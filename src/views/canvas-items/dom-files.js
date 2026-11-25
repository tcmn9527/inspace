/* canvas-items/dom-files.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { FILE_DOC_SVG, PREVIEW_RENDER_CHARS, TABLE_EXTS, chevronSvg } from "./dom-elements.js";
import { hydrateNoteImages, scheduleItemsSave } from "../canvas.js";
import { setScrollKey, markScrollSilent, watchScrollRegion, restoreScrollMemory } from "./scroll-memory.js";
import { renderMarkdown } from "../markdown.js";
import { sanitizeInlineHtml } from "../inline-html.js";
import { createDelimitedTable, formatSize } from "./dom-media.js";
import { holdPdf, isCancelled, openPdf, pdfPageSize, pdfProblem, releasePdf, renderPdfPage } from "../canvas-pdf.js";

/* ---------- 文本预览的阅读进度 ----------
   读到哪儿按「滚过的比例」记在块上（item.readFrac），跟块一起落盘、复制也带走。
   每次打开（含切回浏览态、重开画布）都滚回上次的位置；只在滚动停下时记一次，
   不在滚动过程中反复排队存盘。 */
const READ_SAVE_DELAY = 240;

function readSpanOf(body) {
  return body.scrollHeight - body.clientHeight;
}

function attachReadProgress(body, item) {
  let timer = 0;
  body.addEventListener(
    "scroll",
    () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        const span = readSpanOf(body);
        const frac = span > 4 ? Math.min(1, Math.max(0, body.scrollTop / span)) : 0;
        if (Math.abs((Number(item.readFrac) || 0) - frac) < 0.0005) return;
        item.readFrac = frac;
        scheduleItemsSave();
      }, READ_SAVE_DELAY);
    },
    { passive: true },
  );
}

/* 内容刚塞进 DOM 时还量不到 scrollHeight：等两帧排版完再滚。
   滚到接近底部就直接到底，别因为比例取整差一两像素停在那儿。 */
export function restoreReadProgress(body, item) {
  const frac = Number(item.readFrac) || 0;
  if (frac <= 0) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const span = readSpanOf(body);
      if (span <= 4) return;
      const top = span * frac;
      body.scrollTop = top >= span - 2 ? span : Math.round(top);
    });
  });
}

/* 重的正文（PDF / Office）等真进视野再建：785 张卡一起 openPdf，光解析出来的文档、
   页位图和工作表 DOM 就能吃掉几个 G。没进视野的只挂一块骨架，进视野时由
   refreshCulling 调 __mountBody 把正文换进来（导出时 withAllVisible 会全量挂）。
   离开视野两屏以上再调 __unmountBody 把正文丢掉：一页 761×1077 的位图就是 3MB，
   几百张看过的卡攒下来照样是大头。 */
export function mountWhenVisible(card, build, release) {
  const wait = document.createElement("div");
  wait.className = "canvas-file-wait";
  card.append(wait);
  let body = null;
  card.__isMounted = () => Boolean(body);
  card.__mountBody = () => {
    if (body) return false;
    body = build();
    if (wait.isConnected) wait.replaceWith(body);
    else card.append(body);
    /* 正文是懒挂的：建块的时候它还不存在，滚动位置也就没地方放。
       正文刚挂上来这一刻补一次，位置才能跟着块一起活过来 */
    restoreScrollMemory(card);
    return true;
  };
  card.__unmountBody = () => {
    if (!body) return false;
    body.remove();
    body = null;
    if (!wait.isConnected) card.append(wait);
    /* 丢掉模块里的缓存项，让 pdf.js 那份文档跟着正文一起被回收 */
    try {
      release?.();
    } catch {
      /* 释放失败不影响卸载本身 */
    }
    return true;
  };
  return card;
}

export function createFileCard(item, options) {
  const card = document.createElement("div");
  card.className = item.text ? "canvas-file-card canvas-file-card-text" : "canvas-file-card";

  const icon = document.createElement("div");
  icon.className = "canvas-file-badge";
  icon.innerHTML = FILE_DOC_SVG;

  const main = document.createElement("div");
  main.className = "canvas-file-main";
  const name = document.createElement("div");
  name.className = "canvas-file-name";
  name.textContent = item.name || "未命名文件";
  const sub = document.createElement("div");
  sub.className = "canvas-file-sub";
  sub.textContent = `${formatSize(item.size)}${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}`;
  main.append(name, sub);

  const head = document.createElement("div");
  head.className = "canvas-file-head";
  head.append(icon, main);
  /* 右上角不再放「编辑 / 浏览」开关：进编辑走双击，退出走 Esc 或点别处 */
  card.append(head);

  /* 不管拷贝还是引用，进画布都问一句文件还在不在；
     丢了就整块换成统一那张丢文件卡，绝对路径写在卡上 */
  options.checkFile?.(item).then((found) => {
    if (!found) options.onMissing?.(item);
  });

  /* 四类重正文都走「进视野才建」：解析成本高、还要长期占内存 */
  const heavyClass = isPdfExt(item.ext)
    ? "canvas-file-card-pdf"
    : isDocxExt(item.ext)
      ? "canvas-file-card-docx"
      : isXlsxExt(item.ext)
        ? "canvas-file-card-xlsx"
        : isPptxExt(item.ext)
          ? "canvas-file-card-pptx"
          : "";
  if (heavyClass) {
    card.classList.add(heavyClass);
    mountWhenVisible(
      card,
      () =>
        heavyClass === "canvas-file-card-pdf"
          ? createPdfBody(item, options)
          : heavyClass === "canvas-file-card-docx"
            ? createDocxBody(item, options)
            : heavyClass === "canvas-file-card-xlsx"
              ? createXlsxBody(item, options)
              : createPptxBody(item, options),
      /* 卸载时把这份 PDF 从 openPdf 的缓存里摘掉：正文一丢，文档就没人引用了 */
      heavyClass === "canvas-file-card-pdf"
        ? async () => {
            const url = await options.loadPdfUrl?.(item);
            if (url) releasePdf(url);
          }
        : null,
    );
    return card;
  }

  if (!item.text) return card;

  const body = document.createElement("div");
  body.className = "canvas-file-preview";
  card.append(body);
  attachPlainCopy(body);
  attachReadProgress(body, item);
  fillFilePreview(card, body, sub, item, options);
  return card;
}

/* 文件卡右上角的编辑/浏览开关：铅笔进编辑、眼睛回浏览，图标按钮不放文字 */
const FILE_EDIT_ICON =
  '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">' +
  '<path d="M12.6 3.6l3.8 3.8L7.2 16.6l-4.6.7.7-4.6z" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linejoin="round"/></svg>';
const FILE_BROWSE_ICON =
  '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">' +
  '<path d="M2.2 10C4 6.8 6.8 5 10 5s6 1.8 7.8 5c-1.8 3.2-4.6 5-7.8 5s-6-1.8-7.8-5z" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

export function setFileToggleMode(toggle, editing) {
  toggle.innerHTML = editing ? FILE_BROWSE_ICON : FILE_EDIT_ICON;
  toggle.title = editing ? "浏览" : "编辑";
  toggle.setAttribute("aria-label", editing ? "浏览" : "编辑");
}

/* Markdown 的两个扩展名（.md / .markdown）：浏览态渲染排版、卡片头带编辑开关 */
export function isMarkdownExt(ext) {
  const name = String(ext || "").toLowerCase();
  return name === "md" || name === "markdown";
}

/* 画布那边也靠这个决定给不给缩放手柄，所以是导出的 */
export function isPdfExt(ext) {
  return String(ext || "").toLowerCase() === "pdf";
}

/* 和 isPdfExt 一个套路，画布那边也靠它决定给不给缩放手柄 */
export function isDocxExt(ext) {
  return String(ext || "").toLowerCase() === "docx";
}

/* 同上：XLSX 块也靠它决定给不给缩放手柄 */
export function isXlsxExt(ext) {
  return String(ext || "").toLowerCase() === "xlsx";
}

/* PPTX 块：跟 docx/xlsx 一样的只读预览家族，靠它决定给不给缩放手柄 */
export function isPptxExt(ext) {
  return String(ext || "").toLowerCase() === "pptx";
}

/* PDF 块是一条纵向页链：滚轮一路往下就能读过整本，不用一下下点翻页。
   一块只把视窗附近那几页真画成位图，其余靠算出来的页高撑住滚动条——
   几百页全画出来内存先炸，什么都不画又没了位置感。
   底部一行照旧留着：跳整页比滚过去快，页码跟着视窗走。
   要在块里看小字就在块上拖角把宽度拉大，页链会按新宽度重排重画。 */

export const PDF_PAGE_GAP = 10;      /* 页与页之间留条缝，滚的时候看得出换了页 */
export const PDF_OVERSCAN = 1;       /* 视窗上下各多备一屏，滚到头不至于先看见空白 */
export const PDF_MAX_PAGES = 8;      /* 同时挂着几页位图：2x 屏上一张 A4 就是几 MB，够眼前用了 */
export const PDF_MEASURE_CHUNK = 12; /* 后台核对页高攒几页排一次版，别问一页重排一次 */

export function createPdfBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-pdf";

  const stage = document.createElement("div");
  stage.className = "canvas-file-pdf-stage";
  const track = document.createElement("div");
  track.className = "canvas-file-pdf-track";
  stage.append(track);

  const bar = document.createElement("div");
  bar.className = "canvas-file-pdf-bar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "canvas-file-pdf-step";
  prev.append(chevronSvg("M10 4 6 8l4 4"));
  prev.title = "上一页";
  prev.setAttribute("aria-label", "上一页");
  const pos = document.createElement("span");
  pos.className = "canvas-file-pdf-pos";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "canvas-file-pdf-step";
  next.append(chevronSvg("M6 4l4 4-4 4"));
  next.title = "下一页";
  next.setAttribute("aria-label", "下一页");
  bar.append(prev, pos, next);

  const state = document.createElement("div");
  state.className = "canvas-file-pdf-state";
  state.hidden = true;

  wrap.append(stage, bar, state);
  for (const control of [prev, next]) stopOnCard(control);

  /* 页号 -> 此刻真挂在页链里的那一格（painted 才是已经画到位图上的） */
  const live = new Map();
  let dims = [];    /* 页号 -> 宽高，只用比值：渲染过的记 CSS 像素，后台核对的记 PDF 点 */
  let tops = [];    /* 页号 -> 这一页在页链里的起点 */
  let heights = [];
  let guess = null; /* 还没问到的页先按它撑，几百页不必一上来就问完 */
  let chain = 0;
  let url = "";
  let total = 0;
  let width = 0;
  /* 卡片被换掉（丢文件、复制进画布、重画整张）后旧回调不能再碰 DOM，作废看 seq；
     宽度又变了一轮，画到一半那一张也不认了，作废看 gen */
  let seq = 0;
  let gen = 0;
  let queue = [];
  let busy = null;
  /* 卡片还没进文档时量到的宽是 0，这一轮的活儿只能等 ResizeObserver 接手，
     但记忆里那个位置得先存着，不然接手时人已经被放到第一页了 */
  let pendingAnchor = null;

  const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
  const dimOf = (at) => dims[at] || guess;

  function chrome(at) {
    pos.textContent = total ? `${at} / ${total}` : "";
    prev.disabled = at <= 1;
    next.disabled = at >= total;
  }

  /* 读一份几十 MB 的书要半秒左右，这段时间在页下面留一行小字；第一页画出来就收掉 */
  function note(text) {
    state.hidden = !text;
    state.textContent = text;
  }

  function fail(text) {
    seq += 1;
    stage.hidden = true;
    bar.hidden = true;
    state.hidden = false;
    state.textContent = text;
  }

  function layout() {
    let y = 0;
    for (let at = 1; at <= total; at += 1) {
      const d = dimOf(at);
      const h = d && width ? Math.max(1, Math.round((d.height * width) / d.width)) : 0;
      tops[at] = y;
      heights[at] = h;
      const box = live.get(at);
      if (box) {
        box.el.style.top = `${y}px`;
        box.el.style.width = `${width}px`;
        box.el.style.height = `${h}px`;
        /* 位图是按旧宽度画的，先拉成新格子的大小顶一下，标脏排队重画 */
        if (box.renderedWidth !== width) {
          box.canvas.style.width = `${width}px`;
          box.canvas.style.height = `${h}px`;
          box.painted = false;
        }
      }
      y += h + PDF_PAGE_GAP;
    }
    chain = Math.max(0, y - PDF_PAGE_GAP);
    track.style.height = `${chain}px`;
  }

  function pageAt(y) {
    let lo = 1;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(Math.max(1, lo), total);
  }

  /* 位置记成「第几页 + 这页滚过去几成」：宽度再拉也没事，落回来还在同一行附近 */
  function anchor() {
    const at = pageAt(stage.scrollTop);
    return { page: at, frac: clamp01((stage.scrollTop - tops[at]) / (heights[at] || 1)) };
  }

  function restore(at, frac) {
    const y = (tops[at] || 0) + clamp01(frac) * (heights[at] || 0);
    stage.scrollTop = Math.max(0, Math.min(chain, y));
  }

  /* 页高补齐了：把它上面那些页多出来、少掉的那截补给滚动位置，
     眼前的字就不会被人推走——不补的话每核对一页，正文就往上蹿一截 */
  function relayout() {
    const at = anchor().page;
    const before = tops[at] || 0;
    layout();
    const delta = (tops[at] || 0) - before;
    if (delta) stage.scrollTop = Math.max(0, stage.scrollTop + delta);
  }

  /* 宽度是页链唯一的排版依据：变了就整个重排，画到一半的那张直接掐掉 */
  function applyWidth(next) {
    const a = pendingAnchor || anchor();
    pendingAnchor = null;
    width = next;
    gen += 1;
    if (busy) busy.slot.task?.cancel();
    layout();
    restore(a.page, a.frac);
    chrome(anchor().page);
    syncWindow();
  }

  function addSlot(at) {
    const el = document.createElement("div");
    el.className = "canvas-file-pdf-slot";
    el.style.top = `${tops[at]}px`;
    el.style.width = `${width}px`;
    el.style.height = `${heights[at]}px`;
    const canvas = document.createElement("canvas");
    canvas.className = "canvas-file-pdf-page";
    canvas.setAttribute("aria-label", `PDF 第 ${at} 页`);
    el.append(canvas);
    track.append(el);
    live.set(at, { el, canvas, painted: false, renderedWidth: 0 });
  }

  /* 只留离当前页最近的那几页：出界的连格子一起撤，浏览器才收得回那张位图 */
  function syncWindow() {
    if (!total || !width || stage.hidden) return;
    const near = anchor().page;
    const from = pageAt(Math.max(0, stage.scrollTop - stage.clientHeight * PDF_OVERSCAN));
    const to = pageAt(Math.min(chain, stage.scrollTop + stage.clientHeight * (1 + PDF_OVERSCAN)));
    const inWindow = [];
    for (let at = from; at <= to; at += 1) inWindow.push(at);
    inWindow.sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
    const keep = new Set(inWindow.slice(0, PDF_MAX_PAGES));
    for (const at of [...live.keys()]) {
      if (keep.has(at)) continue;
      live.get(at).el.remove();
      live.delete(at);
    }
    queue = [...keep].filter((at) => !live.get(at)?.painted);
    queue.sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
    for (const at of queue) if (!live.has(at)) addSlot(at);
    void pump();
  }

  /* 一次只画一张：多张并行会一起抢 worker，滚起来反而更慢 */
  async function pump() {
    if (busy) return;
    const at = queue.shift();
    if (!at) return;
    const box = live.get(at);
    if (!box || box.painted) {
      void pump();
      return;
    }
    const card = seq;
    const mine = gen;
    const slot = { task: null };
    busy = { slot };
    try {
      const result = await renderPdfPage({ url, page: at, canvas: box.canvas, width, slot });
      busy = null;
      if (card !== seq || mine !== gen || !wrap.isConnected) return;
      box.painted = true;
      box.renderedWidth = width;
      /* 真画出来的比例跟撑出来的格子对不上就以它为准，顺手重排一次 */
      if (Math.abs(result.height - (heights[at] || 0)) > 1) {
        dims[at] = { width: result.width, height: result.height };
        relayout();
      }
      note("");
      void pump();
    } catch (error) {
      busy = null;
      /* 掐掉的、作废的不算读坏了，接着画下一张 */
      if (isCancelled(error) || mine !== gen) {
        void pump();
        return;
      }
      fail(pdfProblem(error));
    }
  }

  function go(delta) {
    if (!total) return;
    restore(Math.min(Math.max(1, anchor().page + delta), total), 0);
  }

  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));

  let scrollTick = false;
  let notifyTimer = null;

  /* 存盘这一下攒着点：scheduleItemsSave 会顺带重画鸟瞰窗，滚一页的工夫敲几十次不值当 */
  function notifyPosition() {
    clearTimeout(notifyTimer);
    notifyTimer = null;
    if (!wrap.isConnected) return;
    const a = anchor();
    item.page = a.page;
    item.pageFrac = a.frac;
    options.onPdfPage?.(item);
  }

  stage.addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (!total || stage.hidden) return;
      const a = anchor();
      chrome(a.page);
      /* 读到哪儿当场就记在块上：他可能滚完这一下就切画布，字段得是新的 */
      item.page = a.page;
      item.pageFrac = a.frac;
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(notifyPosition, 400);
      syncWindow();
    });
  });
  stage.addEventListener("scrollend", notifyPosition);

  /* 拖角改宽度：整条页链按新宽重排，画过的先拉成新格子的大小顶着，再一页页重画清楚 */
  new ResizeObserver(() => {
    if (!total || stage.hidden) return;
    const now = stage.clientWidth;
    if (now <= 0 || Math.abs(now - width) < 1) return;
    applyWidth(now);
  }).observe(stage);

  /* 每页多大要一页页问 pdf.js（不画，读几 KB 字典就回），几百页得后台慢慢补。
     问回来一次重排一次，重排前给滚动位置补差价，所以补尺寸这件事他基本看不见。 */
  async function measureRest(mine) {
    let fresh = 0;
    for (let at = 1; at <= total; at += 1) {
      if (mine !== seq || !wrap.isConnected) return;
      if (dims[at]) continue;
      try {
        const box = await pdfPageSize(url, at);
        if (mine !== seq || !wrap.isConnected) return;
        dims[box.page] = { width: box.width, height: box.height };
        fresh += 1;
      } catch {
        return; /* 问不到就算了，反正有比例撑着，读不读得下去不归它 */
      }
      if (fresh >= PDF_MEASURE_CHUNK) {
        fresh = 0;
        relayout();
        /* 让出主线程，别让几百次询问把滚动卡成幻灯片 */
        await new Promise((done) => setTimeout(done, 0));
      }
    }
    if (fresh) relayout();
  }

  (async function start() {
    const mine = seq;
    if (!options.loadPdfUrl) {
      fail("这份 PDF 暂时预览不了");
      return;
    }
    note(`正在读这份 ${formatSize(item.size)} 的 PDF…`);
    try {
      url = await options.loadPdfUrl(item);
      /* 记一笔持有：卸载时靠它判断是不是最后一个，最后一个走才销毁文档 */
      holdPdf(url);
      const doc = await openPdf(url);
      if (mine !== seq || !wrap.isConnected) return;
      total = doc.numPages;
      dims = new Array(total + 1);
      tops = new Array(total + 1);
      heights = new Array(total + 1);
      bar.hidden = total <= 1;
      /* 先把记忆里那一页的尺寸问回来：页链撑得起来，才谈得上滚回上次那一行 */
      const at = Math.min(Math.max(1, Math.trunc(item.page) || 1), total);
      const first = await pdfPageSize(url, at);
      if (mine !== seq || !wrap.isConnected) return;
      guess = { width: first.width, height: first.height };
      dims[first.page] = guess;
      pendingAnchor = { page: at, frac: clamp01(item.pageFrac) };
      if (stage.clientWidth > 0) applyWidth(stage.clientWidth);
      else chrome(at);
      void measureRest(mine);
    } catch (error) {
      if (mine !== seq) return;
      fail(pdfProblem(error));
    }
  })();

  /* agent 通过这个控制器读页码、跳页：和底栏那两颗箭头走的是同一条恢复路径 */
  wrap.__agent = {
    get state() {
      if (!total) {
        return { ready: false, total: 0, page: Math.trunc(item.page) || 1, frac: item.pageFrac || 0 };
      }
      const a = anchor();
      return { ready: true, total, page: a.page, frac: a.frac };
    },
    goto(page) {
      if (!total) throw new Error("PDF 还没读完，稍后再试");
      const at = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), total);
      restore(at, 0);
      notifyPosition();
      const a = anchor();
      return { ready: true, total, page: a.page, frac: a.frac };
    },
  };

  return wrap;
}

export function stopOnCard(button) {
  /* 卡片上的按钮归按钮自己，别顺手把块拖走 */
  for (const type of ["pointerdown", "dblclick"]) {
    button.addEventListener(type, (e) => e.stopPropagation());
  }
}

export const stripExt = (name) => String(name || "").replace(/\.[^.\\/]+$/, "");

/* 书页不进鼠标路径，帧里那段注入脚本只报一个数字：正文排到多高。
   外层把它当成滚动区的 content height，滚动条、滚轮、右键、按下拖动就都是主文档自己的事。
   帧的可滚范围和外层是同一个数（正文高 − 视口高，两边同一个视口），所以每次它报完尺寸
   都把外层当前的位置压回去，两边就对不齐不了。 */
export const pushEbookScroll = (frame) => {
  const scroll = frame.closest?.(".canvas-ebook-scroll");
  if (!scroll) return;
  frame.contentWindow?.postMessage({ type: "workbench:ebook-scroll", y: scroll.scrollTop }, "*");
};

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "workbench:ebook" || data.kind !== "height") return;
  const height = Number(data.h);
  if (!Number.isFinite(height) || height <= 0) return;
  /* 沙箱帧的 origin 是 "null"，只能按 source 认这是哪张纸 */
  const frame = [...document.querySelectorAll("iframe.canvas-ebook-page")].find(
    (f) => f.contentWindow === event.source,
  );
  if (!frame) return;
  const spacer = frame.parentElement;
  /* 拖拽缩放期间书页是被 transform 拉伸的预览，排版尺寸钉在起始值上，
     它报上来的高度也就还是起始宽度下的高度，别拿它去改滚动区 */
  if (frame.dataset.pinned) return;
  const next = `${Math.round(height)}px`;
  if (spacer.style.height !== next) spacer.style.height = next;
  pushEbookScroll(frame);
  /* 正文高度刚定下来，这一章的滚动位置这时候才放得准：
     高度还是旧章的时候算出来的比例是错的，等新高度到了再放一次 */
  const region = frame.closest?.(".canvas-ebook-scroll");
  if (region) watchScrollRegion(region);
});

/* 电子书阅读块：书上架前先读一遍目录，读到第几章记在这块自己身上。
 * 正文塞进 sandbox="allow-scripts" 的 iframe：只给脚本，不给同源、不给读本地文件，
 * 所以图片得在后端转成 data URL。书自带的脚本仍然跑不起来 —— 后端 clean_html
 * 是标签/属性白名单，script 标签和 on* 属性根本进不了正文，这里能跑的只有
 * reader_wrap 注入的那一段「把右键报给外层」的转发。 */
export function createEbookCard(item, options) {
  const card = document.createElement("div");
  card.className = "canvas-ebook-card";

  const head = document.createElement("div");
  head.className = "canvas-ebook-head";
  const meta = document.createElement("div");
  meta.className = "canvas-ebook-meta";
  const title = document.createElement("div");
  title.className = "canvas-ebook-title";
  title.textContent = stripExt(item.name) || "电子书";
  const author = document.createElement("div");
  author.className = "canvas-ebook-author";
  meta.append(title, author);

  /* 箭头用 SVG 而不是 ‹ › 字形：字符的墨迹中心跟行盒中心不重合，
     放在圆钮里怎么调都会看着偏一格 */
  const toolbar = document.createElement("div");
  toolbar.className = "canvas-ebook-toolbar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "canvas-ebook-step";
  prev.append(chevronSvg("M10 4 6 8l4 4"));
  prev.title = "上一章";
  prev.setAttribute("aria-label", "上一章");
  const select = document.createElement("select");
  select.className = "canvas-ebook-select";
  select.title = "选择章节";
  select.disabled = true;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "canvas-ebook-step";
  next.append(chevronSvg("M6 4l4 4-4 4"));
  next.title = "下一章";
  next.setAttribute("aria-label", "下一章");
  const pos = document.createElement("span");
  pos.className = "canvas-ebook-pos";
  toolbar.append(prev, select, next, pos);
  head.append(meta, toolbar);
  for (const control of [prev, select, next]) stopOnCard(control);

  const body = document.createElement("div");
  body.className = "canvas-ebook-body";
  /* 滚动区是主文档自己的元素：悬停给出 move 光标、按下第一像素就能拖块、滚轮滚正文、
     右键走应用的块菜单。书页被钉在这块视口上（sticky），只照外层给的偏移滚自己。 */
  const scroll = document.createElement("div");
  scroll.className = "canvas-ebook-scroll";
  /* 书页按章记：每章的滚动位置各存一份，翻回上一章还在上次读到的地方 */
  scroll.dataset.scrollKey = `ebook:${item.chapter || 0}`;
  const spacer = document.createElement("div");
  spacer.className = "canvas-ebook-spacer";
  const frame = document.createElement("iframe");
  frame.className = "canvas-ebook-page";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "书页";
  spacer.append(frame);
  scroll.append(spacer);
  const state = document.createElement("div");
  state.className = "canvas-ebook-state";
  state.textContent = "正在排版…";
  body.append(scroll, state);
  card.append(head, body);

  /* 书页的排版高度 = 滚动区的可视高度（它是个视口，正文在它里面滚）。
     拖拽期间钉住尺寸，别让跨进程帧每一步都重新分配渲染表面。 */
  const fitPage = () => {
    if (frame.dataset.pinned) return;
    frame.style.height = `${Math.max(1, scroll.clientHeight)}px`;
  };
  new ResizeObserver(fitPage).observe(scroll);
  /* 外层滚了多少，就让帧里的正文跟着滚多少；一帧内多次滚动合并成一次 */
  let syncQueued = false;
  scroll.addEventListener("scroll", () => {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      pushEbookScroll(frame);
    });
  });
  scroll.addEventListener("pointerdown", (e) => {
    /* 按在滚动条上归浏览器拖滚动条，别顺手把整块拖走 */
    if (e.offsetX > scroll.clientWidth) e.stopPropagation();
  });

  /* wanted 是「已经点去、还没翻到」的那一章：连点下一章时按它累加，
     不然两次都从 item.chapter 起算，只会反复请求同一章 */
  let book = null;
  let wanted = null;
  let seq = 0;

  const step = (dir) => {
    if (!book) return;
    const base = wanted ?? item.chapter;
    const target = base + dir;
    if (target < 0 || target >= book.chapters.length) return;
    showChapter(target, true);
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  select.addEventListener("change", () => showChapter(Number(select.value) || 0, true));

  /* 书在、但读不出内容（DRM、空书）时才在块里留一行话；丢了走上面那张卡 */
  function fail(text) {
    seq += 1;
    state.hidden = false;
    state.textContent = text;
    scroll.hidden = true;
  }

  function paintChrome() {
    const total = book.chapters.length;
    const at = Math.min(item.chapter, total - 1);
    select.value = String(at);
    pos.textContent = `${at + 1} / ${total}`;
    prev.disabled = at <= 0;
    next.disabled = at >= total - 1;
  }

  async function showChapter(index, remember) {
    if (!book) return;
    const total = book.chapters.length;
    const at = Math.min(Math.max(0, Math.trunc(index)), total - 1);
    wanted = at;
    const mine = ++seq;
    scroll.hidden = false;
    state.hidden = false;
    state.textContent = total > 1 ? `正在翻到第 ${at + 1} 章…` : "正在排版…";
    let chapter = null;
    try {
      chapter = await options.loadEbookChapter?.(item, at);
    } catch (error) {
      if (mine !== seq || !card.isConnected) return;
      fail(String(error));
      return;
    }
    /* 连点下一章时只认最后一次：慢的那次回来别把新章盖回去 */
    if (mine !== seq || !card.isConnected || !chapter) return;
    frame.srcdoc = chapter.html;
    /* 新一章从顶上看起；外层这条滚动条不会自己归零，等帧报新尺寸时再把 0 压回帧里。
       先换键名再归零：顺序反了的话，这一下归零会被记到上一章名下，
       下一章读完了再翻回去，上一章的位置就没了 */
    setScrollKey(scroll, `ebook:${at}`);
    markScrollSilent(scroll);
    scroll.scrollTop = 0;
    state.hidden = true;
    item.chapter = at;
    paintChrome();
    if (remember) options.onEbookPosition?.(item);
  }

  (async () => {
    /* 先问一句书还在不在，不在就把纸换成丢文件卡，不去读一本不存在的东西 */
    if (options.checkFile) {
      let found = true;
      try {
        found = await options.checkFile(item);
      } catch {
        found = true;
      }
      if (found === false) {
        if (card.isConnected) options.onMissing?.(item);
        return;
      }
    }
    let info = null;
    try {
      info = await options.loadEbookToc?.(item);
    } catch (error) {
      if (card.isConnected) fail(String(error));
      return;
    }
    if (!card.isConnected) return;
    if (!info || !Array.isArray(info.chapters) || !info.chapters.length) {
      fail("这本书里没有正文");
      return;
    }
    book = info;
    if (info.title) title.textContent = info.title;
    if (info.author) author.textContent = info.author;
    else author.remove();
    select.textContent = "";
    info.chapters.forEach((name, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `${i + 1}. ${name || `第 ${i + 1} 章`}`;
      select.append(option);
    });
    select.disabled = false;
    item.chapter = Math.min(item.chapter, info.chapters.length - 1);
    paintChrome();
    await showChapter(item.chapter, false);
  })();

  /* agent 控制器：目录、当前章、跳章，跟工具栏那三件套共用 showChapter */
  const agentState = () => {
    const total = book?.chapters?.length || 0;
    return {
      ready: Boolean(book),
      total,
      chapter: total ? Math.min(item.chapter, total - 1) : item.chapter || 0,
      title: book?.title || title.textContent,
      chapters: book?.chapters || [],
    };
  };
  card.__agent = {
    get state() {
      return agentState();
    },
    async goto(index) {
      if (!book) throw new Error("这本书还没读进来，稍后再试");
      const at = Math.min(Math.max(0, Math.trunc(Number(index)) || 0), book.chapters.length - 1);
      await showChapter(at, true);
      return agentState();
    },
  };

  return card;
}

async function fillFilePreview(card, body, sub, item, options) {
  let preview = null;
  try {
    preview = await options.loadPreview?.(item);
  } catch (error) {
    /* 解不出来才摊开说，正常态这里一行小字都不加 */
    body.className = "canvas-file-preview is-failed";
    body.textContent = String(error);
    return;
  }
  if (!preview || !card.isConnected) return;
  const tags = [];
  if (preview.encoding && preview.encoding !== "UTF-8") tags.push(preview.encoding);
  if (preview.truncated) tags.push("仅预览开头");
  if (tags.length) sub.textContent += ` · ${tags.join(" · ")}`;
  renderFilePreview(body, item, preview);
  restoreReadProgress(body, item);
  /* Markdown 里贴的图存在这块自己的 notes/<块id>/ 下，渲染后换成能显示的地址。
     图是异步加载的，撑高正文会把刚滚好的位置顶偏，换完再对一次。 */
  if (isMarkdownExt(item.ext)) {
    hydrateNoteImages(item, body).then(() => restoreReadProgress(body, item));
  }
}

export function renderFilePreview(body, item, preview) {
  const ext = (item.ext || "").toLowerCase();
  if (isMarkdownExt(ext) && preview.text) {
    /* 浏览态直接渲染 Markdown（与笔记卡同一套排版），不在卡片里摆源码 */
    const md = document.createElement("div");
    md.className = "md-body canvas-file-markdown";
    md.innerHTML = renderMarkdown(preview.text);
    body.classList.add("is-markdown");
    body.append(md);
    return;
  }
  if (TABLE_EXTS.has(ext)) {
    const table = createDelimitedTable(preview.text, ext === "tsv" ? "\t" : ",");
    if (table) {
      body.classList.add("is-table");
      body.append(table);
      return;
    }
  }
  /* 文本文件在画布里设过字级样式：浏览态回显存于块上的富文本，源文件仍是纯文本 */
  if (item.richHtml) {
    const rich = document.createElement("div");
    rich.className = "canvas-file-rich-preview";
    rich.innerHTML = sanitizeInlineHtml(item.richHtml);
    body.append(rich);
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "canvas-file-lines";
  pre.textContent =
    preview.text.length > PREVIEW_RENDER_CHARS
      ? `${preview.text.slice(0, PREVIEW_RENDER_CHARS)}\n…`
      : preview.text;
  body.append(pre);
}

/* DOCX 块：mammoth 把 docx（一个 zip 包）转成语义化 HTML，灌进卡片当只读预览。
   标题/段落/列表/表格/加粗斜体/超链接/内嵌图片都能出来，和 PDF 看页、电子书看章节同级。
   图片默认被 mammoth 转成 base64 内联，WebView 里直接显示，不依赖外部资源。 */

export const DOCX_MAX_BYTES = 30 * 1024 * 1024; /* 带图的 docx 可能很大，整本读进内存前先拦一道 */

/* 在只读预览区里复制时，把选区转成纯文本再写进剪贴板：保留段落/标题/列表的换行，
   但丢掉 HTML 标签。否则 WebView 会把 HTML 序列化（带 <p>/<h1> 等标签）写进剪贴板，
   粘贴到别处就露出源码。Selection.toString() 拿到的就是浏览器原本要作为 text/plain
   复制的那份纯文本，天然带块级换行、没有标签。 */
export function attachPlainCopy(el) {
  el.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    const text = sel.toString();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  });
}

export function createDocxBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-docx";

  const state = document.createElement("div");
  state.className = "canvas-file-docx-state";
  state.textContent = "正在解析 DOCX…";
  wrap.append(state);

  const content = document.createElement("div");
  content.className = "canvas-file-docx-body";
  content.hidden = true;
  wrap.append(content);

  attachPlainCopy(content);
  attachReadProgress(content, item);
  loadDocxPreview(wrap, content, state, item, options);
  return wrap;
}

async function loadDocxPreview(wrap, content, state, item, options) {
  if (item.size && item.size > DOCX_MAX_BYTES) {
    failDocx(state, content, "文件太大（超过 30MB），暂不预览");
    return;
  }
  let url;
  try {
    url = await options.loadDocxUrl?.(item);
  } catch (error) {
    failDocx(state, content, error);
    return;
  }
  if (!url || !wrap.isConnected) return;
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`取文件失败（${res.status}）`);
    buffer = await res.arrayBuffer();
  } catch (error) {
    failDocx(state, content, error);
    return;
  }
  if (!wrap.isConnected) return;
  try {
    const html = await convertDocx(buffer);
    content.innerHTML =
      html || "<p class=\"canvas-file-docx-empty\">（这份 DOCX 里没有可显示的文字）</p>";
    state.hidden = true;
    content.hidden = false;
    /* 正文到位、容器露出来之后才量得到高度，这时候再把阅读位置滚回去 */
    restoreReadProgress(content, item);
  } catch (error) {
    failDocx(state, content, error);
  }
}

export function convertDocx(buffer) {
  const lib = window.mammoth;
  if (lib && typeof lib.convertToHtml === "function") {
    return lib.convertToHtml({ arrayBuffer: buffer }).then((result) => result.value);
  }
  return Promise.reject(new Error("DOCX 预览组件没加载（mammoth 不可用）"));
}

export function failDocx(state, content, error) {
  const message = error && error.message ? error.message : String(error);
  state.className = "canvas-file-docx-state is-failed";
  state.textContent = message;
  state.hidden = false;
  content.hidden = true;
}

/* XLSX 块：把表格读成数据、自己画成 HTML 表，不做像素级还原。
   一个工作簿有多张表，就给一张表一排标签，点哪个亮哪个。 */

export const XLSX_MAX_BYTES = 30 * 1024 * 1024; /* 整本读进内存前先拦一道，跟 docx 一个尺度 */
export const XLSX_MAX_ROWS = 1000;   /* 单表超过这一行就只画前面这些，避免一次塞几千行卡死预览 */
export const XLSX_MAX_COLS = 200;    /* 单列同理 */

export function createXlsxBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-xlsx";

  const tabs = document.createElement("div");
  tabs.className = "canvas-file-xlsx-tabs";
  tabs.hidden = true;

  const state = document.createElement("div");
  state.className = "canvas-file-xlsx-state";
  state.textContent = "正在解析 XLSX…";

  const scroller = document.createElement("div");
  scroller.className = "canvas-file-xlsx-scroll";
  scroller.hidden = true;
  /* 表格区能滚：滚到哪儿记在这块自己身上。
     键名在 renderWorkbook 里换成按表分的：各表各记各的滚动位置 */
  scroller.dataset.scrollKey = "xlsx";

  wrap.append(tabs, state, scroller);
  attachPlainCopy(scroller);

  loadXlsxPreview(wrap, tabs, scroller, state, item, options);
  return wrap;
}

async function loadXlsxPreview(wrap, tabs, scroller, state, item, options) {
  if (item.size && item.size > XLSX_MAX_BYTES) {
    failXlsx(state, scroller, "文件太大（超过 30MB），暂不预览");
    return;
  }
  let url;
  try {
    url = await options.loadXlsxUrl?.(item);
  } catch (error) {
    failXlsx(state, scroller, error);
    return;
  }
  if (!url || !wrap.isConnected) return;
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`取文件失败（${res.status}）`);
    buffer = await res.arrayBuffer();
  } catch (error) {
    failXlsx(state, scroller, error);
    return;
  }
  if (!wrap.isConnected) return;
  try {
    renderWorkbook(scroller, tabs, buffer, state);
    if (!scroller.firstChild) {
      state.className = "canvas-file-xlsx-state is-failed";
      state.textContent = "（这份 XLSX 里没有可显示的表格）";
      state.hidden = false;
      scroller.hidden = true;
      return;
    }
    state.hidden = true;
    tabs.hidden = false;
    scroller.hidden = false;
    /* 表格刚画出来时高度还没稳（上面那句 setScrollKey 放的可能是老位置）：
       可见之后再放一次，这时量到的才是真高度 */
    watchScrollRegion(scroller);
  } catch (error) {
    failXlsx(state, scroller, error);
  }
}

/* 读工作簿 -> 给每张表造一个 table，全部塞进 scroller，只亮第一张；
   标签点哪个就切哪张。表头加粗、合并单元格用 rowspan/colspan 还原。 */
export function renderWorkbook(scroller, tabs, buffer, state) {
  const lib = window.XLSX;
  if (!lib || typeof lib.read !== "function") {
    throw new Error("XLSX 预览组件没加载（SheetJS 不可用）");
  }
  const wb = lib.read(buffer, { type: "array" });
  const names = wb.SheetNames || [];
  if (!names.length) {
    state.textContent = "（这份 XLSX 里没有工作表）";
    return;
  }
  const sheets = [];
  for (const name of names) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const table = buildSheetTable(lib, ws);
    sheets.push({ name, table });
  }
  if (!sheets.length) {
    state.textContent = "（这份 XLSX 里没有可显示的表格）";
    return;
  }
  const panels = [];
  sheets.forEach((sheet, idx) => {
    const panel = document.createElement("div");
    panel.className = "canvas-file-xlsx-sheet";
    panel.hidden = idx !== 0;
    panel.append(sheet.table);
    scroller.append(panel);
    panels.push(panel);

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "canvas-file-xlsx-tab" + (idx === 0 ? " is-active" : "");
    tab.textContent = sheet.name;
    tab.setAttribute("aria-label", sheet.name);
    stopOnCard(tab);
    tab.addEventListener("click", () => {
      panels.forEach((p, i) => (p.hidden = i !== idx));
      for (const t of tabs.children) t.classList.toggle("is-active", t === tab);
      /* 换表就是换了一份内容：键名跟着表名走，各表各记各的滚动位置，
         切回来时回到这张表上次看到的地方 */
      setScrollKey(scroller, `xlsx:${sheet.name}`);
    });
    tabs.append(tab);
  });
  /* 刚打开时显示的是第一张表：键名也要按表名走，跟切表时用的是同一套，
     否则第一次打开记的位置和切回来时的位置对不上号 */
  setScrollKey(scroller, `xlsx:${sheets[0].name}`);
}

/* 一张表 -> 一张 <table>。按 ref 的矩形逐格取，空格留空，合并格用 span 还原。 */
export function buildSheetTable(lib, ws) {
  const range = lib.utils.decode_range(ws["!ref"]);
  const maxRow = Math.min(range.e.r, range.s.r + XLSX_MAX_ROWS - 1);
  const maxCol = Math.min(range.e.c, range.s.c + XLSX_MAX_COLS - 1);

  /* 合并区域：被盖住的格跳过，左上格记上跨行跨列 */
  const skip = new Set();
  const spans = new Map();
  if (ws["!merges"]) {
    for (const m of ws["!merges"]) {
      const rs = m.e.r - m.s.r + 1;
      const cs = m.e.c - m.s.c + 1;
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r === m.s.r && c === m.s.c) spans.set(`${r},${c}`, { rs, cs });
          else skip.add(`${r},${c}`);
        }
      }
    }
  }

  const table = document.createElement("table");
  table.className = "canvas-file-xlsx-table";
  for (let r = range.s.r; r <= maxRow; r++) {
    const tr = document.createElement("tr");
    for (let c = range.s.c; c <= maxCol; c++) {
      const key = `${r},${c}`;
      if (skip.has(key)) continue;
      const addr = lib.utils.encode_cell({ r, c });
      const cell = ws[addr];
      const value = cell ? cell.w != null ? cell.w : String(cell.v ?? "") : "";
      const th = r === range.s.r; /* 第一行当作表头 */
      const td = document.createElement(th ? "th" : "td");
      td.textContent = value;
      const span = spans.get(key);
      if (span) {
        if (span.rs > 1) td.rowSpan = span.rs;
        if (span.cs > 1) td.colSpan = span.cs;
      }
      tr.append(td);
    }
    table.append(tr);
  }
  if (maxRow < range.e.r || maxCol < range.e.c) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "canvas-file-xlsx-trunc";
    td.colSpan = maxCol - range.s.c + 1;
    td.textContent = `… 仅预览前 ${maxRow - range.s.r + 1} 行 / ${maxCol - range.s.c + 1} 列（完整内容请用 Excel 打开）`;
    tr.append(td);
    table.append(tr);
  }
  return table;
}

export function failXlsx(state, scroller, error) {
  const message = error && error.message ? error.message : String(error);
  state.className = "canvas-file-xlsx-state is-failed";
  state.textContent = message;
  state.hidden = false;
  scroller.hidden = true;
}

/* PPTX 块：把每一页拆成绝对定位的文本框/图片/表格，按原始版面比例还原。
   不做像素级还原（图表、SmartArt、动画都跳过），但文本、图片、表格的位置和
   字号、颜色尽量贴近原稿，足够预览内容。PPTX 是 OOXML 压缩包：用 JSZip 解包，
   逐页读 slideN.xml，图片从 ppt/media 里取。 */

export const PPTX_MAX_BYTES = 30 * 1024 * 1024; /* 整包读进内存前先拦一道，跟 docx/xlsx 一个尺度 */
export const PPTX_MAX_SLIDES = 100; /* 超过这么多页就只预览前面这些，避免一次解几百页卡死 */
export const PPTX_EMU_PER_PX = 9525; /* 914400 EMU/英寸 ÷ 96 px/英寸，内部按固定 96DPI 渲染 */
export const PPTX_THUMB_W = 132; /* 缩略图条里每张缩略图的宽度（px） */
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/* 配色方案默认映射：稿件里 schemeClr 的 tx1/bg1 等经 clrMap 落到 dk1/lt1 等具体色 */
export const PPTX_SCHEME_MAP = {
  tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2",
  accent1: "accent1", accent2: "accent2", accent3: "accent3",
  accent4: "accent4", accent5: "accent5", accent6: "accent6",
  hlink: "hlink", folHlink: "folHlink",
};

export function createPptxBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-pptx";

  const state = document.createElement("div");
  state.className = "canvas-file-pptx-state";
  state.textContent = "正在解析 PPTX…";

  const scroller = document.createElement("div");
  scroller.className = "canvas-file-pptx-scroll";
  scroller.hidden = true;

  wrap.append(state, scroller);
  attachPlainCopy(scroller);
  loadPptxPreview(wrap, scroller, state, item, options);
  return wrap;
}

async function loadPptxPreview(wrap, scroller, state, item, options) {
  if (item.size && item.size > PPTX_MAX_BYTES) {
    failPptx(state, scroller, "文件太大（超过 30MB），暂不预览");
    return;
  }
  let url;
  try {
    url = await options.loadPptxUrl?.(item);
  } catch (error) {
    failPptx(state, scroller, error);
    return;
  }
  if (!url || !wrap.isConnected) return;
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`取文件失败（${res.status}）`);
    buffer = await res.arrayBuffer();
  } catch (error) {
    failPptx(state, scroller, error);
    return;
  }
  if (!wrap.isConnected) return;
  try {
    const doc = await parsePptx(buffer);
    if (!doc.slides.length) {
      state.className = "canvas-file-pptx-state is-failed";
      state.textContent = "（这份 PPTX 里没有可显示的幻灯片）";
      state.hidden = false;
      scroller.hidden = true;
      return;
    }
    renderPptx(scroller, doc, state);
    state.hidden = true;
    scroller.hidden = false;
  } catch (error) {
    failPptx(state, scroller, error);
  }
}

/* 解包 + 读页序 + 读主题色 + 逐页解析。图片按路径缓存成 object URL，避免重复解同一张。 */
async function parsePptx(buffer) {
  const lib = window.JSZip;
  if (!lib || typeof lib.loadAsync !== "function") {
    throw new Error("PPTX 预览组件没加载（JSZip 不可用）");
  }
  const zip = await lib.loadAsync(buffer);
  const files = zip.files;
  const names = Object.keys(files);

  let slidePaths = await resolveSlideOrder(zip);
  if (!slidePaths.length) {
    slidePaths = names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => pptxNumSuffix(a) - pptxNumSuffix(b));
  }
  /* 页序里个别 target 可能对不上实际文件（稿件不规范），只留真实存在的，别让一页拖垮整份 */
  slidePaths = slidePaths.filter((p) => files[p]).slice(0, PPTX_MAX_SLIDES);

  const clrScheme = await readThemeColors(zip);
  const sldSz = await readSlideSize(zip);
  const mediaCache = new Map();

  const slides = [];
  for (const path of slidePaths) {
    const xml = await files[path].async("string");
    const relMap = await readSlideRels(zip, path);
    const slide = await parseSlide(xml, relMap, zip, mediaCache, clrScheme);
    slides.push(slide);
  }
  return { slides, sldSz, mediaCache };
}

/* presentation.xml 的 sldIdLst 决定真正页序（含重排），比按文件名排序更准 */
async function resolveSlideOrder(zip) {
  const presFile = zip.file("ppt/presentation.xml");
  if (!presFile) return [];
  const doc = parseXml(await presFile.async("string"));
  if (!doc) return [];
  const sldIdLst = firstByLocal(doc, "sldIdLst");
  if (!sldIdLst) return [];
  const rIds = [];
  for (const el of childrenByLocal(sldIdLst, "sldId")) {
    const rid = el.getAttribute("r:id") || el.getAttributeNS(R_NS, "id");
    if (rid) rIds.push(rid);
  }
  if (!rIds.length) return [];
  const relMap = await readRels(zip, "ppt/presentation.xml");
  const paths = [];
  for (const rid of rIds) {
    const target = relMap.get(rid);
    if (target) paths.push(pptxResolveTarget("ppt/", target));
  }
  return paths;
}

async function readRels(zip, xmlPath) {
  const dir = xmlPath.includes("/") ? xmlPath.slice(0, xmlPath.lastIndexOf("/") + 1) : "";
  const baseName = xmlPath.slice(dir.length);
  const relsPath = `${dir}_rels/${baseName}.rels`;
  const map = new Map();
  const f = zip.file(relsPath);
  if (!f) return map;
  const doc = parseXml(await f.async("string"));
  if (!doc) return map;
  for (const rel of childrenByLocal(doc.documentElement, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

async function readSlideRels(zip, slidePath) {
  return readRels(zip, slidePath);
}

async function readSlideSize(zip) {
  const f = zip.file("ppt/presentation.xml");
  if (!f) return { cx: 12192000, cy: 6858000 };
  const doc = parseXml(await f.async("string"));
  const sldSz = doc && firstByLocal(doc, "sldSz");
  if (sldSz) {
    const cx = parseInt(sldSz.getAttribute("cx") || "", 10);
    const cy = parseInt(sldSz.getAttribute("cy") || "", 10);
    if (cx > 0 && cy > 0) return { cx, cy };
  }
  return { cx: 12192000, cy: 6858000 };
}

async function readThemeColors(zip) {
  const themeFile =
    zip.file("ppt/theme/theme1.xml") ||
    zip.file(Object.keys(zip.files).find((n) => /^ppt\/theme\/theme\d+\.xml$/i.test(n)) || "");
  const map = new Map();
  if (!themeFile) return map;
  const doc = parseXml(await themeFile.async("string"));
  if (!doc) return map;
  const clrScheme = firstByLocal(doc, "clrScheme");
  if (!clrScheme) return map;
  for (const child of clrScheme.children) {
    const name = child.localName;
    if (!name) continue;
    const srgb = firstByLocal(child, "srgbClr");
    if (srgb) {
      map.set(name, "#" + (srgb.getAttribute("val") || "000000"));
      continue;
    }
    const sys = firstByLocal(child, "sysClr");
    if (sys) map.set(name, "#" + (sys.getAttribute("lastClr") || "000000"));
  }
  return map;
}

async function parseSlide(xml, relMap, zip, mediaCache, clrScheme) {
  const doc = parseXml(xml);
  const slide = { shapes: [], bg: null };
  if (!doc) return slide;
  const spTree = firstByLocal(doc, "spTree");
  if (!spTree) return slide;
  await walkShapes(spTree, slide, relMap, zip, mediaCache, clrScheme, 0, 0, 1, 1);
  const bg = firstByLocal(doc, "bg");
  if (bg) slide.bg = readFill(firstByLocal(bg, "bgPr"), clrScheme);
  return slide;
}

/* 递归走 spTree：文本框、图片、表格各自处理；组合图形(grpSp)把子元素按组变换映射回页面坐标 */
async function walkShapes(node, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  for (const child of node.children) {
    const ln = child.localName;
    if (ln === "sp" || ln === "cxsp") {
      handleShape(child, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY);
    } else if (ln === "pic") {
      await handlePic(child, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY);
    } else if (ln === "graphicFrame") {
      handleGraphicFrame(child, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY);
    } else if (ln === "grpSp") {
      const g = readXfrm(child);
      let ngx = gx, ngy = gy, nsx = gScaleX, nsy = gScaleY;
      if (g && g.chExtCx && g.chExtCy) {
        const sx = g.extCx / g.chExtCx;
        const sy = g.extCy / g.chExtCy;
        ngx = gx + (g.offX - g.chOffX) * gScaleX;
        ngy = gy + (g.offY - g.chOffY) * gScaleY;
        nsx = gScaleX * sx;
        nsy = gScaleY * sy;
      }
      await walkShapes(child, slide, relMap, zip, mediaCache, clrScheme, ngx, ngy, nsx, nsy);
    }
  }
}

export function handleShape(sp, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  const txBody = firstByLocal(sp, "txBody");
  if (!txBody) return;
  const paras = extractText(txBody, clrScheme).paras;
  if (!paras.length) return;
  const xfrm = readXfrm(sp);
  const pos = xfrm
    ? { x: gx + xfrm.offX * gScaleX, y: gy + xfrm.offY * gScaleY, w: xfrm.extCx * gScaleX, h: xfrm.extCy * gScaleY }
    : { x: 0, y: 0, w: 0, h: 0 };
  const bodyPr = firstByLocal(txBody, "bodyPr");
  const anchor = bodyPr ? bodyPr.getAttribute("anchor") || "" : "";
  slide.shapes.push({ type: "text", pos, paras, anchor });
}

async function handlePic(pic, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  const xfrm = readXfrm(pic);
  const blip = firstByLocal(pic, "blip");
  const embed = blip ? blip.getAttribute("r:embed") || blip.getAttributeNS(R_NS, "embed") : null;
  let imgUrl = "";
  if (embed && relMap.has(embed)) {
    const mediaPath = pptxResolveTarget("ppt/slides/", relMap.get(embed));
    imgUrl = await getMediaUrl(zip, mediaPath, mediaCache);
  }
  const pos = xfrm
    ? { x: gx + xfrm.offX * gScaleX, y: gy + xfrm.offY * gScaleY, w: xfrm.extCx * gScaleX, h: xfrm.extCy * gScaleY }
    : { x: 0, y: 0, w: 0, h: 0 };
  slide.shapes.push({ type: "pic", pos, imgUrl });
}

export function handleGraphicFrame(gf, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  const graphicData = firstByLocal(gf, "graphicData");
  const tbl = graphicData && descendantByLocal(graphicData, "tbl");
  if (!tbl) return;
  const xfrm = readXfrm(gf);
  const pos = xfrm
    ? { x: gx + xfrm.offX * gScaleX, y: gy + xfrm.offY * gScaleY, w: xfrm.extCx * gScaleX, h: xfrm.extCy * gScaleY }
    : { x: 0, y: 0, w: 0, h: 0 };
  slide.shapes.push({ type: "table", pos, table: parseTable(tbl, clrScheme) });
}

/* 一个文本框 -> 段落数组；每段带对齐/项目符号，段内是带样式的 run */
export function extractText(txBody, clrScheme) {
  const paras = [];
  for (const p of childrenByLocal(txBody, "p")) {
    const pPr = firstByLocal(p, "pPr");
    const align = pPr ? pPr.getAttribute("algn") || "" : "";
    const bullet = hasBullet(pPr);
    const runs = [];
    for (const child of p.children) {
      const ln = child.localName;
      if (ln === "r") {
        const rPr = firstByLocal(child, "rPr");
        const t = firstByLocal(child, "t");
        if (!t || !t.textContent) continue;
        runs.push({
          text: t.textContent,
          bold: rPr ? rPr.getAttribute("b") === "1" || rPr.getAttribute("b") === "" : false,
          italic: rPr ? rPr.getAttribute("i") === "1" || rPr.getAttribute("i") === "" : false,
          sz: rPr ? parseFloat(rPr.getAttribute("sz") || "1800") : 1800,
          color: rPr ? readRunColor(rPr, clrScheme) : "#000000",
        });
      } else if (ln === "br") {
        runs.push({ br: true });
      }
    }
    paras.push({ align, bullet, runs });
  }
  return { paras };
}

export function hasBullet(pPr) {
  if (!pPr) return false;
  if (firstByLocal(pPr, "buNone")) return false;
  return !!(firstByLocal(pPr, "buChar") || firstByLocal(pPr, "buAutoNum"));
}

export function readRunColor(rPr, clrScheme) {
  const solid = firstByLocal(rPr, "solidFill");
  if (solid) {
    const srgb = firstByLocal(solid, "srgbClr");
    if (srgb) return "#" + (srgb.getAttribute("val") || "000000");
    const scheme = firstByLocal(solid, "schemeClr");
    if (scheme) {
      const mapped = pptxMapScheme(scheme.getAttribute("val") || "", clrScheme);
      if (mapped) return mapped;
    }
  }
  return "#000000";
}

export function pptxMapScheme(v, clrScheme) {
  const key = PPTX_SCHEME_MAP[v] || v;
  return clrScheme.get(key) || null;
}

export function readFill(el, clrScheme) {
  if (!el) return null;
  const solid = firstByLocal(el, "solidFill");
  if (!solid) return null;
  const srgb = firstByLocal(solid, "srgbClr");
  if (srgb) return "#" + (srgb.getAttribute("val") || "000000");
  const scheme = firstByLocal(solid, "schemeClr");
  if (scheme) return pptxMapScheme(scheme.getAttribute("val") || "", clrScheme) || null;
  return null;
}

export function parseTable(tbl, clrScheme) {
  const rows = [];
  for (const tr of childrenByLocal(tbl, "tr")) {
    const cells = [];
    for (const tc of childrenByLocal(tr, "tc")) {
      const txBody = firstByLocal(tc, "txBody");
      const text = txBody ? extractText(txBody, clrScheme) : { paras: [] };
      const gs = firstByLocal(tc, "gridSpan");
      const rs = firstByLocal(tc, "rowSpan");
      const gridSpan = gs ? parseInt(gs.getAttribute("val") || "1", 10) || 1 : 1;
      const rowSpan = rs ? parseInt(rs.getAttribute("val") || "1", 10) || 1 : 1;
      cells.push({ text, gridSpan, rowSpan });
    }
    rows.push({ cells });
  }
  return { rows };
}

/* 把一页画成「固定 96DPI 的内部舞台 + 整体缩放」：位置、字号都按 EMU→px 算准，
   再用 transform: scale 适配卡片宽度，所有比例天然跟着缩放，不用逐像素调字号 */
export function buildSlideNode(slide, sldSz, targetWidth) {
  const stageW = sldSz.cx / PPTX_EMU_PER_PX;
  const stageH = sldSz.cy / PPTX_EMU_PER_PX;

  const inner = document.createElement("div");
  inner.className = "canvas-file-pptx-slide";
  inner.style.width = stageW + "px";
  inner.style.height = stageH + "px";
  if (slide.bg) inner.style.background = slide.bg;

  for (const shape of slide.shapes) {
    if (shape.type === "text") {
      const box = document.createElement("div");
      box.className = "pptx-textbox";
      const x = shape.pos.x / PPTX_EMU_PER_PX;
      const y = shape.pos.y / PPTX_EMU_PER_PX;
      const w = shape.pos.w / PPTX_EMU_PER_PX;
      const h = shape.pos.h / PPTX_EMU_PER_PX;
      box.style.left = x + "px";
      box.style.top = y + "px";
      if (w) box.style.width = w + "px";
      if (h) box.style.height = h + "px";
      if (shape.anchor === "ctr") box.style.justifyContent = "center";
      else if (shape.anchor === "b") box.style.justifyContent = "flex-end";
      for (const para of shape.paras) box.append(buildParagraph(para));
      inner.append(box);
    } else if (shape.type === "pic") {
      if (shape.imgUrl) {
        const img = document.createElement("img");
        img.className = "pptx-img";
        img.src = shape.imgUrl;
        img.draggable = false;
        img.style.left = shape.pos.x / PPTX_EMU_PER_PX + "px";
        img.style.top = shape.pos.y / PPTX_EMU_PER_PX + "px";
        if (shape.pos.w) img.style.width = shape.pos.w / PPTX_EMU_PER_PX + "px";
        if (shape.pos.h) img.style.height = shape.pos.h / PPTX_EMU_PER_PX + "px";
        inner.append(img);
      }
    } else if (shape.type === "table") {
      const tbl = buildTableEl(shape);
      tbl.style.left = shape.pos.x / PPTX_EMU_PER_PX + "px";
      tbl.style.top = shape.pos.y / PPTX_EMU_PER_PX + "px";
      if (shape.pos.w) tbl.style.width = shape.pos.w / PPTX_EMU_PER_PX + "px";
      inner.append(tbl);
    }
  }

  const scaler = document.createElement("div");
  scaler.className = "canvas-file-pptx-slidewrap";
  scaler.append(inner);
  if (targetWidth) {
    const scale = targetWidth / stageW;
    inner.style.transform = `scale(${scale})`;
    scaler.style.width = targetWidth + "px";
    scaler.style.height = stageH * scale + "px";
  }
  return { scaler, inner, stageW, stageH };
}

export function buildParagraph(para) {
  const p = document.createElement("p");
  if (para.align) p.style.textAlign = para.align;
  if (para.bullet) p.classList.add("pptx-bullet");
  for (const run of para.runs) {
    if (run.br) {
      p.append(document.createElement("br"));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = run.text;
    span.style.fontWeight = run.bold ? "700" : "400";
    span.style.fontStyle = run.italic ? "italic" : "normal";
    span.style.fontSize = run.sz / 75 + "px"; /* 96DPI：sz(百分之一磅)/100×96/72 = sz/75 */
    span.style.color = run.color;
    p.append(span);
  }
  return p;
}

export function buildTableEl(shape) {
  const tbl = document.createElement("table");
  tbl.className = "pptx-table";
  const table = shape.table;
  const skip = new Set();
  let rIdx = 0;
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    let cIdx = 0;
    for (const cell of row.cells) {
      while (skip.has(rIdx + "," + cIdx)) cIdx++;
      const td = document.createElement("td");
      for (const para of cell.text.paras) td.append(buildParagraph(para));
      if (cell.gridSpan > 1) td.colSpan = cell.gridSpan;
      if (cell.rowSpan > 1) {
        td.rowSpan = cell.rowSpan;
        for (let rr = 1; rr < cell.rowSpan; rr++) skip.add(rIdx + rr + "," + cIdx);
      }
      if (!td.firstChild) td.append(document.createTextNode(""));
      tr.append(td);
      cIdx += cell.gridSpan > 1 ? cell.gridSpan : 1;
    }
    tbl.append(tr);
    rIdx++;
  }
  return tbl;
}

/* 主舞台适配卡片宽度：量出容器宽再算缩放。只返回 apply，由调用方在把 scaler 挂进
   文档之后统一观察 stage：观察 scaler 自己会在回调里改它高度、触发下一轮通知
   （控制台会报 ResizeObserver loop），观察父级 stage 就不会自激。 */
export function layoutSlideFit(scaler, inner, stageW, stageH) {
  const apply = () => {
    const cw = scaler.clientWidth;
    if (!cw) return;
    const scale = cw / stageW;
    inner.style.transform = `scale(${scale})`;
    const h = stageH * scale;
    if (Math.abs((parseFloat(scaler.style.height) || 0) - h) > 0.5) {
      scaler.style.height = h + "px";
    }
  };
  apply();
  return apply;
}

export function renderPptx(scroller, doc, state) {
  const { slides, sldSz } = doc;
  const n = slides.length;
  let current = 0;

  const toolbar = document.createElement("div");
  toolbar.className = "canvas-file-pptx-bar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "canvas-file-pptx-nav";
  prev.textContent = "‹";
  const counter = document.createElement("span");
  counter.className = "canvas-file-pptx-count";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "canvas-file-pptx-nav";
  next.textContent = "›";
  toolbar.append(prev, counter, next);

  const stage = document.createElement("div");
  stage.className = "canvas-file-pptx-stage";
  /* 幻灯片比卡片高时舞台能滚：滚到哪儿记在这块自己身上 */
  stage.dataset.scrollKey = "pptx:stage";

  const thumbs = document.createElement("div");
  thumbs.className = "canvas-file-pptx-thumbs";

  const built = slides.map((slide) => {
    const main = buildSlideNode(slide, sldSz, null);
    main.apply = layoutSlideFit(main.scaler, main.inner, main.stageW, main.stageH);
    const thumb = buildSlideNode(slide, sldSz, PPTX_THUMB_W);
    thumb.scaler.classList.add("canvas-file-pptx-thumb");
    return { main, thumb };
  });

  function show(i) {
    current = (i + n) % n;
    built.forEach((b, idx) => {
      b.main.scaler.hidden = idx !== current;
      b.thumb.scaler.classList.toggle("is-active", idx === current);
    });
    built[current].main.apply(); /* 主动算一次：隐藏→显示不一定触发 ResizeObserver */
    counter.textContent = `第 ${current + 1} / ${n} 张`;
    /* 舞台换页就是换了一份内容：键名跟着页码走，每页各记各的滚动位置。
       缩略图条不记：它的横向位置是 scrollIntoView 按当前页推出来的，
       记下来反而会跟这一下互相打架 */
    setScrollKey(stage, `pptx:stage:${current}`);
    const activeThumb = thumbs.children[current];
    if (activeThumb && activeThumb.scrollIntoView) {
      activeThumb.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  prev.addEventListener("click", () => show(current - 1));
  next.addEventListener("click", () => show(current + 1));
  stopOnCard(prev);
  stopOnCard(next);

  built.forEach((b, idx) => {
    stopOnCard(b.thumb.scaler);
    b.thumb.scaler.addEventListener("click", () => show(idx));
    stage.append(b.main.scaler);
    thumbs.append(b.thumb.scaler);
  });

  scroller.append(toolbar, stage, thumbs);
  show(0);

  /* 一个观察者盯住 stage：卡片被拉宽/拉高时只重算当前这页，不会因为改 scaler 高度而自激 */
  if (typeof ResizeObserver !== "undefined") {
    stage.__ro = new ResizeObserver(() => built[current].main.apply());
    stage.__ro.observe(stage);
  }
}

/* 小工具：XML 解析（容错）、按 localName 取元素、路径规整、媒体取 blob URL */
export function parseXml(text) {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc && doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  } catch {
    return null;
  }
}
export function firstByLocal(node, local) {
  if (!node) return null;
  const els = node.getElementsByTagNameNS("*", local);
  return els.length ? els[0] : null;
}
export function childrenByLocal(node, local) {
  const out = [];
  if (!node) return out;
  for (const c of node.children) if (c.localName === local) out.push(c);
  return out;
}
export function descendantByLocal(node, local) {
  if (!node) return null;
  const els = node.getElementsByTagNameNS("*", local);
  return els.length ? els[0] : null;
}
export function readXfrm(el) {
  const xfrm = firstByLocal(el, "xfrm");
  if (!xfrm) return null;
  const off = firstByLocal(xfrm, "off");
  const ext = firstByLocal(xfrm, "ext");
  const chOff = firstByLocal(xfrm, "chOff");
  const chExt = firstByLocal(xfrm, "chExt");
  return {
    offX: off ? parseInt(off.getAttribute("x") || "0", 10) : 0,
    offY: off ? parseInt(off.getAttribute("y") || "0", 10) : 0,
    extCx: ext ? parseInt(ext.getAttribute("cx") || "0", 10) : 0,
    extCy: ext ? parseInt(ext.getAttribute("cy") || "0", 10) : 0,
    chOffX: chOff ? parseInt(chOff.getAttribute("x") || "0", 10) : 0,
    chOffY: chOff ? parseInt(chOff.getAttribute("y") || "0", 10) : 0,
    chExtCx: chExt ? parseInt(chExt.getAttribute("cx") || "0", 10) : 0,
    chExtCy: chExt ? parseInt(chExt.getAttribute("cy") || "0", 10) : 0,
  };
}
export function pptxNumSuffix(name) {
  const m = name.match(/(\d+)\.xml$/i);
  return m ? parseInt(m[1], 10) : 0;
}
export function pptxResolveTarget(baseDir, target) {
  const parts = (baseDir + target).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}
async function getMediaUrl(zip, mediaPath, cache) {
  const key = mediaPath.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let url = "";
  const f = zip.file(mediaPath);
  if (f) {
    try {
      url = URL.createObjectURL(await f.async("blob"));
    } catch {
      url = "";
    }
  }
  cache.set(key, url);
  return url;
}

export function failPptx(state, scroller, error) {
  const message = error && error.message ? error.message : String(error);
  state.className = "canvas-file-pptx-state is-failed";
  state.textContent = message;
  state.hidden = false;
  scroller.hidden = true;
}

/* RFC 4180 那套：双引号包字段、"" 是一个引号、引号里可以带换行。
   引号没闭合就返回 null，让调用方退回纯文本显示，别硬凑一张错位的表。 */
