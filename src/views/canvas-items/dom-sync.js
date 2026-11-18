/* canvas-items/dom-sync.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { BORDER_DEFAULT_WIDTH, CARD_DEFAULT_BORDER_WIDTH, CARD_DEFAULT_RADIUS, IMAGE_MAX_SIDE, PICTURE_ERASER_TOLERANCE, TEXT_DEFAULT_RADIUS, VIDEO_DEFAULT_HEIGHT, VIDEO_DEFAULT_WIDTH, VIDEO_MAX_SIDE, VIDEO_MIN_WIDTH, VIDEO_ROW_HEIGHT } from "./constants.js";
import { linePoints } from "./dom-connectors.js";
import { LIGHT_DEFAULTS, clipAttr, litPaint, maskAttr, pictureTopLayers, symbolView, tintKey } from "./picture.js";
import { SVG_NS, ratio } from "./util.js";
import { syncGen } from "../genpanel.js";
import { syncScene } from "../scene3d.js";

export function createLineSvg(item) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("canvas-line-svg");
  svg.setAttribute("overflow", "visible");

  if (item.type === "arrow") {
    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", `arrow-${item.id}`);
    marker.setAttribute("viewBox", "0 0 6 6");
    marker.setAttribute("refX", "5.4");
    marker.setAttribute("refY", "3");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto");
    const head = document.createElementNS(SVG_NS, "path");
    head.setAttribute("d", "M0 0 L6 3 L0 6 Z");
    head.setAttribute("fill", item.borderColor);
    marker.append(head);
    defs.append(marker);
    svg.append(defs);
  }

  const line = document.createElementNS(SVG_NS, "line");
  line.classList.add("canvas-line-visible");
  line.setAttribute("stroke", item.borderColor);
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  if (item.type === "arrow") line.setAttribute("marker-end", `url(#arrow-${item.id})`);
  svg.append(line);

  /* 2px 的线太细不好点：叠一条透明的宽线专门用来接指针 */
  const hit = document.createElementNS(SVG_NS, "line");
  hit.classList.add("canvas-line-hit");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "14");
  svg.append(hit);
  return svg;
}

/* 书页是跨进程 iframe：它的布局尺寸一变就要跨进程重分配渲染表面，一帧做不完
   （实测拖角每动一次 33ms、60 步掉 59 帧）。所以拖拽期间把书页钉在起始尺寸，
   滚动区照真实尺寸排版、书页只用 transform 拉满——标题条和按钮不会跟着变胖。
   钉住期间外层不滚动、也不跟着可视区改书页高度，松手一次付清。 */
export function capturePagePin(item, el) {
  if (item.type !== "ebook") return null;
  const frame = el.querySelector(".canvas-ebook-page");
  const scroll = el.querySelector(".canvas-ebook-scroll");
  if (!frame || !scroll || !frame.offsetWidth || !frame.offsetHeight) return null;
  return { frame, scroll, w: frame.offsetWidth, h: frame.offsetHeight, y: scroll.scrollTop };
}

export function pinEbookPage(pin) {
  pin.frame.dataset.pinned = "1";
  pin.frame.style.width = `${pin.w}px`;
  pin.frame.style.height = `${pin.h}px`;
  pin.scroll.style.overflowY = "hidden";
  pin.scroll.scrollTop = pin.y;
}

export function stretchEbookPage(pin) {
  pin.frame.style.transformOrigin = "0 0";
  pin.frame.style.transform = `scale(${Math.max(0.02, pin.scroll.clientWidth / pin.w)}, ${Math.max(0.02, pin.scroll.clientHeight / pin.h)})`;
}

export function releaseEbookPage(pin) {
  delete pin.frame.dataset.pinned;
  pin.frame.style.removeProperty("width");
  pin.frame.style.removeProperty("transform");
  pin.frame.style.removeProperty("transform-origin");
  pin.scroll.style.removeProperty("overflow-y");
  pin.frame.style.height = `${Math.max(1, pin.scroll.clientHeight)}px`;
  pin.scroll.scrollTop = pin.y;
}

/** 把数据同步到已有 DOM（拖动/缩放/改色时只走这里，不重建节点）。 */
/* 笔记卡片的边框和背景：空值就交回样式表，跟随主题 */
export function syncNoteColors(el, item) {
  const card = el.querySelector(".canvas-note-card");
  const body = el.querySelector(".canvas-note-body");
  if (card) {
    card.style.borderColor = item.borderColor || "";
    card.style.background = item.fillColor || "";
    card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  }
  if (body) {
    body.style.background = item.fillColor || "";
    body.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  }
}

/* 文件卡片的边框和背景：空值就交回样式表，跟随主题 */
export function syncFileColors(el, item) {
  const card = el.querySelector(".canvas-file-card");
  if (!card) return;
  card.style.borderColor = item.borderColor || "";
  card.style.background = item.fillColor || "";
  card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
  card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
}

/* ---------- 产品 / 材料卡 ---------- */

export function formatPrice(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `¥${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

export function productField(el, field) {
  return el.querySelector(`[data-field="${field}"]`);
}

export function syncProductElement(el, item) {
  const card = el.querySelector(".canvas-product-card");
  if (!card) return;
  card.style.borderColor = item.borderColor || "";
  card.style.background = item.fillColor || "";
  card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
  card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  /* 正在改的那一格别被重画冲掉 */
  const editing = el.querySelector(".canvas-product-edit");
  const editingField = editing?.dataset.field || "";
  const name = productField(el, "name");
  if (name && editingField !== "name") name.textContent = item.name || "未命名产品";
  const brand = productField(el, "brand");
  if (brand && editingField !== "brand") brand.textContent = item.brand || "";
  const sku = productField(el, "sku");
  if (sku && editingField !== "sku") sku.textContent = item.sku || "";
  const meta = el.querySelector(".canvas-product-meta");
  if (meta) meta.hidden = !item.brand && !item.sku;
  const dot = el.querySelector(".canvas-product-dot");
  if (dot) dot.hidden = !item.brand || !item.sku;
  const spec = productField(el, "spec");
  if (spec && editingField !== "spec") {
    spec.textContent = item.spec || "";
    spec.hidden = !item.spec;
  }
  const price = productField(el, "price");
  if (price && editingField !== "price") price.textContent = formatPrice(item.price);
  const qty = productField(el, "qty");
  if (qty && editingField !== "qty") qty.textContent = `×${item.qty}`;
  const img = el.querySelector(".canvas-product-img");
  if (img) img.alt = item.name || "";
}

export function syncQuoteColors(el, item) {
  const card = el.querySelector(".canvas-quote-card");
  if (!card) return;
  card.style.borderColor = item.borderColor || "";
  card.style.background = item.fillColor || "";
  card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
  card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  const title = card.querySelector(".canvas-quote-title");
  if (title && !el.querySelector(".canvas-quote-edit")) title.textContent = item.title || "家具清单";
}

/* 清单按当前画布的产品卡现算；产品一改，canvas.js 会整块重画 */
export function refreshQuoteCard(el, item, products = []) {
  const card = el.querySelector(".canvas-quote-card");
  if (!card) return;
  syncQuoteColors(el, item);
  const list = products.filter((product) => product.type === "product");
  const count = card.querySelector(".canvas-quote-count");
  if (count) count.textContent = `${list.length} 项`;
  const rows = card.querySelector(".canvas-quote-rows");
  if (!rows) return;
  rows.textContent = "";
  let total = 0;
  for (const product of list) {
    const line = product.price * product.qty;
    total += line;
    const row = document.createElement("div");
    row.className = "canvas-quote-row";
    row.dataset.id = product.id;
    for (const text of [
      product.name || "未命名产品",
      product.spec || "",
      formatPrice(product.price),
      String(product.qty),
      formatPrice(line),
    ]) {
      const cell = document.createElement("span");
      cell.textContent = text;
      row.append(cell);
    }
    rows.append(row);
  }
  if (!list.length) {
    const hint = document.createElement("p");
    hint.className = "canvas-quote-empty";
    hint.textContent = "还没有产品卡";
    rows.append(hint);
  }
  const totalValue = card.querySelector(".canvas-quote-total-value");
  if (totalValue) totalValue.textContent = formatPrice(total);
}

/* ---------- 户型块 ---------- */

/* 图片像素 / 毫米：两点定标那段的像素距离除以它代表的毫米数；没定标就是 0 */
export function planPixelsPerMm(item) {
  const cal = item.calibration;
  if (!cal || !(item.imageW > 0) || !(item.imageH > 0)) return 0;
  const dist = Math.hypot((cal.x2 - cal.x1) * item.imageW, (cal.y2 - cal.y1) * item.imageH);
  return dist > 0 ? dist / cal.mm : 0;
}

export function planAreaM2(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2 / 1_000_000;
}

/* 脚印、面积、机位都画进同一张 SVG：viewBox 就是图片原始像素，
   图片按 fill 拉伸到块里，这层 SVG 用同样的拉伸，两层永远对得上。 */
export function syncPlanElement(el, item) {
  const card = el.querySelector(".canvas-plan-card");
  if (!card) return;
  card.style.borderColor = item.borderColor || "";
  card.style.background = item.fillColor || "";
  card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
  card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  const svg = card.querySelector(".canvas-plan-svg");
  const badge = card.querySelector(".canvas-plan-badge");
  if (!svg) return;
  svg.textContent = "";
  const iw = item.imageW;
  const ih = item.imageH;
  if (!(iw > 0) || !(ih > 0)) {
    if (badge) badge.textContent = "";
    return;
  }
  svg.setAttribute("viewBox", `0 0 ${iw} ${ih}`);
  const scale = planPixelsPerMm(item);
  if (badge) {
    badge.textContent =
      scale > 0
        ? `已定标 · 家具 ${item.footprints.length}${item.cameras.length ? ` · 机位 ${item.cameras.length}` : ""}${item.areas.length ? ` · 面积 ${item.areas.length}` : ""}`
        : "未定标 · 右键「标定比例…」";
  }
  if (!(scale > 0)) return;
  const mk = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  for (const area of item.areas) {
    const pts = area.points.map((p) => `${(p.x * scale).toFixed(1)},${(p.y * scale).toFixed(1)}`).join(" ");
    svg.append(mk("polygon", { class: "canvas-plan-area", points: pts }));
    const cx = area.points.reduce((sum, p) => sum + p.x, 0) / area.points.length;
    const cy = area.points.reduce((sum, p) => sum + p.y, 0) / area.points.length;
    const label = mk("text", {
      class: "canvas-plan-area-label",
      x: (cx * scale).toFixed(1),
      y: (cy * scale).toFixed(1),
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-size": Math.max(14, Math.min(iw, ih) / 34),
    });
    label.textContent = `${planAreaM2(area.points).toFixed(2)} m²`;
    svg.append(label);
  }
  for (const fp of item.footprints) {
    const wpx = fp.w * scale;
    const dpx = fp.d * scale;
    const group = mk("g", {
      class: "canvas-plan-footprint",
      "data-footprint": fp.id,
      "data-product": fp.product,
      transform: `translate(${(fp.x * scale).toFixed(1)} ${(fp.y * scale).toFixed(1)}) rotate(${fp.rotate.toFixed(1)})`,
    });
    group.append(
      mk("rect", {
        x: (-wpx / 2).toFixed(1),
        y: (-dpx / 2).toFixed(1),
        width: wpx.toFixed(1),
        height: dpx.toFixed(1),
        rx: Math.min(8, wpx * 0.08, dpx * 0.08).toFixed(1),
      }),
    );
    if (wpx > 46 && fp.name) {
      const text = mk("text", {
        class: "canvas-plan-foot-label",
        x: 0,
        y: 0,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": Math.max(12, Math.min(wpx * 0.13, dpx * 0.42, 64)),
      });
      text.textContent = fp.name;
      group.append(text);
    }
    svg.append(group);
  }
  for (const cam of item.cameras) {
    const group = mk("g", {
      class: "canvas-plan-camera",
      "data-camera": cam.id,
      "data-scene": cam.scene,
      "data-preset": cam.preset,
      transform: `translate(${(cam.x * scale).toFixed(1)} ${(cam.y * scale).toFixed(1)}) rotate(${cam.rotate.toFixed(1)})`,
    });
    group.append(mk("path", { class: "canvas-plan-camera-cone", d: "M0 0 L-34 -20 A40 40 0 0 1 -34 20 Z" }));
    group.append(mk("circle", { class: "canvas-plan-camera-dot", cx: 0, cy: 0, r: Math.max(9, Math.min(iw, ih) / 70) }));
    svg.append(group);
  }
}

/* ---------- 画面块：指令列表 → svg ----------
   为什么是 svg 不是 <canvas>：导出和 agent 截图都是把世界层塞进一张带 viewBox 的 svg
   再按目标像素栅格化（export.js 的 buildSvg）。块里的 <canvas> 只是一张按当前缩放画好的
   位图，放大倍数一上去就糊；svg 节点交给浏览器按 viewBox 现画，任何倍数都是锐的。 */

export const PICTURE_FAMILIES = {
  sans: "sans-serif",
  serif: "serif",
  mono: "ui-monospace, Consolas, monospace",
  /* 题字走系统自带的黑体，中文不缺字 */
  cjk: '"Microsoft YaHei", "PingFang SC", sans-serif',
};

let pictureClipSeq = 0;
let pictureGradSeq = 0;
let pictureSymSeq = 0;
let picturePatSeq = 0;

/* 画面里垫的位图要显示，就得把存下来的 src 换成这个画布能用的地址，而那张表在 canvas.js 那边
   （跟着画布切换整个重建）。这里不反向 import，由那边启动时把「src → 地址」的函数塞进来。
   没塞、或那个 src 现在取不到（还没加载完、原片被删了）都算「图没到」，渲染层自己退化成占位框。 */
let pictureMedia = null;

export function setPictureMedia(resolve) {
  pictureMedia = typeof resolve === "function" ? resolve : null;
}

export function pictureNode(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === "" || value == null || value === 0) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/* 渐变那几个数不能走上面那种「0 就省掉」的写法：svg 自己的默认值是 50%，
   一个 cx:0 被省掉，圆心就跑到了包围盒正中。 */
export function pictureNodeExact(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/* 一处漆要么是颜色串，要么是渐变 / 图案对象。
   渐变和图案都要现造一个节点塞进这一块的 defs，再把 url(#id) 交回去——
   所以渲染一条指令得带上「往哪儿塞 defs」，不能只返回一个节点。 */
export function paintAttr(paint, ctx) {
  if (!paint) return "";
  if (typeof paint === "string") return paint;
  if (paint.type === "pattern") return patternAttr(paint, ctx);
  pictureGradSeq += 1;
  const id = `canvas-picture-grad-${pictureGradSeq}`;
  const box = paint.units === "user" ? "userSpaceOnUse" : "objectBoundingBox";
  const node = pictureNodeExact(
    paint.type === "linear" ? "linearGradient" : "radialGradient",
    paint.type === "linear"
      ? { id, gradientUnits: box, x1: paint.x1, y1: paint.y1, x2: paint.x2, y2: paint.y2 }
      : { id, gradientUnits: box, cx: paint.cx, cy: paint.cy, r: paint.r },
  );
  for (const stop of paint.stops) {
    node.append(pictureNodeExact("stop", { offset: stop.at, "stop-color": stop.color }));
  }
  markPictureDef(node);
  ctx?.defs?.append(node);
  return `url(#${id})`;
}

/* 现造的 defs 都盖一个记号，每幅重画前按记号清掉：
   渐变、素材、图案的 id 全是递增的，不清就一路堆到内存里。 */
export function markPictureDef(node) {
  node.setAttribute("data-canvas-picture-def", "");
}

/* 图案漆：<pattern> 一格，浏览器自己铺满。格子里画的是自带纹样（斜线 / 方格 / 点），
   或者一个素材（tile，瓦、砖、鳞片都这么铺）。同一份漆只造一次。 */
export function patternAttr(paint, ctx) {
  const key = `pat\u0000${JSON.stringify(paint)}${tintKey(ctx)}`;
  const cached = ctx?.defCache?.get(key);
  if (cached) return `url(#${cached})`;
  const half = paint.gap / 2;
  const cellW = paint.pattern === "tile" ? paint.dx : paint.gap;
  const cellH = paint.pattern === "tile" ? paint.dy : paint.gap;
  const node = pictureNodeExact("pattern", {
    patternUnits: "userSpaceOnUse",
    width: cellW,
    height: cellH,
    patternTransform: paint.angle ? `rotate(${paint.angle})` : null,
  });
  /* 底色先铺满这一格，纹样再压上去：省掉「同一条形状画两遍，一遍底色一遍纹样」 */
  if (paint.background) {
    node.append(pictureNodeExact("rect", { x: 0, y: 0, width: cellW, height: cellH, fill: paint.background }));
  }
  const line = (x1, y1, x2, y2) =>
    pictureNodeExact("line", { x1, y1, x2, y2, stroke: paint.color, "stroke-width": paint.width });
  if (paint.pattern === "tile") {
    /* 铺的单元认不出来就整片漆作废：宁可这块不填，也不给浏览器塞个空 pattern */
    const view = symbolView(ctx?.symbols, ctx?.view || new Map(), { ref: paint.ref });
    if (!view) return "";
    const use = pictureNode("use", { transform: `translate(${-view.symbol.ox} ${-view.symbol.oy})` });
    use.setAttribute("href", `#${pictureSymbolDef(view, ctx)}`);
    node.append(use);
  } else {
    /* 线画在格子正中：贴着边画会被裁掉半根，接缝处看着就断 */
    if (paint.pattern === "dots") {
      node.append(pictureNodeExact("circle", { cx: half, cy: half, r: Math.max(0.2, paint.width / 2), fill: paint.color }));
    } else {
      node.append(line(half, 0, half, paint.gap));
      if (paint.pattern === "grid") node.append(line(0, half, paint.gap, half));
    }
  }
  picturePatSeq += 1;
  const id = `canvas-picture-pat-${picturePatSeq}`;
  node.setAttribute("id", id);
  markPictureDef(node);
  ctx?.defs?.append(node);
  ctx?.defCache?.set(key, id);
  return `url(#${id})`;
}

/* 一个素材按一套图层开关投影出来的那份指令，只造一个 <g>：
   几百份 use 全指同一个 id，这就是实例化省下来的地方。 */
/* 落影不越过素材这一层：素材那一份 <g> 是所有 use 共用的，把落影挤进去等于每一片瓦、
   每一根椽都各自拖一道影子。摆在组里的那个人，影子按整个素材的外接框挤一片就够了。 */
export const noCast = (ctx) => (ctx?.cast ? { ...ctx, cast: null } : ctx);

export function pictureSymbolDef(view, ctx) {
  const key = `sym\u0000${view.key}${tintKey(ctx)}`;
  const cached = ctx?.defCache?.get(key);
  if (cached) return cached;
  const g = pictureNode("g", {});
  const sctx = noCast(ctx);
  for (const cmd of view.cmds) {
    const node = renderPictureCmd(cmd, sctx);
    if (node) g.append(node);
  }
  pictureSymSeq += 1;
  const id = `canvas-picture-sym-${pictureSymSeq}`;
  g.setAttribute("id", id);
  markPictureDef(g);
  ctx?.defs?.append(g);
  ctx?.defCache?.set(key, id);
  return id;
}

export const hasHandles = (points) => points.some((point) => point.c1 || point.c2);

/* 一条边：这一点带了控制点就走三次贝塞尔，没带就是直线。
   只写了一个控制点就拿它顶两个用，不然 C 段会缺参数。 */
export function edgeSegment(from, to) {
  if (!(to.c1 || to.c2)) return ` L ${to.x} ${to.y}`;
  const c1 = to.c1 || to.c2;
  const c2 = to.c2 || to.c1;
  return ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
}

export function edgePath(points, closed) {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) d += edgeSegment(points[i - 1], points[i]);
  if (closed) d += `${edgeSegment(points[points.length - 1], points[0])} Z`;
  return d;
}

/* 曲线段打平成折线，只给命中判定用：不打平会出现「明明压到了却擦不掉」。
   12 段一支足够——容差本来就是几个像素的事。 */
export function flattenSegment(from, to) {
  if (!(to.c1 || to.c2)) return [to];
  const c1 = to.c1 || to.c2;
  const c2 = to.c2 || to.c1;
  const out = [];
  for (let step = 1; step <= 12; step += 1) {
    const t = step / 12;
    const u = 1 - t;
    out.push({
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
    });
  }
  return out;
}

export function flattenEdges(points, closed) {
  if (!hasHandles(points)) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) out.push(...flattenSegment(points[i - 1], points[i]));
  if (closed) out.push(...flattenSegment(points[points.length - 1], points[0]));
  return out;
}

/* 一点就是笔尖落下的那个半径：没写 w 的点用这条指令的默认宽度 */
export function strokeRadiusOf(point, size) {
  const width = Number.isFinite(point.w) ? point.w : size;
  return Math.max(0.05, width / 2);
}

/* 一路等宽的笔交给 svg 自己描（stroke-width + 圆头），比手算轮廓又准又便宜。
   只有真的带提按才走下面那套展开成填色轮廓的画法。 */
export function strokeUniformWidth(points, size) {
  const first = strokeRadiusOf(points[0], size) * 2;
  return points.every((point) => strokeRadiusOf(point, size) * 2 === first) ? first : 0;
}

/* 中心线用二次曲线走：每一点当控制点、相邻点的中点当落点。
   手画的折角会被这段圆弧顺过去，看上去是一笔而不是一串直线段。 */
export function strokeCenterPath(points) {
  const last = points.length - 1;
  if (last < 2) return `M ${points[0].x} ${points[0].y} L ${points[last].x} ${points[last].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < last; i += 1) {
    d += ` Q ${points[i].x} ${points[i].y} ${(points[i].x + points[i + 1].x) / 2} ${(points[i].y + points[i + 1].y) / 2}`;
  }
  return `${d} L ${points[last].x} ${points[last].y}`;
}

/* 变宽的墨迹只能填色：svg 的 stroke-width 沿一条路径是恒定的，想要「按下去粗、
   提起来细」就得把中心线两侧各推出半个笔宽，围成一圈再填。两头补半圆当圆头。 */
export function strokeOutlinePath(points, size) {
  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const prev = points[i - 1] || point;
    const next = points[i + 1] || point;
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    const r = strokeRadiusOf(point, size);
    left.push({ x: point.x - dy * r, y: point.y + dx * r, r });
    right.push({ x: point.x + dy * r, y: point.y - dx * r, r });
  }
  const tail = right.length - 1;
  let d = `M ${left[0].x.toFixed(2)} ${left[0].y.toFixed(2)}`;
  for (let i = 1; i < left.length; i += 1) d += ` L ${left[i].x.toFixed(2)} ${left[i].y.toFixed(2)}`;
  /* 收尾那头：左沿的终点绕到右沿的终点，半径就是那一点的半宽 */
  d += ` A ${left[tail].r.toFixed(2)} ${left[tail].r.toFixed(2)} 0 0 0 ${right[tail].x.toFixed(2)} ${right[tail].y.toFixed(2)}`;
  for (let i = tail - 1; i >= 0; i -= 1) d += ` L ${right[i].x.toFixed(2)} ${right[i].y.toFixed(2)}`;
  d += ` A ${right[0].r.toFixed(2)} ${right[0].r.toFixed(2)} 0 0 0 ${left[0].x.toFixed(2)} ${left[0].y.toFixed(2)} Z`;
  return d;
}

/* ---------- 枯笔：一笔拆成几根丝 ----------
   毛笔写干了，墨先从笔幅两侧咬空，中间只剩一道，沿线还会撕开白缝、末端散成几叉。
   这套几何就是把一笔画成 1~5 条各自长短不齐、各带几处断口的细带。

   股数、每根偏多少、从哪儿断开，全部由这条点串自己的哈希推出来——
   同一份数据永远画成同一笔，重开、导出、第二次重画都不会变成另一笔。
   破了这条，幂等（存进去的拼写=读回来的拼写、再归一化一次还是它）就是假的。 */

/* 一根笔最多拆几股：再多就是一把扫帚，不像一杆枯笔了 */
export const GRAIN_STRAND_MAX = 5;
/* 超长的手绘点串先抽稀再拆股：4000 点 × 5 股会把一条 path 撑到几百 KB，
   而 4000 点的笔本来密到抽剩 480 点也看不出棱角。只在起枯的时候抽，实墨那条一像素不动。 */
export const GRAIN_SPINE_POINTS = 480;

export function grainSeed(points, size, grain) {
  let h = 0x811c9dc5;
  const mix = (value) => {
    h = (h ^ Math.round(Number(value) || 0)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(size);
  mix(grain * 100);
  for (const point of points) {
    mix(point.x);
    mix(point.y);
    mix(point.w ?? size);
  }
  return h >>> 0;
}

/* mulberry32：给一个种子出一串定死的随机数。不用 Math.random——那让同一笔每次画得不一样。 */
export function grainRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 一根丝在笔幅上的位置：t 是 -1（贴左沿）到 +1（贴右沿），share 是它占整幅的比例。
   偏的量按 (1 - share) 收着给，于是 |t|=1 那根正好贴边不越界——
   橡皮判据才不用跟着改：纹理怎么散都还在原来那一笔的宽度里。 */
export function grainStrands(points, size, grain) {
  const strandCount = Math.max(1, Math.min(GRAIN_STRAND_MAX, 1 + Math.round(grain * (GRAIN_STRAND_MAX - 1))));
  const step = Math.max(1, Math.ceil(points.length / GRAIN_SPINE_POINTS));
  const spine = [];
  for (let i = 0; i < points.length; i += step) spine.push(points[i]);
  if (spine[spine.length - 1] !== points[points.length - 1]) spine.push(points[points.length - 1]);
  if (spine.length < 2) return [];
  const rnd = grainRandom(grainSeed(spine, size, grain));
  const paths = [];
  for (let s = 0; s < strandCount; s += 1) {
    const t = strandCount === 1 ? 0 : (s / (strandCount - 1)) * 2 - 1;
    /* 两侧那两根更细：墨是从边上先咬空的 */
    const share = Math.max(0.12, (1 / strandCount) * (1 - grain * 0.25) * (1 - 0.45 * Math.abs(t)));
    const offset = t * (1 - share);
    /* 两头各让开一截：接笔那头留得短，收笔那头散得开，几股一错开就是末端分叉 */
    const from = Math.min(Math.round(rnd() * grain * 0.06 * spine.length), spine.length - 2);
    const to = Math.max(from + 2, spine.length - Math.round(rnd() * grain * 0.22 * spine.length));
    const cuts = [];
    if (to - from >= 6) {
      const extra = (rnd() < grain * 0.9 ? 1 : 0) + (grain > 0.55 && rnd() < 0.55 ? 1 : 0);
      for (let c = 0; c < extra; c += 1) {
        const at = Math.round(from + (0.2 + rnd() * 0.6) * (to - from));
        if (at > from + 2 && at < to - 2) cuts.push(at);
      }
      cuts.sort((a, b) => a - b);
    }
    const bounds = [from, ...cuts, to];
    for (let b = 1; b < bounds.length; b += 1) {
      const start = bounds[b - 1];
      const end = bounds[b];
      if (end - start < 2) continue;
      const sub = [];
      for (let i = start; i < end; i += 1) {
        const point = spine[i];
        const prev = spine[i - 1] || point;
        const next = spine[i + 1] || point;
        let dx = next.x - prev.x;
        let dy = next.y - prev.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) {
          dx = 1;
          dy = 0;
        } else {
          dx /= len;
          dy /= len;
        }
        const width = Number.isFinite(point.w) ? point.w : size;
        const reach = (width / 2) * offset;
        sub.push({
          x: point.x - dy * reach,
          y: point.y + dx * reach,
          /* 各点带上自己的股宽，strokeOutlinePath 照这个半径铺开，提按跟着原笔走 */
          w: Math.max(0.1, width * share),
        });
      }
      paths.push(strokeOutlinePath(sub, size));
    }
  }
  return paths;
}

/* ---------- 橡皮命中判定 ----------
   线 / 笔画量「到折线的最短距离」，填色的矩形和 poly 连内部一起算，空心的只认边框，
   文字按包围盒粗判。group 不参与：橡皮删的是一整条指令，
   擦到组里任意一笔会把整组一起带走，那不像擦除像误删。
   带剪刀的那条还要再过一道 cutAreaHit：剪掉的那部分看不见，也就不该擦得到。 */

/* 一个「面」罩不罩得住这一点。剪刀的三种规范形和素材里的几何指令用同一套判法：
   rect 连圆角一起算（圆角那块看不见，也就擦不到），曲线边一律打平——
   不打平会出现「看着明明压到了却擦不掉」，反过来还会让剪刀外的地方擦得着。 */
export function cutAreaHit(shape, point, ctx) {
  /* 这里的 shape 有两种来路：规范形自己（只有 kind），和摊开后的素材指令（只有 op，
     而且 stroke 那条自己带 kind:"pen"|"brush" 表示笔头——那是笔尖，不是形状种类）。
     先读 op 再读 kind，不然素材里的墨迹会被当成不认识的形整个放行，剪刀等于没挂。 */
  const kind = shape.op || shape.kind;
  if (kind === "ref") {
    const symbol = ctx?.symbols?.[shape.ref];
    /* 剪刀素材没了（归一化那一头拦着不让删还在用的，真到这一步是坏数据）：
       当没有剪刀放行——看不见又擦不掉的东西才最难伺候 */
    if (!symbol) return true;
    const local = pictureLocalPoint(shape, point);
    const scale = Math.abs(Number(shape.scale) || 1) || 1;
    const inside = { x: local.x / scale + symbol.ox, y: local.y / scale + symbol.oy };
    return (symbol.cmds || []).some((cmd) => cutAreaHit(cmd, inside, ctx));
  }
  if (kind === "rect") {
    const r = Math.min(Math.max(0, Number(shape.radius) || 0), Math.min(shape.w, shape.h) / 2);
    if (point.x < shape.x || point.x > shape.x + shape.w || point.y < shape.y || point.y > shape.y + shape.h) return false;
    if (!r) return true;
    /* 圆角那块：把点钳到内缩的方框上，它到圆心的距离超半径就落在角外 */
    const cx = Math.min(Math.max(point.x, shape.x + r), shape.x + shape.w - r);
    const cy = Math.min(Math.max(point.y, shape.y + r), shape.y + shape.h - r);
    return Math.hypot(point.x - cx, point.y - cy) <= r;
  }
  if (kind === "path" || kind === "poly" || kind === "line") {
    return polygonInside(flattenEdges(shape.points, true), point);
  }
  if (kind === "stroke") {
    /* 墨迹当剪刀剪的是那一长条的面积，判法和这条自己的命中一模一样（只看半径，不看枯笔的丝） */
    for (let i = 0; i < shape.points.length; i += 1) {
      const from = shape.points[i - 1] || shape.points[i];
      if (pointSegmentDistance(point, from, shape.points[i]) <= strokeRadiusOf(shape.points[i], shape.size)) return true;
    }
    return false;
  }
  if (kind === "group") {
    const local = pictureLocalPoint(shape, point);
    const scale = Math.abs(Number(shape.scale) || 1) || 1;
    return (shape.cmds || []).some((cmd) => cutAreaHit(cmd, { x: local.x / scale, y: local.y / scale }, ctx));
  }
  /* text 当剪刀只在渲染那头收下（字体缺不缺会影响剪出来的形），擦除按罩不住放行 */
  if (kind === "text") return true;
  return true;
}

export function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function polylineHit(points, closed, p, reach) {
  for (let i = 1; i < points.length; i += 1) {
    if (pointSegmentDistance(p, points[i - 1], points[i]) <= reach) return true;
  }
  if (closed && points.length > 2) {
    return pointSegmentDistance(p, points[points.length - 1], points[0]) <= reach;
  }
  return false;
}

export function polygonInside(points, p) {
  let inside = false;
  /* j 要停在「上一条边的另一端」：写成 j = i += 1 会让 j 跟着 i 一起走，
     两条相邻点变成同一个点，判定几乎永远返回 false（填色 poly 的内部擦不到就是这个） */
  for (let i = 0, j = points.length - 1; i < points.length; j = i, (i += 1)) {
    const a = points[i];
    const b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* 擦不擦得到 = 形状命中了，还要落在这一条自己的剪刀里。
   mask 不参与判定：渐变没有硬边界，「擦得到」的界在这儿划不出来。
   剪刀的坐标和这条指令的几何同一个坐标系，所以这里不用做任何变换。 */
export function pictureCmdHit(cmd, point, tolerance = PICTURE_ERASER_TOLERANCE, ctx = {}) {
  if (!pictureCmdShapeHit(cmd, point, tolerance, ctx)) return false;
  if (!cmd || !cmd.clip) return true;
  return cutAreaHit(cmd.clip, point, ctx);
}

export function pictureCmdShapeHit(cmd, point, tolerance = PICTURE_ERASER_TOLERANCE, ctx = {}) {
  if (!cmd || typeof cmd !== "object") return false;
  const reach = Math.max(0, Number(tolerance) || 0);
  if (cmd.op === "stroke") {
    for (let i = 0; i < cmd.points.length; i += 1) {
      const from = cmd.points[i - 1] || cmd.points[i];
      if (pointSegmentDistance(point, from, cmd.points[i]) <= strokeRadiusOf(cmd.points[i], cmd.size) + reach) return true;
    }
    return false;
  }
  if (cmd.op === "line" || cmd.op === "poly") {
    const closed = cmd.op === "poly";
    /* 带控制点的边先打平：按原始折线算会出现「看着明明压到了却擦不掉」 */
    const ring = flattenEdges(cmd.points, closed);
    const half = (cmd.strokeWidth > 0 ? cmd.strokeWidth / 2 : 0) + reach;
    if (polylineHit(ring, closed, point, half)) return true;
    return closed && Boolean(cmd.fill) && polygonInside(ring, point);
  }
  if (cmd.op === "rect") {
    const inside =
      point.x >= cmd.x - reach &&
      point.x <= cmd.x + cmd.w + reach &&
      point.y >= cmd.y - reach &&
      point.y <= cmd.y + cmd.h + reach;
    if (!inside) return false;
    if (cmd.fill) return true;
    const half = (cmd.strokeWidth > 0 ? cmd.strokeWidth / 2 : 0) + reach;
    return polylineHit(
      [
        { x: cmd.x, y: cmd.y },
        { x: cmd.x + cmd.w, y: cmd.y },
        { x: cmd.x + cmd.w, y: cmd.y + cmd.h },
        { x: cmd.x, y: cmd.y + cmd.h },
      ],
      true,
      point,
      half,
    );
  }
  if (cmd.op === "text") {
    /* svg 的 text 锚点是基线：往上留一个字身，往下留一点下伸部 */
    const width = String(cmd.text || "").length * cmd.size * 0.62;
    return (
      point.x >= cmd.x - reach &&
      point.x <= cmd.x + width + reach &&
      point.y >= cmd.y - cmd.size + reach &&
      point.y <= cmd.y + cmd.size * 0.3 + reach
    );
  }
  /* 素材实例：擦掉的就是这一整份。素材里的图层（name / variants）只是「这份要不要画」的开关，
     不是能各自擦掉的东西，所以穿层问过。 */
  if (cmd.op === "use") {
    const view = symbolView(ctx.symbols, ctx.view || new Map(), cmd);
    if (!view) return false;
    const local = pictureLocalPoint(cmd, point);
    const scale = Math.abs(Number(cmd.scale) || 1) || 1;
    const inside = { x: local.x / scale + view.symbol.ox, y: local.y / scale + view.symbol.oy };
    return view.cmds.some((child) => symbolLayerHit(child, inside, reach / scale, ctx));
  }
  /* 垫的位图整张都算「这一笔」：框内哪一点都擦得到，跟图有没有加载出来无关。
     渲染时旋转绕的是框中心，反推坐标就得绕同一个点，不能套 pictureLocalPoint（那个绕落点）。 */
  if (cmd.op === "image") {
    const cx = cmd.x + cmd.w / 2;
    const cy = cmd.y + cmd.h / 2;
    const rad = ((Number(cmd.rotate) || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = point.x - cx;
    const dy = point.y - cy;
    const local = { x: cx + dx * cos + dy * sin, y: cy - dx * sin + dy * cos };
    return (
      local.x >= cmd.x - reach &&
      local.x <= cmd.x + cmd.w + reach &&
      local.y >= cmd.y - reach &&
      local.y <= cmd.y + cmd.h + reach
    );
  }
  /* 顶层的组：组里任何一笔被碰到，擦掉的就是这一整条 group（和「一擦一整条」一个脾气）。
     以前这里没有组这一支，顶层 group 恒判不中——手绘橡皮擦不掉一整组，
     而图层恰恰推荐「几笔一起开关就包一层 group 起名」，等于给分好组的画留了个擦不掉的洞。 */
  if (cmd.op === "group") {
    const local = pictureLocalPoint(cmd, point);
    const scale = Math.abs(Number(cmd.scale) || 1) || 1;
    return (cmd.cmds || []).some((child) => symbolLayerHit(child, { x: local.x / scale, y: local.y / scale }, reach / scale, ctx));
  }
  return false;
}

/* 素材内部按图层往下穿：图层是同一个整体的一部分，不是各自能擦的一笔 */
export function symbolLayerHit(cmd, point, reach, ctx) {
  if (cmd.op !== "group") return pictureCmdHit(cmd, point, reach, ctx);
  const local = pictureLocalPoint(cmd, point);
  const scale = Math.abs(Number(cmd.scale) || 1) || 1;
  return cmd.cmds.some((child) => symbolLayerHit(child, { x: local.x / scale, y: local.y / scale }, reach / scale, ctx));
}

/* 把外层坐标系的点搬回这条指令自己的坐标系：挪掉落点，再反着把旋转和缩放转回来。
   注意先除缩放再摆 ox/oy：ox 记的是素材自己那套坐标。 */
export function pictureLocalPoint(cmd, point) {
  const dx = point.x - (Number(cmd.x) || 0);
  const dy = point.y - (Number(cmd.y) || 0);
  const rad = ((Number(cmd.rotate) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/* 滤镜走 css 的函数写法，不进 <defs> 现造 <filter>：
   svg 自己那套的画区按形状包围盒取百分比，一条竖线的包围盒宽是 0，模糊会被切出一道硬边；
   css 函数由浏览器按效果自己扩画区，没有这个坑，也不用跟着每幅画增删一个 id。
   发光 = 两层同心 drop-shadow：dx/dy 都是 0 时它就是「自己的形状糊一层颜色」，
   叠两层是为了外面那圈更淡的过渡，单层的边缘会像贴了一张纸片。
   写成数组时按序串起来，css 的 filter 本来就是空格分隔的函数列表。 */
export function filterStyleOf(filter, ctx) {
  return (Array.isArray(filter) ? filter : [filter]).map((one) => oneFilterStyle(one, ctx)).join(" ");
}

/* 影子的落点：写了 dx / dy 就照写的来，缺哪个补哪个——补的方向是光的反方向。
   长短两种来源：写了 h 的是「一个立着的东西」，影长按真实投影来 L = h / tan(太阳高度)，
   太阳越低影子越长（这正是街面上那种斜长影子）；没写 h 的照老口径，短到和化开半径一个量级，
   那是「贴在纸上的一层淡影」。正顶光影长为 0，太阳落到地平线以下也不算长影。
   只在渲染期算，绝不写回存着的数据：改一次光源，全画的影子一起转身。 */
export const SHADOW_MAX_LEN = 2000;

export function shadowOffset(filter, ctx) {
  const dx = Number.isFinite(filter.dx) ? filter.dx : null;
  const dy = Number.isFinite(filter.dy) ? filter.dy : null;
  if (dx !== null && dy !== null) return { dx, dy };
  const light = ctx?.light;
  if (!light) return { dx: dx ?? 0, dy: dy ?? 0 };
  const a = (Number(light.angle) * Math.PI) / 180;
  const e = (Number(light.elev ?? LIGHT_DEFAULTS.elev) * Math.PI) / 180;
  const h = Number(filter.h);
  const len = Number.isFinite(h)
    ? e <= 0
      ? 0
      : Math.min(SHADOW_MAX_LEN, h / Math.max(Math.tan(e), 0.05))
    : Math.max(0, Math.cos(e)) * Number(filter.r || 0);
  const round = (v) => Math.round(v * 10) / 10;
  return { dx: dx ?? round(-Math.sin(a) * len), dy: dy ?? round(Math.cos(a) * len) };
}

/* 滤镜里那条写了 h 的投影。没写 h 的（贴在纸上的一层淡影）还走 css，一个字都不变。 */
export function shadowWithH(filter) {
  const list = Array.isArray(filter) ? filter : filter ? [filter] : [];
  return list.find((one) => one?.type === "shadow" && Number.isFinite(Number(one.h))) || null;
}

/* 写了 h 的那一档不能再交给 css：drop-shadow 是把整个剪影挪一份，影长一超过物体自己的高度，
   挪出来的那份就和物体脱开、悬在半空像一团雾。真的落影是从脚底拖出去的一片：
   拿这条指令和纸接触的那一道（外接框的底边）沿影子向量平移，四点围成一个平行四边形，
   垫在形状自己后面。一个多边形就是一片影子，不占离屏合成，一条街摆几十个也不掉帧。
   group 自己不出一片：那会把整组的外接框当一个物体，十七个小人挤成一整条街的糊。 */
export function castShadowOf(cmd, ctx) {
  if (cmd.op === "group") return null;
  const one = shadowWithH(cmd.filter) || ctx?.cast;
  if (!one || !ctx?.light) return null;
  const { dx, dy } = shadowOffset(one, ctx);
  if (!dx && !dy) return null;
  const pts = pictureOutlineOf(cmd, ctx, 0);
  if (!pts.length) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!(x1 > x0)) return null;
  return { x0, x1, y: y1, dx, dy, color: one.color, r: Number(one.r) || 0 };
}

export function castShadowNode(cast, ctx) {
  const { x0, x1, y, dx, dy, color, r } = cast;
  /* 影子里最不该出现的是「一块均匀的灰板」：真的落影从脚底开始最实，往末梢一路淡掉——
     笔影越远越散（半影变宽）、天光从四面八方补回来。所以按影子的长短拉一道渐变，
     起点在脚底、终点在末梢，都是这块画面的真实坐标。 */
  const mid = (x0 + x1) / 2;
  const fill = paintAttr(
    {
      type: "linear",
      units: "user",
      x1: mid,
      y1: y,
      x2: mid + dx,
      y2: y + dy,
      stops: [
        { at: 0, color },
        { at: 0.5, color: hexAlpha(color, 0.6) },
        { at: 1, color: hexAlpha(color, 0) },
      ],
    },
    ctx,
  );
  const node = pictureNode("polygon", {
    points: `${x0},${y} ${x1},${y} ${x1 + dx},${y + dy} ${x0 + dx},${y + dy}`,
    fill,
  });
  /* 默认硬边：低太阳的落影本来就是一道清楚的边，要羽化再写 r。
     写了 r 才有这一次离屏合成，所以别顺手给每条影子都糊上。 */
  if (r > 0) node.style.filter = `blur(${r}px)`;
  return node;
}

/* 给 #rrggbb / #rrggbbaa 换一档不透明度（影子淡到末梢用） */
export function hexAlpha(color, k) {
  const hex = String(color);
  const a = Math.round((hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255) * k);
  return `${hex.slice(0, 7)}${a.toString(16).padStart(2, "0")}`;
}

/* 这条指令摊开之后占在哪些点上（在它自己那一层坐标里）：落影要按脚底那道边挤。
   素材得摊成它自己的每一笔才知道脚在哪儿；素材里不许再摆素材，所以最深两层。 */
export function pictureOutlineOf(cmd, ctx, depth) {
  if (cmd.op === "rect" || cmd.op === "image") {
    return [
      { x: cmd.x, y: cmd.y },
      { x: cmd.x + (Number(cmd.w) || 0), y: cmd.y + (Number(cmd.h) || 0) },
    ];
  }
  if (Array.isArray(cmd.points)) return cmd.points.map((p) => ({ x: p.x, y: p.y }));
  if (cmd.op === "text") return [{ x: cmd.x, y: cmd.y }];
  if (depth > 2) return [];
  let kids = null;
  let off = { x: 0, y: 0 };
  if (cmd.op === "group") kids = cmd.cmds;
  else if (cmd.op === "use") {
    const view = symbolView(ctx?.symbols, ctx?.view || new Map(), cmd);
    if (!view) return [];
    kids = view.cmds;
    off = { x: -(Number(view.symbol.ox) || 0), y: -(Number(view.symbol.oy) || 0) };
  }
  if (!kids) return [];
  const s = Number(cmd.scale) || 1;
  const rad = ((Number(cmd.rotate) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out = [];
  for (const one of kids) {
    for (const p of pictureOutlineOf(one, ctx, depth + 1)) {
      let x = (p.x + off.x) * s;
      let y = (p.y + off.y) * s;
      if (rad) {
        const nx = x * cos - y * sin;
        y = x * sin + y * cos;
        x = nx;
      }
      out.push({ x: x + (Number(cmd.x) || 0), y: y + (Number(cmd.y) || 0) });
    }
  }
  return out;
}

/* 挤成多边形的这一档别再让 css 挪一遍剪影：两条都留就是一片硬边落影外加一团雾。 */
export function cssFilterOf(filter) {
  if (!filter) return null;
  if (!Array.isArray(filter)) return shadowWithH(filter) ? null : filter;
  const kept = filter.filter((one) => !shadowWithH(one));
  if (!kept.length) return null;
  return kept.length === filter.length ? filter : kept;
}

export function oneFilterStyle(filter, ctx) {
  if (filter.type === "shadow") {
    const { dx, dy } = shadowOffset(filter, ctx);
    return `drop-shadow(${dx}px ${dy}px ${filter.r}px ${filter.color})`;
  }
  if (filter.type === "glow") {
    return `drop-shadow(0 0 ${filter.r}px ${filter.color}) drop-shadow(0 0 ${filter.r / 2}px ${filter.color})`;
  }
  if (filter.type === "gray") return `grayscale(${filter.k})`;
  if (filter.type === "bright") return `brightness(${filter.k})`;
  if (filter.type === "contrast") return `contrast(${filter.k})`;
  return `blur(${filter.r}px)`;
}

/* 一条指令画成一个 svg 节点。落笔过程中也用它画那根还在动的临时笔画，
   这样「预览」和「松手之后的样子」一定是同一套代码算出来的。
   ctx = {defs, symbols, view, defCache, light, face}：这一块的 <defs>，渐变、图案、素材都往里面现造；
   light 是这块的一套光，face 是当下生效的那个朝向（group / use 往下传，子自己写了算子的用子那个）。 */
export function renderPictureCmd(cmd, ctx) {
  /* 朝向是从上往下继承的：一块墙上摆十扇窗，只在 group 上写一次 face 就够。
     没打光的块两个条件都不成立，ctx 原样往下走——那条红线要求它的输出和今天逐字相同。 */
  const face = cmd.face || ctx?.face || "";
  const lctx = face === (ctx?.face || "") ? ctx : { ...ctx, face };
  /* 挂在组上的落影规格往下传：组里每一笔各自挤自己那一片，而不是整组挤一大片 */
  const groupCast = cmd.op === "group" ? shadowWithH(cmd.filter) || ctx?.cast : null;
  const cctx = groupCast ? { ...lctx, cast: groupCast } : lctx;
  let node = pictureCmdNode(cmd, cctx);
  if (!node) return null;
  /* 一条滤镜就是一次离屏合成，整幅每条都挂会掉帧——手册里劝过，这里只管照写。
     先给形状自己，再套落影：糊边是糊形状，不该把地上那片影子一起糊了。 */
  const css = cssFilterOf(cmd.filter);
  if (css) node.style.filter = filterStyleOf(css, lctx);
  const cast = castShadowOf(cmd, cctx);
  if (cast) {
    const g = pictureNode("g", {});
    g.append(castShadowNode(cast, cctx), node);
    node = g;
  }
  if (cmd.blend) node.style.mixBlendMode = cmd.blend;
  /* 剪刀和遮罩挂在这一层的外壳上。group / use / 转过的 image 自己身上带 transform，
     直接挂会让剪刀跟着一起挪一起转——「窗子在墙上，纸在窗里」应该是窗不动纸动。
     套一层没有变换的外壳，剪刀就稳稳落在这一层自己的坐标系里：和橡皮判的同一套坐标。 */
  const carriesTransform = cmd.op === "group" || cmd.op === "use" || (cmd.op === "image" && cmd.rotate);
  if ((cmd.clip || cmd.mask) && carriesTransform) {
    const shell = pictureNode("g", {});
    shell.append(node);
    node = shell;
  }
  if (cmd.clip) {
    const clip = clipAttr(cmd.clip, ctx);
    if (clip) node.setAttribute("clip-path", clip);
  }
  if (cmd.mask) {
    const mask = maskAttr(cmd.mask, ctx);
    if (mask) node.setAttribute("mask", mask);
  }
  return node;
}

export function pictureCmdNode(cmd, ctx) {
  if (cmd.op === "rect") {
    const fill = paintAttr(litPaint(cmd.fill, ctx), ctx);
    const stroke = paintAttr(cmd.stroke, ctx);
    const node = pictureNode("rect", {
      x: cmd.x,
      y: cmd.y,
      width: cmd.w,
      height: cmd.h,
      rx: cmd.radius,
      "stroke-width": cmd.strokeWidth,
      "fill-opacity": cmd.fill && cmd.opacity < 1 ? cmd.opacity : "",
      "stroke-opacity": cmd.stroke && cmd.opacity < 1 ? cmd.opacity : "",
    });
    /* svg 的 fill 默认是黑色：只想描边的矩形不写 fill 就会糊成一坨实心，
       所以没漆也得显式写 none，这一条不能走「空值省属性」那套 */
    node.setAttribute("fill", fill || "none");
    if (stroke) node.setAttribute("stroke", stroke);
    return node;
  }
  if (cmd.op === "poly" || cmd.op === "line") {
    const fill = paintAttr(litPaint(cmd.fill, ctx), ctx);
    const stroke = paintAttr(cmd.stroke, ctx);
    const closed = cmd.op === "poly";
    const shape = {
      stroke: stroke || "",
      "stroke-width": cmd.strokeWidth,
      "stroke-linecap": cmd.cap,
      "stroke-linejoin": "round",
      "fill-opacity": cmd.fill && cmd.opacity < 1 ? cmd.opacity : "",
      "stroke-opacity": cmd.stroke && cmd.opacity < 1 ? cmd.opacity : "",
    };
    /* 一点控制点都没写就还是 polyline / polygon，输出和以前一模一样；
       写了才换成 path，因为只有 path 认 C 段 */
    const node = hasHandles(cmd.points)
      ? pictureNode("path", { d: edgePath(cmd.points, closed), ...shape })
      : pictureNode(closed ? "polygon" : "polyline", {
          points: cmd.points.map((p) => `${p.x},${p.y}`).join(" "),
          ...shape,
        });
    node.setAttribute("fill", fill || "none");
    return node;
  }
  if (cmd.op === "stroke") {
    const points = cmd.points;
    const fade = cmd.opacity < 1 ? cmd.opacity : "";
    /* 墨不吃光：一笔墨是贴在面上的黑，不是受光的立面。给 use 写了 face 曾连着素材里的
       黑线一起调亮，k 一大小人就变成纸片白——漆才跟着明暗走，墨守住自己。 */
    const ink = cmd.color;
    /* 一个点就是戳一下：没有方向可推法线，画个圆点 */
    if (points.length === 1) {
      return pictureNode("circle", {
        cx: points[0].x,
        cy: points[0].y,
        r: strokeRadiusOf(points[0], cmd.size),
        fill: ink,
        "fill-opacity": fade,
      });
    }
    const grain = Number(cmd.grain) || 0;
    if (grain > 0) {
      /* 所有股塞进同一条 path 的多个子路径：DOM 还是一个节点，expanded 不用跟着涨，
         几百根丝也只多占一条 path 的 d。拆不出丝（点太少）就当没起枯，别画成空的 */
      const d = grainStrands(points, cmd.size, grain).join(" ");
      if (d) {
        return pictureNode("path", {
          d,
          fill: ink,
          "fill-opacity": fade,
          stroke: "none",
        });
      }
    }
    const uniform = strokeUniformWidth(points, cmd.size);
    const node = uniform
      ? pictureNode("path", {
          d: strokeCenterPath(points),
          stroke: ink,
          "stroke-width": uniform,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          "stroke-opacity": fade,
        })
      : pictureNode("path", {
          d: strokeOutlinePath(points, cmd.size),
          fill: ink,
          "fill-opacity": fade,
        });
    /* 同 poly 那条规矩：fill / stroke 不写就得显式给 none，默认值是黑的 */
    node.setAttribute(uniform ? "fill" : "stroke", "none");
    return node;
  }
  if (cmd.op === "text") {
    const node = pictureNode("text", {
      x: cmd.x,
      y: cmd.y,
      "font-size": cmd.size,
      "font-weight": cmd.weight === "bold" ? "bold" : "",
      "font-family": PICTURE_FAMILIES[cmd.font] || PICTURE_FAMILIES.sans,
      /* 字是墨，跟着上一条规矩走：只上在墙上的漆随光明暗，题字和招牌的黑不跟着跑 */
      fill: cmd.color,
      "fill-opacity": cmd.opacity < 1 ? cmd.opacity : "",
      transform: cmd.rotate ? `rotate(${cmd.rotate} ${cmd.x} ${cmd.y})` : "",
    });
    node.textContent = cmd.text;
    return node;
  }
  if (cmd.op === "group") {
    const g = pictureNode("g", {
      transform: `translate(${cmd.x} ${cmd.y}) rotate(${cmd.rotate}) scale(${cmd.scale})`,
    });
    for (const child of cmd.cmds) {
      const node = renderPictureCmd(child, ctx);
      if (node) g.append(node);
    }
    return g;
  }
  /* 摆素材：本体是 defs 里那一份 <g>，这里只写落点。
     素材声明的落点 (ox,oy) 正好压到 (x,y) 上，旋转缩放都绕这个点。 */
  if (cmd.op === "use") {
    const view = symbolView(ctx?.symbols, ctx?.view || new Map(), cmd);
    if (!view) return null;
    const node = pictureNode("use", {
      transform: `translate(${cmd.x} ${cmd.y}) rotate(${cmd.rotate}) scale(${cmd.scale}) translate(${-view.symbol.ox} ${-view.symbol.oy})`,
      opacity: cmd.opacity < 1 ? cmd.opacity : "",
    });
    node.setAttribute("href", `#${pictureSymbolDef(view, ctx)}`);
    return node;
  }
  /* 垫一张位图。旋转绕框中心，和 group / use 绕落点不一样——参考图是「框里的一张纸」，
     转的时候它原地转，不该甩到左上角那个落点上去。
     图没到（地址取不到）就画一个同框的虚线框：位置和尺寸都还在，不至于看着像这条指令凭空丢了。 */
  if (cmd.op === "image") {
    const cx = cmd.x + cmd.w / 2;
    const cy = cmd.y + cmd.h / 2;
    const transform = cmd.rotate ? `rotate(${cmd.rotate} ${cx} ${cy})` : "";
    const fade = cmd.opacity < 1 ? cmd.opacity : "";
    const url = ctx?.media ? ctx.media(cmd.src) || "" : "";
    if (!url) {
      return pictureNode("rect", {
        x: cmd.x,
        y: cmd.y,
        width: cmd.w,
        height: cmd.h,
        fill: "none",
        stroke: "#9a9a9a",
        "stroke-width": 2,
        "stroke-dasharray": "8 6",
        "stroke-opacity": 0.7,
        opacity: fade,
        transform,
      });
    }
    const node = pictureNode("image", {
      x: cmd.x,
      y: cmd.y,
      width: cmd.w,
      height: cmd.h,
      preserveAspectRatio: cmd.fit === "fill" ? "none" : "xMidYMid meet",
      opacity: fade,
      transform,
      /* 导出和截图要把图内联成 data:（那张画布走的是 data: URL 的 svg，里头不许再联网取资源），
         而手上的地址是 tauri 那个本地 URL，倒推不回 src——所以把 src 和存法一起留在节点上 */
      "data-picture-src": cmd.src,
      "data-picture-linked": cmd.linked ? "1" : "",
    });
    node.setAttribute("href", url);
    return node;
  }
  return null;
}

/* 裁剪框用块自己的尺寸：画面坐标可以跑到框外，框外那部分不显示但数据还在，
   把块拉大或以后挪裁剪框就能看见。 */
export function syncPictureElement(el, item) {
  const card = el.querySelector(".canvas-picture-card");
  if (!card) return;
  card.style.background = item.paperColor || "transparent";
  /* 圆角要跟着块走：卡片 overflow:hidden 裁画面，半径不一致就会露出直角 */
  card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  const svg = card.querySelector(".canvas-picture-svg");
  if (!svg) return;
  const w = Math.max(1, Math.round(item.w));
  const h = Math.max(1, Math.round(item.h));
  let clipId = svg.querySelector("clipPath")?.id || "";
  if (!clipId) {
    pictureClipSeq += 1;
    clipId = `canvas-picture-clip-${pictureClipSeq}`;
    const defs = pictureNode("defs", {});
    const clip = pictureNode("clipPath", { id: clipId });
    clip.append(pictureNode("rect", { x: 0, y: 0, width: w, height: h }));
    const body = pictureNode("g", { "clip-path": `url(#${clipId})` });
    defs.append(clip);
    svg.append(defs, body);
  } else {
    const rect = svg.querySelector("clipPath rect");
    if (rect) {
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(h));
    }
  }
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  /* 只认 svg 的直接子节点：defs 排在 body 前面，素材实例就是 defs 里的 <g>，
     按标签名 querySelector("g") 会把 body 认成某个素材节点——那个节点随后就被清掉，
     新画的一整串塞进了脱离文档的枝上，块上只剩旧指令的描边，渐变图案 use 全空。 */
  const body = svg.querySelector(":scope > g");
  const defs = svg.querySelector("defs");
  if (!body || !defs) return;
  /* 每幅重画先把上一轮现造的 defs 清掉：渐变、素材、图案的 id 都是递增的，不清就一路堆下去 */
  for (const stale of [...defs.querySelectorAll("linearGradient, radialGradient, [data-canvas-picture-def]")]) {
    stale.remove();
  }
  const ctx = {
    defs,
    symbols: item.symbols || null,
    /* 一套光挂在块上：指令里存的仍是固有色，明暗每次现算。
       没写 light 的块这儿是 null，往下一个调色分支都进不去，输出和没做这功能时逐字相同。 */
    light: item.light || null,
    view: new Map(),
    defCache: new Map(),
    media: pictureMedia,
    /* 遮罩的生效区域按整块画区算（userSpaceOnUse）：不锁死的话它只覆盖被遮元素自己
       外扩 10% 的包围盒，一条长渐变的淡出会被齐根截断 */
    box: { w, h },
  };
  body.replaceChildren(
    /* 先按块上的图层开关过一遍：关掉的层是真不画，不是画成透明——
       画成透明的话导出、截图、橡皮都还得再判一次，早晚对不上 */
    ...pictureTopLayers(item.cmds, item.hidden)
      .filter((one) => one.drawn)
      .map(({ cmd, drawn }) => {
        const node = renderPictureCmd(drawn, ctx);
        /* 号记在节点上：橡皮拖动时按号把命中的那几条临时藏起来，不必整幅重画 */
        if (node) node.dataset.cmd = String(cmd.i);
        return node;
      })
      .filter(Boolean),
  );
}

/* 场景块：把这一块的当前数据交给渲染器。渲染器内部第一次会去拉 three.js，
   拉之前这块只有那句「场景加载中…」，拉到之后每次同步都是重画一帧。 */
export function syncSceneElement(el, item) {
  const view = el.querySelector(".canvas-scene-view");
  if (view) syncScene(view, item);
}

export function syncItemElement(el, item) {
  el.classList.toggle("is-locked", Boolean(item.locked));
  /* 锁点跟着块的圆角往里收：圆角越大，点离角越远，免得落进圆角缺口被边框压住。
     值是世界坐标，跟着相机一起缩放。 */
  el.style.setProperty("--lock-inset", `${Number.isFinite(item.radius) ? Math.max(0, item.radius) : 0}px`);
  el.style.left = `${item.x}px`;
  el.style.top = `${item.y}px`;

  if (item.type === "line" || item.type === "arrow") {
    const points = linePoints(item);
    el.style.left = `${Math.min(item.x, item.x2)}px`;
    el.style.top = `${Math.min(item.y, item.y2)}px`;
    el.style.width = `${points.w}px`;
    el.style.height = `${points.h}px`;
    const svg = el.querySelector(".canvas-line-svg");
    svg.setAttribute("viewBox", `0 0 ${points.w} ${points.h}`);
    for (const line of svg.querySelectorAll("line")) {
      line.setAttribute("x1", String(points.x1));
      line.setAttribute("y1", String(points.y1));
      line.setAttribute("x2", String(points.x2));
      line.setAttribute("y2", String(points.y2));
    }
    const visible = svg.querySelector(".canvas-line-visible");
    visible.setAttribute("stroke", item.borderColor || "transparent");
    const head = svg.querySelector("marker path");
    if (head) head.setAttribute("fill", item.borderColor || "transparent");
    return;
  }

  if (item.type === "text") {
    el.style.width = `${item.w}px`;
    el.style.minHeight = item.minH ? `${item.minH}px` : "";
    el.style.fontSize = `${item.fontSize}px`;
    el.style.color = item.color || "";
    el.style.background = item.fillColor || "transparent";
    el.style.textAlign = item.align || "left";
    el.style.justifyContent =
      item.vAlign === "middle" ? "center" : item.vAlign === "bottom" ? "flex-end" : "flex-start";
    if (item.borderColor) el.style.setProperty("--text-border", item.borderColor);
    else el.style.removeProperty("--text-border");
    el.classList.toggle("is-bordered", Boolean(item.bordered));
    /* 没有边框时宽度交回样式表的透明虚线，别让边框宽度偷偷吃掉内容宽 */
    el.style.borderWidth = item.bordered
      ? `${Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH}px`
      : "";
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : TEXT_DEFAULT_RADIUS}px`;
    return;
  }

  if (item.type === "audio") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    return;
  }

  /* 视频壳、文件卡片、笔记和书页的排版都在卡片自己手里，这里只管按块的宽高摆位置 */
  if (
    item.type === "video" ||
    item.type === "file" ||
    item.type === "ebook" ||
    item.type === "note"
  ) {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    if (item.type === "note") syncNoteColors(el, item);
    else if (item.type === "file") syncFileColors(el, item);
    return;
  }

  if (item.type === "picture") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncPictureElement(el, item);
    return;
  }

  if (item.type === "scene") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncSceneElement(el, item);
    return;
  }

  if (item.type === "gen") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncGen(el, item);
    return;
  }

  if (item.type === "genvideo") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    return;
  }

  if (item.type === "product") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncProductElement(el, item);
    return;
  }

  if (item.type === "quote") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncQuoteColors(el, item);
    return;
  }

  if (item.type === "plan") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncPlanElement(el, item);
    return;
  }

  if (item.type === "page") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    const card = el.querySelector(".canvas-page-card");
    if (card) {
      card.style.background = item.fillColor || "#ffffff";
      card.style.borderRadius = `${Math.max(0, Math.round(Number(item.radius) || 0))}px`;
    }
    const label = el.querySelector(".canvas-page-label");
    if (label) label.textContent = `P${item.order || "?"} · ${item.title || "未命名页"}`;
    return;
  }

  el.style.width = `${item.w}px`;
  el.style.height = `${item.h}px`;
  if (item.type === "image") {
    // 用内偏移描边，不动布局，图片按比例缩放时不会抖
    const width = Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH;
    const radius = Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS;
    el.style.outline = item.borderColor && width > 0 ? `${width}px solid ${item.borderColor}` : "none";
    el.style.outlineOffset = `-${width}px`;
    /* 外壳和图片都交给圆角，描边才跟得上图片的边 */
    el.style.borderRadius = `${radius}px`;
    const img = el.querySelector(".canvas-image");
    if (img) img.style.borderRadius = `${radius}px`;
    return;
  }
  el.style.borderColor = item.borderColor || "transparent";
  el.style.background = item.fillColor || "transparent";
  el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH}px`;
  if (item.type === "rect") {
    el.style.borderRadius = item.radius ? `${item.radius}px` : "";
  }
}

/* ---------- 连线渲染 ---------- */

export function createArrowMarker(id, color) {
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", id);
  marker.setAttribute("viewBox", "0 0 6 6");
  marker.setAttribute("refX", "5.4");
  marker.setAttribute("refY", "3");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const head = document.createElementNS(SVG_NS, "path");
  head.setAttribute("d", "M0 0 L6 3 L0 6 Z");
  head.setAttribute("fill", color);
  marker.append(head);
  return marker;
}

export function createConnectorElement(item) {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("canvas-connector");
  group.dataset.id = item.id;

  /* 箭头 marker 一次建好，之后切换箭头样式不用重造节点 */
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.append(createArrowMarker(`edge-arrow-${item.id}`, item.color));
  group.append(defs);

  const visible = document.createElementNS(SVG_NS, "path");
  visible.classList.add("canvas-edge-visible");
  /* 选中态画在线条底下：一条半透明粗光带，不覆盖线条本色 */
  const halo = document.createElementNS(SVG_NS, "path");
  halo.classList.add("canvas-edge-halo");
  /* 2px 的线太细，叠一条透明宽线专门接指针 */
  const hit = document.createElementNS(SVG_NS, "path");
  hit.classList.add("canvas-edge-hit");

  /* 连线中间的文字：位置每次跟着路径现算，没写字时整层不显示 */
  const label = document.createElementNS(SVG_NS, "g");
  label.classList.add("canvas-edge-label");
  const labelText = document.createElementNS(SVG_NS, "text");
  labelText.classList.add("canvas-edge-label-text");
  labelText.setAttribute("text-anchor", "middle");
  labelText.setAttribute("dominant-baseline", "middle");
  label.append(labelText);

  group.append(halo, visible, hit, label);
  syncConnectorElement(group, item, null);
  return group;
}

/* 标签落在连线中点：折线、曲线都按路径长度取，取不到就退到两端的中间 */
export function connectorLabelPoint(group, geometry) {
  const path = group?.querySelector(".canvas-edge-visible");
  if (path) {
    try {
      const length = path.getTotalLength();
      if (length > 0) {
        const point = path.getPointAtLength(length / 2);
        return { x: point.x, y: point.y };
      }
    } catch {
      /* 路径还没成形时浏览器会抛，按下面的兜底算 */
    }
  }
  if (!geometry) return null;
  return { x: (geometry.a.x + geometry.b.x) / 2, y: (geometry.a.y + geometry.b.y) / 2 };
}

export function syncConnectorElement(group, item, geometry) {
  const halo = group.querySelector(".canvas-edge-halo");
  const visible = group.querySelector(".canvas-edge-visible");
  const hit = group.querySelector(".canvas-edge-hit");
  const head = group.querySelector("marker path");
  const color = item.color || "transparent";
  if (head) head.setAttribute("fill", color);
  visible.setAttribute("stroke", color);

  if (item.arrow === "none") {
    visible.removeAttribute("marker-end");
    visible.removeAttribute("marker-start");
  } else {
    visible.setAttribute("marker-end", `url(#edge-arrow-${item.id})`);
    if (item.arrow === "both") visible.setAttribute("marker-start", `url(#edge-arrow-${item.id})`);
    else visible.removeAttribute("marker-start");
  }

  if (!geometry) {
    group.setAttribute("visibility", "hidden");
    return;
  }
  group.removeAttribute("visibility");
  visible.setAttribute("d", geometry.d);
  hit.setAttribute("d", geometry.d);
  if (halo) halo.setAttribute("d", geometry.d);

  const label = group.querySelector(".canvas-edge-label");
  const labelText = group.querySelector(".canvas-edge-label-text");
  const content = String(item.label || "").trim();
  if (!label || !labelText) return;
  if (!content) {
    label.setAttribute("visibility", "hidden");
    return;
  }
  label.removeAttribute("visibility");
  labelText.textContent = content;
  labelText.setAttribute("fill", color);
  const point = connectorLabelPoint(group, geometry);
  if (point) {
    labelText.setAttribute("x", String(point.x));
    labelText.setAttribute("y", String(point.y));
  }
}

/** 把屏幕尺寸按比例塞进 IMAGE_MAX_SIDE，并保持宽高比。 */
export function fitImageSize(width, height) {
  const w = Math.max(8, width || 120);
  const h = Math.max(8, height || 120);
  const ratio = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
  return { w: Math.round(w * ratio), h: Math.round(h * ratio) };
}

/** 按视频真实比例算块大小：长边不超过 VIDEO_MAX_SIDE，算上底部控制条的高度。 */
export function fitVideoSize(width, height) {
  const w = Math.max(VIDEO_MIN_WIDTH, width || VIDEO_DEFAULT_WIDTH);
  const h = Math.max(60, height || VIDEO_DEFAULT_HEIGHT);
  const ratio = Math.min(1, VIDEO_MAX_SIDE / Math.max(w, h));
  return {
    w: Math.round(w * ratio),
    h: Math.round(h * ratio) + VIDEO_ROW_HEIGHT,
  };
}
