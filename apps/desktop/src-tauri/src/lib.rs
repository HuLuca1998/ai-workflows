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
        let code = match error {
            aiwf_store::StoreError::Invalid(_) => "VALIDATION",
            aiwf_store::StoreError::NotFound { .. } => "VALIDATION",
            aiwf_store::StoreError::Sqlite(_) => "INTERNAL",
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
            retriable: false,
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
    let store = state.store.lock().map_err(|_| IpcError {
        code: "INTERNAL".into(),
        message: "存储锁中毒".into(),
        retriable: false,
    })?;
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
fn workflow_create(state: State<'_, AppState>, name: String) -> IpcResult<String> {
    let store = state.store.lock().map_err(|_| IpcError {
        code: "INTERNAL".into(),
        message: "存储锁中毒".into(),
        retriable: false,
    })?;
    Ok(store.create_workflow(&name, None)?)
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
        .invoke_handler(tauri::generate_handler![workflow_list, workflow_create])
        .build(tauri::generate_context!())
        .expect("启动桌面壳失败")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                // 点 Dock 图标时窗口已隐藏，重新显示而不是新建一个
                show_main_window(app);
            }
        });
}
