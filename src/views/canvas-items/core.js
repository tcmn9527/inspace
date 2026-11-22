/* canvas-items/core.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { AUDIO_DEFAULT_HEIGHT, AUDIO_DEFAULT_WIDTH, AUDIO_MIN_HEIGHT, AUDIO_MIN_WIDTH, BORDER_DEFAULT_WIDTH, BORDER_MAX_WIDTH, CARD_DEFAULT_BORDER_WIDTH, CARD_DEFAULT_RADIUS, DEFAULT_BORDER, DOCX_DEFAULT_HEIGHT, DOCX_DEFAULT_WIDTH, DOCX_MIN_HEIGHT, DOCX_MIN_WIDTH, EBOOK_DEFAULT_HEIGHT, EBOOK_DEFAULT_WIDTH, EBOOK_MIN_HEIGHT, EBOOK_MIN_WIDTH, FILE_DEFAULT_HEIGHT, FILE_DEFAULT_WIDTH, FILE_MIN_HEIGHT, FILE_MIN_WIDTH, GEN_CFG_AUTO, GEN_CFG_MAX, GEN_DEFAULT_HEIGHT, GEN_DEFAULT_WIDTH, GEN_IMAGE_DEFAULT, GEN_MIN_HEIGHT, GEN_MIN_WIDTH, GEN_MODES, GEN_MODE_DEFAULT, GEN_STEPS_AUTO, GEN_STEPS_MAX, GEN_STRENGTH_DEFAULT, GEN_STRENGTH_MAX, GEN_STRENGTH_MIN, GEN_TEXT_MAX, GEN_VIDEO_DEFAULT_HEIGHT, GEN_VIDEO_DEFAULT_WIDTH, GEN_VIDEO_MIN_HEIGHT, GEN_VIDEO_MIN_WIDTH, GEN_VIDEO_SECONDS_DEFAULT, NOTE_DEFAULT_HEIGHT, NOTE_DEFAULT_WIDTH, NOTE_MIN_HEIGHT, NOTE_MIN_WIDTH, PAGE_RATIOS, PICTURE_DEFAULT_HEIGHT, PICTURE_DEFAULT_WIDTH, PICTURE_MAX_CMDS, PICTURE_MIN_HEIGHT, PICTURE_MIN_WIDTH, PLAN_DEFAULT_HEIGHT, PLAN_DEFAULT_WIDTH, PLAN_MIN_HEIGHT, PLAN_MIN_WIDTH, PPTX_DEFAULT_HEIGHT, PPTX_DEFAULT_WIDTH, PPTX_MIN_HEIGHT, PPTX_MIN_WIDTH, PRODUCT_DEFAULT_HEIGHT, PRODUCT_DEFAULT_WIDTH, PRODUCT_MIN_HEIGHT, PRODUCT_MIN_WIDTH, QUOTE_DEFAULT_HEIGHT, QUOTE_DEFAULT_WIDTH, QUOTE_MIN_HEIGHT, QUOTE_MIN_WIDTH, SCENE_DEFAULT_HEIGHT, SCENE_DEFAULT_WIDTH, SCENE_MIN_HEIGHT, SCENE_MIN_WIDTH, TEXT_DEFAULT_RADIUS, TEXT_DEFAULT_WIDTH, VIDEO_DEFAULT_HEIGHT, VIDEO_DEFAULT_WIDTH, VIDEO_MIN_HEIGHT, VIDEO_MIN_WIDTH, XLSX_DEFAULT_HEIGHT, XLSX_DEFAULT_WIDTH, XLSX_MIN_HEIGHT, XLSX_MIN_WIDTH } from "./constants.js";
import { snapGenSize } from "./gen-makes.js";
import { sanitizeInlineHtml } from "../inline-html.js";
import { normalizeHidden, normalizeLight, normalizePictureCmds, normalizePictureSymbols } from "./picture.js";
import { normalizePlanAreas, normalizePlanCalibration, normalizePlanCameras, normalizePlanFootprints } from "./plan.js";
import { normalizeSceneCamera, normalizeSceneParts, normalizeSceneSurfaces } from "./scene-parts.js";
import { CONNECTOR_MAX_POINTS, SIDES, accentStroke, clamp, colorOr, num } from "./util.js";

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

export function normalizeEnd(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.item !== "string") return null;
  return {
    item: raw.item,
    side: SIDES.includes(raw.side) ? raw.side : "auto",
  };
}

/* 块之间的叠放层级；连线不进这一套，固定在最底层 */
export const layerOf = (raw) => (Number.isFinite(raw.z) ? Math.trunc(raw.z) : null);


export function normalizeItem(raw) {
  const item = normalizeBlock(raw);
  /* 锁是块自己的状态，连线不参与 */
  if (item && item.type !== "connector" && raw.locked === true) item.locked = true;
  return item;
}

export function normalizeBlock(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const type = raw.type;
  /* seq 是画布内的固定编号：右下角坐标条和 agent 对块说话都靠它 */
  const base = { id: raw.id, type, seq: Number.isFinite(raw.seq) ? Math.trunc(raw.seq) : 0 };
  /* 客户版隐藏：所有能出现在页面上的块都认，连线不参与 */
  if (type !== "connector") base.internal = raw.internal !== false;
  /* 归属的容器（矩形框编成的分组）：重叠的框各自认自己的子块，拖完/重开都不会串 */
  if (type !== "connector" && typeof raw.containerId === "string") {
    base.containerId = raw.containerId;
  }
  /* 面板树自定义名：只影响树显示，不动块本身的语义名字 */
  if (type !== "connector" && typeof raw.treeName === "string" && raw.treeName.trim()) {
    base.treeName = raw.treeName.trim().slice(0, 60);
  }
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
      align: ["left", "center", "right"].includes(raw.align) ? raw.align : "left",
      vAlign: ["top", "middle", "bottom"].includes(raw.vAlign) ? raw.vAlign : "top",
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
      /* 导入时的原文件名：拷贝进画布会改名，搜索还得按用户记得的名字找得到 */
      name: typeof raw.name === "string" ? raw.name : "",
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : "",
      borderWidth: Math.min(BORDER_MAX_WIDTH, Math.max(0, Math.round(num(raw.borderWidth, BORDER_DEFAULT_WIDTH)))),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
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
      /* 引用态：src 是原片的绝对路径，画布里不存副本 */
      linked: raw.linked === true,
      /* sized：已经按视频真实比例定过一次大小，之后尊重用户手拉的尺寸 */
      sized: raw.sized === true,
      /* 转出来的 AAC 音轨副本（画布目录里的相对路径），没有就是空串 */
      audioRel: typeof raw.audioRel === "string" ? raw.audioRel : "",
      /* 音量是定下来就记住的：0 表示静，1 表示原声 */
      volume: Math.min(1, Math.max(0, num(raw.volume, 1))),
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
      /* 选中文字设的字级样式只存在画布这块上，不写回 .txt / .md 源文件。
         复制块带着它一起走；落进内存前先过白名单，别让外部 HTML 混进来。 */
      ...(typeof raw.richHtml === "string" && raw.richHtml ? { richHtml: sanitizeInlineHtml(raw.richHtml) } : {}),
      /* 引用态 src 就是原文件绝对路径，画布 files/ 里没有副本 */
      linked: raw.linked === true,
      /* PDF 块读到哪儿是这块自己的状态：第几页 + 这一页滚过去几成，重开接着读 */
      page: Math.max(1, Math.trunc(num(raw.page, 1))),
      pageFrac: Math.min(1, Math.max(0, num(raw.pageFrac, 0))),
      /* 文本预览读到哪儿：滚过的比例（0~1）。存比例不存像素，块被拉宽拉窄、
         正文重新排版后位置依然对得上；重开画布、切回浏览态都接着上次读。 */
      readFrac: Math.min(1, Math.max(0, num(raw.readFrac, 0))),
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
      /* 读到第几章是这块自己的状态，重开画布接着上次那页 */
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
      surfaces: normalizeSceneSurfaces(raw.surfaces).surfaces,
      /* 机位写歪了当「没定过」：让渲染器按内容自己框一个，比拿一堆 NaN 去摆相机好 */
      camera: normalizeSceneCamera(raw.camera),
      /* 没挂光就是平光：和画面块同一个约定，坏数据不许把整块判死 */
      light: normalizeLight(raw.light).light || null,
      /* 阴影默认开；关掉只影响这一块的渲染，不进 GLB 导出 */
      shadow: raw.shadow !== false,
      groundColor: colorOr(raw.groundColor, ""),
      /* 地面辅助网格：开着时按镜头距离自动细分（主格 + 细线），不进 GLB */
      grid: raw.grid === true || ["small", "medium", "large"].includes(raw.grid),
      /* 正交投影：户型/产品那种无透视的轴测视角 */
      ortho: raw.ortho === true,
      /* 存下来的机位（最多 3 个）：点一下切过去 */
      cameras: (Array.isArray(raw.cameras) ? raw.cameras : [])
        .slice(0, 3)
        .map((one) => {
          const cam = normalizeSceneCamera(one?.camera);
          return cam
            ? { name: String(one?.name || "").slice(0, 24) || "机位", camera: cam, ortho: one?.ortho === true }
            : null;
        })
        .filter(Boolean),
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
      steps: Math.round(clamp(num(raw.steps, GEN_STEPS_AUTO), 0, GEN_STEPS_MAX)),
      cfg: clamp(num(raw.cfg, GEN_CFG_AUTO), 0, GEN_CFG_MAX),
      /* 用哪一族出图：空串 = 跟设置里的当前模型走 */
      model: raw.model === "qwen21" || raw.model === "h3image" ? raw.model : "",
      /* -1 在引擎里是「每张换一个」的哨兵；认不出别的数一律退回它 */
      seed: Number.isFinite(raw.seed) && raw.seed >= 0 ? Math.trunc(raw.seed) : -1,
      /* 取景窗自己的高度：提示词框变高时块跟着长，这一截不动 */
      stageH: Number.isFinite(raw.stageH) ? Math.max(0, Math.round(raw.stageH)) : 0,
      /* 手动拖过尺寸的面板，重开画布也不按提示词自动改高 */
      manualSize: raw.manualSize === true,
      mode: GEN_MODES.includes(raw.mode) ? raw.mode : GEN_MODE_DEFAULT,
      strength: clamp(num(raw.strength, GEN_STRENGTH_DEFAULT), GEN_STRENGTH_MIN, GEN_STRENGTH_MAX),
      /* 高清放大后要不要再补一遍低强度重绘（长出纹理） */
      refine: raw.refine === true,
      /* 最近那一张，记的是 <画布>/images/ 里的相对路径；还没出过图是空串 */
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
  if (type === "genvideo") {
    const seconds = Math.round(num(raw.seconds, GEN_VIDEO_SECONDS_DEFAULT));
    /* 老块只有 ratio；新块直接存像素宽高。视频编码要偶数边。 */
    const legacy =
      raw.ratio === "9:16" ? [720, 1280] : raw.ratio === "1:1" ? [1024, 1024] : [1280, 720];
    const width = Math.max(64, Math.min(4096, Math.round(num(raw.width, legacy[0]))));
    const height = Math.max(64, Math.min(4096, Math.round(num(raw.height, legacy[1]))));
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(GEN_VIDEO_MIN_WIDTH, num(raw.w, GEN_VIDEO_DEFAULT_WIDTH)),
      h: Math.max(GEN_VIDEO_MIN_HEIGHT, num(raw.h, GEN_VIDEO_DEFAULT_HEIGHT)),
      prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, GEN_TEXT_MAX) : "",
      seconds: Math.max(1, Math.min(60, seconds)),
      width: width - (width % 2),
      height: height - (height % 2),
      borderColor: typeof raw.borderColor === "string" ? raw.borderColor : DEFAULT_BORDER,
      borderWidth: Math.min(
        BORDER_MAX_WIDTH,
        Math.max(0, Math.round(num(raw.borderWidth, CARD_DEFAULT_BORDER_WIDTH))),
      ),
      radius: Math.max(0, Math.round(num(raw.radius, CARD_DEFAULT_RADIUS))),
      z: layerOf(raw),
    };
  }
  if (type === "product") {
    const dims = raw.dims && typeof raw.dims === "object" ? raw.dims : {};    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(PRODUCT_MIN_WIDTH, num(raw.w, PRODUCT_DEFAULT_WIDTH)),
      h: Math.max(PRODUCT_MIN_HEIGHT, num(raw.h, PRODUCT_DEFAULT_HEIGHT)),
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "未命名产品",
      brand: typeof raw.brand === "string" ? raw.brand : "",
      sku: typeof raw.sku === "string" ? raw.sku : "",
      spec: typeof raw.spec === "string" ? raw.spec : "",
      price: Math.max(0, num(raw.price, 0)),
      qty: Math.max(1, Math.trunc(num(raw.qty, 1))),
      source: typeof raw.source === "string" ? raw.source : "",
      note: typeof raw.note === "string" ? raw.note : "",
      /* 产品图是画布 images/ 里的副本，不是引用态 */
      src: typeof raw.src === "string" ? raw.src : "",
      /* 下面两样先存着，P2/P3 的 3D 模型和户型脚印会指回来 */
      model: typeof raw.model === "string" ? raw.model : "",
      dims: {
        w: Math.max(0, num(dims.w, 0)),
        d: Math.max(0, num(dims.d, 0)),
        h: Math.max(0, num(dims.h, 0)),
      },
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
  if (type === "quote") {
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(QUOTE_MIN_WIDTH, num(raw.w, QUOTE_DEFAULT_WIDTH)),
      h: Math.max(QUOTE_MIN_HEIGHT, num(raw.h, QUOTE_DEFAULT_HEIGHT)),
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "家具清单",
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
  if (type === "plan") {
    const w = Math.max(PLAN_MIN_WIDTH, num(raw.w, PLAN_DEFAULT_WIDTH));
    const h = Math.max(PLAN_MIN_HEIGHT, num(raw.h, PLAN_DEFAULT_HEIGHT));
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w,
      h,
      /* 户型图是画布 images/ 里的副本 */
      src: typeof raw.src === "string" ? raw.src : "",
      imageW: Math.max(0, num(raw.imageW, 0)),
      imageH: Math.max(0, num(raw.imageH, 0)),
      calibration: normalizePlanCalibration(raw.calibration),
      footprints: normalizePlanFootprints(raw.footprints),
      cameras: normalizePlanCameras(raw.cameras),
      areas: normalizePlanAreas(raw.areas),
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
  if (type === "page") {
    const ratio = PAGE_RATIOS[raw.ratio] ? raw.ratio : "a4";
    const preset = PAGE_RATIOS[ratio];
    return {
      ...base,
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(200, num(raw.w, preset.w)),
      h: Math.max(200, num(raw.h, preset.h)),
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "未命名页",
      ratio,
      order: Math.max(0, Math.trunc(num(raw.order, 0))),
      fillColor: typeof raw.fillColor === "string" && raw.fillColor ? raw.fillColor : "#ffffff",
      z: layerOf(raw),
    };
  }
  return null;
}

/* 笔记和画面的正文不归 items.json 管：一篇笔记是 <画布>/notes/<块id>.md，
   一幅画面是 <画布>/pictures/<块id>.json。
   运行时对象上那些字段只是从文件里读回来的缓存，
   存回去就成一份数据两处摆，改一处漏一处。 */
export function toPersisted(item) {
  if (item.type === "note") {
    const { source, ...rest } = item;
    return rest;
  }
  if (item.type === "picture") {
    /* 手绘一笔就上百个点，整幅塞进 items.json 会把这个画布的读写一起拖慢 */
    const { cmds, ...rest } = item;
    return rest;
  }
  if (item.type === "scene") {
    /* 同理：一件东西的底面就有一圈坐标点，那份东西列表只认 scenes/<块id>.json。
       「编辑」时场景临时铺满画布，盘上仍记用户原来摆的位置尺寸 */
    const { parts, __editRestore, ...rest } = item;
    if (__editRestore) {
      Object.assign(rest, {
        x: __editRestore.x,
        y: __editRestore.y,
        w: __editRestore.w,
        h: __editRestore.h,
        z: __editRestore.z,
      });
    }
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
