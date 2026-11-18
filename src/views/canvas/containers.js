/* 从 canvas.js 拆出：containers */

import { moveGroup } from "./layout.js";
import { current, findItem, itemBounds, itemEls, scheduleItemsSave, showToast, syncItemElement, ui, updateSelection, worldToStage } from "../canvas.js";

/* ---------- 分组容器 ----------
   矩形可以当「框」用。成员不单独存名字，按几何现算：整个块完全落在框里的才算成员。
   好处是拖出去就自动脱组、拖进来就自动入组，不用维护一份迟早会过期的名单。 */
export function isContainer(item) {
  return item.type === "rect" && item.container === true;
}

/* 框里装着的块。exclude 是已经算进去的（多选时别重复带上）。
   includeLocked 给复制用：锁定的子块也算容器的一部分，粘出去再统一解锁。 */
export function containedBlocks(container, exclude = new Set(), includeLocked = false) {
  const el = itemEls.get(container.id);
  if (!el || !current) return [];
  const box = itemBounds(container, el);
  const out = [];
  for (const item of current.items) {
    if (item.id === container.id || item.type === "connector") continue;
    if (!includeLocked && item.locked) continue;
    if (exclude.has(item.id)) continue;
    const childEl = itemEls.get(item.id);
    if (!childEl) continue;
    const b = itemBounds(item, childEl);
    const inside =
      b.x >= box.x - 1 &&
      b.y >= box.y - 1 &&
      b.x + b.w <= box.x + box.w + 1 &&
      b.y + b.h <= box.y + box.h + 1;
    if (inside) out.push(item);
  }
  return out;
}

export function applyContainerClass(item) {
  itemEls.get(item.id)?.classList.toggle("is-container", isContainer(item));
}

/* ---------- 容器成员归属 ----------
   重叠的两个框里几何判定分不清谁是谁，拖动时就会互相吸走子块。
   block.containerId 记住每块归哪个容器：粘贴容器时新容器立刻认领自己的子块，
   拖动后只重算动过的块，没主的老数据开画布时按容器顺序先到先得。 */
export function containerBoxOf(container) {
  const el = itemEls.get(container.id);
  if (!el) return null;
  return itemBounds(container, el);
}

/* 归属只看左上角落在容器框内：块大出容器一半也照样算它的人，
   整块完全装下已经不再是必要条件 */
export function insideBox(item, box) {
  const el = itemEls.get(item.id);
  if (!el) return false;
  const b = itemBounds(item, el);
  return (
    b.x >= box.x - 1 &&
    b.y >= box.y - 1 &&
    b.x <= box.x + box.w + 1 &&
    b.y <= box.y + box.h + 1
  );
}

/* 开画布：有主的、容器还在且仍框着它就算数；没主的按容器顺序先到先得 */
export function rebuildContainerOwners() {
  if (!current) return;
  const containers = current.items.filter((item) => isContainer(item));
  for (const item of current.items) {
    if (item.type === "connector" || !item.containerId) continue;
    const container = findItem(item.containerId);
    const box = container && container.id !== item.id ? containerBoxOf(container) : null;
    if (!box || !insideBox(item, box)) item.containerId = "";
  }
  for (const container of containers) {
    const box = containerBoxOf(container);
    if (!box) continue;
    for (const item of current.items) {
      if (item.id === container.id || item.type === "connector" || item.containerId) continue;
      if (insideBox(item, box)) item.containerId = container.id;
    }
  }
}

/* 拖完重算：还在原容器里就保持，换了框就换主，拖出去就脱组 */
export function reassignContainerOwners(items) {
  if (!current) return;
  const containers = current.items.filter((item) => isContainer(item));
  for (const item of items) {
    if (!item || item.type === "connector") continue;
    const owner = item.containerId;
    if (owner) {
      const container = findItem(owner);
      const box = container && container.id !== item.id ? containerBoxOf(container) : null;
      if (box && insideBox(item, box)) continue;
      item.containerId = "";
    }
    const host = containers.find((container) => {
      if (container.id === item.id) return false;
      const box = containerBoxOf(container);
      return box ? insideBox(item, box) : false;
    });
    if (host) item.containerId = host.id;
  }
}

/* 这块归不归 container 管：没主或认的就是它；认了别的容器、但那个容器
   本身就在这个框里（嵌套）时算它管。拖动和树里的展开用同一套判定。 */
export function ownedByContainer(item, container, box) {
  const owner = item.containerId;
  if (!owner || owner === container.id) return true;
  const ownerItem = findItem(owner);
  return !ownerItem || insideBox(ownerItem, box);
}

/* 容器自己认的成员（几何在框里 + 归属不是别的容器）。拖动、复制、删除都用它；
   includeLocked 给复制/删除用：锁定的子块也带着走。 */
export function ownedMembers(container, exclude = new Set(), includeLocked = false) {
  const box = containerBoxOf(container);
  if (!box) return [];
  const out = [];
  for (const item of current.items) {
    if (item.id === container.id || item.type === "connector") continue;
    if (!includeLocked && item.locked) continue;
    if (exclude.has(item.id)) continue;
    if (!insideBox(item, box)) continue;
    if (!ownedByContainer(item, container, box)) continue;
    out.push(item);
  }
  return out;
}

/* 拖容器时跟走的成员：框里的块、且它认这个容器；认了别的容器、而那个容器
   不在这个框里的就不跟——重叠的两个容器各带走各的子块，互不串门。 */
/* 跟着容器走的是全部成员，锁定的也算：容器的坐标一挪，框里的东西一起挪 */
export function moveMembers(container, exclude = new Set()) {
  return ownedMembers(container, exclude, true);
}

/* 右键「编为容器 / 取消容器」 */
export function toggleContainer(item) {
  if (item.type !== "rect") return;
  const next = !isContainer(item);
  if (next) {
    item.container = true;
    const kids = containedBlocks(item);
    /* 框要垫在它装的东西底下，否则选中的永远是框 */
    if (kids.length) {
      const lowest = Math.min(...kids.map((kid) => (Number.isFinite(kid.z) ? kid.z : 0)));
      item.z = lowest - 1;
      const el = itemEls.get(item.id);
      if (el) el.style.zIndex = String(item.z);
    }
    for (const kid of kids) {
      if (!kid.containerId) kid.containerId = item.id;
    }
    applyContainerClass(item);
    scheduleItemsSave();
    showToast(`已编为容器：框里 ${kids.length} 块会跟着它走`);
    return;
  }
  delete item.container;
  for (const it of current.items) {
    if (it.containerId === item.id) it.containerId = "";
  }
  applyContainerClass(item);
  scheduleItemsSave();
  showToast("已取消容器，这块回到普通矩形");
}

/* 方向键挪位：一次 1px，按住 Shift 走 10px。整组各加同样的偏移；
   直线/箭头连端点一起挪，否则只动起点、线会变形。 */
export function nudgeSelected(dx, dy) {
  /* 方向和拖动一样：容器带着框里的块一起挪 */
  for (const { item, el } of moveGroup()) {
    item.x += dx;
    item.y += dy;
    if (item.type === "line" || item.type === "arrow") {
      item.x2 += dx;
      item.y2 += dy;
    }
    syncItemElement(el, item);
  }
  updateSelection();
  scheduleItemsSave();
}

/* 吸附阈值按屏幕像素给：缩放多少倍手感都一样（6px 在 50% 缩放下等于 12 个世界像素） */
export const SNAP_PX = 6;
/* 辅助线比参与对齐的那两块各多画出去一截，好让眼睛找得到 */
export const GUIDE_OVERHANG_PX = 24;

/* 拖着的这一组此刻的外接框：位置按各自起点 + 这一帧的偏移算，尺寸取真实渲染值
   （文字块的高度是内容撑出来的，item.h 会过期） */
export function dragBounds(group, offsetX, offsetY) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const member of group) {
    const size = itemBounds(member.item, member.el);
    const x = member.origin.x + offsetX;
    const y = member.origin.y + offsetY;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + size.w);
    bottom = Math.max(bottom, y + size.h);
  }
  if (!Number.isFinite(left)) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/* 参照线的来源：别的面板的三条竖线（左边/中线/右边）和三条横线（上边/中线/下边）；
   外加每块的宽高，改尺寸时用来咬「和它一样宽 / 一样高」 */
export function snapTargets(exclude) {
  const verticals = [];
  const horizontals = [];
  const widths = [];
  const heights = [];
  for (const item of current.items) {
    if (item.type === "connector" || exclude.has(item.id)) continue;
    const el = itemEls.get(item.id);
    if (!el) continue;
    const b = itemBounds(item, el);
    verticals.push({ at: b.x, from: b.y, to: b.y + b.h });
    verticals.push({ at: b.x + b.w / 2, from: b.y, to: b.y + b.h });
    verticals.push({ at: b.x + b.w, from: b.y, to: b.y + b.h });
    horizontals.push({ at: b.y, from: b.x, to: b.x + b.w });
    horizontals.push({ at: b.y + b.h / 2, from: b.x, to: b.x + b.w });
    horizontals.push({ at: b.y + b.h, from: b.x, to: b.x + b.w });
    widths.push({ w: b.w, x: b.x, y: b.y, h: b.h });
    heights.push({ h: b.h, x: b.x, y: b.y, w: b.w });
  }
  return { verticals, horizontals, widths, heights };
}

/* 各轴独立咬合：X 吸住了 Y 还能自由走。只沿一个轴拖时另一轴不咬。
   返回补正后的偏移和要画的辅助线。 */
export function snapOffset(group, offsetX, offsetY, onlyAxis) {
  const bounds = dragBounds(group, offsetX, offsetY);
  if (!bounds) return { dx: offsetX, dy: offsetY, guides: [] };
  const threshold = SNAP_PX / Math.max(0.01, current.camera.scale);
  const exclude = new Set(group.map((member) => member.item.id));
  const targets = snapTargets(exclude);
  const guides = [];

  const pick = (values, lines) => {
    let best = null;
    for (const value of values) {
      for (const line of lines) {
        const delta = line.at - value;
        if (Math.abs(delta) > threshold) continue;
        if (best && Math.abs(best.delta) <= Math.abs(delta)) continue;
        best = { delta, line, edge: value };
      }
    }
    return best;
  };

  let dx = offsetX;
  let dy = offsetY;
  if (onlyAxis !== "y") {
    const best = pick(
      [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w],
      targets.verticals,
    );
    if (best) {
      dx += best.delta;
      guides.push({
        axis: "x",
        at: best.line.at,
        from: Math.min(best.line.from, bounds.y),
        to: Math.max(best.line.to, bounds.y + bounds.h),
      });
    }
  }
  if (onlyAxis !== "x") {
    const best = pick(
      [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h],
      targets.horizontals,
    );
    if (best) {
      dy += best.delta;
      guides.push({
        axis: "y",
        at: best.line.at,
        from: Math.min(best.line.from, bounds.x),
        to: Math.max(best.line.to, bounds.x + bounds.w),
      });
    }
  }
  return { dx, dy, guides };
}

/* 改尺寸时只咬正在拖的那条边，规则和整块拖动一样：差一点就吸上去，并拉一根虚线。
   边没咬上时再看尺寸：拖到和别的面板一样宽 / 一样高也吸住，并在那块上标出它的宽高。
   图片永远等比：角/左右拖时高度是由宽度算出来的，只咬水平那条边；纯上下拖才咬垂直边。
   文字的高度由内容撑开，垂直方向不咬，免得虚线说的和眼睛看到的不一致。 */
export function snapResize(state, dx, dy) {
  const origin = state.origin;
  const dir = state.dir;
  const type = findItem(state.id)?.type;
  if (!type || type === "connector") return { dx, dy, guides: [] };
  const targets = snapTargets(new Set([state.id]));
  const threshold = SNAP_PX / Math.max(0.01, current.camera.scale);
  const guides = [];
  const nearest = (value, lines) => {
    let best = null;
    for (const line of lines) {
      const delta = line.at - value;
      if (Math.abs(delta) > threshold) continue;
      if (best && Math.abs(best.delta) <= Math.abs(delta)) continue;
      best = { delta, line };
    }
    return best;
  };

  let nextDx = dx;
  let nextDy = dy;

  /* 拖右边咬 x+w，拖左边咬 x */
  const edgeX = dir.includes("e")
    ? origin.x + origin.w + dx
    : dir.includes("w")
      ? origin.x + dx
      : null;
  if (edgeX !== null) {
    const best = nearest(edgeX, targets.verticals);
    if (best) {
      nextDx += best.delta;
      guides.push({
        axis: "x",
        at: best.line.at,
        from: Math.min(best.line.from, origin.y),
        to: Math.max(best.line.to, origin.y + origin.h),
      });
    } else {
      /* 宽度拖到和某块一样：吸住，并在那块顶上标一条它的宽 */
      const widthNow = dir.includes("e") ? origin.w + dx : origin.w - dx;
      let fit = null;
      for (const entry of targets.widths) {
        const delta = entry.w - widthNow;
        if (Math.abs(delta) > threshold) continue;
        if (fit && Math.abs(fit.delta) <= Math.abs(delta)) continue;
        fit = { delta, entry };
      }
      if (fit) {
        nextDx += dir.includes("e") ? fit.delta : -fit.delta;
        guides.push({
          axis: "y",
          at: fit.entry.y - 6 / Math.max(0.01, current.camera.scale),
          from: fit.entry.x,
          to: fit.entry.x + fit.entry.w,
          tight: true,
        });
      }
    }
  }

  const byHeight = type === "image" ? dir === "n" || dir === "s" : type !== "text";
  if (byHeight) {
    const edgeY = dir.includes("s")
      ? origin.y + origin.h + dy
      : dir.includes("n")
        ? origin.y + dy
        : null;
    if (edgeY !== null) {
      const best = nearest(edgeY, targets.horizontals);
      if (best) {
        nextDy += best.delta;
        guides.push({
          axis: "y",
          at: best.line.at,
          from: Math.min(best.line.from, origin.x),
          to: Math.max(best.line.to, origin.x + origin.w),
        });
      } else {
        /* 高度拖到和某块一样：吸住，并在那块左边标一条它的高 */
        const heightNow = dir.includes("s") ? origin.h + dy : origin.h - dy;
        let fit = null;
        for (const entry of targets.heights) {
          const delta = entry.h - heightNow;
          if (Math.abs(delta) > threshold) continue;
          if (fit && Math.abs(fit.delta) <= Math.abs(delta)) continue;
          fit = { delta, entry };
        }
        if (fit) {
          nextDy += dir.includes("s") ? fit.delta : -fit.delta;
          guides.push({
            axis: "x",
            at: fit.entry.x - 6 / Math.max(0.01, current.camera.scale),
            from: fit.entry.y,
            to: fit.entry.y + fit.entry.h,
            tight: true,
          });
        }
      }
    }
  }

  return { dx: nextDx, dy: nextDy, guides };
}

/* 直线/箭头吸到 45° 的倍数：水平、垂直和两条对角线。
   判据和块对齐同一口径——离目标方向的垂距不超过 6 个屏幕像素就咬住。 */
export const LINE_SNAP_STEP = Math.PI / 4;
export function snapLineAngle(origin, point) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const len = Math.hypot(dx, dy);
  /* 贴着起点时不吸：方向还没定型，硬吸会让线头乱跳 */
  if (len * current.camera.scale < SNAP_PX) return null;
  const angle = Math.atan2(dy, dx);
  const target = Math.round(angle / LINE_SNAP_STEP) * LINE_SNAP_STEP;
  const miss = len * Math.abs(Math.sin(angle - target)) * current.camera.scale;
  if (miss > SNAP_PX) return null;
  /* 终点沿目标方向摆到同样的投影长度上：只微调，不跳 */
  const along = dx * Math.cos(target) + dy * Math.sin(target);
  return {
    point: {
      x: origin.x + Math.cos(target) * along,
      y: origin.y + Math.sin(target) * along,
    },
    guide: { axis: "angle", at: origin, angle: target },
  };
}

/* 辅助线画在屏幕坐标的顶层：它是拖拽这一下的临时提示，不属于任何一块，
   所以不参与面板之间的层级（同连线端点手柄那个口径）。松手即清。 */
export function drawSnapGuides(guides) {
  if (!ui?.guideLayer) return;
  ui.guideLayer.textContent = "";
  for (const guide of guides) {
    const line = document.createElement("div");
    /* 对齐线要伸出两头，好让眼睛找得到；等宽/等高那条是量在参照块身上的尺子，不伸 */
    const overhang = guide.tight ? 0 : GUIDE_OVERHANG_PX;
    if (guide.axis === "x") {
      const top = worldToStage(guide.at, guide.from);
      const bottom = worldToStage(guide.at, guide.to);
      line.className = "canvas-guide canvas-guide-vertical";
      line.style.left = `${top.x}px`;
      line.style.top = `${Math.min(top.y, bottom.y) - overhang}px`;
      line.style.height = `${Math.abs(bottom.y - top.y) + overhang * 2}px`;
    } else if (guide.axis === "angle") {
      /* 吸附角度的那条参考线：以起点为中心，沿咬住的方向拉长到盖住整个画布 */
      const origin = worldToStage(guide.at.x, guide.at.y);
      const reach = Math.hypot(ui.stage.clientWidth, ui.stage.clientHeight);
      const cos = Math.cos(guide.angle);
      const sin = Math.sin(guide.angle);
      line.className = "canvas-guide canvas-guide-angle";
      line.style.left = `${origin.x - cos * reach}px`;
      line.style.top = `${origin.y - sin * reach}px`;
      line.style.width = `${reach * 2}px`;
      line.style.transform = `rotate(${guide.angle}rad)`;
    } else {
      const start = worldToStage(guide.from, guide.at);
      const end = worldToStage(guide.to, guide.at);
      line.className = "canvas-guide canvas-guide-horizontal";
      line.style.top = `${start.y}px`;
      line.style.left = `${Math.min(start.x, end.x) - overhang}px`;
      line.style.width = `${Math.abs(end.x - start.x) + overhang * 2}px`;
    }
    ui.guideLayer.append(line);
  }
}
