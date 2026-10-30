/* 宇宙主题的星体贴图：内置 2K 打进包里保证离线能跑，想要 8K 由用户在设置页点一下才下载。
 *
 * 下载一律走这里而不是前端的 fetch：贴图站不给跨域头，webview 里 fetch 会被挡；
 * 前端只负责点按钮、看进度、读回来的字节。缓存落在数据目录的 cosmos/8k/，
 * 换数据文件夹时跟着搬（见 store.rs 里那份子目录清单）。
 *
 * 下载先写 .part 再改名：中途断网或取消不会留下半张贴图被当成好的用。 */

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use crate::store::{DataRoot, COSMOS_DIR};

const PACK_DIR: &str = "8k";
const BASE_URL: &str = "https://www.solarsystemscope.com/textures/download/";

/// 前端认的名字 → 站上的文件名。顺序即下载顺序：先地球，用户最先想看清它。
/// 环是 png（带 alpha），其余都是 jpg。
const PACK: [(&str, &str); 7] = [
    ("earth-day", "8k_earth_daymap.jpg"),
    ("earth-night", "8k_earth_nightmap.jpg"),
    ("moon", "8k_moon.jpg"),
    ("mars", "8k_mars.jpg"),
    ("jupiter", "8k_jupiter.jpg"),
    ("saturn", "8k_saturn.jpg"),
    ("saturn-ring", "8k_saturn_ring_alpha.png"),
];

/// 一次下载任务的可取消状态：全局只留一份，重复点升级不会开第二条线程。
#[derive(Default)]
pub struct CosmosJobs {
    running: AtomicBool,
    cancel: AtomicBool,
}

impl CosmosJobs {
    fn begin(&self) -> Result<(), String> {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("已经有一批在下载了".to_string());
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

fn pack_dir(data: &DataRoot) -> PathBuf {
    data.dir(COSMOS_DIR).join(PACK_DIR)
}

fn path_for(dir: &Path, name: &str) -> Option<PathBuf> {
    PACK.iter()
        .find(|(key, _)| *key == name)
        .map(|(_, file)| dir.join(file))
}

fn name_cn(name: &str) -> &'static str {
    match name {
        "earth-day" => "地球白天面",
        "earth-night" => "地球夜面",
        "moon" => "月球",
        "mars" => "火星",
        "jupiter" => "木星",
        "saturn" => "土星",
        "saturn-ring" => "土星环",
        _ => "星体",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexFile {
    pub name: String,
    pub present: bool,
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    pub dir: String,
    pub files: Vec<TexFile>,
    pub bytes: u64,
    /// 一张都没有 → 显示「内置 2K」；全齐 → 「已升级到 8K」；
    /// 下了一半（断网、取消）两种都不算，按钮文案要能把它接着下完。
    pub complete: bool,
    pub empty: bool,
    pub got: usize,
    pub total: usize,
    pub running: bool,
}

#[tauri::command]
pub fn cosmos_tex_status(
    data: tauri::State<'_, DataRoot>,
    jobs: tauri::State<'_, Arc<CosmosJobs>>,
) -> Result<PackStatus, String> {
    let dir = pack_dir(&data);
    let mut files = Vec::with_capacity(PACK.len());
    let mut bytes = 0u64;
    let mut got = 0usize;
    for (name, file) in PACK {
        let path = dir.join(file);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let present = is_image(&path);
        if present {
            got += 1;
            bytes += size;
        }
        files.push(TexFile {
            name: name.to_string(),
            present,
            bytes: size,
        });
    }
    Ok(PackStatus {
        dir: dir.to_string_lossy().to_string(),
        files,
        bytes,
        complete: got == PACK.len(),
        empty: got == 0,
        got,
        total: PACK.len(),
        running: jobs.running.load(Ordering::SeqCst),
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexProgress {
    pub job: String,
    pub name: String,
    /// 第几张 / 一共几张，从 1 数起，跳过的也算
    pub index: usize,
    pub total: usize,
    /// downloading 时是这张已拿到多少；收尾时是整批累计
    pub received: u64,
    pub expected: u64,
    pub bytes: u64,
    /// downloading / skip / saved / error / done / partial / canceled
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub fn cosmos_tex_upgrade(
    app: tauri::AppHandle,
    data: tauri::State<'_, DataRoot>,
    jobs: tauri::State<'_, Arc<CosmosJobs>>,
) -> Result<String, String> {
    jobs.begin()?;
    let dir = pack_dir(&data);
    if let Err(error) = fs::create_dir_all(&dir) {
        jobs.running.store(false, Ordering::SeqCst);
        return Err(format!("无法创建贴图目录：{error}"));
    }
    let id = format!("pack-{}", now_ms());
    let jobs = Arc::clone(jobs.inner());
    let _ = app.emit("cosmos-textures", TexProgress {
        job: id.clone(),
        name: String::new(),
        index: 0,
        total: PACK.len(),
        received: 0,
        expected: 0,
        bytes: 0,
        state: "started".into(),
        error: None,
    });
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let id = thread_id;
        let mut bytes = 0u64;
        let mut failed: Vec<String> = Vec::new();
        for (index, (name, file)) in PACK.iter().enumerate() {
            let path = dir.join(file);
            if is_image(&path) {
                let already = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                bytes += already;
                emit(&app, &id, name, index + 1, "skip", 0, 0, bytes, None);
                continue;
            }
            let outcome = fetch(
                &app,
                &id,
                &jobs,
                name,
                index + 1,
                &format!("{BASE_URL}{file}"),
                &path,
            );
            match outcome {
                Ok(received) => {
                    bytes += received;
                    emit(&app, &id, name, index + 1, "saved", received, 0, bytes, None);
                }
                Err(error) if error == "已取消" => break,
                Err(error) => {
                    failed.push(format!("{}：{error}", name_cn(name)));
                    emit(&app, &id, name, index + 1, "error", 0, 0, bytes, Some(error));
                }
            }
        }
        let canceled = jobs.canceled();
        jobs.running.store(false, Ordering::SeqCst);
        let state = if canceled {
            "canceled"
        } else if failed.is_empty() {
            "done"
        } else {
            "partial"
        };
        emit(
            &app,
            &id,
            "",
            PACK.len(),
            state,
            0,
            0,
            bytes,
            if failed.is_empty() {
                None
            } else {
                Some(failed.join("；"))
            },
        );
    });
    Ok(id)
}

fn emit(
    app: &tauri::AppHandle,
    job: &str,
    name: &str,
    index: usize,
    state: &str,
    received: u64,
    expected: u64,
    bytes: u64,
    error: Option<String>,
) {
    let _ = app.emit(
        "cosmos-textures",
        TexProgress {
            job: job.to_string(),
            name: name.to_string(),
            index,
            total: PACK.len(),
            received,
            expected,
            bytes,
            state: state.to_string(),
            error,
        },
    );
}

/// 连接 20 秒、单次读 90 秒不动就判死：几十 MB 的片子挂在那儿不如报个错让用户重点。
fn agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(20))
            .timeout_read(std::time::Duration::from_secs(90))
            .build()
    })
}

/// 拉一张：边下边报进度，落盘 → 核对大小和文件头 → 改名。
/// 任何一步不成都把 .part 删掉，返回拿到的字节数。
fn fetch(
    app: &tauri::AppHandle,
    job: &str,
    jobs: &CosmosJobs,
    name: &str,
    index: usize,
    url: &str,
    path: &Path,
) -> Result<u64, String> {
    let part = path.with_file_name(format!(
        "{}.part",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("tex")
    ));
    let response = agent()
        .get(url)
        .set("User-Agent", "inspace/0.1 (cosmos texture pack)")
        .call()
        .map_err(|e| format!("连不上：{e}"))?;
    if response.status() != 200 {
        return Err(format!("对方回了 {}", response.status()));
    }
    let expected = response
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut file = fs::File::create(&part).map_err(|e| format!("写不了：{e}"))?;
    let mut reader = response.into_reader();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut received = 0u64;
    let mut reported = 0u64;
    loop {
        if jobs.canceled() {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("已取消".to_string());
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("下到一半断了：{e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("写盘失败：{e}"))?;
        received += read as u64;
        /* 上百 MB 的文件别把事件通道刷爆：每 512KB 报一次 */
        if received - reported >= 512 * 1024 {
            reported = received;
            emit(
                app, job, name, index, "downloading", received, expected, received, None,
            );
        }
    }
    drop(file);
    if received == 0 || (expected > 0 && received != expected) {
        let _ = fs::remove_file(&part);
        return Err(format!("只拿到 {received} 字节，说好的是 {expected}"));
    }
    /* 站上报错也可能回 200 加一页 HTML，半截的文件也不算到位，所以两头都验 */
    if !is_image(&part) {
        let _ = fs::remove_file(&part);
        return Err("拿回来的图片不完整".to_string());
    }
    fs::rename(&part, path).map_err(|e| format!("存放失败：{e}"))?;
    Ok(received)
}

fn read_head(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读不回：{e}"))?;
    let mut head = vec![0u8; 12];
    file.read_exact(&mut head)
        .map_err(|e| format!("读不回：{e}"))?;
    Ok(head)
}

fn read_tail(path: &Path, len: u64) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读不回：{e}"))?;
    let size = file.metadata().map_err(|e| format!("读不回：{e}"))?.len();
    if size < len {
        return Err("太小".to_string());
    }
    file.seek(SeekFrom::End(-(len as i64)))
        .map_err(|e| format!("读不回：{e}"))?;
    let mut tail = vec![0u8; len as usize];
    file.read_exact(&mut tail)
        .map_err(|e| format!("读不回：{e}"))?;
    Ok(tail)
}

/// 一张贴图算不算到位要看两头：开头得是 JPEG/PNG 的签名，结尾得收完整。
/// 光看字节数会被半截文件骗——下载中断、或被上一版直接写目标文件的代码留在盘上的残骸。
fn is_image(path: &Path) -> bool {
    let head = match read_head(path) {
        Ok(head) => head,
        Err(_) => return false,
    };
    let tail = match read_tail(path, 8) {
        Ok(tail) => tail,
        Err(_) => return false,
    };
    if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        /* PNG 收在 IEND + 它固定的那四个 CRC 字节 */
        return tail.ends_with(&[b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
    }
    head.starts_with(&[0xFF, 0xD8, 0xFF]) && tail.windows(2).any(|w| w == [0xFF, 0xD9])
}

#[tauri::command]
pub fn cosmos_tex_cancel(jobs: tauri::State<'_, Arc<CosmosJobs>>) -> bool {
    let running = jobs.running.load(Ordering::SeqCst);
    if running {
        jobs.cancel.store(true, Ordering::SeqCst);
    }
    running
}

/// 清掉 8K 缓存，回到内置 2K：走系统回收站，不直接抹。
#[tauri::command]
pub fn cosmos_tex_reset(
    data: tauri::State<'_, DataRoot>,
    jobs: tauri::State<'_, Arc<CosmosJobs>>,
) -> Result<(), String> {
    if jobs.running.load(Ordering::SeqCst) {
        return Err("下载还没结束，先取消再清除".to_string());
    }
    let dir = pack_dir(&data);
    if dir.is_dir() {
        crate::canvas::recycle_path(&dir).map_err(|e| format!("清除失败：{e}"))?;
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建贴图目录：{e}"))?;
    Ok(())
}

/// 把缓存里的 8K 交回前端（base64）；没下过这张就报错，前端自己退回内置 2K。
#[tauri::command]
pub fn cosmos_tex_read(name: String, data: tauri::State<'_, DataRoot>) -> Result<String, String> {
    let path = path_for(&pack_dir(&data), &name).ok_or_else(|| "不认识这张贴图".to_string())?;
    if !is_image(&path) {
        return Err("这张 8K 贴图坏了".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("读不到 8K 贴图：{e}"))?;
    Ok(BASE64.encode(&bytes))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
