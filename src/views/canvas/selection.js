/* 从 canvas.js 拆出：selection
 *
 * 选中态的公共部分：标题栏路径、面板树高亮、选中框与四角把手、锁点标记。
 * 这里只管「画出来」，选中集合由 canvas.js 维护。 */

import { boundsOfItem, connectorGeometry, current, findItem, itemBounds, itemEls, panelTreeLabel, refreshConnectors, refreshMinimap, revealSelectionInTree, scheduleMeasurements, selectedIds, treeUi, ui, updatePorts, worldToStage } from "../canvas.js";

/* 标题栏：当前画布路径；单选面板时跟上 #N 名称（没自定义名就是类型） */
export function refreshTitlebarPath() {
  const el = document.getElementById("titlebar-path");
  if (!el) return;
  if (!current) {
    el.textContent = "";
    el.title = "";
    return;
  }
  const parts = [String(current.meta.id || "").replace(/\//g, "\\")];
  const ids = [...selectedIds].filter((id) => findItem(id)?.type !== "connector");
  if (ids.length === 1) {
    const item = findItem(ids[0]);
    if (item && Number.isFinite(item.seq) && item.seq > 0) parts.push(panelTreeLabel(item));
  } else if (ids.length > 1) {
    parts.push(`已选 ${ids.length} 项`);
  }
  const text = parts.filter(Boolean).join("\\");
  el.textContent = text;
  el.title = text;
}

/* 画布上选中的块，面板树里对应的行跟着亮底；容器折叠时子块行不在 DOM，自然没有可亮的 */
export function syncTreeSelection() {
  const body = treeUi?.body;
  if (!body) return;
  revealSelectionInTree();
  let first = null;
  for (const row of body.querySelectorAll(".space-tree-row[data-id]")) {
    const on = selectedIds.has(row.dataset.id);
    row.classList.toggle("is-selected", on);
    if (on && !first) first = row;
  }
  /* 选中的行滚出树可视区时把树带过去，不然亮在滚动条下面看不见 */
  if (first) first.scrollIntoView({ block: "nearest" });
}

/* 只选了一个时才有的「那一个」；多选时返回 null，缩放和端口这些单块操作照旧不出现 */
export function loneSelected() {
  return selectedIds.size === 1 ? [...selectedIds][0] : null;
}

/* 锁定的块在左下角信息条的 #N 前面挂一枚小锁；非锁定不挂 */
export const LOCK_BADGE_SVG = `<svg class="canvas-metrics-lock" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="5.3" width="7.4" height="5.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.1 5.3V4a1.9 1.9 0 0 1 3.8 0v1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

export function updateSelection() {
  if (!ui) return;
  syncTreeSelection();
  refreshTitlebarPath();
  refreshConnectors();
  for (const stale of ui.world.querySelectorAll(".canvas-sel-box")) stale.remove();
  ui.endpointLayer.textContent = "";
  if (ui.handleVisualLayer) ui.handleVisualLayer.textContent = "";
  updatePorts();
  refreshMinimap();
  if (!selectedIds.size) return;
  /* 四角缩放把手和线的端点拖拽只给「就选了一个」：一堆块同时缩放没意义，把手糊成一片也没法点 */
  const lone = selectedIds.size === 1;
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (item && el) drawSelectionFor(item, el, lone);
  }
  scheduleMeasurements();
}

/* 选中的记号只剩「四边那几个圈」：描边、柔光全都不要了，单选多选一样。
   所以这里只画两类东西：所有块共用的四角隐形把手（单选时），以及线/箭头两头的端点圈。
   面板四边的端口圈由 updatePorts 统一画，不在这里管。 */
export function drawSelectionFor(item, el, lone) {
  el.classList.add("is-selected");

  if (item.type === "connector") {
    if (!lone) return;
    const geometry = connectorGeometry(item, boundsOfItem);
    if (!geometry) return;
    /* 折点圈先放、两端圈后放：折点被拖到端口上时，端点圈仍然压在上面能拖 */
    if (item.bend) {
      for (const [index, point] of (geometry.points || []).entries()) {
        const screen = worldToStage(point.x, point.y);
        const handle = document.createElement("span");
        handle.className = "canvas-handle canvas-handle-point canvas-handle-bend";
        handle.dataset.handle = "bend";
        handle.dataset.index = String(index);
        handle.title = "拖动调整走线，双击删除折点";
        handle.style.left = `${screen.x}px`;
        handle.style.top = `${screen.y}px`;
        ui.endpointLayer.append(handle);
      }
    }
    for (const [end, point] of [
      ["from", geometry.a],
      ["to", geometry.b],
    ]) {
      const screen = worldToStage(point.x, point.y);
      const handle = document.createElement("span");
      handle.className = "canvas-handle canvas-handle-point";
      handle.dataset.handle = "connect-end";
      handle.dataset.end = end;
      handle.style.left = `${screen.x}px`;
      handle.style.top = `${screen.y}px`;
      ui.endpointLayer.append(handle);
    }
    return;
  }

  /* 锁住的块不给能改它的把手：不能缩放，线的端点也不能拖 */
  if (item.locked) return;
  /* 线没有四边端口圈，选中就靠两头那颗圈说话，多选也一样画 */
  if (item.type === "line" || item.type === "arrow") {
    const box = addOverlayBox(el, "canvas-sel-box");
    const bounds = itemBounds(item, el);
    for (const end of ["a", "b"]) {
      const point = end === "a" ? { x: item.x, y: item.y } : { x: item.x2, y: item.y2 };
      const handle = document.createElement("span");
      handle.className = "canvas-handle canvas-handle-point canvas-handle-hit";
      handle.dataset.handle = "endpoint";
      handle.dataset.end = end;
      /* 端点相对包围盒是固定百分比，块怎么缩放挪动都跟得住（水平/竖直线的某条边是 0，落在 0% 正好） */
      handle.style.left = `${((point.x - bounds.x) / Math.max(1, bounds.w)) * 100}%`;
      handle.style.top = `${((point.y - bounds.y) / Math.max(1, bounds.h)) * 100}%`;
      /* 一堆块同时拽两根端点没意义：只有单选那根线的圈能拖 */
      if (!lone) handle.dataset.inert = "1";
      box.append(handle);
      /* 看得见的端点圈画在屏幕层，和锁点/端口一样不受缩放栅格化影响 */
      const screen = worldToStage(point.x, point.y);
      const dot = document.createElement("span");
      dot.className = "canvas-handle-visual";
      if (!lone) dot.dataset.inert = "1";
      dot.style.left = `${screen.x}px`;
      dot.style.top = `${screen.y}px`;
      ui.handleVisualLayer.append(dot);
    }
    return;
  }

  /* 一堆块同时缩放没意义，缩放把手只给单选那一块 */
  if (!lone) return;
  const box = addOverlayBox(el, "canvas-sel-box");
  /* 四边先放、四角后放：角上那一小块归角缩放，边上其余位置归边缩放 */
  for (const dir of ["n", "e", "s", "w"]) {
    const handle = document.createElement("span");
    handle.className = `canvas-handle canvas-handle-${dir}`;
    handle.dataset.handle = "edge";
    handle.dataset.dir = dir;
    box.append(handle);
  }
  for (const dir of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("span");
    handle.className = `canvas-handle canvas-handle-${dir}`;
    handle.dataset.handle = "corner";
    handle.dataset.dir = dir;
    box.append(handle);
  }
}

/* 选中框、端口框都塞进块自己，跟着块的层级走：块被压在下面，这些记号也一起被压住，
   不再永远浮在所有块之上。绝对定位按块的 padding box 算，默认把边框宽度补回去贴外沿；
   端口传 0.5，让圆圈落在边框带的正中，不然高倍缩放下会贴着外沿、看起来偏心。 */
export function addOverlayBox(el, className, borderFactor = 1) {
  const box = document.createElement("div");
  box.className = className;
  const style = getComputedStyle(el);
  box.style.inset = [
    parseFloat(style.borderTopWidth),
    parseFloat(style.borderRightWidth),
    parseFloat(style.borderBottomWidth),
    parseFloat(style.borderLeftWidth),
  ]
    .map((px) => `${-px * borderFactor}px`)
    .join(" ");
  el.append(box);
  return box;
}
