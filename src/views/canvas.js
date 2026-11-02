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
import { confirmDialog, choiceDialog, promptDialog, progressDialog, CLOSE_X_SVG } from "./dialog.js";
import { createMarkdownEditor } from "./markdown-editor.js";
import { openMenu, closeMenu, isMenuOpen } from "./menu.js";
import { renderMarkdown } from "./markdown.js";
import { disposeScene, setSceneCameraScale } from "./scene3d.js";
import {
  dropGenRun,
  genBusyId,
  genRunOf,
  isGenBusy,
  patchGenRun,
  syncGen,
} from "./genpanel.js";
import { openVideoHelp } from "./video-help.js";
import { createHistory } from "./history.js";
import { createExporter, QUALITY, DEFAULT_QUALITY } from "./export.js";
import * as store from "./canvas-store.js";
import {
  AUDIO_DEFAULT_HEIGHT,
  AUDIO_DEFAULT_WIDTH,
  AUDIO_MIN_HEIGHT,
  AUDIO_MIN_WIDTH,
  BORDER_DEFAULT_WIDTH,
  BORDER_MAX_WIDTH,
  CONNECTOR_MAX_POINTS,
  EBOOK_DEFAULT_HEIGHT,
  EBOOK_DEFAULT_WIDTH,
  EBOOK_MIN_HEIGHT,
  EBOOK_MIN_WIDTH,
  GEN_CFG_MAX,
  GEN_CFG_MIN,
  GEN_DEFAULT_HEIGHT,
  GEN_DEFAULT_WIDTH,
  GEN_MIN_HEIGHT,
  GEN_MIN_WIDTH,
  GEN_STEPS_MAX,
  GEN_STEPS_MIN,
  GEN_TEXT_MAX,
  FILE_MIN_HEIGHT,
  FILE_MIN_WIDTH,
  NOTE_DEFAULT_HEIGHT,
  NOTE_DEFAULT_WIDTH,
  NOTE_MIN_HEIGHT,
  NOTE_MIN_WIDTH,
  PICTURE_DEFAULT_HEIGHT,
  PICTURE_DEFAULT_WIDTH,
  PICTURE_ERASER_TOLERANCE,
  PICTURE_MAX_CMDS,
  PICTURE_MAX_EXPANDED,
  PICTURE_MIN_HEIGHT,
  PICTURE_MIN_WIDTH,
  PICTURE_STROKE_MIN_STEP,
  PICTURE_STROKE_WIDTH_MAX,
  PICTURE_STROKE_WIDTH_MIN,
  SCENE_DEFAULT_HEIGHT,
  SCENE_DEFAULT_WIDTH,
  SCENE_MIN_HEIGHT,
  SCENE_MIN_WIDTH,
  STICKY_DEFAULT_COLOR,
  STICKY_DEFAULT_TEXT,
  STICKY_MIN_HEIGHT,
  STICKY_MIN_WIDTH,
  absolutePathOf,
  capturePagePin,
  collectPictureImageSrcs,
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
  makeGen,
  makeImage,
  makeLine,
  makeNote,
  makePicture,
  makeScene,
  makeSticky,
  makeText,
  makeVideo,
  newId,
  normalizeConnectorPoints,
  normalizeHidden,
  normalizeItem,
  normalizeLight,
  normalizePictureCmd,
  normalizePictureCmds,
  normalizePictureSymbols,
  normalizeSceneCamera,
  normalizeSceneParts,
  pictureCmdHit,
  pictureImageSrc,
  pictureLayerCensus,
  pictureTopLayers,
  pinConnectorSides,
  pinEbookPage,
  remapPictureImageSrcs,
  releaseEbookPage,
  renderMissing,
  renderPictureCmd,
  routeConnectorPreview,
  setPictureMedia,
  snapGenSize,
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
  videoControlOf,
} from "./canvas-items.js";
import { initMinimap, refreshMinimap, blurMinimapFocus, isMinimapFocused } from "./minimap.js";
import { initSearch } from "./search.js";
import { openNote } from "./notes.js";
import { setCosmosCamera, setCosmosSeed } from "./cosmos.js";

const { invoke } = window.__TAURI__.core;

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/* 每次缩放走 2 个百分点：1 点太慢，从 100% 挪到别处要点十几下 */
const ZOOM_STEP = 0.02;
/* 长按缩放键：先走一步，按住超过这段才开始连发，之后按这个节拍继续走 */
const ZOOM_HOLD_DELAY = 340;
const ZOOM_HOLD_INTERVAL = 60;
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
  picture: { w: PICTURE_MIN_WIDTH, h: PICTURE_MIN_HEIGHT },
  scene: { w: SCENE_MIN_WIDTH, h: SCENE_MIN_HEIGHT },
  gen: { w: GEN_MIN_WIDTH, h: GEN_MIN_HEIGHT },
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
/* 画面块里垫的那张位图，渲染层只认 src，要能显示的地址得回来这张表拿。
   切空间时 imageCache 整个换掉，所以塞的是一个现查的函数、不是那张表本身。 */
setPictureMedia((src) => imageCache.get(src) || "");
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
let docxUrlCache = new Map();
let xlsxUrlCache = new Map();
let pptxUrlCache = new Map();
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

/* ---------- 撤销 / 重做 ----------
   快照就是这一屏的所有块，含便签正文和笔记正文（它们平时另存一份文件，
   但撤销要能把这些内容一起还回来，所以内存里这份是完整的）。
   画面的绘制指令是唯一的例外：它不进快照，见 captureHistory。 */

function captureHistory() {
  if (!current) return "";
  try {
    /* 手绘一笔就上百个点，80 份全量快照会把内存吃穿，所以把 cmds 摘出去。
       笔画的撤销由那块画面自己管一层栈（见 pictureHistory）；
       全局撤销管的是这块的位置、尺寸、边框和纸色。
       场景块里的东西（parts）同一个道理：一件的底面就有一圈坐标点。 */
    return JSON.stringify(current.items, (key, value) =>
      (key === "cmds" || key === "parts") && Array.isArray(value) ? undefined : value,
    );
  } catch {
    return "";
  }
}

function applyHistory(snap) {
  if (!current || !snap) return;
  let raw;
  try {
    raw = JSON.parse(snap);
  } catch {
    return;
  }
  /* 回放前先把正在编辑的正文收掉，不然输入框还指着已经不存在的块 */
  if (editingId || edgeLabelEditor) commitEditing();
  pauseMedia();
  noteEditor = null;
  current.items = sanitizeItems(raw);
  /* 快照里没有画面的指令、也没有场景里的那堆东西（见 captureHistory），回放完从旁表接回去：
     撤一次块的位置，不该顺手把用户画过的笔画、摆过的东西一起抹了 */
  for (const item of current.items) {
    if (item.type === "picture") {
      const held = pictureCmdBank.get(item.id);
      if (held) item.cmds = held;
      const bank = pictureSymbolBank.get(item.id);
      if (bank) item.symbols = bank;
    } else if (item.type === "scene") {
      const held = scenePartsBank.get(item.id);
      if (held) item.parts = held;
    } else if (item.type === "gen") {
      /* 提示词和参数在快照里有、在 items.json 里没有：撤销完把这块自己那份文件追平，
         不然重开空间看到的是撤销之前写的那句 */
      persistGen(item);
    }
  }
  for (const id of [...selectedIds]) if (!findItem(id)) selectedIds.delete(id);
  const needImages = current.items.some((item) => {
    if (item.type === "image") return Boolean(item.src) && !imageCache.get(item.src);
    if (item.type === "picture") {
      return collectPictureImageSrcs(item.cmds, item.symbols).some((one) => !imageCache.get(one.src));
    }
    return false;
  });
  renderAll();
  syncSelectedClasses();
  updateSelection();
  updateChrome();
  refreshMinimap();
  scheduleItemsSave();
  /* 便签和笔记的正文平时落在各自文件里，撤销回来的块要把文件也补上，
     否则下一次打开这个空间就只剩个空壳 */
  for (const item of current.items) {
    if (item.type === "sticky") persistSticky(item);
    else if (item.type === "note" && !item.linked) persistNote(item);
  }
  if (needImages) {
    /* 撤销回来的图片块可能还没在缓存里（那边刚被删过）：补一次地址再就地换图，
       整屏不重排，免得把用户正在做的事打断 */
    void loadImages().then(() => {
      if (!current) return;
      for (const item of current.items) {
        /* 画面里垫的图：地址刚补回来，那块画面得整幅重画一次，虚线占位框才换成真图。
           没垫图的块不碰——九百多条指令那一幅重画一次不便宜。 */
        if (item.type === "picture") {
          if (!collectPictureImageSrcs(item.cmds, item.symbols).length) continue;
          const el = itemEls.get(item.id);
          if (el) syncItemElement(el, item);
          continue;
        }
        if (item.type !== "image" || !item.src) continue;
        const url = imageCache.get(item.src);
        if (!url) continue;
        const el = itemEls.get(item.id);
        if (!el) continue;
        const img = el.querySelector("img.canvas-image");
        if (img) {
          if (img.getAttribute("src") !== url) img.src = url;
          continue;
        }
        /* 刚才按「丢文件」画的空卡片：整块重画一次 */
        removeItemFromDom(item.id);
        addItemElement(item);
      }
      updateSelection();
    });
  }
}

const history = createHistory({
  capture: captureHistory,
  apply: applyHistory,
  onChange: () => syncHistoryButtons(),
});

function syncHistoryButtons() {
  if (!ui) return;
  const state = historyState();
  if (ui.undo) ui.undo.disabled = !state.canUndo;
  if (ui.redo) ui.redo.disabled = !state.canRedo;
}

/* 按钮的可用态跟栈走；history 自己不知道界面长什么样，这里现问一次 */
function historyState() {
  let canUndo = false;
  let canRedo = false;
  try {
    canUndo = history.canUndo;
    canRedo = history.canRedo;
  } catch {
    /* 还没 reset 过 */
  }
  return { canUndo, canRedo };
}

function undoHistory() {
  if (history.busy) return;
  if (editingId || edgeLabelEditor) {
    /* 正文还在编辑：第一次 Ctrl+Z 先退出编辑态，别直接回滚一整步 */
    commitEditing();
    return;
  }
  history.undo();
}

function redoHistory() {
  if (history.busy) return;
  if (editingId || edgeLabelEditor) {
    commitEditing();
    return;
  }
  history.redo();
}

/* 删块时文件先不回收：这一笔还能被撤销，文件得留着。
   真正执行推迟到这条记录被挤出撤销栈的时候（见 history.js）。
   万一那一刻这份文件又被别的块引用上了（撤销之后又做了新动作），跳过。 */
function deferFileDelete(canvasId, stillUsed, action) {
  history.addCleanup(() => {
    if (current && current.meta.id === canvasId && stillUsed()) return;
    action();
  });
}

/* ---------- 导出 ---------- */

const exporter = createExporter({
  getItems: () => (current ? current.items : []),
  getWorld: () => ui.world,
  getEdgeG: () => ui.edgeTransform,
  getBounds: (item) => {
    const el = itemEls.get(item.id);
    return el ? itemBounds(item, el) : null;
  },
  getMeta: () => current?.meta || {},
  getStage: () => ui.stage,
  /* 用户此刻看到的这一屏，换算成世界坐标的矩形 */
  getViewportBox: () => {
    if (!current) return null;
    const rect = ui.stage.getBoundingClientRect();
    const { x, y, scale } = current.camera;
    if (!rect.width || !rect.height) return null;
    return {
      x: -x / scale,
      y: -y / scale,
      w: rect.width / scale,
      h: rect.height / scale,
    };
  },
  loadImageData: (id, src, linked) => store.imageData(id, src, linked),
  onError: (error) => showError(error),
});

let exporting = false;

/* 清晰度记在本地：同一个人导过一次高清，下次多半还是要高清 */
const QUALITY_KEY = "canvas.export.quality";

function readQuality() {
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    if (saved && QUALITY[saved]) return saved;
  } catch {
    /* 读不了就按默认来，不影响这次导出 */
  }
  return DEFAULT_QUALITY;
}

function rememberQuality(value) {
  try {
    localStorage.setItem(QUALITY_KEY, value);
  } catch {
    /* 存不下也无所谓，下次重新选一遍 */
  }
}

/* 尺寸说人话：一万四千像素写成数字，比 1.4e4 有用 */
function sizeLabel(width, height) {
  const megapixels = (width * height) / 1e6;
  const mp = megapixels >= 10 ? Math.round(megapixels) : megapixels.toFixed(1);
  return `${width} × ${height} 像素 · ${mp} MP`;
}

function openExportMenu() {
  if (!current || exporting) return;
  const rect = ui.exportBtn.getBoundingClientRect();
  openMenu(
    rect.left - 96,
    rect.bottom + 8,
    [
      { label: "导出为图片…", onClick: () => void openImageExportDialog() },
      { label: "导出为 PDF", onClick: () => void runExport("pdf") },
      { label: "导出为网页", onClick: () => void runExport("html") },
      { label: "导出公众号文章", onClick: () => void runExport("wechat") },
      { label: "导出今日头条文章", onClick: () => void runExport("toutiao") },
    ],
    { label: "整张画布", kind: "export" },
  );
}

/* 图片导出真正的问题不是「能不能导」，是「导出来能不能看清」。
 * 旧版按长边一刀切到 8192：一万四千像素的长卷被压到 0.58 倍，16px 的字落成 9px。
 * 所以先把倍数摊开让用户选，每一种都报出成品尺寸，代价自己看得见。
 * 内容实在长，就给「分段导出」——一张超长图在任何看图软件里都是受罪。 */
async function openImageExportDialog() {
  const base = exporter.plan({ quality: readQuality() });
  if (!base) {
    showToast("这个空间还是空的，没东西可导");
    return;
  }
  const currentQuality = readQuality();
  const options = Object.keys(QUALITY).map((value) => {
    const info = exporter.plan({ quality: value });
    const suffix = value === currentQuality ? "（上次用的）" : "";
    return {
      value,
      label: `${QUALITY[value].label}${suffix}`,
      hint: info.single.capped
        ? `${sizeLabel(info.single.width, info.single.height)} · 内容太大，只能收到这里`
        : sizeLabel(info.single.width, info.single.height),
    };
  });
  const sliced = base.sliced;
  /* 只有一段的时候，分段导出和整张导出是同一件事，别占一行选项 */
  if (sliced.count > 1) {
    options.push({
      value: "slice",
      label: `分段导出 · ${sliced.count} 张`,
      hint: `每张 ${sliced.width} × ${Math.min(sliced.segH, sliced.height)} 像素，按 ${QUALITY[currentQuality].label} 出图 · 逐段放大都清楚`,
    });
  }

  const choice = await choiceDialog({
    title: "导出为图片",
    message: `整张画布 ${Math.round(base.box.w)} × ${Math.round(base.box.h)} 像素，选一个清晰度：`,
    note:
      sliced.count > 1
        ? "倍数越大字越清楚，文件也越大。这么长的画布更推荐分段导出：一张超长图在多数看图软件和聊天工具里都会被压得很小。"
        : "倍数越大字越清楚，文件也越大。",
    options,
  });
  if (!choice) return;
  if (choice === "slice") {
    await runSliceExport(currentQuality);
    return;
  }
  rememberQuality(choice);
  await runExport("png", { quality: choice });
}

async function runExport(format, options = {}) {
  if (!current || exporting) return;
  exporting = true;
  ui.exportBtn?.classList.add("is-busy");
  if (ui.exportBtn) ui.exportBtn.disabled = true;
  if (format === "png" || format === "pdf") showToast("正在生成图片，块多的时候要等几秒…");
  try {
    /* 正文还在编辑就先落稿，不然导出的是改之前那一版 */
    if (editingId || edgeLabelEditor) commitEditing();
    const result = await exporter.exportAs(format, options);
    const saved = await store.exportSave(result.name, result.format, result.data);
    if (!saved) return;
    if (format === "wechat") {
      showToast(`已导出公众号文章：${saved}（点「复制全文」，再粘到编辑器）`);
      /* 顺手打开：省得用户再去文件夹里翻。打不开不影响导出结果 */
      try {
        await store.openExport(saved);
      } catch {
        /* 系统没装浏览器之类的情况，提示里已经有路径了 */
      }
      return;
    }
    if (format === "html") {
      showToast(`已导出网页：${saved}（双击就能打开）`);
      return;
    }
    if (format === "toutiao") {
      showToast(
        `已导出今日头条文档：${saved}（${result.headings} 个标题 / ${result.blocks} 段）· 头条后台「更多 → 文档导入」上传`,
      );
      return;
    }
    const capped = result.capped ? `，内容太大已自动收到 ×${result.scale.toFixed(1)}` : "";
    showToast(`已导出 ${result.width}×${result.height}${capped}：${saved}`);
  } catch (error) {
    showError(error);
  } finally {
    exporting = false;
    ui.exportBtn?.classList.remove("is-busy");
    if (ui.exportBtn) ui.exportBtn.disabled = false;
  }
}

/* 分段导出：选一次文件夹，然后一段一段画、一段一段写。
 * 画完一段就落盘一段，内存里始终只有一张图；中途按停止，已经写出去的保留。 */
async function runSliceExport(quality) {
  if (!current || exporting) return;
  const dir = await store.exportPickDir();
  if (!dir) return;

  exporting = true;
  ui.exportBtn?.classList.add("is-busy");
  if (ui.exportBtn) ui.exportBtn.disabled = true;
  const progress = progressDialog({
    title: "分段导出",
    message: "逐段画、逐段写，画完一段就落盘一段",
    cancelText: "停止",
  });
  let stopped = false;
  progress.onCancel(() => {
    stopped = true;
    progress.cancelPending();
  });

  try {
    if (editingId || edgeLabelEditor) commitEditing();
    let written = 0;
    const result = await exporter.exportSlices({
      quality,
      onProgress: ({ index, total, tile, tiles }) => {
        const inner = tiles ? (tile - 1) / tiles / total : 0;
        progress.set(Math.min(0.999, index / total + inner), `第 ${index + 1}/${total} 段 · 分片 ${tile}/${tiles}`);
      },
      onSlice: async ({ name, data, index, total }) => {
        if (stopped) throw new Error(`已停止，前面写好的 ${written} 张还在文件夹里`);
        await store.exportWrite(dir, name, "png", data);
        written += 1;
        progress.set((index + 1) / total, `已写出 ${written}/${total} 张`);
      },
    });
    progress.close();
    showToast(`已导出 ${result.count} 张（每张 ${result.width}×最多 ${result.segH}）到：${dir}`);
  } catch (error) {
    progress.close();
    showError(error);
  } finally {
    exporting = false;
    ui.exportBtn?.classList.remove("is-busy");
    if (ui.exportBtn) ui.exportBtn.disabled = false;
  }
}

/* 一句轻提示：比弹层轻，比 console 有用。导出这种事有个回执就够了。 */
let toastTimer = null;
function showToast(text) {
  if (!ui?.stage) return;
  let el = ui.stage.querySelector(".canvas-toast");
  if (!el) {
    el = document.createElement("p");
    el.className = "canvas-toast";
    ui.stage.append(el);
  }
  el.textContent = text;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), 3600);
}

/* ---------- 历史版本 ---------- */

function stampText(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function agoText(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/* 盘上那些自动快照。它是撤销栈之外的第二个底：撤销栈一刷新就没了，
   这份留在空间文件夹的 .history/ 里，关机重开也还在。 */
async function openHistoryPicker() {
  if (!current) return;
  const canvasId = current.meta.id;
  let entries = [];
  try {
    entries = await store.historyList(canvasId);
  } catch (error) {
    showError(error);
    return;
  }
  if (!entries.length) {
    showToast("还没有自动快照：改动一下，过一会儿再来看");
    return;
  }
  const picked = await choiceDialog({
    title: "历史版本",
    message:
      `盘上留了 ${entries.length} 份自动快照（每 90 秒最多留一份）。` +
      "挑一份恢复——恢复前的样子会先进撤销栈，按 Ctrl+Z 能退回来。",
    options: entries.slice(0, 30).map((entry) => ({
      value: entry.file,
      label: `${stampText(entry.time)}　${agoText(entry.time)}`,
      hint: `${entry.items} 块 · ${formatSize(entry.bytes)}`,
    })),
  });
  if (!picked) return;
  await restoreHistory(canvasId, picked);
}

async function restoreHistory(canvasId, file) {
  if (!current || current.meta.id !== canvasId) return;
  try {
    const items = await store.historyRead(canvasId, file);
    if (!Array.isArray(items)) throw new Error("这份快照里没有块");
    /* 回放走的是撤销栈那同一套：换 items、重排、把便签和笔记的正文补回文件。
       所以恢复完马上按 Ctrl+Z，回到的就是恢复前那一刻 */
    applyHistory(JSON.stringify(items));
    history.touch();
    showToast(`已恢复到这一版（${items.length} 块），Ctrl+Z 可以退回`);
  } catch (error) {
    showError(error);
  }
}

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
    undo: document.querySelector("#canvas-undo"),
    redo: document.querySelector("#canvas-redo"),
    exportBtn: document.querySelector("#canvas-export"),
    historyBtn: document.querySelector("#canvas-history"),
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
  bindZoomHold(ui.zoomIn, ZOOM_STEP);
  bindZoomHold(ui.zoomOut, -ZOOM_STEP);
  ui.undo.addEventListener("click", undoHistory);
  ui.redo.addEventListener("click", redoHistory);
  /* 和空间名一样：菜单在 document 上挂着「点外部就收起」，这一下点击冒泡到那里，
     会把刚弹出的菜单当成外部点击立刻收掉，看起来就是「点了没反应」 */
  ui.exportBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    /* 菜单本来就开着，再点一下是收起 */
    if (isMenuOpen("export")) {
      closeMenu();
      return;
    }
    openExportMenu();
  });
  ui.historyBtn?.addEventListener("click", () => void openHistoryPicker());
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
  setupGenEvents();
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
  syncHistoryButtons();

  initSearch({
    getItems: () => (current ? current.items : []),
    getSpaceId: () => current?.meta?.id || "",
    focusBlock: focusBlockById,
    openNoteFile: (rel) => {
      /* 笔记是另一个页面的事：切过去，等它把树读完再打开那一篇 */
      window.dispatchEvent(new CustomEvent("inspace:route", { detail: "notes" }));
      Promise.resolve(window.__inspace?.ready)
        .then(() => openNote(rel))
        .catch((error) => console.error(`打开笔记失败：${error}`));
    },
    /* 别的空间的命中：先切过去，等它读完再定位。spaceOpen 自己会等到渲染完 */
    jumpToSpace: async (spaceId, itemId) => {
      if (!spaceId) return;
      if (spaceId !== current?.meta?.id) await canvasAgent.spaceOpen(spaceId);
      if (itemId) focusBlockById(itemId);
    },
  });
}

/* 搜索结果点进来：把这块摆在视野正中，缩放到看得清的大小，再闪一下告诉用户是这块 */
function focusBlockById(id) {
  if (!current) return;
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  const bounds = itemBounds(item, el);
  const stageW = ui.stage.clientWidth;
  const stageH = ui.stage.clientHeight;
  const margin = 160;
  const scale = clamp(
    Math.min(stageW / (bounds.w + margin), stageH / (bounds.h + margin)),
    MIN_SCALE,
    1.6,
  );
  current.camera.scale = scale;
  current.camera.x = stageW / 2 - (bounds.x + bounds.w / 2) * scale;
  current.camera.y = stageH / 2 - (bounds.y + bounds.h / 2) * scale;
  applyCamera();
  scheduleCameraSave();
  select(id);
  const target = itemEls.get(id);
  if (target) {
    target.classList.remove("is-found");
    /* 重排一次动画：连着搜同一块时，闪烁要重新走一遍 */
    void target.offsetWidth;
    target.classList.add("is-found");
    setTimeout(() => target.classList.remove("is-found"), 1500);
  }
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
  history.dispose();
  void flushBlockContents();
  flushItems();
  flushCamera();
  /* 走开的这个空间的笔画旁表没理由还揣着：块 id 到别的空间也用不上 */
  pictureCmdBank.clear();
  pictureSymbolBank.clear();
  pictureEditors.clear();
  pictureTimers.forEach((timer) => clearTimeout(timer));
  pictureTimers.clear();
  scenePartsBank.clear();
  sceneTimers.forEach((timer) => clearTimeout(timer));
  sceneTimers.clear();
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
    docxUrlCache = new Map();
    xlsxUrlCache = new Map();
    pptxUrlCache = new Map();
    ebookTocCache = new Map();
    mediaMissing = new Set();
    await loadImages();
    if (token !== loadToken || !active) return;
    localStorage.setItem(STORAGE_KEY, current.meta.id);
    const staleNotes = await refreshLinkedNotes();
    const brokenContent = await loadBlockContents();
    mediaMissing = await refreshMediaFiles();
    if (token !== loadToken || !active) return;
    /* 正文都读回来了才开始记历史：撤销回的第一帧应该是「刚打开的样子」 */
    history.reset();
    await loadPictureImages();
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
  /* 键就是存下来的 src：images/xxx 和本机绝对路径两种写法天生撞不上，
     所以画面里垫的图和独立图片块能共用这一张表 */
  const wanted = new Map();
  for (const item of current.items) {
    if (item.type === "image" && item.src) wanted.set(item.src, Boolean(item.linked));
    /* 生图面板最近出的那张也是 images/ 里的真文件，同一张表里取地址 */
    else if (item.type === "gen" && item.src) wanted.set(item.src, false);
    else if (item.type === "picture") {
      for (const one of collectPictureImageSrcs(item.cmds, item.symbols)) wanted.set(one.src, one.linked);
    }
  }
  await Promise.all(
    [...wanted].map(async ([src, linked]) => {
      try {
        imageCache.set(src, await store.imageUrl(canvasId, src, linked));
      } catch {
        imageCache.set(src, null);
      }
    }),
  );
}

/* 画面里垫的那张位图，src 是跟着 pictures/<块id>.json 一起读回来的，比上面那次 loadImages 晚一步。
   这里补上：只问缓存里还没有的 src，只重画真垫了图的块——九百多条指令那一幅重画一次不便宜。
   刚打开空间时调它，那时块还没建，重画那步自然落空，地址先躺在缓存里等 renderAll。 */
async function loadPictureImages() {
  if (!current) return;
  const canvasId = current.meta.id;
  const missing = new Map();
  const touched = [];
  for (const item of current.items) {
    if (item.type !== "picture") continue;
    const srcs = collectPictureImageSrcs(item.cmds, item.symbols).filter((one) => !imageCache.has(one.src));
    if (!srcs.length) continue;
    touched.push(item);
    for (const one of srcs) missing.set(one.src, one.linked);
  }
  if (!missing.size) return;
  await Promise.all(
    [...missing].map(async ([src, linked]) => {
      try {
        imageCache.set(src, await store.imageUrl(canvasId, src, linked));
      } catch {
        imageCache.set(src, null);
      }
    }),
  );
  for (const item of touched) {
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
  }
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
  history.dispose();
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
    docxUrlCache.clear();
    xlsxUrlCache.clear();
    pptxUrlCache.clear();
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
  /* 场景块的位图分辨率要跟着相机缩放重算：CSS 的 scale 只是把已有的画布放大，
     不重画的话放到 4 倍就是一坨马赛克 */
  setSceneCameraScale(camera.scale);
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

/* 缩放键长按连发：按下先走一步，按住不放就按节拍继续走，松开/移出/失焦都停 */
function bindZoomHold(button, delta) {
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
    /* 音量是块自己的属性：调完记住，下次打开还是这个音量 */
    onVideoVolume: () => scheduleItemsSave(),
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
    loadDocxUrl: async (block) => {
      const key = previewKey(block);
      const cached = docxUrlCache.get(key);
      if (cached) return cached;
      const url = await store.fileUrl(canvasId, block.src, block.linked);
      docxUrlCache.set(key, url);
      return url;
    },
    loadXlsxUrl: async (block) => {
      const key = previewKey(block);
      const cached = xlsxUrlCache.get(key);
      if (cached) return cached;
      const url = await store.fileUrl(canvasId, block.src, block.linked);
      xlsxUrlCache.set(key, url);
      return url;
    },
    loadPptxUrl: async (block) => {
      const key = previewKey(block);
      const cached = pptxUrlCache.get(key);
      if (cached) return cached;
      const url = await store.fileUrl(canvasId, block.src, block.linked);
      pptxUrlCache.set(key, url);
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
  if (isContainer(item)) el.classList.add("is-container");
  if (item.type === "text") item.h = el.offsetHeight;
  if (item.type === "note") hydrateNoteImages(item, el);
  if (item.type === "picture") attachPictureTools(el, item);
  if (item.type === "gen") attachGenPanel(el, item);
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
  /* 场景块的 WebGL 上下文挂在即将被丢掉的那棵 DOM 上，不主动释放会一路攒到浏览器的上限 */
  for (const view of ui.world.querySelectorAll(".canvas-scene-view")) disposeScene(view);
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

  /* 锁住的块不给能改它的把手：不能缩放，线的端点也不能拖 */
  if (item.locked) return;
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
  /* 按住到松手之间不往撤销栈里落东西：一次拖动只算一步，
     不然每个 pointermove 都会被记成一笔 */
  history.hold(true);
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
  /* 锁住的块拖不动它自己（能点选、能右键），但按住它拖应该挪视野：
     锁的是块，不是画布。这样铺满画面的锁定面板就成了可抓的一整张底。
     点一下（没拖动）仍然只是选中，不产生位移。 */
  if (item.locked) {
    drag = {
      kind: "pan",
      startClient: { x: e.clientX, y: e.clientY },
      origin: { x: current.camera.x, y: current.camera.y },
      moved: false,
    };
    ui.stage.classList.add("is-panning");
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

/* ---------- 批量排版 ---------- */

/* 能参与排版的那几块：选中、有 DOM、没锁。
   锁住的块如果跟着动，那就等于绕过锁定了，所以一律跳过 */
function editableSelection() {
  const out = [];
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (!item || !el || item.locked) continue;
    out.push({ item, el });
  }
  return out;
}

/* 平移一块。直线和箭头要连终点一起挪，不然框走了线还钉在原地 */
function shiftItem(item, dx, dy) {
  item.x += dx;
  item.y += dy;
  if (item.type === "line" || item.type === "arrow") {
    item.x2 += dx;
    item.y2 += dy;
  }
}

const TIDY_GAP = 32;

function applyLayout(entries, target) {
  entries.forEach((entry, index) => {
    const to = target(entry, index);
    const dx = to.x - entry.b.x;
    const dy = to.y - entry.b.y;
    if (!dx && !dy) return;
    shiftItem(entry.item, dx, dy);
    syncItemElement(entry.el, entry.item);
  });
  updateSelection();
  scheduleItemsSave();
}

/* 六种对齐：以选区的外接框为基准。bounds 是先算好的一轮，
   边挪边算会让后面的块对角到已经动过的位置上 */
function alignSelected(mode) {
  const list = editableSelection();
  if (list.length < 2) return;
  const entries = list.map(({ item, el }) => ({ item, el, b: itemBounds(item, el) }));
  const left = Math.min(...entries.map((e) => e.b.x));
  const top = Math.min(...entries.map((e) => e.b.y));
  const right = Math.max(...entries.map((e) => e.b.x + e.b.w));
  const bottom = Math.max(...entries.map((e) => e.b.y + e.b.h));
  applyLayout(entries, (entry) => {
    const b = entry.b;
    if (mode === "left") return { x: left, y: b.y };
    if (mode === "right") return { x: right - b.w, y: b.y };
    if (mode === "center-h") return { x: (left + right) / 2 - b.w / 2, y: b.y };
    if (mode === "top") return { x: b.x, y: top };
    if (mode === "bottom") return { x: b.x, y: bottom - b.h };
    return { x: b.x, y: (top + bottom) / 2 - b.h / 2 };
  });
}

/* 等距分布：首尾两块钉住，中间的按中心点均匀散开。
   用中心而不是左边，是因为大小不一时左边对齐看着更歪 */
function distributeSelected(axis) {
  const list = editableSelection();
  if (list.length < 3) return;
  const entries = list
    .map(({ item, el }) => ({ item, el, b: itemBounds(item, el) }))
    .sort((a, z) => (axis === "x" ? a.b.x - z.b.x : a.b.y - z.b.y));
  const centerOf = (b) => (axis === "x" ? b.x + b.w / 2 : b.y + b.h / 2);
  const first = centerOf(entries[0].b);
  const last = centerOf(entries[entries.length - 1].b);
  const step = (last - first) / (entries.length - 1);
  applyLayout(entries, (entry, index) => {
    const delta = first + step * index - centerOf(entry.b);
    return axis === "x"
      ? { x: entry.b.x + delta, y: entry.b.y }
      : { x: entry.b.x, y: entry.b.y + delta };
  });
}

/* 整理成网格：按现在的阅读顺序（先上下后左右）重排成接近正方形的阵列。
   AI 批量铺完东西之后最需要这一下——它摆的坐标经常疏密不均 */
function tidySelected() {
  const list = editableSelection();
  if (list.length < 2) return;
  const entries = list
    .map(({ item, el }) => ({ item, el, b: itemBounds(item, el) }))
    .sort((a, z) => a.b.y - z.b.y || a.b.x - z.b.x);
  const originX = Math.min(...entries.map((e) => e.b.x));
  const originY = Math.min(...entries.map((e) => e.b.y));
  const colW = Math.max(...entries.map((e) => e.b.w)) + TIDY_GAP;
  const rowH = Math.max(...entries.map((e) => e.b.h)) + TIDY_GAP;
  const cols = Math.max(1, Math.round(Math.sqrt(entries.length)));
  applyLayout(entries, (entry, index) => ({
    x: originX + (index % cols) * colW,
    y: originY + Math.floor(index / cols) * rowH,
  }));
}

/* 这一拖要带上的块：单选就它自己，多选把集合里每个都带上，各记各的起点。
   直线/箭头另记 x2/y2，不然框动了线不动。
   拖的是容器（编成分组的矩形）时，框里那些块跟着一起走。 */function moveGroup() {
  const group = [];
  const seen = new Set();
  const push = (id) => {
    if (seen.has(id)) return;
    const item = findItem(id);
    const el = itemEls.get(id);
    if (!item || !el || item.locked) return;
    seen.add(id);
    group.push({ item, el, origin: { x: item.x, y: item.y, x2: item.x2, y2: item.y2 } });
  };
  for (const id of selectedIds) push(id);
  for (const id of selectedIds) {
    const container = findItem(id);
    if (!container || !isContainer(container)) continue;
    for (const child of containedBlocks(container, seen)) push(child.id);
  }
  return group;
}

/* ---------- 分组容器 ----------
   矩形可以当「框」用。成员不单独存名字，按几何现算：整个块完全落在框里的才算成员。
   好处是拖出去就自动脱组、拖进来就自动入组，不用维护一份迟早会过期的名单。 */
function isContainer(item) {
  return item.type === "rect" && item.container === true;
}

/* 框里装着的块。exclude 是已经算进去的（多选时别重复带上） */
function containedBlocks(container, exclude = new Set()) {
  const el = itemEls.get(container.id);
  if (!el || !current) return [];
  const box = itemBounds(container, el);
  const out = [];
  for (const item of current.items) {
    if (item.id === container.id || item.type === "connector" || item.locked) continue;
    if (exclude.has(item.id)) continue;
    const childEl = itemEls.get(item.id);
    if (!childEl) continue;
    const b = itemBounds(item, childEl);
    const inside =
      b.x >= box.x - 1 &&
      b.y >= box.y - 1 &&
      b.x + b.w <= box.x + box.w + 1 &&
      b.y + b.h <= box.y + box.h + 1;
    if (inside) out.push(item);
  }
  return out;
}

function applyContainerClass(item) {
  itemEls.get(item.id)?.classList.toggle("is-container", isContainer(item));
}

/* 右键「编为容器 / 取消容器」 */
function toggleContainer(item) {
  if (item.type !== "rect") return;
  const next = !isContainer(item);
  if (next) {
    item.container = true;
    const kids = containedBlocks(item);
    /* 框要垫在它装的东西底下，否则选中的永远是框 */
    if (kids.length) {
      const lowest = Math.min(...kids.map((kid) => (Number.isFinite(kid.z) ? kid.z : 0)));
      item.z = lowest - 1;
      const el = itemEls.get(item.id);
      if (el) el.style.zIndex = String(item.z);
    }
    applyContainerClass(item);
    scheduleItemsSave();
    showToast(`已编为容器：框里 ${kids.length} 块会跟着它走`);
    return;
  }
  delete item.container;
  applyContainerClass(item);
  scheduleItemsSave();
  showToast("已取消容器，这块回到普通矩形");
}

/* 方向键挪位：一次 1px，按住 Shift 走 10px。整组各加同样的偏移；
   直线/箭头连端点一起挪，否则只动起点、线会变形。 */
function nudgeSelected(dx, dy) {
  /* 方向和拖动一样：容器带着框里的块一起挪 */
  for (const { item, el } of moveGroup()) {
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

/* 参照线的来源：别的面板的三条竖线（左边/中线/右边）和三条横线（上边/中线/下边）；
   外加每块的宽高，改尺寸时用来咬「和它一样宽 / 一样高」 */
function snapTargets(exclude) {
  const verticals = [];
  const horizontals = [];
  const widths = [];
  const heights = [];
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
    widths.push({ w: b.w, x: b.x, y: b.y, h: b.h });
    heights.push({ h: b.h, x: b.x, y: b.y, w: b.w });
  }
  return { verticals, horizontals, widths, heights };
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

/* 改尺寸时只咬正在拖的那条边，规则和整块拖动一样：差一点就吸上去，并拉一根虚线。
   边没咬上时再看尺寸：拖到和别的面板一样宽 / 一样高也吸住，并在那块上标出它的宽高。
   图片永远等比：角/左右拖时高度是由宽度算出来的，只咬水平那条边；纯上下拖才咬垂直边。
   文字的高度由内容撑开，垂直方向不咬，免得虚线说的和眼睛看到的不一致。 */
function snapResize(state, dx, dy) {
  const origin = state.origin;
  const dir = state.dir;
  const type = findItem(state.id)?.type;
  if (!type || type === "connector") return { dx, dy, guides: [] };
  const targets = snapTargets(new Set([state.id]));
  const threshold = SNAP_PX / Math.max(0.01, current.camera.scale);
  const guides = [];
  const nearest = (value, lines) => {
    let best = null;
    for (const line of lines) {
      const delta = line.at - value;
      if (Math.abs(delta) > threshold) continue;
      if (best && Math.abs(best.delta) <= Math.abs(delta)) continue;
      best = { delta, line };
    }
    return best;
  };

  let nextDx = dx;
  let nextDy = dy;

  /* 拖右边咬 x+w，拖左边咬 x */
  const edgeX = dir.includes("e")
    ? origin.x + origin.w + dx
    : dir.includes("w")
      ? origin.x + dx
      : null;
  if (edgeX !== null) {
    const best = nearest(edgeX, targets.verticals);
    if (best) {
      nextDx += best.delta;
      guides.push({
        axis: "x",
        at: best.line.at,
        from: Math.min(best.line.from, origin.y),
        to: Math.max(best.line.to, origin.y + origin.h),
      });
    } else {
      /* 宽度拖到和某块一样：吸住，并在那块顶上标一条它的宽 */
      const widthNow = dir.includes("e") ? origin.w + dx : origin.w - dx;
      let fit = null;
      for (const entry of targets.widths) {
        const delta = entry.w - widthNow;
        if (Math.abs(delta) > threshold) continue;
        if (fit && Math.abs(fit.delta) <= Math.abs(delta)) continue;
        fit = { delta, entry };
      }
      if (fit) {
        nextDx += dir.includes("e") ? fit.delta : -fit.delta;
        guides.push({
          axis: "y",
          at: fit.entry.y - 6 / Math.max(0.01, current.camera.scale),
          from: fit.entry.x,
          to: fit.entry.x + fit.entry.w,
          tight: true,
        });
      }
    }
  }

  const byHeight = type === "image" ? dir === "n" || dir === "s" : type !== "text";
  if (byHeight) {
    const edgeY = dir.includes("s")
      ? origin.y + origin.h + dy
      : dir.includes("n")
        ? origin.y + dy
        : null;
    if (edgeY !== null) {
      const best = nearest(edgeY, targets.horizontals);
      if (best) {
        nextDy += best.delta;
        guides.push({
          axis: "y",
          at: best.line.at,
          from: Math.min(best.line.from, origin.x),
          to: Math.max(best.line.to, origin.x + origin.w),
        });
      } else {
        /* 高度拖到和某块一样：吸住，并在那块左边标一条它的高 */
        const heightNow = dir.includes("s") ? origin.h + dy : origin.h - dy;
        let fit = null;
        for (const entry of targets.heights) {
          const delta = entry.h - heightNow;
          if (Math.abs(delta) > threshold) continue;
          if (fit && Math.abs(fit.delta) <= Math.abs(delta)) continue;
          fit = { delta, entry };
        }
        if (fit) {
          nextDy += dir.includes("s") ? fit.delta : -fit.delta;
          guides.push({
            axis: "x",
            at: fit.entry.x - 6 / Math.max(0.01, current.camera.scale),
            from: fit.entry.y,
            to: fit.entry.y + fit.entry.h,
            tight: true,
          });
        }
      }
    }
  }

  return { dx: nextDx, dy: nextDy, guides };
}

/* 辅助线画在屏幕坐标的顶层：它是拖拽这一下的临时提示，不属于任何一块，
   所以不参与面板之间的层级（同连线端点手柄那个口径）。松手即清。 */
function drawSnapGuides(guides) {
  if (!ui?.guideLayer) return;
  ui.guideLayer.textContent = "";
  for (const guide of guides) {
    const line = document.createElement("div");
    /* 对齐线要伸出两头，好让眼睛找得到；等宽/等高那条是量在参照块身上的尺子，不伸 */
    const overhang = guide.tight ? 0 : GUIDE_OVERHANG_PX;
    if (guide.axis === "x") {
      const top = worldToStage(guide.at, guide.from);
      const bottom = worldToStage(guide.at, guide.to);
      line.className = "canvas-guide canvas-guide-vertical";
      line.style.left = `${top.x}px`;
      line.style.top = `${Math.min(top.y, bottom.y) - overhang}px`;
      line.style.height = `${Math.abs(bottom.y - top.y) + overhang * 2}px`;
    } else {
      const start = worldToStage(guide.from, guide.at);
      const end = worldToStage(guide.to, guide.at);
      line.className = "canvas-guide canvas-guide-horizontal";
      line.style.top = `${start.y}px`;
      line.style.left = `${Math.min(start.x, end.x) - overhang}px`;
      line.style.width = `${Math.abs(end.x - start.x) + overhang * 2}px`;
    }
    ui.guideLayer.append(line);
  }
}

function startDraw(e) {
  const start = clientToWorld(e.clientX, e.clientY);
  let item = null;
  if (tool === "rect" || tool === "ellipse") item = makeBox(tool, start.x, start.y, start.x, start.y);
  else if (tool === "picture") item = makePicture(start.x, start.y, 0, 0);
  else if (tool === "scene") item = makeScene(start.x, start.y, 0, 0);
  else if (tool === "gen") item = makeGen(start.x, start.y, 0, 0);
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
  /* 手柄上的按下挡住了舞台那一层的 pointerdown，这里自己把撤销栈挂起 */
  history.hold(true);
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

  if (drag.kind === "paint") {
    onPaintPointerMove(e);
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
  let dx = point.x - drag.start.x;
  let dy = point.y - drag.start.y;
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
    if (
      item.type === "rect" ||
      item.type === "ellipse" ||
      item.type === "picture" ||
      item.type === "scene" ||
      item.type === "gen"
    ) {
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
    const snapped = snapResize(drag, dx, dy);
    dx = snapped.dx;
    dy = snapped.dy;
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
    drawSnapGuides(snapped.guides);
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
  try {
    settlePointerUp(e);
  } finally {
    /* 按下时挂起的那一步在手势收尾之后才算完：画一半撤掉的块、拖完的尺寸
       都在这一句之前定下来，撤销栈里不会留下「半成品」状态 */
    history.hold(false);
  }
}

function settlePointerUp(e) {
  if (!drag || !current) return;
  const finished = drag;
  drag = null;
  ui.stage.classList.remove("is-panning", "is-moving", "is-resizing");
  drawSnapGuides([]);
  if (finished.kind === "paint") {
    finishPaint(finished);
    return;
  }
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
        : item.type === "picture"
          ? item.w < PICTURE_MIN_WIDTH || item.h < PICTURE_MIN_HEIGHT
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
    /* 画面块拖得太小不回收，给个能画的地板：它是拿来画东西的，不是装饰 */
    if (item.type === "picture") {
      item.w = Math.max(PICTURE_MIN_WIDTH, item.w);
      item.h = Math.max(PICTURE_MIN_HEIGHT, item.h);
      syncItemElement(itemEls.get(item.id), item);
    }
    /* 场景块同理：拖出多大都先给一块能看的视口，太小的地板交给这里，
       不交给上面的 tooSmall——那条是「根本没拖动就别留」的判据，不是尺寸地板 */
    if (item.type === "scene") {
      item.w = Math.max(SCENE_MIN_WIDTH, item.w);
      item.h = Math.max(SCENE_MIN_HEIGHT, item.h);
      syncItemElement(itemEls.get(item.id), item);
    }
    /* 生图面板同理：地板是给上面那块取景窗留的，再小就没法看正在长的图 */
    if (item.type === "gen") {
      item.w = Math.max(GEN_MIN_WIDTH, item.w);
      item.h = Math.max(GEN_MIN_HEIGHT, item.h);
      syncItemElement(itemEls.get(item.id), item);
    }
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
  /* 锁住的块不进入编辑 */
  if (item.locked) return;
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
  const target = e.target.closest?.(".canvas-item, .canvas-connector");
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
    const entries = [
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
    ];
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
    /* 全锁住时没有可删的，不摆一个点了没反应的删除 */
    if (!allLocked) entries.push({ label: "删除", danger: true, onClick: () => deleteItems(ids) });
    openMenu(e.clientX, e.clientY, entries);
    return;
  }
  select(item.id);
  openItemMenu(item, e.clientX, e.clientY);
}

/* ---------- 右键菜单 ---------- */

/* 颜色行：悬停就在右边展开取色板，选色实时落到块上，色板收起时才写盘 */
function colorEntry(item, prop, { allowNone = false, noneLabel = "透明", presets, allowAlpha = true, save } = {}) {
  let touched = false;
  return {
    label: "颜色",
    colorPicker: {
      /* 每次现读：同一份菜单里改完色再悬停回来，色板要停在新颜色上 */
      get value() {
        return item[prop] || "";
      },
      seed: prop === "color" || prop === "fillColor" ? "#ffffff" : "#9a9a9a",
      presets: presets || PRESETS,
      allowNone,
      noneLabel,
      allowAlpha,
      onChange: (color) => {
        touched = true;
        applyColor(item, prop, color);
      },
      onDone: () => {
        if (touched) (save || scheduleItemsSave)();
      },
    },
  };
}

/* 带边框的块共用一组二级菜单：颜色、宽度、圆角。椭圆天生是圆的，不给圆角 */
function borderMenuEntry(item, colorRow) {
  const children = [
    colorRow,
    { label: "宽度", onClick: () => openBorderWidthDialog(item) },
  ];
  if (item.type !== "ellipse") children.push({ label: "圆角", onClick: () => openRadiusDialog(item) });
  return { label: "边框", children };
}

/* 文件卡（docx 正文 / 文本预览）的复制语义：正文区里有非空文字选区 → 复制纯文字；
   没有选区 → 复制整块（面板）。Ctrl+C 和右键「复制」共用一套判定，不另开菜单项。 */
function itemBodyEl(item) {
  const el = itemEls.get(item.id);
  if (!el) return null;
  return el.querySelector(".canvas-file-docx-body, .canvas-file-preview, .canvas-file-xlsx-scroll, .canvas-file-pptx-scroll");
}
/* 给定正文元素内，当前有没有非空文字选区；有就返回纯文本，没有返回 null */
function bodySelectionText(bodyEl) {
  if (!bodyEl) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!bodyEl.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  return text && text.trim() ? text : null;
}
/* 任意文件卡正文区里的非空文字选区（不指定哪张卡），供全局 Ctrl+C 用 */
function activeBodySelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  const body = el && el.closest && el.closest(".canvas-file-docx-body, .canvas-file-preview, .canvas-file-xlsx-scroll, .canvas-file-pptx-scroll");
  return body ? bodySelectionText(body) : null;
}
async function copyBodySelectionText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      document.execCommand("copy");
    } catch {
      /* 都拿不到剪贴板就随它，选区还在，用户可以再试一次 */
    }
  }
}

function openItemMenu(item, x, y) {
  /* 锁住的块菜单只剩解锁和只读项：锁上之后要改什么都得先解开 */
  if (item.locked) {
    const entries = [];
    entries.push({ label: "解锁", onClick: () => setLocked(item, false) });
    if (PROP_KIND[item.type]) entries.push({ label: "属性", onClick: () => openItemProps(item) });
    if (revealTarget(item)) {
      entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
    }
    openMenu(x, y, entries);
    return;
  }
  const entries = [];
  const isShape = item.type === "rect" || item.type === "ellipse";
  if (isShape) {
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor", { allowNone: true })));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor", { allowNone: true })],
    });
  }
  if (item.type === "rect") {
    entries.push({
      label: isContainer(item) ? "取消容器" : "编为容器",
      onClick: () => toggleContainer(item),
    });
  } else if (item.type === "line" || item.type === "arrow") {
    entries.push({ ...colorEntry(item, "borderColor"), label: "线条颜色" });
  } else if (item.type === "text") {
    entries.push({
      label: "文字",
      children: [colorEntry(item, "color"), { label: "字号", children: fontSizeMenuItems(item) }],
    });
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor", { allowNone: true })],
    });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor", { allowNone: true })));
  } else if (item.type === "connector") {
    entries.push({ ...colorEntry(item, "color"), label: "线条颜色" });
    entries.push({
      label: "线型",
      children: CONNECTOR_SHAPES.map(([value, label]) => ({
        label: `${label}${item.shape === value ? " ✓" : ""}`,
        onClick: () => setConnectorProp(item, "shape", value),
      })),
    });
    entries.push({
      label: "箭头",
      children: CONNECTOR_ARROWS.map(([value, label]) => ({
        label: `${label}${item.arrow === value ? " ✓" : ""}`,
        onClick: () => setConnectorProp(item, "arrow", value),
      })),
    });
    entries.push({
      label: item.bend ? "关闭折点" : "打开折点",
      onClick: () => setConnectorBend(item, !item.bend),
    });
  } else if (item.type === "image") {
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor", { allowNone: true })));
  } else if (item.type === "video") {
    /* 播放器菜单：状态现问播放器，播放/全屏的文案跟着当前状态走 */
    const ctl = videoControlOf(itemEls.get(item.id));
    if (ctl) {
      let touched = false;
      entries.push({
        label: "播放器",
        children: [
          { label: ctl.isPlaying() ? "暂停" : "播放", onClick: () => ctl.togglePlay() },
          { label: ctl.isFullscreen() ? "恢复尺寸" : "最大化", onClick: () => ctl.toggleFullscreen() },
          {
            label: "声音",
            slider: {
              get value() {
                return ctl.getVolume();
              },
              onChange: (value) => {
                touched = true;
                ctl.setVolume(value);
              },
              onDone: () => {
                if (touched) scheduleItemsSave();
              },
            },
          },
        ],
      });
    }
  } else if (item.type === "sticky") {
    entries.push({ label: "编辑", onClick: () => startStickyEdit(item.id) });
    entries.push({
      label: "文字",
      children: [
        colorEntry(item, "textColor", {
          presets: STICKY_TEXT_PRESETS,
          allowAlpha: false,
          save: () => persistSticky(item),
        }),
      ],
    });
    entries.push({
      label: "背景",
      children: [
        colorEntry(item, "color", {
          presets: STICKY_BG_PRESETS,
          allowAlpha: false,
          save: () => persistSticky(item),
        }),
      ],
    });
    entries.push(
      borderMenuEntry(item, colorEntry(item, "borderColor", { save: () => persistSticky(item) })),
    );
  } else if (item.type === "note") {
    entries.push({ label: "编辑", onClick: () => startNoteEdit(item.id) });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor", { allowNone: true })],
    });
  } else if (item.type === "file") {
    if (isFileEditable(item)) {
      entries.push({ label: "编辑", onClick: () => startFileEdit(item.id) });
    }
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor", { allowNone: true })],
    });
  }
  /* 连线不复制：它两头挂着块，粘出去无处可接。
     复制的语义：正文区有文字选区 → 复制纯文字；否则复制整块（面板） */
  if (item.type !== "connector") {
    entries.push({ label: "层级", children: layerMenuItems(item) });
    entries.push({
      label: "复制",
      onClick: () => {
        const text = bodySelectionText(itemBodyEl(item));
        if (text) copyBodySelectionText(text);
        else copyItems([item.id]);
      },
    });
  }
  /* 空间不替用户开文件，只把他带到那份文件躺着的地方 */
  if (revealTarget(item)) {
    entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
  }
  /* 属性：便签报类型，媒体和文件类报绝对路径。文字、图形、连线没有「属性」这一行 */
  if (PROP_KIND[item.type]) {
    entries.push({ label: "属性", onClick: () => openItemProps(item) });
  }
  if (entries.length) entries.push("-");
  /* 锁定贴着删除放，都在分隔线下面 */
  if (item.type !== "connector") {
    entries.push({ label: "锁定", onClick: () => setLocked(item, true) });
  }
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

function layerMenuItems(item) {
  return [
    { label: "上一层", onClick: () => moveLayer(item, 1) },
    { label: "下一层", onClick: () => moveLayer(item, -1) },
    { label: "最顶层", onClick: () => moveLayer(item, "top") },
    { label: "最底层", onClick: () => moveLayer(item, "bottom") },
  ];
}

/* 锁住就是这块先别动：位置、尺寸、正文、删除全挡住，只剩选中、右键和连线 */
function setLocked(item, locked) {
  setLockedMany([item.id], locked);
}

function setLockedMany(ids, locked) {
  for (const id of ids) {
    const item = findItem(id);
    if (!item || item.type === "connector") continue;
    item.locked = locked;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    /* 画面块的锁还要收掉那条工具条：锁上的画不供笔 */
    if (item.type === "picture") refreshPictureChrome(item.id);
  }
  updateSelection();
  scheduleItemsSave();
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

function fontSizeMenuItems(item) {
  const current = item.fontSize || 14;
  const sizes = FONT_SIZES.includes(current)
    ? FONT_SIZES
    : [...FONT_SIZES, current].sort((a, b) => a - b);
  return sizes.map((size) => ({
    label: `${size}px${size === current ? " ✓" : ""}`,
    onClick: () => setFontSize(item, size),
  }));
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
  const value = await promptDialog({
    title: "圆角",
    label: "圆角半径（px，0 为直角）",
    value: String(Number.isFinite(item.radius) ? item.radius : 0),
    okText: "设置",
    validate: (text) => (/^\d{1,4}$/.test(text) ? null : "填 0 到 9999 的整数"),
  });
  if (value === null) return;
  item.radius = Number(value);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
}

/* 边框宽度按像素填，0 就是不要边框 */
async function openBorderWidthDialog(item) {
  const value = await promptDialog({
    title: "边框宽度",
    label: "边框宽度（px，0 为无边框）",
    value: String(Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH),
    okText: "设置",
    validate: (text) =>
      /^\d{1,2}$/.test(text) && Number(text) <= BORDER_MAX_WIDTH
        ? null
        : `填 0 到 ${BORDER_MAX_WIDTH} 的整数`,
  });
  if (value === null) return;
  item.borderWidth = Number(value);
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

function deleteItems(ids) {
  if (!current || !ids.length) return;
  /* 锁住的块不删；连在它身上的线也就没有理由跟着走 */
  const doomed = new Set(
    ids.filter((id) => {
      const item = findItem(id);
      return item && !item.locked;
    }),
  );
  if (!doomed.size) return;
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
    /* 下面这些文件都不当场回收：先挂在撤销记录上，等这一笔再也撤不回来了才真删。
       缓存的地址也别清 —— 撤销回来时块要立刻能显示，不用再问一遍后端。
       引用态本来就是用户自己的文件，哪种情况都不碰。 */
    const canvasId = current.meta.id;
    const usedBy = (type, src) => () =>
      current.items.some((other) => other.type === type && other.src === src);
    if (item.type === "image" && item.src && !item.linked) {
      const { src } = item;
      deferFileDelete(canvasId, usedBy("image", src), () => {
        void store.deleteCanvasImage(canvasId, src, false).catch(() => {});
      });
    }
    if (item.type === "audio" && item.src && !item.linked) {
      const { src } = item;
      deferFileDelete(canvasId, usedBy("audio", src), () => {
        void store.deleteCanvasAudio(canvasId, src, false).catch(() => {});
      });
    }
    if (item.type === "video" && item.src && !item.linked) {
      const { src, audioRel } = item;
      deferFileDelete(canvasId, usedBy("video", src), () => {
        void store.deleteCanvasVideo(canvasId, src, false, audioRel).catch(() => {});
      });
    }
    if (item.type === "sticky") {
      clearTimeout(stickyTimers.get(item.id));
      stickyTimers.delete(item.id);
      const stickyId = item.id;
      deferFileDelete(
        canvasId,
        () => current.items.some((other) => other.id === stickyId),
        () => void store.deleteSticky(canvasId, stickyId).catch(() => {}),
      );
    }
    if (item.type === "picture") {
      clearTimeout(pictureTimers.get(item.id));
      pictureTimers.delete(item.id);
      /* 块没了，那一套笔和笔画栈也跟着清空：块 id 不会复用，留着只是漏 */
      pictureEditors.delete(item.id);
      const pictureId = item.id;
      /* 撤回来那块还得带着笔画，所以旁表里这份也留到这条撤销记录被挤出栈为止，
         跟文件一起放手 */
      deferFileDelete(
        canvasId,
        () => current.items.some((other) => other.id === pictureId),
        () => {
          pictureCmdBank.delete(pictureId);
          pictureSymbolBank.delete(pictureId);
          void store.deletePicture(canvasId, pictureId).catch(() => {});
        },
      );
    }
    if (item.type === "scene") {
      clearTimeout(sceneTimers.get(item.id));
      sceneTimers.delete(item.id);
      const sceneId = item.id;
      /* 和画面一样：旁表里这份留到那条撤销记录被挤出栈为止，撤回来块还带着它摆的东西 */
      deferFileDelete(
        canvasId,
        () => current.items.some((other) => other.id === sceneId),
        () => {
          scenePartsBank.delete(sceneId);
          void store.deleteScene(canvasId, sceneId).catch(() => {});
        },
      );
    }
    if (item.type === "gen") {
      clearTimeout(genTimers.get(item.id));
      genTimers.delete(item.id);
      /* 这一轮的运行态（第几步、预览图）跟着块走：不留，否则「一次一张」会被一块已经不存在的图卡住 */
      dropGenRun(item.id);
      const genId = item.id;
      deferFileDelete(
        canvasId,
        () => current.items.some((other) => other.id === genId),
        () => void store.deleteGen(canvasId, genId).catch(() => {}),
      );
      /* 出的那张图没人指着才回收：落块落出去的那张图片块还用它，撤回来两边都还在 */
      if (item.src) {
        const { src } = item;
        deferFileDelete(canvasId, () => srcInUse(src), () => {
          void store.deleteCanvasImage(canvasId, src, false).catch(() => {});
        });
      }
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
      const noteId = item.id;
      if (!item.linked) {
        deferFileDelete(
          canvasId,
          () => current.items.some((other) => other.id === noteId),
          () => void store.deleteNote(canvasId, noteId).catch(() => {}),
        );
      }
    }
    /* 拷贝块的副本跟着块一起进回收站；引用块只断链接，原文件在用户手里不动 */
    if (item.type === "file" && item.src) {
      if (fileEditor?.itemId === item.id) flushFileEditor();
      filePreviewCache.delete(previewKey(item));
      if (!item.linked) {
        const { src } = item;
        deferFileDelete(canvasId, usedBy("file", src), () => {
          void store.deleteCanvasFile(canvasId, src, false).catch(() => {});
        });
      }
    }
    if (item.type === "ebook" && item.src) {
      ebookTocCache.delete(ebookKey(current.meta.id, item));
      if (!item.linked) {
        const { src } = item;
        deferFileDelete(canvasId, usedBy("ebook", src), () => {
          void store.deleteCanvasFile(canvasId, src, false).catch(() => {});
        });
      }
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

/* ---------- 便签 / 笔记 / 画面块的内容文件 ----------
   一块一份，住在空间自己目录里：便签 stickies/<块id>.json，笔记 notes/<块id>.md，
   画面 pictures/<块id>.json。items.json 只留位置和层级，正文和笔画不再内嵌。
   跟数据根顶层那两个旧目录、跟笔记页都脱钩——
   空间上改这张便签，首页那张不动，反过来也一样。 */

const CONTENT_WRITE_DELAY = 400;
let stickyTimers = new Map(); // 块 id -> 还没落盘的写盘定时器
let noteTimers = new Map();
let pictureTimers = new Map();
let sceneTimers = new Map();
let genTimers = new Map();
/* 块 id -> 那份笔画。全局撤销快照不含 cmds（见 captureHistory），回放之后要从现在还活着的
   这份旁表里接回去；删掉的块也先留一份，等那条撤销记录被挤出栈、文件真进回收站了才放手。 */
const pictureCmdBank = new Map();
/* 素材表同理：快照里没有它，回放后不接回来，块上那些 use 就全点不着名，画面当场空一片 */
const pictureSymbolBank = new Map();
/* 场景块里的那堆东西同理：快照不含 parts，回放之后要从现在还活着的这份旁表里接回去 */
const scenePartsBank = new Map();

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
  /* 正文不进 items.json，但撤销要管它：每敲一下都算「有变化」，
     防抖到点落一步历史 */
  history.touch();
  const canvasId = current.meta.id;
  scheduleContentWrite(stickyTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writeSticky(canvasId, item.id, stickyFileOf(target)).catch(showError);
  });
}

function persistNote(item) {
  if (!current || item.type !== "note" || item.linked) return;
  history.touch();
  const canvasId = current.meta.id;
  scheduleContentWrite(noteTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target || target.linked) return;
    store.writeNoteText(canvasId, item.id, target.source || "").catch(showError);
  });
}

/* 画面的指令和素材表只认 pictures/<块id>.json 那一份：items.json 里没有它们，
   全局撤销快照里也没有（见 captureHistory），所以这一句故意不调 history.touch()——
   笔画的撤销归块自己那一层栈管，全局撤销只管这块的位置、尺寸和边框。 */
function persistPicture(item) {
  if (!current || item.type !== "picture") return;
  pictureCmdBank.set(item.id, item.cmds || []);
  pictureSymbolBank.set(item.id, item.symbols || {});
  const canvasId = current.meta.id;
  scheduleContentWrite(pictureTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writePicture(canvasId, item.id, target.cmds || [], target.symbols || {}).catch(showError);
  });
}

/* 场景块里的东西只认 scenes/<块id>.json 那一份：items.json 和全局快照里都没有 parts。
   和画面同一套：全局撤销管这块的位置、尺寸、机位和光，不管里面摆了什么。 */
function persistScene(item) {
  if (!current || item.type !== "scene") return;
  scenePartsBank.set(item.id, item.parts || []);
  const canvasId = current.meta.id;
  scheduleContentWrite(sceneTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writeScene(canvasId, item.id, target.parts || []).catch(showError);
  });
}

/* 面板写的那句话和那几个参数只认 genpanels/<块id>.json 那一份。
   和画面/场景不一样：这几个字段在撤销快照里是有的（captureHistory 只摘 cmds 和 parts），
   所以这里故意不调 history.touch()——回放完直接调这一句把文件追平就够了。
   出的那张图不在这一份里：它和 img 块一样是 images/ 里的真文件，路径记在块上。 */
function persistGen(item) {
  if (!current || item.type !== "gen") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(genTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writeGen(canvasId, item.id, genContentOf(target)).catch(showError);
  });
}

function genContentOf(item) {
  return {
    prompt: item.prompt || "",
    negative: item.negative || "",
    imageW: item.imageW,
    imageH: item.imageH,
    steps: item.steps,
    cfg: item.cfg,
    seed: item.seed,
  };
}

/* 切空间、重命名、退出页面前把还没写完的正文补上，最后一次编辑不至于丢掉 */
async function flushBlockContents() {
  const canvasId = current?.meta.id;
  const pending = [
    ...[...stickyTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "sticky" })),
    ...[...noteTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "note" })),
    ...[...pictureTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "picture" })),
    ...[...sceneTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "scene" })),
    ...[...genTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "gen" })),
  ];
  stickyTimers.clear();
  noteTimers.clear();
  pictureTimers.clear();
  sceneTimers.clear();
  genTimers.clear();
  if (!canvasId) return;
  await Promise.all(
    pending.map(({ timer, itemId, kind }) => {
      clearTimeout(timer);
      const item = findItem(itemId);
      if (!item) return null;
      if (kind === "sticky") return store.writeSticky(canvasId, itemId, stickyFileOf(item)).catch(showError);
      if (kind === "note") return store.writeNoteText(canvasId, itemId, item.source || "").catch(showError);
      if (kind === "picture")
        return store.writePicture(canvasId, itemId, item.cmds || [], item.symbols || {}).catch(showError);
      if (kind === "gen") return store.writeGen(canvasId, itemId, genContentOf(item)).catch(showError);
      return store.writeScene(canvasId, itemId, item.parts || []).catch(showError);
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
      .filter(
        (item) =>
          item.type === "sticky" ||
          (item.type === "note" && !item.linked) ||
          item.type === "picture" ||
          item.type === "scene" ||
          item.type === "gen",
      )
      .map(async (item) => {
        try {
          if (item.type === "sticky") {
            const file = await store.readSticky(canvasId, item.id);
            if (file) applyStickyFile(item, file);
            else await store.writeSticky(canvasId, item.id, stickyFileOf(item));
            return;
          }
          if (item.type === "picture") {
            /* 老数据把指令记在 items.json 的块上，块里还留着：读不到文件就补写一份，
               下一次 items.json 落盘自然把它们清出去 */
            const file = await store.readPicture(canvasId, item.id);
            if (file) {
              /* 素材表先归一化：use 和 tile 漆都靠它才知道名字在不在，
                 认不了的整条丢，和 cmds 一个规矩 */
              item.symbols = normalizePictureSymbols(file.symbols).symbols;
              item.cmds = normalizePictureCmds(file.cmds, PICTURE_MAX_CMDS, { symbols: item.symbols }).cmds;
            } else {
              await store.writePicture(canvasId, item.id, item.cmds || [], item.symbols || {});
            }
            pictureCmdBank.set(item.id, item.cmds || []);
            pictureSymbolBank.set(item.id, item.symbols || {});
            return;
          }
          if (item.type === "scene") {
            /* 老数据把东西记在 items.json 的块上，块里还留着：读不到文件就补写一份，
               下一次 items.json 落盘自然把它们清出去 */
            const file = await store.readScene(canvasId, item.id);
            if (file) {
              /* 盘上那份照样过一遍归一化：手改坏的文件里认不了的那件整件丢，
                 和建块、改块是同一套规矩，不给渲染器递畸形几何 */
              item.parts = normalizeSceneParts(file.parts).parts;
            } else {
              await store.writeScene(canvasId, item.id, item.parts || []);
            }
            scenePartsBank.set(item.id, item.parts || []);
            return;
          }
          if (item.type === "gen") {
            /* 提示词和参数只认这一份文件：读不到就按块上现在那份补写一次 */
            const file = await store.readGen(canvasId, item.id);
            if (file) {
              item.prompt = file.prompt;
              item.negative = file.negative;
              item.imageW = snapGenSize(file.imageW);
              item.imageH = snapGenSize(file.imageH);
              item.steps = Math.min(GEN_STEPS_MAX, Math.max(GEN_STEPS_MIN, file.steps));
              item.cfg = Math.min(GEN_CFG_MAX, Math.max(GEN_CFG_MIN, file.cfg));
              item.seed = Number.isFinite(file.seed) && file.seed >= -1 ? Math.trunc(file.seed) : -1;
            } else {
              await store.writeGen(canvasId, item.id, genContentOf(item));
            }
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

/* ---------- 生图面板 ----------
   上半截取景、下半截一句提示词加一颗按钮。出图发生在 Rust 那边的一根工作线程里，
   这儿只负责起一轮和收事件；面板上不摆「保存」——图一落成就自己进 images/，
   点「落块」才在外面另摆一张独立图片块。 */

const GEN_PLACE_GAP = 24;

/* 这个路径还有谁指着（独立图片块、别的面板各算一个）：回收旧图之前问一句 */
const srcInUse = (src) => Boolean(current) && current.items.some((other) => other.src === src);

function attachGenPanel(el, item) {
  const bar = el.querySelector(".canvas-gen-bar");
  const prompt = el.querySelector(".canvas-gen-prompt");
  const runButton = el.querySelector(".canvas-gen-run");
  const placeButton = el.querySelector(".canvas-gen-place");
  if (!bar || !prompt || !runButton || !placeButton) return;
  /* 提示词框和按钮上的按下不能变成拖整块：整条在 pointerdown 上截住 */
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());
  prompt.addEventListener("input", () => {
    const target = findItem(item.id);
    if (!target) return;
    target.prompt = prompt.value.slice(0, GEN_TEXT_MAX);
    persistGen(target);
  });
  prompt.addEventListener("keydown", (e) => {
    /* 回车这一下是发出去，换行要按 Shift+Enter：框就三行高，写一句话用不着回车 */
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    runOrStopGen(item.id);
  });
  runButton.addEventListener("click", () => runOrStopGen(item.id));
  placeButton.addEventListener("click", () => placeGenImage(item.id));
  /* 上一张出的图跟着块一起回来：运行态记的是「这一轮」，重开空间时从 images/ 里接上 */
  const run = genRunOf(item.id);
  if (run.phase === "idle" && !run.imageUrl && !run.previewUrl && item.src) {
    patchGenRun(item.id, { imageUrl: imageCache.get(item.src) || "" });
  }
  syncGen(el, item);
}

function refreshGenPanel(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (item && el) syncGen(el, item);
}

/* 这一轮没出成：把上一次那张接回来显示。文件还在盘上，取景窗不该空着。 */
function keepLastGenImage(id) {
  const item = findItem(id);
  patchGenRun(id, { imageUrl: item && item.src ? imageCache.get(item.src) || "" : "" });
}

function runOrStopGen(id) {
  const item = findItem(id);
  if (!item || item.type !== "gen" || item.locked) return;
  const run = genRunOf(id);
  if (run.phase === "loading" || run.phase === "running") {
    void stopGen(id);
    return;
  }
  /* 一次一张：别的块在出图就按不动（syncGen 里已经禁用了，这儿再挡一道） */
  if (isGenBusy()) return;
  if (!(item.prompt || "").trim()) {
    showError("先写一句提示词");
    return;
  }
  patchGenRun(id, {
    phase: "loading",
    step: 0,
    steps: item.steps,
    previewUrl: "",
    imageUrl: "",
    error: "",
  });
  refreshGenPanel(id);
  store.genStart({
    block: item.id,
    prompt: item.prompt.trim(),
    negative: item.negative || "",
    width: item.imageW,
    height: item.imageH,
    steps: item.steps,
    cfg: item.cfg,
    seed: item.seed,
  }).catch((error) => {
    const text = String(error?.message || error || "出图失败");
    if (genRunOf(id).phase === "canceled" || text === "已取消") {
      patchGenRun(id, { phase: "canceled" });
    } else {
      patchGenRun(id, { phase: "failed", error: text });
      keepLastGenImage(id);
    }
    refreshGenPanel(id);
  });
}

async function stopGen(id) {
  /* 点了就是停了，先按画面判；后端那边走它的硬取消，不用这儿等 */
  patchGenRun(id, { phase: "canceled" });
  refreshGenPanel(id);
  await store.genCancel().catch(() => {});
}

async function placeGenImage(id) {
  const item = findItem(id);
  const run = genRunOf(id);
  if (!item || !item.src || run.phase === "loading" || run.phase === "running" || !current) return null;
  const canvasId = current.meta.id;
  try {
    /* 落块是复制不是搬走：面板接着显示它那张，图片块自己带一份文件，
       删哪一块都不该把另一块清空 */
    const rel = await store.duplicatePictureImage(canvasId, item.src, false, canvasId);
    if (!current || current.meta.id !== canvasId) return null;
    const url = imageCache.get(rel) || (await store.imageUrl(canvasId, rel, false).catch(() => ""));
    imageCache.set(rel, url || null);
    const size = await imageSize(url || run.imageUrl);
    const fit = fitImageSize(size.width, size.height);
    return placeBlock(makeImage(item.x + item.w + GEN_PLACE_GAP, item.y, fit.w, fit.h, rel));
  } catch (error) {
    showError(error);
    return null;
  }
}

async function onGenDone(payload) {
  const item = findItem(payload.block);
  if (!item) {
    dropGenRun(payload.block);
    return;
  }
  const dataUrl = payload.dataUrl || "";
  patchGenRun(payload.block, {
    phase: dataUrl ? "idle" : "failed",
    step: payload.steps || item.steps,
    seconds: payload.seconds || 0,
    previewUrl: "",
    imageUrl: dataUrl,
    error: dataUrl ? "" : "出图失败：结果是空的",
  });
  refreshGenPanel(payload.block);
  if (!dataUrl) {
    keepLastGenImage(payload.block);
    refreshGenPanel(payload.block);
    return;
  }
  const canvasId = current?.meta.id;
  const comma = dataUrl.indexOf(",");
  if (!canvasId || comma < 0) return;
  try {
    const rel = await store.saveCanvasImage(canvasId, dataUrl.slice(comma + 1), "png");
    if (!current || current.meta.id !== canvasId) return;
    const target = findItem(payload.block);
    if (!target) {
      void store.deleteCanvasImage(canvasId, rel, false).catch(() => {});
      return;
    }
    const old = target.src;
    target.src = rel;
    imageCache.set(rel, dataUrl);
    /* 上一张没人指着了才回收：跟删块同一套，等这条撤销记录挤出栈才真进回收站 */
    if (old && old !== rel) {
      deferFileDelete(canvasId, () => srcInUse(old), () => {
        void store.deleteCanvasImage(canvasId, old, false).catch(() => {});
      });
    }
    scheduleItemsSave();
  } catch (error) {
    showError(error);
  }
}

function setupGenEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  const on = (name, handler) => {
    Promise.resolve(listen(name, (event) => handler(event?.payload))).catch(() => {});
  };
  on("gen-progress", (payload) => {
    if (!payload || !findItem(payload.block)) return;
    patchGenRun(payload.block, { phase: "running", step: payload.step, steps: payload.steps });
    refreshGenPanel(payload.block);
  });
  on("gen-preview", (payload) => {
    if (!payload || !findItem(payload.block)) return;
    patchGenRun(payload.block, {
      phase: "running",
      step: payload.step,
      steps: payload.steps,
      previewUrl: payload.dataUrl || "",
    });
    refreshGenPanel(payload.block);
  });
  on("gen-done", (payload) => {
    if (payload) void onGenDone(payload);
  });
  on("gen-failed", (payload) => {
    if (!payload) return;
    if (!findItem(payload.block)) {
      dropGenRun(payload.block);
      return;
    }
    patchGenRun(payload.block, {
      phase: payload.canceled ? "canceled" : "failed",
      error: payload.error || "",
    });
    keepLastGenImage(payload.block);
    refreshGenPanel(payload.block);
  });
}

/* ---------- 画面块：块内工具条与手绘 ----------
   笔的状态长在块自己身上，不占空间工具栏那套一次性工具态：
   在画面里涂一笔，不该把「选择」的蓝色从工具栏上挤走。
   一块一套笔，加一层只归这块用的撤销栈——笔画不在全局快照里（见 captureHistory），
   全局 Ctrl+Z 管的是这块的位置、尺寸、边框和纸色。 */

const PICTURE_TOOL_LABELS = {
  select: "选择：这一笔完了，挪块缩放回到平常用法",
  pen: "笔：一路等宽",
  brush: "毛笔：走得快细、停住粗",
  eraser: "橡皮：碰到哪笔擦哪笔，一擦一整条",
  color: "墨色",
  width: "笔宽",
  undo: "撤掉这一步笔画",
  redo: "把这一步笔画放回来",
};

/* 图形跟空间工具栏那套一个画法：currentColor 描边、不填色、不加装饰 */
const PICTURE_TOOL_ICONS = {
  select:
    '<path d="M6.4 3.4l7.2 7.2-3.1.4 1.7 3.6-1.6.7-1.7-3.6-2.2 2.2z" fill="currentColor" stroke="none"/>',
  pen: '<path d="M4.6 15.4l1-3.2 6.7-6.7 2.2 2.2-6.7 6.7z"/><path d="M12.6 5.2l2.2 2.2"/>',
  brush:
    '<path d="M4.2 16c3.3-.4 6.2-2.2 8.3-5.1 1.6-2.2 2.8-4.5 2.8-4.5s1 2.5-.6 5.1C12.8 14.7 9.2 16.4 4.2 16.4z" fill="currentColor" stroke="none"/>',
  eraser: '<path d="M5.4 14.4l6-6 3.4 3.4-4.2 4.2H6.6z"/><path d="M9.4 17.4h6.4"/>',
  undo: '<path d="M8.4 6.6L4.8 10l3.6 3.4"/><path d="M4.8 10h8a3 3 0 0 1 0 6h-2"/>',
  redo: '<path d="M11.6 6.6L15.2 10l-3.6 3.4"/><path d="M15.2 10h-8a3 3 0 0 0 0 6h2"/>',
};

const PICTURE_INK_COLORS = ["#1f1f1f", "#a83232", "#1d5c8c", "#2f6b3a", "#8a5a00", "#5a3d7a"];
const PICTURE_WIDTH_STEPS = [2, 4, 8, 14, 24];
const PICTURE_UNDO_LIMIT = 60;
/* 毛笔按速度定宽：这个速度（画面单位）算「停住」，一路快下去就细到四成 */
const PICTURE_BRUSH_SPEED = 22;

/* 块 id -> 这一块的笔和笔画撤销栈。栈里存补丁不存整幅：
   画一笔记一条、擦一笔记被擦掉的那几条，画几百笔也不会像全量快照那样把内存吃穿。 */
const pictureEditors = new Map();

function pictureEditorOf(id) {
  let editor = pictureEditors.get(id);
  if (!editor) {
    editor = {
      tool: "select",
      color: PICTURE_INK_COLORS[0],
      size: PICTURE_WIDTH_STEPS[1],
      undo: [],
      redo: [],
    };
    pictureEditors.set(id, editor);
  }
  return editor;
}

/* 手里正捏着笔的那一块：只认「单选 + 工具不是选择」。
   键盘的 Ctrl+Z 要先问它，才知道这一下是撤笔画还是撤块的位置尺寸。 */
function paintingTarget() {
  if (selectedIds.size !== 1) return null;
  const id = [...selectedIds][0];
  const editor = pictureEditors.get(id);
  if (!editor || editor.tool === "select") return null;
  return findItem(id)?.type === "picture" ? id : null;
}

function pictureButton(kind, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `canvas-picture-btn canvas-picture-${kind}`;
  button.dataset.paint = kind;
  button.title = title;
  button.innerHTML = `<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${
    PICTURE_TOOL_ICONS[kind] || ""
  }</svg>`;
  button.addEventListener("click", (e) => {
    /* 这一按是弹色板/笔宽菜单，不能让 document 上「点外部关面板」的监听当场把它关掉 */
    e.stopPropagation();
    onClick(e, button);
  });
  return button;
}

/* 工具条挂在块元素里，靠 --canvas-inv 反缩放：块缩到很小也点得着，
   跟选中框、缩放手柄同一个脾气（transform-origin 定在贴块的那条边） */
function attachPictureTools(el, item) {
  const bar = document.createElement("div");
  bar.className = "canvas-picture-tools";
  /* 工具条上的按下不能变成拖整块：整条在 pointerdown 上截住 */
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());
  for (const kind of ["select", "pen", "brush", "eraser"]) {
    bar.append(pictureButton(kind, PICTURE_TOOL_LABELS[kind], () => setPictureTool(item.id, kind)));
  }
  const ink = pictureButton("color", PICTURE_TOOL_LABELS.color, (e, button) => openPictureInk(item.id, button));
  ink.innerHTML = '<span class="canvas-picture-ink"></span>';
  const width = pictureButton("width", PICTURE_TOOL_LABELS.width, (e, button) => openPictureWidth(item.id, button));
  width.innerHTML = '<span class="canvas-picture-width"></span>';
  bar.append(ink, width);
  bar.append(
    pictureButton("undo", PICTURE_TOOL_LABELS.undo, () => pictureStepMove(item.id, "undo")),
    pictureButton("redo", PICTURE_TOOL_LABELS.redo, () => pictureStepMove(item.id, "redo")),
  );
  el.append(bar);
  /* 画面区自己收按下：笔要在这儿落墨，不能让这一下冒到舞台上去挪整块 */
  el.querySelector(".canvas-picture-svg")?.addEventListener("pointerdown", (e) => onPicturePointerDown(e, item.id));
  syncPictureChrome(el, item);
}

function syncPictureChrome(el, item) {
  const bar = el.querySelector(".canvas-picture-tools");
  if (!bar) return;
  const editor = pictureEditorOf(item.id);
  /* 锁住的块不供笔：能选、能右键解锁，但不让人往一块钉死的画上落墨 */
  bar.classList.toggle("is-hidden", Boolean(item.locked));
  el.classList.toggle("is-painting", editor.tool !== "select");
  for (const button of bar.querySelectorAll(".canvas-picture-btn")) {
    const kind = button.dataset.paint;
    button.classList.toggle("is-active", kind === editor.tool);
    if (kind === "undo") button.disabled = !editor.undo.length;
    if (kind === "redo") button.disabled = !editor.redo.length;
  }
  const ink = bar.querySelector(".canvas-picture-ink");
  if (ink) ink.style.setProperty("--picture-ink", editor.color);
  const width = bar.querySelector(".canvas-picture-width");
  if (width) width.textContent = String(editor.size);
}

function refreshPictureChrome(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (item && el) syncPictureChrome(el, item);
}

function setPictureTool(id, kind) {
  const item = findItem(id);
  if (!item || item.type !== "picture") return;
  pictureEditorOf(id).tool = kind;
  /* 拿起笔就把这块选中：看得见边界才知道笔落在哪儿 */
  if (kind !== "select" && !selectedIds.has(id)) select(id);
  refreshPictureChrome(id);
}

function openPictureInk(id, button) {
  const rect = button.getBoundingClientRect();
  const editor = pictureEditorOf(id);
  openColorPicker({
    x: rect.right + 6,
    y: rect.top,
    value: editor.color,
    presets: PICTURE_INK_COLORS,
    /* 色点当场跟着动，不用等面板收起 */
    onChange: (color) => {
      if (!color) return;
      editor.color = color;
      refreshPictureChrome(id);
    },
    onDone: (color) => {
      if (color) editor.color = color;
      refreshPictureChrome(id);
    },
  });
}

function openPictureWidth(id, button) {
  const rect = button.getBoundingClientRect();
  const editor = pictureEditorOf(id);
  /* 行尾那根线按这个宽度画，看着就知道落笔多粗；前面的数字是精确值 */
  openMenu(
    rect.right + 6,
    rect.top - 4,
    PICTURE_WIDTH_STEPS.map((size) => ({
      label: `${size}`,
      trailing: `<svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true"><path d="M3 7h14" stroke="currentColor" stroke-width="${Math.min(size, 12)}" stroke-linecap="round"/></svg>`,
      onClick: () => {
        editor.size = size;
        refreshPictureChrome(id);
      },
    })),
  );
}

/* ---------- 块内那层笔画栈 ---------- */

function pushPictureStep(id, step) {
  const editor = pictureEditorOf(id);
  editor.undo.push(step);
  if (editor.undo.length > PICTURE_UNDO_LIMIT) editor.undo.shift();
  editor.redo.length = 0;
}

/* reverse=true 是把这一步撤掉：放进去的摘出来、摘掉的按原位放回 */
function applyPictureStep(item, step, reverse) {
  const gone = reverse ? step.added : step.removed;
  const back = reverse ? step.removed : step.added;
  const ids = new Set(gone.map((entry) => entry.cmd.i));
  const cmds = (item.cmds || []).filter((cmd) => !ids.has(cmd.i));
  for (const entry of [...back].sort((a, b) => a.index - b.index)) {
    cmds.splice(Math.min(entry.index, cmds.length), 0, entry.cmd);
  }
  item.cmds = cmds;
}

function pictureStepMove(id, direction) {
  const item = findItem(id);
  if (!item || item.type !== "picture") return;
  const editor = pictureEditorOf(id);
  const from = direction === "undo" ? editor.undo : editor.redo;
  const to = direction === "undo" ? editor.redo : editor.undo;
  const step = from.pop();
  if (!step) return;
  applyPictureStep(item, step, direction === "undo");
  to.push(step);
  pictureAfterChange(id);
}

function pictureAfterChange(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  syncItemElement(el, item);
  persistPicture(item);
  refreshPictureChrome(id);
}

/* ---------- 落笔 ---------- */

/* 块内画面坐标：块的左上角就是原点，所以能出现负数、也能画到框外面 */
function picturePointAt(item, clientX, clientY) {
  const world = clientToWorld(clientX, clientY);
  return { x: Math.round(world.x - item.x), y: Math.round(world.y - item.y) };
}

/* 毛笔的宽度：有真实笔压就按压力，没有就按走得快慢——快细慢粗，跟提按一个意思 */
function brushWidthAt(size, speedWorld, pressure) {
  const target =
    pressure > 0 && pressure !== 0.5
      ? size * (0.3 + pressure * 1.4)
      : size * (1.45 - Math.min(1, speedWorld / PICTURE_BRUSH_SPEED) * 1.05);
  return Math.round(Math.min(PICTURE_STROKE_WIDTH_MAX, Math.max(PICTURE_STROKE_WIDTH_MIN, target)) * 10) / 10;
}

function paintPreview(item, gesture) {
  const el = itemEls.get(gesture.id);
  /* 只认 svg 的直接子节点：defs 里那些素材实例也是 <g>，
     按标签名找会把预览笔画塞进素材定义里，每一个 use 都跟着多出一笔 */
  const body = el?.querySelector(".canvas-picture-svg")?.querySelector(":scope > g");
  if (!body) return;
  gesture.preview?.remove();
  const node = renderPictureCmd({
    op: "stroke",
    i: -1,
    points: gesture.points,
    color: gesture.color,
    size: gesture.size,
    kind: gesture.kind2,
    opacity: 1,
  });
  if (!node) return;
  node.classList.add("canvas-picture-preview");
  body.append(node);
  gesture.preview = node;
}

function onPicturePointerDown(e, id) {
  if (!active || !current || e.button !== 0) return;
  const item = findItem(id);
  if (!item || item.type !== "picture" || item.locked) return;
  const editor = pictureEditorOf(id);
  /* 选择态什么都不拦：这一下该冒到舞台上去选中、挪块 */
  if (editor.tool === "select") return;
  /* 落笔先把上一次操作收尾：正编辑的文字、开着的菜单和色板。
     这一下按在画面里，svg 拦住了冒泡，那些「点外面就收起」的监听收不到，得自己关。
     色板要先关再取墨色——关的那一刻才落 onDone，新挑的颜色这时候才算进 editor。 */
  if (editingId) commitEditing();
  closeColorPicker(true);
  closeMenu();
  e.preventDefault();
  e.stopPropagation();
  /* 舞台那一层的按下没跑到，它那句 hold(true) 也没机会执行，这儿自己挂上 */
  history.hold(true);
  if (!selectedIds.has(id)) select(id);
  const point = picturePointAt(item, e.clientX, e.clientY);
  drag = {
    kind: "paint",
    id,
    tool: editor.tool,
    color: editor.color,
    size: editor.size,
    kind2: editor.tool === "brush" ? "brush" : "pen",
    lastClient: { x: e.clientX, y: e.clientY },
    points: editor.tool === "eraser" ? [] : [{ ...point, ...(editor.tool === "brush" ? { w: editor.size } : {}) }],
    hit: [],
    preview: null,
    width: editor.size,
    /* 橡皮按屏幕距离算命中：缩得再小，也还是那根手指好点的那一段 */
    tolerance: PICTURE_ERASER_TOLERANCE / current.camera.scale,
    moved: false,
  };
  if (editor.tool === "eraser") eraseAlong(item, point, drag);
  else paintPreview(item, drag);
}

/* 橡皮：命中的几条当场藏起来，松手才真删——中途看着像擦掉了，反悔挪出去还能还原。
   按图层开关投影过的那一份判命中：关掉的层根本没画，能擦到就是「看不见却擦得到」。
   记进栈的还是原始那条和它原来的下标——撤销要把它插回原位，投影后的下标对不上盘上的数据。 */
function eraseAlong(item, point, gesture) {
  const el = itemEls.get(gesture.id);
  const ctx = { symbols: item.symbols || null };
  pictureTopLayers(item.cmds, item.hidden).forEach(({ cmd, drawn }, index) => {
    if (!drawn) return;
    if (!pictureCmdHit(drawn, point, gesture.tolerance, ctx) || gesture.hit.some((one) => one.cmd.i === cmd.i)) return;
    gesture.hit.push({ index, cmd });
    el?.querySelector(`[data-cmd="${cmd.i}"]`)?.setAttribute("visibility", "hidden");
  });
}

function onPaintPointerMove(e) {
  const gesture = drag;
  const item = findItem(gesture.id);
  if (!item) return;
  const point = picturePointAt(item, e.clientX, e.clientY);
  gesture.moved = true;
  if (gesture.tool === "eraser") {
    eraseAlong(item, point, gesture);
    return;
  }
  /* 相邻两点的间距按屏幕算：放大画就采得密、缩小画就采得疏，手感一致、点数可控 */
  const minStep = PICTURE_STROKE_MIN_STEP / current.camera.scale;
  const last = gesture.points[gesture.points.length - 1];
  const step = Math.hypot(point.x - last.x, point.y - last.y);
  if (step < minStep) return;
  const speed = Math.hypot(e.clientX - gesture.lastClient.x, e.clientY - gesture.lastClient.y) / current.camera.scale;
  gesture.lastClient = { x: e.clientX, y: e.clientY };
  let next = { ...point };
  if (gesture.kind2 === "brush") {
    const target = brushWidthAt(gesture.size, speed, Number(e.pressure) || 0);
    /* 新宽度向旧的靠一靠：不然手一抖就在笔迹上跳出一个突然的胖节 */
    gesture.width = clamp(gesture.width * 0.55 + target * 0.45, PICTURE_STROKE_WIDTH_MIN, PICTURE_STROKE_WIDTH_MAX);
    next.w = Math.round(gesture.width * 10) / 10;
  }
  gesture.points.push(next);
  paintPreview(item, gesture);
}

function finishPaint(finished) {
  const item = findItem(finished.id);
  const el = itemEls.get(finished.id);
  if (!item || !el) return;
  finished.preview?.remove();
  for (const node of el.querySelectorAll('[visibility="hidden"]')) node.removeAttribute("visibility");
  if (finished.tool === "eraser") {
    if (!finished.hit.length) return;
    const ids = new Set(finished.hit.map((entry) => entry.cmd.i));
    item.cmds = (item.cmds || []).filter((cmd) => !ids.has(cmd.i));
    pushPictureStep(finished.id, { added: [], removed: finished.hit });
  } else {
    if (!finished.points.length) return;
    const top = (item.cmds || []).reduce((max, cmd) => Math.max(max, Number(cmd.i) || 0), 0);
    const cmd = normalizePictureCmd({
      op: "stroke",
      points: finished.points,
      color: finished.color,
      size: finished.size,
      kind: finished.kind2,
    }).cmd;
    if (!cmd) return;
    cmd.i = top + 1;
    item.cmds = [...(item.cmds || []), cmd];
    pushPictureStep(finished.id, { added: [{ index: item.cmds.length - 1, cmd }], removed: [] });
  }
  pictureAfterChange(finished.id);
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

  if (item.type === "picture") {
    /* 垫进画面的位图跟着块走：粘到哪儿就在哪儿落一份自己的副本，
       引用本机绝对路径的那种也一并收进空间——不然换个空间就只剩虚线框。
       拷不动的那几张不改写，块照粘、画出来是占位框，报一句就行：
       几百条矢量指令不该被一张丢了的原图连累得整块粘不出来。 */
    const map = new Map();
    let lost = 0;
    for (const ref of collectPictureImageSrcs(item.cmds, item.symbols)) {
      const rel = await store
        .duplicatePictureImage(fromId, ref.src, ref.linked, canvasId)
        .catch(() => "");
      if (rel) map.set(ref.src, rel);
      else lost += 1;
    }
    remapPictureImageSrcs(item.cmds, item.symbols, map);
    /* 新副本先取一次地址进缓存：粘完画的第一遍就是真图，不用等下一轮加载 */
    for (const rel of map.values()) {
      try {
        imageCache.set(rel, await store.imageUrl(canvasId, rel, false));
      } catch {
        imageCache.set(rel, null);
      }
    }
    if (lost) showError(`这块垫的位图有 ${lost} 张拷不动（原文件已经不在了），粘过去的那部分是虚线占位框`);
    return true;
  }

  if (item.type === "gen") {
    /* 面板出的那张图跟着块落一份自己的副本：删原块不该把粘出来的那块一起清空。
       这条命令就是「把源空间 images/ 里的那个文件拷进目标空间」，画面块也用同一份 */
    if (item.src) {
      const rel = await store
        .duplicatePictureImage(fromId, item.src, false, canvasId)
        .catch(() => "");
      if (rel) {
        item.src = rel;
        try {
          imageCache.set(rel, await store.imageUrl(canvasId, rel, false));
        } catch {
          imageCache.set(rel, null);
        }
      }
    }
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

/* 量一张图多大。读不出来时给个兜底的框是图片块用的（宁可先摆个空卡片），
   画面里垫的参考图宁可报失败也不能编一个尺寸出来，所以兜底值由调用方给。 */
function imageSize(src, fallback = { width: 320, height: 200 }) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(fallback);
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
  /* 便签/笔记/画面/场景从建下来那一刻就有自己那份文件，内容以后只认文件 */
  if (item.type === "sticky") persistSticky(item);
  if (item.type === "note") persistNote(item);
  if (item.type === "picture") persistPicture(item);
  if (item.type === "scene") persistScene(item);
  if (item.type === "gen") persistGen(item);
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
  /* Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y 也行）：撤销、重做画布上的操作。
     焦点在输入框/正文里时上面已经 return 了，那里归浏览器自己的撤销管。 */
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    /* 手里正捏着笔的那块：这一下归笔画栈，不该跳到块的位置尺寸上去 */
    const id = paintingTarget();
    if (id) {
      pictureStepMove(id, e.shiftKey ? "redo" : "undo");
      return;
    }
    if (e.shiftKey) redoHistory();
    else undoHistory();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    const id = paintingTarget();
    if (id) pictureStepMove(id, "redo");
    else redoHistory();
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
  /* 每一次会改块的操作都会走到这儿，撤销栈挂在这一句上，
     不用去每个动作里各记一笔 */
  history.touch();
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
  const base = {
    id: item.id,
    type: item.type,
    z: Number.isFinite(item.z) ? item.z : null,
    locked: Boolean(item.locked),
  };
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
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "rect" || item.type === "ellipse") {
    return {
      ...base,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "line" || item.type === "arrow") {
    return { ...base, x2: item.x2, y2: item.y2, borderColor: item.borderColor };
  }
  if (item.type === "sticky") {
    return {
      ...base,
      text: item.text,
      color: item.color,
      textColor: item.textColor,
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "picture") {
    return {
      ...base,
      cmds: Array.isArray(item.cmds) ? item.cmds.length : 0,
      hidden: Array.isArray(item.hidden) ? item.hidden : [],
      light: item.light || null,
      paperColor: item.paperColor || "",
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "scene") {
    return {
      ...base,
      /* 件数报成一个数，和画面块报 cmds 条数同一个口径：整份 parts 塞进摘要会把 space_scene 撑爆 */
      parts: Array.isArray(item.parts) ? item.parts.length : 0,
      camera: item.camera || null,
      light: item.light || null,
      groundColor: item.groundColor || "",
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "gen") {
    /* 这一轮的相位在这儿一并报：等一张图的时候 agent 得问得出「还在跑」 */
    const run = genRunOf(item.id);
    return {
      ...base,
      prompt: item.prompt || "",
      negative: item.negative || "",
      imageW: item.imageW,
      imageH: item.imageH,
      steps: item.steps,
      cfg: item.cfg,
      seed: item.seed,
      src: item.src || "",
      phase: run.phase,
      step: run.step,
      seconds: run.phase === "idle" ? run.seconds : 0,
      error: run.phase === "failed" ? run.error || "" : "",
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
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
      borderWidth: item.borderWidth,
      radius: item.radius,
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
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "ebook") {
    return { ...base, name: item.name, linked: item.linked, chapter: item.chapter };
  }
  if (item.type === "image") {
    return {
      ...base,
      src: item.src,
      linked: item.linked,
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "audio" || item.type === "video") {
    return { ...base, name: item.name, src: item.src, linked: item.linked };
  }
  return base;
}

/* 演示用的光带：只加一圈外发光，不动块自己的颜色和尺寸 */
/* 批量模式：agent 一次提交一串操作时打开。
   这期间不运镜、不打光带——一个块一次镜头跳动，看的人只会晕。
   撤销也靠 history.hold 挂住，整批落成一步。 */
let batching = false;

function agentHighlight(ids, ms = 900) {
  /* 批量里每一项都打一圈光带只是噪音：等整批做完再说 */
  if (batching) return;
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
  /* 批量铺东西时镜头不该跟着每个块跳：整批完成后用户自己看一眼就够 */
  if (batching) return false;
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
  const locked = spec.locked === true;
  const withLock = (item) => {
    if (locked) item.locked = true;
    return item;
  };

  if (type === "text") {
    const w = Math.max(40, numOr(spec.w, TEXT_DEFAULT_WIDTH));
    const at = agentPlacePoint(w, 24, spec);
    const item = withLock(makeText(at.x, at.y, w));
    item.text = String(spec.text ?? "");
    item.fontSize = clamp(Math.round(numOr(spec.fontSize, item.fontSize)), 8, 200);
    if (spec.borderColor !== undefined) {
      item.borderColor = String(spec.borderColor || "");
      item.bordered = Boolean(item.borderColor);
    }
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (spec.color !== undefined) item.color = String(spec.color || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    const placed = placeBlock(item);
    if (!placed) throw new Error("这块没落进空间");
    return agentSummary(placed);
  }

  if (type === "rect" || type === "ellipse") {
    const w = Math.max(8, numOr(spec.w, 240));
    const h = Math.max(8, numOr(spec.h, 120));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makeBox(type, at.x, at.y, at.x + w, at.y + h));
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, BORDER_DEFAULT_WIDTH)), 0, BORDER_MAX_WIDTH);
    }
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
    const item = withLock(makeLine(type, x1, y1, x2, y2));
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "sticky") {
    const w = Math.max(STICKY_MIN_WIDTH, numOr(spec.w, 280));
    const h = Math.max(STICKY_MIN_HEIGHT, numOr(spec.h, 280));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makeSticky(at.x, at.y, String(spec.text ?? "")));
    item.w = w;
    item.h = h;
    if (spec.color) item.color = String(spec.color);
    if (spec.textColor) item.textColor = String(spec.textColor);
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "picture") {
    const w = Math.max(PICTURE_MIN_WIDTH, numOr(spec.w, PICTURE_DEFAULT_WIDTH));
    const h = Math.max(PICTURE_MIN_HEIGHT, numOr(spec.h, PICTURE_DEFAULT_HEIGHT));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makePicture(at.x, at.y, w, h));
    if (spec.paperColor) item.paperColor = String(spec.paperColor);
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    /* 素材和指令得一起发来才认得 use：先把表立起来，再归一化 cmds。
       垫的那张位图先在这一步拷进来、量好尺寸，归一化才有的可认 */
    await resolvePictureImages(spec, canvasId);
    const table = normalizePictureSymbols(spec.symbols);
    item.symbols = table.symbols;
    const result = normalizePictureCmds(spec.cmds, PICTURE_MAX_CMDS, { symbols: item.symbols });
    item.cmds = result.cmds;
    const dropped = [...table.dropped, ...result.dropped];
    rejectFatalDrop(dropped);
    const placed = placeBlock(item);
    return dropped.length ? { ...agentSummary(placed), dropped } : agentSummary(placed);
  }

  if (type === "scene") {
    const w = Math.max(SCENE_MIN_WIDTH, numOr(spec.w, SCENE_DEFAULT_WIDTH));
    const h = Math.max(SCENE_MIN_HEIGHT, numOr(spec.h, SCENE_DEFAULT_HEIGHT));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makeScene(at.x, at.y, w, h));
    if (spec.groundColor) item.groundColor = String(spec.groundColor);
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    const parts = normalizeSceneParts(spec.parts);
    item.parts = parts.parts;
    const light = normalizeLight(spec.light);
    if (light.why) throw new Error(light.why);
    item.light = light.light;
    item.camera = normalizeSceneCamera(spec.camera);
    /* 一件东西写歪（尺寸不是正数、op 不认）整件丢掉并说清是第几件——
       静默少一栋楼，agent 下一轮根本不知道自己写错了 */
    rejectFatalDrop(parts.dropped);
    return agentSummary(placeBlock(item));
  }

  if (type === "gen") {
    const w = Math.max(GEN_MIN_WIDTH, numOr(spec.w, GEN_DEFAULT_WIDTH));
    const h = Math.max(GEN_MIN_HEIGHT, numOr(spec.h, GEN_DEFAULT_HEIGHT));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makeGen(at.x, at.y, w, h));
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    applyGenFields(item, spec);
    const placed = placeBlock(item);
    /* 提示词和参数归 genpanels/ 那份文件管，建完就得落盘：只等 scheduleItemsSave 的话，
       items.json 里根本没有这几个字段 */
    persistGen(placed);
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
    const item = withLock(makeNote(at.x, at.y, "", name, markdown));
    item.w = w;
    item.h = h;
    if (spec.notePath) item.assets = await snapshotNoteImages(canvasId, item);
    if (!current || current.meta.id !== canvasId) throw new Error("插笔记时空间被切走了");
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
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
    /* 只有图片和文件有边框外观，音视频和电子书不接这两个字段 */
    const extra = {};
    if (type === "image" || type === "file") {
      if (spec.borderWidth !== undefined) extra.borderWidth = spec.borderWidth;
      if (spec.radius !== undefined) extra.radius = spec.radius;
    }
    if (locked) extra.locked = true;
    if (Object.keys(extra).length) return agentUpdateBlock(placed.id, extra);
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
  if (item.locked) throw new Error("这块已锁定，先解锁再删");
  const summary = agentSummary(item);
  deleteItems([item.id]);
  return summary;
}

async function agentDuplicateBlock(id, patch = {}) {
  agentRequireSpace();
  const source = agentRequireItem(id);
  if (source.type === "connector") throw new Error("连线不复制，直接重新连一条");
  if (editingId || edgeLabelEditor) commitEditing();
  /* 换空间复制是让另一个空间的落盘记录去取文件，防抖里那点改动必须先催下去；
     同空间复制沿用原来的口径：只有笔记要催（副本读的是它那份 .md 和图片目录）。 */
  const wanted = String(patch.space ?? "").trim();
  const target = wanted ? await agentFindSpace(wanted) : null;
  const elsewhere = Boolean(target && target.id !== current.meta.id);
  if (elsewhere) await Promise.all([flushItems(), flushBlockContents()]);
  else if (source.type === "note" && !source.linked) await flushBlockContents();
  const raw = JSON.parse(JSON.stringify(source));
  const fromId = current.meta.id;
  const sourceId = source.id;
  if (elsewhere) await agentOpenSpace(target.id);
  const item = normalizeItem({ ...raw, id: newId(), z: null });
  if (!item) throw new Error("这块没法复制");
  if (elsewhere) {
    /* 目标空间没有「原块右下一格」这回事：给了落点就照着摆，没给就摆在镜头正中 */
    const point =
      Number.isFinite(Number(patch.x)) && Number.isFinite(Number(patch.y))
        ? { x: Number(patch.x), y: Number(patch.y) }
        : stageCenterWorld();
    item.x = Math.round(point.x);
    item.y = Math.round(point.y);
    if (item.type === "line" || item.type === "arrow") {
      item.x2 = item.x + Math.round(numOr(raw.x2, raw.x) - numOr(raw.x, 0));
      item.y2 = item.y + Math.round(numOr(raw.y2, raw.y) - numOr(raw.y, 0));
    }
  } else {
    const dx = numOr(patch.dx, 24);
    const dy = numOr(patch.dy, 24);
    item.x += dx;
    item.y += dy;
    if (item.type === "line" || item.type === "arrow") {
      item.x2 += dx;
      item.y2 += dy;
    }
  }
  const ok = await landBlock(item, fromId, sourceId);
  if (!ok) throw new Error("复制失败：源文件已经不在了");
  const placed = placeBlock(item);
  return elsewhere ? { ...agentSummary(placed), space: { id: target.id, name: target.name } } : agentSummary(placed);
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
  if (item.locked) throw new Error("这块已锁定，先解锁再改层级");
  const map = { up: 1, down: -1, top: "top", bottom: "bottom" };
  const dir = map[String(direction)];
  if (dir === undefined) throw new Error("direction 只能是 up / down / top / bottom");
  moveLayer(item, dir);
  return agentSummary(item);
}

/* 边框宽度/圆角按块类型认：连线和不带边框外观的音视频、电子书不接 */
const BORDER_WIDTH_KINDS = new Set(["text", "rect", "ellipse", "image", "sticky", "note", "file", "picture", "scene", "gen"]);

async function agentUpdateBlock(id, patch = {}) {
  const item = agentRequireItem(id);
  if (item.type === "connector") return agentUpdateConnector(item, patch);
  /* 画面里垫的那张位图要先拷进空间、量好尺寸，归一化才认得这条 image。
     这一步放在任何改动落地之前：拷不动就抛，块还是原来那块，不会留下改到一半的样子 */
  const canvasId = current.meta.id;
  if (item.type === "picture" && (patch.cmds !== undefined || patch.symbols !== undefined)) {
    await resolvePictureImages(patch, canvasId);
    if (!current || current.meta.id !== canvasId) throw new Error("改这块的时候空间被切走了，什么都没改");
  }
  /* 锁住的块只认解锁（可以顺带在同一次 patch 里改别的）；其余修改先解锁 */
  const unlocking = patch.locked === false;
  if (item.locked && !unlocking && Object.keys(patch).some((key) => key !== "locked")) {
    throw new Error("这块已锁定，先解锁再改");
  }
  if (patch.locked !== undefined) item.locked = patch.locked === true;
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
  if (patch.radius !== undefined && item.type !== "ellipse" && BORDER_WIDTH_KINDS.has(item.type)) {
    item.radius = Math.max(0, Math.round(numOr(patch.radius, item.radius)));
  }
  if (patch.borderWidth !== undefined && BORDER_WIDTH_KINDS.has(item.type)) {
    item.borderWidth = clamp(Math.round(numOr(patch.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
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
  let pictureDropped = [];
  if (item.type === "picture" && (patch.cmds !== undefined || patch.symbols !== undefined)) {
    /* 素材并表只算新表，指令归一化通过了才一起换上 */
    const merged =
      patch.symbols === undefined ? null : mergePictureSymbols(item, patch.symbols, Array.isArray(patch.cmds) ? patch.cmds : item.cmds);
    const symbols = merged ? merged.symbols : item.symbols || {};
    /* 带着这块自己的素材表过一遍：不带的话 use 全成了点不着名的孤儿，一条不剩 */
    const wanted = Array.isArray(patch.cmds) ? patch.cmds : item.cmds || [];
    const result = normalizePictureCmds(wanted, PICTURE_MAX_CMDS, { symbols });
    /* 没给 cmds、只动了素材的那次，归一化的就是块上原有这一串——洗掉任何一条都得拒 */
    if (patch.cmds === undefined) pictureWashed(result, wanted.length, wanted);
    pictureDropped = [...(merged ? merged.dropped : []), ...result.dropped];
    rejectFatalDrop(pictureDropped);
    item.cmds = result.cmds;
    if (merged) item.symbols = merged.symbols;
    /* 指令和素材不归 items.json 管，改了就单独落那份文件 */
    persistPicture(item);
  }
  if (item.type === "picture" && patch.paperColor !== undefined) {
    item.paperColor = String(patch.paperColor || "");
  }
  /* 图层开关也是块上的属性，和纸色并一处；写在指令之后：那一头抛了错这块不该半改 */
  if (item.type === "picture" && patch.hidden !== undefined) {
    const got = normalizeHidden(patch.hidden);
    if (got.why) throw new Error(got.why);
    item.hidden = got.hidden;
  }
  /* 一套光也是块上的属性：指令里存的永远是固有色，改光不许动任何一条指令 */
  if (item.type === "picture" && patch.light !== undefined) {
    const got = normalizeLight(patch.light);
    if (got.why) throw new Error(got.why);
    item.light = got.light;
  }
  /* 场景块的三样：里面的东西、机位、地面色。光那一套字段和画面块共用同一个约定。 */
  if (item.type === "scene" && patch.parts !== undefined) {
    const got = normalizeSceneParts(patch.parts);
    rejectFatalDrop(got.dropped);
    item.parts = got.parts;
    /* 东西不归 items.json 管，改了就单独落那份文件 */
    persistScene(item);
  }
  if (item.type === "scene" && patch.camera !== undefined) {
    /* 写成 null 就是「机位没定过」，下一次按内容重新框 */
    item.camera = normalizeSceneCamera(patch.camera);
  }
  if (item.type === "scene" && patch.groundColor !== undefined) {
    item.groundColor = String(patch.groundColor || "");
  }
  if (item.type === "scene" && patch.light !== undefined) {
    const got = normalizeLight(patch.light);
    if (got.why) throw new Error(got.why);
    item.light = got.light;
  }
  /* 生图面板的参数也在这条路上改：改完单独落那份文件，和画面块一个规矩 */
  if (item.type === "gen" && applyGenFields(item, patch)) persistGen(item);
  if (el) syncItemElement(el, item);
  if (geometry) {
    updateSelection();
    refreshConnectors();
  }
  scheduleItemsSave();
  if (item.type === "sticky") persistSticky(item);
  if (item.type === "note" && patch.borderColor !== undefined) void persistNote(item);
  return pictureDropped.length ? { ...agentSummary(item), dropped: pictureDropped } : agentSummary(item);
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

async function agentStickyWrite(id, patch = {}) {
  const item = agentStickyOf(id);
  agentHighlight([item.id]);
  return agentUpdateBlock(item.id, patch);
}

function agentPictureOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "picture") throw new Error("这不是画面块");
  return item;
}

/* 这块有哪几层：同名指令算一层（几笔一起开关就包一层 group 起同名），组里起了名的那笔也算。
   没起名的指令单独报个数——agent 得知道自己画的有多少还没成组，不然会以为整幅就这几层。 */
function pictureLayersOf(item) {
  const hidden = Array.isArray(item.hidden) ? item.hidden : [];
  const census = pictureLayerCensus(item.cmds);
  return {
    layers: census.order.map((name) => ({ name, cmds: census.counts.get(name), hidden: hidden.includes(name) })),
    unnamed: census.unnamed,
    hidden,
  };
}

/* 这块有多少笔声明了朝向（组里、素材表里的都算）：一条都没声明的话打光等于没打，
   截图看不出变化。报给 agent，别让它对着一张「光没生效」的画面瞎猜是自己画歪了。 */
function pictureFaceCount(item) {
  let n = 0;
  const walk = (list) => {
    for (const cmd of Array.isArray(list) ? list : []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.face) n += 1;
      if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(item.cmds);
  for (const symbol of Object.values(item.symbols || {})) walk(symbol?.cmds);
  return n;
}

function agentPictureGet(id) {
  const item = agentPictureOf(id);
  const cmds = Array.isArray(item.cmds) ? item.cmds : [];
  const symbols = item.symbols || {};
  const expanded = normalizePictureCmds(cmds, PICTURE_MAX_CMDS, { symbols }).expanded;
  const drawn = pictureTopLayers(cmds, item.hidden).filter((one) => one.drawn).length;
  return {
    ...agentSummary(item),
    paperColor: item.paperColor || "",
    cmds,
    /* 素材表整个交回去：use 只记一个名字，看不到名字背后是什么就没法接着画 */
    symbols,
    /* 一条 use 顶一整个素材，所以除了条数还要报展开后多少个节点 */
    expanded,
    symbolNames: Object.keys(symbols),
    /* 图层开关：hidden 是关着的层名，layers 是这块现有的层，drawn 是真画出来的条数（不等于 cmds 的条数） */
    hidden: Array.isArray(item.hidden) ? item.hidden : [],
    layers: pictureLayersOf(item).layers,
    drawn,
    /* 一套光：light 是这块的光，faced 是有多少笔声明了朝向。
       回读的 cmds 里颜色是固有色，屏幕上看到的是打过光的——对不上不是画丢了 */
    light: item.light || null,
    faced: pictureFaceCount(item),
    /* 块自身的左上角就是画面坐标原点；框外的部分不显示但数据还在，拉大块就露出来 */
    frame: { x: Math.round(item.x), y: Math.round(item.y), w: Math.round(item.w), h: Math.round(item.h) },
    limit: PICTURE_MAX_CMDS,
    expandedLimit: PICTURE_MAX_EXPANDED,
  };
}

/* 素材表并进块里现有的那一份：给了定义就按名字盖上去，值给 null 就是删掉它。
   这里只算出新表返回，不改 item —— 调用方要等指令也归一化通过了再落手，
   半途抛错的话块上会留下改了一半的素材表。
   还有指令在用的素材不许删：悄悄把那些实例一起抹掉，等于少写一个字段就丢一片画。
   数的是 incoming（这次请求结束后要留在块上的那一串），不是 item.cmds ——
   同批把用到它的指令一起撤掉的那种请求本来就干净，拦它就是把人逼成两次调用。
   没并进去的定义（名字不对、里面一条指令都不成立）报回去，旧的照原样留着。 */
function mergePictureSymbols(item, given, incoming) {
  if (!given || typeof given !== "object" || Array.isArray(given)) {
    throw new Error('symbols 得是一个 {"名字":{cmds:[...]}} 对象；要删素材就把这个名的值写成 null');
  }
  const table = normalizePictureSymbols(given);
  /* 空原型：素材名是调用方给的，"__proto__" 往普通对象上塞会改掉原型链 */
  const next = Object.assign(Object.create(null), item.symbols || {});
  for (const key of Object.keys(given)) {
    const name = String(key).trim();
    if (!name) continue;
    if (given[key] == null) {
      const used = pictureSymbolUses(incoming ?? item.cmds, name);
      if (used) {
        throw new Error(`素材「${name}」还有 ${used} 处在用（use 摆的、tile 平铺铺的、clip / mask 当剪刀的），删了它们就空了：把用到它们的指令一起去掉（mode:"delete" 或整幅 replace）再删这个素材`);
      }
      delete next[name];
    } else if (table.symbols[name]) {
      next[name] = table.symbols[name];
    }
  }
  const merged = normalizePictureSymbols(next);
  /* 新并的、和整表重归一化时被掉的，都得报出去——不报就是「你说存好了，其实没存」 */
  return { symbols: merged.symbols, dropped: [...table.dropped, ...merged.dropped] };
}

/* 有多少地方在用这个素材：use 摆的一份、tile 图案铺的一份、当剪刀使的一份都算。
   图案漆里的 tile 也认素材名，只看 use 会漏——漏了就是一次悄悄丢指令。
   剪刀漏了更难看：素材一删，那条的 clip 就剪不出形，被遮住的那片画会凭空露出来。 */
function pictureSymbolUses(cmds, name) {
  let uses = 0;
  const tiled = (paint) =>
    paint && typeof paint === "object" && paint.type === "pattern" && paint.pattern === "tile" && paint.ref === name;
  const cut = (shape) => shape && typeof shape === "object" && shape.ref === name;
  const walk = (list) => {
    for (const cmd of list || []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.op === "use" && cmd.ref === name) uses += 1;
      if (tiled(cmd.fill) || tiled(cmd.stroke)) uses += 1;
      if (cut(cmd.clip) || cut(cmd.mask) || tiled(cmd.mask?.fill)) uses += 1;
      if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(cmds);
  return uses;
}

/* 画面里垫一张位图，发过来最常见的两种写法是「只有本机路径」和「没写多大」。
   归一化那一步是同步的、量不了图，所以三个写入口（block_create / block_update / picture_draw）
   先异步补一圈：写了 path 的拷进这个空间、把回来的相对路径填进 src；w / h 缺的照原图量。
   拷不动、量不出都直接抛——悄悄少一块画，调用方会以为画面本来就该长这样。
   地址顺手放进 imageCache，画的第一遍就是真图，不用等下一次重画。
   src 自己写坏了的这里不动它，留给归一化去说那句 why（它会进返回的 dropped，比抛错好定位）。 */
async function resolvePictureImages(spec, canvasId) {
  const found = [];
  const walk = (list) => {
    for (const cmd of list || []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.op === "image") found.push(cmd);
      else if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(spec.cmds);
  for (const symbol of Object.values(spec.symbols || {})) walk(symbol && symbol.cmds);
  for (const cmd of found) {
    const path = String(cmd.path || "").trim();
    const needsSize = !(Number(cmd.w) > 0 && Number(cmd.h) > 0);
    let parsed = pictureImageSrc(cmd.src);
    if (path) {
      if (!IMAGE_EXTS.has(fileExt(path))) {
        throw new Error(`垫进画面的 path 得是一张图片（「${path.slice(0, 40)}」不是）——要放文档就另建一个文件块`);
      }
      let rel = "";
      try {
        rel = await store.importCanvasImage(canvasId, path);
      } catch (error) {
        throw new Error(`没能把「${path.slice(0, 48)}」拷进这个空间：${error?.message || error}`);
      }
      parsed = pictureImageSrc(rel);
    }
    if (parsed.why) continue;
    cmd.src = parsed.src;
    let url = imageCache.get(parsed.src) || "";
    if (!url) {
      try {
        url = await store.imageUrl(canvasId, parsed.src, parsed.linked);
      } catch (error) {
        throw new Error(`读不到这张垫图：${parsed.src}——${error?.message || error}`);
      }
    }
    if (!current || current.meta.id !== canvasId) throw new Error("垫图进画面的时候空间被切走了");
    imageCache.set(parsed.src, url);
    if (!needsSize) continue;
    const size = await imageSize(url, null);
    if (!size || !size.width || !size.height) {
      throw new Error(
        `量不出这张图有多大：${parsed.src}——原文件可能读不出来或已经不是图片了；自己写上 w 和 h 就能垫进去`,
      );
    }
    cmd.w = Math.round(size.width);
    cmd.h = Math.round(size.height);
  }
}

/* 已经画好的指令在这轮归一化里没过 = 这一笔会把画好的东西洗掉（多半是它用的素材被删了）。
   不能只报一声就写下去：append 报的 at 减掉了前面旧的那一截，成了负数，
   调用方根本对不上是哪条。所以直接拒掉，让调用方先把素材补回来。
   oldCount 是「送进归一化的那串里，前多少条是块上原有的」。 */
function pictureWashed(result, oldCount, wanted) {
  const broke = result.dropped.find((one) => one.at < oldCount);
  if (!broke) return;
  const lost = wanted[broke.at];
  throw new Error(
    `这一笔会把已有的第 ${lost?.i ?? broke.at + 1} 条（${lost?.op || broke.op}）洗掉：${broke.why}` +
      "——素材要先补回来，或先用 mode:\"delete\" 把用它的指令一起删掉；整幅重画就明说 mode:\"replace\"",
  );
}

/* 名字写错的那一类（use 的 ref / variant / hide、tile 漆的 ref、剪刀的 ref）整笔请求失败。
   以前它们只进 dropped，于是「一个变体名拼错 → 十七个小人没了」要回看渲染才发现，
   而回话里那句「画好了」把人骗过去。报错时把这块现在有的名字一起带回去，改起来不用猜。
   用户手绘那一路不过这里：手绘不会写错名字，也不该为这个丢一笔。 */
function rejectFatalDrop(list) {
  const bad = (list || []).find((one) => one.fatal);
  if (bad) throw new Error(bad.why);
}

/* 画进去三种走法：replace 整幅换掉（默认）、append 追加、delete 按号删。
   按号删是给橡皮和「洗掉画歪那一笔」用的——整幅重替换风险大得多。 */
async function agentPictureDraw(id, patch = {}) {
  const item = agentPictureOf(id);
  if (item.locked) throw new Error("这块已锁定，先解锁再画");
  /* 垫的位图得先拷进来、量好尺寸，下面归一化才认得这条 image */
  const canvasId = current.meta.id;
  await resolvePictureImages(patch, canvasId);
  if (!current || current.meta.id !== canvasId) throw new Error("画这一笔的时候空间被切走了，什么都没改");
  const before = Array.isArray(item.cmds) ? item.cmds : [];
  const mode = String(patch.mode || "replace");
  const given = Array.isArray(patch.cmds) ? patch.cmds : [];
  /* 图层开关是块上的属性（和纸色同一类，走 items.json）：坏拼写在这儿就抛，
     别等指令已经落了一半才发现改不动。 */
  const hidden = patch.hidden === undefined ? null : normalizeHidden(patch.hidden);
  if (hidden?.why) throw new Error(hidden.why);
  const light = patch.light === undefined ? null : normalizeLight(patch.light);
  if (light?.why) throw new Error(light.why);
  /* 先定下这一请求结束后块上留的是哪一串（还没归一化）：素材删除的守卫数的是它，
     不是块上旧的那一串——同批把用到它的指令一起撤干净的那种请求本来就安全，
     拦它等于逼人多跑一趟。mode 不对也在这儿就抛，别抛在素材已经改了之后。 */
  let incoming = before;
  if (mode === "delete") {
    const ids = new Set((Array.isArray(patch.ids) ? patch.ids : []).map(Number));
    if (!ids.size) throw new Error("delete 需要 ids：要删的指令号，从 picture_get 里拿");
    incoming = before.filter((cmd) => !ids.has(cmd.i));
  } else if (mode === "append") {
    incoming = [...before, ...given];
  } else if (mode === "replace") {
    incoming = given;
  } else {
    throw new Error("mode 只能是 replace / append / delete");
  }
  /* 素材先并进来：同一个请求里的 cmds 才认得刚起的名字，use 不用分两次发。
     并出来的是新表，先攥在手里，等指令也归一化通过了一起换上——半途抛错不能留下改到一半的块 */
  const merged = patch.symbols === undefined ? null : mergePictureSymbols(item, patch.symbols, incoming);
  const symbols = merged ? merged.symbols : item.symbols || {};
  let next = before;
  let dropped = [];
  let deleted = 0;
  let expanded = 0;
  if (mode === "delete") {
    next = incoming;
    deleted = before.length - next.length;
    const rest = normalizePictureCmds(next, PICTURE_MAX_CMDS, { symbols });
    pictureWashed(rest, next.length, next);
    expanded = rest.expanded;
  } else {
    const result = normalizePictureCmds(incoming, PICTURE_MAX_CMDS, { symbols });
    next = result.cmds;
    expanded = result.expanded;
    if (mode === "append") pictureWashed(result, before.length, incoming);
    /* append 洗的是「旧的 + 新发的」拼起来的表，下标得减掉前面旧的那一截，
       报回去的 at 才是调用方自己发出去的 cmds 里的第几条 */
    const offset = mode === "append" ? before.length : 0;
    dropped = result.dropped.map((one) => ({ ...one, at: one.at - offset }));
  }
  const rejected = [...(merged ? merged.dropped : []), ...dropped];
  /* 名字写错的那一类在这儿拦下来：拼错一个 variant / ref 只悄悄少一片画、回话还说画好了，
     agent 会照着这个半成品继续往下画。整笔请求先失败，改对了再发一次。 */
  rejectFatalDrop(rejected);
  if (merged) item.symbols = merged.symbols;
  item.cmds = next;
  /* 指令和素材不归 items.json 管、也不进全局撤销快照，改完单独落 pictures/<块id>.json 那一份 */
  persistPicture(item);
  if (patch.paperColor !== undefined) item.paperColor = String(patch.paperColor || "");
  /* 开关要在重画之前就写上，不然这一帧还是按旧的层画 */
  if (hidden) item.hidden = hidden.hidden;
  if (light) item.light = light.light;
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  agentHighlight([item.id]);
  return {
    ...agentSummary(item),
    added: next.length - before.length,
    deleted,
    total: next.length,
    expanded,
    symbolNames: Object.keys(symbols),
    /* 回显图层开关：只改素材或纸色的那一次也要看得见现在关着哪几层，
       不然 agent 以为画面上少了那一片是自己画丢了 */
    hidden: Array.isArray(item.hidden) ? item.hidden : [],
    layers: pictureLayersOf(item).layers,
    light: item.light || null,
    drawn: pictureTopLayers(next, item.hidden).filter((one) => one.drawn).length,
    limit: PICTURE_MAX_CMDS,
    expandedLimit: PICTURE_MAX_EXPANDED,
    /* 认不了的指令原样报回去：at 是你在 cmds 里提交的下标，why 说清是哪个字段写成了什么。
       不报的话 agent 会以为画面本来就该长这样 */
    ...(rejected.length
      ? {
          dropped: rejected,
          hint: `有 ${rejected.length} 条指令或素材被丢了，按每条的 why 改掉再发一次；改完要拿 picture_get 回读编号，别按提交下标删`,
        }
      : {}),
  };
}

/* 图层单独一个工具：读这块有哪些层、关着哪几层；带 hide / show 就动开关。
   开关不碰指令——为了关一层把几千条整幅 replace 一遍，风险和开销都不该在那头。
   同名同时出现在 hide 和 show 里按 show 算（开着），返回里照实回显，不用猜。 */
function agentPictureLayers(id, patch = {}) {
  const item = agentPictureOf(id);
  if (item.locked) throw new Error("这块已锁定，先解锁再改图层");
  const off = Array.isArray(item.hidden) ? [...item.hidden] : [];
  const read = (raw, key) => {
    if (raw === undefined) return null;
    const got = normalizeHidden(raw);
    if (got.why) throw new Error(`${key} ${got.why.replace(/^hidden /, "")}`);
    return got.hidden;
  };
  const hide = read(patch.hide, "hide");
  const show = read(patch.show, "show");
  const census = pictureLayersOf(item);
  const known = census.layers.map((one) => one.name);
  const asked = [...new Set([...(hide || []), ...(show || [])])];
  const unknown = asked.filter((name) => !known.includes(name));
  if (unknown.length) {
    throw new Error(
      `这块没有「${unknown.join(" / ")}」这些图层——${
        known.length ? `现在有的层是：${known.slice(0, 12).join(" / ")}` : "这块一条指令都还没起 name（想整层开关，就给那几条指令写同一个 name，几笔一起开关就包一层 group 起名）"
      }`,
    );
  }
  if (hide || show) {
    const next = [...off];
    for (const name of hide || []) if (!next.includes(name)) next.push(name);
    for (const name of show || []) {
      const at = next.indexOf(name);
      if (at >= 0) next.splice(at, 1);
    }
    item.hidden = next;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    scheduleItemsSave();
    agentHighlight([item.id]);
  }
  const layers = census.layers.map((one) => ({ ...one, hidden: item.hidden.includes(one.name) }));
  return {
    ...agentSummary(item),
    hidden: [...item.hidden],
    layers,
    unnamed: census.unnamed,
    drawn: pictureTopLayers(item.cmds, item.hidden).filter((one) => one.drawn).length,
    total: (Array.isArray(item.cmds) ? item.cmds : []).length,
    ...(layers.length ? {} : { hint: "这块还没分层：想整层开关，就给那几条指令写同一个 name（几笔一起开关就包一层 group 起名）" }),
  };
}

/* 一套光单独一个工具：只带 id 就是问「这块现在怎么打的光」。
   带哪个字段就改哪个字段，没带的沿用块上现值——为了挪五度方位角要把光色、影色、强度重发一遍，
   等于把用户定好的那几样洗回默认，这正是「改一处丢一片」那类坑。
   关掉光写 off:true。 */
function agentPictureLight(id, patch = {}) {
  const item = agentPictureOf(id);
  const wanted = patch.off === true || patch.off === "true" || ["angle", "elev", "lit", "dark", "k"].some((key) => patch[key] !== undefined);
  /* 只带 id 是「问这块现在怎么打的光」，锁着也得答——锁拦的是改，不是看 */
  if (wanted && item.locked) throw new Error("这块已锁定，先解锁再改光");
  if (patch.off === true || patch.off === "true") {
    item.light = null;
  } else {
    const given = ["angle", "elev", "lit", "dark", "k"].filter((key) => patch[key] !== undefined);
    if (given.length) {
      /* 从没挂过光的块起步：没有现值可沿用，angle 没给就报错，不替它挑一个方向 */
      const merged = { ...(item.light || {}) };
      for (const key of given) merged[key] = patch[key];
      const got = normalizeLight(merged);
      if (got.why) throw new Error(got.why);
      item.light = got.light;
    }
  }
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  agentHighlight([item.id]);
  const faced = pictureFaceCount(item);
  return {
    ...agentSummary(item),
    light: item.light || null,
    faced,
    cmds: (Array.isArray(item.cmds) ? item.cmds : []).length,
    ...(item.light && !faced
      ? { hint: "这块还没有一笔声明 face，光打上去不会有任何明暗变化——要给受光的那几笔写 face（up/down/left/right/front/back），整面墙就包一层 group 写一次" }
      : {}),
  };
}

/* ---------- 生图面板（agent） ----------
   引擎一次只吃一张，所以「现在能不能开始」看的不是这一块，而是 genBusyId() 那一个 id。
   gen_run 默认把这一趟等完：出图半分钟，比分几次去问相位省事；
   头一次跑还要先把权重读进来，那一两分钟也在同一个等待里。 */

function agentGenOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "gen") throw new Error("这不是生图面板");
  return item;
}

/* 出图参数只认块上这几个字段：给了才改，认不出的数收成最接近的合法值。
   尺寸得贴到 32 的倍数上（snapGenSize），步数、cfg、seed 的区间和建块时同一套。 */
function applyGenFields(item, spec = {}) {
  let touched = false;
  if (spec.prompt !== undefined) {
    item.prompt = String(spec.prompt).slice(0, GEN_TEXT_MAX);
    touched = true;
  }
  if (spec.negative !== undefined) {
    item.negative = String(spec.negative).slice(0, GEN_TEXT_MAX);
    touched = true;
  }
  if (Number.isFinite(Number(spec.imageW))) {
    item.imageW = snapGenSize(Number(spec.imageW));
    touched = true;
  }
  if (Number.isFinite(Number(spec.imageH))) {
    item.imageH = snapGenSize(Number(spec.imageH));
    touched = true;
  }
  if (Number.isFinite(Number(spec.steps))) {
    item.steps = clamp(Math.round(Number(spec.steps)), GEN_STEPS_MIN, GEN_STEPS_MAX);
    touched = true;
  }
  if (Number.isFinite(Number(spec.cfg))) {
    item.cfg = clamp(Number(spec.cfg), GEN_CFG_MIN, GEN_CFG_MAX);
    touched = true;
  }
  if (spec.seed !== undefined) {
    /* -1 是「每张换一个」的哨兵，别的认不出的数也退回它 */
    const want = Number(spec.seed);
    item.seed = Number.isFinite(want) && want >= -1 ? Math.trunc(want) : -1;
    touched = true;
  }
  return touched;
}

async function agentGenStatus() {
  agentRequireSpace();
  const engine = await store.genStatus();
  return {
    loaded: Boolean(engine.loaded),
    busyBlock: genBusyId() || null,
    modelsDir: engine.modelsDir || "",
    missing: Array.isArray(engine.missing) ? engine.missing : [],
    idleMinutes: engine.idleMinutes || 0,
    panels: current.items.filter((item) => item.type === "gen").map(agentSummary),
  };
}

/* 等到这一轮出完、失败或取消。运行态是事件写回来的，这儿只能轮询着读。 */
async function waitGenRun(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = genRunOf(id);
    if (run.phase !== "loading" && run.phase !== "running") return run;
    if (Date.now() > deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function agentGenRun(id, patch = {}) {
  const item = agentGenOf(id);
  /* 锁拦改不拦看，但这一趟既改字段又发任务：先看锁，不许把提示词写进一块锁着的面板 */
  if (item.locked) throw new Error("这块已锁定，先解锁再出图");
  const busy = genBusyId();
  if (busy && busy !== item.id) {
    throw new Error(`引擎正被生图面板 ${busy} 占着，一次只出一张`);
  }
  /* 改字段和发出去是同一次调用：先落到块上，出图取的就是块上这一份 */
  if (applyGenFields(item, patch)) {
    persistGen(item);
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    scheduleItemsSave();
  }
  if (!busy) runOrStopGen(item.id);
  agentHighlight([item.id], 1600);
  if (patch.wait === false) return { ...agentSummary(item), waited: false };
  const seconds = Math.min(600, Math.max(1, numOr(patch.timeout, 300)));
  const run = await waitGenRun(item.id, seconds * 1000);
  const still = findItem(item.id);
  if (!still) throw new Error(`生图面板 ${item.id} 已经不在这块空间里了`);
  return {
    ...agentSummary(still),
    waited: true,
    timedOut: run.phase === "loading" || run.phase === "running",
  };
}

function agentGenCancel() {
  const busy = genBusyId();
  if (!busy) return { canceled: false, note: "现在没有在出图" };
  void stopGen(busy);
  return { canceled: true, block: busy };
}

/* 把最近那张落成一块独立图片块：面板留着继续改词重出，图片块自己带一份文件 */
async function agentGenPlace(id) {
  const item = agentGenOf(id);
  if (!item.src) throw new Error("这块还没出过图，先 gen_run");
  const run = genRunOf(item.id);
  if (run.phase === "loading" || run.phase === "running") {
    throw new Error("正在出图，等这一张跑完再落块");
  }
  const placed = await placeGenImage(item.id);
  if (!placed) throw new Error("没能落块：那张图的文件读不出来，具体原因弹在界面右下角了");
  agentRevealBlock(placed.id);
  return agentSummary(placed);
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
  /* 一次提交一串操作：期间不运镜不打光带，整批算一步撤销 */
  beginBatch: () => {
    if (batching) return;
    batching = true;
    history.hold(true);
  },
  endBatch: () => {
    if (!batching) return;
    batching = false;
    history.hold(false);
  },
  /* 批量铺完之后把整批框进视野，让用户一眼看到结果 */
  batchFit: () => {
    if (!current) return false;
    agentFitView();
    return true;
  },
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
  blockUpdate: async (id, patch) => {
    const result = await agentUpdateBlock(id, patch);
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
  snapshot: (options) => {
    if (!current) throw new Error("当前没有打开的空间");
    return exporter.snapshot(options || {});
  },
  exportAs: (format, options) => {
    if (!current) throw new Error("当前没有打开的空间");
    return exporter.exportAs(format, options || {});
  },
  importFile: agentImportFile,
  stickyRead: agentStickyRead,
  stickyWrite: agentStickyWrite,
  pictureGet: agentPictureGet,
  pictureDraw: agentPictureDraw,
  pictureLayers: agentPictureLayers,
  pictureLight: agentPictureLight,
  genStatus: agentGenStatus,
  genRun: agentGenRun,
  genCancel: agentGenCancel,
  genPlace: agentGenPlace,
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
