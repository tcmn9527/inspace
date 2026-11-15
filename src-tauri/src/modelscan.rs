//! 模型目录扫描：用户把权重文件丢进约定目录，这里按「文件名关键词 + 大小」
//! 认出每个槽位该用哪个文件。认不出来时给改名建议，而不是让引擎去载错东西。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::store::{DataRoot, GEN_DIR};

pub const VIDEO_SUB: &str = "h3video";
pub const IMAGE_H3_SUB: &str = "h3image";

/// 小于这个体积的一律不当权重（阈值、配置、mmproj 之外的杂物）
const MIN_WEIGHT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_DEPTH: usize = 3;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub path: String,
    pub name: String,
    pub bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSlot {
    /// diffusion / videoVae / audioVae / encoder
    pub role: String,
    pub label: String,
    pub required: bool,
    pub missing: bool,
    pub file: Option<ModelFile>,
    pub suggest_name: String,
    pub suggest_bytes: u64,
    pub url: String,
    /// 共享、改名建议之类的补充说明
    pub note: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub dir: String,
    pub ready: bool,
    pub roles: Vec<RoleSlot>,
    pub notes: Vec<String>,
    pub found_bytes: u64,
}

pub fn video_default_dir(data: &DataRoot) -> PathBuf {
    data.dir(GEN_DIR).join(VIDEO_SUB)
}

pub fn image_default_dir(data: &DataRoot) -> PathBuf {
    data.dir(GEN_DIR).join(IMAGE_H3_SUB)
}

/// 递归收集候选权重：深度有限、跳过隐藏目录，按打开后的元数据看大小。
fn collect(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, u64)>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect(&path, depth + 1, out);
            continue;
        }
        if !meta.is_file() || meta.len() < MIN_WEIGHT_BYTES {
            continue;
        }
        let lower = name.to_lowercase();
        if !lower.ends_with(".gguf")
            && !lower.ends_with(".safetensors")
            && !lower.ends_with(".ckpt")
            && !lower.ends_with(".pt")
            && !lower.ends_with(".bin")
        {
            continue;
        }
        out.push((path, meta.len()));
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VideoRole {
    Diffusion,
    VideoVae,
    AudioVae,
    Encoder,
}

impl VideoRole {
    fn id(self) -> &'static str {
        match self {
            VideoRole::Diffusion => "diffusion",
            VideoRole::VideoVae => "videoVae",
            VideoRole::AudioVae => "audioVae",
            VideoRole::Encoder => "encoder",
        }
    }

    fn label(self) -> &'static str {
        match self {
            VideoRole::Diffusion => "扩散模型",
            VideoRole::VideoVae => "视频 VAE",
            VideoRole::AudioVae => "音频 VAE",
            VideoRole::Encoder => "文本编码器",
        }
    }

    fn suggest(self) -> (&'static str, u64, &'static str) {
        match self {
            VideoRole::Diffusion => (
                "minimax_h3_fl2va_pruned-Q4_K_M.gguf",
                11_420_663_904,
                "https://hf-mirror.com/leejet/MiniMax-H3-GGUF/resolve/main/minimax_h3_fl2va_pruned-Q4_K_M.gguf",
            ),
            VideoRole::VideoVae => (
                "minimax_h3_video_vae_fp16.safetensors",
                5_207_808_496,
                "https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors",
            ),
            VideoRole::AudioVae => (
                "minimax_h3_audio_vae_fp32.safetensors",
                605_254_808,
                "https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
            ),
            VideoRole::Encoder => (
                "qwen3vl_32b_minimax_h3-Q2_K_M.gguf",
                13_102_161_024,
                "https://hf-mirror.com/leejet/MiniMax-H3-GGUF/resolve/main/qwen3vl_32b_minimax_h3-Q2_K_M.gguf",
            ),
        }
    }

    fn prefer(self) -> &'static [&'static str] {
        match self {
            VideoRole::Diffusion => &["q4_k", "q4", "fp8", "int8"],
            VideoRole::VideoVae => &["fp16", "video_vae"],
            VideoRole::AudioVae => &["fp32", "audio_vae"],
            VideoRole::Encoder => &["q2", "q3", "q4", "int8"],
        }
    }
}

/// 按名字认角色：编码器要和扩散模型分开，qwen3vl 的文件名里也带 minimax_h3，
/// 所以「编码器类关键词」必须先于「H3 关键词」判断。
fn video_role_of(name: &str, bytes: u64) -> Option<VideoRole> {
    let lower = name.to_lowercase();
    if lower.contains("audio") {
        return Some(VideoRole::AudioVae);
    }
    if lower.contains("qwen")
        || lower.contains("clip")
        || lower.contains("text_encoder")
        || lower.contains("t5")
        || lower.contains("encoder")
        || lower.contains("llm")
    {
        return Some(VideoRole::Encoder);
    }
    if lower.contains("vae") {
        return Some(VideoRole::VideoVae);
    }
    if lower.contains("minimax")
        || lower.contains("fl2va")
        || lower.contains("ref2va")
        || lower.contains("t2v")
        || lower.contains("i2v")
        || lower.contains("dit")
        || lower.contains("h3")
    {
        return Some(VideoRole::Diffusion);
    }
    /* 名字完全不带关键词的，只能靠体积猜：视频这套四件套的体积档位差得很开 */
    let gb = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    if lower.ends_with(".gguf") && (8.0..=24.0).contains(&gb) {
        return Some(VideoRole::Diffusion);
    }
    if lower.ends_with(".safetensors") {
        if gb >= 2.0 {
            return Some(VideoRole::VideoVae);
        }
        return Some(VideoRole::AudioVae);
    }
    None
}

fn pick(candidates: &[(PathBuf, u64)], role: VideoRole) -> Option<ModelFile> {
    let mut best: Option<&(PathBuf, u64)> = None;
    let mut best_score = -1;
    for entry in candidates {
        let name = entry
            .0
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mut score = 0;
        for (index, token) in role.prefer().iter().enumerate() {
            if name.contains(token) {
                score = 100 - index as i32;
                break;
            }
        }
        if score > best_score {
            best_score = score;
            best = Some(entry);
        }
    }
    best.map(|(path, bytes)| ModelFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        bytes: *bytes,
    })
}

pub fn scan_video(dir: &Path, shared_dirs: &[PathBuf]) -> ScanReport {
    let mut files = Vec::new();
    collect(dir, 0, &mut files);
    let mut bucket: Vec<(VideoRole, Vec<(PathBuf, u64)>)> = Vec::new();
    let mut unknown: Vec<(PathBuf, u64)> = Vec::new();
    for (path, bytes) in &files {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        match video_role_of(&name, *bytes) {
            Some(role) => {
                if let Some((_, list)) = bucket.iter_mut().find(|(r, _)| *r == role) {
                    list.push((path.clone(), *bytes));
                } else {
                    bucket.push((role, vec![(path.clone(), *bytes)]));
                }
            }
            None => unknown.push((path.clone(), *bytes)),
        }
    }

    let mut notes = Vec::new();
    let mut found_bytes = 0u64;
    let mut roles = Vec::new();
    for role in [
        VideoRole::Diffusion,
        VideoRole::VideoVae,
        VideoRole::AudioVae,
        VideoRole::Encoder,
    ] {
        let candidates = bucket
            .iter()
            .find(|(r, _)| *r == role)
            .map(|(_, list)| list.clone())
            .unwrap_or_default();
        let mut file = pick(&candidates, role);
        let mut note = String::new();
        if file.is_none() && matches!(role, VideoRole::Encoder) {
            /* 编码器和生图共用：视频目录里没有就去生图目录借 */
            for shared in shared_dirs {
                let mut shared_files = Vec::new();
                collect(shared, 0, &mut shared_files);
                let shared_candidates: Vec<(PathBuf, u64)> = shared_files
                    .into_iter()
                    .filter(|(path, bytes)| {
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        video_role_of(&name, *bytes) == Some(VideoRole::Encoder)
                    })
                    .collect();
                if let Some(found) = pick(&shared_candidates, role) {
                    note = format!("和生图共用，来自 {}", shared.display());
                    file = Some(found);
                    break;
                }
            }
        }
        if candidates.len() > 1 {
            if let Some(chosen) = &file {
                let others: Vec<String> = candidates
                    .iter()
                    .filter(|(path, _)| path.to_string_lossy() != chosen.path)
                    .filter_map(|(path, _)| {
                        path.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                    })
                    .collect();
                if !others.is_empty() {
                    notes.push(format!(
                        "{}有多份候选，本次用 {}；另外还有 {}",
                        role.label(),
                        chosen.name,
                        others.join("、")
                    ));
                }
            }
        }
        if let Some(found) = &file {
            found_bytes += found.bytes;
            if !found.name.to_lowercase().contains("minimax")
                && !found.name.to_lowercase().contains("h3")
            {
                note = if note.is_empty() {
                    format!("已识别；文件名不含 h3/minimax，建议改名为 {} 更保险", role.suggest().0)
                } else {
                    note
                };
            }
        }
        let (suggest_name, suggest_bytes, url) = role.suggest();
        roles.push(RoleSlot {
            role: role.id().to_string(),
            label: role.label().to_string(),
            required: !matches!(role, VideoRole::AudioVae),
            missing: file.is_none(),
            file,
            suggest_name: suggest_name.to_string(),
            suggest_bytes,
            url: url.to_string(),
            note,
        });
    }
    for (path, bytes) in unknown {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        notes.push(format!(
            "{}（{:.1} GB）没认出来：不像视频四件套里的任何一件，建议改名带上 fl2va / video_vae / audio_vae / qwen 之类的关键词",
            name,
            bytes as f64 / (1024.0 * 1024.0 * 1024.0)
        ));
    }
    ScanReport {
        dir: dir.to_string_lossy().to_string(),
        ready: roles
            .iter()
            .filter(|slot| slot.required)
            .all(|slot| !slot.missing),
        roles,
        notes,
        found_bytes,
    }
}
