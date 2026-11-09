/* 把客户版网页的 3D 查看器打成一个普通脚本：
   three + 插件 + 查看器全部合进去，导出时只需写一个 scene-viewer.js，
   客户双击 index.html 就能看（file:// 下不跑 ES 模块，所以不能散装 import）。
   改了 src/views/export-scene-viewer.js 之后跑一次：npm run build:viewer */

import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const viewer = fs.readFileSync("src/views/export-scene-viewer.js", "utf8");
const at = (p) => path.resolve(root, p);

const result = await build({
  stdin: {
    contents: viewer,
    resolveDir: at("src/views"),
    sourcefile: "export-scene-viewer.js",
    loader: "js",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  minify: true,
  write: false,
  plugins: [
    {
      name: "vendor-resolve",
      setup(api) {
        api.onResolve({ filter: /^\/vendor\/three\/three\.module\.js$/ }, () => ({
          path: at("src/vendor/three/three.module.js"),
        }));
        api.onResolve({ filter: /^\.\/three\.module\.js$/ }, () => ({
          path: at("src/vendor/three/three.module.js"),
        }));
        api.onResolve({ filter: /^\.\/GLTFLoader\.js$/ }, () => ({
          path: at("src/vendor/three/addons/loaders/GLTFLoader.js"),
        }));
        api.onResolve({ filter: /^\.\/SkeletonUtils\.js$/ }, () => ({
          path: at("src/vendor/three/addons/utils/SkeletonUtils.js"),
        }));
        api.onResolve({ filter: /^\.\/RoomEnvironment\.js$/ }, () => ({
          path: at("src/vendor/three/addons/environments/RoomEnvironment.js"),
        }));
      },
    },
  ],
});

const out = result.outputFiles[0].text;
fs.mkdirSync("src/vendor/web-viewer", { recursive: true });
const target = "src/vendor/web-viewer/scene-viewer.bundle.js";
fs.writeFileSync(target, out);
console.log(`viewer bundle -> ${target} (${(out.length / 1024).toFixed(0)} KB)`);
