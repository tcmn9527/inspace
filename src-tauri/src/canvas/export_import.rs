/* canvas::export_import —— 从原 canvas.rs 拆出的子模块。 */

use super::*;

#[tauri::command]
pub async fn canvas_export_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    file_name: String,
    filter_name: String,
    exts: Vec<String>,
    target: Option<String>,
    data: String,
) -> Result<Option<String>, String> {
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("导出数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("导出的内容是空的".to_string());
    }
    let path = match target.filter(|one| !one.trim().is_empty()) {
        Some(path) => PathBuf::from(path),
        None => {
            let exts: Vec<&str> = exts.iter().map(String::as_str).filter(|one| !one.is_empty()).collect();
            let mut builder = app
                .dialog()
                .file()
                .set_title("导出")
                .set_file_name(file_name)
                .set_parent(&window);
            if !exts.is_empty() {
                builder = builder.add_filter(&filter_name, &exts);
            }
            let Some(file_path) = builder.blocking_save_file() else {
                return Ok(None);
            };
            file_path
                .into_path()
                .map_err(|e| format!("无法解析保存位置：{e}"))?
        }
    };
    fs::write(&path, &bytes).map_err(|e| format!("写文件失败：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// ---------- 导入 / 导出（.inspace = 标准 zip） ----------
/* 包根放一份 inspace.json 清单说明类型和名字；其余条目就是画布/分组目录的内容，
   条目名不带顶层目录，所以解压到哪儿就是哪儿，用户拿普通解压工具也能打开看。 */
const INSPACE_MANIFEST: &str = "inspace.json";
const INSPACE_KIND: &str = "inspace";
const INSPACE_FILTER: &str = "inspace";

fn zip_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

/// 把目录整棵塞进 zip。跳过隐藏文件、符号链接；条目名一律正斜杠相对路径。
fn zip_write_dir<W: Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    base: &Path,
    dir: &Path,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("读目录失败 {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .map_err(|_| "路径不在画布目录里".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if kind.is_dir() {
            zip_write_dir(zw, base, &path, depth + 1)?;
        } else if kind.is_file() {
            let bytes = fs::read(&path).map_err(|e| format!("读文件失败 {rel}：{e}"))?;
            zw.start_file(rel.as_str(), zip_options())
                .map_err(|e| format!("写入压缩包失败：{e}"))?;
            zw.write_all(&bytes)
                .map_err(|e| format!("写入压缩包失败：{e}"))?;
        }
    }
    Ok(())
}

/// 导出画布（group=false）或整个分组（group=true）为 .inspace。
/// target 给了就直接写到那个路径；不给就弹保存框。返回最终写出的路径，取消是 None。
#[tauri::command]
pub async fn canvas_export(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    group: bool,
    target: Option<String>,
) -> Result<Option<String>, String> {
    let root = app.state::<CanvasState>().root();
    let (dir, kind) = if group {
        (group_dir(&root, &id)?, "group")
    } else {
        (
            canvas_dir(&root, &id)?,
            "canvas",
        )
    };
    /* 根级分组导出 = 整个 spaces 打包，名字不用目录名 "spaces" */
    let name = if group && id.trim().is_empty() {
        "全部画布".to_string()
    } else {
        dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "画布".to_string())
    };
    let out_path = match target {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => {
            let picked = app
                .dialog()
                .file()
                .set_title("导出画布")
                .set_file_name(format!("{name}.{INSPACE_FILTER}"))
                .add_filter("无限画布容器", &["inspace"])
                .set_parent(&window)
                .blocking_save_file();
            let Some(file_path) = picked else {
                return Ok(None);
            };
            file_path
                .into_path()
                .map_err(|e| format!("无法解析保存位置：{e}"))?
        }
    };
    let out_path = if out_path.extension().is_none() {
        out_path.with_extension(INSPACE_FILTER)
    } else {
        out_path
    };
    let file = fs::File::create(&out_path).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut zw = zip::ZipWriter::new(file);
    let manifest = json!({
        "family": INSPACE_KIND,
        "version": 1,
        "kind": kind,
        "name": name,
        "exportedAt": now_ms(),
    });
    zw.start_file(INSPACE_MANIFEST, zip_options())
        .map_err(|e| format!("写入压缩包失败：{e}"))?;
    zw.write_all(manifest.to_string().as_bytes())
        .map_err(|e| format!("写入压缩包失败：{e}"))?;
    zip_write_dir(&mut zw, &dir, &dir, 0)?;
    zw.finish().map_err(|e| format!("收尾压缩包失败：{e}"))?;
    Ok(Some(out_path.to_string_lossy().to_string()))
}

fn zip_entry_is_symlink(unix_mode: Option<u32>) -> bool {
    matches!(unix_mode, Some(mode) if mode & 0o170000 == 0o120000)
}

/// 解压 .inspace 到 parent 分组下。source 给了就直接读那个文件；不给就弹打开框。
/// 画布包解出来是一个画布目录，分组件包解出来是一个子分组；重名自动加后缀。
/// 返回 {kind, id, name}，取消是 None。
#[tauri::command]
pub async fn canvas_import(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    parent: String,
    source: Option<String>,
) -> Result<Option<Value>, String> {
    let root = app.state::<CanvasState>().root();
    let parent_dir = group_dir(&root, &parent)?;
    let src_path = match source {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => {
            let picked = app
                .dialog()
                .file()
                .set_title("导入画布")
                .add_filter("无限画布容器", &["inspace"])
                .set_parent(&window)
                .blocking_pick_file();
            let Some(file_path) = picked else {
                return Ok(None);
            };
            file_path
                .into_path()
                .map_err(|e| format!("无法解析所选文件：{e}"))?
        }
    };
    let file = fs::File::open(&src_path).map_err(|e| format!("打开压缩包失败：{e}"))?;
    let mut za = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("这不是有效的 .inspace 压缩包：{e}"))?;
    /* 清单里的类型和名字只当参考：类型可以从包内容推翻，名字只作默认目录名 */
    let manifest: Option<Value> = za
        .by_name(INSPACE_MANIFEST)
        .ok()
        .and_then(|mut entry| {
            let mut text = String::new();
            entry.read_to_string(&mut text).ok()?;
            serde_json::from_str(&text).ok()
        });
    let file_stem = src_path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "导入的画布".to_string());
    let raw_name = manifest
        .as_ref()
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&file_stem)
        .to_string();
    let name = check_name(&raw_name).unwrap_or_else(|_| check_name(&file_stem).unwrap_or_else(|_| "导入的画布".to_string()));
    /* 根下有没有 space.json 是判断画布包的硬依据；清单里的 kind 只用来兜底 */
    let has_canvas_meta = (0..za.len()).any(|i| {
        za.by_index(i)
            .ok()
            .and_then(|entry| entry.enclosed_name())
            .map(|path| {
                path.parent().map(|p| p.as_os_str().is_empty()).unwrap_or(true)
                    && (path.file_name().map(|n| n == META_FILE || n == LEGACY_META_FILE).unwrap_or(false))
            })
            .unwrap_or(false)
    });
    let kind = if has_canvas_meta {
        "canvas"
    } else if manifest.as_ref().and_then(|m| m.get("kind")).and_then(|v| v.as_str()) == Some("group") {
        "group"
    } else {
        "canvas"
    };
    let new_dir = unique_dir(&parent_dir, &name);
    fs::create_dir_all(&new_dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let mut unpacked = 0u32;
    for i in 0..za.len() {
        let Ok(mut entry) = za.by_index(i) else { continue };
        if entry.name() == INSPACE_MANIFEST {
            continue;
        }
        /* enclosed_name 挡掉 ..、绝对路径和盘符；符号链接一律不落盘 */
        let Some(rel) = entry.enclosed_name() else { continue };
        let target = new_dir.join(&rel);
        if entry.is_dir() {
            let _ = fs::create_dir_all(&target);
            continue;
        }
        if zip_entry_is_symlink(entry.unix_mode()) {
            continue;
        }
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir).map_err(|e| {
                let _ = fs::remove_dir_all(&new_dir);
                format!("创建目录失败：{e}")
            })?;
        }
        let mut bytes = Vec::with_capacity(entry.size().min(64 * 1024 * 1024) as usize);
        if let Err(e) = entry.read_to_end(&mut bytes) {
            let _ = fs::remove_dir_all(&new_dir);
            return Err(format!("解压失败：{e}"));
        }
        if let Err(e) = fs::write(&target, &bytes) {
            let _ = fs::remove_dir_all(&new_dir);
            return Err(format!("写入文件失败：{e}"));
        }
        unpacked += 1;
    }
    if unpacked == 0 {
        let _ = fs::remove_dir_all(&new_dir);
        return Err("压缩包里没有可导入的内容".to_string());
    }
    /* 包里没带清单里的目录结构（手工压的包）时，跟着内容重新认一遍类型 */
    let kind = if is_canvas_dir(&new_dir) { "canvas" } else { kind };
    /* 画布目录的约定是带一个 images/：空画布的包不会带它，这里补齐 */
    if kind == "canvas" {
        let _ = fs::create_dir_all(new_dir.join(IMAGE_DIR));
    }
    let new_id = rel_id(&root, &new_dir);
    let final_name = new_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(name);
    Ok(Some(json!({
        "kind": kind,
        "id": new_id,
        "name": final_name,
        "parent": parent,
    })))
}

// ---------- 导出 ----------

/// 导出时把块引用的图片读成 data URL。
/// 画布里的图走 asset 协议加载，那是另一个源，直接塞进 canvas 会把画布污染成
/// 取不出像素的状态；从这条线把字节读出来再进导出图，就没有跨域这回事。
#[tauri::command]
pub fn canvas_image_data(
    id: String,
    src: String,
    linked: bool,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let path = media_source_path(&state, &id, &src, linked, IMAGE_DIR, "图片")?;
    image_data_url(&path, "图片不在了")
}

/// 导出：弹系统保存框，把前端拼好的文件写出去。取消返回 null。
/// 收 png / pdf / html / docx，路径由用户在那个框里定，前端递来的只是一个建议文件名。
#[tauri::command]
pub async fn canvas_export_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    ext: String,
    data: String,
) -> Result<Option<String>, String> {
    let ext = ext.to_lowercase();
    if ext != "png" && ext != "pdf" && ext != "html" && ext != "docx" && ext != "csv" && ext != "xlsx" {
        return Err("只支持导出 png、pdf、html、docx、csv 和 xlsx".to_string());
    }
    let safe_name = name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], " ");
    let safe_name = if safe_name.trim().is_empty() {
        "space".to_string()
    } else {
        safe_name.trim().to_string()
    };
    let picked = app
        .dialog()
        .file()
        .set_title("导出")
        .set_parent(&window)
        .set_file_name(format!("{safe_name}.{ext}"))
        .add_filter(
            match ext.as_str() {
                "pdf" => "PDF",
                "html" => "网页",
                "docx" => "Word 文档",
                "csv" => "CSV 表格",
                "xlsx" => "Excel 表格",
                _ => "PNG 图片",
            },
            &[ext.as_str()],
        )
        .blocking_save_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析保存位置：{e}"))?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("导出数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("导出内容是空的".to_string());
    }
    fs::write(&path, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 导出完顺手用默认程序打开。
///
/// 公众号文章的成品自带「复制全文」按钮，可用户还得自己去文件夹里翻一遍，
/// 这一步就是为了省掉那次翻找。只放行导出的网页：这条命令把路径交给系统执行，
/// 范围开得越小越好。
#[tauri::command]
pub fn canvas_open_export(path: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err("这个文件不在了".to_string());
    }
    let ext = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "html" && ext != "htm" {
        return Err("只有导出的网页能直接打开".to_string());
    }
    open::that(&file).map_err(|e| format!("打不开这个文件：{e}"))
}

/// 分段导出第一步：选一个文件夹。取消返回 null。
///
/// 分段导出会出好几张图，一张一个保存框就没法用了，所以先选一次目录，
/// 之后由前端一张一张调用 `canvas_export_write` 写进去。
#[tauri::command]
pub async fn canvas_export_pick_dir(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("导出到文件夹")
        .set_parent(&window)
        .blocking_pick_folder();
    let Some(dir) = picked else {
        return Ok(None);
    };
    let path = dir
        .into_path()
        .map_err(|e| format!("无法解析文件夹：{e}"))?;
    if !path.is_dir() {
        return Err("选的不是一个文件夹".to_string());
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 分段导出第二步：把一张图写进上面选好的文件夹。
///
/// 文件名由前端给（带序号），这里只挡掉路径穿越：名字里不许有分隔符，
/// 也不许出现 ..，最后一定落在 dir 里面。
#[tauri::command]
pub async fn canvas_export_write(
    dir: String,
    name: String,
    ext: String,
    data: String,
) -> Result<String, String> {
    let path = export_write_target(&dir, &name, &ext)?;
    /* 同名不覆盖：同一个画布导第二遍，别把上一版悄悄顶掉 */
    let path = unique_path(path);
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("导出数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("导出内容是空的".to_string());
    }
    fs::write(&path, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// agent 用的导出：不弹框，直接写到数据根下的 exports/ 里。
/// UI 那条路要用户挑位置；agent 这条路只需要一个确定的落点。
#[tauri::command]
pub async fn canvas_export_auto(
    state: tauri::State<'_, CanvasState>,
    name: String,
    ext: String,
    data: String,
) -> Result<String, String> {
    let dir = state.data.dir("exports");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建导出目录：{e}"))?;
    let path = export_write_target(&dir.to_string_lossy(), &name, &ext)?;
    let path = unique_path(path);
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("导出数据有误：{e}"))?;
    if bytes.is_empty() {
        return Err("导出内容是空的".to_string());
    }
    fs::write(&path, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 小红书卡片图：一次写一整个文件夹（01.png、02.png…）。
/// 单张走 canvas_export_auto 会把名字里的斜杠抹成空格，建不了子目录，所以单开一条。
#[derive(serde::Deserialize)]
pub struct CardFile {
    pub rel: String,
    pub data: String,
}

#[tauri::command]
pub fn canvas_export_cards(
    state: tauri::State<'_, CanvasState>,
    name: String,
    files: Vec<CardFile>,
) -> Result<String, String> {
    if files.is_empty() {
        return Err("没有要写的卡片".to_string());
    }
    let root = state.data.dir("exports");
    fs::create_dir_all(&root).map_err(|e| format!("无法创建导出目录：{e}"))?;
    let safe = name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], " ");
    let safe = safe.trim().trim_matches('.').trim();
    if safe.is_empty() || safe.contains("..") {
        return Err("文件名不合法".to_string());
    }
    let folder = unique_card_dir(root.join(safe));
    fs::create_dir_all(&folder).map_err(|e| format!("创建卡片目录失败：{e}"))?;
    for file in &files {
        let rel = Path::new(&file.rel);
        let mut parts = rel.components();
        let Some(Component::Normal(part)) = parts.next() else {
            return Err("卡片文件名不合法".to_string());
        };
        if parts.next().is_some() {
            return Err("卡片只能写在一层里".to_string());
        }
        let bytes = BASE64
            .decode(file.data.as_bytes())
            .map_err(|e| format!("卡片数据有误：{e}"))?;
        if bytes.is_empty() {
            return Err("卡片内容是空的".to_string());
        }
        fs::write(folder.join(part), &bytes).map_err(|e| format!("写入卡片失败：{e}"))?;
    }
    Ok(folder.to_string_lossy().to_string())
}

/// 目录撞名就加序号：同名再导一次是新的一批图，不该把上一批顶掉。
fn unique_card_dir(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    for n in 2..1000 {
        let candidate = parent.join(format!("{name} ({n})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

/// 客户版网页导出：按相对路径写文件，父目录自动建。
/// 名字只许正常的路径段（不许 ..、隐藏文件、绝对路径），最后一定落在 dir 里面。
/// 和分段导出不同，这里允许覆盖：每次导出一个新的时间戳子文件夹，同一批文件要能互相引用。
#[tauri::command]
pub fn canvas_export_write_path(dir: String, rel: String, data: String) -> Result<String, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("导出文件夹不在了".to_string());
    }
    let rel_path = Path::new(&rel);
    if rel_path.as_os_str().is_empty() {
        return Err("导出文件名是空的".to_string());
    }
    let mut out = root;
    for component in rel_path.components() {
        let Component::Normal(part) = component else {
            return Err("导出文件名不合法".to_string());
        };
        let text = part.to_string_lossy();
        if text.is_empty() || text.starts_with('.') {
            return Err("导出文件名不合法".to_string());
        }
        out.push(part);
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败：{e}"))?;
    }
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("导出数据有误：{e}"))?;
    fs::write(&out, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(out.to_string_lossy().to_string())
}

/// 导出完打开那个文件夹：客户版网页是一整个目录，得让用户看到它在哪。
#[tauri::command]
pub fn canvas_export_reveal(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("这个导出文件夹不在了".to_string());
    }
    open::that(&dir).map_err(|e| format!("打不开这个文件夹：{e}"))
}

/// 撞名就往后加序号：`西游记-01.png` 已存在就写 `西游记-01 (2).png`。
/// 分段导出常常整批重来，覆盖上一版不是「更新」，是「弄丢了」。
fn unique_path(path: PathBuf) -> PathBuf {    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    for n in 2..1000 {
        let candidate = parent.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

/// 算出「这张图该写到哪」。摘出来是为了能单测：路径拼接和过滤是这个命令里
/// 唯一会出错的地方，弹框和写盘反而没什么好测的。
fn export_write_target(dir: &str, name: &str, ext: &str) -> Result<PathBuf, String> {
    let ext = ext.to_lowercase();
    if ext != "png" && ext != "pdf" && ext != "html" && ext != "docx" {
        return Err("只支持导出 png、pdf、html 和 docx".to_string());
    }
    let folder = PathBuf::from(dir);
    if !folder.is_dir() {
        return Err("导出文件夹不在了".to_string());
    }
    let safe_name = name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], " ");
    let safe_name = safe_name.trim().trim_matches('.').trim();
    if safe_name.is_empty() || safe_name.contains("..") {
        return Err("文件名不合法".to_string());
    }
    Ok(folder.join(format!("{safe_name}.{ext}")))
}

#[cfg(test)]
mod export_write_tests {
    use super::export_write_target;

    #[test]
    fn builds_path_for_normal_name() {
        let dir = std::env::temp_dir();
        let path = export_write_target(dir.to_str().unwrap(), "西游记 · 一百回全卷-03", "png").unwrap();
        assert!(path.starts_with(&dir));
        assert!(path.to_string_lossy().ends_with("西游记 · 一百回全卷-03.png"));
    }

    #[test]
    fn keeps_separators_inside_dir() {
        let dir = std::env::temp_dir();
        let path = export_write_target(dir.to_str().unwrap(), "a/b\\c", "png").unwrap();
        assert_eq!(path.parent(), Some(dir.as_path()));
        assert!(path.to_string_lossy().ends_with("a b c.png"));
    }

    #[test]
    fn rejects_traversal() {
        let dir = std::env::temp_dir();
        assert!(export_write_target(dir.to_str().unwrap(), "..\\..\\evil", "png").is_err());
        assert!(export_write_target(dir.to_str().unwrap(), "....", "png").is_err());
    }

    #[test]
    fn rejects_bad_ext_and_empty_name() {
        let dir = std::env::temp_dir();
        assert!(export_write_target(dir.to_str().unwrap(), "a", "exe").is_err());
        assert!(export_write_target(dir.to_str().unwrap(), "   ", "png").is_err());
    }
}
