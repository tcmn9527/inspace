/* 文生视频 / 图生视频：本地跑不动视频扩散，整条路走远端 API。
   三家协议都长成「提交任务 → 轮询状态 → 下载 mp4」，只是字段和鉴权各异：

   - openai：POST {base}/videos（带首帧图时 multipart 的 input_reference）
             GET {base}/videos/{id}，GET {base}/videos/{id}/content
   - minimax：POST {base}/v1/video_generation（first_frame_image 吃 Data URL）
              GET {base}/v1/query/video_generation?task_id=，
              成功后再 GET {base}/v1/files/retrieve?file_id= 拿下载地址
   - dashscope：POST {base}/api/v1/services/aigc/video-generation/video-synthesis
                （X-DashScope-Async: enable；万相和百炼托管的可灵都走这套）
                GET {base}/api/v1/tasks/{task_id} 拿 video_url
                DashScope 的图生视频只收公网图片 URL，本地首帧暂时不支持。

   任务提交出去之后服务端停不掉：取消只是本地不再等，费用已经发生。 */

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::db::{self, DbState};
use crate::store::{DataRoot, GEN_DIR};
use crate::videolocal::{self, LocalEngine};

const CONFIG_KEY: &str = "gen_video_api_config";
const VIDEOS_SUB: &str = "videos";
const POLL_EVERY: Duration = Duration::from_secs(5);
const POLL_LIMIT: Duration = Duration::from_secs(30 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const BODY_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

/* ---------- 配置 ---------- */

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoApiConfig {
    /// openai / minimax / dashscope
    #[serde(default = "default_protocol")]
    pub protocol: String,
    /// 留空用该协议的默认地址
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// 同时最多跑几条。0 = 老配置没这项，按默认 2 算。
    #[serde(default)]
    pub parallel: u32,
}

fn default_protocol() -> String {
    "openai".to_string()
}

impl Default for VideoApiConfig {
    fn default() -> Self {
        VideoApiConfig {
            protocol: default_protocol(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            parallel: 2,
        }
    }
}

impl VideoApiConfig {
    /// 并行上限：0（老配置/没填）当 2，最多 10。
    fn parallel_limit(&self) -> usize {
        let value = if self.parallel == 0 { 2 } else { self.parallel };
        value.clamp(1, 10) as usize
    }
    fn base(&self) -> String {
        let text = self.base_url.trim().trim_end_matches('/');
        if !text.is_empty() {
            return text.to_string();
        }
        match self.protocol.as_str() {
            "minimax" => "https://api.minimax.cn".to_string(),
            "dashscope" => "https://dashscope.aliyuncs.com".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        }
    }

    fn problem(&self) -> Option<String> {
        if self.api_key.trim().is_empty() {
            return Some("API Key 还没填".to_string());
        }
        if self.model.trim().is_empty() {
            return Some("模型名还没选".to_string());
        }
        None
    }
}

pub fn load(db: &DbState) -> VideoApiConfig {
    let Ok(conn) = db.0.lock() else {
        return VideoApiConfig::default();
    };
    db::read_setting(&conn, CONFIG_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(db: &DbState, config: &VideoApiConfig) -> Result<(), String> {
    let conn = db
        .0
        .lock()
        .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
    let text = serde_json::to_string(config).map_err(|e| format!("视频 API 配置存不下来：{e}"))?;
    db::write_setting(&conn, CONFIG_KEY, &text)
}

/* ---------- 状态 ---------- */

/// 一条在跑的视频任务。API 通道可以同时有多条（上限由配置决定），本地引擎只有一条。
pub(crate) struct Job {
    pub(crate) block: String,
    pub(crate) status: String,
    pub(crate) task_id: String,
    pub(crate) started: Instant,
    /// API 任务自己的取消标志；本地任务直接用 core.cancel（和 sd.cpp 取消共用）
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) local: bool,
}

pub(crate) struct Core {
    pub(crate) data: DataRoot,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) jobs: Arc<Mutex<HashMap<String, Job>>>,
    pub(crate) config: Arc<Mutex<VideoApiConfig>>,
    pub(crate) engine: Arc<Mutex<String>>,
    pub(crate) local: LocalEngine,
}

impl Core {
    pub(crate) fn engine(&self) -> String {
        self.engine
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "api".to_string())
    }

    pub(crate) fn local_engine(&self) -> LocalEngine {
        self.local.clone()
    }
}

pub struct VideoState {
    core: Arc<Core>,
}

impl VideoState {
    pub fn config(&self) -> VideoApiConfig {
        self.core
            .config
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    fn set_config(&self, value: VideoApiConfig) {
        if let Ok(mut config) = self.core.config.lock() {
            *config = value;
        }
    }

    pub(crate) fn engine(&self) -> String {
        self.core.engine()
    }

    pub(crate) fn set_engine(&self, value: String) {
        if let Ok(mut engine) = self.core.engine.lock() {
            *engine = value;
        }
    }

    pub(crate) fn local_engine(&self) -> LocalEngine {
        self.core.local_engine()
    }

    pub(crate) fn is_busy(&self) -> bool {
        self.core
            .jobs
            .lock()
            .map(|jobs| !jobs.is_empty())
            .unwrap_or(true)
    }

    fn busy_json(&self) -> Value {
        let jobs: Vec<Value> = self
            .core
            .jobs
            .lock()
            .map(|jobs| {
                jobs.values()
                    .map(|job| {
                        json!({
                            "block": job.block,
                            "status": job.status,
                            "taskId": job.task_id,
                            "waitedSeconds": job.started.elapsed().as_secs(),
                            "local": job.local,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        /* job 留成第一条，老的调用方（含 agent）不用改 */
        let first = jobs.first().cloned();
        json!({ "busy": !jobs.is_empty(), "jobs": jobs, "job": first })
    }
}

pub fn init(data: DataRoot, db: &DbState) -> VideoState {
    let stored = db
        .0
        .lock()
        .ok()
        .and_then(|conn| db::read_setting(&conn, "gen_video_engine"))
        .filter(|value| value == "local" || value == "api");
    /* 没选过引擎：本地四件套齐就默认走本地，缺件时先落到云 API 的位置 */
    let engine = match stored.as_deref() {
        Some("local") => "local".to_string(),
        Some(_) => "api".to_string(),
        None if crate::videolocal::resolve(db, &data).problem().is_none() => "local".to_string(),
        None => "api".to_string(),
    };
    VideoState {
        core: Arc::new(Core {
            data,
            cancel: Arc::new(AtomicBool::new(false)),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            config: Arc::new(Mutex::new(load(db))),
            engine: Arc::new(Mutex::new(engine)),
            local: videolocal::init(db),
        }),
    }
}

/* ---------- 请求 ---------- */

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRequest {
    /// 结果按这个块 id 路由事件（面板或 MCP 都靠它认领这一张）
    pub block: String,
    pub prompt: String,
    /// 首帧图：PNG 的 base64（`data:` 前缀也吃）。给了就是图生视频。
    #[serde(default)]
    pub image: Option<String>,
    /// 秒数；不给按协议默认
    #[serde(default)]
    pub seconds: Option<i32>,
    /// 画幅比例，老请求的兜底（16:9 / 9:16 / 1:1）
    #[serde(default)]
    pub ratio: Option<String>,
    /// 画面像素宽高；给了就按它来，没给按 ratio 推默认档
    #[serde(default)]
    pub width: Option<i32>,
    #[serde(default)]
    pub height: Option<i32>,
    /// 面板上点名模型时覆盖设置
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VideoProgress {
    block: String,
    /// queued / running
    phase: String,
    label: String,
    waited: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VideoDone {
    block: String,
    /// 缓存文件的绝对路径（asset protocol 已放行），面板直接拿去播
    path: String,
    seconds: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VideoFail {
    block: String,
    error: String,
    canceled: bool,
}

/* ---------- 命令 ---------- */

#[tauri::command]
pub fn gen_video_api_get(app: tauri::AppHandle) -> VideoApiConfig {
    load(&app.state::<DbState>())
}

#[tauri::command]
pub fn gen_video_api_set(
    app: tauri::AppHandle,
    state: tauri::State<VideoState>,
    config: VideoApiConfig,
) -> Result<VideoApiConfig, String> {
    let mut next = config;
    next.protocol = match next.protocol.as_str() {
        "minimax" => "minimax".to_string(),
        "dashscope" => "dashscope".to_string(),
        _ => "openai".to_string(),
    };
    next.base_url = next.base_url.trim().trim_end_matches('/').to_string();
    next.api_key = next.api_key.trim().to_string();
    next.model = next.model.trim().to_string();
    if !next.base_url.is_empty()
        && !next.base_url.starts_with("http://")
        && !next.base_url.starts_with("https://")
    {
        return Err("接口地址要以 http:// 或 https:// 开头".to_string());
    }
    save(&app.state::<DbState>(), &next)?;
    state.set_config(next.clone());
    let _ = app.emit("inspace:gen-video-api", json!({ "protocol": next.protocol }));
    Ok(next)
}

/// 模型列表：OpenAI 兼容网关去 /models 拉；海螺和 DashScope 没有列表接口，
/// 给内置清单（随官方文档更新）。模型名不让手填。
#[tauri::command]
pub async fn gen_video_models(config: VideoApiConfig) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match config.protocol.as_str() {
        "minimax" => Ok(minimax_models()),
        "dashscope" => Ok(dashscope_models()),
        _ => fetch_openai_models(&config),
    })
    .await
    .map_err(|e| format!("读取模型列表的任务起不来：{e}"))?
}

fn minimax_models() -> Vec<String> {
    [
        "MiniMax-Hailuo-2.3",
        "MiniMax-Hailuo-2.3-Fast",
        "MiniMax-Hailuo-02",
        "T2V-01",
        "T2V-01-Director",
        "I2V-01",
        "I2V-01-Director",
        "I2V-01-live",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect()
}

fn dashscope_models() -> Vec<String> {
    [
        "wan2.5-t2v-preview",
        "wan2.2-t2v-plus",
        "wan2.2-i2v-plus",
        "wan2.2-i2v-flash",
        "wan2.1-t2v-turbo",
        "wan2.1-t2v-plus",
        "wan2.1-i2v-turbo",
        "wan2.1-i2v-plus",
        "kling/kling-v3-video-generation",
        "kling/kling-v3-turbo-video-generation",
        "kling/kling-v3-omni-video-generation",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect()
}

fn fetch_openai_models(config: &VideoApiConfig) -> Result<Vec<String>, String> {
    if config.base_url.trim().is_empty() && config.api_key.trim().is_empty() {
        return Err("先把 API Key 填上".to_string());
    }
    let url = format!("{}/models", config.base());
    let request = http_get(&url, config);
    let resp = request.call().map_err(|error| api_error("读取模型列表", error))?;
    let value = read_json(resp)?;
    let mut names: Vec<String> = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    row.get("id")
                        .and_then(Value::as_str)
                        .or_else(|| row.as_str())
                        .map(|name| name.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err("接口没有返回模型列表".to_string());
    }
    Ok(names)
}

#[tauri::command]
pub fn gen_video_status(state: tauri::State<VideoState>) -> Value {
    let mut value = state.busy_json();
    if let Value::Object(map) = &mut value {
        map.insert("engine".to_string(), Value::String(state.engine()));
    }
    value
}

#[tauri::command]
pub fn gen_video_cancel(state: tauri::State<VideoState>, block: Option<String>) -> bool {
    let core = Arc::clone(&state.core);
    let mut hit = false;
    let mut hit_local = false;
    if let Ok(mut jobs) = core.jobs.lock() {
        match block.as_deref() {
            Some(target) => {
                if let Some(job) = jobs.get(target) {
                    job.cancel.store(true, Ordering::Relaxed);
                    hit_local = job.local;
                    hit = true;
                }
            }
            None => {
                for job in jobs.values() {
                    job.cancel.store(true, Ordering::Relaxed);
                    hit_local |= job.local;
                }
                hit = !jobs.is_empty();
            }
        }
    }
    if hit_local {
        core.local_engine().cancel();
    }
    hit
}

#[tauri::command]
pub async fn gen_video_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, VideoState>,
    req: VideoRequest,
) -> Result<(), String> {
    let engine = state.engine();
    if req.prompt.trim().is_empty() {
        return Err("提示词是空的".to_string());
    }
    let config = if engine == "local" {
        let local = crate::videolocal::resolved_for_start(&app);
        state.local_engine().set_config(local.clone());
        if let Some(problem) = local.problem() {
            return Err(format!(
                "本地视频模型还没就绪：{problem}。把权重文件放进 {} 后会自动识别，缺什么在设置 → 视频生成里看清单",
                local.dir
            ));
        }
        None
    } else {
        let config = state.config();
        if let Some(problem) = config.problem() {
            return Err(format!("视频 API 配置不完整：{problem}（去设置 → 视频生成里配好）"));
        }
        Some(config)
    };
    if let Some(config) = &config {
        if config.protocol == "dashscope"
            && req.image.as_deref().is_some_and(|text| !text.trim().is_empty())
        {
            return Err("DashScope 协议的图生视频只收公网图片 URL，本地首帧暂不支持；换成 OpenAI 或海螺协议".to_string());
        }
    }
    /* 任务名额：本地只有一张卡，一次一条；API 按设置的并行上限放行 */
    let cancel = {
        let mut jobs = state
            .core
            .jobs
            .lock()
            .map_err(|_| "视频任务状态异常".to_string())?;
        if jobs.contains_key(&req.block) {
            return Err("这块正在出视频，等这一条跑完".to_string());
        }
        let (cancel, local) = if config.is_none() {
            if !jobs.is_empty() {
                return Err("正在出一个视频，等这一条跑完".to_string());
            }
            state.core.cancel.store(false, Ordering::Relaxed);
            (Arc::clone(&state.core.cancel), true)
        } else {
            let limit = config.as_ref().map(|c| c.parallel_limit()).unwrap_or(1);
            if jobs.len() >= limit {
                return Err(format!("视频 API 并行已满（{limit} 条），等一条跑完再点"));
            }
            (Arc::new(AtomicBool::new(false)), false)
        };
        jobs.insert(
            req.block.clone(),
            Job {
                block: req.block.clone(),
                status: "提交中…".to_string(),
                task_id: String::new(),
                started: Instant::now(),
                cancel: Arc::clone(&cancel),
                local,
            },
        );
        cancel
    };
    let core = Arc::clone(&state.core);
    thread::spawn(move || run_job(core, app, config, req, cancel));
    Ok(())
}

/* ---------- 任务线程 ---------- */

pub(crate) fn set_status(core: &Core, block: &str, status: &str) {
    if let Ok(mut jobs) = core.jobs.lock() {
        if let Some(job) = jobs.get_mut(block) {
            job.status = status.to_string();
        }
    }
}

fn set_task(core: &Core, block: &str, task_id: &str) {
    if let Ok(mut jobs) = core.jobs.lock() {
        if let Some(job) = jobs.get_mut(block) {
            job.task_id = task_id.to_string();
        }
    }
}

fn clear_job(core: &Core, block: &str) {
    if let Ok(mut jobs) = core.jobs.lock() {
        jobs.remove(block);
    }
}

pub(crate) fn emit_progress(app: &tauri::AppHandle, block: &str, phase: &str, label: &str, waited: u64) {
    let _ = app.emit(
        "video-progress",
        VideoProgress {
            block: block.to_string(),
            phase: phase.to_string(),
            label: label.to_string(),
            waited,
        },
    );
}

fn run_job(
    core: Arc<Core>,
    app: tauri::AppHandle,
    config: Option<VideoApiConfig>,
    req: VideoRequest,
    cancel: Arc<AtomicBool>,
) {
    let block = req.block.clone();
    let started = Instant::now();
    let outcome = match config {
        Some(config) => execute(&core, &app, &config, &req, &cancel),
        None => videolocal::execute(&core, &app, &req),
    };
    clear_job(&core, &block);
    let canceled = cancel.load(Ordering::Relaxed);
    match outcome {
        Ok(path) if !canceled => {
            let _ = app.emit(
                "video-done",
                VideoDone {
                    block,
                    path,
                    seconds: started.elapsed().as_secs_f32(),
                },
            );
        }
        Ok(_) => {
            let _ = app.emit(
                "video-failed",
                VideoFail {
                    block,
                    error: "已取消".to_string(),
                    canceled: true,
                },
            );
        }
        Err(error) => {
            eprintln!("[video] 生成失败：{error}");
            let _ = app.emit(
                "video-failed",
                VideoFail {
                    block,
                    error,
                    canceled,
                },
            );
        }
    }
}

fn execute(
    core: &Core,
    app: &tauri::AppHandle,
    config: &VideoApiConfig,
    req: &VideoRequest,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let block = &req.block;
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(config.model.trim())
        .to_string();
    let task_id = match config.protocol.as_str() {
        "minimax" => minimax_submit(config, req, &model)?,
        "dashscope" => dashscope_submit(config, req, &model)?,
        _ => openai_submit(config, req, &model)?,
    };
    set_task(core, block, &task_id);
    set_status(core, block, "排队中");
    emit_progress(app, block, "queued", "排队中", started_secs(core, block));

    let mut label = "排队中".to_string();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".to_string());
        }
        let poll_started = Instant::now();
        let waited = started_secs(core, block);
        if waited > POLL_LIMIT.as_secs() {
            return Err("等太久了（超过 30 分钟），去平台看一眼任务状态".to_string());
        }
        let result = match config.protocol.as_str() {
            "minimax" => minimax_poll(config, &task_id)?,
            "dashscope" => dashscope_poll(config, &task_id)?,
            _ => openai_poll(config, &task_id)?,
        };
        match result {
            Poll::Pending(next_label) => {
                if next_label != label {
                    label = next_label;
                    set_status(core, block, &label);
                    emit_progress(app, block, "running", &label, waited);
                }
            }
            Poll::Done(url) => {
                set_status(core, block, "下载中");
                emit_progress(app, block, "running", "下载中", waited);
                let dest = download(core, app, config, &url, block)?;
                return Ok(dest);
            }
        }
        /* 别把轮询打得太密：平台一般 1-5 分钟出片 */
        let elapsed = poll_started.elapsed();
        if elapsed < POLL_EVERY {
            thread::sleep(POLL_EVERY - elapsed);
        }
    }
}

pub(crate) fn started_secs(core: &Core, block: &str) -> u64 {
    core.jobs
        .lock()
        .ok()
        .and_then(|jobs| {
            jobs.get(block)
                .map(|job| job.started.elapsed().as_secs())
        })
        .unwrap_or(0)
}

enum Poll {
    Pending(String),
    Done(String),
}

/* ---------- OpenAI videos ---------- */

fn openai_submit(
    config: &VideoApiConfig,
    req: &VideoRequest,
    model: &str,
) -> Result<String, String> {
    let url = format!("{}/videos", config.base());
    let seconds = req.seconds.unwrap_or(8).clamp(1, 30).to_string();
    let (width, height) = video_size(req);
    let size = format!("{width}x{height}");
    let image = req
        .image
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(image_bytes)
        .transpose()?;
    let request = http_post(&url, config);
    let resp = match image {
        Some(bytes) => {
            let parts = vec![
                Part::text("model", model),
                Part::text("prompt", req.prompt.trim()),
                Part::text("seconds", &seconds),
                Part::text("size", &size),
                Part::file("input_reference", "reference.png", "image/png", bytes),
            ];
            let (content_type, body) = multipart(parts);
            request
                .set("Content-Type", &content_type)
                .send_bytes(&body)
                .map_err(|error| api_error("提交视频任务", error))?
        }
        None => {
            let body = json!({
                "model": model,
                "prompt": req.prompt.trim(),
                "seconds": seconds,
                "size": size,
            });
            let text = serde_json::to_string(&body).map_err(|e| format!("请求拼不起来：{e}"))?;
            request
                .set("Content-Type", "application/json")
                .send_bytes(text.as_bytes())
                .map_err(|error| api_error("提交视频任务", error))?
        }
    };
    let value = read_json(resp)?;
    value
        .get("id")
        .and_then(Value::as_str)
        .map(|id| id.to_string())
        .ok_or_else(|| format!("接口没有返回任务 id：{}", trim_text(&value.to_string(), 300)))
}

fn openai_poll(config: &VideoApiConfig, task_id: &str) -> Result<Poll, String> {
    let url = format!("{}/videos/{task_id}", config.base());
    let resp = http_get(&url, config)
        .call()
        .map_err(|error| api_error("查询视频任务", error))?;
    let value = read_json(resp)?;
    let status = value.get("status").and_then(Value::as_str).unwrap_or("");
    match status {
        "completed" | "succeeded" | "success" => Ok(Poll::Done(format!(
            "{}/videos/{task_id}/content",
            config.base()
        ))),
        "failed" | "error" | "canceled" => {
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .unwrap_or("远端任务失败");
            Err(message.to_string())
        }
        "queued" | "pending" => Ok(Poll::Pending("排队中".to_string())),
        _ => Ok(Poll::Pending("生成中".to_string())),
    }
}

/// /content 要带鉴权头，下载函数按协议补。
fn openai_download_headers(config: &VideoApiConfig) -> Vec<(String, String)> {
    vec![(
        "Authorization".to_string(),
        format!("Bearer {}", config.api_key.trim()),
    )]
}

/* ---------- MiniMax（海螺） ---------- */

fn minimax_submit(
    config: &VideoApiConfig,
    req: &VideoRequest,
    model: &str,
) -> Result<String, String> {
    let url = format!("{}/v1/video_generation", config.base());
    let duration = match req.seconds.unwrap_or(6) {
        value if value >= 9 => 10,
        _ => 6,
    };
    let (width, height) = video_size(req);
    let mut body = json!({
        "model": model,
        "prompt": req.prompt.trim(),
        "duration": duration,
        /* MiniMax 认的是短边档位：720P/768P/1080P，按用户填的宽高就近落档 */
        "resolution": minimax_resolution(width, height),
        /* 平台默认会改写提示词，我们不发就自己控制 */
        "prompt_optimizer": false,
    });
    if let Some(image) = req
        .image
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        body["first_frame_image"] = Value::String(to_data_url(image)?);
    }
    let text = serde_json::to_string(&body).map_err(|e| format!("请求拼不起来：{e}"))?;
    let resp = http_post(&url, config)
        .set("Content-Type", "application/json")
        .send_bytes(text.as_bytes())
        .map_err(|error| api_error("提交视频任务", error))?;
    let value = read_json(resp)?;
    let code = value
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if code != 0 {
        let message = value
            .pointer("/base_resp/status_msg")
            .and_then(Value::as_str)
            .unwrap_or("MiniMax 拒绝了这次提交");
        return Err(format!("{message}（{code}）"));
    }
    value
        .get("task_id")
        .and_then(Value::as_str)
        .map(|id| id.to_string())
        .ok_or_else(|| format!("接口没有返回 task_id：{}", trim_text(&value.to_string(), 300)))
}

fn minimax_poll(config: &VideoApiConfig, task_id: &str) -> Result<Poll, String> {
    let url = format!("{}/v1/query/video_generation?task_id={task_id}", config.base());
    let resp = http_get(&url, config)
        .call()
        .map_err(|error| api_error("查询视频任务", error))?;
    let value = read_json(resp)?;
    let status = value.get("status").and_then(Value::as_str).unwrap_or("");
    match status {
        "Success" | "success" => {
            let file_id = value
                .get("file_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "任务成功了但没有 file_id".to_string())?;
            let url = format!("{}/v1/files/retrieve?file_id={file_id}", config.base());
            let resp = http_get(&url, config)
                .call()
                .map_err(|error| api_error("取视频下载地址", error))?;
            let value = read_json(resp)?;
            let download = value
                .pointer("/file/download_url")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    format!("没拿到下载地址：{}", trim_text(&value.to_string(), 300))
                })?;
            Ok(Poll::Done(download.to_string()))
        }
        "Fail" | "Failed" | "failed" => {
            let message = value
                .get("base_resp")
                .and_then(|resp| resp.get("status_msg"))
                .and_then(Value::as_str)
                .unwrap_or("远端任务失败");
            Err(message.to_string())
        }
        "Queueing" | "Preparing" | "queueing" => Ok(Poll::Pending("排队中".to_string())),
        _ => Ok(Poll::Pending("生成中".to_string())),
    }
}

/* ---------- DashScope（万相 / 百炼可灵） ---------- */

fn dashscope_submit(
    config: &VideoApiConfig,
    req: &VideoRequest,
    model: &str,
) -> Result<String, String> {
    let url = format!(
        "{}/api/v1/services/aigc/video-generation/video-synthesis",
        config.base()
    );
    let duration = req.seconds.unwrap_or(5).clamp(3, 15);
    let (width, height) = video_size(req);
    let ratio = aspect_ratio_of(width, height);
    let long = width.max(height);
    let input = json!({ "prompt": req.prompt.trim() });
    /* 两家模型参数名不一样：万相认 resolution 档位，百炼托管的可灵认 mode。
       都靠模型名区分，同一个协议分支两套写法。 */
    let parameters = if model.to_ascii_lowercase().contains("kling") {
        json!({
            "mode": if long >= 1600 { "pro" } else { "std" },
            "aspect_ratio": ratio,
            "duration": duration,
        })
    } else {
        json!({
            "resolution": if long >= 1600 { "1080P" } else { "720P" },
            "aspect_ratio": ratio,
            "duration": duration,
        })
    };
    let body = json!({
        "model": model,
        "input": input,
        "parameters": parameters,
    });
    let text = serde_json::to_string(&body).map_err(|e| format!("请求拼不起来：{e}"))?;
    let resp = http_post(&url, config)
        .set("Content-Type", "application/json")
        .set("X-DashScope-Async", "enable")
        .send_bytes(text.as_bytes())
        .map_err(|error| api_error("提交视频任务", error))?;
    let value = read_json(resp)?;
    value
        .pointer("/output/task_id")
        .and_then(Value::as_str)
        .map(|id| id.to_string())
        .ok_or_else(|| {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("");
            if message.is_empty() {
                format!("接口没有返回 task_id：{}", trim_text(&value.to_string(), 300))
            } else {
                message.to_string()
            }
        })
}

fn dashscope_poll(config: &VideoApiConfig, task_id: &str) -> Result<Poll, String> {
    let url = format!("{}/api/v1/tasks/{task_id}", config.base());
    let resp = http_get(&url, config)
        .call()
        .map_err(|error| api_error("查询视频任务", error))?;
    let value = read_json(resp)?;
    let status = value
        .pointer("/output/task_status")
        .and_then(Value::as_str)
        .unwrap_or("");
    match status {
        "SUCCEEDED" => {
            let video = value
                .pointer("/output/video_url")
                .and_then(Value::as_str)
                .ok_or_else(|| "任务成功了但没有 video_url".to_string())?;
            Ok(Poll::Done(video.to_string()))
        }
        "FAILED" | "CANCELED" | "UNKNOWN" => {
            let message = value
                .pointer("/output/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .unwrap_or("远端任务失败");
            Err(message.to_string())
        }
        "PENDING" => Ok(Poll::Pending("排队中".to_string())),
        _ => Ok(Poll::Pending("生成中".to_string())),
    }
}

/* ---------- 尺寸换算 ---------- */

/// 面板给的是像素宽高，没给就按老请求的 ratio 推默认档。取偶：视频编码要求偶数边。
pub(crate) fn video_size(req: &VideoRequest) -> (i32, i32) {
    let (width, height) = match (req.width, req.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => (width, height),
        _ => match req.ratio.as_deref().unwrap_or("16:9") {
            "9:16" => (720, 1280),
            "1:1" => (1024, 1024),
            _ => (1280, 720),
        },
    };
    (
        (width.clamp(64, 4096) / 2) * 2,
        (height.clamp(64, 4096) / 2) * 2,
    )
}

/// MiniMax 只认短边档位：512P / 720P / 768P / 1080P。
fn minimax_resolution(width: i32, height: i32) -> &'static str {
    let short = width.min(height);
    if short >= 1000 {
        "1080P"
    } else if short >= 760 {
        "768P"
    } else if short >= 700 {
        "720P"
    } else {
        "512P"
    }
}

fn aspect_ratio_of(width: i32, height: i32) -> &'static str {
    let ratio = width as f32 / height as f32;
    if ratio > 1.2 {
        "16:9"
    } else if ratio < 0.83 {
        "9:16"
    } else {
        "1:1"
    }
}

/* ---------- 下载 ---------- */fn download(
    core: &Core,
    app: &tauri::AppHandle,
    config: &VideoApiConfig,
    url: &str,
    block: &str,
) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build();
    let mut request = agent.get(url);
    for (name, value) in match config.protocol.as_str() {
        "openai" => openai_download_headers(config),
        _ => Vec::new(),
    } {
        request = request.set(&name, &value);
    }
    let resp = request
        .call()
        .map_err(|error| api_error("下载视频", error))?;
    let dir = core.data.dir(GEN_DIR).join(VIDEOS_SUB);
    fs::create_dir_all(&dir).map_err(|e| format!("创建视频缓存目录失败：{e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("{stamp}.mp4"));
    let part = dest.with_extension("mp4.part");
    {
        let mut reader = resp.into_reader().take(BODY_LIMIT);
        let mut output =
            fs::File::create(&part).map_err(|e| format!("写视频缓存失败：{e}"))?;
        std::io::copy(&mut reader, &mut output).map_err(|e| format!("下载视频中断：{e}"))?;
        output.flush().ok();
    }
    fs::rename(&part, &dest).map_err(|e| format!("整理视频文件失败：{e}"))?;
    let _ = app.asset_protocol_scope().allow_file(&dest);
    let _ = block;
    Ok(dest.to_string_lossy().to_string())
}

/* ---------- HTTP 小工具 ---------- */

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
}

fn http_get(url: &str, config: &VideoApiConfig) -> ureq::Request {
    agent()
        .get(url)
        .set("Authorization", &format!("Bearer {}", config.api_key.trim()))
}

fn http_post(url: &str, config: &VideoApiConfig) -> ureq::Request {
    agent()
        .post(url)
        .set("Authorization", &format!("Bearer {}", config.api_key.trim()))
}

fn read_json(resp: ureq::Response) -> Result<Value, String> {
    let mut reader = resp.into_reader().take(BODY_LIMIT);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读接口返回失败：{e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str(&text)
        .map_err(|e| format!("接口返回的不是 JSON：{e}｜{}", trim_text(&text, 300)))
}

fn api_error(action: &str, error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, resp) => {
            let mut body = String::new();
            let _ = resp.into_reader().take(4096).read_to_string(&mut body);
            match code {
                401 | 403 => format!("{action}失败：鉴权被拒（HTTP {code}），检查 API Key"),
                _ => format!("{action}失败：HTTP {code} {}", trim_text(&body, 300)),
            }
        }
        other => format!("{action}失败：{other}"),
    }
}

fn trim_text(text: &str, limit: usize) -> String {
    let one_line = text.replace(['\r', '\n'], " ");
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= limit {
        trimmed.to_string()
    } else {
        let cut: String = trimmed.chars().take(limit).collect();
        format!("{cut}…")
    }
}

/* ---------- 图片 / multipart ---------- */

fn image_bytes(text: &str) -> Result<Vec<u8>, String> {
    let body = match text.find(',') {
        Some(at) if text.starts_with("data:") => &text[at + 1..],
        _ => text,
    };
    BASE64
        .decode(body.trim())
        .map_err(|e| format!("首帧图不是 base64：{e}"))
}

fn to_data_url(text: &str) -> Result<String, String> {
    if text.starts_with("data:") {
        return Ok(text.to_string());
    }
    image_bytes(text).map(|bytes| format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

struct Part {
    name: String,
    filename: Option<String>,
    content_type: Option<String>,
    data: Vec<u8>,
}

impl Part {
    fn text(name: &str, value: &str) -> Part {
        Part {
            name: name.to_string(),
            filename: None,
            content_type: None,
            data: value.as_bytes().to_vec(),
        }
    }

    fn file(name: &str, filename: &str, content_type: &str, data: Vec<u8>) -> Part {
        Part {
            name: name.to_string(),
            filename: Some(filename.to_string()),
            content_type: Some(content_type.to_string()),
            data,
        }
    }
}

fn multipart(parts: Vec<Part>) -> (String, Vec<u8>) {
    let boundary = format!(
        "inspace-video-{:x}-{:x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match (&part.filename, &part.content_type) {
            (Some(filename), Some(content_type)) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
                    part.name, filename, content_type
                )
                .as_bytes(),
            ),
            _ => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
                    part.name
                )
                .as_bytes(),
            ),
        }
        body.extend_from_slice(&part.data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(protocol: &str) -> VideoApiConfig {
        let base = if protocol == "openai" {
            "http://127.0.0.1:38999/v1"
        } else {
            "http://127.0.0.1:38999"
        };
        VideoApiConfig {
            protocol: protocol.to_string(),
            base_url: base.to_string(),
            api_key: "test".to_string(),
            model: "mock-video-1".to_string(),
        }
    }

    fn request() -> VideoRequest {
        VideoRequest {
            block: "test".to_string(),
            prompt: "一只猫在窗台上".to_string(),
            image: None,
            seconds: Some(6),
            ratio: Some("16:9".to_string()),
            width: Some(1920),
            height: Some(1080),
            model: None,
        }
    }

    fn ok_poll(poll: Poll) -> String {
        match poll {
            Poll::Done(url) => url,
            Poll::Pending(label) => panic!("mock 应该直接完成，实际是 {label}"),
        }
    }

    #[test]
    fn base_defaults() {
        assert_eq!(config("openai").base(), "http://127.0.0.1:38999/v1");
        let mut cfg = config("minimax");
        cfg.base_url.clear();
        assert_eq!(cfg.base(), "https://api.minimax.cn");
        let mut cfg = config("dashscope");
        cfg.base_url.clear();
        assert_eq!(cfg.base(), "https://dashscope.aliyuncs.com");
    }

    #[test]
    fn models_builtin() {
        assert!(minimax_models().contains(&"MiniMax-Hailuo-2.3".to_string()));
        assert!(dashscope_models()
            .iter()
            .any(|name| name.contains("kling")));
    }

    #[test]
    fn openai_submit_and_poll() {
        let cfg = config("openai");
        let id = openai_submit(&cfg, &request(), "mock-video-1").expect("submit");
        assert!(id.starts_with("video-"));
        assert!(ok_poll(openai_poll(&cfg, &id).expect("poll")).contains("/content"));
    }

    #[test]
    fn minimax_submit_and_poll() {
        let cfg = config("minimax");
        let id = minimax_submit(&cfg, &request(), "MiniMax-Hailuo-2.3").expect("submit");
        assert!(id.starts_with("task-"));
        assert!(ok_poll(minimax_poll(&cfg, &id).expect("poll")).contains("file-1.mp4"));
    }

    #[test]
    fn dashscope_submit_and_poll() {
        let cfg = config("dashscope");
        let id = dashscope_submit(&cfg, &request(), "wan2.2-t2v-plus").expect("submit");
        assert!(id.starts_with("dash-"));
        assert!(ok_poll(dashscope_poll(&cfg, &id).expect("poll")).contains("dash-mock-1.mp4"));
    }
}
