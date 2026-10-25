/* 笔记页：左边是本地 .md 文件树，右边是渲染后的 Markdown。
 *
 * - 笔记就是磁盘上的一个 .md 文件，树的结构就是文件夹结构；
 * - 笔记固定存在工作台数据文件夹的 notes/ 里，位置只在设置页换，这一页没有目录选择；
 * - 树空白处右键：新建笔记 / 新建文件夹 / 刷新；
 * - 文件/文件夹右键：重命名（就地改字，失焦保存）、删除（永久）；
 * - 文件和文件夹都能拖进别的文件夹，拖到空白处回笔记根；
 * - 阅读态只有一个「编辑」按钮，编辑态同名按钮变成「显示」；
 * - 编辑时边打字边自动保存（500ms 防抖），Ctrl+Z / Ctrl+Y 撤销重做；
 * - 粘贴的图片落到笔记同目录的隐藏文件夹 .assets/<笔记名>/ 里，删笔记时只删自己那份。 */

import { confirmDialog } from "./dialog.js";
import { createMarkdownEditor } from "./markdown-editor.js";
import { externalUrlFrom, renderMarkdown } from "./markdown.js";
import { openMenu } from "./menu.js";
import { startDrag } from "./splitter.js";

const { invoke } = window.__TAURI__.core;

const TREE_WIDTH_KEY = "workbench.notesTreeWidth";
const LAST_FILE_KEY = "workbench.notesLastFile";
const TREE_HIDDEN_KEY = "workbench.notesTreeHidden";
const SAVE_DEBOUNCE = 500;

const ui = {};
let rootPath = null;
let tree = [];
const expanded = new Set();
let currentPath = null;
let currentSource = "";
let editing = false;
let saveTimer = 0;
let saveChain = Promise.resolve();
let statusTimer = 0;
let errorTimer = 0;
let editor = null;

// ---------- 小工具 ----------

function showError(message) {
  ui.error.textContent = message;
  ui.error.hidden = !message;
  clearTimeout(errorTimer);
  if (message) {
    errorTimer = setTimeout(() => {
      ui.error.hidden = true;
    }, 6000);
  }
}

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("is-error", isError);
  clearTimeout(statusTimer);
  if (isError) return;
  statusTimer = setTimeout(() => {
    ui.status.textContent = "";
  }, 4000);
}

function timeLabel() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

function basename(path) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function stemOf(name) {
  return name.replace(/\.md$/i, "");
}

function findNode(path, nodes = tree) {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "dir") {
      const hit = findNode(path, node.children);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------- 初始化 ----------

export function initNotes() {
  ui.view = document.getElementById("notes-view");
  ui.tree = document.getElementById("notes-tree-scroll");
  ui.rootName = document.getElementById("notes-root-name");
  ui.rootReveal = document.getElementById("notes-root-reveal");
  ui.crumb = document.getElementById("notes-crumb");
  ui.body = document.getElementById("notes-body");
  ui.empty = document.getElementById("notes-empty");
  ui.editor = document.getElementById("notes-editor");
  ui.textarea = document.getElementById("notes-textarea");
  ui.toolbar = document.getElementById("notes-toolbar");
  ui.editBtn = document.getElementById("notes-edit");
  ui.guide = document.getElementById("notes-guide");
  ui.status = document.getElementById("notes-status-text");
  ui.guidePath = document.getElementById("notes-guide-path");
  ui.error = document.getElementById("notes-error");
  ui.emptyTree = document.getElementById("notes-tree-empty");
  ui.treeToggle = document.getElementById("notes-tree-toggle");

  ui.rootReveal.addEventListener("click", () => revealPath(""));
  ui.treeToggle.addEventListener("click", () => {
    applyTreeHidden(!ui.view.classList.contains("is-tree-hidden"));
  });
  ui.editBtn.addEventListener("click", toggleEdit);

  // 树空白处右键：新建 / 刷新
  ui.tree.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".tree-row")) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: "新建笔记", onClick: () => createNote("") },
      { label: "新建文件夹", onClick: () => createFolder("") },
      "-",
      { label: "刷新", onClick: () => reloadTree(true) },
      { label: "打开文件所在目录", onClick: () => revealPath("") },
    ]);
  });

  editor = createMarkdownEditor({
    textarea: ui.textarea,
    toolbar: ui.toolbar,
    saveImage: (data, ext) => invoke("notes_save_image", { noteRel: currentPath, data, ext }),
    onChange: (value) => {
      currentSource = value;
      scheduleSave();
    },
    onStatus: setStatus,
    onError: showError,
  });

  ui.body.addEventListener("click", async (e) => {
    const url = externalUrlFrom(e.target);
    if (!url) return;
    e.preventDefault();
    try {
      await invoke("plugin:opener|open_url", { url });
    } catch {
      showError("打不开这个链接（系统浏览器调用失败）");
    }
  });

  // 拖到树空白处 = 移到根目录
  ui.tree.addEventListener("dragover", (e) => {
    if (!e.target.closest(".tree-row")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      ui.tree.classList.add("is-drop-root");
    }
  });
  ui.tree.addEventListener("dragleave", (e) => {
    if (!ui.tree.contains(e.relatedTarget)) ui.tree.classList.remove("is-drop-root");
  });
  ui.tree.addEventListener("drop", async (e) => {
    if (e.target.closest(".tree-row")) return;
    e.preventDefault();
    ui.tree.classList.remove("is-drop-root");
    await moveNode(e.dataTransfer.getData("text/plain"), "");
  });

  restoreTreeWidth();
  initTreeSplitter();
  editor.setEnabled(false);
  showDocumentHint();
}

/* 隐藏/显示文件树；状态记在 localStorage，下次进来保持 */
function applyTreeHidden(hidden, persist = true) {
  ui.view.classList.toggle("is-tree-hidden", hidden);
  ui.treeToggle.setAttribute("aria-pressed", String(!hidden));
  ui.treeToggle.title = hidden ? "显示文件树" : "隐藏文件树";
  ui.treeToggle.setAttribute("aria-label", hidden ? "显示文件树" : "隐藏文件树");
  if (persist) {
    try {
      localStorage.setItem(TREE_HIDDEN_KEY, hidden ? "1" : "0");
    } catch {
      /* 存不了就只在本次运行生效 */
    }
  }
}

function restoreTreeWidth() {
  const saved = Number(localStorage.getItem(TREE_WIDTH_KEY));
  /* 不设上限：只要求不小于文件树的最小宽度，超出部分由 CSS 的
     max-width: calc(100% - 20px) 兜住，保证内容区至少还有 20px */
  if (Number.isFinite(saved) && saved >= 20) {
    document.documentElement.style.setProperty("--notes-tree-w", `${saved}px`);
  }
}

function initTreeSplitter() {
  const handle = document.getElementById("notes-split-v");
  const pane = document.getElementById("notes-tree");
  if (!handle || !pane) return;
  /* 只有两个下限：文件树 ≥ 20px、右边内容区 ≥ 20px；其它随便拖 */
  const MIN_TREE = 20;
  const MIN_MAIN = 20;
  startDrag(
    handle,
    (e) => ({ width: pane.offsetWidth, x: e.clientX }),
    (e, start) => {
      const available = pane.parentElement?.clientWidth || 0;
      const maxWidth = Math.max(MIN_TREE, available - MIN_MAIN);
      const width = Math.min(Math.max(start.width + (e.clientX - start.x), MIN_TREE), maxWidth);
      document.documentElement.style.setProperty("--notes-tree-w", `${Math.round(width)}px`);
    },
    () => {
      const width = pane.offsetWidth;
      if (width >= MIN_TREE) localStorage.setItem(TREE_WIDTH_KEY, String(Math.round(width)));
    },
  );
}

// ---------- 笔记目录 ----------

/* 笔记固定在工作台数据文件夹的 notes/ 下面，换位置去设置页，这里只显示、不选择。 */
function updateRootLabel() {
  ui.rootName.textContent = "笔记";
  ui.rootName.title = rootPath || "";
}

function showGuide(visible) {
  ui.guide.hidden = !visible;
  ui.view.classList.toggle("is-no-root", visible);
}

export async function refreshNotes() {
  try {
    rootPath = await invoke("notes_dir");
  } catch (err) {
    showGuide(true);
    ui.guidePath.textContent = String(err);
    showError(String(err));
    return;
  }
  showGuide(false);
  updateRootLabel();
  await reloadTree();
  if (currentPath && !findNode(currentPath)) closeDocument();
}

async function reloadTree(keepSelection = false) {
  try {
    tree = await invoke("notes_tree");
    showError("");
    showGuide(false);
    ui.guidePath.textContent = "";
  } catch (err) {
    tree = [];
    const message = String(err);
    showError(message);
    /* 数据文件夹被移走/改名：说清在哪儿打不开，而不是留一棵空树让人莫名其妙 */
    showGuide(true);
    ui.guidePath.textContent = `笔记目录打不开：${rootPath || ""}`;
  }
  renderTree();
  if (!keepSelection && currentPath && !findNode(currentPath)) closeDocument();
}

// ---------- 文件树 ----------

function renderTree() {
  ui.tree.textContent = "";
  for (const node of tree) renderNode(node, 0);
  ui.emptyTree.hidden = tree.length > 0 || !rootPath;
}

function renderNode(node, depth) {
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.path = node.path;
  row.dataset.kind = node.kind;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.draggable = true;
  if (node.kind === "dir") row.classList.add("is-dir");
  if (node.kind === "file" && node.path === currentPath) row.classList.add("is-active");

  const marker = document.createElement("span");
  if (node.kind === "dir") {
    marker.className = "tree-caret";
    marker.textContent = expanded.has(node.path) ? "▾" : "▸";
  } else {
    marker.className = "tree-dot";
  }
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = node.kind === "file" ? stemOf(node.name) : node.name;
  name.title = node.name;
  row.append(marker, name);

  row.addEventListener("click", () => {
    if (row.classList.contains("is-renaming")) return;
    if (node.kind === "dir") toggleDir(node.path);
    else openFile(node.path);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openNodeMenu(node, row, e.clientX, e.clientY);
  });

  row.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
    row.classList.add("is-dragging");
  });
  row.addEventListener("dragend", () => row.classList.remove("is-dragging"));

  if (node.kind === "dir") {
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("is-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-drop"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("is-drop");
      await moveNode(e.dataTransfer.getData("text/plain"), node.path);
    });
  }

  ui.tree.append(row);

  if (node.kind === "dir" && expanded.has(node.path)) {
    for (const child of node.children) renderNode(child, depth + 1);
  }
}

function toggleDir(path) {
  if (expanded.has(path)) expanded.delete(path);
  else expanded.add(path);
  renderTree();
}

function openNodeMenu(node, row, x, y) {
  const items = [];
  if (node.kind === "dir") {
    items.push(
      { label: "新建笔记", onClick: () => createNote(node.path) },
      { label: "新建文件夹", onClick: () => createFolder(node.path) },
      "-",
      { label: "重命名", onClick: () => startRename(node, row) },
      { label: "打开文件所在目录", onClick: () => revealPath(node.path) },
      "-",
      { label: "删除", danger: true, onClick: () => deleteNode(node) },
    );
  } else {
    items.push(
      { label: "重命名", onClick: () => startRename(node, row) },
      { label: "打开文件所在目录", onClick: () => revealPath(node.path) },
      "-",
      { label: "删除", danger: true, onClick: () => deleteNode(node) },
    );
  }
  openMenu(x, y, items);
}

/* 在资源管理器里定位；空路径表示根目录 */
async function revealPath(rel) {
  try {
    await invoke("notes_reveal", { rel });
  } catch (err) {
    showError(String(err));
  }
}

// ---------- 就地重命名 ----------

/* 不弹框：把树上的名字直接变成可编辑文本，失焦即保存，Esc 放弃 */
function startRename(node, row) {
  if (!row || row.classList.contains("is-renaming")) return;
  const nameEl = row.querySelector(".tree-name");
  if (!nameEl) return;
  const original = node.kind === "file" ? stemOf(node.name) : node.name;

  row.classList.add("is-renaming");
  row.draggable = false;
  nameEl.dataset.prev = nameEl.textContent;
  nameEl.textContent = original;
  nameEl.contentEditable = "plaintext-only";
  if (nameEl.contentEditable !== "plaintext-only") nameEl.contentEditable = "true";
  nameEl.classList.add("is-editing");
  nameEl.focus({ preventScroll: true });

  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  let finished = false;
  const stop = () => {
    nameEl.removeAttribute("contenteditable");
    nameEl.classList.remove("is-editing");
    row.classList.remove("is-renaming");
    row.draggable = true;
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    stop();
    nameEl.textContent = nameEl.dataset.prev;
  };
  const commit = async () => {
    if (finished) return;
    finished = true;
    const next = nameEl.textContent.replace(/\s+/g, " ").trim();
    stop();
    if (!next || next === original) {
      nameEl.textContent = nameEl.dataset.prev;
      return;
    }
    try {
      const renamed = await invoke("notes_rename", { rel: node.path, name: next });
      if (currentPath === node.path) {
        currentPath = renamed;
        updateCrumb();
      }
      await reloadTree(true);
    } catch (err) {
      nameEl.textContent = nameEl.dataset.prev;
      showError(String(err));
    }
  };

  nameEl.addEventListener("blur", commit, { once: true });
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameEl.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
    e.stopPropagation();
  });
  nameEl.addEventListener("click", (e) => e.stopPropagation());
  nameEl.addEventListener("mousedown", (e) => e.stopPropagation());
}

// ---------- 新建 / 删除 / 移动 ----------

async function createNote(parent) {
  try {
    const rel = await invoke("notes_create", { parent, name: "新笔记" });
    if (parent) expanded.add(parent);
    await reloadTree(true);
    await openFile(rel);
    enterEdit();
  } catch (err) {
    showError(String(err));
  }
}

async function createFolder(parent) {
  /* 不弹框：直接建一个默认名字的文件夹，需要改名右键「重命名」就地改 */
  try {
    await invoke("notes_create_dir", { parent, name: "新建文件夹" });
    if (parent) expanded.add(parent);
    await reloadTree(true);
    setStatus("已新建文件夹");
  } catch (err) {
    showError(String(err));
  }
}

async function deleteNode(node) {
  const isFile = node.kind === "file";
  const ok = await confirmDialog({
    title: isFile ? "删除笔记" : "删除文件夹",
    message: isFile
      ? `「${stemOf(node.name)}」会被永久删除（含它粘贴的图片），无法恢复。`
      : `文件夹「${node.name}」和里面所有内容都会被永久删除，无法恢复。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke("notes_delete", { rel: node.path });
    if (currentPath === node.path || currentPath?.startsWith(`${node.path}/`)) closeDocument();
    setStatus("已删除");
    await reloadTree(true);
  } catch (err) {
    showError(String(err));
  }
}

async function moveNode(source, targetDir) {
  if (!source) return;
  if (targetDir && (source === targetDir || targetDir.startsWith(`${source}/`))) {
    showError("不能把文件夹移动到它自己里面");
    return;
  }
  try {
    const next = await invoke("notes_move", { rel: source, targetDir });
    if (currentPath === source) {
      currentPath = next;
      updateCrumb();
    }
    if (expanded.has(source)) {
      expanded.delete(source);
      expanded.add(next);
    }
    if (targetDir) expanded.add(targetDir);
    setStatus(`已移动到「${targetDir ? basename(targetDir) : "笔记"}」`);
    await reloadTree(true);
  } catch (err) {
    showError(String(err));
  }
}

// ---------- 文档阅读 ----------

async function openFile(path) {
  if (editing) await flushSave();
  try {
    const content = await invoke("notes_read", { rel: path });
    currentPath = path;
    currentSource = content;
    localStorage.setItem(LAST_FILE_KEY, path);
    renderDocument();
  } catch (err) {
    showError(String(err));
  }
}

function updateCrumb() {
  ui.crumb.textContent = currentPath ? currentPath.replace(/\.md$/i, "") : "";
  ui.crumb.title = currentPath || "";
}

function renderDocument() {
  editing = false;
  ui.editor.hidden = true;
  ui.body.hidden = false;
  ui.empty.hidden = true;
  ui.editBtn.disabled = false;
  setEditButton(false);
  updateCrumb();
  ui.body.innerHTML = renderMarkdown(currentSource);
  hydrateLocalImages();
  editor.setEnabled(false);
  editor.setValue(currentSource);
  markActiveRow();
}

/* 正文里的本地图片（相对笔记的路径）读成 data URL 再塞进 <img> */
async function hydrateLocalImages() {
  const images = [...ui.body.querySelectorAll("img.md-local-img")];
  for (const img of images) {
    const raw = img.dataset.src || "";
    if (!raw) continue;
    let rel = raw;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      /* 已经是原始路径，直接用 */
    }
    try {
      const dataUrl = await invoke("notes_read_image", { noteRel: currentPath, rel });
      img.src = dataUrl;
      img.classList.remove("md-local-img");
    } catch {
      const missing = document.createElement("span");
      missing.className = "md-image-missing";
      missing.textContent = `[图片：${img.alt || rel}]`;
      img.replaceWith(missing);
    }
  }
}

function showDocumentHint() {
  if (currentPath) return;
  ui.body.hidden = true;
  ui.editor.hidden = true;
  ui.empty.hidden = false;
  ui.editBtn.disabled = true;
  setEditButton(false);
  updateCrumb();
}

function closeDocument() {
  currentPath = null;
  currentSource = "";
  editing = false;
  ui.editor.hidden = true;
  ui.empty.hidden = rootPath ? false : true;
  ui.body.hidden = true;
  ui.crumb.textContent = "";
  ui.editBtn.disabled = true;
  setEditButton(false);
  markActiveRow();
}

function markActiveRow() {
  for (const row of ui.tree.querySelectorAll(".tree-row")) {
    row.classList.toggle("is-active", row.dataset.kind === "file" && row.dataset.path === currentPath);
  }
}

// ---------- 编辑 ----------

/* 右上角按钮：阅读态是铅笔（点它进入编辑），编辑态是眼睛（点它回到阅读） */
function setEditButton(isEditing) {
  ui.editBtn.classList.toggle("is-editing", isEditing);
  const label = isEditing ? "显示" : "编辑";
  ui.editBtn.title = label;
  ui.editBtn.setAttribute("aria-label", label);
}

function toggleEdit() {
  if (!currentPath) return;
  if (editing) exitEdit();
  else enterEdit();
}

function enterEdit() {
  editing = true;
  ui.empty.hidden = true;
  ui.body.hidden = true;
  ui.editor.hidden = false;
  setEditButton(true);
  editor.setValue(currentSource);
  editor.setEnabled(true);
  editor.focus();
  setStatus("边打字边自动保存");
}

async function exitEdit() {
  clearTimeout(saveTimer);
  await flushSave();
  editor.setEnabled(false);
  renderDocument();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => queueSave(), SAVE_DEBOUNCE);
}

function queueSave() {
  if (!currentPath) return Promise.resolve();
  const path = currentPath;
  const text = currentSource;
  saveChain = saveChain.then(async () => {
    try {
      await invoke("notes_write", { rel: path, content: text });
      if (path === currentPath) setStatus(`已保存 ${timeLabel()}`);
    } catch (err) {
      if (path === currentPath) setStatus(`保存失败：${err}`, true);
    }
  });
  return saveChain;
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!currentPath) return;
  await queueSave();
}

/* 供以后从首页跳转复用 */
export function openNote(path) {
  if (path) openFile(path);
}
