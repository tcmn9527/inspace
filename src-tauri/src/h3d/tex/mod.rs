//! 纹理阶段入口：图片块 → 几何 → 去光照 + 六视图扩散（worker 进程）→ 烘焙贴图 GLB。
//!
//! 推理跑在独立的 `h3d_tex_worker` 进程里（独立 crate，静态链接 libtorch）：主程序不链接
//! tch，启动时不需要 torch.dll，libtorch（5.5GB）只作为数据根里的可选组件存在。
//! 依赖住 `gen/h3d`：`libtorch/`、`jit/`（TorchScript 模型与常量）。设置页负责提示缺件。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::canvas::CanvasState;
use crate::store::{DataRoot, GEN_DIR};

use super::{
    api_enabled, check_models, ensure_cuda_path, generate_glb, image_file_of, init_ort, model_paths,
    models_dir, open_session, safe_name, H3dModel, H3dState, Progress,
};

mod mesh;
mod prep;

const JIT_SUB: &str = "jit";
const LIBTORCH_SUB: &str = "libtorch";

fn root(data: &DataRoot) -> PathBuf {
    data.dir(GEN_DIR).join("h3d")
}

pub fn jit_dir(data: &DataRoot) -> PathBuf {
    root(data).join(JIT_SUB)
}

fn libtorch_dir(data: &DataRoot) -> PathBuf {
    root(data).join(LIBTORCH_SUB)
}

/// 纹理依赖齐不齐：worker + libtorch + 六个 TorchScript 模型 + 六个常量文件。
pub fn check_tex_assets(data: &DataRoot) -> Vec<String> {
    let lib = libtorch_dir(data).join("lib").join("torch_cuda.dll");
    let jit = jit_dir(data);
    let mut missing = Vec::new();
    if worker_path().is_none() {
        missing.push("h3d_tex_worker.exe".to_string());
    }
    if !lib.is_file() {
        missing.push("libtorch".to_string());
    }
    for name in [
        "delight_venc.pt",
        "delight_unet.pt",
        "delight_vdec.pt",
        "paint_venc.pt",
        "paint_vdec.pt",
        "mv_unet.pt",
    ] {
        if !jit.join(name).is_file() {
            missing.push(format!("jit/{name}"));
        }
    }
    for name in [
        "d_text_emb.bin",
        "mv_ehs.bin",
        "d_sigmas.bin",
        "d_timesteps.bin",
        "mv_sigmas.bin",
        "mv_timesteps.bin",
    ] {
        if !jit.join(name).is_file() {
            missing.push(format!("jit/{name}"));
        }
    }
    missing
}

fn worker_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(if cfg!(windows) { "h3d_tex_worker.exe" } else { "h3d_tex_worker" });
    candidate.is_file().then_some(candidate)
}

fn unique_tex_path(dir: &Path, stem: &str) -> PathBuf {
    let base = format!("{}-3d-tex", safe_name(stem));
    let mut candidate = dir.join(format!("{base}.glb"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base}-{n}.glb"));
        n += 1;
    }
    candidate
}

fn cuda_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(p) = std::env::var("CUDA_PATH") {
        dirs.push(PathBuf::from(p).join("bin"));
    }
    if let Ok(list) = std::fs::read_dir(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA") {
        for entry in list.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("v12.") {
                dirs.push(entry.path().join("bin"));
            }
        }
    }
    dirs
}

/// 对画布图片块生成「带纹理」的 3D 模型：几何 + 去光照 + 多视图扩散 + 烘焙贴图。
#[tauri::command]
pub async fn h3d_texture(
    app: tauri::AppHandle,
    canvas: tauri::State<'_, CanvasState>,
    h3d: tauri::State<'_, H3dState>,
    id: String,
    item_id: String,
    seed: Option<u64>,
) -> Result<H3dModel, String> {
    let data = canvas.data_root();
    let paths = model_paths(&data);
    let missing = check_models(&paths);
    if !missing.is_empty() {
        return Err(format!(
            "3D 模型文件不全：缺 {}。到设置里看「3D 生成」",
            missing.join("、")
        ));
    }
    let tex_missing = check_tex_assets(&data);
    if !tex_missing.is_empty() {
        return Err(format!(
            "纹理组件不全：缺 {}。到设置里看「3D 生成」",
            tex_missing.join("、")
        ));
    }
    if api_enabled(&app) {
        return Err("3D 生成引擎现在是 API 模式，但云端协议还没接上；先在设置里切回本地模型".to_string());
    }
    let img = image_file_of(&canvas, &id, &item_id)?;
    let stem = img
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "模型".to_string());
    let stem = stem.rsplit_once('.').map(|(a, _)| a).unwrap_or(&stem).to_string();
    let dir = models_dir(&data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型库失败：{e}"))?;
    let target = unique_tex_path(&dir, &stem);

    let jit = jit_dir(&data);
    let libtorch = libtorch_dir(&data);
    let h3d_root = root(&data);
    h3d.cancel.store(false, Ordering::SeqCst);
    let cancel = h3d.cancel.clone();
    let seed = seed.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(42)
    });
    let started = Instant::now();
    let app_for_job = app.clone();
    let glb_bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        run_pipeline(&app_for_job, &img, &paths, &jit, &libtorch, &h3d_root, seed, cancel.as_ref())
    })
    .await
    .map_err(|e| format!("生成任务异常：{e}"))??;

    let mut file = std::fs::File::create(&target).map_err(|e| format!("保存模型失败：{e}"))?;
    file.write_all(&glb_bytes).map_err(|e| format!("写模型失败：{e}"))?;
    drop(file);
    let meta = std::fs::metadata(&target).map_err(|e| format!("模型文件异常：{e}"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    eprintln!("[h3d-tex] {} 用时 {:.1?}", name, started.elapsed());
    Ok(H3dModel {
        name,
        size: meta.len(),
        modified,
    })
}

fn run_pipeline(
    app: &tauri::AppHandle,
    img: &Path,
    paths: &super::ModelPaths,
    jit: &Path,
    libtorch: &Path,
    h3d_root: &Path,
    seed: u64,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    init_ort();
    ensure_cuda_path();
    // 几何占前 45%，纹理链占 45%..100%
    let geo_p = Progress { app, cancel, scale: 0.45, offset: 0.0 };
    let tex_p = Progress { app, cancel, scale: 0.55, offset: 0.45 };

    // 1) 图像预处理（u2net 抠图 + recenter + 白底）
    let mut u2net = open_session(&paths.u2net)?;
    let prep = prep::prep_image(img, &mut u2net)?;
    drop(u2net);
    geo_p.check()?;

    // 2) 几何
    let glb = generate_glb(img, paths, seed, &geo_p)?;
    geo_p.check()?;

    // 3) 网格简化 + UV + 六视图控制图（纯 CPU，很快）
    tex_p.report("uv", 0.0);
    let (verts, faces) = mesh::load_glb(&glb)?;
    let mut verts = verts;
    mesh::prepare(&mut verts);
    let (verts, faces) = mesh::simplify(verts, faces, 0.3, 0.02);
    let (v, uv_raw, f) = mesh::uv_wrap(&verts, &faces)?;
    let mut uv_bake = uv_raw.clone();
    for t in uv_bake.iter_mut() {
        t[1] = 1.0 - t[1];
    }
    tex_p.check()?;
    tex_p.report("render", 0.02);
    let controls = mesh::render_normal_views(&v, &f);
    tex_p.check()?;

    // 4) 中间目录（数据根 last-tex，覆盖式保留六视图便于排查）+ worker 输入
    let tmp = h3d_root.join("last-tex");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("建临时目录失败：{e}"))?;
    let prep_file = tmp.join("prep.bin");
    {
        let mut out: Vec<u8> =
            Vec::with_capacity(3 * mesh::RES * mesh::RES * 4 * 2 + mesh::RES * mesh::RES);
        for v in &prep.delight_in {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for px in &prep.rgb_target {
            for c in 0..3 {
                out.extend_from_slice(&(px[c] as f32).to_le_bytes());
            }
        }
        out.extend_from_slice(&prep.alpha);
        std::fs::write(&prep_file, out).map_err(|e| format!("写中间文件失败：{e}"))?;
    }
    {
        // worker 侧按 CHW（[3,512,512]）使用，控制图是 HWC 交错序，这里重排
        let stride = mesh::RES * mesh::RES;
        let mut out: Vec<u8> = Vec::with_capacity(6 * 2 * 3 * stride * 4);
        for (n, pos) in &controls {
            for c in 0..3 {
                for px in 0..stride {
                    out.extend_from_slice(&(n[px * 3 + c] as f32 / 255.0 * 2.0 - 1.0).to_le_bytes());
                }
            }
            for c in 0..3 {
                for px in 0..stride {
                    out.extend_from_slice(&(pos[px * 3 + c] as f32 / 255.0 * 2.0 - 1.0).to_le_bytes());
                }
            }
        }
        std::fs::write(tmp.join("ctrl.bin"), out).map_err(|e| format!("写控制图失败：{e}"))?;
    }

    // 5) 拉 worker
    let worker = worker_path().ok_or_else(|| "找不到 h3d_tex_worker".to_string())?;
    let mut path_parts: Vec<PathBuf> = vec![libtorch.join("lib")];
    path_parts.extend(cuda_bin_dirs());
    if let Some(old) = std::env::var_os("PATH") {
        path_parts.extend(std::env::split_paths(&old));
    }
    let path_env = std::env::join_paths(path_parts).map_err(|e| format!("拼 PATH 失败：{e}"))?;
    let mut child = Command::new(&worker)
        .arg(&prep_file)
        .arg(&tmp)
        .arg(seed.to_string())
        .arg(jit)
        .arg(libtorch)
        .env("PATH", &path_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动纹理进程失败：{e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "纹理进程没有输出".to_string())?;
    let mut done = false;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| format!("读纹理进程输出失败：{e}"))?;
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("已取消".to_string());
        }
        if let Some(rest) = line.strip_prefix("PROGRESS ") {
            let mut parts = rest.split_whitespace();
            if let (Some(stage), Some(value)) = (parts.next(), parts.next()) {
                tex_p.report(stage, value.parse::<f64>().unwrap_or(0.0));
            }
        } else if line == "DONE" {
            done = true;
        } else if let Some(err) = line.strip_prefix("ERROR ") {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(err.to_string());
        }
    }
    let status = child.wait().map_err(|e| format!("等待纹理进程失败：{e}"))?;
    if !done || !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            use std::io::Read;
            let _ = e.read_to_string(&mut err);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("纹理进程异常退出：{}", err.trim().lines().last().unwrap_or("")));
    }
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("已取消".to_string());
    }

    // 6) 读六视图 → 烘焙 → GLB
    tex_p.report("bake", 0.93);
    let mut views: Vec<Vec<[f64; 3]>> = Vec::new();
    for view in 0..6 {
        let img = image::open(tmp.join(format!("view{view}.png")))
            .map_err(|e| format!("读视图 {view} 失败：{e}"))?
            .to_rgb8();
        let mut px = vec![[0f64; 3]; mesh::RES * mesh::RES];
        for i in 0..mesh::RES * mesh::RES {
            let p = img.get_pixel((i % mesh::RES) as u32, (i / mesh::RES) as u32);
            for c in 0..3 {
                px[i][c] = p[c] as f64 / 255.0;
            }
        }
        views.push(px);
    }
    let texture = mesh::bake_texture(&v, &uv_bake, &f, &views);
    let png = mesh::texture_png(&texture);
    let bytes = mesh::textured_glb_bytes(&v, &uv_raw, &f, &png)?;
    tex_p.report("bake", 0.99);
    Ok(bytes)
}
