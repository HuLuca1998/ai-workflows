use serde::Deserialize;

/// 工作流图的引擎侧镜像。
///
/// 图以 JSON 存在库里（契约的 `WorkflowGraph`），引擎要调度就得解析它。
/// 这是一份**只读镜像**：字段名必须与契约一致，
/// `crates/engine/tests/contract_sync_test.rs` 守住它不脱节。
///
/// 节点配置保持 `serde_json::Value`——每种节点的配置形状由契约的 Schema 定义，
/// 引擎在执行到具体节点时再按类型解释，不在这里重复一份 16 种配置结构。
#[derive(Debug, Clone, Deserialize)]
pub struct WorkflowGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// 老数据可能没有这个字段；缺了不该让引擎起不来
    #[serde(default)]
    pub groups: Vec<GraphGroup>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub title: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub join: Option<JoinConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    pub source: EdgeEnd,
    pub target: EdgeEnd,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EdgeEnd {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub port: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphGroup {
    pub id: String,
    pub title: String,
    #[serde(rename = "nodeIds")]
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JoinConfig {
    #[serde(default)]
    pub strategy: Option<String>,
    #[serde(default)]
    pub quorum: Option<usize>,
}

/// N→1 连线上的等待规则（技术选型 §13）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinStrategy {
    All,
    Any,
    Quorum,
    Sequential,
}

impl JoinStrategy {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "all" => Some(Self::All),
            "any" => Some(Self::Any),
            "quorum" => Some(Self::Quorum),
            "sequential" => Some(Self::Sequential),
            _ => None,
        }
    }
}

impl WorkflowGraph {
    pub fn node(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// 某个节点的全部上游节点 id。
    pub fn upstream(&self, id: &str) -> Vec<&str> {
        self.edges
            .iter()
            .filter(|e| e.target.node_id == id)
            .map(|e| e.source.node_id.as_str())
            .collect()
    }

    /// 某个节点的全部下游节点 id。
    pub fn downstream(&self, id: &str) -> Vec<&str> {
        self.edges
            .iter()
            .filter(|e| e.source.node_id == id)
            .map(|e| e.target.node_id.as_str())
            .collect()
    }
}

impl GraphNode {
    /// 汇聚策略。没写就是「等待全部」——这是最安全的默认：
    /// 少等一路可能拿到不完整的输入，多等一路只是慢一点。
    pub fn join_strategy(&self) -> JoinStrategy {
        self.join
            .as_ref()
            .and_then(|j| j.strategy.as_deref())
            .and_then(JoinStrategy::parse)
            .unwrap_or(JoinStrategy::All)
    }

    pub fn quorum(&self) -> Option<usize> {
        self.join.as_ref().and_then(|j| j.quorum)
    }
}
