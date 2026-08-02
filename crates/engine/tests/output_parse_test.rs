//! `outputParse: 'json'` 解析不出来时，节点不能算成功。
//!
//! 原来无条件走 `success`：`${x.success.parsed}` 插值出**字面量 `null`**，
//! 下游 AI 拿着 `null` 写一份「一切正常」的报告。七条内置模板全都
//! 只读 `.parsed`，没有一条读 `.parseError` —— 引擎把解析失败当成
//! 一条可查询的元数据，而没有任何一处消费它。
//!
//! 现实触发路径：输出撞上 `MAX_OUTPUT_BYTES` 被截断、脚本多打一行、
//! gh 认证失效时的异常输出。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Mutex;

use aiwf_engine::executor::{NodeEvent, NodeExecutor};
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::Scope;
use aiwf_engine::runner::NodeOutcome;

fn 脚本节点(script: &str, parse: Option<&str>) -> GraphNode {
    let mut config = serde_json::json!({ "interpreter": "zsh", "script": script });
    if let Some(mode) = parse {
        config["outputParse"] = serde_json::Value::String(mode.to_string());
    }
    GraphNode {
        id: "sh".to_string(),
        node_type: "script.shell".to_string(),
        title: "跑".to_string(),
        config,
        join: None,
    }
}

fn 跑(node: &GraphNode) -> (NodeOutcome, Vec<NodeEvent>, Scope) {
    let dir = tempfile::tempdir().unwrap();
    let events: Mutex<Vec<NodeEvent>> = Mutex::new(Vec::new());
    let mut scope = Scope::new("run_parse");
    let outcome = NodeExecutor::new(dir.path().to_path_buf())
        .with_permission_preset("human_approval")
        .execute_with_sink(node, &mut scope, &|e| events.lock().unwrap().push(e))
        .unwrap();
    let events = events.lock().unwrap().clone();
    (outcome, events, scope)
}

#[test]
fn 配了_json_却解析不出来时走_failed_端口() {
    let (outcome, events, _) = 跑(&脚本节点("echo 这不是 JSON", Some("json")));
    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "failed"),
        "解析不出来却走了成功端口 —— 下游会拿到字面量 null：{outcome:?}"
    );
    assert!(
        events.iter().any(|e| e.summary.contains("解析不成 JSON")),
        "走 failed 端口也要说清为什么：{events:?}"
    );
}

#[test]
fn 解析得出来时照常走_success() {
    let (outcome, _, scope) = 跑(&脚本节点(r#"echo '{"a":1}'"#, Some("json")));
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
    let parsed = aiwf_engine::interp::interpolate("${sh.success.parsed.a}", &scope).unwrap();
    assert_eq!(parsed, "1");
}

#[test]
fn 没配输出解析的脚本不受影响() {
    // 纯文本输出的脚本本来就不产出结构化数据，不该被判失败
    let (outcome, _, _) = 跑(&脚本节点("echo 就是一段文本", None));
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
}

#[test]
fn 脚本本身失败时是节点失败_不是走失败端口() {
    // 两件事要分得开：脚本退出码非零是节点失败；
    // 退出码 0 但输出格式不对是「走失败分支」
    let (outcome, _, _) = 跑(&脚本节点("exit 3", Some("json")));
    assert!(
        matches!(&outcome, NodeOutcome::Failed { .. }),
        "脚本非零退出应当是 Failed：{outcome:?}"
    );
}
