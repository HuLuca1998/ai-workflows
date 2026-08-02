//! 子运行的审批：批准之后下游只跑一遍。
//!
//! ## 这条守的是什么
//!
//! `run_subworkflow` 起的子运行绕过 `Supervisor::start`，所以它不在
//! `Supervisor.cancels` 里 —— `spawn` 那道「已经在跑就别重复起」的保护
//! 看不到它。而父运行的线程本身在轮询 `child.run_all` 推进子运行。
//!
//! 于是用户在审批列表里点「通过」时：`Supervisor::decide_approval`
//! 又 spawn 一条线程，两条同时推进同一条运行，**审批下游的每个节点
//! 执行两遍**。模板里那一步是 `git push` + `gh pr create`。
//!
//! 独立复核实测：`node.started` 计数 `{entry:1, gate:1, do:2, end:1}`，
//! 副作用文件两行。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_engine::schedule::Trigger;
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;

#[test]
fn 批准子运行的审批后_下游节点只跑一遍() {
    let dir = tempfile::tempdir().unwrap();
    let 产出 = dir.path().join("副作用.txt");
    /*
     * **必须是文件库，不能是 `open_in_memory`。**
     *
     * Supervisor 起的线程会自己开一条连接。用 `:memory:` 的话它开的是
     * **另一个**空库，看不到这条运行 —— 于是「重复 spawn」这件事
     * 在测试里根本不会发生，把防重复那段删掉测试照样绿（我第一版就是这么假绿的）。
     */
    let db = dir.path().join("run.sqlite");
    let store = Store::open_workspace(&db).unwrap();

    let 子图 = serde_json::json!({
        "nodes": [
            {"id":"c_entry","type":"entry","title":"入口","position":{"x":0,"y":0},
             "config":{"inputSchema":{"type":"object"}}},
            {"id":"c_gate","type":"approval","title":"开工确认","position":{"x":1,"y":0},
             "config":{"title":"确认","interaction":"confirm","decider":"user","waitStrategy":"forever"}},
            {"id":"c_do","type":"script.shell","title":"有副作用的一步","position":{"x":2,"y":0},
             "config":{"interpreter":"zsh","script":format!("echo 跑了 >> {}", 产出.display())}},
            {"id":"c_end","type":"end","title":"结束","position":{"x":3,"y":0},
             "config":{"outcome":"success","artifacts":[]}}
        ],
        "edges": [
            {"id":"a","source":{"nodeId":"c_entry","port":"success"},"target":{"nodeId":"c_gate","port":"input"}},
            {"id":"b","source":{"nodeId":"c_gate","port":"approved"},"target":{"nodeId":"c_do","port":"input"}},
            {"id":"c","source":{"nodeId":"c_do","port":"success"},"target":{"nodeId":"c_end","port":"input"}}
        ],
        "groups": []
    })
    .to_string();
    let child_wf = store
        .create_workflow_with_graph("子流程", None, &子图)
        .unwrap();

    // 子运行直接跑（不经父流程）——「批准之后跑几遍」这件事
    // 在单层上就能验，而单层比嵌套稳定得多
    let runner = Runner::new();
    let run_id = runner
        .start(
            &store,
            RunRequest {
                workflow_id: child_wf,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: dir.path().display().to_string(),
                trigger: Trigger::Manual,
            },
        )
        .unwrap();
    assert_eq!(runner.run_all(&store, &run_id).unwrap(), "waiting_approval");

    // 手工把它标成「有父运行」—— 模拟 run_subworkflow 建出来的那种。
    // 直接跑一遍嵌套要起真线程，时序不稳。
    // 父运行得是真存在的一条（parent_run_id 有外键）
    let parent = store
        .create_run(
            &store.create_workflow("父流程", None).unwrap(),
            None,
            Some(0),
            "{}",
        )
        .unwrap();
    store.set_parent_run_for_test(&run_id, &parent).unwrap();

    let supervisor = Supervisor::new(db.clone());
    supervisor
        .decide_approval(&store, &run_id, "c_gate", "approved")
        .unwrap();
    // 父线程那一侧的推进
    runner.run_all(&store, &run_id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(600));

    let 起过几次 = store
        .events(&run_id, 0, 500)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "node.started" && e.node_id.as_deref() == Some("c_do"))
        .count();
    assert_eq!(
        起过几次, 1,
        "有副作用的节点跑了 {起过几次} 遍 —— Supervisor 又 spawn 了一条线程，\
         而父运行的线程本来就在推进这条子运行。模板里那一步是 git push + gh pr create"
    );
    let 行数 = std::fs::read_to_string(&产出)
        .map(|t| t.lines().count())
        .unwrap_or(0);
    assert_eq!(行数, 1, "副作用发生了 {行数} 次");
}
