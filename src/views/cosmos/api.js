/* 从 cosmos.js 拆出：对外接口与生命周期 */

import { FLARE_MAX_PX, MINUTES_MAX, MINUTES_MIN, PACE_KEY, PLANET_DEFS, ROUTE, ROUTE_KEY, TEX_NAMES, TEX_URLS, TYPES, parseMinutes, parseOrder, writeStored } from "./constants.js";
import { gotoBody, resetFlight, skipEncounter, warpBody } from "./flight.js";
import { hashString, normalize3, vecLen, vecSub } from "./math.js";
import { frame } from "./render.js";
import { buildStars } from "./stars.js";
import { state } from "./state.js";
import { dropHiRes, initResources, loadTexture, refreshPack } from "./textures.js";
import { describeBody, describeFocus, pitchOf } from "./view.js";

/* ---------- 对外接口 ---------- */

export function initCosmos() {
  if (state.canvas) return;
  const canvas = document.getElementById("canvas-cosmos");
  if (!canvas) return;
  state.canvas = canvas;
  const stage = canvas.parentElement;
  new ResizeObserver(() => {
    if (state.ok) resize();
  }).observe(stage);
  document.addEventListener("themechange", (event) => {
    const id = event.detail?.id ?? event.detail;
    if (id === "cosmos") activate();
    else deactivate();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopLoop();
    else if (state.active) startLoop();
  });
  /* theme.js 在模块加载时就套好了主题，这里补一次首帧判断 */
  if (document.documentElement.dataset.theme === "cosmos") activate();
}

/* 设置窗口下载完或清除完 8K 会广播这一条：正在飞的航线下一颗就该用新档位 */
window.addEventListener("cosmos-textures-changed", () => {
  dropHiRes();
  refreshPack();
});

/* canvas.js 的 applyCamera 每次相机变化都会推过来；这里只当头部偏移用 */
export function setCosmosCamera(camera) {
  state.cam.x = camera.x;
  state.cam.y = camera.y;
  state.cam.scale = camera.scale;
  state.camKnown = true;
}

/* 换画布等于换一段航线：星野重铺、星体重新沿新航线摆 */
export function setCosmosSeed(id) {
  state.pendingSeed = id || "inspace";
  if (!state.ok) return;
  const seed = hashString(state.pendingSeed);
  if (seed === state.seed) return;
  state.seed = seed;
  buildStars();
  resetFlight();
}

/* 飞行状态给 MCP 工具看 */
export function cosmosFlight() {
  const f = state.flight;
  if (!f) return { phase: "idle", paused: false, pitch: 0, bodies: [] };
  return {
    phase: f.phase,
    paused: f.paused,
    speed: Math.round(f.speed),
    travelled: Math.round(f.travelled),
    pitch: pitchOf(normalize3(f.view)),
    focus: describeFocus(f),
    ahead: f.bodies
      .map((b) => describeBody(b, f))
      .filter((b) => b !== null)
      .sort((a, b) => a.distance - b.distance),
    /* hi = 本机下好了几张 8K；resident = 此刻躺在显存里的几张，空的就是在用内置 2K */
    textures: { hi: state.pack ? state.pack.size : 0, resident: [...state.hi.keys()] },
  };
}

/* 航线名单和遭遇间隔：设置窗口读这一份、写也从这一份走，MCP 用的是同一个口子，
   所以 agent 改完，用户在设置窗口能当场看到一样的值 */
export function cosmosRoute() {
  return {
    order: [...ROUTE.order],
    minutes: ROUTE.minutes,
    range: [MINUTES_MIN, MINUTES_MAX],
    types: TYPES.map((type) => ({ type, name: PLANET_DEFS[type].name })),
  };
}

export function cosmosRouteSet(order, minutes) {
  const before = ROUTE.order.join(",");
  if (order !== undefined && order !== null) ROUTE.order = parseOrder([].concat(order).join(","));
  if (minutes !== undefined && minutes !== null) ROUTE.minutes = parseMinutes(minutes);
  writeStored(ROUTE_KEY, ROUTE.order.join(","));
  writeStored(PACE_KEY, String(ROUTE.minutes));
  if (ROUTE.order.join(",") !== before) requeuePending();
  /* 设置窗口正开着时也让它跟着重画：agent 从 MCP 改的，用户要当场看见 */
  window.dispatchEvent(new CustomEvent("cosmos-route-changed"));
  return cosmosRoute();
}

/* 名单换了，把还没长成球的那些按新名单从头排一遍。
   正在绕的、已经在画面上成面的都不动：换类型等于换半径和贴图，那是一帧之内的跳变；
   还只是一枚亮星的远处那颗可以悄悄换，屏幕上也看不出它换了。
   排队指针跟着挪，所以改完下一个遇到的就是名单第一颗，不用等前方备着的几颗走完。 */
export function requeuePending() {
  const f = state.flight;
  /* 第一帧还没跑时算不出焦距，判不了谁只是枚亮点；那会儿屏幕上也还空着 */
  if (!f || !state.proj) return;
  const pending = f.bodies
    .filter((b) => b !== f.focus && !b.visited)
    .sort((a, b) => vecLen(vecSub(a.pos, f.pos)) - vecLen(vecSub(b.pos, f.pos)));
  let i = 0;
  for (const b of pending) {
    const type = ROUTE.order[i % ROUTE.order.length];
    /* 换完还是亮星才允许换：木星最小的一颗换到地球能胀到 2.8 倍，
       近处那颗会当场从一枚点闪成一张面，那是用户盯着的方向 */
    if (!stillFlare(b, f, type)) break;
    retypeBody(b, type);
    i += 1;
  }
  f.queue = i;
}

export function stillFlare(b, f, becomes) {
  const d = vecLen(vecSub(b.pos, f.pos));
  if (d < 1) return false;
  /* 换类型等于换大小，按新档的最大半径判：木星最小那颗换成地球能胀到 2.8 倍 */
  const r = Math.max(b.r, PLANET_DEFS[becomes].size[1]);
  return (r / d) * state.proj.focal < FLARE_MAX_PX;
}

export function retypeBody(b, type) {
  if (b.type === type) return;
  const def = PLANET_DEFS[type];
  b.type = type;
  const [lo, hi] = def.size;
  b.r = lo + b.rnd() * (hi - lo);
  /* 倾角也得跟着换：土星的环按倾角张开，留着木星的 0.05 就成一条压扁的线 */
  b.tilt = def.tilt + (b.rnd() - 0.5) * 0.3;
}

export const ACTION_HINTS =
  "pause 停住看当前这颗；resume 接着飞；skip 结束绕飞或跳过没追上的目标，立刻启程去下一颗；goto {body|type} 追某一颗（body 用 ahead 里的 id，type 是 earth/moon/mars/jupiter/saturn）；warp {body|type} 直接挪到某一颗旁边，不再飞几分钟的路";

/* 飞行控制：MCP 工具调这个，界面手势以后也能调 */
export function cosmosFlightControl(action, arg, distance) {
  const f = state.flight;
  if (!f) return { ok: false, note: "宇宙主题还没激活" };
  const kind = String(action || "").trim().toLowerCase();
  switch (kind) {
    case "pause":
      f.paused = true;
      break;
    case "resume":
      f.paused = false;
      break;
    case "skip":
      skipEncounter();
      break;
    case "goto":
      return gotoBody(arg);
    case "warp":
      return warpBody(arg, distance);
    default:
      throw new Error(`不认识的飞行操作：${kind || "(空)"}；可用 pause / resume / skip / goto / warp。${ACTION_HINTS}`);
  }
  return { ok: true, action: kind, ...cosmosFlight() };
}

/* ---------- 生命周期 ---------- */

export function ensureGL() {
  if (state.ok) return true;
  const canvas = state.canvas;
  if (!canvas) return false;
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    depth: true,
    powerPreference: "high-performance",
  });
  if (!gl) {
    canvas.hidden = true;
    console.warn("WebGL2 不可用，宇宙主题退回普通底色");
    return false;
  }
  state.gl = gl;
  /* 8K 传不上去会变成一张黑贴图，先问清楚这张卡能吃多大 */
  state.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  try {
    initResources(gl);
  } catch (error) {
    canvas.hidden = true;
    console.error("宇宙背景初始化失败：", error);
    return false;
  }
  state.ok = true;
  state.seed = hashString(state.pendingSeed || "inspace");
  buildStars();
  resetFlight();
  return true;
}

export function activate() {
  if (!state.canvas || state.active) return;
  if (!ensureGL()) return;
  state.active = true;
  state.canvas.hidden = false;
  resize();
  if (!state.flight) resetFlight();
  ensureTextures();
  refreshPack();
  state.last = performance.now();
  startLoop();
}

export function deactivate() {
  if (!state.active) return;
  state.active = false;
  stopLoop();
  state.canvas.hidden = true;
}

export function startLoop() {
  if (state.raf) return;
  state.last = performance.now();
  state.raf = requestAnimationFrame(frame);
}

export function stopLoop() {
  if (!state.raf) return;
  cancelAnimationFrame(state.raf);
  state.raf = 0;
}

export function resize() {
  if (!state.canvas) return;
  const stage = state.canvas.parentElement;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (w === state.w && h === state.h && dpr === state.dpr) return;
  state.w = w;
  state.h = h;
  state.dpr = dpr;
  state.canvas.width = Math.max(1, Math.round(w * dpr));
  state.canvas.height = Math.max(1, Math.round(h * dpr));
}

export function ensureTextures() {
  if (state.texturesStarted) return;
  state.texturesStarted = true;
  for (const name of TEX_NAMES) {
    loadTexture(TEX_URLS[name])
      .then((tex) => state.textures.set(name, tex))
      .catch(() => state.textures.set(name, null));
  }
}
