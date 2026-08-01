//! 迁移。
//!
//! 规则：迁移只增不改。已发布的迁移文件是历史事实，改动它会让老库与新库分叉；
//! 需要调整就追加一个新版本。

use rusqlite::Connection;

use crate::Result;

/// 当前 schema 版本。新增迁移时同时更新这里与 `MIGRATIONS`。
pub const EXPECTED_SCHEMA_VERSION: i64 = 16;

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
    (
        8,
        "工作区设置",
        include_str!("sql/008_workspace_setting.sql"),
    ),
    (
        9,
        "提示词版本历史",
        include_str!("sql/009_prompt_version.sql"),
    ),
    (
        10,
        "MCP 写操作的确认队列",
        include_str!("sql/010_mcp_confirmation.sql"),
    ),
    (
        11,
        "一次性引导数据的记账表",
        include_str!("sql/011_bootstrap.sql"),
    ),
    (
        12,
        "FTS 级联删除走索引，不再全表扫",
        include_str!("sql/012_fts_ref_index.sql"),
    ),
    (
        13,
        "清掉 provider.api 的残留",
        include_str!("sql/013_drop_provider_api.sql"),
    ),
    (
        14,
        "Agent 向用户提问，回答与确认共用一条队列",
        include_str!("sql/014_ask_user.sql"),
    ),
    (
        15,
        "运行记下触发来源，调度器据此不重复触发",
        include_str!("sql/015_run_trigger.sql"),
    ),
    (
        16,
        "事件记下节点的出口端口，端口路由据此生效",
        include_str!("sql/016_event_exit_port.sql"),
    ),
];

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    migrate_up_to(conn, EXPECTED_SCHEMA_VERSION)
}

/// 迁到指定版本为止。生产只用 [`migrate`]（迁到最新）；
/// 停在中间版本这条路是给测试用的 —— 「从旧 schema 向前迁」
/// 必须在**有数据**的库上验过，而从空库直上最新版那条路径
/// 永远碰不到「已有行遇上新列」这件事。
pub(crate) fn migrate_up_to(conn: &Connection, target: i64) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migration (
           version    INTEGER PRIMARY KEY,
           note       TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );",
    )?;

    let current = current_version(conn)?;

    // 库比这个二进制还新 —— **明确报错，不要静默跳过**。
    //
    // 原来只有 `if version <= current { continue }`，只往上看不往下看：
    // 老二进制打开新库时全部跳过、返回 Ok。而迁移只增不改、SELECT 又都是
    // 显式列名，新库对老二进制是个超集，第一条查询不会报错 ——
    // 失败是无声的数据分叉。实测症状：降级期间建的角色 created_at 是空串，
    // 而回填那条迁移早已记账、再也不会跑，于是它们被
    // `ORDER BY updated_at DESC` 永久钉在最后一页。
    if current > EXPECTED_SCHEMA_VERSION {
        return Err(crate::StoreError::Invalid(format!(
            "这个工作区是更新版本的应用建的（schema v{current}，本版只认到              v{EXPECTED_SCHEMA_VERSION}）。请升级应用后再打开 ——              用旧版继续写会让两边的数据对不上，而且不会有任何报错"
        )));
    }

    for (version, note, sql) in MIGRATIONS {
        if *version > target {
            break;
        }
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
