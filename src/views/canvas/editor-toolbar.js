/* 编辑态顶部工具栏的公共宿主。
 *
 * 文本块编辑（字号 / 文字色 / 背景色）和 Markdown 文件编辑（笔记那套
 * md-toolbar）都把各自的条挂到这里：画布顶部居中、脱离块本身，块在画布
 * 上跑到哪儿工具栏都钉在同一处。同一时刻谁想挂就挂，退出编辑自己摘掉；
 * 宿主空了就隐藏。 */

const HOST_ID = "canvas-editor-toolbar";
export const EDITOR_TOOLBAR_GUARD = `#${HOST_ID}`;

let host = null;

function ensureHost() {
  if (host?.isConnected) return host;
  host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.className = "editor-toolbar-host";
    host.setAttribute("role", "toolbar");
    (document.querySelector(".canvas-content") || document.body).append(host);
  }
  return host;
}

function syncHost() {
  if (!host) return;
  const empty = host.childElementCount === 0;
  host.hidden = empty;
  host.classList.toggle("is-visible", !empty);
}

/* 挂上去并显出来；同一个节点重复挂只会移动，不会叠两份 */
export function mountEditorToolbar(node) {
  if (!node) return;
  const root = ensureHost();
  if (node.parentNode !== root) root.append(node);
  root.hidden = false;
  root.classList.add("is-visible");
}

/* 只摘自己那一条，别把别人的工具栏顺手清了 */
export function unmountEditorToolbar(node) {
  if (node?.parentNode) node.parentNode.removeChild(node);
  syncHost();
}

export function clearEditorToolbar() {
  const root = ensureHost();
  root.textContent = "";
  syncHost();
}

/* 富文本编辑期间放开画布的文字选择。
   body 上是 user-select:none（防误选），从编辑区拖选、指针移到面板外时，
   落进 none 区域会让浏览器把选区折叠掉——看着就是「选中的字突然掉了」。
   进入编辑 +1、退出 -1，重叠过渡时不会提前把 class 摘掉。 */
let selectHolds = 0;
export function holdCanvasTextSelection() {
  selectHolds += 1;
  document.body.classList.add("is-text-editing");
}
export function releaseCanvasTextSelection() {
  selectHolds = Math.max(0, selectHolds - 1);
  if (!selectHolds) document.body.classList.remove("is-text-editing");
}
/* 切画布/空态：编辑态被整体清掉，计数直接归零，别留下 is-text-editing */
export function resetCanvasTextSelection() {
  selectHolds = 0;
  document.body.classList.remove("is-text-editing");
}
