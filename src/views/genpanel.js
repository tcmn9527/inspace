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
  if (run.phase === "loading") return isUpscale ? "放大中…" : "载入权重…";
  if (run.phase === "running") return isUpscale ? "放大中…" : `第 ${run.step} / ${run.steps} 步`;
  if (run.phase === "failed") return run.error || "出图失败";
  if (run.phase === "canceled") return "已取消";
  /* 秒数只在刚出完这一张时报；重开画布接回来的那张没跑过，别报个 0.0 秒 */
  if (run.imageUrl && run.seconds) return `${run.seconds.toFixed(1)} 秒`;
  /* 放大不读提示词，那句「写下提示词」在这儿是瞎指 */
  if (isUpscale || run.imageUrl || run.previewUrl || item.prompt) return "";
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
  const sizeLabel = el.querySelector(".canvas-gen-size .canvas-gen-select-label");
  const styleLabel = el.querySelector(".canvas-gen-style .canvas-gen-select-label");
  const shotsLabel = el.querySelector(".canvas-gen-shots .canvas-gen-select-label");
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
  /* 逐步预览先垫上，成品到了才换下来——两张都不在的时候这块是空的 */
  const shown = run.imageUrl || run.previewUrl;
  image.hidden = !shown;
  if (shown && image.getAttribute("src") !== shown) image.setAttribute("src", shown);
  /* 预览帧本来就一两百像素，按自身尺寸摆就是张邮票漂在空取景窗里；拉满这一格
     才看得出是同一张图在逐渐变清晰。成品到了再按成品的尺寸铺。 */
  image.classList.toggle("is-preview", Boolean(shown) && !run.imageUrl);
  el.classList.toggle("has-image", Boolean(shown));

  const text = hintText(run, item, mode);
  hint.hidden = !text;
  hint.textContent = text;
  hint.classList.toggle("is-error", run.phase === "failed");

  /* 参数行：放大这一档不读尺寸、风格和张数，整行撤掉；锁住的块不给动 */
  if (controls) controls.hidden = mode === "upscale";
  for (const button of [
    el.querySelector(".canvas-gen-size"),
    el.querySelector(".canvas-gen-style"),
    el.querySelector(".canvas-gen-shots"),
  ]) {
    if (button) button.disabled = Boolean(item.locked);
  }
  if (sizeLabel) sizeLabel.textContent = `${item.imageW}×${item.imageH}`;
  if (styleLabel) styleLabel.textContent = item.style || "无风格";
  if (shotsLabel) shotsLabel.textContent = `${item.shots || 1} 张`;
  /* 放大这一档一个字都不读，提示词框就整个撤掉（取景窗自己会长回来占这块） */
  prompt.hidden = mode === "upscale";
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
