/* 取一份 libclang.dll 放进 tools/libclang/bin，给 bindgen 用。

   生图引擎的 C++ 绑定是编译时由 bindgen 现生成的，它运行时要 libclang.dll。
   本机没装 LLVM，而装整套要 300MB 以上还动系统 —— 其实只需要那一个 dll。
   PyPI 上的 libclang wheel 就是把它单独打包发布的，26MB，解出来即用。

   不依赖 python：直接读 PyPI 的 JSON 拿 wheel 地址，自己下、自己解。
   下载走 .part + Range 续传，慢网中断了重跑这句就接着来，不会留半个文件：
     node scripts/prepare-libclang.mjs

   产物不入库。已经有 LLVM 的话把 LIBCLANG_PATH 指到它的 bin，这个脚本会让路。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, "tools", "libclang");
const WHEEL = path.join(CACHE_DIR, "libclang.whl");
const TARGET = path.join(CACHE_DIR, "bin", "libclang.dll");
const INDEX = "https://pypi.org/pypi/libclang/json";

function log(message) {
  console.log(`[libclang] ${message}`);
}

function fail(message) {
  console.error(`[libclang] ${message}`);
  process.exit(1);
}

function get(url, headers = { "user-agent": "inspace-build" }, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error(`重定向太多：${url}`));
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve(get(new URL(res.headers.location, url).href, headers, redirects + 1));
          return;
        }
        if (status !== 200 && status !== 206) {
          res.resume();
          reject(new Error(`HTTP ${status}　${url}`));
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function fetchJson(url) {
  const res = await get(url);
  let text = "";
  for await (const chunk of res) text += chunk;
  return JSON.parse(text);
}

/* PyPI 的 wheel 按平台分开发布，这里要的是 Windows 64 位那份 */
async function resolveWheel() {
  const data = await fetchJson(INDEX);
  const version = data.info.version;
  const candidates = (data.releases?.[version] || data.urls || []).filter(
    (file) => file.filename.endsWith("-win_amd64.whl") && !file.yanked
  );
  const hit = candidates.find((file) => /cp3\d+-abi|py2\.py3/.test(file.filename)) || candidates[0];
  if (!hit) fail(`libclang ${version} 没找到 win_amd64 的 wheel。`);
  return { version, filename: hit.filename, url: hit.url, size: hit.size };
}

/* 接着上次断的地方续传：服务器给 Range 就带 Range，不给就整份重来 */
async function download(url, file, total) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const headers = { "user-agent": "inspace-build" };
  if (have > 0 && total && have < total) headers.range = `bytes=${have}-`;

  const res = await get(url, headers);
  const start = res.statusCode === 206 ? have : 0;
  if (res.statusCode === 206) {
    log(`续传：已有 ${mib(have)}，接着下剩下的 ${mib((total || 0) - have)}`);
  } else if (have > 0) {
    log(`服务器不支持续传，整份重来（${mib(total || 0)}）`);
  }

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: start ? "a" : "w" });
    let got = start;
    let mark = start;
    res.on("data", (chunk) => {
      got += chunk.length;
      if (total && got - mark > 4 * 1024 * 1024) {
        mark = got;
        log(`${((got / total) * 100).toFixed(0)}%　${mib(got)} / ${mib(total)}`);
      }
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", () => out.close(() => resolve()));
    res.pipe(out);
  });

  if (total && fs.statSync(file).size !== total) {
    throw new Error(`下完了但字节数不对：${fs.statSync(file).size} ≠ ${total}，重跑这句可续传。`);
  }
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function unzip(archive, into) {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  // wheel 就是 zip，但 Expand-Archive 只认 .zip 后缀，先换个名。
  const named = path.join(os.tmpdir(), `libclang-${path.basename(archive)}.zip`);
  fs.copyFileSync(archive, named);
  try {
    const script = `Expand-Archive -LiteralPath '${named}' -DestinationPath '${into}' -Force`;
    const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 300000,
    });
    if (run.status !== 0) {
      throw new Error((run.stderr || run.stdout || "Expand-Archive 失败").trim());
    }
  } finally {
    fs.rmSync(named, { force: true });
  }
}

function findFile(dir, name, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory()) {
      const hit = findFile(full, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function main() {
  if (process.env.LIBCLANG_PATH && fs.existsSync(path.join(process.env.LIBCLANG_PATH, "libclang.dll"))) {
    log(`环境变量已经指好了，不用取：${process.env.LIBCLANG_PATH}`);
    return;
  }
  if (fs.existsSync(TARGET)) {
    log(`已在位：${TARGET}（${mib(fs.statSync(TARGET).size)}）`);
    return;
  }

  const wheel = await resolveWheel();
  log(`目标：libclang ${wheel.version}　${wheel.filename}（${mib(wheel.size)}）`);

  try {
    if (fs.existsSync(WHEEL) && fs.statSync(WHEEL).size === wheel.size) {
      log("wheel 已经下全了，直接解压。");
    } else {
      await download(wheel.url, WHEEL, wheel.size);
    }
  } catch (error) {
    fail(`${error.message}\n下不动的话自己存成这个路径再重跑：${WHEEL}\n直链：${wheel.url}`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "libclang-unpack-"));
  try {
    log("解压 wheel…");
    unzip(WHEEL, work);
    const dll = findFile(work, "libclang.dll");
    if (!dll) fail("wheel 里没找到 libclang.dll。");
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.copyFileSync(dll, TARGET);
    log(`就绪：${TARGET}（${mib(fs.statSync(TARGET).size)}）`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.message));
