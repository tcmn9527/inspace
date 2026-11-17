/* 从 export.js 拆出：查看器与公众号页面的样式和脚本字符串 */

  /* 单文件网页的样式。只放查看器自己的几条，剩下全靠原应用的样式表。 */
export const VIEWER_CSS = `
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
export const VIEWER_SCRIPT = `
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

export const WECHAT_WIDTH = 677;
export const FONT_STACK =
    '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  /* 写进 style="..." 时不能用双引号，属性会被提前截断 */
export const FONT_STACK_ATTR = FONT_STACK.replace(/"/g, "'");
export const CARD_FILL = "#fbf7ef";


  /* 页面自带一个「复制全文」按钮：复制走 execCommand 选中渲染后的文章，
     剪贴板里落的是富文本，粘到公众号编辑器样式就跟着过去了。
     按钮和页面样式只作用于这个查看页，不进选区，不会被复制进去。 */
export const WECHAT_PAGE_CSS = `
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

export const WECHAT_PAGE_SCRIPT = `
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
