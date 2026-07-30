//! 临时探针：审查用，跑完即删。
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_store::Store;

fn setup(graph_json: &str) -> (Store, String) {
    let store = Store::open_in_memory().unwrap();
    store
        .set_workspace_setting("permissionPreset", "workspace_safe")
        .unwrap();
    let workflow = store
        .create_workflow_with_graph("测试流程", None, graph_json)
        .unwrap();
    (store, workflow)
}

fn request(workflow_id: &str) -> RunRequest {
    RunRequest {
        workflow_id: workflow_id.to_string(),
        version_id: None,
        draft_rev: Some(0),
        inputs_json: "{}".to_string(),
        workdir: "/tmp/aiwf-probe".to_string(),
    }
}

#[test]
fn 探针_超长节点标题() {
    let 长标题 = "标".repeat(3000);
    let graph = format!(
        r#"{{
  "nodes": [
    {{"id":"entry","type":"entry","title":"入口","position":{{"x":0,"y":0}},"config":{{}}}},
    {{"id":"work","type":"transform","title":"{长标题}","position":{{"x":1,"y":0}},"config":{{}}}},
    {{"id":"done","type":"end","title":"结束","position":{{"x":2,"y":0}},"config":{{}}}}
  ],
  "edges": [
    {{"id":"e1","source":{{"nodeId":"entry","port":"success"}},"target":{{"nodeId":"work","port":"input"}}}},
    {{"id":"e2","source":{{"nodeId":"work","port":"success"}},"target":{{"nodeId":"done","port":"input"}}}}
  ],
  "groups": []
}}"#
    );
    let (store, workflow) = setup(&graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let 结果 = runner.run_all(&store, &run_id);
    println!("超长标题 run_all => {结果:?}");
    println!("状态 => {:?}", store.run_status(&run_id));
    for e in store.events(&run_id, 0, 50).unwrap() {
        println!("  ev {} {}", e.seq, e.kind);
    }
}

#[test]
fn 探针_空图() {
    let graph = r#"{"nodes":[],"edges":[],"groups":[]}"#;
    let (store, workflow) = setup(graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    println!("空图 状态 => {:?}", store.run_status(&run_id));
    for e in store.events(&run_id, 0, 50).unwrap() {
        println!("  ev {} {} :: {}", e.seq, e.kind, e.summary);
    }
}

#[test]
fn 探针_只有入口和孤立节点() {
    let graph = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"orphan","type":"transform","title":"孤儿","position":{"x":3,"y":3},"config":{}}
  ],
  "edges": [],
  "groups": []
}"#;
    let (store, workflow) = setup(graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let 结果 = runner.run_all(&store, &run_id);
    println!("孤立节点 run_all => {结果:?}");
    println!("状态 => {:?}", store.run_status(&run_id));
    for e in store.events(&run_id, 0, 50).unwrap() {
        println!("  ev {} {} :: {}", e.seq, e.kind, e.summary);
    }
}

#[test]
fn 探针_单节点只有入口() {
    let graph = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}}
  ],
  "edges": [],
  "groups": []
}"#;
    let (store, workflow) = setup(graph);
    let runner = Runner::new();
    let run_id = runner.start(&store, request(&workflow)).unwrap();
    let 结果 = runner.run_all(&store, &run_id);
    println!("单入口 run_all => {结果:?}");
    println!("状态 => {:?}", store.run_status(&run_id));
    for e in store.events(&run_id, 0, 50).unwrap() {
        println!("  ev {} {} :: {}", e.seq, e.kind, e.summary);
    }
}

#[test]
fn 探针_超长标题走_supervisor() {
    use aiwf_engine::supervisor::Supervisor;
    let dir = std::env::temp_dir().join(format!("aiwf-probe-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("probe.sqlite");
    let _ = std::fs::remove_file(&db);
    let store = Store::open(&db).unwrap();
    store
        .set_workspace_setting("permissionPreset", "workspace_safe")
        .unwrap();
    let 长标题 = "标".repeat(3000);
    let graph = format!(
        r#"{{
  "nodes": [
    {{"id":"entry","type":"entry","title":"入口","position":{{"x":0,"y":0}},"config":{{}}}},
    {{"id":"work","type":"transform","title":"{长标题}","position":{{"x":1,"y":0}},"config":{{}}}}
  ],
  "edges": [
    {{"id":"e1","source":{{"nodeId":"entry","port":"success"}},"target":{{"nodeId":"work","port":"input"}}}}
  ],
  "groups": []
}}"#
    );
    let workflow = store
        .create_workflow_with_graph("测试流程", None, &graph)
        .unwrap();
    let sup = Supervisor::new(db.clone());
    let run_id = sup.start(&store, request(&workflow)).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(800));
    println!("supervisor 路径 状态 => {:?}", store.run_status(&run_id));
    for e in store.events(&run_id, 0, 50).unwrap() {
        println!("  ev {} {} :: {}", e.seq, e.kind, e.summary);
    }
    // 再点一次「恢复」看看
    let r = sup.resume(&store, &run_id);
    println!("resume => {r:?}");
    std::thread::sleep(std::time::Duration::from_millis(800));
    println!("resume 后状态 => {:?}", store.run_status(&run_id));
}

#[test]
fn 探针_超长单行stderr() {
    let dir = std::env::temp_dir().join("aiwf-probe-stderr");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("p.sqlite");
    let _ = std::fs::remove_file(&db);
    let store = Store::open(&db).unwrap();
    store
        .set_workspace_setting("permissionPreset", "workspace_safe")
        .unwrap();
    // 一行 5000 字符的 stderr，退出码 1
    let graph = r#"{
  "nodes": [
    {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
    {"id":"boom","type":"script.shell","title":"炸","position":{"x":1,"y":0},
     "config":{"interpreter":"bash","script":"printf 'E%.0s' {1..5000} >&2; exit 1"}}
  ],
  "edges": [
    {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"boom","port":"input"}}
  ],
  "groups": []
}"#;
    let workflow = store
        .create_workflow_with_graph("测试流程", None, graph)
        .unwrap();
    let sup = aiwf_engine::supervisor::Supervisor::new(db.clone());
    let mut req = request(&workflow);
    req.workdir = dir.display().to_string();
    let run_id = sup.start(&store, req).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2500));
    println!("状态 => {:?}", store.run_status(&run_id));
    for e in store.events(&run_id, 0, 50).unwrap() {
        let s: String = e.summary.chars().take(80).collect();
        println!("  ev {} {} :: {} (len={})", e.seq, e.kind, s, e.summary.chars().count());
    }
}

#[test]
fn 探针_两个supervisor同时恢复() {
    let dir = std::env::temp_dir().join("aiwf-probe-two-sup");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("p.sqlite");
    let marker = dir.join("side-effect.txt");
    let store = Store::open(&db).unwrap();
    store
        .set_workspace_setting("permissionPreset", "workspace_safe")
        .unwrap();
    let graph = format!(
        r#"{{
  "nodes": [
    {{"id":"entry","type":"entry","title":"入口","position":{{"x":0,"y":0}},"config":{{}}}},
    {{"id":"side","type":"script.shell","title":"有副作用","position":{{"x":1,"y":0}},
     "config":{{"interpreter":"bash","script":"sleep 0.5; echo ran >> {}"}}}}
  ],
  "edges": [
    {{"id":"e1","source":{{"nodeId":"entry","port":"success"}},"target":{{"nodeId":"side","port":"input"}}}}
  ],
  "groups": []
}}"#,
        marker.display()
    );
    let workflow = store
        .create_workflow_with_graph("测试流程", None, &graph)
        .unwrap();

    // 造一个 failed 的运行（还没跑到 side 节点）
    let runner = Runner::new();
    let mut req = request(&workflow);
    req.workdir = dir.display().to_string();
    let run_id = runner.start(&store, req).unwrap();
    store.set_run_status(&run_id, "failed", None).unwrap();

    // 桌面壳一个 Supervisor，进程内 MCP 一个 Supervisor —— 各自一份 cancels
    let sup_desktop = std::sync::Arc::new(aiwf_engine::supervisor::Supervisor::new(db.clone()));
    let sup_mcp = std::sync::Arc::new(aiwf_engine::supervisor::Supervisor::new(db.clone()));

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for (名, sup) in [("desktop", sup_desktop), ("mcp", sup_mcp)] {
        let db = db.clone();
        let run_id = run_id.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let s = Store::open(&db).unwrap();
            barrier.wait();
            let r = sup.resume(&s, &run_id);
            println!("{名} resume => {r:?}");
            std::thread::sleep(std::time::Duration::from_millis(3000));
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    let 内容 = std::fs::read_to_string(&marker).unwrap_or_default();
    println!("副作用文件行数 => {}", 内容.lines().count());
    let started = store
        .events(&run_id, 0, 200)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "node.started" && e.node_id.as_deref() == Some("side"))
        .count();
    println!("side 的 node.started 事件条数 => {started}");
    println!("最终状态 => {:?}", store.run_status(&run_id));
}
