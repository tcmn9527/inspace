/* 导出：把这一屏的块画成一张图（PNG），或包成一页 PDF。
 *
 * 做法：不重画一遍，而是把世界里那份 DOM 原样克隆下来，塞进一个
 * <foreignObject>，让浏览器自己再排一次版、再光栅化一次 —— 这样文字换行、
 * 圆角、便签配色、笔记里的 Markdown 全都不用手写第二套渲染。
 *
 * 几个必须自己处理的坑：
 *   - 图片走 asset 协议，是另一个源，直接画会污染画布。所以图片一律先让后端
 *     读成 data URL 再换进去（见 canvas_image_data）。
 *   - <canvas>（PDF 那一页）里的像素不会被序列化，先 toDataURL 换成 <img>。
 *   - <video> 和沙箱里的电子书页是跨进程的东西，序列化不过去，换成等尺寸的占位块。
 *   - 样式表要跟着搬进去：SVG 当图片加载时不认外面的 CSS，只能把规则整份塞进 <style>，
 *     再补一份当前主题的 CSS 变量（:root 对外层文档有效，对 SVG 里的根不生效）。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
/* 留白：块的边框和便签的阴影不至于被切在边上 */
const PADDING = 56;

/* 清晰度档位 = 相对「屏幕上 100% 的样子」的倍数。
   16px 的字放大 2 倍就是 32px，一万多像素的长卷整张看时也读得出来。
   旧版是「长边一律收到 8192」，长卷会被压到 0.58 倍，16px 落成 9px —— 糊就是这么来的。 */
export const QUALITY = {
  normal: { scale: 1, label: "原始尺寸 ×1" },
  high: { scale: 2, label: "高清 ×2" },
  ultra: { scale: 3, label: "超清 ×3" },
};
export const DEFAULT_QUALITY = "high";

/* 单张图的硬上限。120M 像素的 RGBA 已经 480MB，再往上浏览器常常直接给一张白图，
   所以内容实在太大时宁可自动降一档，也不硬画。 */
const MAX_PIXELS = 120_000_000;
const MAX_SIDE = 60_000;
/* 分段导出：每段的高度。一段一个文件，3000 万像素以内，图片查看器都吃得下 */
const SEGMENT_PIXELS = 6_000;
const MAX_SEGMENT_PIXELS = 30_000_000;
/* 分片渲染的片大小。整张长图一次交给浏览器解码，峰值内存会翻好几倍；
   切成 4096 见方逐片画到同一张画布上，峰值只跟片大小有关，成品像素一点不少。 */
const TILE = 4096;

/* 选中框、端口、吸附辅助线这些只是操作时的记号，不该出现在导出的图里。
   .canvas-port 是连线两端那几颗圈，选中时才画，静态图里就是一点脏东西 */
const OVERLAY_SELECTOR =
  ".canvas-sel-box, .canvas-port-box, .canvas-port, .canvas-guide, .canvas-handle";

/* 卡片里那些滚动条在静态图里看着像画坏了；导出画布又没有「滚动」这回事 */
const EXPORT_CSS = `
.canvas-export-root *::-webkit-scrollbar { width: 0; height: 0; display: none; }
.canvas-export-root * { scrollbar-width: none; }
`;

function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* 最小 PDF：一页，里面就一张 JPEG。没有外部依赖，够用也够稳。 */
function buildPdf(jpeg, imageW, imageH) {
  /* 画布像素换成分（1px ≈ 0.75pt），再收进 PDF 允许的页面尺寸里 */
  const ratio = Math.min(0.75, 14400 / Math.max(imageW, imageH));
  const pageW = Math.max(1, Math.round(imageW * ratio));
  const pageH = Math.max(1, Math.round(imageH * ratio));
  const content = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`;

  const parts = [];
  let cursor = 0;
  const offsets = [];
  const pushBytes = (bytes) => {
    parts.push(bytes);
    cursor += bytes.length;
  };
  const pushText = (text) => pushBytes(encodeLatin1(text));
  const startObject = () => {
    offsets.push(cursor);
  };

  pushText("%PDF-1.4\n");

  startObject();
  pushText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObject();
  pushText("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  startObject();
  pushText(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );

  startObject();
  pushText(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageW} /Height ${imageH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${jpeg.length} >>\nstream\n`,
  );
  pushBytes(jpeg);
  pushText("\nendstream\nendobj\n");

  startObject();
  pushText(
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  );

  const xref = cursor;
  pushText("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i += 1) {
    pushText(`${String(offsets[i - 1]).padStart(10, "0")} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return concatBytes(parts);
}

/* 当前文档里所有样式规则。取不到的（跨域字体表之类）直接跳过，不该为它挡住导出。 */
function collectCss() {
  const parts = [];
  for (const sheet of document.styleSheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (const rule of rules) parts.push(rule.cssText);
  }
  return parts.join("\n");
}

/* 主题色是 :root 上的自定义属性，SVG 里那层根不认外面的 :root，
   所以把当前算出来的值原样抄一份进去。 */
function themeVars() {
  try {
    const style = getComputedStyle(document.documentElement);
    const out = [];
    for (const name of style) {
      if (!name.startsWith("--")) continue;
      const value = style.getPropertyValue(name).trim();
      if (value) out.push(`${name}:${value}`);
    }
    return out.length ? `:root{${out.join(";")}}` : "";
  } catch {
    return "";
  }
}

export function createExporter({
  getItems,
  getWorld,
  getEdgeG,
  getBounds,
  getMeta,
  getStage,
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
      if (!item || item.type !== "image" || !item.src) {
        /* 认不出这张图是谁的、或者本来就没加载出来：与其留个破图标，不如留白 */
        img.remove();
        continue;
      }
      try {
        img.src = await loadImageData(canvasId, item.src, item.linked);
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
  async function prepareWorld() {
    const world = getWorld().cloneNode(true);
    world.removeAttribute("id");
    world.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;");

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
  function buildSvg(slice, prepared, pxW, pxH) {
    const stageStyle = getComputedStyle(getStage());
    const background = stageStyle.backgroundColor || "#ffffff";
    const w = Math.max(0.5, slice.w);
    const h = Math.max(0.5, slice.h);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("width", String(Math.max(1, Math.round(pxW))));
    svg.setAttribute("height", String(Math.max(1, Math.round(pxH))));
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
    const edgeGroup = getEdgeG()?.cloneNode(true);
    if (edgeGroup) {
      edgeGroup.removeAttribute("transform");
      edgeSvg.append(edgeGroup);
    }

    shift.append(prepared.cloneNode(true));
    frame.append(edgeSvg, shift);
    host.append(frame);
    foreign.append(host);
    svg.append(foreign);
    return { svg, background };
  }

  async function rasterize(svg, pxW, pxH, background) {
    const markup = new XMLSerializer().serializeToString(svg);
    /* 必须是 data: URL，不能用 URL.createObjectURL。
       blob: 载入的 SVG 只要里头有 <foreignObject>，Chromium 就把它当成跨源资源，
       drawImage 之后画布直接被污染，toDataURL 抛 SecurityError
       （实测：同样的图换成 data: 就干净）。base64 比 encodeURIComponent 省，
       中文按 UTF-8 走字节，不会一格三膨胀。 */
    const url = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(markup))}`;
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("画不出来：这块内容太大了，或者里面有取不到的图"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(pxW));
    canvas.height = Math.max(1, Math.round(pxH));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = background || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    /* SVG 自身的像素尺寸就是目标尺寸，这里 1:1 贴上去，不会再糊一层 */
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /* 把 slice 这块世界区域画成一张画布，内部按 TILE 分片。
     分片只管峰值内存，不影响成品像素：片与片按整数像素对齐，拼起来是连续的。 */
  async function renderRegion(prepared, slice, pxW, pxH, scale, onProgress) {
    const width = Math.max(1, Math.round(pxW));
    const height = Math.max(1, Math.round(pxH));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const background = getComputedStyle(getStage()).backgroundColor || "#ffffff";
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

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
        const built = buildSvg(part, prepared, tw, th);
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


  /* 单文件网页的样式。只放查看器自己的几条，剩下全靠原应用的样式表。 */
  const VIEWER_CSS = `
.export-hint {
  position: fixed;
  left: 16px;
  bottom: 12px;
  margin: 0;
  font: 12px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  opacity: 0.45;
  pointer-events: none;
  user-select: none;
}
`;

  /* 查看器的交互：拖动平移、滚轮缩放、双击复位。
     不用任何库——一个 60 行的脚本换来「对方双击就能看」，值。 */
  const VIEWER_SCRIPT = `
(function () {
  var view = document.getElementById("view");
  var stage = document.getElementById("stage");
  var C = __BOX__;
  var scale = 1, tx = 0, ty = 0, down = null;

  function apply() {
    stage.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
  }

  function fit() {
    var w = view.clientWidth, h = view.clientHeight, pad = 48;
    var s = Math.min((w - pad * 2) / C.w, (h - pad * 2) / C.h, 1.15);
    if (!isFinite(s) || s <= 0) s = 1;
    scale = s;
    tx = (w - C.w * s) / 2 - C.x * s;
    ty = (h - C.h * s) / 2 - C.y * s;
    apply();
  }

  view.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    down = { x: e.clientX - tx, y: e.clientY - ty };
    view.style.cursor = "grabbing";
    try { view.setPointerCapture(e.pointerId); } catch (_) {}
  });

  view.addEventListener("pointermove", function (e) {
    if (!down) return;
    tx = e.clientX - down.x;
    ty = e.clientY - down.y;
    apply();
  });

  function release(e) {
    if (!down) return;
    down = null;
    view.style.cursor = "";
    try { view.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  view.addEventListener("pointerup", release);
  view.addEventListener("pointercancel", release);

  view.addEventListener("wheel", function (e) {
    e.preventDefault();
    var next = Math.min(4, Math.max(0.08, scale * Math.exp(-e.deltaY * 0.0015)));
    var r = view.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    tx = mx - (mx - tx) * (next / scale);
    ty = my - (my - ty) * (next / scale);
    scale = next;
    apply();
  }, { passive: false });

  view.addEventListener("dblclick", fit);
  window.addEventListener("resize", fit);
  fit();
})();
`;

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
       少了它，卡片会掉内边距、便签会掉阴影 */
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
  const WECHAT_WIDTH = 677;
  const FONT_STACK =
    '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  /* 写进 style="..." 时不能用双引号，属性会被提前截断 */
  const FONT_STACK_ATTR = FONT_STACK.replace(/"/g, "'");
  const CARD_FILL = "#fbf7ef";

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
      } else if (item.type === "sticky") {
        if (!String(item.text || "").trim()) continue;
        texts.push({
          ...item,
          type: "text",
          fontSize: item.fontSize || 16,
          color: item.textColor || "#2b2622",
        });
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

  /* 页面自带一个「复制全文」按钮：复制走 execCommand 选中渲染后的文章，
     剪贴板里落的是富文本，粘到公众号编辑器样式就跟着过去了。
     按钮和页面样式只作用于这个查看页，不进选区，不会被复制进去。 */
  const WECHAT_PAGE_CSS = `
html, body { margin: 0; background: #f2efe9; }
body { font-family: ${FONT_STACK}; }
.wx-bar {
  position: sticky; top: 0; z-index: 9;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 12px 22px; background: #fff; border-bottom: 1px solid #e6ded2;
}
.wx-bar button {
  appearance: none; border: 0; cursor: pointer;
  padding: 9px 20px; border-radius: 999px;
  background: #9c3b1f; color: #fff;
  font: 600 14px/1 ${FONT_STACK};
}
.wx-bar button:active { transform: translateY(1px); }
.wx-bar span { font-size: 12.5px; color: #8a7f70; line-height: 1.6; }
#wx-article {
  max-width: ${WECHAT_WIDTH}px; margin: 22px auto 90px;
  padding: 34px 30px; background: #fff;
  box-shadow: 0 2px 20px rgba(60, 40, 20, 0.08);
}
@media (max-width: 720px) {
  #wx-article { margin: 12px; padding: 22px 18px; }
  .wx-bar { padding: 10px 14px; }
}
@media print { .wx-bar { display: none; } #wx-article { box-shadow: none; margin: 0; max-width: none; } }
`;

  const WECHAT_PAGE_SCRIPT = `
(function () {
  var btn = document.getElementById("wx-copy");
  var hint = document.getElementById("wx-hint");
  function select() {
    var el = document.getElementById("wx-article");
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel;
  }
  btn.addEventListener("click", function () {
    var sel = select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    sel.removeAllRanges();
    hint.textContent = ok
      ? "已复制 · 到公众号编辑器里按 Ctrl+V，排版会原样过去"
      : "浏览器拦了自动复制，请手动 Ctrl+A 全选，再 Ctrl+C";
  });
})();
`;

  async function buildArticle(name) {
    const items = getItems();
    if (!items.length) throw new Error("这个空间还是空的，没东西可导出");
    const nodes = articleNodes(items);
    if (!nodes.length) throw new Error("这个空间只有连线，没有可成文的文字");

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
    if (!items.length) throw new Error("这个空间还是空的，没东西可导出");
    const nodes = articleNodes(items);
    if (!nodes.length) throw new Error("这个空间只有连线，没有可成文的文字");
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
    if (!items.length) throw new Error("这个空间还是空的，没东西可导出");
    const box = contentBox(items);
    if (!box) throw new Error("这个空间只有连线，没东西可导出");
    const name = (getMeta().name || "空间").trim() || "空间";

    if (format === "wechat") {
      const html = await buildArticle(name);
      return {
        format: "html",
        name: `${name} · 公众号`,
        data: bytesToBase64(new TextEncoder().encode(html)),
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

    if (format === "html") {
      const html = await buildHtml(box, name);
      /* 网页是文本，走 UTF-8 字节再转 base64：直接 btoa 会把中文弄坏 */
      return { format, name, data: bytesToBase64(new TextEncoder().encode(html)) };
    }

    /* 先定倍数再建图，画完再放大只会糊 */
    const { scale, capped } = scaleFor(box, options.quality);
    const prepared = await prepareWorld();
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
    if (!items.length) throw new Error("这个空间还是空的，没东西可导出");
    const box = contentBox(items);
    if (!box) throw new Error("这个空间只有连线，没东西可导出");
    const name = (getMeta().name || "空间").trim() || "空间";

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


  /* 截图：给 agent「看」自己刚画出来的东西。
   *
   * 和导出的区别只在「框哪儿」和「多大」。截图是回给模型看的，越大越亏 token，
   * 所以默认 1600 长边。但长卷整张缩到 1600 长边时字只有一两个像素，
   * 所以给了 scale：需要读字就指定倍数（上限 4），或者干脆框一块区域来看。
   * region 三种：all（所有块）、viewport（用户此刻看到的这一屏）、{x,y,w,h}（指定矩形）。
   */
  async function snapshot(options = {}) {
    const items = getItems();
    if (!items.length) throw new Error("这个空间还是空的，没有画面可看");

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
      if (!box) throw new Error("这个空间只有连线，没有可看的块");
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
    const canvas = await renderRegion(prepared, box, box.w * scale, box.h * scale, scale);
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

  return {
    exportAs: run,
    exportSlices,
    plan,
    snapshot,
    reportError(error) {
      onError?.(error);
    },
  };
}
