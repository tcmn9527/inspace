/* canvas::files —— 从原 canvas.rs 拆出的子模块。 */

use super::*;
use super::video::{VIDEO_DIR, video_path, part_path, clear_parts, copy_stream};

// ---------- 文件块 ----------

/// 图片/音频/视频之外的都算文件：一律拷进画布 files/，双击交给系统默认程序打开。
/// 这一层不认格式、不装解析器，先保证「任何文件拖进来都有个落点，原文件删了也还在」。
const FILE_DIR: &str = "files";
/// 视频和文件共用这根进度事件：同一时刻只跑一个后台拷贝，两根进度条会打架。
pub(super) const COPY_EVENT: &str = "canvas-video-copy";
/// 到这个体积以内同步拷完直接返回，更大的走后台进度拷贝，界面不至于像卡住了
const SYNC_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Markdown 拖进来是当笔记块用的，正文抄进 items.json，太大的抄进去也没法看
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
/// 预览只读文件头这么多字节：20MB 的日志整份塞进 DOM 会把画布卡死
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
    "md", "markdown",
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

/// 在画布 files/ 下新建一个空文本文件：右键菜单「创建文件」用，
/// 扩展名限白名单里的文本格式，建完块就是拷贝态、可以直接在画布里编辑。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTextFile {
    pub rel: String,
    pub name: String,
    pub size: u64,
    pub ext: String,
    pub text: bool,
    pub markdown: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTypeOption {
    pub ext: String,
    pub label: String,
    pub group: String,
}

/* 新建文件时菜单里能选的类型：分组 + 可读名，顺序就是菜单顺序。
   白名单本身（TEXT_EXTS/MARKDOWN_EXTS）还是唯一裁判，这张表只负责怎么展示。 */
const FILE_TYPE_TABLE: &[(&str, &str, &str)] = &[
    ("md", "Markdown", "Markdown"),
    ("txt", "纯文本", "文本"),
    ("log", "日志", "文本"),
    ("srt", "字幕", "文本"),
    ("vtt", "字幕", "文本"),
    ("diff", "差异", "文本"),
    ("patch", "补丁", "文本"),
    ("eml", "邮件", "文本"),
    ("bib", "文献 BibTeX", "文本"),
    ("tex", "LaTeX", "文本"),
    ("json", "JSON", "数据"),
    ("jsonc", "JSONC", "数据"),
    ("json5", "JSON5", "数据"),
    ("jsonl", "JSON Lines", "数据"),
    ("ndjson", "NDJSON", "数据"),
    ("geojson", "GeoJSON", "数据"),
    ("yaml", "YAML", "数据"),
    ("yml", "YAML", "数据"),
    ("toml", "TOML", "数据"),
    ("xml", "XML", "数据"),
    ("csv", "CSV", "数据"),
    ("tsv", "TSV", "数据"),
    ("ics", "日历 ICS", "数据"),
    ("vcf", "名片 VCF", "数据"),
    ("gpx", "GPS 轨迹 GPX", "数据"),
    ("plist", "Plist", "数据"),
    ("rss", "RSS", "数据"),
    ("atom", "Atom", "数据"),
    ("html", "HTML", "网页"),
    ("htm", "HTML", "网页"),
    ("xhtml", "XHTML", "网页"),
    ("svg", "SVG", "网页"),
    ("css", "CSS", "网页"),
    ("scss", "SCSS", "网页"),
    ("sass", "Sass", "网页"),
    ("less", "Less", "网页"),
    ("vue", "Vue", "网页"),
    ("svelte", "Svelte", "网页"),
    ("js", "JavaScript", "代码"),
    ("mjs", "JavaScript", "代码"),
    ("cjs", "JavaScript", "代码"),
    ("ts", "TypeScript", "代码"),
    ("jsx", "JSX", "代码"),
    ("tsx", "TSX", "代码"),
    ("py", "Python", "代码"),
    ("rs", "Rust", "代码"),
    ("go", "Go", "代码"),
    ("java", "Java", "代码"),
    ("kt", "Kotlin", "代码"),
    ("c", "C", "代码"),
    ("h", "C 头文件", "代码"),
    ("cpp", "C++", "代码"),
    ("hpp", "C++ 头文件", "代码"),
    ("cs", "C#", "代码"),
    ("rb", "Ruby", "代码"),
    ("php", "PHP", "代码"),
    ("swift", "Swift", "代码"),
    ("dart", "Dart", "代码"),
    ("lua", "Lua", "代码"),
    ("r", "R", "代码"),
    ("sql", "SQL", "代码"),
    ("graphql", "GraphQL", "代码"),
    ("proto", "Protobuf", "代码"),
    ("tf", "Terraform", "代码"),
    ("zig", "Zig", "代码"),
    ("sh", "Shell", "脚本"),
    ("bash", "Bash", "脚本"),
    ("zsh", "Zsh", "脚本"),
    ("fish", "Fish", "脚本"),
    ("bat", "批处理", "脚本"),
    ("cmd", "批处理", "脚本"),
    ("ps1", "PowerShell", "脚本"),
    ("ini", "INI", "配置"),
    ("conf", "配置", "配置"),
    ("cfg", "配置", "配置"),
    ("env", "环境变量", "配置"),
    ("properties", "Properties", "配置"),
    ("editorconfig", "EditorConfig", "配置"),
    ("gitignore", "Git Ignore", "配置"),
    ("dockerfile", "Dockerfile", "配置"),
    ("makefile", "Makefile", "配置"),
    ("cmake", "CMake", "配置"),
];

/// 新建文件菜单能选的全部类型（分组与顺序由 FILE_TYPE_TABLE 决定，白名单外的剔除）。
#[tauri::command]
pub fn canvas_file_types() -> Vec<FileTypeOption> {
    FILE_TYPE_TABLE
        .iter()
        .filter(|(ext, _, _)| is_text_ext(ext) || is_markdown_ext(ext))
        .map(|(ext, label, group)| FileTypeOption {
            ext: ext.to_string(),
            label: label.to_string(),
            group: group.to_string(),
        })
        .collect()
}

/// 新建一个空文本文件：文件名和拷贝进来的附件同一套逻辑（毫秒时间戳 + 扩展名），
/// 建完返回存储相对路径，前端落成文件卡并直接进画布内编辑。
#[tauri::command]
pub fn canvas_create_file(
    id: String,
    ext: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<CreatedTextFile, String> {
    let dir = resolve_dir(&state, &id)?;
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !is_text_ext(&ext) && !is_markdown_ext(&ext) {
        return Err(format!(".{ext} 不是可创建的文本格式"));
    }
    let target_dir = dir.join(FILE_DIR);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建文件目录失败：{e}"))?;
    let path = unique_media_path(&target_dir, &safe_file_ext(&ext));
    fs::write(&path, b"").map_err(|e| format!("建文件失败：{e}"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "文件名不合法".to_string())?;
    Ok(CreatedTextFile {
        rel: format!("{FILE_DIR}/{name}"),
        name,
        size: 0,
        ext: ext.clone(),
        text: true,
        markdown: is_markdown_ext(&ext),
    })
}

/// 系统文件框选一个文件，不加扩展名过滤（什么格式都收）。取消返回 null。
#[tauri::command]
pub async fn canvas_pick_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<FileInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择文件")
        .set_parent(&window)
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    describe_file(&path).map(Some)
}

/// 系统文件框选一份 CSV（清单导入用）。取消返回 null。
#[tauri::command]
pub async fn canvas_pick_csv(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择 CSV 表格")
        .set_parent(&window)
        .add_filter("CSV 表格", &["csv", "txt"])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("无法解析所选文件：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 拷进画布之后的落点，卡片上的名字和体积都从这里来。
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

/// 复制一块的时候，把源块那份文件原样再拷一份，落进目标画布的同一个子目录，
/// 返回新的相对路径。路径不从嘴里信：只认源画布 items.json 里那条记录。
/// 引用态那块也一样收：src 是用户原文件的绝对路径，从那儿拷进画布，
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
        .ok_or_else(|| "这块已经不在画布上了".to_string())?;
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

/// 画面块里垫的那张位图：按 src 直接拷一份进目标画布的 images/，回新文件名。
/// 画面块的指令住在 pictures/<块id>.json，items.json 里查不到那张图，所以这条不走
/// canvas_duplicate_media 的「按块 id 从 items.json 认文件」，src 由前端从指令里读出来直给；
/// 抄来的 src 出不了源画布目录（media_path 自己会拦），引用态那条本来就是原文件的绝对路径。
#[tauri::command]
pub async fn canvas_duplicate_picture_image(
    id: String,
    src: String,
    linked: bool,
    to_id: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<String, String> {
    let from = media_source_path(&state, &id, &src, linked, IMAGE_DIR, "图片")?;
    let to_dir = resolve_dir(&state, &to_id)?;
    store_copy(&to_dir, &from, IMAGE_DIR)
}

/// 把一份已经在盘上的副本按新名字收进 `<目标画布>/<子目录>/`，返回带目录名的相对路径。
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

/// 读一份纯文本（CSV 清单导入用）：编码按 UTF-8/UTF-16/GB18030 自动认。
#[tauri::command]
pub fn canvas_read_text_file(path: String) -> Result<String, String> {
    let file = Path::new(&path);
    let meta = fs::metadata(file).map_err(|e| format!("读不到这个文件：{e}"))?;
    if !meta.is_file() {
        return Err("这个路径不是文件".to_string());
    }
    if meta.len() > 8 * 1024 * 1024 {
        return Err("文件太大了（超过 8MB）".to_string());
    }
    let bytes = fs::read(file).map_err(|e| format!("读取失败：{e}"))?;
    Ok(decode_text(&bytes)?.text)
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
/// 引用态 rel 就是原文件绝对路径，画布里没有副本。
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
pub(super) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
        .ok_or_else(|| "这块已经不在画布上了".to_string())?;
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
        return Err("这份文本超过 4MB，画布里只读不改，请到原文件里编辑".to_string());
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
/// CRLF 的文件别因为画布改了一次就整篇换行大改。
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
/// GBK 存的中文笔记不该因为画布改了一次就变 UTF-8，CRLF 的文件别整篇换行大改。
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

/// 引用态 rel 就是原文件绝对路径，拷贝态按画布目录下的相对路径找。
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

/// 书往画布上放之前先整本预读一遍目录：DRM、KF8 这类读不了的在这里就报错，
/// 免得用户先拷了 20MB 再发现打不开。
#[tauri::command]
pub fn canvas_ebook_info(path: String) -> Result<crate::ebook::Book, String> {
    crate::ebook::open(Path::new(&path))
}

/// 重开画布时只想拿目录，不重新弹一次「这书多大」：直接按块记的路径读。
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
        .ok_or_else(|| "这块已经不在画布上了".to_string())?;
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
