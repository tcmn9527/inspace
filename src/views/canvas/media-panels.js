/* 从 canvas.js 拆出：media-panels */

import { GEN_TEXT_MAX, active, collectPictureImageSrcs, copyIntoCanvas, current, findItem, genInputItems, genInputPng, genModeFor, insertPoint, itemEls, makeVideo, makeVideoGen, openMenu, patchVideoRun, placeBlock, refreshGenPanel, scheduleItemsSave, select, showError, store, syncItemElement, syncVideoPanel, videoRunOf } from "../canvas.js";

/* ---------- 生图面板 ----------
   上半截取景、下半截一句提示词加一颗按钮。出图发生在 Rust 那边的一根工作线程里，
   这儿只负责起一轮和收事件；面板上不摆「保存」——图一落成就自己进 images/，
   点「落块」才在外面另摆一张独立图片块。 */

export const GEN_PLACE_GAP = 24;

/* 这个路径还有谁指着（独立图片块、别的面板、画面块垫的位图都算一份）：
   回收旧图之前问一句，有人指着的就别动 */
export const srcInUse = (src) =>
  Boolean(current) &&
  current.items.some(
    (other) =>
      other.src === src ||
      (other.type === "picture" &&
        collectPictureImageSrcs(other.cmds, other.symbols).some((one) => one.src === src)),
  );

/* ---------- 局部重绘：遮罩层 ----------
   每块一张 512×512 的黑底画布，白笔迹 = 要重绘的地方；出图时整张当 mask 传给引擎。 */
export const GEN_MASK_SIZE = 512;
export const genMaskBases = new Map(); // 块 id -> 取景窗里垫的底图地址
/* 块 id -> 涂抹模式开着没有：开着遮罩层才吃鼠标，关着就能拖面板 */
export const genMaskModes = new Map();
/* agent 临时递过来的遮罩（base64），只在下一张用一次 */
export const genRunMasks = new Map();
export let maskPainting = null;

export function applyGenMaskMode(el, id, on) {
  genMaskModes.set(id, on);
  genMaskCanvasOf(el)?.classList.toggle("is-active", on);
}

export function genMaskCanvasOf(el) {
  return el?.querySelector(".canvas-gen-mask") || null;
}

export function resetGenMask(canvas) {
  canvas.width = GEN_MASK_SIZE;
  canvas.height = GEN_MASK_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, GEN_MASK_SIZE, GEN_MASK_SIZE);
}

export function attachGenMask(el, item) {
  const canvas = genMaskCanvasOf(el);
  if (!canvas || canvas.dataset.ready) return;
  canvas.dataset.ready = "1";
  resetGenMask(canvas);
  const at = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
  };
  const stroke = (e) => {
    const ctx = canvas.getContext("2d");
    const point = at(e);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(point.x, point.y, GEN_MASK_SIZE * 0.045, 0, Math.PI * 2);
    ctx.fill();
  };
  canvas.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const target = findItem(item.id);
    if (!target) return;
    if (genModeFor(target, genInputItems(target).length) !== "inpaint") return;
    if (!genMaskModes.get(item.id)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    maskPainting = canvas;
    stroke(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (maskPainting !== canvas) return;
    e.preventDefault();
    stroke(e);
  });
  const stop = () => {
    if (maskPainting === canvas) maskPainting = null;
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
}

/* 局部重绘面板的底图：连线过来的第一张图；没有就清掉 */
export async function refreshGenMaskBase(item) {
  if (!current) return;
  const mode = genModeFor(item, genInputItems(item).length);
  const source = mode === "inpaint" ? genInputItems(item)[0] : null;
  if (!source) {
    if (genMaskBases.delete(item.id)) refreshGenPanel(item.id);
    return;
  }
  const canvasId = current.meta.id;
  let url = "";
  try {
    if (source.type === "image" || (source.type === "gen" && source.src)) {
      url = await store.imageUrl(canvasId, source.src, Boolean(source.linked));
    } else if (source.type === "picture") {
      url = await genInputPng(source);
    }
  } catch {
    url = "";
  }
  if (!current || current.meta.id !== canvasId) return;
  if ((genMaskBases.get(item.id) || "") === url) return;
  if (url) genMaskBases.set(item.id, url);
  else genMaskBases.delete(item.id);
  refreshGenPanel(item.id);
}

/* 提示词框跟着内容长高、不出滚动条。只按「框这次长了多少」调整块高：
   用户拖角改块高、agent 改块高都不受影响，刷新多少次也不会把尺寸弹回去 */
/* 取景窗的地板（和 CSS .canvas-gen-stage 的 min-height 对齐）：
   面板再矮也要给图留这么高，提示词在它自己的框里滚。 */
export const GEN_STAGE_MIN_HEIGHT = 160;

export function fitGenPrompt(itemId, prompt, grow = false) {
  const item = findItem(itemId);
  const el = itemEls.get(itemId);
  if (!item || !prompt || !el) return;
  /* 提示词框没显示（高清放大那档）：不参与量高，否则 0 和 56 的差会把块越撑越高 */
  if (prompt.hidden || prompt.offsetParent === null) return;
  const bar = el.querySelector(".canvas-gen-bar");
  /* 先压到 0 再读 scrollHeight：textarea 的 height:auto 只会退回 rows 行，
     不这么量出来的是三行的高度，长内容照样被裁 */
  prompt.style.height = "0px";
  const want = Math.max(56, prompt.scrollHeight);
  const other = bar ? bar.offsetHeight - prompt.offsetHeight : 0;
  const room = () => Math.max(56, item.h - GEN_STAGE_MIN_HEIGHT - other);
  /* 手动拉过高度之后就不再按提示词自动长高——用户缩矮时提示词滚动，图不缩没 */
  const manual = item.manualSize === true || el.dataset.userResized === "1";
  if (grow && !manual && want > room()) {
    item.h += want - room();
    syncItemElement(el, item);
    scheduleItemsSave();
  }
  const height = Math.min(want, room());
  prompt.style.height = `${height}px`;
  prompt.style.overflowY = want > height ? "auto" : "hidden";
}


/* ---------- 视频面板 ---------- */

export function videoFeedOf(item) {
  return { count: genInputItems(item).length };
}

export function refreshVideoPanel(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  syncVideoPanel(el, item, videoFeedOf(item));
}

/* 视频面板的常用档：时长按秒，尺寸按用户认得的 720p/1080p 命名，给的是真实像素 */
export const VIDEO_SECONDS_PRESETS = [4, 5, 6, 8, 10, 12];
export const VIDEO_SIZE_PRESETS = [
  { label: "720p 横屏 · 1280×720", w: 1280, h: 720 },
  { label: "1080p 横屏 · 1920×1080", w: 1920, h: 1080 },
  { label: "720p 竖屏 · 720×1280", w: 720, h: 1280 },
  { label: "1080p 竖屏 · 1080×1920", w: 1080, h: 1920 },
  { label: "1:1 方形 · 1024×1024", w: 1024, h: 1024 },
];

export function attachVideoPanel(el, item) {
  const card = el.querySelector(".canvas-genvideo-card");
  if (!card) return;
  /* 输入框、下拉、按钮、播放器自己吃按下：其余地方留给拖整块 */
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("textarea, input, select, button, video")) e.stopPropagation();
  });
  const prompt = el.querySelector(".canvas-genvideo-prompt");
  prompt.addEventListener("input", () => {
    const target = findItem(item.id);
    if (!target) return;
    target.prompt = prompt.value.slice(0, GEN_TEXT_MAX);
    scheduleItemsSave();
  });
  prompt.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    runOrStopVideo(item.id);
  });
  el.querySelector(".canvas-genvideo-run").addEventListener("click", (e) => {
    e.stopPropagation();
    runOrStopVideo(item.id);
  });
  el.querySelector(".canvas-genvideo-place").addEventListener("click", (e) => {
    e.stopPropagation();
    void placeVideoBlock(item.id);
  });
  const controls = el.querySelector(".canvas-genvideo-controls");
  const applyField = (control) => {
    const target = findItem(item.id);
    if (!target) return;
    const value = Math.round(Number(control.value));
    if (!Number.isFinite(value) || value <= 0) return;
    if (control.dataset.videoField === "seconds") {
      target.seconds = Math.min(60, value);
    } else {
      const even = Math.min(4096, value - (value % 2));
      if (even < 64) return;
      target[control.dataset.videoField] = even;
    }
    scheduleItemsSave();
  };
  controls.addEventListener("input", (e) => {
    const control = e.target.closest?.("[data-video-field]");
    if (control) applyField(control);
  });
  controls.addEventListener("change", (e) => {
    const control = e.target.closest?.("[data-video-field]");
    if (!control) return;
    applyField(control);
    refreshVideoPanel(item.id);
  });
  controls.addEventListener("click", (e) => {
    const button = e.target.closest?.("[data-video-preset]");
    if (!button) return;
    e.stopPropagation();
    e.preventDefault();
    const target = findItem(item.id);
    if (!target) return;
    const kind = button.dataset.videoPreset;
    const entries =
      kind === "seconds"
        ? VIDEO_SECONDS_PRESETS.map((value) => ({
            label: `${value} 秒`,
            onClick: () => {
              const current = findItem(item.id);
              if (!current) return;
              current.seconds = value;
              scheduleItemsSave();
              refreshVideoPanel(current.id);
            },
          }))
        : VIDEO_SIZE_PRESETS.map((preset) => ({
            label: preset.label,
            onClick: () => {
              const current = findItem(item.id);
              if (!current) return;
              current.width = preset.w;
              current.height = preset.h;
              scheduleItemsSave();
              refreshVideoPanel(current.id);
            },
          }));
    const rect = button.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 6, entries, { kind: "video-preset" });
  });
  syncVideoPanel(el, item, videoFeedOf(item));
}

export function insertVideoPanel() {
  if (!current) return;
  const at = insertPoint(320, 360);
  placeBlock(makeVideoGen(at.x, at.y));
}

export function runOrStopVideo(id) {
  const item = findItem(id);
  if (!item || item.type !== "genvideo") return;
  const run = videoRunOf(id);
  if (run.phase === "running") {
    void stopVideo(id);
    return;
  }
  if (!(item.prompt || "").trim()) {
    showError("先写一句提示词");
    return;
  }
  patchVideoRun(id, {
    phase: "running",
    label: "提交中…",
    startedAt: Date.now(),
    path: "",
    seconds: 0,
    error: "",
    canceled: false,
  });
  refreshVideoPanel(id);
  void startVideoRun(item);
}

export async function startVideoRun(item) {
  const id = item.id;
  try {
    const sources = genInputItems(item);
    /* 首帧一张就够：多张时按连线顺序取第一张 */
    const image = sources.length ? await genInputPng(sources[0]) : "";
    await store.genVideoStart({
      block: id,
      prompt: (item.prompt || "").trim(),
      image: image || undefined,
      seconds: item.seconds,
      width: item.width,
      height: item.height,
    });
  } catch (error) {
    patchVideoRun(id, {
      phase: "failed",
      error: String(error?.message || error || "视频生成失败"),
    });
    refreshVideoPanel(id);
  }
}

export async function stopVideo(id) {
  /* 点了就是不等了；后端那边只置标志位，平台任务照样跑完、费用照算 */
  patchVideoRun(id, { phase: "canceled" });
  refreshVideoPanel(id);
  await store.genVideoCancel(id).catch(() => {});
}

/* 出片在缓存里；落块把它拷进画布 video/，新块自己带一份，面板接着改词重出。 */
export async function placeVideoBlock(id) {
  const item = findItem(id);
  if (!item || item.type !== "genvideo") return;
  const run = videoRunOf(id);
  if (!run.path || run.phase === "running") return;
  const canvasId = current?.meta.id;
  if (!canvasId) return;
  const name = "AI 视频.mp4";
  const rel = await copyIntoCanvas(canvasId, { path: run.path, name }, "video");
  if (!rel || !current || current.meta.id !== canvasId) return;
  const target = findItem(id);
  if (!target) return;
  placeBlock(makeVideo(target.x + target.w + GEN_PLACE_GAP, target.y, name, rel, false));
}
