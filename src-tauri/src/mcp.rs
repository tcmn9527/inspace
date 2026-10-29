//! 应用内 MCP 服务：让别的 agent 通过 Streamable HTTP 操作这个空间。
//!
//! 这里只做协议和通道，不知道任何工具的业务含义：
//! 工具清单由前端启动时注册进来，tools/call 通过 Tauri 事件发给前端执行，
//! 前端拿着请求号再 invoke 回来，oneshot 唤醒后把结果原样交给 MCP 客户端。
//! 所有变更因此都发生在应用前端那套内存态上，和用户自己点菜单走的是同一条落盘路径。
//!
//! 只绑 127.0.0.1，Bearer token 首次生成后存在应用配置目录的 mcp.json 里，
//! 设置页负责展示连接配置和重置 token。

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

const DEFAULT_PORT: u16 = 31230;
const PORT_TRIES: u16 = 20;
/// 一次工具调用的等待上限：前端可能正在等文件拷贝、等 PDF 打开，
/// 但 MCP 客户端那边也有自己的超时，这里比常见的 60 秒多留一截。
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const EVENT_NAME: &str = "mcp-command";

#[derive(Serialize, Deserialize, Clone)]
struct FileConfig {
    token: String,
    port: u16,
}

pub struct McpState {
    app: AppHandle,
    config_path: PathBuf,
    token: Mutex<String>,
    port: Mutex<u16>,
    error: Mutex<Option<String>>,
    tools: Mutex<Vec<Value>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

#[derive(Clone)]
struct HttpState(Arc<McpState>);

/// 启动本地 MCP 服务。端口被占就往后顺延，最终端口写回 mcp.json；
/// 绑不上任何端口也不影响应用本身，错误留给设置页展示。
pub fn start(app: AppHandle, config_dir: PathBuf) -> Arc<McpState> {
    let config_path = config_dir.join("mcp.json");
    let config = read_config(&config_path);
    let state = Arc::new(McpState {
        app,
        config_path: config_path.clone(),
        token: Mutex::new(config.token),
        port: Mutex::new(0),
        error: Mutex::new(None),
        tools: Mutex::new(Vec::new()),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
    });

    let mut bound = None;
    for offset in 0..PORT_TRIES {
        let port = config.port.saturating_add(offset).max(DEFAULT_PORT);
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                bound = Some((listener, port));
                break;
            }
            Err(_) => continue,
        }
    }

    let Some((listener, port)) = bound else {
        *state.error.lock().unwrap() = Some(format!(
            "本地端口 {DEFAULT_PORT}-{} 都被占用，MCP 服务没有启动",
            DEFAULT_PORT + PORT_TRIES - 1
        ));
        return state;
    };
    if listener.set_nonblocking(true).is_err() {
        *state.error.lock().unwrap() = Some("本地 MCP 端口无法切换成非阻塞模式".into());
        return state;
    }
    *state.port.lock().unwrap() = port;

    let token = state.token.lock().unwrap().clone();
    let file = FileConfig { token, port };
    if let Err(error) = write_config(&config_path, &file) {
        eprintln!("[mcp] 写入连接配置失败：{error}");
    }

    let http_state = HttpState(state.clone());
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[mcp] 接管控件端口失败：{error}");
                return;
            }
        };
        let router = Router::new()
            .route("/mcp", post(handle_rpc).get(handle_get))
            .with_state(http_state);
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("[mcp] 服务退出：{error}");
        }
    });
    state
}

fn read_config(path: &PathBuf) -> FileConfig {
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(config) = serde_json::from_str::<FileConfig>(&raw) {
            if !config.token.is_empty() && config.port != 0 {
                return config;
            }
        }
    }
    FileConfig {
        token: random_token(),
        port: DEFAULT_PORT,
    }
}

fn write_config(path: &PathBuf, config: &FileConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败：{e}"))?;
    let mut file = std::fs::File::create(path).map_err(|e| format!("创建配置文件失败：{e}"))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("写入配置文件失败：{e}"))
}

/* 不引随机数库：时间、进程号、地址和一段 xorshift 混出 64 位十六进制，
   对「本机别的进程猜不到」这个要求已经够了 */
fn random_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut seed = nanos ^ ((std::process::id() as u64) << 32);
    seed ^= &seed as *const u64 as u64;
    let mut out = String::with_capacity(64);
    for _ in 0..8 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.push_str(&format!("{:08x}", seed as u32));
    }
    out
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(|value| value == format!("Bearer {token}"))
        .unwrap_or(false)
}

async fn handle_get() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [("allow", "POST")],
        "这个 MCP 服务只用 POST 收消息",
    )
        .into_response()
}

async fn handle_rpc(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(message): Json<Value>,
) -> Response {
    let state = state.0;
    let token = state.token.lock().unwrap().clone();
    if !authorized(&headers, &token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32001, "message": "MCP token 不对，去设置页重新复制连接配置" }
            })),
        )
            .into_response();
    }

    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let Some(id) = message.get("id").cloned() else {
        /* initialized、cancelled 这些通知没有 id，也不需要回什么 */
        return StatusCode::ACCEPTED.into_response();
    };

    match method {
        "initialize" => {
            let version = message
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            rpc_ok(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "inspace", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "这是「无限空间」桌面应用的本地 MCP，能操作空间、画布上的块、笔记库和播放器。先调 space_scene 或 notes_tree 熟悉现场再动手。工具默认会把界面切到对应页面并做演示：滚动镜头、给目标加一圈光带；传 pace: \"instant\" 可跳过演示。坐标是空间里的世界坐标，原点在空间左上角。"
                }),
            )
        }
        "ping" => rpc_ok(&id, json!({})),
        "tools/list" => {
            /* 应用刚起来时前端还没注册工具：等一小会儿再回，免得客户端把空表缓存下来 */
            wait_ready(&state).await;
            let tools = state.tools.lock().unwrap().clone();
            rpc_ok(&id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let payload = call_frontend(&state, &name, args).await;
            rpc_ok(&id, payload)
        }
        _ => rpc_error(&id, -32601, "这个 MCP 服务不提供该方法"),
    }
}

/* 前端启动时先挂监听、再注册工具；注册表非空就说明它已经能接命令。
   最多等五秒，前端一直没起来就照旧往下走，让客户端拿到错误而不是一直挂着。 */
async fn wait_ready(state: &Arc<McpState>) {
    for _ in 0..100 {
        if !state.tools.lock().unwrap().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn call_frontend(state: &Arc<McpState>, tool: &str, args: Value) -> Value {
    /* 工具表为空说明前端的总线还没接好，这时候 emit 出去没人接。等它一会儿。 */
    wait_ready(state).await;
    let request_id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    state.pending.lock().unwrap().insert(request_id, sender);

    let event = json!({ "requestId": request_id, "tool": tool, "args": args });
    if let Err(error) = state.app.emit(EVENT_NAME, event) {
        state.pending.lock().unwrap().remove(&request_id);
        return tool_error(&format!("把命令递给界面失败：{error}"));
    }

    match tokio::time::timeout(CALL_TIMEOUT, receiver).await {
        Ok(Ok(payload)) => normalize_payload(payload),
        Ok(Err(_)) => tool_error("界面没有接住这条命令（应用可能正在关闭）"),
        Err(_) => {
            state.pending.lock().unwrap().remove(&request_id);
            tool_error("界面处理这条命令超过了等待上限")
        }
    }
}

/* 前端回的是完整的 MCP result（content/isError），这里只做兜底，
   让它至少长成协议要求的形状 */
fn normalize_payload(payload: Value) -> Value {
    if payload.get("content").is_some() {
        return payload;
    }
    let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true
    })
}

fn rpc_ok(id: &Value, result: Value) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
    .into_response()
}

fn info_of(state: &McpState) -> Value {
    let port = *state.port.lock().unwrap();
    let token = state.token.lock().unwrap().clone();
    let error = state.error.lock().unwrap().clone();
    json!({
        "running": port != 0,
        "port": port,
        "url": if port != 0 { format!("http://127.0.0.1:{port}/mcp") } else { String::new() },
        "token": token,
        "error": error,
    })
}

#[tauri::command]
pub fn mcp_register_tools(state: tauri::State<'_, Arc<McpState>>, tools: Vec<Value>) -> Value {
    let clean: Vec<Value> = tools
        .into_iter()
        .filter(|tool| {
            tool.get("name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())
                && tool.get("inputSchema").is_some()
        })
        .collect();
    *state.tools.lock().unwrap() = clean;
    json!({ "count": state.tools.lock().unwrap().len() })
}

#[tauri::command]
pub fn mcp_reply(state: tauri::State<'_, Arc<McpState>>, request_id: u64, payload: Value) {
    if let Some(sender) = state.pending.lock().unwrap().remove(&request_id) {
        let _ = sender.send(payload);
    }
}

#[tauri::command]
pub fn mcp_info(state: tauri::State<'_, Arc<McpState>>) -> Value {
    info_of(&state)
}

#[tauri::command]
pub fn mcp_reset_token(state: tauri::State<'_, Arc<McpState>>) -> Result<Value, String> {
    let token = random_token();
    let port = *state.port.lock().unwrap();
    if port != 0 {
        write_config(&state.config_path, &FileConfig { token: token.clone(), port })?;
    }
    *state.token.lock().unwrap() = token;
    Ok(info_of(&state))
}
