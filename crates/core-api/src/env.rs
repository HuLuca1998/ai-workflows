//! 环境健康报告。
//!
//! 图纸「06 首次安装与检测」的产品原则写在头部：
//! 「我们不会静默修改系统。下面列出将要安装的内容、来源、版本与位置，
//! 确认后才执行；不使用 sudo，不改动 shell profile，
//! 也不把 App 工具写入全局 PATH。」
//!
//! 这个模块只管**检测**那一半，而且只读 —— 它没有任何能写的入口。

use std::process::Command;

use serde::Serialize;

use crate::ApiResult;

/// 工具从哪来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvSource {
    /// 系统自带或用户自己装的。
    System,
    /// 应用装在自己目录下的（不进全局 PATH）。
    AppManaged,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvStatus {
    Ready,
    NeedsAttention,
    /// 只有某类工作流需要 —— 缺了不影响整体状态。
    Optional,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvHealthItem {
    pub capability: String,
    /// 面向用户的名字。capability 是 id，这个是显示用的。
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 它在哪 —— 用户要能自己确认，而不是只被告知「已就绪」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub source: EnvSource,
    pub status: EnvStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvHealthReport {
    /// 必需项是否都就绪。可选项缺失不影响它 ——
    /// 一个从不跑容器的用户不该永远看到「环境需要处理」。
    pub ready: bool,
    pub items: Vec<EnvHealthItem>,
}

/// 要探测的工具。
///
/// `(capability, 显示名, 命令, 版本参数, 是否可选, 说明)`
const PROBES: &[(&str, &str, &str, &str, bool, &str)] = &[
    (
        "git",
        "Git",
        "git",
        "--version",
        false,
        "worktree 与 PR 都要它",
    ),
    (
        "node",
        "Node.js",
        "node",
        "--version",
        false,
        "ACP adapter 跑在它上面",
    ),
    (
        "python",
        "Python",
        "python3",
        "--version",
        true,
        "只有 Python 脚本节点需要",
    ),
    (
        "gh",
        "GitHub CLI",
        "gh",
        "--version",
        true,
        "只有 GitHub 相关的工作流需要",
    ),
    (
        "docker",
        "Docker / OrbStack",
        "docker",
        "--version",
        true,
        "只有容器工作流需要",
    ),
];

/// 探测环境。
///
/// `recheck` 目前不影响行为 —— 没有缓存可跳过。留着这个参数是因为
/// 契约里有它：真正加缓存时不该再改一次契约。
pub fn env_health(_recheck: bool) -> ApiResult<EnvHealthReport> {
    let mut items: Vec<EnvHealthItem> = PROBES.iter().map(probe_tool).collect();

    // ACP adapter 单独探：它们不在 PATH 里，而是装在 sidecar 的 node_modules 下
    for (runtime, label) in [
        ("acp.claude", "Claude Code（ACP）"),
        ("acp.codex", "Codex（ACP）"),
    ] {
        items.push(probe_adapter(runtime, label));
    }

    let ready = items
        .iter()
        .filter(|item| item.status != EnvStatus::Optional)
        .all(|item| item.status == EnvStatus::Ready);

    Ok(EnvHealthReport { ready, items })
}

fn probe_tool(
    (capability, label, command, version_arg, optional, detail): &(
        &str,
        &str,
        &str,
        &str,
        bool,
        &str,
    ),
) -> EnvHealthItem {
    let Some(path) = which(command) else {
        return EnvHealthItem {
            capability: (*capability).to_string(),
            label: (*label).to_string(),
            version: None,
            path: None,
            source: EnvSource::Missing,
            // 可选项缺失不是「有问题」，只是「这类工作流跑不了」
            status: if *optional {
                EnvStatus::Optional
            } else {
                EnvStatus::Missing
            },
            detail: Some((*detail).to_string()),
        };
    };

    EnvHealthItem {
        capability: (*capability).to_string(),
        label: (*label).to_string(),
        version: read_version(command, version_arg),
        path: Some(path),
        source: EnvSource::System,
        status: EnvStatus::Ready,
        detail: None,
    }
}

fn probe_adapter(runtime: &str, label: &str) -> EnvHealthItem {
    match aiwf_engine::acp::adapter_installed(runtime) {
        Some(path) => EnvHealthItem {
            capability: runtime.to_string(),
            label: label.to_string(),
            version: None,
            // 装在 sidecar 目录下的算 app_managed —— 它不进全局 PATH，
            // 这正是「不把 App 工具写入全局 PATH」那句话的落地
            source: if path.contains("node_modules") {
                EnvSource::AppManaged
            } else {
                EnvSource::System
            },
            path: Some(path),
            status: EnvStatus::Ready,
            detail: None,
        },
        None => EnvHealthItem {
            capability: runtime.to_string(),
            label: label.to_string(),
            version: None,
            path: None,
            source: EnvSource::Missing,
            // AI 节点与主管 AI 都要它，但没有它其余功能照常 ——
            // 所以是可选而不是缺失
            status: EnvStatus::Optional,
            detail: Some("AI 节点与主管 AI 需要它".to_string()),
        },
    }
}

fn which(command: &str) -> Option<String> {
    let output = Command::new("which").arg(command).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// 读版本号。读不到不算失败 —— 工具在就是在，版本只是补充信息。
fn read_version(command: &str, arg: &str) -> Option<String> {
    let output = Command::new(command).arg(arg).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    // 「git version 2.45.1」→「2.45.1」：前缀对用户没用，
    // 而表格里那一列窄得放不下整句
    Some(
        line.split_whitespace()
            .find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .unwrap_or(line)
            .trim_start_matches('v')
            .to_string(),
    )
}
