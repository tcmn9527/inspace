/* Markdown 编辑器：笔记页和画布笔记块共用同一套编辑能力。
 *
 * 工具栏、撤销/重做、文字颜色、粘贴图片、插入语法都从这里来，两边行为完全一致；
 * 值的去向由调用方决定（笔记页写回 .md，画布笔记块写回 items.json）。
 *
 * 用法：
 *   const editor = createMarkdownEditor({
 *     textarea, toolbar,
 *     saveImage: (base64, ext) => Promise<string>, // 返回写进 Markdown 的相对路径
 *     onChange: (value) => {},                     // 每次内容变化
 *     onStatus: (text) => {},                      // 轻量提示（可省略）
 *     onError: (message) => {},                    // 错误提示
 *   });
 *   editor.setValue(text); editor.setEnabled(true); editor.focus();
 */

import { openColorPicker } from "./color-picker.js";
import { openMenu } from "./menu.js";

export const EDITOR_TOOLS = [
  { action: "h1", label: "H1", title: "一级标题" },
  { action: "h2", label: "H2", title: "二级标题" },
  { action: "h3", label: "H3", title: "三级标题" },
  { action: "h4", label: "H4", title: "四级标题" },
  { action: "h5", label: "H5", title: "五级标题" },
  { action: "sep" },
  { action: "bold", label: "B", title: "加粗", strong: true },
  { action: "italic", label: "I", title: "斜体", italic: true },
  { action: "strike", label: "S", title: "删除线", strike: true },
  { action: "code", label: "‹›", title: "行内代码" },
  { action: "sep" },
  { action: "quote", label: "❝", title: "引用" },
  { action: "ul", label: "• 列表", title: "无序列表" },
  { action: "ol", label: "1. 列表", title: "有序列表" },
  { action: "task", label: "☑ 任务", title: "任务列表" },
  { action: "sep" },
  { action: "link", label: "链接", title: "插入链接" },
  { action: "image", label: "图片", title: "插入图片" },
  { action: "table", label: "表格", title: "插入表格" },
  { action: "hr", label: "分割线", title: "插入分割线" },
  { action: "sep" },
  { action: "codeblock", label: "代码块", title: "插入代码块" },
  { action: "color", label: "", title: "文字颜色 / 文字背景色" },
];

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createMarkdownEditor({
  textarea,
  toolbar,
  saveImage,
  onChange,
  onStatus = () => {},
  onError = () => {},
}) {
  const ta = textarea;
  let enabled = false;
  let colorTarget = null;
  const history = { stack: [], index: -1, lastPush: 0 };

  const emit = () => onChange?.(ta.value);

  // ---------- 撤销 / 重做 ----------

  function resetHistory(value) {
    history.stack = [{ value, start: value.length, end: value.length }];
    history.index = 0;
    history.lastPush = 0;
  }

  function pushHistory(force) {
    const now = Date.now();
    if (!force && now - history.lastPush < 350) return;
    history.lastPush = now;
    const value = ta.value;
    const current = history.stack[history.index];
    if (current && current.value === value) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push({ value, start: ta.selectionStart, end: ta.selectionEnd });
    if (history.stack.length > 120) history.stack.shift();
    history.index = history.stack.length - 1;
  }

  function applyHistory() {
    const snap = history.stack[history.index];
    if (!snap) return;
    ta.value = snap.value;
    const start = Math.min(snap.start, snap.value.length);
    const end = Math.min(snap.end, snap.value.length);
    ta.setSelectionRange(start, end);
    ta.focus({ preventScroll: true });
    onStatus(history.index === history.stack.length - 1 ? "已回到最新" : "已撤销");
    emit();
  }

  function undo() {
    if (history.index <= 0) return;
    history.index -= 1;
    applyHistory();
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index += 1;
    applyHistory();
  }

  // ---------- 选区操作 ----------

  function wrapSelection(before, after, placeholder) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const picked = ta.value.slice(start, end) || placeholder;
    const inserted = `${before}${picked}${after}`;
    ta.setRangeText(inserted, start, end, "end");
    ta.setSelectionRange(start + before.length, start + before.length + picked.length);
    ta.focus();
  }

  function toggleLinePrefix(prefix, pattern) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = value.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const allHave = lines.every((line) => pattern.test(line));
    const next = lines
      .map((line) => {
        const stripped = line.replace(pattern, "");
        return allHave ? stripped : `${prefix}${stripped}`;
      })
      .join("\n");
    ta.setRangeText(next, lineStart, lineEnd, "end");
    ta.setSelectionRange(lineStart, lineStart + next.length);
    ta.focus();
  }

  function insertText(text) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.setRangeText(text, start, end, "end");
    ta.focus();
    emit();
  }

  // ---------- 文字颜色 ----------

  function openColorMenu(button) {
    colorTarget = { start: ta.selectionStart, end: ta.selectionEnd };
    const rect = button.getBoundingClientRect();
    openMenu(Math.max(8, rect.left - 46), rect.bottom + 4, [
      { label: "文字颜色", onClick: () => pickTextColor("color", rect) },
      { label: "文字背景色", onClick: () => pickTextColor("background-color", rect) },
    ]);
  }

  function pickTextColor(prop, rect) {
    const isText = prop === "color";
    openColorPicker({
      x: Math.max(8, rect.left - 70),
      y: rect.bottom + 6,
      value: isText ? "#e5484d" : "#fff3bf",
      presets: isText
        ? ["#000000", "#e5484d", "#f08c00", "#2f9e44", "#1971c2", "#7048e8"]
        : ["#fff3bf", "#d3f9d8", "#d0ebff", "#ffdeeb", "#e5dbff", "#e9ecef"],
      onDone: (color) => applyColor(prop, color),
    });
  }

  function applyColor(prop, color) {
    const target = colorTarget || { start: ta.selectionStart, end: ta.selectionEnd };
    const start = Math.min(target.start, ta.value.length);
    const end = Math.min(target.end, ta.value.length);
    const picked = ta.value.slice(start, end) || "文字";
    const snippet = `<span style="${prop}:${color}">${picked}</span>`;
    ta.setRangeText(snippet, start, end, "end");
    const inner = start + snippet.indexOf(">") + 1;
    ta.setSelectionRange(inner, inner + picked.length);
    ta.focus();
    pushHistory(true);
    emit();
    onStatus("已应用颜色");
  }

  // ---------- 工具栏 ----------

  function runTool(action, button, event) {
    if (!enabled) return;
    ta.focus();
    pushHistory(true);
    if (action === "color") {
      /* 这个 click 会冒泡到 document，被 menu.js 的「点外部关菜单」当场把
         刚弹出来的菜单关掉（右键菜单是从 contextmenu 打开的，所以没这问题）。 */
      event?.stopPropagation();
      openColorMenu(button);
      return;
    }
    switch (action) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5": {
        const level = Number(action.slice(1));
        toggleLinePrefix(`${"#".repeat(level)} `, /^#{1,6}\s+/);
        break;
      }
      case "bold":
        wrapSelection("**", "**", "加粗文字");
        break;
      case "italic":
        wrapSelection("*", "*", "斜体文字");
        break;
      case "strike":
        wrapSelection("~~", "~~", "删除线文字");
        break;
      case "code":
        wrapSelection("`", "`", "行内代码");
        break;
      case "quote":
        toggleLinePrefix("> ", /^>\s?/);
        break;
      case "ul":
        toggleLinePrefix("- ", /^[-*+]\s+/);
        break;
      case "ol":
        toggleLinePrefix("1. ", /^\d+\.\s+/);
        break;
      case "task":
        toggleLinePrefix("- [ ] ", /^- \[[ xX]\]\s+/);
        break;
      case "link":
        wrapSelection("[", "](https://)", "链接文字");
        break;
      case "image":
        wrapSelection("![", "](<https://>)", "图片说明");
        break;
      case "table":
        insertText("\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n");
        break;
      case "hr":
        insertText("\n---\n");
        break;
      case "codeblock":
        wrapSelection("```\n", "\n```", "代码");
        break;
      default:
        break;
    }
    pushHistory(true);
    onStatus("正在输入…");
    emit();
  }

  function buildToolbar() {
    toolbar.textContent = "";
    for (const tool of EDITOR_TOOLS) {
      if (tool.action === "sep") {
        const sep = document.createElement("span");
        sep.className = "md-tool-sep";
        toolbar.append(sep);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "md-tool";
      button.textContent = tool.label;
      button.title = tool.title;
      button.dataset.action = tool.action;
      if (tool.strong) button.classList.add("is-strong");
      if (tool.italic) button.classList.add("is-italic");
      if (tool.strike) button.classList.add("is-strike");
      if (tool.action === "color") {
        button.classList.add("md-tool-color");
        button.textContent = "";
        const swatch = document.createElement("span");
        swatch.className = "md-tool-swatch";
        button.append(swatch);
        button.setAttribute("aria-label", "文字颜色 / 文字背景色");
      }
      button.addEventListener("mousedown", (e) => e.preventDefault()); // 别把焦点从正文抢走
      button.addEventListener("click", (event) => runTool(tool.action, button, event));
      toolbar.append(button);
    }
  }

  // ---------- 事件 ----------

  function onInput() {
    pushHistory(false);
    onStatus("正在输入…");
    emit();
  }

  function onKeyDown(e) {
    if (e.key === "Tab") {
      e.preventDefault();
      insertText("  ");
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    }
  }

  async function onPaste(e) {
    if (!enabled) return;
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    try {
      if (typeof saveImage !== "function") {
        onError("这里不能保存图片");
        return;
      }
      onStatus("正在保存图片…");
      const ext = (file.type.split("/")[1] || "png").toLowerCase().replace("jpeg", "jpg");
      const base64 = arrayBufferToBase64(await file.arrayBuffer());
      const rel = await saveImage(base64, ext);
      /* 粘贴即字面插入：图片直接落在光标处，落在哪一行就是哪一行，不补空行也不加换行。 */
      insertText(`![图片](<${rel}>)`);
      pushHistory(true);
      onStatus("图片已保存");
    } catch (err) {
      onError(`图片保存失败：${err}`);
    }
  }

  ta.addEventListener("input", onInput);
  ta.addEventListener("keydown", onKeyDown);
  ta.addEventListener("paste", onPaste);
  buildToolbar();

  return {
    setValue(value) {
      ta.value = String(value ?? "");
      resetHistory(ta.value);
    },
    getValue() {
      return ta.value;
    },
    setEnabled(next) {
      enabled = Boolean(next);
    },
    focus() {
      ta.focus({ preventScroll: true });
    },
    insertText,
    undo,
    redo,
    resetHistory,
    destroy() {
      ta.removeEventListener("input", onInput);
      ta.removeEventListener("keydown", onKeyDown);
      ta.removeEventListener("paste", onPaste);
      toolbar.textContent = "";
    },
  };
}
