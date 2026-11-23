//! 生图通路：只剩「远端 API」这一条。
//!
//! 本地扩散引擎（stable-diffusion.cpp / CUDA）和本地放大模型都已移除，
//! 这里只留三件事：保存接口配置、把请求丢给后台线程、把结果按块 id 发回前端。
//!
//! 一次可以并行出几张，上限由配置里的 parallel 决定（1–10）；网络那头掐不断，
//! 「停止」只是给这一轮打上取消标志，请求回来再把这张认作废——界面先按「已取消」显示。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use image::ImageEncoder as _;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::canvas::check_item_id;
use crate::db::{self, DbState};
use crate::imageapi::{self, ApiConfig};

/// 新建面板默认参数（每一块新面板照这一套初始化，面板「更多设置」改的就是它）
const DEFAULTS_KEY: &str = "gen_defaults_api";
const DEFAULT_SIZE: i32 = 1024;
const DEFAULT_STEPS: i32 = 30;
const DEFAULT_CFG: f32 = 6.0;
/// 图生图的改动幅度默认值，跟上游那套 0.75 保持一致（API 侧只作为提示，不直接生效）
const DEFAULT_STRENGTH: f32 = 0.75;
/// 负向提示词存这么长就够，再长也是白占
const NEGATIVE_MAX: usize = 2000;
/// 尺寸上限：多数接口到 4096 就打住了
const MAX_SIDE: i32 = 4096;

/// 一族的出图默认参数：面板「更多设置」显示和修改的就是它，新建面板直接照这套初始化。
/// 现在只剩 API 一条路，所以全机只有一份，不再按模型族分。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenDefaults {
    pub width: i32,
    pub height: i32,
    pub steps: i32,
    pub cfg: f32,
    pub seed: i64,
    /// auto / t2i / i2i / edit / upscale / inpaint
    pub mode: String,
    pub strength: f32,
    pub negative: String,
    pub refine: bool,
}

impl GenDefaults {
    fn factory() -> GenDefaults {
        GenDefaults {
            width: DEFAULT_SIZE,
            height: DEFAULT_SIZE,
            steps: DEFAULT_STEPS,
            cfg: DEFAULT_CFG,
            seed: -1,
            mode: "auto".to_string(),
            strength: DEFAULT_STRENGTH,
            negative: String::new(),
            refine: false,
        }
    }
}

/// 把用户给的数收进合法范围：宽高 32 对齐，步数 / CFG / 幅度都夹在可用区间里。
fn normalize_defaults(mut value: GenDefaults) -> GenDefaults {
    let snap = |amount: i32| (amount / 32).max(1) * 32;
    value.width = snap(value.width).clamp(256, MAX_SIDE);
    value.height = snap(value.height).clamp(256, MAX_SIDE);
    value.steps = value.steps.clamp(1, 100);
    value.cfg = value.cfg.clamp(0.1, 20.0);
    if value.seed < -1 {
        value.seed = -1;
    }
    if !matches!(
        value.mode.as_str(),
        "auto" | "t2i" | "i2i" | "edit" | "upscale" | "inpaint"
    ) {
        value.mode = "auto".to_string();
    }
    value.strength = value.strength.clamp(0.0, 1.0);
    if value.negative.chars().count() > NEGATIVE_MAX {
        value.negative = value.negative.chars().take(NEGATIVE_MAX).collect();
    }
    value
}

/// 读存下来的默认参数。没存过、存坏了都回出厂值——参数坏了不该把整条路挡住。
fn read_defaults(db: &DbState) -> GenDefaults {
    let Some(conn) = db.0.lock().ok() else {
        return GenDefaults::factory();
    };
    let Some(text) = db::read_setting(&conn, DEFAULTS_KEY) else {
        return GenDefaults::factory();
    };
    serde_json::from_str::<GenDefaults>(&text)
        .map(normalize_defaults)
        .unwrap_or_else(|_| GenDefaults::factory())
}

#[derive(Clone)]
pub struct GenCore {
    /// 远端接口的配置（设置页写、出图时读）
    api: Arc<Mutex<ApiConfig>>,
    /// 正在跑的块 id -> 这一轮的取消标志。并行上限见 ApiConfig::parallel_limit。
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// 新建面板的默认参数
    defaults: Arc<Mutex<GenDefaults>>,
}

pub struct GenState(pub(crate) GenCore);

impl GenState {
    /// 设置页改完 API 配置后同步进内存缓存，下一次出图直接用新配置。
    pub fn set_api(&self, value: ApiConfig) {
        self.0.set_api(value);
    }
}

impl GenCore {
    fn api(&self) -> ApiConfig {
        self.api.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn set_api(&self, value: ApiConfig) {
        *self.api.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
    }

    fn defaults(&self) -> GenDefaults {
        self.defaults
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_defaults(&self, value: GenDefaults) {
        *self.defaults.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
    }
}

pub fn init(db: &DbState) -> GenState {
    GenState(GenCore {
        api: Arc::new(Mutex::new(imageapi::load(db))),
        jobs: Arc::new(Mutex::new(HashMap::new())),
        defaults: Arc::new(Mutex::new(read_defaults(db))),
    })
}

/* ---------- 状态 ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenStatus {
    pub busy: bool,
    /// 正在跑的块 id（并行时可能有多个）
    pub running: Vec<String>,
    /// 固定 api：这一版只有远端一条路
    pub provider: &'static str,
    /// 接口里填的模型名
    pub api_model: String,
    /// 配置缺哪样；None 表示配齐了
    pub api_problem: Option<String>,
    /// 同时最多跑几张
    pub parallel: u32,
    /// 新建面板的默认参数（面板「更多设置」读它）
    pub defaults: GenDefaults,
}

#[tauri::command]
pub fn gen_status(state: tauri::State<GenState>) -> GenStatus {
    let core = state.0.clone();
    let api = core.api();
    let running: Vec<String> = core
        .jobs
        .lock()
        .map(|jobs| jobs.keys().cloned().collect())
        .unwrap_or_default();
    GenStatus {
        busy: !running.is_empty(),
        running,
        provider: "api",
        api_model: api.model.clone(),
        api_problem: api.problem(),
        parallel: api.parallel_limit() as u32,
        defaults: core.defaults(),
    }
}

/* ---------- 出图 ---------- */

/// 起一轮出图。立刻返回，进度和成品走事件。
#[tauri::command]
pub async fn gen_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    req: GenRequest,
) -> Result<(), String> {
    let block = check_item_id(&req.block)?;
    let mode = Mode::pick(req.mode.as_deref(), req.images.len());
    if mode == Mode::Upscale {
        return Err("高清放大依赖本地放大模型，这一版已随本地引擎移除；换一档模式，或让接口那边放大".to_string());
    }
    if req.prompt.trim().is_empty() {
        return Err("提示词是空的".to_string());
    }
    let core = state.0.clone();
    let api = core.api();
    if let Some(problem) = api.problem() {
        return Err(format!("API 配置不完整：{problem}。去设置 → 图片生成里补上"));
    }
    let limit = api.parallel_limit();
    let cancel = {
        let mut jobs = core
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if jobs.contains_key(&block) {
            return Err("这块正在出图，等这一张跑完".to_string());
        }
        if jobs.len() >= limit {
            return Err(format!("API 并行已满（{limit} 个），等一个跑完再点"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(block.clone(), Arc::clone(&cancel));
        cancel
    };
    thread::spawn(move || {
        let started = Instant::now();
        /* 一条 0/0 的进度：前端拿它把「准备中…」换成「生成中…」 */
        let _ = app.emit(
            "gen-progress",
            ProgressEvent {
                block: block.clone(),
                step: 0,
                steps: 0,
                seconds: 0.0,
            },
        );
        let outcome = imageapi::generate(&api, &req, &cancel);
        if let Ok(mut jobs) = core.jobs.lock() {
            jobs.remove(&block);
        }
        let canceled = cancel.load(Ordering::Relaxed);
        emit_outcome(&app, block, outcome, started.elapsed().as_secs_f32(), canceled);
    });
    Ok(())
}

/// 停止一轮：给了块 id 就只停那一块（并行时各停各的），不给就全停。
/// 网络那头掐不断，这里只打标志位，请求回来再认这张作废。
#[tauri::command]
pub fn gen_cancel(state: tauri::State<GenState>, block: Option<String>) -> bool {
    let Ok(jobs) = state.0.jobs.lock() else {
        return false;
    };
    match block.as_deref() {
        Some(target) => match jobs.get(target) {
            Some(job) => {
                job.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        },
        None => {
            for job in jobs.values() {
                job.store(true, Ordering::Relaxed);
            }
            !jobs.is_empty()
        }
    }
}

/* ---------- 默认参数 ---------- */

/// 读新建面板的默认参数。`family` 只为兼容老调用，这一版只有一份。
#[tauri::command]
pub fn gen_defaults(state: tauri::State<GenState>, _family: Option<String>) -> GenDefaults {
    state.0.defaults()
}

/// 保存新建面板的默认参数（面板「更多设置」改动时调）。
#[tauri::command]
pub async fn gen_defaults_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    defaults: GenDefaults,
    _family: Option<String>,
) -> Result<GenDefaults, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || apply_defaults(core, app, defaults))
        .await
        .map_err(|e| format!("保存默认参数失败：{e}"))?
}

/// 恢复出厂参数。
#[tauri::command]
pub async fn gen_defaults_reset(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    _family: Option<String>,
) -> Result<GenDefaults, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || apply_defaults(core, app, GenDefaults::factory()))
        .await
        .map_err(|e| format!("恢复默认参数失败：{e}"))?
}

fn apply_defaults(
    core: GenCore,
    app: tauri::AppHandle,
    defaults: GenDefaults,
) -> Result<GenDefaults, String> {
    let next = normalize_defaults(defaults);
    let db = app.state::<DbState>();
    {
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        let text = serde_json::to_string(&next).map_err(|e| format!("参数存不下来：{e}"))?;
        db::write_setting(&conn, DEFAULTS_KEY, &text)?;
    }
    core.set_defaults(next.clone());
    Ok(next)
}

/* ---------- 请求与结果 ---------- */

/// 前端的出图请求。本地专用的几个字段（步数、CFG、种子、负向、模型族、补细节）
/// 还在收，是为了老面板、老 agent 调用不至于报错；API 这一路只读提示词、尺寸、
/// 参考图、遮罩和模式。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
/* 本地专用的字段只收不用：老面板、老 agent 调用还带着它们，留着是为了不报错 */
#[allow(dead_code)]
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
    #[serde(default)]
    pub seed: Option<i64>,
    /// 连线带上来的输入图：PNG 的 base64（`data:image/png;base64,` 前缀也吃）
    #[serde(default)]
    pub images: Vec<String>,
    /// t2i / i2i / edit / inpaint。不给就按图数定：没图是文生图，一张当底图，多张当参考。
    #[serde(default)]
    pub mode: Option<String>,
    /// 图生图改多少（0 原样 1 全改）。API 侧只作为语义提示，不直接下发。
    #[serde(default)]
    pub strength: Option<f32>,
    /// 局部重绘的遮罩：PNG 的 base64，白=重绘、黑=保留
    #[serde(default)]
    pub mask: Option<String>,
    /// 老调用会带 qwen21 / h3image，这一版忽略
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub refine: Option<bool>,
    #[serde(default)]
    pub refine_strength: Option<f32>,
}

/// 输入图的三种吃法，外加一条本地放大路（API 侧直接拒）。
#[derive(Copy, Clone, PartialEq, Eq)]
pub(crate) enum Mode {
    Text,
    /// 一张底图 + strength 重绘
    Image,
    /// 多张参考图
    Reference,
    /// 本地 ESRGAN 放大，这一版已移除，只留识别好给一句明确的报错
    Upscale,
    /// 局部重绘：一张底图 + 一张遮罩
    Inpaint,
}

impl Mode {
    pub(crate) fn pick(want: Option<&str>, count: usize) -> Mode {
        match want.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "t2i" | "text" => Mode::Text,
            "i2i" | "image" => Mode::Image,
            "edit" | "reference" => Mode::Reference,
            "upscale" => Mode::Upscale,
            "inpaint" | "redraw" => Mode::Inpaint,
            _ if count == 0 => Mode::Text,
            _ if count == 1 => Mode::Image,
            _ => Mode::Reference,
        }
    }
}

/// 解码好的一张图（RGB 三通道）。
pub(crate) struct Out {
    pub width: u32,
    pub height: u32,
    pub channel: u32,
    pub pixels: Vec<u8>,
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

/// 一轮的结果统一从这儿发出去。
fn emit_outcome(
    app: &tauri::AppHandle,
    block: String,
    outcome: Result<Out, String>,
    seconds: f32,
    canceled: bool,
) {
    match outcome {
        /* 请求回来时用户已经点了停止：这张作废，别再显示成成品 */
        Ok(_) if canceled => {
            let _ = app.emit(
                "gen-failed",
                FailEvent {
                    block,
                    error: "已取消".to_string(),
                    canceled: true,
                },
            );
        }
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

/// 像素缓冲编成 PNG 的 data URL，交给前端直接塞进 <img>。
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
