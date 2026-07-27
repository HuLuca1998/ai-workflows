//! 存储层契约测试。
//!
//! 数据模型见技术选型 §10。这里守住的不变量：
//! 事件流可信（(run_id, seq) 唯一且连续）、记忆键唯一、大 payload 不入事件表、
//! 断电后能凭检查点恢复。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::{EXPECTED_SCHEMA_VERSION, NewRunEvent, Store};

fn store() -> Store {
    Store::open_in_memory().expect("打开内存库")
}

/// 事件、检查点都挂在真实的 Run 上——外键约束不允许凭空的 run_id。
fn store_with_run() -> (Store, String) {
    let s = store();
    let workflow = s.create_workflow("测试流程", None).expect("建工作流");
    let run = s.create_run_for_test(&workflow).expect("建运行");
    (s, run)
}

#[test]
fn 新库自动迁移到当前版本() {
    let s = store();
    assert_eq!(s.schema_version().unwrap(), EXPECTED_SCHEMA_VERSION);
}

#[test]
fn 迁移是幂等的_重复运行不报错也不重复建表() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");

    let first = Store::open(&path).unwrap();
    let version = first.schema_version().unwrap();
    drop(first);

    let second = Store::open(&path).unwrap();
    assert_eq!(second.schema_version().unwrap(), version);
}

#[test]
fn 落盘库启用_wal_与外键() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("aiwf.sqlite")).unwrap();
    assert_eq!(s.pragma_string("journal_mode").unwrap(), "wal");
    assert_eq!(s.pragma_string("foreign_keys").unwrap(), "1");
}

#[test]
fn 数据模型包含技术选型列出的全部表() {
    let s = store();
    for table in [
        "workflow",
        "workflow_revision",
        "workflow_version",
        "node_definition",
        "agent_profile",
        "prompt",
        "model",
        "run",
        "run_event",
        "run_checkpoint",
        "artifact",
        "approval",
        "memory",
        "credential_ref",
    ] {
        assert!(s.table_exists(table).unwrap(), "缺少表 {table}");
    }
}

// ── M0 出口标准：能创建空工作流并持久化 ────────────────────────────────────

#[test]
fn 创建空工作流并持久化() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");

    let id = {
        let s = Store::open(&path).unwrap();
        let id = s
            .create_workflow("GitHub Issue 修复", Some("工作区"))
            .unwrap();
        // 新建即带 rev 0 的空草稿，画布打开就能编辑
        assert_eq!(s.draft_revision(&id).unwrap(), Some(0));
        id
    };

    let reopened = Store::open(&path).unwrap();
    let workflow = reopened
        .get_workflow(&id)
        .unwrap()
        .expect("工作流应当已持久化");
    assert_eq!(workflow.name, "GitHub Issue 修复");
    assert_eq!(reopened.list_workflows().unwrap().len(), 1);
}

#[test]
fn 草稿修订号单调递增() {
    let s = store();
    let id = s.create_workflow("流程", None).unwrap();

    let rev1 = s
        .save_draft(&id, r#"{"nodes":[],"edges":[],"groups":[]}"#)
        .unwrap();
    let rev2 = s
        .save_draft(&id, r#"{"nodes":[],"edges":[],"groups":[]}"#)
        .unwrap();
    assert_eq!(rev1, 1);
    assert_eq!(rev2, 2);
    assert_eq!(s.draft_revision(&id).unwrap(), Some(2));
}

#[test]
fn 发布产生不可变版本快照() {
    let s = store();
    let id = s.create_workflow("流程", None).unwrap();
    s.save_draft(&id, r#"{"nodes":[],"edges":[],"groups":[]}"#)
        .unwrap();

    let v1 = s.publish(&id, 1, "你").unwrap();
    assert_eq!(v1.version, 1);
    assert!(!v1.config_hash.is_empty());

    // 再改草稿不影响已发布快照
    s.save_draft(&id, r#"{"nodes":[{"id":"n1"}],"edges":[],"groups":[]}"#)
        .unwrap();
    let snapshot = s.get_version(&v1.id).unwrap().unwrap();
    assert_eq!(
        snapshot.graph_json,
        r#"{"nodes":[],"edges":[],"groups":[]}"#
    );

    let v2 = s.publish(&id, 2, "你").unwrap();
    assert_eq!(v2.version, 2);
}

// ── 事件流 ──────────────────────────────────────────────────────────────────

fn event(run_id: &str, kind: &str, summary: &str) -> NewRunEvent {
    NewRunEvent {
        run_id: run_id.to_string(),
        kind: kind.to_string(),
        node_id: None,
        attempt: None,
        actor: "engine".to_string(),
        status: None,
        summary: summary.to_string(),
        payload_ref: None,
        artifact_refs: vec![],
        parent_event_id: None,
        sensitivity: "internal".to_string(),
        schema_ver: 1,
    }
}

#[test]
fn 事件_seq_由存储分配且连续() {
    let (s, run) = store_with_run();

    let a = s.append_event(&event(&run, "run.started", "开始")).unwrap();
    let b = s.append_event(&event(&run, "node.queued", "排队")).unwrap();
    let c = s
        .append_event(&event(&run, "node.started", "执行"))
        .unwrap();
    assert_eq!((a.seq, b.seq, c.seq), (1, 2, 3));
}

#[test]
fn 同一_run_内_seq_唯一_重复插入被数据库拒绝() {
    let (s, run) = store_with_run();
    s.append_event(&event(&run, "run.started", "开始")).unwrap();

    let err = s.force_insert_event_seq(&run, 1).unwrap_err();
    assert!(
        err.to_string().contains("UNIQUE"),
        "应触发唯一约束，实际：{err}"
    );
}

#[test]
fn 事件按游标分页读取() {
    let (s, run) = store_with_run();
    for i in 0..10 {
        s.append_event(&event(&run, "script.stdout", &format!("第 {i} 行")))
            .unwrap();
    }

    let page = s.events(&run, 0, 4).unwrap();
    assert_eq!(page.len(), 4);
    assert_eq!(page[0].seq, 1);

    let next = s.events(&run, 4, 4).unwrap();
    assert_eq!(next[0].seq, 5);
}

#[test]
fn 事件只存摘要与引用_超长摘要被拒绝() {
    let (s, run) = store_with_run();
    let huge = "x".repeat(2001);

    let err = s
        .append_event(&event(&run, "script.stdout", &huge))
        .unwrap_err();
    assert!(
        err.to_string().contains("摘要"),
        "超长摘要必须落 artifact 后用 payload_ref 指过去，实际：{err}"
    );
}

#[test]
fn 事件外键指向真实的_run() {
    let s = store();
    let err = s
        .append_event(&event("run_不存在", "run.started", "开始"))
        .unwrap_err();
    assert!(
        err.to_string().to_uppercase().contains("FOREIGN KEY"),
        "实际：{err}"
    );
}

// ── 检查点与恢复 ───────────────────────────────────────────────────────────

#[test]
fn 检查点可覆盖写入_恢复时取最新一条() {
    let (s, run) = store_with_run();
    s.append_event(&event(&run, "run.started", "开始")).unwrap();
    s.save_checkpoint(&run, 1, r#"{"env":{}}"#, None).unwrap();
    s.append_event(&event(&run, "node.waiting", "等审批"))
        .unwrap();
    s.save_checkpoint(&run, 2, r#"{"env":{"A":"1"}}"#, Some(r#"{"nodeId":"n7"}"#))
        .unwrap();

    let checkpoint = s.latest_checkpoint(&run).unwrap().expect("应有检查点");
    assert_eq!(checkpoint.seq, 2);
    assert_eq!(
        checkpoint.pending_approval_json.as_deref(),
        Some(r#"{"nodeId":"n7"}"#)
    );
}

// ── 记忆 ────────────────────────────────────────────────────────────────────

#[test]
fn 记忆在同一作用域内_key_唯一() {
    let s = store();
    s.upsert_memory("workflow", Some("wf_1"), "保留 worktree", "直到 PR 合并")
        .unwrap();
    s.upsert_memory("workflow", Some("wf_1"), "保留 worktree", "改成合并后清理")
        .unwrap();

    let items = s.list_memory("workflow", Some("wf_1")).unwrap();
    assert_eq!(items.len(), 1, "同一 key 应更新而不是新增");
    assert_eq!(items[0].value, "改成合并后清理");
    assert_eq!(items[0].ver, 2, "每次更新生成新版本");

    // 不同作用域互不干扰
    s.upsert_memory("global", None, "保留 worktree", "全局偏好")
        .unwrap();
    assert_eq!(s.list_memory("global", None).unwrap().len(), 1);
}

// ── 全文检索 ────────────────────────────────────────────────────────────────

#[test]
fn fts5_索引覆盖事件摘要与工作流名称() {
    let s = store();
    let wf = s.create_workflow("错误日志归因", None).unwrap();
    let run = s.create_run_for_test(&wf).unwrap();
    s.append_event(&event(
        &run,
        "node.failed",
        "parse: unexpected end of stream",
    ))
    .unwrap();

    let hits = s.search("unexpected").unwrap();
    assert!(
        hits.iter().any(|h| h.kind == "run_event"),
        "事件摘要应可检索"
    );

    let wf_hits = s.search("归因").unwrap();
    assert!(
        wf_hits.iter().any(|h| h.kind == "workflow"),
        "工作流名称应可检索"
    );
}

#[test]
fn 删除工作流会连带清理其运行与事件() {
    let s = store();
    let wf = s.create_workflow("临时流程", None).unwrap();
    let run = s.create_run_for_test(&wf).unwrap();
    s.append_event(&event(&run, "run.started", "开始")).unwrap();

    s.delete_workflow(&wf).unwrap();
    assert!(s.get_workflow(&wf).unwrap().is_none());
    assert!(
        s.events(&run, 0, 10).unwrap().is_empty(),
        "级联删除应清掉事件"
    );
}
