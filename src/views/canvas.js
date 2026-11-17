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
  setSceneFurnitureSelection, sceneFurnitureInspect, exportSceneGLB, exportPartsGLB,
  onSceneFurnitureSelection, renderModelThumbnail,
} from "./scene3d.js";
import {
  dropGenRun,
  genBusyId,
  genRunOf,
  onGenRunChange,
  patchGenRun,
  syncGen,
} from "./genpanel.js";
import {
  dropVideoRun,
  patchVideoRun,
  syncVideoPanel,
  videoBusyId,
  videoRunOf,
} from "./videopanel.js";
import { openVideoHelp } from "./video-help.js";
import { openImageCompare } from "./image-compare.js";
import { createExporter, QUALITY, DEFAULT_QUALITY } from "./export.js";
import { rasterize, toPngDataUrl } from "./raster.js";
import * as store from "./canvas-store.js";
export { agentAnimateCamera, agentFindSpace, agentHighlight, agentOpenSpace, agentPlacePoint, agentRequireItem, agentRequireSpace, agentRevealBlock, agentStopCameraAnim, agentSummary, applyProductFields, numOr };
import { agentAnimateCamera, agentBlock, agentBounds, agentCameraState, agentCreateSpace, agentDeleteSpace, agentFindGroup, agentFindSpace, agentFitView, agentFocusBlock, agentGroupCreate, agentGroupDelete, agentGroupRename, agentHighlight, agentOpenSpace, agentPlacePoint, agentRenameSpace, agentRequireItem, agentRequireSpace, agentRevealBlock, agentScene, agentSleep, agentSpaceCopy, agentSpaceList, agentSpaceTree, agentStopCameraAnim, agentSummary, applyProductFields, cameraAnim, numOr } from "./canvas/agent-layer.js";
export { genFeedOf };
export { BATCH_GAP, addImageBlock, applyColor, baseName, copyIntoCanvas, copyItems, deleteItems, fileExt, insertPoint, landBlock, moveLayer, pasteAudio, pasteImage, placeBlock, revealItem, setFontSize, setTextAlign };
import { BATCH_GAP, INSERT_STEP, copyIntoCanvas, finishAudioFix, fixVideoAudio, hideCopyProgress, insertCam, insertPoint, insertStep, onAudioFixProgress, onCopyProgress, openVideoProblem, paintCopyProgress, paintFixProgress, pasteAudio, pasteImage, placeBlock, probeCache, probeVideoBlock, setupVideoCopyEvents, showCopyProgress, showFixProgress } from "./canvas/media-fallback.js";
export { audioExtFor, fileToDataUrl, formatSize, imageSize, openVideoHelp, pastePoint, stageCenterWorld };
import { AUDIO_MIME_EXT, BLOCK_CLIPBOARD, MEDIA_TYPES, PASTE_OFFSET, addImageBlock, addTextAtPointer, audioExtFor, baseName, batchRowPoint, clipboardBlockPayload, clipboardFiles, coord, copiedBlocks, copyItems, fileExt, fileToDataUrl, imageSize, insertFileFromPicker, insertGenPanel, insertPaths, landBlock, onPaste, pasteBlocks, pasteCopiedBlocks, pastePoint, pickAndInsert, revealItem, selectionBox, stageCenterWorld } from "./canvas/copy-paste.js";
export { askInsertMode, remapPictureImageSrcs };
import { CONNECTOR_ARROWS, CONNECTOR_SHAPES, FONT_SIZES, PROP_KIND, PROP_PATH_TYPES, STACK_LABELS, TEXT_ALIGN_H, TEXT_ALIGN_V, activeBodySelectionText, applyColor, blocksBelowPoint, bodySelectionText, borderMenuEntry, colorEntry, compareImagesEntry, copyBodySelectionText, deleteItems, fontSizeMenuItems, imageSaveAsEntry, itemBodyEl, itemMenuEntries, layerMenuItems, moveLayer, openBlankMenu, openBorderWidthDialog, openCompareFor, openItemMenu, openItemProps, openRadiusDialog, removeItemFromDom, saveImageAs, selectBelowEntry, setConnectorProp, setFontSize, setLocked, setLockedMany, setTextAlign, showPropsCard, withSelect } from "./canvas/context-menu.js";
export { absolutePathOf, addSceneModelFlow, cancelPlanCalibration, changeProductImage, collectPictureImageSrcs, createFurnitureFlow, exportQuote, exportSceneFlow, importCsvFromQuote, newSceneForProduct, openImageCompare, pickProductModel, placeProductInSceneFlow, placeProductOnPlanFlow, planCalibration, renamePageFlow, revealFileBlock, setPageOrderFlow, setPageRatio, startPlanCalibration, videoControlOf };
import { BORDER_WIDTH_KINDS, addTemplateText, agentCreateBlock, agentCreateConnector, agentDeleteBlock, agentDuplicateBlock, agentPageDuplicate, agentPageSnapshot, agentProposalTemplate, agentSelectBlocks, agentSetLayer, agentUpdateBlock, agentUpdateConnector, blockCenterInsidePage, buildClientScenes, clientHiddenIds, clientPageHtml, exportClientPdfTo, exportClientWebTo, exportHtmlEscape, exportJsonForHtml, exportRootName, fetchDataUrl, fetchTextAsset, hideConnectorsTemporarily, imageMimeOf, pageItems, renamePageFlow, setPageOrderFlow, setPageRatio } from "./canvas/delivery.js";
export { BORDER_DEFAULT_WIDTH, BORDER_MAX_WIDTH, GEN_DEFAULT_HEIGHT, GEN_DEFAULT_WIDTH, GEN_MIN_WIDTH, NOTE_MIN_HEIGHT, NOTE_MIN_WIDTH, PAGE_RATIOS, PICTURE_DEFAULT_HEIGHT, PICTURE_DEFAULT_WIDTH, PICTURE_MIN_HEIGHT, PICTURE_MIN_WIDTH, PLAN_DEFAULT_HEIGHT, PLAN_DEFAULT_WIDTH, PLAN_MIN_HEIGHT, PLAN_MIN_WIDTH, PRODUCT_MIN_HEIGHT, PRODUCT_MIN_WIDTH, QUOTE_DEFAULT_HEIGHT, QUOTE_DEFAULT_WIDTH, QUOTE_MIN_HEIGHT, QUOTE_MIN_WIDTH, SCENE_DEFAULT_HEIGHT, SCENE_DEFAULT_WIDTH, SCENE_MIN_HEIGHT, SCENE_MIN_WIDTH, TEXT_DEFAULT_WIDTH, agentImportFile, applyGenDefaultsToItem, bytesToBase64, connectorGeometry, itemBounds, makeBox, makeConnector, makeGen, makeLine, makePage, makePicture, makePlan, makeQuote, makeText, makeVideoGen, mergePictureSymbols, normalizeConnectorPoints, normalizeItem, pictureWashed, pinConnectorSides, refreshGenPanel, refreshQuotes, rejectFatalDrop, renderMarkdown, resolvePictureImages, roomShellParts, roomShellSurfaces, sceneLightOf, sceneSurfacesOf, sceneView, syncConnectorElement };
export { applyGenFields };
import { agentFileOf, agentFileRead, agentFileWrite, agentGenCancel, agentGenFamily, agentGenOf, agentGenPlace, agentGenRun, agentGenStatus, agentGenVideo, agentGenVideoCancel, agentGenVideoStatus, agentNoteOf, agentNoteRead, agentNoteWrite, agentOpenImage, agentRevealFile, applyGenFields, waitGenRun } from "./canvas/gen-agent.js";
export { GEN_CFG_MAX, GEN_MODES, GEN_STEPS_MAX, dropVideoRun, genEngine, genInputItems, genInputPng, genModeFor, placeGenImage, revealTarget, runOrStopGen, snapGenSize, stopGen, videoBusyId };
import { agentImportFile, agentPictureDraw, agentPictureGet, agentPictureLayers, agentPictureLight, agentPictureOf, mergePictureSymbols, pictureFaceCount, pictureLayersOf, pictureSymbolUses, pictureWashed, rejectFatalDrop, resolvePictureImages } from "./canvas/files-content.js";
export { PICTURE_MAX_CMDS, PICTURE_MAX_EXPANDED, addAudioBlock, addDroppedFile, addEbookBlock, addFileBlock, addVideoBlock, normalizeHidden, normalizePictureCmds, normalizePictureSymbols, pictureImageSrc, pictureLayerCensus, pictureTopLayers };
import { GEN_SIZE_PRESETS, applyGenDefaultsToItem, applySizePreset, attachGenPanel, genApiWatchBound, genDefaultsCache, genDefaultsTimer, genEffective, genEngine, genFamily, genFamilyWatchBound, genFeedOf, genInputItems, genInputPng, genModeFor, keepLastGenImage, loadGenDefaults, onGenDone, otherGenBlocked, paintGenMore, placeGenImage, refreshGenDefaults, refreshGenFeeds, refreshGenPanel, refreshGenRunButtons, runOrStopGen, saveGenDefaults, setupGenEvents, setupVideoEvents, shiftBlocksForPlace, startGenRun, stopGen, switchGenFamily, watchGenApi, watchGenFamily } from "./canvas/gen-defaults.js";
export { GEN_MIN_HEIGHT, GEN_MODE_LABELS, GEN_TEXT_MAX, dropGenRun, fitImageSize, genBusyId, genRunOf, makeImage, onGenRunChange, patchGenRun, patchVideoRun, syncGen, toPngDataUrl, videoRunOf };
import { agentPlanArea, agentPlanCalibrate, agentPlanPlaceCamera, agentPlanPlaceProduct, agentPlanRemove, attachPlanBlock, cancelPlanCalibration, finishPlanCalibration, placeProductOnPlanFlow, planAddArea, planAreaOf, planCalibration, planCardOf, planDefaultPoint, planPlaceCamera, planPlaceProduct, planRemove, startPlanCalibration } from "./canvas/floorplan.js";
export { planPixelsPerMm, promptDialog, setSceneCameraPreset };
import { FURNITURE_COLORS, SCENE_LIGHT_PRESETS, addSceneFloor, addSceneModel, addSceneModelFlow, agentSceneApplyMaterial, agentSceneCameraPreset, agentSceneFurnitureBind, agentSceneFurnitureMove, agentSceneGet, agentSceneLightPreset, agentScenePlaceProduct, agentSceneRoomShell, agentSceneSurfaceSet, applyFurniture, bufferToBase64, buildFurnitureParts, createFurnitureFlow, editableScene, exportSceneFlow, modelThumbCache, modelThumbnail, newSceneForProduct, openFurnitureDialog, pickProductModel, placeProductInScene, placeProductInSceneFlow, roomShellParts, roomShellSurfaces, saveSceneFurniture, sceneLightOf, sceneSurfacesOf, sceneView, setSceneCameraPreset } from "./canvas/scene-tools.js";
export { CLOSE_X_SVG, contentBox, exportPartsGLB, exportSceneGLB, makeScene, moveSceneFurnitureParts, newId, normalizeLight, normalizeSceneParts, normalizeSceneSurfaces, openMenu, renderModelThumbnail, sceneFurnitureGroup, sceneFurnitureInspect, sceneFurnitureMoveDelta, scenePlacementActive, setScenePlacementMode };
export { AUDIO_DEFAULT_HEIGHT, AUDIO_DEFAULT_WIDTH, EBOOK_DEFAULT_HEIGHT, EBOOK_DEFAULT_WIDTH, NOTE_DEFAULT_HEIGHT, NOTE_DEFAULT_WIDTH, PRODUCT_DEFAULT_HEIGHT, PRODUCT_DEFAULT_WIDTH, VIDEO_DEFAULT_HEIGHT, VIDEO_DEFAULT_WIDTH, beginSceneFurnitureDrag, fileBlockSize, makeAudio, makeEbook, makeFile, makeNote, makeProduct, makeVideo, normalizeSceneCamera, refreshQuoteCard, sceneCameraState, sceneFurnitureDragDelta, scenePick, setSceneFurnitureSelection, syncItemElement };
import { CSV_HEADER_ALIASES, addAudioBlock, addDroppedFile, addEbookBlock, addFileBlock, addVideoBlock, askInsertMode, attachProductCard, attachQuoteCard, attachSceneControls, bytesToBase64, changeProductImage, csvAmount, csvCell, csvColumnIndex, exportQuote, importCsvFromQuote, importProductsFromCsv, inlineEditField, moveSceneFurnitureParts, normalizeCsvHeader, parseCsvText, placeMarkdownFile, placeVideo, productItems, refreshQuotes, resolveCsvImagePath, revealFileBlock, revealTarget, sceneFurnitureGroup, scenePlacementActive, setScenePlacementMode, startProductFieldEdit } from "./canvas/inventory.js";
export { choiceDialog, store };
import { agentPdfController, agentPdfOf, agentPdfState, agentPdfGoto, agentEbookController, agentEbookOf, agentEbookToc, agentEbookGoto, agentMediaElement, agentMediaOf, agentMediaState, agentMediaControl } from "./canvas/pdf-media.js";
import { agentSetCamera, agentResetZoom } from "./canvas/camera.js";
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
  GEN_VIDEO_MIN_HEIGHT,
  GEN_VIDEO_MIN_WIDTH,
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
  makeVideoGen,
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

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
/* 每次缩放走 2 个百分点：1 点太慢，从 100% 挪到别处要点十几下 */
const ZOOM_STEP = 0.02;
/* 长按缩放键：先走一步，按住超过这段才开始连发，之后按这个节拍继续走 */
const ZOOM_HOLD_DELAY = 340;
const ZOOM_HOLD_INTERVAL = 60;
export const STORAGE_KEY = "workbench.canvas";
export const PRESETS = [
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
  /* 视频面板同理：首帧图就是连进来的 */
  "genvideo",
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
  genvideo: { w: GEN_VIDEO_MIN_WIDTH, h: GEN_VIDEO_MIN_HEIGHT },
};
const NOTE_EDITOR_GUARDS = ".canvas-note-editor, .color-pop, #ctx-menu";
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
export const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]);
/* 浏览器能解的容器：不在列表里的也能拖进来，但只能按引用播，交给浏览器试 */
export const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mkv", "mov"]);
/* Markdown 不当附件看待：拖进来抄成正文，直接变成一个能编辑的笔记块 */
const MARKDOWN_EXTS = new Set(["md", "markdown"]);
/* epub/mobi 能就地在画布上读；azw/azw3 这一版读不了，仍旧按附件收进来 */
export const EBOOK_EXTS = new Set(["epub", "mobi"]);

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export let ui = null;
export let active = false;
let searchApi = null;
export let canvases = [];
export let current = null; // { meta, camera, items }
/* 选中的块：平时点选只会有一个，Ctrl 点选往里加/摘，Ctrl+A 全往里倒 */
export let selectedIds = new Set();
export let editingId = null;
/* 连线中间文字的编辑态 { itemId, el, input, point, original } */
export let edgeLabelEditor = null;
let tool = "select";
let drag = null;
export let itemEls = new Map();
export let imageCache = new Map();
/* 画面块里垫的那张位图，渲染层只认 src，要能显示的地址得回来这张表拿。
   切画布时 imageCache 整个换掉，所以塞的是一个现查的函数、不是那张表本身。 */
setPictureMedia((src) => imageCache.get(src) || "");
/* 场景里贴的材质图也按当前画布取地址：换画布后同一个 images/xxx 不会串到上一个画布 */
setSceneAssetProvider(async (src) => {
  if (!current) throw new Error("没有打开的画布");
  return store.imageUrl(current.meta.id, src, false);
});
export let audioCache = new Map();
/* 视频只缓存 asset 地址（一串字符），不缓存任何字节 */
export let videoCache = new Map();
export let noteImageCache = new Map();
/* 文本块只读预览：缓存后端解好码的开头一段，切画布就清空重来。
   键带上存在方式，免得同一个路径的拷贝态和引用态串了。 */
export let filePreviewCache = new Map();
export const previewKey = (item) => `${item.linked ? "L" : "C"}|${item.src}`;
/* PDF 块的 asset 地址：一份文件问后端一次（顺带开的那次读权限也就够了），
   翻页和拖角缩放重画都复用这条地址 */
let pdfUrlCache = new Map();
let docxUrlCache = new Map();
let xlsxUrlCache = new Map();
let pptxUrlCache = new Map();
/* 书的目录进画布只读一次，翻章不用再解析整本；键和预览一样带上存在方式 */
export let ebookTocCache = new Map();
export const ebookKey = (canvasId, item) => `${canvasId}|${item.linked}|${item.src}`;
export let noteEditor = null; // 当前笔记块的编辑态 { itemId, el, box, textarea, editor }
/* 引用态笔记块这一轮编辑是否允许写回原 .md（编辑弹层里选「修改源文件」才是） */
let noteWriteBack = false;
/* 已经弹过「改哪一份」的块，双击连着触发两次不至于叠出两层弹层 */
let noteAskId = null;
/* 音视频块指向的文件找不到了（引用查原片、拷贝查副本）：块留在原地，改成丢文件卡。每次进画布重新查。 */
let mediaMissing = new Set();
export let modalOpen = false;
export let lastPointer = { x: 0, y: 0, inside: false };
let hoverId = null;
/* Alt 测距：按住时给单选的块画四周最近面板的距离，松开就收 */
let measureHeld = false;
let measureFrame = 0;
let previewPath = null;
export let itemsTimer = null;
export let cameraTimer = null;
export let errorTimer = null;
let loadToken = 0;
/* 同时只跑一个后台拷贝：进度条只有一根，视频和文件共用 */
export let batching = false;
export let copyTask = null; // { job, canvasId, resolve, label }
/* 转音轨排在拷贝后面，同一根进度条，不并发 */
export let audioFix = null; // { job, canvasId, item }

/* canvas/* 子模块需要写的状态走 setter：ESM 的 import 绑定只读 */
export function replaceSelection(ids) { selectedIds = ids; }
export function setModalOpen(value) { modalOpen = value; }
export function setCopyTask(value) { copyTask = value; }
export function setAudioFix(value) { audioFix = value; }
export function setItemsTimer(value) { itemsTimer = value; }
export function setCameraTimer(value) { cameraTimer = value; }
export function setErrorTimer(value) { errorTimer = value; }
export function setCurrent(value) { current = value; }
export function setEditingId(value) { editingId = value; }
export function setNoteEditor(value) { noteEditor = value; }

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
export const exporter = {
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
      showToast(
        result.layout
          ? `已导出公众号长图页：${saved}（点「复制整版长图」，再粘到编辑器）`
          : `已导出公众号文章：${saved}（点「复制全文」，再粘到编辑器）`,
      );
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
export function showToast(text) {
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

  /* 左下角信息条：默认只报编号，点一下展开坐标和尺寸，再点收起 */
  ui.metrics.addEventListener("click", () => {
    metricsOpen = !metricsOpen;
    updateMetrics();
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
  setupVideoEvents();
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

  /* 生图面板的模型默认参数：启动读一次，设置窗口切模型时再刷 */
  watchGenFamily();
  watchGenApi();
  refreshGenDefaults();

  /* Ctrl 按住时画布进入框选态（光标变十字），松开恢复 */
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Control" && event.key !== "Meta") return;
    ctrlHeld = true;
    setMarqueeCursor();
  });
  window.addEventListener("keyup", (event) => {
    if (event.key !== "Control" && event.key !== "Meta") return;
    ctrlHeld = false;
    setMarqueeCursor();
  });
  window.addEventListener("blur", () => {
    ctrlHeld = false;
    setMarqueeCursor();
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

export async function loadList() {
  try {
    canvases = await store.listCanvases();
  } catch (error) {
    canvases = [];
    showError(error);
  }
  await refreshTree();
}

export async function switchTo(id) {
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
    /* 块的容器归属按新画布重算：重叠的框先到先得 */
    rebuildContainerOwners();
    refreshTitlebarPath();
    refreshSceneToolbar();
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

export function showEmpty() {
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

/* ---------- 左侧画布树 ---------- */

/* 右键谁，谁就保持悬停底色，直到菜单收起；换右键对象时旧的撤掉 */
function markTreeContext(row) {
  for (const el of document.querySelectorAll(".space-tree-row.is-context")) {
    el.classList.remove("is-context");
  }
  row.classList.add("is-context");
}

document.addEventListener("inspace:menu-closed", () => {
  for (const el of document.querySelectorAll(".space-tree-row.is-context")) {
    el.classList.remove("is-context");
  }
});

const TREE_KEY = "workbench.spaceTree";
let treeUi = null;
export let treeData = [];
export let treeCollapsed = new Set();
let treePanelCollapsed = new Set();
let treeSections = { canvas: true, panels: true };
let treeOrder = {};
let treeRenaming = null;
let treeWidth = 220;

function treeSavePrefs() {
  localStorage.setItem(TREE_KEY, JSON.stringify({
    width: treeWidth,
    hidden: treeUi ? treeUi.aside.hidden : false,
    collapsed: [...treeCollapsed],
    panelCollapsed: [...treePanelCollapsed],
    sections: treeSections,
    order: treeOrder,
  }));
}

function initSpaceTree() {
  treeUi = {
    aside: document.querySelector("#space-tree"),
    body: document.querySelector("#space-tree-body"),
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
  treePanelCollapsed = new Set(Array.isArray(prefs.panelCollapsed) ? prefs.panelCollapsed : []);
  if (prefs.order && typeof prefs.order === "object") treeOrder = prefs.order;
  if (prefs.sections && typeof prefs.sections === "object") {
    treeSections = {
      canvas: prefs.sections.canvas !== false,
      panels: prefs.sections.panels !== false,
    };
  }
  treeSetHidden(Boolean(prefs.hidden));


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
    "-",
    { label: "导入画布", onClick: () => void importIntoGroup("") },
    /* 根级导出 = 整个 spaces 一次打包成一个 .inspace */
    { label: "导出画布", onClick: () => void exportTreeSpace({ id: "", name: "全部画布" }, true) },
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

/* 扁平的分组清单：复制画布时当目标列表，标签带上父路径才分得清同名分组 */
export function treeGroupList() {
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

/* 手动排序：同一父级下的兄弟顺序存偏好，覆盖后端按名字排的默认序 */
function treeParentKey(id) {
  const i = id.lastIndexOf("/");
  return i < 0 ? "" : id.slice(0, i);
}

function treeFindGroup(id) {
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type !== "group") continue;
      if (n.id === id) return n;
      const hit = walk(n.children || []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(treeData);
}

function orderedChildren(kids, parentKey) {
  const ord = treeOrder[parentKey];
  if (!Array.isArray(ord) || !ord.length) return kids;
  const pos = new Map(ord.map((id, i) => [id, i]));
  return [...kids].sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : 1e9;
    const pb = pos.has(b.id) ? pos.get(b.id) : 1e9;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

function treeSiblings(node) {
  const pk = treeParentKey(node.id);
  const kids = pk ? (treeFindGroup(pk)?.children || []) : treeData;
  return orderedChildren(kids, pk);
}

function moveTreeNode(node, dir) {
  const sibs = treeSiblings(node);
  const i = sibs.findIndex((x) => x.id === node.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const ids = sibs.map((x) => x.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  treeOrder[treeParentKey(node.id)] = ids;
  treeSavePrefs();
  renderTree();
}

function treeMoveEntries(node) {
  const sibs = treeSiblings(node);
  const i = sibs.findIndex((x) => x.id === node.id);
  return [
    { label: "向上", disabled: i <= 0, onClick: () => moveTreeNode(node, -1) },
    { label: "向下", disabled: i < 0 || i >= sibs.length - 1, onClick: () => moveTreeNode(node, 1) },
  ];
}

function renderTree() {
  if (!treeUi) return;
  /* 正在就地改名就别重排：输入框会被排掉，blur 还会误提交一次 */
  if (treeRenaming) return;
  const body = treeUi.body;
  body.textContent = "";
  let shown = 0;
  body.append(treeSectionHeader("canvas"));

  const renderRow = (node, depth) => {
    const isGroup = node.type === "group";
    const row = document.createElement("div");
    row.className = `space-tree-row${isGroup ? " is-group" : ""}`;
    row.dataset.kind = node.type;
    row.dataset.id = node.id;
    row.style.paddingLeft = `${6 + depth * 14 + (isGroup ? 0 : 17)}px`;
    const expanded = !treeCollapsed.has(node.id);
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
      markTreeContext(row);
      if (isGroup) openTreeGroupMenu(node, event.clientX, event.clientY);
      else openTreeCanvasMenu(node, event.clientX, event.clientY);
    });
    body.append(row);
    shown += 1;
    if (isGroup && expanded) {
      for (const kid of orderedChildren(node.children || [], node.id)) renderRow(kid, depth + 1);
    }
  };
  if (treeSections.canvas) {
    for (const node of orderedChildren(treeData, "")) renderRow(node, 0);
    if (!shown) {
      const hint = document.createElement("p");
      hint.className = "space-tree-hint";
      hint.textContent = "还没有画布，点「画布」行的 + 新建";
      body.append(hint);
    }
  }
  body.append(treeSectionHeader("panels"));
  if (treeSections.panels) renderPanelTree(body);
}

/* 分类标题跟着自己的列表走：吸顶在滚动区里，折叠按钮和新建/计数都在这一行 */
function treeSectionHeader(kind) {
  const isCanvas = kind === "canvas";
  const open = isCanvas ? treeSections.canvas : treeSections.panels;
  const row = document.createElement("div");
  row.className = `space-tree-section${open ? " is-open" : ""}`;
  row.dataset.section = kind;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "space-tree-section-toggle";
  toggle.title = isCanvas ? "收起 / 展开画布" : "收起 / 展开面板";
  toggle.setAttribute("aria-label", toggle.title);
  toggle.innerHTML = TREE_CHEVRON;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isCanvas) treeSections.canvas = !treeSections.canvas;
    else treeSections.panels = !treeSections.panels;
    treeSavePrefs();
    renderTree();
  });
  row.append(toggle);
  const label = document.createElement("span");
  label.className = "space-tree-section-label";
  label.textContent = isCanvas ? "画布" : "面板";
  row.append(label);
  /* 和分组行一样：整行点下去就是展开 / 收起 */
  row.addEventListener("click", () => {
    if (isCanvas) treeSections.canvas = !treeSections.canvas;
    else treeSections.panels = !treeSections.panels;
    treeSavePrefs();
    renderTree();
  });
  if (isCanvas) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "space-tree-btn";
    add.title = "新建";
    add.setAttribute("aria-label", "新建");
    add.setAttribute("aria-haspopup", "true");
    add.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>';
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = add.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, treeRootEntries(), { label: "新建" });
    });
    row.append(add);
  } else {
    const count = document.createElement("span");
    count.className = "space-tree-count";
    count.textContent = current?.items?.length ? String(current.items.length) : "";
    row.append(count);
  }
  return row;
}

/* ---------- 面板树：当前画布里的块，容器矩形可展开 ---------- */

const PANEL_TYPE_LABEL = {
  text: "文字",
  rect: "矩形",
  ellipse: "椭圆",
  line: "直线",
  arrow: "箭头",
  note: "笔记",
  picture: "画面",
  scene: "3D 场景",
  gen: "生图面板",
  genvideo: "视频生成",
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
  ebook: "书页",
  product: "产品卡",
  quote: "清单",
  plan: "户型",
  page: "提案页",
  connector: "连线",
};

const GEN_MODE_TREE_LABEL = {
  t2i: "文生图",
  i2i: "图生图",
  edit: "参考图编辑",
  inpaint: "局部重绘",
  upscale: "高清放大",
};

/* 树上一律「编号 + 类型」；重命名过的用自定义名顶替类型那截 */
function panelTreeLabel(item) {
  const seq = item.seq ? `#${item.seq} ` : "";
  const custom = (item.treeName || "").trim();
  if (custom) return seq + custom;
  if (item.type === "gen") {
    const mode = genModeFor(item, genInputItems(item).length);
    return seq + (GEN_MODE_TREE_LABEL[mode] || "生图");
  }
  if (item.type === "rect" && isContainer(item)) return seq + "容器";
  if (item.type === "connector") return "连线";
  return seq + (PANEL_TYPE_LABEL[item.type] || item.type);
}

async function renamePanelTree(item) {
  const fallback = panelTreeLabel(item).replace(/^#\d+\s*/, "");
  const name = await promptDialog({
    title: "重命名面板",
    label: "留空恢复成编号 + 类型",
    value: (item.treeName || "").trim() || fallback,
    okText: "重命名",
    validate: () => null,
  });
  if (name === null || name === undefined) return;
  const trimmed = String(name).trim();
  if (trimmed) item.treeName = trimmed.slice(0, 60);
  else delete item.treeName;
  scheduleItemsSave();
  renderTree();
}

/* 容器框里的块：整块落在框内才算；连线按两端中点落框内算 */
function treeContainerKids(container) {
  const el = itemEls.get(container.id);
  if (!el || !current) return [];
  const box = itemBounds(container, el);
  const out = [];
  for (const item of current.items) {
    if (item.id === container.id) continue;
    if (item.type === "connector") {
      const a = findItem(item.from?.item);
      const b = findItem(item.to?.item);
      const ae = a && itemEls.get(a.id);
      const be = b && itemEls.get(b.id);
      if (!ae || !be) continue;
      const ab = itemBounds(a, ae);
      const bb = itemBounds(b, be);
      const mx = (ab.x + ab.w / 2 + bb.x + bb.w / 2) / 2;
      const my = (ab.y + ab.h / 2 + bb.y + bb.h / 2) / 2;
      if (mx >= box.x && mx <= box.x + box.w && my >= box.y && my <= box.y + box.h) out.push(item);
      continue;
    }
    const childEl = itemEls.get(item.id);
    if (!childEl) continue;
    const b = itemBounds(item, childEl);
    if (
      b.x >= box.x - 1 &&
      b.y >= box.y - 1 &&
      b.x + b.w <= box.x + box.w + 1 &&
      b.y + b.h <= box.y + box.h + 1 &&
      ownedByContainer(item, container, box)
    ) out.push(item);
  }
  return out;
}

/* 面板的兄弟 = 同一个容器里的块，或都不在任何容器里的顶层块；取最内层容器 */
function panelSiblingList(item) {
  const items = current?.items || [];
  const kidsOf = new Map();
  const nested = new Set();
  for (const it of items) {
    if (it.type === "rect" && isContainer(it)) {
      const kids = treeContainerKids(it);
      kidsOf.set(it.id, kids);
      for (const kid of kids) nested.add(kid.id);
    }
  }
  let parent = null;
  let parentArea = Infinity;
  for (const [cid, kids] of kidsOf) {
    if (!kids.some((x) => x.id === item.id)) continue;
    const c = findItem(cid);
    const area = (c?.w || 0) * (c?.h || 0);
    if (area < parentArea) {
      parentArea = area;
      parent = cid;
    }
  }
  return parent ? kidsOf.get(parent) : items.filter((x) => !nested.has(x.id));
}

/* 上下移 = 在 current.items 里和相邻兄弟交换位置，随画布一起存 */
function movePanelItem(item, dir) {
  const list = panelSiblingList(item);
  const i = list.findIndex((x) => x.id === item.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j];
  const ia = current.items.indexOf(item);
  const ib = current.items.indexOf(other);
  if (ia < 0 || ib < 0) return;
  current.items[ia] = other;
  current.items[ib] = item;
  scheduleItemsSave();
  renderTree();
}

function panelMoveEntries(item) {
  const list = panelSiblingList(item);
  const i = list.findIndex((x) => x.id === item.id);
  return [
    { label: "向上", disabled: i <= 0, onClick: () => movePanelItem(item, -1) },
    { label: "向下", disabled: i < 0 || i >= list.length - 1, onClick: () => movePanelItem(item, 1) },
  ];
}

function renderPanelTree(body) {
  const items = current?.items || [];
  if (!items.length) {
    const hint = document.createElement("p");
    hint.className = "space-tree-hint";
    hint.textContent = current ? "这块画布还是空的" : "先打开一块画布";
    body.append(hint);
    return;
  }
  /* 先算每个容器的孩子，顶层只摆没被任何容器装着的块 */
  const kidsOf = new Map();
  const nested = new Set();
  for (const item of items) {
    if (item.type === "rect" && isContainer(item)) {
      const kids = treeContainerKids(item);
      kidsOf.set(item.id, kids);
      for (const kid of kids) nested.add(kid.id);
    }
  }
  const renderPanelRow = (item, depth, seen) => {
    const isCont = item.type === "rect" && isContainer(item);
    const isScene = item.type === "scene";
    const row = document.createElement("div");
    row.className = "space-tree-row";
    row.dataset.kind = "panel";
    row.dataset.id = item.id;
    row.style.paddingLeft = `${6 + depth * 14 + (isCont || isScene ? 0 : 17)}px`;
    if (selectedIds.has(item.id)) row.classList.add("is-selected");
    const expanded = !treePanelCollapsed.has(item.id);
    if (isCont || isScene) {
      const chevron = document.createElement("span");
      chevron.className = `space-tree-chevron${expanded ? " is-open" : ""}`;
      chevron.innerHTML = TREE_CHEVRON;
      /* 三角单独管展开/收起：单击它不连带选中这一行 */
      chevron.addEventListener("click", (event) => {
        event.stopPropagation();
        if (treePanelCollapsed.has(item.id)) treePanelCollapsed.delete(item.id);
        else treePanelCollapsed.add(item.id);
        treeSavePrefs();
        renderTree();
      });
      chevron.addEventListener("dblclick", (event) => {
        event.stopPropagation();
      });
      row.append(chevron);
    }
    const label = document.createElement("span");
    label.className = "space-tree-label";
    const text = panelTreeLabel(item);
    label.textContent = text;
    label.title = text;
    row.append(label);
    if (item.locked) {
      const lock = document.createElement("span");
      lock.className = "space-tree-lock";
      lock.title = "已锁定";
      lock.innerHTML = LOCK_BADGE_SVG;
      row.append(lock);
    }
    row.addEventListener("click", () => {
      select(item.id);
      agentRevealBlock(item.id);
      /* 从面板树点选：给画布上那块打一圈 1 秒的光带，锁定块没有常规选中标记，
         靠这一下知道点的是谁；直接在画布上选不走这里，就没有这效果 */
      agentHighlight([item.id], 1000);
      renderTree();
    });
    /* 双击：容器展开/收起；Ctrl+双击：锁定/解锁（和 Ctrl+L 同一套语义） */
    row.addEventListener("dblclick", (event) => {
      const now = findItem(item.id);
      if (!now) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        setLockedMany([now.id], !now.locked);
        renderTree();
        return;
      }
      if (!isCont && !isScene) return;
      event.preventDefault();
      event.stopPropagation();
      if (treePanelCollapsed.has(now.id)) treePanelCollapsed.delete(now.id);
      else treePanelCollapsed.add(now.id);
      treeSavePrefs();
      renderTree();
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markTreeContext(row);
      openMenu(event.clientX, event.clientY, [
        ...panelMoveEntries(item),
        "-",
        { label: "重命名", onClick: () => void renamePanelTree(item) },
        "-",
        ...itemMenuEntries(item, event.clientX, event.clientY),
      ], { label: text });
    });
    body.append(row);
    if (isCont && expanded && !seen.has(item.id)) {
      seen.add(item.id);
      for (const kid of kidsOf.get(item.id) || []) renderPanelRow(kid, depth + 1, seen);
    }
    if (isScene && expanded) {
      const labelCount = new Map();
      (item.parts || []).forEach((part, index) => {
        const base = scenePartBaseLabel(part);
        const count = (labelCount.get(base) || 0) + 1;
        labelCount.set(base, count);
        const partRow = document.createElement("div");
        partRow.className = "space-tree-row";
        partRow.dataset.kind = "scene-part";
        partRow.dataset.id = item.id;
        partRow.dataset.index = String(index);
        partRow.style.paddingLeft = `${6 + (depth + 1) * 14 + 17}px`;
        const partSelection = sceneView(item)?.__sceneSelection?.indices || [];
        if (partSelection.includes(index)) partRow.classList.add("is-selected");
        const partLabel = document.createElement("span");
        partLabel.className = "space-tree-label";
        partLabel.textContent = count > 1 ? `${base} ${count}` : base;
        partLabel.title = partLabel.textContent;
        partRow.append(partLabel);
        partRow.addEventListener("click", () => enterScenePart(item, index));
        body.append(partRow);
      });
    }
  };
  const seen = new Set();
  for (const item of items) {
    if (nested.has(item.id)) continue;
    renderPanelRow(item, 0, seen);
  }
}

function openTreeGroupMenu(node, x, y) {
  const empty = !(node.children || []).length;
  openMenu(x, y, [
    { label: "新建画布", onClick: () => createFlowIn(node.id) },
    { label: "新建子分组", onClick: () => createGroupFlow(node.id) },
    { label: "导入画布", onClick: () => void importIntoGroup(node.id) },
    { label: "导出画布", onClick: () => void exportTreeSpace(node, true) },
    "-",
    ...treeMoveEntries(node),
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
    { label: "导出画布", onClick: () => void exportTreeSpace(node, false) },
    "-",
    ...treeMoveEntries(node),
    "-",
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

/* ---------- .inspace 容器导入导出 ----------
   导出成标准 zip：画布包解压是一个画布目录，分组件包解压是一个子分组。
   导出会打开系统保存框，导入会打开系统打开框；重名由后端自动加后缀，不覆盖。 */

async function exportTreeSpace(node, group) {
  try {
    if (!group && current?.meta.id === node.id) {
      if (editingId || edgeLabelEditor) commitEditing();
      await flushBlockContents();
      await flushItems();
      await flushCamera();
    }
    await store.exportSpace(node.id, group);
  } catch (error) {
    showError(error);
  }
}

async function importIntoGroup(parent) {
  try {
    if (current) {
      if (editingId || edgeLabelEditor) commitEditing();
      await flushBlockContents();
      await flushItems();
      await flushCamera();
    }
    const result = await store.importSpace(parent);
    if (!result) return;
    const reveal = (id) => {
      let prefix = id;
      while (prefix) {
        treeCollapsed.delete(prefix);
        const cut = prefix.lastIndexOf("/");
        if (cut < 0) break;
        prefix = prefix.slice(0, cut);
      }
    };
    reveal(parent || "");
    if (result.kind === "canvas") {
      await loadList();
      await switchTo(result.id);
    } else {
      reveal(result.id);
      await loadList();
    }
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

export async function renameTreeGroup(id, name) {
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
export function toolMenuEntries() {
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
        { label: "参考图编辑", onClick: () => armAndInsertGen("edit") },
        { label: "图片局部重绘", onClick: () => armAndInsertGen("inpaint") },
        { label: "图片高清放大", onClick: () => armAndInsertGen("upscale") },
      ],
    },
    {
      label: "AI 视频",
      onClick: () => {
        dropTool();
        insertVideoPanel();
      },
    },
    {
      label: "3D 场景",
      onClick: () => {
        dropTool();
        insertSceneBlock();
      },
    },
  ];
}

/* 用户自己建 3D 场景：起手就是一间能用的客厅（地板/背景墙/侧墙/窗/地毯/边柜 + 白天光） */
function insertSceneBlock() {
  if (!current) return;
  const at = insertPoint(SCENE_DEFAULT_WIDTH, SCENE_DEFAULT_HEIGHT);
  const item = makeScene(at.x, at.y);
  /* 默认就一个空间 + 一块地板：墙/窗要的话自己加（或让 agent 铺房间壳） */
  const got = normalizeSceneParts([
    { op: "box", x: 0, y: 0, z: 0, w: 620, d: 520, h: 2, color: "#b98a5e", name: "地板" },
  ]);
  item.parts = got.parts;
  item.surfaces = sceneSurfacesOf([
    { id: "floor", name: "地面", kind: "floor", x: 0, y: 0, z: 2, w: 608, h: 508 },
  ]);
  item.light = sceneLightOf("day");
  placeBlock(item);
  persistScene(item);
  select(item.id);
  agentRevealBlock(item.id);
  scheduleItemsSave();
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
  setMarqueeCursor();
}

/* Ctrl 按住 = 框选：光标换成十字，拖出矩形松手把相交的块加进选择。
   输入框里的 Ctrl（选字/复制）不归它管，按下走原有输入逻辑。 */
let ctrlHeld = false;
let marqueeEl = null;

function setMarqueeCursor() {
  if (!ui?.stage) return;
  ui.stage.classList.toggle("is-marquee-ready", ctrlHeld && tool === "select");
}

function beginMarquee(event, clickId) {
  const box = document.createElement("div");
  box.className = "canvas-marquee";
  box.hidden = true;
  document.body.append(box);
  marqueeEl = box;
  return {
    kind: "marquee",
    startClient: { x: event.clientX, y: event.clientY },
    clickId,
    moved: false,
  };
}

function updateMarquee(dragState, clientX, clientY) {
  if (!marqueeEl) return;
  const left = Math.min(dragState.startClient.x, clientX);
  const top = Math.min(dragState.startClient.y, clientY);
  const width = Math.abs(clientX - dragState.startClient.x);
  const height = Math.abs(clientY - dragState.startClient.y);
  marqueeEl.hidden = false;
  marqueeEl.style.left = `${left}px`;
  marqueeEl.style.top = `${top}px`;
  marqueeEl.style.width = `${width}px`;
  marqueeEl.style.height = `${height}px`;
  dragState.rect = { left, top, right: left + width, bottom: top + height };
}

function finishMarquee(dragState) {
  marqueeEl?.remove();
  marqueeEl = null;
  if (!dragState.moved) {
    /* 没拖动就是一次 Ctrl+点击：点到块加选，点空白清空 */
    if (dragState.clickId && findItem(dragState.clickId)) select(dragState.clickId, true);
    else select(null);
    return;
  }
  const rect = dragState.rect;
  if (!rect || !current) return;
  const hits = [];
  for (const item of current.items) {
    if (item.type === "connector") continue;
    const el = itemEls.get(item.id);
    if (!el) continue;
    const box = el.getBoundingClientRect();
    if (box.right < rect.left || box.left > rect.right || box.bottom < rect.top || box.top > rect.bottom) {
      continue;
    }
    hits.push(item.id);
  }
  for (const id of hits) select(id, true);
}

/* 画图工具是一次性的：这一按（或这一次操作）没能真的起画，就把选中态交回第一个按钮，
   别让蓝点卡在「文字」上。保留当前选中的块，退工具不该顺手把人选的清空。 */
export function dropTool() {
  if (tool !== "select") setTool("select", true);
}

export function applyCamera() {
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

export function clientToWorld(clientX, clientY) {
  const rect = ui.stage.getBoundingClientRect();
  const camera = current.camera;
  return {
    x: (clientX - rect.left - camera.x) / camera.scale,
    y: (clientY - rect.top - camera.y) / camera.scale,
  };
}

export function worldToStage(x, y) {
  const camera = current.camera;
  return { x: camera.x + x * camera.scale, y: camera.y + y * camera.scale };
}

/* ---------- 渲染 ---------- */

export function findItem(id) {
  return current?.items.find((item) => item.id === id) || null;
}

export function boundsOfItem(id) {
  const item = findItem(id);
  if (!item) return null;
  const el = itemEls.get(id);
  if (!el) return null;
  return itemBounds(item, el);
}

export function syncConnector(item) {
  const el = itemEls.get(item.id);
  if (!el) return;
  syncConnectorElement(el, item, connectorGeometry(item, boundsOfItem));
}

/* 连线本身没有坐标，块一动就得重算一遍 */
export function refreshConnectors() {
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

export function addItemElement(item) {
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
  if (item.type === "genvideo") attachVideoPanel(el, item);
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

export function renderAll() {
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
export function select(id, add = false) {
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

export function syncSelectedClasses() {
  for (const [itemId, el] of itemEls) {
    el.classList.toggle("is-selected", selectedIds.has(itemId));
  }
}

/* 画布上选中的块如果藏在折叠的容器里，把容器逐级展开，让人在树里看得见选中行 */
function revealSelectionInTree() {
  const body = treeUi?.body;
  if (!body || !current) return;
  let changed = false;
  for (const id of selectedIds) {
    const item = findItem(id);
    if (!item || item.type === "connector") continue;
    let ownerId = item.containerId;
    let guard = 0;
    while (ownerId && guard < 8) {
      if (treePanelCollapsed.has(ownerId)) {
        treePanelCollapsed.delete(ownerId);
        changed = true;
      }
      const owner = findItem(ownerId);
      ownerId = owner?.containerId || "";
      guard += 1;
    }
  }
  if (changed) {
    treeSavePrefs();
    renderTree();
  }
}

/* ---------- 3D 场景工具条 ----------
   选中恰好一个场景块时，画布底部浮一条：环境 / 灯光 / 机位 / 内容 / 输出。
   所有控件都改块上的现有字段（groundColor / parts / surfaces / light / camera），
   agent 的 block_update 改的也是同一份，两边即时互通。 */
const SCENE_TOOL_LABELS = [
  ["environment", "环境"],
  ["light", "灯光"],
  ["camera", "机位"],
  ["content", "内容"],
  ["export", "输出"],
];
const GROUND_COLORS = [
  { value: "", title: "默认灰" },
  { value: "#f2efe9", title: "白" },
  { value: "#cfc4b0", title: "浅米" },
  { value: "#9a917d", title: "暖灰" },
  { value: "#4a4a48", title: "深灰" },
];
const LIGHT_LIT_COLORS = [
  { value: "#fff4e2", title: "暖白" },
  { value: "#ffc07a", title: "暖橙" },
  { value: "#ffffff", title: "纯白" },
];
const LIGHT_DARK_COLORS = [
  { value: "#dbe7f2", title: "冷灰蓝" },
  { value: "#71809a", title: "蓝灰" },
  { value: "#5b6781", title: "深蓝" },
];
let sceneToolbar = null;
let scenePop = null;
let scenePopKind = "";

function soloSceneItem() {
  if (selectedIds.size !== 1) return null;
  const item = findItem([...selectedIds][0]);
  return item && item.type === "scene" ? item : null;
}

function installSceneToolbar() {
  const main = document.querySelector(".canvas-main");
  if (!main || sceneToolbar) return;
  sceneToolbar = document.createElement("div");
  sceneToolbar.className = "scene-toolbar";
  sceneToolbar.hidden = true;
  scenePop = document.createElement("div");
  scenePop.className = "scene-pop";
  scenePop.hidden = true;
  main.append(sceneToolbar, scenePop);
  sceneToolbar.addEventListener("click", (event) => {
    const btn = event.target.closest?.("[data-scene-tool]");
    if (!btn || btn.disabled) return;
    handleSceneTool(btn.dataset.sceneTool);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!scenePop || scenePop.hidden) return;
      if (scenePop.contains(event.target) || sceneToolbar.contains(event.target)) return;
      /* 点取色盘浮层不算点了外面，不然一按颜色区整个面板就被关了 */
      if (event.target.closest?.(".color-pop")) return;
      closeScenePop();
    },
    true,
  );
}

function closeScenePop() {
  scenePopKind = "";
  closeColorPicker(false);
  if (scenePop) scenePop.hidden = true;
  for (const btn of sceneToolbar?.querySelectorAll(".scene-tool-btn") || []) {
    btn.classList.remove("is-open");
  }
}

function openScenePop(item, kind) {
  scenePopKind = kind;
  scenePop.hidden = false;
  for (const btn of sceneToolbar.querySelectorAll(".scene-tool-btn")) {
    btn.classList.toggle("is-open", btn.dataset.sceneTool === kind);
  }
  renderScenePop(item, kind);
}

function sceneLightPatch(item, patch, options = {}) {
  const base = lightOrDay(item);
  const got = normalizeLight({ ...base, ...patch });
  if (got.light) scenePatch(item, { light: got.light }, options);
}

function lightOrDay(item) {
  const got = normalizeLight(item.light || SCENE_LIGHT_PRESETS.day);
  return got.light || normalizeLight(SCENE_LIGHT_PRESETS.day).light;
}

export function scenePatch(item, patch, options = {}) {
  if (item.locked) {
    showError("场景已锁定，先解锁再改");
    return;
  }
  Object.assign(item, patch);
  persistScene(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  if (options.quiet) return;
  if (scenePopKind && scenePop && !scenePop.hidden) renderScenePop(item, scenePopKind);
  else refreshSceneToolbar();
}

/* ---------- 场景元素（选中单件/整组）操作 ---------- */

function moveSceneElement(item, indices, axis, target) {
  const first = item.parts[indices[0]];
  if (!first) return;
  const delta = target - first[axis];
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) return;
  const parts = item.parts.map((part, k) =>
    indices.includes(k) ? { ...part, [axis]: part[axis] + delta } : part,
  );
  scenePatch(item, { parts }, { quiet: true });
}

function resizeSceneElement(item, indices, axis, value) {
  if (indices.length !== 1) return;
  const size = Math.max(0, Math.round(value));
  const parts = item.parts.map((part, k) => (k === indices[0] ? { ...part, [axis]: size } : part));
  scenePatch(item, { parts }, { quiet: true });
}

function rotateSceneElement(item, indices, value) {
  if (indices.length !== 1) return;
  const rotate = ((Math.round(value) % 360) + 360) % 360;
  const parts = item.parts.map((part, k) => (k === indices[0] ? { ...part, rotate } : part));
  scenePatch(item, { parts }, { quiet: true });
}

function paintSceneElement(item, indices, color) {
  const parts = item.parts.map((part, k) =>
    indices.includes(k) && part.op !== "model" ? { ...part, color } : part,
  );
  scenePatch(item, { parts });
}

/* 给程序几何件贴图（画布 images/ 里的相对路径）；tex 空串回纯色 */
function paintSceneTexture(item, indices, tex) {
  const parts = item.parts.map((part, k) =>
    indices.includes(k) && part.op !== "model"
      ? { ...part, tex: tex || "", texRepeat: part.texRepeat || 100 }
      : part,
  );
  scenePatch(item, { parts });
}

function duplicateSceneElement(item, indices) {
  const part = item.parts[indices[0]];
  if (!part) return;
  const copy = { ...part, group: newId(), x: part.x + 20, y: part.y + 20 };
  const got = normalizeSceneParts([...item.parts, copy]);
  if (got.dropped.length) {
    showError(got.dropped[0].why);
    return;
  }
  scenePatch(item, { parts: got.parts });
  setSceneFurnitureSelection(sceneView(item), [item.parts.length - 1]);
  showToast("已复制这件");
}

function deleteSceneElement(item, indices) {
  const parts = item.parts.filter((_, k) => !indices.includes(k));
  scenePatch(item, { parts });
  setSceneFurnitureSelection(sceneView(item), []);
  showToast("已删除");
}

/* 元素弹层：位置 / 尺寸 / 旋转 / 颜色 */
function renderElementPop(item, kind) {
  const indices = sceneSelectedIndices(item);
  const part = indices.length ? item.parts[indices[0]] : null;
  const hint = (text) => {
    const div = document.createElement("div");
    div.className = "scene-pop-row";
    div.textContent = text;
    scenePop.append(div);
  };
  if (!part) {
    hint("先在场景里点一下要编辑的元素");
    return;
  }
  if (kind === "position") {
    scenePopNumber("X", part.x, 1, (value) => moveSceneElement(item, indices, "x", value));
    scenePopNumber("Y", part.y, 1, (value) => moveSceneElement(item, indices, "y", value));
    scenePopNumber("离地", part.z, 1, (value) => moveSceneElement(item, indices, "z", value));
    hint(indices.length > 1 ? `整组 ${indices.length} 件一起移动 · 单位 cm` : "单位 cm");
  } else if (kind === "size") {
    scenePopNumber("宽", part.w || 0, 1, (value) => resizeSceneElement(item, indices, "w", value));
    scenePopNumber("深", part.d || 0, 1, (value) => resizeSceneElement(item, indices, "d", value));
    scenePopNumber("高", part.h || 0, 1, (value) => resizeSceneElement(item, indices, "h", value));
    hint(part.op === "model" ? "模型件填 0 = 按模型自带尺寸" : "单位 cm");
  } else if (kind === "rotate") {
    scenePopSlider("方向", part.rotate || 0, 0, 360, 1, (value) => rotateSceneElement(item, indices, value));
  } else if (kind === "color") {
    if (indices.some((k) => item.parts[k]?.op === "model")) {
      hint("模型件带自己的贴图，不支持整体换色");
      return;
    }
    scenePopRow(
      "颜色",
      scenePopDots(FURNITURE_COLORS, part.color || "", (value) => paintSceneElement(item, indices, value)),
    );
    /* 贴图：从画布上的图片块里挑一张贴上去（相对路径存 scenes 文件，跟画布一起搬） */
    if (part.tex) {
      scenePopActions([{ label: "清除贴图", onClick: () => paintSceneTexture(item, indices, "") }]);
    }
    const images = (current?.items || []).filter(
      (one) => (one.type === "image" || one.type === "gen") && one.src,
    );
    if (!images.length) {
      hint("画布上没有图片块，贴不了图");
      return;
    }
    hint("贴图（点一张贴上）");
    scenePopActions(
      images.slice(0, 12).map((one) => ({
        label: `#${one.seq} ${one.type === "gen" ? "生图" : "图片"}`,
        active: one.src === part.tex,
        onClick: () => paintSceneTexture(item, indices, one.src),
      })),
      { perRow: 3 },
    );
  }
}

function useCurrentSceneCamera(item) {
  const view = sceneView(item);
  const camera = normalizeSceneCamera(sceneCameraState(item, view));
  if (!camera) {
    showError("场景还没渲染出来，等它显示出来再试");
    return;
  }
  scenePatch(item, { camera });
  showToast("已记住当前视角");
}

/* ---------- 场景弹层公共控件 ---------- */
function scenePopRow(label, ...children) {
  const div = document.createElement("div");
  div.className = "scene-pop-row";
  const name = document.createElement("span");
  name.textContent = label;
  div.append(name, ...children);
  scenePop.append(div);
  return div;
}

function scenePopDots(colors, current, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "scene-pop-dots";
  for (const entry of colors) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "scene-dot";
    if (entry.value) dot.style.setProperty("--c", entry.value);
    else dot.classList.add("is-default");
    if (entry.title) dot.title = entry.title;
    if ((current || "") === (entry.value || "")) dot.classList.add("is-active");
    dot.addEventListener("click", () => onPick(entry.value));
    wrap.append(dot);
  }
  /* 更多色：直接弹全局取色盘（常用色 + SV 方块 + 色相条），点「确定」才生效 */
  const more = document.createElement("button");
  more.type = "button";
  more.className = "scene-dot is-more";
  more.title = "更多颜色…";
  if (current && !colors.some((entry) => (entry.value || "") === (current || ""))) {
    more.style.setProperty("--c", current);
    more.classList.add("is-custom", "is-active");
  }
  more.addEventListener("click", () => {
    const rect = more.getBoundingClientRect();
    openColorPicker({
      x: rect.left - 150,
      y: rect.bottom + 6,
      value: current || "#b98a5e",
      seed: "#b98a5e",
      presets: SCENE_MORE_COLORS,
      withButtons: true,
      dismissCommits: false,
      onDone: (hex) => {
        if (hex) onPick(hex);
      },
    });
  });
  wrap.append(more);
  return wrap;
}

function scenePopActions(entries, options = {}) {
  const perRow = Math.max(0, Math.floor(Number(options.perRow) || 0));
  const rows = [];
  if (perRow > 0) {
    for (let i = 0; i < entries.length; i += perRow) rows.push(entries.slice(i, i + perRow));
  } else {
    rows.push(entries);
  }
  let first = null;
  for (const row of rows) {
    const wrap = document.createElement("div");
    wrap.className = "scene-pop-actions";
    for (const entry of row) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `plain-btn${entry.active ? " is-active" : ""}`;
      btn.textContent = entry.label;
      btn.addEventListener("click", entry.onClick);
      wrap.append(btn);
    }
    scenePop.append(wrap);
    if (!first) first = wrap;
  }
  return first;
}

function scenePopSlider(label, value, min, max, step, onInput) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => onInput(Number(input.value)));
  scenePopRow(label, input);
}

/* 元素弹层里那种数字框：失焦/回车才提交，边打字不重建面板 */
function scenePopNumber(label, value, step, onCommit) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.value = String(Math.round(value));
  /* 边输入边生效（和滑杆一致）；空串/半截数字先不理，焦点留在框里 */
  input.addEventListener("input", () => {
    const raw = input.value.trim();
    if (!raw || raw === "-" || raw === "." || raw === "-.") return;
    const next = Number(raw);
    if (Number.isFinite(next)) onCommit(next);
  });
  input.addEventListener("change", () => {
    const next = Number(input.value);
    if (Number.isFinite(next)) onCommit(next);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
  scenePopRow(label, input);
}

const ELEMENT_POP_KINDS = new Set(["position", "size", "rotate", "color"]);

function renderScenePop(item, kind) {
  scenePop.textContent = "";
  if (ELEMENT_POP_KINDS.has(kind)) {
    renderElementPop(item, kind);
    return;
  }
  if (kind === "environment") {
    /* 环境只放环境本身的参数；地板/墙这些构造物在元素工具里改 */
    scenePopRow("空间底色", scenePopDots(GROUND_COLORS, item.groundColor || "", (value) => scenePatch(item, { groundColor: value })));
    scenePopActions([
      {
        label: "阴影开",
        active: item.shadow !== false,
        onClick: () => scenePatch(item, { shadow: true }),
      },
      {
        label: "阴影关",
        active: item.shadow === false,
        onClick: () => scenePatch(item, { shadow: false }),
      },
    ]);
  } else if (kind === "light") {
    scenePopActions([
      { label: "白天", onClick: () => scenePatch(item, { light: sceneLightOf("day") }) },
      { label: "傍晚", onClick: () => scenePatch(item, { light: sceneLightOf("warm") }) },
      { label: "夜灯", onClick: () => scenePatch(item, { light: sceneLightOf("night") }) },
      { label: "无灯", onClick: () => scenePatch(item, { light: null }) },
    ]);
    const light = lightOrDay(item);
    /* 拖动中只落数据不重建面板，否则滑杆每动一下就被新 DOM 换掉、拖不动 */
    scenePopSlider("光方向", light.angle, 0, 360, 5, (value) => sceneLightPatch(item, { angle: value }, { quiet: true }));
    scenePopSlider("太阳高度", light.elev, 5, 85, 1, (value) => sceneLightPatch(item, { elev: value }, { quiet: true }));
    scenePopSlider("明暗对比", Math.round(light.k * 100), 20, 100, 1, (value) => sceneLightPatch(item, { k: value / 100 }, { quiet: true }));
    scenePopRow("亮部色", scenePopDots(LIGHT_LIT_COLORS, light.lit, (value) => sceneLightPatch(item, { lit: value })));
    scenePopRow("暗部色", scenePopDots(LIGHT_DARK_COLORS, light.dark, (value) => sceneLightPatch(item, { dark: value })));
  } else if (kind === "camera") {
    scenePopActions([
      { label: "自动", onClick: () => setSceneCameraPreset(item, "auto") },
      { label: "正面", onClick: () => setSceneCameraPreset(item, "front") },
      { label: "左角", onClick: () => setSceneCameraPreset(item, "left") },
      { label: "右角", onClick: () => setSceneCameraPreset(item, "right") },
      { label: "俯视", onClick: () => setSceneCameraPreset(item, "top") },
    ]);
    scenePopActions([
      { label: "用当前视角", onClick: () => useCurrentSceneCamera(item) },
      { label: "重置", onClick: () => scenePatch(item, { camera: null }) },
    ]);
    const hint = document.createElement("div");
    hint.className = "scene-pop-row";
    hint.textContent = "Ctrl 拖动转视角 · Shift 拖动平移";
    scenePop.append(hint);
  } else if (kind === "content") {
    scenePopActions([
      { label: "编辑元素", onClick: () => { closeScenePop(); setScenePlacementMode(item, true); } },
      { label: "模型库添加", onClick: () => { closeScenePop(); void addSceneModelFlow(item); } },
      { label: "新建模型", onClick: () => { closeScenePop(); void createFurnitureFlow(item); } },
      { label: "添加地板", onClick: () => { closeScenePop(); addSceneFloor(item); } },
    ], { perRow: 3 });
  } else if (kind === "export") {
    scenePopActions([
      { label: "导出为 GLB", onClick: () => { closeScenePop(); void exportSceneFlow(item); } },
      { label: "落图", onClick: () => { closeScenePop(); void dropRegionImage(item.id); } },
    ]);
  }
}

/* ---------- 场景取色盘（更多色） ---------- */
const SCENE_MORE_COLORS = [
  "#ffffff", "#f2efe9", "#e8e4dc", "#d9d2c6", "#c9b9a6", "#b7b0a4", "#9a917d", "#6f6a62", "#4a4a48",
  "#2c2c2c", "#d2b48c", "#b98a5e", "#8a6f55", "#6b5138", "#a0522d", "#8b4513", "#c0703c", "#e0c088",
  "#e7b8a8", "#d9a7a0", "#b7c4b1", "#8fa58a", "#6e8b73", "#5c7c89", "#8f9bb3", "#b7a8c4", "#d9c27e",
];
/* 选中/锁/字段变化后重排工具条：只在选中恰好一个场景块时出现 */
/* 元素态：工具条换成「选中那件东西」的工具 */
const ELEMENT_TOOL_BUTTONS = [
  ["position", "位置", { edit: true }],
  ["size", "尺寸", { edit: true, single: true }],
  ["rotate", "旋转", { edit: true, single: true }],
  ["color", "颜色", { edit: true }],
  ["copy", "复制", { edit: true, action: true }],
  ["delete", "删除", { edit: true, action: true }],
  ["back", "返回场景", {}],
];

function sceneSelectedIndices(item) {
  const selection = sceneView(item)?.__sceneSelection;
  return Array.isArray(selection?.indices)
    ? selection.indices.filter((index) => Number.isInteger(index) && index >= 0)
    : [];
}

function buildSceneToolButtons(item, elementMode, indices) {
  sceneToolbar.textContent = "";
  const locked = Boolean(item.locked);
  const hasSel = indices.length > 0;
  if (elementMode) {
    for (const [kind, label, opts = {}] of ELEMENT_TOOL_BUTTONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scene-tool-btn";
      btn.dataset.sceneTool = kind;
      btn.textContent = label;
      if (opts.edit) btn.disabled = locked || !hasSel;
      if (opts.single && indices.length !== 1) btn.disabled = true;
      sceneToolbar.append(btn);
    }
    return;
  }
  for (const [kind, label] of SCENE_TOOL_LABELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scene-tool-btn";
    btn.dataset.sceneTool = kind;
    btn.textContent = label;
    if (["environment", "light", "content"].includes(kind) && locked) btn.disabled = true;
    sceneToolbar.append(btn);
  }
}

function handleSceneTool(kind) {
  const item = soloSceneItem();
  if (!item) return;
  const elementMode = scenePlacementActive(item);
  const indices = elementMode ? sceneSelectedIndices(item) : [];
  if (kind === "back") {
    closeScenePop();
    setScenePlacementMode(item, false);
    refreshSceneToolbar();
    return;
  }
  if (kind === "copy") {
    if (indices.length) duplicateSceneElement(item, indices);
    return;
  }
  if (kind === "delete") {
    if (indices.length) deleteSceneElement(item, indices);
    return;
  }
  if (item.locked) {
    showError("场景已锁定，先解锁再改");
    return;
  }
  if (scenePopKind === kind && !scenePop.hidden) {
    closeScenePop();
    return;
  }
  openScenePop(item, kind);
}

/* 场景元素在树里显示的名字：有名用名，没名按类型 */
function scenePartBaseLabel(part) {
  if (part.name) return part.name;
  if (part.op === "model") return String(part.src || "").replace(/\.glb$/i, "") || "模型";
  if (part.op === "solid") {
    return { cylinder: "圆柱", sphere: "球体", cone: "圆锥", torus: "圆环", capsule: "胶囊" }[part.shape] || "形体";
  }
  if (part.op === "poly") return "棱柱";
  if (part.op === "roof") return "屋顶";
  return "方块";
}

/* 树里点场景的一件：进元素模式并选中它 */
function enterScenePart(scene, index) {
  if (scene.locked) {
    showError("场景已锁定，先解锁再改");
    return;
  }
  if (!scenePlacementActive(scene)) setScenePlacementMode(scene, true);
  select(scene.id);
  agentRevealBlock(scene.id);
  setSceneFurnitureSelection(sceneView(scene), [index]);
  agentHighlight([scene.id], 1000);
  renderTree();
}

let sceneToolbarSignature = "";

export function refreshSceneToolbar() {
  if (!sceneToolbar) installSceneToolbar();
  if (!sceneToolbar) return;
  const item = soloSceneItem();
  sceneToolbar.hidden = !item;
  if (!item) {
    if (sceneToolbarSignature) closeScenePop();
    sceneToolbarSignature = "";
    return;
  }
  const elementMode = scenePlacementActive(item);
  const indices = elementMode ? sceneSelectedIndices(item) : [];
  const signature = `${item.id}|${elementMode}|${item.locked ? 1 : 0}|${indices.join(",")}`;
  if (signature !== sceneToolbarSignature) {
    sceneToolbarSignature = signature;
    closeScenePop();
    buildSceneToolButtons(item, elementMode, indices);
  }
}

/* 场景里选中/取消选中元素：工具条跟着换 */
onSceneFurnitureSelection(() => {
  refreshSceneToolbar();
  /* 树里的场景子行也要跟选中高亮走 */
  if (current) renderTree();
});

/* 标题栏：当前画布路径；单选面板时跟上 #N 名称（没自定义名就是类型） */
function refreshTitlebarPath() {
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
function syncTreeSelection() {
  const body = treeUi?.body;
  if (!body) return;
  revealSelectionInTree();
  for (const row of body.querySelectorAll('.space-tree-row[data-kind="panel"]')) {
    row.classList.toggle("is-selected", selectedIds.has(row.dataset.id));
  }
}

/* 只选了一个时才有的「那一个」；多选时返回 null，缩放和端口这些单块操作照旧不出现 */
function loneSelected() {
  return selectedIds.size === 1 ? [...selectedIds][0] : null;
}

/* 锁定的块在左下角信息条的 #N 前面挂一枚小锁；非锁定不挂 */
const LOCK_BADGE_SVG = `<svg class="canvas-metrics-lock" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="5.3" width="7.4" height="5.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.1 5.3V4a1.9 1.9 0 0 1 3.8 0v1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

/* 左下角信息条：选中谁就报谁的编号；(X, Y) 和 [W, H] 点一下才展开，再点收起。
   多选取整组的外接框，收起时只报块数。连线没有自己的位置，单独选中它时这条不出现。 */
let metricsOpen = false;
let metricsSignature = "";

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
  /* 换了一批选中就回到收起态；拖动同一批时展开状态保持 */
  const signature = [...selectedIds].sort().join("|");
  if (signature !== metricsSignature) {
    metricsSignature = signature;
    metricsOpen = false;
  }
  const count = selectedIds.size > 1 ? ` · ${selectedIds.size} 块` : "";
  const single = selectedIds.size === 1 ? findItem([...selectedIds][0]) : null;
  const lock = single?.locked ? LOCK_BADGE_SVG : "";
  const seq = single && single.type !== "connector" && single.seq ? `#${single.seq}` : "";
  const pos = `(${Math.round(left)}, ${Math.round(top)})`;
  const size = `[${Math.round(right - left)}, ${Math.round(bottom - top)}]`;
  if (!metricsOpen) {
    ui.metrics.innerHTML = `${lock}${seq || (single ? size : `${selectedIds.size} 块`)}`;
    return;
  }
  ui.metrics.innerHTML = `${lock}${seq ? `${seq} · ` : ""}${pos} ${size}${count}`;
}

export function updateSelection() {
  if (!ui) return;
  syncTreeSelection();
  refreshTitlebarPath();
  refreshSceneToolbar();
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

/* 命中优先级：块层压在连线层上面，容器矩形的填充会把框里的线盖住，
   点线永远落在容器上。命中容器时再翻一遍命中栈找底下的连线，有就按命中线算。 */
function stageTargetAt(e) {
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
  /* 左下角信息条自己处理点击（展开/收起），别当成点空白清选择 */
  if (e.target.closest?.("#canvas-metrics")) {
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
    drag = beginMarquee(e, target?.dataset.id || null);
    return;
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
    for (const child of moveMembers(container, seen)) push(child.id);
  }
  return group;
}

/* ---------- 分组容器 ----------
   矩形可以当「框」用。成员不单独存名字，按几何现算：整个块完全落在框里的才算成员。
   好处是拖出去就自动脱组、拖进来就自动入组，不用维护一份迟早会过期的名单。 */
export function isContainer(item) {
  return item.type === "rect" && item.container === true;
}

/* 框里装着的块。exclude 是已经算进去的（多选时别重复带上）。
   includeLocked 给复制用：锁定的子块也算容器的一部分，粘出去再统一解锁。 */
function containedBlocks(container, exclude = new Set(), includeLocked = false) {
  const el = itemEls.get(container.id);
  if (!el || !current) return [];
  const box = itemBounds(container, el);
  const out = [];
  for (const item of current.items) {
    if (item.id === container.id || item.type === "connector") continue;
    if (!includeLocked && item.locked) continue;
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

/* ---------- 容器成员归属 ----------
   重叠的两个框里几何判定分不清谁是谁，拖动时就会互相吸走子块。
   block.containerId 记住每块归哪个容器：粘贴容器时新容器立刻认领自己的子块，
   拖动后只重算动过的块，没主的老数据开画布时按容器顺序先到先得。 */
export function containerBoxOf(container) {
  const el = itemEls.get(container.id);
  if (!el) return null;
  return itemBounds(container, el);
}

export function insideBox(item, box) {
  const el = itemEls.get(item.id);
  if (!el) return false;
  const b = itemBounds(item, el);
  return (
    b.x >= box.x - 1 &&
    b.y >= box.y - 1 &&
    b.x + b.w <= box.x + box.w + 1 &&
    b.y + b.h <= box.y + box.h + 1
  );
}

/* 开画布：有主的、容器还在且仍框着它就算数；没主的按容器顺序先到先得 */
function rebuildContainerOwners() {
  if (!current) return;
  const containers = current.items.filter((item) => isContainer(item));
  for (const item of current.items) {
    if (item.type === "connector" || !item.containerId) continue;
    const container = findItem(item.containerId);
    const box = container && container.id !== item.id ? containerBoxOf(container) : null;
    if (!box || !insideBox(item, box)) item.containerId = "";
  }
  for (const container of containers) {
    const box = containerBoxOf(container);
    if (!box) continue;
    for (const item of current.items) {
      if (item.id === container.id || item.type === "connector" || item.containerId) continue;
      if (insideBox(item, box)) item.containerId = container.id;
    }
  }
}

/* 拖完重算：还在原容器里就保持，换了框就换主，拖出去就脱组 */
function reassignContainerOwners(items) {
  if (!current) return;
  const containers = current.items.filter((item) => isContainer(item));
  for (const item of items) {
    if (!item || item.type === "connector") continue;
    const owner = item.containerId;
    if (owner) {
      const container = findItem(owner);
      const box = container && container.id !== item.id ? containerBoxOf(container) : null;
      if (box && insideBox(item, box)) continue;
      item.containerId = "";
    }
    const host = containers.find((container) => {
      if (container.id === item.id) return false;
      const box = containerBoxOf(container);
      return box ? insideBox(item, box) : false;
    });
    if (host) item.containerId = host.id;
  }
}

/* 这块归不归 container 管：没主或认的就是它；认了别的容器、但那个容器
   本身就在这个框里（嵌套）时算它管。拖动和树里的展开用同一套判定。 */
function ownedByContainer(item, container, box) {
  const owner = item.containerId;
  if (!owner || owner === container.id) return true;
  const ownerItem = findItem(owner);
  return !ownerItem || insideBox(ownerItem, box);
}

/* 容器自己认的成员（几何在框里 + 归属不是别的容器）。拖动、复制、删除都用它；
   includeLocked 给复制/删除用：锁定的子块也带着走。 */
export function ownedMembers(container, exclude = new Set(), includeLocked = false) {
  const box = containerBoxOf(container);
  if (!box) return [];
  const out = [];
  for (const item of current.items) {
    if (item.id === container.id || item.type === "connector") continue;
    if (!includeLocked && item.locked) continue;
    if (exclude.has(item.id)) continue;
    if (!insideBox(item, box)) continue;
    if (!ownedByContainer(item, container, box)) continue;
    out.push(item);
  }
  return out;
}

/* 拖容器时跟走的成员：框里的块、且它认这个容器；认了别的容器、而那个容器
   不在这个框里的就不跟——重叠的两个容器各带走各的子块，互不串门。 */
function moveMembers(container, exclude = new Set()) {
  return ownedMembers(container, exclude, false);
}

/* 右键「编为容器 / 取消容器」 */
export function toggleContainer(item) {
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
    for (const kid of kids) {
      if (!kid.containerId) kid.containerId = item.id;
    }
    applyContainerClass(item);
    scheduleItemsSave();
    showToast(`已编为容器：框里 ${kids.length} 块会跟着它走`);
    return;
  }
  delete item.container;
  for (const it of current.items) {
    if (it.containerId === item.id) it.containerId = "";
  }
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
  if (drag.kind === "marquee") {
    const dx = e.clientX - drag.startClient.x;
    const dy = e.clientY - drag.startClient.y;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    updateMarquee(drag, e.clientX, e.clientY);
    return;
  }

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
  /* 生图面板拉过高度：记住这是手动尺寸，提示词超出时在框里滚，不再自动长高。
     这个标记要跟着块存进画布文件——只放 dataset 的话重开画布就丢，面板又会被撑高 */
  if (item.type === "gen") {
    el.dataset.userResized = "1";
    item.manualSize = true;
    fitGenPrompt(item.id, el.querySelector(".canvas-gen-prompt"), false);
  }
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

  if (finished.kind === "marquee") {
    finishMarquee(finished);
    return;
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
  /* 拖完重算这几块的容器归属：拖出就脱组、拖进就入组，重叠区各认各的 */
  if (finished.kind === "move" && finished.group) {
    reassignContainerOwners(finished.group.map((member) => member.item));
  } else if (finished.kind === "resize") {
    reassignContainerOwners([item]);
  }
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

function onStageDoubleClick(e) {
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

export function openImageExternally(item) {
  const canvasId = current?.meta?.id;
  if (!canvasId) return Promise.resolve();
  /* 块上的路径可能还没落盘（生图刚出完那一下），先把这笔存下去，后端才认得 */
  return flushItems().then(() => store.openCanvasImage(canvasId, item.id));
}

function onStageContextMenu(e) {
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

export function commitEditing() {
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
export let noteTimers = new Map();
export let pictureTimers = new Map();
export let sceneTimers = new Map();
export let genTimers = new Map();
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

export function persistNote(item) {
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
export function persistPicture(item) {
  if (!current || item.type !== "picture") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(pictureTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writePicture(canvasId, item.id, target.cmds || [], target.symbols || {}).catch(showError);
  });
}

/* 场景块里的东西只认 scenes/<块id>.json 那一份：items.json 里没有 parts。 */
export function persistScene(item) {
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
export function persistGen(item) {
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
    model: item.model || "",
    strength: item.strength,
  };
}

/* 切画布、重命名、退出页面前把还没写完的正文补上，最后一次编辑不至于丢掉 */
export async function flushBlockContents() {
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
              item.steps = Math.min(GEN_STEPS_MAX, Math.max(0, file.steps));
              item.cfg = Math.min(GEN_CFG_MAX, Math.max(0, file.cfg));
              item.seed = Number.isFinite(file.seed) && file.seed >= -1 ? Math.trunc(file.seed) : -1;
              /* 老文件里没有这两个字段：按「看连线自己定」和上游默认改动幅度接上 */
              item.mode = GEN_MODES.includes(file.mode) ? file.mode : "auto";
              item.model = file.model === "qwen21" || file.model === "h3image" ? file.model : "";
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

export const GEN_PLACE_GAP = 24;

/* 这个路径还有谁指着（独立图片块、别的面板、画面块垫的位图都算一份）：
   回收旧图之前问一句，有人指着的就别动 */
export const srcInUse = (src) =>
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
export const genMaskBases = new Map(); // 块 id -> 取景窗里垫的底图地址
/* 块 id -> 涂抹模式开着没有：开着遮罩层才吃鼠标，关着就能拖面板 */
export const genMaskModes = new Map();
/* agent 临时递过来的遮罩（base64），只在下一张用一次 */
export const genRunMasks = new Map();
let maskPainting = null;

export function applyGenMaskMode(el, id, on) {
  genMaskModes.set(id, on);
  genMaskCanvasOf(el)?.classList.toggle("is-active", on);
}

export function genMaskCanvasOf(el) {
  return el?.querySelector(".canvas-gen-mask") || null;
}

export function resetGenMask(canvas) {
  canvas.width = GEN_MASK_SIZE;
  canvas.height = GEN_MASK_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, GEN_MASK_SIZE, GEN_MASK_SIZE);
}

export function attachGenMask(el, item) {
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
    if (!target) return;
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
export async function refreshGenMaskBase(item) {
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
/* 取景窗的地板（和 CSS .canvas-gen-stage 的 min-height 对齐）：
   面板再矮也要给图留这么高，提示词在它自己的框里滚。 */
const GEN_STAGE_MIN_HEIGHT = 160;

export function fitGenPrompt(itemId, prompt, grow = false) {
  const item = findItem(itemId);
  const el = itemEls.get(itemId);
  if (!item || !prompt || !el) return;
  /* 提示词框没显示（高清放大那档）：不参与量高，否则 0 和 56 的差会把块越撑越高 */
  if (prompt.hidden || prompt.offsetParent === null) return;
  const bar = el.querySelector(".canvas-gen-bar");
  /* 先压到 0 再读 scrollHeight：textarea 的 height:auto 只会退回 rows 行，
     不这么量出来的是三行的高度，长内容照样被裁 */
  prompt.style.height = "0px";
  const want = Math.max(56, prompt.scrollHeight);
  const other = bar ? bar.offsetHeight - prompt.offsetHeight : 0;
  const room = () => Math.max(56, item.h - GEN_STAGE_MIN_HEIGHT - other);
  /* 手动拉过高度之后就不再按提示词自动长高——用户缩矮时提示词滚动，图不缩没 */
  const manual = item.manualSize === true || el.dataset.userResized === "1";
  if (grow && !manual && want > room()) {
    item.h += want - room();
    syncItemElement(el, item);
    scheduleItemsSave();
  }
  const height = Math.min(want, room());
  prompt.style.height = `${height}px`;
  prompt.style.overflowY = want > height ? "auto" : "hidden";
}


/* ---------- 视频面板 ---------- */

function videoFeedOf(item) {
  return { count: genInputItems(item).length };
}

export function refreshVideoPanel(id) {
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el) return;
  syncVideoPanel(el, item, videoFeedOf(item));
}

/* 视频面板的常用档：时长按秒，尺寸按用户认得的 720p/1080p 命名，给的是真实像素 */
const VIDEO_SECONDS_PRESETS = [4, 5, 6, 8, 10, 12];
const VIDEO_SIZE_PRESETS = [
  { label: "720p 横屏 · 1280×720", w: 1280, h: 720 },
  { label: "1080p 横屏 · 1920×1080", w: 1920, h: 1080 },
  { label: "720p 竖屏 · 720×1280", w: 720, h: 1280 },
  { label: "1080p 竖屏 · 1080×1920", w: 1080, h: 1920 },
  { label: "1:1 方形 · 1024×1024", w: 1024, h: 1024 },
];

function attachVideoPanel(el, item) {
  const card = el.querySelector(".canvas-genvideo-card");
  if (!card) return;
  /* 输入框、下拉、按钮、播放器自己吃按下：其余地方留给拖整块 */
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("textarea, input, select, button, video")) e.stopPropagation();
  });
  const prompt = el.querySelector(".canvas-genvideo-prompt");
  prompt.addEventListener("input", () => {
    const target = findItem(item.id);
    if (!target) return;
    target.prompt = prompt.value.slice(0, GEN_TEXT_MAX);
    scheduleItemsSave();
  });
  prompt.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    runOrStopVideo(item.id);
  });
  el.querySelector(".canvas-genvideo-run").addEventListener("click", (e) => {
    e.stopPropagation();
    runOrStopVideo(item.id);
  });
  el.querySelector(".canvas-genvideo-place").addEventListener("click", (e) => {
    e.stopPropagation();
    void placeVideoBlock(item.id);
  });
  const controls = el.querySelector(".canvas-genvideo-controls");
  const applyField = (control) => {
    const target = findItem(item.id);
    if (!target) return;
    const value = Math.round(Number(control.value));
    if (!Number.isFinite(value) || value <= 0) return;
    if (control.dataset.videoField === "seconds") {
      target.seconds = Math.min(60, value);
    } else {
      const even = Math.min(4096, value - (value % 2));
      if (even < 64) return;
      target[control.dataset.videoField] = even;
    }
    scheduleItemsSave();
  };
  controls.addEventListener("input", (e) => {
    const control = e.target.closest?.("[data-video-field]");
    if (control) applyField(control);
  });
  controls.addEventListener("change", (e) => {
    const control = e.target.closest?.("[data-video-field]");
    if (!control) return;
    applyField(control);
    refreshVideoPanel(item.id);
  });
  controls.addEventListener("click", (e) => {
    const button = e.target.closest?.("[data-video-preset]");
    if (!button) return;
    e.stopPropagation();
    e.preventDefault();
    const target = findItem(item.id);
    if (!target) return;
    const kind = button.dataset.videoPreset;
    const entries =
      kind === "seconds"
        ? VIDEO_SECONDS_PRESETS.map((value) => ({
            label: `${value} 秒`,
            onClick: () => {
              const current = findItem(item.id);
              if (!current) return;
              current.seconds = value;
              scheduleItemsSave();
              refreshVideoPanel(current.id);
            },
          }))
        : VIDEO_SIZE_PRESETS.map((preset) => ({
            label: preset.label,
            onClick: () => {
              const current = findItem(item.id);
              if (!current) return;
              current.width = preset.w;
              current.height = preset.h;
              scheduleItemsSave();
              refreshVideoPanel(current.id);
            },
          }));
    const rect = button.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 6, entries, { kind: "video-preset" });
  });
  syncVideoPanel(el, item, videoFeedOf(item));
}

function insertVideoPanel() {
  if (!current) return;
  const at = insertPoint(320, 360);
  placeBlock(makeVideoGen(at.x, at.y));
}

function runOrStopVideo(id) {
  const item = findItem(id);
  if (!item || item.type !== "genvideo") return;
  const run = videoRunOf(id);
  if (run.phase === "running") {
    void stopVideo(id);
    return;
  }
  if (!(item.prompt || "").trim()) {
    showError("先写一句提示词");
    return;
  }
  patchVideoRun(id, {
    phase: "running",
    label: "提交中…",
    startedAt: Date.now(),
    path: "",
    seconds: 0,
    error: "",
    canceled: false,
  });
  refreshVideoPanel(id);
  void startVideoRun(item);
}

async function startVideoRun(item) {
  const id = item.id;
  try {
    const sources = genInputItems(item);
    /* 首帧一张就够：多张时按连线顺序取第一张 */
    const image = sources.length ? await genInputPng(sources[0]) : "";
    await store.genVideoStart({
      block: id,
      prompt: (item.prompt || "").trim(),
      image: image || undefined,
      seconds: item.seconds,
      width: item.width,
      height: item.height,
    });
  } catch (error) {
    patchVideoRun(id, {
      phase: "failed",
      error: String(error?.message || error || "视频生成失败"),
    });
    refreshVideoPanel(id);
  }
}

export async function stopVideo(id) {
  /* 点了就是不等了；后端那边只置标志位，平台任务照样跑完、费用照算 */
  patchVideoRun(id, { phase: "canceled" });
  refreshVideoPanel(id);
  await store.genVideoCancel(id).catch(() => {});
}

/* 出片在缓存里；落块把它拷进画布 video/，新块自己带一份，面板接着改词重出。 */
async function placeVideoBlock(id) {
  const item = findItem(id);
  if (!item || item.type !== "genvideo") return;
  const run = videoRunOf(id);
  if (!run.path || run.phase === "running") return;
  const canvasId = current?.meta.id;
  if (!canvasId) return;
  const name = "AI 视频.mp4";
  const rel = await copyIntoCanvas(canvasId, { path: run.path, name }, "video");
  if (!rel || !current || current.meta.id !== canvasId) return;
  const target = findItem(id);
  if (!target) return;
  placeBlock(makeVideo(target.x + target.w + GEN_PLACE_GAP, target.y, name, rel, false));
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
export const pictureEditors = new Map();

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
export function pictureMenuEntries(item) {
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
export async function exportPictureImage(id) {
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
export async function dropRegionImage(id) {
  if (!current || exporting) return null;
  const item = findItem(id);
  /* 矩形和 3D 场景都能落图：场景是 WebGL 画布，靠屏幕抓取拿到真实渲染帧 */
  if (!item || (item.type !== "rect" && item.type !== "scene")) return null;
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
  /* 场景离屏导不出 WebGL 画面：不在视野里就明说，别生成一张黑图 */
  if (!visible && item.type === "scene") {
    showToast("场景要先完整露在视野里才能落图");
    return null;
  }

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

export function refreshPictureChrome(id) {
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
export async function startNoteEdit(id) {
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

export function renderNoteBody(item, el) {
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
export let fileEditor = null; // { itemId, canvasId, item, el, box, preview, textarea, body, saving, closing, refreshed }
let fileAskId = null;

export function isFileEditable(item) {
  return item?.type === "file" && Boolean(item.text) && Boolean(item.src);
}

export async function startFileEdit(id) {
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

export async function closeFileEdit() {
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
export function flushFileEditor() {
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
export function refreshFileBlock(item) {
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

export async function hydrateNoteImages(item, el) {
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
  itemsTimer = setTimeout(flushItems, 500);
  /* 块的位置/尺寸/增减都会改鸟瞰窗里的方框，跟着重画一次 */
  refreshMinimap();
  /* 面板树跟着块增删/挪动/编容器刷新 */
  renderTree();
}

export async function flushItems() {
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

export function scheduleCameraSave() {
  if (!current) return;
  clearTimeout(cameraTimer);
  cameraTimer = setTimeout(flushCamera, 400);
}

export async function flushCamera() {
  clearTimeout(cameraTimer);
  cameraTimer = null;
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
  errorTimer = setTimeout(() => {
    ui.error.hidden = true;
  }, 4200);
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
  /* 调试用：直接设置选中的块 id 列表（不模拟鼠标），验证多选相关菜单用 */
  debugSelect: ({ ids } = {}) => {
    agentRequireSpace();
    const list = Array.isArray(ids) ? ids.filter((id) => findItem(id)) : [];
    selectedIds = new Set(list);
    updateSelection();
    return { selected: [...selectedIds] };
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
  debugDoubleClick: ({ selector, text = "", ctrl = false } = {}) => {
    const nodes = [...document.querySelectorAll(String(selector || ""))].filter(
      (node) => node.getBoundingClientRect().width > 0,
    );
    const el = text
      ? nodes.find((node) => (node.textContent || "").includes(String(text)))
      : nodes[0];
    if (!el) throw new Error("没找到要双击的元素");
    el.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        detail: 2,
        ctrlKey: Boolean(ctrl),
      }),
    );
    return {
      doubleClicked: true,
      ctrl: Boolean(ctrl),
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
  sceneAddModel: async (sceneId, name) => {
    const scene = agentRequireItem(sceneId);
    if (scene.type !== "scene") throw new Error("scene 要传场景块");
    const result = await addSceneModel(scene, String(name || "").trim());
    if (!result) throw new Error("模型没加进场景");
    return result;
  },
  sceneCreateFurniture: async (sceneId, spec = {}) => {
    const scene = agentRequireItem(sceneId);
    if (scene.type !== "scene") throw new Error("scene 要传场景块");
    const KIND = {
      cabinet: { w: 160, d: 45, h: 80, cabinet: true },
      table: { w: 140, d: 70, h: 75, cabinet: false },
      box: { w: 100, d: 100, h: 100, cabinet: false },
      cylinder: { w: 80, d: 80, h: 120, cabinet: false },
      sphere: { w: 100, d: 100, h: 100, cabinet: false },
      cone: { w: 100, d: 100, h: 120, cabinet: false },
      torus: { w: 100, d: 100, h: 30, cabinet: false },
      capsule: { w: 60, d: 60, h: 120, cabinet: false },
    };
    const kind = KIND[spec.kind] ? spec.kind : "cabinet";
    const preset = KIND[kind];
    const color = /^#[0-9a-fA-F]{6}$/.test(String(spec.color || "")) ? String(spec.color) : "#b98a5e";
    const built = {
      kind,
      w: Math.min(320, Math.max(40, Math.round(numOr(spec.w, preset.w)))),
      d: Math.min(120, Math.max(20, Math.round(numOr(spec.d, preset.d)))),
      h: Math.min(240, Math.max(20, Math.round(numOr(spec.h, preset.h)))),
      color,
      doors: preset.cabinet ? Math.min(4, Math.max(0, Math.round(numOr(spec.doors, 2)))) : 0,
      leg: preset.cabinet ? Math.min(15, Math.max(0, Math.round(numOr(spec.leg, 10)))) : 0,
      save: spec.save === true,
    };
    return applyFurniture(scene, built);
  },
  modelGenerate: async (spec = {}) => {
    const got = normalizeSceneParts(spec.parts || []);
    if (got.dropped.length) throw new Error(got.dropped[0].why);
    if (!got.parts.length) throw new Error("parts 是空的：至少给一件几何");
    if (got.parts.some((part) => part.op === "model")) {
      throw new Error("parts 里不能放 model 引用件；要用网格请写 mesh");
    }
    const buffer = await exportPartsGLB(got.parts);
    const base = String(spec.name || "模型").trim().slice(0, 60) || "模型";
    if (spec.out) {
      const path = await store.exportSaveFile(`${base}.glb`, bufferToBase64(buffer), spec.out);
      return { name: `${base}.glb`, path: path || "" };
    }
    const file = await store.modelLibrarySave(base, bufferToBase64(buffer));
    let placed = null;
    if (spec.scene) {
      const scene = agentRequireItem(spec.scene);
      if (scene.type !== "scene") throw new Error("scene 要传场景块");
      placed = await addSceneModel(scene, file.name);
    }
    return { name: file.name, placed };
  },
  sceneExportGlb: async (id, out) => {
    const item = agentRequireItem(id);
    if (item.type !== "scene") throw new Error("id 要传场景块");
    if (!out) throw new Error("out 要给保存的绝对路径（.glb），MCP 里弹不了文件框");
    const buffer = await exportSceneGLB(sceneView(item));
    const base = current?.meta.name || "场景";
    const name = `${base}${item.seq ? `-#${item.seq}` : ""}.glb`;
    const path = await store.exportSaveFile(name, bufferToBase64(buffer), out);
    return { path: path || "", block: item.id };
  },
  planCalibrate: agentPlanCalibrate,
  planPlaceProduct: agentPlanPlaceProduct,
  planPlaceCamera: agentPlanPlaceCamera,
  planArea: agentPlanArea,
  planRemove: agentPlanRemove,
  pageSnapshot: agentPageSnapshot,
  proposalTemplate: agentProposalTemplate,
  pageDuplicate: agentPageDuplicate,
  exportCanvas: async (format, options = {}) => {
    const kinds = ["wechat", "html", "png", "pdf", "toutiao"];
    const kind = kinds.includes(format) ? format : "wechat";
    const result = await exporter.exportAs(kind, { quality: options.quality });
    const saved = await store.exportAuto(result.name, result.format, result.data);
    const out = { path: saved, format: kind, file: result.format, name: result.name };
    if (result.layout !== undefined) out.layout = result.layout;
    if (result.width) out.width = result.width;
    if (result.height) out.height = result.height;
    if (result.pages) out.pages = result.pages;
    if (result.blocks) out.blocks = result.blocks;
    return out;
  },
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
  exportSpace: (id, group, target) => store.exportSpace(id, group, target),
  importSpace: (parent, source) => store.importSpace(parent, source),
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
  genFamily: agentGenFamily,
  genCancel: agentGenCancel,
  genPlace: agentGenPlace,
  genVideo: agentGenVideo,
  genVideoStatus: agentGenVideoStatus,
  genVideoCancel: agentGenVideoCancel,
  genVideoLocal: async (dir) => {
    if (dir === undefined) return store.genVideoLocalGet();
    const current = await store.genVideoLocalGet();
    return store.genVideoLocalSet({
      ...(current?.config || {}),
      dir: String(dir || ""),
    });
  },
  openSettings: (page) => invoke("open_settings_window", page ? { page } : {}),
  genDegrid: (id, srcs) => store.genDegrid(id, srcs),
  genDeviceGet: () => store.genDeviceGet(),
  genDeviceSet: (device) => store.genDeviceSet(device),
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
