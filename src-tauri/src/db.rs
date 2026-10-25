//! SQLite 只存应用配置：笔记根目录、数据目录、迁移标记。
//!
//! 便签/待办是文件（见 store.rs），笔记是磁盘上的 .md，画布是 items.json；
//! 旧版本把便签/待办放在这张库的 sticky_note / todo 表里，store::migrate
//! 会在首次启动时把它们导出成 JSON 并清空，表结构只为兼容旧库保留升级语句。

use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;

-- 应用级配置，key/value 都是纯文本
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// 托管进 Tauri 状态的数据库连接；命令都通过它访问配置。
pub struct DbState(pub Mutex<Connection>);

/// 读取一条应用配置；没有就返回 None。
pub fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM setting WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// 写入（或覆盖）一条应用配置。
pub fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| format!("保存设置失败：{e}"))
}

/// 打开（必要时创建）数据库并把表结构准备好。不做任何种子数据。
pub fn init_state(dir: PathBuf) -> Result<DbState, String> {
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
    let conn = Connection::open(dir.join("workbench.db"))
        .map_err(|e| format!("无法打开数据库 {}：{e}", dir.display()))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("初始化表结构失败：{e}"))?;
    /* 旧库的便签表是逐版加列的，迁移读整行前先补齐；新库没有这张表，
       「表不存在」的报错直接吞掉即可。 */
    for sql in [
        "ALTER TABLE sticky_note ADD COLUMN text_color TEXT NOT NULL DEFAULT '#000000';",
        "ALTER TABLE sticky_note ADD COLUMN width INTEGER;",
        "ALTER TABLE sticky_note ADD COLUMN height INTEGER;",
    ] {
        let _ = conn.execute_batch(sql);
    }
    Ok(DbState(Mutex::new(conn)))
}
