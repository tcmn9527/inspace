/* 从 canvas.js 拆出：gen-agent */

import { GEN_CFG_MAX, ratio } from "../canvas-items.js";
import { GEN_MODES, GEN_STEPS_MAX, GEN_TEXT_MAX, agentHighlight, agentRequireItem, agentRequireSpace, agentRevealBlock, agentSummary, clamp, closeFileEdit, commitEditing, current, dropVideoRun, editingId, filePreviewCache, findItem, genBusyId, genEngine, genInputItems, genInputPng, genModeFor, genRunMasks, genRunOf, isFileEditable, itemEls, numOr, openImageExternally, patchVideoRun, persistGen, persistNote, placeGenImage, previewKey, refreshFileBlock, refreshVideoPanel, renderNoteBody, revealTarget, runOrStopGen, scheduleItemsSave, showError, snapGenSize, stopGen, stopVideo, store, syncItemElement, videoBusyId, videoRunOf } from "../canvas.js";

/* ---------- 生图面板（agent） ----------
   引擎一次只吃一张，所以「现在能不能开始」看的不是这一块，而是 genBusyId() 那一个 id。
   gen_run 默认把这一趟等完：出图半分钟，比分几次去问相位省事；
   头一次跑还要先把权重读进来，那一两分钟也在同一个等待里。 */

export function agentGenOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "gen") throw new Error("这不是生图面板");
  return item;
}

/* 出图参数只认块上这几个字段：给了才改，认不出的数收成最接近的合法值。
   尺寸得贴到 32 的倍数上（snapGenSize），步数、cfg、seed 的区间和建块时同一套。 */
export function applyGenFields(item, spec = {}) {
  let touched = false;
  if (spec.prompt !== undefined) {
    item.prompt = String(spec.prompt).slice(0, GEN_TEXT_MAX);
    touched = true;
  }
  if (spec.negative !== undefined) {
    item.negative = String(spec.negative).slice(0, GEN_TEXT_MAX);
    touched = true;
  }
  if (Number.isFinite(Number(spec.imageW))) {
    item.imageW = snapGenSize(Number(spec.imageW));
    touched = true;
  }
  if (Number.isFinite(Number(spec.imageH))) {
    item.imageH = snapGenSize(Number(spec.imageH));
    touched = true;
  }
  if (Number.isFinite(Number(spec.steps))) {
    item.steps = clamp(Math.round(Number(spec.steps)), 0, GEN_STEPS_MAX);
    touched = true;
  }
  if (Number.isFinite(Number(spec.cfg))) {
    item.cfg = clamp(Number(spec.cfg), 0, GEN_CFG_MAX);
    touched = true;
  }
  if (spec.seed !== undefined) {
    /* -1 是「每张换一个」的哨兵，别的认不出的数也退回它 */
    const want = Number(spec.seed);
    item.seed = Number.isFinite(want) && want >= -1 ? Math.trunc(want) : -1;
    touched = true;
  }
  if (spec.mode !== undefined) {
    const want = String(spec.mode).trim().toLowerCase();
    if (!GEN_MODES.includes(want)) throw new Error(`mode 只认 ${GEN_MODES.join(" / ")}`);
    item.mode = want;
    touched = true;
  }
  if (spec.model !== undefined) {
    const want = String(spec.model).trim().toLowerCase();
    if (!["", "qwen21", "h3image"].includes(want)) {
      throw new Error("model 只认 qwen21 / h3image，空串是跟随设置里的当前模型");
    }
    item.model = want;
    touched = true;
  }
  if (spec.strength !== undefined) {
    const want = Number(spec.strength);
    if (!Number.isFinite(want)) throw new Error("strength 得是个 0~1 的数");
    item.strength = clamp(want, 0, 1);
    touched = true;
  }
  return touched;
}

export async function agentGenStatus() {
  agentRequireSpace();
  const engine = await store.genStatus();
  return {
    loaded: Boolean(engine.loaded),
    busyBlock: genBusyId() || null,
    family: engine.family || "",
    familyLabel: engine.familyLabel || "",
    provider: engine.provider || "local",
    apiModel: engine.apiModel || "",
    apiProblem: engine.apiProblem || null,
    modelsDir: engine.modelsDir || "",
    missing: Array.isArray(engine.missing) ? engine.missing : [],
    dit: engine.dit || "",
    encoder: engine.encoder || "",
    idleSeconds: engine.idleSeconds || 0,
    panels: current.items.filter((item) => item.type === "gen").map(agentSummary),
  };
}

/* 看/切当前生图模型族。切换会放掉已载入的权重，下一次出图按新族重新载入。 */
export async function agentGenFamily(family) {
  agentRequireSpace();
  const want = typeof family === "string" ? family.trim() : "";
  const info = want ? await store.genFamilySet(want) : await store.genModels();
  return {
    family: info.family || "",
    familyLabel: info.familyLabel || "",
    modes: Array.isArray(info.modes) ? info.modes : [],
    maxSide: info.maxSide || 0,
    modelsDir: info.modelsDir || "",
    currentDit: info.currentDit || "",
    currentEncoder: info.currentEncoder || "",
    missing: Array.isArray(info.missing) ? info.missing : [],
    advice: info.advice || "",
  };
}

/* 等到这一轮出完、失败或取消。运行态是事件写回来的，这儿只能轮询着读。 */
export async function waitGenRun(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = genRunOf(id);
    if (run.phase !== "loading" && run.phase !== "running") return run;
    if (Date.now() > deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function agentGenRun(id, patch = {}, mask = "") {
  const item = agentGenOf(id);
  /* 锁拦改不拦看，但这一趟既改字段又发任务：先看锁，不许把提示词写进一块锁着的面板 */
  /* 锁只锁坐标：出图、改参数、落块这些照常走 */
  if (!item.prompt?.trim() && genModeFor(item, genInputItems(item).length) !== "upscale") {
    throw new Error("提示词是空的");
  }
  const busy = genBusyId();
  const usingApi = genEngine.provider === "api";
  if (!usingApi && busy && busy !== item.id) {
    throw new Error(`引擎正被生图面板 ${busy} 占着，一次只出一张`);
  }
  if (mask) genRunMasks.set(item.id, String(mask));
  else genRunMasks.delete(item.id);
  /* 补细节是块上的开关，不走 applyGenFields */
  let refined = false;
  if (patch.refine !== undefined) {
    item.refine = Boolean(patch.refine);
    refined = true;
  }
  /* 改字段和发出去是同一次调用：先落到块上，出图取的就是块上这一份 */
  if (applyGenFields(item, patch) || refined) {
    persistGen(item);
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    scheduleItemsSave();
  }
  const nowRun = genRunOf(item.id);
  const running = nowRun.phase === "loading" || nowRun.phase === "running";
  if (running) runOrStopGen(item.id);
  else if (usingApi || !busy) runOrStopGen(item.id);
  agentHighlight([item.id], 1600);
  if (patch.wait === false) return { ...agentSummary(item), waited: false };
  const seconds = Math.min(600, Math.max(1, numOr(patch.timeout, 300)));
  const run = await waitGenRun(item.id, seconds * 1000);
  const still = findItem(item.id);
  if (!still) throw new Error(`生图面板 ${item.id} 已经不在这块画布里了`);
  return {
    ...agentSummary(still),
    waited: true,
    timedOut: run.phase === "loading" || run.phase === "running",
  };
}

/* 停一块的取消：给了块 id 就停那一块，不给就停当前在跑的第一块（兼容老调用） */
export function agentGenCancel(id) {
  const target = id ? String(id) : genBusyId();
  if (!target) return { canceled: false, note: "现在没有在出图" };
  const run = genRunOf(target);
  if (run.phase !== "loading" && run.phase !== "running") {
    return { canceled: false, note: "这块现在没有在出图" };
  }
  void stopGen(target);
  return { canceled: true, block: target };
}

/* 把最近那张落成一块独立图片块：面板留着继续改词重出，图片块自己带一份文件 */
export async function agentGenPlace(id) {  const item = agentGenOf(id);
  if (!item.src) throw new Error("这块还没出过图，先 gen_run");
  const run = genRunOf(item.id);
  if (run.phase === "loading" || run.phase === "running") {
    throw new Error("正在出图，等这一张跑完再落块");
  }
  const placed = await placeGenImage(item.id);
  if (!placed) throw new Error("没能落块：那张图的文件读不出来，具体原因弹在界面右下角了");
  agentRevealBlock(placed.id);
  return agentSummary(placed);
}

/* 视频生成：提交一条任务，等它出片。首帧可以给画布块 id（图片块、画面块、
   已出图的生图面板），也可以直接给 PNG 的 base64。产物是 gen/videos 下的缓存文件。 */
export async function agentGenVideo(args = {}) {
  agentRequireSpace();
  /* 给了 genvideo 面板就按面板走：提示词、秒数、尺寸、首帧都从面板上取，
     结果也写在面板的取景窗里，和手点「开始」完全一样，出完能直接落块。 */
  const panel = args.block ? findItem(String(args.block)) : null;
  const usePanel = panel && panel.type === "genvideo";
  const prompt = String(args.prompt || (usePanel ? panel.prompt : "") || "").trim();
  if (!prompt) throw new Error("prompt 是空的");
  let image = "";
  const first = args.firstFrame ? String(args.firstFrame) : "";
  if (first) {
    const item = findItem(first);
    image = item ? await genInputPng(item) : first;
  } else if (usePanel) {
    const sources = genInputItems(panel);
    if (sources.length) image = await genInputPng(sources[0]);
  }
  const block = usePanel ? panel.id : `video-${Date.now()}`;
  dropVideoRun(block);
  if (usePanel) {
    patchVideoRun(block, {
      phase: "running",
      label: "提交中…",
      startedAt: Date.now(),
      path: "",
      seconds: 0,
      error: "",
      canceled: false,
    });
    refreshVideoPanel(block);
  }
  await store.genVideoStart({
    block,
    prompt,
    image: image || undefined,
    seconds: numOr(args.seconds, usePanel ? panel.seconds : 6),
    ratio: args.ratio || "16:9",
    width: args.imageW ? Math.round(Number(args.imageW)) : usePanel ? panel.width : undefined,
    height: args.imageH ? Math.round(Number(args.imageH)) : usePanel ? panel.height : undefined,
    model: args.model || undefined,
  });
  const timeout = Math.min(1800, Math.max(30, numOr(args.timeout, 600)));
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const run = videoRunOf(block);
    if (run?.phase === "failed") {
      throw new Error(run.canceled ? "已取消" : run.error || "视频生成失败");
    }
    if (run?.phase === "done") {
      return { path: run.path, seconds: run.seconds };
    }
    if (Date.now() > deadline) {
      const status = await store.genVideoStatus().catch(() => null);
      return { timedOut: true, status };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

export async function agentGenVideoStatus() {
  agentRequireSpace();
  return store.genVideoStatus();
}

export async function agentGenVideoCancel(id) {
  const target = id ? String(id) : videoBusyId();
  if (target) {
    const run = videoRunOf(target);
    if (run?.phase === "running") {
      void stopVideo(target);
      return { canceled: true, block: target };
    }
  }
  const canceled = await store.genVideoCancel(target || undefined).catch(() => false);
  return { canceled };
}

export function agentNoteOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "note") throw new Error("这不是笔记块");
  return item;
}

export function agentNoteRead(id) {
  const item = agentNoteOf(id);
  return { ...agentSummary(item), markdown: item.source || "" };
}

export async function agentNoteWrite(id, text) {
  const item = agentNoteOf(id);
  if (editingId === item.id) commitEditing();
  const body = String(text ?? "");
  const canvasId = current.meta.id;
  if (item.linked) {
    await store.writeBackNote(canvasId, item.id, body);
    if (!current || current.meta.id !== canvasId) throw new Error("写回时画布被切走了");
  } else {
    item.source = body;
    persistNote(item);
  }
  item.source = body;
  const el = itemEls.get(item.id);
  if (el) renderNoteBody(item, el);
  agentHighlight([item.id]);
  return { ...agentSummary(item), markdown: body };
}

export async function agentFileOf(id) {
  const item = agentRequireItem(id);
  if (!isFileEditable(item)) throw new Error("这块不是可直接读写正文的文本文件");
  return item;
}

export async function agentFileRead(id, maxChars) {
  const item = await agentFileOf(id);
  const canvasId = current.meta.id;
  const body = await store.readFileBody(canvasId, item.id);
  if (!current || current.meta.id !== canvasId) throw new Error("读文件时画布被切走了");
  agentHighlight([item.id]);
  const limit = Math.max(0, Math.trunc(numOr(maxChars, 20000)));
  const full = body.text || "";
  const text = limit && full.length > limit ? full.slice(0, limit) : full;
  return {
    ...agentSummary(item),
    text,
    chars: full.length,
    truncated: text.length < full.length,
    encoding: body.encoding,
  };
}

export async function agentFileWrite(id, text, force = false) {
  const item = await agentFileOf(id);
  const canvasId = current.meta.id;
  /* 块里的编辑框开着就先收掉，不然它手上的旧正文会把这次写回盖掉 */
  if (!(await closeFileEdit())) throw new Error("块里的编辑框还开着，先处理那边的保存");
  if (!current || current.meta.id !== canvasId) throw new Error("写文件时画布被切走了");
  const body = await store.readFileBody(canvasId, item.id);
  const next = String(text ?? "");
  const result = await store.writeBackCanvasFile(canvasId, item.id, next, body, Boolean(force));
  if (!current || current.meta.id !== canvasId) throw new Error("写文件时画布被切走了");
  if (result?.conflict) {
    throw new Error("原文件在读取之后被别的程序改过；确认用这份覆盖请再带 force: true 调一次");
  }
  item.size = Number(result?.size) || item.size;
  filePreviewCache.delete(previewKey(item));
  refreshFileBlock(item);
  scheduleItemsSave();
  agentHighlight([item.id]);
  return { ...agentSummary(item), chars: next.length, encoding: body.encoding };
}

export function agentRevealFile(id) {
  const item = agentRequireItem(id);
  const target = revealTarget(item);
  if (!target) throw new Error("这块没有对应的磁盘文件");
  const call = target.block
    ? store.revealBlock(current.meta.id, item.id)
    : store.revealCanvasFile(current.meta.id, target.rel, target.linked);
  call.catch(showError);
  agentHighlight([item.id]);
  return agentSummary(item);
}

/* 用系统看图工具打开那块图：跟用户在画布上双击那一下是一回事 */
export async function agentOpenImage(id) {
  const item = agentRequireItem(id);
  if (item.type !== "image" && item.type !== "gen") throw new Error("这不是图片块");
  if (!item.src) throw new Error("这块还没有图");
  await openImageExternally(item);
  agentHighlight([item.id]);
  return agentSummary(item);
}
