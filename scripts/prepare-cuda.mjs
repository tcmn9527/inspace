/* 打包前把 CUDA 12 运行库拷进 src-tauri/resources/cuda。

   生图引擎链接的是 CUDA 的导入库，运行时需要这三个 DLL；它们必须在
   inspace.exe 同目录。安装包通过 tauri.conf 的 bundle.resources 把
   resources/cuda/* 映射到安装根目录，正好落在 exe 旁边。

   DLL 不入库：cublasLt 一个就 600 多 MB，每次构建从本机 CUDA 现拷。
   必须用 CUDA 12.x（文件名里的 _12），和 build.rs 的链接版本一致。 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "src-tauri", "resources", "cuda");
const DLLS = ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"];

function fail(message) {
  console.error(`[cuda] ${message}`);
  process.exit(1);
}

function pickCudaBin() {
  const candidates = [];
  if (process.env.CUDA_PATH) candidates.push(process.env.CUDA_PATH);
  const toolkit = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA";
  if (fs.existsSync(toolkit)) {
    for (const name of fs.readdirSync(toolkit)) {
      if (/^v12\./i.test(name)) candidates.push(path.join(toolkit, name));
    }
  }
  for (const base of candidates) {
    const bin = path.join(base, "bin");
    if (DLLS.every((name) => fs.existsSync(path.join(bin, name)))) return bin;
  }
  return null;
}

const bin = pickCudaBin();
if (!bin) {
  fail(
    "找不到 CUDA 12 运行库。这三个 DLL 是生图引擎的运行时依赖：\n" +
      `  ${DLLS.join("\n  ")}\n` +
      "请装 CUDA 12.x Toolkit，或把 CUDA_PATH 指到已有的 CUDA 12 安装目录。",
  );
}

fs.mkdirSync(DEST, { recursive: true });
let copied = 0;
let total = 0;
for (const name of DLLS) {
  const from = path.join(bin, name);
  const to = path.join(DEST, name);
  const src = fs.statSync(from);
  total += src.size;
  const same =
    fs.existsSync(to) &&
    fs.statSync(to).size === src.size &&
    fs.statSync(to).mtimeMs >= src.mtimeMs;
  if (!same) {
    fs.copyFileSync(from, to);
    copied += 1;
  }
  const mb = (src.size / 1024 / 1024).toFixed(1);
  console.log(`[cuda] ${name}  ${mb} MB  ${same ? "已是最新" : "已复制"}`);
}
console.log(
  `[cuda] 来源 ${bin}；共 ${(total / 1024 / 1024).toFixed(1)} MB，` +
    `${copied} 个文件更新，输出 ${path.relative(ROOT, DEST)}`,
);
