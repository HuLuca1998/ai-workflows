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

/// 除了要验的那个字段以外，把这个命令**别的**必填参数都按契约填上。
///
/// **从 schema 自己捞，不手写清单。** 手写的话下一个加必填字段的人
/// 不会想到来改这里，于是报错变成「缺少参数 name」——
/// 那时守卫测的是「有没有报错」，而不是「这个字段校验了没有」。
/// 突变验证当场抓到过：退回 `string` 之后测试照样绿。
fn 其余必填参数(command: &str, 要验的: &str) -> Value {
    let schema: Value = serde_json::from_str(API_SCHEMA).unwrap();
    let mut out = serde_json::Map::new();
    for (method, spec) in schema.as_object().expect("schema 顶层是对象") {
        if command_name(method) != command {
            continue;
        }
        let Some(input) = spec.get("input") else {
            continue;
        };
        let required: Vec<&str> = input
            .get("required")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let properties = input.get("properties").and_then(Value::as_object);
        for field in required {
            if field == 要验的 {
                continue;
            }
            let shape = properties.and_then(|p| p.get(field));
            let kind = shape
                .and_then(|s| s.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("string");
            out.insert(
                field.to_string(),
                match kind {
                    "number" | "integer" => json!(1),
                    "boolean" => json!(true),
                    "array" => json!([]),
                    "object" => json!({}),
                    // 枚举字段填它自己的第一个候选，别的字符串填占位
                    _ => shape
                        .and_then(|s| s.get("enum"))
                        .and_then(Value::as_array)
                        .and_then(|v| v.first().cloned())
                        .unwrap_or_else(|| json!("__占位__")),
                },
            );
        }
    }
    Value::Object(out)
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
        let input = 其余必填参数(command, field);
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

/// 契约里声明为**必填枚举**的入参：`(命令名, 字段名, 候选)`。
fn 必填枚举字段() -> Vec<(String, String, Vec<String>)> {
    let schema: Value = serde_json::from_str(API_SCHEMA).unwrap();
    let mut out = Vec::new();
    for (method, spec) in schema.as_object().expect("schema 顶层是对象") {
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
            let Some(values) = shape.get("enum").and_then(Value::as_array) else {
                continue;
            };
            out.push((
                command_name(method),
                field.clone(),
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
            ));
        }
    }
    out.sort();
    out
}

#[test]
fn 契约标必填的枚举_传候选之外的值时报错而不是静默降级() {
    /*
     * 与上面那条同族。**没有安全默认值的字段，认不出就要报错。**
     *
     * 实测撞到的（run_18c806db182eb3c0，真仓库的 issue 修复）：
     * 给 `approval_decide` 发 `decision: "approve"`（少个 d），
     * 引擎里判的是 `== "approved"`，别的一律当拒批 ——
     * 事件摘要成了「审批未通过：approve，走 rejected 分支」，
     * 回显了调用方的原词，读起来像「他批了但还是没过」。
     * 整条 issue 修复流程就此走进失败终点。
     */
    let 字段 = 必填枚举字段();
    assert!(
        !字段.is_empty(),
        "一个必填枚举都没捞到 —— schema 的形状变了，这条守卫已经空转"
    );

    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("aiwf.sqlite");
    let store = Mutex::new(Store::open_workspace(&db).unwrap());
    let supervisor = Supervisor::new(db);

    for (command, field, allowed) in &字段 {
        let mut input = 其余必填参数(command, field);
        // 一个绝不可能在候选里的值
        input[field] = json!("__这不是一个合法档位__");
        let 结果 =
            aiwf_core_api::dispatch::dispatch(command, &input, &store, &supervisor, dir.path());

        let Some(error) = 结果.err() else {
            panic!(
                "{command} 收到候选之外的 `{field}` 却成功了 —— \
                 候选是 {allowed:?}。认不出的值会被当成某个默认档，\
                 而那多半是相反的那一档"
            )
        };
        /*
         * **判据是「报错提到了这个字段」，不是「报了错」。**
         *
         * 第一版只断言「有 error」，而占位的 runId 会让
         * `approval_decide` 在校验 decision **之前**就因「找不到运行」失败 ——
         * 于是把校验退回 `string` 之后测试照样绿。突变验证当场抓到。
         *
         * 现在要求报错里出现字段名或候选值：那只有校验真的跑到才成立。
         */
        assert!(
            error.message.contains(field.as_str())
                || allowed.iter().any(|v| error.message.contains(v.as_str())),
            "{command} 的 `{field}` 传了非法值，报错却没提到它 —— \
             说明校验没跑到，是别的地方先失败了：{}",
            error.message
        );
        assert!(
            error.code == "VALIDATION" || 错误码例外(command, field),
            "{command} 的 `{field}` 传了非法值，报的是 {}（该是 VALIDATION）：{}",
            error.code,
            error.message
        );
    }
}

/*
 * **突变验证的结果，如实记在这里。**
 *
 * 把 `enumerated` 退回 `string`：
 *
 * | 字段                      | 守卫变红吗 |
 * | ------------------------- | ---------- |
 * | `approval_decide.decision` | ✅         |
 * | `memory_create.scope`     | ✅         |
 * | `mcp_connect.client`      | ❌         |
 *
 * 最后一条不红**不是守卫的漏洞**：`mcp_connect` 自己就拒未知客户端，
 * 而且报错里带着候选值。那里的 `enumerated` 是多一道保险，
 * 不是唯一的防线 —— 写清楚免得下一个人以为它被守着。
 */

/// 拒得响亮但错误码不是 VALIDATION 的，**逐条写明理由**。
///
/// 这条守卫要的是「认不出的值不被静默接受」，那一点上面已经断言了。
/// 错误码只影响界面怎么呈现，不影响安全性 —— 所以允许例外，
/// 但必须说清为什么，否则这个白名单会变成「哪条红了就加哪条」。
fn 错误码例外(command: &str, field: &str) -> bool {
    match (command, field) {
        // 它先按 runtime 去找 adapter，找不到时报的是「这个 runtime
        // 不支持连通性测试」—— 那句话对用户比「参数不合法」更有用，
        // 因为真正的场景是「装了但版本不对」而不是「打错字」
        ("model_sync", "runtime") => true,
        _ => false,
    }
}

#[test]
fn 这条守卫认得出_approval_decide_的_decision() {
    // 元测试。捞空了或命令名换算错了，上面那条会静默全绿
    let 字段 = 必填枚举字段();
    let 找到 = 字段
        .iter()
        .find(|(command, field, _)| command == "approval_decide" && field == "decision");
    let (_, _, allowed) = 找到.unwrap_or_else(|| {
        panic!("捞出来的是 {字段:?} —— 没有 approval_decide.decision，守卫在空转")
    });
    assert!(
        allowed.contains(&"approved".to_string()),
        "候选里没有 approved：{allowed:?}"
    );
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
