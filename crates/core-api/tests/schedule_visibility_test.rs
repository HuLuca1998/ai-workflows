//! 定时状态要在工作流列表上看得见 —— 包括「设了但不生效」那一种。
//!
//! 调度器只跑**已发布版本**（`crates/core-api/src/scheduler.rs`）。
//! 于是有一条极易踩的死路：用户在画布上设好「每天 09:00」、保存草稿、
//! 关掉应用，第二天来看什么都没跑 —— 而画布上那行「每天 09:00」
//! 还好好写着，节点配置里也一切正常。
//!
//! 这是 CLAUDE.md 第二条纪律的第二种形态在**版本层**的变体：
//! 字段真的被引擎读了，只是读的是另一份图。所以列表上要有两样东西：
//!
//! - `scheduleLabel`：已发布版本上的，**真的会跑**
//! - `schedulePendingPublish`：草稿上设了而发布版本上没有，**不会跑**

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

fn 带触发的图(trigger: serde_json::Value) -> String {
    serde_json::json!({
        "nodes": [
            { "id": "entry_1", "type": "entry", "position": { "x": 0, "y": 0 },
              "config": trigger },
            { "id": "end_1", "type": "end", "position": { "x": 200, "y": 0 },
              "config": { "outcome": "success", "artifacts": [] } },
        ],
        "edges": [
            { "id": "e1",
              "source": { "nodeId": "entry_1", "port": "success" },
              "target": { "nodeId": "end_1", "port": "input" } },
        ],
    })
    .to_string()
}

fn 每天九点() -> serde_json::Value {
    serde_json::json!({
        "trigger": "schedule",
        "scheduleTime": "09:00",
        "workdirSource": "prompt",
        "inputSchema": { "type": "object" },
    })
}

fn 手动() -> serde_json::Value {
    serde_json::json!({
        "trigger": "manual",
        "workdirSource": "prompt",
        "inputSchema": { "type": "object" },
    })
}

/// 列表里这个工作流的两个定时字段。
fn 列表上的定时(store: &Store, id: &str) -> (Option<String>, bool) {
    let page = aiwf_core_api::workflow_list(store, None, None, Some(50), Some(0)).unwrap();
    let json = serde_json::to_value(&page.items).unwrap();
    let row = json
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .expect("列表里应该有这个工作流");
    (
        row.get("scheduleLabel")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        row["schedulePendingPublish"].as_bool().unwrap_or(false),
    )
}

#[test]
fn 草稿上设了定时但没发布时明确标出来() {
    let store = Store::open_in_memory().unwrap();
    let wf = store
        .create_workflow_with_graph("每天跑一次", None, &带触发的图(每天九点()))
        .unwrap();

    let (label, pending) = 列表上的定时(&store, &wf);
    assert_eq!(
        label, None,
        "没发布过的定时不会跑，就不该在列表上写「每天 09:00」—— \
         那正是让用户以为它会跑的原因"
    );
    assert!(
        pending,
        "草稿上设了定时而它不会生效 —— 这一条必须能传到界面，\
         否则用户永远查不出「为什么没跑」"
    );
}

#[test]
fn 发布之后列表上就是那句人话() {
    let store = Store::open_in_memory().unwrap();
    let wf = store
        .create_workflow_with_graph("每天跑一次", None, &带触发的图(每天九点()))
        .unwrap();
    aiwf_core_api::workflow_publish(&store, wf.clone(), 0).unwrap();

    let (label, pending) = 列表上的定时(&store, &wf);
    assert_eq!(
        label.as_deref(),
        Some("每天 09:00"),
        "措辞与画布、与 Rust 调度日志是同一句（trigger_reach_test 守着）"
    );
    assert!(!pending, "已经发布了，就不该再提示「还没发布」");
}

#[test]
fn 手动触发的工作流两个字段都是空的() {
    // 常驻的定时徽章会让真正有定时的那几条淹没在噪音里
    let store = Store::open_in_memory().unwrap();
    let wf = store
        .create_workflow_with_graph("手动跑", None, &带触发的图(手动()))
        .unwrap();
    aiwf_core_api::workflow_publish(&store, wf.clone(), 0).unwrap();

    assert_eq!(列表上的定时(&store, &wf), (None, false));
}

#[test]
fn 发布过定时之后又在草稿里改回手动_列表跟着发布版走() {
    // 已发布的那份仍然每天在跑。列表要说的是「现在实际会发生什么」，
    // 不是「你最后一次编辑打算怎样」
    let store = Store::open_in_memory().unwrap();
    let wf = store
        .create_workflow_with_graph("每天跑一次", None, &带触发的图(每天九点()))
        .unwrap();
    aiwf_core_api::workflow_publish(&store, wf.clone(), 0).unwrap();
    aiwf_core_api::workflow_save_draft(&store, wf.clone(), 0, 带触发的图(手动())).unwrap();

    let (label, pending) = 列表上的定时(&store, &wf);
    assert_eq!(
        label.as_deref(),
        Some("每天 09:00"),
        "发布版本还在每天跑，列表就得这么说"
    );
    assert!(!pending);
}

#[test]
fn 只挑入口节点的三个字段_不把整份图捞出来() {
    // 列表一次 50 行，每份图几十 KB。这条查的是「拿到的是不是配置对象」——
    // 实现换成 `SELECT graph_json` 再在 Rust 里解析的话，
    // 行为一样但列表会慢下来，而慢不会有测试发现
    let store = Store::open_in_memory().unwrap();
    let wf = store
        .create_workflow_with_graph("每天跑一次", None, &带触发的图(每天九点()))
        .unwrap();

    let config = store
        .entry_trigger(&wf, false)
        .unwrap()
        .expect("草稿上有入口节点");
    assert_eq!(config["trigger"], "schedule");
    assert!(
        config.get("nodes").is_none(),
        "拿到的应该是入口节点的 config，而不是整份图"
    );
}

#[test]
fn 没有入口节点的图不会崩() {
    let store = Store::open_in_memory().unwrap();
    let graph = serde_json::json!({ "nodes": [], "edges": [] }).to_string();
    let wf = store
        .create_workflow_with_graph("空图", None, &graph)
        .unwrap();

    assert_eq!(store.entry_trigger(&wf, false).unwrap(), None);
    assert_eq!(列表上的定时(&store, &wf), (None, false));
}
