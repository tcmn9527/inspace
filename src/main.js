import { initHome, refreshHome } from "./views/home.js";
import { initNotes, refreshNotes } from "./views/notes.js";
import { enterCanvas, initCanvas, leaveCanvas } from "./views/canvas.js";
import { initSettings, refreshSettings } from "./views/settings.js";
import { initTheme } from "./views/theme.js";
import { initSplitters } from "./views/splitter.js";

const { getCurrentWindow } = window.__TAURI__.window;

const appWindow = getCurrentWindow();

/* 首页已合并便签库；笔记、画布和设置各有自己的页面 */
function showRoute(route) {
  const isHome = route === "home";
  const isNotes = route === "notes";
  const isCanvas = route === "canvas";
  const isSettings = route === "settings";

  document.querySelector("#home-view").hidden = !isHome;
  document.querySelector("#todo-view").hidden = !isHome;
  document.querySelector("#notes-view").hidden = !isNotes;
  document.querySelector("#canvas-view").hidden = !isCanvas;
  document.querySelector("#settings-view").hidden = !isSettings;

  /* 进出页面时刷新数据，保证首页墙与便签库同步；笔记树每次进页都重读磁盘；
     离开画布前把还在防抖里的改动落盘 */
  if (isHome) refreshHome().catch((error) => console.error(`刷新首页失败：${error}`));
  if (isNotes) refreshNotes();
  if (isSettings) refreshSettings();
  if (isCanvas) enterCanvas();
  else leaveCanvas();

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

  /* 换过数据目录，四类内容全得重读一遍。设置页只改自己那行路径的话，
     首页还挂着旧目录的残影，看着就像「新文件夹里也有数据」。 */
  window.addEventListener("data-root-changed", () => {
    refreshHome().catch((error) => console.error(`换目录后刷新首页失败：${error}`));
    refreshNotes().catch((error) => console.error(`换目录后刷新笔记失败：${error}`));
  });

  /* 屏蔽 WebView2 原生右键菜单（含文本选择/输入框的剪切粘贴菜单），
     应用内只保留自己的右键菜单（待办见 home.js、便签见 wall.js） */
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  appWindow.onResized(syncMaximizeIcon);
  syncMaximizeIcon();

  initTheme();
  initSplitters();
  initHome();
  initNotes();
  initCanvas();
  initSettings();
  showRoute("home");
});
