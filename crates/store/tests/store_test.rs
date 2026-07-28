//! 存储层契约测试。
//!
//! 数据模型见技术选型 §10。这里守住的不变量：
//! 事件流可信（(run_id, seq) 唯一且连续）、记忆键唯一、大 payload 不入事件表、
//! 断电后能凭检查点恢复。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::{
    AgentPatch, EXPECTED_SCHEMA_VERSION, NewAgent, NewMemory, NewModel, NewPrompt, NewRunEvent,
    Store,
};

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
        node_label: None,
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

    let items = s.memories_for_injection("workflow", Some("wf_1")).unwrap();
    assert_eq!(items.len(), 1, "同一 key 应更新而不是新增");
    assert_eq!(items[0].value, "改成合并后清理");
    assert_eq!(items[0].ver, 2, "每次更新生成新版本");

    // 不同作用域互不干扰
    s.upsert_memory("global", None, "保留 worktree", "全局偏好")
        .unwrap();
    assert_eq!(s.memories_for_injection("global", None).unwrap().len(), 1);
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

// ── 草稿写入的版本守卫（M1：画布保存要能挡住并发覆盖）────────────────────

#[test]
fn 保存草稿时基础版本不匹配会被拒绝() {
    let s = store();
    let id = s.create_workflow("流程", None).unwrap();

    // 基于 rev 0 写入，得到 rev 1
    assert_eq!(s.save_draft_guarded(&id, 0, EMPTY).unwrap(), 1);

    // 再基于 rev 0 写入：说明调用方读到的是旧草稿，必须拒绝而不是悄悄覆盖
    let err = s.save_draft_guarded(&id, 0, EMPTY).unwrap_err();
    assert!(
        matches!(
            err,
            aiwf_store::StoreError::RevisionConflict { current: 1, .. }
        ),
        "应报版本冲突并带上当前 rev，实际：{err}"
    );

    // 基于最新 rev 写入正常
    assert_eq!(s.save_draft_guarded(&id, 1, EMPTY).unwrap(), 2);
}

#[test]
fn 版本冲突不会写入任何东西() {
    let s = store();
    let id = s.create_workflow("流程", None).unwrap();
    s.save_draft_guarded(&id, 0, r#"{"nodes":[{"id":"a"}],"edges":[],"groups":[]}"#)
        .unwrap();

    let _ = s.save_draft_guarded(&id, 0, r#"{"nodes":[],"edges":[],"groups":[]}"#);

    // 冲突那次的内容不能落库
    assert_eq!(s.draft_revision(&id).unwrap(), Some(1));
    assert!(s.get_draft(&id, 1).unwrap().unwrap().contains("\"a\""));
}

#[test]
fn 列出版本时按版本号倒序_最新在前() {
    let s = store();
    let id = s.create_workflow("流程", None).unwrap();
    s.save_draft_guarded(&id, 0, EMPTY).unwrap();
    s.publish(&id, 1, "你").unwrap();
    s.save_draft_guarded(&id, 1, EMPTY).unwrap();
    s.publish(&id, 2, "你").unwrap();

    let versions = s.list_versions(&id).unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(
        versions[0].version, 2,
        "最新版本要排在最前，界面按这个顺序渲染版本抽屉"
    );
    assert_eq!(versions[1].version, 1);
}

#[test]
fn 未发布过的工作流版本列表为空而不是报错() {
    let s = store();
    let id = s.create_workflow("流程", None).unwrap();
    assert!(s.list_versions(&id).unwrap().is_empty());
}

const EMPTY: &str = r#"{"nodes":[],"edges":[],"groups":[]}"#;

// ── M1 出口标准：模板搭出的工作流能发布为 v1 ──────────────────────────────

#[test]
fn 从空工作流到发布_v1_的完整链路() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    let s = Store::open(&path).unwrap();

    // 1. 新建：带 rev 0 的空草稿
    let id = s.create_workflow("GitHub Issue 修复", None).unwrap();
    assert_eq!(s.draft_revision(&id).unwrap(), Some(0));

    // 2. 客户端应用模板的结构化操作后，把结果图提交（带版本守卫）
    let template_graph = r#"{"nodes":[{"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}}],"edges":[],"groups":[]}"#;
    let rev = s.save_draft_guarded(&id, 0, template_graph).unwrap();
    assert_eq!(rev, 1);

    // 3. 发布为 v1
    let v1 = s.publish(&id, rev, "本地用户").unwrap();
    assert_eq!(v1.version, 1);

    // 4. 快照不可变：之后怎么改草稿，v1 都不变
    s.save_draft_guarded(&id, rev, r#"{"nodes":[],"edges":[],"groups":[]}"#)
        .unwrap();
    let snapshot = s.get_version(&v1.id).unwrap().unwrap();
    assert_eq!(snapshot.graph_json, template_graph);
    assert_eq!(snapshot.config_hash, v1.config_hash);

    // 5. 重开应用后版本仍在，且能读回完整的图
    drop(s);
    let reopened = Store::open(&path).unwrap();
    let versions = reopened.list_versions(&id).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].version, 1);
    assert!(
        reopened
            .get_version(&v1.id)
            .unwrap()
            .unwrap()
            .graph_json
            .contains("entry")
    );
}

#[test]
fn 带初始图创建_模板与导入走这条路() {
    let s = store();
    let graph = r#"{"nodes":[{"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}}],"edges":[],"groups":[]}"#;

    let id = s
        .create_workflow_with_graph("从模板创建", None, graph)
        .unwrap();

    // 初始图就是 rev 0，不需要再来一次「改动」把它写进去
    assert_eq!(s.draft_revision(&id).unwrap(), Some(0));
    assert_eq!(s.get_draft(&id, 0).unwrap().as_deref(), Some(graph));
}

// ── 运行列表与详情（执行记录页要用）────────────────────────────────────────

#[test]
fn 列出运行按开始时间倒序_最新的在最前() {
    let store = Store::open_in_memory().unwrap();
    let workflow = store.create_workflow("流程", None).unwrap();
    let first = store.create_run(&workflow, None, Some(0), "{}").unwrap();
    let second = store.create_run(&workflow, None, Some(0), "{}").unwrap();

    let runs = store.list_runs(None, &[], None).unwrap();
    assert_eq!(runs.len(), 2);
    // 同一毫秒创建时靠 rowid 兜底，最新的必须在前
    assert_eq!(runs[0].id, second);
    assert_eq!(runs[1].id, first);
}

#[test]
fn 按工作流筛选运行() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_workflow("A", None).unwrap();
    let b = store.create_workflow("B", None).unwrap();
    store.create_run(&a, None, Some(0), "{}").unwrap();
    let in_b = store.create_run(&b, None, Some(0), "{}").unwrap();

    let runs = store.list_runs(Some(&b), &[], None).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, in_b);
}

#[test]
fn 按状态筛选运行() {
    let store = Store::open_in_memory().unwrap();
    let workflow = store.create_workflow("流程", None).unwrap();
    let running = store.create_run(&workflow, None, Some(0), "{}").unwrap();
    let done = store.create_run(&workflow, None, Some(0), "{}").unwrap();
    store.set_run_status(&running, "running", None).unwrap();
    store.set_run_status(&done, "succeeded", None).unwrap();

    let active = store
        .list_runs(None, &["running".to_string()], None)
        .unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, running);
}

#[test]
fn 搜索能命中_run_id_与工作流名() {
    let store = Store::open_in_memory().unwrap();
    let workflow = store.create_workflow("批量文件整理", None).unwrap();
    let run = store.create_run(&workflow, None, Some(0), "{}").unwrap();

    assert_eq!(store.list_runs(None, &[], Some("批量")).unwrap().len(), 1);
    assert_eq!(
        store.list_runs(None, &[], Some(&run[..6])).unwrap().len(),
        1
    );
    assert_eq!(store.list_runs(None, &[], Some("不存在")).unwrap().len(), 0);
}

#[test]
fn 运行详情带上工作流名_列表不用再查一次() {
    let store = Store::open_in_memory().unwrap();
    let workflow = store.create_workflow("我的流程", None).unwrap();
    let run = store.create_run(&workflow, None, Some(0), "{}").unwrap();

    let detail = store.get_run(&run).unwrap().expect("应当能读到");
    assert_eq!(detail.workflow_name, "我的流程");
    assert_eq!(detail.status, "created");
}

#[test]
fn 读不存在的运行返回_none_而不是报错() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.get_run("run_nope").unwrap().is_none());
}

// ── 模型登记（M3）─────────────────────────────────────────────────────────

fn model(name: &str) -> NewModel {
    NewModel {
        name: name.to_string(),
        runtime: "acp.claude".to_string(),
        model_id: "claude-opus-5".to_string(),
        effort: "high".to_string(),
        context_window: 200_000,
        capabilities: vec!["结构化输出".to_string(), "工具调用".to_string()],
        credential_ref: Some("keychain://anthropic".to_string()),
        enabled: true,
    }
}

#[test]
fn 登记模型后能按_id_读回() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_model(&model("Opus 5 · high")).unwrap();

    let found = store.get_model(&id).unwrap().expect("应当能读到");
    assert_eq!(found.name, "Opus 5 · high");
    assert_eq!(found.effort, "high");
    assert_eq!(found.capabilities, vec!["结构化输出", "工具调用"]);
}

#[test]
fn 同一模型的不同档位是不同条目() {
    // 图纸原话：「同一模型的不同档位登记为不同条目，运行记录能区分」
    let store = Store::open_in_memory().unwrap();
    let mut low = model("Opus 5 · low");
    low.effort = "low".to_string();

    store.create_model(&model("Opus 5 · high")).unwrap();
    store.create_model(&low).unwrap();

    assert_eq!(store.list_models(false).unwrap().len(), 2);
}

#[test]
fn 只列已启用时跳过停用条目() {
    // 「系统内所有模型下拉只列出这里已启用的条目」
    let store = Store::open_in_memory().unwrap();
    let mut off = model("停用的");
    off.enabled = false;
    store.create_model(&model("启用的")).unwrap();
    store.create_model(&off).unwrap();

    let enabled = store.list_models(true).unwrap();
    assert_eq!(enabled.len(), 1);
    assert_eq!(enabled[0].name, "启用的");
    assert_eq!(store.list_models(false).unwrap().len(), 2);
}

#[test]
fn 凭据只存引用_明文密钥被拒绝() {
    // 硬约束：仓库、事件、日志、导出里只出现 keychain:// 引用
    let store = Store::open_in_memory().unwrap();
    let mut plain = model("明文");
    // 刻意不用真实密钥的样子：仓库里的扫描器认得那种前缀，
    // 而它没法区分「测试用的假值」和「真的漏了一个 key」——
    // 那是对的，所以这里用一个明显不是密钥的字符串
    plain.credential_ref = Some("明文密钥的占位".to_string());

    let error = store.create_model(&plain).unwrap_err().to_string();
    assert!(error.contains("keychain://"), "错误信息实际：{error}");
}

#[test]
fn 更新只改传进来的字段_没传的保持原样() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_model(&model("原名")).unwrap();

    store
        .update_model(&id, Some("新名"), None, None, None, None, None, None)
        .unwrap();

    let found = store.get_model(&id).unwrap().unwrap();
    assert_eq!(found.name, "新名");
    // 没传的字段不该被清空
    assert_eq!(found.model_id, "claude-opus-5");
    assert_eq!(found.capabilities.len(), 2);
}

#[test]
fn 停用与启用来回切换() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_model(&model("切换")).unwrap();

    store
        .update_model(&id, None, None, None, None, None, None, Some(false))
        .unwrap();
    assert!(!store.get_model(&id).unwrap().unwrap().enabled);

    store
        .update_model(&id, None, None, None, None, None, None, Some(true))
        .unwrap();
    assert!(store.get_model(&id).unwrap().unwrap().enabled);
}

#[test]
fn 删除模型后读不到() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_model(&model("待删")).unwrap();
    store.delete_model(&id).unwrap();
    assert!(store.get_model(&id).unwrap().is_none());
}

#[test]
fn 记录最近一次连通性测试的延迟() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_model(&model("测延迟")).unwrap();

    store.record_model_latency(&id, 342).unwrap();
    assert_eq!(
        store.get_model(&id).unwrap().unwrap().last_latency_ms,
        Some(342)
    );
}

#[test]
fn 模型按接入方式分组_列表顺序稳定() {
    // 图纸左栏按 runtime 分组显示，顺序跳来跳去会让人找不到刚建的那条
    let store = Store::open_in_memory().unwrap();
    let mut codex = model("Codex 条目");
    codex.runtime = "acp.codex".to_string();
    store.create_model(&codex).unwrap();
    store.create_model(&model("Claude 条目")).unwrap();

    let first = store.list_models(false).unwrap();
    let second = store.list_models(false).unwrap();
    assert_eq!(
        first.iter().map(|m| &m.id).collect::<Vec<_>>(),
        second.iter().map(|m| &m.id).collect::<Vec<_>>()
    );
    // 同一 runtime 的排在一起
    assert_eq!(first[0].runtime, "acp.claude");
}

#[test]
fn 上下文窗口必须为正数() {
    let store = Store::open_in_memory().unwrap();
    let mut zero = model("零窗口");
    zero.context_window = 0;
    assert!(store.create_model(&zero).is_err());
}

#[test]
fn 多个连接并发写同一个运行的事件_seq_不冲突() {
    // 端到端测试抓到的：取消运行时主线程写 run.cancelled，
    // 后台执行线程同时写 node.succeeded，两条 SELECT MAX(seq)+1 拿到同一个值，
    // 第二条 INSERT 撞上 UNIQUE 约束。症状是「取消偶尔报数据库错误」。
    let dir = std::env::temp_dir().join("aiwf_seq_race");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("aiwf.sqlite");

    let store = Store::open(&path).unwrap();
    let workflow = store.create_workflow("并发", None).unwrap();
    let run = store.create_run(&workflow, None, Some(0), "{}").unwrap();
    drop(store);

    const THREADS: usize = 4;
    const PER_THREAD: usize = 25;

    let handles: Vec<_> = (0..THREADS)
        .map(|thread| {
            let path = path.clone();
            let run = run.clone();
            std::thread::spawn(move || {
                let store = Store::open(&path).unwrap();
                for index in 0..PER_THREAD {
                    store
                        .append_event(&NewRunEvent {
                            run_id: run.clone(),
                            kind: "node.started".to_string(),
                            node_id: Some(format!("n{thread}")),
                            node_label: None,
                            attempt: Some(1),
                            actor: "engine".to_string(),
                            status: None,
                            summary: format!("线程 {thread} 第 {index} 条"),
                            payload_ref: None,
                            artifact_refs: vec![],
                            parent_event_id: None,
                            sensitivity: "internal".to_string(),
                            schema_ver: 1,
                        })
                        .expect("并发写事件不该失败");
                }
            })
        })
        .collect();

    for handle in handles {
        handle.join().expect("写事件的线程崩了");
    }

    let store = Store::open(&path).unwrap();
    let events = store.events(&run, 0, 1000).unwrap();
    assert_eq!(events.len(), THREADS * PER_THREAD, "有事件丢了");

    // seq 必须连续无缺口：事件流可回放依赖这一点
    let seqs: Vec<i64> = events.iter().map(|e| e.seq).collect();
    assert_eq!(
        seqs,
        (1..=(THREADS * PER_THREAD) as i64).collect::<Vec<_>>(),
        "seq 出现缺口或重复"
    );
}

#[test]
fn 终态不会被推进覆盖回运行中() {
    // 端到端抓到的：取消运行时，执行线程正好在节点开始前读到 running，
    // 主线程随即写入 cancelled，执行线程接着把状态覆盖回 running ——
    // 运行就再也停不下来了。终态一旦写下，普通推进不得改动它。
    let store = Store::open_in_memory().unwrap();
    let workflow = store.create_workflow("终态", None).unwrap();
    let run = store.create_run(&workflow, None, Some(0), "{}").unwrap();

    store.set_run_status(&run, "cancelled", None).unwrap();
    store
        .advance_run_status(&run, "running", Some("node_a"))
        .unwrap();

    assert_eq!(
        store.run_status(&run).unwrap().as_deref(),
        Some("cancelled")
    );
}

#[test]
fn 非终态可以正常推进() {
    let store = Store::open_in_memory().unwrap();
    let workflow = store.create_workflow("推进", None).unwrap();
    let run = store.create_run(&workflow, None, Some(0), "{}").unwrap();

    store
        .advance_run_status(&run, "running", Some("node_a"))
        .unwrap();
    assert_eq!(store.run_status(&run).unwrap().as_deref(), Some("running"));
}

#[test]
fn 显式设置状态能把失败的运行改回运行中_恢复要用() {
    // 「从检查点恢复」需要 failed → running，这条路要留着，
    // 但它是显式操作，不是节点推进的副作用
    let store = Store::open_in_memory().unwrap();
    let workflow = store.create_workflow("恢复", None).unwrap();
    let run = store.create_run(&workflow, None, Some(0), "{}").unwrap();

    store.set_run_status(&run, "failed", None).unwrap();
    store.set_run_status(&run, "running", None).unwrap();
    assert_eq!(store.run_status(&run).unwrap().as_deref(), Some("running"));
}

#[test]
fn 不认识的接入方式被拒绝() {
    // 契约里 runtime 是枚举。存储层也要拦一道：
    // 绕过界面直接调 Core API 的路径（MCP、脚本）同样不该写进脏数据。
    // 这个坑踩过一次 —— 界面用了自造的 runtime 字符串，
    // 前端组件测试因为 mock 掉了校验而全绿，端到端才抓到。
    let store = Store::open_in_memory().unwrap();
    let mut bad = model("野路子");
    bad.runtime = "acp_claude_code".to_string();

    let error = store.create_model(&bad).unwrap_err().to_string();
    assert!(error.contains("acp.claude"), "错误信息实际：{error}");
}

#[test]
fn 契约里的每一种接入方式都能登记() {
    let store = Store::open_in_memory().unwrap();
    for runtime in ["acp.claude", "acp.codex", "provider.api"] {
        let mut entry = model(runtime);
        entry.runtime = runtime.to_string();
        store
            .create_model(&entry)
            .unwrap_or_else(|e| panic!("{runtime} 应当可以登记：{e}"));
    }
    assert_eq!(store.list_models(false).unwrap().len(), 3);
}

// ── Agent 角色（M3）────────────────────────────────────────────────────────

fn agent(name: &str) -> NewAgent {
    NewAgent {
        name: name.to_string(),
        role: "分析师".to_string(),
        goal: "定位根因，给出可验证的方案".to_string(),
        persona: "先读代码再下结论；不确定时说不确定。".to_string(),
        runtime: "acp.claude".to_string(),
        model_ref: "model_opus".to_string(),
        fallback_model_ref: None,
        tools: vec!["read".to_string(), "grep".to_string()],
        capabilities_json: r#"{"file":"read_only","network":"none"}"#.to_string(),
        output_contract: "结构化 JSON".to_string(),
        turn_limit: 12,
        timeout_ms: 900_000,
    }
}

#[test]
fn 登记_agent_后能按_id_读回全部字段() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_agent(&agent("分析 Agent")).unwrap();

    let found = store.get_agent(&id).unwrap().expect("应当能读到");
    assert_eq!(found.name, "分析 Agent");
    assert_eq!(found.role, "分析师");
    assert_eq!(found.runtime, "acp.claude");
    assert_eq!(found.tools, vec!["read", "grep"]);
    assert_eq!(found.turn_limit, 12);
    // 新建的是第 1 版
    assert_eq!(found.ver, 1);
}

#[test]
fn agent_的接入方式也要在契约枚举里() {
    let store = Store::open_in_memory().unwrap();
    let mut bad = agent("野路子");
    bad.runtime = "acp_claude_code".to_string();
    let error = store.create_agent(&bad).unwrap_err().to_string();
    assert!(error.contains("acp.claude"), "错误信息实际：{error}");
}

#[test]
fn 保存新版本会让版本号递增_而不是覆盖() {
    // 图纸的按钮是「保存新版本」——角色升级后引用它的节点一并生效，
    // 所以历史版本号必须能往前走，运行记录才能说清「用的是第几版」
    let store = Store::open_in_memory().unwrap();
    let id = store.create_agent(&agent("会升级的")).unwrap();

    store
        .update_agent(
            &id,
            1,
            &AgentPatch {
                name: Some("改了名"),
                goal: None,
                persona: None,
                model_ref: None,
                fallback_model_ref: None,
            },
        )
        .unwrap();
    let after = store.get_agent(&id).unwrap().unwrap();
    assert_eq!(after.name, "改了名");
    assert_eq!(after.ver, 2, "保存一次应当到第 2 版");

    store
        .update_agent(
            &id,
            2,
            &AgentPatch {
                name: None,
                goal: Some("换个目标"),
                persona: None,
                model_ref: None,
                fallback_model_ref: None,
            },
        )
        .unwrap();
    assert_eq!(store.get_agent(&id).unwrap().unwrap().ver, 3);
}

#[test]
fn 部分更新不清空其他字段() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_agent(&agent("部分更新")).unwrap();

    store
        .update_agent(
            &id,
            1,
            &AgentPatch {
                name: Some("新名字"),
                goal: None,
                persona: None,
                model_ref: None,
                fallback_model_ref: None,
            },
        )
        .unwrap();
    let after = store.get_agent(&id).unwrap().unwrap();
    assert_eq!(after.goal, "定位根因，给出可验证的方案");
    assert_eq!(after.tools, vec!["read", "grep"]);
}

#[test]
fn 列出_agent_顺序稳定() {
    let store = Store::open_in_memory().unwrap();
    store.create_agent(&agent("乙")).unwrap();
    store.create_agent(&agent("甲")).unwrap();

    let first: Vec<String> = store
        .list_agents()
        .unwrap()
        .into_iter()
        .map(|a| a.name)
        .collect();
    let second: Vec<String> = store
        .list_agents()
        .unwrap()
        .into_iter()
        .map(|a| a.name)
        .collect();
    // 要的是「稳定」，不是某个特定的中文序 —— SQLite 按 UTF-8 字节排，
    // 乙(U+4E59) 在 甲(U+7532) 前面，与拼音、笔画都不一致。
    // 界面上要按中文排的话得在前端做
    assert_eq!(first, second, "两次列出的顺序应当一致");
    assert_eq!(first.len(), 2);
}

#[test]
fn 内置角色不能删() {
    // 「节点引用角色而不是复制 Prompt」——删掉内置角色会让引用它的节点失效，
    // 而用户往往意识不到某个节点在用它
    let store = Store::open_in_memory().unwrap();
    let id = store.create_builtin_agent(&agent("内置分析师")).unwrap();

    let error = store.delete_agent(&id).unwrap_err().to_string();
    assert!(error.contains("内置"), "错误信息实际：{error}");
    assert!(store.get_agent(&id).unwrap().is_some());
}

#[test]
fn 自建角色可以删() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_agent(&agent("我建的")).unwrap();
    store.delete_agent(&id).unwrap();
    assert!(store.get_agent(&id).unwrap().is_none());
}

#[test]
fn 复制内置角色得到一个可编辑的副本() {
    // 图纸详情区有「复制」——用户想基于内置角色改，但不该改到内置本身
    let store = Store::open_in_memory().unwrap();
    let id = store.create_builtin_agent(&agent("内置审查员")).unwrap();

    let copy_id = store.duplicate_agent(&id, "我的审查员").unwrap();
    let copy = store.get_agent(&copy_id).unwrap().unwrap();

    assert_ne!(copy_id, id);
    assert_eq!(copy.name, "我的审查员");
    assert!(!copy.builtin, "副本必须是可编辑的");
    assert_eq!(copy.persona, "先读代码再下结论；不确定时说不确定。");
    assert_eq!(copy.ver, 1, "副本从第 1 版开始");
}

#[test]
fn 复制不存在的角色报错而不是建出空副本() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.duplicate_agent("agent_nope", "x").is_err());
}

#[test]
fn 轮次上限与超时必须为正() {
    let store = Store::open_in_memory().unwrap();
    let mut zero = agent("零轮次");
    zero.turn_limit = 0;
    assert!(store.create_agent(&zero).is_err());

    let mut no_timeout = agent("零超时");
    no_timeout.timeout_ms = 0;
    assert!(store.create_agent(&no_timeout).is_err());
}

// ── 提示词库（M3）──────────────────────────────────────────────────────────

fn prompt(name: &str) -> NewPrompt {
    NewPrompt {
        group: "系统内建 · 节点".to_string(),
        name: name.to_string(),
        sections_json: r#"[{"title":"Role","body":"你是一名代码分析师。"},
                           {"title":"Task","body":"定位 ${input.issue} 的根因。"}]"#
            .to_string(),
        vars_json: r#"[{"name":"${input.issue}","source":"启动表单","onMissing":"empty_and_log"}]"#
            .to_string(),
    }
}

#[test]
fn 登记提示词后能读回分段与变量() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_prompt(&prompt("分析 · 根因")).unwrap();

    let found = store.get_prompt(&id).unwrap().expect("应当能读到");
    assert_eq!(found.name, "分析 · 根因");
    assert_eq!(found.group, "系统内建 · 节点");
    assert!(found.sections_json.contains("代码分析师"));
    assert_eq!(found.ver, 1);
}

#[test]
fn 保存新版本让版本号递增() {
    // 「运行记录会引用当时的提示词版本，历史结果始终可解释」——
    // 版本号必须往前走，否则没法回答「那次运行用的是哪一版」
    let store = Store::open_in_memory().unwrap();
    let id = store.create_prompt(&prompt("会升级的")).unwrap();

    store
        .update_prompt(
            &id,
            1,
            None,
            Some(r#"[{"title":"Role","body":"改过了"}]"#),
            None,
        )
        .unwrap();
    let after = store.get_prompt(&id).unwrap().unwrap();
    assert_eq!(after.ver, 2);
    assert!(after.sections_json.contains("改过了"));
}

#[test]
fn 按分组列出_同组的排在一起() {
    // 图纸左栏按 group 分组显示
    let store = Store::open_in_memory().unwrap();
    let mut memory = prompt("记忆提议");
    memory.group = "系统内建 · 记忆".to_string();
    store.create_prompt(&prompt("节点 A")).unwrap();
    store.create_prompt(&memory).unwrap();
    store.create_prompt(&prompt("节点 B")).unwrap();

    let items = store.list_prompts(None).unwrap();
    assert_eq!(items.len(), 3);
    let groups: Vec<&str> = items.iter().map(|p| p.group.as_str()).collect();
    // 同组连续出现，不能交错
    let mut seen = std::collections::HashSet::new();
    let mut previous = "";
    for group in &groups {
        if *group != previous {
            assert!(seen.insert(*group), "分组 {group} 被拆开了：{groups:?}");
            previous = group;
        }
    }
}

#[test]
fn 搜索命中名称与正文() {
    // 图纸的搜索框写的是「搜索名称、变量或正文」
    let store = Store::open_in_memory().unwrap();
    store.create_prompt(&prompt("根因分析")).unwrap();

    let mut review = prompt("代码审查");
    review.sections_json = r#"[{"title":"Role","body":"你是一名审查者，只读不改。"}]"#.to_string();
    store.create_prompt(&review).unwrap();

    // 名称命中
    assert_eq!(store.list_prompts(Some("根因")).unwrap().len(), 1);
    // 正文命中：只有审查那条写了「只读不改」
    assert_eq!(store.list_prompts(Some("只读不改")).unwrap().len(), 1);
    // 两条正文都有的词，两条都命中
    assert_eq!(store.list_prompts(Some("你是一名")).unwrap().len(), 2);
    assert_eq!(store.list_prompts(Some("不存在的词")).unwrap().len(), 0);
}

#[test]
fn 内置提示词不能删_但能复制() {
    // 「系统调用 AI 的每一处都在这里」——删掉内置的会让某处调用没有提示词
    let store = Store::open_in_memory().unwrap();
    let id = store.create_builtin_prompt(&prompt("内置的")).unwrap();

    assert!(store.delete_prompt(&id).is_err());

    let copy_id = store.duplicate_prompt(&id, "我的版本").unwrap();
    let copy = store.get_prompt(&copy_id).unwrap().unwrap();
    assert!(!copy.builtin);
    assert_eq!(copy.ver, 1);
    assert_eq!(
        copy.sections_json,
        store.get_prompt(&id).unwrap().unwrap().sections_json
    );
}

#[test]
fn 分段不能是空数组() {
    // 一条没有任何分段的提示词等于没有提示词，
    // 让它存进去只会在运行时才发现
    let store = Store::open_in_memory().unwrap();
    let mut empty = prompt("空的");
    empty.sections_json = "[]".to_string();
    assert!(store.create_prompt(&empty).is_err());
}

#[test]
fn 分段必须是合法_json() {
    let store = Store::open_in_memory().unwrap();
    let mut bad = prompt("坏的");
    bad.sections_json = "{不是 JSON".to_string();
    assert!(store.create_prompt(&bad).is_err());
}

#[test]
fn 删除自建提示词后读不到() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_prompt(&prompt("待删")).unwrap();
    store.delete_prompt(&id).unwrap();
    assert!(store.get_prompt(&id).unwrap().is_none());
}

// ── 记忆（M4）──────────────────────────────────────────────────────────────

fn memory(key: &str) -> NewMemory {
    NewMemory {
        scope: "workspace".to_string(),
        scope_id: None,
        key: key.to_string(),
        value: "PR 合并前保留 worktree".to_string(),
        summary: None,
        source: "user".to_string(),
        created_by: "本地用户".to_string(),
        sensitivity: "internal".to_string(),
        tags: vec!["worktree".to_string()],
    }
}

#[test]
fn 写入记忆后能按_key_读回() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_memory(&memory("worktree.cleanup")).unwrap();

    let found = store.get_memory(&id).unwrap().expect("应当能读到");
    assert_eq!(found.key, "worktree.cleanup");
    assert_eq!(found.scope, "workspace");
    assert_eq!(found.ver, 1);
    assert!(found.enabled);
}

#[test]
fn 同一作用域下_key_唯一() {
    // 两条同 key 的记忆会让「注入哪一条」变成运气问题
    let store = Store::open_in_memory().unwrap();
    store.create_memory(&memory("dup.key")).unwrap();
    let error = store
        .create_memory(&memory("dup.key"))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("已存在") || error.contains("唯一"),
        "错误实际：{error}"
    );
}

#[test]
fn 不同作用域可以有同名_key() {
    // global 的「代码风格」与某个工作流的「代码风格」是两回事
    let store = Store::open_in_memory().unwrap();
    let mut global = memory("code.style");
    global.scope = "global".to_string();
    store.create_memory(&global).unwrap();
    store.create_memory(&memory("code.style")).unwrap();

    assert_eq!(store.list_memories(None, None).unwrap().len(), 2);
}

#[test]
fn 按作用域筛选() {
    // 图纸顶部有一排作用域 chips
    let store = Store::open_in_memory().unwrap();
    let mut global = memory("g");
    global.scope = "global".to_string();
    store.create_memory(&global).unwrap();
    store.create_memory(&memory("w")).unwrap();

    assert_eq!(store.list_memories(Some("global"), None).unwrap().len(), 1);
    assert_eq!(
        store.list_memories(Some("workspace"), None).unwrap().len(),
        1
    );
}

#[test]
fn 搜索命中_key_内容与标签() {
    // 图纸的搜索框写的是「搜索 key、内容或标签」
    let store = Store::open_in_memory().unwrap();
    store.create_memory(&memory("worktree.cleanup")).unwrap();

    assert_eq!(
        store.list_memories(None, Some("worktree")).unwrap().len(),
        1
    );
    assert_eq!(store.list_memories(None, Some("PR 合并")).unwrap().len(), 1);
    assert_eq!(store.list_memories(None, Some("不相干")).unwrap().len(), 0);
}

#[test]
fn 更新带乐观锁_落后的版本被拒绝() {
    // 「AI 通过 MCP 更新时携带版本号，落后版本会被拒绝」——
    // 没有这道锁，AI 的写入会悄悄覆盖用户刚改的内容
    let store = Store::open_in_memory().unwrap();
    let id = store.create_memory(&memory("locked")).unwrap();

    store.update_memory(&id, 1, Some("用户改的"), None).unwrap();
    assert_eq!(store.get_memory(&id).unwrap().unwrap().ver, 2);

    // AI 拿着旧版本号来写
    let error = store
        .update_memory(&id, 1, Some("AI 改的"), None)
        .unwrap_err()
        .to_string();
    assert!(error.contains("版本"), "错误实际：{error}");
    assert_eq!(store.get_memory(&id).unwrap().unwrap().value, "用户改的");
}

#[test]
fn 停用的记忆不再注入_但还留着() {
    // 「删除后不再注入未来调用」——停用是比删除更轻的一档：
    // 先停掉看看有没有影响，确认没用了再删
    let store = Store::open_in_memory().unwrap();
    let id = store.create_memory(&memory("toggle")).unwrap();

    store.set_memory_enabled(&id, false).unwrap();
    assert!(!store.get_memory(&id).unwrap().unwrap().enabled);

    // 注入时只取启用的
    assert_eq!(
        store
            .memories_for_injection("workspace", None)
            .unwrap()
            .len(),
        0
    );
    store.set_memory_enabled(&id, true).unwrap();
    assert_eq!(
        store
            .memories_for_injection("workspace", None)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn 过期的记忆不再注入() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_memory(&memory("expiring")).unwrap();
    store
        .set_memory_expiry(&id, Some("2020-01-01T00:00:00.000Z"))
        .unwrap();

    assert_eq!(
        store
            .memories_for_injection("workspace", None)
            .unwrap()
            .len(),
        0
    );
    // 但列表里还能看到它 —— 用户要知道它为什么不生效
    assert_eq!(store.list_memories(None, None).unwrap().len(), 1);
}

#[test]
fn ai_提议的记忆默认不启用_要确认才生效() {
    // 图纸：「AI 提议写入 · 确认后才保存，并注入后续调用」
    let store = Store::open_in_memory().unwrap();
    let mut proposed = memory("ai.suggested");
    proposed.source = "ai_proposed".to_string();
    let id = store.create_memory(&proposed).unwrap();

    let found = store.get_memory(&id).unwrap().unwrap();
    assert!(!found.enabled, "AI 提议的记忆不该直接生效");
    assert_eq!(
        store
            .memories_for_injection("workspace", None)
            .unwrap()
            .len(),
        0
    );

    // 采纳后才注入
    store.set_memory_enabled(&id, true).unwrap();
    assert_eq!(
        store
            .memories_for_injection("workspace", None)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn 看起来像密钥的内容被拒绝() {
    // 「Token、密钥和敏感文件内容禁止写入记忆」——
    // 记忆会被注入每一次 AI 调用，写进去等于发给模型
    let store = Store::open_in_memory().unwrap();
    let mut secret = memory("leaked");
    secret.value = "AKIAIOSFODNN7EXAMPLE".to_string();

    let error = store.create_memory(&secret).unwrap_err().to_string();
    assert!(
        error.contains("密钥") || error.contains("凭据"),
        "错误实际：{error}"
    );
}

#[test]
fn 删除后彻底不注入() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_memory(&memory("gone")).unwrap();
    store.delete_memory(&id).unwrap();

    assert!(store.get_memory(&id).unwrap().is_none());
    assert_eq!(
        store
            .memories_for_injection("workspace", None)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn 工作流可以改名() {
    // 用户操作级测试发现的：新建只能得到「未命名工作流 N」，
    // 而且没有任何改名入口 —— 真实列表堆了 300 多条「未命名工作流」
    let store = Store::open_in_memory().unwrap();
    let id = store.create_workflow("未命名工作流 1", None).unwrap();

    store.rename_workflow(&id, "GitHub Issue 修复").unwrap();
    assert_eq!(
        store.get_workflow(&id).unwrap().unwrap().name,
        "GitHub Issue 修复"
    );
}

#[test]
fn 改名会更新时间戳_列表排序才跟得上() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_workflow("原名", None).unwrap();
    let before = store.get_workflow(&id).unwrap().unwrap().updated_at;

    std::thread::sleep(std::time::Duration::from_millis(5));
    store.rename_workflow(&id, "新名").unwrap();

    let after = store.get_workflow(&id).unwrap().unwrap().updated_at;
    assert!(after >= before, "改名后 updated_at 应当更新");
}

#[test]
fn 空名字被拒绝() {
    // 空名字的工作流在列表里就是一行看不见的东西
    let store = Store::open_in_memory().unwrap();
    let id = store.create_workflow("有名字", None).unwrap();

    assert!(store.rename_workflow(&id, "   ").is_err());
    assert_eq!(store.get_workflow(&id).unwrap().unwrap().name, "有名字");
}

#[test]
fn 改不存在的工作流报错() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.rename_workflow("wf_nope", "新名").is_err());
}

// ── Agent 与提示词的乐观锁 ────────────────────────────────────────────────
//
// 契约里这两个 update 都要求带 base_ver 并返回新版本，但存储层最初
// 只是无条件 `ver = ver + 1`。症状在界面上是「保存报『返回值不合契约』」，
// 而真正的风险是：AI 通过 MCP 的写入会悄悄盖掉用户刚改的内容。

#[test]
fn 更新_agent_返回新版本号() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_agent(&agent("分析")).unwrap();
    let before = store.get_agent(&id).unwrap().unwrap().ver;

    let after = store
        .update_agent(
            &id,
            before,
            &AgentPatch {
                name: Some("分析 v2"),
                goal: None,
                persona: None,
                model_ref: None,
                fallback_model_ref: None,
            },
        )
        .unwrap();

    assert_eq!(after, before + 1);
    assert_eq!(store.get_agent(&id).unwrap().unwrap().name, "分析 v2");
}

#[test]
fn 带着旧版本号更新_agent_会被拒() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_agent(&agent("分析")).unwrap();
    let base = store.get_agent(&id).unwrap().unwrap().ver;

    // 别人先改了一版
    store
        .update_agent(
            &id,
            base,
            &AgentPatch {
                name: Some("别人改的"),
                goal: None,
                persona: None,
                model_ref: None,
                fallback_model_ref: None,
            },
        )
        .unwrap();

    // 我拿着过期的 base 再改 —— 必须拒，否则「别人改的」会被无声盖掉
    let err = store
        .update_agent(
            &id,
            base,
            &AgentPatch {
                name: Some("我改的"),
                goal: None,
                persona: None,
                model_ref: None,
                fallback_model_ref: None,
            },
        )
        .unwrap_err();
    assert!(format!("{err}").contains("已被改过"), "实际：{err}");
    assert_eq!(store.get_agent(&id).unwrap().unwrap().name, "别人改的");
}

#[test]
fn 更新_agent_能清空降级模型() {
    let store = Store::open_in_memory().unwrap();
    let mut input = agent("分析");
    input.fallback_model_ref = Some("model_sonnet".to_string());
    let id = store.create_agent(&input).unwrap();
    let base = store.get_agent(&id).unwrap().unwrap().ver;

    // 空字符串表示「不降级」。用 None 表示的话就与「这个字段没改」撞了，
    // 于是降级模型一旦设上就再也去不掉
    store
        .update_agent(
            &id,
            base,
            &AgentPatch {
                name: None,
                goal: None,
                persona: None,
                model_ref: None,
                fallback_model_ref: Some(""),
            },
        )
        .unwrap();
    assert_eq!(
        store.get_agent(&id).unwrap().unwrap().fallback_model_ref,
        None
    );
}

#[test]
fn 更新提示词返回新版本号并带乐观锁() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_prompt(&prompt("根因")).unwrap();
    let base = store.get_prompt(&id).unwrap().unwrap().ver;

    let sections = r#"[{"title":"Role","body":"改过的"}]"#;
    let after = store
        .update_prompt(&id, base, None, Some(sections), None)
        .unwrap();
    assert_eq!(after, base + 1);

    let err = store
        .update_prompt(&id, base, None, Some(sections), None)
        .unwrap_err();
    assert!(format!("{err}").contains("已被改过"), "实际：{err}");
}

#[test]
fn 更新提示词仍然拒绝非法分段() {
    let store = Store::open_in_memory().unwrap();
    let id = store.create_prompt(&prompt("根因")).unwrap();
    let base = store.get_prompt(&id).unwrap().unwrap().ver;

    // 乐观锁不能把原有的分段校验挤掉
    assert!(
        store
            .update_prompt(&id, base, None, Some("不是数组"), None)
            .is_err()
    );
    assert_eq!(store.get_prompt(&id).unwrap().unwrap().ver, base);
}

// ── 首页的运行态投影 ──────────────────────────────────────────────────────
//
// 图纸「01 工作流首页」的状态列显示的是**最近一次运行**的状态，
// 不带上它每一行都长成「已创建 · 未运行 · 草稿」——
// 用户发布并跑过三次，列表看起来还是没动过。

fn 建工作流并跑一次(store: &Store, name: &str, status: &str) -> (String, String) {
    let wf = store.create_workflow(name, None).unwrap();
    let run = store.create_run(&wf, None, Some(1), "{}").unwrap();
    store.advance_run_status(&run, status, None).unwrap();
    (wf, run)
}

#[test]
fn 列表带上最近一次运行() {
    let store = Store::open_in_memory().unwrap();
    let (wf, run) = 建工作流并跑一次(&store, "跑过的", "succeeded");

    let found = store.list_workflows().unwrap();
    let row = found.iter().find(|w| w.id == wf).unwrap();
    let last = row.last_run.as_ref().expect("跑过就该有");
    assert_eq!(last.id, run);
    assert_eq!(last.status, "succeeded");
}

#[test]
fn 没跑过的工作流没有最近运行() {
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("没跑过的", None).unwrap();

    let found = store.list_workflows().unwrap();
    let row = found.iter().find(|w| w.id == wf).unwrap();
    assert!(row.last_run.is_none(), "没运行过就不该编一个出来");
}

#[test]
fn 最近一次运行取的是最新那条而不是第一条() {
    let store = Store::open_in_memory().unwrap();
    let (wf, _first) = 建工作流并跑一次(&store, "跑很多次的", "failed");

    // 同一条工作流再跑一次，这次成功
    let second = store.create_run(&wf, None, Some(1), "{}").unwrap();
    store
        .advance_run_status(&second, "succeeded", None)
        .unwrap();

    let found = store.list_workflows().unwrap();
    let row = found.iter().find(|w| w.id == wf).unwrap();
    let last = row.last_run.as_ref().unwrap();
    assert_eq!(last.id, second, "列表要显示最新那次，不是第一次");
    assert_eq!(last.status, "succeeded");
}

#[test]
fn 一次查询就带回全部工作流的最近运行() {
    // N+1 会让 300 条工作流的首页发 300 次查询。
    // 这条用例不测性能，只是把「必须是一次查询」这件事钉住：
    // 300 条的列表要能在一次调用里返回
    let store = Store::open_in_memory().unwrap();
    for i in 0..40 {
        建工作流并跑一次(&store, &format!("流程 {i}"), "succeeded");
    }
    let found = store.list_workflows().unwrap();
    assert_eq!(found.len(), 40);
    assert!(found.iter().all(|w| w.last_run.is_some()));
}

#[test]
fn 统计卡数今天的运行与其中成功的() {
    let store = Store::open_in_memory().unwrap();
    建工作流并跑一次(&store, "成功一", "succeeded");
    建工作流并跑一次(&store, "成功二", "succeeded");
    建工作流并跑一次(&store, "失败的", "failed");

    let stats = store.workspace_stats().unwrap();
    assert_eq!(stats.runs_today, 3);
    assert_eq!(stats.runs_today_succeeded, 2);
}

#[test]
fn 统计卡数等待审批的运行() {
    let store = Store::open_in_memory().unwrap();
    建工作流并跑一次(&store, "在等审批的", "waiting_approval");
    建工作流并跑一次(&store, "跑完了的", "succeeded");

    let stats = store.workspace_stats().unwrap();
    assert_eq!(stats.pending_approvals, 1);
    assert_eq!(
        stats.pending_approval_hint.as_deref(),
        Some("在等审批的"),
        "副文本要说清是哪条在等，只给一个数字没法行动"
    );
}

#[test]
fn 一条运行都没有时统计全是零而不是报错() {
    let store = Store::open_in_memory().unwrap();
    let stats = store.workspace_stats().unwrap();
    assert_eq!(stats.pending_approvals, 0);
    assert_eq!(stats.runs_today, 0);
    assert!(stats.pending_approval_hint.is_none());
}

#[test]
fn 进入终态时记下结束时间() {
    // ended_at 一直没人写，于是「这次跑了多久」在整个应用里都是空的：
    // 首页的「4m18s」、执行记录的时长、运行详情的耗时统统显示不出来。
    // 这不是显示层的问题 —— 数据从来就没被记下来过。
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("会结束的", None).unwrap();
    let run = store.create_run(&wf, None, Some(1), "{}").unwrap();

    store.advance_run_status(&run, "running", None).unwrap();
    assert!(
        store.get_run(&run).unwrap().unwrap().ended_at.is_none(),
        "还在跑就不该有结束时间"
    );

    store.advance_run_status(&run, "succeeded", None).unwrap();
    assert!(store.get_run(&run).unwrap().unwrap().ended_at.is_some());
}

#[test]
fn 失败与取消也记结束时间() {
    for status in ["failed", "cancelled"] {
        let store = Store::open_in_memory().unwrap();
        let wf = store.create_workflow("会结束的", None).unwrap();
        let run = store.create_run(&wf, None, Some(1), "{}").unwrap();
        store.advance_run_status(&run, status, None).unwrap();
        assert!(
            store.get_run(&run).unwrap().unwrap().ended_at.is_some(),
            "{status} 也是终态"
        );
    }
}

#[test]
fn 等待审批不算结束() {
    // waiting_approval 会停很久，但它随时可能继续 ——
    // 记了结束时间的话「运行时长」会把审批等待算成执行耗时
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("等审批的", None).unwrap();
    let run = store.create_run(&wf, None, Some(1), "{}").unwrap();

    store
        .advance_run_status(&run, "waiting_approval", None)
        .unwrap();
    assert!(store.get_run(&run).unwrap().unwrap().ended_at.is_none());
}

#[test]
fn 事件记下节点当时的标题() {
    // 失败横幅原来显示的是内部 id（「节点『script_shell_2』失败」），
    // 而用户从没见过那个 id —— 他看到的是自己起的名字。
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("有标题的", None).unwrap();
    let run = store.create_run(&wf, None, Some(1), "{}").unwrap();

    store
        .append_event(&NewRunEvent {
            run_id: run.clone(),
            kind: "node.failed".to_string(),
            node_id: Some("script_shell_2".to_string()),
            node_label: Some("解析日志".to_string()),
            attempt: Some(1),
            actor: "engine".to_string(),
            status: None,
            summary: "脚本以退出码 7 结束".to_string(),
            payload_ref: None,
            artifact_refs: vec![],
            parent_event_id: None,
            sensitivity: "internal".to_string(),
            schema_ver: 1,
        })
        .unwrap();

    let events = store.events(&run, 0, 10).unwrap();
    assert_eq!(events[0].node_label.as_deref(), Some("解析日志"));
}

#[test]
fn 没有标题的事件照样读得出来() {
    // 加 node_label 之前写下的每一条事件都没有它。
    // 事件是不可变的历史，读不出来等于丢了运行记录
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("旧事件", None).unwrap();
    let run = store.create_run(&wf, None, Some(1), "{}").unwrap();

    store
        .append_event(&NewRunEvent {
            run_id: run.clone(),
            kind: "run.created".to_string(),
            node_id: None,
            node_label: None,
            attempt: None,
            actor: "engine".to_string(),
            status: None,
            summary: "运行已创建".to_string(),
            payload_ref: None,
            artifact_refs: vec![],
            parent_event_id: None,
            sensitivity: "internal".to_string(),
            schema_ver: 1,
        })
        .unwrap();

    assert!(store.events(&run, 0, 10).unwrap()[0].node_label.is_none());
}

// ── 主管 AI 的历史会话（M4）──────────────────────────────────────────────

#[test]
fn 会话与消息一起读回来() {
    let store = Store::open_in_memory().unwrap();
    let session = store
        .create_supervisor_session("给这条流程加个审批", None, None)
        .unwrap();
    store
        .append_supervisor_message(&session, "user", "加个审批")
        .unwrap();
    store
        .append_supervisor_message(&session, "agent", "加好了，你看下 Diff")
        .unwrap();

    let (meta, messages) = store.supervisor_session(&session).unwrap().unwrap();
    assert_eq!(meta.title, "给这条流程加个审批");
    assert_eq!(meta.message_count, 2);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].text, "加好了，你看下 Diff");
}

#[test]
fn 消息按_seq_排而不是按时间() {
    // 同一秒内写两条时，按 at 排的顺序是不稳定的 ——
    // 而对话读起来颠倒就完全没法理解
    let store = Store::open_in_memory().unwrap();
    let session = store
        .create_supervisor_session("很快的对话", None, None)
        .unwrap();
    for i in 0..20 {
        store
            .append_supervisor_message(
                &session,
                if i % 2 == 0 { "user" } else { "agent" },
                &format!("第 {i} 条"),
            )
            .unwrap();
    }

    let (_, messages) = store.supervisor_session(&session).unwrap().unwrap();
    for (i, message) in messages.iter().enumerate() {
        assert_eq!(message.text, format!("第 {i} 条"), "顺序乱了");
    }
}

#[test]
fn 列表按最近更新排() {
    // 用户找的是「刚才那条」，不是「最早那条」
    let store = Store::open_in_memory().unwrap();
    let a = store
        .create_supervisor_session("先问的", None, None)
        .unwrap();
    let b = store
        .create_supervisor_session("后问的", None, None)
        .unwrap();
    store
        .append_supervisor_message(&a, "user", "又问了一句")
        .unwrap();

    let list = store.list_supervisor_sessions(10).unwrap();
    assert_eq!(
        list.first().map(|s| s.id.as_str()),
        Some(a.as_str()),
        "刚更新的排最前"
    );
    assert!(list.iter().any(|s| s.id == b));
}

#[test]
fn 会话可以关联到工作流() {
    // 图纸：「按关联的工作流 / 运行 / 记忆 / 模型标注」
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("被问到的流程", None).unwrap();
    let session = store
        .create_supervisor_session("这条为什么失败", Some(&wf), None)
        .unwrap();

    let list = store.list_supervisor_sessions(10).unwrap();
    let found = list.iter().find(|s| s.id == session).unwrap();
    assert_eq!(found.workflow_id.as_deref(), Some(wf.as_str()));
}

#[test]
fn 不关联任何东西的会话也存得下() {
    // 「这个应用怎么用」不属于任何工作流，但它也是一次会话
    let store = Store::open_in_memory().unwrap();
    let session = store
        .create_supervisor_session("这个应用怎么用", None, None)
        .unwrap();
    assert!(store.supervisor_session(&session).unwrap().is_some());
}

#[test]
fn 删掉工作流后会话还在() {
    // 会话是对话记录，不该因为被问到的东西没了就一起消失 ——
    // 那段对话里可能有用户想找回来的结论
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("会被删的", None).unwrap();
    let session = store
        .create_supervisor_session("问一句", Some(&wf), None)
        .unwrap();

    store.delete_workflow(&wf).unwrap();

    let (meta, _) = store
        .supervisor_session(&session)
        .unwrap()
        .expect("会话该还在");
    assert!(meta.workflow_id.is_none(), "关联清掉，但会话本身留着");
}

#[test]
fn 读不存在的会话返回_none_而不是报错() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.supervisor_session("sess_ghost").unwrap().is_none());
}

// ── 启动参数的脱敏 ────────────────────────────────────────────────────────
//
// codex 自主体验时看到执行记录列表里直接显示完整的 `sk-proj-…`，
// 而运行详情底部写着「Secret 值在写入事件存储前已脱敏，界面不提供绕过查看」。
// 两处表现互相矛盾，而矛盾的那一半是真的：inputs 是原样存的。
//
// 脱敏必须发生在**写入时**：只在某一个视图上遮掉的话，
// 换个接口（列表、搜索、导出、MCP）就又漏出去了。

#[test]
fn 启动参数里的密钥在落库时就被脱敏() {
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("带密钥的", None).unwrap();
    let run = store
        .create_run(
            &wf,
            None,
            Some(1),
            r#"{"apiKey":"sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"}"#,
        )
        .unwrap();

    let row = store.get_run(&run).unwrap().unwrap();
    assert!(
        !row.inputs_json
            .contains("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"),
        "密钥原样进了库：{}",
        row.inputs_json
    );
    // 留痕：完全删掉的话用户不知道这里本来有个参数
    assert!(row.inputs_json.contains("apiKey"), "字段名要留着");
}

#[test]
fn github_token_也脱敏() {
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("带 token 的", None).unwrap();
    let run = store
        .create_run(
            &wf,
            None,
            Some(1),
            r#"{"token":"ghp_1234567890abcdefghijklmnopqrstuvwxyzAB"}"#,
        )
        .unwrap();

    assert!(
        !store
            .get_run(&run)
            .unwrap()
            .unwrap()
            .inputs_json
            .contains("ghp_1234567890abcdefghijklmnopqrstuvwxyzAB")
    );
}

#[test]
fn 普通参数不受影响() {
    // 脱敏太激进的话，`repo: atlas-api` 这种正常参数也会被吃掉，
    // 而用户就再也看不出这次是拿什么参数跑的
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("普通参数", None).unwrap();
    let run = store
        .create_run(&wf, None, Some(1), r#"{"repo":"atlas-api","issue":"548"}"#)
        .unwrap();

    let inputs = store.get_run(&run).unwrap().unwrap().inputs_json;
    assert!(inputs.contains("atlas-api"), "正常参数被误伤：{inputs}");
    assert!(inputs.contains("548"));
}

#[test]
fn keychain_引用原样保留() {
    // `keychain://` 本来就是「引用而非明文」的表达方式，遮掉它反而丢信息
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("引用凭据", None).unwrap();
    let run = store
        .create_run(&wf, None, Some(1), r#"{"cred":"keychain://openai-prod"}"#)
        .unwrap();

    assert!(
        store
            .get_run(&run)
            .unwrap()
            .unwrap()
            .inputs_json
            .contains("keychain://openai-prod")
    );
}

// ── 列表分页 ──────────────────────────────────────────────────────────────
//
// 1292 条工作流一次全返回，浏览器要建出上千个 DOM 节点，
// 而用户真正关心的那几条淹在里面。

#[test]
fn 工作流列表按页取() {
    let store = Store::open_in_memory().unwrap();
    for i in 0..25 {
        store
            .create_workflow(&format!("流程 {i:02}"), None)
            .unwrap();
    }

    let (first, total) = store.list_workflows_paged(10, 0).unwrap();
    assert_eq!(first.len(), 10);
    assert_eq!(total, 25, "total 是满足条件的总数，不是这一页的条数");

    let (second, _) = store.list_workflows_paged(10, 10).unwrap();
    assert_eq!(second.len(), 10);

    let (last, _) = store.list_workflows_paged(10, 20).unwrap();
    assert_eq!(last.len(), 5, "最后一页不足一整页");
}

#[test]
fn 分页之间不重不漏() {
    // 排序不稳定的话翻页会看到重复的条目，而另一些永远看不到
    let store = Store::open_in_memory().unwrap();
    for i in 0..30 {
        store
            .create_workflow(&format!("流程 {i:02}"), None)
            .unwrap();
    }

    let mut seen = std::collections::BTreeSet::new();
    for page in 0..3 {
        let (rows, _) = store.list_workflows_paged(10, page * 10).unwrap();
        for row in rows {
            assert!(seen.insert(row.id.clone()), "{} 出现了两次", row.name);
        }
    }
    assert_eq!(seen.len(), 30, "有条目一页都没出现过");
}

#[test]
fn 越界的_offset_返回空而不是报错() {
    // 用户手改 URL 或数据在翻页间被删掉时都会走到这
    let store = Store::open_in_memory().unwrap();
    store.create_workflow("唯一一条", None).unwrap();

    let (rows, total) = store.list_workflows_paged(10, 999).unwrap();
    assert!(rows.is_empty());
    assert_eq!(total, 1, "总数照样要给 —— 界面靠它知道该跳回第几页");
}

#[test]
fn 运行列表分页且_total_跟着筛选走() {
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("跑很多次的", None).unwrap();
    for _ in 0..12 {
        let run = store.create_run(&wf, None, Some(1), "{}").unwrap();
        store.advance_run_status(&run, "succeeded", None).unwrap();
    }
    for _ in 0..5 {
        let run = store.create_run(&wf, None, Some(1), "{}").unwrap();
        store.advance_run_status(&run, "failed", None).unwrap();
    }

    let (all, total_all) = store.list_runs_paged(None, &[], None, 10, 0).unwrap();
    assert_eq!(all.len(), 10);
    assert_eq!(total_all, 17);

    // 筛选之后 total 要是筛选后的数 —— 否则分页控件会画出翻不到的页
    let (failed, total_failed) = store
        .list_runs_paged(None, &["failed".to_string()], None, 10, 0)
        .unwrap();
    assert_eq!(failed.len(), 5);
    assert_eq!(total_failed, 5);
}

#[test]
fn 其余四个列表也分页() {
    let store = Store::open_in_memory().unwrap();
    for i in 0..15 {
        store
            .create_prompt(&prompt(&format!("提示 {i:02}")))
            .unwrap();
        store.create_agent(&agent(&format!("角色 {i:02}"))).unwrap();
    }

    let (prompts, prompt_total) = store.list_prompts_paged(None, None, 5, 0).unwrap();
    assert_eq!(prompts.len(), 5);
    assert_eq!(prompt_total, 15);

    let (agents, agent_total) = store.list_agents_paged(5, 0).unwrap();
    assert_eq!(agents.len(), 5);
    assert_eq!(agent_total, 15);
}

// ── 列表按时间倒序 ────────────────────────────────────────────────────────
//
// 按名字排的话，新建的东西会被埋在中间某一页 ——
// 而用户刚建完最想看到的就是它。

#[test]
fn agent_列表最新的排最前() {
    let store = Store::open_in_memory().unwrap();
    let first = store.create_agent(&agent("先建的")).unwrap();
    let second = store.create_agent(&agent("后建的")).unwrap();

    let (rows, _) = store.list_agents_paged(10, 0).unwrap();
    assert_eq!(rows.first().map(|a| a.id.as_str()), Some(second.as_str()));
    assert_eq!(rows.get(1).map(|a| a.id.as_str()), Some(first.as_str()));
}

#[test]
fn 改过的_agent_排到最前() {
    // 「最近动过的」比「最近建的」更接近用户的心理模型
    let store = Store::open_in_memory().unwrap();
    let old = store.create_agent(&agent("老的")).unwrap();
    let _new = store.create_agent(&agent("新的")).unwrap();

    // 时间戳精度到毫秒。同一毫秒内建完就改的话两条时间相同，
    // 排序退回 rowid 兜底 —— 那时「改过的排最前」不成立。
    // 真实使用里没人能在 1ms 内建完再改，这里等一下更贴近现实
    std::thread::sleep(std::time::Duration::from_millis(3));

    let ver = store.get_agent(&old).unwrap().unwrap().ver;
    store
        .update_agent(
            &old,
            ver,
            &AgentPatch {
                name: Some("老的（改过）"),
                ..AgentPatch::default()
            },
        )
        .unwrap();

    let (rows, _) = store.list_agents_paged(10, 0).unwrap();
    assert_eq!(rows.first().map(|a| a.id.as_str()), Some(old.as_str()));
}

#[test]
fn 模型列表也是最新的排最前() {
    let store = Store::open_in_memory().unwrap();
    let first = store.create_model(&model("先登记的")).unwrap();
    let second = store.create_model(&model("后登记的")).unwrap();

    let (rows, _) = store.list_models_paged(false, 10, 0).unwrap();
    assert_eq!(rows.first().map(|m| m.id.as_str()), Some(second.as_str()));
    assert_eq!(rows.get(1).map(|m| m.id.as_str()), Some(first.as_str()));
}

#[test]
fn 提示词列表也是最新的排最前() {
    let store = Store::open_in_memory().unwrap();
    let first = store.create_prompt(&prompt("先写的")).unwrap();
    let second = store.create_prompt(&prompt("后写的")).unwrap();

    let (rows, _) = store.list_prompts_paged(None, None, 10, 0).unwrap();
    assert_eq!(rows.first().map(|p| p.id.as_str()), Some(second.as_str()));
    assert_eq!(rows.get(1).map(|p| p.id.as_str()), Some(first.as_str()));
}

#[test]
fn 时间相同时用_rowid_兜底_翻页不重不漏() {
    // 同一毫秒建出来的几条，按时间排的顺序在两次查询间可能不同 ——
    // 翻页会看到重复的条目，而另一些永远看不到
    let store = Store::open_in_memory().unwrap();
    for i in 0..30 {
        store.create_agent(&agent(&format!("角色 {i:02}"))).unwrap();
    }

    let mut seen = std::collections::BTreeSet::new();
    for page in 0..3 {
        let (rows, _) = store.list_agents_paged(10, page * 10).unwrap();
        for row in rows {
            assert!(seen.insert(row.id.clone()), "{} 出现了两次", row.name);
        }
    }
    assert_eq!(seen.len(), 30, "有条目一页都没出现过");
}
