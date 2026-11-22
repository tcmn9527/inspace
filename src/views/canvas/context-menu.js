/* 从 canvas.js 拆出：context-menu */

import { h3dEntries } from "./h3d-ui.js";
import { BORDER_DEFAULT_WIDTH, BORDER_MAX_WIDTH, CLOSE_X_SVG, PAGE_RATIOS, PRESETS, absolutePathOf, addSceneModelFlow, cancelPlanCalibration, changeProductImage, clientToWorld, collectPictureImageSrcs, copyItems, createFurnitureFlow, current, dropGenRun, dropRegionImage, dropVideoRun, ebookKey, ebookTocCache, editingId, exportPictureImage, exportQuote, exportSceneFlow, fileEditor, filePreviewCache, findItem, flushFileEditor, genTimers, imageCache, importCsvFromQuote, isContainer, isFileEditable, itemBounds, itemEls, modalOpen, newSceneForProduct, noteEditor, noteImageCache, noteTimers, openImageCompare, openMenu, ownedMembers, pickProductModel, pictureEditors, pictureMenuEntries, pictureTimers, placeProductInSceneFlow, placeProductOnPlanFlow, planCalibration, previewKey, promptDialog, refreshFileBlock, refreshPictureChrome, refreshQuotes, renamePageFlow, revealFileBlock, revealTarget, scenePlacementActive, sceneTimers, scheduleItemsSave, select, selectedIds, setConnectorBend, setEditingId, setModalOpen, setNoteEditor, setPageOrderFlow, setPageRatio, setSceneCameraPreset, setScenePlacementMode, showError, showToast, srcInUse, startFileEdit, startNoteEdit, startTextEdit, startPlanCalibration, store, syncConnector, syncItemElement, toggleContainer, toolMenuEntries, updateSelection, videoControlOf } from "../canvas.js";

/* ---------- 右键菜单 ---------- */

/* 颜色行：悬停就在右边展开取色板，选色实时落到块上，色板收起时才写盘 */
export function colorEntry(item, prop, { presets, allowAlpha = true, save } = {}) {
  let touched = false;
  return {
    label: "颜色",
    colorPicker: {
      /* 每次现读：同一份菜单里改完色再悬停回来，色板要停在新颜色上 */
      get value() {
        return item[prop] || "";
      },
      seed: prop === "color" || prop === "fillColor" ? "#ffffff" : "#9a9a9a",
      presets: presets || PRESETS,
      allowAlpha,
      onChange: (color) => {
        touched = true;
        applyColor(item, prop, color);
      },
      onDone: () => {
        if (touched) (save || scheduleItemsSave)();
      },
    },
  };
}

/* 带边框的块共用一组二级菜单：颜色、宽度、圆角。椭圆天生是圆的，不给圆角 */
export function borderMenuEntry(item, colorRow) {
  const children = [
    colorRow,
    { label: "宽度", onClick: () => openBorderWidthDialog(item) },
  ];
  if (item.type !== "ellipse") children.push({ label: "圆角", onClick: () => openRadiusDialog(item) });
  return { label: "边框", children };
}

/* 文件卡（docx 正文 / 文本预览）的复制语义：正文区里有非空文字选区 → 复制纯文字；
   没有选区 → 复制整块（面板）。Ctrl+C 和右键「复制」共用一套判定，不另开菜单项。 */
export function itemBodyEl(item) {
  const el = itemEls.get(item.id);
  if (!el) return null;
  return el.querySelector(".canvas-file-docx-body, .canvas-file-preview, .canvas-file-xlsx-scroll, .canvas-file-pptx-scroll");
}
/* 给定正文元素内，当前有没有非空文字选区；有就返回纯文本，没有返回 null */
export function bodySelectionText(bodyEl) {
  if (!bodyEl) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!bodyEl.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  return text && text.trim() ? text : null;
}
/* 任意文件卡正文区里的非空文字选区（不指定哪张卡），供全局 Ctrl+C 用 */
export function activeBodySelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  const body = el && el.closest && el.closest(".canvas-file-docx-body, .canvas-file-preview, .canvas-file-xlsx-scroll, .canvas-file-pptx-scroll");
  return body ? bodySelectionText(body) : null;
}
export async function copyBodySelectionText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      document.execCommand("copy");
    } catch {
      /* 都拿不到剪贴板就随它，选区还在，用户可以再试一次 */
    }
  }
}

export const STACK_LABELS = {
  text: "文字",
  note: "笔记卡",
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
  ebook: "电子书",
  rect: "矩形",
  ellipse: "圆形",
  picture: "画面",
  scene: "场景",
  gen: "生图面板",
};

/* 右键落点下方还压着哪些块。DOM 命中永远只给最上面那块，
   被完全盖住的矩形只能从这一摞里挑。按层从高到低排。 */
export function blocksBelowPoint(item, x, y) {
  if (!current) return [];
  const point = clientToWorld(x, y);
  const baseZ = Number(item.z) || 0;
  const baseIndex = current.items.findIndex((entry) => entry.id === item.id);
  const out = [];
  current.items.forEach((other, index) => {
    if (other.id === item.id) return;
    if (other.type === "connector" || other.type === "line" || other.type === "arrow") return;
    const otherEl = itemEls.get(other.id);
    if (!otherEl) return;
    const b = itemBounds(other, otherEl);
    if (point.x < b.x || point.x > b.x + b.w || point.y < b.y || point.y > b.y + b.h) return;
    const z = Number(other.z) || 0;
    /* z 相撞时按创建顺序判上下：后建的压在先建的上面，和 DOM 的叠法一致 */
    if (z > baseZ || (z === baseZ && index > baseIndex)) return;
    out.push({ item: other, index });
  });
  out.sort((a, b) => (Number(b.item.z) || 0) - (Number(a.item.z) || 0) || b.index - a.index);
  return out.map((entry) => entry.item);
}

export function selectBelowEntry(item, x, y, depth = 0) {
  /* 只在最外层给这一项：嵌进某一层的菜单后再套一层会一路排到屏幕外，
     要再往下钻就收起菜单、在新选中的块上重新右键 */
  if (depth > 0) return null;
  const below = blocksBelowPoint(item, x, y);
  if (!below.length) return null;
  return {
    label: "选择下层",
    children: below.map((other) => ({
      label: `${STACK_LABELS[other.type] || other.type}${other.seq ? ` #${other.seq}` : ""}`,
      /* 悬停往右展开这一层的完整菜单（只是看）；点这一行才算选中，菜单收起 */
      onClick: () => select(other.id),
      children: withSelect(itemMenuEntries(other, x, y, depth + 1), other),
    })),
  };
}

/* 悬停只在看，选中得等真的动了里面的设置：
   给每个能落地的动作包一层，先选中这块再执行原来的动作。
   颜色/滑杆只包 onChange——只悬停看一眼色板、没动，不算选中。 */
export function withSelect(entries, target) {
  return entries.map((entry) => {
    if (entry === "-") return entry;
    if (entry.children) {
      const copy = { ...entry, children: withSelect(entry.children, target) };
      if (copy.onClick) {
        const run = copy.onClick;
        copy.onClick = () => {
          select(target.id);
          run();
        };
      }
      return copy;
    }
    if (entry.colorPicker) {
      const cfg = entry.colorPicker;
      return {
        ...entry,
        colorPicker: {
          ...cfg,
          onChange: (value) => {
            select(target.id);
            cfg.onChange?.(value);
          },
        },
      };
    }
    if (entry.slider) {
      const cfg = entry.slider;
      return {
        ...entry,
        slider: {
          ...cfg,
          onChange: (value) => {
            select(target.id);
            cfg.onChange?.(value);
          },
        },
      };
    }
    if (entry.onClick) {
      const run = entry.onClick;
      return {
        ...entry,
        onClick: () => {
          select(target.id);
          run();
        },
      };
    }
    return entry;
  });
}

export function openItemMenu(item, x, y) {
  openMenu(x, y, itemMenuEntries(item, x, y));
}

/* 图片块和有图的生图面板：另存一份到用户自己的目录，只复制、不挪动画布里那份 */
export async function saveImageAs(item) {
  if (!current || !item.src) {
    showToast("这块还没有图");
    return;
  }
  const canvasId = current.meta.id;
  try {
    const target = await store.saveCanvasImageAs(canvasId, item.id);
    if (!target) return;
    if (!current || current.meta.id !== canvasId) return;
    showToast(`已另存到 ${target}`);
  } catch (error) {
    showError(error);
  }
}

export function imageSaveAsEntry(item) {
  if (!((item.type === "image" || item.type === "gen") && item.src)) return null;
  return { label: "另存为…", onClick: () => void saveImageAs(item) };
}

/* 选中里恰好有两张能看的图（图片块或有图的生图面板）时，菜单才出现「对比」：
   临时叠图看差异，不落画布。选中里顺带带了文字块/连线也不影响。 */
export function compareImagesEntry(item) {
  const images = [...selectedIds]
    .map((id) => findItem(id))
    .filter((block) => block && (block.type === "image" || block.type === "gen") && block.src);
  if (images.length !== 2) return null;
  if (!images.includes(item)) return null;
  return { label: "对比", onClick: () => void openCompareFor(images) };
}

export async function openCompareFor(pair) {
  if (!current) return;
  const canvasId = current.meta.id;
  try {
    const urls = await Promise.all(
      pair.map(async (block) => {
        const cached = imageCache.get(block.src);
        if (cached) return cached;
        const url = await store
          .imageUrl(canvasId, block.src, Boolean(block.linked))
          .catch(() => "");
        if (url) imageCache.set(block.src, url);
        return url;
      }),
    );
    if (!current || current.meta.id !== canvasId) return;
    if (urls.some((url) => !url)) throw new Error("图片读不出来，可能文件已经不在画布里了");
    openImageCompare({ a: urls[0], b: urls[1] });
  } catch (error) {
    showError(error);
  }
}

/* 容器的「锁定全部 / 全部解锁」：容器连同成员一起算，
   还有没锁的就全锁，全锁了就全解 */
function lockMembersEntry(item) {
  if (!isContainer(item)) return null;
  const members = [item, ...ownedMembers(item, new Set(), true)];
  if (members.length < 2) return null;
  const anyUnlocked = members.some((member) => !member.locked);
  return {
    label: anyUnlocked ? "锁定全部" : "全部解锁",
    onClick: () => setLockedMany(members.map((member) => member.id), anyUnlocked),
  };
}

/* 一块的右键菜单内容。单独拆出来是为了「选择下层」：
   鼠标停在某一层上时，直接把这一层的菜单当子菜单挂出去。 */
export function itemMenuEntries(item, x, y, depth = 0) {
  /* 锁住的块菜单只剩解锁、只读项和删除：锁只锁坐标，菜单里的改动先解开 */
  if (item.locked) {
    const entries = [];
    entries.push({ label: "解锁", onClick: () => setLocked(item, false) });
    const lockAll = lockMembersEntry(item);
    if (lockAll) entries.push(lockAll);
    const below = selectBelowEntry(item, x, y, depth);
    if (below) entries.push(below);
    if (item.type === "file" && item.text && !item.linked) {
      entries.push({ label: "修改文件名…", onClick: () => void renameFileBlock(item) });
    }
    if (isFileEditable(item) || item.type === "text" || item.type === "note") {
      const edit =
        item.type === "file" ? () => startFileEdit(item.id) : item.type === "text" ? () => startTextEdit(item.id) : () => startNoteEdit(item.id);
      entries.push({ label: "编辑", onClick: edit });
    }
    if (revealTarget(item)) {
      entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
    }
    const lockedSave = imageSaveAsEntry(item);
    if (lockedSave) entries.push(lockedSave);
    entries.push(...h3dEntries(item));
    /* 对比是只读查看，锁着也允许 */
    const compare = compareImagesEntry(item);
    if (compare) entries.push(compare);
    entries.push("-");
    entries.push({ label: "删除", danger: true, onClick: () => deleteItems([item.id]) });
    /* 属性能看清这块到底是什么，放最后一行收尾（系统右键也是这个习惯） */
    if (PROP_KIND[item.type]) entries.push({ label: "属性", onClick: () => openItemProps(item) });
    return entries;
  }
  const entries = [];
  const isShape = item.type === "rect" || item.type === "ellipse";
  if (isShape) {
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  }
  if (item.type === "rect") {
    entries.push({
      label: isContainer(item) ? "取消容器" : "编为容器",
      onClick: () => toggleContainer(item),
    });
    entries.push({ label: "落图", onClick: () => void dropRegionImage(item.id) });
  } else if (item.type === "line" || item.type === "arrow") {
    entries.push({ ...colorEntry(item, "borderColor"), label: "线条颜色" });
  } else if (item.type === "text") {
    entries.push({
      label: "文字",
      children: [colorEntry(item, "color"), { label: "字号", children: fontSizeMenuItems(item) }],
    });
    entries.push({
      label: "对齐",
      children: [
        {
          label: "水平",
          children: TEXT_ALIGN_H.map(([value, label]) => ({
            label: `${label}${item.align === value ? " ✓" : ""}`,
            onClick: () => setTextAlign(item, "align", value),
          })),
        },
        {
          label: "垂直",
          children: TEXT_ALIGN_V.map(([value, label]) => ({
            label: `${label}${item.vAlign === value ? " ✓" : ""}`,
            onClick: () => setTextAlign(item, "vAlign", value),
          })),
        },
      ],
    });
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
  } else if (item.type === "connector") {
    entries.push({ ...colorEntry(item, "color"), label: "线条颜色" });
    entries.push({
      label: "线型",
      children: CONNECTOR_SHAPES.map(([value, label]) => ({
        label: `${label}${item.shape === value ? " ✓" : ""}`,
        onClick: () => setConnectorProp(item, "shape", value),
      })),
    });
    entries.push({
      label: "箭头",
      children: CONNECTOR_ARROWS.map(([value, label]) => ({
        label: `${label}${item.arrow === value ? " ✓" : ""}`,
        onClick: () => setConnectorProp(item, "arrow", value),
      })),
    });
    entries.push({
      label: item.bend ? "关闭折点" : "打开折点",
      onClick: () => setConnectorBend(item, !item.bend),
    });
  } else if (item.type === "picture") {
    entries.push(...pictureMenuEntries(item));
    entries.push({ label: "落图", onClick: () => void exportPictureImage(item.id) });
  } else if (item.type === "image") {
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
  } else if (item.type === "video") {
    /* 播放器菜单：状态现问播放器，播放/全屏的文案跟着当前状态走 */
    const ctl = videoControlOf(itemEls.get(item.id));
    if (ctl) {
      let touched = false;
      entries.push({
        label: "播放器",
        children: [
          { label: ctl.isPlaying() ? "暂停" : "播放", onClick: () => ctl.togglePlay() },
          { label: ctl.isFullscreen() ? "恢复尺寸" : "最大化", onClick: () => ctl.toggleFullscreen() },
          {
            label: "声音",
            slider: {
              get value() {
                return ctl.getVolume();
              },
              onChange: (value) => {
                touched = true;
                ctl.setVolume(value);
              },
              onDone: () => {
                if (touched) scheduleItemsSave();
              },
            },
          },
        ],
      });
    }
  } else if (item.type === "note") {
    entries.push({ label: "编辑", onClick: () => startNoteEdit(item.id) });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "file") {
    if (isFileEditable(item)) {
      entries.push({ label: "编辑", onClick: () => startFileEdit(item.id) });
    }
    if (item.text && !item.linked) {
      entries.push({ label: "修改文件名…", onClick: () => void renameFileBlock(item) });
    }
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "product") {
    entries.push({ label: "更换图片…", onClick: () => void changeProductImage(item.id) });
    entries.push({ label: "设置 3D 模型…", onClick: () => void pickProductModel(item) });
    const scenes = current ? current.items.filter((one) => one.type === "scene") : [];
    entries.push({
      label: "放进 3D 场景",
      children: scenes.length
        ? scenes.map((scene) => ({
            label: `场景 #${scene.seq}`,
            onClick: () => void placeProductInSceneFlow(item, scene),
          }))
        : [{ label: "新建场景并放入", onClick: () => newSceneForProduct(item) }],
    });
    const plans = current ? current.items.filter((one) => one.type === "plan") : [];
    entries.push({
      label: "放到户型图",
      children: plans.length
        ? plans.map((plan) => ({
            label: `#${plan.seq} 户型图`,
            onClick: () => void placeProductOnPlanFlow(item, plan),
          }))
        : [{ label: "还没有户型图", disabled: true }],
    });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "quote") {
    entries.push({
      label: "导出清单",
      children: [
        { label: "Excel 表格（.xlsx）", onClick: () => void exportQuote(item, "xlsx").catch(showError) },
        { label: "CSV 表格（.csv）", onClick: () => void exportQuote(item, "csv").catch(showError) },
      ],
    });
    entries.push({ label: "从 CSV 导入产品…", onClick: () => void importCsvFromQuote(item) });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "plan") {
    entries.push({
      label: planCalibration?.itemId === item.id ? "取消定标" : "标定比例…",
      onClick: () => {
        if (planCalibration?.itemId === item.id) cancelPlanCalibration();
        else startPlanCalibration(item);
      },
    });
    if (item.calibration) {
      entries.push({
        label: "清除定标",
        onClick: () => {
          item.calibration = null;
          const el = itemEls.get(item.id);
          if (el) syncItemElement(el, item);
          scheduleItemsSave();
        },
      });
    }
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
    entries.push({
      label: "背景",
      children: [colorEntry(item, "fillColor")],
    });
  } else if (item.type === "page") {
    entries.push({ label: "重命名页…", onClick: () => renamePageFlow(item) });
    entries.push({
      label: "页面比例",
      children: Object.entries(PAGE_RATIOS).map(([value, preset]) => ({
        label: `${preset.label}${item.ratio === value ? " ✓" : ""}`,
        onClick: () => setPageRatio(item, value),
      })),
    });
    entries.push({ label: "设为第几页…", onClick: () => setPageOrderFlow(item) });
  } else if (item.type === "scene") {
    entries.push({
      label: scenePlacementActive(item) ? "退出编辑元素" : "编辑元素",
      onClick: () => setScenePlacementMode(item, !scenePlacementActive(item)),
    });
    entries.push({ label: "从模型库添加…", onClick: () => void addSceneModelFlow(item) });
    entries.push({ label: "新建模型…", onClick: () => void createFurnitureFlow(item) });
    entries.push({
      label: "导出为 GLB",
      onClick: () => void exportSceneFlow(item),
    });
    entries.push({
      label: "重置视角",
      onClick: () => {
        item.camera = null;
        const el = itemEls.get(item.id);
        if (el) syncItemElement(el, item);
        scheduleItemsSave();
      },
    });
    entries.push({
      label: "视角",
      children: [
        ["auto", "自动"],
        ["front", "正面"],
        ["left", "左角"],
        ["right", "右角"],
        ["top", "俯视"],
      ].map(([value, label]) => ({
        label,
        onClick: () => setSceneCameraPreset(item, value),
      })),
    });
    entries.push(borderMenuEntry(item, colorEntry(item, "borderColor")));
  }
  /* 连线不复制：它两头挂着块，粘出去无处可接。
     复制的语义：正文区有文字选区 → 复制纯文字；否则复制整块（面板） */
  if (item.type !== "connector") {
    const below = selectBelowEntry(item, x, y, depth);
    if (below) entries.push(below);
    /* 图片块和生图面板：选中里恰好有两张图时给一个「对比」 */
  const compare = compareImagesEntry(item);
  if (compare) entries.push(compare);
  entries.push({ label: "层级", children: layerMenuItems(item) });
    entries.push({
      label: "复制",
      onClick: () => {
        const text = bodySelectionText(itemBodyEl(item));
        if (text) copyBodySelectionText(text);
        else copyItems([item.id]);
      },
    });
  }
  /* 画布不替用户开文件，只把他带到那份文件躺着的地方 */
  if (revealTarget(item)) {
    entries.push({ label: "在文件夹中显示", onClick: () => revealFileBlock(item) });
  }
  const saveAs = imageSaveAsEntry(item);
  if (saveAs) entries.push(saveAs);
  entries.push(...h3dEntries(item));
  if (entries.length) entries.push("-");
  /* 锁定贴着删除放，都在分隔线下面 */
  if (item.type !== "connector") {
    entries.push({ label: "锁定", onClick: () => setLocked(item, true) });
    const lockAll = lockMembersEntry(item);
    if (lockAll) entries.push(lockAll);
  }
  entries.push({ label: "删除", danger: true, onClick: () => deleteItems([item.id]) });
  /* 属性：笔记报类型，媒体和文件类报绝对路径。文字、图形、连线没有「属性」这一行。
     位置固定在最后一行，和系统右键一致，也不打断上面那串操作。 */
  if (PROP_KIND[item.type]) {
    entries.push({ label: "属性", onClick: () => openItemProps(item) });
  }
  return entries;
}

/* 属性卡：每块都能说清自己是什么、怎么用；落在磁盘上的那种再报绝对路径。
   路径整段可选中、长路径换行显示，不拿省略号把中间藏掉。 */
export const PROP_KIND = {
  text: { name: "文字", hint: "画布上的文字，双击就地编辑，可调字号、对齐与边框。" },
  rect: { name: "矩形", hint: "可设边框和底色的矩形，也能编成容器框住一组内容。" },
  ellipse: { name: "椭圆", hint: "可设边框和底色的椭圆。" },
  line: { name: "直线", hint: "按住 Shift 拖端点会吸到 45° 倍数。" },
  arrow: { name: "箭头", hint: "带箭头的线，按住 Shift 拖端点会吸到 45° 倍数。" },
  connector: { name: "连线", hint: "连接两块面板的线，可改线型、箭头和折点。" },
  note: { name: "笔记", hint: "Markdown 笔记卡，双击进入编辑。" },
  picture: { name: "画面（矢量）", hint: "矢量画面：绘制指令、素材和手绘笔画都在这块里。" },
  scene: { name: "场景（真 3D）", hint: "真 3D 场景：可摆家具、调光与机位，Ctrl 转、Shift 平移。" },
  gen: { name: "生图面板", hint: "提示词 + 开始，出图参数也可以由 agent 设置。" },
  product: { name: "产品卡", hint: "一件家具 / 材料：名称、价格、数量和真实尺寸。" },
  quote: { name: "清单", hint: "汇总画布内所有产品卡的金额，可导 CSV / XLSX。" },
  plan: { name: "户型图", hint: "两点定标后能量面积、摆家具脚印和 3D 机位。" },
  page: { name: "提案页", hint: "提案页框：按页导出客户版 PDF / 网页。" },
  image: { name: "图片", hint: "静态图片，可双击看大图。" },
  audio: { name: "音乐", hint: "音频面板，可播放和调音量。" },
  video: { name: "视频", hint: "视频面板，可播放和全屏。" },
  file: { name: "文件", hint: "文件面板，双击用系统默认程序打开。" },
  ebook: { name: "电子书", hint: "分章阅读的电子书面板。" },
};

/* 真正落在磁盘上的面板才报路径：文字、图形、卡片这些没有自己的文件 */
export const PROP_PATH_TYPES = new Set(["note", "image", "audio", "video", "file", "ebook"]);

export async function openItemProps(item) {
  if (!current || !PROP_KIND[item.type]) return;
  setModalOpen(true);
  await showPropsCard(item);
  setModalOpen(false);
}

export function showPropsCard(item) {
  const kind = PROP_KIND[item.type];
  const path = PROP_PATH_TYPES.has(item.type) ? absolutePathOf(item, current?.meta.path || "") : "";
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog dialog-props" role="dialog" aria-modal="true">
        <p class="dialog-title">属性</p>
        <button class="dialog-close" type="button" aria-label="关闭">${CLOSE_X_SVG}</button>
        <p class="dialog-message props-kind"></p>
        <p class="dialog-message props-seq"></p>
        <p class="dialog-message props-geometry"></p>
        <p class="dialog-message props-path" hidden></p>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    const kindEl = mask.querySelector(".props-kind");
    const seqEl = mask.querySelector(".props-seq");
    const geometryEl = mask.querySelector(".props-geometry");
    const pathEl = mask.querySelector(".props-path");
    const closeBtn = mask.querySelector(".dialog-close");
    /* 类型名和这句说明排在同一行：名字加粗，说明用小一号的灰字 */
    const nameSpan = document.createElement("span");
    nameSpan.textContent = kind?.name || item.type;
    kindEl.append(nameSpan);
    if (kind?.hint) {
      const hintSpan = document.createElement("span");
      hintSpan.className = "props-hint-inline";
      hintSpan.textContent = `　${kind.hint}`;
      kindEl.append(hintSpan);
    }
    if (Number.isFinite(item.seq) && item.seq > 0) {
      seqEl.textContent = `编号：#${item.seq}`;
    } else {
      seqEl.hidden = true;
    }
    /* 坐标和宽高：量画面上的实际尺寸，文字块这类高度由 DOM 定的块也准 */
    if (item.type === "connector") {
      geometryEl.hidden = true;
    } else {
      const el = itemEls.get(item.id);
      const b = el ? itemBounds(item, el) : { x: item.x, y: item.y, w: item.w, h: item.h };
      geometryEl.innerHTML =
        `坐标：(${Math.round(b.x)}, ${Math.round(b.y)})<br>` +
        `宽高：${Math.round(b.w)} × ${Math.round(b.h)}`;
    }
    if (path) {
      pathEl.textContent = path;
      pathEl.hidden = false;
    }
    const finish = () => {
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
        finish();
      }
    };
    closeBtn.addEventListener("click", finish);
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) finish();
    });
    document.body.append(mask);
    document.addEventListener("keydown", onKey, true);
    closeBtn.focus({ preventScroll: true });
  });
}

export function layerMenuItems(item) {
  return [
    { label: "上一层", onClick: () => moveLayer(item, 1) },
    { label: "下一层", onClick: () => moveLayer(item, -1) },
    { label: "最顶层", onClick: () => moveLayer(item, "top") },
    { label: "最底层", onClick: () => moveLayer(item, "bottom") },
  ];
}

/* 锁住就是这块先别动：位置、尺寸、正文、删除全挡住，只剩选中、右键和连线 */
export function setLocked(item, locked) {
  setLockedMany([item.id], locked);
}

export function setLockedMany(ids, locked) {
  for (const id of ids) {
    const item = findItem(id);
    if (!item || item.type === "connector") continue;
    item.locked = locked;
    const el = itemEls.get(item.id);
    if (el) syncItemElement(el, item);
    /* 画面块的锁还要收回十字光标：锁上的画不供笔 */
    if (item.type === "picture") refreshPictureChrome(item.id);
  }
  updateSelection();
  scheduleItemsSave();
}

export function moveLayer(item, dir) {
  if (!current) return;
  const blocks = current.items
    .filter((entry) => entry.type !== "connector")
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const index = blocks.indexOf(item);
  if (index < 0) return;
  const target =
    dir === "top"
      ? blocks.length - 1
      : dir === "bottom"
        ? 0
        : Math.min(blocks.length - 1, Math.max(0, index + dir));
  if (target === index) return;
  blocks.splice(index, 1);
  blocks.splice(target, 0, item);
  blocks.forEach((entry, position) => {
    entry.z = position;
    const el = itemEls.get(entry.id);
    if (el) el.style.zIndex = String(position);
  });
  scheduleItemsSave();
}

export function openBlankMenu(x, y) {
  /* 空白处右键和标题栏工具按钮弹同一个工具清单 */
  openMenu(x, y, toolMenuEntries());
}

export const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32, 48];
export const TEXT_ALIGN_H = [
  ["left", "左对齐"],
  ["center", "居中"],
  ["right", "右对齐"],
];
export const TEXT_ALIGN_V = [
  ["top", "顶端"],
  ["middle", "居中"],
  ["bottom", "底端"],
];

export function fontSizeMenuItems(item) {
  const current = item.fontSize || 14;
  const sizes = FONT_SIZES.includes(current)
    ? FONT_SIZES
    : [...FONT_SIZES, current].sort((a, b) => a - b);
  return sizes.map((size) => ({
    label: `${size}px${size === current ? " ✓" : ""}`,
    onClick: () => setFontSize(item, size),
  }));
}

export function setFontSize(item, size) {
  item.fontSize = size;
  const el = itemEls.get(item.id);
  if (el) {
    syncItemElement(el, item);
    item.h = el.offsetHeight;
  }
  updateSelection();
  scheduleItemsSave();
}

export function setTextAlign(item, prop, value) {
  if (item[prop] === value) return;
  item[prop] = value;
  const el = itemEls.get(item.id);
  if (el) {
    syncItemElement(el, item);
    item.h = el.offsetHeight;
  }
  updateSelection();
  scheduleItemsSave();
}

/* 圆角按像素填，0 就是直角；CSS 会把超过半边的值自己收住，不用另外夹 */
export async function openRadiusDialog(item) {
  const value = await promptDialog({
    title: "圆角",
    label: "圆角半径（px，0 为直角）",
    value: String(Number.isFinite(item.radius) ? item.radius : 0),
    okText: "设置",
    validate: (text) => (/^\d{1,4}$/.test(text) ? null : "填 0 到 9999 的整数"),
  });
  if (value === null) return;
  item.radius = Number(value);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
}

/* 边框宽度按像素填，0 就是不要边框 */
export async function openBorderWidthDialog(item) {
  const value = await promptDialog({
    title: "边框宽度",
    label: "边框宽度（px，0 为无边框）",
    value: String(Number.isFinite(item.borderWidth) ? item.borderWidth : BORDER_DEFAULT_WIDTH),
    okText: "设置",
    validate: (text) =>
      /^\d{1,2}$/.test(text) && Number(text) <= BORDER_MAX_WIDTH
        ? null
        : `填 0 到 ${BORDER_MAX_WIDTH} 的整数`,
  });
  if (value === null) return;
  item.borderWidth = Number(value);
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
  scheduleItemsSave();
}

export const CONNECTOR_SHAPES = [
  ["elbow", "折线"],
  ["curve", "曲线"],
];

export const CONNECTOR_ARROWS = [
  ["none", "无"],
  ["end", "单向"],
  ["both", "双向"],
];

export function setConnectorProp(item, prop, value) {
  item[prop] = value;
  syncConnector(item);
  updateSelection();
  scheduleItemsSave();
}

export function applyColor(item, prop, color) {
  item[prop] = color;
  /* 文字块的边框随颜色开关：选了颜色才显示边框，选「透明」就去掉 */
  if (item.type === "text" && prop === "borderColor") {
    item.bordered = Boolean(color);
  }
  if (item.type === "connector") {
    syncConnector(item);
    return;
  }
  const el = itemEls.get(item.id);
  if (el) syncItemElement(el, item);
}

export function deleteItems(ids) {
  if (!current || !ids.length) return;
  /* 锁定只锁坐标，不拦删除：锁着的块照样能删 */
  const doomed = new Set(ids.filter((id) => Boolean(findItem(id))));
  if (!doomed.size) return;
  /* 删容器连带框里的块：容器是一组东西的框，框没了，里面的面板也不该留着。
     锁定的子块同样带走——锁不是删除的保护伞。 */
  for (const id of [...doomed]) {
    const container = findItem(id);
    if (!container || !isContainer(container)) continue;
    for (const kid of ownedMembers(container, doomed, true)) doomed.add(kid.id);
  }
  /* 删块时，挂在它身上的连线一起删，不留悬空线 */
  for (const item of current.items) {
    if (item.type === "connector" && (doomed.has(item.from.item) || doomed.has(item.to.item))) {
      doomed.add(item.id);
    }
  }
  for (const removeId of doomed) {
    const index = current.items.findIndex((item) => item.id === removeId);
    if (index < 0) continue;
    const [item] = current.items.splice(index, 1);
    if (editingId === removeId) setEditingId(null);
    const el = itemEls.get(removeId);
    el?.querySelector("audio")?.pause();
    el?.querySelector("video")?.pause();
    removeItemFromDom(removeId);
    /* 块一删，画布里那份副本当场进回收站（引入的原图是用户自己的，不碰）。
       别的块还指着同一个文件就先留着，等最后一块也删了再收。 */
    const canvasId = current.meta.id;
    const usedBy = (type, src) =>
      current.items.some((other) => other.type === type && other.src === src);
    if (item.type === "image" && item.src && !item.linked) {
      const { src } = item;
      if (!srcInUse(src)) void store.deleteCanvasImage(canvasId, src, false).catch(() => {});
    }
    /* 产品卡的产品图也是拷贝进画布的那份，跟着块一起回收 */
    if (item.type === "product" && item.src && !srcInUse(item.src)) {
      void store.deleteCanvasImage(canvasId, item.src, false).catch(() => {});
      imageCache.delete(item.src);
    }
    /* 户型图同理 */
    if (item.type === "plan" && item.src && !srcInUse(item.src)) {
      void store.deleteCanvasImage(canvasId, item.src, false).catch(() => {});
      imageCache.delete(item.src);
    }
    if (planCalibration?.itemId === item.id) cancelPlanCalibration();
    if (item.type === "audio" && item.src && !item.linked) {
      const { src } = item;
      if (!usedBy("audio", src)) void store.deleteCanvasAudio(canvasId, src, false).catch(() => {});
    }
    if (item.type === "video" && item.src && !item.linked) {
      const { src, audioRel } = item;
      if (!usedBy("video", src)) void store.deleteCanvasVideo(canvasId, src, false, audioRel).catch(() => {});
    }
    if (item.type === "picture") {
      clearTimeout(pictureTimers.get(item.id));
      pictureTimers.delete(item.id);
      /* 块没了，那一套笔和笔画栈也跟着清空：块 id 不会复用，留着只是漏 */
      pictureEditors.delete(item.id);
      void store.deletePicture(canvasId, item.id).catch(() => {});
      /* 垫的位图：拷贝进画布的那份跟着块一起回收（引入的原图是用户自己的，不碰） */
      for (const one of collectPictureImageSrcs(item.cmds, item.symbols)) {
        if (one.linked || !one.src) continue;
        if (/^[a-zA-Z]:[\\/]/.test(one.src) || one.src.startsWith("/")) continue;
        if (!srcInUse(one.src)) void store.deleteCanvasImage(canvasId, one.src, false).catch(() => {});
      }
    }
    if (item.type === "scene") {
      clearTimeout(sceneTimers.get(item.id));
      sceneTimers.delete(item.id);
      void store.deleteScene(canvasId, item.id).catch(() => {});
    }
    if (item.type === "gen") {
      clearTimeout(genTimers.get(item.id));
      genTimers.delete(item.id);
      /* 这一轮的运行态（第几步、预览图）跟着块走：不留，否则「一次一张」会被一块已经不存在的图卡住 */
      dropGenRun(item.id);
      /* 正在跑的任务也停掉：块都没了，结果回来只会被丢掉，API 调用别白花钱 */
      void store.genCancel(item.id).catch(() => {});
      void store.deleteGen(canvasId, item.id).catch(() => {});
      /* 出的那张图没人指着才回收：落块落出去的那张图片块还用它 */
      if (item.src && !srcInUse(item.src)) {
        void store.deleteCanvasImage(canvasId, item.src, false).catch(() => {});
      }
    }
    if (item.type === "genvideo") {
      dropVideoRun(item.id);
      void store.genVideoCancel(item.id).catch(() => {});
    }
    if (item.type === "note") {
      const prefix = `notes/${item.id}/`;
      for (const key of [...noteImageCache.keys()]) {
        if (key.startsWith(prefix)) noteImageCache.delete(key);
      }
      if (noteEditor?.itemId === item.id) setNoteEditor(null);
      clearTimeout(noteTimers.get(item.id));
      noteTimers.delete(item.id);
      /* 引用块的原文件不归这里管，删的是画布自己那份 .md */
      if (!item.linked) void store.deleteNote(canvasId, item.id).catch(() => {});
    }
    /* 拷贝块的副本跟着块一起进回收站；引用块只断链接，原文件在用户手里不动 */
    if (item.type === "file" && item.src) {
      if (fileEditor?.itemId === item.id) flushFileEditor();
      filePreviewCache.delete(previewKey(item));
      /* Markdown 正文里贴过的图落在这块自己的 notes/<块id>/，跟着块一起清 */
      const assetPrefix = `notes/${item.id}/`;
      for (const key of [...noteImageCache.keys()]) {
        if (key.startsWith(assetPrefix)) noteImageCache.delete(key);
      }
      void store.deleteNote(canvasId, item.id).catch(() => {});
      if (!item.linked && !usedBy("file", item.src)) {
        void store.deleteCanvasFile(canvasId, item.src, false).catch(() => {});
      }
    }
    if (item.type === "ebook" && item.src) {
      ebookTocCache.delete(ebookKey(current.meta.id, item));
      if (!item.linked && !usedBy("ebook", item.src)) {
        void store.deleteCanvasFile(canvasId, item.src, false).catch(() => {});
      }
    }
  }
  for (const removeId of doomed) selectedIds.delete(removeId);
  updateSelection();
  refreshQuotes();
  scheduleItemsSave();
}

export function removeItemFromDom(id) {
  const el = itemEls.get(id);
  if (el) el.remove();
  itemEls.delete(id);
}

/* 文本文件块改名：只改复制进画布的那份（files/ 下），扩展名保持不变。
   引用态没有这一项——改的就是用户磁盘上的原文件了。 */
async function renameFileBlock(item) {
  if (!current || item.linked) return;
  const { invoke } = window.__TAURI__?.core || {};
  if (typeof invoke !== "function") return;
  const ext = String(item.ext || "").toLowerCase();
  const oldName = String(item.name || "");
  const base =
    ext && oldName.toLowerCase().endsWith(`.${ext}`) ? oldName.slice(0, -(ext.length + 1)) : oldName;
  const next = await promptDialog({
    title: "修改文件名",
    label: ext ? `扩展名 .${ext} 保持不变` : "",
    value: base,
    okText: "改名",
  });
  if (!next || next === base) return;
  try {
    const res = await invoke("canvas_rename_file", {
      id: current.meta.id,
      itemId: item.id,
      name: next,
    });
    const same = findItem(item.id);
    if (!same) return;
    same.name = res.name;
    same.src = res.src;
    scheduleItemsSave();
    refreshFileBlock(same);
  } catch (error) {
    showError(error);
  }
}
