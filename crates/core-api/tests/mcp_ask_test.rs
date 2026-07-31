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

const 问题: &str =
    r#"{"kind":"choice","title":"先修哪个","options":[{"value":"a","label":"缓存"}]}"#;

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
fn 缺_title_或_kind_的问题不入队() {
    // 经 MCP 来的 spec 永远是合法 JSON（Value 序列化出来的），
    // 「合法 JSON」这道校验对那条路径形同虚设。卡片渲染的底线是
    // 有 title、有 kind —— 白名单仍在界面层，但底线在门口验：
    // 一张连标题都没有的卡就是一个空壳，用户什么都决定不了
    let store = 库();
    for 坏的 in [
        r#"{"kind":"choice"}"#,
        r#"{"title":"先修哪个"}"#,
        r#"{"kind":"","title":"先修哪个"}"#,
        r#"{"kind":"choice","title":""}"#,
        r#"["kind","title"]"#,
    ] {
        let err = aiwf_core_api::mcp_ask_user(&store, 坏的.to_string()).unwrap_err();
        assert_eq!(err.code, "VALIDATION", "{坏的} 进队列了");
    }
    assert!(store.pending_confirmations().unwrap().is_empty());
}

#[test]
fn 缺_label_的选项和字段也在门口拒() {
    // 界面按 AskSpecSchema 校验 pendingConfirms 的**整个响应** ——
    // 一条缺 label 的 option 入了队，同时排队的写操作确认卡
    // 会跟着一起消失三分钟。门口的校验必须不比读出来那一侧松
    let store = 库();
    for 坏的 in [
        r#"{"kind":"choice","title":"选","options":[{"value":"a"}]}"#,
        r#"{"kind":"choice","title":"选","options":[{"label":"甲"}]}"#,
        r#"{"kind":"form","title":"填","fields":[{"name":"x"}]}"#,
        r#"{"kind":"form","title":"填","fields":[{"label":"分支"}]}"#,
    ] {
        let err = aiwf_core_api::mcp_ask_user(&store, 坏的.to_string()).unwrap_err();
        assert_eq!(err.code, "VALIDATION", "{坏的} 进队列了");
    }
    assert!(store.pending_confirmations().unwrap().is_empty());

    // 完整的照常入队 —— 校验不能严到把好问题也挡了
    aiwf_core_api::mcp_ask_user(
        &store,
        r#"{"kind":"choice","title":"选","options":[{"value":"a","label":"甲"}]}"#.to_string(),
    )
    .unwrap();
}

#[test]
fn 回答不是合法_json_时不落库() {
    // 桌面 IPC 不经 Zod 直达 dispatch，缺 answer 时那边序列化出的是
    // 空字符串 —— 落库的话 agent 解析答案会当场炸掉
    let store = 库();
    let id = aiwf_core_api::mcp_ask_user(&store, 问题.to_string()).unwrap();

    let err = aiwf_core_api::mcp_answer_ask(&store, id.clone(), String::new()).unwrap_err();
    assert_eq!(err.code, "VALIDATION");

    // 裸字符串也是合法 JSON —— 双重编码漏过去的正是它。必须是对象
    let err =
        aiwf_core_api::mcp_answer_ask(&store, id.clone(), r#""{\"selected\":\"a\"}""#.to_string())
            .unwrap_err();
    assert_eq!(err.code, "VALIDATION", "裸字符串形态的回答该被拒");

    let 结果 = aiwf_core_api::mcp_ask_result(&store, id).unwrap();
    assert_eq!(结果.status, "pending", "坏回答不该把这条提问标成已回答");
}

#[test]
fn 不存在的提问报错而不是空结果() {
    // StoreError::NotFound 在这个仓库统一映射成 VALIDATION（lib.rs 的错误表）
    let err = aiwf_core_api::mcp_ask_result(&库(), "mcpc_不存在".to_string()).unwrap_err();
    assert_eq!(err.code, "VALIDATION");
    assert!(err.message.contains("提问"), "报错要说清是哪类东西没找到");
}

#[test]
fn 经_ipc_映射来的字符串形态回答_不被再编码一层() {
    // 界面 → IPC 映射把 answer JSON.stringify 成字符串（Tauri 的命令参数
    // 必须扁平）。dispatch 对它直接 to_string 的话，字符串被再编码一层：
    // agent 拿到的是「字符串套 JSON」，得自己再解析一次 ——
    // 而工具描述说好了 answer 是对象。桌面壳直传 String 没这个问题，
    // Web 形态（devserver 走 dispatch）实测中招
    let store = std::sync::Mutex::new(库());
    let id = {
        let guard = store.lock().unwrap();
        aiwf_core_api::mcp_ask_user(&guard, 问题.to_string()).unwrap()
    };

    let dir = tempfile::tempdir().unwrap();
    let supervisor = aiwf_engine::supervisor::Supervisor::new(dir.path().join("aiwf.sqlite"));
    aiwf_core_api::dispatch::dispatch(
        "mcp_answer_ask",
        &serde_json::json!({ "id": id, "answer": "{\"selected\":\"cache\"}" }),
        &store,
        &supervisor,
        dir.path(),
    )
    .unwrap();

    let guard = store.lock().unwrap();
    let 结果 = aiwf_core_api::mcp_ask_result(&guard, id).unwrap();
    let 答案: serde_json::Value =
        serde_json::from_str(结果.answer_json.as_deref().unwrap()).unwrap();
    assert!(
        答案.is_object(),
        "答案被再编码成了字符串，agent 还得自己剥一层：{答案}"
    );
    assert_eq!(答案["selected"], "cache");
}
