//! 图校验 —— `packages/contracts/src/graph.ts` 的 `validateGraph` 在 Rust 这一侧。
//!
//! 两份实现是有代价的，代价的对冲是 `tests/conformance_test.rs`：
//! 夹具输入写在契约里，期望输出由 TypeScript 那份算出来，这边逐条比，
//! **连错误文案都比**。改这里之前先去改夹具，让它红一次。
//!
//! 为什么非要第二份：`workflow.validate` 原先只有 TypeScript 有，
//! 于是从 MCP 连进来的 Agent 没法在提交前自己检查一遍 ——
//! 它只能把一张可能有问题的图写进草稿，等用户打开界面才发现。

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::catalog;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ValidationIssue {
    pub level: &'static str,
    pub code: &'static str,
    pub message: String,
    #[serde(rename = "nodeId", skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(rename = "edgeId", skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ValidationResult {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
}

/// 图里的一个节点，只取校验用得上的那几项。
struct NodeView<'a> {
    id: &'a str,
    node_type: &'a str,
    config: &'a Value,
    join: Option<&'a Value>,
}

/// 校验一张图。issue 的顺序与 TypeScript 那份严格一致 ——
/// 界面按顺序渲染问题列表，顺序不同的话「第一个问题」就换了一条。
#[must_use]
pub fn validate_graph(graph: &Value) -> ValidationResult {
    let mut issues: Vec<ValidationIssue> = Vec::new();

    let nodes = array(graph, "nodes");
    let edges = array(graph, "edges");

    // ── 先建 id → 节点。重复的 id 在这里就报掉，后面一律按第一个算 ──
    let mut by_id: Vec<NodeView<'_>> = Vec::new();
    let mut seen_ids: HashSet<&str> = HashSet::new();
    for node in &nodes {
        let id = text(node, "id");
        if !seen_ids.insert(id) {
            issues.push(error(
                "DUPLICATE_NODE_ID",
                format!("节点 id {id} 重复"),
                Some(id.to_string()),
                None,
            ));
            continue;
        }
        by_id.push(NodeView {
            id,
            node_type: text(node, "type"),
            config: node.get("config").unwrap_or(&Value::Null),
            join: node.get("join").filter(|value| value.is_object()),
        });
    }

    // ── 节点类型与配置 ──
    for node in &by_id {
        if !catalog::is_known(node.node_type) {
            issues.push(error(
                "UNKNOWN_NODE_TYPE",
                format!("节点类型 {} 未登记", node.node_type),
                Some(node.id.to_string()),
                None,
            ));
            continue;
        }
        if let Err(details) = catalog::parse_config(node.node_type, node.config) {
            issues.push(error(
                "INVALID_CONFIG",
                format!("配置不合法 —— {}", details.join("；")),
                Some(node.id.to_string()),
                None,
            ));
        }
    }

    // ── 入口与结束 ──
    let entries: Vec<&NodeView<'_>> = by_id.iter().filter(|n| n.node_type == "entry").collect();
    if entries.is_empty() {
        issues.push(error(
            "ENTRY_MISSING",
            "工作流缺少入口节点，启动表单无从生成".to_string(),
            None,
            None,
        ));
    } else {
        for extra in entries.iter().skip(1) {
            issues.push(error(
                "ENTRY_DUPLICATE",
                "入口节点必须全图唯一".to_string(),
                Some(extra.id.to_string()),
                None,
            ));
        }
    }
    if !by_id.is_empty() && !by_id.iter().any(|n| n.node_type == "end") {
        issues.push(warning(
            "END_MISSING",
            "没有结束节点，运行结果不会被显式标记".to_string(),
            None,
            None,
        ));
    }

    // ── 连线 ──
    let lookup: BTreeMap<&str, &NodeView<'_>> = by_id.iter().map(|n| (n.id, n)).collect();
    let mut seen_edge_keys: HashSet<String> = HashSet::new();
    for edge in &edges {
        let edge_id = text(edge, "id");
        let source_id = nested(edge, "source", "nodeId");
        let source_port = nested(edge, "source", "port");
        let target_id = nested(edge, "target", "nodeId");
        let target_port = nested(edge, "target", "port");

        let (Some(source), Some(target)) = (lookup.get(source_id), lookup.get(target_id)) else {
            issues.push(error(
                "DANGLING_EDGE",
                "连线指向不存在的节点".to_string(),
                None,
                Some(edge_id.to_string()),
            ));
            continue;
        };

        let key = format!("{source_id}:{source_port}->{target_id}:{target_port}");
        if !seen_edge_keys.insert(key) {
            issues.push(warning(
                "DUPLICATE_EDGE",
                "重复连线".to_string(),
                None,
                Some(edge_id.to_string()),
            ));
        }

        if catalog::is_known(source.node_type) {
            let ports = catalog::outputs(source.node_type, source.config);
            if !ports.iter().any(|port| port.id == source_port) {
                issues.push(error(
                    "UNKNOWN_PORT",
                    format!("{} 没有输出端口 {source_port}", source.id),
                    None,
                    Some(edge_id.to_string()),
                ));
            }
        }
        if catalog::is_known(target.node_type) {
            if target.node_type == "entry" {
                issues.push(error(
                    "ENTRY_HAS_INPUT",
                    "入口节点不能有入边".to_string(),
                    Some(target.id.to_string()),
                    Some(edge_id.to_string()),
                ));
            }
            let ports = catalog::inputs(target.node_type);
            if target.node_type != "entry" && !ports.iter().any(|port| port.id == target_port) {
                issues.push(error(
                    "UNKNOWN_PORT",
                    format!("{} 没有输入端口 {target_port}", target.id),
                    None,
                    Some(edge_id.to_string()),
                ));
            }
        }
    }

    // ── 汇聚策略 ──
    for node in &by_id {
        let Some(join) = node.join else { continue };
        if join.get("strategy").and_then(Value::as_str) != Some("quorum") {
            continue;
        }
        let incoming = edges
            .iter()
            .filter(|edge| nested(edge, "target", "nodeId") == node.id)
            .count();
        let quorum = join.get("quorum").and_then(Value::as_i64);
        let out_of_range = match quorum {
            None => true,
            Some(value) => value < 1 || value > incoming as i64,
        };
        if out_of_range {
            let current = quorum.map_or_else(|| "未设置".to_string(), |value| value.to_string());
            issues.push(error(
                "JOIN_QUORUM_INVALID",
                format!("Quorum 需在 1..{incoming} 之间，当前为 {current}"),
                Some(node.id.to_string()),
                None,
            ));
        }
    }

    // ── 环 ──
    for node_id in cyclic_nodes(&by_id, &edges) {
        issues.push(error(
            "CYCLE",
            "节点位于环上，工作流必须是有向无环图".to_string(),
            Some(node_id),
            None,
        ));
    }

    // ── 可达性 ──
    //
    // warning 而不是 error：编辑中途拖进来一个还没连线的节点是正常状态。
    // 文案说的是「它仍会被执行」而不是「会被跳过」—— 调度器挑的是
    // 「上游都完成了的节点」，没有上游的节点第一轮就满足条件
    match entries.first() {
        Some(entry) => {
            let reachable = reachable_from(entry.id, &edges);
            for node in &by_id {
                if !reachable.contains(node.id) {
                    issues.push(warning(
                        "ORPHAN_NODE",
                        "从入口连不到这个节点，但运行时它仍会被执行 —— 多半是忘了连线".to_string(),
                        Some(node.id.to_string()),
                        None,
                    ));
                }
            }
        }
        None => {
            for node in &by_id {
                issues.push(warning(
                    "ORPHAN_NODE",
                    "没有入口节点，无法判定可达性".to_string(),
                    Some(node.id.to_string()),
                    None,
                ));
            }
        }
    }

    ValidationResult {
        ok: !issues.iter().any(|issue| issue.level == "error"),
        issues,
    }
}

/// Kahn 排不掉的节点就是环上的节点。
fn cyclic_nodes(nodes: &[NodeView<'_>], edges: &[&Value]) -> Vec<String> {
    let ids: Vec<&str> = nodes.iter().map(|n| n.id).collect();
    let known: HashSet<&str> = ids.iter().copied().collect();

    let mut indegree: BTreeMap<&str, i64> = ids.iter().map(|id| (*id, 0)).collect();
    for edge in edges {
        let source = nested(edge, "source", "nodeId");
        let target = nested(edge, "target", "nodeId");
        if !known.contains(source) || !known.contains(target) {
            continue;
        }
        *indegree.entry(target).or_insert(0) += 1;
    }

    // 按 nodes 数组顺序入队：同层节点的输出顺序要稳定
    let mut queue: Vec<&str> = ids
        .iter()
        .copied()
        .filter(|id| indegree.get(id).copied().unwrap_or(0) == 0)
        .collect();
    let mut order: Vec<&str> = Vec::new();

    let mut head = 0;
    while head < queue.len() {
        let current = queue[head];
        head += 1;
        order.push(current);
        for edge in edges {
            if nested(edge, "source", "nodeId") != current {
                continue;
            }
            let target = nested(edge, "target", "nodeId");
            if !known.contains(target) {
                continue;
            }
            let left = indegree.entry(target).or_insert(0);
            *left -= 1;
            if *left == 0 {
                queue.push(target);
            }
        }
    }

    let sorted: HashSet<&str> = order.into_iter().collect();
    ids.into_iter()
        .filter(|id| !sorted.contains(id))
        .map(str::to_string)
        .collect()
}

fn reachable_from<'a>(start: &'a str, edges: &[&'a Value]) -> HashSet<&'a str> {
    let mut seen: HashSet<&str> = HashSet::new();
    seen.insert(start);
    let mut stack = vec![start];

    while let Some(current) = stack.pop() {
        for edge in edges {
            if nested(edge, "source", "nodeId") != current {
                continue;
            }
            let target = nested(edge, "target", "nodeId");
            if seen.insert(target) {
                stack.push(target);
            }
        }
    }
    seen
}

fn error(
    code: &'static str,
    message: String,
    node_id: Option<String>,
    edge_id: Option<String>,
) -> ValidationIssue {
    ValidationIssue {
        level: "error",
        code,
        message,
        node_id,
        edge_id,
    }
}

fn warning(
    code: &'static str,
    message: String,
    node_id: Option<String>,
    edge_id: Option<String>,
) -> ValidationIssue {
    ValidationIssue {
        level: "warning",
        code,
        message,
        node_id,
        edge_id,
    }
}

fn array<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn nested<'a>(value: &'a Value, outer: &str, inner: &str) -> &'a str {
    value
        .get(outer)
        .and_then(|node| node.get(inner))
        .and_then(Value::as_str)
        .unwrap_or_default()
}
