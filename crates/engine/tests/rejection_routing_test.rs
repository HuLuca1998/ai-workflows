//! 人工拒批走 `rejected` 端口 —— 图上接了它的话。
//!
//! 原来一律 `node.failed` + `run.failed`，于是画布上那条
//! `approval.rejected → 结束 · 方案被否` 的连线**一次都走不到**。
//! 内置模板 `issue-feature` 有两处这样的边（DEBT O-24）。
//!
//! 没接下游时保持判失败：那时拒批确实就是终点，发一个走不通的端口
//! 只会让运行卡在那里而看不出原因。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_engine::schedule::Trigger;
use aiwf_store::Store;

fn 图(接了拒批下游: bool) -> String {
    let mut edges = vec![
        serde_json::json!({"id":"a","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"gate","port":"input"}}),
        serde_json::json!({"id":"b","source":{"nodeId":"gate","port":"approved"},"target":{"nodeId":"ok","port":"input"}}),
    ];
    if 接了拒批下游 {
        edges.push(serde_json::json!({"id":"c","source":{"nodeId":"gate","port":"rejected"},"target":{"nodeId":"no","port":"input"}}));
    }
    let mut nodes = vec![
        serde_json::json!({"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}}),
        serde_json::json!({"id":"gate","type":"approval","title":"门","position":{"x":1,"y":0},
          "config":{"title":"确认","interaction":"confirm","decider":"user","waitStrategy":"forever"}}),
        serde_json::json!({"id":"ok","type":"end","title":"结束 · 通过","position":{"x":2,"y":0},
          "config":{"outcome":"success","artifacts":[]}}),
    ];
    if 接了拒批下游 {
        nodes.push(serde_json::json!({"id":"no","type":"end","title":"结束 · 方案被否","position":{"x":2,"y":1},
          "config":{"outcome":"failure","artifacts":[]}}));
    }
    serde_json::json!({ "nodes": nodes, "edges": edges, "groups": [] }).to_string()
}

fn 拒批一次(接了: bool) -> (Store, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let wf = store
        .create_workflow_with_graph("拒批", None, &图(接了))
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
                workdir: dir.path().display().to_string(),
                trigger: Trigger::Manual,
            },
        )
        .unwrap();
    assert_eq!(runner.run_all(&store, &run_id).unwrap(), "waiting_approval");
    runner
        .decide_approval(&store, &run_id, "gate", "rejected")
        .unwrap();
    let status = runner.run_all(&store, &run_id).unwrap();
    (store, run_id, status)
}

fn 跑过(store: &Store, run_id: &str) -> Vec<String> {
    store
        .events(run_id, 0, 500)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "node.started")
        .filter_map(|e| e.node_id)
        .collect()
}

#[test]
fn 图上接了_rejected_下游时_那条分支真的会走到() {
    let (store, run_id, _) = 拒批一次(true);
    let 跑过 = 跑过(&store, &run_id);
    assert!(
        跑过.contains(&"no".to_string()),
        "拒批之后「结束 · 方案被否」没跑 —— 画布上那条线画了却走不到：{跑过:?}"
    );
    assert!(
        !跑过.contains(&"ok".to_string()),
        "拒批却走了通过分支：{跑过:?}"
    );
}

#[test]
fn 没接_rejected_下游时仍然判失败() {
    // 那时拒批确实就是终点，发一个走不通的端口只会让运行卡在那里
    let (store, run_id, status) = 拒批一次(false);
    assert_eq!(status, "failed");
    assert!(!跑过(&store, &run_id).contains(&"ok".to_string()));
}
