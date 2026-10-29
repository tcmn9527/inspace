/* 右下角鸟瞰窗：整个空间的缩小版 + 当前视窗框。
 * 拖那个框，主空间跟着走；点框外的任意处，把那处拉到屏幕正中。
 * 点过一下之后框进入「选中」态，此时方向键能一格一格挪视野（Shift 大步）。
 * 画在一张 <canvas> 上而不是把块镜像成 DOM 节点：块数上百时每次改动重建节点会卡，
 * 而这里要的只是几百个矩形，一次绘制就够跟住相机。 */

const STORAGE_KEY = "workbench.canvas.minimap";
const EDGE_PAD = 6; /* 小窗里四周留的空白（CSS px） */
const FIT_PAD = 0.08; /* 取景范围按内容外扩的比例 */
const VIEWPORT_FIT = 1.6; /* 取景至少是视野这么大：框最多占小窗约三分之二，才看得出在挪 */
const MIN_FIT = 1200; /* 没有空间时的兜底取景边长（世界像素），别让缩小版糊成一个点 */
const MIN_DOT = 1.5; /* 块再小也至少画这么大，否则内容铺得远时看不见 */
const NUDGE = 0.05; /* 方向键一格挪视野的 5% */
const NUDGE_FAST = 0.25; /* 按住 Shift 一格挪 25% */

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
let minimized = false;
let queued = false;
let drag = null;
let focused = false; /* 点过一次视窗框之后，方向键归它 */

export function initMinimap(options) {
  hooks = options;
  ui = {
    root: document.getElementById("canvas-minimap"),
    canvas: document.getElementById("canvas-minimap-canvas"),
    count: document.getElementById("canvas-minimap-count"),
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
  /* 右键别漏给空间：在那上面弹块菜单没有意义 */
  ui.canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  new ResizeObserver(() => redraw()).observe(ui.canvas);
  document.addEventListener("keydown", onKeyDown);
  setMinimized(localStorage.getItem(STORAGE_KEY) === "min");
}

/* 取消「方向键归鸟瞰窗」；返回 true 表示刚才确实是选中态、这个按键事件已被用掉 */
export function blurMinimapFocus() {
  if (!focused) return false;
  focused = false;
  redraw();
  return true;
}

/* 方向键此刻归谁：鸟瞰窗拿着的时候，空间就别用方向键挪块 */
export function isMinimapFocused() {
  return focused;
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
  /* 面板都看不见了还吃方向键，会让人以为空间自己乱走 */
  if (on) focused = false;
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
  focused = true;
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
  /* 拖框期间没人重画（相机变化只改主空间的 transform），松手补一次，
     顺手把选中态画出来 */
  redraw();
}

/* 选中之后方向键挪视野：一格是视野的 5%，按住 Shift 是 25% */
function onKeyDown(e) {
  if (!focused || minimized || !view) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  const dy = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  if (!dx && !dy) return;
  const camera = hooks.getCamera();
  const size = hooks.getStageSize();
  if (!camera || !size.w || !size.h) return;
  const focusedEl = document.activeElement;
  if (
    focusedEl &&
    (focusedEl.tagName === "INPUT" ||
      focusedEl.tagName === "TEXTAREA" ||
      focusedEl.isContentEditable)
  ) {
    return;
  }
  e.preventDefault();
  const ratio = e.shiftKey ? NUDGE_FAST : NUDGE;
  /* panBy 收的是世界像素，视野本身在世界里就是 stage 尺寸 / scale */
  panBy(dx * ratio * (size.w / camera.scale), dy * ratio * (size.h / camera.scale));
  hooks.commitCamera();
  redraw();
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

/* 选中态要把框线往前景色压暗一档。主题变量可能写成 hsl() 或 color-mix()，
   空间不见得认得，所以借一个隐藏节点让浏览器自己解析成 rgb。 */
let probe = null;

function toRgb(color) {
  if (!color) return null;
  if (!probe) {
    probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
  }
  probe.style.color = "";
  probe.style.color = color;
  const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(getComputedStyle(probe).color);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function shade(color, amount) {
  const base = toRgb(color);
  const dark = toRgb(getComputedStyle(document.documentElement).getPropertyValue("--fg").trim());
  if (!base || !dark) return color;
  const mixed = base.map((v, i) => Math.round(v + (dark[i] - v) * amount));
  return `rgb(${mixed.join(",")})`;
}

function redraw() {
  if (!ui || !ctx) return;
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
  /* 没有空间可看时（删到最后一个、停在空白页），上面那次擦除就是全部工作：
     早退要退在擦除之后，否则上一个空间的块、框、数字会一直留在玻璃上。
     view 一并清空，面板从此不再吃鼠标。 */
  if (!hooks.getCamera()) {
    view = null;
    if (ui.count) ui.count.textContent = "0";
    return;
  }

  const camera = hooks.getCamera();
  const size = hooks.getStageSize();
  const items = hooks.getItems();
  const selectedIds = hooks.getSelectedIds();
  if (ui.count) {
    /* 连线不是「一块面板」，按空间自己的口径排除 */
    ui.count.textContent = String(items.filter((item) => item.type !== "connector").length);
  }
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const viewport = {
    x: -camera.x / camera.scale,
    y: -camera.y / camera.scale,
    w: size.w / camera.scale,
    h: size.h / camera.scale,
  };

  /* 取景只跟内容走：把视窗也算进来会自我放大 —— 往外拖一点 → 取景变大 → 缩小比变小
     → 同一格鼠标对应的世界距离更远 → 拖得更远，实测 60px 鼠标能甩出 5000px 相机。
     代价是跑到内容外面时框会顶出小窗，所以下面把它贴到边上画，至少看得出「偏哪一边」。
     地板按视窗的「大小」放（不看相机在哪儿），所以拖框喂不出正反馈：
     内容只有两块时，光靠 MIN_FIT 兜底会窄于视野，框一画就铺满小窗、贴边钉死，怎么挪都不动。 */
  const content =
    contentBounds(items) ||
    (() => {
      /* 空的空间钉一块以原点为中心的死区域，否则缩小版跟着视窗一起滑，看不出自己在动 */
      const half = MIN_FIT / 2;
      return { x1: -half, y1: -half, x2: half, y2: half };
    })();
  const cx = (content.x1 + content.x2) / 2;
  const cy = (content.y1 + content.y2) / 2;
  const halfW = Math.max(
    (content.x2 - content.x1) / 2 + Math.max((content.x2 - content.x1) * FIT_PAD, MIN_FIT * FIT_PAD),
    (viewport.w * VIEWPORT_FIT) / 2,
  );
  const halfH = Math.max(
    (content.y2 - content.y1) / 2 + Math.max((content.y2 - content.y1) * FIT_PAD, MIN_FIT * FIT_PAD),
    (viewport.h * VIEWPORT_FIT) / 2,
  );
  const fitW = halfW * 2;
  const fitH = halfH * 2;
  const s = Math.min((w - EDGE_PAD * 2) / fitW, (h - EDGE_PAD * 2) / fitH);
  const ox = (w - fitW * s) / 2 - (cx - halfW) * s;
  const oy = (h - fitH * s) / 2 - (cy - halfH) * s;

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
    ctx.globalAlpha = selectedIds.has(item.id) ? 1 : visible ? 0.95 : 0.45;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, rw, rh, Math.min(2, rw / 2, rh / 2));
    ctx.fill();
    if (selectedIds.has(item.id)) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  /* 选中态：框线加粗并压暗一档（2px 是偶数，不半边对齐） */
  ctx.strokeStyle = focused ? shade(accent, 0.45) : accent;
  ctx.lineWidth = focused ? 2 : 1;
  const inset = focused ? 0 : 0.5;
  ctx.strokeRect(box.x + inset, box.y + inset, Math.max(box.w - 1, 1), Math.max(box.h - 1, 1));
}
