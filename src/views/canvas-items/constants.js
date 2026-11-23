/* canvas-items/constants.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

export const DEFAULT_BORDER = "#9a9a9a";
/* 矩形/椭圆的边框宽度，跟样式表里 .canvas-item-rect/.canvas-item-ellipse 的 2px 对齐 */
export const BORDER_DEFAULT_WIDTH = 2;
export const BORDER_MAX_WIDTH = 40;
/* 卡片型面板（笔记/文件/图片）的边框和圆角，跟样式表里的 1px 实线、10px 圆角对齐 */
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
   除了把笔画栈和文件撑大没有任何用处。 */
export const PICTURE_STROKE_MIN_STEP = 1.2;
/* 橡皮判定再往外让这么多：笔迹细的时候指着它旁边一点也该擦得掉 */
export const PICTURE_ERASER_TOLERANCE = 4;
/* 生图面板：一块本地出图的取景窗。出图一张要 30 秒，所以这块的重点是「等得明白」——
   面板上只摆提示词框和一颗开始，其余参数走默认，agent 想改直接写块字段。 */
export const GEN_MIN_WIDTH = 320;
export const GEN_MIN_HEIGHT = 360;
/* 新建就用最小尺寸：无限画布上先占一小块，要大的自己拉 */
export const GEN_DEFAULT_WIDTH = GEN_MIN_WIDTH;
export const GEN_DEFAULT_HEIGHT = GEN_MIN_HEIGHT;
/* 提示词给到 4000 字：够写一整段画面描述，又不至于把这份内容文件当笔记使 */
export const GEN_TEXT_MAX = 4000;
export const GEN_IMAGE_MIN = 256;
/* H3-Image 能出到 4096（16MP）；Qwen 那侧后端再压回 2048 */
export const GEN_IMAGE_MAX = 4096;
/* 引擎要 32 的倍数，差一个就整条调度错位 */
export const GEN_IMAGE_STEP = 32;
export const GEN_IMAGE_DEFAULT = 1024;
export const GEN_STEPS_MIN = 1;
export const GEN_STEPS_MAX = 100;
export const GEN_STEPS_DEFAULT = 30;
export const GEN_CFG_MIN = 1.0;
export const GEN_CFG_MAX = 20.0;
export const GEN_CFG_DEFAULT = 6.0;
/* 0 = 跟着当前模型走：Qwen 30 步 / cfg 6，H3-Image 6 步 / cfg 1。
   块上没显式设过就是它，面板点「开始」不吃死某一族的默认。 */
export const GEN_STEPS_AUTO = 0;
export const GEN_CFG_AUTO = 0;
/* 视频面板：一块远端出片的取景窗。参数比生图少——时长和画幅就够，
   步数/种子这些本地引擎参数在视频 API 上不存在。 */
export const GEN_VIDEO_MIN_WIDTH = 320;
export const GEN_VIDEO_MIN_HEIGHT = 360;
export const GEN_VIDEO_DEFAULT_WIDTH = GEN_VIDEO_MIN_WIDTH;
export const GEN_VIDEO_DEFAULT_HEIGHT = GEN_VIDEO_MIN_HEIGHT;
export const GEN_VIDEO_SECONDS_DEFAULT = 6;

/* 出图那一档：auto 是「看连线自己定」——没接图就文生图，接一张当底图，接多张当参考。
   明写 t2i / i2i / edit 才能盖掉这个推断（画风锚点那种「只有一张但它是参考图」就得明写）。
   本地高清放大（upscale）已随本地引擎移除，不再是一个可选的档。 */
export const GEN_MODES = ["auto", "t2i", "i2i", "edit", "inpaint"];
export const GEN_MODE_DEFAULT = "auto";
export const GEN_MODE_LABELS = {
  auto: "自动",
  t2i: "文生图",
  i2i: "图生图",
  edit: "参考图编辑",
  inpaint: "局部重绘",
};
/* 图生图改多少：0 原样、1 全改。默认跟上游 sd_img_gen_params_init 的 0.75 一致 */
export const GEN_STRENGTH_MIN = 0;
export const GEN_STRENGTH_MAX = 1;
export const GEN_STRENGTH_DEFAULT = 0.75;
/* 面板上的尺寸：常用比例、手机、电脑、证件照各给几档。
   像素一律取引擎要求的 32 倍数、不超过 2048，所以常见分辨率都取最接近的合法值
   （1080→1088 这种）；证件照给的是比例和出图尺寸，打印前再缩到具体毫米对应像素。 */
/* 每类面板拖角缩放的地板：拉到这里就不动了，免得块缩成看不见内容的一小坨 */
export const AUDIO_MIN_WIDTH = 160;
export const AUDIO_MIN_HEIGHT = 64;
export const FILE_MIN_WIDTH = 160;
export const FILE_MIN_HEIGHT = 56;
export const NOTE_MIN_WIDTH = 160;
export const NOTE_MIN_HEIGHT = 120;
/* 产品/材料卡：一件家具在画布上的名片。户型脚印和清单都指回这一块的字段，
   所以它不是一张普通图片卡——名字、品牌、SKU、规格、单价这些都得能单独改。 */
export const PRODUCT_DEFAULT_WIDTH = 300;
export const PRODUCT_DEFAULT_HEIGHT = 132;
export const PRODUCT_MIN_WIDTH = 220;
export const PRODUCT_MIN_HEIGHT = 96;
/* 清单块：按当前画布里的产品卡自动汇总，自己只记标题和外观 */
export const QUOTE_DEFAULT_WIDTH = 620;
export const QUOTE_DEFAULT_HEIGHT = 320;
export const QUOTE_MIN_WIDTH = 380;
export const QUOTE_MIN_HEIGHT = 160;
/* 户型块：一张户型图 + 真实比例 + 家具脚印 + 面积。
   坐标分三层：图片像素（图片原始尺寸）、毫米（真实世界）、块内像素（显示时按块尺寸拉伸）。 */
export const PLAN_DEFAULT_WIDTH = 820;
export const PLAN_DEFAULT_HEIGHT = 620;
export const PLAN_MIN_WIDTH = 320;
export const PLAN_MIN_HEIGHT = 240;
export const PLAN_MAX_FOOTPRINTS = 400;
export const PLAN_MAX_AREAS = 40;
/* 提案页框：一块就是一张客户要看的页。尺寸按 96dpi 的纸面给，导出时整页抓图 */
export const PAGE_RATIOS = {
  a4: { label: "A4 竖", w: 794, h: 1123 },
  a4l: { label: "A4 横", w: 1123, h: 794 },
  "16:9": { label: "16:9", w: 1280, h: 720 },
  "4:3": { label: "4:3", w: 1024, h: 768 },
};
