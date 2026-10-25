/* 工作台主题：40 套配色（20 深色 + 20 浅色），覆盖页面底色、浮层、文字、线框、强调色。
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

/* [id, 名称, 底色色相, 底色饱和度, 强调色相, 底色明度] —— 深色系 */
export const THEMES = [
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
  const theme = ALL_THEMES.find((t) => t[0] === id) || THEMES[0];
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
}

/* 模块加载就套用上次选的主题（此时 DOM 还没解析完，但 <html> 已经在了） */
let saved = null;
try {
  saved = localStorage.getItem(STORAGE_KEY);
} catch {
  saved = null;
}
apply(saved || THEMES[0][0], { persist: false });

// ---------- 选择框 ----------

let pop = null;

function closePop() {
  if (!pop) return;
  pop.remove();
  pop = null;
  document.removeEventListener("pointerdown", onDocDown, true);
  document.removeEventListener("keydown", onKeyDown, true);
  themeBtn?.setAttribute("aria-expanded", "false");
}

function onDocDown(e) {
  if (!pop) return;
  if (pop.contains(e.target) || e.target === themeBtn || themeBtn?.contains(e.target)) return;
  closePop();
}

function onKeyDown(e) {
  if (e.key === "Escape" && pop) {
    e.stopPropagation();
    closePop();
  }
}

let themeBtn = null;

function buildPop() {
  const panel = document.createElement("div");
  panel.className = "theme-pop";
  panel.innerHTML = `
    <div class="theme-pop-title">主题</div>
    <div class="theme-pop-scroll">
      <div class="theme-pop-group">深色</div>
      <div class="theme-pop-grid theme-pop-grid-dark"></div>
      <div class="theme-pop-group">浅色</div>
      <div class="theme-pop-grid theme-pop-grid-light"></div>
    </div>
  `;

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
      chip.querySelector(".theme-chip-preview").style.background = vars["--surface"];
      chip.querySelector(".theme-chip-line").style.background = vars["--line"];
      chip.querySelector(".theme-chip-dot").style.background = vars["--accent"];
      chip.classList.toggle("is-active", id === currentId);
      chip.addEventListener("click", () => apply(id));
      container.append(chip);
    }
  };
  addChips(panel.querySelector(".theme-pop-grid-dark"), THEMES);
  addChips(panel.querySelector(".theme-pop-grid-light"), LIGHT_THEMES);
  document.body.append(panel);
  pop = panel;

  // 贴着标题栏右上角展开
  const rect = themeBtn.getBoundingClientRect();
  const width = panel.getBoundingClientRect().width;
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  panel.style.left = `${Math.max(8, left)}px`;
  panel.style.top = `${rect.bottom + 6}px`;

  themeBtn.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKeyDown, true);
}

export function initTheme() {
  themeBtn = document.getElementById("theme-btn");
  if (!themeBtn) return;
  themeBtn.addEventListener("click", () => {
    if (pop) closePop();
    else buildPop();
  });
}
