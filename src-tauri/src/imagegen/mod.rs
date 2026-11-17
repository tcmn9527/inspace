//! 生图面板的引擎通路：一个常驻 sd_ctx，一次只出一张。
//!
//! 为什么不用高层封装：它每次出图都 free 掉再重建 ctx，等于每点一次「开始」
//! 把 6GB 权重从盘上重读一遍。
//!
//! 显存走 P0 验过的卸载档（权重住内存条、按 max_vram 现搬上卡）：
//! 峰值 8986 MiB / 29.7 秒一张，和全塞显存（15393 MiB / 29.3 秒）像素逐字节相同。
//! 实测空闲那几分钟显存并不额外占（跑前跑后都是同一档），占的是内存条上那 ~15GB，
//! 所以出完 45 秒没接着画就自己放掉——连点改词还热着，停手一分钟把内存还回去。

use std::collections::HashMap;
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
use crate::imageapi::{self, ApiConfig};
use crate::sdcpp as sd;
use crate::store::{DataRoot, GEN_DIR};


mod gen_run;
mod model_files;
mod pipeline;

pub use gen_run::*;
pub use model_files::*;
pub use pipeline::*;
pub(crate) use pipeline::Out;

use model_files::Gpu;

const MODELS_SUB: &str = "models";
/// H3-Image 那套 25GB 权重默认住自己的子目录，不和 Qwen 的混在一起
const H3_MODELS_SUB: &str = "h3image";
/// 目录可以不在数据根里：有人只有一个盘装得下这十几 GB
const DIR_KEY: &str = "gen_models_dir";
/// 这四件的实测名字和字节数都在盘上核过，就是设置页的检测清单
const DEFAULT_DIT: &str = "qwen_image_2.1-Q6_K.gguf";
const DEFAULT_ENCODER: &str = "Qwen3VL-8B-Instruct-Q4_K_M.gguf";
const DEFAULT_VISION: &str = "mmproj-Qwen3VL-8B-Instruct-F16.gguf";
const DEFAULT_VAE: &str = "qwen_image_2.1_vae_bf16.safetensors";

/* ---------- MiniMax-H3-Image：33B DiT + Qwen3-VL-32B 编码器 + 专用 2D VAE ----------
   4080 16GB 实测：Q4 DiT + Q2 编码器，1MP 热态 4.9 秒、2MP 8.3 秒、16MP 136 秒。
   6 步蒸馏、cfg 1、不需要视觉投影（编码器里自带视觉塔）。 */
const H3_DEFAULT_DIT: &str = "MiniMax-H3-Image-AD-Q4_K.gguf";
const H3_DEFAULT_ENCODER: &str = "qwen3vl_32b_minimax_h3-Q2_K_M.gguf";
const H3_DEFAULT_VAE: &str = "minimax_h3_image_vae_fp16.safetensors";
const H3_ENCODER_BYTES: u64 = 13_102_161_024;
const H3_VAE_BYTES: u64 = 1_168_505_312;
const H3_DIT_TIERS: [(&str, u64); 6] = [
    ("MiniMax-H3-Image-AD-Q2_K.gguf", 7_567_053_024),
    ("MiniMax-H3-Image-AD-Q3_K.gguf", 8_726_118_624),
    ("MiniMax-H3-Image-AD-Q4_K.gguf", 11_571_097_824),
    ("MiniMax-H3-Image-AD-Q5_K.gguf", 13_841_060_064),
    ("MiniMax-H3-Image-AD-Q6_K.gguf", 16_670_986_464),
    ("MiniMax-H3-Image-Q8_0.gguf", 21_448_745_184),
];
const H3_DIT_PAGE: &str = "https://hf-mirror.com/AtomicChat/MiniMax-H3-Image-GGUF/tree/main";
const H3_ENCODER_PAGE: &str = "https://hf-mirror.com/leejet/MiniMax-H3-GGUF/tree/main";
const H3_VAE_PAGE: &str = "https://hf-mirror.com/Comfy-Org/MiniMax-H3-Image/tree/main/vae";

/// 高清放大那颗网络权重，跟着数据根走（`gen/upscale/`）。它不参与「模型目录可换」
/// 那套：只有 67 MB，没人会为它单独指一个盘。
const UPSCALE_SUB: &str = "upscale";
const DEFAULT_UPSCALER: &str = "RealESRGAN_x4plus.pth";
/// 分块边长（输入侧像素）。整张一次过装不下：864×1152→3456×4608 那一版图要 26 GB
/// 显存，引擎干净失败；512 分块同一张 9.8 秒出，反复跑也不坏。
/// 补细节默认用这一句：用户不用写，只想让整张图更细腻
const REFINE_PROMPT: &str =
    "全图每一处细节都更细腻丰富，纹理清晰，材质真实，边缘干净，色彩层次自然";

const UPSCALE_TILE: i32 = 512;
/// 档位存 SQLite 用的键：存的就是模型目录里的纯文件名
const DIT_KEY: &str = "gen_dit";
const ENCODER_KEY: &str = "gen_encoder";
const FAMILY_KEY: &str = "gen_family";
/// H3 那套的档位键；Qwen 沿用旧键，老配置升级后原样可用
const H3_DIT_KEY: &str = "gen_h3_dit";
const H3_ENCODER_KEY: &str = "gen_h3_encoder";
const H3_DIR_KEY: &str = "gen_h3_models_dir";
/// 每族一套「新建面板默认参数」，用户在面板「更多设置」里改的就是它（JSON）
const DEFAULTS_KEY: &str = "gen_defaults_qwen21";
const H3_DEFAULTS_KEY: &str = "gen_defaults_h3image";
/// 负向提示词存这么长就够，再长也是白占
const NEGATIVE_MAX: usize = 2000;
/// 显存预算（GiB）：留出的那一截是给 three.js 的
const VRAM_BUDGET: &str = "14";

/// 两套模型：Qwen-Image 2.1（日常，30 步）和 MiniMax-H3-Image（高质量，6 步）。
/// 各自有独立的槽位、目录、默认参数和空闲卸载时长。
#[derive(Copy, Clone, PartialEq, Eq)]
pub enum Family {
    Qwen21,
    H3Image,
}

impl Family {
    fn from_id(text: &str) -> Option<Family> {
        match text.trim().to_ascii_lowercase().as_str() {
            "qwen21" | "qwen" | "qwen-image" => Some(Family::Qwen21),
            "h3image" | "h3" | "h3-image" | "minimax" | "minimax-h3-image" => Some(Family::H3Image),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Family::Qwen21 => "qwen21",
            Family::H3Image => "h3image",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Family::Qwen21 => "Qwen-Image 2.1",
            Family::H3Image => "MiniMax-H3-Image",
        }
    }

    fn index(self) -> usize {
        match self {
            Family::Qwen21 => 0,
            Family::H3Image => 1,
        }
    }

    fn dit_key(self) -> &'static str {
        match self {
            Family::Qwen21 => DIT_KEY,
            Family::H3Image => H3_DIT_KEY,
        }
    }

    fn encoder_key(self) -> &'static str {
        match self {
            Family::Qwen21 => ENCODER_KEY,
            Family::H3Image => H3_ENCODER_KEY,
        }
    }

    fn dir_key(self) -> &'static str {
        match self {
            Family::Qwen21 => DIR_KEY,
            Family::H3Image => H3_DIR_KEY,
        }
    }

    fn defaults(self) -> Weights {
        match self {
            Family::Qwen21 => Weights {
                dit: DEFAULT_DIT.to_string(),
                encoder: DEFAULT_ENCODER.to_string(),
            },
            Family::H3Image => Weights {
                dit: H3_DEFAULT_DIT.to_string(),
                encoder: H3_DEFAULT_ENCODER.to_string(),
            },
        }
    }

    /// 这一族躲不掉的固定件：VAE 名字和字节数（Qwen 另有一个可选的视觉投影）
    fn vae(self) -> (&'static str, u64) {
        match self {
            Family::Qwen21 => (DEFAULT_VAE, VAE_BYTES),
            Family::H3Image => (H3_DEFAULT_VAE, H3_VAE_BYTES),
        }
    }

    fn tiers(self) -> &'static [(&'static str, u64)] {
        match self {
            Family::Qwen21 => &DIT_TIERS,
            Family::H3Image => &H3_DIT_TIERS,
        }
    }

    fn default_steps(self) -> i32 {
        match self {
            Family::Qwen21 => DEFAULT_STEPS,
            Family::H3Image => 6,
        }
    }

    fn default_cfg(self) -> f32 {
        match self {
            Family::Qwen21 => DEFAULT_CFG,
            Family::H3Image => 1.0,
        }
    }

    /// H3 原生支持到 4K 级（16MP 实测 136 秒）；Qwen 到 2048。
    fn max_side(self) -> i32 {
        match self {
            Family::Qwen21 => 2048,
            Family::H3Image => 4096,
        }
    }

    /// H3-Image 只保证文生图和参考图编辑；图生图/局部重绘没验证，先不接。
    fn modes(self) -> Vec<&'static str> {
        match self {
            Family::Qwen21 => vec!["t2i", "i2i", "edit", "inpaint", "upscale"],
            Family::H3Image => vec!["t2i", "edit", "upscale"],
        }
    }

    fn supports(self, mode: Mode) -> bool {
        match mode {
            Mode::Text | Mode::Upscale => true,
            Mode::Reference => true,
            Mode::Image => self == Family::Qwen21,
            Mode::Inpaint => self == Family::Qwen21,
        }
    }

    /// 25GB 权重重读要几分钟：以前 45 秒/5 分钟就放，用户看图改词的间隙一过就得整套重载，
    /// 看起来像「每张都从头加载」。两族统一给 30 分钟，权重只常驻内存、不常驻显存。
    fn idle_seconds(self) -> u64 {
        1800
    }

    fn defaults_key(self) -> &'static str {
        match self {
            Family::Qwen21 => DEFAULTS_KEY,
            Family::H3Image => H3_DEFAULTS_KEY,
        }
    }

    /// 出厂参数：用户没改过、或点了「恢复默认」时用这一套。
    fn factory_defaults(self) -> GenDefaults {
        GenDefaults {
            width: DEFAULT_SIZE,
            height: DEFAULT_SIZE,
            steps: self.default_steps(),
            cfg: self.default_cfg(),
            seed: -1,
            mode: "auto".to_string(),
            strength: DEFAULT_STRENGTH,
            negative: String::new(),
            refine: false,
        }
    }
}

/// 一族的出图默认参数：面板「更多设置」显示和修改的就是它，新建面板直接照这套初始化。
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

/// 把用户给的数收进合法范围：宽高 32 对齐并按该族上限，模式不支持就回 auto。
fn normalize_defaults(mut value: GenDefaults, family: Family) -> GenDefaults {
    let snap = |amount: i32| (amount / 32).max(1) * 32;
    value.width = snap(value.width).clamp(256, family.max_side());
    value.height = snap(value.height).clamp(256, family.max_side());
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
    if !family.supports(Mode::pick(Some(&value.mode), 0)) {
        value.mode = "auto".to_string();
    }
    value.strength = value.strength.clamp(0.0, 1.0);
    if value.negative.chars().count() > NEGATIVE_MAX {
        value.negative = value.negative.chars().take(NEGATIVE_MAX).collect();
    }
    value
}

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
const DIT_PAGE: &str = "https://hf-mirror.com/leejet/Qwen-Image-2.1-GGUF/tree/main";
const ENCODER_PAGE: &str = "https://hf-mirror.com/Qwen/Qwen3-VL-8B-Instruct-GGUF/tree/main";
const VAE_PAGE: &str = "https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/tree/main/vae";
/// 建议档要留下的余量（MB）。显存不参与：权重住内存条、按预算现搬上卡，
/// P0 实测卸载档和全显存档出的图像素逐字节相同，卡的 size 只影响快慢。
const RAM_RESERVE_MB: u64 = 4096;
const DISK_RESERVE_MB: u64 = 2048;
/// 后台线程就按这个节奏看一眼，所以实际释放落在 idle_seconds 之后
const IDLE_POLL: Duration = Duration::from_secs(10);

const DEFAULT_SIZE: i32 = 1024;
const DEFAULT_STEPS: i32 = 30;
const DEFAULT_CFG: f32 = 6.0;
/// 2026-11 之前 Qwen 的出厂步数是 20。老 H3 块上可能还留着这一对默认值，
/// 迁移判断不能跟着 DEFAULT_STEPS 一起变。
const LEGACY_QWEN_STEPS: i32 = 20;
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
    /// 本地/放大任务认领的块 id；换成按块取消时靠它认人。
    block: String,
    last_used: Instant,
    /// "gpu"=显卡(快,推荐)；"cpu"=全内存(慢,显存不够时用)。格纹与设备无关,是 H3 本地解码固有
    device: String,
}

/// API 通道在跑的一轮：每轮自己的取消标志，互不打扰。
struct ApiJob {
    cancel: Arc<AtomicBool>,
}

unsafe impl Send for Engine {}

#[derive(Clone)]
pub struct GenCore {
    data: DataRoot,
    engine: Arc<Mutex<Engine>>,
    /// 「这一轮别再跑了」的意愿。冷加载权重那一两分钟锁被人占着，
    /// 停止只能靠这个标志位传话，不能去等锁。
    cancel: Arc<AtomicBool>,
    /// 当前用哪一族。切换会放掉旧 ctx，下一次出图按新族重新载入。
    family: Arc<Mutex<Family>>,
    /// 两族各自的档位，下标见 Family::index。改动都同步写进 SQLite。
    picked: Arc<Mutex<[Weights; 2]>>,
    /// 两族各自的模型目录：Some 是用户在设置页另指的位置，None 就跟着数据根走。
    /// 指到数据根外面那份就不跟着搬，所以换数据目录时别指望它。
    models_dir: Arc<Mutex<[Option<PathBuf>; 2]>>,
    /// 两族各自的新建面板默认参数，下标见 Family::index。
    /// 面板「更多设置」改的就是这一份：新建面板照它初始化，恢复默认回出厂值。
    defaults: Arc<Mutex<[GenDefaults; 2]>>,
    /// nvidia-smi 认到的那张卡。探测要等一两秒，认过一次就记下——
    /// 认不到也记着（Gpu 里名字为空），不然每次检测都再等一遍。
    gpu: Arc<Mutex<Option<Gpu>>>,
    /// 远端 API 的配置（设置页写、出图时读）。启用且填全了就不碰本地引擎。
    api: Arc<Mutex<ApiConfig>>,
    /// API 通道在跑的任务：块 id -> 任务。并行上限见 ApiConfig::parallel_limit，
    /// 本地引擎不走这里——那张卡一次只能算一张。
    api_jobs: Arc<Mutex<HashMap<String, ApiJob>>>,
}

pub struct GenState(GenCore);

impl GenState {
    /// 设置页改完 API 配置后同步进内存缓存，下一次出图直接用新配置。
    pub fn set_api(&self, value: ApiConfig) {
        self.0.set_api(value);
    }
}

impl GenCore {
    fn lock(&self) -> std::sync::MutexGuard<'_, Engine> {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn family(&self) -> Family {
        *self
            .family
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set_family(&self, family: Family) {
        *self
            .family
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = family;
    }

    fn weights(&self) -> Weights {
        let family = self.family();
        self.picked.lock().unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()].clone()
    }

    fn set_weights(&self, weights: Weights) {
        let family = self.family();
        self.picked.lock().unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()] = weights;
    }

    fn set_models_dir(&self, dir: Option<PathBuf>) {
        let family = self.family();
        self.models_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()] = dir;
    }

    /// 数据根里那份默认位置，「换个目录」之前的样子。H3 有自己的子目录。
    fn default_models(&self) -> PathBuf {
        let sub = match self.family() {
            Family::Qwen21 => MODELS_SUB,
            Family::H3Image => H3_MODELS_SUB,
        };
        self.data.dir(GEN_DIR).join(sub)
    }

    fn models(&self) -> PathBuf {
        let family = self.family();
        self.models_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()]
            .clone()
            .unwrap_or_else(|| self.default_models())
    }

    fn is_default_dir(&self) -> bool {
        let family = self.family();
        self.models_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()]
            .is_none()
    }

    fn defaults_of(&self, family: Family) -> GenDefaults {
        self.defaults.lock().unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()].clone()
    }

    fn defaults(&self) -> GenDefaults {
        self.defaults_of(self.family())
    }

    fn set_defaults(&self, family: Family, value: GenDefaults) {
        self.defaults.lock().unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()] = value;
    }

    fn api(&self) -> ApiConfig {
        self.api.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn set_api(&self, value: ApiConfig) {
        *self.api.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenStatus {
    pub loaded: bool,
    pub busy: bool,
    /// 当前族：qwen21 / h3image
    pub family: &'static str,
    pub family_label: &'static str,
    pub models_dir: String,
    /// 模型目录还是数据根里那份默认位置（false = 用户另指过，换数据根不跟着搬）
    pub dir_is_default: bool,
    pub missing: Vec<String>,
    /// 出完之后隔多久自动放权重（秒）
    pub idle_seconds: u64,
    /// 这一轮真会载入的两个文件
    pub dit: String,
    pub encoder: String,
    /// 当前族的新建面板默认参数（面板「更多设置」读它）
    pub defaults: GenDefaults,
    /// local / api：这一张会走哪条路
    pub provider: &'static str,
    /// 走 API 时用的模型名（本地模式为空）
    pub api_model: String,
    /// API 配置的毛病：启用了但缺哪样，或者为 None 表示没配好也没启用
    pub api_problem: Option<String>,
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
    /// 当前族：qwen21 / h3image
    pub family: &'static str,
    pub family_label: &'static str,
    /// 出图边长上限（Qwen 2048，H3 4096）
    pub max_side: i32,
    /// 这一族支持的模式：t2i / i2i / edit / inpaint / upscale
    pub modes: Vec<&'static str>,
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
    /// 建议那一套的文件
    pub needed: Vec<NeededRow>,
    /// DiT 的全部量化档，从小到大
    pub tiers: Vec<TierRow>,
}

#[derive(Clone, Deserialize)]
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
    /// 局部重绘的遮罩：PNG 的 base64，白=重绘、黑=保留，尺寸会自动缩到底图。
    #[serde(default)]
    pub mask: Option<String>,
    /// 用哪一族：qwen21 / h3image。不给就用设置里当前选的那一族；
    /// 给了会先把当前族切过去（下次面板出图也跟着用这套）。
    #[serde(default)]
    pub family: Option<String>,
    /// 高清放大后要不要再补一遍低强度重绘（长出原图没有的纹理）
    #[serde(default)]
    pub refine: Option<bool>,
    /// 补细节那一步的改动幅度，默认 0.25；0 等于不补，太大就改了原图
    #[serde(default)]
    pub refine_strength: Option<f32>,
}

/// 输入图的三种吃法，外加一条完全不碰扩散模型的放大路。
#[derive(Copy, Clone, PartialEq, Eq)]
pub(crate) enum Mode {
    Text,
    /// 一张底图 + strength 重绘
    Image,
    /// 多张参考图（Qwen-Image 2.1 吃 ref-latent）
    Reference,
    /// 纯 ESRGAN 前向，输出 4×。不吃提示词、不载入那 12 GB 权重
    Upscale,
    /// 局部重绘：一张底图 + 一张遮罩，只有白的地方按提示词重画
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


/// 尺寸必须是 32 的倍数（上游文档），面板给的下拉已经满足；agent 直传时在这儿兜住。
/// 上限按模型族走：Qwen 2048，H3-Image 4096（16MP 实测能出）。
fn fit_size(width: Option<i32>, height: Option<i32>, max_side: i32) -> (i32, i32) {
    let snap = |value: i32| (value / 32).max(1) * 32;
    let w = snap(width.unwrap_or(DEFAULT_SIZE));
    let h = snap(height.unwrap_or(DEFAULT_SIZE));
    (w.clamp(256, max_side), h.clamp(256, max_side))
}

fn cstring(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "提示词里有不能用的字符".to_string())
}

fn cpath(path: &Path) -> CString {
    CString::new(path.as_os_str().to_string_lossy().into_owned()).expect("路径里有 0")
}

/// 这一轮真会载入的文件里，哪些不在目录里。视觉投影不在必需名单上：
/// 缺了它出不了图生图和编辑，纯文生图照样能跑，别拿它拦「开始」。
/// 目录里认到同名以外的文件时按种类解析，用户不必把文件改成内置名字。
fn missing_weights(dir: &Path, weights: &Weights, family: Family) -> Vec<String> {
    let resolved = resolve_weights(dir, family, weights);
    let vae = resolve_vae(dir, family).unwrap_or_else(|| family.vae().0.to_string());
    [resolved.dit, resolved.encoder, vae]
        .into_iter()
        .filter(|name| !dir.join(name).is_file())
        .collect()
}

/// 目录里同一种类可能有多份（不同量化档）。给没有内置名字的文件打分挑一份：
/// 高分辨率优先、贴近推荐档的加分，避免把 Q8 当默认。
fn pick_kind(dir: &Path, want: Kind, family: Family) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(i32, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if weight_kind(&name) != Some(want) {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        let mut score = 0;
        match want {
            Kind::Dit => {
                if family == Family::H3Image && lower.contains("minimax") {
                    score += 40;
                }
                if lower.contains("ad") {
                    score += 10;
                }
                if lower.contains("q4") {
                    score += 10;
                }
            }
            Kind::Encoder => {
                if lower.contains("q2") || lower.contains("int8") {
                    score += 10;
                }
                if lower.contains("minimax") || lower.contains("h3") {
                    score += 20;
                }
            }
            Kind::Vae => {
                if lower.contains("fp16") {
                    score += 10;
                }
                if family == Family::H3Image && lower.contains("h3") {
                    score += 10;
                }
            }
            _ => {}
        }
        if best.as_ref().is_none_or(|(current, _)| score > *current) {
            best = Some((score, name));
        }
    }
    best.map(|(_, name)| name)
}

/// 配置里的名字不在目录里就按种类换一份；在就照旧，绝不偷偷换掉用户点名的档。
fn resolve_weights(dir: &Path, family: Family, base: &Weights) -> Weights {
    let mut next = base.clone();
    if !dir.join(&next.dit).is_file() {
        if let Some(name) = pick_kind(dir, Kind::Dit, family) {
            next.dit = name;
        }
    }
    if !dir.join(&next.encoder).is_file() {
        if let Some(name) = pick_kind(dir, Kind::Encoder, family) {
            next.encoder = name;
        }
    }
    next
}

fn resolve_vae(dir: &Path, family: Family) -> Option<String> {
    let (name, _) = family.vae();
    if dir.join(name).is_file() {
        return Some(name.to_string());
    }
    pick_kind(dir, Kind::Vae, family)
}

