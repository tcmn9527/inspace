/* 从 canvas.js 拆出：export */

import { DEFAULT_QUALITY, QUALITY, choiceDialog, commitEditing, createExporter, current, edgeLabelEditor, editingId, itemBounds, itemEls, openMenu, progressDialog, showError, store, ui, withAllVisible } from "../canvas.js";

/* ---------- 导出 ---------- */

export const rawExporter = createExporter({
  getItems: () => (current ? current.items : []),
  getWorld: () => ui.world,
  getEdgeG: () => ui.edgeTransform,
  getBounds: (item) => {
    const el = itemEls.get(item.id);
    return el ? itemBounds(item, el) : null;
  },
  getMeta: () => current?.meta || {},
  getStage: () => ui.stage,
  getPageWidth: () => current?.pageWidth || 0,
  /* 用户此刻看到的这一屏，换算成世界坐标的矩形 */
  getViewportBox: () => {
    if (!current) return null;
    const rect = ui.stage.getBoundingClientRect();
    const { x, y, scale } = current.camera;
    if (!rect.width || !rect.height) return null;
    return {
      x: -x / scale,
      y: -y / scale,
      w: rect.width / scale,
      h: rect.height / scale,
    };
  },
  loadImageData: (id, src, linked) => store.imageData(id, src, linked),
  onError: (error) => showError(error),
});

/* 导出/截图要看到整张画布，先把视口裁剪暂时松开，克隆完再按视口收回去 */
export const exporter = {
  ...rawExporter,
  exportAs: (...args) => withAllVisible(() => rawExporter.exportAs(...args)),
  exportSlices: (...args) => withAllVisible(() => rawExporter.exportSlices(...args)),
  exportRegion: (...args) => withAllVisible(() => rawExporter.exportRegion(...args)),
  snapshot: (...args) => withAllVisible(() => rawExporter.snapshot(...args)),
};

export let exporting = false;
export function setExporting(value) { exporting = value; }

/* 清晰度记在本地：同一个人导过一次高清，下次多半还是要高清 */
export const QUALITY_KEY = "canvas.export.quality";

export function readQuality() {
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    if (saved && QUALITY[saved]) return saved;
  } catch {
    /* 读不了就按默认来，不影响这次导出 */
  }
  return DEFAULT_QUALITY;
}

export function rememberQuality(value) {
  try {
    localStorage.setItem(QUALITY_KEY, value);
  } catch {
    /* 存不下也无所谓，下次重新选一遍 */
  }
}

/* 尺寸说人话：一万四千像素写成数字，比 1.4e4 有用 */
export function sizeLabel(width, height) {
  const megapixels = (width * height) / 1e6;
  const mp = megapixels >= 10 ? Math.round(megapixels) : megapixels.toFixed(1);
  return `${width} × ${height} 像素 · ${mp} MP`;
}

export function openExportMenu() {
  if (!current || exporting) return;
  const rect = ui.exportBtn.getBoundingClientRect();
  openMenu(
    rect.left - 96,
    rect.bottom + 8,
    [
      { label: "导出为图片…", onClick: () => void openImageExportDialog() },
      { label: "导出为 PDF", onClick: () => void runExport("pdf") },
      { label: "导出为网页", onClick: () => void runExport("html") },
      { label: "导出公众号文章", onClick: () => void runExport("wechat") },
      { label: "导出今日头条文章", onClick: () => void runExport("toutiao") },
    ],
    { label: "整张画布", kind: "export" },
  );
}

/* 图片导出真正的问题不是「能不能导」，是「导出来能不能看清」。
 * 旧版按长边一刀切到 8192：一万四千像素的长卷被压到 0.58 倍，16px 的字落成 9px。
 * 所以先把倍数摊开让用户选，每一种都报出成品尺寸，代价自己看得见。
 * 内容实在长，就给「分段导出」——一张超长图在任何看图软件里都是受罪。 */
export async function openImageExportDialog() {
  const base = exporter.plan({ quality: readQuality() });
  if (!base) {
    showToast("这个画布还是空的，没东西可导");
    return;
  }
  const currentQuality = readQuality();
  const options = Object.keys(QUALITY).map((value) => {
    const info = exporter.plan({ quality: value });
    const suffix = value === currentQuality ? "（上次用的）" : "";
    return {
      value,
      label: `${QUALITY[value].label}${suffix}`,
      hint: info.single.capped
        ? `${sizeLabel(info.single.width, info.single.height)} · 内容太大，只能收到这里`
        : sizeLabel(info.single.width, info.single.height),
    };
  });
  const sliced = base.sliced;
  /* 只有一段的时候，分段导出和整张导出是同一件事，别占一行选项 */
  if (sliced.count > 1) {
    options.push({
      value: "slice",
      label: `分段导出 · ${sliced.count} 张`,
      hint: `每张 ${sliced.width} × ${Math.min(sliced.segH, sliced.height)} 像素，按 ${QUALITY[currentQuality].label} 出图 · 逐段放大都清楚`,
    });
  }

  const choice = await choiceDialog({
    title: "导出为图片",
    message: `整张画布 ${Math.round(base.box.w)} × ${Math.round(base.box.h)} 像素，选一个清晰度：`,
    note:
      sliced.count > 1
        ? "倍数越大字越清楚，文件也越大。这么长的画布更推荐分段导出：一张超长图在多数看图软件和聊天工具里都会被压得很小。"
        : "倍数越大字越清楚，文件也越大。",
    options,
  });
  if (!choice) return;
  if (choice === "slice") {
    await runSliceExport(currentQuality);
    return;
  }
  rememberQuality(choice);
  await runExport("png", { quality: choice });
}

export async function runExport(format, options = {}) {
  if (!current || exporting) return;
  exporting = true;
  ui.exportBtn?.classList.add("is-busy");
  if (ui.exportBtn) ui.exportBtn.disabled = true;
  if (format === "png" || format === "pdf") showToast("正在生成图片，块多的时候要等几秒…");
  try {
    /* 正文还在编辑就先落稿，不然导出的是改之前那一版 */
    if (editingId || edgeLabelEditor) commitEditing();
    const result = await exporter.exportAs(format, options);
    const saved = await store.exportSave(result.name, result.format, result.data);
    if (!saved) return;
    if (format === "wechat") {
      showToast(
        result.layout
          ? `已导出公众号长图页：${saved}（点「复制整版长图」，再粘到编辑器）`
          : `已导出公众号文章：${saved}（点「复制全文」，再粘到编辑器）`,
      );
      /* 顺手打开：省得用户再去文件夹里翻。打不开不影响导出结果 */
      try {
        await store.openExport(saved);
      } catch {
        /* 系统没装浏览器之类的情况，提示里已经有路径了 */
      }
      return;
    }
    if (format === "html") {
      showToast(`已导出网页：${saved}（双击就能打开）`);
      return;
    }
    if (format === "toutiao") {
      showToast(
        `已导出今日头条文档：${saved}（${result.headings} 个标题 / ${result.blocks} 段）· 头条后台「更多 → 文档导入」上传`,
      );
      return;
    }
    const capped = result.capped ? `，内容太大已自动收到 ×${result.scale.toFixed(1)}` : "";
    showToast(`已导出 ${result.width}×${result.height}${capped}：${saved}`);
  } catch (error) {
    showError(error);
  } finally {
    exporting = false;
    ui.exportBtn?.classList.remove("is-busy");
    if (ui.exportBtn) ui.exportBtn.disabled = false;
  }
}

/* 分段导出：选一次文件夹，然后一段一段画、一段一段写。
 * 画完一段就落盘一段，内存里始终只有一张图；中途按停止，已经写出去的保留。 */
export async function runSliceExport(quality) {
  if (!current || exporting) return;
  const dir = await store.exportPickDir();
  if (!dir) return;

  exporting = true;
  ui.exportBtn?.classList.add("is-busy");
  if (ui.exportBtn) ui.exportBtn.disabled = true;
  const progress = progressDialog({
    title: "分段导出",
    message: "逐段画、逐段写，画完一段就落盘一段",
    cancelText: "停止",
  });
  let stopped = false;
  progress.onCancel(() => {
    stopped = true;
    progress.cancelPending();
  });

  try {
    if (editingId || edgeLabelEditor) commitEditing();
    let written = 0;
    const result = await exporter.exportSlices({
      quality,
      onProgress: ({ index, total, tile, tiles }) => {
        const inner = tiles ? (tile - 1) / tiles / total : 0;
        progress.set(Math.min(0.999, index / total + inner), `第 ${index + 1}/${total} 段 · 分片 ${tile}/${tiles}`);
      },
      onSlice: async ({ name, data, index, total }) => {
        if (stopped) throw new Error(`已停止，前面写好的 ${written} 张还在文件夹里`);
        await store.exportWrite(dir, name, "png", data);
        written += 1;
        progress.set((index + 1) / total, `已写出 ${written}/${total} 张`);
      },
    });
    progress.close();
    showToast(`已导出 ${result.count} 张（每张 ${result.width}×最多 ${result.segH}）到：${dir}`);
  } catch (error) {
    progress.close();
    showError(error);
  } finally {
    exporting = false;
    ui.exportBtn?.classList.remove("is-busy");
    if (ui.exportBtn) ui.exportBtn.disabled = false;
  }
}

/* 一句轻提示：比弹层轻，比 console 有用。导出这种事有个回执就够了。 */
export let toastTimer = null;
export function showToast(text) {
  if (!ui?.stage) return;
  let el = ui.stage.querySelector(".canvas-toast");
  if (!el) {
    el = document.createElement("p");
    el.className = "canvas-toast";
    ui.stage.append(el);
  }
  el.textContent = text;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), 3600);
}
