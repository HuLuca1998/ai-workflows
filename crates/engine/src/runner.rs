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
    // `{expected:?}` 会把 Option 的 Debug 形态原样显示给用户 ——
    // 界面上出现的是字面的 `Some("n_review")`，而 None 那支
    // 更是一句病句：「当前等的是节点 None」
    #[error("运行 {run_id} 当前等的{}，而你提交的是 {got}", pending_approval(.expected))]
    NotPendingApproval {
        run_id: String,
        expected: Option<String>,
        got: String,
    },
    #[error("节点执行失败：{0}")]
    Executor(#[from] crate::executor::ExecutorError),
}

fn pending_approval(expected: &Option<String>) -> String {
    match expected {
        Some(node) => format!("是节点 {node} 的审批"),
        None => "根本不是审批".to_string(),
    }
}

/// 一张图引用到的 Agent 角色，从库里查好。
///
/// **执行器与 Dry Run 共用**：Dry Run 不带角色的话，它解出的 runtime
/// 与执行时不是同一个（角色的 runtime 压过节点上那个 M2 遗留字段），
/// 于是查的 adapter 也不是同一个 —— 说通过，一跑就挂。
pub fn agent_profiles_for_graph(
    store: &Store,
    graph: &crate::graph::WorkflowGraph,
) -> Result<Vec<crate::executor::AgentProfile>> {
    let mut ids: Vec<String> = Vec::new();
    for node in &graph.nodes {
        let Some(id) = node
            .config
            .get("agentProfileId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_string());
        }
    }

    let mut profiles = Vec::new();
    for id in ids {
        // 查不到就不放进去 —— 执行器会在跑到那个节点时报
        // 「找不到 Agent 角色 X」，那句话比这里静默跳过有用
        if let Some(row) = store.get_agent(&id)? {
            profiles.push(crate::executor::AgentProfile {
                id: row.id,
                name: row.name,
                role: row.role,
                goal: row.goal,
                persona: row.persona,
                runtime: row.runtime,
                model_ref: row.model_ref,
                fallback_model_ref: row.fallback_model_ref.unwrap_or_default(),
                output_contract: row.output_contract,
                capabilities_json: row.capabilities_json,
                timeout_ms: row.timeout_ms,
            });
        }
    }
    Ok(profiles)
}

impl RunError {
    /// 接下来该干什么。
    ///
    /// 「发生了什么」只答了一半 —— 用户拿到「运行 r_x 当前是 running，
    /// 不能提交审批决定」之后，最想知道的是「我刚才那一下到底算没算数」。
    /// 照 `patch.rs` 的 `PatchError::hint()` 那个写法。
    #[must_use]
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            // 连点两次审批必撞这个：第一次其实已经成功了
            Self::WrongState { .. } => {
                Some("这次操作没生效，多半是上一次已经成功了。去执行记录里看它现在停在哪一步")
            }
            Self::NotPendingApproval { .. } => {
                Some("刷新一下执行记录，按它当前真正等的那一步再决定")
            }
            Self::RunNotFound(_) => Some("这条运行可能已被清理。回执行记录列表看看还在不在"),
            Self::GraphMissing { .. } | Self::GraphInvalid(_) => {
                Some("这条运行引用的图已经读不出来了。回编辑器确认草稿还在，再重新发起一次")
            }
            Self::Plan(_) => Some("回编辑器看画布上的报错：多半是有环，或者某个节点没连上"),
            // 存储与执行器的错误由它们自己那层给提示
            Self::Store(_) | Self::Executor(_) => None,
        }
    }
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
pub struct Runner {
    /// 谁把系统通知发出去。桌面壳注入；无头环境是 None，
    /// 那时 `notify` 节点明确报「这个环境发不了」而不是假装成功。
    notifier: Option<std::sync::Arc<dyn crate::notify::Notifier>>,
    /// 用哪个 adapter 命令起 ACP。只有测试会设。
    acp_override: Option<(String, Vec<String>)>,
    /// AI 节点的实时帧往哪推。None = 不推。
    stream: Option<std::sync::Arc<dyn crate::acp::ChunkSink>>,
}

impl Runner {
    pub fn new() -> Self {
        Self {
            notifier: None,
            acp_override: None,
            stream: None,
        }
    }

    /// 接上系统通知的发送器。
    #[must_use]
    pub fn with_notifier(mut self, notifier: std::sync::Arc<dyn crate::notify::Notifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    /// AI 节点的实时帧往哪推。
    ///
    /// **必须跟进后台线程**：真正跑节点的是 `Supervisor::spawn` 起的那条，
    /// 只给 `start` 那条路径上的 Runner 接上的话，一个 AI 节点都不会经过它 ——
    /// notifier 踩过同一个坑，那条注释就写在旁边。
    #[must_use]
    pub fn with_stream(mut self, sink: std::sync::Arc<dyn crate::acp::ChunkSink>) -> Self {
        self.stream = Some(sink);
        self
    }

    /// 换掉 adapter 命令。**给测试用**，与 `NodeExecutor::with_acp_command` 同一个口子。
    ///
    /// 没有它的时候，任何一条「图里有 AI 节点」的 Runner 级测试都会
    /// **真的拉起 adapter**，连上开发者自己的登录态与配额 ——
    /// 跑一次全量测试就在 `ps` 里留下一串 `codex app-server`。
    ///
    /// 以前靠「把 runtime 写成一个装不上的值」绕开，而 `provider.api`
    /// 从枚举里删掉之后，合法的 runtime 全都是真能拉起来的 ——
    /// 那条绕法连同它一起没了。
    #[must_use]
    pub fn with_acp_command(mut self, command: &str, args: &[String]) -> Self {
        self.acp_override = Some((command.to_string(), args.to_vec()));
        self
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
        // 这条路径是测试与外部调度用的，调用方自带执行逻辑，
        // 「用了哪个模型」它自己知道 —— 这里不替它编一条
        self.advance(
            store,
            run_id,
            &mut scope,
            |node, _| execute(node),
            |_, _| Vec::new(),
        )
    }

    /// 用真实执行器推进一个节点。
    fn step_with(
        &self,
        store: &Store,
        run_id: &str,
        executor: &NodeExecutor,
        scope: &mut Scope,
    ) -> Result<StepResult> {
        self.advance(
            store,
            run_id,
            scope,
            |node, scope| {
                // 对话 / 推理 / 工具调用**边跑边写**。
                //
                // 攒到节点跑完再一起写也行，但 AI 节点要跑好几分钟，
                // 那期间界面上除了一条 node.started 什么都没有 ——
                // 而「对话」这一屏的价值恰恰在于边跑边看。
                let label = node.title.clone();
                let emit = |event: crate::executor::NodeEvent| {
                    // 走 emit_full，不自己拼一份 NewRunEvent：
                    // 自己拼的那版漏了 attempt，于是 node.output_emitted
                    // 缺它，界面把整页事件流判为不合契约（issue #1）
                    let written = self.emit_full(
                        store,
                        run_id,
                        event.kind,
                        Some(&event.node_id),
                        Some(&label),
                        "agent",
                        &event.summary,
                        event.payload_ref,
                    );
                    // 写不进去只影响记录，不该让节点本身失败 ——
                    // 但要留痕：静默丢掉的话，对话流里会**少一条**而没人知道
                    if let Err(error) = written {
                        eprintln!("[runner] 节点事件没写进去（{}）：{error}", event.kind);
                    }
                };

                executor
                    .execute_with_sink(node, scope, &emit)
                    .unwrap_or_else(|error| NodeOutcome::Failed {
                        message: error.to_string(),
                    })
            },
            // 「这一步用了哪个角色、哪个模型」问执行器 —— 它是纯函数，
            // 执行之前就能答
            |node, scope| {
                executor
                    .resolution_for(node, scope)
                    .into_iter()
                    .map(|item| {
                        // 推理档拼在模型后面：「mock-model-b · 推理 medium」。
                        // 没指定就不写 —— 写「推理 」半句话比不写糟
                        let model = if item.effort.is_empty() {
                            item.model_ref.clone()
                        } else {
                            format!("{} · 推理 {}", item.model_ref, item.effort)
                        };
                        let who = if item.agent_profile_id.is_empty() {
                            format!("runtime {} · 没挂 Agent 角色 · 模型 {model}", item.runtime)
                        } else {
                            format!(
                                "Agent 角色「{}」（{}）· 模型 {model} · runtime {}",
                                item.agent_name, item.agent_profile_id, item.runtime
                            )
                        };
                        // cwd 也写进去：图纸承诺「Fix Agent 的 cwd 固定为 worktree，
                        // 不会污染你当前分支」，而用户唯一能核对这句话的地方
                        // 就是运行记录
                        if item.workdir.is_empty() {
                            who
                        } else {
                            format!("{who} · cwd {}", item.workdir)
                        }
                    })
                    .collect()
            },
        )
    }

    fn advance<F, R>(
        &self,
        store: &Store,
        run_id: &str,
        scope: &mut Scope,
        execute: F,
        resolutions: R,
    ) -> Result<StepResult>
    where
        F: Fn(&crate::graph::GraphNode, &mut Scope) -> NodeOutcome,
        R: Fn(&crate::graph::GraphNode, &Scope) -> Vec<String>,
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

        // 「这一步用了哪个角色、哪个模型、跑在哪个 runtime 上」——
        // 写在**执行之前**。AI 节点连 adapter 可能挂上好几分钟，
        // 而排查「它卡在哪」的第一个问题就是「它到底想连哪个」；
        // 等节点跑完再写，那条信息永远来不及。
        for resolutions in resolutions(node, scope) {
            self.emit_node(
                store,
                run_id,
                "system.model_resolved",
                &node_id,
                &node.title,
                "engine",
                &resolutions,
            )?;
        }

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

    /// 用户已经批准过的节点。
    ///
    /// 从事件流里算而不是另存一张表：审批的事实本来就写在
    /// `approval.decided` 事件里，再存一份就有了两个可能不一致的真相。
    fn approved_nodes(&self, store: &Store, run_id: &str) -> Result<Vec<String>> {
        let mut approved = Vec::new();
        let mut from_seq = 0_i64;
        loop {
            let page = store.events(run_id, from_seq, 500)?;
            if page.is_empty() {
                break;
            }
            from_seq = page.last().map_or(from_seq, |event| event.seq);
            for event in page {
                if event.kind == "approval.decided"
                    && let Some(node_id) = event.node_id
                {
                    approved.push(node_id);
                }
            }
        }
        Ok(approved)
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

        // 记忆在**运行开始时**取一份快照，而不是每个节点各取一次：
        // 一次运行中途被改掉的记忆会让前后两个 AI 节点拿到不同的上下文，
        // 而运行记录里只会有一条注入事件 —— 那时它就说不清了。
        //
        // 只取启用且未过期的（memories_for_injection 保证这一点）
        let memories: Vec<(String, String)> = store
            .memories_for_injection("workspace", None)
            .unwrap_or_default()
            .into_iter()
            .take(20)
            .map(|memory| (memory.key, memory.value))
            .collect();

        // 权限档来自工作区设置。没设过就按最严的一档办 ——
        // 默认放宽等于替用户做了一个他不知道自己做过的决定。
        //
        // 已批准的节点从事件流里算：用户在审批那一步点过通过之后，
        // 恢复执行不该又停在同一个节点上。
        // 读出来先过一次迁移：库里可能躺着上一版的档位名
        // （`workspace_safe` 等）。不迁的话它们会落到「认不出 → 最严」，
        // 一个原本选了「全放行」的用户升级后每一步都被拦，
        // 而他没改过任何设置
        let preset = store
            .workspace_settings()
            .ok()
            .and_then(|settings| settings.permission_preset)
            .map(|value| crate::risk::migrate_approval_mode(&value).to_string())
            .unwrap_or_else(|| "human_approval".to_string());
        let approved = self.approved_nodes(store, run_id)?;

        // 图里引用到的 Agent 角色，一次性查好交给执行器。
        //
        // 执行器不碰数据库：中途角色被改的话，同一次运行的前后两个节点
        // 会拿到不一样的人设，而运行记录上看不出这件事发生过。
        let profiles = self.agent_profiles_for(store, run_id)?;

        // 「模型」页的**全量**目录（含停用的），一次性查好交给执行器 ——
        // 节点的 modelPolicy 与角色的 model_ref 靠它解析，
        // 而「已停用」与「未登记」要区分：前者是用户的显式动作。
        let models: Vec<crate::executor::ModelEntry> = store
            .list_models(false)
            .unwrap_or_else(|error| {
                // 读失败与「模型页是空的」是两回事：后者静默用 agent 默认
                // 是设计，前者会把用户配好的模型悄悄忽略 —— 至少留痕
                eprintln!("[runner] 模型目录读不出来，这次运行按未配置跑：{error}");
                Vec::new()
            })
            .into_iter()
            .map(|row| crate::executor::ModelEntry {
                id: row.id,
                name: row.name,
                runtime: row.runtime,
                model_id: row.model_id,
                effort: row.effort,
                enabled: row.enabled,
            })
            .collect();

        let mut executor = NodeExecutor::new(workdir)
            .with_run_id(run_id)
            .with_memories(&memories)
            .with_permission_preset(&preset)
            .with_approved_nodes(&approved)
            .with_agent_profiles(&profiles)
            .with_models(&models);

        // 通知发送器从外壳一路传下来。没有它时 `notify` 节点
        // 明确报「这个环境发不了」—— 那正是 B-1 要修的
        if let Some(notifier) = &self.notifier {
            executor = executor.with_notifier(notifier.clone());
        }

        // 测试注入的 adapter 命令。生产路径上永远是 None
        if let Some((command, args)) = &self.acp_override {
            executor = executor.with_acp_command(command, args);
        }

        if let Some(sink) = &self.stream {
            executor = executor.with_stream(sink.clone());
        }

        // 「记忆注入可在事件中溯源」：在**取快照时**就写下，
        // 而不是等某个 AI 节点跑完 —— 那个节点可能失败、可能被取消，
        // 而「这次运行带着这些记忆」在它开始之前就已经成立了。
        //
        // 只有图里真有 AI 节点才写：一条纯脚本的工作流不用记忆，
        // 写一条注入事件是误导。
        if !memories.is_empty()
            && self.has_ai_node(store, run_id)?
            && !self.memory_event_written(store, run_id)?
        {
            let keys: Vec<&str> = memories.iter().map(|(key, _)| key.as_str()).collect();
            self.emit(
                store,
                run_id,
                "system.memory_injected",
                None,
                "engine",
                &format!("注入了 {} 条记忆：{}", keys.len(), keys.join("、")),
            )?;
        }
        // 「这次运行用的是什么角色」也要在**开始之前**写下。
        //
        // 版本快照只冻结了图，而图里存的是 `agentProfileId` 这样的引用 ——
        // 执行时现查 `agent_profile`，取的是当下的 persona / capabilities /
        // runtime。三个月后打开一条旧运行问「它当时用的什么人设、什么权限」，
        // 答案会是**今天**的；用同一个 config_hash 重跑，行为可能完全不同，
        // 而没有任何东西记下这件事发生过。
        //
        // 与记忆那条同样的判据：没有 AI 节点就不写（纯脚本的工作流
        // 写一条「用了哪些角色」是噪声），而且只写一次
        if !profiles.is_empty()
            && self.has_ai_node(store, run_id)?
            && !self.event_written(store, run_id, "system.env_snapshot")?
        {
            let summarize = profiles
                .iter()
                .map(|p| {
                    format!(
                        "{}（{}）· runtime {} · 模型 {} · 权限 {}",
                        p.name, p.id, p.runtime, p.model_ref, p.capabilities_json
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            self.emit(
                store,
                run_id,
                "system.env_snapshot",
                None,
                "engine",
                &format!("这次运行用的 {} 个角色：\n{summarize}", profiles.len()),
            )?;
        }

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
            // 「批准」对两种节点意味着完全不同的事：
            //
            // - `approval` 类型本身就是引擎强制的暂停点，它没有要执行的东西，
            //   批准即完成
            // - 其余节点是**因为权限档**（review_every_change）被拦在执行之前的。
            //   对它们发 node.succeeded 就等于跳过真正的执行 ——
            //   `completed_nodes` 信任所有 node.succeeded，下一轮推进直接走到
            //   下游去了。用户报的正是这个：他批准了「读取 Issue」，
            //   界面写着「审批通过」，而 `gh issue view` 一次都没跑，
            //   下游的 AI 于是拿到一个空的分析对象
            //
            // 不标完成，只回到 running：下一次推进会重新执行它，
            // 而 `approved_nodes`（从 approval.decided 事件算出来）
            // 保证这一次不会再被拦一遍
            if self.node_type(store, run_id, node_id)? == "approval" {
                self.emit_node(
                    store,
                    run_id,
                    "node.succeeded",
                    node_id,
                    &label,
                    "engine",
                    "审批通过",
                )?;
            } else {
                self.emit_node(
                    store,
                    run_id,
                    "node.started",
                    node_id,
                    &label,
                    "engine",
                    &format!("{label} 已批准，开始执行"),
                )?;
            }
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

    /// 这次运行的图里引用到的 Agent 角色。
    ///
    /// 只查图里真的用到的那几个：全表拉出来在角色多了之后是白花的，
    /// 而且会把「这次运行涉及哪些角色」这件事糊掉。
    fn agent_profiles_for(
        &self,
        store: &Store,
        run_id: &str,
    ) -> Result<Vec<crate::executor::AgentProfile>> {
        let (graph, _) = self.load_plan(store, run_id)?;
        agent_profiles_for_graph(store, &graph)
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
        self.emit_full(
            store, run_id, kind, node_id, node_label, actor, summary, None,
        )
    }

    /// **唯一**的事件写入口。
    ///
    /// issue #1：这里曾经有两条路径 —— 这一条填 `attempt: 1`，节点执行
    /// 途中那条事件通道填 `None`，于是 `node.output_emitted` 缺 attempt，
    /// 界面把整页事件流判为不合契约。两条路径就会有两套规则。
    ///
    /// 存储层现在也拦（`node.*` 缺 attempt 直接拒收），这里是第二道：
    /// 让所有调用点只有一个地方决定这些公共字段。
    #[allow(clippy::too_many_arguments)]
    fn emit_full(
        &self,
        store: &Store,
        run_id: &str,
        kind: &str,
        node_id: Option<&str>,
        node_label: Option<&str>,
        actor: &str,
        summary: &str,
        payload_ref: Option<String>,
    ) -> Result<()> {
        store.append_event(&NewRunEvent {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            node_id: node_id.map(str::to_string),
            node_label: node_label.map(str::to_string),
            // 重试还没实现，先都是第 1 轮。契约要求 node.* 必须有它 ——
            // 缺了的话整页事件流不合契约
            attempt: node_id.map(|_| 1),
            actor: actor.to_string(),
            status: None,
            // **落库前脱敏**，而不是读出来时才脱。
            //
            // 这是唯一的事件写入口，所以是唯一守得住的位置：脚本里一句
            // `echo $TOKEN`、`curl -v` 打出的 Authorization 头、agent 把密钥
            // 复述进回答 —— 任何一次都会让明文躺进 run_event.summary，
            // 跟着进全文索引，显示在事件列表里。而列表正下方写着
            // 「Secret 值在写入事件存储前已脱敏，界面不提供绕过查看」。
            //
            // 只在读取点脱的话，数据库文件本身仍然带着明文走备份
            summary: truncate_to(&crate::redactor::redact_shared(summary)),
            payload_ref,
            artifact_refs: vec![],
            parent_event_id: None,
            sensitivity: "internal".to_string(),
            schema_ver: 1,
        })?;
        Ok(())
    }

    /// 这次运行的图里有没有 AI 节点。
    ///
    /// 一条纯脚本的工作流不用记忆，给它写一条注入事件是误导。
    fn has_ai_node(&self, store: &Store, run_id: &str) -> Result<bool> {
        let Some(graph_json) = store.run_graph(run_id)? else {
            return Ok(false);
        };
        let graph: WorkflowGraph =
            serde_json::from_str(&graph_json).map_err(|e| RunError::GraphInvalid(e.to_string()))?;
        Ok(graph
            .nodes
            .iter()
            .any(|node| node.node_type.starts_with("ai.")))
    }

    /// 这次运行有没有写过注入事件。
    ///
    /// 记忆快照在整个运行里是同一份，所以写一条就够 ——
    /// 每个 AI 节点各写一条的话，五个 AI 节点就是五条一模一样的事件。
    fn memory_event_written(&self, store: &Store, run_id: &str) -> Result<bool> {
        self.event_written(store, run_id, "system.memory_injected")
    }

    /// 这条运行里已经写过这类事件了吗。
    ///
    /// 「运行开始时写一次」的那几条（记忆注入、角色快照）恢复执行时
    /// 会再走一遍这段代码 —— 不查一下的话，一条被中断过三次的运行
    /// 会有四条一模一样的快照。
    fn event_written(&self, store: &Store, run_id: &str, kind: &str) -> Result<bool> {
        Ok(store
            .events(run_id, 0, 500)?
            .iter()
            .any(|event| event.kind == kind))
    }

    /// 从运行引用的图里查节点标题。查不到就退回 id ——
    /// 显示一个 id 总好过让审批决定写不进事件。
    /// 节点类型。`decide_approval` 靠它区分「审批节点」与
    /// 「因权限档被拦下的节点」—— 两者对「批准」的含义完全不同。
    ///
    /// 查不到时返回空串：那会走「重新执行」那一支，而重跑一个
    /// 已经批准过的节点，最坏是多做一次；反过来漏掉执行是静默跳过。
    fn node_type(&self, store: &Store, run_id: &str, node_id: &str) -> Result<String> {
        let Some(graph_json) = store.run_graph(run_id)? else {
            return Ok(String::new());
        };
        let graph: WorkflowGraph =
            serde_json::from_str(&graph_json).map_err(|e| RunError::GraphInvalid(e.to_string()))?;
        Ok(graph
            .nodes
            .iter()
            .find(|n| n.id == node_id)
            .map_or_else(String::new, |n| n.node_type.clone()))
    }

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

/// 摘要的兜底截断。
///
/// 存储层拒收超过 `EVENT_SUMMARY_MAX` 的摘要，那条约束是对的 ——
/// 大内容该走 artifact + `payload_ref`。但**拒收发生在写入的那一刻**，
/// 而写入的那一刻常常正是「节点失败了，要记下为什么」：
///
/// - 脚本把 5000 字错误打在同一行 stderr 上（编译器、node 的 stack、
///   curl 打回的 body 都会这样），`first_line()` 只取第一行、不限长度
/// - 节点标题本身很长（契约对 title 只有 `min(1)`，没有上限）
///
/// 结果是**连 `node.failed` 都写不进去**：界面上那个节点永远停在
/// 「运行中」，而用户看到的是一句提「artifact」「payload_ref」的内部术语 ——
/// 真正的失败原因反而被这条假错误盖过去了。
///
/// 所以在唯一的写入口兜一道。截断比丢事件好得多：前半段通常就够定位问题，
/// 而丢掉整条之后连「它失败过」都无从得知。
fn truncate_to(summary: &str) -> String {
    let limit = aiwf_store::EVENT_SUMMARY_MAX;
    if summary.chars().count() <= limit {
        return summary.to_string();
    }
    // 留出省略提示的位置，并且**按字符切**不按字节 —— 中文按字节切会切出半个字
    const HINT: &str = "…（超长已截断，全文见产物）";
    let keep = limit.saturating_sub(HINT.chars().count());
    format!("{}{HINT}", summary.chars().take(keep).collect::<String>())
}
