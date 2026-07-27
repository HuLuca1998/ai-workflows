//! ACP 客户端：JSON-RPC over stdio。
//!
//! 用一个可控的 mock adapter 跑，因为真实 adapter 需要登录凭据、
//! 会真的调模型、每次响应还不一样 —— 那些不适合放进单元测试。
//! 真实 adapter 的验证走 `tests/e2e/acp_real.mjs`（需要装了 adapter 才跑）。
//!
//! mock 说的是与真实 adapter 完全相同的协议：实测过的
//! initialize → session/new → session/prompt → session/update 通知。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use aiwf_engine::acp::{AcpClient, AcpError, PromptOutcome, SessionUpdate};

/// mock adapter 的路径。它是个 Node 脚本，行为由第一个参数控制。
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

fn connect(scenario: &str) -> Result<AcpClient, AcpError> {
    let (command, args) = mock(scenario);
    AcpClient::connect(&command, &args, &[], Duration::from_secs(10))
}

#[test]
fn 握手拿到协议版本与能力() {
    let client = connect("normal").expect("连接 mock");
    assert_eq!(client.protocol_version(), 1);
    // 图纸那句「ACP 握手只返回协议能力与 session modes，不返回可用模型」
    assert!(
        client.capabilities().get("promptCapabilities").is_some(),
        "能力实际：{:?}",
        client.capabilities()
    );
}

#[test]
fn 协议版本对不上时拒绝连接() {
    // 「适配器与 CLI 版本要成对锁定，避免出现模型元数据错配的警告」——
    // 版本不匹配就该在握手时停下，而不是跑到一半才发现字段对不上
    let error = match connect("wrong-version") {
        Err(error) => error.to_string(),
        Ok(_) => panic!("协议版本不匹配时不该连接成功"),
    };
    assert!(error.contains("协议版本"), "错误信息实际：{error}");
}

#[test]
fn 建会话拿到_session_id_与权限档位() {
    let mut client = connect("normal").expect("连接 mock");
    let session = client
        .new_session(std::env::temp_dir().to_str().unwrap())
        .unwrap();

    assert!(!session.id.is_empty());
    // modes 就是图纸说的「session modes（权限档位）」
    assert!(!session.modes.is_empty(), "应当返回可选的权限档位");
}

#[test]
fn 发提示词收到流式文本并在结束时拿到停止原因() {
    let mut client = connect("normal").expect("连接 mock");
    let session = client
        .new_session(std::env::temp_dir().to_str().unwrap())
        .unwrap();

    let mut chunks = Vec::new();
    let outcome = client
        .prompt(&session.id, "分析这段代码", |update| {
            if let SessionUpdate::AgentText { text } = update {
                chunks.push(text.to_string());
            }
        })
        .unwrap();

    assert!(!chunks.is_empty(), "没收到任何流式文本");
    assert!(chunks.join("").contains("分析结果"), "实际：{chunks:?}");
    assert_eq!(outcome, PromptOutcome::EndTurn);
}

#[test]
fn 工具调用也走同一条通知流() {
    // 图纸的对话视图要显示「工具活动 · 6 次读取，2 次搜索」，
    // 那些数字来自这些通知
    let mut client = connect("normal").expect("连接 mock");
    let session = client
        .new_session(std::env::temp_dir().to_str().unwrap())
        .unwrap();

    let mut tools = Vec::new();
    client
        .prompt(&session.id, "读一下文件", |update| {
            if let SessionUpdate::ToolCall { title, status } = update {
                tools.push(format!("{title}:{status}"));
            }
        })
        .unwrap();

    assert!(
        tools.iter().any(|t| t.contains("读取")),
        "工具调用实际：{tools:?}"
    );
}

#[test]
fn adapter_崩溃时报出来_而不是一直等() {
    let mut client = connect("crash-after-session").expect("连接 mock");
    let session = client
        .new_session(std::env::temp_dir().to_str().unwrap())
        .unwrap();

    let error = client
        .prompt(&session.id, "会让它崩的输入", |_| {})
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("退出") || error.contains("断开"),
        "错误信息实际：{error}"
    );
}

#[test]
fn 超时不会永远挂着() {
    let (command, args) = mock("hang");
    let error = match AcpClient::connect(&command, &args, &[], Duration::from_millis(600)) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("hang 场景不该连接成功"),
    };
    assert!(error.contains("超时"), "错误信息实际：{error}");
}

#[test]
fn 起不来的命令给出可操作的错误() {
    let error = match AcpClient::connect(
        "definitely-not-an-adapter",
        &[],
        &[],
        Duration::from_secs(5),
    ) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("不存在的命令不该连接成功"),
    };
    assert!(
        error.contains("definitely-not-an-adapter"),
        "错误信息实际：{error}"
    );
}

#[test]
fn 环境变量按注册表清除() {
    // 应用可能从某个 agent 会话的终端里启动，继承了宿主的嵌套标记；
    // 不清掉的话 adapter 会误判自己运行在另一个 agent 内部而拒绝服务。
    //
    // 拿 CARGO_MANIFEST_DIR 当靶子：cargo test 一定会设它，
    // 所以不必自己 set_var（那在 Rust 2024 里是 unsafe，而 workspace 级 forbid）
    let (command, args) = mock("echo-env");

    // 不清除时，mock 能看到它
    let mut with_env =
        AcpClient::connect(&command, &args, &[], Duration::from_secs(10)).expect("连接 mock");
    let seen = with_env
        .new_session(std::env::temp_dir().to_str().unwrap())
        .expect("建会话");
    assert!(
        seen.id.contains("CARGO_MANIFEST_DIR"),
        "前提不成立：mock 本来就该看到这个变量，实际 {}",
        seen.id
    );

    // 清除后就看不到了
    let mut without_env = AcpClient::connect(
        &command,
        &args,
        &["CARGO_MANIFEST_DIR".to_string()],
        Duration::from_secs(10),
    )
    .expect("连接 mock");
    let session = without_env
        .new_session(std::env::temp_dir().to_str().unwrap())
        .expect("建会话");
    assert!(
        !session.id.contains("CARGO_MANIFEST_DIR"),
        "环境变量没有被清除：{}",
        session.id
    );
}

#[test]
fn 关闭会把进程收干净() {
    let client = connect("normal").expect("连接 mock");
    let pid = client.pid();
    drop(client);

    // 给一点时间让进程收场
    std::thread::sleep(Duration::from_millis(300));
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(!alive, "adapter 进程 {pid} 还活着");
}
