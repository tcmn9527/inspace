mod canvas;
mod capture;
mod cosmos;
mod db;
mod ebook;
mod ffmpeg;
mod imagegen;
mod mcp;
pub mod sdcpp; // 引擎绑定：examples 和后续的生图面板都从这里进
mod store;

use std::sync::Arc;
use tauri::Manager;

/* F10 是 WebView2 的浏览器加速键（菜单栏焦点），页面拿不到它的 keydown。
   在控制器层把这一次拦下来，再通知前端切换软件头部。 */
#[cfg(windows)]
fn listen_f10_toggle(app: &tauri::AppHandle) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2Controller,
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    };
    use webview2_com::AcceleratorKeyPressedEventHandler;

    const VK_F10: u32 = 0x79;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app = tauri::AppHandle::clone(app);
    let _ = window.with_webview(move |platform| {
        let controller = platform.controller();
        let mut token = 0i64;
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
            move |_controller: Option<ICoreWebView2Controller>,
                  args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut key = 0u32;
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                let mut status: COREWEBVIEW2_PHYSICAL_KEY_STATUS = unsafe { std::mem::zeroed() };
                unsafe {
                    args.VirtualKey(&mut key)?;
                    args.KeyEventKind(&mut kind)?;
                    args.PhysicalKeyStatus(&mut status)?;
                    if key == VK_F10 {
                        args.SetHandled(true)?;
                    }
                }
                /* F10 到的是系统键（SYSTEM_KEY_DOWN），不是普通 KEY_DOWN */
                let down = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
                if key == VK_F10 && down && status.RepeatCount <= 1 {
                    let _ = app.emit("inspace:toggle-titlebar", ());
                }
                Ok(())
            },
        ));
        unsafe {
            let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法解析应用数据目录：{e}"))?;
            let db_state = db::init_state(dir.clone())?;
            let store_state = store::init(dir.clone());
            // migrate 顺手把 SQLite 里记的数据根目录同步进 DataRoot 镜像，
            // 之后画布读的是同一个路径
            store::migrate(&db_state, &store_state)?;
            let data_root = store::root_handle(&store_state);
            app.manage(canvas::init(
                data_root.clone(),
                dir.join(store::LEGACY_CANVAS_DIR),
            )?);
            app.manage(data_root.clone());
            // 视频拷贝是后台线程在跑，用 Arc 包一层才既能在命令里读、又能挪进线程
            app.manage(Arc::new(canvas::VideoCopyJobs::default()));
            // 8K 贴图包的下载同样在后台线程跑，取消只改这份共享标志
            app.manage(Arc::new(cosmos::CosmosJobs::default()));
            // 生图引擎：一个常驻 sd_ctx，一次只出一张，空闲几分钟自己放掉
            app.manage(imagegen::init(data_root.clone(), &db_state));
            // 换数据目录的搬运同理：进度在后台线程报，停止只改标志
            app.manage(Arc::new(store::RootMoveJobs::default()));
            app.manage(db_state);
            app.manage(store_state);
            /* MCP 服务跟着应用一起起：端口占不上不影响窗口，错误留给设置页说 */
            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|e| format!("无法解析应用配置目录：{e}"))?;
            app.manage(mcp::start(app.handle().clone(), config_dir));
            match app.get_webview_window("main") {
                Some(w) => {
                    /* 仅开发时按用户记录的布局开窗：左上角 (0,0)、客户区 2723×1200 物理像素。
                       release 打包不编译这段，窗口仍按配置居中。 */
                    #[cfg(debug_assertions)]
                    {
                        let _ = w.set_position(tauri::PhysicalPosition::new(0, 0));
                        let _ = w.set_size(tauri::PhysicalSize::new(2723, 1200));
                    }
                    eprintln!(
                        "[diag] scale_factor={:.3} inner={:?} outer={:?}",
                        w.scale_factor().unwrap_or(1.0),
                        w.inner_size(),
                        w.outer_size()
                    );
                    if let Ok(ms) = app.available_monitors() {
                        for m in ms {
                            eprintln!(
                                "[diag] monitor scale={:.3} size={:?}",
                                m.scale_factor(),
                                m.size()
                            );
                        }
                    }
                }
                None => eprintln!("[diag] no main window in setup"),
            }
            #[cfg(windows)]
            listen_f10_toggle(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store::data_root,
            store::data_pick_root,
            store::data_default_root,
            store::data_stats,
            store::data_set_root,
            store::data_root_cancel,
            store::data_reveal,
            canvas::canvas_list,
            canvas::canvas_tree,
            canvas::canvas_create,
            canvas::canvas_open,
            canvas::canvas_save_items,
            canvas::canvas_search,
            canvas::canvas_save_camera,
            canvas::canvas_rename,
            canvas::canvas_copy,
            canvas::canvas_delete,
            canvas::canvas_group_create,
            canvas::canvas_group_rename,
            canvas::canvas_group_delete,
            canvas::canvas_group_reveal,
            canvas::canvas_save_image,
            canvas::canvas_pick_image,
            canvas::canvas_import_image,
            canvas::canvas_image_url,
            canvas::canvas_open_image,
            canvas::canvas_delete_image,
            canvas::canvas_save_note_image,
            canvas::canvas_read_note_image,
            canvas::canvas_read_note,
            canvas::canvas_write_note,
            canvas::canvas_duplicate_note,
            canvas::canvas_delete_note,
            canvas::canvas_read_picture,
            canvas::canvas_write_picture,
            canvas::canvas_delete_picture,
            canvas::canvas_read_scene,
            canvas::canvas_write_scene,
            canvas::canvas_delete_scene,
            canvas::canvas_read_gen,
            canvas::canvas_write_gen,
            canvas::canvas_delete_gen,
            canvas::canvas_reveal_block,
            canvas::canvas_duplicate_media,
            canvas::canvas_duplicate_picture_image,
            canvas::canvas_save_audio,
            canvas::canvas_pick_audio,
            canvas::canvas_import_audio,
            canvas::canvas_audio_url,
            canvas::canvas_delete_audio,
            canvas::canvas_video_info,
            canvas::canvas_pick_video,
            canvas::canvas_copy_video,
            canvas::canvas_cancel_video_copy,
            canvas::canvas_video_url,
            canvas::canvas_video_probe,
            canvas::canvas_audio_fix,
            canvas::canvas_delete_video,
            canvas::canvas_file_info,
            canvas::canvas_pick_file,
            canvas::canvas_import_file,
            canvas::canvas_copy_file,
            canvas::canvas_file_text,
            canvas::canvas_file_preview,
            canvas::canvas_file_url,
            canvas::canvas_file_body,
            canvas::canvas_file_write_back,
            canvas::canvas_reveal_file,
            canvas::canvas_delete_file,
            canvas::canvas_file_exists,
            canvas::canvas_ebook_info,
            canvas::canvas_ebook_toc,
            canvas::canvas_ebook_chapter,
            canvas::canvas_note_write_back,
            ffmpeg::ffmpeg_status,
            ffmpeg::ffmpeg_reveal,
            cosmos::cosmos_tex_status,
            cosmos::cosmos_tex_upgrade,
            cosmos::cosmos_tex_cancel,
            cosmos::cosmos_tex_reset,
            cosmos::cosmos_tex_read,
            imagegen::gen_status,
            imagegen::gen_models,
            imagegen::gen_models_set,
            imagegen::gen_models_dir_pick,
            imagegen::gen_models_dir_set,
            imagegen::gen_models_reveal,
            imagegen::gen_start,
            imagegen::gen_cancel,
            canvas::canvas_reveal,
            canvas::canvas_image_data,
            canvas::canvas_export_save,
            canvas::canvas_open_export,
            canvas::canvas_export_pick_dir,
            canvas::canvas_export_write,
            capture::webview_capture,
            mcp::mcp_register_tools,
            mcp::mcp_reply,
            mcp::mcp_info,
            mcp::mcp_reset_token
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, _| {});
}
