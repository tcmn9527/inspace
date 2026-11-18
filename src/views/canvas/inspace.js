/* 从 canvas.js 拆出：inspace */

import { agentRenameSpace } from "./agent-layer.js";
import { commitEditing } from "./text-edit.js";
import { setTreeCollapsed } from "./tree.js";
import { current, edgeLabelEditor, editingId, flushBlockContents, flushCamera, flushItems, loadList, newId, renderTree, select, setCurrent, setTreeRenaming, showError, store, switchTo, treeCollapsed, treeRenaming, treeUi } from "../canvas.js";

/* ---------- .inspace 容器导入导出 ----------
   导出成标准 zip：画布包解压是一个画布目录，分组件包解压是一个子分组。
   导出会打开系统保存框，导入会打开系统打开框；重名由后端自动加后缀，不覆盖。 */

export async function exportTreeSpace(node, group) {
  try {
    if (!group && current?.meta.id === node.id) {
      if (editingId || edgeLabelEditor) commitEditing();
      await flushBlockContents();
      await flushItems();
      await flushCamera();
    }
    await store.exportSpace(node.id, group);
  } catch (error) {
    showError(error);
  }
}

export async function importIntoGroup(parent) {
  try {
    if (current) {
      if (editingId || edgeLabelEditor) commitEditing();
      await flushBlockContents();
      await flushItems();
      await flushCamera();
    }
    const result = await store.importSpace(parent);
    if (!result) return;
    const reveal = (id) => {
      let prefix = id;
      while (prefix) {
        treeCollapsed.delete(prefix);
        const cut = prefix.lastIndexOf("/");
        if (cut < 0) break;
        prefix = prefix.slice(0, cut);
      }
    };
    reveal(parent || "");
    if (result.kind === "canvas") {
      await loadList();
      await switchTo(result.id);
    } else {
      reveal(result.id);
      await loadList();
    }
  } catch (error) {
    showError(error);
  }
}

/* 就地改名：行内换成输入框，Enter/失焦提交，Esc 放弃 */
export function startTreeRename(kind, id, name) {
  setTreeRenaming({ kind, id });
  renderTree();
  const row = treeUi.body.querySelector(`.space-tree-row[data-id="${CSS.escape(id)}"]`);
  if (!row) {
    setTreeRenaming(null);
    return;
  }
  const label = row.querySelector(".space-tree-label");
  const input = document.createElement("input");
  input.className = "space-tree-rename";
  input.value = name;
  input.spellcheck = false;
  label.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    setTreeRenaming(null);
    if (!commit || !value || value === name) {
      renderTree();
      return;
    }
    try {
      if (kind === "canvas") {
        await agentRenameSpace(id, value);
      } else {
        await renameTreeGroup(id, value);
      }
    } catch (error) {
      showError(error);
      renderTree();
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish(false);
    }
  });
  input.addEventListener("blur", () => void finish(true));
  input.addEventListener("click", (event) => event.stopPropagation());
}

export async function renameTreeGroup(id, name) {
  const newId = await store.renameGroup(id, name);
  /* 折叠记忆里的前缀跟着换 */
  const remap = (key) => (key === id || key.startsWith(`${id}/`) ? newId + key.slice(id.length) : key);
  setTreeCollapsed(new Set([...treeCollapsed].map(remap)));
  if (current && (current.meta.id === id || current.meta.id.startsWith(`${id}/`))) {
    /* 当前画布住在这个分组里：id 前缀变了，落盘后按新 id 重开 */
    if (editingId || edgeLabelEditor) commitEditing();
    await flushBlockContents();
    await flushItems();
    await flushCamera();
    const next = remap(current.meta.id);
    setCurrent(null);
    await loadList();
    await switchTo(next);
  } else {
    await loadList();
  }
  return newId;
}
