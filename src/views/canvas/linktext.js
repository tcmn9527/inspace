/* 从 canvas.js 拆出：linktext */

import { boundsOfItem, commitEditing, connectorGeometry, connectorLabelPoint, current, edgeLabelEditor, editingId, findItem, itemEls, scheduleItemsSave, select, setEdgeLabelEditor, syncConnector, ui } from "../canvas.js";

/* ---------- 连线文字 ----------
   双击连线，在它中间浮出一个输入框就地写；文字本身画在 SVG 里跟着线走。 */

export const EDGE_LABEL_FONT = 13;

export function startEdgeLabelEdit(id) {
  if (edgeLabelEditor?.itemId === id) return;
  if (editingId || edgeLabelEditor) commitEditing();
  if (edgeLabelEditor) commitEdgeLabelEdit();
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || item.type !== "connector" || !el) return;
  const point = connectorLabelPoint(el, connectorGeometry(item, boundsOfItem));
  if (!point) return;
  select(id);
  el.classList.add("is-label-editing");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "canvas-edge-label-input";
  input.spellcheck = false;
  input.placeholder = "连线文字";
  input.value = item.label || "";
  ui.stage.append(input);
  setEdgeLabelEditor({ itemId: id, el, input, point, original: item.label || "" });
  input.addEventListener("input", sizeEdgeLabelInput);
  input.addEventListener("keydown", onEdgeLabelKeyDown);
  input.addEventListener("blur", commitEdgeLabelEdit);
  positionEdgeLabelEditor();
  input.focus({ preventScroll: true });
  input.select();
}

/* 跟着相机走：编辑中缩放、平移时输入框还钉在连线中间 */
export function positionEdgeLabelEditor() {
  if (!edgeLabelEditor || !current) return;
  const camera = current.camera;
  const { input, point } = edgeLabelEditor;
  input.style.left = `${camera.x + point.x * camera.scale}px`;
  input.style.top = `${camera.y + point.y * camera.scale}px`;
  input.style.fontSize = `${Math.max(9, EDGE_LABEL_FONT * camera.scale)}px`;
  sizeEdgeLabelInput();
}

export function sizeEdgeLabelInput() {
  if (!edgeLabelEditor) return;
  const { input } = edgeLabelEditor;
  const font = parseFloat(input.style.fontSize) || EDGE_LABEL_FONT;
  input.style.width = `${Math.min(320, Math.max(90, (input.value.length + 2) * font * 0.9))}px`;
}

export function onEdgeLabelKeyDown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitEdgeLabelEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    finishEdgeLabelEdit(false);
  }
}

export function commitEdgeLabelEdit() {
  finishEdgeLabelEdit(true);
}

export function finishEdgeLabelEdit(save) {
  if (!edgeLabelEditor) return;
  const { itemId, el, input, original } = edgeLabelEditor;
  setEdgeLabelEditor(null);
  const value = input.value;
  input.removeEventListener("input", sizeEdgeLabelInput);
  input.removeEventListener("keydown", onEdgeLabelKeyDown);
  input.removeEventListener("blur", commitEdgeLabelEdit);
  input.remove();
  el.classList.remove("is-label-editing");
  const item = findItem(itemId);
  if (!item) return;
  item.label = save ? value.replace(/\s+/g, " ").trim() : original;
  syncConnector(item);
  scheduleItemsSave();
}
