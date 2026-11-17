/* 从 canvas.js 拆出：gen-defaults */

import { GEN_MIN_HEIGHT, GEN_MODE_LABELS, GEN_PLACE_GAP, GEN_TEXT_MAX, applyGenFields, applyGenMaskMode, attachGenMask, current, dropGenRun, exporter, findItem, fitGenPrompt, fitImageSize, genBusyId, genMaskBases, genMaskCanvasOf, genMaskModes, genRunMasks, genRunOf, imageCache, imageSize, itemEls, makeImage, onGenRunChange, openMenu, patchGenRun, patchVideoRun, persistGen, placeBlock, refreshConnectors, refreshGenMaskBase, refreshVideoPanel, resetGenMask, scheduleItemsSave, select, showError, showToast, srcInUse, store, syncGen, syncItemElement, toPngDataUrl, updatePorts, updateSelection, videoRunOf } from "../canvas.js";

/* ---------- 生图面板的参数默认值（每模型一套） ---------- */

export const genDefaultsCache = new Map();
export let genFamily = "qwen21";
/* 生图引擎走哪条路：local 用本地权重，api 发远端。API 模式下本地参数不生效，
   面板上要撤掉它们；尺寸仍然有用。 */
export let genEngine = { provider: "local", apiModel: "" };

export async function loadGenDefaults(family) {
  const value = await store.genDefaults(family).catch(() => null);
  if (value) genDefaultsCache.set(family, value);
  return value;
}

export async function refreshGenDefaults() {
  const status = await store.genStatus().catch(() => null);
  if (status?.family) genFamily = status.family;
  if (status?.provider) {
    genEngine = { provider: status.provider, apiModel: status.apiModel || "" };
  }
  if (status?.defaults) genDefaultsCache.set(genFamily, status.defaults);
  const other = genFamily === "qwen21" ? "h3image" : "qwen21";
  loadGenDefaults(other);
  /* 引擎换了（本地 ↔ API）：并行规则跟着换，把面板的开始按钮重排一遍 */
  refreshGenRunButtons();
}

/* 新建面板：把当前模型那套默认参数带上，用户不用每块重新设。 */
export function applyGenDefaultsToItem(item) {
  const family = genFamily;
  const value = genDefaultsCache.get(family);
  item.model = family;
  if (!value) return item;
  item.imageW = value.width;
  item.imageH = value.height;
  item.steps = value.steps;
  item.cfg = value.cfg;
  item.seed = value.seed;
  item.mode = value.mode;
  item.strength = value.strength;
  item.negative = value.negative || "";
  item.refine = Boolean(value.refine);
  return item;
}

/* 面板上改的值同时记成该模型的新建默认（其它已有面板不动）。 */
export let genDefaultsTimer = 0;
export function saveGenDefaults(item) {
  clearTimeout(genDefaultsTimer);
  genDefaultsTimer = setTimeout(() => {
    const family = item.model === "h3image" || item.model === "qwen21" ? item.model : genFamily;
    const fallback = genDefaultsCache.get(family) || {};
    const value = {
      width: item.imageW,
      height: item.imageH,
      steps: item.steps > 0 ? item.steps : fallback.steps ?? 30,
      cfg: item.cfg > 0 ? item.cfg : fallback.cfg ?? 6,
      seed: item.seed,
      mode: item.mode,
      strength: item.strength,
      negative: item.negative || "",
      refine: Boolean(item.refine),
    };
    genDefaultsCache.set(family, value);
    store.genDefaultsSet(value, family).catch(() => {});
  }, 400);
}

/* 面板里显示的实际生效值：0 是「跟模型走」，用该模型默认补齐。 */
export function genEffective(item, field, fallback) {
  const value = item[field];
  if (field === "steps" || field === "cfg") return value > 0 ? value : fallback;
  return value;
}

export function paintGenMore(item, el) {
  const more = el.querySelector(".canvas-gen-more");
  if (!more) return;
  /* 走 API：本地参数（模型档位、步数、CFG、种子、负向、改动幅度）整行撤掉，
     只留尺寸；顶部一行说清这一张走的是哪个 API 模型。 */
  const usingApi = genEngine.provider === "api";
  more.classList.toggle("is-api", usingApi);
  const apiNote = more.querySelector(".canvas-gen-more-api");
  if (apiNote) {
    apiNote.hidden = !usingApi;
    apiNote.textContent = usingApi
      ? `走 API${genEngine.apiModel ? `（${genEngine.apiModel}）` : ""}：只发提示词、尺寸和参考图`
      : "";
  }
  const family = item.model === "h3image" || item.model === "qwen21" ? item.model : genFamily;
  const fallback = genDefaultsCache.get(family) || {};
  const set = (field, value) => {
    const control = more.querySelector(`[data-gen-field="${field}"]`);
    if (!control || document.activeElement === control) return;
    if (control.type === "checkbox") control.checked = Boolean(value);
    else control.value = value ?? "";
  };
  set("model", family);
  set("imageW", item.imageW);
  set("imageH", item.imageH);
  set("steps", genEffective(item, "steps", fallback.steps ?? 30));
  set("cfg", genEffective(item, "cfg", fallback.cfg ?? 6));
  set("seed", item.seed);
  set("strength", item.strength);
  set("negative", item.negative || "");
  /* 改动幅度只对图生图/局部重绘有意义：其它模式（含 H3 的全部模式）这一行不摆 */
  const effectiveMode = genModeFor(item, genInputItems(item).length);
  const strengthRow = more.querySelector('[data-gen-field="strength"]')?.closest(".canvas-gen-more-row");
  if (strengthRow) {
    strengthRow.hidden = effectiveMode !== "i2i" && effectiveMode !== "inpaint";
  }
  /* 高清放大只吃「输入图 + 放大权重」：模型、尺寸、步数、CFG、种子、负向都不参与，
     摆在这里只会让人以为调了有用。整行撤掉，连「更多设置」入口一起撤。 */
  const upscale = effectiveMode === "upscale";
  for (const field of ["model", "imageW", "imageH", "steps", "cfg", "seed", "negative"]) {
    const row = more.querySelector(`[data-gen-field="${field}"]`)?.closest(".canvas-gen-more-row");
    if (row) row.hidden = upscale;
  }
  const seedTip = more.querySelector(".canvas-gen-more-tip");
  if (seedTip) seedTip.hidden = upscale;
  const moreToggle = el.querySelector(".canvas-gen-more-toggle");
  if (moreToggle) moreToggle.hidden = upscale;
  /* 补细节只在「高清放大」这一档有意义（放大后按提示词重绘一遍）。
     文生图、编辑、局部重绘都不读这个开关，H3 的放大也不支持重绘，都不显示。 */
  const refineButton = el.querySelector(".canvas-gen-refine");
  if (refineButton) refineButton.hidden = !upscale || family === "h3image";
}

/* 常用尺寸：宽高都是 32 的倍数；超出当前模型边长上限的项在菜单里自动过滤 */
export const GEN_SIZE_PRESETS = [
  {
    label: "1K",
    items: [
      { label: "1:1 · 1024×1024", w: 1024, h: 1024 },
      { label: "3:4 · 896×1152", w: 896, h: 1152 },
      { label: "4:3 · 1152×896", w: 1152, h: 896 },
      { label: "9:16 · 768×1344", w: 768, h: 1344 },
      { label: "16:9 · 1344×768", w: 1344, h: 768 },
      { label: "2:3 · 832×1248", w: 832, h: 1248 },
      { label: "3:2 · 1248×832", w: 1248, h: 832 },
    ],
  },
  {
    label: "手机壁纸",
    items: [
      { label: "1080p 手机 · 1088×1920", w: 1088, h: 1920 },
      { label: "2K 手机 · 1440×2560", w: 1440, h: 2560 },
      { label: "16MP 竖屏 · 2304×4096", w: 2304, h: 4096 },
    ],
  },
  {
    label: "电脑壁纸",
    items: [
      { label: "1080p · 1920×1088", w: 1920, h: 1088 },
      { label: "2K · 2560×1440", w: 2560, h: 1440 },
      { label: "16MP 横屏 · 4096×2304", w: 4096, h: 2304 },
    ],
  },
  {
    label: "方形",
    items: [
      { label: "1024 × 1024", w: 1024, h: 1024 },
      { label: "2048 × 2048", w: 2048, h: 2048 },
      { label: "16MP · 4096×4096", w: 4096, h: 4096 },
    ],
  },
  {
    label: "海报 / 竖版",
    items: [
      { label: "2:3 · 1024×1536", w: 1024, h: 1536 },
      { label: "2:3 大图 · 2048×3072", w: 2048, h: 3072 },
      { label: "4:5 · 1024×1280", w: 1024, h: 1280 },
    ],
  },
  {
    label: "超宽",
    items: [
      { label: "21:9 · 2560×1088", w: 2560, h: 1088 },
      { label: "21:9 大图 · 4096×1728", w: 4096, h: 1728 },
    ],
  },
];

export function applySizePreset(item, preset) {
  if (!applyGenFields(item, { imageW: preset.w, imageH: preset.h })) return;
  persistGen(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  refreshGenPanel(item.id);
  saveGenDefaults(item);
}

/* 面板里换模型：块上那套参数跟着换成目标模型的默认值。 */
export async function switchGenFamily(item, family) {
  let value = genDefaultsCache.get(family);
  if (!value) value = await loadGenDefaults(family);
  const patch = { model: family };
  if (value) {
    patch.imageW = value.width;
    patch.imageH = value.height;
    patch.steps = value.steps;
    patch.cfg = value.cfg;
    patch.seed = value.seed;
    patch.mode = value.mode;
    patch.strength = value.strength;
    patch.negative = value.negative || "";
    patch.refine = Boolean(value.refine);
  }
  if (!applyGenFields(item, patch)) return;
  persistGen(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  refreshGenPanel(item.id);
}

export let genFamilyWatchBound = false;
export function watchGenFamily() {
  if (genFamilyWatchBound) return;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  genFamilyWatchBound = true;
  listen("inspace:gen-family", (event) => {
    const next = event.payload?.family;
    if (next !== "qwen21" && next !== "h3image") return;
    genFamily = next;
    if (!genDefaultsCache.has(next)) loadGenDefaults(next);
  }).catch(() => {});
}

/* 设置里切了「本地 / API」：重读状态，再把每块面板的档位行和更多设置刷一遍。 */
export let genApiWatchBound = false;
export function watchGenApi() {
  if (genApiWatchBound) return;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  genApiWatchBound = true;
  listen("inspace:gen-api", () => {
    void refreshGenDefaults().then(() => refreshGenFeeds());
  }).catch(() => {});
}

export function attachGenPanel(el, item) {
  const bar = el.querySelector(".canvas-gen-bar");
  const prompt = el.querySelector(".canvas-gen-prompt");
  const runButton = el.querySelector(".canvas-gen-run");
  const placeButton = el.querySelector(".canvas-gen-place");
  if (!bar || !prompt || !runButton || !placeButton) return;
  /* 只有真正的控件吃掉按下：提示词框、下拉、按钮、涂抹层；
     行与行之间、按钮与按钮之间的空白留给拖整块 */
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("textarea, input, button, select, canvas")) e.stopPropagation();
  });
  /* 参数行这几颗下拉：点开一列，选中就写回块上，面板立刻跟着换字 */
  const select = (selector, makeEntries) => {
    const button = el.querySelector(selector);
    if (!button) return;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = findItem(item.id);
      if (!target) return;
      const rect = button.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 6, makeEntries(target), { kind: "gen-select" });
    });
  };
  const check = (on) =>
    on
      ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.4 8.4 6.6 11.6 12.6 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : "";
  prompt.addEventListener("input", () => {
    const target = findItem(item.id);
    if (!target) return;
    target.prompt = prompt.value.slice(0, GEN_TEXT_MAX);
    persistGen(target);
    fitGenPrompt(item.id, prompt, true);
  });
  prompt.addEventListener("keydown", (e) => {
    /* 回车这一下是发出去，换行要按 Shift+Enter：框就三行高，写一句话用不着回车 */
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    runOrStopGen(item.id);
  });
  runButton.addEventListener("click", () => runOrStopGen(item.id));
  placeButton.addEventListener("click", () => placeGenImage(item.id));
  /* 上一张出的图跟着块一起回来：运行态记的是「这一轮」，重开画布时从 images/ 里接上 */
  const run = genRunOf(item.id);
  if (run.phase === "idle" && !run.imageUrl && !run.previewUrl && item.src) {
    patchGenRun(item.id, { imageUrl: imageCache.get(item.src) || "" });
  }
  attachGenMask(el, item);
  /* 涂抹开关：开着遮罩吃鼠标，关着才拖得动面板 */
  const brushButton = el.querySelector(".canvas-gen-brush");
  brushButton?.addEventListener("click", (e) => {
    e.stopPropagation();
    applyGenMaskMode(el, item.id, !genMaskModes.get(item.id));
    refreshGenPanel(item.id);
  });
  const clearButton = el.querySelector(".canvas-gen-clear");
  clearButton?.addEventListener("click", (e) => {
    e.stopPropagation();
    const canvas = genMaskCanvasOf(el);
    if (canvas) resetGenMask(canvas);
    showToast("遮罩已清空");
  });
  /* 高清放大的「补细节」开关：开了就在放大之后按提示词低强度重绘一遍 */
  const refineButton = el.querySelector(".canvas-gen-refine");
  refineButton?.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = findItem(item.id);
    if (!target) return;
    target.refine = !target.refine;
    scheduleItemsSave();
    refreshGenPanel(target.id);
  });
  /* 更多设置：展开/收起、改参数、换模型、恢复默认 */
  const more = el.querySelector(".canvas-gen-more");
  const moreToggle = el.querySelector(".canvas-gen-more-toggle");
  if (more && moreToggle) {
    moreToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = findItem(item.id);
      const targetEl = itemEls.get(item.id);
      if (!target || !targetEl) return;
      const box = targetEl.querySelector(".canvas-gen-more");
      if (!box) return;
      const open = box.hidden;
      box.hidden = !open;
      moreToggle.classList.toggle("is-open", open);
      moreToggle.textContent = open ? "隐藏更多设置" : "更多设置";
      moreToggle.title = open
        ? "收起尺寸、步数、CFG、种子、模式等参数"
        : "展开尺寸、步数、CFG、种子、模式等参数";
      const resetButton = targetEl.querySelector(".canvas-gen-more-reset");
      if (resetButton) resetButton.hidden = !open;
      if (open) {
        box.dataset.height = String(box.offsetHeight + 6);
        targetEl.dataset.openHeight = String(target.h);
        target.h = Math.max(GEN_MIN_HEIGHT, target.h + (Number(box.dataset.height) || 0));
      } else {
        const before = Number(targetEl.dataset.openHeight);
        target.h = Number.isFinite(before)
          ? before
          : Math.max(GEN_MIN_HEIGHT, target.h - (Number(box.dataset.height) || 0));
        delete targetEl.dataset.openHeight;
      }
      /* 展开只是看参数，不把临时高度写进画布文件 */
      syncItemElement(targetEl, target);
      /* 块高变了，选中框和端口要立刻跟到新边缘，不能停在展开前的位置 */
      updateSelection();
      updatePorts();
      paintGenMore(target, targetEl);
    });
    const applyMore = (event) => {
      const control = event.target.closest?.("[data-gen-field]");
      if (!control) return;
      event.stopPropagation();
      const target = findItem(item.id);
      if (!target) return;
      const field = control.dataset.genField;
      if (field === "model") {
        switchGenFamily(target, control.value);
        return;
      }
      const value = control.type === "checkbox" ? control.checked : control.value;
      if (!applyGenFields(target, { [field]: value })) return;
      persistGen(target);
      const targetEl = itemEls.get(target.id);
      if (targetEl) syncItemElement(targetEl, target);
      scheduleItemsSave();
      refreshGenPanel(target.id);
      saveGenDefaults(target);
    };
    more.addEventListener("change", applyMore);
    /* 输入框敲一下就生效，不用等失焦：面板上没有「保存」 */
    more.addEventListener("input", (event) => {
      const control = event.target.closest?.("[data-gen-field]");
      if (!control || control.tagName === "SELECT" || control.type === "checkbox") return;
      applyMore(event);
    });
    const reset = el.querySelector(".canvas-gen-more-reset");
    reset?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const target = findItem(item.id);
      if (!target) return;
      const family = target.model === "h3image" || target.model === "qwen21" ? target.model : genFamily;
      const value = await store.genDefaultsReset(family).catch((error) => {
        showError(error);
        return null;
      });
      if (!value) return;
      genDefaultsCache.set(family, value);
      applyGenFields(target, {
        imageW: value.width,
        imageH: value.height,
        steps: value.steps,
        cfg: value.cfg,
        seed: value.seed,
        mode: value.mode,
        strength: value.strength,
        negative: value.negative || "",
        refine: Boolean(value.refine),
      });
      persistGen(target);
      const targetEl = itemEls.get(target.id);
      if (targetEl) syncItemElement(targetEl, target);
      scheduleItemsSave();
      refreshGenPanel(target.id);
    });
    /* 常用尺寸：按当前模型能出的边长过滤，选完直接写块并记成默认 */
    const sizePreset = el.querySelector(".canvas-gen-more-size-preset");
    sizePreset?.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = findItem(item.id);
      if (!target) return;
      const family = target.model === "h3image" || target.model === "qwen21" ? target.model : genFamily;
      const maxSide = family === "h3image" ? 4096 : 2048;
      const entries = GEN_SIZE_PRESETS.map((group) => ({
        label: group.label,
        children: group.items
          .filter((preset) => preset.w <= maxSide && preset.h <= maxSide)
          .map((preset) => ({
            label: preset.label,
            onClick: () => applySizePreset(target, preset),
          })),
      })).filter((group) => group.children.length);
      if (!entries.length) return;
      const rect = sizePreset.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 6, entries, { kind: "gen-size" });
    });
  }
  /* 局部重绘面板一建好就进涂抹态：拉开就是要涂的 */
  if (genModeFor(item, genInputItems(item).length) === "inpaint") {
    applyGenMaskMode(el, item.id, true);
  }
  syncGen(el, item, genFeedOf(item), { blocked: otherGenBlocked(item.id) });
  paintGenMore(item, el);
  fitGenPrompt(item.id, prompt);
  void refreshGenMaskBase(item);
}

/* 本地引擎一次只吃一张：别的面板在跑时这块的开始要灰掉；走 API 放开并行 */
export function otherGenBlocked(id) {
  if (genEngine.provider === "api") return false;
  const busy = genBusyId();
  return Boolean(busy && busy !== id);
}

/* 运行态变了：把所有生图面板的「开始/停止」按新的占用情况重排一遍 */
export function refreshGenRunButtons() {
  if (!current) return;
  for (const item of current.items) {
    if (item.type !== "gen") continue;
    const el = itemEls.get(item.id);
    const btn = el?.querySelector(".canvas-gen-run");
    if (!btn) continue;
    const run = genRunOf(item.id);
    const busy = run.phase === "loading" || run.phase === "running";
    btn.textContent = busy ? "停止" : "开始";
    btn.disabled = !busy && otherGenBlocked(item.id);
  }
}

onGenRunChange(refreshGenRunButtons);

export function refreshGenPanel(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  syncGen(el, item, genFeedOf(item), { blocked: otherGenBlocked(item.id) });
  paintGenMore(item, el);
  /* 只量不涨：打开画布、拖块、连线、刷新引擎状态都会走到这里，
     这些都该保持用户上次的尺寸。提示词变长由输入/改词那一趟单独 grow */
  fitGenPrompt(id, el.querySelector(".canvas-gen-prompt"), false);
}

/* 面板上那一行进料提示：接了几张、这一张会按哪档走。
   连线一改就有新答案，所以 refreshConnectors 末尾统一刷一遍。 */
export function genFeedOf(item) {
  const sources = genInputItems(item);
  const mode = genModeFor(item, sources.length);
  const base = GEN_MODE_LABELS[mode] || mode;
  const label =
    genEngine.provider === "api"
      ? `${base} · API${genEngine.apiModel ? ` ${genEngine.apiModel}` : ""}`
      : base;
  return {
    mode,
    label,
    count: sources.length,
    baseUrl: genMaskBases.get(item.id) || "",
  };
}

export function refreshGenFeeds() {
  if (!current) return;
  for (const item of current.items) {
    if (item.type === "gen") void refreshGenMaskBase(item);
    if (item.type === "gen") refreshGenPanel(item.id);
    if (item.type === "genvideo") refreshVideoPanel(item.id);
  }
}

/* 这一轮没出成：把上一次那张接回来显示。文件还在盘上，取景窗不该空着。 */
export function keepLastGenImage(id) {
  const item = findItem(id);
  patchGenRun(id, { imageUrl: item && item.src ? imageCache.get(item.src) || "" : "" });
}

/* 面板的进料口就是连线：谁用线连到这块，谁就是输入图。
   一条线 = 拿那张当底图重绘，多条线 = 几张一起当参考图。
   块上明写了 t2i / i2i / edit 才盖掉这个推断——画风锚点那种「只有一张、
   但它是参考图不是底图」就得明写。 */
export function genInputItems(item) {
  const out = [];
  for (const link of current?.items || []) {
    if (link.type !== "connector" || link.to?.item !== item.id) continue;
    const source = findItem(link.from?.item);
    if (source && source.id !== item.id && !out.includes(source)) out.push(source);
  }
  return out;
}

export function genModeFor(item, count) {
  const stated = item.mode && item.mode !== "auto" ? item.mode : "";
  if (stated) return stated;
  if (!count) return "t2i";
  return count === 1 ? "i2i" : "edit";
}

/* 一块东西画成引擎能吃的 PNG。图片块和面板自己那张都在 images/ 里，读字节就行；
   画面块是矢量，走导出那套光栅化。场景块这一版还不吃——three.js 抓帧是另一件事。 */
export async function genInputPng(item) {
  const space = current?.meta?.id;
  if (!space) throw new Error("没有打开的画布");
  if (item.type === "image" || (item.type === "gen" && item.src)) {
    return toPngDataUrl(await store.imageData(space, item.src, Boolean(item.linked)));
  }
  if (item.type === "picture") {
    /* 走导出那条光栅化：只画这一块，位图底会内联成 data:，纸色和笔迹都在 */
    const shot = await exporter.snapshot({
      region: { x: item.x, y: item.y, w: item.w, h: item.h },
      only: item.id,
      maxSide: 1024,
    });
    return `data:image/png;base64,${shot.data}`;
  }
  throw new Error(`「${item.type}」这块当不了输入图`);
}

export function runOrStopGen(id) {
  const item = findItem(id);
  if (!item || item.type !== "gen") return;
  const run = genRunOf(id);
  if (run.phase === "loading" || run.phase === "running") {
    void stopGen(id);
    return;
  }
  /* 本地引擎一次一张由后端拒绝；API 通道按设置并行，这里不拦 */
  /* 放大这一档不读提示词，那句「先写一句提示词」在这儿是拦错人 */
  const mode = genModeFor(item, genInputItems(item).length);
  if (mode !== "upscale" && !(item.prompt || "").trim()) {
    showError("先写一句提示词");
    return;
  }
  patchGenRun(id, {
    phase: "loading",
    step: 0,
    steps: item.steps,
    previewUrl: "",
    imageUrl: "",
    error: "",
  });
  refreshGenPanel(id);
  void startGenRun(item);
}

export async function startGenRun(item) {
  const id = item.id;
  const fail = (text) => {
    patchGenRun(id, { phase: "failed", error: text });
    keepLastGenImage(id);
    refreshGenPanel(id);
  };
  let body;
  try {
    const sources = genInputItems(item);
    const mode = genModeFor(item, sources.length);
    /* 一张一张取，别攒：一张就是几 MB 的 base64，同时来几张没意义 */
    const images = [];
    if (mode !== "t2i") {
      for (const source of sources) images.push(await genInputPng(source));
    }
    let mask = genRunMasks.get(id) || "";
    if (!mask && mode === "inpaint") {
      const canvas = genMaskCanvasOf(itemEls.get(id));
      if (!canvas) throw new Error("遮罩层没准备好，重开一下面板再试");
      mask = canvas.toDataURL("image/png");
    }
    genRunMasks.delete(id);
    body = {
      block: id,
      prompt: (item.prompt || "").trim(),
      mask,
      refine: mode === "upscale" ? Boolean(item.refine) : false,
      negative: item.negative || "",
      width: item.imageW,
      height: item.imageH,
      steps: item.steps,
      cfg: item.cfg,
      seed: item.seed,
      mode,
      family: item.model || undefined,
      strength: item.strength,
      images,
    };
  } catch (error) {
    fail(String(error?.message || error || "输入图取不出来"));
    return;
  }
  store.genStart(body).catch((error) => {
    const text = String(error?.message || error || "出图失败");
    if (genRunOf(id).phase === "canceled" || text === "已取消") {
      patchGenRun(id, { phase: "canceled" });
      refreshGenPanel(id);
      return;
    }
    fail(text);
  });
}

export async function stopGen(id) {
  /* 点了就是停了，先按画面判；后端那边走它的硬取消，不用这儿等 */
  patchGenRun(id, { phase: "canceled" });
  refreshGenPanel(id);
  await store.genCancel(id).catch(() => {});
}

/* 落块时右边放不下：把面板右侧、和新图同一水平线的块整体右移，给新图片留出位置。
   只看块的起点在不在面板右边缘之外；垂直不重叠的块属于别的行，不动。
   连线跟着端点重算，不参与平移。 */
export function shiftBlocksForPlace(panel, x, y, width, height) {
  if (!current) return;
  const right = x + width + GEN_PLACE_GAP;
  const threshold = panel.x + panel.w;
  const blocks = current.items.filter(
    (other) =>
      other !== panel &&
      other.type !== "connector" &&
      Number.isFinite(other.x) &&
      other.x >= threshold &&
      other.y < y + height &&
      other.y + (other.h || 0) > y,
  );
  if (!blocks.length) return;
  const nearest = Math.min(...blocks.map((block) => block.x));
  if (right <= nearest) return;
  const delta = right - nearest;
  for (const block of blocks) {
    block.x += delta;
    const el = itemEls.get(block.id);
    if (el) syncItemElement(el, block);
  }
  refreshConnectors();
  updateSelection();
  updatePorts();
  scheduleItemsSave();
}

export async function placeGenImage(id) {
  const item = findItem(id);
  const run = genRunOf(id);
  if (!item || !item.src || run.phase === "loading" || run.phase === "running" || !current) return null;
  const canvasId = current.meta.id;
  try {
    /* 落块是复制不是搬走：面板接着显示它那张，图片块自己带一份文件，
       删哪一块都不该把另一块清空 */
    const rel = await store.duplicatePictureImage(canvasId, item.src, false, canvasId);
    if (!current || current.meta.id !== canvasId) return null;
    const url = imageCache.get(rel) || (await store.imageUrl(canvasId, rel, false).catch(() => ""));
    imageCache.set(rel, url || null);
    const size = await imageSize(url || run.imageUrl);
    const fit = fitImageSize(size.width, size.height);
    const placeX = item.x + item.w + GEN_PLACE_GAP;
    shiftBlocksForPlace(item, placeX, item.y, fit.w, fit.h);
    return placeBlock(makeImage(placeX, item.y, fit.w, fit.h, rel));
  } catch (error) {
    showError(error);
    return null;
  }
}

export async function onGenDone(payload) {
  const item = findItem(payload.block);
  if (!item) {
    dropGenRun(payload.block);
    return;
  }
  const dataUrl = payload.dataUrl || "";
  patchGenRun(payload.block, {
    phase: dataUrl ? "idle" : "failed",
    step: payload.steps || item.steps,
    seconds: payload.seconds || 0,
    previewUrl: "",
    imageUrl: dataUrl,
    error: dataUrl ? "" : "出图失败：结果是空的",
  });
  refreshGenPanel(payload.block);
  if (!dataUrl) {
    keepLastGenImage(payload.block);
    refreshGenPanel(payload.block);
    return;
  }
  const canvasId = current?.meta.id;
  const comma = dataUrl.indexOf(",");
  if (!canvasId || comma < 0) return;
  try {
    const rel = await store.saveCanvasImage(canvasId, dataUrl.slice(comma + 1), "png");
    if (!current || current.meta.id !== canvasId) return;
    const target = findItem(payload.block);
    if (!target) {
      void store.deleteCanvasImage(canvasId, rel, false).catch(() => {});
      return;
    }
    const old = target.src;
    target.src = rel;
    imageCache.set(rel, dataUrl);
    /* 上一张没人指着了才回收：跟删块同一套，当场进回收站 */
    if (old && old !== rel && !srcInUse(old)) {
      void store.deleteCanvasImage(canvasId, old, false).catch(() => {});
    }
    scheduleItemsSave();
  } catch (error) {
    showError(error);
  }
}

export function setupGenEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  const on = (name, handler) => {
    Promise.resolve(listen(name, (event) => handler(event?.payload))).catch(() => {});
  };
  on("gen-progress", (payload) => {
    if (!payload || !findItem(payload.block)) return;
    patchGenRun(payload.block, { phase: "running", step: payload.step, steps: payload.steps });
    refreshGenPanel(payload.block);
  });
  on("gen-preview", (payload) => {
    if (!payload || !findItem(payload.block)) return;
    patchGenRun(payload.block, {
      phase: "running",
      step: payload.step,
      steps: payload.steps,
      previewUrl: payload.dataUrl || "",
    });
    refreshGenPanel(payload.block);
  });
  on("gen-done", (payload) => {
    if (payload) void onGenDone(payload);
  });
  on("gen-failed", (payload) => {
    if (!payload) return;
    if (!findItem(payload.block)) {
      dropGenRun(payload.block);
      return;
    }
    patchGenRun(payload.block, {
      phase: payload.canceled ? "canceled" : "failed",
      error: payload.error || "",
    });
    keepLastGenImage(payload.block);
    refreshGenPanel(payload.block);
  });
}

/* 视频任务的回执：进度写进这一块的运行态，面板据此画「排队中/生成中」；
   出片路径也在这里，点「落块」时从这儿取。 */
export function setupVideoEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  const on = (name, handler) => {
    Promise.resolve(listen(name, (event) => handler(event?.payload))).catch(() => {});
  };
  on("video-progress", (payload) => {
    if (!payload?.block) return;
    patchVideoRun(payload.block, {
      phase: "running",
      label: payload.label || "生成中",
      waited: payload.waited || 0,
    });
    refreshVideoPanel(payload.block);
  });
  on("video-done", (payload) => {
    if (!payload?.block) return;
    patchVideoRun(payload.block, {
      phase: "done",
      path: payload.path || "",
      seconds: payload.seconds || 0,
      label: "",
    });
    refreshVideoPanel(payload.block);
  });
  on("video-failed", (payload) => {
    if (!payload?.block) return;
    patchVideoRun(payload.block, {
      phase: payload.canceled ? "canceled" : "failed",
      error: payload.error || "",
      canceled: Boolean(payload.canceled),
    });
    refreshVideoPanel(payload.block);
  });
  /* 生成中每秒刷一遍面板：后端 5 秒才报一次，秒数不能让用户数着事件跳 */
  setInterval(() => {
    if (!current) return;
    for (const item of current.items) {
      if (item.type === "genvideo" && videoRunOf(item.id).phase === "running") {
        refreshVideoPanel(item.id);
      }
    }
  }, 1000);
}
