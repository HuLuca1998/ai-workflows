//! 迁移。
//!
//! 规则：迁移只增不改。已发布的迁移文件是历史事实，改动它会让老库与新库分叉；
//! 需要调整就追加一个新版本。

use rusqlite::Connection;

use crate::Result;

/// 当前 schema 版本。新增迁移时同时更新这里与 `MIGRATIONS`。
pub const EXPECTED_SCHEMA_VERSION: i64 = 7;

/// (版本号, 说明, SQL)
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "初始 schema", include_str!("sql/001_init.sql")),
    (
        2,
        "run 增加 workdir",
        include_str!("sql/002_run_workdir.sql"),
    ),
    (
        3,
        "model 增加连通性延迟",
        include_str!("sql/003_model_latency.sql"),
    ),
    (
        4,
        "agent_profile 补齐契约字段",
        include_str!("sql/004_agent_profile.sql"),
    ),
    (
        5,
        "run_event 记下节点当时的标题",
        include_str!("sql/005_event_node_label.sql"),
    ),
    (
        6,
        "主管 AI 的会话与消息",
        include_str!("sql/006_supervisor_session.sql"),
    ),
    (
        7,
        "Agent 与模型加时间戳，列表按最近改动排",
        include_str!("sql/007_list_ordering.sql"),
    ),
];

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migration (
           version    INTEGER PRIMARY KEY,
           note       TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );",
    )?;

    let current = current_version(conn)?;
    for (version, note, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        // 每个迁移单独一个事务：失败时不会留下半截 schema
        conn.execute_batch("BEGIN")?;
        let applied = (|| -> Result<()> {
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT INTO schema_migration(version, note, applied_at)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![version, note, crate::now_iso()],
            )?;
            Ok(())
        })();

        match applied {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(error) => {
                conn.execute_batch("ROLLBACK")?;
                return Err(error);
            }
        }
    }

    Ok(())
}

pub(crate) fn current_version(conn: &Connection) -> Result<i64> {
    let version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migration",
        [],
        |row| row.get(0),
    )?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 迁移版本号连续且与常量一致() {
        for (index, (version, _, _)) in MIGRATIONS.iter().enumerate() {
            assert_eq!(*version, index as i64 + 1, "迁移版本号必须从 1 起连续");
        }
        assert_eq!(
            MIGRATIONS.last().map(|m| m.0),
            Some(EXPECTED_SCHEMA_VERSION),
            "EXPECTED_SCHEMA_VERSION 应等于最后一个迁移的版本"
        );
    }
}
