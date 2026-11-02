/* 生图面板的显示层：把块上的字段和这一轮的运行态画出来。
 *
 * 出图发生在 Rust 那边，这儿只管两件事——画，以及把按钮的按下递出去。
 * 运行态（第几步、预览图、报错）故意不写在 item 上：它属于这一轮，
 * 重开空间就该没了，落盘的只有提示词、参数和最近那一张在哪。
 */

const runs = new Map(); // 块 id -> 这一轮的运行态

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
function hintText(run, item) {
  if (run.phase === "loading") return "载入权重…";
  if (run.phase === "running") return `第 ${run.step} / ${run.steps} 步`;
  if (run.phase === "failed") return run.error || "出图失败";
  if (run.phase === "canceled") return "已取消";
  /* 秒数只在刚出完这一张时报；重开空间接回来的那张没跑过，别报个 0.0 秒 */
  if (run.imageUrl && run.seconds) return `${run.seconds.toFixed(1)} 秒`;
  if (run.imageUrl || run.previewUrl || item.prompt) return "";
  return "写下提示词，点开始";
}

export function syncGen(el, item) {
  const run = genRunOf(item.id);
  const image = el.querySelector(".canvas-gen-image");
  const hint = el.querySelector(".canvas-gen-hint");
  const prompt = el.querySelector(".canvas-gen-prompt");
  const runButton = el.querySelector(".canvas-gen-run");
  const placeButton = el.querySelector(".canvas-gen-place");
  if (!image || !hint || !prompt || !runButton || !placeButton) return;

  const busy = run.phase === "loading" || run.phase === "running";
  /* 逐步预览先垫上，成品到了才换下来——两张都不在的时候这块是空的 */
  const shown = run.imageUrl || run.previewUrl;
  image.hidden = !shown;
  if (shown && image.getAttribute("src") !== shown) image.setAttribute("src", shown);
  el.classList.toggle("has-image", Boolean(shown));

  const text = hintText(run, item);
  hint.hidden = !text;
  hint.textContent = text;
  hint.classList.toggle("is-error", run.phase === "failed");

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
