/* 从 canvas.js 拆出：scene-tools */

import { CLOSE_X_SVG, active, agentRequireItem, agentRequireSpace, agentSummary, contentBox, current, exportPartsGLB, exportSceneGLB, itemEls, makeScene, moveSceneFurnitureParts, newId, normalizeLight, normalizeSceneCamera, normalizeSceneParts, normalizeSceneSurfaces, openMenu, persistScene, placeBlock, renderModelThumbnail, sceneCameraState, sceneFurnitureGroup, sceneFurnitureInspect, sceneFurnitureMoveDelta, scenePatch, scenePlacementActive, scheduleItemsSave, select, setSceneFurnitureSelection, setScenePlacementMode, showError, showToast, syncItemElement } from "../canvas.js";
import * as store from "../canvas-store.js";

/* ---------- 3D 房间壳 / 灯光 / 机位 ---------- */

export function sceneSurfacesOf(value) {
  if (!Array.isArray(value)) throw new Error("附着面必须是数组");
  const result = normalizeSceneSurfaces(value);
  if (result.dropped.length) throw new Error(result.dropped[0].why);
  return result.surfaces;
}

export function editableScene(id) {
  const item = agentRequireItem(id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  if (item.locked) throw new Error("场景已锁定，请先解锁");
  return item;
}

export function sceneView(item) {
  return itemEls.get(item.id)?.querySelector(".canvas-scene-view");
}

export function saveSceneFurniture(item, indices, delta) {
  const view = sceneView(item);
  item.camera = normalizeSceneCamera(sceneCameraState(item, view));
  moveSceneFurnitureParts(item, indices.map((index) => ({ index, ...item.parts[index] })), delta);
  persistScene(item);
  scheduleItemsSave();
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  if (scenePlacementActive(item)) setSceneFurnitureSelection(view, indices);
  return { id: item.id, clamped: delta.clamped,
    parts: indices.map((index) => ({ index, x: item.parts[index].x, y: item.parts[index].y, z: item.parts[index].z })) };
}

export function agentSceneGet({ id }) {
  const item = agentRequireItem(id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  return { ...agentSummary(item), parts: item.parts.map((part, index) => ({ ...part, index })),
    rendering: sceneFurnitureInspect(sceneView(item)) };
}

export function agentSceneSurfaceSet({ id, surface }) {
  const item = editableScene(id);
  const [next] = sceneSurfacesOf([surface]);
  const old = item.surfaces.find((one) => one.id === next.id);
  if (old && item.parts.some((part) => part.surface === old.id) &&
      ["kind", "x", "y", "z", "w", "h", "rotate"].some((key) => old[key] !== next[key])) {
    throw new Error("这个面已有家具，请先解除绑定再修改附着面");
  }
  item.surfaces = [...item.surfaces.filter((one) => one.id !== next.id), next];
  scheduleItemsSave();
  return { id, surface: next };
}

export function agentSceneFurnitureBind(spec) {
  const item = editableScene(spec.id);
  if (!Array.isArray(spec.parts) || !spec.parts.length || spec.parts.some((index) =>
      !Number.isInteger(index) || index < 0 || index >= item.parts.length)) throw new Error("parts 要传有效的零件序号数组");
  const indices = [...new Set(spec.parts)];
  const surfaceId = String(spec.surface || "").trim();
  if (!surfaceId) {
    for (const index of indices) { item.parts[index].group = ""; item.parts[index].surface = ""; }
    setSceneFurnitureSelection(sceneView(item), []);
    persistScene(item);
    return { id: item.id, parts: indices, unbound: true };
  }
  const surface = item.surfaces.find((one) => one.id === surfaceId);
  if (!surface) throw new Error(`找不到附着面 ${surfaceId}`);
  const group = String(spec.group || newId()).trim().slice(0, 128);
  if (!group || item.parts.some((part, index) => part.group === group && !indices.includes(index))) {
    throw new Error("家具组名为空或已被其他零件占用，请把整件家具的零件一起绑定");
  }
  const delta = sceneFurnitureMoveDelta(sceneView(item), indices, surface, 0, 0);
  for (const index of indices) { item.parts[index].group = group; item.parts[index].surface = surfaceId; }
  return { ...saveSceneFurniture(item, indices, delta), group, surface: surfaceId };
}

export function agentSceneFurnitureMove({ id, part, du = 0, dv = 0 }) {
  const item = editableScene(id);
  if (!Number.isFinite(du) || !Number.isFinite(dv)) throw new Error("du / dv 要传有限数值");
  const furniture = sceneFurnitureGroup(item, part);
  if (!furniture) throw new Error("这件物体还没绑定附着面，不能移动");
  const delta = sceneFurnitureMoveDelta(sceneView(item), furniture.indices, furniture.surface, du, dv);
  return saveSceneFurniture(item, furniture.indices, delta);
}

export const SCENE_LIGHT_PRESETS = {
  /* 白天：太阳高、天光足，颜色尽量保持固有色 */
  day: { angle: 35, elev: 52, k: 0.55, lit: "#fff4e2", dark: "#dbe7f2" },
  /* 傍晚：低角度暖光，影子里带一点蓝 */
  warm: { angle: 210, elev: 22, k: 0.42, lit: "#ffc07a", dark: "#71809a" },
  /* 夜里开着暖灯：太阳从屋子前方打进来，天光留得多一点，别让一面墙黑成一块 */
  night: { angle: 150, elev: 48, k: 0.6, lit: "#ffd9b0", dark: "#5b6781" },
};

/* 房间壳的单位是厘米：客厅 6.2m × 5.2m、墙高 2.8m。
   墙只做背面和左侧，前面敞开给相机；窗是贴在墙上的一块亮面。 */
export function roomShellParts(preset, options = {}) {
  const specs = {
    living: { w: 620, d: 520, rug: true, console: true },
    bedroom: { w: 500, d: 460, rug: true, console: false },
    dining: { w: 560, d: 470, rug: false, console: true },
  };
  const spec = specs[preset] || specs.living;
  const wall = options.wallColor || "#ece7de";
  const floor = options.floorColor || "#b98a5e";
  const { w, d } = spec;
  const wallH = 280;
  const t = 12;
  const winX = w * 0.22;
  const winY = d / 2 - t - 1;
  const winW = Math.min(240, w * 0.38);
  const winH = 140;
  const winZ = 90;
  const frame = "#d8d2c8";
  const parts = [
    { op: "box", x: 0, y: 0, z: 0, w, d, h: 2, color: floor, name: "地板" },
    { op: "box", x: 0, y: d / 2 - t / 2, z: 0, w, d: t, h: wallH, color: wall, name: "背景墙" },
    { op: "box", x: -w / 2 + t / 2, y: 0, z: 0, w: t, d, h: wallH, color: wall, name: "侧墙" },
    { op: "box", x: winX, y: winY, z: winZ, w: winW, d: 2, h: winH, color: "#cfe2ef", name: "窗" },
    { op: "box", x: winX, y: winY + 1, z: winZ - 8, w: winW + 12, d: 4, h: 8, color: frame, name: "窗框" },
    { op: "box", x: winX, y: winY + 1, z: winZ + winH, w: winW + 12, d: 4, h: 8, color: frame, name: "窗框" },
    { op: "box", x: winX - winW / 2 - 6, y: winY + 1, z: winZ, w: 12, d: 4, h: winH, color: frame, name: "窗框" },
    { op: "box", x: winX + winW / 2 + 6, y: winY + 1, z: winZ, w: 12, d: 4, h: winH, color: frame, name: "窗框" },
  ];
  if (spec.rug) {
    parts.push({ op: "box", x: 0, y: -d * 0.06, z: 2, w: w * 0.56, d: d * 0.48, h: 1.4, color: "#c9b9a6", name: "地毯", group: "rug", surface: "floor" });
  }
  if (spec.console) {
    parts.push({ op: "box", x: w * 0.22, y: d / 2 - t - 22, z: 2, w: 180, d: 38, h: 46, color: "#8a6f55", name: "边柜", group: "console", surface: "floor" });
  }
  return parts;
}

export function roomShellSurfaces(parts) {
  const floor = parts[0];
  const wall = parts[1];
  return sceneSurfacesOf([
    { id: "floor", name: "房间地面", kind: "floor", x: 6, y: -6, z: floor.h, w: floor.w - 12, h: floor.d - 12 },
    { id: "back-wall", name: "背景墙", kind: "wall", x: 0, y: floor.d / 2 - 12, z: floor.h, w: floor.w - 24, h: wall.h - floor.h },
    { id: "left-wall", name: "侧墙", kind: "wall", x: -floor.w / 2 + 12, y: -6, z: floor.h, w: floor.d - 12, h: wall.h - floor.h, rotate: 90 },
  ]);
}

export function sceneLightOf(preset) {
  const got = normalizeLight(SCENE_LIGHT_PRESETS[preset]);
  if (got.why) throw new Error(got.why);
  return got.light;
}

export function agentSceneRoomShell(spec = {}) {
  agentRequireSpace();
  const item = agentRequireItem(spec.id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  const preset = ["living", "bedroom", "dining"].includes(spec.preset) ? spec.preset : "living";
  const got = normalizeSceneParts(roomShellParts(preset, { wallColor: spec.wallColor, floorColor: spec.floorColor }));
  if (got.dropped.length) throw new Error(got.dropped[0].why);
  item.parts = got.parts;
  item.surfaces = roomShellSurfaces(got.parts);
  setSceneFurnitureSelection(sceneView(item), []);
  item.light = sceneLightOf("day");
  item.camera = null;
  persistScene(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return { ...agentSummary(item), preset };
}

export function agentSceneLightPreset(spec = {}) {
  const item = agentRequireItem(spec.id);
  if (item.type !== "scene") throw new Error("id 要传场景块");
  const preset = String(spec.preset || "");
  if (preset === "off") item.light = null;
  else if (SCENE_LIGHT_PRESETS[preset]) item.light = sceneLightOf(preset);
  else throw new Error("灯光预设只有 day / warm / night / off");
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return agentSummary(item);
}

export function setSceneCameraPreset(item, preset) {
  if (item.type !== "scene") throw new Error("id 要传场景块");
  if (preset === "auto") {
    item.camera = null;
  } else {
    const box = contentBox(item.parts, item.light);
    const span = Math.max(box.dx, box.dy, 1);
    const angles = { front: [180, 16, 1.02], left: [212, 24, 0.95], right: [148, 24, 0.95], top: [180, 66, 1] };
    const p = angles[preset];
    if (!p) throw new Error("机位预设只有 auto / front / left / right / top");
    item.camera = normalizeSceneCamera({
      azim: p[0],
      elev: p[1],
      dist: Math.max(280, span * p[2]),
      tx: box.cx,
      ty: box.cy,
      tz: Math.max(60, box.dz * 0.35),
      fov: 45,
    });
  }
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return agentSummary(item);
}

export function agentSceneCameraPreset(spec = {}) {
  const item = agentRequireItem(spec.id);
  return setSceneCameraPreset(item, String(spec.preset || ""));
}

/* 一张产品卡落进场景：读卡上的 model 和真实尺寸，模型自带单位由渲染器按尺寸等比缩。
   卡片上没有模型就不放——空一块假家具比报错更难查。 */
export async function placeProductInScene(product, scene, options = {}) {
  if (!product || product.type !== "product") throw new Error("要放进去的是一张产品卡");
  if (!scene || scene.type !== "scene") throw new Error("要放进的是场景块");
  if (!product.model) {
    throw new Error("这张产品卡还没设 3D 模型：右键「设置 3D 模型…」或 block_update 写 model");
  }
  const models = await invoke("model_library_list").catch(() => []);
  if (!models.some((one) => one.name === product.model)) {
    throw new Error(`模型库里没有 ${product.model}，去设置窗口「3D 模型库」导入`);
  }
  let floors = scene.surfaces.filter((one) => one.kind === "floor");
  if (!scene.parts.length && !floors.length && !options.surface) {
    const [floor] = sceneSurfacesOf([{ id: "ground", name: "地面", kind: "floor", w: 1000, h: 1000 }]);
    scene.surfaces.push(floor);
    floors = [floor];
  }
  const surface = options.surface
    ? floors.find((one) => one.id === options.surface)
    : floors.length === 1 ? floors[0] : null;
  if (!surface) throw new Error("请先配置地面附着面；多个地面时用 surface 指定放入哪个区域");
  const dims = product.dims || {};
  const part = {
    op: "model",
    group: newId(),
    surface: surface.id,
    src: product.model,
    x: Number.isFinite(Number(options.x)) ? Number(options.x) : surface.x,
    y: Number.isFinite(Number(options.y)) ? Number(options.y) : surface.y,
    z: surface.z,
    rotate: Number.isFinite(Number(options.rotate)) ? Number(options.rotate) : 0,
    w: dims.w > 0 ? dims.w / 10 : 0,
    d: dims.d > 0 ? dims.d / 10 : 0,
    h: dims.h > 0 ? dims.h / 10 : 0,
    name: product.name,
    color: "",
  };
  if (!part.h) part.h = 80;
  const got = normalizeSceneParts([part]);
  if (got.dropped.length) throw new Error(got.dropped[0].why);
  scene.parts = [...scene.parts, got.parts[0]];
  persistScene(scene);
  const el = itemEls.get(scene.id);
  if (el) syncItemElement(el, scene);
  scheduleItemsSave();
  return { ...agentSummary(scene), placed: product.model, partIndex: scene.parts.length - 1 };
}

export async function agentScenePlaceProduct(spec = {}) {
  agentRequireSpace();
  const scene = agentRequireItem(spec.scene);
  const product = agentRequireItem(spec.product);
  return placeProductInScene(product, scene, spec);
}

/* 把产品卡的图当材质贴到场景的某个实体面上：地板、墙、柜子都行，模型件不接 */
export function agentSceneApplyMaterial(spec = {}) {
  const item = agentRequireItem(spec.scene);
  if (item.type !== "scene") throw new Error("scene 要传场景块");
  const target = spec.target;
  let part = null;
  if (target !== undefined && target !== "" && /^\d+$/.test(String(target))) {
    part = item.parts[Number(target)] || null;
  } else {
    const needle = String(target || "").trim();
    if (needle) part = item.parts.find((one) => (one.name || "").includes(needle)) || null;
  }
  if (!part) {
    throw new Error("找不到要贴的面：target 给 parts 序号或件名（地板 / 背景墙 / 侧墙 / 边柜 / 地毯）");
  }
  if (part.op === "model") throw new Error("模型件不能贴材质图；要换材质请直接改模型");
  if (spec.clear === true) {
    delete part.tex;
    delete part.texRepeat;
  } else {
    const product = agentRequireItem(spec.product);
    if (product.type !== "product") throw new Error("product 要传产品卡");
    if (!product.src) throw new Error("这张产品卡还没有图：先给它换一张材质图");
    part.tex = product.src;
    const repeat = Number(spec.repeat);
    part.texRepeat = Number.isFinite(repeat) && repeat >= 10 ? repeat : 100;
  }
  persistScene(item);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return { ...agentSummary(item), target: part.name || String(target), tex: part.tex || "" };
}

export async function placeProductInSceneFlow(product, scene) {
  try {
    await placeProductInScene(product, scene);
    showToast("已放进场景");
  } catch (error) {
    showError(error);
  }
}

export function newSceneForProduct(product) {
  const scene = makeScene(product.x + product.w + 40, product.y, 720, 480);
  placeBlock(scene);
  persistScene(scene);
  void placeProductInSceneFlow(product, scene);
}

/* 产品卡选模型：菜单里列模型库里的 .glb，选完只改卡上的 model 字段 */
export async function pickProductModel(item) {
  const models = await invoke("model_library_list").catch(() => []);
  const el = itemEls.get(item.id);
  const r = el ? el.getBoundingClientRect() : { left: 200, top: 200 };
  const entries = models.length
    ? models.map((model) => ({
        label: `${model.name}${model.name === item.model ? " ✓" : ""}`,
        thumb: modelThumbnail(model.name),
        onClick: () => {
          item.model = model.name;
          scheduleItemsSave();
          showToast(`模型：${model.name}`);
        },
      }))
    : [{ label: "模型库还没有 .glb（去设置窗口导入）", disabled: true }];
  openMenu(r.left + 24, r.top + 24, entries, { label: "3D 模型", searchable: true });
}

/* ---------- 场景里从模型库加家具 ---------- */

export const modelThumbCache = new Map();
/* 模型库缩略图：同一份只渲一次，失败给空串（菜单里显示占位块） */
export function modelThumbnail(name) {
  if (!modelThumbCache.has(name)) {
    modelThumbCache.set(name, renderModelThumbnail(name).catch(() => ""));
  }
  return modelThumbCache.get(name);
}

export async function addSceneModelFlow(scene) {
  const models = await invoke("model_library_list").catch(() => []);
  const el = itemEls.get(scene.id);
  const r = el ? el.getBoundingClientRect() : { left: 200, top: 200 };
  const entries = models.length
    ? models.map((model) => ({
        label: model.name,
        thumb: modelThumbnail(model.name),
        onClick: () => void addSceneModel(scene, model.name),
      }))
    : [{ label: "模型库还没有 .glb（去设置窗口「3D 模型库」导入）", disabled: true }];
  openMenu(r.left + 24, r.top + 24, entries, { label: "从模型库添加", searchable: true });
}

/* 删掉地板之后能加回来：一张 6.2×5.2m 的地板 + 地面附着面（没有才补，不重复加） */
export function addSceneFloor(item) {
  if (item.parts.some((part) => part.name === "地板")) {
    showError("场景里已经有地板了");
    return;
  }
  let surfaces = item.surfaces;
  if (!surfaces.some((one) => one.kind === "floor")) {
    surfaces = sceneSurfacesOf([
      ...surfaces,
      { id: "floor", name: "地面", kind: "floor", x: 0, y: 0, z: 2, w: 608, h: 508 },
    ]);
  }
  const got = normalizeSceneParts([
    ...item.parts,
    { op: "box", x: 0, y: 0, z: 0, w: 620, d: 520, h: 2, color: "#b98a5e", name: "地板" },
  ]);
  if (got.dropped.length) {
    showError(got.dropped[0].why);
    return;
  }
  scenePatch(item, { parts: got.parts, surfaces });
  setSceneFurnitureSelection(sceneView(item), [item.parts.length - 1]);
  showToast("已添加地板");
}

/* 把模型库里的一份 .glb 放进场景：没有地面就补一块 10m 地面，
   加完直接进摆放模式并选中这件，用户可以马上拖着摆位置。 */
export async function addSceneModel(scene, name) {
  try {
    let floor = scene.surfaces.find((one) => one.kind === "floor");
    if (!floor) {
      const list = sceneSurfacesOf([
        ...scene.surfaces,
        { id: "ground", name: "地面", kind: "floor", w: 1000, h: 1000 },
      ]);
      scene.surfaces = list;
      floor = list.find((one) => one.kind === "floor");
    }
    const part = {
      op: "model",
      group: newId(),
      surface: floor.id,
      src: name,
      x: floor.x,
      y: floor.y,
      z: floor.z,
      rotate: 0,
      w: 0,
      d: 0,
      h: 80,
      name: String(name).replace(/\.glb$/i, ""),
      color: "",
    };
    const got = normalizeSceneParts([...scene.parts, part]);
    if (got.dropped.length) throw new Error(got.dropped[0].why);
    scene.parts = got.parts;
    persistScene(scene);
    const el = itemEls.get(scene.id);
    if (el) syncItemElement(el, scene);
    scheduleItemsSave();
    /* 直接进入摆放模式并选中新加的这件：拖动就能挪位置 */
    setScenePlacementMode(scene, true);
    setSceneFurnitureSelection(sceneView(scene), [scene.parts.length - 1]);
    showToast(`已加入 ${part.name}，拖动它摆位置`);
    return { index: scene.parts.length - 1, name: part.name };
  } catch (error) {
    showError(error);
    return null;
  }
}

/* ---------- 参数化家具 ---------- */

export const FURNITURE_COLORS = [
  { label: "浅木", value: "#d2b48c" },
  { label: "原木", value: "#b98a5e" },
  { label: "深木", value: "#8a6f55" },
  { label: "白", value: "#ece7de" },
  { label: "灰", value: "#9aa0a6" },
  { label: "黑", value: "#3c3f43" },
];

/* 按参数拼零件：全部以原点为中心、底面 z=0（调用方再平移到放置点）。
   每件家具的零件共用一个 group，拖动时整体一起走。 */
export function buildFurnitureParts(spec) {
  const W = spec.w;
  const D = spec.d;
  const H = spec.h;
  const color = spec.color;
  /* 基础几何体：一块方块，或一个圆柱/球/圆锥 */
  if (["box", "cylinder", "sphere", "cone", "torus", "capsule"].includes(spec.kind)) {
    if (spec.kind === "box") {
      return [{ op: "box", x: 0, y: 0, z: 0, w: W, d: D, h: H, color, name: "方块" }];
    }
    const name = { cylinder: "圆柱", sphere: "球体", cone: "圆锥", torus: "圆环", capsule: "胶囊" }[spec.kind];
    return [{ op: "solid", shape: spec.kind, x: 0, y: 0, z: 0, w: W, d: D, h: H, color, name }];
  }
  const parts = [];
  if (spec.kind === "cabinet") {
    const legH = spec.leg;
    const bodyH = Math.max(20, H - legH);
    parts.push({ op: "box", x: 0, y: 0, z: legH, w: W, d: D, h: bodyH, color, name: "柜体" });
    if (spec.doors > 0) {
      const gap = 2;
      const side = 2;
      const td = 2;
      const dw = (W - side * 2 - gap * (spec.doors - 1)) / spec.doors;
      const dh = Math.max(10, bodyH - 4);
      for (let i = 0; i < spec.doors; i += 1) {
        const x = -W / 2 + side + dw / 2 + i * (dw + gap);
        parts.push({ op: "box", x, y: -D / 2 - td / 2, z: legH + 2, w: dw, d: td, h: dh, color, name: "柜门" });
        parts.push({
          op: "box",
          x,
          y: -D / 2 - td - 1,
          z: legH + 2 + dh / 2 - 5,
          w: 2,
          d: 2,
          h: 10,
          color: "#6b6f74",
          name: "把手",
        });
      }
    }
    if (legH > 0) {
      const lx = W / 2 - 5;
      const ly = D / 2 - 5;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        parts.push({ op: "box", x: sx * lx, y: sy * ly, z: 0, w: 5, d: 5, h: legH, color: "#6b5138", name: "柜腿" });
      }
    }
    return parts;
  }
  /* 桌子：桌面 + 四条腿 */
  parts.push({ op: "box", x: 0, y: 0, z: H - 4, w: W, d: D, h: 4, color, name: "桌面" });
  const lx = W / 2 - 5;
  const ly = D / 2 - 5;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    parts.push({ op: "box", x: sx * lx, y: sy * ly, z: 0, w: 5, d: 5, h: H - 4, color, name: "桌腿" });
  }
  return parts;
}

export function openFurnitureDialog() {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog dialog-furniture" role="dialog" aria-modal="true">
        <p class="dialog-title">新建模型</p>
        <button class="dialog-close" type="button" aria-label="关闭">${CLOSE_X_SVG}</button>
        <div class="furn-row">
          <span>模板</span>
          <select data-furn="kind"><option value="cabinet">柜子</option><option value="table">桌子</option><option value="box">方块</option><option value="cylinder">圆柱</option><option value="sphere">球体</option><option value="cone">圆锥</option><option value="torus">圆环</option><option value="capsule">胶囊</option></select>
        </div>
        <div class="furn-row">
          <span>宽</span><input data-furn="w" type="number" value="160" min="40" max="320" step="1" /><em>cm</em>
        </div>
        <div class="furn-row">
          <span>深</span><input data-furn="d" type="number" value="45" min="20" max="120" step="1" /><em>cm</em>
        </div>
        <div class="furn-row">
          <span>高</span><input data-furn="h" type="number" value="80" min="20" max="240" step="1" /><em>cm</em>
        </div>
        <div class="furn-row" data-furn-row="cabinet">
          <span>柜门</span>
          <select data-furn="doors"><option value="0">无门</option><option value="1">1 扇</option><option value="2" selected>2 扇</option><option value="3">3 扇</option><option value="4">4 扇</option></select>
        </div>
        <div class="furn-row" data-furn-row="cabinet">
          <span>腿高</span>
          <select data-furn="leg"><option value="0">落地</option><option value="10" selected>10 cm</option><option value="15">15 cm</option></select>
        </div>
        <div class="furn-row">
          <span>颜色</span>
          <div class="furn-colors">${FURNITURE_COLORS.map(
            (color, index) =>
              `<button type="button" class="furn-color${index === 1 ? " is-active" : ""}" data-color="${color.value}" title="${color.label}" style="--c:${color.value}"></button>`,
          ).join("")}</div>
        </div>
        <label class="furn-save"><input type="checkbox" data-furn="save" /> 同时存进模型库（下次直接从库里摆）</label>
        <div class="furn-actions"><button class="plain-btn furn-ok" type="button">放到场景</button></div>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    const finish = (value) => {
      mask.remove();
      resolve(value);
    };
    const kindSel = mask.querySelector('[data-furn="kind"]');
    /* 每类模板一套默认尺寸；切到基础几何体时把柜门/腿高行收起来 */
    const KIND_PRESETS = {
      cabinet: { w: 160, d: 45, h: 80, cabinet: true },
      table: { w: 140, d: 70, h: 75, cabinet: false },
      box: { w: 100, d: 100, h: 100, cabinet: false },
      cylinder: { w: 80, d: 80, h: 120, cabinet: false },
      sphere: { w: 100, d: 100, h: 100, cabinet: false },
      cone: { w: 100, d: 100, h: 120, cabinet: false },
      torus: { w: 100, d: 100, h: 30, cabinet: false },
      capsule: { w: 60, d: 60, h: 120, cabinet: false },
    };
    const syncKind = () => {
      const preset = KIND_PRESETS[kindSel.value] || KIND_PRESETS.cabinet;
      for (const row of mask.querySelectorAll('[data-furn-row="cabinet"]')) row.hidden = !preset.cabinet;
      const set = (key, value) => {
        const input = mask.querySelector(`[data-furn="${key}"]`);
        if (input) input.value = String(value);
      };
      set("w", preset.w);
      set("d", preset.d);
      set("h", preset.h);
    };
    kindSel.addEventListener("change", syncKind);
    syncKind();
    mask.addEventListener("click", (e) => {
      const dot = e.target.closest?.(".furn-color");
      if (!dot) return;
      for (const one of mask.querySelectorAll(".furn-color")) {
        one.classList.toggle("is-active", one === dot);
      }
    });
    mask.querySelector(".dialog-close").addEventListener("click", () => finish(null));
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) finish(null);
    });
    mask.querySelector(".furn-ok").addEventListener("click", () => {
      const read = (key, fallback) => {
        const input = mask.querySelector(`[data-furn="${key}"]`);
        const value = Number(input?.value);
        return Number.isFinite(value) ? value : fallback;
      };
      finish({
        kind: KIND_PRESETS[kindSel.value] ? kindSel.value : "cabinet",
        w: Math.min(320, Math.max(40, Math.round(read("w", 160)))),
        d: Math.min(120, Math.max(20, Math.round(read("d", 45)))),
        h: Math.min(240, Math.max(20, Math.round(read("h", 80)))),
        doors: Number(mask.querySelector('[data-furn="doors"]').value) || 0,
        leg: Number(mask.querySelector('[data-furn="leg"]').value) || 0,
        color: mask.querySelector(".furn-color.is-active")?.dataset.color || "#b98a5e",
        save: mask.querySelector('[data-furn="save"]').checked,
      });
    });
    document.body.append(mask);
  });
}

export async function createFurnitureFlow(scene) {
  const spec = await openFurnitureDialog();
  if (!spec) return;
  try {
    const result = await applyFurniture(scene, spec);
    if (spec.save) showToast(`已放进场景，并存进模型库：${result.saved}`);
    else showToast("已放进场景，拖动它摆位置");
  } catch (error) {
    showError(error);
  }
}

/* 生成 + 摆进场景 +（可选）入库；返回 {start, count, saved}，MCP 也走这条。 */
export async function applyFurniture(scene, spec) {
  const rel = buildFurnitureParts(spec);
  let floor = scene.surfaces.find((one) => one.kind === "floor");
  if (!floor) {
    const list = sceneSurfacesOf([
      ...scene.surfaces,
      { id: "ground", name: "地面", kind: "floor", w: 1000, h: 1000 },
    ]);
    scene.surfaces = list;
    floor = list.find((one) => one.kind === "floor");
  }
  const groupId = newId();
  const placed = rel.map((part) => ({
    ...part,
    group: groupId,
    surface: floor.id,
    x: part.x + floor.x,
    y: part.y + floor.y,
    z: part.z + floor.z,
  }));
  const got = normalizeSceneParts([...scene.parts, ...placed]);
  if (got.dropped.length) throw new Error(got.dropped[0].why);
  scene.parts = got.parts;
  persistScene(scene);
  const el = itemEls.get(scene.id);
  if (el) syncItemElement(el, scene);
  scheduleItemsSave();
  const start = scene.parts.length - rel.length;
  const indices = rel.map((_, k) => start + k);
  setScenePlacementMode(scene, true);
  setSceneFurnitureSelection(sceneView(scene), indices);
  let saved = "";
  if (spec.save) {
    const buffer = await exportPartsGLB(rel);
    const name = {
      cabinet: "参数柜",
      table: "参数桌",
      box: "方块",
      cylinder: "圆柱",
      sphere: "球体",
      cone: "圆锥",
      torus: "圆环",
      capsule: "胶囊",
    }[spec.kind] || "模型";
    const file = await store.modelLibrarySave(name, bufferToBase64(buffer));
    saved = file.name;
  }
  return { start, count: rel.length, saved };
}

/* ---------- 场景导出 GLB ---------- */

export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function exportSceneFlow(item) {
  try {
    const buffer = await exportSceneGLB(sceneView(item));
    const base = current?.meta.name || "场景";
    const suffix = item.seq ? `-#${item.seq}` : "";
    const name = `${base}${suffix}.glb`;
    const data = bufferToBase64(buffer);
    const path = await store.exportSaveFile(name, data);
    if (path) showToast(`已导出：${path}`);
  } catch (error) {
    showError(error);
  }
}
