/* 从 canvas.js 拆出：相机 agent 接口 */

import { MAX_SCALE, MIN_SCALE, agentAnimateCamera, agentRequireSpace, agentStopCameraAnim, applyCamera, clamp, current, numOr, scheduleCameraSave, stageCenterWorld, ui } from "../canvas.js";

/* ---------- 相机 ---------- */

export function agentSetCamera(patch = {}) {
  agentRequireSpace();
  const target = {
    x: numOr(patch.x, current.camera.x),
    y: numOr(patch.y, current.camera.y),
    scale:
      patch.scale == null ? current.camera.scale : clamp(numOr(patch.scale, current.camera.scale), MIN_SCALE, MAX_SCALE),
  };
  if (patch.instant) {
    agentStopCameraAnim();
    current.camera.x = target.x;
    current.camera.y = target.y;
    current.camera.scale = target.scale;
    applyCamera();
    scheduleCameraSave();
  } else {
    agentAnimateCamera(target, 320);
  }
  return { camera: { x: Math.round(target.x), y: Math.round(target.y), scale: Number(target.scale.toFixed(3)) } };
}

/* 回到 100%，视野中心对着原来看着的那一点——和 Ctrl+0 一个意思 */
export function agentResetZoom() {
  agentRequireSpace();
  const center = stageCenterWorld();
  const vw = ui.stage.clientWidth;
  const vh = ui.stage.clientHeight;
  const target = { scale: 1, x: vw / 2 - center.x, y: vh / 2 - center.y };
  agentAnimateCamera(target, 320);
  return { camera: { x: Math.round(target.x), y: Math.round(target.y), scale: 1 } };
}
