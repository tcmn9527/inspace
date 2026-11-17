/* 从 cosmos.js 拆出：WebGL 网格与光晕 */

import { FLARE_MAX_PX, FLARE_MIN_PX, FLARE_SIZE, PLANET_DEFS } from "./constants.js";
import { smoothstep } from "./math.js";
import { state } from "./state.js";

export function decodeBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/* blob 地址是同源的，直接喂给 WebGL 不会被当成跨域图 */
export function imageFromBytes(bytes, name) {
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
export function drawHeroFlare(b, body) {
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

export function makeProgram(vsSource, fsSource) {
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
export function makeSphere() {
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

export function makeRing() {
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

export function makeMeshVAO(vertices, indices) {
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

export function makeRingVAO(vertices, indices) {
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
