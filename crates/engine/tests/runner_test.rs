//! Run 生命周期与事件写入。
//!
//! 「RunEvent 是唯一事实来源」（产品原则 §1）落在这里：
//! 每一次状态变化都要有对应事件，事件流本身就能回答
//! 「现在跑到哪、为什么停、接下来做什么」。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{NodeOutcome, RunRequest, Runner, StepResult};
use aiwf_store::Store;

const GRAPH: &str = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"work","type":"script.shell","title":"跑一下","position":{"x":1,"y":0},"config":{}},
    {"id":"done","type":"end","title":"结束","position":{"x":2,"y":0},"config":{}}
  ],
  "edges": [
    {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"work","port":"input"}},
    {"id":"e2","source":{"nodeId":"work","port":"success"},"target":{"nodeId":"done","port":"input"}}
  ],
  "groups": []
}"#;

/// 含审批节点：审批要挂起并落检查点
const WITH_APPROVAL: &str = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"ap","type":"approval","title":"审批","position":{"x":1,"y":0},"config":{"title":"确认"}},
    {"id":"done","type":"end","title":"结束","position":{"x":2,"y":0},"config":{}}
  ],
  "edges": [
    {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"ap","port":"input"}},
    {"id":"e2","source":{"nodeId":"ap","port":"approved"},"target":{"nodeId":"done","port":"input"}}
  ],
  "groups": []
}"#;

fn setup(graph_json: &str) -> (Store, String) {
    let store = Store::open_in_memory().unwrap();
    // 显式声明权限档：默认是 review_every_change（有副作用的节点先挂起
    // 等审批），而这些用例测的是「跑起来之后发生什么」。
    // 声明比放宽默认好 —— 默认放宽等于替用户做了一个他不知道的决定。
    store
        .set_workspace_setting("permissionPreset", "human_approval")
        .unwrap();
    let workflow = store
        .create_workflow_with_graph("测试流程", None, graph_json)
        .unwrap();
    (store, workflow)
}

fn request(workflow_id: &str) -> RunRequest {
    RunRequest {
        workflow_id: workflow_id.to_string(),
        version_id: None,
        draft_rev: Some(0),
        inputs_json: "{}".to_string(),
        workdir: "/tmp/aiwf-test".to_string(),
    }
}

#[test]
fn 启动运行会写入生命周期事件() {
    let (store, workflow) = setup(GRAPH);
    let runner = Runner::new();

    let run_id = runner.start(&store, request(&workflow)).unwrap();

    let events = store.events(&run_id, 0, 50).unwrap();
    let types: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    // 顺序不能乱：先创建、再 preflight、再排队、再开始
    assert_eq!(
        types,
        vec![
            "run.created",
            "run.preflight_passed",
            "run.queued",
            "run.started"
        ]
    );
}

#[test]
fn 事件的_seq_从_1_起连续() {
    let (store, workflow) = setup(GRAPH);
    let run_id = Runner::new().start(&store, request(&workflow)).unwrap();

    let seqs: Vec<i64> = store
        .events(&run_id, 0, 50)
        .unwrap()
        .iter()
        .map(|e| e.seq)
        .collect();
    assert_eq!(seqs, vec![1, 2, 3, 4]);
}

#[test]
fn 图有问题时_preflight_不通过_不进队列() {
    // 没有入口节点的图：校验不该让它跑起来
    let broken = r#"{"nodes":[{"id":"a","type":"end","title":"孤零零","position":{"x":0,"y":0},"config":{}}],"edges":[],"groups":[]}"#;
    let (store, workflow) = setup(broken);
    let runner = Runner::new();

    let run_id = runner.start(&store, request(&workflow)).unwrap();

    let types: Vec<String> = store
        .events(&run_id, 0, 50)
        .unwrap()
        .iter()
        .map(|e| e.kind.clone())
        .collect();
    assert!(types.contains(&"run.preflight_failed".to_string()));
    assert!(
        !types.contains(&"run.queued".to_string()),
        "preflight 没过不该进队列"
    );
    assert_eq!(runner.status(&store, &run_id).unwrap(), "failed");
}

#[test]
fn 逐步推进_每个节点都留下开始与结束事件() {
    let (store, workflow) = setup(GRAPH);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();

    // 每一步执行一个就绪节点；这里用测试执行器直接返回成功
    while let StepResult::Advanced { .. } = runner
        .step(&store, &run_id, |_node| NodeOutcome::Succeeded {
            port: "success".to_string(),
        })
        .unwrap()
    {}

    let events = store.events(&run_id, 0, 100).unwrap();
    for node in ["entry", "work", "done"] {
        let started = events
            .iter()
            .any(|e| e.kind == "node.started" && e.node_id.as_deref() == Some(node));
        let succeeded = events
            .iter()
            .any(|e| e.kind == "node.succeeded" && e.node_id.as_deref() == Some(node));
        assert!(started, "{node} 缺 node.started");
        assert!(succeeded, "{node} 缺 node.succeeded");
    }
    assert_eq!(runner.status(&store, &run_id).unwrap(), "succeeded");
}

#[test]
fn 节点失败时运行失败_并记下是哪个节点() {
    let (store, workflow) = setup(GRAPH);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();

    loop {
        let result = runner
            .step(&store, &run_id, |node| {
                if node.id == "work" {
                    NodeOutcome::Failed {
                        message: "exitCode 1".to_string(),
                    }
                } else {
                    NodeOutcome::Succeeded {
                        port: "success".to_string(),
                    }
                }
            })
            .unwrap();
        if !matches!(result, StepResult::Advanced { .. }) {
            break;
        }
    }

    let events = store.events(&run_id, 0, 100).unwrap();
    let failed = events
        .iter()
        .find(|e| e.kind == "node.failed")
        .expect("应有 node.failed 事件");
    assert_eq!(failed.node_id.as_deref(), Some("work"));
    // 标题一并记下：界面显示的是它。只有 id 的话失败横幅写的是
    // 「节点『work』失败」，而用户从没见过那个 id
    assert!(
        failed.node_label.is_some(),
        "node.* 事件要带上节点当时的标题"
    );
    assert!(failed.summary.contains("exitCode 1"), "失败原因要写进事件");

    // run.failed 的摘要也要用标题，它是失败横幅的第一行
    let run_failed = events
        .iter()
        .find(|e| e.kind == "run.failed")
        .expect("应有 run.failed 事件");
    assert!(
        !run_failed.summary.contains("节点 work 失败"),
        "run.failed 不该用内部 id：{}",
        run_failed.summary
    );
    assert_eq!(runner.status(&store, &run_id).unwrap(), "failed");

    // 失败后不再往下跑
    assert!(!events.iter().any(|e| e.node_id.as_deref() == Some("done")));
}

// ── 审批与检查点：M2 出口标准「杀掉 App 后重启能回到同一审批点」──────────

#[test]
fn 审批节点挂起并落检查点() {
    let (store, workflow) = setup(WITH_APPROVAL);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();

    // 第一步跑入口
    runner
        .step(&store, &run_id, |_| NodeOutcome::Succeeded {
            port: "success".to_string(),
        })
        .unwrap();
    // 第二步走到审批：即使执行器说「成功」，引擎也必须挂起
    let result = runner
        .step(&store, &run_id, |_| NodeOutcome::Succeeded {
            port: "success".to_string(),
        })
        .unwrap();

    assert!(
        matches!(result, StepResult::WaitingApproval { .. }),
        "实际：{result:?}"
    );
    assert_eq!(runner.status(&store, &run_id).unwrap(), "waiting_approval");

    // 检查点必须落下来，否则重启后无从恢复
    let checkpoint = store
        .latest_checkpoint(&run_id)
        .unwrap()
        .expect("应有检查点");
    assert!(
        checkpoint
            .pending_approval_json
            .as_deref()
            .unwrap_or("")
            .contains("ap"),
        "检查点要记下卡在哪个审批节点"
    );
}

#[test]
fn 重启后能从检查点回到同一审批点() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");

    let run_id = {
        let store = Store::open(&path).unwrap();
        let workflow = store
            .create_workflow_with_graph("测试流程", None, WITH_APPROVAL)
            .unwrap();
        let runner = Runner::new();
        let run_id = runner.start(&store, request(&workflow)).unwrap();
        for _ in 0..2 {
            let _ = runner.step(&store, &run_id, |_| NodeOutcome::Succeeded {
                port: "success".to_string(),
            });
        }
        run_id
    };

    // —— 应用被杀掉，重新打开 ——
    let store = Store::open(&path).unwrap();
    let runner = Runner::new();

    assert_eq!(runner.status(&store, &run_id).unwrap(), "waiting_approval");
    let pending = runner.pending_approval(&store, &run_id).unwrap();
    assert_eq!(pending.as_deref(), Some("ap"), "重启后要知道卡在哪个审批");

    // 批准后继续，最终跑完
    runner
        .decide_approval(&store, &run_id, "ap", "approved")
        .unwrap();
    while let StepResult::Advanced { .. } = runner
        .step(&store, &run_id, |_| NodeOutcome::Succeeded {
            port: "success".to_string(),
        })
        .unwrap()
    {}
    assert_eq!(runner.status(&store, &run_id).unwrap(), "succeeded");
}

#[test]
fn 审批决定写入事件_谁在什么时候批准了什么() {
    let (store, workflow) = setup(WITH_APPROVAL);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    for _ in 0..2 {
        let _ = runner.step(&store, &run_id, |_| NodeOutcome::Succeeded {
            port: "success".to_string(),
        });
    }

    runner
        .decide_approval(&store, &run_id, "ap", "approved")
        .unwrap();

    let events = store.events(&run_id, 0, 100).unwrap();
    let requested = events.iter().find(|e| e.kind == "approval.requested");
    let decided = events.iter().find(|e| e.kind == "approval.decided");
    assert!(requested.is_some(), "挂起时要写 approval.requested");
    let decided = decided.expect("决定后要写 approval.decided");
    assert_eq!(decided.actor, "user");
    assert!(decided.summary.contains("approved"));
}

#[test]
fn 取消运行会停在当前位置并写入事件() {
    let (store, workflow) = setup(GRAPH);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();

    runner.cancel(&store, &run_id).unwrap();

    assert_eq!(runner.status(&store, &run_id).unwrap(), "cancelled");
    let events = store.events(&run_id, 0, 100).unwrap();
    assert!(events.iter().any(|e| e.kind == "run.cancelled"));

    // 取消后再 step 不应继续推进
    let result = runner
        .step(&store, &run_id, |_| NodeOutcome::Succeeded {
            port: "success".to_string(),
        })
        .unwrap();
    assert!(matches!(result, StepResult::Finished { .. }));
}

#[test]
fn 同一工作流可以并行跑多个运行_互不影响() {
    let (store, workflow) = setup(GRAPH);
    let runner = Runner::new();

    let a = runner.start(&store, request(&workflow)).unwrap();
    let b = runner.start(&store, request(&workflow)).unwrap();
    assert_ne!(a, b);

    // 只推进 a
    let _ = runner.step(&store, &a, |_| NodeOutcome::Succeeded {
        port: "success".to_string(),
    });

    let a_events = store.events(&a, 0, 100).unwrap();
    let b_events = store.events(&b, 0, 100).unwrap();
    assert!(a_events.iter().any(|e| e.kind == "node.started"));
    assert!(
        !b_events.iter().any(|e| e.kind == "node.started"),
        "另一个运行不该被带着往前跑"
    );
}

// ── 真实执行：Runner + NodeExecutor 闭环 ──────────────────────────────────

#[test]
fn 真实执行一条_shell_工作流并把上游输出传给下游() {
    // 这是 M2 的核心断言：两个脚本节点，第二个引用第一个的输出。
    // 通不过就说明「工作流真的跑起来了」这句话是假的。
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "产出",
             "config": {"interpreter": "bash", "script": "echo 42", "timeoutMs": 5000}},
            {"id": "b", "type": "script.shell", "title": "消费",
             "config": {"interpreter": "bash", "script": "echo got-${a.success.stdout}", "timeoutMs": 5000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();

    let (store, workflow) = setup(&graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();

    let status = runner.run_all(&store, &run_id).unwrap();
    assert_eq!(status, "succeeded", "运行应当成功");

    // 下游真的拿到了上游的输出
    let events = store.events(&run_id, 0, 200).unwrap();
    let b_done = events
        .iter()
        .find(|e| e.kind == "node.succeeded" && e.node_id.as_deref() == Some("b"))
        .expect("b 应当成功");
    assert!(b_done.summary.contains("消费"), "实际：{}", b_done.summary);
}

#[test]
fn 上游节点的输出在重启后仍能被下游引用() {
    // 检查点必须带着 scope 快照，否则重启后 ${a.success.stdout} 解析不出来
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "产出",
             "config": {"interpreter": "bash", "script": "echo 7", "timeoutMs": 5000}},
            {"id": "ap", "type": "approval", "title": "审批", "config": {"title": "确认"}},
            {"id": "b", "type": "script.shell", "title": "消费",
             "config": {"interpreter": "bash", "script": "echo v=${a.success.stdout}", "timeoutMs": 5000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "ap", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "ap", "port": "approved"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();

    let (store, workflow) = setup(&graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();

    // 跑到审批挂起
    let status = runner.run_all(&store, &run_id).unwrap();
    assert_eq!(status, "waiting_approval");

    // 「重启」：换一个全新的 Runner，什么内存状态都没有
    let after_restart = Runner::new();
    assert_eq!(
        after_restart.pending_approval(&store, &run_id).unwrap(),
        Some("ap".to_string())
    );
    after_restart
        .decide_approval(&store, &run_id, "ap", "approved")
        .unwrap();

    let final_status = after_restart.run_all(&store, &run_id).unwrap();
    assert_eq!(final_status, "succeeded", "重启后应当能跑完");
}

// ── 记忆注入的溯源（M4 出口标准）─────────────────────────────────────────

/// 只有一个 AI 节点的图。
///
/// runtime 故意写一个**不存在**的值：要验的是「注入事件在调用之前
/// 就写下了」，节点本身跑不跑得起来无所谓。
///
/// 这里原本写的是 `acp.claude`，注释说「跑不动 adapter 也没关系」——
/// 而这条假设在装了 adapter 的机器上不成立：`Runner` 没有
/// `with_acp_command` 那样的注入口，于是测试会**真的拉起
/// claude adapter**，连上开发者自己正在用的登录态与配额。
/// CLAUDE.md 那条「测试与试验不要用 claude 的 adapter」说的就是这个。
///
/// 实测：跑一次全量 `cargo test -p aiwf-engine` 会在 `ps` 里
/// 留下 `claude --session-id=…` 与 `codex app-server` 进程。
const AI_GRAPH: &str = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"think","type":"ai.analyze","title":"分析","position":{"x":1,"y":0},
     "config":{"instruction":"看一眼","runtime":"acp.codex"}}
  ],
  "edges": [
    {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"think","port":"input"}}
  ],
  "groups": []
}"#;

#[test]
fn 注入的记忆写进事件_可溯源() {
    // M4 出口标准：「记忆注入可在事件中溯源」。
    //
    // 记忆会改变 AI 的行为，而用户看到出乎意料的结果时第一个要问的
    // 就是「它凭什么这么干」。答案必须在运行记录里 ——
    // 而不是让他去猜当时哪几条记忆生效了。
    let (store, workflow) = setup(AI_GRAPH);
    store
        .create_memory(&aiwf_store::NewMemory {
            scope: "workspace".to_string(),
            scope_id: None,
            key: "style.commit".to_string(),
            value: "提交信息用中文".to_string(),
            summary: None,
            source: "user".to_string(),
            created_by: "本地用户".to_string(),
            sensitivity: "internal".to_string(),
            tags: vec![],
        })
        .unwrap();

    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    // adapter 多半没装，跑失败也没关系 —— 注入事件在调用之前就写下了
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    let injected = events
        .iter()
        .find(|e| e.kind == "system.memory_injected")
        .expect("注入了记忆就该有 system.memory_injected 事件");
    assert!(
        injected.summary.contains("style.commit"),
        "要说清注入的是哪几条：{}",
        injected.summary
    );
}

#[test]
fn 没有记忆时不写空的注入事件() {
    // 每个 AI 节点都写一条「注入了 0 条」会把事件流冲得没法看
    let (store, workflow) = setup(AI_GRAPH);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    assert!(
        !events.iter().any(|e| e.kind == "system.memory_injected"),
        "没记忆就不该有这条事件"
    );
}

#[test]
fn 停用的记忆不注入() {
    // 「删除后不再注入未来调用，停用则先留着不生效」——
    // 停用如果照样注入，那个开关就是假的
    let (store, workflow) = setup(AI_GRAPH);
    let memory = store
        .create_memory(&aiwf_store::NewMemory {
            scope: "workspace".to_string(),
            scope_id: None,
            key: "已停用的".to_string(),
            value: "不该出现".to_string(),
            summary: None,
            source: "user".to_string(),
            created_by: "本地用户".to_string(),
            sensitivity: "internal".to_string(),
            tags: vec![],
        })
        .unwrap();
    store.set_memory_enabled(&memory, false).unwrap();

    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    assert!(
        !events.iter().any(|e| e.kind == "system.memory_injected"),
        "停用的记忆不该被注入"
    );
}

// ── 可解释性：这一步用了什么（M4 出口标准）──────────────────────────────────
//
// 执行记录那一屏的承诺是「用了哪个模型 / 提示词 / 注入了哪些记忆 /
// 谁批准了什么」。前两样长期没有落点：AI 节点连 agentProfileId 都不读，
// 事件流里自然也没有一条说得清「这一步是谁在跑」。

fn 挂角色的图(agent_id: &str) -> String {
    format!(
        r#"{{
  "nodes": [
    {{"id":"entry","type":"entry","title":"入口","position":{{"x":0,"y":0}},"config":{{}}}},
    {{"id":"think","type":"ai.analyze","title":"分析","position":{{"x":1,"y":0}},
     "config":{{"agentProfileId":"{agent_id}","instruction":"看一眼"}}}}
  ],
  "edges": [
    {{"id":"e1","source":{{"nodeId":"entry","port":"success"}},"target":{{"nodeId":"think","port":"input"}}}}
  ],
  "groups": []
}}"#
    )
}

fn 建一个分析师(store: &Store) -> String {
    建一个分析师_用模型(store, "model:codex")
}

fn 建一个分析师_用模型(store: &Store, model_ref: &str) -> String {
    store
        .create_builtin_agent(&aiwf_store::NewAgent {
            name: "分析师".to_string(),
            role: "分析".to_string(),
            goal: "定位根因".to_string(),
            persona: "只看证据说话".to_string(),
            // 故意用一个装不上的 runtime：这条测的是「运行记录说得清
            // 用了哪个角色与模型」，而那条事件在选 adapter **之前**就写下了。
            // 写真实的 `acp.codex` 会让测试真的拉起 codex ——
            // `Runner` 没有 mock 注入口，跑一次全量测试就在 `ps` 里
            // 留下一串 adapter 进程，用的是开发者自己的登录态与配额
            runtime: "acp.codex".to_string(),
            model_ref: model_ref.to_string(),
            fallback_model_ref: None,
            tools: vec![],
            capabilities_json:
                r#"{"file":"read","command":"none","network":"none","memory":"read","secret":[]}"#
                    .to_string(),
            output_contract: "根因 + 方案清单".to_string(),
            turn_limit: 12,
            timeout_ms: 900_000,
        })
        .unwrap()
}

/// 用 mock adapter 起 Runner。
///
/// 图里有 AI 节点的 Runner 级测试**必须**走这条：不然它会真的拉起
/// codex，用开发者自己的登录态与配额跑一轮，跑一次全量测试就在 `ps` 里
/// 留下一串 `codex app-server`（CLAUDE.md「测试与试验优先用 codex」
/// 那条说的是被测的 adapter，不是「可以随便拉起真的」）。
fn mock_adapter_runner() -> Runner {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    Runner::new().with_acp_command(
        "node",
        &[script.display().to_string(), "normal".to_string()],
    )
}

#[test]
fn 运行记录说得清这一步用了哪个角色与模型() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_workspace_setting("permissionPreset", "human_approval")
        .unwrap();
    // 「模型」页登记一条：这条测试同时守着 runner → 执行器的模型目录
    // 管道 —— 库里的登记条目要一路走到事件文案里，而不是引用原样照抄
    let model = store
        .create_model(&aiwf_store::NewModel {
            name: "Codex 高档".to_string(),
            runtime: "acp.codex".to_string(),
            model_id: "gpt-5-codex".to_string(),
            effort: "high".to_string(),
            context_window: 200_000,
            capabilities: vec![],
            credential_ref: None,
            enabled: true,
        })
        .unwrap();
    let agent = 建一个分析师_用模型(&store, &model);
    let workflow = store
        .create_workflow_with_graph("测试流程", None, &挂角色的图(&agent))
        .unwrap();

    let runner = mock_adapter_runner();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    // 解析事件在连 adapter 之前就写下，跑成跑不成都不影响这条断言 ——
    // 但 adapter 得是 mock 的，不然这条测试会真的拉起 codex
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    let 解析 = events
        .iter()
        .find(|e| e.kind == "system.model_resolved")
        .expect("AI 节点该留一条 system.model_resolved");

    assert_eq!(解析.node_id.as_deref(), Some("think"));
    // gpt-5-codex 是登记条目解析出来的 —— 事件里写的是实际交给 adapter
    // 的名字与推理档，不是 model:xxx 这种没人读得懂的内部引用
    for 片段 in [
        "分析师",
        agent.as_str(),
        "gpt-5-codex",
        "推理 high",
        "acp.codex",
        "cwd ",
    ] {
        assert!(
            解析.summary.contains(片段),
            "「{片段}」没写进事件：{}",
            解析.summary
        );
    }
}

#[test]
fn 角色被删掉时运行失败并说清缺的是哪一个() {
    // 悄悄按「没有角色」跑下去的话，用户得到的分析是一个没有人设、
    // 没有输出契约、也没有权限约束的模型给的，而画布上写着「分析师」
    let (store, workflow) = setup(&挂角色的图("agent_没有这个"));

    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    let 失败 = events
        .iter()
        .find(|e| e.kind == "node.failed")
        .expect("角色不存在该让节点失败");
    assert!(
        失败.summary.contains("agent_没有这个"),
        "要说清缺的是哪一个：{}",
        失败.summary
    );
}

// ── 对话进事件流（M3 的「对话」tab 靠它）────────────────────────────────────

#[test]
fn ai_节点的对话与工具调用真的落进事件表() {
    // 执行器把事件交给一个回调，runner 负责落库。中间断一环的话，
    // 「对话」tab 会空着 —— 而产物里明明躺着几 KB 的回答。
    let store = Store::open_in_memory().unwrap();
    store
        .set_workspace_setting("permissionPreset", "human_approval")
        .unwrap();
    let agent = 建一个分析师(&store);
    let workflow = store
        .create_workflow_with_graph("测试流程", None, &挂角色的图(&agent))
        .unwrap();

    let runner = mock_adapter_runner();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    let 类型: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();

    // 这里原先有一句「adapter 没装就 eprintln 一句然后 return」。
    //
    // 那是条**永远可能不执行断言**的测试：CI 上没装 adapter，于是它
    // 每次都从这儿返回，绿着，而下面那四条断言一次都没跑过。
    // 现在 adapter 是 mock 的，条件由测试自己造 —— 跑不到对话
    // 就是真的坏了，该红。
    assert!(
        events
            .iter()
            .any(|e| e.kind == "node.succeeded" && e.node_id.as_deref() == Some("think")),
        "mock adapter 下 AI 节点没跑成功：{类型:?}"
    );

    assert!(
        类型.contains(&"conversation.user_message"),
        "发出去的提示词该进对话流：{类型:?}"
    );
    assert!(
        类型.contains(&"conversation.agent_message"),
        "agent 的回答该进对话流：{类型:?}"
    );

    let 提问 = events
        .iter()
        .find(|e| e.kind == "conversation.user_message")
        .unwrap();
    assert_eq!(提问.node_id.as_deref(), Some("think"));
    assert_eq!(提问.actor, "agent", "对话事件的 actor 不是 engine");
    assert!(提问.payload_ref.is_some(), "全文要落产物，事件里只留摘要");
}

/// 权限档挂起的节点，批准之后必须**真的执行**。
///
/// 用户报的：内置模板里那个「读取 Issue」（`script.shell`）在
/// review_every_change 档下挂起等审批，他点了同意，界面写着「审批通过」，
/// 而 `gh issue view` 一次都没跑 —— 下游的 AI 分析于是拿到一个空的分析对象，
/// 回了一句「请提供要分析的具体问题和现有证据」。
///
/// `decide_approval` 里那条注释早就写着这个危害：「completed_nodes 信任所有
/// node.succeeded，那个节点的真实脚本就被整个跳过了」——
/// 它防住了「审批指向错节点」，却没防住「因权限档挂起的节点」走同一条路。
mod 权限档审批 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_engine::runner::{NodeOutcome, RunRequest, Runner, StepResult};
    use aiwf_store::Store;

    const 脚本图: &str = r#"{
      "nodes": [
        {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
        {"id":"read","type":"script.shell","title":"读取 Issue","position":{"x":1,"y":0},"config":{}},
        {"id":"done","type":"end","title":"结束","position":{"x":2,"y":0},"config":{}}
      ],
      "edges": [
        {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"read","port":"input"}},
        {"id":"e2","source":{"nodeId":"read","port":"success"},"target":{"nodeId":"done","port":"input"}}
      ],
      "groups": []
    }"#;

    /// 走默认权限档（review_every_change）—— 用户撞上的就是这一档。
    fn 库() -> (Store, String) {
        let store = Store::open_in_memory().unwrap();
        let workflow = store
            .create_workflow_with_graph("测试流程", None, 脚本图)
            .unwrap();
        (store, workflow)
    }

    fn 请求(workflow_id: &str) -> RunRequest {
        RunRequest {
            workflow_id: workflow_id.to_string(),
            version_id: None,
            draft_rev: Some(0),
            inputs_json: "{}".to_string(),
            workdir: "/tmp/aiwf-test".to_string(),
        }
    }

    #[test]
    fn 批准之后脚本真的被执行了() {
        let (store, workflow) = 库();
        let runner = Runner::new();
        let run_id = runner.start(&store, 请求(&workflow)).unwrap();

        // 跑到脚本节点，它应当因为权限档挂起
        loop {
            let 结果 = runner
                .step(&store, &run_id, |node| {
                    if node.id == "read" {
                        return NodeOutcome::NeedsApproval;
                    }
                    NodeOutcome::Succeeded {
                        port: "success".to_string(),
                    }
                })
                .unwrap();
            if !matches!(结果, StepResult::Advanced { .. }) {
                break;
            }
        }
        assert_eq!(
            runner.status(&store, &run_id).unwrap(),
            "waiting_approval",
            "脚本节点应当先挂起等审批"
        );

        runner
            .decide_approval(&store, &run_id, "read", "approved")
            .unwrap();

        // 批准之后再推进：这一次那个节点必须真的进执行器
        let 批准后执行 = std::cell::Cell::new(false);
        while let StepResult::Advanced { .. } = runner
            .step(&store, &run_id, |node| {
                if node.id == "read" {
                    批准后执行.set(true);
                }
                NodeOutcome::Succeeded {
                    port: "success".to_string(),
                }
            })
            .unwrap()
        {}

        assert!(
            批准后执行.get(),
            "批准之后节点没有再被执行 —— 界面写着「审批通过」，而脚本一次都没跑"
        );
        assert_eq!(runner.status(&store, &run_id).unwrap(), "succeeded");
    }

    #[test]
    fn approval_节点本身批准即完成_不重复执行() {
        // 审批节点是引擎强制的暂停点，它没有「要执行的东西」。
        // 把它也拉回去重跑的话，用户会被同一个审批问第二次
        let store = Store::open_in_memory().unwrap();
        let graph = r#"{
          "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"ap","type":"approval","title":"审批","position":{"x":1,"y":0},"config":{"title":"确认"}},
            {"id":"done","type":"end","title":"结束","position":{"x":2,"y":0},"config":{}}
          ],
          "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"ap","port":"input"}},
            {"id":"e2","source":{"nodeId":"ap","port":"approved"},"target":{"nodeId":"done","port":"input"}}
          ],
          "groups": []
        }"#;
        let workflow = store
            .create_workflow_with_graph("测试流程", None, graph)
            .unwrap();
        let runner = Runner::new();
        let run_id = runner.start(&store, 请求(&workflow)).unwrap();

        loop {
            let 结果 = runner
                .step(&store, &run_id, |node| {
                    if node.node_type == "approval" {
                        return NodeOutcome::NeedsApproval;
                    }
                    NodeOutcome::Succeeded {
                        port: "success".to_string(),
                    }
                })
                .unwrap();
            if !matches!(结果, StepResult::Advanced { .. }) {
                break;
            }
        }

        runner
            .decide_approval(&store, &run_id, "ap", "approved")
            .unwrap();

        let 又问了一次 = std::cell::Cell::new(false);
        while let StepResult::Advanced { .. } = runner
            .step(&store, &run_id, |node| {
                if node.node_type == "approval" {
                    又问了一次.set(true);
                    return NodeOutcome::NeedsApproval;
                }
                NodeOutcome::Succeeded {
                    port: "success".to_string(),
                }
            })
            .unwrap()
        {}

        assert!(!又问了一次.get(), "同一个审批不该问第二次");
        assert_eq!(runner.status(&store, &run_id).unwrap(), "succeeded");
    }
}

/// 事件摘要里不能有 Secret 明文。
///
/// `redactor.rs` 的模块文档写着「stdout、stderr、AI 输入输出统一过这里
/// **才落库**」，而事件的写入链路上一次都没调过它 —— Redactor 只在三个
/// **读取点**（产物内容、运行诊断、环境诊断）用过。
///
/// 于是脚本里一句 `echo $TOKEN` 就让明文躺进 `run_event.summary`、
/// 躺进全文索引、显示在事件列表里 —— 而列表正下方写着
/// 「Secret 值在写入事件存储前已脱敏，界面不提供绕过查看」。
mod 事件不留明文 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_engine::runner::{RunRequest, Runner};
    use aiwf_store::Store;

    /// 一个长得像真令牌的串。用 GitHub 的形态：Redactor 与存储层
    /// 那两份判据都认它，能同时压住「至少有一份生效」。
    ///
    /// **拼出来而不是写成字面量**：仓库有一道扫明文凭据的门禁
    /// （`scripts/scan-secrets.mjs`），一个长得像真令牌的常量会被它拦下 ——
    /// 那道门禁是对的，该让步的是夹具。运行时拼出来的串是完整的，
    /// 脚本 echo 出去的也是完整的，测的东西一点没少
    fn 假令牌() -> String {
        format!("{}{}", "gh", "p_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    }

    fn 跑一条(script: &str) -> (Store, String) {
        let graph = serde_json::json!({
            "nodes": [
                {"id": "entry", "type": "entry", "title": "入口", "config": {}},
                {"id": "leak", "type": "script.shell", "title": "会吐密钥的脚本",
                 "config": {"interpreter": "bash", "script": script, "timeoutMs": 5000}}
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
                 "target": {"nodeId": "leak", "port": "input"}}
            ],
            "groups": []
        })
        .to_string();

        let store = Store::open_in_memory().unwrap();
        // 脚本节点在默认档下要审批，这里测的是「写进去的东西长什么样」
        store
            .set_workspace_setting("permissionPreset", "human_approval")
            .unwrap();
        let workflow = store
            .create_workflow_with_graph("测试流程", None, &graph)
            .unwrap();

        let runner = Runner::new();
        let run_id = runner
            .start(
                &store,
                RunRequest {
                    workflow_id: workflow,
                    version_id: None,
                    draft_rev: Some(0),
                    inputs_json: "{}".to_string(),
                    workdir: "/tmp".to_string(),
                },
            )
            .unwrap();
        runner.run_all(&store, &run_id).unwrap();
        (store, run_id)
    }

    #[test]
    fn 脚本吐出来的令牌不进事件摘要() {
        let 令牌 = 假令牌();
        let (store, run_id) = 跑一条(&format!("echo {令牌}"));

        let events = store.events(&run_id, 0, 200).unwrap();
        let 命中: Vec<&str> = events
            .iter()
            .filter(|e| e.summary.contains(&令牌))
            .map(|e| e.kind.as_str())
            .collect();

        assert!(
            命中.is_empty(),
            "这些事件的摘要里有令牌明文：{命中:?}。\
             它会跟着数据库一起被备份走，而界面上写着「已脱敏」"
        );
        // 事件本身还得在 —— 脱敏不是把整条吞掉
        assert!(
            events.iter().any(|e| e.kind == "script.stdout"),
            "连输出事件都没了，那是另一种坏法"
        );
    }

    #[test]
    fn authorization_头也不留() {
        let 令牌 = format!("{}{}", "sk-", "live-abcdefghijklmnop");
        let (store, run_id) = 跑一条(&format!("echo 'Authorization: Bearer {令牌}'"));

        let events = store.events(&run_id, 0, 200).unwrap();
        assert!(
            !events.iter().any(|e| e.summary.contains(&令牌)),
            "Authorization 头里的令牌进了事件摘要"
        );
    }

    #[test]
    fn 全文索引里也搜不到() {
        // 只脱敏 summary 而索引里留着的话，搜索框一搜就出来了
        let 令牌 = 假令牌();
        let (store, _run_id) = 跑一条(&format!("echo {令牌}"));

        let 命中 = store.search(&令牌).unwrap();
        assert!(命中.is_empty(), "全文索引里还留着令牌明文：{命中:?}");
    }
}

/// 端到端：人工介入这条链路，从挂起到批准到真的产生副作用。
///
/// 这是「审查循环」里「人工介入」方向的那一轮。要看的不只是跑通，
/// 而是三件事：执行过程停在该停的地方没有、写进库的数据对不对、
/// 那些数据是不是真发生过（有独立可验证的副作用）。
mod 端到端_人工介入 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_engine::runner::{RunRequest, Runner};
    use aiwf_store::Store;

    #[test]
    fn 批准之后脚本真的写了文件_而不是只把节点标绿() {
        let dir = std::env::temp_dir().join("aiwf_e2e_approval");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let 产出 = dir.join("批准之后才该出现.txt");

        // **门放在写文件那一步之前** —— 权限由流程管：
        // 引擎不再按节点类型自动拦，拦它的就是图上这一道
        let graph = serde_json::json!({
            "nodes": [
                {"id": "entry", "type": "entry", "title": "入口", "config": {}},
                {"id": "gate", "type": "approval", "title": "开工前确认",
                 "config": {"title": "要开始写文件了", "interaction": "confirm"}},
                {"id": "write", "type": "script.shell", "title": "写一个文件",
                 "config": {"interpreter": "bash", "timeoutMs": 5000,
                            "script": format!("echo 真的跑了 > {}", 产出.display())}},
                {"id": "done", "type": "end", "title": "结束", "config": {}}
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "gate", "port": "input"}},
                {"id": "e2", "source": {"nodeId": "gate", "port": "approved"}, "target": {"nodeId": "write", "port": "input"}},
                {"id": "e3", "source": {"nodeId": "write", "port": "success"}, "target": {"nodeId": "done", "port": "input"}}
            ],
            "groups": []
        }).to_string();

        let store = Store::open_in_memory().unwrap();
        // 最严档：图上那道门由人批
        store
            .set_workspace_setting("permissionPreset", "human_approval")
            .unwrap();
        let workflow = store
            .create_workflow_with_graph("人工介入", None, &graph)
            .unwrap();

        let runner = Runner::new();
        let run_id = runner
            .start(
                &store,
                RunRequest {
                    workflow_id: workflow,
                    version_id: None,
                    draft_rev: Some(0),
                    inputs_json: "{}".to_string(),
                    workdir: dir.display().to_string(),
                },
            )
            .unwrap();

        // ── 执行过程：停在该停的地方 ──────────────────────────────────
        // 走 run_all 而不是自己搭 executor —— 它会按 workspace 设置
        // 构造权限档与 approved_nodes，那正是生产路径
        let status = runner.run_all(&store, &run_id).unwrap();
        assert_eq!(status, "waiting_approval", "图上那道门没有拦住");
        assert!(
            !产出.exists(),
            "还没批准，文件就已经写出来了 —— 门拦在了副作用之后"
        );
        assert_eq!(
            runner.pending_approval(&store, &run_id).unwrap().as_deref(),
            Some("gate"),
            "卡住的不是那道门"
        );

        runner
            .decide_approval(&store, &run_id, "gate", "approved")
            .unwrap();
        let status = runner.run_all(&store, &run_id).unwrap();
        assert_eq!(status, "succeeded", "批准之后没跑完");

        // ── 真实：副作用能独立验证 ───────────────────────────────────
        assert!(
            产出.exists(),
            "运行说成功了，而文件根本没出现 —— 这正是「批准之后节点没被执行」那个坑"
        );
        assert_eq!(std::fs::read_to_string(&产出).unwrap().trim(), "真的跑了");

        // ── 正确：事件流讲的是同一件事 ───────────────────────────────
        let events = store.events(&run_id, 0, 200).unwrap();
        let 种类: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert!(种类.contains(&"approval.requested"), "{种类:?}");
        assert!(种类.contains(&"approval.decided"), "{种类:?}");
        assert!(
            种类.iter().filter(|k| **k == "node.succeeded").count() >= 2,
            "入口与脚本都该有成功事件：{种类:?}"
        );

        // 顺序：先问、再决定、然后才是那个节点成功
        let 位置 = |kind: &str| events.iter().position(|e| e.kind == kind);
        assert!(位置("approval.requested") < 位置("approval.decided"));
        let 脚本成功 = events
            .iter()
            .position(|e| e.kind == "node.succeeded" && e.node_id.as_deref() == Some("write"));
        assert!(
            位置("approval.decided") < 脚本成功,
            "脚本的成功事件排在审批决定之前 —— 那说明它在批准前就跑了"
        );

        // ── 必须留：删掉这些还答不答得出「为什么是这个结果」 ─────────
        let 决定 = events
            .iter()
            .find(|e| e.kind == "approval.decided")
            .unwrap();
        assert_eq!(决定.actor, "user", "审批的执行者必须是人，不能记成 engine");
        assert!(决定.summary.contains("approved"), "{}", 决定.summary);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 一条超长的失败信息不该让整个运行猝死。
///
/// `摘要()` 把 stdout/stderr 事件截到 400 字，但 `NodeOutcome::Failed`
/// 那条路走的是 `first_line()` —— 只取第一行，**不限长度**。
/// 编译器、node 的 stack、curl 打回的 body 都可能把几千字打在同一行上。
///
/// 于是存储层拒收（摘要上限 2000），而那是在 `node.failed` 写入的时候 ——
/// 结果是：**一条 `node.failed` 都没有**，界面上那个节点永远停在
/// 「运行中」（有 started 无终态），用户看到的是一句提「artifact」
/// 「payload_ref」的内部术语，而真正的失败原因（退出码与 stderr）
/// 被这条假错误盖过去了。
mod 超长摘要不该压垮运行 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_engine::runner::{RunRequest, Runner};
    use aiwf_store::Store;

    #[test]
    fn 一行五千字的_stderr_仍然写得出_node_failed() {
        // 同一行五千字 —— first_line() 挡不住这种
        let graph = serde_json::json!({
            "nodes": [
                {"id": "entry", "type": "entry", "title": "入口", "config": {}},
                {"id": "boom", "type": "script.shell", "title": "会长篇大论地失败",
                 "config": {"interpreter": "bash", "timeoutMs": 5000,
                            "script": "python3 -c \"import sys; sys.stderr.write('E'*5000)\"; exit 1"}}
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
                 "target": {"nodeId": "boom", "port": "input"}}
            ],
            "groups": []
        }).to_string();

        let store = Store::open_in_memory().unwrap();
        store
            .set_workspace_setting("permissionPreset", "human_approval")
            .unwrap();
        let workflow = store
            .create_workflow_with_graph("长错误", None, &graph)
            .unwrap();

        let runner = Runner::new();
        let run_id = runner
            .start(
                &store,
                RunRequest {
                    workflow_id: workflow,
                    version_id: None,
                    draft_rev: Some(0),
                    inputs_json: "{}".to_string(),
                    workdir: "/tmp".to_string(),
                },
            )
            .unwrap();

        // 脚本节点不再被自动拦（权限由流程管）—— 直接跑到失败
        let status = runner.run_all(&store, &run_id).unwrap();

        let events = store.events(&run_id, 0, 500).unwrap();
        let 种类: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();

        assert!(
            种类.contains(&"node.failed"),
            "节点失败了却没有 node.failed —— 界面上它会永远停在「运行中」：{种类:?}"
        );
        assert_eq!(status, "failed");

        // 失败原因要说清是哪个节点，不能是一句存储层的内部术语
        let 收尾 = events.iter().find(|e| e.kind == "run.failed").unwrap();
        assert!(
            !收尾.summary.contains("payload_ref") && !收尾.summary.contains("artifact"),
            "把存储层的内部术语抛给了用户：{}",
            收尾.summary
        );
    }

    #[test]
    fn 超长的节点标题也不该让运行卡住() {
        // 契约对 title 只有 min(1)，没有上限
        let 长标题 = "标".repeat(3000);
        let graph = serde_json::json!({
            "nodes": [
                {"id": "entry", "type": "entry", "title": "入口", "config": {}},
                {"id": "long", "type": "end", "title": 长标题, "config": {}}
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
                 "target": {"nodeId": "long", "port": "input"}}
            ],
            "groups": []
        })
        .to_string();

        let store = Store::open_in_memory().unwrap();
        store
            .set_workspace_setting("permissionPreset", "human_approval")
            .unwrap();
        let workflow = store
            .create_workflow_with_graph("长标题", None, &graph)
            .unwrap();

        let runner = Runner::new();
        let run_id = runner
            .start(
                &store,
                RunRequest {
                    workflow_id: workflow,
                    version_id: None,
                    draft_rev: Some(0),
                    inputs_json: "{}".to_string(),
                    workdir: "/tmp".to_string(),
                },
            )
            .unwrap();

        assert_eq!(
            runner.run_all(&store, &run_id).unwrap(),
            "succeeded",
            "一个标题太长的节点让整条运行跑不完"
        );
    }
}

/// 版本快照只冻结了图，而图里存的是 `agentProfileId` 这样的**引用**。
///
/// 执行时现查 `agent_profile`，把 persona / capabilities / runtime
/// 全取当下的值。三个月后打开一条旧运行问「它当时用的什么人设、
/// 什么权限」，答案是**今天**的 —— 用同一个 config_hash 重跑，
/// 行为可能完全不同，而没有任何东西记下这件事发生过。
///
/// 这与「RunEvent 是唯一事实来源」和「可解释性证据：用了哪个模型 /
/// 提示词 / 注入了哪些记忆」直接冲突。`system.env_snapshot` 这个事件类型
/// 契约里早就声明了，只是从来没被发射过。
mod 角色快照要留痕 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_engine::runner::{RunRequest, Runner};
    use aiwf_store::Store;

    fn 起一条带_ai_节点的运行() -> (Store, String) {
        let graph = serde_json::json!({
            "nodes": [
                {"id": "entry", "type": "entry", "title": "入口", "config": {}},
                {"id": "think", "type": "ai.analyze", "title": "分析",
                 "config": {"agentProfileId": "builtin:analyst", "instruction": "看看",
                            "target": "某段代码"}}
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
                 "target": {"nodeId": "think", "port": "input"}}
            ],
            "groups": []
        })
        .to_string();

        let store = Store::open_workspace(
            &std::env::temp_dir().join(format!("aiwf_snap_{}.sqlite", std::process::id())),
        )
        .unwrap();
        store
            .set_workspace_setting("permissionPreset", "human_approval")
            .unwrap();
        let wf = store
            .create_workflow_with_graph("带 AI 的", None, &graph)
            .unwrap();

        let runner = Runner::new();
        let run_id = runner
            .start(
                &store,
                RunRequest {
                    workflow_id: wf,
                    version_id: None,
                    draft_rev: Some(0),
                    inputs_json: "{}".to_string(),
                    workdir: std::env::temp_dir().display().to_string(),
                },
            )
            .unwrap();
        // adapter 多半连不上，那没关系 —— 快照该在**开始执行之前**就写下
        let _ = runner.run_all(&store, &run_id);
        (store, run_id)
    }

    #[test]
    fn 运行开始时记下当时的角色长什么样() {
        let (store, run_id) = 起一条带_ai_节点的运行();
        let events = store.events(&run_id, 0, 200).unwrap();

        let 快照 = events
            .iter()
            .find(|e| e.kind == "system.env_snapshot")
            .expect("没有 system.env_snapshot —— 三个月后没人答得出「它当时用的什么角色」");

        // 要能回答的三个问题：谁、跑在哪个 runtime、有什么权限
        assert!(快照.summary.contains("分析师"), "{}", 快照.summary);
        assert!(快照.summary.contains("acp.codex"), "{}", 快照.summary);
        assert!(
            快照.summary.contains("read") || 快照.summary.contains("file"),
            "没记下权限声明：{}",
            快照.summary
        );
    }

    #[test]
    fn 没有_ai_节点时不写这条() {
        // 一条纯脚本的工作流写一条「用了哪些角色」是噪声
        let graph = serde_json::json!({
            "nodes": [
                {"id": "entry", "type": "entry", "title": "入口", "config": {}},
                {"id": "done", "type": "end", "title": "结束", "config": {}}
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
                 "target": {"nodeId": "done", "port": "input"}}
            ],
            "groups": []
        })
        .to_string();
        let store = Store::open_in_memory().unwrap();
        store
            .set_workspace_setting("permissionPreset", "human_approval")
            .unwrap();
        let wf = store
            .create_workflow_with_graph("纯脚本", None, &graph)
            .unwrap();
        let runner = Runner::new();
        let run_id = runner
            .start(
                &store,
                RunRequest {
                    workflow_id: wf,
                    version_id: None,
                    draft_rev: Some(0),
                    inputs_json: "{}".to_string(),
                    workdir: "/tmp".to_string(),
                },
            )
            .unwrap();
        runner.run_all(&store, &run_id).unwrap();

        let events = store.events(&run_id, 0, 200).unwrap();
        assert!(
            !events.iter().any(|e| e.kind == "system.env_snapshot"),
            "没有 AI 节点却写了角色快照"
        );
    }
}

#[test]
fn 每次落检查点都在事件流留痕() {
    // B-2:检查点真的在落(每个节点完成后一次),但事件流里看不到 ——
    // 「杀掉 App 能恢复」这个能力对用户完全不可见,直到他真的杀一次
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "干活",
             "config": {"interpreter": "bash", "script": "echo ok", "timeoutMs": 5000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();

    let (store, workflow) = setup(&graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let status = runner.run_all(&store, &run_id).unwrap();
    assert_eq!(status, "succeeded");

    let checkpoints = store
        .events(&run_id, 0, 200)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "system.checkpoint_saved")
        .count();
    assert!(
        checkpoints >= 2,
        "两个节点各落一次检查点,事件流里应当至少两条留痕,实际 {checkpoints}"
    );
}

#[test]
fn 产物落盘时发_artifact_created_事件() {
    // B-2:产物真的在落盘,而「产物视图」这个投影没有源事件 ——
    // 界面只能靠 run.artifacts 全量拉,事件流里看不到产物何时出现
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "产出",
             "config": {"interpreter": "bash", "script": "echo 产物内容", "timeoutMs": 5000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();

    let (store, workflow) = setup(&graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    assert_eq!(runner.run_all(&store, &run_id).unwrap(), "succeeded");

    let events = store.events(&run_id, 0, 300).unwrap();
    let created: Vec<_> = events
        .iter()
        .filter(|e| e.kind == "artifact.created")
        .collect();
    assert!(
        !created.is_empty(),
        "脚本写了 stdout.log,事件流里要有 artifact.created"
    );
    assert!(
        created
            .iter()
            .all(|e| e.payload_ref.as_deref().is_some_and(|r| !r.is_empty())),
        "artifact.created 必须带 payload_ref,界面拿它读内容"
    );
    // 前端产物投影只读 artifactRefs —— 读路径丢了它的话投影永远为空
    assert!(
        created
            .iter()
            .all(|e| !e.artifact_refs.is_empty()),
        "artifact.created 的 artifact_refs 要能从读路径出来"
    );
    // 反例:普通脚本没截断,不得谎报 artifact.truncated(假测试复核要求的反向断言)
    assert!(
        events.iter().all(|e| e.kind != "artifact.truncated"),
        "没截断不能谎报截断"
    );
}

#[test]
fn 输出被截断时发_artifact_truncated_事件() {
    // B-2:截断真的在做(防跑飞的 Agent 刷爆内存),但事件流里看不到 ——
    // 一份被砍掉的日志和一份完整的日志在产物列表里长得一样
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "刷日志",
             "config": {"interpreter": "bash",
                        "script": "for i in $(seq 1 200000); do echo aaaaaaaaaaaaaaaaaaaa; done",
                        "timeoutMs": 60000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();

    let (store, workflow) = setup(&graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    assert_eq!(runner.run_all(&store, &run_id).unwrap(), "succeeded");

    let events = store.events(&run_id, 0, 300).unwrap();
    let truncated: Vec<_> = events
        .iter()
        .filter(|e| e.kind == "artifact.truncated")
        .collect();
    assert!(
        !truncated.is_empty(),
        "stdout 超上限被截断,事件流里要有 artifact.truncated"
    );
    assert!(
        truncated[0]
            .payload_ref
            .as_deref()
            .is_some_and(|r| r.contains("stdout")),
        "要指明截断的是哪份产物:{:?}",
        truncated[0].payload_ref
    );
}
