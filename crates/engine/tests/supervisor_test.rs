//! 后台运行管理器：真起线程、真并发、真取消。
//!
//! 图纸「同一工作流可用不同参数并行运行，环境快照互不影响」——
//! 这条只有真的并发跑两个运行才能验证。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::{Duration, Instant};

use aiwf_engine::runner::RunRequest;
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;

fn db(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("aiwf_sup_{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("aiwf.db")
}

/// 一条会写文件的工作流：文件在，就证明脚本真的跑了。
fn graph_writing(marker: &str) -> String {
    serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "write", "type": "script.shell", "title": "写标记",
             "config": {"interpreter": "bash", "script": format!("echo done > {marker}"), "timeoutMs": 5000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "write", "port": "input"}}
        ],
        "groups": []
    })
    .to_string()
}

fn wait_until<F: Fn() -> bool>(check: F, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    false
}

#[test]
fn 后台运行真的执行脚本并留下副作用() {
    let path = db("effect");
    let marker = path.parent().unwrap().join("marker.txt");
    let store = Store::open(&path).unwrap();
    let workflow = store
        .create_workflow_with_graph(
            "写文件",
            None,
            &graph_writing(&marker.display().to_string()),
        )
        .unwrap();

    let supervisor = Supervisor::new(path.clone());
    let run_id = supervisor
        .start(
            &store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: path.parent().unwrap().display().to_string(),
            },
        )
        .unwrap();

    assert!(
        wait_until(|| marker.exists(), Duration::from_secs(10)),
        "脚本没有真的执行"
    );
    assert!(
        wait_until(
            || store.run_status(&run_id).unwrap().as_deref() == Some("succeeded"),
            Duration::from_secs(10)
        ),
        "状态实际：{:?}",
        store.run_status(&run_id).unwrap()
    );
}

#[test]
fn 同一工作流的两个并行运行互不影响() {
    let path = db("parallel");
    let dir = path.parent().unwrap().to_path_buf();
    let store = Store::open(&path).unwrap();

    // 脚本把 run id 写进各自的文件：串了的话文件内容会互相覆盖
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "w", "type": "script.shell", "title": "写",
             "config": {"interpreter": "bash",
                        "script": "sleep 0.2; echo $AIWF_RUN_ID > out.txt",
                        "timeoutMs": 8000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "w", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();
    let workflow = store
        .create_workflow_with_graph("并行", None, &graph)
        .unwrap();

    let supervisor = Supervisor::new(path.clone());
    let mut ids = vec![];
    for suffix in ["a", "b"] {
        let workdir = dir.join(suffix);
        std::fs::create_dir_all(&workdir).unwrap();
        ids.push(
            supervisor
                .start(
                    &store,
                    RunRequest {
                        workflow_id: workflow.clone(),
                        version_id: None,
                        draft_rev: Some(0),
                        inputs_json: "{}".to_string(),
                        workdir: workdir.display().to_string(),
                    },
                )
                .unwrap(),
        );
    }

    assert!(
        wait_until(
            || ids
                .iter()
                .all(|id| store.run_status(id).unwrap().as_deref() == Some("succeeded")),
            Duration::from_secs(20)
        ),
        "两个运行都应当成功：{:?}",
        ids.iter()
            .map(|id| store.run_status(id).unwrap())
            .collect::<Vec<_>>()
    );

    // 各自的工作目录里是各自的 run id
    for (suffix, id) in ["a", "b"].iter().zip(&ids) {
        let content = std::fs::read_to_string(dir.join(suffix).join("out.txt")).unwrap();
        assert_eq!(content.trim(), id, "{suffix} 的输出串了");
    }
}

#[test]
fn 取消能让运行停下而不是跑到底() {
    let path = db("cancel");
    let dir = path.parent().unwrap().to_path_buf();
    let store = Store::open(&path).unwrap();

    // 第一个节点慢，第二个节点写文件：取消后第二个不该留下痕迹
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "slow", "type": "script.shell", "title": "慢",
             "config": {"interpreter": "bash", "script": "sleep 2", "timeoutMs": 10000}},
            {"id": "after", "type": "script.shell", "title": "之后",
             "config": {"interpreter": "bash", "script": "echo x > after.txt", "timeoutMs": 5000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "slow", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "slow", "port": "success"},
             "target": {"nodeId": "after", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();
    let workflow = store
        .create_workflow_with_graph("可取消", None, &graph)
        .unwrap();

    let supervisor = Supervisor::new(path.clone());
    let run_id = supervisor
        .start(
            &store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: dir.display().to_string(),
            },
        )
        .unwrap();

    // 等它进到慢节点，再取消
    assert!(
        wait_until(
            || store.run_status(&run_id).unwrap().as_deref() == Some("running"),
            Duration::from_secs(5)
        ),
        "运行没有起来"
    );
    supervisor.cancel(&store, &run_id).unwrap();

    assert!(
        wait_until(
            || store.run_status(&run_id).unwrap().as_deref() == Some("cancelled"),
            Duration::from_secs(10)
        ),
        "状态实际：{:?}",
        store.run_status(&run_id).unwrap()
    );
    // 给一点时间让「如果没停」的情况暴露出来
    std::thread::sleep(Duration::from_millis(600));
    assert!(!dir.join("after.txt").exists(), "取消后下游节点仍然执行了");
}

#[test]
fn 运行到审批就停下等人_不占着线程() {
    let path = db("approval");
    let dir = path.parent().unwrap().to_path_buf();
    let store = Store::open(&path).unwrap();
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ap", "type": "approval", "title": "审批", "config": {"title": "确认"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "ap", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();
    let workflow = store
        .create_workflow_with_graph("待审", None, &graph)
        .unwrap();

    let supervisor = Supervisor::new(path.clone());
    let run_id = supervisor
        .start(
            &store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: dir.display().to_string(),
            },
        )
        .unwrap();

    assert!(
        wait_until(
            || store.run_status(&run_id).unwrap().as_deref() == Some("waiting_approval"),
            Duration::from_secs(10)
        ),
        "状态实际：{:?}",
        store.run_status(&run_id).unwrap()
    );
    assert!(!supervisor.is_active(&run_id), "挂起后不该还占着执行槽");
}

#[test]
fn 审批通过后能继续跑到结束() {
    let path = db("resume");
    let dir = path.parent().unwrap().to_path_buf();
    let store = Store::open(&path).unwrap();
    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ap", "type": "approval", "title": "审批", "config": {"title": "确认"}},
            {"id": "after", "type": "script.shell", "title": "之后",
             "config": {"interpreter": "bash", "script": "echo ok > resumed.txt", "timeoutMs": 5000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "ap", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "ap", "port": "approved"},
             "target": {"nodeId": "after", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();
    let workflow = store
        .create_workflow_with_graph("续跑", None, &graph)
        .unwrap();

    let supervisor = Supervisor::new(path.clone());
    let run_id = supervisor
        .start(
            &store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: dir.display().to_string(),
            },
        )
        .unwrap();

    assert!(wait_until(
        || store.run_status(&run_id).unwrap().as_deref() == Some("waiting_approval"),
        Duration::from_secs(10)
    ));

    supervisor
        .decide_approval(&store, &run_id, "ap", "approved")
        .unwrap();

    assert!(
        wait_until(
            || store.run_status(&run_id).unwrap().as_deref() == Some("succeeded"),
            Duration::from_secs(10)
        ),
        "状态实际：{:?}",
        store.run_status(&run_id).unwrap()
    );
    assert!(dir.join("resumed.txt").exists(), "审批后的节点没有执行");
}

#[test]
fn 杀掉进程后重新打开数据库_能回到同一审批点并跑完() {
    // M2 出口标准。这里刻意 drop 掉所有内存对象再重新打开：
    // 只要有一点状态只存在于内存里，这个测试就会失败。
    let path = db("restart");
    let dir = path.parent().unwrap().to_path_buf();

    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "prep", "type": "script.shell", "title": "准备",
             "config": {"interpreter": "bash", "script": "echo 上游产出", "timeoutMs": 8000}},
            {"id": "ap", "type": "approval", "title": "审批", "config": {"title": "确认"}},
            {"id": "use", "type": "script.shell", "title": "用上游的输出",
             "config": {"interpreter": "bash",
                        "script": "echo ${prep.success.stdout} > after-restart.txt",
                        "timeoutMs": 8000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "prep", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "prep", "port": "success"}, "target": {"nodeId": "ap", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "ap", "port": "approved"}, "target": {"nodeId": "use", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();

    // ── 第一次「启动应用」──────────────────────────────────────────────
    let run_id = {
        let store = Store::open(&path).unwrap();
        let workflow = store
            .create_workflow_with_graph("重启", None, &graph)
            .unwrap();
        let supervisor = Supervisor::new(path.clone());
        let run_id = supervisor
            .start(
                &store,
                RunRequest {
                    workflow_id: workflow,
                    version_id: None,
                    draft_rev: Some(0),
                    inputs_json: "{}".to_string(),
                    workdir: dir.display().to_string(),
                },
            )
            .unwrap();

        assert!(
            wait_until(
                || store.run_status(&run_id).unwrap().as_deref() == Some("waiting_approval"),
                Duration::from_secs(15)
            ),
            "第一次运行没有停在审批点：{:?}",
            store.run_status(&run_id).unwrap()
        );
        run_id
        // store 与 supervisor 在这里全部析构 —— 相当于杀掉应用
    };

    // ── 第二次「启动应用」──────────────────────────────────────────────
    let store = Store::open(&path).unwrap();
    let supervisor = Supervisor::new(path.clone());

    // 重启后仍然知道卡在哪个审批上
    assert_eq!(
        store.run_status(&run_id).unwrap().as_deref(),
        Some("waiting_approval")
    );

    supervisor
        .decide_approval(&store, &run_id, "ap", "approved")
        .unwrap();

    assert!(
        wait_until(
            || store.run_status(&run_id).unwrap().as_deref() == Some("succeeded"),
            Duration::from_secs(15)
        ),
        "重启后没跑完：{:?}",
        store.run_status(&run_id).unwrap()
    );

    // 上游节点的输出跨重启存活了：文件内容来自重启前那次执行
    let content = std::fs::read_to_string(dir.join("after-restart.txt")).unwrap();
    assert_eq!(content.trim(), "上游产出", "上游输出没能跨重启传下来");
}

#[test]
fn 事件流可完整回放_从第一条到最后一条连续无缺口() {
    // M2 出口标准第三条
    let path = db("replay");
    let dir = path.parent().unwrap().to_path_buf();
    let store = Store::open(&path).unwrap();

    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A",
             "config": {"interpreter": "bash", "script": "echo a", "timeoutMs": 8000}},
            {"id": "b", "type": "script.shell", "title": "B",
             "config": {"interpreter": "bash", "script": "echo b", "timeoutMs": 8000}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();
    let workflow = store
        .create_workflow_with_graph("回放", None, &graph)
        .unwrap();

    let supervisor = Supervisor::new(path.clone());
    let run_id = supervisor
        .start(
            &store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: dir.display().to_string(),
            },
        )
        .unwrap();

    assert!(wait_until(
        || store.run_status(&run_id).unwrap().as_deref() == Some("succeeded"),
        Duration::from_secs(20)
    ));

    let events = store.events(&run_id, 0, 1000).unwrap();
    // seq 从 1 起，逐条连续：缺一条就说明有状态变化没被记下来
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.seq, index as i64 + 1, "seq 在第 {index} 条出现缺口");
    }

    // 整条生命周期都在
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    for expected in [
        "run.created",
        "run.preflight_passed",
        "run.queued",
        "run.started",
        "run.succeeded",
    ] {
        assert!(kinds.contains(&expected), "缺少 {expected}：{kinds:?}");
    }
    // 每个节点都有开始与结束
    for node in ["entry", "a", "b"] {
        assert!(
            events
                .iter()
                .any(|e| e.kind == "node.started" && e.node_id.as_deref() == Some(node)),
            "{node} 缺少 node.started"
        );
        assert!(
            events
                .iter()
                .any(|e| e.kind == "node.succeeded" && e.node_id.as_deref() == Some(node)),
            "{node} 缺少 node.succeeded"
        );
    }
}
