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
- block_delete：块和挂在它身上的连线一起消失。界面里有撤销（Ctrl+Z，最多 80 步），盘上还有每 90 秒一份的自动快照，所以不是绝路——但别指望用户一定知道要撤，删之前先问一句。
- notes_delete：永久删除笔记或文件夹，不进回收站，最谨慎。`,
  },
  {
    id: "space",
    title: "应用与空间",
    body: `## 应用与空间（11 个工具）

### app_state
一眼看全局，不切页。返回 route（canvas/notes/settings）、dataRoot、notesRoot、theme、mcp 状态、当前空间（id/名字/块数/相机/选中）、当前笔记（根/路径/是否编辑/字数）。新接手先调它。

### theme_list
列出全部主题 [{id,name,mode}]，mode 是 dark 或 light；current 标出当前用的那套。

### theme_set
切换主题：

~~~json
{ "theme": "cosmos" }
~~~

id 从 theme_list 拿。调 "cosmos" 会给空间页打开一条自动飞行的深空航线：镜头一直往前飞，好几分钟才遇到一颗——远处先是一枚会眨的亮星，越飞越大才显出球体，追上一颗就贴着它慢飞两三圈看表面，看完顺切线方向接着走；镜头里同时只画一颗星体。星野钉在天球方向上，镜头一转就换一片星空。飞行层的细节看「宇宙飞行」那一章。主题是应用级设置，不影响任何空间数据，也不会自动切页。

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

返回里的 id 就是后面 block_update / connector_create / 内容工具要的 id。

### space_snapshot
**你的眼睛。** 返回一张 PNG 图片（真的图片，不是坐标），你能直接看到画布现在长什么样。

~~~json
{ "region": "all" }
{ "region": "viewport" }
{ "rect": { "x": 0, "y": 0, "w": 900, "h": 600 }, "maxSide": 2000 }
~~~

region 三选一：all 整张画布（默认，看整体构图）、viewport 用户此刻看到的这一屏（凑近看细节）、rect 自定义世界坐标矩形。maxSide 是长边像素上限，默认 1600，范围 320–2400。

**为什么它重要**：space_scene 给的是数字，你要靠心算判断「这两块会不会重叠」「这段文字会不会溢出边框」——很容易翻车。铺完东西调一次 snapshot，直接看结果再改，质量差一个数量级。返回的文字里带 region，可以按它把图上的像素位置换算回世界坐标。

建议节奏：铺一批 → snapshot 看一眼 → 改有问题的几块。不要每建一块就看一次，太费。

### space_batch
一次提交一串操作，**整批算一步撤销**，而且期间不运镜、不打光带，只在最后把整批框进视野。

~~~json
{ "operations": [
  { "tool": "block_create", "args": { "type": "text", "x": 0, "y": 0, "text": "第一章" } },
  { "tool": "block_create", "args": { "type": "sticky", "x": 0, "y": 80, "text": "要点的内容" } },
  { "tool": "connector_create", "args": { "from": "<上一个返回的 id>", "to": "<再上一个>" } }
] }
~~~

规则：
- 最多 200 项；按顺序执行；某一项失败不中断后面的，返回里逐项标 ok，失败的带 error。
- stopOnError: true 可以遇到失败就停。
- 只收画布上的块操作（block_* / connector_* / sticky_* / note_read / note_write / file_import / pdf_goto / ebook_goto / camera_*）。切空间、换主题、笔记树的增删不能混进来——那会把「一次撤销全退」这个承诺破功。
- 批量里拿不到前一项的返回值去当参数：id 是执行时才生成的。要连线就先批量建块、拿到返回的 id，再单独调 connector_create 或第二个批次。

**什么时候该用**：铺一整块区域、批量改颜色、连着建十几块再连起来。一个一个调不但慢，撤销栈还会被切成一堆碎片，用户想退回原样得按几十次 Ctrl+Z。`,
  },
  {
    id: "flight",
    title: "宇宙飞行",
    body: `## 宇宙飞行（4 个工具）

宇宙主题的背景是一条自动航线，不需要你驱动：镜头一直往前飞，好几分钟才遇到一颗——远处先是一枚会眨的亮星，越飞越大才显出球体，追上以后绕几圈看表面，看完顺切线方向启程。地球特殊，绕四圈：头两圈退在 1.65 倍半径把整颗球、大气边和昼夜线看全，之后慢慢降到 1.3 倍掠地表。镜头里同时只画一颗星体，星体自己不自转，全靠镜头绕飞换面。这几个工具只调节奏、目的地和名单。

### flight_state
看现在飞到哪了：phase（cruise 巡航 / approach 逼近 / orbit 绕飞观察 / depart 启程）、paused、speed、travelled（累计航程）、pitch（视线仰角，正=抬头）、focus（当前目标星体，绕飞时带 lap/laps 圈数、radius 当前半径、target 这一段要收到的半径、remaining 剩余秒数——地球的 target 会在两圈后掉一档）、ahead[]（前方星体：id、type、name 中文名、distance、radius、visited）、textures（hi = 本机就位几张 8K，resident = 此刻进显存的贴图名，空数组说明正用内置 2K）。

不知道有什么可飞就先调它，goto 要的 id 从 ahead 里拿。不在宇宙主题时它会自动切过去。

### flight_control
~~~json
{ "action": "goto", "type": "saturn" }
~~~

- pause：停住，方便看清当前这颗。
- resume：接着飞。
- skip：正在绕飞就结束这一圈立刻启程；在巡航/逼近就把当前目标划掉换下一颗。
- goto：追某一颗，带 body（ahead 里的 id）或 type（earth/moon/mars/jupiter/saturn）；type 找不到就现生成一颗摆在正前方。goto 会顺带 resume。**goto 只是改目的地，镜头照旧按 150/秒 赶过去，追上要几分钟。**
- warp：直接挪到某一颗旁边，省掉赶路。同样带 body 或 type，可选 distance（落点距星心多少倍星体半径，默认 2.5）。落点沿「星→镜头」这条射线，所以看到的还是刚才那一面；落地后仍旧自然走「逼近→进轨→绕飞」，一两秒就开始绕。要看某颗星的脸就用它，别用 goto 干等。

~~~json
{ "action": "warp", "type": "earth", "distance": 6 }
~~~

~~~json
{ "action": "skip" }
~~~

航线的走法不接受外部驱动：goto / warp 之外没有任何「往左飞」「加速」的工具，用户在工作区平移/缩放只是小幅转头和长焦，不会改航线。别为了「飞到某处」去动相机工具，那只会改变镜头偏角。能改的只有下一颗是什么、隔多久遇到——见 cosmos_route。

### cosmos_route
读或改航线名单与节奏，不带参数就是读：

~~~json
{ "order": ["saturn", "earth", "moon"], "minutes": 6 }
~~~

- order：星体类型按遇到先后排，走完一轮从头再开始，像一张歌单。至少一颗，认不出的类型丢掉。
- minutes：两颗星之间隔几分钟（1-10，默认 3，四舍五入到整分钟）。它只改赶路时长，绕飞那几圈的时间尺度是固定的。

改名单不打断正在绕飞的这颗：只把前方还是亮点的几颗按新名单换成对应类型，已经追上或已看过的不动。所以改完不会看见一颗星球当场换脸换大小。这是偏好设置，不是飞行指令，所以不在宇宙主题时也不会替你切主题——名单照样存下，用户切过去就按这条飞。用户在 设置 › 遨游星球 里能看到并改同一份值，改错了别去磁盘上找，那是存在应用里的。

### cosmos_textures
星体表面内置是 2K 贴图，飞近了会糊；同一套贴图的 8K 版是 7 张，用户手动升级后存在数据文件夹的 cosmos/8k/，离线照用。

- status：档位、目录、已就位几张/共几张、总字节、running 有没有活在跑。
- upgrade：启动后台下载缺的那几张（已下好的跳过），**立刻返回**，不等收尾——整包约 35MB，慢链路要几分钟。返回里带 note 告诉你怎么跟进：隔 30 秒调一次 status 看 got 涨到 7/7 就完事，中间别重复 upgrade。
- cancel：停掉当前下载，已下好的留着。
- reset：把 8K 清进系统回收站，回到内置 2K。

不升级完全不影响飞行，所以别主动 upgrade——先问用户，他点了设置里那个按钮或明确同意之后再调。8K 只给镜头里当前这颗驻留，换星体就释放。`,
  },
  {
    id: "block",
    title: "块",
    body: `## 块（9 个工具）

块类型：text（画布文字）、rect（矩形）、ellipse（椭圆）、line（线）、arrow（箭头）、sticky（便签）、note（Markdown 笔记卡）、image、audio、video、file（附件/PDF/文本文件卡）、ebook、connector（连线）、picture（矢量画面，见「画面块」一章）、scene（真 3D 场景，字段见 block_create / block_update 的 parts / camera / light）、gen（生图面板，见「生图面板」一章）。

### block_get
单块摘要，不切页之外没有副作用。

### block_create
建一块，type 必填。不给坐标时落在视野中央并自动错开；批量摆放请给 x/y。

文字：

~~~json
{ "type": "text", "text": "标题", "x": 0, "y": 0, "w": 480, "fontSize": 28, "borderColor": "" }
~~~

- w 决定宽度（默认 320），高度随内容自动长；borderColor 传 "" 去掉默认细边框，传颜色才有框。
- color 是字色，fillColor 是底色；borderWidth 是边框宽度（px），radius 是圆角。

矩形 / 椭圆：

~~~json
{ "type": "rect", "x": 0, "y": 100, "w": 240, "h": 120, "fillColor": "#e8f0fe", "borderColor": "#4a78c2", "radius": 12 }
{ "type": "ellipse", "x": 300, "y": 100, "w": 160, "h": 100, "fillColor": "#ffe8cc" }
~~~

边框这组（borderColor / borderWidth / radius）所有带边框的块都认：矩形/椭圆/文字/图片默认 2px 宽，便签/笔记/文件默认 1px；圆角默认 10px（矩形默认 0），椭圆没有圆角；宽度 0 就是无边框。
locked 传 true 建好就锁住（所有块类型都认，连线除外）：锁住的块不能移动、缩放、改内容、删除。

线 / 箭头：

~~~json
{ "type": "arrow", "x": 0, "y": 0, "x2": 240, "y2": 0, "borderColor": "#333333" }
~~~

便签：

~~~json
{ "type": "sticky", "text": "待确认", "x": 0, "y": 300, "color": "#bfa648", "textColor": "#000000", "borderColor": "" }
~~~

color 是便签底色，textColor 是字色；宽高默认 280×280，最小有下限。边框同样认 borderColor / borderWidth / radius。

笔记卡（两种来源）：

~~~json
{ "type": "note", "markdown": "# 会议记录\\n- 第一项", "name": "会议记录" }
{ "type": "note", "notePath": "工作/周报.md", "name": "周报" }
~~~

markdown 直接给正文；notePath 从笔记库读一篇，正文和图片会拷进空间，之后各改各的。宽高默认 520×420。边框同样认 borderColor / borderWidth / radius。

图片 / 音频 / 视频 / 附件 / 电子书（按扩展名自动判）：

~~~json
{ "type": "image", "path": "C:\\\\Users\\\\me\\\\shot.png", "mode": "copy" }
{ "type": "file", "path": "C:\\\\Users\\\\me\\\\资料.zip" }
~~~

- mode 默认 copy（拷进空间，原文件删了也不影响）；link 只引用原文件（省空间，但原文件动了块就失效）。
- 图片和附件认 borderColor / borderWidth / radius；音视频和电子书没有边框外观。
- 这类块也可以直接调 file_import，不用先想类型。

连线也可以用 block_create 建，但更推荐 connector_create：

~~~json
{ "type": "connector", "from": "<块id>", "to": "<块id>", "label": "依赖" }
~~~

### block_update
改一块，只传要改的字段。可改：x、y、w、h、x2、y2、fontSize、radius、borderWidth、locked、borderColor、fillColor、color、textColor、text、markdown、shape、arrow、label、from、to、fromSide。

- locked 是块的锁：锁住的块不能移动、缩放、改内容、删除，改其他字段会报错；解锁传 locked:false（可以在同一次调用里带上其他改动）。
- 文字块的 w/h 改不了（高度随内容），宽度要在创建时定。
- borderWidth/radius 所有带边框的块都能改（椭圆只有宽度），连线没有这组字段。
- note 块的 markdown 只适用于空间内的笔记卡；引用外部 .md 的用 note_write。
- 连线的 shape/arrow/label/from/to/fromSide 也可以走 connector_update。

### block_delete
删一块，挂在它身上的连线一起删，不可撤销。锁住的块删不掉，先 block_update 解锁。

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
    id: "picture",
    title: "画面块",
    body: `## 画面块：往一块画面上画矢量图形（5 个工具）

### 先建块
block_create {type:"picture", x, y, w, h, paperColor}。paperColor 是画纸底色，如 #f5efdf，不给就是透明。
建块这一口也能直接带 cmds 和 symbols，一次把素材和第一层都落下去。

### picture_draw
往块里画指令。mode 三种：
- replace（默认）整幅换掉
- append 追加
- delete 按 ids 删掉那几条，ids 是 picture_get 里的 i

每条指令 {op, ...}，op 八种：
- rect   {x,y,w,h,fill,stroke,strokeWidth,radius,opacity}
- poly   {points,fill,stroke,strokeWidth,opacity} 闭合多边形
- line   {points,stroke,strokeWidth,cap,opacity} 折线；close:true 等价于 poly
- stroke {points,color,size,kind,grain,opacity} 一笔墨迹：points 是这一笔的点串，每个点还能带 w（那一点的笔宽）；
  kind=pen 一路等宽，kind=brush 按每点的 w 提按，粗细过渡是填色轮廓，不是恒定描边；grain 是枯笔，见下面「枯笔」
- text   {x,y,text,size,color,weight,font,rotate,opacity}；font 用 cjk 走系统中文黑体，题字靠它
- group  {x,y,rotate,scale,cmds} 整组变换，想嵌几层都行
- use    {ref,x,y,rotate,scale,variant,hide,opacity} 摆一份已定义的素材
- image  {src|path,x,y,w,h,fit,rotate,opacity} 垫一张位图当底，见下面「垫一张参考图描」

任何一种指令还都能多带 name:"图层名" / variants:["站","坐"] 两个字段——素材里靠它给 use 的 hide / variant 挑，块顶层靠它分层，见下面「素材」和「图层」；
再加 filter / blend 两个字段管柔边、调色和叠色，见下面「柔边与叠色」；
再加 clip / mask 两个字段管裁剪和渐隐，见下面「剪刀与遮罩」。

fill 和 stroke 都可以是颜色串、渐变对象或图案对象；rect / poly / line 三种都吃这三样。

### 渐变：一片天、一段水
{type:"linear", x1,y1,x2,y2, stops:[{at,color},...]} 或 {type:"radial", cx,cy,r, stops:[...]}。
stops 至少两个色标，at 是 0~1 的位置（乱序会替你排好）。
坐标默认按这一块形状自己的包围盒比例：0~1 之间取值，x1:0,y1:0 → x2:0,y2:1 就是自上而下。
要拿块内画面像素定一条贯穿整幅的渐变（比如一片天跨着几个形状连续过渡），加 units:"user"，
这时 x1/y1/x2/y2（radial 是 cx/cy/r）必须全写成像素数，少一个整条丢掉。
例：{op:"rect", x:0,y:0,w:1600,h:420, fill:{type:"linear",y2:1,stops:[{at:0,color:"#cfe0ea"},{at:1,color:"#f6efdf"}]}}

### 图案：一片瓦、一地麻点
{pattern:"hatch"|"grid"|"dots", gap, angle, color, width, background}——gap 是间距（块内画面像素），
angle 是整套纹样的转角，width 是线宽（dots 里是点直径）。往 poly / rect 的 fill 上一放就铺满，
不用自己算几十条平行线。
{pattern:"tile", ref:素材名, dx, dy, angle, background} 拿一个素材当平铺单元，dx/dy 不给就取素材声明的 w/h，
两个都没有整条漆丢掉。屋顶、地砖、编木桥的格栅靠它。
background 是这一格先铺的一层底色，纹样再压上去——瓦缝里的木色、布纹里的布本靠它，
不必把同一条形状画两遍（一遍底色一遍纹样）。底色和纹样都是漆，打光时一起跟着明暗走。
tile 的那一格是硬裁的：素材的几何超出 dx/dy 那一格就被剪掉，落点 ox/oy 一挪整条纹样就推出格子、
看着像只剩几个点。平铺单元的素材写 ox:0,oy:0，尺寸照 dx/dy 对齐。
例：{op:"poly", fill:{pattern:"hatch",gap:7,angle:38,color:"#6f6250",width:1.2,background:"#8a6a4a"}, points:[...]}

### 曲线：poly / line 的点带控制点
每个点可以多写 c1、c2 两个控制点（{x,y} 或 [x,y]），这一段就渲染成三次贝塞尔；没带控制点的段还是直线。
控制点是「进入这一点」的那两根把手，所以闭合形的最后一条边回到 points[0] 用的是 points[0] 自己的 c1/c2。
只写 c1 不写 c2 会拿 c1 顶两个用，不会报错。stroke（一笔墨迹）不吃控制点：手绘的点串本来就密，
要精确曲线就改写成 poly / line，这也是「洗画」该走的方向。
例：{op:"poly", fill:"#8a9a7b", points:[{x:100,y:300},{x:260,y:210,c1:{x:180,y:300},c2:{x:200,y:210}},{x:420,y:300}]}

### 枯笔：一笔散成几根丝
stroke 可以多带一个 grain（0~1；不写就是 0，实墨一杆，画面上和过去一模一样）。
笔上墨少了，笔幅两侧先咬空、中间只剩一道，沿线撕开白缝、末端散成几叉——grain 干的就是这件事：
把这一笔拆成 1~5 根各自长短不齐、各带几处断口的细带。0.4~0.7 是最常用的枯，0.9 往上只剩几根丝。
pen、brush 都能起枯；brush 的提按（每点的 w）跟着丝一起走，粗段丝宽、细段丝窄。
股数、每根偏哪儿、从哪断开，全由这条点串自己算出来——同一份数据永远画成同一笔，
重开、第二次重画、导出都不会变成另一笔。想换个枯法就改点，别指望重发一次碰运气。
丝只在这一笔自己的宽度里散，不越界：橡皮擦到的还是原来那一笔，而且一擦就带走整条，不是一根根丝。
点太少（一个点是戳一下）拆不出丝，那就照实墨画，不会画成一片空。
poly / line 不吃 grain——它们是形，不是「一笔」；用户手绘的笔迹这一轮也还是实墨，工具条没加枯笔档。
想要飞白别拿十几条细 line 自己拼：那不是同一笔，也擦不干净。
例：{op:"stroke",kind:"brush",size:9,grain:0.6,color:"#2b2b2b",points:[...]}

### 素材：同一个东西摆一百份
人、船、树、瓦这些要重复摆的，定义一次、摆无数次：一条 use 顶一整个素材，
浏览器只画一份几何，剩下的全是它的影子。别再重算同一段几何三十遍——几百个小人会把条数和帧率一起顶穿。

picture_draw 带 symbols 就是并表：{"名字":{cmds:[...],ox,oy,w,h}}，同一个请求里的 cmds 立刻认得新名字，
不用分两次发。名字 1~32 个字，自己起。ox/oy 是落点（use 的 x,y 就对准它，默认 0,0），
w/h 只有拿它当 tile 平铺单元时才非要不可。素材内部不能再嵌 use，也不能再点别的素材当剪刀。
要删一个素材就把它的值写成 null。还有指令在用它就不让删（use 摆的、tile 平铺铺的、拿它当剪刀 clip / mask 的 ref 都算），
报有几处在用——先按号 delete 掉那些指令，再删素材：剪刀的素材一删，被它遮住的那片画会凭空露出来。
append 同理：这一批要把已有哪条指令洗掉了，整笔直接报错回你，
不会悄悄少画一片；真想整幅重来就明说 mode:"replace"。

{op:"use", ref:"人A", x:820, y:640, rotate:8, scale:1.2} 摆一份。同一份素材要长得不一样，
给素材里要单独开关的那几笔起 name 当图层（几种 op 都行，几笔要一起开关就包一层 group 起名）：
- hide:["旗子"] 关掉那一层，其余照画；
- 图层标 variants:["站","坐"]，use 给 variant:"坐" 就只画标了「坐」的那些层 + 没标变体的层。
  标了 variants 的层是「某一副样子才出现的那一笔」：use 不挑（不写 variant）时它不画，只剩没标的常驻笔。
  所以一副样子都别标的东西（身体、头）就别写 variants，写了它反而消失。块顶层没有变体开关，顶层那条上写 variants 没有意义（照画）。
名字写错是致命的：ref 点不着名、variant / hide 里写出素材没有的名字、tile 漆或剪刀点了不存在的素材——
这几种只要错一个，这一笔请求整个失败，报错里把这块现有的素材名 / 层名 / 变体名一起列回来。
别学旧行为「少几条也当画完了」：一个变体名拼错能悄悄抹掉一片小人。

例：symbols:{"人A":{ox:0,oy:34,cmds:[
  {op:"line",stroke:"#3a2f26",strokeWidth:2,points:[{x:0,y:12},{x:0,y:30}]},
  {op:"rect",name:"头",x:-4,y:0,w:8,h:8,radius:4,fill:"#3a2f26"},
  {op:"group",name:"担",variants:["挑"],cmds:[{op:"line",stroke:"#6b4d2e",strokeWidth:2,points:[{x:-12,y:8},{x:12,y:8}]}]}
]}, cmds:[{op:"use",ref:"人A",x:300,y:520},{op:"use",ref:"人A",x:340,y:524,variant:"挑"},{op:"use",ref:"人A",x:380,y:520,hide:["头"]}]

### 柔边与叠色：滤镜和混合模式
剪影画和有氛围的画，分界就在这两个字段上。任何一条指令（任何一种 op）都能带。

filter 两族，写成对象是一条、写成数组是好几条按序串起来（{type:"gray",k:1} 那种也一样）。

化开那一族，r 是半径（块内画面像素，0.5~200，跟着块缩放一起缩放，所以同一个素材摆远摆近不用改它）：
- {type:"blur", r} 化开边缘：远景的山、水面的汽、焦外的东西。近景别用，用了看着像没对焦。
- {type:"shadow", dx, dy, r, color, h} 落在纸上的投影：dx/dy 是投影偏的方向（光在左上就往右下偏），color 不给是半透的黑。
  船和桥要「压在水面上」靠它，不是靠再叠一层深色。
  写了 h（这东西在画里立起多高，块内画面像素）就是另一件事了：它不是把剪影挪一份，而是从这条指令的脚底
  拖出一片真正的落影——影长 = h / tan(太阳高度)，方向跟着块上那套光倒向背光，太阳压得越低影子越长。
  街面上斜长的那种影子只有这条能给，别手搓一条渐淡的多边形当影子。
  三个要点：一，前提是这块打了光（picture_light），没光就没有影子的方向，一片都不画；
  二，边是硬的（r 不给就是 0），要羽化再自己写 r——写了 r 才占一次离屏合成，不写不占，所以一条街几十个都挂得起；
     往末梢那一段淡掉是自带的，不用你再叠一层渐变去装；
  三，h 别照抄画面上看到的高度：散点俯视里那条立面已经把俯视压掉的比例算进去了，一般给它的一半上下，
  先给短了再往上加，一给满就成了盖住半条街的糊。
  明确写了 dx / dy 的那一头照旧一个字不动：h 不替你已经定好的影子重算方向。
- {type:"glow", r, color} 自己发亮：color 不给是暖黄，正好是灯笼和火把的颜色。夜里几点 glow 落在暗面上就是氛围。

调色那一族，k 是倍数（1 就是原样，不给就是 1）：
- {type:"gray", k} 去色，k=1 彻底灰掉——垫的参考图先灰掉，才看得出你自己上的颜色。
- {type:"bright", k} 提亮 / 压暗，k=1.3 亮三成。
- {type:"contrast", k} 加对比，参考图去色后会发平，配 k:1.3~1.6 才还剩线条。

blend 和已经画在它下面的内容叠色：multiply 叠墨（淡彩一层层压深，比调 opacity 更像宣纸吃墨）、screen 叠光、
overlay / soft-light 压明暗、hue / saturation / color / luminosity 只借一样。不写就是正常盖上去。
叠色只在这块画面自己的内容里发生，不会把画纸底色和块外的东西一起搅黑。

两条省着用的规矩：一条 css 滤镜（blur / 没写 h 的 shadow / glow）是一次离屏合成，整幅每条都挂会掉帧——按「远 / 中 / 近」分层给 blur 就够，别按「每个形状」给；写了 h 的那片落影是个多边形，不占合成，挂得起一条街。
滤镜不改几何，橡皮还是按原来的形状碰到才算擦到（影子那一片擦不到，它是这条指令的一部分）。
例：{op:"poly", fill:"#9fb3c8", filter:{type:"blur",r:6}, points:[...]} 是远山；
{op:"use", ref:"人A", x:300, y:520, filter:{type:"shadow",h:16}} 是小人落地，还拖出一道跟着太阳走的斜长影；
一排小人要一起挂影子就包一层 group、把 filter 写在 group 上，组里每一笔各挤自己那一片（别拿整组的外接框挤成一整条街的糊）；
素材算一笔——摆在带影子的组里的一份 use 只按整个素材的外接框挤一片，不会素材里每一笔各拖一道；
只要一小层贴地淡影就写 {type:"shadow",dx:2,dy:3,r:2}。

### 剪刀与遮罩：clip / mask
一条指令可以自带一块裁剪。clip 是硬边剪刀——形状里面才画得出来；mask 是软边——拿形状的明度当透明度。
和 filter / blend 一样写在条上，任何一种 op 都能带。

剪刀只认闭合的面，写法三种：
- {op:"rect", x,y,w,h,radius} 一扇方窗；radius 给到 w / h 的一半就是一把圆剪刀
- {op:"poly"|"line", points} 点串围出的面，点还能带 c1 / c2 让边是曲线；line 当剪刀时自动首尾相连，strokeWidth 不参与
- {ref:"素材名", x,y,rotate,scale} 拿一份现成素材当剪刀——一百个窗共用一把，几何只算一次，别给每扇窗各算一遍
两个点围不出面、宽或高是 0 的方窗剪不出形，这两种当场报错回你：那种结果看着像「画丢了」，不像剪刀失效。
素材内部不能再点素材当剪刀（套下去没完）；素材里能参与裁剪的几何是 rect / poly / line / stroke / group，
image 和 use 当不了剪刀。文字也当不了剪刀——svg 认 <text> 当裁剪形，但字体缺失时剪出来的和看见的不是一回事。

剪刀的坐标是块内画面像素，和这条指令自己在同一套坐标系里。但 group / use 自带的位移和旋转不带着剪刀一起动：
{op:"use", ref:"窗", x:600, y:240, rotate:30, clip:{op:"rect",x:580,y:220,w:40,h:60}} 转的是窗里的纸，窗洞还在那面墙上。
裁剪永远再和这块的画框相交一次，越不出块。剪掉的那部分看不见，橡皮也擦不到——看不见又擦得着的东西最难伺候。
剪刀剪不出任何形状（ref 那份素材里没有面）就不挂剪刀，画面照出：宁可不剪，也不悄悄把这条抹平。

mask 比 clip 多一层「拿什么当透明度」：fill 白=留着、黑=没了，不给是纯白（那就是一把还能羽化的硬边）。
fill 写成渐变就是渐隐，这是 mask 最要紧的用处——山脚化进雾里、水天相接处淡掉、近处的一层墨压过去，靠的都是它：
{op:"rect",x:0,y:200,w:1600,h:400,fill:"#7f8f7a",mask:{op:"rect",x:0,y:200,w:1600,h:400,fill:{type:"linear",y2:1,stops:[{at:0,color:"#fff"},{at:1,color:"#000"}]},soft:8}}
遮罩的生效区域按整块画区算（不锁就只覆盖被遮元素自己那一小块，一条长渐变会被齐根截断）。
soft 0~200 是边缘羽化的半径（块内画面像素）；一条遮罩是一次离屏合成，和滤镜一样别每条都挂。
mask 不参与橡皮判定——渐变没有硬边界，「擦得到」的界在这儿划不出来。

### 垫一张参考图描
照着已有的画（扫描件、照片、别人的一张图、你自己先前那幅）时，把那张位图垫在画面最底下当底，
上面照样用矢量指令画——它和别的指令一样是一条指令，橡皮擦得到、picture_get 看得见、按号 delete 也删得掉。

发法就一行：{op:"image", path:"C:\\某处\\参考图.png", x:0, y:0}。
应用会把它拷进这个空间的 images/ 下、把回填好的 src 存下来，并照原图量出 w / h 填进框，你不用先知道它多大。
已经在这块画面里垫过的图（比如 picture_get 读回来的 src），第二次直接写 src 就行；
不想拷、就想引用本机原图，把绝对路径写进 src（这两种写法不混：src 只认 images/xxx.png 或本机绝对路径）。
联网地址和 data: 内联一律不认——这应用要离线也画得出来，一串 base64 还会把 pictures/<块id>.json 撑爆。

框和图片比例不一样时默认等比缩到整张都在框内、居中留边（fit:"meet"）；要硬拉铺满框就 fit:"fill"，会变形。
rotate 绕的是这张图自己的框中心，不是块的左上角。

垫完就压淡，别让它跟你上的颜色抢：
{op:"image", path:"C:\\扫描\\城楼.png", x:0, y:0, opacity:0.35, filter:[{type:"gray"},{type:"contrast",k:1.4}]}
opacity 压到 0.3 上下、去色、再加一点对比，剩下的线够你描，又不会盖住你画的东西。
描完记得按号 delete 掉这条 image——它留在文件里就还是这张块的一部分。

两个坑：src 是 images/ 下那份副本，删掉同名的独立图片块会把文件一起删了，画面里这条就只剩一个虚线占位框；
复制这块（Ctrl+V、block_duplicate，包括给 space 复制到别的空间）会连垫图一起真再拷一份副本进目标空间，
引用本机绝对路径的那种也顺手收进来变成副本，所以换空间不用管图——只有原文件已经不在的那几张拷不动，
块照样粘过去，那几条就是虚线框。两种都画成同框的虚线框，位置和尺寸还在，看得见「这儿本来有张图」而不是凭空少一块。

### 图层：一幅画分成几摊管
一幅有内容的画动辄上千条指令。给指令起同一个 name，它们就是一层：

{op:"rect", name:"远景", ...}、{op:"use", name:"人", ...}，几笔要一起开关就包一层 group 起同名
（{op:"group", name:"城楼", cmds:[...二十条...]} 一层就是一条指令，开关、删除、橡皮都按这一整条算）。

组里面单独起了名的那几笔，本身也算一层：hide:["旗子"] 只从组里摘掉那一笔，组照画，
清单和报错里报的层名包含这些「组里的层」——名字关得动就一定列得出。

开关用 picture_layers：{id, hide:["远景"]} 关掉、{id, show:["远景"]} 打开，不带 hide / show 就是问一句「这块有哪些层」。
picture_draw 也能带 hidden:["远景","中景"] 整幅替换这份开关，但那是重发指令的路子，只动开关别用它。

关掉的层是真不画：截图、导出里都没有那一片，不是画成透明。橡皮也擦不到它——看不见又能擦掉，等于埋了个坑。
数据一条不动：指令还在文件里，条数和展开额度也照样占着（一开关就冒「超上限」或者少一批画，那是把画丢了），
picture_get 的 drawn 是真画出来的条数，和 cmds 的条数可以不一样。

分层是给「改一处不用翻全表」用的，不是 z 轴：谁压着谁还是由指令在数组里的先后决定，这轮没有整层置顶 / 置底。
要挪一层的画法，就 picture_layers 只看那一层有几条、picture_get 按号找出那几条、mode:"delete" 删掉再 append 改好的。

### 光：一幅画一套光
逼真不逼真是明暗关系说了算，所以光不是每条指令自己声明颜色，而是块上挂一套光、每条指令只声明「我这个面朝向哪」。

块上：picture_light {id, angle:315} —— angle 是光从哪个方位来（0 正上方、顺时针数、315 就是左上方），
可选 elev（光源抬高 0~90，默认 45）、lit / dark（受光端 / 背光端往哪个颜色拉，默认暖 #fff4de 和冷 #2f3a52）、
k（强度 0~1，默认 0.3，留一份固有色在）。关掉写 off:true。
k 别一上来就拉满：明暗是把固有色往 lit / dark 两端拉，吃到一半的那类面（朝天的屋顶、脚下地面）在 k 大时
算出来就是 (光色+影色)/2 —— 颜色被吃干，整幅像蒙了张灰纸。0.3 是「看得出朝向差、颜色还是自己的」那一档，要浓再往 0.5 走。

指令上：{op:"rect", face:"left", ...}，六个词 up / down / left / right / front / back。
front 正对观者、back 背对观者——这两个分量用一个角度数字表达不了，所以存的就是词。
斜射不用你算：吃到多少光由光的方位角和这个朝向的夹角算出来（夹角 90° 以上就不受光）。

三条规矩：
1. 指令里存的颜色永远是固有色。picture_get 回读到的颜色和截图上看见的不一样，那不是画丢了，是光在渲染时现算的。
   改一次光，整幅跟着变，一条指令都不用重写——这也是为什么不能把明暗烘进 stops 存起来。
2. 没写 face 的笔不吃光，保持固有色。所以光是逐步加上去的：先给该受光的那几组写 face。
   一块里一条 face 都没有，打光就没有任何效果，picture_light 的返回会用 faced 告诉你有几条吃了光、并提示你。
3. 朝向是从上往下继承的：一整面墙包一层 group 写一次 face:"right" 就够，组里没自己写的每一笔都跟着这个面。
   use 写的朝向传给素材里每一笔——同一份瓦摆在朝左的坡和朝右的墙上会各自变色，不用复制素材。

吃光的只有漆：fill（颜色、渐变的每一档、图案漆那根线连同它的 background）。
不吃光的：墨——描边 stroke、一条 line 的线、毛笔一笔、题字的字；op:"image" 垫的位图（要它跟着明暗就挂 {type:"bright",k:0.8}）；
遮罩里的黑白（那是透明度，不是颜色）。
这条是拿画面换来的：一笔墨是贴在面上的黑，不是一个受光的立面。让墨跟着吃光，k 一大素材里那些黑线一起被提亮，
几十个小人糊成纸片白，颜色再准也白搭。要某一笔「亮起来」，它是漆，就写成 fill。
顺带一条：投影 filter 不写 dx / dy 时，影子跟着这块的光倒向背光那边（不写 h 就短到和 r 一个量级，光抬得越高越短）；
写了 h 才有长影（影长 = h / tan(太阳高度)，从这条指令的脚底拖出一片，不是挪一份剪影，而且要有光才画得出来）；
写了 dx / dy 就照你写的来，改光也不动它。想自己定方向就写全。

### picture_get
读全部指令（带号 i）、这块的包围盒 frame、素材表 symbols、展开后的节点数 expanded，另外给 hidden（关着哪几层）、
layers（有哪几层、各几条）、drawn（真画出来几条）、light（这块的一套光，没打光是 null）和 faced（有几条声明了 face）。
改某一条之前先调它拿号。
它返回的每一条都是可以直接再发一遍的形态（渐变、图案、素材都带着自己的字段），改完原样发回去不会丢东西。
注意里头的颜色是固有色，屏幕上看到的是打过光的。

### picture_layers
问这块有哪些层，或者按层名整层开关。层名写错会报错并把它有的层列给你——半途的开关看不见，比报错难查。
锁着的块不让改图层，先解锁。

### picture_light
问这块现在怎么打的光，或者改光。带哪个字段就改哪个字段，没带的沿用现值：
刚设了 lit / dark / k，只想把方位角挪五度，就只发 angle——把整包重发一遍等于把用户定好的那几样洗回默认。
off:true 关掉，画面回到没有光的原样（和没做这功能时逐字相同）。
返回里 faced 是这块有几条吃了光；一条都没有时打光看不见效果，它会提示你。
锁着的块不让改光，先解锁。

### picture_screenshot
只看这一块，返回一张 PNG。

### 用户手绘的笔迹
用户在块左缘那条工具条上画：选择 / 笔 / 毛笔 / 橡皮，再加墨色、笔宽和撤笔画。工具条第一项是「选择」，
点它才回到挪块、缩放；画画的蓝色只亮在这条工具条上，不占空间工具栏。
他画下来的每一笔就是 op:"stroke" 的原始点串，存的是手绘轨迹，不是精确图形。
要「洗画」：picture_get 拿到这些 stroke，照着点串改写成 rect / poly / line / text，
再按号 delete 掉原来那几笔，别留着两套。
橡皮是「碰到哪笔擦哪笔、一擦一整条」：用户没法只擦掉一笔里的一段，他觉得擦不干净时，
整条删掉重画比劝他微调更省事。一份 use 也是一整条，擦一个小人就是擦掉那一个小人。

### 必须守的五条
1. 画完就 picture_screenshot 看一眼再接着画。盲铺是大忌：一次 append 二三十条、回来看见歪的，
   就 delete 那几条重画，别整幅 replace。
2. picture_draw 返回里的 dropped 不是空的，就说明有指令或素材被丢了。每条带 at（你在 cmds 里的下标）、
   op 和 why（哪个字段没给、写成了什么）。被丢的那几条在画面上根本不存在，别当「画过了」继续往下叠。
   名字写错不在这里：素材名 / 变体名 / 图层名 / tile 与剪刀点的素材名对不上，这一笔请求整个失败（回话是报错，不是「画好了」），
   报错里把这块现有的名字列回来，照着改完再发一次。
3. 坐标是块内画面坐标：块的左上角是原点，可以出现负数、也可以超出块边界。
   画到框外面的部分不显示但数据还在，把块拉大就露出来。
   换算回空间世界坐标：picture_get 的 frame.x + 画面内 x。
4. 颜色只认 #rgb / #rrggbb / #rrggbbaa。red、rgba(...) 这类写法会被整条丢掉。
   只想描边不想填色就不写 fill（渲染器会自动填 none）；反过来 fill 写了不透明色就是实心。
5. 条数有两个口袋：顶层 cmds 最多 4000 条，展开后（use 摊成素材的实际节点）最多 20000 个。
   返回里的 expanded 就是已用的那份，接近 20000 就别再摆 use，先拿 tile 和渐变省。

画面块是矢量：块缩到多小都锐利，导出和截图同样锐利。文字是 op:"text" 指令，不是 HTML，
不要拿 text 块往画面上叠。`,
  },
  {
    id: "gen",
    title: "生图面板",
    body: `## 生图面板：写一句话出一张图（7 个工具）

### 先有一块
block_create {type:"gen", x, y, w, h, prompt, imageW, imageH, steps, cfg, seed, mode, strength}。
面板上只摆一个提示词框和一颗「开始」，出图尺寸 / 步数 / 贴合度 / 种子 / 那一档 / 改动幅度没有控件——想调就调块上这几个字段，
gen_run 和 block_update 都收这九个。默认 1024×1024、20 步、cfg 6、seed -1、mode auto、strength 0.75。

### gen_run：一条命令出一张
gen_run {id, prompt} 默认等到出完再回（本机一张约 30 秒）。返回里 phase 回到 idle、seconds 是这一张花了多久，
src 是这张图在这个空间 images/ 里的相对路径。
- 头一次跑（或者闲过 45 秒引擎自己放掉权重之后）要从盘上读十来 GB 权重，那一两分钟也算在同一个等待里；
  timeout 别压太小，默认 300 秒，最大 600。到点返回 timedOut:true，图还在后台跑，用 gen_status 接着问。
- 引擎一次只吃一张。别的面板正占着它会直接报回「引擎正被 xxx 占着」，先 gen_cancel 或者等它完事。
- 想边跑边干别的就 wait:false 只起一轮，之后看 phase。
- 同一张要复现就给正数 seed；-1 是每张换一个。
- 这一步不进批量：一次一张、每张几十秒，排在批量里没有意义。

### 进料靠连线：图生图与参考图编辑
**谁用 connector 连到这块面板，谁就是输入图**（方向是上游 → 面板；面板现在也能当连线的两端，圈才画得出来）。
一根不接是文生图；接一张当底图重绘，是图生图；接多张一起当参考，是参考图编辑（Qwen-Image 2.1 一路最多吃 10 张）。
这套推断就是 mode 的 auto 档，块上面板上都会显式报一句「接了 N 张输入图 · 图生图 / 参考图编辑」，别猜。
- mode 明写才盖得住推断：auto / t2i / i2i / edit。**「只有一张、但它是画风锚点不是底图」必须明写 edit**——
  不写会被当成底图重绘，锚点只约束画法这条就丢了。只想纯文生图却懒得拆线，就明写 t2i。
- strength 只在图生图吃：0 几乎原样、1 只剩个大概，默认 0.75。参考图编辑不看它。
- 能当进料的块：图片块（读盘上那份文件）、画面块（矢量先光栅化成 PNG）、另一块面板最近出的那张。
  **场景块这一版还不吃**（three.js 抓帧是另一件事），连过来会报「这块当不了输入图」。
- 输入图是每次点「开始」现取的：上游改了、线改了，下一张就跟着变，不用重新建块。
- 带图比纯文字慢：本机一张参考图约 54 秒，两张约 160 秒（显存吃紧时引擎会自己关掉 prefix 缓存重试，别当成卡死）。

### 出完看一眼
gen_screenshot {id} 返回一张 PNG——成品，或者正在跑时的那一帧逐步预览。
词写得对不对、构图偏不偏，在这儿看比读字段可靠；和画面块、场景块一样，改完先看再接着做。

### 要另摆一块才 gen_place
面板上那张不会自己变成图片块。gen_place {id} 在面板右边落一块独立图片块：是复制不是搬走，
面板接着显示它那张、也接着能改词重出，两份 PNG 各自独立，删一块不动另一块。

### 档位可换：gen_models / gen_models_set
模型文件夹里可以并存几档 Qwen-Image 2.1 的权重，同一时刻只吃其中一档。gen_models 不带参数，就是设置页上那颗「检测模型」：
回两列可换的文件（dit 画图模型、encoder 文本编码器，都带字节数、小的在前）+ fixed 那两件跟着模型定死的 + 当前档 currentDit / currentEncoder
+ machine（显卡名、显存、内存总量与空闲、模型目录那个盘还剩多少）+ advice（为什么建议某一档）
+ needed（建议那一套要放的四个文件：名字、字节数、下载页、在不在盘上，视觉投影标 optional）+ tiers（全部量化档，从小到大，标了建议那一个）。
gen_models_set {dit|encoder} 只传要动的那个槽位，文件名必须原样取自 gen_models 的列——它不是块上的字段，是全机一份配置。
- 换完当场落库，并把已载入的权重放掉：下一次出图重新读盘，那一两分钟会落在第一次 gen_run 上。
- 正在出图时换不了，先 gen_cancel 或等这张跑完。
- 大档更清晰也更吃内存（权重住内存条，按显存预算现搬上卡），但出图速度由算力决定，别拿体积当质量承诺；改档是为了画质，得用户点头，别自己挑一档就换。
- advice 那句「这台机器装得下」是拿检测那一刻的空闲内存和该盘剩余算的，用户开着大程序时数字会偏小——别照着它劝人换档。
- 这两个工具不进批量，也不该顺手改：它们是设置页上明摆着的东西。

### 权重不在盘上
needed 里有缺、或 missing 非空，就是这台机器还没备好模型文件。把 needed 的文件名、字节数和 modelsDir 报给用户，
让他在设置页点「检测模型」看一眼、自己下载了扔进那个文件夹——别自己去下载，也别改路径：
模型目录归用户（他可能只有一个盘装得下这十几 GB），「换个目录」那颗按钮就是给他按的。
当前档位选过一个后来被删掉的文件，也是这儿报出来。
视觉投影（mmproj）那行标着 optional 是真的：纯文生图缺了照跑，**但图生图和参考图编辑要靠它读输入图**，
真要走带图的档却缺这个文件，报回的话就照 needed 那行说清楚。`,
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

### 6. 批量建块（推荐用 space_batch）
先算好网格：列间距 = 块宽 + 40，行间距 = 块高 + 60；把整批操作塞进一次 space_batch，显式给每一块的 x/y：

~~~json
{ "operations": [
  { "tool": "block_create", "args": { "type": "rect", "x": 0, "y": 0, "w": 240, "h": 120 } },
  { "tool": "block_create", "args": { "type": "rect", "x": 320, "y": 0, "w": 240, "h": 120 } }
] }
~~~

整批只记一步撤销，中途也不会每块都运镜。

### 7. 铺完自查（很重要）
1. space_batch 铺完一批
2. space_snapshot {region:"all"} —— 看整体：有没有块重叠、有没有大片空白、重心是不是歪的
3. 有问题的块：space_snapshot {rect:{...}, maxSide:2000} 凑近看，确认是文字溢出还是尺寸不够
4. block_update 改那几块（也可以再包一个 space_batch）

不要跳第 2 步直接交活。你看到的坐标是对的，看到的效果不一定对。

### 8. 用户说「重排一下」
block_select {ids:[...]} 选中那一批 → 让用户右键选「对齐 / 分布 / 整理成网格」（这三个是界面里的操作，没有对应工具）；需要你用工具做的话，就是自己算坐标再 block_update，或者直接 space_batch 一批 block_update。`,
  },
  {
    id: "pitfalls",
    title: "易错点",
    body: `## 易错点

- 忘拿 id：动块前先 space_scene；id 跨空间不通用，space_open 后重新拿。
- 连线两端只能是两个不同的普通块；删块会连删线。
- 便签底色是 color，不是 fillColor；便签没有 fillColor。
- 文字块高度随内容自动长，block_update 改不了 text 的 w/h。
- radius 对除 ellipse 以外的带边框块都有效（rect/text/image/sticky/note/file）；ellipse 没有圆角。
- 坐标是世界坐标，不是屏幕坐标；拿不准就 space_scene 看现成的 x/y。
- 批量摆放一定要显式给坐标，不给会落在视野中央一格格错开。
- 本机文件用绝对路径，笔记用相对路径，两者不能混。
- file_write 冲突先 file_read 看新内容，再决定要不要 force；别无脑覆盖。
- PDF 页码从 1 开始，电子书章节从 0 开始；PDF 没读完不能跳页。
- 删除去向：space_delete 进回收站，notes_delete 永久不回头；block_delete 能靠 Ctrl+Z 撤回，但撤销栈只在内存里，刷新窗口就没了。
- 盲铺是大忌：一次要建的块超过五块，就开 space_batch；铺完 space_snapshot 看一眼再交活。
- 批量里拿不到前一项的 id：id 是执行时才生成的。要连线就分两批。
- 设置页换数据目录和窗口控制没有工具；改主题用 theme_set，先 theme_list 拿 id。
- 宇宙主题的航线不能用相机工具驱动：camera_pan / camera_zoom 只是小幅转头和长焦，要改飞行节奏请用 flight_control，要改遇星顺序和间隔请用 cosmos_route。
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
