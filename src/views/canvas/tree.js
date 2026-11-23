/* 从 canvas.js 拆出：tree */

import { LOCK_BADGE_SVG, active, agentDeleteSpace, agentHighlight, agentRevealBlock, commitEditing, confirmDialog, current, edgeLabelEditor, editingId, exportTreeSpace, findItem, flushBlockContents, flushCamera, flushItems, genInputItems, genModeFor, importIntoGroup, insideBox, isContainer, itemBounds, itemEls, itemMenuEntries, loadList, openMenu, ownedByContainer, promptDialog, scheduleCulling, scheduleItemsSave, select, selectedIds, setLockedMany, showError, startTreeRename, store, switchTo, treeRenaming } from "../canvas.js";
import { pageWidthMenuFlow } from "./page-width.js";

/* ---------- 左侧画布树 ---------- */

/* 右键谁，谁就保持悬停底色，直到菜单收起；换右键对象时旧的撤掉 */
export function markTreeContext(row) {
  for (const el of document.querySelectorAll(".space-tree-row.is-context")) {
    el.classList.remove("is-context");
  }
  row.classList.add("is-context");
}

document.addEventListener("inspace:menu-closed", () => {
  for (const el of document.querySelectorAll(".space-tree-row.is-context")) {
    el.classList.remove("is-context");
  }
});

export const TREE_KEY = "workbench.spaceTree";
export let treeUi = null;
export let treeData = [];
export let treeCollapsed = new Set();
export function setTreeCollapsed(value) { treeCollapsed = value; }
export let treePanelCollapsed = new Set();
export let treeSections = { canvas: true, panels: true };
export let treeOrder = {};
export let treeWidth = 220;
/* 画布区固定高度（px）；null = 按内容自适应、最多占一半。拖分隔条后才有值 */
export let treeSplit = null;
export function setTreeSplit(value) { treeSplit = value; }

export function treeSavePrefs() {
  localStorage.setItem(TREE_KEY, JSON.stringify({
    width: treeWidth,
    hidden: treeUi ? treeUi.aside.hidden : false,
    collapsed: [...treeCollapsed],
    panelCollapsed: [...treePanelCollapsed],
    sections: treeSections,
    order: treeOrder,
    split: treeSplit,
  }));
}

export function initSpaceTree() {
  treeUi = {
    aside: document.querySelector("#space-tree"),
    body: document.querySelector("#space-tree-body"),
    hide: document.querySelector("#space-tree-hide"),
    resize: document.querySelector("#space-tree-resize"),
  };
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(TREE_KEY) || "{}");
  } catch { /* 坏掉的偏好按默认来 */ }
  const width = Math.min(420, Math.max(160, Number(prefs.width) || 220));
  treeWidth = width;
  treeUi.aside.style.width = `${width}px`;
  treeCollapsed = new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed : []);
  treePanelCollapsed = new Set(Array.isArray(prefs.panelCollapsed) ? prefs.panelCollapsed : []);
  if (prefs.order && typeof prefs.order === "object") treeOrder = prefs.order;
  if (prefs.sections && typeof prefs.sections === "object") {
    treeSections = {
      canvas: prefs.sections.canvas !== false,
      panels: prefs.sections.panels !== false,
    };
  }
  if (Number.isFinite(Number(prefs.split)) && Number(prefs.split) > 0) {
    treeSplit = Math.round(Number(prefs.split));
  }
  treeSetHidden(Boolean(prefs.hidden));


  treeUi.hide.addEventListener("click", () => treeSetHidden(!treeUi.aside.hidden));
  treeUi.body.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".space-tree-row")) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY, treeRootEntries(), { label: "画布" });
  });

  treeUi.resize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const handle = treeUi.resize;
    handle.classList.add("is-active");
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = treeUi.aside.offsetWidth;
    const move = (e) => {
      const w = Math.min(420, Math.max(160, startWidth + e.clientX - startX));
      treeWidth = w;
      treeUi.aside.style.width = `${w}px`;
      scheduleCulling();
    };
    const up = () => {
      handle.classList.remove("is-active");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      treeSavePrefs();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

export function treeSetHidden(hidden) {
  if (!treeUi) return;
  treeUi.aside.hidden = hidden;
  /* 收起后整列树都消失，标题栏那颗箭头翻成向右，原地点一下再展开 */
  treeUi.hide.classList.toggle("is-collapsed", hidden);
  treeUi.hide.title = hidden ? "展开画布栏" : "收起画布栏";
  treeUi.hide.setAttribute("aria-label", treeUi.hide.title);
  treeSavePrefs();
  scheduleCulling();
}

export function treeRootEntries() {
  return [
    { label: "新建画布", onClick: () => createFlowIn(null) },
    { label: "新建分组", onClick: () => createGroupFlow(null) },
    "-",
    { label: "导入画布", onClick: () => void importIntoGroup("") },
    /* 根级导出 = 整个 spaces 一次打包成一个 .inspace */
    { label: "导出画布", onClick: () => void exportTreeSpace({ id: "", name: "全部画布" }, true) },
  ];
}

export async function refreshTree() {
  try {
    treeData = await store.canvasTree();
  } catch {
    treeData = [];
  }
  renderTree();
}

/* 扁平的分组清单：复制画布时当目标列表，标签带上父路径才分得清同名分组 */
export function treeGroupList() {
  const out = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes) {
      if (node.type !== "group") continue;
      const label = prefix ? `${prefix} / ${node.name}` : node.name;
      out.push({ id: node.id, label });
      walk(node.children || [], label);
    }
  };
  walk(treeData, "");
  return out;
}

export const TREE_CHEVRON = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* 手动排序：同一父级下的兄弟顺序存偏好，覆盖后端按名字排的默认序 */
export function treeParentKey(id) {
  const i = id.lastIndexOf("/");
  return i < 0 ? "" : id.slice(0, i);
}

export function treeFindGroup(id) {
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type !== "group") continue;
      if (n.id === id) return n;
      const hit = walk(n.children || []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(treeData);
}

export function orderedChildren(kids, parentKey) {
  const ord = treeOrder[parentKey];
  if (!Array.isArray(ord) || !ord.length) return kids;
  const pos = new Map(ord.map((id, i) => [id, i]));
  return [...kids].sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : 1e9;
    const pb = pos.has(b.id) ? pos.get(b.id) : 1e9;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

export function treeSiblings(node) {
  const pk = treeParentKey(node.id);
  const kids = pk ? (treeFindGroup(pk)?.children || []) : treeData;
  return orderedChildren(kids, pk);
}

export function moveTreeNode(node, dir) {
  const sibs = treeSiblings(node);
  const i = sibs.findIndex((x) => x.id === node.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const ids = sibs.map((x) => x.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  treeOrder[treeParentKey(node.id)] = ids;
  treeSavePrefs();
  renderTree();
}

export function treeMoveEntries(node) {
  const sibs = treeSiblings(node);
  const i = sibs.findIndex((x) => x.id === node.id);
  return [
    { label: "向上", disabled: i <= 0, onClick: () => moveTreeNode(node, -1) },
    { label: "向下", disabled: i < 0 || i >= sibs.length - 1, onClick: () => moveTreeNode(node, 1) },
  ];
}

export function renderTree() {
  if (!treeUi) return;
  /* 正在就地改名就别重排：输入框会被排掉，blur 还会误提交一次 */
  if (treeRenaming) return;
  const body = treeUi.body;
  /* 整棵树是重建的，两个滚动区的位置要自己接住：否则每次保存块
     （scheduleItemsSave 顺手调这里）都把面板列表弹回顶部，
     刚滚到选中行又被甩走，看着就像「树不跟着选中走」 */
  const keepScroll = treeScrollOf(body);
  body.textContent = "";
  /* 画布区和面板区各占一块、各自滚动；中间的分隔条可以上下拖，调两边的高度 */
  const canvasPart = document.createElement("div");
  canvasPart.className = "space-tree-part";
  canvasPart.dataset.part = "canvas";
  if (treeSplit) {
    canvasPart.style.height = `${treeSplit}px`;
    canvasPart.classList.add("is-fixed");
  }
  canvasPart.append(treeSectionHeader("canvas"));
  let shown = 0;

  const renderRow = (node, depth) => {
    const isGroup = node.type === "group";
    const row = document.createElement("div");
    row.className = `space-tree-row${isGroup ? " is-group" : ""}`;
    row.dataset.kind = node.type;
    row.dataset.id = node.id;
    row.style.paddingLeft = `${6 + depth * 14 + (isGroup ? 0 : 17)}px`;
    const expanded = !treeCollapsed.has(node.id);
    if (isGroup) {
      const chevron = document.createElement("span");
      chevron.className = `space-tree-chevron${expanded ? " is-open" : ""}`;
      chevron.innerHTML = TREE_CHEVRON;
      row.append(chevron);
    } else if (current?.meta.id === node.id) {
      row.classList.add("is-current");
    }
    const label = document.createElement("span");
    label.className = "space-tree-label";
    label.textContent = node.name;
    label.title = node.name;
    row.append(label);
    row.addEventListener("click", () => {
      if (isGroup) {
        if (treeCollapsed.has(node.id)) treeCollapsed.delete(node.id);
        else treeCollapsed.add(node.id);
        treeSavePrefs();
        renderTree();
      } else {
        void switchTo(node.id);
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markTreeContext(row);
      if (isGroup) openTreeGroupMenu(node, event.clientX, event.clientY);
      else openTreeCanvasMenu(node, event.clientX, event.clientY);
    });
    canvasPart.append(row);
    shown += 1;
    if (isGroup && expanded) {
      for (const kid of orderedChildren(node.children || [], node.id)) renderRow(kid, depth + 1);
    }
  };
  if (treeSections.canvas) {
    for (const node of orderedChildren(treeData, "")) renderRow(node, 0);
    if (!shown) {
      const hint = document.createElement("p");
      hint.className = "space-tree-hint";
      hint.textContent = "还没有画布，点「画布」行的 + 新建";
      canvasPart.append(hint);
    }
  }
  body.append(canvasPart);

  const splitter = document.createElement("div");
  splitter.className = "space-tree-splitter";
  splitter.title = "拖动调节上下高度";
  splitter.addEventListener("pointerdown", startTreeSplit);
  body.append(splitter);

  const panelsPart = document.createElement("div");
  panelsPart.className = "space-tree-part";
  panelsPart.dataset.part = "panels";
  panelsPart.append(treeSectionHeader("panels"));
  if (treeSections.panels) renderPanelTree(panelsPart);
  body.append(panelsPart);
  applyTreeScroll(body, keepScroll);
}

/* 重建前/后接住两个滚动区的位置：画布区与面板区各自滚，按 data-part 记 */
function treeScrollOf(body) {
  const out = {};
  for (const part of body?.querySelectorAll(".space-tree-part") || []) {
    out[part.dataset.part] = part.scrollTop;
  }
  return out;
}

function applyTreeScroll(body, saved) {
  if (!saved) return;
  for (const part of body?.querySelectorAll(".space-tree-part") || []) {
    const top = saved[part.dataset.part];
    if (top) part.scrollTop = top;
  }
}

/* 拖分隔条：画布区变成固定高度，面板区吃掉剩下的空间；松手存偏好 */
function startTreeSplit(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const body = treeUi?.body;
  const canvasPart = body?.querySelector('.space-tree-part[data-part="canvas"]');
  if (!body || !canvasPart) return;
  const startY = event.clientY;
  const startH = canvasPart.getBoundingClientRect().height;
  const max = Math.max(88, body.getBoundingClientRect().height - 96);
  treeUi.aside.classList.add("is-splitting");
  const move = (e) => {
    const h = Math.round(Math.min(max, Math.max(52, startH + e.clientY - startY)));
    canvasPart.style.height = `${h}px`;
    canvasPart.classList.add("is-fixed");
    treeSplit = h;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    treeUi?.aside.classList.remove("is-splitting");
    if (treeSplit) treeSavePrefs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/* 分类标题跟着自己的列表走：吸顶在滚动区里，折叠按钮和新建/计数都在这一行 */
export function treeSectionHeader(kind) {
  const isCanvas = kind === "canvas";
  const open = isCanvas ? treeSections.canvas : treeSections.panels;
  const row = document.createElement("div");
  row.className = `space-tree-section${open ? " is-open" : ""}`;
  row.dataset.section = kind;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "space-tree-section-toggle";
  toggle.title = isCanvas ? "收起 / 展开画布" : "收起 / 展开面板";
  toggle.setAttribute("aria-label", toggle.title);
  toggle.innerHTML = TREE_CHEVRON;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isCanvas) treeSections.canvas = !treeSections.canvas;
    else treeSections.panels = !treeSections.panels;
    treeSavePrefs();
    renderTree();
  });
  row.append(toggle);
  const label = document.createElement("span");
  label.className = "space-tree-section-label";
  label.textContent = isCanvas ? "画布" : "面板";
  row.append(label);
  /* 和分组行一样：整行点下去就是展开 / 收起 */
  row.addEventListener("click", () => {
    if (isCanvas) treeSections.canvas = !treeSections.canvas;
    else treeSections.panels = !treeSections.panels;
    treeSavePrefs();
    renderTree();
  });
  if (isCanvas) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "space-tree-btn";
    add.title = "新建";
    add.setAttribute("aria-label", "新建");
    add.setAttribute("aria-haspopup", "true");
    add.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>';
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = add.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, treeRootEntries(), { label: "新建" });
    });
    row.append(add);
  }
  return row;
}

/* ---------- 面板树：当前画布里的块，容器矩形可展开 ---------- */

export const PANEL_TYPE_LABEL = {
  text: "文字",
  rect: "矩形",
  ellipse: "椭圆",
  line: "直线",
  arrow: "箭头",
  note: "笔记",
  picture: "画面",
  gen: "生图面板",
  genvideo: "视频生成",
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
  ebook: "书页",
  product: "产品卡",
  quote: "清单",
  plan: "户型",
  page: "提案页",
  connector: "连线",
};

export const GEN_MODE_TREE_LABEL = {
  t2i: "文生图",
  i2i: "图生图",
  edit: "参考图编辑",
  inpaint: "局部重绘",
};

/* 树上一律「编号 + 类型」；重命名过的用自定义名顶替类型那截 */
export function panelTreeLabel(item) {
  const seq = item.seq ? `#${item.seq} ` : "";
  const custom = (item.treeName || "").trim();
  if (custom) return seq + custom;
  if (item.type === "gen") {
    const mode = genModeFor(item, genInputItems(item).length);
    return seq + (GEN_MODE_TREE_LABEL[mode] || "生图");
  }
  if (item.type === "rect" && isContainer(item)) return seq + "容器";
  if (item.type === "connector") return "连线";
  return seq + (PANEL_TYPE_LABEL[item.type] || item.type);
}

export async function renamePanelTree(item) {
  const fallback = panelTreeLabel(item).replace(/^#\d+\s*/, "");
  const name = await promptDialog({
    title: "重命名面板",
    label: "留空恢复成编号 + 类型",
    value: (item.treeName || "").trim() || fallback,
    okText: "重命名",
    validate: () => null,
  });
  if (name === null || name === undefined) return;
  const trimmed = String(name).trim();
  if (trimmed) item.treeName = trimmed.slice(0, 60);
  else delete item.treeName;
  scheduleItemsSave();
  renderTree();
}

/* 容器框里的块：整块落在框内才算；连线按两端中点落框内算 */
export function treeContainerKids(container) {
  const el = itemEls.get(container.id);
  if (!el || !current) return [];
  const box = itemBounds(container, el);
  const out = [];
  for (const item of current.items) {
    if (item.id === container.id) continue;
    if (item.type === "connector") {
      const a = findItem(item.from?.item);
      const b = findItem(item.to?.item);
      const ae = a && itemEls.get(a.id);
      const be = b && itemEls.get(b.id);
      if (!ae || !be) continue;
      const ab = itemBounds(a, ae);
      const bb = itemBounds(b, be);
      const mx = (ab.x + ab.w / 2 + bb.x + bb.w / 2) / 2;
      const my = (ab.y + ab.h / 2 + bb.y + bb.h / 2) / 2;
      if (mx >= box.x && mx <= box.x + box.w && my >= box.y && my <= box.y + box.h) out.push(item);
      continue;
    }
    const childEl = itemEls.get(item.id);
    if (!childEl) continue;
    if (insideBox(item, box) && ownedByContainer(item, container, box)) out.push(item);
  }
  return out;
}

/* 面板的兄弟 = 同一个容器里的块，或都不在任何容器里的顶层块；取最内层容器 */
export function panelSiblingList(item) {
  const items = current?.items || [];
  const kidsOf = new Map();
  const nested = new Set();
  for (const it of items) {
    if (it.type === "rect" && isContainer(it)) {
      const kids = treeContainerKids(it);
      kidsOf.set(it.id, kids);
      for (const kid of kids) nested.add(kid.id);
    }
  }
  let parent = null;
  let parentArea = Infinity;
  for (const [cid, kids] of kidsOf) {
    if (!kids.some((x) => x.id === item.id)) continue;
    const c = findItem(cid);
    const area = (c?.w || 0) * (c?.h || 0);
    if (area < parentArea) {
      parentArea = area;
      parent = cid;
    }
  }
  return parent ? kidsOf.get(parent) : items.filter((x) => !nested.has(x.id));
}

/* 上下移 = 在 current.items 里和相邻兄弟交换位置，随画布一起存 */
export function movePanelItem(item, dir) {
  const list = panelSiblingList(item);
  const i = list.findIndex((x) => x.id === item.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j];
  const ia = current.items.indexOf(item);
  const ib = current.items.indexOf(other);
  if (ia < 0 || ib < 0) return;
  current.items[ia] = other;
  current.items[ib] = item;
  scheduleItemsSave();
  renderTree();
}

export function panelMoveEntries(item) {
  const list = panelSiblingList(item);
  const i = list.findIndex((x) => x.id === item.id);
  return [
    { label: "向上", disabled: i <= 0, onClick: () => movePanelItem(item, -1) },
    { label: "向下", disabled: i < 0 || i >= list.length - 1, onClick: () => movePanelItem(item, 1) },
  ];
}

export function renderPanelTree(body) {
  const items = current?.items || [];
  if (!items.length) return;
  /* 先算每个容器的孩子，顶层只摆没被任何容器装着的块 */
  const kidsOf = new Map();
  const nested = new Set();
  for (const item of items) {
    if (item.type === "rect" && isContainer(item)) {
      const kids = treeContainerKids(item);
      kidsOf.set(item.id, kids);
      for (const kid of kids) nested.add(kid.id);
    }
  }
  const renderPanelRow = (item, depth, seen) => {
    const isCont = item.type === "rect" && isContainer(item);
    const row = document.createElement("div");
    row.className = "space-tree-row";
    row.dataset.kind = "panel";
    row.dataset.id = item.id;
    row.style.paddingLeft = `${6 + depth * 14 + (isCont ? 0 : 17)}px`;
    if (selectedIds.has(item.id)) row.classList.add("is-selected");
    const expanded = !treePanelCollapsed.has(item.id);
    if (isCont) {
      const chevron = document.createElement("span");
      chevron.className = `space-tree-chevron${expanded ? " is-open" : ""}`;
      chevron.innerHTML = TREE_CHEVRON;
      /* 三角单独管展开/收起：单击它不连带选中这一行 */
      chevron.addEventListener("click", (event) => {
        event.stopPropagation();
        if (treePanelCollapsed.has(item.id)) treePanelCollapsed.delete(item.id);
        else treePanelCollapsed.add(item.id);
        treeSavePrefs();
        renderTree();
      });
      chevron.addEventListener("dblclick", (event) => {
        event.stopPropagation();
      });
      row.append(chevron);
    }
    const label = document.createElement("span");
    label.className = "space-tree-label";
    const text = panelTreeLabel(item);
    label.textContent = text;
    label.title = text;
    row.append(label);
    if (item.locked) {
      const lock = document.createElement("span");
      lock.className = "space-tree-lock";
      lock.title = "已锁定";
      lock.innerHTML = LOCK_BADGE_SVG;
      row.append(lock);
    }
    row.addEventListener("click", () => {
      select(item.id);
      agentRevealBlock(item.id);
      /* 从面板树点选：给画布上那块打一圈 1 秒的光带，锁定块没有常规选中标记，
         靠这一下知道点的是谁；直接在画布上选不走这里，就没有这效果 */
      agentHighlight([item.id], 1000);
      renderTree();
    });
    /* 双击：容器展开/收起；Ctrl+双击：锁定/解锁（和 Ctrl+L 同一套语义） */
    row.addEventListener("dblclick", (event) => {
      const now = findItem(item.id);
      if (!now) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        setLockedMany([now.id], !now.locked);
        renderTree();
        return;
      }
      if (!isCont) return;
      event.preventDefault();
      event.stopPropagation();
      if (treePanelCollapsed.has(now.id)) treePanelCollapsed.delete(now.id);
      else treePanelCollapsed.add(now.id);
      treeSavePrefs();
      renderTree();
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markTreeContext(row);
      openMenu(event.clientX, event.clientY, [
        ...panelMoveEntries(item),
        "-",
        { label: "重命名", onClick: () => void renamePanelTree(item) },
        "-",
        ...itemMenuEntries(item, event.clientX, event.clientY),
      ], { label: text });
    });
    body.append(row);
    if (isCont && expanded && !seen.has(item.id)) {
      seen.add(item.id);
      for (const kid of kidsOf.get(item.id) || []) renderPanelRow(kid, depth + 1, seen);
    }
  };
  const seen = new Set();
  for (const item of items) {
    if (nested.has(item.id)) continue;
    renderPanelRow(item, 0, seen);
  }
}

export function openTreeGroupMenu(node, x, y) {
  const empty = !(node.children || []).length;
  openMenu(x, y, [
    { label: "新建画布", onClick: () => createFlowIn(node.id) },
    { label: "新建子分组", onClick: () => createGroupFlow(node.id) },
    { label: "导入画布", onClick: () => void importIntoGroup(node.id) },
    { label: "导出画布", onClick: () => void exportTreeSpace(node, true) },
    "-",
    ...treeMoveEntries(node),
    "-",
    { label: "重命名", onClick: () => startTreeRename("group", node.id, node.name) },
    { label: "在资源管理器中显示", onClick: () => store.revealGroup(node.id).catch(showError) },
    "-",
    empty
      ? { label: "删除分组", danger: true, onClick: () => deleteGroupFlow(node) }
      : { label: "删除分组（请先清空）", disabled: true },
  ], { label: node.name });
}

export function openTreeCanvasMenu(node, x, y) {
  const targets = [
    { label: "（根目录）", onClick: () => copyCanvasFlow(node.id, "") },
    ...treeGroupList().map((group) => ({
      label: group.label,
      onClick: () => copyCanvasFlow(node.id, group.id),
    })),
  ];
  const width = current?.pageWidth;
  openMenu(x, y, [
    {
      label: "画布尺寸…",
      trailing: width ? `<span class="menu-trailing-text">${Math.round(width)} px</span>` : "",
      onClick: () => void pageWidthMenuFlow(),
    },
    { label: "导出画布", onClick: () => void exportTreeSpace(node, false) },
    "-",
    ...treeMoveEntries(node),
    "-",
    { label: "重命名", onClick: () => startTreeRename("canvas", node.id, node.name) },
    { label: "复制到分组", children: targets },
    { label: "在资源管理器中显示", onClick: () => store.revealCanvas(node.id).catch(showError) },
    "-",
    { label: "删除画布", danger: true, onClick: () => deleteTreeCanvasFlow(node) },
  ], { label: node.name });
}

export async function createFlowIn(parent) {
  const name = await promptDialog({
    title: "新建画布",
    label: "画布名字",
    value: "新画布",
    okText: "创建",
  });
  if (!name) return;
  try {
    const data = await store.createCanvas(name, parent);
    await loadList();
    await switchTo(data.meta.id);
  } catch (error) {
    showError(error);
  }
}

export async function createGroupFlow(parent) {
  const name = await promptDialog({
    title: "新建分组",
    label: "分组名字",
    value: "新分组",
    okText: "创建",
  });
  if (!name) return;
  try {
    const id = await store.createGroup(parent, name);
    /* 新分组要当场看得见：它和它的长辈都展开 */
    treeCollapsed.delete(id);
    let prefix = id;
    while (prefix.includes("/")) {
      prefix = prefix.slice(0, prefix.lastIndexOf("/"));
      treeCollapsed.delete(prefix);
    }
    await loadList();
  } catch (error) {
    showError(error);
  }
}

export async function deleteGroupFlow(node) {
  const ok = await confirmDialog({
    title: "删除分组",
    message: `「${node.name}」会被移到系统回收站。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteGroup(node.id);
    treeCollapsed.delete(node.id);
    await loadList();
  } catch (error) {
    showError(error);
  }
}

export async function deleteTreeCanvasFlow(node) {
  const ok = await confirmDialog({
    title: "删除画布",
    message: `「${node.name}」的整个文件夹会被移到系统回收站，之后仍可找回。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await agentDeleteSpace(node.id);
  } catch (error) {
    showError(error);
  }
}

export async function copyCanvasFlow(id, parent) {
  try {
    if (current?.meta.id === id) {
      if (editingId || edgeLabelEditor) commitEditing();
      await flushBlockContents();
      await flushItems();
      await flushCamera();
    }
    const meta = await store.copyCanvas(id, parent);
    await loadList();
    await switchTo(meta.id);
  } catch (error) {
    showError(error);
  }
}
