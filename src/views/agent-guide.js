/* 给外部 agent 看的速查手册：所有工具怎么配合用、每种块怎么建、坐标和颜色约定、
   常用配方和易错点。guide 工具原样返回这里的 Markdown，按 topic 取单章。
   工具清单和参数仍以 tools/list 为准，这里只讲「怎么用」。 */

const SECTIONS = [
  {
    id: "overview",
    title: "总览与基本约定",
    body: `## 总览与基本约定

无限空间是一个无限画布桌面应用：空间（space）里摆各种块（block），块之间用连线（connector）连起来；另有独立的笔记库（notes），就是磁盘上的 .md 文件树。

### 调用节奏
- 每个工具都接受 pace: "normal"（默认）或 "instant"。normal 会把界面切到对应页面、镜头缓动跟随、目标加一圈光带，给用户看；instant 只改结果、不演示，批量操作时更省时间。
- 用户一碰鼠标或键盘，正在进行的运镜会立刻停下，把画面还给用户，不要和用户抢镜头。
- 空间类工具会先切到空间页、等空间加载完再执行；笔记类工具同理。guide 和 app_state 不切页。
- 工具返回 JSON 文本；出错时 isError 为 true，text 是中文原因，照着改参数重试即可。

### 先看现场再动手
- 动任何块之前先 space_scene 拿 id 和现状；动笔记之前先 notes_tree。
- 块 id 只在当前空间里有效；space_open 换了空间后要重新拿。
- 引用外部 .md 的笔记块，正文不在空间里，读写会自动走原文件。

### 坐标与尺寸
- 世界坐标，单位像素，原点在空间左上角；x 向右、y 向下。
- 普通块用左上角 x,y 加宽高 w,h；线/箭头用起点 x,y 和终点 x2,y2。
- 相机是另一个概念：camera.x/y 是画面平移量，camera.scale 是缩放（0.25 到 4）。换算关系是 屏幕位置 = 世界坐标 × scale + camera 偏移。一般不用手算，用 camera_focus / camera_fit。
- 不给 x,y 时块落在当前视野中央，连续创建会自动错开；批量精确摆放请显式给坐标。

### 颜色与路径
- 颜色用 CSS 色值："#ff8800"、"rgb(255,136,0)"、"red" 都行；空字符串 "" 表示无填充或无边框。
- 便签的底色是 color，字色是 textColor，和普通块的 fillColor 不一样。
- 本机文件（要导入空间的）用绝对路径，例如 C:\\Users\\me\\a.png；笔记库里的路径用相对笔记根、/ 分隔，例如 工作/周报.md（文件带 .md 后缀）。两套路径不能混用。

### 删除的三种去向
- space_delete：整个空间文件夹进系统回收站，可以捞回来。
- block_delete：块和挂在它身上的连线一起消失，不可撤销。
- notes_delete：永久删除笔记或文件夹，不进回收站，最谨慎。`,
  },
  {
    id: "space",
    title: "应用与空间",
    body: `## 应用与空间（9 个工具）

### app_state
一眼看全局，不切页。返回 route（canvas/notes/settings）、dataRoot、notesRoot、theme、mcp 状态、当前空间（id/名字/块数/相机/选中）、当前笔记（根/路径/是否编辑/字数）。新接手先调它。

### theme_list
列出全部主题 [{id,name,mode}]，mode 是 dark 或 light；current 标出当前用的那套。

### theme_set
切换主题：

~~~json
{ "theme": "cosmos" }
~~~

id 从 theme_list 拿。调 "cosmos" 会给空间页打开实时深空背景：三层视差星野、真实银河与星云、带光照和自转的行星（含土星环）、偶发流星；换成别的主题就收起。主题是应用级设置，不影响任何空间数据，也不会自动切页。

### space_list
列出全部空间：[{id,name,path}]，current 标出当前空间。

### space_open
切到某个空间，space 传 id 或名字都行；会等空间读完才返回 {space, blocks}。

~~~json
{ "space": "方案图" }
~~~

### space_create
新建空间并切过去，返回 {id, name, opened}。

~~~json
{ "name": "登录流程" }
~~~

### space_rename
改名，磁盘文件夹跟着改；改的是当前空间时界面会重新加载。

~~~json
{ "space": "登录流程", "name": "登录流程 v2" }
~~~

### space_delete
删除整个空间，文件夹进系统回收站。删的是当前空间时，会自动切到列表里的下一个。

### space_scene
当前空间的全景：space、camera、selected、blocks[]（每块的 id、type、x、y、w、h、z 和类型专属字段）。可选 type 过滤：

~~~json
{ "type": "sticky" }
~~~

返回里的 id 就是后面 block_update / connector_create / 内容工具要的 id。`,
  },
  {
    id: "block",
    title: "块",
    body: `## 块（9 个工具）

块类型：text（画布文字）、rect（矩形）、ellipse（椭圆）、line（线）、arrow（箭头）、sticky（便签）、note（Markdown 笔记卡）、image、audio、video、file（附件/PDF/文本文件卡）、ebook、connector（连线）。

### block_get
单块摘要，不切页之外没有副作用。

### block_create
建一块，type 必填。不给坐标时落在视野中央并自动错开；批量摆放请给 x/y。

文字：

~~~json
{ "type": "text", "text": "标题", "x": 0, "y": 0, "w": 480, "fontSize": 28, "borderColor": "" }
~~~

- w 决定宽度（默认 320），高度随内容自动长；borderColor 传 "" 去掉默认细边框，传颜色才有框。
- color 是字色，fillColor 是底色，radius 是圆角。

矩形 / 椭圆：

~~~json
{ "type": "rect", "x": 0, "y": 100, "w": 240, "h": 120, "fillColor": "#e8f0fe", "borderColor": "#4a78c2", "radius": 12 }
{ "type": "ellipse", "x": 300, "y": 100, "w": 160, "h": 100, "fillColor": "#ffe8cc" }
~~~

radius 只对矩形有效，椭圆没有圆角。

线 / 箭头：

~~~json
{ "type": "arrow", "x": 0, "y": 0, "x2": 240, "y2": 0, "borderColor": "#333333" }
~~~

便签：

~~~json
{ "type": "sticky", "text": "待确认", "x": 0, "y": 300, "color": "#bfa648", "textColor": "#000000", "borderColor": "" }
~~~

color 是便签底色，textColor 是字色；宽高默认 280×280，最小有下限。

笔记卡（两种来源）：

~~~json
{ "type": "note", "markdown": "# 会议记录\\n- 第一项", "name": "会议记录" }
{ "type": "note", "notePath": "工作/周报.md", "name": "周报" }
~~~

markdown 直接给正文；notePath 从笔记库读一篇，正文和图片会拷进空间，之后各改各的。宽高默认 520×420。

图片 / 音频 / 视频 / 附件 / 电子书（按扩展名自动判）：

~~~json
{ "type": "image", "path": "C:\\\\Users\\\\me\\\\shot.png", "mode": "copy" }
{ "type": "file", "path": "C:\\\\Users\\\\me\\\\资料.zip" }
~~~

- mode 默认 copy（拷进空间，原文件删了也不影响）；link 只引用原文件（省空间，但原文件动了块就失效）。
- 这类块也可以直接调 file_import，不用先想类型。

连线也可以用 block_create 建，但更推荐 connector_create：

~~~json
{ "type": "connector", "from": "<块id>", "to": "<块id>", "label": "依赖" }
~~~

### block_update
改一块，只传要改的字段。可改：x、y、w、h、x2、y2、fontSize、radius、borderColor、fillColor、color、textColor、text、markdown、shape、arrow、label、from、to、fromSide。

- 文字块的 w/h 改不了（高度随内容），宽度要在创建时定。
- note 块的 markdown 只适用于空间内的笔记卡；引用外部 .md 的用 note_write。
- 连线的 shape/arrow/label/from/to/fromSide 也可以走 connector_update。

### block_delete
删一块，挂在它身上的连线一起删，不可撤销。

### block_duplicate
复制一块，返回新块摘要（新 id）；媒体文件会真拷副本。dx/dy 默认 24。

### block_select
选中块给人看：

~~~json
{ "ids": ["id1", "id2"], "additive": false }
~~~

只选一条连线也可以；additive 为 true 时加入现有多选。

### block_layer
调层级，direction 是 up / down / top / bottom。连线始终在块下面，不参与层级。

### block_reveal
镜头带到某块；已经在视野里就不动。返回里 moved 表示有没有动镜头。

### block_highlight
只给块加演示光带，不改任何数据；ids 数组，光带亮 1.6 秒左右。`,
  },
  {
    id: "connector",
    title: "连线",
    body: `## 连线（2 个工具）

### connector_create
连两块：

~~~json
{
  "from": "<起点块id>",
  "to": "<终点块id>",
  "fromSide": "auto",
  "shape": "elbow",
  "arrow": "end",
  "label": "依赖"
}
~~~

- fromSide：auto（自动挑边）/ top / right / bottom / left，指从起点块的哪条边出去。
- shape：elbow 折线（默认）/ curve 曲线；arrow：end 箭头（默认）/ none 无箭头 / both 双向。
- color 不传用主题色。
- from 和 to 必须是两个不同的普通块，不能连到另一条连线上。
- 连线自己没坐标，跟随两端块移动；块删了线跟着删。

### connector_update
改一条线：id 加任意字段；from/to 可以改接别的块（端点边自动重算）。

~~~json
{ "id": "<连线id>", "arrow": "both", "label": "双向同步" }
~~~

### 手动折点
折点模式默认关闭。关闭时线按两端块自动走线，拖线身不会产生折点；打开后才能在界面上手动摆折点。

- 界面上：右键连线选「打开折点」；选中后拖线身插入折点、拖折点圈改善走线、双击折点删除；右键「关闭折点」清除全部折点并回到自动走线。
- 数据上：bend: true 表示折点模式打开；points 是世界坐标 {x,y} 数组，线按 from → 折点依次 → to 穿过。最多 40 个。
- connector_update 示例：

~~~json
{ "id": "<连线id>", "bend": true, "points": [{ "x": 420, "y": 260 }, { "x": 420, "y": 480 }] }
~~~

- 传 points: [] 清空折点但保留折点模式；bend: false 连模式一起关闭。connector_create 也能直接带 bend / points。
- 折点固定在世界坐标里：块移动时折点不动，线仍然穿过它们。
- elbow 按折点画圆角折线，curve 过折点做平滑曲线，两头仍沿端口法线出线。`,
  },
  {
    id: "camera",
    title: "相机",
    body: `## 相机（5 个工具）

### camera_get
当前 {x, y, scale}。

### camera_set
直接给定相机：

~~~json
{ "x": 120, "y": 80, "scale": 1.2, "instant": false }
~~~

x/y 是画面平移量，不是「对准哪个世界坐标」；只想让用户看某块时用 camera_focus。

### camera_focus
对准某块，可同时指定缩放（0.25 到 4）：

~~~json
{ "id": "<块id>", "zoom": 1.4 }
~~~

### camera_fit
缩放到刚好装下空间里所有块（四周留 80px），适合收尾或开场。

### camera_reset
回到 100% 缩放，视野中心不动。`,
  },
  {
    id: "content",
    title: "块内内容",
    body: `## 块内内容：便签、笔记卡、文本文件（7 个工具）

### sticky_read
读便签：text、color（底色）、textColor（字色）、borderColor。

### sticky_write
改便签内容或颜色，只传要改的：

~~~json
{ "id": "<便签id>", "text": "新内容", "color": "#ffd166" }
~~~

### note_read
读笔记卡：markdown、name、linked。linked 为 true 表示正文来自空间外的 .md 原文件。

### note_write
整篇覆盖笔记卡正文：

~~~json
{ "id": "<笔记卡id>", "markdown": "# 新正文" }
~~~

引用外部 .md 时直接写回原文件；空间内的笔记卡只改空间里的副本。返回会带回写入后的 markdown。

### file_read
只对「文本文件块」有效（卡片里能直接翻正文的 txt/md/日志等）：

~~~json
{ "id": "<文件块id>", "maxChars": 20000 }
~~~

maxChars 默认 20000，0 表示整份；返回 text、chars、truncated、encoding。

### file_write
整份覆盖文件块的正文：

~~~json
{ "id": "<文件块id>", "text": "新内容" }
~~~

- 拷贝态写空间里的副本，引用态写原文件。
- 原文件在读取后被别的程序改过时会报冲突；先 file_read 看新内容，确认覆盖再带 force: true 调一次。
- 块内编辑框还开着且没处理时也会拒绝，先把那边的保存处理掉。

### file_reveal
在系统文件管理器里定位这块指向的文件。

### file_import
把本机文件放上空间，按扩展名自动选块类型：

~~~json
{ "path": "C:\\\\Users\\\\me\\\\demo.mp4", "mode": "copy", "x": 0, "y": 0 }
~~~

path 必填，绝对路径；mode 默认 copy；as 可强制成 image / audio / video / file / ebook；可以顺手给 borderColor / fillColor。大文件拷贝要等工具返回再继续。`,
  },
  {
    id: "playback",
    title: "阅读与播放",
    body: `## PDF、电子书、音视频（6 个工具）

### pdf_state
PDF 块读到哪：{ready, total, page, frac}。page 从 1 开始，frac 是页内滚动进度 0 到 1。

### pdf_goto
跳页（从 1 开始）：

~~~json
{ "id": "<PDF块id>", "page": 12 }
~~~

PDF 还没读完时会报错，稍等再试。

### ebook_toc
电子书目录：{ready, title, total, chapter, chapters}。chapter 从 0 开始。

### ebook_goto
翻到某一章（从 0 开始）：

~~~json
{ "id": "<电子书块id>", "chapter": 3 }
~~~

### media_state
音频/视频的播放状态：ready、playing、time、duration、volume。

### media_control
控制播放：

~~~json
{ "id": "<音视频块id>", "action": "play" }
~~~

action：play / pause / toggle / seek（value 是目标秒数）/ volume（value 是 0 到 1）。`,
  },
  {
    id: "notes",
    title: "笔记库",
    body: `## 笔记库（13 个工具）

笔记库就是磁盘上的 .md 文件树，路径一律相对笔记根、用 / 分隔；文件路径带 .md 后缀，文件夹不带。

### notes_tree
整棵树：

~~~json
{ "root": "D:\\\\...\\\\notes", "path": "<当前打开>", "tree": [ ... ] }
~~~

每个节点有 path、name、kind（dir/file），文件夹带 children。动笔记前先调它。

### notes_read
读一篇：{path, text, chars}。path 是相对路径，如 工作/周报.md。

### notes_write
整篇覆盖：

~~~json
{ "path": "工作/周报.md", "text": "# 周报\\n..." }
~~~

当前正在编辑器里打开的笔记会走同一条自动保存链，写完界面同步刷新。

### notes_attach_image
把本机图片贴进笔记：

~~~json
{ "path": "C:\\\\Users\\\\me\\\\chart.png", "notePath": "工作/周报.md", "append": true }
~~~

图片会复制到这篇笔记自己的 .assets/<笔记名>/ 下；append 默认 true，在正文末尾补一段图片语法；append: false 只存图不插正文。返回 asset（图片相对路径）和 markdown（插入的那行）。

### notes_create
新建笔记：

~~~json
{ "name": "周报", "dir": "工作", "text": "# 本周" }
~~~

name 不用带 .md；dir 是所在文件夹（相对路径），不传放根目录；text 可带初始正文。

### notes_create_folder
新建文件夹：

~~~json
{ "name": "归档", "dir": "工作" }
~~~

### notes_rename
笔记或文件夹改名（笔记不用带 .md）：

~~~json
{ "path": "工作/周报.md", "name": "周报 2026-10" }
~~~

### notes_move
移到另一个文件夹，dir 为空字符串表示笔记根：

~~~json
{ "path": "工作/周报.md", "dir": "归档" }
~~~

不能把文件夹移进它自己里面。

### notes_delete
永久删除一篇笔记或整个文件夹，不进回收站，最谨慎。

### notes_open
在笔记页打开给人看：

~~~json
{ "path": "工作/周报.md" }
~~~

### notes_current
当前笔记页状态：root、path、editing、chars。

### notes_edit
切阅读/编辑状态：

~~~json
{ "editing": true }
~~~

### notes_reveal
在系统文件管理器里定位笔记或文件夹；path 传空字符串是笔记根。`,
  },
  {
    id: "recipes",
    title: "常用配方",
    body: `## 常用配方

### 1. 从零画一张流程草图
1. space_create {name:"登录流程"}
2. block_create {type:"rect", x:0, y:0, w:240, h:120, fillColor:"#e8f0fe", borderColor:"#4a78c2", radius:12}
3. block_create {type:"text", text:"用户输入", x:24, y:40, w:192, borderColor:""}
4. 再建第二个矩形和文字（x 从 360 起）
5. connector_create {from:"<矩形A>", to:"<矩形B>", label:"提交"}
6. camera_fit {}

### 2. 收尾给用户看
camera_fit {} → block_highlight {ids:["<块id>", ...]} → camera_focus {id:"<重点块>", zoom:1.2}

normal 节奏会自己切页、运镜、打光带，不需要额外做什么。

### 3. 把一篇笔记搬上空间
notes_tree → notes_read {path:"工作/周报.md"} → block_create {type:"note", notePath:"工作/周报.md", x:0, y:0} → camera_focus {id:"<新块id>"}

### 4. 把本机资料放上空间
file_import {path:"C:\\\\Users\\\\me\\\\demo.mp4", mode:"copy", x:0, y:0}

等它返回再继续（大文件要拷一会儿）；返回的 id 可以接着 pdf_goto / ebook_goto / media_control。

### 5. 整理笔记
notes_tree → notes_create_folder {name:"归档", dir:""} → notes_move {path:"旧笔记.md", dir:"归档"} → notes_open {path:"归档/旧笔记.md"}

### 6. 批量建块
先算好网格：列间距 = 块宽 + 40，行间距 = 块高 + 60；逐条 block_create 显式给 x/y；最后 camera_fit。批量时用 pace:"instant" 可以跳过每步的演示节拍。`,
  },
  {
    id: "pitfalls",
    title: "易错点",
    body: `## 易错点

- 忘拿 id：动块前先 space_scene；id 跨空间不通用，space_open 后重新拿。
- 连线两端只能是两个不同的普通块；删块会连删线。
- 便签底色是 color，不是 fillColor；便签没有 fillColor。
- 文字块高度随内容自动长，block_update 改不了 text 的 w/h。
- radius 只对 rect 和 text 有效，ellipse 没有圆角。
- 坐标是世界坐标，不是屏幕坐标；拿不准就 space_scene 看现成的 x/y。
- 批量摆放一定要显式给坐标，不给会落在视野中央一格格错开。
- 本机文件用绝对路径，笔记用相对路径，两者不能混。
- file_write 冲突先 file_read 看新内容，再决定要不要 force；别无脑覆盖。
- PDF 页码从 1 开始，电子书章节从 0 开始；PDF 没读完不能跳页。
- 删除去向：space_delete 进回收站，notes_delete 永久，block_delete 不可撤销。
- 设置页换数据目录和窗口控制没有工具；改主题用 theme_set，先 theme_list 拿 id。
- 文件选择对话框不存在，改为直接传 path。
- pace:"instant" 只跳过演示，不改变结果；默认 normal 更适合让用户看着你干活。`,
  },
];

export const GUIDE_TOPICS = SECTIONS.map((section) => section.id);

/* 不传 topic 给整本（带目录），传了就只给那一章；topic 也认中文标题里的词 */
export function guideText(topic) {
  const key = String(topic || "").trim();
  if (!key) {
    const toc = SECTIONS.map((section) => `- ${section.id}：${section.title}`).join("\n");
    return [
      "# 无限空间 MCP 速查手册",
      "",
      "第一次接手先读「总览与基本约定」；下面每章也可以单独取：guide {topic:\"章节名\"}。",
      "",
      toc,
      ...SECTIONS.map((section) => `\n---\n\n${section.body}`),
    ].join("\n");
  }
  const lower = key.toLowerCase();
  const hit = SECTIONS.find((section) => section.id === lower || section.title.includes(key));
  if (!hit) {
    throw new Error(`没有「${key}」这一章；可用：${GUIDE_TOPICS.join("、")}`);
  }
  return hit.body;
}
