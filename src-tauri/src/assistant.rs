//! AI 助手：只做 API 配置、模型列表和模型请求归一化。
//!
//! 画布操作一件都不在这里做：模型返回的 tool_calls 由前端交给 agent-tools.js 的
//! runTool 执行，和外部 MCP agent 走同一条路径。这样助手和外部 agent 的能力天然一致。
//!
//! 支持四类协议：OpenAI-compatible、Anthropic Messages、Gemini generateContent、Ollama。
//! 各家请求/响应格式在这里翻成内部统一的 ChatMessage / ChatReply。

use crate::db::{self, DbState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

const CONFIG_KEY: &str = "assistant_api_config";

/* ---------- 配置 ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConfig {
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: i64,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default = "default_true")]
    pub confirm_tools: bool,
    /// 当前模型是否收图片。设置页会按模型名自动勾上，也能手动改。
    #[serde(default)]
    pub supports_images: bool,
}

fn default_protocol() -> String {
    "openai".to_string()
}
fn default_temperature() -> f64 {
    0.4
}
fn default_max_tokens() -> i64 {
    4096
}
fn default_true() -> bool {
    true
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            protocol: default_protocol(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            system_prompt: String::new(),
            confirm_tools: true,
            supports_images: false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    pub configured: bool,
    pub protocol: String,
    pub model: String,
    pub confirm_tools: bool,
    pub supports_images: bool,
}

fn load(db: &DbState) -> ApiConfig {
    let Ok(conn) = db.0.lock() else {
        return ApiConfig::default();
    };
    db::read_setting(&conn, CONFIG_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(db: &DbState, config: &ApiConfig) -> Result<(), String> {
    let conn = db
        .0
        .lock()
        .map_err(|_| "数据库连接状态异常".to_string())?;
    let text = serde_json::to_string(config).map_err(|e| format!("配置存不下来：{e}"))?;
    db::write_setting(&conn, CONFIG_KEY, &text)
}

#[tauri::command]
pub fn assistant_api_get(app: tauri::AppHandle) -> ApiConfig {
    load(&app.state::<DbState>())
}

#[tauri::command]
pub fn assistant_api_status(app: tauri::AppHandle) -> ApiStatus {
    let config = load(&app.state::<DbState>());
    ApiStatus {
        configured: !config.api_key.trim().is_empty() && !config.model.trim().is_empty(),
        protocol: config.protocol,
        model: config.model,
        confirm_tools: config.confirm_tools,
        supports_images: config.supports_images,
    }
}

#[tauri::command]
pub fn assistant_api_set(app: tauri::AppHandle, config: ApiConfig) -> Result<ApiConfig, String> {
    let mut next = config;
    let protocol = match next.protocol.trim().to_lowercase().as_str() {
        "anthropic" => "anthropic",
        "gemini" => "gemini",
        "ollama" => "ollama",
        "custom" | "openai_compatible" => "custom",
        _ => "openai",
    }
    .to_string();
    next.protocol = protocol;
    next.base_url = next.base_url.trim().trim_end_matches('/').to_string();
    next.api_key = next.api_key.trim().to_string();
    next.model = next.model.trim().to_string();
    next.system_prompt = next.system_prompt.trim().to_string();
    if !next.base_url.is_empty()
        && !next.base_url.starts_with("http://")
        && !next.base_url.starts_with("https://")
    {
        return Err("接口地址要以 http:// 或 https:// 开头".to_string());
    }
    next.temperature = next.temperature.clamp(0.0, 2.0);
    next.max_tokens = next.max_tokens.clamp(64, 200_000);
    save(&app.state::<DbState>(), &next)?;
    Ok(next)
}


/// 按模型名猜一个是否能吃图片。只用来给设置页预填勾选框，用户随时能改。
fn model_supports_images(model: &str) -> bool {
    let m = model.trim().to_lowercase();
    const VISION: &[&str] = &[
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-turbo",
        "o1",
        "o3",
        "o4",
        "claude-3",
        "claude-4",
        "gemini",
        "qwen-vl",
        "qwen2-vl",
        "qwen2.5-vl",
        "qwen3-vl",
        "glm-4v",
        "glm-4.5v",
        "doubao-vision",
        "llava",
        "internvl",
        "minicpm-v",
        "pixtral",
        "grok-2-vision",
    ];
    VISION.iter().any(|needle| m.contains(needle))
}

#[tauri::command]
pub fn assistant_model_vision(model: String) -> bool {
    model_supports_images(&model)
}

/* ---------- HTTP 与协议适配 ---------- */

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(180))
        .build()
}

fn response_json(response: ureq::Response) -> Result<Value, String> {
    response
        .into_json::<Value>()
        .map_err(|e| format!("接口返回的不是合法 JSON：{e}"))
}

fn send_json(method: &str, url: &str, config: &ApiConfig, body: Option<Value>) -> Result<Value, String> {
    let mut request = match method {
        "GET" => agent().get(url),
        _ => agent().post(url),
    };
    request = request.set("Content-Type", "application/json");
    match config.protocol.as_str() {
        "anthropic" => {
            if !config.api_key.is_empty() {
                request = request.set("x-api-key", &config.api_key);
            }
            request = request.set("anthropic-version", "2023-06-01");
        }
        "gemini" => {}
        "ollama" => {
            if !config.api_key.is_empty() {
                request = request.set("Authorization", &format!("Bearer {}", config.api_key));
            }
        }
        _ => {
            if !config.api_key.is_empty() {
                request = request.set("Authorization", &format!("Bearer {}", config.api_key));
            }
        }
    }
    let result = match body {
        Some(value) => request.send_json(value),
        None => request.call(),
    };
    match result {
        Ok(response) => response_json(response),
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(format!("接口返回 {code}：{}", truncate(&text, 800)))
        }
        Err(error) => Err(format!("请求失败：{error}")),
    }
}

fn truncate(text: &str, max: usize) -> String {
    let mut out = text.chars().take(max).collect::<String>();
    if text.chars().count() > max {
        out.push_str("…");
    }
    out
}

fn join_url(base: &str, suffix: &str) -> String {
    let base = base.trim_end_matches('/');
    if suffix.starts_with("http://") || suffix.starts_with("https://") {
        return suffix.to_string();
    }
    format!("{}/{}", base, suffix.trim_start_matches('/'))
}

fn openai_base(base: &str) -> String {
    let mut base = base.trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/models", "/v1/models"] {
        if base.ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
        }
    }
    if base.ends_with("/v1") {
        base
    } else {
        format!("{}/v1", base)
    }
}

fn anthropic_base(base: &str) -> String {
    let base = base.trim_end_matches('/').to_string();
    if base.ends_with("/v1") {
        base
    } else {
        format!("{}/v1", base)
    }
}

fn gemini_base(base: &str) -> String {
    let base = base.trim_end_matches('/').to_string();
    if base.ends_with("/v1beta") {
        base
    } else {
        format!("{}/v1beta", base)
    }
}

fn url_with_key(url: &str, key: &str) -> String {
    if key.is_empty() || url.contains('?') {
        return url.to_string();
    }
    format!("{url}?key={key}")
}

/* ---------- 消息结构 ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InToolCall {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImagePart>,
    #[serde(default)]
    pub tool_calls: Vec<InToolCall>,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    pub tool_calls: Vec<OutToolCall>,
    pub model: String,
    /// 用户按了停止：text 是已经吐出来的那部分，工具调用作废
    #[serde(default)]
    pub canceled: bool,
}

fn parse_arguments(value: &Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| json!({})),
        Value::Object(_) => value.clone(),
        _ => json!({}),
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    #[serde(default)]
    pub data_url: String,
    #[serde(default)]
    pub mime_type: String,
}

/// data:image/png;base64,xxxx → (mime, base64)。不是 data URL 就当 PNG base64。
fn split_image(image: &ImagePart) -> (String, String) {
    let raw = image.data_url.trim();
    if let Some(rest) = raw.strip_prefix("data:") {
        if let Some((meta, data)) = rest.split_once(',') {
            let mime = meta.split(';').next().unwrap_or("image/png").to_string();
            return (if mime.is_empty() { "image/png".to_string() } else { mime }, data.to_string());
        }
    }
    let mime = if image.mime_type.trim().is_empty() {
        "image/png".to_string()
    } else {
        image.mime_type.trim().to_string()
    };
    (mime, raw.to_string())
}

fn has_images(messages: &[ChatMessage]) -> bool {
    messages.iter().any(|message| !message.images.is_empty())
}

/* ---------- OpenAI / Ollama ---------- */

fn openai_messages(config: &ApiConfig, messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    if !config.system_prompt.is_empty() {
        out.push(json!({ "role": "system", "content": config.system_prompt }));
    }
    for message in messages {
        match message.role.as_str() {
            "tool" => out.push(json!({
                "role": "tool",
                "tool_call_id": message.tool_call_id,
                "content": message.content,
            })),
            "assistant" if !message.tool_calls.is_empty() => {
                let calls = message
                    .tool_calls
                    .iter()
                    .map(|call| json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string()),
                        }
                    }))
                    .collect::<Vec<_>>();
                out.push(json!({
                    "role": "assistant",
                    "content": if message.content.is_empty() { Value::Null } else { json!(message.content) },
                    "tool_calls": calls,
                }));
            }
            role if role == "user" && !message.images.is_empty() => {
                let mut parts = vec![json!({ "type": "text", "text": message.content })];
                for image in &message.images {
                    let (mime, data) = split_image(image);
                    parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{mime};base64,{data}") }
                    }));
                }
                out.push(json!({ "role": "user", "content": parts }));
            }
            role => out.push(json!({ "role": role, "content": message.content })),
        }
    }
    out
}

fn ollama_messages(config: &ApiConfig, messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = openai_messages(config, messages);
    for (index, message) in messages.iter().enumerate() {
        if message.role != "user" || message.images.is_empty() {
            continue;
        }
        let images = message
            .images
            .iter()
            .map(|image| split_image(image).1)
            .collect::<Vec<_>>();
        if let Some(item) = out.get_mut(index) {
            let text = item.get("content").cloned().unwrap_or_else(|| json!(message.content));
            item["content"] = json!(message.content);
            item["images"] = json!(images);
            let _ = text;
        }
    }
    out
}

fn tools_openai(tools: &[ToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| json!({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }
        }))
        .collect()
}

/* ---------- Anthropic ---------- */

fn anthropic_messages(config: &ApiConfig, messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        match message.role.as_str() {
            "tool" => out.push(json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id,
                    "content": message.content,
                }]
            })),
            "assistant" if !message.tool_calls.is_empty() => {
                let mut content = Vec::new();
                if !message.content.is_empty() {
                    content.push(json!({ "type": "text", "text": message.content }));
                }
                for call in &message.tool_calls {
                    content.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }));
                }
                out.push(json!({ "role": "assistant", "content": content }));
            }
            role if role == "user" && !message.images.is_empty() => {
                let mut content = vec![json!({ "type": "text", "text": message.content })];
                for image in &message.images {
                    let (mime, data) = split_image(image);
                    content.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": data,
                        }
                    }));
                }
                out.push(json!({ "role": "user", "content": content }));
            }
            role => out.push(json!({
                "role": if role == "assistant" { "assistant" } else { "user" },
                "content": message.content,
            })),
        }
    }
    let _ = config;
    out
}

/* ---------- Gemini ---------- */

fn gemini_contents(config: &ApiConfig, messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        match message.role.as_str() {
            "tool" => out.push(json!({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": message.name,
                        "response": { "result": message.content },
                    }
                }]
            })),
            "assistant" if !message.tool_calls.is_empty() => {
                let mut parts = Vec::new();
                if !message.content.is_empty() {
                    parts.push(json!({ "text": message.content }));
                }
                for call in &message.tool_calls {
                    parts.push(json!({
                        "functionCall": { "name": call.name, "args": call.arguments }
                    }));
                }
                out.push(json!({ "role": "model", "parts": parts }));
            }
            role if role == "user" && !message.images.is_empty() => {
                let mut parts = vec![json!({ "text": message.content })];
                for image in &message.images {
                    let (mime, data) = split_image(image);
                    parts.push(json!({
                        "inline_data": { "mime_type": mime, "data": data }
                    }));
                }
                out.push(json!({ "role": "user", "parts": parts }));
            }
            role => out.push(json!({
                "role": if role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": message.content }],
            })),
        }
    }
    let _ = config;
    out
}

/* ---------- 流式 ---------- */

/* 助手同一时刻只跑一轮请求，所以取消用一个全局开关就够：
   每次请求开始前清掉，用户在面板上按「停止」时置位，读循环每读到一行就查一次。
   缺点是不做真正的 socket 关闭——已经发出去的那一段由服务端跑完，
   但至少不会再把后面的轮次和工具调用继续下去。 */
static CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn assistant_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

fn canceled() -> bool {
    CANCEL.load(Ordering::Relaxed)
}

/* 和 send_json 同一套请求头，区别只在于回来的是没缓冲的响应体：
   SSE / NDJSON 要一行一行读，不能等整包收完。 */
fn open_stream(url: &str, config: &ApiConfig, body: Value) -> Result<Box<dyn BufRead + Send>, String> {
    let request = agent().post(url).set("Content-Type", "application/json");
    let request = match config.protocol.as_str() {
        "anthropic" => {
            let request = request.set("anthropic-version", "2023-06-01");
            if config.api_key.is_empty() {
                request
            } else {
                request.set("x-api-key", &config.api_key)
            }
        }
        "gemini" => request,
        _ => {
            if config.api_key.is_empty() {
                request
            } else {
                request.set("Authorization", &format!("Bearer {}", config.api_key))
            }
        }
    };
    match request.send_json(body) {
        Ok(response) => Ok(Box::new(BufReader::new(response.into_reader()))),
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(format!("接口返回 {code}：{}", truncate(&text, 800)))
        }
        Err(error) => Err(format!("请求失败：{error}")),
    }
}

fn emit_delta(app: &tauri::AppHandle, session: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let _ = app.emit("assistant-delta", json!({ "session": session, "text": text }));
}

/* 流里工具调用是分片来的：id / name 只来一次，arguments 是若干段 JSON 字符串。
   按协议给的 index 攒起来，收尾再整体解析一次。 */
#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

fn finish_calls(calls: Vec<PartialCall>) -> Vec<OutToolCall> {
    calls
        .into_iter()
        .filter(|call| !call.name.is_empty())
        .map(|call| OutToolCall {
            id: call.id,
            name: call.name,
            arguments: parse_arguments(&Value::String(call.arguments)),
        })
        .collect()
}

fn sse_payload(line: &str) -> Option<&str> {
    let payload = line.trim().strip_prefix("data:")?.trim();
    if payload.is_empty() {
        None
    } else {
        Some(payload)
    }
}

fn chat_openai_stream(
    app: &tauri::AppHandle,
    session: &str,
    config: &ApiConfig,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
) -> Result<ChatReply, String> {
    let url = join_url(&openai_base(&config.base_url), "chat/completions");
    let mut body = json!({
        "model": config.model,
        "messages": openai_messages(config, messages),
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools_openai(tools));
        body["tool_choice"] = json!("auto");
    }
    let reader = open_stream(&url, config, body)?;
    let mut text = String::new();
    let mut calls: std::collections::BTreeMap<usize, PartialCall> = std::collections::BTreeMap::new();
    for line in reader.lines() {
        if canceled() {
            return Ok(ChatReply {
                text,
                tool_calls: Vec::new(),
                model: config.model.clone(),
                canceled: true,
            });
        }
        let Ok(line) = line else { break };
        let Some(payload) = sse_payload(&line) else { continue };
        if payload == "[DONE]" {
            break;
        }
        let Ok(data) = serde_json::from_str::<Value>(payload) else { continue };
        let Some(delta) = data.pointer("/choices/0/delta") else { continue };
        if let Some(chunk) = delta.get("content").and_then(Value::as_str) {
            text.push_str(chunk);
            emit_delta(app, session, chunk);
        }
        let Some(list) = delta.get("tool_calls").and_then(Value::as_array) else { continue };
        for call in list {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let slot = calls.entry(index).or_default();
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            let Some(function) = call.get("function") else { continue };
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                if !name.is_empty() {
                    slot.name = name.to_string();
                }
            }
            if let Some(args) = function.get("arguments").and_then(Value::as_str) {
                slot.arguments.push_str(args);
            }
        }
    }
    Ok(ChatReply {
        text,
        tool_calls: finish_calls(calls.into_values().collect()),
        model: config.model.clone(),
        canceled: false,
    })
}

fn chat_anthropic_stream(
    app: &tauri::AppHandle,
    session: &str,
    config: &ApiConfig,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
) -> Result<ChatReply, String> {
    let url = join_url(&anthropic_base(&config.base_url), "messages");
    let mut body = json!({
        "model": config.model,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
        "messages": anthropic_messages(config, messages),
        "stream": true,
    });
    if !config.system_prompt.is_empty() {
        body["system"] = json!(config.system_prompt);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools.iter().map(|tool| json!({
            "name": tool.name,
            "description": tool.description,
            "input_schema": tool.parameters,
        })).collect::<Vec<_>>());
    }
    let reader = open_stream(&url, config, body)?;
    let mut text = String::new();
    let mut calls: std::collections::BTreeMap<usize, PartialCall> = std::collections::BTreeMap::new();
    for line in reader.lines() {
        if canceled() {
            return Ok(ChatReply {
                text,
                tool_calls: Vec::new(),
                model: config.model.clone(),
                canceled: true,
            });
        }
        let Ok(line) = line else { break };
        let Some(payload) = sse_payload(&line) else { continue };
        let Ok(data) = serde_json::from_str::<Value>(payload) else { continue };
        match data.get("type").and_then(Value::as_str).unwrap_or_default() {
            "content_block_start" => {
                let index = data.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block = data.get("content_block").cloned().unwrap_or(Value::Null);
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let slot = calls.entry(index).or_default();
                    slot.id = block.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    slot.name = block.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                }
            }
            "content_block_delta" => {
                let index = data.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = data.get("delta").cloned().unwrap_or(Value::Null);
                match delta.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "text_delta" => {
                        if let Some(chunk) = delta.get("text").and_then(Value::as_str) {
                            text.push_str(chunk);
                            emit_delta(app, session, chunk);
                        }
                    }
                    "input_json_delta" => {
                        if let Some(part) = delta.get("partial_json").and_then(Value::as_str) {
                            calls.entry(index).or_default().arguments.push_str(part);
                        }
                    }
                    _ => {}
                }
            }
            "message_stop" => break,
            "error" => {
                let message = data.pointer("/error/message").and_then(Value::as_str).unwrap_or("模型报错");
                return Err(message.to_string());
            }
            _ => {}
        }
    }
    Ok(ChatReply {
        text,
        tool_calls: finish_calls(calls.into_values().collect()),
        model: config.model.clone(),
        canceled: false,
    })
}

fn chat_gemini_stream(
    app: &tauri::AppHandle,
    session: &str,
    config: &ApiConfig,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
) -> Result<ChatReply, String> {
    let base = gemini_base(&config.base_url);
    let url = url_with_key(
        &join_url(
            &base,
            &format!("models/{}:streamGenerateContent?alt=sse", config.model),
        ),
        &config.api_key,
    );
    let mut body = json!({
        "contents": gemini_contents(config, messages),
        "generationConfig": {
            "temperature": config.temperature,
            "maxOutputTokens": config.max_tokens,
        }
    });
    if !config.system_prompt.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": config.system_prompt }] });
    }
    if !tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": tools.iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })).collect::<Vec<_>>()
        }]);
    }
    let reader = open_stream(&url, config, body)?;
    let mut text = String::new();
    let mut calls: Vec<PartialCall> = Vec::new();
    for line in reader.lines() {
        if canceled() {
            return Ok(ChatReply {
                text,
                tool_calls: Vec::new(),
                model: config.model.clone(),
                canceled: true,
            });
        }
        let Ok(line) = line else { break };
        let Some(payload) = sse_payload(&line) else { continue };
        let Ok(data) = serde_json::from_str::<Value>(payload) else { continue };
        let Some(parts) = data.pointer("/candidates/0/content/parts").and_then(Value::as_array) else {
            continue;
        };
        for part in parts {
            if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                text.push_str(chunk);
                emit_delta(app, session, chunk);
            }
            if let Some(call) = part.get("functionCall") {
                let name = call.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                calls.push(PartialCall {
                    id: format!("gemini-{}-{name}", calls.len()),
                    name,
                    arguments: call.get("args").map(|args| args.to_string()).unwrap_or_else(|| "{}".to_string()),
                });
            }
        }
    }
    Ok(ChatReply {
        text,
        tool_calls: finish_calls(calls),
        model: config.model.clone(),
        canceled: false,
    })
}

fn chat_ollama_stream(
    app: &tauri::AppHandle,
    session: &str,
    config: &ApiConfig,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
) -> Result<ChatReply, String> {
    let url = join_url(&config.base_url, "api/chat");
    let mut body = json!({
        "model": config.model,
        "messages": ollama_messages(config, messages),
        "stream": true,
        "options": {
            "temperature": config.temperature,
            "num_predict": config.max_tokens,
        }
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools_openai(tools));
    }
    let reader = open_stream(&url, config, body)?;
    let mut text = String::new();
    let mut calls: Vec<PartialCall> = Vec::new();
    for line in reader.lines() {
        if canceled() {
            return Ok(ChatReply {
                text,
                tool_calls: Vec::new(),
                model: config.model.clone(),
                canceled: true,
            });
        }
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(data) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(chunk) = data.pointer("/message/content").and_then(Value::as_str) {
            text.push_str(chunk);
            emit_delta(app, session, chunk);
        }
        if let Some(list) = data.pointer("/message/tool_calls").and_then(Value::as_array) {
            for call in list {
                let Some(function) = call.get("function") else { continue };
                calls.push(PartialCall {
                    id: format!("ollama-{}-{}", calls.len(), function.get("name").and_then(Value::as_str).unwrap_or_default()),
                    name: function.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    arguments: function
                        .get("arguments")
                        .map(|args| args.to_string())
                        .unwrap_or_else(|| "{}".to_string()),
                });
            }
        }
        if data.get("done").and_then(Value::as_bool).unwrap_or(false) {
            break;
        }
    }
    Ok(ChatReply {
        text,
        tool_calls: finish_calls(calls),
        model: config.model.clone(),
        canceled: false,
    })
}

/* ---------- 命令 ---------- */

#[tauri::command]
pub fn assistant_models(config: ApiConfig) -> Result<Vec<String>, String> {
    if config.base_url.trim().is_empty() {
        return Ok(Vec::new());
    }
    let data = match config.protocol.as_str() {
        "anthropic" => {
            let url = join_url(&anthropic_base(&config.base_url), "models");
            send_json("GET", &url, &config, None)?
        }
        "gemini" => {
            let url = url_with_key(&join_url(&gemini_base(&config.base_url), "models"), &config.api_key);
            send_json("GET", &url, &config, None)?
        }
        "ollama" => {
            let url = join_url(&config.base_url, "api/tags");
            send_json("GET", &url, &config, None)?
        }
        _ => {
            let url = join_url(&openai_base(&config.base_url), "models");
            send_json("GET", &url, &config, None)?
        }
    };
    let key = if config.protocol == "gemini" { "models" } else { "data" };
    let Some(list) = data.get(key).and_then(Value::as_array) else {
        return Err("模型列表返回格式不认识".to_string());
    };
    let mut names = list
        .iter()
        .filter_map(|item| item.get("id").or_else(|| item.get("name")).and_then(Value::as_str))
        .map(|name| name.strip_prefix("models/").unwrap_or(name).to_string())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

#[tauri::command]
pub async fn assistant_chat(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSpec>,
    session: Option<String>,
) -> Result<ChatReply, String> {
    let mut config = load(&app.state::<DbState>());
    if config.base_url.trim().is_empty() || config.model.trim().is_empty() {
        return Err("先在设置 → AI 助手里填好接口地址和模型".to_string());
    }
    if messages.is_empty() {
        return Err("消息是空的".to_string());
    }
    if has_images(&messages) && !config.supports_images {
        return Err("当前模型没开多模态：去设置 → AI 助手勾上「模型支持图片输入」".to_string());
    }
    CANCEL.store(false, Ordering::Relaxed);
    /* 已装的技能只把清单塞进系统提示，正文留给 skill_read：
       技能一多，正文全塞进来会把真正的对话挤出去 */
    let skills = crate::assistant_skills::skills_prompt(&app);
    if !skills.is_empty() {
        config.system_prompt = if config.system_prompt.trim().is_empty() {
            skills
        } else {
            format!("{}

{}", config.system_prompt.trim_end(), skills)
        };
    }
    let session = session.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || match config.protocol.as_str() {
        "anthropic" => chat_anthropic_stream(&app, &session, &config, &messages, &tools),
        "gemini" => chat_gemini_stream(&app, &session, &config, &messages, &tools),
        "ollama" => chat_ollama_stream(&app, &session, &config, &messages, &tools),
        _ => chat_openai_stream(&app, &session, &config, &messages, &tools),
    })
    .await
    .map_err(|e| format!("助手线程出错：{e}"))?
}
