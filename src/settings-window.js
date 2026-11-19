/* 设置窗口：左侧平铺菜单，右侧只显示当前这一项。
 *
 * 窗口由 Rust 侧 open_settings_window 创建（label = settings），关闭就是销毁，
 * 下次打开重新读磁盘。主题和主窗口双向同步：主窗口是唯一真源，这里点色卡
 * 先本地生效再通知 main；主窗口那边有任何主题变化也会推回来。 */

import { initSettings, refreshSettings } from "./views/settings.js";
import { THEMES, LIGHT_THEMES, palette, setTheme, currentTheme } from "./views/theme.js";

const { getCurrentWindow } = window.__TAURI__.window;
const { emitTo, listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
const PANE_KEY = "workbench.settings.pane";
const PANES = ["theme", "data", "gen", "video", "h3d", "cosmos", "mcp", "shortcuts", "ffmpeg"];

const ui = {};
let currentPane = "theme";

/* ---------- 左侧菜单 ---------- */

function paneButton(id) {
  return ui.nav.querySelector(`.settings-nav-item[data-pane="${id}"]`);
}

function showPane(id) {
  let target = PANES.includes(id) ? id : "theme";
  if (paneButton(target)?.hidden) target = "theme";
  currentPane = target;
  for (const button of ui.nav.querySelectorAll(".settings-nav-item")) {
    const on = button.dataset.pane === target;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-current", on ? "page" : "false");
  }
  for (const pane of ui.content.querySelectorAll(".settings-pane")) {
    pane.hidden = pane.dataset.pane !== target;
  }
  ui.content.scrollTop = 0;
  try {
    localStorage.setItem(PANE_KEY, target);
  } catch {
    /* 写不进去只影响「记住上次」，不影响使用 */
  }
}

function initialPane() {
  const fromUrl = new URLSearchParams(location.search).get("page");
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem(PANE_KEY) || "theme";
  } catch {
    return "theme";
  }
}

/* 条件项：宇宙主题这一页（贴图 + 航线）只在宇宙主题下出现；视频组件只在缺
   ffmpeg 时才出现。当前停在被收起的项上时退回主题页，别把人留在空白页。 */
function syncConditionalPanes() {
  const cosmosOn = currentTheme() === "cosmos";
  paneButton("cosmos").hidden = !cosmosOn;
  paneButton("ffmpeg").hidden = document.querySelector("#settings-ffmpeg-card")?.hidden !== false;
  if (
    (currentPane === "cosmos" && !cosmosOn) ||
    (currentPane === "ffmpeg" && paneButton("ffmpeg").hidden)
  ) {
    showPane("theme");
  }
}

/* ---------- 主题 ---------- */

function themeChip(theme) {
  const [id, name] = theme;
  const vars = palette(theme);
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "theme-chip";
  chip.id = `theme-chip-${id}`;
  chip.dataset.theme = id;
  chip.title = name;
  chip.setAttribute("aria-label", `主题 ${name}`);
  chip.innerHTML = `
    <span class="theme-chip-preview">
      <span class="theme-chip-line"></span>
      <span class="theme-chip-dot"></span>
    </span>
    <span class="theme-chip-name">${name}</span>
  `;
  const preview = chip.querySelector(".theme-chip-preview");
  if (id === "cosmos") {
    preview.classList.add("is-cosmos");
  } else {
    preview.style.background = vars["--surface"];
    chip.querySelector(".theme-chip-line").style.background = vars["--line"];
    chip.querySelector(".theme-chip-dot").style.background = vars["--accent"];
  }
  chip.classList.toggle("is-active", id === currentTheme());
  chip.addEventListener("click", () => pickTheme(id));
  return chip;
}

function renderThemeChips() {
  ui.darkTheme.replaceChildren(...THEMES.map(themeChip));
  ui.lightTheme.replaceChildren(...LIGHT_THEMES.map(themeChip));
}

function pickTheme(id) {
  if (currentTheme() === id) return;
  setTheme(id);
  /* 主窗口那侧收到后 setTheme，它会再把最终值推回来（theme-sync）。
     这里先本地生效是为了点下去就换色，不依赖跨窗口的往返。 */
  emitTo("main", "inspace:theme-set", { id }).catch(() => {});
}

/* ---------- 事件 ---------- */

function setupWindow() {
  document.querySelector("#settings-win-min").addEventListener("click", () => appWindow.minimize());
  document.querySelector("#settings-win-close").addEventListener("click", () => appWindow.close());

  document.querySelectorAll(".settings-nav-item").forEach((button) => {
    button.addEventListener("click", () => showPane(button.dataset.pane));
  });

  /* Esc 关窗口：输入框和正在弹出的对话框自己先用掉 Esc，不连窗口一起关 */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.repeat) return;
    const target = event.target;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    appWindow.close();
  });

  /* 和主窗口一样：鼠标点完按钮摘掉焦点，键盘操作（detail=0）保留焦点框 */
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.("button");
      if (button && event.detail > 0) button.blur();
    },
    true,
  );

  document.addEventListener("contextmenu", (event) => event.preventDefault());

  listen("inspace:theme-sync", (event) => {
    const id = event.payload?.id;
    if (id && id !== currentTheme()) setTheme(id);
  }).catch(() => {});

  listen("inspace:settings-page", (event) => {
    if (event.payload) showPane(String(event.payload));
  }).catch(() => {});

  document.addEventListener("themechange", syncConditionalPanes);
}

function start() {
  ui.nav = document.querySelector("#settings-nav");
  ui.content = document.querySelector("#settings-content");
  ui.darkTheme = document.querySelector("#settings-theme-dark");
  ui.lightTheme = document.querySelector("#settings-theme-light");
  ui.nav.querySelectorAll(".settings-nav-item").forEach((button) => {
    button.id = `settings-pane-${button.dataset.pane}`;
  });

  setupWindow();
  initSettings({ onFfmpegState: syncConditionalPanes });
  renderThemeChips();
  showPane(initialPane());
  syncConditionalPanes();

  refreshSettings().then(syncConditionalPanes);
  /* 问一次主窗口当前主题：两个 webview 的 localStorage 同源共享，
     但主窗口可能刚被 MCP 改过，以它为准更稳。 */
  emitTo("main", "inspace:theme-query", {}).catch(() => {});
}

start();
