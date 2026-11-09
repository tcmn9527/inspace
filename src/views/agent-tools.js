/* MCP 工具表：给 agent 看的名字、说明和参数，以及把一次调用派给动作层的分发。
 *
 * 这里只做「参数翻译 + 切页 + 演示节奏」；真正改数据的是 canvas.js
 * 里那套和菜单、拖拽共用的动作函数，所以 agent 和用户手工操作不会写出两种状态。
 *
 * 所有会改界面的工具都默认先切到对应页面，用户能当场看见；返回前留一小拍高亮，
 * 传 pace: "instant" 可以跳过这一拍。 */

import { GUIDE_TOPICS, guideText } from "./agent-guide.js";
import { canvasAgent } from "./canvas.js";
import { cosmosFlight, cosmosFlightControl, cosmosRoute, cosmosRouteSet } from "./cosmos.js";
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
const X = { type: "number", description: "块左上角的世界坐标 x（画布坐标，原点在画布左上角）" };
const Y = { type: "number", description: "块左上角的世界坐标 y" };
const W = { type: "number", description: "宽度（像素）" };
const H = { type: "number", description: "高度（像素）" };

/* 画面块的绘制指令。坐标是块内画面坐标：块左上角就是原点，可以出现负数——
   画到框外面数据还在，把块拉大或挪裁剪框就露出来。 */
const PICTURE_CMDS = {
  type: "array",
  description: "一组绘制指令，按给的顺序叠放（后面的盖前面的）",
  items: {
    type: "object",
    properties: {
      i: { type: "number", description: "指令号：不传就自动编号；删改某一条要靠它" },
      op: { type: "string", enum: ["rect", "poly", "line", "stroke", "text", "group", "use", "image"], description: "矩形 / 闭合多边形 / 折线 / 一笔墨迹 / 文字 / 分组 / 摆一份素材 / 垫一张位图" },
      x: { type: "number", description: "rect / image 的左上角、text 的基线起点、group 的平移 x" },
      y: { type: "number", description: "rect / image 的左上角、text 的基线起点、group 的平移 y" },
      w: { type: "number", description: "rect 宽；image 是垫进去的框宽（不给就照原图量，picture_draw 可以省掉这两个数）" },
      h: { type: "number", description: "rect 高；image 是框高" },
      radius: { type: "number", description: "rect 圆角（px）" },
      fill: {
        type: ["string", "object"],
        description: "填充：颜色 #rgb / #rrggbb / #rrggbbaa，或渐变对象 {type:\"linear\",x1,y1,x2,y2,stops:[{at,color}]} / {type:\"radial\",cx,cy,r,stops}（坐标默认按这块形状的包围盒比例 0~1，要按块内画面像素就加 units:\"user\" 并把四个数写全），或图案对象 {pattern:\"hatch\"|\"grid\"|\"dots\",gap,angle,color,width,background} / {pattern:\"tile\",ref:素材名,dx,dy,angle,background}——图案是按块内画面像素反复铺的漆，瓦、砖、鳞片靠 tile。background 是铺在纹样底下的那层底色（瓦缝里的木色、布纹里的布本），有了它就不必把同一条形状画两遍：一遍底色一遍纹样",
      },
      stroke: {
        type: ["string", "object"],
        description: "描边：同 fill，颜色、渐变、图案都行",
      },
      strokeWidth: { type: "number", description: "描边宽度（px）" },
      opacity: { type: "number", description: "整条透明度 0–1，默认 1" },
      filter: {
        type: ["object", "array"],
        description:
          '柔边、投影、发光、调色，任何一种 op 都能带：{type:"blur",r} 化开边缘（远景、水汽、焦外）、{type:"shadow",dx,dy,r,color,h} 落在纸上的投影（color 不给是半透的黑）、{type:"glow",r,color} 自己发亮（不给是暖黄，正好是灯笼的颜色）、{type:"gray"|"bright"|"contrast",k} 去色 / 提亮 / 加对比（k 是倍数，1 就是原样）。r 是化开的半径（块内画面像素 0.5~200，跟着块缩放一起缩放）。shadow 还可以写 h：这东西在画里立起多高（块内画面像素）——写了 h 的不是把剪影挪一份，是从这条指令的脚底拖出一片真正的落影，影长 = h / tan(太阳高度)，太阳压得越低影子越长，越往末梢越淡（那道渐变不用你自己叠），方向由块上那套光给（没打光就一片都不画）；默认硬边，r 不给就是 0，要羽化再自己写。h 别照抄画面上看到的高度：散点俯视里那条立面已经把俯视压掉的比例算进去了，给它的一半上下，先给短了再往上加。挂在 group 上时组里每一笔各挤自己那一片，不是整组挤一大片；素材（use）算一笔，整个素材按外接框挤一片，不会素材里每一笔各拖一道。明确写了 dx / dy 的那一头照旧一个字不动。要几样一起用就写成数组，按序生效，比如压一张参考图用 [{type:"gray"},{type:"contrast",k:1.4}]。一条 css 滤镜是一次离屏合成，别每条都挂；写了 h 的那片落影是个多边形，不占合成',
      },
      blend: {
        type: "string",
        enum: [
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
        ],
        description:
          "混合模式：和已经画在它下面的内容叠色。叠墨用 multiply（淡彩一层层压深）、叠光用 screen、压明暗用 overlay / soft-light；不写就是正常盖上去。只在这块画面里互相影响，不会把画纸底色和块外的东西搅黑",
      },
      cap: { type: "string", enum: ["round", "square", "butt"], description: "折线端头，默认 round" },
      clip: {
        type: "object",
        description:
          '剪刀：只画得出这个形状里面的部分，任何一种 op 都能带。写成形状对象本身：{op:"rect",x,y,w,h,radius}、{op:"poly"|"line",points}（点还能带 c1/c2 让边是曲线）、或 {ref:"素材名",x,y,rotate,scale} 拿一份现成素材当剪刀——一百个窗共用一把，别把同一个形重算一百遍。坐标是块内画面像素，和这条指令自己在同一套坐标系；group / use 自带位移旋转时，剪刀留在这一层不动（窗在墙上转，纸不会跟着挪）。裁剪永远再和这块的画框相交，越不出块。剪掉的那部分看不见，橡皮也擦不到。剪不出任何形状（ref 的素材里没有面）就不挂剪刀，画面照出',
      },
      mask: {
        type: "object",
        description:
          '软边遮罩，形状写法同 clip，多两样：fill 是拿什么当透明度——白=留着、黑=没了，不给是纯白（等价于硬边剪刀）；写成渐变就是渐隐，比如 {type:"linear",y2:1,stops:[{at:0,color:"#fff"},{at:1,color:"#000"}]} 自上而下淡出，图案漆也行（hatch 就是隔着百叶窗看）。soft 是羽化半径 0~200（块内画面像素），给边缘化开一点。遮罩的生效区域按整块画区算，一条长渐变不会被齐根截断。一条遮罩是一次离屏合成，别每条都挂。mask 不参与橡皮判定——渐变没有硬边界，擦得到的界在这儿划不出来',
      },
      close: { type: "boolean", description: "line 想围成闭合面时给 true（等价于 op=poly）；描边的线就用 line，闭合的形就用 poly" },
      kind: { type: "string", enum: ["pen", "brush"], description: "op=stroke 的笔：pen 一路等宽，brush 按每个点的 w 提按" },
      grain: {
        type: "number",
        description:
          "op=stroke 的枯笔程度 0~1，不写就是 0（实墨一杆，和现在一样）。墨少了笔幅会撕开：一笔被拆成几根各自长短不齐的细丝，中间露纸、末端分叉。0.4~0.7 是常用的枯，0.9 以上只剩几根丝。股数和断口的位子由这条点串自己算出来——同样的点永远画成同样的形，重开、重发都不会变样；想换个枯法就改点。只作用于 stroke，poly / line 不认这个字段；橡皮擦的还是这一整条，不是一根根丝",
      },
      points: {
        type: "array",
        description: "poly / line / stroke 的顶点，{x,y} 或直接 [x,y]；最多 4000 个点。poly / line 的点还能带 c1、c2 两个控制点（{x,y}），带上这一段就是三次贝塞尔曲线，不带还是直线。stroke 的点另可各带一个 w（那一点的笔宽），用来做毛笔的提按",
        items: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            c1: { type: "object", description: "poly / line：进入这一点的第一个控制点 {x,y}，不写就直线段" },
            c2: { type: "object", description: "poly / line：进入这一点的第二个控制点 {x,y}" },
            w: { type: "number", description: "op=stroke：这一点的笔宽（px），不给就用这条的 size" },
          },
          required: ["x", "y"],
        },
      },
      text: { type: "string", description: "op=text 要写的字，最多 500 字" },
      size: { type: "number", description: "text 的字号 / stroke 的笔宽（px）" },
      color: { type: "string", description: "op=text 的字色 / op=stroke 的墨色" },
      weight: { type: "string", enum: ["normal", "bold"], description: "字重" },
      font: { type: "string", enum: ["sans", "serif", "mono", "cjk"], description: "字体族；cjk 走系统中文黑体，题字用这个" },
      rotate: { type: "number", description: "旋转的度数：group / use 绕自己的落点，image 绕那张图的框中心" },
      scale: { type: "number", description: "缩放倍数（group / use），默认 1" },
      cmds: { type: "array", description: "group 的子指令，写法同外层" },
      name: {
        type: "string",
        description:
          "图层名，任何一种 op 都能带，两处都用它：素材里给要单独开关的那几笔起名，use 靠 hide / variant 挑；块上把同名指令算成一层（group 里单独起了名的那笔也算，关它只从组里摘那一笔），用 picture_layers 的 hide / show（或 picture_draw 的 hidden）整层开关——关掉的层真不画，指令和数据都还在，条数与展开额度照样占着。几笔要一起开关就包一层 group 起同名",
      },
      variants: {
        type: "array",
        items: { type: "string" },
        description: "这一层属于哪几个变体：素材里同一个图层想要好几种样子时标它，use 的 variant 挑中谁就只画谁那一套。标了 variants 的层是「某一副样子才出现的那一笔」——use 没给同名 variant 时它不画，所以一份素材的几副样子不会同时糊在图上；常驻的那几笔别标",
      },
      face: {
        type: "string",
        enum: ["up", "down", "left", "right", "front", "back"],
        description:
          "这一面的朝向，任何一种 op 都能带，只有这块打了光（picture_light）才有用：吃多少光由光来的方位角和这个朝向的夹角算出来，不用你心算明暗。front 正对观者（受光只看光源抬高多少，和方位角无关）、back 背对观者。没写 face 的指令不吃光，保持固有色——所以光是一点点加上去的，先给该受光的几组写 face。group 写一次，组里没自己写的每一笔都跟着这个面；use 写的朝向传给素材里的每一笔（同一份瓦摆在朝左的坡和朝右的墙上会各自变色）。只有漆跟着明暗走：fill（颜色 / 渐变 / 图案连同它的底色）才吃光，墨不吃——描边 stroke、一条 line、毛笔一笔、题字都守住固有色，那是贴在面上的黑，不是受光的立面。词写错整条丢掉并报回 dropped",
      },
      ref: { type: "string", description: "use 用哪个素材名 / tile 图案铺哪个素材，得是这块 symbols 里已经定义好的" },
      variant: { type: "string", description: "use：挑素材的哪一个变体（图层上 variants 标过的名字）。不挑就只画没标 variants 的那些常驻笔；标了变体的层只有挑中它才出现" },
      hide: { type: "array", items: { type: "string" }, description: "use：关掉素材里这几个名字的图层，其余照画" },
      src: { type: "string", description: 'image 垫的那张图：images/xxx.png（这个画布里的，拷贝态）或本机绝对路径 C:\\某处\\参考图.png（引用原图，不拷字节）。联网地址和 data: 内联一律不认——这应用要离线也画得出来，一串 base64 还会把 pictures/<块id>.json 撑爆' },
      path: { type: "string", description: 'image 简写：图还在本机某个位置就直接写 path，应用会把它拷进这个画布、回填 src，顺手量好 w / h；和 src 同时给以 path 为准。文件读不出来就整次报错，不会悄悄少一张' },
      fit: { type: "string", enum: ["meet", "fill"], description: 'image 的框和图片本身比例不一致时怎么办：meet（默认）等比缩到整张都在框内、居中留边；fill 硬拉成正好铺满框，会变形' },
    },
    required: ["op"],
  },
};

/* 素材表：{"名字":{cmds:[...]}}。一条 use 顶一整个素材，几百个小人、几万片瓦
   才不至于把浏览器压死；也是 agent 别再一条条重算同一栋房子的唯一办法。 */
const PICTURE_SYMBOLS = {
  type: "object",
  description:
    '这块画面的素材表 {"名字":{cmds:[...],ox,oy,w,h}}：名字自己起（1~32 字），cmds 写法同外层指令。ox/oy 是落点（use 的 x,y 就对准它，默认 0,0），w/h 是声明的框，只有拿它当 tile 平铺单元时非要不可。素材内部不能再嵌 use，也不能再点别的素材当剪刀。值写成 null 是删掉这个素材，还有 use 在用它、拿它当剪刀（clip / mask 的 ref）、或用它的 tile 平铺都不让删。和 cmds 在同一个请求里发来才认得新名字',
  additionalProperties: {
    type: ["object", "null"],
    properties: {
      cmds: { type: "array", items: PICTURE_CMDS.items, description: "素材自己的指令串，坐标是素材本地坐标" },
      ox: { type: "number", description: "落点在素材坐标里的 x" },
      oy: { type: "number", description: "落点在素材坐标里的 y" },
      w: { type: "number", description: "素材声明的框宽，tile 平铺一格多大照它" },
      h: { type: "number", description: "素材声明的框高" },
    },
  },
};

/* 一套光：整块只认一个光源，逐条指令只声明自己那面朝哪儿，明暗由这儿算。
   挂在块上，不写进任何一条指令——改一次光要重写上千条的话，幂等和性能都顶不住。 */
const PICTURE_LIGHT = {
  type: ["object", "null"],
  description:
    "这块的一套光；写成 null 就是关掉。整块只认一个光源，每条指令只声明自己那面朝哪儿（face），明暗由夹角算出来，不用你心算",
  properties: {
    angle: { type: "number", description: "光从哪个方位来：0 是正上方、顺时针数、315 就是左上方（必填）" },
    elev: { type: "number", description: "光源抬高 0~90，默认 45：0 贴着画面侧打（明暗差最大）、90 和观者同侧（只剩 front / back 有差别，投影也短到没有）" },
    lit: { type: "string", description: "受光端往哪个颜色拉，默认 #fff4de（暖阳光）" },
    dark: { type: "string", description: "背光端往哪个颜色拉，默认 #2f3a52（天光兜底的冷影）" },
    k: { type: "number", description: "拉伸强度 0~1，默认 0.3：越大越把颜色往光色 / 影色那两端拉。别一上来就拉满——吃一半光的那类面（朝天的屋顶、地面）在 k 大时算出来就是 (光色+影色)/2，固有色被吃干、整幅像蒙了张灰纸；0.3 是「看得出朝向差、颜色还是自己的」那一档，要浓再往 0.5 走" },
  },
};

const SCENE_PARTS = {
  type: "array",
  description:
    "场景块里的东西，一件一个对象。坐标是「地上的」不是纸上的：x 左右、y 往画面里去（越大越远）、z 底面离地多高、h 立起来多高，单位仍是块内画面像素。" +
    "三种写法：{op:\"box\",x,y,z,w,d,h,rotate,color,name}——w 是 x 方向的宽、d 是 y 方向的厚，三个尺寸都得是正数（0 高不是「一片地」，是写错了，整件丢掉并报回第几件）；" +
    "{op:\"poly\",x,y,z,points,h,rotate,color,name}——points 是底面轮廓 [{x,y},…]（也收 [x,y]），点相对 (x,y)，首尾不用重复写、写了两遍会自己收掉，至少 3 个不重复的点，轮廓里别写 c1/c2（底面只吃折线，要圆弧就多取几点）。" +
    "这两种都是「轮廓 + h 挤成真棱柱」：L 形、梯形、八角台都能立起来，直角就是直角。" +
    "{op:\"roof\",x,y,z,h,…} 是屋顶：同一圈底面立到 h 高，顶上一圈往中线收。矩形底面写 w,d 再加 ridge（屋脊多长）——ridge 不写或 = w 是双坡（悬山，脊和房子一样长）、0 < ridge < w 是四阿 / 庑殿（四角都斜下去）、ridge:0 是四角攒尖；多边形底面写 points（八角亭的攒尖就这么来），这种没有脊长可写，硬写会报回。" +
    "墙和顶是两件东西，别指望一件自带屋顶：墙 {op:\"box\",z:26,h:170} 立到 196，顶就写 {op:\"roof\",z:196,h:130}；出檐不靠参数，让顶的 w,d 各比墙宽出一圈就行（宽 100 的墙给宽 160 的顶，檐口探出去 30）。" +
    "模型件写 {op:\"model\",x,y,z,src,w,d,h,rotate,scale,name}：src 只写模型库（数据根 library/models）里的 .glb 文件名，w/d/h 是期望的真实尺寸（厘米，按 w 等比缩放；没给 w 就按 h，默认 80cm）。产品卡落场景请用 scene_place_product，别手拼。" +
    "实体件还能带 tex（场景块所在画布 images/ 里的图片路径）和 texRepeat（每格多少厘米，默认 100）当材质贴图；把产品卡图片套到墙/地上用 scene_apply_material。" +
    "落点 (x,y) 永远是底面那个中心，rotate 绕它转。" +
    "影子不用你画也不用来这儿要：块上有 light 就有一盏真的太阳，几何自己把影子落到地上，没光就是平光。",
  items: { type: "object" },
};

const SCENE_CAMERA = {
  type: ["object", "null"],
  description:
    "这块的机位；写成 null 或不写就是「按内容自动框一个」。存的是绕注视点转的球坐标，改窗口大小、挪块都不会让机位漂",
  properties: {
    azim: { type: "number", description: "相机绕到哪个方位：0 从正北那边看过来、顺时针数、180 是从南往北看（默认）" },
    elev: { type: "number", description: "相机抬高 2~88 度，默认 30：越大越俯视" },
    dist: { type: "number", description: "相机离注视点多远（块内画面像素）。不给就自动框住全部内容" },
    tx: { type: "number", description: "注视点的地面 x，默认是所有内容的中心" },
    ty: { type: "number", description: "注视点的地面 y（越远越大），默认同上" },
    tz: { type: "number", description: "注视点离地多高，默认取内容高度的一档" },
    fov: { type: "number", description: "竖直视角 8~100 度，默认 45。越小越像长焦（透视压平、远处显得大）" },
  },
};

/* 生图面板那七个字段：面板上只摆提示词框和一颗按钮，尺寸/步数/贴合度/种子没有控件，
   只有这条通道能改——和画面块的光、场景块的机位是同一个约定。
   建块和改块共用一份，漏一个不报错、那块会安静地建成默认值。 */
const GEN_PROPS = {
  prompt: { type: "string", description: "生图面板的提示词（这一张要什么）" },
  negative: { type: "string", description: "生图面板的负向提示词（不想要什么）" },
  imageW: { type: "number", description: "出图宽，256~2048，自己贴到 32 的倍数，默认 1024" },
  imageH: { type: "number", description: "出图高，同上" },
  steps: { type: "number", description: "步数 1~100，默认 20" },
  cfg: { type: "number", description: "提示词贴合度 1~20，默认 6" },
  seed: { type: "number", description: "种子；-1 每张换一个，给正数才能复现同一张" },
  mode: {
    type: "string",
    enum: ["auto", "t2i", "i2i", "edit", "upscale"],
    description:
      "出图那一档。auto（默认）看连线自己定：没接图=文生图，接一张=图生图，接多张=参考图编辑。" +
      "只有「一张参考图而不是底图」这种要明写 edit（画风锚点就是这种）；一张也不接却想文生图，明写 t2i 盖掉连线。" +
      "upscale 是纯 ESRGAN 高清放大，不吃推断：连一张图、出不带提示词的 4× 那张。",
  },
  strength: { type: "number", description: "图生图改多少，0~1，默认 0.75：小=贴着原图改，大=只留个大概" },
};

const GEN_KEYS = Object.keys(GEN_PROPS);

/* 换档只认这两个槽位；pace 是每张工具都带的装饰参数，不能当档位传下去 */
const GEN_MODEL_KEYS = ["dit", "encoder"];

/* waitSeconds：这条命令最长可能占住总线多久，只给 Rust 那头的等待上限用，
   注册时会被摘掉，不进 tools/list。没写的走默认 120 秒。 */
const def = (name, description, properties = {}, required = [], waitSeconds = 0) => ({
  name,
  description,
  ...(waitSeconds ? { waitSeconds } : {}),
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
  def("app_state", "看当前应用状态：正在哪一页、数据文件夹、当前主题、当前画布和相机、MCP 服务端口。"),
  def("theme_list", "列出所有主题（id、名字、深色/浅色），并标出当前用的那套。"),
  def("theme_set", "切换应用主题。宇宙主题是一条自动飞行航线：镜头一直往前飞，路上遇到星体会绕两圈慢慢看。", {
    theme: { type: "string", description: "主题 id，从 theme_list 拿" },
  }, ["theme"]),
  def(
    "flight_state",
    "看宇宙主题的飞行状态：现在在哪个阶段（cruise 巡航 / approach 逼近 / orbit 绕飞观察 / depart 启程）、速度、累计航程、视线仰角、目标星体与前方星体列表（含 id、类型、距离）。要先知道有什么可飞就调它。需要当前是宇宙主题。",
  ),
  def(
    "flight_control",
    "控制宇宙飞行：pause 停住、resume 接着飞、skip 结束当前绕飞直接启程、goto 追某一颗星体（body 用 flight_state 里的 id，type 用 earth/moon/mars/jupiter/saturn）、warp 直接挪到某一颗旁边跳过赶路。航线本身是自动的，这些只改节奏不改块。",
    {
      action: { type: "string", enum: ["pause", "resume", "skip", "goto", "warp"], description: "飞行操作" },
      body: { type: "string", description: "goto / warp 用：星体 id（flight_state 的 ahead 列表里拿）" },
      type: { type: "string", description: "goto / warp 用：星体类型 earth/moon/mars/jupiter/saturn，没有 id 时按类型挑或现生成一颗" },
      distance: { type: "number", description: "warp 用：落点距星心多少倍星体半径，默认 2.5（一两秒后进绕飞）；想先看全貌就填 6 以上" },
    },
    ["action"],
  ),
  def(
    "cosmos_route",
    "读或改宇宙主题的航线。不带参数只读回当前名单与间隔。带 order（星体类型数组，按遇到先后排，走完一轮从头再开始）或 minutes（1-10，两颗星之间隔几分钟）就写。改名单不打断正在绕飞的这颗，只把前方还是亮点的几颗按新名单重排；用户在 设置 › 遨游星球 里看到同样的值，改错了他能自己改回来。",
    {
      order: {
        type: "array",
        items: { type: "string", enum: ["earth", "moon", "mars", "jupiter", "saturn"] },
        description: "星体类型按遇到先后排，至少一颗；认不出的类型直接丢掉",
      },
      minutes: { type: "number", description: "几分钟遇到下一颗，1-10，默认 3，四舍五入到整分钟" },
    },
  ),
  def(
    "cosmos_textures",
    "管宇宙主题的 8K 贴图集（7 张，存在数据文件夹的 cosmos/8k/）。status 看档位（got/total、每张在不在、此刻有没有活在跑）；upgrade 启动后台下载缺的那几张并立刻返回——整包约 35MB、要几分钟，别重复调用，隔 30 秒调一次 status 看 got 就行；cancel 停掉当前下载；reset 把 8K 清进系统回收站、回到内置 2K。不升级也照飞，只是贴到脸上时表面糊。",
    {
      action: { type: "string", enum: ["status", "upgrade", "cancel", "reset"], description: "贴图操作" },
    },
    ["action"],
  ),
  def("space_list", "列出所有画布（id、名字、文件夹路径），并标出当前打开的是哪个。画布住在分组里时 id 是相对 spaces/ 的路径（如 手绘/神仙卡）。"),
  def("space_tree", "看画布树：分组（磁盘上的真文件夹，可嵌套）套画布，返回 {current, tree}。节点 {type: group|canvas, id, name, children}，分组和画布的 id 都是相对 spaces/ 的路径。整理画布前先看它。"),
  def("space_open", "切换到指定画布，等它读完再返回。space 传画布 id 或画布名。", {
    space: { type: "string", description: "画布 id 或名字" },
  }, ["space"]),
  def("space_create", "新建一个画布并切过去。parent 给分组 id 或名字就落在那个分组里，不给落在根级。", {
    name: { type: "string", description: "画布名" },
    parent: { type: "string", description: "分组 id 或名字，可省" },
  }, ["name"]),
  def("space_copy", "复制整个画布到别的分组：素材和内容整棵拷一份，独立副本新 id，并切过去。不支持移动画布。parent 为空复制到根级。", {
    space: { type: "string", description: "源画布 id 或名字" },
    parent: { type: "string", description: "目标分组 id 或名字，空为根级" },
  }, ["space"]),
  def("space_rename", "给画布改名（磁盘文件夹跟着改，留在原分组）。", {
    space: { type: "string", description: "画布 id 或名字" },
    name: { type: "string", description: "新名字" },
  }, ["space", "name"]),
  def("space_delete", "删除画布：整个画布文件夹进系统回收站。", {
    space: { type: "string", description: "画布 id 或名字" },
  }, ["space"]),
  def("group_create", "新建分组（spaces/ 下的真文件夹）。parent 给分组 id 或名字就建在它里面，不给建在根级。返回 {id}。", {
    name: { type: "string", description: "分组名" },
    parent: { type: "string", description: "父分组 id 或名字，可省" },
  }, ["name"]),
  def("group_rename", "给分组改名：真文件夹跟着改，里面所有画布的 id 前缀都变，返回新 id。", {
    group: { type: "string", description: "分组 id 或名字（同名分组必须给 id）" },
    name: { type: "string", description: "新名字" },
  }, ["group", "name"]),
  def("group_delete", "删除空分组，文件夹进系统回收站。里面还有画布或子分组会报错——先把它们删掉或复制走，画布不能被分组连坐。", {
    group: { type: "string", description: "分组 id 或名字（同名分组必须给 id）" },
  }, ["group"]),
  def("space_scene", "看当前画布里所有块的摘要：id、类型、位置尺寸、层级、各类型的关键字段。做任何块操作前先调这个拿 id。", {
    type: { type: "string", description: "只看某一类块（text/rect/ellipse/line/arrow/note/picture/scene/file/image/audio/video/ebook/connector），不传就全部" },
  }),
  def(
    "space_snapshot",
    "看一眼画布现在长什么样——返回一张 PNG 图片，你能直接看到画面。space_scene 给的是坐标，这个是「眼睛」：用它检查块有没有重叠、文字有没有溢出边框、连线有没有从标题中间穿过去、整张图的重心是不是歪了。画完一批东西之后调一次自查，比心算坐标可靠得多。图上的像素位置可以按返回里的 region 换算成世界坐标。",
    {
      region: {
        type: "string",
        enum: ["all", "viewport"],
        description: "all 整张画布（默认，适合看整体构图）；viewport 用户此刻看到的这一屏（适合凑近看某处细节）",
      },
      rect: {
        type: "object",
        description: "自定义矩形 {x,y,w,h}（世界坐标）；给了就忽略 region，适合精确检查某一块附近",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          w: { type: "number" },
          h: { type: "number" },
        },
        required: ["x", "y", "w", "h"],
      },
      maxSide: { type: "number", description: "长边像素上限，默认 1600（范围 320–4096）。凑近看细节时调大，看整体时可调小省时间" },
      scale: { type: "number", description: "直接指定倍数（0.05–4），给了就忽略 maxSide。要读清小字时用它，比如 scale: 1.5 就是「屏幕上 150% 的样子」" },
    },
  ),
  def(
    "block_export",
    "把一块矩形面板的范围导成一张 PNG：框里所有块按层级合成，框外裁掉，装饰可以故意出血。transparent 为 true 时连面板自己的底色都不画，只留框里的内容。返回图片本身，能直接看。",
    {
      id: ID,
      quality: { type: "string", enum: ["normal", "high", "ultra"], description: "清晰度 ×1 / ×2 / ×3，默认 high" },
      transparent: { type: "boolean", description: "true = 透明背景，不画面板底色" },
    },
    ["id"],
  ),
  def(
    "ui_color_picker",
    "调试用：直接在指定块上打开颜色面板，不经过鼠标——面板位置按块在屏幕上的位置算。打开后配合 ui_inspect 读元素样式验证布局，再用 ui_close 收起。",
    {
      id: ID,
      prop: {
        type: "string",
        enum: ["borderColor", "fillColor"],
        description: "要改哪一个颜色，默认 borderColor",
      },
    },
    ["id"],
  ),
  def(
    "ui_menu",
    "调试用：按块 id 打开右键菜单（不展开子菜单），配合 ui_click 逐级点菜单项做验证。",
    { id: ID },
    ["id"],
  ),
  def(
    "ui_menu_color",
    "调试用：按块 id 打开右键菜单，并程序化展开「边框 → 颜色」三级色盘（不经过鼠标）。打开后用 ui_inspect 读 .color-menu .color-pop-preset 验证样式，再用 ui_close 收起。",
    { id: ID },
    ["id"],
  ),
  def(
    "ui_click",
    "调试用：按 CSS 选择器点一下元素（可再用 text 筛内容），走 DOM click、不模拟鼠标。focus 为 true 时先让元素拿到焦点再点，模拟真实鼠标点击的焦点副作用。适合验证按钮和菜单项的效果，点完用 ui_inspect 读结果。",
    {
      selector: { type: "string", description: "CSS 选择器，例如 .canvas-gen-prompt" },
      text: { type: "string", description: "多个匹配时，挑文字里包含这一段的那个" },
      focus: { type: "boolean", description: "先 focus 再 click，默认 false" },
      detail: {
        type: "number",
        description: "点击事件的 detail；真实鼠标点击一般是 1，默认 0（DOM click）",
      },
      right: { type: "boolean", description: "true 时派发 contextmenu（右键菜单），坐标取元素左上角内侧" },
    },
    ["selector"],
  ),
  def(
    "ui_key",
    "调试用：向页面派发一次按键（不模拟鼠标、不抢系统焦点）。key 如 f、Escape、Enter；ctrl 为 true 就是 Ctrl+组合键，例如 key:f + ctrl:true 开搜索。",
    {
      key: { type: "string", description: "按键名，如 f、Escape、Enter" },
      action: {
        type: "string",
        enum: ["press", "down", "up"],
        description: "press 按下并松开（默认）；down/up 只发一半，用来模拟按住修饰键",
      },
      ctrl: { type: "boolean", description: "按住 Ctrl，默认 false" },
      shift: { type: "boolean", description: "按住 Shift，默认 false" },
      alt: { type: "boolean", description: "按住 Alt，默认 false" },
      meta: { type: "boolean", description: "按住 Meta/Win，默认 false" },
    },
    ["key"],
  ),
  def(
    "ui_input",
    "调试用：把文字写进输入框并触发 input 事件（不模拟键盘），等实时逻辑跑完再回话。搜索框的 #N 定位就用它。",
    {
      selector: { type: "string", description: "CSS 选择器，例如 #canvas-search-input" },
      text: { type: "string", description: "要写入的文字" },
    },
    ["selector", "text"],
  ),
  def(
    "ui_hover",
    "调试用：把指针悬停到视口坐标 (x,y) 上（只派发移动事件，不按下、不选中），用来验证悬停样式。给 selector 时直接悬停到该元素中心。",
    {
      x: { type: "number", description: "视口坐标 x（给了 selector 可省略）" },
      y: { type: "number", description: "视口坐标 y（给了 selector 可省略）" },
      selector: { type: "string", description: "CSS 选择器；给了就悬停到它的中心" },
      text: { type: "string", description: "按文字筛元素：同一选择器命中多个时用" },
      last: { type: "boolean", description: "命中多个时取最后一个（深几级的子菜单）" },
    },
    [],
  ),
  def(
    "ui_wheel",
    "调试用：向视口某个点派发一次滚轮（不模拟鼠标），验证块内滚动或 3D 场景推拉。",
    {
      x: { type: "number", description: "客户端 x" },
      y: { type: "number", description: "客户端 y" },
      deltaY: { type: "number", description: "滚轮量，正数往下，默认 120" },
    },
    ["x", "y"],
  ),
  def(
    "ui_scroll",
    "调试用：把匹配到的元素滚动到视野里（scrollIntoView），不模拟滚轮。",
    {
      selector: { type: "string", description: "CSS 选择器" },
      align: {
        type: "string",
        enum: ["start", "center", "end", "nearest"],
        description: "滚到视野的哪个位置，默认 center",
      },
    },
    ["selector"],
  ),
  def(
    "ui_dblclick",
    "调试用：按 CSS 选择器双击一下元素（可再用 text 筛内容），走 DOM dblclick、不模拟鼠标。",
    {
      selector: { type: "string", description: "CSS 选择器" },
      text: { type: "string", description: "多个匹配时，挑文字里包含这一段的那个" },
    },
    ["selector"],
  ),
  def(
    "ui_drag",
    "调试用：从视口坐标 (x,y) 拖到 (x+dx, y+dy)，走 DOM 的 pointer 事件、不模拟鼠标。用来验证拖块、拖遮罩这类交互。",
    {
      x: { type: "number", description: "起点 x（视口坐标）" },
      y: { type: "number", description: "起点 y" },
      dx: { type: "number", description: "横向拖多少" },
      dy: { type: "number", description: "纵向拖多少" },
    },
    ["x", "y"],
  ),
  def(
    "ui_inspect",
    "调试用：读页面上匹配元素的标签、位置和计算样式（display/宽高/边框/背景/网格列/间距），最多返回 40 个。验证 CSS 布局时用它，不用靠截图猜；pseudo 传 ::after 这类伪元素时读的是伪元素的样式。",
    {
      selector: { type: "string", description: "CSS 选择器，例如 .color-pop-preset" },
      pseudo: { type: "string", description: "可选：要读的伪元素，如 ::after / ::before" },
      view: {
        type: "string",
        enum: ["canvas", "settings", "current"],
        description: "量之前先切到哪个页面；默认 canvas，current 表示保持当前页面不动",
      },
    },
    ["selector"],
  ),
  def(
    "ui_hit",
    "调试用：给屏幕坐标，返回该点从顶层到底层的元素（标签、class、z-index、背景），用来查「谁盖住了谁」。",
    {
      x: { type: "number", description: "客户端 x" },
      y: { type: "number", description: "客户端 y" },
    },
    ["x", "y"],
  ),
  def("ui_close", "调试用：收起当前打开的取色板和菜单。"),
  def(
    "ui_reload",
    "调试用：重新加载前端页面，改完 JS/CSS 后让新代码生效（等同 Ctrl+R），不重启应用进程。",
  ),
  def(
    "space_batch",
    "一次提交一串操作，期间不会每个块都运镜打光，只在最后把整批框进视野。铺一整块区域、批量改样式、批量连线，都该用它，别一个一个调：既快，画面也不会被一串镜头跳动搅乱。每项 {tool, args}；某项失败不会中断后面的，返回里逐项标 ok。",
    {
      operations: {
        type: "array",
        description: "按顺序执行的操作，最多 200 项",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "工具名，如 block_create / block_update / connector_create" },
            args: { type: "object", description: "那个工具的参数，和单独调用时一样" },
          },
          required: ["tool"],
        },
      },
      stopOnError: { type: "boolean", description: "某一项失败就停下，默认 false（继续跑完）" },
    },
    ["operations"],
  ),
  def("block_get", "看单个块的摘要。", { id: ID }, ["id"]),
  def("block_create", "在画布里新建一块。坐标不给就落在视野中央、连续创建自动错开。", {
    type: { type: "string", description: "text/rect/ellipse/line/arrow/note/picture/scene/gen/product/quote/plan/page/image/audio/video/file/ebook/connector" },
    x: X, y: Y, w: W, h: H,
    text: { type: "string", description: "文字块的正文" },
    markdown: { type: "string", description: "笔记块的 Markdown 正文" },
    name: { type: "string", description: "笔记块的名字；产品卡也用它当名称" },
    brand: { type: "string", description: "产品卡：品牌" },
    sku: { type: "string", description: "产品卡：SKU / 货号" },
    spec: { type: "string", description: "产品卡：规格描述" },
    price: { type: "number", description: "产品卡：单价（元）" },
    qty: { type: "number", description: "产品卡：数量，默认 1" },
    source: { type: "string", description: "产品卡：来源链接或出处" },
    note: { type: "string", description: "产品卡：内部备注" },
    model: { type: "string", description: "产品卡：本机 GLB 模型路径（P2 用）" },
    dims: {
      type: "object",
      description: "产品卡：真实尺寸（毫米，宽×深×高），给户型脚印和 3D 用",
      properties: { w: { type: "number" }, d: { type: "number" }, h: { type: "number" } },
    },
    internal: { type: "boolean", description: "内部块：客户版导出时隐藏（P4 用）" },
    title: { type: "string", description: "清单块的标题；提案页也用它当页名" },
    ratio: { type: "string", enum: ["a4", "a4l", "16:9", "4:3"], description: "提案页比例，默认 a4（竖）" },
    order: { type: "number", description: "提案页的页序，从 1 开始" },
    path: { type: "string", description: "image/audio/video/file/ebook 块要的本机文件绝对路径；product 块用它当产品图，plan 块用它当户型图" },
    mode: { type: "string", enum: ["copy", "link"], description: "文件拷进画布还是只引用原文件，默认 copy" },
    as: { type: "string", enum: ["image", "audio", "video", "file", "ebook"], description: "按指定类型落块，覆盖按扩展名的自动判断" },
    fontSize: { type: "number", description: "文字块字号" },
    align: {
      type: "string",
      enum: ["left", "center", "right"],
      description: "文字块水平对齐，默认 left",
    },
    vAlign: {
      type: "string",
      enum: ["top", "middle", "bottom"],
      description: "文字块垂直对齐，默认 top；块被拉高后才看得出来",
    },
    radius: { type: "number", description: "圆角像素（px）：矩形/文字/图片/笔记/文件都认，椭圆没有圆角" },
    borderWidth: { type: "number", description: "边框宽度（px，0 为无边框）：矩形/椭圆/文字/图片默认 2，笔记/文件默认 1" },
    locked: { type: "boolean", description: "建好就锁住（锁住的块不能移动、缩放、改内容、删除，要先解锁）" },
    color: COLOR,
    textColor: { type: "string", description: "文字颜色" },
    borderColor: COLOR,
    fillColor: COLOR,
    paperColor: { type: "string", description: "画面块的画纸底色，如 #f5efdf；空串是透明" },
    cmds: PICTURE_CMDS,
    symbols: PICTURE_SYMBOLS,
    light: PICTURE_LIGHT,
    parts: SCENE_PARTS,
    camera: SCENE_CAMERA,
    groundColor: { type: "string", description: "场景块的地面颜色，如 #9a917d；空串用默认那档灰" },
    ...GEN_PROPS,
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
  def(
    "product_import_csv",
    "把一份 CSV 表格批量变成产品/材料卡：表头认中文（名称、品牌、SKU、规格、单价、数量、来源、备注、图片、模型）也认英文。图片列写相对路径时按 CSV 所在目录找，拷进画布。返回导入了几项、跳过几行、几张图没找到。",
    {
      path: { type: "string", description: "CSV 文件的绝对路径" },
      x: X,
      y: Y,
    },
    ["path"],
  ),
  def("block_update", "改一块的位置、尺寸、颜色或正文。只传要改的字段。画面块也能在这儿整幅换指令（cmds），但改几条不如用 picture_draw 按号追加、删。生图面板的提示词和出图参数也能在这儿改，但那只是改块上的字，要真出一张得用 gen_run。", {
    id: ID, x: X, y: Y, w: W, h: H,
    x2: { type: "number", description: "线段终点 x" },
    y2: { type: "number", description: "线段终点 y" },
    fontSize: { type: "number", description: "文字块字号" },
    align: {
      type: "string",
      enum: ["left", "center", "right"],
      description: "文字块水平对齐",
    },
    vAlign: {
      type: "string",
      enum: ["top", "middle", "bottom"],
      description: "文字块垂直对齐；块被拉高后才看得出来",
    },
    radius: { type: "number", description: "圆角像素（px）：所有带边框的块都认，椭圆没有圆角" },
    borderWidth: { type: "number", description: "边框宽度（px，0 为无边框）：所有带边框的块都认" },
    locked: { type: "boolean", description: "锁定/解锁这块；锁住的块要先传 locked:false 才能改其他字段" },
    borderColor: COLOR,
    fillColor: COLOR,
    color: { type: "string", description: "文字色" },
    textColor: { type: "string", description: "文字色" },
    text: { type: "string", description: "文字块正文" },
    markdown: { type: "string", description: "画布内笔记块的 Markdown 正文（引用外部 .md 的块用 note_write）" },
    name: { type: "string", description: "产品卡：名称" },
    brand: { type: "string", description: "产品卡：品牌" },
    sku: { type: "string", description: "产品卡：SKU / 货号" },
    spec: { type: "string", description: "产品卡：规格描述" },
    price: { type: "number", description: "产品卡：单价（元）" },
    qty: { type: "number", description: "产品卡：数量" },
    source: { type: "string", description: "产品卡：来源链接或出处" },
    note: { type: "string", description: "产品卡：内部备注" },
    model: { type: "string", description: "产品卡：本机 GLB 模型路径（P2 用）" },
    dims: {
      type: "object",
      description: "产品卡：真实尺寸（毫米，宽×深×高）",
      properties: { w: { type: "number" }, d: { type: "number" }, h: { type: "number" } },
    },
    internal: { type: "boolean", description: "内部块：客户版导出时隐藏" },
    title: { type: "string", description: "清单块的标题；提案页也用它当页名" },
    ratio: { type: "string", enum: ["a4", "a4l", "16:9", "4:3"], description: "提案页比例（改它会按比例重设页框大小）" },
    order: { type: "number", description: "提案页的页序，从 1 开始" },
    shape: { type: "string", enum: ["curve", "elbow"], description: "连线走线" },
    arrow: { type: "string", enum: ["none", "end", "both"], description: "连线箭头" },
    label: { type: "string", description: "连线文字" },
    points: POINTS,
    bend: BEND,
    from: { type: "string", description: "连线改起点块" },
    to: { type: "string", description: "连线改终点块" },
    fromSide: { type: "string", enum: ["auto", "top", "right", "bottom", "left"] },
    paperColor: { type: "string", description: "画面块的画纸底色，如 #f5efdf；空串是透明" },
    parts: SCENE_PARTS,
    camera: SCENE_CAMERA,
    groundColor: { type: "string", description: "场景块的地面颜色，如 #9a917d；空串用默认那档灰" },
    hidden: {
      type: "array",
      items: { type: "string" },
      description: "画面块关着的图层名（整幅替换这份开关，空数组是全开）；只想动开关用 picture_layers",
    },
    light: PICTURE_LIGHT,
    cmds: PICTURE_CMDS,
    symbols: PICTURE_SYMBOLS,
    ...GEN_PROPS,
  }, ["id"]),
  def("block_delete", "删除一块；挂在它身上的连线一起删。", { id: ID }, ["id"]),
  def("block_duplicate", "复制一块（媒体文件会真拷一份副本），默认落在原块右下 24px。给 space 就复制到那个画布（会切过去），垫在画面里的位图也一并拷进那个画布。", {
    id: ID,
    dx: { type: "number", description: "横向偏移，默认 24；给了 space 时不作数" },
    dy: { type: "number", description: "纵向偏移，默认 24；给了 space 时不作数" },
    space: { type: "string", description: "复制到哪个画布：id 或名字。不给就在本画布复制" },
    x: { type: "number", description: "跨画布复制时的落点世界 x（不给就摆在镜头正中）" },
    y: { type: "number", description: "跨画布复制时的落点世界 y" },
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
  def("camera_fit", "缩放到刚好看见画布里所有块。"),
  def("camera_reset", "回到 100% 缩放，视野中心不动。"),
  def("picture_get", "读一块画面的全部绘制指令和素材表：每条带号 i、类型和几何，symbols 是这块已经定义过的素材。改某一条之前先调它拿号，picture_screenshot 上看到的东西在这里都能按号对上。", {
    id: ID,
  }, ["id"]),
  def("picture_draw", "往画面块里画矢量指令。mode=replace（默认）整幅换掉、append 追加、delete 按 ids 删掉那几条。画歪了别整幅重画：picture_screenshot 看一眼，再 delete 那几条重新 append。字段写坏（颜色、半径、朝向词）不会报错、那一条整条丢掉并在返回的 dropped 里给出 at 和 why，条数对不上就是被丢了；但名字写错是致命的——素材名、变体名、图层名、tile / 剪刀点的素材名，只要一个对不上，这一笔请求整个失败并把这块现有的名字列回来，别指望少几条还能悄悄画完。用户自己在块左缘工具条上手绘的笔迹也是 op:stroke 的点串，要洗画就按号 delete 掉那几笔、换成精确指令。要重复摆同一个东西（人、船、瓦）就先用 symbols 定义一次、再摆 use，别把同一段几何重算几十遍。要照着已有的画就垫一张位图当底：{op:\"image\",path:\"C:\\\\某处\\\\参考图.png\"}，应用会把它拷进这个画布、照原图量好尺寸，再配 opacity 压淡、filter 去色；参考图也是一条指令，橡皮擦和按号 delete 都删得掉。笔画想带飞白就给那条 stroke 加 grain（0~1，0.5 上下最像写干了）：一笔会自己散成几根丝，中间露纸、末端分叉，不用你算丝。要遮、要裁就给那条加 clip（剪刀，形状里面才画得出来）或 mask（拿渐变当透镜子，做渐隐）；一百个窗就定义一个素材当剪刀，每个窗只写 ref 和落点。要把一幅画分开管就给指令起同一个 name 分层（远 / 中 / 近、城楼 / 河面），开关用 hidden 或 picture_layers，别为关一层把整幅 replace 一遍。明暗别自己心算：给块上挂一套光（picture_light），指令只声明那面朝哪个方向 face。", {
    id: ID,
    mode: { type: "string", enum: ["replace", "append", "delete"], description: "默认 replace" },
    cmds: PICTURE_CMDS,
    symbols: PICTURE_SYMBOLS,
    ids: { type: "array", items: { type: "number" }, description: "delete 要删的指令号" },
    hidden: {
      type: "array",
      items: { type: "string" },
      description: "这块关着的图层名（整幅替换这个开关，空数组是全开）。只想动开关用 picture_layers 更省，不用把指令重发一遍",
    },
    paperColor: { type: "string", description: "顺手改画纸底色，如 #f5efdf；空串是透明" },
    light: PICTURE_LIGHT,
  }, ["id"]),
  def("picture_screenshot", "只看这一块画面，返回一张 PNG：比 space_snapshot 近得多，用来检查刚画进去的那几条对不对。maxSide 给大一点才看得清字。", {
    id: ID,
    maxSide: { type: "number", description: "长边像素，默认 1200，最大 4096" },
  }, ["id"]),
  def("scene_screenshot", "看一块场景现在渲染成什么样，返回一张 PNG。这就是那块 3D 视口本身：里面是相机拍出来的，不是指令清单，所以摆歪了、影子不对、东西跑出框，都在这儿看得见。改完 parts / camera / light 就调它看一眼再决定下一步。", {
    id: ID,
    maxSide: { type: "number", description: "长边像素，默认 1200，最大 4096" },
  }, ["id"]),
  def("scene_room_shell", "给一块场景铺房间壳：客厅 / 主卧 / 餐厅三种，含地板、背景墙、侧墙、窗、地毯和边柜。单位是厘米（客厅 6.2×5.2m、墙高 2.8m）。会替换场景里现有的 parts，然后按白天光、自动机位重排；摆好壳再用 scene_place_product 把产品卡里的 GLB 家具放进去。", {
    id: ID,
    preset: { type: "string", enum: ["living", "bedroom", "dining"], description: "房间类型，默认 living" },
    wallColor: { type: "string", description: "墙面颜色，如 #ece7de" },
    floorColor: { type: "string", description: "地板颜色，如 #b98a5e" },
  }, ["id"]),
  def("scene_light_preset", "给场景换一套现成的光：day（白天）、warm（傍晚暖光）、night（夜间暖灯）、off（平光）。", {
    id: ID,
    preset: { type: "string", enum: ["day", "warm", "night", "off"] },
  }, ["id", "preset"]),
  def("scene_camera_preset", "把场景机位摆到现成的角度：front（正面）、left（左角）、right（右角）、top（俯视）、auto（按内容自动框）。", {
    id: ID,
    preset: { type: "string", enum: ["front", "left", "right", "top", "auto"] },
  }, ["id", "preset"]),
  def("scene_place_product", "把一张产品卡上的 GLB 模型放进场景：按卡上的真实尺寸 dims（毫米）等比缩放，落点 x/y 是场景地面坐标（厘米），rotate 是绕落点转的角度；不给 x/y 就放在地面中心。产品卡的 model 必须是模型库里已有的 .glb。返回场景摘要和 partIndex。", {
    scene: ID,
    product: ID,
    x: X,
    y: Y,
    rotate: { type: "number", description: "绕落点转的角度，0~360" },
  }, ["scene", "product"]),
  def("scene_apply_material", "把一张产品卡的图片当材质贴到场景的某个实体面上：target 给件名（地板 / 背景墙 / 侧墙 / 边柜 / 地毯）或 parts 序号，repeat 是每格多少厘米（默认 100）。clear:true 去掉贴图回到纯色。模型件不能贴。", {
    scene: ID,
    product: ID,
    target: { type: ["string", "number"], description: "件名或 parts 序号（从 0 开始）" },
    repeat: { type: "number", description: "每格多少厘米，默认 100" },
    clear: { type: "boolean", description: "true 就去掉这个面的贴图" },
  }, ["scene"]),
  def("plan_calibrate", "给户型块定标：x1/y1/x2/y2 是图片上两个点的相对位置（0~1，左上角是 0,0），mm 是这两点的真实长度（毫米）。定标后家具脚印、面积和机位才有真实比例。可以先 space_snapshot 看户型图再估点。", {
    id: ID,
    x1: { type: "number", description: "第一点的横向比例 0~1" },
    y1: { type: "number", description: "第一点的纵向比例 0~1" },
    x2: { type: "number", description: "第二点的横向比例 0~1" },
    y2: { type: "number", description: "第二点的纵向比例 0~1" },
    mm: { type: "number", description: "这两点的真实长度（毫米）" },
  }, ["id", "x1", "y1", "x2", "y2", "mm"]),
  def("plan_place_product", "把产品卡放上户型图：脚印尺寸取卡上的 dims（毫米），x/y 是户型图上的毫米坐标（左上角原点，不给就放图中心），rotate 绕脚印中心转。返回 footprint（以后移动/删除用它的 id）。", {
    plan: ID,
    product: ID,
    x: X,
    y: Y,
    rotate: { type: "number", description: "脚印旋转角度，0~360" },
  }, ["plan", "product"]),
  def("plan_place_camera", "在户型图上放一个 3D 机位标记：链接一个场景块，preset 是 front / left / right / top / auto；用户点这个标记时会把该场景切到这个机位。x/y 是户型图毫米坐标（标记位置），rotate 是朝向。", {
    plan: ID,
    scene: ID,
    x: X,
    y: Y,
    rotate: { type: "number", description: "标记朝向，0~360" },
    preset: { type: "string", enum: ["front", "left", "right", "top", "auto"], description: "点击时场景切到哪个机位，默认 front" },
  }, ["plan", "scene"]),
  def("plan_area", "在户型图上量一块面积：points 是毫米坐标 [{x,y},…]（至少 3 个点，按顺序围一圈），返回 squareMeters。", {
    plan: ID,
    points: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  }, ["plan", "points"]),
  def("plan_remove", "删掉户型图上的一个脚印 / 机位 / 面积区域：kind 是 footprint / camera / area，item 是它们的 id（block_get 能拿到）。", {
    plan: ID,
    kind: { type: "string", enum: ["footprint", "camera", "area"] },
    item: { type: "string", description: "要删的那一项 id" },
  }, ["plan", "kind", "item"]),
  def("page_screenshot", "看一张提案页按客户版规则导出的样子：去掉内部块、摘掉页名和描边，整页渲染成 PNG。maxSide 越大越清楚（320~4096，默认 1400）。", {
    id: ID,
    maxSide: { type: "number", description: "长边像素，默认 1400，最大 4096" },
  }, ["id"]),
  def("proposal_template", "一键搭一套软装提案骨架：7 页（封面 / 客户需求 / 风格板 / 客厅 / 主卧 / 餐厅 / 材料与报价），客厅、主卧、餐厅三页里已经铺好房间壳场景，最后页带清单块。只建占位文字，不出图；建完再往里填参考图、产品卡和户型。", {
    title: { type: "string", description: "提案标题，默认「软装提案」" },
    x: X,
    y: Y,
  }),
  def("page_duplicate", "复制一张提案页和页里的内容，新页排在原页右边（媒体各拷一份独立副本），用来快速做风格变体。连线不复制。", {
    id: ID,
  }, ["id"]),
  def("client_web_export", "把客户版网页导出到指定文件夹：在 dir 下新开一个 name 子文件夹，写 index.html、每页一张 PNG 和一个可转 3D 的查看器。模型和材质图都内嵌，客户双击 index.html 就能看；内部块、页名、页框描边都不进成品。dir 必须已经存在。", {
    dir: { type: "string", description: "目标文件夹的绝对路径（必须已存在）" },
    name: { type: "string", description: "子文件夹名，默认「画布名 客户版 时间」" },
  }, ["dir"]),
  def("client_pdf_export", "把提案按页导出成多页 PDF，写到 dir 下的 <name>.pdf。内部块和页名不会进 PDF。", {
    dir: { type: "string", description: "目标文件夹的绝对路径（必须已存在）" },
    name: { type: "string", description: "PDF 文件名（不带扩展名），默认「画布名 客户版」" },
  }, ["dir"]),
  def("model_list", "列出 3D 模型库（数据根 library/models）里的 .glb，返回 {models:[{name,size,modified}]}。产品卡的 model 字段就填这里的 name。"),
  def("model_import", "把一份本机 .glb 收进模型库（贴图要内嵌）；path 不给就弹文件框。返回导入后的 {name,size}。", {
    path: { type: "string", description: "本机 .glb 的绝对路径；不给就开文件框" },
  }),
  def(
    "picture_export",
    "把一块画面落成一张独立的图片块：只渲染这一块、存成 PNG 进画布 images/，摆在原块右边。之后它就是普通图片，能拖、能双击看大图、也能单独导出。",
    { id: ID },
    ["id"],
  ),
  def("picture_layers", "看这块画面有哪些图层（同名指令算一层，group 里单独起了名的那笔也算一层；报每层几条、关没关着，另外给还没起名的条数），带 hide / show 就按层名整层开关。关掉的层真不画（截图和导出里都没有它），但指令、条数和展开额度都还在，重新打开就回来；关着的层橡皮也擦不到。名字不在 hide 和 show 里同时给才有意义：同名两边都给按 show 算（开着）。素材内部那套 name / variants 是给 use 的 hide / variant 挑的，和这块的层开关是两回事。", {
    id: ID,
    hide: { type: "array", items: { type: "string" }, description: "要关掉的层名" },
    show: { type: "array", items: { type: "string" }, description: "要打开的层名" },
  }, ["id"]),
  def("picture_light", "给一块画面打一套光，或问它现在怎么打的光。只传 id 就是读；带哪个字段就改哪个字段，没带的沿用块上现值——挪五度方位角不该把光色、影色、强度重发一遍。off:true 关掉光。指令里存的永远是固有色：明暗是渲染时按每条的 face 和这套光的夹角算出来的，所以改一次光整幅跟着变、一条指令都不动。没写 face 的笔保持固有色，一块里一条 face 都没有时打光看不出效果（返回里的 faced 告你几条吃了光）。位图（image）不吃光；缺 dx/dy 的投影会跟着这套光倒向背光那边。", {
    id: ID,
    ...(PICTURE_LIGHT.properties || {}),
    off: { type: "boolean", description: "true 就是关掉这块的光，回到没有光的原样" },
  }, ["id"]),
  def("gen_status", "问出图引擎现在什么状况：权重进没进内存、哪一块生图面板正占着它、要用的那几个文件在不在盘上、当前用的是哪一档（dit / encoder）、空闲多久自动放掉。顺带把这块画布里每一面生图面板的摘要都列出来（提示词、参数、那一档 mode 和改动幅度 strength、进料 feed={mode,label,count} 说清这次真会走哪档、接了几张输入图、相位、最近那张的相对路径）。"),
  def("gen_models", "检测出图模型这一整套的现状，一次全给：模型目录（modelsDir，用户在设置页定的，可能在数据根之外）+ 目录里可换的两列文件（dit 画图模型、encoder 文本编码器，各带字节数，小的在前）+ fixed 两件跟着模型定死的 + 当前选的档 + missing 缺哪些 + machine 这台机器的数字（显卡名、显存、内存总量与空闲、该盘剩余）+ advice 为什么建议某一档 + needed 建议那一套要放的四个文件（名字、字节数、下载页、在不在盘上，视觉投影标 optional）+ tiers 全部量化档。头一次调用会探显卡，稍慢一两秒。这是引擎级的全局配置，和当前画布无关。"),
  def("gen_models_set", "换出图档位：dit / encoder 各给一个模型文件夹里的文件名，没给的槽位不动。选了立刻落库并放掉已载入的权重——下一次出图按新档重新载入，头一次会慢一两分钟。正在出图时换不了（先 gen_cancel 或等这张跑完）。文件名必须是 gen_models 扫出来的那一个，且不能跨槽位（拿编码器当 DiT 会报回）。模型目录不由这条工具改：要挪地方是用户在设置页「换个目录」。", {
    dit: { type: "string", description: "画图模型文件名，取自 gen_models 的 dit 列" },
    encoder: { type: "string", description: "文本编码器文件名，取自 gen_models 的 encoder 列" },
  }),
  def("gen_run", "让一块生图面板出一张图。默认这一次调用会等到出完为止（出图约半分钟；头一次跑要先从盘上读权重，那一两分钟也算在里头，所以别把 timeout 压太小）。引擎一次只吃一张：别的面板正在出图会直接报回，先 gen_cancel 或等它完事。图出好自动存进这个画布的 images/，路径写在返回的 src 上；面板上那张不会自己变成图片块，要另摆一块用 gen_place。想改词重出就带着 prompt 再调一次；固定 seed 才能复现同一张（-1 是每张换一个）。输入图靠连线：谁用 connector 连到这块，谁就是进料——接一张是图生图，接多张是参考图编辑，一根不接就是文生图。mode 给 upscale 是另一条路：纯 ESRGAN 放大，连一张图、不读提示词也不看步数，出来就是 4× 那张（864×1152 那种输入约十秒）。", {
    id: ID,
    prompt: { type: "string", description: "这一张要什么，一句话到一段话" },
    negative: { type: "string", description: "不想要什么" },
    imageW: { type: "number", description: "出图宽，256~2048，自己贴到 32 的倍数，默认 1024" },
    imageH: { type: "number", description: "出图高，同上" },
    steps: { type: "number", description: "步数 1~100，默认 20" },
    cfg: { type: "number", description: "提示词贴合度 1~20，默认 6" },
    seed: { type: "number", description: "种子；-1 每张换一个，给正数才能同一张复现" },
    mode: {
      type: "string",
      enum: ["auto", "t2i", "i2i", "edit", "upscale", "inpaint"],
      description:
        "出图那一档，写在块上会留着。auto 按连线定：没图=文生图、一张=图生图、多张=参考图编辑。upscale 是纯 ESRGAN 高清放大，不参与推断、要明说：连一张图进来，出不带提示词的 4× 那张。inpaint 是局部重绘：连一张底图、再带 mask，白的地方按 prompt 重画",
    },
    mask: {
      type: "string",
      description: "局部重绘（mode=inpaint）的遮罩：PNG 的 base64（data: 前缀也吃），白=重绘、黑=保留，尺寸会自动缩到底图",
    },
    refine: {
      type: "boolean",
      description: "高清放大（mode=upscale）时是否在放大后再低强度重绘一遍补细节；要配 prompt 一起用",
    },
    strength: { type: "number", description: "图生图改多少 0~1，默认 0.75" },
    wait: { type: "boolean", description: "false 只起一轮就返回（马上拿 phase 判断），默认 true 等到出完" },
    timeout: { type: "number", description: "等多少秒，默认 300，最大 600。到点返回 timedOut:true，图还在后台跑，用 gen_status 接着问" },
  }, ["id"], 630),
  def("gen_cancel", "掐掉正在出的那一张。载入权重那几分钟也能停（那边一出来看到取消标志就自己收）。没有图在跑返回 canceled:false。"),
  def("gen_place", "把一块生图面板最近出的那张落成一块独立图片块，落在面板右边。落出去的是复制：面板接着显示它那张、也接着能改词重出，图片块自己带一份文件，删哪一块都不影响另一块。", { id: ID }, ["id"]),
  def("gen_screenshot", "看一块生图面板现在是什么样，返回一张 PNG——取景窗里就是最近那张成品，正在跑的时候是逐步预览的那一帧。比 space_snapshot 近得多，改完提示词、出了图想确认画面对不对，调它。", {
    id: ID,
    maxSide: { type: "number", description: "长边像素，默认 1200，最大 4096" },
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
  def("file_write", "把正文写回文本文件块对应的文件（拷贝态写画布副本，引用态写原文件）。", {
    id: ID,
    text: { type: "string", description: "完整的新正文" },
    force: { type: "boolean", description: "原文件在读取后被外部改过时，是否仍然覆盖" },
  }, ["id", "text"]),
  def("file_reveal", "在系统文件管理器里定位一块指向的磁盘文件。", { id: ID }, ["id"]),
  def("image_open", "用系统默认的看图工具打开一块图（用户在画布上双击那块图是一回事）。", { id: ID }, ["id"]),
  def("file_import", "把本机文件作为一块插进画布：图片、音频、视频、电子书、附件、Markdown 自动分类型。", {
    path: { type: "string", description: "本机文件绝对路径" },
    mode: { type: "string", enum: ["copy", "link"], description: "拷进画布还是只引用原文件，默认 copy" },
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
];

export const TOOL_LIST = TOOL_DEFS;

function viewNow() {
  return window.__inspace?.route || "canvas";
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

function pick(args, keys) {
  const out = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

const BLOCK_FIELDS = [
  "x", "y", "w", "h", "x2", "y2", "fontSize", "align", "vAlign", "radius", "borderWidth", "locked",
  "borderColor", "fillColor", "color", "textColor", "text", "markdown",
  "name", "brand", "sku", "spec", "price", "qty", "source", "note", "model", "dims", "internal", "title", "ratio", "order",
  "shape", "arrow", "label", "bend", "points", "from", "to", "fromSide",
  "cmds", "symbols", "paperColor", "hidden", "light",
  "parts", "camera", "groundColor",
  ...GEN_KEYS,
];

async function appState() {
  const [dataRoot, mcpInfo] = await Promise.all([
    invoke("data_root").catch(() => ""),
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
    theme: currentTheme(),
    mcp: mcpInfo ? { running: mcpInfo.running, port: mcpInfo.port, url: mcpInfo.url, error: mcpInfo.error } : null,
    space,
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

/* 飞行工具默认先把宇宙主题打开，和切页一样让用户当场看得见 */
async function ensureCosmos(args) {
  if (currentTheme() === "cosmos") return null;
  setTheme("cosmos");
  await beat(args);
  return "已切到宇宙主题，航线开始飞";
}

async function flightState(args) {
  const note = await ensureCosmos(args);
  return { ...(note ? { note } : {}), ...cosmosFlight() };
}

async function flightControl(args) {
  const note = await ensureCosmos(args);
  const result = cosmosFlightControl(args.action, args.body ?? args.type, args.distance);
  return { ...(note ? { note } : {}), ...result };
}

/* 下载在 Rust 的后台线程上跑，整包七张要几分钟，比前端命令的等待上限长得多：
   所以启动完就返回，让 agent 自己隔一会儿调一次 status。坐着等只会回一个假错误。 */
async function cosmosTextures(args) {
  const action = args.action;
  if (action === "upgrade") {
    await invoke("cosmos_tex_upgrade");
    const status = await invoke("cosmos_tex_status");
    return {
      ...status,
      note:
        "下载已在后台跑，整包约 35MB、要几分钟；隔 30 秒调一次 action:\"status\" 看 got/total，" +
        "跑完下一颗星体自动用新档，中间别再调 upgrade",
    };
  }
  if (action === "cancel") {
    await invoke("cosmos_tex_cancel");
    return {
      ...(await invoke("cosmos_tex_status")),
      note: "已请求取消，下过的那几张留着",
    };
  }
  if (action === "reset") {
    await invoke("cosmos_tex_reset");
    window.dispatchEvent(new CustomEvent("cosmos-textures-changed"));
    return { ...(await invoke("cosmos_tex_status")), note: "8K 已进系统回收站，回到内置 2K" };
  }
  const status = await invoke("cosmos_tex_status");
  /* 设置页没开着时没人通知渲染层档位变了；agent 轮到这里发现盘上的张数
     和渲染层以为的不一样，就提醒它重问一次——不然新下的 8K 要等下次进主题才生效 */
  if (!status.running && status.got !== (cosmosFlight().textures?.hi ?? -1)) {
    window.dispatchEvent(new CustomEvent("cosmos-textures-changed"));
  }
  return status;
}

/* 航线是偏好，不是飞行操作：不为了改个名单就把用户从别的主题拽进宇宙。 */
function cosmosRouteTool(args) {
  const changed = args.order !== undefined || args.minutes !== undefined;
  const route = changed ? cosmosRouteSet(args.order, args.minutes) : cosmosRoute();
  if (currentTheme() === "cosmos") return route;
  return { ...route, note: "当前不是宇宙主题；名单已存下，切过去就按这条航线飞" };
}

/* 档位和航线同理：引擎级的全局配置，不为它把用户从当前画布拽走。
   这一个还带机器规格和本机建议档，所以缺文件时能把「该下什么」直接说清楚。 */
async function genModelsTool() {
  const models = await invoke("gen_models");
  const advised = models.tiers.find((tier) => tier.recommended)?.name || models.currentDit;
  const lacking = models.needed.filter((row) => !row.present && !row.optional);
  if (lacking.length) {
    const want = lacking.map((row) => `${row.name}（${row.role}）`).join("、");
    return {
      ...models,
      note:
        `模型目录 ${models.modelsDir} 里还缺 ${lacking.length} 件：${want}。这台机器的建议档是 ${advised}，` +
        "文件名、字节数、下载页都在 needed 里，量化档对照表在 tiers 里——把这些报给用户，" +
        "下载和「换个目录」都是他在设置页做的事，你别代劳。",
    };
  }
  if (models.missing.length) {
    return {
      ...models,
      note: `当前档位缺文件：${models.missing.join("、")}；换一档用 gen_models_set，或让用户把文件放回 ${models.modelsDir}`,
    };
  }
  const advice = advised === models.currentDit ? "本机建议档就是当前这档" : `这台机器装得下更大的：建议 ${advised}`;
  return { ...models, note: `两列（dit / encoder）里挑一档，gen_models_set 换。${advice}` };
}

async function genModelsSetTool(args) {
  if (!args.dit && !args.encoder) throw new Error("dit 和 encoder 至少给一个，不然没什么可换");
  const models = await invoke("gen_models_set", args);
  return {
    ...models,
    note:
      `已记下：画图模型 ${models.currentDit}、编码器 ${models.currentEncoder}。` +
      "载入的权重已放掉，下一次出图按新档重新读盘，头一次会慢一两分钟",
  };
}

/* 截图不改任何数据，所以不走 pace 那一拍；但要先把画布页切出来，不然取不到 DOM */
async function snapshot(args) {
  await ensureView("canvas");
  const region = args.rect && typeof args.rect === "object" ? args.rect : args.region || "all";
  const shot = await canvasAgent.snapshot({ region, maxSide: args.maxSide, scale: args.scale });
  const perPixel = shot.region.w / shot.width;
  return {
    __image: { data: shot.data, mimeType: "image/png" },
    note:
      `截图 ${shot.width}×${shot.height}，覆盖世界坐标 x ${shot.region.x}~${shot.region.x + shot.region.w}、` +
      `y ${shot.region.y}~${shot.region.y + shot.region.h}；画面里 ${shot.blocks} 个块、${shot.connectors} 条连线。` +
      `换算世界坐标：x = ${shot.region.x} + 图上横向像素 × ${perPixel.toFixed(2)}，y 同理从 ${shot.region.y} 起算。`,
  };
}

/* 把一块矩形面板的范围导出成图。和截图走同一套世界层光栅化，
   区别是这里会连「框外裁掉、透明底不画面板」一起按导出规格处理。 */
async function blockExport(args) {
  await ensureView("canvas");
  const block = canvasAgent.blockGet(args.id);
  if (block.type !== "rect") throw new Error("只有矩形面板能按范围导出");
  const shot = await canvasAgent.exportRegion({
    box: { x: block.x, y: block.y, w: block.w, h: block.h },
    quality: args.quality || "high",
    transparent: args.transparent === true,
    hideId: block.id,
    name: `${block.seq ?? "面板"}`,
  });
  return {
    __image: { data: shot.data, mimeType: "image/png" },
    note:
      `已导出 ${shot.width}×${shot.height} 的 PNG（${shot.transparent ? "透明背景" : "含面板底色"}，×${shot.scale}），` +
      `覆盖世界坐标 x ${block.x}~${block.x + block.w}、y ${block.y}~${block.y + block.h}。`,
  };
}

/* 只看一块画面：把这块的包围盒当自定义矩形交给同一套截图管线。
   外扩 2px 是为了把块自己那圈边框也带上，不然看不出画到边了没有。 */
async function blockScreenshot(args, type, label) {
  await ensureView("canvas");
  const block = canvasAgent.blockGet(args.id);
  if (block.type !== type) throw new Error(`这不是${label}`);
  const pad = 2;
  const shot = await canvasAgent.snapshot({
    region: {
      x: block.x - pad,
      y: block.y - pad,
      w: block.w + pad * 2,
      h: block.h + pad * 2,
    },
    maxSide: args.maxSide || 1200,
  });
  const perPixel = shot.region.w / shot.width;
  /* 这块「装了多少东西」每种块说法不一样，都得报：出图的这一张、画图的几百条指令、场景的几件东西 */
  const inside =
    type === "picture"
      ? `${block.cmds} 条指令`
      : type === "scene"
        ? `${block.parts} 件东西`
        : block.phase === "loading" || block.phase === "running"
          ? `这一张跑到第 ${block.step} / ${block.steps} 步`
          : block.src
            ? `最近一张是 ${block.src}`
            : "还没出过图";
  return {
    __image: { data: shot.data, mimeType: "image/png" },
    note:
      `${label} ${block.id}：${shot.width}×${shot.height}，覆盖世界坐标 x ${shot.region.x}~${shot.region.x + shot.region.w}、` +
      `y ${shot.region.y}~${shot.region.y + shot.region.h}；块内 ${inside}。` +
      `换算块内画面坐标：x = ${(shot.region.x - block.x).toFixed(0)} + 图上横向像素 × ${perPixel.toFixed(2)}，y 同理。`,
  };
}

/* 批量里只放画布上的块操作。切画布、换主题这些会跳页，
   混进来会把这一批的观感打散，所以按白名单放行。
   生图那一头只放看和落块：gen_run 一次只吃一张、一批排三十秒一张没意义，gen_cancel 掐的是唯一那一张，
   都不该藏在批量里。 */
const BATCH_ALLOWED =
  /^(block_|connector_|picture_|scene_|gen_(status$|screenshot$|place$)|note_read$|note_write$|file_import$|pdf_goto$|ebook_goto$|camera_)/;

/* 一项的结果只留 id 和类型：200 项把完整摘要都塞回去，这个回复会大到没法看 */
function briefResult(data) {
  if (data && typeof data === "object" && !Array.isArray(data) && data.id) {
    return { id: data.id, type: data.type };
  }
  return undefined;
}

async function runBatch(args) {
  const ops = Array.isArray(args.operations) ? args.operations : [];
  if (!ops.length) throw new Error("operations 是空的，没什么可做");
  if (ops.length > 200) throw new Error(`一次最多 200 项，这次给了 ${ops.length} 项`);
  await ensureView("canvas");

  const results = [];
  let failed = 0;
  let firstId = "";
  let lastId = "";
  canvasAgent.beginBatch();
  try {
    for (const op of ops) {
      const tool = String(op?.tool || "");
      const sub = op?.args && typeof op.args === "object" ? op.args : {};
      if (!BATCH_ALLOWED.test(tool)) {
        failed += 1;
        results.push({ tool, ok: false, error: "这个工具不能放进批量里" });
        continue;
      }
      try {
        const data = await dispatch(tool, sub);
        if (!firstId && data?.id) firstId = data.id;
        if (data?.id) lastId = data.id;
        results.push({ tool, ok: true, result: briefResult(data) });
      } catch (error) {
        failed += 1;
        results.push({ tool, ok: false, error: String(error?.message || error) });
        if (args.stopOnError) break;
      }
    }
  } finally {
    canvasAgent.endBatch();
  }

  /* 整批做完再把视野收到这批东西上，比中途每建一块跳一次镜头好得多 */
  if (firstId || lastId) canvasAgent.batchFit();

  return {
    done: results.length - failed,
    failed,
    note: "整批不运镜不打光带",
    operations: results,
  };
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
    case "flight_state":
      return flightState(args);
    case "flight_control":
      return flightControl(args);
    case "cosmos_route":
      return cosmosRouteTool(args);
    case "cosmos_textures":
      return cosmosTextures(args);

    case "space_list":
      return onCanvas(args, () => canvasAgent.spaceList());
    case "space_tree":
      return onCanvas(args, () => canvasAgent.spaceTree());
    case "space_open":
      return onCanvas(args, () => canvasAgent.spaceOpen(args.space));
    case "space_create":
      return onCanvas(args, () => canvasAgent.spaceCreate(args.name, args.parent));
    case "space_copy":
      return onCanvas(args, () => canvasAgent.spaceCopy(args.space, args.parent));
    case "space_rename":
      return onCanvas(args, () => canvasAgent.spaceRename(args.space, args.name));
    case "space_delete":
      return onCanvas(args, () => canvasAgent.spaceDelete(args.space));
    case "group_create":
      return onCanvas(args, () => canvasAgent.groupCreate(args.parent, args.name));
    case "group_rename":
      return onCanvas(args, () => canvasAgent.groupRename(args.group, args.name));
    case "group_delete":
      return onCanvas(args, () => canvasAgent.groupDelete(args.group));
    case "space_scene":
      return onCanvas(args, () => canvasAgent.scene(pick(args, ["type"])));
    case "space_snapshot":
      return snapshot(args);
    case "block_export":
      return blockExport(args);
    case "space_batch":
      return runBatch(args);
    case "ui_color_picker":
      return onCanvas(args, () => canvasAgent.debugColorPicker({ id: args.id, prop: args.prop }));
    case "ui_menu":
      return onCanvas(args, () => canvasAgent.debugMenu({ id: args.id }));
    case "ui_menu_color":
      return onCanvas(args, () => canvasAgent.debugMenuColor({ id: args.id }));
    case "ui_drag":
      return canvasAgent.debugDrag({ x: Number(args.x) || 0, y: Number(args.y) || 0, dx: Number(args.dx) || 0, dy: Number(args.dy) || 0 });
    case "ui_click":
      return canvasAgent.debugClick({
        selector: args.selector,
        text: args.text,
        focus: args.focus,
        detail: args.detail,
        right: args.right,
      });
    case "ui_key":
      return canvasAgent.debugKey({
        key: args.key,
        action: args.action,
        ctrl: args.ctrl,
        shift: args.shift,
        alt: args.alt,
        meta: args.meta,
      });
    case "ui_input":
      return canvasAgent.debugInput({ selector: args.selector, text: args.text });
    case "ui_hover":
      return canvasAgent.debugHover({
        x: Number(args.x) || 0,
        y: Number(args.y) || 0,
        selector: args.selector,
        text: args.text,
        last: args.last === true,
      });
    case "ui_dblclick":
      return canvasAgent.debugDoubleClick({ selector: args.selector, text: args.text });
    case "ui_wheel":
      return canvasAgent.debugWheel({
        x: Number(args.x) || 0,
        y: Number(args.y) || 0,
        deltaY: Number(args.deltaY) || 120,
      });
    case "ui_scroll":
      return canvasAgent.debugScroll({ selector: args.selector, align: args.align });
    case "ui_inspect": {
      const view = args.view || "canvas";
      if (view !== "current") await ensureView(view);
      return canvasAgent.debugInspect({ selector: args.selector, pseudo: args.pseudo });
    }
    case "ui_hit":
      return canvasAgent.debugHit({ x: args.x, y: args.y });
    case "ui_close":
      return canvasAgent.debugClose();
    case "ui_reload":
      /* 先把回执发出去再刷新，不然请求会跟着页面一起断在半路 */
      setTimeout(() => window.location.reload(), 80);
      return { reloading: true };

    case "block_get":
      return onCanvas(args, () => canvasAgent.blockGet(args.id));
    case "block_create":
      return onCanvas(args, () =>
        /* schema 里写了的字段，这里就得挨个接住：漏一个不报错，那块会安静地建成空的
           （第一版就是这样把 parts / light / camera / groundColor 落掉的——五件东西回来是 0 件） */
        canvasAgent.blockCreate(
          pick(args, [
            "type", "x", "y", "w", "h", "text", "markdown", "name", "path", "mode", "as",
            "fontSize", "align", "vAlign", "radius", "borderWidth", "locked", "color", "textColor", "borderColor", "fillColor",
            "brand", "sku", "spec", "price", "qty", "source", "note", "model", "dims", "internal", "title", "ratio", "order",
            "paperColor", "cmds", "symbols", "light", "parts", "camera", "groundColor",
            ...GEN_KEYS,
            "x2", "y2", "shape", "arrow", "label", "bend", "points", "from", "to", "fromSide",
          ]),
        ),
      );
    case "product_import_csv":
      return onCanvas(args, () =>
        canvasAgent.productImportCsv({ path: args.path, x: args.x, y: args.y }),
      );
    case "block_update":
      return onCanvas(args, () => canvasAgent.blockUpdate(args.id, pick(args, BLOCK_FIELDS)));
    case "block_delete":
      return onCanvas(args, () => canvasAgent.blockDelete(args.id));
    case "block_duplicate":
      return onCanvas(args, () => canvasAgent.blockDuplicate(args.id, pick(args, ["dx", "dy", "space", "x", "y"])));
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

    case "picture_get":
      return onCanvas(args, () => canvasAgent.pictureGet(args.id));
    case "picture_draw":
      return onCanvas(args, () =>
        canvasAgent.pictureDraw(args.id, pick(args, ["mode", "cmds", "symbols", "ids", "paperColor", "hidden", "light"])),
      );
    case "picture_layers":
      return onCanvas(args, () => canvasAgent.pictureLayers(args.id, pick(args, ["hide", "show"])));
    case "picture_light":
      return onCanvas(args, () => canvasAgent.pictureLight(args.id, pick(args, ["angle", "elev", "lit", "dark", "k", "off"])));
    case "picture_export":
      return onCanvas(args, () => canvasAgent.pictureExport(args.id));
    case "picture_screenshot":
      return blockScreenshot(args, "picture", "画面块");
    case "scene_screenshot":
      return blockScreenshot(args, "scene", "场景块");
    case "scene_room_shell":
      return onCanvas(args, () =>
        canvasAgent.sceneRoomShell(pick(args, ["id", "preset", "wallColor", "floorColor"])),
      );
    case "scene_light_preset":
      return onCanvas(args, () => canvasAgent.sceneLightPreset(pick(args, ["id", "preset"])));
    case "scene_camera_preset":
      return onCanvas(args, () => canvasAgent.sceneCameraPreset(pick(args, ["id", "preset"])));
    case "scene_place_product":
      return onCanvas(args, () =>
        canvasAgent.scenePlaceProduct(pick(args, ["scene", "product", "x", "y", "rotate"])),
      );
    case "scene_apply_material":
      return onCanvas(args, () =>
        canvasAgent.sceneApplyMaterial(pick(args, ["scene", "product", "target", "repeat", "clear"])),
      );
    case "plan_calibrate":
      return onCanvas(args, () =>
        canvasAgent.planCalibrate(pick(args, ["id", "x1", "y1", "x2", "y2", "mm"])),
      );
    case "plan_place_product":
      return onCanvas(args, () =>
        canvasAgent.planPlaceProduct(pick(args, ["plan", "product", "x", "y", "rotate"])),
      );
    case "plan_place_camera":
      return onCanvas(args, () =>
        canvasAgent.planPlaceCamera(pick(args, ["plan", "scene", "x", "y", "rotate", "preset"])),
      );
    case "plan_area":
      return onCanvas(args, () => canvasAgent.planArea(pick(args, ["plan", "points"])));
    case "plan_remove":
      return onCanvas(args, () => canvasAgent.planRemove(pick(args, ["plan", "kind", "item"])));
    case "page_screenshot": {
      await ensureView("canvas");
      const shot = await canvasAgent.pageSnapshot({ id: args.id, maxSide: args.maxSide || 1400 });
      return {
        __image: { data: shot.data, mimeType: "image/png" },
        note:
          `提案页 ${args.id}：${shot.width}×${shot.height}，整页范围 x ${shot.region.x}~${shot.region.x + shot.region.w}、` +
          `y ${shot.region.y}~${shot.region.y + shot.region.h}`,
      };
    }
    case "client_web_export":
      return onCanvas(args, () => canvasAgent.clientWebExport(args.dir, args.name));
    case "client_pdf_export":
      return onCanvas(args, () => canvasAgent.clientPdfExport(args.dir, args.name));
    case "proposal_template":
      return onCanvas(args, () => canvasAgent.proposalTemplate(pick(args, ["title", "x", "y"])));
    case "page_duplicate":
      return onCanvas(args, () => canvasAgent.pageDuplicate({ id: args.id }));
    case "model_list": {
      const models = await invoke("model_library_list");
      return { models };
    }
    case "model_import": {
      const file = await invoke("model_library_import", { path: args.path || null });
      return file ? { imported: file } : { imported: null };
    }
    case "gen_models":
      return genModelsTool();
    case "gen_models_set":
      return genModelsSetTool(pick(args, GEN_MODEL_KEYS));
    case "gen_status":
      return onCanvas(args, () => canvasAgent.genStatus());
    case "gen_run":
      /* wait / timeout 也走 pick：wait:false 是「只起一轮就回」，不能当成没给 */
      return onCanvas(args, () =>
        canvasAgent.genRun(args.id, pick(args, [...GEN_KEYS, "wait", "timeout", "refine"]), args.mask || ""),
      );
    case "gen_cancel":
      return onCanvas(args, () => canvasAgent.genCancel());
    case "gen_place":
      return onCanvas(args, () => canvasAgent.genPlace(args.id));
    case "gen_screenshot":
      return blockScreenshot(args, "gen", "生图面板");
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
    case "image_open":
      return onCanvas(args, () => canvasAgent.imageOpen(args.id));
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
    /* 截图是真图片，不能塞进 JSON 变成一坨 base64 文本——MCP 有 image 这种 content，
       客户端会把它当图渲染出来，模型才真的「看得见」 */
    if (data && data.__image) {
      const content = [{ type: "image", data: data.__image.data, mimeType: data.__image.mimeType }];
      if (data.note) content.push({ type: "text", text: data.note });
      return { content, isError: false };
    }
    const text = typeof data === "string" ? data : JSON.stringify(data ?? {});
    return textResult(text, false);
  } catch (error) {
    return textResult(String(error?.message || error || "工具执行失败"), true);
  }
}
