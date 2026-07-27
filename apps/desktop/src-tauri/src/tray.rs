//! 菜单栏（托盘）与关闭行为。
//!
//! 产品要求：点窗口红叉不退出，应用留在菜单栏继续跑；真要结束进程从菜单栏走。
//! 对一个会挂着等审批数小时的工具，这是必要的——误点红叉丢掉运行的代价太大。
//!
//! 这里只放决策逻辑（菜单清单、id → 动作、关闭时隐藏还是退出），
//! 执行部分在 lib.rs。这样 GUI 之外的部分能单测，见 tests/tray_test.rs。

/// 托盘菜单项。id 同时用于事件分发，改动要连带更新 tests/tray_test.rs。
pub struct TrayMenuItem {
    pub id: &'static str,
    pub label: &'static str,
}

pub const TRAY_MENU: &[TrayMenuItem] = &[
    TrayMenuItem {
        id: "show",
        label: "打开 AI Workflows",
    },
    TrayMenuItem {
        id: "check-update",
        label: "检查更新…",
    },
    TrayMenuItem {
        // 文案要说清这次是真的结束进程，与关窗区分开
        id: "quit",
        label: "退出（结束后台运行）",
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    ShowWindow,
    CheckUpdate,
    Quit,
    /// 未登记的 id。刻意单独一个分支：拼错的 id 绝不能落到 Quit 上。
    Unknown,
}

pub fn resolve_menu_action(id: &str) -> TrayAction {
    match id {
        "show" => TrayAction::ShowWindow,
        "check-update" => TrayAction::CheckUpdate,
        "quit" => TrayAction::Quit,
        _ => TrayAction::Unknown,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseBehavior {
    /// 隐藏窗口，进程继续跑（默认）。
    HideToTray,
    /// 用户已经从托盘明确要求退出。
    Exit,
}

pub fn close_behavior(quit_requested: bool) -> CloseBehavior {
    if quit_requested {
        CloseBehavior::Exit
    } else {
        CloseBehavior::HideToTray
    }
}
