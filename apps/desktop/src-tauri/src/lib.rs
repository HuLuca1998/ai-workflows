//! 桌面壳。
//!
//! 界面只发命令、只读事件；文件、进程、数据库都在这一侧（技术选型 §2）。
//! M0 只接通存储层的最小几条命令，证明 IPC 契约走得通；
//! 调度与 ACP 在 M2 / M3 接上。

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use aiwf_store::Store;
use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};

pub mod tray;

/// 传给界面的错误。形状与 `@aiwf/contracts` 的统一错误对象一致，
/// 这样前端只处理一种错误类型。
#[derive(Debug, Serialize)]
pub struct IpcError {
    code: String,
    message: String,
    retriable: bool,
}

impl From<aiwf_store::StoreError> for IpcError {
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

type IpcResult<T> = Result<T, IpcError>;

/// 写入串行化到单个 writer：SQLite 连接不是 Sync，用锁把它固定在一处。
pub struct AppState {
    store: Mutex<Store>,
}

#[derive(Serialize)]
pub struct WorkflowSummary {
    id: String,
    name: String,
    folder: Option<String>,
    updated_at: String,
}

#[tauri::command]
fn workflow_list(state: State<'_, AppState>) -> IpcResult<Vec<WorkflowSummary>> {
    let store = lock(&state)?;
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

#[tauri::command]
fn workflow_create(
    state: State<'_, AppState>,
    name: String,
    graph_json: Option<String>,
) -> IpcResult<String> {
    let store = lock(&state)?;
    Ok(match graph_json {
        Some(graph) => store.create_workflow_with_graph(&name, None, &graph)?,
        None => store.create_workflow(&name, None)?,
    })
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

#[tauri::command]
fn workflow_get(state: State<'_, AppState>, id: String) -> IpcResult<WorkflowDetail> {
    let store = lock(&state)?;
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
#[tauri::command]
fn workflow_save_draft(
    state: State<'_, AppState>,
    id: String,
    base_rev: i64,
    graph_json: String,
) -> IpcResult<i64> {
    let store = lock(&state)?;
    Ok(store.save_draft_guarded(&id, base_rev, &graph_json)?)
}

#[derive(Serialize)]
pub struct PublishedDto {
    version_id: String,
    version: i64,
    config_hash: String,
}

#[tauri::command]
fn workflow_publish(state: State<'_, AppState>, id: String, rev: i64) -> IpcResult<PublishedDto> {
    let store = lock(&state)?;
    // 发布者暂时固定为本机用户；M4 接入身份后改为真实 actor
    let published = store.publish(&id, rev, "本地用户")?;
    Ok(PublishedDto {
        version_id: published.id,
        version: published.version,
        config_hash: published.config_hash,
    })
}

/// 读某个已发布版本的完整图。回滚为草稿与版本对比都要用。
#[tauri::command]
fn workflow_version_graph(state: State<'_, AppState>, version_id: String) -> IpcResult<String> {
    let store = lock(&state)?;
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
#[tauri::command]
fn workflow_rollback(state: State<'_, AppState>, id: String, version_id: String) -> IpcResult<i64> {
    let store = lock(&state)?;
    let version = store
        .get_version(&version_id)?
        .ok_or(aiwf_store::StoreError::NotFound {
            kind: "版本",
            id: version_id,
        })?;
    if version.workflow_id != id {
        return Err(IpcError {
            code: "VALIDATION".into(),
            message: "这个版本不属于该工作流".into(),
            retriable: false,
        });
    }
    Ok(store.save_draft(&id, &version.graph_json)?)
}

#[tauri::command]
fn workflow_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
    let store = lock(&state)?;
    store.delete_workflow(&id)?;
    Ok(())
}

/// 取存储锁。锁中毒说明有 writer 线程 panic 过，此时任何写入都不可信。
fn lock<'a>(state: &'a State<'_, AppState>) -> IpcResult<std::sync::MutexGuard<'a, Store>> {
    state.store.lock().map_err(|_| IpcError {
        code: "INTERNAL".into(),
        message: "存储锁中毒：有写入线程崩溃过，请重启应用".into(),
        retriable: false,
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

/// 用户是否已经从菜单栏明确要求退出。
///
/// 关窗默认只隐藏，所以需要一个标记区分「隐藏」与「真退出」——
/// 否则退出流程里那次窗口关闭又会被拦下来，进程永远结束不了。
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
                    // 更新流程在前端（设置页的更新卡片），这里只负责把用户带过去
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("navigate", "/settings");
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
            let store = Store::open(&path)?;
            app.manage(AppState {
                store: Mutex::new(store),
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
            workflow_create,
            workflow_get,
            workflow_save_draft,
            workflow_publish,
            workflow_version_graph,
            workflow_rollback,
            workflow_delete
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
