//! 两份图之间的差异 —— `packages/contracts/src/diff.ts` 的 `diffGraphs` 在 Rust 这一侧。
//!
//! 用途：版本抽屉里「草稿 vs 某个已发布版本」的对比，以及 `workflow.diff`。
//! 与 `apply_patch` 产出的 Diff 是同一种结构，界面用同一套渲染。
//!
//! 位置变化**不算改动**：布局不影响执行语义，把挪动节点也标成变更
//! 会让版本对比被噪音淹没。
//!
//! 一致性由 `tests/conformance_test.rs` 压着。

use serde_json::Value;

use crate::patch::{DiffEntry, WorkflowDiff};

#[must_use]
pub fn diff_graphs(before: &Value, after: &Value) -> WorkflowDiff {
    let mut diff = WorkflowDiff::default();

    let before_nodes = list(before, "nodes");
    let after_nodes = list(after, "nodes");

    for node in &after_nodes {
        if find(&before_nodes, id_of(node)).is_none() {
            diff.added.push(DiffEntry {
                kind: "node",
                id: id_of(node).to_string(),
                label: node_label(node),
                before: None,
                after: Some(config_of(node)),
            });
        }
    }
    for node in &before_nodes {
        if find(&after_nodes, id_of(node)).is_none() {
            diff.removed.push(DiffEntry {
                kind: "node",
                id: id_of(node).to_string(),
                label: node_label(node),
                before: Some(config_of(node)),
                after: None,
            });
        }
    }
    for node in &after_nodes {
        let Some(old) = find(&before_nodes, id_of(node)) else {
            continue;
        };
        if let Some(entry) = describe_node_change(old, node) {
            diff.changed.push(entry);
        }
    }

    let before_edges = list(before, "edges");
    let after_edges = list(after, "edges");
    for edge in &after_edges {
        if find(&before_edges, id_of(edge)).is_none() {
            diff.added.push(DiffEntry {
                kind: "edge",
                id: id_of(edge).to_string(),
                label: edge_label(edge),
                before: None,
                after: Some((*edge).clone()),
            });
        }
    }
    for edge in &before_edges {
        if find(&after_edges, id_of(edge)).is_none() {
            diff.removed.push(DiffEntry {
                kind: "edge",
                id: id_of(edge).to_string(),
                label: edge_label(edge),
                before: Some((*edge).clone()),
                after: None,
            });
        }
    }

    let before_groups = list(before, "groups");
    let after_groups = list(after, "groups");
    for group in &after_groups {
        if find(&before_groups, id_of(group)).is_none() {
            diff.added.push(DiffEntry {
                kind: "group",
                id: id_of(group).to_string(),
                label: format!("group「{}」", text(group, "title")),
                before: None,
                after: Some((*group).clone()),
            });
        }
    }
    for group in &before_groups {
        if find(&after_groups, id_of(group)).is_none() {
            diff.removed.push(DiffEntry {
                kind: "group",
                id: id_of(group).to_string(),
                label: format!("group「{}」", text(group, "title")),
                before: Some((*group).clone()),
                after: None,
            });
        }
    }

    diff
}

fn describe_node_change(before: &Value, after: &Value) -> Option<DiffEntry> {
    let mut parts: Vec<String> = Vec::new();

    let before_title = text(before, "title");
    let after_title = text(after, "title");
    if before_title != after_title {
        parts.push(format!("标题 {before_title} → {after_title}"));
    }

    let empty = serde_json::Map::new();
    let before_config = before
        .get("config")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let after_config = after
        .get("config")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    // 键的遍历顺序要和 `new Set([...before, ...after])` 一致：
    // before 的键按原序，再补上 after 里新出现的
    let mut keys: Vec<&String> = before_config.keys().collect();
    for key in after_config.keys() {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    for key in keys {
        let a = before_config.get(key);
        let b = after_config.get(key);
        if a == b {
            continue;
        }
        parts.push(format!("{key} {} → {}", format_value(a), format_value(b)));
    }

    if before.get("join") != after.get("join") {
        parts.push(format!(
            "汇聚策略 {} → {}",
            strategy(before.get("join")),
            strategy(after.get("join"))
        ));
    }

    // 位置刻意不比较：布局变化不影响执行语义
    if parts.is_empty() {
        return None;
    }

    Some(DiffEntry {
        kind: "node",
        id: id_of(after).to_string(),
        label: format!("node {}：{}", id_of(after), parts.join("，")),
        before: Some(config_of(before)),
        after: Some(config_of(after)),
    })
}

/// 值太长时截断，Diff 行要能一眼看完。
///
/// 截断按**字符**而不是字节：中文配置按字节切会切出半个字，
/// 那一行在界面上是一个乱码方块。
fn format_value(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return "未设置".to_string();
    };
    let text = match value {
        Value::String(raw) => raw.clone(),
        other => other.to_string(),
    };
    if text.chars().count() > 24 {
        format!("{}…", text.chars().take(24).collect::<String>())
    } else {
        text
    }
}

fn strategy(join: Option<&Value>) -> String {
    join.and_then(|value| value.get("strategy"))
        .and_then(Value::as_str)
        .unwrap_or("默认")
        .to_string()
}

fn node_label(node: &Value) -> String {
    format!("node {}「{}」", text(node, "type"), text(node, "title"))
}

fn edge_label(edge: &Value) -> String {
    format!(
        "edge {}.{} → {}",
        endpoint(edge, "source", "nodeId"),
        endpoint(edge, "source", "port"),
        endpoint(edge, "target", "nodeId")
    )
}

fn config_of(node: &Value) -> Value {
    node.get("config").cloned().unwrap_or(Value::Null)
}

fn list<'a>(graph: &'a Value, key: &str) -> Vec<&'a Value> {
    graph
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn find<'a>(items: &[&'a Value], id: &str) -> Option<&'a Value> {
    items.iter().copied().find(|item| id_of(item) == id)
}

fn id_of(value: &Value) -> &str {
    text(value, "id")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn endpoint<'a>(edge: &'a Value, side: &str, key: &str) -> &'a str {
    edge.get(side)
        .and_then(|node| node.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
}
