/* 从 canvas.js 拆出：keys-save */

import { active, activeBodySelectionText, blurMinimapFocus, cameraTimer, cancelPlanCalibration, clientToWorld, copyBodySelectionText, copyItems, current, deleteItems, errorTimer, findItem, insertPaths, isMinimapFocused, itemsTimer, modalOpen, nudgeSelected, paintingTarget, pasteCopiedBlocks, pictureStepMove, planCalibration, refreshMinimap, renderTree, resetZoom, scenePlacementActive, select, selectAll, selectedIds, setCameraTimer, setErrorTimer, setItemsTimer, setLockedMany, setMeasureHeld, setPictureEditing, setScenePlacementMode, setTool, store, toPersisted, tool, ui } from "../canvas.js";

/* ---------- 从资源管理器拖入 ---------- */

export function setupFileDrop() {
  const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
  if (!webview || typeof webview.onDragDropEvent !== "function") return;
  try {
    Promise.resolve(
      webview.onDragDropEvent((event) => {
        const payload = event?.payload || {};
        if (payload.type === "enter" || payload.type === "over") {
          const point = active && current ? pointFromDrop(payload.position) : null;
          ui.stage.classList.toggle("is-file-over", Boolean(point));
          return;
        }
        ui.stage.classList.remove("is-file-over");
        if (payload.type === "drop" && active && current) {
          onFilesDropped(payload.paths || [], payload.position);
        }
      }),
    ).catch(() => {});
  } catch {
    /* 浏览器预览里没有原生拖放事件，忽略 */
  }
}

export function pointFromDrop(position) {
  if (!position || !ui) return null;
  const dpr = window.devicePixelRatio || 1;
  const x = position.x / dpr;
  const y = position.y / dpr;
  const rect = ui.stage.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  return clientToWorld(x, y);
}

export async function onFilesDropped(paths, position) {
  const point = pointFromDrop(position);
  if (!point || !paths.length) return;
  await insertPaths(paths, point);
}

/* ---------- 键盘 ---------- */

/* 方向键挪选中项：一格 1px，Shift 走 10 倍。用世界坐标，缩放看不太清时按几下 Shift 就够了 */
export const NUDGE_KEYS = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};
export const NUDGE_STEP = 1;

export function onKeyDown(e) {
  if (!active || !current || modalOpen) return;
  /* 全屏播放时按键是给影片的：Esc 归浏览器退全屏，Delete 不能顺手把这块删了 */
  if (document.fullscreenElement) return;
  /* 定标时键盘只认 Esc：别让 Delete、方向键把块挪走 */
  if (planCalibration) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelPlanCalibration();
    }
    return;
  }
  const focused = document.activeElement;
  if (
    focused &&
    (focused.tagName === "INPUT" ||
      focused.tagName === "TEXTAREA" ||
      focused.isContentEditable)
  ) {
    return;
  }
  /* 按住 Alt 给选中的块量四周距离；松开在 keyup 里收 */
  if (e.key === "Alt") {
    if (!e.repeat) setMeasureHeld(true);
    e.preventDefault();
    return;
  }
  /* Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y 也行）只在画面块里退笔画：
     画笔自己那层栈还在，画布本身没有撤销了。
     焦点在输入框/正文里时上面已经 return 了，那里归浏览器自己的撤销管。 */
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    const id = paintingTarget();
    if (!id) return;
    e.preventDefault();
    pictureStepMove(id, e.shiftKey ? "redo" : "undo");
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
    const id = paintingTarget();
    if (!id) return;
    e.preventDefault();
    pictureStepMove(id, "redo");
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "0") {
    e.preventDefault();
    resetZoom();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    selectAll();
    return;
  }
  /* Ctrl+C 存这批块的快照；Ctrl+V 走系统粘贴事件（外来内容照旧能粘），Ctrl+D 复制+粘贴一步到位 */
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
    /* 正文区有文字选区 → 复制纯文字；没有 → 复制选中的整块（面板） */
    if (!selectedIds.size && !activeBodySelectionText()) return;
    e.preventDefault();
    const text = activeBodySelectionText();
    if (text) copyBodySelectionText(text);
    else copyItems([...selectedIds]);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
    if (!selectedIds.size) return;
    e.preventDefault();
    copyItems([...selectedIds]);
    pasteCopiedBlocks();
    return;
  }
  /* Ctrl+L：锁/解锁选中的面板；都锁着就一起解开，否则一起锁上 */
  if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
    const ids = [...selectedIds].filter((id) => findItem(id)?.type !== "connector");
    if (!ids.length) return;
    e.preventDefault();
    const allLocked = ids.every((id) => findItem(id)?.locked);
    setLockedMany(ids, !allLocked);
    return;
  }
  if (NUDGE_KEYS[e.key] && selectedIds.size && !isMinimapFocused()) {
    e.preventDefault();
    const [dx, dy] = NUDGE_KEYS[e.key];
    const step = e.shiftKey ? NUDGE_STEP * 10 : NUDGE_STEP;
    nudgeSelected(dx * step, dy * step);
    return;
  }
  if (e.key === "Escape") {
    /* 手里捏着笔时 Esc 先退出编辑，回到挪块缩放 */
    const painting = paintingTarget();
    if (painting) {
      e.preventDefault();
      setPictureEditing(painting, false);
      return;
    }
    const placing = current.items.find((item) => item.type === "scene" && scenePlacementActive(item));
    if (placing) {
      e.preventDefault();
      setScenePlacementMode(placing, false);
      return;
    }
    /* 鸟瞰窗的选中态最轻，Esc 先退它，再退工具/块选中 */
    if (blurMinimapFocus()) return;
    if (tool !== "select") setTool("select");
    else if (selectedIds.size) select(null);
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size) {
    e.preventDefault();
    deleteItems([...selectedIds]);
  }
}

/* ---------- 保存与提示 ---------- */

export function scheduleItemsSave() {
  if (!current) return;
  clearTimeout(itemsTimer);
  setItemsTimer(setTimeout(flushItems, 500));
  /* 块的位置/尺寸/增减都会改鸟瞰窗里的方框，跟着重画一次 */
  refreshMinimap();
  /* 面板树跟着块增删/挪动/编容器刷新 */
  renderTree();
}

export async function flushItems() {
  clearTimeout(itemsTimer);
  setItemsTimer(null);
  if (!current) return;
  const id = current.meta.id;
  const payload = JSON.parse(JSON.stringify(current.items.map(toPersisted)));
  try {
    await store.saveCanvasItems(id, payload);
  } catch (error) {
    showError(error);
  }
}

export function scheduleCameraSave() {
  if (!current) return;
  clearTimeout(cameraTimer);
  setCameraTimer(setTimeout(flushCamera, 400));
}

export async function flushCamera() {
  clearTimeout(cameraTimer);
  setCameraTimer(null);
  if (!current) return;
  try {
    await store.saveCanvasCamera(current.meta.id, { ...current.camera });
  } catch (error) {
    showError(error);
  }
}

export function showError(error) {
  if (!ui) return;
  const message = typeof error === "string" ? error : error?.message || String(error);
  ui.error.textContent = message;
  ui.error.hidden = false;
  clearTimeout(errorTimer);
  setErrorTimer(setTimeout(() => {
    ui.error.hidden = true;
  }, 4200));
}
