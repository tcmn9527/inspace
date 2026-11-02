/* cargo 之前的构建环境注入。

   生图引擎是 C++（stable-diffusion.cpp），它的 build.rs 写死要 Ninja + cl.exe，
   bindgen 又要有 libclang.dll 才跑得动。这几样 VS 2022 全都带着，但都不在 PATH 里：
     cl.exe   → 要先 call vcvars64.bat，连 INCLUDE/LIB 一起导入才能用
     cmake    → Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin
     ninja    → Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja
     libclang → 本机没装 LLVM，放仓库的 tools\libclang\bin

   所以 npm run dev / build 先过这个脚本。找不到 VS 时原样放行，不拦日常开发：
   环境本来就对的外壳（比如开发者命令行）直接跑就行。

   用法：node scripts/msvc-env.mjs <命令> [参数...]        */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function log(message) {
  console.log(`[env] ${message}`);
}

function vswhere() {
  const exe = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (!fs.existsSync(exe)) return null;
  const run = spawnSync(exe, ["-latest", "-products", "*", "-property", "installationPath"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const dir = (run.stdout || "").trim();
  return dir && fs.existsSync(dir) ? dir : null;
}

/* vcvars64.bat 只能靠 cmd 跑，而 cmd 的嵌套引号在 Node 这边怎么拼都容易翻车。
   它做的事无非是把这三组路径摆好，那就照着目录自己摆：
     PATH   ← cl.exe 所在的 Hostx64\x64
     INCLUDE← MSVC 的 include + Windows SDK 的 ucrt/um/shared/winrt
     LIB    ← MSVC 的 lib\x64 + SDK 的 ucrt\x64、um\x64
   Ninja 是裸生成器，不会自己搭环境，少一条 CMake 就报「cl 不能编译简单测试程序」。*/
function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function highest(candidates) {
  return candidates.sort((a, b) => {
    const pa = a.split(/[._]/).map((n) => Number(n) || 0);
    const pb = b.split(/[._]/).map((n) => Number(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    }
    return 0;
  })[0];
}

function buildMsvcEnv(vsDir) {
  const msvcRoot = path.join(vsDir, "VC", "Tools", "MSVC");
  const msvc = highest(listDirs(msvcRoot));
  if (!msvc) return null;

  const kits = "C:\\Program Files (x86)\\Windows Kits\\10";
  const sdk = highest(listDirs(path.join(kits, "Include")));
  const bin = path.join(msvcRoot, msvc, "bin", "Hostx64", "x64");
  if (!fs.existsSync(path.join(bin, "cl.exe"))) return null;

  const include = [path.join(msvcRoot, msvc, "include")];
  const lib = [path.join(msvcRoot, msvc, "lib", "x64")];
  if (sdk) {
    for (const part of ["ucrt", "um", "shared", "winrt", "crt\\10254"]) {
      const dir = path.join(kits, "Include", sdk, part);
      if (fs.existsSync(dir)) include.push(dir);
    }
    for (const part of ["ucrt", "um"]) {
      const dir = path.join(kits, "Lib", sdk, part, "x64");
      if (fs.existsSync(dir)) lib.push(dir);
    }
  } else {
    log("警告：没找到 Windows 10 SDK 的 Include 目录，CMake 大概率过不去。");
  }

  const sep = ";";
  return {
    PATH: [bin, ...(process.env.PATH ? [process.env.PATH] : [])].join(sep),
    INCLUDE: include.join(sep),
    LIB: lib.join(sep),
    LIBPATH: lib.join(sep),
    VS_DIR: vsDir,
    MSVC_VERSION: msvc,
    WINDOWS_SDK_VERSION: sdk || "",
  };
}

function prependPath(env, dirs) {
  const existing = env.PATH || env.Path || "";
  const parts = existing.split(path.delimiter).filter(Boolean);
  const head = dirs.filter((d) => fs.existsSync(d) && !parts.includes(d));
  env.PATH = [...head, ...parts].join(path.delimiter);
  delete env.Path;
  return head;
}

function resolveCommand(cmd) {
  if (cmd.includes(path.sep) || cmd.includes("/")) return cmd;
  // npm 把 node_modules\.bin 放进 PATH，但那是 .cmd，Node 自己不会这么找
  const local = path.join(ROOT, "node_modules", ".bin", `${cmd}.cmd`);
  return fs.existsSync(local) ? local : cmd;
}

/* shell:true 下路径里的空格会被当参数分开，先自己裹起来 */
function quoteForShell(value) {
  return /[\s"^&|<>]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
function main(argv) {
  const env = { ...process.env };

  const vsDir = vswhere();
  if (!vsDir) {
    log("没找到 Visual Studio，原样放行。");
  } else {
    const msvc = buildMsvcEnv(vsDir);
    if (msvc) {
      for (const [key, value] of Object.entries(msvc)) env[key] = value;
      prependPath(env, [
        path.join(vsDir, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin"),
        path.join(vsDir, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "Ninja"),
      ]);
      log(
        `VS ${path.basename(vsDir)}：MSVC ${msvc.MSVC_VERSION}、SDK ${msvc.WINDOWS_SDK_VERSION || "无"}、` +
          "cl/cmake/ninja 已就位"
      );
    } else {
      log("找到了 VS，但凑不出 cl.exe 和 SDK 路径，只补 cmake/ninja。");
      prependPath(env, [
        path.join(vsDir, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin"),
        path.join(vsDir, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "Ninja"),
      ]);
    }
  }

  // bindgen 靠这个找 libclang，缺了它 build.rs 里那句 generate().unwrap() 直接炸
  const clangBin = path.join(ROOT, "tools", "libclang", "bin");
  if (fs.existsSync(path.join(clangBin, "libclang.dll"))) {
    env.LIBCLANG_PATH = clangBin;
    log(`libclang：${clangBin}`);
  } else if (!env.LIBCLANG_PATH) {
    log(`警告：${clangBin} 下没有 libclang.dll，编译 C++ 绑定会失败。`);
  }

  // 4080 SUPER 是 sm_89；不给的话 CMake 按 ggml 的默认架构编，跑不满新卡
  if (!env.CUDA_COMPUTE_CAP) env.CUDA_COMPUTE_CAP = "89";

  const [cmd, ...rest] = argv;
  if (!cmd) {
    console.error("用法：node scripts/msvc-env.mjs <命令> [参数...]");
    process.exit(2);
  }
  const spawned = spawn([resolveCommand(cmd), ...rest].map(quoteForShell).join(" "), {
    stdio: "inherit",
    env,
    shell: true,
  });
  spawned.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  spawned.on("error", (error) => {
    console.error(`[env] 起不来 ${cmd}：${error.message}`);
    process.exit(1);
  });
}

main(process.argv.slice(2));
