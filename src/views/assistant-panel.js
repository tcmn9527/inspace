/* 主窗口右侧 AI 助手面板。
 *
 * 逻辑上分两层：
 * 1) 聊天与工具循环在这里：Rust 只负责把消息发给模型、把模型返回归一化；
 * 2) 真正的画布操作全部走 agent-tools.js 的 runTool，和外部 MCP agent 同一条路。
 *
 * 会话按画布存 localStorage，不进画布目录——换画布不该把聊天记录当内容带走。 */

import { TOOL_LIST, runTool } from "./agent-tools.js";
import { canvasAgent } from "./canvas.js";
import { confirmDialog } from "./dialog.js";
import { assistantApiGet, assistantCancel, assistantChat } from "./assistant-store.js";

const STORE_KEY = "inspace.assistant.open";
const WIDTH_KEY = "inspace.assistant.width";
const COMPOSE_HEIGHT_KEY = "inspace.assistant.compose-height";
const MAX_ROUNDS = 8;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const DANGEROUS = new Set([
  "space_delete",
  "space_import",
  "block_delete",
  "file_write",
  "note_write",
  "image_open",
  "client_web_export",
  "client_pdf_export",
  "export_canvas",
  "gen_run",
  "gen_video",
  "article_template_save",
]);

const HIDDEN_TOOLS = new Set(["ui_close", "ui_reload"]);

let ui = {};
let messages = [];
let running = false;
let canceled = false;
let config = null;
let spaceKey = "";
let images = [];

/* 流式：后端每吐一段就发一条 assistant-delta，这里的 streamEl 直接追加文字，
   不走整页 render——整页重建会把滚动位置和光标打断。 */
let streamSession = "";
let streamText = "";
let streamEl = null;

function toolKey() {
  try {
    return canvasAgent.scene().space.id || "global";
  } catch {
    return "global";
  }
}

function chatKey() {
  return `inspace.assistant.chat.${spaceKey || "global"}`;
}

function readStored() {
  try {
    const raw = localStorage.getItem(chatKey());
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStored() {
  try {
    localStorage.setItem(chatKey(), JSON.stringify(messages.slice(-80)));
  } catch {
    /* 存不下不影响这一轮对话 */
  }
}

function setStatus(text, error = false) {
  if (!ui.status) return;
  ui.status.textContent = text || "";
  ui.status.hidden = !text;
  ui.status.classList.toggle("is-error", Boolean(error));
}

function setBusy(on) {
  running = on;
  ui.send.disabled = on;
  ui.stop.hidden = !on;
  ui.input.readOnly = on;
  if (!on) setStatus("");
}

function render() {
  if (!ui.list) return;
  ui.list.textContent = "";
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "assistant-empty";
    empty.textContent = "给助手一句话，它会自己读画布、调工具、把结果填回来。";
    ui.list.append(empty);
    return;
  }
  for (const msg of messages) {
    if (msg.role === "tool") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const el = document.createElement("div");
    el.className = `assistant-msg ${msg.role}`;
    el.textContent = msg.content || (msg.toolCalls?.length ? `调用 ${msg.toolCalls.length} 个工具…` : "");
    ui.list.append(el);
  }
  ui.list.scrollTop = ui.list.scrollHeight;
}

function trace(name, detail, error = false) {
  const el = document.createElement("div");
  el.className = `assistant-tool${error ? " is-error" : ""}`;
  el.textContent = `${error ? "失败" : "工具"} · ${name}${detail ? `：${detail}` : ""}`;
  ui.list.querySelector(".assistant-empty")?.remove();
  ui.list.append(el);
  ui.list.scrollTop = ui.list.scrollHeight;
}

function toolContent(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
  if (blocks.some((block) => block?.type === "image")) parts.push("[工具返回了图片]");
  const text = parts.join("\n").trim();
  return result?.isError ? `工具报错：${text || "未知错误"}` : text || "完成";
}

function appendDelta(chunk) {
  if (!chunk) return;
  streamText += chunk;
  ui.list.querySelector(".assistant-empty")?.remove();
  if (!streamEl) {
    streamEl = document.createElement("div");
    streamEl.className = "assistant-msg assistant is-streaming";
    ui.list.append(streamEl);
  }
  streamEl.textContent = streamText;
  ui.list.scrollTop = ui.list.scrollHeight;
}

function beginStream(session) {
  streamSession = session;
  streamText = "";
  streamEl = null;
}

/* 收尾把这一轮流出来的文字交回去：事件偶尔会丢最后一小段，
   拿它兜底比让用户看到半句话强。 */
function endStream() {
  const text = streamText;
  streamSession = "";
  streamText = "";
  if (streamEl) streamEl.classList.remove("is-streaming");
  streamEl = null;
  return text;
}

function listenStream() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  listen("assistant-delta", (event) => {
    const payload = event.payload || {};
    if (!streamSession || payload.session !== streamSession) return;
    appendDelta(String(payload.text || ""));
  }).catch(() => {
    /* 没有事件通道就退化成整段返回，不影响功能 */
  });
}

async function runChatLoop() {
  const tools = TOOL_LIST.filter((tool) => !HIDDEN_TOOLS.has(tool.name));
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (canceled) return;
    setStatus(`第 ${round + 1} / ${MAX_ROUNDS} 轮 · 生成中…`);

    const session = `chat-${Date.now()}-${round}`;
    beginStream(session);
    let reply = null;
    let failure = null;
    try {
      reply = await assistantChat({ messages, tools, session });
    } catch (error) {
      failure = error;
    }
    const streamed = endStream();
    if (failure) {
      /* 已经流出来的半截别跟着错误一起消失，看着至少知道断在哪 */
      if (streamed.trim()) {
        messages.push({ role: "assistant", content: streamed.trim() });
        render();
      }
      throw failure;
    }
    if (reply && !reply.text && streamed) reply.text = streamed;

    /* 用户点了停止：把已经流出来的半截留下，后面的工具调用一律不执行 */
    if (reply?.canceled || canceled) {
      const partial = String(reply?.text || "").trim();
      messages.push({ role: "assistant", content: partial ? `${partial}

（已停止）` : "（已停止）" });
      render();
      saveStored();
      return;
    }

    const text = typeof reply?.text === "string" ? reply.text.trim() : "";
    const calls = Array.isArray(reply?.toolCalls) ? reply.toolCalls : [];
    if (text) messages.push({ role: "assistant", content: text });
    if (!calls.length) {
      render();
      saveStored();
      return;
    }
    messages.push({ role: "assistant", content: text, toolCalls: calls });
    render();

    for (const call of calls) {
      if (canceled) return;
      const name = String(call?.name || "");
      const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
      if (config?.confirmTools !== false && DANGEROUS.has(name)) {
        const ok = await confirmDialog({
          title: "AI 助手要执行一个操作",
          message: `${name}
${JSON.stringify(args).slice(0, 400)}`,
          okText: "允许",
          cancelText: "跳过",
          danger: true,
        });
        if (!ok) {
          messages.push({ role: "tool", toolCallId: call.id, name, content: "用户跳过了这个操作" });
          trace(name, "用户跳过");
          continue;
        }
      }
      setStatus(`执行工具 ${name}…`);
      const result = await runTool(name, args);
      if (canceled) return;
      const content = toolContent(result);
      messages.push({ role: "tool", toolCallId: call.id, name, content });
      trace(name, content.slice(0, 180), Boolean(result?.isError));
      saveStored();
    }
  }
  messages.push({ role: "assistant", content: `已执行 ${MAX_ROUNDS} 轮工具调用，先停在这里避免跑飞。你可以继续追问。` });
  render();
  saveStored();
}

async function send(text) {
  if (running || !text.trim()) return;
  canceled = false;
  messages.push({
    role: "user",
    content: text.trim(),
    images: images.map((image) => ({ dataUrl: image.dataUrl, mimeType: image.mimeType })),
  });
  ui.input.value = "";
  images = [];
  renderAttachments();
  render();
  saveStored();
  setBusy(true);
  try {
    config = await assistantApiGet();
    if (!config?.configured || !config?.model) {
      throw new Error("还没配好 AI 助手：去设置 → AI 助手填接口地址、Key 和模型");
    }
    await runChatLoop();
  } catch (error) {
    setStatus(String(error?.message || error || "调用失败"), true);
    trace("请求失败", String(error?.message || error || ""), true);
  } finally {
    setBusy(false);
  }
}

function setOpen(open) {
  ui.panel.hidden = !open;
  ui.toggle.setAttribute("aria-expanded", open ? "true" : "false");
  ui.toggle.title = open ? "收起 AI 助手" : "打开 AI 助手";
  ui.toggle.setAttribute("aria-label", ui.toggle.title);
  try {
    localStorage.setItem(STORE_KEY, open ? "1" : "0");
  } catch {
    /* 不影响使用 */
  }
  if (open) {
    ui.input.focus();
    refreshContext();
  }
}

function refreshContext() {
  try {
    const info = canvasAgent.scene();
    ui.context.textContent = `当前画布：${info.space?.name || "未命名"}`;
  } catch {
    ui.context.textContent = "当前画布：—";
  }
}

function setupResize() {
  let startX = 0;
  let startWidth = 0;
  const onMove = (event) => {
    const width = Math.max(320, Math.min(780, startWidth + startX - event.clientX));
    ui.panel.style.width = `${width}px`;
  };
  const onUp = () => {
    ui.panel.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    try {
      localStorage.setItem(WIDTH_KEY, String(parseInt(ui.panel.style.width, 10) || 420));
    } catch {
      /* 忽略 */
    }
  };
  ui.resize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = ui.panel.getBoundingClientRect().width;
    ui.panel.classList.add("is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

export function initAssistantPanel() {
  ui = {
    panel: document.querySelector("#assistant-panel"),
    toggle: document.querySelector("#assistant-toggle"),
    close: document.querySelector("#assistant-close"),
    newChat: document.querySelector("#assistant-new"),
    model: document.querySelector("#assistant-model"),
    status: document.querySelector("#assistant-status"),
    list: document.querySelector("#assistant-messages"),
    form: document.querySelector("#assistant-form"),
    composeResize: document.querySelector("#assistant-compose-resize"),
    attachments: document.querySelector("#assistant-attachments"),
    attach: document.querySelector("#assistant-attach"),
    file: document.querySelector("#assistant-file"),
    input: document.querySelector("#assistant-input"),
    send: document.querySelector("#assistant-send"),
    stop: document.querySelector("#assistant-stop"),
    context: document.querySelector("#assistant-context"),
    resize: document.querySelector("#assistant-resize"),
  };
  if (!ui.panel || !ui.toggle) return;

  let savedWidth = 420;
  let savedOpen = false;
  try {
    savedWidth = Number(localStorage.getItem(WIDTH_KEY)) || 420;
    savedOpen = localStorage.getItem(STORE_KEY) === "1";
  } catch {
    /* 忽略 */
  }
  ui.panel.style.width = `${savedWidth}px`;
  setOpen(savedOpen);

  ui.toggle.addEventListener("click", () => setOpen(ui.panel.hidden));
  ui.close.addEventListener("click", () => setOpen(false));
  ui.newChat.addEventListener("click", () => {
    messages = [];
    render();
    saveStored();
    setStatus("");
  });
  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send(ui.input.value);
  });
  ui.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(ui.input.value);
    }
  });
  ui.stop.addEventListener("click", () => {
    canceled = true;
    assistantCancel().catch(() => {});
    setStatus("已停止");
  });
  ui.attach.addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", () => {
    void addImages(ui.file.files);
    ui.file.value = "";
  });
  ui.input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  });
  ui.form.addEventListener("dragover", (event) => {
    if (!config?.supportsImages) return;
    event.preventDefault();
    ui.form.classList.add("is-dragover");
  });
  ui.form.addEventListener("dragleave", () => ui.form.classList.remove("is-dragover"));
  ui.form.addEventListener("drop", (event) => {
    if (!config?.supportsImages) return;
    event.preventDefault();
    ui.form.classList.remove("is-dragover");
    void addImages(event.dataTransfer?.files);
  });
  window.addEventListener("inspace:space-changed", refreshContext);

  listenStream();
  assistantApiGet()
    .then((value) => {
      config = value;
      ui.model.textContent = value?.model ? `${value.model}${value.supportsImages ? " · 多模态" : ""}` : "未配置";
      syncImageSupport();
    })
    .catch(() => {
      ui.model.textContent = "未配置";
    });

  spaceKey = toolKey();
  messages = readStored();
  render();
  refreshContext();
  setupResize();
  setupComposeResize();
}


/* 输入框上边缘整条都能拖：往上拖长、往下拖短。原生右下角手柄关掉了，
   免得用户从角上斜着拽，把一行宽高都带歪。 */
function setupComposeResize() {
  let saved = 58;
  try {
    saved = Number(localStorage.getItem(COMPOSE_HEIGHT_KEY)) || 58;
  } catch {
    /* 忽略 */
  }
  ui.input.style.height = `${Math.max(58, Math.min(420, saved))}px`;

  let startY = 0;
  let startHeight = 0;
  const onMove = (event) => {
    const height = Math.max(58, Math.min(420, startHeight + startY - event.clientY));
    ui.input.style.height = `${height}px`;
  };
  const onUp = () => {
    ui.form.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    try {
      localStorage.setItem(COMPOSE_HEIGHT_KEY, String(parseInt(ui.input.style.height, 10) || 58));
    } catch {
      /* 忽略 */
    }
  };
  ui.composeResize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startY = event.clientY;
    startHeight = ui.input.getBoundingClientRect().height;
    ui.form.classList.add("is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}


/* 只有当前模型开了多模态才让放图片；不支持时粘贴/拖入直接忽略并提示一次。 */
function syncImageSupport() {
  if (!ui.attach) return;
  const on = Boolean(config?.supportsImages);
  ui.attach.hidden = !on;
  if (!on && images.length) {
    images = [];
    renderAttachments();
  }
}

function renderAttachments() {
  if (!ui.attachments) return;
  ui.attachments.textContent = "";
  ui.attachments.hidden = !images.length;
  for (const image of images) {
    const box = document.createElement("div");
    box.className = "assistant-attachment";
    const img = document.createElement("img");
    img.src = image.dataUrl;
    img.alt = image.name || "附件";
    const remove = document.createElement("button");
    remove.className = "assistant-attachment-remove";
    remove.type = "button";
    remove.title = "移除";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      images = images.filter((one) => one !== image);
      renderAttachments();
    });
    box.append(img, remove);
    ui.attachments.append(box);
  }
}

async function addImages(fileList) {
  if (!config?.supportsImages) {
    setStatus("当前模型不支持图片输入，先在设置里换模型或勾上多模态", true);
    return;
  }
  const files = [...(fileList || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  const room = MAX_IMAGES - images.length;
  if (room <= 0) {
    setStatus(`最多带 ${MAX_IMAGES} 张图片`, true);
    return;
  }
  for (const file of files.slice(0, room)) {
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus(`「${file.name}」超过 5MB，没加进来`, true);
      continue;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    images.push({ name: file.name, mimeType: file.type, dataUrl });
  }
  renderAttachments();
  if (images.length >= MAX_IMAGES) setStatus(`已到 ${MAX_IMAGES} 张上限`);
}
