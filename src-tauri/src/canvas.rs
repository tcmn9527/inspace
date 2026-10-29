//! 无限空间 = 一个空间一个文件夹，全部落在本地文件里（不进数据库）。
//!
//! 目录结构（根目录 = 数据文件夹/spaces，跟着设置页那个目录一起搬）：
//!   <空间名>/
//!     space.json    空间信息与相机（缩放/平移）
//!     items.json    所有图元
//!     images/       粘贴/拖入的图片
//!     audio/        粘贴/拖入的音频
//!     video/        拖入/选择的视频（小文件拷贝进来，大文件只记原始路径）
//!     files/        拖入/选择的其它文件，一律拷副本；文本类在卡片里给只读预览，双击交系统程序打开
//!     stickies/     便签块的内容，一块一个 <块id>.json
//!     notes/        笔记块的内容，一块一个 <块id>.md，图片副本在同名的 <块id>/ 目录里
//!
//! 删除空间时整个文件夹进系统回收站。
//!
//! 前端只传空间 id（就是文件夹名），路径一律在这里算，不接受路径片段。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::store::DataRoot;

pub(crate) const META_FILE: &str = "space.json";
/// 旧版的元数据文件名；读到就顺手改成 space.json
pub(crate) const LEGACY_META_FILE: &str = "canvas.json";
const ITEMS_FILE: &str = "items.json";
const IMAGE_DIR: &str = "images";
const AUDIO_DIR: &str = "audio";
const NOTE_DIR: &str = "notes";
const STICKY_DIR: &str = "stickies";
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;
const BAD_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 空间不自己记根目录，只在数据根目录下面挂一层 spaces/；
/// 用户在设置页换了数据文件夹，空间列表立刻跟着变。
pub struct CanvasState {
    data: DataRoot,
}

impl CanvasState {
    fn root(&self) -> PathBuf {
        self.data.dir(crate::store::SPACE_DIR)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasMeta {
    pub id: String,
    pub name: String,
    pub item_count: usize,
    pub modified: i64,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasData {
    pub meta: CanvasMeta,
    pub camera: Value,
    pub items: Value,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn default_camera() -> Value {
    json!({ "x": 0.0, "y": 0.0, "scale": 1.0 })
}

pub fn init(data: DataRoot, legacy_dir: PathBuf) -> Result<CanvasState, String> {
    let root = data.dir(crate::store::SPACE_DIR);
    fs::create_dir_all(&root).map_err(|e| format!("无法创建空间目录：{e}"))?;
    adopt_legacy(&legacy_dir, &root);
    align_meta_names(&root);
    Ok(CanvasState { data })
}

/// 旧版的空间直接住在 app_data_dir/canvases 下；数据统一到一个文件夹之后，
/// 首次启动把那批空间整批挪进去，只挪一次（新位置已经有同名文件夹就不动旧的）。
fn adopt_legacy(legacy_dir: &Path, root: &Path) {
    if legacy_dir == root || !legacy_dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(legacy_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() {
            continue;
        }
        let dst = root.join(entry.file_name());
        if dst.exists() {
            continue;
        }
        // 挪不动（跨盘、被占用）就算了，旧文件留在原地不会丢
        let _ = fs::rename(&src, &dst);
    }
}

/// 元数据文件名换过一次：旧版叫 canvas.json。读到旧文件就顺手改成新名字，
/// 改不动也继续用它，不耽误打开。
fn meta_path(dir: &Path) -> PathBuf {
    let current = dir.join(META_FILE);
    if current.exists() {
        return current;
    }
    let legacy = dir.join(LEGACY_META_FILE);
    if legacy.exists() {
        if fs::rename(&legacy, &current).is_ok() {
            return current;
        }
        return legacy;
    }
    current
}

/// 启动时把每个空间里的旧元数据文件名改过来；改不动的留给 meta_path 兜底。
fn align_meta_names(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            let _ = meta_path(&path);
        }
    }
}

/// 空间 id -> 目录。
fn resolve_dir(state: &CanvasState, id: &str) -> Result<PathBuf, String> {
    canvas_dir(&state.root(), id)
}

/// 用户内容删除一律进系统回收站：跨盘也能用，误删还能找回。文件和目录都走这里。
#[cfg(target_os = "windows")]
pub(crate) fn recycle_path(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct ShFileOpStructW {
        hwnd: *mut core::ffi::c_void,
        w_func: u32,
        p_from: *const u16,
        p_to: *const u16,
        f_flags: u16,
        f_any_operations_aborted: i32,
        h_name_mappings: *mut core::ffi::c_void,
        lpsz_progress_title: *const u16,
    }

    unsafe extern "system" {
        fn SHFileOperationW(op: *mut ShFileOpStructW) -> i32;
    }

    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.push(0);
    from.push(0);
    let mut op = ShFileOpStructW {
        hwnd: std::ptr::null_mut(),
        w_func: FO_DELETE,
        p_from: from.as_ptr(),
        p_to: std::ptr::null(),
        f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        f_any_operations_aborted: 0,
        h_name_mappings: std::ptr::null_mut(),
        lpsz_progress_title: std::ptr::null(),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code == 0 {
        Ok(())
    } else {
        Err(format!("移入回收站失败（错误码 {code}）"))
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn recycle_path(path: &Path) -> Result<(), String> {
    let result = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|e| format!("删除失败：{e}"))
}

// ---------- 名字与路径 ----------

fn check_name(raw: &str) -> Result<String, String> {
    let mut name = raw.trim().to_string();
    if name.is_empty() {
        return Err("名字不能为空".to_string());
    }
    if name.chars().count() > 80 {
        return Err("名字太长了（最多 80 个字）".to_string());
    }
    if let Some(bad) = name.chars().find(|c| BAD_CHARS.contains(c) || c.is_control()) {
        return Err(format!("名字里不能有 {bad} 这类字符"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("名字不能以点或空格结尾".to_string());
    }
    if name == "." || name == ".." {
        return Err("这个名字不能用".to_string());
    }
    if name.starts_with('.') {
        name.insert_str(0, "空间 ");
    }
    Ok(name)
}

fn unique_dir(root: &Path, name: &str) -> PathBuf {
    let first = root.join(name);
    if !first.exists() {
        return first;
    }
    for index in 2..1000 {
        let candidate = root.join(format!("{name} {index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!("{name} 1000"))
}

/// 空间 id 只允许单层文件夹名；同时要求目录确实存在。
fn canvas_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.trim().is_empty() {
        return Err("空间不存在".to_string());
    }
    let rel = id.replace('\\', "/");
    let path = Path::new(&rel);
    let mut components = path.components();
    let valid = matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !valid {
        return Err("空间路径不合法".to_string());
    }
    let dir = root.join(path);
    if !dir.is_dir() {
        return Err("空间不存在或已被移除".to_string());
    }
    Ok(dir)
}

fn file_mtime(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 先写临时文件再替换，避免写到一半断电留下半个 JSON。
fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("数据序列化失败：{e}"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "data.json".to_string());
    let tmp = path.with_file_name(format!("{name}.tmp"));
    fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
    if path.exists() {
        let bak = path.with_file_name(format!("{name}.bak"));
        let _ = fs::remove_file(&bak);
        fs::rename(path, &bak).map_err(|e| format!("替换文件失败：{e}"))?;
        fs::rename(&tmp, path).map_err(|e| format!("替换文件失败：{e}"))?;
        let _ = fs::remove_file(&bak);
    } else {
        fs::rename(&tmp, path).map_err(|e| format!("写入失败：{e}"))?;
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取失败：{e}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let value = serde_json::from_str(&text).map_err(|e| format!("文件内容损坏：{e}"))?;
    Ok(Some(value))
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn audio_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" | "oga" | "opus" => Some("audio/ogg"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        "weba" => Some("audio/webm"),
        _ => None,
    }
}

const AUDIO_EXTS: [&str; 9] = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"];

fn safe_image_ext(raw: &str) -> String {
    let ext = raw
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .replace("jpeg", "jpg");
    if image_mime(&ext).is_some() {
        ext
    } else {
        "png".to_string()
    }
}

fn safe_audio_ext(raw: &str) -> Result<String, String> {
    let ext = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    if audio_mime(&ext).is_some() {
        Ok(ext)
    } else {
        Err("不是支持的音频格式".to_string())
    }
}

fn unique_media_path(dir: &Path, ext: &str) -> PathBuf {
    let stamp = now_ms();
    for index in 0..1000 {
        let name = if index == 0 {
            format!("{stamp}.{ext}")
        } else {
            format!("{stamp}-{index}.{ext}")
        };
        let path = dir.join(name);
        if !path.exists() {
            return path;
        }
    }
    dir.join(format!("{stamp}-overflow.{ext}"))
}

/// 媒体相对路径只允许落在指定子目录下。
fn media_path(dir: &Path, rel: &str, sub_dir: &str, missing: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let path = Path::new(&rel);
    let mut components = path.components();
    let first = components.next();
    let second = components.next();
    let overflow = components.next();
    let valid = matches!(first, Some(Component::Normal(_)))
        && matches!(second, Some(Component::Normal(_)))
        && overflow.is_none()
        && first
            .map(|c| c.as_os_str().to_string_lossy() == sub_dir)
            .unwrap_or(false);
    if !valid {
        return Err(format!("{missing}路径不合法"));
    }
    let full = dir.join(path);
    if !full.is_file() {
        return Err(format!("{missing}不在了"));
    }
    Ok(full)
}

fn image_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    media_path(dir, rel, IMAGE_DIR, "图片")
}

fn audio_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    media_path(dir, rel, AUDIO_DIR, "音频")
}

/// 媒体块的来源路径：拷贝态按空间目录下的相对路径找副本，引用态 src 就是原文件绝对路径。
fn media_source_path(
    state: &CanvasState,
    id: &str,
    src: &str,
    linked: bool,
    sub_dir: &str,
    missing: &str,
) -> Result<PathBuf, String> {
    if linked {
        let path = PathBuf::from(src);
        if !path.is_file() {
            return Err(format!("{missing}不在了"));
        }
        return Ok(path);
    }
    let dir = resolve_dir(state, id)?;
    media_path(&dir, src, sub_dir, missing)
}

/// 引用态的媒体地址：确认文件还在，给它开一次 asset 读权限，
/// 前端 convertFileSrc 之后直接当 <img>/<audio> 的 src，不把大图大音频 base64 塞进内存。
fn media_url(
    state: &CanvasState,
    app: &tauri::AppHandle,
    id: &str,
    src: &str,
    linked: bool,
    sub_dir: &str,
    missing: &str,
) -> Result<String, String> {
    let path = media_source_path(state, id, src, linked, sub_dir, missing)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("授权失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 块 id 是前端生成的一层名字，被拿来当文件名，所以先过一遍：不许有点、斜杠、冒号、控制字符。
/// 便签和笔记的文件名直接用它，写之前都必须过这里。
fn check_item_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    let valid = !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains(':')
        && !id.contains('.')
        && !id.chars().any(|c| c.is_control());
    if !valid {
        return Err("块标识不合法".to_string());
    }
    Ok(id.to_string())
}

/// 笔记块的正文：<空间>/notes/<块id>.md。
fn note_text_file(dir: &Path, item_id: &str) -> Result<PathBuf, String> {
    Ok(dir
        .join(NOTE_DIR)
        .join(format!("{}.md", check_item_id(item_id)?)))
}

/// 便签块的正文：<空间>/stickies/<块id>.json。
fn sticky_file(dir: &Path, item_id: &str) -> Result<PathBuf, String> {
    Ok(dir
        .join(STICKY_DIR)
        .join(format!("{}.json", check_item_id(item_id)?)))
}

/// 空壳目录不留：删掉最后一张便签/最后一篇笔记之后把 `stickies/`、`notes/` 一起收走，
/// 免得列表里挂着一个空的空间文件夹。
fn prune_empty(dir: &Path) {
    if dir.is_dir() && fs::read_dir(dir).map(|mut i| i.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(dir);
    }
}

/// 复制笔记块要连它自己的图片目录一起搬；目标已存在就整体覆盖（新块的新目录，不可能有人用）。
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建笔记图片目录失败：{e}"))?;
    let entries = fs::read_dir(src).map_err(|e| format!("读取笔记图片目录失败：{e}"))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("复制笔记图片失败：{e}"))?;
        }
    }
    Ok(())
}

/// 笔记块图片目录：<空间>/notes/<块id>/。块 id 是前端生成的单层名字。
fn note_item_dir(dir: &Path, item_id: &str) -> Result<PathBuf, String> {
    Ok(dir.join(NOTE_DIR).join(check_item_id(item_id)?))
}

/// 笔记块图片的相对路径只允许 notes/<本块id>/<文件名>。
fn note_image_path(dir: &Path, item_id: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let path = Path::new(&rel);
    let mut components = path.components();
    let first = components.next();
    let second = components.next();
    let third = components.next();
    let extra = components.next();
    let named = |c: &Option<Component>, name: &str| match c {
        Some(Component::Normal(value)) => value.to_string_lossy() == name,
        _ => false,
    };
    let valid = named(&first, NOTE_DIR)
        && named(&second, item_id.trim())
        && matches!(third, Some(Component::Normal(_)))
        && extra.is_none();
    if !valid {
        return Err("笔记图片路径不合法".to_string());
    }
    let full = dir.join(path);
    if !full.is_file() {
        return Err("笔记图片不在了".to_string());
    }
    Ok(full)
}

fn image_data_url(path: &Path, missing: &str) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|_| missing.to_string())?;
    if meta.len() as usize > MAX_IMAGE_BYTES {
        return Err("图片太大了".to_string());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let mime = image_mime(&ext).ok_or_else(|| "不是支持的图片格式".to_string())?;
    let bytes = fs::read(path).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn read_meta(dir: &Path, fallback: &str) -> (String, Value) {
    let meta = read_json(&meta_path(dir)).ok().flatten();
    let name = meta
        .as_ref()
        .and_then(|m| m.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| fallback.to_string());
    let camera = meta
        .as_ref()
        .and_then(|m| m.get("camera"))
        .cloned()
        .unwrap_or_else(default_camera);
    (name, camera)
}

fn read_items(dir: &Path) -> Result<Value, String> {
    let items = read_json(&dir.join(ITEMS_FILE))?.unwrap_or_else(|| json!([]));
    if !items.is_array() {
        return Err("图元文件格式不对".to_string());
    }
    Ok(items)
}

/// space.json 没写名字时退回文件夹名；空间 id 就是文件夹名，所以直接用 id。
fn meta_of(dir: &Path, id: &str) -> CanvasMeta {
    let (name, _) = read_meta(dir, id);
    let items_path = dir.join(ITEMS_FILE);
    let item_count = read_items(dir)
        .map(|items| items.as_array().map(|a| a.len()).unwrap_or(0))
        .unwrap_or(0);
    CanvasMeta {
        id: id.to_string(),
        name,
        item_count,
        modified: file_mtime(&items_path).max(file_mtime(&meta_path(dir))),
        path: dir.to_string_lossy().to_string(),
    }
}

fn open_dir(dir: &Path, id: &str) -> Result<CanvasData, String> {
    let items = read_items(dir)?;
    let (name, camera) = read_meta(dir, id);
    let item_count = items.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(CanvasData {
        meta: CanvasMeta {
            id: id.to_string(),
            name,
            item_count,
            modified: file_mtime(&dir.join(ITEMS_FILE)).max(file_mtime(&meta_path(dir))),
            path: dir.to_string_lossy().to_string(),
        },
        camera,
        items,
    })
}

fn reveal_path(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        /* explorer /select 只认反斜杠，给正斜杠它只会开个目录不选中。 */
        let fix = |p: &Path| {
            let text = p.to_string_lossy().replace('/', "\\");
            text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
        };
        /* 目录直接打开；文件在就选中它；文件没了就退一步开它本该躺着的那个文件夹。 */
        let arg = if path.is_dir() {
            format!("\"{}\"", fix(path))
        } else if path.is_file() {
            format!("/select,\"{}\"", fix(path))
        } else {
            match path.parent().filter(|dir| dir.is_dir()) {
                Some(dir) => format!("\"{}\"", fix(dir)),
                None => format!("/select,\"{}\"", fix(path)),
            }
        };
        let _ = std::process::Command::new("explorer.exe")
            .raw_arg(arg)
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
}

// ---------- 命令 ----------

#[tauri::command]
pub fn canvas_list(state: tauri::State<'_, CanvasState>) -> Result<Vec<CanvasMeta>, String> {
    let root = state.root();
    let entries = fs::read_dir(&root).map_err(|e| format!("读取空间目录失败：{e}"))?;
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            list.push(meta_of(&entry.path(), &name));
        }
    }
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(list)
}

/// 新建空间：一律落在数据文件夹的 spaces 下，文件夹名就是空间名。
#[tauri::command]
pub fn canvas_create(
    name: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<CanvasData, String> {
    let name = check_name(&name)?;
    let folder = unique_dir(&state.root(), &name);
    let id = folder
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "无法创建空间目录".to_string())?;
    fs::create_dir_all(folder.join(IMAGE_DIR)).map_err(|e| format!("创建空间失败：{e}"))?;
    write_json(
        &meta_path(&folder),
        &json!({
            "name": name,
            "camera": default_camera(),
            "createdAt": now_ms()
        }),
    )?;
    write_json(&folder.join(ITEMS_FILE), &json!([]))?;
    open_dir(&folder, &id)
}

#[tauri::command]
pub fn canvas_open(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<CanvasData, String> {
    let dir = resolve_dir(&state, &id)?;
    // 进空间就把整个空间目录交给 asset protocol：之前存过的视频不用一个个再授权，
    // 用户换了数据目录也会在这里重新授权。
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    open_dir(&dir, &id)
}

#[tauri::command]
pub fn canvas_save_items(
    id: String,
    items: Value,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if !items.is_array() {
        return Err("图元数据必须是数组".to_string());
    }
    let dir = resolve_dir(&state, &id)?;
    write_json(&dir.join(ITEMS_FILE), &items)
}

#[tauri::command]
pub fn canvas_save_camera(
    id: String,
    camera: Value,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if !camera.is_object() {
        return Err("相机数据格式不对".to_string());
    }
    let dir = resolve_dir(&state, &id)?;
    let mut meta = read_json(&meta_path(&dir))?.unwrap_or_else(|| json!({}));
    let (name, _) = read_meta(&dir, &id);
    meta["name"] = json!(name);
    meta["camera"] = camera;
    if meta.get("createdAt").is_none() {
        meta["createdAt"] = json!(now_ms());
    }
    write_json(&meta_path(&dir), &meta)
}

#[tauri::command]
pub fn canvas_rename(
    id: String,
    name: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<CanvasMeta, String> {
    let dir = resolve_dir(&state, &id)?;
    let name = check_name(&name)?;
    let root = state.root();
    let same = root.join(&name) == dir;
    let new_dir = if same { dir.clone() } else { unique_dir(&root, &name) };
    let new_id = new_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "无法重命名空间".to_string())?;
    if new_dir != dir {
        fs::rename(&dir, &new_dir).map_err(|e| format!("重命名失败：{e}"))?;
    }
    let mut meta = read_json(&meta_path(&new_dir))?.unwrap_or_else(|| json!({}));
    meta["name"] = json!(name);
    write_json(&meta_path(&new_dir), &meta)?;
    Ok(meta_of(&new_dir, &new_id))
}

#[tauri::command]
pub fn canvas_delete(id: String, state: tauri::State<'_, CanvasState>) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    recycle_path(&dir)
}

#[tauri::command]
pub fn canvas_save_image(
    id: String,
    data: String,
    ext: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("图片数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("图片是空的".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片太大了（超过 20MB）".to_string());
    }
    store_image(&dir, &bytes, &ext)
}

/// 用系统文件框选一张图片，只返回它的绝对路径（拷不拷由前端问用户）。取消返回 null。
#[tauri::command]
pub fn canvas_pick_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择图片")
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 把资源管理器里拖进空间的图片存进 images/。
#[tauri::command]
pub fn canvas_import_image(
    id: String,
    path: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    import_image_file(&dir, Path::new(&path))
}

fn store_image(dir: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    let ext = safe_image_ext(ext);
    let image_dir = dir.join(IMAGE_DIR);
    fs::create_dir_all(&image_dir).map_err(|e| format!("创建图片目录失败：{e}"))?;
    let path = unique_media_path(&image_dir, &ext);
    fs::write(&path, bytes).map_err(|e| format!("保存图片失败：{e}"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(format!("{IMAGE_DIR}/{name}"))
}

fn store_audio(dir: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    let ext = safe_audio_ext(ext)?;
    let audio_dir = dir.join(AUDIO_DIR);
    fs::create_dir_all(&audio_dir).map_err(|e| format!("创建音频目录失败：{e}"))?;
    let path = unique_media_path(&audio_dir, &ext);
    fs::write(&path, bytes).map_err(|e| format!("保存音频失败：{e}"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(format!("{AUDIO_DIR}/{name}"))
}

/// 选择/拖入音频后返回存储相对路径和原始文件名（播放器显示歌名用）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedAudio {
    pub rel: String,
    pub name: String,
}

/// 选文件/拖文件进空间前的共同一问：空的没什么可显示
fn require_non_empty(path: &Path, what: &str) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|_| format!("{what}不在了"))?;
    if meta.len() == 0 {
        return Err(format!("{what}是空的"));
    }
    Ok(())
}

/// 从磁盘整份拷进空间的某个媒体目录。走 fs::copy 不过 base64，
/// 所以这里不用像「前端递字节」那样卡体积：一部 200MB 的片子也是边读边写。
fn copy_media(dir: &Path, src: &Path, sub_dir: &str, ext: &str) -> Result<String, String> {
    let target_dir = dir.join(sub_dir);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建{sub_dir}目录失败：{e}"))?;
    let dest = unique_media_path(&target_dir, ext);
    fs::copy(src, &dest).map_err(|e| format!("拷贝失败：{e}"))?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(format!("{sub_dir}/{name}"))
}

fn import_image_file(dir: &Path, path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    if image_mime(&ext).is_none() {
        return Err("不是支持的图片格式".to_string());
    }
    require_non_empty(path, "图片")?;
    copy_media(dir, path, IMAGE_DIR, &safe_image_ext(&ext))
}

fn import_audio_file(dir: &Path, path: &Path) -> Result<PickedAudio, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    if audio_mime(&ext).is_none() {
        return Err("不是支持的音频格式".to_string());
    }
    require_non_empty(path, "音频")?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名音频".to_string());
    let rel = copy_media(dir, path, AUDIO_DIR, &safe_audio_ext(&ext)?)?;
    Ok(PickedAudio { rel, name })
}

/// 图片块的显示地址：拷贝态给空间 images/ 里那份，引用态给原文件。
#[tauri::command]
pub fn canvas_image_url(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    media_url(&state, &app, &id, &src, linked, IMAGE_DIR, "图片")
}

/// 删图片块：拷贝态把空间里那份副本送进回收站；引用态只断链接，原图是用户自己的东西。
#[tauri::command]
pub fn canvas_delete_image(
    id: String,
    src: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if linked {
        return Ok(());
    }
    let dir = resolve_dir(&state, &id)?;
    let path = image_path(&dir, &src)?;
    recycle_path(&path).map_err(|e| format!("删除图片失败：{e}"))
}

/// 空间笔记块自己的图片副本：notes/<块id>/<时间戳>.<ext>。
/// 原笔记的图片先读成 data URL，再由这里复制进来，之后怎么编辑都不碰原 .md。
#[tauri::command]
pub fn canvas_save_note_image(
    id: String,
    item_id: String,
    data: String,
    ext: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    let target = note_item_dir(&dir, &item_id)?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("图片数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("图片是空的".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片太大了（超过 20MB）".to_string());
    }
    let ext = safe_image_ext(&ext);
    fs::create_dir_all(&target).map_err(|e| format!("创建笔记图片目录失败：{e}"))?;
    let path = unique_media_path(&target, &ext);
    fs::write(&path, &bytes).map_err(|e| format!("保存图片失败：{e}"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(format!("{NOTE_DIR}/{}/{name}", item_id.trim()))
}

#[tauri::command]
pub fn canvas_read_note_image(
    id: String,
    item_id: String,
    rel: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = note_image_path(&dir, &item_id, &rel)?;
    image_data_url(&path, "笔记图片不在了")
}

// ---------- 便签块与笔记块：一块一份文件 ----------
//
// 空间上的便签和笔记各有一份自己的文件，住在空间自己的目录里。
// 数据根顶层那个 `stickies/` 是已下线的首页便签墙留下的，跟这里同名不同物，互不相干。
// 字段口径沿用当年的便签卡（title/body/color/textColor/width/height），
// 「一个便签就是一个 json 文件」这句话在两边字面一致。

const MAX_STICKY_CHARS: usize = 200_000;
const MAX_STICKY_HEAD_CHARS: usize = 200;
const MAX_COLOR_CHARS: usize = 32;

/// 不管前端递来什么，只收认得的几个字段，字符串掐长度、尺寸夹到合理范围。
/// 落盘的便签文件永远是这个样子，读的时候再遇到坏值也有默认兜着。
fn sticky_of(raw: &Value) -> Value {
    let text = |key: &str, max: usize| -> String {
        raw.get(key)
            .and_then(Value::as_str)
            .map(|s| s.chars().take(max).collect())
            .unwrap_or_default()
    };
    let size = |key: &str| -> Option<f64> {
        raw.get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(8.0, 20000.0))
    };
    json!({
        "title": text("title", MAX_STICKY_HEAD_CHARS),
        "body": text("body", MAX_STICKY_CHARS),
        "color": text("color", MAX_COLOR_CHARS),
        "textColor": text("textColor", MAX_COLOR_CHARS),
        "borderColor": text("borderColor", MAX_COLOR_CHARS),
        "width": size("width"),
        "height": size("height"),
        "updatedAt": now_ms(),
    })
}

/// 这块便签的文件；还没落过盘就返回 null，由前端拿块上残留的旧正文补写一次。
#[tauri::command]
pub fn canvas_read_sticky(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Option<Value>, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = sticky_file(&dir, &item_id)?;
    read_json(&path).map(|value| value.map(|raw| sticky_of(&raw)))
}

#[tauri::command]
pub fn canvas_write_sticky(
    id: String,
    item_id: String,
    sticky: Value,
    state: tauri::State<'_, CanvasState>,
) -> Result<Value, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = sticky_file(&dir, &item_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建便签目录失败：{e}"))?;
    }
    let value = sticky_of(&sticky);
    write_json(&path, &value)?;
    Ok(value)
}

/// 复制便签块：读源空间那块的那份 json，原样写成目标块自己的文件。
/// 两边各是各的文件，之后改谁都不影响谁。
#[tauri::command]
pub fn canvas_duplicate_sticky(
    id: String,
    item_id: String,
    to_id: String,
    to_item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Value, String> {
    let from = sticky_file(&resolve_dir(&state, &id)?, &item_id)?;
    let raw = read_json(&from)?.ok_or_else(|| "这张便签的文件不在了".to_string())?;
    let dir = resolve_dir(&state, &to_id)?;
    let to = sticky_file(&dir, &to_item_id)?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建便签目录失败：{e}"))?;
    }
    let value = sticky_of(&raw);
    write_json(&to, &value)?;
    Ok(value)
}

/// 空间笔记块的正文（不是引用态；引用态那份走 notes_read / canvas_note_write_back 碰用户自己的文件）。
#[tauri::command]
pub fn canvas_read_note(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Option<String>, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = note_text_file(&dir, &item_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("读取笔记失败：{e}"))
}

#[tauri::command]
pub fn canvas_write_note(
    id: String,
    item_id: String,
    text: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let path = note_text_file(&dir, &item_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建笔记目录失败：{e}"))?;
    }
    write_bytes_atomic(&path, text.as_bytes())
}

/// 复制笔记块：正文 .md 和它自己的图片目录一起搬到目标块名下，成为互不相干的另一篇。
#[tauri::command]
pub fn canvas_duplicate_note(
    id: String,
    item_id: String,
    to_id: String,
    to_item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let from_dir = resolve_dir(&state, &id)?;
    let to_dir = resolve_dir(&state, &to_id)?;
    let from_text = note_text_file(&from_dir, &item_id)?;
    let bytes = fs::read(&from_text).map_err(|_| "这篇笔记的文件不在了".to_string())?;
    let to_text = note_text_file(&to_dir, &to_item_id)?;
    if let Some(parent) = to_text.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建笔记目录失败：{e}"))?;
    }
    write_bytes_atomic(&to_text, &bytes)?;
    let from_assets = note_item_dir(&from_dir, &item_id)?;
    if from_assets.is_dir() {
        copy_dir_all(&from_assets, &note_item_dir(&to_dir, &to_item_id)?)?;
    }
    Ok(())
}

/// 删掉一块便签：它自己那份 json 进系统回收站，空间上没别的地方用它。
#[tauri::command]
pub fn canvas_delete_sticky(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let path = sticky_file(&dir, &item_id)?;
    if path.is_file() {
        recycle_path(&path).map_err(|e| format!("删除便签失败：{e}"))?;
    }
    prune_empty(&dir.join(STICKY_DIR));
    Ok(())
}

/// 删掉一块笔记：正文 .md 连它的图片目录一起进系统回收站（引用态的原文件不归这里管）。
#[tauri::command]
pub fn canvas_delete_note(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let assets = note_item_dir(&dir, &item_id)?;
    if assets.is_dir() {
        recycle_path(&assets).map_err(|e| format!("清理笔记图片失败：{e}"))?;
    }
    let text = note_text_file(&dir, &item_id)?;
    if text.is_file() {
        recycle_path(&text).map_err(|e| format!("删除笔记失败：{e}"))?;
    }
    prune_empty(&dir.join(NOTE_DIR));
    Ok(())
}

/// 带用户去看这块便签/笔记自己那份文件躺在哪儿：路径只从 items.json 里那块记的类型算，
/// 前端递来的块 id 是唯一线索，所以这儿开不出空间目录以外的东西。
#[tauri::command]
pub fn canvas_reveal_block(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let items = read_items(&dir)?;
    let found = items
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|it| it.get("id").and_then(Value::as_str) == Some(item_id.as_str()))
        })
        .ok_or_else(|| "这块已经不在空间上了".to_string())?;
    let path = match found.get("type").and_then(Value::as_str).unwrap_or_default() {
        "sticky" => sticky_file(&dir, &item_id)?,
        "note" => note_text_file(&dir, &item_id)?,
        _ => return Err("这块没有自己的文件".to_string()),
    };
    reveal_path(&path);
    Ok(())
}

#[tauri::command]
pub fn canvas_save_audio(
    id: String,
    data: String,
    ext: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("音频数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("音频是空的".to_string());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("音频太大了（超过 50MB）".to_string());
    }
    store_audio(&dir, &bytes, &ext)
}

/// 用系统文件框选一个音频，只返回它的绝对路径（拷不拷由前端问用户）。取消返回 null。
#[tauri::command]
pub fn canvas_pick_audio(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择音频")
        .add_filter("音频", &AUDIO_EXTS)
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 把资源管理器里拖进空间的音频存进 audio/。
#[tauri::command]
pub fn canvas_import_audio(
    id: String,
    path: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<PickedAudio, String> {
    let dir = resolve_dir(&state, &id)?;
    import_audio_file(&dir, Path::new(&path))
}

/// 音频块的播放地址：拷贝态给空间 audio/ 里那份，引用态给原文件。
#[tauri::command]
pub fn canvas_audio_url(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    media_url(&state, &app, &id, &src, linked, AUDIO_DIR, "音频")
}

/// 删音频块：拷贝态回收空间里那份副本；引用态只断链接，不动原文件。
#[tauri::command]
pub fn canvas_delete_audio(
    id: String,
    src: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if linked {
        return Ok(());
    }
    let dir = resolve_dir(&state, &id)?;
    let path = audio_path(&dir, &src)?;
    recycle_path(&path).map_err(|e| format!("删除音频失败：{e}"))
}

#[tauri::command]
pub fn canvas_reveal(id: String, state: tauri::State<'_, CanvasState>) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    reveal_path(&dir);
    Ok(())
}

// ---------- 视频 ----------

/// 视频不套 base64 通道：块里放的是 asset protocol 地址，浏览器按 Range 来要片段，
/// 所以 20GB 的片子也只占几十 MB 解码缓冲，不会把整份读进内存。
const VIDEO_DIR: &str = "video";
const VIDEO_EXTS: [&str; 5] = ["mp4", "m4v", "webm", "mkv", "mov"];
const COPY_CHUNK: usize = 8 * 1024 * 1024;
/// 攒够这么多字节报一次进度，免得事件把前端刷爆。
const COPY_REPORT_EVERY: u64 = 32 * 1024 * 1024;

fn is_video_ext(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    VIDEO_EXTS.contains(&ext.as_str())
}

fn video_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    media_path(dir, rel, VIDEO_DIR, "视频")
}

/// 拷贝途中的临时名：只有整个写完才改名，中途停/出错一律删掉，不留半个文件。
fn part_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string());
    dest.with_file_name(format!("{name}.part"))
}

/// 上次崩在一半留下的 .part，开工前一律扫干净。
fn clear_parts(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_part = path
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("part"))
            .unwrap_or(false);
        if is_part {
            let _ = fs::remove_file(&path);
        }
    }
}

/// 视频文件的来源信息，前端据此问用户拷不拷。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub ext: String,
    /// 扩展名在不在支持列表。不在也别硬拦，交给浏览器试，播不了再提示。
    pub known: bool,
}

fn describe_video(path: &Path) -> Result<VideoInfo, String> {
    let meta = fs::metadata(path).map_err(|_| "视频文件不在了".to_string())?;
    if meta.len() == 0 {
        return Err("视频是空的".to_string());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名视频".to_string());
    Ok(VideoInfo {
        path: path.to_string_lossy().to_string(),
        name,
        size: meta.len(),
        known: is_video_ext(&ext),
        ext,
    })
}

#[tauri::command]
pub fn canvas_video_info(path: String) -> Result<VideoInfo, String> {
    describe_video(Path::new(&path))
}

/// 用系统文件框选一个视频，只返回来源信息（拷不拷由前端问用户）。取消返回 null。
#[tauri::command]
pub fn canvas_pick_video(app: tauri::AppHandle) -> Result<Option<VideoInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择视频")
        .add_filter("视频", &VIDEO_EXTS)
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    describe_video(&path).map(Some)
}

/// 正在进行的拷贝：任务号 → 取消标志。前端随时能喊停。
#[derive(Default)]
pub struct VideoCopyJobs {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl VideoCopyJobs {
    fn register(&self, job: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.flags.lock() {
            map.insert(job.to_string(), Arc::clone(&flag));
        }
        flag
    }

    fn finish(&self, job: &str) {
        if let Ok(mut map) = self.flags.lock() {
            map.remove(job);
        }
    }

    pub fn cancel(&self, job: &str) -> bool {
        let map = match self.flags.lock() {
            Ok(map) => map,
            Err(_) => return false,
        };
        match map.get(job) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoCopyProgress {
    job: String,
    /// progress | done | cancelled | error
    phase: String,
    copied: u64,
    total: u64,
    /// done 时才非空：空间里的相对路径。
    rel: String,
    name: String,
    error: String,
}

fn emit_copy(app: &tauri::AppHandle, payload: VideoCopyProgress) {
    if let Err(e) = app.emit(COPY_EVENT, payload) {
        eprintln!("[copy] 拷贝进度事件发送失败：{e}");
    }
}

/// 把视频拷进空间目录。后台线程跑，立刻返回任务号，进度走 canvas-video-copy 事件。
#[tauri::command]
pub fn canvas_copy_video(
    id: String,
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
    jobs: tauri::State<'_, Arc<VideoCopyJobs>>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    let src = PathBuf::from(&path);
    let info = describe_video(&src)?;
    if !info.known {
        return Err("不是支持的视频格式".to_string());
    }
    let video_dir = dir.join(VIDEO_DIR);
    fs::create_dir_all(&video_dir).map_err(|e| format!("创建视频目录失败：{e}"))?;
    clear_parts(&video_dir);
    let dest = unique_media_path(&video_dir, &info.ext);
    let job = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "视频文件名不合法".to_string())?;
    let rel = format!("{VIDEO_DIR}/{job}");
    let flag = jobs.register(&job);
    let jobs = Arc::clone(&*jobs);
    let part = part_path(&dest);
    let total = info.size;
    let name = info.name;
    let thread_job = job.clone();
    std::thread::spawn(move || {
        copy_stream(
            &app, &src, &part, &dest, &thread_job, &rel, &name, total, &flag, "视频",
        );
        jobs.finish(&thread_job);
    });
    Ok(job)
}

#[allow(clippy::too_many_arguments)]
fn copy_stream(
    app: &tauri::AppHandle,
    src: &Path,
    part: &Path,
    dest: &Path,
    job: &str,
    rel: &str,
    name: &str,
    total: u64,
    flag: &AtomicBool,
    kind: &str,
) {
    let report = |phase: &str, copied: u64, error: String| {
        emit_copy(
            app,
            VideoCopyProgress {
                job: job.to_string(),
                phase: phase.to_string(),
                copied,
                total,
                rel: if phase == "done" { rel.to_string() } else { String::new() },
                name: name.to_string(),
                error,
            },
        );
    };
    // 半截文件一律当场删掉，磁盘上不会留下看不懂的残骸
    let abandon = |phase: &str, copied: u64, error: String| {
        let _ = fs::remove_file(part);
        report(phase, copied, error);
    };

    let mut input = match fs::File::open(src) {
        Ok(file) => file,
        Err(e) => {
            abandon("error", 0, format!("打开{kind}失败：{e}"));
            return;
        }
    };
    let mut output = match fs::File::create(part) {
        Ok(file) => file,
        Err(e) => {
            abandon("error", 0, format!("写入失败：{e}"));
            return;
        }
    };

    let mut buffer = vec![0u8; COPY_CHUNK];
    let mut copied: u64 = 0;
    let mut since_report: u64 = 0;
    report("progress", 0, String::new());
    loop {
        if flag.load(Ordering::Relaxed) {
            drop(output);
            abandon("cancelled", copied, String::new());
            return;
        }
        let read = match input.read(&mut buffer) {
            Ok(size) => size,
            Err(e) => {
                drop(output);
                abandon("error", copied, format!("读取失败：{e}"));
                return;
            }
        };
        if read == 0 {
            break;
        }
        if let Err(e) = output.write_all(&buffer[..read]) {
            drop(output);
            abandon("error", copied, format!("写入失败：{e}"));
            return;
        }
        copied += read as u64;
        since_report += read as u64;
        if since_report >= COPY_REPORT_EVERY {
            since_report = 0;
            report("progress", copied, String::new());
        }
    }
    if let Err(e) = output.flush() {
        drop(output);
        abandon("error", copied, format!("写入失败：{e}"));
        return;
    }
    drop(output);
    if let Err(e) = fs::rename(part, dest) {
        let _ = fs::remove_file(part);
        report("error", copied, format!("整理文件失败：{e}"));
        return;
    }
    let _ = app.asset_protocol_scope().allow_file(dest);
    report("done", copied, String::new());
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AudioFixProgress {
    job: String,
    /// progress | done | cancelled | error
    phase: String,
    /// 0.0 ~ 1.0，ffmpeg 自己报的 out_time / duration
    percent: f64,
    /// done 时才非空：音轨副本在空间里的相对路径
    rel: String,
    error: String,
}

fn emit_audio(app: &tauri::AppHandle, payload: AudioFixProgress) {
    if let Err(e) = app.emit("canvas-video-audio", payload) {
        eprintln!("[video] 音轨进度事件发送失败：{e}");
    }
}

/// 音轨靠系统解码器、WebView2 播不出声时，把第一条音轨转成 AAC 存进空间，
/// 前端再拿它跟画面对声。后台线程跑，立刻返回任务号，进度走 canvas-video-audio 事件。
#[tauri::command]
pub fn canvas_audio_fix(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
    jobs: tauri::State<'_, Arc<VideoCopyJobs>>,
) -> Result<String, String> {
    let input = video_source_path(&state, &id, &src, linked)?;
    let exe = crate::ffmpeg::executable(&app).ok_or("没找到 ffmpeg")?;
    let dir = resolve_dir(&state, &id)?;
    let video_dir = dir.join(VIDEO_DIR);
    fs::create_dir_all(&video_dir).map_err(|e| format!("创建视频目录失败：{e}"))?;
    let dest = unique_media_path(&video_dir, "m4a");
    let job = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "音轨文件名不合法".to_string())?;
    let rel = format!("{VIDEO_DIR}/{job}");
    // ffmpeg 的进度输出不带总时长，这里先探一次拿时长，进度条才有分母
    let total = crate::ffmpeg::probe(&app, &input).duration;
    let flag = jobs.register(&job);
    let jobs = Arc::clone(&*jobs);
    let part = part_path(&dest);
    let thread_job = job.clone();
    std::thread::spawn(move || {
        fix_audio(
            &app, &exe, &input, &part, &dest, &thread_job, &rel, total, &flag,
        );
        jobs.finish(&thread_job);
    });
    Ok(job)
}

#[allow(clippy::too_many_arguments)]
fn fix_audio(
    app: &tauri::AppHandle,
    exe: &Path,
    input: &Path,
    part: &Path,
    dest: &Path,
    job: &str,
    rel: &str,
    total: Option<f64>,
    flag: &AtomicBool,
) {
    let send = |phase: &str, percent: f64, error: String| {
        emit_audio(
            app,
            AudioFixProgress {
                job: job.to_string(),
                phase: phase.to_string(),
                percent,
                rel: if phase == "done" { rel.to_string() } else { String::new() },
                error,
            },
        );
    };
    // 转一半的 sidecar 同样当场删掉，空间目录里不留半截文件
    let abandon = |phase: &str, error: String| {
        let _ = fs::remove_file(part);
        send(phase, 1.0, error);
    };
    send("progress", 0.0, String::new());
    match crate::ffmpeg::extract_audio(exe, input, part, total, flag, |percent| {
        send("progress", percent, String::new())
    }) {
        Ok(true) => {
            if let Err(e) = fs::rename(part, dest) {
                let _ = fs::remove_file(part);
                send("error", 1.0, format!("整理文件失败：{e}"));
                return;
            }
            let _ = app.asset_protocol_scope().allow_file(dest);
            send("done", 1.0, String::new());
        }
        Ok(false) => abandon("cancelled", String::new()),
        Err(e) => abandon("error", e),
    }
}

#[tauri::command]
pub fn canvas_cancel_video_copy(job: String, jobs: tauri::State<'_, Arc<VideoCopyJobs>>) -> bool {
    jobs.cancel(&job)
}

/// 取视频的可播放绝对路径（前端再 convertFileSrc 成 asset 地址），顺手给它开一次读权限。
/// 引用态传 linked=true，src 就是原始绝对路径。
#[tauri::command]
pub fn canvas_video_url(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let path = video_source_path(&state, &id, &src, linked)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("授权失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 引用态 src 就是原片绝对路径，拷贝态按空间目录下的相对路径找。
fn video_source_path(
    state: &CanvasState,
    id: &str,
    src: &str,
    linked: bool,
) -> Result<PathBuf, String> {
    media_source_path(state, id, src, linked, VIDEO_DIR, "视频文件")
}

/// 问 ffmpeg 这条片子装的是什么。拖入阶段还没有块，按引用态把绝对路径传进来即可。
#[tauri::command]
pub fn canvas_video_probe(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<crate::ffmpeg::Probe, String> {
    let path = video_source_path(&state, &id, &src, linked)?;
    Ok(crate::ffmpeg::probe(&app, &path))
}

/// 删视频块：拷贝进来的删空间里那份副本（原片还在用户手里）；
/// 引用态只是解除关联，绝不碰用户磁盘上的原片。
#[tauri::command]
pub fn canvas_delete_video(
    id: String,
    src: String,
    linked: bool,
    audio_rel: Option<String>,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if linked {
        return Ok(());
    }
    let dir = resolve_dir(&state, &id)?;
    /* 转出来的 AAC 副本跟着块一起走，不然空间目录里留一堆没人认领的音轨 */
    if let Some(rel) = audio_rel.filter(|r| !r.is_empty()) {
        if let Ok(path) = video_path(&dir, &rel) {
            let _ = recycle_path(&path);
        }
    }
    let path = video_path(&dir, &src)?;
    recycle_path(&path).map_err(|e| format!("删除视频失败：{e}"))
}

// ---------- 文件块 ----------

/// 图片/音频/视频之外的都算文件：一律拷进空间 files/，双击交给系统默认程序打开。
/// 这一层不认格式、不装解析器，先保证「任何文件拖进来都有个落点，原文件删了也还在」。
const FILE_DIR: &str = "files";
/// 视频和文件共用这根进度事件：同一时刻只跑一个后台拷贝，两根进度条会打架。
const COPY_EVENT: &str = "canvas-video-copy";
/// 到这个体积以内同步拷完直接返回，更大的走后台进度拷贝，界面不至于像卡住了
const SYNC_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Markdown 拖进来是当笔记块用的，正文抄进 items.json，太大的抄进去也没法看
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
/// 预览只读文件头这么多字节：20MB 的日志整份塞进 DOM 会把空间卡死
const PREVIEW_BYTES: u64 = 512 * 1024;
const MARKDOWN_EXTS: [&str; 2] = ["md", "markdown"];

/// 这些扩展名按文本看待：卡片里直接给只读预览。白名单而不是嗅探内容，
/// 是因为 GB18030 这类编码对任意字节都能「解成功」，嗅探会把二进制当文章。
const TEXT_EXTS: &[&str] = &[
    // 纯文本与日志
    "txt", "text", "log", "nfo", "asc", "srt", "vtt", "sub", "diff", "patch", "eml", "bib", "tex",
    // 配置
    "ini", "conf", "cfg", "env", "properties", "props", "settings", "theme", "desktop", "service",
    "editorconfig", "gitignore", "gitattributes", "dockerfile", "makefile", "cmake", "mk",
    // 数据与标记
    "json", "jsonc", "json5", "ndjson", "jsonl", "geojson", "yaml", "yml", "toml", "xml", "csv",
    "tsv", "rss", "atom", "gpx", "plist", "svg", "html", "htm", "xhtml", "ics", "vcf",
    // 代码
    "js", "mjs", "cjs", "ts", "jsx", "tsx", "rs", "go", "py", "pyi", "java", "kt", "kts", "scala",
    "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "vb", "rb", "php", "swift", "dart", "lua", "pl",
    "pm", "r", "m", "mm", "groovy", "gradle", "clj", "ex", "exs", "erl", "hs", "nim", "zig", "v",
    "sql", "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "awk", "tcl", "css", "scss", "sass",
    "less", "graphql", "gql", "proto", "thrift", "tf", "hcl", "vue", "svelte",
];

fn is_markdown_ext(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    MARKDOWN_EXTS.contains(&ext.as_str())
}

fn is_text_ext(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    TEXT_EXTS.contains(&ext.as_str())
}

fn file_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    media_path(dir, rel, FILE_DIR, "文件")
}

/// 副本的相对路径自己带目录名（images/、audio/、video/、files/），
/// 问「还在吗」和「在文件夹中显示」要按开头的目录挑对应的校验通道。
fn copy_source_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let first = rel.replace('\\', "/").split('/').next().unwrap_or("").to_string();
    match first.as_str() {
        IMAGE_DIR => image_path(dir, rel),
        AUDIO_DIR => audio_path(dir, rel),
        VIDEO_DIR => video_path(dir, rel),
        _ => file_path(dir, rel),
    }
}

/// 副本的文件名只保留字母数字，别的扩展名一律当 .bin 收：
/// 块上另有原始文件名，这里只要保证落盘的名字不会搞出路径花样。
fn safe_file_ext(raw: &str) -> String {
    let cleaned: String = raw
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    if cleaned.is_empty() {
        return "bin".to_string();
    }
    cleaned
}

/// 拖入/选择到的文件信息，前端据此决定走同步还是进度拷贝、卡片上写什么。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub ext: String,
    /// 是不是 Markdown：是的话抄正文当笔记块，不当附件卡片
    pub markdown: bool,
    /// 能不能当文本预览：白名单扩展名，卡片里给几行只读正文
    pub text: bool,
    /// 超过同步阈值，得走后台拷贝报进度
    pub big: bool,
}

fn describe_file(path: &Path) -> Result<FileInfo, String> {
    let meta = fs::metadata(path).map_err(|_| "文件不在了".to_string())?;
    if !meta.is_file() {
        return Err("只能拖文件，文件夹请先压成 zip".to_string());
    }
    if meta.len() == 0 {
        return Err("文件是空的".to_string());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名文件".to_string());
    Ok(FileInfo {
        path: path.to_string_lossy().to_string(),
        name,
        size: meta.len(),
        markdown: is_markdown_ext(&ext),
        text: is_text_ext(&ext),
        big: meta.len() > SYNC_FILE_BYTES,
        ext,
    })
}

#[tauri::command]
pub fn canvas_file_info(path: String) -> Result<FileInfo, String> {
    describe_file(Path::new(&path))
}

/// 系统文件框选一个文件，不加扩展名过滤（什么格式都收）。取消返回 null。
#[tauri::command]
pub fn canvas_pick_file(app: tauri::AppHandle) -> Result<Option<FileInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择文件")
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    describe_file(&path).map(Some)
}

/// 拷进空间之后的落点，卡片上的名字和体积都从这里来。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub rel: String,
    pub name: String,
    pub size: u64,
    pub ext: String,
}

#[tauri::command]
pub fn canvas_import_file(
    id: String,
    path: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<PickedFile, String> {
    let dir = resolve_dir(&state, &id)?;
    import_file(&dir, Path::new(&path))
}

fn import_file(dir: &Path, path: &Path) -> Result<PickedFile, String> {
    let info = describe_file(path)?;
    if info.big {
        return Err("文件较大，请走进度拷贝".to_string());
    }
    let bytes = fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
    let ext = safe_file_ext(&info.ext);
    let file_dir = dir.join(FILE_DIR);
    fs::create_dir_all(&file_dir).map_err(|e| format!("创建文件目录失败：{e}"))?;
    let dest = unique_media_path(&file_dir, &ext);
    fs::write(&dest, bytes).map_err(|e| format!("保存文件失败：{e}"))?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(PickedFile {
        rel: format!("{FILE_DIR}/{name}"),
        name: info.name,
        size: info.size,
        ext: info.ext,
    })
}

/// 大文件走后台拷贝：进度、取消、半截 .part 一律删掉，全部沿用视频那套。
#[tauri::command]
pub fn canvas_copy_file(
    id: String,
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
    jobs: tauri::State<'_, Arc<VideoCopyJobs>>,
) -> Result<String, String> {
    let dir = resolve_dir(&state, &id)?;
    let src = PathBuf::from(&path);
    let info = describe_file(&src)?;
    if !info.big {
        return Err("这个体积不用后台拷贝".to_string());
    }
    let file_dir = dir.join(FILE_DIR);
    fs::create_dir_all(&file_dir).map_err(|e| format!("创建文件目录失败：{e}"))?;
    clear_parts(&file_dir);
    let ext = safe_file_ext(&info.ext);
    let dest = unique_media_path(&file_dir, &ext);
    let job = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "文件名不合法".to_string())?;
    let rel = format!("{FILE_DIR}/{job}");
    let flag = jobs.register(&job);
    let jobs = Arc::clone(&*jobs);
    let part = part_path(&dest);
    let total = info.size;
    let name = info.name;
    let thread_job = job.clone();
    std::thread::spawn(move || {
        copy_stream(
            &app, &src, &part, &dest, &thread_job, &rel, &name, total, &flag, "文件",
        );
        jobs.finish(&thread_job);
    });
    Ok(job)
}

/// 复制一块的时候，把源块那份文件原样再拷一份，落进目标空间的同一个子目录，
/// 返回新的相对路径。路径不从嘴里信：只认源空间 items.json 里那条记录。
/// 引用态那块也一样收：src 是用户原文件的绝对路径，从那儿拷进空间，
/// 粘出来的新块从此自己带一份副本，删它不会碰到用户那份原文件。
/// 命令放在 async 上，视频几十 GB 也只是占住一个工作线程，不堵命令线程。
#[tauri::command]
pub async fn canvas_duplicate_media(
    id: String,
    item_id: String,
    to_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Value, String> {
    let from_dir = resolve_dir(&state, &id)?;
    let to_dir = resolve_dir(&state, &to_id)?;
    let items = read_items(&from_dir)?;
    let item = items
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|it| it.get("id").and_then(Value::as_str) == Some(item_id.as_str()))
        })
        .ok_or_else(|| "这块已经不在空间上了".to_string())?;
    let (sub, missing) = match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "image" => (IMAGE_DIR, "图片"),
        "audio" => (AUDIO_DIR, "音频"),
        "video" => (VIDEO_DIR, "视频"),
        "file" | "ebook" => (FILE_DIR, "文件"),
        _ => return Err("这种块没有副本可拷".to_string()),
    };
    let src_rel = item
        .get("src")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "这块没记文件在哪".to_string())?;
    let linked = item.get("linked").and_then(Value::as_bool) == Some(true);
    let src = media_source_path(&state, &id, src_rel, linked, sub, missing)?;
    let rel = store_copy(&to_dir, &src, sub)?;

    let mut out = json!({ "rel": rel });
    // 视频转出来的那条 AAC 音轨是副本的副本，跟着一起搬，不然粘过去没声音
    if let Some(track) = item
        .get("audioRel")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let from = copy_source_path(&from_dir, track)?;
        let track_sub = track.replace('\\', "/").split('/').next().unwrap_or(AUDIO_DIR).to_string();
        out["audioRel"] = json!(store_copy(&to_dir, &from, &track_sub)?);
    }
    Ok(out)
}

/// 把一份已经在盘上的副本按新名字收进 `<目标空间>/<子目录>/`，返回带目录名的相对路径。
/// 扩展名只收字母数字（名字由我们自己写，别把花样带进新文件），撞名靠 unique_media_path 让号。
fn store_copy(dir: &Path, src: &Path, sub: &str) -> Result<String, String> {
    let target_dir = dir.join(sub);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建副本目录失败：{e}"))?;
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let dest = unique_media_path(&target_dir, &safe_file_ext(&ext));
    fs::copy(src, &dest).map_err(|e| format!("拷贝副本失败：{e}"))?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "文件名不合法".to_string())?;
    Ok(format!("{sub}/{name}"))
}

/// 取文件块的可读绝对路径（前端 convertFileSrc 成 asset 地址），顺手开一次读权限。
/// PDF 预览要的是文件本身，走这条比把整本 base64 塞进内存划算。
#[tauri::command]
pub fn canvas_file_url(
    id: String,
    src: String,
    linked: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    media_url(&state, &app, &id, &src, linked, FILE_DIR, "文件")
}

/// 抄 Markdown 正文进笔记块用，编码解不出来就别抄。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    pub encoding: &'static str,
    /// 引用态的块要把这两个记在图元上，写回原文件时才知道还原成什么样子
    pub format: &'static str,
    pub crlf: bool,
}

/// 读 Markdown 正文：只认 .md/.markdown。抄进块里就不再看原文件，引用态则每次现读。
#[tauri::command]
pub fn canvas_file_text(path: String) -> Result<FileText, String> {
    let file = Path::new(&path);
    let ext = file
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    if !is_markdown_ext(&ext) {
        return Err("只有 Markdown 文件能当笔记抄进来".to_string());
    }
    let info = describe_file(file)?;
    if info.size > MAX_TEXT_BYTES {
        return Err("Markdown 太大了（超过 4MB）".to_string());
    }
    let bytes = fs::read(file).map_err(|e| format!("读取失败：{e}"))?;
    let decoded = decode_text(&bytes)?;
    Ok(FileText {
        encoding: encoding_label(decoded.format),
        format: decoded.format,
        crlf: decoded.crlf,
        text: decoded.text,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub text: String,
    pub encoding: &'static str,
    pub size: u64,
    /// 文件比预览上限大，前端据此提示「只看得到开头」
    pub truncated: bool,
}

/// 只读文件开头给卡片当预览，20MB 的日志不至于整个进内存。
/// 引用态 rel 就是原文件绝对路径，空间里没有副本。
#[tauri::command]
pub fn canvas_file_preview(
    id: String,
    rel: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<FilePreview, String> {
    let path = file_source_path(&state, &id, &rel, linked)?;
    let meta = fs::metadata(&path).map_err(|_| "文件不在了".to_string())?;
    let mut file = fs::File::open(&path).map_err(|e| format!("读取失败：{e}"))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(PREVIEW_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取失败：{e}"))?;
    let decoded = decode_text(&bytes)?;
    Ok(FilePreview {
        encoding: encoding_label(decoded.format),
        text: decoded.text,
        size: meta.len(),
        truncated: meta.len() > PREVIEW_BYTES,
    })
}

/// 整篇覆盖用户自己的文件不能一步写：先落到旁边的 .tmp 再换过去。
/// 直接 fs::write 摊在中间崩一次，那份文件就成半截甚至 0 字节了。
fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp_name = path
        .file_name()
        .ok_or_else(|| "文件名不合法".to_string())?
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, bytes).map_err(|e| format!("写入失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换文件失败：{e}")
    })?;
    Ok(())
}

/// 从 items.json 里挖出这块「文本文件块」，返回它自己记着的 (路径, 是不是引用)。
/// 读写都只认这一条：前端递个路径进来就能改盘上任何文件，那不行。
fn editable_text_item(dir: &Path, item_id: &str) -> Result<(String, bool), String> {
    let items = read_items(dir)?;
    let item = items
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|it| it.get("id").and_then(Value::as_str) == Some(item_id))
        })
        .ok_or_else(|| "这块已经不在空间上了".to_string())?;
    if item.get("type").and_then(Value::as_str) != Some("file")
        || item.get("text").and_then(Value::as_bool) != Some(true)
    {
        return Err("只有文本文件块能这样编辑".to_string());
    }
    let src = item
        .get("src")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "这块没记文件在哪".to_string())?;
    let linked = item.get("linked").and_then(Value::as_bool) == Some(true);
    Ok((src.to_string(), linked))
}

/// 这份文件现在的样子。编辑前拿一次、写回前再拿一次，对不上就是被别的程序动过。
fn file_stamp(path: &Path) -> String {
    fs::metadata(path)
        .map(|meta| format!("{}:{}", file_mtime(path), meta.len()))
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBody {
    pub text: String,
    pub encoding: &'static str,
    /// 写回时按这两个还原字节形态，跟笔记块那对口径一样
    pub format: &'static str,
    pub crlf: bool,
    pub stamp: String,
}

/// 块内编辑器要的那份正文：整份读，不像预览那样掐头。
/// 超过 4MB 直接拒——这么大一份正文塞进输入框，编辑器本身就先卡死了，
/// 而且改一个字就要重写几 MB，不如让用户去原文件里改。
#[tauri::command]
pub fn canvas_file_body(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<FileBody, String> {
    let dir = resolve_dir(&state, &id)?;
    let (src, linked) = editable_text_item(&dir, &item_id)?;
    let path = file_source_path(&state, &id, &src, linked)?;
    let meta = fs::metadata(&path).map_err(|_| "文件不在了".to_string())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err("这份文本超过 4MB，空间里只读不改，请到原文件里编辑".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    let decoded = decode_text(&bytes)?;
    Ok(FileBody {
        stamp: file_stamp(&path),
        text: decoded.text,
        encoding: encoding_label(decoded.format),
        format: decoded.format,
        crlf: decoded.crlf,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteBackResult {
    /// 原文件在编辑期间被别的程序改过：没有直接盖上去，等用户点头
    pub conflict: bool,
    pub size: u64,
    /// 落盘之后这份文件的样子，给下一次保存当基线
    pub stamp: String,
}

/// 文本块写回它自己记着的那份文件。GBK 存的中文文件还按 GB18030 落盘，
/// CRLF 的文件别因为空间改了一次就整篇换行大改。
#[tauri::command]
pub fn canvas_file_write_back(
    id: String,
    item_id: String,
    text: String,
    format: String,
    crlf: bool,
    stamp: String,
    force: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<WriteBackResult, String> {
    let dir = resolve_dir(&state, &id)?;
    let (src, linked) = editable_text_item(&dir, &item_id)?;
    let path = file_source_path(&state, &id, &src, linked)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    if !is_text_ext(&ext) {
        return Err("这份文件不在文本白名单里，不往它上面写".to_string());
    }
    let now = file_stamp(&path);
    if !force && !stamp.is_empty() && now != stamp {
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        return Ok(WriteBackResult {
            conflict: true,
            size,
            stamp: now,
        });
    }
    let bytes = encode_text(&text, &format, crlf)?;
    write_bytes_atomic(&path, &bytes)?;
    Ok(WriteBackResult {
        conflict: false,
        size: bytes.len() as u64,
        stamp: file_stamp(&path),
    })
}

struct DecodedText {
    text: String,
    /// 记的是具体哪一种字节形态（utf8 / utf8bom / gb18030 / utf16le / utf16be），
    /// 写回原文件时照它还原，不能只凭给人看的那个标签。
    format: &'static str,
    crlf: bool,
}

/// 卡片上给人看的编码名。UTF-8 家族合成一个，正常态前端根本不显示这行。
fn encoding_label(format: &str) -> &'static str {
    match format {
        "gb18030" => "GB18030",
        "utf16le" | "utf16be" => "UTF-16",
        _ => "UTF-8",
    }
}

/// 文本解码：BOM 说了算，没 BOM 先严格 UTF-8，解不动再让系统按 GB18030 解一遍。
/// 两样都对不上就直说，别把乱码当正文塞进块里。
fn decode_text(bytes: &[u8]) -> Result<DecodedText, String> {
    if let Some(raw) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16_text(raw, "utf16le", true);
    }
    if let Some(raw) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16_text(raw, "utf16be", false);
    }
    let (raw, format) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(body) => (body, "utf8bom"),
        None => (bytes, "utf8"),
    };
    match String::from_utf8(raw.to_vec()) {
        Ok(text) => Ok(decoded_text(text, format)),
        Err(err) => {
            let up_to = err.utf8_error().valid_up_to();
            /* 预览是掐着字节读的，末尾正好切断一个多字节序列不算编码不对 */
            if raw.len() - up_to <= 3 {
                let text = String::from_utf8_lossy(&raw[..up_to]).into_owned();
                return Ok(decoded_text(text, format));
            }
            match gb18030_text(raw) {
                Some(text) => Ok(decoded_text(text, "gb18030")),
                None => Err("这个文件不是 UTF-8 也不是 GB18030，先另存为 UTF-8 再拖进来".to_string()),
            }
        }
    }
}

fn decoded_text(text: String, format: &'static str) -> DecodedText {
    let crlf = text.contains("\r\n");
    DecodedText {
        text: text.replace("\r\n", "\n"),
        format,
        crlf,
    }
}

/// 写回原文件时把读上来时记下的编码和换行还原回去：
/// GBK 存的中文笔记不该因为空间改了一次就变 UTF-8，CRLF 的文件别整篇换行大改。
fn encode_text(text: &str, format: &str, crlf: bool) -> Result<Vec<u8>, String> {
    let normalized = if crlf {
        text.replace('\n', "\r\n")
    } else {
        text.to_string()
    };
    let bytes = match format {
        "utf8bom" => {
            let mut body = vec![0xEF, 0xBB, 0xBF];
            body.extend_from_slice(normalized.as_bytes());
            body
        }
        "gb18030" => gb18030_bytes(&normalized)?,
        "utf16le" => utf16_bytes(&normalized, true),
        "utf16be" => utf16_bytes(&normalized, false),
        _ => normalized.into_bytes(),
    };
    Ok(bytes)
}

fn utf16_bytes(text: &str, little: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    let bom: [u8; 2] = if little { [0xFF, 0xFE] } else { [0xFE, 0xFF] };
    out.extend_from_slice(&bom);
    for unit in text.encode_utf16() {
        let pair = if little {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        out.extend_from_slice(&pair);
    }
    out
}

fn utf16_text(raw: &[u8], format: &'static str, little: bool) -> Result<DecodedText, String> {
    let mut units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    let text = String::from_utf16(&units)
        /* 预览可能正好切断一个代理对，退掉末尾那个落单的高代理再试 */
        .or_else(|_| {
            units.pop();
            String::from_utf16(&units)
        })
        .map_err(|_| "UTF-16 内容解不出来".to_string())?;
    Ok(decoded_text(text, format))
}

/// GB18030 是 Windows 自带的代码页 54936，直接叫系统解，不用为这一个功能带一张几百 KB 的表。
/// 实测 GBK 正文和 GB18030 的四字节生僻字（镈鍳）都能正确解出来；代价是只认 Windows。
#[cfg(target_os = "windows")]
fn gb18030_text(bytes: &[u8]) -> Option<String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            src: *const u8,
            src_len: i32,
            dst: *mut u16,
            dst_len: i32,
        ) -> i32;
    }
    const GB18030: u32 = 54936;
    /* 截断读来的尾巴可能剩半个四字节序列，从后让出最多三个字节再试 */
    for shave in 0..4usize {
        let Some(len) = bytes.len().checked_sub(shave) else {
            continue;
        };
        if len == 0 {
            return None;
        }
        let count =
            unsafe { MultiByteToWideChar(GB18030, 0, bytes.as_ptr(), len as i32, std::ptr::null_mut(), 0) };
        if count <= 0 {
            continue;
        }
        let mut wide = vec![0u16; count as usize];
        let written = unsafe {
            MultiByteToWideChar(GB18030, 0, bytes.as_ptr(), len as i32, wide.as_mut_ptr(), count)
        };
        if written <= 0 {
            continue;
        }
        wide.truncate(written as usize);
        return Some(String::from_utf16_lossy(&wide));
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn gb18030_text(_bytes: &[u8]) -> Option<String> {
    None
}

/// 反向走一遍：写回 GB18030 文件时还按 GB18030 落盘，别把用户的中文笔记换成 UTF-8。
/// GB18030 覆盖整个 Unicode，所以这里不存在编不出字的字符。
#[cfg(target_os = "windows")]
fn gb18030_bytes(text: &str) -> Result<Vec<u8>, String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn WideCharToMultiByte(
            code_page: u32,
            flags: u32,
            src: *const u16,
            src_len: i32,
            dst: *mut u8,
            dst_len: i32,
            default_char: *const u8,
            used_default: *mut i32,
        ) -> i32;
    }
    const GB18030: u32 = 54936;
    let wide: Vec<u16> = text.encode_utf16().collect();
    let need = unsafe {
        WideCharToMultiByte(
            GB18030,
            0,
            wide.as_ptr(),
            wide.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
        )
    };
    if need <= 0 {
        return Err("这份 GB18030 文件写不回去，先另存为 UTF-8 再改".to_string());
    }
    let mut out = vec![0u8; need as usize];
    let written = unsafe {
        WideCharToMultiByte(
            GB18030,
            0,
            wide.as_ptr(),
            wide.len() as i32,
            out.as_mut_ptr(),
            need,
            std::ptr::null(),
            std::ptr::null_mut(),
        )
    };
    if written <= 0 {
        return Err("这份 GB18030 文件写不回去，先另存为 UTF-8 再改".to_string());
    }
    out.truncate(written as usize);
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
fn gb18030_bytes(_text: &str) -> Result<Vec<u8>, String> {
    Err("这份 GB18030 文件写不回去，先另存为 UTF-8 再改".to_string())
}

/// 引用态 rel 就是原文件绝对路径，拷贝态按空间目录下的相对路径找。
fn file_source_path(
    state: &CanvasState,
    id: &str,
    rel: &str,
    linked: bool,
) -> Result<PathBuf, String> {
    if linked {
        let path = PathBuf::from(rel);
        if !path.is_file() {
            return Err("原文件不在了".to_string());
        }
        return Ok(path);
    }
    let dir = resolve_dir(state, id)?;
    file_path(&dir, rel)
}

#[tauri::command]
pub fn canvas_reveal_file(
    id: String,
    rel: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    /* 故意不校验「文件还在不在」：副本没了更要带用户去那个文件夹，好让他把东西放回去。 */
    let path = if linked {
        PathBuf::from(rel)
    } else {
        copy_source_path(&resolve_dir(&state, &id)?, &rel)?
    };
    reveal_path(&path);
    Ok(())
}

/// 引用块只断链接，原文件是用户自己的东西，不动它一根手指。
#[tauri::command]
pub fn canvas_delete_file(
    id: String,
    rel: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if linked {
        return Ok(());
    }
    let dir = resolve_dir(&state, &id)?;
    let path = file_path(&dir, &rel)?;
    recycle_path(&path).map_err(|e| format!("删除文件失败：{e}"))
}

/// 块指向的那份文件还在吗，拷贝态和引用态都问；不在了前端就把整块换成丢文件卡。
#[tauri::command]
pub fn canvas_file_exists(
    id: String,
    rel: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> bool {
    if linked {
        return PathBuf::from(&rel).is_file();
    }
    match resolve_dir(&state, &id) {
        Ok(dir) => copy_source_path(&dir, &rel).is_ok(),
        Err(_) => false,
    }
}

/// 书往空间上放之前先整本预读一遍目录：DRM、KF8 这类读不了的在这里就报错，
/// 免得用户先拷了 20MB 再发现打不开。
#[tauri::command]
pub fn canvas_ebook_info(path: String) -> Result<crate::ebook::Book, String> {
    crate::ebook::open(Path::new(&path))
}

/// 重开空间时只想拿目录，不重新弹一次「这书多大」：直接按块记的路径读。
#[tauri::command]
pub fn canvas_ebook_toc(
    id: String,
    rel: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<crate::ebook::Book, String> {
    let path = file_source_path(&state, &id, &rel, linked)?;
    crate::ebook::open(&path)
}

#[tauri::command]
pub fn canvas_ebook_chapter(
    id: String,
    rel: String,
    linked: bool,
    index: usize,
    state: tauri::State<'_, CanvasState>,
) -> Result<crate::ebook::Chapter, String> {
    let path = file_source_path(&state, &id, &rel, linked)?;
    crate::ebook::chapter(&path, index)
}

/// 引用态的笔记块写回原 .md。路径不从嘴裡信：只认 items.json 里确实记着
/// 「这块是引用、原文件是哪份」的那一条，免得前端递个路径就能写盘上任何文件。
#[tauri::command]
pub fn canvas_note_write_back(
    id: String,
    item_id: String,
    text: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let items = read_items(&dir)?;
    let item = items
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|it| it.get("id").and_then(Value::as_str) == Some(item_id.as_str()))
        })
        .ok_or_else(|| "这块已经不在空间上了".to_string())?;
    let is_linked_note = item.get("type").and_then(Value::as_str) == Some("note")
        && item.get("linked").and_then(Value::as_bool) == Some(true);
    if !is_linked_note {
        return Err("只有引用原文件的笔记块能写回去".to_string());
    }
    let path = item
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "这块没记原文件在哪".to_string())?;
    let file = Path::new(path);
    let ext = file
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    if !is_markdown_ext(&ext) {
        return Err("引用写回只认 Markdown 文件".to_string());
    }
    if !file.is_file() {
        return Err("原文件不在了，先另存一份再改".to_string());
    }
    let format = item
        .get("sourceFormat")
        .and_then(Value::as_str)
        .unwrap_or("utf8");
    let crlf = item
        .get("sourceCrlf")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let bytes = encode_text(&text, format, crlf)?;
    write_bytes_atomic(file, &bytes)
}
