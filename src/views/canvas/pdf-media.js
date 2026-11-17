/* 从 canvas.js 拆出：PDF / 电子书 / 媒体块的 agent 接口 */

import { agentHighlight, agentRequireItem, agentSummary, clamp, current, itemEls, numOr } from "../canvas.js";
import * as store from "../canvas-store.js";

/* ---------- PDF / 电子书 / 媒体 ---------- */

export function agentPdfController(item) {
  return itemEls.get(item.id)?.querySelector(".canvas-file-pdf")?.__agent || null;
}

export function agentPdfOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "file" || String(item.ext || "").toLowerCase() !== "pdf") {
    throw new Error("这不是 PDF 块");
  }
  return item;
}

export function agentPdfState(id) {
  const item = agentPdfOf(id);
  const ctl = agentPdfController(item);
  const fallback = {
    ready: false,
    total: 0,
    page: Math.trunc(item.page) || 1,
    frac: item.pageFrac || 0,
  };
  const state = ctl ? ctl.state : fallback;
  return { ...agentSummary(item), ...state };
}

export function agentPdfGoto(id, page) {
  const item = agentPdfOf(id);
  const ctl = agentPdfController(item);
  if (!ctl) throw new Error("PDF 还没读进来，稍后再试");
  const state = ctl.goto(page);
  agentHighlight([item.id]);
  return { ...agentSummary(item), ...state };
}

export function agentEbookController(item) {
  return itemEls.get(item.id)?.querySelector(".canvas-ebook-card")?.__agent || null;
}

export function agentEbookOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "ebook") throw new Error("这不是电子书块");
  return item;
}

export async function agentEbookToc(id) {
  const item = agentEbookOf(id);
  const ctl = agentEbookController(item);
  if (ctl?.state?.ready) {
    agentHighlight([item.id]);
    return { ...agentSummary(item), ...ctl.state };
  }
  const canvasId = current.meta.id;
  const info = await store.ebookToc(canvasId, item.src, item.linked);
  if (!current || current.meta.id !== canvasId) throw new Error("读目录时画布被切走了");
  agentHighlight([item.id]);
  const chapters = Array.isArray(info?.chapters) ? info.chapters : [];
  return {
    ...agentSummary(item),
    ready: true,
    title: info?.title || item.name,
    total: chapters.length,
    chapter: Math.min(item.chapter || 0, Math.max(0, chapters.length - 1)),
    chapters,
  };
}

export async function agentEbookGoto(id, chapter) {
  const item = agentEbookOf(id);
  const ctl = agentEbookController(item);
  if (!ctl) throw new Error("这本书还没读进来，稍后再试");
  const state = await ctl.goto(chapter);
  agentHighlight([item.id]);
  return { ...agentSummary(item), ...state };
}

export function agentMediaElement(item) {
  return itemEls.get(item.id)?.querySelector("audio.canvas-audio-element, video.canvas-video-element") || null;
}

export function agentMediaOf(id) {
  const item = agentRequireItem(id);
  if (item.type !== "audio" && item.type !== "video") throw new Error("这不是音频或视频块");
  return item;
}

export function agentMediaState(id) {
  const item = agentMediaOf(id);
  const media = agentMediaElement(item);
  return {
    ...agentSummary(item),
    ready: Boolean(media),
    playing: media ? !media.paused && !media.ended : false,
    time: media ? Number(media.currentTime.toFixed(2)) : 0,
    duration: media && Number.isFinite(media.duration) ? Number(media.duration.toFixed(2)) : 0,
    volume: media ? Number(media.volume.toFixed(2)) : 1,
  };
}

export async function agentMediaControl(id, action, value) {
  const item = agentMediaOf(id);
  const media = agentMediaElement(item);
  if (!media) throw new Error("这块媒体还没准备好，稍后再试");
  const act = String(action || "");
  if (act === "play" || act === "toggle") {
    if (act === "play" || media.paused) {
      try {
        await media.play();
      } catch (error) {
        throw new Error(`播放失败：${error?.message || error}`);
      }
    } else {
      media.pause();
    }
  } else if (act === "pause") {
    media.pause();
  } else if (act === "seek") {
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    media.currentTime = clamp(numOr(value, 0), 0, Math.max(0, duration));
  } else if (act === "volume") {
    media.volume = clamp(numOr(value, 1), 0, 1);
  } else {
    throw new Error("action 只能是 play / pause / toggle / seek / volume");
  }
  agentHighlight([item.id]);
  return agentMediaState(item.id);
}
