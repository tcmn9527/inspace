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
import { AUDIO_DEFAULT_HEIGHT, AUDIO_DEFAULT_WIDTH, AUDIO_MIN_HEIGHT, AUDIO_MIN_WIDTH, BORDER_DEFAULT_WIDTH, BORDER_MAX_WIDTH, CONNECTOR_MAX_POINTS, EBOOK_DEFAULT_HEIGHT, EBOOK_DEFAULT_WIDTH, EBOOK_MIN_HEIGHT, EBOOK_MIN_WIDTH, FILE_MIN_HEIGHT, FILE_MIN_WIDTH, GEN_CFG_MAX, GEN_DEFAULT_HEIGHT, GEN_DEFAULT_WIDTH, GEN_MIN_HEIGHT, GEN_MIN_WIDTH, GEN_MODES, GEN_MODE_LABELS, GEN_STEPS_MAX, GEN_TEXT_MAX, GEN_VIDEO_MIN_HEIGHT, GEN_VIDEO_MIN_WIDTH, NOTE_DEFAULT_HEIGHT } from "./canvas-items.js";
import { NOTE_DEFAULT_WIDTH, NOTE_MIN_HEIGHT, NOTE_MIN_WIDTH, PAGE_RATIOS, PICTURE_DEFAULT_HEIGHT, PICTURE_DEFAULT_WIDTH, PICTURE_ERASER_TOLERANCE, PICTURE_MAX_CMDS, PICTURE_MAX_EXPANDED, PICTURE_MIN_HEIGHT, PICTURE_MIN_WIDTH, PICTURE_STROKE_MIN_STEP, PICTURE_STROKE_WIDTH_MAX, PICTURE_STROKE_WIDTH_MIN, PLAN_DEFAULT_HEIGHT, PLAN_DEFAULT_WIDTH, PLAN_MIN_HEIGHT, PLAN_MIN_WIDTH, PRODUCT_DEFAULT_HEIGHT, PRODUCT_DEFAULT_WIDTH, PRODUCT_MIN_HEIGHT, PRODUCT_MIN_WIDTH, QUOTE_DEFAULT_HEIGHT, QUOTE_DEFAULT_WIDTH, QUOTE_MIN_HEIGHT } from "./canvas-items.js";
import { QUOTE_MIN_WIDTH, TEXT_DEFAULT_WIDTH, VIDEO_DEFAULT_HEIGHT, VIDEO_DEFAULT_WIDTH, VIDEO_MIN_HEIGHT, VIDEO_MIN_WIDTH, absolutePathOf, capturePagePin, collectPictureImageSrcs, connectorGeometry, connectorLabelPoint, createConnectorElement, createItemElement, fileBlockSize, fitImageSize, formatSize, itemBounds, setFileToggleMode, makeAudio, makeBox, makeConnector, makeEbook } from "./canvas-items.js";
import { makeFile, makeGen, makeImage, makeLine, makeNote, makePage, makePicture, makePlan, makeProduct, makeQuote, makeText, makeVideo, makeVideoGen, newId, normalizeConnectorPoints, normalizeHidden, normalizeItem, normalizeLight, normalizePictureCmd, normalizePictureCmds, normalizePictureSymbols } from "./canvas-items.js";
import { pictureCmdHit, pictureImageSrc, pictureLayerCensus, pictureTopLayers, pinConnectorSides, pinEbookPage, planPixelsPerMm, refreshQuoteCard, releaseEbookPage, remapPictureImageSrcs, renderMissing, renderPictureCmd, routeConnectorPreview, setPictureMedia, snapGenSize, stretchEbookPage, syncConnectorElement, syncItemElement, toPersisted, videoControlOf } from "./canvas-items.js";
import * as store from "./canvas-store.js";
import { LOCK_BADGE_SVG, addOverlayBox, loneSelected, refreshTitlebarPath, updateSelection } from "./canvas/selection.js";

export { AUDIO_MIN_HEIGHT, AUDIO_MIN_WIDTH, EBOOK_MIN_HEIGHT, EBOOK_MIN_WIDTH, FILE_MIN_HEIGHT, FILE_MIN_WIDTH, GEN_VIDEO_MIN_HEIGHT, GEN_VIDEO_MIN_WIDTH, PICTURE_BRUSH_SPEED, PICTURE_ERASER_TOLERANCE, PICTURE_STROKE_MIN_STEP, PICTURE_STROKE_WIDTH_MAX, PICTURE_STROKE_WIDTH_MIN, PICTURE_UNDO_LIMIT, VIDEO_MIN_HEIGHT, VIDEO_MIN_WIDTH, agentBlock, agentCameraState, agentCreateBlock, agentCreateConnector, agentCreateSpace, agentDeleteBlock, agentDuplicateBlock, agentEbookGoto };
export { agentEbookToc, agentFileRead, agentFileWrite, agentFitView, agentFocusBlock, agentGenCancel, agentGenPlace, agentGenRun, agentGenStatus, agentGenVideo, agentGenVideoCancel, agentGenVideoStatus, agentGroupCreate, agentGroupDelete, agentGroupRename, agentMediaControl, agentMediaState, agentNoteRead, agentNoteWrite, agentOpenImage, agentPageDuplicate, agentPageSnapshot, agentPdfGoto, agentPdfState };
export { agentPictureDraw, agentPictureGet, agentPictureLayers, agentPictureLight, agentPlanArea, agentPlanCalibrate, agentPlanPlaceProduct, agentPlanRemove, agentResetZoom, agentRevealFile, agentScene, agentSelectBlocks, agentSetCamera, agentSetLayer };
export { agentSpaceCopy, agentSpaceList, agentSpaceTree, agentUpdateBlock, applyZoomInput, bindZoomHold, closeMenu, exportClientPdfTo, exportClientWebTo, exportRootName, finishEdgeLabelEdit, genFamily, hasScrollableAncestor, importProductsFromCsv, initMinimap, initSearch, initSpaceTree, isMenuOpen, loadBlockContents, normalizePictureCmd, onBendHandleDoubleClick, onKeyDown, onPaste };
export { onStageContextMenu, onStageDoubleClick, onStagePointerDown, onWindowPointerMove, onWindowPointerUp, openExportMenu, openToolMenu, pictureCmdHit, pictureEditorOf, planPlaceProduct, planRemove, probeCache, rebuildContainerOwners, refreshGenDefaults, refreshLinkedNotes, refreshTitlebarPath, refreshTree, renderPictureCmd, selectZoomDigits, setCosmosSeed, setMarqueeCursor, setPictureMedia, setupFileDrop };
export { setupGenEvents, setupVideoCopyEvents, setupVideoEvents, startConnect, startResize, watchGenApi, zoomAt, zoomLabel };
import { agentAnimateCamera, agentBlock, agentCameraState, agentCreateSpace, agentDeleteSpace, agentFindSpace, agentFitView, agentFocusBlock, agentGroupCreate, agentGroupDelete, agentGroupRename, agentHighlight, agentOpenSpace, agentPlacePoint, agentRenameSpace, agentRequireItem, agentRequireSpace, agentRevealBlock, agentScene, agentSpaceCopy, agentSpaceList, agentSpaceTree, agentStopCameraAnim, agentSummary, applyProductFields } from "./canvas/agent-layer.js";
import { numOr } from "./canvas/agent-layer.js";
import { onWindowPointerMove, onWindowPointerUp, scheduleMeasurements, setMeasureHeld, settlePointerUp, startDraw, startResize } from "./canvas/alt-measure.js";
import { agentResetZoom, agentSetCamera } from "./canvas/camera.js";
import { bendInsertIndex, nearestPathPoint, onBendHandleDoubleClick, onStageContextMenu, onStageDoubleClick, openImageExternally, setConnectorBend } from "./canvas/connector-points.js";
import { connectHit, drawConnectPreview, finishConnect, finishConnectEnd, setConnectTarget, setHoverId, startConnect, updatePorts } from "./canvas/connectors.js";
import { containerBoxOf, drawSnapGuides, insideBox, isContainer, moveMembers, nudgeSelected, ownedByContainer, ownedMembers, pushSelected, reassignContainerOwners, rebuildContainerOwners, snapLineAngle, snapOffset, snapResize, toggleContainer } from "./canvas/containers.js";
import { flushBlockContents, genTimers, loadBlockContents, noteTimers, persistGen, persistNote, persistPicture, pictureTimers } from "./canvas/content-files.js";
import { activeBodySelectionText, applyColor, compareImagesEntry, copyBodySelectionText, deleteItems, itemMenuEntries, moveLayer, openBlankMenu, openItemMenu, removeItemFromDom, setFontSize, setLocked, setLockedMany, setTextAlign } from "./canvas/context-menu.js";
import { addImageBlock, audioExtFor, baseName, copyItems, fileExt, fileToDataUrl, imageSize, insertFileFromPicker, insertGenPanel, insertPaths, landBlock, onPaste, pasteCopiedBlocks, pastePoint, revealItem, stageCenterWorld } from "./canvas/copy-paste.js";
import { agentCreateBlock, agentCreateConnector, agentDeleteBlock, agentDuplicateBlock, agentPageDuplicate, agentPageSnapshot, agentSelectBlocks, agentSetLayer, agentUpdateBlock, exportClientPdfTo, exportClientWebTo, exportRootName, renamePageFlow, setPageOrderFlow, setPageRatio } from "./canvas/delivery.js";
import { exporter, exporting, openExportMenu, showToast } from "./canvas/export.js";
import { agentImportFile, agentPictureDraw, agentPictureGet, agentPictureLayers, agentPictureLight, createTextFile, fileTypeMenuItems, loadFileTypes, mergePictureSymbols, pictureWashed, rejectFatalDrop, resolvePictureImages } from "./canvas/files-content.js";
import { agentPlanArea, agentPlanCalibrate, agentPlanPlaceProduct, agentPlanRemove, attachPlanBlock, cancelPlanCalibration, placeProductOnPlanFlow, planCalibration, planPlaceProduct, planRemove, startPlanCalibration } from "./canvas/floorplan.js";
import { agentFileRead, agentFileWrite, agentGenCancel, agentGenPlace, agentGenRun, agentGenStatus, agentGenVideo, agentGenVideoCancel, agentGenVideoStatus, agentNoteRead, agentNoteWrite, agentOpenImage, agentRevealFile, applyGenFields } from "./canvas/gen-agent.js";
import { applyGenDefaultsToItem, attachGenPanel, genEngine, genFamily, genFeedOf, genInputItems, genInputPng, genModeFor, placeGenImage, refreshGenDefaults, refreshGenFeeds, refreshGenPanel, runOrStopGen, setupGenEvents, setupVideoEvents, stopGen, watchGenApi } from "./canvas/gen-defaults.js";
import { exportTreeSpace, importIntoGroup, renameTreeGroup, startTreeRename } from "./canvas/inspace.js";
import { onStagePointerDown, stageTargetAt } from "./canvas/interactions.js";
import { addAudioBlock, addDroppedFile, addEbookBlock, addFileBlock, addVideoBlock, askInsertMode, attachProductCard, attachQuoteCard, bytesToBase64, changeProductImage, exportQuote, importCsvFromQuote, importProductsFromCsv, productItems, refreshQuotes, revealFileBlock, revealTarget } from "./canvas/inventory.js";
import { flushCamera, flushItems, onKeyDown, scheduleCameraSave, scheduleItemsSave, setupFileDrop, showError } from "./canvas/keys-save.js";
import { sanitizePageWidth } from "./canvas/page-width-core.js";
import { alignSelected, distributeSelected, tidySelected } from "./canvas/layout.js";
import { commitEdgeLabelEdit, finishEdgeLabelEdit, positionEdgeLabelEditor, startEdgeLabelEdit } from "./canvas/linktext.js";
import { BATCH_GAP, copyIntoCanvas, insertPoint, openVideoProblem, pasteAudio, pasteImage, placeBlock, probeCache, setupVideoCopyEvents } from "./canvas/media-fallback.js";
import { GEN_PLACE_GAP, applyGenMaskMode, attachGenMask, attachVideoPanel, fitGenPrompt, genMaskBases, genMaskCanvasOf, genMaskModes, genRunMasks, insertVideoPanel, refreshGenMaskBase, refreshVideoPanel, resetGenMask, srcInUse, stopVideo } from "./canvas/media-panels.js";
import { closeFileEdit, commitNoteEditing, fileEditor, flushFileEditor, hydrateNoteImages, isFileEditable, refreshFileBlock, refreshLinkedNotes, renderNoteBody, startFileEdit, startNoteEdit } from "./canvas/note.js";
import { PICTURE_BRUSH_SPEED, PICTURE_UNDO_LIMIT, attachPictureTools, dropRegionImage, exportPictureImage, paintingTarget, pictureEditorOf, pictureEditors, pictureMenuEntries, refreshPictureChrome, setPictureEditing } from "./canvas/paint.js";
import { agentEbookGoto, agentEbookToc, agentMediaControl, agentMediaState, agentPdfGoto, agentPdfState } from "./canvas/pdf-media.js";
import { addItemElement, boundsOfItem, findItem, refreshConnectors, renderAll, revealSelectionInTree, select, selectAll, syncConnector, syncSelectedClasses } from "./canvas/render.js";
import { resetCanvasTextSelection } from "./canvas/editor-toolbar.js";
import { commitEditing, startTextEdit } from "./canvas/text-edit.js";
import { applyCamera, applyZoomInput, beginMarquee, bindZoomHold, clientToWorld, dropTool, finishMarquee, hasScrollableAncestor, openToolMenu, refreshCulling, resetZoom, scheduleCulling, selectZoomDigits, setMarqueeCursor, setTool, toolMenuEntries, updateMarquee, withAllVisible, worldToStage, zoomAt, zoomLabel } from "./canvas/tools-camera.js";
import { initSpaceTree, panelTreeLabel, refreshTree, renameTreePanel, renderTree, treeCollapsed, treeData, treeGroupList, treePanelCollapsed, treeSavePrefs, treeUi } from "./canvas/tree.js";
import { closeColorPicker, openColorPicker } from "./color-picker.js";
import { setCosmosCamera, setCosmosSeed } from "./cosmos.js";
import { CLOSE_X_SVG, choiceDialog, confirmDialog, progressDialog, promptDialog } from "./dialog.js";
import { DEFAULT_QUALITY, QUALITY, createExporter } from "./export.js";
import { dropGenRun, genBusyId, genRunOf, onGenRunChange, patchGenRun, syncGen } from "./genpanel.js";
import { openImageCompare } from "./image-compare.js";
import { createMarkdownEditor } from "./markdown-editor.js";
import { renderMarkdown } from "./markdown.js";
import { closeMenu, isMenuOpen, openMenu } from "./menu.js";
import { blurMinimapFocus, initMinimap, isMinimapFocused, refreshMinimap } from "./minimap.js";
import { toPngDataUrl } from "./raster.js";
import { initSearch } from "./search.js";
import { openVideoHelp } from "./video-help.js";
import { dropVideoRun, patchVideoRun, syncVideoPanel, videoBusyId, videoRunOf } from "./videopanel.js";
export { AUDIO_DEFAULT_HEIGHT, AUDIO_DEFAULT_WIDTH, BATCH_GAP, BORDER_DEFAULT_WIDTH, BORDER_MAX_WIDTH, CLOSE_X_SVG, CONNECTOR_MAX_POINTS, DEFAULT_QUALITY, EBOOK_DEFAULT_HEIGHT, EBOOK_DEFAULT_WIDTH, GEN_CFG_MAX, GEN_DEFAULT_HEIGHT, GEN_DEFAULT_WIDTH, GEN_MIN_HEIGHT, GEN_MIN_WIDTH, GEN_MODES, GEN_MODE_LABELS, GEN_PLACE_GAP, GEN_STEPS_MAX, GEN_TEXT_MAX, LOCK_BADGE_SVG, NOTE_DEFAULT_HEIGHT, NOTE_DEFAULT_WIDTH, NOTE_MIN_HEIGHT };
export { NOTE_MIN_WIDTH, PAGE_RATIOS, PICTURE_DEFAULT_HEIGHT, PICTURE_DEFAULT_WIDTH, PICTURE_MAX_CMDS, PICTURE_MAX_EXPANDED, PICTURE_MIN_HEIGHT, PICTURE_MIN_WIDTH, PLAN_DEFAULT_HEIGHT, PLAN_DEFAULT_WIDTH, PLAN_MIN_HEIGHT, PLAN_MIN_WIDTH, PRODUCT_DEFAULT_HEIGHT, PRODUCT_DEFAULT_WIDTH, PRODUCT_MIN_HEIGHT, PRODUCT_MIN_WIDTH, QUALITY, QUOTE_DEFAULT_HEIGHT, QUOTE_DEFAULT_WIDTH, QUOTE_MIN_HEIGHT, QUOTE_MIN_WIDTH };
export { TEXT_DEFAULT_WIDTH, VIDEO_DEFAULT_HEIGHT, VIDEO_DEFAULT_WIDTH, absolutePathOf, activeBodySelectionText, addAudioBlock, addDroppedFile, addEbookBlock, addFileBlock, addImageBlock, addItemElement, addOverlayBox, addVideoBlock, agentAnimateCamera, agentDeleteSpace, agentFindSpace, agentHighlight, agentImportFile, agentOpenSpace, agentPlacePoint, agentRenameSpace, agentRequireItem, createTextFile, fileTypeMenuItems, loadFileTypes };
export { agentRequireSpace, agentRevealBlock, agentStopCameraAnim, agentSummary, alignSelected, applyCamera, applyColor, applyGenDefaultsToItem, applyGenFields, applyGenMaskMode, applyProductFields, askInsertMode, attachGenMask, attachGenPanel, attachPictureTools, attachPlanBlock, attachProductCard, attachQuoteCard, attachVideoPanel, audioExtFor, baseName, beginMarquee, bendInsertIndex };
export { blurMinimapFocus, boundsOfItem, bytesToBase64, cancelPlanCalibration, capturePagePin, changeProductImage, choiceDialog, clientToWorld, closeColorPicker, closeFileEdit, collectPictureImageSrcs, commitEdgeLabelEdit, commitEditing, commitNoteEditing, compareImagesEntry, confirmDialog, connectHit, connectorGeometry, connectorLabelPoint, containerBoxOf, copyBodySelectionText, copyIntoCanvas, copyItems, createConnectorElement };
export { createExporter, createItemElement, createMarkdownEditor, deleteItems, distributeSelected, drawConnectPreview, drawSnapGuides, dropGenRun, dropRegionImage, dropTool, dropVideoRun, exportPictureImage, exportQuote, exportTreeSpace, exporter, exporting, fileBlockSize, fileEditor, fileExt, setFileToggleMode };
export { fileToDataUrl, findItem, finishConnect, finishConnectEnd, finishMarquee, fitGenPrompt, fitImageSize, flushBlockContents, flushCamera, flushFileEditor, flushItems, formatSize, genBusyId, genEngine, genFeedOf, genInputItems, genInputPng, genMaskBases, genMaskCanvasOf, genMaskModes, genModeFor, genRunMasks, genRunOf, genTimers, hydrateNoteImages };
export { imageSize, importCsvFromQuote, importIntoGroup, insertFileFromPicker, insertGenPanel, insertPaths, insertPoint, insertVideoPanel, insideBox, isContainer, isFileEditable, isMinimapFocused, itemBounds, itemMenuEntries, landBlock, loneSelected, makeAudio, makeBox, makeConnector, makeEbook, makeFile, makeGen, makeImage, makeLine, makeNote };
export { makePage, makePicture, makePlan, makeProduct, makeQuote, makeText, makeVideo, makeVideoGen, mergePictureSymbols, moveLayer, moveMembers, nearestPathPoint, newId, normalizeConnectorPoints, normalizeHidden, normalizeItem, normalizeLight, normalizePictureCmds, normalizePictureSymbols };
export { noteTimers, nudgeSelected, numOr, onGenRunChange, openBlankMenu, openColorPicker, openImageCompare, openImageExternally, openItemMenu, openMenu, openVideoHelp, openVideoProblem, ownedByContainer, ownedMembers, paintingTarget, panelTreeLabel, pasteAudio, pasteCopiedBlocks, pasteImage, pastePoint, patchGenRun, patchVideoRun, persistGen, persistNote, pushSelected, renameTreePanel };
export { persistPicture, pictureEditors, pictureImageSrc, pictureLayerCensus, pictureMenuEntries, pictureTimers, pictureTopLayers, pictureWashed, pinConnectorSides, pinEbookPage, placeBlock, placeGenImage, placeProductOnPlanFlow, planCalibration, planPixelsPerMm, positionEdgeLabelEditor, productItems, progressDialog, promptDialog, reassignContainerOwners, refreshConnectors, refreshCulling };
export { refreshFileBlock, refreshGenFeeds, refreshGenMaskBase, refreshGenPanel, refreshMinimap, refreshPictureChrome, refreshQuoteCard, refreshQuotes, refreshVideoPanel, rejectFatalDrop, releaseEbookPage, remapPictureImageSrcs, removeItemFromDom, renamePageFlow, renameTreeGroup, renderAll, renderMarkdown, renderMissing, renderNoteBody, renderTree, resetGenMask, resetZoom, resolvePictureImages };
export { revealFileBlock, revealItem, revealSelectionInTree, revealTarget, routeConnectorPreview, runOrStopGen, scheduleCameraSave, scheduleCulling, scheduleItemsSave, scheduleMeasurements };
export { select, selectAll, setConnectTarget, setConnectorBend, setCosmosCamera, setFontSize, setHoverId, setLocked, setLockedMany, setMeasureHeld, setPageOrderFlow, setPageRatio, setPictureEditing, setTextAlign, setTool, showError, showToast, snapGenSize, snapLineAngle, snapOffset, snapResize };
export { srcInUse, stageCenterWorld, stageTargetAt, startDraw, startEdgeLabelEdit, startFileEdit, startNoteEdit, startPlanCalibration, startTextEdit, startTreeRename, stopGen, stopVideo, store, stretchEbookPage, syncConnector, syncConnectorElement, syncGen, syncItemElement, syncSelectedClasses, syncVideoPanel, tidySelected, toPersisted, toPngDataUrl, toggleContainer, toolMenuEntries };
export { treeCollapsed, treeData, treeGroupList, treePanelCollapsed, treeSavePrefs, treeUi, updateMarquee, updatePorts, updateSelection, videoBusyId, videoControlOf, videoRunOf, withAllVisible, worldToStage };

const { invoke } = window.__TAURI__.core;

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
/* 每次缩放走 5 个百分点（按钮、长按连发、Ctrl+滚轮都按这个来） */
const ZOOM_STEP = 0.05;
/* 长按缩放键：先走一步，按住超过这段才开始连发，之后按这个节拍继续走 */
export const ZOOM_HOLD_DELAY = 340;
export const ZOOM_HOLD_INTERVAL = 60;
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

export const SVG_NS = "http://www.w3.org/2000/svg";
export const CONNECTABLE = new Set([
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
export const RESIZE_MIN = {
  audio: { w: AUDIO_MIN_WIDTH, h: AUDIO_MIN_HEIGHT },
  file: { w: FILE_MIN_WIDTH, h: FILE_MIN_HEIGHT },
  video: { w: VIDEO_MIN_WIDTH, h: VIDEO_MIN_HEIGHT },
  ebook: { w: EBOOK_MIN_WIDTH, h: EBOOK_MIN_HEIGHT },
  note: { w: NOTE_MIN_WIDTH, h: NOTE_MIN_HEIGHT },
  picture: { w: PICTURE_MIN_WIDTH, h: PICTURE_MIN_HEIGHT },
  gen: { w: GEN_MIN_WIDTH, h: GEN_MIN_HEIGHT },
  genvideo: { w: GEN_VIDEO_MIN_WIDTH, h: GEN_VIDEO_MIN_HEIGHT },
};
export const NOTE_EDITOR_GUARDS = ".canvas-note-editor, .color-pop, #ctx-menu, #canvas-editor-toolbar";
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
export let searchApi = null;
export let canvases = [];
export let current = null; // { meta, camera, items, pageWidth }；pageWidth=null 表示无限画布
/* 选中的块：平时点选只会有一个，Ctrl 点选往里加/摘，Ctrl+A 全往里倒 */
export let selectedIds = new Set();
export let editingId = null;
/* 连线中间文字的编辑态 { itemId, el, input, point, original } */
export let edgeLabelEditor = null;
export let tool = "select";
export let drag = null;
export let itemEls = new Map();
export let imageCache = new Map();
/* 画面块里垫的那张位图，渲染层只认 src，要能显示的地址得回来这张表拿。
   切画布时 imageCache 整个换掉，所以塞的是一个现查的函数、不是那张表本身。 */
setPictureMedia((src) => imageCache.get(src) || "");
/* 场景里贴的材质图也按当前画布取地址：换画布后同一个 images/xxx 不会串到上一个画布 */
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
export let pdfUrlCache = new Map();
export let docxUrlCache = new Map();
export let xlsxUrlCache = new Map();
export let pptxUrlCache = new Map();
/* 书的目录进画布只读一次，翻章不用再解析整本；键和预览一样带上存在方式 */
export let ebookTocCache = new Map();
export const ebookKey = (canvasId, item) => `${canvasId}|${item.linked}|${item.src}`;
export let noteEditor = null; // 当前笔记块的编辑态 { itemId, el, box, textarea, editor }
/* 引用态笔记块这一轮编辑是否允许写回原 .md（编辑弹层里选「修改源文件」才是） */
export let noteWriteBack = false;
/* 已经弹过「改哪一份」的块，双击连着触发两次不至于叠出两层弹层 */
export let noteAskId = null;
/* 音视频块指向的文件找不到了（引用查原片、拷贝查副本）：块留在原地，改成丢文件卡。每次进画布重新查。 */
export let mediaMissing = new Set();
export let modalOpen = false;
export let lastPointer = { x: 0, y: 0, inside: false };
export let hoverId = null;
/* Alt 测距：按住时给单选的块画四周最近面板的距离，松开就收 */
export let measureHeld = false;
export let measureFrame = 0;
export let previewPath = null;
export let toolboxMarkup = "";
export let ctrlHeld = false;
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
export function setPreviewPath(value) { previewPath = value; }
export function assignTool(value) { tool = value; }
export function setToolboxMarkup(value) { toolboxMarkup = value; }
export function setCtrlHeld(value) { ctrlHeld = value; }
export let treeRenaming = null;
export function setTreeRenaming(value) { treeRenaming = value; }
export function setNoteWriteBack(value) { noteWriteBack = value; }
export function setNoteAskId(value) { noteAskId = value; }
export function assignMeasureHeld(value) { measureHeld = value; }
export function setMeasureFrame(value) { measureFrame = value; }
export function assignHoverId(value) { hoverId = value; }
export function setMediaMissing(value) { mediaMissing = value; }
export function setUi(value) { ui = value; }
export function setActive(value) { active = value; }
export function setDrag(value) { drag = value; }
export function setLastPointer(value) { lastPointer = value; }
export function setSearchApi(value) { searchApi = value; }
export function setEdgeLabelEditor(value) { edgeLabelEditor = value; }
export function setCurrent(value) { current = value; }
export function setEditingId(value) { editingId = value; }
export function setNoteEditor(value) { noteEditor = value; }

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
    getPageWidth: () => current?.pageWidth || 0,
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

  /* 舞台尺寸一变（拽窗口边缘、拖动左侧空间树），画布得按新视野重算一遍：
     相机要重新套固定宽度约束；白页/灰底那两个色标是按舞台宽算的，不重画的话
     窗口一窄左边/右边就会漏出没上色的一条；鸟瞰窗的视窗框也吃视野尺寸。
     光重算还不够——整幅内容死贴着旧窗口的左上角不动，看着就像画布没跟上窗口，
     所以先按尺寸差的一半挪相机，让视野中心那个世界点还留在窗口中心，再让
     applyCamera 去收固定宽度的约束。 */
  let stageSize = null;
  let stageSyncFrame = 0;
  const syncStageSize = () => {
    const w = ui.stage.clientWidth;
    const h = ui.stage.clientHeight;
    /* 视图切走时舞台被藏起来、尺寸归零，这不是窗口真的变了：留住上次的真尺寸，
       回来时再按真实差值补一次 */
    if (!w || !h) return;
    const last = stageSize;
    stageSize = { w, h };
    if (!last || !current) return;
    const dw = w - last.w;
    const dh = h - last.h;
    if (!dw && !dh) return;
    current.camera.x += dw / 2;
    current.camera.y += dh / 2;
    applyCamera();
    refreshMinimap();
    scheduleCameraSave();
  };
  /* 一次拖动窗口边缘会连着来几十个 resize，一帧只算一次就够 */
  new ResizeObserver(() => {
    if (stageSyncFrame) return;
    stageSyncFrame = requestAnimationFrame(() => {
      stageSyncFrame = 0;
      syncStageSize();
    });
  }).observe(ui.stage);

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

  /* 生图面板的默认参数：启动读一次，设置窗口改了接口配置再刷 */
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
    /* 窗口外松手收不到 pointerup：失焦就把框选收掉，别让框和中途状态挂着 */
    if (drag?.kind === "marquee") settlePointerUp(null);
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
      pageWidth: sanitizePageWidth(data.pageWidth),
    };
    setCosmosSeed(current.meta.id);
    selectedIds = new Set();
    setEditingId(null);
    resetCanvasTextSelection();
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
  setEditingId(null);
  resetCanvasTextSelection();
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

export function pictureStepMove(id, direction) {
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

export function onPicturePointerDown(e, id) {
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
  setDrag({
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
  });
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

export function onPaintPointerMove(e) {
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

export function finishPaint(finished) {
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
  /* 程序化设置真实的 window.getSelection()：合成键鼠事件造不出浏览器原生选区，
     但 Range + addRange 会触发 selectionchange，工具栏的启用判断照常响应。
     三种定位：字符偏移 start/end；子串 text（取第一次出现）；all 全选元素正文。 */
  debugSelectText: ({ selector, start, end, text = "", all = false } = {}) => {
    const el = document.querySelector(String(selector || ""));
    if (!el) throw new Error("没找到要设置选区的元素");
    if (typeof el.focus === "function") el.focus({ preventScroll: true });

    /* 把元素里所有文本节点按顺序摊平，偏移按「可见文字」算，跨 <br>/<span> 也能选中 */
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let total = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, from: total, to: total + node.nodeValue.length });
      total += node.nodeValue.length;
    }
    if (!nodes.length) throw new Error("元素里没有可选的文字");

    const flat = nodes.map((n) => n.node.nodeValue).join("");
    let a;
    let b;
    if (all) {
      a = 0;
      b = total;
    } else if (text) {
      const at = flat.indexOf(String(text));
      if (at < 0) throw new Error(`没找到子串：${text}`);
      a = at;
      b = at + String(text).length;
    } else {
      a = Math.max(0, Math.min(Number(start) || 0, total));
      b = a + Math.max(1, Math.min(Number(end) || 0, total) - a);
    }

    const locate = (offset, bias) => {
      const hit = nodes.find((n) => offset >= n.from && (offset < n.to || (bias === "end" && offset === n.to)));
      if (!hit) return { node: nodes[bias === "end" ? nodes.length - 1 : 0].node, at: 0 };
      return { node: hit.node, at: Math.max(0, Math.min(offset - hit.from, hit.node.nodeValue.length)) };
    };
    const from = locate(a, "start");
    const to = locate(b, "end");
    const range = document.createRange();
    range.setStart(from.node, from.at);
    range.setEnd(to.node, to.at);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { selected: sel.toString(), start: a, end: b, rangeCount: sel.rangeCount, collapsed: sel.isCollapsed };
  },
  debugInspect: ({ selector, pseudo = "" } = {}) => {    const nodes = [...document.querySelectorAll(String(selector || ""))].slice(0, 40);
    const active = document.activeElement;
    const sel = window.getSelection();
    const selection = sel && sel.rangeCount
      ? { text: sel.toString(), collapsed: sel.isCollapsed, rangeCount: sel.rangeCount }
      : { text: "", collapsed: true, rangeCount: 0 };
    return {
      count: nodes.length,
      selection,
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
          html: (el.innerHTML || "").slice(0, 400),
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
          userSelect: style.userSelect || style.webkitUserSelect,
          position: style.position,
          zIndex: style.zIndex,
          cursor: style.cursor,
          backgroundImage: style.backgroundImage === "none" ? undefined : style.backgroundImage,
          scrollHeight: el.scrollHeight || undefined,
          scrollTop: el.scrollTop || undefined,
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
  planCalibrate: agentPlanCalibrate,
  planPlaceProduct: agentPlanPlaceProduct,
  planArea: agentPlanArea,
  planRemove: agentPlanRemove,
  pageSnapshot: agentPageSnapshot,
  pageDuplicate: agentPageDuplicate,
  exportCanvas: async (format, options = {}) => {
    const kinds = ["wechat", "html", "png", "pdf", "toutiao", "xiaohongshu"];
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
  /* 助手技能：list 只给 id / name / description，read 才拿 SKILL.md 全文 */
  skillsList: () => store.skillsList(),
  skillsDir: () => store.skillsDir(),
  skillRead: (id) => store.skillRead(id),
  skillSave: (payload) => store.skillSave(payload),
  skillDelete: (id) => store.skillDelete(id),
  skillImport: (from) => store.skillImport(from),
  /* 小红书卡片：按 3:4 竖页切成一组 PNG，写进 exports/<画布名>/01.png… */
  exportCards: async (options = {}) => {
    const result = await exporter.exportCards({ width: options.width || 1080, ratio: options.ratio });
    const folder = await store.exportCards(
      result.name,
      result.cards.map((card) => ({ rel: card.rel, data: card.data })),
    );
    return {
      path: folder,
      format: "png",
      count: result.count,
      width: result.width,
      pageHeight: result.pageHeight,
    };
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
  genCancel: agentGenCancel,
  genPlace: agentGenPlace,
  genVideo: agentGenVideo,
  genVideoStatus: agentGenVideoStatus,
  genVideoCancel: agentGenVideoCancel,
  openSettings: (page) => invoke("open_settings_window", page ? { page } : {}),
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
