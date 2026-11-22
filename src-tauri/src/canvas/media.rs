/* canvas::media —— 从原 canvas.rs 拆出的子模块。 */

use super::*;
use super::files::write_bytes_atomic;

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
        return Err(format!(
            "图片太大了（超过 {}MB）",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    store_image(&dir, &bytes, &ext)
}

/// 用系统文件框选一张图片，只返回它的绝对路径（拷不拷由前端问用户）。取消返回 null。
/* 系统框会一直阻塞到用户选完：命令必须跑在线程池里，不能占着主线程。
   主线程一停，Windows 就把窗口判成未响应，用户点一下就会盖上原生的白色标题栏。
   挂在发起命令的窗口上，框开着的时候窗口照旧点不动，但帧还能正常刷。 */
#[tauri::command]
pub async fn canvas_pick_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择图片")
        .set_parent(&window)
        .add_filter("图片", &IMAGE_EXTS)
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 把资源管理器里拖进画布的图片存进 images/。
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

/// 选文件/拖文件进画布前的共同一问：空的没什么可显示
fn require_non_empty(path: &Path, what: &str) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|_| format!("{what}不在了"))?;
    if meta.len() == 0 {
        return Err(format!("{what}是空的"));
    }
    Ok(())
}

/// 从磁盘整份拷进画布的某个媒体目录。走 fs::copy 不过 base64，
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

/// 图片块的显示地址：拷贝态给画布 images/ 里那份，引用态给原文件。
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

/// 双击画布上那块图，用系统默认的看图工具打开：画布上那块太小，看不清原图时用。
///
/// 路径只从 items.json 里那块自己算（前端递来的块 id 是唯一线索），
/// 所以这条命令开不出画布里没有的图片。引用态那块开的是原文件本身。
#[tauri::command]
pub fn canvas_open_image(
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
        .ok_or_else(|| "这块已经不在画布上了".to_string())?;
    let kind = found.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind != "image" && kind != "gen" {
        return Err("这块不是图片".to_string());
    }
    let src = found.get("src").and_then(Value::as_str).unwrap_or_default();
    if src.is_empty() {
        return Err("这块还没有图".to_string());
    }
    let linked = kind == "image" && found.get("linked").and_then(Value::as_bool) == Some(true);
    let path = if linked {
        PathBuf::from(src)
    } else {
        media_path(&dir, src, IMAGE_DIR, "图片")?
    };
    if !path.is_file() {
        return Err("图片不在了".to_string());
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err("这不是图片文件".to_string());
    }
    open::that(&path).map_err(|e| format!("打不开这张图：{e}"))
}

/// 把图片块/生图面板上的图另存到用户挑的位置：只复制一份，画布里那份不动。
#[tauri::command]
pub async fn canvas_image_save_as(
    id: String,
    item_id: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, CanvasState>,
) -> Result<Option<String>, String> {
    let dir = resolve_dir(&state, &id)?;
    let items = read_items(&dir)?;
    let found = items
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|it| it.get("id").and_then(Value::as_str) == Some(item_id.as_str()))
        })
        .ok_or_else(|| "这块已经不在画布上了".to_string())?;
    let kind = found.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind != "image" && kind != "gen" {
        return Err("这块不是图片".to_string());
    }
    let src = found.get("src").and_then(Value::as_str).unwrap_or_default();
    if src.is_empty() {
        return Err("这块还没有图".to_string());
    }
    let linked = kind == "image" && found.get("linked").and_then(Value::as_bool) == Some(true);
    let source = if linked {
        PathBuf::from(src)
    } else {
        media_path(&dir, src, IMAGE_DIR, "图片")?
    };
    if !source.is_file() {
        return Err("图片不在了".to_string());
    }
    let name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.png".to_string());
    let picked = app
        .dialog()
        .file()
        .set_title("图片另存为")
        .set_parent(&window)
        .set_file_name(&name)
        .add_filter("图片", &["png", "jpg", "jpeg", "webp"])
        .blocking_save_file();
    let Some(target) = picked.and_then(|value| value.into_path().ok()) else {
        return Ok(None);
    };
    fs::copy(&source, &target).map_err(|e| format!("保存失败：{e}"))?;
    Ok(Some(target.to_string_lossy().to_string()))
}

/// 删图片块：拷贝态把画布里那份副本送进回收站；引用态只断链接，原图是用户自己的东西。
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
    let path = media_path_in(&dir, &src, IMAGE_DIR, "图片")?;
    /* 已经不在了：想做的事本来就已经做完了，不当成错 */
    if !path.is_file() {
        return Ok(());
    }
    recycle_path(&path).map_err(|e| format!("删除图片失败：{e}"))
}

/// 画布笔记块自己的图片副本：notes/<块id>/<时间戳>.<ext>。
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
        return Err(format!(
            "图片太大了（超过 {}MB）",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
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

// ---------- 笔记块：一块一份文件 ----------
//
// 画布上的笔记块有一份自己的 Markdown 文件，住在画布自己的目录里。

/// 画布笔记块的正文（不是引用态；引用态那份走 canvas_note_write_back 碰用户自己的文件）。
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

/// 复制 Markdown 文件块（file 块）时把它贴图的图床 notes/<块id>/ 一起搬过去，
/// 并把副本正文里指向旧块目录的图片路径换成新块目录——删掉原块后副本的图不裂。
/// 正文位置用前端递来的新 rel（复制刚发生，目标画布的 items.json 可能还没落盘这块）。
#[tauri::command]
pub fn canvas_duplicate_file_assets(
    id: String,
    item_id: String,
    to_id: String,
    to_item_id: String,
    to_src: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let from_dir = resolve_dir(&state, &id)?;
    let to_dir = resolve_dir(&state, &to_id)?;
    let from_assets = note_item_dir(&from_dir, &item_id)?;
    let to_assets = note_item_dir(&to_dir, &to_item_id)?;
    if from_assets.is_dir() {
        copy_dir_all(&from_assets, &to_assets)?;
    }
    let rel = to_src.replace('\\', "/");
    let path = media_path_in(&to_dir, &rel, FILE_DIR, "文件")?;
    if !path.is_file() {
        return Ok(());
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取正文失败：{e}"))?;
    let decoded = super::files::decode_text(&bytes)?;
    let old = format!("notes/{}/", item_id.trim());
    if !decoded.text.contains(&old) {
        return Ok(());
    }
    let new = format!("notes/{}/", to_item_id.trim());
    let updated = decoded.text.replace(&old, &new);
    let out = super::files::encode_text(&updated, decoded.format, decoded.crlf)?;
    super::files::write_bytes_atomic(&path, &out)
}

// ---------- 画面块的绘制指令 ----------

/// 一幅画面最多收多少条指令，口径跟前端那条上限一致。
const MAX_PICTURE_CMDS: usize = 4000;
/// 素材表的个数：老文件还没这一项，读出来就是空表。
const MAX_PICTURE_SYMBOLS: usize = 200;

/// 只收 cmds 和 symbols 两样：条数掐到上限、非对象的条目丢掉。
/// 单条指令长什么样不在这里查——前端每读一次都会自己严格过一遍（认不了的整条丢），
/// 这儿挡的只是坏文件把盘和内存一起撑爆。
fn picture_of(raw: &Value) -> Value {
    let list: Vec<Value> = raw
        .get("cmds")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|cmd| cmd.is_object())
                .take(MAX_PICTURE_CMDS)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let symbols = raw
        .get("symbols")
        .filter(|value| {
            value
                .as_object()
                .map_or(false, |map| map.len() <= MAX_PICTURE_SYMBOLS)
        })
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({ "cmds": list, "symbols": symbols, "updatedAt": now_ms() })
}

/// 这块画面的指令文件；还没落过盘返回 null，由前端拿块上残留的指令补写一次。
#[tauri::command]
pub fn canvas_read_picture(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Option<Value>, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = picture_file(&dir, &item_id)?;
    read_json(&path).map(|value| value.map(|raw| picture_of(&raw)))
}

#[tauri::command]
pub fn canvas_write_picture(
    id: String,
    item_id: String,
    cmds: Value,
    symbols: Option<Value>,
    state: tauri::State<'_, CanvasState>,
) -> Result<Value, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = picture_file(&dir, &item_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建画面目录失败：{e}"))?;
    }
    let value = picture_of(&json!({ "cmds": cmds, "symbols": symbols }));
    write_json_compact(&path, &value)?;
    Ok(value)
}

/// 删掉一块画面：它自己那份指令文件进系统回收站，画过的东西不留在盘上没人认领。
#[tauri::command]
pub fn canvas_delete_picture(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let path = picture_file(&dir, &item_id)?;
    if path.is_file() {
        recycle_path(&path).map_err(|e| format!("删除画面失败：{e}"))?;
    }
    prune_empty(&dir.join(PICTURE_DIR));
    Ok(())
}

// ---------- 场景块里的东西 ----------

/// 一块场景最多收多少件，口径跟前端那条上限一致。
const MAX_SCENE_PARTS: usize = 2000;

/// 只收 parts 一样：件数掐到上限、非对象的条目丢掉。
/// 单件长什么样不在这里查——前端每读一次都会自己严格过一遍（认不了的整件丢），
/// 这儿挡的只是坏文件把盘和内存一起撑爆。
fn scene_of(raw: &Value) -> Value {
    let list: Vec<Value> = raw
        .get("parts")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|part| part.is_object())
                .take(MAX_SCENE_PARTS)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    json!({ "parts": list, "updatedAt": now_ms() })
}

/// 这块场景的东西文件；还没落过盘返回 null，由前端拿块上残留的那份补写一次。
#[tauri::command]
pub fn canvas_read_scene(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Option<Value>, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = scene_file(&dir, &item_id)?;
    read_json(&path).map(|value| value.map(|raw| scene_of(&raw)))
}

#[tauri::command]
pub fn canvas_write_scene(
    id: String,
    item_id: String,
    parts: Value,
    state: tauri::State<'_, CanvasState>,
) -> Result<Value, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = scene_file(&dir, &item_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建场景目录失败：{e}"))?;
    }
    let value = scene_of(&json!({ "parts": parts }));
    write_json_compact(&path, &value)?;
    Ok(value)
}

/// 删掉一块场景：它自己那份东西文件进系统回收站，摆好的院子不留在盘上没人认领。
#[tauri::command]
pub fn canvas_delete_scene(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let path = scene_file(&dir, &item_id)?;
    if path.is_file() {
        recycle_path(&path).map_err(|e| format!("删除场景失败：{e}"))?;
    }
    prune_empty(&dir.join(SCENE_DIR));
    Ok(())
}

// ---------- 生图面板的内容 ----------

/// 一块面板的提示词最长多少字：比一句提示词宽裕，但绝不让一份文件变成文章。
const GEN_TEXT_MAX: usize = 4000;

fn gen_text(raw: &Value, key: &str, max: usize) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .map(|text| text.chars().take(max).collect())
        .unwrap_or_default()
}

fn gen_int(raw: &Value, key: &str, fallback: i64, lo: i64, hi: i64) -> i64 {
    raw.get(key)
        .and_then(Value::as_f64)
        .map(|value| value.round().clamp(lo as f64, hi as f64) as i64)
        .unwrap_or(fallback)
}

/// 只收这一份文件该收的字段：坏数据在这儿挡一次，读回来的就永远是能用的。
/// 出图状态（第几步、忙不忙）不落盘——那是这一轮运行时的东西，重开画布该回到「上次那张」。
fn gen_of(raw: &Value) -> Value {
    json!({
        "prompt": gen_text(raw, "prompt", GEN_TEXT_MAX),
        "negative": gen_text(raw, "negative", GEN_TEXT_MAX),
        "imageW": gen_int(raw, "imageW", 1024, 256, 4096),
        "imageH": gen_int(raw, "imageH", 1024, 256, 4096),
        /* 0 = 跟着当前模型走（Qwen 30 步 / H3 6 步）；只有真的写过步数才存正数 */
        "steps": gen_int(raw, "steps", 0, 0, 100),
        "cfg": raw
            .get("cfg")
            .and_then(Value::as_f64)
            .map(|value| value.clamp(0.0, 20.0))
            .unwrap_or(0.0),
        "seed": gen_int(raw, "seed", -1, -1, i64::MAX as i64),
        /* 出图那一档和改动幅度：认不出的一律回 auto / 0.75，
           别把写错的字符串原样存回去，下次读出来还是错的 */
        "mode": raw
            .get("mode")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "auto" | "t2i" | "i2i" | "edit" | "upscale" | "inpaint"))
            .unwrap_or("auto"),
        /* 空串 = 跟随设置里的当前模型 */
        "model": raw
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "qwen21" | "h3image"))
            .unwrap_or(""),
        "strength": raw
            .get("strength")
            .and_then(Value::as_f64)
            .map(|value| value.clamp(0.0, 1.0))
            .unwrap_or(0.75),
        "updatedAt": now_ms(),
    })
}

/// 这块面板的内容文件；还没落过盘返回 null，由前端拿块上残留的那份补写一次。
#[tauri::command]
pub fn canvas_read_gen(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Option<Value>, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = gen_file(&dir, &item_id)?;
    read_json(&path).map(|value| value.map(|raw| gen_of(&raw)))
}

#[tauri::command]
pub fn canvas_write_gen(
    id: String,
    item_id: String,
    content: Value,
    state: tauri::State<'_, CanvasState>,
) -> Result<Value, String> {
    let dir = resolve_dir(&state, &id)?;
    let path = gen_file(&dir, &item_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建生图目录失败：{e}"))?;
    }
    let value = gen_of(&content);
    write_json_compact(&path, &value)?;
    Ok(value)
}

/// 删掉一块面板：那份内容文件进系统回收站。
/// 出的那张图不归这儿管——它已经落在 images/ 里，由 images 那套按引用清。
#[tauri::command]
pub fn canvas_delete_gen(
    id: String,
    item_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<(), String> {
    let dir = resolve_dir(&state, &id)?;
    let path = gen_file(&dir, &item_id)?;
    if path.is_file() {
        recycle_path(&path).map_err(|e| format!("删除生图面板失败：{e}"))?;
    }
    prune_empty(&dir.join(GENPANEL_DIR));
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

/// 带用户去看这块笔记自己那份文件躺在哪儿：路径只从 items.json 里那块记的类型算，
/// 前端递来的块 id 是唯一线索，所以这儿开不出画布目录以外的东西。
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
        .ok_or_else(|| "这块已经不在画布上了".to_string())?;
    let path = match found.get("type").and_then(Value::as_str).unwrap_or_default() {
        "note" => note_text_file(&dir, &item_id)?,
        "picture" => picture_file(&dir, &item_id)?,
        "scene" => scene_file(&dir, &item_id)?,
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
pub async fn canvas_pick_audio(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择音频")
        .set_parent(&window)
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

/// 把资源管理器里拖进画布的音频存进 audio/。
#[tauri::command]
pub fn canvas_import_audio(
    id: String,
    path: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<PickedAudio, String> {
    let dir = resolve_dir(&state, &id)?;
    import_audio_file(&dir, Path::new(&path))
}

/// 音频块的播放地址：拷贝态给画布 audio/ 里那份，引用态给原文件。
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

/// 删音频块：拷贝态回收画布里那份副本；引用态只断链接，不动原文件。
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
