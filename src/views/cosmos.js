/* 宇宙主题背景：一张全屏 WebGL2 画布，叠在空间底色上、块和连线层下面。
 *
 * 从远到近四层：
 *   星野   三层视差的小星点，按星等亮度分布和色温着色，亮星带光晕与十字星芒；
 *   银河   真实银河影像，只做最远处的尘埃带；
 *   星云   真实星云照片，加法混合，缓慢漂移；
 *   行星   真实等距圆柱贴图 + 球面光照（晨昏线、大气边缘、地球夜面灯光、土星环），
 *          按世界坐标的格子分布在场里，锚点附近固定摆一组太阳系。
 * 另加偶发流星。相机和空间种子由 canvas.js 推过来，主题由 theme.js 用事件通知。
 *
 * 只有「宇宙」主题激活时才跑渲染循环；窗口隐藏时浏览器会自动停掉 rAF。
 * 贴图在第一次激活时才加载，没切过宇宙主题就一分资源也不占。 */

const TEX_BASE = "/assets/cosmos/";
const PLANET_LAYER = 0.4;
const CELL = 2400;
/* 太阳放在观察者正前方：星体朝我们的一整面都被照亮，贴图细节最清楚 */
const SUN = normalize3([0, 0, 1]);

const STAR_LAYERS = [
  { depth: 0.02, count: 3400, size: [0.55, 1.4], alpha: 0.36 },
  { depth: 0.05, count: 2400, size: [0.75, 1.9], alpha: 0.44 },
  { depth: 0.1, count: 1500, size: [1.0, 2.5], alpha: 0.52 },
];

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
    day: "earth-day",
    night: "earth-night",
    atmo: [0.34, 0.6, 1.0],
    speed: 0.07,
    tilt: 0.41,
    brightness: 0.92,
  },
  moon: { day: "moon", atmo: null, speed: 0.03, tilt: 0.12, brightness: 0.95 },
  mars: {
    day: "mars",
    atmo: [0.95, 0.46, 0.26],
    speed: 0.06,
    tilt: 0.44,
    brightness: 0.9,
  },
  jupiter: {
    day: "jupiter",
    atmo: [0.92, 0.82, 0.62],
    speed: 0.16,
    tilt: 0.05,
    brightness: 0.9,
  },
  saturn: {
    day: "saturn",
    atmo: [0.95, 0.86, 0.64],
    speed: 0.13,
    tilt: 0.47,
    brightness: 0.9,
    ring: true,
  },
};
/* 随机星域里不再出现地球：固定太阳系那颗就是唯一的地球，重复会一眼看穿 */
const RANDOM_TYPES = ["moon", "mars", "jupiter", "saturn"];

/* 锚点附近固定的一组，保证第一次切进宇宙主题一定有景可看 */
const SOLAR = [
  { type: "earth", dx: -380, dy: -190, r: 150, phase: 0.4 },
  { type: "jupiter", dx: 420, dy: -200, r: 170, phase: 1.9 },
  { type: "saturn", dx: 30, dy: 330, r: 118, phase: 3.1 },
  { type: "mars", dx: -450, dy: 220, r: 75, phase: 5.2 },
  { type: "moon", dx: 300, dy: 170, r: 40, phase: 2.4 },
];

const NEBULAE = [
  { depth: 0.14, dx: -820, dy: -560, size: 1250, rot: 0.35, tint: [0.62, 0.78, 1.0], alpha: 0.16 },
  { depth: 0.2, dx: 980, dy: 620, size: 1600, rot: -0.8, tint: [1.0, 0.82, 0.66], alpha: 0.1 },
];

const TEX_NAMES = [
  "earth-day",
  "earth-night",
  "moon",
  "mars",
  "jupiter",
  "saturn",
  "saturn-ring",
  "galaxy",
  "nebula",
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
  nebula: "nebula-pillars.jpg",
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
  starLayers: [],
  bright: null,
  textures: new Map(),
  texturesStarted: false,
  anchor: null,
  nebulaAnchors: null,
  meteors: [],
  nextMeteor: 5,
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

/* canvas.js 的 applyCamera 每次相机变化都会推过来 */
export function setCosmosCamera(camera) {
  state.cam.x = camera.x;
  state.cam.y = camera.y;
  state.cam.scale = camera.scale;
  state.camKnown = true;
  if (state.ok && !state.anchor && state.w) ensureAnchors();
}

/* 换空间时换一片星空；星体和星云重新锚定到新视野 */
export function setCosmosSeed(id) {
  state.pendingSeed = id || "inspace";
  if (!state.ok) return;
  const seed = hashString(state.pendingSeed);
  if (seed === state.seed) return;
  state.seed = seed;
  state.anchor = null;
  state.nebulaAnchors = null;
  buildStars();
  if (state.camKnown && state.w) ensureAnchors();
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
  return true;
}

function activate() {
  if (!state.canvas || state.active) return;
  if (!ensureGL()) return;
  state.active = true;
  state.canvas.hidden = false;
  resize();
  if (state.camKnown) ensureAnchors();
  ensureTextures();
  state.last = performance.now();
  startLoop();
}

function deactivate() {
  if (!state.active) return;
  state.active = false;
  stopLoop();
  state.canvas.hidden = true;
  state.meteors.length = 0;
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
  if (w && h && state.camKnown) ensureAnchors();
}

function ensureAnchors() {
  if (!state.w || !state.h) return;
  state.anchor = anchorFor(PLANET_LAYER);
  state.nebulaAnchors = NEBULAE.map((n) => {
    const a = anchorFor(n.depth);
    return { ...n, ax: a.x, ay: a.y };
  });
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
  render(dt);
}

function render(dt) {
  const gl = state.gl;
  gl.viewport(0, 0, state.canvas.width, state.canvas.height);
  gl.depthMask(true);
  gl.clearColor(0.006, 0.008, 0.014, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  drawSky();
  drawGalaxy();
  drawNebulae();
  drawStars();
  drawPlanets();
  updateMeteors(dt);
  drawMeteors();
}

function drawSky() {
  const gl = state.gl;
  const prog = state.programs.sky;
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog.program);
  gl.bindVertexArray(state.quad.vao);
  gl.uniform1f(prog.u.u_aspect, state.w / Math.max(1, state.h));
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawGalaxy() {
  const tex = state.textures.get("galaxy");
  if (!tex) return;
  const size = Math.max(state.w, state.h) * 0.9;
  const rot = -0.16 + Math.sin(state.time * 0.008) * 0.006;
  const drift = state.time * 0.0015;
  drawTexturedQuad(
    tex,
    state.w / 2,
    state.h / 2,
    size,
    size * 0.5,
    rot,
    -state.cam.x * 0.000006,
    -state.cam.y * 0.000006 + drift,
    [1.0, 0.98, 0.96],
    0.17,
  );
}

function drawNebulae() {
  const tex = state.textures.get("nebula");
  if (!tex || !state.nebulaAnchors) return;
  for (const n of state.nebulaAnchors) {
    const driftX = Math.sin(state.time * 0.018 + n.rot * 4) * 24;
    const driftY = Math.cos(state.time * 0.014 + n.rot * 3) * 18;
    const p = projectPlanet(n.ax + n.dx + driftX, n.ay + n.dy + driftY, n.depth);
    const size = n.size * p.s;
    drawTexturedQuad(
      tex,
      p.x,
      p.y,
      size,
      size,
      n.rot + state.time * 0.004,
      0,
      0,
      n.tint,
      n.alpha * (0.92 + 0.08 * Math.sin(state.time * 0.05 + n.rot)),
    );
  }
}

function drawStars() {
  const gl = state.gl;
  const prog = state.programs.star;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog.program);
  gl.uniform2f(prog.u.u_res, state.w, state.h);
  gl.uniform1f(prog.u.u_time, state.time);
  gl.uniform1f(prog.u.u_dpr, state.dpr);
  gl.uniform1f(prog.u.u_sizeScale, clamp(state.cam.scale, 0.8, 1.5));
  for (const layer of state.starLayers) {
    gl.uniform2f(
      prog.u.u_scroll,
      (state.cam.x * layer.depth) / Math.max(1, state.w),
      (state.cam.y * layer.depth) / Math.max(1, state.h),
    );
    gl.bindVertexArray(layer.vao);
    gl.drawArrays(gl.POINTS, 0, layer.count);
  }
  if (state.bright) {
    const prog2 = state.programs.bright;
    gl.useProgram(prog2.program);
    gl.uniform2f(prog2.u.u_res, state.w, state.h);
    gl.uniform1f(prog2.u.u_time, state.time);
    gl.uniform1f(prog2.u.u_dpr, state.dpr);
    gl.uniform1f(prog2.u.u_sizeScale, clamp(state.cam.scale, 0.85, 1.35));
    gl.uniform2f(
      prog2.u.u_scroll,
      (state.cam.x * 0.08) / Math.max(1, state.w),
      (state.cam.y * 0.08) / Math.max(1, state.h),
    );
    gl.bindVertexArray(state.bright.vao);
    gl.drawArrays(gl.POINTS, 0, state.bright.count);
  }
  gl.disable(gl.BLEND);
}

function drawPlanets() {
  const gl = state.gl;
  if (!state.anchor) return;
  const list = planetList();
  if (!list.length) return;
  list.sort((a, b) => a.y - b.y);
  for (let i = 0; i < list.length; i++) list[i].depth = i * 600;

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  const prog = state.programs.planet;
  gl.useProgram(prog.program);
  gl.uniform2f(prog.u.u_res, state.w, state.h);
  gl.uniform3fv(prog.u.u_sun, SUN);
  gl.uniform1i(prog.u.u_day, 0);
  gl.uniform1i(prog.u.u_night, 1);
  gl.activeTexture(gl.TEXTURE0);

  for (const p of list) drawSphere(p);

  gl.depthMask(false);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const ringProg = state.programs.ring;
  for (const p of list) {
    if (PLANET_DEFS[p.type].ring) drawSaturnRing(ringProg, p);
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
}

function planetList() {
  const list = [];
  const anchor = state.anchor;
  if (!anchor) return list;
  for (const s of SOLAR) {
    list.push({
      type: s.type,
      x: anchor.x + s.dx,
      y: anchor.y + s.dy,
      r: s.r,
      phase: s.phase,
      extraTilt: 0,
    });
  }
  const d = PLANET_LAYER;
  const s = 1 + (state.cam.scale - 1) * d;
  const left = (0 - state.cam.x * d) / s;
  const right = (state.w - state.cam.x * d) / s;
  const top = (0 - state.cam.y * d) / s;
  const bottom = (state.h - state.cam.y * d) / s;
  const g0 = Math.floor(left / CELL);
  const g1 = Math.floor(right / CELL);
  const h0 = Math.floor(top / CELL);
  const h1 = Math.floor(bottom / CELL);
  for (let gx = g0; gx <= g1; gx++) {
    for (let gy = h0; gy <= h1; gy++) {
      const rnd = cellRandom(state.seed, gx, gy);
      if (rnd() > 0.34) continue;
      let type = RANDOM_TYPES[Math.min(RANDOM_TYPES.length - 1, Math.floor(rnd() * RANDOM_TYPES.length))];
      const x = (gx + 0.16 + rnd() * 0.68) * CELL;
      const y = (gy + 0.16 + rnd() * 0.68) * CELL;
      const r = 52 + rnd() * 95;
      const phase = rnd() * Math.PI * 2;
      const extraTilt = (rnd() - 0.5) * 0.24;
      if (nearSolar(x, y, r)) continue;
      list.push({ type, x, y, r, phase, extraTilt });
    }
  }
  return list;
}

function nearSolar(x, y, r) {
  for (const s of SOLAR) {
    const sx = state.anchor.x + s.dx;
    const sy = state.anchor.y + s.dy;
    const min = (s.r + r) * 2.4;
    if (Math.abs(x - sx) < min && Math.abs(y - sy) < min) return true;
  }
  return false;
}

function drawSphere(p) {
  const def = PLANET_DEFS[p.type];
  const dayTex = state.textures.get(def.day);
  if (!dayTex) return;
  const center = projectPlanet(p.x, p.y, PLANET_LAYER);
  const radius = p.r * center.s;
  if (!onScreen(center.x, center.y, radius)) return;

  const gl = state.gl;
  const progUse = state.programs.planet;
  gl.useProgram(progUse.program);
  gl.bindVertexArray(state.sphere.vao);
  gl.uniform2f(progUse.u.u_center, center.x, center.y);
  gl.uniform1f(progUse.u.u_radius, radius);
  gl.uniform1f(progUse.u.u_depth, p.depth);
  gl.uniformMatrix3fv(progUse.u.u_rot, false, rotationMatrix(p.phase + state.time * def.speed, def.tilt + p.extraTilt));
  gl.uniform1f(progUse.u.u_brightness, def.brightness);
  gl.uniform3fv(progUse.u.u_atmo, def.atmo || [0, 0, 0]);
  gl.uniform1f(progUse.u.u_hasNight, def.night ? 1 : 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, dayTex);
  if (def.night) {
    const nightTex = state.textures.get(def.night);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, nightTex || dayTex);
  }
  gl.drawElements(gl.TRIANGLES, state.sphere.count, gl.UNSIGNED_SHORT, 0);
}

function drawSaturnRing(prog, p) {
  const tex = state.textures.get("saturn-ring");
  if (!tex) return;
  const def = PLANET_DEFS[p.type];
  const center = projectPlanet(p.x, p.y, PLANET_LAYER);
  const radius = p.r * center.s;
  if (!onScreen(center.x, center.y, radius * 2.3)) return;

  const gl = state.gl;
  gl.useProgram(prog.program);
  gl.bindVertexArray(state.ring.vao);
  gl.uniform2f(prog.u.u_res, state.w, state.h);
  gl.uniform2f(prog.u.u_center, center.x, center.y);
  gl.uniform1f(prog.u.u_radius, radius);
  gl.uniform1f(prog.u.u_depth, p.depth);
  gl.uniformMatrix3fv(prog.u.u_rot, false, rotationMatrix(0, def.tilt + p.extraTilt));
  gl.uniform3fv(prog.u.u_sun, SUN);
  gl.uniform3f(prog.u.u_ringColor, 0.8, 0.74, 0.6);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(prog.u.u_ring, 2);
  gl.drawElements(gl.TRIANGLES, state.ring.count, gl.UNSIGNED_SHORT, 0);
}

function updateMeteors(dt) {
  state.nextMeteor -= dt;
  if (state.nextMeteor <= 0) {
    state.nextMeteor = 7 + Math.random() * 10;
    if (state.meteors.length < 2) {
      const fromLeft = Math.random() < 0.6;
      const x = fromLeft ? -60 : state.w * (0.35 + Math.random() * 0.55);
      const y = state.h * (0.04 + Math.random() * 0.26);
      const angle = fromLeft ? 0.52 : 2.55;
      const speed = 950 + Math.random() * 650;
      state.meteors.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        max: 0.9 + Math.random() * 0.6,
        speed,
      });
    }
  }
  for (const m of state.meteors) {
    m.life += dt;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
  }
  state.meteors = state.meteors.filter(
    (m) => m.life < m.max && m.x > -300 && m.x < state.w + 300 && m.y < state.h + 300,
  );
}

function drawMeteors() {
  if (!state.meteors.length) return;
  const gl = state.gl;
  const prog = state.programs.meteor;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog.program);
  gl.bindVertexArray(state.quad.vao);
  gl.uniform2f(prog.u.u_res, state.w, state.h);

  for (const m of state.meteors) {
    const k = m.life / m.max;
    const fade = Math.sin(Math.PI * Math.min(1, k * 1.2));
    const len = m.speed * 0.28;
    const dirX = m.vx / m.speed;
    const dirY = m.vy / m.speed;
    const cx = m.x - dirX * len * 0.5;
    const cy = m.y - dirY * len * 0.5;
    const rot = Math.atan2(dirY, dirX);
    gl.uniform2f(prog.u.u_center, cx, cy);
    gl.uniform2f(prog.u.u_size, len * 0.5, 2.4);
    gl.uniform1f(prog.u.u_rot, rot);
    gl.uniform1f(prog.u.u_alpha, 0.9 * fade);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.BLEND);
}

/* ---------- 投影与数学 ---------- */

function anchorFor(depth) {
  const s = 1 + (state.cam.scale - 1) * depth;
  return {
    x: (state.w / 2 - state.cam.x * depth) / s,
    y: (state.h / 2 - state.cam.y * depth) / s,
  };
}

function projectPlanet(wx, wy, depth) {
  const s = 1 + (state.cam.scale - 1) * depth;
  return { x: wx * s + state.cam.x * depth, y: wy * s + state.cam.y * depth, s };
}

function onScreen(x, y, radius) {
  return x + radius > -60 && x - radius < state.w + 60 && y + radius > -60 && y - radius < state.h + 60;
}

/* Rz(tilt) * Ry(spin)，按 WebGL 的列主序摆 */
function rotationMatrix(spin, tilt) {
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return [
    ct * cs, st * cs, -sn,
    -st, ct, 0,
    ct * sn, st * sn, cs,
  ];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function cellRandom(seed, gx, gy) {
  let h = seed ^ Math.imul(gx, 0x27d4eb2d) ^ Math.imul(gy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return mulberry32(h >>> 0);
}

/* ---------- 星点 ---------- */

function buildStars() {
  if (!state.ok) return;
  const gl = state.gl;
  const rnd = mulberry32(state.seed ^ 0x51ed270b);
  for (const layer of state.starLayers) {
    gl.deleteBuffer(layer.buffer);
    gl.deleteVertexArray(layer.vao);
  }
  state.starLayers = [];
  for (const layer of STAR_LAYERS) {
    const data = new Float32Array(layer.count * 8);
    for (let i = 0; i < layer.count; i++) {
      const o = i * 8;
      const color = pickStarColor(rnd);
      const size = layer.size[0] + rnd() * (layer.size[1] - layer.size[0]);
      const alpha = layer.alpha * (0.45 + rnd() * 0.55);
      data[o] = rnd();
      data[o + 1] = rnd();
      data[o + 2] = color[0];
      data[o + 3] = color[1];
      data[o + 4] = color[2];
      data[o + 5] = size;
      data[o + 6] = alpha;
      data[o + 7] = rnd();
    }
    const mesh = createStarVAO(gl, data);
    state.starLayers.push({ ...layer, vao: mesh.vao, buffer: mesh.buffer });
  }
  if (state.bright) {
    gl.deleteBuffer(state.bright.buffer);
    gl.deleteVertexArray(state.bright.vao);
  }
  const count = 34;
  const data = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    const color = pickStarColor(rnd);
    const size = 26 + rnd() * 20;
    data[o] = rnd();
    data[o + 1] = rnd();
    data[o + 2] = color[0];
    data[o + 3] = color[1];
    data[o + 4] = color[2];
    data[o + 5] = size;
    data[o + 6] = 0.5 + rnd() * 0.45;
    data[o + 7] = rnd();
  }
  const brightMesh = createStarVAO(gl, data);
  state.bright = { count, vao: brightMesh.vao, buffer: brightMesh.buffer };
}

function pickStarColor(rnd) {
  let roll = rnd();
  for (let i = 0; i < STAR_WEIGHTS.length; i++) {
    roll -= STAR_WEIGHTS[i];
    if (roll <= 0) return STAR_COLORS[i];
  }
  return STAR_COLORS[2];
}

function createStarVAO(gl, data) {
  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = 32;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 28);
  gl.bindVertexArray(null);
  return { vao, buffer };
}

/* ---------- 资源 ---------- */

function createBuffer(gl, target, data) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return buffer;
}

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
  state.programs.quad = makeProgram(QUAD_VS, QUAD_FS);
  state.programs.star = makeProgram(STAR_VS, STAR_FS);
  state.programs.bright = makeProgram(STAR_VS, BRIGHT_FS);
  state.programs.planet = makeProgram(PLANET_VS, PLANET_FS);
  state.programs.ring = makeProgram(RING_VS, RING_FS);
  state.programs.meteor = makeProgram(METEOR_VS, METEOR_FS);

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

/* 球面：位置、法线、UV；UV 的 v=0 在北极，直接对上不翻转的贴图 */
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
      const x = cosLat * Math.cos(lon);
      const y = sinLat;
      const z = cosLat * Math.sin(lon);
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
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_aspect;
out vec4 outColor;
void main() {
  vec2 p = (v_uv - 0.5) * vec2(u_aspect, 1.0);
  float d = length(p);
  vec3 inner = vec3(0.015, 0.021, 0.038);
  vec3 outer = vec3(0.002, 0.003, 0.006);
  vec3 col = mix(inner, outer, smoothstep(0.15, 0.95, d));
  outColor = vec4(col, 1.0);
}`;

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform vec2 u_res;
uniform vec2 u_center;
uniform vec2 u_size;
uniform float u_rot;
uniform vec2 u_uvOffset;
uniform vec2 u_uvScale;
out vec2 v_uv;
void main() {
  float c = cos(u_rot);
  float s = sin(u_rot);
  vec2 p = vec2(a_pos.x * u_size.x, a_pos.y * u_size.y);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + u_center;
  vec2 ndc = vec2(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = u_uvOffset + vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5) * u_uvScale;
}`;

const QUAD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_tint;
uniform float u_strength;
out vec4 outColor;
void main() {
  vec3 col = texture(u_tex, v_uv).rgb;
  outColor = vec4(col * u_tint * u_strength, 1.0);
}`;

const STAR_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_base;
layout(location = 1) in vec3 a_color;
layout(location = 2) in float a_size;
layout(location = 3) in float a_alpha;
layout(location = 4) in float a_phase;
uniform vec2 u_res;
uniform vec2 u_scroll;
uniform float u_time;
uniform float u_dpr;
uniform float u_sizeScale;
out vec3 v_color;
out float v_alpha;
void main() {
  vec2 p = mod(a_base + u_scroll, 1.0) * u_res;
  vec2 ndc = vec2(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = max(1.0, a_size * u_dpr * u_sizeScale);
  float tw = 0.8 + 0.2 * sin(u_time * (1.1 + a_phase * 2.3) + a_phase * 37.0);
  v_alpha = a_alpha * tw;
  v_color = a_color;
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
uniform vec2 u_res;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_depth;
out vec3 v_nrm;
out vec2 v_uv;
void main() {
  vec3 p = u_rot * a_pos;
  v_nrm = u_rot * a_nrm;
  v_uv = a_uv;
  vec2 screen = u_center + p.xy * u_radius;
  vec2 ndc = vec2(screen.x / u_res.x * 2.0 - 1.0, 1.0 - screen.y / u_res.y * 2.0);
  float z = -(p.z * u_radius + u_depth) / 20000.0;
  gl_Position = vec4(ndc, z, 1.0);
}`;

const PLANET_FS = `#version 300 es
precision highp float;
in vec3 v_nrm;
in vec2 v_uv;
uniform sampler2D u_day;
uniform sampler2D u_night;
uniform float u_hasNight;
uniform vec3 u_atmo;
uniform vec3 u_sun;
uniform float u_brightness;
out vec4 outColor;
void main() {
  vec3 n = normalize(v_nrm);
  float lam = dot(n, u_sun);
  vec3 day = texture(u_day, v_uv).rgb;
  float dayMix = smoothstep(-0.06, 0.24, lam);
  vec3 col = day * dayMix * u_brightness;
  if (u_hasNight > 0.5) {
    vec3 night = texture(u_night, v_uv).rgb;
    float nightMix = 1.0 - smoothstep(-0.22, 0.02, lam);
    col += night * nightMix * 0.85;
  }
  col += day * 0.012;
  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
  col += u_atmo * rim * (0.22 + 0.78 * max(lam, 0.0)) * 0.9;
  outColor = vec4(col, 1.0);
}`;

const RING_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_ring;
uniform mat3 u_rot;
uniform vec2 u_res;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_depth;
out vec2 v_uv;
out vec3 v_nrm;
void main() {
  float r = a_ring.x;
  float theta = a_ring.y;
  vec3 p = vec3(cos(theta) * r, 0.0, sin(theta) * r);
  vec3 pos = u_rot * p;
  v_nrm = u_rot * vec3(0.0, 1.0, 0.0);
  v_uv = vec2((r - 1.28) / (2.25 - 1.28), 0.5);
  vec2 screen = u_center + pos.xy * u_radius;
  vec2 ndc = vec2(screen.x / u_res.x * 2.0 - 1.0, 1.0 - screen.y / u_res.y * 2.0);
  float z = -(pos.z * u_radius + u_depth) / 20000.0;
  gl_Position = vec4(ndc, z, 1.0);
}`;

const RING_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_nrm;
uniform sampler2D u_ring;
uniform vec3 u_ringColor;
uniform vec3 u_sun;
out vec4 outColor;
void main() {
  vec3 t = texture(u_ring, v_uv).rgb;
  float lum = dot(t, vec3(0.299, 0.587, 0.114));
  float light = 0.4 + 0.6 * abs(dot(normalize(v_nrm), u_sun));
  vec3 col = u_ringColor * (0.45 + 0.55 * lum) * light;
  float a = lum * 0.88 * light;
  outColor = vec4(col, a);
}`;

const METEOR_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform vec2 u_res;
uniform vec2 u_center;
uniform vec2 u_size;
uniform float u_rot;
out vec2 v_uv;
void main() {
  float c = cos(u_rot);
  float s = sin(u_rot);
  vec2 p = vec2(a_pos.x * u_size.x, a_pos.y * u_size.y);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + u_center;
  vec2 ndc = vec2(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_pos * 0.5 + 0.5;
}`;

const METEOR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_alpha;
out vec4 outColor;
void main() {
  float along = pow(v_uv.x, 3.0);
  float cross = 1.0 - abs(v_uv.y * 2.0 - 1.0);
  float a = along * pow(cross, 6.0) * u_alpha;
  outColor = vec4(vec3(0.85, 0.92, 1.0), a);
}`;

function drawTexturedQuad(tex, cx, cy, hw, hh, rot, uvx, uvy, tint, strength) {
  const gl = state.gl;
  const prog = state.programs.quad;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog.program);
  gl.bindVertexArray(state.quad.vao);
  gl.uniform2f(prog.u.u_res, state.w, state.h);
  gl.uniform2f(prog.u.u_center, cx, cy);
  gl.uniform2f(prog.u.u_size, hw, hh);
  gl.uniform1f(prog.u.u_rot, rot);
  gl.uniform2f(prog.u.u_uvOffset, uvx, uvy);
  gl.uniform2f(prog.u.u_uvScale, 1, 1);
  gl.uniform3fv(prog.u.u_tint, tint);
  gl.uniform1f(prog.u.u_strength, strength);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(prog.u.u_tex, 3);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disable(gl.BLEND);
}
