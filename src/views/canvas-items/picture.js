/* canvas-items/picture.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */
/* 画面块生成 cut/clip def 的自增序号（原在共享模块里，拆分后归本模块） */
let pictureCutSeq = 0;


import { PICTURE_MAX_CMDS, PICTURE_MAX_EXPANDED, PICTURE_MAX_POINTS, PICTURE_MAX_SYMBOLS, PICTURE_MAX_SYMBOL_CMDS, PICTURE_STROKE_DEFAULT_WIDTH, PICTURE_STROKE_KINDS, PICTURE_STROKE_WIDTH_MAX, PICTURE_STROKE_WIDTH_MIN, PICTURE_TEXT_FONTS } from "./constants.js";
import { edgePath, markPictureDef, paintAttr, pictureNode, pictureNodeExact, strokeOutlinePath, strokeRadiusOf } from "./dom-sync.js";
import { COLOR_RULE, GRADIENT_RULE, GRADIENT_TYPES, OPS_RULE, SYMBOL_RULE, clamp, colorIssue, colorOr, ratio } from "./util.js";

export function normalizeGradientStops(raw, name) {
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

export function normalizeGradient(raw, name) {
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
export const PATTERN_TYPES = ["hatch", "grid", "dots", "tile"];
export const PATTERN_RULE =
  '图案漆写成 {pattern:"hatch"|"grid"|"dots",gap,angle,color,width} 或 {pattern:"tile",ref:素材名,dx,dy,angle}：gap 是间距（画面像素），angle 是整套纹样的转角，width 是线宽（点阵里是点的直径）';

/* tile 的格子尺寸：没写就拿素材声明的框，两个都没有只能报错——
   不知道一格多大根本铺不出东西，按 0 铺等于什么都没画。 */
export function patternSpan(raw, declared, ref, key, name) {
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
export function patternBackground(raw, name) {
  if (raw.background == null || raw.background === "") return { value: "" };
  if (!colorOr(raw.background, "")) {
    return { why: `${name} 的图案${colorIssue(raw.background, "background")}——${COLOR_RULE}` };
  }
  return { value: colorOr(raw.background, "") };
}

export function normalizePattern(raw, name, symbols) {
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
export function paintOf(raw, name, state) {
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
export function paintIssue(value, name) {
  if (value == null || value === "") return `${name} 没给`;
  return `${name}「${typeof value === "object" ? "渐变或图案对象" : String(value).slice(0, 24)}」不合法`;
}

/* 柔边和叠色：远景要虚、物体要落在纸上、火把要自己发亮，三件事都靠滤镜；
   一层淡墨叠出厚度靠混合模式。和渐变一样，写坏了整条丢掉——半套滤镜糊在屏幕上
   比少一笔更难查。存下来的拼写必须和认的拼写一致（append 会把整表再归一化一遍）。 */
export const FILTER_TYPES = ["blur", "shadow", "glow", "gray", "bright", "contrast"];
/* 调色那三种只吃一个倍数，不给就是「拉满 / 原样」；半径那三种没有默认可言，
   r=0 等于没挂滤镜，不如逼调用方写一个数。 */
export const FILTER_TONE = { gray: [0, 1, 1], bright: [0.05, 5, 1], contrast: [0.05, 5, 1] };
export const BLEND_MODES = [
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
export const FILTER_RULE =
  '滤镜写成 {type:"blur",r}（化开边缘、远景虚）、{type:"shadow",dx,dy,r,color}（落在纸上的投影）、{type:"glow",r,color}（自己发亮），或调色的 {type:"gray"|"bright"|"contrast",k}（去色 / 提亮 / 加对比，k 是倍数）：r 是化开的半径（块内画面像素，0.5~200），dx/dy 是投影往哪偏、可以都不写（这块打了光就跟着光倒向背光那边，没打光就是 0）；投影还可以写 h（这东西在画里立起多高，块内画面像素）：写了 h 的不是把剪影挪一份，而是从它的脚底拖出一片真正的落影，影长 = h / tan(太阳高度)，太阳越低影子越长，越往末梢越淡（那道渐变不用你自己叠），边是硬的（要羽化再写 r），前提是这块打了光（picture_light），没光就没有影子的方向；几样要一起用就写成数组，按序生效';
export const BLEND_RULE = `混合模式只有 ${BLEND_MODES.join(" / ")}：叠墨用 multiply、叠光用 screen，不写就是正常盖上去`;

/* 滤镜只可能写在 filter 这一个字段上，不像漆还要分清 fill / stroke，
   所以报错直接说「滤镜」，不必把字段名传来传去。 */
export function normalizeFilter(raw) {
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
export function normalizeFilterList(raw) {
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

/* 画面里垫一张位图：参考底、扫描件、照片。跟图片块一样两种存法——这个画布
   images/ 下的相对路径（拷贝态），或原图在本机的绝对路径（引用态，不拷字节）。
   http 和 data: 一律不认：这应用得离线也画得出来，而且一串 base64 会把
   pictures/<块id>.json 撑爆。 */
export const IMAGE_SRC_RULE =
  'src 要么是这个画布 images/ 下的相对路径（images/xxx.png），要么是原图在本机的绝对路径（C:\\某处\\参考图.png，引用不拷）；想直接垫一张本机图就写 path，应用会把它拷进这个画布再回填 src';

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
  return { why: `image 的 src「${text.slice(0, 28)}」既不是本机绝对路径，也不是 images/xxx 这种画布内相对路径——${IMAGE_SRC_RULE}` };
}

/* 滤镜和混合模式八种 op 都能带，和 name / variants 一样在出口统一收：
   八个分支各抄一遍迟早漏一种。返回 {filter?, blend?}，写坏了返回 {why}。 */
export function normalizeFx(raw) {
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

export const coord = (value) => Math.round(clamp(Number.isFinite(value) ? value : 0, -1e6, 1e6));
export const opacityOf = (value, fallback) => Math.round(clamp(Number.isFinite(value) ? value : fallback, 0, 1) * 100) / 100;

/* ---------- 剪刀：一条指令自带一块裁剪 ----------
   画窗、瓦、水面的遮挡关系靠它。clip 是硬边：形状外不画，橡皮也擦不到。
   mask 是软边：拿遮罩形状的明度当透明度，白=留着、黑=没了，所以填一道渐变就是渐隐。
   两样八种 op 都能带，和 filter / blend 一样在出口统一收——八个分支各抄一遍迟早漏一种。 */
export const CUT_RULE =
  '剪刀只认闭合的面：{op:"rect",x,y,w,h,radius}、{op:"poly"|"line",points}（点还能带 c1 / c2 走曲线边）、或 {ref:"素材名",x,y,rotate,scale} 拿一个已定义的素材当剪刀——一百个窗共用一把。裁剪永远和这块的画框再相交，越不出块';

export function cutShapeIssue(value, name) {
  const shown = Array.isArray(value)
    ? "一条数组"
    : value === null
      ? "null"
      : `${typeof value}「${String(value).slice(0, 20)}」`;
  return `${name} 得是一个形状对象（现在是 ${shown}）——${CUT_RULE}`;
}

export function normalizeCutShape(raw, state, name) {
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
export function normalizeCuts(raw, state) {
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
export function cutGeometryOf(cmd, transform, fill, ctx) {
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
export function cutRefNodes(shape, fill, ctx) {
  const symbol = ctx?.symbols?.[shape.ref];
  if (!symbol) return [];
  const local = `translate(${shape.x} ${shape.y}) rotate(${shape.rotate}) scale(${shape.scale}) translate(${-symbol.ox} ${-symbol.oy})`;
  return (symbol.cmds || []).flatMap((cmd) => cutGeometryOf(cmd, local, fill, ctx));
}

/* 归一化存下来的三种规范形，各自变成 svg 的几何节点。
   形状节点不带 transform（剪刀自己的位移已经写进 x/y 或 ref 的那层 g 里了）。 */
export function cutGeometryNodes(shape, fill, ctx) {
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

export function clipAttr(clip, ctx) {
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
export function maskAttr(mask, ctx) {
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

export function normalizePicturePoints(raw, cap = PICTURE_MAX_POINTS) {
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

export function handleOf(raw) {
  const x = Number(raw?.x ?? raw?.[0]);
  const y = Number(raw?.y ?? raw?.[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: coord(x), y: coord(y) } : null;
}

/* 手绘一笔的点：除了 x/y 还带这一点的笔宽（{x,y,w} 或 [x,y,w]）。
   不写 w 就一路等宽，渲染那边会走更便宜的描边画法。 */
export function normalizePictureStrokePoints(raw, cap = PICTURE_MAX_POINTS) {
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

export function pictureCmdShape(raw, state) {
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

export function normalizePictureCmdPoints(raw) {
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
export function pictureCmdCost(cmd, st) {
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

/* 把垫图换成另一画布的副本：map 是 {旧 src → 新的 images/xxx.png}，命中的改写 src 并落成拷贝态。
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
export const LAYER_NAME_MAX = 32;

export function projectLayers(cmds, variant, hide) {
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
export const HIDDEN_MAX = 200;

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
   cmd 是原始那条（号还在、在数组里的位置也还在，笔画栈和按号 delete 都对得上盘上的数据），
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
   烘进 stops 的话改一次光要重写上千条，幂等和性能都顶不住。 */
export const PICTURE_FACES = ["up", "down", "left", "right", "front", "back"];
/* k 默认 0.3：双端插值在 k 大的时候，吃一半光的面（朝天的屋顶、地面）算出来就是
   (影色+光色)/2，固有色被吃干，整幅像蒙了张灰纸。0.3 是「看得出有朝向差、颜色还是自己的」那一档。 */
export const LIGHT_DEFAULTS = { angle: 315, elev: 45, lit: "#fff4de", dark: "#2f3a52", k: 0.3 };
export const FACE_RULE =
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
export const FACE_VEC = {
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

export function hexParts(value) {
  const body = String(value || "").trim().slice(1);
  const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
  if (!/^([0-9a-f]{6})([0-9a-f]{2})?$/i.test(full)) return null;
  const n = parseInt(full.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: full.slice(6) };
}

export const mixTo = (base, target, amount) => Math.max(0, Math.min(255, Math.round(base + (target - base) * amount)));

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
export function litPaint(paint, ctx) {
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
export const tintKey = (ctx) => (ctx?.light && ctx.face ? `\u0000${ctx.face}` : "");

/* 一个素材有哪些可选图层 / 变体：连组里都翻，报错时才报得全 */
export function collectLayers(cmds, acc) {
  for (const cmd of cmds) {
    if (cmd.name && !acc.names.includes(cmd.name)) acc.names.push(cmd.name);
    for (const one of cmd.variants || []) if (!acc.variants.includes(one)) acc.variants.push(one);
    if (cmd.op === "group") collectLayers(cmd.cmds, acc);
  }
  return acc;
}

export function symbolLayers(symbol, st) {
  /* 单独归一化一条指令时手上没有缓存，现算一份就用：省不了但不许算错 */
  const memo = st.layers || new Map();
  const hit = memo.get(symbol);
  if (hit) return hit;
  const built = collectLayers(symbol.cmds, { names: [], variants: [] });
  memo.set(symbol, built);
  return built;
}

/* 同一份「素材 + 这套开关」只投影一次：几百个小人点的是同一个键 */
export function symbolView(symbols, memo, cmd) {
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

/* 笔记块默认存 Markdown 快照和一份「原图路径 → 画布副本」映射，编辑不动原 .md。
   引用态（link.linked）多带写回要用的编码和换行，path 是原 .md 的绝对路径。 */
