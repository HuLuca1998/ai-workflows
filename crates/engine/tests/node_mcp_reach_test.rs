//! 工作流里的 AI 节点也要够得着系统 MCP。
//!
//! ## 这条守的是什么
//!
//! `NodeExecutor` 有 `mcp` 字段、有 `with_mcp` setter、`SessionSpec` 也把它
//! 传给 `session/new` —— 而 **`with_mcp` 一个调用点都没有**。
//! 于是 `self.mcp` 永远是空的，AI 节点建会话时那一段一直发的是空数组。
//!
//! ## 那为什么实测里有时能用
//!
//! **沾了 codex 的光**：它会读 `~/.codex/config.toml` 的
//! `[mcp_servers.*]`（B-14 那条路）。所以在装了 codex、且那份配置指对了
//! 地址的机器上，AI 节点碰巧有工具。
//!
//! 这条依赖有三个问题：
//!
//! - **对 `acp.claude` 完全不成立** —— 它不读那份配置
//! - 用户没点过「一键接入」就没有那一条
//! - 那是本机全局配置，不是这次运行的配置：换个工作区、换个端口就指错
//!
//! 实测撞到过（run_a3f5bdf1cde3c992 的 `write_report`）：
//!
//! > 当前环境没有暴露 `run_events`，MCP 资源列表也是空的，
//! > 因此无法从运行 …… 重新读取 assess 事件或 `aiwf://guide/write-report`
//!
//! 而 `release-checklist` 这条模板的指令里**明写着**让它用
//! `run_events` 去读上一步的结论。界面上有的能力，节点里够不着。
//!
//! ## 判据
//!
//! 不查「MCP 此刻活着」（那取决于运行环境），查**源码里有没有那一步** ——
//! 与 `crates/core-api/tests/supervisor_tools_reach_test.rs` 同一个判法。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

fn 读(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}：{e}", path.display()))
}

#[test]
fn 构造执行器时把系统_mcp_接上() {
    let source = 读("crates/engine/src/runner.rs");
    // **判据带点**：`contains("with_mcp")` 会被 `pub fn with_mcp` 这个
    // 定义本身、以及注释里的 `Supervisor::with_mcp` 命中 —— 突变验证
    // 当场抓到过：把调用点删掉，守卫照样绿
    assert!(
        source.contains(".with_mcp("),
        "runner 构造 NodeExecutor 时没接系统 MCP —— \
         AI 节点建会话时发的是空的 mcpServers。\n\
         能用只是沾了 codex 读 ~/.codex/config.toml 的光，\
         而那对 acp.claude 完全不成立，也随本机配置漂移。\n\
         内置模板（release-checklist / release-pipeline）的指令里\
         明写着让节点用 run_events、read_mcp_resource 去读上一步的结论"
    );
}

#[test]
fn 这条守卫自己会红() {
    // 元测试：假装一个只接了别的东西的构造链
    let 假源码 = "NodeExecutor::new(workdir).with_run_id(run_id).with_memories(&memories)";
    assert!(假源码.contains("NodeExecutor::new"));
    assert!(!假源码.contains("with_mcp"), "守卫抓不到就不是守卫");
}
