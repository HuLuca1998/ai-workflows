//! 端口路由：上游走哪个口，只有那条边的下游会跑。
//!
//! ## 这条守的是什么
//!
//! 端口此前**只进了事件摘要的文案**（「完成 · 走 success 分支」），
//! 调度器从不读它 —— `plan.rs` 的 `ready_nodes` 只数「有多少上游**节点**
//! 完成了」。于是不管上游从哪个口出去，所有下游一律执行。
//!
//! 契约声明端口、界面画出端口并给端口上色、右键还能切换端口、
//! 内置模板精心把失败分支接到失败终点 —— 四处都在认真对待端口，
//! 而引擎从头到尾没看过它一眼。
//!
//! 实测症状（run_4b439b16806ef3f3，仓库动态报告模板）：一条
//! **成功的**运行把标着「结束 · 材料不足」的失败终点也跑了一遍，
//! 事件 #78/#79 就在 #72（写报告成功）后面。整条运行状态仍是 succeeded，
//! 于是没有任何一处会报。
//!
//! ## 判据
//!
//! 一个只接在 `failed` 端口上的节点，在成功路径上**一次都不该跑**。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_engine::schedule::Trigger;
use aiwf_store::Store;

/// 一条会成功的脚本 + 两个终点：成功那个接 `success`，另一个接 `failed`。
fn 分叉图(dir: &std::path::Path) -> String {
    serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"sh","type":"script.shell","title":"跑一下","position":{"x":1,"y":0},
             "config":{"interpreter":"zsh","script":format!("echo ok > {}/成功走过.txt", dir.display())}},
            {"id":"ok","type":"end","title":"结束 · 成功","position":{"x":2,"y":0},
             "config":{"outcome":"success","artifacts":[]}},
            {"id":"bad","type":"end","title":"结束 · 失败","position":{"x":2,"y":1},
             "config":{"outcome":"failure","artifacts":[]}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"sh","port":"input"}},
            {"id":"e2","source":{"nodeId":"sh","port":"success"},"target":{"nodeId":"ok","port":"input"}},
            {"id":"e3","source":{"nodeId":"sh","port":"failed"},"target":{"nodeId":"bad","port":"input"}}
        ],
        "groups": []
    })
    .to_string()
}

fn 跑一条(graph: &str, dir: &std::path::Path) -> (Store, String, String) {
    let store = Store::open_in_memory().unwrap();
    let workflow = store
        .create_workflow_with_graph("端口路由", None, graph)
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
                trigger: Trigger::Manual,
            },
        )
        .unwrap();
    let status = runner.run_all(&store, &run_id).unwrap();
    (store, run_id, status)
}

/// 这次运行里跑过的节点。
fn 跑过的节点(store: &Store, run_id: &str) -> Vec<String> {
    store
        .events(run_id, 0, 500)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "node.started")
        .filter_map(|e| e.node_id)
        .collect()
}

#[test]
fn 只接在_failed_端口上的节点_在成功路径上不会跑() {
    let dir = tempfile::tempdir().unwrap();
    let (store, run_id, status) = 跑一条(&分叉图(dir.path()), dir.path());

    assert_eq!(status, "succeeded", "这条路本来就该成功");
    let 跑过 = 跑过的节点(&store, &run_id);
    assert!(跑过.contains(&"ok".to_string()), "成功终点没跑：{跑过:?}");
    assert!(
        !跑过.contains(&"bad".to_string()),
        "脚本走的是 success 口，而只接在 failed 上的「结束 · 失败」也跑了 —— \
         端口路由没生效。实测里这让一条成功的运行同时执行了失败终点：{跑过:?}"
    );
}

#[test]
fn 出口端口写进事件的_exit_port_列_而不是只进摘要文案() {
    // 从摘要里解析的话，改一次措辞就会把调度器弄坏，
    // 而那种坏法不会有任何报错
    let dir = tempfile::tempdir().unwrap();
    let (store, run_id, _) = 跑一条(&分叉图(dir.path()), dir.path());

    let 完成事件: Vec<_> = store
        .events(&run_id, 0, 500)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "node.succeeded")
        .collect();
    assert!(!完成事件.is_empty());
    for event in &完成事件 {
        assert!(
            event.exit_port.is_some(),
            "{:?} 的 node.succeeded 没记出口端口 —— 调度器只能靠猜",
            event.node_id
        );
    }
}

#[test]
fn 脚本失败时_failed_端口的下游走不到_这是真话不是设计() {
    /*
     * **这条原来叫「失败分支上的节点在失败路径上会跑」，是条假测试。**
     *
     * 它的注释写着「守着反方向」，而断言只查了 `ok` 没跑，
     * 从没断言 `bad` 跑了 —— 于是它掩护了一个真实存在的缺口：
     * 脚本非零退出走的是 `NodeOutcome::Failed`（executor.rs:1389），
     * runner 直接写 `run.failed` 收尾，**`failed` 端口的下游一次都走不到**。
     *
     * 独立复核实测：`exit 3` 的脚本 ⇒ `failed, 跑过=["entry","sh"]`，
     * 接在 `sh.failed` 上的终点没跑。
     *
     * 现在这条测试断言的是**真实行为**，并且名字就说出了那句真话。
     * 要让失败分支真的能走，得让脚本节点在失败时走
     * `Succeeded{port:"failed"}` 而不是 `Failed` —— 那是另一件事，
     * 记在 DEBT 里（与 O-24 的人工拒批同一类）。
     */
    let dir = tempfile::tempdir().unwrap();
    let graph = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"sh","type":"script.shell","title":"注定失败","position":{"x":1,"y":0},
             "config":{"interpreter":"zsh","script":"exit 3"}},
            {"id":"ok","type":"end","title":"结束 · 成功","position":{"x":2,"y":0},
             "config":{"outcome":"success","artifacts":[]}},
            {"id":"bad","type":"end","title":"结束 · 失败","position":{"x":2,"y":1},
             "config":{"outcome":"failure","artifacts":[]}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"sh","port":"input"}},
            {"id":"e2","source":{"nodeId":"sh","port":"success"},"target":{"nodeId":"ok","port":"input"}},
            {"id":"e3","source":{"nodeId":"sh","port":"failed"},"target":{"nodeId":"bad","port":"input"}}
        ],
        "groups": []
    })
    .to_string();
    let (store, run_id, status) = 跑一条(&graph, dir.path());

    let 跑过 = 跑过的节点(&store, &run_id);
    assert_eq!(status, "failed");
    assert!(
        !跑过.contains(&"ok".to_string()),
        "脚本失败了，成功终点不该跑：{跑过:?}"
    );
    assert!(
        !跑过.contains(&"bad".to_string()),
        "如果这一条红了，说明脚本失败时已经改走 failed 端口了 —— \
         那是好事，把这条测试的名字和注释一起改掉"
    );
}

#[test]
fn 有分支的图正常跑完时判成功_而不是判卡住() {
    /*
     * 收尾判据换掉之后最容易踩的反向坑。
     *
     * 原来是「完成数 == 节点总数」。端口路由生效之后，没走到的分支上
     * 那些节点本来就不会执行，那个等式在**任何有分支的图上**都不成立 ——
     * 于是每一条正常结束的运行都会被判成 failed，而事件流看起来一切正常。
     */
    let dir = tempfile::tempdir().unwrap();
    let (_, _, status) = 跑一条(&分叉图(dir.path()), dir.path());
    assert_eq!(
        status, "succeeded",
        "图里有一个没走到的失败终点，运行就被判失败了 —— 收尾判据写反了"
    );
}
