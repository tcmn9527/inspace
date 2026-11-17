/* canvas-items/gen-makes.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { CARD_DEFAULT_BORDER_WIDTH, CARD_DEFAULT_RADIUS, DEFAULT_BORDER, GEN_CFG_AUTO, GEN_DEFAULT_HEIGHT, GEN_DEFAULT_WIDTH, GEN_IMAGE_DEFAULT, GEN_IMAGE_MAX, GEN_IMAGE_MIN, GEN_IMAGE_STEP, GEN_MODE_DEFAULT, GEN_STEPS_AUTO, GEN_STRENGTH_DEFAULT, GEN_VIDEO_DEFAULT_HEIGHT, GEN_VIDEO_DEFAULT_WIDTH, GEN_VIDEO_SECONDS_DEFAULT } from "./constants.js";
import { clamp, newId } from "./util.js";

export function snapGenSize(value) {
  const clamped = clamp(Math.round(value), GEN_IMAGE_MIN, GEN_IMAGE_MAX);
  return Math.round(clamped / GEN_IMAGE_STEP) * GEN_IMAGE_STEP;
}

/* 生图面板：刚建出来没图，提示词也空着——等用户在框里写第一句。 */
export function makeGen(x, y, w = GEN_DEFAULT_WIDTH, h = GEN_DEFAULT_HEIGHT) {
  return {
    id: newId(),
    internal: true,
    type: "gen",
    x,
    y,
    w,
    h,
    stageH: 0,
    /* 手动拖过尺寸：提示词再长也不自动改块高，超出部分在框里滚 */
    manualSize: false,
    refine: false,
    prompt: "",
    negative: "",
    imageW: GEN_IMAGE_DEFAULT,
    imageH: GEN_IMAGE_DEFAULT,
    steps: GEN_STEPS_AUTO,
    cfg: GEN_CFG_AUTO,
    seed: -1,
    mode: GEN_MODE_DEFAULT,
    model: "",
    strength: GEN_STRENGTH_DEFAULT,
    src: "",
    borderColor: DEFAULT_BORDER,
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 视频面板：远端出片，取景窗里放播放器；参数是时长和像素尺寸（都能手改，也能从常用里挑）。 */
export function makeVideoGen(x, y, w = GEN_VIDEO_DEFAULT_WIDTH, h = GEN_VIDEO_DEFAULT_HEIGHT) {
  return {
    id: newId(),
    internal: true,
    type: "genvideo",
    x,
    y,
    w,
    h,
    prompt: "",
    seconds: GEN_VIDEO_SECONDS_DEFAULT,
    width: 1280,
    height: 720,
    borderColor: DEFAULT_BORDER,
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 颜色直接进 svg 属性，只认 #rgb / #rrggbb / #rrggbbaa，其余一律当「没填」处理 */
