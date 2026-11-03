/* 设置页：数据文件夹 + 视频组件状态。

   笔记、空间两类数据都存在这一个文件夹里；这里负责「选目录 → 问旧文件夹怎么处置 → 落地」
   这三步。拷贝 / 剪贴 / 新建由用户当场决定，后端只在最后一步动手，中途失败原数据保持不动。

   视频组件只在没认到的时候才出现：那种情况下用户需要「把 ffmpeg.exe 放进哪个文件夹」
   和「放完了点一下重新检测」，整张卡就是为这两步存在的。认到了就一行都不显示，
   因为这时候他没有任何事可干——音轨转 AAC 是空间里点播放时顺手做的。 */

import { choiceDialog, confirmDialog, progressDialog } from "./dialog.js";
import { currentTheme } from "./theme.js";
import { cosmosRoute, cosmosRouteSet } from "./cosmos.js";

const { invoke } = window.__TAURI__.core;

const ui = {};
let statusTimer = 0;
let currentRoot = "";
let mcpInfo = null;
let mcpStatusTimer = 0;

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
  ui.mcpUrl = document.querySelector("#settings-mcp-url");
  ui.mcpCopy = document.querySelector("#settings-mcp-copy");
  ui.mcpReset = document.querySelector("#settings-mcp-reset");
  ui.mcpStatus = document.querySelector("#settings-mcp-status");
  ui.mcpError = document.querySelector("#settings-mcp-error");
  ui.cosmosCard = document.querySelector("#settings-cosmos-card");
  ui.cosmosHint = document.querySelector("#settings-cosmos-hint");
  ui.cosmosStatus = document.querySelector("#settings-cosmos-status");
  ui.cosmosDir = document.querySelector("#settings-cosmos-dir");
  ui.cosmosUpgrade = document.querySelector("#settings-cosmos-upgrade");
  ui.cosmosCancel = document.querySelector("#settings-cosmos-cancel");
  ui.cosmosClear = document.querySelector("#settings-cosmos-clear");
  ui.cosmosError = document.querySelector("#settings-cosmos-error");
  ui.routeCard = document.querySelector("#settings-route-card");
  ui.routeList = document.querySelector("#settings-route-list");
  ui.routeAdd = document.querySelector("#settings-route-add");
  ui.routeField = document.querySelector("#settings-route-field");
  ui.routeMinutes = document.querySelector("#settings-route-minutes");
  ui.routeStatus = document.querySelector("#settings-route-status");
  ui.genHint = document.querySelector("#settings-gen-hint");
  ui.genStatus = document.querySelector("#settings-gen-status");
  ui.genDir = document.querySelector("#settings-gen-dir");
  ui.genDetail = document.querySelector("#settings-gen-detail");
  ui.genCheck = document.querySelector("#settings-gen-check");
  ui.genReveal = document.querySelector("#settings-gen-reveal");
  ui.genDirPick = document.querySelector("#settings-gen-dir-pick");
  ui.genDirReset = document.querySelector("#settings-gen-dir-reset");
  ui.genError = document.querySelector("#settings-gen-error");

  ui.pick.addEventListener("click", pickRoot);
  ui.reveal.addEventListener("click", reveal);
  ui.reset.addEventListener("click", reset);
  ui.ffmpegReveal.addEventListener("click", revealFfmpegDir);
  ui.ffmpegRecheck.addEventListener("click", refreshFfmpeg);
  ui.mcpCopy.addEventListener("click", copyMcpConfig);
  ui.mcpReset.addEventListener("click", resetMcpToken);
  ui.cosmosUpgrade.addEventListener("click", upgradeCosmosTextures);
  ui.cosmosCancel.addEventListener("click", cancelCosmosTextures);
  ui.cosmosClear.addEventListener("click", clearCosmosTextures);
  ui.genCheck.addEventListener("click", runGenCheck);
  ui.genReveal.addEventListener("click", revealGenDir);
  ui.genDirPick.addEventListener("click", pickGenDir);
  ui.genDirReset.addEventListener("click", () => setGenDir(null));
  setupMoveEvents();
  setupCosmosEvents();
  setupRoute();
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
  refreshMcp();
  refreshCosmos();
  refreshGen();
  paintRouteCard();
  renderRoute();
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

/* ---------- Agent 连接（MCP） ---------- */

function showMcpError(message) {
  ui.mcpError.textContent = message || "";
  ui.mcpError.hidden = !message;
}

function showMcpStatus(message) {
  clearTimeout(mcpStatusTimer);
  ui.mcpStatus.textContent = message;
  ui.mcpStatus.hidden = false;
  mcpStatusTimer = setTimeout(() => {
    ui.mcpStatus.hidden = true;
  }, 3000);
}

function mcpConfigText() {
  if (!mcpInfo?.running) return "";
  return JSON.stringify(
    {
      mcpServers: {
        inspace: {
          type: "http",
          url: mcpInfo.url,
          headers: { Authorization: `Bearer ${mcpInfo.token}` },
        },
      },
    },
    null,
    2,
  );
}

async function refreshMcp() {
  showMcpError("");
  try {
    mcpInfo = await invoke("mcp_info");
  } catch (error) {
    mcpInfo = null;
    ui.mcpUrl.textContent = "状态读取失败";
    ui.mcpCopy.disabled = true;
    showMcpError(String(error));
    return;
  }
  if (!mcpInfo?.running) {
    ui.mcpUrl.textContent = "本地服务没有启动";
    ui.mcpCopy.disabled = true;
    showMcpError(mcpInfo?.error || "本地 MCP 服务没有启动");
    return;
  }
  ui.mcpUrl.textContent = mcpInfo.url;
  ui.mcpCopy.disabled = false;
}

async function copyMcpConfig() {
  const text = mcpConfigText();
  if (!text) {
    showMcpError("连接配置还没准备好");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showMcpError("");
    showMcpStatus("已复制连接配置");
  } catch (error) {
    showMcpError(`复制失败：${error}`);
  }
}

async function resetMcpToken() {
  const ok = await confirmDialog({
    title: "重置 MCP token",
    message: "已经连上的 agent 会断开，需要重新复制新的连接配置给它们。",
    okText: "重置",
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke("mcp_reset_token");
    await refreshMcp();
    showMcpStatus("token 已重置，请重新复制连接配置");
  } catch (error) {
    showMcpError(String(error));
  }
}

/* ---------- 宇宙贴图 ---------- */

/* 内置 2K 是保底，8K 只服务一件事：飞近贴脸时表面别糊。
   下全了这张卡就该安静下来——一行状态加一个清除，说明文案收掉，
   因为这时候用户没有任何事要干。下载中才把进度摊开。 */
let cosmosStatus = null;
let cosmosLive = null;
const TEX_LABEL = {
  "earth-day": "地球白天面",
  "earth-night": "地球夜面",
  moon: "月球",
  mars: "火星",
  jupiter: "木星",
  saturn: "土星",
  "saturn-ring": "土星环",
};

function showCosmosError(message) {
  ui.cosmosError.textContent = message;
  ui.cosmosError.hidden = !message;
}

function mibText(bytes) {
  if (!bytes) return "0 MB";
  const mib = bytes / 1024 / 1024;
  return `${mib >= 10 ? Math.round(mib) : mib.toFixed(1)} MB`;
}

async function refreshCosmos() {
  showCosmosError("");
  try {
    cosmosStatus = await invoke("cosmos_tex_status");
  } catch (error) {
    cosmosStatus = null;
    ui.cosmosStatus.textContent = "贴图状态读取失败";
    ui.cosmosUpgrade.disabled = true;
    showCosmosError(String(error));
    return;
  }
  paintCosmos();
}

function paintCosmos() {
  const s = cosmosStatus;
  const downloading = Boolean(cosmosLive) || s.running;
  ui.cosmosHint.hidden = s.complete && !downloading;
  ui.cosmosDir.hidden = s.empty;
  ui.cosmosDir.textContent = s.dir;
  ui.cosmosClear.hidden = s.empty;
  /* 七张齐了就没有可下的了，只留「清除」；下载按钮只在还缺东西时出现 */
  ui.cosmosUpgrade.hidden = downloading || s.complete;
  ui.cosmosCancel.hidden = !downloading;
  if (downloading) return;
  if (s.complete) {
    ui.cosmosStatus.textContent = `星体表面用 8K 贴图（${mibText(s.bytes)}）`;
    return;
  }
  if (s.empty) {
    ui.cosmosStatus.textContent = "星体表面用内置 2K 贴图";
    return;
  }
  ui.cosmosStatus.textContent = `8K 只下到 ${s.got}/${s.total}（${mibText(s.bytes)}）`;
}

function setupCosmosEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  Promise.resolve(
    listen("cosmos-textures", (event) => {
      const payload = event?.payload;
      if (!payload) return;
      if (["done", "partial", "canceled"].includes(payload.state)) {
        cosmosLive = null;
        refreshCosmos().then(() => announceCosmosTextures());
        if (payload.error) showCosmosError(payload.error);
        else if (payload.state === "done") ui.cosmosStatus.textContent = "8K 贴图已就位";
        return;
      }
      cosmosLive = payload;
      if (payload.state !== "downloading") return;
      const share = payload.expected
        ? ` · ${Math.round((payload.received / payload.expected) * 100)}%`
        : "";
      ui.cosmosStatus.textContent =
        `正在下载 ${payload.index}/${payload.total} · ` +
        `${TEX_LABEL[payload.name] || "星体"} ${mibText(payload.received)}${share}`;
    }),
  ).catch(() => {});
}

/* 贴图档位变了，宇宙主题那边要重新问一次状态：正在飞的航线下一颗就该用新档。 */
function announceCosmosTextures() {
  window.dispatchEvent(new CustomEvent("cosmos-textures-changed"));
}

async function upgradeCosmosTextures() {
  showCosmosError("");
  try {
    cosmosLive = { state: "starting" };
    ui.cosmosStatus.textContent = "开始下载…";
    await invoke("cosmos_tex_upgrade");
    paintCosmos();
  } catch (error) {
    cosmosLive = null;
    showCosmosError(String(error));
    paintCosmos();
  }
}

async function cancelCosmosTextures() {
  try {
    await invoke("cosmos_tex_cancel");
    ui.cosmosStatus.textContent = "正在取消…";
  } catch (error) {
    showCosmosError(String(error));
  }
}

async function clearCosmosTextures() {
  const ok = await confirmDialog({
    title: "清除 8K 贴图",
    message: "删掉下载的那 7 张 8K，星体回到内置 2K。文件进系统回收站，随时能再下一遍。",
    okText: "清除",
    danger: true,
  });
  if (!ok) return;
  showCosmosError("");
  try {
    await invoke("cosmos_tex_reset");
    cosmosLive = null;
    await refreshCosmos();
    announceCosmosTextures();
  } catch (error) {
    showCosmosError(String(error));
  }
}

/* ---------- 生图模型 ---------- */

/* 权重四件：VAE 和视觉投影跟模型一对一、没得挑，DiT 和文本编码器各有量化档。
   打开设置只读一行状态（gen_status 不探测，随时可读）；点「检测模型」才摊开整块结论：
   这台机器的内存和盘装得下哪一档 → 建议哪一档 → 还缺哪几个文件、去哪儿下 →
   目录里真有的文件摊成两列让他直接选。列文件比造「低/中/高」那种预设诚实：
   下了什么就看到什么，体积摆在右手边自己权衡。 */
let genState = null;
let genModels = null;
let genChecked = false;
let genBusy = false;

function showGenError(message) {
  ui.genError.textContent = message;
  ui.genError.hidden = !message;
}

function lockGen(on) {
  genBusy = on;
  for (const button of [ui.genCheck, ui.genReveal, ui.genDirPick, ui.genDirReset]) {
    button.disabled = on;
  }
  ui.genCheck.textContent = on ? "检测中…" : genChecked ? "重新检测" : "检测模型";
}

async function refreshGen() {
  showGenError("");
  /* 每次打开设置都从「收起」开始：健康态就一行状态加一个目录，摊开是他自己点出来的 */
  genChecked = false;
  try {
    genState = await invoke("gen_status");
  } catch (error) {
    genState = null;
    ui.genStatus.textContent = "模型状态读取失败";
    ui.genDir.textContent = "";
    ui.genDetail.hidden = true;
    ui.genHint.hidden = true;
    ui.genDirReset.hidden = true;
    lockGen(false);
    showGenError(String(error));
    return;
  }
  paintGen();
}

function paintGen() {
  const s = genState;
  if (!s) return;
  ui.genStatus.textContent = s.missing.length
    ? `缺 ${s.missing.length} 个模型文件，出图起不来：${s.missing.join("、")}`
    : `当前 ${s.dit} + ${s.encoder}`;
  ui.genDir.textContent = s.modelsDir;
  /* 「往里扔文件就行」这句只在还缺东西时才需要说 */
  ui.genHint.hidden = !s.missing.length;
  ui.genDirReset.hidden = s.dirIsDefault;
  ui.genCheck.textContent = genChecked ? "重新检测" : "检测模型";
  ui.genDetail.hidden = !(genChecked && genModels);
  if (genChecked && genModels) renderGenDetail();
}

async function runGenCheck() {
  if (genBusy) return;
  lockGen(true);
  showGenError("");
  try {
    genModels = await invoke("gen_models");
    genChecked = true;
    /* 检测顺带把状态行也刷新了：换档、换目录之后的缺件情况在这儿一次看到 */
    genState = await invoke("gen_status").catch(() => genState);
  } catch (error) {
    showGenError(String(error));
  } finally {
    lockGen(false);
  }
  paintGen();
}

function genText(text, className) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function genSpan(text, className) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function mbText(mb) {
  return mb ? `${(mb / 1024).toFixed(1)} GB` : "认不到";
}

function renderGenDetail() {
  const m = genModels;
  const box = ui.genDetail;
  box.replaceChildren();
  box.append(
    genText(
      `显卡 ${m.machine.gpu || "没认到"} · 显存 ${mbText(m.machine.vramMb)} · 内存空闲 ${mbText(
        m.machine.ramAvailMb,
      )} · 这个盘还剩 ${mbText(m.machine.dirFreeMb)}`,
      "settings-gen-line",
    ),
  );
  box.append(genText(m.advice, "settings-gen-line is-advice"));
  const lacking = m.needed.filter((row) => !row.present && !row.optional);
  if (lacking.length) {
    box.append(genText(`这几个文件还没有，下好扔进上面那个文件夹就行：`, "settings-gen-line is-title"));
    box.append(genNeededBlock(m));
    box.append(genText("画图模型的量化档，从省内存到费内存：", "settings-gen-line is-title"));
    box.append(genTierBlock(m));
  }
  if (m.dit.length || m.encoder.length) {
    box.append(genText("目录里已经有这些，点一个当场记下，下一次出图生效：", "settings-gen-line is-title"));
    const cols = document.createElement("div");
    cols.className = "settings-gen-cols";
    cols.append(genColumn("画图模型", "dit"), genColumn("文本编码器", "encoder"));
    const fixed = document.createElement("p");
    fixed.className = "settings-gen-fixed";
    fixed.textContent = `跟着模型定死：${
      m.fixed.map((file) => `${file.name}（${formatBytes(file.bytes)}）`).join(" · ") ||
      "这目录里还没有 VAE 和视觉投影"
    }`;
    cols.append(fixed);
    box.append(cols);
  } else {
    box.append(genText("这个目录里还没有可选的模型档：先把上面那几个文件放进去。", "settings-gen-line"));
  }
}

/* 下载清单的字节数取仓库里的真数，和本地文件大小无关——这一栏说的是「该下什么」。 */
function genNeededBlock(m) {
  const wrap = document.createElement("div");
  wrap.className = "settings-gen-files";
  for (const row of m.needed) {
    const line = document.createElement("div");
    line.className = `settings-gen-file${row.present ? "" : " is-missing"}`;
    line.append(
      genSpan(row.role, "settings-gen-role"),
      genSpan(row.name, "settings-gen-name"),
      genSpan(formatBytes(row.bytes), "settings-gen-size"),
      genSpan(row.present ? "已有" : row.optional ? "缺（可先不下）" : "缺", "settings-gen-state"),
    );
    const link = document.createElement("button");
    link.type = "button";
    link.className = "settings-gen-link";
    link.textContent = "下载页";
    link.addEventListener("click", async () => {
      try {
        await invoke("plugin:opener|open_url", { url: row.page });
      } catch {
        showGenError("打不开这个链接（系统浏览器调用失败）");
      }
    });
    line.append(link);
    wrap.append(line);
  }
  return wrap;
}

function genTierBlock(m) {
  const wrap = document.createElement("div");
  wrap.className = "settings-gen-files";
  for (const tier of m.tiers) {
    const line = document.createElement("div");
    line.className = `settings-gen-file${tier.recommended ? " is-recommended" : ""}`;
    line.append(
      genSpan(tier.name, "settings-gen-name"),
      genSpan(formatBytes(tier.bytes), "settings-gen-size"),
    );
    if (tier.recommended) line.append(genSpan("这台机器建议", "settings-gen-state"));
    if (tier.present) line.append(genSpan("已在目录里", "settings-gen-state"));
    wrap.append(line);
  }
  return wrap;
}

function slotOf(kind) {
  return kind === "dit"
    ? { list: genModels.dit, current: genModels.currentDit }
    : { list: genModels.encoder, current: genModels.currentEncoder };
}

function genColumn(title, kind) {
  const { list, current } = slotOf(kind);
  const col = document.createElement("div");
  col.className = "settings-gen-col";
  const head = document.createElement("p");
  head.className = "settings-gen-col-title";
  head.textContent = list.length ? title : `${title}：一个都没有`;
  col.append(head);
  for (const file of list) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "settings-gen-opt";
    if (file.name === current) row.classList.add("is-current");
    const name = document.createElement("span");
    name.className = "settings-gen-name";
    name.textContent = file.name;
    const size = document.createElement("span");
    size.className = "settings-gen-size";
    size.textContent = formatBytes(file.bytes);
    row.append(name, size);
    row.addEventListener("click", () => pickGenModel(kind, file.name));
    col.append(row);
  }
  return col;
}

async function pickGenModel(kind, name) {
  if (genBusy || !genModels || slotOf(kind).current === name) return;
  lockGen(true);
  showGenError("");
  try {
    genModels = await invoke("gen_models_set", kind === "dit" ? { dit: name } : { encoder: name });
    genState = await invoke("gen_status").catch(() => genState);
  } catch (error) {
    showGenError(String(error));
  } finally {
    lockGen(false);
  }
  paintGen();
}

async function revealGenDir() {
  if (genBusy) return;
  showGenError("");
  try {
    await invoke("gen_models_reveal");
  } catch (error) {
    showGenError(String(error));
  }
}

/* 换目录是「选完就认」，不弹确认也不留保存按钮：挑的时候已经看清是哪个文件夹了。
   换完直接摊开检测结果——新目录里有没有东西，这一眼就是要给他的答复。 */
async function setGenDir(dir) {
  if (genBusy) return;
  lockGen(true);
  showGenError("");
  try {
    genModels = await invoke("gen_models_dir_set", { dir });
    genState = await invoke("gen_status").catch(() => genState);
    genChecked = true;
  } catch (error) {
    showGenError(String(error));
  } finally {
    lockGen(false);
  }
  paintGen();
}

async function pickGenDir() {
  if (genBusy) return;
  showGenError("");
  let picked = null;
  try {
    picked = await invoke("gen_models_dir_pick");
  } catch (error) {
    showGenError(String(error));
    return;
  }
  if (picked) await setGenDir(picked);
}

/* ---------- 遨游星球 ---------- */

/* 名单和间隔都存在 cosmos.js 那一侧（localStorage），这里只是它的界面：
   点一下就写回并立刻重排前方那些还只是亮点的星体，不放「保存」。 */

function renderRoute() {
  const route = cosmosRoute();
  const nameOf = new Map(route.types.map((t) => [t.type, t.name]));
  /* 真的在编辑时才不盖用户敲的字（agent 从 MCP 改值也会重画这张卡） */
  const editing = document.activeElement === ui.routeMinutes && !ui.routeMinutes.readOnly;
  if (!editing) ui.routeMinutes.value = String(route.minutes);
  ui.routeList.textContent = "";
  route.order.forEach((type, i) => {
    const item = document.createElement("li");
    item.className = "settings-route-item";
    const index = document.createElement("span");
    index.className = "settings-route-index";
    index.textContent = String(i + 1);
    const name = document.createElement("span");
    name.className = "settings-route-name";
    name.textContent = nameOf.get(type) || type;
    const ops = document.createElement("span");
    ops.className = "settings-route-ops";
    /* 首行没有上移、末行没有下移、只剩一颗时不许移除：没有意义的操作干脆不出现 */
    const wanted = [
      i > 0 && ["up", "上移"],
      i < route.order.length - 1 && ["down", "下移"],
      route.order.length > 1 && ["remove", "移除"],
    ].filter(Boolean);
    for (const [op, text] of wanted) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-route-op";
      button.dataset.op = op;
      button.dataset.index = String(i);
      button.textContent = text;
      ops.append(button);
    }
    item.append(index, name, ops);
    ui.routeList.append(item);
  });
  ui.routeAdd.textContent = "";
  for (const t of route.types) {
    if (route.order.includes(t.type)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "notes-btn";
    button.dataset.add = t.type;
    button.textContent = `加入${t.name}`;
    ui.routeAdd.append(button);
  }
  ui.routeAdd.hidden = !ui.routeAdd.childElementCount;
}

function setupRoute() {
  ui.routeList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-op]");
    if (!button) return;
    const order = cosmosRoute().order;
    const i = Number(button.dataset.index);
    if (button.dataset.op === "remove") {
      order.splice(i, 1);
    } else {
      const j = button.dataset.op === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
    }
    commitRoute(order, null, "名单已更新");
  });
  ui.routeAdd.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-add]");
    if (!button) return;
    commitRoute([...cosmosRoute().order, button.dataset.add], null, "名单已更新");
  });
  /* 平时只是个数，双击才进编辑、失焦就存：单击和滚轮都不该误改飞行时间。
     越界由 cosmos.js 那边夹好再回填，敲的不是数字就回显当前值、不写。 */
  ui.routeField.addEventListener("dblclick", () => {
    ui.routeMinutes.readOnly = false;
    ui.routeMinutes.focus();
    ui.routeMinutes.select();
  });
  ui.routeMinutes.addEventListener("blur", () => {
    if (ui.routeMinutes.readOnly) return;
    ui.routeMinutes.readOnly = true;
    const raw = ui.routeMinutes.value.trim();
    /* 清空或敲了非数字：回显当前值，不写——Number("") 是 0，会被夹成下限 1 */
    if (!raw || !Number.isFinite(Number(raw))) {
      renderRoute();
      return;
    }
    const route = commitRoute(null, raw);
    showRouteStatus(`下一颗约 ${route.minutes} 分钟后遇到`);
  });
  ui.routeMinutes.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.target.blur();
    } else if (event.key === "Escape") {
      event.target.value = String(cosmosRoute().minutes);
      event.target.readOnly = true;
      event.target.blur();
    }
  });
  document.addEventListener("themechange", paintRouteCard);
  /* 值是从 cosmos.js 那一侧改的（MCP 也走那儿），卡片跟着重画 */
  window.addEventListener("cosmos-route-changed", renderRoute);
}

function commitRoute(order, minutes, status) {
  const route = cosmosRouteSet(order, minutes);
  if (status) showRouteStatus(status);
  return route;
}

/* 这条航线只在宇宙主题下有意义，切走主题就整张卡收掉 */
function paintRouteCard() {
  ui.routeCard.hidden = currentTheme() !== "cosmos";
}

let routeStatusTimer = 0;

function showRouteStatus(message) {
  clearTimeout(routeStatusTimer);
  ui.routeStatus.textContent = message;
  ui.routeStatus.hidden = false;
  routeStatusTimer = setTimeout(() => {
    ui.routeStatus.hidden = true;
  }, 3000);
}
