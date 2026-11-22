/* 选中文字的字级工具栏：字号 / 文字色 / 背景色，挂在画布顶部中间。
 *
 * 服务「文本文件块」的富文本编辑区：只对编辑区里的非空选区生效，
 * 没有选中文字时整条灰化。颜色走块上取色盘那一套，字号给几个常用档位。
 * 样式写进 <span style="...">，落盘时由 inline-html 白名单清洗。 */

import { openColorPicker } from "../color-picker.js";
import { sanitizeInlineHtml } from "../inline-html.js";
import { mountEditorToolbar, unmountEditorToolbar } from "./editor-toolbar.js";

const SIZES = [12, 14, 16, 18, 20, 24, 32];
const COLOR_PRESETS = ["#000000", "#e5484d", "#f08c00", "#2f9e44", "#1971c2", "#7048e8"];
const BG_PRESETS = ["#fff3bf", "#d3f9d8", "#d0ebff", "#ffdeeb", "#e5dbff", "#e9ecef"];

let current = null; // { body, root, onChange, sizeInput }
let savedRange = null; // 打开色盘前留住选区，色盘那边点完还能贴回原处
let lastValidRange = null; // 最近一次非空选区：输入框/色盘抢焦点后还能贴回来
let editingSize = false; // 字号输入框正在打字：此时选区折叠不算「没选中」
let currentCloseMenu = null; // 当前工具栏的下拉菜单关闭器，退出编辑时收掉

/* ---------- 编辑输入期间的选区高亮 ----------
   字号输入框一拿焦点，编辑区就失焦，浏览器不再给选区上色（选区本身还在，
   提交时照样精确落到那些字上）。这里用一层纯展示的矩形把「选着的是哪些字」
   画回来，让用户打字时心里有数；不碰编辑区 DOM，摘掉时也不留痕迹。 */
let selectionOverlay = null;
let overlayRange = null;

function clearSelectionOverlay() {
  if (!selectionOverlay) return;
  window.removeEventListener("scroll", repaintSelectionOverlay, true);
  window.removeEventListener("resize", repaintSelectionOverlay);
  selectionOverlay.remove();
  selectionOverlay = null;
  overlayRange = null;
}

function repaintSelectionOverlay() {
  if (!overlayRange) return;
  paintSelectionOverlay(overlayRange, true);
}

function paintSelectionOverlay(range, keep = false) {
  if (!keep) clearSelectionOverlay();
  if (!range) return;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  if (!rects.length) return;
  const layer = selectionOverlay || document.createElement("div");
  layer.className = "text-selection-overlay";
  layer.textContent = "";
  for (const r of rects) {
    const box = document.createElement("span");
    box.className = "text-selection-box";
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    layer.append(box);
  }
  if (!selectionOverlay) {
    document.body.append(layer);
    selectionOverlay = layer;
    window.addEventListener("scroll", repaintSelectionOverlay, true);
    window.addEventListener("resize", repaintSelectionOverlay);
  }
  overlayRange = range;
}

/* 拖选保持：拖选一旦建立，按住左键移出编辑区/面板时浏览器可能把选区折叠
   （落到 user-select:none 的区域、或焦点变动都会触发）。只要这次按键还在、
   且已经有过有效选区，就把它恢复回去，直到松手。 */
let dragSelect = null; // { body, lastRange }

function selectionIn(body) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  if (sel.anchorNode && sel.focusNode && body.contains(sel.anchorNode) && body.contains(sel.focusNode)) {
    return sel;
  }
  return null;
}

function onDragSelectStart(e) {
  if (!current || e.button !== 0) return;
  dragSelect = { body: current.body, lastRange: null };
}

function onDragSelectMove() {
  if (!dragSelect) return;
  const sel = selectionIn(dragSelect.body);
  if (sel && !sel.isCollapsed) {
    dragSelect.lastRange = sel.getRangeAt(0).cloneRange();
    return;
  }
  /* 拖选过程中选区掉了：恢复上一次有效选区 */
  if (dragSelect.lastRange) {
    const restored = window.getSelection();
    restored.removeAllRanges();
    restored.addRange(dragSelect.lastRange);
  }
}

function onDragSelectEnd() {
  dragSelect = null;
}

/* 选中内容里得真有字，才算「选中了文字」。
   双击行尾、空行时浏览器会把换行符 / <br> / 零宽字符一起选进去：isCollapsed 是
   false，可屏幕上一点高亮都看不到，工具栏却会亮起来——点下去什么也改不了。 */
function selectionHasText(sel) {
  const text = (sel?.toString?.() || "").replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "").trim();
  return text.length > 0;
}

function hasSelection(body) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
  if (!sel.anchorNode || !sel.focusNode) return false;
  if (!body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) return false;
  return selectionHasText(sel);
}

/* ---------- 实时预览 ----------
   拖动色盘 / 输入字号时，文字要跟着当场变。做法：第一次先把选区包成一个
   带样式的 span（Range API，不需要编辑区焦点，不打断输入），之后每次变化
   只改这个 span 的 style，不再重建 DOM——否则每动一下就重排、选区也会乱。 */
let live = null; // { span, prop, baseValue }

/* 选区恰好覆盖某个 span 的全部内容时直接复用那个 span，别再包一层。
   否则先设字号、再设颜色就会套成 <span><span>…，DOM 越叠越深。
   判断用「文本长度 + 起止都在 span 内」，比 compareBoundaryPoints 稳：
   后者遇到选区端点在 span 元素节点上时会误判。 */
function reusableSpan(range) {
  const startEl = range.startContainer?.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer?.parentElement;
  if (!startEl || startEl.tagName !== "SPAN" || startEl === current?.body) return null;
  const span = startEl;
  if (!span.contains(range.endContainer)) return null;
  /* 选中长度必须正好等于这个 span 的全部文字，才是「整段都是它」 */
  const picked = range.cloneContents();
  const box = document.createElement("div");
  box.append(picked);
  const pickedLen = (box.textContent || "").length;
  const spanLen = (span.textContent || "").length;
  if (!spanLen || pickedLen !== spanLen) return null;
  return span;
}

function startLive(range, prop, value) {
  endLive(false);
  if (!range) return null;
  const inherited = inheritedStyle(range.startContainer);
  const baseValue = inherited[prop] || "";
  const reuse = reusableSpan(range);
  if (reuse) {
    /* 已有 span 直接改它的样式，不重排 DOM；记下原来的 style 供取消时整条还原 */
    live = { span: reuse, prop, baseValue, snapshot: reuse.getAttribute("style") || "" };
    if (value) reuse.style.setProperty(prop, value);
    return reuse;
  }
  const span = document.createElement("span");
  for (const [key, val] of Object.entries({ ...inherited, [prop]: value })) {
    if (val) span.style.setProperty(key, val);
  }
  span.append(range.extractContents());
  range.insertNode(span);
  live = { span, prop, baseValue, snapshot: null };
  return span;
}

function updateLive(prop, value) {
  if (!live?.span?.isConnected) return false;
  if (prop !== live.prop) {
    /* 换了一种样式（比如先调色再调背景），直接把新属性加到同一个 span 上 */
    live.prop = prop;
    live.baseValue = live.span.style.getPropertyValue(prop) || "";
  }
  if (value) live.span.style.setProperty(prop, value);
  else live.span.style.removeProperty(prop);
  current?.onChange?.();
  return true;
}

/* commit=true 保留预览结果；false 还原成开始时的样子 */
function endLive(commit) {
  if (!live) return;
  const { span, prop, baseValue, snapshot } = live;
  live = null;
  if (!span.isConnected) return;
  if (!commit) {
    if (snapshot != null) {
      /* 复用的 span：整条 style 还原成进来时的样子 */
      span.setAttribute("style", snapshot);
      if (!snapshot) span.removeAttribute("style");
    } else if (baseValue) {
      span.style.setProperty(prop, baseValue);
    } else {
      span.style.removeProperty(prop);
    }
    if (!span.getAttribute("style")) {
      /* 样式全空了就把这层壳拆掉，别在正文里留空 span */
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  } else {
    /* 落定后把选区放回这段文字上，工具栏继续可用，也能接着调别的样式 */
    const sel = window.getSelection();
    const back = document.createRange();
    back.selectNodeContents(span);
    sel?.removeAllRanges();
    sel?.addRange(back);
    lastValidRange = back.cloneRange();
  }
  current?.onChange?.();
}

/* 把编辑区的选区高亮画出来（字号输入期间编辑区失焦，靠它显示选着哪些字） */
function rangeOf(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  return r;
}

function refreshEnabled() {
  if (!current) return;
  /* 字号输入框拿着焦点时选区已折叠，但这不算「没选中」，别把整条灰掉 */
  const active = hasSelection(current.body) || editingSize || Boolean(live);
  current.root.classList.toggle("is-disabled", !active);
  for (const button of current.root.querySelectorAll("button")) button.disabled = !active;
  if (current.sizeInput) {
    current.sizeInput.readOnly = !active;
    current.sizeInput.classList.toggle("is-locked", !active);
  }
  if (!active) {
    /* 没有有效选区了就把快照清掉，免得之后拿它把样式贴到早就没选中的文字上 */
    lastValidRange = null;
    return;
  }
  const sel = window.getSelection();
  /* 只要选区还在编辑区里、且真的圈住了字，就记下来：接下来鼠标点输入框/色盘会把
     选区弄折叠，提交时得靠这份快照把样式贴回原来的字上。 */
  if (sel?.rangeCount && !sel.isCollapsed && current.body.contains(sel.anchorNode) && selectionHasText(sel)) {
    lastValidRange = sel.getRangeAt(0).cloneRange();
  }
  const anchor = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
  const px = anchor?.closest?.("span[style]")?.style.fontSize || "";
  for (const option of current.root.querySelectorAll(".text-size-option")) {
    option.classList.toggle("is-active", px && option.dataset.size === String(parseInt(px, 10)));
  }
  /* 输入框里没在打字时，跟着选区显示当前字号 */
  if (current.sizeInput && document.activeElement !== current.sizeInput) {
    current.sizeInput.value = px ? String(parseInt(px, 10)) : "";
  }
}

/* 把当前（或色盘打开前留住的）选区包一层带样式的 span，再交回编辑态保存。 */
/* 把 rgb(211, 249, 216) / rgba(...) 转成 #d3f9d8。
   el.style.getPropertyValue() 会把我们写进去的 #hex 规范化成 rgb()，
   而落盘的 sanitizeInlineHtml 只收 #hex——不转回去，继承来的颜色会被清掉。 */
function colorToHex(value) {
  const m = String(value).match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return value;
  return `#${[m[1], m[2], m[3]]
    .map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/* 选区落在已有样式的 span 内部时，cloneContents 只拿到里面的纯文本，
   外层 span 的样式会丢——第二次设颜色就会把第一次设的字号冲掉。
   这里从选区起点往上把祖先 span 的样式收齐，合并进新 span。 */
function inheritedStyle(node) {
  const found = {};
  let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (el && el !== current.body) {
    if (el.tagName === "SPAN" && el.style) {
      for (const prop of ["font-size", "color", "background-color"]) {
        if (!found[prop]) {
          const value = el.style.getPropertyValue(prop);
          if (value) found[prop] = prop === "font-size" ? value : colorToHex(value);
        }
      }
    }
    el = el.parentElement;
  }
  return found;
}

function applyStyle(prop, value) {
  if (!current) return;
  const { body, onChange } = current;
  const sel = window.getSelection();
  /* 优先用色盘/输入框按下时存的选区；都没有就退回最近一次有效选区 */
  const live = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
  const range = savedRange || live || lastValidRange;
  savedRange = null;
  if (!range || !body.contains(range.commonAncestorContainer)) return;
  /* 圈住的只是换行/空白：什么字都没选中，别往空处套样式 */
  if (!selectionHasText(range)) return;

  body.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(range);

  const picked = document.createElement("div");
  picked.append(range.cloneContents());
  const inner = sanitizeInlineHtml(picked.innerHTML);
  const merged = { ...inheritedStyle(range.startContainer), [prop]: value };
  const styleText = Object.entries(merged)
    .map(([key, val]) => `${key}:${val}`)
    .join(";");

  /* 用唯一标记，别用固定属性——编辑区里若有上次残留的标记会选中错的 span。 */
  const token = `tf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const span = `<span data-text-fmt="${token}" style="${styleText}">${inner}</span>`;
  document.execCommand("insertHTML", false, span);

  /* 新包出来的 span 重新选中，好接着改第二处样式；标记属性清洗时会被丢掉 */
  const mark = body.querySelector(`span[data-text-fmt="${token}"]`);
  if (mark) {
    mark.removeAttribute("data-text-fmt");
    const next = document.createRange();
    next.selectNodeContents(mark);
    sel.removeAllRanges();
    sel.addRange(next);
  }
  /* 不要把新 span 的 range 留在 savedRange：那是给「色盘打开期间」暂存选区用的。
     留着会让下一次直接点字号时误用旧选区，把整段 span 一起改掉。
     连续设置样式靠上面 sel.addRange 已经设好的真实选区就够了。 */
  savedRange = null;
  onChange?.();
  refreshEnabled();
}

function openColorMenu(button, prop) {
  if (!current || button.disabled) return;
  const sel = window.getSelection();
  const range = savedRange || lastValidRange || (sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null);
  savedRange = null;
  const rect = button.getBoundingClientRect();
  const isText = prop === "color";

  /* 先把选中文字包成可实时改色的 span，再把浏览器原生的选中高亮去掉——
     否则蓝色选中层盖在字上，拖动色盘时看不清颜色到底变成什么样。
     初始值取「这段文字现在的颜色」，没有就不设，别一开面板就把字染成黑色。 */
  const inheritedNow = inheritedStyle(range?.startContainer);
  const startValue = inheritedNow[prop] || "";
  const span = startLive(range, prop, startValue);
  if (sel) sel.removeAllRanges();
  clearSelectionOverlay();
  refreshEnabled();

  /* 面板里那颗取色点落在当前色上；没设过就用默认落点（只影响显示，不改文字） */
  const currentHex = span ? colorToHex(span.style.getPropertyValue(prop)) : "";
  openColorPicker({
    x: Math.max(8, rect.left - 70),
    y: rect.bottom + 6,
    value: currentHex,
    seed: isText ? "#000000" : "#fff3bf",
    presets: isText ? COLOR_PRESETS : BG_PRESETS,
    onChange: (color) => {
      if (color) updateLive(prop, color);
    },
    onDone: (color) => {
      if (color) updateLive(prop, color);
      endLive(true);
    },
    onClose: (commit) => {
      /* 没确认就关（Esc/点外面取消）→ 还原成打开前 */
      if (!commit) endLive(false);
    },
  });
}

function makeButton(className, label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.disabled = true;
  /* 按钮不许抢走 contentEditable 的焦点，否则选区当场就没了 */
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(button);
  });
  return button;
}

function buildRoot() {
  const root = document.createElement("div");
  root.className = "canvas-editor-toolbar text-format-toolbar";
  root.setAttribute("aria-label", "文字格式工具栏");

  const label = document.createElement("span");
  label.className = "text-toolbar-label";
  label.textContent = "字号";
  root.append(label);

  /* 字号合成一格：左边直接输入任意值，右边 ▾ 拉出常用字号。
     输入框拿焦点会让编辑区失焦，所以按下那一瞬先把选区存进 savedRange。 */
  const sizeWrap = document.createElement("div");
  sizeWrap.className = "text-size-combo";
  const sizeInput = document.createElement("input");
  sizeInput.className = "text-tool-size-input";
  sizeInput.type = "text";
  sizeInput.inputMode = "numeric";
  sizeInput.autocomplete = "off";
  sizeInput.spellcheck = false;
  sizeInput.placeholder = "字号";
  sizeInput.title = "输入字号后回车（8–200），或点 ▾ 选常用字号";
  /* 不用 disabled：disabled 的输入框没法聚焦，点它什么都不会发生。
     用 readOnly + 透明样式表示「当前没选中文字」，选中后放开。 */
  sizeInput.readOnly = true;
  sizeInput.setAttribute("aria-label", "字号");
  const beginSizeEdit = () => {
    const sel = window.getSelection();
    let range = null;
    if (sel?.rangeCount && !sel.isCollapsed && selectionHasText(sel) && current?.body.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0).cloneRange();
    } else if (!savedRange && lastValidRange) {
      range = lastValidRange.cloneRange();
    }
    /* 圈住的只是换行/空白：不算选中，别让输入框变可编辑、工具条亮起来 */
    if (!range) {
      editingSize = false;
      refreshEnabled();
      return;
    }
    savedRange = range;
    editingSize = true;
    refreshEnabled();
    /* 编辑区马上要失焦，把选区画成覆盖层，打字期间一直看得见选着哪些字 */
    paintSelectionOverlay(range);
  };
  /* 输入过程中实时套用：把范围框在「改动的那段」上，用户边敲边看到字变大变小 */
  const previewSize = () => {
    const raw = Number(sizeInput.value);
    if (!editingSize || !Number.isFinite(raw) || !raw) return;
    const px = Math.max(8, Math.min(200, Math.round(raw)));
    if (!live) {
      /* 第一次改：把选区包成一个 span，之后只改它的字号 */
      const span = startLive(savedRange || lastValidRange, "font-size", `${px}px`);
      if (!span) return;
      savedRange = null;
    } else {
      updateLive("font-size", `${px}px`);
    }
    /* 覆盖层跟着实时 span 走，字号一变框也得跟着变 */
    if (live?.span) paintSelectionOverlay(rangeOf(live.span), true);
    refreshEnabled();
  };
  const commitSize = () => {
    const raw = Number(sizeInput.value);
    if (!Number.isFinite(raw) || !raw) {
      /* 没填或填了乱码：还原成当前选区字号 */
      editingSize = false;
      endLive(false);
      clearSelectionOverlay();
      refreshEnabled();
      return;
    }
    const px = Math.max(8, Math.min(200, Math.round(raw)));
    sizeInput.value = String(px);
    editingSize = false;
    if (live) endLive(true);
    else applyStyle("font-size", `${px}px`);
    clearSelectionOverlay();
    refreshEnabled();
  };
  sizeInput.addEventListener("pointerdown", beginSizeEdit);
  /* focus 也走一遍：键盘 Tab 进来、或程序化聚焦时同样要保住选区 */
  sizeInput.addEventListener("focus", beginSizeEdit);
  /* click 兜底：某些合成点击只发 click、不发 pointerdown/focus */
  sizeInput.addEventListener("click", beginSizeEdit);
  /* 边打边预览：文字当场跟着变大小 */
  sizeInput.addEventListener("input", previewSize);
  sizeInput.addEventListener("keydown", (e) => {
    /* 别让输入框的按键冒泡到画布快捷键（Delete/方向键之类） */
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      /* 让 setRangeText 之类的默认行为先落定再读值 */
      commitSize();
      sizeInput.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingSize = false;
      endLive(false);
      clearSelectionOverlay();
      sizeInput.blur();
      refreshEnabled();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      /* 上下键微调字号，同样实时预览 */
      e.preventDefault();
      const now = Number(sizeInput.value) || 0;
      const next = Math.max(8, Math.min(200, now + (e.key === "ArrowUp" ? 1 : -1)));
      sizeInput.value = String(next);
      previewSize();
    }
  });
  /* 点别处收工：有值就应用，没值就还原成进输入框前的样子 */
  sizeInput.addEventListener("blur", () => {
    if (!editingSize) return;
    if (sizeInput.value.trim()) commitSize();
    else {
      editingSize = false;
      endLive(false);
      clearSelectionOverlay();
      refreshEnabled();
    }
  });

  /* 下拉箭头：拉出常用字号。按下不许抢焦点，否则输入框先 blur 提交一次，选完又提交一次。 */
  const sizeToggle = document.createElement("button");
  sizeToggle.type = "button";
  sizeToggle.className = "text-size-toggle";
  sizeToggle.tabIndex = -1;
  sizeToggle.setAttribute("aria-label", "选择常用字号");
  sizeToggle.title = "常用字号";
  const arrow = document.createElement("span");
  arrow.className = "text-size-caret";
  sizeToggle.append(arrow);

  const sizeMenu = document.createElement("div");
  sizeMenu.className = "text-size-menu";
  sizeMenu.hidden = true;
  for (const size of SIZES) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "text-size-option";
    option.textContent = String(size);
    option.dataset.size = String(size);
    option.addEventListener("mousedown", (e) => e.preventDefault());
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSizeMenu();
      /* 用预设值直接应用；输入框同步显示，方便接着看/改 */
      sizeInput.value = String(size);
      editingSize = false;
      clearSelectionOverlay();
      applyStyle("font-size", `${size}px`);
    });
    sizeMenu.append(option);
  }

  const closeSizeMenu = () => {
    if (sizeMenu.hidden) return;
    sizeMenu.hidden = true;
    sizeToggle.classList.remove("is-open");
    document.removeEventListener("pointerdown", onDocDownSize, true);
    document.removeEventListener("click", onDocDownSize, true);
    document.removeEventListener("keydown", onDocEscSize, true);
  };
  const onDocDownSize = (e) => {
    if (!sizeWrap.contains(e.target)) closeSizeMenu();
  };
  /* 菜单开着时 Esc 只收菜单，别让它继续冒泡把整个编辑态退掉 */
  const onDocEscSize = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeSizeMenu();
  };
  const openSizeMenu = () => {
    if (!sizeMenu.hidden) return;
    beginSizeEdit();
    sizeMenu.hidden = false;
    sizeToggle.classList.add("is-open");
    /* pointerdown 覆盖真实鼠标；click 兜底合成点击（DOM click 不派发 pointerdown） */
    document.addEventListener("pointerdown", onDocDownSize, true);
    document.addEventListener("click", onDocDownSize, true);
    document.addEventListener("keydown", onDocEscSize, true);
    refreshEnabled();
  };
  sizeToggle.addEventListener("mousedown", (e) => e.preventDefault());
  sizeToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (sizeToggle.disabled) return;
    if (sizeMenu.hidden) openSizeMenu();
    else closeSizeMenu();
  });
  currentCloseMenu = closeSizeMenu;

  sizeWrap.append(sizeInput, sizeToggle, sizeMenu);
  root.append(sizeWrap);

  /* 点工具栏任何地方都别把编辑区弄失焦：失焦会触发 blur 退出编辑态。
     输入框要留给它自己拿焦点，其余（标签、色块、空隙）一律拦掉默认行为。 */
  root.addEventListener("pointerdown", (e) => {
    if (e.target.closest("input, textarea")) return;
    e.preventDefault();
  });

  const sep = document.createElement("span");
  sep.className = "md-tool-sep";
  root.append(sep);

  const colorLabel = document.createElement("span");
  colorLabel.className = "text-toolbar-label";
  colorLabel.textContent = "文字色";
  root.append(colorLabel);
  const color = makeButton("md-tool md-tool-color", "", "文字颜色", (button) => openColorMenu(button, "color"));
  const colorSwatch = document.createElement("span");
  colorSwatch.className = "md-tool-swatch";
  color.append(colorSwatch);
  root.append(color);

  const bgLabel = document.createElement("span");
  bgLabel.className = "text-toolbar-label";
  bgLabel.textContent = "背景色";
  root.append(bgLabel);
  const bg = makeButton("md-tool md-tool-color", "", "文字背景色", (button) => openColorMenu(button, "background-color"));
  const bgSwatch = document.createElement("span");
  bgSwatch.className = "md-tool-swatch md-tool-swatch-bg";
  bg.append(bgSwatch);
  root.append(bg);

  return root;
}

/* 进入富文本编辑态时调用；onChange 在样式写入 DOM 后触发，用来存 richHtml。 */
export function openTextToolbar(body, onChange) {
  closeTextToolbar();
  const root = buildRoot();
  current = { body, root, onChange, sizeInput: root.querySelector(".text-tool-size-input") };
  mountEditorToolbar(root);
  /* 恢复逻辑排在 refreshEnabled 前面：先补回选区，按钮状态才算得准 */
  document.addEventListener("selectionchange", onDragSelectMove);
  document.addEventListener("selectionchange", refreshEnabled);
  body.addEventListener("pointerdown", onDragSelectStart);
  window.addEventListener("pointerup", onDragSelectEnd);
  window.addEventListener("pointercancel", onDragSelectEnd);
  refreshEnabled();
}

export function closeTextToolbar() {
  if (!current) return;
  document.removeEventListener("selectionchange", onDragSelectMove);
  document.removeEventListener("selectionchange", refreshEnabled);
  current.body.removeEventListener("pointerdown", onDragSelectStart);
  window.removeEventListener("pointerup", onDragSelectEnd);
  window.removeEventListener("pointercancel", onDragSelectEnd);
  currentCloseMenu?.();
  currentCloseMenu = null;
  unmountEditorToolbar(current.root);
  current = null;
  savedRange = null;
  lastValidRange = null;
  dragSelect = null;
  editingSize = false;
  clearSelectionOverlay();
}
