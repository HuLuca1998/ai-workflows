//! 主管 AI 在**每个执行宿主上**都要够得着系统 MCP。
//!
//! ## 这条守的是什么
//!
//! 「AI 主管对话进行工作流创建、修改」这条能力，全靠主管 AI 手上
//! 那套系统 MCP 工具（50 个契约派生工具）。没有它，agent 只能对话 ——
//! 而且它会**如实说自己没工具**（`SupervisorTools::None` 那一档，
//! 提示词照实写），所以症状不是报错，是一句
//! 「当前工具不可用，请你自己去界面里点」。
//!
//! 实测：devserver（Web 形态的执行宿主）**不起系统 MCP**，
//! 于是同一句话在桌面壳里 agent 直接把工作流建出来，在 Web 形态里
//! 它让用户自己去点六步。两边都「正常工作」，而能力差了一整条。
//!
//! 判据不是「MCP 服务此刻活着」（那取决于运行环境），
//! 而是**每个执行宿主的源码里都有起它的那一步** —— 漏掉的那个
//! 会安静地少一整套能力。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

/// 执行宿主：拥有 Supervisor、会跑主管 AI 的那些进程。
///
/// 判据与调度器那条一致（`crates/core-api/src/scheduler.rs` 的
/// 「只由执行宿主调」）—— 拥有 `Supervisor` 的就是宿主。
const 执行宿主: &[(&str, &str)] = &[
    ("crates/devserver/src/main.rs", "Web 形态"),
    ("apps/desktop/src-tauri/src/lib.rs", "桌面壳"),
];

fn 读(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}：{e}", path.display()))
}

#[test]
fn 每个执行宿主都起系统_mcp() {
    let mut 漏了 = Vec::new();
    for (rel, 名字) in 执行宿主 {
        let source = 读(rel);
        // 拥有 Supervisor 才算宿主 —— 不拥有的进程不该起 MCP
        // （两个进程各起一个，同一个端口会撞）
        if !source.contains("Supervisor::new") {
            continue;
        }
        if !source.contains("aiwf_mcp::start") {
            漏了.push(format!("{名字}（{rel}）"));
        }
    }
    assert!(
        漏了.is_empty(),
        "这些执行宿主没起系统 MCP：{漏了:?}。\n\
         主管 AI 因此拿不到那 50 个工具 —— 它会如实说「当前工具不可用，\
         请你自己去界面里点」，而同一句话在别的宿主上它能直接做完。\
         症状不是报错，是能力安静地少了一整条"
    );
}

#[test]
fn 起了_mcp_就要把地址刷新给已接入的客户端() {
    /*
     * 「起来了」还不够 —— **接入地址是一张快照**。
     *
     * 「一键接入」把 `http://127.0.0.1:<port>/mcp/<token>` 写进
     * `~/.codex/config.toml` 的 `[mcp_servers.aiwf]`。而端口在启动时
     * 可能被占用后重绑（`crates/mcp/src/http.rs`），换个工作区 token 也变，
     * 于是那条快照指向一个不存在的地址。
     *
     * `mcp_clients::connected()` 只查「那一条在不在」，不查它对不对，
     * 所以设置页照样显示「已接入」。实测：config.toml 里躺着
     * `:5178/...299f5b20`，实际服务在 `:5179/...269d1635` ——
     * 主管 AI 一个工具都没有，而 MCP 服务本身活得好好的。
     *
     * 那条 curl 得到的是连接被拒，agent 侧只表现为「没有这个工具」，
     * 于是它老老实实说「当前工具不可用」——
     * 与整个 MCP 没起来的症状**一模一样**。
     */
    let mut 漏了 = Vec::new();
    for (rel, 名字) in 执行宿主 {
        let source = 读(rel);
        if !source.contains("aiwf_mcp::start") {
            continue;
        }
        if !source.contains("refresh_connected") {
            漏了.push(format!("{名字}（{rel}）"));
        }
    }
    assert!(
        漏了.is_empty(),
        "这些宿主起了 MCP 却不刷新已接入客户端的地址：{漏了:?}。\n\
         端口重绑或换工作区之后，`~/.codex/config.toml` 里那条快照就指错了，\
         而设置页仍显示「已接入」—— 症状与「MCP 完全没起来」无法区分"
    );
}

#[test]
fn 这两条守卫自己都会红() {
    // 元测试：假装一个宿主只有 Supervisor 没有 MCP
    let 缺_mcp = "let supervisor = Supervisor::new(path);";
    assert!(缺_mcp.contains("Supervisor::new"));
    assert!(!缺_mcp.contains("aiwf_mcp::start"), "守卫抓不到就不是守卫");

    // 起了 MCP 但不刷新 —— 这正是实测撞到的那一版
    let 缺刷新 = "let handle = aiwf_mcp::start(&data_dir, db, config)?;";
    assert!(缺刷新.contains("aiwf_mcp::start"));
    assert!(
        !缺刷新.contains("refresh_connected"),
        "刷新那条守卫抓不到「起了但没刷新」，就不是守卫"
    );
}
