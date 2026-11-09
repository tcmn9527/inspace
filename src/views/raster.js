/* SVG → 画布这一条通路，导出和生图面板取输入图共用一份。
 *
 * 为什么单独一个文件：生图面板要把画面块那块矢量画成位图喂给引擎，
 * 用的正是导出里已经踩过坑的那套。留两份的话，坑只会被踩第二次。
 */

export function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export async function rasterize(svg, pxW, pxH, background) {
  const markup = new XMLSerializer().serializeToString(svg);
  /* 必须是 data: URL，不能用 URL.createObjectURL。
     blob: 载入的 SVG 只要里头有 <foreignObject>，Chromium 就把它当成跨源资源，
     drawImage 之后画布直接被污染，toDataURL 抛 SecurityError
     （实测：同样的图换成 data: 就干净）。base64 比 encodeURIComponent 省，
     中文按 UTF-8 走字节，不会一格三膨胀。 */
  const url = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(markup))}`;
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("画不出来：这块内容太大了，或者里面有取不到的图"));
    image.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(pxW));
  canvas.height = Math.max(1, Math.round(pxH));
  const ctx = canvas.getContext("2d");
  /* background 传 null 表示要透明底：连底色都不铺，alpha 全留给 SVG 自己 */
  if (background !== null) {
    ctx.fillStyle = background || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  /* SVG 自身的像素尺寸就是目标尺寸，这里 1:1 贴上去，不会再糊一层 */
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* 任何一张位图（data URL，什么格式都行）转成 PNG 的 data URL。
   生图引擎那边只解 PNG，所以进引擎的图一律先过这一道；
   data: 图源画进画布不污染画布，toDataURL 拿得到。 */
export async function toPngDataUrl(dataUrl, pxW, pxH) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("输入图打不开"));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(pxW || image.naturalWidth));
  canvas.height = Math.max(1, Math.round(pxH || image.naturalHeight));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
