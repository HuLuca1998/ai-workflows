//! 引擎侧的图解析与调度计划。
//!
//! 图以 JSON 存在库里（契约的 WorkflowGraph）。引擎要调度就得解析它，
//! 所以 Rust 侧有一份结构镜像——contract_sync_test 守住它不脱节。
//!
//! 调度语义来自技术选型 §13：
//! 1→N 并行分发、N→1 按汇聚策略阻塞、N→N 全部就绪后再分发。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::graph::{JoinStrategy, WorkflowGraph};
use aiwf_engine::plan::{ExecutionPlan, PlanError};

/// 一条直线：entry → a → b
const LINEAR: &str = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"a","type":"script.shell","title":"A","position":{"x":1,"y":0},"config":{"script":"echo a"}},
    {"id":"b","type":"end","title":"结束","position":{"x":2,"y":0},"config":{}}
  ],
  "edges": [
    {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"a","port":"input"}},
    {"id":"e2","source":{"nodeId":"a","port":"success"},"target":{"nodeId":"b","port":"input"}}
  ],
  "groups": []
}"#;

/// 扇出再汇聚：entry → (x, y, z) → join
const FAN: &str = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"x","type":"script.shell","title":"X","position":{"x":1,"y":0},"config":{}},
    {"id":"y","type":"script.shell","title":"Y","position":{"x":1,"y":1},"config":{}},
    {"id":"z","type":"script.shell","title":"Z","position":{"x":1,"y":2},"config":{}},
    {"id":"join","type":"end","title":"汇聚","position":{"x":2,"y":1},"config":{},
     "join":{"strategy":"all"}}
  ],
  "edges": [
    {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"x","port":"input"}},
    {"id":"e2","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"y","port":"input"}},
    {"id":"e3","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"z","port":"input"}},
    {"id":"e4","source":{"nodeId":"x","port":"success"},"target":{"nodeId":"join","port":"input"}},
    {"id":"e5","source":{"nodeId":"y","port":"success"},"target":{"nodeId":"join","port":"input"}},
    {"id":"e6","source":{"nodeId":"z","port":"success"},"target":{"nodeId":"join","port":"input"}}
  ],
  "groups": []
}"#;

#[test]
fn 解析契约格式的图() {
    let graph: WorkflowGraph = serde_json::from_str(LINEAR).unwrap();
    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.edges.len(), 2);
    assert_eq!(graph.nodes[0].id, "entry");
    assert_eq!(graph.nodes[0].node_type, "entry");
}

#[test]
fn 缺少_groups_字段也能解析_老数据不该让引擎起不来() {
    let without_groups = r#"{"nodes":[],"edges":[]}"#;
    let graph: WorkflowGraph = serde_json::from_str(without_groups).unwrap();
    assert!(graph.groups.is_empty());
}

#[test]
fn 图坏掉时报错而不是给一张空图() {
    assert!(serde_json::from_str::<WorkflowGraph>("{ 不是 JSON").is_err());
}

// ── 执行计划 ────────────────────────────────────────────────────────────────

/// 「这些节点都从 success 出去了」。
///
/// `ready_nodes` 收的是**走过的边**（节点 + 出口端口），不是节点名单 ——
/// 按节点名单判的话，`failed` 分支上的节点在成功路径上照样会被唤醒。
fn 走了success(nodes: &[&str]) -> Vec<(String, String)> {
    nodes
        .iter()
        .map(|n| ((*n).to_string(), "success".to_string()))
        .collect()
}

#[test]
fn 直线图的执行顺序就是拓扑序() {
    let graph: WorkflowGraph = serde_json::from_str(LINEAR).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();
    assert_eq!(plan.order(), &["entry", "a", "b"]);
}

#[test]
fn 入口是唯一的起点() {
    let graph: WorkflowGraph = serde_json::from_str(FAN).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();
    assert_eq!(plan.ready_nodes(&[]), vec!["entry"]);
}

#[test]
fn 扇出后三路同时就绪_这就是并行分发() {
    let graph: WorkflowGraph = serde_json::from_str(FAN).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    let mut ready = plan.ready_nodes(&走了success(&["entry"]));
    ready.sort();
    assert_eq!(ready, vec!["x", "y", "z"]);
}

#[test]
fn 汇聚节点要等全部上游完成() {
    let graph: WorkflowGraph = serde_json::from_str(FAN).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    // 只完成两路：汇聚节点还不能跑
    let done = 走了success(&["entry", "x", "y"]);
    assert!(!plan.ready_nodes(&done).contains(&"join".to_string()));

    // 三路都完成才就绪
    let all = 走了success(&["entry", "x", "y", "z"]);
    assert_eq!(plan.ready_nodes(&all), vec!["join"]);
}

#[test]
fn 任一策略下有一路完成就能继续() {
    let json = FAN.replace(r#""strategy":"all""#, r#""strategy":"any""#);
    let graph: WorkflowGraph = serde_json::from_str(&json).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    // ready_nodes 返回的是「此刻所有能跑的节点」：y / z 的上游也完成了，
    // 所以它们同样就绪。这里关心的是 join 有没有解除阻塞
    let done = 走了success(&["entry", "x"]);
    assert!(plan.ready_nodes(&done).contains(&"join".to_string()));
}

#[test]
fn quorum_策略按票数决定() {
    let json = FAN.replace(
        r#""join":{"strategy":"all"}"#,
        r#""join":{"strategy":"quorum","quorum":2}"#,
    );
    let graph: WorkflowGraph = serde_json::from_str(&json).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    assert!(
        !plan
            .ready_nodes(&走了success(&["entry", "x"]))
            .contains(&"join".to_string())
    );

    let two = 走了success(&["entry", "x", "y"]);
    assert!(plan.ready_nodes(&two).contains(&"join".to_string()));
}

#[test]
fn 默认汇聚策略是等待全部() {
    let json = FAN.replace(r#","join":{"strategy":"all"}"#, "");
    let graph: WorkflowGraph = serde_json::from_str(&json).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    let two = 走了success(&["entry", "x", "y"]);
    assert!(!plan.ready_nodes(&two).contains(&"join".to_string()));
}

#[test]
fn 已完成的节点不会被重复调度() {
    let graph: WorkflowGraph = serde_json::from_str(LINEAR).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();
    assert!(
        !plan
            .ready_nodes(&走了success(&["entry"]))
            .contains(&"entry".to_string())
    );
}

#[test]
fn 有环的图建不出计划_调度前必须先过校验() {
    let cyclic = r#"{
      "nodes":[
        {"id":"a","type":"script.shell","title":"A","position":{"x":0,"y":0},"config":{}},
        {"id":"b","type":"script.shell","title":"B","position":{"x":1,"y":0},"config":{}}
      ],
      "edges":[
        {"id":"e1","source":{"nodeId":"a","port":"success"},"target":{"nodeId":"b","port":"input"}},
        {"id":"e2","source":{"nodeId":"b","port":"success"},"target":{"nodeId":"a","port":"input"}}
      ],
      "groups":[]
    }"#;
    let graph: WorkflowGraph = serde_json::from_str(cyclic).unwrap();
    assert!(matches!(
        ExecutionPlan::build(&graph),
        Err(PlanError::Cyclic { .. })
    ));
}

#[test]
fn 连线指向不存在的节点时建计划失败() {
    let dangling = r#"{
      "nodes":[{"id":"a","type":"entry","title":"A","position":{"x":0,"y":0},"config":{}}],
      "edges":[{"id":"e1","source":{"nodeId":"a","port":"success"},"target":{"nodeId":"ghost","port":"input"}}],
      "groups":[]
    }"#;
    let graph: WorkflowGraph = serde_json::from_str(dangling).unwrap();
    assert!(matches!(
        ExecutionPlan::build(&graph),
        Err(PlanError::DanglingEdge { .. })
    ));
}

#[test]
fn 汇聚策略的字符串映射与契约一致() {
    assert_eq!(JoinStrategy::parse("all"), Some(JoinStrategy::All));
    assert_eq!(JoinStrategy::parse("any"), Some(JoinStrategy::Any));
    assert_eq!(JoinStrategy::parse("quorum"), Some(JoinStrategy::Quorum));
    assert_eq!(
        JoinStrategy::parse("sequential"),
        Some(JoinStrategy::Sequential)
    );
    assert_eq!(JoinStrategy::parse("majority"), None);
}

// ── 配置不合法时要说清是哪一个字段 ──────────────────────────────────────────
//
// 实跑时撞到的：改一个脚本节点的配置，返回「节点 push_pr 的新配置不合法」，
// 提示还写着「先用 workflow.get 读取当前草稿，再基于真实 id 重试」——
// 而 id 根本没问题。照着提示做一遍，什么也解决不了。
//
// 引擎本来就算出了逐字段的中文消息（schema.rs 与契约的 describeIssue 对齐），
// 是 `map_err(|_| …)` 把它整个丢掉了。

fn 脚本节点图() -> serde_json::Value {
    serde_json::json!({
        "nodes": [{
            "id": "s", "type": "script.shell", "title": "跑个脚本",
            "position": {"x": 0, "y": 0},
            "config": {"interpreter": "bash", "script": "echo hi", "timeoutMs": 1000}
        }],
        "edges": [], "groups": []
    })
}

#[test]
fn set_config_不合法时带上字段级原因() {
    let graph = 脚本节点图();
    let error = aiwf_engine::patch::apply_patch(
        &graph,
        0,
        &serde_json::json!({"baseRevision": 0, "operations": [{
            "op": "setConfig", "nodeId": "s",
            // interpreter 少了，且 timeoutMs 给成了字符串
            "config": {"script": "echo hi", "timeoutMs": "很久"}
        }]}),
    )
    .expect_err("配置不合法该报错");

    let text = error.to_string();
    assert!(
        text.contains("timeoutMs") || text.contains("超时"),
        "要指出是哪个字段：{text}"
    );
    assert!(text.contains('s'), "要指出是哪个节点：{text}");
}

#[test]
fn add_node_不合法时也带上字段级原因() {
    let graph = 脚本节点图();
    let error = aiwf_engine::patch::apply_patch(
        &graph,
        0,
        &serde_json::json!({"baseRevision": 0, "operations": [{
            "op": "addNode", "nodeId": "s2", "type": "script.shell",
            "title": "另一个", "position": {"x": 1, "y": 1},
            "config": {"interpreter": "不存在的解释器", "script": "echo hi"}
        }]}),
    )
    .expect_err("配置不合法该报错");

    let text = error.to_string();
    assert!(
        text.contains("解释器") || text.contains("interpreter"),
        "要指出是哪个字段：{text}"
    );
}

/// 「id 不存在」与「配置写错了」是两件要采取不同行动的事：
/// 前者去重读草稿，后者去改字段。给同一句提示的话，配置写错的人
/// 会被支去核对一个根本没问题的 id —— `RevisionConflict` 那条注释
/// 讲的就是这个道理，只是它在 Validation 内部又犯了一次。
#[test]
fn 配置不合法与_id_不存在给的提示不一样() {
    let graph = 脚本节点图();
    let patch = |op: serde_json::Value| {
        aiwf_engine::patch::apply_patch(
            &graph,
            0,
            &serde_json::json!({"baseRevision": 0, "operations": [op]}),
        )
        .expect_err("该报错")
    };

    let 配置错 = patch(serde_json::json!({
        "op": "setConfig", "nodeId": "s", "config": {"timeoutMs": "很久"}
    }));
    let id错 = patch(serde_json::json!({
        "op": "setConfig", "nodeId": "根本没有这个节点", "config": {}
    }));

    assert_eq!(配置错.code(), "VALIDATION");
    assert_eq!(id错.code(), "VALIDATION");
    assert_ne!(
        配置错.hint(),
        id错.hint(),
        "两种错该给不同的下一步：{} / {}",
        配置错.hint(),
        id错.hint()
    );
    assert!(
        !配置错.hint().contains("id"),
        "配置写错了不该被支去核对 id：{}",
        配置错.hint()
    );
}
