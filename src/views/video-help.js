/* 视频播不出来时的说明弹层。

 * 两件事分开看：
 *   画面黑 —— 多半是 H.265/HEVC，Windows 要单独装解码器，无限空间替不了，只能给步骤。
 *   没声音 —— 音轨是 AC3/DTS 这类看系统脸色的编码，无限空间能自己解决：借 ffmpeg 把音轨转成 AAC。
 *
 * 不假设用户装过 ffmpeg，也不替他猜能不能播：弹层只讲这台机器现在的实情，
 * 装完点「重新检测」就地换成分支，不用关掉重开。 */

import * as store from "./canvas-store.js";

let current = null;

const STEP_CLASS = "dialog-steps";

function stepList(steps) {
  const box = document.createElement("ol");
  box.className = STEP_CLASS;
  for (const text of steps) {
    const li = document.createElement("li");
    li.textContent = text;
    box.append(li);
  }
  return box;
}

/* 已知信息一行带过：编码、音轨、字幕。探测没成功就不硬凑。 */
function factsLine(probe) {
  if (!probe?.ok) {
    return probe?.reason === "no-ffmpeg" ? "没找到 ffmpeg，暂时看不出这条片子的编码。" : "";
  }
  const bits = [];
  if (probe.videoCodec) bits.push(`画面 ${probe.videoCodec}`);
  if (probe.audioCodec) {
    bits.push(`音轨 ${probe.audioCodec}${probe.audioLayout ? ` ${probe.audioLayout}` : ""}`);
  }
  if (probe.audioTracks > 1) bits.push(`共 ${probe.audioTracks} 条音轨`);
  if (probe.subtitleTracks > 0) bits.push(`${probe.subtitleTracks} 条字幕（空间里暂时不显示）`);
  return bits.join(" · ");
}

function audioSteps(status) {
  if (!status?.found) {
    return [
      "到 gyan.dev 或 ffmpegwings.com 下载 Windows 64 位版（编译版即可，不用自己编）。",
      "解压，把里面的 bin\\ffmpeg.exe 拷到下面这个文件夹：",
      "回到这里点「重新检测」，认出来就直接转。",
    ];
  }
  return [
    "只转第一条音轨，画面原样不动，转出来的 AAC 放在空间目录里。",
    "原片不会被改动，删掉视频块时这份 AAC 一起删。",
    "片子越长转得越久，中途随时能停，停了不留半截文件。",
  ];
}

const VIDEO_STEPS = [
  "打开 Microsoft Store，搜「HEVC 视频扩展」，开发商是 Microsoft Corporation，装上（约 6 元）。",
  "不想为解码器花钱，也可以先把片子压成 H.264 再拖进来 —— 那是另一条路，这里不拦你。",
  "装完回到空间再播一次；解码器是系统级的，不用重启无限空间。",
];

const VIDEO_NOTE =
  "装好了还是黑，多半不是解码器的事：换个播放器放一下确认原片没坏，再看看这条片子的编码是不是别的格式。";

export function openVideoHelp({ reason, probe } = {}) {
  current?.close();

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "dialog-mask";
    mask.innerHTML = `
      <div class="dialog dialog-help" role="dialog" aria-modal="true">
        <p class="dialog-title"></p>
        <p class="dialog-message"></p>
        <p class="dialog-note dialog-help-facts"></p>
        <div class="dialog-help-body"></div>
        <p class="dialog-note dialog-help-path"></p>
        <div class="dialog-actions">
          <button class="dialog-btn dialog-cancel" type="button">关闭</button>
          <button class="dialog-btn dialog-ok" type="button"></button>
          <button class="dialog-btn dialog-help-extra" type="button" hidden></button>
        </div>
      </div>
    `;
    const dialog = mask.querySelector(".dialog");
    const titleEl = dialog.querySelector(".dialog-title");
    const messageEl = dialog.querySelector(".dialog-message");
    const factsEl = dialog.querySelector(".dialog-help-facts");
    const bodyEl = dialog.querySelector(".dialog-help-body");
    const pathEl = dialog.querySelector(".dialog-help-path");
    const cancelBtn = dialog.querySelector(".dialog-cancel");
    const okBtn = dialog.querySelector(".dialog-ok");
    const extraBtn = dialog.querySelector(".dialog-help-extra");

    let settled = false;
    let status = null;
    const controller = { close: () => finish(null) };

    function finish(action) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      if (current === controller) current = null;
      resolve(action);
    }

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        finish(null);
      }
    };

    async function repaint() {
      titleEl.textContent = reason === "audio" ? "画面能动，没有声音" : "这个视频播不出来";
      factsEl.textContent = factsLine(probe);
      factsEl.hidden = !factsEl.textContent;
      bodyEl.replaceChildren(
        stepList(reason === "audio" ? audioSteps(status) : VIDEO_STEPS),
      );
      if (reason === "audio") {
        const who = status?.source === "bundled" ? "无限空间自带的 ffmpeg" : "ffmpeg";
        messageEl.textContent = status?.found
          ? `无限空间用 ${who} 把音轨转成 AAC 就能响。这台机器已经认到（${status.version}），直接转就行。`
          : "这条音轨要靠系统解码器，这台机器没给它出声。装一个 ffmpeg，无限空间就能自己把音轨转成 AAC。";
        okBtn.textContent = status?.found ? "转换音轨" : "重新检测";
        okBtn.dataset.action = status?.found ? "convert" : "recheck";
        extraBtn.hidden = !status || status.found;
        extraBtn.textContent = "打开组件文件夹";
        pathEl.textContent = status?.found ? "" : `组件文件夹：${status?.componentsDir ?? ""}`;
        pathEl.hidden = !pathEl.textContent;
      } else {
        messageEl.textContent =
          "画面一帧都没解出来。最常见的原因是片子压成了 H.265/HEVC，而 Windows 没装对应的解码器 —— 这一步得系统自己装，无限空间替不了。";
        okBtn.textContent = "知道了";
        okBtn.dataset.action = "close";
        extraBtn.hidden = true;
        pathEl.hidden = false;
        pathEl.textContent = VIDEO_NOTE;
      }
    }

    async function refreshStatus() {
      try {
        status = await store.ffmpegStatus();
      } catch {
        status = null;
      }
      await repaint();
    }

    okBtn.addEventListener("click", () => {
      if (okBtn.dataset.action === "convert") finish("convert");
      else if (okBtn.dataset.action === "recheck") refreshStatus();
      else finish(null);
    });
    extraBtn.addEventListener("click", async () => {
      try {
        await store.revealFfmpegDir();
      } catch (error) {
        pathEl.textContent = error?.message || String(error);
      }
    });
    cancelBtn.addEventListener("click", () => finish(null));
    mask.addEventListener("pointerdown", (e) => {
      if (!dialog.contains(e.target)) finish(null);
    });

    document.body.append(mask);
    document.addEventListener("keydown", onKey, true);
    current = controller;
    refreshStatus();
    okBtn.focus({ preventScroll: true });
  });
}
