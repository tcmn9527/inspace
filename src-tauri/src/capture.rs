//! 落图抓屏：把窗口当前画面画成 PNG，裁出客户区。
//! 屏幕上的 DOM 文本由 Windows 用 ClearType 渲染；离屏光栅化（SVG/canvas）
//! 只有灰度抗锯齿，笔画会显粗。要「和屏幕完全一致」只能直接读窗口像素。
//!
//! 注意用整窗抓取（PW_RENDERFULLCONTENT，不带 PW_CLIENTONLY）：
//! 只抓客户区时 WebView2 交的是缩放过的表面，字会糊一层。

use std::ffi::c_void;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageEncoder;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
    GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    HBITMAP, HDC, HGDIOBJ,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect, PW_RENDERFULLCONTENT};

#[tauri::command]
pub async fn webview_capture(window: tauri::WebviewWindow) -> Result<String, String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    /* HWND 是裸指针，不能跨线程；转成 isize 带过去再还原 */
    let handle = hwnd.0 as isize;
    tauri::async_runtime::spawn_blocking(move || capture(HWND(handle as *mut c_void)))
        .await
        .map_err(|error| error.to_string())?
}

fn capture(hwnd: HWND) -> Result<String, String> {
    unsafe {
        let mut client = RECT::default();
        GetClientRect(hwnd, &mut client).map_err(|error| error.to_string())?;
        let width = client.right - client.left;
        let height = client.bottom - client.top;
        if width <= 0 || height <= 0 {
            return Err("窗口客户区是空的".to_string());
        }

        let mut outer = RECT::default();
        GetWindowRect(hwnd, &mut outer).map_err(|error| error.to_string())?;
        let outer_w = outer.right - outer.left;
        let outer_h = outer.bottom - outer.top;
        let mut origin = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return Err("换算客户区原点失败".to_string());
        }
        let offset_x = origin.x - outer.left;
        let offset_y = origin.y - outer.top;

        let screen = GetDC(Some(hwnd));
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, outer_w, outer_h);
        if screen.is_invalid() || memory.is_invalid() || bitmap.is_invalid() {
            return Err("建不了抓屏用的位图".to_string());
        }
        let old = SelectObject(memory, HGDIOBJ(bitmap.0));

        let printed = PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
        let result = if printed {
            read_client_png(
                memory, bitmap, outer_w, outer_h, offset_x, offset_y, width, height,
            )
        } else {
            Err("窗口画面没抓下来".to_string())
        };

        SelectObject(memory, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory);
        ReleaseDC(Some(hwnd), screen);
        result
    }
}

#[allow(clippy::too_many_arguments)]
fn read_client_png(
    memory: HDC,
    bitmap: HBITMAP,
    outer_w: i32,
    outer_h: i32,
    offset_x: i32,
    offset_y: i32,
    width: i32,
    height: i32,
) -> Result<String, String> {
    unsafe {
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: outer_w,
            biHeight: -outer_h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut window_pixels = vec![0u8; outer_w as usize * outer_h as usize * 4];
        let lines = GetDIBits(
            memory,
            bitmap,
            0,
            outer_h as u32,
            Some(window_pixels.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            return Err("读不出抓屏像素".to_string());
        }

        /* 把客户区从整窗里抠出来 */
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        for row in 0..height as usize {
            let src = ((offset_y as usize + row) * outer_w as usize + offset_x as usize) * 4;
            let dst = row * width as usize * 4;
            let span = width as usize * 4;
            pixels[dst..dst + span].copy_from_slice(&window_pixels[src..src + span]);
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }

        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                &pixels,
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| error.to_string())?;
        Ok(format!("data:image/png;base64,{}", STANDARD.encode(&png)))
    }
}