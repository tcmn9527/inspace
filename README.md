# 无限空间 (inspace)

一个基于 Tauri v2 的桌面应用：Markdown 笔记加一块可无限扩展的画布，数据全部存在本机。

前端是原生 ES 模块 + Vite，没有引入框架；后端在 `src-tauri/`，负责文件存储、媒体导入、电子书解析等。

## 功能

- **画布**（打开应用就是它）
  - 多份画布文件，相机缩放/平移位置会记住。
  - 图元：图片、音频、视频、任意文件、笔记、便签、电子书（epub/mobi）、文本框、方框、连线。
  - 拖入文件时选择「拷贝进画布」或「引用原文件」；引用的 `.md` 在画布内编辑会写回原文件。
  - 复制粘贴出来的块各带一份自己的副本，改新的不动旧的。
  - 右下角鸟瞰窗跳视、左下角坐标条、拖动吸附对齐。
  - 删除媒体副本走系统回收站。
- **笔记**：Markdown 编辑器，图片可拖入插入。
- **本地数据**：笔记、画布共用一个数据根目录，默认在应用数据目录下的 `data/`，可在设置页整体更换（支持搬运并显示进度）。

## 开发

需要 Node.js 18+、Rust stable，以及 Tauri 在 Windows 上的构建依赖（WebView2、MSVC 工具链）。

```bash
npm install
npm run tauri dev      # 开发模式，Vite 端口 1430
npm run build          # 打包（不含 ffmpeg 组件）
npm run ffmpeg:prepare # 下载 ffmpeg 组件到 src-tauri/resources/components/ffmpeg
npm run build:full     # 内置 ffmpeg 的完整安装包
```

## 目录

```
src/                 前端
  views/             各页面与画布图元/交互
  styles.css         全部样式
src-tauri/           Rust 后端
  src/canvas.rs      画布读写、媒体与文件命令
  src/ebook.rs       epub/mobi 解析
  src/store.rs       数据根目录与迁移
  src/notes.rs       Markdown 笔记
scripts/             构建辅助脚本
```

## 安装包

Releases 里提供两个 Windows x64 安装包：普通版需要系统里能装 WebView2（Win10/11 一般自带），完整版内置 ffmpeg 组件，拖入视频后无需额外配置。首次打开如果提示缺少 WebView2，装一下微软的运行时即可。

## 许可证

[MIT](LICENSE)
