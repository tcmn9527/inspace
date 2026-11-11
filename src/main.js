import { enterCanvas, initCanvas, leaveCanvas } from "./views/canvas.js";
import { initSettings, refreshSettings } from "./views/settings.js";
import { initTheme } from "./views/theme.js";
import { initCosmos } from "./views/cosmos.js";
import { initAgent } from "./views/agent.js";

const { getCurrentWindow } = window.__TAURI__.window;

const appWindow = getCurrentWindow();

/* 应用只有两页：画布和设置。设置从右上角那颗齿轮进出，其它时候都在画布上。 */
function showRoute(route) {
  const isCanvas = route === "canvas";
  const isSettings = route === "settings";

  /* 设置是浮在画布上的弹层：画布留着当背景，交互已经由 leaveCanvas 停掉 */
  document.querySelector("#canvas-view").hidden = !(isCanvas || isSettings);
  document.querySelector("#settings-view").hidden = !isSettings;
  if (isSettings) {
    document.querySelector("#settings-body")?.scrollTo({ top: 0 });
    /* 焦点收进弹层：别让它留在右上角齿轮上，不然关掉后按钮上会挂一圈焦点框 */
    requestAnimationFrame(() => {
      document.querySelector("#settings-dialog")?.focus({ preventScroll: true });
    });
  } else {
    const active = document.activeElement;
    if (active && (active.id === "settings-btn" || document.querySelector("#settings-view")?.contains(active))) {
      active.blur();
    }
  }

  /* 进出页面时刷新数据：设置页每次进页重读磁盘，画布进出要先把防抖里的改动落盘。
     agent 也靠 routeReady 等这一轮读完再动手，不然会在半空的画布上做操作。 */
  let work = Promise.resolve();
  if (isSettings) work = Promise.resolve(refreshSettings());
  if (isCanvas) work = Promise.resolve(enterCanvas());
  else leaveCanvas();
  const ready = work.catch((error) => {
    console.error(`切到 ${route} 失败：${error}`);
  });
  window.__inspace = { route, ready };

  document.querySelector("#settings-btn")?.classList.toggle("is-active", isSettings);
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

  /* 右上角那颗齿轮：开着就回画布，关着就开设置。
     走 insepace:route 而不是直接 showRoute——主题弹窗也听这个事件，切路由时一起收起 */
  document.querySelector("#settings-btn")?.addEventListener("click", () => {
    const onSettings = !document.querySelector("#settings-view").hidden;
    window.dispatchEvent(new CustomEvent("inspace:route", { detail: onSettings ? "canvas" : "settings" }));
  });

  /* MCP 工具要切页时派发这个事件，和点齿轮走同一条路 */
  window.addEventListener("inspace:route", (event) => {
    const route = event.detail;
    if (route === "canvas" || route === "settings") showRoute(route);
  });

  /* 换过数据目录，画布得整组重读一遍。只换个指针的话，页面上还挂着
     旧目录那些内容，看着就像「新文件夹里也有数据」。 */
  window.addEventListener("data-root-changed", () => {
    leaveCanvas();
    enterCanvas().catch((error) => console.error(`换目录后重进画布失败：${error}`));
  });

  /* 屏蔽 WebView2 原生右键菜单（含文本选择/输入框的剪切粘贴菜单），
     应用内只保留自己的右键菜单（见 menu.js） */
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  /* 鼠标点完按钮就把焦点摘掉：之后按 Esc 收浮层时，按钮上不会留一圈焦点框。
     用捕获阶段——画布上不少按钮为了不让菜单误收会 stopPropagation。
     键盘激活的 click（detail 为 0）不清，键盘用户仍看得到焦点位置 */
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.("button");
      if (button && event.detail > 0) button.blur();
    },
    true,
  );

  /* F10 是 WebView2 的保留加速键，页面收不到它的 keydown；按键由 Rust 侧的
     控制器拦下后走这条事件过来（见 lib.rs listen_f10_toggle） */
  window.__TAURI__.event.listen("inspace:toggle-titlebar", () => {
    document.body.classList.toggle("is-titlebar-hidden");
  });

  appWindow.onResized(syncMaximizeIcon);
  syncMaximizeIcon();

  initTheme();
  initCanvas();
  initCosmos();
  initSettings();
  showRoute("canvas");
  initAgent();
});
