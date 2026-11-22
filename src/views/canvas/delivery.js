/* 从 canvas.js 拆出：delivery */

import { BORDER_MAX_WIDTH, ratio } from "../canvas-items.js";
import { clampXToPage } from "./page-width.js";
import { BORDER_DEFAULT_WIDTH } from "../canvas-items.js";
import { GEN_DEFAULT_HEIGHT, GEN_DEFAULT_WIDTH, GEN_MIN_HEIGHT, GEN_MIN_WIDTH, GEN_TEXT_MAX, NOTE_DEFAULT_HEIGHT, NOTE_DEFAULT_WIDTH, NOTE_MIN_HEIGHT, NOTE_MIN_WIDTH, PAGE_RATIOS, PICTURE_DEFAULT_HEIGHT, PICTURE_DEFAULT_WIDTH, PICTURE_MAX_CMDS, PICTURE_MIN_HEIGHT, PICTURE_MIN_WIDTH, PLAN_DEFAULT_HEIGHT, PLAN_DEFAULT_WIDTH, PLAN_MIN_HEIGHT, PLAN_MIN_WIDTH, PRODUCT_DEFAULT_HEIGHT, PRODUCT_DEFAULT_WIDTH, PRODUCT_MIN_HEIGHT, PRODUCT_MIN_WIDTH, QUOTE_DEFAULT_HEIGHT, QUOTE_DEFAULT_WIDTH, QUOTE_MIN_HEIGHT, QUOTE_MIN_WIDTH, SCENE_DEFAULT_HEIGHT, SCENE_DEFAULT_WIDTH, SCENE_MIN_HEIGHT, SCENE_MIN_WIDTH, TEXT_DEFAULT_WIDTH, addItemElement, agentFindSpace, agentImportFile, agentOpenSpace, agentPlacePoint, agentRequireItem, agentRequireSpace, agentSummary, applyColor, applyGenDefaultsToItem, applyGenFields, applyProductFields, boundsOfItem, bytesToBase64, clamp, commitEditing, connectorGeometry, current, deleteItems, edgeLabelEditor, editingId, exporter, findItem, fitGenPrompt, flushBlockContents, flushItems, hydrateNoteImages, imageCache, imageSize, itemBounds, itemEls, landBlock, makeBox, makeConnector, makeGen, makeLine, makeNote, makePage, makePicture, makePlan, makeProduct, makeQuote, makeScene, makeText, makeVideoGen, mergePictureSymbols, moveLayer, newId, normalizeConnectorPoints, normalizeHidden, normalizeItem, normalizeLight, normalizePictureCmds, normalizePictureSymbols, normalizeSceneCamera, normalizeSceneParts, numOr, persistGen, persistNote, persistPicture, persistScene, pictureWashed, pinConnectorSides, placeBlock, promptDialog, refreshConnectors, refreshGenPanel, refreshPictureChrome, refreshQuotes, refreshVideoPanel, rejectFatalDrop, renderMarkdown, replaceSelection, resolvePictureImages, roomShellParts, roomShellSurfaces, sceneLightOf, sceneSurfacesOf, sceneView, scheduleItemsSave, select, selectedIds, setFontSize, setSceneFurnitureSelection, setTextAlign, stageCenterWorld, store, syncConnectorElement, syncItemElement, syncSelectedClasses, updateSelection } from "../canvas.js";

/* ---------- 提案页与客户版交付 ---------- */

export function pageItems() {
  if (!current) return [];
  return current.items
    .filter((item) => item.type === "page")
    .sort((a, b) => (a.order || a.seq) - (b.order || b.seq) || a.y - b.y || a.x - b.x);
}

export function renamePageFlow(item) {
  void (async () => {
    const name = await promptDialog({ title: "重命名页", label: "页名", value: item.title, okText: "重命名" });
    if (!name || name === item.title) return;
    item.title = name;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    scheduleItemsSave();
  })();
}

export function setPageRatio(item, ratio) {
  if (!PAGE_RATIOS[ratio] || item.ratio === ratio) return;
  item.ratio = ratio;
  item.w = PAGE_RATIOS[ratio].w;
  item.h = PAGE_RATIOS[ratio].h;
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  updateSelection();
  scheduleItemsSave();
}

export function setPageOrderFlow(item) {
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
export function clientHiddenIds() {
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

export function hideConnectorsTemporarily(ids) {
  const touched = ids.map((id) => itemEls.get(id)).filter(Boolean);
  const previous = touched.map((el) => el.style.display);
  for (const el of touched) el.style.display = "none";
  return () => {
    touched.forEach((el, index) => {
      el.style.display = previous[index];
    });
  };
}

export async function fetchTextAsset(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读不到 ${url}（${res.status}）`);
  return res.text();
}

export async function fetchDataUrl(url, mime = "") {
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

export function exportHtmlEscape(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

export function exportJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function exportRootName(name) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const safe = String(name || "提案").replace(/[\\/:*?"<>|]/g, " ").trim() || "提案";
  return `${safe} 客户版 ${stamp}`;
}

export function imageMimeOf(src) {
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
export async function buildClientScenes(pages, canvasId) {
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

export function clientPageHtml(title, pages, scenes, pageImages) {
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
export async function exportClientWebTo(dir, root) {
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
export async function exportClientPdfTo(dir, fileName) {
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
export async function agentPageSnapshot({ id, maxSide = 1400 } = {}) {
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

export function blockCenterInsidePage(item, page) {
  if (item.type === "page" || item.type === "connector") return false;
  const bounds = boundsOfItem(item.id) || itemBounds(item, null);
  if (!bounds) return false;
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return cx >= page.x && cx <= page.x + page.w && cy >= page.y && cy <= page.y + page.h;
}

export function addTemplateText(page, x, y, w, text, { size = 14, color = "" } = {}) {
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
export function agentProposalTemplate(spec = {}) {
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
export async function agentPageDuplicate(spec = {}) {
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

export async function agentCreateBlock(spec = {}) {
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
    else if (spec.textColor !== undefined) item.color = String(spec.textColor || "");
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
    const item = withLock(applyGenDefaultsToItem(makeGen(at.x, at.y, w, h)));
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

  if (type === "genvideo") {
    const w = Math.max(320, numOr(spec.w, 320));
    const h = Math.max(360, numOr(spec.h, 360));
    const at = agentPlacePoint(w, h, spec);
    const item = withLock(makeVideoGen(at.x, at.y, w, h));
    if (spec.prompt !== undefined) item.prompt = String(spec.prompt).slice(0, GEN_TEXT_MAX);
    const seconds = Math.round(numOr(spec.seconds, 6));
    if (seconds >= 1 && seconds <= 60) item.seconds = seconds;
    const even = (value) => Math.min(4096, Math.max(64, Math.round(value) - (Math.round(value) % 2)));
    if (spec.width !== undefined) item.width = even(numOr(spec.width, item.width));
    if (spec.height !== undefined) item.height = even(numOr(spec.height, item.height));
    if (spec.borderColor !== undefined) item.borderColor = String(spec.borderColor || "");
    if (spec.borderWidth !== undefined) {
      item.borderWidth = clamp(Math.round(numOr(spec.borderWidth, item.borderWidth)), 0, BORDER_MAX_WIDTH);
    }
    if (spec.radius !== undefined) item.radius = Math.max(0, Math.round(numOr(spec.radius, item.radius)));
    return agentSummary(placeBlock(item));
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

export function agentCreateConnector(spec = {}) {
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

export function agentUpdateConnector(item, patch) {
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

export function agentDeleteBlock(id) {
  const item = agentRequireItem(id);
  const summary = agentSummary(item);
  deleteItems([item.id]);
  return summary;
}

export async function agentDuplicateBlock(id, patch = {}) {
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

export function agentSelectBlocks(ids, additive = false) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  for (const id of list) agentRequireItem(id);
  if (additive) {
    for (const id of list) select(id, true);
  } else {
    const onlyConnector = list.length === 1 && findItem(list[0])?.type === "connector";
    replaceSelection(new Set(onlyConnector ? list : list.filter((id) => findItem(id)?.type !== "connector")));
    syncSelectedClasses();
    updateSelection();
  }
  return { selected: [...selectedIds] };
}

export function agentSetLayer(id, direction) {
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
export const BORDER_WIDTH_KINDS = new Set(["text", "rect", "ellipse", "image", "note", "file", "picture", "scene", "gen", "product", "quote", "plan"]);

export async function agentUpdateBlock(id, patch = {}) {
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
    clampXToPage(item);
    geometry = true;
  }
  if (Number.isFinite(Number(patch.y))) {
    item.y = Number(patch.y);
    geometry = true;
  }
  if (item.type !== "text" && patch.w !== undefined) {
    item.w = Math.max(8, numOr(patch.w, item.w));
    /* 固定宽度画布：宽度不许超过页面，夹完顺便把 x 收回页内 */
    clampXToPage(item);
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
  if (patch.color !== undefined || patch.textColor !== undefined) {
    applyColor(item, "color", String(patch.color ?? patch.textColor ?? ""));
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
    refreshGenPanel(item.id);
    /* agent 换了提示词：这是「内容真的变了」的一趟，框和块高跟着长 */
    if (patch.prompt !== undefined) {
      const genEl = itemEls.get(item.id);
      fitGenPrompt(item.id, genEl?.querySelector(".canvas-gen-prompt"), true);
    }
  }
  if (item.type === "genvideo") {
    let videoChanged = false;
    if (patch.prompt !== undefined) {
      item.prompt = String(patch.prompt).slice(0, GEN_TEXT_MAX);
      videoChanged = true;
    }
    if (patch.seconds !== undefined) {
      const seconds = Math.round(numOr(patch.seconds, item.seconds));
      if (seconds >= 1 && seconds <= 60) {
        item.seconds = seconds;
        videoChanged = true;
      }
    }
    const evenDim = (value, fallback) => {
      const raw = Math.round(numOr(value, fallback));
      return Math.min(4096, Math.max(64, raw - (raw % 2)));
    };
    if (patch.width !== undefined) {
      item.width = evenDim(patch.width, item.width);
      videoChanged = true;
    }
    if (patch.height !== undefined) {
      item.height = evenDim(patch.height, item.height);
      videoChanged = true;
    }
    if (videoChanged) refreshVideoPanel(item.id);
  }
  if (item.type === "pet") applyPetFields(item, patch);
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
