//! 把引擎的通知意图变成一条真的 macOS 通知。
//!
//! 引擎自己发不了 —— 它是个库，跑在没有桌面的地方也要能编译。
//! 它定义了 `Notifier` trait，这里是**唯一**的真实实现。
//!
//! 在这之前，`notify` 节点与 `entry` / `end` 归在同一档：什么都不做，
//! 直接返回成功。而它的契约承诺的是「macOS 系统通知，点击可跳回运行」。
//! 掩护它的三样东西里有一条测试，注释写着「实际发送在 Tauri 壳里做」——
//! 这个文件在那句话写下之后一年才存在（DEBT.md 的 B-1）。
//!
//! ## 权限
//!
//! macOS 的通知要用户授权，且 **ad-hoc 签名下每次更新都会失效**
//! （designated requirement 是 cdhash 精确匹配，见 docs/MACOS-PERMISSIONS.md）。
//! 所以这里不缓存「授权过了」——每次发之前问一遍系统，
//! 没授权就把这句话原样交回给引擎，让它写进事件流。

use aiwf_engine::notify::{Notification, Notifier};
use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

pub struct DesktopNotifier {
    app: AppHandle,
}

impl DesktopNotifier {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl Notifier for DesktopNotifier {
    fn send(&self, notification: &Notification) -> Result<(), String> {
        // 每次都问一遍，不缓存。
        //
        // 更新一次 App，cdhash 变了，上一版拿到的通知授权就不再适用 ——
        // 缓存「授权过了」会让更新后的第一批通知静默丢失，
        // 而事件流里写着「已发出」
        let state = self
            .app
            .notification()
            .permission_state()
            .map_err(|error| format!("问不到通知权限的状态：{error}"))?;

        match state {
            PermissionState::Granted => {}
            PermissionState::Denied => {
                return Err("通知权限被拒绝了。到「系统设置 → 通知 → AI Workflows」里打开 \
                            —— App 自己没法再弹那个授权框"
                    .to_string());
            }
            // 还没问过：现在问。首次运行到一个 notify 节点时走这里
            _ => {
                let granted = self
                    .app
                    .notification()
                    .request_permission()
                    .map_err(|error| format!("申请通知权限失败：{error}"))?;
                if granted != PermissionState::Granted {
                    return Err("这次没有授予通知权限，通知发不出去".to_string());
                }
            }
        }

        // 副标题拼进正文第一行。
        //
        // macOS 的通知原生支持 subtitle，但 `tauri-plugin-notification`
        // 在桌面端只通 title / body / icon / sound
        // （`desktop.rs` 的 `show`，2.3.3）—— 没有 subtitle 的通路。
        //
        // 拼进正文而不是丢掉：契约里 `subtitle` 是个能填能存能校验的字段，
        // 丢掉它就是「填了不生效」，比报错更糟。节点配置界面上
        // 也写了这句话（`definitions.ts` 的字段描述）
        let body = match &notification.subtitle {
            Some(subtitle) if !subtitle.trim().is_empty() => {
                format!("{subtitle}\n{}", notification.body)
            }
            _ => notification.body.clone(),
        };

        let mut builder = self
            .app
            .notification()
            .builder()
            .title(&notification.title)
            .body(&body);

        // 点击跳回**这一次**运行。
        //
        // 没有这个的话，用户点开通知落在概览页上 —— 而他点的时候
        // 想看的是刚跑完的那一条。前端 `useTrayNavigation` 那套监听
        // 同一个事件名
        if notification.click_action == "open_run" {
            builder = builder.extra("route", format!("/runs/{}", notification.run_id));
        }

        builder
            .show()
            .map_err(|error| format!("系统没有接受这条通知：{error}"))
    }
}
