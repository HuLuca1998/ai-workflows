//! 一键把本地 ACP 客户端接进系统 MCP。
//!
//! 两个客户端的接法不一样，而差异不是风格问题：
//! - Claude Code 能带自定义头 → 令牌走 `Authorization: Bearer`
//! - Codex 的 `mcp add --url` 只认「从环境变量读 bearer」或 OAuth
//!   → 要一键就不能要求用户先 export 一个变量，令牌只能走路径
//!
//! 这份测试守的是「命令拼对了」与「令牌落在该落的地方」，
//! 不真的去改用户机器上的配置。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_core_api::mcp_clients::{self as clients, Client};
use aiwf_core_api::mcp_config as config;

const 令牌: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn claude_的令牌走请求头_不进_url() {
    let 命令 = clients::install_command(Client::Claude, 4321, 令牌);

    assert_eq!(命令.program, "claude");
    let 参数 = 命令.args.join(" ");
    assert!(参数.contains("--transport http"), "{参数}");
    assert!(参数.contains("--scope user"), "要跨项目可用：{参数}");
    assert!(
        参数.contains("http://127.0.0.1:4321/mcp "),
        "URL 里不该带令牌 —— Claude Code 能带头：{参数}"
    );
    assert!(
        参数.contains(&format!("Authorization: Bearer {令牌}")),
        "{参数}"
    );
}

#[test]
fn codex_的令牌走路径_因为它带不了自定义头() {
    let 命令 = clients::install_command(Client::Codex, 4321, 令牌);

    assert_eq!(命令.program, "codex");
    let 参数 = 命令.args.join(" ");
    assert!(参数.contains("--url"), "{参数}");
    assert!(
        参数.contains(&format!("http://127.0.0.1:4321/mcp/{令牌}")),
        "Codex 只能这么带令牌：{参数}"
    );
    // 反过来也要成立：不能顺手加一个它不认的 --header
    assert!(
        !参数.contains("--header"),
        "codex mcp add 没有这个参数：{参数}"
    );
}

#[test]
fn 两个客户端注册的名字一致() {
    // 名字不一致的话，用户在两边看到的工具前缀不同
    //（Claude Code 是 mcp__<name>__<tool>），换个客户端就得重学一遍
    for client in [Client::Claude, Client::Codex] {
        assert!(
            clients::install_command(client, 1, 令牌)
                .args
                .contains(&"aiwf".to_string()),
            "{client:?} 注册的名字该是 aiwf"
        );
    }
}

#[test]
fn 先删后加_否则重复接入会失败() {
    // `claude mcp add` 碰到同名会报错。用户点第二次「接入」时
    // 看到一句「already exists」会以为是自己操作错了
    for client in [Client::Claude, Client::Codex] {
        let 命令 = clients::uninstall_command(client);
        assert!(命令.args.contains(&"remove".to_string()), "{client:?}");
        assert!(命令.args.contains(&"aiwf".to_string()), "{client:?}");
    }
}

#[test]
fn 令牌文件权限是_0600() {
    // 这个令牌等于这台机器上这个应用的全部能力。同机器上的
    // 别的用户读得到的话，鉴权就白做了
    let dir = tempfile::tempdir().unwrap();
    let 配置 = config::load_or_create(dir.path()).expect("建不出配置");

    assert_eq!(配置.token.len(), 48, "令牌太短");
    assert!(配置.port > 0);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(config::path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "令牌文件权限不对：{:o}", mode & 0o777);
    }
}

#[test]
fn 令牌只生成一次_重开应用还是同一个() {
    // 每次启动换一个的话，昨天写进客户端配置的那份今天就失效了 ——
    // 而用户看到的是「工具突然全没了」
    let dir = tempfile::tempdir().unwrap();
    let 第一次 = config::load_or_create(dir.path()).unwrap();
    let 第二次 = config::load_or_create(dir.path()).unwrap();

    assert_eq!(第一次.token, 第二次.token);
    assert_eq!(第一次.port, 第二次.port);
}

#[test]
fn 配置文件坏了就重建_而不是让应用起不来() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(config::path(dir.path()), "这不是 JSON").unwrap();

    let 配置 = config::load_or_create(dir.path()).expect("坏文件不该让它失败");
    assert_eq!(配置.token.len(), 48);
}

#[test]
fn 令牌不该出现在诊断包会读的地方() {
    // 设置表会被诊断报告导出，也会显示在界面上。令牌进了那里
    // 就等于随每一份诊断包一起发出去
    let dir = tempfile::tempdir().unwrap();
    config::load_or_create(dir.path()).unwrap();

    assert_eq!(
        config::path(dir.path())
            .file_name()
            .and_then(|n| n.to_str()),
        Some("mcp.json"),
        "令牌存在单独的文件里，不进 workspace_setting"
    );
}
