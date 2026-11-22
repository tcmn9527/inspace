/* 从 canvas.js 拆出：layout */

import { findItem, isContainer, itemBounds, itemEls, moveMembers, scheduleItemsSave, selectedIds, syncItemElement, updateSelection } from "../canvas.js";
import { clampXToPage } from "./page-width.js";

/* ---------- 批量排版 ---------- */

/* 能参与排版的那几块：选中、有 DOM、没锁。
   锁住的块如果跟着动，那就等于绕过锁定了，所以一律跳过 */
export function editableSelection() {
  const out = [];
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (!item || !el || item.locked) continue;
    out.push({ item, el });
  }
  return out;
}

/* 平移一块。直线和箭头要连终点一起挪，不然框走了线还钉在原地 */
export function shiftItem(item, dx, dy) {
  /* 对齐/分布/整理也会改 x，统一夹回页内 */
  item.x += dx;
  clampXToPage(item);
  item.y += dy;
  if (item.type === "line" || item.type === "arrow") {
    item.x2 += dx;
    item.y2 += dy;
  }
}

export const TIDY_GAP = 32;

export function applyLayout(entries, target) {
  entries.forEach((entry, index) => {
    const to = target(entry, index);
    const dx = to.x - entry.b.x;
    const dy = to.y - entry.b.y;
    if (!dx && !dy) return;
    shiftItem(entry.item, dx, dy);
    syncItemElement(entry.el, entry.item);
  });
  updateSelection();
  scheduleItemsSave();
}

/* 六种对齐：以选区的外接框为基准。bounds 是先算好的一轮，
   边挪边算会让后面的块对角到已经动过的位置上 */
export function alignSelected(mode) {
  const list = editableSelection();
  if (list.length < 2) return;
  const entries = list.map(({ item, el }) => ({ item, el, b: itemBounds(item, el) }));
  const left = Math.min(...entries.map((e) => e.b.x));
  const top = Math.min(...entries.map((e) => e.b.y));
  const right = Math.max(...entries.map((e) => e.b.x + e.b.w));
  const bottom = Math.max(...entries.map((e) => e.b.y + e.b.h));
  applyLayout(entries, (entry) => {
    const b = entry.b;
    if (mode === "left") return { x: left, y: b.y };
    if (mode === "right") return { x: right - b.w, y: b.y };
    if (mode === "center-h") return { x: (left + right) / 2 - b.w / 2, y: b.y };
    if (mode === "top") return { x: b.x, y: top };
    if (mode === "bottom") return { x: b.x, y: bottom - b.h };
    return { x: b.x, y: (top + bottom) / 2 - b.h / 2 };
  });
}

/* 等距分布：首尾两块钉住，中间的按中心点均匀散开。
   用中心而不是左边，是因为大小不一时左边对齐看着更歪 */
export function distributeSelected(axis) {
  const list = editableSelection();
  if (list.length < 3) return;
  const entries = list
    .map(({ item, el }) => ({ item, el, b: itemBounds(item, el) }))
    .sort((a, z) => (axis === "x" ? a.b.x - z.b.x : a.b.y - z.b.y));
  const centerOf = (b) => (axis === "x" ? b.x + b.w / 2 : b.y + b.h / 2);
  const first = centerOf(entries[0].b);
  const last = centerOf(entries[entries.length - 1].b);
  const step = (last - first) / (entries.length - 1);
  applyLayout(entries, (entry, index) => {
    const delta = first + step * index - centerOf(entry.b);
    return axis === "x"
      ? { x: entry.b.x + delta, y: entry.b.y }
      : { x: entry.b.x, y: entry.b.y + delta };
  });
}

/* 整理成网格：按现在的阅读顺序（先上下后左右）重排成接近正方形的阵列。
   AI 批量铺完东西之后最需要这一下——它摆的坐标经常疏密不均 */
export function tidySelected() {
  const list = editableSelection();
  if (list.length < 2) return;
  const entries = list
    .map(({ item, el }) => ({ item, el, b: itemBounds(item, el) }))
    .sort((a, z) => a.b.y - z.b.y || a.b.x - z.b.x);
  const originX = Math.min(...entries.map((e) => e.b.x));
  const originY = Math.min(...entries.map((e) => e.b.y));
  const colW = Math.max(...entries.map((e) => e.b.w)) + TIDY_GAP;
  const rowH = Math.max(...entries.map((e) => e.b.h)) + TIDY_GAP;
  const cols = Math.max(1, Math.round(Math.sqrt(entries.length)));
  applyLayout(entries, (entry, index) => ({
    x: originX + (index % cols) * colW,
    y: originY + Math.floor(index / cols) * rowH,
  }));
}

/* 这一拖要带上的块：单选就它自己，多选把集合里每个都带上，各记各的起点。
   直线/箭头另记 x2/y2，不然框动了线不动。
   拖的是容器（编成分组的矩形）时，框里那些块跟着一起走。 */
export function moveGroup() {
  const group = [];
  const seen = new Set();
  const push = (id, asMember = false) => {
    if (seen.has(id)) return;
    const item = findItem(id);
    const el = itemEls.get(id);
    /* 锁只拦「直接拖它」；容器搬家时框里的锁定块照样跟着走 */
    if (!item || !el || (item.locked && !asMember)) return;
    seen.add(id);
    group.push({ item, el, origin: { x: item.x, y: item.y, x2: item.x2, y2: item.y2 } });
  };
  for (const id of selectedIds) push(id);
  for (const id of selectedIds) {
    const container = findItem(id);
    if (!container || !isContainer(container)) continue;
    for (const child of moveMembers(container, seen)) push(child.id, true);
  }
  return group;
}
