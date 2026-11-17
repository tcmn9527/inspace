/* 从 cosmos.js 拆出：常量、星球参数与航线存档 */

import { clamp, normalize3 } from "./math.js";

export const TEX_BASE = "/assets/cosmos/";
export const invoke = window.__TAURI__?.core?.invoke ?? null;

/* 透视相机：近平面给得远一点，深度精度够用；远平面要罩得住星与星之间那段空档 */
/* 贴地绕飞时镜头离表面只有零点几倍星球半径，小的月球不到 15 个单位：
   近裁剪面必须比这个还小，不然脚下的地表被裁掉，看着像缺一块 */
export const NEAR = 4;
export const FAR = 160000;
export const FOV_K = 1.05;
export const HEAD_YAW = 0.26;
export const HEAD_PITCH = 0.17;
export const HEAD_MAG = 0.45;
export const MAX_PITCH_Y = 0.8;

/* 航线：巡航故意慢，一场遭遇之间隔着一大段什么都不发生的空档 */
export const CRUISE = 150;
/* 镜头转向的角速度（弧度/秒）。0.4 会让交接那一帧变成甩头，压慢之后
   再配上下面 LEAD 的预对准，交接时本来就没剩多少角度 */
export const TURN_RATE = 0.16;
export const ENGAGE = 20000;
/* 巡航路上提前开始把航线往那颗星体引，而不是等进遭遇圈才猛转 */
export const LEAD = 30000;
/* 绕飞半径和最近贴法距离，都用星球半径的倍数说。
   垂直半视场约 43.6°：1.45 倍时地平线刚好压在画面上下边，
   1.3 倍时地表铺满正中、弧形地平线退到四角——低空掠过表面但又不至于看不出是个球 */
export const ORBIT_K = 1.3;
/* 绕飞一圈几秒。这是「欣赏」而不是「路过」的时间尺度：一两圈摊到三到五分钟，
   一屏的地表慢慢推过去，看得清环形山也看得出弧线。它也直接决定贴图在屏幕上
   每秒扫过多少像素，越快越容易看出采样颗粒。 */
export const LAP_TIME = 150;
/* 绕飞时球面贴图在屏幕上扫过约 220 设备像素每秒、一帧跨过 3.6 个（68 秒一圈时量到的是 8 个）。
   零时长的锐利采样会让高频纹素逐帧换个相位落在同一个像素上——频闪，观感就是
   「轮廓不动、里面的地表在游」。真实相机 1/60 秒快门里这段位移本来拖成一条线，所以照片不觉得抖。
   这里沿本帧的位移方向铺几枚瞬时采样求平均，把高于奈奎斯特的那部分抖回压掉。乘子就是「快门时长」：
   1 等于一帧全曝光，0 等于瞬时快照（回到原来的抖），2 是更长的拖影。 */
export const MOTION_BLUR = 1;
export const BLUR_TAPS = 5;
/* 单帧最多按这么长（CSS 像素）来糊：正常绕飞用不到，只有 warp 那种瞬移会碰到 */
export const MAX_SWEEP_PX = 24;
export const CLOSEST_K = 1.12;
/* 地球分两段：头一圈退到 1.65 倍，把整颗球、大气边和昼夜线看全；
   这一圈走完再把目标半径收到 1.3 倍去掠地表。半径一直是按比例慢慢收的，
   换段只是目标值变了，不会出现一帧之内的跳 */
export const EARTH_FAR_K = 1.65;
export const EARTH_FAR_LAPS = 1;
export const EARTH_NEAR_LAPS = 1.5;
/* 上轨不是瞬移：离到 1.8 倍轨道半径就开始收，头几秒仍然带着「往里飞」的动量，
   切向速度慢慢加进来，走成螺旋，免得背景流动一帧之内从「往前」换成「横着绕」 */
export const ORBIT_ENTER_K = 1.8;
/* 轨道平面不再固定走赤道：交替「接近横向」和「明显竖向」两种。
   竖向最多 65°，再陡镜头就要从极点正上方往下看，世界 up 退化会翻屏。 */
export const ORBIT_TILT_FLAT = [0.05, 0.3]; // 约 3°~17°
export const ORBIT_TILT_STEEP = [0.7, 1.13]; // 约 40°~65°
/* 星体一颗一颗沿航线摆，隔多远由用户在设置窗口定的「几分钟遇到一颗」换算成世界距离：
   按巡航 150 单位/秒算，三分钟就是两万七。名单和间隔都存在 localStorage，
   设置窗口和 MCP 走同一个写入口。 */
export const ROUTE_KEY = "workbench.cosmosRoute";
export const PACE_KEY = "workbench.cosmosMinutes";
export const DEFAULT_ORDER = ["earth", "moon", "mars", "jupiter", "saturn"];
export const DEFAULT_MINUTES = 3;
export const MINUTES_MIN = 1;
export const MINUTES_MAX = 10;
/* 间隔的随机幅度：每次都差这么多，别把星体摆成等距的电线杆 */
export const GAP_JITTER = 0.35;
export const SPAWN_LATERAL = 5200;
export const SPAWN_VERTICAL = 3200;
/* 直接点名的那颗（MCP goto）不该让人先飞五分钟才看到 */
export const GOTO_DIST = ENGAGE + 2000;
/* MCP warp 的默认落点：距星心多少倍星体半径。2.5 倍落在进轨门槛外一点点，
   接着自然走「逼近→进轨」，一两秒就开始绕，不至于凭空插进绕飞状态 */
export const WARP_R = 2.5;
export const MAX_BODIES = 8;
/* 前方最多常备几颗，镜头里同时只画一颗，但下一颗得已经在路上。
   间隔拉大时按 FAR 折算，实际备得更少——不然第三颗跑到远裁剪面外，会被反复回收重生 */
export const KEEP_AHEAD = 3;

/* 远处那颗还没胀大成面的星：屏幕半径这么小就当一枚会眨的亮星画，
   越过上限淡出，交给真正的球面 */
export const FLARE_MIN_PX = 5;
export const FLARE_MAX_PX = 30;
export const FLARE_SIZE = 30;

export const SUN_WORLD = normalize3([0.28, 0.34, -0.9]);

export const STAR_SHELLS = [
  { count: 3600, alpha: 0.34, size: [0.6, 1.5] },
  { count: 2200, alpha: 0.46, size: [0.9, 2.1] },
  { count: 900, alpha: 0.6, size: [1.3, 2.8] },
];
export const BRIGHT_COUNT = 42;

/* 掠过去的冰晶分两层：近层给速度感，中远层比前景慢、比天球快。
   三层速度差才是「在飞」的观感来源，只有一层或者都铺在远处就看着像静止。 */
export const DUST_FIELDS = [
  /* nearK：这个距离内的点按 1/d 放大加亮，让近处的真掠过去、远处的收成针尖。
     放大倍数和亮度都收着，数量也别多，否则整片星跟着抖 */
  { name: "dust", count: 820, alpha: 0.38, size: [1.2, 2.4], min: 900, max: 8600, spread: 1250, nearK: 2200 },
  { name: "dustFar", count: 360, alpha: 0.16, size: [0.9, 1.7], min: 8000, max: 17000, spread: 3600, nearK: 0 },
];
/* 补到前方的点淡入这么久：一出现就是最亮的状态，看着像星星在爆闪 */
export const DUST_FADE = 1.4;

/* 按恒星光谱型大致配的色温，权重偏向白色和淡黄，红蓝点缀 */
export const STAR_COLORS = [
  [0.62, 0.72, 1.0],
  [0.8, 0.87, 1.0],
  [1.0, 1.0, 1.0],
  [1.0, 0.94, 0.8],
  [1.0, 0.8, 0.58],
  [1.0, 0.66, 0.5],
];
export const STAR_WEIGHTS = [0.1, 0.2, 0.3, 0.22, 0.13, 0.05];

export const PLANET_DEFS = {
  earth: {
    name: "地球",
    day: "earth-day",
    night: "earth-night",
    atmo: [0.34, 0.6, 1.0],
    tilt: 0.41,
    brightness: 0.92,
    size: [170, 220],
  },
  moon: {
    name: "月球",
    day: "moon",
    atmo: null,
    tilt: 0.12,
    brightness: 0.95,
    size: [90, 150],
  },
  mars: {
    name: "火星",
    day: "mars",
    atmo: [0.95, 0.46, 0.26],
    tilt: 0.44,
    brightness: 0.9,
    size: [150, 210],
  },
  jupiter: {
    name: "木星",
    day: "jupiter",
    atmo: [0.92, 0.82, 0.62],
    tilt: 0.05,
    brightness: 0.9,
    size: [250, 330],
  },
  saturn: {
    name: "土星",
    day: "saturn",
    atmo: [0.95, 0.86, 0.64],
    tilt: 0.47,
    brightness: 0.9,
    size: [230, 310],
    ring: true,
  },
};
export const TYPES = Object.keys(PLANET_DEFS);

/* ---------- 航线名单与遭遇间隔 ----------
   名单是循环的：走完一轮从头再走，所以地球也能每轮遇到一次；
   间隔说「几分钟遇到一颗」，换算成世界距离交给 nextSpawnDistance。
   两个值都存在 localStorage，设置窗口和 MCP 都走 cosmosRouteSet 这一个口子。 */

export const ROUTE = {
  order: parseOrder(readStored(ROUTE_KEY)),
  minutes: parseMinutes(readStored(PACE_KEY)),
};

export function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式之类写不进去，这次改了只在当次飞行里有效 */
  }
}

/* 只认这五种，重复的去掉；一个都不剩就退回默认——航线不能没有星可飞 */
export function parseOrder(raw) {
  const list = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => TYPES.includes(item));
  const unique = [...new Set(list)];
  return unique.length ? unique : [...DEFAULT_ORDER];
}

/* 没存过（null）和空着都算默认：Number(null) 和 Number("") 都是 0，
   不先把空串挡掉会被夹成下限的 1 分钟 */
export function parseMinutes(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return DEFAULT_MINUTES;
  const value = Number(text);
  if (!Number.isFinite(value)) return DEFAULT_MINUTES;
  return clamp(Math.round(value), MINUTES_MIN, MINUTES_MAX);
}

export const TEX_NAMES = [
  "earth-day",
  "earth-night",
  "moon",
  "mars",
  "jupiter",
  "saturn",
  "saturn-ring",
  "galaxy",
];
export const TEX_URLS = {
  "earth-day": "earth-day.jpg",
  "earth-night": "earth-night.jpg",
  moon: "moon.jpg",
  mars: "mars.jpg",
  jupiter: "jupiter.jpg",
  saturn: "saturn.jpg",
  "saturn-ring": "saturn-ring.png",
  galaxy: "galaxy.jpg",
};
