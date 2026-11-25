/* 从 canvas.js 拆出：render */

import { attachGenPanel, attachPictureTools, attachPlanBlock, attachProductCard, attachQuoteCard, attachVideoPanel, audioCache, connectorGeometry, createConnectorElement, createItemElement, current, docxUrlCache, ebookKey, ebookTocCache, filePreviewCache, flushFileEditor, hydrateNoteImages, imageCache, isContainer, itemBounds, itemEls, mediaMissing, noteEditor, openVideoProblem, pdfUrlCache, pinConnectorSides, pptxUrlCache, previewKey, previewPath, productItems, refreshCulling, refreshGenFeeds, refreshMinimap, refreshQuoteCard, renderMissing, renderTree, replaceSelection, restoreScrollMemory, scheduleCulling, scheduleItemsSave, selectedIds, setNoteEditor, setPreviewPath, store, syncConnectorElement, syncItemElement, treePanelCollapsed, treeSavePrefs, treeUi, ui, updateSelection, videoCache, xlsxUrlCache } from "../canvas.js";

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

export function nextSeq() {
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
  /* 面板里内容滚动条的位置：放回上次读到的那一段。
     重的正文（PDF/Office）是懒挂的，等它真挂上来时再放一次 */
  restoreScrollMemory(el);
  scheduleCulling();
  return el;
}

export function nextLayerZ() {
  let top = -1;
  if (current) {
    for (const item of current.items) {
      if (item.type !== "connector" && Number.isFinite(item.z)) top = Math.max(top, item.z);
    }
  }
  return top + 1;
}

export function renderAll() {
  /* 文件卡里懒挂的 PDF/Office 正文也要先卸掉：光删 DOM 的话 pdf.js 的文档和
     工作线程会跟着旧元素一起变成孤儿（切画布时最明显） */
  for (const el of ui.world.querySelectorAll(".canvas-item")) el.__unmountBody?.();
  ui.world.textContent = "";
  ui.edgeTransform.textContent = "";
  setPreviewPath(null);
  setNoteEditor(null);
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
    replaceSelection(new Set([id]));
  } else {
    if (!selectedIds.size) {
      updateSelection();
      return;
    }
    replaceSelection(new Set());
  }
  syncSelectedClasses();
  updateSelection();
}

/* Ctrl+A：面板、文字、图形都算，连线不进集合——它没有自己的位置，跟着两端的块走 */
export function selectAll() {
  replaceSelection(new Set(
    current.items.filter((item) => item.type !== "connector").map((item) => item.id),
  ));
  syncSelectedClasses();
  updateSelection();
}

export function syncSelectedClasses() {
  for (const [itemId, el] of itemEls) {
    el.classList.toggle("is-selected", selectedIds.has(itemId));
  }
}

/* 画布上选中的块如果藏在折叠的容器里，把容器逐级展开，让人在树里看得见选中行 */
export function revealSelectionInTree() {
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
