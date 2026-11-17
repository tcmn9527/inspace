/* 从 cosmos.js 拆出：着色器源码 */

import { BLUR_TAPS, MOTION_BLUR } from "./constants.js";

/* ---------- 着色器 ---------- */

export const SKY_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 1.0, 1.0);
}`;

export const SKY_FS = `#version 300 es
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

export const STAR_VS = `#version 300 es
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

export const STAR_FS = `#version 300 es
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

export const BRIGHT_FS = `#version 300 es
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

export const PLANET_VS = `#version 300 es
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

export const PLANET_FS = `#version 300 es
precision highp float;
in vec3 v_nrm;
in vec2 v_uv;
uniform mat3 u_rot;
uniform vec3 u_camc;
uniform sampler2D u_day;
uniform sampler2D u_night;
uniform float u_hasNight;
uniform vec3 u_atmo;
uniform vec3 u_sunView;
uniform float u_brightness;
uniform float u_focal;
uniform float u_dpr;
uniform vec2 u_blur;
uniform float u_radius;
out vec4 outColor;
void main() {
  vec3 n = normalize(v_nrm);
  /* 相机画布 +z 指向观察者：这半边是正面，用补光保证贴图细节 */
  float sunL = dot(n, u_sunView);
  float key = smoothstep(-0.28, 0.42, sunL);
  float fill = max(n.z, 0.0);
  float light = 0.18 + 0.5 * key + 0.38 * fill;
  /* 每个屏幕像素横向、纵向各跨过多少纹素，解析求出来交给 textureGrad。
     近距绕飞时相机只在 1.3 倍半径外，看到的是个球冠：越靠轮廓，视线越贴着球面走，
     竖直方向一像素能跨过五个纹素行，水平方向却接近 1:1。这种强各向异性用一个标量
     LOD 表达不了——压少了轮廓那圈混叠，混叠相位随相机横移每帧变，看着就是「轮廓不
     动、里面的地表在游」；压多了正对镜头的细节全丢。逐像素导数倒是各向异性的，但它
     在 2x2 quad 上算，跨三角形边时整块地表会跳级，所以这里自己把导数算出来。 */
  vec3 surf = u_camc + u_radius * n;
  float len = length(surf);
  vec3 dir = surf / len;
  float focalPx = u_focal * u_dpr;
  float rc = -focalPx * len / surf.z;
  float cc = dot(u_camc, u_camc) - u_radius * u_radius;
  float proj = dot(u_camc, dir);
  float dd = sqrt(max(proj * proj - cc, 1e-4));
  float dk = 1.0 - proj / dd;
  vec3 ddX = (vec3(1.0, 0.0, 0.0) - dir * dir.x) / rc;
  vec3 ddY = (vec3(0.0, 1.0, 0.0) - dir * dir.y) / rc;
  vec3 dpX = ddX * len + dir * (dot(u_camc, ddX) * dk);
  vec3 dpY = ddY * len + dir * (dot(u_camc, ddY) * dk);
  mat3 toLocal = transpose(u_rot);
  vec3 oDir = toLocal * n;
  vec3 oX = toLocal * dpX / u_radius;
  vec3 oY = toLocal * dpY / u_radius;
  float latK = 1.0 / (3.14159265 * sqrt(max(1.0 - oDir.y * oDir.y, 1e-4)));
  float lonK = 1.0 / (6.2831853 * max(oDir.x * oDir.x + oDir.z * oDir.z, 1e-6));
  vec2 gX = vec2((oDir.z * oX.x - oDir.x * oX.z) * lonK, -oX.y * latK);
  vec2 gY = vec2((oDir.z * oY.x - oDir.x * oY.z) * lonK, -oY.y * latK);
  /* u_blur 是本帧贴图在屏幕上划过的设备像素（已乘 MOTION_BLUR）。锐利采样只留瞬时那一刀，
     一帧跨过几个像素时高频纹素逐帧换相位落在同一个像素上，就是「轮廓不动、里面的地表在游」。
     沿位移方向把快门摊成几枚瞬时采样求平均，等于真实相机 1/60 秒的那条拖影：footprint
     仍是上面算好的各向异性那一条，只有采样点沿线散开，所以细节不糊成一团，只是不再游。 */
  vec2 smear = u_blur.x * gX + u_blur.y * gY;
  vec3 day = textureGrad(u_day, v_uv, gX, gY).rgb;
  if (dot(u_blur, u_blur) > 0.25) {
    day = vec3(0.0);
    for (int i = 0; i < ${BLUR_TAPS}; i++) {
      float k = (float(i) + 0.5) / float(${BLUR_TAPS}) - 0.5;
      day += textureGrad(u_day, v_uv + smear * k, gX, gY).rgb;
    }
    day /= float(${BLUR_TAPS});
  }
  vec3 col = day * light * u_brightness;
  if (u_hasNight > 0.5) {
    vec3 night = textureGrad(u_night, v_uv, gX, gY).rgb;
    float nightMix = (1.0 - key) * (1.0 - 0.6 * fill);
    col += night * nightMix * 0.8;
  }
  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
  col += u_atmo * rim * (0.25 + 0.75 * max(sunL, 0.0)) * 0.9;
  outColor = vec4(col, 1.0);
}`;

export const RING_VS = `#version 300 es
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

export const RING_FS = `#version 300 es
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
