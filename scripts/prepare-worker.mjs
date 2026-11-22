/* 把编好的 h3d_tex_worker.exe 放到两个地方：
   1) src-tauri/target/<profile>/ —— dev 运行时主程序就从 exe 同目录找它
   2) src-tauri/resources/worker/ —— tauri 打包收进安装包（resources 配置要求文件存在） */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = process.argv[2] || "debug";
const src = path.join(ROOT, "src-tauri", "h3d-worker", "target", profile, "h3d_tex_worker.exe");
if (!fs.existsSync(src)) {
  console.error(`[worker] 没找到 ${src}，先构建 h3d-worker crate`);
  process.exit(1);
}
const exe_dir = path.join(ROOT, "src-tauri", "target", profile);
fs.mkdirSync(exe_dir, { recursive: true });
fs.copyFileSync(src, path.join(exe_dir, "h3d_tex_worker.exe"));
const res_dir = path.join(ROOT, "src-tauri", "resources", "worker");
fs.mkdirSync(res_dir, { recursive: true });
fs.copyFileSync(src, path.join(res_dir, "h3d_tex_worker.exe"));
console.log(`[worker] ${profile} → target/${profile} 与 resources/worker`);
