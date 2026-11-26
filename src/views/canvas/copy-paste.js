/* 从 canvas.js 拆出：copy-paste */

import { AUDIO_EXTS, BATCH_GAP, EBOOK_EXTS, GEN_DEFAULT_HEIGHT, GEN_DEFAULT_WIDTH, IMAGE_EXTS, VIDEO_EXTS, active, addAudioBlock, addDroppedFile, addEbookBlock, addItemElement, addVideoBlock, applyCamera, applyGenDefaultsToItem, askInsertMode, boundsOfItem, clientToWorld, collectPictureImageSrcs, commitEditing, containerBoxOf, current, edgeLabelEditor, editingId, fitImageSize, flushItems, imageCache, insertPoint, insideBox, isContainer, itemBounds, lastPointer, makeGen, makeImage, makeText, modalOpen, newId, normalizeItem, ownedMembers, pasteAudio, pasteImage, placeBlock, remapPictureImageSrcs, replaceSelection, scheduleCameraSave, scheduleItemsSave, select, selectedIds, showError, store, syncSelectedClasses, ui, updateSelection, worldToStage } from "../canvas.js";
import { rebuildContainerOwners } from "../canvas.js";
import { clampXToPage } from "./page-width.js";

/* ---------- 复制 / 粘贴块 ----------
   Ctrl+C 存下这批块的一份快照（连它来自哪个画布一起记），Ctrl+V 落一批全新的块。
   笔记带上自己那份 .md，拷贝态媒体真再拷一份副本，引用态还是指着同一份原文件；
   连线不复制。同画布落在原块右下方一格，跨画布跟着鼠标落。 */

export const BLOCK_CLIPBOARD = "workbench.canvas.blocks";
export const PASTE_OFFSET = 24;
export const MEDIA_TYPES = new Set(["image", "audio", "video", "file", "ebook"]);
export let copiedBlocks = null; // { canvasId, box: {x, y}, blocks: [块快照] }

export const coord = (value) => (Number.isFinite(value) ? value : 0);

export function selectionBox(items) {
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
export async function landBlock(item, fromId, sourceId) {
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
  /* Markdown 文件块：贴图图床 notes/<块id>/ 和正文里的图片路径跟着新块走，
     否则删掉原块后副本里的图全裂 */
  if (item.type === "file" && item.text) {
    await store
      .duplicateFileAssets(fromId, sourceId, canvasId, item.id, item.src)
      .catch(() => {});
  }
  return true;
}

export function copyItems(ids) {
  if (!current || !ids.length) return;
  const picked = new Set(ids);
  const selected = current.items.filter((item) => picked.has(item.id) && item.type !== "connector");
  if (!selected.length) return;
  /* 容器要把框里的子块一起带上：复制粘贴一个完整的容器 */
  const byId = new Map(selected.map((item) => [item.id, item]));
  for (const item of selected) {
    if (!isContainer(item)) continue;
    for (const kid of ownedMembers(item, new Set(byId.keys()), true)) byId.set(kid.id, kid);
  }
  const blocks = [...byId.values()];
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
export function clipboardBlockPayload(data) {
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

export async function pasteBlocks(payload) {
  if (!current || !payload?.blocks.length) return;
  if (editingId || edgeLabelEditor) commitEditing();
  const canvasId = current.meta.id;
  const blocks = payload.blocks.filter((raw) => raw && typeof raw === "object");
  const plain = blocks.filter((raw) => raw.type !== "connector");
  /* 同画布右下错开一点点，跨画布落在鼠标这儿 */
  const box = selectionBox(plain);
  const anchor =
    payload.canvasId === canvasId
      ? { x: box.x + PASTE_OFFSET, y: box.y + PASTE_OFFSET }
      : pastePoint();
  const placed = [];
  for (const raw of blocks) {
    /* 拷贝副本那几下是异步的：期间切了画布就别再把块往原来那个画布上摆 */
    if (!current || current.meta.id !== canvasId) return;
    /* 粘出来的一律未锁定、归属清空后按新的落点重认：复制容器是为了接着用，不是把锁也搬过去 */
    const item = normalizeItem({ ...raw, id: newId(), seq: 0, z: null, locked: false, containerId: "" });
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
  /* 粘出来的容器认自己的子块：重叠区里的老块都有主，不会被新容器抢走 */
  const placedContainers = placed
    .filter((item) => isContainer(item))
    .sort((a, b) => a.w * a.h - b.w * b.h);
  for (const container of placedContainers) {
    const box = containerBoxOf(container);
    if (!box) continue;
    for (const item of placed) {
      if (item === container || item.type === "connector") continue;
      if (!item.containerId && insideBox(item, box)) {
        item.containerId = container.id;
      }
    }
  }
  /* 新容器只偏移 24px，和老容器高度重叠。老容器里后来插进去的块没有 containerId，
     不收敛的话会被新容器当成自己的成员，拖新容器把老块一起拖走。
     这里按容器顺序先到先得地把所有无主块认回各自的框。 */
  rebuildContainerOwners();
  replaceSelection(new Set(placed.map((item) => item.id)));
  syncSelectedClasses();
  updateSelection();
}

export function pasteCopiedBlocks() {
  if (!copiedBlocks) return;
  void pasteBlocks(copiedBlocks);
}

/* ---------- 粘贴 ---------- */

export async function onPaste(e) {
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

export function fileExt(name) {
  const clean = String(name || "").split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function clipboardFiles(data) {
  const files = [...(data.files || [])];
  if (files.length) return files;
  for (const entry of data.items || []) {
    if (entry.kind !== "file") continue;
    const file = entry.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export const AUDIO_MIME_EXT = {
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

export function audioExtFor(file) {
  const ext = fileExt(file.name);
  if (AUDIO_EXTS.has(ext)) return ext;
  return AUDIO_MIME_EXT[(file.type || "").toLowerCase()] || "";
}

export function stageCenterWorld() {
  const rect = ui.stage.getBoundingClientRect();
  return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

export function pastePoint() {
  if (lastPointer.inside) {
    return clientToWorld(lastPointer.x, lastPointer.y);
  }
  return stageCenterWorld();
}

export function addTextAtPointer(text) {
  if (!current) return;
  if (editingId || edgeLabelEditor) commitEditing();
  const point = pastePoint();
  const item = makeText(point.x, point.y);
  clampXToPage(item);
  item.text = text;
  current.items.push(item);
  const el = addItemElement(item);
  item.h = el.offsetHeight;
  select(item.id);
  scheduleItemsSave();
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/* 量一张图多大。读不出来时给个兜底的框是图片块用的（宁可先摆个空卡片），
   画面里垫的参考图宁可报失败也不能编一个尺寸出来，所以兜底值由调用方给。 */
export function imageSize(src, fallback = { width: 320, height: 200 }) {
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
export async function insertPaths(paths, origin) {
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
export function revealItem(item) {
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
export function batchRowPoint(origin) {
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
export async function pickAndInsert(pick) {
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
export function insertGenPanel(mode) {
  if (!current) return;
  const at = insertPoint(GEN_DEFAULT_WIDTH, GEN_DEFAULT_HEIGHT);
  const item = applyGenDefaultsToItem(makeGen(at.x, at.y));
  item.mode = mode;
  placeBlock(item);
}

export function insertFileFromPicker() {
  return pickAndInsert(store.pickCanvasFile);
}

export function baseName(path) {
  return String(path).split(/[\\/]/).pop() || "未命名";
}

/* 图片：两种存在方式都要先拿到显示地址才知道原始比例，量完才定块的大小。
   引用态不拷字节，地址直接指向原图，几百 MB 的扫描件也不会整份进内存。 */
export async function addImageBlock(path, point, mode) {
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
  placeBlock(item);
  return item;
}
