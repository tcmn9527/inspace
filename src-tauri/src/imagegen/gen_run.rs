use super::*;
use super::model_files::apply_family;
use super::pipeline::{upscale_job, generate, png_data_url, on_progress, on_preview, on_log};

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
    /* API 启用就整条路走远端：配置不全也不偷偷退回本地——
       那会变成几十秒的本地生成，和「配置了就走 API」相悖。缺什么直接报。 */
    let api = core.api();
    if api.enabled {
        if let Some(problem) = api.problem() {
            return Err(format!("API 配置不完整：{problem}。去设置 → 生图模型里补上"));
        }
        /* 高清放大例外：它只用本机的 ESRGAN 放大权重，不吃远端模型，
           后台直接走本地，不拿「API 不支持」把这条路堵死 */
        if Mode::pick(req.mode.as_deref(), req.images.len()) == Mode::Upscale {
            return begin_upscale(core, app, req, block);
        }
        return begin_api(core, app, req, block, api);
    }
    /* 放大这一档不碰扩散模型：既不载入那 12 GB，也不走 ctx，自成一条路 */
    if Mode::pick(req.mode.as_deref(), req.images.len()) == Mode::Upscale {
        return begin_upscale(core, app, req, block);
    }
    /* 请求里点名了另一族：先切过去（持久化），这一次和下次都按它来。
       名字写错就报错，别静默拿旧模型出图。 */
    if let Some(requested) = req.family.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        match Family::from_id(requested) {
            Some(family) if family != core.family() => {
                apply_family(core.clone(), app.clone(), family.id())?;
            }
            Some(_) => {}
            None => return Err(format!("没有这个模型：{requested}")),
        }
    }
    let family = core.family();
    let mode = Mode::pick(req.mode.as_deref(), req.images.len());
    if !family.supports(mode) {
        return Err(match mode {
            Mode::Image => format!(
                "{} 不支持图生图；要拿参考图改画风/改内容，用参考图编辑（mode=edit）",
                family.label()
            ),
            Mode::Inpaint => format!("{} 暂不支持局部重绘", family.label()),
            _ => format!("{} 不支持这个模式", family.label()),
        });
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
        engine.block = block.clone();
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
        engine.block = block.clone();
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

/// API 这一趟：按设置的并行上限起一条独立任务，不占本地引擎，多块可以同时跑。
/// 网络那头掐不断，「停止」只留标志位，请求回来再认这张作废——和放大那条路一个道理。
fn begin_api(
    core: GenCore,
    app: tauri::AppHandle,
    req: GenRequest,
    block: String,
    config: ApiConfig,
) -> Result<(), String> {
    let limit = config.parallel_limit();
    let cancel = {
        let mut jobs = core
            .api_jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if jobs.contains_key(&block) {
            return Err("这块正在出图，等这一张跑完".to_string());
        }
        if jobs.len() >= limit {
            return Err(format!("API 并行已满（{limit} 个），等一个跑完再点"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(
            block.clone(),
            ApiJob {
                cancel: Arc::clone(&cancel),
            },
        );
        cancel
    };
    thread::spawn(move || {
        let started = Instant::now();
        /* 一条 0/0 的进度：前端拿它把「载入权重…」换成「生成中…」 */
        let _ = app.emit(
            "gen-progress",
            ProgressEvent {
                block: block.clone(),
                step: 0,
                steps: 0,
                seconds: 0.0,
            },
        );
        let outcome = imageapi::generate(&config, &req, &cancel);
        if let Ok(mut jobs) = core.api_jobs.lock() {
            jobs.remove(&block);
        }
        let canceled = cancel.load(Ordering::Relaxed);
        emit_outcome(&app, block, outcome, started.elapsed().as_secs_f32(), canceled);
    });
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

/// 停止一轮：给了块 id 就只停那一块（API 并行时各停各的），不给就全停。
/// 这里不碰那把锁——它正被「载入权重」占着的时候，等锁就是卡界面。
#[tauri::command]
pub fn gen_cancel(state: tauri::State<GenState>, block: Option<String>) -> bool {
    let core = state.0.clone();
    let mut hit = false;
    /* API 任务：各带各的取消标志 */
    if let Ok(mut jobs) = core.api_jobs.lock() {
        match block.as_deref() {
            Some(target) => {
                if let Some(job) = jobs.get(target) {
                    job.cancel.store(true, Ordering::Relaxed);
                    hit = true;
                }
            }
            None => {
                for job in jobs.values() {
                    job.cancel.store(true, Ordering::Relaxed);
                }
                hit |= !jobs.is_empty();
            }
        }
    }
    /* 本地/放大那一条：一次只有一块，engine.block 认人 */
    match core.engine.try_lock() {
        Ok(engine) => {
            let mine = engine.busy
                && block.as_deref().is_none_or(|target| target == engine.block);
            if mine {
                core.cancel.store(true, Ordering::Relaxed);
                if !engine.ctx.is_null() {
                    unsafe { sd::sd_cancel_generation(engine.ctx, sd::sd_cancel_mode_t::SD_CANCEL_ALL) };
                }
                hit = true;
            }
        }
        /* 锁被「载入权重」占着：认不出块，给的是哪块都按这块处理，只留标志位 */
        Err(_) => {
            core.cancel.store(true, Ordering::Relaxed);
            hit = true;
        }
    }
    hit
}

/// 权重是惰性的：new_sd_ctx 只登记，真正搬上卡发生在第一次出图里。
pub(super) fn ensure_ctx(core: &GenCore, engine: &mut Engine) -> Result<*mut sd::sd_ctx_t, String> {
    if !engine.ctx.is_null() {
        return Ok(engine.ctx);
    }
    let family = core.family();
    let dir = core.models();
    let weights = resolve_weights(&dir, family, &core.weights());
    let missing = missing_weights(&dir, &weights, family);
    if !missing.is_empty() {
        return Err(format!("权重还没下全，缺：{}", missing.join("、")));
    }
    // 这几条 CString 必须活到 new_sd_ctx 返回之后，所以只能在栈上捏着
    let diffusion = cpath(&dir.join(&weights.dit));
    let encoder = cpath(&dir.join(&weights.encoder));
    let vae_name = resolve_vae(&dir, family).unwrap_or_else(|| family.vae().0.to_string());
    let vae = cpath(&dir.join(&vae_name));
    /* 视觉投影是 Qwen 的可选件：没有它就出不了图生图和编辑，纯文生图照跑。
       H3 的编码器自带视觉塔，不填这个槽。 */
    let vision = if family == Family::Qwen21 {
        let vision_path = dir.join(DEFAULT_VISION);
        vision_path.is_file().then(|| cpath(&vision_path))
    } else {
        None
    };
    let cpu_mode = engine.device == "cpu";
    let budget = CString::new(VRAM_BUDGET).expect("常量串");
    let params_backend = CString::new("cpu").expect("常量串");
    let main_backend = CString::new(if cpu_mode { "cpu" } else { "" }).expect("常量串");
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
        params.flash_attn = !cpu_mode;
        params.diffusion_flash_attn = !cpu_mode;
        params.max_vram = if cpu_mode { std::ptr::null() } else { budget.as_ptr() };
        params.backend = main_backend.as_ptr();
        params.params_backend = params_backend.as_ptr();
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
    let family = core.family();
    let outcome = unsafe {
        sd::sd_set_progress_callback(Some(on_progress), sink_ptr);
        // proj 模式是 latent 到 RGB 的一次线性投影，Qwen 2.1 有现成的投影表，
        // 不用多下一个预览用的小 VAE，代价几乎看不出来。H3 没有这张投影表。
        if family == Family::Qwen21 {
            sd::sd_set_preview_callback(
                Some(on_preview),
                sd::preview_t::PREVIEW_PROJ,
                1,
                true,
                false,
                sink_ptr,
            );
        }
        let out = generate(ctx, &req, family);
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

/// 对已落盘的旧图原地去网格：修复前生成的图像素里还带棋盘，重出才会换掉；
/// 这个命令让旧图不重出构图也能清干净。只读 images/ 里指定的相对路径。
#[tauri::command]
pub fn gen_degrid(
    app: tauri::AppHandle,
    id: String,
    srcs: Vec<String>,
) -> Result<u32, String> {
    let data = app.state::<crate::store::DataRoot>();
    let dir = data
        .dir(crate::store::SPACE_DIR)
        .join(&id)
        .join("images");
    let mut done = 0u32;
    for src in srcs {
        let rel = src.trim();
        if rel.is_empty() || rel.contains("..") || rel.starts_with('/') || rel.contains(':') {
            continue;
        }
        let path = dir.join(rel);
        if !path.is_file() {
            continue;
        }
        let img = image::open(&path).map_err(|e| format!("读图失败 {rel}: {e}"))?;
        let rgb = img.to_rgb8();
        let (w, h) = rgb.dimensions();
        let mut pixels = rgb.into_raw();
        dechecker(&mut pixels, w, h, 3);
        let out = image::RgbImage::from_raw(w, h, pixels)
            .ok_or_else(|| format!("尺寸不合 {rel}"))?;
        out.save(&path).map_err(|e| format!("写图失败 {rel}: {e}"))?;
        done += 1;
    }
    Ok(done)
}

/// 消解码网格：H3 的 VAE 会在平坦区（皮肤/墙/纯色布）留一层细棋盘网格，周期随图变化，
/// 单一陷波滤不干净。改用 sigma≈2 的高斯平滑，但按局部梯度做边缘感知混合：
/// 平坦区全力平滑把网格抹掉，头发/衣纹/轮廓等高频处保持原样不糊。
fn dechecker(pixels: &mut [u8], width: u32, height: u32, channel: u32) {
    let w = width as usize;
    let h = height as usize;
    let ch = channel.max(1) as usize;
    if w < 9 || h < 9 || pixels.len() < w * h * ch {
        return;
    }
    // sigma=2 的高斯核（-4..4 归一化）
    const K: [f32; 5] = [0.0276, 0.0663, 0.1238, 0.1802, 0.2042];
    let luma = |p: &[u8], at: usize| -> f32 {
        if ch >= 3 {
            0.299 * p[at] as f32 + 0.587 * p[at + 1] as f32 + 0.114 * p[at + 2] as f32
        } else {
            p[at] as f32
        }
    };
    // 可分离高斯：横 -> tmp，竖 -> blurred
    let mut tmp = vec![0f32; pixels.len()];
    for y in 0..h {
        for x in 0..w {
            for k in 0..ch {
                let mut s = 0f32;
                for d in 0..5 {
                    let xx = (x + d).saturating_sub(4).min(w - 1);
                    // 对称核：中心权重 K[4]，两侧 K[3..0]
                    let wt = if d == 4 { K[4] } else { K[d] };
                    s += pixels[(y * w + xx) * ch + k] as f32 * wt;
                    if d != 4 {
                        let xx2 = (x + (4 - d)).min(w - 1);
                        s += pixels[(y * w + xx2) * ch + k] as f32 * wt;
                    }
                }
                tmp[(y * w + x) * ch + k] = s;
            }
        }
    }
    let mut blurred = vec![0f32; pixels.len()];
    for y in 0..h {
        for x in 0..w {
            for k in 0..ch {
                let mut s = 0f32;
                for d in 0..5 {
                    let yy = (y + d).saturating_sub(4).min(h - 1);
                    let wt = if d == 4 { K[4] } else { K[d] };
                    s += tmp[(yy * w + x) * ch + k] * wt;
                    if d != 4 {
                        let yy2 = (y + (4 - d)).min(h - 1);
                        s += tmp[(yy2 * w + x) * ch + k] * wt;
                    }
                }
                blurred[(y * w + x) * ch + k] = s;
            }
        }
    }
    // 边缘感知混合
    for y in 0..h {
        for x in 0..w {
            let at = (y * w + x) * ch;
            let xl = (y * w + x.saturating_sub(1)) * ch;
            let xr = (y * w + (x + 1).min(w - 1)) * ch;
            let yu = (y.saturating_sub(1) * w + x) * ch;
            let yd = ((y + 1).min(h - 1) * w + x) * ch;
            let grad = (luma(pixels, xr) - luma(pixels, xl)).abs()
                + (luma(pixels, yd) - luma(pixels, yu)).abs();
            let t = if grad < 8.0 {
                1.0
            } else if grad > 32.0 {
                0.0
            } else {
                (32.0 - grad) / 24.0
            };
            for k in 0..ch {
                let o = pixels[at + k] as f32;
                pixels[at + k] = (o * (1.0 - t) + blurred[at + k] * t).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// 本地两条路（扩散、放大）跑完都从这儿收尾：交还 busy，再把这一张或这条错发回前端。
pub(super) fn finish(
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
        engine.block.clear();
        engine.last_used = Instant::now();
    }
    emit_outcome(app, block, outcome, seconds, canceled);
}

/// 一轮的结果统一从这儿发出去：本地、放大、API 三条路共用。
fn emit_outcome(
    app: &tauri::AppHandle,
    block: String,
    outcome: Result<Out, String>,
    seconds: f32,
    canceled: bool,
) {
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
        Ok(mut image) => {
            /* H3 的 VAE 解码会在平坦区留一层细棋盘网格（转置卷积固有伪影）。
               边缘感知的高斯平滑：平坦区抹平细网格，高频结构处保持原样。 */
            dechecker(&mut image.pixels, image.width, image.height, image.channel);
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

