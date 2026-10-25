/* 工作台的分隔条：待办栏左边界 —— 左右拖，改待办栏宽度（左边便签区随之变宽变窄）。
 * 尺寸存 localStorage，下次启动还原。
 *
 * 拖动中只改 CSS 变量，布局（便签瀑布墙）靠它自己的 ResizeObserver 重排。 */

const KEY_TODO = "workbench.todoWidth";

const TODO_MIN = 240;
const TODO_MAX = 620;
const LEFT_MIN = 420; // 左边便签区最小宽度

const root = document.documentElement;

function readNumber(key) {
  try {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

function saveNumber(key, value) {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* 存不了就只在本次运行生效 */
  }
}

/* 拖动通用：按下时记下起点，move 里按起点算新尺寸，松手存盘 */
export function startDrag(handle, onStart, onMove, onDone) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add("is-resizing");

    const start = onStart(e);
    const move = (ev) => onMove(ev, start);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      onDone?.();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

export function initSplitters() {
  const todoHandle = document.getElementById("todo-split-v");
  const todoCol = document.getElementById("todo-view");

  // 还原上次的尺寸
  const savedTodo = readNumber(KEY_TODO);
  if (savedTodo && todoCol) root.style.setProperty("--todo-w", `${savedTodo}px`);

  if (todoHandle && todoCol) {
    startDrag(
      todoHandle,
      (e) => ({ width: todoCol.offsetWidth, x: e.clientX }),
      (e, start) => {
        const maxByWindow = window.innerWidth - LEFT_MIN;
        const width = Math.min(
          Math.max(start.width - (e.clientX - start.x), TODO_MIN),
          Math.min(TODO_MAX, Math.max(TODO_MIN, maxByWindow)),
        );
        root.style.setProperty("--todo-w", `${Math.round(width)}px`);
      },
      () => saveNumber(KEY_TODO, todoCol.offsetWidth),
    );
  }

  /* 窗口变小后，之前存下来的像素宽度可能超出可用空间：收回到窗口允许的上限 */
  const clampToWindow = () => {
    if (todoCol) {
      const maxWidth = Math.min(TODO_MAX, window.innerWidth - LEFT_MIN);
      if (todoCol.offsetWidth > maxWidth) {
        root.style.setProperty("--todo-w", `${Math.round(maxWidth)}px`);
      }
    }
  };
  clampToWindow();
  window.addEventListener("resize", clampToWindow);
}
