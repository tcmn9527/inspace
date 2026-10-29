/* 设置页：数据文件夹 + 视频组件状态。

   笔记、空间两类数据都存在这一个文件夹里；这里负责「选目录 → 问旧文件夹怎么处置 → 落地」
   这三步。拷贝 / 剪贴 / 新建由用户当场决定，后端只在最后一步动手，中途失败原数据保持不动。

   视频组件只在没认到的时候才出现：那种情况下用户需要「把 ffmpeg.exe 放进哪个文件夹」
   和「放完了点一下重新检测」，整张卡就是为这两步存在的。认到了就一行都不显示，
   因为这时候他没有任何事可干——音轨转 AAC 是空间里点播放时顺手做的。 */

import { choiceDialog, progressDialog } from "./dialog.js";

const { invoke } = window.__TAURI__.core;

const ui = {};
let statusTimer = 0;
let currentRoot = "";

/* 搬运在后台线程跑，进度走 data-root-move 事件。命令一返回，线程就可能已经发过
   好几条了，所以监听器常驻、事件先按任务号攒着，等进度弹层挂上再补画。 */
const moveEvents = new Map();
let activeMove = null;

function showError(message) {
  ui.error.textContent = message;
  ui.error.hidden = !message;
}

function showFfmpegError(message) {
  ui.ffmpegError.textContent = message;
  ui.ffmpegError.hidden = !message;
}

function showStatus(message) {
  clearTimeout(statusTimer);
  ui.status.textContent = message;
  ui.status.hidden = false;
  statusTimer = setTimeout(() => {
    ui.status.hidden = true;
  }, 3000);
}

function setBusy(busy) {
  for (const button of [ui.pick, ui.reveal, ui.reset]) button.disabled = busy;
}

export function initSettings() {
  ui.path = document.querySelector("#settings-data-path");
  ui.pick = document.querySelector("#settings-data-pick");
  ui.reveal = document.querySelector("#settings-data-reveal");
  ui.reset = document.querySelector("#settings-data-reset");
  ui.status = document.querySelector("#settings-data-status");
  ui.error = document.querySelector("#settings-data-error");
  ui.ffmpegCard = document.querySelector("#settings-ffmpeg-card");
  ui.ffmpegDir = document.querySelector("#settings-ffmpeg-dir");
  ui.ffmpegReveal = document.querySelector("#settings-ffmpeg-reveal");
  ui.ffmpegRecheck = document.querySelector("#settings-ffmpeg-recheck");
  ui.ffmpegError = document.querySelector("#settings-ffmpeg-error");

  ui.pick.addEventListener("click", pickRoot);
  ui.reveal.addEventListener("click", reveal);
  ui.reset.addEventListener("click", reset);
  ui.ffmpegReveal.addEventListener("click", revealFfmpegDir);
  ui.ffmpegRecheck.addEventListener("click", refreshFfmpeg);
  setupMoveEvents();
}

function setupMoveEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  Promise.resolve(
    listen("data-root-move", (event) => {
      const payload = event?.payload;
      if (!payload?.job) return;
      moveEvents.set(payload.job, payload);
      activeMove?.(payload);
    }),
  ).catch(() => {});
}

export async function refreshSettings() {
  try {
    currentRoot = await invoke("data_root");
    ui.path.textContent = currentRoot;
  } catch (error) {
    showError(String(error));
  }
  refreshFfmpeg();
}

function sameDir(a, b) {
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function countText(counts) {
  const bits = [];
  if (counts.notes) bits.push(`${counts.notes} 篇笔记`);
  if (counts.canvases) bits.push(`${counts.canvases} 个空间`);
  return bits.join("、");
}

const hasAny = (counts) => counts.notes + counts.canvases > 0;

const STATUS_TEXT = {
  copy: "已复制一份到新文件夹，旧文件夹原样留着",
  move: "数据已搬到新文件夹，旧文件夹里的文件在回收站",
  fresh: "已切换文件夹，原有数据留在原地",
};

const MOVE_TITLE = { copy: "正在拷贝数据…", move: "正在搬运数据…" };
const STAGE_TEXT = { copy: "复制到新文件夹", recycle: "旧文件送回收站" };

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/* 后端报的是「处理到第几个文件 + 当前大文件的字节数」，两者合成一根条：
   小文件一格一格走，碰到几 GB 的视频时按字节填，不至于盯着不动。 */
function paintMove(dialog, payload) {
  const bytes = payload.bytesTotal > 0 ? Math.min(1, payload.bytesDone / payload.bytesTotal) : 0;
  const fraction = payload.total > 0 ? Math.min(1, (payload.done + bytes) / payload.total) : 0;
  const bits = [`${STAGE_TEXT[payload.stage] || "搬运"} ${payload.done} / ${payload.total} 个`];
  if (payload.bytesTotal > 0) {
    bits.push(`${formatBytes(payload.bytesDone)} / ${formatBytes(payload.bytesTotal)}`);
  }
  if (payload.label) bits.push(payload.label);
  dialog.set(fraction, bits.join(" · "));
}

/* 等一次搬运跑完，返回 done / cancelled / error 三种收尾事件之一。
   弹层是攒到第一条进度才建：几十个几百个小文件一眨眼就完，提前弹反而闪人。 */
function watchMove(job, mode) {
  return new Promise((resolve) => {
    let dialog = null;

    const finish = (payload) => {
      activeMove = null;
      moveEvents.delete(job);
      dialog?.close();
      resolve(payload);
    };

    const handle = (payload) => {
      if (payload.job !== job) return;
      if (payload.phase !== "progress") {
        finish(payload);
        return;
      }
      if (!dialog) {
        dialog = progressDialog({ title: MOVE_TITLE[mode] || "正在搬运数据…" });
        dialog.onCancel(async () => {
          dialog.cancelPending();
          try {
            await invoke("data_root_cancel", { job });
          } catch (error) {
            dialog.setText?.(String(error));
          }
        });
      }
      paintMove(dialog, payload);
    };

    activeMove = handle;
    const backlog = moveEvents.get(job);
    if (backlog) handle(backlog);
  });
}

function applyRoot(path, mode) {
  currentRoot = path;
  ui.path.textContent = path;
  window.dispatchEvent(new Event("data-root-changed"));
  showStatus(STATUS_TEXT[mode]);
}

/* 换目录前先问清旧文件夹怎么处置：拷贝留两份、剪贴清旧的、新建谁也不动。
   源目录本来就空的话没什么可问的，直接切。
   新建只挪指针，一步就完；拷贝/剪贴把搬运交给后台线程，前端弹进度条，随时能停。 */
async function switchRoot(target) {
  if (sameDir(target, currentRoot)) {
    showStatus("已经在这个文件夹了");
    return;
  }
  const from = await invoke("data_stats", { root: currentRoot });
  let mode = "fresh";
  if (hasAny(from)) {
    const to = await invoke("data_stats", { root: target });
    const full = hasAny(to);
    const choice = await choiceDialog({
      title: "旧文件夹里的数据怎么处理？",
      message: `现有 ${countText(from)}。新文件夹：${target}`,
      options: [
        {
          value: "copy",
          label: "拷贝",
          hint: full
            ? "目标里已经有数据，会拒绝以免两份混在一起"
            : "新文件夹放一份，旧文件夹原样留着；以后两边各改各的",
        },
        {
          value: "move",
          label: "剪贴",
          hint: full
            ? "目标里已经有数据，会拒绝以免两份混在一起"
            : "新文件夹放一份，旧文件夹里的数据文件送进回收站",
        },
        {
          value: "fresh",
          label: "新建",
          hint: full
            ? `切过去显示那一份（${countText(to)}），原来的不动`
            : "什么都不带，新文件夹从空的开始；旧数据原地留着，指回来还能看见",
        },
      ],
    });
    if (choice === null) return;
    mode = choice;
  }
  const switchResult = await invoke("data_set_root", { root: target, mode });
  if (!switchResult.job) {
    applyRoot(switchResult.path, mode);
    return;
  }
  const outcome = await watchMove(switchResult.job, mode);
  if (outcome.phase === "done") {
    applyRoot(switchResult.path, mode);
  } else if (outcome.phase === "cancelled") {
    showStatus("已停止：复制过去的都清掉了，旧文件夹没动");
  } else {
    showError(outcome.error || "搬运数据失败");
  }
}

/* 认到了就什么都不显示：这时候用户没事儿可干——转音轨是空间里点播放时顺手做的。
   只有没认到（或检测本身出错）才摆出修复入口：放哪儿、打开文件夹、重新检测。 */
async function refreshFfmpeg() {
  showFfmpegError("");
  try {
    const status = await invoke("ffmpeg_status");
    ui.ffmpegCard.hidden = status.found;
    if (!status.found) ui.ffmpegDir.textContent = status.componentsDir;
  } catch (error) {
    ui.ffmpegCard.hidden = false;
    showFfmpegError(String(error));
  }
}

async function revealFfmpegDir() {
  showFfmpegError("");
  ui.ffmpegReveal.disabled = true;
  try {
    await invoke("ffmpeg_reveal");
  } catch (error) {
    showFfmpegError(String(error));
  } finally {
    ui.ffmpegReveal.disabled = false;
  }
}

async function pickRoot() {
  showError("");
  setBusy(true);
  try {
    const path = await invoke("data_pick_root");
    if (path) await switchRoot(path);
  } catch (error) {
    showError(String(error));
  } finally {
    setBusy(false);
  }
}

async function reveal() {
  showError("");
  try {
    await invoke("data_reveal");
  } catch (error) {
    showError(String(error));
  }
}

async function reset() {
  showError("");
  setBusy(true);
  try {
    await switchRoot(await invoke("data_default_root"));
  } catch (error) {
    showError(String(error));
  } finally {
    setBusy(false);
  }
}
