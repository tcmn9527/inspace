/* 模型名选择器：输入框 + 右边一个小箭头 + 点开的候选面板。
 *
 * 为什么不用原生 datalist：它只会显示「已经塞进去的那几条」。设置页以前是打开时才
 * 画一次清单、而且图片那边压根不联网，所以点箭头永远只有当前那一个模型。
 * 这里改成点一下就展开，同时重新读一遍列表，读到了就地补进面板 —— 无论什么时候点，
 * 看到的都是接口当下支持的模型。
 *
 * 输入框仍然可编辑：接口不通、或者模型是新上的，都可以手填，面板只是候选。
 */

/* 一次只开一个：点开第二个时把第一个收起来 */
let opened = null;

/* input  —— 承载模型名的文本框（可编辑）
 * toggle —— 右边那颗箭头按钮
 * panel  —— 展开的候选面板（绝对定位）
 * load   —— 返回模型名数组的异步函数；报错原样显示在面板里
 * onPick —— 选中某个模型之后（用来落库） */
export function createModelPicker({ input, toggle, panel, load, onPick }) {
  let items = [];
  let loading = false;
  let error = "";
  let open = false;
  /* 只有用户这次真打了字才按关键字过滤。
     不然点开时输入框里已经躺着一个模型名，其它模型全被判成「不匹配」——
     面板就只剩当前那一条，跟原生 datalist 一个德行 */
  let typed = false;

  function render() {
    panel.replaceChildren();
    const keyword = typed ? input.value.trim().toLowerCase() : "";
    const list = keyword ? items.filter((name) => name.toLowerCase().includes(keyword)) : items;

    if (loading) {
      const note = document.createElement("p");
      note.className = "model-picker-note";
      note.textContent = "读取模型列表…";
      panel.append(note);
    }
    if (error) {
      const note = document.createElement("p");
      note.className = "model-picker-note is-error";
      note.textContent = error;
      panel.append(note);
    }
    if (!list.length && !loading && !error) {
      const note = document.createElement("p");
      note.className = "model-picker-note";
      note.textContent = items.length ? "没有匹配的模型" : "没有读到模型，可以直接手填";
      panel.append(note);
    }

    for (const name of list) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-picker-item";
      if (name === input.value.trim()) item.classList.add("is-active");
      item.textContent = name;
      item.addEventListener("click", () => {
        input.value = name;
        close();
        onPick?.(name);
      });
      panel.append(item);
    }
    panel.hidden = !open;
    if (open) {
      /* 当前用的那条滚进视野：视频有 11 个模型，一开就停在那条上更好找 */
      const active = panel.querySelector(".is-active");
      if (active) {
        panel.scrollTop = Math.max(
          0,
          active.offsetTop - panel.clientHeight / 2 + active.offsetHeight / 2,
        );
      }
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    error = "";
    render();
    try {
      const names = await load();
      items = [...new Set((names || []).filter(Boolean))];
    } catch (failure) {
      error = String(failure?.message || failure);
      items = [];
    } finally {
      loading = false;
      render();
    }
  }

  function openPanel() {
    if (open) return;
    if (opened && opened !== controller) opened.close();
    opened = controller;
    open = true;
    typed = false;
    render();
    /* 先把已有的画出来再读：面板不会空白等网络 */
    void refresh();
  }

  function close() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    if (opened === controller) opened = null;
  }

  const controller = {
    setItems(names) {
      items = [...new Set((names || []).filter(Boolean))];
      if (open) render();
    },
    refresh,
    close,
  };

  toggle.addEventListener("click", () => {
    if (open) close();
    else openPanel();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    /* 往下键是「想挑一个」的常见动作 */
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      openPanel();
      return;
    }
    if (event.key === "Enter" && open) close();
  });

  /* 边打字边过滤 */
  input.addEventListener("input", () => {
    if (!open) return;
    typed = true;
    render();
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!open) return;
      if (panel.contains(event.target) || toggle.contains(event.target) || input === event.target) return;
      close();
    },
    true,
  );

  return controller;
}
