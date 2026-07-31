//! `notify` 节点。
//!
//! 这条是 DEBT.md 的 B-1：它与 `entry` / `end` 归在同一档，
//! 什么都不做直接返回成功。掩护它的有三样 —— `IMPLEMENTED` 清单让
//! Dry Run 也不报、一条叫「无桌面环境下也不应崩溃」的绿测试、
//! 以及 ROADMAP 里记为已完成的一整块。
//!
//! 那条测试的注释写着「实际发送在 Tauri 壳里做，引擎只负责记录意图」——
//! 两件事都不成立：壳里没有实现，引擎也没记任何意图。
//!
//! 现在的形态是：引擎**不自己发通知**（它是个库，没有桌面），
//! 但它要么调到一个真的发送器，要么明确报「这个环境发不了」。
//! 中间那种「什么都没做但返回成功」不再存在。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use aiwf_engine::executor::{NodeEvent, NodeExecutor};
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::Scope;
use aiwf_engine::notify::{Notification, Notifier};
use aiwf_engine::runner::NodeOutcome;

/// 记下收到了什么的假发送器。
struct 记录器 {
    收到: Mutex<Vec<Notification>>,
    结果: Result<(), String>,
}

impl 记录器 {
    fn 成功() -> Arc<Self> {
        Arc::new(Self {
            收到: Mutex::new(Vec::new()),
            结果: Ok(()),
        })
    }
    fn 失败(理由: &str) -> Arc<Self> {
        Arc::new(Self {
            收到: Mutex::new(Vec::new()),
            结果: Err(理由.to_string()),
        })
    }
}

impl Notifier for 记录器 {
    fn send(&self, notification: &Notification) -> Result<(), String> {
        self.收到.lock().unwrap().push(notification.clone());
        self.结果.clone()
    }
}

fn notify节点(config: serde_json::Value) -> GraphNode {
    GraphNode {
        id: "notify".to_string(),
        node_type: "notify".to_string(),
        title: "系统通知".to_string(),
        config,
        join: None,
    }
}

fn workdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("aiwf_notify_workdir");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 通知节点是只读的（基线风险 read_only），三档都不拦 —— 不用预批准。
fn executor() -> NodeExecutor {
    NodeExecutor::new(workdir()).with_permission_preset("human_approval")
}

#[test]
fn 没有发送器时走_failed_端口并说清原因_而不是假装成功() {
    // 这条就是 B-1。旧实现走的是 **success** 端口且不留任何事件，
    // 于是「用户第一条能跑的工作流，最后一个节点是绿的、什么也不会发生」。
    //
    // 现在走 failed 端口 + 事件里写明原因。**这不是假装成功**：
    // 端口叫 failed、事件说了没发出去、原因是一句真话。
    // 让整个节点 Failed 是另一回事 —— 通知是提醒不是产出，
    // 发不出去就把工作流拖挂反而过头了（要那样就配 onFailure: fail_node）
    let 事件: Mutex<Vec<NodeEvent>> = Mutex::new(Vec::new());
    let outcome = executor()
        .execute_with_sink(
            &notify节点(serde_json::json!({"title": "完成了", "body": "PR 已创建"})),
            &mut Scope::new("run_notify_1"),
            &|event| 事件.lock().unwrap().push(event),
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "failed"),
        "没有发送器却走了成功端口 —— 那正是 B-1：{outcome:?}"
    );

    let 事件 = 事件.lock().unwrap();
    let 记录 = 事件
        .iter()
        .find(|e| e.kind == "system.notification_sent")
        .expect("没发也要留一条 —— 旧实现连这条都没有");
    assert!(
        记录.summary.contains("没能发出"),
        "事件摘要看不出这条通知没发出去：{}",
        记录.summary
    );
}

#[test]
fn 没有发送器且配了_fail_node_时整个节点失败() {
    let outcome = executor()
        .execute(
            &notify节点(serde_json::json!({
                "title": "完成了", "body": "PR 已创建", "onFailure": "fail_node",
            })),
            &mut Scope::new("run_notify_1b"),
        )
        .unwrap();

    match &outcome {
        NodeOutcome::Failed { message } => {
            assert!(
                message.contains("通知"),
                "报错要说清是通知发不出去：{message}"
            );
        }
        other => panic!("配了 fail_node 却没失败：{other:?}"),
    }
}

#[test]
fn 有发送器时真的调它_并把标题与正文带过去() {
    let 发送器 = 记录器::成功();
    let outcome = executor()
        .with_notifier(发送器.clone())
        .execute(
            &notify节点(serde_json::json!({
                "title": "Issue 修复完成",
                "subtitle": "aiwf-e2e-fixture",
                "body": "PR 已创建，点击查看。",
                "clickAction": "open_run",
            })),
            &mut Scope::new("run_notify_2"),
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "{outcome:?}"
    );

    let 收到 = 发送器.收到.lock().unwrap();
    assert_eq!(收到.len(), 1, "该发一条，实际发了 {} 条", 收到.len());
    let n = &收到[0];
    assert_eq!(n.title, "Issue 修复完成");
    assert_eq!(n.subtitle.as_deref(), Some("aiwf-e2e-fixture"));
    assert_eq!(n.body, "PR 已创建，点击查看。");
    // 点击要跳回**这一次**运行，不是跳回列表
    assert_eq!(n.run_id, "run_notify_2");
    assert_eq!(n.click_action, "open_run");
}

#[test]
fn 标题与正文会先做变量插值() {
    // 不插值的话，用户看到的通知上写着 `${input.issue}` 这串字面量
    let 发送器 = 记录器::成功();
    let mut scope = Scope::new("run_notify_3");
    scope.set_inputs(serde_json::json!({"issue": "42"}));

    executor()
        .with_notifier(发送器.clone())
        .execute(
            &notify节点(serde_json::json!({
                "title": "Issue #${input.issue} 修好了",
                "body": "分支 fix/${input.issue}",
            })),
            &mut scope,
        )
        .unwrap();

    let 收到 = 发送器.收到.lock().unwrap();
    assert_eq!(收到[0].title, "Issue #42 修好了");
    assert_eq!(收到[0].body, "分支 fix/42");
}

#[test]
fn 发送失败时按_on_failure_办() {
    // 默认 ignore：通知发不出去不该让整条工作流失败 ——
    // 它是个提醒，不是产出
    let outcome = executor()
        .with_notifier(记录器::失败("通知权限未授予"))
        .execute(
            &notify节点(serde_json::json!({
                "title": "完成", "body": "好了", "onFailure": "ignore",
            })),
            &mut Scope::new("run_notify_4"),
        )
        .unwrap();
    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "failed"),
        "ignore 该走 failed 端口继续往下，而不是让运行挂掉：{outcome:?}"
    );

    // fail_node：用户明确要求「通知发不出去就算这一步失败」
    let outcome = executor()
        .with_notifier(记录器::失败("通知权限未授予"))
        .execute(
            &notify节点(serde_json::json!({
                "title": "完成", "body": "好了", "onFailure": "fail_node",
            })),
            &mut Scope::new("run_notify_5"),
        )
        .unwrap();
    match &outcome {
        NodeOutcome::Failed { message } => {
            assert!(
                message.contains("通知权限未授予"),
                "失败原因要带回来，否则用户不知道是权限问题：{message}"
            );
        }
        other => panic!("fail_node 却没失败：{other:?}"),
    }
}

#[test]
fn 发出去要留一条事件() {
    // 「RunEvent 是唯一事实来源」。通知发生在应用之外，
    // 事件流是**唯一**能回答「到底有没有发出去」的地方 ——
    // 而用户抱怨「我没收到通知」时，第一个要分清的就是
    // 「没发」还是「发了但系统没显示」
    let 事件: Mutex<Vec<NodeEvent>> = Mutex::new(Vec::new());
    let outcome = executor()
        .with_notifier(记录器::成功())
        .execute_with_sink(
            &notify节点(serde_json::json!({"title": "完成", "body": "好了"})),
            &mut Scope::new("run_notify_6"),
            &|event| 事件.lock().unwrap().push(event),
        )
        .unwrap();
    assert!(matches!(&outcome, NodeOutcome::Succeeded { .. }));

    let 事件 = 事件.lock().unwrap();
    let 发了 = 事件
        .iter()
        .find(|e| e.kind == "system.notification_sent")
        .expect("发出去了却没留事件");
    assert!(发了.summary.contains("完成"), "{}", 发了.summary);
}

#[test]
fn 发不出去也要留事件_而且要能看出是没发() {
    let 事件: Mutex<Vec<NodeEvent>> = Mutex::new(Vec::new());
    executor()
        .with_notifier(记录器::失败("用户拒绝了通知权限"))
        .execute_with_sink(
            &notify节点(serde_json::json!({"title": "完成", "body": "好了"})),
            &mut Scope::new("run_notify_7"),
            &|event| 事件.lock().unwrap().push(event),
        )
        .unwrap();

    let 事件 = 事件.lock().unwrap();
    let 记录 = 事件
        .iter()
        .find(|e| e.kind == "system.notification_sent")
        .expect("没发也要留一条，否则事件流里这一步是空白");
    assert!(
        记录.summary.contains("没能发出") || 记录.summary.contains("失败"),
        "事件摘要看不出这条通知没发出去：{}",
        记录.summary
    );
    assert!(
        记录.summary.contains("用户拒绝了通知权限"),
        "原因要写进去：{}",
        记录.summary
    );
}

#[test]
fn 配置缺标题或正文时报错_不发一条空通知() {
    // 契约里两个都是 min(1) 的必填。发一条空通知比不发更糟：
    // 用户收到一个没有内容的横幅，不知道是哪条工作流发的
    let outcome = executor()
        .with_notifier(记录器::成功())
        .execute(
            &notify节点(serde_json::json!({"body": "只有正文"})),
            &mut Scope::new("run_notify_8"),
        );
    assert!(outcome.is_err() || matches!(outcome, Ok(NodeOutcome::Failed { .. })));
}
