/* 从 canvas.js 拆出：floorplan */

import { active, agentRequireItem, agentSummary, current, findItem, itemEls, newId, planPixelsPerMm, promptDialog, revealItem, scheduleItemsSave, select, setSceneCameraPreset, showError, showToast, syncItemElement } from "../canvas.js";
import * as store from "../canvas-store.js";

/* ---------- 户型块 ---------- */

export let planCalibration = null; // { itemId, points: [{ fx, fy }] }

export function planCardOf(itemId) {
  return itemEls.get(itemId)?.querySelector(".canvas-plan-card") || null;
}

export function startPlanCalibration(item) {
  const card = planCardOf(item.id);
  if (!card) return;
  planCalibration = { itemId: item.id, points: [] };
  card.classList.add("is-calibrating");
  showToast("在户型图上点这条已知长度的两个端点");
}

export function cancelPlanCalibration() {
  if (!planCalibration) return;
  const { itemId } = planCalibration;
  planCalibration = null;
  planCardOf(itemId)?.classList.remove("is-calibrating");
  const el = itemEls.get(itemId);
  const item = findItem(itemId);
  if (el && item) syncItemElement(el, item);
}

export async function finishPlanCalibration(item, a, b) {
  const canvasId = current?.meta.id;
  planCardOf(item.id)?.classList.remove("is-calibrating");
  const pixelDist = Math.hypot((b.fx - a.fx) * item.imageW, (b.fy - a.fy) * item.imageH);
  if (!(pixelDist > 0)) {
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    showToast("两个点重合了，再来一次");
    return;
  }
  const answer = await promptDialog({
    title: "标定比例",
    label: "这两点实际多少毫米？（例如 4200）",
    value: "",
    okText: "定标",
  });
  if (!current || current.meta.id !== canvasId) return;
  const mm = Number(String(answer || "").replace(/[,\s]/g, ""));
  if (!(mm > 0)) {
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    return;
  }
  item.calibration = { x1: a.fx, y1: a.fy, x2: b.fx, y2: b.fy, mm };
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  showToast("已定标，现在可以放家具和机位了");
}

export function attachPlanBlock(el, item) {
  const card = el.querySelector(".canvas-plan-card");
  if (!card) return;

  /* 定标模式：按下两下各取一个点，再问这条线的实际长度 */
  card.addEventListener(
    "pointerdown",
    (event) => {
      if (planCalibration?.itemId !== item.id) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      planCalibration.points.push({ fx, fy });
      const svg = card.querySelector(".canvas-plan-svg");
      if (svg && item.imageW > 0 && item.imageH > 0) {
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("class", "canvas-plan-cal-dot");
        dot.setAttribute("cx", String(fx * item.imageW));
        dot.setAttribute("cy", String(fy * item.imageH));
        dot.setAttribute("r", String(Math.max(12, Math.min(item.imageW, item.imageH) / 45)));
        svg.append(dot);
      }
      if (planCalibration.points.length === 1) {
        showToast("再点另一头");
        return;
      }
      const [a, b] = planCalibration.points;
      planCalibration = null;
      void finishPlanCalibration(item, a, b);
    },
    true,
  );

  /* 脚印：按住拖动位置；松手没怎么动就选中对应产品卡 */
  card.addEventListener(
    "pointerdown",
    (event) => {
      if (planCalibration) return;
      const footprint = event.target.closest?.(".canvas-plan-footprint");
      if (!footprint) {
        if (event.target.closest?.(".canvas-plan-camera")) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (item.locked) return;
      const scale = planPixelsPerMm(item);
      if (!(scale > 0)) return;
      const fp = item.footprints.find((one) => one.id === footprint.getAttribute("data-footprint"));
      if (!fp) return;
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { x: fp.x, y: fp.y };
      let moved = false;
      const move = (e) => {
        const dxPx = (e.clientX - startX) * (item.imageW / rect.width);
        const dyPx = (e.clientY - startY) * (item.imageH / rect.height);
        fp.x = origin.x + dxPx / scale;
        fp.y = origin.y + dyPx / scale;
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 2) moved = true;
        footprint.setAttribute(
          "transform",
          `translate(${(fp.x * scale).toFixed(1)} ${(fp.y * scale).toFixed(1)}) rotate(${fp.rotate.toFixed(1)})`,
        );
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (moved) {
          const target = itemEls.get(item.id);
          if (target) syncItemElement(target, item);
          scheduleItemsSave();
        } else {
          select(fp.product);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    true,
  );

  /* 点机位：把链接的场景切到对应机位并跟过去 */
  card.addEventListener("click", (event) => {
    if (planCalibration) return;
    const camera = event.target.closest?.(".canvas-plan-camera");
    if (!camera) return;
    event.preventDefault();
    event.stopPropagation();
    const marker = item.cameras.find((one) => one.id === camera.getAttribute("data-camera"));
    if (!marker) return;
    const scene = findItem(marker.scene);
    if (!scene || scene.type !== "scene") {
      showError("这个机位链接的场景块不在了");
      return;
    }
    setSceneCameraPreset(scene, marker.preset);
    select(scene.id);
    revealItem(scene);
  });
}

export function planDefaultPoint(plan) {
  const scale = planPixelsPerMm(plan);
  if (!(scale > 0)) return { x: 0, y: 0 };
  return { x: plan.imageW / scale / 2, y: plan.imageH / scale / 2 };
}

export function planAreaOf(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2 / 1_000_000;
}

export function planPlaceProduct(product, plan, options = {}) {
  if (!plan || plan.type !== "plan") throw new Error("要放进的是一块户型图");
  if (!plan.calibration) {
    throw new Error("这张户型图还没定标：右键「标定比例…」，或先 plan_calibrate");
  }
  const dims = product.dims || {};
  const w = dims.w > 0 ? dims.w : 600;
  const d = dims.d > 0 ? dims.d : 600;
  const center = planDefaultPoint(plan);
  const footprint = {
    id: newId(),
    product: product.id,
    name: product.name || "产品",
    x: Number.isFinite(Number(options.x)) ? Number(options.x) : center.x,
    y: Number.isFinite(Number(options.y)) ? Number(options.y) : center.y,
    w,
    d,
    rotate: Number.isFinite(Number(options.rotate)) ? ((Number(options.rotate) % 360) + 360) % 360 : 0,
  };
  plan.footprints.push(footprint);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), footprint };
}

export function planPlaceCamera(plan, scene, options = {}) {
  if (!plan || plan.type !== "plan") throw new Error("要放机位的是一块户型图");
  if (!plan.calibration) throw new Error("这张户型图还没定标，放不了机位");
  const center = planDefaultPoint(plan);
  const marker = {
    id: newId(),
    scene: scene.id,
    x: Number.isFinite(Number(options.x)) ? Number(options.x) : center.x,
    y: Number.isFinite(Number(options.y)) ? Number(options.y) : center.y,
    rotate: Number.isFinite(Number(options.rotate)) ? ((Number(options.rotate) % 360) + 360) % 360 : 0,
    preset: ["front", "left", "right", "top", "auto"].includes(options.preset) ? options.preset : "front",
  };
  plan.cameras.push(marker);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), camera: marker };
}

export function planAddArea(plan, points) {
  if (!plan || plan.type !== "plan") throw new Error("要量面积的是一块户型图");
  if (!plan.calibration) throw new Error("这张户型图还没定标，量不了面积");
  const pts = [];
  for (const one of Array.isArray(points) ? points : []) {
    const x = Number(one?.x);
    const y = Number(one?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
  }
  if (pts.length < 3) throw new Error("面积至少给 3 个点（毫米坐标）");
  const area = { id: newId(), points: pts };
  plan.areas.push(area);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), area, squareMeters: planAreaOf(pts) };
}

export function planRemove(plan, kind, itemId) {
  const list = kind === "footprint" ? plan.footprints : kind === "camera" ? plan.cameras : kind === "area" ? plan.areas : null;
  if (!list) throw new Error("kind 只有 footprint / camera / area");
  const index = list.findIndex((one) => one.id === itemId);
  if (index < 0) throw new Error("没找到这一项");
  const [removed] = list.splice(index, 1);
  const el = itemEls.get(plan.id);
  if (el) syncItemElement(el, plan);
  scheduleItemsSave();
  return { ...agentSummary(plan), removed };
}

export async function placeProductOnPlanFlow(product, plan) {
  try {
    if (!active || !current) return;
    planPlaceProduct(product, plan);
    showToast("已放到户型图中央，拖动脚印调整位置");
  } catch (error) {
    showError(error);
  }
}

export function agentPlanCalibrate(spec = {}) {
  const item = agentRequireItem(spec.id);
  if (item.type !== "plan") throw new Error("id 要传户型块");
  const nums = ["x1", "y1", "x2", "y2", "mm"].map((key) => Number(spec[key]));
  if (!nums.every(Number.isFinite) || !(nums[4] > 0)) {
    throw new Error("要给 x1 / y1 / x2 / y2（0~1 的图片比例）和 mm（这段实际毫米数）");
  }
  const [x1, y1, x2, y2, mm] = nums;
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-4) throw new Error("两个点重合了");
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  item.calibration = { x1: clamp01(x1), y1: clamp01(y1), x2: clamp01(x2), y2: clamp01(y2), mm };
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  return agentSummary(item);
}

export function agentPlanPlaceProduct(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  const product = agentRequireItem(spec.product);
  if (product.type !== "product") throw new Error("product 要传产品卡");
  return planPlaceProduct(product, plan, { x: spec.x, y: spec.y, rotate: spec.rotate });
}

export function agentPlanPlaceCamera(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  const scene = agentRequireItem(spec.scene);
  if (scene.type !== "scene") throw new Error("scene 要传场景块");
  return planPlaceCamera(plan, scene, { x: spec.x, y: spec.y, rotate: spec.rotate, preset: spec.preset });
}

export function agentPlanArea(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  return planAddArea(plan, spec.points);
}

export function agentPlanRemove(spec = {}) {
  const plan = agentRequireItem(spec.plan);
  return planRemove(plan, String(spec.kind || ""), String(spec.item || ""));
}
