//! 定时触发的扫描循环。
//!
//! 纯逻辑（怎么算下一次、该不该跑）在 `aiwf_engine::schedule`，
//! 这里只管「定期扫一遍所有工作流，到点的跑起来」。
//!
//! ## 为什么住在 core-api
//!
//! 它要同时够得着 `Store`（读工作流与上次触发时间）和 `Supervisor`
//! （把运行起起来），而 `run_start` 里那套「入口节点固定工作目录压过
//! 调用方」的规则也只在 core-api 有 —— 调度器绕过去自己 `Supervisor::start`
//! 的话，定时跑出来的运行工作目录会和手动跑的不一样，而没人会想到去查这个。
//!
//! ## 只跑已发布的版本
//!
//! 草稿是可变的。定时跑一份正在编辑的图，用户改到一半时它就跑起来了 ——
//! 这在半夜发生一次就足够让人不敢再用定时。没发布过版本的工作流直接跳过，
//! 界面上要说清楚这一条（`WorkflowsPage` 的定时徽章）。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration as StdDuration;

use aiwf_engine::schedule::{self, Trigger};
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use chrono::{DateTime, Duration, Local};

/// 两次扫描的间隔。
///
/// 一分钟：契约允许的最小间隔就是 1 分钟，扫描比它慢就会漏。
pub const SCAN_INTERVAL: StdDuration = StdDuration::from_secs(60);

/// 宽限期 —— 触发点落在两次扫描之间是常态，超过这个就算错过。
///
/// 取扫描间隔的三倍：机器休眠、数据库锁竞争都会让某一轮扫描迟到，
/// 而「迟到两分钟就当作没到过」会让定时任务时不时无声地跳过一天。
pub const GRACE: Duration = Duration::seconds(180);

/// 一个工作流这一轮的判定结果。给测试和日志用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 手动触发的工作流，不归调度器管。
    Manual,
    /// 没发布过版本 —— 跳过，并且**要让用户知道**。
    NoPublishedVersion,
    /// 图读不出来或触发配置不合法。
    Unreadable(String),
    /// 还没到点。
    NotYet,
    /// 该跑了，带上从 inputSchema 默认值算出来的入参。
    Fire(Trigger, serde_json::Value),
    /// 到点了，但必填参数填不出来 —— 定时没有人在场填表。
    ///
    /// **不硬跑**：跑出去必然死在第一个用到参数的节点上，
    /// 而用户看到的是「每天一条失败运行」，查不到原因。
    MissingInputs(Vec<String>),
}

/// 定时起运行时的入参：从入口的 `inputSchema` 取每个字段的 `default`。
///
/// **这是定时触发唯一的参数来源。** 没有人在场填表 —— 原来这里写死
/// `"{}"`，于是任何有必填参数的工作流一到点就死在第二个节点上
/// （`未定义的引用 ${input.repo.name}`）。手动点运行则一切正常，
/// 所以实跑记录里看不出来（独立复核抓到的）。
///
/// 缺默认值的必填字段由 `validateGraph` 在**发布时**就拦下
/// （`TRIGGER_INPUT_NO_DEFAULT`），走到这里的图不该再有那种字段；
/// 真有的话下面 `missing_required` 会把它报出来而不是硬跑。
#[must_use]
pub fn inputs_from_defaults(config: &serde_json::Value) -> serde_json::Value {
    let mut inputs = serde_json::Map::new();
    let Some(properties) = config
        .get("inputSchema")
        .and_then(|schema| schema.get("properties"))
        .and_then(serde_json::Value::as_object)
    else {
        return serde_json::Value::Object(inputs);
    };
    for (key, spec) in properties {
        if let Some(value) = spec.get("default") {
            inputs.insert(key.clone(), value.clone());
        }
    }
    serde_json::Value::Object(inputs)
}

/// 必填却没有默认值的字段。定时触发填不出它们。
#[must_use]
pub fn missing_required(config: &serde_json::Value) -> Vec<String> {
    let schema = config.get("inputSchema");
    let properties = schema.and_then(|s| s.get("properties"));
    schema
        .and_then(|s| s.get("required"))
        .and_then(serde_json::Value::as_array)
        .map(|required| {
            required
                .iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|key| {
                    properties
                        .and_then(|p| p.get(*key))
                        .and_then(|spec| spec.get("default"))
                        .is_none()
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 单个工作流这一轮该怎么办。**纯函数**，不碰数据库也不碰时钟 ——
/// 所有判定分支都能在测试里走到。
///
/// `anchor` 是这份版本的发布时刻。间隔触发从它起算 ——
/// 语义是「发布之后每 N 分钟一次」，而不是「进程启动之后」：
/// 后者会让每次重启都把节奏重置一遍，而重启是常事。
#[must_use]
pub fn decide(
    graph_json: Option<&str>,
    anchor: DateTime<Local>,
    now: DateTime<Local>,
    last_auto: Option<DateTime<Local>>,
) -> Decision {
    let Some(graph_json) = graph_json else {
        return Decision::NoPublishedVersion;
    };
    let graph: serde_json::Value = match serde_json::from_str(graph_json) {
        Ok(value) => value,
        Err(error) => return Decision::Unreadable(format!("图数据无法解析：{error}")),
    };
    let entry = graph
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .and_then(|nodes| {
            nodes
                .iter()
                .find(|node| node.get("type").and_then(serde_json::Value::as_str) == Some("entry"))
        });
    let Some(config) = entry.and_then(|node| node.get("config")) else {
        return Decision::Unreadable("这份图里没有入口节点".to_string());
    };

    let trigger = match Trigger::from_entry_config(config) {
        Ok(trigger) => trigger,
        Err(why) => return Decision::Unreadable(why),
    };
    if !trigger.is_automatic() {
        return Decision::Manual;
    }
    if !schedule::due(&trigger, now, anchor, last_auto, GRACE) {
        return Decision::NotYet;
    }
    let missing = missing_required(config);
    if !missing.is_empty() {
        return Decision::MissingInputs(missing);
    }
    Decision::Fire(trigger, inputs_from_defaults(config))
}

/// 后台扫描线程的把手。丢掉它会停掉线程 —— 桌面壳与 devserver
/// 都把它一直拿着。
pub struct Scheduler {
    stop: Arc<AtomicBool>,
}

impl Scheduler {
    /// 起一条后台线程，每 [`SCAN_INTERVAL`] 扫一遍。
    ///
    /// **只由执行宿主调**（桌面壳、devserver）。共库的 MCP server 不要起 ——
    /// 两个进程各起一个调度器，同一个定时任务会跑两遍。
    #[must_use]
    pub fn start(db_path: std::path::PathBuf, supervisor: Arc<Supervisor>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        std::thread::spawn(move || {
            // 自己开一条连接：主线程那条被 Mutex 守着，
            // 扫描一次要占住它一小会儿，而界面的每一次查询都在等那把锁
            let store = match Store::open(&db_path) {
                Ok(store) => store,
                Err(error) => {
                    eprintln!("[aiwf] 调度器没起来，定时触发不会生效：{error}");
                    return;
                }
            };
            let data_dir = db_path
                .parent()
                .map_or_else(std::env::temp_dir, std::path::Path::to_path_buf);
            while !flag.load(Ordering::Relaxed) {
                std::thread::sleep(SCAN_INTERVAL);
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                scan_once(&store, &supervisor, &data_dir);
            }
        });
        Self { stop }
    }

    /// 停掉扫描。下一轮醒来时退出，最多等一个 [`SCAN_INTERVAL`]。
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 扫一遍。错误一律只打日志不中断 —— 一个坏掉的工作流不能让
/// 其余的定时任务全部停摆。
fn scan_once(store: &Store, supervisor: &Supervisor, data_dir: &std::path::Path) {
    let workflows = match store.list_workflows() {
        Ok(list) => list,
        Err(error) => {
            eprintln!("[aiwf] 调度器读不到工作流清单：{error}");
            return;
        }
    };
    let now = Local::now();

    for workflow in workflows {
        if workflow.archived {
            continue;
        }
        // 只看已发布的最新版本，草稿不参与定时（见模块头）
        let published = match store.latest_version(&workflow.id) {
            Ok(version) => version,
            Err(error) => {
                eprintln!("[aiwf] 调度器读不到 {} 的版本：{error}", workflow.id);
                continue;
            }
        };
        let last_auto = store
            .last_auto_run_at(&workflow.id)
            .ok()
            .flatten()
            .and_then(|iso| parse_iso_local(&iso));

        // 间隔触发的起算点：这份版本什么时候发布的
        let anchor = published
            .as_ref()
            .and_then(|v| parse_iso_local(&v.published_at))
            .unwrap_or(now);

        match decide(
            published.as_ref().map(|v| v.graph_json.as_str()),
            anchor,
            now,
            last_auto,
        ) {
            Decision::MissingInputs(missing) => {
                eprintln!(
                    "[aiwf] {} 到点了但填不出必填参数（{}），没有起运行 —— \
                     定时触发没有人在场填表，给这些字段配上默认值",
                    workflow.name,
                    missing.join("、")
                );
            }
            Decision::Fire(trigger, inputs) => {
                // published 一定是 Some —— Fire 只可能从「有图」那条路出来
                let Some(version) = published else { continue };
                match crate::run_start(
                    store,
                    supervisor,
                    data_dir,
                    workflow.id.clone(),
                    Some(version.id),
                    None,
                    inputs.to_string(),
                    None,
                    trigger,
                ) {
                    Ok(run_id) => println!(
                        "[aiwf] 定时触发 {}（{}）→ {run_id}",
                        workflow.name,
                        trigger.describe()
                    ),
                    Err(error) => eprintln!("[aiwf] 定时触发 {} 失败：{error:?}", workflow.name),
                }
            }
            Decision::Unreadable(why) => {
                eprintln!("[aiwf] {} 的触发配置读不出来，跳过：{why}", workflow.name);
            }
            Decision::Manual | Decision::NoPublishedVersion | Decision::NotYet => {}
        }
    }
}

/// 存储层写的是 UTC ISO（`now_iso`），这里换回本地时刻做比较。
fn parse_iso_local(iso: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|dt| dt.with_timezone(&Local))
}

#[cfg(test)]
// 测试里 unwrap / expect / panic 是表达断言的方式；生产代码那条禁令不适用
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn local(h: u32, mi: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 8, 2, h, mi, 0)
            .single()
            .expect("测试时刻在本机时区里应当唯一")
    }

    /// 发布时刻。间隔触发从它起算。
    fn anchor() -> DateTime<Local> {
        local(9, 0)
    }

    fn graph(entry_config: serde_json::Value) -> String {
        serde_json::json!({
            "nodes": [
                { "id": "entry_1", "type": "entry", "position": {"x": 0, "y": 0},
                  "config": entry_config },
            ],
            "edges": [],
        })
        .to_string()
    }

    #[test]
    fn 没发布过版本的工作流不会被定时跑() {
        // 草稿是可变的，半夜跑一份改到一半的图是最糟的形态
        assert_eq!(
            decide(None, anchor(), local(9, 31), None),
            Decision::NoPublishedVersion
        );
    }

    #[test]
    fn 手动触发的工作流不归调度器管() {
        let json = graph(serde_json::json!({ "trigger": "manual", "inputSchema": {} }));
        assert_eq!(
            decide(Some(&json), anchor(), local(9, 31), None),
            Decision::Manual
        );
    }

    #[test]
    fn 到点的定时工作流会被点火() {
        let json = graph(serde_json::json!({
            "trigger": "schedule", "scheduleTime": "09:30", "inputSchema": {}
        }));
        assert_eq!(
            decide(Some(&json), anchor(), local(9, 31), None),
            Decision::Fire(
                Trigger::Daily {
                    hour: 9,
                    minute: 30
                },
                serde_json::json!({})
            )
        );
    }

    #[test]
    fn 没到点就不点火() {
        let json = graph(serde_json::json!({
            "trigger": "schedule", "scheduleTime": "09:30", "inputSchema": {}
        }));
        assert_eq!(
            decide(Some(&json), anchor(), local(9, 0), None),
            Decision::NotYet
        );
    }

    #[test]
    fn 刚跑过就不会在同一轮再跑一次() {
        // 扫描间隔一分钟、宽限三分钟 —— 没有这条判断，
        // 一个 09:30 的定时任务会连着跑三轮
        let json = graph(serde_json::json!({
            "trigger": "schedule", "scheduleTime": "09:30", "inputSchema": {}
        }));
        let fired = local(9, 30);
        assert_eq!(
            decide(Some(&json), anchor(), local(9, 32), Some(fired)),
            Decision::NotYet
        );
    }

    #[test]
    fn 触发配置不合法时报出来而不是静默跳过() {
        // 静默跳过 = 用户设了定时、什么都没发生、日志里也没有痕迹
        let json = graph(serde_json::json!({ "trigger": "schedule", "inputSchema": {} }));
        let Decision::Unreadable(why) = decide(Some(&json), anchor(), local(9, 31), None) else {
            panic!("缺 scheduleTime 应当报 Unreadable");
        };
        assert!(why.contains("scheduleTime"), "{why}");
    }

    #[test]
    fn 没有入口节点的图报出来() {
        let json = serde_json::json!({ "nodes": [], "edges": [] }).to_string();
        let Decision::Unreadable(why) = decide(Some(&json), anchor(), local(9, 31), None) else {
            panic!("没有入口节点应当报 Unreadable");
        };
        assert!(why.contains("入口"), "{why}");
    }

    #[test]
    fn 间隔触发按上次自动运行起算() {
        let json = graph(serde_json::json!({
            "trigger": "interval", "intervalMinutes": 30, "inputSchema": {}
        }));
        assert_eq!(
            decide(Some(&json), anchor(), local(9, 31), Some(local(9, 0))),
            Decision::Fire(Trigger::Interval { minutes: 30 }, serde_json::json!({}))
        );
        assert_eq!(
            decide(Some(&json), anchor(), local(9, 20), Some(local(9, 0))),
            Decision::NotYet
        );
    }

    #[test]
    fn 从没跑过的间隔触发_一个间隔之后会点火() {
        /*
         * **这条是实跑抓出来的缺口。**
         *
         * 上一版实现里 `next_fire_at` 对 `last = None` 的间隔触发返回
         * 「当刻 + 一个间隔」，每次扫描都是未来时刻，永远不到点。
         * 实跑五分钟一条运行都没有，而这一层的九条用例全绿 ——
         * 没有一条覆盖「发布之后从没自动跑过、等够一个间隔」。
         */
        let json = graph(serde_json::json!({
            "trigger": "interval", "intervalMinutes": 30, "inputSchema": {}
        }));
        assert_eq!(
            decide(Some(&json), anchor(), local(9, 31), None),
            Decision::Fire(Trigger::Interval { minutes: 30 }, serde_json::json!({})),
            "发布之后从没自动跑过的工作流，等够一个间隔必须跑起来"
        );
    }

    #[test]
    fn 定时起运行时带上入参默认值() {
        /*
         * **这条是独立复核抓到的。**
         *
         * 原来调度器起运行时 inputsJson 写死 `"{}"`，于是任何有必填参数
         * 的工作流一到点就死在第二个节点上（`未定义的引用 ${input.repo}`）。
         * 手动点运行填表则一切正常 —— 所以实跑记录里完全看不出来，
         * 而四条定时模板全都有必填参数。
         */
        let json = graph(serde_json::json!({
            "trigger": "schedule", "scheduleTime": "09:30",
            "inputSchema": {
                "type": "object",
                "required": ["repo"],
                "properties": {
                    "repo": { "type": "string", "default": "cli/cli" },
                    "days": { "type": "string", "default": "7" },
                    "note": { "type": "string" }
                }
            }
        }));
        let Decision::Fire(_, inputs) = decide(Some(&json), anchor(), local(9, 31), None) else {
            panic!("到点了却没点火");
        };
        assert_eq!(inputs["repo"], "cli/cli");
        assert_eq!(inputs["days"], "7");
        assert!(
            inputs.get("note").is_none(),
            "没有默认值的可选字段不该凭空造一个出来"
        );
    }

    #[test]
    fn 必填字段没有默认值时不硬跑_而是报出来() {
        // 硬跑的话用户每天收到一条失败运行，而失败原因在第二个节点里，
        // 查到的是「未定义的引用」，看不出根因是「定时没人填表」
        let json = graph(serde_json::json!({
            "trigger": "schedule", "scheduleTime": "09:30",
            "inputSchema": {
                "type": "object",
                "required": ["repo", "path"],
                "properties": { "repo": { "type": "string", "default": "x" } }
            }
        }));
        let Decision::MissingInputs(missing) = decide(Some(&json), anchor(), local(9, 31), None)
        else {
            panic!("填不出必填参数却点火了");
        };
        assert_eq!(missing, vec!["path".to_string()]);
    }

    #[test]
    fn 宽限期比扫描间隔宽() {
        // 相等的话，一次迟到的扫描就会让那天的触发无声消失
        assert!(
            GRACE.num_seconds() > SCAN_INTERVAL.as_secs() as i64,
            "宽限期必须比扫描间隔宽，否则迟到一轮就漏一次触发"
        );
    }
}
