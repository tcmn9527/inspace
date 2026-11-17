/* 从 export.js 拆出：导出用常量、CSS 收集与 PDF 拼装 */

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XHTML_NS = "http://www.w3.org/1999/xhtml";
/* 留白：块的边框和阴影不至于被切在边上 */
export const PADDING = 56;

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
export const MAX_PIXELS = 120_000_000;
export const MAX_SIDE = 60_000;
/* 分段导出：每段的高度。一段一个文件，3000 万像素以内，图片查看器都吃得下 */
export const SEGMENT_PIXELS = 6_000;
export const MAX_SEGMENT_PIXELS = 30_000_000;
/* 分片渲染的片大小。整张长图一次交给浏览器解码，峰值内存会翻好几倍；
   切成 4096 见方逐片画到同一张画布上，峰值只跟片大小有关，成品像素一点不少。 */
export const TILE = 4096;

/* 选中框、端口、吸附辅助线这些只是操作时的记号，不该出现在导出的图里。
   .canvas-port 是连线两端那几颗圈，选中时才画，静态图里就是一点脏东西 */
export const OVERLAY_SELECTOR =
  ".canvas-sel-box, .canvas-port-box, .canvas-port, .canvas-guide, .canvas-handle, .canvas-scene-selection";

/* 卡片里那些滚动条在静态图里看着像画坏了；导出画布又没有「滚动」这回事 */
export const EXPORT_CSS = `
.canvas-export-root *::-webkit-scrollbar { width: 0; height: 0; display: none; }
.canvas-export-root * { scrollbar-width: none; }
`;

export function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function concatBytes(parts) {
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

export function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* 最小 PDF：一页，里面就一张 JPEG。没有外部依赖，够用也够稳。 */
export function buildPdf(jpeg, imageW, imageH) {
  return buildPdfPages([{ jpeg, imageW, imageH }]);
}

/* 多页 PDF：每页一张 JPEG，页尺寸按图片比例折算；每页三件对象（页 / 图 / 内容） */
export function buildPdfPages(pages) {
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
  const count = pages.length;

  pushText("%PDF-1.4\n");

  startObject();
  pushText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObject();
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  pushText(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${count} >>\nendobj\n`);

  pages.forEach((page, index) => {
    /* 画布像素换成分（1px ≈ 0.75pt），再收进 PDF 允许的页面尺寸里 */
    const ratio = Math.min(0.75, 14400 / Math.max(page.imageW, page.imageH));
    const pageW = Math.max(1, Math.round(page.imageW * ratio));
    const pageH = Math.max(1, Math.round(page.imageH * ratio));
    const content = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`;
    const pageNo = 3 + index * 3;
    const imageNo = 4 + index * 3;
    const contentNo = 5 + index * 3;

    startObject();
    pushText(
      `\n${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
        `/Resources << /XObject << /Im0 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`,
    );

    startObject();
    pushText(
      `\n${imageNo} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.imageW} /Height ${page.imageH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    pushBytes(page.jpeg);
    pushText("\nendstream\nendobj\n");

    startObject();
    pushText(`\n${contentNo} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  });

  const xref = cursor;
  pushText(`xref\n0 ${count * 3 + 3}\n0000000000 65535 f \n`);
  for (const offset of offsets) {
    pushText(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${count * 3 + 3} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return concatBytes(parts);
}

/* 当前文档里所有样式规则。取不到的（跨域字体表之类）直接跳过，不该为它挡住导出。 */
export function collectCss() {
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
export function themeVars() {
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
