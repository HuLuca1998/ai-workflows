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
struct 示例 {
    name: String,
    graph: serde_json::Value,
}

/// 种下示例工作流。调用方保证「只种一次」（`seed.rs` 的批次记账）。
pub(crate) fn seed_sample(conn: &Connection) -> Result<()> {
    let 数据: 示例 = serde_json::from_str(SAMPLE).map_err(|error| {
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
        rusqlite::params![id, 数据.name, now],
    )?;
    // rev 从 1 起：与 create_workflow 一致，编辑器读的是最大 rev
    conn.execute(
        "INSERT INTO workflow_revision (workflow_id, rev, graph_json, updated_at)
         VALUES (?1, 1, ?2, ?3)",
        rusqlite::params![id, 数据.graph.to_string(), now],
    )?;

    Ok(())
}
