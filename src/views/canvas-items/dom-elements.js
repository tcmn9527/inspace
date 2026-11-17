/* canvas-items/dom-elements.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { createMissingCard } from "./dom-connectors.js";
import { createEbookCard, createFileCard } from "./dom-files.js";
import { createAudioPlayer, createVideoPlayer } from "./dom-media.js";
import { createLineSvg, syncItemElement } from "./dom-sync.js";
import { SVG_NS } from "./util.js";
import { renderMarkdown } from "../markdown.js";

export function createItemElement(item, mediaSrc, options = {}) {
  const el = document.createElement("div");
  el.className = `canvas-item canvas-item-${item.type}`;
  el.dataset.id = item.id;

  if (item.type === "text") {
    const body = document.createElement("div");
    body.className = "canvas-text-body";
    body.textContent = item.text;
    el.append(body);
  } else if (item.type === "image") {
    if (mediaSrc) {
      const img = document.createElement("img");
      img.className = "canvas-image";
      img.src = mediaSrc;
      img.draggable = false;
      img.alt = "";
      el.append(img);
    } else {
      el.append(createMissingCard(item, options.canvasDir));
    }
  } else if (item.type === "audio" || item.type === "video") {
    /* 音视频的数据是点开才取的，丢没丢只由这句 mediaMissing 说了算 */
    if (!item.src || options.mediaMissing) {
      el.append(createMissingCard(item, options.canvasDir));
    } else if (item.type === "audio") {
      el.append(createAudioPlayer(item, mediaSrc, options));
    } else {
      el.append(createVideoPlayer(item, mediaSrc, options));
    }
  } else if (item.type === "line" || item.type === "arrow") {
    el.append(createLineSvg(item));
  } else if (item.type === "note") {
    const card = document.createElement("div");
    card.className = "canvas-note-card";
    const body = document.createElement("div");
    body.className = "md-body canvas-note-body";
    body.innerHTML = renderMarkdown(item.source);
    card.append(body);
    el.append(card);
  } else if (item.type === "picture") {
    const card = document.createElement("div");
    card.className = "canvas-picture-card";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "canvas-picture-svg");
    card.append(svg);
    el.append(card);
  } else if (item.type === "scene") {
    /* 里面先只摆一句话：three.js 是点开才拉的，拉到之前这块就是「加载中」。
       canvas-scene-view 是渲染器挂 <canvas> 的宿主，卡片自身负责裁剪。 */
    const card = document.createElement("div");
    card.className = "canvas-scene-card";
    const view = document.createElement("div");
    view.className = "canvas-scene-view";
    const hint = document.createElement("p");
    hint.className = "canvas-scene-hint";
    hint.textContent = "场景加载中…";
    view.append(hint);
    card.append(view);
    el.append(card);
  } else if (item.type === "gen") {
    /* 上面是取景窗、下面是提示词和一颗开始。出图要几十秒，这一上半截就是给「等」留的。 */
    const card = document.createElement("div");
    card.className = "canvas-gen-card";
    const stage = document.createElement("div");
    stage.className = "canvas-gen-stage";
    const image = document.createElement("img");
    image.className = "canvas-gen-image";
    image.draggable = false;
    image.alt = "";
    const hint = document.createElement("p");
    hint.className = "canvas-gen-hint";
    /* 局部重绘的遮罩层：白色笔迹是「这里要重画」，叠在底图上 */
    const maskCanvas = document.createElement("canvas");
    maskCanvas.className = "canvas-gen-mask";
    maskCanvas.hidden = true;
    stage.append(image, maskCanvas, hint);
    const bar = document.createElement("div");
    bar.className = "canvas-gen-bar";
    /* 一行参数：只报档位纯文字，尺寸/步数/种子都由 agent 改块上的字段 */
    const controls = document.createElement("div");
    controls.className = "canvas-gen-controls";
    const modeLabel = document.createElement("span");
    modeLabel.className = "canvas-gen-mode-label";
    controls.append(modeLabel);
    /* 这一行只报「这张会怎么出」：接了几张输入图、走的哪一档。没接图就不占地方 */
    const feed = document.createElement("p");
    feed.className = "canvas-gen-feed";
    feed.hidden = true;
    const promptWrap = document.createElement("div");
    promptWrap.className = "canvas-gen-prompt-wrap";
    const prompt = document.createElement("textarea");
    prompt.className = "canvas-gen-prompt";
    prompt.placeholder = "写下你想看的东西";
    prompt.rows = 3;
    prompt.spellcheck = false;
    promptWrap.append(prompt);
    const more = document.createElement("div");
    more.className = "canvas-gen-more";
    more.hidden = true;
    {
      const row = (labelText, control, wide = false) => {
        const label = document.createElement("label");
        label.className = wide ? "canvas-gen-more-row is-wide" : "canvas-gen-more-row";
        const name = document.createElement("span");
        name.textContent = labelText;
        label.append(name, control);
        more.append(label);
      };
      const field = (tag, name, attrs = {}) => {
        const control = document.createElement(tag);
        control.className = "canvas-gen-more-input";
        control.dataset.genField = name;
        Object.assign(control, attrs);
        return control;
      };
      const select = (name, entries, wide = false) => {
        const control = document.createElement("select");
        control.className = "canvas-gen-more-input";
        control.dataset.genField = name;
        for (const [value, text] of entries) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          control.append(option);
        }
        row(name === "model" ? "模型" : "模式", control, wide);
      };
      select("model", [["qwen21", "Qwen-Image 2.1"], ["h3image", "MiniMax-H3-Image"]], true);
      const width = field("input", "imageW", { inputMode: "numeric", spellcheck: false });
      const height = field("input", "imageH", { inputMode: "numeric", spellcheck: false });
      const size = document.createElement("div");
      size.className = "canvas-gen-more-size";
      const times = document.createElement("span");
      times.textContent = "×";
      const sizePreset = document.createElement("button");
      sizePreset.type = "button";
      sizePreset.className = "canvas-gen-more-size-preset";
      sizePreset.textContent = "常用";
      sizePreset.title = "选一个常用尺寸（手机壁纸、电脑壁纸等），也可以直接改左右两个数";
      size.append(width, times, height, sizePreset);
      row("尺寸", size, true);
      row("步数", field("input", "steps", { inputMode: "numeric" }));
      row("CFG", field("input", "cfg", { inputMode: "decimal" }));
      const seedInput = field("input", "seed", { inputMode: "numeric" });
      seedInput.title = "-1=随机，固定种子=复原提示词和参数都相同时的图";
      row("种子", seedInput);
      const seedTip = document.createElement("p");
      seedTip.className = "canvas-gen-more-tip";
      seedTip.textContent = "-1=随机，固定种子=复原提示词和参数都相同时的图";
      more.append(seedTip);
      row("改动幅度", field("input", "strength", { inputMode: "decimal" }));
      const negative = field("textarea", "negative", { rows: 2, spellcheck: false });
      negative.placeholder = "不想要的东西（可选）";
      row("负向", negative, true);
      /* 走 API 时这些本地参数没有对应字段：整行撤掉，只留尺寸。
         在哪些行上生效由 paintGenMore 决定，这里先打上标记。 */
      for (const name of ["model", "steps", "cfg", "seed", "strength", "negative"]) {
        more
          .querySelector(`[data-gen-field="${name}"]`)
          ?.closest(".canvas-gen-more-row")
          ?.classList.add("is-local-only");
      }
      seedTip.classList.add("is-local-only");
      const apiNote = document.createElement("p");
      apiNote.className = "canvas-gen-more-api";
      apiNote.hidden = true;
      more.insertBefore(apiNote, more.firstChild);
    }
    const actions = document.createElement("div");
    actions.className = "canvas-gen-actions";
    const brush = document.createElement("button");
    brush.type = "button";
    brush.className = "canvas-gen-brush";
    brush.textContent = "涂抹";
    brush.title = "开启后在预览上涂要重绘的地方；再点一下就能拖动面板";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "canvas-gen-clear";
    clear.textContent = "清除";
    clear.title = "把涂过的遮罩清空，重新涂";
    const refine = document.createElement("button");
    refine.type = "button";
    refine.className = "canvas-gen-refine";
    refine.textContent = "补细节";
    refine.title = "放大后再按提示词低强度重绘一遍，把纹理长回来";
    const moreToggle = document.createElement("button");
    moreToggle.type = "button";
    moreToggle.className = "canvas-gen-more-toggle";
    moreToggle.textContent = "更多设置";
    moreToggle.title = "展开尺寸、步数、CFG、种子、模式等参数";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "canvas-gen-more-reset";
    reset.textContent = "恢复默认";
    reset.title = "把这套参数恢复成该模型的出厂值";
    /* 只在展开更多设置时出现：收起状态这颗按钮没有意义 */
    reset.hidden = true;
    const run = document.createElement("button");
    run.type = "button";
    run.className = "canvas-gen-run";
    const place = document.createElement("button");
    place.type = "button";
    place.className = "canvas-gen-place";
    place.textContent = "落块";
    /* 左侧一组参数按钮、右侧开始/落块，中间用弹性空位隔开 */
    const spacer = document.createElement("span");
    spacer.className = "canvas-gen-spacer";
    actions.append(brush, clear, refine, moreToggle, reset, spacer, run, place);
    bar.append(controls, feed, promptWrap, more, actions);
    card.append(stage, bar);
    el.append(card);
  } else if (item.type === "genvideo") {
    /* 视频面板：上半截是播放器/等待区，下半截提示词 + 时长画幅 + 开始/落块。
       版式借用生图面板那套类，视觉上是一家人；产物不落在这块上：
       出片留在缓存里直接播，点「落块」才拷一份成视频块。 */
    const card = document.createElement("div");
    card.className = "canvas-gen-card canvas-genvideo-card";
    const stage = document.createElement("div");
    stage.className = "canvas-gen-stage canvas-genvideo-stage";
    const video = document.createElement("video");
    video.className = "canvas-genvideo-video";
    video.controls = true;
    video.playsInline = true;
    video.hidden = true;
    const hint = document.createElement("p");
    hint.className = "canvas-gen-hint canvas-genvideo-hint";
    stage.append(video, hint);
    const bar = document.createElement("div");
    bar.className = "canvas-gen-bar canvas-genvideo-bar";
    const feed = document.createElement("p");
    feed.className = "canvas-gen-feed canvas-genvideo-feed";
    const prompt = document.createElement("textarea");
    prompt.className = "canvas-gen-prompt canvas-genvideo-prompt";
    prompt.placeholder = "写下这段视频要什么：画面、动作、镜头";
    prompt.rows = 3;
    prompt.spellcheck = false;
    const controls = document.createElement("div");
    controls.className = "canvas-gen-controls canvas-genvideo-controls";
    const input = (fieldName, extra = "") => {
      const control = document.createElement("input");
      control.className = `canvas-gen-more-input canvas-genvideo-input${extra}`;
      control.dataset.videoField = fieldName;
      control.inputMode = "numeric";
      control.spellcheck = false;
      return control;
    };
    const preset = (kind, title) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "canvas-gen-more-size-preset canvas-genvideo-preset";
      button.dataset.videoPreset = kind;
      button.textContent = "常用";
      button.title = title;
      return button;
    };
    const secondsRow = document.createElement("div");
    secondsRow.className = "canvas-genvideo-row";
    const secondsLabel = document.createElement("span");
    secondsLabel.className = "canvas-genvideo-label";
    secondsLabel.textContent = "时长";
    /* 「秒」是输入框里的后缀：放外面会把这一行撑得比尺寸行短，两个常用按钮就对不齐 */
    const secondsWrap = document.createElement("div");
    secondsWrap.className = "canvas-genvideo-seconds";
    const seconds = input("seconds");
    const secondsUnit = document.createElement("span");
    secondsUnit.className = "canvas-genvideo-unit-inside";
    secondsUnit.textContent = "秒";
    secondsWrap.append(seconds, secondsUnit);
    secondsRow.append(secondsLabel, secondsWrap, preset("seconds", "挑一个常用时长，也可以直接改左边的数"));
    const sizeRow = document.createElement("div");
    sizeRow.className = "canvas-genvideo-row";
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "canvas-genvideo-label";
    sizeLabel.textContent = "尺寸";
    const width = input("width");
    const times = document.createElement("span");
    times.className = "canvas-genvideo-unit";
    times.textContent = "×";
    const height = input("height");
    sizeRow.append(sizeLabel, width, times, height, preset("size", "挑一个常用尺寸（720p、1080p），也可以直接改像素"));
    controls.append(secondsRow, sizeRow);
    const actions = document.createElement("div");
    actions.className = "canvas-gen-actions canvas-genvideo-actions";
    const spacer = document.createElement("span");
    spacer.className = "canvas-gen-spacer";
    const run = document.createElement("button");
    run.type = "button";
    run.className = "canvas-gen-run canvas-genvideo-run";
    const place = document.createElement("button");
    place.type = "button";
    place.className = "canvas-gen-place canvas-genvideo-place";
    place.textContent = "落块";
    place.hidden = true;
    actions.append(spacer, run, place);
    bar.append(feed, prompt, controls, actions);
    card.append(stage, bar);
    el.append(card);
  } else if (item.type === "file") {
    el.append(createFileCard(item, options));
  } else if (item.type === "ebook") {
    el.append(createEbookCard(item, options));
  } else if (item.type === "product") {
    const card = document.createElement("div");
    card.className = "canvas-product-card";
    const media = document.createElement("div");
    media.className = "canvas-product-media";
    if (mediaSrc) {
      const img = document.createElement("img");
      img.className = "canvas-product-img";
      img.src = mediaSrc;
      img.draggable = false;
      img.alt = "";
      media.append(img);
    } else {
      const hint = document.createElement("span");
      hint.className = "canvas-product-noimg";
      hint.textContent = "无图";
      media.append(hint);
    }
    const info = document.createElement("div");
    info.className = "canvas-product-info";
    const name = document.createElement("p");
    name.className = "canvas-product-name";
    name.dataset.field = "name";
    const meta = document.createElement("p");
    meta.className = "canvas-product-meta";
    const brand = document.createElement("span");
    brand.dataset.field = "brand";
    const dot = document.createElement("span");
    dot.className = "canvas-product-dot";
    dot.textContent = "·";
    const sku = document.createElement("span");
    sku.dataset.field = "sku";
    meta.append(brand, dot, sku);
    const spec = document.createElement("p");
    spec.className = "canvas-product-spec";
    spec.dataset.field = "spec";
    const foot = document.createElement("div");
    foot.className = "canvas-product-foot";
    const price = document.createElement("span");
    price.className = "canvas-product-price";
    price.dataset.field = "price";
    const qty = document.createElement("span");
    qty.className = "canvas-product-qty";
    qty.dataset.field = "qty";
    foot.append(price, qty);
    info.append(name, meta, spec, foot);
    card.append(media, info);
    el.append(card);
  } else if (item.type === "quote") {
    const card = document.createElement("div");
    card.className = "canvas-quote-card";
    const head = document.createElement("div");
    head.className = "canvas-quote-head";
    const title = document.createElement("span");
    title.className = "canvas-quote-title";
    title.dataset.field = "title";
    const count = document.createElement("span");
    count.className = "canvas-quote-count";
    head.append(title, count);
    const table = document.createElement("div");
    table.className = "canvas-quote-table";
    const headRow = document.createElement("div");
    headRow.className = "canvas-quote-row is-head";
    for (const label of ["名称", "规格", "单价", "数量", "小计"]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      headRow.append(cell);
    }
    const rows = document.createElement("div");
    rows.className = "canvas-quote-rows";
    table.append(headRow, rows);
    const total = document.createElement("div");
    total.className = "canvas-quote-total";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "合计";
    const totalValue = document.createElement("b");
    totalValue.className = "canvas-quote-total-value";
    total.append(totalLabel, totalValue);
    card.append(head, table, total);
    el.append(card);
  } else if (item.type === "plan") {
    const card = document.createElement("div");
    card.className = "canvas-plan-card";
    if (mediaSrc) {
      const img = document.createElement("img");
      img.className = "canvas-plan-img";
      img.src = mediaSrc;
      img.draggable = false;
      img.alt = "";
      card.append(img);
    } else {
      const hint = document.createElement("span");
      hint.className = "canvas-plan-noimg";
      hint.textContent = "户型图没找到";
      card.append(hint);
    }
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "canvas-plan-svg");
    svg.setAttribute("preserveAspectRatio", "none");
    card.append(svg);
    const badge = document.createElement("span");
    badge.className = "canvas-plan-badge";
    card.append(badge);
    el.append(card);
  } else if (item.type === "page") {
    const card = document.createElement("div");
    card.className = "canvas-page-card";
    const label = document.createElement("span");
    label.className = "canvas-page-label";
    card.append(label);
    el.append(card);
  }

  if (item.type !== "connector") {
    const lockDot = document.createElement("span");
    lockDot.className = "canvas-lock-dot";
    lockDot.title = "双击解除锁定";
    lockDot.setAttribute("aria-label", "双击解除锁定");
    el.append(lockDot);
  }

  syncItemElement(el, item);
  return el;
}

export function chevronSvg(d, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export const FILE_DOC_SVG = `
  <svg class="canvas-file-icon" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5.2 3.2h6l3.6 3.6v9.4h-9.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M11.2 3.2v3.6h3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
  </svg>`;

/* 文本预览一次最多渲染这么多字：后端读的是 512KB 开头，全塞进 DOM 会拖慢画布 */
export const PREVIEW_RENDER_CHARS = 20000;
export const TABLE_EXTS = new Set(["csv", "tsv"]);
export const TABLE_MAX_ROWS = 200;
export const TABLE_MAX_COLS = 24;

/* 附件卡片：文件已经拷进画布的 files/ 了，这里负责把名字/体积说清楚，
   文本类的再附一段只读预览。要打开文件走右键菜单的「在文件夹中显示」。 */
