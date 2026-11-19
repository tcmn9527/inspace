//! 本地图生 3D（Hunyuan3D-2 标准版，几何阶段）。
//!
//! 一条链：u2net 抠图 + recenter → DINO 条件编码 → 30 步 flow matching 采样 →
//! 257³ 体素解码 → marching cubes → GLB。全部在进程内走 ONNX Runtime（CUDA EP），
//! 精度已与 PyTorch 对齐：同一 latent 解出的网格顶点平均偏差 5e-5。
//!
//! 权重住 `gen/h3d`：`onnx/` 下三件（cond/step/geo）+ 外部数据 `encoder.*`/`dit.*`，
//! 抠图用的 `u2net.onnx` 在 `gen/h3d/u2net.onnx`。会话每次生成时现开、结束即放，
//! 显存不常驻——生图面板随时要用卡。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use half::f16;
use ort::execution_providers::{CUDAExecutionProvider, ExecutionProvider};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::canvas::CanvasState;
use crate::store::{DataRoot, GEN_DIR, LIBRARY_DIR};

mod geo;
mod pre;
mod tables;

const H3D_SUB: &str = "h3d";
const N_TOK: usize = 3072;
const LAT_DIM: usize = 64;
const STEPS: usize = 30;
const GUIDANCE: f32 = 5.0;
const CHUNK: usize = 10_000;

#[derive(Default)]
pub struct H3dState {
    cancel: std::sync::Arc<AtomicBool>,
}

struct ModelPaths {
    u2net: PathBuf,
    cond: PathBuf,
    step: PathBuf,
    geo: PathBuf,
}

fn model_root(data: &DataRoot) -> PathBuf {
    data.dir(GEN_DIR).join(H3D_SUB)
}

fn model_paths(data: &DataRoot) -> ModelPaths {
    let root = model_root(data);
    let onnx = root.join("onnx");
    ModelPaths {
        u2net: root.join("u2net.onnx"),
        cond: onnx.join("cond_fp16.onnx"),
        step: onnx.join("step_fp16.onnx"),
        geo: onnx.join("geo_fp16.onnx"),
    }
}

/// 外部数据是分片的：抽查几个关键分片就能判断权重目录齐不齐。
fn check_models(paths: &ModelPaths) -> Vec<String> {
    let onnx_dir = paths.cond.parent().map(Path::to_path_buf).unwrap_or_default();
    let probes = [
        (&paths.u2net, "u2net.onnx"),
        (&paths.cond, "onnx/cond_fp16.onnx"),
        (&paths.step, "onnx/step_fp16.onnx"),
        (&paths.geo, "onnx/geo_fp16.onnx"),
    ];
    let mut missing = Vec::new();
    for (path, label) in probes {
        if !path.is_file() {
            missing.push(label.to_string());
        }
    }
    let data_probes = [
        "encoder.main_image_encoder.model.embeddings.cls_token",
        "dit.cond_in.weight",
    ];
    for name in data_probes {
        if !onnx_dir.join(name).is_file() {
            missing.push(format!("onnx/{name}"));
        }
    }
    missing
}

/* ---------- 云端 3D 生成接口配置（设置页「3D 生成」里填，本地生成不用它） ---------- */

const API_SETTING_KEY: &str = "h3d_api";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct H3dApiConfig {
    pub enabled: bool,
    pub protocol: String,
    pub parallel: u32,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[tauri::command]
pub fn h3d_api_get(app: tauri::AppHandle) -> H3dApiConfig {
    let state = app.state::<crate::db::DbState>();
    let Ok(conn) = state.0.lock() else {
        return H3dApiConfig::default();
    };
    crate::db::read_setting(&conn, API_SETTING_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn h3d_api_set(app: tauri::AppHandle, config: H3dApiConfig) -> Result<H3dApiConfig, String> {
    let mut next = config;
    next.protocol = match next.protocol.as_str() {
        "tripo" => "tripo".to_string(),
        "fal" => "fal".to_string(),
        _ => "hunyuan".to_string(),
    };
    next.parallel = if next.parallel == 0 { 2 } else { next.parallel.min(10) };
    next.base_url = next.base_url.trim().trim_end_matches('/').to_string();
    next.api_key = next.api_key.trim().to_string();
    next.model = next.model.trim().to_string();
    if !next.base_url.is_empty()
        && !next.base_url.starts_with("http://")
        && !next.base_url.starts_with("https://")
    {
        return Err("接口地址要以 http:// 或 https:// 开头".to_string());
    }
    let state = app.state::<crate::db::DbState>();
    let conn = state
        .0
        .lock()
        .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
    let text = serde_json::to_string(&next).map_err(|e| format!("3D API 配置存不下来：{e}"))?;
    crate::db::write_setting(&conn, API_SETTING_KEY, &text)?;
    Ok(next)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct H3dStatus {
    pub ok: bool,
    pub dir: String,
    pub missing: Vec<String>,
}

#[tauri::command]
pub fn h3d_status(state: tauri::State<'_, crate::store::StoreState>) -> H3dStatus {
    let data = crate::store::root_handle(&state);
    let paths = model_paths(&data);
    let missing = check_models(&paths);
    H3dStatus {
        ok: missing.is_empty(),
        dir: model_root(&data).to_string_lossy().to_string(),
        missing,
    }
}

#[tauri::command]
pub fn h3d_reveal(state: tauri::State<'_, crate::store::StoreState>) -> Result<(), String> {
    let data = crate::store::root_handle(&state);
    let dir = model_root(&data);
    if !dir.is_dir() {
        return Err("3D 模型目录还不存在".to_string());
    }
    open::that(&dir).map_err(|e| format!("打不开目录：{e}"))
}

#[tauri::command]
pub fn h3d_cancel(h3d: tauri::State<'_, H3dState>) {
    h3d.cancel.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct H3dModel {
    pub name: String,
    pub size: u64,
    pub modified: i64,
}

/// 图片块（image/gen）→ 磁盘上的那张图。
fn image_file_of(canvas: &CanvasState, id: &str, item_id: &str) -> Result<PathBuf, String> {
    let dir = crate::canvas::resolve_dir(canvas, id)?;
    let text = fs::read_to_string(dir.join("items.json"))
        .map_err(|e| format!("读画布图元失败：{e}"))?;
    let items: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("画布图元格式不对：{e}"))?;
    let found = items
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|it| it.get("id").and_then(serde_json::Value::as_str) == Some(item_id))
        })
        .ok_or_else(|| "这块已经不在画布上了".to_string())?;
    let kind = found
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if kind != "image" && kind != "gen" {
        return Err("只能对图片生成 3D 模型".to_string());
    }
    let src = found
        .get("src")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if src.is_empty() {
        return Err("这块还没有图".to_string());
    }
    let linked =
        kind == "image" && found.get("linked").and_then(serde_json::Value::as_bool) == Some(true);
    let path = if linked {
        PathBuf::from(src)
    } else {
        let rel = src.replace('\\', "/");
        if !rel.starts_with("images/") || rel.contains("..") {
            return Err("图片路径不合法".to_string());
        }
        dir.join(&rel)
    };
    if !path.is_file() {
        return Err("图片不在了".to_string());
    }
    Ok(path)
}

fn models_dir(data: &DataRoot) -> PathBuf {
    data.dir(LIBRARY_DIR).join("models")
}

fn safe_name(stem: &str) -> String {
    let mut name: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    if name.len() > 48 {
        name.truncate(48);
    }
    let name = name.trim().trim_matches('.').to_string();
    if name.is_empty() {
        "模型".to_string()
    } else {
        name
    }
}

fn unique_model_path(dir: &Path, stem: &str) -> PathBuf {
    let base = format!("{}-3d", safe_name(stem));
    let mut candidate = dir.join(format!("{base}.glb"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base}-{n}.glb"));
        n += 1;
    }
    candidate
}

/// CUDA EP 除了 cublas/cudart，还要 cuDNN 9；把能找到的 CUDA bin 目录前置到 PATH。
fn ensure_cuda_path() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(p) = std::env::var("CUDA_PATH") {
            candidates.push(PathBuf::from(p).join("bin"));
        }
        let toolkit = PathBuf::from(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA");
        if let Ok(list) = fs::read_dir(&toolkit) {
            for entry in list.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("v12.") {
                    candidates.push(entry.path().join("bin"));
                }
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.to_path_buf());
            }
        }
        if let Some(bin) = candidates
            .into_iter()
            .find(|dir| dir.join("cudnn64_9.dll").is_file())
        {
            let key = std::ffi::OsStr::new("PATH");
            let old = std::env::var_os(key).unwrap_or_default();
            let mut new_path = std::ffi::OsString::from(bin.as_os_str());
            new_path.push(";");
            new_path.push(old);
            unsafe { std::env::set_var(key, new_path) };
        }
    });
}

fn init_ort() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = ort::init().commit();
    });
}

fn open_session(path: &Path) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("初始化推理失败：{e}"))?
        .with_execution_providers([CUDAExecutionProvider::default().build()])
        .map_err(|e| format!("CUDA 不可用：{e}"))?
        .commit_from_file(path)
        .map_err(|e| {
            format!(
                "加载 {} 失败：{e}",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })
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

struct Progress<'a> {
    app: &'a tauri::AppHandle,
    cancel: &'a AtomicBool,
}

impl Progress<'_> {
    fn report(&self, stage: &str, value: f64) {
        let _ = self.app.emit(
            "h3d-progress",
            serde_json::json!({ "stage": stage, "value": value.clamp(0.0, 1.0) }),
        );
    }
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("已取消".to_string())
        } else {
            Ok(())
        }
    }
}

fn generate_glb(
    img_path: &Path,
    paths: &ModelPaths,
    seed: u64,
    p: &Progress,
) -> Result<Vec<u8>, String> {
    init_ort();
    ensure_cuda_path();
    if !CUDAExecutionProvider::default().is_available().unwrap_or(false) {
        return Err("没找到可用的 CUDA".to_string());
    }

    p.report("load", 0.02);
    let mut u2net = open_session(&paths.u2net)?;
    p.check()?;
    p.report("pre", 0.05);
    let prep = pre::preprocess(&mut u2net, img_path)?;
    drop(u2net);
    p.check()?;

    p.report("cond", 0.12);
    let mut cond_sess = open_session(&paths.cond)?;
    let it = Tensor::from_array(([1usize, 3, 512, 512], prep.image))
        .map_err(|e| format!("图像张量失败：{e}"))?;
    let outs = cond_sess
        .run(ort::inputs!["image" => it])
        .map_err(|e| format!("条件编码失败：{e}"))?;
    let (_, cond_out) = outs[0]
        .try_extract_tensor::<f16>()
        .map_err(|e| format!("条件输出异常：{e}"))?;
    let cond16: Vec<f16> = cond_out.to_vec();
    drop(outs);
    drop(cond_sess);
    p.check()?;

    p.report("sample", 0.16);
    let mut latents: Vec<f16> = randn(N_TOK * LAT_DIM, seed)
        .iter()
        .map(|&v| f16::from_f32(v))
        .collect();
    let sigmas: Vec<f32> = (0..=STEPS)
        .map(|i| i as f32 / STEPS as f32)
        .collect();
    {
        let mut step_sess = open_session(&paths.step)?;
        let cd = Tensor::from_array(([2usize, 1370, 1536], cond16))
            .map_err(|e| format!("条件张量失败：{e}"))?;
        for i in 0..STEPS {
            p.check()?;
            let mut x2: Vec<f16> = Vec::with_capacity(N_TOK * LAT_DIM * 2);
            x2.extend_from_slice(&latents);
            x2.extend_from_slice(&latents);
            let x = Tensor::from_array(([2usize, N_TOK, LAT_DIM], x2))
                .map_err(|e| format!("latent 张量失败：{e}"))?;
            let t = Tensor::from_array(([2usize], vec![f16::from_f32(sigmas[i]); 2]))
                .map_err(|e| format!("时间步失败：{e}"))?;
            let g = Tensor::from_array(([] as [usize; 0], vec![f16::from_f32(GUIDANCE)]))
                .map_err(|e| format!("guidance 失败：{e}"))?;
            let outputs = step_sess
                .run(ort::inputs!["x" => x, "t" => t, "cond" => cd.clone(), "guidance" => g])
                .map_err(|e| format!("采样失败：{e}"))?;
            let (_, v16) = outputs[0]
                .try_extract_tensor::<f16>()
                .map_err(|e| format!("采样输出异常：{e}"))?;
            let dt = sigmas[i + 1] - sigmas[i];
            for k in 0..(N_TOK * LAT_DIM) {
                let prev = f32::from(latents[k]) + dt * f32::from(v16[k]);
                latents[k] = f16::from_f32(prev);
            }
            p.report("sample", 0.16 + 0.39 * (i + 1) as f64 / STEPS as f64);
        }
    }
    p.check()?;

    p.report("voxel", 0.56);
    let res = geo::RES;
    let n3 = res * res * res;
    let coords: Vec<f32> = (0..res)
        .map(|i| -geo::BOUND + 2.0 * geo::BOUND * (i as f32) / ((res - 1) as f32))
        .collect();
    let mut volume = vec![0f32; n3];
    {
        let mut geo_sess = open_session(&paths.geo)?;
        let lat = Tensor::from_array(([1usize, N_TOK, LAT_DIM], latents.clone()))
            .map_err(|e| format!("latent 张量失败：{e}"))?;
        let mut done = 0usize;
        let total_batches = (n3 + CHUNK - 1) / CHUNK;
        let mut batch_n = 0usize;
        while done < n3 {
            p.check()?;
            let end = (done + CHUNK).min(n3);
            let mut q: Vec<f16> = Vec::with_capacity((end - done) * 3);
            for idx in done..end {
                let i = idx / (res * res);
                let r = idx % (res * res);
                q.push(f16::from_f32(coords[i]));
                q.push(f16::from_f32(coords[r / res]));
                q.push(f16::from_f32(coords[r % res]));
            }
            let qt = Tensor::from_array(([1usize, end - done, 3], q))
                .map_err(|e| format!("查询点张量失败：{e}"))?;
            let outputs = geo_sess
                .run(ort::inputs!["queries" => qt, "latents" => lat.clone()])
                .map_err(|e| format!("体素解码失败：{e}"))?;
            let (_, logits) = outputs[0]
                .try_extract_tensor::<f16>()
                .map_err(|e| format!("体素输出异常：{e}"))?;
            for idx in done..end {
                volume[idx] = f32::from(logits[idx - done]);
            }
            done = end;
            batch_n += 1;
            p.report("voxel", 0.56 + 0.41 * batch_n as f64 / total_batches as f64);
        }
    }
    p.check()?;

    p.report("mesh", 0.98);
    let (mut verts, tris) = geo::marching_cubes(&volume, res, 0.0);
    if tris.is_empty() {
        return Err("这次没解出表面，换张图或再来一次".to_string());
    }
    Ok(geo::to_glb(&mut verts, &tris))
}

/// 对画布上的图片块生成 3D 模型，存进模型库，返回模型文件信息。
#[tauri::command]
pub async fn h3d_generate(
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
    {
        let db = app.state::<crate::db::DbState>();
        let api_on = db
            .0
            .lock()
            .ok()
            .and_then(|conn| crate::db::read_setting(&conn, API_SETTING_KEY))
            .and_then(|text| serde_json::from_str::<H3dApiConfig>(&text).ok())
            .map(|config| config.enabled)
            .unwrap_or(false);
        if api_on {
            return Err("3D 生成引擎现在是 API 模式，但云端协议还没接上；先在设置里切回本地模型".to_string());
        }
    }
    let img = image_file_of(&canvas, &id, &item_id)?;
    let stem = img
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "模型".to_string());
    let stem = stem.rsplit_once('.').map(|(a, _)| a).unwrap_or(&stem);
    let dir = models_dir(&data);
    fs::create_dir_all(&dir).map_err(|e| format!("创建模型库失败：{e}"))?;
    let target = unique_model_path(&dir, stem);

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
    let result = tauri::async_runtime::spawn_blocking(move || {
        let progress = Progress {
            app: &app_for_job,
            cancel: cancel.as_ref(),
        };
        generate_glb(&img, &paths, seed, &progress).map(|bytes| (bytes, started.elapsed()))
    })
    .await
    .map_err(|e| format!("生成任务异常：{e}"))??;
    let (bytes, elapsed) = result;

    let mut file = fs::File::create(&target).map_err(|e| format!("保存模型失败：{e}"))?;
    file.write_all(&bytes).map_err(|e| format!("写模型失败：{e}"))?;
    drop(file);
    let meta = fs::metadata(&target).map_err(|e| format!("模型文件异常：{e}"))?;
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
    eprintln!("[h3d] {} 用时 {:.1?}", name, elapsed);
    Ok(H3dModel {
        name,
        size: meta.len(),
        modified,
    })
}
