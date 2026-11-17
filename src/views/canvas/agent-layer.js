/* 从 canvas.js 拆出：agent-layer */

import { ratio } from "../canvas-items.js";
import { MAX_SCALE, MIN_SCALE, STORAGE_KEY, active, applyCamera, batching, canvases, clamp, commitEditing, current, edgeLabelEditor, editingId, findItem, flushBlockContents, flushCamera, flushItems, genFeedOf, genRunOf, insertPoint, itemBounds, itemEls, loadList, renameTreeGroup, renderAll, replaceSelection, scenePlacementActive, scheduleCameraSave, selectedIds, setCurrent, showEmpty, store, switchTo, treeCollapsed, treeData, treeGroupList, ui } from "../canvas.js";

/* ---------- MCP / agent 动作层 ----------
   菜单、工具栏、拖拽里的动作在这里收成一组不带界面的函数：参数是普通对象，
   返回块摘要或状态。MCP 工具从这里走，和用户点菜单共用同一套落盘与校验。 */

export let cameraAnim = null;
export const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
export const agentSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function agentRequireSpace() {
  if (!current) throw new Error("当前没有打开的画布");
  return current;
}

export function agentRequireItem(id) {
  const item = findItem(String(id));
  if (!item) throw new Error(`找不到块 ${id}`);
  return item;
}

export function agentBounds(item) {
  const bounds = itemBounds(item, itemEls.get(item.id));
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    w: Math.round(bounds.w),
    h: Math.round(bounds.h),
  };
}

/* 给 agent 看的块摘要：几何、样式和内容规模都带上，正文另用专用工具取 */
export function agentSummary(item) {
  /* 连线自己没有坐标，包围盒只对块算 */
  const base = {
    id: item.id,
    seq: item.seq || null,
    type: item.type,
    z: Number.isFinite(item.z) ? item.z : null,
    locked: Boolean(item.locked),
  };
  if (item.type !== "connector") Object.assign(base, agentBounds(item), { internal: item.internal });
  if (item.type === "connector") {
    return {
      ...base,
      from: item.from,
      to: item.to,
      shape: item.shape,
      arrow: item.arrow,
      color: item.color,
      label: item.label || "",
      bend: Boolean(item.bend),
      points: (item.points || []).map((point) => ({
        x: Math.round(point.x),
        y: Math.round(point.y),
      })),
    };
  }
  if (item.type === "text") {
    return {
      ...base,
      text: item.text,
      color: item.color,
      fontSize: item.fontSize,
      align: item.align || "left",
      vAlign: item.vAlign || "top",
      fillColor: item.fillColor,
      borderColor: item.borderColor,
      bordered: item.bordered,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "rect" || item.type === "ellipse") {
    return {
      ...base,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "line" || item.type === "arrow") {
    return { ...base, x2: item.x2, y2: item.y2, borderColor: item.borderColor };
  }
  if (item.type === "picture") {
    return {
      ...base,
      cmds: Array.isArray(item.cmds) ? item.cmds.length : 0,
      hidden: Array.isArray(item.hidden) ? item.hidden : [],
      light: item.light || null,
      paperColor: item.paperColor || "",
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "scene") {
    return {
      ...base,
      /* 件数报成一个数，和画面块报 cmds 条数同一个口径：整份 parts 塞进摘要会把 space_scene 撑爆 */
      parts: Array.isArray(item.parts) ? item.parts.length : 0,
      surfaces: item.surfaces,
      placement: scenePlacementActive(item),
      camera: item.camera || null,
      light: item.light || null,
      groundColor: item.groundColor || "",
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "product") {
    return {
      ...base,
      name: item.name,
      brand: item.brand,
      sku: item.sku,
      spec: item.spec,
      price: item.price,
      qty: item.qty,
      source: item.source,
      note: item.note,
      src: item.src,
      model: item.model,
      dims: item.dims,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "quote") {
    const products = current ? current.items.filter((one) => one.type === "product") : [];
    return {
      ...base,
      title: item.title,
      count: products.length,
      total: products.reduce((sum, one) => sum + one.price * one.qty, 0),
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "plan") {
    return {
      ...base,
      imageW: item.imageW,
      imageH: item.imageH,
      calibration: item.calibration,
      footprints: item.footprints,
      cameras: item.cameras,
      areas: item.areas,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "page") {
    return {
      ...base,
      title: item.title,
      ratio: item.ratio,
      order: item.order,
    };
  }
  if (item.type === "gen") {
    /* 这一轮的相位在这儿一并报：等一张图的时候 agent 得问得出「还在跑」 */
    const run = genRunOf(item.id);
    const feed = genFeedOf(item);
    return {
      ...base,
      prompt: item.prompt || "",
      negative: item.negative || "",
      imageW: item.imageW,
      imageH: item.imageH,
      steps: item.steps,
      cfg: item.cfg,
      seed: item.seed,
      /* 出图那一档：mode 是块上写的（auto=看连线），feed 是这次真会走的 */
      mode: item.mode || "auto",
      strength: item.strength,
      feed,
      src: item.src || "",
      phase: run.phase,
      step: run.step,
      seconds: run.phase === "idle" ? run.seconds : 0,
      error: run.phase === "failed" ? run.error || "" : "",
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "note") {
    return {
      ...base,
      name: item.name,
      linked: item.linked,
      path: item.path || "",
      chars: (item.source || "").length,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "file") {
    return {
      ...base,
      name: item.name,
      ext: item.ext,
      linked: item.linked,
      src: item.src,
      page: item.page || 1,
      pageFrac: item.pageFrac || 0,
      borderColor: item.borderColor,
      fillColor: item.fillColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "ebook") {
    return { ...base, name: item.name, linked: item.linked, chapter: item.chapter };
  }
  if (item.type === "image") {
    return {
      ...base,
      src: item.src,
      linked: item.linked,
      borderColor: item.borderColor,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "audio" || item.type === "video") {
    return { ...base, name: item.name, src: item.src, linked: item.linked };
  }
  return base;
}

/* 演示用的光带：只加一圈外发光，不动块自己的颜色和尺寸 */
/* 批量模式：agent 一次提交一串操作时打开。
   这期间不运镜、不打光带——一个块一次镜头跳动，看的人只会晕。 */

export function agentHighlight(ids, ms = 900) {
  /* 批量里每一项都打一圈光带只是噪音：等整批做完再说 */
  if (batching) return;
  for (const raw of ids) {
    const id = String(raw);
    const el = itemEls.get(id);
    if (!el) continue;
    el.classList.add("is-agent-target");
    clearTimeout(el.__agentGlow);
    el.__agentGlow = setTimeout(() => el.classList.remove("is-agent-target"), ms);
  }
}

export function agentStopCameraAnim() {
  if (!cameraAnim) return;
  cancelAnimationFrame(cameraAnim.raf);
  cameraAnim.cleanup();
  cameraAnim = null;
}

/* 相机移动给用户看：用户自己一碰鼠标或键盘就把镜头还给他，不硬拽 */
export function agentAnimateCamera(target, duration = 420) {
  if (!current) return;
  agentStopCameraAnim();
  const start = { ...current.camera };
  const began = performance.now();
  const onUser = () => agentStopCameraAnim();
  window.addEventListener("pointerdown", onUser, true);
  window.addEventListener("keydown", onUser, true);
  const cleanup = () => {
    window.removeEventListener("pointerdown", onUser, true);
    window.removeEventListener("keydown", onUser, true);
  };
  const step = (now) => {
    const t = Math.min(1, (now - began) / duration);
    const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    current.camera.x = start.x + (target.x - start.x) * k;
    current.camera.y = start.y + (target.y - start.y) * k;
    current.camera.scale = start.scale + (target.scale - start.scale) * k;
    applyCamera();
    if (t < 1) {
      cameraAnim = { raf: requestAnimationFrame(step), cleanup };
    } else {
      cleanup();
      cameraAnim = null;
      scheduleCameraSave();
    }
  };
  cameraAnim = { raf: requestAnimationFrame(step), cleanup };
}

export function agentCameraState() {
  return current
    ? { x: Math.round(current.camera.x), y: Math.round(current.camera.y), scale: Number(current.camera.scale.toFixed(3)) }
    : null;
}

export function agentFocusBlock(id, patch = {}) {
  agentRequireSpace();
  const item = agentRequireItem(id);
  const bounds = agentBounds(item);
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const zoom = patch.zoom == null ? current.camera.scale : clamp(Number(patch.zoom), MIN_SCALE, MAX_SCALE);
  const target = {
    scale: zoom,
    x: vw / 2 - (bounds.x + bounds.w / 2) * zoom,
    y: vh / 2 - (bounds.y + bounds.h / 2) * zoom,
  };
  agentAnimateCamera(target, 360);
  return { camera: agentCameraState() };
}

/* 新块落在视野外时把镜头带过去；本来就在眼前就不动，免得用户明明看得见还给他跳一下 */
export function agentRevealBlock(id) {
  /* 批量铺东西时镜头不该跟着每个块跳：整批完成后用户自己看一眼就够 */
  if (batching) return false;
  const item = findItem(String(id));
  if (!item || item.type === "connector") return false;
  const bounds = agentBounds(item);
  const scale = current.camera.scale;
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const left = bounds.x * scale + current.camera.x;
  const top = bounds.y * scale + current.camera.y;
  const margin = 40;
  const inView =
    left >= margin &&
    top >= margin &&
    left + bounds.w * scale <= vw - margin &&
    top + bounds.h * scale <= vh - margin;
  if (inView) return false;
  agentAnimateCamera(
    {
      scale,
      x: vw / 2 - (bounds.x + bounds.w / 2) * scale,
      y: vh / 2 - (bounds.y + bounds.h / 2) * scale,
    },
    360,
  );
  return true;
}

export function agentFitView() {
  agentRequireSpace();
  const blocks = current.items.filter((item) => item.type !== "connector");
  if (!blocks.length) return { camera: agentCameraState() };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of blocks) {
    const bounds = agentBounds(item);
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.w);
    bottom = Math.max(bottom, bounds.y + bounds.h);
  }
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const pad = 80;
  const scale = clamp(Math.min((vw - pad * 2) / w, (vh - pad * 2) / h), MIN_SCALE, MAX_SCALE);
  const target = {
    scale,
    x: vw / 2 - (left + w / 2) * scale,
    y: vh / 2 - (top + h / 2) * scale,
  };
  agentAnimateCamera(target, 480);
  return { camera: { x: Math.round(target.x), y: Math.round(target.y), scale: Number(scale.toFixed(3)) }, bounds: { x: Math.round(left), y: Math.round(top), w: Math.round(w), h: Math.round(h) } };
}

export async function agentFindSpace(ref) {
  await loadList();
  const key = String(ref ?? "").trim();
  /* 先按 id 精确匹配，再按名字兜底：复制出来的画布和原画布同名，
     若混在一次 find 里，名字命中会抢在 id 前面，删/开都会落到重名的那份上 */
  const target =
    canvases.find((meta) => meta.id === key) ||
    canvases.find((meta) => meta.name === key);
  if (!target) throw new Error(`找不到画布「${key}」`);
  return target;
}

export async function agentSpaceList() {
  await loadList();
  return {
    current: current ? { id: current.meta.id, name: current.meta.name } : null,
    spaces: canvases.map((meta) => ({ id: meta.id, name: meta.name, path: meta.path || "" })),
  };
}

export async function agentOpenSpace(ref) {
  const target = await agentFindSpace(ref);
  if (!active) {
    window.dispatchEvent(new CustomEvent("inspace:route", { detail: "canvas" }));
    await agentSleep(250);
  }
  await switchTo(target.id);
  if (!current || current.meta.id !== target.id) throw new Error(`打开画布「${target.name}」失败`);
  return { space: { id: current.meta.id, name: current.meta.name }, blocks: current.items.length };
}

export async function agentCreateSpace(name, parent) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("画布名不能为空");
  const parentId = parent && String(parent).trim() ? (await agentFindGroup(parent)).id : null;
  const data = await store.createCanvas(clean, parentId);
  const meta = data?.meta;
  if (!meta) throw new Error("画布建好了，但没拿到它的信息");
  await loadList();
  if (active) await switchTo(meta.id);
  return { id: meta.id, name: meta.name, opened: Boolean(current && current.meta.id === meta.id) };
}

/* 分组引用：id（相对路径）优先；名字只在唯一时才认，同名分组必须给 id */
export async function agentFindGroup(ref) {
  await loadList();
  const key = String(ref ?? "").trim();
  const groups = treeGroupList();
  const byId = groups.find((group) => group.id === key);
  if (byId) return byId;
  const matches = groups.filter((group) => group.id.split("/").pop() === key);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`有多个分组叫「${key}」，请传 id（相对路径）`);
  throw new Error(`找不到分组「${key}」`);
}

export async function agentSpaceTree() {
  await loadList();
  return { current: current?.meta.id || null, tree: treeData };
}

export async function agentGroupCreate(parent, name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("分组名不能为空");
  const parentId = parent && String(parent).trim() ? (await agentFindGroup(parent)).id : "";
  const id = await store.createGroup(parentId, clean);
  treeCollapsed.delete(id);
  await loadList();
  return { id };
}

export async function agentGroupRename(ref, name) {
  const target = await agentFindGroup(ref);
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("新名字不能为空");
  const id = await renameTreeGroup(target.id, clean);
  return { id };
}

export async function agentGroupDelete(ref) {
  const target = await agentFindGroup(ref);
  await store.deleteGroup(target.id);
  treeCollapsed.delete(target.id);
  await loadList();
  return { deleted: { id: target.id } };
}

export async function agentSpaceCopy(ref, parent) {
  const target = await agentFindSpace(ref);
  const parentId = parent && String(parent).trim() ? (await agentFindGroup(parent)).id : "";
  if (current?.meta.id === target.id) {
    if (editingId || edgeLabelEditor) commitEditing();
    await flushBlockContents();
    await flushItems();
    await flushCamera();
  }
  const meta = await store.copyCanvas(target.id, parentId);
  await loadList();
  if (active) await switchTo(meta.id);
  return { id: meta.id, name: meta.name, opened: Boolean(current && current.meta.id === meta.id) };
}

export async function agentRenameSpace(ref, newName) {
  const target = await agentFindSpace(ref);
  const clean = String(newName ?? "").trim();
  if (!clean) throw new Error("新名字不能为空");
  const mine = current && current.meta.id === target.id;
  if (mine) {
    if (editingId || edgeLabelEditor) commitEditing();
    await flushBlockContents();
    await flushItems();
    await flushCamera();
    setCurrent(null);
  }
  let meta;
  try {
    meta = await store.renameCanvas(target.id, clean);
  } catch (error) {
    /* 改名没成：把刚才放下的画布重新打开，别让界面停在无画布的样子 */
    if (mine) {
      await loadList();
      if (canvases.some((entry) => entry.id === target.id)) await switchTo(target.id);
    }
    throw error;
  }
  await loadList();
  if (mine && meta) await switchTo(meta.id);
  return { id: meta?.id || "", name: meta?.name || clean };
}

export async function agentDeleteSpace(ref) {
  const target = await agentFindSpace(ref);
  const mine = current && current.meta.id === target.id;
  if (mine) {
    if (editingId || edgeLabelEditor) commitEditing();
    /* 删除前把防抖里的改动落盘；否则删除之后那些迟到的保存会把旧文件夹又写回来 */
    await flushBlockContents();
    await flushItems();
    await flushCamera();
  }
  await store.deleteCanvas(target.id);
  await loadList();
  if (mine) {
    localStorage.removeItem(STORAGE_KEY);
    setCurrent(null);
    replaceSelection(new Set());
    renderAll();
    if (canvases[0]) await switchTo(canvases[0].id);
    else showEmpty();
  }
  return { deleted: { id: target.id, name: target.name } };
}

export function agentScene(patch = {}) {
  agentRequireSpace();
  const type = patch.type ? String(patch.type) : "";
  const items = current.items.filter((item) => !type || item.type === type);
  return {
    space: { id: current.meta.id, name: current.meta.name },
    camera: agentCameraState(),
    selected: [...selectedIds],
    blocks: items.map(agentSummary),
  };
}

export function agentBlock(id) {
  return agentSummary(agentRequireItem(id));
}

/* 不给坐标就落在视野里，连着建会一格格错开（insertPoint 负责） */
export function agentPlacePoint(w, h, spec) {
  if (Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y))) {
    return { x: Number(spec.x), y: Number(spec.y) };
  }
  return insertPoint(w, h);
}

/* 产品卡字段的统一下发口：建块和改块共用同一套取值规矩 */
export function applyProductFields(item, spec = {}) {
  if (spec.name !== undefined) {
    const name = String(spec.name || "").trim();
    if (name) item.name = name;
  }
  if (spec.brand !== undefined) item.brand = String(spec.brand || "").trim();
  if (spec.sku !== undefined) item.sku = String(spec.sku || "").trim();
  if (spec.spec !== undefined) item.spec = String(spec.spec || "").trim();
  if (spec.price !== undefined) item.price = Math.max(0, numOr(spec.price, item.price));
  if (spec.qty !== undefined) item.qty = Math.max(1, Math.trunc(numOr(spec.qty, item.qty)));
  if (spec.source !== undefined) item.source = String(spec.source || "").trim();
  if (spec.note !== undefined) item.note = String(spec.note || "").trim();
  if (spec.model !== undefined) item.model = String(spec.model || "").trim();
  if (spec.internal !== undefined) item.internal = spec.internal === true;
  if (spec.dims !== undefined) {
    const dims = spec.dims && typeof spec.dims === "object" ? spec.dims : {};
    item.dims = {
      w: Math.max(0, numOr(dims.w, item.dims.w)),
      d: Math.max(0, numOr(dims.d, item.dims.d)),
      h: Math.max(0, numOr(dims.h, item.dims.h)),
    };
  }
}
