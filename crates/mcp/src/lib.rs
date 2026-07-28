//! 系统级 MCP Server。
//!
//! 把这个应用的**全部能力与知识**通过 MCP 暴露出去，让 Claude Code、
//! Codex 这类客户端连上来之后，能读懂这个系统、能设计工作流、能跑起来、
//! 能回头分析执行数据。
//!
//! 三层：
//! - `catalog`：工具清单，由契约派生
//! - `knowledge`：资源（系统知识）与提示词模板
//! - `protocol` / `http`：MCP 的 JSON-RPC 与 Streamable HTTP 传输
//!
//! 调用一律经 `aiwf_core_api::dispatch`——没有直连数据库或文件的路径，
//! 那会绕过版本守卫与审计（技术选型 §6）。

pub mod catalog;
pub mod http;
pub mod knowledge;
pub mod protocol;

/// 配置（端口与令牌）住在 core-api —— MCP 依赖它，反过来会成环。
/// 这里转发一下，调用方不必知道这条依赖方向。
pub use aiwf_core_api::mcp_clients as clients;
pub use aiwf_core_api::mcp_config as config;
pub use http::{ServerHandle, serve};
pub use protocol::{McpContext, handle_message};

/// 起服务，端口被占就往后挪，挪成了就把新端口存回配置。
///
/// 不挪的话，本机上任何一个占了 5178 的东西都会让 MCP 起不来，
/// 而症状是「一键接入点了没反应」——用户无从知道是端口冲突。
/// 挪完必须存回去：客户端配置里写的是那个地址，不存下次就指错了。
///
/// # Errors
/// 连挪 10 个端口都起不来时返回 Err。那多半不是冲突，是别的问题。
pub fn start(
    data_dir: &std::path::Path,
    db_path: std::path::PathBuf,
    config: aiwf_core_api::mcp_config::McpConfig,
) -> Result<ServerHandle, String> {
    let mut last = String::new();
    for offset in 0..10_u16 {
        let port = config.port.saturating_add(offset);
        match serve(
            port,
            config.token.clone(),
            db_path.clone(),
            data_dir.to_path_buf(),
        ) {
            Ok(handle) => {
                if handle.port != config.port {
                    let _ = aiwf_core_api::mcp_config::save(
                        data_dir,
                        &aiwf_core_api::mcp_config::McpConfig {
                            port: handle.port,
                            token: config.token.clone(),
                        },
                    );
                }
                return Ok(handle);
            }
            Err(error) => last = error,
        }
    }
    Err(format!(
        "MCP 起不来（从 {} 起连试 10 个端口）：{last}",
        config.port
    ))
}
