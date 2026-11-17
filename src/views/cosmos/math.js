/* 从 cosmos.js 拆出：向量与随机数 */

/* ---------- 数学 ---------- */

export function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vecLen(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vecSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vecScale(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function isZero(a) {
  return vecLen(a) < 1e-6;
}

export function normalize3(v) {
  const len = vecLen(v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function lerp3(a, b, k) {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/* a*A + b*B + c*C：三个向量按系数相加，本文件里到处是这种组合 */
export function combine3(a, ka, b, kb, c, kc) {
  return [
    a[0] * ka + b[0] * kb + c[0] * kc,
    a[1] * ka + b[1] * kb + c[1] * kc,
    a[2] * ka + b[2] * kb + c[2] * kc,
  ];
}

export function ramp(cur, target, maxDelta) {
  if (cur < target) return Math.min(target, cur + maxDelta);
  return Math.max(target, cur - maxDelta);
}

/* Rodrigues 旋转 */
export function rotateAxis(v, axis, angle) {
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
export function mulMat3(a, b) {
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

export function applyMat3(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

export function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
