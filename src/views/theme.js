/* 应用主题：42 套配色（22 深色 + 20 浅色），覆盖页面底色、浮层、文字、线框、强调色。
 *
 * 每套主题只描述「色相 + 饱和度 + 明度 + 明暗模式」这几项骨架，具体色值由下面的
 * palette() 统一生成，所以各套之间的明暗关系完全一致：
 *   深色：正文/底色 ≈ 15:1，次要文字/浮层 ≈ 5:1，强调色/浮层 ≈ 5:1
 *   浅色：正文/底色 ≈ 13:1，次要文字/浮层 ≈ 5.5:1，强调色/浮层 ≈ 4.6:1
 * 随便换哪套都不会出现看不清文字、描边消失的情况。
 *
 * 选中的主题存 localStorage，模块加载时就先套上（早于首帧绘制，不会闪默认色）。
 * 标题栏的主题按钮（index.html 里 #theme-btn）点击后弹出选择框。 */

const STORAGE_KEY = "workbench.theme";

/* 没选过主题时套这套（雪白）。只影响首次运行——选过一次就存进 localStorage，
 * 之后每次启动都跟着他自己的选择走，不会被他手动定的主题顶掉。 */
const DEFAULT_THEME = "snow";

/* [id, 名称, 底色色相, 底色饱和度, 强调色相, 底色明度] —— 深色系 */
export const THEMES = [
  ["cosmos", "宇宙", 220, 6, 210, 6],
  ["graphite", "石墨", 220, 6, 210, 6],
  ["steel", "钢青", 205, 14, 205, 8],
  ["ocean", "深海", 200, 32, 192, 11],
  ["midnight", "午夜", 232, 28, 225, 11],
  ["indigo", "靛蓝", 255, 26, 250, 11],
  ["violet", "紫罗兰", 272, 24, 272, 11],
  ["plum", "梅子", 305, 22, 315, 11],
  ["rose", "玫瑰", 340, 22, 338, 11],
  ["wine", "酒红", 352, 28, 355, 10],
  ["terracotta", "赤陶", 18, 24, 20, 11],
  ["amber", "琥珀", 36, 28, 40, 11],
  ["sand", "沙岩", 42, 16, 45, 12],
  ["olive", "橄榄", 68, 18, 75, 11],
  ["moss", "苔藓", 100, 16, 100, 11],
  ["forest", "森林", 145, 22, 150, 11],
  ["emerald", "翡翠", 165, 24, 160, 11],
  ["teal", "松石", 185, 26, 180, 11],
  ["ice", "冰川", 195, 20, 190, 12],
  ["slate", "石板", 215, 8, 210, 7],
  ["coffee", "咖啡", 24, 16, 28, 11],
];

/* 浅色系：[id, 名称, 色相, 饱和度, 强调色相, 底色明度, "light"] */
export const LIGHT_THEMES = [
  // —— 白 / 灰白 ——
  ["snow", "雪白", 210, 3, 210, 99, "light"],
  ["mist", "雾白", 215, 6, 215, 96, "light"],
  ["cream", "米白", 45, 18, 42, 97, "light"],
  ["ivory", "象牙", 40, 22, 40, 96, "light"],
  ["ash", "灰白", 220, 5, 220, 93, "light"],
  // —— 暖色 ——
  ["warm-sand", "暖沙", 35, 26, 35, 95, "light"],
  ["peach", "蜜桃", 22, 38, 20, 95, "light"],
  ["apricot", "杏橘", 28, 42, 25, 95, "light"],
  ["rose-light", "玫瑰粉", 345, 32, 345, 96, "light"],
  ["brick", "砖红", 12, 32, 12, 94, "light"],
  ["caramel", "焦糖", 30, 32, 30, 93, "light"],
  // —— 浅彩 ——
  ["sky", "天蓝", 205, 42, 205, 94, "light"],
  ["mint", "薄荷", 160, 28, 160, 94, "light"],
  ["lavender", "薰衣草", 265, 30, 265, 95, "light"],
  ["leaf", "嫩绿", 110, 22, 110, 94, "light"],
  ["lake", "湖蓝", 195, 38, 195, 93, "light"],
  ["sakura", "樱粉", 335, 42, 335, 96, "light"],
  ["lilac", "淡紫", 285, 22, 285, 95, "light"],
  ["celadon", "青瓷", 150, 18, 150, 93, "light"],
  ["milk-tea", "奶茶", 32, 22, 32, 94, "light"],
];

export function palette([, , hue, sat, accentHue, lightness, mode]) {
  const tint = (l) => `hsl(${hue} ${sat}% ${Math.min(99, Math.max(2, l))}%)`;
  const clampL = (l) => Math.min(99, Math.max(2, l));

  if (mode === "light") {
    // 浅色：浅底 + 深字，描边比底色深一档，强调色压暗保证在浅底上看得清
    return {
      "--bg": tint(lightness),
      "--surface": tint(lightness + 3),
      "--surface-2": tint(lightness - 4),
      "--line": `hsl(${hue} ${Math.min(sat + 8, 26)}% ${clampL(lightness - 24)}%)`,
      "--fg": `hsl(${hue} ${Math.min(sat + 14, 30)}% 16%)`,
      "--muted": `hsl(${hue} ${Math.min(sat + 8, 20)}% 38%)`,
      "--accent": `hsl(${accentHue} 66% 42%)`,
      "--accent-fg": `hsl(${accentHue} 80% 98%)`,
      "--danger": "hsl(4 68% 45%)",
    };
  }

  return {
    "--bg": tint(lightness),
    "--surface": tint(lightness + 4),
    "--surface-2": tint(lightness + 2),
    "--line": `hsl(${hue} ${Math.min(sat + 8, 22)}% 33%)`,
    "--fg": `hsl(${hue} ${Math.min(sat + 10, 26)}% 95%)`,
    "--muted": `hsl(${hue} ${Math.min(sat + 4, 16)}% 66%)`,
    "--accent": `hsl(${accentHue} 68% 62%)`,
    "--accent-fg": `hsl(${accentHue} 80% 10%)`,
    "--danger": "hsl(4 72% 63%)",
  };
}

let currentId = null;

const ALL_THEMES = [...THEMES, ...LIGHT_THEMES];

function apply(id, { persist = true } = {}) {
  const theme = ALL_THEMES.find((t) => t[0] === id) || ALL_THEMES.find((t) => t[0] === DEFAULT_THEME);
  const vars = palette(theme);
  for (const [key, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, value);
  }
  document.documentElement.dataset.theme = theme[0];
  currentId = theme[0];
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, theme[0]);
    } catch {
      /* 隐私模式之类写不进去就算了，本次运行内仍然生效 */
    }
  }
  for (const chip of document.querySelectorAll(".theme-chip")) {
    chip.classList.toggle("is-active", chip.dataset.theme === currentId);
  }
  /* 深空背景层（cosmos.js）靠这个事件启停；其他监听方也可以按需响应 */
  document.dispatchEvent(new CustomEvent("themechange", { detail: { id: currentId } }));
}

export function setTheme(id) {
  apply(id);
  return currentId;
}

export function currentTheme() {
  return currentId;
}

/* 模块加载就套用上次选的主题（此时 DOM 还没解析完，但 <html> 已经在了） */
let saved = null;
try {
  saved = localStorage.getItem(STORAGE_KEY);
} catch {
  saved = null;
}
apply(saved || DEFAULT_THEME, { persist: false });

// ---------- 选择弹窗 ----------

let themeBtn = null;
let ui = null;
let chipsReady = false;

function renderChips() {
  const addChips = (container, list) => {
    for (const theme of list) {
      const [id, name] = theme;
      const vars = palette(theme);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "theme-chip";
      chip.dataset.theme = id;
      chip.title = name;
      chip.setAttribute("aria-label", `主题 ${name}`);
      chip.innerHTML = `
        <span class="theme-chip-preview">
          <span class="theme-chip-line"></span>
          <span class="theme-chip-dot"></span>
        </span>
        <span class="theme-chip-name">${name}</span>
      `;
      const preview = chip.querySelector(".theme-chip-preview");
      if (id === "cosmos") {
        preview.classList.add("is-cosmos");
      } else {
        preview.style.background = vars["--surface"];
        chip.querySelector(".theme-chip-line").style.background = vars["--line"];
        chip.querySelector(".theme-chip-dot").style.background = vars["--accent"];
      }
      chip.classList.toggle("is-active", id === currentId);
      chip.addEventListener("click", () => apply(id));
      container.append(chip);
    }
  };
  addChips(ui.darkGrid, THEMES);
  addChips(ui.lightGrid, LIGHT_THEMES);
}

function openTheme() {
  if (!ui) return;
  if (!chipsReady) {
    renderChips();
    chipsReady = true;
  }
  ui.page.hidden = false;
  /* 焦点收进弹层，别留在标题栏那颗主题按钮上 */
  ui.dialog.focus();
  themeBtn?.setAttribute("aria-expanded", "true");
}

function closeTheme() {
  if (!ui || ui.page.hidden) return;
  ui.page.hidden = true;
  themeBtn?.setAttribute("aria-expanded", "false");
}

export function initTheme() {
  themeBtn = document.getElementById("theme-btn");
  const page = document.getElementById("theme-view");
  if (!themeBtn || !page) return;
  ui = {
    page,
    dialog: document.getElementById("theme-dialog"),
    scrim: document.getElementById("theme-scrim"),
    close: document.getElementById("theme-close"),
    darkGrid: page.querySelector(".theme-pop-grid-dark"),
    lightGrid: page.querySelector(".theme-pop-grid-light"),
  };
  themeBtn.addEventListener("click", () => {
    if (!ui.page.hidden) {
      closeTheme();
      return;
    }
    /* 设置页开着时先回画布，避免两个弹层叠在一起 */
    window.dispatchEvent(new CustomEvent("inspace:route", { detail: "canvas" }));
    openTheme();
  });
  ui.close.addEventListener("click", closeTheme);
  ui.scrim.addEventListener("click", closeTheme);
  document.addEventListener("keydown", (event) => {
    if (ui.page.hidden) return;
    if (event.key !== "Escape" || event.repeat) return;
    event.preventDefault();
    closeTheme();
  });
  /* 切去设置或别的页面时，主题弹窗跟着收起 */
  window.addEventListener("inspace:route", closeTheme);
}
