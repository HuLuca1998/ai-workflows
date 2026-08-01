//! 入口节点的触发方式 —— 从「填了不生效」到真的会跑。
//!
//! 这个模块出现之前，契约 `entry.trigger` 有五个枚举值，Rust 侧
//! `grep trigger` **零命中**。用户在画布上把入口设成 `schedule`，
//! 节点上老老实实显示「触发：schedule」，到点什么都不会发生，
//! 也没有任何地方告诉他不会发生 —— CLAUDE.md 第二条纪律的第二种形态。
//!
//! 跨侧守卫在 `tests/trigger_reach_test.rs`：契约里能选的每一种，
//! 这里都得认得，否则红。
//!
//! ## 两条语义，先说清楚
//!
//! **一、只在应用开着的时候触发，错过就是错过。**
//! 不补跑。补跑意味着开机瞬间一口气冒出七条运行，而用户以为
//! 昨晚那次没跑成 —— 惊吓大于价值。界面上要直说这一条。
//!
//! **二、第一次不立刻跑。** `last = None` 时等到下一个触发点，
//! 而不是「从没跑过 ⇒ 现在就该跑」。否则每次重启应用，所有定时
//! 工作流都会在启动那一刻齐刷刷跑一遍。

use chrono::{DateTime, Duration, Local, NaiveTime, TimeZone};
use serde_json::Value;

/// 契约里声明了、但调度器故意不接的触发方式。
///
/// 空 = 契约的枚举里每一种都接上了。往里加条目必须写明理由 ——
/// 守卫会检查理由非空（照 `crates/mcp/src/catalog.rs` 的
/// `DELIBERATELY_HIDDEN` 那个写法）。
pub const DELIBERATELY_UNSCHEDULED: &[(&str, &str)] = &[];

/// 入口节点的触发方式。契约 `entry.trigger` 的镜像。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// 只有人点「运行」才跑。
    Manual,
    /// 每天固定时刻，**本机时区**。
    Daily { hour: u32, minute: u32 },
    /// 每隔 N 分钟。
    Interval { minutes: u32 },
}

impl Trigger {
    /// 契约里对应的枚举值。
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Daily { .. } => "schedule",
            Self::Interval { .. } => "interval",
        }
    }

    /// 会自己跑起来吗。`Manual` 不会 —— 调度器直接跳过它。
    #[must_use]
    pub fn is_automatic(&self) -> bool {
        !matches!(self, Self::Manual)
    }

    /// 从入口节点的 config 解析。
    ///
    /// **认不出的一律报错，绝不静默降级成 Manual**：降级的后果是
    /// 定时任务不跑而界面上一切正常 —— 那正是这个模块要消灭的形态。
    pub fn from_entry_config(config: &Value) -> Result<Self, String> {
        // 缺字段按契约的 default 走（Zod 那边 `.default('manual')`）
        let kind = config
            .get("trigger")
            .and_then(Value::as_str)
            .unwrap_or("manual");
        match kind {
            "manual" => Ok(Self::Manual),
            "schedule" => {
                let raw = config
                    .get("scheduleTime")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "触发方式是 schedule，但没填 scheduleTime".to_string())?;
                let (hour, minute) = parse_hhmm(raw)?;
                Ok(Self::Daily { hour, minute })
            }
            "interval" => {
                let minutes = config
                    .get("intervalMinutes")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "触发方式是 interval，但没填 intervalMinutes".to_string())?;
                if minutes == 0 {
                    return Err("间隔不能是 0 分钟".to_string());
                }
                let minutes = u32::try_from(minutes).map_err(|_| "间隔太大".to_string())?;
                Ok(Self::Interval { minutes })
            }
            other => Err(format!(
                "认不出的触发方式 {other}。契约的枚举加了新值而调度器没跟上 —— \
                 见 crates/engine/src/schedule.rs"
            )),
        }
    }

    /// 给人看的一句话。工作流列表、入口节点、运行来源都用它。
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Manual => "手动触发".to_string(),
            Self::Daily { hour, minute } => format!("每天 {hour:02}:{minute:02}"),
            Self::Interval { minutes } => {
                if *minutes >= 60 && minutes % 60 == 0 {
                    format!("每 {} 小时", minutes / 60)
                } else {
                    format!("每 {minutes} 分钟")
                }
            }
        }
    }
}

fn parse_hhmm(raw: &str) -> Result<(u32, u32), String> {
    let malformed = || format!("时刻要写成 HH:MM，收到 {raw}");
    let (h, m) = raw.split_once(':').ok_or_else(malformed)?;
    let hour: u32 = h.parse().map_err(|_| malformed())?;
    let minute: u32 = m.parse().map_err(|_| malformed())?;
    if hour > 23 || minute > 59 {
        return Err(format!("{raw} 不是一个合法时刻"));
    }
    Ok((hour, minute))
}

/// 把本地日期 + 时刻拼成一个绝对时刻。
///
/// 夏令时那一小时里，某个本地时刻可能**不存在**或**有两个**。
/// 两种都返回 `None`，由调用方跳到下一天 —— 一年一次的边界不值得猜。
fn at_local(date: chrono::NaiveDate, at: NaiveTime) -> Option<DateTime<Local>> {
    Local.from_local_datetime(&date.and_time(at)).single()
}

/// 下一次该跑的时刻（本机时区）。`Manual` 返回 `None`。
///
/// `last` 是**上一次真的跑起来**的时刻。`None` 表示这个进程还没让它跑过 ——
/// 此时也不立刻跑（见模块头第二条），而是从 `now` 往后找第一个触发点。
#[must_use]
pub fn next_fire_at(
    trigger: &Trigger,
    now: DateTime<Local>,
    last: Option<DateTime<Local>>,
) -> Option<DateTime<Local>> {
    match trigger {
        Trigger::Manual => None,
        Trigger::Daily { hour, minute } => {
            let at = NaiveTime::from_hms_opt(*hour, *minute, 0)?;
            let today = now.date_naive();
            let tomorrow = || at_local(today + Duration::days(1), at);
            match at_local(today, at) {
                // 今天这个点还没到 —— 就是它
                Some(point) if point > now => Some(point),
                // 已经过了：跑过就等明天，没跑过就是它（宽限判断交给 `due`）
                Some(point) => {
                    if last.is_some_and(|l| l >= point) {
                        tomorrow()
                    } else {
                        Some(point)
                    }
                }
                // 夏令时空档，跳过这一天
                None => tomorrow(),
            }
        }
        // 没跑过就从「现在」起算，而不是立刻跑
        Trigger::Interval { minutes } => {
            Some(last.unwrap_or(now) + Duration::minutes(i64::from(*minutes)))
        }
    }
}

/// 一次扫描里，现在该不该把它跑起来。
///
/// `grace` 是宽限期：扫描是按固定间隔轮询的，触发点必然落在两次扫描之间。
/// 超过宽限就当作**错过**，不补跑 —— 应用关了一整天，第二天开机
/// 不该冒出一串昨天的运行。
#[must_use]
pub fn due(
    trigger: &Trigger,
    now: DateTime<Local>,
    last: Option<DateTime<Local>>,
    grace: Duration,
) -> bool {
    let Some(at) = next_fire_at(trigger, now, last) else {
        return false;
    };
    at <= now && now - at <= grace
}

#[cfg(test)]
// 测试里 unwrap / expect / panic 是表达断言的方式；生产代码那条禁令不适用
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};
    use serde_json::json;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .expect("测试用的时刻在本机时区里应当唯一")
    }

    const GRACE: Duration = Duration::minutes(5);

    #[test]
    fn 缺_trigger_字段按契约的默认值当手动() {
        let parsed = Trigger::from_entry_config(&json!({ "inputSchema": {} })).expect("要能解析");
        assert_eq!(parsed, Trigger::Manual);
    }

    #[test]
    fn 定时触发要带时刻否则报错而不是当手动() {
        let err = Trigger::from_entry_config(&json!({ "trigger": "schedule" }))
            .expect_err("没填时刻必须报错");
        assert!(
            err.contains("scheduleTime"),
            "报错要指出缺的是哪个字段：{err}"
        );
    }

    #[test]
    fn 时刻格式不对报错() {
        let err =
            Trigger::from_entry_config(&json!({ "trigger": "schedule", "scheduleTime": "25:00" }))
                .expect_err("25 点不是时刻");
        assert!(err.contains("25:00"), "{err}");
    }

    #[test]
    fn 间隔为零报错() {
        let err =
            Trigger::from_entry_config(&json!({ "trigger": "interval", "intervalMinutes": 0 }))
                .expect_err("0 分钟间隔会把 CPU 跑满");
        assert!(err.contains('0'), "{err}");
    }

    #[test]
    fn 手动触发不会自己跑() {
        let now = local(2026, 8, 2, 9, 0);
        assert!(!Trigger::Manual.is_automatic());
        assert_eq!(next_fire_at(&Trigger::Manual, now, None), None);
        assert!(!due(&Trigger::Manual, now, None, GRACE));
    }

    #[test]
    fn 每天定时从没跑过时也不在启动那一刻跑() {
        // 模块头第二条语义。没有它，每次重启应用所有定时工作流
        // 都会在启动瞬间齐刷刷跑一遍
        let trigger = Trigger::Daily {
            hour: 12,
            minute: 0,
        };
        assert!(!due(&trigger, local(2026, 8, 2, 9, 0), None, GRACE));
    }

    #[test]
    fn 每天定时到点就跑() {
        let trigger = Trigger::Daily {
            hour: 9,
            minute: 30,
        };
        // 扫描发生在 09:31，触发点是 09:30 —— 落在宽限内
        assert!(due(&trigger, local(2026, 8, 2, 9, 31), None, GRACE));
    }

    #[test]
    fn 错过太久就不补跑() {
        let trigger = Trigger::Daily {
            hour: 9,
            minute: 30,
        };
        // 应用晚上八点才打开，早上那个点已经过去十个多小时
        assert!(
            !due(&trigger, local(2026, 8, 2, 20, 0), None, GRACE),
            "补跑会让用户在晚上八点收到一条以为早上跑过的运行"
        );
    }

    #[test]
    fn 同一天不会跑第二次() {
        let trigger = Trigger::Daily {
            hour: 9,
            minute: 30,
        };
        let fired = local(2026, 8, 2, 9, 31);
        // 下一次扫描（一分钟后）不能再跑一遍
        assert!(!due(&trigger, local(2026, 8, 2, 9, 32), Some(fired), GRACE));
        // 下一次是明天同一时刻
        let next =
            next_fire_at(&trigger, local(2026, 8, 2, 9, 32), Some(fired)).expect("要有下一次");
        assert_eq!(next.day(), 3);
        assert_eq!((next.hour(), next.minute()), (9, 30));
    }

    #[test]
    fn 间隔触发从上次跑完起算() {
        let trigger = Trigger::Interval { minutes: 30 };
        let fired = local(2026, 8, 2, 9, 0);
        assert!(!due(&trigger, local(2026, 8, 2, 9, 20), Some(fired), GRACE));
        assert!(due(&trigger, local(2026, 8, 2, 9, 31), Some(fired), GRACE));
    }

    #[test]
    fn 间隔触发第一次也等一个间隔() {
        let trigger = Trigger::Interval { minutes: 30 };
        assert!(!due(&trigger, local(2026, 8, 2, 9, 0), None, GRACE));
    }

    #[test]
    fn 描述给人看得懂的话() {
        assert_eq!(
            Trigger::Daily { hour: 9, minute: 5 }.describe(),
            "每天 09:05"
        );
        assert_eq!(Trigger::Interval { minutes: 120 }.describe(), "每 2 小时");
        assert_eq!(Trigger::Interval { minutes: 45 }.describe(), "每 45 分钟");
    }
}
