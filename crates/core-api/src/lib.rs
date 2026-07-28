//! Core API 的实现，与外壳无关。
//!
//! 桌面壳（Tauri IPC）与开发用 HTTP 服务都调用这里的函数。
//! 之所以抽出来，是因为两端各写一份的话，改了一处忘了另一处，
//! 症状是「桌面版好用、Web 版数据不对」——这种漂移很难查。
//!
//! 所有 DTO 的 `Option` 字段都带 `skip_serializing_if`：
//! Rust 的 `None` 序列化成 JSON `null`，而契约里 `.optional()` 只接受
//! **字段不存在**，不接受 `null` —— 校验直接失败，症状是整页显示
//! 「返回值不合契约」。JSON 里表达「没有这个值」的方式是字段缺席。
//! 这个坑是浏览器端到端测试抓到的。

pub mod dispatch;
pub mod env;
pub mod mcp_clients;
pub mod mcp_config;

pub use env::{EnvHealthItem, EnvHealthReport, EnvSource, EnvStatus, env_health};

use std::path::Path;

use aiwf_engine::runner::RunRequest;
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde::Serialize;

/// Dry Run 结果 + 实际会用的工作目录。
///
/// 目录要回传给界面：默认路径只有引擎侧知道（应用数据目录），
/// 让前端自己拼一个字符串的话，它拼出来的会是个不存在的路径 ——
/// 于是「打开启动表单什么都不改就无法运行」。这个坑是浏览器端到端抓到的。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunDto {
    pub workdir: String,
    #[serde(flatten)]
    pub report: aiwf_engine::preflight::DryRunReport,
}

/// 起一次运行时的工作目录：未指定就在运行根下**开一个独立的**。
///
/// 共用一个目录的代价是并发运行互相覆盖文件。第 4 轮复验实测：
/// 并发起 5 个运行，每个 `echo > mark.txt` 再读回，磁盘上只剩一个
/// `mark.txt` —— 而启动表单写着「每次运行一个独立目录，并行运行互不影响」，
/// `Runner::workdir` 的注释也写着「每个 Run 一个」。
/// M2 的出口标准里那条「并行运行互不影响」，`supervisor_test` 是
/// **显式传不同 workdir** 验的，恰好绕开了产品的默认路径。
///
/// 目录名用「时刻 + 序号」而不是 run id：run id 由 `store.create_run_in`
/// 分配，这一层还拿不到。运行详情页显示的是这里存下的完整路径，对得上是哪一次。
fn resolve_run_workdir(workdir: Option<&str>, data_dir: &std::path::Path) -> std::path::PathBuf {
    let 指定了 = workdir
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .is_some();
    let 根 = resolve_workdir(workdir, data_dir);
    if 指定了 {
        // 显式指定通常是「跑在我这个仓库里」，再往下套一层就跑错地方了
        return 根;
    }

    static 序号: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = 序号.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let 时刻 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let 独立 = 根.join(format!("run-{时刻}-{n:04}"));
    let _ = std::fs::create_dir_all(&独立);
    独立
}

/// 解析工作目录的**根**：留空用应用的默认运行目录，`~` 要展开。
///
/// 不展开 `~` 的话，用户手输一个看起来完全正常的路径，
/// 引擎会去找一个名叫 `~` 的目录，报「不存在」——
/// 而错误信息里那个路径看着是对的，没人会想到是波浪号的问题。
///
/// 默认目录**由这里创建**：那是引擎自己的地盘，第一次跑必然不存在，
/// 让 Dry Run 报「目录不存在」等于要求用户先手动 mkdir 一个
/// 他根本不知道在哪的路径。用户显式指定的目录是另一回事 ——
/// 那种不存在就该报错，因为多半是打错了。
///
/// Dry Run 用这个（它只是告诉用户「会写到哪一片」，不该为一次预检
/// 建一个空的运行目录）；真正起运行走 `resolve_run_workdir`。
fn resolve_workdir(workdir: Option<&str>, data_dir: &std::path::Path) -> std::path::PathBuf {
    let raw = workdir.map(str::trim).filter(|dir| !dir.is_empty());
    let Some(raw) = raw else {
        let default = data_dir.join("runs");
        let _ = std::fs::create_dir_all(&default);
        return default;
    };

    if let Some(rest) = raw.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        // 去掉前导斜杠：`~//tmp/x` 的 rest 是 `/tmp/x`，
        // 而 PathBuf::join 遇到绝对路径会**丢掉左边整段** ——
        // 结果落到文件系统根下的 /tmp/x，而不是家目录里
        let rest = rest.trim_start_matches('/');
        return std::path::PathBuf::from(home).join(rest);
    }
    std::path::PathBuf::from(raw)
}

/// 传给界面的错误。形状与 `@aiwf/contracts` 的统一错误对象一致。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub retriable: bool,
    /**
     * 接下来该干什么。
     *
     * 契约的错误对象一直是 `{code, message, retriable, hint}`，
     * 而这里长期只有前三个 —— 于是用户看到的永远只有「出了什么事」，
     * 没有「怎么办」。「找不到工作流 wf_x」与
     * 「找不到工作流 wf_x（它可能已被删除，去首页列表里找找）」
     * 差的就是这个字段。
     */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    /// 入参不合法。与契约的 ERROR_CODES 对齐，界面只处理一种错误形状。
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "VALIDATION".to_string(),
            message: message.into(),
            retriable: false,
            hint: None,
        }
    }

    /// 带上「接下来该干什么」。空串等于没有 —— 界面会显示一对空括号。
    #[must_use]
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        let text = hint.into();
        self.hint = (!text.trim().is_empty()).then_some(text);
        self
    }
}

impl From<aiwf_store::StoreError> for ApiError {
    fn from(error: aiwf_store::StoreError) -> Self {
        // 错误码与 @aiwf/contracts 的 ERROR_CODES 对齐，界面只处理一种错误形状
        let (code, retriable) = match error {
            aiwf_store::StoreError::Invalid(_) => ("VALIDATION", false),
            aiwf_store::StoreError::NotFound { .. } => ("VALIDATION", false),
            // 冲突可重试：调用方重新读取草稿后再提交
            aiwf_store::StoreError::RevisionConflict { .. } => ("REVISION_CONFLICT", true),
            aiwf_store::StoreError::Sqlite(_) => ("INTERNAL", false),
        };
        // 提示按错误种类给：它要能照着做，不是把 message 换个说法
        let hint = match &error {
            aiwf_store::StoreError::NotFound { kind, .. } => {
                Some(format!("这个{kind}可能已被删除。回列表页看看还在不在"))
            }
            aiwf_store::StoreError::RevisionConflict { base, current } => Some(format!(
                "别处已经把它改到 rev{current}，而你这次基于 rev{base}。\
                 刷新拿到最新版本再改一次"
            )),
            _ => None,
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
            retriable,
            hint,
        }
    }
}

impl From<aiwf_engine::supervisor::SupervisorError> for ApiError {
    fn from(error: aiwf_engine::supervisor::SupervisorError) -> Self {
        use aiwf_engine::supervisor::SupervisorError as E;
        let (code, retriable) = match &error {
            E::Store(inner) => match inner {
                aiwf_store::StoreError::RevisionConflict { .. } => ("REVISION_CONFLICT", true),
                aiwf_store::StoreError::Sqlite(_) => ("INTERNAL", false),
                _ => ("VALIDATION", false),
            },
            // preflight 不过、状态不对、审批指向错节点，都属于用户能修的问题
            E::Run(_) => ("VALIDATION", false),
            // 已经在跑了：这是调用方的状态判断问题，重试没有意义
            E::AlreadyRunning(_) => ("VALIDATION", false),
            E::Poisoned => ("INTERNAL", false),
        };
        // 已经在跑是最常撞的一种，给条出路
        let hint = match &error {
            E::AlreadyRunning(_) => {
                Some("这条运行还没结束。去执行记录里看它停在哪一步".to_string())
            }
            _ => None,
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
            retriable,
            hint,
        }
    }
}

/// 已接通的方法名清单。HTTP 侧按它分派，测试按它守住两端一致。
pub const COMMANDS: &[&str] = &[
    "supervisor_ask",
    "supervisor_sessions",
    "supervisor_session",
    "memory_list",
    "memory_create",
    "memory_update",
    "memory_toggle",
    "memory_delete",
    "prompt_list",
    "prompt_create",
    "prompt_update",
    "prompt_versions",
    "prompt_duplicate",
    "prompt_delete",
    "agent_list",
    "agent_create",
    "agent_update",
    "agent_duplicate",
    "agent_delete",
    "model_list",
    "model_create",
    "model_update",
    "model_test",
    "model_delete",
    "run_start",
    "run_dry_run",
    "run_list",
    "run_get",
    "run_events",
    "run_artifacts",
    "run_cancel",
    "run_resume",
    "run_rewind_to_approval",
    "approval_decide",
    "workflow_list",
    "workspace_stats",
    "workspace_settings",
    "mcp_request_confirm",
    "mcp_confirm_status",
    "mcp_pending_confirms",
    "mcp_decide_confirm",
    "mcp_status",
    "mcp_connect",
    "env_diagnostics",
    "workspace_update_settings",
    "env_health",
    "run_artifact_content",
    "run_diagnostics",
    "workflow_create",
    "workflow_get",
    "workflow_save_draft",
    "workflow_patch",
    "workflow_validate",
    "workflow_diff",
    "workflow_publish",
    "workflow_version_graph",
    "workflow_rollback",
    "workflow_rename",
    "workflow_discard_if_empty",
    "workflow_delete",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    id: String,
    workflow_id: String,
    workflow_name: String,
    status: String,
    inputs_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
/// 字段名与契约的 `RunEventSchema` 严格对应。
///
/// 少一个 `runId` 或把 `type` 写成 `kind`，Zod 就会整页拒收 ——
/// 症状是「事件流一条都不显示」，而运行本身明明成功了。
pub struct RunEventDto {
    id: String,
    run_id: String,
    seq: i64,
    ts: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_id: Option<String>,
    /// 节点在**当时**的标题。界面显示的是它，不是 node_id。
    #[serde(skip_serializing_if = "Option::is_none")]
    node_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<i64>,
    actor: String,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload_ref: Option<String>,
    sensitivity: String,
    schema_ver: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventsPage {
    events: Vec<RunEventDto>,
    next_seq: i64,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDto {
    pub id: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub key: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub source: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub sensitivity: String,
    pub ver: i64,
    pub tags: Vec<String>,
    pub enabled: bool,
}

impl From<aiwf_store::MemoryRow> for MemoryDto {
    fn from(row: aiwf_store::MemoryRow) -> Self {
        Self {
            id: row.id,
            scope: row.scope,
            scope_id: row.scope_id,
            key: row.key,
            value: row.value,
            summary: row.summary,
            source: row.source,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
            expires_at: row.expires_at,
            sensitivity: row.sensitivity,
            ver: row.ver,
            tags: row.tags,
            enabled: row.enabled,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDto {
    pub id: String,
    pub group: String,
    pub name: String,
    pub sections: serde_json::Value,
    pub vars: serde_json::Value,
    pub ver: i64,
    pub builtin: bool,
    pub updated_at: String,
}

impl From<aiwf_store::PromptRow> for PromptDto {
    fn from(row: aiwf_store::PromptRow) -> Self {
        Self {
            id: row.id,
            group: row.group,
            name: row.name,
            // 存的是 JSON 文本，给界面的是结构化值。
            // 解析不出来时给空数组：一条坏记录不该让整个提示词库打不开
            sections: serde_json::from_str(&row.sections_json)
                .unwrap_or_else(|_| serde_json::json!([])),
            vars: serde_json::from_str(&row.vars_json).unwrap_or_else(|_| serde_json::json!([])),
            ver: row.ver,
            builtin: row.builtin,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDto {
    pub id: String,
    pub name: String,
    pub role: String,
    pub goal: String,
    pub persona: String,
    pub runtime: String,
    pub model_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_model_ref: Option<String>,
    pub tools: Vec<String>,
    pub capabilities: serde_json::Value,
    pub output_contract: String,
    pub turn_limit: i64,
    pub timeout_ms: i64,
    pub ver: i64,
    pub builtin: bool,
}

impl From<aiwf_store::AgentRow> for AgentDto {
    fn from(row: aiwf_store::AgentRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            role: row.role,
            goal: row.goal,
            persona: row.persona,
            runtime: row.runtime,
            model_ref: row.model_ref,
            fallback_model_ref: row.fallback_model_ref,
            tools: row.tools,
            // 权限整体存一个 JSON；解析不出来时给空对象而不是让整页失败
            capabilities: serde_json::from_str(&row.capabilities_json)
                .unwrap_or_else(|_| serde_json::json!({})),
            output_contract: row.output_contract,
            turn_limit: row.turn_limit,
            timeout_ms: row.timeout_ms,
            ver: row.ver,
            builtin: row.builtin,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    id: String,
    name: String,
    runtime: String,
    model_id: String,
    effort: String,
    context_window: i64,
    capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_ref: Option<String>,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_latency_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDto {
    node_id: String,
    kind: String,
    name: String,
    /// 磁盘上的绝对路径。图纸列表底部显示的是它的父目录。
    path: String,
    /// 相对运行目录的路径，预览接口收的就是它。
    rel_path: String,
    bytes: u64,
    sha256: String,
}

/// 一次产物预览的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContentDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    binary: bool,
    truncated: bool,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsDto {
    items: Vec<ArtifactDto>,
    root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder: Option<String>,
    created_at: String,
    updated_at: String,
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run: Option<LastRunDto>,
}

/// 首页列表行上的运行态投影。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRunDto {
    id: String,
    status: String,
    started_at: String,
    /// 已结束才有；运行中的时长由界面按当前时间算。
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_node_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<i64>,
}

/// 首页四张统计卡。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatsDto {
    pending_approvals: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_approval_hint: Option<String>,
    runs_today: i64,
    runs_today_succeeded: i64,
    /// 缺席表示还没有数据源 —— 界面显示「—」而不是 0。
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens_this_week: Option<i64>,
    active_worktrees: i64,
    worktree_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMetaDto {
    id: String,
    version: i64,
    config_hash: String,
    published_at: String,
    published_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDetail {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder: Option<String>,
    created_at: String,
    updated_at: String,
    /// 当前草稿修订号。提交改动时要带回来做版本守卫。
    rev: i64,
    graph_json: String,
    versions: Vec<VersionMetaDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedDto {
    version_id: String,
    version: i64,
    config_hash: String,
}

impl From<aiwf_store::RunRow> for RunSummary {
    fn from(row: aiwf_store::RunRow) -> Self {
        Self {
            id: row.id,
            workflow_id: row.workflow_id,
            workflow_name: row.workflow_name,
            status: row.status,
            inputs_json: row.inputs_json,
            current_node: row.current_node,
            workdir: row.workdir,
            started_at: row.started_at,
            ended_at: row.ended_at,
        }
    }
}

impl From<aiwf_store::ModelRow> for ModelDto {
    fn from(row: aiwf_store::ModelRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            runtime: row.runtime,
            model_id: row.model_id,
            effort: row.effort,
            context_window: row.context_window,
            capabilities: row.capabilities,
            credential_ref: row.credential_ref,
            enabled: row.enabled,
            last_latency_ms: row.last_latency_ms,
        }
    }
}

pub fn model_list(
    store: &Store,
    enabled_only: bool,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> ApiResult<Page<ModelDto>> {
    let (rows, total) = store.list_models_paged(
        enabled_only,
        query.as_deref(),
        page_limit(limit),
        page_offset(offset),
    )?;
    Ok(Page {
        items: rows.into_iter().map(ModelDto::from).collect(),
        total,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn model_create(
    store: &Store,
    name: String,
    runtime: String,
    model_id: String,
    effort: String,
    context_window: i64,
    capabilities: Vec<String>,
    credential_ref: Option<String>,
    enabled: bool,
) -> ApiResult<String> {
    Ok(store.create_model(&aiwf_store::NewModel {
        name,
        runtime,
        model_id,
        effort,
        context_window,
        capabilities,
        credential_ref,
        enabled,
    })?)
}

#[allow(clippy::too_many_arguments)]
pub fn model_update(
    store: &Store,
    id: String,
    name: Option<String>,
    runtime: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    context_window: Option<i64>,
    capabilities: Option<Vec<String>>,
    credential_ref: Option<String>,
    enabled: Option<bool>,
) -> ApiResult<()> {
    store.update_model(
        &id,
        name.as_deref(),
        runtime.as_deref(),
        model_id.as_deref(),
        effort.as_deref(),
        context_window,
        capabilities.as_deref(),
        enabled,
    )?;
    // 凭据单独走一条，改凭据在审计里独立可见
    if let Some(reference) = credential_ref {
        store.set_model_credential(&id, Some(&reference))?;
    }
    Ok(())
}

pub fn model_delete(store: &Store, id: String) -> ApiResult<()> {
    store.delete_model(&id)?;
    Ok(())
}

/// 启动运行。preflight 与建 Run 同步做完（调用方立刻拿到 runId
/// 或立刻知道图有问题），执行本身在后台线程。
#[allow(clippy::too_many_arguments)]
pub fn run_start(
    store: &Store,
    supervisor: &Supervisor,
    data_dir: &std::path::Path,
    workflow_id: String,
    version_id: Option<String>,
    draft_rev: Option<i64>,
    inputs_json: String,
    workdir: Option<String>,
) -> ApiResult<String> {
    // 契约写的是「versionId 与 draftRev 必须且只能提供一个」，但那条约束
    // 原来只活在 Zod 里 —— HTTP 桥接与 MCP 都能绕过去。
    //
    // 绕过去的后果不是报错：run_graph 找不到图就返回 None，引擎拿一张空图跑，
    // preflight 报「缺少入口节点」。用户看到的是「我的工作流明明有入口节点」，
    // 而真正的原因是调用方少传了参数
    if version_id.is_some() == draft_rev.is_some() {
        return Err(ApiError::validation(
            "versionId 与 draftRev 必须且只能提供一个：运行引用的是某个确定的图",
        ));
    }

    let workdir = resolve_run_workdir(workdir.as_deref(), data_dir);
    let run_id = supervisor.start(
        store,
        RunRequest {
            workflow_id,
            version_id,
            draft_rev,
            inputs_json,
            workdir: workdir.display().to_string(),
        },
    )?;
    Ok(run_id)
}

/// Dry Run 依赖检查。只读，不建 Run —— 启动表单打开时就调。
pub fn run_dry_run(
    store: &Store,
    data_dir: &std::path::Path,
    workflow_id: String,
    version_id: Option<String>,
    draft_rev: Option<i64>,
    workdir: Option<String>,
) -> ApiResult<DryRunDto> {
    let workdir = resolve_workdir(workdir.as_deref(), data_dir);
    let graph_json = match version_id {
        Some(id) => store.get_version(&id)?.map(|v| v.graph_json),
        None => store.get_draft(&workflow_id, draft_rev.unwrap_or(0))?,
    }
    .ok_or_else(|| ApiError {
        code: "VALIDATION".to_string(),
        message: "找不到要检查的工作流定义".to_string(),
        retriable: false,
        hint: None,
    })?;

    let graph: aiwf_engine::graph::WorkflowGraph =
        serde_json::from_str(&graph_json).map_err(|error| ApiError {
            code: "INTERNAL".to_string(),
            message: format!("图数据无法解析：{error}"),
            retriable: false,
            hint: None,
        })?;

    Ok(DryRunDto {
        report: aiwf_engine::preflight::dry_run(&graph, &workdir),
        workdir: workdir.display().to_string(),
    })
}

pub fn run_list(
    store: &Store,
    workflow_id: Option<String>,
    statuses: Vec<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> ApiResult<Page<RunSummary>> {
    let (rows, total) = store.list_runs_paged(
        workflow_id.as_deref(),
        &statuses,
        query.as_deref(),
        page_limit(limit),
        page_offset(offset),
    )?;
    Ok(Page {
        items: rows.into_iter().map(RunSummary::from).collect(),
        total,
    })
}

pub fn run_get(store: &Store, run_id: String) -> ApiResult<Option<RunSummary>> {
    Ok(store.get_run(&run_id)?.map(RunSummary::from))
}

/// 游标分页拉事件。界面靠 nextSeq 增量拉，不重复读已有的部分。
pub fn run_events(
    store: &Store,
    run_id: String,
    from_seq: i64,
    limit: i64,
) -> ApiResult<RunEventsPage> {
    // 多取一条来判断还有没有更多，省掉一次 count 查询
    let mut rows = store.events(&run_id, from_seq, limit + 1)?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);

    let next_seq = rows.last().map_or(from_seq, |row| row.seq);
    Ok(RunEventsPage {
        events: rows
            .into_iter()
            .map(|row| RunEventDto {
                id: row.id,
                run_id: row.run_id,
                seq: row.seq,
                ts: row.ts,
                kind: row.kind,
                node_id: row.node_id,
                node_label: row.node_label,
                attempt: row.attempt,
                actor: row.actor,
                summary: row.summary,
                payload_ref: row.payload_ref,
                sensitivity: row.sensitivity,
                // 事件的 schema 版本目前只有 1；契约要求这个字段必填
                schema_ver: 1,
            })
            .collect(),
        next_seq,
        has_more,
    })
}

pub fn run_artifacts(store: &Store, run_id: String) -> ApiResult<ArtifactsDto> {
    let workdir = store
        .run_workdir(&run_id)?
        .filter(|dir| !dir.is_empty())
        .map_or_else(std::env::temp_dir, std::path::PathBuf::from);

    let artifacts = aiwf_engine::artifacts::ArtifactStore::new(workdir.join(".aiwf-artifacts"));
    let items = artifacts.list(&run_id).map_err(|error| ApiError {
        code: "INTERNAL".to_string(),
        message: format!("读取产物失败：{error}"),
        retriable: true,
        hint: None,
    })?;

    Ok(ArtifactsDto {
        root: artifacts.root().join(&run_id).display().to_string(),
        items: items
            .into_iter()
            .map(|item| ArtifactDto {
                // 预览用相对路径 —— 绝对路径进了界面就等于让前端拼任意路径，
                // 而 run.artifactContent 的第一道防线正是「只收相对路径」
                rel_path: format!("{}/{}", item.node_id, item.name),
                node_id: item.node_id,
                kind: item.kind,
                name: item.name,
                path: item.path.display().to_string(),
                bytes: item.bytes,
                sha256: item.sha256,
            })
            .collect(),
    })
}

/// 读一个产物的内容用于预览。
///
/// 路径穿越由引擎侧的 ArtifactStore::read 挡 —— 那是真正的边界，
/// 因为 HTTP 桥接与 MCP 都绕得过契约层的 Zod。
pub fn run_artifact_content(
    store: &Store,
    run_id: String,
    path: String,
    max_bytes: Option<i64>,
) -> ApiResult<ArtifactContentDto> {
    let workdir = store
        .run_workdir(&run_id)?
        .filter(|dir| !dir.is_empty())
        .map_or_else(std::env::temp_dir, std::path::PathBuf::from);

    let artifacts = aiwf_engine::artifacts::ArtifactStore::new(workdir.join(".aiwf-artifacts"));
    let limit = max_bytes.unwrap_or(65_536).clamp(1, 1_000_000) as usize;

    let content = artifacts
        .read(&run_id, &path, limit)
        .map_err(|error| ApiError::validation(format!("读取产物失败：{error}")))?;

    // 界面这一层要脱敏。事件流底部常驻着「Secret 值在写入事件存储前已脱敏，
    // **界面不提供绕过查看**」，而产物就在隔壁那个 tab，每条都有「预览」按钮 ——
    // 第 5 轮实测：脚本 echo 出来的 sk-… 在这里一字未改地送到了界面，
    // 那正是最容易被截图与录屏的地方。
    //
    // 磁盘上的文件不动：那是脚本的真实输出，要调试就去 workdir 看，
    // 路径在运行详情页显示着。这里管的是界面这一层。
    let redactor = aiwf_engine::redactor::Redactor::with_defaults();

    Ok(ArtifactContentDto {
        text: content.text.map(|t| redactor.redact(&t)),
        binary: content.binary,
        truncated: content.truncated,
        bytes: content.bytes,
    })
}

pub fn run_cancel(store: &Store, supervisor: &Supervisor, run_id: String) -> ApiResult<()> {
    supervisor.cancel(store, &run_id)?;
    Ok(())
}

/// 从检查点恢复：接着最近一次挂起的位置往下跑。
pub fn run_resume(store: &Store, supervisor: &Supervisor, run_id: String) -> ApiResult<()> {
    supervisor.resume(store, &run_id)?;
    Ok(())
}

pub fn approval_decide(
    store: &Store,
    supervisor: &Supervisor,
    run_id: String,
    node_id: String,
    decision: String,
) -> ApiResult<()> {
    supervisor.decide_approval(store, &run_id, &node_id, &decision)?;
    Ok(())
}

pub fn workflow_list(
    store: &Store,
    status: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> ApiResult<Page<WorkflowSummary>> {
    // 筛选与搜索都在后端做：分页之后前端过滤只能过滤当前页
    let (rows, total) = store.list_workflows_filtered(
        status.as_deref(),
        query.as_deref(),
        page_limit(limit),
        page_offset(offset),
    )?;
    Ok(Page {
        total,
        items: rows
            .into_iter()
            .map(|w| WorkflowSummary {
                id: w.id,
                name: w.name,
                folder: w.folder,
                created_at: w.created_at,
                updated_at: w.updated_at,
                archived: w.archived,
                latest_version: w.latest_version,
                last_run: w.last_run.map(|r| LastRunDto {
                    duration_ms: duration_ms_between(&r.started_at, r.ended_at.as_deref()),
                    // 失败时停在哪个节点：current_node 存的是节点 id，
                    // 界面要的是用户看得懂的标题，但那要读图 —— 列表一次读 300 张图
                    // 不现实。先给 id，详情页才展开成标题
                    failed_node_label: if r.status == "failed" {
                        r.failed_node.clone()
                    } else {
                        None
                    },
                    id: r.id,
                    status: r.status,
                    started_at: r.started_at,
                    version: r.version,
                }),
            })
            .collect(),
    })
}

/// 一页最多多少条。与契约的 LIST_PAGE_LIMIT_MAX 对齐 ——
/// 上限存在的意义就是不能被绕过。
const PAGE_LIMIT_MAX: i64 = 200;
const PAGE_SIZE: i64 = 50;

fn page_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(PAGE_SIZE).clamp(1, PAGE_LIMIT_MAX)
}

fn page_offset(offset: Option<i64>) -> i64 {
    offset.unwrap_or(0).max(0)
}

/// 首页四张统计卡。
///
/// worktree 那两项走文件系统 —— 存储层里没有它们的记录，
/// 而真实占用只有磁盘知道（用户可能手工删过）。
/// 工作区设置。三项都可缺席 —— 没配过就是没配过，界面照实显示。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettingsDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_checked_at: Option<String>,
}

/// 读工作区设置。顶栏的工作目录、侧栏的权限档与环境状态都来自它。
pub fn workspace_settings(store: &Store) -> ApiResult<WorkspaceSettingsDto> {
    let settings = store.workspace_settings()?;
    Ok(WorkspaceSettingsDto {
        workdir: settings.workdir,
        permission_preset: settings.permission_preset,
        env_checked_at: settings.env_checked_at,
    })
}

/// 改工作区设置。只带要改的项。
pub fn workspace_update_settings(
    store: &Store,
    workdir: Option<&str>,
    permission_preset: Option<&str>,
    env_checked_at: Option<&str>,
) -> ApiResult<()> {
    if let Some(dir) = workdir {
        store.set_workspace_setting("workdir", dir)?;
    }
    if let Some(preset) = permission_preset {
        // 契约那侧已经用 enum 挡过一道；这里再挡一次是因为
        // MCP 与桌面 IPC 都能直接调到这里，不都经过 Zod
        if !PERMISSION_PRESETS.contains(&preset) {
            return Err(ApiError::validation(format!(
                "不认识的权限档 {preset}。允许的是：{}",
                PERMISSION_PRESETS.join("、")
            )));
        }
        store.set_workspace_setting("permissionPreset", preset)?;
    }
    if let Some(at) = env_checked_at {
        store.set_workspace_setting("envCheckedAt", at)?;
    }
    Ok(())
}

/// 权限三档。与 `packages/contracts/src/capabilities.ts` 的 `PERMISSION_PRESETS` 对齐。
const PERMISSION_PRESETS: &[&str] = &["review_every_change", "workspace_safe", "trusted_workflow"];

pub fn workspace_stats(store: &Store, workdir: Option<&Path>) -> ApiResult<WorkspaceStatsDto> {
    let stats = store.workspace_stats()?;
    let (count, bytes) = workdir.map_or((0, 0), worktree_usage);

    Ok(WorkspaceStatsDto {
        pending_approvals: stats.pending_approvals,
        pending_approval_hint: stats.pending_approval_hint,
        runs_today: stats.runs_today,
        runs_today_succeeded: stats.runs_today_succeeded,
        // 事件流里目前不记 token。给 0 会被读成「这周没花钱」，
        // 那比空着更糟 —— 空着至少是诚实的
        tokens_this_week: None,
        active_worktrees: count,
        worktree_bytes: bytes,
    })
}

/// 数 `.aiwf-worktrees` 下的目录与占用。
///
/// 失败一律当 0：统计卡不该因为权限问题让整个首页报错。
fn worktree_usage(workdir: &Path) -> (i64, i64) {
    let root = workdir.join(aiwf_engine::worktree::ENGINE_WORKTREE_DIR);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return (0, 0);
    };

    let mut count = 0;
    let mut bytes = 0;
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            count += 1;
            bytes += dir_size(&entry.path());
        }
    }
    (count, bytes)
}

fn dir_size(path: &Path) -> i64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            // symlink 不递归：worktree 里的链接可能指向仓库外，
            // 跟进去会把整个磁盘算进来，也可能绕成环
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len() as i64).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// 两个 ISO 时间戳之间的毫秒数。解析不出来就当没有 —— 界面会显示「运行中」。
fn duration_ms_between(started: &str, ended: Option<&str>) -> Option<i64> {
    let ended = ended?;
    let a = iso_to_millis(started)?;
    let b = iso_to_millis(ended)?;
    (b >= a).then_some(b - a)
}

/// 解析 `now_iso()` 写出的 `YYYY-MM-DDTHH:MM:SS.mmmZ`。
fn iso_to_millis(iso: &str) -> Option<i64> {
    let (date, rest) = iso.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day) = (
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<i64>().ok()?,
    );
    let time = rest.trim_end_matches('Z');
    let (hms, ms) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':');
    let (h, min, sec) = (
        t.next()?.parse::<i64>().ok()?,
        t.next()?.parse::<i64>().ok()?,
        t.next()?.parse::<i64>().ok()?,
    );

    // days_from_civil（Howard Hinnant），与存储层写时间用的是同一套换算
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    Some((days * 86_400 + h * 3600 + min * 60 + sec) * 1000 + ms.parse::<i64>().unwrap_or(0))
}

/// 新建工作流。
///
/// `name` 缺席时由存储层编号（「未命名工作流 N」）——
/// 界面自己算的话只能看到当前页，分页后每次新建都叫「未命名工作流 51」。
pub fn workflow_create(
    store: &Store,
    name: Option<String>,
    graph_json: Option<String>,
) -> ApiResult<String> {
    let name = match name {
        Some(given) => given,
        None => store.next_untitled_name()?,
    };
    Ok(match graph_json {
        Some(graph) => store.create_workflow_with_graph(&name, None, &graph)?,
        None => store.create_workflow(&name, None)?,
    })
}

pub fn workflow_get(store: &Store, id: String) -> ApiResult<WorkflowDetail> {
    let workflow = store
        .get_workflow(&id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "工作流",
            id: id.clone(),
        })?;
    let rev = store
        .draft_revision(&id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "草稿",
            id: id.clone(),
        })?;
    let graph_json = store
        .get_draft(&id, rev)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "草稿修订",
            id: format!("{id}@{rev}"),
        })?;

    Ok(WorkflowDetail {
        id: workflow.id,
        name: workflow.name,
        folder: workflow.folder,
        created_at: workflow.created_at,
        updated_at: workflow.updated_at,
        rev,
        graph_json,
        versions: store
            .list_versions(&id)?
            .into_iter()
            .map(|v| VersionMetaDto {
                id: v.id,
                version: v.version,
                config_hash: v.config_hash,
                published_at: v.published_at,
                published_by: v.published_by,
            })
            .collect(),
    })
}

/// 保存草稿。`base_rev` 不匹配时返回 REVISION_CONFLICT，绝不覆盖别处的改动。
pub fn workflow_save_draft(
    store: &Store,
    id: String,
    base_rev: i64,
    graph_json: String,
) -> ApiResult<i64> {
    Ok(store.save_draft_guarded(&id, base_rev, &graph_json)?)
}

/// `workflow.patch` 的返回值。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchDto {
    pub rev: i64,
    pub diff: aiwf_engine::patch::WorkflowDiff,
    pub validation: aiwf_engine::validate::ValidationResult,
}

/// 结构化修改草稿 —— **引擎自己应用 Patch**。
///
/// ADR-0008 当时的决定是「客户端算好结果图捎带过来」，理由是 Rust 侧
/// 没有 applyPatch，写第二份必然漂移。那条 ADR 也写了退出条件：
/// 「一旦引擎侧要独立应用 Patch（例如让 MCP 直连引擎而不经过客户端），
/// 就该在 Rust 侧实现 applyPatch，并把 graphJson 降级为可选校验用途。」
/// 系统级 MCP 就是那个场景：Agent 不经过任何客户端，没人替它算那张图。
///
/// 漂移的对冲是 `crates/engine/tests/conformance_test.rs`：
/// 43 组夹具由 TypeScript 那份算出期望值，Rust 逐字比对，含错误文案。
///
/// `graph_json` 仍然收，但只当交叉校验：两边算出的图不一致时留一行日志。
/// 以引擎算的为准 —— 它是唯一能保证「操作列表与落库的图对得上」的一方。
///
/// # Errors
/// baseRevision 与当前草稿不符时返回 REVISION_CONFLICT；操作不合法返回 VALIDATION。
pub fn workflow_patch(
    store: &Store,
    id: String,
    base_revision: i64,
    operations_json: String,
    graph_json: Option<String>,
) -> ApiResult<PatchDto> {
    let current = store
        .draft_revision(&id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "草稿",
            id: id.clone(),
        })?;
    let graph_text = store
        .get_draft(&id, current)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "草稿修订",
            id: format!("{id}@{current}"),
        })?;

    let graph: serde_json::Value = serde_json::from_str(&graph_text)
        .map_err(|error| ApiError::validation(format!("草稿不是合法 JSON：{error}")))?;
    let operations: serde_json::Value = serde_json::from_str(&operations_json)
        .map_err(|error| ApiError::validation(format!("operations 不是合法 JSON：{error}")))?;

    let patch = serde_json::json!({ "baseRevision": base_revision, "operations": operations });
    let result =
        aiwf_engine::patch::apply_patch(&graph, current, &patch).map_err(|error| ApiError {
            code: error.code().to_string(),
            message: error.to_string(),
            retriable: matches!(
                error,
                aiwf_engine::patch::PatchError::RevisionConflict { .. }
            ),
            hint: Some(error.hint().to_string()),
        })?;

    // 交叉校验。不一致是**实现 bug**，不是用户能修的东西 ——
    // 所以不抛给用户，留一行日志给诊断包，落库以引擎算的为准
    if graph_json
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .is_some_and(|parsed| parsed != result.graph)
    {
        eprintln!(
            "[workflow.patch] 客户端与引擎算出的图不一致（工作流 {id}，rev {current}）。\
             以引擎为准；这说明 conformance 夹具漏了一种形态"
        );
    }

    let next = serde_json::to_string(&result.graph)
        .map_err(|error| ApiError::validation(format!("序列化结果图失败：{error}")))?;
    let rev = store.save_draft_guarded(&id, base_revision, &next)?;

    Ok(PatchDto {
        rev,
        diff: result.diff,
        validation: result.validation,
    })
}

/// 校验草稿（或某个历史修订）。
///
/// # Errors
/// 工作流或修订不存在时返回 NOT_FOUND。
pub fn workflow_validate(
    store: &Store,
    id: String,
    rev: Option<i64>,
) -> ApiResult<aiwf_engine::validate::ValidationResult> {
    let rev = match rev {
        Some(value) => value,
        None => store
            .draft_revision(&id)?
            .ok_or(aiwf_store::StoreError::NotFound {
                kind: "草稿",
                id: id.clone(),
            })?,
    };
    let graph_text = store
        .get_draft(&id, rev)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "草稿修订",
            id: format!("{id}@{rev}"),
        })?;
    let graph: serde_json::Value = serde_json::from_str(&graph_text)
        .map_err(|error| ApiError::validation(format!("草稿不是合法 JSON：{error}")))?;

    Ok(aiwf_engine::validate::validate_graph(&graph))
}

/// 对比两份图。`from` / `to` 可以是版本 id，也可以是字面量 `draft`。
///
/// # Errors
/// 任一侧解析不出图时返回 VALIDATION。
pub fn workflow_diff(
    store: &Store,
    id: String,
    from: String,
    to: String,
) -> ApiResult<aiwf_engine::patch::WorkflowDiff> {
    let 取图 = |which: &str| -> ApiResult<serde_json::Value> {
        let text = if which == "draft" {
            let rev = store
                .draft_revision(&id)?
                .ok_or(aiwf_store::StoreError::NotFound {
                    kind: "草稿",
                    id: id.clone(),
                })?;
            store
                .get_draft(&id, rev)?
                .ok_or(aiwf_store::StoreError::NotFound {
                    kind: "草稿修订",
                    id: format!("{id}@{rev}"),
                })?
        } else {
            store
                .get_version(which)?
                .ok_or(aiwf_store::StoreError::NotFound {
                    kind: "版本",
                    id: which.to_string(),
                })?
                .graph_json
        };
        serde_json::from_str(&text)
            .map_err(|error| ApiError::validation(format!("{which} 的图不是合法 JSON：{error}")))
    };

    Ok(aiwf_engine::diff::diff_graphs(&取图(&from)?, &取图(&to)?))
}

pub fn workflow_publish(store: &Store, id: String, rev: i64) -> ApiResult<PublishedDto> {
    // 发布者暂时固定为本机用户；M4 接入身份后改为真实 actor
    let published = store.publish(&id, rev, "本地用户")?;
    Ok(PublishedDto {
        version_id: published.id,
        version: published.version,
        config_hash: published.config_hash,
    })
}

/// 读某个已发布版本的完整图。回滚为草稿与版本对比都要用。
pub fn workflow_version_graph(store: &Store, version_id: String) -> ApiResult<String> {
    let version = store
        .get_version(&version_id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "版本",
            id: version_id,
        })?;
    Ok(version.graph_json)
}

/// 回滚：把某个已发布版本的图写成**新的**草稿修订。
///
/// 刻意不是「覆盖」——原草稿仍留在修订历史里，用户随时能再回来。
/// 也刻意不复用 save_draft：这一步没有结构化操作可记，
/// 用假的 Patch 去凑会往审计里写一条不存在的节点操作。
pub fn workflow_rollback(store: &Store, id: String, version_id: String) -> ApiResult<i64> {
    let version = store
        .get_version(&version_id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "版本",
            id: version_id,
        })?;
    if version.workflow_id != id {
        return Err(ApiError {
            code: "VALIDATION".into(),
            message: "这个版本不属于该工作流".into(),
            retriable: false,
            hint: None,
        });
    }
    Ok(store.save_draft(&id, &version.graph_json)?)
}

pub fn workflow_delete(store: &Store, id: String) -> ApiResult<()> {
    store.delete_workflow(&id)?;
    Ok(())
}

// ── Agent 角色 ──────────────────────────────────────────────────────────────

pub fn agent_list(
    store: &Store,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> ApiResult<Page<AgentDto>> {
    let (rows, total) =
        store.list_agents_paged(query.as_deref(), page_limit(limit), page_offset(offset))?;
    Ok(Page {
        items: rows.into_iter().map(AgentDto::from).collect(),
        total,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn agent_create(
    store: &Store,
    name: String,
    role: String,
    goal: String,
    persona: String,
    runtime: String,
    model_ref: String,
    fallback_model_ref: Option<String>,
    tools: Vec<String>,
    capabilities_json: Option<String>,
    output_contract: String,
    turn_limit: Option<i64>,
    timeout_ms: Option<i64>,
) -> ApiResult<String> {
    Ok(store.create_agent(&aiwf_store::NewAgent {
        name,
        role,
        goal,
        persona,
        runtime,
        model_ref,
        fallback_model_ref,
        tools,
        capabilities_json: capabilities_json.unwrap_or_else(|| "{}".to_string()),
        output_contract,
        turn_limit: turn_limit.unwrap_or(12),
        timeout_ms: timeout_ms.unwrap_or(900_000),
    })?)
}

/// 更新角色。版本号由存储层递增 —— 图纸的按钮就叫「保存新版本」。
/// 主管 AI 的一次会话。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSessionDto {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub updated_at: String,
    pub message_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorMessageDto {
    pub role: String,
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSessionDetail {
    pub session: SupervisorSessionDto,
    pub messages: Vec<SupervisorMessageDto>,
}

fn to_session_dto(row: aiwf_store::SupervisorSessionRow) -> SupervisorSessionDto {
    SupervisorSessionDto {
        id: row.id,
        title: row.title,
        started_at: row.started_at,
        updated_at: row.updated_at,
        message_count: row.message_count,
        workflow_id: row.workflow_id,
        run_id: row.run_id,
        model_ref: row.model_ref,
    }
}

pub fn supervisor_sessions(
    store: &Store,
    limit: Option<i64>,
) -> ApiResult<Vec<SupervisorSessionDto>> {
    Ok(store
        .list_supervisor_sessions(limit.unwrap_or(50).clamp(1, 200))?
        .into_iter()
        .map(to_session_dto)
        .collect())
}

pub fn supervisor_session(store: &Store, session_id: String) -> ApiResult<SupervisorSessionDetail> {
    let (meta, messages) = store
        .supervisor_session(&session_id)?
        .ok_or_else(|| ApiError::validation(format!("找不到会话 {session_id}")))?;

    Ok(SupervisorSessionDetail {
        session: to_session_dto(meta),
        messages: messages
            .into_iter()
            .map(|row| SupervisorMessageDto {
                role: row.role,
                text: row.text,
                at: row.at,
            })
            .collect(),
    })
}

/// Agent 角色的部分更新。字段与 [`aiwf_store::AgentPatch`] 一一对应，
/// 只是持有所有权 —— IPC 层拿到的是 `Option<String>`，借不出去。
#[derive(Debug, Default, Clone)]
pub struct AgentEdit {
    pub name: Option<String>,
    pub goal: Option<String>,
    pub persona: Option<String>,
    pub model_ref: Option<String>,
    pub fallback_model_ref: Option<String>,
    /// 能力声明（JSON）。引擎按它拦截，所以它必须可改 ——
    /// 只拦不让改的话，那条拦截就只会挡人、不会放行。
    pub capabilities_json: Option<String>,
    pub tools: Option<Vec<String>>,
    pub output_contract: Option<String>,
}

pub fn agent_update(
    store: &Store,
    id: String,
    base_ver: i64,
    edit: AgentEdit,
) -> ApiResult<VerOnly> {
    let ver = store.update_agent(
        &id,
        base_ver,
        &aiwf_store::AgentPatch {
            name: edit.name.as_deref(),
            goal: edit.goal.as_deref(),
            persona: edit.persona.as_deref(),
            model_ref: edit.model_ref.as_deref(),
            fallback_model_ref: edit.fallback_model_ref.as_deref(),
            capabilities_json: edit.capabilities_json.as_deref(),
            tools: edit.tools.as_deref(),
            output_contract: edit.output_contract.as_deref(),
        },
    )?;
    Ok(VerOnly { ver })
}

pub fn agent_duplicate(store: &Store, id: String, name: String) -> ApiResult<String> {
    Ok(store.duplicate_agent(&id, &name)?)
}

pub fn agent_delete(store: &Store, id: String) -> ApiResult<()> {
    store.delete_agent(&id)?;
    Ok(())
}

// ── 提示词库 ────────────────────────────────────────────────────────────────

pub fn prompt_list(
    store: &Store,
    group: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> ApiResult<Page<PromptDto>> {
    let (rows, total) = store.list_prompts_paged(
        group.as_deref(),
        query.as_deref(),
        page_limit(limit),
        page_offset(offset),
    )?;
    Ok(Page {
        items: rows.into_iter().map(PromptDto::from).collect(),
        total,
    })
}

pub fn prompt_create(
    store: &Store,
    group: String,
    name: String,
    sections_json: String,
    vars_json: Option<String>,
) -> ApiResult<String> {
    Ok(store.create_prompt(&aiwf_store::NewPrompt {
        group,
        name,
        sections_json,
        vars_json: vars_json.unwrap_or_else(|| "[]".to_string()),
    })?)
}

/// 列表的一页 + 总数。界面靠 total 画分页控件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    /// 满足筛选条件的总条数，不是这一页的条数。
    pub total: i64,
}

/// `{ ver }` —— agent.update / prompt.update 的返回形状。
///
/// 保存成功后界面要立刻拿到新版本号做下一次乐观锁，
/// 不回传的话它只能再查一次列表，而那中间又有一个可被别人插队的窗口。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerOnly {
    pub ver: i64,
}

/// 更新提示词，返回新版本号。
///
/// `base_ver` 是乐观锁：运行记录引用的是具体版本号，同一个 ver 前后
/// 指向两份不同的正文，历史结果就再也解释不清了。
pub fn prompt_update(
    store: &Store,
    id: String,
    base_ver: i64,
    name: Option<String>,
    sections_json: Option<String>,
    vars_json: Option<String>,
    changed_by: Option<String>,
) -> ApiResult<VerOnly> {
    let ver = store.update_prompt(
        &id,
        base_ver,
        name.as_deref(),
        sections_json.as_deref(),
        vars_json.as_deref(),
        changed_by.as_deref(),
    )?;
    Ok(VerOnly { ver })
}

/// 一条提示词的历史版本。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersionDto {
    pub ver: i64,
    pub name: String,
    /// 分段的 JSON 原文。界面自己解析 —— 引擎不需要理解它的结构。
    pub sections_json: String,
    pub vars_json: String,
    pub changed_by: String,
    pub created_at: String,
}

/// 图纸「06 提示词库」版本页。只返回**历史**版本，当前那份在 prompt.list 里。
pub fn prompt_versions(store: &Store, prompt_id: String) -> ApiResult<Vec<PromptVersionDto>> {
    Ok(store
        .prompt_versions(&prompt_id)?
        .into_iter()
        .map(|row| PromptVersionDto {
            ver: row.ver,
            name: row.name,
            sections_json: row.sections_json,
            vars_json: row.vars_json,
            changed_by: row.changed_by.unwrap_or_else(|| "你".to_string()),
            created_at: row.created_at,
        })
        .collect())
}

pub fn prompt_duplicate(store: &Store, id: String, name: String) -> ApiResult<String> {
    Ok(store.duplicate_prompt(&id, &name)?)
}

pub fn prompt_delete(store: &Store, id: String) -> ApiResult<()> {
    store.delete_prompt(&id)?;
    Ok(())
}

// ── 记忆 ────────────────────────────────────────────────────────────────────

pub fn memory_list(
    store: &Store,
    scope: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> ApiResult<Page<MemoryDto>> {
    let (rows, total) = store.list_memories_paged(
        scope.as_deref(),
        query.as_deref(),
        page_limit(limit),
        page_offset(offset),
    )?;
    Ok(Page {
        items: rows.into_iter().map(MemoryDto::from).collect(),
        total,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn memory_create(
    store: &Store,
    scope: String,
    scope_id: Option<String>,
    key: String,
    value: String,
    source: Option<String>,
    created_by: Option<String>,
    tags: Vec<String>,
) -> ApiResult<String> {
    Ok(store.create_memory(&aiwf_store::NewMemory {
        scope,
        scope_id,
        key,
        value,
        summary: None,
        source: source.unwrap_or_else(|| "user".to_string()),
        created_by: created_by.unwrap_or_else(|| "本地用户".to_string()),
        sensitivity: "internal".to_string(),
        tags,
    })?)
}

/// 更新记忆。`baseVer` 是乐观锁 —— 落后的版本会被拒绝，
/// 否则 AI 通过 MCP 的写入会悄悄覆盖用户刚改的内容。
pub fn memory_update(
    store: &Store,
    id: String,
    base_ver: i64,
    value: Option<String>,
    tags: Option<Vec<String>>,
) -> ApiResult<()> {
    store.update_memory(&id, base_ver, value.as_deref(), tags.as_deref())?;
    Ok(())
}

/// 启用 / 停用。停用是比删除更轻的一档：先停掉看看有没有影响。
pub fn memory_toggle(store: &Store, id: String, enabled: bool) -> ApiResult<()> {
    store.set_memory_enabled(&id, enabled)?;
    Ok(())
}

pub fn memory_delete(store: &Store, id: String) -> ApiResult<()> {
    store.delete_memory(&id)?;
    Ok(())
}

// ── 主管 AI ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorAnswer {
    pub text: String,
    pub tool_calls: u32,
    /// 这轮对话有没有进历史。落库失败时答案照给，但要说出来。
    pub history_saved: bool,
    /// 这轮所属的会话。界面据此把后续问题接到同一条。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// AI 想做的改动。界面据此算 Diff，用户确认后才落草稿。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<Proposal>,
}

/// 问主管 AI。走与 AI 节点同一套 ACP 客户端。
///
/// 上下文由调用方显式给：把「当前草稿 rev、正在看的运行」这些
/// 拼进提示词，而不是让模型自己去猜或去查 —— 猜错的话它的回答
/// 会基于一个不存在的状态，而用户看不出来。
pub fn supervisor_ask(
    store: &Store,
    data_dir: &std::path::Path,
    question: String,
    context_json: Option<String>,
    session_id: Option<String>,
) -> ApiResult<SupervisorAnswer> {
    // 要提结构化改动就得先看得见当前的图 ——
    // 让模型凭空造 nodeId 的话，那些操作应用不到任何东西上
    let context_graph = context_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|value| {
            value
                .get("workflowId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .and_then(|workflow_id| {
            let rev = store.draft_revision(&workflow_id).ok().flatten()?;
            store.get_draft(&workflow_id, rev).ok().flatten()
        });

    use aiwf_engine::acp::{AcpClient, SessionUpdate, adapter_installed, env_to_remove};

    // 优先 codex：这个应用本身跑在 Claude Code 里开发，用 claude 的 adapter
    // 会与开发环境互相干扰（嵌套的 agent 会话、共用的登录态、同一份配额）。
    // 「尽可能」不是「绝不」—— 只装了 claude 的机器上仍然能用
    let installed: Vec<&str> = ACP_RUNTIMES
        .iter()
        .copied()
        .filter(|rt| adapter_installed(rt).is_some())
        .collect();
    let runtime = preferred_acp_runtime(&installed).unwrap_or("acp.codex");
    let Some(command) = adapter_installed(runtime) else {
        return Err(ApiError {
            code: "VALIDATION".to_string(),
            message: format!(
                "{runtime} 的 adapter 没有安装。主管 AI 需要它才能工作 ——\
                 在「设置与环境」里能看到怎么装"
            ),
            retriable: false,
            hint: None,
        });
    };

    // 把系统 MCP 接给它。
    //
    // 这是「主管 AI 能真的操作这个系统」的那一环。不接的话它只能凭
    // 提示词里的文字描述工作：读不到当前有哪些工作流、改不动草稿、
    // 也查不到那次运行到底停在哪一步 —— 于是只能建议用户自己去点。
    //
    // 令牌走 Authorization 头而不是 URL：这条 URL 会出现在 adapter 的
    // 日志与错误信息里。
    let mcp = system_mcp_server(data_dir);

    // 把上下文与可注入的记忆拼进提示词。
    // 记忆只取启用且未过期的（memories_for_injection 保证这一点）
    let memories = store
        .memories_for_injection("workspace", None)
        .unwrap_or_default();
    let prompt = supervisor_prompt(
        &question,
        &memories
            .iter()
            .map(|m| (m.key.clone(), m.value.clone()))
            .collect::<Vec<_>>(),
        context_json
            .as_deref()
            .filter(|c| *c != "{}" && !c.is_empty()),
        context_graph.as_deref(),
        if mcp.is_empty() {
            SupervisorTools::None
        } else {
            SupervisorTools::SystemMcp
        },
    );

    let mut client = AcpClient::connect(
        &command,
        &[],
        &env_to_remove(runtime),
        std::time::Duration::from_secs(180),
    )
    .map_err(|error| ApiError {
        code: "EXTERNAL".to_string(),
        message: format!("连不上 adapter：{error}"),
        retriable: true,
        hint: None,
    })?;

    let session = client
        .new_session_with_mcp(&data_dir.display().to_string(), mcp.as_slice())
        .map_err(|error| ApiError {
            code: "EXTERNAL".to_string(),
            message: format!("建会话失败：{error}"),
            retriable: true,
            hint: None,
        })?;

    let mut text = String::new();
    let mut tool_calls = 0_u32;

    client
        .prompt(&session.id, &prompt, |update| match update {
            SessionUpdate::AgentText { text: chunk } => text.push_str(chunk),
            SessionUpdate::ToolCall { .. } => tool_calls += 1,
            _ => {}
        })
        .map_err(|error| ApiError {
            code: "EXTERNAL".to_string(),
            message: format!("主管 AI 失败：{error}"),
            retriable: true,
            hint: None,
        })?;

    let (text, proposal) = extract_proposal(&text);

    // 落会话。不存的话每次关掉抽屉对话就没了 ——
    // 而用户常常是隔天回来接着问「上次它说那个来着」。
    //
    // 存失败**不丢答案**：用户已经等了几十秒，拿不到答案比丢掉历史糟得多。
    // 但也不能假装成功 —— 他隔天回来找不到这条对话会以为是自己记错了。
    // 所以答案照给，把「没存住」放进返回值里说出来。
    let mut history_saved = true;
    let session = session_id.or_else(|| {
        let workflow_id = context_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
            .and_then(|value| {
                value
                    .get("workflowId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            });
        match store.create_supervisor_session(&question, workflow_id.as_deref(), None) {
            Ok(id) => Some(id),
            Err(error) => {
                eprintln!("[supervisor] 建会话失败，这轮对话不会进历史：{error}");
                history_saved = false;
                None
            }
        }
    });

    match &session {
        Some(id) => {
            for (role, body) in [("user", &question), ("agent", &text)] {
                if let Err(error) = store.append_supervisor_message(id, role, body) {
                    eprintln!("[supervisor] 存 {role} 消息失败：{error}");
                    history_saved = false;
                }
            }
        }
        // 会话没建起来时消息无处可放 —— 上面已经标过了
        None => history_saved = false,
    }

    Ok(SupervisorAnswer {
        text,
        tool_calls,
        proposal,
        session_id: session,
        history_saved,
    })
}

/// 丢弃从没被用过的空草稿。判断在存储层。
pub fn workflow_discard_if_empty(store: &Store, id: String) -> ApiResult<DiscardResult> {
    Ok(DiscardResult {
        discarded: store.discard_if_empty(&id)?,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardResult {
    pub discarded: bool,
}

pub fn workflow_rename(store: &Store, id: String, name: String) -> ApiResult<()> {
    store.rename_workflow(&id, &name)?;
    Ok(())
}

/// 主管 AI 提议的一组改动。
///
/// 只是**提议** —— 界面据此算 Diff 给用户看，确认后才走 workflow.patch
/// 落草稿。那一步有 baseRevision 守卫，且必须由用户触发。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    /// Diff 上面那句话 —— 用户判断要不要接受的依据。
    pub summary: String,
    /// 原样透传给前端；完整校验由契约的 Zod 做，这里只认 op 名。
    pub operations: Vec<serde_json::Value>,
}

/// 契约里的操作名。
///
/// Rust 侧只做**最小校验**（op 名已知、结构完整），完整校验在契约的 Zod 里 ——
/// 在 Rust 里镜像 12 种 op 的完整结构等于维护第二份契约，而那必然漂移。
/// 这个名单由 contract_sync_test 对着生成物守着。
pub fn patch_ops() -> &'static [&'static str] {
    &PATCH_OPS
}

const PATCH_OPS: [&str; 12] = [
    "addNode",
    "removeNode",
    "renameNode",
    "moveNode",
    "setConfig",
    "setJoin",
    "setCapabilities",
    "setRetry",
    "connect",
    "disconnect",
    "createGroup",
    "deleteGroup",
];

/// 主管 AI 用来包裹提议的围栏标记。
///
/// 用专门的标记而不是普通的 ```json：用户问「这个节点配置长什么样」时
/// 模型会贴一段 JSON，那是解释不是要改东西。
const PROPOSAL_FENCE: &str = "```aiwf-proposal";

/// 从模型的回答里抠出结构化提议，并把那段围栏从展示文本里去掉。
///
/// 返回 `(给用户看的文本, 提议)`。抠不出来时提议为 None ——
/// **不报错**：模型偶尔会写出不合法的 JSON，整个回答因此失败的话，
/// 用户连那句自然语言解释都看不到，而那句往往是有用的。
pub fn extract_proposal(answer: &str) -> (String, Option<Proposal>) {
    let Some(start) = answer.find(PROPOSAL_FENCE) else {
        return (answer.to_string(), None);
    };
    let body_start = start + PROPOSAL_FENCE.len();
    let Some(end_offset) = answer[body_start..].find("```") else {
        return (answer.to_string(), None);
    };
    let body = &answer[body_start..body_start + end_offset];

    // 无论解析成不成功，那段围栏都要从展示文本里去掉 ——
    // 用户看的是 Diff，不是 JSON
    let mut text = String::with_capacity(answer.len());
    text.push_str(&answer[..start]);
    text.push_str(&answer[body_start + end_offset + 3..]);
    let text = text.trim().to_string();

    (text, parse_proposal(body))
}

fn parse_proposal(body: &str) -> Option<Proposal> {
    let value: serde_json::Value = serde_json::from_str(body.trim()).ok()?;

    let summary = value.get("summary")?.as_str()?.trim().to_string();
    if summary.is_empty() {
        return None;
    }

    let operations = value.get("operations")?.as_array()?;
    // 空列表不算提议：那会让用户看到一个没内容的 Diff
    if operations.is_empty() {
        return None;
    }

    // 有一个操作不合契约就整个作废。半个能用的提议比没有更危险：
    // 用户看到 Diff 少了一半却以为那就是全部
    let all_known = operations.iter().all(|op| {
        op.get("op")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|name| PATCH_OPS.contains(&name))
    });
    if !all_known {
        return None;
    }

    Some(Proposal {
        summary,
        operations: operations.clone(),
    })
}

/// 诊断包导出的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsResult {
    pub path: String,
    pub bytes: u64,
}

/// 导出一次运行的诊断包。
///
/// M5 的出口标准写着「诊断包不含 Secret」—— 那是这个功能存在的全部理由：
/// 用户要把失败现场发给别人看，而手工整理必然会漏掉某处的 token。
///
/// 内容是运行本身 + 完整事件流 + 环境报告。环境那部分是因为
/// 「在我机器上是好的」是最常见的一类原因，而让用户手工贴版本号必然漏。
///
/// **一切文本都过脱敏器**，包括启动参数 —— inputs 是用户自己填的，
/// 里面可能就有 token，而启动表单不拦这个。
pub fn run_diagnostics(
    store: &Store,
    out_dir: &Path,
    run_id: String,
) -> ApiResult<DiagnosticsResult> {
    let run = store.get_run(&run_id)?.ok_or_else(|| {
        // 导出一个空包的话，读的人会以为「这次运行什么都没发生」
        ApiError::validation(format!("找不到运行 {run_id}"))
    })?;

    let redactor = aiwf_engine::redactor::Redactor::with_defaults();

    // 事件流整段拉出来 —— 诊断包的价值就在于完整，分页在这里没有意义
    let mut events = Vec::new();
    let mut from_seq = 0_i64;
    loop {
        let page = store.events(&run_id, from_seq, 500)?;
        if page.is_empty() {
            break;
        }
        from_seq = page.last().map_or(from_seq, |event| event.seq);
        for event in page {
            events.push(serde_json::json!({
                "seq": event.seq,
                "ts": event.ts,
                "type": event.kind,
                "nodeId": event.node_id,
                "nodeLabel": event.node_label,
                "actor": event.actor,
                "summary": redactor.redact(&event.summary),
            }));
        }
    }

    let environment = env::env_health(false)?;

    // 产物只列元信息，不含内容。
    //
    // 内容可能有几十 MB，也可能有脚本 echo 出来的 token —— stdout 走的是
    // artifact 而不是事件摘要，事件那层的脱敏管不到它。
    // 名字、大小与哈希足够定位问题；真要看内容，界面里有预览。
    let artifacts = run
        .workdir
        .as_deref()
        .filter(|dir| !dir.is_empty())
        .map(|dir| {
            aiwf_engine::artifacts::ArtifactStore::new(
                std::path::Path::new(dir).join(".aiwf-artifacts"),
            )
        })
        .and_then(|store| store.list(&run_id).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            serde_json::json!({
                "nodeId": item.node_id,
                "name": item.name,
                "kind": item.kind,
                "bytes": item.bytes,
                "sha256": item.sha256,
            })
        })
        .collect::<Vec<_>>();

    let bundle = serde_json::json!({
        "kind": "aiwf-diagnostics",
        "version": 1,
        "note": "所有文本已过脱敏器；Secret 只以 keychain:// 引用形式出现",
        "run": {
            "id": run.id,
            "workflowId": run.workflow_id,
            "status": run.status,
            "startedAt": run.started_at,
            "endedAt": run.ended_at,
            "currentNode": run.current_node,
            // inputs 是用户填的，里面可能就有 token
            "inputs": redactor.redact(&run.inputs_json),
        },
        "events": events,
        "artifacts": artifacts,
        "environment": environment,
    });

    let text = serde_json::to_string_pretty(&bundle)
        .map_err(|error| ApiError::validation(format!("诊断包序列化失败：{error}")))?;

    // 最后一道：整段再扫一遍。上面逐字段脱敏可能漏掉某个我没想到的字段，
    // 而这个包是要发出去的
    let text = redactor.redact(&text);

    std::fs::create_dir_all(out_dir)
        .map_err(|error| ApiError::validation(format!("建不了输出目录：{error}")))?;
    let path = out_dir.join(format!("{run_id}-diagnostics.json"));
    std::fs::write(&path, &text)
        .map_err(|error| ApiError::validation(format!("写不了诊断包：{error}")))?;

    Ok(DiagnosticsResult {
        path: path.display().to_string(),
        bytes: text.len() as u64,
    })
}

/// 环境诊断包 —— 图纸「06 首次安装与检测」与「05 设置与环境」的「导出脱敏报告」。
///
/// 那两屏都还没有任何一次运行，所以 `run_diagnostics`（要 run_id）用不上。
/// 与它共用同一个 Redactor：用户要把环境情况发给别人看，
/// 而手工整理必然会漏掉某处的 token —— 路径里的用户名、
/// CLI 登录态里的账号，都是这么漏出去的。
pub fn env_diagnostics(out_dir: &Path) -> ApiResult<DiagnosticsResult> {
    let redactor = aiwf_engine::redactor::Redactor::with_defaults();
    let environment = env::env_health(false)?;

    let bundle = serde_json::json!({
        "kind": "aiwf-env-diagnostics",
        "version": 1,
        "note": "所有文本已过脱敏器；Secret 只以 keychain:// 引用形式出现",
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "environment": environment,
    });

    let text = serde_json::to_string_pretty(&bundle)
        .map_err(|error| ApiError::validation(format!("诊断包序列化失败：{error}")))?;
    // 与 run_diagnostics 同一道最后防线：整段再扫一遍
    let text = redactor.redact(&text);

    std::fs::create_dir_all(out_dir)
        .map_err(|error| ApiError::validation(format!("建不了输出目录：{error}")))?;
    let path = out_dir.join("env-diagnostics.json");
    std::fs::write(&path, &text)
        .map_err(|error| ApiError::validation(format!("写不了诊断包：{error}")))?;

    Ok(DiagnosticsResult {
        path: path.display().to_string(),
        bytes: text.len() as u64,
    })
}

/// 回到最近审批点的结果。
#[derive(Debug)]
pub struct RewindResult {
    pub run_id: String,
    pub node_id: String,
}

impl Serialize for RewindResult {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("RewindResult", 2)?;
        state.serialize_field("runId", &self.run_id)?;
        state.serialize_field("nodeId", &self.node_id)?;
        state.end()
    }
}

/// 回到最近的审批点重新选择 —— 图纸失败横幅的第二个按钮。
///
/// 用户在审批那一步选错了（批准了一个不该批的 Diff），后面才发现。
/// `run_resume` 没用 —— 它沿用同一个决定继续往下；「用相同参数重跑」
/// 又会把前面几十分钟的工作全丢掉。
///
/// 开的是一条**新运行**，原来那条留在记录里：两次的事件流可以对照着看，
/// 那正是可解释性要回答的「这次为什么不一样」。
pub fn run_rewind_to_approval(store: &Store, run_id: String) -> ApiResult<RewindResult> {
    let run = store
        .get_run(&run_id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "运行",
            id: run_id.clone(),
        })?;

    let checkpoint = store.latest_approval_checkpoint(&run_id)?.ok_or_else(|| {
        // 界面上给一个按下去什么都不会发生的按钮，比不给按钮更糟
        ApiError::validation(format!("运行 {run_id} 没有经过任何审批点，无处可回"))
    })?;

    let node_id = checkpoint
        .pending_approval_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|value| {
            value
                .get("nodeId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| ApiError::validation("检查点里没有记下是哪个节点在等审批".to_string()))?;

    let new_run = store.create_run_in(
        &run.workflow_id,
        run.version_id.as_deref(),
        run.draft_rev,
        &run.inputs_json,
        run.workdir.as_deref(),
    )?;

    Ok(RewindResult {
        run_id: new_run,
        node_id,
    })
}

/// 这一轮主管 AI 有没有工具。
///
/// 不是装饰性的参数：有没有工具是两种完全不同的工作方式，
/// 提示词说错哪一边都会坏事 —— 说有而实际没有，它会「调用 workflow_list」
/// 然后凭空编一份清单；说没有而实际有，它会一路建议用户自己去点，
/// 而它本可以做完。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorTools {
    /// 接上了系统 MCP，能直接操作这个应用。
    SystemMcp,
    /// 没有工具，只能基于给定的上下文回答。
    None,
}

/// 系统 MCP 的接入声明，交给 ACP 会话。
///
/// 服务没起来时返回空 —— 那时 agent 仍然能对话，只是没有工具，
/// 而提示词会照实说「这次没有工具可用」。给它一个连不上的地址
/// 只会让它在每次工具调用上白等一轮超时。
#[must_use]
pub fn system_mcp_server(data_dir: &std::path::Path) -> Vec<aiwf_engine::acp::McpHttpServer> {
    let Ok(config) = mcp_config::load_or_create(data_dir) else {
        return Vec::new();
    };
    if !mcp_alive(config.port, &config.token) {
        return Vec::new();
    }

    vec![aiwf_engine::acp::McpHttpServer {
        name: mcp_clients::SERVER_NAME.to_string(),
        url: format!("http://127.0.0.1:{}/mcp", config.port),
        headers: vec![(
            "Authorization".to_string(),
            format!("Bearer {}", config.token),
        )],
    }]
}

/// 主管 AI 的提示词。
///
/// **应用说明必须在最前面**。codex 自主体验时问「怎么创建并运行一个最简单的
/// 工作流」，模型回答「目前我对这个应用一无所知」，要求放开 `ls`、
/// 提供项目路径或截图 —— 因为提示词里一个字都没提这个应用是什么。
///
/// 而抽屉顶上写着「掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置」。
/// 界面上承诺了却不存在的能力比没有更糟：用户会以为是自己没说清，
/// 换个说法再问一遍，几轮之后开始怀疑别的提示是不是也是假的。
pub fn supervisor_prompt(
    question: &str,
    memories: &[(String, String)],
    context_json: Option<&str>,
    graph_json: Option<&str>,
    tools: SupervisorTools,
) -> String {
    let mut prompt = String::from(
        "你是 AI Workflows 这个桌面应用里的主管 AI。用户正在使用它，\
         你的任务是帮他把事情办成：回答关于**这个应用**的问题、设计与修改工作流、\
         起运行、读运行数据找出问题在哪。\
         \n\n\
         这个应用是什么：一个本地优先的 AI 工作流编排工具。用户在画布上搭出\
         由节点组成的流程（入口、Shell/Python 脚本、AI 分析/审查/决策/执行、\
         分支、汇聚、审批、子工作流、MCP 工具、结束等），然后运行它；\
         每次运行的全过程以事件流记录下来，可回放、可解释。\
         \n\n\
         用户能去的每一屏：\n\
         - **工作流**（首页）：全部工作流的列表，能新建、导入、搜索、按状态筛选\n\
         - **画布编辑器**：拖节点、连线、配置节点、保存草稿、发布版本、发起运行\n\
         - **执行记录**：每次运行的事件流、产物、对话；失败时能从失败节点重试、\
         回到最近审批点改选择、用相同参数重跑、导出诊断包\n\
         - **记忆**：会被注入后续每一次 AI 调用的长期上下文，可停用或删除\n\
         - **Agent 角色**：Agent 的目标、人设、可用工具、权限与模型\n\
         - **提示词库**：分段的提示词模板与变量，按版本保存\n\
         - **模型**：已登记的模型与它们的运行时、上下文窗口、能力\n\
         - **设置与环境**：依赖工具的健康检查、权限策略、MCP 接入\n\
         \n\
         几个必须分清的概念：\n\
         - **草稿**（rev，单调递增）是可变的编辑现场，改它不影响正在跑的东西\n\
         - **版本**（v，不可变快照，带 config_hash）是发布出来的；\
         运行永远引用某个版本或某个草稿修订，所以改草稿不会影响运行中的版本\n\
         - **结构化 Patch** 是唯一的写入形态：只接受 addNode / connect / setConfig \
         这类操作，刻意没有「整份回写」—— 那会绕过版本守卫与 Diff\n\
         - **运行状态只有一份真源**：事件流。对话、节点进度、产物、\
         「为什么这么做」的证据全是同一条流的不同投影\n\
         \n",
    );

    // 有没有工具，是两种完全不同的工作方式 —— 提示词必须说对。
    //
    // 说有而实际没有：它会「调用 workflow_list」然后凭空编一份清单出来。
    // 说没有而实际有：它会一路建议用户「你去点这里」，而它本可以自己做完。
    // 后者正是这条提示词长期的样子。
    match tools {
        SupervisorTools::SystemMcp => prompt.push_str(
            "\n**你接着这个应用的系统 MCP，能直接操作它。** 工具名形如 \
             workflow_list / workflow_get / workflow_patch / workflow_validate / \
             run_dry_run / run_start / run_events / memory_create。\
             \n\n\
             动手之前先读这几份资源，别靠猜：\n\
             - `aiwf://guide/build-and-run`：设计并跑通一条工作流该按什么顺序调哪个工具\n\
             - `aiwf://catalog/nodes`：16 种节点的端口与配置字段（连线的 port 必须来自这里）\n\
             - `aiwf://workspace/inventory`：现在有哪些 Agent 角色和模型\
             （AI 节点的 agentProfileId 必须来自这里，编一个会在 Dry Run 才暴露）\n\
             - `aiwf://guide/read-run-data`：一次运行的数据分别从哪来\n\
             \n\
             几条硬要求：\n\
             1. 改图走 workflow_patch，一次把该改的都带上 —— 分很多次发，\
             中间任何一次失败都会留下半张图\n\
             2. 每次 patch 都要带当前的 baseRevision。不符会返回 REVISION_CONFLICT，\
             那时重新 workflow_get 再基于新 rev 重来，别硬试\n\
             3. Dry Run 没过就别起运行 —— 起了也是当场失败，还多一条脏记录\n\
             4. 起了运行之后要**读事件流确认它真的跑通了**，别只说「已发起」\n\
             \n\
             写操作是否需要用户先确认，取决于「设置与环境」里的权限档。\
             被挡住时工具会告诉你，那时把「在等什么」说给用户听，别反复重试。\n",
        ),
        SupervisorTools::None => prompt.push_str(
            "\n**这次没有工具可用**（系统 MCP 没在跑，或者这个 adapter 不支持）。\
             所以你只能基于下面给出的上下文回答，并告诉用户该去点哪里 ——\
             不要说「我来帮你查一下」然后编一个结果出来。\
             要恢复工具，去「设置与环境 · MCP 与集成」看服务起没起来。\n",
        ),
    }

    prompt.push_str(
        "\n回答用中文，简短、具体。做过的事说清楚做了什么、结果是什么；\
         做不到的事直说做不到。你看不到用户的屏幕，也不需要看。\n\n",
    );

    if !memories.is_empty() {
        prompt.push_str("已知的长期上下文：\n");
        for (key, value) in memories.iter().take(20) {
            prompt.push_str(&format!("- {key}：{value}\n"));
        }
        prompt.push('\n');
    }

    if let Some(context) = context_json {
        prompt.push_str(&format!("当前界面状态：{context}\n\n"));
    }

    // 教它怎么提改动。不说的话它只会用自然语言描述「你可以加一个审批节点」——
    // 那没法出 Diff，用户还得自己动手照做一遍。
    //
    // 用专门的围栏标记而不是 ```json：用户问「这个节点配置长什么样」时
    // 模型会贴一段 JSON，那是解释，不是要改东西
    if let Some(graph) = graph_json {
        prompt.push_str(
            "要修改这条工作流时，除了用自然语言说明，还要附一段提议：\n\n\
             ```aiwf-proposal\n\
             {\"summary\": \"一句话说清这次改了什么\", \"operations\": [ … ]}\n\
             ```\n\n\
             operations 里每一项的 op 只能是：",
        );
        prompt.push_str(&PATCH_OPS.join("、"));
        prompt.push_str(
            "。\n改动不会直接生效 —— 用户会先看到 Diff，确认后才写进草稿。\n\n当前草稿的图：\n",
        );
        prompt.push_str(graph);
        prompt.push_str("\n\n");
    }

    prompt.push_str(question);
    prompt
}

/// 模型连通性测试的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTestResult {
    pub ok: bool,
    pub latency_ms: i64,
    pub detail: String,
}

/// 测一个模型现在能不能用 —— 图纸「07 模型」的「测试连通性」。
///
/// 只做**握手 + 建会话**，不发提示词：那样快、不花钱，而且已经足以回答
/// 「这个模型现在能不能用」。握不上手的原因（adapter 没装、版本不匹配、
/// 没登录）正是用户需要知道的。
///
/// adapter 没装**不算错误**：那是最常见的情况，用户需要的是「装什么」，
/// 不是一个红色的异常。所以它走 ok=false 而不是 Err。
pub fn model_test(store: &Store, id: String) -> ApiResult<ModelTestResult> {
    use aiwf_engine::acp::{AcpClient, env_to_remove};

    let model = store
        .get_model(&id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "模型",
            id: id.clone(),
        })?;

    let started = std::time::Instant::now();
    let 结果 = probe_runtime(&model.runtime, |command| {
        let mut client = AcpClient::connect(
            command,
            &[],
            &env_to_remove(&model.runtime),
            std::time::Duration::from_secs(30),
        )
        .map_err(|error| format!("连不上 adapter：{error}"))?;

        let session = client
            .new_session(&std::env::temp_dir().display().to_string())
            .map_err(|error| format!("握手成功但建会话失败：{error}"))?;

        Ok(format!(
            "握手成功 · 协议 v{} · 会话已建立（{} 个权限档）",
            client.protocol_version(),
            session.modes.len()
        ))
    });
    let latency_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);

    // 失败也记：用户看到一个停在上周的延迟会以为现在还是那么快
    store.set_model_latency(&id, latency_ms)?;

    Ok(match 结果 {
        Ok(detail) => ModelTestResult {
            ok: true,
            latency_ms,
            detail,
        },
        Err(detail) => ModelTestResult {
            ok: false,
            latency_ms,
            detail,
        },
    })
}

/// 找到运行时对应的 adapter 再跑探测。找不到时给出可照做的说明。
fn probe_runtime(
    runtime: &str,
    probe: impl FnOnce(&str) -> std::result::Result<String, String>,
) -> std::result::Result<String, String> {
    use aiwf_engine::acp::{adapter_command, adapter_installed};

    if adapter_command(runtime).is_none() {
        return Err(format!(
            "{runtime} 不是 ACP 运行时，连通性测试只支持 ACP（acp.claude / acp.codex）"
        ));
    }
    let Some(command) = adapter_installed(runtime) else {
        return Err(format!(
            "{runtime} 的 adapter 没有安装。在「设置与环境」里能看到怎么装"
        ));
    };
    probe(&command)
}

/// 一条待用户确认的 MCP 写操作。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationDto {
    pub id: String,
    pub tool: String,
    pub input_json: String,
    pub created_at: String,
}

/// 确认的当前状态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmStatusDto {
    pub status: String,
}

/// 没人理的写操作多久算过期。
///
/// **默认拒绝**：三分钟没人理，多半是用户根本不在电脑前，
/// 而一条写操作在几小时后突然生效比它没生效糟得多。
const CONFIRM_TTL_SECS: i64 = 180;

/// MCP 提交一条待确认的写操作。
pub fn mcp_request_confirm(store: &Store, tool: String, input_json: String) -> ApiResult<String> {
    // 顺手清理过期的：没有后台定时器，就在每次有人碰这张表时收拾一下
    store.expire_confirmations(CONFIRM_TTL_SECS)?;
    Ok(store.create_confirmation(&tool, &input_json)?)
}

/// MCP 侧轮询结果。
pub fn mcp_confirm_status(store: &Store, id: String) -> ApiResult<ConfirmStatusDto> {
    store.expire_confirmations(CONFIRM_TTL_SECS)?;
    let row = store
        .get_confirmation(&id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "确认",
            id: id.clone(),
        })?;
    Ok(ConfirmStatusDto { status: row.status })
}

/// 应用轮询待确认队列。
pub fn mcp_pending_confirms(store: &Store) -> ApiResult<Vec<ConfirmationDto>> {
    store.expire_confirmations(CONFIRM_TTL_SECS)?;
    Ok(store
        .pending_confirmations()?
        .into_iter()
        .map(|row| ConfirmationDto {
            id: row.id,
            tool: row.tool,
            input_json: row.input_json,
            created_at: row.created_at,
        })
        .collect())
}

/// 用户的决定。
pub fn mcp_decide_confirm(store: &Store, id: String, approved: bool) -> ApiResult<()> {
    store.decide_confirmation(&id, approved)?;
    Ok(())
}

/// 已知的 ACP 运行时，**按偏好排序**。
pub const ACP_RUNTIMES: &[&str] = &["acp.codex", "acp.claude"];

/// 从装好的这些里挑一个用。
///
/// 优先 codex：这个应用本身跑在 Claude Code 里开发，用 claude 的 adapter
/// 做测试会与开发环境互相干扰 —— 嵌套的 agent 会话、共用的登录态、
/// 同一份配额。写死用 claude 的话，一跑测试就把开发会话搅乱。
///
/// 「尽可能」不是「绝不」：只装了 claude 的机器上仍然要能用。
#[must_use]
pub fn preferred_acp_runtime<'a>(installed: &[&'a str]) -> Option<&'a str> {
    for preferred in ACP_RUNTIMES {
        if let Some(found) = installed.iter().find(|rt| *rt == preferred) {
            return Some(found);
        }
    }
    installed.first().copied()
}

// ── 系统 MCP 的接线 ─────────────────────────────────────────────────────────

/// 一个客户端的接入情况。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientDto {
    pub id: String,
    pub label: String,
    pub cli_installed: bool,
    pub connected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatusDto {
    pub running: bool,
    /// 写进客户端配置的那个地址，**带令牌**。界面上默认打码。
    pub url: String,
    /// 不带令牌的端点，配合 Authorization 头用。
    pub endpoint: String,
    pub port: i64,
    pub tool_count: i64,
    pub resource_count: i64,
    pub clients: Vec<McpClientDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectDto {
    pub ok: bool,
    pub detail: String,
    pub command: String,
}

/// 系统 MCP 现在是什么状态。
///
/// `running` 是**真的探一次**，不是「配置文件在就算跑着」——
/// 后者会让用户对着一个「运行中」却连不上的服务查半天。
///
/// # Errors
/// 配置读不出来（目录不可写之类）时返回 Err。
pub fn mcp_status(
    data_dir: &std::path::Path,
    tool_count: i64,
    resource_count: i64,
) -> ApiResult<McpStatusDto> {
    let config = mcp_config::load_or_create(data_dir).map_err(ApiError::validation)?;

    let clients = [mcp_clients::Client::Claude, mcp_clients::Client::Codex]
        .into_iter()
        .map(|client| McpClientDto {
            id: client.cli().to_string(),
            label: client.label().to_string(),
            cli_installed: client.installed(),
            connected: mcp_clients::connected(client),
        })
        .collect();

    Ok(McpStatusDto {
        running: mcp_alive(config.port, &config.token),
        url: format!("http://127.0.0.1:{}/mcp/{}", config.port, config.token),
        endpoint: format!("http://127.0.0.1:{}/mcp", config.port),
        port: i64::from(config.port),
        tool_count,
        resource_count,
        clients,
    })
}

/// 真的发一条 ping 过去。
///
/// 只做 TCP connect 的话，任何占着这个端口的东西都会被算成「MCP 在跑」——
/// 而那正是端口冲突时最容易误导人的地方。
fn mcp_alive(port: u16, token: &str) -> bool {
    use std::io::{Read, Write};

    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1500)));

    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let request = format!(
        "POST /mcp/{token} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200")
}

/// 一键接入 / 断开。
///
/// # Errors
/// 客户端名认不出来时返回 Err。
pub fn mcp_connect(
    data_dir: &std::path::Path,
    client: String,
    disconnect: bool,
) -> ApiResult<McpConnectDto> {
    let target = match client.as_str() {
        "claude" => mcp_clients::Client::Claude,
        "codex" => mcp_clients::Client::Codex,
        other => {
            return Err(ApiError::validation(format!(
                "不认识的客户端 {other}，只支持 claude 与 codex"
            )));
        }
    };

    let outcome = if disconnect {
        mcp_clients::disconnect(target)
    } else {
        let config = mcp_config::load_or_create(data_dir).map_err(ApiError::validation)?;
        mcp_clients::connect(target, config.port, &config.token)
    };

    Ok(McpConnectDto {
        ok: outcome.ok,
        detail: outcome.detail,
        command: outcome.command,
    })
}
