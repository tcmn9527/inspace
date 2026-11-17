use super::*;
use super::gen_run::{finish, ensure_ctx};

pub(super) fn upscale_job(
    core: GenCore,
    app: tauri::AppHandle,
    model: PathBuf,
    req: GenRequest,
    block: String,
) {
    let started = Instant::now();
    eprintln!("[gen] upscale refine={:?} prompt={:?}", req.refine, req.prompt.trim());
    let outcome = if req.refine == Some(true) {
        if core.family() == Family::H3Image {
            Err("H3-Image 不支持放大后的低强度重绘；把「补细节」关掉，只做纯 ESRGAN 放大".to_string())
        } else {
            refine_then_upscale(&core, &app, &block, &req, &model)
        }
    } else {
        upscale_run(&model, &req)
    };
    finish(&core, &app, block, outcome, started.elapsed().as_secs_f32());
}

/// 切片重绘：先把整张图 ESRGAN 放大，再切成带重叠的块，每块低强度重绘补细节，
/// 最后按羽化权重把重叠区融合回去——ComfyUI 那种切片放大的做法。
fn refine_then_upscale(
    core: &GenCore,
    app: &tauri::AppHandle,
    block: &str,
    req: &GenRequest,
    model: &Path,
) -> Result<Out, String> {
    let mut up_req = req.clone();
    up_req.refine = None;
    let big = upscale_run(model, &up_req)?;
    let prompt = if req.prompt.trim().is_empty() {
        REFINE_PROMPT.to_string()
    } else {
        req.prompt.clone()
    };
    let strength = req.refine_strength.unwrap_or(0.25).clamp(0.05, 0.6);
    /* 2048 的图切 3×3 共九块、每块约 810，重叠 128；更大的图再密一格 */
    let count = if big.width.max(big.height) > 2600 { 4 } else { 3 };
    let overlap = 128u32;
    let xs = axis_spans(big.width, count, overlap);
    let ys = axis_spans(big.height, count, overlap);
    let total = (xs.len() * ys.len()) as i32;
    let mut index = 0i32;
    /* 累加缓冲：每块结果按羽化权重往里加权，最后归一化 */
    let channels = big.channel.max(1) as usize;
    let mut acc = vec![0f32; big.pixels.len()];
    let mut weights = vec![0f32; (big.width * big.height) as usize];
    for (yi, &(ty, th)) in ys.iter().enumerate() {
        for (xi, &(tx, tw)) in xs.iter().enumerate() {
            if core.cancel.load(Ordering::Relaxed) {
                return Err("已取消".to_string());
            }
            index += 1;
            let _ = (index, total);
            let tile = Tile {
                x: tx,
                y: ty,
                w: tw,
                h: th,
            };
            let png = tile_png_base64(&big, &tile)?;
            let mut sub = req.clone();
            sub.mode = Some("i2i".to_string());
            sub.prompt = prompt.clone();
            sub.images = vec![png];
            sub.width = Some(tw as i32);
            sub.height = Some(th as i32);
            sub.strength = Some(strength);
            sub.refine = None;
            let ctx = {
                let mut engine = core.lock();
                ensure_ctx(core, &mut engine)?
            };
            let done = generate(Ctx(ctx), &sub, core.family())?;
            blend_tile(&mut acc, &mut weights, &big, &tile, &done, overlap, channels);
            /* 每补完一片就报进度、发一张「到目前为止」的缩略图：
               用户能看着画面一块块清晰起来，而不是对着「放大中…」干等 */
            let _ = app.emit(
                "gen-progress",
                ProgressEvent {
                    block: block.to_string(),
                    step: index,
                    steps: total,
                    seconds: 0.0,
                },
            );
            let mut preview = big.clone();
            paint_tile(&mut preview, &tile, &done);
            if let Ok(data_url) = thumb_data_url(&preview, 640) {
                let _ = app.emit(
                    "gen-preview",
                    PreviewEvent {
                        block: block.to_string(),
                        step: index,
                        steps: total,
                        data_url,
                    },
                );
            }
            let _ = (yi, xi);
        }
    }
    normalize_tiles(acc, weights, &big)
}

/// 预览用：把一片结果直接盖进大图（不做羽化，缩略图上够看）
fn paint_tile(big: &mut Out, tile: &Tile, done: &Out) {
    if done.width != tile.w || done.height != tile.h {
        return;
    }
    let dst_ch = big.channel.max(1) as usize;
    let src_ch = done.channel.max(1) as usize;
    for y in 0..tile.h {
        for x in 0..tile.w {
            let at = ((tile.y + y) * big.width + tile.x + x) as usize * dst_ch;
            let src = (y * tile.w + x) as usize * src_ch;
            for c in 0..dst_ch {
                if c < src_ch {
                    big.pixels[at + c] = done.pixels[src + c];
                }
            }
        }
    }
}

/// 缩略成小图当预览：整张 2048 的 PNG 有几 MB，推给前端太重
fn thumb_data_url(out: &Out, max_side: u32) -> Result<String, String> {
    let dynamic = match out.channel {
        3 => image::RgbImage::from_raw(out.width, out.height, out.pixels.clone())
            .map(image::DynamicImage::ImageRgb8),
        4 => image::RgbaImage::from_raw(out.width, out.height, out.pixels.clone())
            .map(image::DynamicImage::ImageRgba8),
        other => return Err(format!("预览图的通道数不对：{other}")),
    };
    let image = dynamic.ok_or_else(|| "预览图的像素尺寸对不上".to_string())?;
    let thumb = image.resize(max_side, max_side, image::imageops::FilterType::Triangle);
    let mut png = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("预览图编码失败：{e}"))?;
    Ok(format!("data:image/png;base64,{}", BASE64.encode(&png)))
}

struct Tile {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

/// 一根轴上的切片：count 格均分，格子之间各让出 overlap，边上的格子贴住图边
fn axis_spans(total: u32, count: u32, overlap: u32) -> Vec<(u32, u32)> {
    let count = count.max(1);
    let base = total.div_ceil(count);
    let mut out = Vec::new();
    for i in 0..count {
        let start = if i == 0 { 0 } else { i * base - overlap.min(i * base) };
        let end = if i + 1 == count {
            total
        } else {
            ((i + 1) * base + overlap).min(total)
        };
        if end > start {
            out.push((start, end - start));
        }
    }
    if out.is_empty() {
        out.push((0, total.max(1)));
    }
    out
}

/// 从大图里抠一块编成 PNG base64，给重绘当输入
fn tile_png_base64(big: &Out, tile: &Tile) -> Result<String, String> {
    let channels = big.channel.max(1) as usize;
    let mut pixels = Vec::with_capacity((tile.w * tile.h) as usize * channels);
    for y in 0..tile.h {
        let row = ((tile.y + y) * big.width + tile.x) as usize * channels;
        let end = row + tile.w as usize * channels;
        pixels.extend_from_slice(&big.pixels[row..end]);
    }
    let out = Out {
        pixels,
        width: tile.w,
        height: tile.h,
        channel: big.channel,
    };
    out_to_png_base64(&out)
}

/// 把一块重绘结果按羽化权重累加回大图
fn blend_tile(
    acc: &mut [f32],
    weights: &mut [f32],
    big: &Out,
    tile: &Tile,
    done: &Out,
    overlap: u32,
    channels: usize,
) {
    if done.width != tile.w || done.height != tile.h {
        return;
    }
    /* 重绘结果可能是 3 通道、放大图是 4 通道（或反过来）：按各自的步长取，
       少了 alpha 就补不透明。混着读就是一道道竖条纹 */
    let src_channels = done.channel.max(1) as usize;
    let left_edge = tile.x == 0;
    let right_edge = tile.x + tile.w == big.width;
    let top_edge = tile.y == 0;
    let bottom_edge = tile.y + tile.h == big.height;
    let feather = |at: u32, total: u32, edge: bool| -> f32 {
        if edge || total <= 1 {
            return 1.0;
        }
        let d = at.min(total - 1 - at);
        (d as f32 / overlap.max(1) as f32).min(1.0)
    };
    for y in 0..tile.h {
        let wy = feather(y, tile.h, top_edge) * feather(tile.h - 1 - y, tile.h, bottom_edge);
        for x in 0..tile.w {
            let wx = feather(x, tile.w, left_edge) * feather(tile.w - 1 - x, tile.w, right_edge);
            let w = wx * wy;
            if w <= 0.0 {
                continue;
            }
            let at = ((tile.y + y) * big.width + tile.x + x) as usize;
            let src = (y * tile.w + x) as usize * src_channels;
            let dst = at * channels;
            for c in 0..channels {
                let value = if c < src_channels {
                    done.pixels[src + c]
                } else {
                    255
                };
                acc[dst + c] += value as f32 * w;
            }
            weights[at] += w;
        }
    }
}

fn normalize_tiles(acc: Vec<f32>, weights: Vec<f32>, big: &Out) -> Result<Out, String> {
    let mut pixels = vec![0u8; big.pixels.len()];
    let channels = big.channel.max(1) as usize;
    for at in 0..weights.len() {
        let w = weights[at];
        if w <= 0.0 {
            pixels[at * channels..(at + 1) * channels]
                .copy_from_slice(&big.pixels[at * channels..(at + 1) * channels]);
            continue;
        }
        for c in 0..channels {
            pixels[at * channels + c] = (acc[at * channels + c] / w).clamp(0.0, 255.0) as u8;
        }
    }
    Ok(Out {
        pixels,
        width: big.width,
        height: big.height,
        channel: big.channel,
    })
}

/// 把引擎结果编成 PNG base64，给补细节那一步当输入图
fn out_to_png_base64(out: &Out) -> Result<String, String> {
    let dynamic = match out.channel {
        3 => image::RgbImage::from_raw(out.width, out.height, out.pixels.clone())
            .map(image::DynamicImage::ImageRgb8),
        4 => image::RgbaImage::from_raw(out.width, out.height, out.pixels.clone())
            .map(image::DynamicImage::ImageRgba8),
        other => return Err(format!("放大结果的通道数不对：{other}")),
    };
    let image = dynamic.ok_or_else(|| "放大结果的像素尺寸对不上".to_string())?;
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("放大结果转 PNG 失败：{e}"))?;
    Ok(BASE64.encode(&png))
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

#[derive(Clone)]
pub(crate) struct Out {
    pub(crate) pixels: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) channel: u32,
}

pub(super) fn generate(ctx: Ctx, req: &GenRequest, family: Family) -> Result<Out, String> {
    let prompt = cstring(&req.prompt)?;
    let negative = cstring(req.negative.as_deref().unwrap_or(""))?;
    let (width, height) = fit_size(req.width, req.height, family.max_side());
    /* 0 或没给 = 跟着模型走（Qwen 30 步 / cfg 6，H3 6 步 / cfg 1）。 */
    let mut steps = match req.steps.filter(|value| *value > 0) {
        Some(steps) => steps.clamp(1, 100),
        None => family.default_steps(),
    };
    let mut cfg = match req.cfg.filter(|value| *value > 0.0) {
        Some(cfg) => cfg.clamp(1.0, 20.0),
        None => family.default_cfg(),
    };
    /* 老块上还留着 Qwen 那套老默认（20 步 / cfg 6）。H3 是 6 步蒸馏，
       按这两个数跑只会慢三倍、画面还容易过曝；两个都等于老 Qwen 默认时当成没设过。 */
    if family == Family::H3Image && steps == LEGACY_QWEN_STEPS && (cfg - DEFAULT_CFG).abs() < f32::EPSILON {
        steps = family.default_steps();
        cfg = family.default_cfg();
    }
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
    if family == Family::H3Image && inputs.len() > 16 {
        return Err("H3-Image 最多吃 16 张参考图".to_string());
    }
    let strength = req.strength.unwrap_or(DEFAULT_STRENGTH).clamp(0.0, 1.0);
    /* 遮罩和输入图一样得活过 generate_image：raw.data 指着它的堆内存 */
    let mask: Option<InputImage> = match req.mask.as_deref() {
        Some(text) if !text.trim().is_empty() => Some(decode_input(text)?),
        _ => None,
    };
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
        /* H3-Image 的 6 步蒸馏就配离散调度；Qwen 让它按模型自己选。 */
        params.sample_params.scheduler = match family {
            Family::Qwen21 => sd::sd_get_default_scheduler(ctx.0, method),
            Family::H3Image => sd::scheduler_t::DISCRETE_SCHEDULER,
        };
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
            /* 局部重绘：底图 + 遮罩，白的地方按提示词重画 */
            Mode::Inpaint => {
                let mask = mask
                    .as_ref()
                    .ok_or_else(|| "局部重绘要先在预览上涂出要重绘的区域".to_string())?;
                params.init_image = inputs[0].raw;
                params.mask_image = mask.raw;
                params.strength = strength;
            }
            /* 放大那一档在 begin() 就分岔走了，压根不会带着它走到这儿来碰扩散参数 */
            Mode::Upscale => unreachable!("高清放大不走扩散"),
        }

        let mut result: *mut sd::sd_image_generation_result_t = null_mut();
        let ok = sd::generate_image(ctx.0, &params, &mut result);
        read_back(result, ok, "出图失败")
    }
}

pub(super) unsafe extern "C" fn on_log(level: sd::sd_log_level_t, text: *const i8, _data: *mut c_void) {
    /* 枚举是 DEBUG 0 → ERROR 4 这么排的，所以「只放行警告和错误」得正着写：
       上一版写成 `> WARN 就丢`，把 ERROR 一起丢了，引擎为什么失败从来看不见 */
    if level != sd::sd_log_level_t::SD_LOG_WARN && level != sd::sd_log_level_t::SD_LOG_ERROR {
        return;
    }
    let text = unsafe { std::ffi::CStr::from_ptr(text) };
    eprintln!("[gen] {}", text.to_string_lossy().trim_end());
}

pub(super) unsafe extern "C" fn on_progress(step: i32, steps: i32, time: f32, data: *mut c_void) {
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

pub(super) unsafe extern "C" fn on_preview(
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
pub(super) fn png_data_url(pixels: &[u8], width: u32, height: u32, channel: u32) -> Option<String> {
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
