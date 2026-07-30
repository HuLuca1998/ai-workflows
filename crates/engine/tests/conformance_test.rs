//! 跨语言一致性：Rust 的图校验 / Patch 必须与 TypeScript 那份逐字一致。
//!
//! 夹具的输入写在 `packages/contracts/src/conformance.ts`，期望输出由
//! `pnpm contracts:gen` 用 TypeScript 那份实现算出来，落在
//! `packages/contracts/generated/conformance.json`。
//!
//! 存在的理由：`workflow.patch` / `workflow.validate` 从 M0 起就只有
//! TypeScript 一份实现，于是从 MCP 连进来的 Agent 根本改不动工作流。
//! 补第二份实现的代价是「两份会漂移」——漂移的样子是用户在界面上
//! 连得上一条线，Agent 却被告知「没有这个输出端口」，两句话互相矛盾。
//! 这条测试就是那个代价的对冲。
//!
//! **连错误文案都比**：用户看到的那句话不该取决于他走的是界面还是 MCP。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::diff::diff_graphs;
use aiwf_engine::patch::{PatchError, apply_patch};
use aiwf_engine::validate::validate_graph;
use serde_json::Value;

const 夹具: &str = include_str!("../../../packages/contracts/generated/conformance.json");

fn 用例() -> Vec<Value> {
    let root: Value = serde_json::from_str(夹具).expect("夹具不是合法 JSON");
    root.get("cases")
        .and_then(Value::as_array)
        .expect("夹具缺 cases")
        .clone()
}

#[test]
fn 夹具不是空的() {
    // 生成器出错时会写出一个空数组，那时下面每条断言都「通过」——
    // 而实际上什么都没比
    assert!(用例().len() >= 30, "夹具用例太少，多半是生成器写歪了");
}

#[test]
fn 图校验与_typescript_逐字一致() {
    let mut 失败 = Vec::new();
    let mut 比过 = 0_usize;

    for case in 用例() {
        let Some(期望) = case.get("validation") else {
            continue;
        };
        比过 += 1;
        let name = case["name"].as_str().unwrap_or("(无名)");
        let 实得 = serde_json::to_value(validate_graph(&case["graph"])).unwrap();

        if &实得 != 期望 {
            失败.push(format!(
                "【{name}】\n  期望：{}\n  实得：{}",
                serde_json::to_string(期望).unwrap(),
                serde_json::to_string(&实得).unwrap()
            ));
        }
    }

    assert!(
        失败.is_empty(),
        "{} 条不一致：\n{}",
        失败.len(),
        失败.join("\n")
    );
    // **比过多少条也要断言**。上面那个 `continue` 看的是夹具里的键名，
    // 键名一改（或生成器换了形状）就是「全部跳过、一条不比、测试全绿」——
    // 43 组夹具的保护无声归零。`夹具不是空的` 拦不住这种：
    // 用例还在，只是没有一条走进比对
    assert!(
        比过 >= 15,
        "只比了 {比过} 条 validation 夹具 —— 夹具里的键名多半变了，这条测试已经空转"
    );
}

#[test]
fn patch_与_typescript_逐字一致() {
    let mut 失败 = Vec::new();
    let mut 比过 = 0_usize;

    for case in 用例() {
        let Some(patch) = case.get("patch") else {
            continue;
        };
        比过 += 1;
        let name = case["name"].as_str().unwrap_or("(无名)");
        let 期望 = &case["result"];
        // 当前 rev 由夹具显式给出 —— 猜的话版本守卫那条路径永远走不到
        let 当前 = case["currentRevision"]
            .as_i64()
            .unwrap_or_else(|| patch["baseRevision"].as_i64().unwrap_or(0));

        let 实得 = match apply_patch(&case["graph"], 当前, patch) {
            Ok(result) => {
                let mut value = serde_json::to_value(&result).unwrap();
                value["ok"] = Value::Bool(true);
                value
            }
            Err(error) => serde_json::json!({
                "ok": false,
                "error": { "code": error.code(), "message": error.to_string() },
            }),
        };

        if &实得 != 期望 {
            失败.push(format!(
                "【{name}】\n  期望：{}\n  实得：{}",
                serde_json::to_string(期望).unwrap(),
                serde_json::to_string(&实得).unwrap()
            ));
        }
    }

    assert!(
        失败.is_empty(),
        "{} 条不一致：\n{}",
        失败.len(),
        失败.join("\n")
    );
    assert!(
        比过 >= 20,
        "只比了 {比过} 条 patch 夹具 —— 夹具里的键名多半变了，这条测试已经空转"
    );
}

#[test]
fn 图对比与_typescript_逐字一致() {
    let root: Value = serde_json::from_str(夹具).unwrap();
    let diffs = root["diffs"].as_array().cloned().unwrap_or_default();
    assert!(diffs.len() >= 6, "diff 夹具太少");

    let mut 失败 = Vec::new();
    for case in diffs {
        let name = case["name"].as_str().unwrap_or("(无名)");
        let 实得 = serde_json::to_value(diff_graphs(&case["before"], &case["after"])).unwrap();

        if 实得 != case["diff"] {
            失败.push(format!(
                "【{name}】\n  期望：{}\n  实得：{}",
                serde_json::to_string(&case["diff"]).unwrap(),
                serde_json::to_string(&实得).unwrap()
            ));
        }
    }

    assert!(
        失败.is_empty(),
        "{} 条不一致：\n{}",
        失败.len(),
        失败.join("\n")
    );
}

#[test]
fn 版本守卫的错误码是_revision_conflict() {
    // 单独钉一条：这个码决定界面走「重新读取草稿」还是「显示校验错误」，
    // 混成 VALIDATION 的话用户会被要求去改一个根本没问题的配置
    let graph = serde_json::json!({ "nodes": [], "edges": [], "groups": [] });
    let patch = serde_json::json!({
        "baseRevision": 7,
        "operations": [{ "op": "removeNode", "nodeId": "x" }],
    });

    let error = apply_patch(&graph, 3, &patch).expect_err("陈旧的 baseRevision 应当被拒绝");
    assert_eq!(error.code(), "REVISION_CONFLICT");
    assert!(matches!(error, PatchError::RevisionConflict { .. }));
}
