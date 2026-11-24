/* 导出：把这一屏的块画成一张图（PNG），或包成一页 PDF。
 *
 * 做法：不重画一遍，而是把世界里那份 DOM 原样克隆下来，塞进一个
 * <foreignObject>，让浏览器自己再排一次版、再光栅化一次 —— 这样文字换行、
 * 圆角、配色、笔记里的 Markdown 全都不用手写第二套渲染。
 *
 * 几个必须自己处理的坑：
 *   - 图片走 asset 协议，是另一个源，直接画会污染画布。所以图片一律先让后端
 *     读成 data URL 再换进去（见 canvas_image_data）。
 *   - <canvas>（PDF 那一页）里的像素不会被序列化，先 toDataURL 换成 <img>。
 *   - <video> 和沙箱里的电子书页是跨进程的东西，序列化不过去，换成等尺寸的占位块。
 *   - 样式表要跟着搬进去：SVG 当图片加载时不认外面的 CSS，只能把规则整份塞进 <style>，
 *     再补一份当前主题的 CSS 变量（:root 对外层文档有效，对 SVG 里的根不生效）。
 */

/* SVG 光栅化和 base64 这两条抽到 raster.js 了：生图面板取输入图走同一份实现 */
import { bytesToBase64, rasterize } from "./raster.js";

export { QUALITY, DEFAULT_QUALITY } from "./export/core.js";
import { QUALITY, DEFAULT_QUALITY, EXPORT_CSS, MAX_PIXELS, MAX_SEGMENT_PIXELS, MAX_SIDE, OVERLAY_SELECTOR, PADDING, SEGMENT_PIXELS, SVG_NS, TILE, XHTML_NS, base64ToBytes, buildPdf, buildPdfPages, collectCss, themeVars } from "./export/core.js";
import { CARD_FILL, FONT_STACK_ATTR, VIEWER_CSS, VIEWER_SCRIPT, WECHAT_PAGE_CSS, WECHAT_PAGE_SCRIPT } from "./export/assets.js";

export function createExporter({
  getItems,
  getWorld,
  getEdgeG,
  getBounds,
  getMeta,
  getStage,
  getPageWidth,
  getViewportBox,
  loadImageData,
  onError,
}) {
  function contentBox(items) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const item of items) {
      if (item.type === "connector") continue;
      const bounds = getBounds(item);
      if (!bounds) continue;
      left = Math.min(left, bounds.x);
      top = Math.min(top, bounds.y);
      right = Math.max(right, bounds.x + bounds.w);
      bottom = Math.max(bottom, bounds.y + bounds.h);
    }
    if (!Number.isFinite(left)) return null;
    /* 固定宽度的画布：横向取景钉在页面上（x=0..W），别让内容少一块就露出灰底。
       高度仍按内容走，所以上下不受影响。 */
    const pageWidth = Number(getPageWidth?.()) || 0;
    if (pageWidth > 0) {
      left = Math.min(left, 0);
      right = Math.max(right, pageWidth);
    }
    return {
      x: left - PADDING,
      y: top - PADDING,
      w: right - left + PADDING * 2,
      h: bottom - top + PADDING * 2,
    };
  }

  /* 克隆出来的树里，这些元素留不住也画不出，换成等尺寸的占位 */
  function swapPlaceholder(node, label) {
    const box = document.createElement("div");
    box.className = "canvas-export-placeholder";
    box.textContent = label;
    const style = node.getAttribute("style") || "";
    box.setAttribute(
      "style",
      `${style};display:flex;align-items:center;justify-content:center;width:100%;height:100%;` +
        "background:#1b1b1b;border-radius:8px;color:rgba(255,255,255,0.62);" +
        "font-size:13px;letter-spacing:0.04em;",
    );
    node.replaceWith(box);
  }

  function replaceCanvases(originals, clones) {
    clones.forEach((clone, index) => {
      const source = originals[index];
      if (!source) return;
      let dataUrl = "";
      try {
        dataUrl = source.toDataURL("image/png");
      } catch {
        dataUrl = "";
      }
      if (!dataUrl || dataUrl === "data:,") {
        swapPlaceholder(clone, "画面未能导出");
        return;
      }
      const img = document.createElement("img");
      img.src = dataUrl;
      img.setAttribute(
        "style",
        `${clone.getAttribute("style") || ""};width:100%;height:100%;display:block;`,
      );
      clone.replaceWith(img);
    });
  }

  async function inlineImages(root, canvasId) {
    const images = [...root.querySelectorAll("img")];
    for (const img of images) {
      const src = img.getAttribute("src") || "";
      if (src.startsWith("data:")) continue;
      const holder = img.closest("[data-id]");
      const item = holder ? getItems().find((entry) => entry.id === holder.dataset.id) : null;
      /* 图片、产品卡、户型图和生图面板里的图都是画布 images/ 里的真文件，导出时换成 data:；
         认不出来的别留破图标，直接拿掉 */
      if (!item || !item.src || !["image", "product", "plan", "gen"].includes(item.type)) {
        img.remove();
        continue;
      }
      const linked = item.type === "image" ? Boolean(item.linked) : false;
      try {
        img.src = await loadImageData(canvasId, item.src, linked);
      } catch {
        img.remove();
      }
    }
  }

  /* 画面块里垫的那张位图：同上，data: 的 svg 里不许再去取本地 URL，得换成内联的 data:。
     src 和「拷贝还是引用」就写在节点上（手上那个本地地址倒推不回 src）。
     图本来就没到（读不到文件）时画的是虚线占位框，那是个 rect，压根不在这儿——不用另做处理。 */
  async function inlinePictureImages(root, canvasId) {
    for (const node of root.querySelectorAll("image[data-picture-src]")) {
      const src = node.getAttribute("data-picture-src") || "";
      const linked = node.getAttribute("data-picture-linked") === "1";
      try {
        node.setAttribute("href", await loadImageData(canvasId, src, linked));
      } catch {
        node.remove();
      }
    }
  }

  /* 克隆世界层，顺手把留不住、画不出的东西换掉。
     导出图片和导出网页共用这一段——两种产物要长得一样，就不该有两套准备流程。 */
  async function prepareWorld(onlyId, { hideIds = [], stripIds = [], pageId = "" } = {}) {
    const world = getWorld().cloneNode(true);
    world.removeAttribute("id");
    world.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;");

    /* 导出不看当前视口：克隆里被视口裁剪藏起来的块要全部放出来，
       不然镜头没对着的那一页会少东西 */
    for (const el of world.querySelectorAll(".is-culled")) el.classList.remove("is-culled");

    /* 只导一块时，把别的块从克隆里整个摘掉：画面块底下压着的东西不该跟着进图 */
    if (onlyId) {
      for (const el of world.querySelectorAll(".canvas-item")) {
        if (el.dataset.id !== onlyId) el.remove();
        else {
          /* 导出的是一幅画，不是这块面板的外框：边框和圆角都摘掉 */
          el.style.border = "0";
          el.style.borderRadius = "0";
          el.style.boxShadow = "none";
          for (const card of el.querySelectorAll("*")) {
            if (card.style?.borderWidth) card.style.borderWidth = "0";
            if (card.style?.borderRadius) card.style.borderRadius = "0";
          }
        }
      }
    }

    /* 画板导出：透明模式把画板整个摘掉，含底色模式留底色只摘外框 */
    for (const id of hideIds) {
      for (const el of world.querySelectorAll("[data-id]")) {
        if (el.dataset.id === id) el.remove();
      }
    }
    for (const id of stripIds) {
      const el = [...world.querySelectorAll("[data-id]")].find((node) => node.dataset.id === id);
      if (!el) continue;
      el.style.border = "0";
      el.style.borderRadius = "0";
      el.style.boxShadow = "none";
      for (const node of el.querySelectorAll("*")) {
        node.style.borderWidth = "0";
        node.style.borderRadius = "0";
        node.style.boxShadow = "none";
      }
    }
    /* 提案页框：页面本体留着当底色，只把页名标签、描边和投影摘掉 */
    if (pageId) {
      for (const el of world.querySelectorAll("[data-id]")) {
        if (el.dataset.id !== pageId) continue;
        el.style.border = "0";
        el.style.borderRadius = "0";
        el.style.boxShadow = "none";
        el.style.outline = "none";
        for (const label of el.querySelectorAll(".canvas-page-label")) label.remove();
      }
    }

    /* 记号层先摘掉，再处理留不住的元素 */
    for (const node of world.querySelectorAll(OVERLAY_SELECTOR)) node.remove();

    const canvasOriginals = [...getWorld().querySelectorAll("canvas")];
    const canvasClones = [...world.querySelectorAll("canvas")];
    replaceCanvases(canvasOriginals, canvasClones);

    for (const video of world.querySelectorAll("video")) swapPlaceholder(video, "▶ 视频");
    for (const frameEl of world.querySelectorAll("iframe")) swapPlaceholder(frameEl, "内容未能导出");

    await inlineImages(world, getMeta().id);
    await inlinePictureImages(world, getMeta().id);
    return world;
  }

  /* 造一张 SVG：只画 slice 这块世界区域，输出恰好 pxW×pxH 像素。
     分片渲染时每片都调它一次——世界层在外面只准备一次（prepared），
     这里只做浅克隆，图片已经是 data URL，不会重复读盘。 */
  function buildSvg(slice, prepared, pxW, pxH, only, transparent = false) {
    const stageStyle = getComputedStyle(getStage());
    /* 固定宽度的画布导出的是这张页面：底色用页面白，别把页面外的浅灰带进成品 */
    const background = transparent
      ? "transparent"
      : Number(getPageWidth?.()) > 0
        ? "#ffffff"
        : stageStyle.backgroundColor || "#ffffff";
    const w = Math.max(0.5, slice.w);
    const h = Math.max(0.5, slice.h);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("width", String(Math.max(1, Math.round(pxW))));
    svg.setAttribute("height", String(Math.max(1, Math.round(pxH))));
    /* 应用样式表里有 :root{background:var(--bg)}，序列化成 SVG 图后 :root 是这根 svg，
       会在整张图底下铺一层舞台色。透明导出必须把它内联盖掉，不然 alpha 永远不透明。 */
    if (transparent) svg.style.setProperty("background", "transparent", "important");
    /* viewBox 直接用世界坐标：这片图在世界里的位置由它决定，
       里面的块不用逐个挪，换算全交给浏览器 */
    svg.setAttribute("viewBox", `${slice.x} ${slice.y} ${w} ${h}`);

    const foreign = document.createElementNS(SVG_NS, "foreignObject");
    foreign.setAttribute("x", String(slice.x));
    foreign.setAttribute("y", String(slice.y));
    foreign.setAttribute("width", String(w));
    foreign.setAttribute("height", String(h));

    const host = document.createElementNS(XHTML_NS, "div");
    host.className = "canvas-export-root";
    host.setAttribute(
      "style",
      `position:relative;width:${w}px;height:${h}px;overflow:hidden;` +
        `background:${background};color:${stageStyle.color};font-family:${stageStyle.fontFamily};` +
        `font-size:${stageStyle.fontSize};line-height:${stageStyle.lineHeight};`,
    );

    const style = document.createElementNS(XHTML_NS, "style");
    style.textContent = `${collectCss()}\n${themeVars()}\n${EXPORT_CSS}`;
    host.append(style);

    const frame = document.createElementNS(XHTML_NS, "div");
    frame.setAttribute(
      "style",
      `position:absolute;left:0;top:0;width:${w}px;height:${h}px;overflow:hidden;`,
    );

    /* 世界和连线层都按世界坐标摆，整块挪 -slice.x/-slice.y 就落回画框左上角 */
    const shift = document.createElementNS(XHTML_NS, "div");
    shift.setAttribute(
      "style",
      `position:absolute;left:${-slice.x}px;top:${-slice.y}px;width:0;height:0;`,
    );

    /* 连线层用一块和画框同样大的 SVG，viewBox 直接框住这片世界坐标：
       线本身还是按世界坐标画的，不用再挪一层 */
    const edgeSvg = document.createElementNS(SVG_NS, "svg");
    edgeSvg.setAttribute("width", String(w));
    edgeSvg.setAttribute("height", String(h));
    edgeSvg.setAttribute("viewBox", `${slice.x} ${slice.y} ${w} ${h}`);
    edgeSvg.setAttribute(
      "style",
      `position:absolute;left:0;top:0;overflow:visible;width:${w}px;height:${h}px;`,
    );
    const edgeGroup = only ? null : getEdgeG()?.cloneNode(true);
    if (edgeGroup) {
      edgeGroup.removeAttribute("transform");
      edgeSvg.append(edgeGroup);
    }

    /* 只导一块时，在最靠近渲染的这一层再把外框扒掉：块的外壳边框在 CSS 类上、
       圆角在卡片的内联样式上，准备阶段改一遍、这里再保一遍最稳 */
    const worldClone = prepared.cloneNode(true);
    if (only) {
      for (const el of worldClone.querySelectorAll(".canvas-item")) {
        for (const node of [el, ...el.querySelectorAll("*")]) {
          node.style.borderWidth = "0";
          node.style.borderRadius = "0";
          node.style.boxShadow = "none";
        }
      }
    }
    shift.append(worldClone);
    frame.append(edgeSvg, shift);
    host.append(frame);
    foreign.append(host);
    svg.append(foreign);
    /* 透明导出交给 rasterize 一个 null：那边看到 null 就不铺底色 */
    return { svg, background: transparent ? null : background };
  }

  /* 把 slice 这块世界区域画成一张画布，内部按 TILE 分片。
     分片只管峰值内存，不影响成品像素：片与片按整数像素对齐，拼起来是连续的。 */
  async function renderRegion(prepared, slice, pxW, pxH, scale, onProgress, only, transparent = false) {
    const width = Math.max(1, Math.round(pxW));
    const height = Math.max(1, Math.round(pxH));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!transparent) {
      const background = getComputedStyle(getStage()).backgroundColor || "#ffffff";
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }

    const cols = Math.ceil(width / TILE);
    const rows = Math.ceil(height / TILE);
    let done = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const ox = col * TILE;
        const oy = row * TILE;
        const tw = Math.min(TILE, width - ox);
        const th = Math.min(TILE, height - oy);
        /* 片的世界坐标由「像素 ÷ 比例尺」倒推，保证和最终像素严格对齐 */
        const part = {
          x: slice.x + ox / scale,
          y: slice.y + oy / scale,
          w: tw / scale,
          h: th / scale,
        };
        const built = buildSvg(part, prepared, tw, th, only, transparent);
        const tile = await rasterize(built.svg, tw, th, built.background);
        ctx.drawImage(tile, ox, oy);
        done += 1;
        onProgress?.(done, cols * rows);
        /* 让出一帧：几百个块重排一次版不算快，不让出来窗口会假死 */
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return canvas;
  }

  const escapeText = (text) =>
    String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* 单文件网页：同一张画布，打包成一个双击就能打开的 .html。
   *
   * 和 PNG 的差别是「活的」：接收方不用装这个软件，能拖着看、滚轮缩放。
   * 代价是要带着整套 CSS 走（几百 KB），换来的是版式和屏幕上完全一致。
   */
  async function buildHtml(box, name) {
    const stageStyle = getComputedStyle(getStage());
    const background = stageStyle.backgroundColor || "#ffffff";

    const world = await prepareWorld();

    /* 连线层：没有 viewBox 的 SVG，1 用户单位就是 1px，线照旧按世界坐标画。
       overflow 要放开，不然画框外的线会被自己裁掉 */
    const edgeSvg = document.createElementNS(SVG_NS, "svg");
    edgeSvg.setAttribute(
      "style",
      "position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;",
    );
    const edgeGroup = getEdgeG()?.cloneNode(true);
    if (edgeGroup) {
      edgeGroup.removeAttribute("transform");
      edgeSvg.append(edgeGroup);
    }

    const stage = document.createElement("div");
    stage.id = "stage";
    stage.setAttribute(
      "style",
      "position:absolute;left:0;top:0;transform-origin:0 0;" +
        `font-family:${stageStyle.fontFamily};font-size:${stageStyle.fontSize};` +
        `line-height:${stageStyle.lineHeight};color:${stageStyle.color};`,
    );
    stage.append(edgeSvg, world);

    const view = document.createElement("div");
    view.id = "view";
    /* 必须挂上 canvas-stage 这个类：块的样式里有不少是 .canvas-stage 的后代选择器，
       少了它，卡片会掉内边距和阴影 */
    view.className = "canvas-stage";
    view.setAttribute(
      "style",
      "position:fixed;inset:0;overflow:hidden;cursor:grab;" +
        `background-color:${background};color:${stageStyle.color};`,
    );
    view.append(stage);

    const css = `${collectCss()}\n${themeVars()}\n${EXPORT_CSS}\n${VIEWER_CSS}`.replace(
      /<\/style/gi,
      "<\\/style",
    );
    const script = VIEWER_SCRIPT.replace(
      "__BOX__",
      JSON.stringify({
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.max(1, Math.round(box.w)),
        h: Math.max(1, Math.round(box.h)),
      }),
    );

    return [
      "<!doctype html>",
      '<html lang="zh">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${escapeText(name)}</title>`,
      "<style>",
      css,
      "</style>",
      "</head>",
      `<body style="margin:0;height:100vh;overflow:hidden;background:${background}">`,
      view.outerHTML,
      `<p class="export-hint">${escapeText(name)} · 拖动平移 · 滚轮缩放 · 双击复位</p>`,
      `<script>${script}</script>`,
      "</body>",
      "</html>",
    ].join("\n");
  }

  /* ---------------- 公众号文章 ----------------
   *
   * 微信编辑器只认「内联样式」：class 会被剥掉，<style> 会被丢掉，
   * 绝对定位和 flex 粘过去会散架。所以这里不是把画布 1:1 搬过去，
   * 而是照它的层级和配色重排一遍——先后顺序、字号、颜色都对得上，
   * 版式换成公众号自己的流。
   *
   * 结构推断只有三条规则，够用且不猜：
   *   1. 装得下一个文字块的矩形 = 卡片（画布的卡片、时间轴、引文框都是这个形状）
   *   2. 装下多个文字块的矩形 = 分组容器，不输出（它只是把东西圈起来）
   *   3. 高度个位数的矩形 = 分隔线，圆圈和直线是装饰，丢掉
   */

  function escapeMulti(text) {
    return String(text).split("\n").map(escapeText).join("<br>");
  }

  /* 画布字号 → 公众号字号。公众号正文 17px、注释 15px 是常见做法，
     卡片里再收一档，不然一屏只能放三行。 */
  function wechatFontSize(item, inCard) {
    const size = Number(item.fontSize) || 16;
    if (inCard) return Math.max(13, Math.min(16, Math.round(size * 0.88)));
    if (size >= 60) return 38;
    if (size >= 32) return 26;
    if (size >= 22) return 20;
    if (size >= 19) return 17;
    if (size >= 17.5) return 16;
    return 15;
  }

  /* 把画布摊成一条竖向序列：卡片、独立文字、分隔线、图片各占一个节点 */
  function articleNodes(items) {
    const rects = [];
    const texts = [];
    const rules = [];
    const media = [];

    for (const item of items) {
      if (item.type === "connector" || item.type === "line" || item.type === "arrow") continue;
      if (item.type === "rect") {
        if (item.h <= 8 || item.w <= 8) rules.push(item);
        else rects.push(item);
      } else if (item.type === "text") {
        if (String(item.text || "").trim()) texts.push(item);
      } else if (
        item.type === "image" ||
        item.type === "video" ||
        item.type === "audio" ||
        item.type === "ebook"
      ) {
        media.push(item);
      }
      /* 剩下的（圆圈、箭头之类）是画布上的装饰记号，文章里没有对应物，丢掉 */
    }

    /* 每个文字块认一个宿主矩形：能装下它的里面挑面积最小的那个，
       嵌套的分组框因此不会把卡片抢走 */
    const hostOf = new Map();
    for (const text of texts) {
      let host = null;
      for (const rect of rects) {
        if (text.x < rect.x - 3 || text.y < rect.y - 3) continue;
        if (text.x + text.w > rect.x + rect.w + 8) continue;
        if (text.y + text.h > rect.y + rect.h + 14) continue;
        if (!host || rect.w * rect.h < host.w * host.h) host = rect;
      }
      if (host) hostOf.set(text.id, host);
    }

    /* 只有「独生子」矩形才算卡片；装了好几个的是分组容器，跳过 */
    const members = new Map();
    for (const [textId, rect] of hostOf) {
      if (!members.has(rect.id)) members.set(rect.id, []);
      members.get(rect.id).push(textId);
    }
    const cardOf = new Map();
    for (const [rectId, textIds] of members) {
      if (textIds.length !== 1) continue;
      cardOf.set(textIds[0], rects.find((rect) => rect.id === rectId));
    }

    const nodes = [];
    for (const text of texts) {
      const card = cardOf.get(text.id);
      nodes.push({
        kind: card ? "card" : "text",
        card,
        text,
        x: card ? card.x : text.x,
        y: card ? card.y : text.y,
      });
    }
    for (const rule of rules) nodes.push({ kind: "rule", x: rule.x, y: rule.y });
    for (const item of media) nodes.push({ kind: "media", item, x: item.x, y: item.y });

    /* 同一行的东西（两列卡片）按 x 从左往右，其余按 y 从上往下 */
    nodes.sort((a, b) => (Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x));
    return nodes;
  }

  function renderWechatText(item) {
    const size = wechatFontSize(item, false);
    const raw = Number(item.fontSize) || 16;
    const color = item.color || "#2b2622";
    const body = String(item.text);
    /* 大字号 + 短句才算标题：导语那种字号不小、整段几行的，留在正文里 */
    const isTitle = raw >= 60;
    const isHeading = !isTitle && (raw >= 32 || (raw >= 23 && body.length <= 30 && !body.includes("\n")));
    const margin = isTitle ? "0 0 18px" : isHeading ? "34px 0 14px" : "0 0 16px";
    const lineHeight = isTitle ? 1.25 : isHeading ? 1.45 : 1.9;
    const letter = isTitle ? "2px" : isHeading ? "1px" : "0.4px";
    return (
      `<p style="margin:${margin};font-size:${size}px;line-height:${lineHeight};` +
      `color:${color};font-weight:${isTitle || isHeading ? 700 : 400};` +
      `letter-spacing:${letter};text-align:left;">${escapeMulti(body)}</p>`
    );
  }

  /* 卡片内文：首行短、像名字的，提出来当小标题；剩下的降一档、变浅，层次才立得住 */
  function renderWechatCardBody(raw, size) {
    const lines = String(raw)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return "";
    if (lines.length === 1) return escapeText(lines[0]);
    const head = lines[0];
    const rest = lines.slice(1).map(escapeText).join("<br>");
    const asTitle = head.length <= 12 && !/[。，；：]/.test(head) && lines.length <= 5;
    if (!asTitle) return lines.map(escapeText).join("<br>");
    return (
      `<span style="display:block;font-weight:700;font-size:${size}px;color:#2b2622;margin-bottom:4px;">` +
      `${escapeText(head)}</span>` +
      `<span style="display:block;font-size:${Math.max(12, size - 1)}px;color:#5b5248;line-height:1.75;">` +
      `${rest}</span>`
    );
  }

  function renderWechatCard(node) {
    const { card, text } = node;
    const size = wechatFontSize(text, true);
    const color = text.color || "#3a332c";
    const fill = card.fillColor || CARD_FILL;
    const border = card.borderColor || "#e6d8c4";
    const radius = Math.max(6, Math.min(12, Number(card.radius) || 8));
    /* 底色和默认卡片不一样的，当成强调块（引文框就是这种），给一道左侧竖线 */
    const accent = String(fill).toLowerCase() !== CARD_FILL;
    const skin = accent
      ? `background:${fill};border-left:3px solid ${border};`
      : `background:${fill};border:1px solid ${border};`;
    return (
      `<section style="margin:0 0 12px;padding:13px 16px;${skin}border-radius:${radius}px;` +
      `font-size:${size}px;line-height:1.8;color:${color};letter-spacing:0.3px;">` +
      `${renderWechatCardBody(text.text, size)}</section>`
    );
  }

  function renderWechatBody(nodes) {
    const out = [];
    for (const node of nodes) {
      if (node.kind === "rule") {
        out.push(
          '<section style="height:0;border-top:1px solid #e6d8c4;margin:24px 0;' +
            'font-size:0;line-height:0;">&nbsp;</section>',
        );
      } else if (node.kind === "media") {
        const label = node.item.type === "image" ? "图片" : node.item.type === "video" ? "视频" : "附件";
        out.push(
          `<p style="margin:0 0 14px;padding:10px 12px;background:#f6f1e7;border-radius:6px;` +
            `font-size:13px;line-height:1.7;color:#8a7f70;">［这里有一处${label}，导出时没有带出来——` +
            `到公众号编辑器里单独上传一次就行］</p>`,
        );
      } else if (node.kind === "card") {
        out.push(renderWechatCard(node));
      } else {
        out.push(renderWechatText(node.text));
      }
    }
    return out.join("");
  }

  /* 版式画布：绝对定位在公众号里没法照搬，但字必须是真字——字数统计、
     搜索和推荐都靠正文文本吃饭，整张图等于自废武功。所以按画布的结构
     （年份 / 标题 / 正文 / 当时的世界 / 配图）重排成图文：卡片、红线和
     年份用内联样式还原，图片内嵌成 data:，在页面上右键就能复制。 */
  function layoutBoxOf(items) {
    const box = contentBox(items);
    if (!box) return null;
    const big = items.some(
      (item) =>
        item.type === "picture" &&
        item.w > 0 &&
        item.h > 0 &&
        item.w * item.h >= box.w * box.h * 0.5,
    );
    return big ? box : null;
  }

  function entryText(entry) {
    return String(entry?.item?.text || "").trim();
  }

  function pictureHtml(entry) {
    return (
      '<p style="margin:16px 0 6px;font-size:0;line-height:0;">' +
      `<img src="${entry.url}" alt="" style="width:100%;height:auto;border-radius:8px;display:block;">` +
      "</p>"
    );
  }

  /* 文章里的图走 JPEG、宽度收到 1200：公众号正文最宽 677，再大只是把 HTML 撑成十几兆 */
  function articleImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxW = 1200;
        const ratio = Math.min(1, maxW / Math.max(1, img.width));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * ratio));
        canvas.height = Math.max(1, Math.round(img.height * ratio));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL("image/jpeg", 0.88));
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function buildLayoutArticle(box, name) {
    const items = getItems();
    const canvasId = (getMeta() || {}).id || "";
    const texts = items.filter((item) => item.type === "text" && String(item.text || "").trim());
    const pics = items.filter((item) => item.type === "image" && item.src);
    const entries = [
      ...texts.map((item) => ({ kind: "text", item, y: item.y })),
      ...pics.map((item) => ({ kind: "image", item, y: item.y, url: "" })),
    ].sort((a, b) => a.y - b.y || a.item.x - b.item.x);

    for (const entry of entries) {
      if (entry.kind !== "image") continue;
      try {
        entry.url = await articleImage(
          await loadImageData(canvasId, entry.item.src, Boolean(entry.item.linked)),
        );
      } catch {
        entry.url = "";
      }
    }

    /* 三套版式的年份写法都要认：1964 / T-1971 / 「一 ／ 1949 · 01 · 12」 */
    const yearTextOf = (e) => {
      const t = entryText(e);
      let m = t.match(/^T-(\d{4})$/);
      if (m) return m[1];
      m = t.match(/／\s*(\d{4})/);
      if (m) return m[1];
      m = t.match(/^(\d{4})$/);
      return m ? m[1] : "";
    };
    const isYear = (e) => e.kind === "text" && Boolean(yearTextOf(e)) && Number(e.item.fontSize) >= 18;
    /* 档案版的「01」编号：两位数字的大字，不是年份 */
    const isIndex = (e) =>
      e.kind === "text" && /^\d{1,2}$/.test(entryText(e)) && Number(e.item.fontSize) >= 70;
    const isMonth = (e) =>
      e.kind === "text" &&
      Number(e.item.fontSize) <= 24 &&
      /^\d{1,2}(\s*[·.]\s*\d{1,2})?$/.test(entryText(e));
    const isRed = (e) => e.kind === "text" && /c8102e/i.test(String(e.item.color || e.item.textColor || ""));
    const isLabel = (e) =>
      e.kind === "text" &&
      /^(当时的世界|时代注脚|WORLD|世界 ·)/.test(entryText(e)) &&
      Number(e.item.fontSize) <= 26;
    const isChinaLabel = (e) =>
      e.kind === "text" && (/^CHINA/.test(entryText(e)) || /^中国 ?· ?\d{4}$/.test(entryText(e)));
    const isSmall = (e) => e.kind === "text" && Number(e.item.fontSize) <= 20;

    /* 节点按「标题」分块：三套版式的年份位置不一样（左栏中部 / T-1971 / 小节号），
       但每节都有一个 32–60 号、不是年份标签引语的标题，位置就在节顶。
       封面大标题是 60+，不会混进来。 */
    /* 标题附近 300px 内必须有年份块：封面的大标题旁边没有年份块，会被排除 */
    const yearEntries = entries.filter(isYear);
    const titleAnchors = entries
      .filter(
        (e) =>
          e.kind === "text" &&
          Number(e.item.fontSize) >= 32 &&
          Number(e.item.fontSize) <= 60 &&
          !isYear(e) &&
          !isIndex(e) &&
          !isLabel(e) &&
          !isChinaLabel(e) &&
          !/^「/.test(entryText(e)) &&
          yearEntries.some((y) => Math.abs(y.y - e.y) < 300),
      )
      .sort((a, b) => a.y - b.y);
    if (!titleAnchors.length) return buildArticle(name);

    const lastLabel = [...entries].reverse().find(isLabel);
    const closingStartY = lastLabel ? lastLabel.y + 560 : Infinity;
    const coverEntries = entries.filter((e) => e.y < titleAnchors[0].y - 80);
    const sections = titleAnchors.map((anchor, k) => {
      const upper = k + 1 < titleAnchors.length ? titleAnchors[k + 1].y - 80 : closingStartY;
      return entries.filter((e) => e.y >= anchor.y - 80 && e.y < upper);
    });
    const closingParts = entries.filter((e) => e.y >= closingStartY);

    const html = [];

    /* 封面：眉标（红小字）→ 大标题（合并）→ 副标/引语 → 封面图 */
    const coverTitles = coverEntries.filter((e) => e.kind === "text" && Number(e.item.fontSize) >= 60);
    const titleY = coverTitles.length ? coverTitles[0].y : Infinity;
    const coverRest = coverEntries.filter((e) => !coverTitles.includes(e));
    const coverLine = (entry) => {
      if (entry.kind === "image") {
        if (entry.url) html.push(pictureHtml(entry));
        return;
      }
      const size = Number(entry.item.fontSize) || 16;
      const red = isRed(entry);
      html.push(
        `<p style="margin:0 0 ${size >= 28 ? 12 : 8}px;font-size:${size >= 28 ? 18 : 14}px;` +
          `line-height:1.7;color:${red ? "#C8102E" : size >= 24 ? "#6F675C" : "#2A2620"};` +
          `${red ? "font-weight:700;letter-spacing:1px;" : ""}">${escapeMulti(entryText(entry))}</p>`,
      );
    };
    /* 封面图注跟着图片走，不按坐标插在副标前面 */
    const coverFigure = coverRest.find((e) => e.kind === "image");
    const coverCaption = coverFigure
      ? coverRest.find(
          (e) =>
            e.kind === "text" &&
            Number(e.item.fontSize) <= 22 &&
            Math.abs(e.item.y - (coverFigure.item.y + (coverFigure.item.h || 0))) < 120,
        )
      : null;
    for (const entry of coverRest.filter((e) => e.kind === "text" && e !== coverCaption && e.y < titleY)) coverLine(entry);
    if (coverTitles.length) {
      html.push(
        '<p style="margin:0 0 12px;font-size:34px;line-height:1.3;color:#14110E;font-weight:700;letter-spacing:1px;">' +
          coverTitles.map((e) => escapeText(entryText(e))).join("") +
          "</p>",
      );
    }
    for (const entry of coverRest.filter((e) => e.kind === "text" && e !== coverCaption && e.y >= titleY)) coverLine(entry);
    /* 封面图放在标题和副标后面，文章开头先用文字立住 */
    for (const entry of coverRest.filter((e) => e.kind === "image")) coverLine(entry);
    if (coverCaption) {
      html.push(
        `<p style="margin:6px 0 16px;font-size:12px;line-height:1.6;color:#8a7f70;">${escapeText(entryText(coverCaption))}</p>`,
      );
    }

    /* 节点：年份 → 标题 → 正文 → 配图 → 当时的世界 */
    for (const parts of sections) {
      const year = parts.find(isYear);
      if (!year) continue;
      const month = parts.find(isMonth);
      const title = parts
        .filter(
          (e) =>
            e.kind === "text" &&
            e !== year &&
            e !== month &&
            !isLabel(e) &&
            !isIndex(e) &&
            !isChinaLabel(e) &&
            !isRed(e) &&
            !isSmall(e) &&
            !/^「/.test(entryText(e)),
        )
        .sort((a, b) => Number(b.item.fontSize) - Number(a.item.fontSize))[0];
      const label = parts.find(isLabel);
      const quote = parts.find(
        (e) =>
          e.kind === "text" &&
          Number(e.item.fontSize) >= 22 &&
          Number(e.item.fontSize) <= 40 &&
          /^「/.test(entryText(e)),
      );
      const afterLabel = label
        ? parts
            .filter((e) => e.kind === "text" && e !== label && e.item.y >= label.item.y)
            .sort((a, b) => a.item.y - b.item.y)
        : [];
      const chinaLabel = afterLabel.find(isChinaLabel);
      /* 数据行不再只认红色：档案铜色、蓝图白色、书页棕色、编年双卡都要认。
         特征是「在卡片里、字号小、带数字、够短」。先认数据再认中国行，
         免得「中国钢产量…」这种数据被当成中国正文。 */
      const dataList = afterLabel.filter(
        (e) =>
          e !== chinaLabel &&
          Number(e.item.fontSize) <= 24 &&
          /\d/.test(entryText(e)) &&
          entryText(e).length <= 40,
      );
      const chinaText = afterLabel.find(
        (e) => e !== chinaLabel && !dataList.includes(e) && /^中国/.test(entryText(e)),
      );
      const chinaBody = chinaLabel
        ? afterLabel.find(
            (e) =>
              e !== chinaLabel &&
              e !== chinaText &&
              !dataList.includes(e) &&
              e.item.y > chinaLabel.item.y &&
              Math.abs(Number(e.item.x) - Number(chinaLabel.item.x)) < 40 &&
              Number(e.item.fontSize) <= 22 &&
              !/^中国/.test(entryText(e)),
          )
        : null;
      const img = parts.find((e) => e.kind === "image" && e.url);
      const caption = img
        ? parts.find((e) => isSmall(e) && e !== month && Math.abs(e.y - (img.y + (img.item.h || 0))) < 90)
        : null;
      const worldBody = afterLabel.find(
        (e) =>
          e !== chinaLabel &&
          e !== chinaBody &&
          e !== chinaText &&
          !dataList.includes(e) &&
          Math.abs(Number(e.item.x) - Number(label.item.x)) < 40 &&
          Number(e.item.fontSize) >= 20,
      );
      const body = parts.filter(
        (e) =>
          e.kind === "text" &&
          e !== year &&
          e !== month &&
          e !== title &&
          e !== label &&
          e !== worldBody &&
          e !== chinaText &&
          e !== chinaLabel &&
          e !== chinaBody &&
          e !== caption &&
          !isIndex(e) &&
          !dataList.includes(e) &&
          !isSmall(e) &&
          (!label || e.item.y < label.item.y),
      );

      const chinaLine = chinaText
        ? entryText(chinaText)
        : chinaBody
          ? `中国 · ${yearTextOf(year)}｜${entryText(chinaBody)}`
          : "";

      html.push('<section style="margin:0 0 34px;padding:0 0 0 16px;border-left:3px solid #C8102E;">');
      html.push(
        '<p style="margin:0 0 2px;font-size:40px;line-height:1.1;color:#C8102E;font-weight:700;letter-spacing:1px;">' +
          escapeText(yearTextOf(year)) +
          (month
            ? `<span style="font-size:13px;font-weight:400;color:#6F675C;letter-spacing:0.5px;"> ${escapeText(entryText(month))}</span>`
            : "") +
          "</p>",
      );
      if (title) {
        html.push(
          `<p style="margin:0 0 10px;font-size:24px;line-height:1.45;color:#14110E;font-weight:700;letter-spacing:0.5px;">${escapeMulti(entryText(title))}</p>`,
        );
      }
      for (const entry of body) {
        if (entry === quote) {
          html.push(
            '<section style="margin:2px 0 16px;padding:4px 0 4px 14px;border-left:3px solid #C8102E;">' +
              `<p style="margin:0;font-size:18px;line-height:1.7;color:#5A5248;letter-spacing:0.3px;">${escapeMulti(entryText(entry))}</p>` +
              "</section>",
          );
          continue;
        }
        html.push(
          `<p style="margin:0 0 14px;font-size:17px;line-height:1.9;color:#2A2620;letter-spacing:0.4px;">${escapeMulti(entryText(entry))}</p>`,
        );
      }
      if (img) html.push(pictureHtml(img));
      if (caption) {
        html.push(
          `<p style="margin:6px 0 12px;font-size:12px;line-height:1.6;color:#8a7f70;">${escapeText(entryText(caption))}</p>`,
        );
      }
      if (label) {
        html.push('<section style="margin:8px 0 0;padding:14px 16px;background:#EAE3D6;border-radius:10px;">');
        html.push(
          `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#6F675C;letter-spacing:0.5px;">${escapeText(entryText(label))}</p>`,
        );
        if (worldBody) {
          html.push(
            `<p style="margin:0 0 8px;font-size:15px;line-height:1.85;color:#3A352C;">${escapeMulti(entryText(worldBody))}</p>`,
          );
        }
        for (const data of dataList) {
          html.push(
            `<p style="margin:0 0 4px;font-size:15px;line-height:1.7;color:#C8102E;font-weight:700;">${escapeText(entryText(data))}</p>`,
          );
        }
        if (chinaLine) {
          html.push(
            `<p style="margin:8px 0 0;font-size:13px;line-height:1.75;color:#8a7f70;">${escapeMulti(chinaLine)}</p>`,
          );
        }
        html.push("</section>");
      }
      html.push("</section>");
    }

    /* 结语：引语 → 英文 → 正文 → 两张世界对比卡（按列配对，两列的标签是同一行） */
    if (closingParts.length) {
      const quote = closingParts.find((e) => e.kind === "text" && Number(e.item.fontSize) >= 42);
      /* 档案 / 蓝图 / 书页三套版式把两张卡合成了一段（标签｜正文 + 换行），先拆出来 */
      const mergedCard = closingParts.find(
        (e) => e.kind === "text" && /世界/.test(entryText(e)) && entryText(e).includes("｜"),
      );
      const labels = closingParts.filter(
        (e) =>
          e.kind === "text" &&
          e !== mergedCard &&
          Number(e.item.fontSize) <= 24 &&
          /世界/.test(entryText(e)),
      );
      const cardBodies = new Map();
      for (const label of labels) {
        const body = closingParts.find(
          (e) =>
            e.kind === "text" &&
            e !== label &&
            e.item.y > label.item.y + 10 &&
            Math.abs(Number(e.item.x) - Number(label.item.x)) < 80 &&
            Number(e.item.fontSize) >= 24 &&
            Number(e.item.fontSize) <= 30,
        );
        if (body) cardBodies.set(label, body);
      }
      const skip = new Set([quote, ...labels, ...cardBodies.values(), mergedCard].filter(Boolean));
      if (quote) {
        html.push(
          `<p style="margin:0 0 8px;font-size:30px;line-height:1.4;color:#14110E;font-weight:700;letter-spacing:1px;">${escapeText(entryText(quote))}</p>`,
        );
      }
      for (const entry of closingParts.filter((e) => !skip.has(e))) {
        const text = entryText(entry);
        if (entry.kind !== "text" || !text) continue;
        if (/^Stay /i.test(text)) {
          html.push(
            `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#8A7F70;">${escapeText(text)}</p>`,
          );
          continue;
        }
        html.push(
          `<p style="margin:0 0 14px;font-size:17px;line-height:1.9;color:#2A2620;letter-spacing:0.4px;">${escapeMulti(text)}</p>`,
        );
      }
      for (const label of labels) {
        html.push('<section style="margin:0 0 12px;padding:14px 16px;background:#EAE3D6;border-radius:10px;">');
        html.push(
          `<p style="margin:0 0 4px;font-size:13px;letter-spacing:0.5px;color:${isRed(label) ? "#C8102E" : "#6F675C"};${isRed(label) ? "font-weight:700;" : ""}">${escapeText(entryText(label))}</p>`,
        );
        const body = cardBodies.get(label);
        if (body) {
          html.push(
            `<p style="margin:0;font-size:15px;line-height:1.85;color:#14110E;">${escapeMulti(entryText(body))}</p>`,
          );
        }
        html.push("</section>");
      }
      if (mergedCard) {
        for (const line of entryText(mergedCard).split("\n").filter(Boolean)) {
          const parts2 = line.split("｜");
          const lab = parts2.shift() || "";
          html.push('<section style="margin:0 0 12px;padding:14px 16px;background:#EAE3D6;border-radius:10px;">');
          html.push(
            `<p style="margin:0 0 4px;font-size:13px;letter-spacing:0.5px;color:#6F675C;">${escapeText(lab)}</p>`,
          );
          html.push(
            `<p style="margin:0;font-size:15px;line-height:1.85;color:#14110E;">${escapeMulti(parts2.join("｜"))}</p>`,
          );
          html.push("</section>");
        }
      }
    }

    return [
      "<!doctype html>",
      '<html lang="zh">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${escapeText(name)}</title>`,
      `<style>${WECHAT_PAGE_CSS}</style>`,
      "</head>",
      "<body>",
      '<div class="wx-bar"><button id="wx-copy">复制全文</button>' +
        '<span id="wx-hint">正文是可选文本（字数、搜索都正常）；图片内嵌在正文里，粘贴后请在图上右键「复制图片」再替换进编辑器</span></div>',
      `<article id="wx-article" style="font-family:${FONT_STACK_ATTR};font-size:17px;line-height:1.9;` +
        'color:#2b2622;letter-spacing:0.4px;">',
      html.join(""),
      "</article>",
      `<script>${WECHAT_PAGE_SCRIPT}</script>`,
      "</body>",
      "</html>",
    ].join("\n");
  }

  async function buildArticle(name) {
    const items = getItems();
    if (!items.length) throw new Error("这个画布还是空的，没东西可导出");
    const nodes = articleNodes(items);
    if (!nodes.length) throw new Error("这个画布只有连线，没有可成文的文字");

    const body = renderWechatBody(nodes);
    return [
      "<!doctype html>",
      '<html lang="zh">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${escapeText(name)}</title>`,
      `<style>${WECHAT_PAGE_CSS}</style>`,
      "</head>",
      "<body>",
      '<div class="wx-bar"><button id="wx-copy">复制全文</button>' +
        '<span id="wx-hint">复制后粘到公众号编辑器，内联样式会跟着过去（图片需要单独上传）</span></div>',
      `<article id="wx-article" style="font-family:${FONT_STACK_ATTR};font-size:17px;line-height:1.9;` +
        'color:#2b2622;letter-spacing:0.4px;">',
      body,
      "</article>",
      `<script>${WECHAT_PAGE_SCRIPT}</script>`,
      "</body>",
      "</html>",
    ].join("\n");
  }

  /* ---------------- 今日头条文章 ----------------
   *
   * 头条和微信是两个相反的产品：微信把排版交给作者，头条把排版收归平台。
   * 头条 PC 编辑器根本没有字号选择，颜色和底色也一路收窄（2025 年 9 月连手机端
   * 的改字色都取消了），粘过去的内联样式基本被剥光。
   *
   * 所以这里一个样式都不输出，只输出「结构」：这段是标题、这段是正文、
   * 这段是引用。颜色字号全交给头条自己的正文样式。
   *
   * 通道也不一样：头条编辑器工具栏右侧「更多 → 文档导入」支持 doc/docx/pdf/txt，
   * 官方建议用 docx。所以主路径是生成 .docx —— 这是唯一能把标题层级
   * 真正带进去的方式（靠 Word 的内置样式 ID，不是靠字号大小假装）。
   */

  /* XML 只认这几个实体，另外 XML 1.0 不允许控制字符，留着会让整个文档打不开 */
  function xmlEscape(text) {
    return String(text)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* ---- zip：docx 就是个 zip 包，自己拼比引一个库划算 ----
   * 用 CompressionStream("deflate-raw") 压，压不动就退回 store（method 0）。
   * 两个可以混用，zip 允许每个条目各自选。 */
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
      }
      crcTable = table;
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  async function zipFiles(entries) {
    const encoder = new TextEncoder();
    const parts = [];
    const directory = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const source = entry.data;
      const checksum = crc32(source);
      let body = source;
      let method = 0;
      const packed = await deflateRaw(source);
      if (packed && packed.length < source.length) {
        body = packed;
        method = 8;
      }

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); /* 文件名是 UTF-8 */
      lv.setUint16(8, method, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true); /* 1980-01-01，zip 的零点 */
      lv.setUint32(14, checksum, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, source.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, body);

      const head = new Uint8Array(46 + nameBytes.length);
      const hv = new DataView(head.buffer);
      hv.setUint32(0, 0x02014b50, true);
      hv.setUint16(4, 20, true);
      hv.setUint16(6, 20, true);
      hv.setUint16(8, 0x0800, true);
      hv.setUint16(10, method, true);
      hv.setUint16(12, 0, true);
      hv.setUint16(14, 0x21, true);
      hv.setUint32(16, checksum, true);
      hv.setUint32(20, body.length, true);
      hv.setUint32(24, source.length, true);
      hv.setUint16(28, nameBytes.length, true);
      hv.setUint32(42, offset, true);
      head.set(nameBytes, 46);
      directory.push(head);

      offset += local.length + body.length;
    }

    const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, directorySize, true);
    ev.setUint32(16, offset, true);

    const total = parts.reduce((sum, part) => sum + part.length, 0) + directorySize + 22;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    for (const part of directory) {
      out.set(part, at);
      at += part.length;
    }
    out.set(end, at);
    return out;
  }

  /* ---- docx：四个部件就够 ----
   * [Content_Types].xml 说明每个部件是什么
   * _rels/.rels 指向正文
   * word/document.xml 正文
   * word/styles.xml 样式表 —— 标题能不能被头条认出来，全看这里的 styleId */
  const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  const DOCX_CONTENT_TYPES =
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    "</Types>";

  const DOCX_ROOT_RELS =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";

  const DOCX_DOC_RELS =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>";

  /* 标题样式的 w:styleId 必须是 Heading1/Heading2（Word 内置的命名），
     name 也要是 "heading 1"。头条认的是这个身份，不是你把字调多大。
     正文故意不写字号不写颜色，让平台自己的正文样式生效。 */
  const DOCX_STYLES =
    `${DECL}<w:styles xmlns:w="${W_NS}">` +
    "<w:docDefaults><w:rPrDefault><w:rPr>" +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:eastAsia="zh-CN"/>' +
    "</w:rPr></w:rPrDefault>" +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="330" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="320" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>' +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="300" w:after="140"/><w:outlineLvl w:val="1"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>' +
    '<w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:ind w:left="480" w:right="240"/><w:spacing w:before="120" w:after="160"/></w:pPr>' +
    "</w:style>" +
    "</w:styles>";

  function docxRun(text, bold) {
    const size = bold ? "<w:rPr><w:b/><w:bCs/></w:rPr>" : "";
    /* 换行用 <w:br/>，不去动段落：一段内的软换行在头条里还是同一段 */
    const body = String(text)
      .split("\n")
      .map((line) => `<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`)
      .join("<w:br/>");
    return `<w:r>${size}${body}</w:r>`;
  }

  function docxParagraph(block) {
    if (block.kind === "hr") {
      return (
        "<w:p><w:pPr><w:pBdr>" +
        '<w:bottom w:val="single" w:sz="6" w:space="1" w:color="D6CEC0"/>' +
        '</w:pBdr><w:spacing w:before="200" w:after="200"/></w:pPr></w:p>'
      );
    }
    const props = [];
    if (block.style) props.push(`<w:pStyle w:val="${block.style}"/>`);
    if (block.indent) props.push(`<w:ind w:left="${block.indent}"/>`);
    /* 卡片组之间要留得比组内行距大，不然一屏十几组卡片会糊成一片。
       头条不认这个间距也没关系，退回去就是它自己的默认段距，不会更糟。 */
    if (block.gap) props.push(`<w:spacing w:after="${block.gap}"/>`);
    const pPr = props.length ? `<w:pPr>${props.join("")}</w:pPr>` : "";
    /* 一行加粗 + 一行说明，必须待在同一个段落里：拆成两段就会被段落间距
       拉成两个平行段落，读者分不清哪两行是一组。段落内的 <w:br/> 是硬换行，
       头条换成 <br> 之后还是粘在一起。 */
    const runs = block.runs || [{ text: block.text, bold: block.bold }];
    const inner = runs
      .filter((run) => String(run.text).length)
      .map((run, index) => (index ? "<w:r><w:br/></w:r>" : "") + docxRun(run.text, run.bold))
      .join("");
    return `<w:p>${pPr}${inner}</w:p>`;
  }

  async function buildDocx(blocks) {
    const body = blocks.map(docxParagraph).join("");
    const documentXml =
      `${DECL}<w:document xmlns:w="${W_NS}"><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" ' +
      'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
      "</w:body></w:document>";
    const encoder = new TextEncoder();
    return zipFiles([
      { name: "[Content_Types].xml", data: encoder.encode(DOCX_CONTENT_TYPES) },
      { name: "_rels/.rels", data: encoder.encode(DOCX_ROOT_RELS) },
      { name: "word/document.xml", data: encoder.encode(documentXml) },
      { name: "word/_rels/document.xml.rels", data: encoder.encode(DOCX_DOC_RELS) },
      { name: "word/styles.xml", data: encoder.encode(DOCX_STYLES) },
    ]);
  }

  /* 画布 → 头条能吃的语义。这里不产生任何颜色字号，只决定「这是一级标题、
     二级标题、正文、引用还是列表项」。 */
  function toutiaoBlocks(nodes) {
    const blocks = [];
    const pushLines = (lines, each = false) => {
      if (!lines.length) return;
      if (each) {
        for (const line of lines) blocks.push({ kind: "p", text: line });
      } else {
        blocks.push({ kind: "p", text: lines.join("\n") });
      }
    };

    for (const node of nodes) {
      if (node.kind === "rule") {
        blocks.push({ kind: "hr" });
        continue;
      }
      if (node.kind === "media") {
        const label =
          node.item.type === "image" ? "图片" : node.item.type === "video" ? "视频" : "附件";
        blocks.push({
          kind: "p",
          text: `［这里原有一处${label}，导出时没有带出来，进编辑器后单独上传一次］`,
        });
        continue;
      }

      const lines = String(node.text.text || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length) continue;

      if (node.kind === "card") {
        /* 引文框（底色和普通卡片不同）当引用处理；其余是卡片，首行提出来当小标题 */
        const fill = String(node.card?.fillColor || "").toLowerCase();
        const accent = fill && fill !== CARD_FILL;
        const asTitle =
          lines.length > 1 && lines[0].length <= 14 && !/[。，；：]/.test(lines[0]);
        if (accent) {
          blocks.push({ kind: "quote", text: lines.join("\n") });
        } else if (asTitle) {
          /* 卡片是「名字 + 一两句说明」的形状，整块装进一个段落：
             首行加粗，其余换行跟在下面。拆成独立段落的话，段落间距会把
             每一行拉成平级，一组卡片就读成了两段不相干的话。 */
          blocks.push({
            kind: "p",
            gap: 320,
            runs: lines.map((line, index) => ({ text: line, bold: index === 0 })),
          });
        } else {
          pushLines(lines, lines.length >= 5);
        }
        continue;
      }

      /* 独立文字：按画布字号判层级。大字号整块当标题时，只把第一行算标题，
         后面那行通常是副标题（画布上就是「章节名 + 一句话」的两行） */
      const size = Number(node.text.fontSize) || 16;
      const level = size >= 60 ? "Heading1" : size >= 32 ? "Heading2" : null;
      if (level) {
        blocks.push({ kind: "p", text: lines[0], style: level });
        pushLines(lines.slice(1));
        continue;
      }
      /* 画布上原本就是一列行（逐回、清单），逐行成段更好编辑；整段正文保持一段 */
      pushLines(lines, lines.length >= 5);
    }
    return blocks;
  }

  async function buildToutiao(name) {
    const items = getItems();
    if (!items.length) throw new Error("这个画布还是空的，没东西可导出");
    const nodes = articleNodes(items);
    if (!nodes.length) throw new Error("这个画布只有连线，没有可成文的文字");
    const blocks = toutiaoBlocks(nodes);
    if (!blocks.length) throw new Error("这里没有可以转成文章的文字");
    const bytes = await buildDocx(blocks);
    return {
      bytes,
      name,
      blocks: blocks.length,
      headings: blocks.filter((b) => b.style).length,
    };
  }

  /* 按档位算比例尺，再按硬上限收一次：内容太大时自动降档，而不是交白图 */
  function scaleFor(box, quality, tiled = false) {
    const wanted = QUALITY[quality]?.scale ?? QUALITY[DEFAULT_QUALITY].scale;
    const bySide = MAX_SIDE / Math.max(1, box.w, box.h);
    /* 分段导出每段自己一张画布，总像素上限管不到它，只受长边约束 */
    const byPixels = tiled ? Infinity : Math.sqrt(MAX_PIXELS / Math.max(1, box.w * box.h));
    const scale = Math.max(0.02, Math.min(wanted, bySide, byPixels));
    return { scale, wanted, capped: scale < wanted - 1e-6 };
  }

  function slicePlan(box, quality) {
    const { scale, wanted, capped } = scaleFor(box, quality, true);
    const width = Math.max(1, Math.round(box.w * scale));
    const height = Math.max(1, Math.round(box.h * scale));
    /* 段高同时受两个约束：段太短文件零碎，段太高单张图片查看器吃力；
       宽图再按总像素收一次，免得出来一条 6000 高的超宽横带 */
    const byPixels = Math.floor(MAX_SEGMENT_PIXELS / Math.max(1, width));
    const segH = Math.max(256, Math.min(SEGMENT_PIXELS, byPixels, height));
    return {
      scale,
      wanted,
      capped,
      width,
      height,
      segH,
      count: Math.max(1, Math.ceil(height / segH)),
    };
  }

  /* 预估：不画图，只算尺寸。给导出菜单显示「大概多大一张」，
     也让用户看得见内容太大时被降档了。 */
  function plan(options = {}) {
    const items = getItems();
    if (!items.length) return null;
    const box = contentBox(items);
    if (!box) return null;
    const single = scaleFor(box, options.quality);
    const sliced = slicePlan(box, options.quality);
    return {
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      single: {
        width: Math.max(1, Math.round(box.w * single.scale)),
        height: Math.max(1, Math.round(box.h * single.scale)),
        scale: single.scale,
        capped: single.capped,
      },
      sliced,
    };
  }

  async function run(format, options = {}) {
    const items = getItems();
    if (!items.length) throw new Error("这个画布还是空的，没东西可导出");
    const box = contentBox(items);
    if (!box) throw new Error("这个画布只有连线，没东西可导出");
    const name = (getMeta().name || "画布").trim() || "画布";

    if (format === "wechat") {
      const layoutBox = layoutBoxOf(items);
      const html = layoutBox ? await buildLayoutArticle(layoutBox, name) : await buildArticle(name);
      return {
        format: "html",
        name: `${name} · 公众号`,
        data: bytesToBase64(new TextEncoder().encode(html)),
        layout: Boolean(layoutBox),
      };
    }

    if (format === "toutiao") {
      /* 头条走 docx，因为它的编辑器有官方「文档导入」，且只有 docx 能把
         标题层级真正带过去；网页复制粘贴那条路在这里没有胜算 */
      const built = await buildToutiao(name);
      return {
        format: "docx",
        name: `${name} · 今日头条`,
        data: bytesToBase64(built.bytes),
        blocks: built.blocks,
        headings: built.headings,
      };
    }

    if (format === "xiaohongshu") {
      /* 小红书没有官方导出协议，先给一份窄栏图文 HTML：复制到笔记编辑器时
         图片与文字都能留住，版式也按手机竖屏收窄，不被桌面页宽撑散。 */
      const html = await buildHtml(box, name);
      return {
        format: "html",
        name: `${name} · 小红书`,
        data: bytesToBase64(new TextEncoder().encode(html)),
      };
    }

    if (format === "html") {
      const html = await buildHtml(box, name);
      /* 网页是文本，走 UTF-8 字节再转 base64：直接 btoa 会把中文弄坏 */
      return { format, name, data: bytesToBase64(new TextEncoder().encode(html)) };
    }

    /* 先定倍数再建图，画完再放大只会糊 */
    const { scale, capped } = scaleFor(box, options.quality);
    const prepared = await prepareWorld(options.only);
    const canvas = await renderRegion(
      prepared,
      box,
      box.w * scale,
      box.h * scale,
      scale,
      options.onProgress,
    );

    if (format === "pdf") {
      const jpeg = base64ToBytes(canvas.toDataURL("image/jpeg", 0.95).split(",")[1]);
      const pdf = buildPdf(jpeg, canvas.width, canvas.height);
      return {
        format,
        name,
        data: bytesToBase64(pdf),
        width: canvas.width,
        height: canvas.height,
        scale,
        capped,
      };
    }
    const data = canvas.toDataURL("image/png").split(",")[1];
    return { format, name, data, width: canvas.width, height: canvas.height, scale, capped };
  }

  /* 分段导出：超长画布切成几张，每张都按所选倍数原样出图，
     所以哪一段放大看都清楚。一次只画一段、交一段，内存不攒一摞。
     onSlice 返回 Promise —— 写完一张再画下一张，失败就整批停。 */
  async function exportSlices(options = {}) {
    const items = getItems();
    if (!items.length) throw new Error("这个画布还是空的，没东西可导出");
    const box = contentBox(items);
    if (!box) throw new Error("这个画布只有连线，没东西可导出");
    const name = (getMeta().name || "画布").trim() || "画布";

    const info = slicePlan(box, options.quality);
    const prepared = await prepareWorld();
    for (let index = 0; index < info.count; index += 1) {
      const oy = index * info.segH;
      const h = Math.min(info.segH, info.height - oy);
      const slice = {
        x: box.x,
        y: box.y + oy / info.scale,
        w: box.w,
        h: h / info.scale,
      };
      const canvas = await renderRegion(prepared, slice, info.width, h, info.scale, (done, all) => {
        options.onProgress?.({ index, total: info.count, tile: done, tiles: all });
      });
      const data = canvas.toDataURL("image/png").split(",")[1];
      const suffix = String(index + 1).padStart(2, "0");
      await options.onSlice?.({
        index,
        total: info.count,
        data,
        name: info.count > 1 ? `${name}-${suffix}` : name,
        width: canvas.width,
        height: canvas.height,
      });
    }
    return {
      format: "png",
      name,
      count: info.count,
      width: info.width,
      height: info.height,
      segH: info.segH,
      scale: info.scale,
    };
  }


  /* 把一页贴到固定尺寸的白底上：下面空出来的部分补底色，不是透明的 */
  function padTo(source, width, height, background) {
    if (source.width === width && source.height === height) return source;
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = background || "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0);
    return out;
  }

  /* 小红书卡片：整张画布按 3:4 竖页切开，一页一张 PNG。
     切点优先落在块边界上——按固定高度硬切会把一段正文拦腰截断。 */
  async function exportCards(options = {}) {
    const items = getItems();
    if (!items.length) throw new Error("这个画布还是空的，没东西可导出");
    let box = contentBox(items);
    if (!box) throw new Error("这个画布只有连线，没东西可导出");
    /* 卡片四周留一圈底：文字紧贴画面边看着像被裁过 */
    const pad = Math.max(12, Math.round(box.w * 0.045));
    box = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
    const name = (getMeta().name || "画布").trim() || "画布";
    const outWidth = Math.max(320, Number(options.width) || 1080);
    const ratio = Number(options.ratio) || 4 / 3;
    const scale = outWidth / box.w;
    const pageH = box.w * ratio;
    const bottom = box.y + box.h;

    /* 所有块的上下边都能当切点，但只取页面靠下那一段里的，
       否则每页都会被切得很短 */
    const edges = [];
    for (const item of items) {
      if (!item || item.type === "connector" || item.type === "page") continue;
      edges.push(item.y, item.y + item.h);
    }
    let cuts = [box.y];
    while (cuts[cuts.length - 1] < bottom - 1) {
      const top = cuts[cuts.length - 1];
      let next = top + pageH;
      if (next < bottom - 1) {
        const low = top + pageH * 0.55;
        const candidates = edges.filter((edge) => edge > low && edge <= top + pageH);
        if (candidates.length) next = Math.max(...candidates);
        next = Math.max(next, top + pageH * 0.3);
      }
      next = Math.min(next, bottom);
      if (next <= top) break;
      cuts.push(next);
    }
    /* 只比一页高一点点的时候并成一页：否则会多出一张几乎全白的第二张。
       超出 15% 以上还是老实分页，硬并会把内容压出画面。 */
    const contentH = bottom - box.y;
    if (cuts.length === 3 && bottom - cuts[1] < pageH * 0.3 && contentH <= pageH * 1.15) {
      cuts = [box.y, bottom];
    }

    const prepared = await prepareWorld();
    const cards = [];
    const total = cuts.length - 1;
    /* 每页都出成一模一样的 3:4：内容不够一页就在下面补白，
       不然最后一张会比别人矮一截，发出去像被裁过 */
    const pageOut = Math.max(1, Math.round(pageH * scale));
    const background = options.background || "#ffffff";
    for (let index = 0; index < total; index += 1) {
      const top = cuts[index];
      const h = cuts[index + 1] - top;
      const shot = await renderRegion(
        prepared,
        { x: box.x, y: top, w: box.w, h },
        outWidth,
        Math.max(1, Math.round(h * scale)),
        scale,
        (done, all) => {
          options.onProgress?.({ index, total, tile: done, tiles: all });
        },
      );
      /* 内容超过半页就补满 3:4；半页以下的（多见于并成一页的长图）
         补到半页即可，再往上补就是一整片白 */
      const targetH = Math.max(
        shot.height,
        shot.height >= pageOut * 0.55 ? pageOut : Math.round(pageOut * 0.55),
      );
      const canvas = padTo(shot, outWidth, targetH, background);
      cards.push({
        rel: `${String(index + 1).padStart(2, "0")}.png`,
        data: canvas.toDataURL("image/png").split(",")[1],
        width: outWidth,
        height: canvas.height,
      });
    }
    return {
      format: "png",
      name,
      count: cards.length,
      width: outWidth,
      pageHeight: Math.round(pageH * scale),
      cards,
    };
  }

  /* 按一块矩形面板的范围导出：框里所有块按层级合成，框外自然裁掉（装饰可以出血）。
     透明模式把面板自己整个摘掉，只留框里的内容；含底色模式只摘面板的外框和圆角。 */
  async function exportRegion(options = {}) {
    const box = options.box;
    if (!box || ![box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n))) {
      throw new Error("导出范围必须是 {x, y, w, h}");
    }
    if (box.w <= 0 || box.h <= 0) throw new Error("导出范围的宽高要大于 0");
    const transparent = options.transparent === true;
    const { scale, capped } = scaleFor(box, options.quality);
    const prepared = await prepareWorld(undefined, {
      hideIds: transparent && options.hideId ? [options.hideId] : [],
      stripIds: !transparent && options.hideId ? [options.hideId] : [],
    });
    const canvas = await renderRegion(
      prepared,
      box,
      box.w * scale,
      box.h * scale,
      scale,
      options.onProgress,
      undefined,
      transparent,
    );
    const data = canvas.toDataURL("image/png").split(",")[1];
    return {
      format: "png",
      name: options.name || "海报",
      data,
      width: canvas.width,
      height: canvas.height,
      scale,
      capped,
      transparent,
    };
  }

  /* 截图：给 agent「看」自己刚画出来的东西。
   *
   * 和导出的区别只在「框哪儿」和「多大」。截图是回给模型看的，越大越亏 token，
   * 所以默认 1600 长边。但长卷整张缩到 1600 长边时字只有一两个像素，
   * 所以给了 scale：需要读字就指定倍数（上限 4），或者干脆框一块区域来看。
   * region 三种：all（所有块）、viewport（用户此刻看到的这一屏）、{x,y,w,h}（指定矩形）。
   */
  async function snapshot(options = {}) {
    const items = getItems();
    if (!items.length) throw new Error("这个画布还是空的，没有画面可看");

    let box = null;
    const region = options.region ?? "all";
    if (region === "viewport") {
      box = getViewportBox?.() || null;
      if (!box) throw new Error("取不到当前视口");
    } else if (region && typeof region === "object") {
      const { x, y, w, h } = region;
      if (![x, y, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) {
        throw new Error("region 需要 {x, y, w, h}，四个都得是数字，宽高要大于 0");
      }
      box = { x, y, w, h };
    } else {
      box = contentBox(items);
      if (!box) throw new Error("这个画布只有连线，没有可看的块");
    }

    const maxSide = Math.max(320, Math.min(4096, Number(options.maxSide) || 1600));
    /* 给了 scale 就按倍数来（凑近看字），否则按长边收敛 */
    const wanted = Number(options.scale);
    let scale = Number.isFinite(wanted) && wanted > 0
      ? Math.min(4, wanted)
      : maxSide / Math.max(box.w, box.h);
    /* 超大区域的保护：像素总量封顶，宁可小一点也不交白图 */
    const byPixels = Math.sqrt(MAX_PIXELS / Math.max(1, box.w * box.h));
    scale = Math.max(0.02, Math.min(scale, byPixels));

    const prepared = await prepareWorld();
    const canvas = await renderRegion(prepared, box, box.w * scale, box.h * scale, scale, undefined, options.only);
    const data = canvas.toDataURL("image/png").split(",")[1];
    return {
      format: "png",
      data,
      width: canvas.width,
      height: canvas.height,
      scale,
      region: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
      blocks: items.filter((item) => item.type !== "connector").length,
      connectors: items.filter((item) => item.type === "connector").length,
    };
  }

  /* 提案页：只画这一页的范围，页框留下当底色，页名和描边摘掉；
     hideIds 里放别的页和客户版隐藏的块。 */
  async function exportPage(options = {}) {
    const box = options.box;
    if (!box || ![box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n))) {
      throw new Error("页面范围必须是 {x, y, w, h}");
    }
    if (box.w <= 0 || box.h <= 0) throw new Error("页面的宽高要大于 0");
    const { scale, capped } = scaleFor(box, options.quality);
    const prepared = await prepareWorld(undefined, {
      hideIds: options.hideIds || [],
      pageId: options.pageId || "",
    });
    const canvas = await renderRegion(
      prepared,
      box,
      box.w * scale,
      box.h * scale,
      scale,
      options.onProgress,
    );
    const jpeg = options.format === "jpeg";
    const data = jpeg
      ? canvas.toDataURL("image/jpeg", 0.95).split(",")[1]
      : canvas.toDataURL("image/png").split(",")[1];
    return {
      format: jpeg ? "jpeg" : "png",
      data,
      width: canvas.width,
      height: canvas.height,
      scale,
      capped,
    };
  }

  /* 多页 PDF：一页一张，出来按顺序排好的多页文件 */
  async function exportPagesPdf(pages, options = {}) {
    if (!Array.isArray(pages) || !pages.length) throw new Error("没有页面可导出");
    const built = [];
    for (let index = 0; index < pages.length; index += 1) {
      const shot = await exportPage({ ...pages[index], quality: options.quality, format: "jpeg" });
      built.push({ jpeg: base64ToBytes(shot.data), imageW: shot.width, imageH: shot.height });
      options.onProgress?.(index + 1, pages.length);
    }
    return {
      format: "pdf",
      pages: built.length,
      data: bytesToBase64(buildPdfPages(built)),
    };
  }

  return {
    exportAs: run,
    exportSlices,
    exportCards,
    exportRegion,
    exportPage,
    exportPagesPdf,
    plan,
    snapshot,
    reportError(error) {
      onError?.(error);
    },
  };
}
