//! B-2 的接缝守卫：契约声明的每个事件类型，引擎侧要有发射点。
//!
//! 曾经的形态：契约定义 51 类、前端投影 32 类且测得很认真、引擎只发 31 类 ——
//! 三处各自「完成」，接缝断着，三处的绿灯合起来像一条通的链路。
//! 契约测试只验 Schema 与流不变量，没有任何测试问「这个类型有人发吗」。
//!
//! 守卫是**双向**的：零发射的必须在白名单里写明理由；
//! 接上发射点之后白名单没删，这里也红 —— 白名单永远是现状的精确清单。
//!
//! 扫描的前提是发射点都写字面量。`format!` 拼事件名会让扫描失明，
//! 所以第三条测试守住「没有拼接发射」。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::path::PathBuf;

/// 有意（或暂时）不发射的事件类型。**每条要么写着「机制未实现」，
/// 要么写着「待补发射点」—— 后者是 B-2 的剩余清单，接上一个删一行。**
const NOT_YET_EMITTED: &[(&str, &str)] = &[
    ("run.paused", "暂停机制整体未实现：引擎没有暂停入口"),
    (
        "run.resumed",
        "同上 —— resume 直接回 running，不经 resumed 事件",
    ),
    ("node.queued", "调度器单线程逐节点推进，没有独立的入队阶段"),
    (
        "node.retried",
        "重试机制未实现（run.retryNode 也不在 COMMANDS，见 L-4）",
    ),
    ("node.skipped", "调度器跳过不可达分支但不留痕 —— 待补发射点"),
    (
        "node.cancelled",
        "待补发射点，且界面已承诺（NodeConfigDialog「先停子进程再写 node.cancelled」）—— B-2 优先级最高的一条",
    ),
    (
        "conversation.agent_delta",
        "流式断在 core-api（B-8 H-2），修通之前没有增量可发",
    ),
    ("approval.reminded", "reminderAfterMs 字段未实现（B-5）"),
    ("approval.expired", "waitStrategy 字段未实现（B-5）"),
    ("artifact.created", "产物真的在落盘 —— 待补发射点"),
    ("artifact.truncated", "截断真的在做 —— 待补发射点"),
    ("system.checkpoint_saved", "检查点真的在落 —— 待补发射点"),
    ("system.memory_written", "记忆提议写入已实现 —— 待补发射点"),
    ("system.prompt_resolved", "提示词库还没接上执行路径（B-3）"),
    (
        "system.permission_granted",
        "权限档在拦但不留痕 —— 待补发射点",
    ),
    ("system.permission_denied", "同上"),
    (
        "system.redaction_applied",
        "脱敏真的在做（三道）—— 待补发射点",
    ),
    ("system.session_rebuilt", "会话重建机制未实现"),
    ("system.audit", "audited:true 的方法审计没有落点机制"),
];

fn contract_event_types() -> BTreeSet<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/generated/contracts.meta.json");
    let raw = std::fs::read_to_string(&path).expect("先跑 pnpm contracts:gen");
    let meta: serde_json::Value = serde_json::from_str(&raw).unwrap();
    meta["eventTypes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

/// 引擎侧三处会写事件的源码，整目录读进来。
fn emission_sources() -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut all = String::new();
    for dir in [
        "crates/engine/src",
        "crates/core-api/src",
        "crates/store/src",
    ] {
        collect_rs(&root.join(dir), &mut all);
    }
    all
}

fn collect_rs(dir: &std::path::Path, out: &mut String) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push_str(&std::fs::read_to_string(&path).unwrap());
        }
    }
}

#[test]
fn 每个契约事件类型要么有发射点_要么在白名单里写明理由() {
    let sources = emission_sources();
    let whitelist: BTreeSet<&str> = NOT_YET_EMITTED.iter().map(|(t, _)| *t).collect();

    for event_type in contract_event_types() {
        let emitted = sources.contains(&format!("\"{event_type}\""));
        let whitelisted = whitelist.contains(event_type.as_str());

        assert!(
            emitted || whitelisted,
            "事件类型 {event_type} 没有任何发射点，也不在白名单里 ——\n\
             契约声明了、前端可能已写好投影，而引擎永远不会发它。\n\
             要么补发射点，要么进 NOT_YET_EMITTED 并写明理由"
        );
        assert!(
            !(emitted && whitelisted),
            "事件类型 {event_type} 已经有发射点了，但还挂在白名单里 —— 删掉那一行"
        );
    }
}

#[test]
fn 白名单里没有契约之外的类型() {
    let types = contract_event_types();
    for (event_type, _) in NOT_YET_EMITTED {
        assert!(
            types.contains(*event_type),
            "白名单里的 {event_type} 不在契约里 —— 契约删了类型要同步删这里"
        );
    }
}

#[test]
fn 没有拼接发射_扫描才可信() {
    // 发射点都写字面量是上面那条守卫成立的前提。
    // `format!("node.{...}")` 这类拼法会让字面量扫描失明。
    let sources = emission_sources();
    for prefix in ["run.", "node.", "system.", "approval.", "artifact."] {
        let pattern = format!("format!(\"{prefix}");
        assert!(
            !sources.contains(&pattern),
            "发现事件名拼接（{pattern}…）—— 改成字面量，否则发射点扫描不可信"
        );
    }
}
