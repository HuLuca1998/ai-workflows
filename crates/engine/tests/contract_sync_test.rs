//! 跨语言契约门禁。
//!
//! 契约的真源是 `packages/contracts`（TypeScript + Zod），Rust 侧是它的镜像。
//! 镜像会漂移，所以对着生成物校验一遍：TS 改了状态机而 Rust 没跟上，这里立刻红。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::path::PathBuf;

use aiwf_engine::status::{NodeStatus, RunStatus};

fn meta() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/generated/contracts.meta.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到契约生成物 {}：{e}。先跑 pnpm contracts:gen",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("契约生成物不是合法 JSON")
}

fn string_set(value: &serde_json::Value, key: &str) -> BTreeSet<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("契约生成物缺少数组字段 {key}"))
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

#[test]
fn 契约生成物存在且带版本号() {
    let meta = meta();
    assert!(meta["version"].as_i64().unwrap_or(0) >= 1);
}

#[test]
fn 事件类型清单非空且都是_分类点动作_形式() {
    let types = string_set(&meta(), "eventTypes");
    assert!(!types.is_empty());
    let categories = string_set(&meta(), "eventCategories");
    for t in &types {
        let prefix = t.split('.').next().unwrap_or_default();
        assert!(
            categories.contains(prefix),
            "事件 {t} 的分类 {prefix} 不在九类之内"
        );
    }
}

#[test]
fn 恰好九类事件() {
    assert_eq!(string_set(&meta(), "eventCategories").len(), 9);
}

#[test]
fn 节点类型数量与契约一致() {
    // 节点库展示 15 条，其中脚本节点合并展示；类型总数 16
    assert_eq!(string_set(&meta(), "nodeTypes").len(), 16);
}

#[test]
fn 已实现的节点类型与契约一致() {
    // **读着契约比。** 这份清单原来只活在 preflight.rs 里，界面拿不到 ——
    // 于是节点库把 6 个跑不了的类型跟能跑的摆在一起，用户搭完整条流程
    // 点了运行才知道（第三方巡检 B-06）。现在契约是真源，
    // 这条守着「Rust 的 IMPLEMENTED 别偷偷多一个或少一个」。
    let 契约 = string_set(&meta(), "implementedNodeTypes");
    let 引擎: BTreeSet<String> = aiwf_engine::preflight::IMPLEMENTED
        .iter()
        .map(|s| (*s).to_string())
        .collect();

    assert_eq!(
        引擎, 契约,
        "引擎的已实现清单与契约对不上 —— \
         多出来的会让界面替一个跑不了的节点背书，少掉的会让能跑的被标成「未实现」"
    );
}

#[test]
fn 引擎侧状态机与契约同名同数() {
    // **读着契约比，不跟字面量比。**
    //
    // 第一版把 11 个状态名硬编码在这个文件里，于是给契约加第 12 个状态、
    // 照着报错提示改完之后：pnpm test 979 passed、contract_sync 7 passed、
    // parity 10 passed —— 而契约 12 个、Rust 11 个，漂移完整出厂。
    // 守卫跟一份自己维护的副本比，等于没有守卫。
    let meta = meta();

    let 契约_run = string_set(&meta, "runStatuses");
    let 引擎_run: BTreeSet<String> = RunStatus::ALL
        .iter()
        .map(|s| s.as_str().to_string())
        .collect();
    assert_eq!(
        引擎_run, 契约_run,
        "运行状态与契约对不上。契约在 packages/contracts/src/state-machine.ts，\
         Rust 侧在 crates/engine/src/status.rs —— 两边都要改"
    );

    let 契约_node = string_set(&meta, "nodeStatuses");
    let 引擎_node: BTreeSet<String> = NodeStatus::ALL
        .iter()
        .map(|s| s.as_str().to_string())
        .collect();
    assert_eq!(引擎_node, 契约_node, "节点状态与契约对不上");
}

#[test]
fn 状态机守卫真的会因为漂移而红() {
    // 守卫本身也要被验证：它绿着但守不住，比没有更糟。
    // 这里模拟「契约多了一个状态」的情形 —— 断言比对逻辑会发现差异
    let mut 契约 = string_set(&meta(), "runStatuses");
    契约.insert("新加的状态".to_string());
    let 引擎: BTreeSet<String> = RunStatus::ALL
        .iter()
        .map(|s| s.as_str().to_string())
        .collect();

    assert_ne!(引擎, 契约, "比对逻辑发现不了多出来的状态");
}

#[test]
fn 核心_api_方法清单包含写入口() {
    let methods = string_set(&meta(), "methods");
    for required in [
        "workflow.patch",
        "workflow.publish",
        "run.start",
        "approval.decide",
    ] {
        assert!(methods.contains(required), "契约缺少方法 {required}");
    }
}

#[test]
fn 接入方式枚举与契约一致() {
    // 契约（packages/contracts/src/domain.ts 的 AGENT_RUNTIMES）是单一真源。
    // Rust 侧这份镜像脱离它的话，界面能存的值存储层会拒绝，反之亦然。
    let contracts = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("仓库根")
            .join("packages/contracts/src/domain.ts"),
    )
    .expect("读不到契约源");

    let line = contracts
        .lines()
        .find(|line| line.contains("export const AGENT_RUNTIMES"))
        .expect("契约里找不到 AGENT_RUNTIMES");

    for runtime in aiwf_store::AGENT_RUNTIMES {
        assert!(
            line.contains(&format!("'{runtime}'")),
            "Rust 侧有 {runtime}，契约里没有：{line}"
        );
    }

    let count = line.matches('\'').count() / 2;
    assert_eq!(
        count,
        aiwf_store::AGENT_RUNTIMES.len(),
        "两侧数量不一致：契约 {count} 个，Rust {} 个",
        aiwf_store::AGENT_RUNTIMES.len()
    );
}

// ── 引擎写出去的事件必须合契约（issue #1）─────────────────────────────────
//
// 界面报「run.events 的返回值不合契约」时，根因在引擎：
// `node.output_emitted` 缺 attempt。而那条约束写在契约的 superRefine 里，
// Rust 侧看不见 —— 只有真的跑一次、把返回值喂给 Zod 才会发现。
//
// 这条测试把契约里那几条**跨字段**约束抄到 Rust 侧：抄错了
// 下面「名单与契约一致」那条会红。

/// 契约 `RunEventSchema` 的 superRefine 里对 `node.*` 的要求。
fn 检查一条(event: &serde_json::Value) -> Vec<String> {
    let mut 问题 = Vec::new();
    let kind = event["type"].as_str().unwrap_or_default();

    if kind.starts_with("node.") {
        if event.get("nodeId").and_then(|v| v.as_str()).is_none() {
            问题.push(format!("{kind} 缺 nodeId"));
        }
        if event
            .get("attempt")
            .and_then(serde_json::Value::as_i64)
            .is_none()
        {
            问题.push(format!("{kind} 缺 attempt"));
        }
    }
    if event["summary"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .count()
        > 2000
    {
        问题.push(format!("{kind} 的摘要超过 2000 字符"));
    }
    问题
}

#[test]
fn 契约里对_node_事件的跨字段约束没写歪() {
    // 抄过来的规则要与契约源对得上。契约改了而这里没跟上的话，
    // 下面那条真跑一遍的测试会变成一个永远绿的摆设
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("仓库根")
            .join("packages/contracts/src/events.ts"),
    )
    .expect("读不到契约源");

    assert!(
        source.contains("node.* 事件必须携带 nodeId"),
        "契约里那条 nodeId 约束改了措辞或没了，这边的抄本要跟着改"
    );
    assert!(
        source.contains("node.* 事件必须携带 attempt"),
        "契约里那条 attempt 约束改了措辞或没了"
    );
}

#[test]
fn 跑一条含各类节点的工作流_每条事件都合契约() {
    use aiwf_engine::runner::{RunRequest, Runner};
    use aiwf_store::Store;

    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("aiwf.sqlite")).unwrap();
    store
        .set_workspace_setting("permissionPreset", "workspace_safe")
        .unwrap();

    // 脚本 + worktree：两类都会走那条「节点执行途中的事件通道」，
    // 而 issue #1 正是那条通道漏了 attempt
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "测试"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }
    std::fs::write(repo.join("README.md"), "hi").unwrap();
    for args in [vec!["add", "."], vec!["commit", "-qm", "初始"]] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }

    let graph = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"sh","type":"script.shell","title":"脚本","position":{"x":1,"y":0},
             "config":{"interpreter":"zsh","script":"echo 出来了; echo 也有错 >&2"}},
            {"id":"wt","type":"git.worktree","title":"隔离","position":{"x":2,"y":0},
             "config":{"repoRoot":"repo","baseBranch":"main","branchTemplate":"fix/合契约"}},
            {"id":"done","type":"end","title":"结束","position":{"x":3,"y":0},"config":{"outcome":"success"}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},"target":{"nodeId":"sh","port":"input"}},
            {"id":"e2","source":{"nodeId":"sh","port":"success"},"target":{"nodeId":"wt","port":"input"}},
            {"id":"e3","source":{"nodeId":"wt","port":"success"},"target":{"nodeId":"done","port":"input"}}
        ],
        "groups": []
    });
    let workflow = store
        .create_workflow_with_graph("合契约", None, &graph.to_string())
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
                trigger: aiwf_engine::schedule::Trigger::Manual,
            },
        )
        .unwrap();
    let _ = runner.run_all(&store, &run_id);

    let events = store.events(&run_id, 0, 500).unwrap();
    assert!(
        events.len() > 6,
        "没跑起来，这条测试什么都没验：{} —— {:?}",
        events.len(),
        events
            .iter()
            .map(|e| (
                e.kind.clone(),
                e.node_id.clone(),
                e.exit_port.clone(),
                e.summary.chars().take(40).collect::<String>()
            ))
            .collect::<Vec<_>>()
    );

    let mut 问题 = Vec::new();
    for event in &events {
        let value = serde_json::json!({
            "type": event.kind,
            "nodeId": event.node_id,
            "attempt": event.attempt,
            "summary": event.summary,
        });
        for 一条 in 检查一条(&value) {
            问题.push(format!("seq {}：{一条}", event.seq));
        }
    }

    assert!(
        问题.is_empty(),
        "{} 条事件不合契约：\n{}",
        问题.len(),
        问题.join("\n")
    );
}
