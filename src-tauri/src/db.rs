//! SQLite 只存应用配置：数据根目录一条 key/value。
//!
//! 用户内容全在磁盘上：笔记是 .md 树，每个空间一个文件夹；
//! 旧版本把便签/待办放在这张库的表里，那张表和它的升级语句一并下线了，
//! 留下的 `stickies/`、`todos/` 目录由 `store::migrate` 送进系统回收站。

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
    Ok(DbState(Mutex::new(conn)))
}
