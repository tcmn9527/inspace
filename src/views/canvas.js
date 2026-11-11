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
import { confirmDialog, choiceDialog, promptDialog, progressDialog, CLOSE_X_SVG } from "./dialog.js";
import { createMarkdownEditor } from "./markdown-editor.js";
import { openMenu, closeMenu, isMenuOpen } from "./menu.js";
import { renderMarkdown } from "./markdown.js";
import {
  disposeScene, setSceneCameraScale, setSceneAssetProvider, contentBox, sceneCameraState,
  scenePick, sceneFurnitureMoveDelta, beginSceneFurnitureDrag, sceneFurnitureDragDelta,
  setSceneFurnitureSelection, sceneFurnitureInspect,
} from "./scene3d.js";
import {
  dropGenRun,
  genBusyId,
  genRunOf,
  isGenBusy,
  patchGenRun,
  syncGen,
} from "./genpanel.js";
import { openVideoHelp } from "./video-help.js";
import { createExporter, QUALITY, DEFAULT_QUALITY } from "./export.js";
import { rasterize, toPngDataUrl } from "./raster.js";
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
  GEN_MODES,
  GEN_MODE_LABELS,
  GEN_STEPS_MAX,
  GEN_STEPS_MIN,
  GEN_STRENGTH_MAX,
  GEN_STRENGTH_MIN,
  GEN_TEXT_MAX,
  FILE_MIN_HEIGHT,
  FILE_MIN_WIDTH,
  NOTE_DEFAULT_HEIGHT,
  NOTE_DEFAULT_WIDTH,
  NOTE_MIN_HEIGHT,
  NOTE_MIN_WIDTH,
  PAGE_RATIOS,
  PLAN_DEFAULT_HEIGHT,
  PLAN_DEFAULT_WIDTH,
  PLAN_MIN_HEIGHT,
  PLAN_MIN_WIDTH,
  PRODUCT_DEFAULT_HEIGHT,
  PRODUCT_DEFAULT_WIDTH,
  PRODUCT_MIN_HEIGHT,
  PRODUCT_MIN_WIDTH,
  QUOTE_DEFAULT_HEIGHT,
  QUOTE_DEFAULT_WIDTH,
  QUOTE_MIN_HEIGHT,
  QUOTE_MIN_WIDTH,
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
  makePlan,
  makePage,
  makeProduct,
  makeQuote,
  makeScene,
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
  normalizeSceneSurfaces,
  pictureCmdHit,
  pictureImageSrc,
  pictureLayerCensus,
  planPixelsPerMm,
  pictureTopLayers,
  pinConnectorSides,
  pinEbookPage,
  remapPictureImageSrcs,
  releaseEbookPage,
  renderMissing,
  renderPictureCmd,
  refreshQuoteCard,
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
  "note",
  "file",
  "ebook",
  /* 生图面板也上名单：选中要看得见那四个圈的记号，
     而且它的输入图本来就靠连线进来（P2 才吃这条线） */
  "gen",
  /* 画面块：手绘的图和矢量画都能连给生图面板当参考图 */
  "picture",
]);
/* 每类面板拖角缩放的地板，和 canvas-items 里 normalizeItem 的取值口径一致：
   播放器、附件条这类排版固定的块也能拉角，只是不许拉小到控件看不见 */
const RESIZE_MIN = {
  audio: { w: AUDIO_MIN_WIDTH, h: AUDIO_MIN_HEIGHT },
  file: { w: FILE_MIN_WIDTH, h: FILE_MIN_HEIGHT },
  video: { w: VIDEO_MIN_WIDTH, h: VIDEO_MIN_HEIGHT },
  ebook: { w: EBOOK_MIN_WIDTH, h: EBOOK_MIN_HEIGHT },
  note: { w: NOTE_MIN_WIDTH, h: NOTE_MIN_HEIGHT },
  picture: { w: PICTURE_MIN_WIDTH, h: PICTURE_MIN_HEIGHT },
  scene: { w: SCENE_MIN_WIDTH, h: SCENE_MIN_HEIGHT },
  gen: { w: GEN_MIN_WIDTH, h: GEN_MIN_HEIGHT },
};
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
let searchApi = null;
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
   切画布时 imageCache 整个换掉，所以塞的是一个现查的函数、不是那张表本身。 */
setPictureMedia((src) => imageCache.get(src) || "");
/* 场景里贴的材质图也按当前画布取地址：换画布后同一个 images/xxx 不会串到上一个画布 */
setSceneAssetProvider(async (src) => {
  if (!current) throw new Error("没有打开的画布");
  return store.imageUrl(current.meta.id, src, false);
});
let audioCache = new Map();
/* 视频只缓存 asset 地址（一串字符），不缓存任何字节 */
let videoCache = new Map();
let noteImageCache = new Map();
/* 文本块只读预览：缓存后端解好码的开头一段，切画布就清空重来。
   键带上存在方式，免得同一个路径的拷贝态和引用态串了。 */
let filePreviewCache = new Map();
const previewKey = (item) => `${item.linked ? "L" : "C"}|${item.src}`;
/* PDF 块的 asset 地址：一份文件问后端一次（顺带开的那次读权限也就够了），
   翻页和拖角缩放重画都复用这条地址 */
let pdfUrlCache = new Map();
let docxUrlCache = new Map();
let xlsxUrlCache = new Map();
let pptxUrlCache = new Map();
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
/* Alt 测距：按住时给单选的块画四周最近面板的距离，松开就收 */
let measureHeld = false;
let measureFrame = 0;
let previewPath = null;
let itemsTimer = null;
let cameraTimer = null;
let errorTimer = null;
let loadToken = 0;
/* 同时只跑一个后台拷贝：进度条只有一根，视频和文件共用 */
let copyTask = null; // { job, canvasId, resolve, label }
/* 转音轨排在拷贝后面，同一根进度条，不并发 */
let audioFix = null; // { job, canvasId, item }

/* ---------- 导出 ---------- */

const rawExporter = createExporter({
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

/* 导出/截图要看到整张画布，先把视口裁剪暂时松开，克隆完再按视口收回去 */
const exporter = {
  ...rawExporter,
  exportAs: (...args) => withAllVisible(() => rawExporter.exportAs(...args)),
  exportSlices: (...args) => withAllVisible(() => rawExporter.exportSlices(...args)),
  exportRegion: (...args) => withAllVisible(() => rawExporter.exportRegion(...args)),
  snapshot: (...args) => withAllVisible(() => rawExporter.snapshot(...args)),
};

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
    showToast("这个画布还是空的，没东西可导");
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

/* ---------- 初始化 ---------- */

export function initCanvas() {
  ui = {
    page: document.querySelector("#canvas-view"),
    stage: document.querySelector("#canvas-stage"),
    world: document.querySelector("#canvas-world"),
    edgeTransform: document.querySelector("#canvas-edge-transform"),
    endpointLayer: document.querySelector("#canvas-endpoint-layer"),
    guideLayer: document.querySelector("#canvas-guide-layer"),
    measureLayer: document.querySelector("#canvas-measure-layer"),
    portVisualLayer: document.querySelector("#canvas-port-visual-layer"),
    handleVisualLayer: document.querySelector("#canvas-handle-visual-layer"),
    metrics: document.querySelector("#canvas-metrics"),
    tools: document.querySelector("#canvas-tools"),
    toolMenu: document.querySelector("#canvas-tool-menu"),
    toolIcon: document.querySelector("#canvas-tool-icon"),
    zoomValue: document.querySelector("#canvas-zoom-value"),
    zoomIn: document.querySelector("#canvas-zoom-in"),
    zoomOut: document.querySelector("#canvas-zoom-out"),
    exportBtn: document.querySelector("#canvas-export"),
    empty: document.querySelector("#canvas-empty"),
    create: document.querySelector("#canvas-create"),
    error: document.querySelector("#canvas-error"),
    copy: document.querySelector("#canvas-video-copy"),
    copyName: document.querySelector("#canvas-copy-name"),
    copyFill: document.querySelector("#canvas-copy-fill"),
    copyText: document.querySelector("#canvas-copy-text"),
    copyCancel: document.querySelector("#canvas-copy-cancel"),
  };

  toolboxMarkup = ui.toolIcon.innerHTML;
  ui.toolMenu.addEventListener("click", (event) => {
    /* 菜单在 document 上挂着「点外部就收起」：不挡住这一下，刚开的菜单会被当成外部点击 */
    event.stopPropagation();
    if (isMenuOpen("tools")) {
      closeMenu();
      return;
    }
    openToolMenu();
  });
  ui.copyCancel.addEventListener("click", () => {
    const job = copyTask?.job || audioFix?.job;
    if (!job) return;
    ui.copyCancel.disabled = true;
    ui.copyCancel.textContent = "停止中…";
    store.cancelVideoCopy(job).catch(() => {});
  });

  ui.create.addEventListener("click", createFlow);
  initSpaceTree();
  bindZoomHold(ui.zoomIn, ZOOM_STEP);
  bindZoomHold(ui.zoomOut, -ZOOM_STEP);
  /* 菜单在 document 上挂着「点外部就收起」：这一下点击冒泡到那里，
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
    if (id !== hoverId) setHoverId(id);
  });
  ui.stage.addEventListener("pointerleave", () => {
    lastPointer.inside = false;
    if (hoverId) setHoverId(null);
  });

  /* 端口和选中框都画在块自己身上（见 updatePorts / updateSelection），所以按下事件在 world 这层收 */
  ui.world.addEventListener("pointerdown", startConnect);
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
  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt") setMeasureHeld(false);
  });
  window.addEventListener("blur", () => setMeasureHeld(false));
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

  searchApi = initSearch({
    getItems: () => (current ? current.items : []),
    getSpaceId: () => current?.meta?.id || "",
    focusBlock: focusBlockById,
    /* 别的画布的命中：先切过去，等它读完再定位。spaceOpen 自己会等到渲染完 */
    jumpToSpace: async (spaceId, itemId) => {
      if (!spaceId) return;
      if (spaceId !== current?.meta?.id) await canvasAgent.spaceOpen(spaceId);
      if (itemId) focusBlockById(itemId);
    },
  });
}

/* 搜索定位：把这块摆在视野正中并闪一下告诉用户是这块。
   缩放保持用户当前的比例不动——搜索只负责找，不替用户改视野大小 */
function focusBlockById(id) {
  if (!current) return;
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  const bounds = itemBounds(item, el);
  const stageW = ui.stage.clientWidth;
  const stageH = ui.stage.clientHeight;
  const scale = current.camera.scale;
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
  setMeasureHeld(false);
  if (ui?.portVisualLayer) ui.portVisualLayer.textContent = "";
  if (ui?.handleVisualLayer) ui.handleVisualLayer.textContent = "";
  pauseMedia();
  /* 全屏壳躲在被隐藏的画布视图里时浏览器不会自己退，切走要手动收，
     不然下一页会被撑到整块屏幕的尺寸 */
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  modalOpen = false;
  if (editingId || edgeLabelEditor) commitEditing();
  closeColorPicker(true);
  closeMenu();
  void flushBlockContents();
  flushItems();
  flushCamera();
  /* 走开的这个画布的画笔状态没理由还揣着：块 id 到别的画布也用不上 */
  pictureEditors.clear();
  pictureTimers.forEach((timer) => clearTimeout(timer));
  pictureTimers.clear();
  sceneTimers.forEach((timer) => clearTimeout(timer));
  sceneTimers.clear();
}

/* ---------- 画布列表 / 新建 / 切换 ---------- */

async function loadList() {
  try {
    canvases = await store.listCanvases();
  } catch (error) {
    canvases = [];
    showError(error);
  }
  await refreshTree();
}

async function switchTo(id) {
  pauseMedia();
  /* 换画布 = 换一块新画幅，上一个画布里武装着的画图工具不该跟着过来 */
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
    await loadPictureImages();
    if (token !== loadToken || !active) return;
    renderAll();
    /* 源 .md 读不到的笔记块整块换成丢文件卡，不再拿最后一次缓存的正文糊弄用户 */
    for (const item of staleNotes) {
      renderMissing(itemEls.get(item.id), item, current.meta.path || "");
    }
    /* 自己那份内容文件读不动的笔记同样是丢了，只是丢的是画布目录里的那份 */
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
  normalizeSeqs(kept);
  return kept;
}

/* 块的固定编号：老数据按文件顺序补；重复或坏掉的号重排，保证画布内唯一。
   删块后号不回收，新块接着最大的往下排，用户记过的号不会突然指到别的块上。 */
function normalizeSeqs(items) {
  const blocks = items.filter((item) => item.type !== "connector");
  const seen = new Set();
  let max = 0;
  for (const item of blocks) {
    if (item.seq > 0 && !seen.has(item.seq)) {
      seen.add(item.seq);
      max = Math.max(max, item.seq);
    } else {
      item.seq = 0;
    }
  }
  for (const item of blocks) {
    if (!item.seq) {
      max += 1;
      item.seq = max;
      seen.add(max);
    }
  }
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
    /* 产品卡的图也是 images/ 里的副本，和图片块共用一张缓存表 */
    else if (item.type === "product" && item.src) wanted.set(item.src, false);
    /* 户型图同样是画布 images/ 里的副本 */
    else if (item.type === "plan" && item.src) wanted.set(item.src, false);
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
   刚打开画布时调它，那时块还没建，重画那步自然落空，地址先躺在缓存里等 renderAll。 */
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
  ui.empty.hidden = hasCanvas;
  renderTree();
  if (!hasCanvas) {
    ui.world.textContent = "";
    ui.edgeTransform.textContent = "";
    previewPath = null;
    itemEls.clear();
    ui.endpointLayer.textContent = "";
    if (ui.handleVisualLayer) ui.handleVisualLayer.textContent = "";
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
    docxUrlCache.clear();
    xlsxUrlCache.clear();
    pptxUrlCache.clear();
  ebookTocCache.clear();
  mediaMissing = new Set();
  updateChrome();
  updateMetrics();
}

async function createFlow() {
  await createFlowIn(null);
}

/* ---------- 左侧画布树 ---------- */

const TREE_KEY = "workbench.spaceTree";
let treeUi = null;
let treeData = [];
let treeCollapsed = new Set();
let treeFilter = "";
let treeRenaming = null;
let treeWidth = 220;

function treeSavePrefs() {
  localStorage.setItem(TREE_KEY, JSON.stringify({
    width: treeWidth,
    hidden: treeUi ? treeUi.aside.hidden : false,
    collapsed: [...treeCollapsed],
  }));
}

function initSpaceTree() {
  treeUi = {
    aside: document.querySelector("#space-tree"),
    body: document.querySelector("#space-tree-body"),
    filter: document.querySelector("#space-tree-filter"),
    add: document.querySelector("#space-tree-add"),
    hide: document.querySelector("#space-tree-hide"),
    resize: document.querySelector("#space-tree-resize"),
  };
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(TREE_KEY) || "{}");
  } catch { /* 坏掉的偏好按默认来 */ }
  const width = Math.min(420, Math.max(160, Number(prefs.width) || 220));
  treeWidth = width;
  treeUi.aside.style.width = `${width}px`;
  treeCollapsed = new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed : []);
  treeSetHidden(Boolean(prefs.hidden));

  treeUi.filter.addEventListener("input", () => {
    treeFilter = treeUi.filter.value;
    renderTree();
  });
  treeUi.add.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = treeUi.add.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 4, treeRootEntries(), { label: "新建" });
  });
  treeUi.hide.addEventListener("click", () => treeSetHidden(!treeUi.aside.hidden));
  treeUi.body.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".space-tree-row")) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY, treeRootEntries(), { label: "画布" });
  });

  treeUi.resize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const handle = treeUi.resize;
    handle.classList.add("is-active");
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = treeUi.aside.offsetWidth;
    const move = (e) => {
      const w = Math.min(420, Math.max(160, startWidth + e.clientX - startX));
      treeWidth = w;
      treeUi.aside.style.width = `${w}px`;
      scheduleCulling();
    };
    const up = () => {
      handle.classList.remove("is-active");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      treeSavePrefs();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function treeSetHidden(hidden) {
  if (!treeUi) return;
  treeUi.aside.hidden = hidden;
  /* 收起后整列树都消失，标题栏那颗箭头翻成向右，原地点一下再展开 */
  treeUi.hide.classList.toggle("is-collapsed", hidden);
  treeUi.hide.title = hidden ? "展开画布栏" : "收起画布栏";
  treeUi.hide.setAttribute("aria-label", treeUi.hide.title);
  treeSavePrefs();
  scheduleCulling();
}

function treeRootEntries() {
  return [
    { label: "新建画布", onClick: () => createFlowIn(null) },
    { label: "新建分组", onClick: () => createGroupFlow(null) },
  ];
}

async function refreshTree() {
  try {
    treeData = await store.canvasTree();
  } catch {
    treeData = [];
  }
  renderTree();
}

function treeMatches(node, needle) {
  if (node.name.toLowerCase().includes(needle)) return true;
  return (node.children || []).some((kid) => treeMatches(kid, needle));
}

/* 扁平的分组清单：复制画布时当目标列表，标签带上父路径才分得清同名分组 */
function treeGroupList() {
  const out = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes) {
      if (node.type !== "group") continue;
      const label = prefix ? `${prefix} / ${node.name}` : node.name;
      out.push({ id: node.id, label });
      walk(node.children || [], label);
    }
  };
  walk(treeData, "");
  return out;
}

const TREE_CHEVRON = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderTree() {
  if (!treeUi) return;
  /* 正在就地改名就别重排：输入框会被排掉，blur 还会误提交一次 */
  if (treeRenaming) return;
  const body = treeUi.body;
  body.textContent = "";
  const needle = treeFilter.trim().toLowerCase();
  let shown = 0;

  const renderRow = (node, depth, forceShow) => {
    const isGroup = node.type === "group";
    if (needle && !forceShow && !treeMatches(node, needle)) return;
    const row = document.createElement("div");
    row.className = `space-tree-row${isGroup ? " is-group" : ""}`;
    row.dataset.kind = node.type;
    row.dataset.id = node.id;
    row.style.paddingLeft = `${6 + depth * 14 + (isGroup ? 0 : 17)}px`;
    const expanded = needle ? true : !treeCollapsed.has(node.id);
    if (isGroup) {
      const chevron = document.createElement("span");
      chevron.className = `space-tree-chevron${expanded ? " is-open" : ""}`;
      chevron.innerHTML = TREE_CHEVRON;
      row.append(chevron);
    } else if (current?.meta.id === node.id) {
      row.classList.add("is-current");
    }
    const label = document.createElement("span");
    label.className = "space-tree-label";
    label.textContent = node.name;
    label.title = node.name;
    row.append(label);
    row.addEventListener("click", () => {
      if (isGroup) {
        if (treeCollapsed.has(node.id)) treeCollapsed.delete(node.id);
        else treeCollapsed.add(node.id);
        treeSavePrefs();
        renderTree();
      } else {
        void switchTo(node.id);
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isGroup) openTreeGroupMenu(node, event.clientX, event.clientY);
      else openTreeCanvasMenu(node, event.clientX, event.clientY);
    });
    body.append(row);
    shown += 1;
    if (isGroup && expanded) {
      /* 分组名自己命中筛选时，整棵子树都摆出来 */
      const forceKids = forceShow || (needle && node.name.toLowerCase().includes(needle));
      for (const kid of node.children || []) renderRow(kid, depth + 1, forceKids);
    }
  };
  for (const node of treeData) renderRow(node, 0, false);
  if (!shown) {
    const hint = document.createElement("p");
    hint.className = "space-tree-hint";
    hint.textContent = needle ? "没有匹配的画布" : "还没有画布，右键新建";
    body.append(hint);
  }
}

function openTreeGroupMenu(node, x, y) {
  const empty = !(node.children || []).length;
  openMenu(x, y, [
    { label: "新建画布", onClick: () => createFlowIn(node.id) },
    { label: "新建子分组", onClick: () => createGroupFlow(node.id) },
    "-",
    { label: "重命名", onClick: () => startTreeRename("group", node.id, node.name) },
    { label: "在资源管理器中显示", onClick: () => store.revealGroup(node.id).catch(showError) },
    "-",
    empty
      ? { label: "删除分组", danger: true, onClick: () => deleteGroupFlow(node) }
      : { label: "删除分组（请先清空）", disabled: true },
  ], { label: node.name });
}

function openTreeCanvasMenu(node, x, y) {
  const targets = [
    { label: "（根目录）", onClick: () => copyCanvasFlow(node.id, "") },
    ...treeGroupList().map((group) => ({
      label: group.label,
      onClick: () => copyCanvasFlow(node.id, group.id),
    })),
  ];
  openMenu(x, y, [
    { label: "重命名", onClick: () => startTreeRename("canvas", node.id, node.name) },
    { label: "复制到分组", children: targets },
    { label: "在资源管理器中显示", onClick: () => store.revealCanvas(node.id).catch(showError) },
    "-",
    { label: "删除画布", danger: true, onClick: () => deleteTreeCanvasFlow(node) },
  ], { label: node.name });
}

async function createFlowIn(parent) {
  const name = await promptDialog({
    title: "新建画布",
    label: "画布名字",
    value: "新画布",
    okText: "创建",
  });
  if (!name) return;
  try {
    const data = await store.createCanvas(name, parent);
    await loadList();
    await switchTo(data.meta.id);
  } catch (error) {
    showError(error);
  }
}

async function createGroupFlow(parent) {
  const name = await promptDialog({
    title: "新建分组",
    label: "分组名字",
    value: "新分组",
    okText: "创建",
  });
  if (!name) return;
  try {
    const id = await store.createGroup(parent, name);
    /* 新分组要当场看得见：它和它的长辈都展开 */
    treeCollapsed.delete(id);
    let prefix = id;
    while (prefix.includes("/")) {
      prefix = prefix.slice(0, prefix.lastIndexOf("/"));
      treeCollapsed.delete(prefix);
    }
    await loadList();
  } catch (error) {
    showError(error);
  }
}

async function deleteGroupFlow(node) {
  const ok = await confirmDialog({
    title: "删除分组",
    message: `「${node.name}」会被移到系统回收站。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteGroup(node.id);
    treeCollapsed.delete(node.id);
    await loadList();
  } catch (error) {
    showError(error);
  }
}

async function deleteTreeCanvasFlow(node) {
  const ok = await confirmDialog({
    title: "删除画布",
    message: `「${node.name}」的整个文件夹会被移到系统回收站，之后仍可找回。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await agentDeleteSpace(node.id);
  } catch (error) {
    showError(error);
  }
}

async function copyCanvasFlow(id, parent) {
  try {
    if (current?.meta.id === id) {
      if (editingId || edgeLabelEditor) commitEditing();
      await flushBlockContents();
      await flushItems();
      await flushCamera();
    }
    const meta = await store.copyCanvas(id, parent);
    await loadList();
    await switchTo(meta.id);
  } catch (error) {
    showError(error);
  }
}

/* 就地改名：行内换成输入框，Enter/失焦提交，Esc 放弃 */
function startTreeRename(kind, id, name) {
  treeRenaming = { kind, id };
  renderTree();
  const row = treeUi.body.querySelector(`.space-tree-row[data-id="${CSS.escape(id)}"]`);
  if (!row) {
    treeRenaming = null;
    return;
  }
  const label = row.querySelector(".space-tree-label");
  const input = document.createElement("input");
  input.className = "space-tree-rename";
  input.value = name;
  input.spellcheck = false;
  label.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    treeRenaming = null;
    if (!commit || !value || value === name) {
      renderTree();
      return;
    }
    try {
      if (kind === "canvas") {
        await agentRenameSpace(id, value);
      } else {
        await renameTreeGroup(id, value);
      }
    } catch (error) {
      showError(error);
      renderTree();
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish(false);
    }
  });
  input.addEventListener("blur", () => void finish(true));
  input.addEventListener("click", (event) => event.stopPropagation());
}

async function renameTreeGroup(id, name) {
  const newId = await store.renameGroup(id, name);
  /* 折叠记忆里的前缀跟着换 */
  const remap = (key) => (key === id || key.startsWith(`${id}/`) ? newId + key.slice(id.length) : key);
  treeCollapsed = new Set([...treeCollapsed].map(remap));
  if (current && (current.meta.id === id || current.meta.id.startsWith(`${id}/`))) {
    /* 当前画布住在这个分组里：id 前缀变了，落盘后按新 id 重开 */
    if (editingId || edgeLabelEditor) commitEditing();
    await flushBlockContents();
    await flushItems();
    await flushCamera();
    const next = remap(current.meta.id);
    current = null;
    await loadList();
    await switchTo(next);
  } else {
    await loadList();
  }
  return newId;
}

/* ---------- 工具与相机 ---------- */

/* 手里端着哪个工具，标题栏那颗「工具」按钮就换成哪个工具的图标；
   没端工具（选择态）时显示工具箱图标。图标与旧工具栏逐一对齐。 */
const TOOL_ICONS = {
  rect: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4.5" width="13" height="11" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  ellipse: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.4" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  line: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 16 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 16 4M9.5 4H16v6.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  text: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h13M10 4.5v11M7.2 15.5h5.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  picture:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.4" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.2 13.4c1.6-3.4 3-1.2 4.3-3.1 1.2-1.8 2.5.9 4.2-1.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
};
const TOOL_LABELS = {
  rect: "矩形",
  ellipse: "圆形",
  line: "直线",
  arrow: "箭头",
  text: "文字",
  picture: "画图",
};
let toolboxMarkup = "";

/* 工具下拉清单：标题栏工具按钮和画布空白处右键共用这一份。
   六种画图工具排成两行图标格（标题栏里也是 15px 图标，这里放大到 17px）；
   工具都是一次性的，用完自动回选择，所以不列「选择」。
   插入文件和 AI 出图是动作，保持文字行。 */
function toolMenuEntries() {
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
      label: "AI 出图",
      children: [
        { label: "文生图", onClick: () => armAndInsertGen("t2i") },
        { label: "图生图", onClick: () => armAndInsertGen("i2i") },
        { label: "图片局部重绘", onClick: () => armAndInsertGen("inpaint") },
        { label: "图片高清放大", onClick: () => armAndInsertGen("upscale") },
      ],
    },
  ];
}

function armAndInsertGen(mode) {
  dropTool();
  insertGenPanel(mode);
}

function openToolMenu() {
  if (!current) return;
  const rect = ui.toolMenu.getBoundingClientRect();
  openMenu(rect.left, rect.bottom + 8, toolMenuEntries(), { kind: "tools" });
}

function setTool(name, keepSelection = false) {
  tool = name;
  const armed = name !== "select";
  ui.toolMenu?.classList.toggle("is-active", armed);
  ui.toolMenu?.setAttribute("aria-pressed", String(armed));
  if (ui.toolIcon) ui.toolIcon.innerHTML = (armed && TOOL_ICONS[name]) || toolboxMarkup;
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
  scheduleCulling();
}

/* 视口裁剪：只渲染视野附近的面板。上千块的参考画布如果全部挂在 DOM 里，
   拖动和缩放每一帧都要把整棵树重新画一遍，卡得没法操作。
   只裁普通块；场景/生图/音视频自带运行时，显示/隐藏可能把它们的上下文弄坏，不碰。 */
const CULL_MARGIN_PX = 480;
const CULL_TYPES = new Set(["text", "image", "rect", "ellipse", "line", "arrow", "note", "picture", "product", "quote", "plan", "page"]);
let cullingSuspended = 0;
let cullFrame = 0;

function scheduleCulling() {
  if (cullingSuspended || cullFrame) return;
  cullFrame = requestAnimationFrame(() => {
    cullFrame = 0;
    refreshCulling();
  });
}

function refreshCulling() {
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

async function withAllVisible(fn) {
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

/* 从落点往上找有没有真的带滚动条的容器（笔记正文、编辑框、代码块等） */
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
  /* 连线一改，面板的进料就换了答案 */
  refreshGenFeeds();
}

function nextSeq() {
  let max = 0;
  for (const item of current.items) {
    if (item.type !== "connector" && item.seq > max) max = item.seq;
  }
  return max + 1;
}

function addItemElement(item) {
  if (item.type === "connector") {
    const el = createConnectorElement(item);
    itemEls.set(item.id, el);
    ui.edgeTransform.append(el);
    syncConnector(item);
    return el;
  }
  if (item.type !== "connector" && !item.seq) item.seq = nextSeq();
  if (!Number.isFinite(item.z)) item.z = nextLayerZ();
  const mediaSrc =
    item.type === "image" || item.type === "product" || item.type === "plan"
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
  if (item.type === "product") attachProductCard(el, item);
  if (item.type === "quote") {
    attachQuoteCard(el, item);
    refreshQuoteCard(el, item, productItems());
  }
  if (item.type === "plan") attachPlanBlock(el, item);
  if (item.type === "scene") attachSceneControls(el, item);
  scheduleCulling();
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
  refreshCulling();
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

/* 锁定的块在左下角信息条的 #N 前面挂一枚小锁；非锁定不挂 */
const LOCK_BADGE_SVG = `<svg class="canvas-metrics-lock" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="5.3" width="7.4" height="5.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.1 5.3V4a1.9 1.9 0 0 1 3.8 0v1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

/* 左下角信息条：选中谁就报谁的 (X, Y) 和 [W, H]，多选取整组的外接框。
   连线没有自己的位置，单独选中它时这条不出现。 */
function updateMetrics() {
  if (!ui?.metrics) return;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (!item || !el || item.type === "connector") continue;
    const bounds = itemBounds(item, el);
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.w);
    bottom = Math.max(bottom, bounds.y + bounds.h);
  }
  const shown = Number.isFinite(left);
  ui.metrics.hidden = !shown;
  if (!shown) return;
  const count = selectedIds.size > 1 ? ` · ${selectedIds.size} 块` : "";
  const single = selectedIds.size === 1 ? findItem([...selectedIds][0]) : null;
  const lock = single?.locked ? LOCK_BADGE_SVG : "";
  const seq = single && single.type !== "connector" && single.seq ? `#${single.seq} · ` : "";
  const pos = `(${Math.round(left)}, ${Math.round(top)})`;
  const size = `[${Math.round(right - left)}, ${Math.round(bottom - top)}]`;
  ui.metrics.innerHTML = `${lock}${seq}${pos} ${size}${count}`;
}

function updateSelection() {
  if (!ui) return;
  refreshConnectors();
  for (const stale of ui.world.querySelectorAll(".canvas-sel-box")) stale.remove();
  ui.endpointLayer.textContent = "";
  if (ui.handleVisualLayer) ui.handleVisualLayer.textContent = "";
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
  scheduleMeasurements();
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
function addOverlayBox(el, className, borderFactor = 1) {
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

/* ---------- 指针交互 ---------- */

function onStagePointerDown(e) {
  if (!active || !current) return;
  /* 右键/中键起不成画，武装着的工具也一并退回默认 */
  if (e.button !== 0) {
    dropTool();
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

/* 直线/箭头吸到 45° 的倍数：水平、垂直和两条对角线。
   判据和块对齐同一口径——离目标方向的垂距不超过 6 个屏幕像素就咬住。 */
const LINE_SNAP_STEP = Math.PI / 4;
function snapLineAngle(origin, point) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const len = Math.hypot(dx, dy);
  /* 贴着起点时不吸：方向还没定型，硬吸会让线头乱跳 */
  if (len * current.camera.scale < SNAP_PX) return null;
  const angle = Math.atan2(dy, dx);
  const target = Math.round(angle / LINE_SNAP_STEP) * LINE_SNAP_STEP;
  const miss = len * Math.abs(Math.sin(angle - target)) * current.camera.scale;
  if (miss > SNAP_PX) return null;
  /* 终点沿目标方向摆到同样的投影长度上：只微调，不跳 */
  const along = dx * Math.cos(target) + dy * Math.sin(target);
  return {
    point: {
      x: origin.x + Math.cos(target) * along,
      y: origin.y + Math.sin(target) * along,
    },
    guide: { axis: "angle", at: origin, angle: target },
  };
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
    } else if (guide.axis === "angle") {
      /* 吸附角度的那条参考线：以起点为中心，沿咬住的方向拉长到盖住整个画布 */
      const origin = worldToStage(guide.at.x, guide.at.y);
      const reach = Math.hypot(ui.stage.clientWidth, ui.stage.clientHeight);
      const cos = Math.cos(guide.angle);
      const sin = Math.sin(guide.angle);
      line.className = "canvas-guide canvas-guide-angle";
      line.style.left = `${origin.x - cos * reach}px`;
      line.style.top = `${origin.y - sin * reach}px`;
      line.style.width = `${reach * 2}px`;
      line.style.transform = `rotate(${guide.angle}rad)`;
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

/* ---------- Alt 测距 ---------- */

function setMeasureHeld(on) {
  if (measureHeld === on) return;
  measureHeld = on;
  if (on) scheduleMeasurements();
  else clearMeasurements();
}

function clearMeasurements() {
  if (measureFrame) {
    cancelAnimationFrame(measureFrame);
    measureFrame = 0;
  }
  if (ui?.measureLayer) ui.measureLayer.textContent = "";
}

function scheduleMeasurements() {
  if (!measureHeld || measureFrame) return;
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    drawMeasurements();
  });
}

/* 选中的块到四周最近面板的空隙：左右要求竖向有投影重叠，上下要求横向有重叠，
   只量真正“挨着的那一排/那一列”，不给斜对角硬拉一条线 */
function drawMeasurements() {
  const layer = ui?.measureLayer;
  if (!layer) return;
  layer.textContent = "";
  if (!measureHeld || !active || !current || editingId) return;
  const id = loneSelected();
  if (!id) return;
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el || item.type === "connector" || item.type === "line" || item.type === "arrow") return;
  const sel = itemBounds(item, el);
  const nearest = { left: null, right: null, top: null, bottom: null };
  for (const other of current.items) {
    if (other.id === id || other.type === "connector" || other.type === "line" || other.type === "arrow") continue;
    const otherEl = itemEls.get(other.id);
    if (!otherEl) continue;
    const b = itemBounds(other, otherEl);
    const overY = Math.min(sel.y + sel.h, b.y + b.h) - Math.max(sel.y, b.y);
    const overX = Math.min(sel.x + sel.w, b.x + b.w) - Math.max(sel.x, b.x);
    if (overY > 1) {
      const at = (Math.max(sel.y, b.y) + Math.min(sel.y + sel.h, b.y + b.h)) / 2;
      const leftGap = sel.x - (b.x + b.w);
      if (leftGap >= 0 && (!nearest.left || leftGap < nearest.left.gap)) {
        nearest.left = { gap: leftGap, b, at };
      }
      const rightGap = b.x - (sel.x + sel.w);
      if (rightGap >= 0 && (!nearest.right || rightGap < nearest.right.gap)) {
        nearest.right = { gap: rightGap, b, at };
      }
    }
    if (overX > 1) {
      const at = (Math.max(sel.x, b.x) + Math.min(sel.x + sel.w, b.x + b.w)) / 2;
      const topGap = sel.y - (b.y + b.h);
      if (topGap >= 0 && (!nearest.top || topGap < nearest.top.gap)) {
        nearest.top = { gap: topGap, b, at };
      }
      const bottomGap = b.y - (sel.y + sel.h);
      if (bottomGap >= 0 && (!nearest.bottom || bottomGap < nearest.bottom.gap)) {
        nearest.bottom = { gap: bottomGap, b, at };
      }
    }
  }

  /* 世界坐标换成屏幕坐标再画；两头的刻度由 CSS 伪元素补 */
  const ruler = (kind, from, to, gap) => {
    const a = worldToStage(from.x, from.y);
    const c = worldToStage(to.x, to.y);
    const line = document.createElement("div");
    line.className = `canvas-measure-line canvas-measure-${kind}`;
    if (kind === "h") {
      line.style.left = `${Math.min(a.x, c.x)}px`;
      line.style.top = `${a.y}px`;
      line.style.width = `${Math.abs(c.x - a.x)}px`;
    } else {
      line.style.left = `${a.x}px`;
      line.style.top = `${Math.min(a.y, c.y)}px`;
      line.style.height = `${Math.abs(c.y - a.y)}px`;
    }
    const label = document.createElement("span");
    label.className = "canvas-measure-label";
    label.textContent = String(Math.round(gap));
    label.style.left = `${(a.x + c.x) / 2}px`;
    label.style.top = `${(a.y + c.y) / 2}px`;
    layer.append(line, label);
  };

  if (nearest.left) {
    ruler(
      "h",
      { x: nearest.left.b.x + nearest.left.b.w, y: nearest.left.at },
      { x: sel.x, y: nearest.left.at },
      nearest.left.gap,
    );
  }
  if (nearest.right) {
    ruler(
      "h",
      { x: sel.x + sel.w, y: nearest.right.at },
      { x: nearest.right.b.x, y: nearest.right.at },
      nearest.right.gap,
    );
  }
  if (nearest.top) {
    ruler(
      "v",
      { x: nearest.top.at, y: nearest.top.b.y + nearest.top.b.h },
      { x: nearest.top.at, y: sel.y },
      nearest.top.gap,
    );
  }
  if (nearest.bottom) {
    ruler(
      "v",
      { x: nearest.bottom.at, y: sel.y + sel.h },
      { x: nearest.bottom.at, y: nearest.bottom.b.y },
      nearest.bottom.gap,
    );
  }
}

function startDraw(e) {
  const start = clientToWorld(e.clientX, e.clientY);
  let item = null;
  if (tool === "rect" || tool === "ellipse") item = makeBox(tool, start.x, start.y, start.x, start.y);
  else if (tool === "picture") item = makePicture(start.x, start.y, 0, 0);
  else if (tool === "scene") item = makeScene(start.x, start.y, 0, 0);
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
    scheduleMeasurements();
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
    /* 拖的是哪一头，另一端就是吸角度的原点 */
    const origin = drag.end === "a" ? { x: item.x2, y: item.y2 } : { x: item.x, y: item.y };
    const snapped = snapLineAngle(origin, point);
    const target = snapped ? snapped.point : point;
    if (drag.end === "a") {
      item.x = target.x;
      item.y = target.y;
    } else {
      item.x2 = target.x;
      item.y2 = target.y;
    }
    drawSnapGuides(snapped ? [snapped.guide] : []);
  } else if (drag.kind === "draw") {
    if (
      item.type === "rect" ||
      item.type === "ellipse" ||
      item.type === "picture" ||
      item.type === "scene"
    ) {
      item.x = Math.min(drag.start.x, point.x);
      item.y = Math.min(drag.start.y, point.y);
      item.w = Math.max(1, Math.abs(dx));
      item.h = Math.max(1, Math.abs(dy));
    } else if (item.type === "line" || item.type === "arrow") {
      /* 画的时候也吸：起点在按下处，鼠标离 45° 的倍数足够近就咬住 */
      const snapped = snapLineAngle({ x: item.x, y: item.y }, point);
      const target = snapped ? snapped.point : point;
      item.x2 = target.x;
      item.y2 = target.y;
      drawSnapGuides(snapped ? [snapped.guide] : []);
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
  settlePointerUp(e);
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
    if (hit) setHoverId(hit.id);
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
    /* 拖到一半这块没了（切画布/被别处删掉）：手势没有收尾，工具也得自己退回去 */
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

function updatePorts() {
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
function setHoverId(id) {
  if (hoverId && hoverId !== id) itemEls.get(hoverId)?.classList.remove("is-hover");
  hoverId = id;
  if (id) itemEls.get(id)?.classList.add("is-hover");
  updatePorts();
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
  /* 双击锁点：解除锁定。锁住的块不吃别的双击，所以这条放在最前 */
  const lockDot = e.target.closest?.(".canvas-lock-dot");
  if (lockDot) {
    const lockedEl = lockDot.closest?.(".canvas-item");
    const lockedItem = findItem(lockedEl?.dataset.id);
    if (lockedItem?.locked) {
      e.preventDefault();
      setLocked(lockedItem, false);
      showToast("已解锁");
    }
    return;
  }
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
  /* 双击图片：交给系统看图工具打开原图。画布上那块太小，看不清时用。
     锁只拦「改」不拦「读」，所以这条放在锁的判断前头。 */
  if (item.type === "image" || item.type === "gen") {
    if (!openImageByDoubleClick(e, item)) return;
    e.preventDefault();
    return;
  }
  /* 锁住的块不进入编辑 */
  if (item.locked) return;
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
function openImageByDoubleClick(e, item) {
  if (item.type === "gen" && !e.target.closest?.(".canvas-gen-image")) return false;
  if (!item.src) {
    if (item.type === "gen") showToast("这张还没出好，等出完了再双击");
    return false;
  }
  openImageExternally(item).catch(showError);
  return true;
}

function openImageExternally(item) {
  const canvasId = current?.meta?.id;
  if (!canvasId) return Promise.resolve();
  /* 块上的路径可能还没落盘（生图刚出完那一下），先把这笔存下去，后端才认得 */
  return flushItems().then(() => store.openCanvasImage(canvasId, item.id));
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
function colorEntry(item, prop, { presets, allowAlpha = true, save } = {}) {
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

const STACK_LABELS = {
  text: "文字",
  note: "笔记卡",
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
  ebook: "电子书",
  rect: "矩形",
  ellipse: "圆形",
  picture: "画面",
  scene: "场景",
  gen: "生图面板",
};

/* 右键落点下方还压着哪些块。DOM 命中永远只给最上面那块，
   被完全盖住的矩形只能从这一摞里挑。按层从高到低排。 */
function blocksBelowPoint(item, x, y) {
  if (!current) return [];
  const point = clientToWorld(x, y);
  const baseZ = Number(item.z) || 0;
  const baseIndex = current.items.findIndex((entry) => entry.id === item.id);
  const out = [];
  current.items.forEach((other, index) => {
    if (other.id === item.id) return;
    if (other.type === "connector" || other.type === "line" || other.type === "arrow") return;
    const otherEl = itemEls.get(other.id);
    if (!otherEl) return;
    const b = itemBounds(other, otherEl);
    if (point.x < b.x || point.x > b.x + b.w || point.y < b.y || point.y > b.y + b.h) return;
    const z = Number(other.z) || 0;
    /* z 相撞时按创建顺序判上下：后建的压在先建的上面，和 DOM 的叠法一致 */
    if (z > baseZ || (z === baseZ && index > baseIndex)) return;
    out.push({ item: other, index });
  });
  out.sort((a, b) => (Number(b.item.z) || 0) - (Number(a.item.z) || 0) || b.index - a.index);
  return out.map((entry) => entry.item);
}

function selectBelowEntry(item, x, y, depth = 0) {
  /* 只在最外层给这一项：嵌进某一层的菜单后再套一层会一路排到屏幕外，
     要再往下钻就收起菜单、在新选中的块上重新右键 */
  if (depth > 0) return null;
  const below = blocksBelowPoint(item, x, y);
  if (!below.length) return null;
  return {
    label: "选择下层",
    children: below.map((other) => ({
      label: `${STACK_LABELS[other.type] || other.type}${other.seq ? ` #${other.seq}` : ""}`,
      /* 悬停往右展开这一层的完整菜单（只是看）；点这一行才算选中，菜单收起 */
      onClick: () => select(other.id),
      children: withSelect(itemMenuEntries(other, x, y, depth + 1), other),
    })),
  };
}

/* 悬停只在看，选中得等真的动了里面的设置：
   给每个能落地的动作包一层，先选中这块再执行原来的动作。
   颜色/滑杆只包 onChange——只悬停看一眼色板、没动，不算选中。 */
function withSelect(entries, target) {
  return entries.map((entry) => {
    if (entry === "-") return entry;
    if (entry.children) {
      const copy = { ...entry, children: withSelect(entry.children, target) };
      if (copy.onClick) {
        const run = copy.onClick;
        copy.onClick = () => {
          select(target.id);
          run();
        };
      }
      return copy;
    }
    if (entry.colorPicker) {
      const cfg = entry.colorPicker;
      return {
        ...entry,
        colorPicker: {
          ...cfg,
          onChange: (value) => {
            select(target.id);
            cfg.onChange?.(value);
          },
        },
      };
    }
    if (entry.slider) {
      const cfg = entry.slider;
      return {
        ...entry,
        slider: {
          ...cfg,
          onChange: (value) => {
            select(target.id);
            cfg.onChange?.(value);
          },
        },
      };
    }
    if (entry.onClick) {
      const run = entry.onClick;
      return {
        ...entry,
        onClick: () => {
          select(target.id);
          run();
        },
      };
    }
    return entry;
  });
}

function openItemMenu(item, x, y) {
  openMenu(x, y, itemMenuEntries(item, x, y));
}

/* 一块的右键菜单内容。单独拆出来是为了「选择下层」：
   鼠标停在某一层上时，直接把这一层的菜单当子菜单挂出去。 */
function itemMenuEntries(item, x, y, depth = 0) {
  /* 锁住的块菜单只剩解锁和只读项：锁上之后要改什么都得先解开 */
  if (item.locked) {
    const entries = [];
    entries.push({ label: "解锁", onClick: () => setLocked(item, false) });
    const below = selectBelowEntry(item, x, y, depth);
    if (below) entries.push(below);
    if (PROP_KIND[item.type]) entries.push({ label: "属性", onClick: () => openItemProps(item) });
    if (revealTarget(item)) {
      entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
    }
    return entries;
  }
  const entries = [];
  const isShape = item.type === "rect" || item.type === "ellipse";
  if (isShape) {
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  }
  if (item.type === "rect") {
    entries.push({
      label: isContainer(item) ? "取消容器" : "编为容器",
      onClick: () => toggleContainer(item),
    });
    entries.push({ label: "落图", onClick: () => void dropRegionImage(item.id) });
  } else if (item.type === "line" || item.type === "arrow") {
    entries.push({ ...colorEntry(item, "borderColor"), label: "线条颜色" });
  } else if (item.type === "text") {
    entries.push({
      label: "文字",
      children: [colorEntry(item, "color"), { label: "字号", children: fontSizeMenuItems(item) }],
    });
    entries.push({
      label: "对齐",
      children: [
        {
          label: "水平",
          children: TEXT_ALIGN_H.map(([value, label]) => ({
            label: `${label}${item.align === value ? " ✓" : ""}`,
            onClick: () => setTextAlign(item, "align", value),
          })),
        },
        {
          label: "垂直",
          children: TEXT_ALIGN_V.map(([value, label]) => ({
            label: `${label}${item.vAlign === value ? " ✓" : ""}`,
            onClick: () => setTextAlign(item, "vAlign", value),
          })),
        },
      ],
    });
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
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
  } else if (item.type === "picture") {
    entries.push(...pictureMenuEntries(item));
    entries.push({ label: "落图", onClick: () => void exportPictureImage(item.id) });
  } else if (item.type === "image") {
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
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
  } else if (item.type === "note") {
    entries.push({ label: "编辑", onClick: () => startNoteEdit(item.id) });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "file") {
    if (isFileEditable(item)) {
      entries.push({ label: "编辑", onClick: () => startFileEdit(item.id) });
    }
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "product") {
    entries.push({ label: "更换图片…", onClick: () => void changeProductImage(item.id) });
    entries.push({ label: "设置 3D 模型…", onClick: () => void pickProductModel(item) });
    const scenes = current ? current.items.filter((one) => one.type === "scene") : [];
    entries.push({
      label: "放进 3D 场景",
      children: scenes.length
        ? scenes.map((scene) => ({
            label: `场景 #${scene.seq}`,
            onClick: () => void placeProductInSceneFlow(item, scene),
          }))
        : [{ label: "新建场景并放入", onClick: () => newSceneForProduct(item) }],
    });
    const plans = current ? current.items.filter((one) => one.type === "plan") : [];
    entries.push({
      label: "放到户型图",
      children: plans.length
        ? plans.map((plan) => ({
            label: `#${plan.seq} 户型图`,
            onClick: () => void placeProductOnPlanFlow(item, plan),
          }))
        : [{ label: "还没有户型图", disabled: true }],
    });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "quote") {
    entries.push({
      label: "导出清单",
      children: [
        { label: "Excel 表格（.xlsx）", onClick: () => void exportQuote(item, "xlsx").catch(showError) },
        { label: "CSV 表格（.csv）", onClick: () => void exportQuote(item, "csv").catch(showError) },
      ],
    });
    entries.push({ label: "从 CSV 导入产品…", onClick: () => void importCsvFromQuote(item) });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "plan") {
    entries.push({
      label: planCalibration?.itemId === item.id ? "取消定标" : "标定比例…",
      onClick: () => {
        if (planCalibration?.itemId === item.id) cancelPlanCalibration();
        else startPlanCalibration(item);
      },
    });
    if (item.calibration) {
      entries.push({
        label: "清除定标",
        onClick: () => {
          item.calibration = null;
          const el = itemEls.get(item.id);
          if (el) syncItemElement(el, item);
          scheduleItemsSave();
        },
      });
    }
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "page") {
    entries.push({ label: "重命名页…", onClick: () => renamePageFlow(item) });
    entries.push({
      label: "页面比例",
      children: Object.entries(PAGE_RATIOS).map(([value, preset]) => ({
        label: `${preset.label}${item.ratio === value ? " ✓" : ""}`,
        onClick: () => setPageRatio(item, value),
      })),
    });
    entries.push({ label: "设为第几页…", onClick: () => setPageOrderFlow(item) });
  } else if (item.type === "scene") {
    entries.push({
      label: scenePlacementActive(item) ? "退出家具摆放" : "摆放家具",
      onClick: () => setScenePlacementMode(item, !scenePlacementActive(item)),
    });
    entries.push({
      label: "重置视角",
      onClick: () => {
        item.camera = null;
        const el = itemEls.get(item.id);
        if (el) syncItemElement(el, item);
        scheduleItemsSave();
      },
    });
    entries.push({
      label: "视角",
      children: [
        ["auto", "自动"],
        ["front", "正面"],
        ["left", "左角"],
        ["right", "右角"],
        ["top", "俯视"],
      ].map(([value, label]) => ({
        label,
        onClick: () => setSceneCameraPreset(item, value),
      })),
    });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
  }
  /* 连线不复制：它两头挂着块，粘出去无处可接。
     复制的语义：正文区有文字选区 → 复制纯文字；否则复制整块（面板） */
  if (item.type !== "connector") {
    const below = selectBelowEntry(item, x, y, depth);
    if (below) entries.push(below);
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
  /* 画布不替用户开文件，只把他带到那份文件躺着的地方 */
  if (revealTarget(item)) {
    entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
  }
  /* 属性：笔记报类型，媒体和文件类报绝对路径。文字、图形、连线没有「属性」这一行 */
  if (PROP_KIND[item.type]) {
    entries.push({ label: "属性", onClick: () => openItemProps(item) });
  }
  if (entries.length) entries.push("-");
  /* 锁定贴着删除放，都在分隔线下面 */
  if (item.type !== "connector") {
    entries.push({ label: "锁定", onClick: () => setLocked(item, true) });
  }
  entries.push({ label: "删除", danger: true, onClick: () => deleteItems([item.id]) });
  return entries;
}

/* 属性卡：每块都能说清自己是什么、怎么用；落在磁盘上的那种再报绝对路径。
   路径整段可选中、长路径换行显示，不拿省略号把中间藏掉。 */
const PROP_KIND = {
  text: { name: "文字", hint: "画布上的文字，双击就地编辑，可调字号、对齐与边框。" },
  rect: { name: "矩形", hint: "可设边框和底色的矩形，也能编成容器框住一组内容。" },
  ellipse: { name: "椭圆", hint: "可设边框和底色的椭圆。" },
  line: { name: "直线", hint: "按住 Shift 拖端点会吸到 45° 倍数。" },
  arrow: { name: "箭头", hint: "带箭头的线，按住 Shift 拖端点会吸到 45° 倍数。" },
  connector: { name: "连线", hint: "连接两块面板的线，可改线型、箭头和折点。" },
  note: { name: "笔记", hint: "Markdown 笔记卡，双击进入编辑。" },
  picture: { name: "画面（矢量）", hint: "矢量画面：绘制指令、素材和手绘笔画都在这块里。" },
  scene: { name: "场景（真 3D）", hint: "真 3D 场景：可摆家具、调光与机位，Ctrl 转、Shift 平移。" },
  gen: { name: "生图面板", hint: "提示词 + 开始，出图参数由 agent 调。" },
  product: { name: "产品卡", hint: "一件家具 / 材料：名称、价格、数量和真实尺寸。" },
  quote: { name: "清单", hint: "汇总画布内所有产品卡的金额，可导 CSV / XLSX。" },
  plan: { name: "户型图", hint: "两点定标后能量面积、摆家具脚印和 3D 机位。" },
  page: { name: "提案页", hint: "提案页框：按页导出客户版 PDF / 网页。" },
  image: { name: "图片", hint: "静态图片，可双击看大图。" },
  audio: { name: "音乐", hint: "音频面板，可播放和调音量。" },
  video: { name: "视频", hint: "视频面板，可播放和全屏。" },
  file: { name: "文件", hint: "文件面板，双击用系统默认程序打开。" },
  ebook: { name: "电子书", hint: "分章阅读的电子书面板。" },
};

/* 真正落在磁盘上的面板才报路径：文字、图形、卡片这些没有自己的文件 */
const PROP_PATH_TYPES = new Set(["note", "image", "audio", "video", "file", "ebook"]);

async function openItemProps(item) {
  if (!current || !PROP_KIND[item.type]) return;
  modalOpen = true;
  await showPropsCard(item);
  modalOpen = false;
}

function showPropsCard(item) {
  const kind = PROP_KIND[item.type];
  const path = PROP_PATH_TYPES.has(item.type) ? absolutePathOf(item, current?.meta.path || "") : "";
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog dialog-props" role="dialog" aria-modal="true">
        <p class="dialog-title">属性</p>
        <button class="dialog-close" type="button" aria-label="关闭">${CLOSE_X_SVG}</button>
        <p class="dialog-message props-kind"></p>
        <p class="dialog-message props-hint"></p>
        <p class="dialog-message props-path" hidden></p>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    const kindEl = mask.querySelector(".props-kind");
    const hintEl = mask.querySelector(".props-hint");
    const pathEl = mask.querySelector(".props-path");
    const closeBtn = mask.querySelector(".dialog-close");
    kindEl.textContent = kind?.name || item.type;
    hintEl.textContent = kind?.hint || "";
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
    /* 画面块的锁还要收回十字光标：锁上的画不供笔 */
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
  /* 空白处右键和标题栏工具按钮弹同一个工具清单 */
  openMenu(x, y, toolMenuEntries());
}

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32, 48];
const TEXT_ALIGN_H = [
  ["left", "左对齐"],
  ["center", "居中"],
  ["right", "右对齐"],
];
const TEXT_ALIGN_V = [
  ["top", "顶端"],
  ["middle", "居中"],
  ["bottom", "底端"],
];

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

function setTextAlign(item, prop, value) {
  if (item[prop] === value) return;
  item[prop] = value;
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
    /* 块一删，画布里那份副本当场进回收站（引入的原图是用户自己的，不碰）。
       别的块还指着同一个文件就先留着，等最后一块也删了再收。 */
    const canvasId = current.meta.id;
    const usedBy = (type, src) =>
      current.items.some((other) => other.type === type && other.src === src);
    if (item.type === "image" && item.src && !item.linked) {
      const { src } = item;
      if (!srcInUse(src)) void store.deleteCanvasImage(canvasId, src, false).catch(() => {});
    }
    /* 产品卡的产品图也是拷贝进画布的那份，跟着块一起回收 */
    if (item.type === "product" && item.src && !srcInUse(item.src)) {
      void store.deleteCanvasImage(canvasId, item.src, false).catch(() => {});
      imageCache.delete(item.src);
    }
    /* 户型图同理 */
    if (item.type === "plan" && item.src && !srcInUse(item.src)) {
      void store.deleteCanvasImage(canvasId, item.src, false).catch(() => {});
      imageCache.delete(item.src);
    }
    if (planCalibration?.itemId === item.id) cancelPlanCalibration();
    if (item.type === "audio" && item.src && !item.linked) {
      const { src } = item;
      if (!usedBy("audio", src)) void store.deleteCanvasAudio(canvasId, src, false).catch(() => {});
    }
    if (item.type === "video" && item.src && !item.linked) {
      const { src, audioRel } = item;
      if (!usedBy("video", src)) void store.deleteCanvasVideo(canvasId, src, false, audioRel).catch(() => {});
    }
    if (item.type === "picture") {
      clearTimeout(pictureTimers.get(item.id));
      pictureTimers.delete(item.id);
      /* 块没了，那一套笔和笔画栈也跟着清空：块 id 不会复用，留着只是漏 */
      pictureEditors.delete(item.id);
      void store.deletePicture(canvasId, item.id).catch(() => {});
      /* 垫的位图：拷贝进画布的那份跟着块一起回收（引入的原图是用户自己的，不碰） */
      for (const one of collectPictureImageSrcs(item.cmds, item.symbols)) {
        if (one.linked || !one.src) continue;
        if (/^[a-zA-Z]:[\\/]/.test(one.src) || one.src.startsWith("/")) continue;
        if (!srcInUse(one.src)) void store.deleteCanvasImage(canvasId, one.src, false).catch(() => {});
      }
    }
    if (item.type === "scene") {
      clearTimeout(sceneTimers.get(item.id));
      sceneTimers.delete(item.id);
      void store.deleteScene(canvasId, item.id).catch(() => {});
    }
    if (item.type === "gen") {
      clearTimeout(genTimers.get(item.id));
      genTimers.delete(item.id);
      /* 这一轮的运行态（第几步、预览图）跟着块走：不留，否则「一次一张」会被一块已经不存在的图卡住 */
      dropGenRun(item.id);
      void store.deleteGen(canvasId, item.id).catch(() => {});
      /* 出的那张图没人指着才回收：落块落出去的那张图片块还用它 */
      if (item.src && !srcInUse(item.src)) {
        void store.deleteCanvasImage(canvasId, item.src, false).catch(() => {});
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
      /* 引用块的原文件不归这里管，删的是画布自己那份 .md */
      if (!item.linked) void store.deleteNote(canvasId, item.id).catch(() => {});
    }
    /* 拷贝块的副本跟着块一起进回收站；引用块只断链接，原文件在用户手里不动 */
    if (item.type === "file" && item.src) {
      if (fileEditor?.itemId === item.id) flushFileEditor();
      filePreviewCache.delete(previewKey(item));
      if (!item.linked && !usedBy("file", item.src)) {
        void store.deleteCanvasFile(canvasId, item.src, false).catch(() => {});
      }
    }
    if (item.type === "ebook" && item.src) {
      ebookTocCache.delete(ebookKey(current.meta.id, item));
      if (!item.linked && !usedBy("ebook", item.src)) {
        void store.deleteCanvasFile(canvasId, item.src, false).catch(() => {});
      }
    }
  }
  for (const removeId of doomed) selectedIds.delete(removeId);
  updateSelection();
  refreshQuotes();
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

/* ---------- 笔记 / 画面块的内容文件 ----------
   一块一份，住在画布自己目录里：笔记 notes/<块id>.md，画面 pictures/<块id>.json。
   items.json 只留位置和层级，正文和笔画不再内嵌。 */

const CONTENT_WRITE_DELAY = 400;
let noteTimers = new Map();
let pictureTimers = new Map();
let sceneTimers = new Map();
let genTimers = new Map();
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

function persistNote(item) {
  if (!current || item.type !== "note" || item.linked) return;
  const canvasId = current.meta.id;
  scheduleContentWrite(noteTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target || target.linked) return;
    store.writeNoteText(canvasId, item.id, target.source || "").catch(showError);
  });
}

/* 画面的指令和素材表只认 pictures/<块id>.json 那一份：items.json 里没有它们，
   块自己的笔画撤销管的是画笔那层栈，和这儿无关。 */
function persistPicture(item) {
  if (!current || item.type !== "picture") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(pictureTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writePicture(canvasId, item.id, target.cmds || [], target.symbols || {}).catch(showError);
  });
}

/* 场景块里的东西只认 scenes/<块id>.json 那一份：items.json 里没有 parts。 */
function persistScene(item) {
  if (!current || item.type !== "scene") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(sceneTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writeScene(canvasId, item.id, target.parts || []).catch(showError);
  });
}

/* 面板写的那句话和那几个参数只认 genpanels/<块id>.json 那一份；
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
    mode: item.mode,
    strength: item.strength,
  };
}

/* 切画布、重命名、退出页面前把还没写完的正文补上，最后一次编辑不至于丢掉 */
async function flushBlockContents() {
  const canvasId = current?.meta.id;
  const pending = [
    ...[...noteTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "note" })),
    ...[...pictureTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "picture" })),
    ...[...sceneTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "scene" })),
    ...[...genTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "gen" })),
  ];
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
          (item.type === "note" && !item.linked) ||
          item.type === "picture" ||
          item.type === "scene" ||
          item.type === "gen",
      )
      .map(async (item) => {
        try {
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
              /* 老文件里没有这两个字段：按「看连线自己定」和上游默认改动幅度接上 */
              item.mode = GEN_MODES.includes(file.mode) ? file.mode : "auto";
              item.strength = Number.isFinite(file.strength)
                ? Math.min(1, Math.max(0, file.strength))
                : item.strength;
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

/* 这个路径还有谁指着（独立图片块、别的面板、画面块垫的位图都算一份）：
   回收旧图之前问一句，有人指着的就别动 */
const srcInUse = (src) =>
  Boolean(current) &&
  current.items.some(
    (other) =>
      other.src === src ||
      (other.type === "picture" &&
        collectPictureImageSrcs(other.cmds, other.symbols).some((one) => one.src === src)),
  );

/* ---------- 局部重绘：遮罩层 ----------
   每块一张 512×512 的黑底画布，白笔迹 = 要重绘的地方；出图时整张当 mask 传给引擎。 */
const GEN_MASK_SIZE = 512;
const genMaskBases = new Map(); // 块 id -> 取景窗里垫的底图地址
/* 块 id -> 涂抹模式开着没有：开着遮罩层才吃鼠标，关着就能拖面板 */
const genMaskModes = new Map();
/* agent 临时递过来的遮罩（base64），只在下一张用一次 */
const genRunMasks = new Map();
let maskPainting = null;

function applyGenMaskMode(el, id, on) {
  genMaskModes.set(id, on);
  genMaskCanvasOf(el)?.classList.toggle("is-active", on);
}

function genMaskCanvasOf(el) {
  return el?.querySelector(".canvas-gen-mask") || null;
}

function resetGenMask(canvas) {
  canvas.width = GEN_MASK_SIZE;
  canvas.height = GEN_MASK_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, GEN_MASK_SIZE, GEN_MASK_SIZE);
}

function attachGenMask(el, item) {
  const canvas = genMaskCanvasOf(el);
  if (!canvas || canvas.dataset.ready) return;
  canvas.dataset.ready = "1";
  resetGenMask(canvas);
  const at = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
  };
  const stroke = (e) => {
    const ctx = canvas.getContext("2d");
    const point = at(e);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(point.x, point.y, GEN_MASK_SIZE * 0.045, 0, Math.PI * 2);
    ctx.fill();
  };
  canvas.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const target = findItem(item.id);
    if (!target || target.locked) return;
    if (genModeFor(target, genInputItems(target).length) !== "inpaint") return;
    if (!genMaskModes.get(item.id)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    maskPainting = canvas;
    stroke(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (maskPainting !== canvas) return;
    e.preventDefault();
    stroke(e);
  });
  const stop = () => {
    if (maskPainting === canvas) maskPainting = null;
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
}

/* 局部重绘面板的底图：连线过来的第一张图；没有就清掉 */
async function refreshGenMaskBase(item) {
  if (!current) return;
  const mode = genModeFor(item, genInputItems(item).length);
  const source = mode === "inpaint" ? genInputItems(item)[0] : null;
  if (!source) {
    if (genMaskBases.delete(item.id)) refreshGenPanel(item.id);
    return;
  }
  const canvasId = current.meta.id;
  let url = "";
  try {
    if (source.type === "image" || (source.type === "gen" && source.src)) {
      url = await store.imageUrl(canvasId, source.src, Boolean(source.linked));
    } else if (source.type === "picture") {
      url = await genInputPng(source);
    }
  } catch {
    url = "";
  }
  if (!current || current.meta.id !== canvasId) return;
  if ((genMaskBases.get(item.id) || "") === url) return;
  if (url) genMaskBases.set(item.id, url);
  else genMaskBases.delete(item.id);
  refreshGenPanel(item.id);
}

/* 提示词框跟着内容长高、不出滚动条。只按「框这次长了多少」调整块高：
   用户拖角改块高、agent 改块高都不受影响，刷新多少次也不会把尺寸弹回去 */
function fitGenPrompt(itemId, prompt, grow = false) {
  const item = findItem(itemId);
  const el = itemEls.get(itemId);
  if (!item || !prompt || !el) return;
  /* 提示词框没显示（高清放大那档）：不参与量高，否则 0 和 56 的差会把块越撑越高 */
  if (prompt.hidden || prompt.offsetParent === null) return;
  const before = prompt.offsetHeight;
  /* 先压到 0 再读 scrollHeight：textarea 的 height:auto 只会退回 rows 行，
     不这么量出来的是三行的高度，长内容照样被裁 */
  prompt.style.height = "0px";
  const want = Math.max(56, prompt.scrollHeight);
  prompt.style.height = `${want}px`;
  if (!grow) return;
  const delta = want - before;
  if (!delta) return;
  item.h = Math.max(GEN_MIN_HEIGHT, item.h + delta);
  syncItemElement(el, item);
  scheduleItemsSave();
}

function attachGenPanel(el, item) {
  const bar = el.querySelector(".canvas-gen-bar");
  const prompt = el.querySelector(".canvas-gen-prompt");
  const runButton = el.querySelector(".canvas-gen-run");
  const placeButton = el.querySelector(".canvas-gen-place");
  if (!bar || !prompt || !runButton || !placeButton) return;
  /* 只有真正的控件吃掉按下：提示词框、下拉、按钮、涂抹层；
     行与行之间、按钮与按钮之间的空白留给拖整块 */
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("textarea, input, button, select, canvas")) e.stopPropagation();
  });
  /* 参数行这几颗下拉：点开一列，选中就写回块上，面板立刻跟着换字 */
  const select = (selector, makeEntries) => {
    const button = el.querySelector(selector);
    if (!button) return;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = findItem(item.id);
      if (!target || target.locked) return;
      const rect = button.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 6, makeEntries(target), { kind: "gen-select" });
    });
  };
  const check = (on) =>
    on
      ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.4 8.4 6.6 11.6 12.6 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : "";
  prompt.addEventListener("input", () => {
    const target = findItem(item.id);
    if (!target) return;
    target.prompt = prompt.value.slice(0, GEN_TEXT_MAX);
    persistGen(target);
    fitGenPrompt(item.id, prompt, true);
  });
  prompt.addEventListener("keydown", (e) => {
    /* 回车这一下是发出去，换行要按 Shift+Enter：框就三行高，写一句话用不着回车 */
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    runOrStopGen(item.id);
  });
  runButton.addEventListener("click", () => runOrStopGen(item.id));
  placeButton.addEventListener("click", () => placeGenImage(item.id));
  /* 上一张出的图跟着块一起回来：运行态记的是「这一轮」，重开画布时从 images/ 里接上 */
  const run = genRunOf(item.id);
  if (run.phase === "idle" && !run.imageUrl && !run.previewUrl && item.src) {
    patchGenRun(item.id, { imageUrl: imageCache.get(item.src) || "" });
  }
  attachGenMask(el, item);
  /* 涂抹开关：开着遮罩吃鼠标，关着才拖得动面板 */
  const brushButton = el.querySelector(".canvas-gen-brush");
  brushButton?.addEventListener("click", (e) => {
    e.stopPropagation();
    applyGenMaskMode(el, item.id, !genMaskModes.get(item.id));
    refreshGenPanel(item.id);
  });
  const clearButton = el.querySelector(".canvas-gen-clear");
  clearButton?.addEventListener("click", (e) => {
    e.stopPropagation();
    const canvas = genMaskCanvasOf(el);
    if (canvas) resetGenMask(canvas);
    showToast("遮罩已清空");
  });
  /* 高清放大的「补细节」开关：开了就在放大之后按提示词低强度重绘一遍 */
  const refineButton = el.querySelector(".canvas-gen-refine");
  refineButton?.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = findItem(item.id);
    if (!target || target.locked) return;
    target.refine = !target.refine;
    scheduleItemsSave();
    refreshGenPanel(target.id);
  });
  /* 局部重绘面板一建好就进涂抹态：拉开就是要涂的 */
  if (genModeFor(item, genInputItems(item).length) === "inpaint") {
    applyGenMaskMode(el, item.id, true);
  }
  syncGen(el, item, genFeedOf(item));
  fitGenPrompt(item.id, prompt);
  void refreshGenMaskBase(item);
}

function refreshGenPanel(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  syncGen(el, item, genFeedOf(item));
  /* 程序换掉提示词（agent 改词）后，框和块高都要跟着变；
     加载画布走的是 attachGenPanel 那一路，不会从这里重复加高 */
  fitGenPrompt(id, el.querySelector(".canvas-gen-prompt"), true);
}

/* 面板上那一行进料提示：接了几张、这一张会按哪档走。
   连线一改就有新答案，所以 refreshConnectors 末尾统一刷一遍。 */
function genFeedOf(item) {
  const sources = genInputItems(item);
  const mode = genModeFor(item, sources.length);
  return {
    mode,
    label: GEN_MODE_LABELS[mode] || mode,
    count: sources.length,
    baseUrl: genMaskBases.get(item.id) || "",
  };
}

function refreshGenFeeds() {
  if (!current) return;
  for (const item of current.items) {
    if (item.type === "gen") void refreshGenMaskBase(item);
    if (item.type === "gen") refreshGenPanel(item.id);
  }
}

/* 这一轮没出成：把上一次那张接回来显示。文件还在盘上，取景窗不该空着。 */
function keepLastGenImage(id) {
  const item = findItem(id);
  patchGenRun(id, { imageUrl: item && item.src ? imageCache.get(item.src) || "" : "" });
}

/* 面板的进料口就是连线：谁用线连到这块，谁就是输入图。
   一条线 = 拿那张当底图重绘，多条线 = 几张一起当参考图。
   块上明写了 t2i / i2i / edit 才盖掉这个推断——画风锚点那种「只有一张、
   但它是参考图不是底图」就得明写。 */
function genInputItems(item) {
  const out = [];
  for (const link of current?.items || []) {
    if (link.type !== "connector" || link.to?.item !== item.id) continue;
    const source = findItem(link.from?.item);
    if (source && source.id !== item.id && !out.includes(source)) out.push(source);
  }
  return out;
}

function genModeFor(item, count) {
  const stated = item.mode && item.mode !== "auto" ? item.mode : "";
  if (stated) return stated;
  if (!count) return "t2i";
  return count === 1 ? "i2i" : "edit";
}

/* 一块东西画成引擎能吃的 PNG。图片块和面板自己那张都在 images/ 里，读字节就行；
   画面块是矢量，走导出那套光栅化。场景块这一版还不吃——three.js 抓帧是另一件事。 */
async function genInputPng(item) {
  const space = current?.meta?.id;
  if (!space) throw new Error("没有打开的画布");
  if (item.type === "image" || (item.type === "gen" && item.src)) {
    return toPngDataUrl(await store.imageData(space, item.src, Boolean(item.linked)));
  }
  if (item.type === "picture") {
    /* 走导出那条光栅化：只画这一块，位图底会内联成 data:，纸色和笔迹都在 */
    const shot = await exporter.snapshot({
      region: { x: item.x, y: item.y, w: item.w, h: item.h },
      only: item.id,
      maxSide: 1024,
    });
    return `data:image/png;base64,${shot.data}`;
  }
  throw new Error(`「${item.type}」这块当不了输入图`);
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
  /* 放大这一档不读提示词，那句「先写一句提示词」在这儿是拦错人 */
  const mode = genModeFor(item, genInputItems(item).length);
  if (mode !== "upscale" && !(item.prompt || "").trim()) {
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
  void startGenRun(item);
}

async function startGenRun(item) {
  const id = item.id;
  const fail = (text) => {
    patchGenRun(id, { phase: "failed", error: text });
    keepLastGenImage(id);
    refreshGenPanel(id);
  };
  let body;
  try {
    const sources = genInputItems(item);
    const mode = genModeFor(item, sources.length);
    /* 一张一张取，别攒：一张就是几 MB 的 base64，同时来几张没意义 */
    const images = [];
    if (mode !== "t2i") {
      for (const source of sources) images.push(await genInputPng(source));
    }
    let mask = genRunMasks.get(id) || "";
    if (!mask && mode === "inpaint") {
      const canvas = genMaskCanvasOf(itemEls.get(id));
      if (!canvas) throw new Error("遮罩层没准备好，重开一下面板再试");
      mask = canvas.toDataURL("image/png");
    }
    genRunMasks.delete(id);
    body = {
      block: id,
      prompt: (item.prompt || "").trim(),
      mask,
      refine: mode === "upscale" ? Boolean(item.refine) : false,
      negative: item.negative || "",
      width: item.imageW,
      height: item.imageH,
      steps: item.steps,
      cfg: item.cfg,
      seed: item.seed,
      mode,
      strength: item.strength,
      images,
    };
  } catch (error) {
    fail(String(error?.message || error || "输入图取不出来"));
    return;
  }
  store.genStart(body).catch((error) => {
    const text = String(error?.message || error || "出图失败");
    if (genRunOf(id).phase === "canceled" || text === "已取消") {
      patchGenRun(id, { phase: "canceled" });
      refreshGenPanel(id);
      return;
    }
    fail(text);
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
    /* 上一张没人指着了才回收：跟删块同一套，当场进回收站 */
    if (old && old !== rel && !srcInUse(old)) {
      void store.deleteCanvasImage(canvasId, old, false).catch(() => {});
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

/* ---------- 画面块：右键菜单控件与手绘 ----------
   笔的状态长在块自己身上，不占画布工具栏那套一次性工具态：
   在画面里涂一笔，不该把「选择」的蓝色从工具栏上挤走。
   一块一套笔，撤销重做只退这块画过的笔画。
   先开「编辑」才能落笔：默认非编辑态，拖块、点选都和平常一样。 */

const PICTURE_PEN_LABELS = {
  pen: "钢笔",
  brush: "毛笔",
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
      editing: false,
      tool: "pen",
      color: PICTURE_INK_COLORS[0],
      size: PICTURE_WIDTH_STEPS[1],
      undo: [],
      redo: [],
    };
    pictureEditors.set(id, editor);
  }
  return editor;
}

/* 手里正捏着笔的那一块：只认「单选 + 编辑态」。
   键盘的 Ctrl+Z 只在这一块里生效，退的是画过的笔画。 */
function paintingTarget() {
  if (selectedIds.size !== 1) return null;
  const id = [...selectedIds][0];
  const editor = pictureEditors.get(id);
  if (!editor || !editor.editing) return null;
  return findItem(id)?.type === "picture" ? id : null;
}

/* 画面块的手绘控件全在右键菜单里：块身上不再挂常驻工具条，
   只留一个 is-painting 的十字光标提示「这一下是落墨不是挪块」。 */
function pictureMenuEntries(item) {
  const editor = pictureEditorOf(item.id);
  const penEntry = (kind) => ({
    label: `${PICTURE_PEN_LABELS[kind]}${editor.tool === kind ? " ✓" : ""}`,
    onClick: () => setPictureTool(item.id, kind),
  });
  const entries = [
    {
      label: `编辑${editor.editing ? " ✓" : ""}`,
      onClick: () => setPictureEditing(item.id, !editor.editing),
    },
    { label: "画笔", children: [penEntry("pen"), penEntry("brush")] },
    {
      label: "笔宽",
      children: PICTURE_WIDTH_STEPS.map((size) => ({
        label: `${size}${editor.size === size ? " ✓" : ""}`,
        trailing: `<svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true"><path d="M3 7h14" stroke="currentColor" stroke-width="${Math.min(size, 12)}" stroke-linecap="round"/></svg>`,
        onClick: () => {
          pictureEditorOf(item.id).size = size;
        },
      })),
    },
    {
      label: `橡皮${editor.tool === "eraser" ? " ✓" : ""}`,
      onClick: () => setPictureTool(item.id, "eraser"),
    },
    {
      label: "墨色",
      colorPicker: {
        get value() {
          return pictureEditorOf(item.id).color;
        },
        seed: PICTURE_INK_COLORS[0],
        presets: PICTURE_INK_COLORS,
        allowAlpha: false,
        onChange: (color) => {
          if (color) pictureEditorOf(item.id).color = color;
        },
      },
    },
    {
      label: "纸色",
      colorPicker: {
        get value() {
          return findItem(item.id)?.paperColor || "";
        },
        seed: "#ffffff",
        presets: PRESETS,
        allowAlpha: true,
        onChange: (color) => applyPicturePaper(item.id, color),
        onDone: (color) => applyPicturePaper(item.id, color),
      },
    },
    { label: "撤销笔画", disabled: !editor.undo.length, onClick: () => pictureStepMove(item.id, "undo") },
    { label: "重做笔画", disabled: !editor.redo.length, onClick: () => pictureStepMove(item.id, "redo") },
  ];
  return entries;
}

/* 纸色：画面块的底色。选全透明就存空串，卡片背景交回 transparent */
function applyPicturePaper(id, color) {
  const now = findItem(id);
  if (!now || now.locked) return;
  now.paperColor = color && !String(color).endsWith("00") ? color : "";
  const el = itemEls.get(id);
  if (el) syncItemElement(el, now);
  scheduleItemsSave();
}

/* 把这块画面落成一张图片块：渲染成 PNG 存进画布 images/，在它右边摆一块独立的图片面板。
   只渲染这一块，底下压着的别的块不跟着进图；之后就是普通图片，能拖、能双击看大图。 */
async function exportPictureImage(id) {
  const item = findItem(id);
  if (!item || item.type !== "picture" || !current) return null;
  const canvasId = current.meta.id;
  try {
    const shot = await exporter.snapshot({
      region: { x: item.x, y: item.y, w: item.w, h: item.h },
      only: item.id,
      maxSide: Math.max(1600, Math.round(Math.max(item.w, item.h) * 2)),
    });
    const rel = await store.saveCanvasImage(canvasId, shot.data, "png");
    if (!current || current.meta.id !== canvasId) return null;
    imageCache.set(rel, `data:image/png;base64,${shot.data}`);
    const placed = placeBlock({
      ...makeImage(item.x + item.w + GEN_PLACE_GAP, item.y, item.w, item.h, rel),
      /* 圆角跟着原面板走：原块是直角，落出来的图块也是直角。
         也不留边框——1px 边框会把图片内容挤小一丝，和原面板对不上 */
      radius: Number.isFinite(Number(item.radius)) ? Number(item.radius) : 0,
      borderWidth: 0,
    });
    showToast("已把这张画面落成图片块");
    return placed ? agentSummary(placed) : null;
  } catch (error) {
    showError(error);
    return null;
  }
}

/* 抓屏并在图片里裁出这块面板的屏幕范围。
   抓回来的是设备像素（DPR 1.5 时窗口宽 2723），按 innerWidth 反推比例。 */
async function grabRegionImage(item) {
  const shotUrl = await store.captureViewport();
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("抓屏结果读不出来"));
    img.src = shotUrl;
  });
  const dpr = image.naturalWidth / window.innerWidth;
  const rect = itemEls.get(item.id).getBoundingClientRect();
  /* 源坐标和源尺寸都取整：1.5 倍屏上 rect.left*1.5 常是 .5，
     直接用小数裁会让 drawImage 做半像素重采样，字就被糊了一层 */
  const sx = Math.round(rect.left * dpr);
  const sy = Math.round(rect.top * dpr);
  const sw = Math.max(1, Math.round(rect.width * dpr));
  const sh = Math.max(1, Math.round(rect.height * dpr));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png").split(",")[1];
}

/* 矩形落图：抓当前屏幕上的这块面板，存成 PNG 摆在右边。
   抓屏幕而不是离屏渲染，是因为屏幕上的字用 ClearType，离屏只有灰度抗锯齿，
   同一个颜色也会显得更粗；抓屏出来的图和面板逐像素一致。
   面板没完整露在视野里时抓不全，退回 ×2 离屏出图。 */
async function dropRegionImage(id) {
  if (!current || exporting) return null;
  const item = findItem(id);
  if (!item || item.type !== "rect") return null;
  const el = itemEls.get(id);
  if (!el) return null;
  const box = itemBounds(item, el);
  if (!(box.w > 0 && box.h > 0)) {
    showToast("这块的范围是空的，没东西可落");
    return null;
  }
  const canvasId = current.meta.id;
  const rect = el.getBoundingClientRect();
  const visible =
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= window.innerWidth &&
    rect.bottom <= window.innerHeight;

  exporting = true;
  showToast("正在按屏幕画面生成图片…");
  select(null);
  document.body.classList.add("is-screen-capturing");
  try {
    if (editingId || edgeLabelEditor) commitEditing();
    /* 等两帧再让窗口把藏掉记号的画面画出来，抓到的才是干净的一帧 */
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 120));

    let data;
    if (visible) {
      data = await grabRegionImage(item);
    } else {
      showToast("面板没完整露在视野里，按 ×2 离屏出图");
      const shot = await exporter.exportRegion({ box, quality: "high", transparent: false });
      data = shot.data;
    }
    const rel = await store.saveCanvasImage(canvasId, data, "png");
    if (!current || current.meta.id !== canvasId) return null;
    imageCache.set(rel, `data:image/png;base64,${data}`);
    const placed = placeBlock({
      ...makeImage(item.x + item.w + GEN_PLACE_GAP, item.y, box.w, box.h, rel),
      /* 圆角跟着原矩形走：它设了多少就多少，没设就是直角。
         也不留边框——1px 边框会把图片内容挤小一丝，和原面板对不上 */
      radius: Number.isFinite(Number(item.radius)) ? Number(item.radius) : 0,
      borderWidth: 0,
    });
    showToast("已把这块面板落成图片块");
    return placed ? agentSummary(placed) : null;
  } catch (error) {
    select(item.id);
    showError(error);
    return null;
  } finally {
    document.body.classList.remove("is-screen-capturing");
    exporting = false;
  }
}

/* 画面区自己收按下：笔要在这儿落墨，不能让这一下冒到舞台上去挪整块。
   控件都在右键菜单（pictureMenuEntries），块身上只留十字光标这一个状态提示。 */
function attachPictureTools(el, item) {
  el.querySelector(".canvas-picture-svg")?.addEventListener("pointerdown", (e) => onPicturePointerDown(e, item.id));
  syncPictureChrome(el, item);
}

function syncPictureChrome(el, item) {
  const editor = pictureEditorOf(item.id);
  /* 锁住的块不供笔：能选、能右键解锁，但不让人往一块钉死的画上落墨 */
  el.classList.toggle("is-painting", editor.editing && !item.locked);
}

function refreshPictureChrome(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (item && el) syncPictureChrome(el, item);
}

/* 点笔型只换笔，不顺手开编辑：编辑是总开关，开着才落得下去 */
function setPictureTool(id, kind) {
  const item = findItem(id);
  if (!item || item.type !== "picture") return;
  if (item.locked) return;
  pictureEditorOf(id).tool = kind;
  refreshPictureChrome(id);
}

/* 编辑总开关：打开后块内按下就是落笔，关掉回到拖块/点选 */
function setPictureEditing(id, on) {
  const item = findItem(id);
  if (!item || item.type !== "picture") return;
  if (on && item.locked) return;
  pictureEditorOf(id).editing = on;
  /* 进入编辑就把这块选中：看得见边界才知道笔落在哪儿 */
  if (on && !selectedIds.has(id)) select(id);
  refreshPictureChrome(id);
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
  /* 非编辑态什么都不拦：这一下该冒到舞台上去选中、挪块 */
  if (!editor.editing) return;
  /* 落笔先把上一次操作收尾：正编辑的文字、开着的菜单和色板。
     这一下按在画面里，svg 拦住了冒泡，那些「点外面就收起」的监听收不到，得自己关。
     色板要先关再取墨色——关的那一刻才落 onDone，新挑的颜色这时候才算进 editor。 */
  if (editingId) commitEditing();
  closeColorPicker(true);
  closeMenu();
  e.preventDefault();
  e.stopPropagation();
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

/* ---------- 笔记块 ---------- */

/* 笔记块内联编辑器：工具栏、撤销重做、粘贴图片都走 markdown-editor 那一套。
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
        title: "请确认编辑对象",
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
    toolbar.className = "md-toolbar canvas-note-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Markdown 工具栏");
    const textarea = document.createElement("textarea");
    textarea.className = "md-textarea canvas-note-textarea";
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

/* 「复制进画布」：正文落到画布自己的 notes/<块id>.md，链接断掉，原 .md 一个字节都不动。
   图片另说——引用期间本来就禁止贴图，块里不会有指向画布目录的图片路径。 */
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
        note: "改源文件会把整份正文写回那个文件；复制进画布则先把副本收进画布，原文件不动，之后随便改。",
        options: [
          { value: "write", label: "修改源文件", hint: "直接写回那份文本" },
          { value: "copy", label: "复制进画布", hint: "原文件不动，编辑画布里的副本" },
        ],
      });
    } finally {
      modalOpen = false;
      fileAskId = null;
    }
    /* 弹层期间可能切了画布 / 关了页面，块早就不存在了 */
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

/* 「复制进画布」：把副本收进 files/，块改指副本，原文件一个字节都不动。 */
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
  textarea.className = "md-textarea canvas-file-textarea";
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

/* 切画布、关页面、重画整个画布、删块：编辑框跟着没了，稿子仍要落盘。
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
        message: `「${state.item.name}」在你编辑期间被别的程序改过。要用画布里这份覆盖吗？`,
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
    /* 画布已经切走时不碰 items：那份 items 不再会落盘，改了只会让内存和盘上对不上 */
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

/* 引用块的正文只是显示缓存，进画布时现读一次原文件，用户在外面改了也能看到。
 * 读不到就当原文件没了：块和最后一次读到的正文都留着，只把角标换成那句话，
 * 别把整个画布卡在这。返回这些读不到的块，renderAll 之后再改角标。 */
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
   Ctrl+C 存下这批块的一份快照（连它来自哪个画布一起记），Ctrl+V 落一批全新的块。
   笔记带上自己那份 .md，拷贝态媒体真再拷一份副本，引用态还是指着同一份原文件；
   连线不复制。同画布落在原块右下方一格，跨画布跟着鼠标落。 */

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
   所以媒体一律真再拷一份，引用态那块粘过来就地转成画布自己的副本。
   返回 false 表示这块落不了地（原文件都找不着），只报错，不摆一块假的上画布。 */
async function landBlock(item, fromId, sourceId) {
  const canvasId = current.meta.id;

  if (item.type === "note") {
    /* 引用外部 .md 的那一块，复制出来是画布里的新副本，不再连着原文件 */
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
       引用本机绝对路径的那种也一并收进画布——不然换个画布就只剩虚线框。
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
       这条命令就是「把源画布 images/ 里的那个文件拷进目标画布」，画面块也用同一份 */
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

  if (item.type === "product" && item.src) {
    /* 产品图跟着卡走一份自己的副本，删哪一块都不该动到另一张卡的图 */
    const rel = await store.duplicatePictureImage(fromId, item.src, false, canvasId).catch(() => "");
    if (rel) {
      item.src = rel;
      try {
        imageCache.set(rel, await store.imageUrl(canvasId, rel, false));
      } catch {
        imageCache.set(rel, null);
      }
    } else {
      item.src = "";
      showError("产品图没拷过来（原图已经不在了），这张卡先只带字段");
    }
    return true;
  }

  if (item.type === "plan" && item.src) {
    /* 户型图也跟着块独立拷一份 */
    const rel = await store.duplicatePictureImage(fromId, item.src, false, canvasId).catch(() => "");
    if (rel) {
      item.src = rel;
      try {
        imageCache.set(rel, await store.imageUrl(canvasId, rel, false));
      } catch {
        imageCache.set(rel, null);
      }
    } else {
      item.src = "";
      showError("户型图没拷过来（原图已经不在了），脚印和定标保留");
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
  /* 顺手写进系统剪贴板，换个画布、换个窗口也还能粘；写不写得成本地这份照旧能用 */
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
  /* 同画布右下挪一格，跨画布落在鼠标这儿 */
  const box = selectionBox(blocks.filter((raw) => raw.type !== "connector"));
  const anchor =
    payload.canvasId === canvasId
      ? { x: box.x + PASTE_OFFSET, y: box.y + PASTE_OFFSET }
      : pastePoint();
  const placed = [];
  for (const raw of blocks) {
    /* 拷贝副本那几下是异步的：期间切了画布就别再把块往原来那个画布上摆 */
    if (!current || current.meta.id !== canvasId) return;
    const item = normalizeItem({ ...raw, id: newId(), seq: 0, z: null });
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
 * 一批路径先问一次「拷进画布还是只引用」，答案整批通用，取消就一个都不插；
 * 再按扩展名分流——能显示的直接显示，显示不了的才做附件卡片。
 * 一次进来好几个就整排铺开（见 batchRowPoint），单个才按入口给的位置落。
 * origin 是拖入的落点：单个文件落在这儿，一批文件在空白画布上也从这儿起排。 */
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
      /* 中途切了画布就别往新画布里插东西 */
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

/* 插完把视野带到第一个新块那儿，不然画布一大就不知道东西落去了哪里。
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

/* 一批文件的整排落点：左端对齐到画布上最靠左那块，顶边落在最靠下那块的底边再空一档。
   排下一个时按前一块的实际宽度往右走，块与块之间同样空一档，所以混着类型也不会压在一起。
   画布还空着（或只有连线）没有参照，就从拖入落点起排，落点也没有就按视野正中。 */
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

/* 工具栏的插入文件按钮：开文件框 → 把选中的路径交给统一流程，按扩展名落成图片/音乐/视频/附件 */
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

/* 面板摆在视口正中，档位按入口预设；提示词和参数从这一刻起就归 genpanels/ 那份文件管 */
function insertGenPanel(mode) {
  if (!current) return;
  const at = insertPoint(GEN_DEFAULT_WIDTH, GEN_DEFAULT_HEIGHT);
  const item = makeGen(at.x, at.y);
  item.mode = mode;
  placeBlock(item);
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
  const item = makeImage(at.x, at.y, fit.w, fit.h, src, linked);
  item.name = baseName(path);
  return placeBlock(item);
}

/* ---------- 产品 / 材料卡与清单 ---------- */

function productItems() {
  return current ? current.items.filter((item) => item.type === "product") : [];
}

/* 产品一改，画布上的清单整块重画：清单里的数字永远按产品卡现算 */
function refreshQuotes() {
  if (!current) return;
  const products = productItems();
  for (const item of current.items) {
    if (item.type !== "quote") continue;
    const el = itemEls.get(item.id);
    if (el) refreshQuoteCard(el, item, products);
  }
}

/* 一格就地编辑：Enter / 失焦提交，Esc 放弃。提交后由调用方重画 */
function inlineEditField(fieldEl, value, onCommit, options = {}) {
  if (!fieldEl) return;
  const input = document.createElement("input");
  input.className = options.className || "canvas-product-edit";
  if (options.field) input.dataset.field = options.field;
  input.type = "text";
  if (options.numeric) input.inputMode = "decimal";
  input.spellcheck = false;
  input.value = value;
  fieldEl.textContent = "";
  fieldEl.append(input);
  input.focus();
  input.select();
  let settled = false;
  let cancelled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    if (commit && !cancelled) onCommit(input.value.trim());
    input.remove();
    options.onSettled?.();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelled = true;
      input.blur();
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
}

function attachProductCard(el, item) {
  const card = el.querySelector(".canvas-product-card");
  if (!card) return;
  card.addEventListener("dblclick", (event) => {
    const fieldEl = event.target.closest("[data-field]");
    if (!fieldEl || fieldEl.closest(".canvas-product-edit")) return;
    event.preventDefault();
    event.stopPropagation();
    if (item.locked) return;
    startProductFieldEdit(item.id, fieldEl.dataset.field, fieldEl);
  });
  /* 双击图片直接换图，和右键「更换图片…」同一个入口 */
  el.querySelector(".canvas-product-media")?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (item.locked) return;
    void changeProductImage(item.id);
  });
}

function startProductFieldEdit(itemId, field, fieldEl) {
  const item = findItem(itemId);
  if (!item || item.locked || !["name", "brand", "sku", "spec", "price", "qty"].includes(field)) return;
  const value =
    field === "price" ? String(item.price) : field === "qty" ? String(item.qty) : String(item[field] ?? "");
  const numeric = field === "price" || field === "qty";
  inlineEditField(
    fieldEl,
    value,
    (raw) => {
      let next = raw;
      if (field === "price") {
        const amount = Number(raw.replace(/[¥￥,\s元]/g, ""));
        next = Number.isFinite(amount) && amount >= 0 ? amount : item.price;
      } else if (field === "qty") {
        const count = Math.trunc(Number(raw.replace(/[×xX\s]/g, "")));
        next = Number.isFinite(count) && count >= 1 ? count : item.qty;
      } else if (field === "name") {
        next = raw || item.name;
      }
      if (next !== item[field]) {
        item[field] = next;
        scheduleItemsSave();
        refreshQuotes();
      }
    },
    {
      field,
      numeric,
      onSettled: () => {
        const el = itemEls.get(item.id);
        if (el) syncItemElement(el, item);
      },
    },
  );
}

function scenePlacementActive(item) {
  return Boolean(itemEls.get(item.id)?.querySelector(".canvas-scene-card.is-placing"));
}

function setScenePlacementMode(item, enabled) {
  if (item.type !== "scene") throw new Error("要选择场景块");
  if (enabled && item.locked) throw new Error("场景已锁定，请先解锁");
  const el = itemEls.get(item.id);
  const card = el?.querySelector(".canvas-scene-card");
  if (!card) throw new Error("场景还没显示出来");
  card.classList.toggle("is-placing", enabled);
  if (!enabled) setSceneFurnitureSelection(card.querySelector(".canvas-scene-view"), []);
  return { id: item.id, placement: enabled };
}

function sceneFurnitureGroup(item, index) {
  if (!Number.isInteger(index) || index < 0 || index >= item.parts.length) throw new Error("家具零件序号无效");
  const part = item.parts[index];
  if (!part.surface) return null;
  const surface = item.surfaces.find((one) => one.id === part.surface);
  if (!surface) throw new Error(`找不到附着面 ${part.surface}`);
  const indices = part.group
    ? item.parts.flatMap((one, at) => one.group === part.group ? [at] : [])
    : [index];
  if (indices.some((at) => item.parts[at].surface !== part.surface)) throw new Error("同一件家具必须绑定同一附着面");
  return { indices, surface, group: part.group || String(index) };
}

function moveSceneFurnitureParts(item, origins, delta) {
  for (const origin of origins) {
    const part = item.parts[origin.index];
    part.x = origin.x + delta.x;
    part.y = origin.y + delta.y;
    part.z = origin.z + delta.z;
  }
}

function attachSceneControls(el, item) {
  const card = el.querySelector(".canvas-scene-card");
  if (!card) return;
  let frame = 0;
  const renderSoon = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const target = itemEls.get(item.id);
      if (target) syncItemElement(target, item);
    });
  };
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || item.locked) return;
    /* 普通左键不碰内部：交回舞台，和别的块一样拖整块 / 点选 */
    if (!event.ctrlKey && !event.shiftKey && !scenePlacementActive(item)) return;
    event.preventDefault();
    event.stopPropagation();
    select(item.id);
    dropTool();
    if (!event.ctrlKey && !event.shiftKey) {
      const view = card.querySelector(".canvas-scene-view");
      try {
        const hit = scenePick(view, event.clientX, event.clientY);
        const furniture = hit ? sceneFurnitureGroup(item, hit.index) : null;
        setSceneFurnitureSelection(view, furniture?.indices || []);
        if (!furniture) return;
        const movement = beginSceneFurnitureDrag(view, furniture.indices, furniture.surface, event.clientX, event.clientY);
        if (!movement) return;
        item.camera = normalizeSceneCamera(sceneCameraState(item, view));
        const origins = furniture.indices.map((index) => ({ index, ...item.parts[index] }));
        let moved = false;
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          window.removeEventListener("blur", up);
          if (moved) persistScene(item);
          scheduleItemsSave();
        };
        const move = (e) => {
          if (e.pointerId !== event.pointerId) return;
          if (!card.isConnected || item.locked || !scenePlacementActive(item)) { up(); return; }
          const delta = sceneFurnitureDragDelta(view, movement, e.clientX, e.clientY);
          if (!delta) return;
          moveSceneFurnitureParts(item, origins, delta);
          moved = true;
          renderSoon();
        };
        if (event.isTrusted) card.setPointerCapture(event.pointerId);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        window.addEventListener("blur", up);
      } catch (error) {
        showError(error);
      }
      return;
    }
    const base = sceneCameraState(item);
    const startX = event.clientX;
    const startY = event.clientY;
    const panning = event.shiftKey;
    const interactionClass = panning ? "is-panning" : "is-orbiting";
    const unitsPerPixel = (2 * base.dist * Math.tan((base.fov * Math.PI) / 360)) / card.getBoundingClientRect().height;
    const azim = (base.azim * Math.PI) / 180;
    const elev = (base.elev * Math.PI) / 180;
    card.classList.add(interactionClass);
    const move = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (panning) {
        const right = dx * unitsPerPixel;
        const down = dy * unitsPerPixel;
        // 相机目标沿屏幕右轴反向、上轴正向移动，模型才会跟随鼠标。
        item.camera = normalizeSceneCamera({
          ...base,
          tx: base.tx + right * Math.cos(azim) - down * Math.sin(azim) * Math.sin(elev),
          ty: base.ty - right * Math.sin(azim) - down * Math.cos(azim) * Math.sin(elev),
          tz: base.tz + down * Math.cos(elev),
        });
      } else {
        item.camera = normalizeSceneCamera({
          ...base,
          azim: base.azim - dx * 0.35,
          elev: base.elev + dy * 0.25,
        });
      }
      renderSoon();
    };
    const up = () => {
      card.classList.remove(interactionClass);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      scheduleItemsSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  card.addEventListener(
    "wheel",
    (event) => {
      if (item.locked) return;
      event.preventDefault();
      event.stopPropagation();
      const base = sceneCameraState(item);
      item.camera = normalizeSceneCamera({
        ...base,
        dist: base.dist * (event.deltaY > 0 ? 1.1 : 0.9),
      });
      renderSoon();
      scheduleItemsSave();
    },
    { passive: false },
  );
}

function attachQuoteCard(el, item) {
  const title = el.querySelector(".canvas-quote-title");
  title?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (item.locked) return;
    inlineEditField(
      title,
      item.title || "家具清单",
      (raw) => {
        const next = raw || item.title;
        if (next !== item.title) {
          item.title = next;
          scheduleItemsSave();
        }
      },
      {
        className: "canvas-quote-edit",
        onSettled: () => {
          const target = itemEls.get(item.id);
          if (target) refreshQuoteCard(target, item, productItems());
        },
      },
    );
  });
}

async function changeProductImage(itemId) {
  const item = findItem(itemId);
  if (!item || item.locked || !current) return;
  const canvasId = current.meta.id;
  try {
    const path = await store.pickCanvasImage();
    if (!path || !current || current.meta.id !== canvasId) return;
    const rel = await store.importCanvasImage(canvasId, path);
    if (!current || current.meta.id !== canvasId) return;
    const url = await store.imageUrl(canvasId, rel, false);
    const old = item.src;
    item.src = rel;
    imageCache.set(rel, url);
    const media = itemEls.get(item.id)?.querySelector(".canvas-product-media");
    if (media) {
      media.textContent = "";
      const img = document.createElement("img");
      img.className = "canvas-product-img";
      img.src = url;
      img.draggable = false;
      img.alt = item.name || "";
      media.append(img);
    }
    if (old && old !== rel) {
      imageCache.delete(old);
      if (!srcInUse(old)) void store.deleteCanvasImage(canvasId, old, false).catch(() => {});
    }
    scheduleItemsSave();
  } catch (error) {
    showError(error);
  }
}

/* ---- CSV：表头中英文都认，图片列相对 CSV 所在目录解析 ---- */

const CSV_HEADER_ALIASES = {
  name: ["名称", "产品名称", "家具名称", "品名", "name"],
  brand: ["品牌", "brand"],
  sku: ["sku", "编号", "型号", "货号", "商品编码"],
  spec: ["规格", "尺寸", "spec"],
  price: ["单价", "价格", "报价", "price"],
  qty: ["数量", "件数", "qty", "quantity"],
  source: ["来源", "链接", "网址", "source", "url"],
  note: ["备注", "说明", "note"],
  image: ["图片", "图片路径", "图片文件", "image", "img"],
  model: ["模型", "模型文件", "glb", "model"],
};

const normalizeCsvHeader = (value) => String(value || "").trim().toLowerCase().replace(/[\s_\-]/g, "");

function parseCsvText(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((line) => line.some((value) => String(value).trim()));
}

function csvColumnIndex(headerRow) {
  const lookup = new Map();
  for (const [field, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    for (const alias of aliases) lookup.set(normalizeCsvHeader(alias), field);
  }
  const map = new Map();
  headerRow.forEach((cell, index) => {
    const field = lookup.get(normalizeCsvHeader(cell));
    if (field && !map.has(field)) map.set(field, index);
  });
  return map;
}

const csvAmount = (value) => {
  const amount = Number(String(value || "").replace(/[¥￥,\s元]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
};

/* 图片列写相对路径时按 CSV 所在目录算；写绝对路径就照用 */
function resolveCsvImagePath(csvPath, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return raw;
  const cut = Math.max(csvPath.lastIndexOf("\\"), csvPath.lastIndexOf("/"));
  const dir = cut > 0 ? csvPath.slice(0, cut) : "";
  return dir ? `${dir}\\${raw.replace(/\//g, "\\")}` : raw;
}

async function importProductsFromCsv(path, origin) {
  if (!active || !current) throw new Error("先打开一个画布");
  const canvasId = current.meta.id;
  const text = await store.readTextFile(path);
  if (!current || current.meta.id !== canvasId) throw new Error("读 CSV 的时候画布被切走了");
  const rows = parseCsvText(text);
  if (!rows.length) throw new Error("这份 CSV 是空的");
  const columnsMap = csvColumnIndex(rows[0]);
  if (!columnsMap.has("name")) {
    throw new Error("CSV 里找不到「名称」列（也认 name / 产品名称 / 品名）");
  }
  const start = origin || insertPoint(PRODUCT_DEFAULT_WIDTH, PRODUCT_DEFAULT_HEIGHT);
  const gap = 20;
  const columns = 3;
  let created = 0;
  let skipped = 0;
  let imagesMissing = 0;
  let first = null;
  for (const row of rows.slice(1)) {
    const get = (field) => (columnsMap.has(field) ? String(row[columnsMap.get(field)] ?? "").trim() : "");
    const name = get("name");
    if (!name) {
      skipped += 1;
      continue;
    }
    const product = makeProduct(0, 0, name);
    product.brand = get("brand");
    product.sku = get("sku");
    product.spec = get("spec");
    product.price = Math.max(0, csvAmount(get("price")));
    const qty = Math.trunc(csvAmount(get("qty")));
    product.qty = qty >= 1 ? qty : 1;
    product.source = get("source");
    product.note = get("note");
    product.model = get("model");
    const imagePath = resolveCsvImagePath(path, get("image"));
    if (imagePath) {
      try {
        const rel = await store.importCanvasImage(canvasId, imagePath);
        if (!current || current.meta.id !== canvasId) throw new Error("导入时画布被切走了");
        product.src = rel;
        try {
          imageCache.set(rel, await store.imageUrl(canvasId, rel, false));
        } catch {
          imageCache.set(rel, null);
        }
      } catch {
        imagesMissing += 1;
      }
    }
    product.x = start.x + (created % columns) * (PRODUCT_DEFAULT_WIDTH + gap);
    product.y = start.y + Math.floor(created / columns) * (PRODUCT_DEFAULT_HEIGHT + gap);
    if (!placeBlock(product)) throw new Error("产品卡没能落进画布");
    first = first || product;
    created += 1;
  }
  refreshQuotes();
  scheduleItemsSave();
  if (first) {
    select(first.id);
    revealItem(first);
  }
  return { created, skipped, imagesMissing };
}

async function importCsvFromQuote(quote) {
  if (!current) return;
  const canvasId = current.meta.id;
  try {
    const path = await store.pickCsv();
    if (!path || !current || current.meta.id !== canvasId) return;
    const result = await importProductsFromCsv(path, { x: quote.x, y: quote.y + quote.h + 40 });
    const parts = [`导入 ${result.created} 项`];
    if (result.skipped) parts.push(`跳过 ${result.skipped} 行`);
    if (result.imagesMissing) parts.push(`${result.imagesMissing} 张图没找到`);
    showToast(parts.join("，"));
  } catch (error) {
    showError(error);
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function exportQuote(item, format) {
  const products = productItems();
  if (!products.length) throw new Error("清单里还没有产品卡");
  const rows = [["名称", "品牌", "SKU", "规格", "单价", "数量", "小计"]];
  let total = 0;
  for (const product of products) {
    const line = product.price * product.qty;
    total += line;
    rows.push([product.name, product.brand, product.sku, product.spec, product.price, product.qty, line]);
  }
  rows.push(["合计", "", "", "", "", "", total]);
  const name = item.title || "清单";
  if (format === "csv") {
    const text = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    const saved = await store.exportSave(name, "csv", bytesToBase64(new TextEncoder().encode(text)));
    if (saved) showToast("清单已导出");
    return;
  }
  const writer = window.XLSX;
  if (!writer) throw new Error("表格组件没加载起来");
  const book = writer.utils.book_new();
  const sheet = writer.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 16 }, { wch: 24 }, { wch: 10 }, { wch: 8 }, { wch: 12 }];
  writer.utils.book_append_sheet(book, sheet, "清单");
  const buffer = writer.write(book, { type: "array", bookType: "xlsx" });
  const saved = await store.exportSave(name, "xlsx", bytesToBase64(new Uint8Array(buffer)));
  if (saved) showToast("清单已导出");
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
  const size = info.markdown
    ? { w: NOTE_DEFAULT_WIDTH, h: NOTE_DEFAULT_HEIGHT }
    : fileBlockSize(info);
  const at = topLeft || insertPoint(size.w, size.h);
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

/* 哪块指向磁盘上的一个文件、以及它在哪儿：引用外部 .md 的笔记块 path 是原文件的绝对路径，
   不在画布目录里，所以一律按引用态去定位；其余块的 src 拷贝态是画布内相对路径。 */
function revealTarget(item) {
  /* 画布自己的笔记：那块的内容文件叫 <块id>.md，路径后端自己拼 */
  if (item.type === "note" && !item.linked) return { block: true };
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
  /* 笔记那块的文件名就是块 id，画布目录后端知道，前端一个字都不用递 */
  const call = target.block
    ? store.revealBlock(current.meta.id, item.id)
    : store.revealCanvasFile(current.meta.id, target.rel, target.linked);
  call.catch((error) => showError(error));
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
  /* 新进来一张产品卡，清单当场重算：粘贴、复制、批量导入都走这里 */
  if (item.type === "product") refreshQuotes();
  select(item.id);
  scheduleItemsSave();
  /* 笔记/画面/场景从建下来那一刻就有自己那份文件，内容以后只认文件 */
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
  if (!current) throw new Error("当前没有打开的画布");
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
    seq: item.seq || null,
    type: item.type,
    z: Number.isFinite(item.z) ? item.z : null,
    locked: Boolean(item.locked),
  };
  if (item.type !== "connector") Object.assign(base, agentBounds(item), { internal: item.internal });
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
      align: item.align || "left",
      vAlign: item.vAlign || "top",
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
      surfaces: item.surfaces,
      placement: scenePlacementActive(item),
      camera: item.camera || null,
      light: item.light || null,
      groundColor: item.groundColor || "",
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "product") {
    return {
      ...base,
      name: item.name,
      brand: item.brand,
      sku: item.sku,
      spec: item.spec,
      price: item.price,
      qty: item.qty,
      source: item.source,
      note: item.note,
      src: item.src,
      model: item.model,
      dims: item.dims,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "quote") {
    const products = current ? current.items.filter((one) => one.type === "product") : [];
    return {
      ...base,
      title: item.title,
      count: products.length,
      total: products.reduce((sum, one) => sum + one.price * one.qty, 0),
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "plan") {
    return {
      ...base,
      imageW: item.imageW,
      imageH: item.imageH,
      calibration: item.calibration,
      footprints: item.footprints,
      cameras: item.cameras,
      areas: item.areas,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "page") {
    return {
      ...base,
      title: item.title,
      ratio: item.ratio,
      order: item.order,
    };
  }
  if (item.type === "gen") {
    /* 这一轮的相位在这儿一并报：等一张图的时候 agent 得问得出「还在跑」 */
    const run = genRunOf(item.id);
    const feed = genFeedOf(item);
    return {
      ...base,
      prompt: item.prompt || "",
      negative: item.negative || "",
      imageW: item.imageW,
      imageH: item.imageH,
      steps: item.steps,
      cfg: item.cfg,
      seed: item.seed,
      /* 出图那一档：mode 是块上写的（auto=看连线），feed 是这次真会走的 */
      mode: item.mode || "auto",
      strength: item.strength,
      feed,
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
   这期间不运镜、不打光带——一个块一次镜头跳动，看的人只会晕。 */
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
  if (!target) throw new Error(`找不到画布「${key}」`);
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
  if (!current || current.meta.id !== target.id) throw new Error(`打开画布「${target.name}」失败`);
  return { space: { id: current.meta.id, name: current.meta.name }, blocks: current.items.length };
}

async function agentCreateSpace(name, parent) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("画布名不能为空");
  const parentId = parent && String(parent).trim() ? (await agentFindGroup(parent)).id : null;
  const data = await store.createCanvas(clean, parentId);
  const meta = data?.meta;
  if (!meta) throw new Error("画布建好了，但没拿到它的信息");
  await loadList();
  if (active) await switchTo(meta.id);
  return { id: meta.id, name: meta.name, opened: Boolean(current && current.meta.id === meta.id) };
}

/* 分组引用：id（相对路径）优先；名字只在唯一时才认，同名分组必须给 id */
async function agentFindGroup(ref) {
  await loadList();
  const key = String(ref ?? "").trim();
  const groups = treeGroupList();
  const byId = groups.find((group) => group.id === key);
  if (byId) return byId;
  const matches = groups.filter((group) => group.id.split("/").pop() === key);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`有多个分组叫「${key}」，请传 id（相对路径）`);
  throw new Error(`找不到分组「${key}」`);
}

async function agentSpaceTree() {
  await loadList();
  return { current: current?.meta.id || null, tree: treeData };
}

async function agentGroupCreate(parent, name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("分组名不能为空");
  const parentId = parent && String(parent).trim() ? (await agentFindGroup(parent)).id : "";
  const id = await store.createGroup(parentId, clean);
  treeCollapsed.delete(id);
  await loadList();
  return { id };
}

async function agentGroupRename(ref, name) {
  const target = await agentFindGroup(ref);
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("新名字不能为空");
  const id = await renameTreeGroup(target.id, clean);
  return { id };
}

async function agentGroupDelete(ref) {
  const target = await agentFindGroup(ref);
  await store.deleteGroup(target.id);
  treeCollapsed.delete(target.id);
  await loadList();
  return { deleted: { id: target.id } };
}

async function agentSpaceCopy(ref, parent) {
  const target = await agentFindSpace(ref);
  const parentId = parent && String(parent).trim() ? (await agentFindGroup(parent)).id : "";
  if (current?.meta.id === target.id) {
    if (editingId || edgeLabelEditor) commitEditing();
    await flushBlockContents();
    await flushItems();
    await flushCamera();
  }
  const meta = await store.copyCanvas(target.id, parentId);
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
    /* 改名没成：把刚才放下的画布重新打开，别让界面停在无画布的样子 */
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

/* 产品卡字段的统一下发口：建块和改块共用同一套取值规矩 */
function applyProductFields(item, spec = {}) {
  if (spec.name !== undefined) {
    const name = String(spec.name || "").trim();
    if (name) item.name = name;
  }
  if (spec.brand !== undefined) item.brand = String(spec.brand || "").trim();
  if (spec.sku !== undefined) item.sku = String(spec.sku || "").trim();
  if (spec.spec !== undefined) item.spec = String(spec.spec || "").trim();
  if (spec.price !== undefined) item.price = Math.max(0, numOr(spec.price, item.price));
  if (spec.qty !== undefined) item.qty = Math.max(1, Math.trunc(numOr(spec.qty, item.qty)));
  if (spec.source !== undefined) item.source = String(spec.source || "").trim();
  if (spec.note !== undefined) item.note = String(spec.note || "").trim();
  if (spec.model !== undefined) item.model = String(spec.model || "").trim();
  if (spec.internal !== undefined) item.internal = spec.internal === true;
  if (spec.dims !== undefined) {
    const dims = spec.dims && typeof spec.dims === "object" ? spec.dims : {};
    item.dims = {
      w: Math.max(0, numOr(dims.w, item.dims.w)),
      d: Math.max(0, numOr(dims.d, item.dims.d)),
      h: Math.max(0, numOr(dims.h, item.dims.h)),
    };
  }
}

/* ---------- 3D 房间壳 / 灯光 / 机位 ---------- */

function sceneSurfacesOf(value) {
  if (!Array.isArray(value)) throw new Error("附着面必须是数组");
  const result = normalizeSceneSurfaces(value);
  if (result.dropped.length) throw new Error(result.dropped[0].why);
  return result.surfaces;
}

function editableScene(id) {
  const item = agentRequireItem(id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  if (item.locked) throw new Error("场景已锁定，请先解锁");
  return item;
}

function sceneView(item) {
  return itemEls.get(item.id)?.querySelector(".canvas-scene-view");
}

function saveSceneFurniture(item, indices, delta) {
  const view = sceneView(item);
  item.camera = normalizeSceneCamera(sceneCameraState(item, view));
  moveSceneFurnitureParts(item, indices.map((index) => ({ index, ...item.parts[index] })), delta);
  persistScene(item);
  scheduleItemsSave();
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  if (scenePlacementActive(item)) setSceneFurnitureSelection(view, indices);
  return { id: item.id, clamped: delta.clamped,
    parts: indices.map((index) => ({ index, x: item.parts[index].x, y: item.parts[index].y, z: item.parts[index].z })) };
}

function agentSceneGet({ id }) {
  const item = agentRequireItem(id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  return { ...agentSummary(item), parts: item.parts.map((part, index) => ({ ...part, index })),
    rendering: sceneFurnitureInspect(sceneView(item)) };
}

function agentSceneSurfaceSet({ id, surface }) {
  const item = editableScene(id);
  const [next] = sceneSurfacesOf([surface]);
  const old = item.surfaces.find((one) => one.id === next.id);
  if (old && item.parts.some((part) => part.surface === old.id) &&
      ["kind", "x", "y", "z", "w", "h", "rotate"].some((key) => old[key] !== next[key])) {
    throw new Error("这个面已有家具，请先解除绑定再修改附着面");
  }
  item.surfaces = [...item.surfaces.filter((one) => one.id !== next.id), next];
  scheduleItemsSave();
  return { id, surface: next };
}

function agentSceneFurnitureBind(spec) {
  const item = editableScene(spec.id);
  if (!Array.isArray(spec.parts) || !spec.parts.length || spec.parts.some((index) =>
      !Number.isInteger(index) || index < 0 || index >= item.parts.length)) throw new Error("parts 要传有效的零件序号数组");
  const indices = [...new Set(spec.parts)];
  const surfaceId = String(spec.surface || "").trim();
  if (!surfaceId) {
    for (const index of indices) { item.parts[index].group = ""; item.parts[index].surface = ""; }
    setSceneFurnitureSelection(sceneView(item), []);
    persistScene(item);
    return { id: item.id, parts: indices, unbound: true };
  }
  const surface = item.surfaces.find((one) => one.id === surfaceId);
  if (!surface) throw new Error(`找不到附着面 ${surfaceId}`);
  const group = String(spec.group || newId()).trim().slice(0, 128);
  if (!group || item.parts.some((part, index) => part.group === group && !indices.includes(index))) {
    throw new Error("家具组名为空或已被其他零件占用，请把整件家具的零件一起绑定");
  }
  const delta = sceneFurnitureMoveDelta(sceneView(item), indices, surface, 0, 0);
  for (const index of indices) { item.parts[index].group = group; item.parts[index].surface = surfaceId; }
  return { ...saveSceneFurniture(item, indices, delta), group, surface: surfaceId };
}

function agentSceneFurnitureMove({ id, part, du = 0, dv = 0 }) {
  const item = editableScene(id);
  if (!Number.isFinite(du) || !Number.isFinite(dv)) throw new Error("du / dv 要传有限数值");
  const furniture = sceneFurnitureGroup(item, part);
  if (!furniture) throw new Error("这件物体还没绑定附着面，不能移动");
  const delta = sceneFurnitureMoveDelta(sceneView(item), furniture.indices, furniture.surface, du, dv);
  return saveSceneFurniture(item, furniture.indices, delta);
}

const SCENE_LIGHT_PRESETS = {
  /* 白天：太阳高、天光足，颜色尽量保持固有色 */
  day: { angle: 35, elev: 52, k: 0.55, lit: "#fff4e2", dark: "#dbe7f2" },
  /* 傍晚：低角度暖光，影子里带一点蓝 */
  warm: { angle: 210, elev: 22, k: 0.42, lit: "#ffc07a", dark: "#71809a" },
  /* 夜里开着暖灯：太阳从屋子前方打进来，天光留得多一点，别让一面墙黑成一块 */
  night: { angle: 150, elev: 48, k: 0.6, lit: "#ffd9b0", dark: "#5b6781" },
};

/* 房间壳的单位是厘米：客厅 6.2m × 5.2m、墙高 2.8m。
   墙只做背面和左侧，前面敞开给相机；窗是贴在墙上的一块亮面。 */
function roomShellParts(preset, options = {}) {
  const specs = {
    living: { w: 620, d: 520, rug: true, console: true },
    bedroom: { w: 500, d: 460, rug: true, console: false },
    dining: { w: 560, d: 470, rug: false, console: true },
  };
  const spec = specs[preset] || specs.living;
  const wall = options.wallColor || "#ece7de";
  const floor = options.floorColor || "#b98a5e";
  const { w, d } = spec;
  const wallH = 280;
  const t = 12;
  const winX = w * 0.22;
  const winY = d / 2 - t - 1;
  const winW = Math.min(240, w * 0.38);
  const winH = 140;
  const winZ = 90;
  const frame = "#d8d2c8";
  const parts = [
    { op: "box", x: 0, y: 0, z: 0, w, d, h: 2, color: floor, name: "地板" },
    { op: "box", x: 0, y: d / 2 - t / 2, z: 0, w, d: t, h: wallH, color: wall, name: "背景墙" },
    { op: "box", x: -w / 2 + t / 2, y: 0, z: 0, w: t, d, h: wallH, color: wall, name: "侧墙" },
    { op: "box", x: winX, y: winY, z: winZ, w: winW, d: 2, h: winH, color: "#cfe2ef", name: "窗" },
    { op: "box", x: winX, y: winY + 1, z: winZ - 8, w: winW + 12, d: 4, h: 8, color: frame, name: "窗框" },
    { op: "box", x: winX, y: winY + 1, z: winZ + winH, w: winW + 12, d: 4, h: 8, color: frame, name: "窗框" },
    { op: "box", x: winX - winW / 2 - 6, y: winY + 1, z: winZ, w: 12, d: 4, h: winH, color: frame, name: "窗框" },
    { op: "box", x: winX + winW / 2 + 6, y: winY + 1, z: winZ, w: 12, d: 4, h: winH, color: frame, name: "窗框" },
  ];
  if (spec.rug) {
    parts.push({ op: "box", x: 0, y: -d * 0.06, z: 2, w: w * 0.56, d: d * 0.48, h: 1.4, color: "#c9b9a6", name: "地毯", group: "rug", surface: "floor" });
  }
  if (spec.console) {
    parts.push({ op: "box", x: w * 0.22, y: d / 2 - t - 22, z: 2, w: 180, d: 38, h: 46, color: "#8a6f55", name: "边柜", group: "console", surface: "floor" });
  }
  return parts;
}

function roomShellSurfaces(parts) {
  const floor = parts[0];
  const wall = parts[1];
  return sceneSurfacesOf([
    { id: "floor", name: "房间地面", kind: "floor", x: 6, y: -6, z: floor.h, w: floor.w - 12, h: floor.d - 12 },
    { id: "back-wall", name: "背景墙", kind: "wall", x: 0, y: floor.d / 2 - 12, z: floor.h, w: floor.w - 24, h: wall.h - floor.h },
    { id: "left-wall", name: "侧墙", kind: "wall", x: -floor.w / 2 + 12, y: -6, z: floor.h, w: floor.d - 12, h: wall.h - floor.h, rotate: 90 },
  ]);
}

function sceneLightOf(preset) {
  const got = normalizeLight(SCENE_LIGHT_PRESETS[preset]);
  if (got.why) throw new Error(got.why);
  return got.light;
}

function agentSceneRoomShell(spec = {}) {
  agentRequireSpace();
  const item = agentRequireItem(spec.id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  const preset = ["living", "bedroom", "dining"].includes(spec.preset) ? spec.preset : "living";
  const got = normalizeSceneParts(roomShellParts(preset, { wallColor: spec.wallColor, floorColor: spec.floorColor }));
  if (got.dropped.length) throw new Error(got.dropped[0].why);
  item.parts = got.parts;
  item.surfaces = roomShellSurfaces(got.parts);
  setSceneFurnitureSelection(sceneView(item), []);
  item.light = sceneLightOf("day");
  item.camera = null;
  persistScene(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return { ...agentSummary(item), preset };
}

function agentSceneLightPreset(spec = {}) {
  const item = agentRequireItem(spec.id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  const preset = String(spec.preset || "");
  if (preset === "off") item.light = null;
  else if (SCENE_LIGHT_PRESETS[preset]) item.light = sceneLightOf(preset);
  else throw new Error("灯光预设只有 day / warm / night / off");
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return agentSummary(item);
}

function setSceneCameraPreset(item, preset) {
  if (item.type !== "scene") throw new Error("id 要传场景块");
  if (preset === "auto") {
    item.camera = null;
  } else {
    const box = contentBox(item.parts, item.light);
    const span = Math.max(box.dx, box.dy, 1);
    const angles = { front: [180, 16, 1.02], left: [212, 24, 0.95], right: [148, 24, 0.95], top: [180, 66, 1] };
    const p = angles[preset];
    if (!p) throw new Error("机位预设只有 auto / front / left / right / top");
    item.camera = normalizeSceneCamera({
      azim: p[0],
      elev: p[1],
      dist: Math.max(280, span * p[2]),
      tx: box.cx,
      ty: box.cy,
      tz: Math.max(60, box.dz * 0.35),
      fov: 45,
    });
  }
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return agentSummary(item);
}

function agentSceneCameraPreset(spec = {}) {
  const item = agentRequireItem(spec.id);
  return setSceneCameraPreset(item, String(spec.preset || ""));
}

/* 一张产品卡落进场景：读卡上的 model 和真实尺寸，模型自带单位由渲染器按尺寸等比缩。
   卡片上没有模型就不放——空一块假家具比报错更难查。 */
async function placeProductInScene(product, scene, options = {}) {
  if (!product || product.type !== "product") throw new Error("要放进去的是一张产品卡");
  if (!scene || scene.type !== "scene") throw new Error("要放进的是场景块");
  if (!product.model) {
    throw new Error("这张产品卡还没设 3D 模型：右键「设置 3D 模型…」或 block_update 写 model");
  }
  const models = await invoke("model_library_list").catch(() => []);
  if (!models.some((one) => one.name === product.model)) {
    throw new Error(`模型库里没有 ${product.model}，去设置页「3D 模型库」导入`);
  }
  let floors = scene.surfaces.filter((one) => one.kind === "floor");
  if (!scene.parts.length && !floors.length && !options.surface) {
    const [floor] = sceneSurfacesOf([{ id: "ground", name: "地面", kind: "floor", w: 1000, h: 1000 }]);
    scene.surfaces.push(floor);
    floors = [floor];
  }
  const surface = options.surface
    ? floors.find((one) => one.id === options.surface)
    : floors.length === 1 ? floors[0] : null;
  if (!surface) throw new Error("请先配置地面附着面；多个地面时用 surface 指定放入哪个区域");
  const dims = product.dims || {};
  const part = {
    op: "model",
    group: newId(),
    surface: surface.id,
    src: product.model,
    x: Number.isFinite(Number(options.x)) ? Number(options.x) : surface.x,
    y: Number.isFinite(Number(options.y)) ? Number(options.y) : surface.y,
    z: surface.z,
    rotate: Number.isFinite(Number(options.rotate)) ? Number(options.rotate) : 0,
    w: dims.w > 0 ? dims.w / 10 : 0,
    d: dims.d > 0 ? dims.d / 10 : 0,
    h: dims.h > 0 ? dims.h / 10 : 0,
    name: product.name,
    color: "",
  };
  if (!part.h) part.h = 80;
  const got = normalizeSceneParts([part]);
  if (got.dropped.length) throw new Error(got.dropped[0].why);
  scene.parts = [...scene.parts, got.parts[0]];
  persistScene(scene);
  const el = itemEls.get(scene.id);
  if (el) syncItemElement(el, scene);
  scheduleItemsSave();
  return { ...agentSummary(scene), placed: product.model, partIndex: scene.parts.length - 1 };
}

async function agentScenePlaceProduct(spec = {}) {
  agentRequireSpace();
  const scene = agentRequireItem(spec.scene);
  const product = agentRequireItem(spec.product);
  return placeProductInScene(product, scene, spec);
}

/* 把产品卡的图当材质贴到场景的某个实体面上：地板、墙、柜子都行，模型件不接 */
function agentSceneApplyMaterial(spec = {}) {
  const item = agentRequireItem(spec.scene);
  if (item.type !== "scene") throw new Error("scene 要传场景块");
  const target = spec.target;
  let part = null;
  if (target !== undefined && target !== "" && /^\d+$/.test(String(target))) {
    part = item.parts[Number(target)] || null;
  } else {
    const needle = String(target || "").trim();
    if (needle) part = item.parts.find((one) => (one.name || "").includes(needle)) || null;
  }
  if (!part) {
    throw new Error("找不到要贴的面：target 给 parts 序号或件名（地板 / 背景墙 / 侧墙 / 边柜 / 地毯）");
  }
  if (part.op === "model") throw new Error("模型件不能贴材质图；要换材质请直接改模型");
  if (spec.clear === true) {
    delete part.tex;
    delete part.texRepeat;
  } else {
    const product = agentRequireItem(spec.product);
    if (product.type !== "product") throw new Error("product 要传产品卡");
    if (!product.src) throw new Error("这张产品卡还没有图：先给它换一张材质图");
    part.tex = product.src;
    const repeat = Number(spec.repeat);
    part.texRepeat = Number.isFinite(repeat) && repeat >= 10 ? repeat : 100;
  }
  persistScene(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return { ...agentSummary(item), target: part.name || String(target), tex: part.tex || "" };
}

async function placeProductInSceneFlow(product, scene) {
  try {
    await placeProductInScene(product, scene);
    showToast("已放进场景");
  } catch (error) {
    showError(error);
  }
}

function newSceneForProduct(product) {
  const scene = makeScene(product.x + product.w + 40, product.y, 720, 480);
  placeBlock(scene);
  persistScene(scene);
  void placeProductInSceneFlow(product, scene);
}

/* 产品卡选模型：菜单里列模型库里的 .glb，选完只改卡上的 model 字段 */
async function pickProductModel(item) {
  const models = await invoke("model_library_list").catch(() => []);
  const el = itemEls.get(item.id);
  const r = el ? el.getBoundingClientRect() : { left: 200, top: 200 };
  const entries = models.length
    ? models.map((model) => ({
        label: `${model.name}${model.name === item.model ? " ✓" : ""}`,
        onClick: () => {
          item.model = model.name;
          scheduleItemsSave();
          showToast(`模型：${model.name}`);
        },
      }))
    : [{ label: "模型库还没有 .glb（去设置页导入）", disabled: true }];
  openMenu(r.left + 24, r.top + 24, entries, { label: "3D 模型" });
}

/* ---------- 户型块 ---------- */

let planCalibration = null; // { itemId, points: [{ fx, fy }] }

function planCardOf(itemId) {
  return itemEls.get(itemId)?.querySelector(".canvas-plan-card") || null;
}

function startPlanCalibration(item) {
  const card = planCardOf(item.id);
  if (!card) return;
  planCalibration = { itemId: item.id, points: [] };
  card.classList.add("is-calibrating");
  showToast("在户型图上点这条已知长度的两个端点");
}

function cancelPlanCalibration() {
  if (!planCalibration) return;
  const { itemId } = planCalibration;
  planCalibration = null;
  planCardOf(itemId)?.classList.remove("is-calibrating");
  const el = itemEls.get(itemId);
  const item = findItem(itemId);
  if (el && item) syncItemElement(el, item);
}

async function finishPlanCalibration(item, a, b) {
  const canvasId = current?.meta.id;
  planCardOf(item.id)?.classList.remove("is-calibrating");
  const pixelDist = Math.hypot((b.fx - a.fx) * item.imageW, (b.fy - a.fy) * item.imageH);
  if (!(pixelDist > 0)) {
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    showToast("两个点重合了，再来一次");
    return;
  }
  const answer = await promptDialog({
    title: "标定比例",
    label: "这两点实际多少毫米？（例如 4200）",
    value: "",
    okText: "定标",
  });
  if (!current || current.meta.id !== canvasId) return;
  const mm = Number(String(answer || "").replace(/[,\s]/g, ""));
  if (!(mm > 0)) {
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    return;
  }
  item.calibration = { x1: a.fx, y1: a.fy, x2: b.fx, y2: b.fy, mm };
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  showToast("已定标，现在可以放家具和机位了");
}

function attachPlanBlock(el, item) {
  const card = el.querySelector(".canvas-plan-card");
  if (!card) return;

  /* 定标模式：按下两下各取一个点，再问这条线的实际长度 */
  card.addEventListener(
    "pointerdown",
    (event) => {
      if (planCalibration?.itemId !== item.id) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      planCalibration.points.push({ fx, fy });
      const svg = card.querySelector(".canvas-plan-svg");
      if (svg && item.imageW > 0 && item.imageH > 0) {
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("class", "canvas-plan-cal-dot");
        dot.setAttribute("cx", String(fx * item.imageW));
        dot.setAttribute("cy", String(fy * item.imageH));
        dot.setAttribute("r", String(Math.max(12, Math.min(item.imageW, item.imageH) / 45)));
        svg.append(dot);
      }
      if (planCalibration.points.length === 1) {
        showToast("再点另一头");
        return;
      }
      const [a, b] = planCalibration.points;
      planCalibration = null;
      void finishPlanCalibration(item, a, b);
    },
    true,
  );

  /* 脚印：按住拖动位置；松手没怎么动就选中对应产品卡 */
  card.addEventListener(
    "pointerdown",
    (event) => {
      if (planCalibration) return;
      const footprint = event.target.closest?.(".canvas-plan-footprint");
      if (!footprint) {
        if (event.target.closest?.(".canvas-plan-camera")) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (item.locked) return;
      const scale = planPixelsPerMm(item);
      if (!(scale > 0)) return;
      const fp = item.footprints.find((one) => one.id === footprint.getAttribute("data-footprint"));
      if (!fp) return;
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { x: fp.x, y: fp.y };
      let moved = false;
      const move = (e) => {
        const dxPx = (e.clientX - startX) * (item.imageW / rect.width);
        const dyPx = (e.clientY - startY) * (item.imageH / rect.height);
        fp.x = origin.x + dxPx / scale;
        fp.y = origin.y + dyPx / scale;
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 2) moved = true;
        footprint.setAttribute(
          "transform",
          `translate(${(fp.x * scale).toFixed(1)} ${(fp.y * scale).toFixed(1)}) rotate(${fp.rotate.toFixed(1)})`,
        );
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (moved) {
          const target = itemEls.get(item.id);
          if (target) syncItemElement(target, item);
          scheduleItemsSave();
        } else {
          select(fp.product);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    true,
  );

  /* 点机位：把链接的场景切到对应机位并跟过去 */
  card.addEventListener("click", (event) => {
    if (planCalibration) return;
    const camera = event.target.closest?.(".canvas-plan-camera");
    if (!camera) return;
    event.preventDefault();
    event.stopPropagation();
    const marker = item.cameras.find((one) => one.id === camera.getAttribute("data-camera"));
    if (!marker) return;
    const scene = findItem(marker.scene);
    if (!scene || scene.type !== "scene") {
      showError("这个机位链接的场景块不在了");
      return;
    }
    setSceneCameraPreset(scene, marker.preset);
    select(scene.id);
    revealItem(scene);
  });
}

function planDefaultPoint(plan) {
  const scale = planPixelsPerMm(plan);
  if (!(scale > 0)) return { x: 0, y: 0 };
  return { x: plan.imageW / scale / 2, y: plan.imageH / scale / 2 };
}

function planAreaOf(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2 / 1_000_000;
}

function planPlaceProduct(product, plan, options = {}) {
  if (!plan || plan.type !== "plan") throw new Error("要放进的是一块户型图");
  if (!plan.calibration) {
    throw new Error("这张户型图还没定标：右键「标定比例…」，或先 plan_calibrate");
  }
  const dims = product.dims || {};
  const w = dims.w > 0 ? dims.w : 600;
  const d = dims.d > 0 ? dims.d : 600;
  const center = planDefaultPoint(plan);
  const footprint = {
    id: newId(),
    product: product.id,
    name: product.name || "产品",
    x: Number.isFinite(Number(options.x)) ? Number(options.x) : center.x,
    y: Number.isFinite(Number(options.y)) ? Number(options.y) : center.y,
    w,
    d,
    rotate: Number.isFinite(Number(options.rotate)) ? ((Number(options.rotate) % 360) + 360) % 360 : 0,
  };
  plan.footprints.push(footprint);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), footprint };
}

function planPlaceCamera(plan, scene, options = {}) {
  if (!plan || plan.type !== "plan") throw new Error("要放机位的是一块户型图");
  if (!plan.calibration) throw new Error("这张户型图还没定标，放不了机位");
  const center = planDefaultPoint(plan);
  const marker = {
    id: newId(),
    scene: scene.id,
    x: Number.isFinite(Number(options.x)) ? Number(options.x) : center.x,
    y: Number.isFinite(Number(options.y)) ? Number(options.y) : center.y,
    rotate: Number.isFinite(Number(options.rotate)) ? ((Number(options.rotate) % 360) + 360) % 360 : 0,
    preset: ["front", "left", "right", "top", "auto"].includes(options.preset) ? options.preset : "front",
  };
  plan.cameras.push(marker);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), camera: marker };
}

function planAddArea(plan, points) {
  if (!plan || plan.type !== "plan") throw new Error("要量面积的是一块户型图");
  if (!plan.calibration) throw new Error("这张户型图还没定标，量不了面积");
  const pts = [];
  for (const one of Array.isArray(points) ? points : []) {
    const x = Number(one?.x);
    const y = Number(one?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
  }
  if (pts.length < 3) throw new Error("面积至少给 3 个点（毫米坐标）");
  const area = { id: newId(), points: pts };
  plan.areas.push(area);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), area, squareMeters: planAreaOf(pts) };
}

function planRemove(plan, kind, itemId) {
  const list = kind === "footprint" ? plan.footprints : kind === "camera" ? plan.cameras : kind === "area" ? plan.areas : null;
  if (!list) throw new Error("kind 只有 footprint / camera / area");
  const index = list.findIndex((one) => one.id === itemId);
  if (index < 0) throw new Error("没找到这一项");
  const [removed] = list.splice(index, 1);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), removed };
}

async function placeProductOnPlanFlow(product, plan) {
  try {
    if (!active || !current) return;
    planPlaceProduct(product, plan);
    showToast("已放到户型图中央，拖动脚印调整位置");
  } catch (error) {
    showError(error);
  }
}

function agentPlanCalibrate(spec = {}) {
  const item = agentRequireItem(spec.id);
  if (item.type !== "plan") throw new Error("id 要传户型块");
  const nums = ["x1", "y1", "x2", "y2", "mm"].map((key) => Number(spec[key]));
  if (!nums.every(Number.isFinite) || !(nums[4] > 0)) {
    throw new Error("要给 x1 / y1 / x2 / y2（0~1 的图片比例）和 mm（这段实际毫米数）");
  }
  const [x1, y1, x2, y2, mm] = nums;
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-4) throw new Error("两个点重合了");
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  item.calibration = { x1: clamp01(x1), y1: clamp01(y1), x2: clamp01(x2), y2: clamp01(y2), mm };
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return agentSummary(item);
}

function agentPlanPlaceProduct(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  const product = agentRequireItem(spec.product);
  if (product.type !== "product") throw new Error("product 要传产品卡");
  return planPlaceProduct(product, plan, { x: spec.x, y: spec.y, rotate: spec.rotate });
}

function agentPlanPlaceCamera(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  const scene = agentRequireItem(spec.scene);
  if (scene.type !== "scene") throw new Error("scene 要传场景块");
  return planPlaceCamera(plan, scene, { x: spec.x, y: spec.y, rotate: spec.rotate, preset: spec.preset });
}

function agentPlanArea(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  return planAddArea(plan, spec.points);
}

function agentPlanRemove(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  return planRemove(plan, String(spec.kind || ""), String(spec.item || ""));
}

/* ---------- 提案页与客户版交付 ---------- */

function pageItems() {
  if (!current) return [];
  return current.items
    .filter((item) => item.type === "page")
    .sort((a, b) => (a.order || a.seq) - (b.order || b.seq) || a.y - b.y || a.x - b.x);
}

function renamePageFlow(item) {
  void (async () => {
    const name = await promptDialog({ title: "重命名页", label: "页名", value: item.title, okText: "重命名" });
    if (!name || name === item.title) return;
    item.title = name;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    scheduleItemsSave();
  })();
}

function setPageRatio(item, ratio) {
  if (!PAGE_RATIOS[ratio] || item.ratio === ratio) return;
  item.ratio = ratio;
  item.w = PAGE_RATIOS[ratio].w;
  item.h = PAGE_RATIOS[ratio].h;
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  updateSelection();
  scheduleItemsSave();
}

function setPageOrderFlow(item) {
  void (async () => {
    const answer = await promptDialog({
      title: "页序",
      label: "这是第几页？",
      value: String(item.order || 1),
      okText: "好",
    });
    const order = Math.trunc(Number(String(answer || "").replace(/[^\d]/g, "")));
    if (!(order >= 1) || order === item.order) return;
    item.order = order;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    scheduleItemsSave();
  })();
}

/* 客户版要藏的东西：内部块，以及挂在内部块上的连线 */
function clientHiddenIds() {
  if (!current) return { ids: [], connectors: [] };
  const ids = current.items
    .filter((item) => item.internal && item.type !== "connector" && item.type !== "page")
    .map((item) => item.id);
  const set = new Set(ids);
  const connectors = current.items
    .filter((item) => item.type === "connector")
    .filter((item) => set.has(item.from?.item) || set.has(item.to?.item))
    .map((item) => item.id);
  return { ids, connectors };
}

function hideConnectorsTemporarily(ids) {
  const touched = ids.map((id) => itemEls.get(id)).filter(Boolean);
  const previous = touched.map((el) => el.style.display);
  for (const el of touched) el.style.display = "none";
  return () => {
    touched.forEach((el, index) => {
      el.style.display = previous[index];
    });
  };
}

async function fetchTextAsset(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读不到 ${url}（${res.status}）`);
  return res.text();
}

async function fetchDataUrl(url, mime = "") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读不到素材（${res.status}）`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      if (!mime) {
        resolve(text);
        return;
      }
      const comma = text.indexOf(",");
      resolve(`data:${mime};base64,${comma >= 0 ? text.slice(comma + 1) : ""}`);
    };
    reader.onerror = () => reject(reader.error || new Error("素材读取失败"));
    reader.readAsDataURL(blob);
  });
}

function exportHtmlEscape(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

function exportJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function exportRootName(name) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const safe = String(name || "提案").replace(/[\\/:*?"<>|]/g, " ").trim() || "提案";
  return `${safe} 客户版 ${stamp}`;
}

function imageMimeOf(src) {
  const ext = String(src).split(".").pop().toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
    }[ext] || "image/png"
  );
}

/* 页面上的场景块：位置换算成页内百分比，模型和材质图都塞成 data URL，
   客户拿到的文件夹不依赖模型库、不依赖网络 */
async function buildClientScenes(pages, canvasId) {
  const scenes = [];
  const modelCache = new Map();
  const texCache = new Map();
  for (const [pageIndex, page] of pages.entries()) {
    for (const item of current.items) {
      if (item.type !== "scene" || item.internal) continue;
      const bounds = boundsOfItem(item.id) || itemBounds(item, null);
      if (!bounds) continue;
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      if (cx < page.x || cx > page.x + page.w || cy < page.y || cy > page.y + page.h) continue;
      const models = {};
      for (const part of item.parts || []) {
        if (part.op !== "model" || !part.src || models[part.src] !== undefined) continue;
        try {
          if (!modelCache.has(part.src)) {
            modelCache.set(part.src, await fetchDataUrl(await store.modelLibraryUrl(part.src), "model/gltf-binary"));
          }
          models[part.src] = await modelCache.get(part.src);
        } catch {
          models[part.src] = "";
        }
      }
      const textures = {};
      for (const part of item.parts || []) {
        if (!part.tex || textures[part.tex] !== undefined) continue;
        try {
          if (!texCache.has(part.tex)) {
            texCache.set(
              part.tex,
              await fetchDataUrl(await store.imageUrl(canvasId, part.tex, false), imageMimeOf(part.tex)),
            );
          }
          textures[part.tex] = await texCache.get(part.tex);
        } catch {
          textures[part.tex] = "";
        }
      }
      scenes.push({
        page: pageIndex,
        rect: {
          x: (item.x - page.x) / page.w,
          y: (item.y - page.y) / page.h,
          w: item.w / page.w,
          h: item.h / page.h,
        },
        w: item.w,
        h: item.h,
        parts: (item.parts || []).map((part) => ({ ...part })),
        camera: item.camera || null,
        light: item.light || null,
        groundColor: item.groundColor || "",
        models,
        textures,
      });
    }
  }
  return scenes;
}

function clientPageHtml(title, pages, scenes, pageImages) {
  const figures = pages
    .map(
      (page, index) => `  <section class="page" aria-label="${exportHtmlEscape(page.title)}">
    <span class="page-title">P${page.order || index + 1} · ${exportHtmlEscape(page.title)}</span>
    <img src="${pageImages[index]}" alt="${exportHtmlEscape(page.title)}">
    <div class="hotspots"></div>
  </section>`,
    )
    .join("\n");
  const css = `:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f2efe9; color: #23262b; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
header { max-width: 1000px; margin: 56px auto 26px; padding: 0 24px; }
h1 { margin: 0 0 8px; font-size: 30px; font-weight: 650; letter-spacing: 0.02em; }
.meta { margin: 0; color: #837b6f; font-size: 13px; }
.pages { max-width: 1000px; margin: 0 auto 72px; padding: 0 24px; display: flex; flex-direction: column; gap: 40px; }
.page { position: relative; background: #fff; box-shadow: 0 20px 56px rgba(30, 26, 20, 0.14); }
.page img { display: block; width: 100%; height: auto; }
.page-title { position: absolute; left: 0; bottom: 100%; margin-bottom: 9px; color: #8a8378; font-size: 12px; letter-spacing: 0.03em; }
.hotspots { position: absolute; inset: 0; }
.scene-hotspot { position: absolute; padding: 0; border: 1.5px dashed rgba(66, 108, 178, 0.6); border-radius: 8px; background: transparent; cursor: pointer; }
.scene-hotspot:hover { border-color: rgba(48, 92, 168, 0.95); background: rgba(66, 108, 178, 0.06); }
.scene-hotspot-label { position: absolute; right: 8px; bottom: 8px; padding: 4px 11px; border-radius: 999px; background: rgba(38, 57, 86, 0.88); color: #fff; font-size: 12px; letter-spacing: 0.04em; }
body.viewer-open { overflow: hidden; }
.viewer-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(12, 16, 22, 0.74); }
.viewer-stage { position: relative; width: min(1240px, 92vw); height: min(780px, 84vh); overflow: hidden; border-radius: 12px; background: #111; box-shadow: 0 32px 90px rgba(0, 0, 0, 0.55); }
.viewer-stage canvas { display: block; width: 100%; height: 100%; cursor: grab; }
.viewer-close { position: fixed; top: 22px; right: 26px; width: 40px; height: 40px; border: none; border-radius: 50%; background: rgba(255, 255, 255, 0.16); color: #fff; font-size: 22px; line-height: 1; cursor: pointer; }
.viewer-close:hover { background: rgba(255, 255, 255, 0.28); }
.viewer-hint { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); margin: 0; color: rgba(255, 255, 255, 0.72); font-size: 12px; letter-spacing: 0.04em; }
@media print {
  body { background: #fff; }
  header, .hotspots { display: none !important; }
  .pages { max-width: none; margin: 0; padding: 0; gap: 0; }
  .page { box-shadow: none; break-after: page; }
  .page-title { display: none; }
}`;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${exportHtmlEscape(title)}</title>
<style>
${css}
</style>
</head>
<body>
<header>
  <h1>${exportHtmlEscape(title)}</h1>
  <p class="meta">共 ${pages.length} 页 · 虚线框住的场景可以点开，用鼠标拖着看 3D</p>
</header>
<main class="pages">
${figures}
</main>
<script type="application/json" id="scene-data">${exportJsonForHtml({ scenes })}</script>
<script src="./scene-viewer.js" defer></script>
</body>
</html>
`;
}

/* 客户版网页：一个文件夹，双击 index.html 就能看；3D 场景是真能转的，
   模型和材质图都内嵌成 data URL，不依赖模型库和网络。 */
/* 把客户版网页写进指定文件夹（不弹选择框，agent 也走这条路） */
async function exportClientWebTo(dir, root) {
  if (!current) throw new Error("先打开一个画布");
  const allPages = pageItems();
  const pages = allPages.filter((page) => !page.internal);
  if (!pages.length) throw new Error("没有客户版可见的提案页，请先将要导出的页面设为 internal:false");
  const canvasId = current.meta.id;
  const hidden = clientHiddenIds();
  const pageIds = allPages.map((page) => page.id);
  const writeText = (rel, text) =>
    store.exportWritePath(dir, `${root}/${rel}`, bytesToBase64(new TextEncoder().encode(text)));
  const writeBase64 = (rel, data) => store.exportWritePath(dir, `${root}/${rel}`, data);

  const restore = hideConnectorsTemporarily(hidden.connectors);
  const pageImages = [];
  let scenes = [];
  try {
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const shot = await exporter.exportPage({
        box: { x: page.x, y: page.y, w: page.w, h: page.h },
        pageId: page.id,
        hideIds: [...hidden.ids, ...pageIds.filter((id) => id !== page.id)],
        quality: "high",
        format: "png",
      });
      const rel = `pages/page-${String(index + 1).padStart(2, "0")}.png`;
      await writeBase64(rel, shot.data);
      pageImages.push(rel);
    }
    if (!current || current.meta.id !== canvasId) throw new Error("导出时画布被切走了");
    scenes = await buildClientScenes(pages, canvasId);
  } finally {
    restore();
  }
  if (!current || current.meta.id !== canvasId) throw new Error("导出时画布被切走了");

  const viewer = await fetchTextAsset("/vendor/web-viewer/scene-viewer.bundle.js");
  const html = clientPageHtml(current.meta.name, pages, scenes, pageImages);
  await writeText("scene-viewer.js", viewer);
  await writeText("index.html", html);
  return { root, pages: pages.length, scenes: scenes.length };
}

/* 按页 PDF 写进指定文件夹（agent 用） */
async function exportClientPdfTo(dir, fileName) {
  if (!current) throw new Error("先打开一个画布");
  const allPages = pageItems();
  const pages = allPages.filter((page) => !page.internal);
  if (!pages.length) throw new Error("没有客户版可见的提案页，请先将要导出的页面设为 internal:false");
  const hidden = clientHiddenIds();
  const pageIds = allPages.map((page) => page.id);
  const payload = pages.map((page) => ({
    box: { x: page.x, y: page.y, w: page.w, h: page.h },
    pageId: page.id,
    hideIds: [...hidden.ids, ...pageIds.filter((id) => id !== page.id)],
  }));
  const restore = hideConnectorsTemporarily(hidden.connectors);
  let result;
  try {
    result = await exporter.exportPagesPdf(payload, { quality: "high" });
  } finally {
    restore();
  }
  const safe = String(fileName || "客户版").replace(/[\\/:*?"<>|]/g, " ").trim() || "客户版";
  const path = await store.exportWritePath(dir, `${safe}.pdf`, result.data);
  return { path, pages: result.pages };
}

/* 给 agent 看这一页真正导出的样子（含页框底色、去掉客户版隐藏的块） */
async function agentPageSnapshot({ id, maxSide = 1400 } = {}) {
  const page = agentRequireItem(id);
  if (page.type !== "page") throw new Error("这不是提案页");
  const hidden = clientHiddenIds();
  const pageIds = pageItems().map((one) => one.id);
  const quality = Number(maxSide) > 2400 ? "ultra" : Number(maxSide) > 1800 ? "high" : "normal";
  const restore = hideConnectorsTemporarily(hidden.connectors);
  try {
    const shot = await exporter.exportPage({
      box: { x: page.x, y: page.y, w: page.w, h: page.h },
      pageId: page.id,
      hideIds: [...hidden.ids, ...pageIds.filter((pageId) => pageId !== page.id)],
      quality,
      format: "png",
    });
    return {
      data: shot.data,
      width: shot.width,
      height: shot.height,
      region: { x: page.x, y: page.y, w: page.w, h: page.h },
    };
  } finally {
    restore();
  }
}

function blockCenterInsidePage(item, page) {
  if (item.type === "page" || item.type === "connector") return false;
  const bounds = boundsOfItem(item.id) || itemBounds(item, null);
  if (!bounds) return false;
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return cx >= page.x && cx <= page.x + page.w && cy >= page.y && cy <= page.y + page.h;
}

function addTemplateText(page, x, y, w, text, { size = 14, color = "" } = {}) {
  const item = makeText(page.x + x, page.y + y, w, 0);
  item.text = text;
  item.fontSize = size;
  item.bordered = false;
  item.borderColor = "";
  item.fillColor = "";
  item.color = color;
  return placeBlock(item);
}

/* 一键搭软装提案的骨架：7 页，空间页里已经铺好房间壳，最后页带清单 */
function agentProposalTemplate(spec = {}) {
  agentRequireSpace();
  const title = String(spec.title || "软装提案");
  const pageW = PAGE_RATIOS.a4.w;
  const pageH = PAGE_RATIOS.a4.h;
  const gap = 160;
  const topics = [
    { key: "cover", title: "封面" },
    { key: "brief", title: "客户需求" },
    { key: "style", title: "风格板" },
    { key: "living", title: "客厅方案", scene: "living" },
    { key: "bedroom", title: "主卧方案", scene: "bedroom" },
    { key: "dining", title: "餐厅方案", scene: "dining" },
    { key: "quote", title: "材料与报价" },
  ];
  const totalW = topics.length * pageW + (topics.length - 1) * gap;
  const center = stageCenterWorld();
  const startX = Number.isFinite(Number(spec.x)) ? Number(spec.x) : center.x - totalW / 2;
  const startY = Number.isFinite(Number(spec.y)) ? Number(spec.y) : center.y - pageH / 2;
  const created = { pages: [], scenes: [], quote: null };
  topics.forEach((topic, index) => {
    const page = makePage(startX + index * (pageW + gap), startY, "a4", topic.title, index + 1);
    placeBlock(page);
    created.pages.push({ id: page.id, title: topic.title, order: index + 1 });
    const left = 80;
    const contentW = pageW - left * 2;
    if (topic.key === "cover") {
      addTemplateText(page, left, 140, contentW, `${title}\n客户提案`, { size: 34 });
      addTemplateText(page, left, 270, contentW, "客户名称 / 日期 / 设计师", { size: 14, color: "#8a8378" });
    } else if (topic.key === "brief") {
      addTemplateText(page, left, 90, contentW, "客户需求", { size: 26 });
      addTemplateText(page, left, 170, contentW, "• 风格偏好：…\n• 预算：…\n• 常住人口：…\n• 重点空间：…\n• 喜欢与不喜欢的参考：…", { size: 15 });
    } else if (topic.key === "style") {
      addTemplateText(page, left, 90, contentW, "风格板", { size: 26 });
      addTemplateText(page, left, 170, contentW, "把参考图、配色和材质拖到这里；也可以让 agent 按 brief 先出 2–3 套方向。", { size: 15, color: "#8a8378" });
    } else if (topic.scene) {
      addTemplateText(page, left, 90, contentW, topic.title, { size: 26 });
      const scene = makeScene(page.x + left, page.y + 170, contentW, 470);
      const got = normalizeSceneParts(roomShellParts(topic.scene));
      if (got.dropped.length) throw new Error(got.dropped[0].why);
      scene.parts = got.parts;
      scene.surfaces = roomShellSurfaces(got.parts);
      scene.light = sceneLightOf("day");
      placeBlock(scene);
      persistScene(scene);
      created.scenes.push({ id: scene.id, page: page.id, preset: topic.scene });
      addTemplateText(page, left, 680, contentW, "把产品卡放进场景：右键产品卡 →「放进 3D 场景」；也可以右键产品卡 →「放到户型图」。", { size: 13, color: "#8a8378" });
    } else if (topic.key === "quote") {
      addTemplateText(page, left, 90, contentW, "材料与报价", { size: 26 });
      const quote = makeQuote(page.x + left, page.y + 170, "软装清单");
      quote.w = contentW;
      quote.h = 520;
      placeBlock(quote);
      created.quote = quote.id;
      addTemplateText(page, left, 730, contentW, "右键清单「从 CSV 导入产品…」；也可以把产品卡放到这一页，金额自动汇总。", { size: 13, color: "#8a8378" });
    }
  });
  scheduleItemsSave();
  return { title, pages: created.pages, scenes: created.scenes, quote: created.quote };
}

/* 复制整页做风格变体：新页在右边，页里的块各拷一份独立媒体 */
async function agentPageDuplicate(spec = {}) {
  if (!spec.id) throw new Error(`page_duplicate 没收到页 id（${JSON.stringify(spec)}）`);
  const page = agentRequireItem(spec.id);
  if (page.type !== "page") throw new Error("id 要传提案页");
  const pages = pageItems();
  const nextOrder = Math.max(0, pages.length, ...pages.map((one) => one.order || 0)) + 1;
  /* 副本排到整排页的最右边，别正好压在下一张页上 */
  const rightmost = Math.max(...pages.map((one) => one.x + one.w), page.x + page.w);
  const copyX = rightmost + 160;
  const dx = copyX - page.x;
  const copy = makePage(copyX, page.y, page.ratio, `${page.title} 副本`, nextOrder);
  copy.w = page.w;
  copy.h = page.h;
  copy.internal = page.internal;
  placeBlock(copy);
  const contained = current.items.filter((item) => blockCenterInsidePage(item, page));
  const created = [];
  const failed = [];
  for (const item of contained) {
    try {
      const placed = await agentDuplicateBlock(item.id, { dx, dy: 0 });
      created.push(placed.id);
    } catch (error) {
      /* 单块拷不动就跳过，别让整页复制失败 */
      failed.push({ id: item.id, type: item.type, why: String(error?.message || error) });
    }
  }
  scheduleItemsSave();
  return { page: copy.id, copies: created.length, skipped: contained.length - created.length, failed };
}

async function agentCreateBlock(spec = {}) {
  agentRequireSpace();
  if (editingId || edgeLabelEditor) commitEditing();
  const type = String(spec.type || "").trim();
  const canvasId = current.meta.id;
  const locked = spec.locked === true;
  const withLock = (item) => {
    if (locked) item.locked = true;
    if (spec.internal !== undefined) item.internal = spec.internal === true;
    return item;
  };

  if (type === "text") {
    const w = Math.max(40, numOr(spec.w, TEXT_DEFAULT_WIDTH));
    const minH = Math.max(0, numOr(spec.h, 0));
    const at = agentPlacePoint(w, 24, spec);
    const item = withLock(makeText(at.x, at.y, w, minH));
    item.text = String(spec.text ?? "");
    item.fontSize = clamp(Math.round(numOr(spec.fontSize, item.fontSize)), 8, 200);
    if (["left", "center", "right"].includes(spec.align)) item.align = spec.align;
    if (["top", "middle", "bottom"].includes(spec.vAlign)) item.vAlign = spec.vAlign;
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
    if (!placed) throw new Error("这块没落进画布");
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
    if (spec.surfaces !== undefined) item.surfaces = sceneSurfacesOf(spec.surfaces);
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
    const markdown = String(spec.markdown ?? "");
    const name = String(spec.name ?? "未命名笔记");
    const item = withLock(makeNote(at.x, at.y, "", name, markdown));
    item.w = w;
    item.h = h;
    if (!current || current.meta.id !== canvasId) throw new Error("插笔记块时画布被切走了");
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "page") {
    const ratio = PAGE_RATIOS[spec.ratio] ? spec.ratio : "a4";
    const preset = PAGE_RATIOS[ratio];
    const pages = pageItems();
    const order =
      Number.isFinite(Number(spec.order)) && Number(spec.order) >= 1
        ? Math.trunc(Number(spec.order))
        : pages.length + 1;
    const w = Math.max(200, numOr(spec.w, preset.w));
    const h = Math.max(200, numOr(spec.h, preset.h));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makePage(at.x, at.y, ratio, spec.title ? String(spec.title) : "未命名页", order));
    item.w = w;
    item.h = h;
    if (spec.internal !== undefined) item.internal = spec.internal === true;
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "plan") {
    if (!spec.path) throw new Error("plan 块需要户型图的本机路径 path");
    const rel = await store.importCanvasImage(canvasId, String(spec.path));
    if (!current || current.meta.id !== canvasId) throw new Error("导入户型图时画布被切走了");
    const url = await store.imageUrl(canvasId, rel, false).catch(() => "");
    imageCache.set(rel, url || null);
    const size = url ? await imageSize(url) : { width: 0, height: 0 };
    const sourceW = size.width || PLAN_DEFAULT_WIDTH;
    const sourceH = size.height || PLAN_DEFAULT_HEIGHT;
    const ratio = Math.min(1, 900 / Math.max(sourceW, sourceH, 1));
    const w = Math.max(PLAN_MIN_WIDTH, Math.round(numOr(spec.w, sourceW * ratio)));
    const h = Math.max(PLAN_MIN_HEIGHT, Math.round(numOr(spec.h, sourceH * ratio)));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makePlan(at.x, at.y, rel, size.width, size.height));
    item.w = w;
    item.h = h;
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    const placed = placeBlock(item);
    return agentSummary(placed);
  }

  if (type === "product") {
    const w = Math.max(PRODUCT_MIN_WIDTH, numOr(spec.w, PRODUCT_DEFAULT_WIDTH));
    const h = Math.max(PRODUCT_MIN_HEIGHT, numOr(spec.h, PRODUCT_DEFAULT_HEIGHT));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makeProduct(at.x, at.y));
    item.w = w;
    item.h = h;
    applyProductFields(item, spec);
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.fillColor !== undefined) item.fillColor = String(spec.fillColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    if (spec.path) {
      const rel = await store.importCanvasImage(canvasId, String(spec.path));
      if (!current || current.meta.id !== canvasId) throw new Error("导入产品图时画布被切走了");
      item.src = rel;
      try {
        imageCache.set(rel, await store.imageUrl(canvasId, rel, false));
      } catch {
        imageCache.set(rel, null);
      }
    }
    const placed = placeBlock(item);
    refreshQuotes();
    return agentSummary(placed);
  }

  if (type === "quote") {
    const w = Math.max(QUOTE_MIN_WIDTH, numOr(spec.w, QUOTE_DEFAULT_WIDTH));
    const h = Math.max(QUOTE_MIN_HEIGHT, numOr(spec.h, QUOTE_DEFAULT_HEIGHT));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makeQuote(at.x, at.y, spec.title ? String(spec.title) : "家具清单"));
    item.w = w;
    item.h = h;
    if (spec.internal !== undefined) item.internal = spec.internal === true;
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
    if (spec.internal !== undefined) extra.internal = spec.internal === true;
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
  /* 换画布复制是让另一个画布的落盘记录去取文件，防抖里那点改动必须先催下去；
     同画布复制沿用原来的口径：只有笔记要催（副本读的是它那份 .md 和图片目录）。 */
  const wanted = String(patch.space ?? "").trim();
  const target = wanted ? await agentFindSpace(wanted) : null;
  const elsewhere = Boolean(target && target.id !== current.meta.id);
  if (elsewhere) await Promise.all([flushItems(), flushBlockContents()]);
  else if (source.type === "note" && !source.linked) await flushBlockContents();
  const raw = JSON.parse(JSON.stringify(source));
  const fromId = current.meta.id;
  const sourceId = source.id;
  if (elsewhere) await agentOpenSpace(target.id);
  const item = normalizeItem({ ...raw, id: newId(), seq: 0, z: null });
  if (!item) throw new Error("这块没法复制");
  if (elsewhere) {
    /* 目标画布没有「原块右下一格」这回事：给了落点就照着摆，没给就摆在镜头正中 */
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
const BORDER_WIDTH_KINDS = new Set(["text", "rect", "ellipse", "image", "note", "file", "picture", "scene", "gen", "product", "quote", "plan"]);

async function agentUpdateBlock(id, patch = {}) {
  const item = agentRequireItem(id);
  if (item.type === "connector") return agentUpdateConnector(item, patch);
  /* 画面里垫的那张位图要先拷进画布、量好尺寸，归一化才认得这条 image。
     这一步放在任何改动落地之前：拷不动就抛，块还是原来那块，不会留下改到一半的样子 */
  const canvasId = current.meta.id;
  if (item.type === "picture" && (patch.cmds !== undefined || patch.symbols !== undefined)) {
    await resolvePictureImages(patch, canvasId);
    if (!current || current.meta.id !== canvasId) throw new Error("改这块的时候画布被切走了，什么都没改");
  }
  /* 锁住的块只认解锁（可以顺带在同一次 patch 里改别的）；其余修改先解锁 */
  const unlocking = patch.locked === false;
  if (item.locked && !unlocking && Object.keys(patch).some((key) => key !== "locked")) {
    throw new Error("这块已锁定，先解锁再改");
  }
  if (patch.locked !== undefined) item.locked = patch.locked === true;
  /* 客户版隐藏是所有块都有的开关，连线没有内容，不参与 */
  if (patch.internal !== undefined && item.type !== "connector") item.internal = patch.internal === true;
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
  /* 文字块的高度是内容撑开的；给 h 就是抬高地板，垂直对齐才有地方体现 */
  if (patch.h !== undefined && item.type === "text") {
    item.minH = Math.max(0, numOr(patch.h, item.minH));
    geometry = true;
  }
  if (item.type === "text" && ["left", "center", "right"].includes(patch.align)) {
    setTextAlign(item, "align", patch.align);
  }
  if (item.type === "text" && ["top", "middle", "bottom"].includes(patch.vAlign)) {
    setTextAlign(item, "vAlign", patch.vAlign);
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
    /* 文字块的边框跟「有没有边框色」同一个开关，和创建时的规矩一致 */
    if (item.type === "text") item.bordered = Boolean(patch.borderColor);
  }
  if (patch.fillColor !== undefined) {
    applyColor(item, "fillColor", String(patch.fillColor || ""));
  }
  if (patch.color !== undefined) {
    applyColor(item, "color", String(patch.color || ""));
  }
  if (patch.text !== undefined && item.type === "text") {
    item.text = String(patch.text);
    const body = el?.querySelector(".canvas-text-body");
    if (body) body.textContent = item.text;
    /* 被视口裁掉的块量不到高度，等回到视野里再补 */
    if (el && !el.classList.contains("is-culled")) item.h = el.offsetHeight;
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
    refreshPictureChrome(item.id);
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
  if (item.type === "scene" && patch.surfaces !== undefined) {
    item.surfaces = sceneSurfacesOf(patch.surfaces);
    setSceneFurnitureSelection(sceneView(item), []);
  }
  if (item.type === "scene" && patch.parts !== undefined) {
    setSceneFurnitureSelection(sceneView(item), []);
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
  if (item.type === "gen" && applyGenFields(item, patch)) {
    persistGen(item);
    /* 提示词/尺寸被 agent 改过，面板上的字和框高都要重新算 */
    refreshGenPanel(item.id);
  }
  if (item.type === "product") applyProductFields(item, patch);
  if (item.type === "quote") {
    if (patch.title !== undefined) {
      const title = String(patch.title || "").trim();
      if (title) item.title = title;
    }
    if (patch.internal !== undefined) item.internal = patch.internal === true;
  }
  if (item.type === "page") {
    if (patch.title !== undefined) {
      const title = String(patch.title || "").trim();
      if (title) item.title = title;
    }
    if (patch.order !== undefined) item.order = Math.max(0, Math.trunc(numOr(patch.order, item.order)));
    if (patch.ratio !== undefined && PAGE_RATIOS[patch.ratio]) {
      item.ratio = patch.ratio;
      item.w = PAGE_RATIOS[patch.ratio].w;
      item.h = PAGE_RATIOS[patch.ratio].h;
      geometry = true;
    }
  }
  if (el) syncItemElement(el, item);
  if (item.type === "product") refreshQuotes();
  if (geometry) {
    updateSelection();
    refreshConnectors();
  }
  scheduleItemsSave();
  if (item.type === "note" && patch.borderColor !== undefined) void persistNote(item);
  return pictureDropped.length ? { ...agentSummary(item), dropped: pictureDropped } : agentSummary(item);
}

/* ---------- 文件 / 笔记内容 ---------- */

/* agent 插文件不走弹窗：拷进画布还是引用原文件由调用方直接给 mode。 */
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
      if (!current || current.meta.id !== canvasId) throw new Error("导入时画布被切走了");
      if (force === "file") {
        const size = fileBlockSize(info);
        placed = await addFileBlock(info, point || insertPoint(size.w, size.h), mode);
      } else {
        placed = await addDroppedFile(info, point, mode);
      }
    }
  } catch (error) {
    throw new Error(`没能把这份文件放进画布：${error?.message || error}`);
  }
  if (!current || current.meta.id !== canvasId) throw new Error("导入时画布被切走了");
  if (!placed) throw new Error("没能把这份文件放进画布");
  if (spec.borderColor !== undefined) applyColor(placed, "borderColor", String(spec.borderColor || ""));
  if (spec.fillColor !== undefined) applyColor(placed, "fillColor", String(spec.fillColor || ""));
  if (spec.borderColor !== undefined || spec.fillColor !== undefined) scheduleItemsSave();
  agentRevealBlock(placed.id);
  agentHighlight([placed.id], 1400);
  return agentSummary(placed);
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
   先异步补一圈：写了 path 的拷进这个画布、把回来的相对路径填进 src；w / h 缺的照原图量。
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
        throw new Error(`没能把「${path.slice(0, 48)}」拷进这个画布：${error?.message || error}`);
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
    if (!current || current.meta.id !== canvasId) throw new Error("垫图进画面的时候画布被切走了");
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
  if (!current || current.meta.id !== canvasId) throw new Error("画这一笔的时候画布被切走了，什么都没改");
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
  /* 指令和素材不归 items.json 管，改完单独落 pictures/<块id>.json 那一份 */
  persistPicture(item);
  if (patch.paperColor !== undefined) {
    item.paperColor = String(patch.paperColor || "");
    refreshPictureChrome(item.id);
  }
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
  if (spec.mode !== undefined) {
    const want = String(spec.mode).trim().toLowerCase();
    if (!GEN_MODES.includes(want)) throw new Error(`mode 只认 ${GEN_MODES.join(" / ")}`);
    item.mode = want;
    touched = true;
  }
  if (spec.strength !== undefined) {
    const want = Number(spec.strength);
    if (!Number.isFinite(want)) throw new Error("strength 得是个 0~1 的数");
    item.strength = clamp(want, 0, 1);
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
    dit: engine.dit || "",
    encoder: engine.encoder || "",
    idleSeconds: engine.idleSeconds || 0,
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

async function agentGenRun(id, patch = {}, mask = "") {
  const item = agentGenOf(id);
  /* 锁拦改不拦看，但这一趟既改字段又发任务：先看锁，不许把提示词写进一块锁着的面板 */
  if (item.locked) throw new Error("这块已锁定，先解锁再出图");
  const busy = genBusyId();
  if (busy && busy !== item.id) {
    throw new Error(`引擎正被生图面板 ${busy} 占着，一次只出一张`);
  }
  if (mask) genRunMasks.set(item.id, String(mask));
  else genRunMasks.delete(item.id);
  /* 补细节是块上的开关，不走 applyGenFields */
  let refined = false;
  if (patch.refine !== undefined) {
    item.refine = Boolean(patch.refine);
    refined = true;
  }
  /* 改字段和发出去是同一次调用：先落到块上，出图取的就是块上这一份 */
  if (applyGenFields(item, patch) || refined) {
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
  if (!still) throw new Error(`生图面板 ${item.id} 已经不在这块画布里了`);
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
    if (!current || current.meta.id !== canvasId) throw new Error("写回时画布被切走了");
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
  if (!current || current.meta.id !== canvasId) throw new Error("读文件时画布被切走了");
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
  if (!current || current.meta.id !== canvasId) throw new Error("写文件时画布被切走了");
  const body = await store.readFileBody(canvasId, item.id);
  const next = String(text ?? "");
  const result = await store.writeBackCanvasFile(canvasId, item.id, next, body, Boolean(force));
  if (!current || current.meta.id !== canvasId) throw new Error("写文件时画布被切走了");
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

/* 用系统看图工具打开那块图：跟用户在画布上双击那一下是一回事 */
async function agentOpenImage(id) {
  const item = agentRequireItem(id);
  if (item.type !== "image" && item.type !== "gen") throw new Error("这不是图片块");
  if (!item.src) throw new Error("这块还没有图");
  await openImageExternally(item);
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
  if (!current || current.meta.id !== canvasId) throw new Error("读目录时画布被切走了");
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
  /* —— 调试口：不经过鼠标，直接开浮层、读元素样式。给 MCP 自测用 —— */
  debugColorPicker: ({ id, prop = "borderColor" } = {}) => {
    agentRequireSpace();
    const item = findItem(id);
    if (!item) throw new Error("没有这块");
    const el = itemEls.get(id);
    const rect = el ? el.getBoundingClientRect() : { right: 240, top: 240 };
    openColorPicker({
      x: Math.max(8, Math.min(rect.right + 12, window.innerWidth - 250)),
      y: Math.max(8, Math.min(rect.top, window.innerHeight - 400)),
      value: item[prop] || "",
      presets: PRESETS,
      allowAlpha: true,
      onChange: (color) => applyColor(item, prop, color),
    });
    return { id, prop, opened: true };
  },
  /* 调试用：按块 id 打开右键菜单，不展开子菜单 */
  debugMenu: ({ id } = {}) => {
    agentRequireSpace();
    const item = findItem(id);
    if (!item) throw new Error("没有这块");
    const el = itemEls.get(id);
    const r = el ? el.getBoundingClientRect() : { left: 200, top: 200 };
    openItemMenu(item, r.left + 24, r.top + 24);
    return { id, opened: true };
  },
  /* 调试用：按块 id 打开右键菜单，并程序化展开「边框 → 颜色」三级色盘 */
  debugMenuColor: async ({ id } = {}) => {
    agentRequireSpace();
    const item = findItem(id);
    if (!item) throw new Error("没有这块");
    const el = itemEls.get(id);
    const r = el ? el.getBoundingClientRect() : { left: 200, top: 200 };
    openItemMenu(item, r.left + 24, r.top + 24);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
    const menu = document.getElementById("ctx-menu");
    const border = [...menu.querySelectorAll("button")].find((b) => b.textContent.trim() === "边框");
    if (!border) throw new Error("菜单里没有「边框」");
    border.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await tick();
    const color = [...document.querySelectorAll(".ctx-submenu button")].find((b) =>
      b.textContent.trim().startsWith("颜色"),
    );
    if (!color) throw new Error("二级菜单里没有「颜色」");
    color.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await tick();
    return { id, opened: true };
  },
  /* 调试用：按选择器点一下（可再按文字筛），走 DOM 的 click，不模拟鼠标 */
  debugClick: ({ selector, text = "", focus = false, detail = 0, right = false } = {}) => {
    /* 隐藏的元素（别的面板上的同名按钮）不算候选，免得点错块 */
    const nodes = [...document.querySelectorAll(String(selector || ""))].filter(
      (node) => node.getBoundingClientRect().width > 0,
    );
    const el = text
      ? nodes.find((node) => (node.textContent || "").includes(String(text)))
      : nodes[0];
    if (!el) throw new Error("没找到要点的元素");
    if (right) {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }));
      return { clicked: true, right: true, text: (el.textContent || "").trim().slice(0, 30) };
    }
    if (focus) el.focus({ preventScroll: true });
    /* detail > 0 模拟真实鼠标点击，走和鼠标一样的 click 事件路径（含全局的“点完摘焦点”） */
    /* SVG 元素没有 click()，统一派发 MouseEvent；detail>0 也走这里 */
    if (detail > 0 || typeof el.click !== "function") {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: detail || 1 }));
    } else {
      el.click();
    }
    return {
      clicked: true,
      focused: focus && document.activeElement === el,
      className: typeof el.className === "string" ? el.className : "",
      text: (el.textContent || "").trim().slice(0, 30),
    };
  },
  /* 调试用：按选择器双击一下，走 DOM 的 dblclick，不模拟鼠标 */
  debugDoubleClick: ({ selector, text = "" } = {}) => {
    const nodes = [...document.querySelectorAll(String(selector || ""))].filter(
      (node) => node.getBoundingClientRect().width > 0,
    );
    const el = text
      ? nodes.find((node) => (node.textContent || "").includes(String(text)))
      : nodes[0];
    if (!el) throw new Error("没找到要双击的元素");
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    return {
      doubleClicked: true,
      className: typeof el.className === "string" ? el.className : "",
      text: (el.textContent || "").trim().slice(0, 30),
    };
  },
  /* 调试用：只派发 pointermove，验证悬停样式（不按下、不选中） */
  debugHover: ({ x = 0, y = 0, selector = "", text = "", last = false } = {}) => {
    /* 合成 pointermove 造不出 mouseenter（那是浏览器按真实位置推的），
       所以按选择器直接往元素上派发一份悬停事件，专供菜单展开这类验证 */
    let target = null;
    if (selector) {
      const all = [...document.querySelectorAll(selector)];
      const matches = text ? all.filter((el) => el.textContent.trim().includes(text)) : all;
      target = last ? matches.at(-1) : matches[0];
      if (!target) throw new Error(`没有匹配 ${selector} ${text} 的元素`);
      const rect = target.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
      const opts = { bubbles: false, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true };
      target.dispatchEvent(new PointerEvent("pointerenter", opts));
      target.dispatchEvent(new MouseEvent("mouseenter", opts));
      target.dispatchEvent(new PointerEvent("pointermove", { ...opts, bubbles: true }));
      return { hovered: true, x, y, target: target.textContent.trim().slice(0, 24) };
    }
    target = document.elementFromPoint(x, y) || document.body;
    target.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    return {
      hovered: true,
      x,
      y,
      target: typeof target.className === "string" ? target.className : target.tagName,
    };
  },
  /* 调试用：把元素滚进视野，不模拟滚轮 */
  debugScroll: ({ selector, align = "center" } = {}) => {
    const el = [...document.querySelectorAll(String(selector || ""))].find(
      (node) => node.getBoundingClientRect().width > 0,
    );
    if (!el) throw new Error("没找到要滚动的元素");
    el.scrollIntoView({ block: align, inline: "nearest" });
    return { scrolled: true, className: typeof el.className === "string" ? el.className : "" };
  },
  /* 调试用：向视口某个点派发一次滚轮，不模拟鼠标；验证块内滚动/推拉 */
  debugWheel: ({ x = 0, y = 0, deltaY = 120 } = {}) => {
    const target = document.elementFromPoint(Number(x) || 0, Number(y) || 0) || document.body;
    target.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: Number(x) || 0,
        clientY: Number(y) || 0,
        deltaY: Number(deltaY) || 0,
      }),
    );
    return {
      wheeled: true,
      target: typeof target.className === "string" ? target.className : "",
    };
  },
  /* 调试用：从视口坐标 (x,y) 拖 (dx,dy)，走 DOM 的 pointer 事件、不模拟鼠标 */
  debugDrag: ({ x = 0, y = 0, dx = 0, dy = 0, ctrl = false, shift = false } = {}) => {
    const fire = (type, cx, cy) => {
      const target = document.elementFromPoint(cx, cy) || document.body;
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          ctrlKey: Boolean(ctrl),
          shiftKey: Boolean(shift),
        }),
      );
    };
    fire("pointerdown", x, y);
    fire("pointermove", x + dx * 0.5, y + dy * 0.5);
    fire("pointermove", x + dx, y + dy);
    fire("pointerup", x + dx, y + dy);
    return { dragged: true, from: [x, y], to: [x + dx, y + dy] };
  },
  /* 调试用：向页面派发一次键盘事件，不模拟鼠标、不抢系统焦点 */
  debugKey: ({ key, action = "press", ctrl = false, shift = false, alt = false, meta = false } = {}) => {
    if (!key) throw new Error("缺少按键名");
    const target = document.activeElement || document.body;
    const init = {
      key: String(key),
      code: String(key),
      bubbles: true,
      cancelable: true,
      ctrlKey: Boolean(ctrl),
      shiftKey: Boolean(shift),
      altKey: Boolean(alt),
      metaKey: Boolean(meta),
    };
    let down = null;
    if (action !== "up") {
      down = new KeyboardEvent("keydown", init);
      target.dispatchEvent(down);
    }
    if (action !== "down") target.dispatchEvent(new KeyboardEvent("keyup", init));
    return {
      dispatched: true,
      key: String(key),
      action,
      prevented: Boolean(down?.defaultPrevented),
    };
  },
  /* 调试用：把文字写进输入框并触发 input，不模拟键盘。搜索框的实时定位走这条 */
  debugInput: async ({ selector, text = "" } = {}) => {
    const el = [...document.querySelectorAll(String(selector || ""))].find(
      (node) => node.getBoundingClientRect().width > 0,
    );
    if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      throw new Error("没找到可输入的输入框");
    }
    el.focus();
    el.value = String(text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    /* 搜索有 90ms 防抖：等它跑完再回话，调用方拿到的就是定位后的状态 */
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { input: true, value: el.value };
  },
  /* 调试用：给屏幕坐标，列出这一点的元素栈，查「谁把谁盖住了」 */
  debugHit: ({ x = 0, y = 0 } = {}) =>
    document.elementsFromPoint(Number(x) || 0, Number(y) || 0).slice(0, 14).map((node) => {
      const style = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return {
        tag: node.tagName.toLowerCase(),
        className: typeof node.className === "string" ? node.className : "",
        zIndex: style.zIndex,
        background: style.backgroundColor,
        opacity: style.opacity,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    }),
  debugInspect: ({ selector, pseudo = "" } = {}) => {    const nodes = [...document.querySelectorAll(String(selector || ""))].slice(0, 40);
    const active = document.activeElement;
    return {
      count: nodes.length,
      activeElement: active
        ? {
            tag: active.tagName.toLowerCase(),
            id: active.id || "",
            className: typeof active.className === "string" ? active.className : "",
          }
        : null,
      items: nodes.map((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el, pseudo || null);
        return {
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === "string" ? el.className : "",
          text: (el.textContent || "").trim().slice(0, 30),
          value:
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.value
              : undefined,
          ...(el instanceof HTMLImageElement
            ? {
                src: el.getAttribute("src") || "",
                natural: [el.naturalWidth, el.naturalHeight],
                complete: el.complete,
              }
            : {}),
          ...(pseudo ? { content: style.content } : {}),
          parent: el.parentElement
            ? `${el.parentElement.tagName.toLowerCase()}.${
                typeof el.parentElement.className === "string" ? el.parentElement.className : ""
              }`
            : "",
          visibility: style.visibility,
          position: style.position,
          zIndex: style.zIndex,
          cursor: style.cursor,
          scrollHeight: el.scrollHeight || undefined,
          clientHeight: el.clientHeight || undefined,
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          display: style.display,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          width: style.width,
          height: style.height,
          border: style.border,
          background: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          gridColumns: style.gridTemplateColumns,
          gap: style.gap,
          textAlign: style.textAlign,
          justifyContent: style.justifyContent,
        };
      }),
    };
  },
  debugClose: () => {
    closeColorPicker(true);
    closeMenu();
    searchApi?.close();
    return { closed: true };
  },
  /* 一次提交一串操作：期间不运镜不打光带 */
  beginBatch: () => {
    batching = true;
  },
  endBatch: () => {
    batching = false;
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
  sceneGet: agentSceneGet,
  sceneSurfaceSet: agentSceneSurfaceSet,
  sceneFurnitureBind: agentSceneFurnitureBind,
  sceneFurnitureMove: agentSceneFurnitureMove,
  scenePlacementMode: ({ id, enabled }) => setScenePlacementMode(agentRequireItem(id), Boolean(enabled)),
  sceneRoomShell: agentSceneRoomShell,
  sceneLightPreset: agentSceneLightPreset,
  sceneCameraPreset: agentSceneCameraPreset,
  scenePlaceProduct: agentScenePlaceProduct,
  sceneApplyMaterial: agentSceneApplyMaterial,
  planCalibrate: agentPlanCalibrate,
  planPlaceProduct: agentPlanPlaceProduct,
  planPlaceCamera: agentPlanPlaceCamera,
  planArea: agentPlanArea,
  planRemove: agentPlanRemove,
  pageSnapshot: agentPageSnapshot,
  proposalTemplate: agentProposalTemplate,
  pageDuplicate: agentPageDuplicate,
  clientWebExport: (dir, name) => {
    const target = String(dir || "").trim();
    if (!target) throw new Error("要给一个已经存在的导出文件夹 dir");
    return exportClientWebTo(target, String(name || exportRootName(current?.meta.name || "提案")));
  },
  clientPdfExport: (dir, name) => {
    const target = String(dir || "").trim();
    if (!target) throw new Error("要给一个已经存在的导出文件夹 dir");
    return exportClientPdfTo(target, String(name || `${current?.meta.name || "提案"} 客户版`));
  },
  spaceList: agentSpaceList,
  spaceTree: agentSpaceTree,
  spaceOpen: agentOpenSpace,
  spaceCreate: agentCreateSpace,
  spaceCopy: agentSpaceCopy,
  spaceRename: agentRenameSpace,
  spaceDelete: agentDeleteSpace,
  groupCreate: agentGroupCreate,
  groupRename: agentGroupRename,
  groupDelete: agentGroupDelete,
  blockGet: agentBlock,
  blockCreate: async (spec) => {
    const placed = await agentCreateBlock(spec);
    agentRevealBlock(placed.id);
    agentHighlight([placed.id], 1200);
    return placed;
  },
  /* 一次把一份 CSV 变成一排产品卡；图片列按 CSV 所在目录找 */
  productImportCsv: async ({ path, x, y } = {}) => {
    agentRequireSpace();
    const file = String(path || "").trim();
    if (!file) throw new Error("需要 CSV 文件的绝对路径 path");
    const origin =
      Number.isFinite(Number(x)) && Number.isFinite(Number(y))
        ? { x: Number(x), y: Number(y) }
        : null;
    return importProductsFromCsv(file, origin);
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
  pictureExport: (id) => exportPictureImage(id),
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
    if (!current) throw new Error("当前没有打开的画布");
    return exporter.snapshot(options || {});
  },
  exportAs: (format, options) => {
    if (!current) throw new Error("当前没有打开的画布");
    return exporter.exportAs(format, options || {});
  },
  exportRegion: (options) => {
    if (!current) throw new Error("当前没有打开的画布");
    return exporter.exportRegion(options || {});
  },
  importFile: agentImportFile,
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
  imageOpen: agentOpenImage,
  pdfState: agentPdfState,
  pdfGoto: agentPdfGoto,
  ebookToc: agentEbookToc,
  ebookGoto: agentEbookGoto,
  mediaState: agentMediaState,
  mediaControl: agentMediaControl,
};
