//! MCP 写操作的确认通道：提交 → 用户批准 → **再调一次真的执行**。
//!
//! 第三步原本是断的。`call_tool` 每次都无条件重跑 `gate_for`，
//! `NeedsConfirm` 就新建一条待确认记录 —— 而**没有任何一处代码读
//! `status = 'approved'`**。设计好的三步里，第二步（`mcp.confirmStatus`）
//! 自己躺在 `DELIBERATELY_HIDDEN` 里。
//!
//! 实测过的后果：默认档下 40 多个写工具**一个都用不了**。用户看到确认卡、
//! 按下「批准这次写入」、卡片消失，而卡上那句「批准后这次写入会走
//! Core API 的版本守卫与审计」是假的 —— 什么都没写。Agent 照提示重试，
//! 每次再塞一条 pending，用户被同一个弹层反复砸。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

fn 库() -> Store {
    Store::open_in_memory().unwrap()
}

const 工具: &str = "workflow_create";
const 入参: &str = r#"{"name":"新的"}"#;

#[test]
fn 批准之后同样的入参能被认领() {
    let store = 库();
    aiwf_core_api::mcp_request_confirm(&store, 工具.to_string(), 入参.to_string()).unwrap();

    let 待办 = store.pending_confirmations().unwrap();
    assert_eq!(待办.len(), 1);
    aiwf_core_api::mcp_decide_confirm(&store, 待办[0].id.clone(), true).unwrap();

    // 这一步原本不存在 —— agent 再调一次时没有任何地方去查「批准过没有」
    let 认领到 = aiwf_core_api::mcp_claim_approved(&store, 工具, 入参).unwrap();
    assert!(认领到, "批准过的调用没被认领 —— agent 再调一次仍然会被挡住");

    assert!(
        store.pending_confirmations().unwrap().is_empty(),
        "认领之后队列该空了，否则用户会被同一个弹层反复砸"
    );
}

#[test]
fn 同一条批准只能用一次() {
    // 防重放：一次批准换一次执行。否则 agent 拿着一条旧批准
    // 可以把同一个写操作重复做任意多次
    let store = 库();
    aiwf_core_api::mcp_request_confirm(&store, 工具.to_string(), 入参.to_string()).unwrap();
    let 待办 = store.pending_confirmations().unwrap();
    aiwf_core_api::mcp_decide_confirm(&store, 待办[0].id.clone(), true).unwrap();

    assert!(aiwf_core_api::mcp_claim_approved(&store, 工具, 入参).unwrap());
    assert!(
        !aiwf_core_api::mcp_claim_approved(&store, 工具, 入参).unwrap(),
        "同一条批准被用了第二次"
    );
}

#[test]
fn 入参不一样的不算批准过() {
    // 用户批准的是「建一个叫『新的』的工作流」，不是「建任何工作流」
    let store = 库();
    aiwf_core_api::mcp_request_confirm(&store, 工具.to_string(), 入参.to_string()).unwrap();
    let 待办 = store.pending_confirmations().unwrap();
    aiwf_core_api::mcp_decide_confirm(&store, 待办[0].id.clone(), true).unwrap();

    assert!(
        !aiwf_core_api::mcp_claim_approved(&store, 工具, r#"{"name":"别的"}"#).unwrap(),
        "换了入参却认领到了上一条批准"
    );
    assert!(
        !aiwf_core_api::mcp_claim_approved(&store, "workflow_delete", 入参).unwrap(),
        "换了工具却认领到了上一条批准"
    );
}

#[test]
fn 被拒绝的不算批准过() {
    let store = 库();
    aiwf_core_api::mcp_request_confirm(&store, 工具.to_string(), 入参.to_string()).unwrap();
    let 待办 = store.pending_confirmations().unwrap();
    aiwf_core_api::mcp_decide_confirm(&store, 待办[0].id.clone(), false).unwrap();

    assert!(!aiwf_core_api::mcp_claim_approved(&store, 工具, 入参).unwrap());
}

#[test]
fn 没提交过的直接说没有() {
    let store = 库();
    assert!(!aiwf_core_api::mcp_claim_approved(&store, 工具, 入参).unwrap());
}
