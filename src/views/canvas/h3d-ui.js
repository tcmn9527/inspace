/* 本地图生 3D：右键图片块「生成 3D 模型」，进度落在右下角小卡片上。
   生成要跑两分钟，不做全屏遮罩；完成后模型进模型库，画布不动。 */

import { current, showError, showToast } from "../canvas.js";

const STAGE_LABELS = {
  load: "载入模型…",
  pre: "抠图并摆正…",
  cond: "图像编码…",
  sample: "采样…",
  voxel: "生成网格…",
  mesh: "提取表面…",
};

let running = null;

export function h3dEntry(item) {
  if (!((item.type === "image" || item.type === "gen") && item.src)) return null;
  return { label: "生成 3D 模型", onClick: () => void startH3d(item) };
}

function buildCard() {
  const card = document.createElement("div");
  card.className = "h3d-card";
  card.innerHTML = `
    <div class="h3d-title">生成 3D 模型</div>
    <div class="h3d-bar"><i></i></div>
    <div class="h3d-line">
      <span class="h3d-stage">载入模型…</span>
      <button class="h3d-cancel" type="button">取消</button>
    </div>
  `;
  document.body.append(card);
  return {
    card,
    bar: card.querySelector(".h3d-bar i"),
    stage: card.querySelector(".h3d-stage"),
    cancel: card.querySelector(".h3d-cancel"),
    set(stageKey, value) {
      const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
      this.bar.style.width = `${pct}%`;
      const label = STAGE_LABELS[stageKey] || "";
      this.stage.textContent =
        stageKey === "sample" && pct > 0 && pct < 55 ? `采样 ${pct}%` : label;
    },
    remove() {
      card.remove();
    },
  };
}

export async function startH3d(item) {
  if (!current || !item?.id) return;
  if (running) {
    showToast("正在生成 3D 模型，等这次完成");
    return;
  }
  const { invoke } = window.__TAURI__?.core || {};
  if (typeof invoke !== "function") return;
  const canvasId = current.meta.id;
  const view = buildCard();
  running = view;
  let unlisten = null;
  let stopped = false;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen === "function") {
    Promise.resolve(listen("h3d-progress", (event) => {
      const payload = event?.payload || {};
      if (!stopped) view.set(payload.stage, Number(payload.value) || 0);
    }))
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
  }
  view.cancel.addEventListener("click", () => {
    stopped = true;
    view.cancel.disabled = true;
    view.cancel.textContent = "正在停止…";
    void invoke("h3d_cancel");
  });
  try {
    const model = await invoke("h3d_generate", { id: canvasId, itemId: item.id });
    showToast(`已生成 ${model?.name || "模型"}，在模型库里，可放进 3D 场景`);
  } catch (error) {
    const text = String(error || "");
    if (text.includes("已取消")) showToast("已停止生成");
    else showError(error);
  } finally {
    if (typeof unlisten === "function") unlisten();
    view.remove();
    running = null;
  }
}
