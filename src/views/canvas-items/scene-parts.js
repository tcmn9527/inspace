/* canvas-items/scene-parts.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { CARD_DEFAULT_BORDER_WIDTH, CARD_DEFAULT_RADIUS, DEFAULT_BORDER, SCENE_DEFAULT_HEIGHT, SCENE_DEFAULT_WIDTH, SCENE_MAX_PARTS, SCENE_MAX_POLY_POINTS, SCENE_MAX_SIZE } from "./constants.js";
import { normalizePicturePoints } from "./picture.js";
import { clamp, colorOr, newId, num } from "./util.js";

export function sceneRing(label, raw) {
  const got = normalizePicturePoints(raw.points, SCENE_MAX_POLY_POINTS);
  if (got.why) return { why: `${label} 的 points 读不出来：${got.why}` };
  if (got.points.some((p) => p.c1 || p.c2)) {
    return { why: `${label} 的底面只吃折线，点里别写 c1 / c2（要圆弧就多取几个点）` };
  }
  const points = [];
  for (const p of got.points) {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    points.push(p);
  }
  if (points.length > 2) {
    const [a, b] = [points[0], points[points.length - 1]];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) points.pop();
  }
  if (points.length < 3) {
    return { why: `${label} 的底面至少要 3 个不重复的点才围得出面（现在 ${points.length} 个）` };
  }
  return { points };
}

/* 场景里的一件东西。落点永远是它底面那个点，h 往上立起来。
   box 是长方体；poly 是把一条闭合平面轮廓沿 h 挤成真棱柱——任意形状的房子、
   带天井的院落、L 形的街面都靠它；roof 是同一圈底面立成一个屋顶。
   轮廓的点相对 (x, y)，rotate 绕 (x, y) 转。
   坐标是地上的：x 左右、y 往画面里去（越大越远）、z 底面离地多高、h 立起来多高。 */
export function normalizeScenePart(raw) {
  if (!raw || typeof raw !== "object") return { why: "不是对象" };
  /* 先认 op 再挑毛病：一件「sphere」报「h 得是正数」，写的人会被带去改 h，改完还是不认 */
  if (raw.op !== "box" && raw.op !== "poly" && raw.op !== "roof" && raw.op !== "model" && raw.op !== "solid" && raw.op !== "mesh") {
    return { why: `op「${String(raw.op).slice(0, 12)}」不认：现在只有 "box"（长方体）、"poly"（底面轮廓 + h 挤成真棱柱）、"roof"（底面轮廓 + h 立成屋顶）、"solid"（圆柱/球/圆锥/圆环/胶囊）、"mesh"（任意三角网格）和 "model"（模型库里的 GLB）` };
  }
  /* 落点：永远指底面那个中心点，h 从这儿往上立起来。轮廓里的点相对它，rotate 绕它转。 */
  const foot = {
    x: num(raw.x), y: num(raw.y), z: Math.max(0, num(raw.z)),
    group: typeof raw.group === "string" ? raw.group.trim().slice(0, 128) : "",
    surface: typeof raw.surface === "string" ? raw.surface.trim().slice(0, 128) : "",
  };
  const rotate = Number(raw.rotate);
  if (raw.op === "model") {
    const src = typeof raw.src === "string" ? raw.src.trim() : "";
    if (!src || src.includes("/") || src.includes("\\") || src.startsWith(".")) {
      return { why: "model 的 src 只写模型库里的 .glb 文件名（不带路径、不能以点开头）" };
    }
    /* 尺寸是「期望的真实尺寸（厘米）」：模型自带的单位五花八门，渲染器按它等比缩放。
       w/d/h 都可省：省了就按高 80cm 放。 */
    const w = Number(raw.w);
    const d = Number(raw.d);
    const h = Number(raw.h);
    const scale = Number(raw.scale);
    return {
      part: {
        op: "model",
        ...foot,
        src,
        w: w > 0 ? Math.min(w, SCENE_MAX_SIZE) : 0,
        d: d > 0 ? Math.min(d, SCENE_MAX_SIZE) : 0,
        h: h > 0 ? Math.min(h, SCENE_MAX_SIZE) : 80,
        scale: scale > 0 ? scale : 1,
        rotate: Number.isFinite(rotate) ? ((rotate % 360) + 360) % 360 : 0,
        color: colorOr(raw.color, ""),
        name: typeof raw.name === "string" ? raw.name : "",
      },
    };
  }
    /* 任意三角网格：positions 是扁平 [x,y,z,...]（three 坐标、y 向上、原点即落点），
     indices 可省（省了就按顶点顺序三角化）。上下限挡住离谱数据把内存打爆 */
  if (raw.op === "mesh") {
    const positions = Array.isArray(raw.positions) ? raw.positions.map(Number) : null;
    if (!positions || positions.length < 9 || positions.length % 3 !== 0 || positions.length > 90000) {
      return { why: "mesh 的 positions 要是扁平数组 [x,y,z,...]：至少一个三角形，长度是 3 的倍数、不超过 90000" };
    }
    if (!positions.every(Number.isFinite)) return { why: "mesh 的 positions 里有不是数的坐标" };
    const rawIndices = Array.isArray(raw.indices) ? raw.indices.map((n) => Math.trunc(Number(n))) : null;
    if (rawIndices) {
      if (rawIndices.length < 3 || rawIndices.length % 3 !== 0 || rawIndices.length > 180000) {
        return { why: "mesh 的 indices 至少一个三角形，长度是 3 的倍数、不超过 180000" };
      }
      const count = positions.length / 3;
      if (!rawIndices.every((n) => Number.isInteger(n) && n >= 0 && n < count)) {
        return { why: "mesh 的 indices 越界：每个下标都要落在顶点范围内" };
      }
    }
    const rotate = Number(raw.rotate);
    return {
      part: {
        op: "mesh",
        ...foot,
        positions,
        indices: rawIndices,
        rotate: Number.isFinite(rotate) ? ((rotate % 360) + 360) % 360 : 0,
        color: colorOr(raw.color, ""),
        name: typeof raw.name === "string" ? raw.name : "",
      },
    };
  }

  const h = Number(raw.h);
  if (!(h > 0) || h > SCENE_MAX_SIZE) {
    return { why: `h（立起来多高）得是正数、不超过 ${SCENE_MAX_SIZE}（现在是 ${String(raw.h).slice(0, 12)}）` };
  }
  const body = {
    h,
    rotate: Number.isFinite(rotate) ? ((rotate % 360) + 360) % 360 : 0,
    color: colorOr(raw.color, ""),
    name: typeof raw.name === "string" ? raw.name : "",
    /* 材质：画布 images/ 里的图片路径 + 每格多少厘米；空串就是纯色 */
    tex: typeof raw.tex === "string" ? raw.tex : "",
    texRepeat: Math.max(10, Math.min(2000, num(raw.texRepeat, 100))),
  };
  const rect = () => {
    const w = Number(raw.w);
    const d = Number(raw.d);
    /* 尺寸写歪（0 / 负 / 不是数）整件丢掉：一个零高的长方体不是「一片地」，是画错了 */
    if (!(w > 0) || !(d > 0) || w > SCENE_MAX_SIZE || d > SCENE_MAX_SIZE) {
      return { why: `${raw.op} 的 w / d 得是正数、不超过 ${SCENE_MAX_SIZE}（现在 w=${String(raw.w).slice(0, 12)} d=${String(raw.d).slice(0, 12)}）` };
    }
    return { w, d };
  };
  if (raw.op === "box") {
    const got = rect();
    if (got.why) return got;
    return { part: { op: "box", ...foot, w: got.w, d: got.d, ...body } };
  }
  /* 基础几何体：圆柱 / 球 / 圆锥（w/d 是底面两个方向的直径，h 是高度） */
  if (raw.op === "solid") {
    const got = rect();
    if (got.why) return got;
    const shape = ["cylinder", "sphere", "cone", "torus", "capsule"].includes(raw.shape) ? raw.shape : "cylinder";
    return { part: { op: "solid", ...foot, shape, w: got.w, d: got.d, ...body } };
  }
  if (raw.op === "poly") {
    const got = sceneRing("poly", raw);
    if (got.why) return got;
    return { part: { op: "poly", ...foot, points: got.points, ...body } };
  }
  /* 屋顶：底面一圈 + h，脊长 ridge 决定它是哪一种——
     ridge = w 是双坡（悬山 / 硬山），0 < ridge < w 是四阿 / 庑殿，ridge = 0 是四角攒尖；
     底面写成 points（八角、六角）就是那个多边形的攒尖。一套几何全包，不用三种 op。 */
  if (raw.points != null) {
    const got = sceneRing("roof", raw);
    if (got.why) return got;
    if (raw.ridge != null) {
      return { why: "roof 的底面写成 points 就是攒尖（顶上收成一个尖），没有脊长可写" };
    }
    return { part: { op: "roof", ...foot, points: got.points, ...body } };
  }
  const got = rect();
  if (got.why) return got;
  const ridge = num(raw.ridge, got.w);
  if (!(ridge >= 0) || ridge > got.w) {
    return { why: `roof 的 ridge（脊长）得在 0 ~ w=${got.w} 之间：0 是攒尖、${got.w} 是双坡、中间是四阿（现在是 ${String(raw.ridge).slice(0, 12)}）` };
  }
  return { part: { op: "roof", ...foot, w: got.w, d: got.d, ridge, ...body } };
}

export function normalizeSceneSurfaces(value) {
  const surfaces = [];
  const dropped = [];
  const ids = new Set();
  for (const [at, raw] of (Array.isArray(value) ? value : []).entries()) {
    const id = typeof raw?.id === "string" ? raw.id.trim().slice(0, 128) : "";
    const kind = raw?.kind;
    const w = Number(raw?.w);
    const h = Number(raw?.h);
    const coordinates = [raw?.x ?? 0, raw?.y ?? 0, raw?.z ?? 0, raw?.rotate ?? 0].map(Number);
    if (!id || ids.has(id) || !["floor", "wall"].includes(kind) ||
        !(w > 0 && w <= SCENE_MAX_SIZE && h > 0 && h <= SCENE_MAX_SIZE) ||
        !coordinates.every(Number.isFinite) || coordinates[2] < 0) {
      dropped.push({ at, why: "附着面需要唯一 id、floor/wall 类型、有效坐标和正数 w/h，z 不能低于地面" });
      continue;
    }
    const [x, y, z, rotate] = coordinates;
    ids.add(id);
    surfaces.push({ id, name: typeof raw.name === "string" ? raw.name.slice(0, 128) : id,
      kind, x, y, z, w, h, rotate: ((rotate % 360) + 360) % 360 });
  }
  return { surfaces, dropped };
}

export function normalizeSceneParts(value) {
  const list = Array.isArray(value) ? value : [];
  const parts = [];
  const dropped = [];
  for (const [k, raw] of list.entries()) {
    if (parts.length >= SCENE_MAX_PARTS) {
      dropped.push({ at: k, why: `场景里的东西最多 ${SCENE_MAX_PARTS} 件，多出来的没画` });
      continue;
    }
    const got = normalizeScenePart(raw);
    if (got.part) parts.push(got.part);
    /* 说清是第几件、哪儿不对：静默少一栋楼，下一轮根本不知道是谁写歪了 */
    else dropped.push({ at: k, why: `第 ${k} 件不认：${got.why}` });
  }
  return { parts, dropped };
}

/* 机位：绕着注视点转的球坐标，存角度不存相机位置——改窗口大小、挪块，机位都得稳。
   写歪了返回 null，让渲染器按内容自己框一个。 */
export function normalizeSceneCamera(value) {
  if (!value || typeof value !== "object") return null;
  const azim = Number(value.azim);
  const elev = Number(value.elev);
  const dist = Number(value.dist);
  if (!Number.isFinite(azim) || !Number.isFinite(elev) || !(dist > 0)) return null;
  return {
    azim: ((azim % 360) + 360) % 360,
    elev: clamp(elev, 2, 88),
    dist: clamp(dist, 1, SCENE_MAX_SIZE * 4),
    tx: num(value.tx),
    ty: num(value.ty),
    tz: num(value.tz),
    fov: clamp(num(value.fov, 45), 8, 100),
  };
}

/* ---------- 户型块 ---------- */

export const PLAN_CAMERA_PRESETS = ["front", "left", "right", "top", "auto"];
export const frac01 = (value) => Math.min(1, Math.max(0, num(value)));


export function makeScene(x, y, w = SCENE_DEFAULT_WIDTH, h = SCENE_DEFAULT_HEIGHT) {
  return {
    id: newId(),
    internal: true,
    type: "scene",
    x,
    y,
    w,
    h,
    parts: [],
    surfaces: [],
    camera: null,
    light: null,
    shadow: true,
    groundColor: "",
    grid: false,
    ortho: false,
    cameras: [],
    borderColor: DEFAULT_BORDER,
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 出图尺寸贴到 32 的倍数上：引擎的 latent 按 8 下采样、再 2×2 合块，差一个数整条调度就错位。 */
