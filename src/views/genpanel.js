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
  /* 这一轮是在哪个画布里发起的：出图是后台跑的，跑完时用户可能已经切走了，
     结果得落回发起时那一份，不能按「当前打开的画布」算 */
  canvasId: "",
};

export function genRunOf(id) {
  return runs.get(id) || IDLE_RUN;
}

// 改一点运行态；没人开过这一轮就从空态起。
export function patchGenRun(id, patch) {
  const next = { ...(runs.get(id) || IDLE_RUN), ...patch };
  runs.set(id, next);
  runChange?.();
  return next;
}

export function dropGenRun(id) {
  runs.delete(id);
  feeds.delete(id);
  runChange?.();
}

/* 运行态一变，canvas 那边要跟着刷新别的面板的「开始」灰化 */
let runChange = null;
export function onGenRunChange(listener) {
  runChange = listener;
}

/* 当前在跑的块（API 并行时可能不止一块，取第一块给老调用用）。 */
export function genBusyId() {
  for (const [id, run] of runs) {
    if (run.phase === "loading" || run.phase === "running") return id;
  }
  return "";
}

/* 取景窗里那句话：正常态最多一行小字，出问题或在等才多说。 */
function hintText(run, item, mode) {
  /* 远端没有步进：loading 是「请求发出去了」，running 是「在等接口回来」 */
  if (run.phase === "loading") return "提交中…";
  if (run.phase === "running") {
    if (!run.steps) return "生成中…";
    return `第 ${run.step} / ${run.steps} 步`;
  }
  if (run.phase === "failed") return run.error || "出图失败";
  if (run.phase === "canceled") return "已取消";
  /* 秒数只在刚出完这一张时报；重开画布接回来的那张没跑过，别报个 0.0 秒 */
  if (run.imageUrl && run.seconds) return `${run.seconds.toFixed(1)} 秒`;
  if (run.imageUrl || run.previewUrl || item.prompt) return "";
  /* 局部重绘：底图到位了先让人涂，一句顶用的话比「写下提示词」实在 */
  if (mode === "inpaint") {
    return item.prompt ? "在预览上涂出要重绘的地方，点开始" : "连一张图进来，涂出要重绘的地方";
  }
  return "写下提示词，点开始";
}

/* 这块这一张会走哪一档；没算进料就退回块上存的那份。
   老块上可能还留着 upscale（本地放大已移除），当成 auto 重新推断，别让它卡死。 */
function genModeOf(item, info) {
  const stored = item.mode && item.mode !== "auto" && item.mode !== "upscale" ? item.mode : "";
  return info?.mode || stored;
}

export function syncGen(el, item, feed, options = {}) {
  const blocked = Boolean(options.blocked);
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
        ? mode === "t2i"
          ? `连着 ${info.count} 张输入图，可文生图不喂图：想喂就换档位，或选「自动」`
          : `接了 ${info.count} 张输入图 · ${info.label}`
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

  /* 参数行与提示框一直都在：这一版只走 API，没有「整档不读提示词」的分支 */
  if (controls) controls.hidden = false;
  const promptWrap = el.querySelector(".canvas-gen-prompt-wrap");
  if (promptWrap) promptWrap.hidden = false;
  prompt.hidden = false;
  /* 正在打字的时候不拿块上的值去盖光标 */
  if (document.activeElement !== prompt && prompt.value !== item.prompt) {
    prompt.value = item.prompt || "";
  }
  prompt.disabled = false;

  runButton.textContent = busy ? "停止" : "开始";
  /* 本地引擎一次只吃一张：别的面板在跑时这块的开始灰掉；API 通道按并行数放开 */
  runButton.disabled = !busy && blocked;
  placeButton.hidden = !run.imageUrl || busy;
}
