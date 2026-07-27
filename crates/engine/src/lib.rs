//! AI Workflows 编排引擎。
//!
//! 职责（技术选型 §2）：调度、检查点、环境快照、路径守卫、脱敏。
//! 调度、重试、路径 canonicalize 与沙箱都在这一进程内完成，不经过 JS。
//!
//! M0 只落地两块安全基元与状态机骨架；调度器在 M2 补齐。

pub mod exec;
pub mod executor;
pub mod graph;
pub mod interp;
pub mod path_guard;
pub mod plan;
pub mod redactor;
pub mod runner;
pub mod status;
pub mod supervisor;
pub mod worktree;

pub use path_guard::PathGuard;
pub use redactor::Redactor;
