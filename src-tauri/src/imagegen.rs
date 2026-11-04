//! 生图面板的引擎通路：一个常驻 sd_ctx，一次只出一张。
//!
//! 为什么不用高层封装：它每次出图都 free 掉再重建 ctx，等于每点一次「开始」
//! 把 6GB 权重从盘上重读一遍。
//!
//! 显存走 P0 验过的卸载档（权重住内存条、按 max_vram 现搬上卡）：
//! 峰值 8986 MiB / 29.7 秒一张，和全塞显存（15393 MiB / 29.3 秒）像素逐字节相同。
//! 实测空闲那几分钟显存并不额外占（跑前跑后都是同一档），占的是内存条上那 ~15GB，
//! 所以出完 45 秒没接着画就自己放掉——连点改词还热着，停手一分钟把内存还回去。

use std::ffi::{c_void, CString};
use std::fs;
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
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::canvas::check_item_id;
use crate::db::{self, DbState};
use crate::sdcpp as sd;
use crate::store::{DataRoot, GEN_DIR};

const MODELS_SUB: &str = "models";
/// 目录可以不在数据根里：有人只有一个盘装得下这十几 GB
const DIR_KEY: &str = "gen_models_dir";
/// 这四件的实测名字和字节数都在盘上核过，就是设置页的检测清单
const DEFAULT_DIT: &str = "qwen_image_2.1-Q6_K.gguf";
const DEFAULT_ENCODER: &str = "Qwen3VL-8B-Instruct-Q4_K_M.gguf";
const DEFAULT_VISION: &str = "mmproj-Qwen3VL-8B-Instruct-F16.gguf";
const DEFAULT_VAE: &str = "qwen_image_2.1_vae_bf16.safetensors";
/// 高清放大那颗网络权重，跟着数据根走（`gen/upscale/`）。它不参与「模型目录可换」
/// 那套：只有 67 MB，没人会为它单独指一个盘。
const UPSCALE_SUB: &str = "upscale";
const DEFAULT_UPSCALER: &str = "RealESRGAN_x4plus.pth";
/// 分块边长（输入侧像素）。整张一次过装不下：864×1152→3456×4608 那一版图要 26 GB
/// 显存，引擎干净失败；512 分块同一张 9.8 秒出，反复跑也不坏。
const UPSCALE_TILE: i32 = 512;
/// 档位存 SQLite 用的键：存的就是模型目录里的纯文件名
const DIT_KEY: &str = "gen_dit";
const ENCODER_KEY: &str = "gen_encoder";
/// 显存预算（GiB）：留出的那一截是给 three.js 的
const VRAM_BUDGET: &str = "12";

/// DiT 的量化档，从小到大。名字和字节数都是 2026-11-03 从模型仓库的 tree 接口
/// 一家一家核过的（不是估的），下载清单和本机建议都靠这张表。
const DIT_TIERS: [(&str, u64); 7] = [
    ("qwen_image_2.1-Q2_K.gguf", 2_561_716_256),
    ("qwen_image_2.1-Q3_K.gguf", 3_270_553_632),
    ("qwen_image_2.1-Q4_0.gguf", 4_197_494_816),
    ("qwen_image_2.1-Q4_K.gguf", 4_197_494_816),
    ("qwen_image_2.1-Q5_0.gguf", 5_069_910_048),
    ("qwen_image_2.1-Q6_K.gguf", 5_996_851_232),
    ("qwen_image_2.1-Q8_0.gguf", 7_687_155_744),
];
/// 编码器和 VAE 只认这一档：再大的档没有文件，换档也只换 DiT。
const ENCODER_BYTES: u64 = 5_027_784_800;
const VAE_BYTES: u64 = 675_509_688;
const VISION_BYTES: u64 = 1_159_029_824;
/// 三个来源页。下载由用户自己点，应用不碰网络。
const DIT_PAGE: &str = "https://huggingface.co/leejet/Qwen-Image-2.1-GGUF/tree/main";
const ENCODER_PAGE: &str = "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/tree/main";
const VAE_PAGE: &str = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/main/vae";
/// 建议档要留下的余量（MB）。显存不参与：权重住内存条、按预算现搬上卡，
/// P0 实测卸载档和全显存档出的图像素逐字节相同，卡的 size 只影响快慢。
const RAM_RESERVE_MB: u64 = 4096;
const DISK_RESERVE_MB: u64 = 2048;
const IDLE_UNLOAD: Duration = Duration::from_secs(45);
/// 后台线程就按这个节奏看一眼，所以实际释放落在 45~55 秒之间
const IDLE_POLL: Duration = Duration::from_secs(10);

const DEFAULT_SIZE: i32 = 1024;
const DEFAULT_STEPS: i32 = 20;
const DEFAULT_CFG: f32 = 6.0;
/// 图生图的改动幅度默认值，跟上游 `sd_img_gen_params_init` 那个 0.75 保持一致
const DEFAULT_STRENGTH: f32 = 0.75;
/// 面板上的图最短的一条边也得有这个数，再小就是糊的
const PREVIEW_MAX: u32 = 256;

/// 引擎给的 ctx 是裸指针，Rust 不知道它能不能跨线程。包一层并替它担保：
/// 只有 busy 的那条工作线程会使唤它，取消和卸载都在这把锁里判过 busy。
struct Ctx(*mut sd::sd_ctx_t);

unsafe impl Send for Ctx {}

/// 当前选的量化档：DiT（真正画图的那个大模型）和文本编码器各一档。
#[derive(Clone, PartialEq, Eq)]
struct Weights {
    dit: String,
    encoder: String,
}

impl Weights {
    /// 盘上没配过档时用它，也是设置页下载清单的默认项。
    fn fallback() -> Self {
        Self {
            dit: DEFAULT_DIT.to_string(),
            encoder: DEFAULT_ENCODER.to_string(),
        }
    }
}

/// 一个 models 目录里混着四种文件，靠名字认。分错档就是拿编码器去当 DiT 载入，
/// 引擎会直接起不来，所以选文件时卡死「各槽位只收自己那一类」。
#[derive(Copy, Clone, PartialEq, Eq)]
enum Kind {
    Dit,
    Encoder,
    Vae,
    Mmproj,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Dit => "画图模型",
            Kind::Encoder => "文本编码器",
            Kind::Vae => "VAE",
            Kind::Mmproj => "视觉投影",
        }
    }
}

fn weight_kind(name: &str) -> Option<Kind> {
    let lower = name.to_ascii_lowercase();
    match Path::new(&lower).extension().and_then(|e| e.to_str()) {
        Some("gguf") | Some("safetensors") => {}
        _ => return None,
    }
    if lower.contains("vae") {
        return Some(Kind::Vae);
    }
    if lower.contains("mmproj") {
        return Some(Kind::Mmproj);
    }
    if lower.contains("qwen3vl") || lower.contains("qwen3-vl") {
        return Some(Kind::Encoder);
    }
    Some(Kind::Dit)
}

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
    /// 当前档位。改动只发生在 gen_models_set，那儿会同步写进 SQLite。
    picked: Arc<Mutex<Weights>>,
    /// 模型目录：Some 是用户在设置页另指的位置，None 就跟着数据根走。
    /// 指到数据根外面那份就不跟着搬，所以换数据目录时别指望它。
    models_dir: Arc<Mutex<Option<PathBuf>>>,
    /// nvidia-smi 认到的那张卡。探测要等一两秒，认过一次就记下——
    /// 认不到也记着（Gpu 里名字为空），不然每次检测都再等一遍。
    gpu: Arc<Mutex<Option<Gpu>>>,
}

pub struct GenState(GenCore);

impl GenCore {
    fn lock(&self) -> std::sync::MutexGuard<'_, Engine> {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn weights(&self) -> Weights {
        self.picked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_weights(&self, weights: Weights) {
        *self
            .picked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = weights;
    }

    fn set_models_dir(&self, dir: Option<PathBuf>) {
        *self
            .models_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = dir;
    }

    /// 数据根里那份默认位置，「换个目录」之前的样子。
    fn default_models(&self) -> PathBuf {
        self.data.dir(GEN_DIR).join(MODELS_SUB)
    }

    fn models(&self) -> PathBuf {
        self.models_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .unwrap_or_else(|| self.default_models())
    }

    fn is_default_dir(&self) -> bool {
        self.models_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenStatus {
    pub loaded: bool,
    pub busy: bool,
    pub models_dir: String,
    /// 模型目录还是数据根里那份默认位置（false = 用户另指过，换数据根不跟着搬）
    pub dir_is_default: bool,
    pub missing: Vec<String>,
    /// 出完之后隔多久自动放权重（秒）
    pub idle_seconds: u64,
    /// 这一轮真会载入的两个文件
    pub dit: String,
    pub encoder: String,
}

/// 目录里的档位清单：两列可选 + 两件固定，都带字节数好比较大小。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub name: String,
    pub bytes: u64,
}

/// 这台机器能撑起哪一档，看的是内存和磁盘，不是显卡。
/// 显卡单独报一行：认不到就是空的，出图会走纯 CPU，慢一个数量级。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub gpu: String,
    pub vram_mb: u64,
    pub ram_total_mb: u64,
    /// 检测这一刻的空闲内存。忙的时候数字会小，建议档跟着小——这是有意的。
    pub ram_avail_mb: u64,
    /// 模型目录所在盘的剩余画布
    pub dir_free_mb: u64,
}

/// 下载清单里的一行：扔进目录的就是这个文件名。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeededRow {
    pub name: String,
    pub bytes: u64,
    pub role: &'static str,
    /// 视觉投影只有图生图/编辑要，纯文生图缺了也能出
    pub optional: bool,
    pub present: bool,
    /// 去哪儿下：仓库的文件列表页，用户自己点
    pub page: String,
}

/// DiT 量化档表里的一行，让用户自己拿大小换画质
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierRow {
    pub name: String,
    pub bytes: u64,
    /// 本机建议的那一档
    pub recommended: bool,
    /// 已经在目录里了
    pub present: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenModels {
    pub models_dir: String,
    /// false = 用户在设置页另指过目录。换数据根不搬它，前端要说清。
    pub dir_is_default: bool,
    pub dit: Vec<ModelFile>,
    pub encoder: Vec<ModelFile>,
    pub fixed: Vec<ModelFile>,
    pub current_dit: String,
    pub current_encoder: String,
    /// 当前档位里已经不在盘上的那几个：换档选过、后来文件被删了就是这儿报
    pub missing: Vec<String>,
    pub machine: Machine,
    /// 一句话：为什么建议这一档
    pub advice: String,
    /// 建议那一套的四个文件
    pub needed: Vec<NeededRow>,
    /// DiT 的全部量化档，从小到大
    pub tiers: Vec<TierRow>,
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
    /// 连线带上来的输入图：PNG 的 base64（`data:image/png;base64,` 前缀也吃）。
    /// 解码只靠 image 的 png 特性——别的格式在前端那侧就已经画成 PNG 了。
    #[serde(default)]
    pub images: Vec<String>,
    /// t2i / i2i / edit / upscale。不给就按图数定：没图是文生图，一张当底图，多张当参考。
    /// upscale 那档不读提示词，也不碰扩散权重。
    #[serde(default)]
    pub mode: Option<String>,
    /// 图生图改多少（0 原样 1 全改）。不给吃上游默认 0.75。
    #[serde(default)]
    pub strength: Option<f32>,
}

/// 输入图的三种吃法，外加一条完全不碰扩散模型的放大路。
#[derive(Copy, Clone, PartialEq, Eq)]
enum Mode {
    Text,
    /// 一张底图 + strength 重绘
    Image,
    /// 多张参考图（Qwen-Image 2.1 吃 ref-latent）
    Reference,
    /// 纯 ESRGAN 前向，输出 4×。不吃提示词、不载入那 12 GB 权重
    Upscale,
}

impl Mode {
    fn pick(want: Option<&str>, count: usize) -> Mode {
        match want.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "t2i" | "text" => Mode::Text,
            "i2i" | "image" => Mode::Image,
            "edit" | "reference" => Mode::Reference,
            "upscale" => Mode::Upscale,
            _ if count == 0 => Mode::Text,
            _ if count == 1 => Mode::Image,
            _ => Mode::Reference,
        }
    }
}

/// 解码好的一张输入图。`raw.data` 指着 `buf` 自己那块堆内存——
/// 整个结构体搬家不要紧（Vec 的头搬了、数据不搬），但 buf 不能在被使唤期间改动。
struct InputImage {
    buf: Vec<u8>,
    raw: sd::sd_image_t,
}

fn decode_input(text: &str) -> Result<InputImage, String> {
    let body = match text.find(',') {
        Some(at) if text.starts_with("data:") => &text[at + 1..],
        _ => text,
    };
    let bytes = BASE64
        .decode(body.trim())
        .map_err(|e| format!("输入图不是 base64：{e}"))?;
    let decoded = image::load_from_memory(&bytes).map_err(|e| format!("输入图解不开：{e}"))?;
    let rgb = decoded.to_rgb8();
    let (width, height) = rgb.dimensions();
    if width < 32 || height < 32 {
        return Err(format!("输入图太小了（{width}×{height}）"));
    }
    let buf = rgb.into_raw();
    let mut image = InputImage {
        buf,
        raw: sd::sd_image_t {
            width,
            height,
            channel: 3,
            data: null_mut(),
        },
    };
    image.raw.data = image.buf.as_mut_ptr();
    Ok(image)
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

pub fn init(data: DataRoot, db: &DbState) -> GenState {
    let core = GenCore {
        data,
        engine: Arc::new(Mutex::new(Engine {
            ctx: null_mut(),
            busy: false,
            last_used: Instant::now(),
        })),
        cancel: Arc::new(AtomicBool::new(false)),
        picked: Arc::new(Mutex::new(read_weights(db))),
        models_dir: Arc::new(Mutex::new(read_models_dir(db))),
        gpu: Arc::new(Mutex::new(None)),
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

/// 启动时把档位从 SQLite 读回来。读不到、值不合法就用默认档。
/// 这儿不查文件在不在：缺权重是点「开始」那一刻要报的事，不是启动的事。
fn read_weights(db: &DbState) -> Weights {
    let mut next = Weights::fallback();
    let Some(conn) = db.0.lock().ok() else {
        return next;
    };
    for (key, slot) in [(DIT_KEY, &mut next.dit), (ENCODER_KEY, &mut next.encoder)] {
        if let Some(name) = db::read_setting(&conn, key).filter(|name| check_weight_name(name).is_ok())
        {
            *slot = name;
        }
    }
    next
}

/// 另指过的模型目录。空串、不存在的目录都当没配过——跟着数据根走。
/// 用户后来把那个文件夹删了不该让整个生图通路哑掉，退回默认才是能用的样子。
fn read_models_dir(db: &DbState) -> Option<PathBuf> {
    let conn = db.0.lock().ok()?;
    let text = db::read_setting(&conn, DIR_KEY)?;
    let path = PathBuf::from(text);
    path.is_dir().then_some(path)
}

/// 档名只许是 models 目录里的纯文件名：挡掉分隔符、`..`、绝对路径、隐藏文件。
fn check_weight_name(name: &str) -> Result<(), String> {    if name.is_empty() || name.len() > 200 {
        return Err("模型文件名不对".to_string());
    }
    if name.starts_with('.') || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("“{name}”不是个文件名"));
    }
    Ok(())
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
    let weights = core.weights();
    GenStatus {
        loaded,
        busy,
        models_dir: core.models().display().to_string(),
        dir_is_default: core.is_default_dir(),
        missing: missing_weights(&core.models(), &weights),
        idle_seconds: IDLE_UNLOAD.as_secs(),
        dit: weights.dit,
        encoder: weights.encoder,
    }
}

/// 检测：列出模型目录里能选的档位，再报这台机器的规格、建议档和该下的文件。
/// 前端拿这个铺「缺什么、下什么、放哪儿」，不做预设组合。
/// 探测显卡要等子进程，所以整趟放到别的线程上跑，别把窗口冻住。
#[tauri::command]
pub async fn gen_models(state: tauri::State<'_, GenState>) -> Result<GenModels, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(collect_models(&core)))
        .await
        .map_err(|e| format!("检测跑不起来：{e}"))?
}

/// 弹系统目录选择框挑模型目录：只负责选，改不改由前端问完再定。
/// 目录这事归用户——agent 那头只管从目录里读档、挑档，不代劳换位置。
#[tauri::command]
pub async fn gen_models_dir_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    app.dialog()
        .file()
        .set_title("选择模型文件夹")
        .set_parent(&window)
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

/// 换模型目录：`dir` 给空就是收回默认位置（数据根里那份）。
/// 换完放掉权重——旧 ctx 已经把上一条路径的权重读进内存了，留着会继续用。
#[tauri::command]
pub async fn gen_models_dir_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    dir: Option<String>,
) -> Result<GenModels, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || apply_models_dir(core, app, dir))
        .await
        .map_err(|e| format!("换目录任务起不来：{e}"))?
}

fn apply_models_dir(
    core: GenCore,
    app: tauri::AppHandle,
    dir: Option<String>,
) -> Result<GenModels, String> {
    let db = app.state::<DbState>();
    let picked = dir
        .map(|text| text.trim().trim_matches('"').to_string())
        .filter(|text| !text.is_empty());
    let next = match picked {
        Some(text) => {
            let path = PathBuf::from(&text);
            if !path.is_absolute() {
                return Err("要的是一个完整的目录路径".to_string());
            }
            if !path.is_dir() {
                return Err(format!("这个文件夹不存在：{text}"));
            }
            Some(path)
        }
        None => None,
    };
    if next == *core
        .models_dir
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
    {
        return Ok(collect_models(&core));
    }
    let mut engine = core.lock();
    if engine.busy {
        return Err("正在出图，等这一张跑完再换目录".to_string());
    }
    {
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        let value = next
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        db::write_setting(&conn, DIR_KEY, &value)?;
    }
    core.set_models_dir(next);
    if !engine.ctx.is_null() {
        unsafe { sd::free_sd_ctx(engine.ctx) };
        engine.ctx = null_mut();
    }
    Ok(collect_models(&core))
}

/// 在资源管理器里打开模型目录：下载清单要说「扔进这里」，得能一点就到。
/// 目录还没建出来就顺手建，空目录不碍事。
#[tauri::command]
pub fn gen_models_reveal(state: tauri::State<GenState>) -> Result<String, String> {
    let dir = state.0.clone().models();
    fs::create_dir_all(&dir).map_err(|e| format!("建不出模型目录 {}：{e}", dir.display()))?;
    open::that(&dir).map_err(|e| format!("打不开模型目录：{e}"))?;
    Ok(dir.display().to_string())
}

/// 换档：校验 → 落库 → 放掉权重。下一次出图按新档重新载入，
/// 正在出图的时候不换——那一张的成图会说不自己是哪个模型出的。
#[tauri::command]
pub async fn gen_models_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    dit: Option<String>,
    encoder: Option<String>,
) -> Result<GenModels, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || apply_weights(core, app, dit, encoder))
        .await
        .map_err(|e| format!("换档任务起不来：{e}"))?
}

fn apply_weights(
    core: GenCore,
    app: tauri::AppHandle,
    dit: Option<String>,
    encoder: Option<String>,
) -> Result<GenModels, String> {
    let db = app.state::<DbState>();
    let dir = core.models();
    let mut next = core.weights();
    if let Some(name) = dit {
        check_available(&dir, &name, Kind::Dit)?;
        next.dit = name;
    }
    if let Some(name) = encoder {
        check_available(&dir, &name, Kind::Encoder)?;
        next.encoder = name;
    }
    if next == core.weights() {
        return Ok(collect_models(&core));
    }
    let mut engine = core.lock();
    if engine.busy {
        return Err("正在出图，等这一张跑完再换档".to_string());
    }
    {
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        db::write_setting(&conn, DIT_KEY, &next.dit)?;
        db::write_setting(&conn, ENCODER_KEY, &next.encoder)?;
    }
    /* 换的就是引擎的进料：旧 ctx 留着只会让下一次出图用错档，直接放掉。
       先改档位再放 ctx，两步都在这把锁里做完——中间要是松一下手，
       挤进来的「开始」会拿旧档又起一个 ctx。 */
    core.set_weights(next);
    if !engine.ctx.is_null() {
        unsafe { sd::free_sd_ctx(engine.ctx) };
        engine.ctx = null_mut();
    }
    Ok(collect_models(&core))
}

/// 槽位收文件：名字得是对的那一类，而且真在目录里。
fn check_available(dir: &Path, name: &str, want: Kind) -> Result<(), String> {
    check_weight_name(name)?;
    if weight_kind(name) != Some(want) {
        return Err(format!("“{name}”不是{}", want.label()));
    }
    if !dir.join(name).is_file() {
        return Err(format!("“{name}”不在模型目录里：{}", dir.display()));
    }
    Ok(())
}

/// nvidia-smi 认到的那张卡。这工具是显卡驱动自带的，不装 CUDA Toolkit 也在，
/// 所以探一眼不算依赖外部软件。
#[derive(Clone)]
struct Gpu {
    name: String,
    vram_mb: u64,
}

const MB: u64 = 1024 * 1024;

fn probe_gpu() -> Gpu {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：不然每次检测闪一个黑框
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok();
    let Some(out) = out.filter(|o| o.status.success()) else {
        return Gpu {
            name: String::new(),
            vram_mb: 0,
        };
    };
    // 多卡只取第一行：这台机器上出图就一张卡，第二行是同一张的别名或者别人的机器
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let mut parts = line.split(',').map(|p| p.trim());
    let name = parts.next().unwrap_or("").to_string();
    let vram_mb = parts
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| v.round() as u64)
        .unwrap_or(0);
    Gpu { name, vram_mb }
}

/// 空闲内存。自己声明 kernel32 的 GlobalMemoryStatusEx，不为一个数字加依赖。
/// 认不到就报 (0, 0)，调用方按「不知道」处理。
#[cfg(windows)]
#[repr(C)]
#[allow(dead_code)] // 只读其中两个数，其余字段是布局的一部分
struct MemoryStatusEx {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

#[cfg(windows)]
unsafe extern "system" {
    fn GlobalMemoryStatusEx(lp_memory_status: *mut MemoryStatusEx) -> i32;
    fn GetDiskFreeSpaceExW(
        directory_path: *const u16,
        free_bytes_available_to_caller: *mut u64,
        total_number_of_bytes: *mut u64,
        total_number_of_free_bytes: *mut u64,
    ) -> i32;
}

#[cfg(windows)]
fn ram_mb() -> (u64, u64) {
    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) != 0 };
    if ok {
        (status.ull_total_phys / MB, status.ull_avail_phys / MB)
    } else {
        (0, 0)
    }
}

#[cfg(not(windows))]
fn ram_mb() -> (u64, u64) {
    (0, 0)
}

/// 目录所在盘的剩余画布（MB）。目录还没建出来时按最近的已存在父目录算。
fn free_mb(dir: &Path) -> u64 {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut target = dir;
        while !target.is_dir() {
            match target.parent() {
                Some(up) => target = up,
                None => return 0,
            }
        }
        let wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
                != 0
        };
        if ok {
            free / MB
        } else {
            0
        }
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        0
    }
}

impl GenCore {
    /// 检测用的机器数字。显卡那条要等子进程，认过一次就记下；
    /// 内存和磁盘每次现读，因为它们本来就在变。
    fn machine(&self) -> Machine {
        let gpu = self
            .gpu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_or_insert_with(probe_gpu)
            .clone();
        let (ram_total_mb, ram_avail_mb) = ram_mb();
        Machine {
            gpu: gpu.name,
            vram_mb: gpu.vram_mb,
            ram_total_mb,
            ram_avail_mb,
            dir_free_mb: free_mb(&self.models()),
        }
    }
}

fn gb(mb: u64) -> String {
    format!("{:.1} GB", mb as f64 / 1024.0)
}

/// 建议哪一档：编码器和 VAE 是躲不掉的固定开销，剩下的内存和磁盘看能塞进
/// 多大的 DiT，从最大档往下试。认不到机器数字就退回默认档，不瞎猜。
fn advise(machine: &Machine) -> (&'static str, u64, String) {
    let smallest = DIT_TIERS[0];
    let fallback = DIT_TIERS
        .iter()
        .find(|(name, _)| *name == DEFAULT_DIT)
        .unwrap_or(&smallest);
    if machine.ram_avail_mb == 0 || machine.dir_free_mb == 0 {
        let need = (fallback.1 + ENCODER_BYTES + VAE_BYTES) / MB;
        return (
            fallback.0,
            fallback.1,
            format!("认不到这台机器的空闲内存或磁盘余量，先按默认的 {}（这一套 {}）给建议。", fallback.0, gb(need)),
        );
    }
    let fixed = (ENCODER_BYTES + VAE_BYTES) / MB;
    let ram_budget = machine.ram_avail_mb.saturating_sub(RAM_RESERVE_MB);
    let disk_budget = machine.dir_free_mb.saturating_sub(DISK_RESERVE_MB);
    let picked = DIT_TIERS
        .iter()
        .rev()
        .find(|(_, bytes)| fixed + bytes / MB <= ram_budget && fixed + bytes / MB <= disk_budget);
    let (name, dit_bytes) = *picked.unwrap_or(&smallest);
    let need = (dit_bytes + ENCODER_BYTES + VAE_BYTES) / MB;
    let mut reason = match picked {
        Some(_) => format!(
            "内存空出 {}、模型目录那个盘还剩 {}，扣掉留给应用和系统的余量，装得下 {}（这一套共 {}）。",
            gb(machine.ram_avail_mb),
            gb(machine.dir_free_mb),
            name,
            gb(need)
        ),
        None => format!(
            "内存只剩 {}、盘还剩 {}，连最小档 {} 那一套（{}）都放不下。先清出地方，或把模型目录换到大盘上。",
            gb(machine.ram_avail_mb),
            gb(machine.dir_free_mb),
            name,
            gb(need)
        ),
    };
    if machine.vram_mb == 0 {
        reason.push_str("另外没认到 NVIDIA 显卡，出图会走纯 CPU，慢一个数量级。");
    }
    (name, dit_bytes, reason)
}

/// 建议那一套要扔进目录的文件。字节数是仓库里的真数，不是本地文件的。
fn needed_rows(dir: &Path, dit: &str, dit_bytes: u64) -> Vec<NeededRow> {
    let rows: [(&str, u64, &'static str, bool, String); 4] = [
        (dit, dit_bytes, Kind::Dit.label(), false, DIT_PAGE.to_string()),
        (
            DEFAULT_ENCODER,
            ENCODER_BYTES,
            Kind::Encoder.label(),
            false,
            ENCODER_PAGE.to_string(),
        ),
        (DEFAULT_VAE, VAE_BYTES, Kind::Vae.label(), false, VAE_PAGE.to_string()),
        (
            DEFAULT_VISION,
            VISION_BYTES,
            Kind::Mmproj.label(),
            true,
            ENCODER_PAGE.to_string(),
        ),
    ];
    rows.into_iter()
        .map(|(name, bytes, role, optional, page)| NeededRow {
            name: name.to_string(),
            bytes,
            role,
            optional,
            present: dir.join(name).is_file(),
            page,
        })
        .collect()
}

fn tier_rows(dir: &Path, recommended: &str) -> Vec<TierRow> {
    DIT_TIERS
        .iter()
        .map(|(name, bytes)| TierRow {
            name: name.to_string(),
            bytes: *bytes,
            recommended: *name == recommended,
            present: dir.join(name).is_file(),
        })
        .collect()
}

fn collect_models(core: &GenCore) -> GenModels {
    let dir = core.models();
    let mut buckets: Vec<Vec<ModelFile>> = vec![Vec::new(), Vec::new(), Vec::new()];
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if !path.is_file() {
                continue;
            }
            let Some(kind) = weight_kind(&name) else {
                continue;
            };
            let slot = match kind {
                Kind::Dit => 0,
                Kind::Encoder => 1,
                Kind::Vae | Kind::Mmproj => 2,
            };
            let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            buckets[slot].push(ModelFile { name, bytes });
        }
    }
    for bucket in &mut buckets {
        bucket.sort_by_key(|file| file.bytes);
    }
    let weights = core.weights();
    let machine = core.machine();
    let (dit, dit_bytes, advice) = advise(&machine);
    GenModels {
        models_dir: dir.display().to_string(),
        dir_is_default: core.is_default_dir(),
        dit: buckets.remove(0),
        encoder: buckets.remove(0),
        fixed: buckets.remove(0),
        current_dit: weights.dit.clone(),
        current_encoder: weights.encoder.clone(),
        missing: missing_weights(&dir, &weights),
        machine,
        advice,
        needed: needed_rows(&dir, dit, dit_bytes),
        tiers: tier_rows(&dir, dit),
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
    /* 放大那一档压根不读提示词，别拿空框拦它 */
    if Mode::pick(req.mode.as_deref(), req.images.len()) != Mode::Upscale && req.prompt.trim().is_empty() {
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
    /* 放大这一档不碰扩散模型：既不载入那 12 GB，也不走 ctx，自成一条路 */
    if Mode::pick(req.mode.as_deref(), req.images.len()) == Mode::Upscale {
        return begin_upscale(core, app, req, block);
    }
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

/// 高清放大这一趟：认领 busy、认权重，然后把前向丢给后台线程。
/// 一次前向几十秒，中途掐不掉，所以「停止」只能靠标志位让收尾显示成「已取消」。
fn begin_upscale(core: GenCore, app: tauri::AppHandle, req: GenRequest, block: String) -> Result<(), String> {
    {
        let mut engine = core.lock();
        if engine.busy {
            return Err("正在出图，等这一张跑完".to_string());
        }
        engine.busy = true;
        engine.last_used = Instant::now();
        core.cancel.store(false, Ordering::Relaxed);
    }
    let model = match upscaler_path(&core) {
        Ok(path) => path,
        Err(error) => {
            core.lock().busy = false;
            return Err(error);
        }
    };
    thread::spawn(move || upscale_job(core, app, model, req, block));
    Ok(())
}

/// 放大权重的位置：数据根里的 `gen/upscale/`，跟「模型目录可换」那套无关。
fn upscaler_path(core: &GenCore) -> Result<PathBuf, String> {
    let path = core.data.dir(GEN_DIR).join(UPSCALE_SUB).join(DEFAULT_UPSCALER);
    if !path.is_file() {
        return Err(format!(
            "放大模型不在：{}（Real-ESRGAN x4plus，67 MB）",
            path.display()
        ));
    }
    Ok(path)
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
    let weights = core.weights();
    let missing = missing_weights(&dir, &weights);
    if !missing.is_empty() {
        return Err(format!("权重还没下全，缺：{}", missing.join("、")));
    }
    // 这几条 CString 必须活到 new_sd_ctx 返回之后，所以只能在栈上捏着
    let diffusion = cpath(&dir.join(&weights.dit));
    let encoder = cpath(&dir.join(&weights.encoder));
    let vae = cpath(&dir.join(DEFAULT_VAE));
    /* 视觉投影是可选件：没有它就出不了图生图和编辑，纯文生图照跑。
       引擎那边按 strlen 判空，所以缺了就干脆不填这个槽。 */
    let vision_path = dir.join(DEFAULT_VISION);
    let vision = vision_path.is_file().then(|| cpath(&vision_path));
    let budget = CString::new(VRAM_BUDGET).expect("常量串");
    let backend = CString::new("cpu").expect("常量串");
    unsafe {
        let mut raw = std::mem::MaybeUninit::<sd::sd_ctx_params_t>::uninit();
        sd::sd_ctx_params_init(raw.as_mut_ptr());
        let mut params = raw.assume_init();
        params.diffusion_model_path = diffusion.as_ptr();
        params.llm_path = encoder.as_ptr();
        if let Some(vision) = &vision {
            params.llm_vision_path = vision.as_ptr();
        }
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
    finish(&core, &app, block, outcome, started.elapsed().as_secs_f32());
}

/// 两条路（扩散、放大）跑完都从这儿收尾：交还 busy，再把这一张或这条错发回前端。
fn finish(
    core: &GenCore,
    app: &tauri::AppHandle,
    block: String,
    outcome: Result<Out, String>,
    seconds: f32,
) {
    let canceled = core.cancel.load(Ordering::Relaxed);
    {
        let mut engine = core.lock();
        engine.busy = false;
        engine.last_used = Instant::now();
    }
    match outcome {
        /* 放大那一次前向掐不断，只能跑完再认这张已经作废——
           不然界面先显示「已取消」，过几秒又自己变成一张成品。 */
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

fn upscale_job(
    core: GenCore,
    app: tauri::AppHandle,
    model: PathBuf,
    req: GenRequest,
    block: String,
) {
    let started = Instant::now();
    let outcome = upscale_run(&model, &req);
    finish(&core, &app, block, outcome, started.elapsed().as_secs_f32());
}

/// 一次 ESRGAN 前向。ctx 现建现放：认过一次 0.1 秒，比那 12 GB 权重便宜得多，
/// 不值得为它维护一套空闲释放。提示词、宽高、步数、种子在这一档全都不看，
/// 输出尺寸就是输入的 4 倍（网络自带的倍率）。
fn upscale_run(model: &Path, req: &GenRequest) -> Result<Out, String> {
    match req.images.len() {
        1 => {}
        0 => return Err("高清放大要连一张图过来".to_string()),
        count => return Err(format!("高清放大只吃一张图，现在连了 {count} 张")),
    }
    let input = decode_input(&req.images[0])?;
    let path = cpath(model);
    /* 后端名留空 = 引擎自己挑，和扩散那条路一个口径；参数住 CPU 也是照它抄。
       线程数只管 CPU 后端，CUDA 上用不上，跟着引擎的默认 4。 */
    let backend = CString::new("").expect("常量串");
    let params_backend = CString::new("cpu").expect("常量串");
    unsafe {
        let ctx = sd::new_upscaler_ctx(
            path.as_ptr(),
            false,
            4,
            UPSCALE_TILE,
            backend.as_ptr(),
            params_backend.as_ptr(),
        );
        if ctx.is_null() {
            return Err("放大模型起不来：new_upscaler_ctx 返回空，看后端日志".to_string());
        }
        let mut result: *mut sd::sd_image_generation_result_t = null_mut();
        let ok = sd::upscale(ctx, input.raw, 4, &mut result);
        let out = read_back(result, ok, "放大失败，看后端日志");
        sd::free_upscaler_ctx(ctx);
        out
    }
}

/// 把引擎那份结果像素拷出来。扩散和放大两条路共用：结果必须在拷完之后才 free，
/// 顺序错了就是拿已还回去的内存。
fn read_back(
    result: *mut sd::sd_image_generation_result_t,
    ok: bool,
    failed: &str,
) -> Result<Out, String> {
    if !ok || result.is_null() {
        return Err(failed.to_string());
    }
    unsafe {
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
            // 必须拷：free 一跑，这份像素就没了
            pixels: std::slice::from_raw_parts(image.data, len).to_vec(),
            width: image.width,
            height: image.height,
            channel,
        };
        sd::free_sd_image_generation_result(result);
        Ok(out)
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
    /* 输入图先全解出来捏在这儿：raw.data 指着它们的堆内存，
       必须活过 generate_image，所以不能是临时值 */
    let inputs: Vec<InputImage> = req
        .images
        .iter()
        .map(|text| decode_input(text))
        .collect::<Result<_, _>>()?;
    let mode = Mode::pick(req.mode.as_deref(), inputs.len());
    if mode != Mode::Text && inputs.is_empty() {
        return Err("这一档要输入图，但一块连过来的图都没有".to_string());
    }
    let strength = req.strength.unwrap_or(DEFAULT_STRENGTH).clamp(0.0, 1.0);
    /* 引擎吃的是 sd_image_t 数组，指针是「借」过去的：数组本体必须活过 generate_image。
       所以在这儿就地摊平，不能等进了 match 分支再临时造一个——出分支就散架，
       引擎读到的是一堆已经还给系统的内存（实测报 empty image in array）。 */
    let ref_images: Vec<sd::sd_image_t> = inputs.iter().map(|input| input.raw).collect();

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
        match mode {
            Mode::Text => {}
            /* 图生图：底图按块上的宽高走（引擎自己缩放它），
               不拿原图尺寸去改用户定好的那几个数 */
            Mode::Image => {
                params.init_image = inputs[0].raw;
                params.strength = strength;
            }
            Mode::Reference => {
                params.ref_images = ref_images.as_ptr() as *mut sd::sd_image_t;
                params.ref_images_count = ref_images.len() as _;
            }
            /* 放大那一档在 begin() 就分岔走了，压根不会带着它走到这儿来碰扩散参数 */
            Mode::Upscale => unreachable!("高清放大不走扩散"),
        }

        let mut result: *mut sd::sd_image_generation_result_t = null_mut();
        let ok = sd::generate_image(ctx.0, &params, &mut result);
        read_back(result, ok, "出图失败")
    }
}

unsafe extern "C" fn on_log(level: sd::sd_log_level_t, text: *const i8, _data: *mut c_void) {
    /* 枚举是 DEBUG 0 → ERROR 4 这么排的，所以「只放行警告和错误」得正着写：
       上一版写成 `> WARN 就丢`，把 ERROR 一起丢了，引擎为什么失败从来看不见 */
    if level != sd::sd_log_level_t::SD_LOG_WARN && level != sd::sd_log_level_t::SD_LOG_ERROR {
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

/// 这一轮真会载入的文件里，哪些不在目录里。视觉投影不在必需名单上：
/// 缺了它出不了图生图和编辑，纯文生图照样能跑，别拿它拦「开始」。
fn missing_weights(dir: &Path, weights: &Weights) -> Vec<String> {
    [
        weights.dit.as_str(),
        weights.encoder.as_str(),
        DEFAULT_VAE,
    ]
    .into_iter()
    .filter(|name| !dir.join(name).is_file())
    .map(|name| (*name).to_string())
    .collect()
}
