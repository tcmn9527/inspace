/* 画布尺寸的基础约定：常量 + 归一化。无依赖，避免 page-width.js 与 canvas.js 循环引用。 */

export const PAGE_WIDTH_MIN = 200;
export const PAGE_WIDTH_MAX = 10000;

/* 固定宽度只认范围内的正数；缺字段、坏数据、超范围一律退回无限画布。 */
export function sanitizePageWidth(raw) {
  return Number.isFinite(raw) && raw >= PAGE_WIDTH_MIN && raw <= PAGE_WIDTH_MAX ? raw : null;
}

/* 固定宽度画布的横向视野余量：页面左右各允许多露出这么多世界像素。 */
export const PAGE_VIEW_MARGIN = 50;

/* 把相机 x 约束在页面附近：视口的世界 x 区间不得超过 [−M, W+M]。
   页面占世界 x∈[0,W]，视口宽 = stageW / scale。
   - 视口比允许区间窄：相机可在 [minX, maxX] 内自由横移；
   - 视口比允许区间还宽（缩得很小）：无处可挪，直接把页面居中锁死。
   只动 x —— 高度无限，y 从不约束。无限画布（pageWidth 为空）原样返回。 */
export function clampCameraXToPage(camera, stageW, pageWidth) {
  if (!(pageWidth > 0) || !camera || !(stageW > 0)) return;
  const scale = Number.isFinite(camera.scale) && camera.scale > 0 ? camera.scale : 1;
  const worldW = stageW / scale;
  const minX = -PAGE_VIEW_MARGIN;
  const maxX = pageWidth + PAGE_VIEW_MARGIN;
  if (worldW >= maxX - minX) {
    /* 视口比允许区间还宽，没得挪 —— 把页面中心摆到视口中心。
       世界中心 c 对应的相机 x = stageW/2 − c·scale。 */
    camera.x = stageW / 2 - ((minX + maxX) / 2) * scale;
    return;
  }
  /* 视口左边界 vx 限制在 [minX, maxX - worldW]，换成相机 x = −vx·scale */
  const vx = -camera.x / scale;
  const clampedVx = Math.max(minX, Math.min(maxX - worldW, vx));
  camera.x = -clampedVx * scale;
}
