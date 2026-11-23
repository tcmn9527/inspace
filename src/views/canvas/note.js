/* 从 canvas.js 拆出：note */

import { NOTE_EDITOR_GUARDS, active, addItemElement, bytesToBase64, choiceDialog, commitEditing, confirmDialog, createMarkdownEditor, current, edgeLabelEditor, editingId, filePreviewCache, findItem, itemEls, modalOpen, noteAskId, noteEditor, noteImageCache, noteWriteBack, persistNote, previewKey, removeItemFromDom, renderAll, renderMarkdown, scheduleItemsSave, select, setEditingId, setModalOpen, setNoteAskId, setNoteEditor, setNoteWriteBack, setFileToggleMode, showError, store, updateSelection } from "../canvas.js";
import { isMarkdownExt, restoreReadProgress } from "../canvas-items/dom-files.js";
import { sanitizeInlineHtml } from "../inline-html.js";
import { holdCanvasTextSelection, releaseCanvasTextSelection } from "./editor-toolbar.js";
import { closeTextToolbar } from "./text-toolbar.js";

const { invoke } = window.__TAURI__.core;

/* ---------- 笔记块 ---------- */

/* 笔记块内联编辑器：工具栏、撤销重做、粘贴图片都走 markdown-editor 那一套。
 * 引用块默认只读——双击先问清楚「改源文件 / 转成画布副本 / 算了」，取消就一个字都不动。 */
export async function startNoteEdit(id) {
  if (editingId === id) {
    noteEditor?.editor.focus();
    return;
  }
  const item = findItem(id);
  if (!item || item.type !== "note") return;
  if (noteAskId === id) return;

  let writeBack = false;
  if (item.linked) {
    const canvasId = current.meta.id;
    setNoteAskId(id);
    let mode = null;
    try {
      mode = await choiceDialog({
        title: "请确认编辑对象",
        message: `「${item.name}」引用的是 ${item.path}。这次编辑要改哪一份？`,
        note: "改源文件会把正文直接写回那份 .md；复制进画布则把正文收进块里，原文件不动，之后随便改。",
        options: [
          { value: "write", label: "修改源文件", hint: "直接写回那份 Markdown" },
          { value: "copy", label: "复制进画布", hint: "原文件不动，之后随便改" },
        ],
      });
    } finally {
      setNoteAskId(null);
    }
    /* 弹层期间可能切了画布 / 关了页面，块早就不存在了 */
    if (!current || current.meta.id !== canvasId || !findItem(id)) return;
    if (!mode) return;
    if (mode === "copy") convertNoteToCopy(item);
    else writeBack = true;
  }

  if (editingId || edgeLabelEditor) commitEditing();
  const el = itemEls.get(id);
  if (!item || !el || item.type !== "note") return;

  setNoteWriteBack(writeBack);
  setEditingId(id);
  select(id);
  el.classList.add("is-editing");

  let state = noteEditor && noteEditor.el === el ? noteEditor : null;
  if (!state) {
    const canvasId = current.meta.id;
    const box = document.createElement("div");
    box.className = "canvas-note-editor";
    const toolbar = document.createElement("div");
    toolbar.className = "md-toolbar canvas-note-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Markdown 工具栏");
    const textarea = document.createElement("textarea");
    textarea.className = "md-textarea canvas-note-textarea";
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", "Markdown 源码");
    box.append(toolbar, textarea);
    el.querySelector(".canvas-note-card").append(box);

    const editor = createMarkdownEditor({
      textarea,
      toolbar,
      /* 引用块贴图会把画布目录下的相对路径写进用户原文件，那份 .md 挪个窝图就全断了。
         真要贴图就先转成画布副本，图片才跟着块走。 */
      saveImage: async (data, ext) => {
        if (findItem(item.id)?.linked) throw new Error("引用块请先选「复制进画布」再贴图");
        return store.saveCanvasNoteImage(canvasId, item.id, data, ext);
      },
      onChange: (value) => {
        const target = findItem(item.id);
        if (!target) return;
        target.source = value;
        persistNote(target);
      },
      onError: (message) => showError(message),
    });

    textarea.addEventListener("blur", () => scheduleNoteBlurCheck(item.id));
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commitEditing();
      }
    });

    const reading = el.querySelector(".canvas-note-body");
    reading?.addEventListener("pointerdown", onNoteLinkPointerDown);
    reading?.addEventListener("click", onNoteLinkClick);

    state = { itemId: item.id, el, box, textarea, editor };
    setNoteEditor(state);
  }

  state.itemId = item.id;
  state.editor.setValue(item.source);
  state.editor.setEnabled(true);
  const reading = el.querySelector(".canvas-note-body");
  if (reading) reading.hidden = true;
  state.box.hidden = false;
  state.editor.focus();
  updateSelection();
}

/* 失焦退出，但点工具栏 / 右键菜单 / 取色盘不算离开：那些操作本来就是编辑的一部分。 */
export function scheduleNoteBlurCheck(id) {
  setTimeout(() => {
    if (editingId !== id) return;
    const active = document.activeElement;
    if (active?.closest?.(NOTE_EDITOR_GUARDS)) return;
    if (document.querySelector(".color-pop")) return;
    const menu = document.getElementById("ctx-menu");
    if (menu && !menu.hidden) return;
    commitEditing();
  }, 0);
}

export function commitNoteEditing() {
  const state = noteEditor;
  const id = editingId;
  const writeBack = noteWriteBack;
  setEditingId(null);
  setNoteWriteBack(false);
  if (!state) return;
  const item = findItem(state.itemId);
  const el = itemEls.get(state.itemId);
  if (!item || !el || item.type !== "note" || state.itemId !== id) {
    setNoteEditor(null);
    updateSelection();
    return;
  }
  const draft = state.editor.getValue();
  const previous = item.source;
  item.source = draft;
  state.editor.setEnabled(false);
  state.box.hidden = true;
  const reading = el.querySelector(".canvas-note-body");
  if (reading) {
    reading.innerHTML = renderMarkdown(item.source);
    reading.hidden = false;
    hydrateNoteImages(item, el);
  }
  el.classList.remove("is-editing");
  updateSelection();
  persistNote(item);
  /* 选的是「修改源文件」才写盘；后端只认 items.json 里这块自己记着的那条路径 */
  if (writeBack && item.linked) {
    store.writeBackNote(current.meta.id, item.id, draft).catch((error) => {
      showError(error);
      /* 没写进去，界面上那份新正文就是假的：退回编辑前读到的那份，同时把稿子留在
         输入框里重新进入编辑，用户不至于白打一遍 */
      item.source = previous;
      renderNoteBody(item, el);
      if (noteEditor?.itemId === item.id && findItem(item.id)) {
        setEditingId(item.id);
        el.classList.add("is-editing");
        reading?.setAttribute("hidden", "");
        noteEditor.box.hidden = false;
        noteEditor.editor.setEnabled(true);
        noteEditor.editor.focus();
      }
    });
  }
}

export function renderNoteBody(item, el) {
  const body = el.querySelector(".canvas-note-body");
  if (!body) return;
  body.innerHTML = renderMarkdown(item.source);
  hydrateNoteImages(item, el);
}

/* 「复制进画布」：正文落到画布自己的 notes/<块id>.md，链接断掉，原 .md 一个字节都不动。
   图片另说——引用期间本来就禁止贴图，块里不会有指向画布目录的图片路径。 */
export function convertNoteToCopy(item) {
  item.linked = false;
  item.path = "";
  item.sourceFormat = "utf8";
  item.sourceCrlf = false;
  const el = itemEls.get(item.id);
  el?.querySelector(".canvas-note-badge")?.remove();
  persistNote(item);
}

/* ---------- 文本文件块的就地编辑 ----------
   整份读进来，点别处（失焦）就写回源文件，跟笔记块一个口径。
   覆盖的是用户自己磁盘上的文件，所以写盘前比一次改动基线：编辑期间被外部改过就问一句再动。 */
export let fileEditor = null; // { itemId, canvasId, item, el, box, preview, textarea, body, saving, closing, refreshed }
export let fileAskId = null;
/* 正在打开编辑框的块：读正文是异步的，连点两下会同时进来两次，
   第二次得挡掉，否则会往同一张卡里挂两个编辑容器 */
let fileOpening = null;

export function isFileEditable(item) {
  return item?.type === "file" && Boolean(item.text) && Boolean(item.src);
}

export async function startFileEdit(id) {
  if (!current || fileAskId === id || fileOpening === id) return;
  fileOpening = id;
  try {
    if (fileEditor && fileEditor.itemId !== id) {
      /* 一次只开一个编辑框：上一个没存下来就哪儿也不去 */
      if (!(await closeFileEdit())) return;
    }
    if (fileEditor?.itemId === id) {
      if (fileEditor.closing) return;
      fileEditor.textarea.focus({ preventScroll: true });
      return;
    }
    const item = findItem(id);
    if (!isFileEditable(item)) return;

    const canvasId = current.meta.id;
    /* 引用态才有「改哪一份」这一问：拷贝态那份副本就是唯一的一份，问它是假问题 */
    if (item.linked) {
      fileAskId = id;
      setModalOpen(true);
      let mode = null;
      try {
        mode = await choiceDialog({
          title: "请确认编辑对象",
          message: `「${item.name}」引用的是 ${item.src}。这次编辑要改哪一份？`,
          note: "改源文件会把整份正文写回那个文件；复制进画布则先把副本收进画布，原文件不动，之后随便改。",
          options: [
            { value: "write", label: "修改源文件", hint: "直接写回那份文本" },
            { value: "copy", label: "复制进画布", hint: "原文件不动，编辑画布里的副本" },
          ],
        });
      } finally {
        setModalOpen(false);
        fileAskId = null;
      }
      /* 弹层期间可能切了画布 / 关了页面，块早就不存在了 */
      if (!current || current.meta.id !== canvasId || !findItem(id)) return;
      if (!mode) return;
      if (mode === "copy" && !(await copyFileBlockIntoCanvas(findItem(id)))) return;
    }

    let body;
    try {
      body = await store.readFileBody(current.meta.id, id);
    } catch (error) {
      showError(error);
      return;
    }
    const el = itemEls.get(id);
    if (!current || !isFileEditable(findItem(id)) || !el) return;
    openFileEditor(id, el, body);
  } finally {
    if (fileOpening === id) fileOpening = null;
  }
}

/* 「复制进画布」：把副本收进 files/，块改指副本，原文件一个字节都不动。 */
export async function copyFileBlockIntoCanvas(item) {
  if (!item || !current) return false;
  const canvasId = current.meta.id;
  filePreviewCache.delete(previewKey(item));
  let stored;
  try {
    stored = await store.importCanvasFile(canvasId, item.src);
  } catch (error) {
    showError(error);
    return false;
  }
  if (!current || current.meta.id !== canvasId || !findItem(item.id)) return false;
  item.src = stored.rel;
  item.name = stored.name || item.name;
  item.ext = stored.ext || item.ext;
  item.size = Number(stored.size) || item.size;
  item.linked = false;
  scheduleItemsSave();
  refreshFileBlock(item);
  return true;
}

/* 记下最后一次按下的落点：编辑区一失焦就来不及问了，只能靠按下那一下判断
   「是不是点在卡片自己身上」。捕获阶段先记，免得被别处 stopPropagation 吃掉。 */
let lastDownTarget = null;
document.addEventListener(
  "pointerdown",
  (event) => {
    lastDownTarget = event.target;
  },
  true,
);

/* 进编辑态时把「读到哪儿」接上：滚动条回到上次的位置，光标落到当前视口的第一行。
   之前一进编辑就是 focus 到文首，读了几百行的地方瞬间回到第一行。 */
function editorLineHeight(el) {
  const style = getComputedStyle(el);
  return parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 16;
}

/* textarea 只按「行号」取行首：按比例估字符容易落进句子中间，
   接着打字就改到别处去了，宁可偏几行也不能偏进正文里 */
function textOffsetAtTop(textarea, top) {
  if (!(top > 0)) return 0;
  const lines = Math.floor(top / editorLineHeight(textarea));
  if (lines <= 0) return 0;
  const text = textarea.value;
  let offset = 0;
  for (let i = 0; i < lines; i += 1) {
    const at = text.indexOf("\n", offset);
    if (at < 0) return text.length;
    offset = at + 1;
  }
  return offset;
}

/* 富文本直接用坐标取视口顶部那个字的位置，比按行数估准 */
function caretAtTopOfView(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const range = document.caretRangeFromPoint?.(rect.left + 6, rect.top + 6);
  if (!range || !el.contains(range.startContainer)) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function restoreEditorPosition(el, state) {
  const frac = Number(state.item?.readFrac) || 0;
  if (!(frac > 0)) return;
  /* 内容和字号排好版之前量不到 scrollHeight，等两帧再放 */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const span = el.scrollHeight - el.clientHeight;
      if (span <= 4) return;
      const top = frac >= 0.999 ? span : Math.round(span * frac);
      el.scrollTop = top;
      if (el.isContentEditable) {
        caretAtTopOfView(el);
        return;
      }
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        const offset = textOffsetAtTop(el, top);
        el.setSelectionRange(offset, offset);
        /* 选完光标可能被浏览器带着滚一下，再压回去 */
        el.scrollTop = top;
      }
    });
  });
}

export function openFileEditor(id, el, body) {
  const item = findItem(id);
  const card = el.querySelector(".canvas-file-card");
  const preview = el.querySelector(".canvas-file-preview");
  if (!item || !card || !preview) return;
  /* 已经开着就别再加一层；卡片里有上次没清掉的编辑容器也先摘掉 */
  if (fileEditor?.itemId === id) return;
  card.querySelectorAll(".canvas-file-editor").forEach((node) => node.remove());
  const box = document.createElement("div");
  box.className = "canvas-file-editor";
  const textarea = document.createElement("textarea");
  textarea.className = "md-textarea canvas-file-textarea";
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "文件正文");
  textarea.value = body.text;
  box.append(textarea);
  const toggle = card.querySelector(".canvas-file-toggle");
  if (toggle) setFileToggleMode(toggle, true);
  if (body.encoding && body.encoding !== "UTF-8") {
    const tip = document.createElement("div");
    tip.className = "canvas-file-editor-tip";
    tip.textContent = `这份是 ${body.encoding} 编码，写回时按原样保留`;
    box.prepend(tip);
  }
  card.append(box);
  preview.hidden = true;
  el.classList.add("is-editing");

  const state = {
    itemId: id,
    canvasId: current.meta.id,
    item,
    el,
    box,
    preview,
    textarea,
    body,
    saving: false,
    closing: false,
    refreshed: false,
    markdown: false,
    rich: false,
    editorEl: null,
    toolbar: null,
    editor: null,
    /* 进来时的富文本基线：退出时只改了样式没改文字也要重建预览 */
    initialRichHtml: item.richHtml || "",
  };
  /* 编辑区两种形态：Markdown 是 textarea（源码），普通文本是 contentEditable（富文本）。
     写盘只认纯文本，所以统一从这里取：富文本取 innerText，Markdown 取 textarea.value。 */
  state.getText = () =>
    state.rich ? (state.editorEl?.innerText || "").replace(/\n$/, "") : state.textarea.value;
  state.focusEditor = () => (state.rich ? state.editorEl : state.textarea)?.focus({ preventScroll: true });
  fileEditor = state;

  if (isMarkdownExt(item.ext)) {
    /* Markdown 文件：编辑态跟笔记块一样，工具栏就长在面板里（贴在正文上方），
       不再浮到画布顶部。正文仍是本地文件，图片落到这块自己的 notes/<块id>/ 图床。 */
    state.markdown = true;
    const toolbar = document.createElement("div");
    toolbar.className = "md-toolbar canvas-note-toolbar canvas-file-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Markdown 工具栏");
    state.toolbar = toolbar;
    /* 头的名字/体积这时候没什么用，工具栏已经说明在改哪份；留着头会把正文挤掉一大截 */
    card.classList.add("is-md-edit");
    box.prepend(toolbar);
    state.editor = createMarkdownEditor({
      textarea,
      toolbar,
      saveImage: async (data, ext) => {
        if (!current || current.meta.id !== state.canvasId) throw new Error("画布已切换");
        return store.saveCanvasNoteImage(state.canvasId, state.itemId, data, ext);
      },
      onError: (message) => showError(message),
    });
    state.editor.setValue(body.text);
    state.editor.setEnabled(true);
  } else {
    /* 普通文本文件：编辑区做成富文本，选中文字能设字号/文字色/背景色。
       样式只存画布上的 item.richHtml，写盘仍写纯文本——用户的 .txt 一个字节都不动。 */
    state.rich = true;
    const editor = document.createElement("div");
    editor.className = "md-textarea canvas-file-textarea canvas-file-rich";
    editor.contentEditable = "true";
    editor.spellcheck = false;
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "文件正文");
    /* 有富文本样式就回显样式，否则回显磁盘读来的纯文本 */
    if (item.richHtml) editor.innerHTML = sanitizeInlineHtml(item.richHtml);
    else editor.textContent = body.text;
    textarea.replaceWith(editor);
    state.editorEl = editor;
    /* 编辑期放开画布文字选择：拖选移出面板才不会掉选区 */
    holdCanvasTextSelection();

    /* 样式变更即时落到 item（不落盘），另有一次 items 保存排队 */
    const syncRich = () => {
      const html = sanitizeInlineHtml(editor.innerHTML);
      if (html) item.richHtml = html;
      else delete item.richHtml;
      scheduleItemsSave();
    };
    editor.addEventListener("input", syncRich);
    /* 非 Markdown 的文本文件不再挂字号/文字色那条工具栏：只有 .md 走顶部 md-toolbar */

    /* 粘贴一律按纯文本塞，别把外部富文本/脚本带进编辑区 */
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") || "";
      if (text) document.execCommand("insertText", false, text);
    });
  }
  const editEl = state.editorEl || textarea;
  editEl.addEventListener("keydown", onFileEditorKeyDown);
  /* 点顶部工具栏 / 取色盘不算离开编辑，别把刚要用的工具给收了 */
  editEl.addEventListener("blur", () => {
    setTimeout(() => {
      if (fileEditor !== state) return;
      const active = document.activeElement;
      if (active?.closest?.(NOTE_EDITOR_GUARDS)) return;
      /* 点在卡片自己的壳上（标题行、边框、缩放手柄）：这次不算离开编辑。
         必须顺手把焦点还回正文——否则编辑区已经失焦，下一次点别处不再有 blur，
         编辑态就永远退不出去了。 */
      const down = lastDownTarget;
      lastDownTarget = null;
      if (down && state.el?.contains(down)) {
        state.focusEditor();
        return;
      }
      void closeFileEdit();
    }, 0);
  });
  /* 编辑时滚到哪儿也记一份：退出编辑回到浏览态，接着这儿看 */
  let readTimer = 0;
  editEl.addEventListener(
    "scroll",
    () => {
      if (readTimer) return;
      readTimer = window.setTimeout(() => {
        readTimer = 0;
        const span = editEl.scrollHeight - editEl.clientHeight;
        const frac = span > 4 ? Math.min(1, Math.max(0, editEl.scrollTop / span)) : 0;
        if (Math.abs((Number(item.readFrac) || 0) - frac) < 0.0005) return;
        item.readFrac = frac;
        scheduleItemsSave();
      }, 240);
    },
    { passive: true },
  );
  select(id);
  state.focusEditor();
  if (!state.rich) textarea.setSelectionRange(0, 0);
  /* 别一进编辑就把人读到的位置清掉：滚动条按块上记的比例放回原处，
     光标也挪到当前视口的第一行（而不是永远落在第一行） */
  restoreEditorPosition(editEl, state);
  updateSelection();
}

export function onFileEditorKeyDown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeFileEdit();
  } else if (e.key === "Tab" && fileEditor?.rich) {
    /* 富文本编辑区里 Tab 是缩进，不能让它跳去页面上别的控件 */
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  } else if (e.key === "Tab" && !fileEditor?.markdown) {
    e.preventDefault();
    e.target.setRangeText("  ", e.target.selectionStart, e.target.selectionEnd, "end");
  }
}

/* 换行符、末尾空行都不算改动：CRLF 文件读进来是 \r\n，编辑区里 innerText
   一律给 \n，不归一化的话「打开再关掉」每次都被判成改过，白写一遍整份文件
   （1.6MB 的书稿每开关一次就重写一次），末尾空行还会一点点被吃掉。 */
function textForCompare(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "");
}

/* 编辑区读完就把末尾的空行吞掉了，写回时按源文件结尾的换行补回来：
   否则每次编辑都少一行，改几次文件末尾就变样了。 */
function keepOriginalTail(text, source) {
  const tail = (String(source ?? "").match(/\n+$/) || [""])[0];
  return String(text ?? "").replace(/\n+$/, "") + tail;
}

export function fileDraftDirty(state) {
  return textForCompare(state.getText()) !== textForCompare(state.body.text);
}

const itemRichHtml = (item) => item?.richHtml || "";

export async function closeFileEdit() {
  const state = fileEditor;
  if (!state) return true;
  if (state.closing) return false;
  state.closing = true;
  if (fileDraftDirty(state) && !(await persistFileEdit(state))) {
    state.closing = false;
    if (fileEditor === state) state.focusEditor();
    return false;
  }
  if (fileEditor !== state) return false;
  fileEditor = null;
  closeFileEditorBox(state);
  /* 只改了字级样式、文字没动时不会写盘（state.refreshed 仍是 false），
     但预览卡还是进来前那张纯文本，必须重建才能看到新样式。 */
  const richChanged = state.rich && (itemRichHtml(state.item) !== state.initialRichHtml);
  if ((state.refreshed || richChanged) && findItem(state.itemId)) refreshFileBlock(findItem(state.itemId));
  else updateSelection();
  return true;
}

/* 切画布、关页面、重画整个画布、删块：编辑框跟着没了，稿子仍要落盘。
   这几处调用点后面都跟着把整块 DOM 换掉，所以只摘状态、不收尾，写盘在后台跑完。 */
export function flushFileEditor() {
  const state = fileEditor;
  if (!state) return;
  fileEditor = null;
  disposeFileToolbar(state);
  if (fileDraftDirty(state)) void persistFileEdit(state);
}

/* 工具栏现在长在面板里（和笔记块一样），收尾只要把内容销毁，DOM 跟着编辑框一起走 */
function disposeFileToolbar(state) {
  if (state.rich) releaseCanvasTextSelection();
  state.editor?.destroy();
  state.editor = null;
  if (state.rich) closeTextToolbar();
  state.toolbar = null;
}

export function closeFileEditorBox(state) {
  disposeFileToolbar(state);
  state.box.closest(".canvas-file-card")?.classList.remove("is-md-edit");
  state.box.remove();
  state.el.querySelectorAll(".canvas-file-editor").forEach((node) => node.remove());
  state.el.classList.remove("is-editing");
  state.preview.hidden = false;
  /* 编辑时可能滚到了别处：回浏览态接着那儿看，别退回进编辑前的位置 */
  restoreReadProgress(state.preview, state.item);
  const toggle = state.el.querySelector(".canvas-file-toggle");
  if (toggle) setFileToggleMode(toggle, false);
}

/* 写回源文件。返回 false 表示这次没写成（出错或用户选了不覆盖），调用方据此决定留不留编辑框。 */
export async function persistFileEdit(state) {
  if (state.saving) return false;
  /* 写盘的永远是纯文本：富文本模式取 innerText，样式只在 item.richHtml 里，不进文件。
     编辑区会把末尾空行吃掉，写回时按源文件原来的末尾换行补上，免得每改一次少一行 */
  const text = keepOriginalTail(state.getText(), state.body.text);
  state.saving = true;
  try {
    let result = await store.writeBackCanvasFile(state.canvasId, state.itemId, text, state.body, false);
    if (result?.conflict) {
      setModalOpen(true);
      const overwrite = await confirmDialog({
        title: "原文件已经变了",
        message: `「${state.item.name}」在你编辑期间被别的程序改过。要用画布里这份覆盖吗？`,
        okText: "覆盖",
        cancelText: "不覆盖",
        danger: true,
      });
      setModalOpen(false);
      if (!overwrite) return false;
      result = await store.writeBackCanvasFile(state.canvasId, state.itemId, text, state.body, true);
    }
    /* 磁盘上的样子已经变了：正文基线和 stamp 都换成刚写进去的这份，
       不然下一次保存会拿过期的 stamp 一路报「被外部改过」 */
    state.body = { ...state.body, text, stamp: result.stamp || "" };
    state.refreshed = true;
    filePreviewCache.delete(previewKey(state.item));
    /* 画布已经切走时不碰 items：那份 items 不再会落盘，改了只会让内存和盘上对不上 */
    if (current?.meta.id === state.canvasId) {
      state.item.size = Number(result.size) || state.item.size;
      scheduleItemsSave();
    }
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    state.saving = false;
  }
}

/* 预览是异步填的，改过盘就要把整块重做一遍，卡片上的体积和正文才跟得上 */
export function refreshFileBlock(item) {
  if (!itemEls.has(item.id)) return;
  removeItemFromDom(item.id);
  addItemElement(item);
  updateSelection();
}

/* 引用块的正文只是显示缓存，进画布时现读一次原文件，用户在外面改了也能看到。
 * 读不到就当原文件没了：块和最后一次读到的正文都留着，只把角标换成那句话，
 * 别把整个画布卡在这。返回这些读不到的块，renderAll 之后再改角标。 */
export async function refreshLinkedNotes() {
  if (!current) return [];
  const stale = [];
  let changed = false;
  await Promise.all(
    current.items
      .filter((item) => item.type === "note" && item.linked && item.path)
      .map(async (item) => {
        try {
          const file = await store.readFileText(item.path);
          item.source = file.text;
          item.sourceFormat = file.format || "utf8";
          item.sourceCrlf = Boolean(file.crlf);
          changed = true;
        } catch {
          stale.push(item);
        }
      }),
  );
  /* 写回时后端是从 items.json 里查这份编码/换行的，这里不落盘它就照着旧的那份还原 */
  if (changed) scheduleItemsSave();
  return stale;
}

export function onNoteLinkPointerDown(e) {
  if (e.target.closest?.("a[href]")) e.stopPropagation();
}

export async function onNoteLinkClick(e) {
  const anchor = e.target.closest?.("a[href]");
  if (!anchor) return;
  const url = anchor.getAttribute("href") || "";
  if (!/^(https?:|mailto:|tel:)/i.test(url)) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    await invoke("plugin:opener|open_url", { url });
  } catch {
    showError("打不开这个链接（系统浏览器调用失败）");
  }
}

/* ---------- 笔记图片副本 ---------- */

export function decodeRel(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function noteImageRel(item, raw) {
  if (item.assets && item.assets[raw]) return item.assets[raw];
  if (raw.startsWith(`notes/${item.id}/`)) return raw;
  return "";
}

export function replaceMissingNoteImage(img) {
  const missing = document.createElement("span");
  missing.className = "md-image-missing";
  missing.textContent = `[图片：${img.alt || "缺失"}]`;
  img.replaceWith(missing);
}

export async function hydrateNoteImages(item, el) {
  if (!current) return;
  const canvasId = current.meta.id;
  const images = [...el.querySelectorAll(".md-body img.md-local-img")];
  for (const img of images) {
    const raw = decodeRel(img.dataset.src || "");
    const rel = noteImageRel(item, raw);
    if (!rel) {
      replaceMissingNoteImage(img);
      continue;
    }
    try {
      let dataUrl = noteImageCache.get(rel);
      if (!dataUrl) {
        dataUrl = await store.readCanvasNoteImage(canvasId, item.id, rel);
        noteImageCache.set(rel, dataUrl);
      }
      if (!current || current.meta.id !== canvasId || !img.isConnected) return;
      img.src = dataUrl;
      img.classList.remove("md-local-img");
    } catch {
      if (img.isConnected) replaceMissingNoteImage(img);
    }
  }
}
