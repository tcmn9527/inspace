/* 文章模板就是普通画布：统一放在左侧画布树的「文章模板」分组里。
 *
 * 这里不再维护 templates/articles 那种 JSON 目录。套模板时先按 id/名字找到
 * 模板画布，读它的 items，提取配色 / 布局 / 元素类型，再新建一张画布落块。 */

import { canvasAgent, current, store } from "../canvas.js";

const TEMPLATE_GROUP = "文章模板";

const unique = (values) => [...new Set(values.filter(Boolean))];
const round = (value) => Math.round(Number(value) || 0);

function findGroup(nodes, name) {
  for (const node of nodes || []) {
    if (node.type === "group" && node.name === name) return node;
    const nested = findGroup(node.children, name);
    if (nested) return nested;
  }
  return null;
}

function collectCanvases(node) {
  const out = [];
  for (const child of node?.children || []) {
    if (child.type === "canvas") out.push(child);
    else if (child.type === "group") out.push(...collectCanvases(child));
  }
  return out;
}

async function templateGroup(create = true) {
  let tree = (await canvasAgent.spaceTree()).tree || [];
  let group = findGroup(tree, TEMPLATE_GROUP);
  if (!group && create) {
    await canvasAgent.groupCreate("", TEMPLATE_GROUP);
    tree = (await canvasAgent.spaceTree()).tree || [];
    group = findGroup(tree, TEMPLATE_GROUP);
  }
  return group;
}

function colorPool(item) {
  return unique([item.fillColor, item.paperColor, item.borderColor, item.color]).slice(0, 12);
}

function roleOf(item) {
  switch (item.type) {
    case "text":
      return Number(item.fontSize) >= 28 ? "title" : "body";
    case "image":
    case "picture":
      return "image";
    case "quote":
      return "quote";
    case "rect":
    case "ellipse":
      return "decoration";
    default:
      return item.type || "other";
  }
}

function styleOf(item) {
  const style = {};
  for (const key of [
    "color", "fillColor", "paperColor", "borderColor", "borderWidth", "radius",
    "fontSize", "align", "vAlign",
  ]) {
    if (item[key] !== undefined && item[key] !== "") style[key] = item[key];
  }
  return style;
}

/* 最长的那段文字基本就是正文，用它判断正文字号 */
function bodySizeOf(textItems) {
  if (!textItems.length) return 17;
  const longest = textItems.reduce(
    (best, item) => (String(item.text || "").length > String(best.text || "").length ? item : best),
    textItems[0],
  );
  return Number(longest.fontSize) || 17;
}

export function extractTemplate(items, meta = {}) {
  const source = (Array.isArray(items) ? items : []).filter(
    (item) => item && !["connector", "page"].includes(item.type),
  );
  if (!source.length) throw new Error("模板画布里没有可提取的块");

  const minX = Math.min(...source.map((item) => item.x || 0));
  const minY = Math.min(...source.map((item) => item.y || 0));
  const maxX = Math.max(...source.map((item) => (item.x || 0) + (item.w || 0)));
  const maxY = Math.max(...source.map((item) => (item.y || 0) + (item.h || 0)));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const textItems = source.filter((item) => item.type === "text");
  const sizes = textItems.map((item) => Number(item.fontSize) || 16).sort((a, b) => b - a);
  const palette = unique(source.flatMap(colorPool));
  const blocks = source.map((item) => ({
    type: item.type,
    role: roleOf(item),
    x: round((item.x || 0) - minX),
    y: round((item.y || 0) - minY),
    w: round(item.w || 0),
    h: round(item.h || 0),
    style: styleOf(item),
  }));

  return {
    id: meta.id || "",
    name: meta.name || "未命名模板",
    platform: "generic",
    canvas: { width: round(width), height: round(height) },
    palette: {
      colors: palette,
      background: unique(source.filter((item) => ["rect", "ellipse"].includes(item.type)).map((item) => item.fillColor)).slice(0, 6),
      text: unique(textItems.map((item) => item.color)).slice(0, 6),
      accent: unique(source.map((item) => item.borderColor)).slice(0, 6),
    },
    typography: {
      title: sizes.length ? sizes[0] : 32,
      /* 正文字号看「最长的那块文字」：模板里往往还有小签、页脚这类 11/12 号字，
         按中位数取会把正文压到 12 号，生成出来的文章小得没法读 */
      body: bodySizeOf(textItems),
      aligns: unique(textItems.map((item) => item.align)).slice(0, 4),
    },
    elements: unique(source.map((item) => item.type)).sort(),
    layout: { blocks },
  };
}

async function loadTemplate(ref) {
  const group = await templateGroup();
  if (!group) throw new Error("没有「文章模板」分组");
  const list = collectCanvases(group);
  const key = String(ref || "").trim();
  const target =
    list.find((meta) => meta.id === key) ||
    list.find((meta) => meta.name === key) ||
    (list.length === 1 ? list[0] : null);
  if (!target) throw new Error(`「文章模板」分组里找不到模板「${key || "未命名"}」`);
  const data = await store.openCanvas(target.id);
  return { meta: target, template: extractTemplate(data?.items, data?.meta || target) };
}

export async function articleTemplateList() {
  const group = await templateGroup();
  if (!group) return [];
  return collectCanvases(group).map((meta) => ({
    id: meta.id,
    name: meta.name,
    path: meta.path || "",
    blocks: meta.itemCount || 0,
  }));
}

export async function articleTemplateGet(name) {
  return (await loadTemplate(name)).template;
}

/** 提取当前画布或某个模板画布的样式，只返回结构，不落盘。 */
export async function articleTemplateExtract(name) {
  if (name) return articleTemplateGet(name);
  if (!current) throw new Error("先打开一张画布再提取模板");
  return extractTemplate(current.items, current.meta);
}

/** 按模板画布生成一张新画布：先提取样式，再把骨架块落进去。 */
export async function articleTemplateApply(name, spec = {}) {
  const { meta, template } = await loadTemplate(name);
  const spaceName = String(spec.spaceName || `${meta.name} · 新画布`).trim();
  const target = await canvasAgent.spaceCreate(spaceName);
  const created = [];

  for (const block of template.layout.blocks || []) {
    const role = block.role;
    const isText = ["title", "body", "quote"].includes(role);
    const type = isText ? "text" : block.type === "ellipse" ? "ellipse" : "rect";
    const style = { ...(block.style || {}) };
    const specBlock = {
      type,
      x: block.x,
      y: block.y,
      w: block.w,
      h: block.h,
      internal: false,
      ...style,
    };
    if (isText) {
      specBlock.text = role === "title" ? "标题" : role === "quote" ? "引文" : "正文段落";
    } else {
      if (!specBlock.fillColor) specBlock.fillColor = "#ece6da";
      if (!specBlock.borderColor) specBlock.borderColor = "";
    }
    const item = await canvasAgent.blockCreate(specBlock);
    if (item?.id) created.push(item.id);
  }

  return {
    template: { id: meta.id, name: meta.name, palette: template.palette, typography: template.typography, elements: template.elements },
    space: target,
    count: created.length,
    ids: created,
  };
}

/* ---------- 一键成文 ---------- */

const PLATFORM_WIDTH = { wechat: 780, toutiao: 780, xiaohongshu: 720 };

/* 正文高度不靠猜：按每行能塞多少字算行数，再乘行高。
   排出来的画布不会互相压字，也不用模型自己算坐标。 */
function textHeight(text, width, fontSize) {
  const perLine = Math.max(8, Math.floor(width / (fontSize * 1.05)));
  const lines = String(text || "")
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / perLine)), 0);
  return Math.round(lines * fontSize * 1.75 + 16);
}

function styleFromTemplate(template) {
  const blocks = template?.layout?.blocks || [];
  const pick = (role) => blocks.find((block) => block.role === role)?.style || {};
  const title = pick("title");
  const bodyTarget = Number(template?.typography?.body) || 17;
  /* role 只分得出「标题 / 不是标题」，小签和页脚也落在 body 里。
     正文样式取字号最接近 typography.body 的那块，别拿 12 号小签当正文 */
  const bodyBlock = blocks
    .filter((block) => block.role === "body")
    .sort(
      (a, b) =>
        Math.abs((Number(a.style?.fontSize) || 0) - bodyTarget) -
        Math.abs((Number(b.style?.fontSize) || 0) - bodyTarget),
    )[0];
  const body = bodyBlock?.style || {};
  const titleSize = Number(title.fontSize) || Number(template?.typography?.title) || 36;
  const bodySize = bodyTarget || Number(body.fontSize) || 17;
  return {
    title,
    body,
    titleSize,
    bodySize,
    headingSize: Math.round((titleSize + bodySize) / 2),
  };
}

/**
 * 一条调用出整篇排版：写标题、小标题、正文，位置和字号自己算。
 * 给了 template 就沿用那张模板画布的标题 / 正文字号与颜色，否则用内置版式。
 *
 * 每落一块都把真实高度读回来再加下一块的 y——文字块的高度是引擎按内容和字号
 * 重算的，拿传入的 h 去排后面必然压字。
 */
export async function articleGenerate(spec = {}) {
  const title = String(spec.title || "").trim();
  if (!title) throw new Error("先给个文章标题");
  const sections = (Array.isArray(spec.sections) ? spec.sections : [])
    .map((section) => (typeof section === "string" ? { body: section } : section || {}))
    .map((section) => ({
      heading: String(section.heading || "").trim(),
      body: String(section.body || "").trim(),
    }))
    .filter((section) => section.body);
  if (!sections.length) throw new Error("正文是空的：sections 里每段至少要有 body");

  const platform = ["wechat", "toutiao", "xiaohongshu"].includes(spec.platform) ? spec.platform : "wechat";
  let template = null;
  let templateMeta = null;
  if (spec.template) {
    const loaded = await loadTemplate(spec.template);
    template = loaded.template;
    templateMeta = loaded.meta;
  }

  /* 宽度按平台定：模板卡是展示用的（比公众号正文宽），
     直接拿它的宽度生成文章，版式会散 */
  const width = PLATFORM_WIDTH[platform] || 780;
  const style = styleFromTemplate(template);
  /* parent 给了就建在那个分组里：推广稿、模板、草稿各归各的目录 */
  const space = await canvasAgent.spaceCreate(title, spec.parent);
  const created = [];

  const place = async (block) => {
    const blockSpec = {
      type: "text",
      x: block.x,
      y: block.y,
      w: block.w,
      h: block.h,
      text: block.text,
      fontSize: block.fontSize,
      internal: false,
      align: block.align,
      /* 排版稿不是一堆输入框：正文块默认无边框、无底色，
         导出卡片时才不会每段都套一个方框 */
      borderColor: "",
      fillColor: "",
    };
    if (block.color) blockSpec.color = block.color;
    const item = await canvasAgent.blockCreate(blockSpec);
    if (item?.id) created.push({ id: item.id, role: block.role, text: String(block.text).slice(0, 40) });
    return Number(item?.h) || Number(block.h) || 0;
  };

  let y = 0;
  y += await place({
    role: "title",
    x: 0,
    y,
    w: width,
    h: 68,
    text: title,
    fontSize: style.titleSize,
    color: style.title.color,
    align: style.title.align || "left",
  }) + 30;

  for (const section of sections) {
    if (section.heading) {
      y += await place({
        role: "heading",
        x: 0,
        y,
        w: width,
        h: 40,
        text: section.heading,
        fontSize: style.headingSize,
        color: style.title.color,
        align: style.body.align || "left",
      }) + 12;
    }
    y += await place({
      role: "body",
      x: 0,
      y,
      w: width,
      h: textHeight(section.body, width, style.bodySize),
      text: section.body,
      fontSize: style.bodySize,
      color: style.body.color,
      align: style.body.align || "left",
    }) + 28;
  }

  return {
    space: { id: space?.id, name: space?.name || title, opened: Boolean(space?.opened) },
    platform,
    width,
    height: Math.max(0, y - 28),
    template: templateMeta ? { id: templateMeta.id, name: templateMeta.name } : null,
    blocks: created,
  };
}

export async function articleExport(format = "wechat") {
  const kind = ["wechat", "toutiao", "xiaohongshu", "html", "png", "pdf"].includes(format)
    ? format
    : "wechat";
  /* 小红书不做网页：按 3:4 竖页切成 1080×1440 的 PNG 组，
     导出目录里 01.png 是封面，后面按顺序发内页 */
  if (kind === "xiaohongshu") {
    const cards = await canvasAgent.exportCards({ width: 1080 });
    return { ...cards, platform: "xiaohongshu" };
  }
  return canvasAgent.exportCanvas(kind, { quality: "high" });
}
