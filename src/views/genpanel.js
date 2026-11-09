/* 生图面板的显示层：把块上的字段和这一轮的运行态画出来。
 *
 * 出图发生在 Rust 那边，这儿只管两件事——画，以及把按钮的按下递出去。
 * 运行态（第几步、预览图、报错）故意不写在 item 上：它属于这一轮，
 * 重开画布就该没了，落盘的只有提示词、参数和最近那一张在哪。
 */

const runs = new Map(); // 块 id -> 这一轮的运行态
const feeds = new Map(); // 块 id -> 最近一次算好的进料

const IDLE_RUN = {
  phase: "idle",
  step: 0,
  steps: 0,
  seconds: 0,
  previewUrl: "",
  imageUrl: "",
  error: "",
};

export function genRunOf(id) {
  return runs.get(id) || IDLE_RUN;
}

// 改一点运行态；没人开过这一轮就从空态起。
export function patchGenRun(id, patch) {
  const next = { ...(runs.get(id) || IDLE_RUN), ...patch };
  runs.set(id, next);
  return next;
}

export function dropGenRun(id) {
  runs.delete(id);
  feeds.delete(id);
}

/* 哪一块正占着引擎：一次只出一张，所以最多一个。 */
export function genBusyId() {
  for (const [id, run] of runs) {
    if (run.phase === "loading" || run.phase === "running") return id;
  }
  return "";
}

export function isGenBusy() {
  return Boolean(genBusyId());
}

/* 取景窗里那句话：正常态最多一行小字，出问题或在等才多说。 */
function hintText(run, item, mode) {
  /* 放大这一路引擎不报进度，一张整跑完才回来，所以只有「在等」这一句 */
  const isUpscale = mode === "upscale";
  const upscaleRefine = isUpscale && Boolean(item.refine);
  if (run.phase === "loading") return isUpscale ? "放大中…" : "载入权重…";
  if (run.phase === "running") {
    /* 补细节是一块一块补的，报片数比报「放大中」有用 */
    if (isUpscale) return upscaleRefine ? `补细节 ${run.step} / ${run.steps} 片` : "放大中…";
    return `第 ${run.step} / ${run.steps} 步`;
  }
  if (run.phase === "failed") return run.error || "出图失败";
  if (run.phase === "canceled") return "已取消";
  /* 秒数只在刚出完这一张时报；重开画布接回来的那张没跑过，别报个 0.0 秒 */
  if (run.imageUrl && run.seconds) return `${run.seconds.toFixed(1)} 秒`;
  /* 放大不读提示词，那句「写下提示词」在这儿是瞎指 */
  if (isUpscale && !upscaleRefine) return "";
  if (run.imageUrl || run.previewUrl || item.prompt) return "";
  if (upscaleRefine) return "点开始，放大后自动把细节补一遍";
  /* 局部重绘：底图到位了先让人涂，一句顶用的话比「写下提示词」实在 */
  if (mode === "inpaint") {
    return item.prompt ? "在预览上涂出要重绘的地方，点开始" : "连一张图进来，涂出要重绘的地方";
  }
  return "写下提示词，点开始";
}

/* 这块这一张会走哪一档；没算进料就退回块上存的那份（upscale 只能明选，所以存的就是它） */
function genModeOf(item, info) {
  return info?.mode || (item.mode && item.mode !== "auto" ? item.mode : "");
}

export function syncGen(el, item, feed) {
  const run = genRunOf(item.id);
  const image = el.querySelector(".canvas-gen-image");
  const hint = el.querySelector(".canvas-gen-hint");
  const modeLabel = el.querySelector(".canvas-gen-mode-label");
  const controls = el.querySelector(".canvas-gen-controls");
  const feedLine = el.querySelector(".canvas-gen-feed");
  const prompt = el.querySelector(".canvas-gen-prompt");
  const runButton = el.querySelector(".canvas-gen-run");
  const placeButton = el.querySelector(".canvas-gen-place");
  if (!image || !hint || !prompt || !runButton || !placeButton) return;

  /* 拖块、改边框那条路只刷元素，算不出连线数，所以不带 feed：沿用上一次的。
     一次都没算过时整块跳过——attachGenPanel 紧跟着会带真实的那份回来。 */
  if (feed) feeds.set(item.id, feed);
  const info = feeds.get(item.id);
  const mode = genModeOf(item, info);
  if (info) {
    /* 档位是纯文字：写这一张真会走的档，块上存 auto 时它跟着连线数变 */
    if (modeLabel && modeLabel.textContent !== info.label) modeLabel.textContent = info.label;
    /* 进料那一行：接了图才说话；明写了要图却一根线都没接，也说一句（不然点了才报错） */
    if (feedLine) {
      const text = info.count
        ? mode === "upscale"
          ? info.count === 1
            ? "连着 1 张输入图 · 出 4× 大的那张"
            : `高清放大只吃一张图，现在连了 ${info.count} 张`
          : mode === "t2i"
            ? `连着 ${info.count} 张输入图，可文生图不喂图：想喂就换档位，或选「自动」`
            : `接了 ${info.count} 张输入图 · ${info.label}`
        : mode === "upscale"
          ? "高清放大 · 连一张图进来"
          : mode !== "t2i"
            ? `${info.label} · 还没把图连进来`
            : "";
      feedLine.hidden = !text;
      feedLine.textContent = text;
    }
  }

  const busy = run.phase === "loading" || run.phase === "running";
  /* 局部重绘还没出图时取景窗垫连线来的底图，好让人对着它涂遮罩 */
  const baseUrl = mode === "inpaint" ? info?.baseUrl || "" : "";
  /* 逐步预览先垫上，成品到了才换下来——两张都不在的时候这块是空的 */
  const shown = run.imageUrl || run.previewUrl || baseUrl;
  image.hidden = !shown;
  if (shown && image.getAttribute("src") !== shown) image.setAttribute("src", shown);
  /* 预览帧本来就一两百像素，按自身尺寸摆就是张邮票漂在空取景窗里；拉满这一格
     才看得出是同一张图在逐渐变清晰。成品到了再按成品的尺寸铺。 */
  image.classList.toggle("is-preview", Boolean(shown) && !run.imageUrl);
  el.classList.toggle("has-image", Boolean(shown));

  const maskCanvas = el.querySelector(".canvas-gen-mask");
  if (maskCanvas) maskCanvas.hidden = mode !== "inpaint";
  /* 涂抹 / 清除只在局部重绘时出现；涂抹按钮亮着说明现在鼠标在涂、不在拖块 */
  const brushButton = el.querySelector(".canvas-gen-brush");
  const clearButton = el.querySelector(".canvas-gen-clear");
  if (brushButton) {
    brushButton.hidden = mode !== "inpaint";
    brushButton.classList.toggle(
      "is-active",
      mode === "inpaint" && Boolean(maskCanvas?.classList.contains("is-active")),
    );
  }
  if (clearButton) clearButton.hidden = mode !== "inpaint";
  const text = hintText(run, item, mode);
  hint.hidden = !text;
  hint.textContent = text;
  hint.classList.toggle("is-error", run.phase === "failed");

  /* 参数行：放大这一档没有可看的参数，整行撤掉 */
  if (controls) controls.hidden = mode === "upscale";
  /* 放大不读提示词，补细节也走内置那句；提示框整档都不摆 */
  const refineOn = mode === "upscale" && Boolean(item.refine);
  const promptWrap = el.querySelector(".canvas-gen-prompt-wrap");
  if (promptWrap) promptWrap.hidden = mode === "upscale";
  prompt.hidden = mode === "upscale";
  /* 补细节开关只在放大那档出现 */
  const refineButton = el.querySelector(".canvas-gen-refine");
  if (refineButton) {
    refineButton.hidden = mode !== "upscale";
    refineButton.classList.toggle("is-active", mode === "upscale" && Boolean(item.refine));
  }
  /* 正在打字的时候不拿块上的值去盖光标 */
  if (document.activeElement !== prompt && prompt.value !== item.prompt) {
    prompt.value = item.prompt || "";
  }
  prompt.disabled = Boolean(item.locked);

  runButton.textContent = busy ? "停止" : "开始";
  /* 一次一张：别的块在出图，这儿的开始就按不动 */
  runButton.disabled = Boolean(item.locked) || (!busy && isGenBusy());
  placeButton.hidden = !run.imageUrl || busy || Boolean(item.locked);
}
