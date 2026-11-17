/* 从 cosmos.js 拆出：帧循环与画面绘制 */

import { resize } from "./api.js";
import { DUST_FIELDS, MAX_SWEEP_PX, MOTION_BLUR, PLANET_DEFS, SUN_WORLD } from "./constants.js";
import { updateFlight } from "./flight.js";
import { drawHeroFlare } from "./gl.js";
import { applyMat3, clamp, combine3, cross3, mulMat3, normalize3, vecDot, vecLen, vecSub } from "./math.js";
import { state } from "./state.js";
import { texOf, useHiRes } from "./textures.js";
import { computeView, northAxis, projectBody, sideAxis, uploadDust } from "./view.js";

/* ---------- 画面 ---------- */

export function frame(now) {
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

export function render() {
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

export function drawSky(view) {
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

export function drawStars(view) {
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
export function heroCandidates(view) {
  const f = state.flight;
  if (!f) return [];
  const pool = f.focus ? [f.focus] : f.bodies.filter((b) => !b.visited);
  return pool
    .map((b) => ({ b, d: vecLen(vecSub(b.pos, view.pos)) }))
    .sort((x, y) => x.d - y.d)
    .map((x) => x.b);
}

export function drawBodies(view) {
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
  if (!b) {
    state.heroTrack = null;
    return;
  }
  useHiRes(b);
  const sunView = normalize3(applyMat3(view.w2c, SUN_WORLD));
  const blur = trackSweep(b, view);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);
  /* 球是封闭的，远侧那半个半球本来就不该画：靠近轮廓的地方前后两层只差十几个世界单位，
     而 near=4 / far=160000 把 16 位深度在绕飞距离上压到约 30 单位一格，谁赢只剩舍入。
     背面剔除把这层不确定性一起去掉，也少画一半三角形。 */
  gl.enable(gl.CULL_FACE);
  drawSphere(b, body, sunView, blur);
  gl.disable(gl.CULL_FACE);

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

/* 本帧贴图在屏幕上划过多少设备像素（乘上 MOTION_BLUR 后交给着色器）。
   取上一帧正对镜头的那个球面点，用本帧视线再投一次，两次之差就是内容这一帧走过的路——
   贴脸掠地表才有几个像素，巡航和暂停时接近 0，所以只有绕飞才糊。换星体那一帧没有可比的前值，
   给 0；warp 那种一帧挪几万米的会算出巨大的位移，按上限夹住，宁可少糊不可乱糊。 */
export function trackSweep(b, view) {
  const dir = normalize3(vecSub(view.pos, b.pos));
  const near = combine3(b.pos, 1, dir, b.r, [0, 0, 0], 0);
  const now = projectOffset(near, view);
  const t = state.heroTrack;
  let out = [0, 0];
  if (t && t.id === b.id && now) {
    const k = state.dpr * MOTION_BLUR;
    out = [
      clamp(now[0] - t.x, -MAX_SWEEP_PX, MAX_SWEEP_PX) * k,
      clamp(now[1] - t.y, -MAX_SWEEP_PX, MAX_SWEEP_PX) * k,
    ];
  }
  state.heroTrack = now ? { id: b.id, x: now[0], y: now[1] } : null;
  return out;
}

/* 世界点投到画面中心右边/上边各多少 CSS 像素（不带屏幕原点，只差值用） */
export function projectOffset(p, view) {
  const c = applyMat3(view.w2c, vecSub(p, view.pos));
  const d = -c[2];
  if (d <= 1e-3) return null;
  const f = state.proj.focal;
  return [(c[0] / d) * f, (c[1] / d) * f];
}

export function drawSphere(b, body, sunView, blur) {
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
  gl.uniform1f(prog.u.u_focal, state.proj.focal);
  gl.uniform1f(prog.u.u_dpr, state.dpr);
  gl.uniform2f(prog.u.u_blur, blur[0], blur[1]);
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

export function drawSaturnRing(b, body, view, sunView) {
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
export function ringFrame(b) {
  const t = northAxis(b);
  const x0 = sideAxis(t, b.azimuth);
  const z0 = normalize3(cross3(x0, t));
  return [x0[0], x0[1], x0[2], t[0], t[1], t[2], z0[0], z0[1], z0[2]];
}

/* ---------- 航线状态机 ---------- */
