/* 无限空间。
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
 * 数据落在后端给的空间文件夹里：图元是 items.json，图片在 images/。 */

import { closeColorPicker, openColorPicker } from "./color-picker.js";
import { confirmDialog, choiceDialog, promptDialog, CLOSE_X_SVG } from "./dialog.js";
import { createMarkdownEditor } from "./markdown-editor.js";
import { openMenu, closeMenu } from "./menu.js";
import { renderMarkdown } from "./markdown.js";
import { openVideoHelp } from "./video-help.js";
import * as store from "./canvas-store.js";
import {
  AUDIO_DEFAULT_HEIGHT,
  AUDIO_DEFAULT_WIDTH,
  AUDIO_MIN_HEIGHT,
  AUDIO_MIN_WIDTH,
  CONNECTOR_MAX_POINTS,
  DEFAULT_BORDER,
  EBOOK_DEFAULT_HEIGHT,
  EBOOK_DEFAULT_WIDTH,
  EBOOK_MIN_HEIGHT,
  EBOOK_MIN_WIDTH,
  FILE_MIN_HEIGHT,
  FILE_MIN_WIDTH,
  NOTE_DEFAULT_HEIGHT,
  NOTE_DEFAULT_WIDTH,
  NOTE_MIN_HEIGHT,
  NOTE_MIN_WIDTH,
  STICKY_DEFAULT_COLOR,
  STICKY_DEFAULT_TEXT,
  STICKY_MIN_HEIGHT,
  STICKY_MIN_WIDTH,
  absolutePathOf,
  capturePagePin,
  connectorGeometry,
  connectorLabelPoint,
  createConnectorElement,
  createItemElement,
  fileBlockSize,
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
  newId,
  normalizeConnectorPoints,
  normalizeItem,
  pinConnectorSides,
  pinEbookPage,
  releaseEbookPage,
  renderMissing,
  routeConnectorPreview,
  stretchEbookPage,
  syncConnectorElement,
  syncItemElement,
  TEXT_DEFAULT_RADIUS,
  TEXT_DEFAULT_WIDTH,
  toPersisted,
  VIDEO_DEFAULT_HEIGHT,
  VIDEO_DEFAULT_WIDTH,
  VIDEO_MIN_HEIGHT,
  VIDEO_MIN_WIDTH,
} from "./canvas-items.js";
import { initMinimap, refreshMinimap, blurMinimapFocus, isMinimapFocused } from "./minimap.js";
import { setCosmosCamera, setCosmosSeed } from "./cosmos.js";

const { invoke } = window.__TAURI__.core;

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/* 每次缩放走 2 个百分点：1 点太慢，从 100% 挪到别处要点十几下 */
const ZOOM_STEP = 0.02;
const STORAGE_KEY = "workbench.canvas";
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
/* 每类面板拖角缩放的地板，和 canvas-items 里 normalizeItem 的取值口径一致：
   播放器、附件条这类排版固定的块也能拉角，只是不许拉小到控件看不见 */
const RESIZE_MIN = {
  audio: { w: AUDIO_MIN_WIDTH, h: AUDIO_MIN_HEIGHT },
  file: { w: FILE_MIN_WIDTH, h: FILE_MIN_HEIGHT },
  video: { w: VIDEO_MIN_WIDTH, h: VIDEO_MIN_HEIGHT },
  ebook: { w: EBOOK_MIN_WIDTH, h: EBOOK_MIN_HEIGHT },
  sticky: { w: STICKY_MIN_WIDTH, h: STICKY_MIN_HEIGHT },
  note: { w: NOTE_MIN_WIDTH, h: NOTE_MIN_HEIGHT },
};
const STICKY_BG_PRESETS = ["#bfa648", "#a6bf47", "#47bfb4", "#e5e1d6", "#aab0b5", "#262626"];
const STICKY_TEXT_PRESETS = ["#000000", "#ffffff", "#4c4c4c", "#9e9e9e"];
const NOTE_EDITOR_GUARDS = ".canvas-note-editor, .color-pop, #ctx-menu";
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]);
/* 浏览器能解的容器：不在列表里的也能拖进来，但只能按引用播，交给浏览器试 */
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mkv", "mov"]);
/* Markdown 不当附件看待：拖进来抄成正文，直接变成一个能编辑的笔记块 */
const MARKDOWN_EXTS = new Set(["md", "markdown"]);
/* epub/mobi 能就地在空间上读；azw/azw3 这一版读不了，仍旧按附件收进来 */
const EBOOK_EXTS = new Set(["epub", "mobi"]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let ui = null;
let active = false;
let canvases = [];
let current = null; // { meta, camera, items }
/* 选中的块：平时点选只会有一个，Ctrl 点选往里加/摘，Ctrl+A 全往里倒 */
let selectedIds = new Set();
let editingId = null;
/* 连线中间文字的编辑态 { itemId, el, input, point, original } */
let edgeLabelEditor = null;
let tool = "select";
let drag = null;
let itemEls = new Map();
let imageCache = new Map();
let audioCache = new Map();
/* 视频只缓存 asset 地址（一串字符），不缓存任何字节 */
let videoCache = new Map();
let noteImageCache = new Map();
/* 文本块只读预览：缓存后端解好码的开头一段，切空间就清空重来。
   键带上存在方式，免得同一个路径的拷贝态和引用态串了。 */
let filePreviewCache = new Map();
const previewKey = (item) => `${item.linked ? "L" : "C"}|${item.src}`;
/* PDF 块的 asset 地址：一份文件问后端一次（顺带开的那次读权限也就够了），
   翻页和拖角缩放重画都复用这条地址 */
let pdfUrlCache = new Map();
/* 书的目录进空间只读一次，翻章不用再解析整本；键和预览一样带上存在方式 */
let ebookTocCache = new Map();
const ebookKey = (canvasId, item) => `${canvasId}|${item.linked}|${item.src}`;
let noteEditor = null; // 当前笔记块的编辑态 { itemId, el, box, textarea, editor }
/* 引用态笔记块这一轮编辑是否允许写回原 .md（编辑弹层里选「修改源文件」才是） */
let noteWriteBack = false;
/* 已经弹过「改哪一份」的块，双击连着触发两次不至于叠出两层弹层 */
let noteAskId = null;
/* 音视频块指向的文件找不到了（引用查原片、拷贝查副本）：块留在原地，改成丢文件卡。每次进空间重新查。 */
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
    endpointLayer: document.querySelector("#canvas-endpoint-layer"),
    guideLayer: document.querySelector("#canvas-guide-layer"),
    metrics: document.querySelector("#canvas-metrics"),
    name: document.querySelector("#canvas-name"),
    nameText: document.querySelector("#canvas-name-text"),
    tools: document.querySelector("#canvas-tools"),
    toolButtons: [...document.querySelectorAll(".canvas-tool[data-tool]")],
    insertImage: document.querySelector("#canvas-insert-image"),
    insertAudio: document.querySelector("#canvas-insert-audio"),
    insertVideo: document.querySelector("#canvas-insert-video"),
    insertFile: document.querySelector("#canvas-insert-file"),
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
  /* 插入类按钮不在 toolButtons 里（它们不是一种画图工具），点一下仍然要把
     武装着的工具交回第一个按钮，否则「文字」的蓝会一直留在原地 */
  for (const button of [
    ui.insertImage,
    ui.insertAudio,
    ui.insertVideo,
    ui.insertFile,
    ui.insertNote,
  ]) {
    button.addEventListener("click", dropTool);
  }
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
  ui.insertNote.addEventListener("click", insertNoteFromPicker);

  /* 菜单在 document 上挂了「点外部就收起」（见 menu.js），点击冒泡到那里会把刚弹出的
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
  /* 画面里的按下由 onStagePointerDown 自己判断是起画还是退回；画面外的一切按下
     （缩放、侧栏、菜单、颜色面板…）都算这次操作结束，武装着的工具退回第一个按钮 */
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!active || ui.stage.contains(e.target)) return;
      dropTool();
    },
    true,
  );
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

  /* 端口和选中框都画在块自己身上（见 updatePorts / updateSelection），所以按下事件在 world 这层收 */
  ui.world.addEventListener("pointerdown", startConnect);
  ui.stage.addEventListener("dblclick", onStageDoubleClick);
  ui.stage.addEventListener("contextmenu", onStageContextMenu);
  ui.stage.addEventListener(
    "wheel",
    (e) => {
      if (!active || !current) return;
      /* 全屏看片时滚轮是给影片的，别去动背后空间的缩放 */
      if (document.fullscreenElement) return;
      const rect = ui.stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY === 0) return;
        const step = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, current.camera.scale + step);
        return;
      }
      /* 滚轮落在块的滚动区上就交给块自己滚（不 preventDefault，浏览器原生滚动），滚到头也不动空间 */
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
    if (!handle || !selectedIds.size || !current) return;
    e.preventDefault();
    e.stopPropagation();
    startResize(handle, e);
  };
  ui.world.addEventListener("pointerdown", onHandleDown);
  ui.endpointLayer.addEventListener("pointerdown", onHandleDown);
  ui.endpointLayer.addEventListener("dblclick", onBendHandleDoubleClick);

  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("pointercancel", onWindowPointerUp);

  document.addEventListener("paste", onPaste);
  document.addEventListener("keydown", onKeyDown);
  setupFileDrop();
  setupVideoCopyEvents();
  initMinimap({
    getCamera: () => (current ? current.camera : null),
    getStageSize: () => ({ w: ui.stage.clientWidth, h: ui.stage.clientHeight }),
    getItems: () => (current ? current.items : []),
    getSelectedIds: () => selectedIds,
    setCamera: (x, y) => {
      if (!current) return;
      current.camera.x = x;
      current.camera.y = y;
      applyCamera();
    },
    commitCamera: scheduleCameraSave,
  });

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
  /* 面板已经不显示了还让方向键挪视野，到了别的页面会莫名其妙 */
  blurMinimapFocus();
  pauseMedia();
  /* 全屏壳躲在被隐藏的空间视图里时浏览器不会自己退，切走要手动收，
     不然下一页会被撑到整块屏幕的尺寸 */
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  modalOpen = false;
  activePickerClose?.();
  activePickerClose = null;
  if (editingId || edgeLabelEditor) commitEditing();
  closeColorPicker(true);
  closeMenu();
  void flushBlockContents();
  flushItems();
  flushCamera();
}

/* ---------- 空间列表 / 新建 / 切换 ---------- */

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
  /* 换空间 = 换一块新画幅，上一个空间里武装着的画图工具不该跟着过来 */
  setTool("select");
  if (!current || current.meta.id !== id) {
    if (editingId || edgeLabelEditor) commitEditing();
    await flushBlockContents();
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
    setCosmosSeed(current.meta.id);
    selectedIds = new Set();
    editingId = null;
    noteEditor = null;
    flushFileEditor();
    imageCache = new Map();
    audioCache = new Map();
    videoCache = new Map();
    probeCache.clear();
    noteImageCache = new Map();
    filePreviewCache = new Map();
    pdfUrlCache = new Map();
    ebookTocCache = new Map();
    mediaMissing = new Set();
    await loadImages();
    if (token !== loadToken || !active) return;
    localStorage.setItem(STORAGE_KEY, current.meta.id);
    const staleNotes = await refreshLinkedNotes();
    const brokenContent = await loadBlockContents();
    mediaMissing = await refreshMediaFiles();
    if (token !== loadToken || !active) return;
    renderAll();
    /* 源 .md 读不到的笔记块整块换成丢文件卡，不再拿最后一次缓存的正文糊弄用户 */
    for (const item of staleNotes) {
      renderMissing(itemEls.get(item.id), item, current.meta.path || "");
    }
    /* 自己那份内容文件读不动的便签/笔记同样是丢了，只是丢的是空间目录里的那份 */
    for (const item of brokenContent) {
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

/* 音视频：进空间先问一句文件还在不在——引用态查原片，拷贝态查空间里的副本。
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

/* 音视频都是按需加载的，切空间/离开时把还在响的播放器停掉 */
function pauseMedia() {
  if (!ui || !ui.world) return;
  for (const media of ui.world.querySelectorAll("audio, video")) media.pause();
}

function updateChrome() {
  const hasCanvas = Boolean(current);
  ui.page.classList.toggle("no-canvas", !hasCanvas);
  ui.nameText.textContent = current?.meta.name || "空间";
  ui.empty.hidden = hasCanvas;
  if (!hasCanvas) {
    ui.world.textContent = "";
    ui.edgeTransform.textContent = "";
    previewPath = null;
    itemEls.clear();
    ui.endpointLayer.textContent = "";
    ui.zoomValue.value = "100%";
    refreshMinimap();
  }
}

function showEmpty() {
  pauseMedia();
  if (edgeLabelEditor) finishEdgeLabelEdit(false);
  current = null;
  selectedIds = new Set();
  editingId = null;
  noteEditor = null;
  flushFileEditor();
  imageCache.clear();
  audioCache.clear();
  videoCache.clear();
  noteImageCache.clear();
  filePreviewCache.clear();
  pdfUrlCache.clear();
  ebookTocCache.clear();
  mediaMissing = new Set();
  updateChrome();
  updateMetrics();
}

async function createFlow() {
  const name = await promptDialog({
    title: "新建空间",
    label: "空间名字",
    value: "新空间",
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
    title: "重命名空间",
    label: "空间名字",
    value: current.meta.name,
    okText: "重命名",
  });
  if (!name || name === current.meta.name) return;
  if (editingId || edgeLabelEditor) commitEditing();
  await flushBlockContents();
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
    title: "删除空间",
    message: `「${current.meta.name}」的整个文件夹会被移到系统回收站，之后仍可找回。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  if (editingId || edgeLabelEditor) commitEditing();
  await flushBlockContents();
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
  entries.push({ label: "新建空间", onClick: createFlow });
  if (current) {
    entries.push({ label: "重命名空间", onClick: renameFlow });
    entries.push({ label: "在资源管理器中显示", onClick: revealFlow });
    entries.push({ label: "删除空间", danger: true, onClick: deleteFlow });
  }
  openMenu(rect.left, rect.bottom + 6, entries, { label: "空间" });
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

/* 画图工具是一次性的：这一按（或这一次操作）没能真的起画，就把选中态交回第一个按钮，
   别让蓝点卡在「文字」上。保留当前选中的块，退工具不该顺手把人选的清空。 */
function dropTool() {
  if (tool !== "select") setTool("select", true);
}

function applyCamera() {
  if (!current) return;
  const camera = current.camera;
  ui.world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  /* 选中框、端口、缩放手柄都画在块的坐标系里，乘上这个倒数才在屏幕上保持固定粗细和大小。
     只挂在 world 上：连线端点手柄在 world 外面的屏幕坐标层，本来就不该跟着缩放。 */
  ui.world.style.setProperty("--canvas-inv", String(1 / camera.scale));
  /* 连线层单独一层，靠同一套相机变换跟 world 对齐 */
  ui.edgeTransform.setAttribute(
    "transform",
    `translate(${camera.x} ${camera.y}) scale(${camera.scale})`,
  );
  syncZoomLabel();
  updateSelection();
  positionEdgeLabelEditor();
  setCosmosCamera(camera);
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
    loadPdfUrl: async (block) => {
      const key = previewKey(block);
      const cached = pdfUrlCache.get(key);
      if (cached) return cached;
      const url = await store.fileUrl(canvasId, block.src, block.linked);
      pdfUrlCache.set(key, url);
      return url;
    },
    onPdfPage: () => scheduleItemsSave(),
    canvasDir,
    /* 换成丢文件卡会把块里的内容连选中框一起清空，所以换完补回选中记号 */
    onMissing: (block) => {
      renderMissing(itemEls.get(block.id), block, canvasDir);
      updateSelection();
    },
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
  flushFileEditor();
  itemEls.clear();
  if (!current) return;
  for (const item of current.items) addItemElement(item);
  /* 老数据里的 auto 端在这儿钉一次（元素刚建好，量得到真实尺寸），
     之后挪块就不会再出现「本来接左边，一会儿跑到下边」 */
  let pinned = false;
  for (const item of current.items) {
    if (item.type === "connector" && pinConnectorSides(item, boundsOfItem)) pinned = true;
  }
  if (pinned) refreshConnectors();
  updateSelection();
  refreshMinimap();
}

/* 选中：默认单选（换成只有它）；add=true 是 Ctrl 点选，往集合里加，再点已选中的就摘掉 */
function select(id, add = false) {
  /* 连线不进多选集合：它没有自己的位置，只能单独选中拖两端 */
  if (add && findItem(id)?.type === "connector") add = false;
  if (add && id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  } else if (id) {
    if (selectedIds.size === 1 && selectedIds.has(id)) {
      updateSelection();
      return;
    }
    selectedIds = new Set([id]);
  } else {
    if (!selectedIds.size) {
      updateSelection();
      return;
    }
    selectedIds = new Set();
  }
  syncSelectedClasses();
  updateSelection();
}

/* Ctrl+A：面板、文字、图形都算，连线不进集合——它没有自己的位置，跟着两端的块走 */
function selectAll() {
  selectedIds = new Set(
    current.items.filter((item) => item.type !== "connector").map((item) => item.id),
  );
  syncSelectedClasses();
  updateSelection();
}

function syncSelectedClasses() {
  for (const [itemId, el] of itemEls) {
    el.classList.toggle("is-selected", selectedIds.has(itemId));
  }
}

/* 只选了一个时才有的「那一个」；多选时返回 null，缩放和端口这些单块操作照旧不出现 */
function loneSelected() {
  return selectedIds.size === 1 ? [...selectedIds][0] : null;
}

/* 左下角坐标条：选中谁就报谁左上角的 X/Y，多选取整组的外接框左上角。
   连线没有自己的位置，单独选中它时这条不出现。 */
function updateMetrics() {
  if (!ui?.metrics) return;
  let left = Infinity;
  let top = Infinity;
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (!item || !el || item.type === "connector") continue;
    const bounds = itemBounds(item, el);
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
  }
  const shown = Number.isFinite(left);
  ui.metrics.hidden = !shown;
  if (!shown) return;
  const count = selectedIds.size > 1 ? ` · ${selectedIds.size} 块` : "";
  ui.metrics.textContent = `X ${Math.round(left)} · Y ${Math.round(top)}${count}`;
}

function updateSelection() {
  if (!ui) return;
  refreshConnectors();
  for (const stale of ui.world.querySelectorAll(".canvas-sel-box")) stale.remove();
  ui.endpointLayer.textContent = "";
  updatePorts();
  updateMetrics();
  refreshMinimap();
  if (!selectedIds.size) return;
  /* 四角缩放把手和线的端点拖拽只给「就选了一个」：一堆块同时缩放没意义，把手糊成一片也没法点 */
  const lone = selectedIds.size === 1;
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (item && el) drawSelectionFor(item, el, lone);
  }
}

/* 选中的记号只剩「四边那几个圈」：描边、柔光全都不要了，单选多选一样。
   所以这里只画两类东西：所有块共用的四角隐形把手（单选时），以及线/箭头两头的端点圈。
   面板四边的端口圈由 updatePorts 统一画，不在这里管。 */
function drawSelectionFor(item, el, lone) {
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

  /* 线没有四边端口圈，选中就靠两头那颗圈说话，多选也一样画 */
  if (item.type === "line" || item.type === "arrow") {
    const box = addOverlayBox(el, "canvas-sel-box");
    const bounds = itemBounds(item, el);
    for (const end of ["a", "b"]) {
      const point = end === "a" ? { x: item.x, y: item.y } : { x: item.x2, y: item.y2 };
      const handle = document.createElement("span");
      handle.className = "canvas-handle canvas-handle-point";
      handle.dataset.handle = "endpoint";
      handle.dataset.end = end;
      /* 端点相对包围盒是固定百分比，块怎么缩放挪动都跟得住（水平/竖直线的某条边是 0，落在 0% 正好） */
      handle.style.left = `${((point.x - bounds.x) / Math.max(1, bounds.w)) * 100}%`;
      handle.style.top = `${((point.y - bounds.y) / Math.max(1, bounds.h)) * 100}%`;
      /* 一堆块同时拽两根端点没意义：只有单选那根线的圈能拖 */
      if (!lone) handle.dataset.inert = "1";
      box.append(handle);
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
   不再永远浮在所有块之上。绝对定位按块的 padding box 算，所以把块自己的边框宽度补回去，才贴得住真实外沿。 */
function addOverlayBox(el, className) {
  const box = document.createElement("div");
  box.className = className;
  const style = getComputedStyle(el);
  box.style.inset = [
    -parseFloat(style.borderTopWidth),
    -parseFloat(style.borderRightWidth),
    -parseFloat(style.borderBottomWidth),
    -parseFloat(style.borderLeftWidth),
  ]
    .map((px) => `${px}px`)
    .join(" ");
  el.append(box);
  return box;
}

/* ---------- 指针交互 ---------- */

function onStagePointerDown(e) {
  if (!active || !current) return;
  /* 右键/中键起不成画，武装着的工具也一并退回默认 */
  if (e.button !== 0) {
    dropTool();
    return;
  }
  /* 全屏时画面还挂在原来那个块上，事件会顺着 DOM 冒泡回空间：
     这时点的是影片，不是空间，别去挪那块的位置 */
  if (document.fullscreenElement) {
    dropTool();
    return;
  }
  /* 右下角鸟瞰窗自己管自己的按下（拖视窗/点跳/收起），别当成空间平移 */
  if (e.target.closest?.(".canvas-minimap, .canvas-minimap-key")) {
    dropTool();
    return;
  }
  /* 回到空间上操作，方向键就不再是挪视野 */
  blurMinimapFocus();
  /* 连线文字的输入框自己收指针：选字、挪光标，不是平移空间 */
  if (edgeLabelEditor && e.target === edgeLabelEditor.input) {
    dropTool();
    return;
  }
  const target = e.target.closest?.(".canvas-item, .canvas-connector");

  /* 文本块的编辑框里按下是给输入框的：选字、拖滚动条，不该顺手把这块拖走 */
  if (fileEditor && target?.dataset.id === fileEditor.itemId) {
    dropTool();
    return;
  }

  if (editingId) {
    if (target && target.dataset.id === editingId) {
      dropTool();
      return;
    }
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
  /* 连线没有整条拖动；打开折点后，拖线身才会插一个折点跟着走 */
  if (item.type === "connector") {
    if (!item.bend) return;
    drag = {
      kind: "bend-insert",
      id: item.id,
      start: clientToWorld(e.clientX, e.clientY),
      moved: false,
    };
    return;
  }
  if (editingId === item.id) return;

  const start = clientToWorld(e.clientX, e.clientY);
  drag = {
    kind: "move",
    id: item.id,
    group: moveGroup(),
    start,
    moved: false,
  };
  ui.stage.classList.add("is-moving");
}

/* 这一拖要带上的块：单选就它自己，多选把集合里每个都带上，各记各的起点。
   直线/箭头另记 x2/y2，不然框动了线不动。 */
function moveGroup() {
  const group = [];
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (!item || !el) continue;
    group.push({ item, el, origin: { x: item.x, y: item.y, x2: item.x2, y2: item.y2 } });
  }
  return group;
}

/* 方向键挪位：一次 1px，按住 Shift 走 10px。整组各加同样的偏移；
   直线/箭头连端点一起挪，否则只动起点、线会变形。 */
function nudgeSelected(dx, dy) {
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (!item || !el) continue;
    item.x += dx;
    item.y += dy;
    if (item.type === "line" || item.type === "arrow") {
      item.x2 += dx;
      item.y2 += dy;
    }
    syncItemElement(el, item);
  }
  updateSelection();
  scheduleItemsSave();
}

/* 吸附阈值按屏幕像素给：缩放多少倍手感都一样（6px 在 50% 缩放下等于 12 个世界像素） */
const SNAP_PX = 6;
/* 辅助线比参与对齐的那两块各多画出去一截，好让眼睛找得到 */
const GUIDE_OVERHANG_PX = 24;

/* 拖着的这一组此刻的外接框：位置按各自起点 + 这一帧的偏移算，尺寸取真实渲染值
   （文字块的高度是内容撑出来的，item.h 会过期） */
function dragBounds(group, offsetX, offsetY) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const member of group) {
    const size = itemBounds(member.item, member.el);
    const x = member.origin.x + offsetX;
    const y = member.origin.y + offsetY;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + size.w);
    bottom = Math.max(bottom, y + size.h);
  }
  if (!Number.isFinite(left)) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/* 参照线的来源：别的面板的三条竖线（左边/中线/右边）和三条横线（上边/中线/下边） */
function snapTargets(exclude) {
  const verticals = [];
  const horizontals = [];
  for (const item of current.items) {
    if (item.type === "connector" || exclude.has(item.id)) continue;
    const el = itemEls.get(item.id);
    if (!el) continue;
    const b = itemBounds(item, el);
    verticals.push({ at: b.x, from: b.y, to: b.y + b.h });
    verticals.push({ at: b.x + b.w / 2, from: b.y, to: b.y + b.h });
    verticals.push({ at: b.x + b.w, from: b.y, to: b.y + b.h });
    horizontals.push({ at: b.y, from: b.x, to: b.x + b.w });
    horizontals.push({ at: b.y + b.h / 2, from: b.x, to: b.x + b.w });
    horizontals.push({ at: b.y + b.h, from: b.x, to: b.x + b.w });
  }
  return { verticals, horizontals };
}

/* 各轴独立咬合：X 吸住了 Y 还能自由走。只沿一个轴拖时另一轴不咬。
   返回补正后的偏移和要画的辅助线。 */
function snapOffset(group, offsetX, offsetY, onlyAxis) {
  const bounds = dragBounds(group, offsetX, offsetY);
  if (!bounds) return { dx: offsetX, dy: offsetY, guides: [] };
  const threshold = SNAP_PX / Math.max(0.01, current.camera.scale);
  const exclude = new Set(group.map((member) => member.item.id));
  const targets = snapTargets(exclude);
  const guides = [];

  const pick = (values, lines) => {
    let best = null;
    for (const value of values) {
      for (const line of lines) {
        const delta = line.at - value;
        if (Math.abs(delta) > threshold) continue;
        if (best && Math.abs(best.delta) <= Math.abs(delta)) continue;
        best = { delta, line, edge: value };
      }
    }
    return best;
  };

  let dx = offsetX;
  let dy = offsetY;
  if (onlyAxis !== "y") {
    const best = pick(
      [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w],
      targets.verticals,
    );
    if (best) {
      dx += best.delta;
      guides.push({
        axis: "x",
        at: best.line.at,
        from: Math.min(best.line.from, bounds.y),
        to: Math.max(best.line.to, bounds.y + bounds.h),
      });
    }
  }
  if (onlyAxis !== "x") {
    const best = pick(
      [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h],
      targets.horizontals,
    );
    if (best) {
      dy += best.delta;
      guides.push({
        axis: "y",
        at: best.line.at,
        from: Math.min(best.line.from, bounds.x),
        to: Math.max(best.line.to, bounds.x + bounds.w),
      });
    }
  }
  return { dx, dy, guides };
}

/* 辅助线画在屏幕坐标的顶层：它是拖拽这一下的临时提示，不属于任何一块，
   所以不参与面板之间的层级（同连线端点手柄那个口径）。松手即清。 */
function drawSnapGuides(guides) {
  if (!ui?.guideLayer) return;
  ui.guideLayer.textContent = "";
  for (const guide of guides) {
    const line = document.createElement("div");
    if (guide.axis === "x") {
      const top = worldToStage(guide.at, guide.from);
      const bottom = worldToStage(guide.at, guide.to);
      line.className = "canvas-guide canvas-guide-vertical";
      line.style.left = `${top.x}px`;
      line.style.top = `${Math.min(top.y, bottom.y) - GUIDE_OVERHANG_PX}px`;
      line.style.height = `${Math.abs(bottom.y - top.y) + GUIDE_OVERHANG_PX * 2}px`;
    } else {
      const start = worldToStage(guide.from, guide.at);
      const end = worldToStage(guide.to, guide.at);
      line.className = "canvas-guide canvas-guide-horizontal";
      line.style.top = `${start.y}px`;
      line.style.left = `${Math.min(start.x, end.x) - GUIDE_OVERHANG_PX}px`;
      line.style.width = `${Math.abs(end.x - start.x) + GUIDE_OVERHANG_PX * 2}px`;
    }
    ui.guideLayer.append(line);
  }
}

function startDraw(e) {
  const start = clientToWorld(e.clientX, e.clientY);
  let item = null;
  if (tool === "rect" || tool === "ellipse") item = makeBox(tool, start.x, start.y, start.x, start.y);
  else if (tool === "line" || tool === "arrow") item = makeLine(tool, start.x, start.y, start.x, start.y);
  else if (tool === "text") item = makeText(start.x, start.y, 40);
  if (!item) {
    dropTool();
    return;
  }

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
  /* 手柄只在单选时才画出来，所以这里拿到的必然是那一个 */
  const item = findItem(loneSelected());
  if (!item) return;
  const start = clientToWorld(e.clientX, e.clientY);
  if (handle.dataset.handle === "bend") {
    drag = {
      kind: "bend",
      id: item.id,
      index: Number(handle.dataset.index),
      start,
      moved: false,
    };
    return;
  }
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

  /* 整组挪位：单选就一个成员，多选把选中的都按各自起点平移同样的距离 */
  if (drag.kind === "move") {
    let offsetX = dx;
    let offsetY = dy;
    /* Shift 锁一个轴：只沿此刻走得更远的那条轴动，另一轴钉死 */
    let onlyAxis = null;
    if (e.shiftKey) {
      onlyAxis = Math.abs(offsetX) >= Math.abs(offsetY) ? "x" : "y";
      if (onlyAxis === "x") offsetY = 0;
      else offsetX = 0;
    }
    const snapped = snapOffset(drag.group, offsetX, offsetY, onlyAxis);
    for (const member of drag.group) {
      member.item.x = member.origin.x + snapped.dx;
      member.item.y = member.origin.y + snapped.dy;
      if (member.item.type === "line" || member.item.type === "arrow") {
        member.item.x2 = member.origin.x2 + snapped.dx;
        member.item.y2 = member.origin.y2 + snapped.dy;
      }
      syncItemElement(member.el, member.item);
    }
    drawSnapGuides(snapped.guides);
    /* 选中框和端口本来就长在块自己身上，跟着块一起走；每帧只补算连线、坐标和鸟瞰窗。
       走完整的 updateSelection 会把每个框都拆了重建，一次拖几十块就卡。 */
    refreshConnectors();
    updatePorts();
    updateMetrics();
    refreshMinimap();
    return;
  }

  const item = findItem(drag.id);
  if (!item) return;
  const el = itemEls.get(item.id);
  if (!el) return;

  if (drag.kind === "bend-insert") {
    /* 手一抖不算拖：超过 3px 才真插折点 */
    if (Math.hypot(dx, dy) < 3) return;
    const anchor = nearestPathPoint(el, point);
    const geometry = connectorGeometry(item, boundsOfItem);
    if (!anchor || !geometry) return;
    /* 第一次拖线身：先把当前自动折线的拐点原样收下，插折点那一刻形状不跳；
       曲线没有现成拐点，只能从头排 */
    const points = item.points?.length
      ? [...item.points]
      : item.shape === "curve"
        ? []
        : (geometry.vertices || []).slice(1, -1);
    if (points.length >= CONNECTOR_MAX_POINTS) return;
    const index = bendInsertIndex([geometry.a, ...points, geometry.b], anchor);
    points.splice(index, 0, anchor);
    item.points = points;
    drag.moved = true;
    drag.kind = "bend";
    drag.index = index;
    drag.start = { ...anchor };
    syncConnector(item);
    updateSelection();
    return;
  }

  if (drag.kind === "bend") {
    if (!item.points?.[drag.index]) return;
    item.points[drag.index] = { x: point.x, y: point.y };
    syncConnector(item);
    updateSelection();
    return;
  }

  if (drag.kind === "endpoint") {
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
      if (drag.dir === "n" || drag.dir === "s") {
        /* 上下边拖：以高度为准等比缩放，水平居中，免得图被拉变形 */
        const h = Math.max(8, drag.dir === "n" ? origin.h - dy : origin.h + dy);
        const w = h * drag.aspect;
        item.w = w;
        item.h = h;
        item.x = origin.x + (origin.w - w) / 2;
        item.y = drag.dir === "n" ? origin.y + origin.h - h : origin.y;
      } else {
        const width =
          drag.dir.includes("e") ? origin.w + dx : origin.w - dx;
        const w = Math.max(8, width);
        const h = w / drag.aspect;
        item.w = w;
        item.h = h;
        item.x = drag.dir.includes("w") ? origin.x + origin.w - w : origin.x;
        item.y = drag.dir.includes("n") ? origin.y + origin.h - h : origin.y;
      }
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
      /* 每类面板拖角的地板：拉到这块自己的最小尺寸就不动了 */
      const min = RESIZE_MIN[item.type] || { w: 8, h: 8 };
      if (drag.dir.includes("e")) item.w = Math.max(min.w, origin.w + dx);
      if (drag.dir.includes("w")) {
        const w = Math.max(min.w, origin.w - dx);
        item.x = origin.x + origin.w - w;
        item.w = w;
      }
      if (drag.dir.includes("s")) item.h = Math.max(min.h, origin.h + dy);
      if (drag.dir.includes("n")) {
        const h = Math.max(min.h, origin.h - dy);
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
  drawSnapGuides([]);
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
  if (!item) {
    /* 拖到一半这块没了（切空间/被别处删掉）：手势没有收尾，工具也得自己退回去 */
    dropTool();
    return;
  }

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

  if (!finished.moved) return;
  scheduleItemsSave();
  /* 便签的宽高记在它自己那份 json 里，不写进 items.json */
  if (finished.kind === "resize" && item.type === "sticky") persistSticky(item);
}

/* ---------- 连线交互 ---------- */

/* 端口圈现在兼作选中的记号，所以一次画一批：
   - 选中集合里每块一套「选中态」圈；换到画框/划线工具也照样在，只是不响应拖连线，
     否则选了块一切工具就看不出选了谁。
   - 鼠标悬停但没点中的那块，给现在那种普通空心圈；它已经在集合里就只画选中态，不叠两套。
   - 拖连线途中只跟着光标下那块走（要瞄准具体的边）。 */
function portTargets() {
  if (!current || !active || editingId) return [];
  const out = [];
  const seen = new Set();
  const push = (id, selected) => {
    const item = findItem(id);
    if (!item || !CONNECTABLE.has(item.type) || seen.has(id)) return;
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

function updatePorts() {
  if (!ui?.world) return;
  for (const stale of ui.world.querySelectorAll(".canvas-port-box")) stale.remove();
  for (const target of portTargets()) {
    const item = findItem(target.id);
    const el = itemEls.get(target.id);
    if (!item || !el) continue;
    const box = addOverlayBox(el, "canvas-port-box");
    for (const side of ["top", "right", "bottom", "left"]) {
      const port = document.createElement("span");
      port.className = "canvas-port";
      port.dataset.id = target.id;
      port.dataset.side = side;
      if (target.selected) port.dataset.sel = "1";
      if (target.marksOnly) port.dataset.inert = "1";
      box.append(port);
    }
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
  if (editingId || edgeLabelEditor) commitEditing();
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
   端口圈和别的东西会叠在同一处，所以按整摞命中结果找端口/块 */
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
  /* 接上那一刻就把两条边定死，之后挪块只改走线不改接法 */
  pinConnectorSides(connector, boundsOfItem);
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
  /* 换到新块上的那一端同样当场定死 */
  pinConnectorSides(connector, boundsOfItem);
  syncConnector(connector);
  updateSelection();
  scheduleItemsSave();
}

/* ---------- 连线折点 ---------- */

/* 把指针位置贴到线上最近的一点：拖线身插折点时，折点落在线上而不是凭空跳一下 */
function nearestPathPoint(el, target) {
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

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (!length) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/* 新折点落在哪一段上：按它离哪两个相邻顶点最近来定插入位置 */
function bendInsertIndex(vertices, point) {
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
function onBendHandleDoubleClick(e) {
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
function setConnectorBend(item, on) {
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

function onStageDoubleClick(e) {
  if (!active || !current) return;
  const target = e.target.closest?.(".canvas-item, .canvas-connector");
  if (!target) return;
  const item = findItem(target.dataset.id);
  if (!item) return;
  if (item.type === "connector") {
    e.preventDefault();
    setTool("select", true);
    startEdgeLabelEdit(item.id);
    return;
  }
  if (!["text", "sticky", "note", "file"].includes(item.type)) return;
  /* 非文本的附件没有正文可编，双击仍然什么都不做（找文件走右键「在文件夹中显示」） */
  if (item.type === "file" && !isFileEditable(item)) return;
  e.preventDefault();
  setTool("select", true);
  select(item.id);
  if (item.type === "text") startTextEdit(item.id);
  else if (item.type === "sticky") startStickyEdit(item.id);
  else if (item.type === "note") startNoteEdit(item.id);
  else startFileEdit(item.id);
}

function onStageContextMenu(e) {
  if (!active || !current) return;
  /* 全屏时菜单挂在 body 上，只会渲染全屏子树，弹了也看不见 */
  if (document.fullscreenElement) return;
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
  const target = e.target.closest?.(".canvas-item, .canvas-connector");
  if (!target) {
    openBlankMenu(e.clientX, e.clientY);
    return;
  }
  const item = findItem(target.dataset.id);
  if (!item) return;
  /* 多选里右键其中一块：菜单只给复制和删除，一次作用在整批上；右键集合外的块才退回单选菜单 */
  if (selectedIds.size > 1 && selectedIds.has(item.id)) {
    openMenu(e.clientX, e.clientY, [
      { label: "复制", onClick: () => copyItems([...selectedIds]) },
      { label: "删除", danger: true, onClick: () => deleteItems([...selectedIds]) },
    ]);
    return;
  }
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
    if (item.type === "rect") {
      entries.push({ label: "圆角", onClick: () => openRadiusDialog(item) });
    }
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
    entries.push({ label: "圆角", onClick: () => openRadiusDialog(item) });
  } else if (item.type === "connector") {
    entries.push({
      label: "线条颜色",
      onClick: pick("color"),
      ...connectorValueMark(item, "color"),
    });
    entries.push({
      label: "线型",
      onClick: () => openConnectorShapeMenu(item, x, y),
      ...connectorValueMark(item, "shape"),
    });
    entries.push({
      label: "箭头",
      onClick: () => openConnectorArrowMenu(item, x, y),
      ...connectorValueMark(item, "arrow"),
    });
    entries.push({
      label: item.bend ? "关闭折点" : "打开折点",
      onClick: () => setConnectorBend(item, !item.bend),
    });
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
    entries.push({
      label: "边框颜色",
      onClick: pick("borderColor", { save: () => persistSticky(item) }),
    });
  } else if (item.type === "note") {
    entries.push({ label: "编辑", onClick: () => startNoteEdit(item.id) });
    entries.push({
      label: "边框颜色",
      onClick: pick("borderColor"),
    });
    entries.push({
      label: "背景颜色",
      onClick: pick("fillColor", none),
    });
  } else if (item.type === "file") {
    if (isFileEditable(item)) {
      entries.push({ label: "编辑", onClick: () => startFileEdit(item.id) });
    }
    entries.push({
      label: "边框颜色",
      onClick: pick("borderColor"),
    });
    entries.push({
      label: "背景颜色",
      onClick: pick("fillColor", none),
    });
  }
  /* 属性：便签报类型，媒体和文件类报绝对路径。文字、图形、连线没有「属性」这一行 */
  if (PROP_KIND[item.type]) {
    entries.push({ label: "属性", onClick: () => openItemProps(item) });
  }
  /* 空间不替用户开文件，只把他带到那份文件躺着的地方 */
  if (revealTarget(item)) {
    entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
  }
  /* 连线不复制：它两头挂着块，粘出去无处可接 */
  if (item.type !== "connector") {
    entries.push({ label: "复制", onClick: () => copyItems([item.id]) });
    entries.push({ label: "层级", onClick: () => openLayerMenu(item, x, y) });
  }
  if (entries.length) entries.push("-");
  entries.push({ label: "删除", danger: true, onClick: () => deleteItems([item.id]) });
  openMenu(x, y, entries);
}

/* 属性卡：这块是什么、文件躺在哪儿。便签只报「便签」，媒体和文件类带上绝对路径；
   路径整段可选中、长路径换行显示，不拿省略号把中间藏掉。 */
const PROP_KIND = {
  sticky: "便签",
  note: "笔记",
  image: "图片",
  audio: "音乐",
  video: "视频",
  file: "文件",
  ebook: "电子书",
};

async function openItemProps(item) {
  if (!current || !PROP_KIND[item.type]) return;
  modalOpen = true;
  await showPropsCard(item);
  modalOpen = false;
}

function showPropsCard(item) {
  const path = absolutePathOf(item, current?.meta.path || "");
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog dialog-props" role="dialog" aria-modal="true">
        <p class="dialog-title">属性</p>
        <button class="dialog-close" type="button" aria-label="关闭">${CLOSE_X_SVG}</button>
        <p class="dialog-message props-kind"></p>
        <p class="dialog-message props-path" hidden></p>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    const kindEl = mask.querySelector(".props-kind");
    const pathEl = mask.querySelector(".props-path");
    const closeBtn = mask.querySelector(".dialog-close");
    kindEl.textContent = PROP_KIND[item.type];
    if (path) {
      pathEl.textContent = path;
      pathEl.hidden = false;
    }
    const finish = () => {
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
        finish();
      }
    };
    closeBtn.addEventListener("click", finish);
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) finish();
    });
    document.body.append(mask);
    document.addEventListener("keydown", onKey, true);
    closeBtn.focus({ preventScroll: true });
  });
}

/* 便签文字色 / 背景色：和便签墙用同一套预设；改动只落在空间里的副本上。 */
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
      persistSticky(item);
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
  const entries = [{ label: "新建空间", onClick: createFlow }];
  if (current) {
    /* 刚复制过块才给这一条：空白处右键主要是空间级操作，粘不上去时不摆个死项 */
    if (copiedBlocks) {
      entries.push({ label: "粘贴", onClick: pasteCopiedBlocks });
    }
    entries.push({
      label: "重置视图",
      onClick: () => {
        current.camera = { x: 0, y: 0, scale: 1 };
        applyCamera();
        scheduleCameraSave();
      },
    });
    entries.push({ label: "重命名空间", onClick: renameFlow });
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

/* 圆角按像素填，0 就是直角；CSS 会把超过半边的值自己收住，不用另外夹 */
async function openRadiusDialog(item) {
  const fallback = item.type === "text" ? TEXT_DEFAULT_RADIUS : 0;
  const value = await promptDialog({
    title: item.type === "text" ? "文字圆角" : "矩形圆角",
    label: "圆角半径（px，0 为直角）",
    value: String(Number.isFinite(item.radius) ? item.radius : fallback),
    okText: "设置",
    validate: (text) => (/^\d{1,4}$/.test(text) ? null : "填 0 到 9999 的整数"),
  });
  if (value === null) return;
  item.radius = Number(value);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
}

const CONNECTOR_SHAPES = [
  ["elbow", "折线"],
  ["curve", "曲线"],
];

const CONNECTOR_ARROWS = [
  ["none", "无"],
  ["end", "单向"],
  ["both", "双向"],
];

/* 表示连线属性的图标：统一 22x14、1.9 描边、走 currentColor，三个看起来是一套。
   菜单行尾的「当前值」用这一套；颜色那一格不用 SVG，直接用线自己的颜色画圆点（见 .menu-icon-dot）。 */
const CONNECTOR_ICONS = {
  dot: '<span class="menu-icon-dot"></span>',
  elbow:
    '<svg viewBox="0 0 22 14" width="22" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h6V2h12"/></svg>',
  curve:
    '<svg viewBox="0 0 22 14" width="22" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2 12c6 0 4-10 18-10"/></svg>',
  none:
    '<svg viewBox="0 0 22 14" width="22" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2 7h18"/></svg>',
  end:
    '<svg viewBox="0 0 22 14" width="22" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7h14"/><path d="M13 3.5 18.5 7 13 10.5"/></svg>',
  both:
    '<svg viewBox="0 0 22 14" width="22" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 7h9"/><path d="M6.5 3.5 2 7l4.5 3.5"/><path d="M15.5 3.5 20 7l-4.5 3.5"/></svg>',
};

function openConnectorShapeMenu(item, x, y) {
  const options = CONNECTOR_SHAPES;
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
  const options = CONNECTOR_ARROWS;
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

/* 某一项属性现在是什么：没显式设过的，按渲染用的默认值算 */
function connectorValue(item, prop) {
  if (prop === "color") return item.color || DEFAULT_BORDER;
  const options = prop === "shape" ? CONNECTOR_SHAPES : CONNECTOR_ARROWS;
  const fallback = prop === "shape" ? "elbow" : "end";
  return options.some(([value]) => value === item[prop]) ? item[prop] : fallback;
}

/* 菜单行尾的「当前值」指示：颜色画成线自己的色点，线型/箭头画成对应形状 */
function connectorValueMark(item, prop) {
  const value = connectorValue(item, prop);
  return prop === "color"
    ? { trailing: CONNECTOR_ICONS.dot, color: value }
    : { trailing: CONNECTOR_ICONS[value] };
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

function pickColor(item, prop, x, y, { allowNone = false, noneLabel = "无填充", save } = {}) {
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
      /* 便签的颜色不归 items.json 管，改完要写回它自己那份 json */
      (save || scheduleItemsSave)();
    },
  });
}

function deleteItems(ids) {
  if (!current || !ids.length) return;
  const doomed = new Set(ids);
  /* 删块时，挂在它身上的连线一起删，不留悬空线 */
  for (const item of current.items) {
    if (item.type === "connector" && (doomed.has(item.from.item) || doomed.has(item.to.item))) {
      doomed.add(item.id);
    }
  }
  for (const removeId of doomed) {
    const index = current.items.findIndex((item) => item.id === removeId);
    if (index < 0) continue;
    const [item] = current.items.splice(index, 1);
    if (editingId === removeId) editingId = null;
    const el = itemEls.get(removeId);
    el?.querySelector("audio")?.pause();
    el?.querySelector("video")?.pause();
    removeItemFromDom(removeId);
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
    if (item.type === "sticky") {
      clearTimeout(stickyTimers.get(item.id));
      stickyTimers.delete(item.id);
      store.deleteSticky(current.meta.id, item.id).catch(() => {});
    }
    if (item.type === "note") {
      const prefix = `notes/${item.id}/`;
      for (const key of [...noteImageCache.keys()]) {
        if (key.startsWith(prefix)) noteImageCache.delete(key);
      }
      if (noteEditor?.itemId === item.id) noteEditor = null;
      clearTimeout(noteTimers.get(item.id));
      noteTimers.delete(item.id);
      /* 引用块的原文件不归这里管，删的是空间自己那份 .md */
      if (!item.linked) store.deleteNote(current.meta.id, item.id).catch(() => {});
    }
    /* 拷贝块的副本跟着块一起进回收站；引用块只断链接，原文件在用户手里不动 */
    if (item.type === "file" && item.src) {
      if (fileEditor?.itemId === item.id) flushFileEditor();
      filePreviewCache.delete(previewKey(item));
      store.deleteCanvasFile(current.meta.id, item.src, item.linked).catch(() => {});
    }
    if (item.type === "ebook" && item.src) {
      ebookTocCache.delete(ebookKey(current.meta.id, item));
      store.deleteCanvasFile(current.meta.id, item.src, item.linked).catch(() => {});
    }
  }
  for (const removeId of doomed) selectedIds.delete(removeId);
  updateSelection();
  scheduleItemsSave();
}

function removeItemFromDom(id) {
  const el = itemEls.get(id);
  if (el) el.remove();
  itemEls.delete(id);
}

/* ---------- 连线文字 ----------
   双击连线，在它中间浮出一个输入框就地写；文字本身画在 SVG 里跟着线走。 */

const EDGE_LABEL_FONT = 13;

function startEdgeLabelEdit(id) {
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
  edgeLabelEditor = { itemId: id, el, input, point, original: item.label || "" };
  input.addEventListener("input", sizeEdgeLabelInput);
  input.addEventListener("keydown", onEdgeLabelKeyDown);
  input.addEventListener("blur", commitEdgeLabelEdit);
  positionEdgeLabelEditor();
  input.focus({ preventScroll: true });
  input.select();
}

/* 跟着相机走：编辑中缩放、平移时输入框还钉在连线中间 */
function positionEdgeLabelEditor() {
  if (!edgeLabelEditor || !current) return;
  const camera = current.camera;
  const { input, point } = edgeLabelEditor;
  input.style.left = `${camera.x + point.x * camera.scale}px`;
  input.style.top = `${camera.y + point.y * camera.scale}px`;
  input.style.fontSize = `${Math.max(9, EDGE_LABEL_FONT * camera.scale)}px`;
  sizeEdgeLabelInput();
}

function sizeEdgeLabelInput() {
  if (!edgeLabelEditor) return;
  const { input } = edgeLabelEditor;
  const font = parseFloat(input.style.fontSize) || EDGE_LABEL_FONT;
  input.style.width = `${Math.min(320, Math.max(90, (input.value.length + 2) * font * 0.9))}px`;
}

function onEdgeLabelKeyDown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitEdgeLabelEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    finishEdgeLabelEdit(false);
  }
}

function commitEdgeLabelEdit() {
  finishEdgeLabelEdit(true);
}

function finishEdgeLabelEdit(save) {
  if (!edgeLabelEditor) return;
  const { itemId, el, input, original } = edgeLabelEditor;
  edgeLabelEditor = null;
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

/* ---------- 文字编辑 ---------- */

function startTextEdit(id) {
  if (editingId === id) return;
  if (editingId || edgeLabelEditor) commitEditing();
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "text") return;
  editingId = id;
  select(id);
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
  if (editingId || edgeLabelEditor) commitEditing();
}

function commitEditing() {
  if (edgeLabelEditor) commitEdgeLabelEdit();
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
    deleteItems([id]);
    return;
  }
  updateSelection();
  scheduleItemsSave();
}

/* ---------- 便签块 / 笔记块的内容文件 ----------
   一块一份，住在空间自己目录里：便签 stickies/<块id>.json，笔记 notes/<块id>.md。
   items.json 只留位置和层级，正文不再内嵌。跟数据根顶层那两个旧目录、跟笔记页都脱钩——
   空间上改这张便签，首页那张不动，反过来也一样。 */

const CONTENT_WRITE_DELAY = 400;
let stickyTimers = new Map(); // 块 id -> 还没落盘的写盘定时器
let noteTimers = new Map();

/* 块上那几个运行时字段拼回文件该有的样子（字段口径同首页便签的 json） */
function stickyFileOf(item) {
  return {
    title: "",
    body: item.text || "",
    color: item.color || STICKY_DEFAULT_COLOR,
    textColor: item.textColor || STICKY_DEFAULT_TEXT,
    borderColor: item.borderColor || "",
    width: item.w,
    height: item.h,
  };
}

function applyStickyFile(item, file) {
  item.text = typeof file.body === "string" ? file.body : "";
  item.color = file.color || STICKY_DEFAULT_COLOR;
  item.textColor = file.textColor || STICKY_DEFAULT_TEXT;
  item.borderColor = typeof file.borderColor === "string" ? file.borderColor : "";
  if (Number.isFinite(file.width)) item.w = Math.max(STICKY_MIN_WIDTH, file.width);
  if (Number.isFinite(file.height)) item.h = Math.max(STICKY_MIN_HEIGHT, file.height);
}

function scheduleContentWrite(timers, key, write) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      write();
    }, CONTENT_WRITE_DELAY),
  );
}

/* 打字、改色、拖角都只改块上的字段，落盘统一走这一句；真正的写发生在防抖到点之后 */
function persistSticky(item) {
  if (!current || item.type !== "sticky") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(stickyTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writeSticky(canvasId, item.id, stickyFileOf(target)).catch(showError);
  });
}

function persistNote(item) {
  if (!current || item.type !== "note" || item.linked) return;
  const canvasId = current.meta.id;
  scheduleContentWrite(noteTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target || target.linked) return;
    store.writeNoteText(canvasId, item.id, target.source || "").catch(showError);
  });
}

/* 切空间、重命名、退出页面前把还没写完的正文补上，最后一次编辑不至于丢掉 */
async function flushBlockContents() {
  const canvasId = current?.meta.id;
  const pending = [
    ...[...stickyTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, sticky: true })),
    ...[...noteTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, sticky: false })),
  ];
  stickyTimers.clear();
  noteTimers.clear();
  if (!canvasId) return;
  await Promise.all(
    pending.map(({ timer, itemId, sticky }) => {
      clearTimeout(timer);
      const item = findItem(itemId);
      if (!item) return null;
      return sticky
        ? store.writeSticky(canvasId, itemId, stickyFileOf(item)).catch(showError)
        : store.writeNoteText(canvasId, itemId, item.source || "").catch(showError);
    }),
  );
}

/* 读每块自己的文件当正文；文件还没落过盘的老数据，拿块里残留的正文补写一次。
   读不动的那几块交给丢文件卡，别拿空白糊弄用户。 */
async function loadBlockContents() {
  if (!current) return [];
  const canvasId = current.meta.id;
  const broken = [];
  await Promise.all(
    current.items
      .filter((item) => item.type === "sticky" || (item.type === "note" && !item.linked))
      .map(async (item) => {
        try {
          if (item.type === "sticky") {
            const file = await store.readSticky(canvasId, item.id);
            if (file) applyStickyFile(item, file);
            else await store.writeSticky(canvasId, item.id, stickyFileOf(item));
            return;
          }
          const text = await store.readNoteText(canvasId, item.id);
          if (text === null || text === undefined) {
            await store.writeNoteText(canvasId, item.id, item.source || "");
            return;
          }
          item.source = text;
        } catch {
          broken.push(item);
        }
      }),
  );
  return broken;
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
  if (editingId || edgeLabelEditor) commitEditing();
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "sticky") return;
  editingId = id;
  select(id);
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
  persistSticky(item);
}

function onStickyKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    commitEditing();
  }
}

function onStickyBlur() {
  if (editingId || edgeLabelEditor) commitEditing();
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
  persistSticky(item);
}

/* 笔记块内联编辑器：工具栏、撤销重做、粘贴图片全部复用笔记页那一套。
 * 引用块默认只读——双击先问清楚「改源文件 / 转成空间副本 / 算了」，取消就一个字都不动。 */
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
        title: "请确认编辑对象",
        message: `「${item.name}」引用的是 ${item.path}。这次编辑要改哪一份？`,
        note: "改源文件会把正文直接写回那份 .md；复制进空间则把正文收进块里，原文件不动，之后随便改。",
        options: [
          { value: "write", label: "修改源文件", hint: "直接写回那份 Markdown" },
          { value: "copy", label: "复制进空间", hint: "原文件不动，之后随便改" },
        ],
      });
    } finally {
      noteAskId = null;
    }
    /* 弹层期间可能切了空间 / 关了页面，块早就不存在了 */
    if (!current || current.meta.id !== canvasId || !findItem(id)) return;
    if (!mode) return;
    if (mode === "copy") convertNoteToCopy(item);
    else writeBack = true;
  }

  if (editingId || edgeLabelEditor) commitEditing();
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "note") return;

  noteWriteBack = writeBack;
  editingId = id;
  select(id);
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
      /* 引用块贴图会把空间目录下的相对路径写进用户原文件，那份 .md 挪个窝图就全断了。
         真要贴图就先转成空间副本，图片才跟着块走。 */
      saveImage: async (data, ext) => {
        if (findItem(item.id)?.linked) throw new Error("引用块请先选「复制进空间」再贴图");
        return store.saveCanvasNoteImage(canvasId, item.id, data, ext);
      },
      onChange: (value) => {
        const target = findItem(item.id);
        if (!target) return;
        target.source = value;
        persistNote(target);
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
  persistNote(item);
  /* 选的是「修改源文件」才写盘；后端只认 items.json 里这块自己记着的那条路径 */
  if (writeBack && item.linked) {
    store.writeBackNote(current.meta.id, item.id, draft).catch((error) => {
      showError(error);
      /* 没写进去，界面上那份新正文就是假的：退回编辑前读到的那份，同时把稿子留在
         输入框里重新进入编辑，用户不至于白打一遍 */
      item.source = previous;
      renderNoteBody(item, el);
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

/* 「复制进空间」：正文落到空间自己的 notes/<块id>.md，链接断掉，原 .md 一个字节都不动。
   图片另说——引用期间本来就禁止贴图，块里不会有指向空间目录的图片路径。 */
function convertNoteToCopy(item) {
  item.linked = false;
  item.path = "";
  item.sourceFormat = "utf8";
  item.sourceCrlf = false;
  const el = itemEls.get(item.id);
  el?.querySelector(".canvas-note-badge")?.remove();
  persistNote(item);
}

/* ---------- 文本文件块的就地编辑 ----------
   整份读进来，点别处（失焦）就写回源文件，跟笔记块一个口径。
   覆盖的是用户自己磁盘上的文件，所以写盘前比一次改动基线：编辑期间被外部改过就问一句再动。 */
let fileEditor = null; // { itemId, canvasId, item, el, box, preview, textarea, body, saving, closing, refreshed }
let fileAskId = null;

function isFileEditable(item) {
  return item?.type === "file" && Boolean(item.text) && Boolean(item.src);
}

async function startFileEdit(id) {
  if (!current || fileAskId === id) return;
  if (fileEditor && fileEditor.itemId !== id) {
    /* 一次只开一个编辑框：上一个没存下来就哪儿也不去 */
    if (!(await closeFileEdit())) return;
  }
  if (fileEditor?.itemId === id) {
    if (fileEditor.closing) return;
    fileEditor.textarea.focus({ preventScroll: true });
    return;
  }
  const item = findItem(id);
  if (!isFileEditable(item)) return;

  const canvasId = current.meta.id;
  /* 引用态才有「改哪一份」这一问：拷贝态那份副本就是唯一的一份，问它是假问题 */
  if (item.linked) {
    fileAskId = id;
    modalOpen = true;
    let mode = null;
    try {
      mode = await choiceDialog({
        title: "请确认编辑对象",
        message: `「${item.name}」引用的是 ${item.src}。这次编辑要改哪一份？`,
        note: "改源文件会把整份正文写回那个文件；复制进空间则先把副本收进空间，原文件不动，之后随便改。",
        options: [
          { value: "write", label: "修改源文件", hint: "直接写回那份文本" },
          { value: "copy", label: "复制进空间", hint: "原文件不动，编辑空间里的副本" },
        ],
      });
    } finally {
      modalOpen = false;
      fileAskId = null;
    }
    /* 弹层期间可能切了空间 / 关了页面，块早就不存在了 */
    if (!current || current.meta.id !== canvasId || !findItem(id)) return;
    if (!mode) return;
    if (mode === "copy" && !(await copyFileBlockIntoCanvas(findItem(id)))) return;
  }

  let body;
  try {
    body = await store.readFileBody(current.meta.id, id);
  } catch (error) {
    showError(error);
    return;
  }
  const el = itemEls.get(id);
  if (!current || !isFileEditable(findItem(id)) || !el) return;
  openFileEditor(id, el, body);
}

/* 「复制进空间」：把副本收进 files/，块改指副本，原文件一个字节都不动。 */
async function copyFileBlockIntoCanvas(item) {
  if (!item || !current) return false;
  const canvasId = current.meta.id;
  filePreviewCache.delete(previewKey(item));
  let stored;
  try {
    stored = await store.importCanvasFile(canvasId, item.src);
  } catch (error) {
    showError(error);
    return false;
  }
  if (!current || current.meta.id !== canvasId || !findItem(item.id)) return false;
  item.src = stored.rel;
  item.name = stored.name || item.name;
  item.ext = stored.ext || item.ext;
  item.size = Number(stored.size) || item.size;
  item.linked = false;
  scheduleItemsSave();
  refreshFileBlock(item);
  return true;
}

function openFileEditor(id, el, body) {
  const item = findItem(id);
  const card = el.querySelector(".canvas-file-card");
  const preview = el.querySelector(".canvas-file-preview");
  if (!item || !card || !preview) return;
  const box = document.createElement("div");
  box.className = "canvas-file-editor";
  const textarea = document.createElement("textarea");
  textarea.className = "notes-textarea canvas-file-textarea";
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "文件正文");
  textarea.value = body.text;
  box.append(textarea);
  if (body.encoding && body.encoding !== "UTF-8") {
    const tip = document.createElement("div");
    tip.className = "canvas-file-editor-tip";
    tip.textContent = `这份是 ${body.encoding} 编码，写回时按原样保留`;
    box.prepend(tip);
  }
  card.append(box);
  preview.hidden = true;
  el.classList.add("is-editing");

  const state = {
    itemId: id,
    canvasId: current.meta.id,
    item,
    el,
    box,
    preview,
    textarea,
    body,
    saving: false,
    closing: false,
    refreshed: false,
  };
  fileEditor = state;
  textarea.addEventListener("keydown", onFileEditorKeyDown);
  /* 点哪儿都算收工：只认自己还挂着的那次编辑，免得把后来新开的框顺手关了 */
  textarea.addEventListener("blur", () => {
    if (fileEditor === state) void closeFileEdit();
  });
  select(id);
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(0, 0);
  updateSelection();
}

function onFileEditorKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeFileEdit();
  } else if (e.key === "Tab") {
    /* 代码和配置文件里 Tab 是缩进，不能让它跳去页面上别的控件 */
    e.preventDefault();
    e.target.setRangeText("  ", e.target.selectionStart, e.target.selectionEnd, "end");
  }
}

function fileDraftDirty(state) {
  return state.textarea.value !== state.body.text;
}

async function closeFileEdit() {
  const state = fileEditor;
  if (!state) return true;
  if (state.closing) return false;
  state.closing = true;
  if (fileDraftDirty(state) && !(await persistFileEdit(state))) {
    state.closing = false;
    if (fileEditor === state) state.textarea.focus({ preventScroll: true });
    return false;
  }
  if (fileEditor !== state) return false;
  fileEditor = null;
  closeFileEditorBox(state);
  if (state.refreshed && findItem(state.itemId)) refreshFileBlock(findItem(state.itemId));
  else updateSelection();
  return true;
}

/* 切空间、关页面、重画整个空间、删块：编辑框跟着没了，稿子仍要落盘。
   这几处调用点后面都跟着把整块 DOM 换掉，所以只摘状态、不收尾，写盘在后台跑完。 */
function flushFileEditor() {
  const state = fileEditor;
  if (!state) return;
  fileEditor = null;
  if (fileDraftDirty(state)) void persistFileEdit(state);
}

function closeFileEditorBox(state) {
  state.box.remove();
  state.el.classList.remove("is-editing");
  state.preview.hidden = false;
}

/* 写回源文件。返回 false 表示这次没写成（出错或用户选了不覆盖），调用方据此决定留不留编辑框。 */
async function persistFileEdit(state) {
  if (state.saving) return false;
  const text = state.textarea.value;
  state.saving = true;
  try {
    let result = await store.writeBackCanvasFile(state.canvasId, state.itemId, text, state.body, false);
    if (result?.conflict) {
      modalOpen = true;
      const overwrite = await confirmDialog({
        title: "原文件已经变了",
        message: `「${state.item.name}」在你编辑期间被别的程序改过。要用空间里这份覆盖吗？`,
        okText: "覆盖",
        cancelText: "不覆盖",
        danger: true,
      });
      modalOpen = false;
      if (!overwrite) return false;
      result = await store.writeBackCanvasFile(state.canvasId, state.itemId, text, state.body, true);
    }
    /* 磁盘上的样子已经变了：正文基线和 stamp 都换成刚写进去的这份，
       不然下一次保存会拿过期的 stamp 一路报「被外部改过」 */
    state.body = { ...state.body, text, stamp: result.stamp || "" };
    state.refreshed = true;
    filePreviewCache.delete(previewKey(state.item));
    /* 空间已经切走时不碰 items：那份 items 不再会落盘，改了只会让内存和盘上对不上 */
    if (current?.meta.id === state.canvasId) {
      state.item.size = Number(result.size) || state.item.size;
      scheduleItemsSave();
    }
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    state.saving = false;
  }
}

/* 预览是异步填的，改过盘就要把整块重做一遍，卡片上的体积和正文才跟得上 */
function refreshFileBlock(item) {
  if (!itemEls.has(item.id)) return;
  removeItemFromDom(item.id);
  addItemElement(item);
  updateSelection();
}

/* 引用块的正文只是显示缓存，进空间时现读一次原文件，用户在外面改了也能看到。
 * 读不到就当原文件没了：块和最后一次读到的正文都留着，只把角标换成那句话，
 * 别把整个空间卡在这。返回这些读不到的块，renderAll 之后再改角标。 */
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

/* 把原笔记里的本地图片读出来，复制进空间自己的 notes/<块id>/，返回映射。 */
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

/* ---------- 复制 / 粘贴块 ----------
   Ctrl+C 存下这批块的一份快照（连它来自哪个空间一起记），Ctrl+V 落一批全新的块。
   便签和笔记各带上自己那份 json / .md，拷贝态媒体真再拷一份副本，引用态还是指着同一份原文件；
   连线不复制。同空间落在原块右下方一格，跨空间跟着鼠标落。 */

const BLOCK_CLIPBOARD = "workbench.canvas.blocks";
const PASTE_OFFSET = 24;
const MEDIA_TYPES = new Set(["image", "audio", "video", "file", "ebook"]);
let copiedBlocks = null; // { canvasId, box: {x, y}, blocks: [块快照] }

const coord = (value) => (Number.isFinite(value) ? value : 0);

function selectionBox(items) {
  let left = Infinity;
  let top = Infinity;
  for (const item of items) {
    const b = itemBounds(item);
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
  }
  return { x: Number.isFinite(left) ? left : 0, y: Number.isFinite(top) ? top : 0 };
}

/* 粘出去的块不能跟原块共用同一份文件——删一块会把另一块的副本一起带走，
   指着用户自己原文件的引用块还会让人以为动的是两份东西。
   所以媒体一律真再拷一份，引用态那块粘过来就地转成空间自己的副本。
   返回 false 表示这块落不了地（原文件都找不着），只报错，不摆一块假的上空间。 */
async function landBlock(item, fromId, sourceId) {
  const canvasId = current.meta.id;
  /* 便签的正文由 placeBlock 写成新块自己的 json，这里什么都不用做 */
  if (item.type === "sticky") return true;

  if (item.type === "note") {
    /* 引用外部 .md 的那一块，复制出来是空间里的新副本，不再连着原文件 */
    if (item.linked) {
      item.linked = false;
      item.path = "";
      item.assets = {};
      return true;
    }
    /* 正文和映射里那些 notes/<原块id>/ 的图片路径得跟着换成新块的目录 */
    const swap = (text) => String(text).split(`notes/${sourceId}/`).join(`notes/${item.id}/`);
    item.source = swap(item.source || "");
    item.assets = Object.fromEntries(
      Object.entries(item.assets || {}).map(([raw, rel]) => [swap(raw), swap(rel)]),
    );
    /* 图片目录整个搬过去；搬不动（原块删了）也照样把正文粘上，图自己报缺 */
    await store.duplicateNote(fromId, sourceId, canvasId, item.id).catch(() => {});
    return true;
  }

  if (!MEDIA_TYPES.has(item.type) || !item.src) return true;
  const copied = await store.duplicateMedia(fromId, sourceId, canvasId).catch(showError);
  if (!copied?.rel) return false;
  item.src = copied.rel;
  item.linked = false;
  if (item.type === "video") item.audioRel = copied.audioRel || "";
  if (item.type === "image") {
    /* 图片是建块时直接从缓存取的，不先取一次地址会当场画成丢文件卡 */
    try {
      imageCache.set(item.src, await store.imageUrl(canvasId, item.src, false));
    } catch {
      imageCache.set(item.src, null);
    }
  }
  return true;
}

function copyItems(ids) {
  if (!current || !ids.length) return;
  const picked = new Set(ids);
  const blocks = current.items.filter((item) => picked.has(item.id) && item.type !== "connector");
  if (!blocks.length) return;
  copiedBlocks = {
    canvasId: current.meta.id,
    box: selectionBox(blocks),
    blocks: JSON.parse(JSON.stringify(blocks)),
  };
  /* 后端认的是 items.json 里那条记录：刚建的块还没落盘就先催一次，不然马上复制粘贴会找不着 */
  void flushItems();
  /* 顺手写进系统剪贴板，换个空间、换个窗口也还能粘；写不写得成本地这份照旧能用 */
  navigator.clipboard
    ?.writeText(JSON.stringify({ [BLOCK_CLIPBOARD]: copiedBlocks }))
    ?.catch(() => {});
}

/* 剪贴板里那段 JSON 只在自己这儿认：别家递来的形状不合就一律当普通文字 */
function clipboardBlockPayload(data) {
  const raw = data?.getData?.("text/plain") || "";
  if (!raw.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const payload = parsed?.[BLOCK_CLIPBOARD];
  return payload && Array.isArray(payload.blocks) && payload.blocks.length ? payload : null;
}

async function pasteBlocks(payload) {
  if (!current || !payload?.blocks.length) return;
  if (editingId || edgeLabelEditor) commitEditing();
  const canvasId = current.meta.id;
  const blocks = payload.blocks.filter((raw) => raw && typeof raw === "object");
  /* 同空间右下挪一格，跨空间落在鼠标这儿 */
  const box = selectionBox(blocks.filter((raw) => raw.type !== "connector"));
  const anchor =
    payload.canvasId === canvasId
      ? { x: box.x + PASTE_OFFSET, y: box.y + PASTE_OFFSET }
      : pastePoint();
  const placed = [];
  for (const raw of blocks) {
    /* 拷贝副本那几下是异步的：期间切了空间就别再把块往原来那个空间上摆 */
    if (!current || current.meta.id !== canvasId) return;
    const item = normalizeItem({ ...raw, id: newId(), z: null });
    if (!item || item.type === "connector") continue;
    const dx = coord(raw.x) - box.x;
    const dy = coord(raw.y) - box.y;
    item.x = anchor.x + dx;
    item.y = anchor.y + dy;
    if (item.type === "line" || item.type === "arrow") {
      /* 线段记的是两个端点：整条平移，形状一分不动 */
      item.x2 = item.x + coord(raw.x2) - coord(raw.x);
      item.y2 = item.y + coord(raw.y2) - coord(raw.y);
    }
    if (await landBlock(item, payload.canvasId, raw.id)) placed.push(placeBlock(item));
  }
  if (!placed.length) return;
  selectedIds = new Set(placed.map((item) => item.id));
  syncSelectedClasses();
  updateSelection();
}

function pasteCopiedBlocks() {
  if (!copiedBlocks) return;
  void pasteBlocks(copiedBlocks);
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
  /* 自己刚 Ctrl+C 的那批块：先认这段标记 JSON，再轮到外来的图和文字 */
  const payload = clipboardBlockPayload(data);
  if (payload) {
    e.preventDefault();
    await pasteBlocks(payload);
    return;
  }
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
  if (editingId || edgeLabelEditor) commitEditing();
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
 * 一批路径先问一次「拷进空间还是只引用」，答案整批通用，取消就一个都不插；
 * 再按扩展名分流——能显示的直接显示，显示不了的才做附件卡片。
 * 一次进来好几个就整排铺开（见 batchRowPoint），单个才按入口给的位置落。
 * origin 是拖入的落点：单个文件落在这儿，一批文件在空白空间上也从这儿起排。 */
async function insertPaths(paths, origin) {
  if (!active || !current || !paths.length) return;
  if (editingId || edgeLabelEditor) commitEditing();
  const canvasId = current.meta.id;
  const mode = await askInsertMode(paths.length);
  if (!current || current.meta.id !== canvasId || !mode) return;
  const row = paths.length > 1 ? batchRowPoint(origin) : null;
  let nextX = row ? row.x : 0;
  let firstPlaced = null;
  for (const path of paths) {
    const at = row ? { x: nextX, y: row.y } : origin ? { x: origin.x, y: origin.y } : null;
    const ext = fileExt(path);
    try {
      let placed = null;
      if (IMAGE_EXTS.has(ext)) placed = await addImageBlock(path, at, mode);
      else if (AUDIO_EXTS.has(ext)) placed = await addAudioBlock(path, at, mode);
      else if (VIDEO_EXTS.has(ext)) placed = await addVideoBlock(path, at, mode);
      else if (EBOOK_EXTS.has(ext)) placed = await addEbookBlock(path, at, mode);
      else placed = await addDroppedFile(await store.fileInfo(path), at, mode);
      /* 中途切了空间就别往新空间里插东西 */
      if (!current || current.meta.id !== canvasId) return;
      /* 没插成（失败或用户喊停拷贝）就别跟着排下一个的位置 */
      if (!placed) continue;
      firstPlaced = firstPlaced || placed;
      if (row) nextX += placed.w + BATCH_GAP;
    } catch (error) {
      showError(error);
    }
  }
  revealItem(firstPlaced);
}

/* 插完把视野带到第一个新块那儿，不然空间一大就不知道东西落去了哪里。
   它本来就整个在视野里就不动，免得用户明明看得见还给他跳一下；要挪就把块心对准视野心。 */
function revealItem(item) {
  const bounds = item && (boundsOfItem(item.id) || itemBounds(item, null));
  if (!bounds) return;
  const scale = current.camera.scale;
  const topLeft = worldToStage(bounds.x, bounds.y);
  const margin = 40;
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const alreadyIn =
    topLeft.x >= margin &&
    topLeft.y >= margin &&
    topLeft.x + bounds.w * scale <= vw - margin &&
    topLeft.y + bounds.h * scale <= vh - margin;
  if (alreadyIn) return;
  current.camera.x = vw / 2 - (bounds.x + bounds.w / 2) * scale;
  current.camera.y = vh / 2 - (bounds.y + bounds.h / 2) * scale;
  applyCamera();
  scheduleCameraSave();
}

/* 一批文件的整排落点：左端对齐到空间上最靠左那块，顶边落在最靠下那块的底边再空一档。
   排下一个时按前一块的实际宽度往右走，块与块之间同样空一档，所以混着类型也不会压在一起。
   空间还空着（或只有连线）没有参照，就从拖入落点起排，落点也没有就按视野正中。 */
function batchRowPoint(origin) {
  let left = Infinity;
  let bottom = -Infinity;
  for (const item of current.items) {
    if (item.type === "connector") continue;
    const bounds = boundsOfItem(item.id) || itemBounds(item, null);
    left = Math.min(left, bounds.x);
    bottom = Math.max(bottom, bounds.y + bounds.h);
  }
  if (Number.isFinite(left)) return { x: left, y: bottom + BATCH_GAP };
  const at = origin || stageCenterWorld();
  return { x: at.x, y: at.y };
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
   不会先往空间塞一份 20MB 的副本才发现打不开。科目已读到的目录顺手留给阅读块，
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
    message: `${who}要拷进空间，还是只引用原文件？`,
    note: "拷进来是在磁盘上再存一份，空间自带；只引用不占地方，但原文件挪走或删掉后这里就只剩个占位。",
    options: [
      { value: "copy", label: "拷进空间", hint: "占磁盘，空间自带这份文件" },
      { value: "link", label: "只引用原文件", hint: "不占磁盘，原文件得留在原地" },
    ],
  });
}

/* 图片/音频/视频之外的文件怎么进空间：Markdown 变成一个笔记块，
 * 其它当附件卡片；两种都按 mode 决定拷副本还是记原路径。
 * topLeft 为 null 时按块类型自己的大小找落点（三种块差着量级）。
 * 返回插好的块，一批多个文件时靠它排偏移。 */
async function addDroppedFile(info, topLeft, mode) {
  if (!current) return null;
  const size = info.markdown
    ? { w: NOTE_DEFAULT_WIDTH, h: NOTE_DEFAULT_HEIGHT }
    : fileBlockSize(info);
  const at = topLeft || insertPoint(size.w, size.h);
  if (info.markdown) return placeMarkdownFile(info, at, mode);
  return addFileBlock(info, at, mode);
}

/* .md 拷贝态：正文抄进 items.json，之后编辑不再看原文件，原文件删了这块照样能读能改。
 * 引用态：块里只记原文件绝对路径，正文是显示缓存，进空间现读刷新，编辑时问要不要写回。 */
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
   不在空间目录里，所以一律按引用态去定位；其余块的 src 拷贝态是空间内相对路径。 */
function revealTarget(item) {
  /* 便签和空间自己的笔记：那块的内容文件叫 <块id>.json / <块id>.md，路径后端自己拼 */
  if (item.type === "sticky" || (item.type === "note" && !item.linked)) return { block: true };
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
  /* 便签/笔记那块的文件名就是块 id，空间目录后端知道，前端一个字都不用递 */
  const call = target.block
    ? store.revealBlock(current.meta.id, item.id)
    : store.revealCanvasFile(current.meta.id, target.rel, target.linked);
  call.catch((error) => showError(error));
}

/* ---------- 播不出来时的兜底 ---------- */

/* 探测结果按「空间 + src + 存在方式」留一份：同一块片子反复问 ffmpeg 没意义。 */
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

/* 大文件拷进空间在后台线程跑，进度走 canvas-video-copy 事件，随时能停：
 * 停了后端把 .part 半截文件删掉，空间里不会留下看不懂的残骸。
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
    close.innerHTML = CLOSE_X_SVG;
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

function showNotePicker(files) {
  return openPickerShell({
    title: "选择笔记",
    hint: "第一项新建一篇空白笔记；选已有笔记会复制到空间，编辑不会修改原笔记。",
    placeholder: "搜索笔记名或所在文件夹…",
    container: "canvas-picker-notes",
    emptyText: "还没有笔记，直接新建一篇就行。",
    create: createEntry({
      cardClass: "canvas-picker-note",
      lines: ["新建空白笔记", "只在空间上，不写进笔记库"],
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

async function insertNoteFromPicker() {
  if (!active || !current) return;
  if (editingId || edgeLabelEditor) commitEditing();
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
  /* 空白笔记块：path 和正文都留空，只活在这个空间上，不碰笔记库里任何一个 .md */
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
/* 一批文件铺开时，块与块之间、整排跟已有内容之间的空隙 */
const BATCH_GAP = 24;
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
  /* 便签/笔记从建下来那一刻就有自己那份文件，正文以后只认文件 */
  if (item.type === "sticky") persistSticky(item);
  if (item.type === "note") persistNote(item);
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

/* 方向键挪选中项：一格 1px，Shift 走 10 倍。用世界坐标，缩放看不太清时按几下 Shift 就够了 */
const NUDGE_KEYS = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};
const NUDGE_STEP = 1;

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
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    selectAll();
    return;
  }
  /* Ctrl+C 存这批块的快照；Ctrl+V 走系统粘贴事件（外来内容照旧能粘），Ctrl+D 复制+粘贴一步到位 */
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
    if (!selectedIds.size) return;
    e.preventDefault();
    copyItems([...selectedIds]);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
    if (!selectedIds.size) return;
    e.preventDefault();
    copyItems([...selectedIds]);
    pasteCopiedBlocks();
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

function scheduleItemsSave() {
  if (!current) return;
  clearTimeout(itemsTimer);
  itemsTimer = setTimeout(flushItems, 500);
  /* 块的位置/尺寸/增减都会改鸟瞰窗里的方框，跟着重画一次 */
  refreshMinimap();
}

async function flushItems() {
  clearTimeout(itemsTimer);
  itemsTimer = null;
  if (!current) return;
  const id = current.meta.id;
  const payload = JSON.parse(JSON.stringify(current.items.map(toPersisted)));
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

/* ---------- MCP / agent 动作层 ----------
   菜单、工具栏、拖拽里的动作在这里收成一组不带界面的函数：参数是普通对象，
   返回块摘要或状态。MCP 工具从这里走，和用户点菜单共用同一套落盘与校验。 */

let cameraAnim = null;
const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const agentSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function agentRequireSpace() {
  if (!current) throw new Error("当前没有打开的空间");
  return current;
}

function agentRequireItem(id) {
  const item = findItem(String(id));
  if (!item) throw new Error(`找不到块 ${id}`);
  return item;
}

function agentBounds(item) {
  const bounds = itemBounds(item, itemEls.get(item.id));
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    w: Math.round(bounds.w),
    h: Math.round(bounds.h),
  };
}

/* 给 agent 看的块摘要：几何、样式和内容规模都带上，正文另用专用工具取 */
function agentSummary(item) {
  /* 连线自己没有坐标，包围盒只对块算 */
  const base = { id: item.id, type: item.type, z: Number.isFinite(item.z) ? item.z : null };
  if (item.type !== "connector") Object.assign(base, agentBounds(item));
  if (item.type === "connector") {
    return {
      ...base,
      from: item.from,
      to: item.to,
      shape: item.shape,
      arrow: item.arrow,
      color: item.color,
      label: item.label || "",
      bend: Boolean(item.bend),
      points: (item.points || []).map((point) => ({
        x: Math.round(point.x),
        y: Math.round(point.y),
      })),
    };
  }
  if (item.type === "text") {
    return {
      ...base,
      text: item.text,
      color: item.color,
      fontSize: item.fontSize,
      fillColor: item.fillColor,
      borderColor: item.borderColor,
      bordered: item.bordered,
      radius: item.radius,
    };
  }
  if (item.type === "rect" || item.type === "ellipse") {
    return { ...base, borderColor: item.borderColor, fillColor: item.fillColor, radius: item.radius };
  }
  if (item.type === "line" || item.type === "arrow") {
    return { ...base, x2: item.x2, y2: item.y2, borderColor: item.borderColor };
  }
  if (item.type === "sticky") {
    return { ...base, text: item.text, color: item.color, textColor: item.textColor, borderColor: item.borderColor };
  }
  if (item.type === "note") {
    return {
      ...base,
      name: item.name,
      linked: item.linked,
      path: item.path || "",
      chars: (item.source || "").length,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
    };
  }
  if (item.type === "file") {
    return {
      ...base,
      name: item.name,
      ext: item.ext,
      linked: item.linked,
      src: item.src,
      page: item.page || 1,
      pageFrac: item.pageFrac || 0,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
    };
  }
  if (item.type === "ebook") {
    return { ...base, name: item.name, linked: item.linked, chapter: item.chapter };
  }
  if (item.type === "image") {
    return { ...base, src: item.src, linked: item.linked, borderColor: item.borderColor };
  }
  if (item.type === "audio" || item.type === "video") {
    return { ...base, name: item.name, src: item.src, linked: item.linked };
  }
  return base;
}

/* 演示用的光带：只加一圈外发光，不动块自己的颜色和尺寸 */
function agentHighlight(ids, ms = 900) {
  for (const raw of ids) {
    const id = String(raw);
    const el = itemEls.get(id);
    if (!el) continue;
    el.classList.add("is-agent-target");
    clearTimeout(el.__agentGlow);
    el.__agentGlow = setTimeout(() => el.classList.remove("is-agent-target"), ms);
  }
}

function agentStopCameraAnim() {
  if (!cameraAnim) return;
  cancelAnimationFrame(cameraAnim.raf);
  cameraAnim.cleanup();
  cameraAnim = null;
}

/* 相机移动给用户看：用户自己一碰鼠标或键盘就把镜头还给他，不硬拽 */
function agentAnimateCamera(target, duration = 420) {
  if (!current) return;
  agentStopCameraAnim();
  const start = { ...current.camera };
  const began = performance.now();
  const onUser = () => agentStopCameraAnim();
  window.addEventListener("pointerdown", onUser, true);
  window.addEventListener("keydown", onUser, true);
  const cleanup = () => {
    window.removeEventListener("pointerdown", onUser, true);
    window.removeEventListener("keydown", onUser, true);
  };
  const step = (now) => {
    const t = Math.min(1, (now - began) / duration);
    const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    current.camera.x = start.x + (target.x - start.x) * k;
    current.camera.y = start.y + (target.y - start.y) * k;
    current.camera.scale = start.scale + (target.scale - start.scale) * k;
    applyCamera();
    if (t < 1) {
      cameraAnim = { raf: requestAnimationFrame(step), cleanup };
    } else {
      cleanup();
      cameraAnim = null;
      scheduleCameraSave();
    }
  };
  cameraAnim = { raf: requestAnimationFrame(step), cleanup };
}

function agentCameraState() {
  return current
    ? { x: Math.round(current.camera.x), y: Math.round(current.camera.y), scale: Number(current.camera.scale.toFixed(3)) }
    : null;
}

function agentFocusBlock(id, patch = {}) {
  agentRequireSpace();
  const item = agentRequireItem(id);
  const bounds = agentBounds(item);
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const zoom = patch.zoom == null ? current.camera.scale : clamp(Number(patch.zoom), MIN_SCALE, MAX_SCALE);
  const target = {
    scale: zoom,
    x: vw / 2 - (bounds.x + bounds.w / 2) * zoom,
    y: vh / 2 - (bounds.y + bounds.h / 2) * zoom,
  };
  agentAnimateCamera(target, 360);
  return { camera: agentCameraState() };
}

/* 新块落在视野外时把镜头带过去；本来就在眼前就不动，免得用户明明看得见还给他跳一下 */
function agentRevealBlock(id) {
  const item = findItem(String(id));
  if (!item || item.type === "connector") return false;
  const bounds = agentBounds(item);
  const scale = current.camera.scale;
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const left = bounds.x * scale + current.camera.x;
  const top = bounds.y * scale + current.camera.y;
  const margin = 40;
  const inView =
    left >= margin &&
    top >= margin &&
    left + bounds.w * scale <= vw - margin &&
    top + bounds.h * scale <= vh - margin;
  if (inView) return false;
  agentAnimateCamera(
    {
      scale,
      x: vw / 2 - (bounds.x + bounds.w / 2) * scale,
      y: vh / 2 - (bounds.y + bounds.h / 2) * scale,
    },
    360,
  );
  return true;
}

function agentFitView() {
  agentRequireSpace();
  const blocks = current.items.filter((item) => item.type !== "connector");
  if (!blocks.length) return { camera: agentCameraState() };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of blocks) {
    const bounds = agentBounds(item);
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.w);
    bottom = Math.max(bottom, bounds.y + bounds.h);
  }
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const pad = 80;
  const scale = clamp(Math.min((vw - pad * 2) / w, (vh - pad * 2) / h), MIN_SCALE, MAX_SCALE);
  const target = {
    scale,
    x: vw / 2 - (left + w / 2) * scale,
    y: vh / 2 - (top + h / 2) * scale,
  };
  agentAnimateCamera(target, 480);
  return { camera: { x: Math.round(target.x), y: Math.round(target.y), scale: Number(scale.toFixed(3)) }, bounds: { x: Math.round(left), y: Math.round(top), w: Math.round(w), h: Math.round(h) } };
}

async function agentFindSpace(ref) {
  await loadList();
  const key = String(ref ?? "").trim();
  const target = canvases.find((meta) => meta.id === key || meta.name === key);
  if (!target) throw new Error(`找不到空间「${key}」`);
  return target;
}

async function agentSpaceList() {
  await loadList();
  return {
    current: current ? { id: current.meta.id, name: current.meta.name } : null,
    spaces: canvases.map((meta) => ({ id: meta.id, name: meta.name, path: meta.path || "" })),
  };
}

async function agentOpenSpace(ref) {
  const target = await agentFindSpace(ref);
  if (!active) {
    window.dispatchEvent(new CustomEvent("inspace:route", { detail: "canvas" }));
    await agentSleep(250);
  }
  await switchTo(target.id);
  if (!current || current.meta.id !== target.id) throw new Error(`打开空间「${target.name}」失败`);
  return { space: { id: current.meta.id, name: current.meta.name }, blocks: current.items.length };
}

async function agentCreateSpace(name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("空间名不能为空");
  const data = await store.createCanvas(clean);
  const meta = data?.meta;
  if (!meta) throw new Error("空间建好了，但没拿到它的信息");
  await loadList();
  if (active) await switchTo(meta.id);
  return { id: meta.id, name: meta.name, opened: Boolean(current && current.meta.id === meta.id) };
}

async function agentRenameSpace(ref, newName) {
  const target = await agentFindSpace(ref);
  const clean = String(newName ?? "").trim();
  if (!clean) throw new Error("新名字不能为空");
  const mine = current && current.meta.id === target.id;
  if (mine) {
    if (editingId || edgeLabelEditor) commitEditing();
    await flushBlockContents();
    await flushItems();
    await flushCamera();
    current = null;
  }
  let meta;
  try {
    meta = await store.renameCanvas(target.id, clean);
  } catch (error) {
    /* 改名没成：把刚才放下的空间重新打开，别让界面停在无空间的样子 */
    if (mine) {
      await loadList();
      if (canvases.some((entry) => entry.id === target.id)) await switchTo(target.id);
    }
    throw error;
  }
  await loadList();
  if (mine && meta) await switchTo(meta.id);
  return { id: meta?.id || "", name: meta?.name || clean };
}

async function agentDeleteSpace(ref) {
  const target = await agentFindSpace(ref);
  const mine = current && current.meta.id === target.id;
  if (mine) {
    if (editingId || edgeLabelEditor) commitEditing();
    /* 删除前把防抖里的改动落盘；否则删除之后那些迟到的保存会把旧文件夹又写回来 */
    await flushBlockContents();
    await flushItems();
    await flushCamera();
  }
  await store.deleteCanvas(target.id);
  await loadList();
  if (mine) {
    localStorage.removeItem(STORAGE_KEY);
    current = null;
    selectedIds = new Set();
    renderAll();
    if (canvases[0]) await switchTo(canvases[0].id);
    else showEmpty();
  }
  return { deleted: { id: target.id, name: target.name } };
}

function agentScene(patch = {}) {
  agentRequireSpace();
  const type = patch.type ? String(patch.type) : "";
  const items = current.items.filter((item) => !type || item.type === type);
  return {
    space: { id: current.meta.id, name: current.meta.name },
    camera: agentCameraState(),
    selected: [...selectedIds],
    blocks: items.map(agentSummary),
  };
}

function agentBlock(id) {
  return agentSummary(agentRequireItem(id));
}

/* 不给坐标就落在视野里，连着建会一格格错开（insertPoint 负责） */
function agentPlacePoint(w, h, spec) {
  if (Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y))) {
    return { x: Number(spec.x), y: Number(spec.y) };
  }
  return insertPoint(w, h);
}

async function agentCreateBlock(spec = {}) {
  agentRequireSpace();
  if (editingId || edgeLabelEditor) commitEditing();
  const type = String(spec.type || "").trim();
  const canvasId = current.meta.id;

  if (type === "text") {
    const w = Math.max(40, numOr(spec.w, TEXT_DEFAULT_WIDTH));
    const at = agentPlacePoint(w, 24, spec);
    const item = makeText(at.x, at.y, w);
    item.text = String(spec.text ?? "");
    item.fontSize = clamp(Math.round(numOr(spec.fontSize, item.fontSize)), 8, 200);
    if (spec.borderColor !== undefined) {
      item.borderColor = String(spec.borderColor || "");
      item.bordered = Boolean(item.borderColor);
    }
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (spec.color !== undefined) item.color = String(spec.color || "");
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    const placed = placeBlock(item);
    if (!placed) throw new Error("这块没落进空间");
    return agentSummary(placed);
  }

  if (type === "rect" || type === "ellipse") {
    const w = Math.max(8, numOr(spec.w, 240));
    const h = Math.max(8, numOr(spec.h, 120));
    const at = agentPlacePoint(w, h, spec);
    const item = makeBox(type, at.x, at.y, at.x + w, at.y + h);
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (type === "rect" && spec.radius !== undefined) {
      item.radius = Math.max(0, Math.round(numOr(spec.radius, 0)));
    }
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "line" || type === "arrow") {
    const hasEnds = spec.x2 !== undefined && spec.y2 !== undefined && spec.x !== undefined && spec.y !== undefined;
    const at = agentPlacePoint(200, 1, spec);
    const x1 = hasEnds ? Number(spec.x) : at.x - 100;
    const y1 = hasEnds ? Number(spec.y) : at.y;
    const x2 = hasEnds ? Number(spec.x2) : x1 + 200;
    const y2 = hasEnds ? Number(spec.y2) : y1;
    const item = makeLine(type, x1, y1, x2, y2);
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "sticky") {
    const w = Math.max(STICKY_MIN_WIDTH, numOr(spec.w, 280));
    const h = Math.max(STICKY_MIN_HEIGHT, numOr(spec.h, 280));
    const at = agentPlacePoint(w, h, spec);
    const item = makeSticky(at.x, at.y, String(spec.text ?? ""));
    item.w = w;
    item.h = h;
    if (spec.color) item.color = String(spec.color);
    if (spec.textColor) item.textColor = String(spec.textColor);
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "note") {
    const w = Math.max(NOTE_MIN_WIDTH, numOr(spec.w, NOTE_DEFAULT_WIDTH));
    const h = Math.max(NOTE_MIN_HEIGHT, numOr(spec.h, NOTE_DEFAULT_HEIGHT));
    const at = agentPlacePoint(w, h, spec);
    let markdown = String(spec.markdown ?? "");
    let name = String(spec.name ?? "未命名笔记");
    if (spec.notePath) {
      markdown = await store.readNote(String(spec.notePath));
      if (!current || current.meta.id !== canvasId) throw new Error("读笔记时空间被切走了");
      name = spec.name ? name : String(spec.notePath).split("/").pop().replace(/\.md$/i, "");
    }
    const item = makeNote(at.x, at.y, "", name, markdown);
    item.w = w;
    item.h = h;
    if (spec.notePath) item.assets = await snapshotNoteImages(canvasId, item);
    if (!current || current.meta.id !== canvasId) throw new Error("插笔记时空间被切走了");
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "image" || type === "audio" || type === "video" || type === "file" || type === "ebook") {
    if (!spec.path) throw new Error(`${type} 块需要本机文件路径 path`);
    const placed = await agentImportFile({
      path: String(spec.path),
      mode: spec.mode === "link" ? "link" : "copy",
      as: type,
      x: spec.x,
      y: spec.y,
      fillColor: spec.fillColor,
      borderColor: spec.borderColor,
    });
    return placed;
  }

  if (type === "connector") {
    return agentCreateConnector(spec);
  }

  throw new Error(`不认识的块类型：${type || "(空)"}`);
}

function agentCreateConnector(spec = {}) {
  agentRequireSpace();
  if (editingId || edgeLabelEditor) commitEditing();
  const from = agentRequireItem(spec.from);
  const to = agentRequireItem(spec.to);
  if (from.type === "connector" || to.type === "connector") throw new Error("连线不能接另一条线");
  if (from.id === to.id) throw new Error("连线不能自己连自己");
  const item = makeConnector(from.id, spec.fromSide, to.id);
  if (spec.shape === "curve" || spec.shape === "elbow") item.shape = spec.shape;
  if (spec.arrow === "none" || spec.arrow === "both" || spec.arrow === "end") item.arrow = spec.arrow;
  if (spec.color) item.color = String(spec.color);
  if (spec.label !== undefined) item.label = String(spec.label);
  if (spec.points !== undefined) {
    const points = normalizeConnectorPoints(spec.points);
    if (points.length) {
      item.points = points;
      item.bend = true;
    }
  }
  if (spec.bend === true) item.bend = true;
  current.items.push(item);
  /* 和拖线一样，接上那一刻就把两条边定死 */
  pinConnectorSides(item, boundsOfItem);
  addItemElement(item);
  refreshConnectors();
  select(item.id);
  scheduleItemsSave();
  return agentSummary(item);
}

function agentUpdateConnector(item, patch) {
  let touched = false;
  if (patch.shape === "curve" || patch.shape === "elbow") {
    item.shape = patch.shape;
    touched = true;
  }
  if (patch.arrow === "none" || patch.arrow === "both" || patch.arrow === "end") {
    item.arrow = patch.arrow;
    touched = true;
  }
  if (patch.color !== undefined) {
    item.color = String(patch.color || "");
    const group = itemEls.get(item.id);
    if (group) syncConnectorElement(group, item, connectorGeometry(item, boundsOfItem));
    touched = true;
  }
  if (patch.label !== undefined) {
    item.label = String(patch.label || "");
    touched = true;
  }
  if (patch.bend !== undefined) {
    if (patch.bend) {
      item.bend = true;
    } else {
      delete item.bend;
      delete item.points;
    }
    touched = true;
  }
  if (patch.points !== undefined) {
    const points = normalizeConnectorPoints(patch.points);
    if (points.length) {
      item.points = points;
      item.bend = true;
    } else {
      delete item.points;
    }
    touched = true;
  }
  if (patch.from !== undefined || patch.to !== undefined || patch.fromSide !== undefined) {
    const from = agentRequireItem(patch.from ?? item.from.item);
    const to = agentRequireItem(patch.to ?? item.to.item);
    if (from.type === "connector" || to.type === "connector" || from.id === to.id) {
      throw new Error("连线端点只能是两个不同的块");
    }
    item.from = { item: from.id, side: patch.fromSide || "auto" };
    item.to = { item: to.id, side: "auto" };
    touched = true;
  }
  if (!touched) return agentSummary(item);
  refreshConnectors();
  if (selectedIds.has(item.id)) updateSelection();
  scheduleItemsSave();
  return agentSummary(item);
}

function agentDeleteBlock(id) {
  const item = agentRequireItem(id);
  const summary = agentSummary(item);
  deleteItems([item.id]);
  return summary;
}

async function agentDuplicateBlock(id, patch = {}) {
  agentRequireSpace();
  const source = agentRequireItem(id);
  if (source.type === "connector") throw new Error("连线不复制，直接重新连一条");
  if (editingId || edgeLabelEditor) commitEditing();
  if (source.type === "note" && !source.linked) await flushBlockContents();
  const raw = JSON.parse(JSON.stringify(source));
  const item = normalizeItem({ ...raw, id: newId(), z: null });
  if (!item) throw new Error("这块没法复制");
  const dx = numOr(patch.dx, 24);
  const dy = numOr(patch.dy, 24);
  item.x += dx;
  item.y += dy;
  if (item.type === "line" || item.type === "arrow") {
    item.x2 += dx;
    item.y2 += dy;
  }
  const ok = await landBlock(item, current.meta.id, source.id);
  if (!ok) throw new Error("复制失败：源文件已经不在了");
  const placed = placeBlock(item);
  return agentSummary(placed);
}

function agentSelectBlocks(ids, additive = false) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  for (const id of list) agentRequireItem(id);
  if (additive) {
    for (const id of list) select(id, true);
  } else {
    const onlyConnector = list.length === 1 && findItem(list[0])?.type === "connector";
    selectedIds = new Set(onlyConnector ? list : list.filter((id) => findItem(id)?.type !== "connector"));
    syncSelectedClasses();
    updateSelection();
  }
  return { selected: [...selectedIds] };
}

function agentSetLayer(id, direction) {
  const item = agentRequireItem(id);
  if (item.type === "connector") throw new Error("连线固定在块下面，不参与层级");
  const map = { up: 1, down: -1, top: "top", bottom: "bottom" };
  const dir = map[String(direction)];
  if (dir === undefined) throw new Error("direction 只能是 up / down / top / bottom");
  moveLayer(item, dir);
  return agentSummary(item);
}

function agentUpdateBlock(id, patch = {}) {
  const item = agentRequireItem(id);
  if (item.type === "connector") return agentUpdateConnector(item, patch);
  const el = itemEls.get(item.id);
  let geometry = false;

  if (Number.isFinite(Number(patch.x))) {
    item.x = Number(patch.x);
    geometry = true;
  }
  if (Number.isFinite(Number(patch.y))) {
    item.y = Number(patch.y);
    geometry = true;
  }
  if (item.type !== "text" && patch.w !== undefined) {
    item.w = Math.max(8, numOr(patch.w, item.w));
    geometry = true;
  }
  if (item.type !== "text" && patch.h !== undefined) {
    item.h = Math.max(8, numOr(patch.h, item.h));
    geometry = true;
  }
  if (patch.fontSize !== undefined && item.type === "text") {
    setFontSize(item, clamp(Math.round(numOr(patch.fontSize, item.fontSize)), 8, 200));
  }
  if ((item.type === "line" || item.type === "arrow") && patch.x2 !== undefined && patch.y2 !== undefined) {
    item.x2 = numOr(patch.x2, item.x2);
    item.y2 = numOr(patch.y2, item.y2);
    geometry = true;
  }
  if (patch.radius !== undefined && (item.type === "rect" || item.type === "text")) {
    item.radius = Math.max(0, Math.round(numOr(patch.radius, item.radius)));
  }
  if (patch.borderColor !== undefined) {
    applyColor(item, "borderColor", String(patch.borderColor || ""));
  }
  if (patch.fillColor !== undefined) {
    applyColor(item, "fillColor", String(patch.fillColor || ""));
  }
  if (patch.color !== undefined) {
    applyColor(item, "color", String(patch.color || ""));
  }
  if (patch.textColor !== undefined && item.type === "sticky") {
    item.textColor = String(patch.textColor || STICKY_DEFAULT_TEXT);
    if (el) syncItemElement(el, item);
  }
  if (patch.text !== undefined && item.type === "text") {
    item.text = String(patch.text);
    const body = el?.querySelector(".canvas-text-body");
    if (body) body.textContent = item.text;
    if (el) item.h = el.offsetHeight;
  }
  if (patch.text !== undefined && item.type === "sticky") {
    item.text = String(patch.text);
    const body = el?.querySelector(".canvas-sticky-body");
    if (body) body.textContent = item.text;
  }
  if (patch.markdown !== undefined && item.type === "note") {
    if (item.linked) throw new Error("这是引用外部 .md 的笔记块，写正文请用 note_write_back");
    item.source = String(patch.markdown);
    const body = el?.querySelector(".canvas-note-body");
    if (body) {
      body.innerHTML = renderMarkdown(item.source);
      void hydrateNoteImages(item, el);
    }
    persistNote(item);
  }
  if (el) syncItemElement(el, item);
  if (geometry) {
    updateSelection();
    refreshConnectors();
  }
  scheduleItemsSave();
  if (item.type === "sticky") persistSticky(item);
  if (item.type === "note" && patch.borderColor !== undefined) void persistNote(item);
  return agentSummary(item);
}

/* ---------- 文件 / 便签 / 笔记内容 ---------- */

/* agent 插文件不走弹窗：拷进空间还是引用原文件由调用方直接给 mode。 */
async function agentImportFile(spec = {}) {
  agentRequireSpace();
  if (editingId || edgeLabelEditor) commitEditing();
  const canvasId = current.meta.id;
  const path = String(spec.path || "").trim();
  if (!path) throw new Error("需要文件在本机的路径 path");
  const mode = spec.mode === "link" ? "link" : "copy";
  const point =
    Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y))
      ? { x: Number(spec.x), y: Number(spec.y) }
      : null;
  const ext = fileExt(path);
  const force = String(spec.as || "");
  let placed = null;
  try {
    if (force === "image" || (!force && IMAGE_EXTS.has(ext))) {
      placed = await addImageBlock(path, point, mode);
    } else if (force === "audio" || (!force && AUDIO_EXTS.has(ext))) {
      placed = await addAudioBlock(path, point, mode);
    } else if (force === "video" || (!force && VIDEO_EXTS.has(ext))) {
      placed = await addVideoBlock(path, point, mode);
    } else if (force === "ebook" || (!force && EBOOK_EXTS.has(ext))) {
      placed = await addEbookBlock(path, point, mode);
    } else {
      const info = await store.fileInfo(path);
      if (!current || current.meta.id !== canvasId) throw new Error("导入时空间被切走了");
      if (force === "file") {
        const size = fileBlockSize(info);
        placed = await addFileBlock(info, point || insertPoint(size.w, size.h), mode);
      } else {
        placed = await addDroppedFile(info, point, mode);
      }
    }
  } catch (error) {
    throw new Error(`没能把这份文件放进空间：${error?.message || error}`);
  }
  if (!current || current.meta.id !== canvasId) throw new Error("导入时空间被切走了");
  if (!placed) throw new Error("没能把这份文件放进空间");
  if (spec.borderColor !== undefined) applyColor(placed, "borderColor", String(spec.borderColor || ""));
  if (spec.fillColor !== undefined) applyColor(placed, "fillColor", String(spec.fillColor || ""));
  if (spec.borderColor !== undefined || spec.fillColor !== undefined) scheduleItemsSave();
  agentRevealBlock(placed.id);
  agentHighlight([placed.id], 1400);
  return agentSummary(placed);
}

function agentStickyOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "sticky") throw new Error("这不是便签块");
  return item;
}

function agentStickyRead(id) {
  const item = agentStickyOf(id);
  return { ...agentSummary(item), text: item.text || "" };
}

function agentStickyWrite(id, patch = {}) {
  const item = agentStickyOf(id);
  agentHighlight([item.id]);
  return agentUpdateBlock(item.id, patch);
}

function agentNoteOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "note") throw new Error("这不是笔记块");
  return item;
}

function agentNoteRead(id) {
  const item = agentNoteOf(id);
  return { ...agentSummary(item), markdown: item.source || "" };
}

async function agentNoteWrite(id, text) {
  const item = agentNoteOf(id);
  if (editingId === item.id) commitEditing();
  const body = String(text ?? "");
  const canvasId = current.meta.id;
  if (item.linked) {
    await store.writeBackNote(canvasId, item.id, body);
    if (!current || current.meta.id !== canvasId) throw new Error("写回时空间被切走了");
  } else {
    item.source = body;
    persistNote(item);
  }
  item.source = body;
  const el = itemEls.get(item.id);
  if (el) renderNoteBody(item, el);
  agentHighlight([item.id]);
  return { ...agentSummary(item), markdown: body };
}

async function agentFileOf(id) {
  const item = agentRequireItem(id);
  if (!isFileEditable(item)) throw new Error("这块不是可直接读写正文的文本文件");
  return item;
}

async function agentFileRead(id, maxChars) {
  const item = await agentFileOf(id);
  const canvasId = current.meta.id;
  const body = await store.readFileBody(canvasId, item.id);
  if (!current || current.meta.id !== canvasId) throw new Error("读文件时空间被切走了");
  agentHighlight([item.id]);
  const limit = Math.max(0, Math.trunc(numOr(maxChars, 20000)));
  const full = body.text || "";
  const text = limit && full.length > limit ? full.slice(0, limit) : full;
  return {
    ...agentSummary(item),
    text,
    chars: full.length,
    truncated: text.length < full.length,
    encoding: body.encoding,
  };
}

async function agentFileWrite(id, text, force = false) {
  const item = await agentFileOf(id);
  const canvasId = current.meta.id;
  /* 块里的编辑框开着就先收掉，不然它手上的旧正文会把这次写回盖掉 */
  if (!(await closeFileEdit())) throw new Error("块里的编辑框还开着，先处理那边的保存");
  if (!current || current.meta.id !== canvasId) throw new Error("写文件时空间被切走了");
  const body = await store.readFileBody(canvasId, item.id);
  const next = String(text ?? "");
  const result = await store.writeBackCanvasFile(canvasId, item.id, next, body, Boolean(force));
  if (!current || current.meta.id !== canvasId) throw new Error("写文件时空间被切走了");
  if (result?.conflict) {
    throw new Error("原文件在读取之后被别的程序改过；确认用这份覆盖请再带 force: true 调一次");
  }
  item.size = Number(result?.size) || item.size;
  filePreviewCache.delete(previewKey(item));
  refreshFileBlock(item);
  scheduleItemsSave();
  agentHighlight([item.id]);
  return { ...agentSummary(item), chars: next.length, encoding: body.encoding };
}

function agentRevealFile(id) {
  const item = agentRequireItem(id);
  const target = revealTarget(item);
  if (!target) throw new Error("这块没有对应的磁盘文件");
  const call = target.block
    ? store.revealBlock(current.meta.id, item.id)
    : store.revealCanvasFile(current.meta.id, target.rel, target.linked);
  call.catch(showError);
  agentHighlight([item.id]);
  return agentSummary(item);
}

/* ---------- PDF / 电子书 / 媒体 ---------- */

function agentPdfController(item) {
  return itemEls.get(item.id)?.querySelector(".canvas-file-pdf")?.__agent || null;
}

function agentPdfOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "file" || String(item.ext || "").toLowerCase() !== "pdf") {
    throw new Error("这不是 PDF 块");
  }
  return item;
}

function agentPdfState(id) {
  const item = agentPdfOf(id);
  const ctl = agentPdfController(item);
  const fallback = {
    ready: false,
    total: 0,
    page: Math.trunc(item.page) || 1,
    frac: item.pageFrac || 0,
  };
  const state = ctl ? ctl.state : fallback;
  return { ...agentSummary(item), ...state };
}

function agentPdfGoto(id, page) {
  const item = agentPdfOf(id);
  const ctl = agentPdfController(item);
  if (!ctl) throw new Error("PDF 还没读进来，稍后再试");
  const state = ctl.goto(page);
  agentHighlight([item.id]);
  return { ...agentSummary(item), ...state };
}

function agentEbookController(item) {
  return itemEls.get(item.id)?.querySelector(".canvas-ebook-card")?.__agent || null;
}

function agentEbookOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "ebook") throw new Error("这不是电子书块");
  return item;
}

async function agentEbookToc(id) {
  const item = agentEbookOf(id);
  const ctl = agentEbookController(item);
  if (ctl?.state?.ready) {
    agentHighlight([item.id]);
    return { ...agentSummary(item), ...ctl.state };
  }
  const canvasId = current.meta.id;
  const info = await store.ebookToc(canvasId, item.src, item.linked);
  if (!current || current.meta.id !== canvasId) throw new Error("读目录时空间被切走了");
  agentHighlight([item.id]);
  const chapters = Array.isArray(info?.chapters) ? info.chapters : [];
  return {
    ...agentSummary(item),
    ready: true,
    title: info?.title || item.name,
    total: chapters.length,
    chapter: Math.min(item.chapter || 0, Math.max(0, chapters.length - 1)),
    chapters,
  };
}

async function agentEbookGoto(id, chapter) {
  const item = agentEbookOf(id);
  const ctl = agentEbookController(item);
  if (!ctl) throw new Error("这本书还没读进来，稍后再试");
  const state = await ctl.goto(chapter);
  agentHighlight([item.id]);
  return { ...agentSummary(item), ...state };
}

function agentMediaElement(item) {
  return itemEls.get(item.id)?.querySelector("audio.canvas-audio-element, video.canvas-video-element") || null;
}

function agentMediaOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "audio" && item.type !== "video") throw new Error("这不是音频或视频块");
  return item;
}

function agentMediaState(id) {
  const item = agentMediaOf(id);
  const media = agentMediaElement(item);
  return {
    ...agentSummary(item),
    ready: Boolean(media),
    playing: media ? !media.paused && !media.ended : false,
    time: media ? Number(media.currentTime.toFixed(2)) : 0,
    duration: media && Number.isFinite(media.duration) ? Number(media.duration.toFixed(2)) : 0,
    volume: media ? Number(media.volume.toFixed(2)) : 1,
  };
}

async function agentMediaControl(id, action, value) {
  const item = agentMediaOf(id);
  const media = agentMediaElement(item);
  if (!media) throw new Error("这块媒体还没准备好，稍后再试");
  const act = String(action || "");
  if (act === "play" || act === "toggle") {
    if (act === "play" || media.paused) {
      try {
        await media.play();
      } catch (error) {
        throw new Error(`播放失败：${error?.message || error}`);
      }
    } else {
      media.pause();
    }
  } else if (act === "pause") {
    media.pause();
  } else if (act === "seek") {
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    media.currentTime = clamp(numOr(value, 0), 0, Math.max(0, duration));
  } else if (act === "volume") {
    media.volume = clamp(numOr(value, 1), 0, 1);
  } else {
    throw new Error("action 只能是 play / pause / toggle / seek / volume");
  }
  agentHighlight([item.id]);
  return agentMediaState(item.id);
}

/* ---------- 相机 ---------- */

function agentSetCamera(patch = {}) {
  agentRequireSpace();
  const target = {
    x: numOr(patch.x, current.camera.x),
    y: numOr(patch.y, current.camera.y),
    scale:
      patch.scale == null ? current.camera.scale : clamp(numOr(patch.scale, current.camera.scale), MIN_SCALE, MAX_SCALE),
  };
  if (patch.instant) {
    agentStopCameraAnim();
    current.camera.x = target.x;
    current.camera.y = target.y;
    current.camera.scale = target.scale;
    applyCamera();
    scheduleCameraSave();
  } else {
    agentAnimateCamera(target, 320);
  }
  return { camera: { x: Math.round(target.x), y: Math.round(target.y), scale: Number(target.scale.toFixed(3)) } };
}

/* 回到 100%，视野中心对着原来看着的那一点——和 Ctrl+0 一个意思 */
function agentResetZoom() {
  agentRequireSpace();
  const center = stageCenterWorld();
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const target = { scale: 1, x: vw / 2 - center.x, y: vh / 2 - center.y };
  agentAnimateCamera(target, 320);
  return { camera: { x: Math.round(target.x), y: Math.round(target.y), scale: 1 } };
}

/* ---------- 汇总出口 ---------- */

export const canvasAgent = {
  cameraFit: agentFitView,
  cameraFocus: (id, patch) => {
    const result = agentFocusBlock(id, patch);
    agentHighlight([id]);
    return result;
  },
  cameraGet: () => {
    agentRequireSpace();
    return { camera: agentCameraState() };
  },
  cameraResetZoom: agentResetZoom,
  cameraSet: agentSetCamera,
  scene: agentScene,
  spaceList: agentSpaceList,
  spaceOpen: agentOpenSpace,
  spaceCreate: agentCreateSpace,
  spaceRename: agentRenameSpace,
  spaceDelete: agentDeleteSpace,
  blockGet: agentBlock,
  blockCreate: async (spec) => {
    const placed = await agentCreateBlock(spec);
    agentRevealBlock(placed.id);
    agentHighlight([placed.id], 1200);
    return placed;
  },
  blockUpdate: (id, patch) => {
    const result = agentUpdateBlock(id, patch);
    agentHighlight([id]);
    return result;
  },
  blockDelete: agentDeleteBlock,
  blockDuplicate: async (id, patch) => {
    const placed = await agentDuplicateBlock(id, patch);
    agentRevealBlock(placed.id);
    agentHighlight([placed.id], 1200);
    return placed;
  },
  blockSelect: agentSelectBlocks,
  blockLayer: (id, direction) => {
    const result = agentSetLayer(id, direction);
    agentHighlight([id]);
    return result;
  },
  blockReveal: (id) => {
    const item = agentRequireItem(id);
    const moved = agentRevealBlock(item.id);
    agentHighlight([item.id]);
    return { ...agentSummary(item), moved };
  },
  blockHighlight: (ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).map(String);
    for (const id of list) agentRequireItem(id);
    agentHighlight(list, 1600);
    return { highlighted: list };
  },
  connectorCreate: agentCreateConnector,
  connectorUpdate: (id, patch) => agentUpdateBlock(id, patch),
  importFile: agentImportFile,
  stickyRead: agentStickyRead,
  stickyWrite: agentStickyWrite,
  noteRead: agentNoteRead,
  noteWrite: agentNoteWrite,
  fileRead: agentFileRead,
  fileWrite: agentFileWrite,
  fileReveal: agentRevealFile,
  pdfState: agentPdfState,
  pdfGoto: agentPdfGoto,
  ebookToc: agentEbookToc,
  ebookGoto: agentEbookGoto,
  mediaState: agentMediaState,
  mediaControl: agentMediaControl,
};
