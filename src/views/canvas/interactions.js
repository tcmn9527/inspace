/* 从 canvas.js 拆出：interactions */

import { moveGroup } from "./layout.js";
import { active, beginMarquee, blurMinimapFocus, clientToWorld, commitEditing, current, drag, dropTool, edgeLabelEditor, editingId, fileEditor, findItem, isContainer, select, selectedIds, setDrag, startDraw, tool, ui } from "../canvas.js";

/* ---------- 指针交互 ---------- */

/* 命中优先级：块层压在连线层上面，容器矩形的填充会把框里的线盖住，
   点线永远落在容器上。命中容器时再翻一遍命中栈找底下的连线，有就按命中线算。 */
export function stageTargetAt(e) {
  const target = e.target.closest?.(".canvas-item, .canvas-connector");
  if (!target || !target.classList.contains("canvas-item")) return target;
  const item = findItem(target.dataset.id);
  if (!item || !isContainer(item)) return target;
  const edge = document
    .elementsFromPoint(e.clientX, e.clientY)
    .map((el) => el.closest?.(".canvas-connector"))
    .find(Boolean);
  return edge || target;
}

export function onStagePointerDown(e) {
  if (!active || !current) return;
  /* 右键/中键起不成画，武装着的工具也一并退回默认 */
  if (e.button !== 0) {
    dropTool();
    return;
  }
  /* 文件卡右上角的「编辑/浏览」开关：点它是切换，不选中、不拖块 */
  if (e.target.closest?.(".canvas-file-toggle")) {
    e.preventDefault();
    return;
  }
  /* 锁点自己的双击热区：这一次按下不吃，免得锁住的块顺手起平移 */
  if (e.target.closest?.(".canvas-lock-dot")) {
    e.preventDefault();
    return;
  }
  /* 全屏时画面还挂在原来那个块上，事件会顺着 DOM 冒泡回画布：
     这时点的是影片，不是画布，别去挪那块的位置 */
  if (document.fullscreenElement) {
    dropTool();
    return;
  }
  /* 右下角鸟瞰窗自己管自己的按下（拖视窗/点跳/收起），别当成画布平移 */
  if (e.target.closest?.(".canvas-minimap, .canvas-minimap-key")) {
    dropTool();
    return;
  }
  /* 回到画布上操作，方向键就不再是挪视野 */
  blurMinimapFocus();
  /* 连线文字的输入框自己收指针：选字、挪光标，不是平移画布 */
  if (edgeLabelEditor && e.target === edgeLabelEditor.input) {
    dropTool();
    return;
  }
  const target = stageTargetAt(e);

  /* 文本块的编辑框里按下是给输入框的：选字、拖滚动条，不该顺手把这块拖走 */
  if (fileEditor && target?.dataset.id === fileEditor.itemId) {
    dropTool();
    return;
  }

  /* 文件卡里能选中文字的预览区（DOCX 正文、文本/Markdown/CSV 预览）：
     在正文上按住是选字、复制，不是挪卡片；移动交给卡片头部（.canvas-file-head）。
     PDF 是位图、本来就选不了字，照旧整块可拖。这里提前 return、不碰
     e.preventDefault()，好让浏览器的原生文字选区正常生效。 */
  if (target && e.target.closest?.(".canvas-file-docx, .canvas-file-preview, .canvas-file-xlsx, .canvas-file-pptx")) {
    const id = target.dataset.id;
    if (id && !selectedIds.has(id)) select(id);
    return;
  }

  if (editingId) {
    if (target && target.dataset.id === editingId) {
      dropTool();
      return;
    }
    commitEditing();
  }

  /* Ctrl/⌘ 按住时进入框选：起点在块上或空白都一样，拖动拉框；不拖仍是 Ctrl 点击加选 */
  if ((e.ctrlKey || e.metaKey) && !e.altKey && tool === "select") {
    e.preventDefault();
    setDrag(beginMarquee(e, target?.dataset.id || null));
    return;
  }

  if (!target) {
    if (tool === "select") {
      select(null);
      setDrag({
        kind: "pan",
        startClient: { x: e.clientX, y: e.clientY },
        origin: { x: current.camera.x, y: current.camera.y },
        moved: false,
      });
      ui.stage.classList.add("is-panning");
    } else {
      startDraw(e);
    }
    return;
  }

  e.preventDefault();
  const item = findItem(target.dataset.id);
  if (!item) {
    dropTool();
    return;
  }
  /* Ctrl/⌘ 点只做加减选，不顺手起拖：手一抖整组就跑了 */
  if (e.ctrlKey || e.metaKey) {
    select(item.id, true);
    dropTool();
    return;
  }
  /* 点集合里的块保持多选（整组就是这么拖走的），点集合外的块才换成单选它 */
  if (!selectedIds.has(item.id)) select(item.id);

  if (tool !== "select") {
    startDraw(e);
    return;
  }
  /* 锁住的块拖不动它自己（能点选、能右键）。按住它拖分两种：
     - 它在一个没锁的容器里：拖的是整个容器，容器和里面的块一起走；
     - 否则挪视野：锁的是块，不是画布，铺满画面的锁定面板就成了可抓的一整张底。
     点一下（没拖动）仍然只是选中，不产生位移。 */
  if (item.locked) {
    const owner = item.containerId ? findItem(item.containerId) : null;
    if (owner && isContainer(owner) && !owner.locked) {
      if (!selectedIds.has(owner.id)) select(owner.id);
      setDrag({
        kind: "move",
        id: owner.id,
        group: moveGroup(),
        start: clientToWorld(e.clientX, e.clientY),
        moved: false,
      });
      ui.stage.classList.add("is-moving");
      return;
    }
    setDrag({
      kind: "pan",
      startClient: { x: e.clientX, y: e.clientY },
      origin: { x: current.camera.x, y: current.camera.y },
      moved: false,
    });
    ui.stage.classList.add("is-panning");
    return;
  }
  /* 连线没有整条拖动；打开折点后，拖线身才会插一个折点跟着走 */
  if (item.type === "connector") {
    if (!item.bend) return;
    setDrag({
      kind: "bend-insert",
      id: item.id,
      start: clientToWorld(e.clientX, e.clientY),
      moved: false,
    });
    return;
  }
  if (editingId === item.id) return;

  const start = clientToWorld(e.clientX, e.clientY);
  setDrag({
    kind: "move",
    id: item.id,
    group: moveGroup(),
    start,
    moved: false,
  });
  ui.stage.classList.add("is-moving");
}
