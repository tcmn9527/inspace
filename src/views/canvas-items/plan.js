/* canvas-items/plan.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { CARD_DEFAULT_BORDER_WIDTH, CARD_DEFAULT_RADIUS, PLAN_DEFAULT_HEIGHT, PLAN_DEFAULT_WIDTH, PLAN_MAX_AREAS, PLAN_MAX_FOOTPRINTS } from "./constants.js";
import { newId, num } from "./util.js";

const frac01 = (value) => Math.min(1, Math.max(0, num(value)));

export function normalizePlanCalibration(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x1 = Number(raw.x1);
  const y1 = Number(raw.y1);
  const x2 = Number(raw.x2);
  const y2 = Number(raw.y2);
  const mm = Number(raw.mm);
  if (![x1, y1, x2, y2, mm].every(Number.isFinite) || !(mm > 0)) return null;
  const cal = { x1: frac01(x1), y1: frac01(y1), x2: frac01(x2), y2: frac01(y2), mm };
  if (Math.hypot(cal.x2 - cal.x1, cal.y2 - cal.y1) < 1e-4) return null;
  return cal;
}

export function normalizePlanFootprints(raw) {
  const out = [];
  for (const one of Array.isArray(raw) ? raw : []) {
    if (out.length >= PLAN_MAX_FOOTPRINTS) break;
    if (!one || typeof one !== "object") continue;
    const product = typeof one.product === "string" ? one.product : "";
    if (!product) continue;
    const w = Number(one.w);
    const d = Number(one.d);
    out.push({
      id: typeof one.id === "string" && one.id ? one.id : newId(),
      product,
      name: typeof one.name === "string" ? one.name : "",
      x: num(one.x),
      y: num(one.y),
      w: w > 0 ? w : 600,
      d: d > 0 ? d : 600,
      rotate: Number.isFinite(Number(one.rotate)) ? ((Number(one.rotate) % 360) + 360) % 360 : 0,
    });
  }
  return out;
}

export function normalizePlanAreas(raw) {
  const out = [];
  for (const one of Array.isArray(raw) ? raw : []) {
    if (out.length >= PLAN_MAX_AREAS) break;
    if (!one || typeof one !== "object" || !Array.isArray(one.points)) continue;
    const points = [];
    for (const p of one.points) {
      if (!p || typeof p !== "object") continue;
      const x = Number(p.x);
      const y = Number(p.y);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }
    if (points.length < 3) continue;
    out.push({ id: typeof one.id === "string" && one.id ? one.id : newId(), points });
  }
  return out;
}

export function makePlan(x, y, src, imageW, imageH) {
  return {
    id: newId(),
    internal: true,
    type: "plan",
    x,
    y,
    w: PLAN_DEFAULT_WIDTH,
    h: PLAN_DEFAULT_HEIGHT,
    src,
    imageW: Math.max(0, Number(imageW) || 0),
    imageH: Math.max(0, Number(imageH) || 0),
    calibration: null,
    footprints: [],
    areas: [],
    borderColor: "",
    fillColor: "",
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}
