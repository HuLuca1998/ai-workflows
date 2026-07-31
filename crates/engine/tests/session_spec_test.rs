//! 打开一条配置好的 ACP 会话 —— 四个 AI 调用点共用的那一个入口。
//!
//! 在这之前，AI 节点、AI 审批者、主管 AI、连通性测试**各写各的**
//! 「找 adapter → connect → new_session」，而后面三格（权限档、模型、
//! 推理深度）四处全是空的：
//!
//! - 不设权限档 ⇒ 跑在 agent 的默认档上。codex 的默认档是 `agent`
//!   （可读写、可跑命令、**不问权限**），于是客户端那套拒绝代码
//!   一次都没被调用过（`docs/acp/07-violations.md` H-6）；
//! - 不设模型 ⇒ 「模型」页登记的东西对执行没有任何影响。
//!
//! 这份测试压着的是：spec 里写了的**真的设进去了**，设不进去的
//! **说出来而不是静默跳过**。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use aiwf_engine::acp::{SessionSpec, open_session};

/// 指向 mock adapter。`claude-flavored` 场景下配置项的 id 换成 claude 那套，
/// 用来验证「按 category 取」在两端都成立。
fn spec(scenario: &str) -> SessionSpec {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    SessionSpec {
        runtime: "acp.codex".to_string(),
        cwd: "/tmp".to_string(),
        model: None,
        effort: None,
        mode: None,
        mcp: Vec::new(),
        timeout: Duration::from_secs(10),
        adapter_override: Some((
            "node".to_string(),
            vec![script.display().to_string(), scenario.to_string()],
        )),
    }
}

#[test]
fn 三项配置都设进去了_两种_id_风格都成立() {
    for 场景 in ["normal", "claude-flavored"] {
        let mut 要的 = spec(场景);
        要的.model = Some("mock-model-b".to_string());
        要的.effort = Some("high".to_string());
        要的.mode = Some("read-only".to_string());

        let opened = open_session(&要的).unwrap_or_else(|e| panic!("{场景}：开会话失败 {e}"));

        assert!(
            opened.downgraded.is_empty(),
            "{场景}：候选里明明有这些值，却降级了：{:?}",
            opened.downgraded
        );

        let 现值 = |category: &str| {
            opened
                .session
                .config_options
                .iter()
                .find(|o| o.category == category)
                .map(|o| o.current_value.clone())
                .unwrap_or_default()
        };
        assert_eq!(现值("model"), "mock-model-b", "{场景}：模型没设进去");
        assert_eq!(现值("thought_level"), "high", "{场景}：推理深度没设进去");
        assert_eq!(现值("mode"), "read-only", "{场景}：权限档没设进去");
    }
}

#[test]
fn 什么都不指定时一项都不设_用_agent_自己的默认() {
    // 「模型失效就不设置，用系统默认的」—— 这条路要真的存在。
    // 顺手也是老 adapter 的兼容路径：它可能根本没有 thought_level 这一项。
    let opened = open_session(&spec("normal")).expect("开会话");

    assert!(opened.downgraded.is_empty(), "什么都没要，不该有降级");

    let 现值 = |category: &str| {
        opened
            .session
            .config_options
            .iter()
            .find(|o| o.category == category)
            .map(|o| o.current_value.clone())
            .unwrap_or_default()
    };
    // mock 的初值。没被动过 = 没发 set 请求
    assert_eq!(现值("model"), "mock-model-a");
    assert_eq!(现值("thought_level"), "medium");
}

#[test]
fn agent_拒了某一项时不阻断_但要记下来() {
    // 实测：设一个不存在的模型，两端都拒（codex -32602 / claude -32603）。
    //
    // 这时**不能让整个节点失败** —— 用户说的是「模型失效就用系统默认的」。
    // 但也**不能静默**：那就是悄悄换了模型，而界面上写着
    // 「降级发生时会写入 RunEvent，不会静默替换模型」。
    let mut 要的 = spec("normal");
    要的.model = Some("这个模型压根不存在".to_string());
    要的.effort = Some("high".to_string());

    let opened = open_session(&要的).expect("一项被拒不该让整条会话开不起来");

    assert_eq!(opened.downgraded.len(), 1, "降级记录数不对");
    let 降 = &opened.downgraded[0];
    assert_eq!(降.category, "model");
    assert_eq!(降.wanted, "这个模型压根不存在");
    assert!(
        降.reason.contains("这个模型压根不存在"),
        "降级原因要带上被拒的值，不然用户不知道是哪一项：{}",
        降.reason
    );

    // 被拒的那一项退回 agent 默认，**其余的照设** ——
    // 一项设不上就整轮不设的话，用户挑的推理深度会跟着一起丢
    let 深度 = opened
        .session
        .config_options
        .iter()
        .find(|o| o.category == "thought_level")
        .map(|o| o.current_value.clone())
        .unwrap_or_default();
    assert_eq!(深度, "high", "模型被拒了，推理深度不该跟着丢");
}

#[test]
fn 不认识的_runtime_直接报错_而不是默默连上别的() {
    let mut 要的 = spec("normal");
    要的.runtime = "provider.某种不存在的接入".to_string();
    要的.adapter_override = None; // 走真实的 adapter 查找

    let 错 = match open_session(&要的) {
        Ok(_) => panic!("不认识的 runtime 却连上了"),
        Err(error) => error,
    };
    assert!(
        错.to_string().contains("provider.某种不存在的接入"),
        "错误信息要带上是哪个 runtime：{错}"
    );
}
