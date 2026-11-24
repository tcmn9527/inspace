//! 助手技能：一个目录一个技能，目录里放一份 SKILL.md。
//!
//! SKILL.md 的格式和常见的 agent skill 一致：开头一段 YAML frontmatter 写
//! name / description，后面是给模型看的指令正文。列表只读 frontmatter（便宜），
//! 全文等模型真要用时再通过 skill_read 取——技能多了也不会把上下文撑爆。

use crate::store::DataRoot;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const SKILL_DIR: &str = "assistant/skills";
const SKILL_FILE: &str = "SKILL.md";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub bytes: u64,
}

fn skills_root(app: &tauri::AppHandle) -> PathBuf {
    app.state::<DataRoot>().dir(SKILL_DIR)
}

fn ensure_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = skills_root(app);
    fs::create_dir_all(&root).map_err(|e| format!("建不了技能目录：{e}"))?;
    Ok(root)
}

/* 目录名就是 id：只留字母数字、汉字、横线和下划线，别的一律换成 -。
   这样目录名能直接拼进路径，也不会因为斜杠跑出去。 */
fn safe_id(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "skill".to_string()
    } else {
        out.chars().take(48).collect()
    }
}

/* frontmatter 只认 `key: value` 这种一行一对的写法：
   不引 yaml 依赖，够用就行；写错了当没有，退回目录名和首行。 */
fn frontmatter(text: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let body = text.trim_start();
    if !body.starts_with("---") {
        return (name, description);
    }
    let mut rest = &body[3..];
    if let Some(stripped) = rest.strip_prefix("\r\n") {
        rest = stripped;
    } else if let Some(stripped) = rest.strip_prefix('\n') {
        rest = stripped;
    }
    for line in rest.lines() {
        let line = line.trim();
        if line == "---" || line == "..." {
            break;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
        match key.trim() {
            "name" => name = value,
            "description" => description = value,
            _ => {}
        }
    }
    (name, description)
}

/* 跳过 frontmatter 之后的正文：frontmatter 自己那几行不是给人读的说明 */
fn body_of(text: &str) -> &str {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return trimmed;
    }
    let rest = trimmed[3..].trim_start_matches(['\r', '\n']);
    match rest.find("\n---") {
        Some(index) => rest[index + 4..].trim_start_matches(['\r', '\n']),
        None => rest,
    }
}

fn first_line(text: &str) -> String {
    for line in text.lines() {
        let line = line.trim().trim_start_matches('#').trim();
        if line.is_empty() {
            continue;
        }
        return line.chars().take(80).collect();
    }
    String::new()
}

fn read_skill(id: &str, dir: &Path) -> Option<SkillInfo> {
    let file = dir.join(SKILL_FILE);
    let text = fs::read_to_string(&file).ok()?;
    let (name, description) = frontmatter(&text);
    let bytes = fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
    Some(SkillInfo {
        id: id.to_string(),
        name: if name.is_empty() { id.to_string() } else { name },
        description: if description.is_empty() { first_line(body_of(&text)) } else { description },
        path: file.to_string_lossy().to_string(),
        bytes,
    })
}

fn list_all(app: &tauri::AppHandle) -> Vec<SkillInfo> {
    let root = skills_root(app);
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|name| name.to_string_lossy().to_string()) else {
            continue;
        };
        if let Some(info) = read_skill(&id, &path) {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
pub fn assistant_skills_list(app: tauri::AppHandle) -> Vec<SkillInfo> {
    list_all(&app)
}

#[tauri::command]
pub fn assistant_skills_dir(app: tauri::AppHandle) -> Result<String, String> {
    let root = ensure_root(&app)?;
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn assistant_skill_read(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let root = skills_root(&app);
    let file = root.join(safe_id(&id)).join(SKILL_FILE);
    fs::read_to_string(&file).map_err(|e| format!("读不到技能 {id}：{e}"))
}

#[tauri::command]
pub fn assistant_skill_save(
    app: tauri::AppHandle,
    id: Option<String>,
    name: String,
    description: String,
    content: String,
) -> Result<SkillInfo, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("技能得有个名字".to_string());
    }
    if content.trim().is_empty() {
        return Err("SKILL.md 是空的".to_string());
    }
    let id = id
        .map(|value| safe_id(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| safe_id(&name));
    let root = ensure_root(&app)?;
    let dir = root.join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("建不了技能目录：{e}"))?;

    /* 正文里已经有 frontmatter 就不再套一层，免得出现两段 --- */
    let text = if content.trim_start().starts_with("---") {
        content
    } else {
        format!(
            "---\nname: {name}\ndescription: {}\n---\n\n{}",
            description.trim(),
            content.trim()
        )
    };
    fs::write(dir.join(SKILL_FILE), text).map_err(|e| format!("写不了 SKILL.md：{e}"))?;
    read_skill(&id, &dir).ok_or_else(|| "技能写进去了但读不回来".to_string())
}

#[tauri::command]
pub fn assistant_skill_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = skills_root(&app).join(safe_id(&id));
    if !dir.is_dir() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("删不掉技能：{e}"))
}

/* 导入：从用户选的目录里复制 SKILL.md。名字取 frontmatter 的 name，
   没有就用目录名。已经装过同名的就加序号，不覆盖人家手上的版本。 */
#[tauri::command]
pub fn assistant_skill_import(app: tauri::AppHandle, from: String) -> Result<SkillInfo, String> {
    let source = PathBuf::from(from.trim());
    let file = if source.is_dir() {
        source.join(SKILL_FILE)
    } else {
        source.clone()
    };
    if !file.is_file() {
        return Err("这个目录里没有 SKILL.md".to_string());
    }
    let text = fs::read_to_string(&file).map_err(|e| format!("读不了 SKILL.md：{e}"))?;
    let (name, description) = frontmatter(&text);
    let fallback = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "导入的技能".to_string());
    let name = if name.is_empty() { fallback } else { name };
    assistant_skill_save(app, None, name, description, text)
}

/* 拼进系统提示的那一段：只说有哪些技能、一句话说明、要用就先 skill_read。
   这里刻意不塞正文——技能多了会挤掉真正的对话。 */
pub fn skills_prompt(app: &tauri::AppHandle) -> String {
    let skills = list_all(app);
    if skills.is_empty() {
        return String::new();
    }
    let mut out = String::from("可用技能（需要哪项就先调 skill_read 拿完整说明，再照说明做）：\n");
    for skill in &skills {
        let description = if skill.description.is_empty() {
            "（没有写说明）".to_string()
        } else {
            skill.description.clone()
        };
        out.push_str(&format!("- {}（id: {}）：{}\n", skill.name, skill.id, description));
    }
    out
}
