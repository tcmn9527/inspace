/* 从 cosmos.js 拆出：航线状态机 */

import { cosmosFlight } from "./api.js";
import { ACTION_HINTS } from "./api.js";
import { CLOSEST_K, CRUISE, EARTH_FAR_K, EARTH_FAR_LAPS, EARTH_NEAR_LAPS, ENGAGE, FAR, GAP_JITTER, GOTO_DIST, KEEP_AHEAD, LAP_TIME, LEAD, MAX_BODIES, MAX_PITCH_Y, ORBIT_ENTER_K, ORBIT_K, ORBIT_TILT_FLAT, ORBIT_TILT_STEEP, PLANET_DEFS, ROUTE, SPAWN_LATERAL, SPAWN_VERTICAL, TURN_RATE, TYPES, WARP_R } from "./constants.js";
import { clamp, combine3, cross3, isZero, lerp3, mulberry32, normalize3, ramp, rotateAxis, smoothstep, vecDot, vecLen, vecScale, vecSub } from "./math.js";
import { state } from "./state.js";
import { basisFor, describeBody, updateDust } from "./view.js";

export function resetFlight() {
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
    /* 名单走到哪儿了：新画布从第一颗重新开始 */
    queue: 0,
    /* 绕飞平面的花样：第 1 次偏竖向、第 2 次偏横向，方向逐次反转 */
    orbitCount: 0,
    orbitDir: 1,
    wanderPhase: rnd() * Math.PI * 2,
    bodies: [],
  };
  state.nextBodyId = 1;
  for (let i = 0; i < keepAhead(); i++) spawnBody();
  updateDust(true, 0);
}

export function updateFlight(dt) {
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

export function cruiseStep(f, dt) {
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
export function leadDirection(f) {
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

export function approachStep(f, dt) {
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

export function orbitStep(f, dt) {
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

  /* 绕飞死盯球心，不加来回漂移：贴脸距离下球的视角半径 50°，画面垂直半视场只有 43.6°，
     球整个溢出画面，只有顶部那条弧对着黑天——视线哪怕只偏 3°，那条弧就在屏幕上滑上百来像素，
     这就是「绕到这颗星，顶部这条带子每次都在晃」的来源。地表本来就一直在横向滑过，不缺这点动。 */
  const observe = normalize3(vecSub(b.pos, f.pos));
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

export function departStep(f, dt) {
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
  /* 交回巡航的时机看画面，不看距离：绕飞结束时这颗还占着大半个屏幕，
     一到 1.5 倍轨道半径就把它从主角里撤掉，星球会凭空消失。等它慢慢滑出视野再撤。 */
  const d = vecLen(rel);
  if (d > orbitR * 1.5 && (d > orbitR * 8 || !discInSight(b, f))) {
    f.focus = null;
    f.phase = "cruise";
  }
}

/* 这颗的圆面（连环一起）还有没有一部分在画面里 */
export function discInSight(b, f) {
  const rel = vecSub(b.pos, f.pos);
  const d = vecLen(rel);
  if (d < 1) return true;
  const off = Math.acos(clamp(vecDot(rel, normalize3(f.view)) / d, -1, 1));
  /* 视锥横向半角 + 这颗自己的角半径；已经大到包住整个视野时算出来的就是「在画面里」 */
  const half = Math.atan2(state.w / 2, state.proj.focal) + Math.asin(Math.min(0.999, (b.r * 2.6) / d));
  return off < half;
}

export function approachSpeed(d, orbitR) {
  const orbitSpeed = (Math.PI * 2 * orbitR) / LAP_TIME;
  const span = Math.max(1, d - orbitR);
  return clamp(Math.max(d / 90, orbitSpeed + span / 14), orbitSpeed, CRUISE);
}

export function enterOrbit(f, b, orbitR) {
  const minDist = b.r * CLOSEST_K;
  let offset = vecSub(f.pos, b.pos);
  let d = vecLen(offset);
  if (d < minDist) {
    offset = vecScale(normalize3(offset), minDist);
    d = minDist;
    f.pos = [b.pos[0] + offset[0], b.pos[1] + offset[1], b.pos[2] + offset[2]];
  }
  const o1 = normalize3(offset);
  /* 基础切线取水平东向；再绕 o1 倾斜，让轨道竖起来。
     交替「接近横向 / 明显竖向」，方向也每次反转，不再永远顺着同一方向横着绕。
     竖向封顶 65°，再陡就会从极点正上方往下看，世界 up 退化会翻屏。 */
  let u2 = normalize3(cross3([0, 1, 0], o1));
  if (isZero(u2)) u2 = [0, 0, -1];
  f.orbitCount = (f.orbitCount || 0) + 1;
  const steep = f.orbitCount % 2 === 1;
  const [tiltLo, tiltHi] = steep ? ORBIT_TILT_STEEP : ORBIT_TILT_FLAT;
  const tilt = (tiltLo + b.rnd() * (tiltHi - tiltLo)) * (b.rnd() < 0.5 ? -1 : 1);
  u2 = normalize3(rotateAxis(u2, o1, tilt));
  f.orbitDir = -(f.orbitDir || 1);
  if (f.orbitDir < 0) u2 = normalize3(vecScale(u2, -1));
  const axis = normalize3(cross3(o1, u2));
  /* 地球走两段：先 1.65 倍把整颗球看全，两圈到了换的点再把目标降到 1.3 倍 */
  const earth = b.type === "earth";
  const firstR = earth ? b.r * EARTH_FAR_K : orbitR;
  /* 一圈 150 秒，绕一两圈就是三到五分钟——看得完，又不至于走不了。
     末了那 1.5 弧度（约 36 秒）本来就在偏头准备启程，不算一整圈 */
  const laps = earth ? EARTH_FAR_LAPS + EARTH_NEAR_LAPS : 1.5 + (b.rnd() < 0.55 ? 0.5 : 0);
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
    spin: 0,
    look: 0,
  };
  f.phase = "orbit";
}

export function skipEncounter() {
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

export function gotoBody(arg) {
  const f = state.flight;
  if (!f) return { ok: false, note: "宇宙主题还没激活" };
  const body = resolveTarget(f, arg);
  f.focus = body;
  body.visited = false;
  f.orbit = null;
  f.phase = "approach";
  f.paused = false;
  return { ok: true, action: "goto", body: describeBody(body, f), ...cosmosFlight() };
}

/* 追哪颗：id 直接找；只给类型就先挑前方最近那颗没看过的，一颗都没有就现造一颗摆在正前方 */
export function resolveTarget(f, arg) {
  const key = arg === null || arg === undefined ? "" : String(arg).trim().toLowerCase();
  if (!key) throw new Error(`要带 body 或 type；${ACTION_HINTS}`);
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
  return body;
}

/* 直接挪到那颗星旁边，省掉追上去的几分钟。落点沿「星→镜头」这条射线，
   所以看到的还是刚才那一面，不会瞬移完球换了个朝向。
   只摆位置和视线，阶段仍旧交给状态机自己走，落地之后运动是连续的。 */
export function warpBody(arg, distance) {
  const f = state.flight;
  if (!f) return { ok: false, note: "宇宙主题还没激活" };
  const b = resolveTarget(f, arg);
  const k = clamp(Number(distance) || WARP_R, 1.15, 60);
  const land = b.r * k;
  let dir = vecSub(f.pos, b.pos);
  if (vecLen(dir) < 1) dir = vecScale(f.view, -1);
  const unit = normalize3(dir);
  f.pos = [b.pos[0] + unit[0] * land, b.pos[1] + unit[1] * land, b.pos[2] + unit[2] * land];
  f.route = normalize3(vecSub(b.pos, f.pos));
  f.view = f.route;
  f.speed = approachSpeed(land, b.r * ORBIT_K);
  f.focus = b;
  b.visited = false;
  f.orbit = null;
  f.phase = "approach";
  f.paused = false;
  return { ok: true, action: "warp", landRadius: Math.round(land), body: describeBody(b, f), ...cosmosFlight() };
}

export function pickByType(f, type) {
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

export function pickTarget(f) {
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
export function recycleBodies(f) {
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
  while (aheadCount < keepAhead() && f.bodies.length < MAX_BODIES && guard < 12) {
    spawnBody();
    aheadCount++;
    guard++;
  }
}

/* 前方常备几颗：间隔越大备得越少，免得最远那颗跑到远裁剪面外被反复回收重生 */
export function keepAhead() {
  return clamp(Math.floor((FAR * 0.75) / gapBase()), 1, KEEP_AHEAD);
}

/* 名单是循环的：走完一轮从头再走，所以地球也能每轮遇到一次 */
export function nextType(f) {
  const order = ROUTE.order;
  const type = order[f.queue % order.length];
  f.queue += 1;
  return type;
}

/* straight：正摆在航线轴上，给 goto 用，免得目标歪到够不着 */
export function makeBody(f, type, straight, dist) {
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
export function nextSpawnDistance(f) {
  let frontier = 0;
  for (const b of f.bodies) {
    const ahead = vecDot(vecSub(b.pos, f.pos), f.route);
    if (ahead > frontier) frontier = ahead;
  }
  if (!frontier) return gapDistance(f);
  return frontier + gapDistance(f);
}

/* 用户说的是分钟，世界距离按巡航速度换算 */
export function gapBase() {
  return CRUISE * ROUTE.minutes * 60;
}

export function gapDistance(f) {
  const jitter = 1 - GAP_JITTER / 2 + f.rnd() * GAP_JITTER;
  return gapBase() * jitter;
}

export function spawnBody() {
  const f = state.flight;
  if (!f || f.bodies.length >= MAX_BODIES) return null;
  const body = makeBody(f, nextType(f), false, nextSpawnDistance(f));
  f.bodies.push(body);
  return body;
}

/* 航线自己慢慢游荡，天空才会一直变 */
export function meander(f, dt) {
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

export function advance(f, dt) {
  f.pos = [
    f.pos[0] + f.view[0] * f.speed * dt,
    f.pos[1] + f.view[1] * f.speed * dt,
    f.pos[2] + f.view[2] * f.speed * dt,
  ];
}

export function steerView(f, target, dt) {
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
