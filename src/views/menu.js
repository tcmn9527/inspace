/* 通用右键菜单：沿用 #ctx-menu 那个浮层，和便签/待办菜单同一套外观。
 * 用法：openMenu(x, y, [{ label, onClick, danger, swatch, separator }])
 * 菜单项点击后自己 stopPropagation —— home.js 在 document 上挂了「点外部关菜单」，
 * 不挡住的话刚弹出的东西会被误当成「点到了外面」。 */

import { closeColorPicker } from "./color-picker.js";

export function closeMenu() {
  const menu = document.getElementById("ctx-menu");
  if (menu) menu.hidden = true;
}

export function openMenu(x, y, items, options = {}) {
  closeColorPicker(true);
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
