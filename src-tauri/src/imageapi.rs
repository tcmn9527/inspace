/* 生图 API：设置里配好接口地址、Key 和模型名之后，出图不走本地扩散引擎，
   而是把提示词（和参考图）发给远端。支持两种协议：
   - images：OpenAI Images 风格，/images/generations 与 /images/edits（multipart，可带 mask）
   - chat：/chat/completions 多模态，提示词和图进消息，图片从返回里找

   请求是同步的（ureq），在后台线程里跑；取消只能等请求回来再认作废——
   这和放大那条路一样：网络那头掐不断，界面先按「已取消」显示。 */

use std::io::Read;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::db::{self, DbState};
use crate::gen_core::{GenRequest, Mode, Out};

const CONFIG_KEY: &str = "gen_api_config";
const TIMEOUT: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const BODY_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConfig {
    /// 老配置的开关位。这一版只有 API 一条路，出图不再看它，
    /// 留着只是为了旧 JSON 能原样反序列化。
    #[serde(default)]
    pub enabled: bool,
    /// images / chat
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// 同时最多跑几轮。0 = 老配置没这项，按默认 2 算。
    #[serde(default)]
    pub parallel: u32,
}

fn default_protocol() -> String {
    "images".to_string()
}

impl Default for ApiConfig {
    fn default() -> Self {
        ApiConfig {
            enabled: false,
            protocol: default_protocol(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            parallel: 2,
        }
    }
}

impl ApiConfig {
    /// 并行上限：0（老配置/没填）当 2，最多 10。
    pub fn parallel_limit(&self) -> usize {
        let value = if self.parallel == 0 { 2 } else { self.parallel };
        value.clamp(1, 10) as usize
    }

    /// 缺哪样在 `problem()` 里说清楚。
    pub fn problem(&self) -> Option<String> {
        if self.base_url.trim().is_empty() {
            return Some("接口地址还没填".to_string());
        }
        if self.model.trim().is_empty() {
            return Some("模型名还没填".to_string());
        }
        if self.api_key.trim().is_empty() {
            return Some("API Key 还没填".to_string());
        }
        None
    }

    fn protocol(&self) -> Protocol {
        match self.protocol.as_str() {
            "chat" => Protocol::Chat,
            _ => Protocol::Images,
        }
    }

    /// 用户填的根地址可能带尾巴斜杠，拼路径前统一去掉。
    fn base(&self) -> String {
        self.base_url.trim().trim_end_matches('/').to_string()
    }
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum Protocol {
    Images,
    Chat,
}

pub fn load(db: &DbState) -> ApiConfig {
    let conn = match db.0.lock() {
        Ok(conn) => conn,
        Err(_) => return ApiConfig::default(),
    };
    db::read_setting(&conn, CONFIG_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(db: &DbState, config: &ApiConfig) -> Result<(), String> {
    let conn = db
        .0
        .lock()
        .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
    let text = serde_json::to_string(config).map_err(|e| format!("API 配置存不下来：{e}"))?;
    db::write_setting(&conn, CONFIG_KEY, &text)
}

/* ---------- 命令 ---------- */

/// 设置页读配置。Key 原样返回给设置窗口（本机界面要能接着编辑），
/// MCP / 生图面板拿到的状态里只有「有没有配好」，不带 Key。
#[tauri::command]
pub fn gen_api_get(app: tauri::AppHandle) -> ApiConfig {
    load(&app.state::<DbState>())
}

#[tauri::command]
pub fn gen_api_set(
    app: tauri::AppHandle,
    state: tauri::State<crate::gen_core::GenState>,
    config: ApiConfig,
) -> Result<ApiConfig, String> {
    let mut next = config;
    next.protocol = match next.protocol.as_str() {
        "chat" => "chat".to_string(),
        _ => "images".to_string(),
    };
    next.base_url = next.base_url.trim().trim_end_matches('/').to_string();
    next.model = next.model.trim().to_string();
    next.api_key = next.api_key.trim().to_string();
    if !next.base_url.is_empty()
        && !next.base_url.starts_with("http://")
        && !next.base_url.starts_with("https://")
    {
        return Err("接口地址要以 http:// 或 https:// 开头".to_string());
    }
    save(&app.state::<DbState>(), &next)?;
    state.set_api(next.clone());
    let _ = app.emit("inspace:gen-api", serde_json::json!({ "enabled": next.enabled }));
    Ok(next)
}

/// 读这个接口能用的模型名：GET {base}/models，把列表抽成名字数组。
/// 模型名不让手填，只能从这份列表里挑。Key 不对、地址不通都在这步报出来。
#[tauri::command]
pub async fn gen_api_models(config: ApiConfig) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_models(&config))
        .await
        .map_err(|e| format!("读取模型列表的任务起不来：{e}"))?
}

fn fetch_models(config: &ApiConfig) -> Result<Vec<String>, String> {
    if config.base_url.trim().is_empty() {
        return Err("先把接口地址填上".to_string());
    }
    if !config.base_url.trim().starts_with("http://") && !config.base_url.trim().starts_with("https://") {
        return Err("接口地址要以 http:// 或 https:// 开头".to_string());
    }
    let url = format!("{}/models", config.base());
    let request = agent().get(&url);
    let request = if config.api_key.trim().is_empty() {
        request
    } else {
        request.set("Authorization", &format!("Bearer {}", config.api_key.trim()))
    };
    let resp = request.call().map_err(|error| match error {
        ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => {
            "服务器能连上，但 API Key 被拒了（401/403），检查一下 Key".to_string()
        }
        ureq::Error::Status(404, _) => {
            "这个地址下没有 /models 接口，换一个支持模型列表的接口地址".to_string()
        }
        ureq::Error::Status(code, resp) => {
            let body = read_body(resp).unwrap_or_default();
            format!("服务器回了 HTTP {code}：{}", trim_text(&body, 300))
        }
        other => format!("连不上：{other}"),
    })?;
    let text = read_body(resp)?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("接口返回的不是 JSON：{e}｜{}", trim_text(&text, 300)))?;
    let mut names = collect_model_names(&value);
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err(format!("接口没有返回模型列表：{}", trim_text(&text, 300)));
    }
    Ok(names)
}

/// 各家列表的形状不完全一样：OpenAI 是 data[].id，也有 models:[...] 或直接一个字符串数组。
fn collect_model_names(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<String>, item: &Value| match item {
        Value::String(name) => out.push(name.clone()),
        Value::Object(map) => {
            if let Some(Value::String(name)) = map.get("id").or_else(|| map.get("name")) {
                out.push(name.clone());
            }
        }
        _ => {}
    };
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array());
    if let Some(rows) = rows {
        for row in rows {
            push(&mut out, row);
        }
    }
    out
}

/* ---------- 出图 ---------- */

/// 走 API 出这一张。upscale 在 API 模式下没有对应能力，直接拒。
/// i2i / inpaint 降级成「参考图 + 提示词」；images 协议的 inpaint 会尽量带上 mask。
pub fn generate(config: &ApiConfig, req: &GenRequest, canceled: &std::sync::atomic::AtomicBool) -> Result<Out, String> {
    let mode = Mode::pick(req.mode.as_deref(), req.images.len());
    if mode == Mode::Upscale {
        return Err("不支持「高清放大」：它依赖本地放大模型，这一版已随本地引擎移除，换一档模式".to_string());
    }
    if canceled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    let width = req.width.unwrap_or(1024).clamp(64, 4096);
    let height = req.height.unwrap_or(1024).clamp(64, 4096);
    let prompt = req.prompt.trim();
    let result = match config.protocol() {
        Protocol::Images => images_request(config, mode, prompt, width, height, req),
        Protocol::Chat => chat_request(config, mode, prompt, req),
    }?;
    if canceled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("已取消".to_string());
    }
    decode_result(&result)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(TIMEOUT)
        .build()
}

fn auth(request: ureq::Request, config: &ApiConfig) -> ureq::Request {
    if config.api_key.trim().is_empty() {
        request
    } else {
        request.set("Authorization", &format!("Bearer {}", config.api_key.trim()))
    }
}

fn images_request(
    config: &ApiConfig,
    mode: Mode,
    prompt: &str,
    width: i32,
    height: i32,
    req: &GenRequest,
) -> Result<ImagePayload, String> {
    let base = config.base();
    if mode == Mode::Text {
        let url = format!("{base}/images/generations");
        let body = serde_json::json!({
            "model": config.model.trim(),
            "prompt": prompt,
            "n": 1,
            "size": format!("{width}x{height}"),
        });
        let text = serde_json::to_string(&body).map_err(|e| format!("请求拼不起来：{e}"))?;
        let request = auth(agent().post(&url), config).set("Content-Type", "application/json");
        let resp = send(request, text.as_bytes(), &url)?;
        return payload_from(resp);
    }

    let url = format!("{base}/images/edits");
    let mut parts = vec![Part::text("model", config.model.trim())];
    parts.push(Part::text("prompt", prompt));
    parts.push(Part::text("n", "1"));
    parts.push(Part::text("size", &format!("{width}x{height}")));
    /* 局部重绘：白=重绘、黑=保留。OpenAI 的约定是透明区域才是要改的地方，
       两种约定平台之间并不统一，所以按常见兼容做法把白区画成透明图再发。 */
    let mut images: Vec<&String> = req.images.iter().collect();
    if mode == Mode::Inpaint {
        if let Some(mask) = req.mask.as_deref().filter(|m| !m.trim().is_empty()) {
            if let Some(png) = mask_png(mask) {
                parts.push(Part::file("mask", "mask.png", "image/png", png));
            }
        }
    }
    if images.is_empty() {
        return Err("参考图编辑没有参考图".to_string());
    }
    if images.len() > 16 {
        images.truncate(16);
    }
    for (index, image) in images.into_iter().enumerate() {
        parts.push(Part::file(
            "image[]",
            &format!("image{index}.png"),
            "image/png",
            base64_image(image)?,
        ));
    }
    let (content_type, body) = multipart(parts);
    let request = auth(agent().post(&url), config).set("Content-Type", &content_type);
    let resp = send(request, &body, &url)?;
    payload_from(resp)
}

fn chat_request(
    config: &ApiConfig,
    mode: Mode,
    prompt: &str,
    req: &GenRequest,
) -> Result<ImagePayload, String> {
    let url = format!("{}/chat/completions", config.base());
    let mut content = vec![serde_json::json!({ "type": "text", "text": prompt })];
    if mode != Mode::Text {
        let images: Vec<&String> = req.images.iter().take(16).collect();
        if images.is_empty() {
            return Err("参考图编辑没有参考图".to_string());
        }
        for image in images {
            let data_url = to_data_url(image)?;
            content.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": data_url },
            }));
        }
    }
    /* chat 协议没有 size 字段，尺寸只能由模型自己定；把想要的尺寸写进消息里
       会改动用户提示词，所以这里不塞。 */
    let body = serde_json::json!({
        "model": config.model.trim(),
        "messages": [{ "role": "user", "content": content }],
    });
    let text = serde_json::to_string(&body).map_err(|e| format!("请求拼不起来：{e}"))?;
    let request = auth(agent().post(&url), config).set("Content-Type", "application/json");
    let resp = send(request, text.as_bytes(), &url)?;
    payload_from(resp)
}

fn send(request: ureq::Request, body: &[u8], url: &str) -> Result<Value, String> {
    let resp = request.send_bytes(body).map_err(|error| match error {
        ureq::Error::Status(code, resp) => {
            let text = read_body(resp).unwrap_or_default();
            let detail = trim_text(&text, 500);
            if detail.is_empty() {
                format!("接口回了 HTTP {code}（{url}）")
            } else {
                format!("接口回了 HTTP {code}：{detail}")
            }
        }
        other => format!("请求发不出去（{url}）：{other}"),
    })?;
    let text = read_body(resp)?;
    serde_json::from_str(&text).map_err(|e| format!("接口返回的不是 JSON：{e}｜{}", trim_text(&text, 300)))
}

fn read_body(resp: ureq::Response) -> Result<String, String> {
    let mut reader = resp.into_reader().take(BODY_LIMIT);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| format!("读接口返回失败：{e}"))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
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

/* ---------- 返回值里的图 ---------- */

/// 两种协议返回的形状差很多，这里统一成「base64 或 URL」二选一。
enum ImagePayload {
    Base64(String),
    Url(String),
}

fn payload_from(value: Value) -> Result<ImagePayload, String> {
    if let Some(found) = find_images(&value).into_iter().next() {
        return Ok(found);
    }
    /* 没图的错误响应常把原因放在 error.message 里 */
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("");
    if !message.is_empty() {
        return Err(format!("接口没有返回图片：{message}"));
    }
    Err(format!("接口没有返回图片：{}", trim_text(&value.to_string(), 300)))
}

/// 宽度优先把整个 JSON 翻一遍：data[0].b64_json、data[0].url、
/// chat 的 message.content（字符串里的 data: / markdown 链接 / 数组里的 image_url）、
/// 以及一些平台直接把图塞在 message.images 里。
fn find_images(value: &Value) -> Vec<ImagePayload> {
    let mut found = Vec::new();
    walk_images(value, &mut found, 0);
    found
}

fn walk_images(value: &Value, found: &mut Vec<ImagePayload>, depth: usize) {
    if depth > 8 {
        return;
    }
    match value {
        Value::Object(map) => {
            if let Some(Value::String(b64)) = map.get("b64_json") {
                if !b64.is_empty() {
                    found.push(ImagePayload::Base64(b64.clone()));
                }
            }
            if let Some(Value::String(url)) = map.get("url") {
                if looks_like_url(url) {
                    found.push(ImagePayload::Url(url.clone()));
                }
            }
            for child in map.values() {
                walk_images(child, found, depth + 1);
            }
        }
        Value::Array(items) => {
            for child in items {
                walk_images(child, found, depth + 1);
            }
        }
        Value::String(text) => {
            scan_string(text, found);
        }
        _ => {}
    }
}

fn scan_string(text: &str, found: &mut Vec<ImagePayload>) {
    /* data URL 是最明确的信号，优先 */
    if let Some(at) = text.find("data:image/") {
        let rest = &text[at..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == ')' || c == '\'' || c == ']')
            .unwrap_or(rest.len());
        let candidate = &rest[..end];
        if let Some(comma) = candidate.find(";base64,") {
            found.push(ImagePayload::Base64(candidate[comma + 8..].to_string()));
            return;
        }
    }
    for token in text.split(|c: char| c.is_whitespace() || c == '"' || c == ')' || c == '(' || c == '\'' || c == ']' || c == '[') {
        let token = token.trim_matches(|c: char| c == ',' || c == '`');
        if looks_like_url(token) {
            found.push(ImagePayload::Url(token.to_string()));
        }
    }
}

fn looks_like_url(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && (lower.contains(".png")
            || lower.contains(".jpg")
            || lower.contains(".jpeg")
            || lower.contains(".webp")
            || lower.contains("image"))
}

fn decode_result(payload: &ImagePayload) -> Result<Out, String> {
    let bytes = match payload {
        ImagePayload::Base64(text) => BASE64
            .decode(text.trim())
            .map_err(|e| format!("接口返回的 base64 解不开：{e}"))?,
        ImagePayload::Url(url) => download(url)?,
    };
    let decoded = image::load_from_memory(&bytes).map_err(|e| format!("接口返回的图打不开：{e}"))?;
    let rgb = decoded.to_rgb8();
    let (width, height) = rgb.dimensions();
    Ok(Out {
        width,
        height,
        channel: 3,
        pixels: rgb.into_raw(),
    })
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url)
        .set("Accept", "image/*")
        .call()
        .map_err(|error| format!("图片下载失败（{url}）：{error}"))?;
    let mut reader = resp.into_reader().take(BODY_LIMIT);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| format!("图片下载读不完：{e}"))?;
    Ok(bytes)
}

/* ---------- 请求体的零件 ---------- */

/// 前端传的是 PNG 的 base64（可能带 data: 前缀）。这里统一成二进制。
fn base64_image(text: &str) -> Result<Vec<u8>, String> {
    let body = match text.find(',') {
        Some(at) if text.starts_with("data:") => &text[at + 1..],
        _ => text,
    };
    BASE64
        .decode(body.trim())
        .map_err(|e| format!("参考图不是 base64：{e}"))
}

fn to_data_url(text: &str) -> Result<String, String> {
    if text.starts_with("data:") {
        return Ok(text.to_string());
    }
    base64_image(text).map(|bytes| format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

/// 遮罩：白=重绘、黑=保留 → 转成 OpenAI 约定的「透明处才重绘」。
fn mask_png(text: &str) -> Option<Vec<u8>> {
    let bytes = base64_image(text).ok()?;
    let decoded = image::load_from_memory(&bytes).ok()?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut out = Vec::with_capacity((width * height * 4) as usize);
    for pixel in rgba.pixels() {
        let gray = (pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32) / 3;
        let alpha = if gray >= 128 { 0 } else { 255 };
        out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], alpha]);
    }
    let image = image::RgbaImage::from_raw(width, height, out)?;
    let mut png = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png);
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .ok()?;
    Some(png)
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
        "inspace-{:x}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
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
                format!("Content-Disposition: form-data; name=\"{}\"\r\n\r\n", part.name).as_bytes(),
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
    use std::sync::atomic::AtomicBool;

    /* 1×1 的 PNG：编辑/遮罩只要是个能解开的图就行 */
    const PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn config(protocol: &str) -> ApiConfig {
        ApiConfig {
            enabled: true,
            protocol: protocol.to_string(),
            base_url: "http://127.0.0.1:38999/v1".to_string(),
            api_key: "test".to_string(),
            model: "mock-image-1".to_string(),
        }
    }

    fn request(mode: &str) -> GenRequest {
        GenRequest {
            block: "test".to_string(),
            prompt: "一张测试图".to_string(),
            negative: None,
            width: Some(96),
            height: Some(64),
            steps: None,
            cfg: None,
            seed: None,
            images: Vec::new(),
            mode: Some(mode.to_string()),
            strength: None,
            mask: None,
            family: None,
            refine: None,
            refine_strength: None,
        }
    }

    fn canceled() -> AtomicBool {
        AtomicBool::new(false)
    }

    #[test]
    fn images_text() {
        let out = generate(&config("images"), &request("t2i"), &canceled()).expect("images t2i");
        assert_eq!((out.width, out.height, out.channel), (96, 64, 3));
        assert_eq!(out.pixels.len(), 96 * 64 * 3);
    }

    #[test]
    fn chat_text() {
        let out = generate(&config("chat"), &request("t2i"), &canceled()).expect("chat t2i");
        assert_eq!((out.width, out.height), (96, 64));
    }

    #[test]
    fn images_edit_and_inpaint() {
        let mut req = request("edit");
        req.images = vec![PIXEL_PNG.to_string(), PIXEL_PNG.to_string()];
        let out = generate(&config("images"), &req, &canceled()).expect("images edit");
        assert_eq!((out.width, out.height), (96, 64));

        let mut req = request("inpaint");
        req.images = vec![PIXEL_PNG.to_string()];
        req.mask = Some(PIXEL_PNG.to_string());
        let out = generate(&config("images"), &req, &canceled()).expect("images inpaint");
        assert_eq!((out.width, out.height), (96, 64));
    }

    #[test]
    fn chat_edit() {
        let mut req = request("edit");
        req.images = vec![PIXEL_PNG.to_string()];
        let out = generate(&config("chat"), &req, &canceled()).expect("chat edit");
        assert_eq!((out.width, out.height), (96, 64));
    }

    #[test]
    fn upscale_rejected() {
        match generate(&config("images"), &request("upscale"), &canceled()) {
            Err(error) => assert!(error.contains("不支持"), "{error}"),
            Ok(_) => panic!("upscale 应该被拒绝"),
        }
    }

    #[test]
    fn problem_reports_missing() {
        let mut cfg = config("images");
        cfg.api_key.clear();
        assert!(cfg.problem().unwrap().contains("API Key"));
        cfg.api_key = "k".into();
        cfg.base_url.clear();
        assert!(cfg.problem().unwrap().contains("接口地址"));
    }

    #[test]
    fn models_listed() {
        let names = fetch_models(&config("images")).expect("models");
        assert!(names.contains(&"mock-image-1".to_string()), "{names:?}");
    }
}
