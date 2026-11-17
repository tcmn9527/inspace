/* 从 cosmos.js 拆出：相机、尘土与描述 */

import { DUST_FADE, DUST_FIELDS, FAR, FOV_K, HEAD_MAG, HEAD_PITCH, HEAD_YAW, LAP_TIME, MAX_PITCH_Y, NEAR, PLANET_DEFS } from "./constants.js";
import { applyMat3, clamp, cross3, isZero, mulMat3, normalize3, rotateAxis, vecDot, vecLen, vecSub } from "./math.js";
import { state } from "./state.js";

/* ---------- 相机 ---------- */

export function computeView(dt) {
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

export function basisFor(dir) {
  let right = normalize3(cross3(dir, [0, 1, 0]));
  if (isZero(right)) right = [1, 0, 0];
  const up = normalize3(cross3(right, dir));
  return { right, up, forward: normalize3(dir) };
}

export function projectBody(b, view) {
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
export function objectRotation(b) {
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

export function northAxis(b) {
  return [
    Math.sin(b.tilt) * Math.cos(b.azimuth),
    Math.cos(b.tilt),
    Math.sin(b.tilt) * Math.sin(b.azimuth),
  ];
}

/* 和北轴垂直的参考轴；正好朝天转的星球取本初子午线方向 */
export function sideAxis(t, azimuth) {
  const a = normalize3(cross3(t, [0, 1, 0]));
  if (!isZero(a)) return a;
  return normalize3([Math.cos(azimuth), 0, Math.sin(azimuth)]);
}

/* ---------- 近处尘埃：世界坐标固定，靠视差往后掠 ---------- */

export function updateDust(rebuild, dt) {
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

export function placeDust(d, i, basis, pos) {
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

export function uploadDust(d) {
  if (!d || !d.dirty) return;
  const gl = state.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, d.buffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.data);
  d.dirty = false;
}

/* ---------- 描述给 MCP ---------- */

export function describeBody(b, f) {
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

export function describeFocus(f) {
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
      /* 这一段轨道平面离赤道有多陡、往哪边绕；给 MCP 自测用 */
      planeTilt: Math.round(Math.acos(clamp(Math.abs(o.axis[1]), 0, 1)) * (180 / Math.PI)),
      direction: f.orbitDir < 0 ? "cw" : "ccw",
    };
  }
  return out;
}

/* 视线仰角：正=往上抬，负=往下俯 */
export function pitchOf(dir) {
  return Math.round(Math.asin(clamp(dir[1], -1, 1)) * (180 / Math.PI));
}
