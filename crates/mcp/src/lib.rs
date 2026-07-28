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

pub use http::{ServerHandle, serve};
pub use protocol::{McpContext, handle_message};
