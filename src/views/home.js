import { createStickyWall } from "./wall.js";
import { confirmDialog } from "./dialog.js";

const { invoke } = window.__TAURI__.core;

const ui = {};

let todos = [];
let todoQuery = "";
let composerOpen = false;

/* ---------- 右键菜单 ---------- */

function closeMenu() {
  ui.menu.hidden = true;
}

function openMenu(x, y, items) {
  const menu = ui.menu;
  menu.textContent = "";

  for (const item of items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    if (item.danger) button.className = "danger";
    button.addEventListener("click", () => {
      closeMenu();
      item.onClick();
    });
    li.append(button);
    menu.append(li);
  }

  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))}px`;
}

/* ---------- 便签 ---------- */

let stickyWall = null;

async function refreshStickies() {
  await stickyWall?.refresh();
}

/* 首页几块一起重读磁盘。换过数据目录必须整组刷——只刷便签的话，待办栏会一直挂着
   旧目录那几条，看着像「新文件夹里还有数据」，实际是残影。 */
export async function refreshHome() {
  await Promise.all([refreshStickies(), refreshTodos(), refreshBroken()]);
}

/* ---------- 待办 ---------- */

/* 多行文本框随内容自动长高，上限 120px */
function autoGrow(ta, max = 120) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
}

function composerNode() {
  const li = document.createElement("li");
  li.className = "todo-composer";

  const input = document.createElement("textarea");
  input.rows = 1;
  input.placeholder = "待办内容，回车保存，Shift+回车换行";
  li.append(input);

  let closed = false;
  async function finish(save) {
    if (closed) return;
    closed = true;
    composerOpen = false;

    const text = input.value.trim();
    if (save && text) {
      try {
        await invoke("create_todo", { input: { text } });
      } catch (error) {
        console.error(`新建待办失败：${error}`);
      }
    }
    await refreshTodos();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (e.shiftKey) return; // Shift+回车保留默认换行
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("input", () => autoGrow(input));
  input.addEventListener("blur", () => finish(true));

  requestAnimationFrame(() => {
    input.focus();
    autoGrow(input);
  });
  return li;
}

async function setTodoDone(id, done) {
  try {
    await invoke("set_todo_done", { id, done });
  } catch (error) {
    console.error(`更新待办状态失败：${error}`);
  }
  await refreshTodos();
}

async function removeTodo(id) {
  try {
    await invoke("delete_todo", { id });
  } catch (error) {
    console.error(`删除待办失败：${error}`);
  }
  await refreshTodos();
}

function todoNode(todo) {
  const li = document.createElement("li");
  li.className = todo.done ? "todo-row is-done" : "todo-row";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "todo-check";
  check.checked = todo.done;
  check.setAttribute("aria-label", "标记完成");
  check.addEventListener("change", () => setTodoDone(todo.id, check.checked));

  const text = document.createElement("span");
  text.className = "todo-text";
  text.textContent = todo.text;

  li.append(check, text);

  /* 双击进入编辑：界面不变，直接在原文字上就地编辑（contenteditable），
     光标停在双击处；回车只换行；失焦自动保存；Esc 撤销恢复 */
  function startEdit({ caretToEnd = false, point = null } = {}) {
    if (text.isContentEditable) return;

    const original = todo.text;

    function placeCaretToEnd() {
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    /* 把光标放到双击的屏幕坐标处（WebView2/Chromium 提供 caretPositionFromPoint） */
    function placeCaretAt(x, y) {
      let node = null;
      let offset = 0;
      const hit = document.caretPositionFromPoint?.(x, y) ?? null;
      if (hit) {
        node = hit.offsetNode;
        offset = hit.offset;
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) {
          node = r.startContainer;
          offset = r.startOffset;
        }
      }
      if (!node || !text.contains(node)) {
        placeCaretToEnd(); // 点在外面（行末空白等）就落到行尾
        return;
      }
      /* 命中的是 span 本身时，折算到它里面的文本节点 */
      const tn = text.firstChild;
      if (node === text && tn?.nodeType === Node.TEXT_NODE) {
        node = tn;
        offset = offset > 0 ? tn.data.length : 0;
      }
      const max = node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length;
      const range = document.createRange();
      range.setStart(node, Math.min(offset, max));
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    let closing = false;
    async function finish(save) {
      if (closing) return;
      closing = true;
      // innerText 会把编辑器里的换行（\n 或 <br>）统一映射成 \n
      const newText = (text.innerText || text.textContent)
        .replace(/\u00a0/g, " ")
        .trim();
      if (save && newText && newText !== original) {
        try {
          await invoke("update_todo", { id: todo.id, input: { text: newText } });
        } catch (error) {
          console.error(`更新待办失败：${error}`);
        }
        await refreshTodos();
        return;
      }
      text.textContent = original;
      text.contentEditable = "false";
      text.blur();
    }

    text.contentEditable = "true";
    text.spellcheck = false;
    text.focus({ preventScroll: true });
    if (point) placeCaretAt(point.x, point.y);
    else if (caretToEnd) placeCaretToEnd();

    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // 编辑中回车只插入换行，保存靠失焦（blur）触发
        e.preventDefault();
        if (!document.execCommand("insertText", false, "\n")) {
          const sel = window.getSelection();
          if (!sel.rangeCount) return;
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const br = document.createTextNode("\n");
          range.insertNode(br);
          range.setStartAfter(br);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    text.addEventListener("paste", (e) => {
      e.preventDefault(); // 只粘贴纯文本，避免带入格式
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    });
    text.addEventListener("blur", () => finish(true));
  }

  li.addEventListener("dblclick", (e) => {
    if (e.target === check) return; // 复选框双击只做勾选
    startEdit({ point: { x: e.clientX, y: e.clientY } });
  });
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: "编辑", onClick: () => startEdit({ caretToEnd: true }) },
      {
        label: "删除",
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: "删除待办",
            message: "确定删除这条待办？",
            okText: "删除",
            danger: true,
          });
          if (ok) await removeTodo(todo.id);
        },
      },
    ]);
  });

  return li;
}

function renderTodos() {
  ui.todoList.textContent = "";

  const query = todoQuery.trim().toLowerCase();
  const matched = (todo) => !query || todo.text.toLowerCase().includes(query);
  const open = todos.filter((t) => !t.done && matched(t));
  const done = todos.filter((t) => t.done && matched(t));

  const nodes = [];
  if (composerOpen) nodes.push(composerNode());
  nodes.push(...open.map(todoNode));

  /* 有完成项就显示「已完成」分隔（全部勾选完也不消失） */
  if (done.length > 0) {
    const group = document.createElement("li");
    group.className = "todo-group";
    group.textContent = `已完成 ${done.length}`;
    nodes.push(group);
  }
  nodes.push(...done.map(todoNode));

  ui.todoList.append(...nodes);

  const visible = open.length + done.length > 0;
  ui.todoEmpty.hidden = visible || composerOpen;
  if (!visible) {
    ui.todoEmpty.textContent = query ? "没有匹配的待办" : "暂无待办";
  }
}

async function refreshTodos() {
  todos = await invoke("list_todos");
  renderTodos();
}

/* ---------- 读不出的文件 ---------- */

/* 后端已经把坏文件跳过、其余照常显示，这里只补一句「少掉的是这几个文件，内容没动」，
   否则用户看到的只是凭空少了几条。正常态这行完全不存在。 */
async function refreshBroken() {
  let broken;
  try {
    broken = await invoke("data_broken_files");
  } catch {
    return; /* 这句只是补充说明，读不到就一个字都不显示 */
  }
  showBroken(ui.stickyBroken, "便签", "stickies", broken.stickies);
  showBroken(ui.todoBroken, "待办", "todos", broken.todos);
}

function showBroken(el, label, dir, names) {
  el.hidden = names.length === 0;
  if (el.hidden) return;
  const listed = names.map((name) => `${dir}/${name}`).join("、");
  el.textContent = `${label}有 ${names.length} 个文件读不出：${listed}。文件没动，把 JSON 修好它就会回来。`;
}

/* ---------- 装配 ---------- */

export function initHome() {
  ui.todoList = document.querySelector("#todo-list");
  ui.todoEmpty = document.querySelector("#todo-empty");
  ui.todoSearch = document.querySelector("#todo-search");
  ui.todoBroken = document.querySelector("#todo-broken");
  ui.stickyBroken = document.querySelector("#sticky-broken");
  ui.menu = document.querySelector("#ctx-menu");

  /* 点菜单外部才收起。用 composedPath 而不是 contains(e.target)：菜单项点击时
     可能已经重建/摘掉了被点的那颗按钮，contains 会误判成「外部点击」。 */
  document.addEventListener("click", (e) => {
    if (!ui.menu.hidden && !e.composedPath().includes(ui.menu)) closeMenu();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !ui.menu.hidden) closeMenu();
  });

  /* 首页主区就是便签库：搜索、新建、全量瀑布墙 */
  stickyWall = createStickyWall({
    wall: document.querySelector("#sticky-wall"),
    empty: document.querySelector("#sticky-empty"),
    error: document.querySelector("#sticky-error"),
    search: document.querySelector("#sticky-search"),
    searchClear: document.querySelector("#sticky-search-clear"),
    addButton: document.querySelector("#sticky-add"),
  });

  document.querySelector("#todo-add").addEventListener("click", () => {
    if (composerOpen) return;
    composerOpen = true;
    renderTodos();
  });

  const searchClear = document.querySelector("#todo-search-clear");
  const syncSearchClear = () => {
    searchClear.hidden = ui.todoSearch.value.length === 0;
  };

  ui.todoSearch.addEventListener("input", () => {
    todoQuery = ui.todoSearch.value;
    syncSearchClear();
    renderTodos();
  });

  searchClear.addEventListener("click", () => {
    ui.todoSearch.value = "";
    todoQuery = "";
    syncSearchClear();
    renderTodos();
    ui.todoSearch.focus();
  });

  refreshHome().catch((error) => console.error(`加载首页数据失败：${error}`));
}
