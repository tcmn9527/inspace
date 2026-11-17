/* canvas-items/dom-connectors.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { normalizeConnectorPoints } from "./core.js";
import { SIDES, SIDE_NORMALS } from "./util.js";

export function itemBounds(item, el) {
  if (item.type === "line" || item.type === "arrow") {
    return {
      x: Math.min(item.x, item.x2),
      y: Math.min(item.y, item.y2),
      w: Math.abs(item.x2 - item.x),
      h: Math.abs(item.y2 - item.y),
    };
  }
  /* 视口裁剪藏起来的块量不到 offsetHeight，退回最后记下的高度 */
  const h =
    item.type === "text"
      ? el && !el.classList.contains("is-culled")
        ? el.offsetHeight
        : item.h || 24
      : item.h;
  return { x: item.x, y: item.y, w: item.w, h };
}

export function linePoints(item) {
  return {
    x1: item.x - Math.min(item.x, item.x2),
    y1: item.y - Math.min(item.y, item.y2),
    x2: item.x2 - Math.min(item.x, item.x2),
    y2: item.y2 - Math.min(item.y, item.y2),
    w: Math.max(1, Math.abs(item.x2 - item.x)),
    h: Math.max(1, Math.abs(item.y2 - item.y)),
  };
}

/* ---------- 连线几何 ---------- */

export const round2 = (value) => Math.round(value * 100) / 100;

export function boundsCenter(bounds) {
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
}

export function sideAnchor(bounds, side) {
  if (side === "top") return { x: bounds.x + bounds.w / 2, y: bounds.y };
  if (side === "bottom") return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h };
  if (side === "left") return { x: bounds.x, y: bounds.y + bounds.h / 2 };
  return { x: bounds.x + bounds.w, y: bounds.y + bounds.h / 2 };
}

/* 从 point 看过来，块离它最近的那条边 */
export function facingSide(point, bounds) {
  const c = boundsCenter(bounds);
  const dx = point.x - c.x;
  const dy = point.y - c.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/* auto 端自动挑相对的两条边；固定端（用户从端口拖出）保持不动。
   只给「刚建立连线」和「拖端点时的预览线」用，渲染路径不再调它。 */
export function pickSides(fromSide, toSide, aBounds, bBounds) {
  let sideA = SIDES.includes(fromSide) ? fromSide : "auto";
  let sideB = SIDES.includes(toSide) ? toSide : "auto";
  if (sideA === "auto" && sideB === "auto") {
    const ac = boundsCenter(aBounds);
    const bc = boundsCenter(bBounds);
    const dx = bc.x - ac.x;
    const dy = bc.y - ac.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      sideA = dx >= 0 ? "right" : "left";
      sideB = dx >= 0 ? "left" : "right";
    } else {
      sideA = dy >= 0 ? "bottom" : "top";
      sideB = dy >= 0 ? "top" : "bottom";
    }
  } else if (sideA === "auto") {
    sideA = facingSide(sideAnchor(bBounds, sideB), aBounds);
  } else if (sideB === "auto") {
    sideB = facingSide(sideAnchor(aBounds, sideA), bBounds);
  }
  return { sideA, sideB };
}

/* 贝塞尔：控制点沿两端边的法线伸出，距离越远伸得越长 */
export function curvePath(a, na, b, nb) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const pull = Math.max(48, Math.min(200, distance * 0.4));
  const c1 = { x: a.x + na.x * pull, y: a.y + na.y * pull };
  const c2 = { x: b.x + nb.x * pull, y: b.y + nb.y * pull };
  return (
    `M ${round2(a.x)} ${round2(a.y)}` +
    ` C ${round2(c1.x)} ${round2(c1.y)} ${round2(c2.x)} ${round2(c2.y)} ${round2(b.x)} ${round2(b.y)}`
  );
}

/* 折线转角做圆角，避免直角太硬 */
export function polylinePath(points, radius) {
  const pts = [];
  for (const point of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - point.x) > 0.01 || Math.abs(last.y - point.y) > 0.01) {
      pts.push(point);
    }
  }
  if (pts.length < 2) return "";
  let d = `M ${round2(pts[0].x)} ${round2(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L ${round2(cur.x)} ${round2(cur.y)}`;
      continue;
    }
    const from = {
      x: cur.x + ((prev.x - cur.x) / inLen) * r,
      y: cur.y + ((prev.y - cur.y) / inLen) * r,
    };
    const to = {
      x: cur.x + ((next.x - cur.x) / outLen) * r,
      y: cur.y + ((next.y - cur.y) / outLen) * r,
    };
    d +=
      ` L ${round2(from.x)} ${round2(from.y)}` +
      ` Q ${round2(cur.x)} ${round2(cur.y)} ${round2(to.x)} ${round2(to.y)}`;
  }
  const end = pts[pts.length - 1];
  d += ` L ${round2(end.x)} ${round2(end.y)}`;
  return d;
}

/* 折线：先沿边的法线出 24px，再按两端的相对方向走 L 形或 Z 形 */
export function elbowVertices(a, na, b, nb) {
  const stub = 24;
  const p1 = { x: a.x + na.x * stub, y: a.y + na.y * stub };
  const p2 = { x: b.x + nb.x * stub, y: b.y + nb.y * stub };
  const exitAxis = na.x !== 0 ? "h" : "v";
  const entryAxis = nb.x !== 0 ? "h" : "v";
  const points = [a, p1];

  if (exitAxis === "h" && entryAxis === "h") {
    if (na.x === nb.x) {
      /* 同侧（比如都是右边）：绕到两块外侧再折回 */
      const outer = na.x > 0 ? Math.max(p1.x, p2.x) + stub : Math.min(p1.x, p2.x) - stub;
      points.push({ x: outer, y: p1.y }, { x: outer, y: p2.y });
    } else if ((na.x > 0 && p1.x <= p2.x) || (na.x < 0 && p1.x >= p2.x)) {
      const mid = (p1.x + p2.x) / 2;
      points.push({ x: mid, y: p1.y }, { x: mid, y: p2.y });
    } else {
      const outer = na.x > 0 ? Math.max(p1.x, p2.x) + stub : Math.min(p1.x, p2.x) - stub;
      points.push({ x: outer, y: p1.y }, { x: outer, y: p2.y });
    }
  } else if (exitAxis === "v" && entryAxis === "v") {
    if (na.y === nb.y) {
      const outer = na.y > 0 ? Math.max(p1.y, p2.y) + stub : Math.min(p1.y, p2.y) - stub;
      points.push({ x: p1.x, y: outer }, { x: p2.x, y: outer });
    } else if ((na.y > 0 && p1.y <= p2.y) || (na.y < 0 && p1.y >= p2.y)) {
      const mid = (p1.y + p2.y) / 2;
      points.push({ x: p1.x, y: mid }, { x: p2.x, y: mid });
    } else {
      const outer = na.y > 0 ? Math.max(p1.y, p2.y) + stub : Math.min(p1.y, p2.y) - stub;
      points.push({ x: p1.x, y: outer }, { x: p2.x, y: outer });
    }
  } else if (exitAxis === "h") {
    /* 目标落在出线方向背后时先竖着走，否则线会从端口往回穿过源块 */
    if ((na.x > 0 && p2.x < a.x) || (na.x < 0 && p2.x > a.x)) {
      points.push({ x: p1.x, y: p2.y });
    } else {
      points.push({ x: p2.x, y: p1.y });
    }
  } else {
    points.push({ x: p1.x, y: p2.y });
  }

  points.push(p2, b);
  return points;
}

/* 曲线过折点：中间按 Catmull-Rom 平滑，两头各自沿端口法线出线，接块处不歪 */
export function smoothPathThrough(a, na, b, nb, points) {
  const verts = [a, ...points, b];
  const last = verts.length - 1;
  let d = `M ${round2(a.x)} ${round2(a.y)}`;
  for (let i = 0; i < last; i++) {
    const p0 = i > 0 ? verts[i - 1] : a;
    const p1 = verts[i];
    const p2 = verts[i + 1];
    const p3 = i + 2 < verts.length ? verts[i + 2] : b;
    const pull = Math.max(
      24,
      Math.min(200, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.4),
    );
    const c1 =
      i === 0
        ? { x: p1.x + na.x * pull, y: p1.y + na.y * pull }
        : { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 =
      i === last - 1
        ? { x: p2.x + nb.x * pull, y: p2.y + nb.y * pull }
        : { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d +=
      ` C ${round2(c1.x)} ${round2(c1.y)} ${round2(c2.x)} ${round2(c2.y)}` +
      ` ${round2(p2.x)} ${round2(p2.y)}`;
  }
  return d;
}

export function routeConnector(shape, fromSide, toSide, aBounds, bBounds, points) {
  /* 边在连线建立那一刻就定死了：移动块只改线的走法，不改它接在哪条边上。
     走到兜底说明这条线没被 pinConnectorSides 固化过（老数据在首次渲染时会补上）。 */
  const sideA = SIDES.includes(fromSide) ? fromSide : "right";
  const sideB = SIDES.includes(toSide) ? toSide : "left";
  const a = sideAnchor(aBounds, sideA);
  const b = sideAnchor(bBounds, sideB);
  const na = SIDE_NORMALS[sideA];
  const nb = SIDE_NORMALS[sideB];
  const manual = normalizeConnectorPoints(points);
  let vertices;
  let d;
  if (manual.length) {
    /* 手动折点：线按 a → 折点 → b 依次穿过，折线只把每个转角磨圆 */
    vertices = [a, ...manual, b];
    d =
      shape === "curve"
        ? smoothPathThrough(a, na, b, nb, manual)
        : polylinePath(vertices, 8);
  } else if (shape === "curve") {
    /* 曲线没有现成拐点，插折点时只能从头排 */
    vertices = [a, b];
    d = curvePath(a, na, b, nb);
  } else {
    vertices = elbowVertices(a, na, b, nb);
    d = polylinePath(vertices, 8);
  }
  return { a, b, sideA, sideB, points: manual, vertices, d };
}

/* 拖端点过程中的预览线：落点还没定，按当前几何临时挑边 */
export function routeConnectorPreview(shape, fromSide, toSide, aBounds, bBounds, points) {
  const { sideA, sideB } = pickSides(fromSide, toSide, aBounds, bBounds);
  return routeConnector(shape, sideA, sideB, aBounds, bBounds, points);
}

/* 把 auto 端就地钉成当时那条边；返回是否真的改了数据 */
export function pinConnectorSides(item, getBounds) {
  const aBounds = getBounds(item.from.item);
  const bBounds = getBounds(item.to.item);
  if (!aBounds || !bBounds) return false;
  const { sideA, sideB } = pickSides(item.from.side, item.to.side, aBounds, bBounds);
  const changed = item.from.side !== sideA || item.to.side !== sideB;
  item.from.side = sideA;
  item.to.side = sideB;
  return changed;
}

export function connectorGeometry(item, getBounds) {
  const aBounds = getBounds(item.from.item);
  const bBounds = getBounds(item.to.item);
  if (!aBounds || !bBounds) return null;
  return routeConnector(
    item.shape,
    item.from.side,
    item.to.side,
    aBounds,
    bBounds,
    item.points,
  );
}

/* 引用块的原文件找不到了说人话；拷贝块的副本没了才是「丢了」 */
export function missingLabel(item, copyText) {
  return item.linked ? "原文件不在了" : copyText;
}

export const MISSING_FILE_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 3.5h7.4L18.5 8.6V20.5H6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M13.4 3.5v5.1h5.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M9.2 12.5l5.6 5.6M14.8 12.5l-5.6 5.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`;

/** 笔记自己那份内容文件在画布目录里的相对位置；复制粘贴和丢文件卡都按它说话。 */
export function contentRelOf(item) {
  if (item.type === "note") return `notes/${item.id}.md`;
  return "";
}

/** 块指向的那份文件在磁盘上的绝对位置：引用态记的就是绝对路径，其余一律按画布目录拼。 */
export function absolutePathOf(item, canvasDir) {
  /* 笔记块上那个 path 只在引用态有意义：拷贝进来的那块还会留着「来自哪儿」，
     可它现在真正拥有的是画布里的 notes/<块id>.md */
  const pointer = item.linked ? (item.type === "note" ? item.path : item.src) : item.src;
  const rel = pointer || contentRelOf(item);
  if (!rel || item.linked) return rel;
  if (!canvasDir) return rel;
  return `${canvasDir.replace(/[\\/]$/, "")}\\${rel.replace(/[\\/]/g, "\\")}`;
}

/* 丢文件是所有块共用的一种状态，所以只长一张卡：图标和一句话一行，下面一行文件的绝对路径。
   块留在原地、宽高不变，只把内容换成这张卡；原文件放回原位后重开画布自己恢复。
   附件和音乐块最矮只有 64px，所以图标只能跟标题挤一行，竖着排三行会被块自己裁掉。 */
export function createMissingCard(item, canvasDir) {
  const card = document.createElement("div");
  card.className = "canvas-missing-card";
  const line = document.createElement("div");
  line.className = "canvas-missing-line";
  const glyph = document.createElement("span");
  glyph.className = "canvas-missing-icon";
  glyph.innerHTML = MISSING_FILE_SVG;
  const title = document.createElement("div");
  title.className = "canvas-missing-title";
  title.textContent = item.linked ? "原文件不在了" : "画布里的副本丢了";
  line.append(glyph, title);
  card.append(line);
  const path = absolutePathOf(item, canvasDir);
  if (path) {
    const shown = document.createElement("div");
    shown.className = "canvas-missing-path";
    shown.textContent = path;
    card.append(shown);
  }
  return card;
}

/** 把块的内容换成丢文件卡：建块时就发现丢了、或后来异步查出来丢了，都走这里。 */
export function renderMissing(el, item, canvasDir) {
  if (!el || el.querySelector(".canvas-missing-card")) return;
  for (const media of el.querySelectorAll("video, audio")) media.pause();
  el.textContent = "";
  el.append(createMissingCard(item, canvasDir));
}
