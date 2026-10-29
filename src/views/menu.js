/* 通用右键菜单：沿用 #ctx-menu 那个浮层，空间块、连线、笔记树都从这里弹。
 * 用法：openMenu(x, y, [{ label, onClick, danger, swatch, trailing, color }])
 *   trailing —— 行尾的当前值指示，纯展示、不响应指针，color 给圆点当填充色。
 * 菜单项点击后自己 stopPropagation —— 下面挂在 document 上的「点外部关菜单」，
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
    if (item.trailing) {
      /* 行尾的当前值指示：只说明这一行现在是什么，不吃指针，所以不跟「整行可点」抢反馈 */
      button.classList.add("has-trailing");
      const trailing = document.createElement("span");
      trailing.className = "menu-icon";
      trailing.innerHTML = item.trailing;
      if (item.color) trailing.style.setProperty("--menu-icon-color", item.color);
      button.append(trailing);
    }
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

/* 点菜单外部、按 Esc 都收起。用 composedPath 而不是 contains(e.target)：菜单项点击时
   可能已经重建/摘掉了被点的那颗按钮，contains 会误判成「外部点击」。 */
document.addEventListener("click", (e) => {
  const menu = document.getElementById("ctx-menu");
  if (menu && !menu.hidden && !e.composedPath().includes(menu)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
