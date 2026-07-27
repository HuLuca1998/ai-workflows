//! 托盘与窗口关闭策略。
//!
//! GUI 行为本身没法在单测里跑，所以把「决策」从「执行」里剥出来：
//! 菜单项清单、菜单 id → 动作的映射、关闭时该隐藏还是该退出，
//! 这些都是纯逻辑，必须能单独验证——否则每改一次都得靠手点。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_desktop_lib::tray::{
    CloseBehavior, TRAY_MENU, TrayAction, close_behavior, resolve_menu_action,
};

#[test]
fn 托盘菜单包含用户需要的三项() {
    let ids: Vec<&str> = TRAY_MENU.iter().map(|item| item.id).collect();
    assert_eq!(ids, vec!["show", "check-update", "quit"]);
}

#[test]
fn 每个菜单项都有可读标签() {
    for item in TRAY_MENU {
        assert!(!item.label.is_empty(), "{} 缺标签", item.id);
    }
}

#[test]
fn 退出项明确写出是彻底退出_而不是关窗() {
    let quit = TRAY_MENU.iter().find(|i| i.id == "quit").unwrap();
    assert!(
        quit.label.contains("退出"),
        "退出项的文案要让用户明白这次是真的结束进程：{}",
        quit.label
    );
}

#[test]
fn 菜单_id_映射到对应动作() {
    assert_eq!(resolve_menu_action("show"), TrayAction::ShowWindow);
    assert_eq!(resolve_menu_action("check-update"), TrayAction::CheckUpdate);
    assert_eq!(resolve_menu_action("quit"), TrayAction::Quit);
}

#[test]
fn 未知菜单_id_不当成退出处理() {
    // 一个拼错的 id 绝不能意外触发退出：正在等审批的运行会被打断
    assert_eq!(resolve_menu_action("qui"), TrayAction::Unknown);
    assert_eq!(resolve_menu_action(""), TrayAction::Unknown);
}

#[test]
fn 关闭窗口默认只是隐藏到托盘() {
    // 这是个会挂着等审批数小时的工具，点红叉不该丢掉正在跑的运行
    assert_eq!(close_behavior(false), CloseBehavior::HideToTray);
}

#[test]
fn 用户从托盘选了退出之后_关闭窗口才真的退出() {
    assert_eq!(close_behavior(true), CloseBehavior::Exit);
}
