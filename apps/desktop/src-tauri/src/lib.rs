//! 桌面壳。
//!
//! 界面只发命令、只读事件；文件、进程、数据库都在这一侧（技术选型 §2）。
//! M0 只接通存储层的最小几条命令，证明 IPC 契约走得通；
//! 调度与 ACP 在 M2 / M3 接上。

use std::path::PathBuf;
use std::sync::Mutex;

use aiwf_store::Store;
use serde::Serialize;
use tauri::{Manager, State};

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![workflow_list, workflow_create])
        .run(tauri::generate_context!())
        .expect("启动桌面壳失败");
}
