/* 拖动条通用：按下时记下起点，move 里按起点算新尺寸，松手存盘。
 * 笔记页那根分隔条用它；尺寸怎么存、存哪儿由调用方自己管。 */

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
