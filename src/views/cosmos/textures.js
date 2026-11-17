/* 从 cosmos.js 拆出：贴图与 8K 档位 */

import { makeStarVAO } from "./stars.js";
import { PLANET_DEFS, TEX_BASE, invoke } from "./constants.js";
import { decodeBase64, imageFromBytes, makeMeshVAO, makeProgram, makeRing, makeRingVAO, makeSphere } from "./gl.js";
import { BRIGHT_FS, PLANET_FS, PLANET_VS, RING_FS, RING_VS, SKY_FS, SKY_VS, STAR_FS, STAR_VS } from "./shaders.js";
import { state } from "./state.js";

/* ---------- 资源 ---------- */

export function loadTexture(file) {
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

export function uploadTexture(img) {
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

export function initResources(gl) {
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

export function refreshPack() {
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

export function dropHiRes() {
  if (!state.ok) return;
  const gl = state.gl;
  for (const tex of state.hi.values()) gl.deleteTexture(tex);
  state.hi.clear();
  state.hiLoading.clear();
  state.hiBad.clear();
  state.hiOwner = 0;
}

/* 一张 8K 进显存是上百 MB 的量，同屏既然只画一颗，就只留这一颗的几张 */
export function useHiRes(b) {
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

export function heroTexNames(b) {
  const def = PLANET_DEFS[b.type];
  const names = [def.day];
  if (def.night) names.push(def.night);
  if (def.ring) names.push("saturn-ring");
  return names;
}

/* 取贴图：下过这张 8K 就用它，没下过（或还在解）就退回内置 2K */
export function texOf(name) {
  return state.hi.get(name) || state.textures.get(name) || null;
}

export function loadHiRes(name) {
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
export function glHasError() {
  const gl = state.gl;
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    console.warn("8K 贴图上传失败，WebGL 错误码", error);
    return true;
  }
  return false;
}
