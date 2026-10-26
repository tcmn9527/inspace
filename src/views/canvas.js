/* 无限画布。
 *
 * 结构：stage（视口，overflow hidden）> world（translate + scale）+ 选择框层。
 * 图元坐标全部是世界坐标；屏幕坐标只在选中框和鼠标换算时出现。
 *
 * 交互约定：
 *   - 选择工具：拖空白平移，拖图元移动，拖四个角改大小；双击文字进入编辑。
 *   - 形状工具：一次画一个，画完自动回到选择工具。
 *   - 滚轮平移，Ctrl + 滚轮以光标为中心缩放；缩放比例可输入，Ctrl+0 回到 100%；
 *     鼠标压在块的滚动区上时，滚轮归块自己滚。
 *   - 粘贴图片/纯文本时落在鼠标当前位置。
 *   - 右键图元：边框色、填充色（文字还有文字色）、删除。
 *
 * 数据落在后端给的画布文件夹里：图元是 items.json，图片在 images/。 */

import { closeColorPicker, openColorPicker } from "./color-picker.js";
import { confirmDialog, choiceDialog, promptDialog } from "./dialog.js";
import { createMarkdownEditor } from "./markdown-editor.js";
import { openMenu, closeMenu } from "./menu.js";
import { renderMarkdown } from "./markdown.js";
import { openVideoHelp } from "./video-help.js";
import * as store from "./canvas-store.js";
import {
  AUDIO_DEFAULT_HEIGHT,
  AUDIO_DEFAULT_WIDTH,
  EBOOK_DEFAULT_HEIGHT,
  EBOOK_DEFAULT_WIDTH,
  FILE_DEFAULT_HEIGHT,
  FILE_DEFAULT_WIDTH,
  FILE_TEXT_EXPANDED_HEIGHT,
  FILE_TEXT_WIDTH,
  NOTE_DEFAULT_HEIGHT,
  NOTE_DEFAULT_WIDTH,
  STICKY_DEFAULT_COLOR,
  STICKY_DEFAULT_TEXT,
  capturePagePin,
  connectorGeometry,
  createConnectorElement,
  createItemElement,
  fitImageSize,
  formatSize,
  itemBounds,
  makeAudio,
  makeBox,
  makeConnector,
  makeEbook,
  makeFile,
  makeImage,
  makeLine,
  makeNote,
  makeSticky,
  makeText,
  makeVideo,
  normalizeItem,
  pinEbookPage,
  releaseEbookPage,
  renderMissing,
  routeConnector,
  sideAnchor,
  stretchEbookPage,
  syncConnectorElement,
  syncItemElement,
  TEXT_DEFAULT_WIDTH,
  VIDEO_DEFAULT_HEIGHT,
  VIDEO_DEFAULT_WIDTH,
  VIDEO_MIN_HEIGHT,
  VIDEO_MIN_WIDTH,
} from "./canvas-items.js";

const { invoke } = window.__TAURI__.core;

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/* 每次缩放只走 1 个百分点，和右上角的百分比读数对齐 */
const ZOOM_STEP = 0.01;
const STORAGE_KEY = "workbench.canvas";
const GRID_UNIT = 24;
const PRESETS = [
  "#ffffff",
  "#9a9a9a",
  "#7aa2ff",
  "#4f7cf7",
  "#43c59e",
  "#ffd166",
  "#ff8f5a",
  "#ff6b60",
  "#c792ea",
];

const SVG_NS = "http://www.w3.org/2000/svg";
const CONNECTABLE = new Set([
  "rect",
  "ellipse",
  "text",
  "image",
  "audio",
  "video",
  "sticky",
  "note",
  "file",
  "ebook",
]);
const STICKY_BG_PRESETS = ["#bfa648", "#a6bf47", "#47bfb4", "#e5e1d6", "#aab0b5", "#262626"];
const STICKY_TEXT_PRESETS = ["#000000", "#ffffff", "#4c4c4c", "#9e9e9e"];
const NOTE_EDITOR_GUARDS = ".canvas-note-editor, .color-pop, #ctx-menu";
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]);
/* 浏览器能解的容器：不在列表里的也能拖进来，但只能按引用播，交给浏览器试 */
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mkv", "mov"]);
/* Markdown 不当附件看待：拖进来抄成正文，直接变成一个能编辑的笔记块 */
const MARKDOWN_EXTS = new Set(["md", "markdown"]);
/* epub/mobi 能就地在画布上读；azw/azw3 这一版读不了，仍旧按附件收进来 */
const EBOOK_EXTS = new Set(["epub", "mobi"]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let ui = null;
let active = false;
let canvases = [];
let current = null; // { meta, camera, items }
let selectedId = null;
let editingId = null;
let tool = "select";
let drag = null;
let itemEls = new Map();
let imageCache = new Map();
let audioCache = new Map();
/* 视频只缓存 asset 地址（一串字符），不缓存任何字节 */
let videoCache = new Map();
let noteImageCache = new Map();
/* 文本块只读预览：缓存后端解好码的开头一段，切画布就清空重来。
   键带上存在方式，免得同一个路径的拷贝态和引用态串了。 */
let filePreviewCache = new Map();
const previewKey = (item) => `${item.linked ? "L" : "C"}|${item.src}`;
/* 书的目录进画布只读一次，翻章不用再解析整本；键和预览一样带上存在方式 */
let ebookTocCache = new Map();
const ebookKey = (canvasId, item) => `${canvasId}|${item.linked}|${item.src}`;
let noteEditor = null; // 当前笔记块的编辑态 { itemId, el, box, textarea, editor }
/* 引用态笔记块这一轮编辑是否允许写回原 .md（编辑弹层里选「修改源文件」才是） */
let noteWriteBack = false;
/* 已经弹过「改哪一份」的块，双击连着触发两次不至于叠出两层弹层 */
let noteAskId = null;
/* 音视频块指向的文件找不到了（引用查原片、拷贝查副本）：块留在原地，改成丢文件卡。每次进画布重新查。 */
let mediaMissing = new Set();
let modalOpen = false;
let lastPointer = { x: 0, y: 0, inside: false };
let hoverId = null;
let previewPath = null;
let itemsTimer = null;
let cameraTimer = null;
let errorTimer = null;
let loadToken = 0;
/* 同时只跑一个后台拷贝：进度条只有一根，视频和文件共用 */
let copyTask = null; // { job, canvasId, resolve, label }
/* 转音轨排在拷贝后面，同一根进度条，不并发 */
let audioFix = null; // { job, canvasId, item }

/* ---------- 初始化 ---------- */

export function initCanvas() {
  ui = {
    page: document.querySelector("#canvas-view"),
    stage: document.querySelector("#canvas-stage"),
    world: document.querySelector("#canvas-world"),
    edgeTransform: document.querySelector("#canvas-edge-transform"),
    portLayer: document.querySelector("#canvas-port-layer"),
    selectLayer: document.querySelector("#canvas-select-layer"),
    endpointLayer: document.querySelector("#canvas-endpoint-layer"),
    name: document.querySelector("#canvas-name"),
    nameText: document.querySelector("#canvas-name-text"),
    tools: document.querySelector("#canvas-tools"),
    toolButtons: [...document.querySelectorAll(".canvas-tool[data-tool]")],
    insertImage: document.querySelector("#canvas-insert-image"),
    insertAudio: document.querySelector("#canvas-insert-audio"),
    insertVideo: document.querySelector("#canvas-insert-video"),
    insertFile: document.querySelector("#canvas-insert-file"),
    insertSticky: document.querySelector("#canvas-insert-sticky"),
    insertNote: document.querySelector("#canvas-insert-note"),
    zoomValue: document.querySelector("#canvas-zoom-value"),
    zoomIn: document.querySelector("#canvas-zoom-in"),
    zoomOut: document.querySelector("#canvas-zoom-out"),
    empty: document.querySelector("#canvas-empty"),
    create: document.querySelector("#canvas-create"),
    error: document.querySelector("#canvas-error"),
    copy: document.querySelector("#canvas-video-copy"),
    copyName: document.querySelector("#canvas-copy-name"),
    copyFill: document.querySelector("#canvas-copy-fill"),
    copyText: document.querySelector("#canvas-copy-text"),
    copyCancel: document.querySelector("#canvas-copy-cancel"),
  };

  ui.toolButtons.forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });
  ui.insertImage.addEventListener("click", insertImageFromFile);
  ui.insertAudio.addEventListener("click", insertAudioFromFile);
  ui.insertVideo.addEventListener("click", insertVideoFromFile);
  ui.insertFile.addEventListener("click", insertFileFromPicker);
  ui.copyCancel.addEventListener("click", () => {
    const job = copyTask?.job || audioFix?.job;
    if (!job) return;
    ui.copyCancel.disabled = true;
    ui.copyCancel.textContent = "停止中…";
    store.cancelVideoCopy(job).catch(() => {});
  });
  ui.insertSticky.addEventListener("click", insertStickyFromPicker);
  ui.insertNote.addEventListener("click", insertNoteFromPicker);

  /* home.js 在 document 上挂了「点菜单外部就收起」，点击冒泡到那里会把刚弹出的
     切换器当成外部点击立刻关掉，所以这里要挡住 */
  ui.name.addEventListener("click", (e) => {
    e.stopPropagation();
    openSwitcher();
  });
  ui.create.addEventListener("click", createFlow);
  ui.zoomIn.addEventListener("click", () => zoomBy(ZOOM_STEP));
  ui.zoomOut.addEventListener("click", () => zoomBy(-ZOOM_STEP));
  /* 缩放比例可以直接改：只选中数字部分，百分号留着，敲数字就能覆盖。
     焦点事件里同步设置选区会被浏览器随后落光标的默认行为盖掉，所以要等一帧 */
  ui.zoomValue.addEventListener("focus", () => {
    requestAnimationFrame(selectZoomDigits);
  });
  ui.zoomValue.addEventListener("blur", applyZoomInput);
  ui.zoomValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ui.zoomValue.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      ui.zoomValue.value = zoomLabel();
      ui.zoomValue.blur();
    }
  });

  ui.stage.addEventListener("pointerdown", onStagePointerDown);
  ui.stage.addEventListener("pointermove", (e) => {
    lastPointer = { x: e.clientX, y: e.clientY, inside: true };
    /* 指针停在端口上不算离开块，否则端口会在鼠标靠近时自己消失 */
    if (e.target.closest?.(".canvas-port")) return;
    const target = e.target.closest?.(".canvas-item");
    const id = target ? target.dataset.id : null;
    if (id !== hoverId) {
      hoverId = id;
      updatePorts();
    }
  });
  ui.stage.addEventListener("pointerleave", () => {
    lastPointer.inside = false;
    if (hoverId) {
      hoverId = null;
      updatePorts();
    }
  });

  ui.portLayer.addEventListener("pointerdown", startConnect);
  ui.stage.addEventListener("dblclick", onStageDoubleClick);
  ui.stage.addEventListener("contextmenu", onStageContextMenu);
  ui.stage.addEventListener(
    "wheel",
    (e) => {
      if (!active || !current) return;
      /* 全屏看片时滚轮是给影片的，别去动背后画布的缩放 */
      if (document.fullscreenElement) return;
      const rect = ui.stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY === 0) return;
        const step = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, current.camera.scale + step);
        return;
      }
      /* 滚轮落在块的滚动区上就交给块自己滚（不 preventDefault，浏览器原生滚动），滚到头也不动画布 */
      if (hasScrollableAncestor(e.target, Math.abs(e.deltaY) >= Math.abs(e.deltaX))) return;
      e.preventDefault();
      current.camera.x -= e.deltaX;
      current.camera.y -= e.deltaY;
      applyCamera();
      scheduleCameraSave();
    },
    { passive: false },
  );

  const onHandleDown = (e) => {
    const handle = e.target.closest(".canvas-handle");
    if (!handle || !selectedId || !current) return;
    e.preventDefault();
    e.stopPropagation();
    startResize(handle, e);
  };
  ui.selectLayer.addEventListener("pointerdown", onHandleDown);
  ui.endpointLayer.addEventListener("pointerdown", onHandleDown);

  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("pointercancel", onWindowPointerUp);

  document.addEventListener("paste", onPaste);
  document.addEventListener("keydown", onKeyDown);
  setupFileDrop();
  setupVideoCopyEvents();

  setTool("select");
  updateChrome();
}

export async function enterCanvas() {
  if (active) return;
  active = true;
  setTool("select");
  await loadList();
  if (!active) return;

  const remembered = localStorage.getItem(STORAGE_KEY);
  const target =
    (current && canvases.some((c) => c.id === current.meta.id) && current.meta.id) ||
    (remembered && canvases.some((c) => c.id === remembered) && remembered) ||
    canvases[0]?.id;
  if (target) {
    await switchTo(target);
  } else {
    showEmpty();
  }
}

export function leaveCanvas() {
  if (!active) return;
  active = false;
  loadToken += 1;
  drag = null;
  pauseMedia();
  /* 全屏壳躲在被隐藏的画布视图里时浏览器不会自己退，切走要手动收，
     不然下一页会被撑到整块屏幕的尺寸 */
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  modalOpen = false;
  activePickerClose?.();
  activePickerClose = null;
  if (editingId) commitEditing();
  closeColorPicker(true);
  closeMenu();
  flushItems();
  flushCamera();
}

/* ---------- 画布列表 / 新建 / 切换 ---------- */

async function loadList() {
  try {
    canvases = await store.listCanvases();
  } catch (error) {
    canvases = [];
    showError(error);
  }
}

async function switchTo(id) {
  pauseMedia();
  if (!current || current.meta.id !== id) {
    if (editingId) commitEditing();
    await flushItems();
    await flushCamera();
  }
  const token = ++loadToken;
  try {
    const data = await store.openCanvas(id);
    if (token !== loadToken || !active) return;
    current = {
      meta: data.meta,
      camera: sanitizeCamera(data.camera),
      items: sanitizeItems(data.items),
    };
    selectedId = null;
    editingId = null;
    noteEditor = null;
    imageCache = new Map();
    audioCache = new Map();
    videoCache = new Map();
    probeCache.clear();
    noteImageCache = new Map();
    filePreviewCache = new Map();
    ebookTocCache = new Map();
    mediaMissing = new Set();
    await loadImages();
    if (token !== loadToken || !active) return;
    localStorage.setItem(STORAGE_KEY, current.meta.id);
    const staleNotes = await refreshLinkedNotes();
    mediaMissing = await refreshMediaFiles();
    if (token !== loadToken || !active) return;
    renderAll();
    /* 源 .md 读不到的笔记块整块换成丢文件卡，不再拿最后一次缓存的正文糊弄用户 */
    for (const item of staleNotes) {
      renderMissing(itemEls.get(item.id), item, current.meta.path || "");
    }
    applyCamera();
    updateChrome();
  } catch (error) {
    if (token === loadToken) showError(error);
  }
}

/* 外部手改过文件时，丢掉端点指向不存在块（或自连）的连线 */
function sanitizeItems(raw) {
  const items = (raw || []).map(normalizeItem).filter(Boolean);
  const blockIds = new Set(items.filter((item) => item.type !== "connector").map((item) => item.id));
  const kept = items.filter(
    (item) =>
      item.type !== "connector" ||
      (item.from.item !== item.to.item &&
        blockIds.has(item.from.item) &&
        blockIds.has(item.to.item)),
  );
  normalizeLayers(kept);
  return kept;
}

/* 老数据没有 z：按文件里的先后顺序补上，保持原来的压盖关系 */
function normalizeLayers(items) {
  const blocks = items.filter((item) => item.type !== "connector");
  let next = 0;
  for (const item of blocks) {
    if (Number.isFinite(item.z)) next = Math.max(next, item.z + 1);
  }
  for (const item of blocks) {
    if (!Number.isFinite(item.z)) item.z = next;
    next = Math.max(next, item.z + 1);
  }
}

function sanitizeCamera(raw) {
  const camera = raw && typeof raw === "object" ? raw : {};
  return {
    x: Number.isFinite(camera.x) ? camera.x : 0,
    y: Number.isFinite(camera.y) ? camera.y : 0,
    scale: Number.isFinite(camera.scale)
      ? clamp(camera.scale, MIN_SCALE, MAX_SCALE)
      : 1,
  };
}

async function loadImages() {
  const canvasId = current.meta.id;
  const tasks = current.items
    .filter((item) => item.type === "image" && item.src)
    .map(async (item) => {
      try {
        imageCache.set(item.src, await store.imageUrl(canvasId, item.src, item.linked));
      } catch {
        imageCache.set(item.src, null);
      }
    });
  await Promise.all(tasks);
}

/* 音视频：进画布先问一句文件还在不在——引用态查原片，拷贝态查画布里的副本。
   在就照常显示，没了块还留在原地，只把内容换成丢文件卡（音视频是点开才加载的，这里不提前拉数据）。 */
async function refreshMediaFiles() {
  if (!current) return new Set();
  const canvasId = current.meta.id;
  const missing = new Set();
  await Promise.all(
    current.items
      .filter(
        (item) =>
          item.src &&
          (item.type === "audio" || item.type === "video"),
      )
      .map(async (item) => {
        const found = await store.canvasFileExists(canvasId, item.src, item.linked);
        if (!found) missing.add(item.id);
      }),
  );
  return missing;
}

/* 音视频都是按需加载的，切画布/离开时把还在响的播放器停掉 */
function pauseMedia() {
  if (!ui || !ui.world) return;
  for (const media of ui.world.querySelectorAll("audio, video")) media.pause();
}

function updateChrome() {
  const hasCanvas = Boolean(current);
  ui.page.classList.toggle("no-canvas", !hasCanvas);
  ui.nameText.textContent = current?.meta.name || "画布";
  ui.empty.hidden = hasCanvas;
  if (!hasCanvas) {
    ui.world.textContent = "";
    ui.edgeTransform.textContent = "";
    ui.portLayer.textContent = "";
    previewPath = null;
    itemEls.clear();
    ui.selectLayer.textContent = "";
    ui.endpointLayer.textContent = "";
    ui.stage.style.backgroundSize = `${GRID_UNIT}px ${GRID_UNIT}px`;
    ui.stage.style.backgroundPosition = "0 0";
    ui.zoomValue.value = "100%";
  }
}

function showEmpty() {
  pauseMedia();
  current = null;
  selectedId = null;
  editingId = null;
  noteEditor = null;
  imageCache.clear();
  audioCache.clear();
  videoCache.clear();
  noteImageCache.clear();
  filePreviewCache.clear();
  ebookTocCache.clear();
  mediaMissing = new Set();
  updateChrome();
}

async function createFlow() {
  const name = await promptDialog({
    title: "新建画布",
    label: "画布名字",
    value: "新画布",
    okText: "创建",
  });
  if (!name) return;
  try {
    const data = await store.createCanvas(name);
    await loadList();
    await switchTo(data.meta.id);
  } catch (error) {
    showError(error);
  }
}

async function renameFlow() {
  if (!current) return;
  const name = await promptDialog({
    title: "重命名画布",
    label: "画布名字",
    value: current.meta.name,
    okText: "重命名",
  });
  if (!name || name === current.meta.name) return;
  if (editingId) commitEditing();
  await flushItems();
  await flushCamera();
  try {
    const meta = await store.renameCanvas(current.meta.id, name);
    current.meta = meta;
    localStorage.setItem(STORAGE_KEY, meta.id);
    await loadList();
    updateChrome();
  } catch (error) {
    showError(error);
  }
}

async function deleteFlow() {
  if (!current) return;
  const ok = await confirmDialog({
    title: "删除画布",
    message: `「${current.meta.name}」的整个文件夹会被移到系统回收站，之后仍可找回。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  if (editingId) commitEditing();
  await flushItems();
  await flushCamera();
  try {
    await store.deleteCanvas(current.meta.id);
    localStorage.removeItem(STORAGE_KEY);
    current = null;
    await loadList();
    if (canvases[0]) await switchTo(canvases[0].id);
    else showEmpty();
  } catch (error) {
    showError(error);
  }
}

function openSwitcher() {
  const rect = ui.name.getBoundingClientRect();
  const entries = canvases.map((canvas) => ({
    label: `${current?.meta.id === canvas.id ? "✓ " : ""}${canvas.name}`,
    onClick: () => switchTo(canvas.id),
  }));
  if (entries.length) entries.push("-");
  entries.push({ label: "新建画布", onClick: createFlow });
  if (current) {
    entries.push({ label: "重命名画布", onClick: renameFlow });
    entries.push({ label: "在资源管理器中显示", onClick: revealFlow });
    entries.push({ label: "删除画布", danger: true, onClick: deleteFlow });
  }
  openMenu(rect.left, rect.bottom + 6, entries, { label: "画布" });
}

async function revealFlow() {
  if (!current) return;
  try {
    await store.revealCanvas(current.meta.id);
  } catch (error) {
    showError(error);
  }
}

/* ---------- 工具与相机 ---------- */

function setTool(name, keepSelection = false) {
  tool = name;
  ui.toolButtons.forEach((button) => {
    const activeButton = button.dataset.tool === name;
    button.classList.toggle("is-active", activeButton);
    button.setAttribute("aria-pressed", String(activeButton));
  });
  ui.stage.dataset.tool = name;
  if (name !== "select" && !keepSelection) select(null);
}

function applyCamera() {
  if (!current) return;
  const camera = current.camera;
  ui.world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  /* 连线层单独一层，靠同一套相机变换跟 world 对齐 */
  ui.edgeTransform.setAttribute(
    "transform",
    `translate(${camera.x} ${camera.y}) scale(${camera.scale})`,
  );
  const raw = GRID_UNIT * camera.scale;
  let gap = raw;
  while (gap < 12) gap *= 2;
  while (gap > 96) gap /= 2;
  const offsetX = ((camera.x % gap) + gap) % gap;
  const offsetY = ((camera.y % gap) + gap) % gap;
  ui.stage.style.backgroundSize = `${gap}px ${gap}px`;
  ui.stage.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
  syncZoomLabel();
  updateSelection();
}

function zoomLabel() {
  return `${Math.round((current?.camera.scale ?? 1) * 100)}%`;
}

function selectZoomDigits() {
  if (document.activeElement !== ui.zoomValue) return;
  const value = ui.zoomValue.value;
  const end = value.endsWith("%") ? value.length - 1 : value.length;
  ui.zoomValue.setSelectionRange(0, end);
}

/* 正在输入时不要把手打的字盖掉 */
function syncZoomLabel() {
  if (ui && document.activeElement === ui.zoomValue) return;
  if (ui) ui.zoomValue.value = zoomLabel();
}

function applyZoomInput() {
  const raw = parseFloat(String(ui.zoomValue.value).replace(/[^0-9.]/g, ""));
  if (!current || !Number.isFinite(raw)) {
    ui.zoomValue.value = zoomLabel();
    return;
  }
  zoomAt(ui.stage.clientWidth / 2, ui.stage.clientHeight / 2, raw / 100);
  ui.zoomValue.value = zoomLabel();
}

function zoomAt(screenX, screenY, nextScale) {
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

function zoomBy(delta) {
  if (!current) return;
  zoomAt(ui.stage.clientWidth / 2, ui.stage.clientHeight / 2, current.camera.scale + delta);
}

function resetZoom() {
  if (!current) return;
  zoomAt(ui.stage.clientWidth / 2, ui.stage.clientHeight / 2, 1);
}

/* 从落点往上找有没有真的带滚动条的容器（笔记正文、便签卡、编辑框、代码块等） */
function hasScrollableAncestor(node, vertical) {
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

function clientToWorld(clientX, clientY) {
  const rect = ui.stage.getBoundingClientRect();
  const camera = current.camera;
  return {
    x: (clientX - rect.left - camera.x) / camera.scale,
    y: (clientY - rect.top - camera.y) / camera.scale,
  };
}

function worldToStage(x, y) {
  const camera = current.camera;
  return { x: camera.x + x * camera.scale, y: camera.y + y * camera.scale };
}

/* ---------- 渲染 ---------- */

function findItem(id) {
  return current?.items.find((item) => item.id === id) || null;
}

function boundsOfItem(id) {
  const item = findItem(id);
  if (!item) return null;
  const el = itemEls.get(id);
  if (!el) return null;
  return itemBounds(item, el);
}

function syncConnector(item) {
  const el = itemEls.get(item.id);
  if (!el) return;
  syncConnectorElement(el, item, connectorGeometry(item, boundsOfItem));
}

/* 连线本身没有坐标，块一动就得重算一遍 */
function refreshConnectors() {
  if (!current) return;
  for (const item of current.items) {
    if (item.type === "connector") syncConnector(item);
  }
}

function addItemElement(item) {
  if (item.type === "connector") {
    const el = createConnectorElement(item);
    itemEls.set(item.id, el);
    ui.edgeTransform.append(el);
    syncConnector(item);
    return el;
  }
  if (!Number.isFinite(item.z)) item.z = nextLayerZ();
  const mediaSrc =
    item.type === "image"
      ? imageCache.get(item.src)
      : item.type === "audio"
        ? audioCache.get(item.src)
        : item.type === "video"
          ? videoCache.get(item.src)
          : undefined;
  const canvasId = current.meta.id;
  const canvasDir = current.meta.path || "";
  const el = createItemElement(item, mediaSrc, {
    mediaMissing: mediaMissing.has(item.id),
    loadAudio: async (src) => {
      const cached = audioCache.get(src);
      if (cached) return cached;
      const url = await store.audioUrl(canvasId, src, item.linked);
      audioCache.set(src, url);
      return url;
    },
    loadVideo: async (src, linked = item.linked) => {
      const cached = videoCache.get(src);
      if (cached) return cached;
      const url = await store.videoUrl(canvasId, src, linked);
      videoCache.set(src, url);
      return url;
    },
    onVideoProblem: (block, reason) => openVideoProblem(block, reason),
    onVideoSize: (block) => {
      /* 第一次拿到真实比例，按视频本身重排这块，之后用户手拉的尺寸不再覆盖 */
      const target = itemEls.get(block.id);
      if (!target) return;
      syncItemElement(target, block);
      updateSelection();
      scheduleItemsSave();
    },
    loadPreview: async (block) => {
      const key = previewKey(block);
      const cached = filePreviewCache.get(key);
      if (cached) return cached;
      const preview = await store.previewCanvasFile(canvasId, block.src, block.linked);
      filePreviewCache.set(key, preview);
      return preview;
    },
    checkFile: (block) => store.canvasFileExists(canvasId, block.src, block.linked),
    canvasDir,
    onMissing: (block) => renderMissing(itemEls.get(block.id), block, canvasDir),
    loadEbookToc: async (block) => {
      const key = ebookKey(canvasId, block);
      const cached = ebookTocCache.get(key);
      if (cached) return cached;
      const info = await store.ebookToc(canvasId, block.src, block.linked);
      ebookTocCache.set(key, info);
      return info;
    },
    loadEbookChapter: (block, index) =>
      store.ebookChapter(canvasId, block.src, block.linked, index),
    onEbookPosition: () => scheduleItemsSave(),
  });
  el.style.zIndex = String(item.z);
  itemEls.set(item.id, el);
  ui.world.append(el);
  if (item.type === "text") item.h = el.offsetHeight;
  if (item.type === "note") hydrateNoteImages(item, el);
  return el;
}

function nextLayerZ() {
  let top = -1;
  if (current) {
    for (const item of current.items) {
      if (item.type !== "connector" && Number.isFinite(item.z)) top = Math.max(top, item.z);
    }
  }
  return top + 1;
}

function renderAll() {
  ui.world.textContent = "";
  ui.edgeTransform.textContent = "";
  previewPath = null;
  noteEditor = null;
  itemEls.clear();
  if (!current) return;
  for (const item of current.items) addItemElement(item);
  updateSelection();
}

function select(id) {
  if (selectedId === id) {
    updateSelection();
    return;
  }
  selectedId = id;
  for (const [itemId, el] of itemEls) {
    el.classList.toggle("is-selected", itemId === id);
  }
  updateSelection();
}

function updateSelection() {
  if (!ui) return;
  refreshConnectors();
  ui.selectLayer.textContent = "";
  ui.endpointLayer.textContent = "";
  updatePorts();
  if (!selectedId) return;
  const item = findItem(selectedId);
  const el = itemEls.get(selectedId);
  if (!item || !el) return;
  el.classList.add("is-selected");

  if (item.type === "connector") {
    const geometry = connectorGeometry(item, boundsOfItem);
    if (!geometry) return;
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

  if (item.type === "line" || item.type === "arrow") {
    const bounds = itemBounds(item, el);
    const topLeft = worldToStage(bounds.x, bounds.y);
    const box = document.createElement("div");
    box.className = "canvas-sel-box";
    box.style.left = `${topLeft.x}px`;
    box.style.top = `${topLeft.y}px`;
    box.style.width = `${bounds.w * current.camera.scale}px`;
    box.style.height = `${bounds.h * current.camera.scale}px`;
    ui.selectLayer.append(box);
    for (const end of ["a", "b"]) {
      const point = end === "a" ? worldToStage(item.x, item.y) : worldToStage(item.x2, item.y2);
      const handle = document.createElement("span");
      handle.className = "canvas-handle canvas-handle-point";
      handle.dataset.handle = "endpoint";
      handle.dataset.end = end;
      handle.style.left = `${point.x}px`;
      handle.style.top = `${point.y}px`;
      ui.endpointLayer.append(handle);
    }
    return;
  }

  const bounds = itemBounds(item, el);
  const topLeft = worldToStage(bounds.x, bounds.y);
  const box = document.createElement("div");
  box.className = "canvas-sel-box";
  box.style.left = `${topLeft.x}px`;
  box.style.top = `${topLeft.y}px`;
  box.style.width = `${bounds.w * current.camera.scale}px`;
  box.style.height = `${bounds.h * current.camera.scale}px`;

  const dirs = ["nw", "ne", "sw", "se"];
  /* 播放器和非文本附件条的排版是固定的，拉角只会把它们挤变形，所以不给缩放把手；
     文本块是在读内容，宽高由用户说了算，把手照给 */
  const fixedLayout = item.type === "audio" || (item.type === "file" && !item.text);
  if (!fixedLayout) {
    for (const dir of dirs) {
      const handle = document.createElement("span");
      handle.className = `canvas-handle canvas-handle-${dir}`;
      handle.dataset.handle = "corner";
      handle.dataset.dir = dir;
      box.append(handle);
    }
  }
  ui.selectLayer.append(box);
}

/* ---------- 指针交互 ---------- */

function onStagePointerDown(e) {
  if (!active || !current || e.button !== 0) return;
  /* 全屏时画面还挂在原来那个块上，事件会顺着 DOM 冒泡回画布：
     这时点的是影片，不是画布，别去挪那块的位置 */
  if (document.fullscreenElement) return;
  const target = e.target.closest?.(".canvas-item, .canvas-connector");

  if (editingId) {
    if (target && target.dataset.id === editingId) return;
    commitEditing();
  }

  if (!target) {
    if (tool === "select") {
      select(null);
      drag = {
        kind: "pan",
        startClient: { x: e.clientX, y: e.clientY },
        origin: { x: current.camera.x, y: current.camera.y },
        moved: false,
      };
      ui.stage.classList.add("is-panning");
    } else {
      startDraw(e);
    }
    return;
  }

  e.preventDefault();
  const item = findItem(target.dataset.id);
  if (!item) return;
  select(item.id);

  if (tool !== "select") {
    startDraw(e);
    return;
  }
  /* 连线没有整条拖动，只能拖端点 */
  if (item.type === "connector") return;
  if (editingId === item.id) return;

  const start = clientToWorld(e.clientX, e.clientY);
  drag = {
    kind: "move",
    id: item.id,
    start,
    origin: { ...item },
    moved: false,
  };
  ui.stage.classList.add("is-moving");
}

function startDraw(e) {
  const start = clientToWorld(e.clientX, e.clientY);
  let item = null;
  if (tool === "rect" || tool === "ellipse") item = makeBox(tool, start.x, start.y, start.x, start.y);
  else if (tool === "line" || tool === "arrow") item = makeLine(tool, start.x, start.y, start.x, start.y);
  else if (tool === "text") {
    item = makeText(start.x, start.y, 40);
    item.bordered = true;
  }
  if (!item) return;

  e.preventDefault();
  select(null);
  current.items.push(item);
  addItemElement(item);
  drag = {
    kind: "draw",
    id: item.id,
    start,
    moved: false,
  };
}

function startResize(handle, e) {
  const item = findItem(selectedId);
  if (!item) return;
  const start = clientToWorld(e.clientX, e.clientY);
  if (handle.dataset.handle === "connect-end") {
    drag = {
      kind: "connect-end",
      id: item.id,
      end: handle.dataset.end,
      fixedId: handle.dataset.end === "from" ? item.to.item : item.from.item,
      point: start,
      targetId: null,
    };
    ui.stage.classList.add("is-connecting");
    updatePorts();
    drawConnectPreview();
    return;
  }
  if (handle.dataset.handle === "endpoint") {
    drag = {
      kind: "endpoint",
      id: item.id,
      end: handle.dataset.end,
      start,
      origin: { ...item },
      moved: false,
    };
    return;
  }
  /* 文字高度由内容撑开，item.h 可能过期；以当前渲染高度为缩放基准 */
  const el = itemEls.get(item.id);
  if (item.type === "text" && el) item.h = el.offsetHeight;
  drag = {
    kind: "resize",
    id: item.id,
    dir: handle.dataset.dir,
    start,
    origin: { ...item },
    aspect: item.w / Math.max(1, item.h),
    page: capturePagePin(item, el),
    moved: false,
  };
  ui.stage.classList.add("is-resizing");
}

function onWindowPointerMove(e) {
  if (!active || !drag || !current) return;

  /* 平移用的是屏幕坐标，没有世界坐标起点；先处理，别去读 drag.start */
  if (drag.kind === "pan") {
    const dx = e.clientX - drag.startClient.x;
    const dy = e.clientY - drag.startClient.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) drag.moved = true;
    current.camera.x = drag.origin.x + dx;
    current.camera.y = drag.origin.y + dy;
    applyCamera();
    return;
  }

  if (drag.kind === "connect" || drag.kind === "connect-end") {
    drag.point = clientToWorld(e.clientX, e.clientY);
    const exclude = drag.kind === "connect" ? [drag.from.item] : [drag.fixedId];
    const hit = connectHit(e, exclude);
    drag.targetSide = hit ? hit.side : null;
    if (setConnectTarget(hit ? hit.id : null)) updatePorts();
    drawConnectPreview();
    return;
  }

  const point = clientToWorld(e.clientX, e.clientY);
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) drag.moved = true;

  const item = findItem(drag.id);
  if (!item) return;
  const el = itemEls.get(item.id);
  if (!el) return;

  if (drag.kind === "move") {
    const origin = drag.origin;
    item.x = origin.x + dx;
    item.y = origin.y + dy;
    if (item.type === "line" || item.type === "arrow") {
      item.x2 = origin.x2 + dx;
      item.y2 = origin.y2 + dy;
    }
  } else if (drag.kind === "endpoint") {
    if (drag.end === "a") {
      item.x = point.x;
      item.y = point.y;
    } else {
      item.x2 = point.x;
      item.y2 = point.y;
    }
  } else if (drag.kind === "draw") {
    if (item.type === "rect" || item.type === "ellipse") {
      item.x = Math.min(drag.start.x, point.x);
      item.y = Math.min(drag.start.y, point.y);
      item.w = Math.max(1, Math.abs(dx));
      item.h = Math.max(1, Math.abs(dy));
    } else if (item.type === "line" || item.type === "arrow") {
      item.x2 = point.x;
      item.y2 = point.y;
    } else if (item.type === "text") {
      /* 文字块拖出矩形：按下处是起点，往右下方拖出宽高 */
      item.x = Math.min(drag.start.x, point.x);
      item.y = Math.min(drag.start.y, point.y);
      item.w = Math.max(40, Math.abs(dx));
      item.minH = Math.max(32, Math.abs(dy));
    }
  } else if (drag.kind === "resize") {
    const origin = drag.origin;
    if (item.type === "image") {
      const width =
        drag.dir.includes("e") ? origin.w + dx : origin.w - dx;
      const w = Math.max(8, width);
      const h = w / drag.aspect;
      item.w = w;
      item.h = h;
      item.x = drag.dir.includes("w") ? origin.x + origin.w - w : origin.x;
      item.y = drag.dir.includes("n") ? origin.y + origin.h - h : origin.y;
    } else if (item.type === "text") {
      /* 拖角：左右改宽度，上下改最小高度（内容再多仍会自动长高） */
      let w = origin.w;
      if (drag.dir.includes("e")) w = Math.max(40, origin.w + dx);
      if (drag.dir.includes("w")) w = Math.max(40, origin.w - dx);
      item.w = w;
      item.x = drag.dir.includes("w") ? origin.x + origin.w - w : origin.x;

      let h = origin.h;
      if (drag.dir.includes("s")) h = Math.max(32, origin.h + dy);
      if (drag.dir.includes("n")) h = Math.max(32, origin.h - dy);
      item.minH = h;
      item.y = drag.dir.includes("n") ? origin.y + origin.h - h : origin.y;
    } else {
      /* 视频块缩到看不见控件就没意义了，下限比别的图元高 */
      const minW = item.type === "video" ? VIDEO_MIN_WIDTH : 8;
      const minH = item.type === "video" ? VIDEO_MIN_HEIGHT : 8;
      if (drag.dir.includes("e")) item.w = Math.max(minW, origin.w + dx);
      if (drag.dir.includes("w")) {
        const w = Math.max(minW, origin.w - dx);
        item.x = origin.x + origin.w - w;
        item.w = w;
      }
      if (drag.dir.includes("s")) item.h = Math.max(minH, origin.h + dy);
      if (drag.dir.includes("n")) {
        const h = Math.max(minH, origin.h - dy);
        item.y = origin.y + origin.h - h;
        item.h = h;
      }
      /* 手动拉过就别再自动按视频比例改了（自动改只在第一次拿到元数据时发生） */
      if (item.type === "video") item.sized = true;
    }
  }

  /* 书页钉在起始尺寸上，容器的真实尺寸才不会把它撑到掉帧；拉满靠 transform */
  if (drag.page) pinEbookPage(drag.page);
  syncItemElement(el, item);
  if (drag.page) stretchEbookPage(drag.page);
  if (item.type === "text") {
    item.h = el.offsetHeight;
    /* 内容把块撑得比目标高时，拖上边要贴住底边重算 y */
    if (drag.kind === "resize" && drag.dir.includes("n")) {
      item.y = drag.origin.y + drag.origin.h - item.h;
      syncItemElement(el, item);
    }
  }
  updateSelection();
}

function onWindowPointerUp(e) {
  if (!drag || !current) return;
  const finished = drag;
  drag = null;
  ui.stage.classList.remove("is-panning", "is-moving", "is-resizing");
  if (e) {
    const hit = connectHit(e, []);
    if (hit) hoverId = hit.id;
    /* 以松手瞬间的位置为准，避免最后一次移动事件之后又挪到端口上 */
    if (hit && (finished.kind === "connect" || finished.kind === "connect-end")) {
      const exclude = finished.kind === "connect" ? finished.from.item : finished.fixedId;
      if (hit.id !== exclude) {
        finished.targetId = hit.id;
        finished.targetSide = hit.side;
      }
    }
  }
  updatePorts();
  const item = finished.id ? findItem(finished.id) : null;
  if (finished.page && item) {
    /* 拖拽期间书页只是被「画」成目标大小，松手这一下才真给它换尺寸，正文重新排版 */
    const el = itemEls.get(item.id);
    releaseEbookPage(finished.page);
    if (el) syncItemElement(el, item);
  }

  if (finished.kind === "pan") {
    if (finished.moved) scheduleCameraSave();
    return;
  }
  if (finished.kind === "connect") {
    finishConnect(finished);
    return;
  }
  if (finished.kind === "connect-end") {
    finishConnectEnd(finished);
    return;
  }
  if (!item) return;

  if (finished.kind === "draw") {
    if (item.type === "text") {
      if (!finished.moved) {
        item.x = finished.start.x;
        item.y = finished.start.y;
        item.w = TEXT_DEFAULT_WIDTH;
        item.minH = TEXT_DEFAULT_WIDTH;
      }
      syncItemElement(itemEls.get(item.id), item);
      setTool("select", true);
      select(item.id);
      scheduleItemsSave();
      startTextEdit(item.id);
      return;
    }
    const tooSmall =
      item.type === "line" || item.type === "arrow"
        ? Math.hypot(item.x2 - item.x, item.y2 - item.y) < 3
        : item.w < 4 || item.h < 4;
    if (!finished.moved || tooSmall) {
      removeItemFromDom(item.id);
      const index = current.items.indexOf(item);
      if (index >= 0) current.items.splice(index, 1);
      select(null);
      setTool("select");
      return;
    }
    setTool("select", true);
    select(item.id);
    scheduleItemsSave();
    return;
  }

  if (finished.moved) scheduleItemsSave();
}

/* ---------- 连线交互 ---------- */

/* 端口在「选择工具 + 悬停或选中一个块 + 没在拖拽」时出现；
   连线拖拽中则跟着鼠标下的目标块走，方便瞄准具体的边 */
function portTargetId() {
  if (!current || !active || tool !== "select" || editingId) return null;
  if (drag) {
    return drag.kind === "connect" || drag.kind === "connect-end"
      ? drag.targetId || null
      : null;
  }
  const hovered = hoverId ? findItem(hoverId) : null;
  if (hovered && CONNECTABLE.has(hovered.type)) return hovered.id;
  const picked = selectedId ? findItem(selectedId) : null;
  if (picked && CONNECTABLE.has(picked.type)) return picked.id;
  return null;
}

function updatePorts() {
  if (!ui?.portLayer) return;
  const id = portTargetId();
  ui.portLayer.textContent = "";
  if (!id) return;
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  const bounds = itemBounds(item, el);
  for (const side of ["top", "right", "bottom", "left"]) {
    const anchor = sideAnchor(bounds, side);
    const point = worldToStage(anchor.x, anchor.y);
    const port = document.createElement("span");
    port.className = "canvas-port";
    port.dataset.id = id;
    port.dataset.side = side;
    port.style.left = `${point.x}px`;
    port.style.top = `${point.y}px`;
    ui.portLayer.append(port);
  }
}

function startConnect(e) {
  if (!active || !current || e.button !== 0) return;
  const port = e.target.closest?.(".canvas-port");
  if (!port) return;
  const item = findItem(port.dataset.id);
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  if (editingId) commitEditing();
  drag = {
    kind: "connect",
    from: { item: item.id, side: port.dataset.side },
    point: clientToWorld(e.clientX, e.clientY),
    targetId: null,
  };
  ui.stage.classList.add("is-connecting");
  updatePorts();
  drawConnectPreview();
}

/* 拖拽中光标下的目标：端口优先（能确定具体边），否则整个块（边自动挑）。
   端口层在块之上，e.target 可能不是块本身；端点手柄等又会挡住块，
   所以按整摞命中结果找端口/块 */
function connectHit(e, excludeIds) {
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

function setConnectTarget(id) {
  if (!drag || drag.targetId === id) return false;
  if (drag.targetId) itemEls.get(drag.targetId)?.classList.remove("is-connect-target");
  drag.targetId = id;
  if (id) itemEls.get(id)?.classList.add("is-connect-target");
  return true;
}

/* 拖拽中的预览线：目标没落在块上时用光标位置当临时端点 */
function drawConnectPreview() {
  if (!drag) return;
  const pointerBounds = { x: drag.point.x, y: drag.point.y, w: 0, h: 0 };
  let route = null;
  if (drag.kind === "connect") {
    const sourceBounds = boundsOfItem(drag.from.item);
    const targetBounds = drag.targetId ? boundsOfItem(drag.targetId) : pointerBounds;
    if (sourceBounds && targetBounds) {
      route = routeConnector(
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
          ? routeConnector(
              connector.shape,
              connector.from.side,
              drag.targetSide || "auto",
              fixedBounds,
              movingBounds,
            )
          : routeConnector(
              connector.shape,
              drag.targetSide || "auto",
              connector.to.side,
              movingBounds,
              fixedBounds,
            );
    }
  }
  if (route) showPreview(route.d);
  else clearPreview();
}

function showPreview(d) {
  if (!previewPath) {
    previewPath = document.createElementNS(SVG_NS, "path");
    previewPath.classList.add("canvas-edge-preview");
    ui.edgeTransform.append(previewPath);
  }
  previewPath.setAttribute("d", d);
}

function clearPreview() {
  if (!previewPath) return;
  previewPath.remove();
  previewPath = null;
}

function cleanupConnect(finished) {
  if (finished?.targetId) itemEls.get(finished.targetId)?.classList.remove("is-connect-target");
  clearPreview();
  ui.stage.classList.remove("is-connecting");
}

function finishConnect(finished) {
  const targetId = finished.targetId;
  cleanupConnect(finished);
  if (!targetId) return;
  const connector = makeConnector(finished.from.item, finished.from.side, targetId);
  connector.to.side = finished.targetSide || "auto";
  current.items.push(connector);
  addItemElement(connector);
  select(connector.id);
  scheduleItemsSave();
}

function finishConnectEnd(finished) {
  const targetId = finished.targetId;
  cleanupConnect(finished);
  const connector = findItem(finished.id);
  if (!connector || !targetId) return;
  const side = finished.targetSide || "auto";
  if (finished.end === "from") connector.from = { item: targetId, side };
  else connector.to = { item: targetId, side };
  syncConnector(connector);
  updateSelection();
  scheduleItemsSave();
}

function onStageDoubleClick(e) {
  if (!active || !current) return;
  const target = e.target.closest?.(".canvas-item");
  if (!target) return;
  const item = findItem(target.dataset.id);
  if (!item) return;
  if (!["text", "sticky", "note"].includes(item.type)) return;
  e.preventDefault();
  setTool("select", true);
  select(item.id);
  if (item.type === "text") startTextEdit(item.id);
  else if (item.type === "sticky") startStickyEdit(item.id);
  else startNoteEdit(item.id);
}

function onStageContextMenu(e) {
  if (!active || !current) return;
  /* 全屏时菜单挂在 body 上，只会渲染全屏子树，弹了也看不见 */
  if (document.fullscreenElement) return;
  e.preventDefault();
  e.stopPropagation();
  if (editingId) commitEditing();
  const target = e.target.closest?.(".canvas-item, .canvas-connector");
  if (!target) {
    openBlankMenu(e.clientX, e.clientY);
    return;
  }
  const item = findItem(target.dataset.id);
  if (!item) return;
  select(item.id);
  openItemMenu(item, e.clientX, e.clientY);
}

/* ---------- 右键菜单 ---------- */

function openItemMenu(item, x, y) {
  const entries = [];
  const pick = (prop, options) => () => pickColor(item, prop, x, y, options);
  const none = { allowNone: true, noneLabel: "透明" };
  if (item.type === "rect" || item.type === "ellipse") {
    entries.push({
      label: "边框颜色",
      onClick: pick("borderColor", none),
    });
    entries.push({
      label: "填充颜色",
      onClick: pick("fillColor", none),
    });
  } else if (item.type === "line" || item.type === "arrow") {
    entries.push({ label: "线条颜色", onClick: pick("borderColor") });
  } else if (item.type === "text") {
    entries.push({
      label: "文字颜色",
      onClick: pick("color"),
    });
    entries.push({
      label: "文字字号",
      onClick: () => openFontSizeMenu(item, x, y),
    });
    entries.push({
      label: "背景颜色",
      onClick: pick("fillColor", none),
    });
    entries.push({
      label: "边框颜色",
      onClick: pick("borderColor", none),
    });
  } else if (item.type === "connector") {
    entries.push({ label: "线条颜色", onClick: pick("color") });
    entries.push({ label: "线型", onClick: () => openConnectorShapeMenu(item, x, y) });
    entries.push({ label: "箭头", onClick: () => openConnectorArrowMenu(item, x, y) });
  } else if (item.type === "image") {
    entries.push({
      label: "边框颜色",
      onClick: pick("borderColor", none),
    });
  } else if (item.type === "sticky") {
    entries.push({ label: "编辑", onClick: () => startStickyEdit(item.id) });
    entries.push({
      label: "文字颜色",
      onClick: () => pickStickyColor(item, "textColor", x, y),
    });
    entries.push({
      label: "背景颜色",
      onClick: () => pickStickyColor(item, "color", x, y),
    });
  } else if (item.type === "note") {
    entries.push({ label: "编辑", onClick: () => startNoteEdit(item.id) });
  }
  /* 画布不替用户开文件，只把他带到那份文件躺着的地方 */
  if (revealTarget(item)) {
    entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
  }
  /* 连线固定在最底层，不参与层级调整 */
  if (item.type !== "connector") {
    entries.push({ label: "层级", onClick: () => openLayerMenu(item, x, y) });
  }
  if (entries.length) entries.push("-");
  entries.push({ label: "删除", danger: true, onClick: () => deleteItem(item.id) });
  openMenu(x, y, entries);
}

/* 便签文字色 / 背景色：和便签墙用同一套预设；改动只落在画布里的副本上。 */
function pickStickyColor(item, field, x, y) {
  const isText = field === "textColor";
  const initial = item[field] || (isText ? STICKY_DEFAULT_TEXT : STICKY_DEFAULT_COLOR);
  let touched = false;
  const apply = (color) => {
    if (!color) return;
    item[field] = color;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
  };
  openColorPicker({
    x,
    y,
    value: initial,
    presets: isText ? STICKY_TEXT_PRESETS : STICKY_BG_PRESETS,
    onChange: (color) => {
      touched = true;
      apply(color);
    },
    onDone: (color) => {
      if (!touched) return;
      apply(color);
      scheduleItemsSave();
    },
  });
}

function openLayerMenu(item, x, y) {
  openMenu(
    x,
    y,
    [
      { label: "上一层", onClick: () => moveLayer(item, 1) },
      { label: "下一层", onClick: () => moveLayer(item, -1) },
      { label: "最顶层", onClick: () => moveLayer(item, "top") },
      { label: "最底层", onClick: () => moveLayer(item, "bottom") },
    ],
    { label: "层级" },
  );
}

function moveLayer(item, dir) {
  if (!current) return;
  const blocks = current.items
    .filter((entry) => entry.type !== "connector")
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const index = blocks.indexOf(item);
  if (index < 0) return;
  const target =
    dir === "top"
      ? blocks.length - 1
      : dir === "bottom"
        ? 0
        : Math.min(blocks.length - 1, Math.max(0, index + dir));
  if (target === index) return;
  blocks.splice(index, 1);
  blocks.splice(target, 0, item);
  blocks.forEach((entry, position) => {
    entry.z = position;
    const el = itemEls.get(entry.id);
    if (el) el.style.zIndex = String(position);
  });
  scheduleItemsSave();
}

function openBlankMenu(x, y) {
  const entries = [{ label: "新建画布", onClick: createFlow }];
  if (current) {
    entries.push({
      label: "重置视图",
      onClick: () => {
        current.camera = { x: 0, y: 0, scale: 1 };
        applyCamera();
        scheduleCameraSave();
      },
    });
    entries.push({ label: "重命名画布", onClick: renameFlow });
    entries.push({ label: "在资源管理器中显示", onClick: revealFlow });
  }
  openMenu(x, y, entries);
}

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32, 48];

function openFontSizeMenu(item, x, y) {
  const current = item.fontSize || 14;
  const sizes = FONT_SIZES.includes(current)
    ? FONT_SIZES
    : [...FONT_SIZES, current].sort((a, b) => a - b);
  openMenu(
    x,
    y,
    sizes.map((size) => ({
      label: `${size}px${size === current ? " ✓" : ""}`,
      onClick: () => setFontSize(item, size),
    })),
    { label: "文字字号" },
  );
}

function setFontSize(item, size) {
  item.fontSize = size;
  const el = itemEls.get(item.id);
  if (el) {
    syncItemElement(el, item);
    item.h = el.offsetHeight;
  }
  updateSelection();
  scheduleItemsSave();
}

function openConnectorShapeMenu(item, x, y) {
  const options = [
    ["elbow", "折线"],
    ["curve", "曲线"],
  ];
  openMenu(
    x,
    y,
    options.map(([value, label]) => ({
      label: `${label}${item.shape === value ? " ✓" : ""}`,
      onClick: () => setConnectorProp(item, "shape", value),
    })),
    { label: "线型" },
  );
}

function openConnectorArrowMenu(item, x, y) {
  const options = [
    ["none", "无"],
    ["end", "终点"],
    ["both", "双向"],
  ];
  openMenu(
    x,
    y,
    options.map(([value, label]) => ({
      label: `${label}${item.arrow === value ? " ✓" : ""}`,
      onClick: () => setConnectorProp(item, "arrow", value),
    })),
    { label: "箭头" },
  );
}

function setConnectorProp(item, prop, value) {
  item[prop] = value;
  syncConnector(item);
  updateSelection();
  scheduleItemsSave();
}

function applyColor(item, prop, color) {
  item[prop] = color;
  /* 文字块的边框随颜色开关：选了颜色才显示边框，选「透明」就去掉 */
  if (item.type === "text" && prop === "borderColor") {
    item.bordered = Boolean(color);
  }
  if (item.type === "connector") {
    syncConnector(item);
    return;
  }
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
}

function pickColor(item, prop, x, y, { allowNone = false, noneLabel = "无填充" } = {}) {
  const seed = prop === "fillColor" ? "#ffffff" : prop === "color" ? "#ffffff" : "#9a9a9a";
  /* 打开后直接点外面关掉不算改色：否则图片这种默认无边框的图元会被填上兜底色 */
  let touched = false;
  openColorPicker({
    x,
    y,
    value: item[prop] || "",
    seed,
    presets: PRESETS,
    allowNone,
    noneLabel,
    allowAlpha: true,
    onChange: (color) => {
      touched = true;
      applyColor(item, prop, color);
    },
    onDone: (color) => {
      if (!touched) return;
      applyColor(item, prop, color);
      scheduleItemsSave();
    },
  });
}

function deleteItem(id) {
  if (!current) return;
  const target = findItem(id);
  if (!target) return;
  const doomed = new Set([id]);
  /* 删块时，挂在它身上的连线一起删，不留悬空线 */
  if (target.type !== "connector") {
    for (const item of current.items) {
      if (item.type === "connector" && (item.from.item === id || item.to.item === id)) {
        doomed.add(item.id);
      }
    }
  }
  let removedSelected = false;
  for (const removeId of doomed) {
    const index = current.items.findIndex((item) => item.id === removeId);
    if (index < 0) continue;
    const [item] = current.items.splice(index, 1);
    if (editingId === removeId) editingId = null;
    const el = itemEls.get(removeId);
    el?.querySelector("audio")?.pause();
    el?.querySelector("video")?.pause();
    removeItemFromDom(removeId);
    if (removeId === selectedId) removedSelected = true;
    if (item.type === "image" && item.src) {
      imageCache.delete(item.src);
      store.deleteCanvasImage(current.meta.id, item.src, item.linked).catch(() => {});
    }
    if (item.type === "audio" && item.src) {
      audioCache.delete(item.src);
      store.deleteCanvasAudio(current.meta.id, item.src, item.linked).catch(() => {});
    }
    if (item.type === "video" && item.src) {
      videoCache.delete(item.src);
      if (item.audioRel) videoCache.delete(item.audioRel);
      // 引用态只断链接，原片是用户自己的东西，后端不会去动它
      store
        .deleteCanvasVideo(current.meta.id, item.src, item.linked, item.audioRel)
        .catch(() => {});
    }
    if (item.type === "note") {
      const prefix = `notes/${item.id}/`;
      for (const key of [...noteImageCache.keys()]) {
        if (key.startsWith(prefix)) noteImageCache.delete(key);
      }
      if (noteEditor?.itemId === item.id) noteEditor = null;
      store.deleteCanvasNoteAssets(current.meta.id, item.id).catch(() => {});
    }
    /* 拷贝块的副本跟着块一起进回收站；引用块只断链接，原文件在用户手里不动 */
    if (item.type === "file" && item.src) {
      filePreviewCache.delete(previewKey(item));
      store.deleteCanvasFile(current.meta.id, item.src, item.linked).catch(() => {});
    }
    if (item.type === "ebook" && item.src) {
      ebookTocCache.delete(ebookKey(current.meta.id, item));
      store.deleteCanvasFile(current.meta.id, item.src, item.linked).catch(() => {});
    }
  }
  if (removedSelected) selectedId = null;
  updateSelection();
  scheduleItemsSave();
}

function removeItemFromDom(id) {
  const el = itemEls.get(id);
  if (el) el.remove();
  itemEls.delete(id);
}

/* ---------- 文字编辑 ---------- */

function startTextEdit(id) {
  if (editingId === id) return;
  if (editingId) commitEditing();
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "text") return;
  editingId = id;
  selectedId = id;
  el.classList.add("is-editing");
  const body = el.querySelector(".canvas-text-body");
  body.contentEditable = "plaintext-only";
  body.spellcheck = false;
  el.querySelector(".canvas-text-body").focus({ preventScroll: true });

  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  body.addEventListener("input", onTextInput);
  body.addEventListener("keydown", onTextKeyDown);
  body.addEventListener("blur", onTextBlur);
  body.addEventListener("paste", onTextPaste);
  updateSelection();
}

function onTextInput() {
  if (!editingId) return;
  const item = findItem(editingId);
  const el = itemEls.get(editingId);
  if (!item || !el) return;
  const body = el.querySelector(".canvas-text-body");
  item.text = body.innerText.replace(/\n$/, "");
  item.h = el.offsetHeight;
  updateSelection();
  scheduleItemsSave();
}

function onTextKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    commitEditing();
  }
}

function onTextPaste(e) {
  e.preventDefault();
  const text = e.clipboardData?.getData("text/plain") || "";
  if (text) document.execCommand("insertText", false, text);
}

function onTextBlur() {
  if (editingId) commitEditing();
}

function commitEditing() {
  if (!editingId) return;
  const editing = findItem(editingId);
  if (editing?.type === "note") {
    commitNoteEditing();
    return;
  }
  if (editing?.type === "sticky") {
    commitStickyEditing();
    return;
  }
  const id = editingId;
  editingId = null;
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  const body = el.querySelector(".canvas-text-body");
  item.text = body.innerText.replace(/\n$/, "");
  item.h = el.offsetHeight;
  body.contentEditable = "false";
  body.removeEventListener("input", onTextInput);
  body.removeEventListener("keydown", onTextKeyDown);
  body.removeEventListener("blur", onTextBlur);
  body.removeEventListener("paste", onTextPaste);
  el.classList.remove("is-editing");

  /* 文字工具画出来的空块要留着（还能再双击进去写）；粘贴出来的文字清空后照旧删掉 */
  if (!item.text.trim() && !item.bordered) {
    deleteItem(id);
    return;
  }
  updateSelection();
  scheduleItemsSave();
}

/* ---------- 便签 / 笔记块 ---------- */

function caretEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function startStickyEdit(id) {
  if (editingId === id) return;
  if (editingId) commitEditing();
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "sticky") return;
  editingId = id;
  selectedId = id;
  el.classList.add("is-editing");
  const body = el.querySelector(".canvas-sticky-body");
  body.contentEditable = "plaintext-only";
  body.spellcheck = false;
  body.focus({ preventScroll: true });
  caretEnd(body);
  body.addEventListener("input", onStickyInput);
  body.addEventListener("keydown", onStickyKeyDown);
  body.addEventListener("blur", onStickyBlur);
  body.addEventListener("paste", onStickyPaste);
  updateSelection();
}

function onStickyInput() {
  if (!editingId) return;
  const item = findItem(editingId);
  if (!item || item.type !== "sticky") return;
  const el = itemEls.get(editingId);
  const body = el?.querySelector(".canvas-sticky-body");
  if (!body) return;
  item.text = body.innerText.replace(/\n$/, "");
  scheduleItemsSave();
}

function onStickyKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    commitEditing();
  }
}

function onStickyBlur() {
  if (editingId) commitEditing();
}

function onStickyPaste(e) {
  e.preventDefault();
  const text = e.clipboardData?.getData("text/plain") || "";
  if (text) document.execCommand("insertText", false, text);
}

function commitStickyEditing() {
  const id = editingId;
  editingId = null;
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "sticky") return;
  const body = el.querySelector(".canvas-sticky-body");
  item.text = body.innerText.replace(/\n$/, "");
  body.contentEditable = "false";
  body.removeEventListener("input", onStickyInput);
  body.removeEventListener("keydown", onStickyKeyDown);
  body.removeEventListener("blur", onStickyBlur);
  body.removeEventListener("paste", onStickyPaste);
  el.classList.remove("is-editing");
  updateSelection();
  scheduleItemsSave();
}

/* 笔记块内联编辑器：工具栏、撤销重做、粘贴图片全部复用笔记页那一套。
 * 引用块默认只读——双击先问清楚「改源文件 / 转成画布副本 / 算了」，取消就一个字都不动。 */
async function startNoteEdit(id) {
  if (editingId === id) {
    noteEditor?.editor.focus();
    return;
  }
  const item = findItem(id);
  if (!item || item.type !== "note") return;
  if (noteAskId === id) return;

  let writeBack = false;
  if (item.linked) {
    const canvasId = current.meta.id;
    noteAskId = id;
    let mode = null;
    try {
      mode = await choiceDialog({
        title: "这块正文来自原文件",
        message: `「${item.name}」引用的是 ${item.path}。这次编辑要改哪一份？`,
        note: "改源文件会把正文直接写回那份 .md；复制进画布则把正文收进块里，原文件不动，之后随便改。",
        options: [
          { value: "write", label: "修改源文件", hint: "直接写回那份 Markdown" },
          { value: "copy", label: "复制进画布", hint: "原文件不动，之后随便改" },
        ],
      });
    } finally {
      noteAskId = null;
    }
    /* 弹层期间可能切了画布 / 关了页面，块早就不存在了 */
    if (!current || current.meta.id !== canvasId || !findItem(id)) return;
    if (!mode) return;
    if (mode === "copy") convertNoteToCopy(item);
    else writeBack = true;
  }

  if (editingId) commitEditing();
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "note") return;

  noteWriteBack = writeBack;
  editingId = id;
  selectedId = id;
  el.classList.add("is-editing");

  let state = noteEditor && noteEditor.el === el ? noteEditor : null;
  if (!state) {
    const canvasId = current.meta.id;
    const box = document.createElement("div");
    box.className = "canvas-note-editor";
    const toolbar = document.createElement("div");
    toolbar.className = "notes-toolbar canvas-note-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Markdown 工具栏");
    const textarea = document.createElement("textarea");
    textarea.className = "notes-textarea canvas-note-textarea";
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", "Markdown 源码");
    box.append(toolbar, textarea);
    el.querySelector(".canvas-note-card").append(box);

    const editor = createMarkdownEditor({
      textarea,
      toolbar,
      /* 引用块贴图会把画布目录下的相对路径写进用户原文件，那份 .md 挪个窝图就全断了。
         真要贴图就先转成画布副本，图片才跟着块走。 */
      saveImage: async (data, ext) => {
        if (findItem(item.id)?.linked) throw new Error("引用块请先选「复制进画布」再贴图");
        return store.saveCanvasNoteImage(canvasId, item.id, data, ext);
      },
      onChange: (value) => {
        const target = findItem(item.id);
        if (!target) return;
        target.source = value;
        scheduleItemsSave();
      },
      onError: (message) => showError(message),
    });

    textarea.addEventListener("blur", () => scheduleNoteBlurCheck(item.id));
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commitEditing();
      }
    });

    const reading = el.querySelector(".canvas-note-body");
    reading?.addEventListener("pointerdown", onNoteLinkPointerDown);
    reading?.addEventListener("click", onNoteLinkClick);

    state = { itemId: item.id, el, box, textarea, editor };
    noteEditor = state;
  }

  state.itemId = item.id;
  state.editor.setValue(item.source);
  state.editor.setEnabled(true);
  const reading = el.querySelector(".canvas-note-body");
  if (reading) reading.hidden = true;
  state.box.hidden = false;
  state.editor.focus();
  updateSelection();
}

/* 失焦退出，但点工具栏 / 右键菜单 / 取色盘不算离开：那些操作本来就是编辑的一部分。 */
function scheduleNoteBlurCheck(id) {
  setTimeout(() => {
    if (editingId !== id) return;
    const active = document.activeElement;
    if (active?.closest?.(NOTE_EDITOR_GUARDS)) return;
    if (document.querySelector(".color-pop")) return;
    const menu = document.getElementById("ctx-menu");
    if (menu && !menu.hidden) return;
    commitEditing();
  }, 0);
}

function commitNoteEditing() {
  const state = noteEditor;
  const id = editingId;
  const writeBack = noteWriteBack;
  editingId = null;
  noteWriteBack = false;
  if (!state) return;
  const item = findItem(state.itemId);
  const el = itemEls.get(state.itemId);
  if (!item || !el || item.type !== "note" || state.itemId !== id) {
    noteEditor = null;
    updateSelection();
    return;
  }
  const draft = state.editor.getValue();
  const previous = item.source;
  item.source = draft;
  state.editor.setEnabled(false);
  state.box.hidden = true;
  const reading = el.querySelector(".canvas-note-body");
  if (reading) {
    reading.innerHTML = renderMarkdown(item.source);
    reading.hidden = false;
    hydrateNoteImages(item, el);
  }
  el.classList.remove("is-editing");
  updateSelection();
  scheduleItemsSave();
  /* 选的是「修改源文件」才写盘；后端只认 items.json 里这块自己记着的那条路径 */
  if (writeBack && item.linked) {
    store.writeBackNote(current.meta.id, item.id, draft).catch((error) => {
      showError(error);
      /* 没写进去，界面上那份新正文就是假的：退回编辑前读到的那份，同时把稿子留在
         输入框里重新进入编辑，用户不至于白打一遍 */
      item.source = previous;
      renderNoteBody(item, el);
      scheduleItemsSave();
      if (noteEditor?.itemId === item.id && findItem(item.id)) {
        editingId = item.id;
        el.classList.add("is-editing");
        reading?.setAttribute("hidden", "");
        noteEditor.box.hidden = false;
        noteEditor.editor.setEnabled(true);
        noteEditor.editor.focus();
      }
    });
  }
}

function renderNoteBody(item, el) {
  const body = el.querySelector(".canvas-note-body");
  if (!body) return;
  body.innerHTML = renderMarkdown(item.source);
  hydrateNoteImages(item, el);
}

/* 「复制进画布」：正文留在块里，链接断掉，原 .md 一个字节都不动。
   图片另说——引用期间本来就禁止贴图，块里不会有指向画布目录的图片路径。 */
function convertNoteToCopy(item) {
  item.linked = false;
  item.path = "";
  item.sourceFormat = "utf8";
  item.sourceCrlf = false;
  const el = itemEls.get(item.id);
  if (el) {
    el.querySelector(".canvas-note-badge")?.remove();
    el.title = item.name;
  }
  scheduleItemsSave();
}

/* 引用块的正文只是显示缓存，进画布时现读一次原文件，用户在外面改了也能看到。
 * 读不到就当原文件没了：块和最后一次读到的正文都留着，只把角标换成那句话，
 * 别把整张画布卡在这。返回这些读不到的块，renderAll 之后再改角标。 */
async function refreshLinkedNotes() {
  if (!current) return [];
  const stale = [];
  let changed = false;
  await Promise.all(
    current.items
      .filter((item) => item.type === "note" && item.linked && item.path)
      .map(async (item) => {
        try {
          const file = await store.readFileText(item.path);
          item.source = file.text;
          item.sourceFormat = file.format || "utf8";
          item.sourceCrlf = Boolean(file.crlf);
          changed = true;
        } catch {
          stale.push(item);
        }
      }),
  );
  /* 写回时后端是从 items.json 里查这份编码/换行的，这里不落盘它就照着旧的那份还原 */
  if (changed) scheduleItemsSave();
  return stale;
}

function onNoteLinkPointerDown(e) {
  if (e.target.closest?.("a[href]")) e.stopPropagation();
}

async function onNoteLinkClick(e) {
  const anchor = e.target.closest?.("a[href]");
  if (!anchor) return;
  const url = anchor.getAttribute("href") || "";
  if (!/^(https?:|mailto:|tel:)/i.test(url)) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    await invoke("plugin:opener|open_url", { url });
  } catch {
    showError("打不开这个链接（系统浏览器调用失败）");
  }
}

/* ---------- 笔记图片副本 ---------- */

function decodeRel(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function splitDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片数据有误");
  const mime = /^data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] || "image/png";
  const ext = (mime.split("/")[1] || "png").toLowerCase().replace("jpeg", "jpg");
  return { data: dataUrl.slice(comma + 1), ext };
}

/* 把原笔记里的本地图片读出来，复制进画布自己的 notes/<块id>/，返回映射。 */
async function snapshotNoteImages(canvasId, item) {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(item.source);
  const raws = [
    ...new Set(
      [...host.querySelectorAll("img.md-local-img")]
        .map((img) => decodeRel(img.dataset.src || ""))
        .filter(Boolean),
    ),
  ];
  const assets = {};
  for (const raw of raws) {
    try {
      const dataUrl = await store.readNoteImage(item.path, raw);
      const { data, ext } = splitDataUrl(dataUrl);
      assets[raw] = await store.saveCanvasNoteImage(canvasId, item.id, data, ext);
    } catch {
      /* 原图缺失：这个链接保留原样，渲染时显示占位 */
    }
  }
  return assets;
}

function noteImageRel(item, raw) {
  if (item.assets && item.assets[raw]) return item.assets[raw];
  if (raw.startsWith(`notes/${item.id}/`)) return raw;
  return "";
}

function replaceMissingNoteImage(img) {
  const missing = document.createElement("span");
  missing.className = "md-image-missing";
  missing.textContent = `[图片：${img.alt || "缺失"}]`;
  img.replaceWith(missing);
}

async function hydrateNoteImages(item, el) {
  if (!current) return;
  const canvasId = current.meta.id;
  const images = [...el.querySelectorAll(".canvas-note-body img.md-local-img")];
  for (const img of images) {
    const raw = decodeRel(img.dataset.src || "");
    const rel = noteImageRel(item, raw);
    if (!rel) {
      replaceMissingNoteImage(img);
      continue;
    }
    try {
      let dataUrl = noteImageCache.get(rel);
      if (!dataUrl) {
        dataUrl = await store.readCanvasNoteImage(canvasId, item.id, rel);
        noteImageCache.set(rel, dataUrl);
      }
      if (!current || current.meta.id !== canvasId || !img.isConnected) return;
      img.src = dataUrl;
      img.classList.remove("md-local-img");
    } catch {
      if (img.isConnected) replaceMissingNoteImage(img);
    }
  }
}

/* ---------- 粘贴 ---------- */

async function onPaste(e) {
  if (!active || !current || modalOpen) return;
  const focused = document.activeElement;
  if (
    focused &&
    (focused.tagName === "INPUT" ||
      focused.tagName === "TEXTAREA" ||
      focused.isContentEditable)
  ) {
    return;
  }
  const data = e.clipboardData;
  if (!data) return;
  const files = clipboardFiles(data);
  const imageFile = files.find(
    (file) => file.type.startsWith("image/") || IMAGE_EXTS.has(fileExt(file.name)),
  );
  if (imageFile) {
    e.preventDefault();
    await pasteImage(imageFile);
    return;
  }
  const audioFile = files.find(
    (file) => file.type.startsWith("audio/") || AUDIO_EXTS.has(fileExt(file.name)),
  );
  if (audioFile) {
    e.preventDefault();
    await pasteAudio(audioFile);
    return;
  }
  const text = data.getData("text/plain");
  if (text) {
    e.preventDefault();
    addTextAtPointer(text);
  }
}

function fileExt(name) {
  const clean = String(name || "").split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

function clipboardFiles(data) {
  const files = [...(data.files || [])];
  if (files.length) return files;
  for (const entry of data.items || []) {
    if (entry.kind !== "file") continue;
    const file = entry.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

const AUDIO_MIME_EXT = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "weba",
};

function audioExtFor(file) {
  const ext = fileExt(file.name);
  if (AUDIO_EXTS.has(ext)) return ext;
  return AUDIO_MIME_EXT[(file.type || "").toLowerCase()] || "";
}

function stageCenterWorld() {
  const rect = ui.stage.getBoundingClientRect();
  return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function pastePoint() {
  if (lastPointer.inside) {
    return clientToWorld(lastPointer.x, lastPointer.y);
  }
  return stageCenterWorld();
}

function addTextAtPointer(text) {
  if (!current) return;
  if (editingId) commitEditing();
  const point = pastePoint();
  const item = makeText(point.x, point.y);
  item.text = text;
  current.items.push(item);
  const el = addItemElement(item);
  item.h = el.offsetHeight;
  select(item.id);
  scheduleItemsSave();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function imageSize(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 320, height: 200 });
    image.src = src;
  });
}

/* 四条入口（工具栏的图片/音频/视频/文件按钮 + 资源管理器拖入）都汇到这里：
 * 一批路径先问一次「拷进画布还是只引用」，答案整批通用，取消就一个都不插；
 * 再按扩展名分流——能显示的直接显示，显示不了的才做附件卡片。
 * origin 是拖放落点（多个块顺着它叠开），工具栏入口传 null，各块按自己的大小找落点。 */
async function insertPaths(paths, origin) {
  if (!active || !current || !paths.length) return;
  if (editingId) commitEditing();
  const canvasId = current.meta.id;
  const mode = await askInsertMode(paths.length);
  if (!current || current.meta.id !== canvasId || !mode) return;
  let offset = 0;
  for (const path of paths) {
    const at = origin ? { x: origin.x + offset, y: origin.y + offset } : null;
    const ext = fileExt(path);
    try {
      let placed = null;
      if (IMAGE_EXTS.has(ext)) placed = await addImageBlock(path, at, mode);
      else if (AUDIO_EXTS.has(ext)) placed = await addAudioBlock(path, at, mode);
      else if (VIDEO_EXTS.has(ext)) placed = await addVideoBlock(path, at, mode);
      else if (EBOOK_EXTS.has(ext)) placed = await addEbookBlock(path, at, mode);
      else placed = await addDroppedFile(await store.fileInfo(path), at, mode);
      /* 中途切了画布就别往新画布里插东西 */
      if (!current || current.meta.id !== canvasId) return;
      /* 没插成（失败或用户喊停拷贝）就别跟着叠下一个的位置 */
      if (placed) offset += 24;
    } catch (error) {
      showError(error);
    }
  }
}

/* 工具栏四个按钮都是「开文件框 → 把选中的那一个路径交给统一流程」 */
async function pickAndInsert(pick) {
  if (!active || !current) return;
  const canvasId = current.meta.id;
  try {
    const picked = await pick();
    if (!picked || !current || current.meta.id !== canvasId) return;
    const path = typeof picked === "string" ? picked : picked.path;
    if (!path) return;
    await insertPaths([path]);
  } catch (error) {
    showError(error);
  }
}

function insertImageFromFile() {
  return pickAndInsert(store.pickCanvasImage);
}

function insertAudioFromFile() {
  return pickAndInsert(store.pickCanvasAudio);
}

function insertVideoFromFile() {
  return pickAndInsert(store.pickCanvasVideo);
}

function insertFileFromPicker() {
  return pickAndInsert(store.pickCanvasFile);
}

function baseName(path) {
  return String(path).split(/[\\/]/).pop() || "未命名";
}

/* 图片：两种存在方式都要先拿到显示地址才知道原始比例，量完才定块的大小。
   引用态不拷字节，地址直接指向原图，几百 MB 的扫描件也不会整份进内存。 */
async function addImageBlock(path, point, mode) {
  if (!current) return null;
  const canvasId = current.meta.id;
  const linked = mode === "link";
  const src = linked ? path : await store.importCanvasImage(canvasId, path);
  if (!current || current.meta.id !== canvasId) return null;
  const url = await store.imageUrl(canvasId, src, linked);
  if (!current || current.meta.id !== canvasId) return null;
  const size = await imageSize(url);
  const fit = fitImageSize(size.width, size.height);
  const at = point || insertPoint(fit.w, fit.h);
  imageCache.set(src, url);
  return placeBlock(makeImage(at.x, at.y, fit.w, fit.h, src, linked));
}

/* 音频：播放器按需取地址，插块时不用先读文件。名字记原文件名，播放器上显示。 */
async function addAudioBlock(path, point, mode) {
  if (!current) return null;
  const canvasId = current.meta.id;
  const linked = mode === "link";
  const src = linked ? path : (await store.importCanvasAudio(canvasId, path)).rel;
  if (!current || current.meta.id !== canvasId) return null;
  const at = point || insertPoint(AUDIO_DEFAULT_WIDTH, AUDIO_DEFAULT_HEIGHT);
  return placeBlock(makeAudio(at.x, at.y, baseName(path), src, linked));
}

/* 视频：拷贝走后台进度拷贝（片子动辄几个 G），引用只记原片路径。
   跟图片/音频一样，拷还是引用听上面那一次回答。 */
async function addVideoBlock(path, point, mode) {
  if (!current) return null;
  const canvasId = current.meta.id;
  const info = await store.videoInfo(path);
  if (!current || current.meta.id !== canvasId) return null;
  /* 浏览器不认的容器没有拷贝通道，只能按引用插进来让它自己试 */
  const linked = mode === "link" || !info.known;
  const at = point || insertPoint(VIDEO_DEFAULT_WIDTH, VIDEO_DEFAULT_HEIGHT);
  if (linked) return placeVideo(info, info.path, at, true);
  const rel = await copyIntoCanvas(canvasId, info, "video");
  if (!rel || !current || current.meta.id !== canvasId) return null;
  return placeVideo(info, rel, at, false);
}

function placeVideo(info, src, topLeft, linked) {
  const item = makeVideo(topLeft.x, topLeft.y, info.name, src, linked);
  placeBlock(item);
  return item;
}

/* ---------- 电子书块 ---------- */

/* 先把整本读一遍目录再决定要不要拷：DRM、KF8 这类读不了的在这里当场报错，
   不会先往画布塞一份 20MB 的副本才发现打不开。科目已读到的目录顺手留给阅读块，
   免得刚放上去又解析一遍。 */
async function addEbookBlock(path, point, mode) {
  if (!current) return null;
  const canvasId = current.meta.id;
  const info = await store.ebookInfo(path);
  const file = await store.fileInfo(path);
  if (!current || current.meta.id !== canvasId) return null;
  const linked = mode === "link";
  const at = point || insertPoint(EBOOK_DEFAULT_WIDTH, EBOOK_DEFAULT_HEIGHT);
  let src = path;
  if (!linked) {
    if (file.big) {
      const rel = await copyIntoCanvas(canvasId, file, "file");
      if (!rel || !current || current.meta.id !== canvasId) return null;
      src = rel;
    } else {
      const stored = await store.importCanvasFile(canvasId, path);
      if (!stored || !current || current.meta.id !== canvasId) return null;
      src = stored.rel;
    }
  }
  const item = makeEbook(at.x, at.y, file.name, src, linked);
  ebookTocCache.set(ebookKey(canvasId, item), info);
  placeBlock(item);
  return item;
}

/* ---------- 文件块 ---------- */

/* 插东西之前问一句占不占这份磁盘。一批文件只问一次，答案整批通用。
 * 取消返回 null，这批就都不插。 */
async function askInsertMode(count) {
  const who = count > 1 ? `本批 ${count} 个文件` : "这个文件";
  return choiceDialog({
    title: count > 1 ? `插入 ${count} 个文件` : "插入文件",
    message: `${who}要拷进画布，还是只引用原文件？`,
    note: "拷进来是在磁盘上再存一份，画布自带；只引用不占地方，但原文件挪走或删掉后这里就只剩个占位。",
    options: [
      { value: "copy", label: "拷进画布", hint: "占磁盘，画布自带这份文件" },
      { value: "link", label: "只引用原文件", hint: "不占磁盘，原文件得留在原地" },
    ],
  });
}

/* 图片/音频/视频之外的文件怎么进画布：Markdown 变成一个笔记块，
 * 其它当附件卡片；两种都按 mode 决定拷副本还是记原路径。
 * topLeft 为 null 时按块类型自己的大小找落点（三种块差着量级）。
 * 返回插好的块，一批多个文件时靠它排偏移。 */
async function addDroppedFile(info, topLeft, mode) {
  if (!current) return null;
  const at =
    topLeft ||
    insertPoint(
      info.markdown ? NOTE_DEFAULT_WIDTH : info.text ? FILE_TEXT_WIDTH : FILE_DEFAULT_WIDTH,
      info.markdown
        ? NOTE_DEFAULT_HEIGHT
        : info.text
          ? FILE_TEXT_EXPANDED_HEIGHT
          : FILE_DEFAULT_HEIGHT,
    );
  if (info.markdown) return placeMarkdownFile(info, at, mode);
  return addFileBlock(info, at, mode);
}

/* .md 拷贝态：正文抄进 items.json，之后编辑不再看原文件，原文件删了这块照样能读能改。
 * 引用态：块里只记原文件绝对路径，正文是显示缓存，进画布现读刷新，编辑时问要不要写回。 */
async function placeMarkdownFile(info, topLeft, mode) {
  const canvasId = current.meta.id;
  const file = await store.readFileText(info.path);
  if (!current || current.meta.id !== canvasId) return null;
  const item =
    mode === "link"
      ? makeNote(topLeft.x, topLeft.y, info.path, info.name, file.text, {
          linked: true,
          format: file.format,
          crlf: file.crlf,
        })
      : makeNote(topLeft.x, topLeft.y, "", info.name, file.text);
  placeBlock(item);
  return item;
}

/* 拷贝态一律拷副本进 files/（大文件走后台拷贝报进度），换来的是原文件挪走也不变死链；
 * 引用态什么都不拷，src 直接记原文件绝对路径。 */
async function addFileBlock(info, topLeft, mode) {
  if (!current) return null;
  if (mode === "link") {
    const item = makeFile(topLeft.x, topLeft.y, {
      path: info.path,
      name: info.name,
      size: info.size,
      ext: info.ext,
      text: info.text,
      linked: true,
    });
    placeBlock(item);
    return item;
  }
  const canvasId = current.meta.id;
  let stored = null;
  if (info.big) {
    const rel = await copyIntoCanvas(canvasId, info, "file");
    if (!rel || !current || current.meta.id !== canvasId) return null;
    stored = { rel, name: info.name, size: info.size, ext: info.ext };
  } else {
    stored = await store.importCanvasFile(canvasId, info.path);
    if (!stored || !current || current.meta.id !== canvasId) return null;
  }
  const item = makeFile(topLeft.x, topLeft.y, { ...stored, text: info.text });
  placeBlock(item);
  return item;
}

/* 哪块指向磁盘上的一个文件、以及它在哪儿：笔记的 path 是笔记库里的绝对路径，
   不在画布目录里，所以一律按引用态去定位；其余块的 src 拷贝态是画布内相对路径。 */
function revealTarget(item) {
  if (item.type === "note") return item.path ? { rel: item.path, linked: true } : null;
  if (
    item.type === "image" ||
    item.type === "audio" ||
    item.type === "video" ||
    item.type === "file" ||
    item.type === "ebook"
  ) {
    return item.src ? { rel: item.src, linked: Boolean(item.linked) } : null;
  }
  return null;
}

function revealFileBlock(item) {
  if (!current) return;
  const target = revealTarget(item);
  if (!target) return;
  store
    .revealCanvasFile(current.meta.id, target.rel, target.linked)
    .catch((error) => showError(error));
}

/* ---------- 播不出来时的兜底 ---------- */

/* 探测结果按「画布 + src + 存在方式」留一份：同一块片子反复问 ffmpeg 没意义。 */
const probeCache = new Map();

async function probeVideoBlock(item) {
  if (!current) return null;
  const key = `${current.meta.id}|${item.linked}|${item.src}`;
  if (probeCache.has(key)) return probeCache.get(key);
  let probe = null;
  try {
    probe = await store.probeVideo(current.meta.id, item.src, item.linked);
  } catch {
    /* 探测只是给话术用的，问不出来照样让用户看教程 */
    probe = null;
  }
  probeCache.set(key, probe);
  return probe;
}

async function openVideoProblem(item, reason) {
  if (!current) return;
  const probe = await probeVideoBlock(item);
  /* 别把"这片子本来就没声"当成故障吓用户 */
  if (reason === "audio" && probe?.ok && probe.audioTracks === 0) {
    showError("这条片子没有音轨，转不了。");
    return;
  }
  const action = await openVideoHelp({ reason, probe });
  if (action === "convert") fixVideoAudio(item);
}

/* 转音轨在后台线程跑，进度走 canvas-video-audio 事件，随时能停。
 * 转完只往块上挂一个相对路径，重建播放器就能对声。 */
async function fixVideoAudio(item) {
  if (!current) return;
  if (copyTask || audioFix) {
    showError("正在忙上一个拷贝任务，等它跑完。");
    return;
  }
  const canvasId = current.meta.id;
  try {
    const job = await store.fixVideoAudio(canvasId, item.src, item.linked);
    audioFix = { job, canvasId, item };
    showFixProgress(item.name);
  } catch (error) {
    showError(error);
  }
}

function onAudioFixProgress(payload) {
  if (!payload || !audioFix || payload.job !== audioFix.job) return;
  if (payload.phase === "progress") {
    paintFixProgress(payload.percent);
    return;
  }
  const job = audioFix;
  audioFix = null;
  hideCopyProgress();
  if (payload.phase === "done") {
    finishAudioFix(job.item, payload.rel);
    return;
  }
  if (payload.phase === "cancelled") {
    showError("已停止转换，写到一半的文件删掉了。");
    return;
  }
  showError(payload.error || "转换音轨失败");
}

function finishAudioFix(item, rel) {
  if (!current || !rel || !itemEls.has(item.id)) return;
  item.audioRel = rel;
  videoCache.delete(rel);
  /* 换音轨得重建这块：画面要改吃静音，副本要挂上去，靠旧的 <video> 补不回来 */
  const old = itemEls.get(item.id);
  old?.remove();
  itemEls.delete(item.id);
  addItemElement(item);
  updateSelection();
  scheduleItemsSave();
  showError("音轨转好了，再点播放就有声音。");
}

/* 大文件拷进画布在后台线程跑，进度走 canvas-video-copy 事件，随时能停：
 * 停了后端把 .part 半截文件删掉，画布里不会留下看不懂的残骸。
 * 视频和文件共用这一根进度条，同一时刻只跑一个。 */
function copyIntoCanvas(canvasId, info, kind) {
  if (copyTask) {
    showError(`正在拷贝上一个${copyTask.label}，等它拷完或者先停掉。`);
    return Promise.resolve(null);
  }
  const start = kind === "file" ? store.copyCanvasFile : store.copyCanvasVideo;
  const label = kind === "file" ? "文件" : "视频";
  return start(canvasId, info.path)
    .then(
      (job) =>
        new Promise((resolve) => {
          copyTask = { job, canvasId, resolve, label };
          showCopyProgress(info.name);
        }),
    )
    .catch((error) => {
      showError(error);
      return null;
    });
}

function setupVideoCopyEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  Promise.resolve(
    listen("canvas-video-copy", (event) => onCopyProgress(event?.payload)),
  ).catch(() => {});
  Promise.resolve(
    listen("canvas-video-audio", (event) => onAudioFixProgress(event?.payload)),
  ).catch(() => {});
}

function onCopyProgress(payload) {
  if (!payload || !copyTask || payload.job !== copyTask.job) return;
  const settle = (rel, message) => {
    const job = copyTask;
    copyTask = null;
    hideCopyProgress();
    if (message) showError(message);
    job.resolve(rel);
  };
  if (payload.phase === "done") {
    settle(payload.rel || null);
    return;
  }
  if (payload.phase === "cancelled") {
    settle(null, "已停止拷贝，写到一半的文件删掉了。");
    return;
  }
  if (payload.phase === "error") {
    settle(null, payload.error || `${copyTask.label}拷贝失败`);
    return;
  }
  paintCopyProgress(payload.copied, payload.total);
}

function showCopyProgress(name) {
  ui.copyName.textContent = name;
  ui.copyFill.style.width = "0%";
  ui.copyText.textContent = "开始拷贝…";
  ui.copyCancel.disabled = false;
  ui.copyCancel.textContent = "停止";
  ui.copy.hidden = false;
}

function paintCopyProgress(copied, total) {
  const fraction = total > 0 ? Math.min(1, copied / total) : 0;
  ui.copyFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  ui.copyText.textContent = `${formatSize(copied)} / ${formatSize(total)} · ${Math.round(
    fraction * 100,
  )}%`;
}

function hideCopyProgress() {
  ui.copy.hidden = true;
}

/* 转音轨借用同一根进度条：ffmpeg 只报百分比，报不出字节数。 */
function showFixProgress(name) {
  ui.copyName.textContent = `${name} · 转音轨`;
  ui.copyFill.style.width = "0%";
  ui.copyText.textContent = "开始转换…";
  ui.copyCancel.disabled = false;
  ui.copyCancel.textContent = "停止";
  ui.copy.hidden = false;
}

function paintFixProgress(percent) {
  const fraction = Math.min(1, Math.max(0, Number(percent) || 0));
  ui.copyFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  ui.copyText.textContent = `${Math.round(fraction * 100)}%`;
}

function stemOfPath(path) {
  const name = String(path || "").split(/[\\/]/).pop() || path;
  return name.replace(/\.md$/i, "");
}

function flattenNotes(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.kind === "file") out.push(node);
    else flattenNotes(node.children, out);
  }
  return out;
}

let activePickerClose = null;

/* 命中的片段用 <mark> 包住；文字一律走 textContent，不把用户内容当 HTML 解析 */
function appendHighlighted(target, text, query) {
  const haystack = String(text ?? "");
  const needle = query.trim().toLowerCase();
  if (!needle) {
    target.textContent = haystack;
    return;
  }
  const lower = haystack.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) target.append(document.createTextNode(haystack.slice(from, at)));
    const mark = document.createElement("mark");
    mark.textContent = haystack.slice(at, at + needle.length);
    target.append(mark);
    from = at + needle.length;
  }
  if (from < haystack.length) target.append(document.createTextNode(haystack.slice(from)));
}

/* 便签 / 笔记选择框共用的外壳：搜索框过滤 + 方向键改选中（网格按行列走，走不动就不动）+ 回车插入，
 * Esc、点遮罩、右上角 × 都能取消。
 * entries: [{ search 可搜索文本, value 选中后回传的数据, card(query) => 按钮 }]
 * create: 可选，置顶的「新建」那一项，只在搜索框空着时出现 */
function openPickerShell({ title, hint, placeholder, container, entries, emptyText, create }) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask canvas-picker-mask";
    const dialog = document.createElement("div");
    dialog.className = "dialog canvas-picker";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const head = document.createElement("div");
    head.className = "canvas-picker-head";
    const heading = document.createElement("p");
    heading.className = "dialog-title canvas-picker-title";
    heading.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "canvas-picker-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    head.append(heading, close);

    const search = document.createElement("input");
    search.type = "text";
    search.className = "dialog-input canvas-picker-search";
    search.placeholder = placeholder;
    search.spellcheck = false;
    search.autocomplete = "off";

    const list = document.createElement("div");
    list.className = "canvas-picker-list";
    const results = document.createElement("div");
    results.className = container;
    const empty = document.createElement("p");
    empty.className = "canvas-picker-empty";
    list.append(results, empty);

    const foot = document.createElement("p");
    foot.className = "canvas-picker-hint";
    foot.textContent = hint || "";
    foot.hidden = !hint;

    dialog.append(head, search, list, foot);
    mask.append(dialog);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      if (activePickerClose === cancel) activePickerClose = null;
      resolve(value);
    };
    const cancel = () => finish(null);
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };

    close.addEventListener("click", cancel);
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) cancel();
    });
    document.addEventListener("keydown", onKey, true);
    activePickerClose = cancel;

    let shown = create ? [create, ...entries] : entries;
    let activeIndex = 0;

    const markActive = () => {
      [...results.children].forEach((el, i) => el.classList.toggle("is-active", i === activeIndex));
      results.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    };
    const moveActive = (dx, dy) => {
      /* 便签是一行好几个的网格，笔记是一列：数一下第一行有几张卡就是列数 */
      const first = results.children[0];
      let cols = 0;
      if (first) {
        while (results.children[cols] && results.children[cols].offsetTop === first.offsetTop) cols += 1;
      }
      cols = Math.max(cols, 1);
      const row = Math.floor(activeIndex / cols) + dy;
      const col = (activeIndex % cols) + dx;
      if (row < 0 || col < 0 || col >= cols) return;
      const next = row * cols + col;
      if (next >= shown.length) return;
      activeIndex = next;
      markActive();
    };
    const render = () => {
      const query = search.value;
      const needle = query.trim().toLowerCase();
      const matched = needle
        ? entries.filter((entry) => entry.search.toLowerCase().includes(needle))
        : entries;
      /* 「新建」只在没打字时置顶：一旦打了字，回车该命中搜到的第一条，不是新建 */
      shown = needle || !create ? matched : [create, ...matched];
      results.textContent = "";
      for (const entry of shown) {
        const card = entry.card(query);
        card.addEventListener("click", () => finish(entry.value));
        results.append(card);
      }
      empty.hidden = shown.length > 0;
      empty.textContent = entries.length ? "没有匹配的项，换个关键词试试。" : emptyText;
      activeIndex = 0;
      if (shown.length) markActive();
    };

    search.addEventListener("input", render);
    search.addEventListener("keydown", (e) => {
      const steps = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      if (steps[e.key]) {
        e.preventDefault();
        moveActive(...steps[e.key]);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (shown[activeIndex]) finish(shown[activeIndex].value);
      }
    });

    render();
    document.body.append(mask);
    requestAnimationFrame(() => search.focus({ preventScroll: true }));
  });
}

/* 置顶那张「新建」卡：跟下面的真卡片同款尺寸，虚线描边、只写一句话 */
function createEntry({ cardClass, lines }) {
  return {
    search: "",
    value: { fresh: true },
    card: () => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${cardClass} canvas-picker-create`;
      lines.forEach((text, index) => {
        const span = document.createElement("span");
        span.className = index ? "canvas-picker-create-note" : "canvas-picker-create-label";
        span.textContent = text;
        button.append(span);
      });
      return button;
    },
  };
}

function showStickyPicker(notes) {
  return openPickerShell({
    title: "选择便签",
    hint: "第一项新建一张空白便签；选已有便签会复制到画布，之后编辑不影响原便签。",
    placeholder: "搜索便签内容…",
    container: "canvas-picker-grid",
    emptyText: "还没有便签，直接新建一张就行。",
    create: createEntry({
      cardClass: "canvas-picker-sticky",
      lines: ["新建空白便签", "不进首页便签墙"],
    }),
    entries: notes.map((note) => ({
      search: `${note.title || ""}\n${note.body || ""}`,
      value: note,
      card: (query) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "canvas-picker-sticky";
        button.style.background = note.color || STICKY_DEFAULT_COLOR;
        button.style.color = note.textColor || STICKY_DEFAULT_TEXT;
        const body = document.createElement("span");
        body.className = "canvas-picker-sticky-body";
        if (!note.body) body.classList.add("is-empty");
        appendHighlighted(body, note.body || "空白便签", query);
        button.append(body);
        return button;
      },
    })),
  });
}

function showNotePicker(files) {
  return openPickerShell({
    title: "选择笔记",
    hint: "第一项新建一篇空白笔记；选已有笔记会复制到画布，编辑不会修改原笔记。",
    placeholder: "搜索笔记名或所在文件夹…",
    container: "canvas-picker-notes",
    emptyText: "还没有笔记，直接新建一篇就行。",
    create: createEntry({
      cardClass: "canvas-picker-note",
      lines: ["新建空白笔记", "只在画布上，不写进笔记库"],
    }),
    entries: files.map((node) => {
      const parts = String(node.path || "").split("/");
      const folder = parts.length > 1 ? parts.slice(0, -1).join(" / ") : "根目录";
      return {
        search: parts.join(" "),
        value: node.path,
        card: (query) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "canvas-picker-note";
          const name = document.createElement("span");
          name.className = "canvas-picker-note-name";
          appendHighlighted(name, stemOfPath(node.name), query);
          const parent = document.createElement("span");
          parent.className = "canvas-picker-note-path";
          appendHighlighted(parent, folder, query);
          button.append(name, parent);
          return button;
        },
      };
    }),
  });
}

async function insertStickyFromPicker() {
  if (!active || !current) return;
  if (editingId) commitEditing();
  let notes;
  try {
    notes = await store.listStickyNotes();
  } catch (error) {
    showError(error);
    return;
  }
  if (!current) return;
  modalOpen = true;
  const note = await showStickyPicker(notes);
  modalOpen = false;
  if (!note || !current) return;
  const item = makeSticky(0, 0, note.fresh ? {} : note);
  const at = insertPoint(item.w, item.h);
  item.x = at.x;
  item.y = at.y;
  placeBlock(item);
  /* 新建的那张当场就能打字，省一次双击 */
  if (note.fresh) startStickyEdit(item.id);
}

async function insertNoteFromPicker() {
  if (!active || !current) return;
  if (editingId) commitEditing();
  let tree;
  try {
    tree = await store.listNotes();
  } catch (error) {
    showError(error);
    return;
  }
  if (!current) return;
  modalOpen = true;
  const pick = await showNotePicker(flattenNotes(tree));
  modalOpen = false;
  if (!pick || !current) return;
  const at = insertPoint(NOTE_DEFAULT_WIDTH, NOTE_DEFAULT_HEIGHT);
  /* 空白笔记块：path 和正文都留空，只活在这块画布上，不碰笔记库里任何一个 .md */
  if (pick.fresh) {
    const item = makeNote(at.x, at.y, "", "未命名笔记", "");
    placeBlock(item);
    startNoteEdit(item.id);
    return;
  }
  const path = pick;
  const canvasId = current.meta.id;
  try {
    const source = await store.readNote(path);
    if (!current || current.meta.id !== canvasId) return;
    const item = makeNote(at.x, at.y, path, stemOfPath(path), source);
    item.assets = await snapshotNoteImages(canvasId, item);
    if (!current || current.meta.id !== canvasId) return;
    placeBlock(item);
  } catch (error) {
    showError(error);
  }
}

/* 工具栏和「选文件」插进来的块都落在视野正中，连着插就叠成一坨，看着像没插进去。
   每插一个往右下错开一档；相机一动说明用户重新对准了视野，回到正中从头起算。
   拖入和粘贴不走这里——那是用户指着哪儿就要落哪儿。 */
const INSERT_STEP = 24;
let insertStep = 0;
let insertCam = "";

function insertPoint(w, h) {
  const center = stageCenterWorld();
  const cam = `${current.camera.x},${current.camera.y},${current.camera.scale}`;
  insertStep = cam === insertCam ? insertStep + 1 : 0;
  insertCam = cam;
  const d = insertStep * INSERT_STEP;
  return { x: center.x + d - w / 2, y: center.y + d - h / 2 };
}

function placeBlock(item) {
  if (!current) return null;
  current.items.push(item);
  addItemElement(item);
  select(item.id);
  scheduleItemsSave();
  return item;
}

async function pasteImage(file) {
  if (!current) return;
  try {
    const dataUrl = await fileToDataUrl(file);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    const base64 = dataUrl.slice(comma + 1);
    const subtype = (file.type.split("/")[1] || "png").toLowerCase();
    const ext = subtype === "svg+xml" ? "svg" : subtype.replace("jpeg", "jpg");
    const canvasId = current.meta.id;
    const rel = await store.saveCanvasImage(canvasId, base64, ext);
    if (!current || current.meta.id !== canvasId) return;
    const size = await imageSize(dataUrl);
    const fit = fitImageSize(size.width, size.height);
    const point = pastePoint();
    imageCache.set(rel, dataUrl);
    placeBlock(makeImage(point.x, point.y, fit.w, fit.h, rel));
  } catch (error) {
    showError(error);
  }
}

async function pasteAudio(file) {
  if (!current) return;
  const ext = audioExtFor(file);
  if (!ext) {
    showError("不是支持的音频格式");
    return;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    const base64 = dataUrl.slice(comma + 1);
    const canvasId = current.meta.id;
    const rel = await store.saveCanvasAudio(canvasId, base64, ext);
    if (!current || current.meta.id !== canvasId) return;
    const point = pastePoint();
    audioCache.set(rel, dataUrl);
    placeBlock(makeAudio(point.x, point.y, file.name || "未命名音频", rel));
  } catch (error) {
    showError(error);
  }
}

/* ---------- 从资源管理器拖入 ---------- */

function setupFileDrop() {
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

function pointFromDrop(position) {
  if (!position || !ui) return null;
  const dpr = window.devicePixelRatio || 1;
  const x = position.x / dpr;
  const y = position.y / dpr;
  const rect = ui.stage.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  return clientToWorld(x, y);
}

async function onFilesDropped(paths, position) {
  const point = pointFromDrop(position);
  if (!point || !paths.length) return;
  await insertPaths(paths, point);
}

/* ---------- 键盘 ---------- */

function onKeyDown(e) {
  if (!active || !current || modalOpen) return;
  /* 全屏播放时按键是给影片的：Esc 归浏览器退全屏，Delete 不能顺手把这块删了 */
  if (document.fullscreenElement) return;
  const focused = document.activeElement;
  if (
    focused &&
    (focused.tagName === "INPUT" ||
      focused.tagName === "TEXTAREA" ||
      focused.isContentEditable)
  ) {
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "0") {
    e.preventDefault();
    resetZoom();
    return;
  }
  if (e.key === "Escape") {
    if (tool !== "select") setTool("select");
    else if (selectedId) select(null);
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    e.preventDefault();
    deleteItem(selectedId);
  }
}

/* ---------- 保存与提示 ---------- */

function scheduleItemsSave() {
  if (!current) return;
  clearTimeout(itemsTimer);
  itemsTimer = setTimeout(flushItems, 500);
}

async function flushItems() {
  clearTimeout(itemsTimer);
  itemsTimer = null;
  if (!current) return;
  const id = current.meta.id;
  const payload = JSON.parse(JSON.stringify(current.items));
  try {
    await store.saveCanvasItems(id, payload);
  } catch (error) {
    showError(error);
  }
}

function scheduleCameraSave() {
  if (!current) return;
  clearTimeout(cameraTimer);
  cameraTimer = setTimeout(flushCamera, 400);
}

async function flushCamera() {
  clearTimeout(cameraTimer);
  cameraTimer = null;
  if (!current) return;
  try {
    await store.saveCanvasCamera(current.meta.id, { ...current.camera });
  } catch (error) {
    showError(error);
  }
}

function showError(error) {
  if (!ui) return;
  const message = typeof error === "string" ? error : error?.message || String(error);
  ui.error.textContent = message;
  ui.error.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    ui.error.hidden = true;
  }, 4200);
}
