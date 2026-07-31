//! 示例工作流：一键初始化之后立刻有一条能点开的东西。
//!
//! 图**不写在这里**，取自 `packages/contracts/generated/sample-workflow.json` ——
//! 那是把内置模板（`templates.ts` 的 `github-issue-fix`）跑一遍 applyPatch
//! 算出来的。手抄一份进 SQL 会与模板悄悄分叉：模板改了节点，示例还是老样子，
//! 而没有任何东西会红。走生成物则由 `pnpm contracts:check` 守着。
//!
//! 为什么不在 SQL 种子里直接 INSERT：`graph_json` 是一大段 JSON，
//! 塞进 `.sql` 就等于把生成物抄进源码 —— 正是上面要避免的那件事。

use rusqlite::Connection;

use crate::Result;

const SAMPLE: &str = include_str!("../../../packages/contracts/generated/sample-workflow.json");

/// 生成物的形状。只取要用的两个字段，多余的忽略。
#[derive(serde::Deserialize)]
struct Sample {
    name: String,
    graph: serde_json::Value,
}

/// 种下示例工作流。调用方保证「只种一次」（`seed.rs` 的批次记账）。
pub(crate) fn seed_sample(conn: &Connection) -> Result<()> {
    let data: Sample = serde_json::from_str(SAMPLE).map_err(|error| {
        crate::StoreError::Invalid(format!(
            "示例工作流的生成物读不动：{error}。跑 pnpm contracts:gen"
        ))
    })?;

    let now = crate::now_iso();
    // id 写死：与内置角色同样的理由 —— 重装或重置之后，
    // 「示例工作流」指的还是同一条，文档与截图里的链接不会失效
    let id = "workflow:sample";

    conn.execute(
        "INSERT INTO workflow (id, name, folder, created_at, updated_at, archived)
         VALUES (?1, ?2, NULL, ?3, ?3, 0)",
        rusqlite::params![id, data.name, now],
    )?;
    // rev 从 1 起：与 create_workflow 一致，编辑器读的是最大 rev
    conn.execute(
        "INSERT INTO workflow_revision (workflow_id, rev, graph_json, updated_at)
         VALUES (?1, 1, ?2, ?3)",
        rusqlite::params![id, data.graph.to_string(), now],
    )?;

    Ok(())
}

/// `sample.v1-fix`：把「从未被用户动过」的坏样例修到与新种子同一个终点。
///
/// 老种子的 `read_issue` 脚本写的是 `"$ISSUE"` 环境变量（引擎注入的叫
/// `AIWF_*`），一跑就 `invalid issue format: ""`。模板与生成物早已修好，
/// 但「只种一次」让老工作区永远留着坏的。
///
/// 判据从紧，两条都满足才动：
/// 1. 只有种子那一版（rev 1 且再无别版）—— 用户存过任何一版就不碰；
/// 2. 那一版还带着坏脚本的标记 —— 已经被别的途径修过就不重复改。
/// 用户删掉的也不复活（查不到行自然什么都不做）。
pub(crate) fn fix_sample(conn: &Connection) -> Result<()> {
    let broken_marker = r#"view \"$ISSUE\""#;

    let state: Option<(i64, String)> = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM workflow_revision WHERE workflow_id='workflow:sample'),
                    graph_json
             FROM workflow_revision
             WHERE workflow_id='workflow:sample' AND rev = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;

    let Some((rev_count, graph)) = state else {
        return Ok(());
    };
    if rev_count != 1 || !graph.contains(broken_marker) {
        return Ok(());
    }

    let data: Sample = serde_json::from_str(SAMPLE).map_err(|error| {
        crate::StoreError::Invalid(format!(
            "示例工作流的生成物读不动：{error}。跑 pnpm contracts:gen"
        ))
    })?;
    conn.execute(
        "UPDATE workflow_revision SET graph_json = ?1, updated_at = ?2
         WHERE workflow_id='workflow:sample' AND rev = 1",
        rusqlite::params![data.graph.to_string(), crate::now_iso()],
    )?;
    Ok(())
}
