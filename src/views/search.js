/* 全局搜索：一块面板搜三处东西。
 *
 *   1. 当前空间里的块 —— 正文、便签、笔记卡、文件名、连线标签，内存里现成的，改了立刻能搜到。
 *   2. 笔记库里的 .md —— 磁盘上的文件，第一次打开搜索时在后台读一遍，之后复用。
 *   3. 别的空间 —— 后端扫一遍所有空间的 items.json。这步慢一些，所以先出前两类，
 *      扫完再补进列表，不让用户盯着空白等。
 *
 * 结果点一下就跳过去：当前空间的块把镜头带过去并高亮一秒；笔记切到笔记页打开那篇；
 * 别的空间先切过去，再定位到那块。
 */

import * as store from "./canvas-store.js";

const DEBOUNCE = 90;
/* 本地和远程分开配份额：不然本地搜出几十条，别的空间永远挤不进来 */
const LOCAL_RESULTS = 30;
const REMOTE_RESULTS = 12;
const NOTE_LIMIT = 600;

const TYPE_LABEL = {
  text: "文字",
  sticky: "便签",
  note: "笔记卡",
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
  ebook: "电子书",
  connector: "连线",
  rect: "矩形",
  ellipse: "圆形",
  line: "直线",
  arrow: "箭头",
  picture: "画面",
  scene: "场景",
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

/* 命中处前后各截一段，前后断掉的地方补省略号 */
function snippetOf(text, query) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 90);
  const from = Math.max(0, at - 34);
  const to = Math.min(flat.length, at + query.length + 60);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}

function mark(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const at = safe.toLowerCase().indexOf(escapeHtml(query).toLowerCase());
  if (at < 0) return safe;
  const head = safe.slice(0, at);
  const hit = safe.slice(at, at + escapeHtml(query).length);
  return `${head}<mark>${hit}</mark>${safe.slice(at + hit.length)}`;
}

/* 一块的「名字」和「正文」分开算：名字命中的排前面，正文命中的给一段上下文 */
function describeBlock(item) {
  if (item.type === "text") return { title: item.text.split("\n")[0] || "文字", body: item.text };
  if (item.type === "sticky") return { title: (item.text || "").split("\n")[0] || "便签", body: item.text || "" };
  if (item.type === "note") return { title: item.name || "笔记卡", body: item.source || "" };
  if (item.type === "connector") return { title: item.label || "连线", body: item.label || "" };
  if (item.type === "image") return { title: "图片", body: "" };
  return { title: item.name || TYPE_LABEL[item.type] || item.type, body: item.name || "" };
}

export function initSearch({ getItems, getSpaceId, focusBlock, openNoteFile, jumpToSpace }) {
  const panel = document.querySelector("#canvas-search");
  const input = document.querySelector("#canvas-search-input");
  const list = document.querySelector("#canvas-search-results");
  const count = document.querySelector("#canvas-search-count");
  if (!panel || !input || !list) return { open() {}, close() {} };

  let timer = null;
  let results = [];
  let cursor = 0;
  let notesCache = null; // [{ rel, name, text }]
  let notesLoading = null;
  let opened = false;
  let remoteSeq = 0;
  let remotePending = false;

  function open() {
    panel.hidden = false;
    opened = true;
    remoteSeq += 1;
    remotePending = false;
    input.value = "";
    input.focus();
    renderResults([]);
    void ensureNotes();
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    opened = false;
    /* 关掉就把在途的远程搜索作废：它回来时不该再往列表里塞东西 */
    remoteSeq += 1;
    remotePending = false;
    input.blur();
    results = [];
    list.textContent = "";
    if (count) count.textContent = "";
  }

  const isOpen = () => !panel.hidden;

  /* 笔记库那部分：一棵树读成一张平表。读不动的单篇跳过，不影响别的结果。 */
  async function ensureNotes() {
    if (notesCache || notesLoading) return notesLoading;
    notesLoading = (async () => {
      try {
        const tree = await store.listNotes();
        const files = [];
        const walk = (nodes) => {
          for (const node of nodes || []) {
            if (node.kind === "dir") walk(node.children);
            else if (node.kind === "file" && files.length < NOTE_LIMIT) files.push(node);
          }
        };
        walk(tree);
        const collected = [];
        /* 一次读几篇，别把磁盘和界面都堵住 */
        const queue = [...files];
        const worker = async () => {
          while (queue.length) {
            const node = queue.shift();
            try {
              const text = await store.readNote(node.path);
              collected.push({ rel: node.path, name: node.name, text: String(text ?? "") });
            } catch {
              /* 读不了就跳过 */
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        notesCache = collected;
      } catch {
        notesCache = [];
      }
      if (opened) build(input.value);
      return notesCache;
    })();
    return notesLoading;
  }

  function searchBlocks(query) {
    const out = [];
    const needle = query.toLowerCase();
    for (const item of getItems()) {
      const { title, body } = describeBlock(item);
      const inTitle = title.toLowerCase().includes(needle);
      const inBody = body.toLowerCase().includes(needle);
      if (!inTitle && !inBody) continue;
      out.push({
        kind: "block",
        id: item.id,
        type: item.type,
        title: title.length > 70 ? `${title.slice(0, 70)}…` : title,
        text: snippetOf(inBody ? body : title, query),
        score: (inTitle ? 2 : 0) + (item.type === "text" ? 0.2 : 0),
      });
    }
    return out;
  }

  function searchNotes(query) {
    const needle = query.toLowerCase();
    const out = [];
    for (const note of notesCache || []) {
      const name = String(note.name || "").replace(/\.md$/i, "");
      const inName = name.toLowerCase().includes(needle);
      const inBody = note.text.toLowerCase().includes(needle);
      if (!inName && !inBody) continue;
      out.push({
        kind: "note",
        rel: note.rel,
        title: name,
        text: snippetOf(inBody ? note.text : note.rel, query),
        score: inName ? 1.6 : 0,
      });
    }
    return out;
  }

  function build(query) {
    const text = query.trim();
    if (!text) {
      renderResults([]);
      return;
    }
    const local = [...searchBlocks(text), ...searchNotes(text)].sort((a, b) => b.score - a.score);
    /* 本地的先上屏：块在内存里、笔记是快照，这一屏不该为了等磁盘而空着 */
    renderResults(local.slice(0, LOCAL_RESULTS), text);
    void searchOtherSpaces(text, local);
  }

  /* 别的空间放在后面扫。慢一步没关系，但不能把已经出来的本地结果顶掉 */
  async function searchOtherSpaces(text, local) {
    if (!jumpToSpace) return;
    const seq = ++remoteSeq;
    remotePending = true;
    let hits = [];
    try {
      hits = await store.searchSpace(text);
    } catch {
      hits = [];
    }
    /* 用户又敲了字，这一批已经过期了 */
    if (seq !== remoteSeq) return;
    remotePending = false;
    if (!isOpen() || input.value.trim() !== text) return;
    const here = getSpaceId?.();
    const remote = (hits || [])
      .filter((hit) => hit && hit.space !== here)
      .slice(0, REMOTE_RESULTS)
      .map((hit) => ({
        kind: "other",
        space: hit.space,
        spaceName: hit.space_name || hit.space,
        id: hit.item,
        title: hit.text || "",
        text: "",
        score: -1,
      }));
    renderResults([...local.slice(0, LOCAL_RESULTS), ...remote], text, { keepCursor: true });
  }

  function renderResults(found, query = "", options = {}) {
    /* 远程结果补进来时不要把用户已经挪动的选择拽回第一条 */
    results = found;
    cursor = options.keepCursor ? Math.min(cursor, Math.max(0, found.length - 1)) : 0;
    list.textContent = "";
    if (!found.length) {
      if (count) count.textContent = query ? "没有结果" : "";
      if (query) {
        const empty = document.createElement("p");
        empty.className = "canvas-search-empty";
        empty.textContent = notesCache
          ? remotePending
            ? "这个空间和笔记库里都没有（还在搜其它空间…）"
            : "这个空间、笔记库和别的空间里都没有"
          : "这个空间里没有（笔记库还在读…）";
        list.append(empty);
      }
      return;
    }
    if (count) count.textContent = `${found.length} 条`;
    found.forEach((entry, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "canvas-search-row";
      row.dataset.index = String(index);
      if (index === cursor) row.classList.add("is-active");
      const badge =
        entry.kind === "block"
          ? TYPE_LABEL[entry.type] || "块"
          : entry.kind === "note"
            ? "笔记"
            : String(entry.spaceName || "空间");
      row.innerHTML =
        `<span class="canvas-search-badge">${escapeHtml(badge.length > 10 ? `${badge.slice(0, 10)}…` : badge)}</span>` +
        `<span class="canvas-search-main"><span class="canvas-search-title">${mark(entry.title, query)}</span>` +
        (entry.text ? `<span class="canvas-search-text">${mark(entry.text, query)}</span>` : "") +
        `</span>`;
      row.addEventListener("click", () => activate(index));
      row.addEventListener("mousemove", () => setCursor(index));
      list.append(row);
    });
  }

  function setCursor(index) {
    if (!results.length) return;
    cursor = (index + results.length) % results.length;
    for (const row of list.querySelectorAll(".canvas-search-row")) {
      row.classList.toggle("is-active", Number(row.dataset.index) === cursor);
    }
    list.querySelector(".canvas-search-row.is-active")?.scrollIntoView({ block: "nearest" });
  }

  function activate(index) {
    const entry = results[index];
    if (!entry) return;
    close();
    if (entry.kind === "block") {
      focusBlock(entry.id);
    } else if (entry.kind === "other") {
      Promise.resolve(jumpToSpace?.(entry.space, entry.id)).catch((error) =>
        console.error(`跳到那个空间失败：${error}`),
      );
    } else {
      openNoteFile(entry.rel);
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => build(input.value), DEBOUNCE);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(cursor + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(cursor);
    }
  });

  /* 点面板外面收起。用捕获阶段，免得被块自己的按下处理抢走 */
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!isOpen() || panel.contains(event.target)) return;
      close();
    },
    true,
  );

  /* 换页了就别留着这个浮层：它挂在空间页里，跟着一起藏起来更干净 */
  window.addEventListener("inspace:route", () => close());

  document.addEventListener("keydown", (event) => {
    if (document.querySelector("#canvas-view")?.hidden) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
    event.preventDefault();
    if (isOpen()) {
      input.focus();
      input.select();
    } else {
      open();
    }
  });

  return { open, close };
}
