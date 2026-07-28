//! 结构化 Patch —— `packages/contracts/src/patch.ts` 的 `applyPatch` 在 Rust 这一侧。
//!
//! 刻意**没有** replaceGraph / setGraphJson：整份回写会绕过版本守卫与 Diff，
//! AI 一旦写坏就无法解释和回滚（技术选型 §6）。存储层的
//! `workflow_save_draft` 是整份回写，那条路只留给界面 ——
//! 界面在本地已经走过一次 applyPatch，Diff 是给用户看过的。
//!
//! 与 TypeScript 那份的一致性由 `tests/conformance_test.rs` 压着，
//! 包括错误码与错误文案。

use serde::Serialize;
use serde_json::{Map, Value};

use crate::catalog;
use crate::validate::{ValidationResult, validate_graph};

#[derive(Debug, thiserror::Error)]
pub enum PatchError {
    /// 读到的草稿已经不是当前的了。**不是 VALIDATION**：
    /// 这个码决定界面是「重新读取草稿」还是「让用户去改配置」，
    /// 混成一个的话用户会被要求去修一个根本没问题的字段。
    #[error("草稿已变化：baseRevision {base}，当前 rev {current}")]
    RevisionConflict { base: i64, current: i64 },

    #[error("{0}")]
    Validation(String),
}

impl PatchError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::RevisionConflict { .. } => "REVISION_CONFLICT",
            Self::Validation(_) => "VALIDATION",
        }
    }

    /// 界面直接展示的「接下来该干什么」。
    #[must_use]
    pub fn hint(&self) -> &'static str {
        match self {
            Self::RevisionConflict { .. } => "重新读取草稿并基于最新 rev 重新生成 Patch",
            Self::Validation(_) => "先用 workflow.get 读取当前草稿，再基于真实 id 重试",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffEntry {
    pub kind: &'static str,
    pub id: String,
    /// 面向用户的一行描述，直接渲染在 Diff 面板里。
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkflowDiff {
    pub added: Vec<DiffEntry>,
    pub removed: Vec<DiffEntry>,
    pub changed: Vec<DiffEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PatchResult {
    pub rev: i64,
    pub graph: Value,
    pub diff: WorkflowDiff,
    pub validation: ValidationResult,
}

type Result<T> = std::result::Result<T, PatchError>;

/// 应用一批操作。**要么全部成功，要么整批不生效** —— 不留半截草稿。
///
/// # Errors
/// baseRevision 与当前不符、或任何一个操作不合法时整批拒绝。
pub fn apply_patch(graph: &Value, current_revision: i64, patch: &Value) -> Result<PatchResult> {
    let base = patch
        .get("baseRevision")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if base != current_revision {
        return Err(PatchError::RevisionConflict {
            base,
            current: current_revision,
        });
    }

    let mut next = graph.clone();
    ensure_shape(&mut next);
    let mut diff = WorkflowDiff::default();

    let operations = patch
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for (index, operation) in operations.iter().enumerate() {
        apply_one(&mut next, &mut diff, operation, index)?;
    }

    let validation = validate_graph(&next);
    Ok(PatchResult {
        rev: current_revision + 1,
        graph: next,
        diff,
        validation,
    })
}

/// 图上缺的数组补成空数组。
///
/// 存储层里躺着的老草稿可能没有 `groups` —— 那时 `createGroup`
/// 会静默地什么都不做，而调用方拿到一个「成功」的返回值。
fn ensure_shape(graph: &mut Value) {
    if !graph.is_object() {
        *graph = Value::Object(Map::new());
    }
    for key in ["nodes", "edges", "groups"] {
        if !graph.get(key).is_some_and(Value::is_array) {
            graph[key] = Value::Array(Vec::new());
        }
    }
}

fn apply_one(
    graph: &mut Value,
    diff: &mut WorkflowDiff,
    operation: &Value,
    index: usize,
) -> Result<()> {
    let op = operation.get("op").and_then(Value::as_str).unwrap_or("");

    match op {
        "addNode" => add_node(graph, diff, operation, index),
        "removeNode" => remove_node(graph, diff, operation),
        "renameNode" => rename_node(graph, diff, operation),
        "moveNode" => move_node(graph, operation),
        "setConfig" => set_config(graph, diff, operation),
        "setJoin" => set_join(graph, diff, operation),
        "setCapabilities" => merge_into(graph, diff, operation, "capabilities"),
        "setRetry" => merge_into(graph, diff, operation, "retry"),
        "connect" => connect(graph, diff, operation),
        "disconnect" => disconnect(graph, diff, operation),
        "createGroup" => create_group(graph, diff, operation),
        "deleteGroup" => delete_group(graph, diff, operation),
        other => Err(PatchError::Validation(format!("未知的操作 {other}"))),
    }
}

// ── 操作 ────────────────────────────────────────────────────────────────────

fn add_node(
    graph: &mut Value,
    diff: &mut WorkflowDiff,
    operation: &Value,
    index: usize,
) -> Result<()> {
    let node_type = str_field(operation, "type");
    let title = str_field(operation, "title");

    let node_id = match operation.get("nodeId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        // 自动编号与 TypeScript 一致：类型里的点换成下划线，再接当前节点数 + 1
        _ => format!("{}_{}", node_type.replace('.', "_"), nodes(graph).len() + 1),
    };

    if nodes(graph)
        .iter()
        .any(|node| node.get("id").and_then(Value::as_str) == Some(node_id.as_str()))
    {
        return Err(PatchError::Validation(format!("节点 id {node_id} 已存在")));
    }

    // 用节点定义解析一次，把 Schema 默认值固化进草稿：
    // 运行时行为不依赖读取方
    let config = catalog::parse_config(node_type, operation.get("config").unwrap_or(&Value::Null))
        .map_err(|_| PatchError::Validation(format!("第 {} 个操作的节点配置不合法", index + 1)))?;

    let mut node = Map::new();
    node.insert("id".to_string(), Value::String(node_id.clone()));
    node.insert("type".to_string(), Value::String(node_type.to_string()));
    node.insert("title".to_string(), Value::String(title.to_string()));
    node.insert(
        "position".to_string(),
        operation.get("position").cloned().unwrap_or(Value::Null),
    );
    node.insert("config".to_string(), config.clone());

    graph["nodes"]
        .as_array_mut()
        .ok_or_else(|| PatchError::Validation("图的 nodes 不是数组".to_string()))?
        .push(Value::Object(node));

    diff.added.push(DiffEntry {
        kind: "node",
        id: node_id,
        label: format!("node {node_type}「{title}」"),
        before: None,
        after: Some(config),
    });
    Ok(())
}

fn remove_node(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let node_id = str_field(operation, "nodeId");
    let node = find_node(graph, node_id)?.clone();

    graph["nodes"] = Value::Array(
        nodes(graph)
            .into_iter()
            .filter(|item| item.get("id").and_then(Value::as_str) != Some(node_id))
            .cloned()
            .collect(),
    );

    // 删节点必须连带断线，否则会留下悬空边
    let orphans: Vec<Value> = edges(graph)
        .into_iter()
        .filter(|edge| endpoint(edge, "source") == node_id || endpoint(edge, "target") == node_id)
        .cloned()
        .collect();
    graph["edges"] = Value::Array(
        edges(graph)
            .into_iter()
            .filter(|edge| !orphans.iter().any(|orphan| orphan == *edge))
            .cloned()
            .collect(),
    );

    diff.removed.push(DiffEntry {
        kind: "node",
        id: node_id.to_string(),
        label: format!(
            "node {}「{}」",
            str_field(&node, "type"),
            str_field(&node, "title")
        ),
        before: Some(node),
        after: None,
    });
    for edge in orphans {
        diff.removed.push(DiffEntry {
            kind: "edge",
            id: str_field(&edge, "id").to_string(),
            label: format!(
                "edge {} → {}",
                endpoint(&edge, "source"),
                endpoint(&edge, "target")
            ),
            before: Some(edge),
            after: None,
        });
    }
    Ok(())
}

fn rename_node(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let node_id = str_field(operation, "nodeId");
    let title = str_field(operation, "title").to_string();
    let before = str_field(find_node(graph, node_id)?, "title").to_string();

    node_mut(graph, node_id)?["title"] = Value::String(title.clone());

    diff.changed.push(DiffEntry {
        kind: "node",
        id: node_id.to_string(),
        label: format!("node {node_id}：标题 {before} → {title}"),
        before: Some(Value::String(before)),
        after: Some(Value::String(title)),
    });
    Ok(())
}

/// 位置变化不进 Diff：它不改变执行语义。
fn move_node(graph: &mut Value, operation: &Value) -> Result<()> {
    let node_id = str_field(operation, "nodeId");
    find_node(graph, node_id)?;
    node_mut(graph, node_id)?["position"] =
        operation.get("position").cloned().unwrap_or(Value::Null);
    Ok(())
}

fn set_config(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let node_id = str_field(operation, "nodeId");
    let node = find_node(graph, node_id)?;
    let node_type = str_field(node, "type").to_string();
    let before = node.get("config").cloned().unwrap_or(Value::Null);

    let config = catalog::parse_config(&node_type, operation.get("config").unwrap_or(&Value::Null))
        .map_err(|_| PatchError::Validation(format!("节点 {node_id} 的新配置不合法")))?;

    node_mut(graph, node_id)?["config"] = config.clone();

    diff.changed.push(DiffEntry {
        kind: "node",
        id: node_id.to_string(),
        label: format!("node {node_id}：配置更新"),
        before: Some(before),
        after: Some(config),
    });
    Ok(())
}

fn set_join(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let node_id = str_field(operation, "nodeId");
    let before = find_node(graph, node_id)?.get("join").cloned();
    let join = operation.get("join").cloned().unwrap_or(Value::Null);
    let strategy = join
        .get("strategy")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    node_mut(graph, node_id)?["join"] = join.clone();

    diff.changed.push(DiffEntry {
        kind: "node",
        id: node_id.to_string(),
        label: format!("node {node_id}：汇聚策略 → {strategy}"),
        before,
        after: Some(join),
    });
    Ok(())
}

/// setCapabilities / setRetry：**合并**而不是替换。
///
/// 替换的话「只想把 maxAttempts 改成 3」会把 backoff 与 idempotency
/// 一起抹掉，而那两项决定了副作用操作重试前要不要先核对外部状态。
fn merge_into(
    graph: &mut Value,
    diff: &mut WorkflowDiff,
    operation: &Value,
    field: &str,
) -> Result<()> {
    let node_id = str_field(operation, "nodeId");
    let before = find_node(graph, node_id)?.get(field).cloned();

    let mut merged = before
        .as_ref()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(patch) = operation.get(field).and_then(Value::as_object) {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    let after = Value::Object(merged);
    node_mut(graph, node_id)?[field] = after.clone();

    diff.changed.push(DiffEntry {
        kind: "node",
        id: node_id.to_string(),
        label: if field == "capabilities" {
            format!("node {node_id}：能力声明变更（扩权会让已保存的信任策略失效）")
        } else {
            format!("node {node_id}：重试策略变更")
        },
        before,
        after: Some(after),
    });
    Ok(())
}

fn connect(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let source = operation.get("source").cloned().unwrap_or(Value::Null);
    let target = operation.get("target").cloned().unwrap_or(Value::Null);
    find_node(graph, nested(&source, "nodeId"))?;
    find_node(graph, nested(&target, "nodeId"))?;

    let edge_id = match operation.get("edgeId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => format!("edge_{}", edges(graph).len() + 1),
    };
    if edges(graph)
        .iter()
        .any(|edge| edge.get("id").and_then(Value::as_str) == Some(edge_id.as_str()))
    {
        return Err(PatchError::Validation(format!("连线 id {edge_id} 已存在")));
    }

    let mut edge = Map::new();
    edge.insert("id".to_string(), Value::String(edge_id.clone()));
    edge.insert("source".to_string(), source.clone());
    edge.insert("target".to_string(), target.clone());
    let edge = Value::Object(edge);

    graph["edges"]
        .as_array_mut()
        .ok_or_else(|| PatchError::Validation("图的 edges 不是数组".to_string()))?
        .push(edge.clone());

    diff.added.push(DiffEntry {
        kind: "edge",
        id: edge_id,
        label: format!(
            "edge {}.{} → {}",
            nested(&source, "nodeId"),
            nested(&source, "port"),
            nested(&target, "nodeId")
        ),
        before: None,
        after: Some(edge),
    });
    Ok(())
}

fn disconnect(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let edge_id = str_field(operation, "edgeId");
    let edge = edges(graph)
        .into_iter()
        .find(|edge| edge.get("id").and_then(Value::as_str) == Some(edge_id))
        .cloned()
        .ok_or_else(|| PatchError::Validation(format!("连线 {edge_id} 不存在")))?;

    graph["edges"] = Value::Array(
        edges(graph)
            .into_iter()
            .filter(|item| item.get("id").and_then(Value::as_str) != Some(edge_id))
            .cloned()
            .collect(),
    );

    diff.removed.push(DiffEntry {
        kind: "edge",
        id: edge_id.to_string(),
        label: format!(
            "edge {}.{} → {}",
            endpoint(&edge, "source"),
            edge.get("source")
                .map(|s| nested(s, "port"))
                .unwrap_or_default(),
            endpoint(&edge, "target")
        ),
        before: Some(edge),
        after: None,
    });
    Ok(())
}

fn create_group(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let title = str_field(operation, "title").to_string();
    let node_ids = operation
        .get("nodeIds")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    let group_id = match operation.get("groupId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => format!("group_{}", groups(graph).len() + 1),
    };

    for node_id in node_ids.as_array().cloned().unwrap_or_default() {
        find_node(graph, node_id.as_str().unwrap_or_default())?;
    }

    let mut group = Map::new();
    group.insert("id".to_string(), Value::String(group_id.clone()));
    group.insert("title".to_string(), Value::String(title.clone()));
    group.insert("nodeIds".to_string(), node_ids);
    let group = Value::Object(group);

    graph["groups"]
        .as_array_mut()
        .ok_or_else(|| PatchError::Validation("图的 groups 不是数组".to_string()))?
        .push(group.clone());

    diff.added.push(DiffEntry {
        kind: "group",
        id: group_id,
        label: format!("group「{title}」"),
        before: None,
        after: Some(group),
    });
    Ok(())
}

fn delete_group(graph: &mut Value, diff: &mut WorkflowDiff, operation: &Value) -> Result<()> {
    let group_id = str_field(operation, "groupId");
    let group = groups(graph)
        .into_iter()
        .find(|group| group.get("id").and_then(Value::as_str) == Some(group_id))
        .cloned()
        .ok_or_else(|| PatchError::Validation(format!("分组 {group_id} 不存在")))?;

    graph["groups"] = Value::Array(
        groups(graph)
            .into_iter()
            .filter(|item| item.get("id").and_then(Value::as_str) != Some(group_id))
            .cloned()
            .collect(),
    );

    diff.removed.push(DiffEntry {
        kind: "group",
        id: group_id.to_string(),
        label: format!("group「{}」", str_field(&group, "title")),
        before: Some(group),
        after: None,
    });
    Ok(())
}

// ── 取值助手 ────────────────────────────────────────────────────────────────

fn nodes(graph: &Value) -> Vec<&Value> {
    graph
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn edges(graph: &Value) -> Vec<&Value> {
    graph
        .get("edges")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn groups(graph: &Value) -> Vec<&Value> {
    graph
        .get("groups")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn find_node<'a>(graph: &'a Value, node_id: &str) -> Result<&'a Value> {
    nodes(graph)
        .into_iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
        .ok_or_else(|| PatchError::Validation(format!("节点 {node_id} 不存在")))
}

fn node_mut<'a>(graph: &'a mut Value, node_id: &str) -> Result<&'a mut Value> {
    graph
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .and_then(|items| {
            items
                .iter_mut()
                .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
        })
        .ok_or_else(|| PatchError::Validation(format!("节点 {node_id} 不存在")))
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn nested<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn endpoint<'a>(edge: &'a Value, side: &str) -> &'a str {
    edge.get(side)
        .and_then(|node| node.get("nodeId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}
