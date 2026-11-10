/* 全局搜索：一块面板搜两处东西。
 *
 *   1. 当前画布里的块 —— 正文、笔记卡、文件名、连线标签，内存里现成的，改了立刻能搜到。
 *   2. 别的画布 —— 后端扫一遍所有画布的 items.json。这步慢一些，所以先出前一类，
 *      扫完再补进列表，不让用户盯着空白等。
 *
 * 结果点一下就跳过去：当前画布的块把镜头带过去并高亮一秒；别的画布先切过去，再定位到那块。
 */

import * as store from "./canvas-store.js";
import { collectPictureImageSrcs } from "./canvas-items.js";

const fileNameOf = (path) => String(path || "").split(/[\\/]/).pop() || "";

const DEBOUNCE = 90;
/* 本地和远程分开配份额：不然本地搜出几十条，别的画布永远挤不进来 */
const LOCAL_RESULTS = 30;
const REMOTE_RESULTS = 12;

const TYPE_LABEL = {
  text: "文字",
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
  gen: "生图面板",
  product: "材料卡",
  quote: "清单",
  plan: "户型图",
  page: "提案页",
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

/* 一块的「名字」和「正文」分开算：名字命中的排前面，正文命中的给一段上下文。
   文件类面板把原文件名和磁盘上的文件名都塞进正文：用户记得的是导入时那个名字，
   而拷贝进画布后会改名，只搜路径是找不到的。 */
function describeBlock(item) {
  const name = item.name || "";
  const file = fileNameOf(item.src);
  if (item.type === "text") return { title: item.text.split("\n")[0] || "文字", body: item.text };
  if (item.type === "note") {
    return {
      title: name || "笔记卡",
      body: [item.source, fileNameOf(item.path)].filter(Boolean).join(" "),
    };
  }
  if (item.type === "connector") return { title: item.label || "连线", body: item.label || "" };
  if (item.type === "image") return { title: name || "图片", body: file };
  if (["audio", "video", "ebook", "file"].includes(item.type)) {
    return { title: name || TYPE_LABEL[item.type], body: [file, item.ext].filter(Boolean).join(" ") };
  }
  /* 面板能搜的就是那句提示词：出来的图还没变成文字 */
  if (item.type === "gen") {
    return { title: (item.prompt || "").split("\n")[0] || "生图面板", body: [item.prompt || "", file].join(" ") };
  }
  /* 材料卡：名字当标题，品牌/货号/规格/备注和模型文件名都进正文，搜「斯德哥尔摩」也能找到那张卡 */
  if (item.type === "product") {
    return {
      title: name || "材料卡",
      body: [item.brand, item.sku, item.spec, item.note, item.model].filter(Boolean).join(" "),
    };
  }
  if (item.type === "quote") return { title: item.title || "清单", body: item.title || "" };
  if (item.type === "plan") {
    const scale = item.calibration ? "已定标" : "未定标";
    return {
      title: "户型图",
      body: `${scale} · 家具 ${(item.footprints || []).length} 件 · 机位 ${(item.cameras || []).length} ${file}`,
    };
  }
  if (item.type === "page") {
    return { title: item.title || "提案页", body: `P${item.order || "?"} · ${item.ratio}` };
  }
  /* 画面里垫的位图、3D 场景里用的 GLB：搜文件名也要能找到这两类面板 */
  if (item.type === "picture") {
    const files = collectPictureImageSrcs(item.cmds, item.symbols).map((entry) => fileNameOf(entry.src)).filter(Boolean);
    return { title: name || "画面", body: [...new Set(files)].join(" ") };
  }
  if (item.type === "scene") {
    const models = (item.parts || []).filter((part) => part.op === "model").map((part) => fileNameOf(part.src));
    return { title: name || "场景", body: [...new Set(models)].filter(Boolean).join(" ") };
  }
  return { title: name || TYPE_LABEL[item.type] || item.type, body: name };
}

export function initSearch({ getItems, getSpaceId, focusBlock, jumpToSpace }) {
  const panel = document.querySelector("#canvas-search");
  const input = document.querySelector("#canvas-search-input");
  const list = document.querySelector("#canvas-search-results");
  const count = document.querySelector("#canvas-search-count");
  if (!panel || !input || !list) return { open() {}, close() {} };

  let timer = null;
  let results = [];
  let cursor = 0;
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

  function build(query) {
    const text = query.trim();
    if (!text) {
      renderResults([]);
      return;
    }
    /* #N 是「定位到 N 号面板」的实时指令：数字没敲完就只跳已经能对上的号，
       对不上就停在这儿显示没有；不走全文搜索，也别去别的画布找 */
    const seqMatch = /^#(\d+)$/.exec(text);
    if (seqMatch) {
      const wanted = Number(seqMatch[1]);
      const target = getItems().find((item) => item.type !== "connector" && item.seq === wanted);
      if (!target) {
        renderResults([], text, { emptyText: `这个画布里没有 #${wanted} 面板` });
        return;
      }
      const { title } = describeBlock(target);
      renderResults(
        [
          {
            kind: "block",
            id: target.id,
            type: target.type,
            title: `#${target.seq} · ${title.length > 60 ? `${title.slice(0, 60)}…` : title}`,
            text: "",
            score: 1,
          },
        ],
        text,
      );
      focusBlock(target.id);
      return;
    }
    const local = searchBlocks(text).sort((a, b) => b.score - a.score);
    /* 本地的先上屏：块在内存里，这一屏不该为了等磁盘而空着 */
    renderResults(local.slice(0, LOCAL_RESULTS), text);
    void searchOtherSpaces(text, local);
  }

  /* 别的画布放在后面扫。慢一步没关系，但不能把已经出来的本地结果顶掉 */
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
        empty.textContent =
          options.emptyText ||
          (remotePending ? "这个画布里没有（还在搜其它画布…）" : "这个画布和别的画布里都没有");
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
          : String(entry.spaceName || "画布");
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
    } else {
      Promise.resolve(jumpToSpace?.(entry.space, entry.id)).catch((error) =>
        console.error(`跳到那个画布失败：${error}`),
      );
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

  /* 换页了就别留着这个浮层：它挂在画布页里，跟着一起藏起来更干净 */
  window.addEventListener("inspace:route", () => close());

  document.addEventListener("keydown", (event) => {
    if (document.querySelector("#canvas-view")?.hidden) return;
    /* 设置弹层开着的时候，快捷键归设置页管，别在它背后开搜索 */
    if (window.__inspace?.route && window.__inspace.route !== "canvas") return;
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
