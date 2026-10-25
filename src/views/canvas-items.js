/* 画布图元：数据形状、几何计算和 DOM 渲染。
 * 所有坐标都是世界坐标（未乘缩放），图元本身互不嵌套。 */

import { renderMarkdown } from "./markdown.js";

export const DEFAULT_BORDER = "#9a9a9a";
export const TEXT_DEFAULT_WIDTH = 320;
export const IMAGE_MAX_SIDE = 520;
export const AUDIO_DEFAULT_WIDTH = 320;
export const AUDIO_DEFAULT_HEIGHT = 92;
export const VIDEO_MIN_WIDTH = 160;
export const VIDEO_MIN_HEIGHT = 120;
export const VIDEO_DEFAULT_WIDTH = 480;
export const VIDEO_DEFAULT_HEIGHT = 300;
/* 底部控制条占掉的高度：自动按视频比例定块高时要把这条算进去 */
export const VIDEO_ROW_HEIGHT = 34;
export const VIDEO_MAX_SIDE = 640;
export const STICKY_DEFAULT_WIDTH = 280;
export const STICKY_DEFAULT_HEIGHT = 280;
export const STICKY_DEFAULT_COLOR = "#bfa648";
export const STICKY_DEFAULT_TEXT = "#000000";
export const NOTE_DEFAULT_WIDTH = 520;
export const NOTE_DEFAULT_HEIGHT = 420;
/* 文件卡片按附件条来做：宽度固定，长名字省略号收尾，不给缩放把手（同音频播放器） */
export const FILE_DEFAULT_WIDTH = 320;
export const FILE_DEFAULT_HEIGHT = 84;
/* 文本类文件在卡片里直接给只读预览：折叠只露几行，展开后才允许自己拉大小 */
export const FILE_TEXT_WIDTH = 420;
export const FILE_TEXT_EXPANDED_HEIGHT = 320;
/* 电子书块是一整页纸：默认给到能读几段的高度，用户还能接着拉 */
export const EBOOK_DEFAULT_WIDTH = 560;
export const EBOOK_DEFAULT_HEIGHT = 640;
export const EBOOK_MIN_WIDTH = 300;
export const EBOOK_MIN_HEIGHT = 220;
/* 收起后只留一条标题的高度；块的 w/h 原样留着，展开就回到原来的大小 */
export const COLLAPSED_HEIGHT = 34;

const SVG_NS = "http://www.w3.org/2000/svg";

/* 哪几种块有「内容区」可以收起来：纯文字/便签/图片和单行附件条本身就是全部内容 */
export function canCollapse(item) {
  return (
    item.type === "note" ||
    item.type === "audio" ||
    item.type === "video" ||
    item.type === "ebook" ||
    (item.type === "file" && item.text)
  );
}

const collapseLabel = (item) => {
  if (item.type === "ebook") return String(item.name || "").replace(/\.[^.\\/]+$/, "") || "电子书";
  if (item.type === "note") return item.name || "笔记";
  if (item.type === "audio") return item.name || "音频";
  if (item.type === "video") return item.name || "视频";
  return item.name || "文件";
};

let seq = 0;

export function newId() {
  seq += 1;
  return `i${Date.now().toString(36)}${seq.toString(36)}`;
}

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

const SIDES = ["top", "right", "bottom", "left"];
const SIDE_NORMALS = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

function normalizeEnd(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.item !== "string") return null;
  return {
    item: raw.item,
    side: SIDES.includes(raw.side) ? raw.side : "auto",
  };
}

/* 块之间的叠放层级；连线不进这一套，固定在最底层 */
const layerOf = (raw) => (Number.isFinite(raw.z) ? Math.trunc(raw.z) : null);

export function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const type = raw.type;
  const base = { id: raw.id, type };
  if (type === "connector") {
    const from = normalizeEnd(raw.from);
    const to = normalizeEnd(raw.to);
    if (!from || !to) return null;
    return {
      ...base,
      from,
      to,
      shape: raw.shape === "curve" ? "curve" : "elbow",
      arrow: raw.arrow === "none" ? "none" : raw.arrow === "both" ? "both" : "end",
      color: typeof raw.color === "string" && raw.color ? raw.color : DEFAULT_BORDER,
    };
  }
  if (type === "rect" || type === "ellipse") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(1, num(raw.w, 1)),
      h: Math.max(1, num(raw.h, 1)),
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : DEFAULT_BORDER,
      fillColor: typeof raw.fillColor === "string" ? raw.fillColor : "",
      z: layerOf(raw),
    };
  }
  if (type === "line" || type === "arrow") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      x2: num(raw.x2),
      y2: num(raw.y2),
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : DEFAULT_BORDER,
      z: layerOf(raw),
    };
  }
  if (type === "text") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(40, num(raw.w, TEXT_DEFAULT_WIDTH)),
      text: typeof raw.text === "string" ? raw.text : "",
      color: typeof raw.color === "string" ? raw.color : "",
      fillColor: typeof raw.fillColor === "string" ? raw.fillColor : "",
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : "",
      h: Math.max(0, num(raw.h)),
      minH: Math.max(0, num(raw.minH)),
      fontSize: Math.min(200, Math.max(8, num(raw.fontSize, 14))),
      bordered: raw.bordered === true,
      z: layerOf(raw),
    };
  }
  if (type === "image") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(8, num(raw.w, 120)),
      h: Math.max(8, num(raw.h, 120)),
      src: typeof raw.src === "string" ? raw.src : "",
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : "",
      /* 引用态：src 是原图绝对路径，画布里没有副本 */
      linked: raw.linked === true,
      z: layerOf(raw),
    };
  }
  if (type === "audio") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(160, num(raw.w, AUDIO_DEFAULT_WIDTH)),
      h: Math.max(64, num(raw.h, AUDIO_DEFAULT_HEIGHT)),
      src: typeof raw.src === "string" ? raw.src : "",
      name: typeof raw.name === "string" ? raw.name : "",
      linked: raw.linked === true,
      collapsed: raw.collapsed === true,
      z: layerOf(raw),
    };
  }
  if (type === "video") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(VIDEO_MIN_WIDTH, num(raw.w, VIDEO_DEFAULT_WIDTH)),
      h: Math.max(VIDEO_MIN_HEIGHT, num(raw.h, VIDEO_DEFAULT_HEIGHT)),
      src: typeof raw.src === "string" ? raw.src : "",
      name: typeof raw.name === "string" ? raw.name : "",
      /* 引用态：src 是原片的绝对路径，画布里不存副本 */
      linked: raw.linked === true,
      /* sized：已经按视频真实比例定过一次大小，之后尊重用户手拉的尺寸 */
      sized: raw.sized === true,
      /* 转出来的 AAC 音轨副本（画布目录里的相对路径），没有就是空串 */
      audioRel: typeof raw.audioRel === "string" ? raw.audioRel : "",
      collapsed: raw.collapsed === true,
      z: layerOf(raw),
    };
  }
  if (type === "sticky") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(120, num(raw.w, STICKY_DEFAULT_WIDTH)),
      h: Math.max(60, num(raw.h, STICKY_DEFAULT_HEIGHT)),
      text: typeof raw.text === "string" ? raw.text : "",
      color: typeof raw.color === "string" && raw.color ? raw.color : STICKY_DEFAULT_COLOR,
      textColor:
        typeof raw.textColor === "string" && raw.textColor ? raw.textColor : STICKY_DEFAULT_TEXT,
      z: layerOf(raw),
    };
  }
  if (type === "note") {
    const assets = {};
    if (raw.assets && typeof raw.assets === "object" && !Array.isArray(raw.assets)) {
      for (const [key, value] of Object.entries(raw.assets)) {
        if (typeof value === "string" && value) assets[key] = value;
      }
    }
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(160, num(raw.w, NOTE_DEFAULT_WIDTH)),
      h: Math.max(120, num(raw.h, NOTE_DEFAULT_HEIGHT)),
      path: typeof raw.path === "string" ? raw.path : "",
      name: typeof raw.name === "string" ? raw.name : "",
      source: typeof raw.source === "string" ? raw.source : "",
      /* 引用态：path 是原 .md 的绝对路径，source 只是显示缓存；
         写回时按 sourceFormat / sourceCrlf 还原成原来那份字节 */
      linked: raw.linked === true,
      sourceFormat: typeof raw.sourceFormat === "string" ? raw.sourceFormat : "utf8",
      sourceCrlf: raw.sourceCrlf === true,
      assets,
      collapsed: raw.collapsed === true,
      z: layerOf(raw),
    };
  }
  if (type === "file") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(160, num(raw.w, FILE_DEFAULT_WIDTH)),
      h: Math.max(56, num(raw.h, FILE_DEFAULT_HEIGHT)),
      src: typeof raw.src === "string" ? raw.src : "",
      name: typeof raw.name === "string" ? raw.name : "",
      ext: typeof raw.ext === "string" ? raw.ext : "",
      size: Math.max(0, num(raw.size)),
      text: raw.text === true,
      /* 引用态 src 就是原文件绝对路径，画布 files/ 里没有副本 */
      linked: raw.linked === true,
      collapsed: raw.collapsed === true,
      z: layerOf(raw),
    };
  }
  if (type === "ebook") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(EBOOK_MIN_WIDTH, num(raw.w, EBOOK_DEFAULT_WIDTH)),
      h: Math.max(EBOOK_MIN_HEIGHT, num(raw.h, EBOOK_DEFAULT_HEIGHT)),
      src: typeof raw.src === "string" ? raw.src : "",
      name: typeof raw.name === "string" ? raw.name : "",
      linked: raw.linked === true,
      /* 读到第几章是这块自己的状态，重开画布接着上次那页 */
      chapter: Math.max(0, Math.trunc(num(raw.chapter))),
      collapsed: raw.collapsed === true,
      z: layerOf(raw),
    };
  }
  return null;
}

export function makeBox(type, x1, y1, x2, y2) {
  return {
    id: newId(),
    type,
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.max(1, Math.abs(x2 - x1)),
    h: Math.max(1, Math.abs(y2 - y1)),
    borderColor: DEFAULT_BORDER,
    fillColor: "",
  };
}

export function makeLine(type, x1, y1, x2, y2) {
  return {
    id: newId(),
    type,
    x: x1,
    y: y1,
    x2,
    y2,
    borderColor: DEFAULT_BORDER,
  };
}

/* minH > 0 时文字块至少保持这么高（文字工具拖出来的块）；粘贴的文字不设下限。 */
export function makeText(x, y, w = TEXT_DEFAULT_WIDTH, minH = 0) {
  return {
    id: newId(),
    type: "text",
    x,
    y,
    w: Math.max(40, w),
    text: "",
    color: "",
    fillColor: "",
    borderColor: "",
    h: 0,
    minH: Math.max(0, minH),
    fontSize: 14,
    bordered: false,
  };
}

/* 图片块两种存在方式：拷贝态 src 是画布 images/ 里的相对路径，引用态是原图绝对路径。 */
export function makeImage(x, y, w, h, src, linked = false) {
  return { id: newId(), type: "image", x, y, w, h, src, linked: Boolean(linked), borderColor: "" };
}

export function makeAudio(x, y, name, src, linked = false) {
  return {
    id: newId(),
    type: "audio",
    x,
    y,
    w: AUDIO_DEFAULT_WIDTH,
    h: AUDIO_DEFAULT_HEIGHT,
    src,
    name,
    linked: Boolean(linked),
  };
}

/* 视频块有两种存在方式：拷贝进来的 src 是画布里的相对路径（linked=false），
   引用原片的 src 是绝对路径（linked=true），播放地址统一由后端开权限后现取。
   audioRel 是转出来的 AAC 音轨副本：本机放不出原音轨时用它对声，空着就是原样播。 */
export function makeVideo(x, y, name, src, linked) {
  return {
    id: newId(),
    type: "video",
    x,
    y,
    w: VIDEO_DEFAULT_WIDTH,
    h: VIDEO_DEFAULT_HEIGHT,
    src,
    name,
    linked: Boolean(linked),
    sized: false,
    audioRel: "",
  };
}

/* 便签是快照副本：颜色、文字、尺寸都从原便签抄过来，之后互不影响。 */
export function makeSticky(x, y, note) {
  return {
    id: newId(),
    type: "sticky",
    x,
    y,
    w: Math.max(120, num(note.width, STICKY_DEFAULT_WIDTH)),
    h: Math.max(60, num(note.height, STICKY_DEFAULT_HEIGHT)),
    text: typeof note.body === "string" ? note.body : "",
    color: note.color || STICKY_DEFAULT_COLOR,
    textColor: note.textColor || STICKY_DEFAULT_TEXT,
  };
}

/* 笔记块默认存 Markdown 快照和一份「原图路径 → 画布副本」映射，编辑不动原 .md。
   引用态（link.linked）多带写回要用的编码和换行，path 是原 .md 的绝对路径。 */
export function makeNote(x, y, path, name, source, link = {}) {
  return {
    id: newId(),
    type: "note",
    x,
    y,
    w: NOTE_DEFAULT_WIDTH,
    h: NOTE_DEFAULT_HEIGHT,
    path,
    name,
    source,
    linked: Boolean(link.linked),
    sourceFormat: link.format || "utf8",
    sourceCrlf: Boolean(link.crlf),
    assets: {},
  };
}

/* 文件块只存定位用的路径和卡片上要显示的名字/体积/扩展名，内容不进 items.json。
   拷贝态 src 是画布 files/ 里的相对路径，引用态是原文件绝对路径。
   文本块给一个能读几行的默认高度，剩下由用户自己拉。 */
export function makeFile(x, y, info) {
  const text = info.text === true;
  const linked = Boolean(info.linked);
  return {
    id: newId(),
    type: "file",
    x,
    y,
    w: text ? FILE_TEXT_WIDTH : FILE_DEFAULT_WIDTH,
    h: text ? FILE_TEXT_EXPANDED_HEIGHT : FILE_DEFAULT_HEIGHT,
    src: linked ? info.path : info.rel,
    name: info.name || "未命名文件",
    ext: info.ext || "",
    size: Math.max(0, Number(info.size) || 0),
    text,
    linked,
  };
}

/* 电子书块只记书在哪儿、读到第几章；正文每次现读，不往 items.json 里存书页。
   拷贝态 src 是画布 files/ 里的相对路径，引用态是原书绝对路径。 */
export function makeEbook(x, y, name, src, linked = false) {
  return {
    id: newId(),
    type: "ebook",
    x,
    y,
    w: EBOOK_DEFAULT_WIDTH,
    h: EBOOK_DEFAULT_HEIGHT,
    src,
    name: name || "未命名电子书",
    linked: Boolean(linked),
    chapter: 0,
  };
}

/* 连线的端点只记「挂在哪个块的哪条边」，坐标每次由块几何现算 */
export function makeConnector(fromId, fromSide, toId) {
  return {
    id: newId(),
    type: "connector",
    from: { item: fromId, side: fromSide || "auto" },
    to: { item: toId, side: "auto" },
    shape: "elbow",
    arrow: "end",
    color: DEFAULT_BORDER,
  };
}

/** 图元包围盒（世界坐标）；文字高度取渲染后的实际高度。 */
export function itemBounds(item, el) {
  if (item.type === "line" || item.type === "arrow") {
    return {
      x: Math.min(item.x, item.x2),
      y: Math.min(item.y, item.y2),
      w: Math.abs(item.x2 - item.x),
      h: Math.abs(item.y2 - item.y),
    };
  }
  const h =
    item.type === "text"
      ? el
        ? el.offsetHeight
        : item.h || 24
      : item.collapsed && canCollapse(item)
        ? COLLAPSED_HEIGHT
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

const round2 = (value) => Math.round(value * 100) / 100;

function boundsCenter(bounds) {
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
}

export function sideAnchor(bounds, side) {
  if (side === "top") return { x: bounds.x + bounds.w / 2, y: bounds.y };
  if (side === "bottom") return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h };
  if (side === "left") return { x: bounds.x, y: bounds.y + bounds.h / 2 };
  return { x: bounds.x + bounds.w, y: bounds.y + bounds.h / 2 };
}

/* 从 point 看过来，块离它最近的那条边 */
function facingSide(point, bounds) {
  const c = boundsCenter(bounds);
  const dx = point.x - c.x;
  const dy = point.y - c.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/* auto 端自动挑相对的两条边；固定端（用户从端口拖出）保持不动 */
function resolveSides(fromSide, toSide, aBounds, bBounds) {
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
function curvePath(a, na, b, nb) {
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
function polylinePath(points, radius) {
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
function elbowPath(a, na, b, nb) {
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
  return polylinePath(points, 8);
}

export function routeConnector(shape, fromSide, toSide, aBounds, bBounds) {
  const { sideA, sideB } = resolveSides(fromSide, toSide, aBounds, bBounds);
  const a = sideAnchor(aBounds, sideA);
  const b = sideAnchor(bBounds, sideB);
  const na = SIDE_NORMALS[sideA];
  const nb = SIDE_NORMALS[sideB];
  const d = shape === "curve" ? curvePath(a, na, b, nb) : elbowPath(a, na, b, nb);
  return { a, b, sideA, sideB, d };
}

export function connectorGeometry(item, getBounds) {
  const aBounds = getBounds(item.from.item);
  const bBounds = getBounds(item.to.item);
  if (!aBounds || !bBounds) return null;
  return routeConnector(item.shape, item.from.side, item.to.side, aBounds, bBounds);
}

/* 引用块的原文件找不到了说人话；拷贝块的副本没了才是「丢了」 */
function missingLabel(item, copyText) {
  return item.linked ? "原文件不在了" : copyText;
}

const IMAGE_MISS_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <circle cx="9" cy="10" r="1.6" fill="currentColor"/>
    <path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
  </svg>`;

export function createItemElement(item, mediaSrc, options = {}) {
  const el = document.createElement("div");
  el.className = `canvas-item canvas-item-${item.type}`;
  el.dataset.id = item.id;

  if (item.type === "text") {
    const body = document.createElement("div");
    body.className = "canvas-text-body";
    body.textContent = item.text;
    el.append(body);
  } else if (item.type === "image") {
    if (mediaSrc) {
      const img = document.createElement("img");
      img.className = "canvas-image";
      img.src = mediaSrc;
      img.draggable = false;
      img.alt = "";
      el.append(img);
      if (item.linked) {
        /* 画布里没有这份图，角标说清楚它指向原文件 */
        const badge = document.createElement("span");
        badge.className = "canvas-media-badge";
        badge.textContent = "引用";
        badge.title = `只引用原文件，画布里没有副本：${item.src}`;
        el.append(badge);
      }
    } else {
      const missing = document.createElement("div");
      missing.className = "canvas-image-missing";
      const glyph = document.createElement("span");
      glyph.className = "canvas-image-missing-icon";
      glyph.innerHTML = IMAGE_MISS_SVG;
      const label = document.createElement("span");
      label.textContent = missingLabel(item, "图片丢失");
      missing.append(glyph, label);
      if (item.linked) {
        /* 块留在原地不动，只把这一格换成占位；原图放回原位后重开画布自己恢复 */
        missing.classList.add("is-missing");
        missing.title = `找不到 ${item.src}`;
      }
      el.append(missing);
    }
  } else if (item.type === "audio") {
    el.append(createAudioPlayer(item, mediaSrc, options));
  } else if (item.type === "video") {
    el.append(createVideoPlayer(item, mediaSrc, options));
  } else if (item.type === "line" || item.type === "arrow") {
    el.append(createLineSvg(item));
  } else if (item.type === "sticky") {
    const card = document.createElement("div");
    card.className = "canvas-sticky-card";
    const body = document.createElement("p");
    body.className = "canvas-sticky-body";
    body.textContent = item.text;
    card.append(body);
    el.append(card);
  } else if (item.type === "note") {
    const card = document.createElement("div");
    card.className = "canvas-note-card";
    const body = document.createElement("div");
    body.className = "notes-body canvas-note-body";
    body.innerHTML = renderMarkdown(item.source);
    card.append(body);
    if (item.linked) {
      /* 引用态默认只读，双击才问「改源文件还是转副本」——角标先把这件事说清楚 */
      const badge = document.createElement("span");
      badge.className = "canvas-note-badge";
      badge.textContent = "引用";
      badge.title = `正文来自原文件，编辑前会先问要不要写回：${item.path}`;
      card.append(badge);
    }
    el.append(card);
    /* 从笔记库来的显示原文件路径，拖进来的 .md 只有文件名 */
    el.title = item.path || item.name || "";
  } else if (item.type === "file") {
    el.append(createFileCard(item, options));
  } else if (item.type === "ebook") {
    el.append(createEbookCard(item, options));
  }

  if (canCollapse(item)) {
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "canvas-block-collapse";
    collapse.append(chevronSvg("M4 10.2 8 6.2l4 4", "up"), chevronSvg("M4 5.8l4 4 4-4", "down"));
    stopOnCard(collapse);
    collapse.addEventListener("click", (e) => {
      e.stopPropagation();
      options.onToggleCollapse?.(item);
    });

    /* 收起后盖住整块的那条标题，跟按钮一起常驻 DOM，靠 is-collapsed 切换 */
    const bar = document.createElement("div");
    bar.className = "canvas-collapsed-bar";
    const label = document.createElement("span");
    label.className = "canvas-collapsed-name";
    label.textContent = collapseLabel(item);
    bar.append(label);
    el.append(collapse, bar);
  }

  syncItemElement(el, item);
  return el;
}

function chevronSvg(d, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

const FILE_DOC_SVG = `
  <svg class="canvas-file-icon" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5.2 3.2h6l3.6 3.6v9.4h-9.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M11.2 3.2v3.6h3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
  </svg>`;

const FILE_OPEN_SVG = `
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M12.6 9.8v3.6a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4V7.4A1.4 1.4 0 0 1 6 6h3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M11.8 5.2h3.2v3.2M15 5.2l-5.4 5.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

/* 文本预览一次最多渲染这么多字：后端读的是 512KB 开头，全塞进 DOM 会拖慢画布 */
const PREVIEW_RENDER_CHARS = 20000;
const TABLE_EXTS = new Set(["csv", "tsv"]);
const TABLE_MAX_ROWS = 200;
const TABLE_MAX_COLS = 24;

/* 附件卡片：文件已经拷进画布的 files/ 了，这里负责把名字/体积说清楚，
   文本类的再附一段只读预览。打开动作交给系统默认程序（画布自己不认格式）。 */
function createFileCard(item, options) {
  const card = document.createElement("div");
  card.className = item.text ? "canvas-file-card canvas-file-card-text" : "canvas-file-card";

  const icon = document.createElement("div");
  icon.className = "canvas-file-badge";
  icon.innerHTML = FILE_DOC_SVG;

  const main = document.createElement("div");
  main.className = "canvas-file-main";
  const name = document.createElement("div");
  name.className = "canvas-file-name";
  name.textContent = item.name || "未命名文件";
  name.title = item.name || "";
  const sub = document.createElement("div");
  sub.className = "canvas-file-sub";
  sub.textContent = `${formatSize(item.size)}${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}`;
  if (item.linked) {
    /* 引用态没有副本可看，悬停直接把原文件完整路径给出来 */
    name.title = item.src;
    sub.textContent += " · 引用";
  }
  main.append(name, sub);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "canvas-file-open";
  open.title = "用系统程序打开";
  open.setAttribute("aria-label", "用系统程序打开");
  open.innerHTML = FILE_OPEN_SVG;
  stopOnCard(open);
  open.addEventListener("click", (e) => {
    e.stopPropagation();
    options.onFileOpen?.(item);
  });

  const head = document.createElement("div");
  head.className = "canvas-file-head";
  head.append(icon, main, open);
  card.append(head);

  /* 引用块进画布时问一句原文件还在不在；拷贝块不用查，副本就在画布里。
     正常态这里一个字都不多显示，只有找不到了才把副标题换成这句话 */
  if (item.linked) {
    options.checkFile?.(item).then((found) => {
      if (found || !card.isConnected) return;
      card.classList.add("is-missing");
      sub.textContent = "原文件不在了";
      /* 预览读不出来时也会写一行错误，别在同一张卡上说两遍同一句话 */
      card.querySelector(".canvas-file-preview")?.remove();
    });
  }

  if (!item.text) return card;

  const body = document.createElement("div");
  body.className = "canvas-file-preview";
  card.append(body);
  fillFilePreview(card, body, sub, item, options);
  return card;
}

function stopOnCard(button) {
  /* 卡片上的按钮归按钮自己，别顺手把块拖走 */
  for (const type of ["pointerdown", "dblclick"]) {
    button.addEventListener(type, (e) => e.stopPropagation());
  }
}

const stripExt = (name) => String(name || "").replace(/\.[^.\\/]+$/, "");

/* 电子书阅读块：书上架前先读一遍目录，读到第几章记在这块自己身上。
 * 正文塞进 sandbox="" 的 iframe——书里的脚本一行都跑不起来，图片已经在后端
 * 转成 data URL，所以也不需要给 iframe 任何读本地文件的权限。 */
function createEbookCard(item, options) {
  const card = document.createElement("div");
  card.className = "canvas-ebook-card";

  const head = document.createElement("div");
  head.className = "canvas-ebook-head";
  head.title = item.linked ? `只引用原文件：${item.src}` : item.name;
  const meta = document.createElement("div");
  meta.className = "canvas-ebook-meta";
  const title = document.createElement("div");
  title.className = "canvas-ebook-title";
  title.textContent = stripExt(item.name) || "电子书";
  const author = document.createElement("div");
  author.className = "canvas-ebook-author";
  meta.append(title, author);

  /* 箭头用 SVG 而不是 ‹ › 字形：字符的墨迹中心跟行盒中心不重合，
     放在圆钮里怎么调都会看着偏一格 */
  const toolbar = document.createElement("div");
  toolbar.className = "canvas-ebook-toolbar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "canvas-ebook-step";
  prev.append(chevronSvg("M10 4 6 8l4 4"));
  prev.title = "上一章";
  prev.setAttribute("aria-label", "上一章");
  const select = document.createElement("select");
  select.className = "canvas-ebook-select";
  select.title = "选择章节";
  select.disabled = true;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "canvas-ebook-step";
  next.append(chevronSvg("M6 4l4 4-4 4"));
  next.title = "下一章";
  next.setAttribute("aria-label", "下一章");
  const pos = document.createElement("span");
  pos.className = "canvas-ebook-pos";
  toolbar.append(prev, select, next, pos);
  head.append(meta, toolbar);
  for (const control of [prev, select, next]) stopOnCard(control);

  const body = document.createElement("div");
  body.className = "canvas-ebook-body";
  const frame = document.createElement("iframe");
  frame.className = "canvas-ebook-page";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "书页";
  const state = document.createElement("div");
  state.className = "canvas-ebook-state";
  state.textContent = "正在排版…";
  body.append(frame, state);
  card.append(head, body);

  /* 双击书眉交给系统默认程序，跟附件卡片一个意思 */
  head.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    options.onFileOpen?.(item);
  });

  /* wanted 是「已经点去、还没翻到」的那一章：连点下一章时按它累加，
     不然两次都从 item.chapter 起算，只会反复请求同一章 */
  let book = null;
  let wanted = null;
  let seq = 0;

  const step = (dir) => {
    if (!book) return;
    const base = wanted ?? item.chapter;
    const target = base + dir;
    if (target < 0 || target >= book.chapters.length) return;
    showChapter(target, true);
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  select.addEventListener("change", () => showChapter(Number(select.value) || 0, true));

  function fail(text, missing = false) {
    seq += 1;
    state.hidden = false;
    state.textContent = text;
    state.classList.toggle("is-missing", missing);
    card.classList.toggle("is-missing", missing);
    frame.hidden = true;
  }

  function paintChrome() {
    const total = book.chapters.length;
    const at = Math.min(item.chapter, total - 1);
    select.value = String(at);
    pos.textContent = `${at + 1} / ${total}`;
    prev.disabled = at <= 0;
    next.disabled = at >= total - 1;
  }

  async function showChapter(index, remember) {
    if (!book) return;
    const total = book.chapters.length;
    const at = Math.min(Math.max(0, Math.trunc(index)), total - 1);
    wanted = at;
    const mine = ++seq;
    frame.hidden = false;
    state.hidden = false;
    state.classList.remove("is-missing");
    state.textContent = total > 1 ? `正在翻到第 ${at + 1} 章…` : "正在排版…";
    let chapter = null;
    try {
      chapter = await options.loadEbookChapter?.(item, at);
    } catch (error) {
      if (mine !== seq || !card.isConnected) return;
      fail(String(error));
      return;
    }
    /* 连点下一章时只认最后一次：慢的那次回来别把新章盖回去 */
    if (mine !== seq || !card.isConnected || !chapter) return;
    frame.srcdoc = chapter.html;
    state.hidden = true;
    item.chapter = at;
    paintChrome();
    if (remember) options.onEbookPosition?.(item);
  }

  (async () => {
    /* 引用块先问一句原书还在不在，不在就把纸换成占位，不去读一本不存在的东西 */
    if (item.linked && options.checkFile) {
      let found = true;
      try {
        found = await options.checkFile(item);
      } catch {
        found = true;
      }
      if (found === false) {
        if (card.isConnected) fail(missingLabel(item, "这本书打不开了"), true);
        return;
      }
    }
    let info = null;
    try {
      info = await options.loadEbookToc?.(item);
    } catch (error) {
      if (card.isConnected) fail(String(error));
      return;
    }
    if (!card.isConnected) return;
    if (!info || !Array.isArray(info.chapters) || !info.chapters.length) {
      fail("这本书里没有正文");
      return;
    }
    book = info;
    if (info.title) title.textContent = info.title;
    if (info.author) author.textContent = info.author;
    else author.remove();
    select.textContent = "";
    info.chapters.forEach((name, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `${i + 1}. ${name || `第 ${i + 1} 章`}`;
      select.append(option);
    });
    select.disabled = false;
    item.chapter = Math.min(item.chapter, info.chapters.length - 1);
    paintChrome();
    await showChapter(item.chapter, false);
  })();

  return card;
}

async function fillFilePreview(card, body, sub, item, options) {
  let preview = null;
  try {
    preview = await options.loadPreview?.(item);
  } catch (error) {
    /* 解不出来才摊开说，正常态这里一行小字都不加 */
    body.className = "canvas-file-preview is-failed";
    body.textContent = String(error);
    return;
  }
  if (!preview || !card.isConnected) return;
  const tags = [];
  if (preview.encoding && preview.encoding !== "UTF-8") tags.push(preview.encoding);
  if (preview.truncated) tags.push("仅预览开头");
  if (tags.length) sub.textContent += ` · ${tags.join(" · ")}`;
  renderFilePreview(body, item, preview);
}

function renderFilePreview(body, item, preview) {
  const ext = (item.ext || "").toLowerCase();
  if (TABLE_EXTS.has(ext)) {
    const table = createDelimitedTable(preview.text, ext === "tsv" ? "\t" : ",");
    if (table) {
      body.classList.add("is-table");
      body.append(table);
      return;
    }
  }
  const pre = document.createElement("pre");
  pre.className = "canvas-file-lines";
  pre.textContent =
    preview.text.length > PREVIEW_RENDER_CHARS
      ? `${preview.text.slice(0, PREVIEW_RENDER_CHARS)}\n…`
      : preview.text;
  body.append(pre);
}

/* RFC 4180 那套：双引号包字段、"" 是一个引号、引号里可以带换行。
   引号没闭合就返回 null，让调用方退回纯文本显示，别硬凑一张错位的表。 */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (quoted) return null;
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function createDelimitedTable(text, delim) {
  const rows = parseDelimited(text, delim);
  if (!rows || rows.length < 2) return null;
  const widest = Math.max(...rows.slice(0, 20).map((row) => row.length));
  if (widest < 2) return null;
  const cols = Math.min(widest, TABLE_MAX_COLS);

  const table = document.createElement("table");
  table.className = "canvas-file-table";
  const head = document.createElement("thead");
  head.append(tableRow(rows[0], cols, "th"));
  const body = document.createElement("tbody");
  for (const row of rows.slice(1, TABLE_MAX_ROWS + 1)) body.append(tableRow(row, cols, "td"));
  table.append(head, body);
  return table;
}

function tableRow(cells, cols, tag) {
  const tr = document.createElement("tr");
  for (let i = 0; i < cols; i += 1) {
    const cell = document.createElement(tag);
    cell.textContent = cells[i] ?? "";
    tr.append(cell);
  }
  return tr;
}

const AUDIO_NOTE_SVG = `
  <svg class="canvas-audio-note" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7.6 14.2V5.7l7-1.5v8.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="5.9" cy="14.6" r="2.1" fill="currentColor"/>
    <circle cx="12.9" cy="13.1" r="2.1" fill="currentColor"/>
  </svg>
  <span class="canvas-audio-bars" aria-hidden="true"><i></i><i></i><i></i></span>`;

const AUDIO_PLAY_SVG = `
  <svg class="canvas-audio-play" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7.2 4.9v10.2L15 10z" fill="currentColor"/>
  </svg>`;

const AUDIO_PAUSE_SVG = `
  <svg class="canvas-audio-pause" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="5.6" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
    <rect x="11.4" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
  </svg>`;

export function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/* 播放器外壳。音频数据按需加载，避免打开画布时把所有歌都读进内存。 */
function createAudioPlayer(item, mediaSrc, options = {}) {
  const loadAudio = options.loadAudio;
  const player = document.createElement("div");
  player.className = "canvas-audio-player";

  const icon = document.createElement("div");
  icon.className = "canvas-audio-icon";
  icon.innerHTML = AUDIO_NOTE_SVG;

  const main = document.createElement("div");
  main.className = "canvas-audio-main";

  const name = document.createElement("div");
  name.className = "canvas-audio-name";
  name.textContent = item.name || "未命名音频";
  name.title = item.name || "未命名音频";
  if (item.linked) {
    /* 引用态没有副本可播，悬停直接把原文件完整路径给出来 */
    name.textContent += " · 引用";
    name.title = item.src;
  }

  const row = document.createElement("div");
  row.className = "canvas-audio-row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "canvas-audio-toggle";
  toggle.setAttribute("aria-label", "播放");
  toggle.innerHTML = `${AUDIO_PLAY_SVG}${AUDIO_PAUSE_SVG}`;

  const track = document.createElement("div");
  track.className = "canvas-audio-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "播放进度");
  track.innerHTML = `
    <div class="canvas-audio-rail">
      <div class="canvas-audio-fill"></div>
      <span class="canvas-audio-knob"></span>
    </div>`;

  const time = document.createElement("span");
  time.className = "canvas-audio-time";
  time.textContent = "0:00 / 0:00";

  row.append(toggle, track, time);
  main.append(name, row);
  player.append(icon, main);

  const audio = document.createElement("audio");
  audio.className = "canvas-audio-element";
  audio.preload = "metadata";

  const fill = track.querySelector(".canvas-audio-fill");
  const knob = track.querySelector(".canvas-audio-knob");

  let ready = false;
  let duration = 0;
  let pendingSeek = null;

  if (item.src && mediaSrc) {
    audio.src = mediaSrc;
    ready = true;
  }
  if (!item.src || options.mediaMissing) {
    player.classList.add("is-missing");
    toggle.disabled = true;
    time.textContent = missingLabel(item, "音频丢失");
    if (options.mediaMissing) name.title = `找不到 ${item.src}`;
  }

  const render = () => {
    const total = Number.isFinite(audio.duration) ? audio.duration : duration;
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    time.textContent = `${formatMediaTime(position)} / ${formatMediaTime(total)}`;
    const fraction = total > 0 ? Math.min(1, Math.max(0, position / total)) : 0;
    fill.style.width = `${fraction * 100}%`;
    knob.style.left = `${fraction * 100}%`;
  };

  const ensureSource = async () => {
    if (ready) return true;
    if (!item.src || typeof loadAudio !== "function") return false;
    try {
      player.classList.add("is-loading");
      const dataUrl = await loadAudio(item.src);
      audio.src = dataUrl;
      ready = true;
      player.classList.remove("is-loading");
      return true;
    } catch {
      player.classList.remove("is-loading");
      player.classList.add("is-error");
      toggle.disabled = true;
      time.textContent = missingLabel(item, "音频丢失");
      return false;
    }
  };

  const seek = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      pendingSeek = fraction;
      return;
    }
    audio.currentTime = fraction * audio.duration;
    render();
  };

  toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  toggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!(await ensureSource())) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        player.classList.add("is-error");
      }
    } else {
      audio.pause();
    }
  });

  track.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ensureSource().then(() => seek(e.clientX));
    const move = (event) => seek(event.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  audio.addEventListener("loadedmetadata", () => {
    duration = audio.duration;
    if (pendingSeek !== null) {
      audio.currentTime = pendingSeek * duration;
      pendingSeek = null;
    }
    render();
  });
  audio.addEventListener("timeupdate", render);
  audio.addEventListener("play", () => {
    /* 画布上同时只播一个声音 */
    const scope = player.closest(".canvas-world") || document;
    for (const other of scope.querySelectorAll("audio, video")) {
      if (other !== audio) other.pause();
    }
    player.classList.add("is-playing");
    player.classList.remove("is-error");
    toggle.setAttribute("aria-label", "暂停");
  });
  audio.addEventListener("pause", () => {
    player.classList.remove("is-playing");
    toggle.setAttribute("aria-label", "播放");
  });
  audio.addEventListener("ended", () => {
    player.classList.remove("is-playing");
    audio.currentTime = 0;
    render();
  });
  audio.addEventListener("error", () => {
    if (!ready) return;
    player.classList.remove("is-playing");
    player.classList.add("is-error");
    toggle.disabled = true;
    time.textContent = "无法播放";
  });

  player.append(audio);
  return player;
}

const VIDEO_CURTAIN_SVG = `
  <svg viewBox="0 0 44 44" aria-hidden="true">
    <circle cx="22" cy="22" r="20.5" fill="rgba(0,0,0,0.42)" stroke="rgba(255,255,255,0.86)" stroke-width="1.5"/>
    <path d="M17.6 14.3v15.4L30.4 22z" fill="#fff"/>
  </svg>`;

const VIDEO_PLAY_SVG = `
  <svg class="canvas-video-play" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7.2 4.9v10.2L15 10z" fill="currentColor"/>
  </svg>`;

const VIDEO_PAUSE_SVG = `
  <svg class="canvas-video-pause" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="5.6" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
    <rect x="11.4" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
  </svg>`;

const VIDEO_MAX_OUT_SVG = `
  <svg class="canvas-video-max-out" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M8 4.4H4.4V8M12 4.4h3.6V8M15.6 12v3.6H12M8 15.6H4.4V12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

const VIDEO_MAX_IN_SVG = `
  <svg class="canvas-video-max-in" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4.6 8.2H8.2V4.6M15.4 8.2H11.8V4.6M15.4 11.8H11.8v3.6M4.6 11.8H8.2v3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

/* 视频播放壳。地址不是 base64，而是后端开了读权限的 asset 协议链接，
 * 浏览器按 Range 一段段要，所以 20GB 的片子也只占解码缓冲，不会整份进内存。
 * 地址也是点到才去取：打开画布时不会把所有片子都拉一遍。 */
function createVideoPlayer(item, mediaSrc, options = {}) {
  const player = document.createElement("div");
  player.className = "canvas-video-player";
  player.title = item.name || "未命名视频";

  const stage = document.createElement("div");
  stage.className = "canvas-video-stage";

  const video = document.createElement("video");
  video.className = "canvas-video-element";
  video.preload = "metadata";
  video.playsInline = true;

  /* 转出来的 AAC 音轨副本：画面还是原片，声音改吃这份。
     原音轨在这台机器上放不出声时才用得上。 */
  const dub = document.createElement("audio");
  dub.preload = "auto";

  const curtain = document.createElement("div");
  curtain.className = "canvas-video-curtain";
  curtain.innerHTML = VIDEO_CURTAIN_SVG;

  stage.append(video, curtain);

  if (item.linked) {
    const badge = document.createElement("span");
    badge.className = "canvas-video-badge";
    badge.textContent = "引用";
    badge.title = `只引用原文件，画布里没有副本：${item.src}`;
    stage.append(badge);
  }

  const row = document.createElement("div");
  row.className = "canvas-video-row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "canvas-video-toggle";
  toggle.setAttribute("aria-label", "播放");
  toggle.innerHTML = `${VIDEO_PLAY_SVG}${VIDEO_PAUSE_SVG}`;

  const track = document.createElement("div");
  track.className = "canvas-video-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "播放进度");
  track.innerHTML = `
    <div class="canvas-video-rail">
      <div class="canvas-video-fill"></div>
      <span class="canvas-video-knob"></span>
    </div>`;

  const time = document.createElement("span");
  time.className = "canvas-video-time";
  time.textContent = "0:00 / 0:00";

  /* 播不出来的入口只在真出问题以后才出现，平时这一行干干净净。纯文字，不带色块。 */
  const hint = document.createElement("button");
  hint.type = "button";
  hint.className = "canvas-video-hint";
  hint.hidden = true;

  /* 铺满屏幕那颗键：视频丢了就没必要露出来 */
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "canvas-video-max";
  expand.setAttribute("aria-label", "全屏");
  expand.title = "铺满屏幕";
  expand.innerHTML = `${VIDEO_MAX_OUT_SVG}${VIDEO_MAX_IN_SVG}`;

  row.append(toggle, track, time, hint);
  /* 原文件没了的引用块没什么可全屏的，那颗键就别露出来 */
  if (item.src && !options.mediaMissing) row.append(expand);
  player.append(stage, row);

  const fill = track.querySelector(".canvas-video-fill");
  const knob = track.querySelector(".canvas-video-knob");

  let ready = false;
  let dubReady = false;
  let duration = 0;
  let pendingSeek = null;
  let problem = "";

  if (item.src && mediaSrc) {
    video.src = mediaSrc;
    ready = true;
  }
  if (!item.src || options.mediaMissing) {
    player.classList.add("is-missing");
    toggle.disabled = true;
    time.textContent = missingLabel(item, "视频丢失");
    if (options.mediaMissing) player.title = `找不到 ${item.src}`;
  }

  /* 有 AAC 副本时画面自己不出声，声音全交给副本，不然两边一起响。 */
  video.muted = Boolean(item.audioRel);

  const markProblem = (reason) => {
    if (problem || !item.src) return;
    problem = reason;
    hint.hidden = false;
    hint.textContent = reason === "audio" ? "没声音？" : "播不出来？";
    hint.title =
      reason === "audio"
        ? "画面在动，可音轨一个字节都没解出来。点这里看怎么办"
        : "连一帧画面都没解出来。点这里看怎么办";
  };

  /* 判断依据只有硬指标：解码器吃进去多少字节、解出多少帧。
     不用 Web Audio 量音量 —— asset 地址算跨源，接上分析器永远读 0，测了反而骗自己。 */
  const checkPlayback = () => {
    if (problem || item.audioRel) return;
    const frames = video.webkitDecodedFrameCount;
    const bytes = video.webkitAudioDecodedByteCount;
    if (typeof frames === "number" && frames === 0) {
      markProblem("video");
    } else if (typeof bytes === "number" && bytes === 0) {
      markProblem("audio");
    }
  };

  const render = () => {
    const total = Number.isFinite(video.duration) ? video.duration : duration;
    const position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    time.textContent = `${formatMediaTime(position)} / ${formatMediaTime(total)}`;
    const fraction = total > 0 ? Math.min(1, Math.max(0, position / total)) : 0;
    fill.style.width = `${fraction * 100}%`;
    knob.style.left = `${fraction * 100}%`;
    /* 副本跟画面对声：差得多于 80ms 才拽一把，不然每帧都设 currentTime 反而抖 */
    if (dubReady && !video.paused && Math.abs(dub.currentTime - position) > 0.08) {
      dub.currentTime = position;
    }
  };

  const ensureSource = async () => {
    if (ready) return true;
    if (!item.src || typeof options.loadVideo !== "function") return false;
    try {
      player.classList.add("is-loading");
      video.src = await options.loadVideo(item.src);
      ready = true;
      player.classList.remove("is-loading");
      return true;
    } catch {
      player.classList.remove("is-loading");
      player.classList.add("is-error");
      /* 不锁死按钮：原片插回硬盘后还能再点一次重试 */
      time.textContent = missingLabel(item, "视频文件不在了");
      return false;
    }
  };

  /* 副本走的是同一条 asset 通道：后端顺手把读权限开了，大音频也不会整份进内存。
     它一定躺在画布目录里，所以按相对路径取，跟原片是不是引用态无关。 */
  const ensureDub = async () => {
    if (!item.audioRel || dubReady || typeof options.loadVideo !== "function") return;
    try {
      dub.src = await options.loadVideo(item.audioRel, false);
      dubReady = true;
    } catch {
      /* 副本没了就回原音轨，别把整块卡死 */
      video.muted = false;
    }
  };

  const togglePlay = async () => {
    if (!(await ensureSource())) return;
    if (video.paused) {
      await ensureDub();
      try {
        await video.play();
      } catch {
        player.classList.add("is-error");
        time.textContent = "这个格式播不了";
        markProblem("video");
      }
    } else {
      video.pause();
    }
  };

  const seek = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      pendingSeek = fraction;
      return;
    }
    video.currentTime = fraction * video.duration;
    if (dubReady) dub.currentTime = video.currentTime;
    render();
  };

  toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });

  hint.addEventListener("pointerdown", (e) => e.stopPropagation());
  hint.addEventListener("click", (e) => {
    e.stopPropagation();
    options.onVideoProblem?.(item, problem);
  });

  /* 全屏挂在外壳上，不是 <video> 自己：这样控制行跟着一起进全屏层。
     监听也挂在壳上，壳随块重建时一起消失，不会在 document 上攒一堆僵尸监听。 */
  const setFullscreen = (on) => {
    player.classList.toggle("is-fullscreen", on);
    expand.setAttribute("aria-label", on ? "退出全屏" : "全屏");
    expand.title = on ? "退出全屏（Esc）" : "铺满屏幕";
  };

  player.addEventListener("fullscreenchange", () => {
    setFullscreen(document.fullscreenElement === player);
  });

  expand.addEventListener("pointerdown", (e) => e.stopPropagation());
  expand.addEventListener("click", (e) => {
    e.stopPropagation();
    if (document.fullscreenElement === player) {
      document.exitFullscreen().catch(() => {});
    } else {
      player.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }
  });

  /* 画面区域留给你拖动整块，双击才切换播放，不然块就挪不动了 */
  stage.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePlay();
  });

  track.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ensureSource().then((ok) => ok && seek(e.clientX));
    const move = (event) => seek(event.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  video.addEventListener("loadedmetadata", () => {
    duration = video.duration;
    if (!item.sized && video.videoWidth > 0 && video.videoHeight > 0) {
      const fit = fitVideoSize(video.videoWidth, video.videoHeight);
      item.w = fit.w;
      item.h = fit.h;
      item.sized = true;
      const el = player.closest(".canvas-item");
      if (el) syncItemElement(el, item);
      options.onVideoSize?.(item);
    }
    if (pendingSeek !== null) {
      video.currentTime = pendingSeek * duration;
      pendingSeek = null;
    }
    render();
  });
  video.addEventListener("timeupdate", () => {
    render();
    /* 播出去一秒多再下结论：刚起步时字节数还没涨，容易看成哑巴 */
    if (video.currentTime > 1.2) checkPlayback();
  });
  video.addEventListener("durationchange", () => {
    /* mkv 的时长有时比 metadata 晚到 */
    if (Number.isFinite(video.duration) && video.duration !== duration) {
      duration = video.duration;
      render();
    }
  });
  video.addEventListener("play", () => {
    const scope = player.closest(".canvas-world") || document;
    for (const other of scope.querySelectorAll("audio, video")) {
      if (other !== video) other.pause();
    }
    if (dubReady) dub.play().catch(() => {});
    player.classList.add("is-playing");
    player.classList.remove("is-error");
    toggle.setAttribute("aria-label", "暂停");
  });
  video.addEventListener("pause", () => {
    if (dubReady) dub.pause();
    player.classList.remove("is-playing");
    toggle.setAttribute("aria-label", "播放");
  });
  video.addEventListener("ended", () => {
    if (dubReady) dub.pause();
    player.classList.remove("is-playing");
    video.currentTime = 0;
    render();
  });
  video.addEventListener("error", () => {
    if (!ready) return;
    player.classList.remove("is-playing");
    player.classList.add("is-error");
    time.textContent = "无法播放";
    markProblem("video");
  });

  /* 副本不进 DOM：画布里有「播一个就停掉其余」的规矩，挂在树上的它会把自己挤掉。 */
  if (item.audioRel) ensureDub();

  return player;
}

function createLineSvg(item) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("canvas-line-svg");
  svg.setAttribute("overflow", "visible");

  if (item.type === "arrow") {
    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", `arrow-${item.id}`);
    marker.setAttribute("viewBox", "0 0 6 6");
    marker.setAttribute("refX", "5.4");
    marker.setAttribute("refY", "3");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto");
    const head = document.createElementNS(SVG_NS, "path");
    head.setAttribute("d", "M0 0 L6 3 L0 6 Z");
    head.setAttribute("fill", item.borderColor);
    marker.append(head);
    defs.append(marker);
    svg.append(defs);
  }

  const line = document.createElementNS(SVG_NS, "line");
  line.classList.add("canvas-line-visible");
  line.setAttribute("stroke", item.borderColor);
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  if (item.type === "arrow") line.setAttribute("marker-end", `url(#arrow-${item.id})`);
  svg.append(line);

  /* 2px 的线太细不好点：叠一条透明的宽线专门用来接指针 */
  const hit = document.createElementNS(SVG_NS, "line");
  hit.classList.add("canvas-line-hit");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "14");
  svg.append(hit);
  return svg;
}

/** 把数据同步到已有 DOM（拖动/缩放/改色时只走这里，不重建节点）。 */
export function syncItemElement(el, item) {
  el.style.left = `${item.x}px`;
  el.style.top = `${item.y}px`;

  const collapsed = item.collapsed === true && canCollapse(item);
  el.classList.toggle("is-collapsed", collapsed);
  const collapse = el.querySelector(".canvas-block-collapse");
  if (collapse) {
    collapse.setAttribute("aria-label", collapsed ? "展开" : "收起");
    collapse.title = collapsed ? "展开内容" : "收起内容";
  }
  const collapsedName = el.querySelector(".canvas-collapsed-name");
  if (collapsedName) collapsedName.textContent = collapseLabel(item);

  if (item.type === "line" || item.type === "arrow") {
    const points = linePoints(item);
    el.style.left = `${Math.min(item.x, item.x2)}px`;
    el.style.top = `${Math.min(item.y, item.y2)}px`;
    el.style.width = `${points.w}px`;
    el.style.height = `${points.h}px`;
    const svg = el.querySelector(".canvas-line-svg");
    svg.setAttribute("viewBox", `0 0 ${points.w} ${points.h}`);
    for (const line of svg.querySelectorAll("line")) {
      line.setAttribute("x1", String(points.x1));
      line.setAttribute("y1", String(points.y1));
      line.setAttribute("x2", String(points.x2));
      line.setAttribute("y2", String(points.y2));
    }
    const visible = svg.querySelector(".canvas-line-visible");
    visible.setAttribute("stroke", item.borderColor || "transparent");
    const head = svg.querySelector("marker path");
    if (head) head.setAttribute("fill", item.borderColor || "transparent");
    return;
  }

  if (item.type === "text") {
    el.style.width = `${item.w}px`;
    el.style.minHeight = item.minH ? `${item.minH}px` : "";
    el.style.fontSize = `${item.fontSize}px`;
    el.style.color = item.color || "";
    el.style.background = item.fillColor || "transparent";
    if (item.borderColor) el.style.setProperty("--text-border", item.borderColor);
    else el.style.removeProperty("--text-border");
    el.classList.toggle("is-bordered", Boolean(item.bordered));
    return;
  }

  if (item.type === "audio") {
    el.style.width = `${item.w}px`;
    el.style.height = `${collapsed ? COLLAPSED_HEIGHT : item.h}px`;
    return;
  }

  /* 视频壳、文件卡片、笔记和书页的排版都在卡片自己手里，这里只管按块的宽高摆位置；
     收起时只留一条标题的高度，item.h 原样留着，展开就回去 */
  if (
    item.type === "video" ||
    item.type === "file" ||
    item.type === "ebook" ||
    item.type === "note"
  ) {
    el.style.width = `${item.w}px`;
    el.style.height = `${collapsed ? COLLAPSED_HEIGHT : item.h}px`;
    return;
  }

  if (item.type === "sticky") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    const card = el.querySelector(".canvas-sticky-card");
    if (card) {
      card.style.background = item.color;
      card.style.color = item.textColor;
    }
    return;
  }

  el.style.width = `${item.w}px`;
  el.style.height = `${item.h}px`;
  if (item.type === "image") {
    // 用内偏移描边，不动布局，图片按比例缩放时不会抖
    el.style.outline = item.borderColor ? `2px solid ${item.borderColor}` : "none";
    el.style.outlineOffset = "-2px";
    return;
  }
  el.style.borderColor = item.borderColor || "transparent";
  el.style.background = item.fillColor || "transparent";
}

/* ---------- 连线渲染 ---------- */

function createArrowMarker(id, color) {
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", id);
  marker.setAttribute("viewBox", "0 0 6 6");
  marker.setAttribute("refX", "5.4");
  marker.setAttribute("refY", "3");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const head = document.createElementNS(SVG_NS, "path");
  head.setAttribute("d", "M0 0 L6 3 L0 6 Z");
  head.setAttribute("fill", color);
  marker.append(head);
  return marker;
}

export function createConnectorElement(item) {
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("canvas-connector");
  group.dataset.id = item.id;

  /* 箭头 marker 一次建好，之后切换箭头样式不用重造节点 */
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.append(createArrowMarker(`edge-arrow-${item.id}`, item.color));
  group.append(defs);

  const visible = document.createElementNS(SVG_NS, "path");
  visible.classList.add("canvas-edge-visible");
  /* 2px 的线太细，叠一条透明宽线专门接指针 */
  const hit = document.createElementNS(SVG_NS, "path");
  hit.classList.add("canvas-edge-hit");

  group.append(visible, hit);
  syncConnectorElement(group, item, null);
  return group;
}

export function syncConnectorElement(group, item, geometry) {
  const visible = group.querySelector(".canvas-edge-visible");
  const hit = group.querySelector(".canvas-edge-hit");
  const head = group.querySelector("marker path");
  const color = item.color || "transparent";
  if (head) head.setAttribute("fill", color);
  visible.setAttribute("stroke", color);

  if (item.arrow === "none") {
    visible.removeAttribute("marker-end");
    visible.removeAttribute("marker-start");
  } else {
    visible.setAttribute("marker-end", `url(#edge-arrow-${item.id})`);
    if (item.arrow === "both") visible.setAttribute("marker-start", `url(#edge-arrow-${item.id})`);
    else visible.removeAttribute("marker-start");
  }

  if (!geometry) {
    group.setAttribute("visibility", "hidden");
    return;
  }
  group.removeAttribute("visibility");
  visible.setAttribute("d", geometry.d);
  hit.setAttribute("d", geometry.d);
}

/** 把屏幕尺寸按比例塞进 IMAGE_MAX_SIDE，并保持宽高比。 */
export function fitImageSize(width, height) {
  const w = Math.max(8, width || 120);
  const h = Math.max(8, height || 120);
  const ratio = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
  return { w: Math.round(w * ratio), h: Math.round(h * ratio) };
}

/** 按视频真实比例算块大小：长边不超过 VIDEO_MAX_SIDE，算上底部控制条的高度。 */
export function fitVideoSize(width, height) {
  const w = Math.max(VIDEO_MIN_WIDTH, width || VIDEO_DEFAULT_WIDTH);
  const h = Math.max(60, height || VIDEO_DEFAULT_HEIGHT);
  const ratio = Math.min(1, VIDEO_MAX_SIDE / Math.max(w, h));
  return {
    w: Math.round(w * ratio),
    h: Math.round(h * ratio) + VIDEO_ROW_HEIGHT,
  };
}
