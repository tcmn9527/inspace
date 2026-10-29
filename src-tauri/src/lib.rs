mod canvas;
mod db;
mod ebook;
mod ffmpeg;
mod mcp;
mod notes;
mod store;

use std::sync::Arc;
use tauri::Manager;

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
            // 之后空间、笔记、便签读的是同一个路径
            store::migrate(&db_state, &store_state)?;
            let data_root = store::root_handle(&store_state);
            app.manage(canvas::init(
                data_root.clone(),
                dir.join(store::LEGACY_CANVAS_DIR),
            )?);
            app.manage(data_root);
            // 视频拷贝是后台线程在跑，用 Arc 包一层才既能在命令里读、又能挪进线程
            app.manage(Arc::new(canvas::VideoCopyJobs::default()));
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
                    /* 仅开发时把窗口钉在屏幕左上角（用户预留的可见区域）。
                       release 打包不编译这段，窗口仍按配置居中。 */
                    #[cfg(debug_assertions)]
                    let _ = w.set_position(tauri::PhysicalPosition::new(0, 0));
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
            notes::notes_dir,
            notes::notes_tree,
            notes::notes_read,
            notes::notes_write,
            notes::notes_create,
            notes::notes_create_dir,
            notes::notes_rename,
            notes::notes_move,
            notes::notes_delete,
            notes::notes_save_image,
            notes::notes_read_image,
            notes::image_read_base64,
            notes::notes_reveal,
            canvas::canvas_list,
            canvas::canvas_create,
            canvas::canvas_open,
            canvas::canvas_save_items,
            canvas::canvas_save_camera,
            canvas::canvas_save_connector,
            canvas::canvas_rename,
            canvas::canvas_delete,
            canvas::canvas_save_image,
            canvas::canvas_pick_image,
            canvas::canvas_import_image,
            canvas::canvas_image_url,
            canvas::canvas_delete_image,
            canvas::canvas_save_note_image,
            canvas::canvas_read_note_image,
            canvas::canvas_read_sticky,
            canvas::canvas_write_sticky,
            canvas::canvas_duplicate_sticky,
            canvas::canvas_delete_sticky,
            canvas::canvas_read_note,
            canvas::canvas_write_note,
            canvas::canvas_duplicate_note,
            canvas::canvas_delete_note,
            canvas::canvas_reveal_block,
            canvas::canvas_duplicate_media,
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
            canvas::canvas_reveal,
            mcp::mcp_register_tools,
            mcp::mcp_reply,
            mcp::mcp_info,
            mcp::mcp_reset_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
