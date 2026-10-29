import { initNotes, refreshNotes } from "./views/notes.js";
import { enterCanvas, initCanvas, leaveCanvas } from "./views/canvas.js";
import { initSettings, refreshSettings } from "./views/settings.js";
import { initTheme } from "./views/theme.js";
import { initAgent } from "./views/agent.js";

const { getCurrentWindow } = window.__TAURI__.window;

const appWindow = getCurrentWindow();

/* 空间就是首页：侧栏三颗 —— 空间、笔记、设置 */
function showRoute(route) {
  const isNotes = route === "notes";
  const isCanvas = route === "canvas";
  const isSettings = route === "settings";

  document.querySelector("#notes-view").hidden = !isNotes;
  document.querySelector("#canvas-view").hidden = !isCanvas;
  document.querySelector("#settings-view").hidden = !isSettings;

  /* 进出页面时刷新数据：笔记树每次进页重读磁盘，空间进出要先把防抖里的改动落盘。
     agent 也靠 routeReady 等这一轮读完再动手，不然会在半空的空间上做操作。 */
  let work = Promise.resolve();
  if (isNotes) work = Promise.resolve(refreshNotes());
  if (isSettings) work = Promise.resolve(refreshSettings());
  if (isCanvas) work = Promise.resolve(enterCanvas());
  else leaveCanvas();
  const ready = work.catch((error) => {
    console.error(`切到 ${route} 失败：${error}`);
  });
  window.__inspace = { route, ready };

  for (const item of document.querySelectorAll(".rail-item")) {
    const active = item.dataset.route === route;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

async function syncMaximizeIcon() {
  const button = document.querySelector("#win-max");
  const maximized = await appWindow.isMaximized();
  button.classList.toggle("is-maximized", maximized);
  button.setAttribute("aria-label", maximized ? "还原" : "最大化");
}

window.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#win-min").addEventListener("click", () => appWindow.minimize());
  document.querySelector("#win-max").addEventListener("click", () => appWindow.toggleMaximize());
  document.querySelector("#win-close").addEventListener("click", () => appWindow.close());

  for (const item of document.querySelectorAll(".rail-item")) {
    item.addEventListener("click", () => showRoute(item.dataset.route));
  }

  /* MCP 工具要切页时派发这个事件，和点侧栏走同一条路 */
  window.addEventListener("inspace:route", (event) => {
    const route = event.detail;
    if (route === "canvas" || route === "notes" || route === "settings") showRoute(route);
  });

  /* 换过数据目录，空间和笔记都得整组重读一遍。只换个指针的话，页面上还挂着
     旧目录那些内容，看着就像「新文件夹里也有数据」。 */
  window.addEventListener("data-root-changed", () => {
    leaveCanvas();
    enterCanvas().catch((error) => console.error(`换目录后重进空间失败：${error}`));
    refreshNotes().catch((error) => console.error(`换目录后刷新笔记失败：${error}`));
  });

  /* 屏蔽 WebView2 原生右键菜单（含文本选择/输入框的剪切粘贴菜单），
     应用内只保留自己的右键菜单（见 menu.js） */
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  appWindow.onResized(syncMaximizeIcon);
  syncMaximizeIcon();

  initTheme();
  initNotes();
  initCanvas();
  initSettings();
  showRoute("canvas");
  initAgent();
});
