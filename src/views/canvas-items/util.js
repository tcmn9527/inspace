/* canvas-items/util.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { DEFAULT_BORDER } from "./constants.js";

export const SVG_NS = "http://www.w3.org/2000/svg";

/* 连线、直线、箭头的新默认色：跟着当前主题的强调色走，比死灰有精神，也不会和面板边框混成一片。
   主题变量常写成 hsl()，而块上存的是死值（切主题不回头改已画好的线），
   所以先借一个隐藏节点让浏览器解析成 rgb，再转成十六进制——右键「线条颜色」的取色器只认十六进制。 */
let colorProbe = null;

export function accentStroke() {
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

export const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
export const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export const SIDES = ["top", "right", "bottom", "left"];
export const SIDE_NORMALS = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/* 手动折点上限：够摆出复杂的绕行，又不至于让 items.json 和手柄糊成一片 */
export const CONNECTOR_MAX_POINTS = 40;


export function colorOr(value, fallback) {
  return typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())
    ? value.trim()
    : fallback;
}

/* 颜色被丢了必须说是哪一项、原来写的什么：agent 只看到「少了一块东西」，
   猜不出是 #FF00 这种手滑。 */
export function colorIssue(value, name) {
  if (value == null || value === "") return `${name} 没给`;
  return `${name}「${String(value).slice(0, 24)}」不合法`;
}

export const COLOR_RULE = "颜色只认 #rgb / #rrggbb / #rrggbbaa";
export const OPS_RULE =
  "只有 rect / poly / line / stroke / text / group / use / image 八种（描边的线用 line，闭合的形用 poly，手绘或一笔一宽的墨迹用 stroke，摆一个已定义的素材用 use，垫一张位图参考用 image）";
/* 素材表：同一支笔、同一片瓦要摆几百遍，一条条写既写不下也画不动 */
export const SYMBOL_RULE =
  '素材先定义一次 symbols:{"名字":{cmds:[...],ox,oy,w,h}}（ox/oy 是落点，w/h 是声明的框，只有 tile 平铺非要不可），之后 {op:"use",ref:"名字",x,y,rotate,scale} 摆一份；同一个素材想要几套样子，就给要单独开关的那几笔起 name（想一起开关就包一层 group 起名）、再标 variants:["站","坐"]，用 use 的 variant 挑一套、hide 关掉某一层';

/* 一处「漆」：填色和描边既可以是一个颜色，也可以是一个渐变。
   渐变写坏了必须整条丢掉并说清坏在哪一步——悄悄退成「没填」，
   调用方看见的是一块凭空少掉的填充，比报错更难查。 */
export const GRADIENT_TYPES = ["linear", "radial"];
export const GRADIENT_RULE =
  '渐变写成 {type:"linear",x1,y1,x2,y2,stops:[{at,color},...]} 或 {type:"radial",cx,cy,r,stops}：at 是 0~1 的位置，坐标默认按这块形状包围盒的比例（0~1），要按块内画面像素就加 units:"user"';

export const ratio = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : fallback;
};
