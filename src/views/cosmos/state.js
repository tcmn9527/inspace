/* 从 cosmos.js 拆出：可变状态 */

import { FAR, NEAR } from "./constants.js";

export const state = {
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
