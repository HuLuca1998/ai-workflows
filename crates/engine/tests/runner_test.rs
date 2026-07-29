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
        .set_workspace_setting("permissionPreset", "workspace_safe")
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

/// 只有一个 AI 节点的图。跑不动 adapter 也没关系 ——
/// 注入事件在**调用之前**就该写下，那正是要验的。
const AI_GRAPH: &str = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"think","type":"ai.analyze","title":"分析","position":{"x":1,"y":0},
     "config":{"instruction":"看一眼","runtime":"acp.claude"}}
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
    store
        .create_builtin_agent(&aiwf_store::NewAgent {
            name: "分析师".to_string(),
            role: "分析".to_string(),
            goal: "定位根因".to_string(),
            persona: "只看证据说话".to_string(),
            runtime: "acp.codex".to_string(),
            model_ref: "model:codex".to_string(),
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

#[test]
fn 运行记录说得清这一步用了哪个角色与模型() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_workspace_setting("permissionPreset", "workspace_safe")
        .unwrap();
    let agent = 建一个分析师(&store);
    let workflow = store
        .create_workflow_with_graph("测试流程", None, &挂角色的图(&agent))
        .unwrap();

    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    // adapter 多半没装，跑失败也没关系 —— 解析事件在连 adapter 之前就写下了
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    let 解析 = events
        .iter()
        .find(|e| e.kind == "system.model_resolved")
        .expect("AI 节点该留一条 system.model_resolved");

    assert_eq!(解析.node_id.as_deref(), Some("think"));
    for 片段 in ["分析师", agent.as_str(), "model:codex", "acp.codex", "cwd "] {
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
        .set_workspace_setting("permissionPreset", "workspace_safe")
        .unwrap();
    let agent = 建一个分析师(&store);
    let workflow = store
        .create_workflow_with_graph("测试流程", None, &挂角色的图(&agent))
        .unwrap();

    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 200).unwrap();
    let 类型: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();

    // adapter 装了才跑得到对话；没装的话节点会失败，那时这条不该误报
    let 连上了 = events
        .iter()
        .any(|e| e.kind == "node.succeeded" && e.node_id.as_deref() == Some("think"));
    if !连上了 {
        eprintln!("跳过：ACP adapter 没装，跑不到对话那一步");
        return;
    }

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
