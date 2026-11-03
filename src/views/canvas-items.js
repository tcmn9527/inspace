/* 空间图元：数据形状、几何计算和 DOM 渲染。
 * 所有坐标都是世界坐标（未乘缩放），图元本身互不嵌套。 */

import { renderMarkdown } from "./markdown.js";
import { isCancelled, openPdf, pdfPageSize, pdfProblem, renderPdfPage } from "./canvas-pdf.js";
/* 只 import 我自己那层薄壳：three.js 本体是 scene3d 里第一次有场景块进屏幕才动态拉的 */
import { syncScene } from "./scene3d.js";
/* 生图面板的显示层：出图在 Rust 那边，这儿只把这一轮的状态画出来 */
import { syncGen } from "./genpanel.js";

export const DEFAULT_BORDER = "#9a9a9a";
/* 矩形/椭圆的边框宽度，跟样式表里 .canvas-item-rect/.canvas-item-ellipse 的 2px 对齐 */
export const BORDER_DEFAULT_WIDTH = 2;
export const BORDER_MAX_WIDTH = 40;
/* 卡片型面板（便签/笔记/文件/图片）的边框和圆角，跟样式表里的 1px 实线、10px 圆角对齐 */
export const CARD_DEFAULT_BORDER_WIDTH = 1;
export const CARD_DEFAULT_RADIUS = 10;
export const TEXT_DEFAULT_WIDTH = 320;
/* 文字块默认的圆角，跟样式表里 .canvas-item-text 的 border-radius 保持一致 */
export const TEXT_DEFAULT_RADIUS = 10;
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
/* 文件卡片按附件条来做：宽度默认够长名字省略号收尾 */
export const FILE_DEFAULT_WIDTH = 320;
export const FILE_DEFAULT_HEIGHT = 84;
/* PDF 页按 A4 比例：420 宽时一页约 594 高，块给 560 就基本是一屏 */
export const PDF_DEFAULT_WIDTH = 420;
export const PDF_DEFAULT_HEIGHT = 560;
/* 文本类文件在卡片里直接给只读预览：折叠只露几行，展开后才允许自己拉大小 */
export const FILE_TEXT_WIDTH = 420;
export const FILE_TEXT_EXPANDED_HEIGHT = 320;
/* 电子书块是一整页纸：默认给到能读几段的高度，用户还能接着拉 */
export const EBOOK_DEFAULT_WIDTH = 560;
export const EBOOK_DEFAULT_HEIGHT = 640;
export const EBOOK_MIN_WIDTH = 300;
export const EBOOK_MIN_HEIGHT = 220;
/* DOCX 块：把 Word 文档转成 HTML 在卡片里只读预览，默认给到能读几段的尺寸 */
export const DOCX_DEFAULT_WIDTH = 420;
export const DOCX_DEFAULT_HEIGHT = 360;
export const DOCX_MIN_WIDTH = 220;
export const DOCX_MIN_HEIGHT = 160;
/* XLSX 块：表格预览，行比文字高，默认给到能看见表头加几行的尺寸 */
export const XLSX_DEFAULT_WIDTH = 460;
export const XLSX_DEFAULT_HEIGHT = 360;
export const XLSX_MIN_WIDTH = 240;
export const XLSX_MIN_HEIGHT = 180;
/* PPTX 块：把每一页拆成绝对定位的文本框/图片/表格，按原始版面比例还原。
   默认给到能看清单页的高度，用户还能接着拉大 */
export const PPTX_DEFAULT_WIDTH = 460;
export const PPTX_DEFAULT_HEIGHT = 300;
export const PPTX_MIN_WIDTH = 240;
export const PPTX_MIN_HEIGHT = 180;
/* 画面块：一块矢量画面。块自身的宽高就是裁剪框，画进去的坐标可以无限往外延伸，
   框外的浏览器直接裁掉——所以「往画外继续画」不需要改块的大小，挪裁剪框就行。 */
export const PICTURE_MIN_WIDTH = 160;
export const PICTURE_MIN_HEIGHT = 120;
export const PICTURE_DEFAULT_WIDTH = 560;
export const PICTURE_DEFAULT_HEIGHT = 420;
/* 指令条数与单条点数：画面是 svg 节点，堆到几万个浏览器会直接卡死。
   到了上限就丢掉多出来的部分，宁可少画几笔也不整块不动。 */
export const PICTURE_MAX_CMDS = 4000;
export const PICTURE_MAX_POINTS = 4000;
/* 素材表：一条 use 顶一整组指令，所以光卡顶层条数不够——
   真把浏览器压死的是展开后的节点数。软上限，超了这次就不落笔并说明白。 */
export const PICTURE_MAX_SYMBOLS = 200;
export const PICTURE_MAX_SYMBOL_CMDS = 300;
export const PICTURE_MAX_EXPANDED = 20000;
export const PICTURE_TEXT_FONTS = ["sans", "serif", "mono", "cjk"];
/* 手绘的两种笔：pen 一路等宽，brush 沿笔程提按（走得快细、停住粗）。
   宽度记的是画面单位而不是屏幕像素——块放大笔画跟着变粗，跟在纸上画是一回事。 */
export const PICTURE_STROKE_KINDS = ["pen", "brush"];
export const PICTURE_STROKE_WIDTH_MIN = 0.5;
export const PICTURE_STROKE_WIDTH_MAX = 120;
export const PICTURE_STROKE_DEFAULT_WIDTH = 6;
/* 落点抽稀：比这个间距还近的点不收。手一抖在原地蹭一下会堆出一坨完全重合的点，
   除了把撤销栈和文件撑大没有任何用处。 */
export const PICTURE_STROKE_MIN_STEP = 1.2;
/* 橡皮判定再往外让这么多：笔迹细的时候指着它旁边一点也该擦得掉 */
export const PICTURE_ERASER_TOLERANCE = 4;
/* 场景块：一块真 3D 视口。块自身的宽高只是观察窗，里面的坐标是「地上的」——
   x/y 落在地面（y 越大越远），h 是立起来多高，z 是底面离地多高。
   单位仍是块内画面像素，和画面块同一套，摆东西不用换脑子。 */
export const SCENE_MIN_WIDTH = 240;
export const SCENE_MIN_HEIGHT = 180;
export const SCENE_DEFAULT_WIDTH = 720;
export const SCENE_DEFAULT_HEIGHT = 480;
/* 件数上限：three.js 一个 Mesh 一次 draw call，堆到几千个就靠合并实例，不是靠堆 Mesh */
export const SCENE_MAX_PARTS = 2000;
export const SCENE_MAX_SIZE = 20000;
/* 一件东西的轮廓点数上限：挤成棱柱要三角剖分，一个圆取到百来个点就够了，
   再多只是把三角剖分和撤销栈一起拖慢 */
export const SCENE_MAX_POLY_POINTS = 200;
/* 生图面板：一块本地出图的取景窗。出图一张要 30 秒，所以这块的重点是「等得明白」——
   面板上只摆提示词框和一颗开始，其余参数走默认，agent 想改直接写块字段。 */
export const GEN_MIN_WIDTH = 320;
export const GEN_MIN_HEIGHT = 360;
export const GEN_DEFAULT_WIDTH = 420;
export const GEN_DEFAULT_HEIGHT = 560;
/* 提示词给到 4000 字：够写一整段画面描述，又不至于把这份内容文件当笔记使 */
export const GEN_TEXT_MAX = 4000;
export const GEN_IMAGE_MIN = 256;
export const GEN_IMAGE_MAX = 2048;
/* 引擎要 32 的倍数，差一个就整条调度错位 */
export const GEN_IMAGE_STEP = 32;
export const GEN_IMAGE_DEFAULT = 1024;
export const GEN_STEPS_MIN = 1;
export const GEN_STEPS_MAX = 100;
export const GEN_STEPS_DEFAULT = 20;
export const GEN_CFG_MIN = 1.0;
export const GEN_CFG_MAX = 20.0;
export const GEN_CFG_DEFAULT = 6.0;
/* 出图那一档：auto 是「看连线自己定」——没接图就文生图，接一张当底图，接多张当参考。
   明写 t2i / i2i / edit 才能盖掉这个推断（画风锚点那种「只有一张但它是参考图」就得明写）。 */
export const GEN_MODES = ["auto", "t2i", "i2i", "edit"];
export const GEN_MODE_DEFAULT = "auto";
/* 图生图改多少：0 原样、1 全改。默认跟上游 sd_img_gen_params_init 的 0.75 一致 */
export const GEN_STRENGTH_MIN = 0;
export const GEN_STRENGTH_MAX = 1;
export const GEN_STRENGTH_DEFAULT = 0.75;
/* 每类面板拖角缩放的地板：拉到这里就不动了，免得块缩成看不见内容的一小坨 */
export const AUDIO_MIN_WIDTH = 160;
export const AUDIO_MIN_HEIGHT = 64;
export const FILE_MIN_WIDTH = 160;
export const FILE_MIN_HEIGHT = 56;
export const STICKY_MIN_WIDTH = 120;
export const STICKY_MIN_HEIGHT = 60;
export const NOTE_MIN_WIDTH = 160;
export const NOTE_MIN_HEIGHT = 120;

const SVG_NS = "http://www.w3.org/2000/svg";

/* 连线、直线、箭头的新默认色：跟着当前主题的强调色走，比死灰有精神，也不会和面板边框混成一片。
   主题变量常写成 hsl()，而块上存的是死值（切主题不回头改已画好的线），
   所以先借一个隐藏节点让浏览器解析成 rgb，再转成十六进制——右键「线条颜色」的取色器只认十六进制。 */
let colorProbe = null;

function accentStroke() {
  try {
    if (!colorProbe) {
      colorProbe = document.createElement("span");
      colorProbe.style.display = "none";
      document.body.append(colorProbe);
    }
    colorProbe.style.color = "";
    colorProbe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    const parts = getComputedStyle(colorProbe).color.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return DEFAULT_BORDER;
    return `#${parts
      .slice(0, 3)
      .map((v) => Math.round(Number(v)).toString(16).padStart(2, "0"))
      .join("")}`;
  } catch {
    return DEFAULT_BORDER;
  }
}

let seq = 0;

export function newId() {
  seq += 1;
  return `i${Date.now().toString(36)}${seq.toString(36)}`;
}

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

const SIDES = ["top", "right", "bottom", "left"];
const SIDE_NORMALS = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/* 手动折点上限：够摆出复杂的绕行，又不至于让 items.json 和手柄糊成一片 */
export const CONNECTOR_MAX_POINTS = 40;

export function normalizeConnectorPoints(raw) {
  if (!Array.isArray(raw)) return [];
  const points = [];
  for (const entry of raw) {
    const x = Number(entry?.x);
    const y = Number(entry?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
    if (points.length >= CONNECTOR_MAX_POINTS) break;
  }
  return points;
}

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
  const item = normalizeBlock(raw);
  /* 锁是块自己的状态，连线不参与 */
  if (item && item.type !== "connector" && raw.locked === true) item.locked = true;
  return item;
}

function normalizeBlock(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const type = raw.type;
  const base = { id: raw.id, type };
  if (type === "connector") {
    const from = normalizeEnd(raw.from);
    const to = normalizeEnd(raw.to);
    if (!from || !to) return null;
    const points = normalizeConnectorPoints(raw.points);
    /* 默认不开折点；老数据里有折点就自动算打开 */
    const bend = raw.bend === true || points.length > 0;
    return {
      ...base,
      from,
      to,
      shape: raw.shape === "curve" ? "curve" : "elbow",
      arrow: raw.arrow === "none" ? "none" : raw.arrow === "both" ? "both" : "end",
      color: typeof raw.color === "string" && raw.color ? raw.color : accentStroke(),
      label: typeof raw.label === "string" ? raw.label : "",
      ...(bend ? { bend: true } : {}),
      ...(points.length ? { points } : {}),
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
      borderWidth: Math.min(BORDER_MAX_WIDTH, Math.max(0, Math.round(num(raw.borderWidth, BORDER_DEFAULT_WIDTH)))),
      radius: Math.max(0, Math.round(num(raw.radius))),
      /* 容器：框里那些块跟着它一起走（成员按几何算，不另存名单） */
      ...(type === "rect" && raw.container === true ? { container: true } : {}),
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
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : accentStroke(),
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
      borderWidth: Math.min(BORDER_MAX_WIDTH, Math.max(0, Math.round(num(raw.borderWidth, BORDER_DEFAULT_WIDTH)))),
      radius: Math.max(0, Math.round(num(raw.radius, TEXT_DEFAULT_RADIUS))),
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
      borderWidth: Math.min(BORDER_MAX_WIDTH, Math.max(0, Math.round(num(raw.borderWidth, BORDER_DEFAULT_WIDTH)))),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
      /* 引用态：src 是原图绝对路径，空间里没有副本 */
      linked: raw.linked === true,
      z: layerOf(raw),
    };
  }
  if (type === "audio") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(AUDIO_MIN_WIDTH, num(raw.w, AUDIO_DEFAULT_WIDTH)),
      h: Math.max(AUDIO_MIN_HEIGHT, num(raw.h, AUDIO_DEFAULT_HEIGHT)),
      src: typeof raw.src === "string" ? raw.src : "",
      name: typeof raw.name === "string" ? raw.name : "",
      linked: raw.linked === true,
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
      /* 引用态：src 是原片的绝对路径，空间里不存副本 */
      linked: raw.linked === true,
      /* sized：已经按视频真实比例定过一次大小，之后尊重用户手拉的尺寸 */
      sized: raw.sized === true,
      /* 转出来的 AAC 音轨副本（空间目录里的相对路径），没有就是空串 */
      audioRel: typeof raw.audioRel === "string" ? raw.audioRel : "",
      /* 音量是定下来就记住的：0 表示静，1 表示原声 */
      volume: Math.min(1, Math.max(0, num(raw.volume, 1))),
      z: layerOf(raw),
    };
  }
  if (type === "sticky") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(STICKY_MIN_WIDTH, num(raw.w, STICKY_DEFAULT_WIDTH)),
      h: Math.max(STICKY_MIN_HEIGHT, num(raw.h, STICKY_DEFAULT_HEIGHT)),
      text: typeof raw.text === "string" ? raw.text : "",
      color: typeof raw.color === "string" && raw.color ? raw.color : STICKY_DEFAULT_COLOR,
      textColor:
        typeof raw.textColor === "string" && raw.textColor ? raw.textColor : STICKY_DEFAULT_TEXT,
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : "",
      borderWidth: Math.min(
        BORDER_MAX_WIDTH,
        Math.max(0, Math.round(num(raw.borderWidth, CARD_DEFAULT_BORDER_WIDTH))),
      ),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
      z: layerOf(raw),
    };
  }
  if (type === "picture") {
    /* 素材表先归一化：cmds 里的 use 要靠它才知道 ref 存不存在 */
    const symbols = normalizePictureSymbols(raw.symbols).symbols;
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(PICTURE_MIN_WIDTH, num(raw.w, PICTURE_DEFAULT_WIDTH)),
      h: Math.max(PICTURE_MIN_HEIGHT, num(raw.h, PICTURE_DEFAULT_HEIGHT)),
      cmds: normalizePictureCmds(raw.cmds, PICTURE_MAX_CMDS, { symbols }).cmds,
      symbols,
      /* 关掉的图层：盘上写歪了就当全开，别让一个坏数组把整块画判成坏数据 */
      hidden: normalizeHidden(raw.hidden).hidden || [],
      /* 光源写歪了同样当「没打光」：一块坏数据不该把已经画好的整幅判死 */
      light: normalizeLight(raw.light).light || null,
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : DEFAULT_BORDER,
      /* 画纸底色：块自己的 fillColor 会被边框样式吃掉，底色单独记一笔 */
      paperColor: colorOr(raw.paperColor, ""),
      borderWidth: Math.min(
        BORDER_MAX_WIDTH,
        Math.max(0, Math.round(num(raw.borderWidth, CARD_DEFAULT_BORDER_WIDTH))),
      ),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
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
      w: Math.max(NOTE_MIN_WIDTH, num(raw.w, NOTE_DEFAULT_WIDTH)),
      h: Math.max(NOTE_MIN_HEIGHT, num(raw.h, NOTE_DEFAULT_HEIGHT)),
      path: typeof raw.path === "string" ? raw.path : "",
      name: typeof raw.name === "string" ? raw.name : "",
      source: typeof raw.source === "string" ? raw.source : "",
      /* 引用态：path 是原 .md 的绝对路径，source 只是显示缓存；
         写回时按 sourceFormat / sourceCrlf 还原成原来那份字节 */
      linked: raw.linked === true,
      sourceFormat: typeof raw.sourceFormat === "string" ? raw.sourceFormat : "utf8",
      sourceCrlf: raw.sourceCrlf === true,
      assets,
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : "",
      fillColor: typeof raw.fillColor === "string" ? raw.fillColor : "",
      borderWidth: Math.min(
        BORDER_MAX_WIDTH,
        Math.max(0, Math.round(num(raw.borderWidth, CARD_DEFAULT_BORDER_WIDTH))),
      ),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
      z: layerOf(raw),
    };
  }
  if (type === "file") {
    const fileExt = (typeof raw.ext === "string" ? raw.ext : "").toLowerCase();
    const isDocx = fileExt === "docx";
    const isXlsx = fileExt === "xlsx";
    const isPptx = fileExt === "pptx";
    const big = isDocx || isXlsx || isPptx;
    const bigW = isDocx ? DOCX_DEFAULT_WIDTH : isXlsx ? XLSX_DEFAULT_WIDTH : PPTX_DEFAULT_WIDTH;
    const bigH = isDocx ? DOCX_DEFAULT_HEIGHT : isXlsx ? XLSX_DEFAULT_HEIGHT : PPTX_DEFAULT_HEIGHT;
    const bigMinW = isDocx ? DOCX_MIN_WIDTH : isXlsx ? XLSX_MIN_WIDTH : PPTX_MIN_WIDTH;
    const bigMinH = isDocx ? DOCX_MIN_HEIGHT : isXlsx ? XLSX_MIN_HEIGHT : PPTX_MIN_HEIGHT;
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(big ? bigMinW : FILE_MIN_WIDTH, num(raw.w, big ? bigW : FILE_DEFAULT_WIDTH)),
      h: Math.max(big ? bigMinH : FILE_MIN_HEIGHT, num(raw.h, big ? bigH : FILE_DEFAULT_HEIGHT)),
      src: typeof raw.src === "string" ? raw.src : "",
      name: typeof raw.name === "string" ? raw.name : "",
      ext: typeof raw.ext === "string" ? raw.ext : "",
      size: Math.max(0, num(raw.size)),
      text: raw.text === true,
      /* 引用态 src 就是原文件绝对路径，空间 files/ 里没有副本 */
      linked: raw.linked === true,
      /* PDF 块读到哪儿是这块自己的状态：第几页 + 这一页滚过去几成，重开接着读 */
      page: Math.max(1, Math.trunc(num(raw.page, 1))),
      pageFrac: Math.min(1, Math.max(0, num(raw.pageFrac, 0))),
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : "",
      fillColor: typeof raw.fillColor === "string" ? raw.fillColor : "",
      borderWidth: Math.min(
        BORDER_MAX_WIDTH,
        Math.max(0, Math.round(num(raw.borderWidth, CARD_DEFAULT_BORDER_WIDTH))),
      ),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
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
      /* 读到第几章是这块自己的状态，重开空间接着上次那页 */
      chapter: Math.max(0, Math.trunc(num(raw.chapter))),
      z: layerOf(raw),
    };
  }
  if (type === "scene") {
    const parts = normalizeSceneParts(raw.parts).parts;
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(SCENE_MIN_WIDTH, num(raw.w, SCENE_DEFAULT_WIDTH)),
      h: Math.max(SCENE_MIN_HEIGHT, num(raw.h, SCENE_DEFAULT_HEIGHT)),
      parts,
      /* 机位写歪了当「没定过」：让渲染器按内容自己框一个，比拿一堆 NaN 去摆相机好 */
      camera: normalizeSceneCamera(raw.camera),
      /* 没挂光就是平光：和画面块同一个约定，坏数据不许把整块判死 */
      light: normalizeLight(raw.light).light || null,
      groundColor: colorOr(raw.groundColor, ""),
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : DEFAULT_BORDER,
      borderWidth: Math.min(
        BORDER_MAX_WIDTH,
        Math.max(0, Math.round(num(raw.borderWidth, CARD_DEFAULT_BORDER_WIDTH))),
      ),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
      z: layerOf(raw),
    };
  }
  if (type === "gen") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(GEN_MIN_WIDTH, num(raw.w, GEN_DEFAULT_WIDTH)),
      h: Math.max(GEN_MIN_HEIGHT, num(raw.h, GEN_DEFAULT_HEIGHT)),
      prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, GEN_TEXT_MAX) : "",
      negative: typeof raw.negative === "string" ? raw.negative.slice(0, GEN_TEXT_MAX) : "",
      imageW: snapGenSize(num(raw.imageW, GEN_IMAGE_DEFAULT)),
      imageH: snapGenSize(num(raw.imageH, GEN_IMAGE_DEFAULT)),
      steps: Math.round(clamp(num(raw.steps, GEN_STEPS_DEFAULT), GEN_STEPS_MIN, GEN_STEPS_MAX)),
      cfg: clamp(num(raw.cfg, GEN_CFG_DEFAULT), GEN_CFG_MIN, GEN_CFG_MAX),
      /* -1 在引擎里是「每张换一个」的哨兵；认不出别的数一律退回它 */
      seed: Number.isFinite(raw.seed) && raw.seed >= 0 ? Math.trunc(raw.seed) : -1,
      mode: GEN_MODES.includes(raw.mode) ? raw.mode : GEN_MODE_DEFAULT,
      strength: clamp(num(raw.strength, GEN_STRENGTH_DEFAULT), GEN_STRENGTH_MIN, GEN_STRENGTH_MAX),
      /* 最近那一张，记的是 <空间>/images/ 里的相对路径；还没出过图是空串 */
      src: typeof raw.src === "string" ? raw.src : "",
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : DEFAULT_BORDER,
      borderWidth: Math.min(
        BORDER_MAX_WIDTH,
        Math.max(0, Math.round(num(raw.borderWidth, CARD_DEFAULT_BORDER_WIDTH))),
      ),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
      z: layerOf(raw),
    };
  }
  return null;
}

/* 便签和笔记的正文不归 items.json 管：一张便签是 <空间>/stickies/<块id>.json，
   一篇笔记是 <空间>/notes/<块id>.md，一幅画面是 <空间>/pictures/<块id>.json。
   运行时对象上那些字段只是从文件里读回来的缓存，
   存回去就成一份数据两处摆，改一处漏一处。 */
export function toPersisted(item) {
  if (item.type === "sticky") {
    /* 正文在 stickies/ 里，items.json 只留位置、锁和边框规格 */
    return {
      id: item.id,
      type: item.type,
      x: item.x,
      y: item.y,
      z: item.z,
      locked: item.locked === true,
      borderWidth: item.borderWidth,
      radius: item.radius,
    };
  }
  if (item.type === "note") {
    const { source, ...rest } = item;
    return rest;
  }
  if (item.type === "picture") {
    /* 手绘一笔就上百个点，整幅塞进 items.json 会把这个空间的读写一起拖慢 */
    const { cmds, ...rest } = item;
    return rest;
  }
  if (item.type === "scene") {
    /* 同理：一件东西的底面就有一圈坐标点，那份东西列表只认 scenes/<块id>.json */
    const { parts, ...rest } = item;
    return rest;
  }
  if (item.type === "gen") {
    /* 同理：提示词和参数只认 genpanels/<块id>.json。
       出的那张图不在里面——它和 img 块一样是 images/ 里的真文件，路径记在块上，
       删块、复制才有个统一的按引用清的办法 */
    const { prompt, negative, imageW, imageH, steps, cfg, seed, ...rest } = item;
    return rest;
  }
  return item;
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
    borderWidth: BORDER_DEFAULT_WIDTH,
    radius: 0,
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
    borderColor: accentStroke(),
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
    color: "#000000",
    fillColor: "#ffffff",
    borderColor: DEFAULT_BORDER,
    h: 0,
    minH: Math.max(0, minH),
    fontSize: 14,
    bordered: true,
    borderWidth: BORDER_DEFAULT_WIDTH,
    radius: TEXT_DEFAULT_RADIUS,
  };
}

/* 图片块两种存在方式：拷贝态 src 是空间 images/ 里的相对路径，引用态是原图绝对路径。 */
export function makeImage(x, y, w, h, src, linked = false) {
  return {
    id: newId(),
    type: "image",
    x,
    y,
    w,
    h,
    src,
    linked: Boolean(linked),
    borderColor: "",
    borderWidth: BORDER_DEFAULT_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
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

/* 视频块有两种存在方式：拷贝进来的 src 是空间里的相对路径（linked=false），
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
    volume: 1,
  };
}

/* 画面块：正文就是那份指令列表，跟着 items.json 一起走（不像便签另存一份文件）。
   坐标是块内的画面坐标，和块自身的左上角同原点，可以出现负数。 */
export function makePicture(x, y, w = PICTURE_DEFAULT_WIDTH, h = PICTURE_DEFAULT_HEIGHT) {
  return {
    id: newId(),
    type: "picture",
    x,
    y,
    w,
    h,
    cmds: [],
    symbols: {},
    hidden: [],
    /* 一套光先不挂：没写 light 的块，渲染输出必须和今天逐字相同 */
    light: null,
    paperColor: "",
    borderColor: DEFAULT_BORDER,
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 底面那一圈点：poly 是墙、roof 是檐，写法一样，所以收点的活儿共用一份。
   不认贝塞尔边（写 c1/c2 是要弧，这儿只会按折线走，等于悄悄把弧拉直）；
   相邻重合、首尾闭合重复的点都收掉（那是零长的墙，挤出来的面片会歪）。 */
function sceneRing(label, raw) {
  const got = normalizePicturePoints(raw.points, SCENE_MAX_POLY_POINTS);
  if (got.why) return { why: `${label} 的 points 读不出来：${got.why}` };
  if (got.points.some((p) => p.c1 || p.c2)) {
    return { why: `${label} 的底面只吃折线，点里别写 c1 / c2（要圆弧就多取几个点）` };
  }
  const points = [];
  for (const p of got.points) {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    points.push(p);
  }
  if (points.length > 2) {
    const [a, b] = [points[0], points[points.length - 1]];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) points.pop();
  }
  if (points.length < 3) {
    return { why: `${label} 的底面至少要 3 个不重复的点才围得出面（现在 ${points.length} 个）` };
  }
  return { points };
}

/* 场景里的一件东西。落点永远是它底面那个点，h 往上立起来。
   box 是长方体；poly 是把一条闭合平面轮廓沿 h 挤成真棱柱——任意形状的房子、
   带天井的院落、L 形的街面都靠它；roof 是同一圈底面立成一个屋顶。
   轮廓的点相对 (x, y)，rotate 绕 (x, y) 转。
   坐标是地上的：x 左右、y 往画面里去（越大越远）、z 底面离地多高、h 立起来多高。 */
function normalizeScenePart(raw) {
  if (!raw || typeof raw !== "object") return { why: "不是对象" };
  /* 先认 op 再挑毛病：一件「sphere」报「h 得是正数」，写的人会被带去改 h，改完还是不认 */
  if (raw.op !== "box" && raw.op !== "poly" && raw.op !== "roof") {
    return { why: `op「${String(raw.op).slice(0, 12)}」不认：现在只有 "box"（长方体）、"poly"（底面轮廓 + h 挤成真棱柱）、"roof"（底面轮廓 + h 立成屋顶）` };
  }
  /* 落点：永远指底面那个中心点，h 从这儿往上立起来。轮廓里的点相对它，rotate 绕它转。 */
  const foot = { x: num(raw.x), y: num(raw.y), z: Math.max(0, num(raw.z)) };
  const h = Number(raw.h);
  if (!(h > 0) || h > SCENE_MAX_SIZE) {
    return { why: `h（立起来多高）得是正数、不超过 ${SCENE_MAX_SIZE}（现在是 ${String(raw.h).slice(0, 12)}）` };
  }
  const rotate = Number(raw.rotate);
  const body = {
    h,
    rotate: Number.isFinite(rotate) ? ((rotate % 360) + 360) % 360 : 0,
    color: colorOr(raw.color, ""),
    name: typeof raw.name === "string" ? raw.name : "",
  };
  const rect = () => {
    const w = Number(raw.w);
    const d = Number(raw.d);
    /* 尺寸写歪（0 / 负 / 不是数）整件丢掉：一个零高的长方体不是「一片地」，是画错了 */
    if (!(w > 0) || !(d > 0) || w > SCENE_MAX_SIZE || d > SCENE_MAX_SIZE) {
      return { why: `${raw.op} 的 w / d 得是正数、不超过 ${SCENE_MAX_SIZE}（现在 w=${String(raw.w).slice(0, 12)} d=${String(raw.d).slice(0, 12)}）` };
    }
    return { w, d };
  };
  if (raw.op === "box") {
    const got = rect();
    if (got.why) return got;
    return { part: { op: "box", ...foot, w: got.w, d: got.d, ...body } };
  }
  if (raw.op === "poly") {
    const got = sceneRing("poly", raw);
    if (got.why) return got;
    return { part: { op: "poly", ...foot, points: got.points, ...body } };
  }
  /* 屋顶：底面一圈 + h，脊长 ridge 决定它是哪一种——
     ridge = w 是双坡（悬山 / 硬山），0 < ridge < w 是四阿 / 庑殿，ridge = 0 是四角攒尖；
     底面写成 points（八角、六角）就是那个多边形的攒尖。一套几何全包，不用三种 op。 */
  if (raw.points != null) {
    const got = sceneRing("roof", raw);
    if (got.why) return got;
    if (raw.ridge != null) {
      return { why: "roof 的底面写成 points 就是攒尖（顶上收成一个尖），没有脊长可写" };
    }
    return { part: { op: "roof", ...foot, points: got.points, ...body } };
  }
  const got = rect();
  if (got.why) return got;
  const ridge = num(raw.ridge, got.w);
  if (!(ridge >= 0) || ridge > got.w) {
    return { why: `roof 的 ridge（脊长）得在 0 ~ w=${got.w} 之间：0 是攒尖、${got.w} 是双坡、中间是四阿（现在是 ${String(raw.ridge).slice(0, 12)}）` };
  }
  return { part: { op: "roof", ...foot, w: got.w, d: got.d, ridge, ...body } };
}

export function normalizeSceneParts(value) {
  const list = Array.isArray(value) ? value : [];
  const parts = [];
  const dropped = [];
  for (const [k, raw] of list.entries()) {
    if (parts.length >= SCENE_MAX_PARTS) {
      dropped.push({ at: k, why: `场景里的东西最多 ${SCENE_MAX_PARTS} 件，多出来的没画` });
      continue;
    }
    const got = normalizeScenePart(raw);
    if (got.part) parts.push(got.part);
    /* 说清是第几件、哪儿不对：静默少一栋楼，下一轮根本不知道是谁写歪了 */
    else dropped.push({ at: k, why: `第 ${k} 件不认：${got.why}` });
  }
  return { parts, dropped };
}

/* 机位：绕着注视点转的球坐标，存角度不存相机位置——改窗口大小、挪块，机位都得稳。
   写歪了返回 null，让渲染器按内容自己框一个。 */
export function normalizeSceneCamera(value) {
  if (!value || typeof value !== "object") return null;
  const azim = Number(value.azim);
  const elev = Number(value.elev);
  const dist = Number(value.dist);
  if (!Number.isFinite(azim) || !Number.isFinite(elev) || !(dist > 0)) return null;
  return {
    azim: ((azim % 360) + 360) % 360,
    elev: clamp(elev, 2, 88),
    dist: clamp(dist, 1, SCENE_MAX_SIZE * 4),
    tx: num(value.tx),
    ty: num(value.ty),
    tz: Math.max(0, num(value.tz)),
    fov: clamp(num(value.fov, 45), 8, 100),
  };
}

/* 场景块：一块真 3D 视口。刚建出来是空的——地面由渲染器垫，相机按内容自动框。 */
export function makeScene(x, y, w = SCENE_DEFAULT_WIDTH, h = SCENE_DEFAULT_HEIGHT) {
  return {
    id: newId(),
    type: "scene",
    x,
    y,
    w,
    h,
    parts: [],
    camera: null,
    light: null,
    groundColor: "",
    borderColor: DEFAULT_BORDER,
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 出图尺寸贴到 32 的倍数上：引擎的 latent 按 8 下采样、再 2×2 合块，差一个数整条调度就错位。 */
export function snapGenSize(value) {
  const clamped = clamp(Math.round(value), GEN_IMAGE_MIN, GEN_IMAGE_MAX);
  return Math.round(clamped / GEN_IMAGE_STEP) * GEN_IMAGE_STEP;
}

/* 生图面板：刚建出来没图，提示词也空着——等用户在框里写第一句。 */
export function makeGen(x, y, w = GEN_DEFAULT_WIDTH, h = GEN_DEFAULT_HEIGHT) {
  return {
    id: newId(),
    type: "gen",
    x,
    y,
    w,
    h,
    prompt: "",
    negative: "",
    imageW: GEN_IMAGE_DEFAULT,
    imageH: GEN_IMAGE_DEFAULT,
    steps: GEN_STEPS_DEFAULT,
    cfg: GEN_CFG_DEFAULT,
    seed: -1,
    mode: GEN_MODE_DEFAULT,
    strength: GEN_STRENGTH_DEFAULT,
    src: "",
    borderColor: DEFAULT_BORDER,
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 颜色直接进 svg 属性，只认 #rgb / #rrggbb / #rrggbbaa，其余一律当「没填」处理 */
function colorOr(value, fallback) {
  return typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())
    ? value.trim()
    : fallback;
}

/* 颜色被丢了必须说是哪一项、原来写的什么：agent 只看到「少了一块东西」，
   猜不出是 #FF00 这种手滑。 */
function colorIssue(value, name) {
  if (value == null || value === "") return `${name} 没给`;
  return `${name}「${String(value).slice(0, 24)}」不合法`;
}

const COLOR_RULE = "颜色只认 #rgb / #rrggbb / #rrggbbaa";
const OPS_RULE =
  "只有 rect / poly / line / stroke / text / group / use / image 八种（描边的线用 line，闭合的形用 poly，手绘或一笔一宽的墨迹用 stroke，摆一个已定义的素材用 use，垫一张位图参考用 image）";
/* 素材表：同一支笔、同一片瓦要摆几百遍，一条条写既写不下也画不动 */
const SYMBOL_RULE =
  '素材先定义一次 symbols:{"名字":{cmds:[...],ox,oy,w,h}}（ox/oy 是落点，w/h 是声明的框，只有 tile 平铺非要不可），之后 {op:"use",ref:"名字",x,y,rotate,scale} 摆一份；同一个素材想要几套样子，就给要单独开关的那几笔起 name（想一起开关就包一层 group 起名）、再标 variants:["站","坐"]，用 use 的 variant 挑一套、hide 关掉某一层';

/* 一处「漆」：填色和描边既可以是一个颜色，也可以是一个渐变。
   渐变写坏了必须整条丢掉并说清坏在哪一步——悄悄退成「没填」，
   调用方看见的是一块凭空少掉的填充，比报错更难查。 */
const GRADIENT_TYPES = ["linear", "radial"];
const GRADIENT_RULE =
  '渐变写成 {type:"linear",x1,y1,x2,y2,stops:[{at,color},...]} 或 {type:"radial",cx,cy,r,stops}：at 是 0~1 的位置，坐标默认按这块形状包围盒的比例（0~1），要按块内画面像素就加 units:"user"';

const ratio = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : fallback;
};

function normalizeGradientStops(raw, name) {
  if (!Array.isArray(raw)) {
    return { why: `${name} 的渐变 stops ${raw == null ? "没给" : `不是数组（是 ${typeof raw}）`}——至少要 2 个 {at,color}` };
  }
  const stops = [];
  for (const entry of raw) {
    const color = colorOr(entry?.color, "");
    if (!color) return { why: `${name} 的渐变里有个色标${colorIssue(entry?.color, "color")}——${COLOR_RULE}` };
    const at = Number(entry?.at);
    if (!Number.isFinite(at)) return { why: `${name} 的渐变里有个色标没写 at（0~1 的色标位置）` };
    stops.push({ at: Math.round(clamp(at, 0, 1) * 1000) / 1000, color });
  }
  /* svg 对乱序的 offset 是「就地夹住」，看着就是一段平色：先按 at 排好再交给它 */
  stops.sort((a, b) => a.at - b.at);
  return { stops };
}

function normalizeGradient(raw, name) {
  const type = GRADIENT_TYPES.includes(String(raw.type ?? "").trim()) ? String(raw.type).trim() : "";
  if (!type) {
    return {
      why: `${name} 的渐变${raw.type == null ? "没写 type" : ` type「${String(raw.type).slice(0, 16)}」不认识`}——只有 linear / radial 两种，${GRADIENT_RULE}`,
    };
  }
  const user = raw.units === "user";
  const pick = user ? coord : ratio;
  const geometry =
    type === "linear"
      ? { x1: pick(raw.x1, 0), y1: pick(raw.y1, 0), x2: pick(raw.x2, 1), y2: pick(raw.y2, 0) }
      : { cx: pick(raw.cx, 0.5), cy: pick(raw.cy, 0.5), r: pick(raw.r, 0.5) };
  if (user) {
    /* 按画面像素画渐变就没有「顺手一个默认值」可言：少写一个数就会退成包围盒比例，
       那种渐变看上去像画错了，不如直接说缺了哪几个。 */
    const missing = Object.keys(geometry).filter((key) => !Number.isFinite(Number(raw[key])));
    if (missing.length) {
      return { why: `${name} 的渐变写了 units:"user"（按块内画面像素），那 ${missing.join(" / ")} 就得都写成像素数` };
    }
  }
  const result = normalizeGradientStops(raw.stops, name);
  if (result.why) return result;
  if (result.stops.length < 2) {
    return { why: `${name} 的渐变只有 ${result.stops.length} 个色标，至少 2 个才有过渡——${GRADIENT_RULE}` };
  }
  /* 存下来的字段名和写进来的必须是同一个（type）：picture_draw 的 append
     会把「已有的 + 新发的」整表再归一化一遍，存读两套拼写就等于每追加一次，
     画布上已有的渐变被当成坏数据丢掉。 */
  return { paint: { type, units: user ? "user" : "bbox", ...geometry, stops: result.stops } };
}

/* 图案填充：反复铺的漆。斜线 / 方格 / 点阵自带画样，tile 拿一个素材当平铺单元
   （瓦、砖、鱼鳞、编木的纹样都靠它）。存下来的拼写必须和认的拼写一致：
   append 会把整表再归一化一遍，对不上就每追加一次丢一片。 */
const PATTERN_TYPES = ["hatch", "grid", "dots", "tile"];
const PATTERN_RULE =
  '图案漆写成 {pattern:"hatch"|"grid"|"dots",gap,angle,color,width} 或 {pattern:"tile",ref:素材名,dx,dy,angle}：gap 是间距（画面像素），angle 是整套纹样的转角，width 是线宽（点阵里是点的直径）';

/* tile 的格子尺寸：没写就拿素材声明的框，两个都没有只能报错——
   不知道一格多大根本铺不出东西，按 0 铺等于什么都没画。 */
function patternSpan(raw, declared, ref, key, name) {
  const given = Number(raw);
  if (Number.isFinite(given) && given > 0) return { value: Math.round(clamp(given, 1, 4000)) };
  const own = Number(declared);
  if (Number.isFinite(own) && own > 0) return { value: Math.round(clamp(own, 1, 4000)) };
  return {
    why: `${name} 的 tile 铺不出格子：${key} 没给，素材「${ref.slice(0, 32)}」也没声明 w / h——${PATTERN_RULE}`,
  };
}

/* 图案的底色：纹样是画在格子上的线，底色是先铺满格子的一张漆。
   没写就别给 paint 添一个空字段——老数据的形状得保持原样。 */
function patternBackground(raw, name) {
  if (raw.background == null || raw.background === "") return { value: "" };
  if (!colorOr(raw.background, "")) {
    return { why: `${name} 的图案${colorIssue(raw.background, "background")}——${COLOR_RULE}` };
  }
  return { value: colorOr(raw.background, "") };
}

function normalizePattern(raw, name, symbols) {
  const kind = raw.pattern == null ? "" : String(raw.pattern).trim();
  if (!PATTERN_TYPES.includes(kind)) {
    return {
      why: `${name} 的图案${raw.pattern == null ? "没写 pattern" : ` pattern「${String(raw.pattern).slice(0, 16)}」不认识`}——只有 ${PATTERN_TYPES.join(" / ")} 四种，${PATTERN_RULE}`,
    };
  }
  const angle = Math.round(clamp(Number(raw.angle) || 0, -180, 180));
  const bg = patternBackground(raw, name);
  if (bg.why) return bg;
  if (kind === "tile") {
    const ref = raw.ref == null ? "" : String(raw.ref).trim();
    /* fatal：素材名 / 变体名 / 图层名写错，曾经只是把这一条悄悄丢掉、只在 dropped 里说一声，
       于是「一个 variant 拼错 → 十七个小人全没了」这种事要看回渲染才发现。名字错 = 整笔请求失败，
       并把这块里现在有的名字列回去（和 picture_layers 查层名是同一套口径）。 */
    if (!ref) return { fatal: true, why: `${name} 的 tile 没写 ref——平铺单元得点名一个素材，${PATTERN_RULE}` };
    const symbol = symbols ? symbols[ref] : null;
    if (!symbol) {
      const known = symbols ? Object.keys(symbols) : [];
      return {
        fatal: true,
        why: `${name} 的 tile 找不着素材「${ref.slice(0, 32)}」${
          known.length ? `，现在有名的是：${known.slice(0, 8).join(" / ")}` : "，这块还没定义任何素材"
        }——素材得和这条指令在同一个请求里发来，${SYMBOL_RULE}`,
      };
    }
    const dx = patternSpan(raw.dx, symbol.w, ref, "dx", name);
    if (dx.why) return dx;
    const dy = patternSpan(raw.dy, symbol.h, ref, "dy", name);
    if (dy.why) return dy;
    const paint = { type: "pattern", pattern: "tile", ref, dx: dx.value, dy: dy.value, angle };
    if (bg.value) paint.background = bg.value;
    return { paint };
  }
  if (raw.color != null && raw.color !== "" && !colorOr(raw.color, "")) {
    return { why: `${name} 的图案${colorIssue(raw.color, "color")}——${COLOR_RULE}` };
  }
  const paint = {
    type: "pattern",
    pattern: kind,
    gap: Math.round(clamp(Number(raw.gap) || 8, 1, 4000) * 10) / 10,
    angle,
    color: colorOr(raw.color, "") || "#000000",
    width: Math.round(clamp(Number(raw.width) || 1, 0.2, 200) * 10) / 10,
  };
  if (bg.value) paint.background = bg.value;
  return { paint };
}

/* 一处漆：颜色、渐变、图案三种写法。图案只看 pattern 字段，渐变只看 type，
   两边互不打扰，才不会把 {pattern:"dots"} 报成「渐变没写 type」。 */
function paintOf(raw, name, state) {
  if (raw == null || raw === "") return { paint: "" };
  if (typeof raw === "string") {
    const color = colorOr(raw, "");
    return color ? { paint: color } : { why: `${name}「${raw.slice(0, 24)}」不合法——${COLOR_RULE}` };
  }
  if (typeof raw === "object") {
    return raw.pattern == null ? normalizeGradient(raw, name) : normalizePattern(raw, name, state?.symbols);
  }
  return { why: `${name} 得是一个颜色串、一个渐变对象或一个图案对象（现在是一条 ${typeof raw}）——${GRADIENT_RULE}；${PATTERN_RULE}` };
}

/* 报错文案里把渐变说成「渐变对象」：把 JS 对象的 [object Object] 打给用户等于没说 */
function paintIssue(value, name) {
  if (value == null || value === "") return `${name} 没给`;
  return `${name}「${typeof value === "object" ? "渐变或图案对象" : String(value).slice(0, 24)}」不合法`;
}

/* 柔边和叠色：远景要虚、物体要落在纸上、火把要自己发亮，三件事都靠滤镜；
   一层淡墨叠出厚度靠混合模式。和渐变一样，写坏了整条丢掉——半套滤镜糊在屏幕上
   比少一笔更难查。存下来的拼写必须和认的拼写一致（append 会把整表再归一化一遍）。 */
const FILTER_TYPES = ["blur", "shadow", "glow", "gray", "bright", "contrast"];
/* 调色那三种只吃一个倍数，不给就是「拉满 / 原样」；半径那三种没有默认可言，
   r=0 等于没挂滤镜，不如逼调用方写一个数。 */
const FILTER_TONE = { gray: [0, 1, 1], bright: [0.05, 5, 1], contrast: [0.05, 5, 1] };
const BLEND_MODES = [
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];
const FILTER_RULE =
  '滤镜写成 {type:"blur",r}（化开边缘、远景虚）、{type:"shadow",dx,dy,r,color}（落在纸上的投影）、{type:"glow",r,color}（自己发亮），或调色的 {type:"gray"|"bright"|"contrast",k}（去色 / 提亮 / 加对比，k 是倍数）：r 是化开的半径（块内画面像素，0.5~200），dx/dy 是投影往哪偏、可以都不写（这块打了光就跟着光倒向背光那边，没打光就是 0）；投影还可以写 h（这东西在画里立起多高，块内画面像素）：写了 h 的不是把剪影挪一份，而是从它的脚底拖出一片真正的落影，影长 = h / tan(太阳高度)，太阳越低影子越长，越往末梢越淡（那道渐变不用你自己叠），边是硬的（要羽化再写 r），前提是这块打了光（picture_light），没光就没有影子的方向；几样要一起用就写成数组，按序生效';
const BLEND_RULE = `混合模式只有 ${BLEND_MODES.join(" / ")}：叠墨用 multiply、叠光用 screen，不写就是正常盖上去`;

/* 滤镜只可能写在 filter 这一个字段上，不像漆还要分清 fill / stroke，
   所以报错直接说「滤镜」，不必把字段名传来传去。 */
function normalizeFilter(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      why: `滤镜得是一个对象（现在是${
        Array.isArray(raw) ? "一条数组" : raw === null ? " null" : ` ${typeof raw}「${String(raw).slice(0, 16)}」`
      }）——${FILTER_RULE}`,
    };
  }
  const type = raw.type == null ? "" : String(raw.type).trim();
  if (!FILTER_TYPES.includes(type)) {
    return {
      why: `滤镜${raw.type == null ? "没写 type" : ` type「${String(raw.type).slice(0, 16)}」不认识`}——只有 ${FILTER_TYPES.join(" / ")} 几种，${FILTER_RULE}`,
    };
  }
  const tone = FILTER_TONE[type];
  if (tone) {
    const [min, max, dflt] = tone;
    const given = raw.k == null ? dflt : Number(raw.k);
    if (!Number.isFinite(given)) return { why: `${type} 的 k 得是一个倍数（${min}~${max}，不给是 ${dflt}）——${FILTER_RULE}` };
    return { filter: { type, k: Math.round(clamp(given, min, max) * 100) / 100 } };
  }
  /* h 只属于 shadow：它说的是「这东西立起来多高」，影子该拖多远由它和太阳高度一起算。
     给了 h 的可以不写 r——按高度给一档羽化，越高的东西影子末梢越糊。 */
  const hGiven = type === "shadow" && raw.h != null && raw.h !== "";
  const h = hGiven ? Number(raw.h) : NaN;
  if (hGiven && !(Number.isFinite(h) && h > 0)) {
    return {
      why: `shadow 的 h 得是一个正数（这东西立起来多高，块内画面像素；现在写的是「${String(raw.h).slice(0, 16)}」）——${FILTER_RULE}`,
    };
  }
  const given = Number(raw.r);
  if (!Number.isFinite(given) && !Number.isFinite(h)) {
    return { why: `${type} 没写 r（化开的半径，块内画面像素）——${FILTER_RULE}` };
  }
  /* 写了 h 的默认硬边（r=0）：低太阳的落影本来就是一道清楚的边，糊了反而像一团雾。
     没写 h 的那种贴在纸上的淡影照旧，最软也要 0.5。 */
  const r = Math.round(clamp(Number.isFinite(given) ? given : 0, hGiven ? 0 : 0.5, 200) * 10) / 10;
  if (type === "blur") return { filter: { type: "blur", r } };
  if (raw.color != null && raw.color !== "" && !colorOr(raw.color, "")) {
    return { why: `滤镜${colorIssue(raw.color, "color")}——${COLOR_RULE}` };
  }
  /* 投影默认半透的黑、发光默认暖黄：一个是不该给东西凭空上色，
     一个是火把、灯笼、窗里的灯才是发光最常见的来由 */
  const color = colorOr(raw.color, "") || (type === "shadow" ? "#00000080" : "#ffdd9a");
  if (type === "glow") return { filter: { type: "glow", r, color } };
  const out = { type: "shadow", r, color };
  if (Number.isFinite(h)) out.h = Math.round(clamp(h, 1, 4000));
  /* 写了的照写下的存（写 0 也是写下）；没写的留空，渲染时跟着块上的光倒向背光那边。
   在这儿替它补 0，就等于替用户把影子方向钉死在正下方，改了光源它也转不动。 */
  const dx = raw.dx == null || raw.dx === "" ? NaN : Number(raw.dx);
  const dy = raw.dy == null || raw.dy === "" ? NaN : Number(raw.dy);
  if (Number.isFinite(dx)) out.dx = Math.round(clamp(dx, -2e3, 2e3));
  if (Number.isFinite(dy)) out.dy = Math.round(clamp(dy, -2e3, 2e3));
  return { filter: out };
}

/* 滤镜可以只写一条，也可以写一串按序生效的（垫底描图常要「先去色再加对比」）。
   存下来的拼写跟着写法走：给对象存对象、给数组存数组，两种各自再归一化一遍都不变形。 */
function normalizeFilterList(raw) {
  if (!Array.isArray(raw)) return normalizeFilter(raw);
  if (!raw.length) return { why: '滤镜写成了一条空数组——要么给一条 {type:"blur",r}，要么就别写这个字段' };
  const list = [];
  for (const one of raw) {
    const item = normalizeFilter(one);
    if (item.why) return item;
    list.push(item.filter);
  }
  return { filter: list };
}

/* 画面里垫一张位图：参考底、扫描件、照片。跟图片块一样两种存法——这个空间
   images/ 下的相对路径（拷贝态），或原图在本机的绝对路径（引用态，不拷字节）。
   http 和 data: 一律不认：这应用得离线也画得出来，而且一串 base64 会把
   pictures/<块id>.json 撑爆，撤销栈跟着一起背。 */
const IMAGE_SRC_RULE =
  'src 要么是这个空间 images/ 下的相对路径（images/xxx.png），要么是原图在本机的绝对路径（C:\\某处\\参考图.png，引用不拷）；想直接垫一张本机图就写 path，应用会把它拷进这个空间再回填 src';

export function pictureImageSrc(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { why: `image 没写 src——${IMAGE_SRC_RULE}` };
  if (/^(https?:|data:|file:|blob:)/i.test(text)) {
    return { why: `image 的 src「${text.slice(0, 28)}…」是一个联网或内联地址，不认——${IMAGE_SRC_RULE}` };
  }
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("/")) return { src: text, linked: true };
  /* 相对路径存下来一律换成正斜杠：后端认的是 images/<文件名> 这两段，
     同一个文件不该因为上次写反斜杠、这次写正斜杠就成了两种拼写 */
  const parts = text.replace(/\\/g, "/").split("/");
  if (parts.length === 2 && parts[0] === "images" && parts[1]) {
    return { src: parts.join("/"), linked: false };
  }
  return { why: `image 的 src「${text.slice(0, 28)}」既不是本机绝对路径，也不是 images/xxx 这种空间内相对路径——${IMAGE_SRC_RULE}` };
}

/* 滤镜和混合模式八种 op 都能带，和 name / variants 一样在出口统一收：
   八个分支各抄一遍迟早漏一种。返回 {filter?, blend?}，写坏了返回 {why}。 */
function normalizeFx(raw) {
  const out = {};
  if (raw.filter != null) {
    const filter = normalizeFilterList(raw.filter);
    if (filter.why) return filter;
    out.filter = filter.filter;
  }
  if (raw.blend != null && raw.blend !== "") {
    if (typeof raw.blend !== "string") {
      return {
        why: `blend 得是一个字符串（现在是${Array.isArray(raw.blend) ? "一条数组" : ` ${typeof raw.blend}「${String(raw.blend).slice(0, 16)}」`}）——${BLEND_RULE}`,
      };
    }
    const blend = raw.blend.trim().toLowerCase();
    if (!BLEND_MODES.includes(blend)) {
      return { why: `blend「${raw.blend.slice(0, 24)}」不认识——${BLEND_RULE}` };
    }
    out.blend = blend;
  }
  return out;
}

const coord = (value) => Math.round(clamp(Number.isFinite(value) ? value : 0, -1e6, 1e6));
const opacityOf = (value, fallback) => Math.round(clamp(Number.isFinite(value) ? value : fallback, 0, 1) * 100) / 100;

/* ---------- 剪刀：一条指令自带一块裁剪 ----------
   画窗、瓦、水面的遮挡关系靠它。clip 是硬边：形状外不画，橡皮也擦不到。
   mask 是软边：拿遮罩形状的明度当透明度，白=留着、黑=没了，所以填一道渐变就是渐隐。
   两样八种 op 都能带，和 filter / blend 一样在出口统一收——八个分支各抄一遍迟早漏一种。 */
const CUT_RULE =
  '剪刀只认闭合的面：{op:"rect",x,y,w,h,radius}、{op:"poly"|"line",points}（点还能带 c1 / c2 走曲线边）、或 {ref:"素材名",x,y,rotate,scale} 拿一个已定义的素材当剪刀——一百个窗共用一把。裁剪永远和这块的画框再相交，越不出块';

function cutShapeIssue(value, name) {
  const shown = Array.isArray(value)
    ? "一条数组"
    : value === null
      ? "null"
      : `${typeof value}「${String(value).slice(0, 20)}」`;
  return `${name} 得是一个形状对象（现在是 ${shown}）——${CUT_RULE}`;
}

function normalizeCutShape(raw, state, name) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { why: cutShapeIssue(raw, name) };
  }
  const st = state || {};
  const ref = raw.ref == null ? "" : String(raw.ref).trim();
  /* 拿素材当剪刀：几何不重复写，剪出来的形和那份素材一模一样。
     素材自己内部不许再点素材当剪刀——套下去没完，渲染时造 defs 会自己咬自己。 */
  if (ref) {
    if (st.inSymbol) {
      return { why: `${name} 在素材里不能再点素材当剪刀——套下去没完，素材内部的剪刀要自己写成 rect / poly` };
    }
    const symbol = st.symbols ? st.symbols[ref] : null;
    if (!symbol) {
      const known = st.symbols ? Object.keys(st.symbols) : [];
      return {
        fatal: true,
        why: `${name} 的素材「${ref.slice(0, LAYER_NAME_MAX)}」在这块里找不到${
          known.length ? `，现在有名的是：${known.slice(0, 8).join(" / ")}` : "，这块还没定义任何素材"
        }——${CUT_RULE}`,
      };
    }
    return {
      shape: {
        kind: "ref",
        ref,
        x: coord(raw.x),
        y: coord(raw.y),
        rotate: Math.round(clamp(Number(raw.rotate) || 0, -360, 360)),
        scale: Math.round(clamp(Number(raw.scale) || 1, 0.01, 100) * 1000) / 1000,
      },
    };
  }
  /* 存回来的规范形带 kind，rect 那一种没有 op 字段——不认就会被当成
     「点不够围不成面」，同一份数据第二次归一化反而报错，幂等就破了 */
  const op = raw.op == null ? (raw.kind === "rect" ? "rect" : "") : String(raw.op).trim();
  if (op === "rect") {
    const w = Math.round(clamp(Number(raw.w) || 0, 0, 2e6));
    const h = Math.round(clamp(Number(raw.h) || 0, 0, 2e6));
    if (!w || !h) {
      return { why: `${name} 的 rect 要 w / h 都是正数（现在 w=${raw.w == null ? "没给" : raw.w} h=${raw.h == null ? "没给" : raw.h}）——宽或高为 0 的剪刀会把这条整条剪没，${CUT_RULE}` };
    }
    return {
      shape: {
        kind: "rect",
        x: coord(raw.x),
        y: coord(raw.y),
        w,
        h,
        radius: Math.max(0, Math.round(Number(raw.radius) || 0)),
      },
    };
  }
  if (op === "poly" || op === "line" || op === "") {
    const got = normalizePicturePoints(raw.points);
    /* 裁剪只看面，所以 line 到了剪刀这儿就是「首尾连起来的那个面」；两个点连不成面，
       面积 0 会把这条剪得一片不剩——那种结果看起来像画丢了，不像剪刀失效，所以当场拦下 */
    if (got.points.length < 3) {
      return {
        why: `${name} 的形状至少要 3 个点才围得出面（现在 ${got.points.length} 个${got.why ? `，${got.why}` : ""}）——${op === "line" ? "line 当剪刀时会自动首尾相连闭合，strokeWidth 不参与裁剪；" : ""}${CUT_RULE}`,
      };
    }
    return { shape: { kind: "path", points: got.points } };
  }
  return { why: `${name} 的 op「${op.slice(0, 12)}」当不了剪刀——${CUT_RULE}` };
}

/* clip / mask 一起收。mask 比 clip 多了「拿什么当透明度」这一层：
   默认纯白（=全不透明，等价于一把硬边剪刀的软边版），要渐隐就把 fill 写成渐变。 */
function normalizeCuts(raw, state) {
  const out = {};
  if (raw.clip != null && raw.clip !== "") {
    const shape = normalizeCutShape(raw.clip, state, "clip");
    if (shape.why) return shape;
    out.clip = shape.shape;
  }
  if (raw.mask != null && raw.mask !== "") {
    const shape = normalizeCutShape(raw.mask, state, "mask");
    if (shape.why) return shape;
    const given = raw.mask.fill == null || raw.mask.fill === "" ? "#fff" : raw.mask.fill;
    const fill = paintOf(given, "mask 的 fill", state);
    if (fill.why) return fill;
    const soft = Number(raw.mask.soft);
    shape.shape.fill = fill.paint || "#fff";
    shape.shape.soft = Number.isFinite(soft) ? Math.round(clamp(soft, 0, 200) * 10) / 10 : 0;
    out.mask = shape.shape;
  }
  return out;
}

/* ---------- 剪刀落到 svg ----------
   clipPath 的子节点按 SVG 只认形状：不能嵌 <g>，也不能靠 <use> 引一个 <g> 进来，
   所以素材当剪刀时把几何摊平——每一片叶子自己带上累计的 transform。
   mask 里放什么都行（它要的是明度），但为了两边同一套代码，也照摊平来。 */

/* 把一条指令的几何变成裁剪用的形状节点。fill 非空时给它上漆（mask 要），clip 只吃几何。
   返回空数组 = 这条当不了剪刀（文字、位图、素材实例），ref 剪刀里遇到就跳过它。 */
function cutGeometryOf(cmd, transform, fill, ctx) {
  const paint = fill ? { fill } : {};
  if (cmd.op === "rect") {
    return [pictureNodeExact("rect", { x: cmd.x, y: cmd.y, width: cmd.w, height: cmd.h, rx: cmd.radius || null, ...paint, transform: transform || null })];
  }
  if (cmd.op === "poly" || cmd.op === "line") {
    /* 裁剪只看面：line 到剪刀这儿也闭合成面，和归一化时的说法一致 */
    return [pictureNodeExact("path", { d: edgePath(cmd.points, true), ...paint, transform: transform || null })];
  }
  if (cmd.op === "stroke") {
    if (cmd.points.length === 1) {
      const one = cmd.points[0];
      return [pictureNodeExact("circle", { cx: one.x, cy: one.y, r: strokeRadiusOf(one, cmd.size), ...paint, transform: transform || null })];
    }
    /* 墨迹当剪刀要的是那一长条的面积，所以走填色轮廓；枯笔的丝不在这里管——
       剪刀是一把硬边，用一杆散掉的笔去裁东西没有意义 */
    return [pictureNodeExact("path", { d: strokeOutlinePath(cmd.points, cmd.size), ...paint, transform: transform || null })];
  }
  if (cmd.op === "group") {
    const local = `${transform ? `${transform} ` : ""}translate(${cmd.x} ${cmd.y}) rotate(${cmd.rotate}) scale(${cmd.scale})`;
    return cmd.cmds.flatMap((child) => cutGeometryOf(child, local, fill, ctx));
  }
  if (cmd.op === "text") {
    /* svg 认 <text> 当裁剪形状，字就成了花窗的洞；字体缺失时剪出来的和看见的不是一回事，
       所以只在渲染这一头收下，手册里不推荐拿它当剪刀 */
    const node = pictureNodeExact("text", { x: cmd.x, y: cmd.y, "font-size": cmd.size, ...paint, transform: transform || null });
    node.textContent = cmd.text;
    return [node];
  }
  return [];
}

/* ref 剪刀：把那份素材的几何整个摊进来。落点 ox/oy 对齐方式和 use 一模一样，
   所以「摆出来长什么样」和「当剪刀剪出什么形」是同一个形。 */
function cutRefNodes(shape, fill, ctx) {
  const symbol = ctx?.symbols?.[shape.ref];
  if (!symbol) return [];
  const local = `translate(${shape.x} ${shape.y}) rotate(${shape.rotate}) scale(${shape.scale}) translate(${-symbol.ox} ${-symbol.oy})`;
  return (symbol.cmds || []).flatMap((cmd) => cutGeometryOf(cmd, local, fill, ctx));
}

/* 归一化存下来的三种规范形，各自变成 svg 的几何节点。
   形状节点不带 transform（剪刀自己的位移已经写进 x/y 或 ref 的那层 g 里了）。 */
function cutGeometryNodes(shape, fill, ctx) {
  const paint = fill ? { fill } : {};
  if (shape.kind === "ref") return cutRefNodes(shape, fill, ctx);
  if (shape.kind === "rect") {
    return [pictureNodeExact("rect", { x: shape.x, y: shape.y, width: shape.w, height: shape.h, rx: shape.radius || null, ...paint })];
  }
  /* 点串没了（盘上坏数据）就当成「剪不出形」：下面那条会返回空，剪刀不挂——
     为一把坏剪刀让整块画面抛错，看起来像是画全丢了 */
  if (!Array.isArray(shape.points) || shape.points.length < 3) return [];
  return [pictureNodeExact("path", { d: edgePath(shape.points, true), ...paint })];
}

function clipAttr(clip, ctx) {
  const key = `cut\u0000${JSON.stringify(clip)}`;
  const cached = ctx?.defCache?.get(key);
  if (cached) return `url(#${cached})`;
  const node = pictureNodeExact("clipPath", {});
  const nodes = cutGeometryNodes(clip, "", ctx);
  if (!nodes.length) return "";
  node.append(...nodes);
  pictureCutSeq += 1;
  const id = `canvas-picture-cut-${pictureCutSeq}`;
  node.setAttribute("id", id);
  markPictureDef(node);
  ctx?.defs?.append(node);
  ctx?.defCache?.set(key, id);
  return `url(#${id})`;
}

/* 遮罩看明度：白的地方留下、黑的地方没了，所以 fill 给一道渐变就是渐隐。
   默认纯白 = 和硬边剪刀同效，只是边缘能靠 soft 羽化。
   羽化用 css blur 挂在遮罩内容上：一条带 soft 的遮罩就是一次离屏合成，别上百条一起挂。 */
function maskAttr(mask, ctx) {
  const key = `mask\u0000${JSON.stringify(mask)}`;
  const cached = ctx?.defCache?.get(key);
  if (cached) return `url(#${cached})`;
  const box = ctx?.box;
  const node = pictureNodeExact(
    "mask",
    box ? { maskUnits: "userSpaceOnUse", x: 0, y: 0, width: box.w, height: box.h } : { maskUnits: "userSpaceOnUse" },
  );
  const paint = paintAttr(mask.fill, ctx);
  const nodes = cutGeometryNodes(mask, paint || "#fff", ctx);
  /* 剪不出任何形状就别挂遮罩：挂了一张全黑会把这条整个抹掉，看起来像画丢了 */
  if (!nodes.length) return "";
  if (mask.soft > 0) {
    const g = pictureNode("g", {});
    g.style.filter = `blur(${mask.soft}px)`;
    g.append(...nodes);
    node.append(g);
  } else {
    node.append(...nodes);
  }
  pictureCutSeq += 1;
  const id = `canvas-picture-mask-${pictureCutSeq}`;
  node.setAttribute("id", id);
  markPictureDef(node);
  ctx?.defs?.append(node);
  ctx?.defCache?.set(key, id);
  return `url(#${id})`;
}

function normalizePicturePoints(raw, cap = PICTURE_MAX_POINTS) {
  if (!Array.isArray(raw)) return { points: [], why: "points 不是数组" };
  const points = [];
  for (const entry of raw) {
    const x = Number(entry?.x ?? entry?.[0]);
    const y = Number(entry?.y ?? entry?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = { x: coord(x), y: coord(y) };
    /* c1 / c2 是「进入这一点」的两个控制点：写了这一段就是三次贝塞尔，没写还是直线。
       控制点写坏了不能悄悄当没写——那会让 agent 以为曲线画出来了，看见的却是个折角。 */
    for (const key of ["c1", "c2"]) {
      if (entry?.[key] == null) continue;
      const handle = handleOf(entry[key]);
      if (!handle) return { points: [], why: `点里的控制点 ${key}「${JSON.stringify(entry[key]).slice(0, 24)}」算不出 x/y，控制点要写成 {x,y} 或 [x,y]` };
      point[key] = handle;
    }
    points.push(point);
    if (points.length >= cap) break;
  }
  return { points, why: "" };
}

function handleOf(raw) {
  const x = Number(raw?.x ?? raw?.[0]);
  const y = Number(raw?.y ?? raw?.[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: coord(x), y: coord(y) } : null;
}

/* 手绘一笔的点：除了 x/y 还带这一点的笔宽（{x,y,w} 或 [x,y,w]）。
   不写 w 就一路等宽，渲染那边会走更便宜的描边画法。 */
function normalizePictureStrokePoints(raw, cap = PICTURE_MAX_POINTS) {
  if (!Array.isArray(raw)) return [];
  const points = [];
  for (const entry of raw) {
    const x = Number(entry?.x ?? entry?.[0]);
    const y = Number(entry?.y ?? entry?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = { x: coord(x), y: coord(y) };
    const given = Number(entry?.w ?? entry?.[2]);
    if (Number.isFinite(given)) {
      point.w = Math.round(clamp(given, PICTURE_STROKE_WIDTH_MIN, PICTURE_STROKE_WIDTH_MAX) * 10) / 10;
    }
    points.push(point);
    if (points.length >= cap) break;
  }
  return points;
}

/* 一条指令认八种：矩形 / 闭合多边形 / 折线 / 一笔墨迹 / 文字 / 分组 / 摆素材 / 垫位图。
   认不了的整条丢掉——宁可少画一笔，也不让半条指令渲染成糊在屏幕上的东西。
   丢掉必须带回一句为什么：只说「丢了」等于让调用方自己猜是哪个字段写错。
   state 是这一轮归一化的上下文（素材表、展开条数、算过的缓存），递归往下传。 */
export function normalizePictureCmd(raw, state) {
  if (!raw || typeof raw !== "object") return { why: "这条不是对象，是一条指令得写成 {op, ...}" };
  const shape = pictureCmdShape(raw, state);
  if (!shape.cmd) return shape;
  /* 滤镜和混合模式挂在任何一种 op 上，跟在出口处统一收 */
  const fx = normalizeFx(raw);
  if (fx.why) return fx;
  if (fx.filter) shape.cmd.filter = fx.filter;
  if (fx.blend) shape.cmd.blend = fx.blend;
  /* 剪刀同理：clip 硬边、mask 软边，八种 op 都能带。没写就不给这个键，
     老数据读回来不会凭空多一个 null。 */
  const cuts = normalizeCuts(raw, state);
  if (cuts.why) return cuts;
  if (cuts.clip) shape.cmd.clip = cuts.clip;
  if (cuts.mask) shape.cmd.mask = cuts.mask;
  return shape;
}

function pictureCmdShape(raw, state) {
  const st = state || {};
  const op = raw.op == null ? "" : String(raw.op).trim();
  const opacity = raw.opacity == null ? 1 : opacityOf(raw.opacity, 1);
  if (op === "rect") {
    const fill = paintOf(raw.fill, "fill", st);
    if (fill.why) return fill;
    const stroke = paintOf(raw.stroke, "stroke", st);
    if (stroke.why) return stroke;
    if (!fill.paint && !stroke.paint) {
      return { why: `rect 的${paintIssue(raw.fill, "fill")}、${paintIssue(raw.stroke, "stroke")}——填色和描边至少要有一个，${COLOR_RULE}，也可以给一个渐变或图案` };
    }
    return {
      cmd: {
        op: "rect",
        x: coord(raw.x),
        y: coord(raw.y),
        w: Math.round(clamp(Number(raw.w) || 0, 0, 2e6)),
        h: Math.round(clamp(Number(raw.h) || 0, 0, 2e6)),
        fill: fill.paint,
        stroke: stroke.paint,
        strokeWidth: stroke.paint ? Math.round(clamp(Number(raw.strokeWidth) || 1, 0, 200)) : 0,
        radius: Math.max(0, Math.round(Number(raw.radius) || 0)),
        opacity,
      },
    };
  }
  /* 折线 / 闭合多边形：闭合靠 op=poly，line 带 close:true 也等价于 poly。
     stroke 这个名字早期借给过「描边的线」，现在它是一笔墨迹，别再往这儿走。 */
  const close = op === "poly" || (op === "line" && raw.close === true);
  if (close || op === "line") {
    const kind = close ? "poly" : "line";
    const stroke = paintOf(raw.stroke, "stroke", st);
    if (stroke.why) return stroke;
    if (!close && !stroke.paint) return { why: `line 的${paintIssue(raw.stroke, "stroke")}——描边线必须有颜色、渐变或图案` };
    const traced = normalizePictureCmdPoints(raw.points);
    if (traced.why) return { why: `${kind} ${traced.why}` };
    const points = traced.points;
    if (points.length < 2) {
      const detail = !Array.isArray(raw.points)
        ? `points ${raw.points == null ? "没给" : `不是数组（是 ${typeof raw.points}）`}`
        : `points 里只有 ${points.length} 个算得出 x/y 的点`;
      return { why: `${kind} 至少要 2 个点，${detail}——每个点写成 {x, y} 或 [x, y]，想拐弯就再给它 c1 / c2 两个控制点` };
    }
    const fill = close ? paintOf(raw.fill, "fill", st) : { paint: "" };
    if (fill.why) return fill;
    if (close && !fill.paint && !stroke.paint) {
      return { why: `poly 的${paintIssue(raw.fill, "fill")}、${paintIssue(raw.stroke, "stroke")}——${COLOR_RULE}，填色和描边至少要有一个` };
    }
    return {
      cmd: {
        op: kind,
        points,
        stroke: stroke.paint,
        strokeWidth: stroke.paint ? Math.round(clamp(Number(raw.strokeWidth) || 2, 0, 200)) : 0,
        cap: raw.cap === "round" || raw.cap === "square" ? raw.cap : "round",
        fill: fill.paint,
        opacity,
      },
    };
  }
  if (op === "stroke") {
    const color = colorOr(raw.color, "");
    if (!color) return { why: `stroke 的${colorIssue(raw.color, "color")}——落笔总得有个墨色，${COLOR_RULE}` };
    const size =
      Math.round(clamp(Number(raw.size) || PICTURE_STROKE_DEFAULT_WIDTH, PICTURE_STROKE_WIDTH_MIN, PICTURE_STROKE_WIDTH_MAX) * 10) / 10;
    const points = normalizePictureStrokePoints(raw.points);
    if (!points.length) {
      const detail = !Array.isArray(raw.points)
        ? `points ${raw.points == null ? "没给" : `不是数组（是 ${typeof raw.points}）`}`
        : "points 里没有一个算得出 x/y 的点";
      return { why: `stroke 至少要 1 个点，${detail}——每个点写成 {x, y}，要提按再各带一个 w（那一点的笔宽）` };
    }
    /* 枯到什么程度：0 是实墨一杆（不写就是 0，老数据读回来补这一个 0，
       和 opacity / cap 一个待遇），1 散得只剩几根丝。 */
    const grain = Math.round(clamp(Number(raw.grain) || 0, 0, 1) * 100) / 100;
    return {
      cmd: {
        op: "stroke",
        points,
        color,
        size,
        kind: PICTURE_STROKE_KINDS.includes(raw.kind) ? raw.kind : "pen",
        grain,
        opacity,
      },
    };
  }
  if (op === "text") {
    const text = typeof raw.text === "string" ? raw.text.slice(0, 500) : "";
    if (!text.trim()) {
      const detail = raw.text == null ? "没给" : `${typeof raw.text}「${String(raw.text).slice(0, 24)}」`;
      return { why: `text 的内容是空的（${detail}）${typeof raw.text === "string" ? "，不能只写空格" : "，text 字段要写成字符串"}` };
    }
    return {
      cmd: {
        op: "text",
        x: coord(raw.x),
        y: coord(raw.y),
        text,
        size: Math.round(clamp(Number(raw.size) || 16, 1, 2000)),
        color: colorOr(raw.color, "") || "#000000",
        weight: raw.weight === "bold" ? "bold" : "normal",
        font: PICTURE_TEXT_FONTS.includes(raw.font) ? raw.font : "sans",
        rotate: Math.round(clamp(Number(raw.rotate) || 0, -360, 360)),
        opacity,
      },
    };
  }
  /* 分组：把一串指令当一个整体搬动。 */
  if (op === "group") {
    const inner = normalizePictureCmds(raw.cmds, st.cap || PICTURE_MAX_CMDS, { ...st, top: false });
    if (!inner.cmds.length) {
      const first = inner.dropped[0];
      return {
        fatal: inner.dropped.some((one) => one.fatal),
        why: !Array.isArray(raw.cmds)
          ? `group 的 cmds ${raw.cmds == null ? "没给" : `不是数组（是 ${typeof raw.cmds}）`}，里面要装一串指令`
          : !raw.cmds.length
            ? "group 的 cmds 是空数组，里头一条指令都没有"
            : `group 里的 ${raw.cmds.length} 条子指令一条都没认出来：第 ${first.at} 条——${first.why}`,
      };
    }
    return {
      cmd: {
        op: "group",
        x: coord(raw.x),
        y: coord(raw.y),
        rotate: Math.round(clamp(Number(raw.rotate) || 0, -360, 360)),
        scale: Math.round(clamp(Number(raw.scale) || 1, 0.01, 100) * 1000) / 1000,
        cmds: inner.cmds,
      },
      /* 组里没进的子指令也要报出去：只捞「整组全丢」那一种的话，
         17 个小人拼错 1 个变体名就只剩 16 个，而回话说一切正常 */
      sub: inner.dropped,
    };
  }
  /* 摆一份素材：真正的节点在渲染时按「素材 + 这套开关」现造一次，
     一百份 use 只共用那一个 <g>，所以存下来的只有 ref 和落点。 */
  if (op === "use") {
    if (st.inSymbol) {
      return { why: "素材里不能再摆 use——套下去没完，素材内部只用 rect / poly / line / stroke / text / group / image" };
    }
    const ref = raw.ref == null ? "" : String(raw.ref).trim();
    if (!ref) return { fatal: true, why: `use 没写 ref——得点名一个已定义的素材，${SYMBOL_RULE}` };
    const symbol = st.symbols ? st.symbols[ref] : null;
    if (!symbol) {
      const known = st.symbols ? Object.keys(st.symbols) : [];
      return {
        fatal: true,
        why: `use 的素材「${ref.slice(0, LAYER_NAME_MAX)}」在这块里找不到${
          known.length ? `，现在有名的是：${known.slice(0, 8).join(" / ")}` : "，这块还没定义任何素材"
        }——素材要和这条指令在同一个请求里发来，${SYMBOL_RULE}`,
      };
    }
    const variant = raw.variant == null ? "" : String(raw.variant).trim().slice(0, LAYER_NAME_MAX);
    if (raw.hide != null && !Array.isArray(raw.hide)) {
      return { why: `use 的 hide 得是一个图层名数组（现在是 ${typeof raw.hide}）——${SYMBOL_RULE}` };
    }
    const hide = [...new Set((raw.hide || []).slice(0, 16).map((one) => String(one ?? "").trim().slice(0, LAYER_NAME_MAX)).filter(Boolean))];
    const layers = symbolLayers(symbol, st);
    if (variant && !layers.variants.includes(variant)) {
      return {
        fatal: true,
        why: `素材「${ref}」没有「${variant}」这个变体——${
          layers.variants.length ? `它标出来的是：${layers.variants.join(" / ")}` : "它一笔都没标 variants（哪几笔要换样子，就给那几笔写 variants:[\"站\",\"坐\"]）"
        }`,
      };
    }
    const unknown = hide.filter((one) => !layers.names.includes(one));
    if (unknown.length) {
      return {
        fatal: true,
        why: `素材「${ref}」里没有叫「${unknown.join(" / ")}」的图层——${
          layers.names.length ? `它有的图层是：${layers.names.join(" / ")}` : "它每一笔都还没起 name（要单独关哪一笔就给它写 name，几笔一起关就包一层 group 起名）"
        }`,
      };
    }
    return {
      cmd: {
        op: "use",
        ref,
        x: coord(raw.x),
        y: coord(raw.y),
        rotate: Math.round(clamp(Number(raw.rotate) || 0, -360, 360)),
        scale: Math.round(clamp(Number(raw.scale) || 1, 0.01, 100) * 1000) / 1000,
        variant,
        hide,
        opacity,
      },
    };
  }
  /* 垫一张位图：描图参考、扫描件、照片。它也是一条指令——橡皮擦得到、picture_get 看得见、
     跟着这块的画面一起搬动，不是浮在上面的另一层东西。 */
  if (op === "image") {
    const src = pictureImageSrc(raw.src);
    if (src.why) return src;
    const w = Math.round(clamp(Number(raw.w) || 0, 0, 2e6));
    const h = Math.round(clamp(Number(raw.h) || 0, 0, 2e6));
    if (w <= 0 || h <= 0) {
      return {
        why: `image 的 w / h 得是正数（现在 w=${raw.w ?? "没给"} h=${raw.h ?? "没给"}）——原图多大要量过才知道，发 picture_draw 时可以省掉这两个数，应用会照着图量好填上`,
      };
    }
    return {
      cmd: {
        op: "image",
        src: src.src,
        linked: src.linked,
        x: coord(raw.x),
        y: coord(raw.y),
        w,
        h,
        fit: raw.fit === "fill" ? "fill" : "meet",
        rotate: Math.round(clamp(Number(raw.rotate) || 0, -360, 360)),
        opacity,
      },
    };
  }
  return { why: op ? `op「${op.slice(0, 24)}」不认识，${OPS_RULE}` : `没给 op，${OPS_RULE}` };
}

function normalizePictureCmdPoints(raw) {
  return normalizePicturePoints(raw, PICTURE_MAX_POINTS);
}

/* 认不了的整条丢掉。丢掉的那几条要报回给调用方：agent 写错一个颜色就少一块东西、
   又没有任何提示，它会以为画面本来就该长这样。
   ctx = {symbols, inSymbol, top, budget, view, layers}：素材表、是不是嵌在素材里、
   是不是最外层、展开后的条数、算过的投影缓存。自己调用只给 {symbols} 就够。 */
export function normalizePictureCmds(raw, cap = PICTURE_MAX_CMDS, ctx = {}) {
  const cmds = [];
  const dropped = [];
  const st = {
    symbols: ctx.symbols || null,
    inSymbol: Boolean(ctx.inSymbol),
    top: ctx.top !== false,
    cap: ctx.cap || cap,
    budget: ctx.budget || { expanded: 0 },
    view: ctx.view || new Map(),
    layers: ctx.layers || new Map(),
  };
  if (!Array.isArray(raw)) return { cmds, dropped, expanded: st.budget.expanded };
  raw.forEach((entry, index) => {
    const { cmd, why, fatal, sub } = normalizePictureCmd(entry, st);
    if (!cmd) {
      dropped.push({
        at: index,
        op: entry && typeof entry === "object" ? String(entry.op ?? "") : "",
        why,
        fatal: Boolean(fatal),
      });
      return;
    }
    if (sub?.length) {
      for (const one of sub) {
        dropped.push({ at: index, op: cmd.op, why: `第 ${index} 条 group 里的第 ${one.at} 条——${one.why}`, fatal: Boolean(one.fatal) });
      }
    }
    /* 每条指令一个块内唯一的号：橡皮按号删、agent 改某一条都靠它，
       调用方不用自己维护编号。取全表最大值而不是上一条，
       否则删掉末尾那条之后新号会撞上前面的。 */
    let id = Number(entry.i);
    if (!Number.isFinite(id) || id <= 0 || cmds.some((one) => one.i === id)) {
      id = cmds.reduce((max, one) => Math.max(max, one.i), 0) + 1;
    }
    cmd.i = Math.trunc(id);
    /* 图层名和变体标在哪一种指令上都算：一条 line 也能是一层「旗杆」，想整组开关就包一层 group。
       这一处统一收，各个分支才不用各抄一遍——存下去的形状也靠这里保住 */
    if (typeof entry.name === "string" && entry.name.trim()) cmd.name = entry.name.trim().slice(0, LAYER_NAME_MAX);
    if (Array.isArray(entry.variants)) {
      const variants = [...new Set(entry.variants.slice(0, 16).map((one) => String(one ?? "").trim().slice(0, LAYER_NAME_MAX)).filter(Boolean))];
      if (variants.length) cmd.variants = variants;
    }
    /* 朝向也在这处统一收：六向词照原样存（存成角度数字表达不了 front / back 那个分量）。
       词写错整条丢掉报回人——一条默默不吃饭的光比少一笔更难查。 */
    if (entry.face != null && entry.face !== "") {
      const face = String(entry.face).trim().toLowerCase();
      if (!PICTURE_FACES.includes(face)) {
        dropped.push({
          at: index,
          op: cmd.op,
          why: `face「${String(entry.face).trim().slice(0, 20)}」不认识——${FACE_RULE}`,
        });
        return;
      }
      cmd.face = face;
    }
    /* 光卡顶层条数不够：一条 use 顶一整个素材，真把浏览器压死的是展开后的节点数。
       到上限就只挡这一条，前面画下的都保住。 */
    if (st.top) {
      const cost = pictureCmdCost(cmd, st);
      if (st.budget.expanded + cost > PICTURE_MAX_EXPANDED) {
        dropped.push({
          at: index,
          op: cmd.op,
          why: `${cmd.op === "use" ? `use「${cmd.ref}」` : cmd.op}铺开要 ${cost} 条，加上已经进的 ${st.budget.expanded} 条，超了 ${PICTURE_MAX_EXPANDED} 的展开上限，这条没进`,
        });
        return;
      }
      st.budget.expanded += cost;
    }
    if (cmds.length >= cap) dropped.push({ at: index, op: cmd.op, why: `超出条数上限 ${cap}，这条和它之后的都没进` });
    else cmds.push(cmd);
  });
  return { cmds, dropped, expanded: st.budget.expanded };
}

/* 一条指令铺开实际要多少个节点：use 把整个素材带进来，group 把子指令带进来。
   素材里不许嵌 use，所以这层递归一定收尾。 */
function pictureCmdCost(cmd, st) {
  if (cmd.op === "use") {
    const view = symbolView(st.symbols, st.view, cmd);
    return view ? view.cmds.reduce((sum, one) => sum + pictureCmdCost(one, st), 0) : 1;
  }
  if (cmd.op === "group") return 1 + cmd.cmds.reduce((sum, one) => sum + pictureCmdCost(one, st), 0);
  return 1;
}

/* 这块画面里垫了哪几张图。加载器要先按 src 把能显示的地址取进缓存，渲染时才拿得到；
   group 里和素材定义里也能写 image，所以两处都要收。同一个 src 只报一次。 */
export function collectPictureImageSrcs(cmds, symbols) {
  const found = new Map();
  const walk = (list) => {
    for (const cmd of list || []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.op === "image" && cmd.src) found.set(cmd.src, Boolean(cmd.linked));
      if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(cmds);
  for (const symbol of Object.values(symbols || {})) walk(symbol.cmds);
  return [...found].map(([src, linked]) => ({ src, linked }));
}

/* 把垫图换成另一空间的副本：map 是 {旧 src → 新的 images/xxx.png}，命中的改写 src 并落成拷贝态。
   没命中的原样留着（拷不动的那几张就是留着的，画出来是虚线占位框）。
   group 和素材定义里也能写 image，两处一起走，口径和 collectPictureImageSrcs 对齐。 */
export function remapPictureImageSrcs(cmds, symbols, map) {
  if (!map || !map.size) return;
  const walk = (list) => {
    for (const cmd of list || []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.op === "image" && map.has(cmd.src)) {
        cmd.src = map.get(cmd.src);
        cmd.linked = false;
      }
      if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(cmds);
  for (const symbol of Object.values(symbols || {})) walk(symbol && symbol.cmds);
}

/* 素材里起了名 / 标了变体的那些层，按 use 的 variant / hide 投影出要画的那一份。
   图层可以是任何一种指令，也可以是整组；只出新的数组，素材本身一条不动——那是要存进磁盘的数据。 */
const LAYER_NAME_MAX = 32;

function projectLayers(cmds, variant, hide) {
  const out = [];
  for (const cmd of cmds) {
    if (cmd.name && hide.includes(cmd.name)) continue;
    /* 标了 variants 的层是「某一副样子才出现的那一笔」，所以 use 没给同名 variant 时它不画——
       以前反过来（没给 variant 就全画），结果一份素材的几副样子会同时糊在图上，
       写错一个变体名还要掉一整批。
       variant 传 null 是「这一层没有变体可切」：块顶层没有变体开关，顶层那条 group 上写的
       variants 是无意义的标注，照画——已经画好的东西不该因为一个没人用的字段凭空消失。 */
    if (variant !== null && cmd.variants?.length && !cmd.variants.includes(variant)) continue;
    if (cmd.op !== "group") {
      out.push(cmd);
      continue;
    }
    const inner = projectLayers(cmd.cmds, variant, hide);
    if (!inner.length) continue;
    out.push(inner.length === cmd.cmds.length ? cmd : { ...cmd, cmds: inner });
  }
  return out;
}

/* 块上的图层开关（hidden）：关掉的层名在这一块的顶层指令里真不画。
   拼写和素材图层是同一套——还是那条指令上的 name，不搞第二套名字。
   关掉的层不画，但指令、条数和展开预算都还在：一开关就报「超上限」或者少一批画，
   等于把用户画好的东西弄丢了。 */
const HIDDEN_MAX = 200;

export function normalizeHidden(raw) {
  if (raw == null || raw === "") return { hidden: [] };
  if (!Array.isArray(raw)) {
    return { why: `hidden 得是一个层名数组（现在是 ${typeof raw}）——写成 ["城楼","远景"]，空数组是全开` };
  }
  const hidden = [];
  for (const one of raw) {
    const name = String(one ?? "").trim().slice(0, LAYER_NAME_MAX);
    if (name && !hidden.includes(name)) hidden.push(name);
  }
  if (hidden.length > HIDDEN_MAX) {
    return { why: `hidden 里 ${hidden.length} 个层名，最多 ${HIDDEN_MAX} 个——一层要关的是几十条指令，不是几十层` };
  }
  return { hidden };
}

/* 顶层按块上的开关过一遍，渲染和橡皮共用这一份判法：
   cmd 是原始那条（号还在、在数组里的位置也还在，撤销栈和按号 delete 都对得上盘上的数据），
   drawn 是这一条该画出来的那份（整层关掉是 null；组里只关掉几笔的，出来的是少了那几笔的组）。
   两边必须同一套，否则会出现「看不见却擦得到」或者「擦得着却擦不到」。 */
export function pictureTopLayers(cmds, hidden) {
  const off = Array.isArray(hidden) ? hidden : [];
  return (Array.isArray(cmds) ? cmds : []).map((cmd) => {
    if (!cmd || typeof cmd !== "object") return { cmd, drawn: null };
    if (cmd.name && off.includes(cmd.name)) return { cmd, drawn: null };
    if (cmd.op !== "group") return { cmd, drawn: cmd };
    return { cmd, drawn: projectLayers([cmd], null, off)[0] || null };
  });
}

/* 块上到底有哪几层：组里起了名的那笔也算一层。
   关它走的正是 projectLayers 那套按名判法——清单里要是不报这个名字，
   agent 就面对一个「关得动、却报给它说不存在」的层。 */
export function pictureLayerCensus(cmds) {
  const order = [];
  const counts = new Map();
  let unnamed = 0;
  const walk = (list) => {
    for (const cmd of Array.isArray(list) ? list : []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.name) {
        if (!counts.has(cmd.name)) order.push(cmd.name);
        counts.set(cmd.name, (counts.get(cmd.name) || 0) + 1);
      } else {
        unnamed += 1;
      }
      if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(cmds);
  return { order, counts, unnamed };
}

/* 一套光：全画面只认一个光源，逐条指令只声明「我这个面朝向哪」，明暗由这儿算。
   光源存块上（和 hidden 同一类，进 items.json），颜色存下去的仍是固有色——
   烘进 stops 的话改一次光要重写上千条，幂等和撤销都顶不住。 */
const PICTURE_FACES = ["up", "down", "left", "right", "front", "back"];
/* k 默认 0.3：双端插值在 k 大的时候，吃一半光的面（朝天的屋顶、地面）算出来就是
   (影色+光色)/2，固有色被吃干，整幅像蒙了张灰纸。0.3 是「看得出有朝向差、颜色还是自己的」那一档。 */
const LIGHT_DEFAULTS = { angle: 315, elev: 45, lit: "#fff4de", dark: "#2f3a52", k: 0.3 };
const FACE_RULE =
  'face 写 up / down / left / right / front / back 之一：那个面的朝向（front 正对观者、back 背对）。斜射的明暗不用你算——由光来的方位角和这个朝向的夹角算出来';

export function normalizeLight(raw) {
  if (raw == null || raw === "" || raw === false) return { light: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      why: `light 得是一个对象（现在是 ${Array.isArray(raw) ? "一条数组" : typeof raw}）——写成 {angle:315}，光从左上方打过来；抹掉光写 null`,
    };
  }
  const angle = Number(raw.angle);
  if (!Number.isFinite(angle)) {
    return {
      why: `light 得写 angle：光从哪个方位来，0 是正上方、顺时针数、315 就是左上方（现在${raw.angle == null ? "没给" : `写的是「${String(raw.angle).slice(0, 16)}」`}）`,
    };
  }
  for (const key of ["lit", "dark"]) {
    if (raw[key] != null && raw[key] !== "" && !colorOr(raw[key], "")) {
      return { why: `light 的 ${colorIssue(raw[key], key)}——${COLOR_RULE}` };
    }
  }
  const elev = Number(raw.elev);
  const k = Number(raw.k);
  /* 归一到「存下去的拼写就是读回来的拼写」：角度收进 0~360 的整数，俯仰 ±90，k 两位小数 */
  return {
    light: {
      angle: Math.round((((angle % 360) + 360) % 360)),
      elev: Number.isFinite(elev) ? Math.round(Math.min(90, Math.max(-90, elev))) : LIGHT_DEFAULTS.elev,
      lit: colorOr(raw.lit, LIGHT_DEFAULTS.lit),
      dark: colorOr(raw.dark, LIGHT_DEFAULTS.dark),
      k: Number.isFinite(k) ? Math.round(Math.min(1, Math.max(0, k)) * 100) / 100 : LIGHT_DEFAULTS.k,
    },
  };
}

/* 六向 → 单位向量：x 向右、y 向下（画面坐标）、z 朝观者。
   front / back 就是 z 轴那两个——它们和屏幕上任何方向都正交，
   朝向只能存词、存成一个角度数字反而表达不了那个分量。 */
const FACE_VEC = {
  up: [0, -1, 0],
  down: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  front: [0, 0, 1],
  back: [0, 0, -1],
};

/* 吃到多少光：外法线和「光源所在方位」点乘，负数归零（Lambert）。
   angle 0 = 光源在正上方，elev 90 = 光源和观者同侧。 */
export function pictureLightT(light, face) {
  const v = face && FACE_VEC[face];
  if (!light || !v) return null;
  const a = (Number(light.angle) * Math.PI) / 180;
  const e = (Number(light.elev ?? LIGHT_DEFAULTS.elev) * Math.PI) / 180;
  const horiz = Math.cos(e);
  const dot = v[0] * Math.sin(a) * horiz - v[1] * Math.cos(a) * horiz + v[2] * Math.sin(e);
  return Math.round(Math.max(0, Math.min(1, dot)) * 1000) / 1000;
}

function hexParts(value) {
  const body = String(value || "").trim().slice(1);
  const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
  if (!/^([0-9a-f]{6})([0-9a-f]{2})?$/i.test(full)) return null;
  const n = parseInt(full.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: full.slice(6) };
}

const mixTo = (base, target, amount) => Math.max(0, Math.min(255, Math.round(base + (target - base) * amount)));

/* 双端插值：完全背光那一头是「固有色往影色拉 k」，完全受光那一头是「往光色拉 k」，
   吃到的光在两头之间线性走过去。这么写而不是先拉影色再拉光色，是为了让掠射角（吃一半）
   落回固有色本身——不然整幅画会莫名偏暗或偏亮，明暗必须是从固有色往两边散开的。
   k 到不了 1 也是刻意的：把固有色吃干，一幅画就只剩光色和影色两个颜色。 */
export function tintHex(color, light, face) {
  const t = pictureLightT(light, face);
  if (t == null) return color;
  const k = Number(light.k ?? LIGHT_DEFAULTS.k);
  if (!(k > 0)) return color;
  const base = hexParts(color);
  if (!base) return color;
  const lit = hexParts(light.lit);
  const dark = hexParts(light.dark);
  if (!lit || !dark) return color;
  const one = (ch) => {
    const shade = mixTo(base[ch], dark[ch], k);
    const shine = mixTo(base[ch], lit[ch], k);
    return Math.round(shade + (shine - shade) * t);
  };
  return `#${[one("r"), one("g"), one("b")].map((v) => v.toString(16).padStart(2, "0")).join("")}${base.alpha || ""}`;
}

/* 明暗落进这一幅画的漆：纯色、渐变的每一档、图案漆的那根线、毛笔的墨。
   只有 paintAttr 这一个出口，八个 op 分支才不用各抄一遍。
   没挂光的块走不进这里——那条红线要求它的输出和今天逐字相同。 */
function litPaint(paint, ctx) {
  const light = ctx?.light;
  const face = ctx?.face;
  if (!light || !face || !paint) return paint;
  if (typeof paint === "string") return tintHex(paint, light, face);
  /* tile 那种图案漆没有 color（铺的是素材），别给它凭空造一个 undefined 字段；
     底色和纹样都是漆，两样都跟着明暗走 */
  if (paint.type === "pattern") {
    const out = { ...paint };
    if (typeof out.color === "string") out.color = tintHex(out.color, light, face);
    if (typeof out.background === "string") out.background = tintHex(out.background, light, face);
    return out;
  }
  if (Array.isArray(paint.stops))
    return { ...paint, stops: paint.stops.map((one) => ({ ...one, color: tintHex(one.color, light, face) })) };
  return paint;
}

/* 现造的 defs 按「这份漆长什么样」缓存，一份只造一个节点。挂了光之后同一个素材
   朝左、朝右是两个颜色，缓存键必须带上生效的那个朝向——不然第二面朝的那份会复用
   第一面造好的 <g>，改了 face 却看不出任何变化。 */
const tintKey = (ctx) => (ctx?.light && ctx.face ? `\u0000${ctx.face}` : "");

/* 一个素材有哪些可选图层 / 变体：连组里都翻，报错时才报得全 */
function collectLayers(cmds, acc) {
  for (const cmd of cmds) {
    if (cmd.name && !acc.names.includes(cmd.name)) acc.names.push(cmd.name);
    for (const one of cmd.variants || []) if (!acc.variants.includes(one)) acc.variants.push(one);
    if (cmd.op === "group") collectLayers(cmd.cmds, acc);
  }
  return acc;
}

function symbolLayers(symbol, st) {
  /* 单独归一化一条指令时手上没有缓存，现算一份就用：省不了但不许算错 */
  const memo = st.layers || new Map();
  const hit = memo.get(symbol);
  if (hit) return hit;
  const built = collectLayers(symbol.cmds, { names: [], variants: [] });
  memo.set(symbol, built);
  return built;
}

/* 同一份「素材 + 这套开关」只投影一次：几百个小人点的是同一个键 */
function symbolView(symbols, memo, cmd) {
  const symbol = symbols ? symbols[cmd.ref] : null;
  if (!symbol) return null;
  const variant = cmd.variant || "";
  const hide = cmd.hide || [];
  const key = `${cmd.ref}\u0000${variant}\u0000${[...hide].sort().join(",")}`;
  const cache = memo || new Map();
  const hit = cache.get(key);
  if (hit) return hit;
  const built = { key, symbol, cmds: projectLayers(symbol.cmds, variant, hide) };
  cache.set(key, built);
  return built;
}

/* 素材表：{名字: {cmds, ox, oy, w, h}}。名字是 agent 自己起的中文，
   只当键用，不进 DOM —— 渲染用的 id 是递增的，省掉一整串转义麻烦。 */
export function normalizePictureSymbols(raw) {
  /* 空原型：素材名是调用方给的，"__proto__" 这种键往普通对象上塞会改掉原型链 */
  const symbols = Object.create(null);
  const dropped = [];
  if (raw == null) return { symbols, dropped };
  if (Array.isArray(raw) || typeof raw !== "object") {
    return { symbols, dropped: [{ name: "", why: `symbols 得是一个 {"名字":{cmds:[...]}} 对象（现在是 ${Array.isArray(raw) ? "数组" : typeof raw}）——${SYMBOL_RULE}` }] };
  }
  for (const [key, entry] of Object.entries(raw)) {
    /* 值是 null / undefined 的是「删掉这个素材」的记号，不是定义——归一化只管定义，
       当定义报错就会让一次成功的删除看起来像失败了 */
    if (entry == null) continue;
    const name = String(key).trim();
    if (!name || name.length > LAYER_NAME_MAX) {
      dropped.push({ name: String(key).slice(0, 40), why: `素材名${name ? `「${name.slice(0, 40)}」太长` : "没写"}——要 1~${LAYER_NAME_MAX} 个字` });
      continue;
    }
    if (Object.keys(symbols).length >= PICTURE_MAX_SYMBOLS) {
      dropped.push({ name, why: `素材表到了 ${PICTURE_MAX_SYMBOLS} 个上限，「${name}」没进` });
      continue;
    }
    const inner = normalizePictureCmds(entry?.cmds, PICTURE_MAX_SYMBOL_CMDS, { inSymbol: true });
    if (!inner.cmds.length) {
      const first = inner.dropped[0];
      dropped.push({
        name,
        fatal: inner.dropped.some((one) => one.fatal),
        why: !Array.isArray(entry?.cmds)
          ? `素材「${name}」的 cmds ${entry?.cmds == null ? "没给" : `不是数组（是 ${typeof entry.cmds}）`}——${SYMBOL_RULE}`
          : `素材「${name}」一条指令都没成立：第 ${first.at} 条——${first.why}`,
      });
      continue;
    }
    symbols[name] = {
      name,
      cmds: inner.cmds,
      ox: coord(entry.ox),
      oy: coord(entry.oy),
      w: Math.round(clamp(Number(entry.w) || 0, 0, 4000)),
      h: Math.round(clamp(Number(entry.h) || 0, 0, 4000)),
    };
    if (inner.dropped.length) {
      const first = inner.dropped[0];
      dropped.push({
        name,
        fatal: inner.dropped.some((one) => one.fatal),
        why: `素材「${name}」里有子指令没进：第 ${first.at} 条——${first.why}`,
      });
    }
  }
  return { symbols, dropped };
}

/* 便签：正文和颜色自成一件事，存在空间自己的 stickies/<id>.json 里 */
export function makeSticky(x, y, text = "") {
  return {
    id: newId(),
    type: "sticky",
    x,
    y,
    w: STICKY_DEFAULT_WIDTH,
    h: STICKY_DEFAULT_HEIGHT,
    text,
    color: STICKY_DEFAULT_COLOR,
    textColor: STICKY_DEFAULT_TEXT,
    borderColor: "",
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 笔记块默认存 Markdown 快照和一份「原图路径 → 空间副本」映射，编辑不动原 .md。
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
    borderColor: "",
    fillColor: "",
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 文件块只存定位用的路径和卡片上要显示的名字/体积/扩展名，内容不进 items.json。
   拷贝态 src 是空间 files/ 里的相对路径，引用态是原文件绝对路径。
   文本块给一个能读几行的默认高度，PDF 块按 A4 竖排给一屏，剩下由用户自己拉。 */
export function fileBlockSize(info) {
  const pdf = isPdfExt(info.ext);
  const text = info.text === true;
  return {
    w: pdf ? PDF_DEFAULT_WIDTH : text ? FILE_TEXT_WIDTH : FILE_DEFAULT_WIDTH,
    h: pdf ? PDF_DEFAULT_HEIGHT : text ? FILE_TEXT_EXPANDED_HEIGHT : FILE_DEFAULT_HEIGHT,
  };
}

export function makeFile(x, y, info) {
  const text = info.text === true;
  const linked = Boolean(info.linked);
  const size = fileBlockSize(info);
  return {
    id: newId(),
    type: "file",
    x,
    y,
    w: size.w,
    h: size.h,
    src: linked ? info.path : info.rel,
    name: info.name || "未命名文件",
    ext: info.ext || "",
    size: Math.max(0, Number(info.size) || 0),
    text,
    linked,
    borderColor: "",
    fillColor: "",
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 电子书块只记书在哪儿、读到第几章；正文每次现读，不往 items.json 里存书页。
   拷贝态 src 是空间 files/ 里的相对路径，引用态是原书绝对路径。 */
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
    color: accentStroke(),
    label: "",
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
  const h = item.type === "text" ? (el ? el.offsetHeight : item.h || 24) : item.h;
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
function elbowVertices(a, na, b, nb) {
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
function smoothPathThrough(a, na, b, nb, points) {
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
function missingLabel(item, copyText) {
  return item.linked ? "原文件不在了" : copyText;
}

const MISSING_FILE_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 3.5h7.4L18.5 8.6V20.5H6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M13.4 3.5v5.1h5.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M9.2 12.5l5.6 5.6M14.8 12.5l-5.6 5.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`;

/** 便签/笔记自己那份内容文件在空间目录里的相对位置；复制粘贴和丢文件卡都按它说话。 */
export function contentRelOf(item) {
  if (item.type === "sticky") return `stickies/${item.id}.json`;
  if (item.type === "note") return `notes/${item.id}.md`;
  return "";
}

/** 块指向的那份文件在磁盘上的绝对位置：引用态记的就是绝对路径，其余一律按空间目录拼。 */
export function absolutePathOf(item, canvasDir) {
  /* 笔记块上那个 path 只在引用态有意义：拷贝进来的那块还会留着「来自哪儿」，
     可它现在真正拥有的是空间里的 notes/<块id>.md */
  const pointer = item.linked ? (item.type === "note" ? item.path : item.src) : item.src;
  const rel = pointer || contentRelOf(item);
  if (!rel || item.linked) return rel;
  if (!canvasDir) return rel;
  return `${canvasDir.replace(/[\\/]$/, "")}\\${rel.replace(/[\\/]/g, "\\")}`;
}

/* 丢文件是所有块共用的一种状态，所以只长一张卡：图标和一句话一行，下面一行文件的绝对路径。
   块留在原地、宽高不变，只把内容换成这张卡；原文件放回原位后重开空间自己恢复。
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
  title.textContent = item.linked ? "原文件不在了" : "空间里的副本丢了";
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
    } else {
      el.append(createMissingCard(item, options.canvasDir));
    }
  } else if (item.type === "audio" || item.type === "video") {
    /* 音视频的数据是点开才取的，丢没丢只由这句 mediaMissing 说了算 */
    if (!item.src || options.mediaMissing) {
      el.append(createMissingCard(item, options.canvasDir));
    } else if (item.type === "audio") {
      el.append(createAudioPlayer(item, mediaSrc, options));
    } else {
      el.append(createVideoPlayer(item, mediaSrc, options));
    }
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
    el.append(card);
  } else if (item.type === "picture") {
    const card = document.createElement("div");
    card.className = "canvas-picture-card";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "canvas-picture-svg");
    card.append(svg);
    el.append(card);
  } else if (item.type === "scene") {
    /* 里面先只摆一句话：three.js 是点开才拉的，拉到之前这块就是「加载中」。
       canvas-scene-view 是渲染器挂 <canvas> 的宿主，卡片自身负责裁剪。 */
    const card = document.createElement("div");
    card.className = "canvas-scene-card";
    const view = document.createElement("div");
    view.className = "canvas-scene-view";
    const hint = document.createElement("p");
    hint.className = "canvas-scene-hint";
    hint.textContent = "场景加载中…";
    view.append(hint);
    card.append(view);
    el.append(card);
  } else if (item.type === "gen") {
    /* 上面是取景窗、下面是提示词和一颗开始。出图要几十秒，这一上半截就是给「等」留的。 */
    const card = document.createElement("div");
    card.className = "canvas-gen-card";
    const stage = document.createElement("div");
    stage.className = "canvas-gen-stage";
    const image = document.createElement("img");
    image.className = "canvas-gen-image";
    image.draggable = false;
    image.alt = "";
    const hint = document.createElement("p");
    hint.className = "canvas-gen-hint";
    stage.append(image, hint);
    const bar = document.createElement("div");
    bar.className = "canvas-gen-bar";
    /* 这一行只报「这张会怎么出」：接了几张输入图、走的哪一档。没接图就不占地方 */
    const feed = document.createElement("p");
    feed.className = "canvas-gen-feed";
    feed.hidden = true;
    const prompt = document.createElement("textarea");
    prompt.className = "canvas-gen-prompt";
    prompt.placeholder = "写下你想看的东西";
    prompt.rows = 3;
    prompt.spellcheck = false;
    const actions = document.createElement("div");
    actions.className = "canvas-gen-actions";
    const run = document.createElement("button");
    run.type = "button";
    run.className = "canvas-gen-run";
    const place = document.createElement("button");
    place.type = "button";
    place.className = "canvas-gen-place";
    place.textContent = "落块";
    actions.append(run, place);
    bar.append(feed, prompt, actions);
    card.append(stage, bar);
    el.append(card);
  } else if (item.type === "file") {
    el.append(createFileCard(item, options));
  } else if (item.type === "ebook") {
    el.append(createEbookCard(item, options));
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

/* 文本预览一次最多渲染这么多字：后端读的是 512KB 开头，全塞进 DOM 会拖慢空间 */
const PREVIEW_RENDER_CHARS = 20000;
const TABLE_EXTS = new Set(["csv", "tsv"]);
const TABLE_MAX_ROWS = 200;
const TABLE_MAX_COLS = 24;

/* 附件卡片：文件已经拷进空间的 files/ 了，这里负责把名字/体积说清楚，
   文本类的再附一段只读预览。要打开文件走右键菜单的「在文件夹中显示」。 */
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
  const sub = document.createElement("div");
  sub.className = "canvas-file-sub";
  sub.textContent = `${formatSize(item.size)}${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}`;
  main.append(name, sub);

  const head = document.createElement("div");
  head.className = "canvas-file-head";
  head.append(icon, main);
  card.append(head);

  /* 不管拷贝还是引用，进空间都问一句文件还在不在；
     丢了就整块换成统一那张丢文件卡，绝对路径写在卡上 */
  options.checkFile?.(item).then((found) => {
    if (!found) options.onMissing?.(item);
  });

  if (isPdfExt(item.ext)) {
    card.classList.add("canvas-file-card-pdf");
    card.append(createPdfBody(item, options));
    return card;
  }

  if (isDocxExt(item.ext)) {
    card.classList.add("canvas-file-card-docx");
    card.append(createDocxBody(item, options));
    return card;
  }

  if (isXlsxExt(item.ext)) {
    card.classList.add("canvas-file-card-xlsx");
    card.append(createXlsxBody(item, options));
    return card;
  }

  if (isPptxExt(item.ext)) {
    card.classList.add("canvas-file-card-pptx");
    card.append(createPptxBody(item, options));
    return card;
  }

  if (!item.text) return card;

  const body = document.createElement("div");
  body.className = "canvas-file-preview";
  card.append(body);
  attachPlainCopy(body);
  fillFilePreview(card, body, sub, item, options);
  return card;
}

/* 空间那边也靠这个决定给不给缩放手柄，所以是导出的 */
export function isPdfExt(ext) {
  return String(ext || "").toLowerCase() === "pdf";
}

/* 和 isPdfExt 一个套路，空间那边也靠它决定给不给缩放手柄 */
export function isDocxExt(ext) {
  return String(ext || "").toLowerCase() === "docx";
}

/* 同上：XLSX 块也靠它决定给不给缩放手柄 */
export function isXlsxExt(ext) {
  return String(ext || "").toLowerCase() === "xlsx";
}

/* PPTX 块：跟 docx/xlsx 一样的只读预览家族，靠它决定给不给缩放手柄 */
export function isPptxExt(ext) {
  return String(ext || "").toLowerCase() === "pptx";
}

/* PDF 块是一条纵向页链：滚轮一路往下就能读过整本，不用一下下点翻页。
   一块只把视窗附近那几页真画成位图，其余靠算出来的页高撑住滚动条——
   几百页全画出来内存先炸，什么都不画又没了位置感。
   底部一行照旧留着：跳整页比滚过去快，页码跟着视窗走。
   要在块里看小字就在块上拖角把宽度拉大，页链会按新宽度重排重画。 */

const PDF_PAGE_GAP = 10;      /* 页与页之间留条缝，滚的时候看得出换了页 */
const PDF_OVERSCAN = 1;       /* 视窗上下各多备一屏，滚到头不至于先看见空白 */
const PDF_MAX_PAGES = 8;      /* 同时挂着几页位图：2x 屏上一张 A4 就是几 MB，够眼前用了 */
const PDF_MEASURE_CHUNK = 12; /* 后台核对页高攒几页排一次版，别问一页重排一次 */

function createPdfBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-pdf";

  const stage = document.createElement("div");
  stage.className = "canvas-file-pdf-stage";
  const track = document.createElement("div");
  track.className = "canvas-file-pdf-track";
  stage.append(track);

  const bar = document.createElement("div");
  bar.className = "canvas-file-pdf-bar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "canvas-file-pdf-step";
  prev.append(chevronSvg("M10 4 6 8l4 4"));
  prev.title = "上一页";
  prev.setAttribute("aria-label", "上一页");
  const pos = document.createElement("span");
  pos.className = "canvas-file-pdf-pos";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "canvas-file-pdf-step";
  next.append(chevronSvg("M6 4l4 4-4 4"));
  next.title = "下一页";
  next.setAttribute("aria-label", "下一页");
  bar.append(prev, pos, next);

  const state = document.createElement("div");
  state.className = "canvas-file-pdf-state";
  state.hidden = true;

  wrap.append(stage, bar, state);
  for (const control of [prev, next]) stopOnCard(control);

  /* 页号 -> 此刻真挂在页链里的那一格（painted 才是已经画到位图上的） */
  const live = new Map();
  let dims = [];    /* 页号 -> 宽高，只用比值：渲染过的记 CSS 像素，后台核对的记 PDF 点 */
  let tops = [];    /* 页号 -> 这一页在页链里的起点 */
  let heights = [];
  let guess = null; /* 还没问到的页先按它撑，几百页不必一上来就问完 */
  let chain = 0;
  let url = "";
  let total = 0;
  let width = 0;
  /* 卡片被换掉（丢文件、复制进空间、重画整张）后旧回调不能再碰 DOM，作废看 seq；
     宽度又变了一轮，画到一半那一张也不认了，作废看 gen */
  let seq = 0;
  let gen = 0;
  let queue = [];
  let busy = null;
  /* 卡片还没进文档时量到的宽是 0，这一轮的活儿只能等 ResizeObserver 接手，
     但记忆里那个位置得先存着，不然接手时人已经被放到第一页了 */
  let pendingAnchor = null;

  const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
  const dimOf = (at) => dims[at] || guess;

  function chrome(at) {
    pos.textContent = total ? `${at} / ${total}` : "";
    prev.disabled = at <= 1;
    next.disabled = at >= total;
  }

  /* 读一份几十 MB 的书要半秒左右，这段时间在页下面留一行小字；第一页画出来就收掉 */
  function note(text) {
    state.hidden = !text;
    state.textContent = text;
  }

  function fail(text) {
    seq += 1;
    stage.hidden = true;
    bar.hidden = true;
    state.hidden = false;
    state.textContent = text;
  }

  function layout() {
    let y = 0;
    for (let at = 1; at <= total; at += 1) {
      const d = dimOf(at);
      const h = d && width ? Math.max(1, Math.round((d.height * width) / d.width)) : 0;
      tops[at] = y;
      heights[at] = h;
      const box = live.get(at);
      if (box) {
        box.el.style.top = `${y}px`;
        box.el.style.width = `${width}px`;
        box.el.style.height = `${h}px`;
        /* 位图是按旧宽度画的，先拉成新格子的大小顶一下，标脏排队重画 */
        if (box.renderedWidth !== width) {
          box.canvas.style.width = `${width}px`;
          box.canvas.style.height = `${h}px`;
          box.painted = false;
        }
      }
      y += h + PDF_PAGE_GAP;
    }
    chain = Math.max(0, y - PDF_PAGE_GAP);
    track.style.height = `${chain}px`;
  }

  function pageAt(y) {
    let lo = 1;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(Math.max(1, lo), total);
  }

  /* 位置记成「第几页 + 这页滚过去几成」：宽度再拉也没事，落回来还在同一行附近 */
  function anchor() {
    const at = pageAt(stage.scrollTop);
    return { page: at, frac: clamp01((stage.scrollTop - tops[at]) / (heights[at] || 1)) };
  }

  function restore(at, frac) {
    const y = (tops[at] || 0) + clamp01(frac) * (heights[at] || 0);
    stage.scrollTop = Math.max(0, Math.min(chain, y));
  }

  /* 页高补齐了：把它上面那些页多出来、少掉的那截补给滚动位置，
     眼前的字就不会被人推走——不补的话每核对一页，正文就往上蹿一截 */
  function relayout() {
    const at = anchor().page;
    const before = tops[at] || 0;
    layout();
    const delta = (tops[at] || 0) - before;
    if (delta) stage.scrollTop = Math.max(0, stage.scrollTop + delta);
  }

  /* 宽度是页链唯一的排版依据：变了就整个重排，画到一半的那张直接掐掉 */
  function applyWidth(next) {
    const a = pendingAnchor || anchor();
    pendingAnchor = null;
    width = next;
    gen += 1;
    if (busy) busy.slot.task?.cancel();
    layout();
    restore(a.page, a.frac);
    chrome(anchor().page);
    syncWindow();
  }

  function addSlot(at) {
    const el = document.createElement("div");
    el.className = "canvas-file-pdf-slot";
    el.style.top = `${tops[at]}px`;
    el.style.width = `${width}px`;
    el.style.height = `${heights[at]}px`;
    const canvas = document.createElement("canvas");
    canvas.className = "canvas-file-pdf-page";
    canvas.setAttribute("aria-label", `PDF 第 ${at} 页`);
    el.append(canvas);
    track.append(el);
    live.set(at, { el, canvas, painted: false, renderedWidth: 0 });
  }

  /* 只留离当前页最近的那几页：出界的连格子一起撤，浏览器才收得回那张位图 */
  function syncWindow() {
    if (!total || !width || stage.hidden) return;
    const near = anchor().page;
    const from = pageAt(Math.max(0, stage.scrollTop - stage.clientHeight * PDF_OVERSCAN));
    const to = pageAt(Math.min(chain, stage.scrollTop + stage.clientHeight * (1 + PDF_OVERSCAN)));
    const inWindow = [];
    for (let at = from; at <= to; at += 1) inWindow.push(at);
    inWindow.sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
    const keep = new Set(inWindow.slice(0, PDF_MAX_PAGES));
    for (const at of [...live.keys()]) {
      if (keep.has(at)) continue;
      live.get(at).el.remove();
      live.delete(at);
    }
    queue = [...keep].filter((at) => !live.get(at)?.painted);
    queue.sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
    for (const at of queue) if (!live.has(at)) addSlot(at);
    void pump();
  }

  /* 一次只画一张：多张并行会一起抢 worker，滚起来反而更慢 */
  async function pump() {
    if (busy) return;
    const at = queue.shift();
    if (!at) return;
    const box = live.get(at);
    if (!box || box.painted) {
      void pump();
      return;
    }
    const card = seq;
    const mine = gen;
    const slot = { task: null };
    busy = { slot };
    try {
      const result = await renderPdfPage({ url, page: at, canvas: box.canvas, width, slot });
      busy = null;
      if (card !== seq || mine !== gen || !wrap.isConnected) return;
      box.painted = true;
      box.renderedWidth = width;
      /* 真画出来的比例跟撑出来的格子对不上就以它为准，顺手重排一次 */
      if (Math.abs(result.height - (heights[at] || 0)) > 1) {
        dims[at] = { width: result.width, height: result.height };
        relayout();
      }
      note("");
      void pump();
    } catch (error) {
      busy = null;
      /* 掐掉的、作废的不算读坏了，接着画下一张 */
      if (isCancelled(error) || mine !== gen) {
        void pump();
        return;
      }
      fail(pdfProblem(error));
    }
  }

  function go(delta) {
    if (!total) return;
    restore(Math.min(Math.max(1, anchor().page + delta), total), 0);
  }

  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));

  let scrollTick = false;
  let notifyTimer = null;

  /* 存盘这一下攒着点：scheduleItemsSave 会顺带重画鸟瞰窗，滚一页的工夫敲几十次不值当 */
  function notifyPosition() {
    clearTimeout(notifyTimer);
    notifyTimer = null;
    if (!wrap.isConnected) return;
    const a = anchor();
    item.page = a.page;
    item.pageFrac = a.frac;
    options.onPdfPage?.(item);
  }

  stage.addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (!total || stage.hidden) return;
      const a = anchor();
      chrome(a.page);
      /* 读到哪儿当场就记在块上：他可能滚完这一下就切空间，字段得是新的 */
      item.page = a.page;
      item.pageFrac = a.frac;
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(notifyPosition, 400);
      syncWindow();
    });
  });
  stage.addEventListener("scrollend", notifyPosition);

  /* 拖角改宽度：整条页链按新宽重排，画过的先拉成新格子的大小顶着，再一页页重画清楚 */
  new ResizeObserver(() => {
    if (!total || stage.hidden) return;
    const now = stage.clientWidth;
    if (now <= 0 || Math.abs(now - width) < 1) return;
    applyWidth(now);
  }).observe(stage);

  /* 每页多大要一页页问 pdf.js（不画，读几 KB 字典就回），几百页得后台慢慢补。
     问回来一次重排一次，重排前给滚动位置补差价，所以补尺寸这件事他基本看不见。 */
  async function measureRest(mine) {
    let fresh = 0;
    for (let at = 1; at <= total; at += 1) {
      if (mine !== seq || !wrap.isConnected) return;
      if (dims[at]) continue;
      try {
        const box = await pdfPageSize(url, at);
        if (mine !== seq || !wrap.isConnected) return;
        dims[box.page] = { width: box.width, height: box.height };
        fresh += 1;
      } catch {
        return; /* 问不到就算了，反正有比例撑着，读不读得下去不归它 */
      }
      if (fresh >= PDF_MEASURE_CHUNK) {
        fresh = 0;
        relayout();
        /* 让出主线程，别让几百次询问把滚动卡成幻灯片 */
        await new Promise((done) => setTimeout(done, 0));
      }
    }
    if (fresh) relayout();
  }

  (async function start() {
    const mine = seq;
    if (!options.loadPdfUrl) {
      fail("这份 PDF 暂时预览不了");
      return;
    }
    note(`正在读这份 ${formatSize(item.size)} 的 PDF…`);
    try {
      url = await options.loadPdfUrl(item);
      const doc = await openPdf(url);
      if (mine !== seq || !wrap.isConnected) return;
      total = doc.numPages;
      dims = new Array(total + 1);
      tops = new Array(total + 1);
      heights = new Array(total + 1);
      bar.hidden = total <= 1;
      /* 先把记忆里那一页的尺寸问回来：页链撑得起来，才谈得上滚回上次那一行 */
      const at = Math.min(Math.max(1, Math.trunc(item.page) || 1), total);
      const first = await pdfPageSize(url, at);
      if (mine !== seq || !wrap.isConnected) return;
      guess = { width: first.width, height: first.height };
      dims[first.page] = guess;
      pendingAnchor = { page: at, frac: clamp01(item.pageFrac) };
      if (stage.clientWidth > 0) applyWidth(stage.clientWidth);
      else chrome(at);
      void measureRest(mine);
    } catch (error) {
      if (mine !== seq) return;
      fail(pdfProblem(error));
    }
  })();

  /* agent 通过这个控制器读页码、跳页：和底栏那两颗箭头走的是同一条恢复路径 */
  wrap.__agent = {
    get state() {
      if (!total) {
        return { ready: false, total: 0, page: Math.trunc(item.page) || 1, frac: item.pageFrac || 0 };
      }
      const a = anchor();
      return { ready: true, total, page: a.page, frac: a.frac };
    },
    goto(page) {
      if (!total) throw new Error("PDF 还没读完，稍后再试");
      const at = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), total);
      restore(at, 0);
      notifyPosition();
      const a = anchor();
      return { ready: true, total, page: a.page, frac: a.frac };
    },
  };

  return wrap;
}

function stopOnCard(button) {
  /* 卡片上的按钮归按钮自己，别顺手把块拖走 */
  for (const type of ["pointerdown", "dblclick"]) {
    button.addEventListener(type, (e) => e.stopPropagation());
  }
}

const stripExt = (name) => String(name || "").replace(/\.[^.\\/]+$/, "");

/* 书页不进鼠标路径，帧里那段注入脚本只报一个数字：正文排到多高。
   外层把它当成滚动区的 content height，滚动条、滚轮、右键、按下拖动就都是主文档自己的事。
   帧的可滚范围和外层是同一个数（正文高 − 视口高，两边同一个视口），所以每次它报完尺寸
   都把外层当前的位置压回去，两边就对不齐不了。 */
const pushEbookScroll = (frame) => {
  const scroll = frame.closest?.(".canvas-ebook-scroll");
  if (!scroll) return;
  frame.contentWindow?.postMessage({ type: "workbench:ebook-scroll", y: scroll.scrollTop }, "*");
};

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "workbench:ebook" || data.kind !== "height") return;
  const height = Number(data.h);
  if (!Number.isFinite(height) || height <= 0) return;
  /* 沙箱帧的 origin 是 "null"，只能按 source 认这是哪张纸 */
  const frame = [...document.querySelectorAll("iframe.canvas-ebook-page")].find(
    (f) => f.contentWindow === event.source,
  );
  if (!frame) return;
  const spacer = frame.parentElement;
  /* 拖拽缩放期间书页是被 transform 拉伸的预览，排版尺寸钉在起始值上，
     它报上来的高度也就还是起始宽度下的高度，别拿它去改滚动区 */
  if (frame.dataset.pinned) return;
  const next = `${Math.round(height)}px`;
  if (spacer.style.height !== next) spacer.style.height = next;
  pushEbookScroll(frame);
});

/* 电子书阅读块：书上架前先读一遍目录，读到第几章记在这块自己身上。
 * 正文塞进 sandbox="allow-scripts" 的 iframe：只给脚本，不给同源、不给读本地文件，
 * 所以图片得在后端转成 data URL。书自带的脚本仍然跑不起来 —— 后端 clean_html
 * 是标签/属性白名单，script 标签和 on* 属性根本进不了正文，这里能跑的只有
 * reader_wrap 注入的那一段「把右键报给外层」的转发。 */
function createEbookCard(item, options) {
  const card = document.createElement("div");
  card.className = "canvas-ebook-card";

  const head = document.createElement("div");
  head.className = "canvas-ebook-head";
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
  /* 滚动区是主文档自己的元素：悬停给出 move 光标、按下第一像素就能拖块、滚轮滚正文、
     右键走应用的块菜单。书页被钉在这块视口上（sticky），只照外层给的偏移滚自己。 */
  const scroll = document.createElement("div");
  scroll.className = "canvas-ebook-scroll";
  const spacer = document.createElement("div");
  spacer.className = "canvas-ebook-spacer";
  const frame = document.createElement("iframe");
  frame.className = "canvas-ebook-page";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "书页";
  spacer.append(frame);
  scroll.append(spacer);
  const state = document.createElement("div");
  state.className = "canvas-ebook-state";
  state.textContent = "正在排版…";
  body.append(scroll, state);
  card.append(head, body);

  /* 书页的排版高度 = 滚动区的可视高度（它是个视口，正文在它里面滚）。
     拖拽期间钉住尺寸，别让跨进程帧每一步都重新分配渲染表面。 */
  const fitPage = () => {
    if (frame.dataset.pinned) return;
    frame.style.height = `${Math.max(1, scroll.clientHeight)}px`;
  };
  new ResizeObserver(fitPage).observe(scroll);
  /* 外层滚了多少，就让帧里的正文跟着滚多少；一帧内多次滚动合并成一次 */
  let syncQueued = false;
  scroll.addEventListener("scroll", () => {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      pushEbookScroll(frame);
    });
  });
  scroll.addEventListener("pointerdown", (e) => {
    /* 按在滚动条上归浏览器拖滚动条，别顺手把整块拖走 */
    if (e.offsetX > scroll.clientWidth) e.stopPropagation();
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

  /* 书在、但读不出内容（DRM、空书）时才在块里留一行话；丢了走上面那张卡 */
  function fail(text) {
    seq += 1;
    state.hidden = false;
    state.textContent = text;
    scroll.hidden = true;
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
    scroll.hidden = false;
    state.hidden = false;
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
    /* 新一章从顶上看起；外层这条滚动条不会自己归零，等帧报新尺寸时再把 0 压回帧里 */
    scroll.scrollTop = 0;
    state.hidden = true;
    item.chapter = at;
    paintChrome();
    if (remember) options.onEbookPosition?.(item);
  }

  (async () => {
    /* 先问一句书还在不在，不在就把纸换成丢文件卡，不去读一本不存在的东西 */
    if (options.checkFile) {
      let found = true;
      try {
        found = await options.checkFile(item);
      } catch {
        found = true;
      }
      if (found === false) {
        if (card.isConnected) options.onMissing?.(item);
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

  /* agent 控制器：目录、当前章、跳章，跟工具栏那三件套共用 showChapter */
  const agentState = () => {
    const total = book?.chapters?.length || 0;
    return {
      ready: Boolean(book),
      total,
      chapter: total ? Math.min(item.chapter, total - 1) : item.chapter || 0,
      title: book?.title || title.textContent,
      chapters: book?.chapters || [],
    };
  };
  card.__agent = {
    get state() {
      return agentState();
    },
    async goto(index) {
      if (!book) throw new Error("这本书还没读进来，稍后再试");
      const at = Math.min(Math.max(0, Math.trunc(Number(index)) || 0), book.chapters.length - 1);
      await showChapter(at, true);
      return agentState();
    },
  };

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

/* DOCX 块：mammoth 把 docx（一个 zip 包）转成语义化 HTML，灌进卡片当只读预览。
   标题/段落/列表/表格/加粗斜体/超链接/内嵌图片都能出来，和 PDF 看页、电子书看章节同级。
   图片默认被 mammoth 转成 base64 内联，WebView 里直接显示，不依赖外部资源。 */

const DOCX_MAX_BYTES = 30 * 1024 * 1024; /* 带图的 docx 可能很大，整本读进内存前先拦一道 */

/* 在只读预览区里复制时，把选区转成纯文本再写进剪贴板：保留段落/标题/列表的换行，
   但丢掉 HTML 标签。否则 WebView 会把 HTML 序列化（带 <p>/<h1> 等标签）写进剪贴板，
   粘贴到别处就露出源码。Selection.toString() 拿到的就是浏览器原本要作为 text/plain
   复制的那份纯文本，天然带块级换行、没有标签。 */
function attachPlainCopy(el) {
  el.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    const text = sel.toString();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  });
}

function createDocxBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-docx";

  const state = document.createElement("div");
  state.className = "canvas-file-docx-state";
  state.textContent = "正在解析 DOCX…";
  wrap.append(state);

  const content = document.createElement("div");
  content.className = "canvas-file-docx-body";
  content.hidden = true;
  wrap.append(content);

  attachPlainCopy(content);
  loadDocxPreview(wrap, content, state, item, options);
  return wrap;
}

async function loadDocxPreview(wrap, content, state, item, options) {
  if (item.size && item.size > DOCX_MAX_BYTES) {
    failDocx(state, content, "文件太大（超过 30MB），暂不预览");
    return;
  }
  let url;
  try {
    url = await options.loadDocxUrl?.(item);
  } catch (error) {
    failDocx(state, content, error);
    return;
  }
  if (!url || !wrap.isConnected) return;
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`取文件失败（${res.status}）`);
    buffer = await res.arrayBuffer();
  } catch (error) {
    failDocx(state, content, error);
    return;
  }
  if (!wrap.isConnected) return;
  try {
    const html = await convertDocx(buffer);
    content.innerHTML =
      html || "<p class=\"canvas-file-docx-empty\">（这份 DOCX 里没有可显示的文字）</p>";
    state.hidden = true;
    content.hidden = false;
  } catch (error) {
    failDocx(state, content, error);
  }
}

function convertDocx(buffer) {
  const lib = window.mammoth;
  if (lib && typeof lib.convertToHtml === "function") {
    return lib.convertToHtml({ arrayBuffer: buffer }).then((result) => result.value);
  }
  return Promise.reject(new Error("DOCX 预览组件没加载（mammoth 不可用）"));
}

function failDocx(state, content, error) {
  const message = error && error.message ? error.message : String(error);
  state.className = "canvas-file-docx-state is-failed";
  state.textContent = message;
  state.hidden = false;
  content.hidden = true;
}

/* XLSX 块：把表格读成数据、自己画成 HTML 表，不做像素级还原。
   一个工作簿有多张表，就给一张表一排标签，点哪个亮哪个。 */

const XLSX_MAX_BYTES = 30 * 1024 * 1024; /* 整本读进内存前先拦一道，跟 docx 一个尺度 */
const XLSX_MAX_ROWS = 1000;   /* 单表超过这一行就只画前面这些，避免一次塞几千行卡死预览 */
const XLSX_MAX_COLS = 200;    /* 单列同理 */

function createXlsxBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-xlsx";

  const tabs = document.createElement("div");
  tabs.className = "canvas-file-xlsx-tabs";
  tabs.hidden = true;

  const state = document.createElement("div");
  state.className = "canvas-file-xlsx-state";
  state.textContent = "正在解析 XLSX…";

  const scroller = document.createElement("div");
  scroller.className = "canvas-file-xlsx-scroll";
  scroller.hidden = true;

  wrap.append(tabs, state, scroller);
  attachPlainCopy(scroller);

  loadXlsxPreview(wrap, tabs, scroller, state, item, options);
  return wrap;
}

async function loadXlsxPreview(wrap, tabs, scroller, state, item, options) {
  if (item.size && item.size > XLSX_MAX_BYTES) {
    failXlsx(state, scroller, "文件太大（超过 30MB），暂不预览");
    return;
  }
  let url;
  try {
    url = await options.loadXlsxUrl?.(item);
  } catch (error) {
    failXlsx(state, scroller, error);
    return;
  }
  if (!url || !wrap.isConnected) return;
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`取文件失败（${res.status}）`);
    buffer = await res.arrayBuffer();
  } catch (error) {
    failXlsx(state, scroller, error);
    return;
  }
  if (!wrap.isConnected) return;
  try {
    renderWorkbook(scroller, tabs, buffer, state);
    if (!scroller.firstChild) {
      state.className = "canvas-file-xlsx-state is-failed";
      state.textContent = "（这份 XLSX 里没有可显示的表格）";
      state.hidden = false;
      scroller.hidden = true;
      return;
    }
    state.hidden = true;
    tabs.hidden = false;
    scroller.hidden = false;
  } catch (error) {
    failXlsx(state, scroller, error);
  }
}

/* 读工作簿 -> 给每张表造一个 table，全部塞进 scroller，只亮第一张；
   标签点哪个就切哪张。表头加粗、合并单元格用 rowspan/colspan 还原。 */
function renderWorkbook(scroller, tabs, buffer, state) {
  const lib = window.XLSX;
  if (!lib || typeof lib.read !== "function") {
    throw new Error("XLSX 预览组件没加载（SheetJS 不可用）");
  }
  const wb = lib.read(buffer, { type: "array" });
  const names = wb.SheetNames || [];
  if (!names.length) {
    state.textContent = "（这份 XLSX 里没有工作表）";
    return;
  }
  const sheets = [];
  for (const name of names) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const table = buildSheetTable(lib, ws);
    sheets.push({ name, table });
  }
  if (!sheets.length) {
    state.textContent = "（这份 XLSX 里没有可显示的表格）";
    return;
  }
  const panels = [];
  sheets.forEach((sheet, idx) => {
    const panel = document.createElement("div");
    panel.className = "canvas-file-xlsx-sheet";
    panel.hidden = idx !== 0;
    panel.append(sheet.table);
    scroller.append(panel);
    panels.push(panel);

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "canvas-file-xlsx-tab" + (idx === 0 ? " is-active" : "");
    tab.textContent = sheet.name;
    tab.setAttribute("aria-label", sheet.name);
    stopOnCard(tab);
    tab.addEventListener("click", () => {
      panels.forEach((p, i) => (p.hidden = i !== idx));
      for (const t of tabs.children) t.classList.toggle("is-active", t === tab);
    });
    tabs.append(tab);
  });
}

/* 一张表 -> 一张 <table>。按 ref 的矩形逐格取，空格留空，合并格用 span 还原。 */
function buildSheetTable(lib, ws) {
  const range = lib.utils.decode_range(ws["!ref"]);
  const maxRow = Math.min(range.e.r, range.s.r + XLSX_MAX_ROWS - 1);
  const maxCol = Math.min(range.e.c, range.s.c + XLSX_MAX_COLS - 1);

  /* 合并区域：被盖住的格跳过，左上格记上跨行跨列 */
  const skip = new Set();
  const spans = new Map();
  if (ws["!merges"]) {
    for (const m of ws["!merges"]) {
      const rs = m.e.r - m.s.r + 1;
      const cs = m.e.c - m.s.c + 1;
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r === m.s.r && c === m.s.c) spans.set(`${r},${c}`, { rs, cs });
          else skip.add(`${r},${c}`);
        }
      }
    }
  }

  const table = document.createElement("table");
  table.className = "canvas-file-xlsx-table";
  for (let r = range.s.r; r <= maxRow; r++) {
    const tr = document.createElement("tr");
    for (let c = range.s.c; c <= maxCol; c++) {
      const key = `${r},${c}`;
      if (skip.has(key)) continue;
      const addr = lib.utils.encode_cell({ r, c });
      const cell = ws[addr];
      const value = cell ? cell.w != null ? cell.w : String(cell.v ?? "") : "";
      const th = r === range.s.r; /* 第一行当作表头 */
      const td = document.createElement(th ? "th" : "td");
      td.textContent = value;
      const span = spans.get(key);
      if (span) {
        if (span.rs > 1) td.rowSpan = span.rs;
        if (span.cs > 1) td.colSpan = span.cs;
      }
      tr.append(td);
    }
    table.append(tr);
  }
  if (maxRow < range.e.r || maxCol < range.e.c) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "canvas-file-xlsx-trunc";
    td.colSpan = maxCol - range.s.c + 1;
    td.textContent = `… 仅预览前 ${maxRow - range.s.r + 1} 行 / ${maxCol - range.s.c + 1} 列（完整内容请用 Excel 打开）`;
    tr.append(td);
    table.append(tr);
  }
  return table;
}

function failXlsx(state, scroller, error) {
  const message = error && error.message ? error.message : String(error);
  state.className = "canvas-file-xlsx-state is-failed";
  state.textContent = message;
  state.hidden = false;
  scroller.hidden = true;
}

/* PPTX 块：把每一页拆成绝对定位的文本框/图片/表格，按原始版面比例还原。
   不做像素级还原（图表、SmartArt、动画都跳过），但文本、图片、表格的位置和
   字号、颜色尽量贴近原稿，足够预览内容。PPTX 是 OOXML 压缩包：用 JSZip 解包，
   逐页读 slideN.xml，图片从 ppt/media 里取。 */

const PPTX_MAX_BYTES = 30 * 1024 * 1024; /* 整包读进内存前先拦一道，跟 docx/xlsx 一个尺度 */
const PPTX_MAX_SLIDES = 100; /* 超过这么多页就只预览前面这些，避免一次解几百页卡死 */
const PPTX_EMU_PER_PX = 9525; /* 914400 EMU/英寸 ÷ 96 px/英寸，内部按固定 96DPI 渲染 */
const PPTX_THUMB_W = 132; /* 缩略图条里每张缩略图的宽度（px） */
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/* 配色方案默认映射：稿件里 schemeClr 的 tx1/bg1 等经 clrMap 落到 dk1/lt1 等具体色 */
const PPTX_SCHEME_MAP = {
  tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2",
  accent1: "accent1", accent2: "accent2", accent3: "accent3",
  accent4: "accent4", accent5: "accent5", accent6: "accent6",
  hlink: "hlink", folHlink: "folHlink",
};

function createPptxBody(item, options) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-file-pptx";

  const state = document.createElement("div");
  state.className = "canvas-file-pptx-state";
  state.textContent = "正在解析 PPTX…";

  const scroller = document.createElement("div");
  scroller.className = "canvas-file-pptx-scroll";
  scroller.hidden = true;

  wrap.append(state, scroller);
  attachPlainCopy(scroller);
  loadPptxPreview(wrap, scroller, state, item, options);
  return wrap;
}

async function loadPptxPreview(wrap, scroller, state, item, options) {
  if (item.size && item.size > PPTX_MAX_BYTES) {
    failPptx(state, scroller, "文件太大（超过 30MB），暂不预览");
    return;
  }
  let url;
  try {
    url = await options.loadPptxUrl?.(item);
  } catch (error) {
    failPptx(state, scroller, error);
    return;
  }
  if (!url || !wrap.isConnected) return;
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`取文件失败（${res.status}）`);
    buffer = await res.arrayBuffer();
  } catch (error) {
    failPptx(state, scroller, error);
    return;
  }
  if (!wrap.isConnected) return;
  try {
    const doc = await parsePptx(buffer);
    if (!doc.slides.length) {
      state.className = "canvas-file-pptx-state is-failed";
      state.textContent = "（这份 PPTX 里没有可显示的幻灯片）";
      state.hidden = false;
      scroller.hidden = true;
      return;
    }
    renderPptx(scroller, doc, state);
    state.hidden = true;
    scroller.hidden = false;
  } catch (error) {
    failPptx(state, scroller, error);
  }
}

/* 解包 + 读页序 + 读主题色 + 逐页解析。图片按路径缓存成 object URL，避免重复解同一张。 */
async function parsePptx(buffer) {
  const lib = window.JSZip;
  if (!lib || typeof lib.loadAsync !== "function") {
    throw new Error("PPTX 预览组件没加载（JSZip 不可用）");
  }
  const zip = await lib.loadAsync(buffer);
  const files = zip.files;
  const names = Object.keys(files);

  let slidePaths = await resolveSlideOrder(zip);
  if (!slidePaths.length) {
    slidePaths = names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => pptxNumSuffix(a) - pptxNumSuffix(b));
  }
  /* 页序里个别 target 可能对不上实际文件（稿件不规范），只留真实存在的，别让一页拖垮整份 */
  slidePaths = slidePaths.filter((p) => files[p]).slice(0, PPTX_MAX_SLIDES);

  const clrScheme = await readThemeColors(zip);
  const sldSz = await readSlideSize(zip);
  const mediaCache = new Map();

  const slides = [];
  for (const path of slidePaths) {
    const xml = await files[path].async("string");
    const relMap = await readSlideRels(zip, path);
    const slide = await parseSlide(xml, relMap, zip, mediaCache, clrScheme);
    slides.push(slide);
  }
  return { slides, sldSz, mediaCache };
}

/* presentation.xml 的 sldIdLst 决定真正页序（含重排），比按文件名排序更准 */
async function resolveSlideOrder(zip) {
  const presFile = zip.file("ppt/presentation.xml");
  if (!presFile) return [];
  const doc = parseXml(await presFile.async("string"));
  if (!doc) return [];
  const sldIdLst = firstByLocal(doc, "sldIdLst");
  if (!sldIdLst) return [];
  const rIds = [];
  for (const el of childrenByLocal(sldIdLst, "sldId")) {
    const rid = el.getAttribute("r:id") || el.getAttributeNS(R_NS, "id");
    if (rid) rIds.push(rid);
  }
  if (!rIds.length) return [];
  const relMap = await readRels(zip, "ppt/presentation.xml");
  const paths = [];
  for (const rid of rIds) {
    const target = relMap.get(rid);
    if (target) paths.push(pptxResolveTarget("ppt/", target));
  }
  return paths;
}

async function readRels(zip, xmlPath) {
  const dir = xmlPath.includes("/") ? xmlPath.slice(0, xmlPath.lastIndexOf("/") + 1) : "";
  const baseName = xmlPath.slice(dir.length);
  const relsPath = `${dir}_rels/${baseName}.rels`;
  const map = new Map();
  const f = zip.file(relsPath);
  if (!f) return map;
  const doc = parseXml(await f.async("string"));
  if (!doc) return map;
  for (const rel of childrenByLocal(doc.documentElement, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

async function readSlideRels(zip, slidePath) {
  return readRels(zip, slidePath);
}

async function readSlideSize(zip) {
  const f = zip.file("ppt/presentation.xml");
  if (!f) return { cx: 12192000, cy: 6858000 };
  const doc = parseXml(await f.async("string"));
  const sldSz = doc && firstByLocal(doc, "sldSz");
  if (sldSz) {
    const cx = parseInt(sldSz.getAttribute("cx") || "", 10);
    const cy = parseInt(sldSz.getAttribute("cy") || "", 10);
    if (cx > 0 && cy > 0) return { cx, cy };
  }
  return { cx: 12192000, cy: 6858000 };
}

async function readThemeColors(zip) {
  const themeFile =
    zip.file("ppt/theme/theme1.xml") ||
    zip.file(Object.keys(zip.files).find((n) => /^ppt\/theme\/theme\d+\.xml$/i.test(n)) || "");
  const map = new Map();
  if (!themeFile) return map;
  const doc = parseXml(await themeFile.async("string"));
  if (!doc) return map;
  const clrScheme = firstByLocal(doc, "clrScheme");
  if (!clrScheme) return map;
  for (const child of clrScheme.children) {
    const name = child.localName;
    if (!name) continue;
    const srgb = firstByLocal(child, "srgbClr");
    if (srgb) {
      map.set(name, "#" + (srgb.getAttribute("val") || "000000"));
      continue;
    }
    const sys = firstByLocal(child, "sysClr");
    if (sys) map.set(name, "#" + (sys.getAttribute("lastClr") || "000000"));
  }
  return map;
}

async function parseSlide(xml, relMap, zip, mediaCache, clrScheme) {
  const doc = parseXml(xml);
  const slide = { shapes: [], bg: null };
  if (!doc) return slide;
  const spTree = firstByLocal(doc, "spTree");
  if (!spTree) return slide;
  await walkShapes(spTree, slide, relMap, zip, mediaCache, clrScheme, 0, 0, 1, 1);
  const bg = firstByLocal(doc, "bg");
  if (bg) slide.bg = readFill(firstByLocal(bg, "bgPr"), clrScheme);
  return slide;
}

/* 递归走 spTree：文本框、图片、表格各自处理；组合图形(grpSp)把子元素按组变换映射回页面坐标 */
async function walkShapes(node, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  for (const child of node.children) {
    const ln = child.localName;
    if (ln === "sp" || ln === "cxsp") {
      handleShape(child, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY);
    } else if (ln === "pic") {
      await handlePic(child, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY);
    } else if (ln === "graphicFrame") {
      handleGraphicFrame(child, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY);
    } else if (ln === "grpSp") {
      const g = readXfrm(child);
      let ngx = gx, ngy = gy, nsx = gScaleX, nsy = gScaleY;
      if (g && g.chExtCx && g.chExtCy) {
        const sx = g.extCx / g.chExtCx;
        const sy = g.extCy / g.chExtCy;
        ngx = gx + (g.offX - g.chOffX) * gScaleX;
        ngy = gy + (g.offY - g.chOffY) * gScaleY;
        nsx = gScaleX * sx;
        nsy = gScaleY * sy;
      }
      await walkShapes(child, slide, relMap, zip, mediaCache, clrScheme, ngx, ngy, nsx, nsy);
    }
  }
}

function handleShape(sp, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  const txBody = firstByLocal(sp, "txBody");
  if (!txBody) return;
  const paras = extractText(txBody, clrScheme).paras;
  if (!paras.length) return;
  const xfrm = readXfrm(sp);
  const pos = xfrm
    ? { x: gx + xfrm.offX * gScaleX, y: gy + xfrm.offY * gScaleY, w: xfrm.extCx * gScaleX, h: xfrm.extCy * gScaleY }
    : { x: 0, y: 0, w: 0, h: 0 };
  const bodyPr = firstByLocal(txBody, "bodyPr");
  const anchor = bodyPr ? bodyPr.getAttribute("anchor") || "" : "";
  slide.shapes.push({ type: "text", pos, paras, anchor });
}

async function handlePic(pic, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  const xfrm = readXfrm(pic);
  const blip = firstByLocal(pic, "blip");
  const embed = blip ? blip.getAttribute("r:embed") || blip.getAttributeNS(R_NS, "embed") : null;
  let imgUrl = "";
  if (embed && relMap.has(embed)) {
    const mediaPath = pptxResolveTarget("ppt/slides/", relMap.get(embed));
    imgUrl = await getMediaUrl(zip, mediaPath, mediaCache);
  }
  const pos = xfrm
    ? { x: gx + xfrm.offX * gScaleX, y: gy + xfrm.offY * gScaleY, w: xfrm.extCx * gScaleX, h: xfrm.extCy * gScaleY }
    : { x: 0, y: 0, w: 0, h: 0 };
  slide.shapes.push({ type: "pic", pos, imgUrl });
}

function handleGraphicFrame(gf, slide, relMap, zip, mediaCache, clrScheme, gx, gy, gScaleX, gScaleY) {
  const graphicData = firstByLocal(gf, "graphicData");
  const tbl = graphicData && descendantByLocal(graphicData, "tbl");
  if (!tbl) return;
  const xfrm = readXfrm(gf);
  const pos = xfrm
    ? { x: gx + xfrm.offX * gScaleX, y: gy + xfrm.offY * gScaleY, w: xfrm.extCx * gScaleX, h: xfrm.extCy * gScaleY }
    : { x: 0, y: 0, w: 0, h: 0 };
  slide.shapes.push({ type: "table", pos, table: parseTable(tbl, clrScheme) });
}

/* 一个文本框 -> 段落数组；每段带对齐/项目符号，段内是带样式的 run */
function extractText(txBody, clrScheme) {
  const paras = [];
  for (const p of childrenByLocal(txBody, "p")) {
    const pPr = firstByLocal(p, "pPr");
    const align = pPr ? pPr.getAttribute("algn") || "" : "";
    const bullet = hasBullet(pPr);
    const runs = [];
    for (const child of p.children) {
      const ln = child.localName;
      if (ln === "r") {
        const rPr = firstByLocal(child, "rPr");
        const t = firstByLocal(child, "t");
        if (!t || !t.textContent) continue;
        runs.push({
          text: t.textContent,
          bold: rPr ? rPr.getAttribute("b") === "1" || rPr.getAttribute("b") === "" : false,
          italic: rPr ? rPr.getAttribute("i") === "1" || rPr.getAttribute("i") === "" : false,
          sz: rPr ? parseFloat(rPr.getAttribute("sz") || "1800") : 1800,
          color: rPr ? readRunColor(rPr, clrScheme) : "#000000",
        });
      } else if (ln === "br") {
        runs.push({ br: true });
      }
    }
    paras.push({ align, bullet, runs });
  }
  return { paras };
}

function hasBullet(pPr) {
  if (!pPr) return false;
  if (firstByLocal(pPr, "buNone")) return false;
  return !!(firstByLocal(pPr, "buChar") || firstByLocal(pPr, "buAutoNum"));
}

function readRunColor(rPr, clrScheme) {
  const solid = firstByLocal(rPr, "solidFill");
  if (solid) {
    const srgb = firstByLocal(solid, "srgbClr");
    if (srgb) return "#" + (srgb.getAttribute("val") || "000000");
    const scheme = firstByLocal(solid, "schemeClr");
    if (scheme) {
      const mapped = pptxMapScheme(scheme.getAttribute("val") || "", clrScheme);
      if (mapped) return mapped;
    }
  }
  return "#000000";
}

function pptxMapScheme(v, clrScheme) {
  const key = PPTX_SCHEME_MAP[v] || v;
  return clrScheme.get(key) || null;
}

function readFill(el, clrScheme) {
  if (!el) return null;
  const solid = firstByLocal(el, "solidFill");
  if (!solid) return null;
  const srgb = firstByLocal(solid, "srgbClr");
  if (srgb) return "#" + (srgb.getAttribute("val") || "000000");
  const scheme = firstByLocal(solid, "schemeClr");
  if (scheme) return pptxMapScheme(scheme.getAttribute("val") || "", clrScheme) || null;
  return null;
}

function parseTable(tbl, clrScheme) {
  const rows = [];
  for (const tr of childrenByLocal(tbl, "tr")) {
    const cells = [];
    for (const tc of childrenByLocal(tr, "tc")) {
      const txBody = firstByLocal(tc, "txBody");
      const text = txBody ? extractText(txBody, clrScheme) : { paras: [] };
      const gs = firstByLocal(tc, "gridSpan");
      const rs = firstByLocal(tc, "rowSpan");
      const gridSpan = gs ? parseInt(gs.getAttribute("val") || "1", 10) || 1 : 1;
      const rowSpan = rs ? parseInt(rs.getAttribute("val") || "1", 10) || 1 : 1;
      cells.push({ text, gridSpan, rowSpan });
    }
    rows.push({ cells });
  }
  return { rows };
}

/* 把一页画成「固定 96DPI 的内部舞台 + 整体缩放」：位置、字号都按 EMU→px 算准，
   再用 transform: scale 适配卡片宽度，所有比例天然跟着缩放，不用逐像素调字号 */
function buildSlideNode(slide, sldSz, targetWidth) {
  const stageW = sldSz.cx / PPTX_EMU_PER_PX;
  const stageH = sldSz.cy / PPTX_EMU_PER_PX;

  const inner = document.createElement("div");
  inner.className = "canvas-file-pptx-slide";
  inner.style.width = stageW + "px";
  inner.style.height = stageH + "px";
  if (slide.bg) inner.style.background = slide.bg;

  for (const shape of slide.shapes) {
    if (shape.type === "text") {
      const box = document.createElement("div");
      box.className = "pptx-textbox";
      const x = shape.pos.x / PPTX_EMU_PER_PX;
      const y = shape.pos.y / PPTX_EMU_PER_PX;
      const w = shape.pos.w / PPTX_EMU_PER_PX;
      const h = shape.pos.h / PPTX_EMU_PER_PX;
      box.style.left = x + "px";
      box.style.top = y + "px";
      if (w) box.style.width = w + "px";
      if (h) box.style.height = h + "px";
      if (shape.anchor === "ctr") box.style.justifyContent = "center";
      else if (shape.anchor === "b") box.style.justifyContent = "flex-end";
      for (const para of shape.paras) box.append(buildParagraph(para));
      inner.append(box);
    } else if (shape.type === "pic") {
      if (shape.imgUrl) {
        const img = document.createElement("img");
        img.className = "pptx-img";
        img.src = shape.imgUrl;
        img.draggable = false;
        img.style.left = shape.pos.x / PPTX_EMU_PER_PX + "px";
        img.style.top = shape.pos.y / PPTX_EMU_PER_PX + "px";
        if (shape.pos.w) img.style.width = shape.pos.w / PPTX_EMU_PER_PX + "px";
        if (shape.pos.h) img.style.height = shape.pos.h / PPTX_EMU_PER_PX + "px";
        inner.append(img);
      }
    } else if (shape.type === "table") {
      const tbl = buildTableEl(shape);
      tbl.style.left = shape.pos.x / PPTX_EMU_PER_PX + "px";
      tbl.style.top = shape.pos.y / PPTX_EMU_PER_PX + "px";
      if (shape.pos.w) tbl.style.width = shape.pos.w / PPTX_EMU_PER_PX + "px";
      inner.append(tbl);
    }
  }

  const scaler = document.createElement("div");
  scaler.className = "canvas-file-pptx-slidewrap";
  scaler.append(inner);
  if (targetWidth) {
    const scale = targetWidth / stageW;
    inner.style.transform = `scale(${scale})`;
    scaler.style.width = targetWidth + "px";
    scaler.style.height = stageH * scale + "px";
  }
  return { scaler, inner, stageW, stageH };
}

function buildParagraph(para) {
  const p = document.createElement("p");
  if (para.align) p.style.textAlign = para.align;
  if (para.bullet) p.classList.add("pptx-bullet");
  for (const run of para.runs) {
    if (run.br) {
      p.append(document.createElement("br"));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = run.text;
    span.style.fontWeight = run.bold ? "700" : "400";
    span.style.fontStyle = run.italic ? "italic" : "normal";
    span.style.fontSize = run.sz / 75 + "px"; /* 96DPI：sz(百分之一磅)/100×96/72 = sz/75 */
    span.style.color = run.color;
    p.append(span);
  }
  return p;
}

function buildTableEl(shape) {
  const tbl = document.createElement("table");
  tbl.className = "pptx-table";
  const table = shape.table;
  const skip = new Set();
  let rIdx = 0;
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    let cIdx = 0;
    for (const cell of row.cells) {
      while (skip.has(rIdx + "," + cIdx)) cIdx++;
      const td = document.createElement("td");
      for (const para of cell.text.paras) td.append(buildParagraph(para));
      if (cell.gridSpan > 1) td.colSpan = cell.gridSpan;
      if (cell.rowSpan > 1) {
        td.rowSpan = cell.rowSpan;
        for (let rr = 1; rr < cell.rowSpan; rr++) skip.add(rIdx + rr + "," + cIdx);
      }
      if (!td.firstChild) td.append(document.createTextNode(""));
      tr.append(td);
      cIdx += cell.gridSpan > 1 ? cell.gridSpan : 1;
    }
    tbl.append(tr);
    rIdx++;
  }
  return tbl;
}

/* 主舞台适配卡片宽度：量出容器宽再算缩放。只返回 apply，由调用方在把 scaler 挂进
   文档之后统一观察 stage：观察 scaler 自己会在回调里改它高度、触发下一轮通知
   （控制台会报 ResizeObserver loop），观察父级 stage 就不会自激。 */
function layoutSlideFit(scaler, inner, stageW, stageH) {
  const apply = () => {
    const cw = scaler.clientWidth;
    if (!cw) return;
    const scale = cw / stageW;
    inner.style.transform = `scale(${scale})`;
    const h = stageH * scale;
    if (Math.abs((parseFloat(scaler.style.height) || 0) - h) > 0.5) {
      scaler.style.height = h + "px";
    }
  };
  apply();
  return apply;
}

function renderPptx(scroller, doc, state) {
  const { slides, sldSz } = doc;
  const n = slides.length;
  let current = 0;

  const toolbar = document.createElement("div");
  toolbar.className = "canvas-file-pptx-bar";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "canvas-file-pptx-nav";
  prev.textContent = "‹";
  const counter = document.createElement("span");
  counter.className = "canvas-file-pptx-count";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "canvas-file-pptx-nav";
  next.textContent = "›";
  toolbar.append(prev, counter, next);

  const stage = document.createElement("div");
  stage.className = "canvas-file-pptx-stage";

  const thumbs = document.createElement("div");
  thumbs.className = "canvas-file-pptx-thumbs";

  const built = slides.map((slide) => {
    const main = buildSlideNode(slide, sldSz, null);
    main.apply = layoutSlideFit(main.scaler, main.inner, main.stageW, main.stageH);
    const thumb = buildSlideNode(slide, sldSz, PPTX_THUMB_W);
    thumb.scaler.classList.add("canvas-file-pptx-thumb");
    return { main, thumb };
  });

  function show(i) {
    current = (i + n) % n;
    built.forEach((b, idx) => {
      b.main.scaler.hidden = idx !== current;
      b.thumb.scaler.classList.toggle("is-active", idx === current);
    });
    built[current].main.apply(); /* 主动算一次：隐藏→显示不一定触发 ResizeObserver */
    counter.textContent = `第 ${current + 1} / ${n} 张`;
    const activeThumb = thumbs.children[current];
    if (activeThumb && activeThumb.scrollIntoView) {
      activeThumb.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  prev.addEventListener("click", () => show(current - 1));
  next.addEventListener("click", () => show(current + 1));
  stopOnCard(prev);
  stopOnCard(next);

  built.forEach((b, idx) => {
    stopOnCard(b.thumb.scaler);
    b.thumb.scaler.addEventListener("click", () => show(idx));
    stage.append(b.main.scaler);
    thumbs.append(b.thumb.scaler);
  });

  scroller.append(toolbar, stage, thumbs);
  show(0);

  /* 一个观察者盯住 stage：卡片被拉宽/拉高时只重算当前这页，不会因为改 scaler 高度而自激 */
  if (typeof ResizeObserver !== "undefined") {
    stage.__ro = new ResizeObserver(() => built[current].main.apply());
    stage.__ro.observe(stage);
  }
}

/* 小工具：XML 解析（容错）、按 localName 取元素、路径规整、媒体取 blob URL */
function parseXml(text) {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc && doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  } catch {
    return null;
  }
}
function firstByLocal(node, local) {
  if (!node) return null;
  const els = node.getElementsByTagNameNS("*", local);
  return els.length ? els[0] : null;
}
function childrenByLocal(node, local) {
  const out = [];
  if (!node) return out;
  for (const c of node.children) if (c.localName === local) out.push(c);
  return out;
}
function descendantByLocal(node, local) {
  if (!node) return null;
  const els = node.getElementsByTagNameNS("*", local);
  return els.length ? els[0] : null;
}
function readXfrm(el) {
  const xfrm = firstByLocal(el, "xfrm");
  if (!xfrm) return null;
  const off = firstByLocal(xfrm, "off");
  const ext = firstByLocal(xfrm, "ext");
  const chOff = firstByLocal(xfrm, "chOff");
  const chExt = firstByLocal(xfrm, "chExt");
  return {
    offX: off ? parseInt(off.getAttribute("x") || "0", 10) : 0,
    offY: off ? parseInt(off.getAttribute("y") || "0", 10) : 0,
    extCx: ext ? parseInt(ext.getAttribute("cx") || "0", 10) : 0,
    extCy: ext ? parseInt(ext.getAttribute("cy") || "0", 10) : 0,
    chOffX: chOff ? parseInt(chOff.getAttribute("x") || "0", 10) : 0,
    chOffY: chOff ? parseInt(chOff.getAttribute("y") || "0", 10) : 0,
    chExtCx: chExt ? parseInt(chExt.getAttribute("cx") || "0", 10) : 0,
    chExtCy: chExt ? parseInt(chExt.getAttribute("cy") || "0", 10) : 0,
  };
}
function pptxNumSuffix(name) {
  const m = name.match(/(\d+)\.xml$/i);
  return m ? parseInt(m[1], 10) : 0;
}
function pptxResolveTarget(baseDir, target) {
  const parts = (baseDir + target).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}
async function getMediaUrl(zip, mediaPath, cache) {
  const key = mediaPath.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let url = "";
  const f = zip.file(mediaPath);
  if (f) {
    try {
      url = URL.createObjectURL(await f.async("blob"));
    } catch {
      url = "";
    }
  }
  cache.set(key, url);
  return url;
}

function failPptx(state, scroller, error) {
  const message = error && error.message ? error.message : String(error);
  state.className = "canvas-file-pptx-state is-failed";
  state.textContent = message;
  state.hidden = false;
  scroller.hidden = true;
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

/* 播放器外壳。音频数据按需加载，避免打开空间时把所有歌都读进内存。 */
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
    /* 空间上同时只播一个声音 */
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

const VIDEO_VOL_ON_SVG = `
  <svg class="canvas-video-vol-on" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3.7 7.4h2.8L10.4 4.2v11.6L6.5 12.6H3.7z" fill="currentColor"/>
    <path d="M12.6 7.7a3.4 3.4 0 0 1 0 4.6M14.9 5.5a6.5 6.5 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

const VIDEO_VOL_OFF_SVG = `
  <svg class="canvas-video-vol-off" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3.7 7.4h2.8L10.4 4.2v11.6L6.5 12.6H3.7z" fill="currentColor"/>
    <path d="M12.6 7.9l4.4 4.2M17 7.9l-4.4 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

/* 视频控制器的对外把手：右键菜单要读状态、改音量，不必知道播放器内部长什么样 */
const videoControls = new WeakMap();

export function videoControlOf(el) {
  const player = el?.querySelector?.(".canvas-video-player");
  return player ? videoControls.get(player) ?? null : null;
}

/* 视频播放壳。地址不是 base64，而是后端开了读权限的 asset 协议链接，
 * 浏览器按 Range 一段段要，所以 20GB 的片子也只占解码缓冲，不会整份进内存。
 * 地址也是点到才去取：打开空间时不会把所有片子都拉一遍。 */
function createVideoPlayer(item, mediaSrc, options = {}) {
  const player = document.createElement("div");
  player.className = "canvas-video-player";

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

  /* 音量：控制行平时只多一颗喇叭键，滑条藏在悬停浮层里。
     点喇叭是静音开关，滑条用来细调。 */
  const volWrap = document.createElement("div");
  volWrap.className = "canvas-video-volwrap";

  const volBtn = document.createElement("button");
  volBtn.type = "button";
  volBtn.className = "canvas-video-volume";
  volBtn.setAttribute("aria-label", "静音");
  volBtn.title = "音量";
  volBtn.innerHTML = `${VIDEO_VOL_ON_SVG}${VIDEO_VOL_OFF_SVG}`;

  const volPop = document.createElement("div");
  volPop.className = "canvas-video-volpop";
  volPop.hidden = true;
  volPop.innerHTML = `
    <div class="canvas-video-volrail" role="slider" aria-label="音量">
      <div class="canvas-video-volfill"></div>
      <span class="canvas-video-volknob"></span>
    </div>`;

  volWrap.append(volBtn, volPop);

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

  row.append(toggle, track, time, hint, volWrap);
  /* 原文件没了的引用块没什么可全屏的，那颗键就别露出来 */
  if (item.src && !options.mediaMissing) row.append(expand);
  player.append(stage, row);

  const fill = track.querySelector(".canvas-video-fill");
  const knob = track.querySelector(".canvas-video-knob");
  const volRail = volPop.querySelector(".canvas-video-volrail");
  const volFill = volPop.querySelector(".canvas-video-volfill");
  const volKnob = volPop.querySelector(".canvas-video-volknob");

  let ready = false;
  let dubReady = false;
  let duration = 0;
  let pendingSeek = null;
  let problem = "";
  let volume = Number.isFinite(item.volume) ? Math.min(1, Math.max(0, item.volume)) : 1;
  let lastVolume = volume > 0 ? volume : 1;

  if (item.src && mediaSrc) {
    video.src = mediaSrc;
    ready = true;
  }

  /* 有 AAC 副本时画面自己不出声，声音全交给副本，不然两边一起响。 */
  video.muted = Boolean(item.audioRel);

  /* 音量同时落原片和副本：哪一路出声都跟着走，不会调了没反应 */
  const applyVolume = () => {
    video.volume = volume;
    dub.volume = volume;
    volWrap.classList.toggle("is-muted", volume === 0);
    volFill.style.width = `${volume * 100}%`;
    volKnob.style.left = `${volume * 100}%`;
    volBtn.setAttribute("aria-label", volume === 0 ? "取消静音" : "静音");
  };

  const setVolume = (next, commit = false) => {
    volume = Math.min(1, Math.max(0, next));
    if (volume > 0) lastVolume = volume;
    item.volume = volume;
    applyVolume();
    if (commit) options.onVideoVolume?.(item);
  };

  applyVolume();

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
     它一定躺在空间目录里，所以按相对路径取，跟原片是不是引用态无关。 */
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

  /* 喇叭和滑条都在这个壳里，一处在 pointerdown 上截住就够整块不被拖走 */
  volWrap.addEventListener("pointerdown", (e) => e.stopPropagation());

  volBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setVolume(volume === 0 ? lastVolume : 0, true);
  });

  /* 按钮和浮层之间隔着 8px 的空隙：收起留一点缓冲，手指挪过去时不会闪没 */
  let volHideTimer = 0;
  let volDragging = false;

  const showVolume = () => {
    if (volHideTimer) {
      clearTimeout(volHideTimer);
      volHideTimer = 0;
    }
    volPop.hidden = false;
  };

  const hideVolumeSoon = () => {
    if (volDragging) return;
    if (volHideTimer) clearTimeout(volHideTimer);
    volHideTimer = setTimeout(() => {
      volHideTimer = 0;
      volPop.hidden = true;
    }, 160);
  };

  volWrap.addEventListener("pointerenter", showVolume);
  volWrap.addEventListener("pointerleave", hideVolumeSoon);

  const volumeSeek = (clientX) => {
    const rect = volRail.getBoundingClientRect();
    if (!rect.width) return;
    setVolume((clientX - rect.left) / rect.width);
  };

  volRail.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    volDragging = true;
    volumeSeek(e.clientX);
    const move = (event) => volumeSeek(event.clientX);
    const up = () => {
      volDragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setVolume(volume, true);
      /* 松手时人已经挪出浮层的话，别把面板留在半空 */
      if (!volWrap.matches(":hover")) volPop.hidden = true;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  /* 全屏挂在外壳上，不是 <video> 自己：这样控制行跟着一起进全屏层。
     监听也挂在壳上，壳随块重建时一起消失，不会在 document 上攒一堆僵尸监听。 */
  const setFullscreen = (on) => {
    player.classList.toggle("is-fullscreen", on);
    expand.setAttribute("aria-label", on ? "退出全屏" : "全屏");
    expand.title = on ? "退出全屏（Esc）" : "铺满屏幕";
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement === player) {
      document.exitFullscreen().catch(() => {});
    } else {
      player.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }
  };

  player.addEventListener("fullscreenchange", () => {
    setFullscreen(document.fullscreenElement === player);
  });

  expand.addEventListener("pointerdown", (e) => e.stopPropagation());
  expand.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFullscreen();
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

  /* 副本不进 DOM：空间里有「播一个就停掉其余」的规矩，挂在树上的它会把自己挤掉。 */
  if (item.audioRel) ensureDub();

  /* 右键菜单通过这套指令控制播放器，读到的永远是播放器此刻的真实状态 */
  videoControls.set(player, {
    isPlaying: () => !video.paused && !video.ended,
    togglePlay,
    isFullscreen: () => document.fullscreenElement === player,
    toggleFullscreen,
    getVolume: () => volume,
    setVolume: (value) => setVolume(value),
  });

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

/* 书页是跨进程 iframe：它的布局尺寸一变就要跨进程重分配渲染表面，一帧做不完
   （实测拖角每动一次 33ms、60 步掉 59 帧）。所以拖拽期间把书页钉在起始尺寸，
   滚动区照真实尺寸排版、书页只用 transform 拉满——标题条和按钮不会跟着变胖。
   钉住期间外层不滚动、也不跟着可视区改书页高度，松手一次付清。 */
export function capturePagePin(item, el) {
  if (item.type !== "ebook") return null;
  const frame = el.querySelector(".canvas-ebook-page");
  const scroll = el.querySelector(".canvas-ebook-scroll");
  if (!frame || !scroll || !frame.offsetWidth || !frame.offsetHeight) return null;
  return { frame, scroll, w: frame.offsetWidth, h: frame.offsetHeight, y: scroll.scrollTop };
}

export function pinEbookPage(pin) {
  pin.frame.dataset.pinned = "1";
  pin.frame.style.width = `${pin.w}px`;
  pin.frame.style.height = `${pin.h}px`;
  pin.scroll.style.overflowY = "hidden";
  pin.scroll.scrollTop = pin.y;
}

export function stretchEbookPage(pin) {
  pin.frame.style.transformOrigin = "0 0";
  pin.frame.style.transform = `scale(${Math.max(0.02, pin.scroll.clientWidth / pin.w)}, ${Math.max(0.02, pin.scroll.clientHeight / pin.h)})`;
}

export function releaseEbookPage(pin) {
  delete pin.frame.dataset.pinned;
  pin.frame.style.removeProperty("width");
  pin.frame.style.removeProperty("transform");
  pin.frame.style.removeProperty("transform-origin");
  pin.scroll.style.removeProperty("overflow-y");
  pin.frame.style.height = `${Math.max(1, pin.scroll.clientHeight)}px`;
  pin.scroll.scrollTop = pin.y;
}

/** 把数据同步到已有 DOM（拖动/缩放/改色时只走这里，不重建节点）。 */
/* 笔记卡片的边框和背景：空值就交回样式表，跟随主题 */
function syncNoteColors(el, item) {
  const card = el.querySelector(".canvas-note-card");
  const body = el.querySelector(".canvas-note-body");
  if (card) {
    card.style.borderColor = item.borderColor || "";
    card.style.background = item.fillColor || "";
    card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  }
  if (body) {
    body.style.background = item.fillColor || "";
    body.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  }
}

/* 文件卡片的边框和背景：空值就交回样式表，跟随主题 */
function syncFileColors(el, item) {
  const card = el.querySelector(".canvas-file-card");
  if (!card) return;
  card.style.borderColor = item.borderColor || "";
  card.style.background = item.fillColor || "";
  card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
  card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
}

/* ---------- 画面块：指令列表 → svg ----------
   为什么是 svg 不是 <canvas>：导出和 agent 截图都是把世界层塞进一张带 viewBox 的 svg
   再按目标像素栅格化（export.js 的 buildSvg）。块里的 <canvas> 只是一张按当前缩放画好的
   位图，放大倍数一上去就糊；svg 节点交给浏览器按 viewBox 现画，任何倍数都是锐的。 */

const PICTURE_FAMILIES = {
  sans: "sans-serif",
  serif: "serif",
  mono: "ui-monospace, Consolas, monospace",
  /* 题字走系统自带的黑体，中文不缺字 */
  cjk: '"Microsoft YaHei", "PingFang SC", sans-serif',
};

let pictureClipSeq = 0;
let pictureGradSeq = 0;
let pictureSymSeq = 0;
let picturePatSeq = 0;
let pictureCutSeq = 0;

/* 画面里垫的位图要显示，就得把存下来的 src 换成这个空间能用的地址，而那张表在 canvas.js 那边
   （跟着空间切换整个重建）。这里不反向 import，由那边启动时把「src → 地址」的函数塞进来。
   没塞、或那个 src 现在取不到（还没加载完、原片被删了）都算「图没到」，渲染层自己退化成占位框。 */
let pictureMedia = null;

export function setPictureMedia(resolve) {
  pictureMedia = typeof resolve === "function" ? resolve : null;
}

function pictureNode(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === "" || value == null || value === 0) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/* 渐变那几个数不能走上面那种「0 就省掉」的写法：svg 自己的默认值是 50%，
   一个 cx:0 被省掉，圆心就跑到了包围盒正中。 */
function pictureNodeExact(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/* 一处漆要么是颜色串，要么是渐变 / 图案对象。
   渐变和图案都要现造一个节点塞进这一块的 defs，再把 url(#id) 交回去——
   所以渲染一条指令得带上「往哪儿塞 defs」，不能只返回一个节点。 */
function paintAttr(paint, ctx) {
  if (!paint) return "";
  if (typeof paint === "string") return paint;
  if (paint.type === "pattern") return patternAttr(paint, ctx);
  pictureGradSeq += 1;
  const id = `canvas-picture-grad-${pictureGradSeq}`;
  const box = paint.units === "user" ? "userSpaceOnUse" : "objectBoundingBox";
  const node = pictureNodeExact(
    paint.type === "linear" ? "linearGradient" : "radialGradient",
    paint.type === "linear"
      ? { id, gradientUnits: box, x1: paint.x1, y1: paint.y1, x2: paint.x2, y2: paint.y2 }
      : { id, gradientUnits: box, cx: paint.cx, cy: paint.cy, r: paint.r },
  );
  for (const stop of paint.stops) {
    node.append(pictureNodeExact("stop", { offset: stop.at, "stop-color": stop.color }));
  }
  markPictureDef(node);
  ctx?.defs?.append(node);
  return `url(#${id})`;
}

/* 现造的 defs 都盖一个记号，每幅重画前按记号清掉：
   渐变、素材、图案的 id 全是递增的，不清就一路堆到内存里。 */
function markPictureDef(node) {
  node.setAttribute("data-canvas-picture-def", "");
}

/* 图案漆：<pattern> 一格，浏览器自己铺满。格子里画的是自带纹样（斜线 / 方格 / 点），
   或者一个素材（tile，瓦、砖、鳞片都这么铺）。同一份漆只造一次。 */
function patternAttr(paint, ctx) {
  const key = `pat\u0000${JSON.stringify(paint)}${tintKey(ctx)}`;
  const cached = ctx?.defCache?.get(key);
  if (cached) return `url(#${cached})`;
  const half = paint.gap / 2;
  const cellW = paint.pattern === "tile" ? paint.dx : paint.gap;
  const cellH = paint.pattern === "tile" ? paint.dy : paint.gap;
  const node = pictureNodeExact("pattern", {
    patternUnits: "userSpaceOnUse",
    width: cellW,
    height: cellH,
    patternTransform: paint.angle ? `rotate(${paint.angle})` : null,
  });
  /* 底色先铺满这一格，纹样再压上去：省掉「同一条形状画两遍，一遍底色一遍纹样」 */
  if (paint.background) {
    node.append(pictureNodeExact("rect", { x: 0, y: 0, width: cellW, height: cellH, fill: paint.background }));
  }
  const line = (x1, y1, x2, y2) =>
    pictureNodeExact("line", { x1, y1, x2, y2, stroke: paint.color, "stroke-width": paint.width });
  if (paint.pattern === "tile") {
    /* 铺的单元认不出来就整片漆作废：宁可这块不填，也不给浏览器塞个空 pattern */
    const view = symbolView(ctx?.symbols, ctx?.view || new Map(), { ref: paint.ref });
    if (!view) return "";
    const use = pictureNode("use", { transform: `translate(${-view.symbol.ox} ${-view.symbol.oy})` });
    use.setAttribute("href", `#${pictureSymbolDef(view, ctx)}`);
    node.append(use);
  } else {
    /* 线画在格子正中：贴着边画会被裁掉半根，接缝处看着就断 */
    if (paint.pattern === "dots") {
      node.append(pictureNodeExact("circle", { cx: half, cy: half, r: Math.max(0.2, paint.width / 2), fill: paint.color }));
    } else {
      node.append(line(half, 0, half, paint.gap));
      if (paint.pattern === "grid") node.append(line(0, half, paint.gap, half));
    }
  }
  picturePatSeq += 1;
  const id = `canvas-picture-pat-${picturePatSeq}`;
  node.setAttribute("id", id);
  markPictureDef(node);
  ctx?.defs?.append(node);
  ctx?.defCache?.set(key, id);
  return `url(#${id})`;
}

/* 一个素材按一套图层开关投影出来的那份指令，只造一个 <g>：
   几百份 use 全指同一个 id，这就是实例化省下来的地方。 */
/* 落影不越过素材这一层：素材那一份 <g> 是所有 use 共用的，把落影挤进去等于每一片瓦、
   每一根椽都各自拖一道影子。摆在组里的那个人，影子按整个素材的外接框挤一片就够了。 */
const noCast = (ctx) => (ctx?.cast ? { ...ctx, cast: null } : ctx);

function pictureSymbolDef(view, ctx) {
  const key = `sym\u0000${view.key}${tintKey(ctx)}`;
  const cached = ctx?.defCache?.get(key);
  if (cached) return cached;
  const g = pictureNode("g", {});
  const sctx = noCast(ctx);
  for (const cmd of view.cmds) {
    const node = renderPictureCmd(cmd, sctx);
    if (node) g.append(node);
  }
  pictureSymSeq += 1;
  const id = `canvas-picture-sym-${pictureSymSeq}`;
  g.setAttribute("id", id);
  markPictureDef(g);
  ctx?.defs?.append(g);
  ctx?.defCache?.set(key, id);
  return id;
}

const hasHandles = (points) => points.some((point) => point.c1 || point.c2);

/* 一条边：这一点带了控制点就走三次贝塞尔，没带就是直线。
   只写了一个控制点就拿它顶两个用，不然 C 段会缺参数。 */
function edgeSegment(from, to) {
  if (!(to.c1 || to.c2)) return ` L ${to.x} ${to.y}`;
  const c1 = to.c1 || to.c2;
  const c2 = to.c2 || to.c1;
  return ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
}

function edgePath(points, closed) {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) d += edgeSegment(points[i - 1], points[i]);
  if (closed) d += `${edgeSegment(points[points.length - 1], points[0])} Z`;
  return d;
}

/* 曲线段打平成折线，只给命中判定用：不打平会出现「明明压到了却擦不掉」。
   12 段一支足够——容差本来就是几个像素的事。 */
function flattenSegment(from, to) {
  if (!(to.c1 || to.c2)) return [to];
  const c1 = to.c1 || to.c2;
  const c2 = to.c2 || to.c1;
  const out = [];
  for (let step = 1; step <= 12; step += 1) {
    const t = step / 12;
    const u = 1 - t;
    out.push({
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
    });
  }
  return out;
}

function flattenEdges(points, closed) {
  if (!hasHandles(points)) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) out.push(...flattenSegment(points[i - 1], points[i]));
  if (closed) out.push(...flattenSegment(points[points.length - 1], points[0]));
  return out;
}

/* 一点就是笔尖落下的那个半径：没写 w 的点用这条指令的默认宽度 */
function strokeRadiusOf(point, size) {
  const width = Number.isFinite(point.w) ? point.w : size;
  return Math.max(0.05, width / 2);
}

/* 一路等宽的笔交给 svg 自己描（stroke-width + 圆头），比手算轮廓又准又便宜。
   只有真的带提按才走下面那套展开成填色轮廓的画法。 */
function strokeUniformWidth(points, size) {
  const first = strokeRadiusOf(points[0], size) * 2;
  return points.every((point) => strokeRadiusOf(point, size) * 2 === first) ? first : 0;
}

/* 中心线用二次曲线走：每一点当控制点、相邻点的中点当落点。
   手画的折角会被这段圆弧顺过去，看上去是一笔而不是一串直线段。 */
function strokeCenterPath(points) {
  const last = points.length - 1;
  if (last < 2) return `M ${points[0].x} ${points[0].y} L ${points[last].x} ${points[last].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < last; i += 1) {
    d += ` Q ${points[i].x} ${points[i].y} ${(points[i].x + points[i + 1].x) / 2} ${(points[i].y + points[i + 1].y) / 2}`;
  }
  return `${d} L ${points[last].x} ${points[last].y}`;
}

/* 变宽的墨迹只能填色：svg 的 stroke-width 沿一条路径是恒定的，想要「按下去粗、
   提起来细」就得把中心线两侧各推出半个笔宽，围成一圈再填。两头补半圆当圆头。 */
function strokeOutlinePath(points, size) {
  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const prev = points[i - 1] || point;
    const next = points[i + 1] || point;
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    const r = strokeRadiusOf(point, size);
    left.push({ x: point.x - dy * r, y: point.y + dx * r, r });
    right.push({ x: point.x + dy * r, y: point.y - dx * r, r });
  }
  const tail = right.length - 1;
  let d = `M ${left[0].x.toFixed(2)} ${left[0].y.toFixed(2)}`;
  for (let i = 1; i < left.length; i += 1) d += ` L ${left[i].x.toFixed(2)} ${left[i].y.toFixed(2)}`;
  /* 收尾那头：左沿的终点绕到右沿的终点，半径就是那一点的半宽 */
  d += ` A ${left[tail].r.toFixed(2)} ${left[tail].r.toFixed(2)} 0 0 0 ${right[tail].x.toFixed(2)} ${right[tail].y.toFixed(2)}`;
  for (let i = tail - 1; i >= 0; i -= 1) d += ` L ${right[i].x.toFixed(2)} ${right[i].y.toFixed(2)}`;
  d += ` A ${right[0].r.toFixed(2)} ${right[0].r.toFixed(2)} 0 0 0 ${left[0].x.toFixed(2)} ${left[0].y.toFixed(2)} Z`;
  return d;
}

/* ---------- 枯笔：一笔拆成几根丝 ----------
   毛笔写干了，墨先从笔幅两侧咬空，中间只剩一道，沿线还会撕开白缝、末端散成几叉。
   这套几何就是把一笔画成 1~5 条各自长短不齐、各带几处断口的细带。

   股数、每根偏多少、从哪儿断开，全部由这条点串自己的哈希推出来——
   同一份数据永远画成同一笔，重开、导出、第二次重画都不会变成另一笔。
   破了这条，幂等（存进去的拼写=读回来的拼写、再归一化一次还是它）就是假的。 */

/* 一根笔最多拆几股：再多就是一把扫帚，不像一杆枯笔了 */
const GRAIN_STRAND_MAX = 5;
/* 超长的手绘点串先抽稀再拆股：4000 点 × 5 股会把一条 path 撑到几百 KB，
   而 4000 点的笔本来密到抽剩 480 点也看不出棱角。只在起枯的时候抽，实墨那条一像素不动。 */
const GRAIN_SPINE_POINTS = 480;

function grainSeed(points, size, grain) {
  let h = 0x811c9dc5;
  const mix = (value) => {
    h = (h ^ Math.round(Number(value) || 0)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(size);
  mix(grain * 100);
  for (const point of points) {
    mix(point.x);
    mix(point.y);
    mix(point.w ?? size);
  }
  return h >>> 0;
}

/* mulberry32：给一个种子出一串定死的随机数。不用 Math.random——那让同一笔每次画得不一样。 */
function grainRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 一根丝在笔幅上的位置：t 是 -1（贴左沿）到 +1（贴右沿），share 是它占整幅的比例。
   偏的量按 (1 - share) 收着给，于是 |t|=1 那根正好贴边不越界——
   橡皮判据才不用跟着改：纹理怎么散都还在原来那一笔的宽度里。 */
function grainStrands(points, size, grain) {
  const strandCount = Math.max(1, Math.min(GRAIN_STRAND_MAX, 1 + Math.round(grain * (GRAIN_STRAND_MAX - 1))));
  const step = Math.max(1, Math.ceil(points.length / GRAIN_SPINE_POINTS));
  const spine = [];
  for (let i = 0; i < points.length; i += step) spine.push(points[i]);
  if (spine[spine.length - 1] !== points[points.length - 1]) spine.push(points[points.length - 1]);
  if (spine.length < 2) return [];
  const rnd = grainRandom(grainSeed(spine, size, grain));
  const paths = [];
  for (let s = 0; s < strandCount; s += 1) {
    const t = strandCount === 1 ? 0 : (s / (strandCount - 1)) * 2 - 1;
    /* 两侧那两根更细：墨是从边上先咬空的 */
    const share = Math.max(0.12, (1 / strandCount) * (1 - grain * 0.25) * (1 - 0.45 * Math.abs(t)));
    const offset = t * (1 - share);
    /* 两头各让开一截：接笔那头留得短，收笔那头散得开，几股一错开就是末端分叉 */
    const from = Math.min(Math.round(rnd() * grain * 0.06 * spine.length), spine.length - 2);
    const to = Math.max(from + 2, spine.length - Math.round(rnd() * grain * 0.22 * spine.length));
    const cuts = [];
    if (to - from >= 6) {
      const extra = (rnd() < grain * 0.9 ? 1 : 0) + (grain > 0.55 && rnd() < 0.55 ? 1 : 0);
      for (let c = 0; c < extra; c += 1) {
        const at = Math.round(from + (0.2 + rnd() * 0.6) * (to - from));
        if (at > from + 2 && at < to - 2) cuts.push(at);
      }
      cuts.sort((a, b) => a - b);
    }
    const bounds = [from, ...cuts, to];
    for (let b = 1; b < bounds.length; b += 1) {
      const start = bounds[b - 1];
      const end = bounds[b];
      if (end - start < 2) continue;
      const sub = [];
      for (let i = start; i < end; i += 1) {
        const point = spine[i];
        const prev = spine[i - 1] || point;
        const next = spine[i + 1] || point;
        let dx = next.x - prev.x;
        let dy = next.y - prev.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) {
          dx = 1;
          dy = 0;
        } else {
          dx /= len;
          dy /= len;
        }
        const width = Number.isFinite(point.w) ? point.w : size;
        const reach = (width / 2) * offset;
        sub.push({
          x: point.x - dy * reach,
          y: point.y + dx * reach,
          /* 各点带上自己的股宽，strokeOutlinePath 照这个半径铺开，提按跟着原笔走 */
          w: Math.max(0.1, width * share),
        });
      }
      paths.push(strokeOutlinePath(sub, size));
    }
  }
  return paths;
}

/* ---------- 橡皮命中判定 ----------
   线 / 笔画量「到折线的最短距离」，填色的矩形和 poly 连内部一起算，空心的只认边框，
   文字按包围盒粗判。group 不参与：橡皮删的是一整条指令，
   擦到组里任意一笔会把整组一起带走，那不像擦除像误删。
   带剪刀的那条还要再过一道 cutAreaHit：剪掉的那部分看不见，也就不该擦得到。 */

/* 一个「面」罩不罩得住这一点。剪刀的三种规范形和素材里的几何指令用同一套判法：
   rect 连圆角一起算（圆角那块看不见，也就擦不到），曲线边一律打平——
   不打平会出现「看着明明压到了却擦不掉」，反过来还会让剪刀外的地方擦得着。 */
function cutAreaHit(shape, point, ctx) {
  /* 这里的 shape 有两种来路：规范形自己（只有 kind），和摊开后的素材指令（只有 op，
     而且 stroke 那条自己带 kind:"pen"|"brush" 表示笔头——那是笔尖，不是形状种类）。
     先读 op 再读 kind，不然素材里的墨迹会被当成不认识的形整个放行，剪刀等于没挂。 */
  const kind = shape.op || shape.kind;
  if (kind === "ref") {
    const symbol = ctx?.symbols?.[shape.ref];
    /* 剪刀素材没了（归一化那一头拦着不让删还在用的，真到这一步是坏数据）：
       当没有剪刀放行——看不见又擦不掉的东西才最难伺候 */
    if (!symbol) return true;
    const local = pictureLocalPoint(shape, point);
    const scale = Math.abs(Number(shape.scale) || 1) || 1;
    const inside = { x: local.x / scale + symbol.ox, y: local.y / scale + symbol.oy };
    return (symbol.cmds || []).some((cmd) => cutAreaHit(cmd, inside, ctx));
  }
  if (kind === "rect") {
    const r = Math.min(Math.max(0, Number(shape.radius) || 0), Math.min(shape.w, shape.h) / 2);
    if (point.x < shape.x || point.x > shape.x + shape.w || point.y < shape.y || point.y > shape.y + shape.h) return false;
    if (!r) return true;
    /* 圆角那块：把点钳到内缩的方框上，它到圆心的距离超半径就落在角外 */
    const cx = Math.min(Math.max(point.x, shape.x + r), shape.x + shape.w - r);
    const cy = Math.min(Math.max(point.y, shape.y + r), shape.y + shape.h - r);
    return Math.hypot(point.x - cx, point.y - cy) <= r;
  }
  if (kind === "path" || kind === "poly" || kind === "line") {
    return polygonInside(flattenEdges(shape.points, true), point);
  }
  if (kind === "stroke") {
    /* 墨迹当剪刀剪的是那一长条的面积，判法和这条自己的命中一模一样（只看半径，不看枯笔的丝） */
    for (let i = 0; i < shape.points.length; i += 1) {
      const from = shape.points[i - 1] || shape.points[i];
      if (pointSegmentDistance(point, from, shape.points[i]) <= strokeRadiusOf(shape.points[i], shape.size)) return true;
    }
    return false;
  }
  if (kind === "group") {
    const local = pictureLocalPoint(shape, point);
    const scale = Math.abs(Number(shape.scale) || 1) || 1;
    return (shape.cmds || []).some((cmd) => cutAreaHit(cmd, { x: local.x / scale, y: local.y / scale }, ctx));
  }
  /* text 当剪刀只在渲染那头收下（字体缺不缺会影响剪出来的形），擦除按罩不住放行 */
  if (kind === "text") return true;
  return true;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function polylineHit(points, closed, p, reach) {
  for (let i = 1; i < points.length; i += 1) {
    if (pointSegmentDistance(p, points[i - 1], points[i]) <= reach) return true;
  }
  if (closed && points.length > 2) {
    return pointSegmentDistance(p, points[points.length - 1], points[0]) <= reach;
  }
  return false;
}

function polygonInside(points, p) {
  let inside = false;
  /* j 要停在「上一条边的另一端」：写成 j = i += 1 会让 j 跟着 i 一起走，
     两条相邻点变成同一个点，判定几乎永远返回 false（填色 poly 的内部擦不到就是这个） */
  for (let i = 0, j = points.length - 1; i < points.length; j = i, (i += 1)) {
    const a = points[i];
    const b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* 擦不擦得到 = 形状命中了，还要落在这一条自己的剪刀里。
   mask 不参与判定：渐变没有硬边界，「擦得到」的界在这儿划不出来。
   剪刀的坐标和这条指令的几何同一个坐标系，所以这里不用做任何变换。 */
export function pictureCmdHit(cmd, point, tolerance = PICTURE_ERASER_TOLERANCE, ctx = {}) {
  if (!pictureCmdShapeHit(cmd, point, tolerance, ctx)) return false;
  if (!cmd || !cmd.clip) return true;
  return cutAreaHit(cmd.clip, point, ctx);
}

function pictureCmdShapeHit(cmd, point, tolerance = PICTURE_ERASER_TOLERANCE, ctx = {}) {
  if (!cmd || typeof cmd !== "object") return false;
  const reach = Math.max(0, Number(tolerance) || 0);
  if (cmd.op === "stroke") {
    for (let i = 0; i < cmd.points.length; i += 1) {
      const from = cmd.points[i - 1] || cmd.points[i];
      if (pointSegmentDistance(point, from, cmd.points[i]) <= strokeRadiusOf(cmd.points[i], cmd.size) + reach) return true;
    }
    return false;
  }
  if (cmd.op === "line" || cmd.op === "poly") {
    const closed = cmd.op === "poly";
    /* 带控制点的边先打平：按原始折线算会出现「看着明明压到了却擦不掉」 */
    const ring = flattenEdges(cmd.points, closed);
    const half = (cmd.strokeWidth > 0 ? cmd.strokeWidth / 2 : 0) + reach;
    if (polylineHit(ring, closed, point, half)) return true;
    return closed && Boolean(cmd.fill) && polygonInside(ring, point);
  }
  if (cmd.op === "rect") {
    const inside =
      point.x >= cmd.x - reach &&
      point.x <= cmd.x + cmd.w + reach &&
      point.y >= cmd.y - reach &&
      point.y <= cmd.y + cmd.h + reach;
    if (!inside) return false;
    if (cmd.fill) return true;
    const half = (cmd.strokeWidth > 0 ? cmd.strokeWidth / 2 : 0) + reach;
    return polylineHit(
      [
        { x: cmd.x, y: cmd.y },
        { x: cmd.x + cmd.w, y: cmd.y },
        { x: cmd.x + cmd.w, y: cmd.y + cmd.h },
        { x: cmd.x, y: cmd.y + cmd.h },
      ],
      true,
      point,
      half,
    );
  }
  if (cmd.op === "text") {
    /* svg 的 text 锚点是基线：往上留一个字身，往下留一点下伸部 */
    const width = String(cmd.text || "").length * cmd.size * 0.62;
    return (
      point.x >= cmd.x - reach &&
      point.x <= cmd.x + width + reach &&
      point.y >= cmd.y - cmd.size + reach &&
      point.y <= cmd.y + cmd.size * 0.3 + reach
    );
  }
  /* 素材实例：擦掉的就是这一整份。素材里的图层（name / variants）只是「这份要不要画」的开关，
     不是能各自擦掉的东西，所以穿层问过。 */
  if (cmd.op === "use") {
    const view = symbolView(ctx.symbols, ctx.view || new Map(), cmd);
    if (!view) return false;
    const local = pictureLocalPoint(cmd, point);
    const scale = Math.abs(Number(cmd.scale) || 1) || 1;
    const inside = { x: local.x / scale + view.symbol.ox, y: local.y / scale + view.symbol.oy };
    return view.cmds.some((child) => symbolLayerHit(child, inside, reach / scale, ctx));
  }
  /* 垫的位图整张都算「这一笔」：框内哪一点都擦得到，跟图有没有加载出来无关。
     渲染时旋转绕的是框中心，反推坐标就得绕同一个点，不能套 pictureLocalPoint（那个绕落点）。 */
  if (cmd.op === "image") {
    const cx = cmd.x + cmd.w / 2;
    const cy = cmd.y + cmd.h / 2;
    const rad = ((Number(cmd.rotate) || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = point.x - cx;
    const dy = point.y - cy;
    const local = { x: cx + dx * cos + dy * sin, y: cy - dx * sin + dy * cos };
    return (
      local.x >= cmd.x - reach &&
      local.x <= cmd.x + cmd.w + reach &&
      local.y >= cmd.y - reach &&
      local.y <= cmd.y + cmd.h + reach
    );
  }
  /* 顶层的组：组里任何一笔被碰到，擦掉的就是这一整条 group（和「一擦一整条」一个脾气）。
     以前这里没有组这一支，顶层 group 恒判不中——手绘橡皮擦不掉一整组，
     而图层恰恰推荐「几笔一起开关就包一层 group 起名」，等于给分好组的画留了个擦不掉的洞。 */
  if (cmd.op === "group") {
    const local = pictureLocalPoint(cmd, point);
    const scale = Math.abs(Number(cmd.scale) || 1) || 1;
    return (cmd.cmds || []).some((child) => symbolLayerHit(child, { x: local.x / scale, y: local.y / scale }, reach / scale, ctx));
  }
  return false;
}

/* 素材内部按图层往下穿：图层是同一个整体的一部分，不是各自能擦的一笔 */
function symbolLayerHit(cmd, point, reach, ctx) {
  if (cmd.op !== "group") return pictureCmdHit(cmd, point, reach, ctx);
  const local = pictureLocalPoint(cmd, point);
  const scale = Math.abs(Number(cmd.scale) || 1) || 1;
  return cmd.cmds.some((child) => symbolLayerHit(child, { x: local.x / scale, y: local.y / scale }, reach / scale, ctx));
}

/* 把外层坐标系的点搬回这条指令自己的坐标系：挪掉落点，再反着把旋转和缩放转回来。
   注意先除缩放再摆 ox/oy：ox 记的是素材自己那套坐标。 */
function pictureLocalPoint(cmd, point) {
  const dx = point.x - (Number(cmd.x) || 0);
  const dy = point.y - (Number(cmd.y) || 0);
  const rad = ((Number(cmd.rotate) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/* 滤镜走 css 的函数写法，不进 <defs> 现造 <filter>：
   svg 自己那套的画区按形状包围盒取百分比，一条竖线的包围盒宽是 0，模糊会被切出一道硬边；
   css 函数由浏览器按效果自己扩画区，没有这个坑，也不用跟着每幅画增删一个 id。
   发光 = 两层同心 drop-shadow：dx/dy 都是 0 时它就是「自己的形状糊一层颜色」，
   叠两层是为了外面那圈更淡的过渡，单层的边缘会像贴了一张纸片。
   写成数组时按序串起来，css 的 filter 本来就是空格分隔的函数列表。 */
function filterStyleOf(filter, ctx) {
  return (Array.isArray(filter) ? filter : [filter]).map((one) => oneFilterStyle(one, ctx)).join(" ");
}

/* 影子的落点：写了 dx / dy 就照写的来，缺哪个补哪个——补的方向是光的反方向。
   长短两种来源：写了 h 的是「一个立着的东西」，影长按真实投影来 L = h / tan(太阳高度)，
   太阳越低影子越长（这正是街面上那种斜长影子）；没写 h 的照老口径，短到和化开半径一个量级，
   那是「贴在纸上的一层淡影」。正顶光影长为 0，太阳落到地平线以下也不算长影。
   只在渲染期算，绝不写回存着的数据：改一次光源，全画的影子一起转身。 */
const SHADOW_MAX_LEN = 2000;

function shadowOffset(filter, ctx) {
  const dx = Number.isFinite(filter.dx) ? filter.dx : null;
  const dy = Number.isFinite(filter.dy) ? filter.dy : null;
  if (dx !== null && dy !== null) return { dx, dy };
  const light = ctx?.light;
  if (!light) return { dx: dx ?? 0, dy: dy ?? 0 };
  const a = (Number(light.angle) * Math.PI) / 180;
  const e = (Number(light.elev ?? LIGHT_DEFAULTS.elev) * Math.PI) / 180;
  const h = Number(filter.h);
  const len = Number.isFinite(h)
    ? e <= 0
      ? 0
      : Math.min(SHADOW_MAX_LEN, h / Math.max(Math.tan(e), 0.05))
    : Math.max(0, Math.cos(e)) * Number(filter.r || 0);
  const round = (v) => Math.round(v * 10) / 10;
  return { dx: dx ?? round(-Math.sin(a) * len), dy: dy ?? round(Math.cos(a) * len) };
}

/* 滤镜里那条写了 h 的投影。没写 h 的（贴在纸上的一层淡影）还走 css，一个字都不变。 */
function shadowWithH(filter) {
  const list = Array.isArray(filter) ? filter : filter ? [filter] : [];
  return list.find((one) => one?.type === "shadow" && Number.isFinite(Number(one.h))) || null;
}

/* 写了 h 的那一档不能再交给 css：drop-shadow 是把整个剪影挪一份，影长一超过物体自己的高度，
   挪出来的那份就和物体脱开、悬在半空像一团雾。真的落影是从脚底拖出去的一片：
   拿这条指令和纸接触的那一道（外接框的底边）沿影子向量平移，四点围成一个平行四边形，
   垫在形状自己后面。一个多边形就是一片影子，不占离屏合成，一条街摆几十个也不掉帧。
   group 自己不出一片：那会把整组的外接框当一个物体，十七个小人挤成一整条街的糊。 */
function castShadowOf(cmd, ctx) {
  if (cmd.op === "group") return null;
  const one = shadowWithH(cmd.filter) || ctx?.cast;
  if (!one || !ctx?.light) return null;
  const { dx, dy } = shadowOffset(one, ctx);
  if (!dx && !dy) return null;
  const pts = pictureOutlineOf(cmd, ctx, 0);
  if (!pts.length) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!(x1 > x0)) return null;
  return { x0, x1, y: y1, dx, dy, color: one.color, r: Number(one.r) || 0 };
}

function castShadowNode(cast, ctx) {
  const { x0, x1, y, dx, dy, color, r } = cast;
  /* 影子里最不该出现的是「一块均匀的灰板」：真的落影从脚底开始最实，往末梢一路淡掉——
     笔影越远越散（半影变宽）、天光从四面八方补回来。所以按影子的长短拉一道渐变，
     起点在脚底、终点在末梢，都是这块画面的真实坐标。 */
  const mid = (x0 + x1) / 2;
  const fill = paintAttr(
    {
      type: "linear",
      units: "user",
      x1: mid,
      y1: y,
      x2: mid + dx,
      y2: y + dy,
      stops: [
        { at: 0, color },
        { at: 0.5, color: hexAlpha(color, 0.6) },
        { at: 1, color: hexAlpha(color, 0) },
      ],
    },
    ctx,
  );
  const node = pictureNode("polygon", {
    points: `${x0},${y} ${x1},${y} ${x1 + dx},${y + dy} ${x0 + dx},${y + dy}`,
    fill,
  });
  /* 默认硬边：低太阳的落影本来就是一道清楚的边，要羽化再写 r。
     写了 r 才有这一次离屏合成，所以别顺手给每条影子都糊上。 */
  if (r > 0) node.style.filter = `blur(${r}px)`;
  return node;
}

/* 给 #rrggbb / #rrggbbaa 换一档不透明度（影子淡到末梢用） */
function hexAlpha(color, k) {
  const hex = String(color);
  const a = Math.round((hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255) * k);
  return `${hex.slice(0, 7)}${a.toString(16).padStart(2, "0")}`;
}

/* 这条指令摊开之后占在哪些点上（在它自己那一层坐标里）：落影要按脚底那道边挤。
   素材得摊成它自己的每一笔才知道脚在哪儿；素材里不许再摆素材，所以最深两层。 */
function pictureOutlineOf(cmd, ctx, depth) {
  if (cmd.op === "rect" || cmd.op === "image") {
    return [
      { x: cmd.x, y: cmd.y },
      { x: cmd.x + (Number(cmd.w) || 0), y: cmd.y + (Number(cmd.h) || 0) },
    ];
  }
  if (Array.isArray(cmd.points)) return cmd.points.map((p) => ({ x: p.x, y: p.y }));
  if (cmd.op === "text") return [{ x: cmd.x, y: cmd.y }];
  if (depth > 2) return [];
  let kids = null;
  let off = { x: 0, y: 0 };
  if (cmd.op === "group") kids = cmd.cmds;
  else if (cmd.op === "use") {
    const view = symbolView(ctx?.symbols, ctx?.view || new Map(), cmd);
    if (!view) return [];
    kids = view.cmds;
    off = { x: -(Number(view.symbol.ox) || 0), y: -(Number(view.symbol.oy) || 0) };
  }
  if (!kids) return [];
  const s = Number(cmd.scale) || 1;
  const rad = ((Number(cmd.rotate) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out = [];
  for (const one of kids) {
    for (const p of pictureOutlineOf(one, ctx, depth + 1)) {
      let x = (p.x + off.x) * s;
      let y = (p.y + off.y) * s;
      if (rad) {
        const nx = x * cos - y * sin;
        y = x * sin + y * cos;
        x = nx;
      }
      out.push({ x: x + (Number(cmd.x) || 0), y: y + (Number(cmd.y) || 0) });
    }
  }
  return out;
}

/* 挤成多边形的这一档别再让 css 挪一遍剪影：两条都留就是一片硬边落影外加一团雾。 */
function cssFilterOf(filter) {
  if (!filter) return null;
  if (!Array.isArray(filter)) return shadowWithH(filter) ? null : filter;
  const kept = filter.filter((one) => !shadowWithH(one));
  if (!kept.length) return null;
  return kept.length === filter.length ? filter : kept;
}

function oneFilterStyle(filter, ctx) {
  if (filter.type === "shadow") {
    const { dx, dy } = shadowOffset(filter, ctx);
    return `drop-shadow(${dx}px ${dy}px ${filter.r}px ${filter.color})`;
  }
  if (filter.type === "glow") {
    return `drop-shadow(0 0 ${filter.r}px ${filter.color}) drop-shadow(0 0 ${filter.r / 2}px ${filter.color})`;
  }
  if (filter.type === "gray") return `grayscale(${filter.k})`;
  if (filter.type === "bright") return `brightness(${filter.k})`;
  if (filter.type === "contrast") return `contrast(${filter.k})`;
  return `blur(${filter.r}px)`;
}

/* 一条指令画成一个 svg 节点。落笔过程中也用它画那根还在动的临时笔画，
   这样「预览」和「松手之后的样子」一定是同一套代码算出来的。
   ctx = {defs, symbols, view, defCache, light, face}：这一块的 <defs>，渐变、图案、素材都往里面现造；
   light 是这块的一套光，face 是当下生效的那个朝向（group / use 往下传，子自己写了算子的用子那个）。 */
export function renderPictureCmd(cmd, ctx) {
  /* 朝向是从上往下继承的：一块墙上摆十扇窗，只在 group 上写一次 face 就够。
     没打光的块两个条件都不成立，ctx 原样往下走——那条红线要求它的输出和今天逐字相同。 */
  const face = cmd.face || ctx?.face || "";
  const lctx = face === (ctx?.face || "") ? ctx : { ...ctx, face };
  /* 挂在组上的落影规格往下传：组里每一笔各自挤自己那一片，而不是整组挤一大片 */
  const groupCast = cmd.op === "group" ? shadowWithH(cmd.filter) || ctx?.cast : null;
  const cctx = groupCast ? { ...lctx, cast: groupCast } : lctx;
  let node = pictureCmdNode(cmd, cctx);
  if (!node) return null;
  /* 一条滤镜就是一次离屏合成，整幅每条都挂会掉帧——手册里劝过，这里只管照写。
     先给形状自己，再套落影：糊边是糊形状，不该把地上那片影子一起糊了。 */
  const css = cssFilterOf(cmd.filter);
  if (css) node.style.filter = filterStyleOf(css, lctx);
  const cast = castShadowOf(cmd, cctx);
  if (cast) {
    const g = pictureNode("g", {});
    g.append(castShadowNode(cast, cctx), node);
    node = g;
  }
  if (cmd.blend) node.style.mixBlendMode = cmd.blend;
  /* 剪刀和遮罩挂在这一层的外壳上。group / use / 转过的 image 自己身上带 transform，
     直接挂会让剪刀跟着一起挪一起转——「窗子在墙上，纸在窗里」应该是窗不动纸动。
     套一层没有变换的外壳，剪刀就稳稳落在这一层自己的坐标系里：和橡皮判的同一套坐标。 */
  const carriesTransform = cmd.op === "group" || cmd.op === "use" || (cmd.op === "image" && cmd.rotate);
  if ((cmd.clip || cmd.mask) && carriesTransform) {
    const shell = pictureNode("g", {});
    shell.append(node);
    node = shell;
  }
  if (cmd.clip) {
    const clip = clipAttr(cmd.clip, ctx);
    if (clip) node.setAttribute("clip-path", clip);
  }
  if (cmd.mask) {
    const mask = maskAttr(cmd.mask, ctx);
    if (mask) node.setAttribute("mask", mask);
  }
  return node;
}

function pictureCmdNode(cmd, ctx) {
  if (cmd.op === "rect") {
    const fill = paintAttr(litPaint(cmd.fill, ctx), ctx);
    const stroke = paintAttr(cmd.stroke, ctx);
    const node = pictureNode("rect", {
      x: cmd.x,
      y: cmd.y,
      width: cmd.w,
      height: cmd.h,
      rx: cmd.radius,
      "stroke-width": cmd.strokeWidth,
      "fill-opacity": cmd.fill && cmd.opacity < 1 ? cmd.opacity : "",
      "stroke-opacity": cmd.stroke && cmd.opacity < 1 ? cmd.opacity : "",
    });
    /* svg 的 fill 默认是黑色：只想描边的矩形不写 fill 就会糊成一坨实心，
       所以没漆也得显式写 none，这一条不能走「空值省属性」那套 */
    node.setAttribute("fill", fill || "none");
    if (stroke) node.setAttribute("stroke", stroke);
    return node;
  }
  if (cmd.op === "poly" || cmd.op === "line") {
    const fill = paintAttr(litPaint(cmd.fill, ctx), ctx);
    const stroke = paintAttr(cmd.stroke, ctx);
    const closed = cmd.op === "poly";
    const shape = {
      stroke: stroke || "",
      "stroke-width": cmd.strokeWidth,
      "stroke-linecap": cmd.cap,
      "stroke-linejoin": "round",
      "fill-opacity": cmd.fill && cmd.opacity < 1 ? cmd.opacity : "",
      "stroke-opacity": cmd.stroke && cmd.opacity < 1 ? cmd.opacity : "",
    };
    /* 一点控制点都没写就还是 polyline / polygon，输出和以前一模一样；
       写了才换成 path，因为只有 path 认 C 段 */
    const node = hasHandles(cmd.points)
      ? pictureNode("path", { d: edgePath(cmd.points, closed), ...shape })
      : pictureNode(closed ? "polygon" : "polyline", {
          points: cmd.points.map((p) => `${p.x},${p.y}`).join(" "),
          ...shape,
        });
    node.setAttribute("fill", fill || "none");
    return node;
  }
  if (cmd.op === "stroke") {
    const points = cmd.points;
    const fade = cmd.opacity < 1 ? cmd.opacity : "";
    /* 墨不吃光：一笔墨是贴在面上的黑，不是受光的立面。给 use 写了 face 曾连着素材里的
       黑线一起调亮，k 一大小人就变成纸片白——漆才跟着明暗走，墨守住自己。 */
    const ink = cmd.color;
    /* 一个点就是戳一下：没有方向可推法线，画个圆点 */
    if (points.length === 1) {
      return pictureNode("circle", {
        cx: points[0].x,
        cy: points[0].y,
        r: strokeRadiusOf(points[0], cmd.size),
        fill: ink,
        "fill-opacity": fade,
      });
    }
    const grain = Number(cmd.grain) || 0;
    if (grain > 0) {
      /* 所有股塞进同一条 path 的多个子路径：DOM 还是一个节点，expanded 不用跟着涨，
         几百根丝也只多占一条 path 的 d。拆不出丝（点太少）就当没起枯，别画成空的 */
      const d = grainStrands(points, cmd.size, grain).join(" ");
      if (d) {
        return pictureNode("path", {
          d,
          fill: ink,
          "fill-opacity": fade,
          stroke: "none",
        });
      }
    }
    const uniform = strokeUniformWidth(points, cmd.size);
    const node = uniform
      ? pictureNode("path", {
          d: strokeCenterPath(points),
          stroke: ink,
          "stroke-width": uniform,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          "stroke-opacity": fade,
        })
      : pictureNode("path", {
          d: strokeOutlinePath(points, cmd.size),
          fill: ink,
          "fill-opacity": fade,
        });
    /* 同 poly 那条规矩：fill / stroke 不写就得显式给 none，默认值是黑的 */
    node.setAttribute(uniform ? "fill" : "stroke", "none");
    return node;
  }
  if (cmd.op === "text") {
    const node = pictureNode("text", {
      x: cmd.x,
      y: cmd.y,
      "font-size": cmd.size,
      "font-weight": cmd.weight === "bold" ? "bold" : "",
      "font-family": PICTURE_FAMILIES[cmd.font] || PICTURE_FAMILIES.sans,
      /* 字是墨，跟着上一条规矩走：只上在墙上的漆随光明暗，题字和招牌的黑不跟着跑 */
      fill: cmd.color,
      "fill-opacity": cmd.opacity < 1 ? cmd.opacity : "",
      transform: cmd.rotate ? `rotate(${cmd.rotate} ${cmd.x} ${cmd.y})` : "",
    });
    node.textContent = cmd.text;
    return node;
  }
  if (cmd.op === "group") {
    const g = pictureNode("g", {
      transform: `translate(${cmd.x} ${cmd.y}) rotate(${cmd.rotate}) scale(${cmd.scale})`,
    });
    for (const child of cmd.cmds) {
      const node = renderPictureCmd(child, ctx);
      if (node) g.append(node);
    }
    return g;
  }
  /* 摆素材：本体是 defs 里那一份 <g>，这里只写落点。
     素材声明的落点 (ox,oy) 正好压到 (x,y) 上，旋转缩放都绕这个点。 */
  if (cmd.op === "use") {
    const view = symbolView(ctx?.symbols, ctx?.view || new Map(), cmd);
    if (!view) return null;
    const node = pictureNode("use", {
      transform: `translate(${cmd.x} ${cmd.y}) rotate(${cmd.rotate}) scale(${cmd.scale}) translate(${-view.symbol.ox} ${-view.symbol.oy})`,
      opacity: cmd.opacity < 1 ? cmd.opacity : "",
    });
    node.setAttribute("href", `#${pictureSymbolDef(view, ctx)}`);
    return node;
  }
  /* 垫一张位图。旋转绕框中心，和 group / use 绕落点不一样——参考图是「框里的一张纸」，
     转的时候它原地转，不该甩到左上角那个落点上去。
     图没到（地址取不到）就画一个同框的虚线框：位置和尺寸都还在，不至于看着像这条指令凭空丢了。 */
  if (cmd.op === "image") {
    const cx = cmd.x + cmd.w / 2;
    const cy = cmd.y + cmd.h / 2;
    const transform = cmd.rotate ? `rotate(${cmd.rotate} ${cx} ${cy})` : "";
    const fade = cmd.opacity < 1 ? cmd.opacity : "";
    const url = ctx?.media ? ctx.media(cmd.src) || "" : "";
    if (!url) {
      return pictureNode("rect", {
        x: cmd.x,
        y: cmd.y,
        width: cmd.w,
        height: cmd.h,
        fill: "none",
        stroke: "#9a9a9a",
        "stroke-width": 2,
        "stroke-dasharray": "8 6",
        "stroke-opacity": 0.7,
        opacity: fade,
        transform,
      });
    }
    const node = pictureNode("image", {
      x: cmd.x,
      y: cmd.y,
      width: cmd.w,
      height: cmd.h,
      preserveAspectRatio: cmd.fit === "fill" ? "none" : "xMidYMid meet",
      opacity: fade,
      transform,
      /* 导出和截图要把图内联成 data:（那张画布走的是 data: URL 的 svg，里头不许再联网取资源），
         而手上的地址是 tauri 那个本地 URL，倒推不回 src——所以把 src 和存法一起留在节点上 */
      "data-picture-src": cmd.src,
      "data-picture-linked": cmd.linked ? "1" : "",
    });
    node.setAttribute("href", url);
    return node;
  }
  return null;
}

/* 裁剪框用块自己的尺寸：画面坐标可以跑到框外，框外那部分不显示但数据还在，
   把块拉大或以后挪裁剪框就能看见。 */
function syncPictureElement(el, item) {
  const card = el.querySelector(".canvas-picture-card");
  if (!card) return;
  card.style.background = item.paperColor || "transparent";
  /* 圆角要跟着块走：卡片 overflow:hidden 裁画面，半径不一致就会露出直角 */
  card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
  const svg = card.querySelector(".canvas-picture-svg");
  if (!svg) return;
  const w = Math.max(1, Math.round(item.w));
  const h = Math.max(1, Math.round(item.h));
  let clipId = svg.querySelector("clipPath")?.id || "";
  if (!clipId) {
    pictureClipSeq += 1;
    clipId = `canvas-picture-clip-${pictureClipSeq}`;
    const defs = pictureNode("defs", {});
    const clip = pictureNode("clipPath", { id: clipId });
    clip.append(pictureNode("rect", { x: 0, y: 0, width: w, height: h }));
    const body = pictureNode("g", { "clip-path": `url(#${clipId})` });
    defs.append(clip);
    svg.append(defs, body);
  } else {
    const rect = svg.querySelector("clipPath rect");
    if (rect) {
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(h));
    }
  }
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  /* 只认 svg 的直接子节点：defs 排在 body 前面，素材实例就是 defs 里的 <g>，
     按标签名 querySelector("g") 会把 body 认成某个素材节点——那个节点随后就被清掉，
     新画的一整串塞进了脱离文档的枝上，块上只剩旧指令的描边，渐变图案 use 全空。 */
  const body = svg.querySelector(":scope > g");
  const defs = svg.querySelector("defs");
  if (!body || !defs) return;
  /* 每幅重画先把上一轮现造的 defs 清掉：渐变、素材、图案的 id 都是递增的，不清就一路堆下去 */
  for (const stale of [...defs.querySelectorAll("linearGradient, radialGradient, [data-canvas-picture-def]")]) {
    stale.remove();
  }
  const ctx = {
    defs,
    symbols: item.symbols || null,
    /* 一套光挂在块上：指令里存的仍是固有色，明暗每次现算。
       没写 light 的块这儿是 null，往下一个调色分支都进不去，输出和没做这功能时逐字相同。 */
    light: item.light || null,
    view: new Map(),
    defCache: new Map(),
    media: pictureMedia,
    /* 遮罩的生效区域按整块画区算（userSpaceOnUse）：不锁死的话它只覆盖被遮元素自己
       外扩 10% 的包围盒，一条长渐变的淡出会被齐根截断 */
    box: { w, h },
  };
  body.replaceChildren(
    /* 先按块上的图层开关过一遍：关掉的层是真不画，不是画成透明——
       画成透明的话导出、截图、橡皮都还得再判一次，早晚对不上 */
    ...pictureTopLayers(item.cmds, item.hidden)
      .filter((one) => one.drawn)
      .map(({ cmd, drawn }) => {
        const node = renderPictureCmd(drawn, ctx);
        /* 号记在节点上：橡皮拖动时按号把命中的那几条临时藏起来，不必整幅重画 */
        if (node) node.dataset.cmd = String(cmd.i);
        return node;
      })
      .filter(Boolean),
  );
}

/* 场景块：把这一块的当前数据交给渲染器。渲染器内部第一次会去拉 three.js，
   拉之前这块只有那句「场景加载中…」，拉到之后每次同步都是重画一帧。 */
function syncSceneElement(el, item) {
  const view = el.querySelector(".canvas-scene-view");
  if (view) syncScene(view, item);
}

export function syncItemElement(el, item) {
  el.classList.toggle("is-locked", Boolean(item.locked));
  el.style.left = `${item.x}px`;
  el.style.top = `${item.y}px`;

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
    /* 没有边框时宽度交回样式表的透明虚线，别让边框宽度偷偷吃掉内容宽 */
    el.style.borderWidth = item.bordered
      ? `${Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH}px`
      : "";
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : TEXT_DEFAULT_RADIUS}px`;
    return;
  }

  if (item.type === "audio") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    return;
  }

  /* 视频壳、文件卡片、笔记和书页的排版都在卡片自己手里，这里只管按块的宽高摆位置 */
  if (
    item.type === "video" ||
    item.type === "file" ||
    item.type === "ebook" ||
    item.type === "note"
  ) {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    if (item.type === "note") syncNoteColors(el, item);
    else if (item.type === "file") syncFileColors(el, item);
    return;
  }

  if (item.type === "sticky") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    const card = el.querySelector(".canvas-sticky-card");
    if (card) {
      card.style.background = item.color;
      card.style.color = item.textColor;
      card.style.borderColor = item.borderColor || "";
      card.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
      card.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    }
    return;
  }

  if (item.type === "picture") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncPictureElement(el, item);
    return;
  }

  if (item.type === "scene") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncSceneElement(el, item);
    return;
  }

  if (item.type === "gen") {
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.borderColor = item.borderColor || "transparent";
    el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : CARD_DEFAULT_BORDER_WIDTH}px`;
    el.style.borderRadius = `${Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS}px`;
    syncGen(el, item);
    return;
  }

  el.style.width = `${item.w}px`;
  el.style.height = `${item.h}px`;
  if (item.type === "image") {
    // 用内偏移描边，不动布局，图片按比例缩放时不会抖
    const width = Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH;
    const radius = Number.isFinite(item.radius) ? item.radius : CARD_DEFAULT_RADIUS;
    el.style.outline = item.borderColor && width > 0 ? `${width}px solid ${item.borderColor}` : "none";
    el.style.outlineOffset = `-${width}px`;
    /* 外壳和图片都交给圆角，描边才跟得上图片的边 */
    el.style.borderRadius = `${radius}px`;
    const img = el.querySelector(".canvas-image");
    if (img) img.style.borderRadius = `${radius}px`;
    return;
  }
  el.style.borderColor = item.borderColor || "transparent";
  el.style.background = item.fillColor || "transparent";
  el.style.borderWidth = `${Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH}px`;
  if (item.type === "rect") {
    el.style.borderRadius = item.radius ? `${item.radius}px` : "";
  }
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
  /* 选中态画在线条底下：一条半透明粗光带，不覆盖线条本色 */
  const halo = document.createElementNS(SVG_NS, "path");
  halo.classList.add("canvas-edge-halo");
  /* 2px 的线太细，叠一条透明宽线专门接指针 */
  const hit = document.createElementNS(SVG_NS, "path");
  hit.classList.add("canvas-edge-hit");

  /* 连线中间的文字：位置每次跟着路径现算，没写字时整层不显示 */
  const label = document.createElementNS(SVG_NS, "g");
  label.classList.add("canvas-edge-label");
  const labelText = document.createElementNS(SVG_NS, "text");
  labelText.classList.add("canvas-edge-label-text");
  labelText.setAttribute("text-anchor", "middle");
  labelText.setAttribute("dominant-baseline", "middle");
  label.append(labelText);

  group.append(halo, visible, hit, label);
  syncConnectorElement(group, item, null);
  return group;
}

/* 标签落在连线中点：折线、曲线都按路径长度取，取不到就退到两端的中间 */
export function connectorLabelPoint(group, geometry) {
  const path = group?.querySelector(".canvas-edge-visible");
  if (path) {
    try {
      const length = path.getTotalLength();
      if (length > 0) {
        const point = path.getPointAtLength(length / 2);
        return { x: point.x, y: point.y };
      }
    } catch {
      /* 路径还没成形时浏览器会抛，按下面的兜底算 */
    }
  }
  if (!geometry) return null;
  return { x: (geometry.a.x + geometry.b.x) / 2, y: (geometry.a.y + geometry.b.y) / 2 };
}

export function syncConnectorElement(group, item, geometry) {
  const halo = group.querySelector(".canvas-edge-halo");
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
  if (halo) halo.setAttribute("d", geometry.d);

  const label = group.querySelector(".canvas-edge-label");
  const labelText = group.querySelector(".canvas-edge-label-text");
  const content = String(item.label || "").trim();
  if (!label || !labelText) return;
  if (!content) {
    label.setAttribute("visibility", "hidden");
    return;
  }
  label.removeAttribute("visibility");
  labelText.textContent = content;
  labelText.setAttribute("fill", color);
  const point = connectorLabelPoint(group, geometry);
  if (point) {
    labelText.setAttribute("x", String(point.x));
    labelText.setAttribute("y", String(point.y));
  }
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
