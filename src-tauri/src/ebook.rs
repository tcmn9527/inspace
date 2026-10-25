/* 电子书只读解析：epub 是 zip + xhtml，mobi 是 Palm 数据库 + PalmDOC 压缩。
 * 两种都自己解，不落临时文件、不调用外部程序；azw3 的 Huffman 压缩和 KF8 拼装这一版不做。
 * 输出是已经清洗过的单章 HTML：图片内联成 data URL，脚本和事件属性全部丢掉，
 * 前端只管把它塞进一个不带 allow-scripts 的 iframe。 */

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAX_ENTRY_BYTES: u64 = 48 * 1024 * 1024;
const MAX_PDB_BYTES: u64 = 64 * 1024 * 1024;
/* 一章里的图片全塞进 IPC 会撑爆内存：超过这个量就只留文字 */
const MAX_CHAPTER_ASSETS: usize = 10 * 1024 * 1024;

#[derive(serde::Serialize)]
pub struct Book {
    pub format: &'static str,
    pub title: String,
    pub author: String,
    pub chapters: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct Chapter {
    pub title: String,
    pub html: String,
}

pub fn open(path: &Path) -> Result<Book, String> {
    match ext_of(path).as_str() {
        "epub" => epub_open(path),
        "mobi" | "azw" => mobi_open(path),
        "azw3" => Err(AZW3_HINT.to_string()),
        _ => Err("这种格式还不支持预览".to_string()),
    }
}

pub fn chapter(path: &Path, index: usize) -> Result<Chapter, String> {
    match ext_of(path).as_str() {
        "epub" => epub_chapter(path, index),
        "mobi" | "azw" => mobi_chapter(path, index),
        "azw3" => Err(AZW3_HINT.to_string()),
        _ => Err("这种格式还不支持预览".to_string()),
    }
}

const AZW3_HINT: &str = "azw3 这一版还读不了（正文是 Huffman 压缩的 KF8），换成同名的 epub 或 mobi 就能看";

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn be16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2)
        .and_then(|s| s.try_into().ok())
        .map(u16::from_be_bytes)
}

fn be32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map(u32::from_be_bytes)
}

fn le16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2)
        .and_then(|s| s.try_into().ok())
        .map(u16::from_le_bytes)
}

fn le32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map(u32::from_le_bytes)
}

/* ---------- zip（epub 的容器） ---------- */

#[derive(Clone)]
struct ZipEntry {
    method: u16,
    csize: u64,
    offset: u64,
}

struct Zip {
    file: File,
    entries: HashMap<String, ZipEntry>,
}

impl Zip {
    fn open(path: &Path) -> Result<Zip, String> {
        let mut file = File::open(path).map_err(|e| format!("打不开这本书：{e}"))?;
        let len = file
            .metadata()
            .map_err(|e| format!("读不到文件信息：{e}"))?
            .len();
        if len < 22 {
            return Err("这本书不是一个完整的 epub".to_string());
        }
        /* 目录区在文件尾，签名也许被注释挤开，所以从后往前找 */
        let tail_len = len.min(66_000);
        let mut tail = vec![0u8; tail_len as usize];
        file.seek(SeekFrom::Start(len - tail_len))
            .map_err(|e| e.to_string())?;
        file.read_exact(&mut tail)
            .map_err(|e| format!("读不了文件尾：{e}"))?;
        let mut eocd = None;
        for i in (0..tail.len().saturating_sub(3)).rev() {
            if tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06] {
                eocd = Some(i);
                break;
            }
        }
        let eocd = eocd.ok_or_else(|| "这本书的目录结构读不出来".to_string())?;
        let count = le16(&tail, eocd + 10).unwrap_or(0) as usize;
        let cd_size = le32(&tail, eocd + 12).unwrap_or(0) as u64;
        let cd_off = le32(&tail, eocd + 16).unwrap_or(0) as u64;
        /* EOCD 里这两个字段顶满就是 zip64，得另读一份目录；书架上的书少见，直接说清楚 */
        if count == 0xffff || cd_off == u32::MAX as u64 || cd_size == u32::MAX as u64 {
            return Err("这本电子书用了 ZIP64 打包，暂时打不开".to_string());
        }
        let want = cd_size.min(16 * 1024 * 1024);
        let mut cd = vec![0u8; want as usize];
        file.seek(SeekFrom::Start(cd_off))
            .map_err(|e| e.to_string())?;
        file.read_exact(&mut cd)
            .map_err(|e| format!("读不了文件目录：{e}"))?;

        let mut entries = HashMap::new();
        let mut pos = 0usize;
        for _ in 0..count {
            if cd.get(pos..pos + 4) != Some(&[0x50, 0x4b, 0x01, 0x02]) {
                break;
            }
            let method = le16(&cd, pos + 10).unwrap_or(0);
            let csize = le32(&cd, pos + 20).unwrap_or(0) as u64;
            let name_len = le16(&cd, pos + 28).unwrap_or(0) as usize;
            let extra_len = le16(&cd, pos + 30).unwrap_or(0) as usize;
            let comment_len = le16(&cd, pos + 32).unwrap_or(0) as usize;
            let offset = le32(&cd, pos + 42).unwrap_or(0) as u64;
            let Some(name) = cd.get(pos + 46..pos + 46 + name_len) else {
                break;
            };
            let name = String::from_utf8_lossy(name).replace('\\', "/");
            entries.insert(
                name,
                ZipEntry {
                    method,
                    csize,
                    offset,
                },
            );
            pos += 46 + name_len + extra_len + comment_len;
        }
        if entries.is_empty() {
            return Err("这本书里没有可读的条目".to_string());
        }
        Ok(Zip { file, entries })
    }

    fn read(&mut self, name: &str) -> Result<Vec<u8>, String> {
        let entry = self
            .entries
            .get(name)
            .or_else(|| {
                /* 有的书目录里大小写和引用对不上，兜一次不区分大小写的查找 */
                let lower = name.to_ascii_lowercase();
                self.entries
                    .iter()
                    .find(|(key, _)| key.to_ascii_lowercase() == lower)
                    .map(|(_, value)| value)
            })
            .cloned()
            .ok_or_else(|| format!("这本书里缺 {name}"))?;
        if entry.csize > MAX_ENTRY_BYTES {
            return Err("这本电子书里有超大条目，先不支持".to_string());
        }
        self.file
            .seek(SeekFrom::Start(entry.offset))
            .map_err(|e| e.to_string())?;
        let mut head = [0u8; 30];
        self.file
            .read_exact(&mut head)
            .map_err(|_| "这本书的文件结构坏了".to_string())?;
        if head[0..4] != [0x50, 0x4b, 0x03, 0x04] {
            return Err("这本书的文件结构坏了".to_string());
        }
        let name_len = le16(&head, 26).unwrap_or(0) as u64;
        let extra_len = le16(&head, 28).unwrap_or(0) as u64;
        self.file
            .seek(SeekFrom::Start(entry.offset + 30 + name_len + extra_len))
            .map_err(|e| e.to_string())?;
        let mut raw = vec![0u8; entry.csize as usize];
        self.file
            .read_exact(&mut raw)
            .map_err(|_| "这本书的文件结构坏了".to_string())?;
        match entry.method {
            0 => Ok(raw),
            8 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(&raw[..])
                    .read_to_end(&mut out)
                    .map_err(|e| format!("解压失败：{e}"))?;
                Ok(out)
            }
            other => Err(format!("这个压缩方式（{other}）读不了")),
        }
    }
}

/* ---------- 公共的 HTML 清洗 ---------- */

/* 章节里的图从哪来：epub 按路径问 zip 要，mobi 按 recindex 问 PDB 要 */
trait Res {
    fn image(&mut self, attrs: &[(String, String)], base: &str, budget: &mut usize) -> Option<String>;
    fn css(&mut self, href: &str, base: &str, budget: &mut usize) -> Option<String>;
}

const KEEP_TAGS: &[&str] = &[
    "p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "i", "em",
    "u", "small", "sup", "sub", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr",
    "td", "th", "img", "a", "section", "article", "pre", "code",
];

const KEEP_ATTRS: &[&str] = &["class", "style", "id", "colspan", "rowspan", "start"];

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn escape_attr(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;")
}

fn parse_tag(src: &str, start: usize) -> Option<(usize, String, Vec<(String, String)>, bool, bool)> {
    let bytes = src.as_bytes();
    let mut i = start + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' && bytes[i] != b'/' {
        i += 1;
    }
    let name = src[name_start..i].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut self_closing = false;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        if bytes[i] == b'>' {
            i += 1;
            break;
        }
        if bytes[i] == b'/' {
            self_closing = true;
            i += 1;
            continue;
        }
        let key_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'>'
            && bytes[i] != b'/'
        {
            i += 1;
        }
        let key = src[key_start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if let Some(quote) = bytes.get(i).copied().filter(|c| *c == b'"' || *c == b'\'') {
                i += 1;
                let value_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value = src[value_start..i].to_string();
                i += 1;
            } else {
                let value_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                value = src[value_start..i].to_string();
            }
        }
        if !key.is_empty() {
            attrs.push((key, value));
        }
    }
    Some((i, name, attrs, closing, self_closing))
}

/* CSS 里的 url(...) 换成 data URL；换不出来的（外链）整条声明留着也没用，原样丢掉引用 */
fn rewrite_css_urls(css: &str, res: &mut dyn Res, base: &str, budget: &mut usize) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(pos) = rest.to_ascii_lowercase().find("url(") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 4..];
        let Some(end) = after.find(')') else {
            out.push_str(&rest[pos..]);
            return out;
        };
        let raw = after[..end].trim().trim_matches(|c| c == '"' || c == '\'');
        let replaced = res.css(raw, base, budget);
        match replaced {
            Some(data_url) => {
                out.push_str("url(\"");
                out.push_str(&data_url);
                out.push_str("\")");
            }
            None => out.push_str("none"),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/* 清洗一章：白名单标签、丢脚本、图片内联、外链一律不引。
   base 是这一章在书里的位置，用来把相对路径拼成 zip 里的绝对条目名。 */
fn clean_html(src: &str, res: &mut dyn Res, base: &str, budget: &mut usize) -> String {
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    let bytes = src.as_bytes();
    while i < bytes.len() {
        if bytes[i] != b'<' {
            let start = i;
            while i < bytes.len() && bytes[i] != b'<' {
                i += 1;
            }
            for ch in src[start..i].chars() {
                /* 控制字符（含 NUL）在 HTML 里没有意义，只会把排版搞乱 */
                if ch == '\n' || ch == '\r' || ch == '\t' || ch >= ' ' {
                    out.push(ch);
                }
            }
            continue;
        }
        if src[i..].starts_with("<!--") {
            match src[i + 4..].find("-->") {
                Some(end) => i += 4 + end + 3,
                None => break,
            }
            continue;
        }
        if src[i..].starts_with("<!") || src[i..].starts_with("<?") {
            match src[i..].find('>') {
                Some(end) => i += end + 1,
                None => break,
            }
            continue;
        }
        let Some((next, name, attrs, closing, self_closing)) = parse_tag(src, i) else {
            out.push('<');
            i += 1;
            continue;
        };
        i = next;
        /* 脚本和样式整段丢掉：epub 的 CSS 另行内联，mobi 里的 style 也没内容 */
        if name == "script" || name == "style" || name == "title" {
            if !closing && !self_closing {
                let needle = format!("</{name}");
                if let Some(end) = src[i..].to_ascii_lowercase().find(&needle) {
                    let after = &src[i + end..];
                    i += end + after.find('>').map(|p| p + 1).unwrap_or(after.len());
                }
            }
            continue;
        }
        if name == "link" {
            let rel = attr(&attrs, "rel").unwrap_or("");
            if rel.eq_ignore_ascii_case("stylesheet") {
                if let Some(href) = attr(&attrs, "href") {
                    if let Some(css) = res.css(href, base, budget) {
                        out.push_str("<style>");
                        out.push_str(&css);
                        out.push_str("</style>");
                    }
                }
            }
            continue;
        }
        if name == "img" {
            if closing {
                continue;
            }
            if let Some(src_url) = res.image(&attrs, base, budget) {
                out.push_str("<img src=\"");
                out.push_str(&escape_attr(&src_url));
                out.push_str("\" alt=\"\">");
            }
            continue;
        }
        if !KEEP_TAGS.contains(&name.as_str()) {
            continue;
        }
        if closing {
            out.push_str("</");
            out.push_str(&name);
            out.push('>');
            continue;
        }
        out.push('<');
        out.push_str(&name);
        for (key, value) in &attrs {
            if !KEEP_ATTRS.contains(&key.as_str()) {
                if key == "href" && name == "a" && value.starts_with('#') {
                    out.push_str(" href=\"");
                    out.push_str(&escape_attr(value));
                    out.push('"');
                }
                continue;
            }
            if value.starts_with("javascript:") {
                continue;
            }
            out.push(' ');
            out.push_str(key);
            out.push_str("=\"");
            out.push_str(&escape_attr(value));
            out.push('"');
        }
        out.push('>');
    }
    out
}

const ENTITIES: &[(&str, &str)] = &[
    ("&nbsp;", " "),
    ("&amp;", "&"),
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", "\""),
    ("&#39;", "'"),
    ("&apos;", "'"),
    ("&mdash;", "—"),
    ("&ndash;", "–"),
    ("&hellip;", "…"),
    ("&ldquo;", "“"),
    ("&rdquo;", "”"),
    ("&middot;", "·"),
];

fn plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 4);
    let mut i = 0usize;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            match html[i..].find('>') {
                Some(end) => i += end + 1,
                None => break,
            }
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i] != b'<' {
            i += 1;
        }
        out.push_str(&html[start..i]);
    }
    for (from, to) in ENTITIES {
        if out.contains(from) {
            out = out.replace(from, to);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_heading(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for tag in ["h1", "h2", "h3"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        let Some(start) = lower.find(&open) else {
            continue;
        };
        let Some(text_start) = lower[start..].find('>') else {
            continue;
        };
        let from = start + text_start + 1;
        if let Some(end) = lower[from..].find(&close) {
            let text = plain_text(&html[from..from + end]);
            if !text.is_empty() && text.chars().count() <= 60 {
                return Some(text);
            }
        }
    }
    None
}

fn reader_wrap(title: &str, body: &str) -> String {
    /* 阅读区固定按「纸」来排：应用本身是深色的，正文跟着深色反而难读，
       所以这里强制浅底深字，并把行高、页边距定死，不让书的 CSS 把它挤没 */
    format!(
        "<!DOCTYPE html><html lang=\"zh\"><head><meta charset=\"utf-8\">\
<title>{}</title>\
<style>\
html{{background:#fbfaf6;}}\
body{{margin:0 auto;padding:30px 34px 44px;max-width:44em;color:#1f2023;\
font:17px/1.85 \"Noto Serif SC\",\"Source Han Serif SC\",\"Songti SC\",Georgia,serif;\
word-wrap:break-word;overflow-wrap:break-word;}}\
img{{max-width:100%;height:auto;}}\
h1,h2,h3,h4{{line-height:1.4;margin:1.2em 0 .6em;}}\
h1{{font-size:1.5em;}}h2{{font-size:1.3em;}}h3{{font-size:1.15em;}}\
p{{margin:0 0 .85em;text-align:justify;}}\
blockquote{{margin:.9em 0;padding:.2em .9em;border-left:3px solid #d8d2c4;color:#4a4a4a;}}\
table{{border-collapse:collapse;max-width:100%;}}td,th{{border:1px solid #ddd;padding:.3em .5em;}}\
a{{color:#8a5a1f;text-decoration:none;}}\
</style></head><body>{}</body></html>",
        escape_attr(title),
        body
    )
}

/* ---------- epub ---------- */

struct EpubRes<'a> {
    zip: &'a mut Zip,
}

fn data_url(bytes: &[u8]) -> Option<String> {
    let mime = if bytes.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") {
        "image/webp"
    } else if bytes.starts_with(b"<svg") || bytes.windows(4).any(|w| w == b"<svg") {
        "image/svg+xml"
    } else {
        return None;
    };
    use base64::Engine;
    Some(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

impl Res for EpubRes<'_> {
    fn image(&mut self, attrs: &[(String, String)], base: &str, budget: &mut usize) -> Option<String> {
        let src = attr(attrs, "src").or_else(|| attr(attrs, "xlink:href"))?;
        if src.starts_with("data:") {
            return Some(src.to_string());
        }
        if src.starts_with("http:") || src.starts_with("https:") {
            return None;
        }
        let path = join_path(base, src);
        let bytes = self.zip.read(&path).ok()?;
        if bytes.len() > *budget {
            return None;
        }
        let url = data_url(&bytes)?;
        *budget = budget.saturating_sub(bytes.len());
        Some(url)
    }

    fn css(&mut self, href: &str, base: &str, budget: &mut usize) -> Option<String> {
        if href.starts_with("http:") || href.starts_with("https:") || href.starts_with("data:") {
            return None;
        }
        let path = join_path(base, href);
        let raw = self.zip.read(&path).ok()?;
        let css = decode_any(&raw);
        let css_base = parent_dir(&path);
        Some(rewrite_css_urls(&css, self, &css_base, budget))
    }
}

fn decode_any(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            /* epub 规定 UTF-8；真遇到别的编码交给已有的 GB18030 兜底思路，这里用替换字符保底 */
            String::from_utf8_lossy(bytes).to_string()
        }
    }
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(pos) => path[..pos].to_string(),
        None => String::new(),
    }
}

/* 相对 href → zip 里的条目名；顺手把 %20 这类转义还原、把 ../ 折掉 */
fn join_path(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or(href);
    let decoded = percent_decode(href);
    let raw = if decoded.starts_with('/') {
        decoded.trim_start_matches('/').to_string()
    } else if base.is_empty() {
        decoded
    } else {
        format!("{base}/{decoded}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

struct EpubDoc {
    path: String,
    title: String,
}

struct EpubBody {
    docs: Vec<EpubDoc>,
    title: String,
    author: String,
}

fn xml_attr(tag: &quick_xml::events::BytesStart, want: &str) -> Option<String> {
    tag.attributes().flatten().find_map(|a| {
        if a.key.local_name().as_ref() == want {
            Some(a.value.to_string())
        } else {
            None
        }
    })
}

/* 0.42 把实体引用单独拆成 GeneralRef 事件，标题里的 &amp; 这类得自己接回去 */
fn ref_char(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            if let Some(num) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(num, 16).ok().and_then(char::from_u32)
            } else if let Some(num) = name.strip_prefix('#') {
                num.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                None
            }
        }
    }
}

fn event_text(event: &quick_xml::events::Event) -> String {    match event {
        quick_xml::events::Event::Text(text) => text.as_ref().to_string(),
        quick_xml::events::Event::GeneralRef(reference) => {
            ref_char(reference.as_ref()).map(String::from).unwrap_or_default()
        }
        quick_xml::events::Event::CData(text) => text.as_ref().to_string(),
        _ => String::new(),
    }
}

/* 有 encryption.xml 不一定是 DRM：很多书只把字体做了混淆，正文照样能读。
   只有当被加密的资源不是字体时才算真加密——掌阅、ADEPT 都是这种。 */
fn epub_drm(zip: &mut Zip) -> Option<String> {
    let raw = zip.read("META-INF/encryption.xml").ok()?;
    let xml = decode_any(&raw);
    let lower = xml.to_ascii_lowercase();
    let mut at = 0usize;
    while let Some(pos) = lower[at..].find("cipherreference") {
        let start = at + pos;
        let tag_end = match xml[start..].find('>') {
            Some(end) => start + end,
            None => break,
        };
        let tag = &xml[start..tag_end];
        if let Some(uri_at) = tag.find("URI=\"") {
            let rest = &tag[uri_at + 5..];
            if let Some(uri_end) = rest.find('"') {
                let uri = rest[..uri_end].to_ascii_lowercase();
                let font = [".ttf", ".otf", ".woff", ".woff2"]
                    .iter()
                    .any(|ext| uri.ends_with(ext));
                if !font {
                    return Some("这本书带 DRM（加密），打不开；请用没加密的版本".to_string());
                }
            }
        }
        at = tag_end;
    }
    None
}

fn epub_parse(path: &Path) -> Result<(Zip, EpubBody), String> {
    let mut zip = Zip::open(path)?;
    if let Some(err) = epub_drm(&mut zip) {
        return Err(err);
    }
    let container = zip.read("META-INF/container.xml")?;
    let container = decode_any(&container);
    let opf_path = {
        let mut reader = quick_xml::Reader::from_str(&container);
        let mut found = None;
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Start(tag))
                | Ok(quick_xml::events::Event::Empty(tag)) => {
                    if tag.local_name().as_ref() == "rootfile" {
                        found = xml_attr(&tag, "full-path");
                        if found.is_some() {
                            break;
                        }
                    }
                }
                Ok(quick_xml::events::Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        found.ok_or_else(|| "这本书里找不到正文索引".to_string())?
    };
    let opf = zip.read(&opf_path)?;
    let opf = decode_any(&opf);
    let opf_dir = parent_dir(&opf_path);

    let mut items: HashMap<String, String> = HashMap::new();
    let mut spine: Vec<String> = Vec::new();
    let mut ncx_path: Option<String> = None;
    let mut title = String::new();
    let mut author = String::new();
    {
        let mut reader = quick_xml::Reader::from_str(&opf);
        let mut text_target = String::new();
        loop {
            match reader.read_event() {
                /* OPF 里 <item/>、<itemref/> 几乎总是自闭合，Start 和 Empty 都得接 */
                Ok(quick_xml::events::Event::Start(tag))
                | Ok(quick_xml::events::Event::Empty(tag)) => {
                    match tag.local_name().as_ref() {
                        "item" => {
                            if let (Some(id), Some(href)) =
                                (xml_attr(&tag, "id"), xml_attr(&tag, "href"))
                            {
                                let media = xml_attr(&tag, "media-type").unwrap_or_default();
                                if media.contains("ncx") {
                                    ncx_path = Some(join_path(&opf_dir, &href));
                                }
                                items.insert(id, href);
                            }
                        }
                        "itemref" => {
                            if let Some(idref) = xml_attr(&tag, "idref") {
                                spine.push(idref);
                            }
                        }
                        "title" => text_target = "title".to_string(),
                        "creator" => text_target = "creator".to_string(),
                        _ => {}
                    }
                }
                Ok(event @ (quick_xml::events::Event::Text(_)
                | quick_xml::events::Event::GeneralRef(_)
                | quick_xml::events::Event::CData(_))) => {
                    if !text_target.is_empty() {
                        let value = event_text(&event);
                        let slot = if text_target == "title" { &mut title } else { &mut author };
                        if slot.is_empty() {
                            *slot = value.trim().to_string();
                        }
                    }
                }
                Ok(quick_xml::events::Event::End(_)) => text_target.clear(),
                Ok(quick_xml::events::Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }

    /* ncx 里的目录名：按 href 对齐到 spine 的文档，章节名比正文里的 h1 更准 */
    let mut labels: HashMap<String, String> = HashMap::new();
    if let Some(ncx_path) = ncx_path {
        if let Ok(raw) = zip.read(&ncx_path) {
            let ncx = decode_any(&raw);
            let ncx_dir = parent_dir(&ncx_path);
            let mut reader = quick_xml::Reader::from_str(&ncx);
            let mut pending = String::new();
            loop {
                match reader.read_event() {
                    /* ncx 里 <content src="..."/> 也基本是自闭合 */
                    Ok(quick_xml::events::Event::Start(tag))
                    | Ok(quick_xml::events::Event::Empty(tag)) => {
                        if tag.local_name().as_ref() == "content" {
                            if let (Some(src), false) = (xml_attr(&tag, "src"), pending.is_empty()) {
                                labels.insert(join_path(&ncx_dir, &src), pending.clone());
                                pending.clear();
                            }
                        }
                    }
                    Ok(event @ (quick_xml::events::Event::Text(_)
                    | quick_xml::events::Event::GeneralRef(_)
                    | quick_xml::events::Event::CData(_))) => {
                        if pending.is_empty() {
                            let value = event_text(&event);
                            let value = value.trim().to_string();
                            if !value.is_empty() {
                                pending = value;
                            }
                        }
                    }
                    Ok(quick_xml::events::Event::Eof) | Err(_) => break,
                    _ => {}
                }
            }
        }
    }

    let mut docs = Vec::new();
    for (index, id) in spine.iter().enumerate() {
        let Some(href) = items.get(id) else { continue };
        let path = join_path(&opf_dir, href);
        let title = labels
            .get(&path)
            .cloned()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("第 {} 节", index + 1));
        docs.push(EpubDoc { path, title });
    }
    if docs.is_empty() {
        return Err("这本书里没有正文".to_string());
    }
    Ok((
        zip,
        EpubBody {
            docs,
            title: if title.is_empty() {
                "未命名电子书".to_string()
            } else {
                title
            },
            author,
        },
    ))
}

fn epub_open(path: &Path) -> Result<Book, String> {
    let (_zip, body) = epub_parse(path)?;
    Ok(Book {
        format: "epub",
        title: body.title,
        author: body.author,
        chapters: body.docs.iter().map(|d| d.title.clone()).collect(),
    })
}

fn epub_chapter(path: &Path, index: usize) -> Result<Chapter, String> {
    let (mut zip, body) = epub_parse(path)?;
    let doc = body
        .docs
        .get(index)
        .ok_or_else(|| "这本书没有这一章".to_string())?;
    let raw = zip.read(&doc.path)?;
    let html = decode_any(&raw);
    let base = parent_dir(&doc.path);
    let mut budget = MAX_CHAPTER_ASSETS;
    let mut res = EpubRes { zip: &mut zip };
    let cleaned = clean_html(&html, &mut res, &base, &mut budget);
    Ok(Chapter {
        title: doc.title.clone(),
        html: reader_wrap(&doc.title, &cleaned),
    })
}

/* ---------- mobi ---------- */

struct Pdb {
    file: File,
    starts: Vec<u64>,
    sizes: Vec<u64>,
}

impl Pdb {
    fn open(path: &Path) -> Result<Pdb, String> {
        let mut file = File::open(path).map_err(|e| format!("打不开这本书：{e}"))?;
        let len = file
            .metadata()
            .map_err(|e| format!("读不到文件信息：{e}"))?
            .len();
        if len > MAX_PDB_BYTES {
            return Err("这本书太大了，暂时打不开".to_string());
        }
        let mut head = [0u8; 78];
        file.read_exact(&mut head)
            .map_err(|_| "这本书不是 mobi 格式".to_string())?;
        let count = be16(&head, 0x4C).unwrap_or(0) as usize;
        if count == 0 || count > 20_000 {
            return Err("这本书不是 mobi 格式".to_string());
        }
        let mut list = vec![0u8; count * 8];
        file.read_exact(&mut list)
            .map_err(|_| "这本书的文件结构坏了".to_string())?;
        let mut starts = Vec::with_capacity(count);
        for i in 0..count {
            starts.push(be32(&list, i * 8).unwrap_or(0) as u64);
        }
        let mut sizes = Vec::with_capacity(count);
        for i in 0..count {
            let end = starts.get(i + 1).copied().unwrap_or(len);
            let start = starts[i];
            sizes.push(if end > start { end - start } else { 0 });
        }
        Ok(Pdb {
            file,
            starts,
            sizes,
        })
    }

    fn record(&mut self, index: usize) -> Result<Vec<u8>, String> {
        let start = *self
            .starts
            .get(index)
            .ok_or_else(|| "这本书的文件结构坏了".to_string())?;
        let size = *self
            .sizes
            .get(index)
            .ok_or_else(|| "这本书的文件结构坏了".to_string())?;
        self.file
            .seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; size as usize];
        self.file
            .read_exact(&mut buf)
            .map_err(|_| "这本书的文件结构坏了".to_string())?;
        Ok(buf)
    }
}

struct Mobi {
    pdb: Pdb,
    compression: u16,
    text_records: usize,
    text_len: usize,
    first_image: usize,
    /* 这本书的文本记录有没有 2 字节长度头：按正文第一个字节判断，见 has_prefix */
    has_prefix: bool,
    /* EXTH 里的书名和作者，比正文里的第一个标题靠谱 */
    title: Option<String>,
    author: Option<String>,
}

/* EXTH 是 mobi 的元数据区：文件名的「04乌合之众」不是书名，这里才有真名。
   EXTH 标志在 MOBI 头的 0x70，紧接着整个 MOBI 头。 */
fn mobi_meta(rec0: &[u8]) -> (Option<String>, Option<String>) {
    let mut title = mobi_full_name(rec0);
    let flags = be32(rec0, 0x80).unwrap_or(0);
    let header_len = be32(rec0, 0x14).unwrap_or(0) as usize;
    let start = 0x10usize.saturating_add(header_len);
    if flags & 0x40 == 0 || rec0.get(start..start + 4) != Some(&b"EXTH"[..]) {
        return (title, None);
    }
    let count = be32(rec0, start + 8).unwrap_or(0) as usize;
    let mut author = None;
    let mut at = start + 12;
    for _ in 0..count.min(512) {
        let kind = be32(rec0, at).unwrap_or(0);
        let len = be32(rec0, at + 4).unwrap_or(0) as usize;
        if len < 8 || at + len > rec0.len() {
            break;
        }
        let value = String::from_utf8_lossy(&rec0[at + 8..at + len])
            .trim()
            .to_string();
        if !value.is_empty() {
            if kind == 100 && author.is_none() {
                author = Some(value);
            } else if kind == 503 && title.is_none() {
                title = Some(value);
            }
        }
        at += len;
    }
    (title, author)
}

/* MOBI 头 0x44 是书名在记录 0 里的偏移，0x48 是长度 */
fn mobi_full_name(rec0: &[u8]) -> Option<String> {
    let at = be32(rec0, 0x54)? as usize;
    let len = be32(rec0, 0x58)? as usize;
    let bytes = rec0.get(at..at.checked_add(len)?)?;
    let name = decode_mobi_text(bytes).trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

fn mobi_open_file(path: &Path) -> Result<Mobi, String> {
    let mut pdb = Pdb::open(path)?;
    let rec0 = pdb.record(0)?;
    if rec0.len() < 0x10 + 0x18 {
        return Err("这本书不是 mobi 格式".to_string());
    }
    let compression = be16(&rec0, 0).unwrap_or(0);
    let text_len = be32(&rec0, 4).unwrap_or(0) as usize;
    let text_records = be16(&rec0, 8).unwrap_or(0) as usize;
    let encryption = be16(&rec0, 0x0C).unwrap_or(0);
    if encryption != 0 {
        return Err("这本书带 DRM（加密），打不开；请用没加密的版本".to_string());
    }
    if compression == 17480 {
        return Err(AZW3_HINT.to_string());
    }
    if !matches!(compression, 1 | 2) {
        return Err(format!("这个压缩方式（{compression}）读不了"));
    }
    if rec0.get(0x10..0x14) != Some(&b"MOBI"[..]) {
        return Err("这本书不是 mobi 格式".to_string());
    }
    let version = be32(&rec0, 0x24).unwrap_or(0);
    /* MOBI 8 及以上是 KF8：正文已不在这份 PalmDOC 记录里 */
    if version >= 8 {
        return Err(AZW3_HINT.to_string());
    }
    let first_image = be32(&rec0, 0x6C).unwrap_or(0) as usize;
    if text_records == 0 || text_len == 0 {
        return Err("这本书里没有正文".to_string());
    }
    let (title, author) = mobi_meta(&rec0);
    let mut mobi = Mobi {
        pdb,
        compression,
        text_records,
        text_len,
        first_image,
        has_prefix: false,
        title,
        author,
    };
    mobi.has_prefix = mobi.detect_prefix();
    Ok(mobi)
}

impl Mobi {
    /* 规范说每条文本记录开头有 2 字节解压后长度，但实际有书（比如混合了 MOBI7 和 KF8
       的合订本）没有。两条路各解前几条记录，谁解出来的字节多就用谁：
       开头差 2 字节时字典距离立刻对不上，解几条就断，长度差得很明显。 */
    fn detect_prefix(&mut self) -> bool {
        if self.compression == 1 {
            return false;
        }
        let mut with = 0usize;
        let mut without = 0usize;
        let mut probe = Vec::new();
        for index in 1..=self.text_records.min(3) {
            let Ok(rec) = self.pdb.record(index) else {
                continue;
            };
            if rec.is_empty() {
                continue;
            }
            probe.clear();
            palmdoc(rec.get(2..).unwrap_or(&[]), &mut probe, 4096);
            with += probe.len();
            probe.clear();
            palmdoc(&rec, &mut probe, 4096);
            without += probe.len();
        }
        with > without
    }

    /* 拼出整本书的正文：输出缓冲区跨记录连续。这不只是为了省内存——
       有的书的压缩字典会跨记录引用，按记录各自解会直接解错。 */
    fn raw_text(&mut self) -> Result<Vec<u8>, String> {
        let mut out: Vec<u8> = Vec::with_capacity(self.text_len + 4096);
        for index in 1..=self.text_records {
            let rec = self.pdb.record(index)?;
            let skip = if self.has_prefix && self.compression == 2 { 2 } else { 0 };
            let body = rec.get(skip..).unwrap_or(&[]);
            if self.compression == 1 {
                out.extend_from_slice(body);
            } else {
                /* 一条记录最多 4096 字节正文，后面紧跟着 trailing entries
                   （多字节重叠之类的附加数据）。不设上限的话它们会被当成
                   正文解出来，在每条记录末尾留下几个乱码字节。 */
                let limit = out.len() + 4096;
                palmdoc(body, &mut out, limit);
                out.truncate(limit);
            }
        }
        if out.len() > self.text_len {
            out.truncate(self.text_len);
        }
        Ok(out)
    }

    fn image_record(&mut self, n: usize) -> Option<Vec<u8>> {
        if self.first_image == 0 || n == 0 {
            return None;
        }
        let index = self.first_image + n - 1;
        self.pdb.record(index).ok()
    }
}

/* PalmDOC 的 LZ77：输出直接追加到 out 上，跨记录共享同一个缓冲区（见 raw_text）。
   limit 是这条记录解到哪儿为止——记录末尾的附加数据不算正文。 */
fn palmdoc(data: &[u8], target: &mut Vec<u8>, limit: usize) {
    let mut i = 0usize;
    while i < data.len() && target.len() < limit {
        let c = data[i];
        i += 1;
        match c {
            0x00 => target.push(0),
            0x01..=0x08 => {
                let count = c as usize;
                let end = (i + count).min(data.len());
                target.extend_from_slice(&data[i..end]);
                i = end;
            }
            0x09..=0x7f => target.push(c),
            0x80..=0xbf => {
                if i >= data.len() {
                    break;
                }
                let pair = ((c as usize) << 8) | data[i] as usize;
                i += 1;
                let distance = (pair >> 3) & 0x07ff;
                let length = (pair & 0x07) + 3;
                if distance == 0 || distance > target.len() {
                    break;
                }
                let start = target.len() - distance;
                for k in 0..length {
                    let byte = target[start + k];
                    target.push(byte);
                }
            }
            _ => {
                target.push(b' ');
                target.push(c ^ 0x80);
            }
        }
    }
}

struct MobiRes<'a> {
    mobi: &'a mut Mobi,
}

impl Res for MobiRes<'_> {
    fn image(&mut self, attrs: &[(String, String)], _base: &str, budget: &mut usize) -> Option<String> {
        let recindex = attr(attrs, "recindex")?;
        let n: usize = recindex.trim().parse().ok()?;
        let bytes = self.mobi.image_record(n)?;
        if bytes.len() > *budget {
            return None;
        }
        /* 记录头可能有偏移数据，从签名处切出来 */
        for sig in [&[0xffu8, 0xd8][..], b"\x89PNG\r\n\x1a\n", b"GIF8"] {
            if let Some(pos) = bytes.windows(sig.len()).position(|w| w == sig) {
                let image = &bytes[pos..];
                let url = data_url(image)?;
                *budget = budget.saturating_sub(image.len());
                return Some(url);
            }
        }
        None
    }

    fn css(&mut self, _href: &str, _base: &str, _budget: &mut usize) -> Option<String> {
        None
    }
}

/* 分页标记是 mobi 自己的私有标签，正文里用它切开 */
fn split_sections(text: &str) -> Vec<String> {
    let mut sections = Vec::new();
    let mut current = String::new();
    let mut rest = text;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(pos) = lower.find("<mbp:pagebreak") else {
            current.push_str(rest);
            break;
        };
        current.push_str(&rest[..pos]);
        sections.push(std::mem::take(&mut current));
        let after = &rest[pos..];
        let Some(end) = after.find('>') else {
            break;
        };
        rest = &after[end + 1..];
    }
    if !current.trim().is_empty() {
        sections.push(current);
    }
    sections
}

struct MobiDoc {
    index: usize,
    title: String,
}

fn mobi_text(mobi: &mut Mobi) -> Result<String, String> {
    let raw = mobi.raw_text()?;
    Ok(text_cut(&decode_mobi_text(&raw)).to_string())
}

fn mobi_docs(sections: &[String]) -> Vec<MobiDoc> {
    let mut docs = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        let has_image = section.to_ascii_lowercase().contains("<img");
        let plain = plain_text(section);
        if plain.is_empty() && !has_image {
            continue;
        }
        let title = if let Some(heading) = first_heading(section) {
            heading
        } else if plain.is_empty() {
            "插图".to_string()
        } else {
            plain.chars().take(18).collect::<String>()
        };
        docs.push(MobiDoc { index, title });
    }
    docs
}

fn decode_mobi_text(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    /* 只断在最后一个完整字符之后：截断位置的残字节不是编码错 */
    let cut = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(err) => err.valid_up_to(),
    };
    String::from_utf8_lossy(&bytes[..cut]).to_string()
}

fn text_cut(text: &str) -> &str {
    /* 文本流末尾常带索引区，切到最后一个 </html> 为止。只在它明显靠后时切：
       有的书每条记录都是独立的一小段 HTML，只按「最后一个」切会把正文腰斩 */
    let lower = text.to_ascii_lowercase();
    match lower.rfind("</html>") {
        Some(pos) if pos * 2 >= text.len() => &text[..pos + 7],
        _ => text,
    }
}

fn mobi_open(path: &Path) -> Result<Book, String> {
    let mut mobi = mobi_open_file(path)?;
    let text = mobi_text(&mut mobi)?;
    let docs = mobi_docs(&split_sections(&text));
    if docs.is_empty() {
        return Err("这本书里没有正文".to_string());
    }
    let title = mobi
        .title
        .clone()
        .filter(|t| usable_meta(t))
        .or_else(|| first_heading(&text))
        .unwrap_or_else(|| {
            Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名电子书".to_string())
        });
    Ok(Book {
        format: "mobi",
        title,
        author: mobi
            .author
            .clone()
            .filter(|a| usable_meta(a))
            .unwrap_or_default(),
        chapters: docs.iter().map(|d| d.title.clone()).collect(),
    })
}

/* 元数据里常有人懒得填，「index」「Unknown」这种当没填 */
fn usable_meta(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "index" | "untitled" | "unknown" | "anonymous" | "佚名" | "未知"
        )
}

fn mobi_chapter(path: &Path, index: usize) -> Result<Chapter, String> {
    let mut mobi = mobi_open_file(path)?;
    let text = mobi_text(&mut mobi)?;
    let sections = split_sections(&text);
    let docs = mobi_docs(&sections);
    let doc = docs
        .get(index)
        .ok_or_else(|| "这本书没有这一节".to_string())?;
    let section = sections
        .get(doc.index)
        .ok_or_else(|| "这本书没有这一节".to_string())?;
    let mut budget = MAX_CHAPTER_ASSETS;
    let mut res = MobiRes { mobi: &mut mobi };
    let cleaned = clean_html(section, &mut res, "", &mut budget);
    Ok(Chapter {
        title: doc.title.clone(),
        html: reader_wrap(&doc.title, &cleaned),
    })
}
