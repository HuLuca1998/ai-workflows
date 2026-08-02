//! 出厂的标准工作流：一键初始化 / 重置之后立刻有一批能跑的流程。
//!
//! 图**不写在这里**，取自 `packages/contracts/generated/builtin-workflows.json`
//! —— 那是把内置模板逐条跑 `applyPatch` 算出来的。手抄进 SQL 会与模板
//! 悄悄分叉：模板改了节点，种子还是老样子，而没有任何东西会红。
//! 走生成物则由 `pnpm contracts:check` 守着。
//!
//! ## 两条刻意的决定
//!
//! **一、id 写死成 `workflow:<模板 id>`。** 重装或重置之后
//! 「Issue 修复」指的还是同一条 —— 文档、截图、别的工作流里的
//! 子调用引用都不会失效。子工作流模板正是靠这一点才引用得到别的内置流程。
//!
//! **二、同时建草稿与发布版本。** 只建草稿的话，定时触发的那几条
//! 出厂就不会跑（调度器只看已发布版本），而用户完全不知道还要先发布一次。

use rusqlite::Connection;

use crate::Result;

const BUILTINS: &str = include_str!("../../../packages/contracts/generated/builtin-workflows.json");

/// 生成物的形状。多余字段忽略。
#[derive(serde::Deserialize)]
struct Builtin {
    id: String,
    name: String,
    graph: serde_json::Value,
}

fn parse() -> Result<Vec<Builtin>> {
    serde_json::from_str(BUILTINS).map_err(|error| {
        crate::StoreError::Invalid(format!(
            "内置工作流的生成物读不动：{error}。跑 pnpm contracts:gen"
        ))
    })
}

/// 种下全部内置工作流。调用方保证「只种一次」（`seed.rs` 的批次记账）。
pub(crate) fn seed_builtin_workflows(conn: &Connection) -> Result<()> {
    let now = crate::now_iso();
    for wf in parse()? {
        // 已经在了就跳过。用户可能删掉过某一条 —— 那时这个批次
        // 早已记账，不会重跑；这里的判断是给「同一批次里部分失败后重来」用的
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM workflow WHERE id = ?1",
            rusqlite::params![wf.id],
            |row| row.get(0),
        )?;
        if exists > 0 {
            continue;
        }

        conn.execute(
            "INSERT INTO workflow (id, name, folder, created_at, updated_at, archived)
             VALUES (?1, ?2, '标准工作流', ?3, ?3, 0)",
            rusqlite::params![wf.id, wf.name, now],
        )?;
        // rev 从 1 起：与 create_workflow 一致，编辑器读的是最大 rev
        let graph = wf.graph.to_string();
        conn.execute(
            "INSERT INTO workflow_revision (workflow_id, rev, graph_json, updated_at)
             VALUES (?1, 1, ?2, ?3)",
            rusqlite::params![wf.id, graph, now],
        )?;
        // 同时发布 v1 —— 定时触发只跑已发布版本
        conn.execute(
            "INSERT INTO workflow_version
               (id, workflow_id, version, graph_json, config_hash,
                dependency_manifest_json, published_at, published_by)
             VALUES (?1, ?2, 1, ?3, ?4, '{}', ?5, 'system')",
            rusqlite::params![
                format!("version:{}", wf.id),
                wf.id,
                graph,
                crate::hash_hex(&graph),
                now
            ],
        )?;
    }
    Ok(())
}
