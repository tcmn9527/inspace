/* 把上游 stable-diffusion.cpp 的源码取到 tools/sdcpp —— 生图引擎编的就是这一份。

   为什么不用 crates.io 上的 diffusion-rs：它封的是 6 月的源码（0.1.20 已是最新，
   作者最后一次 bump 只到 9/2 的 master-841），而 Qwen-Image 2.1 是 9/20 才并进上游的
   （feat: add Qwen Image 2.1 support #1994）。手上这份权重的张量名（img_mlp.gate_up、
   txt_in.text_norm、全局 modulation）只有新代码认得，旧代码连模型都检不出来。

   两条取源路径，按顺序试：
     1. 本地包 tools/downloads/sdcpp.zip + ggml.zip —— 人肉下载走这条。
        要 .zip 不要 .tar.gz：zip 每条带 CRC，截断的包 Expand-Archive 当场报错，
        tar.gz 截断能半开（实测 HTTP 200 + 只有一半的包，解出来一堆缺文件）。
        顶层目录名是 <库名>-<完整 sha>，顺手就当版本核对。
     2. git fetch --depth 1 按 sha 取 —— 没人肉包时自己拉。
        这台机器走 HTTP/2 会在几十 MB 处被掐（curl 92 stream CANCEL），所以退回 1.1；
        掉线了重跑同一句，已下到的对象复用。

   用法：node scripts/prepare-sdcpp.mjs
   直链（钉死的 commit，见下面的 SHA）：
     https://github.com/leejet/stable-diffusion.cpp/archive/<SD_SHA>.zip
     https://github.com/leejet/ggml/archive/<GGML_SHA>.zip
   换版本：SD_SHA 填上游新提交，GGML_SHA 填那份提交 tree 里 ggml 这个 submodule 的 sha
     curl -s https://api.github.com/repos/leejet/stable-diffusion.cpp/git/trees/<SD_SHA>

   两份源码都不入库（tools/sdcpp 已进 .gitignore），编译产物在 src-tauri/target 里。 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SD_SHA = "290148d2e31ca6ef9757d567905776b5f3646db5"; // master-1039，2026-11-01
const GGML_SHA = "d49c49e1dd361ba3c0a77c90b5b1404b83969aa8"; // 上面那份提交里 ggml 指向的

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "tools", "sdcpp");
const PIN = path.join(DEST, ".pin");
const DOWNLOADS = path.join(ROOT, "tools", "downloads");

const SOURCES = [
  {
    name: "stable-diffusion.cpp",
    repo: "https://github.com/leejet/stable-diffusion.cpp",
    sha: SD_SHA,
    into: DEST,
    zip: path.join(DOWNLOADS, "sdcpp.zip"),
    probe: path.join("src", "model", "diffusion", "qwen_image_2_1.hpp"), // 2.1 的权重只认这份
  },
  {
    name: "ggml",
    repo: "https://github.com/leejet/ggml",
    sha: GGML_SHA,
    into: path.join(DEST, "ggml"),
    zip: path.join(DOWNLOADS, "ggml.zip"),
    probe: path.join("CMakeLists.txt"),
  },
];

function log(message) {
  console.log(`[sdcpp] ${message}`);
}

function fail(message) {
  console.error(`[sdcpp] ${message}`);
  process.exit(1);
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
    timeout: 900000,
  });
  if (result.error) throw new Error(`${command} ${args.join(" ")} 起不来：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} 失败（退出码 ${result.status}）${capture ? `：${(result.stderr || "").trim()}` : ""}`
    );
  }
  return capture ? result.stdout.trim() : "";
}

/* git 下到一半留下的临时包是只读的，Windows 上直接删会 EPERM；删之前先把权限放开。 */
function unlock(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    try {
      fs.chmodSync(p, 0o666);
      if (entry.isDirectory()) unlock(p);
    } catch {
      /* 改不动就算了，真删不掉的时候会报错 */
    }
  }
}

function wipe(dir) {
  unlock(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}

/* ---------- 路径 1：本地 zip ---------- */

/* 顶层目录必须是 <库名>-<完整 sha>，不然就不是钉的那个 commit（页面按钮下的是 HEAD）。 */
function unpackZip(source) {
  const size = fs.statSync(source.zip).size;
  log(`${source.name} 用本地包 ${(size / 1048576).toFixed(1)} MB`);
  const staged = path.join(DOWNLOADS, `unpacked-${source.name}`);
  wipe(staged);
  fs.mkdirSync(staged, { recursive: true });
  const quoted = source.zip.replaceAll("'", "''");
  run(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
     `Expand-Archive -LiteralPath '${quoted}' -DestinationPath '${staged}' -Force`],
    ROOT
  );
  const wantTop = `${source.repo.split("/").pop()}-${source.sha}`;
  const found = fs.readdirSync(staged).filter((n) => fs.statSync(path.join(staged, n)).isDirectory());
  if (found.length !== 1) throw new Error(`${source.zip} 里应该有且只有一个顶层目录，实际是 ${found.join(", ")}`);
  if (found[0] !== wantTop) {
    throw new Error(`${source.zip} 的顶层目录是 ${found[0]}，不是钉的 ${wantTop} —— 下错版本了`);
  }
  wipe(source.into);
  fs.mkdirSync(path.dirname(source.into), { recursive: true });
  fs.renameSync(path.join(staged, wantTop), source.into);
  fs.rmSync(staged, { recursive: true, force: true });
}

/* ---------- 路径 2：git 浅取 ---------- */

function git(args, cwd, capture = false) {
  return run(
    "git",
    ["-c", "http.version=HTTP/1.1", "-c", "http.postBuffer=524288000", ...args],
    cwd,
    capture
  );
}

/* 上一次跑到一半留下的 .git 原地接着用；不是同一个仓库就整个换掉。 */
function prepareGitDir(source) {
  const gitDir = path.join(source.into, ".git");
  if (fs.existsSync(gitDir)) {
    const url = git(["remote", "get-url", "origin"], source.into, true);
    if (url === source.repo) {
      log(`${source.name} 接着上次没下完的继续`);
      return;
    }
  }
  wipe(source.into);
  fs.mkdirSync(source.into, { recursive: true });
  git(["init", "-q", "--initial-branch=main", "."], source.into);
  git(["remote", "add", "origin", source.repo], source.into);
}

function fetchByGit(source, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      git(["fetch", "--depth", "1", "origin", source.sha], source.into);
      git(["checkout", "-q", "FETCH_HEAD"], source.into);
      const got = git(["rev-parse", "HEAD"], source.into, true);
      if (got !== source.sha) throw new Error(`检出的是 ${got}，不是钉的 ${source.sha}`);
      return;
    } catch (error) {
      if (i === attempts) throw error;
      log(`第 ${i} 次没拉下来（${error.message}），清掉锁重连…`);
      // 锁可能还被没退干净的 git 占着，删不动也别把整个重试带崩。
      try {
        const lock = path.join(source.into, ".git", "shallow.lock");
        fs.chmodSync(lock, 0o666);
        fs.rmSync(lock, { force: true });
      } catch {
        /* 占着锁的进程还在跑，等它跑完下一轮就能接上 */
      }
    }
  }
  fs.rmSync(path.join(source.into, ".git"), { recursive: true, force: true });
}

function currentPin() {
  return fs.existsSync(PIN) ? fs.readFileSync(PIN, "utf8").trim() : "";
}

function ready(wanted) {
  return currentPin() === wanted && fs.existsSync(path.join(DEST, "include", "stable-diffusion.h"));
}

function place(source) {
  if (fs.existsSync(source.zip)) unpackZip(source);
  else {
    prepareGitDir(source);
    fetchByGit(source);
    fs.rmSync(path.join(source.into, ".git"), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(source.into, source.probe))) {
    throw new Error(`落位后缺 ${source.probe}`);
  }
}

function main() {
  const wanted = `${SD_SHA}\n${GGML_SHA}`;
  if (ready(wanted)) {
    log(`已是目标版本：${SD_SHA.slice(0, 8)}（ggml ${GGML_SHA.slice(0, 8)}）`);
    return;
  }

  try {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    for (const source of SOURCES) {
      log(`${source.name} ← ${source.sha.slice(0, 8)}`);
      place(source);
    }
    fs.writeFileSync(PIN, `${wanted}\n`);
    log(`就绪：${DEST}`);
  } catch (error) {
    fail(
      `${error.message}\n` +
        `两条路都走不通就自己下这两条直链，存成 ${DOWNLOADS}\\sdcpp.zip 和 ggml.zip 再重跑：\n` +
        `  ${SOURCES[0].repo}/archive/${SD_SHA}.zip\n` +
        `  ${SOURCES[1].repo}/archive/${GGML_SHA}.zip`
    );
  }
}

main();
