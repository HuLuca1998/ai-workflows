//! 走到 `outcome: "failure"` 的终点，运行状态就该是 failed。
//!
//! ## 这条守的是什么
//!
//! `end` 节点的 `outcome` 在契约里是**必填**字段，枚举 `success | failure`，
//! 描述写着「运行结果」（`generated/node-configs.schema.json`）。
//! 界面画得出来、Patch 存得进去、`workflow_validate` 校验得过 ——
//! 而 `crates/engine` 里 grep `"outcome"` **零命中**。
//!
//! 运行状态只看一件事：够得着的节点是不是都完成了
//! （`runner.rs` 的 `reachable_all_done`）。于是**故意走进失败终点的运行
//! 报 succeeded**。
//!
//! ## 实测（run_e97c3005197b58d8，嵌套发布编排，2026-08-02）
//!
//! 三条运行全部走进失败路径，三条状态全是 `succeeded`：
//!
//! | 运行     | 最后到达的终点               | 那个终点的 outcome | 运行状态      |
//! | -------- | ---------------------------- | ------------------ | ------------- |
//! | 父       | 「结束 · 子流程跑不起来」    | `failure`          | **succeeded** |
//! | 子1      | 「结束 · 没扫到」            | `failure`          | **succeeded** |
//!
//! 用户在运行列表上看到三行绿的「成功」，而这条流程实际上什么都没产出。
//! 八个内置模板全都精心把失败分支接到失败终点 —— **全部是装饰**。
//!
//! ## 判据
//!
//! 同一张图，只有终点的 `outcome` 不同，运行状态必须跟着不同。
//! 「跑完了」与「跑成了」是两件事。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_engine::schedule::Trigger;
use aiwf_store::Store;

/// 一条必然走到 `outcome` 为指定值的终点的图。
fn 图(outcome: &str) -> String {
    serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"done","type":"end","title":"结束","position":{"x":1,"y":0},
             "config":{"outcome":outcome,"artifacts":[]}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"done","port":"input"}}
        ],
        "groups": []
    })
    .to_string()
}

fn 跑(graph: &str) -> String {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let workflow = store
        .create_workflow_with_graph("终点结局", None, graph)
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
                workdir: dir.path().display().to_string(),
                trigger: Trigger::Manual,
            },
        )
        .unwrap();
    runner.run_all(&store, &run_id).unwrap()
}

#[test]
fn 走到失败终点的运行状态是_failed() {
    assert_eq!(
        跑(&图("failure")),
        "failed",
        "运行走到了一个 outcome 为 failure 的终点，状态却不是 failed —— \
         `end.outcome` 在契约里是必填字段而引擎从不读它。\
         实测后果：三条全都走进失败路径的运行，列表上是三行绿的「成功」"
    );
}

#[test]
fn 走到成功终点的运行状态仍然是_succeeded() {
    // 反方向。只改 outcome 这一个字段，结论必须跟着翻过来 ——
    // 否则上面那条可能只是「什么都判成 failed」
    assert_eq!(跑(&图("success")), "succeeded");
}

#[test]
fn 有多个终点时_只要走到过一个失败终点就算失败() {
    /*
     * 并行分支各自收在自己的终点上。一条成功、一条失败时按失败算 ——
     * 「有一半没做成」不该报成功。
     *
     * 这也是内置模板的实际形状：`repo-digest` 那几条都是
     * 「正常路 → 成功终点 / 材料不足 → 失败终点」，而 join 之后
     * 两个终点可能都被走到。
     */
    let dir = tempfile::tempdir().unwrap();
    let graph = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"a","type":"end","title":"结束 · 成功","position":{"x":1,"y":0},
             "config":{"outcome":"success","artifacts":[]}},
            {"id":"b","type":"end","title":"结束 · 失败","position":{"x":1,"y":1},
             "config":{"outcome":"failure","artifacts":[]}}
        ],
        // 入口的 success 口同时接两个终点：两条都会走到
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"a","port":"input"}},
            {"id":"e2","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"b","port":"input"}}
        ],
        "groups": []
    })
    .to_string();

    let store = Store::open_in_memory().unwrap();
    let workflow = store
        .create_workflow_with_graph("两个终点", None, &graph)
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
                workdir: dir.path().display().to_string(),
                trigger: Trigger::Manual,
            },
        )
        .unwrap();
    let status = runner.run_all(&store, &run_id).unwrap();

    // 先确认两个终点真的都跑了 —— 只跑了成功那个的话，
    // 这条测试测的是别的东西
    let 跑过: Vec<String> = store
        .events(&run_id, 0, 200)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "node.started")
        .filter_map(|e| e.node_id)
        .collect();
    assert!(
        跑过.contains(&"a".to_string()) && 跑过.contains(&"b".to_string()),
        "两个终点没有都跑到，这条测试没测到该测的：{跑过:?}"
    );

    assert_eq!(status, "failed", "走到过失败终点，整条运行不该报成功");
}
