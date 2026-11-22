/* 文本块的字级样式：只允许极窄的一撮 HTML 落盘/回显。
 *
 * 富文本编辑出来的是 <span style="..."> 加换行标签，但画布数据会跟着
 * items.json 在机器之间传来传去，绝不能把外部塞进来的 <script>/on* /
 * url() 也一并放进 innerHTML。这里按白名单重造一遍 DOM：
 *   - 文本、<br>、<div>、<b>/<strong>/<i>/<em>/<u>/<s> 原样保留结构；
 *   - <span> 只留 font-size / color / background-color 三条声明，值也必须合规；
 *   - 其它标签（script、img、a、font……）只留里面的文字，属性一律丢掉。
 */

const INLINE_TAGS = new Set(["b", "strong", "i", "em", "u", "s"]);
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const FONT_SIZE = /^\d{1,3}px$/;

/* 浏览器把内联颜色规范化成 rgb()，而落盘统一用 #hex。
   两种都收，rgb 的顺手转成 hex，不然实时预览设的颜色会被这里清掉。 */
function toHex(value) {
  const m = String(value).match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return value;
  return `#${[m[1], m[2], m[3]]
    .map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function cleanStyle(raw) {
  const kept = [];
  for (const part of String(raw || "").split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (prop === "font-size" && FONT_SIZE.test(value)) kept.push(`font-size:${value}`);
    else if (prop === "color" || prop === "background-color") {
      const hex = toHex(value);
      if (COLOR.test(hex)) kept.push(`${prop}:${hex}`);
    }
  }
  return kept.join(";");
}

/* 返回可以安全塞进 innerHTML 的片段；空串表示没有可保留的样式/内容。 */
export function sanitizeInlineHtml(raw) {
  if (typeof raw !== "string" || !raw) return "";
  const tpl = document.createElement("template");
  tpl.innerHTML = raw;

  const out = document.createElement("div");
  const walk = (from, to) => {
    for (const child of [...from.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        to.append(document.createTextNode(child.nodeValue));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "br") {
        to.append(document.createElement("br"));
        continue;
      }
      if (tag === "span") {
        const span = document.createElement("span");
        const style = cleanStyle(child.getAttribute("style"));
        if (style) span.setAttribute("style", style);
        walk(child, span);
        to.append(span);
        continue;
      }
      if (tag === "div" || INLINE_TAGS.has(tag)) {
        const keep = document.createElement(tag);
        walk(child, keep);
        to.append(keep);
        continue;
      }
      /* 不认的标签连标签带属性一起丢，里面的文字照留 */
      walk(child, to);
    }
  };
  walk(tpl.content, out);
  return out.innerHTML;
}
