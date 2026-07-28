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
