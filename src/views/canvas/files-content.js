/* 从 canvas.js 拆出：files-content */

import { AUDIO_EXTS, EBOOK_EXTS, IMAGE_EXTS, PICTURE_MAX_CMDS, PICTURE_MAX_EXPANDED, VIDEO_EXTS, addAudioBlock, addDroppedFile, addEbookBlock, addFileBlock, addImageBlock, addVideoBlock, agentHighlight, agentRequireItem, agentRequireSpace, agentRevealBlock, agentSummary, applyColor, commitEditing, current, edgeLabelEditor, editingId, fileBlockSize, fileExt, imageCache, imageSize, insertPoint, itemEls, normalizeHidden, normalizeLight, normalizePictureCmds, normalizePictureSymbols, persistPicture, pictureImageSrc, pictureLayerCensus, pictureTopLayers, refreshPictureChrome, scheduleItemsSave, store, syncItemElement } from "../canvas.js";

/* ---------- 文件 / 笔记内容 ---------- */

/* agent 插文件不走弹窗：拷进画布还是引用原文件由调用方直接给 mode。 */
export async function agentImportFile(spec = {}) {
  agentRequireSpace();
  if (editingId || edgeLabelEditor) commitEditing();
  const canvasId = current.meta.id;
  const path = String(spec.path || "").trim();
  if (!path) throw new Error("需要文件在本机的路径 path");
  const mode = spec.mode === "link" ? "link" : "copy";
  const point =
    Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y))
      ? { x: Number(spec.x), y: Number(spec.y) }
      : null;
  const ext = fileExt(path);
  const force = String(spec.as || "");
  let placed = null;
  try {
    if (force === "image" || (!force && IMAGE_EXTS.has(ext))) {
      placed = await addImageBlock(path, point, mode);
    } else if (force === "audio" || (!force && AUDIO_EXTS.has(ext))) {
      placed = await addAudioBlock(path, point, mode);
    } else if (force === "video" || (!force && VIDEO_EXTS.has(ext))) {
      placed = await addVideoBlock(path, point, mode);
    } else if (force === "ebook" || (!force && EBOOK_EXTS.has(ext))) {
      placed = await addEbookBlock(path, point, mode);
    } else {
      const info = await store.fileInfo(path);
      if (!current || current.meta.id !== canvasId) throw new Error("导入时画布被切走了");
      if (force === "file") {
        const size = fileBlockSize(info);
        placed = await addFileBlock(info, point || insertPoint(size.w, size.h), mode);
      } else {
        placed = await addDroppedFile(info, point, mode);
      }
    }
  } catch (error) {
    throw new Error(`没能把这份文件放进画布：${error?.message || error}`);
  }
  if (!current || current.meta.id !== canvasId) throw new Error("导入时画布被切走了");
  if (!placed) throw new Error("没能把这份文件放进画布");
  if (spec.borderColor !== undefined) applyColor(placed, "borderColor", String(spec.borderColor || ""));
  if (spec.fillColor !== undefined) applyColor(placed, "fillColor", String(spec.fillColor || ""));
  if (spec.borderColor !== undefined || spec.fillColor !== undefined) scheduleItemsSave();
  agentRevealBlock(placed.id);
  agentHighlight([placed.id], 1400);
  return agentSummary(placed);
}

export function agentPictureOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "picture") throw new Error("这不是画面块");
  return item;
}

/* 这块有哪几层：同名指令算一层（几笔一起开关就包一层 group 起同名），组里起了名的那笔也算。
   没起名的指令单独报个数——agent 得知道自己画的有多少还没成组，不然会以为整幅就这几层。 */
export function pictureLayersOf(item) {
  const hidden = Array.isArray(item.hidden) ? item.hidden : [];
  const census = pictureLayerCensus(item.cmds);
  return {
    layers: census.order.map((name) => ({ name, cmds: census.counts.get(name), hidden: hidden.includes(name) })),
    unnamed: census.unnamed,
    hidden,
  };
}

/* 这块有多少笔声明了朝向（组里、素材表里的都算）：一条都没声明的话打光等于没打，
   截图看不出变化。报给 agent，别让它对着一张「光没生效」的画面瞎猜是自己画歪了。 */
export function pictureFaceCount(item) {
  let n = 0;
  const walk = (list) => {
    for (const cmd of Array.isArray(list) ? list : []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.face) n += 1;
      if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(item.cmds);
  for (const symbol of Object.values(item.symbols || {})) walk(symbol?.cmds);
  return n;
}

export function agentPictureGet(id) {
  const item = agentPictureOf(id);
  const cmds = Array.isArray(item.cmds) ? item.cmds : [];
  const symbols = item.symbols || {};
  const expanded = normalizePictureCmds(cmds, PICTURE_MAX_CMDS, { symbols }).expanded;
  const drawn = pictureTopLayers(cmds, item.hidden).filter((one) => one.drawn).length;
  return {
    ...agentSummary(item),
    paperColor: item.paperColor || "",
    cmds,
    /* 素材表整个交回去：use 只记一个名字，看不到名字背后是什么就没法接着画 */
    symbols,
    /* 一条 use 顶一整个素材，所以除了条数还要报展开后多少个节点 */
    expanded,
    symbolNames: Object.keys(symbols),
    /* 图层开关：hidden 是关着的层名，layers 是这块现有的层，drawn 是真画出来的条数（不等于 cmds 的条数） */
    hidden: Array.isArray(item.hidden) ? item.hidden : [],
    layers: pictureLayersOf(item).layers,
    drawn,
    /* 一套光：light 是这块的光，faced 是有多少笔声明了朝向。
       回读的 cmds 里颜色是固有色，屏幕上看到的是打过光的——对不上不是画丢了 */
    light: item.light || null,
    faced: pictureFaceCount(item),
    /* 块自身的左上角就是画面坐标原点；框外的部分不显示但数据还在，拉大块就露出来 */
    frame: { x: Math.round(item.x), y: Math.round(item.y), w: Math.round(item.w), h: Math.round(item.h) },
    limit: PICTURE_MAX_CMDS,
    expandedLimit: PICTURE_MAX_EXPANDED,
  };
}

/* 素材表并进块里现有的那一份：给了定义就按名字盖上去，值给 null 就是删掉它。
   这里只算出新表返回，不改 item —— 调用方要等指令也归一化通过了再落手，
   半途抛错的话块上会留下改了一半的素材表。
   还有指令在用的素材不许删：悄悄把那些实例一起抹掉，等于少写一个字段就丢一片画。
   数的是 incoming（这次请求结束后要留在块上的那一串），不是 item.cmds ——
   同批把用到它的指令一起撤掉的那种请求本来就干净，拦它就是把人逼成两次调用。
   没并进去的定义（名字不对、里面一条指令都不成立）报回去，旧的照原样留着。 */
export function mergePictureSymbols(item, given, incoming) {
  if (!given || typeof given !== "object" || Array.isArray(given)) {
    throw new Error('symbols 得是一个 {"名字":{cmds:[...]}} 对象；要删素材就把这个名的值写成 null');
  }
  const table = normalizePictureSymbols(given);
  /* 空原型：素材名是调用方给的，"__proto__" 往普通对象上塞会改掉原型链 */
  const next = Object.assign(Object.create(null), item.symbols || {});
  for (const key of Object.keys(given)) {
    const name = String(key).trim();
    if (!name) continue;
    if (given[key] == null) {
      const used = pictureSymbolUses(incoming ?? item.cmds, name);
      if (used) {
        throw new Error(`素材「${name}」还有 ${used} 处在用（use 摆的、tile 平铺铺的、clip / mask 当剪刀的），删了它们就空了：把用到它们的指令一起去掉（mode:"delete" 或整幅 replace）再删这个素材`);
      }
      delete next[name];
    } else if (table.symbols[name]) {
      next[name] = table.symbols[name];
    }
  }
  const merged = normalizePictureSymbols(next);
  /* 新并的、和整表重归一化时被掉的，都得报出去——不报就是「你说存好了，其实没存」 */
  return { symbols: merged.symbols, dropped: [...table.dropped, ...merged.dropped] };
}

/* 有多少地方在用这个素材：use 摆的一份、tile 图案铺的一份、当剪刀使的一份都算。
   图案漆里的 tile 也认素材名，只看 use 会漏——漏了就是一次悄悄丢指令。
   剪刀漏了更难看：素材一删，那条的 clip 就剪不出形，被遮住的那片画会凭空露出来。 */
export function pictureSymbolUses(cmds, name) {
  let uses = 0;
  const tiled = (paint) =>
    paint && typeof paint === "object" && paint.type === "pattern" && paint.pattern === "tile" && paint.ref === name;
  const cut = (shape) => shape && typeof shape === "object" && shape.ref === name;
  const walk = (list) => {
    for (const cmd of list || []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.op === "use" && cmd.ref === name) uses += 1;
      if (tiled(cmd.fill) || tiled(cmd.stroke)) uses += 1;
      if (cut(cmd.clip) || cut(cmd.mask) || tiled(cmd.mask?.fill)) uses += 1;
      if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(cmds);
  return uses;
}

/* 画面里垫一张位图，发过来最常见的两种写法是「只有本机路径」和「没写多大」。
   归一化那一步是同步的、量不了图，所以三个写入口（block_create / block_update / picture_draw）
   先异步补一圈：写了 path 的拷进这个画布、把回来的相对路径填进 src；w / h 缺的照原图量。
   拷不动、量不出都直接抛——悄悄少一块画，调用方会以为画面本来就该长这样。
   地址顺手放进 imageCache，画的第一遍就是真图，不用等下一次重画。
   src 自己写坏了的这里不动它，留给归一化去说那句 why（它会进返回的 dropped，比抛错好定位）。 */
export async function resolvePictureImages(spec, canvasId) {
  const found = [];
  const walk = (list) => {
    for (const cmd of list || []) {
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.op === "image") found.push(cmd);
      else if (cmd.op === "group") walk(cmd.cmds);
    }
  };
  walk(spec.cmds);
  for (const symbol of Object.values(spec.symbols || {})) walk(symbol && symbol.cmds);
  for (const cmd of found) {
    const path = String(cmd.path || "").trim();
    const needsSize = !(Number(cmd.w) > 0 && Number(cmd.h) > 0);
    let parsed = pictureImageSrc(cmd.src);
    if (path) {
      if (!IMAGE_EXTS.has(fileExt(path))) {
        throw new Error(`垫进画面的 path 得是一张图片（「${path.slice(0, 40)}」不是）——要放文档就另建一个文件块`);
      }
      let rel = "";
      try {
        rel = await store.importCanvasImage(canvasId, path);
      } catch (error) {
        throw new Error(`没能把「${path.slice(0, 48)}」拷进这个画布：${error?.message || error}`);
      }
      parsed = pictureImageSrc(rel);
    }
    if (parsed.why) continue;
    cmd.src = parsed.src;
    let url = imageCache.get(parsed.src) || "";
    if (!url) {
      try {
        url = await store.imageUrl(canvasId, parsed.src, parsed.linked);
      } catch (error) {
        throw new Error(`读不到这张垫图：${parsed.src}——${error?.message || error}`);
      }
    }
    if (!current || current.meta.id !== canvasId) throw new Error("垫图进画面的时候画布被切走了");
    imageCache.set(parsed.src, url);
    if (!needsSize) continue;
    const size = await imageSize(url, null);
    if (!size || !size.width || !size.height) {
      throw new Error(
        `量不出这张图有多大：${parsed.src}——原文件可能读不出来或已经不是图片了；自己写上 w 和 h 就能垫进去`,
      );
    }
    cmd.w = Math.round(size.width);
    cmd.h = Math.round(size.height);
  }
}

/* 已经画好的指令在这轮归一化里没过 = 这一笔会把画好的东西洗掉（多半是它用的素材被删了）。
   不能只报一声就写下去：append 报的 at 减掉了前面旧的那一截，成了负数，
   调用方根本对不上是哪条。所以直接拒掉，让调用方先把素材补回来。
   oldCount 是「送进归一化的那串里，前多少条是块上原有的」。 */
export function pictureWashed(result, oldCount, wanted) {
  const broke = result.dropped.find((one) => one.at < oldCount);
  if (!broke) return;
  const lost = wanted[broke.at];
  throw new Error(
    `这一笔会把已有的第 ${lost?.i ?? broke.at + 1} 条（${lost?.op || broke.op}）洗掉：${broke.why}` +
      "——素材要先补回来，或先用 mode:\"delete\" 把用它的指令一起删掉；整幅重画就明说 mode:\"replace\"",
  );
}

/* 名字写错的那一类（use 的 ref / variant / hide、tile 漆的 ref、剪刀的 ref）整笔请求失败。
   以前它们只进 dropped，于是「一个变体名拼错 → 十七个小人没了」要回看渲染才发现，
   而回话里那句「画好了」把人骗过去。报错时把这块现在有的名字一起带回去，改起来不用猜。
   用户手绘那一路不过这里：手绘不会写错名字，也不该为这个丢一笔。 */
export function rejectFatalDrop(list) {
  const bad = (list || []).find((one) => one.fatal);
  if (bad) throw new Error(bad.why);
}

/* 画进去三种走法：replace 整幅换掉（默认）、append 追加、delete 按号删。
   按号删是给橡皮和「洗掉画歪那一笔」用的——整幅重替换风险大得多。 */
export async function agentPictureDraw(id, patch = {}) {
  const item = agentPictureOf(id);
  if (item.locked) throw new Error("这块已锁定，先解锁再画");
  /* 垫的位图得先拷进来、量好尺寸，下面归一化才认得这条 image */
  const canvasId = current.meta.id;
  await resolvePictureImages(patch, canvasId);
  if (!current || current.meta.id !== canvasId) throw new Error("画这一笔的时候画布被切走了，什么都没改");
  const before = Array.isArray(item.cmds) ? item.cmds : [];
  const mode = String(patch.mode || "replace");
  const given = Array.isArray(patch.cmds) ? patch.cmds : [];
  /* 图层开关是块上的属性（和纸色同一类，走 items.json）：坏拼写在这儿就抛，
     别等指令已经落了一半才发现改不动。 */
  const hidden = patch.hidden === undefined ? null : normalizeHidden(patch.hidden);
  if (hidden?.why) throw new Error(hidden.why);
  const light = patch.light === undefined ? null : normalizeLight(patch.light);
  if (light?.why) throw new Error(light.why);
  /* 先定下这一请求结束后块上留的是哪一串（还没归一化）：素材删除的守卫数的是它，
     不是块上旧的那一串——同批把用到它的指令一起撤干净的那种请求本来就安全，
     拦它等于逼人多跑一趟。mode 不对也在这儿就抛，别抛在素材已经改了之后。 */
  let incoming = before;
  if (mode === "delete") {
    const ids = new Set((Array.isArray(patch.ids) ? patch.ids : []).map(Number));
    if (!ids.size) throw new Error("delete 需要 ids：要删的指令号，从 picture_get 里拿");
    incoming = before.filter((cmd) => !ids.has(cmd.i));
  } else if (mode === "append") {
    incoming = [...before, ...given];
  } else if (mode === "replace") {
    incoming = given;
  } else {
    throw new Error("mode 只能是 replace / append / delete");
  }
  /* 素材先并进来：同一个请求里的 cmds 才认得刚起的名字，use 不用分两次发。
     并出来的是新表，先攥在手里，等指令也归一化通过了一起换上——半途抛错不能留下改到一半的块 */
  const merged = patch.symbols === undefined ? null : mergePictureSymbols(item, patch.symbols, incoming);
  const symbols = merged ? merged.symbols : item.symbols || {};
  let next = before;
  let dropped = [];
  let deleted = 0;
  let expanded = 0;
  if (mode === "delete") {
    next = incoming;
    deleted = before.length - next.length;
    const rest = normalizePictureCmds(next, PICTURE_MAX_CMDS, { symbols });
    pictureWashed(rest, next.length, next);
    expanded = rest.expanded;
  } else {
    const result = normalizePictureCmds(incoming, PICTURE_MAX_CMDS, { symbols });
    next = result.cmds;
    expanded = result.expanded;
    if (mode === "append") pictureWashed(result, before.length, incoming);
    /* append 洗的是「旧的 + 新发的」拼起来的表，下标得减掉前面旧的那一截，
       报回去的 at 才是调用方自己发出去的 cmds 里的第几条 */
    const offset = mode === "append" ? before.length : 0;
    dropped = result.dropped.map((one) => ({ ...one, at: one.at - offset }));
  }
  const rejected = [...(merged ? merged.dropped : []), ...dropped];
  /* 名字写错的那一类在这儿拦下来：拼错一个 variant / ref 只悄悄少一片画、回话还说画好了，
     agent 会照着这个半成品继续往下画。整笔请求先失败，改对了再发一次。 */
  rejectFatalDrop(rejected);
  if (merged) item.symbols = merged.symbols;
  item.cmds = next;
  /* 指令和素材不归 items.json 管，改完单独落 pictures/<块id>.json 那一份 */
  persistPicture(item);
  if (patch.paperColor !== undefined) {
    item.paperColor = String(patch.paperColor || "");
    refreshPictureChrome(item.id);
  }
  /* 开关要在重画之前就写上，不然这一帧还是按旧的层画 */
  if (hidden) item.hidden = hidden.hidden;
  if (light) item.light = light.light;
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  agentHighlight([item.id]);
  return {
    ...agentSummary(item),
    added: next.length - before.length,
    deleted,
    total: next.length,
    expanded,
    symbolNames: Object.keys(symbols),
    /* 回显图层开关：只改素材或纸色的那一次也要看得见现在关着哪几层，
       不然 agent 以为画面上少了那一片是自己画丢了 */
    hidden: Array.isArray(item.hidden) ? item.hidden : [],
    layers: pictureLayersOf(item).layers,
    light: item.light || null,
    drawn: pictureTopLayers(next, item.hidden).filter((one) => one.drawn).length,
    limit: PICTURE_MAX_CMDS,
    expandedLimit: PICTURE_MAX_EXPANDED,
    /* 认不了的指令原样报回去：at 是你在 cmds 里提交的下标，why 说清是哪个字段写成了什么。
       不报的话 agent 会以为画面本来就该长这样 */
    ...(rejected.length
      ? {
          dropped: rejected,
          hint: `有 ${rejected.length} 条指令或素材被丢了，按每条的 why 改掉再发一次；改完要拿 picture_get 回读编号，别按提交下标删`,
        }
      : {}),
  };
}

/* 图层单独一个工具：读这块有哪些层、关着哪几层；带 hide / show 就动开关。
   开关不碰指令——为了关一层把几千条整幅 replace 一遍，风险和开销都不该在那头。
   同名同时出现在 hide 和 show 里按 show 算（开着），返回里照实回显，不用猜。 */
export function agentPictureLayers(id, patch = {}) {
  const item = agentPictureOf(id);
  if (item.locked) throw new Error("这块已锁定，先解锁再改图层");
  const off = Array.isArray(item.hidden) ? [...item.hidden] : [];
  const read = (raw, key) => {
    if (raw === undefined) return null;
    const got = normalizeHidden(raw);
    if (got.why) throw new Error(`${key} ${got.why.replace(/^hidden /, "")}`);
    return got.hidden;
  };
  const hide = read(patch.hide, "hide");
  const show = read(patch.show, "show");
  const census = pictureLayersOf(item);
  const known = census.layers.map((one) => one.name);
  const asked = [...new Set([...(hide || []), ...(show || [])])];
  const unknown = asked.filter((name) => !known.includes(name));
  if (unknown.length) {
    throw new Error(
      `这块没有「${unknown.join(" / ")}」这些图层——${
        known.length ? `现在有的层是：${known.slice(0, 12).join(" / ")}` : "这块一条指令都还没起 name（想整层开关，就给那几条指令写同一个 name，几笔一起开关就包一层 group 起名）"
      }`,
    );
  }
  if (hide || show) {
    const next = [...off];
    for (const name of hide || []) if (!next.includes(name)) next.push(name);
    for (const name of show || []) {
      const at = next.indexOf(name);
      if (at >= 0) next.splice(at, 1);
    }
    item.hidden = next;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    scheduleItemsSave();
    agentHighlight([item.id]);
  }
  const layers = census.layers.map((one) => ({ ...one, hidden: item.hidden.includes(one.name) }));
  return {
    ...agentSummary(item),
    hidden: [...item.hidden],
    layers,
    unnamed: census.unnamed,
    drawn: pictureTopLayers(item.cmds, item.hidden).filter((one) => one.drawn).length,
    total: (Array.isArray(item.cmds) ? item.cmds : []).length,
    ...(layers.length ? {} : { hint: "这块还没分层：想整层开关，就给那几条指令写同一个 name（几笔一起开关就包一层 group 起名）" }),
  };
}

/* 一套光单独一个工具：只带 id 就是问「这块现在怎么打的光」。
   带哪个字段就改哪个字段，没带的沿用块上现值——为了挪五度方位角要把光色、影色、强度重发一遍，
   等于把用户定好的那几样洗回默认，这正是「改一处丢一片」那类坑。
   关掉光写 off:true。 */
export function agentPictureLight(id, patch = {}) {
  const item = agentPictureOf(id);
  const wanted = patch.off === true || patch.off === "true" || ["angle", "elev", "lit", "dark", "k"].some((key) => patch[key] !== undefined);
  /* 只带 id 是「问这块现在怎么打的光」，锁着也得答——锁拦的是改，不是看 */
  if (wanted && item.locked) throw new Error("这块已锁定，先解锁再改光");
  if (patch.off === true || patch.off === "true") {
    item.light = null;
  } else {
    const given = ["angle", "elev", "lit", "dark", "k"].filter((key) => patch[key] !== undefined);
    if (given.length) {
      /* 从没挂过光的块起步：没有现值可沿用，angle 没给就报错，不替它挑一个方向 */
      const merged = { ...(item.light || {}) };
      for (const key of given) merged[key] = patch[key];
      const got = normalizeLight(merged);
      if (got.why) throw new Error(got.why);
      item.light = got.light;
    }
  }
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
  agentHighlight([item.id]);
  const faced = pictureFaceCount(item);
  return {
    ...agentSummary(item),
    light: item.light || null,
    faced,
    cmds: (Array.isArray(item.cmds) ? item.cmds : []).length,
    ...(item.light && !faced
      ? { hint: "这块还没有一笔声明 face，光打上去不会有任何明暗变化——要给受光的那几笔写 face（up/down/left/right/front/back），整面墙就包一层 group 写一次" }
      : {}),
  };
}
