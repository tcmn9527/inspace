import { enterCanvas, initCanvas, leaveCanvas } from "./views/canvas.js";
import { currentTheme, setTheme } from "./views/theme.js";
import { initCosmos } from "./views/cosmos.js";
import { initAgent } from "./views/agent.js";
import { initAssistantPanel } from "./views/assistant-panel.js";

const { getCurrentWindow } = window.__TAURI__.window;
const { invoke } = window.__TAURI__.core;
const { emitTo, listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

/* 主窗口只有画布：设置和主题都搬进了独立的设置窗口（label = settings）。 */
let routeReady = Promise.resolve();

function openSettings(page) {
  invoke("open_settings_window", page ? { page } : {}).catch((error) => {
    console.error(`打开设置窗口失败：${error}`);
  });
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

  /* 齿轮开设置窗口，主题也在那里设置。窗口已经开着的话，Rust 那边只把它提到前面。 */
  document.querySelector("#settings-btn")?.addEventListener("click", () => openSettings());

  /* 主题的真源在这一侧：设置窗口点色卡发过来，这里套上并写回 localStorage；
     主窗口自己因任何原因变主题（启动、MCP）时再推回设置窗口，让色卡高亮跟上。 */
  listen("inspace:theme-set", (event) => {
    const id = event.payload?.id;
    if (id) setTheme(id);
  }).catch(() => {});
  listen("inspace:theme-query", () => {
    emitTo("settings", "inspace:theme-sync", { id: currentTheme() }).catch(() => {});
  }).catch(() => {});
  document.addEventListener("themechange", () => {
    emitTo("settings", "inspace:theme-sync", { id: currentTheme() }).catch(() => {});
  });

  /* 设置窗口换过数据目录：重新进一次画布，别把旧目录的内容留在屏幕上 */
  listen("inspace:data-root-changed", () => {
    window.dispatchEvent(new Event("data-root-changed"));
  }).catch(() => {});

  /* 画布内部的「确保在画布页」事件保留下来；settings 路由现在等于开设置窗口 */
  window.addEventListener("inspace:route", (event) => {
    if (event.detail === "settings") {
      openSettings();
      return;
    }
    if (event.detail === "canvas") {
      routeReady = Promise.resolve(enterCanvas()).catch((error) =>
        console.error(`进画布失败：${error}`),
      );
      window.__inspace = { route: "canvas", ready: routeReady };
    }
  });

  /* 换过数据目录，画布得整组重读一遍。只换个指针的话，页面上还挂着
     旧目录那些内容，看着就像「新文件夹里也有数据」。 */
  window.addEventListener("data-root-changed", () => {
    leaveCanvas();
    routeReady = Promise.resolve(enterCanvas()).catch((error) =>
      console.error(`换目录后重进画布失败：${error}`),
    );
    window.__inspace = { route: "canvas", ready: routeReady };
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

  initCanvas();
  initCosmos();
  initAgent();
  initAssistantPanel();
  routeReady = Promise.resolve(enterCanvas()).catch((error) => console.error(`进画布失败：${error}`));
  window.__inspace = { route: "canvas", ready: routeReady };
});
