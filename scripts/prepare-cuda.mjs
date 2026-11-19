/* 打包前把 CUDA / cuDNN 运行库和 ORT 的 GPU provider 拷进 src-tauri/resources/cuda。

   生图引擎（sd.cpp）链接的是 CUDA 的导入库，本地 3D 生成（ONNX Runtime）除了
   CUDA 还要 cuDNN 9 和 ORT 自己的 provider dll；这些都必须落在 inspace.exe
   同目录。安装包通过 tauri.conf 的 bundle.resources 把 resources/cuda/* 映射到
   安装根目录，正好贴在 exe 旁边。

   DLL 不入库：cublasLt 一个就 600 多 MB，cuDNN 全套近 1 GB，每次构建从本机现拷。
   CUDA 必须用 12.x（文件名里的 _12），ORT provider 从 ort crate 的运行时缓存里取
   （%LOCALAPPDATA%\ort.pyke.io\dfbin\x86_64-pc-windows-msvc\<hash>\onnxruntime\lib）。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "src-tauri", "resources", "cuda");

/* CUDA 运行库（sd.cpp 与 ORT 共用） */
const CUDA_DLLS = ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"];

/* cuDNN 9：实测跑完一整次 3D 生成（抠图/条件/采样/体素）后进程真正加载的这 6 个。
   adv(269MB) 和 cnn 全程没被加载，不打包——两套安装包都卡 2GB 硬上限，
   砍掉它们才装得下；万一将来某种算子触发到，ORT 会回退 CPU 跑慢一点，不会崩。 */
const CUDNN_DLLS = [
  "cudnn64_9.dll",
  "cudnn_engines_precompiled64_9.dll",
  "cudnn_engines_runtime_compiled64_9.dll",
  "cudnn_graph64_9.dll",
  "cudnn_heuristic64_9.dll",
  "cudnn_ops64_9.dll",
];

/* ORT 静态链接版运行时按需加载这两颗，找不到就静默回退 CPU */
const ORT_DLLS = ["onnxruntime_providers_cuda.dll", "onnxruntime_providers_shared.dll"];

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
    if (CUDA_DLLS.every((name) => fs.existsSync(path.join(bin, name)))) return bin;
  }
  return null;
}

function pickOrtLib() {
  const cache = path.join(os.homedir(), "AppData", "Local", "ort.pyke.io", "dfbin", "x86_64-pc-windows-msvc");
  if (!fs.existsSync(cache)) return null;
  for (const hash of fs.readdirSync(cache)) {
    const lib = path.join(cache, hash, "onnxruntime", "lib");
    if (ORT_DLLS.every((name) => fs.existsSync(path.join(lib, name)))) return lib;
  }
  return null;
}

function copyAll(from, names, what) {
  let copied = 0;
  let total = 0;
  for (const name of names) {
    const src = path.join(from, name);
    if (!fs.existsSync(src)) fail(`${what}缺 ${name}（${from}）`);
    const to = path.join(DEST, name);
    const stat = fs.statSync(src);
    total += stat.size;
    const same =
      fs.existsSync(to) &&
      fs.statSync(to).size === stat.size &&
      fs.statSync(to).mtimeMs >= stat.mtimeMs;
    if (!same) {
      fs.copyFileSync(src, to);
      copied += 1;
    }
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`[cuda] ${name}  ${mb} MB  ${same ? "已是最新" : "已复制"}`);
  }
  console.log(`[cuda] ${what}共 ${(total / 1024 / 1024).toFixed(1)} MB，${copied} 个文件更新`);
}

const cudaBin = pickCudaBin();
if (!cudaBin) {
  fail(
    "找不到 CUDA 12 运行库。生图与本地 3D 生成都依赖它：\n" +
      `  ${CUDA_DLLS.join("\n  ")}\n` +
      "请装 CUDA 12.x Toolkit，或把 CUDA_PATH 指到已有的 CUDA 12 安装目录。",
  );
}

const ortLib = pickOrtLib();
if (!ortLib) {
  fail(
    "找不到 ONNX Runtime 的 GPU provider dll（本地 3D 生成要用）。\n" +
      "先在开发机上编一次带 cuda feature 的 Rust 工程（cargo build --features cuda），\n" +
      "ort crate 会把运行时缓存到 %LOCALAPPDATA%\\ort.pyke.io\\dfbin。",
  );
}

fs.mkdirSync(DEST, { recursive: true });
copyAll(cudaBin, CUDA_DLLS, "CUDA 运行库");
copyAll(cudaBin, CUDNN_DLLS, "cuDNN 9");
copyAll(ortLib, ORT_DLLS, "ORT provider");

console.log(`[cuda] 输出 ${path.relative(ROOT, DEST)}`);
