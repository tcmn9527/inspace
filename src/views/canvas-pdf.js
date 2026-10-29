/* PDF 预览：pdf.js（vendor 在 src/vendor/pdfjs）把指定的页画进调用方给的 <canvas>。
 *
 * 没用浏览器自带的 PDF 查看器（<iframe src="asset:...">）：那颗工具栏塞不进空间块，
 * 帧还会把滚轮和按下拖动吃掉——电子书书页就是栽在这儿，最后只能把帧钉成不可交互。
 * 自己画到 canvas 上，滚动、翻页、鼠标路径就都还在我们手里。
 *
 * worker、cmaps（中日韩字符表）和 standard_fonts 都按 pdf.mjs 自己的位置算相对路径，
 * 这样整包挪走也不会指错地方。 */

import * as pdfjs from "../vendor/pdfjs/build/pdf.mjs";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL("build/pdf.worker.mjs", VENDOR).href;

/* url -> Promise<PDFDocumentProxy>。同一份 PDF 在同一个空间里出现多次也只开一遍。 */
const documents = new Map();

export function openPdf(url) {
  let pending = documents.get(url);
  if (!pending) {
    pending = pdfjs.getDocument({
      url,
      cMapUrl: new URL("cmaps/", VENDOR).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("standard_fonts/", VENDOR).href,
      /* 只按需读：asset 地址支持 Range，pdf.js 要多少字节读多少。
         默认那套「后台把整本预取进内存」是为网页连续滚动设计的，
         一个空间一次只挂几页，预取等于把 70MB 的书整份搬进内存。 */
      disableAutoFetch: true,
    }).promise;
    /* 读坏了就别留着这个 key，下次重试还能有机会（比如文件后来补全了） */
    pending.catch(() => {
      if (documents.get(url) === pending) documents.delete(url);
    });
    documents.set(url, pending);
  }
  return pending;
}

export function forgetPdf(url) {
  documents.delete(url);
}

/* 只问一页有多大，不画。页链要先拿到每页宽高比才撑得准滚动条，
   而 getViewport 只要那一页的字典，读几十 KB 就够，比渲染便宜一个量级。 */
export async function pdfPageSize(url, page) {
  const doc = await openPdf(url);
  const at = Math.min(Math.max(1, Math.trunc(page)), doc.numPages);
  const pdfPage = await doc.getPage(at);
  try {
    const box = pdfPage.getViewport({ scale: 1 });
    return { page: at, width: box.width, height: box.height };
  } finally {
    pdfPage.cleanup();
  }
}

/* slot 是「一次画一张 canvas」的把手：pdf.js 不允许同一张 canvas 上两个 render() 并行，
   页链滚快了就得先掐掉上一张没画完的。 */
export async function renderPdfPage({ url, page, canvas, width, slot }) {
  const doc = await openPdf(url);
  const total = doc.numPages;
  const at = Math.min(Math.max(1, page), total);
  const pdfPage = await doc.getPage(at);
  if (slot.task) {
    slot.task.cancel();
    slot.task = null;
  }
  const base = pdfPage.getViewport({ scale: 1 });
  const cssScale = Math.max(0.05, width / base.width);
  const ratio = window.devicePixelRatio || 1;
  const viewport = pdfPage.getViewport({ scale: cssScale * ratio });
  const cssWidth = Math.max(1, Math.round(base.width * cssScale));
  const cssHeight = Math.max(1, Math.round(base.height * cssScale));
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const task = pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport });
  slot.task = task;
  try {
    await task.finished;
  } finally {
    if (slot.task === task) slot.task = null;
    pdfPage.cleanup();
  }
  return { page: at, total, width: cssWidth, height: cssHeight };
}

/* pdf.js 抛的这几种名字稳定，够用来把话说清楚；其余的把原文带上 */
export function pdfProblem(error) {
  const name = error?.name || "";
  if (name === "PasswordException") return "这份 PDF 设了打开密码，空间里读不出来";
  if (name === "InvalidPDFException") return "这份 PDF 不像是一份有效的 PDF，读不出来";
  if (name === "MissingPDFException") return "这份 PDF 已经不在了";
  const message = error?.message || error;
  return `这份 PDF 读不出来：${message}`;
}

export const isCancelled = (error) => error?.name === "RenderingCancelledException";
