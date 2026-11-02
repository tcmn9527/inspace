/* 生图引擎的第一次落地验证（P0）。

   报三个数：能不能载入 Qwen-Image 2.1、单张 1024 多久、显存峰值多少。

   绑的是引擎的 C API（src-tauri/src/sdcpp.rs，bindgen 从上游头文件现生成）。
   之所以不用高层封装：高层每次出图都会 free 掉再重建 sd_ctx，
   也就是每点一次「开始」都要把 6GB 权重从盘上重读一遍。面板要的是常驻一个 ctx。

   跑法（环境由 msvc-env 注入）：
     node ../scripts/msvc-env.mjs cargo run --example genpoc
   用 debug：C++ 那侧 build.rs 已经钉死 Release，Rust 这边只搬参数，不影响速度，
   而 --release 会把整个依赖树再编一遍。

   环境变量：
     GENPOC_PARAMS=cpu|gpu   权重放哪。gpu（默认）=不设预算，一次全塞显存；
                             cpu=权重先进内存条，按 max_vram 预算现搬上卡（省显存、慢一点）。
     GENPOC_MODELS=<目录>    权重所在目录，默认取应用数据目录下的 gen/models。 */

use std::ffi::{c_void, CString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use inspace_lib::sdcpp as sd;

const PROMPT: &str = "a red apple on a wooden table, soft window light";
const SIZE: i32 = 1024;
const STEPS: i32 = 20;
// cpu 模式给显存留的预算（GiB）：超出部分留在内存条，算到哪搬到哪。
const VRAM_BUDGET: &str = "12";

fn models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("GENPOC_MODELS") {
        return PathBuf::from(dir);
    }
    let appdata = std::env::var("APPDATA").expect("没有 APPDATA，给 GENPOC_MODELS 指模型目录");
    PathBuf::from(appdata)
        .join("com.inspace.app")
        .join("data")
        .join("gen")
        .join("models")
}

fn cpath(path: &Path) -> CString {
    CString::new(path.as_os_str().to_string_lossy().into_owned()).expect("路径里有 0")
}

unsafe extern "C" fn on_log(_level: sd::sd_log_level_t, text: *const i8, _data: *mut c_void) {
    let text = std::ffi::CStr::from_ptr(text);
    println!("[sd] {}", text.to_string_lossy().trim_end());
}

unsafe extern "C" fn on_progress(step: i32, steps: i32, time: f32, _data: *mut c_void) {
    // step 从 0 起，time 是上一步花了多久
    println!("    step {}/{}  +{:.2}s", step + 1, steps, time);
}

/* 显存峰值：每半秒问一次 nvidia-smi，取最大值。
   ggml 不会把峰值报出来，只能自己在跑的过程中盯。 */
fn watch_vram(stop: &Arc<AtomicBool>) -> (Arc<AtomicU64>, thread::JoinHandle<()>) {
    let peak = Arc::new(AtomicU64::new(0));
    let sampler = {
        let stop = stop.clone();
        let peak = peak.clone();
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if let Some(used) = query_vram() {
                    peak.fetch_max(used, Ordering::Relaxed);
                }
                thread::sleep(Duration::from_millis(500));
            }
        })
    };
    (peak, sampler)
}

#[cfg(windows)]
fn query_vram() -> Option<u64> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_mib(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
fn query_vram() -> Option<u64> {
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    parse_mib(&String::from_utf8_lossy(&out.stdout))
}

fn parse_mib(csv: &str) -> Option<u64> {
    csv.lines().next()?.trim().parse().ok()
}

fn main() {
    let dir = models_dir();
    for name in [
        "qwen_image_2.1-Q6_K.gguf",
        "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
        "mmproj-Qwen3VL-8B-Instruct-F16.gguf",
        "qwen_image_2.1_vae_bf16.safetensors",
    ] {
        let path = dir.join(name);
        if !path.exists() {
            panic!("少了权重文件：{}", path.display());
        }
    }

    let diffusion_model = cpath(&dir.join("qwen_image_2.1-Q6_K.gguf"));
    let llm = cpath(&dir.join("Qwen3VL-8B-Instruct-Q4_K_M.gguf"));
    let llm_vision = cpath(&dir.join("mmproj-Qwen3VL-8B-Instruct-F16.gguf"));
    let vae = cpath(&dir.join("qwen_image_2.1_vae_bf16.safetensors"));

    // backend/params_backend 只认这两种写法：整段一个词 = 所有模块的默认，
    // 写 module=cpu 这种引擎不认的模块名会直接 unknown backend module 失败。
    let keep_on_gpu = std::env::var("GENPOC_PARAMS").unwrap_or_default() != "cpu";
    let params_backend = (!keep_on_gpu).then(|| CString::new("cpu").expect("常量串"));
    let max_vram = (!keep_on_gpu).then(|| CString::new(VRAM_BUDGET).expect("常量串"));

    unsafe {
        sd::sd_set_log_callback(Some(on_log), null_mut());
        sd::sd_set_progress_callback(Some(on_progress), null_mut());
        println!(
            "[sd] {}",
            std::ffi::CStr::from_ptr(sd::sd_version()).to_string_lossy()
        );

        let mut ctx_params = std::mem::MaybeUninit::<sd::sd_ctx_params_t>::uninit();
        sd::sd_ctx_params_init(ctx_params.as_mut_ptr());
        let mut ctx_params = ctx_params.assume_init();
        ctx_params.diffusion_model_path = diffusion_model.as_ptr();
        ctx_params.llm_path = llm.as_ptr();
        ctx_params.llm_vision_path = llm_vision.as_ptr();
        ctx_params.vae_path = vae.as_ptr();
        ctx_params.flash_attn = true;
        // 预算空着 = 按当前空闲显存全放；给了数就按这个数切，超出的留在 params_backend。
        ctx_params.max_vram = max_vram.as_ref().map_or(std::ptr::null(), |s| s.as_ptr());
        ctx_params.params_backend = params_backend
            .as_ref()
            .map_or(std::ptr::null(), |spec| spec.as_ptr());

        let load_started = Instant::now();
        let sd_ctx = sd::new_sd_ctx(&ctx_params);
        if sd_ctx.is_null() {
            panic!("载入失败：new_sd_ctx 返回空，看上面 [sd] 的报错");
        }
        println!("载入耗时：{:.1} 秒", load_started.elapsed().as_secs_f32());
        println!(
            "模型：{}",
            std::ffi::CStr::from_ptr(sd::sd_get_model_version_name(sd_ctx)).to_string_lossy()
        );
        println!(
            "系统信息：\n{}",
            std::ffi::CStr::from_ptr(sd::sd_get_system_info()).to_string_lossy()
        );

        let stop = Arc::new(AtomicBool::new(false));
        let (peak, sampler) = watch_vram(&stop);

        let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target");
        for (index, name) in [("冷", "genpoc-cold.png"), ("热", "genpoc-warm.png")] {
            let out = out_dir.join(name);
            let started = Instant::now();
            generate(sd_ctx, &out);
            println!(
                "第 {index} 张：{:.1} 秒 → {}",
                started.elapsed().as_secs_f32(),
                out.display()
            );
        }

        stop.store(true, Ordering::Relaxed);
        sampler.join().unwrap();
        println!("显存峰值：{} MiB", peak.load(Ordering::Relaxed));

        sd::free_sd_ctx(sd_ctx);
    }
}

unsafe fn generate(sd_ctx: *mut sd::sd_ctx_t, out: &Path) {
    let prompt = CString::new(PROMPT).unwrap();
    let negative = CString::new("").unwrap();

    let mut params = std::mem::MaybeUninit::<sd::sd_img_gen_params_t>::uninit();
    sd::sd_img_gen_params_init(params.as_mut_ptr());
    let mut params = params.assume_init();

    params.prompt = prompt.as_ptr();
    params.negative_prompt = negative.as_ptr();
    params.width = SIZE;
    params.height = SIZE;
    params.seed = 42;
    params.batch_count = 1;

    params.sample_params.sample_method = sd::sample_method_t::EULER_SAMPLE_METHOD;
    params.sample_params.scheduler =
        sd::sd_get_default_scheduler(sd_ctx, params.sample_params.sample_method);
    params.sample_params.sample_steps = STEPS;
    // 只按上游 docs/qwen_image_2.1.md 给的数：cfg 6.0。
    // flow_shift / eta / img_cfg 的默认值是 INFINITY = 让引擎按分辨率自己选流程；
    // 手写死（3.0 / 0.0）会把 sigma 调度整个带偏，出来就是灰糊糊一片。
    params.sample_params.guidance.txt_cfg = 6.0;

    // 开着 tiling 出的是 3×3 带接缝的方块网纹，先做关掉的对照
    params.vae_tiling_params.enabled = std::env::var("GENPOC_TILING").unwrap_or_default() == "on";
    params.vae_tiling_params.tile_size_w = 256;
    params.vae_tiling_params.tile_size_h = 256;
    params.vae_tiling_params.target_overlap = 0.5;

    // 出图结果自己持有像素和 generation_info，跟 ctx 生命周期无关
    let mut result: *mut sd::sd_image_generation_result_t = std::ptr::null_mut();
    if !sd::generate_image(sd_ctx, &params, &mut result) || result.is_null() {
        panic!("出图失败：generate_image 返回 false，看上面 [sd] 的报错");
    }
    {
        let batch = &*result;
        if batch.count < 1 {
            panic!("出图失败：结果里一张都没有");
        }
        let image = batch.items.as_ref().expect("batch 至少有一张").image;
        println!(
            "像素：{}x{}x{}",
            image.width, image.height, image.channel
        );
        let pixels = std::slice::from_raw_parts(
            image.data,
            (image.width * image.height * image.channel) as usize,
        );
        // Qwen-Image 2.1 的 VAE 出的是 RGBA（4 通道）。按 3 通道切缓冲不会报错，
        // 只会每 12 字节错位一次 —— 出来的就是满屏重复的网点。
        match image.channel {
            4 => image::RgbaImage::from_raw(image.width, image.height, pixels.to_vec())
                .expect("RGBA 像素数和尺寸不匹配")
                .save(out),
            3 => image::RgbImage::from_raw(image.width, image.height, pixels.to_vec())
                .expect("RGB 像素数和尺寸不匹配")
                .save(out),
            other => panic!("没见过的通道数 {other}"),
        }
        .expect("存不下");
    }
    sd::free_sd_image_generation_result(result);
}
