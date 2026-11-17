/* 从 canvas.js 拆出：connectors */

import { CONNECTABLE, SVG_NS, active, addItemElement, addOverlayBox, assignHoverId, boundsOfItem, clientToWorld, commitEditing, current, drag, edgeLabelEditor, editingId, findItem, hoverId, itemBounds, itemEls, makeConnector, pinConnectorSides, previewPath, routeConnectorPreview, scheduleItemsSave, select, selectedIds, setDrag, setPreviewPath, syncConnector, tool, ui, updateSelection, worldToStage } from "../canvas.js";

/* ---------- 连线交互 ---------- */

/* 端口圈现在兼作选中的记号，所以一次画一批：
   - 选中集合里每块一套「选中态」圈；换到画框/划线工具也照样在，只是不响应拖连线，
     否则选了块一切工具就看不出选了谁。
   - 鼠标悬停但没点中的那块，给现在那种普通空心圈；它已经在集合里就只画选中态，不叠两套。
   - 拖连线途中只跟着光标下那块走（要瞄准具体的边）。 */
export function portTargets() {
  if (!current || !active || editingId) return [];
  const out = [];
  const seen = new Set();
  const push = (id, selected) => {
    const item = findItem(id);
    /* 锁住的块不挂端口圈：悬停和选中都只靠右上角那颗小点说话 */
    if (!item || !CONNECTABLE.has(item.type) || item.locked || seen.has(id)) return;
    seen.add(id);
    out.push({ id, selected });
  };
  /* 画方框时端口只是记号，别让它抢走本该落进 world 的按下 */
  const marksOnly = tool !== "select";
  const connecting = drag && (drag.kind === "connect" || drag.kind === "connect-end");
  for (const id of selectedIds) push(id, true);
  if (drag) {
    /* 拖连线途中：光标下那块的圈要能被命中（瞄准具体边靠它）；其余拖拽期都不吃鼠标 */
    if (connecting && drag.targetId) push(drag.targetId, false);
    return out.map((t) => ({ ...t, marksOnly: !connecting }));
  }
  if (!marksOnly && hoverId) push(hoverId, false);
  return out.map((t) => ({ ...t, marksOnly }));
}

export function updatePorts() {
  if (!ui?.world) return;
  for (const stale of ui.world.querySelectorAll(".canvas-port-box")) stale.remove();
  if (ui.portVisualLayer) ui.portVisualLayer.textContent = "";
  /* 两块挨得太近时，端口圈会叠成一颗更大的点。同一条屏幕位置只留先来的那颗：
     选中的排在悬停前面，所以优先保留选中态。 */
  const placed = [];
  const painted = [];
  const taken = (point) =>
    placed.some((one) => Math.hypot(one.x - point.x, one.y - point.y) < 8);
  for (const target of portTargets()) {
    const item = findItem(target.id);
    const el = itemEls.get(target.id);
    if (!item || !el) continue;
    const b = itemBounds(item, el);
    const centers = {
      top: worldToStage(b.x + b.w / 2, b.y),
      right: worldToStage(b.x + b.w, b.y + b.h / 2),
      bottom: worldToStage(b.x + b.w / 2, b.y + b.h),
      left: worldToStage(b.x, b.y + b.h / 2),
    };
    const sides = ["top", "right", "bottom", "left"].filter((side) => {
      if (taken(centers[side])) return false;
      placed.push(centers[side]);
      return true;
    });
    if (!sides.length) continue;
    const box = addOverlayBox(el, "canvas-port-box", 0.5);
    for (const side of sides) {
      const port = document.createElement("span");
      port.className = "canvas-port";
      port.dataset.id = target.id;
      port.dataset.side = side;
      if (target.selected) port.dataset.sel = "1";
      if (target.marksOnly) port.dataset.inert = "1";
      box.append(port);
      painted.push({ port, selected: target.selected });
    }
  }
  /* 看得见的圆点画在屏幕层：位置取热区的实际屏幕中心，尺寸不跟缩放走 */
  if (!ui.portVisualLayer) return;
  const stageRect = ui.stage.getBoundingClientRect();
  for (const { port, selected } of painted) {
    const rect = port.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "canvas-port-dot";
    if (selected) dot.dataset.sel = "1";
    dot.style.left = `${Math.round(rect.left - stageRect.left + rect.width / 2)}px`;
    dot.style.top = `${Math.round(rect.top - stageRect.top + rect.height / 2)}px`;
    ui.portVisualLayer.append(dot);
  }
}

/* 悬停态只认 hoverId，类也跟着它走：锁点变色和 MCP 的 ui_hover 走同一条路 */
export function setHoverId(id) {
  if (hoverId && hoverId !== id) itemEls.get(hoverId)?.classList.remove("is-hover");
  assignHoverId(id);
  if (id) itemEls.get(id)?.classList.add("is-hover");
  updatePorts();
}

export function startConnect(e) {
  if (!active || !current || e.button !== 0) return;
  const port = e.target.closest?.(".canvas-port");
  if (!port) return;
  const item = findItem(port.dataset.id);
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  if (editingId || edgeLabelEditor) commitEditing();
  setDrag({
    kind: "connect",
    from: { item: item.id, side: port.dataset.side },
    point: clientToWorld(e.clientX, e.clientY),
    targetId: null,
  });
  ui.stage.classList.add("is-connecting");
  updatePorts();
  drawConnectPreview();
}

/* 拖拽中光标下的目标：端口优先（能确定具体边），否则整个块（边自动挑）。
   端口圈和别的东西会叠在同一处，所以按整摞命中结果找端口/块 */
export function connectHit(e, excludeIds) {
  const stack =
    document.elementsFromPoint?.(e.clientX, e.clientY) ||
    [document.elementFromPoint(e.clientX, e.clientY)];
  const port = stack.map((el) => el?.closest?.(".canvas-port")).find(Boolean);
  const target = port || stack.map((el) => el?.closest?.(".canvas-item")).find(Boolean);
  if (!target) return null;
  const id = target.dataset.id;
  if (!id || excludeIds.includes(id)) return null;
  const item = findItem(id);
  if (!item || !CONNECTABLE.has(item.type)) return null;
  return { id, side: port ? port.dataset.side : null };
}

export function setConnectTarget(id) {
  if (!drag || drag.targetId === id) return false;
  if (drag.targetId) itemEls.get(drag.targetId)?.classList.remove("is-connect-target");
  drag.targetId = id;
  if (id) itemEls.get(id)?.classList.add("is-connect-target");
  return true;
}

/* 拖拽中的预览线：目标没落在块上时用光标位置当临时端点 */
export function drawConnectPreview() {
  if (!drag) return;
  const pointerBounds = { x: drag.point.x, y: drag.point.y, w: 0, h: 0 };
  let route = null;
  if (drag.kind === "connect") {
    const sourceBounds = boundsOfItem(drag.from.item);
    const targetBounds = drag.targetId ? boundsOfItem(drag.targetId) : pointerBounds;
    if (sourceBounds && targetBounds) {
      route = routeConnectorPreview(
        "elbow",
        drag.from.side,
        drag.targetSide || "auto",
        sourceBounds,
        targetBounds,
      );
    }
  } else {
    const connector = findItem(drag.id);
    const fixedBounds = boundsOfItem(drag.fixedId);
    const movingBounds = drag.targetId ? boundsOfItem(drag.targetId) : pointerBounds;
    if (connector && fixedBounds && movingBounds) {
      route =
        drag.end === "to"
          ? routeConnectorPreview(
              connector.shape,
              connector.from.side,
              drag.targetSide || "auto",
              fixedBounds,
              movingBounds,
              connector.points,
            )
          : routeConnectorPreview(
              connector.shape,
              drag.targetSide || "auto",
              connector.to.side,
              movingBounds,
              fixedBounds,
              connector.points,
            );
    }
  }
  if (route) showPreview(route.d);
  else clearPreview();
}

export function showPreview(d) {
  if (!previewPath) {
    setPreviewPath(document.createElementNS(SVG_NS, "path"));
    previewPath.classList.add("canvas-edge-preview");
    ui.edgeTransform.append(previewPath);
  }
  previewPath.setAttribute("d", d);
}

export function clearPreview() {
  if (!previewPath) return;
  previewPath.remove();
  setPreviewPath(null);
}

export function cleanupConnect(finished) {
  if (finished?.targetId) itemEls.get(finished.targetId)?.classList.remove("is-connect-target");
  clearPreview();
  ui.stage.classList.remove("is-connecting");
}

export function finishConnect(finished) {
  const targetId = finished.targetId;
  cleanupConnect(finished);
  if (!targetId) return;
  const connector = makeConnector(finished.from.item, finished.from.side, targetId);
  connector.to.side = finished.targetSide || "auto";
  current.items.push(connector);
  /* 接上那一刻就把两条边定死，之后挪块只改走线不改接法 */
  pinConnectorSides(connector, boundsOfItem);
  addItemElement(connector);
  select(connector.id);
  scheduleItemsSave();
}

export function finishConnectEnd(finished) {
  const targetId = finished.targetId;
  cleanupConnect(finished);
  const connector = findItem(finished.id);
  if (!connector || !targetId) return;
  const side = finished.targetSide || "auto";
  if (finished.end === "from") connector.from = { item: targetId, side };
  else connector.to = { item: targetId, side };
  /* 换到新块上的那一端同样当场定死 */
  pinConnectorSides(connector, boundsOfItem);
  syncConnector(connector);
  updateSelection();
  scheduleItemsSave();
}
