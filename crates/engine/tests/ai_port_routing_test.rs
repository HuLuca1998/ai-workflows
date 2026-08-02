//! AI 节点的出口端口，由**模型的结论**决定，不是永远取第一个。
//!
//! ## 这条守的是什么
//!
//! 端口路由（B-9）修真之前，AI 节点走哪个口无所谓 —— 所有下游一律执行，
//! 那道人工审批门每次都会停下来问人。修真之后，`outputs(...).first()`
//! 这一行让它变成了**安全缺陷**：
//!
//! `ai.review` 恒 `passed`、`ai.decide` 恒 `auto_decided`，而
//! `github-issue-fix` 里 `approve_diff`（push 前的改动确认）三条入边
//! 全是非首端口 —— 于是那道门**永远不执行**，`git push` + `gh pr create`
//! 直接跑（独立复核以模板结构 + 代码确证）。
//!
//! ## 判据
//!
//! 模型在回答里写 `PORT: <端口名>` 就走那个口；没写或写了不存在的端口，
//! **退回第一个并留一条事件** —— 静默退回等于回到缺陷本身。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::executor::choose_ai_port;

#[test]
fn 模型说走哪个口就走哪个() {
    let (port, note) = choose_ai_port(
        "ai.review",
        &["passed", "changes_requested"],
        "这份改动有三处问题…\nPORT: changes_requested",
    );
    assert_eq!(port, "changes_requested");
    assert_eq!(note, None, "说清楚了就不该有提醒");
}

#[test]
fn 大小写与前后空白都认() {
    for 回答 in [
        "port: changes_requested",
        "PORT:changes_requested",
        "  PORT:   changes_requested  ",
        "结论如下\n\nPort: changes_requested\n",
    ] {
        let (port, _) = choose_ai_port("ai.review", &["passed", "changes_requested"], 回答);
        assert_eq!(port, "changes_requested", "认不出：{回答:?}");
    }
}

#[test]
fn 没说时退回第一个并留一条提醒() {
    // 静默退回等于回到缺陷本身：那道人工门永远不执行而没人知道
    let (port, note) = choose_ai_port("ai.review", &["passed", "changes_requested"], "就这样吧");
    assert_eq!(port, "passed");
    let note = note.expect("没说走哪个口，必须留痕");
    assert!(note.contains("passed"), "提醒要说清退回到了哪个：{note}");
}

#[test]
fn 说了一个不存在的端口_退回第一个并说清() {
    let (port, note) = choose_ai_port(
        "ai.review",
        &["passed", "changes_requested"],
        "PORT: 我编的端口",
    );
    assert_eq!(port, "passed");
    let note = note.expect("端口名不对必须留痕");
    assert!(note.contains("我编的端口"), "{note}");
}

#[test]
fn 说了两次不同的端口_算没说清() {
    // 一份回答里既说走 A 又说走 B —— 按哪个都是猜
    let (port, note) = choose_ai_port(
        "ai.review",
        &["passed", "changes_requested"],
        "PORT: passed\n…想了想\nPORT: changes_requested",
    );
    assert_eq!(port, "passed");
    assert!(note.is_some(), "自相矛盾必须留痕");
}

#[test]
fn 端口清单为空时不崩() {
    let (port, _) = choose_ai_port("ai.analyze", &[], "PORT: success");
    assert_eq!(port, "success", "兜底成 success");
}

#[test]
fn 四类_ai_节点的第一个端口分别是什么() {
    // 退回时用的是各自的第一个端口，不是硬编码的 "success"
    assert_eq!(
        choose_ai_port("ai.analyze", &["success", "insufficient_context"], "").0,
        "success"
    );
    assert_eq!(
        choose_ai_port("ai.review", &["passed", "changes_requested"], "").0,
        "passed"
    );
    assert_eq!(
        choose_ai_port("ai.decide", &["auto_decided", "escalated"], "").0,
        "auto_decided"
    );
    assert_eq!(
        choose_ai_port("ai.execute", &["success", "failed", "needs_decision"], "").0,
        "success"
    );
}
