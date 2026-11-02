//! 生图面板的引擎通路：一个常驻 sd_ctx，一次只出一张。
//!
//! 为什么不用高层封装：它每次出图都 free 掉再重建 ctx，等于每点一次「开始」
//! 把 6GB 权重从盘上重读一遍。
//!
//! 显存走 P0 验过的卸载档（权重住内存条、按 max_vram 现搬上卡）：
//! 峰值 8986 MiB / 29.7 秒一张，和全塞显存（15393 MiB / 29.3 秒）像素逐字节相同，
//! 省下的 6.4GB 留给场景块的 WebGL。空闲几分钟自己放掉。

use std::ffi::{c_void, CString};
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use image::ImageEncoder as _;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::canvas::check_item_id;
use crate::sdcpp as sd;
use crate::store::{DataRoot, GEN_DIR};

const MODELS_SUB: &str = "models";
/// 首发只此一档，文件名就是下载清单（见设置页的模型管理）
const WEIGHTS: [&str; 4] = [
    "qwen_image_2.1-Q6_K.gguf",
    "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
    "mmproj-Qwen3VL-8B-Instruct-F16.gguf",
    "qwen_image_2.1_vae_bf16.safetensors",
];
/// 显存预算（GiB）：留出的那一截是给 three.js 的
const VRAM_BUDGET: &str = "12";
const IDLE_UNLOAD: Duration = Duration::from_secs(300);
const IDLE_POLL: Duration = Duration::from_secs(10);

const DEFAULT_SIZE: i32 = 1024;
const DEFAULT_STEPS: i32 = 20;
const DEFAULT_CFG: f32 = 6.0;
/// 面板上的图最短的一条边也得有这个数，再小就是糊的
const PREVIEW_MAX: u32 = 256;

/// 引擎给的 ctx 是裸指针，Rust 不知道它能不能跨线程。包一层并替它担保：
/// 只有 busy 的那条工作线程会使唤它，取消和卸载都在这把锁里判过 busy。
struct Ctx(*mut sd::sd_ctx_t);

unsafe impl Send for Ctx {}

/// 引擎本体。
struct Engine {
    ctx: *mut sd::sd_ctx_t,
    busy: bool,
    last_used: Instant,
}

unsafe impl Send for Engine {}

#[derive(Clone)]
pub struct GenCore {
    data: DataRoot,
    engine: Arc<Mutex<Engine>>,
    /// 「这一轮别再跑了」的意愿。冷加载权重那一两分钟锁被人占着，
    /// 停止只能靠这个标志位传话，不能去等锁。
    cancel: Arc<AtomicBool>,
}

pub struct GenState(GenCore);

impl GenCore {
    fn lock(&self) -> std::sync::MutexGuard<'_, Engine> {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn models(&self) -> PathBuf {
        self.data.dir(GEN_DIR).join(MODELS_SUB)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenStatus {
    pub loaded: bool,
    pub busy: bool,
    pub models_dir: String,
    pub missing: Vec<String>,
    pub idle_minutes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenRequest {
    /// 出图结果按这个块 id 路由事件
    pub block: String,
    pub prompt: String,
    #[serde(default)]
    pub negative: Option<String>,
    #[serde(default)]
    pub width: Option<i32>,
    #[serde(default)]
    pub height: Option<i32>,
    #[serde(default)]
    pub steps: Option<i32>,
    #[serde(default)]
    pub cfg: Option<f32>,
    /// 不给就是每张换一个（-1 在引擎里是随机哨兵）
    #[serde(default)]
    pub seed: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    block: String,
    step: i32,
    steps: i32,
    seconds: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreviewEvent {
    block: String,
    step: i32,
    steps: i32,
    /// 逐步预览：data:image/png;base64,…，尺寸由引擎给（latent 投影出来的小图）
    data_url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    block: String,
    width: u32,
    height: u32,
    seconds: f32,
    data_url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FailEvent {
    block: String,
    error: String,
    /// 按停止导致的收尾不算失败，前端要显示「已取消」而不是红字
    canceled: bool,
}

/// 回调是 C 函数指针，只能带一个 data 进去：这两张图共用一份。
struct Sink {
    app: tauri::AppHandle,
    block: String,
}

pub fn init(data: DataRoot) -> GenState {
    let core = GenCore {
        data,
        engine: Arc::new(Mutex::new(Engine {
            ctx: null_mut(),
            busy: false,
            last_used: Instant::now(),
        })),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    // 引擎自己的日志：只放行警告和错误，INFO 一步刷几十行会把开发台埋了
    unsafe {
        sd::sd_set_log_callback(Some(on_log), null_mut());
    }
    // 空闲放权重：不是一条命令能办的事，得有个一直在旁边看的线程
    {
        let watcher = core.clone();
        thread::spawn(move || loop {
            thread::sleep(IDLE_POLL);
            let mut engine = watcher.lock();
            if engine.busy || engine.ctx.is_null() {
                continue;
            }
            if engine.last_used.elapsed() < IDLE_UNLOAD {
                continue;
            }
            unsafe { sd::free_sd_ctx(engine.ctx) };
            engine.ctx = null_mut();
        });
    }
    GenState(core)
}

#[tauri::command]
pub fn gen_status(state: tauri::State<GenState>) -> GenStatus {
    let core = state.0.clone();
    /* 锁被「载入权重」占着的时候不能等：等就是卡界面。占着就说明这一轮正在起。 */
    let engine = core.engine.try_lock();
    let (loaded, busy) = match &engine {
        Ok(engine) => (!engine.ctx.is_null(), engine.busy),
        Err(_) => (false, true),
    };
    drop(engine);
    GenStatus {
        loaded,
        busy,
        models_dir: core.models().display().to_string(),
        missing: missing_weights(&core.models()),
        idle_minutes: IDLE_UNLOAD.as_secs() / 60,
    }
}

/// 起一轮出图。立刻返回，进度和成品走事件。
#[tauri::command]
pub async fn gen_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    req: GenRequest,
) -> Result<(), String> {
    let block = check_item_id(&req.block)?;
    if req.prompt.trim().is_empty() {
        return Err("提示词是空的".to_string());
    }
    let core = state.0.clone();
    /* 头一次点「开始」要把十几 GB 权重从盘上读进来，得一两分钟。
       这一趟必须在别的线程上等：留在 UI 线程上，整个窗口跟着冻死。 */
    tauri::async_runtime::spawn_blocking(move || begin(core, app, req, block))
        .await
        .map_err(|e| format!("出图任务起不来：{e}"))?
}

fn begin(core: GenCore, app: tauri::AppHandle, req: GenRequest, block: String) -> Result<(), String> {
    let ctx = {
        let mut engine = core.lock();
        /* 一次一张：正在出图时再点「开始」不排队、不打断，直接回绝 */
        if engine.busy {
            return Err("正在出图，等这一张跑完".to_string());
        }
        /* 先认领再加载：加载这一两分钟里 busy 得是真的，
           否则「停止」和第二次「开始」都看不出有人在干活 */
        engine.busy = true;
        core.cancel.store(false, Ordering::Relaxed);
        let ctx = match ensure_ctx(&core, &mut engine) {
            Ok(ctx) => ctx,
            Err(error) => {
                engine.busy = false;
                return Err(error);
            }
        };
        engine.last_used = Instant::now();
        ctx
    };
    /* 载入权重的那几分钟里按了停止：这一轮就别起了 */
    if core.cancel.load(Ordering::Relaxed) {
        core.lock().busy = false;
        return Err("已取消".to_string());
    }
    let handle = Ctx(ctx);
    thread::spawn(move || run_job(core, app, handle, req, block));
    Ok(())
}

/// 停止这一轮。这里不碰那把锁——它正被「载入权重」占着的时候，等锁就是卡界面。
#[tauri::command]
pub fn gen_cancel(state: tauri::State<GenState>) -> bool {
    let core = state.0.clone();
    if !core.engine.try_lock().map(|engine| engine.busy).unwrap_or(true) {
        return false;
    }
    core.cancel.store(true, Ordering::Relaxed);
    /* 引擎已经起来了就直接掐；还在载入就只留标志位，begin() 一出来自己收 */
    if let Ok(engine) = core.engine.try_lock() {
        if !engine.ctx.is_null() {
            unsafe { sd::sd_cancel_generation(engine.ctx, sd::sd_cancel_mode_t::SD_CANCEL_ALL) };
        }
    }
    true
}

/// 权重是惰性的：new_sd_ctx 只登记，真正搬上卡发生在第一次出图里。
fn ensure_ctx(core: &GenCore, engine: &mut Engine) -> Result<*mut sd::sd_ctx_t, String> {
    if !engine.ctx.is_null() {
        return Ok(engine.ctx);
    }
    let dir = core.models();
    let missing = missing_weights(&dir);
    if !missing.is_empty() {
        return Err(format!("权重还没下全，缺：{}", missing.join("、")));
    }
    // 这几条 CString 必须活到 new_sd_ctx 返回之后，所以只能在栈上捏着
    let diffusion = cpath(&dir.join(WEIGHTS[0]));
    let encoder = cpath(&dir.join(WEIGHTS[1]));
    let vision = cpath(&dir.join(WEIGHTS[2]));
    let vae = cpath(&dir.join(WEIGHTS[3]));
    let budget = CString::new(VRAM_BUDGET).expect("常量串");
    let backend = CString::new("cpu").expect("常量串");
    unsafe {
        let mut raw = std::mem::MaybeUninit::<sd::sd_ctx_params_t>::uninit();
        sd::sd_ctx_params_init(raw.as_mut_ptr());
        let mut params = raw.assume_init();
        params.diffusion_model_path = diffusion.as_ptr();
        params.llm_path = encoder.as_ptr();
        params.llm_vision_path = vision.as_ptr();
        params.vae_path = vae.as_ptr();
        params.flash_attn = true;
        params.max_vram = budget.as_ptr();
        params.params_backend = backend.as_ptr();
        let ctx = sd::new_sd_ctx(&params);
        if ctx.is_null() {
            return Err("引擎起不来：new_sd_ctx 返回空，看后端日志".to_string());
        }
        engine.ctx = ctx;
        Ok(ctx)
    }
}

fn run_job(
    core: GenCore,
    app: tauri::AppHandle,
    ctx: Ctx,
    req: GenRequest,
    block: String,
) {
    let sink = Sink {
        app: app.clone(),
        block: block.clone(),
    };
    let sink_ptr = &sink as *const Sink as *mut c_void;
    let started = Instant::now();
    let outcome = unsafe {
        sd::sd_set_progress_callback(Some(on_progress), sink_ptr);
        // proj 模式是 latent 到 RGB 的一次线性投影，Qwen 2.1 有现成的投影表，
        // 不用多下一个预览用的小 VAE，代价几乎看不出来
        sd::sd_set_preview_callback(
            Some(on_preview),
            sd::preview_t::PREVIEW_PROJ,
            1,
            true,
            false,
            sink_ptr,
        );
        let out = generate(ctx, &req);
        sd::sd_set_progress_callback(None, null_mut());
        sd::sd_set_preview_callback(
            None,
            sd::preview_t::PREVIEW_NONE,
            1,
            false,
            false,
            null_mut(),
        );
        out
    };
    let canceled = core.cancel.load(Ordering::Relaxed);
    {
        let mut engine = core.lock();
        engine.busy = false;
        engine.last_used = Instant::now();
    }
    let seconds = started.elapsed().as_secs_f32();
    match outcome {
        Ok(image) => {
            let _ = app.emit(
                "gen-done",
                DoneEvent {
                    block,
                    width: image.width,
                    height: image.height,
                    seconds,
                    data_url: png_data_url(&image.pixels, image.width, image.height, image.channel)
                        .unwrap_or_default(),
                },
            );
        }
        Err(error) => {
            let _ = app.emit(
                "gen-failed",
                FailEvent {
                    block,
                    error,
                    canceled,
                },
            );
        }
    }
}

struct Out {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    channel: u32,
}

fn generate(ctx: Ctx, req: &GenRequest) -> Result<Out, String> {
    let prompt = cstring(&req.prompt)?;
    let negative = cstring(req.negative.as_deref().unwrap_or(""))?;
    let (width, height) = fit_size(req.width, req.height);
    let steps = req.steps.unwrap_or(DEFAULT_STEPS).clamp(1, 100);
    let cfg = req.cfg.unwrap_or(DEFAULT_CFG).clamp(1.0, 20.0);
    let method = sd::sample_method_t::EULER_SAMPLE_METHOD;

    let mut raw = std::mem::MaybeUninit::<sd::sd_img_gen_params_t>::uninit();
    unsafe {
        sd::sd_img_gen_params_init(raw.as_mut_ptr());
        let mut params = raw.assume_init();
        params.prompt = prompt.as_ptr();
        params.negative_prompt = negative.as_ptr();
        params.width = width;
        params.height = height;
        params.seed = req.seed.unwrap_or(-1);
        params.batch_count = 1;
        params.sample_params.sample_method = method;
        params.sample_params.scheduler = sd::sd_get_default_scheduler(ctx.0, method);
        params.sample_params.sample_steps = steps;
        params.sample_params.guidance.txt_cfg = cfg;
        // flow_shift / eta / img_cfg 留着不动：它们的默认值是 INFINITY，
        // 意思是「按分辨率自己选流程」。手写死会把 sigma 调度整个带偏，出来灰糊糊一片。

        let mut result: *mut sd::sd_image_generation_result_t = null_mut();
        if !sd::generate_image(ctx.0, &params, &mut result) || result.is_null() {
            return Err("出图失败".to_string());
        }
        let batch = &*result;
        let item = batch
            .items
            .as_ref()
            .ok_or_else(|| "出图失败：结果里没有图".to_string())?;
        let image = &item.image;
        let channel = image.channel;
        let len = (image.width * image.height * channel) as usize;
        if image.data.is_null() || len == 0 {
            sd::free_sd_image_generation_result(result);
            return Err("出图失败：结果是空的".to_string());
        }
        let out = Out {
            // 必须拷：free_sd_image_generation_result 一跑，这份像素就没了
            pixels: std::slice::from_raw_parts(image.data, len).to_vec(),
            width: image.width,
            height: image.height,
            channel,
        };
        sd::free_sd_image_generation_result(result);
        Ok(out)
    }
}

unsafe extern "C" fn on_log(level: sd::sd_log_level_t, text: *const i8, _data: *mut c_void) {
    if level as i32 > sd::sd_log_level_t::SD_LOG_WARN as i32 {
        return;
    }
    let text = unsafe { std::ffi::CStr::from_ptr(text) };
    eprintln!("[gen] {}", text.to_string_lossy().trim_end());
}

unsafe extern "C" fn on_progress(step: i32, steps: i32, time: f32, data: *mut c_void) {
    let sink = unsafe { &*(data as *const Sink) };
    // 引擎的 step 从 0 起，time 是上一步花了多久
    let _ = sink.app.emit(
        "gen-progress",
        ProgressEvent {
            block: sink.block.clone(),
            step: step + 1,
            steps,
            seconds: time,
        },
    );
}

unsafe extern "C" fn on_preview(
    step: i32,
    frame_count: i32,
    frames: *mut sd::sd_image_t,
    _is_noisy: bool,
    data: *mut c_void,
) {
    if frame_count <= 0 || frames.is_null() {
        return;
    }
    let sink = unsafe { &*(data as *const Sink) };
    let frame = unsafe { *frames };
    if frame.data.is_null() || frame.width == 0 || frame.height == 0 {
        return;
    }
    let len = (frame.width * frame.height * frame.channel) as usize;
    let pixels = unsafe { std::slice::from_raw_parts(frame.data, len) };
    // 回调里分配的像素在返回后就被引擎 free 了，所以编码要在这一步做完
    let Some(scaled) = shrink(pixels, frame.width, frame.height, frame.channel) else {
        return;
    };
    let Some(url) = png_data_url(&scaled.0, scaled.1, scaled.2, scaled.3) else {
        return;
    };
    let info = unsafe { sd::sd_get_preview_info() };
    let _ = sink.app.emit(
        "gen-preview",
        PreviewEvent {
            block: sink.block.clone(),
            step: step.abs(),
            steps: info.total_steps.max(1),
            data_url: url,
        },
    );
}

/// 投影出来的预览本来就是 latent 尺度（1024 出图约 64×64），一般不用再缩；
/// 真遇上大帧就按最长边收到 PREVIEW_MAX，省得每步推几兆过去。
fn shrink(
    pixels: &[u8],
    width: u32,
    height: u32,
    channel: u32,
) -> Option<(Vec<u8>, u32, u32, u32)> {
    if width.max(height) <= PREVIEW_MAX {
        return Some((pixels.to_vec(), width, height, channel));
    }
    let ratio = PREVIEW_MAX as f32 / width.max(height) as f32;
    let w = ((width as f32 * ratio).round() as u32).max(1);
    let h = ((height as f32 * ratio).round() as u32).max(1);
    let mut out = Vec::with_capacity((w * h * channel) as usize);
    for y in 0..h {
        let sy = (y as f64 * height as f64 / h as f64) as u32;
        for x in 0..w {
            let sx = (x as f64 * width as f64 / w as f64) as u32;
            let from = ((sy * width + sx) * channel) as usize;
            let end = from + channel as usize;
            if end > pixels.len() {
                return None;
            }
            out.extend_from_slice(&pixels[from..end]);
        }
    }
    Some((out, w, h, channel))
}

/// Qwen-Image 2.1 出的是 RGBA（4 通道）。按 3 通道切缓冲不会报错，
/// 只会每 12 字节错位一次——出来的就是满屏重复的网点。
fn png_data_url(pixels: &[u8], width: u32, height: u32, channel: u32) -> Option<String> {
    let color = match channel {
        4 => image::ExtendedColorType::Rgba8,
        3 => image::ExtendedColorType::Rgb8,
        other => {
            eprintln!("[gen] 没见过的通道数 {other}，这张不显示");
            return None;
        }
    };
    let mut buf: Vec<u8> = Vec::new();
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(pixels, width, height, color)
        .map_err(|e| eprintln!("[gen] PNG 编码失败：{e}"))
        .ok()?;
    Some(format!("data:image/png;base64,{}", BASE64.encode(buf)))
}

/// 尺寸必须是 32 的倍数（上游文档），面板给的下拉已经满足；agent 直传时在这儿兜住。
fn fit_size(width: Option<i32>, height: Option<i32>) -> (i32, i32) {
    let snap = |value: i32| (value / 32).max(1) * 32;
    let w = snap(width.unwrap_or(DEFAULT_SIZE));
    let h = snap(height.unwrap_or(DEFAULT_SIZE));
    (w.clamp(256, 2048), h.clamp(256, 2048))
}

fn cstring(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "提示词里有不能用的字符".to_string())
}

fn cpath(path: &Path) -> CString {
    CString::new(path.as_os_str().to_string_lossy().into_owned()).expect("路径里有 0")
}

fn missing_weights(dir: &Path) -> Vec<String> {
    WEIGHTS
        .iter()
        .filter(|name| !dir.join(name).exists())
        .map(|name| (*name).to_string())
        .collect()
}
