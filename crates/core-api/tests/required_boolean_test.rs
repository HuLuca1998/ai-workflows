//! 契约标了必填的布尔参数，dispatch 不能自己默认一个值。
//!
//! ## 这条守的是什么
//!
//! `dispatch.rs` 的 `boolean()` 助手是 `unwrap_or(false)`。对
//! `enabledOnly` / `includeArtifacts` 那类开关，缺省即 false 没问题。
//! 但有两个字段本身**就是那个决定**：
//!
//! - `mcp_decide_confirm` 的 `approved`
//! - `memory_toggle` 的 `enabled`
//!
//! 少传的话，调用方拿到 200 与一个成功的返回值，而实际发生的是
//! **相反的那件事**。实测撞到过：一个批准脚本把参数名写成
//! `{"id":…,"decision":"approve"}`，八次调用全部返回 200，
//! 八条确认单全被**拒批**，而主管 AI 那边看到的只是「还在等确认」——
//! 两侧都没有任何一处会报。
//!
//! `workspace_reset` 早就为同一类问题写过显式守卫（`confirm` 那段），
//! 这条把它推广成「契约说必填，就必须真的必填」。
//!
//! ## 判据
//!
//! 从 `generated/core-api.schema.json` 里捞出**每一个**声明为必填的
//! 布尔入参 —— 不是硬编码那两条。以后契约里再加一个，这条自动覆盖。
//! 少传它去调 dispatch，必须报 VALIDATION，而不是拿默认值往下走。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Mutex;

use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde_json::{Value, json};

const API_SCHEMA: &str = include_str!("../../../packages/contracts/generated/core-api.schema.json");

/// 契约方法名 → 引擎命令名。与 `crates/mcp/src/catalog.rs` 的同名函数一致 ——
/// 那份是 crate 私有的，这里为了不把它变成公开 API 而复制一小段。
fn command_name(method: &str) -> String {
    let Some((head, tail)) = method.split_once('.') else {
        return method.to_string();
    };
    let mut out = String::from(head);
    out.push('_');
    for ch in tail.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// 契约里声明为**必填布尔**的入参：`(命令名, 字段名)`。
fn 必填布尔字段() -> Vec<(String, String)> {
    let schema: Value = serde_json::from_str(API_SCHEMA).unwrap();
    let methods = schema.as_object().expect("schema 顶层是对象");

    let mut out = Vec::new();
    for (method, spec) in methods {
        let Some(input) = spec.get("input") else {
            continue;
        };
        let required: Vec<&str> = input
            .get("required")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let Some(properties) = input.get("properties").and_then(Value::as_object) else {
            continue;
        };

        for (field, shape) in properties {
            if !required.contains(&field.as_str()) {
                continue;
            }
            // `z.literal(true)` 在 JSON Schema 里是 boolean + const，
            // 一样属于「没有安全默认值」那一类
            if shape.get("type").and_then(Value::as_str) == Some("boolean") {
                out.push((command_name(method), field.clone()));
            }
        }
    }
    out.sort();
    out
}

/// 除了那个布尔以外，把这个命令**别的**必填参数都填上 ——
/// 否则报错的会是「缺少参数 id」，那条测试就变成了同义反复。
fn 其余必填参数(command: &str) -> Value {
    match command {
        // 用一条真的存在的确认单：不然报的是「不存在或已经决定过了」，
        // 而那也是 VALIDATION，测试会在错误的理由上变绿
        "mcp_decide_confirm" => json!({ "id": "__占位__" }),
        "memory_toggle" => json!({ "id": "__占位__" }),
        _ => json!({}),
    }
}

#[test]
fn 契约标必填的布尔_少传时报错而不是取默认值() {
    let 字段 = 必填布尔字段();
    assert!(
        !字段.is_empty(),
        "一个必填布尔都没捞到 —— schema 的形状变了，这条守卫已经空转"
    );

    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("aiwf.sqlite");
    let store = Mutex::new(Store::open_workspace(&db).unwrap());
    let supervisor = Supervisor::new(db);

    for (command, field) in &字段 {
        let input = 其余必填参数(command);
        let 结果 =
            aiwf_core_api::dispatch::dispatch(command, &input, &store, &supervisor, dir.path());

        let error = 结果.err().unwrap_or_else(|| {
            panic!(
                "{command} 少传必填的 `{field}` 却成功了 —— \
                 dispatch 替调用方默认了一个值。\
                 这个字段本身就是那个决定，默认它等于替用户做了相反的决定"
            )
        });
        assert_eq!(
            error.code, "VALIDATION",
            "{command} 缺 `{field}` 报的是 {}，应该是 VALIDATION：{}",
            error.code, error.message
        );
        assert!(
            error.message.contains(field.as_str()),
            "{command} 的报错没说是哪个参数缺了，调用方只能猜：{}",
            error.message
        );
    }
}

#[test]
fn 这条守卫认得出_mcp_decide_confirm_的_approved() {
    /*
     * 元测试。上面那条是从 schema 里捞的 —— 捞空了、或者 `command_name`
     * 换算错了，它一样会绿（循环体一次都不进）。
     *
     * 这里钉死实测撞到过的那一条：批准脚本参数名写错，八次调用
     * 全部 200、八条确认单全被拒批。它必须在清单里。
     */
    let 字段 = 必填布尔字段();
    assert!(
        字段.contains(&("mcp_decide_confirm".to_string(), "approved".to_string())),
        "捞出来的是 {字段:?} —— 没有 mcp_decide_confirm.approved，\
         说明 schema 路径或命令名换算不对，上面那条守卫在空转"
    );
}
