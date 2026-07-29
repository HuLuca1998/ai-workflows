//! 主管 AI 的 ACP 会话复用。
//!
//! 每问一句就 `connect` + `new_session` 的话，agent 手上永远是一张白纸：
//! 用户问「那第二个方案呢」，它根本不知道第一个是什么 ——
//! 我们只能把历史重新拼进 prompt，那不是对话，是每次重新做一次自我介绍。
//! 顺带每问一句还要起一个 adapter 进程。
//!
//! mock 的 `count-sessions` 场景把每轮用的 sessionId 回显出来：
//! 复用同一条会话时两轮拿到同一个编号，各建一条时编号会涨。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use aiwf_engine::acp::{AcpClient, SessionPool, SessionUpdate, env_to_remove};

fn mock(scenario: &str) -> (String, Vec<String>) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    (
        "node".to_string(),
        vec![script.display().to_string(), scenario.to_string()],
    )
}

/// 建一条会话：连 adapter → 握手 → session/new。
fn 建会话(scenario: &'static str) -> impl Fn() -> aiwf_engine::acp::Result<(AcpClient, String)> {
    move || {
        let (command, args) = mock(scenario);
        let mut client = AcpClient::connect(
            &command,
            &args,
            &env_to_remove("acp.codex"),
            Duration::from_secs(10),
        )?;
        let session = client.new_session("/tmp")?;
        Ok((client, session.id))
    }
}

/// 跑一轮，把 agent 说的话收回来。
fn 问(pool: &SessionPool, key: &str, scenario: &'static str, text: &str) -> String {
    let mut 回答 = String::new();
    pool.prompt(key, 建会话(scenario), text, |update| {
        if let SessionUpdate::AgentText { text } = update {
            回答.push_str(text);
        }
    })
    .unwrap();
    回答
}

#[test]
fn 同一条会话的两轮用同一个_acp_session() {
    let pool = SessionPool::new(Duration::from_secs(300));

    let 第一轮 = 问(&pool, "sup_1", "count-sessions", "第一个问题");
    let 第一轮进程 = pool.pid_for_test("sup_1");
    let 第二轮 = 问(&pool, "sup_1", "count-sessions", "那第二个方案呢");

    assert_eq!(
        第一轮, 第二轮,
        "两轮拿到的 session id 不同 —— agent 记不住上一句"
    );
    // pid 才是硬证据：没有重新起过 adapter 进程
    assert_eq!(
        第一轮进程,
        pool.pid_for_test("sup_1"),
        "adapter 进程被重起了"
    );
    assert_eq!(pool.live_count(), 1);
}

#[test]
fn 不同的会话各用各的() {
    // 两条主管对话之间不该串味。
    // 比 session id 没用 —— 两个各自新起的 adapter 进程完全可能给出一样的 id，
    // 它们各自的计数器都从 1 开始。看进程
    let pool = SessionPool::new(Duration::from_secs(300));

    问(&pool, "sup_a", "count-sessions", "问题 A");
    问(&pool, "sup_b", "count-sessions", "问题 B");

    assert_eq!(pool.live_count(), 2, "两条不同的对话应当各有一条会话");
    assert_ne!(
        pool.pid_for_test("sup_a"),
        pool.pid_for_test("sup_b"),
        "两条对话共用了同一个 adapter 进程"
    );
}

#[test]
fn adapter_死了之后自己重建_不把错误抛给用户() {
    // adapter 进程会因为各种原因退出（升级、被杀、崩）。
    // 一条死会话留在池子里的话，用户之后每问一句都失败，
    // 而他完全不知道该怎么办 —— 关掉抽屉重开也不管用
    let pool = SessionPool::new(Duration::from_secs(300));

    问(&pool, "sup_die", "count-sessions", "第一个问题");
    let 原来的进程 = pool.pid_for_test("sup_die");

    pool.kill_for_test("sup_die");

    let 第二轮 = 问(&pool, "sup_die", "count-sessions", "第二个问题");
    assert!(
        !第二轮.is_empty(),
        "会话没重建起来，用户之后每问一句都会失败"
    );
    assert_ne!(原来的进程, pool.pid_for_test("sup_die"), "没有真的重建");
}

#[test]
fn 空闲太久的会话被回收() {
    // adapter 进程不能永远留着：用户问完一句就去干别的了，
    // 一个常驻的 node 进程在那儿占着内存与登录态
    let pool = SessionPool::new(Duration::from_millis(1));

    问(&pool, "sup_idle", "count-sessions", "第一个问题");
    assert_eq!(pool.live_count(), 1);

    std::thread::sleep(Duration::from_millis(20));
    pool.reap_idle();

    assert_eq!(pool.live_count(), 0, "空闲超时的会话没被回收");
}

#[test]
fn 回收不会误伤刚用过的会话() {
    let pool = SessionPool::new(Duration::from_secs(300));

    问(&pool, "sup_hot", "count-sessions", "第一个问题");
    pool.reap_idle();

    assert_eq!(pool.live_count(), 1, "刚用过的会话被回收了");
}

#[test]
fn 全部关掉时进程一起收走() {
    // App 退出时要能一次清干净，不然会留下一堆孤儿 adapter 进程
    let pool = SessionPool::new(Duration::from_secs(300));
    问(&pool, "sup_x", "count-sessions", "问题");
    问(&pool, "sup_y", "count-sessions", "问题");
    assert_eq!(pool.live_count(), 2);

    pool.shutdown();
    assert_eq!(pool.live_count(), 0);
}

#[test]
fn 第一句改挂到会话_id_之后第二句仍复用() {
    // 主管对话的第一句是在还没有会话 id 的时候发出去的 ——
    // id 要等答完落库才拿得到。不改挂的话第二句会认不出上一条，
    // 于是又建一条，复用等于没做
    let pool = SessionPool::new(Duration::from_secs(300));

    问(&pool, "新对话:随便问问", "count-sessions", "第一个问题");
    let 第一句的进程 = pool.pid_for_test("新对话:随便问问");
    assert!(第一句的进程.is_some());

    pool.rekey("新对话:随便问问", "sup_real_id");

    问(&pool, "sup_real_id", "count-sessions", "那第二个方案呢");

    assert_eq!(pool.live_count(), 1, "改挂之后又多出一条会话");
    assert_eq!(
        第一句的进程,
        pool.pid_for_test("sup_real_id"),
        "第二句起了新进程 —— 上一句的上下文丢了"
    );
}

#[test]
fn 改挂一个不存在的_key_不出事() {
    let pool = SessionPool::new(Duration::from_secs(300));
    pool.rekey("不存在", "也不存在");
    assert_eq!(pool.live_count(), 0);
}
