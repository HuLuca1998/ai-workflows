//! Dry Run 依赖检查。
//!
//! 一条原则：**只列真的查过的项**。查不了的（ACP 握手、网络白名单）
//! 不出现在结果里 —— 一个永远显示「通过」的条目比没有这个条目更糟，
//! 它会让用户以为已经验证过了。
//!
//! 同样地，与这个工作流无关的检查也不列：图里没有 git 节点就不查 git，
//! 否则用户会以为自己缺了什么必需的东西。

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::graph::WorkflowGraph;
use crate::plan::ExecutionPlan;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Passed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub label: String,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DryRunReport {
    pub checks: Vec<Check>,
    pub passed: usize,
    pub failed: usize,
    pub ok: bool,
}

/// 引擎已经能真实执行的节点类型。其余的在 Dry Run 阶段就要说清楚 ——
/// 跑到一半才说「尚未实现」太晚了，那时已经产生了副作用。
const IMPLEMENTED: &[&str] = &[
    "entry",
    "end",
    "notify",
    "approval",
    "script.shell",
    "git.worktree",
];

pub fn dry_run(graph: &WorkflowGraph, workdir: &Path) -> DryRunReport {
    let mut checks = Vec::new();

    checks.push(check_structure(graph));
    checks.push(check_workdir(workdir));
    checks.extend(check_interpreters(graph));
    checks.extend(check_git(graph));
    checks.extend(check_unimplemented(graph));

    let passed = checks
        .iter()
        .filter(|c| c.status == CheckStatus::Passed)
        .count();
    let failed = checks.len() - passed;

    DryRunReport {
        checks,
        passed,
        failed,
        ok: failed == 0,
    }
}

fn check_structure(graph: &WorkflowGraph) -> Check {
    if !graph.nodes.iter().any(|n| n.node_type == "entry") {
        return Check {
            label: "图结构".to_string(),
            status: CheckStatus::Failed,
            detail: "缺少入口节点，运行无从开始".to_string(),
        };
    }

    match ExecutionPlan::build(graph) {
        Ok(plan) => Check {
            label: "图结构".to_string(),
            status: CheckStatus::Passed,
            detail: format!("{} 个节点可依次执行", plan.order().len()),
        },
        Err(error) => Check {
            label: "图结构".to_string(),
            status: CheckStatus::Failed,
            detail: error.to_string(),
        },
    }
}

fn check_workdir(workdir: &Path) -> Check {
    if workdir.is_dir() {
        Check {
            label: "工作目录".to_string(),
            status: CheckStatus::Passed,
            detail: workdir.display().to_string(),
        }
    } else {
        Check {
            label: "工作目录".to_string(),
            status: CheckStatus::Failed,
            detail: format!("{} 不存在或不是目录", workdir.display()),
        }
    }
}

fn check_interpreters(graph: &WorkflowGraph) -> Vec<Check> {
    // BTreeSet 去重且顺序稳定：同一个解释器用在多个节点上只查一次
    let interpreters: BTreeSet<&str> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type == "script.shell")
        .map(|node| {
            node.config
                .get("interpreter")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("zsh")
        })
        .collect();

    interpreters
        .into_iter()
        .map(|interpreter| match which(interpreter) {
            Some(path) => Check {
                label: format!("解释器 {interpreter}"),
                status: CheckStatus::Passed,
                detail: path,
            },
            None => Check {
                label: format!("解释器 {interpreter}"),
                status: CheckStatus::Failed,
                detail: format!("PATH 里找不到 {interpreter}"),
            },
        })
        .collect()
}

fn check_git(graph: &WorkflowGraph) -> Vec<Check> {
    if !graph.nodes.iter().any(|n| n.node_type == "git.worktree") {
        return vec![];
    }
    vec![match git_version() {
        Some(version) => Check {
            label: "git".to_string(),
            status: CheckStatus::Passed,
            detail: version,
        },
        None => Check {
            label: "git".to_string(),
            status: CheckStatus::Failed,
            detail: "PATH 里找不到 git，worktree 节点无法执行".to_string(),
        },
    }]
}

fn check_unimplemented(graph: &WorkflowGraph) -> Vec<Check> {
    let missing: BTreeSet<&str> = graph
        .nodes
        .iter()
        .map(|node| node.node_type.as_str())
        .filter(|node_type| !IMPLEMENTED.contains(node_type))
        .collect();

    missing
        .into_iter()
        .map(|node_type| Check {
            label: format!("节点类型 {node_type}"),
            status: CheckStatus::Failed,
            detail: format!("{node_type} 尚未实现，运行会在这个节点停下"),
        })
        .collect()
}

fn which(program: &str) -> Option<String> {
    let output = Command::new("which").arg(program).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

fn git_version() -> Option<String> {
    let output = Command::new("git").arg("--version").output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}
