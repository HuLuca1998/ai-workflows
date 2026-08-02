//! 迁移 016 之前的老事件没有 `exit_port` —— 恢复旧运行时不能瞎猜。
//!
//! 兜底成 `"success"` 是错的：真实端口不叫 success 的
//! （`approval→approved`、`ai.review→passed`、notify 失败→`failed`）
//! 一条都匹配不上入边，于是「无节点可跑」⇒ **判 succeeded 而一个节点
//! 都没跑**（独立复核实测）。
//!
//! 而这条路是够得着的：`mark_orphan_runs` 把升级前 running 的运行标成
//! interrupted，界面上的「恢复」直通这里。
//!
//! 正确做法是**通配**：端口未知时那条节点的每条出边都算走过 ——
//! 与老引擎当时的行为（所有下游一律执行）一致。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::Runner;
use aiwf_store::{NewRunEvent, Store};

fn 老事件(run_id: &str, kind: &str, node: Option<&str>) -> NewRunEvent {
    NewRunEvent {
        run_id: run_id.to_string(),
        kind: kind.to_string(),
        node_id: node.map(str::to_string),
        node_label: node.map(str::to_string),
        // 这就是重点：老库里这一列是 NULL
        exit_port: None,
        attempt: node.map(|_| 1),
        actor: "engine".to_string(),
        status: None,
        summary: "升级前写下的".to_string(),
        payload_ref: None,
        artifact_refs: Vec::new(),
        parent_event_id: None,
        sensitivity: "internal".to_string(),
        schema_ver: 1,
    }
}

#[test]
fn 恢复升级前的运行_下游接着跑而不是判成功了事() {
    let dir = tempfile::tempdir().unwrap();
    let 产出 = dir.path().join("恢复后跑的.txt");
    let graph = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"gate","type":"approval","title":"门","position":{"x":1,"y":0},
             "config":{"title":"确认","interaction":"confirm","decider":"user","waitStrategy":"forever"}},
            {"id":"after","type":"script.shell","title":"批准之后","position":{"x":2,"y":0},
             "config":{"interpreter":"zsh","script":format!("echo 跑了 > {}", 产出.display())}},
            {"id":"end","type":"end","title":"结束","position":{"x":3,"y":0},
             "config":{"outcome":"success","artifacts":[]}}
        ],
        "edges": [
            // 出口端口是 approved，**不是 success** —— 兜底成 success 就断在这
            {"id":"a","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"gate","port":"input"}},
            {"id":"b","source":{"nodeId":"gate","port":"approved"},"target":{"nodeId":"after","port":"input"}},
            {"id":"c","source":{"nodeId":"after","port":"success"},"target":{"nodeId":"end","port":"input"}}
        ],
        "groups": []
    })
    .to_string();

    let store = Store::open_in_memory().unwrap();
    let wf = store
        .create_workflow_with_graph("老运行", None, &graph)
        .unwrap();
    let run_id = store.create_run(&wf, None, Some(0), "{}").unwrap();
    store
        .set_run_workdir_for_test(&run_id, &dir.path().display().to_string())
        .unwrap();
    for (kind, node) in [
        ("run.created", None),
        ("run.started", None),
        ("node.succeeded", Some("entry")),
        ("node.succeeded", Some("gate")),
    ] {
        store.append_event(&老事件(&run_id, kind, node)).unwrap();
    }
    store.set_run_status(&run_id, "running", None).unwrap();

    let status = Runner::new().run_all(&store, &run_id).unwrap();

    let 跑过: Vec<String> = store
        .events(&run_id, 0, 500)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "node.started")
        .filter_map(|e| e.node_id)
        .collect();
    assert!(
        跑过.contains(&"after".to_string()),
        "恢复之后 after 没跑 —— 老事件的 exit_port 是 NULL，\
         兜底成 success 就匹配不上 gate 的 approved 端口。跑过：{跑过:?}"
    );
    assert!(
        产出.exists(),
        "运行说 {status}，而批准之后那一步的副作用一次都没发生"
    );
    assert_eq!(status, "succeeded");
}
