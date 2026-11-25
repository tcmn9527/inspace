/* canvas-items/scroll-memory.js —— 面板里内容滚动条的记忆
   面板（块）里的正文常常比面板高，里头自带一条滚动条。以前滚到哪儿只活在内存里：
   切走再切回来、或者重开软件，正文又回到最上面。

   这里把位置记在块自己身上（item.scrolls[区域名] = {x, y}），跟块一起落盘到
   items.json：下次打开还停在上次读到的那一段。

   记的是「滚过的比例」而不是具体像素：面板被拉宽拉窄、正文重新排版之后，
   同一个比例依然落在大致同一段内容上。

   哪些区域算「内容滚动条」，由各处 DOM 上标的 data-scroll-key 决定：
   记和放都在这儿统一办，各面板只要标个名字就行。 */

import { findItem, scheduleItemsSave } from "../canvas.js";

/* 滚动停下来才落盘，不在滚动的每一帧都反复排队存盘 */
const SAVE_DELAY = 240;
/* 内容是异步进来的（文档在解析、图片在加载、书页在排版）：
   放位置要等它真能滚了，最多等这么久 */
const RESTORE_MS = 12000;
/* 可滚长度多久没变过了就算稳了，收工 */
const STABLE_MS = 400;
/* 程序化挪动滚动条（换章归零之类）之后的一小段时间：这一下不算「人滚了」 */
const SILENT_MS = 150;
/* 键盘能滚动正文的那些键：按到它们就算人自己在滚，别再往回拽 */
const NAV_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/* 每个滚动区自己的小账本 */
const regions = new WeakMap();

function stateOf(el) {
  let st = regions.get(el);
  if (!st) {
    st = {
      token: 0,
      applied: null,
      restoring: false,
      userMoved: false,
      silentUntil: 0,
      timer: 0,
      frac: null,
      key: "",
    };
    regions.set(el, st);
  }
  return st;
}

/* 这个滚动区此刻滚到了百分之多少 */
function fractionOf(el) {
  /* 看不见的区域量不准（视口是 0 时算出来的比例是拿整份内容高去乘的），
     这种位置记下来反而会跳到莫名其妙的地方，不记 */
  if (el.clientHeight <= 0 && el.clientWidth <= 0) return null;
  const spanY = el.scrollHeight - el.clientHeight;
  const spanX = el.scrollWidth - el.clientWidth;
  return {
    x: spanX > 4 ? Math.min(1, Math.max(0, el.scrollLeft / spanX)) : 0,
    y: spanY > 4 ? Math.min(1, Math.max(0, el.scrollTop / spanY)) : 0,
  };
}

/* 区域自己报上来的键名：电子书按章记、表格按表记，各记各的一份 */
function keyOfRegion(region) {
  return region.dataset.scrollKey || "";
}

/* 这个区域属于哪一块：块上带着自己的 id */
function idOfRegion(region) {
  return region.closest?.(".canvas-item")?.dataset?.id || "";
}

/* 装一次就够：画布里所有标了 data-scroll-key 的区域都归它管 */
export function initScrollMemory(world) {
  if (!world || world.__scrollMemoryReady) return;
  world.__scrollMemoryReady = true;
  /* scroll 事件不冒泡，只有捕获阶段能听见 */
  world.addEventListener("scroll", onScroll, true);
  /* 人自己动了这个区域：正在等的恢复就别再拽回去 */
  world.addEventListener("wheel", onUserIntent, { capture: true, passive: true });
  world.addEventListener("keydown", onKeyDown, { capture: true });
  world.addEventListener("pointerdown", onPointerDown, { capture: true });
}

/* 滚轮：说明人想看这一段，别跟人抢 */
function onUserIntent(event) {
  const region = event.target?.closest?.("[data-scroll-key]");
  if (region) stateOf(region).userMoved = true;
}

/* 键盘翻页：同上 */
function onKeyDown(event) {
  if (!NAV_KEYS.has(event.key)) return;
  const region = event.target?.closest?.("[data-scroll-key]");
  if (region) stateOf(region).userMoved = true;
}

/* 按在滚动条上拖：也算人自己在滚。
   按在内容里选字不算——那只是选中文字，不该把恢复打断。 */
function onPointerDown(event) {
  const region = event.target?.closest?.("[data-scroll-key]");
  if (!region) return;
  const st = stateOf(region);
  if (event.pointerType === "touch") {
    st.userMoved = true;
    return;
  }
  if (event.target !== region) return;
  const onBar = event.offsetX > region.clientWidth || event.offsetY > region.clientHeight;
  if (onBar) st.userMoved = true;
}

function onScroll(event) {
  const region = event.target;
  if (!region || !region.dataset || !region.dataset.scrollKey) return;
  const st = stateOf(region);
  /* 程序化挪的那一下不算 */
  if (performance.now() < st.silentUntil) return;
  /* 自己放回去的那一下不算「人滚到了哪儿」 */
  if (st.applied && Math.abs(region.scrollTop - st.applied.y) <= 1 && Math.abs(region.scrollLeft - st.applied.x) <= 1) {
    if (st.restoring) st.applied = { x: region.scrollLeft, y: region.scrollTop };
    return;
  }
  /* 恢复中却滚到了别处：这是人在滚，不是程序放的。
     交给人——记下这个位置，也让恢复停下，别把人往回拽。
     （恢复的尾巴有几百毫秒的稳定判定，这段时间里人一动就得立刻让位） */
  st.userMoved = true;
  if (st.restoring) {
    endRestore(st);
    st.token += 1;
  }
  st.frac = fractionOf(region);
  /* 量不出位置就别记：宁可留着上次的位置，也别写一个错的 */
  if (!st.frac) return;
  /* 键名在这一刻抓下来：区域名是会变的（翻章换表），
     迟一步再取就可能把这一章的位置记到下一章名下 */
  st.key = keyOfRegion(region);
  scheduleRecord(region, st);
}

/* 滚动停下来才写：写在每一帧里会拖慢落盘 */
function scheduleRecord(region, st) {
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = 0;
    recordScroll(region, st);
  }, SAVE_DELAY);
}

function recordScroll(region, st) {
  const id = idOfRegion(region);
  const item = id ? findItem(id) : null;
  const frac = st.frac;
  const key = st.key;
  if (!item || !frac || !key) return;
  const scrolls = { ...(item.scrolls || {}) };
  const prev = scrolls[key];
  if (prev && Math.abs(prev.x - frac.x) < 0.001 && Math.abs(prev.y - frac.y) < 0.001) return;
  /* 滚回顶上了：这个位置不用记，留着旧的反而会跳回去 */
  if (frac.x <= 0.001 && frac.y <= 0.001) delete scrolls[key];
  else scrolls[key] = frac;
  item.scrolls = scrolls;
  scheduleItemsSave();
}

/* 把这个块里各滚动区放回上次的位置 */
export function restoreScrollMemory(root) {
  if (!root) return;
  const list = [];
  if (root.dataset && root.dataset.scrollKey) list.push(root);
  for (const el of root.querySelectorAll("[data-scroll-key]")) list.push(el);
  for (const region of list) restoreRegion(region);
}

/* 区域后来才建出来（正文懒挂载、书页排完版）：再放一次 */
export function watchScrollRegion(region) {
  if (region) restoreRegion(region);
}

/* 换一份内容（翻章、换表）：键名跟着换，位置按新键记 */
export function setScrollKey(region, key) {
  if (!region) return;
  region.dataset.scrollKey = key || "";
  /* 换了内容就是另一段东西了：接管标记要清掉，
     否则新内容刚挂上就因为「人接管过」而不给恢复位置 */
  stateOf(region).userMoved = false;
  restoreRegion(region);
}

function restoreRegion(region) {
  const key = keyOfRegion(region);
  const id = idOfRegion(region);
  const st = stateOf(region);
  /* 人之前已经接管过这块：这次别再自动挪他的位置。
     （正文懒挂载、书页排版，都会一连叫好几次恢复，
       不看这个标记的话，用户刚滚到的地方会被拽回旧位置） */
  if (st.userMoved) {
    /* 上一次那轮恢复还在跑的话，先让它停：它还在往同一个地方放位置，
       跟「人已经接管了」打架 */
    st.token += 1;
    endRestore(st);
    return;
  }
  st.token += 1;
  const token = st.token;
  const item = id ? findItem(id) : null;
  const saved = item?.scrolls?.[key];
  if (!saved) {
    /* 没有记过：回到顶上。换表换章时旧位置没有意义，先归零。 */
    endRestore(st);
    markScrollSilent(region);
    if (region.scrollTop) region.scrollTop = 0;
    if (region.scrollLeft) region.scrollLeft = 0;
    return;
  }
  st.restoring = true;
  const start = performance.now();
  let lastSpan = -1;
  let stableSince = 0;
  const loop = () => {
    if (st.token !== token) return;
    /* 人自己滚过了：别拽回去 */
    if (st.userMoved) {
      endRestore(st);
      return;
    }
    /* 这块已经被删了：别再对着空气放位置 */
    if (id && !findItem(id)) {
      endRestore(st);
      return;
    }
    const spanY = region.scrollHeight - region.clientHeight;
    const spanX = region.scrollWidth - region.clientWidth;
    const span = Math.max(spanY, spanX);
    /* 视口是 0 说明这块还看不见（正文还没挂上、表格还没显示）：
       这时候算出来的比例是错的（拿整份内容高去乘，位置会偏到中间去），
       不放，等它真的能滚了再说 */
    if (region.clientHeight > 0 && span > 4) {
      applyFraction(region, saved, st);
      /* 可滚长度变了就是内容还在长，接着等 */
      if (span !== lastSpan) {
        lastSpan = span;
        stableSince = performance.now();
      } else if (performance.now() - stableSince > STABLE_MS) {
        endRestore(st);
        return;
      }
    }
    if (performance.now() - start > RESTORE_MS) {
      endRestore(st);
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function applyFraction(region, saved, st) {
  /* 视口是 0 就是还看不见：这时候没有真正的滚动条，放了也是错的 */
  if (region.clientHeight <= 0 && region.clientWidth <= 0) return;
  const spanY = region.scrollHeight - region.clientHeight;
  const spanX = region.scrollWidth - region.clientWidth;
  if (spanY > 4 && saved.y > 0) {
    const y = saved.y >= 0.999 ? spanY : Math.round(spanY * saved.y);
    if (Math.abs(region.scrollTop - y) > 1) region.scrollTop = y;
  }
  if (spanX > 4 && saved.x > 0) {
    const x = saved.x >= 0.999 ? spanX : Math.round(spanX * saved.x);
    if (Math.abs(region.scrollLeft - x) > 1) region.scrollLeft = x;
  }
  /* 记下这一下落在哪：随后的 scroll 事件靠它认出「这是程序放的，不是人滚的」。
     写完再读回来，因为浏览器可能把值夹在合法范围内 */
  st.applied = { x: region.scrollLeft, y: region.scrollTop };
}

/* 恢复收工：把「程序放的」这层标记也撤掉。
   留着的话，用户随后轻轻滚一两像素会被误认成程序放的，位置就记不下来了。 */
function endRestore(st) {
  st.restoring = false;
  st.applied = null;
}

/* 程序化挪动滚动条时先说一句：这一下不算「人滚到了哪儿」 */
export function markScrollSilent(region) {
  if (region) stateOf(region).silentUntil = performance.now() + SILENT_MS;
}
