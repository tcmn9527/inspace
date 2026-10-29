//! 无限空间的数据根目录：用户内容全在它下面，一条路径由 SQLite 的 setting 记住。
//!
//!   notes/               笔记页那棵 Markdown 树（notes.rs）
//!   spaces/<空间名>/     无限空间，一个空间一个文件夹（canvas.rs）
//!
//! 换根目录时这两块一起走（用户当场选拷贝、剪贴还是新建）；`components/ffmpeg` 和
//! SQLite 留在 app_data_dir，那是程序自己的东西，不算用户内容。
//!
//! 旧版的便签墙和待办栏已经在界面上线，它们留下的 `stickies/`、`todos/` 两个目录
//! 归启动时的 `migrate` 送进系统回收站——原地留着只会让人以为功能还在。
//! 空间上的便签块另有一套，住在各空间自己的目录里，跟这两个目录无关。
//!
//! 根目录路径存在 SQLite 的 setting 表里，启动时同步进下面的 `DataRoot` 镜像。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::db::{self, DbState};

const ROOT_KEY: &str = "data_root";
/// 已下线的便签墙、待办栏留在数据根里的那两个目录，启动时清掉
pub const STICKY_DIR: &str = "stickies";
pub const TODO_DIR: &str = "todos";
/// 笔记树和空间各自的子目录名，notes.rs / canvas.rs 认这两个
pub const NOTE_DIR: &str = "notes";
pub const SPACE_DIR: &str = "spaces";
/// 旧版把空间放在 canvases/ 下，启动时整批改名
pub const LEGACY_CANVAS_DIR: &str = "canvases";

/// 当前数据根目录。SQLite 里那条 setting 是持久化，这份镜像是给
/// 空间、笔记的命令读的：它们只想知道「现在该往哪儿放」，不该各自再存一份对不上的路径。
#[derive(Clone)]
pub struct DataRoot {
    default: PathBuf,
    current: Arc<Mutex<PathBuf>>,
}

impl DataRoot {
    fn new(default: PathBuf) -> Self {
        Self {
            default: default.clone(),
            current: Arc::new(Mutex::new(default)),
        }
    }

    /// 当前根目录。锁被前一次 panic 弄脏了就退回默认值，别让应用从此打不开数据。
    pub fn get(&self) -> PathBuf {
        self.current
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| self.default.clone())
    }

    /// 根目录下的某个子目录（notes / spaces）。
    pub fn dir(&self, sub: &str) -> PathBuf {
        self.get().join(sub)
    }

    fn set(&self, path: &Path) {
        match self.current.lock() {
            Ok(mut guard) => *guard = path.to_path_buf(),
            Err(poisoned) => *poisoned.into_inner() = path.to_path_buf(),
        }
    }
}

pub struct StoreState {
    default_root: PathBuf,
    /// 换根目录时和 SQLite 一起改，空间/笔记读的就是这一份
    root: DataRoot,
    /// 文件读写和「换目录」互斥，避免移动数据时还有写操作落在旧目录
    lock: Mutex<()>,
}

pub fn init(app_dir: PathBuf) -> StoreState {
    let default_root = app_dir.join("data");
    StoreState {
        root: DataRoot::new(default_root.clone()),
        default_root,
        lock: Mutex::new(()),
    }
}

/// 给 lib.rs 分发用：把根目录镜像交给空间、笔记那些拿不到 StoreState 的模块。
pub fn root_handle(state: &StoreState) -> DataRoot {
    state.root.clone()
}


fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn conn(db: &DbState) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.0.lock()
        .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())
}

/// 当前根目录只有一份真相：`DataRoot` 里的镜像。启动时 `migrate` 用 SQLite
/// 里那条 setting 把它填好，之后空间、笔记、便签读的都是同一个路径。
fn read_root(state: &StoreState) -> PathBuf {
    state.root.get()
}

/// 换根目录：先落库再更新镜像，两边一起才算切完。
fn write_root(db: &DbState, state: &StoreState, path: &Path) -> Result<(), String> {
    {
        let conn = conn(db)?;
        db::write_setting(&conn, ROOT_KEY, &path.to_string_lossy())?;
    }
    state.root.set(path);
    Ok(())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => a == b,
    }
}

fn ensure_dirs(root: &Path) -> Result<(), String> {
    for sub in [NOTE_DIR, SPACE_DIR] {
        let dir = root.join(sub);
        fs::create_dir_all(&dir).map_err(|e| format!("无法创建目录 {}：{e}", dir.display()))?;
    }
    Ok(())
}

// ---------- 数据目录 ----------

#[tauri::command]
pub fn data_root(state: tauri::State<'_, StoreState>) -> Result<String, String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "数据状态异常（前一次访问发生 panic）".to_string())?;
    Ok(read_root(&state).to_string_lossy().to_string())
}

#[tauri::command]
pub fn data_reveal(state: tauri::State<'_, StoreState>) -> Result<(), String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "数据状态异常（前一次访问发生 panic）".to_string())?;
    let root = read_root(&state);
    fs::create_dir_all(&root).map_err(|e| format!("无法创建数据目录：{e}"))?;
    reveal_path(&root);
    Ok(())
}

/// 弹系统目录选择框，只负责选，不动任何数据；搬不搬由前端问完再定。
#[tauri::command]
pub fn data_pick_root(app: tauri::AppHandle) -> Option<String> {
    /* 系统对话框会阻塞，别在锁里等它，不然其它命令陪着一块儿卡 */
    app.dialog()
        .file()
        .set_title("选择数据文件夹")
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

/// 默认数据目录：「恢复默认位置」拿它当目标。
#[tauri::command]
pub fn data_default_root(state: tauri::State<'_, StoreState>) -> String {
    state.default_root.to_string_lossy().to_string()
}

/// 数一数某个根目录下有多少条数据，弹层要说清现状才敢让人选。
#[tauri::command]
pub fn data_stats(root: String) -> DataCounts {
    count_data(Path::new(&root))
}

/// 换目录时用户对旧文件夹的三种处置，前端传 "copy" / "move" / "fresh"。
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootMode {
    /// 新目录放一份，旧目录原样留着，两份从此各不相干
    Copy,
    /// 新目录放一份，旧目录里的数据文件送进回收站
    Move,
    /// 什么都不带，只把指针挪过去
    Fresh,
}

/// 换数据目录。`mode` 决定旧文件夹怎么处置：拷贝留两份、剪贴清旧的、新建谁也不动。
/// 前两种目标里必须没有无限空间的数据，免得两份混在一起。
///
/// 东西多的时候这一步要跑很久，所以校验全在命令里当场做完（能立刻拒绝的绝不拖到
/// 弹层后面），真正的搬运丢给后台线程，进度走 `data-root-move` 事件。
/// 后台线程要占着 `lock` 一整天，期间「停止」这种只改标志的命令不能去碰那把锁。
#[tauri::command]
pub fn data_set_root(
    root: String,
    mode: RootMode,
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreState>,
    jobs: tauri::State<'_, Arc<RootMoveJobs>>,
) -> Result<RootSwitch, String> {
    let target = PathBuf::from(&root);
    if !target.exists() {
        fs::create_dir_all(&target).map_err(|e| format!("无法创建数据目录：{e}"))?;
    }
    if !target.is_dir() {
        return Err("选中的不是文件夹".to_string());
    }
    let current = read_root(&state);
    check_nesting(&current, &target, &state.default_root)?;
    migrate_space_dir_name(&target)?;
    let path = target.to_string_lossy().to_string();
    if same_dir(&current, &target) {
        return Ok(RootSwitch {
            job: String::new(),
            path,
        });
    }
    if matches!(mode, RootMode::Fresh) {
        // 什么都不带，只是把指针挪过去，一步就完，用不着进度
        ensure_dirs(&target)?;
        let db = app.state::<DbState>();
        write_root(&db, &state, &target)?;
        return Ok(RootSwitch {
            job: String::new(),
            path,
        });
    }
    if count_data(&target).total() > 0 {
        return Err("目标文件夹里已经有无限空间的数据，请换一个空文件夹".to_string());
    }

    /* 剪贴要过两遍手（复制 + 清旧文件），账按两步算，进度条才不会中途爆表 */
    let keep_source = matches!(mode, RootMode::Copy);
    let total = count_files(&current) * if keep_source { 1 } else { 2 };
    let job = format!("root-{}", now_ms());
    let flag = jobs.register(&job);
    let runner = Arc::clone(&*jobs);
    let thread_job = job.clone();
    std::thread::spawn(move || {
        run_move(&app, &current, &target, keep_source, total, &thread_job, &flag);
        runner.finish(&thread_job);
    });
    Ok(RootSwitch { job, path })
}

/// 停下来。只改标志，不碰数据锁，所以搬运正忙的时候这条命令也收得进来。
/// 返回 false 表示任务已经不在了（早跑完了）。
#[tauri::command]
pub fn data_root_cancel(job: String, jobs: tauri::State<'_, Arc<RootMoveJobs>>) -> bool {
    jobs.cancel(&job)
}

/// 换目录的结果：`job` 为空表示已经就位，不用等进度；非空是搬运任务号。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootSwitch {
    pub job: String,
    pub path: String,
}

/// 一次搬运：任务号 → 停止标志。和空间拷贝视频那套一个路子。
#[derive(Default)]
pub struct RootMoveJobs {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl RootMoveJobs {
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
        let Ok(map) = self.flags.lock() else { return false };
        match map.get(job) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

/// `data-root-move` 事件的载荷。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveProgress {
    job: String,
    /// progress | done | cancelled | error
    phase: String,
    /// copy = 往新文件夹放，recycle = 把旧文件送回收站
    stage: String,
    /// 文件个数：已处理 / 总数
    done: u64,
    total: u64,
    /// 当前这个文件的字节进度；小文件用不上就是 0/0
    bytes_done: u64,
    bytes_total: u64,
    /// 相对数据根的路径，界面念得出在弄哪一个
    label: String,
    error: String,
}

/// 一个根目录下有多少用户内容，弹层用它讲清「搬的是多少东西」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCounts {
    /// 笔记树里的 .md，含子文件夹
    pub notes: usize,
    /// 空间个数
    pub canvases: usize,
}

impl DataCounts {
    fn total(&self) -> usize {
        self.notes + self.canvases
    }
}

fn count_markdown(dir: &Path) -> usize {
    if !dir.is_dir() {
        return 0;
    }
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| {
                    let path = entry.path();
                    if path.is_dir() {
                        count_markdown(&path)
                    } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                        1
                    } else {
                        0
                    }
                })
                .sum()
        })
        .unwrap_or(0)
}

/// 空间 = 一个装着空间元数据文件的子文件夹（文件名和 canvas.rs 的 META_FILE 一致）。
/// 旧版叫 canvas.json，统计时两种都认，换目录前才看得见旧文件夹里还有没有东西。
fn count_canvases(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    let path = entry.path();
                    path.is_dir()
                        && (path.join(crate::canvas::META_FILE).is_file()
                            || path.join(crate::canvas::LEGACY_META_FILE).is_file())
                })
                .count()
        })
        .unwrap_or(0)
}

fn count_data(root: &Path) -> DataCounts {
    DataCounts {
        notes: count_markdown(&root.join(NOTE_DIR)),
        canvases: count_canvases(&root.join(SPACE_DIR))
            + count_canvases(&root.join(LEGACY_CANVAS_DIR)),
    }
}

/// 新旧目录套在一起等于让自己搬到自己家里，切之前先拦掉。
/// 目标目录不能和当前根互相套娃，也不能落进默认根那些类别目录里。
///
/// 后者是真会踩的坑：把根指到 `<默认根>/notes`，`ensure_dirs` 就在笔记树里
/// 长出 `notes/ spaces/` 两个壳，用户的数据被埋进别人的目录，
/// 指针再指回来都看不见。默认根本身例外——「恢复默认位置」要用的。
/// `stickies/`、`todos/` 虽然已经下线，旧目录可能还在原地，一并拦掉；
/// 旧版的 `canvases/` 也一样。
fn check_nesting(from: &Path, to: &Path, default_root: &Path) -> Result<(), String> {
    let nested = |child: &Path, parent: &Path| match (fs::canonicalize(child), fs::canonicalize(parent)) {
        (Ok(child), Ok(parent)) => child != parent && child.starts_with(parent),
        _ => false,
    };
    if nested(to, from) || nested(from, to) {
        return Err("不能选择当前数据文件夹的子文件夹或上级文件夹".to_string());
    }
    for sub in [STICKY_DIR, TODO_DIR, NOTE_DIR, SPACE_DIR, LEGACY_CANVAS_DIR] {
        let dir = default_root.join(sub);
        if same_dir(to, &dir) || nested(to, &dir) {
            return Err(format!(
                "不能选数据文件夹里的 {} 这一类目录，那里装的是数据本身，请在它外面选一个空文件夹",
                dir.display()
            ));
        }
    }
    Ok(())
}

/// 搬运中断：用户按了停止，或者真出错。善后一样——新目录里已复制的清掉，旧的不动。
#[derive(Debug)]
struct Halted {
    cancelled: bool,
    message: String,
}

impl Halted {
    fn cancelled() -> Self {
        Self { cancelled: true, message: "已停止，已复制的都清掉了，旧文件夹没动".to_string() }
    }
}

impl From<String> for Halted {
    fn from(message: String) -> Self {
        Self { cancelled: false, message }
    }
}

/// 进度往哪儿去。命令里是事件，测试里是内存里攒下来的一条条记录——
/// 不然这些函数没法在没有 AppHandle 的地方验证进度算得对不对。
trait Report {
    fn send(&self, payload: &MoveProgress);
}

struct EventReport {
    app: tauri::AppHandle,
}

impl Report for EventReport {
    fn send(&self, payload: &MoveProgress) {
        if let Err(e) = self.app.emit("data-root-move", payload.clone()) {
            eprintln!("[换目录] 进度事件发送失败：{e}");
        }
    }
}

/// 报进度顺带管节流：几千个小文件一个一个报会把事件通道灌满，
/// 最快 60ms 一条，最后一条（阶段结束）强制发。
struct Progress<'a> {
    sink: &'a dyn Report,
    job: &'a str,
    total: u64,
    done: AtomicU64,
    stop: Arc<AtomicBool>,
    since: Instant,
    last_ms: AtomicU64,
}

impl<'a> Progress<'a> {
    fn new(sink: &'a dyn Report, job: &'a str, total: u64, stop: Arc<AtomicBool>) -> Self {
        Self {
            sink,
            job,
            total,
            done: AtomicU64::new(0),
            stop,
            since: Instant::now(),
            // u64::MAX = 一条都还没发过，让第一条无论如何都能挤出去，界面不会卡在 0%
            last_ms: AtomicU64::new(u64::MAX),
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// 一个文件弄完了（或一批瞬间完成的活儿）
    fn file(&self, stage: &str, label: &str) -> u64 {
        let done = self.done.fetch_add(1, Ordering::Relaxed) + 1;
        self.emit(stage, done, 0, 0, label, done == self.total);
        done
    }

    /// 整棵目录改名这种一步到位的活儿：一次记 n 个
    fn skip(&self, stage: &str, count: u64, label: &str) {
        let done = self.done.fetch_add(count, Ordering::Relaxed) + count;
        self.emit(stage, done, 0, 0, label, true);
    }

    /// 大文件中途按字节报，界面那条格子才不会在几 GB 上看着像卡死
    fn bytes(&self, stage: &str, label: &str, bytes_done: u64, bytes_total: u64) {
        self.emit(stage, self.done.load(Ordering::Relaxed), bytes_done, bytes_total, label, false);
    }

    fn emit(&self, stage: &str, done: u64, bytes_done: u64, bytes_total: u64, label: &str, force: bool) {
        let now = self.since.elapsed().as_millis() as u64;
        let last = self.last_ms.load(Ordering::Relaxed);
        if !force && last != u64::MAX && now.saturating_sub(last) < 60 {
            return;
        }
        self.last_ms.store(now, Ordering::Relaxed);
        self.sink.send(&MoveProgress {
            job: self.job.to_string(),
            phase: "progress".to_string(),
            stage: stage.to_string(),
            done,
            total: self.total,
            bytes_done,
            bytes_total,
            label: label.to_string(),
            error: String::new(),
        });
    }

    fn settle(&self, phase: &str, error: &str) {
        self.sink.send(&MoveProgress {
            job: self.job.to_string(),
            phase: phase.to_string(),
            stage: String::new(),
            done: if phase == "done" { self.total } else { self.done.load(Ordering::Relaxed) },
            total: self.total,
            bytes_done: 0,
            bytes_total: 0,
            label: String::new(),
            error: error.to_string(),
        });
    }
}

/// 相对数据根的路径，报给用户看在弄哪一个文件
fn label_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 一共要过手多少个文件：笔记和空间各是一棵树，整棵数进去。
fn count_files(root: &Path) -> u64 {
    [NOTE_DIR, SPACE_DIR]
        .iter()
        .map(|sub| walk_files(&root.join(sub)))
        .sum()
}

fn walk_files(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut n = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            n += walk_files(&path);
        } else if path.is_file() {
            n += 1;
        }
    }
    n
}

/// 超过这个头的文件才按字节报进度，小文件直接整份拷
const BIG_FILE: u64 = 8 << 20;
const CHUNK: usize = 1 << 20;

/// 拷一个文件。大文件分块，中途报字节进度；按停止就把这个半成品删掉并往上抛中断。
fn copy_file(src: &Path, dst: &Path, label: &str, prog: &Progress) -> Result<(), Halted> {
    if prog.stopped() {
        return Err(Halted::cancelled());
    }
    let size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    if size < BIG_FILE {
        fs::copy(src, dst).map_err(|e| format!("复制数据失败：{e}"))?;
        return Ok(());
    }
    let mut input = fs::File::open(src).map_err(|e| format!("读旧文件失败：{e}"))?;
    let mut output = match fs::File::create(dst) {
        Ok(file) => file,
        Err(e) => return Err(format!("写新文件失败：{e}").into()),
    };
    let mut buf = vec![0u8; CHUNK];
    let mut sent = 0u64;
    loop {
        if prog.stopped() {
            drop(output);
            let _ = fs::remove_file(dst);
            return Err(Halted::cancelled());
        }
        let read = input
            .read(&mut buf)
            .map_err(|e| format!("读旧文件失败：{e}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buf[..read])
            .map_err(|e| format!("写新文件失败：{e}"))?;
        sent += read as u64;
        prog.bytes("copy", label, sent, size);
    }
    output.flush().map_err(|e| format!("写新文件失败：{e}"))?;
    Ok(())
}

fn is_empty_dir(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

/// 已下线的便签墙、待办栏留下的目录：整只送系统回收站，本来不存在就什么都不做。
/// 里面装的是 `<id>.json` 那种老格式，留着也没人再读它。
fn recycle_legacy_dirs(root: &Path) {
    for sub in [STICKY_DIR, TODO_DIR] {
        let dir = root.join(sub);
        if dir.exists() {
            let _ = crate::canvas::recycle_path(&dir);
        }
    }
}

fn copy_tree(from: &Path, to: &Path, root: &Path, prog: &Progress) -> Result<(), Halted> {
    fs::create_dir_all(to).map_err(|e| format!("创建目录失败：{e}"))?;
    for entry in fs::read_dir(from).map_err(|e| format!("读取目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取目录失败：{e}"))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_tree(&src, &dst, root, prog)?;
        } else if src.is_file() {
            copy_file(&src, &dst, &label_of(root, &src), prog)?;
            prog.file("copy", &label_of(root, &src));
        }
    }
    Ok(())
}

/// 笔记/空间：整棵目录一起走。剪贴时同盘改名一步到位，跨盘退化成复制再清旧目录；
/// 拷贝就只复制，旧树一个字节都不碰。
fn transfer_tree(
    root: &Path,
    from: &Path,
    to: &Path,
    keep_source: bool,
    prog: &Progress,
) -> Result<(), Halted> {
    if !from.is_dir() {
        return Ok(());
    }
    let name = from.file_name().unwrap_or_default().to_string_lossy().to_string();
    if to.exists() && !to.is_dir() {
        return Err(format!("新文件夹里的 {name} 位置被一个文件占了").into());
    }
    let count = walk_files(from);
    if keep_source {
        if let Err(halt) = copy_tree(from, to, root, prog) {
            // 目标本来就该是空的，整棵撤掉不会碰到用户别的东西
            let _ = fs::remove_dir_all(to);
            return Err(halt);
        }
        return Ok(());
    }
    // ensure_dirs 先建了空壳目录，改名会被它挡住，拿掉再搬
    if to.is_dir() && is_empty_dir(to) {
        let _ = fs::remove_dir(to);
    }
    if fs::rename(from, to).is_ok() {
        /* 同盘改名一步到位：这一步同时顶掉了「复制 + 清旧文件」两步的账，
           不然按两份算的总数会永远走不满 */
        prog.skip("copy", count * 2, &name);
        return Ok(());
    }
    if let Err(halt) = copy_tree(from, to, root, prog) {
        let _ = fs::remove_dir_all(to);
        return Err(halt);
    }
    /* 复制完的旧目录同样进回收站而不是直接删：这一步是唯一可能留下
       「两份数据」的地方，出错时得能反悔 */
    let _ = crate::canvas::recycle_path(from);
    prog.skip("recycle", count, &name);
    Ok(())
}

/// 把笔记树和空间弄到新目录，全程报进度；`from` 是旧根，报路径拿它当基准。
/// 旧版便签/待办那两个目录不跟着搬：剪贴时顺手收进回收站，拷贝一律不碰旧文件夹。
fn transfer_data(from: &Path, to: &Path, keep_source: bool, prog: &Progress) -> Result<(), Halted> {
    ensure_dirs(to)?;
    for sub in [NOTE_DIR, SPACE_DIR] {
        transfer_tree(from, &from.join(sub), &to.join(sub), keep_source, prog)?;
    }
    if !keep_source {
        recycle_legacy_dirs(from);
    }
    Ok(())
}

/// 后台线程的正身：占着数据锁搬，搬完才把根指针落库。
/// 中途停下（出错或用户按停止）就一个字节都不改指针，旧目录保持原样。
fn run_move(
    app: &tauri::AppHandle,
    from: &Path,
    to: &Path,
    keep_source: bool,
    total: u64,
    job: &str,
    flag: &Arc<AtomicBool>,
) {
    let state = app.state::<StoreState>();
    let Ok(_guard) = state.lock.lock() else {
        report_error(app, job, total, "数据状态异常（前一次访问发生 panic）");
        return;
    };
    // 排队期间用户可能又换了一次，动手前按当前根再核一遍
    if !same_dir(&read_root(&state), from) {
        report_error(app, job, total, "数据目录已经变过了，这次没有动");
        return;
    }
    let sink = EventReport { app: app.clone() };
    let prog = Progress::new(&sink, job, total, Arc::clone(flag));
    match transfer_data(from, to, keep_source, &prog) {
        Ok(()) => {
            let db = app.state::<DbState>();
            if let Err(e) = write_root(&db, &state, to) {
                prog.settle("error", &e);
                return;
            }
            prog.settle("done", "");
        }
        Err(halt) => prog.settle(if halt.cancelled { "cancelled" } else { "error" }, &halt.message),
    }
}

fn report_error(app: &tauri::AppHandle, job: &str, total: u64, message: &str) {
    if let Err(e) = app.emit(
        "data-root-move",
        MoveProgress {
            job: job.to_string(),
            phase: "error".to_string(),
            stage: String::new(),
            done: 0,
            total,
            bytes_done: 0,
            bytes_total: 0,
            label: String::new(),
            error: message.to_string(),
        },
    ) {
        eprintln!("[换目录] 进度事件发送失败：{e}");
    }
}

fn reveal_path(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let text = path.to_string_lossy().to_string();
        let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
        let _ = std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{text}\""))
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
}

// ---------- 启动时的收尾 ----------

/// 旧版把空间放在 `canvases/` 下：整棵改名成 `spaces/`。两边都有时逐个搬缺的
/// 文件夹，遇到同名就停下报错——宁可开不了也不能把两份数据混在一起。
fn migrate_space_dir_name(root: &Path) -> Result<(), String> {
    let old = root.join(LEGACY_CANVAS_DIR);
    if !old.is_dir() {
        return Ok(());
    }
    let new = root.join(SPACE_DIR);
    if !new.exists() {
        return fs::rename(&old, &new).map_err(|e| {
            format!(
                "无法把旧的空间目录 {} 改名为 {}：{e}",
                old.display(),
                new.display()
            )
        });
    }
    if !new.is_dir() {
        return Err(format!("{} 被一个文件占了，没法安放空间数据", new.display()));
    }
    for entry in fs::read_dir(&old).map_err(|e| format!("读取旧空间目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取旧空间目录失败：{e}"))?;
        let dst = new.join(entry.file_name());
        if dst.exists() {
            return Err(format!(
                "新旧空间目录里都有「{}」，请先手动合并再打开",
                entry.file_name().to_string_lossy()
            ));
        }
        fs::rename(entry.path(), &dst).map_err(|e| format!("搬动旧空间目录失败：{e}"))?;
    }
    let _ = fs::remove_dir(&old);
    Ok(())
}

/// 启动时做三件事：把 SQLite 里记的根目录同步进 DataRoot 镜像（空间、笔记、
/// 便签块读的都是这一个路径）；把旧版 `canvases/` 改名成 `spaces/`；
/// 再把旧版便签墙、待办栏留下的 `stickies/`、`todos/` 送进系统回收站。
///
/// 清目录不设标记、每次启动都试一遍：目录本来就不存在时什么都不做，用户手动删掉
/// 或换过一个带旧数据的文件夹，下次启动照样收干净；进回收站的东西随时能捞回来。
pub fn migrate(db: &DbState, state: &StoreState) -> Result<(), String> {
    let root = {
        let conn = conn(db)?;
        db::read_setting(&conn, ROOT_KEY)
            .map(PathBuf::from)
            .unwrap_or_else(|| state.default_root.clone())
    };
    state.root.set(&root);
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "数据状态异常（前一次访问发生 panic）".to_string())?;
    migrate_space_dir_name(&root)?;
    recycle_legacy_dirs(&root);
    ensure_dirs(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个用例一个临时目录，名字带 zz- 好认，跑完就删，绝不碰真实数据。
    fn sandbox(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zz-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录失败");
        dir
    }

    /// 攒进度的假上报口：命令里换成事件。`stop_after` 用来演"跑到第几个文件时按了停止"。
    #[derive(Default)]
    struct Collect {
        items: Mutex<Vec<(String, u64)>>,
        stop: Arc<AtomicBool>,
        stop_after: u64,
    }

    impl Report for Collect {
        fn send(&self, payload: &MoveProgress) {
            let mut items = self.items.lock().unwrap();
            items.push((payload.stage.clone(), payload.done));
            if self.stop_after > 0 && items.len() as u64 >= self.stop_after {
                self.stop.store(true, Ordering::Relaxed);
            }
        }
    }

    /// 笔记两篇（其中一篇在子文件夹里）+ 两个空间，全是要跟着搬的真东西
    fn seed_root(root: &Path) {
        fs::create_dir_all(root.join(NOTE_DIR).join("子目录")).unwrap();
        fs::create_dir_all(root.join(SPACE_DIR).join("一").join("images")).unwrap();
        fs::create_dir_all(root.join(SPACE_DIR).join("二")).unwrap();
        fs::write(root.join(NOTE_DIR).join("a.md"), "# a").unwrap();
        fs::write(root.join(NOTE_DIR).join("子目录").join("b.md"), "# b").unwrap();
        fs::write(root.join(SPACE_DIR).join("一").join("space.json"), "{}").unwrap();
        fs::write(root.join(SPACE_DIR).join("一").join("images").join("x.png"), "png").unwrap();
        fs::write(root.join(SPACE_DIR).join("二").join("space.json"), "{}").unwrap();
    }

    #[test]
    fn copy_transfer_moves_both_trees_and_keeps_source() {
        let base = sandbox("copy");
        let from = base.join("from");
        let to = base.join("to");
        seed_root(&from);
        assert_eq!(count_files(&from), 5, "两篇笔记 + 两个空间的文件全数进去");

        let sink = Collect::default();
        let prog = Progress::new(&sink, "job", count_files(&from), Arc::new(AtomicBool::new(false)));
        transfer_data(&from, &to, true, &prog).unwrap();

        assert_eq!(count_data(&to).notes, 2, "笔记树整棵都要过去");
        assert_eq!(count_data(&to).canvases, 2, "空间按装着 space.json 的子目录数");
        assert!(
            to.join(SPACE_DIR).join("一").join("images").join("x.png").is_file(),
            "空间文件夹里的副本目录不能漏"
        );
        assert_eq!(count_files(&from), 5, "拷贝不动旧目录");
        let items = sink.items.lock().unwrap();
        assert_eq!(items.last().unwrap().1, 5, "最后一条进度要数满");
        assert!(items.iter().all(|(stage, _)| stage == "copy"), "拷贝不该有清理阶段");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn cancel_midway_rolls_back_copies_and_leaves_source() {
        let base = sandbox("cancel");
        let from = base.join("from");
        let to = base.join("to");
        seed_root(&from);
        let stop = Arc::new(AtomicBool::new(false));
        /* 第一条上报到手就演一次「用户按了停止」：60ms 节流会把同一毫秒里的后续
           上报都压掉，所以这里只认第一条，够证明第二个文件动手前已经收手 */
        let sink = Collect { stop: Arc::clone(&stop), stop_after: 1, ..Default::default() };
        let prog = Progress::new(&sink, "job", count_files(&from), Arc::clone(&stop));
        ensure_dirs(&to).unwrap();

        let halt = transfer_data(&from, &to, true, &prog).unwrap_err();
        assert!(halt.cancelled, "停止不该被当成出错");
        assert_eq!(count_data(&to).notes, 0, "已经复制过去的那一篇要清掉");
        assert_eq!(count_files(&from), 5, "旧目录一个字节没动");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn legacy_canvas_dir_is_renamed_to_spaces() {
        let base = sandbox("rename");
        let root = base.join("data");
        fs::create_dir_all(root.join(LEGACY_CANVAS_DIR).join("一")).unwrap();
        fs::write(root.join(LEGACY_CANVAS_DIR).join("一").join("canvas.json"), "{}").unwrap();

        migrate_space_dir_name(&root).unwrap();

        assert!(!root.join(LEGACY_CANVAS_DIR).exists(), "旧目录要整棵搬走");
        assert!(
            root.join(SPACE_DIR).join("一").join("canvas.json").is_file(),
            "里面的数据原样跟过来"
        );
        assert_eq!(count_data(&root).canvases, 1, "旧元数据文件名也要认得");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn root_cannot_land_in_default_category_dirs() {
        let base = sandbox("nest");
        let default_root = base.join("data");
        for sub in [STICKY_DIR, TODO_DIR, NOTE_DIR, SPACE_DIR, LEGACY_CANVAS_DIR] {
            fs::create_dir_all(default_root.join(sub)).unwrap();
        }
        let outside = base.join("outside");
        fs::create_dir_all(outside.join("x")).unwrap();
        fs::create_dir_all(default_root.join(SPACE_DIR).join("deep")).unwrap();

        // 「恢复默认位置」走的就是这条，默认根本身不在禁选名单里
        assert!(check_nesting(&outside, &default_root, &default_root).is_ok());
        // 类别目录本身、以及它再往里一层，都不许当根
        assert!(check_nesting(&outside, &default_root.join(NOTE_DIR), &default_root).is_err());
        assert!(check_nesting(&outside, &default_root.join(SPACE_DIR).join("deep"), &default_root).is_err());
        assert!(check_nesting(&outside, &default_root.join(LEGACY_CANVAS_DIR), &default_root).is_err());
        // 原有的套娃检查照旧
        assert!(check_nesting(&outside, &outside.join("x"), &default_root).is_err());
        assert!(check_nesting(&outside.join("x"), &outside, &default_root).is_err());
        // 别处的空文件夹仍然是正路
        assert!(check_nesting(&outside, &base.join("elsewhere"), &default_root).is_ok());
        fs::remove_dir_all(&base).unwrap();
    }
}
