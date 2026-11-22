/* 从 canvas.js 拆出：tools-camera */

import { MAX_SCALE, MIN_SCALE, SCENE_DEFAULT_HEIGHT, SCENE_DEFAULT_WIDTH, ZOOM_HOLD_DELAY, ZOOM_HOLD_INTERVAL, active, agentRevealBlock, assignTool, clamp, ctrlHeld, current, editingId, findItem, fileTypeMenuItems, insertFileFromPicker, insertGenPanel, insertPoint, insertVideoPanel, itemBounds, itemEls, makeScene, normalizeSceneParts, noteEditor, openMenu, persistScene, placeBlock, positionEdgeLabelEditor, sceneLightOf, sceneSurfacesOf, scheduleCameraSave, scheduleItemsSave, select, setCosmosCamera, setSceneCameraScale, tool, toolboxMarkup, ui, updateSelection } from "../canvas.js";
import { clampCameraXToPage } from "./page-width-core.js";

/* ---------- 工具与相机 ---------- */

/* 手里端着哪个工具，标题栏那颗「工具」按钮就换成哪个工具的图标；
   没端工具（选择态）时显示工具箱图标。图标与旧工具栏逐一对齐。 */
export const TOOL_ICONS = {
  rect: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4.5" width="13" height="11" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  ellipse: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.4" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  line: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 16 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 16 4M9.5 4H16v6.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  text: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h13M10 4.5v11M7.2 15.5h5.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  picture:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.4" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.2 13.4c1.6-3.4 3-1.2 4.3-3.1 1.2-1.8 2.5.9 4.2-1.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
};
export const TOOL_LABELS = {
  rect: "矩形",
  ellipse: "圆形",
  line: "直线",
  arrow: "箭头",
  text: "文字",
  picture: "画图",
};

/* 工具下拉清单：标题栏工具按钮和画布空白处右键共用这一份。
   六种画图工具排成两行图标格（标题栏里也是 15px 图标，这里放大到 17px）；
   工具都是一次性的，用完自动回选择，所以不列「选择」。
   插入文件和 AI 出图是动作，保持文字行。 */
export function toolMenuEntries() {
  const entry = (name) => ({
    label: TOOL_LABELS[name],
    icon: TOOL_ICONS[name],
    active: tool === name,
    onClick: () => setTool(name),
  });
  return [
    { grid: [entry("rect"), entry("ellipse"), entry("line"), entry("arrow"), entry("text"), entry("picture")] },
    "-",
    {
      label: "插入文件…",
      onClick: () => {
        dropTool();
        insertFileFromPicker();
      },
    },
    {
      label: "新建文件",
      searchable: true,
      children: fileTypeMenuItems(),
    },
    {
      label: "AI 出图",
      children: [
        { label: "文生图", onClick: () => armAndInsertGen("t2i") },
        { label: "图生图", onClick: () => armAndInsertGen("i2i") },
        { label: "参考图编辑", onClick: () => armAndInsertGen("edit") },
        { label: "图片局部重绘", onClick: () => armAndInsertGen("inpaint") },
        { label: "图片高清放大", onClick: () => armAndInsertGen("upscale") },
      ],
    },
    {
      label: "AI 视频",
      onClick: () => {
        dropTool();
        insertVideoPanel();
      },
    },
    {
      label: "3D 场景",
      onClick: () => {
        dropTool();
        insertSceneBlock();
      },
    },
  ];
}

/* 用户自己建 3D 场景：起手就是一间能用的客厅（地板/背景墙/侧墙/窗/地毯/边柜 + 白天光） */
export function insertSceneBlock() {
  if (!current) return;
  const at = insertPoint(SCENE_DEFAULT_WIDTH, SCENE_DEFAULT_HEIGHT);
  const item = makeScene(at.x, at.y);
  /* 默认就一个空间 + 一块地板：墙/窗要的话自己加（或让 agent 铺房间壳） */
  const got = normalizeSceneParts([
    { op: "box", x: 0, y: 0, z: 0, w: 620, d: 520, h: 2, color: "#b98a5e", name: "地板" },
  ]);
  item.parts = got.parts;
  item.surfaces = sceneSurfacesOf([
    { id: "floor", name: "地面", kind: "floor", x: 0, y: 0, z: 2, w: 608, h: 508 },
  ]);
  item.light = sceneLightOf("day");
  placeBlock(item);
  persistScene(item);
  select(item.id);
  agentRevealBlock(item.id);
  scheduleItemsSave();
}

export function armAndInsertGen(mode) {
  dropTool();
  insertGenPanel(mode);
}

export function openToolMenu() {
  if (!current) return;
  const rect = ui.toolMenu.getBoundingClientRect();
  openMenu(rect.left, rect.bottom + 8, toolMenuEntries(), { kind: "tools" });
}

export function setTool(name, keepSelection = false) {
  assignTool(name);
  const armed = name !== "select";
  ui.toolMenu?.classList.toggle("is-active", armed);
  ui.toolMenu?.setAttribute("aria-pressed", String(armed));
  if (ui.toolIcon) ui.toolIcon.innerHTML = (armed && TOOL_ICONS[name]) || toolboxMarkup;
  ui.stage.dataset.tool = name;
  if (name !== "select" && !keepSelection) select(null);
  setMarqueeCursor();
}

/* Ctrl 按住 = 框选：光标换成十字，拖出矩形松手把相交的块加进选择。
   输入框里的 Ctrl（选字/复制）不归它管，按下走原有输入逻辑。 */
export let marqueeEl = null;

export function setMarqueeCursor() {
  if (!ui?.stage) return;
  ui.stage.classList.toggle("is-marquee-ready", ctrlHeld && tool === "select");
}

/* 框选拖到窗口边缘时自动平移视野：拖出去的框才能罩到视野外的块。
   起点存世界坐标，相机一动框就跟着视野重新算（屏幕层只是显示）。 */
const MARQUEE_EDGE = 52;
const MARQUEE_MAX_SPEED = 22;
let marqueeFrame = 0;
let marqueeState = null;

function stopMarqueePan() {
  if (marqueeFrame) cancelAnimationFrame(marqueeFrame);
  marqueeFrame = 0;
  marqueeState = null;
}

function marqueeAutoPan(dragState) {
  const stage = ui.stage;
  const r = stage.getBoundingClientRect();
  const at = dragState.last;
  let vx = 0;
  let vy = 0;
  if (at.x < r.left + MARQUEE_EDGE) vx = MARQUEE_MAX_SPEED * Math.min(1, (r.left + MARQUEE_EDGE - at.x) / MARQUEE_EDGE);
  else if (at.x > r.right - MARQUEE_EDGE) vx = -MARQUEE_MAX_SPEED * Math.min(1, (at.x - (r.right - MARQUEE_EDGE)) / MARQUEE_EDGE);
  if (at.y < r.top + MARQUEE_EDGE) vy = MARQUEE_MAX_SPEED * Math.min(1, (r.top + MARQUEE_EDGE - at.y) / MARQUEE_EDGE);
  else if (at.y > r.bottom - MARQUEE_EDGE) vy = -MARQUEE_MAX_SPEED * Math.min(1, (at.y - (r.bottom - MARQUEE_EDGE)) / MARQUEE_EDGE);
  if (vx || vy) {
    current.camera.x += vx;
    current.camera.y += vy;
    applyCamera();
    scheduleCulling();
    scheduleCameraSave();
    updateMarquee(dragState, at.x, at.y);
  }
  marqueeFrame = requestAnimationFrame(() => marqueeAutoPan(dragState));
}

export function beginMarquee(event, clickId) {
  const box = document.createElement("div");
  box.className = "canvas-marquee";
  box.hidden = true;
  document.body.append(box);
  marqueeEl = box;
  const world = clientToWorld(event.clientX, event.clientY);
  const state = {
    kind: "marquee",
    startClient: { x: event.clientX, y: event.clientY },
    startWorld: { x: world.x, y: world.y },
    last: { x: event.clientX, y: event.clientY },
    clickId,
    moved: false,
  };
  stopMarqueePan();
  marqueeState = state;
  marqueeFrame = requestAnimationFrame(() => marqueeAutoPan(state));
  return state;
}

export function updateMarquee(dragState, clientX, clientY) {
  if (!marqueeEl) return;
  dragState.last = { x: clientX, y: clientY };
  /* 起点按世界坐标换算成当前屏幕位置：视野被自动平移后框会跟着一起走 */
  const start = worldToStage(dragState.startWorld.x, dragState.startWorld.y);
  const left = Math.min(start.x, clientX);
  const top = Math.min(start.y, clientY);
  const width = Math.abs(clientX - start.x);
  const height = Math.abs(clientY - start.y);
  marqueeEl.hidden = false;
  marqueeEl.style.left = `${left}px`;
  marqueeEl.style.top = `${top}px`;
  marqueeEl.style.width = `${width}px`;
  marqueeEl.style.height = `${height}px`;
  const endWorld = clientToWorld(clientX, clientY);
  dragState.rect = {
    x1: Math.min(dragState.startWorld.x, endWorld.x),
    y1: Math.min(dragState.startWorld.y, endWorld.y),
    x2: Math.max(dragState.startWorld.x, endWorld.x),
    y2: Math.max(dragState.startWorld.y, endWorld.y),
  };
}

export function finishMarquee(dragState) {
  stopMarqueePan();
  marqueeEl?.remove();
  marqueeEl = null;
  if (!dragState.moved) {
    /* 没拖动就是一次 Ctrl+点击：点到块加选，点空白清空 */
    if (dragState.clickId && findItem(dragState.clickId)) select(dragState.clickId, true);
    else select(null);
    return;
  }
  const rect = dragState.rect;
  if (!rect || !current) return;
  const hits = [];
  for (const item of current.items) {
    if (item.type === "connector") continue;
    const el = itemEls.get(item.id);
    if (!el) continue;
    const box = itemBounds(item, el);
    if (box.x > rect.x2 || box.x + box.w < rect.x1 || box.y > rect.y2 || box.y + box.h < rect.y1) {
      continue;
    }
    hits.push(item.id);
  }
  for (const id of hits) select(id, true);
}

/* 画图工具是一次性的：这一按（或这一次操作）没能真的起画，就把选中态交回第一个按钮，
   别让蓝点卡在「文字」上。保留当前选中的块，退工具不该顺手把人选的清空。 */
export function dropTool() {
  if (tool !== "select") setTool("select", true);
}

export function applyCamera() {
  if (!current) return;
  const camera = current.camera;
  /* 固定宽度横移约束：视口不得跑出页面左右各 50px。所有改相机的入口（拖画布、
     缩放、鸟瞰窗、agent 动画）都走这里，集中一处收口。y 无限，不碰。 */
  clampCameraXToPage(camera, ui.stage?.clientWidth || 0, current.pageWidth);
  ui.world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  /* 选中框、端口、缩放手柄都画在块的坐标系里，乘上这个倒数才在屏幕上保持固定粗细和大小。
     只挂在 world 上：连线端点手柄在 world 外面的屏幕坐标层，本来就不该跟着缩放。 */
  ui.world.style.setProperty("--canvas-inv", String(1 / camera.scale));
  /* 连线层单独一层，靠同一套相机变换跟 world 对齐 */
  ui.edgeTransform.setAttribute(
    "transform",
    `translate(${camera.x} ${camera.y}) scale(${camera.scale})`,
  );
  /* 固定宽度的白页/灰底跟着相机一起走：横向两个色标就是页面左右边界的屏幕 x */
  const shade = document.querySelector("#canvas-page-shade");
  if (shade) {
    shade.hidden = !(current.pageWidth > 0);
  }
  if (shade && !shade.hidden) {
    const stageW = ui.stage?.clientWidth || 0;
    const left = Math.max(0, Math.min(stageW, camera.x));
    const right = Math.max(0, Math.min(stageW, camera.x + current.pageWidth * camera.scale));
    shade.style.background =
      `linear-gradient(to right, var(--page-outside) 0 ${left}px,` +
      ` var(--page-inside) ${left}px ${right}px,` +
      ` var(--page-outside) ${right}px ${stageW}px)`;
  }
  syncZoomLabel();
  updateSelection();
  positionEdgeLabelEditor();
  setCosmosCamera(camera);
  /* 场景块的位图分辨率要跟着相机缩放重算：CSS 的 scale 只是把已有的画布放大，
     不重画的话放到 4 倍就是一坨马赛克 */
  setSceneCameraScale(camera.scale);
  scheduleCulling();
}

/* 视口裁剪：只渲染视野附近的面板。上千块的参考画布如果全部挂在 DOM 里，
   拖动和缩放每一帧都要把整棵树重新画一遍，卡得没法操作。
   只裁普通块；场景/生图/音视频自带运行时，显示/隐藏可能把它们的上下文弄坏，不碰。 */
export const CULL_MARGIN_PX = 480;
export const CULL_TYPES = new Set(["text", "image", "rect", "ellipse", "line", "arrow", "note", "picture", "product", "quote", "plan", "page"]);
export let cullingSuspended = 0;
export let cullFrame = 0;

export function scheduleCulling() {
  if (cullingSuspended || cullFrame) return;
  cullFrame = requestAnimationFrame(() => {
    cullFrame = 0;
    refreshCulling();
  });
}

export function refreshCulling() {
  if (!current || !ui?.world || cullingSuspended) return;
  const rect = ui.stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const { x, y, scale } = current.camera;
  const pad = CULL_MARGIN_PX / scale;
  const left = -x / scale - pad;
  const top = -y / scale - pad;
  const right = (rect.width - x) / scale + pad;
  const bottom = (rect.height - y) / scale + pad;
  /* 正在编辑的块不能被藏掉，不然输入焦点和光标会一起没 */
  const keep = editingId || noteEditor?.itemId || "";
  const revealed = [];
  for (const item of current.items) {
    if (!CULL_TYPES.has(item.type)) continue;
    const el = itemEls.get(item.id);
    if (!el) continue;
    let bx = item.x;
    let by = item.y;
    let bw = item.w;
    let bh = item.h || 24;
    if (item.type === "line" || item.type === "arrow") {
      const x2 = Number.isFinite(item.x2) ? item.x2 : item.x;
      const y2 = Number.isFinite(item.y2) ? item.y2 : item.y;
      bx = Math.min(item.x, x2);
      by = Math.min(item.y, y2);
      bw = Math.abs(x2 - item.x);
      bh = Math.abs(y2 - item.y);
    }
    const inside =
      item.id === keep || (bx + bw >= left && bx <= right && by + bh >= top && by <= bottom);
    const wasCulled = el.classList.contains("is-culled");
    el.classList.toggle("is-culled", !inside);
    if (wasCulled && inside && item.type === "text") revealed.push(item);
  }
  /* 藏起来时量不到字高，回到视野里再补一次，后面的吸附/连线用的是最新高度 */
  if (revealed.length) {
    requestAnimationFrame(() => {
      for (const item of revealed) {
        const el = itemEls.get(item.id);
        if (!el || el.classList.contains("is-culled")) continue;
        const measured = el.offsetHeight;
        if (measured) item.h = measured;
      }
    });
  }
}

export async function withAllVisible(fn) {
  cullingSuspended += 1;
  const hidden = ui?.world ? [...ui.world.querySelectorAll(".canvas-item.is-culled")] : [];
  for (const el of hidden) el.classList.remove("is-culled");
  try {
    return await fn();
  } finally {
    cullingSuspended -= 1;
    if (!cullingSuspended) scheduleCulling();
  }
}

window.addEventListener("resize", scheduleCulling);

export function zoomLabel() {
  return `${Math.round((current?.camera.scale ?? 1) * 100)}%`;
}

export function selectZoomDigits() {
  if (document.activeElement !== ui.zoomValue) return;
  const value = ui.zoomValue.value;
  const end = value.endsWith("%") ? value.length - 1 : value.length;
  ui.zoomValue.setSelectionRange(0, end);
}

/* 正在输入时不要把手打的字盖掉 */
export function syncZoomLabel() {
  if (ui && document.activeElement === ui.zoomValue) return;
  if (ui) ui.zoomValue.value = zoomLabel();
}

export function applyZoomInput() {
  const raw = parseFloat(String(ui.zoomValue.value).replace(/[^0-9.]/g, ""));
  if (!current || !Number.isFinite(raw)) {
    ui.zoomValue.value = zoomLabel();
    return;
  }
  zoomAt(ui.stage.clientWidth / 2, ui.stage.clientHeight / 2, raw / 100);
  ui.zoomValue.value = zoomLabel();
}

export function zoomAt(screenX, screenY, nextScale) {
  if (!current) return;
  const camera = current.camera;
  const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  const worldX = (screenX - camera.x) / camera.scale;
  const worldY = (screenY - camera.y) / camera.scale;
  camera.scale = scale;
  camera.x = screenX - worldX * scale;
  camera.y = screenY - worldY * scale;
  applyCamera();
  scheduleCameraSave();
}

export function zoomBy(delta) {
  if (!current) return;
  zoomAt(ui.stage.clientWidth / 2, ui.stage.clientHeight / 2, current.camera.scale + delta);
}

/* 缩放键长按连发：按下先走一步，按住不放就按节拍继续走，松开/移出/失焦都停 */
export function bindZoomHold(button, delta) {
  let delayTimer = 0;
  let repeatTimer = 0;

  const stop = () => {
    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = 0;
    }
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = 0;
    }
  };

  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    stop();
    zoomBy(delta);
    delayTimer = setTimeout(() => {
      delayTimer = 0;
      repeatTimer = setInterval(() => zoomBy(delta), ZOOM_HOLD_INTERVAL);
    }, ZOOM_HOLD_DELAY);
  });
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointerleave", stop);
  button.addEventListener("pointercancel", stop);
  window.addEventListener("pointerup", stop);
  window.addEventListener("blur", stop);
  /* 鼠标点下的那一步已经在 pointerdown 里走了；键盘回车/空格没有 pointerdown，照旧走 click */
  button.addEventListener("click", (e) => {
    if (e.detail === 0) zoomBy(delta);
  });
}

export function resetZoom() {
  if (!current) return;
  zoomAt(ui.stage.clientWidth / 2, ui.stage.clientHeight / 2, 1);
}

/* 从落点往上找有没有真的带滚动条的容器（笔记正文、编辑框、代码块等） */
export function hasScrollableAncestor(node, vertical) {
  for (let el = node; el && el !== ui.stage; el = el.parentElement) {
    const overflow = vertical ? getComputedStyle(el).overflowY : getComputedStyle(el).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const room = vertical
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;
    if (room > 1) return true;
  }
  return false;
}

export function clientToWorld(clientX, clientY) {
  const rect = ui.stage.getBoundingClientRect();
  const camera = current.camera;
  return {
    x: (clientX - rect.left - camera.x) / camera.scale,
    y: (clientY - rect.top - camera.y) / camera.scale,
  };
}

export function worldToStage(x, y) {
  const camera = current.camera;
  return { x: camera.x + x * camera.scale, y: camera.y + y * camera.scale };
}
