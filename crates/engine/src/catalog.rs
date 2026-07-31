//! 节点目录：把契约生成物读进来，供图校验与 Patch 使用。
//!
//! 数据来自两份生成物，都由 `pnpm contracts:check` 守着不漂移：
//! - `node-catalog.json`：端口、能力、externalWrite、seed、动态端口规则
//! - `node-configs.schema.json`：每种节点的配置 Schema
//!
//! 编译期 `include_str!` 进来而不是运行时读文件：装好的 App 里没有
//! `packages/` 目录，运行时读会在用户机器上才炸，而且症状是
//! 「所有节点类型都未登记」——离真正的原因隔了十万八千里。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

const CATALOG_JSON: &str = include_str!("../../../packages/contracts/generated/node-catalog.json");
const CONFIGS_JSON: &str =
    include_str!("../../../packages/contracts/generated/node-configs.schema.json");

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, serde::Serialize)]
pub struct Port {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Ports {
    pub inputs: Vec<Port>,
    pub outputs: Vec<Port>,
}

/// 「输出端口由配置里的哪个字段决定」的声明。
///
/// 契约里原先是个闭包，过不了语言边界；改成声明之后两边读同一份规则。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicOutputRule {
    pub cases_field: String,
    pub port_field: String,
    pub default_port_field: String,
    pub fallback_port: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeEntry {
    pub title: String,
    pub group: String,
    pub summary: String,
    pub icon: String,
    pub ports: Ports,
    pub dynamic_outputs: Option<DynamicOutputRule>,
    pub default_capabilities: Value,
    pub external_write: bool,
    /// 审批判定的下限。引擎按脚本内容往上调，不下调 —— 见 `risk.rs`
    pub base_risk: String,
    pub singleton: bool,
    pub seed: Option<Value>,
}

struct Catalog {
    nodes: BTreeMap<String, NodeEntry>,
    configs: BTreeMap<String, Value>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| Catalog {
        // 解析失败只可能是生成物坏了，而那会让整个应用没有一种节点可用。
        // 用空表撑住而不是 panic：界面至少还能开，校验会逐条报「类型未登记」
        nodes: serde_json::from_str(CATALOG_JSON).unwrap_or_default(),
        configs: serde_json::from_str(CONFIGS_JSON).unwrap_or_default(),
    })
}

/// 全部节点类型，按契约里的顺序。
#[must_use]
pub fn node_types() -> Vec<&'static str> {
    catalog().nodes.keys().map(String::as_str).collect()
}

#[must_use]
pub fn definition(node_type: &str) -> Option<&'static NodeEntry> {
    catalog().nodes.get(node_type)
}

#[must_use]
pub fn config_schema(node_type: &str) -> Option<&'static Value> {
    catalog().configs.get(node_type)
}

#[must_use]
pub fn is_known(node_type: &str) -> bool {
    catalog().nodes.contains_key(node_type)
}

/// 输入端口。入口节点没有输入 —— 那由校验单独报，这里如实返回空。
#[must_use]
pub fn inputs(node_type: &str) -> &'static [Port] {
    definition(node_type).map_or(&[], |entry| entry.ports.inputs.as_slice())
}

/// 输出端口：静态的直接返回，动态的（条件分支）按当前配置推导。
///
/// 每一步都对着**声明**做，不判断节点类型 —— 与
/// `packages/contracts/src/nodes/definitions.ts` 的 `resolveNodeOutputs` 同构。
/// 多一句 `if node_type == "branch"` 就会让两边少一条分支。
#[must_use]
pub fn outputs(node_type: &str, config: &Value) -> Vec<Port> {
    let Some(entry) = definition(node_type) else {
        return Vec::new();
    };
    let Some(rule) = &entry.dynamic_outputs else {
        return entry.ports.outputs.clone();
    };

    // 配置常常是半成品（模型刚提议、用户填了一半），任何一步都不能炸
    let mut ports: Vec<Port> = config
        .get(&rule.cases_field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get(&rule.port_field).and_then(Value::as_str))
                .filter(|port| !port.is_empty())
                .map(|port| Port {
                    id: port.to_string(),
                    label: port.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    let fallback = config
        .get(&rule.default_port_field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(&rule.fallback_port);

    ports.push(Port {
        id: fallback.to_string(),
        label: fallback.to_string(),
    });
    ports
}

/// 按节点类型的 Schema 补默认值再校验。
///
/// 返回 Ok 时给出的是**补全后**的配置：`applyPatch` 要把默认值固化进草稿，
/// 运行时行为不该取决于「谁来读这份配置」。
///
/// # Errors
/// 配置不合法时返回每条问题的中文描述，顺序与 TypeScript 那份一致。
pub fn parse_config(node_type: &str, config: &Value) -> Result<Value, Vec<String>> {
    let Some(schema) = config_schema(node_type) else {
        return Err(vec![format!("节点类型 {node_type} 未登记")]);
    };

    // 缺席的配置当空对象：Zod 那边 `safeParse(operation.config ?? {})`
    let raw = if config.is_null() {
        Value::Object(serde_json::Map::new())
    } else {
        config.clone()
    };

    let filled = crate::schema::apply_defaults(schema, &raw);
    let issues = crate::schema::validate(schema, &filled);
    if issues.is_empty() {
        Ok(filled)
    } else {
        Err(issues.into_iter().map(|issue| issue.message).collect())
    }
}
