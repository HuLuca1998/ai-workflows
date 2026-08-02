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

/// 一条**已经走过**的边：某个节点从某个端口出去了。
///
/// 调度按它判就绪，而不是按「上游节点完成了没有」——
/// 后者让端口路由完全失效：不管上游走哪个口，所有下游一律执行。
/// 实测症状是一条成功的运行把标着「结束 · 材料不足」的失败终点
/// 也跑了一遍（run_4b439b16806ef3f3 的事件 #78）。
pub type TakenPort = (String, String);

pub struct ExecutionPlan {
    /// 拓扑序。同层节点按图中出现顺序排，保证执行记录的列表稳定。
    order: Vec<String>,
    /// 每个节点的入边：(上游节点 id, 上游端口)。
    inbound: HashMap<String, Vec<TakenPort>>,
    /// 每个节点的汇聚要求：需要多少条**入边**被走过才能开始。
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

        let mut inbound: HashMap<String, Vec<TakenPort>> = HashMap::new();
        for node in &graph.nodes {
            inbound.insert(node.id.clone(), Vec::new());
        }
        for edge in &graph.edges {
            if let Some(list) = inbound.get_mut(&edge.target.node_id) {
                list.push((edge.source.node_id.clone(), edge.source.port.clone()));
            }
        }

        let order = topological(graph)?;

        let mut required = HashMap::new();
        for node in &graph.nodes {
            let incoming = inbound.get(&node.id).map(Vec::len).unwrap_or(0);
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
            inbound,
            required,
        })
    }

    pub fn order(&self) -> &[String] {
        &self.order
    }

    /// 给定已走过的边，返回现在可以开始的节点。
    ///
    /// `taken` 是 (上游节点 id, 该节点出去的端口)。判据是**入边被走过几条**，
    /// 不是「上游节点完成了几个」—— 后者会让 `failed` 分支上的节点
    /// 在成功路径上照样执行。
    ///
    /// 返回多个就是可以并行跑多个——调度器据此分发，
    /// 并发上限由调用方控制（全局 Agent 进程上限、节点级并发上限）。
    pub fn ready_nodes(&self, taken: &[TakenPort]) -> Vec<String> {
        let done: HashSet<&str> = taken.iter().map(|(node, _)| node.as_str()).collect();
        let walked: HashSet<(&str, &str)> = taken
            .iter()
            .map(|(node, port)| (node.as_str(), port.as_str()))
            .collect();

        self.order
            .iter()
            .filter(|id| !done.contains(id.as_str()))
            .filter(|id| {
                let ins = self.inbound.get(*id).map(Vec::as_slice).unwrap_or(&[]);
                let satisfied = ins
                    .iter()
                    .filter(|(node, port)| edge_walked(&walked, node, port))
                    .count();
                let need = self.required.get(*id).copied().unwrap_or(0);
                satisfied >= need
            })
            .cloned()
            .collect()
    }

    /// 收尾判据：**够得着的节点是不是都完成了**。
    ///
    /// 不能用「完成数 == 节点总数」：端口路由生效之后，没走到的
    /// 分支上那些节点本来就不会执行，那个等式在任何有分支的图上
    /// 都不成立 —— 每一条正常结束的运行都会被判成 failed。
    ///
    /// 「够得着」= 它的入边至少被走过一条（或者它压根没有入边，
    /// 那是入口）。够不着的不算欠账。
    #[must_use]
    pub fn reachable_all_done(&self, taken: &[TakenPort]) -> bool {
        let done: HashSet<&str> = taken.iter().map(|(node, _)| node.as_str()).collect();
        let walked: HashSet<(&str, &str)> = taken
            .iter()
            .map(|(node, port)| (node.as_str(), port.as_str()))
            .collect();

        self.order.iter().all(|id| {
            if done.contains(id.as_str()) {
                return true;
            }
            let ins = self.inbound.get(id).map(Vec::as_slice).unwrap_or(&[]);
            // 没有入边而又没完成 —— 那是入口没跑起来，确实是欠账
            if ins.is_empty() {
                return false;
            }
            // 一条入边都没被走过 = 这个节点在没走的那一支上，不算欠账
            !ins.iter()
                .any(|(node, port)| edge_walked(&walked, node, port))
        })
    }

    /// 图里全部节点。
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.order.len()
    }
}

/// 这条入边被走过了吗。
///
/// 端口是 [`crate::runner::PORT_UNKNOWN`] 时按**通配**处理：那是迁移 016
/// 之前的老事件，没记出口端口。按 `success` 兜底的话，真实端口不叫
/// success 的（approval→approved 等）一条都匹配不上，恢复旧运行时
/// 会「无节点可跑 ⇒ 判成功」而其实一个节点都没跑。
fn edge_walked(walked: &HashSet<(&str, &str)>, node: &str, port: &str) -> bool {
    walked.contains(&(node, port)) || walked.contains(&(node, crate::runner::PORT_UNKNOWN))
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
