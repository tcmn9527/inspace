/* 从 canvas.js 拆出：connector-points */

import { active, activeBodySelectionText, alignSelected, commitEditing, compareImagesEntry, copyBodySelectionText, copyItems, current, deleteItems, distributeSelected, edgeLabelEditor, editingId, findItem, flushItems, isFileEditable, loneSelected, openBlankMenu, openItemMenu, openMenu, scheduleItemsSave, select, selectedIds, setLocked, setLockedMany, setTool, showError, showToast, stageTargetAt, startEdgeLabelEdit, startFileEdit, startNoteEdit, startTextEdit, store, syncConnector, tidySelected, updateSelection } from "../canvas.js";

/* ---------- 连线折点 ---------- */

/* 把指针位置贴到线上最近的一点：拖线身插折点时，折点落在线上而不是凭空跳一下 */
export function nearestPathPoint(el, target) {
  const path = el?.querySelector(".canvas-edge-visible");
  if (!path) return null;
  let length = 0;
  try {
    length = path.getTotalLength();
  } catch {
    return null;
  }
  if (!(length > 0)) return null;
  const steps = Math.min(240, Math.max(24, Math.ceil(length / 8)));
  let best = null;
  for (let i = 0; i <= steps; i++) {
    const point = path.getPointAtLength((length * i) / steps);
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    if (!best || distance < best.distance) best = { distance, point: { x: point.x, y: point.y } };
  }
  return best?.point || null;
}

export function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (!length) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/* 新折点落在哪一段上：按它离哪两个相邻顶点最近来定插入位置 */
export function bendInsertIndex(vertices, point) {
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < vertices.length - 1; i++) {
    const distance = distanceToSegment(point, vertices[i], vertices[i + 1]);
    if (distance < best) {
      best = distance;
      index = i;
    }
  }
  return index;
}

/* 双击折点圈就地删掉它；剩最后一个就回到自动走线 */
export function onBendHandleDoubleClick(e) {
  const handle = e.target.closest?.('.canvas-handle[data-handle="bend"]');
  if (!handle || !current) return;
  e.preventDefault();
  e.stopPropagation();
  const item = findItem(loneSelected());
  if (!item || item.type !== "connector" || !item.points) return;
  const index = Number(handle.dataset.index);
  if (!Number.isInteger(index) || !item.points[index]) return;
  item.points.splice(index, 1);
  if (!item.points.length) delete item.points;
  syncConnector(item);
  updateSelection();
  scheduleItemsSave();
}

/* 折点模式：默认关闭，拖线身不会插点；打开后拖线身才插，关闭时连同已有折点一起清掉 */
export function setConnectorBend(item, on) {
  if (on) {
    if (item.bend) return;
    item.bend = true;
  } else {
    if (!item.bend && !item.points?.length) return;
    delete item.bend;
    delete item.points;
  }
  syncConnector(item);
  updateSelection();
  scheduleItemsSave();
}

export function onStageDoubleClick(e) {
  if (!active || !current) return;
  /* Ctrl+双击：给这块上锁/解锁。锁住的块也吃这一下，不然只能用右上角那个热区 */
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const hit = e.target.closest?.(".canvas-item");
    const hitItem = findItem(hit?.dataset.id);
    if (hitItem && hitItem.type !== "connector") {
      e.preventDefault();
      e.stopPropagation();
      setLocked(hitItem, !hitItem.locked);
      return;
    }
  }
  /* 双击锁点：解除锁定。锁住的块不吃别的双击，所以这条放在最前 */
  const lockDot = e.target.closest?.(".canvas-lock-dot");
  if (lockDot) {
    const lockedEl = lockDot.closest?.(".canvas-item");
    const lockedItem = findItem(lockedEl?.dataset.id);
    if (lockedItem?.locked) {
      e.preventDefault();
      setLocked(lockedItem, false);
    }
    return;
  }
  const target = stageTargetAt(e);
  if (!target) return;
  const item = findItem(target.dataset.id);
  if (!item) return;
  if (item.type === "connector") {
    e.preventDefault();
    setTool("select", true);
    startEdgeLabelEdit(item.id);
    return;
  }
  /* 双击图片：交给系统看图工具打开原图。画布上那块太小，看不清时用。
     锁只拦「改」不拦「读」，所以这条放在锁的判断前头。 */
  if (item.type === "image" || item.type === "gen") {
    if (!openImageByDoubleClick(e, item)) return;
    e.preventDefault();
    return;
  }
  /* 锁只锁坐标：文本/笔记/文件锁着也能双击进编辑 */
  if (!["text", "note", "file"].includes(item.type)) return;
  /* 非文本的附件没有正文可编，双击仍然什么都不做（找文件走右键「在文件夹中显示」） */
  if (item.type === "file" && !isFileEditable(item)) return;
  e.preventDefault();
  setTool("select", true);
  select(item.id);
  if (item.type === "text") startTextEdit(item.id);
  else if (item.type === "note") startNoteEdit(item.id);
  else startFileEdit(item.id);
}

/* 双击看大图：返回 true 表示这一下归它管。
   生图面板只认取景窗里那张——双击提示词框是选词，不是看大图。 */
export function openImageByDoubleClick(e, item) {
  if (item.type === "gen" && !e.target.closest?.(".canvas-gen-image")) return false;
  if (!item.src) {
    if (item.type === "gen") showToast("这张还没出好，等出完了再双击");
    return false;
  }
  openImageExternally(item).catch(showError);
  return true;
}

export function openImageExternally(item) {
  const canvasId = current?.meta?.id;
  if (!canvasId) return Promise.resolve();
  /* 块上的路径可能还没落盘（生图刚出完那一下），先把这笔存下去，后端才认得 */
  return flushItems().then(() => store.openCanvasImage(canvasId, item.id));
}

export function onStageContextMenu(e) {
  if (!active) return;
  /* 还没有画布时画布区域就是空的：右键什么都不给，创建入口只在左侧画布树 */
  if (!current) {
    e.preventDefault();
    return;
  }
  /* 全屏时也不挡：菜单会把浮层搬进全屏元素，才看得见「恢复」和音量 */
  if (edgeLabelEditor && e.target === edgeLabelEditor.input) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (editingId || edgeLabelEditor) commitEditing();
  /* 右键折点圈：菜单还是这条线的，别退成空白处菜单 */
  if (e.target.closest?.('.canvas-handle[data-handle="bend"]')) {
    const connector = findItem(loneSelected());
    if (connector?.type === "connector") openItemMenu(connector, e.clientX, e.clientY);
    return;
  }
  const target = stageTargetAt(e);
  if (!target) {
    openBlankMenu(e.clientX, e.clientY);
    return;
  }
  const item = findItem(target.dataset.id);
  if (!item) return;
  /* 多选里右键其中一块：菜单一次作用在整批上；右键集合外的块才退回单选菜单 */
  if (selectedIds.size > 1 && selectedIds.has(item.id)) {
    const ids = [...selectedIds];
    const allLocked = ids.every((id) => findItem(id)?.locked);
    const entries = [];
    /* 多选里正好两张能看的图（图片块/生图面板）：菜单顶部给「对比」 */
    const compare = compareImagesEntry(item);
    if (compare) entries.push(compare, "-");
    entries.push(
      {
        label: "复制",
        onClick: () => {
          const text = activeBodySelectionText();
          if (text) copyBodySelectionText(text);
          else copyItems(ids);
        },
      },
      "-",
      {
        label: "对齐",
        children: [
          { label: "左对齐", onClick: () => alignSelected("left") },
          { label: "水平居中", onClick: () => alignSelected("center-h") },
          { label: "右对齐", onClick: () => alignSelected("right") },
          { label: "顶对齐", onClick: () => alignSelected("top") },
          { label: "垂直居中", onClick: () => alignSelected("center-v") },
          { label: "底对齐", onClick: () => alignSelected("bottom") },
        ],
      },
    );
    /* 两块只能对齐，散不开：分布要三块以上才有中间那几块可挪 */
    if (ids.length >= 3) {
      entries.push({
        label: "分布",
        children: [
          { label: "水平等距", onClick: () => distributeSelected("x") },
          { label: "垂直等距", onClick: () => distributeSelected("y") },
        ],
      });
    }
    entries.push({ label: "整理成网格", onClick: () => tidySelected() });
    entries.push("-");
    entries.push(
      allLocked
        ? { label: "解锁", onClick: () => setLockedMany(ids, false) }
        : { label: "锁定", onClick: () => setLockedMany(ids, true) },
    );
    entries.push({ label: "删除", danger: true, onClick: () => deleteItems(ids) });
    openMenu(e.clientX, e.clientY, entries);
    return;
  }
  select(item.id);
  openItemMenu(item, e.clientX, e.clientY);
}
