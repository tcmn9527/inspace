/* 完整版安装包的前置步骤：把 ffmpeg.exe 放到 src-tauri/resources/components/ffmpeg/。
 *
 * 打包时 tauri.full.conf.json 会把这个文件原样放进安装目录的 components\ffmpeg\，
 * 后端 ffmpeg::locate 的第一档就是那里，所以装完机不需要用户再折腾。
 *
 * 三种拿法，按省事程度排：
 *   1. 已经有本地文件：FFMPEG_EXE=D:\\path\\ffmpeg.exe node scripts/prepare-ffmpeg.mjs
 *   2. 什么都不传：从 gyan.dev 下 essentials 包（约 80MB），解压只挑 bin\\ffmpeg.exe
 *   3. 下不动（离线/被墙）：自己去 https://www.gyan.dev/ffmpeg/builds/ 下载后按 1 传路径
 *
 * 只认 ffmpeg.exe：探测和转码都是它一个干的，ffplay/ffprobe 带上纯属占地方。 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DIR = path.join(ROOT, "src-tauri", "resources", "components", "ffmpeg");
const TARGET_EXE = path.join(TARGET_DIR, "ffmpeg.exe");
const SOURCE_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

function log(message) {
  console.log(`[ffmpeg] ${message}`);
}

function fail(message) {
  console.error(`[ffmpeg] ${message}`);
  process.exit(1);
}

/* 下下来的、拷过来的都算数，但得真能跑起来——半个文件比没有更坑。 */
function works(exe) {
  const run = spawnSync(exe, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return run.status === 0;
}

function installFrom(source) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  if (path.resolve(source) !== path.resolve(TARGET_EXE)) {
    fs.copyFileSync(source, TARGET_EXE);
  }
  const size = fs.statSync(TARGET_EXE).size;
  log(`就绪：${TARGET_EXE}（${(size / 1024 / 1024).toFixed(1)} MB）`);
}

function download(url, file, depth = 0) {
  if (depth > 5) return Promise.reject(new Error(`重定向太多：${url}`));
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "user-agent": "inspace-build" } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve(download(new URL(response.headers.location, url).href, file, depth + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const total = Number(response.headers["content-length"] || 0);
        let got = 0;
        let lastMark = 0;
        const out = fs.createWriteStream(file);
        response.on("data", (chunk) => {
          got += chunk.length;
          if (total && got - lastMark > 8 * 1024 * 1024) {
            lastMark = got;
            log(`下载中 ${((got / total) * 100).toFixed(0)}%`);
          }
        });
        response.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
        response.on("error", reject);
      })
      .on("error", reject);
  });
}

/* 不引第三方依赖：Windows 自带的 PowerShell 就能解 zip。 */
function unzip(zipFile, into) {
  fs.mkdirSync(into, { recursive: true });
  const script = `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${into}' -Force`;
  const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 300000,
  });
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || "Expand-Archive 失败").trim());
  }
}

function findFfmpeg(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "ffmpeg.exe") return full;
    if (entry.isDirectory()) {
      const hit = findFfmpeg(full);
      if (hit) return hit;
    }
  }
  return null;
}

async function main() {
  const local = process.env.FFMPEG_EXE;
  if (local) {
    const source = path.resolve(local);
    if (!fs.existsSync(source)) fail(`FFMPEG_EXE 指向的文件不存在：${source}`);
    installFrom(source);
    if (!works(TARGET_EXE)) fail("这个 ffmpeg.exe 跑不起来，换个完整的构建包。");
    return;
  }
  if (fs.existsSync(TARGET_EXE)) {
    if (works(TARGET_EXE)) {
      installFrom(TARGET_EXE);
      return;
    }
    log("已有的文件跑不起来，重新下载。");
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-prepare-"));
  try {
    const zipFile = path.join(work, "ffmpeg.zip");
    log(`下载 ${SOURCE_URL}`);
    await download(SOURCE_URL, zipFile);
    log("解压中…");
    unzip(zipFile, path.join(work, "unpacked"));
    const found = findFfmpeg(path.join(work, "unpacked"));
    if (!found) fail("解压结果里没找到 bin\\ffmpeg.exe。");
    installFrom(found);
    if (!works(TARGET_EXE)) fail("下载下来的 ffmpeg.exe 跑不起来，可能是包不完整。");
  } catch (error) {
    fail(`${error.message}\n离线的话自己下载后这样跑：FFMPEG_EXE=<你的ffmpeg.exe路径> node scripts/prepare-ffmpeg.mjs`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
