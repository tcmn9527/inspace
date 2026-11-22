// 纹理链 worker：独立进程链接 libtorch（静态导入 torch.dll），主程序不链接 tch，
// 启动时不会被 5.5GB 的 libtorch 依赖拖住。主程序设置 PATH 后拉起本进程。
//
// 输入：prep.bin（delight_in [3,512,512] f32 + rgb_target [512,512,3] f32 + alpha [512,512] u8）
// 输出：<out_dir>/view0..5.png（多视图扩散解码结果）
// 进度：stdout 每次输出一行 "PROGRESS <stage> <0..1>"

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use half::f16;

const RES: usize = 512;
const L: usize = 64;
const CH: usize = 4;
const NV: usize = 6 * CH * L * L;
const ELEVS: [f64; 6] = [0.0, 0.0, 0.0, 0.0, 90.0, -90.0];
const AZIMS: [f64; 6] = [0.0, 90.0, 180.0, 270.0, 0.0, 180.0];

struct Consts {
    d_text_emb: Vec<f32>,
    mv_ehs: Vec<f32>,
    d_sigmas: Vec<f32>,
    d_timesteps: Vec<f32>,
    mv_sigmas: Vec<f32>,
    mv_timesteps: Vec<f32>,
}

fn read_bin(path: &Path, expect: usize) -> Result<Vec<f32>, String> {
    let data = fs::read(path).map_err(|e| format!("读不了 {}: {e}", path.display()))?;
    if data.len() != expect * 4 {
        return Err(format!("{} 大小不对", path.display()));
    }
    Ok(data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

fn f16_t(data: &[f32], shape: &[i64]) -> tch::Tensor {
    let h: Vec<f16> = data.iter().map(|&v| f16::from_f32(v)).collect();
    tch::Tensor::from_slice(&h).reshape(shape)
}

fn to_vec_f32(t: &tch::Tensor) -> Result<Vec<f32>, String> {
    Vec::<f32>::try_from(t.to_kind(tch::Kind::Float).view(-1)).map_err(|e| format!("读推理结果失败：{e}"))
}

fn randn(n: usize, seed: u64) -> Vec<f32> {
    let mut s = seed | 1;
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let u1 = ((s >> 11) as f64 + 0.5) / (1u64 << 53) as f64;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let u2 = ((s >> 11) as f64 + 0.5) / (1u64 << 53) as f64;
        let r = (-2.0 * u1.ln()).sqrt();
        let th = 2.0 * std::f64::consts::PI * u2;
        out.push((r * th.cos()) as f32);
        if out.len() < n {
            out.push((r * th.sin()) as f32);
        }
    }
    out
}

fn report(stage: &str, value: f64) {
    println!("PROGRESS {stage} {value:.4}");
    let _ = std::io::stdout().flush();
}

fn cam_code(elev: f64, azim: f64) -> i64 {
    let base = (azim as i64 / 30 + 9) % 12;
    let (div, add) = match elev as i64 {
        -90 => (3, 36),
        90 => (3, 40),
        -20 => (1, 0),
        20 => (1, 24),
        _ => (1, 12),
    };
    base / div + add
}

fn recorrect(src: &[[f64; 3]], target: &[[f64; 3]], alpha: &[u8]) -> Vec<[f64; 3]> {
    let mut cnt = 0f64;
    let mut s_mean = [0f64; 3];
    let mut t_mean = [0f64; 3];
    for i in 0..RES * RES {
        if alpha[i] as f64 / 255.0 > 0.5 {
            cnt += 1.0;
            for c in 0..3 {
                s_mean[c] += src[i][c];
                t_mean[c] += target[i][c];
            }
        }
    }
    if cnt < 1.0 {
        return src.to_vec();
    }
    for c in 0..3 {
        s_mean[c] /= cnt;
        t_mean[c] /= cnt;
    }
    let mut s_var = [0f64; 3];
    let mut t_var = [0f64; 3];
    for i in 0..RES * RES {
        if alpha[i] as f64 / 255.0 > 0.5 {
            for c in 0..3 {
                s_var[c] += (src[i][c] - s_mean[c]).powi(2);
                t_var[c] += (target[i][c] - t_mean[c]).powi(2);
            }
        }
    }
    let s_std: Vec<f64> = (0..3).map(|c| (s_var[c] / cnt).sqrt().max(1e-6)).collect();
    let t_std: Vec<f64> = (0..3).map(|c| (t_var[c] / cnt).sqrt()).collect();
    let mut out = vec![[0f64; 3]; RES * RES];
    let mut mse_src = 0f64;
    let mut mse_mod = 0f64;
    for i in 0..RES * RES {
        for c in 0..3 {
            out[i][c] =
                ((src[i][c] - 0.95 * s_mean[c]) * (t_std[c] / s_std[c]) + 0.95 * t_mean[c]).clamp(0.0, 1.0);
        }
        if alpha[i] as f64 / 255.0 > 0.5 {
            for c in 0..3 {
                mse_src += (src[i][c] - target[i][c]).powi(2);
                mse_mod += (out[i][c] - target[i][c]).powi(2);
            }
        }
    }
    if mse_src < mse_mod {
        src.to_vec()
    } else {
        out
    }
}

fn run(prep_file: &Path, out_dir: &Path, jit: &Path, seed: u64) -> Result<(), String> {
    let cuda = tch::Device::Cuda(0);
    let _ng = tch::no_grad_guard();

    // prep.bin：delight_in + rgb_target + alpha
    let raw = fs::read(prep_file).map_err(|e| format!("读不了预处理结果：{e}"))?;
    let n1 = 3 * RES * RES * 4;
    let n2 = RES * RES * 3 * 4;
    if raw.len() != n1 + n2 + RES * RES {
        return Err("预处理结果大小不对".to_string());
    }
    let delight_in: Vec<f32> = raw[..n1].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let rgb_target: Vec<f64> = raw[n1..n1 + n2]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64)
        .collect();
    let alpha = &raw[n1 + n2..];

    let consts = Consts {
        d_text_emb: read_bin(&jit.join("d_text_emb.bin"), 77 * 1024)?,
        mv_ehs: read_bin(&jit.join("mv_ehs.bin"), 2 * 77 * 1024)?,
        d_sigmas: read_bin(&jit.join("d_sigmas.bin"), 51)?,
        d_timesteps: read_bin(&jit.join("d_timesteps.bin"), 50)?,
        mv_sigmas: read_bin(&jit.join("mv_sigmas.bin"), 31)?,
        mv_timesteps: read_bin(&jit.join("mv_timesteps.bin"), 30)?,
    };

    report("worker", 0.0);

    /* 1) delight 去光照（无 CFG，50 步 EulerA v_prediction） */
    let venc_d = tch::CModule::load(jit.join("delight_venc.pt")).map_err(|e| format!("加载去光照编码模型失败：{e}"))?;
    let unet_d = tch::CModule::load(jit.join("delight_unet.pt")).map_err(|e| format!("加载去光照模型失败：{e}"))?;
    let vdec_d = tch::CModule::load(jit.join("delight_vdec.pt")).map_err(|e| format!("加载去光照解码模型失败：{e}"))?;
    let img_t = f16_t(&delight_in, &[1, 3, RES as i64, RES as i64]).to_device(cuda);
    let params = venc_d.forward_ts(&[img_t]).map_err(|e| format!("去光照编码失败：{e}"))?;
    let params = to_vec_f32(&params)?;
    let mut x: Vec<f32> = params[..CH * L * L].iter().map(|&v| v * 0.18215).collect();
    let emb = f16_t(&consts.d_text_emb, &[1, 77, 1024]).to_device(cuda);
    let img_lat = f16_t(&x, &[1, CH as i64, L as i64, L as i64]).to_device(cuda);
    let noises = randn(50 * CH * L * L, seed ^ 0x9e3779b97f4a7c15);
    for i in 0..50usize {
        let sigma = consts.d_sigmas[i] as f64;
        let sigma_to = consts.d_sigmas[i + 1] as f64;
        let scale = 1.0 / (sigma * sigma + 1.0).sqrt();
        let scaled: Vec<f32> = x.iter().map(|&v| (v as f64 * scale) as f32).collect();
        let sample = f16_t(&scaled, &[1, CH as i64, L as i64, L as i64]).to_device(cuda);
        let ts = f16_t(&[consts.d_timesteps[i]], &[]).to_device(cuda);
        let out = unet_d
            .forward_ts(&[sample, ts, img_lat.shallow_clone(), emb.shallow_clone()])
            .map_err(|e| format!("去光照第 {} 步失败：{e}", i + 1))?;
        let pred = to_vec_f32(&out)?;
        let sigma_up =
            (sigma_to * sigma_to * (sigma * sigma - sigma_to * sigma_to) / (sigma * sigma)).max(0.0).sqrt();
        let sigma_down = (sigma_to * sigma_to - sigma_up * sigma_up).max(0.0).sqrt();
        let base = i * CH * L * L;
        for k in 0..(CH * L * L) {
            let s = x[k] as f64;
            let v = pred[k] as f64;
            let orig = v * (-sigma / (sigma * sigma + 1.0).sqrt()) + s / (sigma * sigma + 1.0);
            let deriv = (s - orig) / sigma;
            x[k] = (s + deriv * (sigma_down - sigma) + noises[base + k] as f64 * sigma_up) as f32;
        }
        report("delight", 0.5 * (i + 1) as f64 / 50.0);
    }
    let lat = f16_t(&x, &[1, CH as i64, L as i64, L as i64]).to_device(cuda);
    let dec = vdec_d.forward_ts(&[lat]).map_err(|e| format!("去光照解码失败：{e}"))?;
    let decv = to_vec_f32(&dec)?;
    drop(venc_d);
    drop(unet_d);
    drop(vdec_d);
    let mut src = vec![[0f64; 3]; RES * RES];
    for i in 0..RES * RES {
        for c in 0..3 {
            src[i][c] = ((decv[c * RES * RES + i] / 2.0 + 0.5) as f64).clamp(0.0, 1.0);
        }
    }
    let target: Vec<[f64; 3]> = (0..RES * RES)
        .map(|i| [rgb_target[i * 3], rgb_target[i * 3 + 1], rgb_target[i * 3 + 2]])
        .collect();
    let corrected = recorrect(&src, &target, alpha);
    let delight_rgb: Vec<[f64; 3]> = (0..RES * RES)
        .map(|i| {
            let a = alpha[i] as f64 / 255.0;
            [
                corrected[i][0] * a + (1.0 - a),
                corrected[i][1] * a + (1.0 - a),
                corrected[i][2] * a + (1.0 - a),
            ]
        })
        .collect();
    {
        let mut img = image::RgbImage::new(RES as u32, RES as u32);
        for i in 0..RES * RES {
            let mut rgb = [0u8; 3];
            for c in 0..3 {
                rgb[c] = (delight_rgb[i][c].clamp(0.0, 1.0) * 255.0).round() as u8;
            }
            img.put_pixel((i % RES) as u32, (i / RES) as u32, image::Rgb(rgb));
        }
        let _ = img.save(out_dir.join("delight.png"));
    }
    report("delight", 0.5);

    /* 2) paint VAE 条件编码 */
    let venc_p = tch::CModule::load(jit.join("paint_venc.pt")).map_err(|e| format!("加载纹理编码模型失败：{e}"))?;
    let vdec_p = tch::CModule::load(jit.join("paint_vdec.pt")).map_err(|e| format!("加载纹理解码模型失败：{e}"))?;
    let mut ref_in = vec![0f32; 3 * RES * RES];
    for i in 0..RES * RES {
        for c in 0..3 {
            ref_in[c * RES * RES + i] = delight_rgb[i][c] as f32 * 2.0 - 1.0;
        }
    }
    let ref_t = f16_t(&ref_in, &[1, 3, RES as i64, RES as i64]).to_device(cuda);
    let ref_params = venc_p.forward_ts(&[ref_t]).map_err(|e| format!("编码参考图失败：{e}"))?;
    let ref_params = to_vec_f32(&ref_params)?;
    let ref_lat: Vec<f32> = ref_params[..CH * L * L].iter().map(|&v| v * 0.18215).collect();

    let ctrl = fs::read(out_dir.join("ctrl.bin")).map_err(|e| format!("读不了控制图：{e}"))?;
    let stride = 3 * RES * RES;
    if ctrl.len() != 6 * 2 * stride * 4 {
        return Err("控制图大小不对".to_string());
    }
    // 写入顺序是每个视图 [normal, position] 交替
    let mut normal_f = vec![0f32; 6 * stride];
    let mut position_f = vec![0f32; 6 * stride];
    for view in 0..6 {
        let base = view * 2 * stride * 4;
        for i in 0..stride {
            let o = base + i * 4;
            normal_f[view * stride + i] = f32::from_le_bytes([ctrl[o], ctrl[o + 1], ctrl[o + 2], ctrl[o + 3]]);
            let o = base + (stride + i) * 4;
            position_f[view * stride + i] =
                f32::from_le_bytes([ctrl[o], ctrl[o + 1], ctrl[o + 2], ctrl[o + 3]]);
        }
    }
    let n_t = f16_t(&normal_f, &[6, 3, RES as i64, RES as i64]).to_device(cuda);
    let n_params = venc_p.forward_ts(&[n_t]).map_err(|e| format!("编码法线图失败：{e}"))?;
    let n_params = to_vec_f32(&n_params)?;
    let normal_lat: Vec<f32> = (0..6 * CH * L * L)
        .map(|i| n_params[(i / (CH * L * L)) * 8 * L * L + (i % (CH * L * L))] * 0.18215)
        .collect();
    let p_t = f16_t(&position_f, &[6, 3, RES as i64, RES as i64]).to_device(cuda);
    let p_params = venc_p.forward_ts(&[p_t]).map_err(|e| format!("编码位置图失败：{e}"))?;
    let p_params = to_vec_f32(&p_params)?;
    let position_lat: Vec<f32> = (0..6 * CH * L * L)
        .map(|i| p_params[(i / (CH * L * L)) * 8 * L * L + (i % (CH * L * L))] * 0.18215)
        .collect();
    drop(venc_p);
    report("cond", 0.55);

    /* 3) 多视图扩散 30 步（B=2 CFG） */
    let unet = tch::CModule::load(jit.join("mv_unet.pt")).map_err(|e| format!("加载纹理生成模型失败：{e}"))?;
    let ehs = f16_t(&consts.mv_ehs, &[2, 77, 1024]).to_device(cuda);
    let mut normal2 = Vec::with_capacity(2 * 6 * CH * L * L);
    normal2.extend_from_slice(&normal_lat);
    normal2.extend_from_slice(&normal_lat);
    let mut pos2 = Vec::with_capacity(2 * 6 * CH * L * L);
    pos2.extend_from_slice(&position_lat);
    pos2.extend_from_slice(&position_lat);
    let mut ref2 = vec![0f32; CH * L * L];
    ref2.extend_from_slice(&ref_lat);
    let scale2 = vec![0f32, 1.0];
    let normal_t = f16_t(&normal2, &[2, 6, CH as i64, L as i64, L as i64]).to_device(cuda);
    let position_t = f16_t(&pos2, &[2, 6, CH as i64, L as i64, L as i64]).to_device(cuda);
    let ref_t = f16_t(&ref2, &[2, 1, CH as i64, L as i64, L as i64]).to_device(cuda);
    let scale_t = f16_t(&scale2, &[2]).to_device(cuda);
    let cam_codes: Vec<i64> = (0..6).map(|i| cam_code(ELEVS[i], AZIMS[i])).collect();
    let mut cam2 = cam_codes.clone();
    cam2.extend_from_slice(&cam_codes);
    let cam_t = tch::Tensor::from_slice(&cam2).reshape(&[2, 6]).to_device(cuda);
    let cam_refs = tch::Tensor::zeros(&[2, 1], (tch::Kind::Int64, cuda));
    let mut x = randn(NV, seed ^ 0xd1b54a32d192ed03);
    let noises = randn(30 * NV, seed ^ 0x94d049bb133111eb);
    for i in 0..30usize {
        let sigma = consts.mv_sigmas[i] as f64;
        let sigma_to = consts.mv_sigmas[i + 1] as f64;
        let scale = 1.0 / (sigma * sigma + 1.0).sqrt();
        let scaled: Vec<f32> = x.iter().map(|&v| (v as f64 * scale) as f32).collect();
        let mut s2 = Vec::with_capacity(2 * NV);
        s2.extend_from_slice(&scaled);
        s2.extend_from_slice(&scaled);
        let sample = f16_t(&s2, &[2, 6, CH as i64, L as i64, L as i64]).to_device(cuda);
        let ts = f16_t(&[consts.mv_timesteps[i]], &[]).to_device(cuda);
        let out = unet
            .forward_ts(&[
                sample,
                ts,
                ehs.shallow_clone(),
                normal_t.shallow_clone(),
                position_t.shallow_clone(),
                ref_t.shallow_clone(),
                scale_t.shallow_clone(),
                cam_t.shallow_clone(),
                cam_refs.shallow_clone(),
            ])
            .map_err(|e| format!("生成纹理第 {} 步失败：{e}", i + 1))?;
        let pred = to_vec_f32(&out)?;
        let base = i * NV;
        let mut next = vec![0f32; NV];
        for k in 0..NV {
            let pn = pred[k] as f64;
            let pp = pred[NV + k] as f64;
            let merged = pn + 2.0 * (pp - pn);
            let s = x[k] as f64;
            let x0 = merged * (-sigma / (sigma * sigma + 1.0).sqrt()) + s / (sigma * sigma + 1.0);
            let deriv = (s - x0) / sigma;
            let sigma_up =
                (sigma_to * sigma_to * (sigma * sigma - sigma_to * sigma_to) / (sigma * sigma)).max(0.0).sqrt();
            let sigma_down = (sigma_to * sigma_to - sigma_up * sigma_up).max(0.0).sqrt();
            next[k] = (s + deriv * (sigma_down - sigma) + noises[base + k] as f64 * sigma_up) as f32;
        }
        x = next;
        report("mv", 0.55 + 0.40 * (i + 1) as f64 / 30.0);
    }
    drop(unet);

    /* 4) 解码 6 视图 → PNG */
    let sc = 0.18215f32;
    let x_scaled: Vec<f32> = x.iter().map(|&v| v / sc).collect();
    let lat_t = f16_t(&x_scaled, &[6, CH as i64, L as i64, L as i64]).to_device(cuda);
    let dec = vdec_p.forward_ts(&[lat_t]).map_err(|e| format!("解码视图失败：{e}"))?;
    let decv = to_vec_f32(&dec)?;
    drop(vdec_p);
    for view in 0..6 {
        let mut img = image::RgbImage::new(RES as u32, RES as u32);
        for i in 0..RES * RES {
            let mut rgb = [0u8; 3];
            for c in 0..3 {
                let val = (decv[view * 3 * RES * RES + c * RES * RES + i] / 2.0 + 0.5).clamp(0.0, 1.0);
                rgb[c] = (val * 255.0).round() as u8;
            }
            img.put_pixel((i % RES) as u32, (i / RES) as u32, image::Rgb(rgb));
        }
        img.save(out_dir.join(format!("view{view}.png")))
            .map_err(|e| format!("写视图失败：{e}"))?;
    }
    report("mv", 0.99);
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 6 {
        eprintln!("用法：h3d_tex_worker <prep.bin> <out_dir> <seed> <jit_dir> <libtorch_dir>");
        std::process::exit(2);
    }
    let prep = PathBuf::from(&args[1]);
    let out_dir = PathBuf::from(&args[2]);
    let seed: u64 = args[3].parse().unwrap_or(42);
    let jit = PathBuf::from(&args[4]);
    let libtorch = PathBuf::from(&args[5]);

    // CUDA 注册在 torch_cuda.dll 的静态初始化里，纯 ATen 调用前必须手动加载
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        unsafe extern "system" {
            fn LoadLibraryW(name: *const u16) -> isize;
            fn SetDllDirectoryW(dir: *const u16) -> i32;
        }
        let lib_dir = libtorch.join("lib");
        let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
        let d = wide(&lib_dir);
        unsafe { SetDllDirectoryW(d.as_ptr()) };
        let dll = wide(&lib_dir.join("torch_cuda.dll"));
        let h = unsafe { LoadLibraryW(dll.as_ptr()) };
        if h == 0 {
            eprintln!("加载 torch_cuda.dll 失败：{}", std::io::Error::last_os_error());
            std::process::exit(3);
        }
    }

    match run(&prep, &out_dir, &jit, seed) {
        Ok(()) => println!("DONE"),
        Err(e) => {
            eprintln!("ERROR {e}");
            std::process::exit(1);
        }
    }
}

