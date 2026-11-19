//! 图像预处理：rembg 的 u2net 抠图 → recenter 居中放大 85% → 512×512 → [-1,1]。
//!
//! 与 hy3dgen 的 ImageProcessorV2 对齐（border_ratio 0.15）：
//! u2net 用 320×320、除以整图最大通道值后做 ImageNet 归一化，输出 min-max 拉伸成灰 mask；
//! recenter 按 mask 包围盒裁切、等比放到 85%、白底合成，最后图片用三次插值、
//! mask 用最近邻放大到 512。

use image::{imageops::FilterType, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

pub fn u2net_mask(sess: &mut Session, rgb: &RgbImage) -> Result<Vec<u8>, String> {
    let w0 = rgb.width() as usize;
    let h0 = rgb.height() as usize;
    let small = image::imageops::resize(rgb, 320, 320, FilterType::Lanczos3);
    let mut maxv = 1e-6f32;
    for p in small.pixels() {
        let m = (p[0].max(p[1]).max(p[2])) as f32;
        if m > maxv {
            maxv = m;
        }
    }
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    let mut chw = vec![0f32; 3 * 320 * 320];
    for y in 0..320usize {
        for x in 0..320usize {
            let p = small.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                chw[c * 320 * 320 + y * 320 + x] = ((p[c] as f32 / maxv) - mean[c]) / std[c];
            }
        }
    }
    let t = Tensor::from_array(([1usize, 3, 320, 320], chw)).map_err(|e| e.to_string())?;
    let outs = sess
        .run(ort::inputs!["input.1" => t])
        .map_err(|e| format!("抠图推理失败：{e}"))?;
    let (_, pred) = outs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("抠图输出异常：{e}"))?;
    if pred.len() != 320 * 320 {
        return Err("抠图输出尺寸异常".to_string());
    }
    let mut mn = f32::MAX;
    let mut mx = f32::MIN;
    for &v in pred.iter() {
        mn = mn.min(v);
        mx = mx.max(v);
    }
    let scale = 1.0 / (mx - mn + 1e-12);
    let mut g = image::GrayImage::new(320, 320);
    for y in 0..320usize {
        for x in 0..320usize {
            let v = ((pred[y * 320 + x] - mn) * scale).clamp(0.0, 1.0);
            g.put_pixel(x as u32, y as u32, image::Luma([(v * 255.0) as u8]));
        }
    }
    let full = image::imageops::resize(&g, w0 as u32, h0 as u32, FilterType::Lanczos3);
    Ok(full.into_raw())
}

pub struct Prepared {
    /// [3,512,512] / 255*2-1
    pub image: Vec<f32>,
    /// [1,512,512] / 255*2-1
    pub mask: Vec<f32>,
}

pub fn preprocess(sess: &mut Session, path: &std::path::Path) -> Result<Prepared, String> {
    let dynimg = image::open(path).map_err(|e| format!("读不了这张图：{e}"))?;
    let rgb = dynimg.to_rgb8();
    let (w0, h0) = rgb.dimensions();
    let (w0, h0) = (w0 as usize, h0 as usize);
    let mask = u2net_mask(sess, &rgb)?;

    let mut x_min = usize::MAX;
    let mut x_max = 0usize;
    let mut y_min = usize::MAX;
    let mut y_max = 0usize;
    for y in 0..h0 {
        for x in 0..w0 {
            if mask[y * w0 + x] > 0 {
                x_min = x_min.min(y);
                x_max = x_max.max(y);
                y_min = y_min.min(x);
                y_max = y_max.max(x);
            }
        }
    }
    if x_min > x_max || y_min > y_max {
        return Err("图片里没找到主体，换一张主体清楚的图再试".to_string());
    }

    let size = h0.max(w0);
    let desired = (size as f32 * 0.85) as usize;
    let h = x_max - x_min;
    let w = y_max - y_min;
    let scale = desired as f32 / h.max(w).max(1) as f32;
    let h2 = (h as f32 * scale) as usize;
    let w2 = (w as f32 * scale) as usize;
    let x2_min = (size - h2) / 2;
    let y2_min = (size - w2) / 2;

    let mut result =
        image::RgbaImage::from_pixel(size as u32, size as u32, image::Rgba([255, 255, 255, 255]));
    let crop_w = (y_max - y_min).max(1);
    let crop_h = (x_max - x_min).max(1);
    let mut crop = image::RgbaImage::new(crop_w as u32, crop_h as u32);
    for y in 0..crop_h {
        for x in 0..crop_w {
            let p = rgb.get_pixel((y_min + x) as u32, (x_min + y) as u32);
            let a = mask[(x_min + y) * w0 + y_min + x];
            crop.put_pixel(x as u32, y as u32, image::Rgba([p[0], p[1], p[2], a]));
        }
    }
    let scaled = image::imageops::resize(
        &crop,
        w2.max(1) as u32,
        h2.max(1) as u32,
        FilterType::Lanczos3,
    );
    for y in 0..h2 {
        for x in 0..w2 {
            let p = scaled.get_pixel(x as u32, y as u32);
            let a = p[3] as f32 / 255.0;
            let r = (p[0] as f32 * a + 255.0 * (1.0 - a)).clamp(0.0, 255.0) as u8;
            let g = (p[1] as f32 * a + 255.0 * (1.0 - a)).clamp(0.0, 255.0) as u8;
            let b = (p[2] as f32 * a + 255.0 * (1.0 - a)).clamp(0.0, 255.0) as u8;
            result.put_pixel(
                (y2_min + x) as u32,
                (x2_min + y) as u32,
                image::Rgba([r, g, b, 255]),
            );
        }
    }
    let mut mask_small = image::GrayImage::new(size as u32, size as u32);
    for y in 0..h2 {
        for x in 0..w2 {
            let a = scaled.get_pixel(x as u32, y as u32)[3];
            mask_small.put_pixel((y2_min + x) as u32, (x2_min + y) as u32, image::Luma([a]));
        }
    }
    let img512 = image::imageops::resize(&result, 512, 512, FilterType::CatmullRom);
    let msk512 = image::imageops::resize(&mask_small, 512, 512, FilterType::Nearest);

    let mut image_chw = vec![0f32; 3 * 512 * 512];
    let mut mask_chw = vec![0f32; 512 * 512];
    for y in 0..512usize {
        for x in 0..512usize {
            let p = img512.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                image_chw[c * 512 * 512 + y * 512 + x] = p[c] as f32 / 255.0 * 2.0 - 1.0;
            }
            mask_chw[y * 512 + x] = msk512.get_pixel(x as u32, y as u32)[0] as f32 / 255.0 * 2.0 - 1.0;
        }
    }
    Ok(Prepared {
        image: image_chw,
        mask: mask_chw,
    })
}
