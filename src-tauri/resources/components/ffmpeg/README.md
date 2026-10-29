# 完整版安装包用的 ffmpeg

这个目录里的 `ffmpeg.exe` 是给 **完整版** 安装包带的，瘦身版没有它。

- 怎么来：仓库根目录跑 `npm run ffmpeg:prepare`（联网下载 essentials 包，只挑 `bin\ffmpeg.exe`）。
  已经有本地文件的话：`FFMPEG_EXE=D:\ffmpeg\bin\ffmpeg.exe npm run ffmpeg:prepare`。
- 怎么进包：`npm run build:full` 会走 `src-tauri/tauri.full.conf.json`，把它原样放到安装目录的
  `components\ffmpeg\ffmpeg.exe`。后端 `ffmpeg::locate` 第一档就找这里，所以装完机直接能用。
- 别提交：`.gitignore` 已经把这个目录除了本说明以外的东西都排掉了，仓库里不该出现 100MB 的 exe。

只带 `ffmpeg.exe` 就够了：探测编码和转音轨都是它一个命令干的，`ffprobe.exe`、`ffplay.exe` 带上纯属占地方。

## 实测体积（本机 0.1.0，NSIS x64）

| 命令 | 安装包 |
| --- | --- |
| `npm run build` | 2.35 MB |
| `npm run build:full` | 43.21 MB（129 MB 的 ffmpeg.exe 压进来了） |

两个包都叫 `inspace_0.1.0_x64-setup.exe`，后跑的覆盖先跑的，要留就自己改个名。

