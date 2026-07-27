use std::collections::{HashMap, HashSet};

use crate::graph::{JoinStrategy, WorkflowGraph};

/// 执行计划：图的静态部分先算好，运行时只回答「现在哪些节点能跑」。
///
/// 调度语义来自技术选型 §13：
/// 1→N 并行分发、N→1 按汇聚策略阻塞、N→N 全部就绪后再分发。

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("图中存在环：{nodes}")]
    Cyclic { nodes: String },
    #[error("连线 {edge} 指向不存在的节点")]
    DanglingEdge { edge: String },
}

pub struct ExecutionPlan {
    /// 拓扑序。同层节点按图中出现顺序排，保证执行记录的列表稳定。
    order: Vec<String>,
    upstream: HashMap<String, Vec<String>>,
    /// 每个节点的汇聚要求：需要多少条上游完成才能开始。
    required: HashMap<String, usize>,
}

impl ExecutionPlan {
    pub fn build(graph: &WorkflowGraph) -> Result<Self, PlanError> {
        let ids: HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        for edge in &graph.edges {
            if !ids.contains(edge.source.node_id.as_str())
                || !ids.contains(edge.target.node_id.as_str())
            {
                return Err(PlanError::DanglingEdge {
                    edge: edge.id.clone(),
                });
            }
        }

        let mut upstream: HashMap<String, Vec<String>> = HashMap::new();
        for node in &graph.nodes {
            upstream.insert(
                node.id.clone(),
                graph
                    .upstream(&node.id)
                    .into_iter()
                    .map(String::from)
                    .collect(),
            );
        }

        let order = topological(graph)?;

        let mut required = HashMap::new();
        for node in &graph.nodes {
            let incoming = upstream.get(&node.id).map(Vec::len).unwrap_or(0);
            let need = match node.join_strategy() {
                JoinStrategy::All => incoming,
                JoinStrategy::Any => 1.min(incoming),
                // quorum 没写票数时退回「等待全部」，绝不猜一个数字
                JoinStrategy::Quorum => node.quorum().unwrap_or(incoming).min(incoming),
                // 顺序汇聚同样要全部到齐，区别在于处理顺序（M2 后续）
                JoinStrategy::Sequential => incoming,
            };
            required.insert(node.id.clone(), need);
        }

        Ok(Self {
            order,
            upstream,
            required,
        })
    }

    pub fn order(&self) -> &[String] {
        &self.order
    }

    /// 给定已完成的节点，返回现在可以开始的节点。
    ///
    /// 返回多个就是可以并行跑多个——调度器据此分发，
    /// 并发上限由调用方控制（全局 Agent 进程上限、节点级并发上限）。
    pub fn ready_nodes(&self, completed: &[String]) -> Vec<String> {
        let done: HashSet<&str> = completed.iter().map(String::as_str).collect();

        self.order
            .iter()
            .filter(|id| !done.contains(id.as_str()))
            .filter(|id| {
                let ups = self.upstream.get(*id).map(Vec::as_slice).unwrap_or(&[]);
                let finished = ups.iter().filter(|u| done.contains(u.as_str())).count();
                let need = self.required.get(*id).copied().unwrap_or(0);
                finished >= need
            })
            .cloned()
            .collect()
    }
}

/// Kahn 算法。同层按图中顺序入队，保证执行记录里的节点顺序稳定。
fn topological(graph: &WorkflowGraph) -> Result<Vec<String>, PlanError> {
    let mut indegree: HashMap<&str, usize> =
        graph.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    for edge in &graph.edges {
        if let Some(count) = indegree.get_mut(edge.target.node_id.as_str()) {
            *count += 1;
        }
    }

    let mut queue: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|n| indegree.get(n.id.as_str()) == Some(&0))
        .map(|n| n.id.as_str())
        .collect();

    let mut order = Vec::with_capacity(graph.nodes.len());
    let mut cursor = 0;
    while cursor < queue.len() {
        let current = queue[cursor];
        cursor += 1;
        order.push(current.to_string());

        for target in graph.downstream(current) {
            if let Some(count) = indegree.get_mut(target) {
                *count -= 1;
                if *count == 0 {
                    queue.push(target);
                }
            }
        }
    }

    if order.len() != graph.nodes.len() {
        let stuck: Vec<&str> = graph
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .filter(|id| !order.iter().any(|o| o == id))
            .collect();
        return Err(PlanError::Cyclic {
            nodes: stuck.join(", "),
        });
    }

    Ok(order)
}
