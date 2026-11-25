/* 设置窗口的内容：数据文件夹、图片生成、宇宙贴图、航线、MCP、视频组件。

   这个模块只管各页里的控件和状态，窗口长什么样、左侧菜单选哪一项由
   settings-window.js 负责。所有路径/模型目录都在 Rust 侧，主窗口和这里读写同一份。

   视频组件只在没认到的时候才出现：那种情况下用户需要「把 ffmpeg.exe 放进哪个文件夹」
   和「放完了点一下重新检测」，整张卡就是为这两步存在的。认到了就一行都不显示，
   因为这时候他没有任何事可干——音轨转 AAC 是画布里点播放时顺手做的。 */

import { choiceDialog, confirmDialog, progressDialog } from "./dialog.js";
import { currentTheme } from "./theme.js";
import { cosmosRoute, cosmosRouteSet } from "./cosmos.js";
import { assistantApiConfig, assistantApiSet, assistantModelVision, assistantModels, skillDelete, skillsDir, skillsList } from "./assistant-store.js";

const { invoke } = window.__TAURI__.core;
const { emitTo } = window.__TAURI__.event;

const ui = {};
let statusTimer = 0;
let currentRoot = "";
let mcpInfo = null;
let mcpStatusTimer = 0;
let onFfmpegState = null;

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

/* options.onFfmpegState(found)：视频组件这一页只在缺 ffmpeg 时才出现在菜单里，
   检测是异步的，检测完让窗口那边同步菜单。 */
export function initSettings(options = {}) {
  onFfmpegState = options.onFfmpegState || null;
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
  ui.genApi = document.querySelector("#settings-gen-api");
  ui.genApiProtocol = document.querySelector("#settings-gen-api-protocol");
  ui.genApiUrl = document.querySelector("#settings-gen-api-url");
  ui.genApiModel = document.querySelector("#settings-gen-api-model");
  ui.genApiModels = document.querySelector("#settings-gen-api-models");
  ui.genApiHint = document.querySelector("#settings-gen-api-hint");
  ui.genApiKey = document.querySelector("#settings-gen-api-key");
  ui.genApiParallel = document.querySelector("#settings-gen-api-parallel");
  ui.genApiReload = document.querySelector("#settings-gen-api-reload");
  ui.genApiStatus = document.querySelector("#settings-gen-api-status");
  ui.genApiError = document.querySelector("#settings-gen-api-error");
  ui.videoProtocol = document.querySelector("#settings-video-protocol");
  ui.videoUrl = document.querySelector("#settings-video-url");
  ui.videoKey = document.querySelector("#settings-video-key");
  ui.videoModel = document.querySelector("#settings-video-model");
  ui.videoModels = document.querySelector("#settings-video-models");
  ui.videoHint = document.querySelector("#settings-video-hint");
  ui.videoParallel = document.querySelector("#settings-video-parallel");
  ui.videoReload = document.querySelector("#settings-video-reload");
  ui.videoStatus = document.querySelector("#settings-video-status");
  ui.videoError = document.querySelector("#settings-video-error");
  ui.videoCloudBox = document.querySelector("#settings-video-cloud");
  ui.videoDir = document.querySelector("#settings-video-dir");
  ui.assistantProtocol = document.querySelector("#settings-assistant-protocol");
  ui.assistantUrl = document.querySelector("#settings-assistant-url");
  ui.assistantKey = document.querySelector("#settings-assistant-key");
  ui.assistantModel = document.querySelector("#settings-assistant-model");
  ui.assistantModels = document.querySelector("#settings-assistant-models");
  ui.assistantTemperature = document.querySelector("#settings-assistant-temperature");
  ui.assistantMaxTokens = document.querySelector("#settings-assistant-maxtokens");
  ui.assistantSystem = document.querySelector("#settings-assistant-system");
  ui.assistantConfirm = document.querySelector("#settings-assistant-confirm");
  ui.assistantVision = document.querySelector("#settings-assistant-vision");
  ui.assistantModelsBtn = document.querySelector("#settings-assistant-models-btn");
  ui.assistantTest = document.querySelector("#settings-assistant-test");
  ui.assistantStatus = document.querySelector("#settings-assistant-status");
  ui.assistantError = document.querySelector("#settings-assistant-error");
  ui.skillList = document.querySelector("#settings-skill-list");
  ui.skillDir = document.querySelector("#settings-skill-dir");

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
  for (const field of [ui.genApiUrl, ui.genApiKey]) {
    /* 地址和 Key 填完就去把模型列表读回来：模型名不给手填，只能从列表里挑 */
    field.addEventListener("blur", async () => {
      await saveGenApiForm();
      await reloadGenApiModels();
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        field.blur();
      }
    });
  }
  ui.genApiModel.addEventListener("change", saveGenApiForm);
  ui.genApiParallel.addEventListener("change", saveGenApiForm);
  ui.genApiProtocol.addEventListener("change", async () => {
    /* 换了协议就是换了服务商：旧模型名不一定还在，清掉让人重挑，
       免得拿着上一家的模型名去发请求，报一串看不懂的 404 */
    ui.genApiModel.value = "";
    ui.genApiModels.replaceChildren();
    paintGenApi();
    await saveGenApiForm();
    await reloadGenApiModels();
  });
  ui.genApiReload.addEventListener("click", reloadGenApiModels);
  ui.videoProtocol.addEventListener("change", async () => {
    /* 换协议就是换了一家，旧模型名不一定还在 */
    ui.videoModel.value = "";
    ui.videoModels.replaceChildren();
    paintVideoUrl();
    await saveVideoForm();
    await reloadVideoModels();
  });
  for (const field of [ui.videoUrl, ui.videoKey]) {
    field.addEventListener("blur", async () => {
      await saveVideoForm();
      await reloadVideoModels();
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        field.blur();
      }
    });
  }
  ui.videoModel.addEventListener("change", saveVideoForm);
  ui.videoParallel.addEventListener("change", saveVideoForm);
  ui.videoReload.addEventListener("click", () => reloadVideoModels());
  ui.assistantUrl.addEventListener("blur", () => void saveAssistantForm());
  ui.assistantKey.addEventListener("blur", () => void saveAssistantForm());
  ui.assistantTemperature.addEventListener("change", () => void saveAssistantForm());
  ui.assistantMaxTokens.addEventListener("change", () => void saveAssistantForm());
  ui.assistantSystem.addEventListener("blur", () => void saveAssistantForm());
  ui.assistantConfirm.addEventListener("change", () => void saveAssistantForm());
  ui.assistantVision.addEventListener("change", () => void saveAssistantForm());
  ui.assistantModel.addEventListener("change", async () => {
    ui.assistantVision.checked = await assistantModelVision(ui.assistantModel.value).catch(() => false);
    await saveAssistantForm();
  });
  ui.assistantProtocol.addEventListener("change", async () => {
    await saveAssistantForm();
    await reloadAssistantModels();
  });
  ui.assistantModelsBtn.addEventListener("click", () => reloadAssistantModels());
  ui.assistantTest.addEventListener("click", () => testAssistant());
  /* 技能不在这儿装：安装走对话（助手有 skill_install / skill_save），
     这一页只负责把装好的列出来、能删掉，外加一个看文件的入口 */
  ui.skillDir?.addEventListener("click", () => {
    skillsDir().then((dir) => invoke("canvas_export_reveal", { path: dir })).catch((error) => showAssistantError(String(error)));
  });
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
  refreshVideo();
  refreshAssistant();
  paintRouteCard();
  renderRoute();
}

function sameDir(a, b) {
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function countText(counts) {
  const bits = [];
  if (counts.canvases) bits.push(`${counts.canvases} 个画布`);
  return bits.join("、");
}

const hasAny = (counts) => counts.canvases > 0;

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

/* 主窗口和设置窗口是两个 webview：换完数据根要让它重新进一次画布，
   不然页面上还挂着旧目录那些内容。 */
function broadcast(name, payload = {}) {
  emitTo("main", name, payload).catch(() => {});
}

function applyRoot(path, mode) {
  currentRoot = path;
  ui.path.textContent = path;
  window.dispatchEvent(new Event("data-root-changed"));
  broadcast("inspace:data-root-changed");
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

/* 认到了就什么都不显示：这时候用户没事儿可干——转音轨是画布里点播放时顺手做的。
   只有没认到（或检测本身出错）才摆出修复入口：放哪儿、打开文件夹、重新检测。 */
async function refreshFfmpeg() {
  showFfmpegError("");
  try {
    const status = await invoke("ffmpeg_status");
    ui.ffmpegCard.hidden = status.found;
    if (!status.found) ui.ffmpegDir.textContent = status.componentsDir;
    onFfmpegState?.(status.found);
  } catch (error) {
    ui.ffmpegCard.hidden = false;
    showFfmpegError(String(error));
    onFfmpegState?.(false);
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

/* ---------- 图片生成 ---------- */

/* 只剩远端 API 一条路：本地扩散引擎和本地放大模型都已移除，这里就是一张接口配置表。
   Key 存在本机设置库里，这个窗口要能接着编辑所以原样带回；别的地方只报「配没配好」。 */
let genApi = { enabled: true, protocol: "images", baseUrl: "", apiKey: "", model: "", parallel: 2 };
let genBusy = false;

/* 七种协议：前两种是 OpenAI 的形状，其余各家按官方接口来。
   地址留空就用该协议的官方默认，所以占位符写的就是那个默认值。 */
const GEN_API_PROTOCOLS = new Set([
  "images",
  "chat",
  "gemini",
  "dashscope",
  "ark",
  "minimax",
  "custom",
]);

const GEN_API_URL_HINTS = {
  images: "https://api.openai.com/v1",
  chat: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
  dashscope: "https://dashscope.aliyuncs.com",
  ark: "https://ark.cn-beijing.volces.com/api/v3",
  minimax: "https://api.minimax.cn",
  custom: "https://你的网关/完整生成地址",
};

/* 每个协议自己要交代的事：地址怎么填、能不能带参考图、模型在哪取。
   写在提示行里，省得用户一个个试出来。 */
const GEN_API_HINTS = {
  images: "填到 /v1 为止，程序自己拼 /images/generations 和 /images/edits。支持参考图与局部重绘（可带遮罩）。",
  chat: "填到 /v1 为止，走 /chat/completions 多模态。能带参考图，但尺寸由模型定，控制不了。",
  gemini: "地址可留空（用官方）。模型挑 gemini-*-image 那几档能带参考图，imagen-* 只吃文生图；比例按最接近的一档取。",
  dashscope: "地址可留空（用官方）。文生图是原生异步，出图要轮询几十秒；参考图只收公网 URL，画布里的本地图发不进去。想用 qwen-image 走兼容模式，请选 OpenAI Images 协议、地址填 …/compatible-mode/v1。",
  ark: "填到 /api/v3 为止。形状同 OpenAI Images；参考图只收公网 URL，画布里的本地图发不进去。",
  minimax: "地址可留空（用国内站）。同步返回；参考图走 subject_reference，一次只带一张。",
  custom: "接口地址填完整的生成地址（不再拼路径）。按 OpenAI 图片的 JSON 格式发，不带参考图。",
};

function showGenApiError(message) {
  ui.genApiError.textContent = message;
  ui.genApiError.hidden = !message;
}

function showGenApiStatus(message) {
  ui.genApiStatus.textContent = message || "";
  ui.genApiStatus.hidden = !message;
}

function apiProblem(config = genApi) {
  /* 除自定义之外都有官方默认地址，地址留空不算缺（和后端 problem() 保持一致） */
  if (config.protocol === "custom" && !config.baseUrl.trim()) return "接口地址";
  if (!config.model.trim()) return "模型名";
  if (!(config.apiKey || "").trim()) return "API Key";
  return "";
}

/* 协议换了，提示行和地址占位符跟着换 —— 各家的默认地址和能不能带图都不一样 */
function paintGenApi() {
  const protocol = ui.genApiProtocol.value;
  ui.genApiUrl.placeholder = GEN_API_URL_HINTS[protocol] || "";
  ui.genApiHint.textContent = GEN_API_HINTS[protocol] || "";
}

function fillGenApiForm() {
  ui.genApiProtocol.value = GEN_API_PROTOCOLS.has(genApi.protocol)
    ? genApi.protocol
    : "images";
  ui.genApiUrl.value = genApi.baseUrl || "";
  ui.genApiKey.value = genApi.apiKey || "";
  ui.genApiParallel.value = String(genApi.parallel || 2);
  fillModelOptions([]);
  paintGenApi();
}

/* 模型名改成可编辑的输入框：万相、MiniMax 这些没有 /models 接口，
   只能给一份内置清单，用户还得能自己填新模型。清单挂成候选，不挡手填。 */
function fillModelOptions(names) {
  const current = genApi.model || "";
  const list = [...new Set(names)];
  if (current && !list.includes(current)) list.unshift(current);
  ui.genApiModels.replaceChildren();
  for (const name of list) ui.genApiModels.append(new Option(name, name));
  if (!ui.genApiModel.value.trim()) {
    ui.genApiModel.value = current || list[0] || "";
  }
  ui.genApiModel.disabled = genBusy;
}

function readGenApiForm() {
  return {
    ...genApi,
    enabled: true,
    protocol: GEN_API_PROTOCOLS.has(ui.genApiProtocol.value)
      ? ui.genApiProtocol.value
      : "images",
    baseUrl: ui.genApiUrl.value.trim(),
    model: ui.genApiModel.value.trim(),
    apiKey: ui.genApiKey.value,
    parallel: Math.min(10, Math.max(1, Math.round(Number(ui.genApiParallel.value) || 2))),
  };
}

async function saveGenApiForm() {
  const next = readGenApiForm();
  if (
    next.protocol === genApi.protocol &&
    next.baseUrl === genApi.baseUrl &&
    next.model === genApi.model &&
    next.apiKey === genApi.apiKey &&
    next.parallel === genApi.parallel
  ) {
    return;
  }
  showGenApiError("");
  try {
    genApi = await invoke("gen_api_set", { config: next });
    const missing = apiProblem();
    showGenApiStatus(missing ? `还差：${missing}` : "");
  } catch (error) {
    showGenApiError(String(error));
  }
}

async function reloadGenApiModels() {
  const form = readGenApiForm();
  /* 万相、方舟、MiniMax 没有列表接口，后端直接给内置清单，不用联网也不用 Key */
  const offline =
    form.protocol === "dashscope" || form.protocol === "minimax" || form.protocol === "ark";
  if (form.protocol === "custom" && !form.baseUrl.trim()) {
    showGenApiError("自定义协议要填完整的生成地址");
    return;
  }
  if (!offline && !(form.apiKey || "").trim()) {
    showGenApiError("先把 API Key 填上");
    return;
  }
  showGenApiError("");
  ui.genApiReload.disabled = true;
  ui.genApiModel.disabled = true;
  showGenApiStatus("读取模型列表…");
  try {
    const names = await invoke("gen_api_models", { config: form });
    fillModelOptions(names);
    showGenApiStatus(`读到 ${names.length} 个模型；挑一个就能出图`);
    /* 清单里预选的不一定是已保存的那个：把它落库，界面显示的就是真会用的 */
    if (ui.genApiModel.value && ui.genApiModel.value !== genApi.model) {
      await saveGenApiForm();
      showGenApiStatus(`读到 ${names.length} 个模型；现在用的是 ${ui.genApiModel.value}`);
    }
  } catch (error) {
    fillModelOptions([]);
    showGenApiStatus("");
    showGenApiError(String(error));
  } finally {
    ui.genApiReload.disabled = false;
    /* 模型框始终可编辑，读不到清单也能手填 */
    ui.genApiModel.disabled = false;
  }
}

/* 打开设置：只读配置和一句状态，不主动打网络——列表要用户点「重新读取模型」。 */
async function refreshGen() {
  showGenApiError("");
  genApi = await invoke("gen_api_get").catch(() => genApi);
  genApi.enabled = true;
  fillGenApiForm();
  const missing = apiProblem();
  showGenApiStatus(
    missing
      ? `还差：${missing}`
      : `已连：${genApi.baseUrl || GEN_API_URL_HINTS[genApi.protocol] || "官方默认地址"} · ${genApi.model}`,
  );
}

/* ---------- 视频生成 API ----------
   视频没有本地兜底，配置好就能用。七种协议：OpenAI 兼容网关去 /models 拉模型，
   其余六家的模型清单在后端内置（各家都没有统一的列表接口）。 */
let videoApi = { protocol: "openai", baseUrl: "", apiKey: "", model: "" };
let videoDefaultDir = "";

const VIDEO_PROTOCOLS = new Set([
  "openai",
  "minimax",
  "dashscope",
  "veo",
  "ark",
  "kling",
  "custom",
]);

const VIDEO_URL_HINTS = {
  openai: "https://api.openai.com/v1",
  minimax: "https://api.minimax.cn",
  dashscope: "https://dashscope.aliyuncs.com",
  veo: "https://generativelanguage.googleapis.com",
  ark: "https://ark.cn-beijing.volces.com/api/v3",
  kling: "https://api-beijing.klingai.com",
  custom: "https://你的网关根地址",
};

/* 各家对首帧、时长、模型名的讲究不一样，写在提示行里省得用户试错 */
const VIDEO_PROTOCOL_HINTS = {
  openai: "填到 /v1 为止，走 /videos。首帧图用 multipart 传，能直接吃画布上的图。",
  minimax: "地址可留空（用国内站）。首帧图吃 Data URL；时长按 6 秒 / 10 秒两档取。",
  dashscope: "地址可留空（用官方）。万相和百炼托管的可灵都走这套；首帧只收公网 URL，画布里的本地图发不进去。",
  veo: "地址可留空（用官方）。模型名要带 -preview 后缀；时长只认 4 / 6 / 8 秒，首帧吃 base64。",
  ark: "填到 /api/v3 为止。比例和时长是接在提示词后面的 --ratio / --duration 写法，程序已经拼好。",
  kling: "地址可留空（用北京站）。模型名照控制台填；时长只有 5 秒和 10 秒两档，首帧走 base64。",
  custom: "接口地址填网关根地址（程序在后面拼 /videos），形状照 OpenAI videos。",
};

function showVideoError(message) {
  ui.videoError.textContent = message;
  ui.videoError.hidden = !message;
}

function showVideoStatus(message) {
  ui.videoStatus.textContent = message || "";
  ui.videoStatus.hidden = !message;
}

function paintVideoUrl() {
  const protocol = ui.videoProtocol.value;
  ui.videoUrl.placeholder = VIDEO_URL_HINTS[protocol] || "";
  ui.videoHint.textContent = VIDEO_PROTOCOL_HINTS[protocol] || "";
}

/* 和图片侧一样：模型框可编辑，清单只当候选 */
function fillVideoModels(names) {
  const current = videoApi.model || "";
  const list = [...new Set(names)];
  if (current && !list.includes(current)) list.unshift(current);
  ui.videoModels.replaceChildren();
  for (const name of list) ui.videoModels.append(new Option(name, name));
  if (!ui.videoModel.value.trim()) {
    ui.videoModel.value = current || list[0] || "";
  }
  ui.videoModel.disabled = false;
}

function fillVideoForm() {
  ui.videoProtocol.value = VIDEO_PROTOCOLS.has(videoApi.protocol)
    ? videoApi.protocol
    : "openai";
  ui.videoUrl.value = videoApi.baseUrl || "";
  ui.videoKey.value = videoApi.apiKey || "";
  ui.videoParallel.value = String(videoApi.parallel || 2);
  paintVideoUrl();
  fillVideoModels([]);
}

async function refreshVideo() {
  videoApi = await invoke("gen_video_api_get").catch(() => videoApi);
  fillVideoForm();
  await reloadVideoModels(true);
}











function readVideoForm() {
  return {
    protocol: ui.videoProtocol.value,
    baseUrl: ui.videoUrl.value.trim(),
    apiKey: ui.videoKey.value,
    model: ui.videoModel.value,
    parallel: Math.min(10, Math.max(1, Math.round(Number(ui.videoParallel.value) || 2))),
  };
}

async function saveVideoForm() {
  const next = readVideoForm();
  if (
    next.protocol === videoApi.protocol &&
    next.baseUrl === videoApi.baseUrl &&
    next.apiKey === videoApi.apiKey &&
    next.model === videoApi.model &&
    next.parallel === videoApi.parallel
  ) {
    return;
  }
  showVideoError("");
  try {
    videoApi = await invoke("gen_video_api_set", { config: next });
  } catch (error) {
    showVideoError(String(error));
  }
}

async function reloadVideoModels(quiet = false) {
  const form = readVideoForm();
  /* 只有 OpenAI 兼容网关和自定义要去拉 /models；其余都是后端内置清单，
     不联网也不需要 Key */
  const needsNetwork = form.protocol === "openai" || form.protocol === "custom";
  if (needsNetwork && !(form.apiKey || "").trim() && !form.baseUrl) {
    fillVideoModels([]);
    showVideoStatus("");
    if (!quiet) showVideoError("先把接口地址或 API Key 填上");
    return;
  }
  showVideoError("");
  ui.videoReload.disabled = true;
  ui.videoModel.disabled = true;
  showVideoStatus("读取模型列表…");
  try {
    const names = await invoke("gen_video_models", { config: form });
    fillVideoModels(names);
    showVideoStatus(`读到 ${names.length} 个模型`);
    if (ui.videoModel.value && ui.videoModel.value !== videoApi.model) {
      await saveVideoForm();
    }
  } catch (error) {
    fillVideoModels([]);
    showVideoStatus("");
    if (quiet) showVideoStatus("模型列表还没读出来，点「读取模型列表」重试");
    else showVideoError(String(error));
  } finally {
    ui.videoReload.disabled = false;
    ui.videoModel.disabled = false;
  }
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
    button.className = "plain-btn";
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



/* ---------- AI 助手 ---------- */

let assistantConfig = null;

function showAssistantStatus(message) {
  ui.assistantStatus.textContent = message || "";
  ui.assistantStatus.hidden = !message;
}

function showAssistantError(message) {
  ui.assistantError.textContent = message;
  ui.assistantError.hidden = !message;
}

function fillAssistantForm(config = assistantConfig) {
  if (!config || !ui.assistantProtocol) return;
  ui.assistantProtocol.value = ["anthropic", "gemini", "ollama", "custom"].includes(config.protocol)
    ? config.protocol
    : "openai";
  ui.assistantUrl.value = config.baseUrl || "";
  ui.assistantKey.value = config.apiKey || "";
  ui.assistantModel.value = config.model || "";
  ui.assistantTemperature.value = String(config.temperature ?? 0.4);
  ui.assistantMaxTokens.value = String(config.maxTokens ?? 4096);
  ui.assistantSystem.value = config.systemPrompt || "";
  ui.assistantConfirm.checked = config.confirmTools !== false;
  ui.assistantVision.checked = Boolean(config.supportsImages);
}

function readAssistantForm() {
  const protocol = ui.assistantProtocol.value;
  const baseUrl = ui.assistantUrl.value.trim();
  let normalized = baseUrl;
  if (protocol === "openai" || protocol === "custom") {
    for (const suffix of ["/chat/completions", "/v1/models", "/models"]) {
      if (normalized.endsWith(suffix)) normalized = normalized.slice(0, -suffix.length);
    }
  }
  return {
    protocol,
    baseUrl: normalized.trim().replace(/\/$/, ""),
    apiKey: ui.assistantKey.value.trim(),
    model: ui.assistantModel.value.trim(),
    temperature: Math.min(2, Math.max(0, Number(ui.assistantTemperature.value) || 0)),
    maxTokens: Math.min(200000, Math.max(64, Math.round(Number(ui.assistantMaxTokens.value) || 4096))),
    systemPrompt: ui.assistantSystem.value,
    confirmTools: ui.assistantConfirm.checked,
    supportsImages: ui.assistantVision.checked,
  };
}

/* 温度和最大 token 填超范围会被夹进合法区间，界面上得显示真正会用的那个数，
   否则框里写着 5、实际发出去的是 2。 */
function syncAssistantNumbers(form) {
  const temperature = String(form.temperature);
  const maxTokens = String(form.maxTokens);
  if (ui.assistantTemperature.value !== temperature) ui.assistantTemperature.value = temperature;
  if (ui.assistantMaxTokens.value !== maxTokens) ui.assistantMaxTokens.value = maxTokens;
}

async function saveAssistantForm() {
  if (!ui.assistantProtocol) return;
  const next = readAssistantForm();
  syncAssistantNumbers(next);
  if (
    assistantConfig &&
    next.protocol === assistantConfig.protocol &&
    next.baseUrl === assistantConfig.baseUrl &&
    next.apiKey === assistantConfig.apiKey &&
    next.model === assistantConfig.model &&
    next.temperature === assistantConfig.temperature &&
    next.maxTokens === assistantConfig.maxTokens &&
    next.systemPrompt === assistantConfig.systemPrompt &&
    next.confirmTools === assistantConfig.confirmTools &&
    next.supportsImages === assistantConfig.supportsImages
  ) {
    return;
  }
  showAssistantError("");
  try {
    assistantConfig = await assistantApiSet(next);
    fillAssistantForm(assistantConfig);
  } catch (error) {
    showAssistantError(String(error));
  }
}

async function reloadAssistantModels() {
  if (!ui.assistantModels) return;
  const form = readAssistantForm();
  showAssistantError("");
  if (!form.baseUrl) {
    ui.assistantModels.replaceChildren();
    showAssistantStatus("先把接口地址填上");
    return;
  }
  ui.assistantModelsBtn.disabled = true;
  ui.assistantTest.disabled = true;
  showAssistantStatus("读取模型…");
  try {
    assistantConfig = await assistantApiSet(form);
    const names = await assistantModels(form);
    ui.assistantModels.replaceChildren(...names.map((name) => new Option(name, name)));
    showAssistantStatus(names.length ? `读到 ${names.length} 个模型` : "没读到模型，可以直接手填模型名");
  } catch (error) {
    showAssistantError(String(error));
    showAssistantStatus("");
  } finally {
    ui.assistantModelsBtn.disabled = false;
    ui.assistantTest.disabled = false;
  }
}

async function testAssistant() {
  showAssistantError("");
  ui.assistantTest.disabled = true;
  showAssistantStatus("测试连接…");
  try {
    assistantConfig = await assistantApiSet(readAssistantForm());
    const names = await assistantModels(assistantConfig);
    showAssistantStatus(
      names.length
        ? `连接正常，读到 ${names.length} 个模型`
        : `连接正常（接口没给模型列表）· 当前模型：${assistantConfig.model || "未填"}`,
    );
  } catch (error) {
    showAssistantError(String(error));
    showAssistantStatus("");
  } finally {
    ui.assistantTest.disabled = false;
  }
}

/* 技能列表：只显示名字和一句话说明，正文在文件里，要改就直接编辑文件 */
function renderSkills(skills) {
  if (!ui.skillList) return;
  ui.skillList.replaceChildren();
  if (!skills.length) {
    const empty = document.createElement("p");
    empty.className = "settings-hint";
    empty.textContent = "还没有技能。在对话里让助手装一个，装好的会出现在这里。";
    ui.skillList.append(empty);
    return;
  }
  for (const skill of skills) {
    const row = document.createElement("div");
    row.className = "settings-skill";
    const text = document.createElement("div");
    text.className = "settings-skill-text";
    const name = document.createElement("p");
    name.className = "settings-skill-name";
    name.textContent = skill.name;
    const desc = document.createElement("p");
    desc.className = "settings-skill-desc";
    desc.textContent = skill.description || "（没有写说明，模型只能看到名字）";
    text.append(name, desc);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "plain-btn";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      del.disabled = true;
      try {
        await skillDelete(skill.id);
        await refreshSkills();
      } catch (error) {
        showAssistantError(String(error));
        del.disabled = false;
      }
    });
    row.append(text, del);
    ui.skillList.append(row);
  }
}

async function refreshSkills() {
  if (!ui.skillList) return;
  try {
    renderSkills(await skillsList());
  } catch (error) {
    showAssistantError(String(error));
  }
}

async function refreshAssistant() {
  if (!ui.assistantProtocol) return;
  showAssistantError("");
  showAssistantStatus("");
  /* 技能列表是本地目录，先画出来：下面读模型要联网，接口没配好会抛错，
     排在它后面的话接口一坏，技能列表就跟着空了 */
  await refreshSkills();
  try {
    assistantConfig = await assistantApiConfig();
    fillAssistantForm(assistantConfig);
    const names = assistantConfig.baseUrl && assistantConfig.apiKey ? await assistantModels(assistantConfig) : [];
    ui.assistantModels.replaceChildren(...names.map((name) => new Option(name, name)));
    ui.assistantVision.checked = await assistantModelVision(assistantConfig.model).catch(
      () => Boolean(assistantConfig.supportsImages),
    );
  } catch (error) {
    showAssistantError(String(error));
  }
}
