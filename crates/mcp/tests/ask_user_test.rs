//! 内建 `ask_user` 工具：agent 提问 → 挂起 → 用户回答 → 答案原样带回。
//!
//! 它不在契约派生清单里 —— 不是某个 Core API 命令的镜像：`dispatch`
//! 从进门就持库锁到返回，一个要挂着等用户回答的调用放进去，
//! 用户提交答案的那条调用会被同一把锁挡在门外，死锁到超时。
//! 所以由 protocol 层特判：入队、放锁、轮询，答案原样带回。
//!
//! 这里的挂起是真的：agent 线程真的停在 `tools/call` 里，
//! 主线程扮演用户从第二条连接写回答。**耗时是证据** ——
//! 一套用例毫秒级跑完，说明没有真的等过。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Mutex;
use std::time::{Duration, Instant};

use aiwf_engine::supervisor::Supervisor;
use aiwf_mcp::{McpContext, handle_message};
use aiwf_store::Store;
use serde_json::{Value, json};

/// 发起提问的用例逐条跑。挂起的提问有**全局**并发上限（防 8 条并发
/// 把 MCP 工作线程占光）—— 并行跑的话，上限用例挂着的 4 条会把
/// 别的用例的提问顶出去，两边都 flaky。
static GATE: Mutex<()> = Mutex::new(());

fn 排队() -> std::sync::MutexGuard<'static, ()> {
    GATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn 建库(dir: &std::path::Path) -> std::path::PathBuf {
    let db = dir.join("aiwf.sqlite");
    // 先开一次把表建起来：两条连接同时跑迁移会撞锁
    Store::open(&db).unwrap();
    db
}

/// 在独立线程里发一次 `tools/call`。挂起的调用不能占住测试主线程 ——
/// 主线程要扮演用户。
fn 后台调用(
    db: std::path::PathBuf,
    dir: std::path::PathBuf,
    args: Value,
) -> std::thread::JoinHandle<Value> {
    std::thread::spawn(move || {
        let store = Mutex::new(Store::open(&db).unwrap());
        let supervisor = Supervisor::new(db.clone());
        let ctx = McpContext {
            store: &store,
            supervisor: &supervisor,
            data_dir: &dir,
        };
        let message = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "ask_user", "arguments": args },
        });
        handle_message(&ctx, &message).unwrap()["result"].clone()
    })
}

/// 等 agent 线程把提问写进队列。等不到就是入队那半边断了。
fn 等到提问(store: &Store) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(row) = store.pending_confirmations().unwrap().first() {
            return row.id.clone();
        }
        assert!(Instant::now() < deadline, "提问一直没进队列");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn 单选问题() -> Value {
    json!({
        "kind": "choice",
        "title": "先修哪个方向",
        "options": [{ "value": "cache", "label": "先改缓存层" }],
    })
}

#[test]
fn 工具清单里有_ask_user_且标注防自动重试() {
    let dir = tempfile::tempdir().unwrap();
    let db = 建库(dir.path());
    let store = Mutex::new(Store::open(&db).unwrap());
    let supervisor = Supervisor::new(db.clone());
    let ctx = McpContext {
        store: &store,
        supervisor: &supervisor,
        data_dir: dir.path(),
    };

    let result =
        handle_message(&ctx, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
    let tools = result["result"]["tools"].as_array().unwrap().clone();
    let ask = tools
        .iter()
        .find(|tool| tool["name"] == "ask_user")
        .expect("清单里没有 ask_user —— agent 无从知道它能问用户");

    // 入参 schema 来自契约生成物，不是手写的第二份
    assert!(ask["inputSchema"]["properties"]["kind"].is_object());
    assert!(ask["inputSchema"]["properties"]["title"].is_object());
    assert!(ask["inputSchema"].get("$schema").is_none());

    // 一次调用会打断用户。标成只读/幂等的话，客户端失败自动重试，
    // 用户会被同一个问题反复砸
    assert_eq!(ask["annotations"]["readOnlyHint"], false);
    assert_eq!(ask["annotations"]["idempotentHint"], false);
    assert_eq!(ask["annotations"]["destructiveHint"], false);
}

#[test]
fn 用户回答后答案原样回到_agent_手上() {
    let _gate = 排队();
    let dir = tempfile::tempdir().unwrap();
    let db = 建库(dir.path());
    let started = Instant::now();
    let agent = 后台调用(db.clone(), dir.path().to_path_buf(), 单选问题());

    // 扮演用户：第二条连接，看到提问卡，选了 cache
    let store = Store::open(&db).unwrap();
    let id = 等到提问(&store);
    // 用户看了 1.2 秒才点。等待循环一拍是 500ms —— 只断言一拍的话，
    // 「睡一觉顺手捡到答案」与「真的在等用户」分不出来
    std::thread::sleep(Duration::from_millis(1200));
    aiwf_core_api::mcp_answer_ask(&store, id, r#"{"selected":"cache"}"#.to_string()).unwrap();

    let result = agent.join().unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(1200),
        "比用户按下按钮还早返回 —— 它没有真的在等"
    );
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["outcome"], "answered");
    assert_eq!(
        result["structuredContent"]["answer"]["selected"], "cache",
        "用户选的东西没有原样带回：{result}"
    );
}

#[test]
fn 用户拒绝回答时_agent_拿到的是_declined_不是空答案() {
    let _gate = 排队();
    let dir = tempfile::tempdir().unwrap();
    let db = 建库(dir.path());
    let agent = 后台调用(db.clone(), dir.path().to_path_buf(), 单选问题());

    // 扮演用户：点了「不回答」（界面走的就是 decideConfirm(false)）
    let store = Store::open(&db).unwrap();
    let id = 等到提问(&store);
    aiwf_core_api::mcp_decide_confirm(&store, id, false).unwrap();

    let result = agent.join().unwrap();
    // 用户的决定不是错误 —— isError 会让部分客户端中断对话
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["outcome"], "declined");
    assert!(
        result["structuredContent"].get("answer").is_none(),
        "拒绝不该带答案 —— 空对象会被 agent 当成「用户什么都没选」"
    );
    // 只读得到文本的客户端也要能懂「别原样再问一遍」
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("拒绝"), "文本没说清用户拒绝了：{text}");
}

#[test]
fn 没人回答过期后_agent_拿到_no_answer() {
    let _gate = 排队();
    let dir = tempfile::tempdir().unwrap();
    let db = 建库(dir.path());
    let agent = 后台调用(db.clone(), dir.path().to_path_buf(), 单选问题());

    // 没人在电脑前。0 秒 TTL 立刻过期 —— 真实 TTL 是三分钟，测试不等它
    let store = Store::open(&db).unwrap();
    let _ = 等到提问(&store);
    store.expire_confirmations(0).unwrap();

    let result = agent.join().unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["outcome"], "no_answer");
    assert!(result["structuredContent"].get("answer").is_none());
}

#[test]
fn 坏问题在门口就被拒_不挂起不入队() {
    let _gate = 排队();
    let dir = tempfile::tempdir().unwrap();
    let db = 建库(dir.path());
    let started = Instant::now();
    // 缺 title：一张没有标题的卡，用户什么都决定不了
    let agent = 后台调用(
        db.clone(),
        dir.path().to_path_buf(),
        json!({ "kind": "choice" }),
    );

    let result = agent.join().unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "坏问题还挂着等 —— 门口就该拒"
    );
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("title"), "报错没说清缺什么：{text}");
    assert!(
        Store::open(&db).unwrap().pending_confirmations().unwrap().is_empty(),
        "被拒的问题不该留在队列里"
    );
}

#[test]
fn 挂起的提问有并发上限_超了直接说() {
    // 8 个 HTTP 工作线程，一次 ask_user 最长占 190 秒 —— 不设上限，
    // 8 条并发提问就让整个 MCP 端点三分钟不响应任何请求
    let _gate = 排队();
    let dir = tempfile::tempdir().unwrap();
    let db = 建库(dir.path());

    let hung: Vec<_> = (0..4)
        .map(|_| 后台调用(db.clone(), dir.path().to_path_buf(), 单选问题()))
        .collect();

    // 等 4 条都进队列 —— 说明 4 个名额都真的被占着
    let store = Store::open(&db).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while store.pending_confirmations().unwrap().len() < 4 {
        assert!(Instant::now() < deadline, "4 条提问没有全部进队列");
        std::thread::sleep(Duration::from_millis(20));
    }

    let started = Instant::now();
    let fifth = 后台调用(db.clone(), dir.path().to_path_buf(), 单选问题())
        .join()
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "第 5 条该立刻被拒，而不是也挂着"
    );
    assert_eq!(fifth["isError"], true);
    let text = fifth["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("同时挂起"), "要说清是并发上限：{text}");

    // 收尾：全部过期，4 条挂着的线程拿到 no_answer 收工
    store.expire_confirmations(0).unwrap();
    for handle in hung {
        let result = handle.join().unwrap();
        assert_eq!(result["structuredContent"]["outcome"], "no_answer");
    }
}
