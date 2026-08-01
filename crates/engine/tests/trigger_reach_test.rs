//! 入口节点声明的每一种触发方式，调度器都够得着。
//!
//! 这条守的是 CLAUDE.md 第二条纪律的第二种形态：**配置字段能填能存能校验，
//! 而引擎从不读它**。在这条守卫出现之前，`entry.trigger` 有五个枚举值，
//! Rust 侧 `grep trigger` **零命中** —— 用户在画布上把入口设成 `schedule`，
//! 节点标题下面老老实实显示「触发：schedule」（`graphAdapter.ts:28`），
//! 然后到点什么都不会发生，也没有任何地方告诉他不会发生。
//!
//! 守法：拿生成物里的枚举值逐个喂给 `Trigger::from_entry_config`。
//! 契约加了一个新触发方式而调度器没跟上 —— 这里立刻红。
//! **不用第二份清单**：清单会和 `match` 分头漂移，而喂真值不会。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use aiwf_engine::schedule::{DELIBERATELY_UNSCHEDULED, Trigger};

/// 生成物里 entry 节点的 trigger 枚举值。
fn 契约里的触发方式() -> Vec<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/generated/node-configs.schema.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到契约生成物 {}：{e}。先跑 pnpm contracts:gen",
            path.display()
        )
    });
    let schema: serde_json::Value = serde_json::from_str(&raw).expect("契约生成物不是合法 JSON");
    schema["entry"]["properties"]["trigger"]["enum"]
        .as_array()
        .expect("entry.trigger 在生成物里不是枚举 —— 契约结构变了，这条守卫要跟着改")
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

fn 入口配置(trigger: &str) -> serde_json::Value {
    serde_json::json!({
        "trigger": trigger,
        "workdirSource": "prompt",
        "inputSchema": { "type": "object" },
        // 两种带参数的触发方式都给上合法值，否则解析会因为缺参数而失败，
        // 那是另一回事（参数校验），不是「够不够得着」
        "scheduleTime": "09:00",
        "intervalMinutes": 30,
    })
}

#[test]
fn 契约声明的每一种触发方式调度器都认得() {
    let mut 够不着 = Vec::new();
    for kind in 契约里的触发方式() {
        if DELIBERATELY_UNSCHEDULED.iter().any(|(k, _)| *k == kind) {
            continue;
        }
        if let Err(why) = Trigger::from_entry_config(&入口配置(&kind)) {
            够不着.push(format!("{kind}：{why}"));
        }
    }
    assert!(
        够不着.is_empty(),
        "这些触发方式在契约里能选、在画布上会显示，而调度器不认：{够不着:?}。\n\
         要么实现，要么从契约的枚举里删掉，要么进 DELIBERATELY_UNSCHEDULED 并写明理由 —— \
         但别留在下拉框里让用户以为选了有用"
    );
}

#[test]
fn 白名单每一条都写了理由并且确实在契约里() {
    let 契约 = 契约里的触发方式();
    for (kind, reason) in DELIBERATELY_UNSCHEDULED {
        assert!(
            !reason.trim().is_empty(),
            "{kind} 进了白名单却没写理由 —— 下一个人无从判断该不该实现它"
        );
        assert!(
            契约.contains(&(*kind).to_string()),
            "{kind} 在白名单里但契约的枚举已经没有它了 —— 白名单该跟着删"
        );
    }
}

#[test]
fn 认不出的触发方式报错而不是当成手动() {
    // 静默降级成 manual 是最坏的结果：定时任务不跑，而界面上一切正常
    let err =
        Trigger::from_entry_config(&入口配置("webhook_v2")).expect_err("认不出的触发方式必须报错");
    assert!(err.contains("webhook_v2"), "报错要说清是哪一种：{err}");
}

#[test]
fn 这条守卫自己会红() {
    // 元测试：假装契约多了一个引擎不认的枚举值，断言上面那条会抓到
    let 假契约 = ["manual", "quantum_entanglement"];
    let 够不着: Vec<_> = 假契约
        .iter()
        .filter(|kind| Trigger::from_entry_config(&入口配置(kind)).is_err())
        .collect();
    assert_eq!(够不着.len(), 1, "守卫抓不到多出来的枚举值，那它就不是守卫");
}
