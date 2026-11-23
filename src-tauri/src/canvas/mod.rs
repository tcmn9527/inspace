//! 无限画布 = 一个画布一个文件夹，全部落在本地文件里（不进数据库）。
//!
//! 目录结构（根目录 = 数据文件夹/spaces，跟着设置页那个目录一起搬）：
//!   <画布名>/
//!     space.json    画布信息与相机（缩放/平移）
//!     items.json    所有图元
//!     images/       粘贴/拖入的图片
//!     audio/        粘贴/拖入的音频
//!     video/        拖入/选择的视频（小文件拷贝进来，大文件只记原始路径）
//!     files/        拖入/选择的其它文件，一律拷副本；文本类在卡片里给只读预览，双击交系统程序打开
//!     notes/        笔记块的内容，一块一个 <块id>.md，图片副本在同名的 <块id>/ 目录里
//!     pictures/     画面块的绘制指令和素材表，一块一个 <块id>.json
//!     genpanels/    生图面板的提示词和参数，一块一个 <块id>.json（出的图在 images/）
//!
//! 删除画布时整个文件夹进系统回收站。
//!
//! 画布可以住在分组里：分组是 spaces/ 下的真文件夹，可以嵌套；装着 space.json
//! 的目录是画布，没装的是分组。画布 id 是相对 spaces/ 的路径（如「手绘/神仙卡」），
//! 路径一律在这里算，前端只传 id，不接受绝对路径。

/* 从原 canvas.rs 拆分出来的画布模块：基础与画布/分组命令在这里，
   其余按功能放在 search / media / export_import / video / files 子模块。 */

mod export_import;
mod files;
mod media;
mod search;
mod video;

pub use export_import::*;
pub use files::*;
pub use media::*;
pub use search::*;
pub use video::*;


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
/// 已下线的自动快照目录：每个画布里曾经留一份 .history/，启动时整只送回收站。
const LEGACY_HISTORY_DIR: &str = ".history";
const IMAGE_DIR: &str = "images";
const AUDIO_DIR: &str = "audio";
const NOTE_DIR: &str = "notes";
const PICTURE_DIR: &str = "pictures";
/// 生图面板的内容，一块一个 <块id>.json。出的图本身落在 images/ 里，这儿只记提示词和参数。
const GENPANEL_DIR: &str = "genpanels";
/* 图片单文件上限。普通文生图只有几 MB；高清放大是 4× 输出，
   一张 1920 的图放大后经常超过 20MB，原来那道上限会把结果挡在保存前，
   面板只能显示内存里的预览、盘上没有 src，双击就打不开。 */
const MAX_IMAGE_BYTES: usize = 128 * 1024 * 1024;
const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;
const BAD_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 画布不自己记根目录，只在数据根目录下面挂一层 spaces/；
/// 用户在设置页换了数据文件夹，画布列表立刻跟着变。
pub struct CanvasState {
    data: DataRoot,
}

impl CanvasState {
    fn root(&self) -> PathBuf {
        self.data.dir(crate::store::SPACE_DIR)
    }
    pub(crate) fn data_root(&self) -> DataRoot {
        self.data.clone()
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
    /// 固定页面宽度（世界坐标 0..pageWidth），None = 无限画布；高度始终无限
    pub page_width: Option<f64>,
}

/// space.json 里记的固定宽度：缺字段、非正数、非有限值都当「无限」。
/// 老画布没有这个键，读出来就是 None，不用迁移写盘。
pub(crate) fn read_page_width(dir: &Path) -> Option<f64> {
    read_json(&meta_path(dir))
        .ok()
        .flatten()
        .and_then(|meta| meta.get("pageWidth").and_then(|v| v.as_f64()))
        .filter(|w| w.is_finite() && *w > 0.0)
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
    fs::create_dir_all(&root).map_err(|e| format!("无法创建画布目录：{e}"))?;
    adopt_legacy(&legacy_dir, &root);
    align_meta_names(&root);
    recycle_legacy_history(&root);
    clear_legacy_undo_stash();
    Ok(CanvasState { data })
}

/// 旧版的画布直接住在 app_data_dir/canvases 下；数据统一到一个文件夹之后，
/// 首次启动把那批画布整批挪进去，只挪一次（新位置已经有同名文件夹就不动旧的）。
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

/// 启动时把每个画布里的旧元数据文件名改过来；改不动的留给 meta_path 兜底。
/// 分组是真目录，要递归进去才找得齐；画布目录里面是它自己的素材，不再往下。
fn align_meta_names(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if is_canvas_dir(&path) {
            let _ = meta_path(&path);
        } else {
            align_meta_names(&path);
        }
    }
}

/// 历史版本功能已经下线：各画布里留的 .history/ 再也读不到，整只送系统回收站。
fn recycle_legacy_history(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if is_canvas_dir(&path) {
            let hist = path.join(LEGACY_HISTORY_DIR);
            if hist.is_dir() {
                let _ = recycle_path(&hist);
            }
        } else {
            recycle_legacy_history(&path);
        }
    }
}

/// 旧版撤销用的临时暂存目录，功能下线后没人再清它，启动时顺手收掉。
fn clear_legacy_undo_stash() {
    let dir = std::env::temp_dir().join("inspace-undo");
    if dir.is_dir() {
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 画布 id -> 目录。
pub(crate) fn resolve_dir(state: &CanvasState, id: &str) -> Result<PathBuf, String> {
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
        name.insert_str(0, "画布 ");
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

/// 装着元数据文件的目录是画布；没装的是分组。旧元数据文件名也算。
pub(crate) fn is_canvas_dir(dir: &Path) -> bool {
    dir.join(META_FILE).is_file() || dir.join(LEGACY_META_FILE).is_file()
}

/// id（相对 spaces/ 的路径）-> 目录。每一段都必须是正常文件夹名：
/// 不许绝对路径、不许 ..、不许点开头的隐藏段，免得借 id 摸到画布目录外面去。
fn rel_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    let rel = id.replace('\\', "/");
    let path = Path::new(&rel);
    let mut any = false;
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                any = true;
                if name.to_string_lossy().starts_with('.') {
                    return Err("画布路径不合法".to_string());
                }
            }
            _ => return Err("画布路径不合法".to_string()),
        }
    }
    if !any {
        return Err("画布路径不合法".to_string());
    }
    Ok(root.join(path))
}

/// 目录 -> 画布/分组 id（相对 spaces/，正斜杠分隔）。
fn rel_id(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root)
        .unwrap_or(dir)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 画布 id -> 目录，要求目录确实存在。
fn canvas_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.trim().is_empty() {
        return Err("画布不存在".to_string());
    }
    let dir = rel_dir(root, id)?;
    if !dir.is_dir() {
        return Err("画布不存在或已被移除".to_string());
    }
    Ok(dir)
}

/// 分组 id -> 目录。空 id 是 spaces 根；其余要求存在且不是画布
/// （装着 space.json 的目录归画布命令管，分组命令不许碰）。
fn group_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.trim().is_empty() {
        return Ok(root.to_path_buf());
    }
    let dir = rel_dir(root, id)?;
    if !dir.is_dir() {
        return Err("分组不存在或已被移除".to_string());
    }
    if is_canvas_dir(&dir) {
        return Err("这是一个画布，不是分组".to_string());
    }
    Ok(dir)
}

/// 递归扫 spaces：画布收进 canvases（不再往里走，里面是它自己的素材目录），
/// 其余目录是分组，收进 groups 并继续往下。隐藏目录和符号链接一律不进。
fn walk_spaces(root: &Path) -> (Vec<(String, PathBuf)>, Vec<(String, PathBuf)>) {
    let mut canvases = Vec::new();
    let mut groups = Vec::new();
    visit(&mut canvases, &mut groups, root, root, 0);
    (canvases, groups)
}

fn visit(
    canvases: &mut Vec<(String, PathBuf)>,
    groups: &mut Vec<(String, PathBuf)>,
    root: &Path,
    dir: &Path,
    depth: usize,
) {
    /* 分组嵌套没有硬限制，但符号链接都不跟，再加个深度兜底，防手工造出来的深坑 */
    if depth > 16 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if is_canvas_dir(&path) {
            canvases.push((rel_id(root, &path), path));
        } else {
            groups.push((rel_id(root, &path), path.clone()));
            visit(canvases, groups, root, &path, depth + 1);
        }
    }
}

fn file_mtime(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("数据序列化失败：{e}"))?;
    write_text_atomic(path, &text)
}

/// 画面指令一份就是几万个坐标数，压掉缩进才不至于把盘上的体积和读盘时间一起放大几倍。
fn write_json_compact(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|e| format!("数据序列化失败：{e}"))?;
    write_text_atomic(path, &text)
}

/// 先写临时文件再替换，避免写到一半断电留下半个 JSON。
fn write_text_atomic(path: &Path, text: &str) -> Result<(), String> {
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

/// 跨画布搜索的结果。只带够定位的东西，正文交给前端高亮。

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
const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

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

/// 媒体相对路径只允许落在指定子目录下（只查形状，不看文件在不在）。
fn media_path_in(dir: &Path, rel: &str, sub_dir: &str, missing: &str) -> Result<PathBuf, String> {
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
    Ok(dir.join(path))
}

/// 同上，另外要求文件真的在。
fn media_path(dir: &Path, rel: &str, sub_dir: &str, missing: &str) -> Result<PathBuf, String> {
    let full = media_path_in(dir, rel, sub_dir, missing)?;
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

/// 媒体块的来源路径：拷贝态按画布目录下的相对路径找副本，引用态 src 就是原文件绝对路径。
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
/// 笔记的文件名直接用它，写之前都必须过这里。
pub(crate) fn check_item_id(raw: &str) -> Result<String, String> {
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

/// 笔记块的正文：<画布>/notes/<块id>.md。
fn note_text_file(dir: &Path, item_id: &str) -> Result<PathBuf, String> {
    Ok(dir
        .join(NOTE_DIR)
        .join(format!("{}.md", check_item_id(item_id)?)))
}

/// 画面块的绘制指令：<画布>/pictures/<块id>.json。
fn picture_file(dir: &Path, item_id: &str) -> Result<PathBuf, String> {
    Ok(dir
        .join(PICTURE_DIR)
        .join(format!("{}.json", check_item_id(item_id)?)))
}

/// 生图面板的内容：<画布>/genpanels/<块id>.json。
/// 提示词和参数是这块自己要记住的话，items.json 只留位置和边框。
fn gen_file(dir: &Path, item_id: &str) -> Result<PathBuf, String> {
    Ok(dir
        .join(GENPANEL_DIR)
        .join(format!("{}.json", check_item_id(item_id)?)))
}

/// 空壳目录不留：删掉最后一篇笔记之后把 `notes/` 收走，
/// 免得列表里挂着一个空的画布文件夹。
fn prune_empty(dir: &Path) {
    if dir.is_dir() && fs::read_dir(dir).map(|mut i| i.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(dir);
    }
}

/// 复制笔记块要连它自己的图片目录一起搬；目标已存在就整体覆盖（新块的新目录，不可能有人用）。
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败：{e}"))?;
    let entries = fs::read_dir(src).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("复制文件失败：{e}"))?;
        }
    }
    Ok(())
}

/// 笔记块图片目录：<画布>/notes/<块id>/。块 id 是前端生成的单层名字。
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

/// space.json 没写名字时退回文件夹名（不是 id——id 可能是带分组前缀的路径）。
fn meta_of(dir: &Path, id: &str) -> CanvasMeta {
    let fallback = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| id.to_string());
    let (name, _) = read_meta(dir, &fallback);
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
    let fallback = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| id.to_string());
    let (name, camera) = read_meta(dir, &fallback);
    let page_width = read_page_width(dir);
    let item_count = items.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(CanvasData {
        meta: CanvasMeta {
            id: id.to_string(),
            name,
            item_count,
            modified: file_mtime(&dir.join(ITEMS_FILE)).max(file_mtime(&meta_path(dir))),
            path: dir.to_string_lossy().replace('/', "\\"),
        },
        camera,
        items,
        page_width,
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
    let (canvases, _) = walk_spaces(&root);
    let mut list: Vec<CanvasMeta> = canvases
        .into_iter()
        .map(|(id, dir)| meta_of(&dir, &id))
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(list)
}

/// 画布树：分组嵌套 + 画布叶子。同一层里分组按名字排在前，画布按名字排在后。
#[tauri::command]
pub fn canvas_tree(state: tauri::State<'_, CanvasState>) -> Result<Value, String> {
    let root = state.root();
    let (canvases, groups) = walk_spaces(&root);
    let mut group_rows: Vec<(String, String)> = groups
        .into_iter()
        .map(|(id, dir)| {
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| id.clone());
            (id, name)
        })
        .collect();
    group_rows.sort_by(|a, b| a.1.cmp(&b.1));
    let mut canvas_rows: Vec<CanvasMeta> = canvases
        .into_iter()
        .map(|(id, dir)| meta_of(&dir, &id))
        .collect();
    canvas_rows.sort_by(|a, b| a.name.cmp(&b.name));
    /* 先按父 id 分桶（"" 是根），再从根递归取桶装 children */
    let mut buckets: HashMap<String, Vec<Value>> = HashMap::new();
    let parent_of = |id: &str| id.rsplit_once('/').map(|(head, _)| head.to_string()).unwrap_or_default();
    for (id, name) in group_rows {
        buckets.entry(parent_of(&id)).or_default().push(json!({
            "type": "group", "id": id, "name": name, "children": [],
        }));
    }
    for meta in canvas_rows {
        buckets.entry(parent_of(&meta.id)).or_default().push(json!({
            "type": "canvas",
            "id": meta.id,
            "name": meta.name,
            "itemCount": meta.item_count,
            "modified": meta.modified,
            "path": meta.path,
        }));
    }
    fn build(id: &str, buckets: &mut HashMap<String, Vec<Value>>) -> Vec<Value> {
        let mut kids = buckets.remove(id).unwrap_or_default();
        for kid in &mut kids {
            if kid["type"] == "group" {
                let kid_id = kid["id"].as_str().unwrap_or_default().to_string();
                kid["children"] = Value::Array(build(&kid_id, buckets));
            }
        }
        kids
    }
    Ok(Value::Array(build("", &mut buckets)))
}

/// 新建画布：落在指定分组（parent 为空就是 spaces 根）下，文件夹名就是画布名。
#[tauri::command]
pub fn canvas_create(
    name: String,
    parent: Option<String>,
    state: tauri::State<'_, CanvasState>,
) -> Result<CanvasData, String> {
    let name = check_name(&name)?;
    let root = state.root();
    let parent_dir = group_dir(&root, parent.as_deref().unwrap_or(""))?;
    let folder = unique_dir(&parent_dir, &name);
    let id = rel_id(&root, &folder);
    fs::create_dir_all(folder.join(IMAGE_DIR)).map_err(|e| format!("创建画布失败：{e}"))?;
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
    // 进画布就把整个画布目录交给 asset protocol：之前存过的视频不用一个个再授权，
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
    let path = dir.join(ITEMS_FILE);
    let next = serde_json::to_string_pretty(&items)
        .map_err(|e| format!("数据序列化失败：{e}"))?;
    /* 内容没变就别动盘：前端 500ms 防抖也会有空转，镜头保存还走另一条路 */
    if let Ok(prev) = fs::read_to_string(&path) {
        if prev == next {
            return Ok(());
        }
    }
    write_json(&path, &items)
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
    let fallback = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| id.clone());
    let (name, _) = read_meta(&dir, &fallback);
    meta["name"] = json!(name);
    meta["camera"] = camera;
    if meta.get("createdAt").is_none() {
        meta["createdAt"] = json!(now_ms());
    }
    write_json(&meta_path(&dir), &meta)
}

/// 设置/取消画布的固定宽度。传 null 就退回无限画布（键直接删掉）。
/// 只动 space.json 的 pageWidth 一个键，其它元数据原样保留。
#[tauri::command]
pub fn canvas_set_page_width(
    id: String,
    page_width: Option<f64>,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    if let Some(width) = page_width {
        if !width.is_finite() || width <= 0.0 {
            return Err("页面宽度必须是正数".to_string());
        }
    }
    let dir = resolve_dir(&state, &id)?;
    let mut meta = read_json(&meta_path(&dir))?.unwrap_or_else(|| json!({}));
    match page_width {
        Some(width) => {
            meta["pageWidth"] = json!(width);
        }
        None => {
            meta.as_object_mut().map(|m| m.remove("pageWidth"));
        }
    }
    if meta.get("name").is_none() {
        let fallback = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| id.clone());
        meta["name"] = json!(fallback);
    }
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
    /* 改名只动最后一段：画布留在原分组里，不挪窝 */
    let parent = dir.parent().unwrap_or(&root);
    let same = parent.join(&name) == dir;
    let new_dir = if same { dir.clone() } else { unique_dir(parent, &name) };
    let new_id = rel_id(&root, &new_dir);
    if new_dir != dir {
        fs::rename(&dir, &new_dir).map_err(|e| format!("重命名失败：{e}"))?;
    }
    let mut meta = read_json(&meta_path(&new_dir))?.unwrap_or_else(|| json!({}));
    meta["name"] = json!(name);
    write_json(&meta_path(&new_dir), &meta)?;
    Ok(meta_of(&new_dir, &new_id))
}

/// 复制整个画布到别的分组：素材、内容文件整棵拷一份，新画布新 id，从此各不相干。
/// 不支持移动——正打开着的画布路径不能变。
#[tauri::command]
pub fn canvas_copy(
    id: String,
    parent: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<CanvasMeta, String> {
    let dir = resolve_dir(&state, &id)?;
    let root = state.root();
    let parent_dir = group_dir(&root, &parent)?;
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "无法复制画布".to_string())?;
    let new_dir = unique_dir(&parent_dir, &name);
    copy_dir_all(&dir, &new_dir).map_err(|e| format!("复制画布失败：{e}"))?;
    /* 副本是个新画布：名字跟文件夹走，创建时间算现在；相机和块原样保留 */
    let mut meta = read_json(&meta_path(&new_dir))?.unwrap_or_else(|| json!({}));
    let new_name = new_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(name);
    meta["name"] = json!(new_name);
    meta["createdAt"] = json!(now_ms());
    write_json(&meta_path(&new_dir), &meta)?;
    let new_id = rel_id(&root, &new_dir);
    Ok(meta_of(&new_dir, &new_id))
}

// ---------- 分组 ----------

/// 新建分组：parent 为空就在 spaces 根下。返回新分组的 id（相对路径）。
#[tauri::command]
pub fn canvas_group_create(
    parent: Option<String>,
    name: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let name = check_name(&name)?;
    let root = state.root();
    let parent_dir = group_dir(&root, parent.as_deref().unwrap_or(""))?;
    let folder = unique_dir(&parent_dir, &name);
    fs::create_dir_all(&folder).map_err(|e| format!("创建分组失败：{e}"))?;
    Ok(rel_id(&root, &folder))
}

/// 分组改名：真文件夹跟着改，里面所有画布的 id 前缀都会变，返回新 id 让前端换算。
#[tauri::command]
pub fn canvas_group_rename(
    id: String,
    name: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let root = state.root();
    let dir = group_dir(&root, &id)?;
    if dir == root {
        return Err("根目录不能改名".to_string());
    }
    let name = check_name(&name)?;
    let parent = dir.parent().unwrap_or(&root);
    let new_dir = if parent.join(&name) == dir { dir.clone() } else { unique_dir(parent, &name) };
    if new_dir != dir {
        fs::rename(&dir, &new_dir).map_err(|e| format!("重命名失败：{e}"))?;
    }
    Ok(rel_id(&root, &new_dir))
}

/// 删分组：只许删空的，里面有画布或子分组就拒绝——画布不能被分组连坐。
#[tauri::command]
pub fn canvas_group_delete(id: String, state: tauri::State<'_, CanvasState>) -> Result<(), String> {
    let root = state.root();
    let dir = group_dir(&root, &id)?;
    if dir == root {
        return Err("根目录不能删除".to_string());
    }
    let occupied = fs::read_dir(&dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(true);
    if occupied {
        return Err("分组里还有画布或子分组，请先清空再删".to_string());
    }
    recycle_path(&dir)
}

#[tauri::command]
pub fn canvas_group_reveal(id: String, state: tauri::State<'_, CanvasState>) -> Result<(), String> {
    let root = state.root();
    let dir = group_dir(&root, &id)?;
    reveal_path(&dir);
    Ok(())
}

#[tauri::command]
pub fn canvas_delete(id: String, state: tauri::State<'_, CanvasState>) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    recycle_path(&dir)
}

#[tauri::command]

pub fn canvas_reveal(id: String, state: tauri::State<'_, CanvasState>) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    reveal_path(&dir);
    Ok(())
}
