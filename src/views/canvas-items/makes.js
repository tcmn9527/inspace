/* canvas-items/makes.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { AUDIO_DEFAULT_HEIGHT, AUDIO_DEFAULT_WIDTH, BORDER_DEFAULT_WIDTH, CARD_DEFAULT_BORDER_WIDTH, CARD_DEFAULT_RADIUS, DEFAULT_BORDER, EBOOK_DEFAULT_HEIGHT, EBOOK_DEFAULT_WIDTH, FILE_DEFAULT_HEIGHT, FILE_DEFAULT_WIDTH, FILE_TEXT_EXPANDED_HEIGHT, FILE_TEXT_WIDTH, NOTE_DEFAULT_HEIGHT, NOTE_DEFAULT_WIDTH, PAGE_RATIOS, PDF_DEFAULT_HEIGHT, PDF_DEFAULT_WIDTH, PICTURE_DEFAULT_HEIGHT, PICTURE_DEFAULT_WIDTH, PRODUCT_DEFAULT_HEIGHT, PRODUCT_DEFAULT_WIDTH, QUOTE_DEFAULT_HEIGHT, QUOTE_DEFAULT_WIDTH, TEXT_DEFAULT_RADIUS, TEXT_DEFAULT_WIDTH, VIDEO_DEFAULT_HEIGHT, VIDEO_DEFAULT_WIDTH } from "./constants.js";
import { isPdfExt } from "./dom-files.js";
import { accentStroke, newId, ratio } from "./util.js";

export function makeBox(type, x1, y1, x2, y2) {
  return {
    id: newId(),
    internal: true,
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
    internal: true,
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
    internal: true,
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
    /* 文字块的对齐：水平左/中/右，垂直顶/中/底（垂直要块被拉高才看得出来） */
    align: "left",
    vAlign: "top",
  };
}

/* 图片块两种存在方式：拷贝态 src 是画布 images/ 里的相对路径，引用态是原图绝对路径。 */
export function makeImage(x, y, w, h, src, linked = false) {
  return {
    id: newId(),
    internal: true,
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

/* 产品/材料卡：一件家具一行字段。户型脚印以后按这个 id 找回来。 */
export function makeProduct(x, y, name = "未命名产品", src = "") {
  return {
    id: newId(),
    internal: true,
    type: "product",
    x,
    y,
    w: PRODUCT_DEFAULT_WIDTH,
    h: PRODUCT_DEFAULT_HEIGHT,
    name,
    brand: "",
    sku: "",
    spec: "",
    price: 0,
    qty: 1,
    source: "",
    note: "",
    src,
    dims: { w: 0, d: 0, h: 0 },
    borderColor: "",
    fillColor: "",
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

export function makeQuote(x, y, title = "家具清单") {
  return {
    id: newId(),
    internal: true,
    type: "quote",
    x,
    y,
    w: QUOTE_DEFAULT_WIDTH,
    h: QUOTE_DEFAULT_HEIGHT,
    title,
    borderColor: "",
    fillColor: "",
    borderWidth: CARD_DEFAULT_BORDER_WIDTH,
    radius: CARD_DEFAULT_RADIUS,
  };
}

/* 提案页框：一块就是一张客户要看的页，内容按「块心落在页里」归页 */
export function makePage(x, y, ratio = "a4", title = "未命名页", order = 0) {
  const preset = PAGE_RATIOS[ratio] || PAGE_RATIOS.a4;
  return {
    id: newId(),
    internal: true,
    type: "page",
    x,
    y,
    w: preset.w,
    h: preset.h,
    title,
    ratio: PAGE_RATIOS[ratio] ? ratio : "a4",
    order: Math.max(0, Math.trunc(Number(order) || 0)),
    fillColor: "#ffffff",
    /* 页框永远垫在内容底下：新建时给负层，后来的块自然盖在它上面 */
    z: -1,
  };
}

/* 户型块：一张图 + 一套真实比例（两点定标），家具脚印和机位都按毫米记 */

export function makeAudio(x, y, name, src, linked = false) {
  return {
    id: newId(),
    internal: true,
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
    internal: true,
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

/* 画面块：正文就是那份指令列表，跟着 items.json 一起走（不像笔记另存一份文件）。
   坐标是块内的画面坐标，和块自身的左上角同原点，可以出现负数。 */
export function makePicture(x, y, w = PICTURE_DEFAULT_WIDTH, h = PICTURE_DEFAULT_HEIGHT) {
  return {
    id: newId(),
    internal: true,
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

export function makeNote(x, y, path, name, source, link = {}) {
  return {
    id: newId(),
    internal: true,
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
   拷贝态 src 是画布 files/ 里的相对路径，引用态是原文件绝对路径。
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
    internal: true,
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
   拷贝态 src 是画布 files/ 里的相对路径，引用态是原书绝对路径。 */
export function makeEbook(x, y, name, src, linked = false) {
  return {
    id: newId(),
    internal: true,
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
