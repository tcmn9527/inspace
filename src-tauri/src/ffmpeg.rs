/* ffmpeg 相关：找到它、问一个视频文件里装的是什么编码。
 *
 * 应用不假设用户装过任何播放器，所以找的顺序是：
 *   打包内置资源 → 用户按教程解压的组件目录 → PATH
 * 每一档都真跑一次 `-version` 确认起得来，光看文件在不在会被解压了一半的目录骗到。
 * 全找不到时不硬拦：照样让用户试播，播不出来再给教程。 */

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::Manager;

/// 用户按教程把 ffmpeg.exe 解压到这里（相对 app_data_dir）。
/// 打包内置的那一档也认这个相对路径，所以 tauri.conf 里 resources 要摆成同样的形状。
pub const COMPONENTS_DIR: &str = "components/ffmpeg";

fn components_path(base: PathBuf) -> PathBuf {
    base.join("components").join("ffmpeg")
}

/// 这些音轨能不能出声全看系统里有没有对应解码器，WebView2 不包办。
/// 实测：AC3 在装了 Media Foundation 解码的 Windows 上能响，DTS/TrueHD 一类多半不行，
/// 所以只当「播不出声时优先怀疑」的名单，不在拖入阶段就报警。
const SYSTEM_DECODER_AUDIO: [&str; 6] = ["ac3", "eac3", "dts", "truehd", "wmav1", "wmav2"];

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：不然每次探测都闪一个黑框
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&out.stderr).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stdout));
    Some(text)
}

/// `ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright ...` → `6.1.1-full_build-www.gyan.dev`
fn version_of(program: &str) -> Option<String> {
    let text = run(program, &["-version"])?;
    let line = text.lines().next()?;
    let at = line.find("version ")?;
    line[at + "version ".len()..]
        .split_whitespace()
        .next()
        .map(|v| v.to_string())
}

/// 找到了返回 (来源, 可执行文件, 版本号)。
fn locate(app: &tauri::AppHandle) -> Option<(&'static str, PathBuf, String)> {
    let mut local: Vec<(&'static str, PathBuf)> = Vec::new();
    if let Ok(dir) = app.path().resolve(
        COMPONENTS_DIR,
        tauri::path::BaseDirectory::Resource,
    ) {
        local.push(("bundled", dir.join(exe_name())));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        local.push(("components", components_path(dir).join(exe_name())));
    }
    for (source, path) in local {
        if !path.is_file() {
            continue;
        }
        if let Some(version) = version_of(&path.to_string_lossy()) {
            return Some((source, path, version));
        }
    }
    // 最后一档交给系统 PATH 解析，开发机上方便，装到别人电脑上多半落空
    let version = version_of("ffmpeg")?;
    Some(("path", PathBuf::from("ffmpeg"), version))
}

/// 给要跑长任务的命令用：只要可执行文件路径。
pub fn executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    locate(app).map(|(_, path, _)| path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub found: bool,
    /// "bundled" | "components" | "path"
    pub source: Option<&'static str>,
    pub version: Option<String>,
    /// 教程要告诉用户把 ffmpeg.exe 放哪儿，这里给的是绝对路径
    pub components_dir: String,
}

fn components_dir(app: &tauri::AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(components_path)
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn ffmpeg_status(app: tauri::AppHandle) -> FfmpegStatus {
    let dir = components_dir(&app);
    match locate(&app) {
        Some((source, _, version)) => FfmpegStatus {
            found: true,
            source: Some(source),
            version: Some(version),
            components_dir: dir,
        },
        None => FfmpegStatus {
            found: false,
            source: None,
            version: None,
            components_dir: dir,
        },
    }
}

/// 教程的"打开文件夹"按钮：目录不存在先建好，不然 explorer 会跳到上一级去。
#[tauri::command]
pub fn ffmpeg_reveal(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map(components_path)
        .map_err(|e| format!("找不到应用数据目录：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建组件目录失败：{e}"))?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let text = dir.to_string_lossy().to_string();
        let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
        let _ = Command::new("explorer.exe")
            .raw_arg(format!("\"{text}\""))
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = dir;
    Ok(())
}

/// 一条片子的底细，前端据此决定给哪份教程、要不要转音轨。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// ffmpeg 跑通并且认出了这个文件
    pub ok: bool,
    /// "no-ffmpeg" | "unreadable"
    pub reason: Option<&'static str>,
    pub duration: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    /// "5.1(side)" / "stereo" 这类原始描述，前端只用来拼话术
    pub audio_layout: Option<String>,
    pub audio_tracks: usize,
    pub subtitle_tracks: usize,
    /// 画面是 HEVC：这台机器有没有解码器，只有真播一次才知道
    pub hevc: bool,
    /// 音轨是需要系统解码器的那几种（AC3/DTS 一类），可能出声也可能是哑巴
    pub audio_needs_check: bool,
}

fn parse_clock(text: &str) -> Option<f64> {
    let mut total = 0f64;
    for part in text.split(':') {
        total = total * 60f64 + part.parse::<f64>().ok()?;
    }
    Some(total)
}

/// `Stream #0:1(eng): Audio: ac3, 48000 Hz, 5.1(side), ...` 里取 `Audio: ` 后面那段
fn stream_body(line: &str, kind: &str) -> Option<String> {
    let at = line.find(&format!("{kind}: "))?;
    Some(line[at + kind.len() + 2..].to_string())
}

fn codec_of(body: &str) -> Option<String> {
    let head = body.split(',').next()?;
    let codec = head.split([' ', '(']).next().filter(|c| !c.is_empty())?;
    Some(codec.to_ascii_lowercase())
}

/// 声道描述：`stereo` / `mono` / `5.1(side)`。采样率那种纯数字 token 不算。
fn layout_of(body: &str) -> Option<String> {
    for token in body.split(',').map(str::trim) {
        if token == "mono" || token == "stereo" {
            return Some(token.to_string());
        }
        if token.contains('.') && token.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return Some(token.to_string());
        }
    }
    None
}

fn unreadable(reason: &'static str) -> Probe {
    Probe {
        ok: false,
        reason: Some(reason),
        duration: None,
        video_codec: None,
        audio_codec: None,
        audio_layout: None,
        audio_tracks: 0,
        subtitle_tracks: 0,
        hevc: false,
        audio_needs_check: false,
    }
}

/// `ffmpeg -i` 不给输出文件会以非 0 退出，但信息都在 stderr 里，所以看内容不看退出码。
pub fn probe(app: &tauri::AppHandle, path: &Path) -> Probe {
    let Some((_, exe, _)) = locate(app) else {
        return unreadable("no-ffmpeg");
    };
    let mut cmd = Command::new(&exe);
    cmd.args(["-hide_banner", "-i"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return unreadable("unreadable");
    };
    let mut text = String::from_utf8_lossy(&out.stderr).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stdout));
    parse_probe(&text)
}

/// 认 `ffmpeg -i` 的输出。没给输出文件时它会以非 0 退出，所以只看内容不看退出码。
fn parse_probe(text: &str) -> Probe {
    if !text.contains("Stream #") && !text.contains("Duration:") {
        return unreadable("unreadable");
    }

    let duration = text
        .find("Duration:")
        .and_then(|at| text[at..].split_whitespace().nth(1))
        .and_then(|clock| parse_clock(clock.trim_end_matches(',')));

    let mut video_codec = None;
    let mut audio_codec = None;
    let mut audio_layout = None;
    let mut audio_tracks = 0usize;
    let mut subtitle_tracks = 0usize;
    for line in text.lines().filter(|l| l.contains("Stream #")) {
        if let Some(body) = stream_body(line, "Video") {
            if video_codec.is_none() {
                video_codec = codec_of(&body);
            }
        } else if let Some(body) = stream_body(line, "Audio") {
            audio_tracks += 1;
            if audio_codec.is_none() {
                audio_codec = codec_of(&body);
                audio_layout = layout_of(&body);
            }
        } else if stream_body(line, "Subtitle").is_some() {
            subtitle_tracks += 1;
        }
    }

    let hevc = matches!(video_codec.as_deref(), Some("hevc") | Some("hvc1") | Some("hev1"));
    let audio_needs_check = audio_codec
        .as_deref()
        .is_some_and(|codec| SYSTEM_DECODER_AUDIO.contains(&codec));

    Probe {
        ok: true,
        reason: None,
        duration,
        video_codec,
        audio_codec,
        audio_layout,
        audio_tracks,
        subtitle_tracks,
        hevc,
        audio_needs_check,
    }
}

/// 最后一条非空 stderr 最有信息量，前面都是 ffmpeg 自己的横幅。
fn last_line(text: &str, fallback: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .next_back()
        .unwrap_or(fallback)
        .to_string()
}

/// 把第一条音轨转成 AAC 写到 out。`-progress pipe:1` 让我们能报真实百分比，
/// cancel 一立起就杀进程（半成品由调用方删）。返回跑完 / 被喊停 / 出错。
///
/// 它的 `-progress` 只报"跑到哪儿了"，不报总时长，所以 total 得由调用方探好递进来；
/// 递不进来就一直报 0，让前端画不定长的进度条，别装作卡在 0%。
pub fn extract_audio(
    exe: &Path,
    input: &Path,
    out: &Path,
    total: Option<f64>,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<bool, String> {
    let mut cmd = Command::new(exe);
    cmd.args([
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-progress",
        "pipe:1",
        "-i",
    ])
    .arg(input)
    .args([
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-f",
        "mp4",
        "-movflags",
        "+faststart",
    ])
    .arg(out);
    hide_console(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;

    // stderr 也得有人一直读着，不然塞满了管道会把 ffmpeg 卡在半路
    let err_pipe = child.stderr.take().expect("stderr piped");
    let err_task = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = BufReader::new(err_pipe).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).to_string()
    });

    let out_pipe = child.stdout.take().expect("stdout piped");
    let mut seconds = 0f64;
    let mut since_report = Instant::now();
    for line in BufReader::new(out_pipe).lines() {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = err_task.join();
            return Ok(false);
        }
        let Ok(line) = line else { break };
        let (key, value) = line.split_once('=').unwrap_or(("", ""));
        // out_time_ms 是 ffmpeg 的历史误名，两个都是微秒；总时长它不给，用传进来的
        if matches!(key, "out_time_us" | "out_time_ms") {
            if let Ok(micro) = value.trim().parse::<f64>() {
                seconds = micro / 1_000_000f64;
            }
        }
        if let Some(span) = total.filter(|s| *s > 0.0) {
            if since_report.elapsed().as_millis() >= 200 {
                on_progress((seconds / span).min(1.0));
                since_report = Instant::now();
            }
        }
    }

    let status = child.wait().map_err(|e| format!("等 ffmpeg 结束失败：{e}"))?;
    let err_text = err_task.join().unwrap_or_default();
    if status.success() {
        on_progress(1.0);
        Ok(true)
    } else {
        Err(last_line(&err_text, "ffmpeg 没能转出来"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 以下三段是本机 ffmpeg 6.1.1 真跑 `-i` 抓下来的输出，改解析逻辑时先照它们跑一遍。
    const AC3_MKV: &str = r#"Input #0, matroska,webm, from 'zz-ac3.mkv':
  Metadata:
    ENCODER         : Lavf60.16.100
  Duration: 00:00:06.00, start: -0.006000, bitrate: 8385 kb/s
  Stream #0:0: Video: h264 (Constrained Baseline), yuv420p(tv, bt709, progressive), 576x1024 [SAR 1:1 DAR 9:16], 30 fps, 30 tbr, 1k tbn (default)
    Metadata:
      HANDLER_NAME    : VideoHandler
      ENCODER         : Lavc60.31.102 libx264
  Stream #0:1: Audio: ac3, 44100 Hz, 5.1(side), fltp, 448 kb/s (default)
    Metadata:
      ENCODER         : Lavc60.31.102 ac3
At least one output file must be specified"#;

    const HEVC_MULTI_MKV: &str = r#"Input #0, matroska,webm, from 'zz-multi.mkv':
  Duration: 00:00:03.02, start: -0.023000, bitrate: 1957 kb/s
  Stream #0:0: Video: hevc (Main), yuv420p(tv, bt709, progressive), 576x1024 [SAR 1:1 DAR 9:16], 30 fps, 30 tbr, 1k tbn (default)
    Metadata:
      ENCODER         : Lavc60.31.102 libx265
  Stream #0:1(eng): Audio: aac (LC), 44100 Hz, stereo, fltp (default)
    Metadata:
      ENCODER         : Lavc60.31.102 aac
  Stream #0:2(chn): Audio: eac3, 48000 Hz, 5.1(side), fltp, 448 kb/s (default)
    Metadata:
      ENCODER         : Lavc60.31.102 eac3
  Stream #0:3: Subtitle: ass
    Metadata:
      ENCODER         : Lavc60.31.102 ass
At least one output file must be specified"#;

    // 手机拍的那种 mp4：音轨排在画面前面，编码名后面还挂了两层括号
    const PHONE_MP4: &str = r#"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'download.mp4':
  Duration: 00:00:39.87, start: 0.000000, bitrate: 2553 kb/s
  Stream #0:0[0x1](und): Audio: aac (HE-AACv2) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 64 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
  Stream #0:1[0x2](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 576x1024 [SAR 1:1 DAR 9:16], 2484 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
    Metadata:
      handler_name    : VideoHandler
At least one output file must be specified"#;

    #[test]
    fn reads_ac3_as_needing_check() {
        let p = parse_probe(AC3_MKV);
        assert!(p.ok);
        assert_eq!(p.video_codec.as_deref(), Some("h264"));
        assert_eq!(p.audio_codec.as_deref(), Some("ac3"));
        assert_eq!(p.audio_layout.as_deref(), Some("5.1(side)"));
        assert_eq!(p.duration, Some(6.0));
        assert_eq!(p.audio_tracks, 1);
        assert!(!p.hevc);
        assert!(p.audio_needs_check);
    }

    #[test]
    fn reads_hevc_and_counts_tracks() {
        let p = parse_probe(HEVC_MULTI_MKV);
        assert!(p.ok);
        assert!(p.hevc);
        // 默认拿第一条音轨：这条是 aac，能直接播，不该报"音轨放不出来"
        assert_eq!(p.audio_codec.as_deref(), Some("aac"));
        assert!(!p.audio_needs_check);
        assert_eq!(p.audio_tracks, 2);
        assert_eq!(p.subtitle_tracks, 1);
        assert_eq!(p.duration, Some(3.02));
    }

    #[test]
    fn reads_audio_first_mp4() {
        let p = parse_probe(PHONE_MP4);
        assert!(p.ok);
        assert_eq!(p.video_codec.as_deref(), Some("h264"));
        assert_eq!(p.audio_codec.as_deref(), Some("aac"));
        assert_eq!(p.audio_layout.as_deref(), Some("stereo"));
        assert_eq!(p.duration, Some(39.87));
        assert!(!p.audio_needs_check);
    }

    #[test]
    fn rejects_output_without_streams() {
        let p = parse_probe("ffmpeg version 6.1.1 Copyright\nAt least one output file must be specified");
        assert!(!p.ok);
        assert_eq!(p.reason, Some("unreadable"));
    }

    #[test]
    fn parses_clocks() {
        assert_eq!(parse_clock("00:00:06.00"), Some(6.0));
        assert_eq!(parse_clock("01:02:03.45"), Some(3723.45));
        assert_eq!(parse_clock("00:00:39.87"), Some(39.87));
        assert_eq!(parse_clock("N/A"), None);
    }
}
