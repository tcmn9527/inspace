/* 从 canvas.js 拆出：scene-toolbar */

import { toPersisted } from "../canvas-items.js";
import { FURNITURE_COLORS } from "./scene-tools.js";
import { SCENE_LIGHT_PRESETS, active, addSceneFloor, addSceneModelFlow, agentHighlight, agentRevealBlock, boundsOfItem, closeColorPicker, connectorGeometry, createFurnitureFlow, current, dropRegionImage, exportSceneFlow, findItem, itemBounds, itemEls, newId, normalizeLight, normalizeSceneCamera, normalizeSceneParts, onSceneFurnitureSelection, openColorPicker, panelTreeLabel, persistScene, refreshConnectors, refreshMinimap, renderTree, revealSelectionInTree, sceneCameraState, sceneLightOf, scenePlacementActive, sceneView, scheduleItemsSave, scheduleMeasurements, select, selectedIds, setSceneCameraPreset, setSceneFurnitureSelection, setScenePlacementMode, showError, showToast, syncItemElement, tool, treeUi, ui, updatePorts, worldToStage } from "../canvas.js";

/* ---------- 3D 场景工具条 ----------
   选中恰好一个场景块时，画布底部浮一条：环境 / 灯光 / 机位 / 内容 / 输出。
   所有控件都改块上的现有字段（groundColor / parts / surfaces / light / camera），
   agent 的 block_update 改的也是同一份，两边即时互通。 */
export const SCENE_TOOL_LABELS = [
  ["environment", "环境"],
  ["light", "灯光"],
  ["camera", "机位"],
  ["content", "内容"],
  ["edit", "编辑"],
  ["export", "输出"],
];
export const GROUND_COLORS = [
  { value: "", title: "默认灰" },
  { value: "#f2efe9", title: "白" },
  { value: "#cfc4b0", title: "浅米" },
  { value: "#9a917d", title: "暖灰" },
  { value: "#4a4a48", title: "深灰" },
];
export const LIGHT_LIT_COLORS = [
  { value: "#fff4e2", title: "暖白" },
  { value: "#ffc07a", title: "暖橙" },
  { value: "#ffffff", title: "纯白" },
];
export const LIGHT_DARK_COLORS = [
  { value: "#dbe7f2", title: "冷灰蓝" },
  { value: "#71809a", title: "蓝灰" },
  { value: "#5b6781", title: "深蓝" },
];
export let sceneToolbar = null;
export let scenePop = null;
/* 沉浸式编辑时，场景级工具（环境/灯光/机位/内容/输出）挪到画布左上角 */
export let sceneEditTools = null;
export let scenePopKind = "";

export function soloSceneItem() {
  if (selectedIds.size !== 1) return null;
  const item = findItem([...selectedIds][0]);
  return item && item.type === "scene" ? item : null;
}

export function installSceneToolbar() {
  const main = document.querySelector(".canvas-main");
  if (!main || sceneToolbar) return;
  sceneToolbar = document.createElement("div");
  sceneToolbar.className = "scene-toolbar";
  sceneToolbar.hidden = true;
  scenePop = document.createElement("div");
  scenePop.className = "scene-pop";
  scenePop.hidden = true;
  sceneEditTools = document.createElement("div");
  sceneEditTools.className = "scene-edit-tools";
  sceneEditTools.hidden = true;
  for (const [kind, label] of SCENE_TOOL_LABELS) {
    if (kind === "edit") continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scene-tool-btn";
    btn.dataset.sceneTool = kind;
    btn.textContent = label;
    sceneEditTools.append(btn);
  }
  main.append(sceneToolbar, scenePop, sceneEditTools);
  sceneEditTools.addEventListener("click", (event) => {
    const btn = event.target.closest?.("[data-scene-tool]");
    if (!btn || btn.disabled) return;
    handleSceneTool(btn.dataset.sceneTool);
  });
  sceneToolbar.addEventListener("click", (event) => {
    const btn = event.target.closest?.("[data-scene-tool]");
    if (!btn || btn.disabled) return;
    handleSceneTool(btn.dataset.sceneTool);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!scenePop || scenePop.hidden) return;
      if (scenePop.contains(event.target) || sceneToolbar.contains(event.target)) return;
      /* 点取色盘浮层不算点了外面，不然一按颜色区整个面板就被关了 */
      if (event.target.closest?.(".color-pop")) return;
      closeScenePop();
    },
    true,
  );
}

export function closeScenePop() {
  scenePopKind = "";
  closeColorPicker(false);
  if (scenePop) scenePop.hidden = true;
  for (const btn of sceneToolbar?.querySelectorAll(".scene-tool-btn") || []) {
    btn.classList.remove("is-open");
  }
  for (const btn of sceneEditTools?.querySelectorAll(".scene-tool-btn") || []) {
    btn.classList.remove("is-open");
  }
}

export function openScenePop(item, kind) {
  scenePopKind = kind;
  scenePop.hidden = false;
  for (const btn of sceneToolbar.querySelectorAll(".scene-tool-btn")) {
    btn.classList.toggle("is-open", btn.dataset.sceneTool === kind);
  }
  for (const btn of sceneEditTools?.querySelectorAll(".scene-tool-btn") || []) {
    btn.classList.toggle("is-open", btn.dataset.sceneTool === kind);
  }
  /* 沉浸式编辑：弹层跟着左上角的工具组走，不再从底部弹 */
  if (sceneEditTools && !sceneEditTools.hidden) {
    scenePop.style.left = "6px";
    scenePop.style.top = "84px";
    scenePop.style.bottom = "auto";
    scenePop.style.transform = "none";
  } else {
    scenePop.style.left = "";
    scenePop.style.top = "";
    scenePop.style.bottom = "";
    scenePop.style.transform = "";
  }
  renderScenePop(item, kind);
}

export function sceneLightPatch(item, patch, options = {}) {
  const base = lightOrDay(item);
  const got = normalizeLight({ ...base, ...patch });
  if (got.light) scenePatch(item, { light: got.light }, options);
}

export function lightOrDay(item) {
  const got = normalizeLight(item.light || SCENE_LIGHT_PRESETS.day);
  return got.light || normalizeLight(SCENE_LIGHT_PRESETS.day).light;
}

export function scenePatch(item, patch, options = {}) {
  if (item.locked) {
    showError("场景已锁定，先解锁再改");
    return;
  }
  Object.assign(item, patch);
  persistScene(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  if (options.quiet) return;
  if (scenePopKind && scenePop && !scenePop.hidden) renderScenePop(item, scenePopKind);
  else refreshSceneToolbar();
}

/* ---------- 场景元素（选中单件/整组）操作 ---------- */

export function moveSceneElement(item, indices, axis, target) {
  const first = item.parts[indices[0]];
  if (!first) return;
  const delta = target - first[axis];
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) return;
  const parts = item.parts.map((part, k) =>
    indices.includes(k) ? { ...part, [axis]: part[axis] + delta } : part,
  );
  scenePatch(item, { parts }, { quiet: true });
}

export function resizeSceneElement(item, indices, axis, value) {
  if (indices.length !== 1) return;
  const size = Math.max(0, Math.round(value));
  const parts = item.parts.map((part, k) => (k === indices[0] ? { ...part, [axis]: size } : part));
  scenePatch(item, { parts }, { quiet: true });
}

export function rotateSceneElement(item, indices, value) {
  if (indices.length !== 1) return;
  const rotate = ((Math.round(value) % 360) + 360) % 360;
  const parts = item.parts.map((part, k) => (k === indices[0] ? { ...part, rotate } : part));
  scenePatch(item, { parts }, { quiet: true });
}

export function paintSceneElement(item, indices, color) {
  const parts = item.parts.map((part, k) =>
    indices.includes(k) && part.op !== "model" ? { ...part, color } : part,
  );
  scenePatch(item, { parts });
}

/* 给程序几何件贴图（画布 images/ 里的相对路径）；tex 空串回纯色 */
export function paintSceneTexture(item, indices, tex) {
  const parts = item.parts.map((part, k) =>
    indices.includes(k) && part.op !== "model"
      ? { ...part, tex: tex || "", texRepeat: part.texRepeat || 100 }
      : part,
  );
  scenePatch(item, { parts });
}

export function duplicateSceneElement(item, indices) {
  const part = item.parts[indices[0]];
  if (!part) return;
  const copy = { ...part, group: newId(), x: part.x + 20, y: part.y + 20 };
  const got = normalizeSceneParts([...item.parts, copy]);
  if (got.dropped.length) {
    showError(got.dropped[0].why);
    return;
  }
  scenePatch(item, { parts: got.parts });
  setSceneFurnitureSelection(sceneView(item), [item.parts.length - 1]);
  showToast("已复制这件");
}

export function deleteSceneElement(item, indices) {
  const parts = item.parts.filter((_, k) => !indices.includes(k));
  scenePatch(item, { parts });
  setSceneFurnitureSelection(sceneView(item), []);
  showToast("已删除");
}

/* 元素弹层：位置 / 尺寸 / 旋转 / 颜色 */
export function renderElementPop(item, kind) {
  const indices = sceneSelectedIndices(item);
  const part = indices.length ? item.parts[indices[0]] : null;
  const hint = (text) => {
    const div = document.createElement("div");
    div.className = "scene-pop-row";
    div.textContent = text;
    scenePop.append(div);
  };
  if (!part) {
    hint("先在场景里点一下要编辑的元素");
    return;
  }
  if (kind === "position") {
    scenePopNumber("X", part.x, 1, (value) => moveSceneElement(item, indices, "x", value));
    scenePopNumber("Y", part.y, 1, (value) => moveSceneElement(item, indices, "y", value));
    scenePopNumber("离地", part.z, 1, (value) => moveSceneElement(item, indices, "z", value));
    hint(indices.length > 1 ? `整组 ${indices.length} 件一起移动 · 单位 cm` : "单位 cm");
  } else if (kind === "size") {
    scenePopNumber("宽", part.w || 0, 1, (value) => resizeSceneElement(item, indices, "w", value));
    scenePopNumber("深", part.d || 0, 1, (value) => resizeSceneElement(item, indices, "d", value));
    scenePopNumber("高", part.h || 0, 1, (value) => resizeSceneElement(item, indices, "h", value));
    hint(part.op === "model" ? "模型件填 0 = 按模型自带尺寸" : "单位 cm");
  } else if (kind === "rotate") {
    scenePopSlider("方向", part.rotate || 0, 0, 360, 1, (value) => rotateSceneElement(item, indices, value));
  } else if (kind === "color") {
    if (indices.some((k) => item.parts[k]?.op === "model")) {
      hint("模型件带自己的贴图，不支持整体换色");
      return;
    }
    scenePopRow(
      "颜色",
      scenePopDots(FURNITURE_COLORS, part.color || "", (value) => paintSceneElement(item, indices, value)),
    );
    /* 贴图：从画布上的图片块里挑一张贴上去（相对路径存 scenes 文件，跟画布一起搬） */
    if (part.tex) {
      scenePopActions([{ label: "清除贴图", onClick: () => paintSceneTexture(item, indices, "") }]);
    }
    const images = (current?.items || []).filter(
      (one) => (one.type === "image" || one.type === "gen") && one.src,
    );
    if (!images.length) {
      hint("画布上没有图片块，贴不了图");
      return;
    }
    hint("贴图（点一张贴上）");
    scenePopActions(
      images.slice(0, 12).map((one) => ({
        label: `#${one.seq} ${one.type === "gen" ? "生图" : "图片"}`,
        active: one.src === part.tex,
        onClick: () => paintSceneTexture(item, indices, one.src),
      })),
      { perRow: 3 },
    );
  }
}

export function useCurrentSceneCamera(item) {
  const view = sceneView(item);
  const camera = normalizeSceneCamera(sceneCameraState(item, view));
  if (!camera) {
    showError("场景还没渲染出来，等它显示出来再试");
    return;
  }
  scenePatch(item, { camera });
  showToast("已记住当前视角");
}

/* ---------- 场景弹层公共控件 ---------- */
export function scenePopRow(label, ...children) {
  const div = document.createElement("div");
  div.className = "scene-pop-row";
  const name = document.createElement("span");
  name.textContent = label;
  div.append(name, ...children);
  scenePop.append(div);
  return div;
}

export function scenePopDots(colors, current, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "scene-pop-dots";
  for (const entry of colors) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "scene-dot";
    if (entry.value) dot.style.setProperty("--c", entry.value);
    else dot.classList.add("is-default");
    if (entry.title) dot.title = entry.title;
    if ((current || "") === (entry.value || "")) dot.classList.add("is-active");
    dot.addEventListener("click", () => onPick(entry.value));
    wrap.append(dot);
  }
  /* 更多色：直接弹全局取色盘（常用色 + SV 方块 + 色相条），点「确定」才生效 */
  const more = document.createElement("button");
  more.type = "button";
  more.className = "scene-dot is-more";
  more.title = "更多颜色…";
  if (current && !colors.some((entry) => (entry.value || "") === (current || ""))) {
    more.style.setProperty("--c", current);
    more.classList.add("is-custom", "is-active");
  }
  more.addEventListener("click", () => {
    const rect = more.getBoundingClientRect();
    openColorPicker({
      x: rect.left - 150,
      y: rect.bottom + 6,
      value: current || "#b98a5e",
      seed: "#b98a5e",
      presets: SCENE_MORE_COLORS,
      withButtons: true,
      dismissCommits: false,
      onDone: (hex) => {
        if (hex) onPick(hex);
      },
    });
  });
  wrap.append(more);
  return wrap;
}

export function scenePopActions(entries, options = {}) {
  const perRow = Math.max(0, Math.floor(Number(options.perRow) || 0));
  const rows = [];
  if (perRow > 0) {
    for (let i = 0; i < entries.length; i += perRow) rows.push(entries.slice(i, i + perRow));
  } else {
    rows.push(entries);
  }
  let first = null;
  for (const row of rows) {
    const wrap = document.createElement("div");
    wrap.className = "scene-pop-actions";
    for (const entry of row) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `plain-btn${entry.active ? " is-active" : ""}`;
      btn.textContent = entry.label;
      if (entry.disabled) btn.disabled = true;
      if (entry.title) btn.title = entry.title;
      if (entry.action) btn.dataset.sceneAction = entry.action;
      if (entry.onContextMenu) {
        btn.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          entry.onContextMenu();
        });
      }
      btn.addEventListener("click", entry.onClick);
      wrap.append(btn);
    }
    scenePop.append(wrap);
    if (!first) first = wrap;
  }
  return first;
}

export function scenePopSlider(label, value, min, max, step, onInput) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => onInput(Number(input.value)));
  scenePopRow(label, input);
}

/* 元素弹层里那种数字框：失焦/回车才提交，边打字不重建面板 */
export function scenePopNumber(label, value, step, onCommit) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.value = String(Math.round(value));
  /* 边输入边生效（和滑杆一致）；空串/半截数字先不理，焦点留在框里 */
  input.addEventListener("input", () => {
    const raw = input.value.trim();
    if (!raw || raw === "-" || raw === "." || raw === "-.") return;
    const next = Number(raw);
    if (Number.isFinite(next)) onCommit(next);
  });
  input.addEventListener("change", () => {
    const next = Number(input.value);
    if (Number.isFinite(next)) onCommit(next);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
  scenePopRow(label, input);
}

export const ELEMENT_POP_KINDS = new Set(["position", "size", "rotate", "color"]);

export function renderScenePop(item, kind) {
  scenePop.textContent = "";
  if (ELEMENT_POP_KINDS.has(kind)) {
    renderElementPop(item, kind);
    return;
  }
  if (kind === "environment") {
    /* 环境只放环境本身的参数；地板/墙这些构造物在元素工具里改 */
    scenePopRow("空间底色", scenePopDots(GROUND_COLORS, item.groundColor || "", (value) => scenePatch(item, { groundColor: value })));
    scenePopActions([
      {
        label: "阴影开",
        active: item.shadow !== false,
        onClick: () => scenePatch(item, { shadow: true }),
      },
      {
        label: "阴影关",
        active: item.shadow === false,
        onClick: () => scenePatch(item, { shadow: false }),
      },
    ]);
    scenePopActions([
      { label: "网格开", active: Boolean(item.grid), onClick: () => scenePatch(item, { grid: true }) },
      { label: "网格关", active: !item.grid, onClick: () => scenePatch(item, { grid: false }) },
    ]);
  } else if (kind === "light") {
    scenePopActions([
      { label: "白天", onClick: () => scenePatch(item, { light: sceneLightOf("day") }) },
      { label: "傍晚", onClick: () => scenePatch(item, { light: sceneLightOf("warm") }) },
      { label: "夜灯", onClick: () => scenePatch(item, { light: sceneLightOf("night") }) },
      { label: "无灯", onClick: () => scenePatch(item, { light: null }) },
    ]);
    const light = lightOrDay(item);
    /* 拖动中只落数据不重建面板，否则滑杆每动一下就被新 DOM 换掉、拖不动 */
    scenePopSlider("光方向", light.angle, 0, 360, 5, (value) => sceneLightPatch(item, { angle: value }, { quiet: true }));
    scenePopSlider("太阳高度", light.elev, 5, 85, 1, (value) => sceneLightPatch(item, { elev: value }, { quiet: true }));
    scenePopSlider("明暗对比", Math.round(light.k * 100), 20, 100, 1, (value) => sceneLightPatch(item, { k: value / 100 }, { quiet: true }));
    scenePopRow("亮部色", scenePopDots(LIGHT_LIT_COLORS, light.lit, (value) => sceneLightPatch(item, { lit: value })));
    scenePopRow("暗部色", scenePopDots(LIGHT_DARK_COLORS, light.dark, (value) => sceneLightPatch(item, { dark: value })));
  } else if (kind === "camera") {
    scenePopActions([
      { label: "自动", onClick: () => setSceneCameraPreset(item, "auto") },
      { label: "正面", onClick: () => setSceneCameraPreset(item, "front") },
      { label: "左角", onClick: () => setSceneCameraPreset(item, "left") },
      { label: "右角", onClick: () => setSceneCameraPreset(item, "right") },
      { label: "俯视", onClick: () => setSceneCameraPreset(item, "top") },
    ]);
    scenePopActions([
      { label: "用当前视角", onClick: () => useCurrentSceneCamera(item) },
      { label: "重置", onClick: () => scenePatch(item, { camera: null }) },
    ]);
    /* 投影方式：正交是户型/产品那种无透视的轴测视角 */
    scenePopActions([
      { label: "透视", active: !item.ortho, onClick: () => scenePatch(item, { ortho: false }) },
      { label: "正交", active: Boolean(item.ortho), onClick: () => scenePatch(item, { ortho: true }) },
    ]);
    /* 焦距视野：视场角越小越像长焦，越大越广角 */
    const shot = sceneCameraState(item, sceneView(item));
    scenePopSlider("焦距视野", Math.round(shot.fov), 20, 90, 1, (value) => {
      const base = sceneCameraState(item, sceneView(item));
      scenePatch(item, { camera: { ...base, fov: value } }, { quiet: true });
    });
    const saved = item.cameras || [];
    scenePopActions([
      {
        label: "存当前为机位",
        action: "save-camera",
        disabled: saved.length >= 3,
        title: "最多存三个，右键机位按钮可删除",
        onClick: () => {
          const base = sceneCameraState(item, sceneView(item));
          const seq = saved.reduce((n, one) => {
            const hit = String(one.name).match(/(\d+)$/);
            return hit ? Math.max(n, Number(hit[1])) : n;
          }, 0) + 1;
          const list = saved.slice();
          list.push({ name: `机位${seq}`, camera: base, ortho: Boolean(item.ortho) });
          scenePatch(item, { cameras: list });
        },
      },
      {
        label: "删全部机位",
        action: "clear-cameras",
        disabled: !saved.length,
        onClick: () => scenePatch(item, { cameras: [] }),
      },
    ]);
    if (saved.length) {
      scenePopActions(
        saved.map((one) => ({
          label: one.name,
          action: "camera-view",
          title: "点击切过去，右键删除",
          onClick: () => scenePatch(item, { camera: one.camera, ortho: Boolean(one.ortho) }),
          onContextMenu: () => scenePatch(item, { cameras: (item.cameras || []).filter((c) => c !== one) }),
        })),
        { perRow: 3 },
      );
    }
    const hint = document.createElement("div");
    hint.className = "scene-pop-row";
    hint.textContent = "Ctrl 拖动转视角 · Shift 拖动平移";
    scenePop.append(hint);
  } else if (kind === "content") {
    scenePopActions([
      { label: "模型库添加", onClick: () => { closeScenePop(); void addSceneModelFlow(item); } },
      { label: "新建模型", onClick: () => { closeScenePop(); void createFurnitureFlow(item); } },
      {
        label: "添加地板",
        disabled: item.parts.some((part) => part.name === "地板"),
        onClick: () => { closeScenePop(); addSceneFloor(item); },
      },
    ], { perRow: 3 });
  } else if (kind === "export") {
    scenePopActions([
      { label: "导出为 GLB", onClick: () => { closeScenePop(); void exportSceneFlow(item); } },
      { label: "落图", onClick: () => { closeScenePop(); void dropRegionImage(item.id); } },
    ]);
  }
}

/* ---------- 场景取色盘（更多色） ---------- */
export const SCENE_MORE_COLORS = [
  "#ffffff", "#f2efe9", "#e8e4dc", "#d9d2c6", "#c9b9a6", "#b7b0a4", "#9a917d", "#6f6a62", "#4a4a48",
  "#2c2c2c", "#d2b48c", "#b98a5e", "#8a6f55", "#6b5138", "#a0522d", "#8b4513", "#c0703c", "#e0c088",
  "#e7b8a8", "#d9a7a0", "#b7c4b1", "#8fa58a", "#6e8b73", "#5c7c89", "#8f9bb3", "#b7a8c4", "#d9c27e",
];
/* 选中/锁/字段变化后重排工具条：只在选中恰好一个场景块时出现 */
/* 元素态：工具条换成「选中那件东西」的工具 */
export const ELEMENT_TOOL_BUTTONS = [
  ["position", "位置", { edit: true }],
  ["size", "尺寸", { edit: true, single: true }],
  ["rotate", "旋转", { edit: true, single: true }],
  ["color", "颜色", { edit: true }],
  ["copy", "复制", { edit: true, action: true }],
  ["delete", "删除", { edit: true, action: true }],
  ["exit", "退出编辑", { keep: true }],
];

export function sceneSelectedIndices(item) {
  const selection = sceneView(item)?.__sceneSelection;
  return Array.isArray(selection?.indices)
    ? selection.indices.filter((index) => Number.isInteger(index) && index >= 0)
    : [];
}

export function buildSceneToolButtons(item, elementMode, indices) {
  sceneToolbar.textContent = "";
  const locked = Boolean(item.locked);
  const hasSel = indices.length > 0;
  if (elementMode) {
    for (const [kind, label, opts = {}] of ELEMENT_TOOL_BUTTONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scene-tool-btn";
      btn.dataset.sceneTool = kind;
      btn.textContent = label;
      if (opts.edit) btn.disabled = locked || !hasSel;
      if (opts.single && indices.length !== 1) btn.disabled = true;
      sceneToolbar.append(btn);
    }
    return;
  }
  for (const [kind, label] of SCENE_TOOL_LABELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scene-tool-btn";
    btn.dataset.sceneTool = kind;
    btn.textContent = label;
    if (["environment", "light", "content", "edit"].includes(kind) && locked) btn.disabled = true;
    sceneToolbar.append(btn);
  }
}

export function handleSceneTool(kind) {
  const item = soloSceneItem();
  if (!item) return;
  const elementMode = scenePlacementActive(item);
  const indices = elementMode ? sceneSelectedIndices(item) : [];
  if (kind === "copy") {
    if (indices.length) duplicateSceneElement(item, indices);
    return;
  }
  if (kind === "delete") {
    if (indices.length) deleteSceneElement(item, indices);
    return;
  }
  if (item.locked) {
    showError("场景已锁定，先解锁再改");
    return;
  }
  if (kind === "edit") {
    closeScenePop();
    enterSceneEdit(item);
    return;
  }
  if (kind === "exit") {
    exitSceneEdit(item);
    return;
  }
  if (scenePopKind === kind && !scenePop.hidden) {
    closeScenePop();
    return;
  }
  openScenePop(item, kind);
}

/* 「编辑」= 把这块场景临时铺满画布，同时进元素态；退出时位置尺寸原样还回去。
   最大化只改内存里的坐标，保存走 toPersisted 时写回原值，盘上永远是用户摆的位置。 */
export function enterSceneEdit(item) {
  if (!item || item.type !== "scene") return;
  if (item.locked) {
    showError("场景已锁定，先解锁再改");
    return;
  }
  if (!sceneView(item)) {
    showError("场景还没显示出来，稍后再试");
    return;
  }
  if (!item.__editRestore) {
    const minimap = document.getElementById("canvas-minimap");
    item.__editRestore = {
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      z: item.z,
      radius: item.radius,
      borderWidth: item.borderWidth,
      minimapHidden: minimap ? minimap.hidden : null,
    };
    /* 沉浸式：左侧树留着，只收掉右下角鸟瞰窗，场景块无边框圆角铺满画布 */
    if (minimap) minimap.hidden = true;
    const rect = ui.stage.getBoundingClientRect();
    const scale = current.camera.scale || 1;
    let maxZ = 0;
    for (const other of current.items) {
      if (Number.isFinite(other.z)) maxZ = Math.max(maxZ, other.z);
    }
    item.x = -current.camera.x / scale;
    item.y = -current.camera.y / scale;
    item.w = Math.max(320, rect.width / scale);
    item.h = Math.max(240, rect.height / scale);
    item.z = maxZ + 1;
    item.radius = 0;
    item.borderWidth = 0;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    updateSelection();
  }
  setScenePlacementMode(item, true);
}

/* 沉浸式编辑中窗口变了：场景块跟着铺满，不然会露出一条画布背景 */
window.addEventListener("resize", () => {
  if (!current || !ui || !ui.stage) return;
  const item = current.items.find((one) => one.type === "scene" && one.__editRestore);
  if (!item) return;
  const rect = ui.stage.getBoundingClientRect();
  const scale = current.camera.scale || 1;
  item.x = -current.camera.x / scale;
  item.y = -current.camera.y / scale;
  item.w = Math.max(320, rect.width / scale);
  item.h = Math.max(240, rect.height / scale);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  updateSelection();
});

export function exitSceneEdit(item) {
  if (!item) return;
  const restore = item.__editRestore;
  if (restore) {
    const minimap = document.getElementById("canvas-minimap");
    if (minimap && restore.minimapHidden !== null && restore.minimapHidden !== undefined) {
      minimap.hidden = restore.minimapHidden;
    }
    item.x = restore.x;
    item.y = restore.y;
    item.w = restore.w;
    item.h = restore.h;
    item.z = restore.z;
    item.radius = restore.radius;
    item.borderWidth = restore.borderWidth;
    delete item.__editRestore;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    updateSelection();
    scheduleItemsSave();
  }
  if (scenePlacementActive(item)) setScenePlacementMode(item, false);
}

/* 场景元素在树里显示的名字：有名用名，没名按类型 */
export function scenePartBaseLabel(part) {
  if (part.name) return part.name;
  if (part.op === "model") return String(part.src || "").replace(/\.glb$/i, "") || "模型";
  if (part.op === "solid") {
    return { cylinder: "圆柱", sphere: "球体", cone: "圆锥", torus: "圆环", capsule: "胶囊" }[part.shape] || "形体";
  }
  if (part.op === "poly") return "棱柱";
  if (part.op === "roof") return "屋顶";
  return "方块";
}

/* 树里点场景的一件：进元素模式并选中它 */
export function enterScenePart(scene, index) {
  if (scene.locked) {
    showError("场景已锁定，先解锁再改");
    return;
  }
  if (!scenePlacementActive(scene)) setScenePlacementMode(scene, true);
  select(scene.id);
  agentRevealBlock(scene.id);
  setSceneFurnitureSelection(sceneView(scene), [index]);
  agentHighlight([scene.id], 1000);
  renderTree();
}

export let sceneToolbarSignature = "";

export function refreshSceneToolbar() {
  if (!sceneToolbar) installSceneToolbar();
  if (!sceneToolbar) return;
  const item = soloSceneItem();
  sceneToolbar.hidden = !item;
  if (!item) {
    if (sceneToolbarSignature) closeScenePop();
    sceneToolbarSignature = "";
    /* 没有场景在选：编辑态左上角的场景工具组也要收掉，别残留在别的画布上 */
    if (sceneEditTools) sceneEditTools.hidden = true;
    return;
  }
  const elementMode = scenePlacementActive(item);
  const indices = elementMode ? sceneSelectedIndices(item) : [];
  const signature = `${item.id}|${elementMode}|${item.locked ? 1 : 0}|${indices.join(",")}`;
  if (signature !== sceneToolbarSignature) {
    sceneToolbarSignature = signature;
    closeScenePop();
    buildSceneToolButtons(item, elementMode, indices);
  }
  if (sceneEditTools) {
    sceneEditTools.hidden = !elementMode;
    for (const btn of sceneEditTools.querySelectorAll(".scene-tool-btn")) {
      btn.disabled = item.locked && ["environment", "light", "content"].includes(btn.dataset.sceneTool);
      btn.classList.toggle("is-open", Boolean(scenePop) && !scenePop.hidden && btn.dataset.sceneTool === scenePopKind);
    }
  }
}

/* 场景里选中/取消选中元素：工具条跟着换 */
onSceneFurnitureSelection(() => {
  refreshSceneToolbar();
  /* 树里的场景子行也要跟选中高亮走 */
  if (current) renderTree();
});

/* 标题栏：当前画布路径；单选面板时跟上 #N 名称（没自定义名就是类型） */
export function refreshTitlebarPath() {
  const el = document.getElementById("titlebar-path");
  if (!el) return;
  if (!current) {
    el.textContent = "";
    el.title = "";
    return;
  }
  const parts = [String(current.meta.id || "").replace(/\//g, "\\")];
  const ids = [...selectedIds].filter((id) => findItem(id)?.type !== "connector");
  if (ids.length === 1) {
    const item = findItem(ids[0]);
    if (item && Number.isFinite(item.seq) && item.seq > 0) parts.push(panelTreeLabel(item));
  } else if (ids.length > 1) {
    parts.push(`已选 ${ids.length} 项`);
  }
  const text = parts.filter(Boolean).join("\\");
  el.textContent = text;
  el.title = text;
}

/* 画布上选中的块，面板树里对应的行跟着亮底；容器折叠时子块行不在 DOM，自然没有可亮的 */
export function syncTreeSelection() {
  const body = treeUi?.body;
  if (!body) return;
  revealSelectionInTree();
  let first = null;
  for (const row of body.querySelectorAll(".space-tree-row[data-id]")) {
    const on = selectedIds.has(row.dataset.id);
    row.classList.toggle("is-selected", on);
    if (on && !first) first = row;
  }
  /* 选中的行滚出树可视区时把树带过去，不然亮在滚动条下面看不见 */
  if (first) first.scrollIntoView({ block: "nearest" });
}

/* 只选了一个时才有的「那一个」；多选时返回 null，缩放和端口这些单块操作照旧不出现 */
export function loneSelected() {
  return selectedIds.size === 1 ? [...selectedIds][0] : null;
}

/* 锁定的块在左下角信息条的 #N 前面挂一枚小锁；非锁定不挂 */
export const LOCK_BADGE_SVG = `<svg class="canvas-metrics-lock" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="5.3" width="7.4" height="5.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.1 5.3V4a1.9 1.9 0 0 1 3.8 0v1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

export function updateSelection() {
  if (!ui) return;
  syncTreeSelection();
  refreshTitlebarPath();
  refreshSceneToolbar();
  refreshConnectors();
  for (const stale of ui.world.querySelectorAll(".canvas-sel-box")) stale.remove();
  ui.endpointLayer.textContent = "";
  if (ui.handleVisualLayer) ui.handleVisualLayer.textContent = "";
  updatePorts();
  refreshMinimap();
  if (!selectedIds.size) return;
  /* 四角缩放把手和线的端点拖拽只给「就选了一个」：一堆块同时缩放没意义，把手糊成一片也没法点 */
  const lone = selectedIds.size === 1;
  for (const id of selectedIds) {
    const item = findItem(id);
    const el = itemEls.get(id);
    if (item && el) drawSelectionFor(item, el, lone);
  }
  scheduleMeasurements();
}

/* 选中的记号只剩「四边那几个圈」：描边、柔光全都不要了，单选多选一样。
   所以这里只画两类东西：所有块共用的四角隐形把手（单选时），以及线/箭头两头的端点圈。
   面板四边的端口圈由 updatePorts 统一画，不在这里管。 */
export function drawSelectionFor(item, el, lone) {
  el.classList.add("is-selected");

  if (item.type === "connector") {
    if (!lone) return;
    const geometry = connectorGeometry(item, boundsOfItem);
    if (!geometry) return;
    /* 折点圈先放、两端圈后放：折点被拖到端口上时，端点圈仍然压在上面能拖 */
    if (item.bend) {
      for (const [index, point] of (geometry.points || []).entries()) {
        const screen = worldToStage(point.x, point.y);
        const handle = document.createElement("span");
        handle.className = "canvas-handle canvas-handle-point canvas-handle-bend";
        handle.dataset.handle = "bend";
        handle.dataset.index = String(index);
        handle.title = "拖动调整走线，双击删除折点";
        handle.style.left = `${screen.x}px`;
        handle.style.top = `${screen.y}px`;
        ui.endpointLayer.append(handle);
      }
    }
    for (const [end, point] of [
      ["from", geometry.a],
      ["to", geometry.b],
    ]) {
      const screen = worldToStage(point.x, point.y);
      const handle = document.createElement("span");
      handle.className = "canvas-handle canvas-handle-point";
      handle.dataset.handle = "connect-end";
      handle.dataset.end = end;
      handle.style.left = `${screen.x}px`;
      handle.style.top = `${screen.y}px`;
      ui.endpointLayer.append(handle);
    }
    return;
  }

  /* 锁住的块不给能改它的把手：不能缩放，线的端点也不能拖 */
  if (item.locked) return;
  /* 线没有四边端口圈，选中就靠两头那颗圈说话，多选也一样画 */
  if (item.type === "line" || item.type === "arrow") {
    const box = addOverlayBox(el, "canvas-sel-box");
    const bounds = itemBounds(item, el);
    for (const end of ["a", "b"]) {
      const point = end === "a" ? { x: item.x, y: item.y } : { x: item.x2, y: item.y2 };
      const handle = document.createElement("span");
      handle.className = "canvas-handle canvas-handle-point canvas-handle-hit";
      handle.dataset.handle = "endpoint";
      handle.dataset.end = end;
      /* 端点相对包围盒是固定百分比，块怎么缩放挪动都跟得住（水平/竖直线的某条边是 0，落在 0% 正好） */
      handle.style.left = `${((point.x - bounds.x) / Math.max(1, bounds.w)) * 100}%`;
      handle.style.top = `${((point.y - bounds.y) / Math.max(1, bounds.h)) * 100}%`;
      /* 一堆块同时拽两根端点没意义：只有单选那根线的圈能拖 */
      if (!lone) handle.dataset.inert = "1";
      box.append(handle);
      /* 看得见的端点圈画在屏幕层，和锁点/端口一样不受缩放栅格化影响 */
      const screen = worldToStage(point.x, point.y);
      const dot = document.createElement("span");
      dot.className = "canvas-handle-visual";
      if (!lone) dot.dataset.inert = "1";
      dot.style.left = `${screen.x}px`;
      dot.style.top = `${screen.y}px`;
      ui.handleVisualLayer.append(dot);
    }
    return;
  }

  /* 一堆块同时缩放没意义，缩放把手只给单选那一块 */
  if (!lone) return;
  const box = addOverlayBox(el, "canvas-sel-box");
  /* 四边先放、四角后放：角上那一小块归角缩放，边上其余位置归边缩放 */
  for (const dir of ["n", "e", "s", "w"]) {
    const handle = document.createElement("span");
    handle.className = `canvas-handle canvas-handle-${dir}`;
    handle.dataset.handle = "edge";
    handle.dataset.dir = dir;
    box.append(handle);
  }
  for (const dir of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("span");
    handle.className = `canvas-handle canvas-handle-${dir}`;
    handle.dataset.handle = "corner";
    handle.dataset.dir = dir;
    box.append(handle);
  }
}

/* 选中框、端口框都塞进块自己，跟着块的层级走：块被压在下面，这些记号也一起被压住，
   不再永远浮在所有块之上。绝对定位按块的 padding box 算，默认把边框宽度补回去贴外沿；
   端口传 0.5，让圆圈落在边框带的正中，不然高倍缩放下会贴着外沿、看起来偏心。 */
export function addOverlayBox(el, className, borderFactor = 1) {
  const box = document.createElement("div");
  box.className = className;
  const style = getComputedStyle(el);
  box.style.inset = [
    parseFloat(style.borderTopWidth),
    parseFloat(style.borderRightWidth),
    parseFloat(style.borderBottomWidth),
    parseFloat(style.borderLeftWidth),
  ]
    .map((px) => `${-px * borderFactor}px`)
    .join(" ");
  el.append(box);
  return box;
}
