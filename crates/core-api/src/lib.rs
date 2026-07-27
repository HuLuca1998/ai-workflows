//! Core API 的实现，与外壳无关。
//!
//! 桌面壳（Tauri IPC）与开发用 HTTP 服务都调用这里的函数。
//! 之所以抽出来，是因为两端各写一份的话，改了一处忘了另一处，
//! 症状是「桌面版好用、Web 版数据不对」——这种漂移很难查。

use aiwf_engine::runner::RunRequest;
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde::Serialize;

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
            // preflight 不过属于用户能修的问题
            E::Run(_) => ("VALIDATION", false),
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
    current_node: Option<String>,
    workdir: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventDto {
    id: String,
    seq: i64,
    ts: String,
    kind: String,
    node_id: Option<String>,
    attempt: Option<i64>,
    actor: String,
    summary: String,
    sensitivity: String,
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
pub struct ModelDto {
    id: String,
    name: String,
    runtime: String,
    model_id: String,
    effort: String,
    context_window: i64,
    capabilities: Vec<String>,
    credential_ref: Option<String>,
    enabled: bool,
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

#[allow(clippy::too_many_arguments)]
/// 启动运行。preflight 与建 Run 同步做完（调用方立刻拿到 runId
/// 或立刻知道图有问题），执行本身在后台线程。
pub fn run_start(
    store: &Store,
    supervisor: &Supervisor,
    workflow_id: String,
    version_id: Option<String>,
    draft_rev: Option<i64>,
    inputs_json: String,
    workdir: String,
) -> ApiResult<String> {
    let run_id = supervisor.start(
        store,
        RunRequest {
            workflow_id,
            version_id,
            draft_rev,
            inputs_json,
            workdir,
        },
    )?;
    Ok(run_id)
}

/// Dry Run 依赖检查。只读，不建 Run —— 启动表单打开时就调。
pub fn run_dry_run(
    store: &Store,
    workflow_id: String,
    version_id: Option<String>,
    draft_rev: Option<i64>,
    workdir: String,
) -> ApiResult<aiwf_engine::preflight::DryRunReport> {
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

    Ok(aiwf_engine::preflight::dry_run(
        &graph,
        std::path::Path::new(&workdir),
    ))
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
                seq: row.seq,
                ts: row.ts,
                kind: row.kind,
                node_id: row.node_id,
                attempt: row.attempt,
                actor: row.actor,
                summary: row.summary,
                sensitivity: row.sensitivity,
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
