//! 本地视频引擎：直接调 sd.cpp 的 `generate_video`（MiniMax-H3 等），
//! 不走任何远端。输出是「原始帧 + float PCM 音频」，用 ffmpeg 封装成 mp4。
//!
//! 权重四件套（DiT、视频 VAE、音频 VAE、文本编码器）由用户在设置里各自选文件；
//! ctx 懒加载、空闲 5 分钟释放，换配置立即释放。

use std::ffi::{c_void, CStr, CString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::db::{self, DbState};
use crate::modelscan;
use crate::sdcpp as sd;
use crate::store::{DataRoot, GEN_DIR};
use crate::videogen::{self, Core, VideoRequest};

const LOCAL_KEY: &str = "gen_video_local_config";
const IDLE_RELEASE: Duration = Duration::from_secs(300);
const IDLE_POLL: Duration = Duration::from_secs(30);
/// 本地视频最长 20 秒：帧数一多显存和时间都撑不住
const LOCAL_MAX_SECONDS: i32 = 20;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVideoConfig {
    /// 模型目录：四件套放这里，启动时自动扫描识别
    #[serde(default)]
    pub dir: String,
    /// MiniMax-H3 扩散模型（safetensors / gguf）
    #[serde(default)]
    pub diffusion: String,
    #[serde(default)]
    pub video_vae: String,
    /// 可空：不给就出无声视频
    #[serde(default)]
    pub audio_vae: String,
    /// Qwen3-VL-32B（H3 版）或 P-H3 4B 编码器
    #[serde(default)]
    pub encoder: String,
    #[serde(default = "default_fps")]
    pub fps: i32,
}

fn default_fps() -> i32 {
    24
}

impl Default for LocalVideoConfig {
    fn default() -> Self {
        LocalVideoConfig {
            dir: String::new(),
            diffusion: String::new(),
            video_vae: String::new(),
            audio_vae: String::new(),
            encoder: String::new(),
            fps: default_fps(),
        }
    }
}

impl LocalVideoConfig {
    pub fn problem(&self) -> Option<String> {
        if self.diffusion.trim().is_empty() {
            return Some("扩散模型（minimax_h3_fl2va*）还没找到".to_string());
        }
        if self.video_vae.trim().is_empty() {
            return Some("视频 VAE 还没找到".to_string());
        }
        if self.encoder.trim().is_empty() {
            return Some("文本编码器还没找到".to_string());
        }
        for (label, path) in [
            ("扩散模型", &self.diffusion),
            ("视频 VAE", &self.video_vae),
            ("文本编码器", &self.encoder),
        ] {
            if !Path::new(path.trim()).is_file() {
                return Some(format!("{label}文件不在了：{path}"));
            }
        }
        if !self.audio_vae.trim().is_empty() && !Path::new(self.audio_vae.trim()).is_file() {
            return Some(format!("音频 VAE 文件不在了：{}", self.audio_vae));
        }
        None
    }

    fn signature(&self) -> String {
        format!(
            "{}|{}|{}|{}",
            self.diffusion.trim(),
            self.video_vae.trim(),
            self.audio_vae.trim(),
            self.encoder.trim()
        )
    }
}

/// 按目录扫一遍，把四个路径填成识别结果；缺的槽位清空，避免拿旧路径骗过 problem()。
fn fill_from_scan(config: &mut LocalVideoConfig, data: &DataRoot) -> modelscan::ScanReport {
    if config.dir.trim().is_empty() {
        config.dir = modelscan::video_default_dir(data)
            .to_string_lossy()
            .to_string();
    }
    let shared = [modelscan::image_default_dir(data)];
    let report = modelscan::scan_video(Path::new(config.dir.trim()), &shared);
    for slot in &report.roles {
        let path = slot
            .file
            .as_ref()
            .map(|file| file.path.clone())
            .unwrap_or_default();
        match slot.role.as_str() {
            "diffusion" => config.diffusion = path,
            "videoVae" => config.video_vae = path,
            "audioVae" => config.audio_vae = path,
            "encoder" => config.encoder = path,
            _ => {}
        }
    }
    report
}

pub fn resolve(db: &DbState, data: &DataRoot) -> LocalVideoConfig {
    let mut config = load(db);
    fill_from_scan(&mut config, data);
    config
}

pub fn resolved_for_start(app: &tauri::AppHandle) -> LocalVideoConfig {
    resolve(&app.state::<DbState>(), &app.state::<DataRoot>())
}

pub fn load(db: &DbState) -> LocalVideoConfig {
    let Ok(conn) = db.0.lock() else {
        return LocalVideoConfig::default();
    };
    db::read_setting(&conn, LOCAL_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(db: &DbState, config: &LocalVideoConfig) -> Result<(), String> {
    let conn = db
        .0
        .lock()
        .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
    let text =
        serde_json::to_string(config).map_err(|e| format!("本地视频配置存不下来：{e}"))?;
    db::write_setting(&conn, LOCAL_KEY, &text)
}

struct CtxState {
    ctx: *mut sd::sd_ctx_t,
    last_used: Instant,
    signature: String,
}

unsafe impl Send for CtxState {}

struct Inner {
    ctx: Mutex<CtxState>,
    config: Mutex<LocalVideoConfig>,
    busy: AtomicBool,
}

pub struct LocalEngine {
    inner: Arc<Inner>,
}

impl Clone for LocalEngine {
    fn clone(&self) -> Self {
        LocalEngine {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl LocalEngine {
    pub fn config(&self) -> LocalVideoConfig {
        self.inner
            .config
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn set_config(&self, value: LocalVideoConfig) {
        let changed = self.config().signature().ne(&value.signature());
        if let Ok(mut config) = self.inner.config.lock() {
            *config = value;
        }
        if changed {
            self.release_ctx();
        }
    }

    pub fn release_ctx(&self) {
        if let Ok(mut state) = self.inner.ctx.lock() {
            if !state.ctx.is_null() {
                unsafe { sd::free_sd_ctx(state.ctx) };
                state.ctx = std::ptr::null_mut();
                state.signature.clear();
            }
        }
    }

    /// 停止这一轮：sd.cpp 的取消要在 ctx 上发；拿不到锁就只靠外层标志位。
    pub fn cancel(&self) {
        if let Ok(state) = self.inner.ctx.try_lock() {
            if !state.ctx.is_null() {
                unsafe { sd::sd_cancel_generation(state.ctx, sd::sd_cancel_mode_t::SD_CANCEL_ALL) };
            }
        }
    }
}

pub fn init(db: &DbState) -> LocalEngine {
    let engine = LocalEngine {
        inner: Arc::new(Inner {
            ctx: Mutex::new(CtxState {
                ctx: std::ptr::null_mut(),
                last_used: Instant::now(),
                signature: String::new(),
            }),
            config: Mutex::new(load(db)),
            busy: AtomicBool::new(false),
        }),
    };
    /* 空转五分钟就把视频权重放掉：十几 GB 占着内存/显存，用户可能只是试一条 */
    let watcher = engine.clone();
    thread::spawn(move || loop {
        thread::sleep(IDLE_POLL);
        if watcher.inner.busy.load(Ordering::Relaxed) {
            continue;
        }
        let Ok(mut state) = watcher.inner.ctx.try_lock() else {
            continue;
        };
        if state.ctx.is_null() {
            continue;
        }
        if state.last_used.elapsed() < IDLE_RELEASE {
            continue;
        }
        unsafe { sd::free_sd_ctx(state.ctx) };
        state.ctx = std::ptr::null_mut();
        state.signature.clear();
    });
    engine
}

/* ---------- 命令 ---------- */

#[tauri::command]
pub fn gen_video_local_get(app: tauri::AppHandle) -> serde_json::Value {
    let db = app.state::<DbState>();
    let data = app.state::<DataRoot>();
    let mut config = load(&db);
    let report = fill_from_scan(&mut config, &data);
    let default_dir = modelscan::video_default_dir(&data).to_string_lossy().to_string();
    serde_json::json!({ "config": config, "scan": report, "defaultDir": default_dir })
}

#[tauri::command]
pub fn gen_video_local_set(
    app: tauri::AppHandle,
    state: tauri::State<videogen::VideoState>,
    config: LocalVideoConfig,
) -> Result<serde_json::Value, String> {
    if state.is_busy() {
        return Err("正在出一个视频，等这一条跑完再换模型".to_string());
    }
    let data = app.state::<DataRoot>();
    let mut next = config;
    next.dir = next.dir.trim().to_string();
    next.fps = next.fps.clamp(8, 30);
    let report = fill_from_scan(&mut next, &data);
    save(&app.state::<DbState>(), &next)?;
    state.local_engine().set_config(next.clone());
    let default_dir = modelscan::video_default_dir(&data).to_string_lossy().to_string();
    Ok(serde_json::json!({ "config": next, "scan": report, "defaultDir": default_dir }))
}

#[tauri::command]
pub async fn gen_video_dir_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    app.dialog()
        .file()
        .set_title("选择视频模型文件夹")
        .set_parent(&window)
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn gen_video_dir_reveal(app: tauri::AppHandle) -> Result<String, String> {
    let data = app.state::<DataRoot>();
    let config = resolve(&app.state::<DbState>(), &data);
    let dir = PathBuf::from(config.dir.trim());
    fs::create_dir_all(&dir).map_err(|e| format!("建不出模型目录 {}：{e}", dir.display()))?;
    open::that(&dir).map_err(|e| format!("打不开模型目录：{e}"))?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn gen_video_engine_get(state: tauri::State<videogen::VideoState>) -> String {
    state.engine()
}

#[tauri::command]
pub fn gen_video_engine_set(
    app: tauri::AppHandle,
    state: tauri::State<videogen::VideoState>,
    engine: String,
) -> Result<String, String> {
    if state.is_busy() {
        return Err("正在出一个视频，等这一条跑完再换引擎".to_string());
    }
    let next = if engine == "local" { "local" } else { "api" }.to_string();
    {
        let db_state = app.state::<DbState>();
        let conn = db_state
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        db::write_setting(&conn, "gen_video_engine", &next)?;
    }
    state.set_engine(next.clone());
    let _ = tauri::Emitter::emit(
        &app,
        "inspace:gen-video-engine",
        serde_json::json!({ "engine": next }),
    );
    Ok(next)
}

/* ---------- 生成 ---------- */

struct ProgressSink {
    core: Arc<Core>,
    app: tauri::AppHandle,
    block: String,
}

unsafe extern "C" fn on_generation_progress(
    progress: *const sd::sd_generation_progress_t,
    data: *mut c_void,
) {
    if progress.is_null() || data.is_null() {
        return;
    }
    let sink = &*(data as *const ProgressSink);
    let info = &*progress;
    let stage = if info.stage.is_null() {
        String::new()
    } else {
        CStr::from_ptr(info.stage).to_string_lossy().to_string()
    };
    let label = if info.total > 0 {
        format!("{} {}/{}", stage_label(&stage), info.completed, info.total)
    } else {
        stage_label(&stage).to_string()
    };
    videogen::set_status(&sink.core, &sink.block, &label);
    videogen::emit_progress(
        &sink.app,
        &sink.block,
        "running",
        &label,
        videogen::started_secs(&sink.core, &sink.block),
    );
}

fn stage_label(stage: &str) -> &str {
    match stage {
        "" => "生成中",
        "loading" => "载入权重",
        "text_encoding" | "text_encode" => "读提示词",
        "sampling" | "denoise" => "采样",
        "vae" | "decode" | "vae_decoding" | "video_decode" => "解码",
        other => other,
    }
}

pub fn execute(core: &Arc<Core>, app: &tauri::AppHandle, req: &VideoRequest) -> Result<String, String> {
    let engine = core.local_engine();
    let config = engine.config();
    if let Some(problem) = config.problem() {
        return Err(format!("本地视频模型配置不完整：{problem}（去设置 → 视频生成里配好）"));
    }
    let block = req.block.clone();
    let (width, height) = videogen::video_size(req);
    let width = align32(width);
    let height = align32(height);
    let seconds = req.seconds.unwrap_or(5).clamp(1, LOCAL_MAX_SECONDS);
    let fps = config.fps.clamp(8, 30);
    let frames = (seconds * fps).clamp(8, LOCAL_MAX_SECONDS * 30);

    if core.cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    engine.inner.busy.store(true, Ordering::Relaxed);
    let _guard = BusyGuard(&engine);
    videogen::set_status(core, &block, "载入权重…");
    videogen::emit_progress(app, &block, "running", "载入权重…", videogen::started_secs(core, &block));

    let result = run_generate(core, app, &engine, &config, req, width, height, frames, fps);
    if let Ok(mut state) = engine.inner.ctx.lock() {
        state.last_used = Instant::now();
    }
    result
}

struct BusyGuard<'a>(&'a LocalEngine);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.inner.busy.store(false, Ordering::Relaxed);
    }
}

#[allow(clippy::too_many_arguments)]
fn run_generate(
    core: &Arc<Core>,
    app: &tauri::AppHandle,
    engine: &LocalEngine,
    config: &LocalVideoConfig,
    req: &VideoRequest,
    width: i32,
    height: i32,
    frames: i32,
    fps: i32,
) -> Result<String, String> {
    let block = &req.block;
    let ctx = ensure_ctx(engine, config)?;
    if core.cancel.load(Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    /* 首帧：和请求尺寸对齐后喂进去（H3 要求 32 对齐） */
    let init = match req
        .image
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        Some(text) => Some(decode_first_frame(text, width, height)?),
        None => None,
    };
    let prompt = CString::new(req.prompt.trim()).map_err(|_| "提示词里有非法字符".to_string())?;
    let sink = ProgressSink {
        core: Arc::clone(core),
        app: app.clone(),
        block: block.clone(),
    };
    let sink_ptr = &sink as *const ProgressSink as *mut c_void;
    unsafe {
        let mut raw = std::mem::MaybeUninit::<sd::sd_vid_gen_params_t>::uninit();
        sd::sd_vid_gen_params_init(raw.as_mut_ptr());
        let mut params = raw.assume_init();
        params.prompt = prompt.as_ptr();
        params.width = width;
        params.height = height;
        params.video_frames = frames;
        params.fps = fps;
        params.seed = -1;
        /* H3 是蒸馏模型：cfg 1.0、步数跟引擎默认；CLI 文档也是这么跑的 */
        params.sample_params.guidance.txt_cfg = 1.0;
        if let Some(image) = &init {
            params.init_image = image.raw;
        }
        sd::sd_set_generation_progress_callback(ctx, Some(on_generation_progress), sink_ptr);
        let mut out: *mut sd::sd_video_generation_result_t = std::ptr::null_mut();
        let ok = sd::generate_video(ctx, &params, &mut out);
        sd::sd_set_generation_progress_callback(ctx, None, std::ptr::null_mut());
        if !ok || out.is_null() {
            return Err("本地视频生成失败，看后端日志".to_string());
        }
        if core.cancel.load(Ordering::Relaxed) {
            sd::free_sd_video_generation_result(out);
            return Err("已取消".to_string());
        }
        let encoded = encode_mp4(core, app, out, width, height, fps);
        sd::free_sd_video_generation_result(out);
        encoded
    }
}

fn ensure_ctx(engine: &LocalEngine, config: &LocalVideoConfig) -> Result<*mut sd::sd_ctx_t, String> {
    let signature = config.signature();
    let mut state = engine
        .inner
        .ctx
        .lock()
        .map_err(|_| "本地视频引擎状态异常".to_string())?;
    if !state.ctx.is_null() && state.signature == signature {
        state.last_used = Instant::now();
        return Ok(state.ctx);
    }
    if !state.ctx.is_null() {
        unsafe { sd::free_sd_ctx(state.ctx) };
        state.ctx = std::ptr::null_mut();
    }
    let diffusion = cpath(config.diffusion.trim())?;
    let vae = cpath(config.video_vae.trim())?;
    let audio = if config.audio_vae.trim().is_empty() {
        None
    } else {
        Some(cpath(config.audio_vae.trim())?)
    };
    let encoder = cpath(config.encoder.trim())?;
    let budget = CString::new("10").expect("常量串");
    let backend = CString::new("cpu").expect("常量串");
    unsafe {
        let mut raw = std::mem::MaybeUninit::<sd::sd_ctx_params_t>::uninit();
        sd::sd_ctx_params_init(raw.as_mut_ptr());
        let mut params = raw.assume_init();
        params.diffusion_model_path = diffusion.as_ptr();
        params.vae_path = vae.as_ptr();
        if let Some(audio) = &audio {
            params.audio_vae_path = audio.as_ptr();
        }
        params.llm_path = encoder.as_ptr();
        params.flash_attn = true;
        params.diffusion_flash_attn = true;
        params.max_vram = budget.as_ptr();
        params.params_backend = backend.as_ptr();
        let ctx = sd::new_sd_ctx(&params);
        if ctx.is_null() {
            return Err("本地视频引擎起不来：new_sd_ctx 返回空，看后端日志".to_string());
        }
        state.ctx = ctx;
        state.signature = signature;
        state.last_used = Instant::now();
        Ok(ctx)
    }
}

fn cpath(path: &str) -> Result<CString, String> {
    CString::new(path).map_err(|_| format!("路径里有非法字符：{path}"))
}

fn align32(value: i32) -> i32 {
    ((value.clamp(64, 4096) + 16) / 32) * 32
}

struct InputFrame {
    /* 帧数据的所有者：raw.data 指着它，别在 generate 之前被回收 */
    _buf: Vec<u8>,
    raw: sd::sd_image_t,
}

/// 首帧解成 RGBA 并按目标尺寸缩放、居中裁切：H3 的 I2VA 要求首帧和出片同尺寸。
fn decode_first_frame(text: &str, width: i32, height: i32) -> Result<InputFrame, String> {
    let body = match text.find(',') {
        Some(at) if text.starts_with("data:") => &text[at + 1..],
        _ => text,
    };
    let bytes = BASE64
        .decode(body.trim())
        .map_err(|e| format!("首帧图不是 base64：{e}"))?;
    let decoded = image::load_from_memory(&bytes).map_err(|e| format!("首帧图解不开：{e}"))?;
    let rgba = decoded.to_rgba8();
    let (sw, sh) = rgba.dimensions();
    let scale = (width as f32 / sw as f32).max(height as f32 / sh as f32);
    let nw = ((sw as f32 * scale).round() as u32).max(width as u32);
    let nh = ((sh as f32 * scale).round() as u32).max(height as u32);
    let resized = image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Lanczos3);
    let x = (nw - width as u32) / 2;
    let y = (nh - height as u32) / 2;
    let cropped = image::imageops::crop_imm(&resized, x, y, width as u32, height as u32).to_image();
    let buf = cropped.into_raw();
    let raw = sd::sd_image_t {
        width: width as u32,
        height: height as u32,
        channel: 4,
        data: buf.as_ptr() as *mut u8,
    };
    Ok(InputFrame { _buf: buf, raw })
}

unsafe fn encode_mp4(
    core: &Arc<Core>,
    app: &tauri::AppHandle,
    result: *mut sd::sd_video_generation_result_t,
    width: i32,
    height: i32,
    fps: i32,
) -> Result<String, String> {
    let res = &*result;
    if res.frame_count <= 0 || res.frames.is_null() {
        return Err("本地视频引擎没返回帧".to_string());
    }
    let frames = std::slice::from_raw_parts(res.frames, res.frame_count as usize);
    {
        let mut nulls = 0;
        let mut total = 0u64;
        let mut sizes = std::collections::BTreeSet::new();
        for f in frames {
            if f.data.is_null() {
                nulls += 1;
            } else {
                sizes.insert((f.width, f.height, f.channel));
                total += (f.width * f.height * f.channel) as u64;
            }
        }
        eprintln!(
            "[video] 帧统计：count={} null={} 尺寸={:?} 总字节={}",
            res.frame_count, nulls, sizes, total
        );
    }
    let channel = frames[0].channel.max(1);
    let pix_fmt = if channel == 4 { "rgba" } else { "rgb24" };
    /* 尺寸以帧本身为准：引擎会把自己的对齐规则套上去，和请求值可能差一截 */
    let frame_w = frames[0].width;
    let frame_h = frames[0].height;
    let ffmpeg = crate::ffmpeg::executable(app)
        .ok_or_else(|| "没找到 ffmpeg：去设置 → 视频组件里装一下".to_string())?;
    let dir = core.data.dir(GEN_DIR).join("videos");
    fs::create_dir_all(&dir).map_err(|e| format!("创建视频缓存目录失败：{e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("{stamp}.mp4"));
    let silent = dir.join(format!("{stamp}.silent.mp4"));

    /* 音频先落成裸 f32 流；没有音频就只编画面 */
    let mut audio_file: Option<(PathBuf, u32, u32)> = None;
    if !res.audio.is_null() {
        let audio = &*res.audio;
        if !audio.data.is_null() && audio.sample_count > 0 {
            let pcm = dir.join(format!("{stamp}.pcm"));
            /* sample_count 是每声道样本数；data 是交错的 f32，字节数要把声道乘回来 */
            let bytes = std::slice::from_raw_parts(
                audio.data as *const u8,
                audio.sample_count as usize
                    * audio.channels.max(1) as usize
                    * std::mem::size_of::<f32>(),
            );
            fs::write(&pcm, bytes).map_err(|e| format!("写音频临时文件失败：{e}"))?;
            audio_file = Some((pcm, audio.sample_rate, audio.channels.max(1)));
        }
    }
    eprintln!(
        "[video] 编码：{} 帧 {}x{} ch{} {}fps，音频={:?}，ffmpeg={}",
        res.frame_count,
        frame_w,
        frame_h,
        channel,
        fps,
        audio_file.as_ref().map(|(_, rate, channels)| (*rate, *channels)),
        ffmpeg.display()
    );
    let _ = (width, height);

    /* 第一阶段：只有画面，管道不会被音频参数拖死 */
    /* 原始帧先落盘再交给 ffmpeg：长镜头把上百帧直接怼进 stdin 时，
       ffmpeg 的 rawvideo 读端会提前退出，写端就拿到 broken pipe；
       落盘后按普通文件读，长度和内存占用都可控。 */
    let raw = dir.join(format!("{stamp}.rgb"));
    {
        let mut file = fs::File::create(&raw).map_err(|e| format!("创建原始帧文件失败：{e}"))?;
        for frame in frames {
            if core.cancel.load(Ordering::Relaxed) {
                let _ = fs::remove_file(&raw);
                return Err("已取消".to_string());
            }
            if frame.data.is_null() {
                continue;
            }
            let bytes = std::slice::from_raw_parts(
                frame.data,
                (frame.width * frame.height * channel) as usize,
            );
            file.write_all(bytes)
                .map_err(|e| format!("写原始帧文件失败：{e}"))?;
        }
    }
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        pix_fmt,
        "-video_size",
        &format!("{}x{}", frame_w, frame_h),
        "-framerate",
        &fps.to_string(),
        "-i",
        raw.to_string_lossy().as_ref(),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        silent.to_string_lossy().as_ref(),
    ]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let output = cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?
        .wait_with_output()
        .map_err(|e| format!("等 ffmpeg 失败：{e}"))?;
    let _ = fs::remove_file(&raw);
    if !output.status.success() {
        let _ = fs::remove_file(&silent);
        if let Some((pcm, _, _)) = &audio_file {
            let _ = fs::remove_file(pcm);
        }
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        eprintln!("[video] ffmpeg 退出码 {:?}：{reason}", output.status.code());
        return Err(format!("ffmpeg 编码失败：{reason}"));
    }

    /* 第二阶段：有音频就混进去；混音失败也留住画面 */
    let mut final_path = silent.clone();
    if let Some((pcm, rate, channels)) = &audio_file {
        let muxed = dir.join(format!("{stamp}.mux.mp4"));
        let status = Command::new(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                silent.to_string_lossy().as_ref(),
                "-f",
                "f32le",
                "-ar",
                &rate.to_string(),
                "-ac",
                &channels.to_string(),
                "-i",
                pcm.to_string_lossy().as_ref(),
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart",
                muxed.to_string_lossy().as_ref(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("混音失败：{e}"))?;
        if status.status.success() {
            let _ = fs::remove_file(&silent);
            if fs::rename(&muxed, &dest).is_ok() {
                final_path = dest.clone();
            } else {
                final_path = muxed;
            }
        } else {
            let reason = String::from_utf8_lossy(&status.stderr).trim().to_string();
            eprintln!("[video] 混音失败，保留无声视频：{reason}");
            if fs::rename(&silent, &dest).is_ok() {
                final_path = dest.clone();
            }
            let _ = fs::remove_file(&muxed);
        }
        let _ = fs::remove_file(pcm);
    } else if fs::rename(&silent, &dest).is_ok() {
        final_path = dest.clone();
    }

    let _ = app.asset_protocol_scope().allow_file(&final_path);
    Ok(final_path.to_string_lossy().to_string())
}
