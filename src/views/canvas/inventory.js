/* 从 canvas.js 拆出：inventory */

import { exitSceneEdit } from "./scene-toolbar.js";
import { AUDIO_DEFAULT_HEIGHT, AUDIO_DEFAULT_WIDTH, EBOOK_DEFAULT_HEIGHT, EBOOK_DEFAULT_WIDTH, NOTE_DEFAULT_HEIGHT, NOTE_DEFAULT_WIDTH, PRODUCT_DEFAULT_HEIGHT, PRODUCT_DEFAULT_WIDTH, VIDEO_DEFAULT_HEIGHT, VIDEO_DEFAULT_WIDTH, active, baseName, beginSceneFurnitureDrag, choiceDialog, copyIntoCanvas, current, dropTool, ebookKey, ebookTocCache, fileBlockSize, findItem, imageCache, insertPoint, itemEls, makeAudio, makeEbook, makeFile, makeNote, makeProduct, makeVideo, normalizeSceneCamera, persistScene, placeBlock, refreshQuoteCard, refreshSceneToolbar, revealItem, sceneCameraState, sceneFurnitureDragDelta, scenePick, scheduleItemsSave, select, setSceneFurnitureSelection, showError, showToast, srcInUse, store, syncItemElement } from "../canvas.js";

/* ---------- 产品 / 材料卡与清单 ---------- */

export function productItems() {
  return current ? current.items.filter((item) => item.type === "product") : [];
}

/* 产品一改，画布上的清单整块重画：清单里的数字永远按产品卡现算 */
export function refreshQuotes() {
  if (!current) return;
  const products = productItems();
  for (const item of current.items) {
    if (item.type !== "quote") continue;
    const el = itemEls.get(item.id);
    if (el) refreshQuoteCard(el, item, products);
  }
}

/* 一格就地编辑：Enter / 失焦提交，Esc 放弃。提交后由调用方重画 */
export function inlineEditField(fieldEl, value, onCommit, options = {}) {
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

export function attachProductCard(el, item) {
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

export function startProductFieldEdit(itemId, field, fieldEl) {
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

export function scenePlacementActive(item) {
  return Boolean(itemEls.get(item.id)?.querySelector(".canvas-scene-card.is-placing"));
}

export function setScenePlacementMode(item, enabled) {
  if (item.type !== "scene") throw new Error("要选择场景块");
  if (enabled && item.locked) throw new Error("场景已锁定，请先解锁");
  const el = itemEls.get(item.id);
  const card = el?.querySelector(".canvas-scene-card");
  if (!card) throw new Error("场景还没显示出来");
  card.classList.toggle("is-placing", enabled);
  if (!enabled) setSceneFurnitureSelection(card.querySelector(".canvas-scene-view"), []);
  /* 工具条跟着换态：场景 ↔ 元素 */
  refreshSceneToolbar();
  return { id: item.id, placement: enabled };
}

export function sceneFurnitureGroup(item, index) {
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

export function moveSceneFurnitureParts(item, origins, delta) {
  for (const origin of origins) {
    const part = item.parts[origin.index];
    part.x = origin.x + delta.x;
    part.y = origin.y + delta.y;
    part.z = origin.z + delta.z;
  }
}

export function attachSceneControls(el, item) {
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
        if (!hit) {
          setSceneFurnitureSelection(view, []);
          /* 编辑态在背景上按左键：拖动=直接转视角（不用再按 Ctrl），轻点不拖=退出编辑 */
          const startX = event.clientX;
          const startY = event.clientY;
          const base = sceneCameraState(item, view);
          let orbiting = false;
          card.classList.add("is-orbiting");
          const move = (e) => {
            if (e.pointerId !== event.pointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!orbiting && Math.hypot(dx, dy) < 3) return;
            orbiting = true;
            item.camera = normalizeSceneCamera({
              ...base,
              azim: base.azim - dx * 0.35,
              elev: base.elev + dy * 0.25,
            });
            renderSoon();
          };
          const up = () => {
            card.classList.remove("is-orbiting");
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            window.removeEventListener("blur", up);
            /* 轻点背景也留在编辑态：退出只走「退出编辑」按钮或 Esc */
            if (orbiting) scheduleItemsSave();
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
          window.addEventListener("blur", up);
          return;
        }
        const furniture = sceneFurnitureGroup(item, hit.index);
        /* 地板/墙/窗这类没有附着面的构件也能选中（用元素工具改颜色尺寸），只是不能拖着走 */
        setSceneFurnitureSelection(view, furniture?.indices || [hit.index]);
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

export function attachQuoteCard(el, item) {
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

export async function changeProductImage(itemId) {
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

export const CSV_HEADER_ALIASES = {
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

export const normalizeCsvHeader = (value) => String(value || "").trim().toLowerCase().replace(/[\s_\-]/g, "");

export function parseCsvText(text) {
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

export function csvColumnIndex(headerRow) {
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

export const csvAmount = (value) => {
  const amount = Number(String(value || "").replace(/[¥￥,\s元]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
};

/* 图片列写相对路径时按 CSV 所在目录算；写绝对路径就照用 */
export function resolveCsvImagePath(csvPath, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return raw;
  const cut = Math.max(csvPath.lastIndexOf("\\"), csvPath.lastIndexOf("/"));
  const dir = cut > 0 ? csvPath.slice(0, cut) : "";
  return dir ? `${dir}\\${raw.replace(/\//g, "\\")}` : raw;
}

export async function importProductsFromCsv(path, origin) {
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

export async function importCsvFromQuote(quote) {
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

export function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function exportQuote(item, format) {
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
export async function addAudioBlock(path, point, mode) {
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
export async function addVideoBlock(path, point, mode) {
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

export function placeVideo(info, src, topLeft, linked) {
  const item = makeVideo(topLeft.x, topLeft.y, info.name, src, linked);
  placeBlock(item);
  return item;
}

/* ---------- 电子书块 ---------- */

/* 先把整本读一遍目录再决定要不要拷：DRM、KF8 这类读不了的在这里当场报错，
   不会先往画布塞一份 20MB 的副本才发现打不开。科目已读到的目录顺手留给阅读块，
   免得刚放上去又解析一遍。 */
export async function addEbookBlock(path, point, mode) {
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
export async function askInsertMode(count) {
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
export async function addDroppedFile(info, topLeft, mode) {
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
export async function placeMarkdownFile(info, topLeft, mode) {
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
export async function addFileBlock(info, topLeft, mode) {
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
export function revealTarget(item) {
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

export function revealFileBlock(item) {
  if (!current) return;
  const target = revealTarget(item);
  if (!target) return;
  /* 笔记那块的文件名就是块 id，画布目录后端知道，前端一个字都不用递 */
  const call = target.block
    ? store.revealBlock(current.meta.id, item.id)
    : store.revealCanvasFile(current.meta.id, target.rel, target.linked);
  call.catch((error) => showError(error));

  item.name = baseName(path);
  return placeBlock(item);
}
