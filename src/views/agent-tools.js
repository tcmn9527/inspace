/* MCP 工具表：给 agent 看的名字、说明和参数，以及把一次调用派给动作层的分发。
 *
 * 这里只做「参数翻译 + 切页 + 演示节奏」；真正改数据的是 canvas.js / notes.js
 * 里那套和菜单、拖拽共用的动作函数，所以 agent 和用户手工操作不会写出两种状态。
 *
 * 所有会改界面的工具都默认先切到对应页面，用户能当场看见；返回前留一小拍高亮，
 * 传 pace: "instant" 可以跳过这一拍。 */

import { GUIDE_TOPICS, guideText } from "./agent-guide.js";
import { canvasAgent } from "./canvas.js";
import { notesAgent } from "./notes.js";
import { LIGHT_THEMES, THEMES, currentTheme, setTheme } from "./theme.js";

const { invoke } = window.__TAURI__.core;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PACE = {
  type: "string",
  enum: ["normal", "instant"],
  description: "演示节奏。normal（默认）会滚动镜头、给目标加一圈光带；instant 只改结果不演示。",
};

const ID = { type: "string", description: "块的 id（从 space_scene / block_create 的返回里拿）" };
const IDS = { type: "array", items: { type: "string" }, description: "一组块的 id" };
const COLOR = { type: "string", description: "颜色，CSS 色值如 #ff8800；空字符串表示无" };
const POINTS = {
  type: "array",
  description:
    "手动折点：世界坐标 {x,y} 数组，线按 from → 折点依次 → to 走；最多 40 个，传 [] 清空回到自动走线",
  items: {
    type: "object",
    properties: { x: { type: "number" }, y: { type: "number" } },
    required: ["x", "y"],
  },
};
const BEND = {
  type: "boolean",
  description: "折点模式：true 打开，之后可以拖线身加折点；false 关闭并清除所有折点。连线默认关闭",
};
const X = { type: "number", description: "块左上角的世界坐标 x（空间坐标，原点在空间左上角）" };
const Y = { type: "number", description: "块左上角的世界坐标 y" };
const W = { type: "number", description: "宽度（像素）" };
const H = { type: "number", description: "高度（像素）" };

const def = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: { ...properties, pace: PACE },
    required,
  },
});

const TOOL_DEFS = [
  def("guide", "速查手册：所有工具怎么配合用、每种块怎么建、坐标与颜色约定、常用配方和易错点。第一次接手先调它；不传 topic 返回整本手册。", {
    topic: { type: "string", enum: GUIDE_TOPICS, description: "只看一章；不传返回整本" },
  }),
  def("app_state", "看当前应用状态：正在哪一页、数据文件夹、当前主题、当前空间和相机、当前打开的笔记、MCP 服务端口。"),
  def("theme_list", "列出所有主题（id、名字、深色/浅色），并标出当前用的那套。"),
  def("theme_set", "切换应用主题。宇宙主题会给空间打开实时深空背景（星野、星云、行星）。", {
    theme: { type: "string", description: "主题 id，从 theme_list 拿" },
  }, ["theme"]),
  def("space_list", "列出所有空间（id、名字、文件夹路径），并标出当前打开的是哪个。"),
  def("space_open", "切换到指定空间，等它读完再返回。space 传空间 id 或空间名。", {
    space: { type: "string", description: "空间 id 或名字" },
  }, ["space"]),
  def("space_create", "新建一个空间并切过去。", {
    name: { type: "string", description: "空间名" },
  }, ["name"]),
  def("space_rename", "给空间改名（磁盘文件夹跟着改）。", {
    space: { type: "string", description: "空间 id 或名字" },
    name: { type: "string", description: "新名字" },
  }, ["space", "name"]),
  def("space_delete", "删除空间：整个空间文件夹进系统回收站。", {
    space: { type: "string", description: "空间 id 或名字" },
  }, ["space"]),
  def("space_scene", "看当前空间里所有块的摘要：id、类型、位置尺寸、层级、各类型的关键字段。做任何块操作前先调这个拿 id。", {
    type: { type: "string", description: "只看某一类块（text/rect/ellipse/line/arrow/sticky/note/file/image/audio/video/ebook/connector），不传就全部" },
  }),
  def("block_get", "看单个块的摘要。", { id: ID }, ["id"]),
  def("block_create", "在空间里新建一块。坐标不给就落在视野中央、连续创建自动错开。", {
    type: { type: "string", description: "text/rect/ellipse/line/arrow/sticky/note/image/audio/video/file/ebook/connector" },
    x: X, y: Y, w: W, h: H,
    text: { type: "string", description: "文字块/便签的正文" },
    markdown: { type: "string", description: "笔记块的 Markdown 正文" },
    name: { type: "string", description: "笔记块的名字" },
    notePath: { type: "string", description: "从笔记库某篇笔记建成笔记块，传笔记库内相对路径" },
    path: { type: "string", description: "image/audio/video/file/ebook 块要的本机文件绝对路径" },
    mode: { type: "string", enum: ["copy", "link"], description: "文件拷进空间还是只引用原文件，默认 copy" },
    as: { type: "string", enum: ["image", "audio", "video", "file", "ebook"], description: "按指定类型落块，覆盖按扩展名的自动判断" },
    fontSize: { type: "number", description: "文字块字号" },
    radius: { type: "number", description: "矩形的圆角像素" },
    color: COLOR,
    textColor: { type: "string", description: "便签文字颜色" },
    borderColor: COLOR,
    fillColor: COLOR,
    x2: { type: "number", description: "线段终点的世界 x" },
    y2: { type: "number", description: "线段终点的世界 y" },
    shape: { type: "string", enum: ["curve", "elbow"], description: "连线的走线方式" },
    arrow: { type: "string", enum: ["none", "end", "both"], description: "连线的箭头" },
    label: { type: "string", description: "连线中点的文字" },
    points: POINTS,
    bend: BEND,
    from: { type: "string", description: "连线的起点块 id" },
    to: { type: "string", description: "连线的终点块 id" },
    fromSide: { type: "string", enum: ["auto", "top", "right", "bottom", "left"], description: "连线从起点的哪条边出去" },
  }, ["type"]),
  def("block_update", "改一块的位置、尺寸、颜色或正文。只传要改的字段。", {
    id: ID, x: X, y: Y, w: W, h: H,
    x2: { type: "number", description: "线段终点 x" },
    y2: { type: "number", description: "线段终点 y" },
    fontSize: { type: "number", description: "文字块字号" },
    radius: { type: "number", description: "矩形/文字块的圆角像素" },
    borderColor: COLOR,
    fillColor: COLOR,
    color: { type: "string", description: "文字色；便签上是底色" },
    textColor: { type: "string", description: "便签文字色" },
    text: { type: "string", description: "文字块/便签正文" },
    markdown: { type: "string", description: "空间内笔记块的 Markdown 正文（引用外部 .md 的块用 note_write）" },
    shape: { type: "string", enum: ["curve", "elbow"], description: "连线走线" },
    arrow: { type: "string", enum: ["none", "end", "both"], description: "连线箭头" },
    label: { type: "string", description: "连线文字" },
    points: POINTS,
    bend: BEND,
    from: { type: "string", description: "连线改起点块" },
    to: { type: "string", description: "连线改终点块" },
    fromSide: { type: "string", enum: ["auto", "top", "right", "bottom", "left"] },
  }, ["id"]),
  def("block_delete", "删除一块；挂在它身上的连线一起删。", { id: ID }, ["id"]),
  def("block_duplicate", "复制一块（媒体文件会真拷一份副本），默认落在原块右下 24px。", {
    id: ID,
    dx: { type: "number", description: "横向偏移，默认 24" },
    dy: { type: "number", description: "纵向偏移，默认 24" },
  }, ["id"]),
  def("block_select", "选中一块或一组块；additive 为 true 时加入现有多选。", {
    ids: IDS,
    additive: { type: "boolean", description: "是否加到现有多选上" },
  }, ["ids"]),
  def("block_layer", "调块的层级。", {
    id: ID,
    direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "上一层/下一层/最顶层/最底层" },
  }, ["id", "direction"]),
  def("block_reveal", "把镜头带到某一块；本来就在眼前就不动。", { id: ID }, ["id"]),
  def("block_highlight", "只给块加一圈演示光带，不改任何数据。", { ids: IDS }, ["ids"]),
  def("connector_create", "连两块：从 from 块的某条边接到 to 块，可以给手动折点。", {
    from: ID,
    to: ID,
    fromSide: { type: "string", enum: ["auto", "top", "right", "bottom", "left"] },
    shape: { type: "string", enum: ["curve", "elbow"] },
    arrow: { type: "string", enum: ["none", "end", "both"] },
    color: COLOR,
    label: { type: "string" },
    points: POINTS,
    bend: BEND,
  }, ["from", "to"]),
  def("connector_update", "改一条连线的走线、箭头、颜色、文字、折点或两端。", {
    id: ID,
    from: { type: "string" },
    to: { type: "string" },
    fromSide: { type: "string", enum: ["auto", "top", "right", "bottom", "left"] },
    shape: { type: "string", enum: ["curve", "elbow"] },
    arrow: { type: "string", enum: ["none", "end", "both"] },
    color: COLOR,
    label: { type: "string" },
    points: POINTS,
    bend: BEND,
  }, ["id"]),
  def("camera_get", "看当前相机位置和缩放。"),
  def("camera_set", "把相机移到指定位置/缩放。", {
    x: { type: "number", description: "相机偏移 x" },
    y: { type: "number", description: "相机偏移 y" },
    scale: { type: "number", description: "缩放，0.25 到 4" },
    instant: { type: "boolean", description: "true 时直接跳过去，不缓动" },
  }),
  def("camera_focus", "镜头对准某一块，可同时给缩放。", {
    id: ID,
    zoom: { type: "number", description: "目标缩放" },
  }, ["id"]),
  def("camera_fit", "缩放到刚好看见空间里所有块。"),
  def("camera_reset", "回到 100% 缩放，视野中心不动。"),
  def("sticky_read", "读便签正文和颜色。", { id: ID }, ["id"]),
  def("sticky_write", "写便签正文/底色/字色/边框色。", {
    id: ID,
    text: { type: "string" },
    color: { type: "string", description: "便签底色" },
    textColor: { type: "string", description: "便签文字色" },
    borderColor: COLOR,
  }, ["id"]),
  def("note_read", "读笔记块的 Markdown 正文。", { id: ID }, ["id"]),
  def("note_write", "写笔记块的 Markdown 正文；引用外部 .md 的块会把正文写回原文件。", {
    id: ID,
    markdown: { type: "string", description: "新的 Markdown 正文" },
  }, ["id", "markdown"]),
  def("file_read", "读文本文件块的整份正文（块内可编辑的那种）。", {
    id: ID,
    maxChars: { type: "number", description: "最多返回多少个字符，默认 20000，0 表示整份" },
  }, ["id"]),
  def("file_write", "把正文写回文本文件块对应的文件（拷贝态写空间副本，引用态写原文件）。", {
    id: ID,
    text: { type: "string", description: "完整的新正文" },
    force: { type: "boolean", description: "原文件在读取后被外部改过时，是否仍然覆盖" },
  }, ["id", "text"]),
  def("file_reveal", "在系统文件管理器里定位一块指向的磁盘文件。", { id: ID }, ["id"]),
  def("file_import", "把本机文件作为一块插进空间：图片、音频、视频、电子书、附件、Markdown 自动分类型。", {
    path: { type: "string", description: "本机文件绝对路径" },
    mode: { type: "string", enum: ["copy", "link"], description: "拷进空间还是只引用原文件，默认 copy" },
    as: { type: "string", enum: ["image", "audio", "video", "file", "ebook"], description: "按指定类型落块" },
    x: X, y: Y,
    borderColor: COLOR,
    fillColor: COLOR,
  }, ["path"]),
  def("pdf_state", "看 PDF 块读到第几页、一共几页。", { id: ID }, ["id"]),
  def("pdf_goto", "把 PDF 块跳到某一页。", {
    id: ID,
    page: { type: "number", description: "页码，从 1 开始" },
  }, ["id", "page"]),
  def("ebook_toc", "读电子书的章节目录和当前章。", { id: ID }, ["id"]),
  def("ebook_goto", "把电子书块翻到某一章。", {
    id: ID,
    chapter: { type: "number", description: "章序号，从 0 开始" },
  }, ["id", "chapter"]),
  def("media_state", "看音频/视频块的播放状态、进度、时长、音量。", { id: ID }, ["id"]),
  def("media_control", "控制音频/视频块：播放、暂停、跳进度、调音量。", {
    id: ID,
    action: { type: "string", enum: ["play", "pause", "toggle", "seek", "volume"] },
    value: { type: "number", description: "seek 是目标秒数，volume 是 0 到 1" },
  }, ["id", "action"]),
  def("notes_tree", "列出笔记库整棵文件树（文件夹和 .md 文件）。"),
  def("notes_read", "读一篇笔记的 Markdown 正文。", {
    path: { type: "string", description: "笔记库内相对路径，如 想法/某篇.md" },
  }, ["path"]),
  def("notes_write", "写一篇笔记的 Markdown 正文（整篇覆盖）。", {
    path: { type: "string" },
    text: { type: "string" },
  }, ["path", "text"]),
  def("notes_attach_image", "把一张本机图片复制进这篇笔记自己的图片目录，并插入到正文末尾。", {
    path: { type: "string", description: "本机图片路径" },
    notePath: { type: "string", description: "贴到哪篇笔记，不传就用当前打开的笔记" },
    append: { type: "boolean", description: "默认 true 插到正文末尾；false 只存图片不插入" },
  }, ["path"]),
  def("notes_create", "新建一篇笔记，可带初始正文。", {
    name: { type: "string", description: "笔记名，不用带 .md" },
    dir: { type: "string", description: "放进哪个文件夹（相对路径），不传放根目录" },
    text: { type: "string", description: "初始 Markdown 正文" },
  }, ["name"]),
  def("notes_create_folder", "在笔记库里新建文件夹。", {
    name: { type: "string" },
    dir: { type: "string", description: "放在哪个文件夹下，不传放根目录" },
  }, ["name"]),
  def("notes_rename", "给笔记或文件夹改名。", {
    path: { type: "string" },
    name: { type: "string", description: "新名字；笔记不用带 .md" },
  }, ["path", "name"]),
  def("notes_move", "把笔记或文件夹移到另一个文件夹。", {
    path: { type: "string" },
    dir: { type: "string", description: "目标文件夹相对路径，空字符串表示笔记根" },
  }, ["path"]),
  def("notes_delete", "永久删除一篇笔记或整个文件夹（不进回收站，谨慎）。", {
    path: { type: "string" },
  }, ["path"]),
  def("notes_open", "在笔记页打开一篇笔记给用户看。", {
    path: { type: "string" },
  }, ["path"]),
  def("notes_current", "看笔记页当前打开的笔记和编辑状态。"),
  def("notes_edit", "切笔记页的阅读/编辑状态。", {
    editing: { type: "boolean", description: "true 进入编辑，false 回到阅读" },
  }, ["editing"]),
  def("notes_reveal", "在系统文件管理器里定位笔记或文件夹。", {
    path: { type: "string", description: "空字符串表示笔记根目录" },
  }, ["path"]),
];

export const TOOL_LIST = TOOL_DEFS;

function viewNow() {
  return document.querySelector(".rail-item.is-active")?.dataset.route || "canvas";
}

async function ensureView(view) {
  if (viewNow() === view) {
    await (window.__inspace?.ready || Promise.resolve()).catch(() => {});
    return;
  }
  window.dispatchEvent(new CustomEvent("inspace:route", { detail: view }));
  await (window.__inspace?.ready || Promise.resolve()).catch(() => {});
  await sleep(60);
}

async function beat(args) {
  if (args.pace === "instant") return;
  await sleep(140);
}

async function onCanvas(args, run) {
  await ensureView("canvas");
  const data = await run();
  await beat(args);
  return data;
}

async function onNotes(args, run) {
  await ensureView("notes");
  const data = await run();
  await beat(args);
  return data;
}

function pick(args, keys) {
  const out = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

const BLOCK_FIELDS = [
  "x", "y", "w", "h", "x2", "y2", "fontSize", "radius",
  "borderColor", "fillColor", "color", "textColor", "text", "markdown",
  "shape", "arrow", "label", "bend", "points", "from", "to", "fromSide",
];

async function appState() {
  const [dataRoot, notesRoot, mcpInfo] = await Promise.all([
    invoke("data_root").catch(() => ""),
    invoke("notes_dir").catch(() => ""),
    invoke("mcp_info").catch(() => null),
  ]);
  let space = null;
  try {
    const scene = canvasAgent.scene();
    space = {
      id: scene.space.id,
      name: scene.space.name,
      blocks: scene.blocks.length,
      camera: scene.camera,
      selected: scene.selected,
    };
  } catch {
    space = null;
  }
  return {
    route: viewNow(),
    dataRoot,
    notesRoot,
    theme: currentTheme(),
    mcp: mcpInfo ? { running: mcpInfo.running, port: mcpInfo.port, url: mcpInfo.url, error: mcpInfo.error } : null,
    space,
    notes: notesAgent.current(),
  };
}

function themeCatalog() {
  return [
    ...THEMES.map(([id, name]) => ({ id, name, mode: "dark" })),
    ...LIGHT_THEMES.map(([id, name]) => ({ id, name, mode: "light" })),
  ];
}

function themeList() {
  return { current: currentTheme(), themes: themeCatalog() };
}

async function themeSet(args) {
  const id = String(args.theme || "");
  if (!themeCatalog().some((t) => t.id === id)) {
    throw new Error(`没有这个主题：${id}；先调 theme_list 看可选项`);
  }
  const applied = setTheme(id);
  await beat(args);
  return { theme: applied };
}

async function dispatch(name, args) {
  switch (name) {
    case "guide":
      return guideText(args.topic);
    case "app_state":
      return appState();
    case "theme_list":
      return themeList();
    case "theme_set":
      return themeSet(args);

    case "space_list":
      return onCanvas(args, () => canvasAgent.spaceList());
    case "space_open":
      return onCanvas(args, () => canvasAgent.spaceOpen(args.space));
    case "space_create":
      return onCanvas(args, () => canvasAgent.spaceCreate(args.name));
    case "space_rename":
      return onCanvas(args, () => canvasAgent.spaceRename(args.space, args.name));
    case "space_delete":
      return onCanvas(args, () => canvasAgent.spaceDelete(args.space));
    case "space_scene":
      return onCanvas(args, () => canvasAgent.scene(pick(args, ["type"])));

    case "block_get":
      return onCanvas(args, () => canvasAgent.blockGet(args.id));
    case "block_create":
      return onCanvas(args, () =>
        canvasAgent.blockCreate(pick(args, ["type", "x", "y", "w", "h", "text", "markdown", "name", "notePath", "path", "mode", "as", "fontSize", "radius", "color", "textColor", "borderColor", "fillColor", "x2", "y2", "shape", "arrow", "label", "bend", "points", "from", "to", "fromSide"])),
      );
    case "block_update":
      return onCanvas(args, () => canvasAgent.blockUpdate(args.id, pick(args, BLOCK_FIELDS)));
    case "block_delete":
      return onCanvas(args, () => canvasAgent.blockDelete(args.id));
    case "block_duplicate":
      return onCanvas(args, () => canvasAgent.blockDuplicate(args.id, pick(args, ["dx", "dy"])));
    case "block_select":
      return onCanvas(args, () => canvasAgent.blockSelect(args.ids, Boolean(args.additive)));
    case "block_layer":
      return onCanvas(args, () => canvasAgent.blockLayer(args.id, args.direction));
    case "block_reveal":
      return onCanvas(args, () => canvasAgent.blockReveal(args.id));
    case "block_highlight":
      return onCanvas(args, () => canvasAgent.blockHighlight(args.ids));

    case "connector_create":
      return onCanvas(args, () => canvasAgent.connectorCreate(pick(args, ["from", "to", "fromSide", "shape", "arrow", "color", "label", "bend", "points"])));
    case "connector_update":
      return onCanvas(args, () => canvasAgent.connectorUpdate(args.id, pick(args, ["from", "to", "fromSide", "shape", "arrow", "color", "label", "bend", "points"])));

    case "camera_get":
      return onCanvas(args, () => canvasAgent.cameraGet());
    case "camera_set":
      return onCanvas(args, () => canvasAgent.cameraSet(pick(args, ["x", "y", "scale", "instant"])));
    case "camera_focus":
      return onCanvas(args, () => canvasAgent.cameraFocus(args.id, pick(args, ["zoom"])));
    case "camera_fit":
      return onCanvas(args, () => canvasAgent.cameraFit());
    case "camera_reset":
      return onCanvas(args, () => canvasAgent.cameraResetZoom());

    case "sticky_read":
      return onCanvas(args, () => canvasAgent.stickyRead(args.id));
    case "sticky_write":
      return onCanvas(args, () => canvasAgent.stickyWrite(args.id, pick(args, ["text", "color", "textColor", "borderColor"])));
    case "note_read":
      return onCanvas(args, () => canvasAgent.noteRead(args.id));
    case "note_write":
      return onCanvas(args, () => canvasAgent.noteWrite(args.id, args.markdown ?? args.text ?? ""));
    case "file_read":
      return onCanvas(args, () => canvasAgent.fileRead(args.id, args.maxChars));
    case "file_write":
      return onCanvas(args, () => canvasAgent.fileWrite(args.id, args.text, Boolean(args.force)));
    case "file_reveal":
      return onCanvas(args, () => canvasAgent.fileReveal(args.id));
    case "file_import":
      return onCanvas(args, () => canvasAgent.importFile(pick(args, ["path", "mode", "as", "x", "y", "borderColor", "fillColor"])));

    case "pdf_state":
      return onCanvas(args, () => canvasAgent.pdfState(args.id));
    case "pdf_goto":
      return onCanvas(args, () => canvasAgent.pdfGoto(args.id, args.page));
    case "ebook_toc":
      return onCanvas(args, () => canvasAgent.ebookToc(args.id));
    case "ebook_goto":
      return onCanvas(args, () => canvasAgent.ebookGoto(args.id, args.chapter));
    case "media_state":
      return onCanvas(args, () => canvasAgent.mediaState(args.id));
    case "media_control":
      return onCanvas(args, () => canvasAgent.mediaControl(args.id, args.action, args.value));

    case "notes_tree":
      return onNotes(args, () => notesAgent.tree());
    case "notes_read":
      return onNotes(args, () => notesAgent.read(args.path));
    case "notes_write":
      return onNotes(args, () => notesAgent.write(args.path, args.text));
    case "notes_attach_image":
      return onNotes(args, () => notesAgent.attachImage(args.path, args.notePath, args.append));
    case "notes_create":
      return onNotes(args, () => notesAgent.create(args.name, args.dir, args.text));
    case "notes_create_folder":
      return onNotes(args, () => notesAgent.createFolder(args.name, args.dir));
    case "notes_rename":
      return onNotes(args, () => notesAgent.rename(args.path, args.name));
    case "notes_move":
      return onNotes(args, () => notesAgent.move(args.path, args.dir));
    case "notes_delete":
      return onNotes(args, () => notesAgent.remove(args.path));
    case "notes_open":
      return onNotes(args, () => notesAgent.open(args.path));
    case "notes_current":
      return onNotes(args, () => notesAgent.current());
    case "notes_edit":
      return onNotes(args, () => notesAgent.edit(args.editing));
    case "notes_reveal":
      return onNotes(args, () => notesAgent.reveal(args.path));

    default:
      throw new Error(`没有这个工具：${name}`);
  }
}

function textResult(text, isError) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

export async function runTool(name, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  try {
    const data = await dispatch(name, args);
    const text = typeof data === "string" ? data : JSON.stringify(data ?? {});
    return textResult(text, false);
  } catch (error) {
    return textResult(String(error?.message || error || "工具执行失败"), true);
  }
}
