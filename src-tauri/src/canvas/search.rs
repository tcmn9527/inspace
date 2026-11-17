/* canvas::search —— 从原 canvas.rs 拆出的子模块。 */

use super::*;

#[derive(Serialize)]
pub struct SearchHit {
    space: String,
    space_name: String,
    item: String,
    kind: String,
    text: String,
}

const SEARCH_LIMIT: usize = 200;
const SEARCH_SNIPPET: usize = 42;

/// 在一段文字里找命中点，切出前后各 42 个字符的片段。
/// 大小写不敏感只在 needle 上做（统一转小写），原文保持原样返回。
fn match_snippet(text: &str, needle: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let lower = text.to_lowercase();
    let at = lower.find(needle)?;
    /* lowercase 对中文和 ASCII 不改变字节数，但别赌这个：切点一律对齐到字符边界 */
    let mut start = at.saturating_sub(SEARCH_SNIPPET);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + needle.len() + SEARCH_SNIPPET).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let body = text.get(start..end)?;
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(body.trim());
    if end < text.len() {
        out.push('…');
    }
    Some(out)
}

/// 跨画布搜索：把所有画布的 items.json 过一遍，只认块里那点文字。
///
/// 不做倒排索引——画布最多几十个，一次全量扫比维护一套索引和它的失效逻辑便宜，
/// 也不会出现「索引说改了、盘上说没改」这种两头对不上的状态。
#[tauri::command]
pub fn canvas_search(
    query: String,
    state: tauri::State<'_, CanvasState>,
) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    let (canvases, _) = walk_spaces(&state.root());
    for (id, dir) in canvases {
        if hits.len() >= SEARCH_LIMIT {
            break;
        }
        let Ok(items) = read_items(&dir) else {
            continue;
        };
        let Some(list) = items.as_array() else {
            continue;
        };
        /* 画布名等真搜到东西再读：没命中的画布不该为此多开一次文件 */
        let mut space_name: Option<String> = None;
        for item in list {
            if hits.len() >= SEARCH_LIMIT {
                break;
            }
            let Some(object) = item.as_object() else {
                continue;
            };
            let kind = object.get("type").and_then(|v| v.as_str()).unwrap_or("");
            for key in ["name", "brand", "sku", "spec", "note", "text", "markdown", "label", "title", "src"] {
                let Some(value) = object.get(key).and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(text) = match_snippet(value, &needle) else {
                    continue;
                };
                let name = space_name
                    .get_or_insert_with(|| {
                        let fallback = dir
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| id.clone());
                        read_meta(&dir, &fallback).0
                    })
                    .clone();
                hits.push(SearchHit {
                    space: id.clone(),
                    space_name: name,
                    item: object
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    kind: kind.to_string(),
                    text,
                });
                /* 一块只报一条：同一块的名字和正文都中了，也就一个结果 */
                break;
            }
        }
    }
    Ok(hits)
}
