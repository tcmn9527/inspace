/* 从 cosmos.js 拆出：星点 */

import { BRIGHT_COUNT, DUST_FIELDS, STAR_COLORS, STAR_SHELLS, STAR_WEIGHTS } from "./constants.js";
import { mulberry32 } from "./math.js";
import { state } from "./state.js";

/* ---------- 星点 ---------- */

export function buildStars() {
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
export function buildStarData(spec, world) {
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

export function pickStarColor(rnd) {
  let roll = rnd();
  for (let i = 0; i < STAR_WEIGHTS.length; i++) {
    roll -= STAR_WEIGHTS[i];
    if (roll <= 0) return STAR_COLORS[i];
  }
  return STAR_COLORS[2];
}

export function makeStarVAO(gl, data, count) {
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
