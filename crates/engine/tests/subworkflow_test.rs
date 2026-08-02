//! 子工作流：一个节点把另一条工作流跑起来。
//!
//! ## 形态
//!
//! 子调用表达成**独立的 Run + `parent_run_id`**（契约 `Run.parentRunId`，
//! 建表时就有那一列）。不是「把子图内联进父图」——
//! 内联的话运行记录里看不出边界，而「这一步实际上跑了另一条工作流」
//! 正是用户最需要看见的事。
//!
//! ## 这一版做到哪
//!
//! `mode: sync` 是真的。`parallel` **明确报「尚未实现」**，
//! 不是悄悄按 sync 跑 —— 后者会让「并发上限 5」这样的配置
//! 看起来生效而实际串行。
//!
//! 子运行停在审批点时父运行跟着等：审批本身出现在审批列表里
//! （它是一条真的 Run），用户决定之后子运行继续，父节点再往下走。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_engine::schedule::Trigger;
use aiwf_store::Store;

/// 一条会把 `${input.文本}` 写进文件的子工作流。
fn 子图(out: &std::path::Path) -> String {
    serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},
             "config":{"inputSchema":{"type":"object"}}},
            {"id":"sh","type":"script.shell","title":"写文件","position":{"x":1,"y":0},
             // 传「失败」进来时子流程自己退非零 —— 用来测「子运行失败」。
             // 不能靠「不传参数让映射解析不出来」造失败：那条路在
             // 建子运行**之前**就返回了，测到的是映射校验，不是子运行
             "config":{"interpreter":"zsh",
                       "script":format!(
                           "printf '%s' ${{input.text}} > {}\nif [ ${{input.text}} = 失败 ]; then exit 7; fi",
                           out.display())}},
            {"id":"done","type":"end","title":"结束","position":{"x":2,"y":0},
             "config":{"outcome":"success","artifacts":[]}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"sh","port":"input"}},
            {"id":"e2","source":{"nodeId":"sh","port":"success"},"target":{"nodeId":"done","port":"input"}}
        ],
        "groups": []
    })
    .to_string()
}

/// 父图：入口 → 调子工作流 → 结束（失败另有终点）。
fn 父图(child_id: &str, extra: serde_json::Value) -> String {
    let mut config = serde_json::json!({
        "workflowId": child_id,
        "versionRef": "latest",
        "mode": "sync",
        "inputMapping": { "text": "${input.说什么}" },
        "outputMapping": {},
        "concurrencyLimit": 1,
        "onFailure": "fail_parent",
        "approvalInheritance": "inherit",
    });
    if let (Some(base), Some(more)) = (config.as_object_mut(), extra.as_object()) {
        for (key, value) in more {
            base.insert(key.clone(), value.clone());
        }
    }
    serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},
             "config":{"inputSchema":{"type":"object"}}},
            {"id":"sub","type":"subworkflow","title":"调子流程","position":{"x":1,"y":0},
             "config": config},
            {"id":"ok","type":"end","title":"结束","position":{"x":2,"y":0},
             "config":{"outcome":"success","artifacts":[]}},
            {"id":"bad","type":"end","title":"结束 · 子流程失败","position":{"x":2,"y":1},
             "config":{"outcome":"failure","artifacts":[]}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"sub","port":"input"}},
            {"id":"e2","source":{"nodeId":"sub","port":"success"},"target":{"nodeId":"ok","port":"input"}},
            {"id":"e3","source":{"nodeId":"sub","port":"failed"},"target":{"nodeId":"bad","port":"input"}}
        ],
        "groups": []
    })
    .to_string()
}

struct 场地 {
    store: Store,
    _dir: tempfile::TempDir,
    workdir: std::path::PathBuf,
}

fn 场地() -> 场地 {
    let dir = tempfile::tempdir().unwrap();
    let workdir = dir.path().to_path_buf();
    场地 {
        store: Store::open_in_memory().unwrap(),
        _dir: dir,
        workdir,
    }
}

fn 跑父流程(场地: &场地, extra: serde_json::Value, inputs: &str) -> (String, String) {
    let 产出 = 场地.workdir.join("子流程写的.txt");
    let child = 场地
        .store
        .create_workflow_with_graph("子流程", None, &子图(&产出))
        .unwrap();
    let parent = 场地
        .store
        .create_workflow_with_graph("父流程", None, &父图(&child, extra))
        .unwrap();

    let runner = Runner::new();
    let run_id = runner
        .start(
            &场地.store,
            RunRequest {
                workflow_id: parent,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: inputs.to_string(),
                workdir: 场地.workdir.display().to_string(),
                trigger: Trigger::Manual,
            },
        )
        .unwrap();
    let status = runner.run_all(&场地.store, &run_id).unwrap();
    (run_id, status)
}

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
fn 子工作流真的被跑起来了_而不是节点直接标绿() {
    let 场地 = 场地();
    let (_, status) = 跑父流程(&场地, serde_json::json!({}), r#"{"说什么":"你好"}"#);

    assert_eq!(status, "succeeded", "父运行没跑完");
    let 产出 = 场地.workdir.join("子流程写的.txt");
    assert!(
        产出.exists(),
        "父运行说成功了，而子工作流的副作用一次都没发生 —— \
         那正是「节点在 IMPLEMENTED 清单里但什么都不做」"
    );
    assert_eq!(std::fs::read_to_string(&产出).unwrap(), "你好");
}

#[test]
fn 子运行是独立一条_并且指回父运行() {
    // 内联进父图的话，运行记录里看不出「这一步跑了另一条工作流」
    let 场地 = 场地();
    let (parent_run, _) = 跑父流程(&场地, serde_json::json!({}), r#"{"说什么":"嗨"}"#);

    let 子运行 = 场地.store.child_runs(&parent_run).unwrap();
    assert_eq!(子运行.len(), 1, "应当正好一条子运行：{子运行:?}");
    assert_eq!(
        子运行[0].parent_run_id.as_deref(),
        Some(parent_run.as_str())
    );
    assert_eq!(子运行[0].status, "succeeded");
}

#[test]
fn 入参映射真的传进去了() {
    // 不传的话子流程拿到空 inputs，脚本里的 ${input.text} 会报未定义引用
    let 场地 = 场地();
    跑父流程(&场地, serde_json::json!({}), r#"{"说什么":"映射过来的"}"#);
    assert_eq!(
        std::fs::read_to_string(场地.workdir.join("子流程写的.txt")).unwrap(),
        "映射过来的"
    );
}

#[test]
fn 子运行失败时父节点走_failed_端口() {
    let 场地 = 场地();
    let (parent_run, status) = 跑父流程(&场地, serde_json::json!({}), r#"{"说什么":"失败"}"#);

    assert_eq!(status, "failed", "onFailure 是 fail_parent，父运行该失败");
    let 跑过 = 跑过的节点(&场地.store, &parent_run);
    assert!(
        !跑过.contains(&"ok".to_string()),
        "子流程失败了，成功终点不该跑：{跑过:?}"
    );
}

#[test]
fn 失败策略_continue_时父运行继续往下走() {
    let 场地 = 场地();
    let (parent_run, status) = 跑父流程(
        &场地,
        serde_json::json!({ "onFailure": "continue" }),
        r#"{"说什么":"失败"}"#,
    );

    assert_eq!(status, "succeeded", "配了 continue 就不该把父运行拖挂");
    let 跑过 = 跑过的节点(&场地.store, &parent_run);
    assert!(
        跑过.contains(&"bad".to_string()),
        "continue 仍然走 failed 端口 —— 「不拖挂父运行」不等于「假装成功」：{跑过:?}"
    );
}

#[test]
fn 入参映射解析不出来时_在建子运行之前就停住() {
    /*
     * 带着一个字面量 `${input.说什么}` 跑下去的话，错误会出现在
     * 子运行的某个节点里 —— 离原因很远，而用户看到的是
     * 「子流程失败了」，完全想不到是父流程的映射没填对。
     */
    let 场地 = 场地();
    let (parent_run, status) = 跑父流程(&场地, serde_json::json!({}), "{}");

    assert_eq!(status, "failed");
    assert!(
        场地.store.child_runs(&parent_run).unwrap().is_empty(),
        "映射都没解析出来，不该已经建了子运行"
    );
    let 事件 = 场地.store.events(&parent_run, 0, 500).unwrap();
    assert!(
        事件.iter().any(|e| e.summary.contains("入参映射")),
        "要说清是映射的问题：{:?}",
        事件.iter().map(|e| &e.summary).collect::<Vec<_>>()
    );
}

#[test]
fn parallel_模式明确报尚未实现_而不是悄悄按_sync_跑() {
    /*
     * 悄悄降级是最坏的：`concurrencyLimit: 5` 看起来生效，
     * 而实际串行跑了五遍，用户等五倍的时间并且找不到原因。
     */
    let 场地 = 场地();
    let (parent_run, status) = 跑父流程(
        &场地,
        serde_json::json!({ "mode": "parallel", "concurrencyLimit": 3 }),
        r#"{"说什么":"并行"}"#,
    );

    assert_eq!(status, "failed");
    let 事件 = 场地.store.events(&parent_run, 0, 500).unwrap();
    let 说明 = 事件
        .iter()
        .find(|e| e.summary.contains("尚未实现"))
        .expect("必须明确报「尚未实现」");
    assert!(说明.summary.contains("parallel"), "{}", 说明.summary);
}

#[test]
fn 工作流调用自己时挡住_而不是无限套娃() {
    let 场地 = 场地();
    // 父流程调用它自己
    let self_ref = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},
             "config":{"inputSchema":{"type":"object"}}},
            {"id":"sub","type":"subworkflow","title":"调自己","position":{"x":1,"y":0},
             "config":{"workflowId":"SELF","versionRef":"latest","mode":"sync",
                       "inputMapping":{},"outputMapping":{},"concurrencyLimit":1,
                       "onFailure":"fail_parent","approvalInheritance":"inherit"}},
            {"id":"done","type":"end","title":"结束","position":{"x":2,"y":0},
             "config":{"outcome":"success","artifacts":[]}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"sub","port":"input"}},
            {"id":"e2","source":{"nodeId":"sub","port":"success"},"target":{"nodeId":"done","port":"input"}}
        ],
        "groups": []
    });
    let id = 场地
        .store
        .create_workflow_with_graph("自调用", None, &self_ref.to_string())
        .unwrap();
    let graph = self_ref.to_string().replace("SELF", &id);
    场地.store.save_draft(&id, &graph).unwrap();

    let runner = Runner::new();
    let run_id = runner
        .start(
            &场地.store,
            RunRequest {
                workflow_id: id,
                version_id: None,
                draft_rev: Some(1),
                inputs_json: "{}".to_string(),
                workdir: 场地.workdir.display().to_string(),
                trigger: Trigger::Manual,
            },
        )
        .unwrap();
    let status = runner.run_all(&场地.store, &run_id).unwrap();

    assert_eq!(status, "failed", "自调用必须被挡住");

    // 断言拦它的是**环检测**，不是深度上限。
    //
    // 两道防线的报错里都有「嵌套」二字，只查那两个字的话，
    // 把环检测整段删掉这条测试照样绿 —— 深度上限会在第 8 层兜住它
    // （实测：删掉环检测这条断言不变红）。判据换成「消息里点出了调用链」
    let 事件 = 场地.store.events(&run_id, 0, 500).unwrap();
    let 说明 = 事件
        .iter()
        .find(|e| e.summary.contains("调用链"))
        .unwrap_or_else(|| {
            panic!(
                "该由环检测在第一层就挡下并列出调用链：{:?}",
                事件.iter().map(|e| &e.summary).collect::<Vec<_>>()
            )
        });
    assert!(说明.summary.contains("无限套"), "{}", 说明.summary);

    // 只该建到第一层就停 —— 靠深度上限兜的话这里会有 8 条
    assert!(
        场地.store.child_runs(&run_id).unwrap().is_empty(),
        "环检测该在建子运行之前就拦住"
    );
}
