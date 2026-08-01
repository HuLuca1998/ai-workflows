//! 结束节点收集最终产物 —— `end.artifacts` 从「填了不生效」变成真的。
//!
//! 两条动机，第二条更要紧：
//!
//! **一、`end.artifacts` 一直挂在 node-config-drift 的欠账里**
//! （「最终产物清单不生效，产物由各节点自己写，末尾不做汇总」）。
//! 契约里它是「最终产物」，用户填了文件名，什么都不会发生。
//!
//! **二、报告抽屉现在永远打不开。** 界面按契约的 `REPORT_ARTIFACT_NAME`
//! （`report.json`）去 `run.artifacts` 里找，而引擎只会存**固定几个名字**的
//! 产物：`stdout.log` / `agent.md` / `command.sh` …… 没有任何路径产出
//! `report.json`。那是第三种违反：界面文案承诺了一件事，实现里没有对应代码。
//!
//! 现在 `end` 节点按声明去工作目录里取文件，取到就进产物库，
//! **取不到就明确报出来**（那是配置错了，静默跳过等于把问题藏起来）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Mutex;

use aiwf_engine::executor::{NodeEvent, NodeExecutor};
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::Scope;
use aiwf_engine::runner::NodeOutcome;

fn end节点(artifacts: serde_json::Value) -> GraphNode {
    GraphNode {
        id: "end_1".to_string(),
        node_type: "end".to_string(),
        title: "结束".to_string(),
        config: serde_json::json!({ "outcome": "success", "artifacts": artifacts }),
        join: None,
    }
}

struct 场地 {
    _dir: tempfile::TempDir,
    executor: NodeExecutor,
    workdir: std::path::PathBuf,
}

fn 场地() -> 场地 {
    let dir = tempfile::tempdir().unwrap();
    let workdir = dir.path().to_path_buf();
    let executor = NodeExecutor::new(workdir.clone())
        .with_permission_preset("human_approval")
        // 产物按 run_id 分目录存，不设的话存到默认的 "run" 下 ——
        // 测试里 list("run_end_1") 就一条都读不到
        .with_run_id("run_end_1")
        .with_artifact_root(workdir.join(".aiwf-artifacts"));
    场地 {
        _dir: dir,
        executor,
        workdir,
    }
}

fn 跑(场地: &场地, node: &GraphNode) -> (NodeOutcome, Vec<NodeEvent>) {
    let events: Mutex<Vec<NodeEvent>> = Mutex::new(Vec::new());
    let outcome = 场地
        .executor
        .execute_with_sink(node, &mut Scope::new("run_end_1"), &|event| {
            events.lock().unwrap().push(event);
        })
        .unwrap();
    let events = events.lock().unwrap().clone();
    (outcome, events)
}

const 报告: &str = r#"{"schemaVer":1,"title":"周报","summary":"一切正常","outcome":"success","blocks":[{"kind":"prose","text":"没有异常"}]}"#;

#[test]
fn 声明的产物真的进产物库_报告抽屉据此才打得开() {
    let 场地 = 场地();
    std::fs::write(场地.workdir.join("report.json"), 报告).unwrap();

    let (outcome, _) = 跑(&场地, &end节点(serde_json::json!(["report.json"])));
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));

    let 产物 = 场地.executor.artifacts().list("run_end_1").unwrap();
    let 报告产物 = 产物.iter().find(|item| item.name == "report.json").expect(
        "界面按 REPORT_ARTIFACT_NAME 去 run.artifacts 里找 report.json，\
             引擎不产出的话那个抽屉永远打不开",
    );
    assert!(报告产物.bytes > 0);
}

#[test]
fn 收进去的内容与文件一模一样() {
    // 只登记名字不搬内容的话，抽屉能打开而里面是空的
    let 场地 = 场地();
    std::fs::write(场地.workdir.join("report.json"), 报告).unwrap();
    跑(&场地, &end节点(serde_json::json!(["report.json"])));

    let 存下的 = 场地
        .executor
        .artifacts()
        .read("run_end_1", "end_1/report.json", 64 * 1024)
        .expect("按相对路径读得到");
    assert_eq!(存下的.text.as_deref(), Some(报告));
}

#[test]
fn 声明了却不存在的文件明确报出来_而不是静默跳过() {
    // 静默跳过 = 用户在 end 上写了 report.json、运行绿着结束、
    // 抽屉里什么都没有，而没有一处告诉他文件名写错了
    let 场地 = 场地();
    let (outcome, events) = 跑(&场地, &end节点(serde_json::json!(["report.json"])));

    // 收不到产物不该让整条运行失败 —— 正事都做完了
    assert!(matches!(&outcome, NodeOutcome::Succeeded { .. }));
    let 提醒 = events
        .iter()
        .find(|e| e.summary.contains("report.json"))
        .expect("声明的产物没找到，事件流里必须留一条");
    assert!(
        提醒.summary.contains("没找到") || 提醒.summary.contains("不存在"),
        "事件要说清是「没找到」：{}",
        提醒.summary
    );
}

#[test]
fn 不声明产物时什么都不做() {
    let 场地 = 场地();
    std::fs::write(场地.workdir.join("report.json"), 报告).unwrap();

    跑(&场地, &end节点(serde_json::json!([])));
    assert!(
        场地
            .executor
            .artifacts()
            .list("run_end_1")
            .unwrap()
            .is_empty(),
        "没声明就不该自作主张收集 —— 工作目录里可能有几万个文件"
    );
}

#[test]
fn 路径逃逸被挡住() {
    // `../../.ssh/id_rsa` 这种。产物会进导出物与诊断包，
    // 让 end 节点能读工作目录之外的任何文件是一条真实的外泄路径
    let 场地 = 场地();
    let (outcome, events) = 跑(&场地, &end节点(serde_json::json!(["../../../etc/passwd"])));

    assert!(matches!(&outcome, NodeOutcome::Succeeded { .. }));
    assert!(
        场地
            .executor
            .artifacts()
            .list("run_end_1")
            .unwrap()
            .is_empty(),
        "工作目录之外的文件不能被收进产物"
    );
    assert!(
        events.iter().any(|e| e.summary.contains("工作目录")),
        "拦下来也要说清为什么：{events:?}"
    );
}

#[test]
fn 多个产物一起收() {
    let 场地 = 场地();
    std::fs::write(场地.workdir.join("report.json"), 报告).unwrap();
    std::fs::write(场地.workdir.join("summary.md"), "# 小结").unwrap();

    跑(
        &场地,
        &end节点(serde_json::json!(["report.json", "summary.md"])),
    );

    let 名字: Vec<String> = 场地
        .executor
        .artifacts()
        .list("run_end_1")
        .unwrap()
        .into_iter()
        .map(|item| item.name)
        .collect();
    assert!(名字.contains(&"report.json".to_string()));
    assert!(名字.contains(&"summary.md".to_string()));
}
