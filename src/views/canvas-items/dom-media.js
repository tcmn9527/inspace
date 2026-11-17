/* canvas-items/dom-media.js —— 从 canvas-items.js 拆出（导出名不变，入口统一 re-export）。 */

import { missingLabel } from "./dom-connectors.js";
import { TABLE_MAX_COLS, TABLE_MAX_ROWS } from "./dom-elements.js";
import { fitVideoSize, syncItemElement } from "./dom-sync.js";

export function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (quoted) return null;
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export function createDelimitedTable(text, delim) {
  const rows = parseDelimited(text, delim);
  if (!rows || rows.length < 2) return null;
  const widest = Math.max(...rows.slice(0, 20).map((row) => row.length));
  if (widest < 2) return null;
  const cols = Math.min(widest, TABLE_MAX_COLS);

  const table = document.createElement("table");
  table.className = "canvas-file-table";
  const head = document.createElement("thead");
  head.append(tableRow(rows[0], cols, "th"));
  const body = document.createElement("tbody");
  for (const row of rows.slice(1, TABLE_MAX_ROWS + 1)) body.append(tableRow(row, cols, "td"));
  table.append(head, body);
  return table;
}

export function tableRow(cells, cols, tag) {
  const tr = document.createElement("tr");
  for (let i = 0; i < cols; i += 1) {
    const cell = document.createElement(tag);
    cell.textContent = cells[i] ?? "";
    tr.append(cell);
  }
  return tr;
}

export const AUDIO_NOTE_SVG = `
  <svg class="canvas-audio-note" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7.6 14.2V5.7l7-1.5v8.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="5.9" cy="14.6" r="2.1" fill="currentColor"/>
    <circle cx="12.9" cy="13.1" r="2.1" fill="currentColor"/>
  </svg>
  <span class="canvas-audio-bars" aria-hidden="true"><i></i><i></i><i></i></span>`;

export const AUDIO_PLAY_SVG = `
  <svg class="canvas-audio-play" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7.2 4.9v10.2L15 10z" fill="currentColor"/>
  </svg>`;

export const AUDIO_PAUSE_SVG = `
  <svg class="canvas-audio-pause" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="5.6" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
    <rect x="11.4" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
  </svg>`;

export function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/* 播放器外壳。音频数据按需加载，避免打开画布时把所有歌都读进内存。 */
export function createAudioPlayer(item, mediaSrc, options = {}) {
  const loadAudio = options.loadAudio;
  const player = document.createElement("div");
  player.className = "canvas-audio-player";

  const icon = document.createElement("div");
  icon.className = "canvas-audio-icon";
  icon.innerHTML = AUDIO_NOTE_SVG;

  const main = document.createElement("div");
  main.className = "canvas-audio-main";

  const name = document.createElement("div");
  name.className = "canvas-audio-name";
  name.textContent = item.name || "未命名音频";

  const row = document.createElement("div");
  row.className = "canvas-audio-row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "canvas-audio-toggle";
  toggle.setAttribute("aria-label", "播放");
  toggle.innerHTML = `${AUDIO_PLAY_SVG}${AUDIO_PAUSE_SVG}`;

  const track = document.createElement("div");
  track.className = "canvas-audio-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "播放进度");
  track.innerHTML = `
    <div class="canvas-audio-rail">
      <div class="canvas-audio-fill"></div>
      <span class="canvas-audio-knob"></span>
    </div>`;

  const time = document.createElement("span");
  time.className = "canvas-audio-time";
  time.textContent = "0:00 / 0:00";

  row.append(toggle, track, time);
  main.append(name, row);
  player.append(icon, main);

  const audio = document.createElement("audio");
  audio.className = "canvas-audio-element";
  audio.preload = "metadata";

  const fill = track.querySelector(".canvas-audio-fill");
  const knob = track.querySelector(".canvas-audio-knob");

  let ready = false;
  let duration = 0;
  let pendingSeek = null;

  if (item.src && mediaSrc) {
    audio.src = mediaSrc;
    ready = true;
  }

  const render = () => {
    const total = Number.isFinite(audio.duration) ? audio.duration : duration;
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    time.textContent = `${formatMediaTime(position)} / ${formatMediaTime(total)}`;
    const fraction = total > 0 ? Math.min(1, Math.max(0, position / total)) : 0;
    fill.style.width = `${fraction * 100}%`;
    knob.style.left = `${fraction * 100}%`;
  };

  const ensureSource = async () => {
    if (ready) return true;
    if (!item.src || typeof loadAudio !== "function") return false;
    try {
      player.classList.add("is-loading");
      const dataUrl = await loadAudio(item.src);
      audio.src = dataUrl;
      ready = true;
      player.classList.remove("is-loading");
      return true;
    } catch {
      player.classList.remove("is-loading");
      player.classList.add("is-error");
      toggle.disabled = true;
      time.textContent = missingLabel(item, "音频丢失");
      return false;
    }
  };

  const seek = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      pendingSeek = fraction;
      return;
    }
    audio.currentTime = fraction * audio.duration;
    render();
  };

  toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  toggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!(await ensureSource())) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        player.classList.add("is-error");
      }
    } else {
      audio.pause();
    }
  });

  track.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ensureSource().then(() => seek(e.clientX));
    const move = (event) => seek(event.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  audio.addEventListener("loadedmetadata", () => {
    duration = audio.duration;
    if (pendingSeek !== null) {
      audio.currentTime = pendingSeek * duration;
      pendingSeek = null;
    }
    render();
  });
  audio.addEventListener("timeupdate", render);
  audio.addEventListener("play", () => {
    /* 画布上同时只播一个声音 */
    const scope = player.closest(".canvas-world") || document;
    for (const other of scope.querySelectorAll("audio, video")) {
      if (other !== audio) other.pause();
    }
    player.classList.add("is-playing");
    player.classList.remove("is-error");
    toggle.setAttribute("aria-label", "暂停");
  });
  audio.addEventListener("pause", () => {
    player.classList.remove("is-playing");
    toggle.setAttribute("aria-label", "播放");
  });
  audio.addEventListener("ended", () => {
    player.classList.remove("is-playing");
    audio.currentTime = 0;
    render();
  });
  audio.addEventListener("error", () => {
    if (!ready) return;
    player.classList.remove("is-playing");
    player.classList.add("is-error");
    toggle.disabled = true;
    time.textContent = "无法播放";
  });

  player.append(audio);
  return player;
}

export const VIDEO_CURTAIN_SVG = `
  <svg viewBox="0 0 44 44" aria-hidden="true">
    <circle cx="22" cy="22" r="20.5" fill="rgba(0,0,0,0.42)" stroke="rgba(255,255,255,0.86)" stroke-width="1.5"/>
    <path d="M17.6 14.3v15.4L30.4 22z" fill="#fff"/>
  </svg>`;

export const VIDEO_PLAY_SVG = `
  <svg class="canvas-video-play" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7.2 4.9v10.2L15 10z" fill="currentColor"/>
  </svg>`;

export const VIDEO_PAUSE_SVG = `
  <svg class="canvas-video-pause" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="5.6" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
    <rect x="11.4" y="4.6" width="3" height="10.8" rx="1" fill="currentColor"/>
  </svg>`;

export const VIDEO_MAX_OUT_SVG = `
  <svg class="canvas-video-max-out" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M8 4.4H4.4V8M12 4.4h3.6V8M15.6 12v3.6H12M8 15.6H4.4V12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

export const VIDEO_MAX_IN_SVG = `
  <svg class="canvas-video-max-in" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4.6 8.2H8.2V4.6M15.4 8.2H11.8V4.6M15.4 11.8H11.8v3.6M4.6 11.8H8.2v3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

export const VIDEO_VOL_ON_SVG = `
  <svg class="canvas-video-vol-on" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3.7 7.4h2.8L10.4 4.2v11.6L6.5 12.6H3.7z" fill="currentColor"/>
    <path d="M12.6 7.7a3.4 3.4 0 0 1 0 4.6M14.9 5.5a6.5 6.5 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

export const VIDEO_VOL_OFF_SVG = `
  <svg class="canvas-video-vol-off" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3.7 7.4h2.8L10.4 4.2v11.6L6.5 12.6H3.7z" fill="currentColor"/>
    <path d="M12.6 7.9l4.4 4.2M17 7.9l-4.4 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

/* 视频控制器的对外把手：右键菜单要读状态、改音量，不必知道播放器内部长什么样 */
export const videoControls = new WeakMap();

export function videoControlOf(el) {
  const player = el?.querySelector?.(".canvas-video-player");
  return player ? videoControls.get(player) ?? null : null;
}

/* 视频播放壳。地址不是 base64，而是后端开了读权限的 asset 协议链接，
 * 浏览器按 Range 一段段要，所以 20GB 的片子也只占解码缓冲，不会整份进内存。
 * 地址也是点到才去取：打开画布时不会把所有片子都拉一遍。 */
export function createVideoPlayer(item, mediaSrc, options = {}) {
  const player = document.createElement("div");
  player.className = "canvas-video-player";

  const stage = document.createElement("div");
  stage.className = "canvas-video-stage";

  const video = document.createElement("video");
  video.className = "canvas-video-element";
  video.preload = "metadata";
  video.playsInline = true;

  /* 转出来的 AAC 音轨副本：画面还是原片，声音改吃这份。
     原音轨在这台机器上放不出声时才用得上。 */
  const dub = document.createElement("audio");
  dub.preload = "auto";

  const curtain = document.createElement("div");
  curtain.className = "canvas-video-curtain";
  curtain.innerHTML = VIDEO_CURTAIN_SVG;

  stage.append(video, curtain);

  const row = document.createElement("div");
  row.className = "canvas-video-row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "canvas-video-toggle";
  toggle.setAttribute("aria-label", "播放");
  toggle.innerHTML = `${VIDEO_PLAY_SVG}${VIDEO_PAUSE_SVG}`;

  const track = document.createElement("div");
  track.className = "canvas-video-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "播放进度");
  track.innerHTML = `
    <div class="canvas-video-rail">
      <div class="canvas-video-fill"></div>
      <span class="canvas-video-knob"></span>
    </div>`;

  const time = document.createElement("span");
  time.className = "canvas-video-time";
  time.textContent = "0:00 / 0:00";

  /* 音量：控制行平时只多一颗喇叭键，滑条藏在悬停浮层里。
     点喇叭是静音开关，滑条用来细调。 */
  const volWrap = document.createElement("div");
  volWrap.className = "canvas-video-volwrap";

  const volBtn = document.createElement("button");
  volBtn.type = "button";
  volBtn.className = "canvas-video-volume";
  volBtn.setAttribute("aria-label", "静音");
  volBtn.title = "音量";
  volBtn.innerHTML = `${VIDEO_VOL_ON_SVG}${VIDEO_VOL_OFF_SVG}`;

  const volPop = document.createElement("div");
  volPop.className = "canvas-video-volpop";
  volPop.hidden = true;
  volPop.innerHTML = `
    <div class="canvas-video-volrail" role="slider" aria-label="音量">
      <div class="canvas-video-volfill"></div>
      <span class="canvas-video-volknob"></span>
    </div>`;

  volWrap.append(volBtn, volPop);

  /* 播不出来的入口只在真出问题以后才出现，平时这一行干干净净。纯文字，不带色块。 */
  const hint = document.createElement("button");
  hint.type = "button";
  hint.className = "canvas-video-hint";
  hint.hidden = true;

  /* 铺满屏幕那颗键：视频丢了就没必要露出来 */
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "canvas-video-max";
  expand.setAttribute("aria-label", "全屏");
  expand.title = "铺满屏幕";
  expand.innerHTML = `${VIDEO_MAX_OUT_SVG}${VIDEO_MAX_IN_SVG}`;

  row.append(toggle, track, time, hint, volWrap);
  /* 原文件没了的引用块没什么可全屏的，那颗键就别露出来 */
  if (item.src && !options.mediaMissing) row.append(expand);
  player.append(stage, row);

  const fill = track.querySelector(".canvas-video-fill");
  const knob = track.querySelector(".canvas-video-knob");
  const volRail = volPop.querySelector(".canvas-video-volrail");
  const volFill = volPop.querySelector(".canvas-video-volfill");
  const volKnob = volPop.querySelector(".canvas-video-volknob");

  let ready = false;
  let dubReady = false;
  let duration = 0;
  let pendingSeek = null;
  let problem = "";
  let volume = Number.isFinite(item.volume) ? Math.min(1, Math.max(0, item.volume)) : 1;
  let lastVolume = volume > 0 ? volume : 1;

  if (item.src && mediaSrc) {
    video.src = mediaSrc;
    ready = true;
  }

  /* 有 AAC 副本时画面自己不出声，声音全交给副本，不然两边一起响。 */
  video.muted = Boolean(item.audioRel);

  /* 音量同时落原片和副本：哪一路出声都跟着走，不会调了没反应 */
  const applyVolume = () => {
    video.volume = volume;
    dub.volume = volume;
    volWrap.classList.toggle("is-muted", volume === 0);
    volFill.style.width = `${volume * 100}%`;
    volKnob.style.left = `${volume * 100}%`;
    volBtn.setAttribute("aria-label", volume === 0 ? "取消静音" : "静音");
  };

  const setVolume = (next, commit = false) => {
    volume = Math.min(1, Math.max(0, next));
    if (volume > 0) lastVolume = volume;
    item.volume = volume;
    applyVolume();
    if (commit) options.onVideoVolume?.(item);
  };

  applyVolume();

  const markProblem = (reason) => {
    if (problem || !item.src) return;
    problem = reason;
    hint.hidden = false;
    hint.textContent = reason === "audio" ? "没声音？" : "播不出来？";
    hint.title =
      reason === "audio"
        ? "画面在动，可音轨一个字节都没解出来。点这里看怎么办"
        : "连一帧画面都没解出来。点这里看怎么办";
  };

  /* 判断依据只有硬指标：解码器吃进去多少字节、解出多少帧。
     不用 Web Audio 量音量 —— asset 地址算跨源，接上分析器永远读 0，测了反而骗自己。 */
  const checkPlayback = () => {
    if (problem || item.audioRel) return;
    const frames = video.webkitDecodedFrameCount;
    const bytes = video.webkitAudioDecodedByteCount;
    if (typeof frames === "number" && frames === 0) {
      markProblem("video");
    } else if (typeof bytes === "number" && bytes === 0) {
      markProblem("audio");
    }
  };

  const render = () => {
    const total = Number.isFinite(video.duration) ? video.duration : duration;
    const position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    time.textContent = `${formatMediaTime(position)} / ${formatMediaTime(total)}`;
    const fraction = total > 0 ? Math.min(1, Math.max(0, position / total)) : 0;
    fill.style.width = `${fraction * 100}%`;
    knob.style.left = `${fraction * 100}%`;
    /* 副本跟画面对声：差得多于 80ms 才拽一把，不然每帧都设 currentTime 反而抖 */
    if (dubReady && !video.paused && Math.abs(dub.currentTime - position) > 0.08) {
      dub.currentTime = position;
    }
  };

  const ensureSource = async () => {
    if (ready) return true;
    if (!item.src || typeof options.loadVideo !== "function") return false;
    try {
      player.classList.add("is-loading");
      video.src = await options.loadVideo(item.src);
      ready = true;
      player.classList.remove("is-loading");
      return true;
    } catch {
      player.classList.remove("is-loading");
      player.classList.add("is-error");
      /* 不锁死按钮：原片插回硬盘后还能再点一次重试 */
      time.textContent = missingLabel(item, "视频文件不在了");
      return false;
    }
  };

  /* 副本走的是同一条 asset 通道：后端顺手把读权限开了，大音频也不会整份进内存。
     它一定躺在画布目录里，所以按相对路径取，跟原片是不是引用态无关。 */
  const ensureDub = async () => {
    if (!item.audioRel || dubReady || typeof options.loadVideo !== "function") return;
    try {
      dub.src = await options.loadVideo(item.audioRel, false);
      dubReady = true;
    } catch {
      /* 副本没了就回原音轨，别把整块卡死 */
      video.muted = false;
    }
  };

  const togglePlay = async () => {
    if (!(await ensureSource())) return;
    if (video.paused) {
      await ensureDub();
      try {
        await video.play();
      } catch {
        player.classList.add("is-error");
        time.textContent = "这个格式播不了";
        markProblem("video");
      }
    } else {
      video.pause();
    }
  };

  const seek = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      pendingSeek = fraction;
      return;
    }
    video.currentTime = fraction * video.duration;
    if (dubReady) dub.currentTime = video.currentTime;
    render();
  };

  toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });

  hint.addEventListener("pointerdown", (e) => e.stopPropagation());
  hint.addEventListener("click", (e) => {
    e.stopPropagation();
    options.onVideoProblem?.(item, problem);
  });

  /* 喇叭和滑条都在这个壳里，一处在 pointerdown 上截住就够整块不被拖走 */
  volWrap.addEventListener("pointerdown", (e) => e.stopPropagation());

  volBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setVolume(volume === 0 ? lastVolume : 0, true);
  });

  /* 按钮和浮层之间隔着 8px 的空隙：收起留一点缓冲，手指挪过去时不会闪没 */
  let volHideTimer = 0;
  let volDragging = false;

  const showVolume = () => {
    if (volHideTimer) {
      clearTimeout(volHideTimer);
      volHideTimer = 0;
    }
    volPop.hidden = false;
  };

  const hideVolumeSoon = () => {
    if (volDragging) return;
    if (volHideTimer) clearTimeout(volHideTimer);
    volHideTimer = setTimeout(() => {
      volHideTimer = 0;
      volPop.hidden = true;
    }, 160);
  };

  volWrap.addEventListener("pointerenter", showVolume);
  volWrap.addEventListener("pointerleave", hideVolumeSoon);

  const volumeSeek = (clientX) => {
    const rect = volRail.getBoundingClientRect();
    if (!rect.width) return;
    setVolume((clientX - rect.left) / rect.width);
  };

  volRail.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    volDragging = true;
    volumeSeek(e.clientX);
    const move = (event) => volumeSeek(event.clientX);
    const up = () => {
      volDragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setVolume(volume, true);
      /* 松手时人已经挪出浮层的话，别把面板留在半空 */
      if (!volWrap.matches(":hover")) volPop.hidden = true;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  /* 全屏挂在外壳上，不是 <video> 自己：这样控制行跟着一起进全屏层。
     监听也挂在壳上，壳随块重建时一起消失，不会在 document 上攒一堆僵尸监听。 */
  const setFullscreen = (on) => {
    player.classList.toggle("is-fullscreen", on);
    expand.setAttribute("aria-label", on ? "退出全屏" : "全屏");
    expand.title = on ? "退出全屏（Esc）" : "铺满屏幕";
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement === player) {
      document.exitFullscreen().catch(() => {});
    } else {
      player.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }
  };

  player.addEventListener("fullscreenchange", () => {
    setFullscreen(document.fullscreenElement === player);
  });

  expand.addEventListener("pointerdown", (e) => e.stopPropagation());
  expand.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  /* 画面区域留给你拖动整块，双击才切换播放，不然块就挪不动了 */
  stage.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePlay();
  });

  track.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    ensureSource().then((ok) => ok && seek(e.clientX));
    const move = (event) => seek(event.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  video.addEventListener("loadedmetadata", () => {
    duration = video.duration;
    if (!item.sized && video.videoWidth > 0 && video.videoHeight > 0) {
      const fit = fitVideoSize(video.videoWidth, video.videoHeight);
      item.w = fit.w;
      item.h = fit.h;
      item.sized = true;
      const el = player.closest(".canvas-item");
      if (el) syncItemElement(el, item);
      options.onVideoSize?.(item);
    }
    if (pendingSeek !== null) {
      video.currentTime = pendingSeek * duration;
      pendingSeek = null;
    }
    render();
  });
  video.addEventListener("timeupdate", () => {
    render();
    /* 播出去一秒多再下结论：刚起步时字节数还没涨，容易看成哑巴 */
    if (video.currentTime > 1.2) checkPlayback();
  });
  video.addEventListener("durationchange", () => {
    /* mkv 的时长有时比 metadata 晚到 */
    if (Number.isFinite(video.duration) && video.duration !== duration) {
      duration = video.duration;
      render();
    }
  });
  video.addEventListener("play", () => {
    const scope = player.closest(".canvas-world") || document;
    for (const other of scope.querySelectorAll("audio, video")) {
      if (other !== video) other.pause();
    }
    if (dubReady) dub.play().catch(() => {});
    player.classList.add("is-playing");
    player.classList.remove("is-error");
    toggle.setAttribute("aria-label", "暂停");
  });
  video.addEventListener("pause", () => {
    if (dubReady) dub.pause();
    player.classList.remove("is-playing");
    toggle.setAttribute("aria-label", "播放");
  });
  video.addEventListener("ended", () => {
    if (dubReady) dub.pause();
    player.classList.remove("is-playing");
    video.currentTime = 0;
    render();
  });
  video.addEventListener("error", () => {
    if (!ready) return;
    player.classList.remove("is-playing");
    player.classList.add("is-error");
    time.textContent = "无法播放";
    markProblem("video");
  });

  /* 副本不进 DOM：画布里有「播一个就停掉其余」的规矩，挂在树上的它会把自己挤掉。 */
  if (item.audioRel) ensureDub();

  /* 右键菜单通过这套指令控制播放器，读到的永远是播放器此刻的真实状态 */
  videoControls.set(player, {
    isPlaying: () => !video.paused && !video.ended,
    togglePlay,
    isFullscreen: () => document.fullscreenElement === player,
    toggleFullscreen,
    getVolume: () => volume,
    setVolume: (value) => setVolume(value),
  });

  return player;
}
