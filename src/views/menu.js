/* 通用右键菜单：主菜单 + 最多两级向右展开的浮层，空间块、连线、笔记树都从这里弹。
 * 用法：openMenu(x, y, [{ label, onClick, danger, swatch, trailing, color, children, colorPicker, slider }])
 *   trailing    —— 行尾的当前值指示，纯展示、不响应指针，color 给圆点当填充色。
 *   children    —— 下一级菜单：鼠标移到这一行就在右边展开，移开收掉；点一下也开着。
 *   colorPicker —— 颜色行：悬停就在下一级展开取色板，选色实时回调，收起时 onDone 落库。
 *   slider      —— 滑条行：悬停就在下一级展开一根滑条（音量），拖动实时回调，收起时 onDone 落库。
 * 主菜单行的 children/colorPicker/slider 开二级；二级行的开三级；三级只放叶子。
 * 菜单项点击后自己 stopPropagation —— 下面挂在 document 上的「点外部关菜单」，
 * 不挡住的话刚弹出的东西会被误当成「点到了外面」。 */

import { closeColorPicker, createColorPanel } from "./color-picker.js";

/* 鼠标从父行挪到子菜单要跨过中间那条缝，收起留一点缓冲，别让子菜单一抖就没了 */
const SUBMENU_CLOSE_DELAY = 160;

let closeTimer = 0;
/* 拖滑条时指针会离开浮层，这时不能按「鼠标走了」把菜单收掉 */
let sliderDragging = false;

/* 二级、三级各一个浮层槽位；[0] 空着，对应主菜单 #ctx-menu */
const slots = [
  null,
  { el: null, row: null, commit: null },
  { el: null, row: null, commit: null },
];

function cancelClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = 0;
  }
}

/* 收起一列：先把它的临时改动按确定落库，再藏起来 */
function commitSlot(slot) {
  if (!slot) return;
  const { el, commit } = slot;
  slot.row = null;
  slot.commit = null;
  if (el) el.hidden = true;
  commit?.();
}

/* 只收比 fromLevel 更深的那几列，当前这一列留着 */
function closeDeeper(fromLevel) {
  for (let level = 2; level >= fromLevel; level -= 1) commitSlot(slots[level]);
}

function closeSubmenu() {
  cancelClose();
  closeDeeper(1);
}

function scheduleClose() {
  cancelClose();
  if (sliderDragging) return;
  closeTimer = setTimeout(() => {
    closeTimer = 0;
    closeSubmenu();
  }, SUBMENU_CLOSE_DELAY);
}

/* 全屏元素在顶层，body 里的浮层会被它整个盖住；菜单得搬进那一层里 */
function menuHost() {
  return document.fullscreenElement || document.body;
}

function ensureSlot(level) {
  const slot = slots[level];
  if (!slot.el) {
    const el = document.createElement("div");
    el.className = "ctx-menu ctx-submenu";
    el.style.zIndex = String(50 + level); /* 主菜单 50 / 二级 51 / 三级 52 */
    el.hidden = true;
    el.addEventListener("mouseenter", cancelClose);
    /* 在这一列里挪动（含行与行之间的缝）都算没离开 */
    el.addEventListener("pointermove", cancelClose);
    el.addEventListener("mouseleave", scheduleClose);
    document.body.append(el);
    slot.el = el;
  }
  /* 全屏时顶层元素盖住 body：整列得搬进全屏层里才看得见 */
  const host = menuHost();
  if (slot.el.parentElement !== host) host.append(slot.el);
  return slot;
}

export function closeMenu() {
  closeSubmenu();
  const menu = document.getElementById("ctx-menu");
  if (menu) menu.hidden = true;
}

/* 主菜单是不是正开着。给「同一个按钮再点一下收起」那种入口用；
   传 kind 就只认这一类菜单，免得把别人刚弹出的右键菜单误收掉。 */
export function isMenuOpen(kind) {
  const menu = document.getElementById("ctx-menu");
  if (!menu || menu.hidden) return false;
  return kind ? menu.dataset.kind === kind : true;
}

/* 浮层从父菜单的边框外侧出来，不是从行的右边：行和菜单边之间还隔着内边距和边框。
   右边放不下就翻到左边，上下收进视口。 */
function placePanel(box, row) {
  const rowRect = row.getBoundingClientRect();
  const menuRect = row.closest(".ctx-menu")?.getBoundingClientRect() ?? rowRect;
  const rect = box.getBoundingClientRect();
  let left = menuRect.right + 4;
  if (left + rect.width > window.innerWidth - 8) left = menuRect.left - rect.width - 4;
  box.style.left = `${Math.max(8, left)}px`;
  box.style.top = `${Math.max(8, Math.min(rowRect.top - 5, window.innerHeight - rect.height - 8))}px`;
}

/* 三级浮层里的滑条：只负责一根轨道和实时回调，收起时由调用方的 onDone 落库 */
function createSliderPanel({ value = 0, onChange } = {}) {
  const clamp = (v) => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0));
  const wrap = document.createElement("div");
  wrap.className = "menu-slider";
  wrap.innerHTML = `
    <div class="menu-slider-rail" role="slider" aria-label="音量">
      <div class="menu-slider-fill"></div>
      <span class="menu-slider-knob"></span>
    </div>
    <span class="menu-slider-value"></span>`;
  const rail = wrap.querySelector(".menu-slider-rail");
  const fill = wrap.querySelector(".menu-slider-fill");
  const knob = wrap.querySelector(".menu-slider-knob");
  const label = wrap.querySelector(".menu-slider-value");
  let level = clamp(value);

  const render = () => {
    fill.style.width = `${level * 100}%`;
    knob.style.left = `${level * 100}%`;
    label.textContent = `${Math.round(level * 100)}%`;
    rail.setAttribute("aria-valuenow", String(Math.round(level * 100)));
  };

  const seek = (clientX) => {
    const rect = rail.getBoundingClientRect();
    if (!rect.width) return;
    level = clamp((clientX - rect.left) / rect.width);
    render();
    onChange?.(level);
  };

  rail.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sliderDragging = true;
    seek(e.clientX);
    const move = (event) => seek(event.clientX);
    const up = () => {
      sliderDragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      /* 松手时指针已经不在任何一列菜单上，就把菜单收了；还在菜单里就留着 */
      const panels = [document.getElementById("ctx-menu"), slots[1]?.el, slots[2]?.el];
      if (!panels.some((el) => el && !el.hidden && el.matches(":hover"))) closeMenu();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });

  render();
  return {
    el: wrap,
    get value() {
      return level;
    },
  };
}

/* 在下一级槽位里放内容：普通菜单项列表、一块取色板，或者一根滑条 */
function openSlot(level, row, item, closeAll) {
  cancelClose();
  /* 同一级换内容、或开更深一级之前，先把这一级和更深的旧面板收尾 */
  closeDeeper(level);
  const slot = ensureSlot(level);
  const el = slot.el;
  el.textContent = "";
  el.classList.remove("color-menu", "slider-menu");
  if (item.colorPicker) {
    el.classList.add("color-menu");
    const config = item.colorPicker;
    const panel = createColorPanel({
      ...config,
      onChange: (color) => {
        /* 颜色行尾那颗点就是当前色，色板里一动它就跟着变 */
        const dot = row.querySelector(".menu-icon-dot");
        if (dot) dot.style.setProperty("--menu-icon-color", color || "transparent");
        config.onChange?.(color);
      },
    });
    el.append(panel.el);
    /* current 随拖动变，收起时现取，交给颜色行自己的 onDone 落库 */
    slot.commit = () => item.colorPicker.onDone?.(panel.current);
  } else if (item.slider) {
    el.classList.add("slider-menu");
    const config = item.slider;
    const panel = createSliderPanel({
      ...config,
      onChange: (value) => {
        /* 声音行尾的百分比跟着滑条走，不用等收起才更新 */
        const show = row.querySelector(".menu-row-volume");
        if (show) show.textContent = `${Math.round(value * 100)}%`;
        config.onChange?.(value);
      },
    });
    el.append(panel.el);
    slot.commit = () => item.slider.onDone?.(panel.value);
  } else {
    fill(el, item.children, closeAll, level);
  }
  slot.row = row;
  el.hidden = false;
  placePanel(el, row);
}

/* 行尾的展开箭头：字符「›」太细太飘，用一枚圆头的 chevron */
function createMenuArrow() {
  const arrow = document.createElement("span");
  arrow.className = "menu-arrow";
  arrow.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M6.2 3.8 10.4 8l-4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return arrow;
}

function fill(container, items, closeAll, level) {
  container.textContent = "";
  for (const item of items) {
    if (item === "-") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      container.append(sep);
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

    const deeper = Boolean(item.colorPicker || item.slider || item.children) && level < 2;
    if (deeper) {
      /* 行尾只说「这行还有下一级」，不吃指针 */
      button.classList.add("has-trailing");
      const meta = document.createElement("span");
      meta.className = "menu-row-meta";
      if (item.colorPicker) {
        const dot = document.createElement("span");
        dot.className = "menu-icon-dot";
        dot.style.setProperty("--menu-icon-color", item.colorPicker.value || "transparent");
        meta.append(dot);
      }
      if (item.slider) {
        /* 声音行尾先把当前音量报出来，滑条一动这里跟着变 */
        const show = document.createElement("span");
        show.className = "menu-row-volume";
        show.textContent = `${Math.round((Number(item.slider.value) || 0) * 100)}%`;
        meta.append(show);
      }
      meta.append(createMenuArrow());
      button.append(meta);
      button.addEventListener("mouseenter", () => openSlot(level + 1, button, item, closeAll));
      /* 直接从这一行滑出去（没落到子菜单上）也要收 */
      button.addEventListener("mouseleave", scheduleClose);
      button.addEventListener("click", (event) => {
        /* hover 时多半已经展开了；点一下也让它在，但别把菜单关掉 */
        event.stopPropagation();
        openSlot(level + 1, button, item, closeAll);
      });
    } else {
      if (item.trailing) {
        /* 行尾的当前值指示：只说明这一行现在是什么，不吃指针，所以不跟「整行可点」抢反馈 */
        button.classList.add("has-trailing");
        const trailing = document.createElement("span");
        trailing.className = "menu-icon";
        trailing.innerHTML = item.trailing;
        if (item.color) trailing.style.setProperty("--menu-icon-color", item.color);
        button.append(trailing);
      }
      /* 挪到没有下一级的行上：比它深的那几列就该收了，当前这列留着。
         鼠标仍在菜单里走动，得把上一行 mouseleave 排下的收起取消掉。 */
      button.addEventListener("mouseenter", () => {
        cancelClose();
        closeDeeper(level + 1);
      });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        closeAll();
        item.onClick();
      });
    }
    container.append(button);
  }
}

export function openMenu(x, y, items, options = {}) {
  closeColorPicker(true);
  closeSubmenu();
  const menu = document.getElementById("ctx-menu");
  /* 全屏时把主菜单也搬进顶层，不然它被全屏元素压在下面 */
  const host = menuHost();
  if (menu.parentElement !== host) host.append(menu);
  if (!menu.__hoverGuard) {
    menu.__hoverGuard = true;
    menu.addEventListener("pointermove", cancelClose);
  }
  fill(menu, items, closeMenu, 0);
  /* 这一份菜单是谁开的：给 isMenuOpen(kind) 认门用 */
  if (options.kind) menu.dataset.kind = options.kind;
  else delete menu.dataset.kind;
  if (options.label) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = options.label;
    menu.prepend(label);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menu.style.right = "auto";
}

/* 点菜单外部、按 Esc 都收起。用 composedPath 而不是 contains(e.target)：菜单项点击时
   可能已经重建/摘掉了被点的那颗按钮，contains 会误判成「外部点击」。 */
document.addEventListener("click", (e) => {
  const menu = document.getElementById("ctx-menu");
  if (!menu || menu.hidden) return;
  const path = e.composedPath();
  const inside = path.includes(menu) || slots.some((slot) => slot?.el && path.includes(slot.el));
  if (!inside) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
