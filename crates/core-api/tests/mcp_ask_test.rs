//! Agent 提问的后端链路：入队 → 用户回答 → **答案能被读回去**。
//!
//! 最后一步原本是断的。`answer_json` 写进了库，而 `mcp_confirm_status`
//! 只回 `status` —— 用户选的东西落在库里，没有任何一条 API 把它读出来。
//! 界面测得再认真，agent 拿到的仍然是「回答过了」四个字，
//! 内容一个字都没有。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

fn 库() -> Store {
    Store::open_in_memory().unwrap()
}

const 问题: &str = r#"{"kind":"choice","title":"先修哪个","options":[{"value":"a","label":"缓存"}]}"#;

#[test]
fn 回答之后结果里带着答案原文() {
    let store = 库();
    let id = aiwf_core_api::mcp_ask_user(&store, 问题.to_string()).unwrap();

    aiwf_core_api::mcp_answer_ask(&store, id.clone(), r#"{"selected":"a"}"#.to_string()).unwrap();

    let 结果 = aiwf_core_api::mcp_ask_result(&store, id).unwrap();
    assert_eq!(结果.status, "approved");
    assert_eq!(
        结果.answer_json.as_deref(),
        Some(r#"{"selected":"a"}"#),
        "用户选的东西没被读出来 —— agent 只知道「回答过了」，内容丢了"
    );
}

#[test]
fn 没回答时只有_pending_没有答案() {
    let store = 库();
    let id = aiwf_core_api::mcp_ask_user(&store, 问题.to_string()).unwrap();

    let 结果 = aiwf_core_api::mcp_ask_result(&store, id).unwrap();
    assert_eq!(结果.status, "pending");
    assert!(结果.answer_json.is_none());
}

#[test]
fn 拒绝回答的结果是_rejected_且没有答案() {
    // 「不回答」走 decideConfirm(false)。agent 该拿到「被拒绝」，
    // 而不是一个空对象 —— 空对象会被它当成「用户什么都没选」
    let store = 库();
    let id = aiwf_core_api::mcp_ask_user(&store, 问题.to_string()).unwrap();

    aiwf_core_api::mcp_decide_confirm(&store, id.clone(), false).unwrap();

    let 结果 = aiwf_core_api::mcp_ask_result(&store, id).unwrap();
    assert_eq!(结果.status, "rejected");
    assert!(结果.answer_json.is_none());
}

#[test]
fn 过期的提问读出来是_expired() {
    let store = 库();
    let id = aiwf_core_api::mcp_ask_user(&store, 问题.to_string()).unwrap();

    // 0 秒超时：立刻就算过期。真实 TTL 是常量，测试不该等三分钟
    store.expire_confirmations(0).unwrap();

    let 结果 = aiwf_core_api::mcp_ask_result(&store, id).unwrap();
    assert_eq!(结果.status, "expired");
    assert!(结果.answer_json.is_none());
}

#[test]
fn 问题定义不是合法_json_时不入队() {
    // 一张渲染不出来的卡会一直堵在队列里，而用户只看得到一个空壳
    let store = 库();
    let err = aiwf_core_api::mcp_ask_user(&store, "不是 json".to_string()).unwrap_err();
    assert_eq!(err.code, "VALIDATION");
    assert!(
        store.pending_confirmations().unwrap().is_empty(),
        "形状不对的问题不该进队列"
    );
}

#[test]
fn 不存在的提问报错而不是空结果() {
    // StoreError::NotFound 在这个仓库统一映射成 VALIDATION（lib.rs 的错误表）
    let err = aiwf_core_api::mcp_ask_result(&库(), "mcpc_不存在".to_string()).unwrap_err();
    assert_eq!(err.code, "VALIDATION");
    assert!(err.message.contains("提问"), "报错要说清是哪类东西没找到");
}
