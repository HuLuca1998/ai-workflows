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

    let mut ready = plan.ready_nodes(&["entry".to_string()]);
    ready.sort();
    assert_eq!(ready, vec!["x", "y", "z"]);
}

#[test]
fn 汇聚节点要等全部上游完成() {
    let graph: WorkflowGraph = serde_json::from_str(FAN).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    // 只完成两路：汇聚节点还不能跑
    let done = vec!["entry".to_string(), "x".to_string(), "y".to_string()];
    assert!(!plan.ready_nodes(&done).contains(&"join".to_string()));

    // 三路都完成才就绪
    let all = vec![
        "entry".to_string(),
        "x".to_string(),
        "y".to_string(),
        "z".to_string(),
    ];
    assert_eq!(plan.ready_nodes(&all), vec!["join"]);
}

#[test]
fn 任一策略下有一路完成就能继续() {
    let json = FAN.replace(r#""strategy":"all""#, r#""strategy":"any""#);
    let graph: WorkflowGraph = serde_json::from_str(&json).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    // ready_nodes 返回的是「此刻所有能跑的节点」：y / z 的上游也完成了，
    // 所以它们同样就绪。这里关心的是 join 有没有解除阻塞
    let done = vec!["entry".to_string(), "x".to_string()];
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
            .ready_nodes(&["entry".to_string(), "x".to_string()])
            .contains(&"join".to_string())
    );

    let two = vec!["entry".to_string(), "x".to_string(), "y".to_string()];
    assert!(plan.ready_nodes(&two).contains(&"join".to_string()));
}

#[test]
fn 默认汇聚策略是等待全部() {
    let json = FAN.replace(r#","join":{"strategy":"all"}"#, "");
    let graph: WorkflowGraph = serde_json::from_str(&json).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();

    let two = vec!["entry".to_string(), "x".to_string(), "y".to_string()];
    assert!(!plan.ready_nodes(&two).contains(&"join".to_string()));
}

#[test]
fn 已完成的节点不会被重复调度() {
    let graph: WorkflowGraph = serde_json::from_str(LINEAR).unwrap();
    let plan = ExecutionPlan::build(&graph).unwrap();
    assert!(
        !plan
            .ready_nodes(&["entry".to_string()])
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
