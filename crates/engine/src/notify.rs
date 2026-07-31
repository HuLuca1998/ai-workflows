//! 系统通知。
//!
//! 引擎**自己发不了通知** —— 它是个库，跑在没有桌面的地方也要能编译。
//! 所以这里只定义「一条通知长什么样」和「谁能把它发出去」，
//! 真正的实现由外壳注入（桌面壳用 `tauri-plugin-notification`）。
//!
//! 关键在于**没有注入实现时怎么办**：
//!
//! 这个节点原来与 `entry` / `end` 归在同一档，什么都不做直接返回成功。
//! 用户第一条能跑的工作流，最后一个节点是绿的、什么也不会发生 ——
//! 而 `executor.rs` 第 3 行写着「没实现的节点类型明确报『尚未实现』，
//! 绝不假装成功」。
//!
//! 现在没有发送器就明确失败。「这个环境发不了通知」是一句真话，
//! 「发送成功」不是。

/// 一条要发出去的通知。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: String,
    pub subtitle: Option<String>,
    pub body: String,
    /// 点击后跳到哪 —— `open_run` / `open_workflow` / `none`。
    pub click_action: String,
    /// 跳回**这一次**运行。少了它，点开通知只能落在运行列表上，
    /// 而用户点的时候想看的是刚刚跑完的那一条。
    pub run_id: String,
    /// 发出这条通知的节点。桌面壳据此拼跳转链接。
    pub node_id: String,
}

/// 谁能把通知发出去。
///
/// 桌面壳注入一个走 `tauri-plugin-notification` 的实现；
/// 无头环境（CI、devserver、单测）不注入，于是 `notify` 节点
/// 明确报「这个环境发不了」。
pub trait Notifier: Send + Sync {
    /// 发出去。返回 `Err` 时里面是**面向用户的**原因 ——
    /// 「用户拒绝了通知权限」比「NotificationError(3)」有用得多，
    /// 而这句话会原样出现在事件摘要里。
    fn send(&self, notification: &Notification) -> Result<(), String>;
}
