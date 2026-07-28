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
    // M3 起 AI 四类节点走 ACP。adapter 装没装是另一回事 ——
    // 那由下面的 check_acp 单独报，说的话也不一样：
    // 「类型没实现」是我们的问题，「adapter 没装」是用户能自己解决的
    "ai.analyze",
    "ai.execute",
    "ai.review",
    "ai.decide",
];

pub fn dry_run(graph: &WorkflowGraph, workdir: &Path) -> DryRunReport {
    let mut checks = Vec::new();

    checks.push(check_structure(graph));
    checks.push(check_reachable(graph));
    checks.push(check_workdir(workdir));
    checks.extend(check_interpreters(graph));
    checks.extend(check_git(graph));
    checks.extend(check_acp(graph));
    checks.extend(check_unimplemented(graph));
    checks.extend(check_double_quoting(graph));

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

/// 脚本里的 `${…}` 被自己又套了一层引号。
///
/// 引擎替进去的值**已经加过 shell 引号**（`interp::shell_quote`）——
/// 单引号内除了单引号本身没有元字符会被解释，那是刻意的安全设计。
/// 代价是脚本里不能再自己套一层：`"${input.issue}"` 会让命令收到
/// `"'1'"`，报出来的是「invalid issue format」这种离原因很远的话。
///
/// 端到端验证里 AI 写出的第一版脚本就踩了这个。引擎的行为没错，
/// 错在它只有跑起来才暴露 —— 而那时脚本可能已经产生了别的副作用。
fn check_double_quoting(graph: &WorkflowGraph) -> Vec<Check> {
    let mut 命中: Vec<String> = Vec::new();

    for node in &graph.nodes {
        if !matches!(node.node_type.as_str(), "script.shell" | "script.python") {
            continue;
        }
        let Some(script) = node
            .config
            .get("script")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        for 变量 in quoted_placeholders(script) {
            命中.push(format!("{}（{}）", node.id, 变量));
        }
    }

    if 命中.is_empty() {
        return Vec::new();
    }

    vec![Check {
        label: "脚本变量的引号".to_string(),
        status: CheckStatus::Failed,
        detail: format!(
            "这些地方给 ${{…}} 又套了一层引号：{}。\
             引擎替进去的值已经加过 shell 引号，再套一层命令会收到带引号的字面量。\
             去掉自己加的那对引号即可",
            命中.join("、")
        ),
    }]
}

/// 找出被引号**包住**的 `${…}`。
///
/// 只认「同一对引号里恰好包着一个占位符」这一种形态：
/// `"前缀"${x}` 是合法的（引号在变量之前就闭合了），
/// `"a ${x} b"` 也算命中 —— 那同样会把引号带进去。
fn quoted_placeholders(script: &str) -> Vec<String> {
    let bytes: Vec<char> = script.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        let quote = bytes[i];
        if quote != '"' && quote != '\'' {
            i += 1;
            continue;
        }
        // 找配对的闭引号
        let Some(close) = (i + 1..bytes.len()).find(|&j| bytes[j] == quote) else {
            break;
        };
        let inner: String = bytes[i + 1..close].iter().collect();
        if let Some(start) = inner.find("${") {
            if let Some(end) = inner[start..].find('}') {
                out.push(inner[start + 2..start + end].to_string());
            }
        }
        i = close + 1;
    }
    out
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

/// 每个节点都要能从入口走到。
///
/// 拓扑排序不管连通性：三个互不相连的节点照样能排出一个顺序，
/// 于是「可依次执行」这句话字面上没错，但用户拖了节点忘了连线时，
/// 那个孤立的脚本**真的会被执行** —— 而他完全没料到。
fn check_reachable(graph: &WorkflowGraph) -> Check {
    let entries: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type == "entry")
        .map(|node| node.id.as_str())
        .collect();

    if entries.is_empty() {
        return Check {
            label: "节点可达性".to_string(),
            status: CheckStatus::Failed,
            detail: "没有入口节点，所有节点都不可达".to_string(),
        };
    }

    let mut reached: BTreeSet<&str> = entries.iter().copied().collect();
    let mut frontier: Vec<&str> = entries;

    while let Some(current) = frontier.pop() {
        for next in graph.downstream(current) {
            if reached.insert(next) {
                frontier.push(next);
            }
        }
    }

    let orphans: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|node| !reached.contains(node.id.as_str()))
        .map(|node| node.title.as_str())
        .collect();

    if orphans.is_empty() {
        Check {
            label: "节点可达性".to_string(),
            status: CheckStatus::Passed,
            detail: format!("{} 个节点都能从入口走到", graph.nodes.len()),
        }
    } else {
        Check {
            label: "节点可达性".to_string(),
            status: CheckStatus::Failed,
            detail: format!(
                "这些节点从入口走不到，但仍会被执行：{}。多半是忘了连线",
                orphans.join("、")
            ),
        }
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

/// 图里有 AI 节点时，检查对应的 adapter 装没装。
///
/// 与「节点类型没实现」分开报：那是我们的问题，这是用户能自己解决的 ——
/// 错误信息也就该长得不一样（一个说「运行会停在这里」，
/// 一个说「装上它就能跑」）。
fn check_acp(graph: &WorkflowGraph) -> Vec<Check> {
    let runtimes: BTreeSet<&str> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type.starts_with("ai."))
        .map(|node| {
            node.config
                .get("runtime")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("acp.claude")
        })
        .collect();

    runtimes
        .into_iter()
        .map(|runtime| match crate::acp::adapter_installed(runtime) {
            Some(path) => Check {
                label: format!("ACP adapter {runtime}"),
                status: CheckStatus::Passed,
                detail: path,
            },
            None => Check {
                label: format!("ACP adapter {runtime}"),
                status: CheckStatus::Failed,
                detail: format!(
                    "{} 没有安装。装上它才能跑 AI 节点",
                    crate::acp::adapter_command(runtime).map_or("adapter", |(cmd, _)| cmd)
                ),
            },
        })
        .collect()
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
