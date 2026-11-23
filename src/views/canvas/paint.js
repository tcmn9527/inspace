/* 从 canvas.js 拆出：paint */

import { setExporting } from "./export.js";
import { GEN_PLACE_GAP } from "./media-panels.js";
import { PRESETS, agentSummary, commitEditing, current, edgeLabelEditor, editingId, exporter, exporting, findItem, imageCache, itemBounds, itemEls, makeImage, onPicturePointerDown, pictureStepMove, placeBlock, scheduleItemsSave, select, selectedIds, showError, showToast, store, syncItemElement, tool } from "../canvas.js";

/* ---------- 画面块：右键菜单控件与手绘 ----------
   笔的状态长在块自己身上，不占画布工具栏那套一次性工具态：
   在画面里涂一笔，不该把「选择」的蓝色从工具栏上挤走。
   一块一套笔，撤销重做只退这块画过的笔画。
   先开「编辑」才能落笔：默认非编辑态，拖块、点选都和平常一样。 */

export const PICTURE_PEN_LABELS = {
  pen: "钢笔",
  brush: "毛笔",
};

export const PICTURE_INK_COLORS = ["#1f1f1f", "#a83232", "#1d5c8c", "#2f6b3a", "#8a5a00", "#5a3d7a"];
export const PICTURE_WIDTH_STEPS = [2, 4, 8, 14, 24];
export const PICTURE_UNDO_LIMIT = 60;
/* 毛笔按速度定宽：这个速度（画面单位）算「停住」，一路快下去就细到四成 */
export const PICTURE_BRUSH_SPEED = 22;

/* 块 id -> 这一块的笔和笔画撤销栈。栈里存补丁不存整幅：
   画一笔记一条、擦一笔记被擦掉的那几条，画几百笔也不会像全量快照那样把内存吃穿。 */
export const pictureEditors = new Map();

export function pictureEditorOf(id) {
  let editor = pictureEditors.get(id);
  if (!editor) {
    editor = {
      editing: false,
      tool: "pen",
      color: PICTURE_INK_COLORS[0],
      size: PICTURE_WIDTH_STEPS[1],
      undo: [],
      redo: [],
    };
    pictureEditors.set(id, editor);
  }
  return editor;
}

/* 手里正捏着笔的那一块：只认「单选 + 编辑态」。
   键盘的 Ctrl+Z 只在这一块里生效，退的是画过的笔画。 */
export function paintingTarget() {
  if (selectedIds.size !== 1) return null;
  const id = [...selectedIds][0];
  const editor = pictureEditors.get(id);
  if (!editor || !editor.editing) return null;
  return findItem(id)?.type === "picture" ? id : null;
}

/* 画面块的手绘控件全在右键菜单里：块身上不再挂常驻工具条，
   只留一个 is-painting 的十字光标提示「这一下是落墨不是挪块」。 */
export function pictureMenuEntries(item) {
  const editor = pictureEditorOf(item.id);
  const penEntry = (kind) => ({
    label: `${PICTURE_PEN_LABELS[kind]}${editor.tool === kind ? " ✓" : ""}`,
    onClick: () => setPictureTool(item.id, kind),
  });
  const entries = [
    {
      label: `编辑${editor.editing ? " ✓" : ""}`,
      onClick: () => setPictureEditing(item.id, !editor.editing),
    },
    { label: "画笔", children: [penEntry("pen"), penEntry("brush")] },
    {
      label: "笔宽",
      children: PICTURE_WIDTH_STEPS.map((size) => ({
        label: `${size}${editor.size === size ? " ✓" : ""}`,
        trailing: `<svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true"><path d="M3 7h14" stroke="currentColor" stroke-width="${Math.min(size, 12)}" stroke-linecap="round"/></svg>`,
        onClick: () => {
          pictureEditorOf(item.id).size = size;
        },
      })),
    },
    {
      label: `橡皮${editor.tool === "eraser" ? " ✓" : ""}`,
      onClick: () => setPictureTool(item.id, "eraser"),
    },
    {
      label: "墨色",
      colorPicker: {
        get value() {
          return pictureEditorOf(item.id).color;
        },
        seed: PICTURE_INK_COLORS[0],
        presets: PICTURE_INK_COLORS,
        allowAlpha: false,
        onChange: (color) => {
          if (color) pictureEditorOf(item.id).color = color;
        },
      },
    },
    {
      label: "纸色",
      colorPicker: {
        get value() {
          return findItem(item.id)?.paperColor || "";
        },
        seed: "#ffffff",
        presets: PRESETS,
        allowAlpha: true,
        onChange: (color) => applyPicturePaper(item.id, color),
        onDone: (color) => applyPicturePaper(item.id, color),
      },
    },
    { label: "撤销笔画", disabled: !editor.undo.length, onClick: () => pictureStepMove(item.id, "undo") },
    { label: "重做笔画", disabled: !editor.redo.length, onClick: () => pictureStepMove(item.id, "redo") },
  ];
  return entries;
}

/* 纸色：画面块的底色。选全透明就存空串，卡片背景交回 transparent */
export function applyPicturePaper(id, color) {
  const now = findItem(id);
  if (!now || now.locked) return;
  now.paperColor = color && !String(color).endsWith("00") ? color : "";
  const el = itemEls.get(id);
  if (el) syncItemElement(el, now);
  scheduleItemsSave();
}

/* 把这块画面落成一张图片块：渲染成 PNG 存进画布 images/，在它右边摆一块独立的图片面板。
   只渲染这一块，底下压着的别的块不跟着进图；之后就是普通图片，能拖、能双击看大图。 */
export async function exportPictureImage(id) {
  const item = findItem(id);
  if (!item || item.type !== "picture" || !current) return null;
  const canvasId = current.meta.id;
  try {
    const shot = await exporter.snapshot({
      region: { x: item.x, y: item.y, w: item.w, h: item.h },
      only: item.id,
      maxSide: Math.max(1600, Math.round(Math.max(item.w, item.h) * 2)),
    });
    const rel = await store.saveCanvasImage(canvasId, shot.data, "png");
    if (!current || current.meta.id !== canvasId) return null;
    imageCache.set(rel, `data:image/png;base64,${shot.data}`);
    const placed = placeBlock({
      ...makeImage(item.x + item.w + GEN_PLACE_GAP, item.y, item.w, item.h, rel),
      /* 圆角跟着原面板走：原块是直角，落出来的图块也是直角。
         也不留边框——1px 边框会把图片内容挤小一丝，和原面板对不上 */
      radius: Number.isFinite(Number(item.radius)) ? Number(item.radius) : 0,
      borderWidth: 0,
    });
    showToast("已把这张画面落成图片块");
    return placed ? agentSummary(placed) : null;
  } catch (error) {
    showError(error);
    return null;
  }
}

/* 抓屏并在图片里裁出这块面板的屏幕范围。
   抓回来的是设备像素（DPR 1.5 时窗口宽 2723），按 innerWidth 反推比例。 */
export async function grabRegionImage(item) {
  const shotUrl = await store.captureViewport();
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("抓屏结果读不出来"));
    img.src = shotUrl;
  });
  const dpr = image.naturalWidth / window.innerWidth;
  const rect = itemEls.get(item.id).getBoundingClientRect();
  /* 源坐标和源尺寸都取整：1.5 倍屏上 rect.left*1.5 常是 .5，
     直接用小数裁会让 drawImage 做半像素重采样，字就被糊了一层 */
  const sx = Math.round(rect.left * dpr);
  const sy = Math.round(rect.top * dpr);
  const sw = Math.max(1, Math.round(rect.width * dpr));
  const sh = Math.max(1, Math.round(rect.height * dpr));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png").split(",")[1];
}

/* 矩形落图：抓当前屏幕上的这块面板，存成 PNG 摆在右边。
   抓屏幕而不是离屏渲染，是因为屏幕上的字用 ClearType，离屏只有灰度抗锯齿，
   同一个颜色也会显得更粗；抓屏出来的图和面板逐像素一致。
   面板没完整露在视野里时抓不全，退回 ×2 离屏出图。 */
export async function dropRegionImage(id) {
  if (!current || exporting) return null;
  const item = findItem(id);
  if (!item || item.type !== "rect") return null;
  const el = itemEls.get(id);
  if (!el) return null;
  const box = itemBounds(item, el);
  if (!(box.w > 0 && box.h > 0)) {
    showToast("这块的范围是空的，没东西可落");
    return null;
  }
  const canvasId = current.meta.id;
  const rect = el.getBoundingClientRect();
  const visible =
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= window.innerWidth &&
    rect.bottom <= window.innerHeight;
  setExporting(true);
  showToast("正在按屏幕画面生成图片…");
  select(null);
  document.body.classList.add("is-screen-capturing");
  try {
    if (editingId || edgeLabelEditor) commitEditing();
    /* 等两帧再让窗口把藏掉记号的画面画出来，抓到的才是干净的一帧 */
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 120));

    let data;
    if (visible) {
      data = await grabRegionImage(item);
    } else {
      showToast("面板没完整露在视野里，按 ×2 离屏出图");
      const shot = await exporter.exportRegion({ box, quality: "high", transparent: false });
      data = shot.data;
    }
    const rel = await store.saveCanvasImage(canvasId, data, "png");
    if (!current || current.meta.id !== canvasId) return null;
    imageCache.set(rel, `data:image/png;base64,${data}`);
    const placed = placeBlock({
      ...makeImage(item.x + item.w + GEN_PLACE_GAP, item.y, box.w, box.h, rel),
      /* 圆角跟着原矩形走：它设了多少就多少，没设就是直角。
         也不留边框——1px 边框会把图片内容挤小一丝，和原面板对不上 */
      radius: Number.isFinite(Number(item.radius)) ? Number(item.radius) : 0,
      borderWidth: 0,
    });
    showToast("已把这块面板落成图片块");
    return placed ? agentSummary(placed) : null;
  } catch (error) {
    select(item.id);
    showError(error);
    return null;
  } finally {
    document.body.classList.remove("is-screen-capturing");
    setExporting(false);
  }
}

/* 画面区自己收按下：笔要在这儿落墨，不能让这一下冒到舞台上去挪整块。
   控件都在右键菜单（pictureMenuEntries），块身上只留十字光标这一个状态提示。 */
export function attachPictureTools(el, item) {
  el.querySelector(".canvas-picture-svg")?.addEventListener("pointerdown", (e) => onPicturePointerDown(e, item.id));
  syncPictureChrome(el, item);
}

export function syncPictureChrome(el, item) {
  const editor = pictureEditorOf(item.id);
  /* 锁住的块不供笔：能选、能右键解锁，但不让人往一块钉死的画上落墨 */
  el.classList.toggle("is-painting", editor.editing && !item.locked);
}

export function refreshPictureChrome(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (item && el) syncPictureChrome(el, item);
}

/* 点笔型只换笔，不顺手开编辑：编辑是总开关，开着才落得下去 */
export function setPictureTool(id, kind) {
  const item = findItem(id);
  if (!item || item.type !== "picture") return;
  if (item.locked) return;
  pictureEditorOf(id).tool = kind;
  refreshPictureChrome(id);
}

/* 编辑总开关：打开后块内按下就是落笔，关掉回到拖块/点选 */
export function setPictureEditing(id, on) {
  const item = findItem(id);
  if (!item || item.type !== "picture") return;
  if (on && item.locked) return;
  pictureEditorOf(id).editing = on;
  /* 进入编辑就把这块选中：看得见边界才知道笔落在哪儿 */
  if (on && !selectedIds.has(id)) select(id);
  refreshPictureChrome(id);
}
