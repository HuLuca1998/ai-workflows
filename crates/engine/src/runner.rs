use aiwf_store::{NewRunEvent, Store};

use crate::executor::NodeExecutor;
use crate::graph::WorkflowGraph;
use crate::interp::Scope;
use crate::plan::ExecutionPlan;

/// Run 的生命周期与推进。
///
/// 「RunEvent 是唯一事实来源」：每一次状态变化都先写事件，再改 Run 状态。
/// 顺序反过来的话，写事件失败就会留下一个「状态变了但没人知道为什么」的运行。
///
/// M2 第一批只做调度骨架：节点的真实执行由调用方通过闭包提供，
/// 脚本 / worktree / AI 执行器在后续批次接上。这样调度逻辑本身能单独验证。

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("存储错误：{0}")]
    Store(#[from] aiwf_store::StoreError),
    #[error("找不到运行 {0}")]
    RunNotFound(String),
    #[error("运行 {run_id} 引用的图不存在")]
    GraphMissing { run_id: String },
    #[error("图无法解析：{0}")]
    GraphInvalid(String),
    #[error("无法建立执行计划：{0}")]
    Plan(#[from] crate::plan::PlanError),
    #[error("运行 {run_id} 当前是 {status}，不能{action}")]
    WrongState {
        run_id: String,
        status: String,
        action: &'static str,
    },
    #[error("运行 {run_id} 当前等的是节点 {expected:?}，不是 {got}")]
    NotPendingApproval {
        run_id: String,
        expected: Option<String>,
        got: String,
    },
    #[error("节点执行失败：{0}")]
    Executor(#[from] crate::executor::ExecutorError),
}

pub type Result<T> = std::result::Result<T, RunError>;

pub struct RunRequest {
    pub workflow_id: String,
    pub version_id: Option<String>,
    pub draft_rev: Option<i64>,
    pub inputs_json: String,
    pub workdir: String,
}

/// 节点执行的结果。真实执行器（脚本 / AI / worktree）产出这个。
#[derive(Debug, Clone)]
pub enum NodeOutcome {
    Succeeded {
        port: String,
    },
    Failed {
        message: String,
    },
    /// 需要人工决定：调度器据此挂起并落检查点。
    NeedsApproval,
}

/// 一次推进的结果。
#[derive(Debug)]
pub enum StepResult {
    /// 推进了一个节点，可以继续调用 step。
    Advanced { node_id: String },
    /// 卡在审批上，等 decide_approval。
    WaitingApproval { node_id: String },
    /// 运行结束（成功、失败或取消）。
    Finished { status: String },
}

#[derive(Default)]
pub struct Runner;

impl Runner {
    pub fn new() -> Self {
        Self
    }

    /// 启动运行：preflight → 入队 → 开始。
    ///
    /// preflight 不通过就直接失败，绝不带着一张坏图进队列——
    /// 那样错误会在执行到一半时才暴露，且已经产生了副作用。
    pub fn start(&self, store: &Store, request: RunRequest) -> Result<String> {
        let run_id = store.create_run_in(
            &request.workflow_id,
            request.version_id.as_deref(),
            request.draft_rev,
            &request.inputs_json,
            Some(&request.workdir),
        )?;

        self.emit(store, &run_id, "run.created", None, "engine", "运行已创建")?;

        match self.load_plan(store, &run_id) {
            Ok(_) => {
                self.emit(
                    store,
                    &run_id,
                    "run.preflight_passed",
                    None,
                    "engine",
                    "依赖检查通过",
                )?;
                self.emit(store, &run_id, "run.queued", None, "engine", "已进入队列")?;
                self.emit(store, &run_id, "run.started", None, "engine", "开始执行")?;
                store.set_run_status(&run_id, "running", None)?;
            }
            Err(error) => {
                self.emit(
                    store,
                    &run_id,
                    "run.preflight_failed",
                    None,
                    "engine",
                    &format!("依赖检查未通过：{error}"),
                )?;
                store.set_run_status(&run_id, "failed", None)?;
            }
        }

        Ok(run_id)
    }

    /// 推进一步：挑一个就绪节点执行。
    ///
    /// 一次只推一个节点，调用方决定推进节奏——并行分发由调用方按
    /// ready 列表自行控制并发上限（全局 Agent 进程上限、节点级上限）。
    pub fn step<F>(&self, store: &Store, run_id: &str, execute: F) -> Result<StepResult>
    where
        F: Fn(&crate::graph::GraphNode) -> NodeOutcome,
    {
        let mut scope = Scope::new(run_id);
        self.advance(store, run_id, &mut scope, |node, _| execute(node))
    }

    /// 用真实执行器推进一个节点。
    fn step_with(
        &self,
        store: &Store,
        run_id: &str,
        executor: &NodeExecutor,
        scope: &mut Scope,
    ) -> Result<StepResult> {
        self.advance(store, run_id, scope, |node, scope| {
            executor
                .execute(node, scope)
                .unwrap_or_else(|error| NodeOutcome::Failed {
                    message: error.to_string(),
                })
        })
    }

    fn advance<F>(
        &self,
        store: &Store,
        run_id: &str,
        scope: &mut Scope,
        execute: F,
    ) -> Result<StepResult>
    where
        F: Fn(&crate::graph::GraphNode, &mut Scope) -> NodeOutcome,
    {
        let status = self.status(store, run_id)?;
        if matches!(status.as_str(), "succeeded" | "failed" | "cancelled") {
            return Ok(StepResult::Finished { status });
        }
        if status == "waiting_approval" {
            let node = self.pending_approval(store, run_id)?.unwrap_or_default();
            return Ok(StepResult::WaitingApproval { node_id: node });
        }

        let (graph, plan) = self.load_plan(store, run_id)?;
        let completed = self.completed_nodes(store, run_id)?;
        let ready = plan.ready_nodes(&completed);

        let Some(node_id) = ready.first().cloned() else {
            // 没有可跑的节点了：要么全跑完，要么被上游失败挡住
            let all_done = completed.len() == graph.nodes.len();
            let status = if all_done { "succeeded" } else { "failed" };
            self.emit(
                store,
                run_id,
                if all_done {
                    "run.succeeded"
                } else {
                    "run.failed"
                },
                None,
                "engine",
                if all_done {
                    "全部节点已完成"
                } else {
                    "没有可继续的节点"
                },
            )?;
            let _ = store.advance_run_status(run_id, status, None)?;
            // 状态可能已被取消抢先写成终态，回读一次而不是想当然
            return Ok(StepResult::Finished {
                status: self.status(store, run_id)?,
            });
        };

        let node = graph
            .node(&node_id)
            .ok_or_else(|| RunError::GraphInvalid(format!("计划里的节点 {node_id} 不在图中")))?;

        // advance_run_status 在终态时不更新任何行。不检查的话，
        // 一个刚被取消的运行仍会继续起新节点 —— 取消之后还产生副作用。
        if !store.advance_run_status(run_id, "running", Some(&node_id))? {
            return Ok(StepResult::Finished {
                status: self.status(store, run_id)?,
            });
        }

        self.emit_node(
            store,
            run_id,
            "node.started",
            &node_id,
            &node.title,
            "engine",
            &format!("{} 开始", node.title),
        )?;

        // 审批是**引擎强制**的暂停点，不是执行器的选择：
        // 交给执行器决定的话，一个实现得不对的执行器就能把人工审批绕过去。
        let outcome = if node.node_type == "approval" {
            NodeOutcome::NeedsApproval
        } else {
            execute(node, scope)
        };

        match outcome {
            NodeOutcome::Succeeded { port } => {
                self.emit_node(
                    store,
                    run_id,
                    "node.succeeded",
                    &node_id,
                    &node.title,
                    "engine",
                    &format!("{} 完成 · 走 {port} 分支", node.title),
                )?;
                self.checkpoint(store, run_id, scope, None)?;
                Ok(StepResult::Advanced { node_id })
            }

            NodeOutcome::Failed { message } => {
                self.emit_node(
                    store,
                    run_id,
                    "node.failed",
                    &node_id,
                    &node.title,
                    "engine",
                    &message,
                )?;
                self.emit(
                    store,
                    run_id,
                    "run.failed",
                    None,
                    "engine",
                    &format!("节点「{}」失败", node.title),
                )?;
                let _ = store.advance_run_status(run_id, "failed", Some(&node_id))?;
                Ok(StepResult::Finished {
                    // 可能已被取消抢先写成终态，回读而不是想当然
                    status: self.status(store, run_id)?,
                })
            }

            NodeOutcome::NeedsApproval => {
                self.emit_node(
                    store,
                    run_id,
                    "node.waiting",
                    &node_id,
                    &node.title,
                    "engine",
                    &format!("{} 等待人工决定", node.title),
                )?;
                self.emit_node(
                    store,
                    run_id,
                    "approval.requested",
                    &node_id,
                    &node.title,
                    "engine",
                    &node.title,
                )?;

                // 检查点必须在挂起时落下：杀掉应用后靠它回到同一位置
                self.checkpoint(store, run_id, scope, Some(&node_id))?;
                let _ = store.advance_run_status(run_id, "waiting_approval", Some(&node_id))?;

                Ok(StepResult::WaitingApproval { node_id })
            }
        }
    }

    /// 用真实执行器一路跑到结束或挂起。
    ///
    /// 每个节点完成后都落一次检查点（带 Scope 快照）——
    /// 检查点频繁写对本地 SQLite 完全不是负担，而它换来的是
    /// 「杀掉 App 后重启能回到同一位置」这条硬要求。
    pub fn run_all(&self, store: &Store, run_id: &str) -> Result<String> {
        self.run_until_pause(store, run_id, &std::sync::atomic::AtomicBool::new(false))
    }

    /// 一路跑到结束或挂起，每个节点边界检查取消标志。
    ///
    /// 取消在**节点边界**生效而不是中途打断：一个正在 push 的脚本被拦腰砍断
    /// 会留下说不清楚的外部状态。当前节点跑完，下一个不再开始。
    pub fn run_until_pause(
        &self,
        store: &Store,
        run_id: &str,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<String> {
        let workdir = self.workdir(store, run_id)?;
        let executor = NodeExecutor::new(workdir).with_run_id(run_id);
        let mut scope = self.restore_scope(store, run_id)?;

        loop {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                return self.status(store, run_id);
            }
            match self.step_with(store, run_id, &executor, &mut scope)? {
                StepResult::Advanced { .. } => continue,
                StepResult::WaitingApproval { .. } => return self.status(store, run_id),
                StepResult::Finished { status } => return Ok(status),
            }
        }
    }

    /// 提交审批决定。批准后节点算完成，运行回到 running。
    pub fn decide_approval(
        &self,
        store: &Store,
        run_id: &str,
        node_id: &str,
        decision: &str,
    ) -> Result<()> {
        // 先校验再写事件。反过来的话，一个指向下游节点的审批会直接写出
        // node.succeeded —— 而 completed_nodes 信任所有 node.succeeded，
        // 那个节点的真实脚本就被整个跳过了。
        let status = self.status(store, run_id)?;
        if status != "waiting_approval" {
            return Err(RunError::WrongState {
                run_id: run_id.to_string(),
                status,
                action: "提交审批决定",
            });
        }

        let pending = self.pending_approval(store, run_id)?;
        if pending.as_deref() != Some(node_id) {
            return Err(RunError::NotPendingApproval {
                run_id: run_id.to_string(),
                expected: pending,
                got: node_id.to_string(),
            });
        }

        // 标题从图里查一次：审批事件也要能自解释，
        // 而这条路径上没有 node 对象（决定是用户从界面发来的）
        let label = self.node_title(store, run_id, node_id)?;

        self.emit_node(
            store,
            run_id,
            "approval.decided",
            node_id,
            &label,
            "user",
            &format!("决定：{decision}"),
        )?;

        if decision == "approved" {
            self.emit_node(
                store,
                run_id,
                "node.succeeded",
                node_id,
                &label,
                "engine",
                "审批通过",
            )?;
            let _ = store.advance_run_status(run_id, "running", Some(node_id))?;
        } else {
            self.emit_node(
                store,
                run_id,
                "node.failed",
                node_id,
                &label,
                "engine",
                &format!("审批未通过：{decision}"),
            )?;
            self.emit(store, run_id, "run.failed", None, "engine", "审批未通过")?;
            let _ = store.advance_run_status(run_id, "failed", Some(node_id))?;
        }
        Ok(())
    }

    /// 取消运行。已经结束的运行不能再取消 —— 终态没有出边。
    ///
    /// 迟到的取消（网络重试、用户在旧页面上点的）如果能改状态，
    /// 运行记录就自相矛盾了：一串 succeeded 事件后面跟着一条 cancelled。
    pub fn cancel(&self, store: &Store, run_id: &str) -> Result<()> {
        let status = self.status(store, run_id)?;
        if is_terminal(&status) {
            return Err(RunError::WrongState {
                run_id: run_id.to_string(),
                status,
                action: "取消",
            });
        }

        self.emit(
            store,
            run_id,
            "run.cancelled",
            None,
            "user",
            "用户取消了运行",
        )?;
        store.set_run_status(run_id, "cancelled", None)?;
        Ok(())
    }

    pub fn status(&self, store: &Store, run_id: &str) -> Result<String> {
        store
            .run_status(run_id)?
            .ok_or_else(|| RunError::RunNotFound(run_id.to_string()))
    }

    /// 卡在哪个审批节点上。重启后靠它把用户带回原处。
    pub fn pending_approval(&self, store: &Store, run_id: &str) -> Result<Option<String>> {
        let Some(checkpoint) = store.latest_checkpoint(run_id)? else {
            return Ok(None);
        };
        let Some(json) = checkpoint.pending_approval_json else {
            return Ok(None);
        };
        let parsed: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| RunError::GraphInvalid(e.to_string()))?;
        Ok(parsed
            .get("nodeId")
            .and_then(|v| v.as_str())
            .map(str::to_string))
    }

    // ── 内部 ────────────────────────────────────────────────────────────────

    fn load_plan(&self, store: &Store, run_id: &str) -> Result<(WorkflowGraph, ExecutionPlan)> {
        let graph_json = store
            .run_graph(run_id)?
            .ok_or_else(|| RunError::GraphMissing {
                run_id: run_id.to_string(),
            })?;
        let graph: WorkflowGraph =
            serde_json::from_str(&graph_json).map_err(|e| RunError::GraphInvalid(e.to_string()))?;

        // 没有入口节点的图不该跑起来：它无从开始
        if !graph.nodes.iter().any(|n| n.node_type == "entry") {
            return Err(RunError::GraphInvalid("缺少入口节点".to_string()));
        }

        let plan = ExecutionPlan::build(&graph)?;
        Ok((graph, plan))
    }

    /// 已完成的节点。直接从事件流算，不另存一份状态——
    /// 多一份状态就多一处可能不一致的地方。
    fn completed_nodes(&self, store: &Store, run_id: &str) -> Result<Vec<String>> {
        let mut completed = Vec::new();
        let mut from = 0;
        loop {
            let page = store.events(run_id, from, 500)?;
            if page.is_empty() {
                break;
            }
            for event in &page {
                if event.kind == "node.succeeded" {
                    if let Some(node) = &event.node_id {
                        if !completed.contains(node) {
                            completed.push(node.clone());
                        }
                    }
                }
                from = event.seq;
            }
        }
        Ok(completed)
    }

    /// 落检查点：seq + Scope 快照 + 挂起的审批节点。
    fn checkpoint(
        &self,
        store: &Store,
        run_id: &str,
        scope: &Scope,
        pending: Option<&str>,
    ) -> Result<()> {
        let seq = self.last_seq(store, run_id)?;
        let env_json = serde_json::to_string(&scope.snapshot())
            .map_err(|e| RunError::GraphInvalid(e.to_string()))?;
        let pending_json = pending.map(|node| format!(r#"{{"nodeId":"{node}"}}"#));
        store.save_checkpoint(run_id, seq, &env_json, pending_json.as_deref())?;
        Ok(())
    }

    /// 从最新检查点恢复 Scope。
    ///
    /// 没有这一步，重启后下游节点引用 `${a.success.stdout}` 会解析不出来——
    /// 「回到同一审批点」就只是回到了那个位置，却没法继续往下跑。
    fn restore_scope(&self, store: &Store, run_id: &str) -> Result<Scope> {
        let mut scope = Scope::new(run_id);

        if let Some(inputs) = store.run_inputs(run_id)? {
            if let Ok(value) = serde_json::from_str(&inputs) {
                scope.set_inputs(value);
            }
        }

        if let Some(checkpoint) = store.latest_checkpoint(run_id)? {
            if let Ok(snapshot) = serde_json::from_str(&checkpoint.env_json) {
                scope.restore(snapshot);
            }
        }
        Ok(scope)
    }

    /// 运行的工作目录，不存在就建。
    ///
    /// 这是引擎自己的运行目录（每个 Run 一个），第一次跑必然不存在——
    /// 让它报错等于要求用户先手动 mkdir。用户显式指定的仓库路径是另一回事，
    /// 那种路径不存在时 worktree 节点会报错，不在这里兜底。
    fn workdir(&self, store: &Store, run_id: &str) -> Result<std::path::PathBuf> {
        let dir = store
            .run_workdir(run_id)?
            .filter(|dir| !dir.is_empty())
            .map_or_else(std::env::temp_dir, std::path::PathBuf::from);
        std::fs::create_dir_all(&dir).map_err(|e| {
            RunError::GraphInvalid(format!("无法创建运行目录 {}：{e}", dir.display()))
        })?;
        Ok(dir)
    }

    fn last_seq(&self, store: &Store, run_id: &str) -> Result<i64> {
        let mut last = 0;
        let mut from = 0;
        loop {
            let page = store.events(run_id, from, 500)?;
            if page.is_empty() {
                break;
            }
            if let Some(event) = page.last() {
                last = event.seq;
                from = event.seq;
            }
        }
        Ok(last)
    }

    fn emit(
        &self,
        store: &Store,
        run_id: &str,
        kind: &str,
        node_id: Option<&str>,
        actor: &str,
        summary: &str,
    ) -> Result<()> {
        self.emit_labeled(store, run_id, kind, node_id, None, actor, summary)
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_labeled(
        &self,
        store: &Store,
        run_id: &str,
        kind: &str,
        node_id: Option<&str>,
        node_label: Option<&str>,
        actor: &str,
        summary: &str,
    ) -> Result<()> {
        store.append_event(&NewRunEvent {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            node_id: node_id.map(str::to_string),
            node_label: node_label.map(str::to_string),
            attempt: node_id.map(|_| 1),
            actor: actor.to_string(),
            status: None,
            summary: summary.to_string(),
            payload_ref: None,
            artifact_refs: vec![],
            parent_event_id: None,
            sensitivity: "internal".to_string(),
            schema_ver: 1,
        })?;
        Ok(())
    }

    /// 从运行引用的图里查节点标题。查不到就退回 id ——
    /// 显示一个 id 总好过让审批决定写不进事件。
    fn node_title(&self, store: &Store, run_id: &str, node_id: &str) -> Result<String> {
        let Some(graph_json) = store.run_graph(run_id)? else {
            return Ok(node_id.to_string());
        };
        let graph: WorkflowGraph =
            serde_json::from_str(&graph_json).map_err(|e| RunError::GraphInvalid(e.to_string()))?;
        Ok(graph
            .nodes
            .iter()
            .find(|n| n.id == node_id)
            .map_or_else(|| node_id.to_string(), |n| n.title.clone()))
    }

    /// 节点事件。**标题一并记下** —— 界面显示的是它，不是内部 id。
    #[allow(clippy::too_many_arguments)]
    fn emit_node(
        &self,
        store: &Store,
        run_id: &str,
        kind: &str,
        node_id: &str,
        node_label: &str,
        actor: &str,
        summary: &str,
    ) -> Result<()> {
        self.emit_labeled(
            store,
            run_id,
            kind,
            Some(node_id),
            Some(node_label),
            actor,
            summary,
        )
    }
}

/// 终态：没有出边。恢复要走显式的 `resume`，而它只接受 failed。
pub fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled")
}
