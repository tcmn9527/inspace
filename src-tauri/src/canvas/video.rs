/* canvas::video —— 从原 canvas.rs 拆出的子模块。 */

use super::*;
use super::files::COPY_EVENT;

// ---------- 视频 ----------

/// 视频不套 base64 通道：块里放的是 asset protocol 地址，浏览器按 Range 来要片段，
/// 所以 20GB 的片子也只占几十 MB 解码缓冲，不会把整份读进内存。
pub(super) const VIDEO_DIR: &str = "video";
const VIDEO_EXTS: [&str; 5] = ["mp4", "m4v", "webm", "mkv", "mov"];
const COPY_CHUNK: usize = 8 * 1024 * 1024;
/// 攒够这么多字节报一次进度，免得事件把前端刷爆。
const COPY_REPORT_EVERY: u64 = 32 * 1024 * 1024;

fn is_video_ext(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    VIDEO_EXTS.contains(&ext.as_str())
}

pub(super) fn video_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    media_path(dir, rel, VIDEO_DIR, "视频")
}

/// 拷贝途中的临时名：只有整个写完才改名，中途停/出错一律删掉，不留半个文件。
pub(super) fn part_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string());
    dest.with_file_name(format!("{name}.part"))
}

/// 上次崩在一半留下的 .part，开工前一律扫干净。
pub(super) fn clear_parts(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_part = path
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("part"))
            .unwrap_or(false);
        if is_part {
            let _ = fs::remove_file(&path);
        }
    }
}

/// 视频文件的来源信息，前端据此问用户拷不拷。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub ext: String,
    /// 扩展名在不在支持列表。不在也别硬拦，交给浏览器试，播不了再提示。
    pub known: bool,
}

fn describe_video(path: &Path) -> Result<VideoInfo, String> {
    let meta = fs::metadata(path).map_err(|_| "视频文件不在了".to_string())?;
    if meta.len() == 0 {
        return Err("视频是空的".to_string());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名视频".to_string());
    Ok(VideoInfo {
        path: path.to_string_lossy().to_string(),
        name,
        size: meta.len(),
        known: is_video_ext(&ext),
        ext,
    })
}

#[tauri::command]
pub fn canvas_video_info(path: String) -> Result<VideoInfo, String> {
    describe_video(Path::new(&path))
}

/// 用系统文件框选一个视频，只返回来源信息（拷不拷由前端问用户）。取消返回 null。
#[tauri::command]
pub async fn canvas_pick_video(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<VideoInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择视频")
        .set_parent(&window)
        .add_filter("视频", &VIDEO_EXTS)
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    describe_video(&path).map(Some)
}

/// 正在进行的拷贝：任务号 → 取消标志。前端随时能喊停。
#[derive(Default)]
pub struct VideoCopyJobs {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl VideoCopyJobs {
    pub(super) fn register(&self, job: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.flags.lock() {
            map.insert(job.to_string(), Arc::clone(&flag));
        }
        flag
    }

    pub(super) fn finish(&self, job: &str) {
        if let Ok(mut map) = self.flags.lock() {
            map.remove(job);
        }
    }

    pub fn cancel(&self, job: &str) -> bool {
        let map = match self.flags.lock() {
            Ok(map) => map,
            Err(_) => return false,
        };
        match map.get(job) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoCopyProgress {
    job: String,
    /// progress | done | cancelled | error
    phase: String,
    copied: u64,
    total: u64,
    /// done 时才非空：画布里的相对路径。
    rel: String,
    name: String,
    error: String,
}

fn emit_copy(app: &tauri::AppHandle, payload: VideoCopyProgress) {
    if let Err(e) = app.emit(COPY_EVENT, payload) {
        eprintln!("[copy] 拷贝进度事件发送失败：{e}");
    }
}

/// 把视频拷进画布目录。后台线程跑，立刻返回任务号，进度走 canvas-video-copy 事件。
#[tauri::command]
pub fn canvas_copy_video(
    id: String,
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
    jobs: tauri::State<'_, Arc<VideoCopyJobs>>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    let src = PathBuf::from(&path);
    let info = describe_video(&src)?;
    if !info.known {
        return Err("不是支持的视频格式".to_string());
    }
    let video_dir = dir.join(VIDEO_DIR);
    fs::create_dir_all(&video_dir).map_err(|e| format!("创建视频目录失败：{e}"))?;
    clear_parts(&video_dir);
    let dest = unique_media_path(&video_dir, &info.ext);
    let job = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "视频文件名不合法".to_string())?;
    let rel = format!("{VIDEO_DIR}/{job}");
    let flag = jobs.register(&job);
    let jobs = Arc::clone(&*jobs);
    let part = part_path(&dest);
    let total = info.size;
    let name = info.name;
    let thread_job = job.clone();
    std::thread::spawn(move || {
        copy_stream(
            &app, &src, &part, &dest, &thread_job, &rel, &name, total, &flag, "视频",
        );
        jobs.finish(&thread_job);
    });
    Ok(job)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn copy_stream(
    app: &tauri::AppHandle,
    src: &Path,
    part: &Path,
    dest: &Path,
    job: &str,
    rel: &str,
    name: &str,
    total: u64,
    flag: &AtomicBool,
    kind: &str,
) {
    let report = |phase: &str, copied: u64, error: String| {
        emit_copy(
            app,
            VideoCopyProgress {
                job: job.to_string(),
                phase: phase.to_string(),
                copied,
                total,
                rel: if phase == "done" { rel.to_string() } else { String::new() },
                name: name.to_string(),
                error,
            },
        );
    };
    // 半截文件一律当场删掉，磁盘上不会留下看不懂的残骸
    let abandon = |phase: &str, copied: u64, error: String| {
        let _ = fs::remove_file(part);
        report(phase, copied, error);
    };

    let mut input = match fs::File::open(src) {
        Ok(file) => file,
        Err(e) => {
            abandon("error", 0, format!("打开{kind}失败：{e}"));
            return;
        }
    };
    let mut output = match fs::File::create(part) {
        Ok(file) => file,
        Err(e) => {
            abandon("error", 0, format!("写入失败：{e}"));
            return;
        }
    };

    let mut buffer = vec![0u8; COPY_CHUNK];
    let mut copied: u64 = 0;
    let mut since_report: u64 = 0;
    report("progress", 0, String::new());
    loop {
        if flag.load(Ordering::Relaxed) {
            drop(output);
            abandon("cancelled", copied, String::new());
            return;
        }
        let read = match input.read(&mut buffer) {
            Ok(size) => size,
            Err(e) => {
                drop(output);
                abandon("error", copied, format!("读取失败：{e}"));
                return;
            }
        };
        if read == 0 {
            break;
        }
        if let Err(e) = output.write_all(&buffer[..read]) {
            drop(output);
            abandon("error", copied, format!("写入失败：{e}"));
            return;
        }
        copied += read as u64;
        since_report += read as u64;
        if since_report >= COPY_REPORT_EVERY {
            since_report = 0;
            report("progress", copied, String::new());
        }
    }
    if let Err(e) = output.flush() {
        drop(output);
        abandon("error", copied, format!("写入失败：{e}"));
        return;
    }
    drop(output);
    if let Err(e) = fs::rename(part, dest) {
        let _ = fs::remove_file(part);
        report("error", copied, format!("整理文件失败：{e}"));
        return;
    }
    let _ = app.asset_protocol_scope().allow_file(dest);
    report("done", copied, String::new());
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AudioFixProgress {
    job: String,
    /// progress | done | cancelled | error
    phase: String,
    /// 0.0 ~ 1.0，ffmpeg 自己报的 out_time / duration
    percent: f64,
    /// done 时才非空：音轨副本在画布里的相对路径
    rel: String,
    error: String,
}

fn emit_audio(app: &tauri::AppHandle, payload: AudioFixProgress) {
    if let Err(e) = app.emit("canvas-video-audio", payload) {
        eprintln!("[video] 音轨进度事件发送失败：{e}");
    }
}

/// 音轨靠系统解码器、WebView2 播不出声时，把第一条音轨转成 AAC 存进画布，
/// 前端再拿它跟画面对声。后台线程跑，立刻返回任务号，进度走 canvas-video-audio 事件。
#[tauri::command]
pub fn canvas_audio_fix(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
    jobs: tauri::State<'_, Arc<VideoCopyJobs>>,
) -> Result<String, String> {
    let input = video_source_path(&state, &id, &src, linked)?;
    let exe = crate::ffmpeg::executable(&app).ok_or("没找到 ffmpeg")?;
    let dir = resolve_dir(&state, &id)?;
    let video_dir = dir.join(VIDEO_DIR);
    fs::create_dir_all(&video_dir).map_err(|e| format!("创建视频目录失败：{e}"))?;
    let dest = unique_media_path(&video_dir, "m4a");
    let job = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "音轨文件名不合法".to_string())?;
    let rel = format!("{VIDEO_DIR}/{job}");
    // ffmpeg 的进度输出不带总时长，这里先探一次拿时长，进度条才有分母
    let total = crate::ffmpeg::probe(&app, &input).duration;
    let flag = jobs.register(&job);
    let jobs = Arc::clone(&*jobs);
    let part = part_path(&dest);
    let thread_job = job.clone();
    std::thread::spawn(move || {
        fix_audio(
            &app, &exe, &input, &part, &dest, &thread_job, &rel, total, &flag,
        );
        jobs.finish(&thread_job);
    });
    Ok(job)
}

#[allow(clippy::too_many_arguments)]
fn fix_audio(
    app: &tauri::AppHandle,
    exe: &Path,
    input: &Path,
    part: &Path,
    dest: &Path,
    job: &str,
    rel: &str,
    total: Option<f64>,
    flag: &AtomicBool,
) {
    let send = |phase: &str, percent: f64, error: String| {
        emit_audio(
            app,
            AudioFixProgress {
                job: job.to_string(),
                phase: phase.to_string(),
                percent,
                rel: if phase == "done" { rel.to_string() } else { String::new() },
                error,
            },
        );
    };
    // 转一半的 sidecar 同样当场删掉，画布目录里不留半截文件
    let abandon = |phase: &str, error: String| {
        let _ = fs::remove_file(part);
        send(phase, 1.0, error);
    };
    send("progress", 0.0, String::new());
    match crate::ffmpeg::extract_audio(exe, input, part, total, flag, |percent| {
        send("progress", percent, String::new())
    }) {
        Ok(true) => {
            if let Err(e) = fs::rename(part, dest) {
                let _ = fs::remove_file(part);
                send("error", 1.0, format!("整理文件失败：{e}"));
                return;
            }
            let _ = app.asset_protocol_scope().allow_file(dest);
            send("done", 1.0, String::new());
        }
        Ok(false) => abandon("cancelled", String::new()),
        Err(e) => abandon("error", e),
    }
}

#[tauri::command]
pub fn canvas_cancel_video_copy(job: String, jobs: tauri::State<'_, Arc<VideoCopyJobs>>) -> bool {
    jobs.cancel(&job)
}

/// 取视频的可播放绝对路径（前端再 convertFileSrc 成 asset 地址），顺手给它开一次读权限。
/// 引用态传 linked=true，src 就是原始绝对路径。
#[tauri::command]
pub fn canvas_video_url(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let path = video_source_path(&state, &id, &src, linked)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("授权失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 引用态 src 就是原片绝对路径，拷贝态按画布目录下的相对路径找。
fn video_source_path(
    state: &CanvasState,
    id: &str,
    src: &str,
    linked: bool,
) -> Result<PathBuf, String> {
    media_source_path(state, id, src, linked, VIDEO_DIR, "视频文件")
}

/// 问 ffmpeg 这条片子装的是什么。拖入阶段还没有块，按引用态把绝对路径传进来即可。
#[tauri::command]
pub fn canvas_video_probe(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<crate::ffmpeg::Probe, String> {
    let path = video_source_path(&state, &id, &src, linked)?;
    Ok(crate::ffmpeg::probe(&app, &path))
}

/// 删视频块：拷贝进来的删画布里那份副本（原片还在用户手里）；
/// 引用态只是解除关联，绝不碰用户磁盘上的原片。
#[tauri::command]
pub fn canvas_delete_video(
    id: String,
    src: String,
    linked: bool,
    audio_rel: Option<String>,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if linked {
        return Ok(());
    }
    let dir = resolve_dir(&state, &id)?;
    /* 转出来的 AAC 副本跟着块一起走，不然画布目录里留一堆没人认领的音轨 */
    if let Some(rel) = audio_rel.filter(|r| !r.is_empty()) {
        if let Ok(path) = video_path(&dir, &rel) {
            let _ = recycle_path(&path);
        }
    }
    let path = video_path(&dir, &src)?;
    recycle_path(&path).map_err(|e| format!("删除视频失败：{e}"))
}
