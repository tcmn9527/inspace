//! 3D 模型库：家具 GLB 放在数据根/library/models，产品卡只记文件名。
//!
//! 只收贴图内嵌的 .glb：.gltf 那种一堆散文件 + 贴图的格式在离线拷贝、跨机器搬数据时
//! 很容易少一张图，先不接。模型的加载和摆放由前端 scene3d 负责，这里只管文件的进出和授权。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::store::DataRoot;

pub struct ModelState {
    data: DataRoot,
}

pub fn init(data: DataRoot) -> Result<ModelState, String> {
    let dir = models_dir(&data);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建模型库目录：{e}"))?;
    Ok(ModelState { data })
}

fn models_dir(data: &DataRoot) -> PathBuf {
    data.dir(crate::store::LIBRARY_DIR).join("models")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub name: String,
    pub size: u64,
    pub modified: i64,
}

fn file_of(path: &Path) -> Option<ModelFile> {
    let name = path.file_name()?.to_string_lossy().to_string();
    if !name.to_ascii_lowercase().ends_with(".glb") {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(ModelFile {
        name,
        size: meta.len(),
        modified,
    })
}

fn list_models(dir: &Path) -> Vec<ModelFile> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        if let Some(file) = file_of(&entry.path()) {
            out.push(file);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 产品卡和场景里记的是模型文件名，不许带路径片段：路径一律由后端自己拼。
fn safe_model_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let valid = !name.is_empty()
        && name.len() <= 160
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':', '\0']);
    if !valid {
        return Err("模型文件名不合法".to_string());
    }
    Ok(name.to_string())
}

fn unique_model_path(dir: &Path, name: &str) -> PathBuf {
    let source = Path::new(name);
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "model".to_string());
    let mut candidate = dir.join(format!("{stem}.glb"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} {n}.glb"));
        n += 1;
    }
    candidate
}

#[tauri::command]
pub fn model_library_dir(state: tauri::State<'_, ModelState>) -> Result<String, String> {
    let dir = models_dir(&state.data);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建模型库目录：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn model_library_list(state: tauri::State<'_, ModelState>) -> Result<Vec<ModelFile>, String> {
    let dir = models_dir(&state.data);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建模型库目录：{e}"))?;
    Ok(list_models(&dir))
}

#[tauri::command]
pub fn model_library_reveal(state: tauri::State<'_, ModelState>) -> Result<(), String> {
    let dir = models_dir(&state.data);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建模型库目录：{e}"))?;
    open::that(&dir).map_err(|e| format!("打不开模型库目录：{e}"))
}

/// 给 GLTFLoader 用的地址：确认文件在库内，再开一次 asset 读权限。
#[tauri::command]
pub fn model_library_url(
    name: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, ModelState>,
) -> Result<String, String> {
    let name = safe_model_name(&name)?;
    let path = models_dir(&state.data).join(&name);
    if !path.is_file() {
        return Err(format!("模型不在了：{name}"));
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("授权失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 把一份 GLB 收进模型库。path 不给就开文件框让用户挑。
#[tauri::command]
pub async fn model_library_import(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: Option<String>,
    state: tauri::State<'_, ModelState>,
) -> Result<Option<ModelFile>, String> {
    let picked = match path {
        Some(p) if !p.trim().is_empty() => Some(PathBuf::from(p)),
        _ => {
            let picked = app
                .dialog()
                .file()
                .set_title("导入 GLB 模型")
                .set_parent(&window)
                .add_filter("GLB 模型", &["glb"])
                .blocking_pick_file();
            let Some(file) = picked else {
                return Ok(None);
            };
            Some(
                file.into_path()
                    .map_err(|e| format!("无法解析所选文件：{e}"))?,
            )
        }
    };
    let Some(source) = picked else {
        return Ok(None);
    };
    if !source.is_file() {
        return Err("这个模型文件不在了".to_string());
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !name.to_ascii_lowercase().ends_with(".glb") {
        return Err("只收 .glb（贴图内嵌的那种）；.gltf 带一堆散文件的先不接".to_string());
    }
    let dir = models_dir(&state.data);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建模型库目录：{e}"))?;
    let target = unique_model_path(&dir, &name);
    fs::copy(&source, &target).map_err(|e| format!("模型拷贝失败：{e}"))?;
    let file = file_of(&target).ok_or_else(|| "模型拷进去了但读不出来".to_string())?;
    Ok(Some(file))
}
