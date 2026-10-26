/* 右下角鸟瞰窗：整张画布的缩小版 + 当前视窗框。
 * 拖那个框，主画布跟着走；点框外的任意处，把那处拉到屏幕正中。
 * 画在一张 <canvas> 上而不是把块镜像成 DOM 节点：块数上百时每次改动重建节点会卡，
 * 而这里要的只是几百个矩形，一次绘制就够跟住相机。 */

const STORAGE_KEY = "workbench.canvas.minimap";
const EDGE_PAD = 6; /* 小窗里四周留的空白（CSS px） */
const FIT_PAD = 0.08; /* 取景范围按内容外扩的比例 */
const MIN_FIT = 1200; /* 空画布时的兜底取景边长（世界像素），别让缩小版糊成一个点 */
const MIN_DOT = 1.5; /* 块再小也至少画这么大，否则内容铺得远时看不见 */

/* 按类型分色，只求一眼分辨「找那张图还是找那段字」，不追求还原卡片外观。
   线、箭头、连线不在表里 —— 鸟瞰窗里不画它们。 */
const TYPE_COLORS = {
  image: "#6ea8fe",
  audio: "#8fd6a0",
  video: "#c99af0",
  file: "#b9b3a4",
  ebook: "#e0b878",
  note: "#7fd4d0",
  sticky: "#e6d373",
  text: "#a8b0bd",
  rect: "#9a9aa6",
  ellipse: "#9a9aa6",
};

let hooks = null;
let ui = null;
let ctx = null;
let view = null; /* 上一次绘制的换算参数，命中测试要用 */
let fit = null; /* 取景范围（世界坐标），只在内容变了才重算 */
let fitKey = "";
let minimized = false;
let queued = false;
let drag = null;

export function initMinimap(options) {
  hooks = options;
  ui = {
    root: document.getElementById("canvas-minimap"),
    canvas: document.getElementById("canvas-minimap-canvas"),
    min: document.getElementById("canvas-minimap-min"),
    key: document.getElementById("canvas-minimap-key"),
  };
  ctx = ui.canvas.getContext("2d");
  ui.min.addEventListener("click", () => setMinimized(true));
  ui.key.addEventListener("click", () => setMinimized(false));
  ui.canvas.addEventListener("pointerdown", onPointerDown);
  ui.canvas.addEventListener("pointermove", onPointerMove);
  ui.canvas.addEventListener("pointerup", onPointerUp);
  ui.canvas.addEventListener("pointercancel", onPointerUp);
  /* 右键别漏给画布：在那上面弹块菜单没有意义 */
  ui.canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  new ResizeObserver(() => redraw()).observe(ui.canvas);
  setMinimized(localStorage.getItem(STORAGE_KEY) === "min");
}

export function refreshMinimap() {
  if (!ui || queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (!minimized) redraw();
  });
}

function setMinimized(on) {
  if (!ui) return;
  minimized = on;
  ui.root.hidden = on;
  ui.key.hidden = !on;
  localStorage.setItem(STORAGE_KEY, on ? "min" : "open");
  if (!on) redraw();
}

function mapToWorld(mx, my) {
  return { x: (mx - view.ox) / view.s, y: (my - view.oy) / view.s };
}

/* 把某个世界点摆到屏幕正中 */
function centerOn(wx, wy) {
  const camera = hooks.getCamera();
  const size = hooks.getStageSize();
  hooks.setCamera(size.w / 2 - wx * camera.scale, size.h / 2 - wy * camera.scale);
}

function panBy(dx, dy) {
  const camera = hooks.getCamera();
  hooks.setCamera(camera.x - dx * camera.scale, camera.y - dy * camera.scale);
}

function localPoint(e) {
  const rect = ui.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/* 手按在框上才算「拖框」；框跑到小窗外面时按贴边的那截也算 */
function onBox(p) {
  const b = view.box;
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

function onPointerDown(e) {
  if (e.button !== 0 || !view) return;
  e.preventDefault();
  e.stopPropagation();
  const p = localPoint(e);
  if (onBox(p)) {
    /* 拖框走增量：不依赖「这一点是哪个世界坐标」，取景怎么算都不会自反馈 */
    drag = { x: p.x, y: p.y };
  } else {
    drag = { jump: true };
    const hit = mapToWorld(p.x, p.y);
    centerOn(hit.x, hit.y);
  }
  ui.canvas.classList.add("is-grabbing");
  ui.canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  const p = localPoint(e);
  if (!drag) {
    if (view) ui.canvas.style.cursor = onBox(p) ? "grab" : "pointer";
    return;
  }
  if (drag.jump) {
    const hit = mapToWorld(p.x, p.y);
    centerOn(hit.x, hit.y);
    return;
  }
  panBy((p.x - drag.x) / view.s, (p.y - drag.y) / view.s);
  drag.x = p.x;
  drag.y = p.y;
}

function onPointerUp(e) {
  if (!drag) return;
  drag = null;
  ui.canvas.classList.remove("is-grabbing");
  ui.canvas.releasePointerCapture?.(e.pointerId);
  hooks.commitCamera();
}

function contentBounds(items) {
  let box = null;
  for (const item of items) {
    if (!TYPE_COLORS[item.type]) continue;
    const x = Number(item.x);
    const y = Number(item.y);
    const w = Number(item.w) || 0;
    const h = Number(item.h) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!box) box = { x1: x, y1: y, x2: x + w, y2: y + h };
    else {
      box.x1 = Math.min(box.x1, x);
      box.y1 = Math.min(box.y1, y);
      box.x2 = Math.max(box.x2, x + w);
      box.y2 = Math.max(box.y2, y + h);
    }
  }
  return box ? { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 } : null;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function redraw() {
  if (!ui || !ctx || !hooks.getCamera()) return;
  const rect = ui.canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (ui.canvas.width !== bw || ui.canvas.height !== bh) {
    ui.canvas.width = bw;
    ui.canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const camera = hooks.getCamera();
  const size = hooks.getStageSize();
  const items = hooks.getItems();
  const selectedId = hooks.getSelectedId();
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const viewport = {
    x: -camera.x / camera.scale,
    y: -camera.y / camera.scale,
    w: size.w / camera.scale,
    h: size.h / camera.scale,
  };

  /* 取景只跟内容走：把视窗也算进来会自我放大 —— 往外拖一点 → 取景变大 → 缩小比变小
     → 同一格鼠标对应的世界距离更远 → 拖得更远，实测 60px 鼠标能甩出 5000px 相机。
     代价是跑到内容外面时框会顶出小窗，所以下面把它贴到边上画，至少看得出「偏哪一边」。 */
  const content =
    contentBounds(items) ||
    (() => {
      /* 空画布钉一块以原点为中心的死区域，否则缩小版跟着视窗一起滑，看不出自己在动 */
      const half = MIN_FIT / 2;
      return { x1: -half, y1: -half, x2: half, y2: half };
    })();
  const key = `${content.x1},${content.y1},${content.x2},${content.y2}`;
  if (key !== fitKey || !fit) {
    const padX = Math.max((content.x2 - content.x1) * FIT_PAD, MIN_FIT * FIT_PAD);
    const padY = Math.max((content.y2 - content.y1) * FIT_PAD, MIN_FIT * FIT_PAD);
    fit = { x1: content.x1 - padX, y1: content.y1 - padY, x2: content.x2 + padX, y2: content.y2 + padY };
    fitKey = key;
  }
  const fitW = Math.max(fit.x2 - fit.x1, MIN_FIT);
  const fitH = Math.max(fit.y2 - fit.y1, MIN_FIT);
  const s = Math.min((w - EDGE_PAD * 2) / fitW, (h - EDGE_PAD * 2) / fitH);
  const ox = (w - fitW * s) / 2 - fit.x1 * s;
  const oy = (h - fitH * s) / 2 - fit.y1 * s;

  const vw = viewport.w * s;
  const vh = viewport.h * s;
  const box = {
    x: clamp(viewport.x * s + ox, 1, Math.max(w - vw - 1, 1)),
    y: clamp(viewport.y * s + oy, 1, Math.max(h - vh - 1, 1)),
    w: Math.min(vw, w - 2),
    h: Math.min(vh, h - 2),
  };
  view = { s, ox, oy, box };

  /* 视窗内填一点强调色，块压在上面画；框线最后描，压在一切之上 */
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = accent;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.globalAlpha = 1;

  /* 不在当前视野里的块压淡：一眼能看出哪些正看得见。
     淡到 0.3 在浅色主题下几乎看不见，实测过，留到 0.45。 */
  for (const item of items) {
    const color = TYPE_COLORS[item.type];
    if (!color || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    const x = item.x * s + ox;
    const y = item.y * s + oy;
    const rw = Math.max((Number(item.w) || 0) * s, MIN_DOT);
    const rh = Math.max((Number(item.h) || 0) * s, MIN_DOT);
    const visible = x + rw >= box.x && x <= box.x + box.w && y + rh >= box.y && y <= box.y + box.h;
    ctx.globalAlpha = item.id === selectedId ? 1 : visible ? 0.95 : 0.45;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, rw, rh, Math.min(2, rw / 2, rh / 2));
    ctx.fill();
    if (item.id === selectedId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(box.w - 1, 1), Math.max(box.h - 1, 1));
}
