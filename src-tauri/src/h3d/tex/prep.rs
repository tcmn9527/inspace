//! 纹理链的图像预处理：u2net 抠图 → 官方 recenter（alpha 包围盒 + 20% 边距方图）
//! → 512² → alpha 腐蚀 → 白底合成。delight 吃白底 RGB，recorrect 用 alpha 区域统计。

use image::imageops::FilterType;
use ort::session::Session;

use super::mesh::RES;

pub struct Prep {
    /// delight 输入 [3,512,512]，[-1,1]
    pub delight_in: Vec<f32>,
    /// 原图白底像素（[0,1]），recorrect 用
    pub rgb_target: Vec<[f64; 3]>,
    /// 腐蚀后的 alpha（0/255）
    pub alpha: Vec<u8>,
}

pub fn prep_image(img_path: &std::path::Path, u2net: &mut Session) -> Result<Prep, String> {
    let dynimg = image::open(img_path).map_err(|e| format!("读不了这张图：{e}"))?;
    let rgb = dynimg.to_rgb8();
    let mask = super::super::pre::u2net_mask(u2net, &rgb)?;
    let (w0, h0) = rgb.dimensions();

    // recenter：alpha 包围盒 + 20% 边距，居中进方形 RGBA（白 0 alpha）
    let mut min_x = u32::MAX;
    let mut max_x = 0u32;
    let mut min_y = u32::MAX;
    let mut max_y = 0u32;
    let mut any = false;
    for y in 0..h0 {
        for x in 0..w0 {
            if mask[(y * w0 + x) as usize] > 0 {
                any = true;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }
    if !any {
        return Err("图片里没找到主体，换一张主体清楚的图再试".to_string());
    }
    let cw = max_x - min_x + 1;
    let ch = max_y - min_y + 1;
    let bw = (cw as f64 * 0.2) as u32;
    let bh = (ch as f64 * 0.2) as u32;
    let nw = cw + 2 * bw;
    let nh = ch + 2 * bh;
    let side = nw.max(nh);
    let mut square = image::RgbaImage::from_pixel(side, side, image::Rgba([255, 255, 255, 0]));
    let px = (side - nw) / 2 + bw;
    let py = (side - nh) / 2 + bh;
    for y in 0..ch {
        for x in 0..cw {
            let p = rgb.get_pixel(min_x + x, min_y + y);
            let a = mask[((min_y + y) * w0 + min_x + x) as usize];
            square.put_pixel(px + x, py + y, image::Rgba([p[0], p[1], p[2], a]));
        }
    }

    let resized = image::imageops::resize(&square, RES as u32, RES as u32, FilterType::Lanczos3);

    // alpha 腐蚀 3×3 ×1（官方 delight 包装的做法）
    let mut alpha = vec![0u8; RES * RES];
    for y in 0..RES {
        for x in 0..RES {
            let mut m = 255;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let xx = (x as i64 + dx).clamp(0, RES as i64 - 1) as u32;
                    let yy = (y as i64 + dy).clamp(0, RES as i64 - 1) as u32;
                    m = m.min(resized.get_pixel(xx, yy)[3]);
                }
            }
            alpha[y * RES + x] = m;
        }
    }

    let mut delight_in = vec![0f32; 3 * RES * RES];
    let mut rgb_target = vec![[0f64; 3]; RES * RES];
    for i in 0..RES * RES {
        let p = resized.get_pixel((i % RES) as u32, (i / RES) as u32);
        let a = alpha[i] as f64 / 255.0;
        for c in 0..3 {
            rgb_target[i][c] = p[c] as f64 / 255.0 * a + (1.0 - a);
        }
        // 官方把 alpha==0 的像素直接刷白再进模型
        let src = if alpha[i] == 0 { [255u8; 3] } else { [p[0], p[1], p[2]] };
        for c in 0..3 {
            delight_in[c * RES * RES + i] = src[c] as f32 / 255.0 * 2.0 - 1.0;
        }
    }
    Ok(Prep { delight_in, rgb_target, alpha })
}

/// 官方 recorrect：把去光照图的均值方差对齐原图（alpha 区域），效果更差时退回原图。
pub fn recorrect(src: &[[f64; 3]], target: &[[f64; 3]], alpha: &[u8]) -> Vec<[f64; 3]> {
    let mut cnt = 0f64;
    let mut s_mean = [0f64; 3];
    let mut t_mean = [0f64; 3];
    for i in 0..RES * RES {
        if alpha[i] as f64 / 255.0 > 0.5 {
            cnt += 1.0;
            for c in 0..3 {
                s_mean[c] += src[i][c];
                t_mean[c] += target[i][c];
            }
        }
    }
    if cnt < 1.0 {
        return src.to_vec();
    }
    for c in 0..3 {
        s_mean[c] /= cnt;
        t_mean[c] /= cnt;
    }
    let mut s_var = [0f64; 3];
    let mut t_var = [0f64; 3];
    for i in 0..RES * RES {
        if alpha[i] as f64 / 255.0 > 0.5 {
            for c in 0..3 {
                s_var[c] += (src[i][c] - s_mean[c]).powi(2);
                t_var[c] += (target[i][c] - t_mean[c]).powi(2);
            }
        }
    }
    let s_std: Vec<f64> = (0..3).map(|c| (s_var[c] / cnt).sqrt().max(1e-6)).collect();
    let t_std: Vec<f64> = (0..3).map(|c| (t_var[c] / cnt).sqrt()).collect();
    let mut out = vec![[0f64; 3]; RES * RES];
    let mut mse_src = 0f64;
    let mut mse_mod = 0f64;
    for i in 0..RES * RES {
        for c in 0..3 {
            out[i][c] = ((src[i][c] - 0.95 * s_mean[c]) * (t_std[c] / s_std[c]) + 0.95 * t_mean[c])
                .clamp(0.0, 1.0);
        }
        if alpha[i] as f64 / 255.0 > 0.5 {
            for c in 0..3 {
                mse_src += (src[i][c] - target[i][c]).powi(2);
                mse_mod += (out[i][c] - target[i][c]).powi(2);
            }
        }
    }
    if mse_src < mse_mod {
        src.to_vec()
    } else {
        out
    }
}
