/* 便签瀑布墙（首页主区）。
 *
 * - 卡片宽高以数据形式存库，下次启动原样还原；高度存在 height 字段。
 * - 高度是「死的」：新建就用 DEFAULT_H，此后只有手动拖卡片下边缘才会变；
 *   正文多少、窗口宽度、进出页面都不许改动它（没有 ResizeObserver 回读高度）。
 * - 编辑是就地的：双击卡片才把正文换成 contenteditable（单击只算选中卡片），
 *   光标落在双击的那一点上；Ctrl+A、Enter 换行、失焦自动保存、Esc 反悔。
 * - 右键四项：编辑 / 设置文字颜色 / 设置背景颜色 / 删除。
 *   两个颜色项弹取色盘（见 color-picker.js）。
 * - 排序按最后更新时间；本地操作后保持原位不再跳动，下次重启按最新顺序排。 */
import { closeColorPicker, openColorPicker } from "./color-picker.js";
import { confirmDialog } from "./dialog.js";

const { invoke } = window.__TAURI__.core;

/* 基础单元宽与列距，跟 styles.css 的 --card-size / --card-gap 保持一致 */
const rootSize = getComputedStyle(document.documentElement);
const CELL = parseFloat(rootSize.getPropertyValue("--card-size")) || 280;
const GAP = parseFloat(rootSize.getPropertyValue("--card-gap")) || 10;
const DEFAULT_H = CELL; // 便签初始高度：恒等于一个方块高，不随正文多少自适应
const MIN_H = 60; // 与 CSS .sticky-wall .sticky-card 的 min-height 同步
const ROW_EPS = 8; // 同一「行」的容差(px)：列高差在 8px 内当作一样高，不让几个像素的差把整列跳过
const PAD_X = 9; // 与 --pad-x 同步：wall 左右内边距
const DEFAULT_COLOR = "#bfa648";
const DEFAULT_TEXT = "#000000";

/* 底色 6 浅 1 深、文字 4 档，都是黑白灰系配出来的柔和色，不乱 */
const BG_COLORS = [
  ["橄榄金", "#bfa648"],
  ["黄绿", "#a6bf47"],
  ["青碧", "#47bfb4"],
  ["米白", "#e5e1d6"],
  ["雾灰", "#aab0b5"],
  ["墨黑", "#262626"],
];
const TEXT_COLORS = [
  ["黑", "#000000"],
  ["白", "#ffffff"],
  ["深灰", "#4c4c4c"],
  ["银灰", "#9e9e9e"],
];

/* 新建便签随机用的 20 套浅色主题：[背景, 文字]。
   全部是「浅底 + 同色系深字」，对比度按 WCAG 算过，最低 7.7:1（AAA 标准是 7:1），
   所以不管随机到哪一套，正文都能看清。加新主题请先验对比度 ≥ 7。 */
const NOTE_THEMES = [
  ["#f5e6b8", "#54430c"], // 米黄
  ["#cfe4f7", "#10365c"], // 天蓝
  ["#d3ecdc", "#14472c"], // 薄荷
  ["#f8d9d2", "#6b1f18"], // 粉桃
  ["#e2dcf7", "#3a2a6b"], // 薰衣草
  ["#f7f0c4", "#57500f"], // 柠檬
  ["#cfeae8", "#0f4a45"], // 浅青
  ["#fbdcd2", "#6b2415"], // 珊瑚
  ["#ecd8f0", "#4c1b57"], // 浅紫
  ["#dcefc8", "#2f4a12"], // 浅绿
  ["#d8e8f2", "#1d3c52"], // 冰蓝
  ["#e8e4dc", "#3c3830"], // 米灰
  ["#f6e2c8", "#5a3a12"], // 杏色
  ["#f7d9e3", "#6b1a37"], // 浅玫
  ["#e9f2c8", "#3e4a12"], // 青柠
  ["#dfe3ee", "#2a3450"], // 雾蓝
  ["#fbdfc0", "#6b3a0c"], // 浅橙
  ["#cdeee2", "#0d4a3a"], // 湖绿
  ["#f2dede", "#5c2222"], // 藕粉
  ["#efe3c0", "#4e4014"], // 沙金
];

let lastTheme = -1; // 上一次随机到的下标：连着新建时不重复同一套

function pickTheme() {
  const count = NOTE_THEMES.length;
  const span = lastTheme >= 0 ? count - 1 : count; // 排除上次用过的那套后再取随机
  let index = Math.floor(Math.random() * span);
  if (lastTheme >= 0 && index >= lastTheme) index += 1;
  lastTheme = index;
  return NOTE_THEMES[index];
}

// ---------- 共用小菜单（沿用 #ctx-menu，和右键待办一个样式） ----------

function closeMenu() {
  document.getElementById("ctx-menu").hidden = true;
}

// item.swatch 会在文字前放一个方形小色块；item.danger 是那种红色危险项
function openMenu(x, y, items, options = {}) {
  closeColorPicker(true); // 再开菜单时先把取色盘按「确定」收掉，别两个浮层叠着
  const menu = document.getElementById("ctx-menu");
  menu.textContent = "";
  if (options.label) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = options.label;
    menu.append(label);
  }
  for (const item of items) {
    if (item === "-") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.append(sep);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    if (item.danger) button.classList.add("menu-danger");
    if (item.swatch) {
      const swatch = document.createElement("span");
      swatch.className = "menu-swatch";
      swatch.style.background = item.swatch;
      button.append(swatch);
    }
    button.append(item.label);
    /* 菜单项自己处理完就不再向上冒泡：home.js 在 document 上挂了「点外部关菜单」，
       而这个 click 里可能已经把被点的 button 从 DOM 摘掉，document 那层就会误判成
       「点到了外部」而把刚打开的东西关掉。挡住冒泡即解决。 */
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMenu();
      item.onClick();
    });
    menu.append(button);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menu.style.right = "auto";
}

/**
 * 造一面便签瀑布墙。
 * @param {object} options
 * @param {HTMLElement} options.wall      卡片容器（.sticky-wall）
 * @param {HTMLElement} options.empty     空状态提示
 * @param {HTMLElement} options.error     错误提示
 * @param {HTMLInputElement} [options.search]     搜索框
 * @param {HTMLButtonElement} [options.searchClear] 清空搜索按钮
 * @param {HTMLButtonElement} [options.addButton]   新建按钮
 * @param {string} [options.emptyText] 一条便签都没有时的提示
 * @param {string} [options.noMatchText] 搜索没命中时的提示
 * @returns {{ refresh: () => Promise<void>, element: HTMLElement }}
 */
export function createStickyWall({
  wall,
  empty,
  error,
  search = null,
  searchClear = null,
  addButton = null,
  emptyText = "暂无便签，点右上角 ＋ 新建",
  noMatchText = "没有匹配的便签",
}) {
  let notes = [];
  let query = "";
  let editingId = null; // 当前哪张卡开着 contenteditable
  let canvas = null;
  const cardEls = new Map(); // note.id -> 卡片元素
  let wallRaf = 0; // 窗口尺寸变化时并帧重排
  let drag = null; // 拖拽中的实时高度 { id, height }：布局按它排这一列，别的卡同时让位

  const heightOf = (note) => note.height;

  function showError(msg) {
    error.textContent = msg;
    error.hidden = !msg;
  }

  // ---------- 数据小工具 ----------

  function matches(note) {
    if (!query) return true;
    // 便签不再有标题，搜索只查正文
    return note.body.toLowerCase().includes(query.toLowerCase());
  }

  function sortedNotes() {
    return notes.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // 后端口径的 StickyNoteInput
  function toInput(note) {
    return {
      title: note.title,
      body: note.body,
      color: note.color,
      textColor: note.textColor || DEFAULT_TEXT,
      width: note.width ?? null,
      height: heightOf(note) ?? null,
    };
  }

  // 保存后只回写内容类字段；updatedAt 保持本地旧值，免得卡片在墙上乱跳，
  // 服务端已经把它 bump 了，下次重启自然按新时间排
  async function persist(note) {
    try {
      const keepSort = note.updatedAt;
      const fresh = await invoke("update_sticky_note", { id: note.id, input: toInput(note) });
      Object.assign(note, fresh);
      note.updatedAt = keepSort;
    } catch (err) {
      showError(String(err));
    }
  }

  // ---------- 瀑布流布局 ----------

  const catsOf = (note, cols) =>
    Math.min(Math.max(1, Math.round(((note.width || CELL) + GAP) / (CELL + GAP))), cols);
  const widthOfCats = (cats) => cats * (CELL + GAP) - GAP;

  function colsNow() {
    const inner = wall.clientWidth - PAD_X * 2;
    return Math.max(1, Math.floor((inner + GAP) / (CELL + GAP)));
  }

  /* 经典列填充：每张卡从左到右扫一遍，找「被它跨的那几列里最高台面」最低的那段
     连续列落脚，落下后把跨过的列台面一起抬高。列数随窗口宽度换算，卡宽吸附整列。
     高度只读数据字段（没有就 DEFAULT_H），布局永远不反过来改写它。 */
  function layout() {
    wallRaf = 0;
    const cards = sortedNotes();
    const cols = colsNow();
    const heights = new Array(cols).fill(0);
    const placed = [];
    for (const note of cards) {
      const span = catsOf(note, cols);
      /* 正在被拖动的那张用「实时高度」，其余卡照旧读存库高度 */
      const h =
        drag && drag.id === note.id
          ? Math.max(drag.height, MIN_H)
          : Math.max(heightOf(note) || DEFAULT_H, MIN_H);
      let bestTop = Infinity;
      let bestCol = 0;
      for (let s = 0; s + span <= cols; s++) {
        let top = 0;
        for (let k = s; k < s + span; k++) top = Math.max(top, heights[k]);
        /* 只有明显更矮（差超过 ROW_EPS）才换到别列；高度只差几像素算同一行，
           从左往右排。否则一张 281 高的卡会让后面每张都绕过它那一列，
           最后一行左侧就空出一个整卡大的洞，看着像丢了一张卡。 */
        if (top < bestTop - ROW_EPS) {
          bestTop = top;
          bestCol = s;
        }
      }
      for (let k = bestCol; k < bestCol + span; k++) heights[k] = bestTop + h + GAP;
      placed.push({ note, col: bestCol, span, top: bestTop, h });
    }
    let maxTop = 0;
    for (const v of heights) maxTop = Math.max(maxTop, v);
    canvas.style.width = `${widthOfCats(cols)}px`;
    canvas.style.height = `${Math.max(maxTop, MIN_H)}px`;
    for (const { note, col, span, top, h } of placed) {
      const el = cardEls.get(note.id);
      if (!el) continue;
      el.style.left = `${col * (CELL + GAP)}px`;
      el.style.top = `${top}px`;
      el.style.width = `${widthOfCats(span)}px`;
      el.style.height = `${h}px`;
    }
  }

  function scheduleLayout() {
    if (!wallRaf) wallRaf = requestAnimationFrame(layout);
  }

  // ---------- 渲染 ----------

  function noteCard(note) {
    const card = document.createElement("article");
    card.className = "sticky-card";
    card.dataset.id = String(note.id);
    card.style.background = note.color;
    card.style.color = note.textColor || DEFAULT_TEXT;

    const body = document.createElement("p");
    body.className = "sticky-body";
    body.textContent = note.body;

    /* 只有下边缘能拖=拉高；宽度不许拖（恒吸附整列，布局说了算） */
    const edgeV = document.createElement("div");
    edgeV.className = "sticky-edge-v";
    edgeV.addEventListener("pointerdown", (e) => startEdgeDrag(e, card, note));

    card.append(body, edgeV);

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCardMenu(note, e.clientX, e.clientY);
    });

    /* 只有双击才进编辑：单击只是选中这张卡，不落光标、不改 contenteditable。
       进编辑时光标尽量落在双击的那一点上（拿不到点就兜到正文末尾）。 */
    card.addEventListener("dblclick", (e) => {
      if (card.classList.contains("is-editing")) return; // 已经在编辑：交给浏览器原生选词
      if (e.target === edgeV) return; // 拖拽把手不算
      e.preventDefault();
      beginEditAt(note, e.clientX, e.clientY);
    });

    // blur 不冒泡，捕获在卡这一层兜住；焦点还在卡内（Tab 到边缘把手之类）不算保存
    card.addEventListener(
      "blur",
      (e) => {
        if (!card.classList.contains("is-editing")) return;
        if (card.contains(e.relatedTarget)) return;
        commitEdit(card, note);
      },
      true,
    );

    card.addEventListener("keydown", (e) => {
      if (!card.classList.contains("is-editing")) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelEdit();
        return;
      }
      if (e.key === "Enter" && e.target === body && !e.isComposing) {
        // 与首页待办编辑同款：直接插换行，不让浏览器塞块级壳
        e.preventDefault();
        document.execCommand("insertText", false, "\n");
      }
    });

    /* 只粘贴纯文本：从别的便签复制时，HTML 里会带上原来的背景色和文字样式 */
    body.addEventListener("paste", (e) => {
      if (!card.classList.contains("is-editing")) return;
      e.preventDefault();
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    });

    if (editingId === note.id) activateEditing(card, note); // 整页重渲染时保持编辑态

    cardEls.set(note.id, card);
    return card;
  }

  function render() {
    drag = null; // 重建 DOM 时任何进行中的拖拽都作废，别让布局继续用旧高度
    const cards = sortedNotes();
    cardEls.clear();
    canvas.replaceChildren(...cards.map(noteCard));
    empty.textContent = notes.length ? noMatchText : emptyText;
    empty.hidden = cards.length > 0;
    showError("");
    layout();
  }

  // ---------- 就地编辑 ----------

  function caretEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }

  /* 开编辑只是给现有节点加 contenteditable，闭包里的 note 还是原来那个，
     所以卡片外观、位置、尺寸都不受激活影响——只多一个光标 */
  function activateEditing(card, note) {
    if (card.classList.contains("is-editing")) return;
    /* 上一张卡还开着就先就地收尾（读值、存库、收光标，不重建 DOM），
       否则这次点击会把两张卡都搅乱 */
    if (editingId !== null && editingId !== note.id) {
      const prevCard = cardEls.get(editingId);
      const prevNote = notes.find((n) => n.id === editingId);
      if (prevCard && prevNote) commitEdit(prevCard, prevNote);
    }
    editingId = note.id;
    card.classList.add("is-editing");
    const body = card.querySelector(".sticky-body");
    body.setAttribute("contenteditable", "true");
    body.setAttribute("spellcheck", "false");
    body.dataset.placeholder = "正文";
  }

  /* 菜单「编辑」走这里：激活后把光标兜到正文末尾。
     双击进编辑走 beginEditAt，光标落在双击的那一点上 */
  function beginEdit(note) {
    const card = cardEls.get(note.id);
    if (!card) return;
    activateEditing(card, note);
    const body = card.querySelector(".sticky-body");
    body.focus({ preventScroll: true });
    caretEnd(body);
  }

  /* 双击进编辑：光标尽量放到双击的坐标上（Chromium 的 caretRangeFromPoint），
     点到的位置不在正文里、或环境不支持，就退回正文末尾。 */
  function beginEditAt(note, x, y) {
    const card = cardEls.get(note.id);
    if (!card) return;
    activateEditing(card, note);
    const body = card.querySelector(".sticky-body");
    body.focus({ preventScroll: true });

    const range = document.caretRangeFromPoint?.(x, y);
    if (!range || !body.contains(range.startContainer)) {
      caretEnd(body);
      return;
    }
    range.collapse(true);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /* 就地收尾：读值、去编辑态、写库，全程不重建 DOM——保存那一下卡片也不跳动 */
  function commitEdit(card, note) {
    if (!card.classList.contains("is-editing")) return;
    const bodyEl = card.querySelector(".sticky-body");
    const newBody = bodyEl.innerText.trim();
    const changed = newBody !== note.body;
    note.body = newBody;
    if (editingId === note.id) editingId = null;
    card.classList.remove("is-editing");
    for (const el of card.querySelectorAll("[contenteditable]")) {
      el.removeAttribute("contenteditable");
      el.removeAttribute("spellcheck");
      delete el.dataset.placeholder;
    }
    if (changed) persist(note);
  }

  function cancelEdit() {
    if (editingId === null) return;
    /* 先摘掉编辑态再重建 DOM：重建会把光标所在的卡片从文档里拿走，
       从而触发 blur，blur 兜底会读值落库——那样「取消」就变成保存了 */
    cardEls.get(editingId)?.classList.remove("is-editing");
    editingId = null;
    render(); // DOM 重建即丢弃未保存草稿
  }

  // ---------- 右键菜单（四项，点外部/Esc 收起由 main.js 统一负责） ----------

  /* 右键「设置文字颜色 / 设置背景颜色」：弹取色盘，拖动时实时改卡片内联样式
     （不重建 DOM，免得卡片闪一下），关闭时只在颜色真的变了才落库。 */
  function pickColor(note, field, x, y) {
    const isText = field === "textColor";
    const initial = (isText ? note.textColor : note.color) || (isText ? DEFAULT_TEXT : DEFAULT_COLOR);
    const card = cardEls.get(note.id);
    const apply = (color) => {
      if (!card) return;
      if (isText) card.style.color = color;
      else card.style.background = color;
    };
    openColorPicker({
      x,
      y,
      value: initial,
      presets: (isText ? TEXT_COLORS : BG_COLORS).map(([, color]) => color),
      onChange: (color) => {
        note[field] = color;
        apply(color);
      },
      onDone: (color) => {
        note[field] = color;
        apply(color);
        if (color !== initial) persist(note);
      },
    });
  }

  function openCardMenu(note, x, y) {
    openMenu(x, y, [
      { label: "编辑", onClick: () => beginEdit(note) },
      { label: "设置文字颜色", onClick: () => pickColor(note, "textColor", x, y) },
      { label: "设置背景颜色", onClick: () => pickColor(note, "color", x, y) },
      "-",
      {
        label: "删除",
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: "删除便签",
            message: "删除后无法恢复，确定删除这张便签？",
            okText: "删除",
            danger: true,
          });
          if (!ok) return;
          try {
            await invoke("delete_sticky_note", { id: note.id });
            const at = notes.findIndex((n) => n.id === note.id);
            if (at >= 0) notes.splice(at, 1);
            render();
          } catch (err) {
            showError(String(err));
          }
        },
      },
    ]);
  }

  // ---------- 新建 ----------

  async function createNew() {
    try {
      // 不弹确认、不进编辑、上面没有任何按钮：就是墙上一个默认尺寸的框。
      // 宽高在新建时就写死进库，之后高度只由「拖底边」改；配色每次随机一套浅色主题。
      const [bg, fg] = pickTheme();
      const input = {
        title: "",
        body: "",
        color: bg,
        textColor: fg,
        width: CELL,
        height: DEFAULT_H,
      };
      const note = await invoke("create_sticky_note", { input });
      notes.unshift(note);
      render();
    } catch (err) {
      showError(String(err));
    }
  }

  // ---------- 手动拉伸：下边缘热区拖拽 + 吸附整列 + 防抖落库 ----------

  const saving = new Map(); // id -> 定时器，拖拽中连发只存最后一次
  function scheduleSave(note) {
    clearTimeout(saving.get(note.id));
    saving.set(
      note.id,
      setTimeout(() => {
        saving.delete(note.id);
        persist(note);
      }, 150),
    );
  }

  /* 只在用户拖动下边缘松手后调用：把最终高度与吸附后的列宽落库。
     布局、渲染、窗口缩放一律不调它——高度是「死的」，只有拖底边才变。
     height 由拖拽方直接给（松手那一帧布局可能还没跑，不能靠量 offsetHeight）。 */
  function snapSize(card, note, height) {
    const cols = colsNow();
    const snapped = widthOfCats(
      Math.min(Math.max(1, Math.round((card.offsetWidth + GAP) / (CELL + GAP))), cols),
    );
    if (Math.abs(card.offsetWidth - snapped) > 2) card.style.width = `${snapped}px`;
    const h = Math.max(Math.round(height ?? card.offsetHeight), MIN_H);
    if (note.width === snapped && heightOf(note) === h) {
      scheduleLayout(); // 高度没变也要排一次：拖动中邻居被顶开过，得挪回原位
      return;
    }
    note.width = snapped;
    note.height = h;
    scheduleSave(note);
    scheduleLayout(); // 这张占了新列宽/新高度，下方各列整体顺移
  }

  /* 下边缘拖拽：pointerdown 在热区上接管并捕获指针，拖动过程中把高度写进 drag 并
     每帧重排整面墙——本卡连续跟手变高变矮，其它卡同时上下让位，不会出现「拖着的
     卡压住邻居、松手才弹开」的重叠。pointerup 才写库。
     拖完位移不足 8px 的误触：高度回到原值，邻居也挪回原位。
     宽度不许拖：恒由布局吸附整列；高度也只有这条路径能改。 */
  function startEdgeDrag(e, card, note) {
    if (e.button !== 0) return;
    e.preventDefault();
    const zone = e.currentTarget;
    try {
      zone.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败就走普通事件流，热区本身也能收 pointermove */
    }
    const startY = e.clientY;
    const startH = card.offsetHeight;
    drag = { id: note.id, height: startH };
    let maxDy = 0;
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > maxDy) maxDy = Math.abs(dy);
      drag.height = Math.max(MIN_H, startH + dy);
      scheduleLayout(); // 并帧重排：本卡高度 + 下方各列位置一起跟手
    };
    const onUp = () => {
      zone.removeEventListener("pointermove", onMove);
      zone.removeEventListener("pointerup", onUp);
      zone.removeEventListener("pointercancel", onUp);
      const finalH = drag?.height ?? heightOf(note);
      drag = null;
      if (maxDy < 8) {
        // 位移太小的误触：不写库，重排一次把邻居挪回原位
        scheduleLayout();
        return;
      }
      snapSize(card, note, finalH);
    };
    zone.addEventListener("pointermove", onMove);
    zone.addEventListener("pointerup", onUp);
    zone.addEventListener("pointercancel", onUp);
  }

  // 窗口宽度变了，列数换算要重算（canvas 在 wall 内部，不会反过来扰动 wall）
  const wallObserver = new ResizeObserver(scheduleLayout);

  // ---------- 初始化与刷新 ----------

  async function refresh() {
    try {
      notes = await invoke("list_sticky_notes");
      render();
    } catch (err) {
      showError(String(err));
    }
  }

  canvas = document.createElement("div");
  canvas.className = "sticky-canvas";
  wall.append(canvas);

  if (search && searchClear) {
    search.addEventListener("input", () => {
      query = search.value.trim();
      searchClear.hidden = !search.value;
      render();
    });
    searchClear.addEventListener("click", () => {
      search.value = "";
      query = "";
      searchClear.hidden = true;
      render();
      search.focus();
    });
  }
  addButton?.addEventListener("click", createNew);

  wallObserver.observe(wall);
  refresh();

  return { refresh, element: wall };
}
