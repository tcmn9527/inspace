/* 自定义确认框：替代 window.confirm()，外观跟右键菜单、取色盘一套（同样的
 * 浮层底色/描边/圆角/阴影，按钮也用同一套排版），保证整个工作台的弹框风格统一。
 *
 * 用法：
 *   if (!(await confirmDialog({ message: "删除这张便签？", danger: true }))) return;
 *
 * 键盘：Enter = 确定，Esc = 取消。点遮罩空白处也算取消。
 */

let openDialog = null;

/* 关闭用的 ×：跟工作台标题栏那颗同一个字形，别自己拿字符凑（文字 × 基线偏下、粗细也不对） */
export const CLOSE_X_SVG = `
  <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1" fill="none"/>
  </svg>
`;

export function confirmDialog({
  title = "请确认",
  message = "",
  okText = "确定",
  cancelText = "取消",
  danger = false,
} = {}) {
  // 同时只留一个：上一个还没关就按取消收掉
  openDialog?.(false);

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <p class="dialog-title"></p>
        <p class="dialog-message"></p>
        <div class="dialog-actions">
          <button class="dialog-btn dialog-cancel" type="button"></button>
          <button class="dialog-btn dialog-ok" type="button"></button>
        </div>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    dialog.querySelector(".dialog-title").textContent = title;
    const messageEl = dialog.querySelector(".dialog-message");
    messageEl.textContent = message;
    messageEl.hidden = !message;
    const cancelBtn = dialog.querySelector(".dialog-cancel");
    const okBtn = dialog.querySelector(".dialog-ok");
    cancelBtn.textContent = cancelText;
    okBtn.textContent = okText;
    if (danger) okBtn.classList.add("dialog-danger");

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      openDialog = null;
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
        finish(true);
      }
    };

    okBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) finish(false);
    });

    document.body.append(mask);
    document.addEventListener("keydown", onKey, true);
    openDialog = finish;
    okBtn.focus({ preventScroll: true });
  });
}

/* 输入框弹层（重命名 / 新建文件夹用）。返回输入的文字，取消返回 null。
 * selectBase：打开时只选中主文件名（不含 .md），方便直接改名覆盖。 */
export function promptDialog({
  title = "重命名",
  label = "",
  value = "",
  okText = "确定",
  cancelText = "取消",
  selectBase = false,
} = {}) {
  openDialog?.(false);

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog dialog-prompt" role="dialog" aria-modal="true">
        <p class="dialog-title"></p>
        <label class="dialog-label"></label>
        <input class="dialog-input" spellcheck="false" />
        <p class="dialog-error" hidden></p>
        <div class="dialog-actions">
          <button class="dialog-btn dialog-cancel" type="button"></button>
          <button class="dialog-btn dialog-ok" type="button"></button>
        </div>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    dialog.querySelector(".dialog-title").textContent = title;
    const labelEl = dialog.querySelector(".dialog-label");
    labelEl.textContent = label;
    labelEl.hidden = !label;
    const input = dialog.querySelector(".dialog-input");
    input.value = value;
    const errorEl = dialog.querySelector(".dialog-error");
    const cancelBtn = dialog.querySelector(".dialog-cancel");
    const okBtn = dialog.querySelector(".dialog-ok");
    cancelBtn.textContent = cancelText;
    okBtn.textContent = okText;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      openDialog = null;
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve(result);
    };
    const submit = () => {
      const text = input.value.trim();
      if (!text) {
        errorEl.textContent = "名字不能为空";
        errorEl.hidden = false;
        input.focus();
        return;
      }
      finish(text);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        finish(null);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
        submit();
      } else if (e.key === "Tab") {
        e.stopPropagation();
      }
    };

    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", () => finish(null));
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) finish(null);
    });

    document.body.append(mask);
    document.addEventListener("keydown", onKey, true);
    openDialog = (ok) => finish(ok ? input.value.trim() || null : null);
    input.focus({ preventScroll: true });
    if (selectBase) {
      const dot = input.value.toLowerCase().endsWith(".md") ? input.value.length - 3 : input.value.length;
      input.setSelectionRange(0, dot);
    } else {
      input.select();
    }
  });
}

/* 多选项弹层：confirmDialog 只有两个按钮，装不下「拷进画布 / 只引用原文件」。
 * 返回选中项的 value，取消返回 null。上下键换选项，Enter 确认，
 * 取消没有按钮——走右上角 × 、Esc 或点空白。 */
export function choiceDialog({
  title = "请确认",
  message = "",
  note = "",
  options = [],
} = {}) {
  openDialog?.(false);

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog dialog-choice-modal" role="dialog" aria-modal="true">
        <p class="dialog-title"></p>
        <button class="dialog-close" type="button" aria-label="关闭">${CLOSE_X_SVG}</button>
        <p class="dialog-message"></p>
        <div class="dialog-choices"></div>
        <p class="dialog-note"></p>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    dialog.querySelector(".dialog-title").textContent = title;
    const messageEl = dialog.querySelector(".dialog-message");
    messageEl.textContent = message;
    messageEl.hidden = !message;
    const noteEl = dialog.querySelector(".dialog-note");
    noteEl.textContent = note;
    noteEl.hidden = !note;
    const closeBtn = dialog.querySelector(".dialog-close");

    const box = dialog.querySelector(".dialog-choices");
    const buttons = options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dialog-choice";
      const label = document.createElement("span");
      label.className = "dialog-choice-label";
      label.textContent = option.label;
      button.append(label);
      if (option.hint) {
        const hint = document.createElement("span");
        hint.className = "dialog-choice-hint";
        hint.textContent = option.hint;
        button.append(hint);
      }
      box.append(button);
      return button;
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      openDialog = null;
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve(value ?? null);
    };
    buttons.forEach((button, index) => {
      button.addEventListener("click", () => finish(options[index].value));
    });

    const move = (step) => {
      if (!buttons.length) return;
      const at = buttons.indexOf(document.activeElement);
      const next = at < 0 ? 0 : (at + step + buttons.length) % buttons.length;
      buttons[next].focus({ preventScroll: true });
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        finish(null);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        /* 焦点在按钮上时浏览器自己会触发 click，这里只兜住焦点跑到别处的情况 */
        if (document.activeElement?.closest?.(".dialog-choice")) return;
        e.preventDefault();
        e.stopPropagation();
        buttons[0]?.click();
      }
    };

    closeBtn.addEventListener("click", () => finish(null));
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) finish(null);
    });

    document.body.append(mask);
    document.addEventListener("keydown", onKey, true);
    openDialog = finish;
    buttons[0]?.focus({ preventScroll: true });
  });
}

/* 进度弹层：换数据目录搬运大量文件时用。别的弹层能 Esc 能点空白关掉，这个不行——
 * 传输中途把框收了，用户会以为活儿已经干完，只留一颗「停止」让他能喊停。
 * 返回控制器：set(比例, 文案) 画进度、onCancel 挂停止、cancelPending 让按钮变灰、close 收掉。 */
export function progressDialog({ title = "请稍候", message = "", cancelText = "停止" } = {}) {
  openDialog?.(false);

  const mask = document.createElement("div");
  mask.className = "dialog-mask";
  mask.innerHTML = `
    <div class="dialog dialog-progress" role="dialog" aria-modal="true">
      <p class="dialog-title"></p>
      <p class="dialog-message"></p>
      <div class="dialog-bar"><i class="dialog-fill"></i></div>
      <p class="dialog-count"></p>
      <div class="dialog-actions">
        <button class="dialog-btn dialog-cancel" type="button"></button>
      </div>
    </div>
  `;
  const dialog = mask.querySelector(".dialog");
  const titleEl = dialog.querySelector(".dialog-title");
  const messageEl = dialog.querySelector(".dialog-message");
  const fill = dialog.querySelector(".dialog-fill");
  const countEl = dialog.querySelector(".dialog-count");
  const cancelBtn = dialog.querySelector(".dialog-cancel");
  titleEl.textContent = title;
  messageEl.textContent = message;
  messageEl.hidden = !message;
  cancelBtn.textContent = cancelText;

  let closed = false;
  let cancelHandler = null;
  cancelBtn.addEventListener("click", () => {
    if (!cancelBtn.disabled) cancelHandler?.();
  });

  document.body.append(mask);
  openDialog = close;
  cancelBtn.focus({ preventScroll: true });

  function close() {
    if (closed) return;
    closed = true;
    if (openDialog === close) openDialog = null;
    mask.remove();
  }

  return {
    set(fraction, text) {
      /* 向下取整：最后一个大文件拷到一半时，四舍五入会把格子写成 100%，
         看着像卡完了一样，宁可少报 0.1%。 */
      const percent = Math.min(1, Math.max(0, Number(fraction) || 0));
      fill.style.width = `${(Math.floor(percent * 1000) / 10).toFixed(1)}%`;
      if (text !== undefined) countEl.textContent = text;
    },
    setText(text) {
      countEl.textContent = text;
    },
    setTitle(text) {
      titleEl.textContent = text;
    },
    onCancel(handler) {
      cancelHandler = handler;
    },
    cancelPending() {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "正在停止…";
    },
    close,
  };
}
