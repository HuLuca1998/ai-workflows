//! Run / Node 状态机（Rust 侧）。
//!
//! 与 `@aiwf/contracts` 的 `state-machine.ts` 是同一份状态机的两种语言表达；
//! `tests/contract_sync_test.rs` 会对着契约生成物校验两边不漂移。

use std::fmt;

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(&self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some($name::$variant),)+
                    _ => None,
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

string_enum!(RunStatus {
    Created => "created",
    Preflight => "preflight",
    Queued => "queued",
    Running => "running",
    WaitingApproval => "waiting_approval",
    Paused => "paused",
    Interrupted => "interrupted",
    Resuming => "resuming",
    Succeeded => "succeeded",
    Failed => "failed",
    Cancelled => "cancelled",
});

string_enum!(NodeStatus {
    Idle => "idle",
    Queued => "queued",
    Running => "running",
    Waiting => "waiting",
    Succeeded => "succeeded",
    Failed => "failed",
    Skipped => "skipped",
    Cancelled => "cancelled",
});

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
        )
    }

    /// 重启后要在运行列表顶部提示「可恢复」的状态。
    pub fn is_resumable(self) -> bool {
        matches!(
            self,
            RunStatus::WaitingApproval | RunStatus::Paused | RunStatus::Interrupted
        )
    }

    pub fn can_transition_to(self, to: RunStatus) -> bool {
        use RunStatus::*;
        if self.is_terminal() {
            return false;
        }
        // 用户永远能叫停一个还没结束的运行
        if to == Cancelled {
            return true;
        }
        matches!(
            (self, to),
            (Created, Preflight)
                | (Preflight, Queued)
                | (Preflight, Failed)
                | (Queued, Running)
                | (Running, WaitingApproval)
                | (Running, Paused)
                | (Running, Interrupted)
                | (Running, Succeeded)
                | (Running, Failed)
                | (WaitingApproval, Running)
                | (WaitingApproval, Paused)
                | (WaitingApproval, Interrupted)
                | (WaitingApproval, Failed)
                | (Paused, Running)
                | (Paused, Interrupted)
                | (Interrupted, Resuming)
                | (Resuming, Running)
                | (Resuming, Failed)
        )
    }
}

impl NodeStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            NodeStatus::Succeeded | NodeStatus::Skipped | NodeStatus::Cancelled
        )
    }

    pub fn can_transition_to(self, to: NodeStatus) -> bool {
        use NodeStatus::*;
        matches!(
            (self, to),
            (Idle, Queued)
                | (Idle, Skipped)
                | (Idle, Cancelled)
                | (Queued, Running)
                | (Queued, Skipped)
                | (Queued, Cancelled)
                | (Running, Waiting)
                | (Running, Succeeded)
                | (Running, Failed)
                | (Running, Cancelled)
                | (Waiting, Running)
                | (Waiting, Failed)
                | (Waiting, Cancelled)
                // 从失败节点重试：产生新的 attempt
                | (Failed, Queued)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 终态没有出边() {
        for status in RunStatus::ALL.iter().copied().filter(|s| s.is_terminal()) {
            for to in RunStatus::ALL.iter().copied() {
                assert!(!status.can_transition_to(to), "{status} → {to} 不该被允许");
            }
        }
    }

    #[test]
    fn 非终态都可取消() {
        for status in RunStatus::ALL.iter().copied().filter(|s| !s.is_terminal()) {
            assert!(status.can_transition_to(RunStatus::Cancelled));
        }
    }

    #[test]
    fn 不能跳过_preflight_直接开跑() {
        assert!(!RunStatus::Created.can_transition_to(RunStatus::Running));
        assert!(!RunStatus::Created.can_transition_to(RunStatus::Queued));
    }

    #[test]
    fn 失败节点可以重试() {
        assert!(NodeStatus::Failed.can_transition_to(NodeStatus::Queued));
        assert!(!NodeStatus::Failed.is_terminal());
    }

    #[test]
    fn 字符串往返() {
        for status in RunStatus::ALL {
            assert_eq!(RunStatus::parse(status.as_str()), Some(*status));
        }
        for status in NodeStatus::ALL {
            assert_eq!(NodeStatus::parse(status.as_str()), Some(*status));
        }
        assert_eq!(RunStatus::parse("不存在的状态"), None);
    }
}
