/* 宇宙主题背景：一张全屏 WebGL2 画布，叠在空间底色上、块和连线层下面。
 *
 * 这里是一条自动航线：相机在三维宇宙里一直往前飞，一镜到底。
 *   星野   恒星钉在天球方向上，转头就换一片星空；近处尘埃有真实视差，飞起来往后掠。
 *   银河   等距圆柱银河贴图按视线方向采样，和星野共一个天穹。
 *   星体   世界坐标的球体，沿航线前方生成、飞过就回收。远处只有针尖大，越近越大；
 *          追上一颗就绕着它慢慢飞两圈看表面，看完顺切线方向接着飞。
 * 光照由世界里的太阳给主光、相机方向补光，绕飞时会看到明暗面和相位变化。
 *   贴图   内置 2K 保底；设置页下载过 8K 就换成 8K，显存里同一时刻只留镜头里这一颗的量。
 *
 * 工作区的平移/缩放只当「头部偏移」：小幅转头 + 长焦倍率，不打断航线。
 * 只有「宇宙」主题激活时才跑渲染循环；贴图第一次激活才加载。 */

const TEX_BASE = "/assets/cosmos/";
const invoke = window.__TAURI__?.core?.invoke ?? null;

/* 透视相机：近平面给得远一点，深度精度够用；远平面要罩得住星与星之间那段空档 */
/* 贴地绕飞时镜头离表面只有零点几倍星球半径，小的月球不到 15 个单位：
   近裁剪面必须比这个还小，不然脚下的地表被裁掉，看着像缺一块 */
const NEAR = 4;
const FAR = 160000;
const FOV_K = 1.05;
const HEAD_YAW = 0.26;
const HEAD_PITCH = 0.17;
const HEAD_MAG = 0.45;
const MAX_PITCH_Y = 0.8;

/* 航线：巡航故意慢，一场遭遇之间隔着一大段什么都不发生的空档 */
const CRUISE = 150;
/* 镜头转向的角速度（弧度/秒）。0.4 会让交接那一帧变成甩头，压慢之后
   再配上下面 LEAD 的预对准，交接时本来就没剩多少角度 */
const TURN_RATE = 0.16;
const ENGAGE = 20000;
/* 巡航路上提前开始把航线往那颗星体引，而不是等进遭遇圈才猛转 */
const LEAD = 30000;
/* 绕飞半径和最近贴法距离，都用星球半径的倍数说。
   垂直半视场约 43.6°：1.45 倍时地平线刚好压在画面上下边，
   1.3 倍时地表铺满正中、弧形地平线退到四角——低空掠过表面但又不至于看不出是个球 */
const ORBIT_K = 1.3;
const LAP_TIME = 68;
const CLOSEST_K = 1.12;
/* 地球分两段：头两圈退到 1.65 倍，把整颗球、大气边和昼夜线看全；
   这两圈走完再把目标半径收到 1.3 倍去掠地表。半径一直是按比例慢慢收的，
   换段只是目标值变了，不会出现一帧之内的跳 */
const EARTH_FAR_K = 1.65;
const EARTH_FAR_LAPS = 2;
const EARTH_NEAR_LAPS = 2;
/* 上轨不是瞬移：离到 1.8 倍轨道半径就开始收，头几秒仍然带着「往里飞」的动量，
   切向速度慢慢加进来，走成螺旋，免得背景流动一帧之内从「往前」换成「横着绕」 */
const ORBIT_ENTER_K = 1.8;
/* 星体一颗一颗沿航线摆：第一颗在多远、往后每颗隔多远。
   按巡航 150 算，追上下一颗要四到八分钟 */
const FIRST_MIN = 34000;
const FIRST_RANGE = 14000;
const GAP_MIN = 26000;
const GAP_RANGE = 18000;
const SPAWN_LATERAL = 5200;
const SPAWN_VERTICAL = 3200;
/* 直接点名的那颗（MCP goto）不该让人先飞五分钟才看到 */
const GOTO_DIST = ENGAGE + 2000;
const MAX_BODIES = 8;
/* 前方常备几颗，镜头里同时只画一颗，但下一颗得已经在路上 */
const KEEP_AHEAD = 3;

/* 远处那颗还没胀大成面的星：屏幕半径这么小就当一枚会眨的亮星画，
   越过上限淡出，交给真正的球面 */
const FLARE_MIN_PX = 5;
const FLARE_MAX_PX = 30;
const FLARE_SIZE = 30;

const SUN_WORLD = normalize3([0.28, 0.34, -0.9]);

const STAR_SHELLS = [
  { count: 3600, alpha: 0.34, size: [0.6, 1.5] },
  { count: 2200, alpha: 0.46, size: [0.9, 2.1] },
  { count: 900, alpha: 0.6, size: [1.3, 2.8] },
];
const BRIGHT_COUNT = 42;

/* 掠过去的冰晶分两层：近层给速度感，中远层比前景慢、比天球快。
   三层速度差才是「在飞」的观感来源，只有一层或者都铺在远处就看着像静止。 */
const DUST_FIELDS = [
  /* nearK：这个距离内的点按 1/d 放大加亮，让近处的真掠过去、远处的收成针尖。
     放大倍数和亮度都收着，数量也别多，否则整片星跟着抖 */
  { name: "dust", count: 820, alpha: 0.38, size: [1.2, 2.4], min: 900, max: 8600, spread: 1250, nearK: 2200 },
  { name: "dustFar", count: 360, alpha: 0.16, size: [0.9, 1.7], min: 8000, max: 17000, spread: 3600, nearK: 0 },
];
/* 补到前方的点淡入这么久：一出现就是最亮的状态，看着像星星在爆闪 */
const DUST_FADE = 1.4;

/* 按恒星光谱型大致配的色温，权重偏向白色和淡黄，红蓝点缀 */
const STAR_COLORS = [
  [0.62, 0.72, 1.0],
  [0.8, 0.87, 1.0],
  [1.0, 1.0, 1.0],
  [1.0, 0.94, 0.8],
  [1.0, 0.8, 0.58],
  [1.0, 0.66, 0.5],
];
const STAR_WEIGHTS = [0.1, 0.2, 0.3, 0.22, 0.13, 0.05];

const PLANET_DEFS = {
  earth: {
    name: "地球",
    day: "earth-day",
    night: "earth-night",
    atmo: [0.34, 0.6, 1.0],
    tilt: 0.41,
    brightness: 0.92,
    size: [170, 220],
    weight: 0.08,
  },
  moon: {
    name: "月球",
    day: "moon",
    atmo: null,
    tilt: 0.12,
    brightness: 0.95,
    size: [90, 150],
    weight: 0.32,
  },
  mars: {
    name: "火星",
    day: "mars",
    atmo: [0.95, 0.46, 0.26],
    tilt: 0.44,
    brightness: 0.9,
    size: [150, 210],
    weight: 0.24,
  },
  jupiter: {
    name: "木星",
    day: "jupiter",
    atmo: [0.92, 0.82, 0.62],
    tilt: 0.05,
    brightness: 0.9,
    size: [250, 330],
    weight: 0.22,
  },
  saturn: {
    name: "土星",
    day: "saturn",
    atmo: [0.95, 0.86, 0.64],
    tilt: 0.47,
    brightness: 0.9,
    size: [230, 310],
    weight: 0.14,
    ring: true,
  },
};
const TYPES = Object.keys(PLANET_DEFS);

const TEX_NAMES = [
  "earth-day",
  "earth-night",
  "moon",
  "mars",
  "jupiter",
  "saturn",
  "saturn-ring",
  "galaxy",
];
const TEX_URLS = {
  "earth-day": "earth-day.jpg",
  "earth-night": "earth-night.jpg",
  moon: "moon.jpg",
  mars: "mars.jpg",
  jupiter: "jupiter.jpg",
  saturn: "saturn.jpg",
  "saturn-ring": "saturn-ring.png",
  galaxy: "galaxy.jpg",
};

const state = {
  canvas: null,
  gl: null,
  ok: false,
  active: false,
  raf: 0,
  last: 0,
  time: 0,
  dpr: 1,
  w: 0,
  h: 0,
  cam: { x: 0, y: 0, scale: 1 },
  camKnown: false,
  pendingSeed: "",
  seed: 0,
  programs: {},
  quad: null,
  sphere: null,
  ring: null,
  shells: [],
  bright: null,
  dust: null,
  dustFar: null,
  textures: new Map(),
  texturesStarted: false,
  /* 8K 档位：pack 是缓存里都有哪些张，hi 是已经进显存的，按名字叠在内置 2K 上面 */
  pack: null,
  hi: new Map(),
  hiLoading: new Set(),
  /* 解不开的 8K 记下来，别每帧重问一次；换档位或重新下载会清空 */
  hiBad: new Set(),
  hiOwner: 0,
  maxTex: 0,
  flare: null,
  view: null,
  head: { yaw: 0, pitch: 0, mag: 1 },
  proj: { focal: 400, mag: 1, k: [1, 1], projScale: [1, 1], clip: [1, 1], near: NEAR, far: FAR },
  flight: null,
  nextBodyId: 1,
};

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

/* 设置页下载完或清除完 8K 会广播这一条：正在飞的航线下一颗就该用新档位 */
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

/* 换空间等于换一段航线：星野重铺、星体重新沿新航线摆 */
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

const ACTION_HINTS =
  "pause 停住看当前这颗；resume 接着飞；skip 结束绕飞或跳过没追上的目标，立刻启程去下一颗；goto {body|type} 追某一颗（body 用 ahead 里的 id，type 是 earth/moon/mars/jupiter/saturn）";

/* 飞行控制：MCP 工具调这个，界面手势以后也能调 */
export function cosmosFlightControl(action, arg) {
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
    default:
      throw new Error(`不认识的飞行操作：${kind || "(空)"}；可用 pause / resume / skip / goto。${ACTION_HINTS}`);
  }
  return { ok: true, action: kind, ...cosmosFlight() };
}

/* ---------- 生命周期 ---------- */

function ensureGL() {
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

function activate() {
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

function deactivate() {
  if (!state.active) return;
  state.active = false;
  stopLoop();
  state.canvas.hidden = true;
}

function startLoop() {
  if (state.raf) return;
  state.last = performance.now();
  state.raf = requestAnimationFrame(frame);
}

function stopLoop() {
  if (!state.raf) return;
  cancelAnimationFrame(state.raf);
  state.raf = 0;
}

function resize() {
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

function ensureTextures() {
  if (state.texturesStarted) return;
  state.texturesStarted = true;
  for (const name of TEX_NAMES) {
    loadTexture(TEX_URLS[name])
      .then((tex) => state.textures.set(name, tex))
      .catch(() => state.textures.set(name, null));
  }
}

/* ---------- 画面 ---------- */

function frame(now) {
  state.raf = requestAnimationFrame(frame);
  if (!state.active) return;
  if (!state.w || !state.h) {
    resize();
    if (!state.w || !state.h) return;
  }
  const dt = Math.min(0.1, (now - state.last) / 1000);
  state.last = now;
  state.time += dt;
  computeView(dt);
  updateFlight(dt);
  render(dt);
}

function render() {
  const gl = state.gl;
  const view = state.view;
  if (!view) return;
  gl.viewport(0, 0, state.canvas.width, state.canvas.height);
  gl.depthMask(true);
  gl.clearColor(0.006, 0.008, 0.014, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.depthMask(false);
  drawSky(view);
  drawStars(view);
  gl.depthMask(true);
  drawBodies(view);
}

function drawSky(view) {
  const gl = state.gl;
  const prog = state.programs.sky;
  const tex = state.textures.get("galaxy");
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog.program);
  gl.bindVertexArray(state.quad.vao);
  gl.uniform3fv(prog.u.u_right, view.right);
  gl.uniform3fv(prog.u.u_up, view.up);
  gl.uniform3fv(prog.u.u_forward, view.dir);
  gl.uniform2f(prog.u.u_k, state.proj.k[0], state.proj.k[1]);
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D, tex || null);
  gl.uniform1i(prog.u.u_galaxy, 4);
  gl.uniform1f(prog.u.u_hasGalaxy, tex ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawStars(view) {
  const gl = state.gl;
  const prog = state.programs.star;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog.program);
  gl.uniformMatrix3fv(prog.u.u_w2c, false, view.w2c);
  gl.uniform3fv(prog.u.u_camPos, view.pos);
  gl.uniform2f(prog.u.u_res, state.w, state.h);
  gl.uniform1f(prog.u.u_focal, state.proj.focal);
  gl.uniform1f(prog.u.u_time, state.time);
  gl.uniform1f(prog.u.u_dpr, state.dpr);
  gl.uniform1f(prog.u.u_mode, 0);
  gl.uniform1f(prog.u.u_dust, 0);
  gl.uniform1f(prog.u.u_nearK, 0);
  const sizeK = clamp(state.proj.mag, 1, 1.6);
  for (const shell of state.shells) {
    gl.uniform1f(prog.u.u_sizeK, sizeK);
    gl.bindVertexArray(shell.vao);
    gl.drawArrays(gl.POINTS, 0, shell.count);
  }
  if (state.bright) {
    const prog2 = state.programs.bright;
    gl.useProgram(prog2.program);
    gl.uniformMatrix3fv(prog2.u.u_w2c, false, view.w2c);
    gl.uniform3fv(prog2.u.u_camPos, view.pos);
    gl.uniform2f(prog2.u.u_res, state.w, state.h);
    gl.uniform1f(prog2.u.u_focal, state.proj.focal);
    gl.uniform1f(prog2.u.u_time, state.time);
    gl.uniform1f(prog2.u.u_dpr, state.dpr);
    gl.uniform1f(prog2.u.u_sizeK, sizeK);
    gl.uniform1f(prog2.u.u_mode, 0);
    gl.uniform1f(prog2.u.u_dust, 0);
    gl.uniform1f(prog2.u.u_nearK, 0);
    gl.bindVertexArray(state.bright.vao);
    gl.drawArrays(gl.POINTS, 0, state.bright.count);
  }
  gl.useProgram(prog.program);
  gl.uniform1f(prog.u.u_mode, 1);
  gl.uniform1f(prog.u.u_sizeK, sizeK);
  for (const field of DUST_FIELDS) {
    const d = state[field.name];
    if (!d) continue;
    uploadDust(d);
    /* 近层按距离放大、远层维持针尖大：两条带速度差就是前进感，但它们都不闪 */
    gl.uniform1f(prog.u.u_dust, 1);
    gl.uniform1f(prog.u.u_nearK, field.nearK);
    gl.bindVertexArray(d.vao);
    gl.drawArrays(gl.POINTS, 0, d.count);
  }
  gl.disable(gl.BLEND);
}

/* 镜头里同时只留一颗星体：真宇宙里离一颗近必然离其他远，同框好几颗一眼就假。
   有目标就画目标，巡航时画前方最近、还没看过的那颗。 */
function heroCandidates(view) {
  const f = state.flight;
  if (!f) return [];
  const pool = f.focus ? [f.focus] : f.bodies.filter((b) => !b.visited);
  return pool
    .map((b) => ({ b, d: vecLen(vecSub(b.pos, view.pos)) }))
    .sort((x, y) => x.d - y.d)
    .map((x) => x.b);
}

function drawBodies(view) {
  const gl = state.gl;
  let b = null;
  let body = null;
  /* 最近的这颗可能刚好在画面外，往下顺延一位，别整帧空着 */
  for (const candidate of heroCandidates(view)) {
    if (vecDot(vecSub(candidate.pos, view.pos), view.dir) < -candidate.r) continue;
    const projected = projectBody(candidate, view);
    if (projected) {
      b = candidate;
      body = projected;
      break;
    }
  }
  if (!b) return;
  useHiRes(b);
  const sunView = normalize3(applyMat3(view.w2c, SUN_WORLD));

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);
  drawSphere(b, body, sunView);

  if (PLANET_DEFS[b.type].ring && texOf("saturn-ring")) {
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    drawSaturnRing(b, body, view, sunView);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  gl.disable(gl.DEPTH_TEST);
  drawHeroFlare(b, body);
}

function drawSphere(b, body, sunView) {
  const def = PLANET_DEFS[b.type];
  const dayTex = texOf(def.day);
  if (!dayTex) return;
  const gl = state.gl;
  const prog = state.programs.planet;
  gl.useProgram(prog.program);
  gl.bindVertexArray(state.sphere.vao);
  gl.uniform2f(prog.u.u_proj, state.proj.projScale[0], state.proj.projScale[1]);
  gl.uniform2f(prog.u.u_clip, state.proj.clip[0], state.proj.clip[1]);
  gl.uniformMatrix3fv(prog.u.u_rot, false, body.rot);
  gl.uniform3fv(prog.u.u_camc, body.camc);
  gl.uniform1f(prog.u.u_radius, b.r);
  gl.uniform1f(prog.u.u_brightness, def.brightness);
  gl.uniform3fv(prog.u.u_atmo, def.atmo || [0, 0, 0]);
  gl.uniform3fv(prog.u.u_sunView, sunView);
  gl.uniform1f(prog.u.u_hasNight, def.night ? 1 : 0);
  gl.uniform1i(prog.u.u_day, 0);
  gl.uniform1i(prog.u.u_night, 1);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, dayTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texOf(def.night) || dayTex);
  gl.drawElements(gl.TRIANGLES, state.sphere.count, gl.UNSIGNED_SHORT, 0);
  gl.activeTexture(gl.TEXTURE0);
}

function drawSaturnRing(b, body, view, sunView) {
  const gl = state.gl;
  const prog = state.programs.ring;
  gl.useProgram(prog.program);
  gl.bindVertexArray(state.ring.vao);
  gl.uniform2f(prog.u.u_proj, state.proj.projScale[0], state.proj.projScale[1]);
  gl.uniform2f(prog.u.u_clip, state.proj.clip[0], state.proj.clip[1]);
  gl.uniformMatrix3fv(prog.u.u_rot, false, mulMat3(view.w2c, ringFrame(b)));
  gl.uniform3fv(prog.u.u_camc, body.camc);
  gl.uniform1f(prog.u.u_radius, b.r);
  gl.uniform3fv(prog.u.u_sunView, sunView);
  gl.uniform3f(prog.u.u_ringColor, 0.82, 0.76, 0.62);
  gl.uniform1i(prog.u.u_ring, 2);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, texOf("saturn-ring"));
  gl.drawElements(gl.TRIANGLES, state.ring.count, gl.UNSIGNED_SHORT, 0);
  gl.activeTexture(gl.TEXTURE0);
}

/* 环只吃倾角 */
function ringFrame(b) {
  const t = northAxis(b);
  const x0 = sideAxis(t, b.azimuth);
  const z0 = normalize3(cross3(x0, t));
  return [x0[0], x0[1], x0[2], t[0], t[1], t[2], z0[0], z0[1], z0[2]];
}

/* ---------- 航线状态机 ---------- */

function resetFlight() {
  const rnd = mulberry32(state.seed ^ 0x9e3779b9);
  const dir = normalize3([(rnd() - 0.5) * 0.9, (rnd() - 0.5) * 0.4, -1]);
  state.flight = {
    rnd,
    pos: [0, 0, 0],
    view: dir,
    route: dir,
    speed: CRUISE,
    phase: "cruise",
    focus: null,
    orbit: null,
    paused: false,
    travelled: 0,
    earthUsed: false,
    wanderPhase: rnd() * Math.PI * 2,
    bodies: [],
  };
  state.nextBodyId = 1;
  for (let i = 0; i < KEEP_AHEAD; i++) spawnBody();
  updateDust(true, 0);
}

function updateFlight(dt) {
  const f = state.flight;
  if (!f || f.paused) return;
  /* 锁定目标之后航线就不再游荡：接近段要对准入轨点，边摆边对准就永远对不上 */
  if (!f.focus) meander(f, dt);
  switch (f.phase) {
    case "cruise":
      cruiseStep(f, dt);
      break;
    case "approach":
      approachStep(f, dt);
      break;
    case "orbit":
      orbitStep(f, dt);
      break;
    case "depart":
      departStep(f, dt);
      break;
    default:
      break;
  }
  f.travelled += f.speed * dt;
  recycleBodies(f);
  updateDust(false, dt);
}

function cruiseStep(f, dt) {
  f.speed = ramp(f.speed, CRUISE, 160 * dt);
  /* 前方 LEAD 距离内就先慢慢对准它，交接那一帧就不需要甩头了 */
  const lead = leadDirection(f);
  if (lead) f.route = normalize3(lerp3(f.route, lead, Math.min(1, dt * 0.12)));
  steerView(f, f.route, dt);
  advance(f, dt);
  const target = pickTarget(f);
  if (target) {
    f.focus = target;
    f.phase = "approach";
  }
}

/* 最近的那颗还没看过的星体给出「该往哪儿对准」；太远的不算，留给 meander 慢慢走 */
function leadDirection(f) {
  let best = null;
  let bestAhead = Infinity;
  for (const b of f.bodies) {
    if (b.visited) continue;
    const ahead = vecDot(vecSub(b.pos, f.pos), f.route);
    if (ahead <= 0 || ahead > LEAD) continue;
    if (ahead < bestAhead) {
      bestAhead = ahead;
      best = b;
    }
  }
  return best ? normalize3(vecSub(best.pos, f.pos)) : null;
}

function approachStep(f, dt) {
  const b = f.focus;
  if (!b) {
    f.phase = "cruise";
    return;
  }
  const rel = vecSub(b.pos, f.pos);
  const d = vecLen(rel);
  if (vecDot(rel, f.route) < -b.r * 2 || d < 1) {
    b.visited = true;
    f.focus = null;
    f.phase = "cruise";
    return;
  }
  const orbitR = b.r * ORBIT_K;
  f.speed = ramp(f.speed, approachSpeed(d, orbitR), 220 * dt);
  /* 接近段镜头不侧头看球：航线慢慢朝目标引，镜头仍跟着航线往前，
     所以这一段和巡航一样是「球在正前方越飞越大」，只是收得比 LEAD 紧一点 */
  f.route = normalize3(lerp3(f.route, normalize3(rel), Math.min(1, dt * 0.35)));
  steerView(f, f.route, dt);
  advance(f, dt);
  if (d <= orbitR * ORBIT_ENTER_K) enterOrbit(f, b, orbitR);
}

function orbitStep(f, dt) {
  const b = f.focus;
  const o = f.orbit;
  if (!b || !o) {
    f.phase = "cruise";
    f.orbit = null;
    return;
  }
  const prev = f.pos;
  /* 切向速度几秒里慢慢加进来，半径同时往里收：合成的速度大小基本接着刚才的巡航，
     方向从「朝球心」转到「绕着走」，不再是一帧之内的急转弯 */
  o.spin += (1 - o.spin) * Math.min(1, dt * 0.35);
  /* 远圈数完了才把目标半径降到贴地那档：这里只改目标，收半径的还是下面那条慢慢来的式子 */
  if (o.theta >= o.swapAt) {
    o.swapAt = Infinity;
    o.target = o.near;
  }
  const inward = Math.min((o.radius - o.target) * 0.16, CRUISE * 0.8);
  o.radius = Math.max(o.target, o.radius - inward * dt);
  o.theta += ((Math.PI * 2 / LAP_TIME) * o.spin) * dt;
  const c = Math.cos(o.theta);
  const s = Math.sin(o.theta);
  const pos = combine3(o.u1, c, o.u2, s, o.axis, 0);
  f.pos = [b.pos[0] + pos[0] * o.radius, b.pos[1] + pos[1] * o.radius, b.pos[2] + pos[2] * o.radius];
  const tangent = normalize3(combine3(o.u1, -s, o.u2, c, o.axis, 0));
  f.speed = dt > 0 ? vecLen(vecSub(f.pos, prev)) / dt : f.speed;

  /* 往球心方向叠一点来回漂移，免得整圈死盯中心 */
  const wobble = Math.sin(state.time * 0.31 + o.seed) * 0.055;
  const observe = normalize3(
    combine3(
      normalize3(vecSub(b.pos, f.pos)),
      1,
      tangent,
      wobble,
      o.axis,
      Math.sin(state.time * 0.19 + o.seed * 1.7) * 0.04,
    ),
  );
  let desired = observe;
  const left = o.total - o.theta;
  if (left < 1.5) {
    const k = smoothstep(0, 1.5, 1.5 - left);
    desired = normalize3(combine3(observe, 1 - k, tangent, k, [0, 0, 0], 0));
  }
  /* 入轨头几秒镜头还接着刚才直飞的方向，再慢慢转成盯球：
     不然一路朝前飞的镜头会在进轨那一帧被横向拽过去，看着就是「突然开始看球」 */
  o.look += (1 - o.look) * Math.min(1, dt * 0.5);
  desired = normalize3(combine3(f.view, 1 - o.look, desired, o.look, [0, 0, 0], 0));
  f.view = normalize3(lerp3(f.view, desired, Math.min(1, dt * 6)));

  if (o.theta >= o.total) {
    b.visited = true;
    f.phase = "depart";
    f.route = tangent;
    /* 速度交给 departStep 的 ramp 提回巡航，这里不硬抬，免得启程也是一下窜出去 */
    f.orbit = null;
  }
}

function departStep(f, dt) {
  f.speed = ramp(f.speed, CRUISE, 120 * dt);
  const b = f.focus;
  if (!b) {
    f.phase = "cruise";
    return;
  }
  const orbitR = b.r * ORBIT_K;
  const rel = vecSub(f.pos, b.pos);
  /* 启程那一小段还是顺着「离开球心」的方向推一点，免得擦回去。
     推力按秒给，一帧最多拽几个百分点——原来单帧 35% 就是绕行结束时那下横向扯 */
  const away = normalize3(rel);
  const k = Math.min(0.18, dt * 0.22);
  f.route = normalize3(combine3(f.route, 1 - k, away, k, [0, 0, 0], 0));
  steerView(f, f.route, dt);
  advance(f, dt);
  if (vecLen(rel) > orbitR * 1.5) {
    f.focus = null;
    f.phase = "cruise";
  }
}

function approachSpeed(d, orbitR) {
  const orbitSpeed = (Math.PI * 2 * orbitR) / LAP_TIME;
  const span = Math.max(1, d - orbitR);
  return clamp(Math.max(d / 90, orbitSpeed + span / 14), orbitSpeed, CRUISE);
}

function enterOrbit(f, b, orbitR) {
  const minDist = b.r * CLOSEST_K;
  let offset = vecSub(f.pos, b.pos);
  let d = vecLen(offset);
  if (d < minDist) {
    offset = vecScale(normalize3(offset), minDist);
    d = minDist;
    f.pos = [b.pos[0] + offset[0], b.pos[1] + offset[1], b.pos[2] + offset[2]];
  }
  const o1 = normalize3(offset);
  /* 绕飞走「赤道」那一圈：切向取水平东向，轨道法线就近似世界 up，
     绕过去时北极一直在画面上方，不会翻过去 */
  let u2 = normalize3(cross3([0, 1, 0], o1));
  if (isZero(u2)) u2 = [0, 0, -1];
  const axis = normalize3(cross3(o1, u2));
  /* 地球走两段：先 1.65 倍把整颗球看全，两圈到了换的点再把目标降到 1.3 倍 */
  const earth = b.type === "earth";
  const firstR = earth ? b.r * EARTH_FAR_K : orbitR;
  const laps = earth ? EARTH_FAR_LAPS + EARTH_NEAR_LAPS : 2 + (b.rnd() < 0.55 ? 1 : 0);
  f.orbit = {
    u1: o1,
    u2,
    axis,
    radius: Math.max(d, firstR),
    target: firstR,
    near: orbitR,
    swapAt: earth ? EARTH_FAR_LAPS * Math.PI * 2 : Infinity,
    theta: 0,
    total: laps * Math.PI * 2,
    seed: b.rnd() * Math.PI * 2,
    spin: 0,
    look: 0,
  };
  f.phase = "orbit";
}

function skipEncounter() {
  const f = state.flight;
  if (!f) return;
  if (f.phase === "orbit" && f.orbit) {
    /* 没看够也走：把这一圈的剩余角度当成已经飞完，直接从切线启程 */
    const o = f.orbit;
    const c = Math.cos(o.theta);
    const s = Math.sin(o.theta);
    f.route = normalize3(combine3(o.u1, -s, o.u2, c, o.axis, 0));
    f.view = f.route;
    if (f.focus) f.focus.visited = true;
    f.orbit = null;
    f.phase = "depart";
    f.speed = Math.max(f.speed, 130);
    return;
  }
  if (f.focus) {
    f.focus.visited = true;
    f.focus = null;
  }
  f.phase = "cruise";
}

function gotoBody(arg) {
  const f = state.flight;
  if (!f) return { ok: false, note: "宇宙主题还没激活" };
  const key = arg === null || arg === undefined ? "" : String(arg).trim().toLowerCase();
  if (!key) throw new Error(`goto 要带 body 或 type；${ACTION_HINTS}`);
  let body = null;
  if (/^\d+$/.test(key)) body = f.bodies.find((b) => b.id === Number(key)) || null;
  if (!body && TYPES.includes(key)) {
    body = pickByType(f, key);
    if (!body) {
      body = makeBody(f, key, true, GOTO_DIST);
      f.bodies.push(body);
    }
  }
  if (!body) throw new Error(`没有 id 或类型为「${key}」的星体；先调 flight_state 看 ahead 列表`);
  f.focus = body;
  body.visited = false;
  f.orbit = null;
  f.phase = "approach";
  f.paused = false;
  return { ok: true, action: "goto", body: describeBody(body, f), ...cosmosFlight() };
}

function pickByType(f, type) {
  let best = null;
  let bestD = Infinity;
  for (const b of f.bodies) {
    if (b.type !== type || b.visited) continue;
    const rel = vecSub(b.pos, f.pos);
    if (vecDot(rel, f.route) < 0) continue;
    const d = vecLen(rel);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function pickTarget(f) {
  let best = null;
  let bestD = Infinity;
  for (const b of f.bodies) {
    if (b.visited) continue;
    const rel = vecSub(b.pos, f.pos);
    const ahead = vecDot(rel, f.route);
    if (ahead <= 0) continue;
    if (ahead > ENGAGE) continue;
    const d = vecLen(rel);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/* 沿当前路线往前撒星体，飞过来的回收 */
function recycleBodies(f) {
  f.bodies = f.bodies.filter((b) => {
    const rel = vecSub(b.pos, f.pos);
    const ahead = vecDot(rel, f.route);
    const d = vecLen(rel);
    if (b === f.focus) return true;
    if (ahead < -(b.r + 2000) && d > b.r * 1.5) return false;
    return d < FAR * 1.2;
  });
  let aheadCount = 0;
  for (const b of f.bodies) {
    if (vecDot(vecSub(b.pos, f.pos), f.route) > b.r) aheadCount++;
  }
  let guard = 0;
  while (aheadCount < KEEP_AHEAD && f.bodies.length < MAX_BODIES && guard < 12) {
    spawnBody();
    aheadCount++;
    guard++;
  }
}

function chooseType(f) {
  let roll = f.rnd();
  for (const type of TYPES) {
    const def = PLANET_DEFS[type];
    /* 地球一个空间只出现一次，重复会一眼看穿 */
    if (type === "earth" && f.earthUsed) continue;
    roll -= def.weight;
    if (roll <= 0) {
      if (type === "earth") f.earthUsed = true;
      return type;
    }
  }
  return "moon";
}

/* straight：正摆在航线轴上，给 goto 用，免得目标歪到够不着 */
function makeBody(f, type, straight, dist) {
  const rnd = mulberry32((state.seed ^ Math.imul(state.nextBodyId, 0x9e3779b1)) >>> 0);
  const def = PLANET_DEFS[type];
  const [lo, hi] = def.size;
  const r = lo + rnd() * (hi - lo);
  const basis = basisFor(f.route);
  const lateral = straight ? 0 : (rnd() - 0.5) * 2 * SPAWN_LATERAL;
  const vertical = straight ? 0 : (rnd() - 0.5) * 2 * SPAWN_VERTICAL;
  const pos = [
    f.pos[0] + f.route[0] * dist + basis.right[0] * lateral + basis.up[0] * vertical,
    f.pos[1] + f.route[1] * dist + basis.right[1] * lateral + basis.up[1] * vertical,
    f.pos[2] + f.route[2] * dist + basis.right[2] * lateral + basis.up[2] * vertical,
  ];
  return {
    id: state.nextBodyId++,
    type,
    pos,
    r,
    /* 星体不自转，只随机一个起始经度，保证每次遇到的都是另一面 */
    face: rnd() * Math.PI * 2,
    tilt: def.tilt + (rnd() - 0.5) * 0.3,
    azimuth: rnd() * Math.PI * 2,
    visited: false,
    rnd,
  };
}

/* 星体沿航线一颗一颗往后排：下一颗永远摆在最远那颗再往前一截的地方，
   这样「追上下一颗」中间必然隔着一大段空无一物的航行 */
function nextSpawnDistance(f) {
  let frontier = 0;
  for (const b of f.bodies) {
    const ahead = vecDot(vecSub(b.pos, f.pos), f.route);
    if (ahead > frontier) frontier = ahead;
  }
  if (!frontier) return FIRST_MIN + f.rnd() * FIRST_RANGE;
  return frontier + GAP_MIN + f.rnd() * GAP_RANGE;
}

function spawnBody(straight) {
  const f = state.flight;
  if (!f) return null;
  if (!straight && f.bodies.length >= MAX_BODIES) return null;
  const dist = straight ? GOTO_DIST : nextSpawnDistance(f);
  const body = makeBody(f, chooseType(f), !!straight, dist);
  f.bodies.push(body);
  return body;
}

/* 航线自己慢慢游荡，天空才会一直变 */
function meander(f, dt) {
  const t = state.time;
  /* 游走幅度压低：这是「所有星星一起平移」的唯一来源，摆得越快整片天越像在晃 */
  const yaw = Math.sin(t * 0.031 + f.wanderPhase) * 0.026 + Math.sin(t * 0.083 + f.wanderPhase * 2.1) * 0.009;
  const pitch = Math.sin(t * 0.026 + f.wanderPhase * 1.7) * 0.016 + Math.sin(t * 0.061 + f.wanderPhase * 0.9) * 0.006;
  f.route = normalize3(rotateAxis(f.route, [0, 1, 0], yaw * dt));
  const side = cross3([0, 1, 0], f.route);
  if (!isZero(side)) f.route = normalize3(rotateAxis(f.route, normalize3(side), pitch * dt));
  if (Math.abs(f.route[1]) > MAX_PITCH_Y * 0.6) {
    f.route[1] = Math.sign(f.route[1]) * MAX_PITCH_Y * 0.6;
    f.route = normalize3(f.route);
  }
}

function advance(f, dt) {
  f.pos = [
    f.pos[0] + f.view[0] * f.speed * dt,
    f.pos[1] + f.view[1] * f.speed * dt,
    f.pos[2] + f.view[2] * f.speed * dt,
  ];
}

function steerView(f, target, dt) {
  const cur = normalize3(f.view);
  const dot = clamp(vecDot(cur, target), -1, 1);
  const angle = Math.acos(dot);
  const maxAngle = TURN_RATE * dt;
  if (angle <= maxAngle || vecLen(target) < 0.5) {
    f.view = normalize3(target);
    return;
  }
  const k = 1 - maxAngle / angle;
  f.view = normalize3([
    cur[0] + (target[0] - cur[0]) * k,
    cur[1] + (target[1] - cur[1]) * k,
    cur[2] + (target[2] - cur[2]) * k,
  ]);
}

/* ---------- 相机 ---------- */

function computeView(dt) {
  const f = state.flight;
  const base = f ? normalize3(f.view) : [0, 0, -1];
  const target = {
    yaw: clamp(-state.cam.x / 1200, -1, 1) * HEAD_YAW,
    pitch: clamp(state.cam.y / 1200, -1, 1) * HEAD_PITCH,
    mag: clamp(1 + (state.cam.scale - 1) * HEAD_MAG, 0.7, 2.4),
  };
  const head = state.head;
  const k = Math.min(1, dt * 2.6);
  head.yaw += (target.yaw - head.yaw) * k;
  head.pitch += (target.pitch - head.pitch) * k;
  head.mag += (target.mag - head.mag) * k;

  let dir = normalize3(rotateAxis(base, [0, 1, 0], head.yaw));
  const side = normalize3(cross3([0, 1, 0], dir));
  if (!isZero(side)) dir = normalize3(rotateAxis(dir, side, head.pitch));
  if (Math.abs(dir[1]) > MAX_PITCH_Y) {
    dir[1] = Math.sign(dir[1]) * MAX_PITCH_Y;
    dir = normalize3(dir);
  }

  let right = normalize3(cross3(dir, [0, 1, 0]));
  if (isZero(right)) right = [1, 0, 0];
  const up = normalize3(cross3(right, dir));
  const pos = f ? f.pos : [0, 0, 0];
  /* 相机旋转矩阵：三行分别是 right / up / -dir，按列主序摊平 */
  const w2c = [right[0], up[0], -dir[0], right[1], up[1], -dir[1], right[2], up[2], -dir[2]];
  const focal = (state.h / 2) * FOV_K * head.mag;
  state.proj = {
    focal,
    mag: head.mag,
    k: [state.w / 2 / focal, state.h / 2 / focal],
    projScale: [(2 * focal) / state.w, (2 * focal) / state.h],
    clip: [(FAR + NEAR) / (NEAR - FAR), (2 * FAR * NEAR) / (NEAR - FAR)],
    near: NEAR,
    far: FAR,
  };
  state.view = { dir, right, up, pos, w2c };
}

function basisFor(dir) {
  let right = normalize3(cross3(dir, [0, 1, 0]));
  if (isZero(right)) right = [1, 0, 0];
  const up = normalize3(cross3(right, dir));
  return { right, up, forward: normalize3(dir) };
}

function projectBody(b, view) {
  const camc = applyMat3(view.w2c, vecSub(b.pos, view.pos));
  const dist = -camc[2];
  if (dist - b.r < state.proj.near * 0.4) return null;
  if (dist + b.r > state.proj.far) return null;
  const screenX = (camc[0] / dist) * state.proj.focal + state.w / 2;
  const screenY = state.h / 2 - (camc[1] / dist) * state.proj.focal;
  /* 环摊到 2.25 倍半径，屏外剔除要把它算进去 */
  const margin = (b.r / dist) * state.proj.focal * 2.6 + 40;
  if (screenX + margin < 0 || screenX - margin > state.w) return null;
  if (screenY + margin < 0 || screenY - margin > state.h) return null;
  return { camc, dist, rot: mulMat3(view.w2c, objectRotation(b)) };
}

/* 局部 → 世界：北轴由倾角和方位定，face 是给定的经度相位（星体不自转） */
function objectRotation(b) {
  const t = northAxis(b);
  const x0 = sideAxis(t, b.azimuth);
  const z0 = normalize3(cross3(x0, t));
  const cs = Math.cos(b.face);
  const sn = Math.sin(b.face);
  return [
    x0[0] * cs + z0[0] * sn, x0[1] * cs + z0[1] * sn, x0[2] * cs + z0[2] * sn,
    t[0], t[1], t[2],
    z0[0] * cs - x0[0] * sn, z0[1] * cs - x0[1] * sn, z0[2] * cs - x0[2] * sn,
  ];
}

function northAxis(b) {
  return [
    Math.sin(b.tilt) * Math.cos(b.azimuth),
    Math.cos(b.tilt),
    Math.sin(b.tilt) * Math.sin(b.azimuth),
  ];
}

/* 和北轴垂直的参考轴；正好朝天转的星球取本初子午线方向 */
function sideAxis(t, azimuth) {
  const a = normalize3(cross3(t, [0, 1, 0]));
  if (!isZero(a)) return a;
  return normalize3([Math.cos(azimuth), 0, Math.sin(azimuth)]);
}

/* ---------- 近处尘埃：世界坐标固定，靠视差往后掠 ---------- */

function updateDust(rebuild, dt) {
  const f = state.flight;
  if (!f) return;
  /* 按航线朝向回收，不用镜头实际朝向：小幅转头不该把这层星尘整体重排 */
  const gaze = rebuild ? f.route : f.view;
  const basis = basisFor(gaze);
  for (const field of DUST_FIELDS) {
    const d = state[field.name];
    if (!d) continue;
    let moved = false;
    for (let i = 0; i < d.count; i++) {
      const o = i * 9;
      if (rebuild) {
        placeDust(d, i, basis, f.pos);
        moved = true;
        continue;
      }
      const rel = [d.data[o] - f.pos[0], d.data[o + 1] - f.pos[1], d.data[o + 2] - f.pos[2]];
      /* 掠到镜头后头、或已经跑到带子外，就补回这条带的前方——近层也要能补到脸上，
         不然飞一会儿近处就空了，看着像停住 */
      if (vecDot(rel, gaze) < -1200 || vecLen(rel) > d.spec.max * 1.6) {
        placeDust(d, i, basis, f.pos);
        moved = true;
        continue;
      }
      if (d.age[i] < 1) {
        d.age[i] = Math.min(1, d.age[i] + dt / DUST_FADE);
        d.data[o + 7] = d.base[i] * d.age[i];
        moved = true;
      }
    }
    if (moved) d.dirty = true;
  }
}

function placeDust(d, i, basis, pos) {
  const { min, max, spread } = d.spec;
  const o = i * 9;
  const depth = min + Math.random() * (max - min);
  const lat = (Math.random() - 0.5) * 2 * spread;
  const vert = (Math.random() - 0.5) * 2 * spread;
  const dir = basis.forward;
  d.data[o] = pos[0] + dir[0] * depth + basis.right[0] * lat + basis.up[0] * vert;
  d.data[o + 1] = pos[1] + dir[1] * depth + basis.right[1] * lat + basis.up[1] * vert;
  d.data[o + 2] = pos[2] + dir[2] * depth + basis.right[2] * lat + basis.up[2] * vert;
  /* 新生点从全暗起，靠 updateDust 每帧推上去 */
  d.age[i] = 0;
  d.data[o + 7] = 0;
}

function uploadDust(d) {
  if (!d || !d.dirty) return;
  const gl = state.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, d.buffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.data);
  d.dirty = false;
}

/* ---------- 描述给 MCP ---------- */

function describeBody(b, f) {
  const rel = vecSub(b.pos, f.pos);
  const ahead = vecDot(rel, f.route);
  if (ahead < -b.r - 2000) return null;
  const def = PLANET_DEFS[b.type];
  return {
    id: b.id,
    type: b.type,
    name: def.name,
    radius: Math.round(b.r),
    distance: Math.round(vecLen(rel)),
    ahead: Math.round(ahead),
    ring: !!def.ring,
    visited: b.visited,
  };
}

function describeFocus(f) {
  const b = f.focus;
  if (!b) return null;
  const def = PLANET_DEFS[b.type];
  const out = {
    id: b.id,
    type: b.type,
    name: def.name,
    radius: Math.round(b.r),
    distance: Math.round(vecLen(vecSub(b.pos, f.pos))),
  };
  const o = f.orbit;
  if (f.phase === "orbit" && o) {
    const laps = Math.round(o.total / (Math.PI * 2));
    out.orbit = {
      lap: Math.min(laps, Math.floor(o.theta / (Math.PI * 2)) + 1),
      laps,
      radius: Math.round(o.radius),
      /* 当前那一段要收到的半径：地球先远后近，这个数会在两圈后掉一档 */
      target: Math.round(o.target),
      remaining: Math.max(0, Math.round(((o.total - o.theta) / (Math.PI * 2)) * LAP_TIME)),
    };
  }
  return out;
}

/* 视线仰角：正=往上抬，负=往下俯 */
function pitchOf(dir) {
  return Math.round(Math.asin(clamp(dir[1], -1, 1)) * (180 / Math.PI));
}

/* ---------- 数学 ---------- */

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vecLen(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function vecSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecScale(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function isZero(a) {
  return vecLen(a) < 1e-6;
}

function normalize3(v) {
  const len = vecLen(v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function lerp3(a, b, k) {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/* a*A + b*B + c*C：三个向量按系数相加，本文件里到处是这种组合 */
function combine3(a, ka, b, kb, c, kc) {
  return [
    a[0] * ka + b[0] * kb + c[0] * kc,
    a[1] * ka + b[1] * kb + c[1] * kc,
    a[2] * ka + b[2] * kb + c[2] * kc,
  ];
}

function ramp(cur, target, maxDelta) {
  if (cur < target) return Math.min(target, cur + maxDelta);
  return Math.max(target, cur - maxDelta);
}

/* Rodrigues 旋转 */
function rotateAxis(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = vecDot(axis, v);
  const cross = cross3(axis, v);
  return [
    v[0] * c + cross[0] * s + axis[0] * k * (1 - c),
    v[1] * c + cross[1] * s + axis[1] * k * (1 - c),
    v[2] * c + cross[2] * s + axis[2] * k * (1 - c),
  ];
}

/* 列主序 mat3 相乘：a*b 表示先 b 后 a */
function mulMat3(a, b) {
  const out = new Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[k * 3 + row] * b[col * 3 + k];
      out[col * 3 + row] = sum;
    }
  }
  return out;
}

function applyMat3(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 星点 ---------- */

function buildStars() {
  if (!state.ok) return;
  const gl = state.gl;
  for (const shell of state.shells) {
    gl.deleteBuffer(shell.buffer);
    gl.deleteVertexArray(shell.vao);
  }
  state.shells = [];
  for (const spec of STAR_SHELLS) {
    state.shells.push(makeStarVAO(gl, buildStarData(spec, false), spec.count));
  }
  if (state.bright) {
    gl.deleteBuffer(state.bright.buffer);
    gl.deleteVertexArray(state.bright.vao);
  }
  state.bright = makeStarVAO(gl, buildStarData({ count: BRIGHT_COUNT, alpha: 0.72, size: [26, 46] }, false), BRIGHT_COUNT);
  for (const field of DUST_FIELDS) {
    const data = buildStarData({ count: field.count, alpha: field.alpha, size: field.size }, true);
    const old = state[field.name];
    if (old) {
      gl.deleteBuffer(old.buffer);
      gl.deleteVertexArray(old.vao);
    }
    const base = new Float32Array(field.count);
    for (let i = 0; i < field.count; i++) base[i] = data[i * 9 + 7];
    state[field.name] = {
      ...makeStarVAO(gl, data, field.count),
      data,
      base,
      age: new Float32Array(field.count),
      dirty: true,
      spec: field,
    };
  }
}

/* 恒星按纬度拒绝采样，稍微往银道带偏一点，和银河贴图对得上 */
function buildStarData(spec, world) {
  const rnd = mulberry32((state.seed ^ 0x51ed270b) >>> 0);
  const data = new Float32Array(spec.count * 9);
  for (let i = 0; i < spec.count; i++) {
    const o = i * 9;
    let y = 0;
    for (let tries = 0; tries < 8; tries++) {
      y = rnd() * 2 - 1;
      const band = Math.exp(-((y / 0.3) ** 2));
      if (rnd() < 0.45 + 0.55 * band) break;
    }
    const lon = rnd() * Math.PI * 2;
    const cosLat = Math.sqrt(Math.max(0, 1 - y * y));
    const x = cosLat * Math.sin(lon);
    const z = cosLat * Math.cos(lon);
    const color = pickStarColor(rnd);
    data[o] = world ? x * (40000 + rnd() * 40000) : x;
    data[o + 1] = world ? y * 60000 : y;
    data[o + 2] = world ? z * (40000 + rnd() * 40000) : z;
    data[o + 3] = color[0];
    data[o + 4] = color[1];
    data[o + 5] = color[2];
    data[o + 6] = spec.size[0] + rnd() * (spec.size[1] - spec.size[0]);
    data[o + 7] = spec.alpha * (0.45 + rnd() * 0.55);
    data[o + 8] = rnd();
  }
  return data;
}

function pickStarColor(rnd) {
  let roll = rnd();
  for (let i = 0; i < STAR_WEIGHTS.length; i++) {
    roll -= STAR_WEIGHTS[i];
    if (roll <= 0) return STAR_COLORS[i];
  }
  return STAR_COLORS[2];
}

function makeStarVAO(gl, data, count) {
  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const stride = 36;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
  gl.bindVertexArray(null);
  return { vao, buffer, count };
}

/* ---------- 资源 ---------- */

function loadTexture(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      try {
        resolve(uploadTexture(img));
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => reject(new Error(`贴图加载失败：${file}`));
    img.src = `${TEX_BASE}${file}`;
  });
}

function uploadTexture(img) {
  const gl = state.gl;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ext =
    gl.getExtension("EXT_texture_filter_anisotropic") ||
    gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
  if (ext) {
    const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  return tex;
}

function initResources(gl) {
  const quadData = new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]);
  state.quad = (() => {
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, buffer };
  })();

  state.programs.sky = makeProgram(SKY_VS, SKY_FS);
  state.programs.star = makeProgram(STAR_VS, STAR_FS);
  state.programs.bright = makeProgram(STAR_VS, BRIGHT_FS);
  state.programs.planet = makeProgram(PLANET_VS, PLANET_FS);
  state.programs.ring = makeProgram(RING_VS, RING_FS);

  const sphere = makeSphere();
  state.sphere = {
    vao: makeMeshVAO(sphere.vertices, sphere.indices),
    count: sphere.indices.length,
  };
  const ring = makeRing();
  state.ring = {
    vao: makeRingVAO(ring.vertices, ring.indices),
    count: ring.indices.length,
  };

  /* 远处那颗亮星：就一个点，位置每帧改成镜头里这颗星体的球心 */
  const flare = new Float32Array(9);
  state.flare = { ...makeStarVAO(gl, flare, 1), data: flare };
}

/* ---------- 8K 贴图档位 ---------- */

function refreshPack() {
  if (!invoke) return Promise.resolve();
  return invoke("cosmos_tex_status")
    .then((status) => {
      state.pack = new Set(
        (status?.files || []).filter((file) => file.present).map((file) => file.name),
      );
    })
    .catch(() => {
      state.pack = new Set();
    });
}

function dropHiRes() {
  if (!state.ok) return;
  const gl = state.gl;
  for (const tex of state.hi.values()) gl.deleteTexture(tex);
  state.hi.clear();
  state.hiLoading.clear();
  state.hiBad.clear();
  state.hiOwner = 0;
}

/* 一张 8K 进显存是上百 MB 的量，同屏既然只画一颗，就只留这一颗的几张 */
function useHiRes(b) {
  /* 这张卡吃不下 8192 宽就整批放弃，用内置 2K 也比黑乎乎的球强 */
  if (!b || !state.pack?.size || state.maxTex < 8192) return;
  const names = heroTexNames(b);
  for (const name of names) {
    if (!state.pack.has(name) || state.hi.has(name) || state.hiBad.has(name)) continue;
    if (state.hiLoading.has(name)) continue;
    loadHiRes(name);
  }
  if (state.hiOwner === b.id) return;
  const gl = state.gl;
  const keep = new Set(names);
  for (const [name, tex] of state.hi) {
    if (keep.has(name)) continue;
    gl.deleteTexture(tex);
    state.hi.delete(name);
  }
  state.hiOwner = b.id;
}

function heroTexNames(b) {
  const def = PLANET_DEFS[b.type];
  const names = [def.day];
  if (def.night) names.push(def.night);
  if (def.ring) names.push("saturn-ring");
  return names;
}

/* 取贴图：下过这张 8K 就用它，没下过（或还在解）就退回内置 2K */
function texOf(name) {
  return state.hi.get(name) || state.textures.get(name) || null;
}

function loadHiRes(name) {
  state.hiLoading.add(name);
  invoke("cosmos_tex_read", { name })
    .then((text) => {
      const bytes = decodeBase64(text);
      return imageFromBytes(bytes, name);
    })
    .then((img) => {
      /* 先把之前遗留的错误位清空，否则那个错会冤枉这张贴图 */
      while (state.gl.getError() !== state.gl.NO_ERROR) {
        // 一直读到 NO_ERROR 为止
      }
      const tex = uploadTexture(img);
      img.src = "";
      if (glHasError()) {
        state.gl.deleteTexture(tex);
        throw new Error("显存放不下");
      }
      state.hi.set(name, tex);
    })
    /* 读不到就继续用内置 2K，但记下这张，别每帧重问一次 */
    .catch(() => state.hiBad.add(name))
    .finally(() => state.hiLoading.delete(name));
}

/* 传超大贴图不会抛错，只会把错误位挂在那儿等人来查 */
function glHasError() {
  const gl = state.gl;
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    console.warn("8K 贴图上传失败，WebGL 错误码", error);
    return true;
  }
  return false;
}

function decodeBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/* blob 地址是同源的，直接喂给 WebGL 不会被当成跨域图 */
function imageFromBytes(bytes, name) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(
      new Blob([bytes], { type: name === "saturn-ring" ? "image/png" : "image/jpeg" }),
    );
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`8K 贴图解不开：${name}`));
    };
    img.src = url;
  });
}

/* 镜头里那颗还只有针尖大时，先当一枚会眨的亮星：越近越淡，交给真正的球面 */
function drawHeroFlare(b, body) {
  const prog = state.programs.bright;
  const gl = state.gl;
  const px = (b.r / body.dist) * state.proj.focal;
  const alpha = 1 - smoothstep(FLARE_MIN_PX, FLARE_MAX_PX, px);
  if (alpha <= 0.02) return;
  const tint = PLANET_DEFS[b.type].atmo || [1, 0.97, 0.92];
  const data = state.flare.data;
  data[0] = b.pos[0];
  data[1] = b.pos[1];
  data[2] = b.pos[2];
  data[3] = tint[0];
  data[4] = tint[1];
  data[5] = tint[2];
  data[6] = FLARE_SIZE;
  data[7] = alpha;
  data[8] = ((b.id % 97) / 97) * Math.PI * 2;
  gl.bindBuffer(gl.ARRAY_BUFFER, state.flare.buffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  gl.useProgram(prog.program);
  gl.uniformMatrix3fv(prog.u.u_w2c, false, state.view.w2c);
  gl.uniform3fv(prog.u.u_camPos, state.view.pos);
  gl.uniform2f(prog.u.u_res, state.w, state.h);
  gl.uniform1f(prog.u.u_focal, state.proj.focal);
  gl.uniform1f(prog.u.u_time, state.time);
  gl.uniform1f(prog.u.u_dpr, state.dpr);
  gl.uniform1f(prog.u.u_sizeK, 1);
  gl.uniform1f(prog.u.u_mode, 1);
  gl.bindVertexArray(state.flare.vao);
  gl.depthMask(false);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.drawArrays(gl.POINTS, 0, 1);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
}

function makeProgram(vsSource, fsSource) {
  const gl = state.gl;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`着色器编译失败：${log}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl.FRAGMENT_SHADER, fsSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`着色器链接失败：${gl.getProgramInfoLog(program)}`);
  }
  const u = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    u[info.name] = gl.getUniformLocation(program, info.name);
  }
  return { program, u };
}

/* 球面：位置、法线、UV。经度 0（贴图横向中点）落在 +z，
   v=0 在北极，对上不翻转上传的贴图顶部，所以画出来永远是上北下南。 */
function makeSphere() {
  const latSegs = 48;
  const lonSegs = 96;
  const vertices = [];
  const indices = [];
  for (let i = 0; i <= latSegs; i++) {
    const v = i / latSegs;
    const lat = Math.PI / 2 - v * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    for (let j = 0; j <= lonSegs; j++) {
      const u = j / lonSegs;
      const lon = u * Math.PI * 2 - Math.PI;
      const x = cosLat * Math.sin(lon);
      const y = sinLat;
      const z = cosLat * Math.cos(lon);
      vertices.push(x, y, z, x, y, z, u, 0.5 - lat / Math.PI);
    }
  }
  for (let i = 0; i < latSegs; i++) {
    for (let j = 0; j < lonSegs; j++) {
      const a = i * (lonSegs + 1) + j;
      const b = a + lonSegs + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

function makeRing() {
  const segs = 160;
  const inner = 1.28;
  const outer = 2.25;
  const vertices = [];
  const indices = [];
  for (let i = 0; i <= segs; i++) {
    const theta = (i / segs) * Math.PI * 2;
    vertices.push(inner, theta, outer, theta);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

function makeMeshVAO(vertices, indices) {
  const gl = state.gl;
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const stride = 32;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return vao;
}

function makeRingVAO(vertices, indices) {
  const gl = state.gl;
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return vao;
}

/* ---------- 着色器 ---------- */

const SKY_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 1.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_forward;
uniform vec2 u_k;
uniform sampler2D u_galaxy;
uniform float u_hasGalaxy;
out vec4 outColor;
void main() {
  vec3 dir = normalize(u_right * (v_ndc.x * u_k.x) + u_up * (v_ndc.y * u_k.y) + u_forward);
  float lon = atan(dir.x, dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.14159265);
  float off = length(v_ndc);
  vec3 base = mix(vec3(0.017, 0.023, 0.043), vec3(0.002, 0.003, 0.007), smoothstep(0.12, 1.05, off));
  vec3 col = base;
  if (u_hasGalaxy > 0.5) {
    vec3 gal = texture(u_galaxy, uv).rgb;
    col += gal * 0.19 * (1.0 - 0.35 * smoothstep(0.4, 1.2, off));
  }
  outColor = vec4(col, 1.0);
}`;

const STAR_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_vec;
layout(location = 1) in vec3 a_color;
layout(location = 2) in float a_size;
layout(location = 3) in float a_alpha;
layout(location = 4) in float a_phase;
uniform mat3 u_w2c;
uniform vec3 u_camPos;
uniform vec2 u_res;
uniform float u_focal;
uniform float u_time;
uniform float u_dpr;
uniform float u_sizeK;
uniform float u_mode;
uniform float u_dust;
uniform float u_nearK;
out vec3 v_color;
out float v_alpha;
void main() {
  v_color = a_color;
  vec3 rel = u_mode > 0.5 ? a_vec - u_camPos : a_vec;
  vec3 e = u_w2c * rel;
  float d = -e.z;
  if (d < 0.05) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    v_alpha = 0.0;
    return;
  }
  vec2 screen = e.xy * (u_focal / d);
  gl_Position = vec4(screen.x / (u_res.x * 0.5), screen.y / (u_res.y * 0.5), 0.5, 1.0);
  /* u_nearK>0 的点是会掠过去的近处冰晶：越近越大越亮，远处收回针尖 */
  float att = u_nearK > 0.0 ? min(u_nearK / d, 1.0) : 0.0;
  gl_PointSize = max(1.0, a_size * u_dpr * u_sizeK * (1.0 + att));
  /* 尘埃（u_dust）不许闪烁：它本来就在快速移动，再加 twinkle 就成了满屏乱抖 */
  float tw = u_dust > 0.5 ? 1.0 : 0.82 + 0.18 * sin(u_time * (1.1 + a_phase * 2.3) + a_phase * 37.0);
  float depthK = u_nearK > 0.0 ? 0.45 + 0.55 * att : 1.0;
  v_alpha = a_alpha * tw * depthK;
}`;

const STAR_FS = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 outColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = smoothstep(1.0, 0.15, d);
  outColor = vec4(v_color, v_alpha * a);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  q.y = -q.y;
  float r2 = dot(q, q);
  float core = exp(-r2 * 14.0);
  float halo = exp(-sqrt(r2) * 2.4) * 0.22;
  float sx = exp(-abs(q.x) * 26.0) * exp(-abs(q.y) * 2.2);
  float sy = exp(-abs(q.y) * 26.0) * exp(-abs(q.x) * 2.2);
  float a = core + halo + (sx + sy) * 0.4;
  if (a < 0.003) discard;
  outColor = vec4(v_color, a * v_alpha);
}`;

const PLANET_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec2 a_uv;
uniform mat3 u_rot;
uniform vec3 u_camc;
uniform float u_radius;
uniform vec2 u_proj;
uniform vec2 u_clip;
out vec3 v_nrm;
out vec2 v_uv;
void main() {
  vec3 p = u_camc + u_radius * (u_rot * a_pos);
  v_nrm = u_rot * a_nrm;
  v_uv = a_uv;
  gl_Position = vec4(p.x * u_proj.x, p.y * u_proj.y, p.z * u_clip.x + u_clip.y, -p.z);
}`;

const PLANET_FS = `#version 300 es
precision highp float;
in vec3 v_nrm;
in vec2 v_uv;
uniform sampler2D u_day;
uniform sampler2D u_night;
uniform float u_hasNight;
uniform vec3 u_atmo;
uniform vec3 u_sunView;
uniform float u_brightness;
out vec4 outColor;
void main() {
  vec3 n = normalize(v_nrm);
  /* 相机空间 +z 指向观察者：这半边是正面，用补光保证贴图细节 */
  float sunL = dot(n, u_sunView);
  float key = smoothstep(-0.28, 0.42, sunL);
  float fill = max(n.z, 0.0);
  float light = 0.18 + 0.5 * key + 0.38 * fill;
  vec3 day = texture(u_day, v_uv).rgb;
  vec3 col = day * light * u_brightness;
  if (u_hasNight > 0.5) {
    vec3 night = texture(u_night, v_uv).rgb;
    float nightMix = (1.0 - key) * (1.0 - 0.6 * fill);
    col += night * nightMix * 0.8;
  }
  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
  col += u_atmo * rim * (0.25 + 0.75 * max(sunL, 0.0)) * 0.9;
  outColor = vec4(col, 1.0);
}`;

const RING_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_ring;
uniform mat3 u_rot;
uniform vec3 u_camc;
uniform float u_radius;
uniform vec2 u_proj;
uniform vec2 u_clip;
out vec2 v_uv;
out vec3 v_nrm;
void main() {
  float r = a_ring.x;
  float theta = a_ring.y;
  vec3 local = vec3(cos(theta) * r, 0.0, sin(theta) * r);
  vec3 p = u_camc + u_radius * (u_rot * local);
  v_nrm = u_rot * vec3(0.0, 1.0, 0.0);
  v_uv = vec2((r - 1.28) / (2.25 - 1.28), 0.5);
  gl_Position = vec4(p.x * u_proj.x, p.y * u_proj.y, p.z * u_clip.x + u_clip.y, -p.z);
}`;

const RING_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_nrm;
uniform sampler2D u_ring;
uniform vec3 u_ringColor;
uniform vec3 u_sunView;
out vec4 outColor;
void main() {
  vec3 t = texture(u_ring, v_uv).rgb;
  float lum = dot(t, vec3(0.299, 0.587, 0.114));
  float light = 0.42 + 0.58 * abs(dot(normalize(v_nrm), u_sunView));
  vec3 col = u_ringColor * (0.45 + 0.55 * lum) * light;
  float a = lum * 0.88 * light;
  outColor = vec4(col, a);
}`;
