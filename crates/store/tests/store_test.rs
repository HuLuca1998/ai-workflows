//! 存储层契约测试。
//!
//! 数据模型见技术选型 §10。这里守住的不变量：
//! 事件流可信（(run_id, seq) 唯一且连续）、记忆键唯一、大 payload 不入事件表、
//! 断电后能凭检查点恢复。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::{EXPECTED_SCHEMA_VERSION, NewModel, NewRunEvent, Store};

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
    plain.credential_ref = Some("sk-ant-api03-abcdefghijklmnop".to_string());

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
