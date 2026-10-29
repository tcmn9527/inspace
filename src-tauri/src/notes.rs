//! 笔记 = 本地 Markdown 文件。
//!
//! 整个模块只认两种路径：
//!   * 根目录：数据文件夹下的 notes/（跟着设置页那个目录走，不再有自己的一套选择）；
//!   * 相对路径：前端传进来的一律是「相对根目录、用 / 分隔」的路径，
//!     真正的绝对路径在这里拼出来，并且拒绝 `..`、盘符、绝对路径，保证跑不出根目录。
//!
//! 文件名、目标是否已存在、能不能把文件夹拖进自己里面，都在这一层校验，
//! 前端只负责展示错误信息。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::store::DataRoot;

/// 单篇笔记上限，超过就不往编辑器里塞了（4MB 的纯文本已经很长）
const MAX_BYTES: u64 = 4 * 1024 * 1024;
/// 笔记同目录下的隐藏图片目录：每篇笔记一个子文件夹，删笔记只删自己那格
const ASSET_DIR: &str = ".assets";
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    pub name: String,
    /// 相对根目录的路径，统一用 / 分隔
    pub path: String,
    /// "dir" 或 "file"
    pub kind: &'static str,
    /// 文件最后修改时间（毫秒）；文件夹为 0
    pub modified: i64,
    pub size: i64,
    pub children: Vec<NoteNode>,
}

// ---------- 路径与名字 ----------

/// 笔记根目录 = 数据文件夹/notes；不在了就顺手建出来，
/// 这样换数据目录、首次启动都不需要额外一步「选文件夹」。
fn read_root(data: &DataRoot) -> Result<PathBuf, String> {
    let path = data.dir(crate::store::NOTE_DIR);
    if !path.is_dir() {
        fs::create_dir_all(&path).map_err(|e| format!("无法创建笔记目录：{e}"))?;
    }
    path.canonicalize()
        .map_err(|e| format!("无法进入笔记目录：{e}"))
}

/// 相对路径 -> 绝对路径。绝对路径、`..`、`.` 之外的盘符一律拒绝。
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Ok(root.to_path_buf());
    }
    let rel = rel.replace('\\', "/");
    let path = Path::new(&rel);
    if path.is_absolute() {
        return Err("路径必须是相对根目录的".to_string());
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err("路径里包含非法片段".to_string()),
        }
    }
    Ok(root.join(path))
}

/// 绝对路径 -> 相对根目录、用 / 分隔的展示路径。
fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

const BAD_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 校验用户输入的名字；`need_md` 为真时补上 .md 后缀。
fn check_name(raw: &str, need_md: bool) -> Result<String, String> {
    let mut name = raw.trim().to_string();
    if name.is_empty() {
        return Err("名字不能为空".to_string());
    }
    if name == "." || name == ".." {
        return Err("这个名字不能用".to_string());
    }
    if name.chars().count() > 120 {
        return Err("名字太长了（最多 120 个字）".to_string());
    }
    if let Some(bad) = name.chars().find(|c| BAD_CHARS.contains(c) || c.is_control()) {
        return Err(format!("名字里不能有 {bad} 这类字符"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("名字不能以点或空格结尾".to_string());
    }
    if name.starts_with('.') {
        return Err("名字不能以点开头".to_string());
    }
    if need_md {
        if !name.to_ascii_lowercase().ends_with(".md") {
            name.push_str(".md");
        }
        if name.eq_ignore_ascii_case(".md") {
            return Err("名字不能为空".to_string());
        }
    }
    Ok(name)
}

/// 目录里的重名处理：`无标题.md` -> `无标题 2.md` -> ...
fn unique_path(dir: &Path, name: &str, need_md: bool) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = if need_md {
        (name.trim_end_matches(".md").to_string(), ".md".to_string())
    } else {
        (name.to_string(), String::new())
    };
    for index in 2..1000 {
        let candidate = dir.join(format!("{stem} {index}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} {}{ext}", 1000))
}

// ---------- 目录树 ----------

fn walk(dir: &Path, base: &Path, depth: usize) -> Vec<NoteNode> {
    if depth > 16 {
        return Vec::new();
    }
    let mut dirs: Vec<NoteNode> = Vec::new();
    let mut files: Vec<NoteNode> = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 隐藏文件不进树
        }
        let path = entry.path();
        let rel = rel_of(base, &path);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            dirs.push(NoteNode {
                name,
                path: rel,
                kind: "dir",
                modified: 0,
                size: 0,
                children: walk(&path, base, depth + 1),
            });
        } else if file_type.is_file() && name.to_ascii_lowercase().ends_with(".md") {
            let meta = entry.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
            files.push(NoteNode {
                name,
                path: rel,
                kind: "file",
                modified,
                size,
                children: Vec::new(),
            });
        }
    }
    let by_name = |a: &NoteNode, b: &NoteNode| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    dirs
}

// ---------- 命令 ----------

/// 笔记目录的绝对路径，前端只拿它做标题提示和「打开所在文件夹」。
#[tauri::command]
pub fn notes_dir(data: tauri::State<'_, DataRoot>) -> Result<String, String> {
    Ok(plain_path(&read_root(&data)?)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn notes_tree(data: tauri::State<'_, DataRoot>) -> Result<Vec<NoteNode>, String> {
    let root = read_root(&data)?;
    Ok(walk(&root, &root, 0))
}

// ---------- 具体文件操作 ----------
// 命令只做「解析根目录 + 调这里」两件事，真正的逻辑放在普通函数里，好写单元测试。

fn read_at(root: &Path, rel: &str) -> Result<String, String> {
    let path = safe_join(root, rel)?;
    let meta = fs::metadata(&path).map_err(|_| format!("找不到这篇笔记：{rel}"))?;
    if meta.len() > MAX_BYTES {
        return Err("笔记太大了（超过 4MB），这里编辑不了".to_string());
    }
    let mut text = fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))?;
    /* 记事本之类存出来的 UTF-8 会带 BOM，留着会让第一行的 # 标题失效，
       读进来时统一去掉 */
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    Ok(text)
}

/// 原子写入：先写同名 .tmp 再覆盖，避免写一半断电把原文件截断。
fn write_at(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let path = safe_join(root, rel)?;
    if !path.to_string_lossy().to_ascii_lowercase().ends_with(".md") {
        return Err("只能写入 .md 文件".to_string());
    }
    if !path.exists() {
        return Err("这篇笔记已经不在了".to_string());
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("保存失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存失败：{e}"))?;
    Ok(())
}

fn create_note_at(root: &Path, parent: &str, name: &str) -> Result<String, String> {
    let dir = safe_join(root, parent)?;
    if !dir.is_dir() {
        return Err("目标文件夹不存在".to_string());
    }
    let file_name = check_name(name, true)?;
    let path = unique_path(&dir, &file_name, true);
    fs::write(&path, "").map_err(|e| format!("新建笔记失败：{e}"))?;
    Ok(rel_of(root, &path))
}

fn create_dir_at(root: &Path, parent: &str, name: &str) -> Result<String, String> {
    let dir = safe_join(root, parent)?;
    if !dir.is_dir() {
        return Err("目标文件夹不存在".to_string());
    }
    let dir_name = check_name(name, false)?;
    let path = unique_path(&dir, &dir_name, false);
    fs::create_dir(&path).map_err(|e| format!("新建文件夹失败：{e}"))?;
    Ok(rel_of(root, &path))
}

fn rename_at(root: &Path, rel: &str, name: &str) -> Result<String, String> {
    let path = safe_join(root, rel)?;
    if !path.exists() {
        return Err("这个文件/文件夹已经不在了".to_string());
    }
    let is_file = path.is_file();
    let new_name = check_name(name, is_file)?;
    let parent = path.parent().ok_or_else(|| "无法定位所在文件夹".to_string())?;
    let target = parent.join(&new_name);
    if target == path {
        return Ok(rel_of(root, &path));
    }
    if target.exists() {
        return Err("这个名字已经被占用了".to_string());
    }
    fs::rename(&path, &target).map_err(|e| format!("重命名失败：{e}"))?;
    /* 图片目录跟着改名：.assets/<旧名>/ -> .assets/<新名>/，
       正文里的相对路径也一起替换掉，否则老链接会指向不存在的目录 */
    if is_file {
        let old_assets = asset_dir_for(&path);
        let new_assets = asset_dir_for(&target);
        if old_assets.is_dir() && !new_assets.exists() {
            let _ = fs::create_dir_all(new_assets.parent().unwrap_or(parent));
            let _ = fs::rename(&old_assets, &new_assets);
            let old_stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let new_stem = target
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Ok(text) = fs::read_to_string(&target) {
                let old_dir = format!("{ASSET_DIR}/{old_stem}/");
                if text.contains(&old_dir) {
                    let new_dir = format!("{ASSET_DIR}/{new_stem}/");
                    let _ = fs::write(&target, text.replace(&old_dir, &new_dir));
                }
            }
        }
    }
    Ok(rel_of(root, &target))
}

fn move_at(root: &Path, rel: &str, target_dir: &str) -> Result<String, String> {
    if rel.trim().is_empty() {
        return Err("根目录不能移动".to_string());
    }
    let src = safe_join(root, rel)?;
    let dst_dir = safe_join(root, target_dir)?;
    if !src.exists() {
        return Err("这个文件/文件夹已经不在了".to_string());
    }
    if !dst_dir.is_dir() {
        return Err("目标文件夹不存在".to_string());
    }
    let src_canon = src.canonicalize().map_err(|e| format!("无法定位源路径：{e}"))?;
    let dst_canon = dst_dir
        .canonicalize()
        .map_err(|e| format!("无法定位目标文件夹：{e}"))?;
    if src_canon.is_dir() && dst_canon.starts_with(&src_canon) {
        return Err("不能把文件夹移动到它自己里面".to_string());
    }
    let name = src
        .file_name()
        .ok_or_else(|| "无法定位名字".to_string())?
        .to_owned();
    let target = dst_dir.join(&name);
    if target == src {
        return Ok(rel_of(root, &src));
    }
    if target.exists() {
        return Err("目标文件夹里已经有同名的了".to_string());
    }
    fs::rename(&src, &target).map_err(|e| format!("移动失败：{e}"))?;
    /* 笔记的图片目录跟着走：相对位置不变（.assets/<同名>/），正文里的相对路径继续有效 */
    if src.is_file() {
        let old_assets = asset_dir_for(&src);
        let new_assets = asset_dir_for(&target);
        if old_assets.is_dir() && !new_assets.exists() {
            let _ = fs::create_dir_all(new_assets.parent().unwrap_or(&dst_dir));
            let _ = fs::rename(&old_assets, &new_assets);
        }
    }
    Ok(rel_of(root, &target))
}

fn delete_at(root: &Path, rel: &str) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err("根目录不能删除".to_string());
    }
    let path = safe_join(root, rel)?;
    if !path.exists() {
        return Ok(()); // 已经不在了，当成功
    }
    if path.is_dir() {
        return fs::remove_dir_all(&path).map_err(|e| format!("删除失败：{e}"));
    }
    fs::remove_file(&path).map_err(|e| format!("删除失败：{e}"))?;
    /* 只删这篇笔记自己的图片目录：同一文件夹下别的笔记的图片在各自的
       .assets/<笔记名>/ 里，完全不受影响 */
    let assets = asset_dir_for(&path);
    if assets.is_dir() {
        let _ = fs::remove_dir_all(&assets);
    }
    Ok(())
}

// ---------- 图片 ----------

/// 某篇笔记的图片目录：<笔记所在目录>/.assets/<笔记名不含扩展名>/
fn asset_dir_for(note: &Path) -> PathBuf {
    let dir = note.parent().unwrap_or(note);
    let stem = note
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    dir.join(ASSET_DIR).join(stem)
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

fn safe_ext(raw: &str) -> String {
    let ext = raw.trim().trim_start_matches('.').to_ascii_lowercase().replace("jpeg", "jpg");
    if image_mime(&ext).is_some() {
        ext
    } else {
        "png".to_string()
    }
}

fn unique_image_path(dir: &Path, ext: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut index = 0;
    loop {
        let name = if index == 0 {
            format!("{stamp}.{ext}")
        } else {
            format!("{stamp}-{index}.{ext}")
        };
        let path = dir.join(name);
        if !path.exists() {
            return path;
        }
        index += 1;
    }
}

/// 保存一张粘贴进来的图片，返回相对笔记的 Markdown 路径。
fn save_image_at(root: &Path, note_rel: &str, data: &str, ext: &str) -> Result<String, String> {
    let note = safe_join(root, note_rel)?;
    if !note.is_file() {
        return Err("这篇笔记已经不在了".to_string());
    }
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("图片数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("图片是空的".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片太大了（超过 20MB）".to_string());
    }
    let ext = safe_ext(ext);
    let dir = asset_dir_for(&note);
    fs::create_dir_all(&dir).map_err(|e| format!("创建图片目录失败：{e}"))?;
    let path = unique_image_path(&dir, &ext);
    fs::write(&path, &bytes).map_err(|e| format!("保存图片失败：{e}"))?;
    let stem = note.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    Ok(format!("{ASSET_DIR}/{stem}/{name}"))
}

/// 读一张本地图片，返回 data URL 给 <img> 用。
fn read_image_at(root: &Path, note_rel: &str, rel: &str) -> Result<String, String> {
    let note = safe_join(root, note_rel)?;
    let base = note.parent().ok_or_else(|| "无法定位笔记所在目录".to_string())?;
    let path = safe_join(base, rel)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let mime = image_mime(&ext).ok_or_else(|| "不是支持的图片格式".to_string())?;
    let meta = fs::metadata(&path).map_err(|_| "图片不在了".to_string())?;
    if meta.len() as usize > MAX_IMAGE_BYTES {
        return Err("图片太大了".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

// ---------- 命令 ----------

#[tauri::command]
pub fn notes_read(rel: String, data: tauri::State<'_, DataRoot>) -> Result<String, String> {
    let root = read_root(&data)?;
    read_at(&root, &rel)
}

#[tauri::command]
pub fn notes_write(rel: String, content: String, data: tauri::State<'_, DataRoot>) -> Result<(), String> {
    let root = read_root(&data)?;
    write_at(&root, &rel, &content)
}

#[tauri::command]
pub fn notes_create(parent: String, name: String, data: tauri::State<'_, DataRoot>) -> Result<String, String> {
    let root = read_root(&data)?;
    create_note_at(&root, &parent, &name)
}

#[tauri::command]
pub fn notes_create_dir(parent: String, name: String, data: tauri::State<'_, DataRoot>) -> Result<String, String> {
    let root = read_root(&data)?;
    create_dir_at(&root, &parent, &name)
}

#[tauri::command]
pub fn notes_rename(rel: String, name: String, data: tauri::State<'_, DataRoot>) -> Result<String, String> {
    let root = read_root(&data)?;
    rename_at(&root, &rel, &name)
}

#[tauri::command]
pub fn notes_move(rel: String, target_dir: String, data: tauri::State<'_, DataRoot>) -> Result<String, String> {
    let root = read_root(&data)?;
    move_at(&root, &rel, &target_dir)
}

#[tauri::command]
pub fn notes_delete(rel: String, data: tauri::State<'_, DataRoot>) -> Result<(), String> {
    let root = read_root(&data)?;
    delete_at(&root, &rel)
}

/// 粘贴图片：前端把图片转成 base64 传进来，这里落到笔记同目录的 .assets/<笔记名>/ 下，
/// 返回可以直接写进 Markdown 的相对路径。
#[tauri::command]
pub fn notes_save_image(
    note_rel: String,
    data: String,
    ext: String,
    data_root: tauri::State<'_, DataRoot>,
) -> Result<String, String> {
    let root = read_root(&data_root)?;
    save_image_at(&root, &note_rel, &data, &ext)
}

/// 阅读态渲染本地图片：读成 data URL 交给 <img>，避免额外开放文件协议。
#[tauri::command]
pub fn notes_read_image(
    note_rel: String,
    rel: String,
    data: tauri::State<'_, DataRoot>,
) -> Result<String, String> {
    let root = read_root(&data)?;
    read_image_at(&root, &note_rel, &rel)
}

/// `canonicalize` 返回的是 `\\?\C:\...` 这种 verbatim 路径：文件操作认，但
/// explorer 不认，交给它之前先摘掉前缀（UNC 就还原成 `\\server\share`）。
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// explorer 的 `/select` 参数必须把路径放进引号里：否则像「新笔记 2.md」
/// 这种带空格的名字会被当成两个参数，explorer 找不到路径就去打开别的地方。
fn reveal_select_arg(path: &Path) -> String {
    format!("/select,\"{}\"", plain_path(path).display())
}

/// 在资源管理器里定位这个文件/文件夹（Windows 的 /select 会选中它）。
#[tauri::command]
pub fn notes_reveal(rel: String, data: tauri::State<'_, DataRoot>) -> Result<(), String> {
    let root = read_root(&data)?;
    let path = if rel.trim().is_empty() {
        root.clone()
    } else {
        safe_join(&root, &rel)?
    };
    if !path.exists() {
        return Err("这个文件/文件夹已经不在了".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        /* 必须用 raw_arg：explorer 有自己的一套命令行解析，不认 CRT 的
           \" 转义；用普通 arg() 会把引号转义成 \"，explorer 看不懂，
           就退回默认目录（文档）而不是定位到文件。 */
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(reveal_select_arg(&path))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &path;
        return Err("当前系统暂不支持在资源管理器中定位".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_paths() {
        let root = Path::new("C:\\notes");
        assert!(safe_join(root, "../secret.md").is_err());
        assert!(safe_join(root, "a/../../b.md").is_err());
        assert!(safe_join(root, "C:/Windows/x.md").is_err());
        assert!(safe_join(root, "a/b.md").is_ok());
    }

    #[test]
    fn checks_names() {
        assert!(check_name("周报", true).unwrap().ends_with(".md"));
        assert!(check_name("周报.md", true).unwrap() == "周报.md");
        assert!(check_name("  ", true).is_err());
        assert!(check_name("a/b", true).is_err());
        assert!(check_name("..", true).is_err());
        assert!(check_name("笔记.", true).is_err());
        assert!(check_name("资料", false).is_ok());
    }

    #[test]
    fn reveal_arguments_are_explorer_friendly() {
        // canonicalize 的 verbatim 前缀要摘掉
        let verbatim = Path::new(r"\\?\C:\Users\me\新笔记 2.md");
        assert_eq!(plain_path(verbatim), PathBuf::from(r"C:\Users\me\新笔记 2.md"));
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\srv\share\a b.md")),
            PathBuf::from(r"\\srv\share\a b.md")
        );
        assert_eq!(plain_path(Path::new(r"D:\notes\x.md")), PathBuf::from(r"D:\notes\x.md"));

        // 路径必须整体带引号，带空格的文件名才不会被拆开
        assert_eq!(
            reveal_select_arg(verbatim),
            "/select,\"C:\\Users\\me\\新笔记 2.md\""
        );
    }

    fn temp_root(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("workbench-notes-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("工作")).unwrap();
        base.canonicalize().unwrap()
    }

    #[test]
    fn file_operations_round_trip() {
        let root = temp_root("ops");

        let first = create_note_at(&root, "工作", "周报").unwrap();
        assert_eq!(first, "工作/周报.md");
        let second = create_note_at(&root, "工作", "周报").unwrap();
        assert_eq!(second, "工作/周报 2.md", "同名要自动加序号");

        write_at(&root, &first, "# 标题").unwrap();
        assert_eq!(read_at(&root, &first).unwrap(), "# 标题");

        let moved = move_at(&root, &second, "").unwrap();
        assert_eq!(moved, "周报 2.md");
        let renamed = rename_at(&root, &moved, "改名").unwrap();
        assert_eq!(renamed, "改名.md");
        assert!(root.join(&renamed).is_file());

        assert!(
            move_at(&root, "工作", "工作").is_err(),
            "不能把文件夹移动到它自己里面"
        );

        delete_at(&root, &renamed).unwrap();
        assert!(!root.join(&renamed).exists());

        let tree = walk(&root, &root, 0);
        assert_eq!(tree.len(), 1, "根目录下只剩「工作」文件夹");
        assert_eq!(tree[0].kind, "dir");
        assert!(tree[0].children.iter().any(|n| n.name == "周报.md"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn image_assets_follow_note_but_stay_separate() {
        let root = temp_root("img");
        let a = create_note_at(&root, "", "笔记 A").unwrap();
        let b = create_note_at(&root, "", "笔记 B").unwrap();

        // 一张极小的「png」（只要 base64 能来回就行）
        let png = BASE64.encode([137u8, 80, 78, 71]);
        let rel_a = save_image_at(&root, &a, &png, "png").unwrap();
        assert!(rel_a.starts_with(".assets/笔记 A/"), "图片落在笔记自己的子目录：{rel_a}");
        assert!(read_image_at(&root, &a, &rel_a).unwrap().starts_with("data:image/png;base64,"));

        let rel_b = save_image_at(&root, &b, &png, "png").unwrap();
        assert!(rel_b.starts_with(".assets/笔记 B/"));

        // 删掉 A：只删 A 的图片目录，B 的图片必须还在
        delete_at(&root, &a).unwrap();
        assert!(!root.join(".assets/笔记 A").exists(), "A 的图片目录应被删除");
        assert!(root.join(".assets/笔记 B").is_dir(), "B 的图片目录不能动");
        assert!(read_image_at(&root, &b, &rel_b).is_ok());

        // 改名：图片目录跟着改，正文里的相对路径也一起替换
        let md = format!("正文\n\n![图](<{rel_b}>)\n");
        write_at(&root, &b, &md).unwrap();
        let renamed = rename_at(&root, &b, "笔记 C").unwrap();
        assert!(root.join(".assets/笔记 C").is_dir());
        assert!(!root.join(".assets/笔记 B").exists());
        let new_md = read_at(&root, &renamed).unwrap();
        assert!(new_md.contains(".assets/笔记 C/"), "正文里的图片路径要跟着改：{new_md}");
        assert!(read_image_at(&root, &renamed, &rel_b.replace("笔记 B/", "笔记 C/")).is_ok());

        let _ = fs::remove_dir_all(&root);
    }
}
