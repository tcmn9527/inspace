/* Markdown 渲染：内嵌 marked（src/vendor/marked.umd.js，MIT），这里只管三件事：
 *
 *   1. 原始 HTML 一律转义 —— .md 是磁盘上的外部文件，不能让里面的 <script>
 *      在 WebView 里跑起来（能拿到 window.__TAURI__）；
 *   2. 链接 / 图片协议白名单，javascript:、data: 之类直接丢掉；
 *   3. 其余语法（标题、表格、任务列表、代码块、删除线…）全部交给 GFM。
 *
 * 渲染结果是纯字符串，调用方塞进容器的 innerHTML。 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/* 只放行明确的几种协议，锚点放行；其余（含相对路径）一律返回空串 */
function safeUrl(raw) {
  const url = String(raw ?? "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  if (url.startsWith("#")) return url;
  return "";
}

const marked = window.marked;

/* 只放行一种行内 HTML：<span style="color:#rgb"> / <span style="background-color:#rgb">
   以及对应的闭合标签。这是「文字颜色 / 背景色」工具栏写进去的那一种，
   其它任何 HTML 仍然一律转义。 */
const SAFE_SPAN = /^<\/?span(?:\s+style="(?:color|background-color):#[0-9a-fA-F]{3,8}")?>$/;

marked.use({
  gfm: true,
  // 单个换行也渲染成 <br>：编辑器里回车换到第几行，预览里就显示在第几行（所见即所得）。
  breaks: true,
  renderer: {
    // 块级 / 行内 HTML 都走这里：默认整段转义，只有上面那种 span 放行
    html(token) {
      const text = String(token.text ?? "").trim();
      if (SAFE_SPAN.test(text)) return text;
      return escapeHtml(token.text);
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeUrl(token.href);
      if (!href) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title} rel="noreferrer noopener">${text}</a>`;
    },
    image(token) {
      const alt = escapeHtml(token.text);
      const href = String(token.href || "").trim();
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      if (!href) return `<span class="md-image-missing">[图片：${alt || "未指定"}]</span>`;
      // 网络图片 / 内联图直接给 src
      if (/^(https?:|data:)/i.test(href)) {
        return `<img src="${escapeHtml(href)}" alt="${alt}"${title} loading="lazy">`;
      }
      // 其它协议（javascript: 等）一律丢弃
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        return `<span class="md-image-missing">[图片：${alt || "不支持"}]</span>`;
      }
      // 相对路径：交给笔记页读成本地 data URL 再填 src
      return `<img class="md-local-img" data-src="${escapeHtml(href)}" alt="${alt}"${title}>`;
    },
  },
});

export function renderMarkdown(source) {
  try {
    return marked.parse(String(source ?? ""));
  } catch (err) {
    return `<pre class="md-error">Markdown 渲染失败：${escapeHtml(err?.message || err)}</pre>`;
  }
}

/* 正文里的外链不在应用内跳转，交给系统浏览器 */
export function externalUrlFrom(node) {
  const anchor = node.closest?.("a[href]");
  if (!anchor) return null;
  const href = anchor.getAttribute("href") || "";
  return safeUrl(href) || null;
}
