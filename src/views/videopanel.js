/* 视频面板的显示层：这一轮跑到哪、出片在哪、参数和按钮状态。

 * 运行态不写进块：和生图面板一样，重开画布就没了。
 * 出片留在 gen/videos 缓存里，面板直接播它；点「落块」才拷一份进画布 video/，
 * 产物的所有权归视频块，面板可以接着改词重出。 */

const { convertFileSrc } = window.__TAURI__.core;

const runs = new Map();

const IDLE_RUN = {
  phase: "idle",
  label: "",
  waited: 0,
  startedAt: 0,
  path: "",
  seconds: 0,
  error: "",
  canceled: false,
};

export function videoRunOf(id) {
  return runs.get(id) || IDLE_RUN;
}

export function patchVideoRun(id, patch) {
  const next = { ...(runs.get(id) || IDLE_RUN), ...patch };
  runs.set(id, next);
  return next;
}

export function dropVideoRun(id) {
  runs.delete(id);
}

/* 当前在跑的视频块（API 并行时可能不止一块，取第一块给老调用用）。 */
export function videoBusyId() {
  for (const [id, run] of runs) {
    if (run.phase === "running") return id;
  }
  return "";
}

function waitedOf(run) {
  if (run.startedAt) return Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
  return run.waited || 0;
}

function hintText(run) {
  if (run.phase === "running") {
    const waited = waitedOf(run);
    return waited ? `${run.label || "生成中"} · 已等 ${waited} 秒` : "提交中…";
  }
  if (run.phase === "failed") return run.error || "生成失败";
  if (run.phase === "canceled") return "已取消；任务在平台那边停不掉，费用照算";
  if (run.path) return run.seconds ? `好了 · ${run.seconds.toFixed(1)} 秒生成` : "好了";
  return "写下提示词，点开始";
}

export function syncVideoPanel(el, item, feed) {
  const hint = el.querySelector(".canvas-genvideo-hint");
  const video = el.querySelector(".canvas-genvideo-video");
  const prompt = el.querySelector(".canvas-genvideo-prompt");
  const feedLine = el.querySelector(".canvas-genvideo-feed");
  const runButton = el.querySelector(".canvas-genvideo-run");
  const placeButton = el.querySelector(".canvas-genvideo-place");
  const seconds = el.querySelector('[data-video-field="seconds"]');
  const width = el.querySelector('[data-video-field="width"]');
  const height = el.querySelector('[data-video-field="height"]');
  if (!hint || !video || !prompt || !runButton || !placeButton) return;

  const run = videoRunOf(item.id);
  const busy = run.phase === "running";

  /* 播放器只认缓存文件；还没有片就藏起来 */
  const src = run.path ? convertFileSrc(run.path) : "";
  if (src) {
    if (video.getAttribute("src") !== src) {
      video.setAttribute("src", src);
      try {
        video.load();
      } catch {
        /* 加载失败就空着，hint 会说 */
      }
    }
    video.hidden = false;
  } else {
    video.hidden = true;
    if (video.getAttribute("src")) {
      try {
        video.pause();
      } catch {
        /* 没开始播过就没什么可停的 */
      }
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* 同上 */
      }
    }
  }

  const text = hintText(run);
  hint.textContent = text;
  hint.hidden = !text;
  hint.classList.toggle("is-error", run.phase === "failed");

  if (feedLine) {
    const count = feed?.count || 0;
    feedLine.textContent = count
      ? `接了 ${count} 张输入图 · 用${count > 1 ? "第一张" : "它"}当首帧`
      : "文生视频 · 连一张图进来就是图生视频";
  }

  if (document.activeElement !== prompt && prompt.value !== (item.prompt || "")) {
    prompt.value = item.prompt || "";
  }
  prompt.disabled = false;
  if (seconds && document.activeElement !== seconds) {
    seconds.value = String(item.seconds || 6);
    seconds.disabled = false;
  }
  if (width && document.activeElement !== width) {
    width.value = String(item.width || 1280);
    width.disabled = false;
  }
  if (height && document.activeElement !== height) {
    height.value = String(item.height || 720);
    height.disabled = false;
  }

  runButton.textContent = busy ? "停止" : "开始";
  /* API 通道可以并行跑多块，这里不再按「别人在跑」禁用；本地引擎由后端拒绝并报错 */
  runButton.disabled = false;
  placeButton.hidden = !run.path || busy;
}
