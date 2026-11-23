/* 从 canvas.js 拆出：media-fallback */

import { addItemElement, audioCache, audioExtFor, audioFix, copyTask, current, fileToDataUrl, fitImageSize, formatSize, imageCache, imageSize, itemEls, makeAudio, makeImage, openVideoHelp, pastePoint, persistGen, persistNote, persistPicture, refreshQuotes, scheduleItemsSave, select, setAudioFix, setCopyTask, showError, stageCenterWorld, store, ui, updateSelection, videoCache } from "../canvas.js";
import { clampXToPage } from "./page-width.js";

/* ---------- 播不出来时的兜底 ---------- */

/* 探测结果按「画布 + src + 存在方式」留一份：同一块片子反复问 ffmpeg 没意义。 */
export const probeCache = new Map();

export async function probeVideoBlock(item) {
  if (!current) return null;
  const key = `${current.meta.id}|${item.linked}|${item.src}`;
  if (probeCache.has(key)) return probeCache.get(key);
  let probe = null;
  try {
    probe = await store.probeVideo(current.meta.id, item.src, item.linked);
  } catch {
    /* 探测只是给话术用的，问不出来照样让用户看教程 */
    probe = null;
  }
  probeCache.set(key, probe);
  return probe;
}

export async function openVideoProblem(item, reason) {
  if (!current) return;
  const probe = await probeVideoBlock(item);
  /* 别把"这片子本来就没声"当成故障吓用户 */
  if (reason === "audio" && probe?.ok && probe.audioTracks === 0) {
    showError("这条片子没有音轨，转不了。");
    return;
  }
  const action = await openVideoHelp({ reason, probe });
  if (action === "convert") fixVideoAudio(item);
}

/* 转音轨在后台线程跑，进度走 canvas-video-audio 事件，随时能停。
 * 转完只往块上挂一个相对路径，重建播放器就能对声。 */
export async function fixVideoAudio(item) {
  if (!current) return;
  if (copyTask || audioFix) {
    showError("正在忙上一个拷贝任务，等它跑完。");
    return;
  }
  const canvasId = current.meta.id;
  try {
    const job = await store.fixVideoAudio(canvasId, item.src, item.linked);
    setAudioFix({ job, canvasId, item });
    showFixProgress(item.name);
  } catch (error) {
    showError(error);
  }
}

export function onAudioFixProgress(payload) {
  if (!payload || !audioFix || payload.job !== audioFix.job) return;
  if (payload.phase === "progress") {
    paintFixProgress(payload.percent);
    return;
  }
  const job = audioFix;
  setAudioFix(null);
  hideCopyProgress();
  if (payload.phase === "done") {
    finishAudioFix(job.item, payload.rel);
    return;
  }
  if (payload.phase === "cancelled") {
    showError("已停止转换，写到一半的文件删掉了。");
    return;
  }
  showError(payload.error || "转换音轨失败");
}

export function finishAudioFix(item, rel) {
  if (!current || !rel || !itemEls.has(item.id)) return;
  item.audioRel = rel;
  videoCache.delete(rel);
  /* 换音轨得重建这块：画面要改吃静音，副本要挂上去，靠旧的 <video> 补不回来 */
  const old = itemEls.get(item.id);
  old?.remove();
  itemEls.delete(item.id);
  addItemElement(item);
  updateSelection();
  scheduleItemsSave();
  showError("音轨转好了，再点播放就有声音。");
}

/* 大文件拷进画布在后台线程跑，进度走 canvas-video-copy 事件，随时能停：
 * 停了后端把 .part 半截文件删掉，画布里不会留下看不懂的残骸。
 * 视频和文件共用这一根进度条，同一时刻只跑一个。 */
export function copyIntoCanvas(canvasId, info, kind) {
  if (copyTask) {
    showError(`正在拷贝上一个${copyTask.label}，等它拷完或者先停掉。`);
    return Promise.resolve(null);
  }
  const start = kind === "file" ? store.copyCanvasFile : store.copyCanvasVideo;
  const label = kind === "file" ? "文件" : "视频";
  return start(canvasId, info.path)
    .then(
      (job) =>
        new Promise((resolve) => {
          setCopyTask({ job, canvasId, resolve, label });
          showCopyProgress(info.name);
        }),
    )
    .catch((error) => {
      showError(error);
      return null;
    });
}

export function setupVideoCopyEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  Promise.resolve(
    listen("canvas-video-copy", (event) => onCopyProgress(event?.payload)),
  ).catch(() => {});
  Promise.resolve(
    listen("canvas-video-audio", (event) => onAudioFixProgress(event?.payload)),
  ).catch(() => {});
}

export function onCopyProgress(payload) {
  if (!payload || !copyTask || payload.job !== copyTask.job) return;
  const settle = (rel, message) => {
    const job = copyTask;
    setCopyTask(null);
    hideCopyProgress();
    if (message) showError(message);
    job.resolve(rel);
  };
  if (payload.phase === "done") {
    settle(payload.rel || null);
    return;
  }
  if (payload.phase === "cancelled") {
    settle(null, "已停止拷贝，写到一半的文件删掉了。");
    return;
  }
  if (payload.phase === "error") {
    settle(null, payload.error || `${copyTask.label}拷贝失败`);
    return;
  }
  paintCopyProgress(payload.copied, payload.total);
}

export function showCopyProgress(name) {
  ui.copyName.textContent = name;
  ui.copyFill.style.width = "0%";
  ui.copyText.textContent = "开始拷贝…";
  ui.copyCancel.disabled = false;
  ui.copyCancel.textContent = "停止";
  ui.copy.hidden = false;
}

export function paintCopyProgress(copied, total) {
  const fraction = total > 0 ? Math.min(1, copied / total) : 0;
  ui.copyFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  ui.copyText.textContent = `${formatSize(copied)} / ${formatSize(total)} · ${Math.round(
    fraction * 100,
  )}%`;
}

export function hideCopyProgress() {
  ui.copy.hidden = true;
}

/* 转音轨借用同一根进度条：ffmpeg 只报百分比，报不出字节数。 */
export function showFixProgress(name) {
  ui.copyName.textContent = `${name} · 转音轨`;
  ui.copyFill.style.width = "0%";
  ui.copyText.textContent = "开始转换…";
  ui.copyCancel.disabled = false;
  ui.copyCancel.textContent = "停止";
  ui.copy.hidden = false;
}

export function paintFixProgress(percent) {
  const fraction = Math.min(1, Math.max(0, Number(percent) || 0));
  ui.copyFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  ui.copyText.textContent = `${Math.round(fraction * 100)}%`;
}

/* 工具栏和「选文件」插进来的块都落在视野正中，连着插就叠成一坨，看着像没插进去。
   每插一个往右下错开一档；相机一动说明用户重新对准了视野，回到正中从头起算。
   拖入和粘贴不走这里——那是用户指着哪儿就要落哪儿。 */
export const INSERT_STEP = 24;
/* 一批文件铺开时，块与块之间、整排跟已有内容之间的空隙 */
export const BATCH_GAP = 24;
export let insertStep = 0;
export let insertCam = "";

export function insertPoint(w, h) {
  const center = stageCenterWorld();
  const cam = `${current.camera.x},${current.camera.y},${current.camera.scale}`;
  insertStep = cam === insertCam ? insertStep + 1 : 0;
  insertCam = cam;
  const d = insertStep * INSERT_STEP;
  return { x: center.x + d - w / 2, y: center.y + d - h / 2 };
}

export function placeBlock(item) {
  if (!current) return null;
  /* 固定宽度的画布：所有新块统一在这里夹进页面，别让任何一个创建入口漏出去 */
  clampXToPage(item);
  current.items.push(item);
  addItemElement(item);
  /* 新进来一张产品卡，清单当场重算：粘贴、复制、批量导入都走这里 */
  if (item.type === "product") refreshQuotes();
  select(item.id);
  scheduleItemsSave();
  /* 笔记/画面从建下来那一刻就有自己那份文件，内容以后只认文件 */
  if (item.type === "note") persistNote(item);
  if (item.type === "picture") persistPicture(item);
  if (item.type === "gen") persistGen(item);
  return item;
}

export async function pasteImage(file) {
  if (!current) return;
  try {
    const dataUrl = await fileToDataUrl(file);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    const base64 = dataUrl.slice(comma + 1);
    const subtype = (file.type.split("/")[1] || "png").toLowerCase();
    const ext = subtype === "svg+xml" ? "svg" : subtype.replace("jpeg", "jpg");
    const canvasId = current.meta.id;
    const rel = await store.saveCanvasImage(canvasId, base64, ext);
    if (!current || current.meta.id !== canvasId) return;
    const size = await imageSize(dataUrl);
    const fit = fitImageSize(size.width, size.height);
    const point = pastePoint();
    imageCache.set(rel, dataUrl);
    placeBlock(makeImage(point.x, point.y, fit.w, fit.h, rel));
  } catch (error) {
    showError(error);
  }
}

export async function pasteAudio(file) {
  if (!current) return;
  const ext = audioExtFor(file);
  if (!ext) {
    showError("不是支持的音频格式");
    return;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    const base64 = dataUrl.slice(comma + 1);
    const canvasId = current.meta.id;
    const rel = await store.saveCanvasAudio(canvasId, base64, ext);
    if (!current || current.meta.id !== canvasId) return;
    const point = pastePoint();
    audioCache.set(rel, dataUrl);
    placeBlock(makeAudio(point.x, point.y, file.name || "未命名音频", rel));
  } catch (error) {
    showError(error);
  }
}
