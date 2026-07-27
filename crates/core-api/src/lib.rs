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

/// 解析工作目录：留空用应用的默认运行目录，`~` 要展开。
///
/// 不展开 `~` 的话，用户手输一个看起来完全正常的路径，
/// 引擎会去找一个名叫 `~` 的目录，报「不存在」——
/// 而错误信息里那个路径看着是对的，没人会想到是波浪号的问题。
///
/// 默认目录**由这里创建**：那是引擎自己的地盘，第一次跑必然不存在，
/// 让 Dry Run 报「目录不存在」等于要求用户先手动 mkdir 一个
/// 他根本不知道在哪的路径。用户显式指定的目录是另一回事 ——
/// 那种不存在就该报错，因为多半是打错了。
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
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub retriable: bool,
}

pub type ApiResult<T> = Result<T, ApiError>;

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
        Self {
            code: code.to_string(),
            message: error.to_string(),
            retriable,
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
        Self {
            code: code.to_string(),
            message: error.to_string(),
            retriable,
        }
    }
}

/// 已接通的方法名清单。HTTP 侧按它分派，测试按它守住两端一致。
pub const COMMANDS: &[&str] = &[
    "supervisor_ask",
    "memory_list",
    "memory_create",
    "memory_update",
    "memory_toggle",
    "memory_delete",
    "prompt_list",
    "prompt_create",
    "prompt_update",
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
    "model_delete",
    "run_start",
    "run_dry_run",
    "run_list",
    "run_get",
    "run_events",
    "run_artifacts",
    "run_cancel",
    "run_resume",
    "approval_decide",
    "workflow_list",
    "workflow_create",
    "workflow_get",
    "workflow_save_draft",
    "workflow_publish",
    "workflow_version_graph",
    "workflow_rollback",
    "workflow_rename",
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
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsDto {
    items: Vec<ArtifactDto>,
    root: String,
}

#[derive(Serialize)]
pub struct WorkflowSummary {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder: Option<String>,
    updated_at: String,
}

#[derive(Serialize)]
pub struct VersionMetaDto {
    id: String,
    version: i64,
    config_hash: String,
    published_at: String,
    published_by: String,
}

#[derive(Serialize)]
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

pub fn model_list(store: &Store, enabled_only: bool) -> ApiResult<Vec<ModelDto>> {
    Ok(store
        .list_models(enabled_only)?
        .into_iter()
        .map(ModelDto::from)
        .collect())
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
    let workdir = resolve_workdir(workdir.as_deref(), data_dir);
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
    })?;

    let graph: aiwf_engine::graph::WorkflowGraph =
        serde_json::from_str(&graph_json).map_err(|error| ApiError {
            code: "INTERNAL".to_string(),
            message: format!("图数据无法解析：{error}"),
            retriable: false,
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
) -> ApiResult<Vec<RunSummary>> {
    Ok(store
        .list_runs(workflow_id.as_deref(), &statuses, query.as_deref())?
        .into_iter()
        .map(RunSummary::from)
        .collect())
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
    })?;

    Ok(ArtifactsDto {
        root: artifacts.root().join(&run_id).display().to_string(),
        items: items
            .into_iter()
            .map(|item| ArtifactDto {
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

pub fn workflow_list(store: &Store) -> ApiResult<Vec<WorkflowSummary>> {
    Ok(store
        .list_workflows()?
        .into_iter()
        .map(|w| WorkflowSummary {
            id: w.id,
            name: w.name,
            folder: w.folder,
            updated_at: w.updated_at,
        })
        .collect())
}

pub fn workflow_create(
    store: &Store,
    name: String,
    graph_json: Option<String>,
) -> ApiResult<String> {
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
        });
    }
    Ok(store.save_draft(&id, &version.graph_json)?)
}

pub fn workflow_delete(store: &Store, id: String) -> ApiResult<()> {
    store.delete_workflow(&id)?;
    Ok(())
}

// ── Agent 角色 ──────────────────────────────────────────────────────────────

pub fn agent_list(store: &Store) -> ApiResult<Vec<AgentDto>> {
    Ok(store
        .list_agents()?
        .into_iter()
        .map(AgentDto::from)
        .collect())
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
/// Agent 角色的部分更新。字段与 [`aiwf_store::AgentPatch`] 一一对应，
/// 只是持有所有权 —— IPC 层拿到的是 `Option<String>`，借不出去。
#[derive(Debug, Default, Clone)]
pub struct AgentEdit {
    pub name: Option<String>,
    pub goal: Option<String>,
    pub persona: Option<String>,
    pub model_ref: Option<String>,
    pub fallback_model_ref: Option<String>,
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

pub fn prompt_list(store: &Store, query: Option<String>) -> ApiResult<Vec<PromptDto>> {
    Ok(store
        .list_prompts(query.as_deref())?
        .into_iter()
        .map(PromptDto::from)
        .collect())
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
) -> ApiResult<VerOnly> {
    let ver = store.update_prompt(
        &id,
        base_ver,
        name.as_deref(),
        sections_json.as_deref(),
        vars_json.as_deref(),
    )?;
    Ok(VerOnly { ver })
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
) -> ApiResult<Vec<MemoryDto>> {
    Ok(store
        .list_memories(scope.as_deref(), query.as_deref())?
        .into_iter()
        .map(MemoryDto::from)
        .collect())
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
) -> ApiResult<SupervisorAnswer> {
    use aiwf_engine::acp::{AcpClient, SessionUpdate, adapter_installed, env_to_remove};

    let runtime = "acp.claude";
    let Some(command) = adapter_installed(runtime) else {
        return Err(ApiError {
            code: "VALIDATION".to_string(),
            message: format!(
                "{runtime} 的 adapter 没有安装。主管 AI 需要它才能工作 ——\
                 在「设置与环境」里能看到怎么装"
            ),
            retriable: false,
        });
    };

    // 把上下文与可注入的记忆拼进提示词。
    // 记忆只取启用且未过期的（memories_for_injection 保证这一点）
    let memories = store
        .memories_for_injection("workspace", None)
        .unwrap_or_default();
    let mut prompt = String::new();

    if !memories.is_empty() {
        prompt.push_str("已知的长期上下文：\n");
        for memory in memories.iter().take(20) {
            prompt.push_str(&format!("- {}：{}\n", memory.key, memory.value));
        }
        prompt.push('\n');
    }

    if let Some(context) = context_json
        .as_deref()
        .filter(|c| *c != "{}" && !c.is_empty())
    {
        prompt.push_str(&format!("当前界面状态：{context}\n\n"));
    }

    prompt.push_str(&question);

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
    })?;

    let session = client
        .new_session(&data_dir.display().to_string())
        .map_err(|error| ApiError {
            code: "EXTERNAL".to_string(),
            message: format!("建会话失败：{error}"),
            retriable: true,
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
        })?;

    Ok(SupervisorAnswer { text, tool_calls })
}

pub fn workflow_rename(store: &Store, id: String, name: String) -> ApiResult<()> {
    store.rename_workflow(&id, &name)?;
    Ok(())
}
