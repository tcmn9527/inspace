/* 两张图片的临时对比浮层：同一区域叠放，拖中间分割线看差异。
   两张图都按 contain 完整显示（比例不同各自留白），可缩放看细节；
   不写画布、不进导出，关掉就没了。 */

import { CLOSE_X_SVG } from "./dialog.js";

const HANDLE_SVG = `
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
    <path d="M6.5 5.2 3.2 10l3.3 4.8M13.5 5.2 16.8 10l-3.3 4.8" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;

export function openImageCompare({ a, b }) {
  if (!a || !b) return;

  const mask = document.createElement("div");
  mask.className = "compare-mask";
  mask.innerHTML = `
    <div class="compare-panel" role="dialog" aria-label="图片对比" tabindex="-1">
      <button class="compare-close" type="button" title="关闭" aria-label="关闭">${CLOSE_X_SVG}</button>
      <div class="compare-tools">
        <button class="compare-tool" data-zoom="out" type="button" title="缩小" aria-label="缩小">−</button>
        <button class="compare-tool compare-zoom-value" data-zoom="reset" type="button" title="恢复 100%">100%</button>
        <button class="compare-tool" data-zoom="in" type="button" title="放大" aria-label="放大">+</button>
      </div>
      <div class="compare-stage">
        <div class="compare-canvas">
          <img class="compare-img compare-bottom" alt="" draggable="false" />
          <img class="compare-img compare-top" alt="" draggable="false" />
        </div>
        <span class="compare-divider"></span>
        <span class="compare-handle">${HANDLE_SVG}</span>
      </div>
    </div>
  `;

  const panel = mask.querySelector(".compare-panel");
  const stage = mask.querySelector(".compare-stage");
  const canvas = mask.querySelector(".compare-canvas");
  const top = mask.querySelector(".compare-top");
  const divider = mask.querySelector(".compare-divider");
  const handle = mask.querySelector(".compare-handle");
  const zoomValue = mask.querySelector(".compare-zoom-value");
  mask.querySelector(".compare-bottom").src = a;
  top.src = b;

  /* ratio = 分割线在画面里的横向位置；scale / tx / ty = 图片内容的缩放和平移 */
  let ratio = 0.5;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let mode = ""; // "" / "split" / "pan"
  let start = null;

  /* 拖动中每帧都读 getBoundingClientRect 会强制布局、拖分割线就发涩；
     浮层尺寸只在打开和窗口 resize 时变，缓存一份就够 */
  let hostRect = stage.getBoundingClientRect();
  const onResize = () => {
    hostRect = stage.getBoundingClientRect();
    paint();
  };
  window.addEventListener("resize", onResize);

  let frame = 0;
  const queuePaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };

  const paint = () => {
    /* canvas 铺满 stage、以中心缩放：尺寸用 hostRect 直接算，不再读 DOM */
    const boxW = hostRect.width * scale;
    const boxL = hostRect.left + (hostRect.width - boxW) / 2 + tx;
    canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    const dividerX = hostRect.left + ratio * hostRect.width;
    /* 图片内容被缩放/平移后，分割线（屏幕位置）对应到图片坐标里的百分比要重算 */
    const pct = boxW > 0 ? ((dividerX - boxL) / boxW) * 100 : ratio * 100;
    top.style.clipPath = `inset(0 0 0 ${Math.min(100, Math.max(0, pct))}%)`;
    const offset = ratio * hostRect.width;
    divider.style.transform = `translate3d(${offset}px, 0, 0)`;
    handle.style.transform = `translate3d(${offset}px, 0, 0)`;
    zoomValue.textContent = `${Math.round(scale * 100)}%`;
    stage.classList.toggle("is-zoomed", scale > 1);
  };

  const setZoom = (next) => {
    scale = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) * 100) / 100;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    paint();
  };

  const moveSplit = (clientX) => {
    if (!hostRect.width) return;
    ratio = Math.min(1, Math.max(0, (clientX - hostRect.left) / hostRect.width));
    queuePaint();
  };

  const nearDivider = (clientX) => {
    return Math.abs(clientX - (hostRect.left + ratio * hostRect.width)) <= 14;
  };

  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stage.setPointerCapture?.(event.pointerId);
    hostRect = stage.getBoundingClientRect();
    if (scale > 1 && !nearDivider(event.clientX)) {
      mode = "pan";
      start = { x: event.clientX, y: event.clientY, tx, ty };
      stage.classList.add("is-comparing-pan");
      return;
    }
    mode = "split";
    moveSplit(event.clientX);
  });

  stage.addEventListener("pointermove", (event) => {
    if (!mode) return;
    if (mode === "split") {
      moveSplit(event.clientX);
      return;
    }
    tx = start.tx + (event.clientX - start.x);
    ty = start.ty + (event.clientY - start.y);
    queuePaint();
  });

  const stop = (event) => {
    mode = "";
    start = null;
    stage.classList.remove("is-comparing-pan");
    if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };
  stage.addEventListener("pointerup", stop);
  stage.addEventListener("pointercancel", stop);

  /* 滚轮缩放：围绕画面中心，放大后拖画面平移 */
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      setZoom(scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    },
    { passive: false },
  );

  /* 双击回到中线 */
  stage.addEventListener("dblclick", () => {
    ratio = 0.5;
    paint();
  });

  mask.querySelector(".compare-tools").addEventListener("click", (event) => {
    const button = event.target.closest("[data-zoom]");
    if (!button) return;
    const action = button.dataset.zoom;
    if (action === "in") setZoom(scale * ZOOM_STEP);
    else if (action === "out") setZoom(scale / ZOOM_STEP);
    else setZoom(1);
  });

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    mask.remove();
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  mask.querySelector(".compare-close").addEventListener("click", close);
  mask.addEventListener("pointerdown", (event) => {
    if (!panel.contains(event.target)) close();
  });
  document.addEventListener("keydown", onKey, true);

  document.body.append(mask);
  hostRect = stage.getBoundingClientRect();
  paint();
  panel.focus({ preventScroll: true });
}
