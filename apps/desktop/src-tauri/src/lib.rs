//! 桌面壳。
//!
//! 界面只发命令、只读事件；文件、进程、数据库都在这一侧（技术选型 §2）。
//! M0 只接通存储层的最小几条命令，证明 IPC 契约走得通；
//! 调度与 ACP 在 M2 / M3 接上。

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use aiwf_core_api as api;
// DTO 与错误类型都从 core-api 来：桌面壳与 HTTP 桥接返回的形状必须一致
use aiwf_core_api::{
    ApiError, ArtifactsDto, ModelDto, PublishedDto, RunEventsPage, RunSummary, WorkflowDetail,
    WorkflowSummary,
};
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};

pub mod tray;

/// 命令实现全在 `aiwf-core-api`，这里只做 IPC 转发。
/// 两端各写一份的话，改了一处忘了另一处，症状是「桌面版好用、Web 版数据不对」。
type IpcResult<T> = Result<T, ApiError>;

#[tauri::command]
fn supervisor_ask(
    state: State<'_, AppState>,
    question: String,
    context_json: Option<String>,
    session_id: Option<String>,
) -> IpcResult<api::SupervisorAnswer> {
    let store = lock(&state)?;
    api::supervisor_ask(&store, &state.data_dir, question, context_json, session_id)
}

#[tauri::command]
fn supervisor_sessions(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> IpcResult<Vec<api::SupervisorSessionDto>> {
    let store = lock(&state)?;
    api::supervisor_sessions(&store, limit)
}

#[tauri::command]
fn supervisor_session(
    state: State<'_, AppState>,
    session_id: String,
) -> IpcResult<api::SupervisorSessionDetail> {
    let store = lock(&state)?;
    api::supervisor_session(&store, session_id)
}

#[tauri::command]
fn memory_list(
    state: State<'_, AppState>,
    scope: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> IpcResult<api::Page<api::MemoryDto>> {
    let store = lock(&state)?;
    api::memory_list(&store, scope, query, limit, offset)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn memory_create(
    state: State<'_, AppState>,
    scope: String,
    scope_id: Option<String>,
    key: String,
    value: String,
    source: Option<String>,
    created_by: Option<String>,
    tags: Vec<String>,
) -> IpcResult<String> {
    let store = lock(&state)?;
    api::memory_create(
        &store, scope, scope_id, key, value, source, created_by, tags,
    )
}

#[tauri::command]
fn memory_update(
    state: State<'_, AppState>,
    id: String,
    base_ver: i64,
    value: Option<String>,
    tags: Option<Vec<String>>,
) -> IpcResult<()> {
    let store = lock(&state)?;
    api::memory_update(&store, id, base_ver, value, tags)
}

#[tauri::command]
fn memory_toggle(state: State<'_, AppState>, id: String, enabled: bool) -> IpcResult<()> {
    let store = lock(&state)?;
    api::memory_toggle(&store, id, enabled)
}

#[tauri::command]
fn memory_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::memory_delete(&store, id)
}

#[tauri::command]
fn prompt_list(
    state: State<'_, AppState>,
    group: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> IpcResult<api::Page<api::PromptDto>> {
    let store = lock(&state)?;
    api::prompt_list(&store, group, query, limit, offset)
}

#[tauri::command]
fn prompt_create(
    state: State<'_, AppState>,
    group: String,
    name: String,
    sections_json: String,
    vars_json: Option<String>,
) -> IpcResult<String> {
    let store = lock(&state)?;
    api::prompt_create(&store, group, name, sections_json, vars_json)
}

#[tauri::command]
fn prompt_update(
    state: State<'_, AppState>,
    id: String,
    ver: i64,
    name: Option<String>,
    sections_json: Option<String>,
    vars_json: Option<String>,
    changed_by: Option<String>,
) -> IpcResult<api::VerOnly> {
    let store = lock(&state)?;
    api::prompt_update(&store, id, ver, name, sections_json, vars_json, changed_by)
}

#[tauri::command]
fn prompt_versions(
    state: State<'_, AppState>,
    prompt_id: String,
) -> IpcResult<Vec<api::PromptVersionDto>> {
    let store = lock(&state)?;
    api::prompt_versions(&store, prompt_id)
}

#[tauri::command]
fn prompt_duplicate(state: State<'_, AppState>, id: String, name: String) -> IpcResult<String> {
    let store = lock(&state)?;
    api::prompt_duplicate(&store, id, name)
}

#[tauri::command]
fn prompt_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::prompt_delete(&store, id)
}

#[tauri::command]
fn agent_list(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> IpcResult<api::Page<api::AgentDto>> {
    let store = lock(&state)?;
    api::agent_list(&store, query, limit, offset)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn agent_create(
    state: State<'_, AppState>,
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
) -> IpcResult<String> {
    let store = lock(&state)?;
    api::agent_create(
        &store,
        name,
        role,
        goal,
        persona,
        runtime,
        model_ref,
        fallback_model_ref,
        tools,
        capabilities_json,
        output_contract,
        turn_limit,
        timeout_ms,
    )
}

#[tauri::command]
// Tauri 的命令参数必须是扁平的，收不了嵌套结构，所以这里仍逐个列出，
// 进 core-api 之前再收成 AgentEdit
#[allow(clippy::too_many_arguments)]
fn agent_update(
    state: State<'_, AppState>,
    id: String,
    ver: i64,
    name: Option<String>,
    goal: Option<String>,
    persona: Option<String>,
    model_ref: Option<String>,
    fallback_model_ref: Option<String>,
    capabilities_json: Option<String>,
    tools: Option<Vec<String>>,
    output_contract: Option<String>,
) -> IpcResult<api::VerOnly> {
    let store = lock(&state)?;
    api::agent_update(
        &store,
        id,
        ver,
        api::AgentEdit {
            name,
            goal,
            persona,
            model_ref,
            fallback_model_ref,
            capabilities_json,
            tools,
            output_contract,
        },
    )
}

#[tauri::command]
fn agent_duplicate(state: State<'_, AppState>, id: String, name: String) -> IpcResult<String> {
    let store = lock(&state)?;
    api::agent_duplicate(&store, id, name)
}

#[tauri::command]
fn agent_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::agent_delete(&store, id)
}

#[tauri::command]
fn model_list(
    state: State<'_, AppState>,
    enabled_only: bool,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> IpcResult<api::Page<ModelDto>> {
    let store = lock(&state)?;
    api::model_list(&store, enabled_only, query, limit, offset)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn model_create(
    state: State<'_, AppState>,
    name: String,
    runtime: String,
    model_id: String,
    effort: String,
    context_window: i64,
    capabilities: Vec<String>,
    credential_ref: Option<String>,
    enabled: bool,
) -> IpcResult<String> {
    let store = lock(&state)?;
    api::model_create(
        &store,
        name,
        runtime,
        model_id,
        effort,
        context_window,
        capabilities,
        credential_ref,
        enabled,
    )
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn model_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    runtime: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    context_window: Option<i64>,
    capabilities: Option<Vec<String>>,
    credential_ref: Option<String>,
    enabled: Option<bool>,
) -> IpcResult<()> {
    let store = lock(&state)?;
    api::model_update(
        &store,
        id,
        name,
        runtime,
        model_id,
        effort,
        context_window,
        capabilities,
        credential_ref,
        enabled,
    )
}

#[tauri::command]
fn model_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::model_delete(&store, id)
}

#[tauri::command]
fn run_start(
    state: State<'_, AppState>,
    workflow_id: String,
    version_id: Option<String>,
    draft_rev: Option<i64>,
    inputs_json: String,
    workdir: Option<String>,
) -> IpcResult<String> {
    let store = lock(&state)?;
    api::run_start(
        &store,
        &state.supervisor,
        &state.data_dir,
        workflow_id,
        version_id,
        draft_rev,
        inputs_json,
        workdir,
    )
}

#[tauri::command]
fn run_dry_run(
    state: State<'_, AppState>,
    workflow_id: String,
    version_id: Option<String>,
    draft_rev: Option<i64>,
    workdir: Option<String>,
) -> IpcResult<api::DryRunDto> {
    let store = lock(&state)?;
    api::run_dry_run(
        &store,
        &state.data_dir,
        workflow_id,
        version_id,
        draft_rev,
        workdir,
    )
}

#[tauri::command]
fn run_list(
    state: State<'_, AppState>,
    workflow_id: Option<String>,
    statuses: Vec<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> IpcResult<api::Page<RunSummary>> {
    let store = lock(&state)?;
    api::run_list(&store, workflow_id, statuses, query, limit, offset)
}

#[tauri::command]
fn run_get(state: State<'_, AppState>, run_id: String) -> IpcResult<Option<RunSummary>> {
    let store = lock(&state)?;
    api::run_get(&store, run_id)
}

#[tauri::command]
fn run_events(
    state: State<'_, AppState>,
    run_id: String,
    from_seq: i64,
    limit: i64,
) -> IpcResult<RunEventsPage> {
    let store = lock(&state)?;
    api::run_events(&store, run_id, from_seq, limit)
}

#[tauri::command]
fn run_artifacts(state: State<'_, AppState>, run_id: String) -> IpcResult<ArtifactsDto> {
    let store = lock(&state)?;
    api::run_artifacts(&store, run_id)
}

#[tauri::command]
fn run_cancel(state: State<'_, AppState>, run_id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::run_cancel(&store, &state.supervisor, run_id)
}

#[tauri::command]
fn run_resume(state: State<'_, AppState>, run_id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::run_resume(&store, &state.supervisor, run_id)
}

#[tauri::command]
fn approval_decide(
    state: State<'_, AppState>,
    run_id: String,
    node_id: String,
    decision: String,
) -> IpcResult<()> {
    let store = lock(&state)?;
    api::approval_decide(&store, &state.supervisor, run_id, node_id, decision)
}

#[tauri::command]
fn workflow_list(
    state: State<'_, AppState>,
    status: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> IpcResult<api::Page<WorkflowSummary>> {
    let store = lock(&state)?;
    api::workflow_list(&store, status, query, limit, offset)
}

#[tauri::command]
fn workspace_stats(state: State<'_, AppState>) -> IpcResult<api::WorkspaceStatsDto> {
    let data_dir = state.data_dir.clone();
    let store = lock(&state)?;
    api::workspace_stats(&store, Some(&data_dir))
}

#[tauri::command]
fn env_diagnostics(state: State<'_, AppState>) -> IpcResult<api::DiagnosticsResult> {
    api::env_diagnostics(&state.data_dir.join("diagnostics"))
}

#[tauri::command]
fn run_rewind_to_approval(
    state: State<'_, AppState>,
    run_id: String,
) -> IpcResult<api::RewindResult> {
    let store = lock(&state)?;
    api::run_rewind_to_approval(&store, run_id)
}

#[tauri::command]
fn model_test(state: State<'_, AppState>, id: String) -> IpcResult<api::ModelTestResult> {
    let store = lock(&state)?;
    api::model_test(&store, id)
}

#[tauri::command]
fn mcp_request_confirm(
    state: State<'_, AppState>,
    tool: String,
    input_json: String,
) -> IpcResult<String> {
    let store = lock(&state)?;
    api::mcp_request_confirm(&store, tool, input_json)
}

#[tauri::command]
fn mcp_confirm_status(state: State<'_, AppState>, id: String) -> IpcResult<api::ConfirmStatusDto> {
    let store = lock(&state)?;
    api::mcp_confirm_status(&store, id)
}

#[tauri::command]
fn mcp_pending_confirms(state: State<'_, AppState>) -> IpcResult<Vec<api::ConfirmationDto>> {
    let store = lock(&state)?;
    api::mcp_pending_confirms(&store)
}

#[tauri::command]
fn mcp_decide_confirm(state: State<'_, AppState>, id: String, approved: bool) -> IpcResult<()> {
    let store = lock(&state)?;
    api::mcp_decide_confirm(&store, id, approved)
}

#[tauri::command]
fn workspace_settings(state: State<'_, AppState>) -> IpcResult<api::WorkspaceSettingsDto> {
    let store = lock(&state)?;
    api::workspace_settings(&store)
}

#[tauri::command]
fn workspace_update_settings(
    state: State<'_, AppState>,
    workdir: Option<String>,
    permission_preset: Option<String>,
    env_checked_at: Option<String>,
) -> IpcResult<()> {
    let store = lock(&state)?;
    api::workspace_update_settings(
        &store,
        workdir.as_deref(),
        permission_preset.as_deref(),
        env_checked_at.as_deref(),
    )
}

#[tauri::command]
fn workspace_reset_preview(state: State<'_, AppState>) -> IpcResult<api::ResetPreviewDto> {
    let data_dir = state.data_dir.clone();
    let store = lock(&state)?;
    let workdir = 授权目录(&store);
    api::workspace_reset_preview(&store, &data_dir, workdir.as_deref())
}

#[tauri::command]
fn workspace_reset(
    state: State<'_, AppState>,
    confirm: bool,
    include_artifacts: Option<bool>,
) -> IpcResult<api::ResetResultDto> {
    // 契约那侧 confirm 是 z.literal(true)。这里再挡一次是因为
    // IPC 收到的是解过的参数，没经过 Zod —— 而这条命令删得掉用户全部的东西
    if !confirm {
        return Err(ApiError {
            code: "VALIDATION".into(),
            message: "一键初始化需要显式确认".into(),
            retriable: false,
            hint: None,
        });
    }
    let data_dir = state.data_dir.clone();
    let mut store = lock(&state)?;
    let workdir = 授权目录(&store);
    api::workspace_reset(
        &mut store,
        &data_dir,
        workdir.as_deref(),
        include_artifacts.unwrap_or(false),
    )
}

/// 用户授权的工作目录。产物落在它下面的 `.aiwf-artifacts` 里。
///
/// 读不到当「还没授权」：那种情况下产物目录本来就不存在，
/// 让一键初始化因为读不到设置而整个失败没有道理。
fn 授权目录(store: &Store) -> Option<std::path::PathBuf> {
    store
        .workspace_settings()
        .ok()
        .and_then(|s| s.workdir)
        .map(std::path::PathBuf::from)
}

#[tauri::command]
fn run_artifact_content(
    state: State<'_, AppState>,
    run_id: String,
    path: String,
    max_bytes: Option<i64>,
) -> IpcResult<api::ArtifactContentDto> {
    let store = lock(&state)?;
    api::run_artifact_content(&store, run_id, path, max_bytes)
}

#[tauri::command]
fn run_diagnostics(
    state: State<'_, AppState>,
    run_id: String,
) -> IpcResult<api::DiagnosticsResult> {
    let out = state.data_dir.join("diagnostics");
    let store = lock(&state)?;
    api::run_diagnostics(&store, &out, run_id)
}

#[tauri::command]
fn env_health(recheck: Option<bool>) -> IpcResult<api::EnvHealthReport> {
    // 只读探测，不需要 store —— 它问的是这台机器上有什么
    api::env_health(recheck.unwrap_or(false))
}

#[tauri::command]
fn workflow_create(
    state: State<'_, AppState>,
    name: Option<String>,
    graph_json: Option<String>,
) -> IpcResult<String> {
    let store = lock(&state)?;
    api::workflow_create(&store, name, graph_json)
}

#[tauri::command]
fn workflow_get(state: State<'_, AppState>, id: String) -> IpcResult<WorkflowDetail> {
    let store = lock(&state)?;
    api::workflow_get(&store, id)
}

#[tauri::command]
fn workflow_save_draft(
    state: State<'_, AppState>,
    id: String,
    base_rev: i64,
    graph_json: String,
) -> IpcResult<i64> {
    let store = lock(&state)?;
    api::workflow_save_draft(&store, id, base_rev, graph_json)
}

#[tauri::command]
fn workflow_patch(
    state: State<'_, AppState>,
    id: String,
    base_revision: i64,
    operations: serde_json::Value,
    graph_json: Option<String>,
) -> IpcResult<api::PatchDto> {
    let store = lock(&state)?;
    api::workflow_patch(
        &store,
        id,
        base_revision,
        operations.to_string(),
        graph_json,
    )
}

#[tauri::command]
fn workflow_validate(
    state: State<'_, AppState>,
    id: String,
    rev: Option<i64>,
) -> IpcResult<aiwf_engine::validate::ValidationResult> {
    let store = lock(&state)?;
    api::workflow_validate(&store, id, rev)
}

#[tauri::command]
fn workflow_diff(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> IpcResult<aiwf_engine::patch::WorkflowDiff> {
    let store = lock(&state)?;
    api::workflow_diff(&store, id, from, to)
}

#[tauri::command]
fn mcp_status(state: State<'_, AppState>) -> IpcResult<api::McpStatusDto> {
    // 工具与资源的条数由 MCP crate 知道 —— 它依赖 core-api，反过来不行
    api::mcp_status(
        &state.data_dir,
        aiwf_mcp::catalog::tools().len() as i64,
        aiwf_mcp::knowledge::resources().len() as i64,
    )
}

#[tauri::command]
fn mcp_connect(
    state: State<'_, AppState>,
    client: String,
    disconnect: Option<bool>,
) -> IpcResult<api::McpConnectDto> {
    api::mcp_connect(&state.data_dir, client, disconnect.unwrap_or(false))
}

#[tauri::command]
fn workflow_publish(state: State<'_, AppState>, id: String, rev: i64) -> IpcResult<PublishedDto> {
    let store = lock(&state)?;
    api::workflow_publish(&store, id, rev)
}

#[tauri::command]
fn workflow_version_graph(state: State<'_, AppState>, version_id: String) -> IpcResult<String> {
    let store = lock(&state)?;
    api::workflow_version_graph(&store, version_id)
}

#[tauri::command]
fn workflow_rollback(state: State<'_, AppState>, id: String, version_id: String) -> IpcResult<i64> {
    let store = lock(&state)?;
    api::workflow_rollback(&store, id, version_id)
}

#[tauri::command]
fn workflow_discard_if_empty(
    state: State<'_, AppState>,
    id: String,
) -> IpcResult<api::DiscardResult> {
    let store = lock(&state)?;
    api::workflow_discard_if_empty(&store, id)
}

#[tauri::command]
fn workflow_rename(state: State<'_, AppState>, id: String, name: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::workflow_rename(&store, id, name)
}

#[tauri::command]
fn workflow_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    api::workflow_delete(&store, id)
}

/// 写入串行化到单个 writer：SQLite 连接不是 Sync，用锁把它固定在一处。
///
/// 后台执行走的是另一条路：Supervisor 给每个运行开自己的连接（WAL 允许），
/// 否则一个跑十分钟的脚本会把界面的所有查询卡住。
pub struct AppState {
    store: Mutex<Store>,
    supervisor: Supervisor,
    /// 应用数据目录。运行目录、产物都落在它下面。
    data_dir: PathBuf,
}

/// 回滚：把某个已发布版本的图写成**新的**草稿修订。
///
/// 刻意不是「覆盖」——原草稿仍留在修订历史里，用户随时能再回来。
/// 也刻意不复用 save_draft：这一步没有结构化操作可记，
/// 取存储锁。锁中毒说明有 writer 线程 panic 过，此时任何写入都不可信。
fn lock<'a>(state: &'a State<'_, AppState>) -> IpcResult<std::sync::MutexGuard<'a, Store>> {
    state.store.lock().map_err(|_| ApiError {
        code: "INTERNAL".into(),
        message: "存储锁中毒：有写入线程崩溃过，请重启应用".into(),
        retriable: false,
        hint: None,
    })
}

/// 应用数据目录：工作流、运行记录、产物、日志都落在这里。
/// Secret 不进这里——它只在 Keychain 中（技术选型 §5）。
fn data_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败：{e}"))?;
    Ok(dir.join("aiwf.sqlite"))
}

static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// 显示并聚焦主窗口。从托盘、Dock 图标、单实例唤起都走这里。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut menu = MenuBuilder::new(app);
    for item in tray::TRAY_MENU {
        if item.id == "quit" {
            // 退出前加分隔线：它与上面两项不是一类操作
            menu = menu.separator();
        }
        menu = menu.item(&MenuItemBuilder::with_id(item.id, item.label).build(app)?);
    }
    let menu = menu.build()?;

    TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        // macOS 的模板图标：只用 alpha 通道，系统按明暗主题自动反色
        .icon_as_template(true)
        .tooltip("AI Workflows")
        .menu(&menu)
        // 左键点图标直接开窗，不弹菜单——这是最高频的操作
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(
            |app, event| match tray::resolve_menu_action(event.id().as_ref()) {
                tray::TrayAction::ShowWindow => show_main_window(app),
                tray::TrayAction::CheckUpdate => {
                    show_main_window(app);
                    // 更新流程在前端（设置 →「系统版本」），这里只负责把用户带过去。
                    // 带上 ?tab= 才算真的带到：只跳 /settings 会停在默认档，
                    // 用户还得自己在左栏找。接这个事件的是 apps/web 的
                    // useTrayNavigation —— 在它之前这一行 emit 出去没人听
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("navigate", "/settings?tab=version");
                    }
                }
                tray::TrayAction::Quit => {
                    QUIT_REQUESTED.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
                // 未登记的 id 什么都不做，绝不落到退出上
                tray::TrayAction::Unknown => {}
            },
        )
        .build(app)?;

    Ok(())
}

/// 应用入口。
///
/// 这里是全项目唯一允许 panic 的地方：壳都起不来就没有界面可以显示错误，
/// 继续执行只会得到一个没有窗口的僵尸进程。业务代码一律返回 Result。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let path = data_file(app.handle())?;
            // open_workspace：首次启动把内置的模型、Agent 角色、提示词与记忆种上。
            // 只种一次 —— 用户改过或删过的条目不会在下次启动被冲回去
            let store = Store::open_workspace(&path)?;
            let data_dir = path
                .parent()
                .map_or_else(std::env::temp_dir, std::path::Path::to_path_buf);
            // 系统 MCP 跟着应用一起起来。
            //
            // 起不来**不拦住应用**：MCP 只是把能力开给外部客户端，
            // 界面本身照常可用。但要留一行日志 —— 静默失败的症状是
            // 「一键接入点了没反应」，而用户无从知道服务根本没起来。
            match aiwf_mcp::config::load_or_create(&data_dir)
                .and_then(|config| aiwf_mcp::start(&data_dir, path.clone(), config))
            {
                Ok(handle) => println!("[aiwf] 系统 MCP 已就绪：{}", handle.plain_url()),
                Err(error) => eprintln!("[aiwf] 系统 MCP 没起来：{error}"),
            }

            app.manage(AppState {
                store: Mutex::new(store),
                supervisor: Supervisor::new(path),
                data_dir,
            });
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match tray::close_behavior(QUIT_REQUESTED.load(Ordering::SeqCst)) {
                    tray::CloseBehavior::HideToTray => {
                        // 拦下关闭：进程继续跑，运行与审批不受影响
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    tray::CloseBehavior::Exit => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            workflow_list,
            workspace_stats,
            workspace_settings,
            mcp_request_confirm,
            mcp_confirm_status,
            mcp_pending_confirms,
            mcp_decide_confirm,
            model_test,
            run_rewind_to_approval,
            env_diagnostics,
            workspace_update_settings,
            workspace_reset_preview,
            workspace_reset,
            env_health,
            run_diagnostics,
            run_artifact_content,
            workflow_create,
            workflow_get,
            workflow_save_draft,
            mcp_status,
            mcp_connect,
            workflow_patch,
            workflow_validate,
            workflow_diff,
            workflow_publish,
            workflow_version_graph,
            workflow_rollback,
            workflow_rename,
            workflow_discard_if_empty,
            workflow_delete,
            run_start,
            run_dry_run,
            run_list,
            run_get,
            run_events,
            run_artifacts,
            run_cancel,
            run_resume,
            approval_decide,
            supervisor_ask,
            supervisor_sessions,
            supervisor_session,
            memory_list,
            memory_create,
            memory_update,
            memory_toggle,
            memory_delete,
            prompt_list,
            prompt_create,
            prompt_update,
            prompt_versions,
            prompt_duplicate,
            prompt_delete,
            agent_list,
            agent_create,
            agent_update,
            agent_duplicate,
            agent_delete,
            model_list,
            model_create,
            model_update,
            model_delete
        ])
        .build(tauri::generate_context!())
        .expect("启动桌面壳失败")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                // 点 Dock 图标时窗口已隐藏，重新显示而不是新建一个
                show_main_window(app);
            }
        });
}
