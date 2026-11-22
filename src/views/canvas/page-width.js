/* 画布尺寸：默认无限；固定后只有宽度受限（高度始终无限）。
 *
 * 页面占据世界坐标 x ∈ [0, pageWidth]，y 任意。所有「创建/移动/缩放/批量排版/
 * MCP 改坐标」的入口统一经 clampXToPage() 收口，别在各自的地方写一套边界判断。
 * 视觉那层白页/灰底在 tools-camera.js 的 applyCamera() 里跟着相机画。 */

import { choiceDialog, confirmDialog, promptDialog } from "../dialog.js";
import {
  current,
  itemEls,
  scheduleCameraSave,
  scheduleItemsSave,
  showError,
  store,
  syncItemElement,
} from "../canvas.js";
import { PAGE_WIDTH_MAX, PAGE_WIDTH_MIN, sanitizePageWidth } from "./page-width-core.js";
import { refreshMinimap } from "../minimap.js";
import { applyCamera } from "./tools-camera.js";

export const PAGE_PRESETS = [1280, 1440, 1920];

export function pageWidth() {
  return current?.pageWidth ?? null;
}

/* 块整体落在页内，且宽度不超过页面：0 ≤ x、x + w ≤ W、w ≤ W。
   比页面还宽的块先收窄到 W，再贴回页内（固定画布里不允许面板越过页面边界）。
   线/箭头的宽度是 |x2 − x|、没有 item.w：把靠外的那个端点拉到离起点 W 的地方。
   返回是否改动了几何，供调用方决定要不要重画。 */
export function clampXToPage(item, width = pageWidth()) {
  if (!(width > 0) || !item || item.type === "connector") return false;
  const isLine = item.type === "line" || item.type === "arrow";
  const x = Number(item.x) || 0;
  let changed = false;

  if (isLine) {
    const x2 = Number(item.x2) || 0;
    if (Math.abs(x2 - x) > width) {
      /* 保留起点和外部端点的方向，把端点拉到刚好 W 处 */
      item.x2 = x + (x2 >= x ? width : -width);
      changed = true;
    }
  } else {
    const w = Math.max(0, Number(item.w) || 0);
    if (w > width) {
      item.w = width;
      changed = true;
    }
  }

  /* 再夹位置：线用两端外接框，普通块用 x + w */
  const w = isLine ? Math.abs((Number(item.x2) || 0) - (Number(item.x) || 0)) : Math.max(0, Number(item.w) || 0);
  const to = Math.max(0, Math.min(x, width - w));
  if (Math.abs(to - x) >= 0.001) {
    item.x = to;
    if (isLine) item.x2 = (Number(item.x2) || 0) + (to - x);
    changed = true;
  }
  return changed;
}

/* 整组平移的水平夹取：按外接框算，组内成员不会被彼此挤出去。
   fromOrigin=true 时用拖动快照的 origin.x（拖动每帧都基于起点重算）。
   组比页面还宽时贴左边，不硬把宽度也改掉。 */
export function clampGroupDx(group, dx, fromOrigin = false) {
  const width = pageWidth();
  if (!(width > 0) || !group?.length) return dx;
  let left = Infinity;
  let right = -Infinity;
  for (const member of group) {
    const item = member.item;
    if (!item || item.type === "connector") continue;
    const base = fromOrigin && member.origin ? member.origin.x : item.x;
    const x = (Number(base) || 0) + dx;
    const w = Math.max(0, Number(item.w) || 0);
    left = Math.min(left, x);
    right = Math.max(right, x + w);
  }
  if (!Number.isFinite(left)) return dx;
  if (left < 0) return dx - left;
  if (right > width) return dx - (right - width);
  return dx;
}

/* 越界块数量：设置固定宽度前给用户看「会有几块被移进来 / 收窄」。
   线/箭头按两端外接框算宽度，普通块按 w。 */
function itemWidthOf(item) {
  return item.type === "line" || item.type === "arrow"
    ? Math.abs((Number(item.x2) || 0) - (Number(item.x) || 0))
    : Math.max(0, Number(item.w) || 0);
}

export function outsideCount(width = pageWidth()) {
  if (!(width > 0) || !current) return 0;
  return current.items.filter((item) => {
    if (item.type === "connector") return false;
    const x = Number(item.x) || 0;
    const w = itemWidthOf(item);
    return x < -0.5 || w > width + 0.5 || x + w > width + 0.5;
  }).length;
}

function clampExistingBlocks(width) {
  if (!(width > 0) || !current) return 0;
  let moved = 0;
  for (const item of current.items) {
    if (!clampXToPage(item, width)) continue;
    moved += 1;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
  }
  if (moved) scheduleItemsSave();
  return moved;
}

/* 设置 / 取消固定宽度。silent=true 时跳过确认（MCP 用）。 */
export async function setPageWidth(next, { silent = false } = {}) {
  if (!current) return { ok: false, reason: "没有打开的画布" };
  const width = sanitizePageWidth(next);
  if (next != null && width == null) {
    return { ok: false, reason: `宽度需在 ${PAGE_WIDTH_MIN}–${PAGE_WIDTH_MAX} 之间` };
  }
  if (width === pageWidth()) return { ok: true, pageWidth: width, clamped: 0 };

  const outside = width ? outsideCount(width) : 0;
  if (!silent && outside) {
    const go = await confirmDialog({
      title: "画布尺寸",
      message: `有 ${outside} 个面板超出页面（含宽度过宽），设置后会被移入并收窄。继续吗？`,
      okText: "设置并调整",
    });
    if (!go) return { ok: false, reason: "已取消" };
  }
  try {
    await store.saveCanvasPageWidth(current.meta.id, width);
  } catch (error) {
    showError(`保存画布尺寸失败：${error}`);
    return { ok: false, reason: String(error) };
  }
  current.pageWidth = width;
  const clamped = clampExistingBlocks(width);
  if (width) {
    /* 水平居中：页面左边界的屏幕 x = camera.x，页面宽 = W * scale */
    const stageW = document.querySelector("#canvas-stage")?.clientWidth || 0;
    current.camera.x = (stageW - width * current.camera.scale) / 2;
    scheduleCameraSave();
  }
  applyCamera();
  /* 固定宽度会改变鸟瞰窗的横向取景，立刻重画一次 */
  refreshMinimap();
  return { ok: true, pageWidth: width, clamped };
}

/* 右键菜单那一步：先选预设/无限/自定义，再落到 setPageWidth */
export async function pageWidthMenuFlow() {
  const choice = await choiceDialog({
    title: "画布尺寸",
    message: "固定宽度后，面板不能超出页面宽度；高度仍然无限。",
    options: [
      { label: "无限画布", hint: "不限制宽度（默认）", value: "unlimited" },
      ...PAGE_PRESETS.map((px) => ({ label: `${px} px`, hint: "常用页面宽度", value: px })),
      { label: "自定义宽度…", hint: `${PAGE_WIDTH_MIN}–${PAGE_WIDTH_MAX} px`, value: "custom" },
    ],
  });
  if (choice === null) return { ok: false, reason: "已取消" };
  if (choice === "unlimited") return setPageWidth(null);
  if (choice !== "custom") return setPageWidth(choice);
  const text = await promptDialog({
    title: "自定义画布宽度",
    label: `页面宽度（px，${PAGE_WIDTH_MIN}–${PAGE_WIDTH_MAX}）`,
    value: String(pageWidth() || 1440),
    okText: "设置",
    validate: (value) =>
      /^\d+$/.test(value) && +value >= PAGE_WIDTH_MIN && +value <= PAGE_WIDTH_MAX
        ? null
        : `填 ${PAGE_WIDTH_MIN}–${PAGE_WIDTH_MAX} 的整数`,
  });
  if (text === null) return { ok: false, reason: "已取消" };
  return setPageWidth(Number(text));
}
