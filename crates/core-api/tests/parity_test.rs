//! 两端方法集必须一致。
//!
//! 桌面壳（Tauri IPC）与开发 HTTP 桥接各注册一份命令表。
//! 漏注册一个命令不会编译报错 —— 症状是「桌面版好用、Web 版某个按钮没反应」，
//! 而这种问题要点到那个按钮才发现。用测试拦住。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use aiwf_engine::status::RunStatus;
use aiwf_store::Store;

fn read(path: &str) -> String {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    std::fs::read_to_string(root.join(path)).unwrap_or_else(|e| panic!("读不到 {path}：{e}"))
}

#[test]
fn 桌面壳注册了_core_api_的每一个命令() {
    let desktop = read("apps/desktop/src-tauri/src/lib.rs");
    let missing: Vec<&str> = aiwf_core_api::COMMANDS
        .iter()
        .copied()
        .filter(|name| !desktop.contains(&format!("fn {name}(")))
        .collect();

    assert!(missing.is_empty(), "桌面壳缺少这些命令的转发：{missing:?}");
}

#[test]
fn 桌面壳的_invoke_handler_列出了每一个命令() {
    // 光有函数不够：没写进 generate_handler! 的命令，前端调用时才报错
    let desktop = read("apps/desktop/src-tauri/src/lib.rs");
    let handler_start = desktop
        .find("generate_handler![")
        .expect("找不到 generate_handler!");
    let handler_end = desktop[handler_start..]
        .find(']')
        .expect("generate_handler! 没有闭合");
    let handler = &desktop[handler_start..handler_start + handler_end];

    let missing: Vec<&str> = aiwf_core_api::COMMANDS
        .iter()
        .copied()
        .filter(|name| !handler.contains(name))
        .collect();

    assert!(
        missing.is_empty(),
        "这些命令没写进 invoke_handler：{missing:?}"
    );
}

#[test]
fn 开发_http_桥接分派了每一个命令() {
    let dispatch = read("crates/devserver/src/dispatch.rs");
    let missing: Vec<&str> = aiwf_core_api::COMMANDS
        .iter()
        .copied()
        .filter(|name| !dispatch.contains(&format!("\"{name}\"")))
        .collect();

    assert!(missing.is_empty(), "HTTP 桥接缺少这些命令：{missing:?}");
}

#[test]
fn 命令表没有重复项() {
    let unique: BTreeSet<&str> = aiwf_core_api::COMMANDS.iter().copied().collect();
    assert_eq!(unique.len(), aiwf_core_api::COMMANDS.len());
}

#[test]
fn 命令表覆盖四个领域() {
    let commands: BTreeSet<&str> = aiwf_core_api::COMMANDS.iter().copied().collect();
    for prefix in ["workflow_", "run_", "model_", "approval_"] {
        assert!(
            commands.iter().any(|c| c.starts_with(prefix)),
            "缺少 {prefix}* 命令"
        );
    }
}

#[test]
fn 每个_dto_的_option_字段都跳过_null_序列化() {
    // Rust 的 None 会变成 JSON null，而契约里 .optional() 只接受字段缺席。
    // 漏一个字段的症状是整页「返回值不合契约」——而这只在真实跑起来时才出现，
    // 单元测试构造的 DTO 不经过 Zod。
    // 只看**会被序列化出去**的结构：入参结构（如 AgentEdit）没有 Serialize，
    // 它的 None 永远不会变成 JSON null，不该被这条规则连坐
    let source = read("crates/core-api/src/lib.rs");

    let mut in_struct = false;
    let mut serializable = false;
    let mut previous = "";
    let mut offenders = Vec::new();

    for line in source.lines() {
        if line.starts_with("#[derive(") {
            serializable = line.contains("Serialize");
        } else if line.starts_with("pub struct ") && line.ends_with('{') {
            in_struct = serializable;
        } else if in_struct && line == "}" {
            in_struct = false;
        } else if in_struct
            && line.starts_with("    ")
            && line.contains(": Option<")
            && !previous.contains("skip_serializing_if")
        {
            offenders.push(line.trim().to_string());
        }
        previous = line;
    }

    assert!(
        offenders.is_empty(),
        "这些 Option 字段缺少 #[serde(skip_serializing_if = \"Option::is_none\")]：\n{}",
        offenders.join("\n")
    );
}

#[test]
fn 统计里的状态字符串必须来自状态机而不是手写() {
    // 我写 workspace_stats 时手打了 'awaiting_approval'，而契约与引擎
    // 一直用的是 'waiting_approval'。症状不是报错 —— 是统计卡永远显示 0，
    // 因为那个状态一条都匹配不到。SQL 里的字符串没有编译期检查，
    // 所以拿状态机的真值反过来验一遍。
    //
    // 这条放在 core-api 是因为它同时看得到 store 与 engine：
    // store 不依赖 engine（方向是 engine → store），在 store 的测试里够不着状态机。
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("在等审批", None).unwrap();
    let run = store.create_run(&wf, None, Some(1), "{}").unwrap();
    store
        .advance_run_status(&run, RunStatus::WaitingApproval.as_str(), None)
        .unwrap();

    let stats = store.workspace_stats().unwrap();
    assert_eq!(stats.pending_approvals, 1, "状态字符串与状态机对不上");
    assert_eq!(stats.pending_approval_hint.as_deref(), Some("在等审批"));
}

#[test]
fn 每个_dto_都声明了_camel_case() {
    // WorkflowSummary 漏了 rename_all，于是它发的是 last_run 而契约里是 lastRun。
    // Zod 的 .optional() 对「字段名不对」和「字段缺席」的反应一模一样 ——
    // 都是静默通过，界面上那一列永远空着，一条错误都没有。
    //
    // 这类问题只在真实跑起来、且恰好有数据时才看得见，
    // 所以拿源码把规则钉死：出参结构一律 camelCase。
    let source = read("crates/core-api/src/lib.rs");

    let mut serializable = false;
    let mut camel = false;
    let mut offenders = Vec::new();

    for line in source.lines() {
        if line.starts_with("#[derive(") {
            serializable = line.contains("Serialize");
            camel = false;
        } else if line.starts_with("#[serde(") && line.contains("camelCase") {
            camel = true;
        } else if line.starts_with("pub struct ") && line.ends_with('{') {
            if serializable && !camel {
                offenders.push(line.trim_end_matches(" {").to_string());
            }
            serializable = false;
            camel = false;
        }
    }

    assert!(
        offenders.is_empty(),
        "这些出参结构缺少 #[serde(rename_all = \"camelCase\")]：\n{}",
        offenders.join("\n")
    );
}

#[test]
fn 存储层的终态集合与状态机一致() {
    // store 不依赖 engine，所以它的 TERMINAL_RUN_STATUSES 是硬编码的
    // 三个字符串。多一个少一个都不会编译报错 —— 症状是某个终态的运行
    // 永远没有结束时间，或者已结束的运行还能被继续推进。
    let store = Store::open_in_memory().unwrap();

    for status in RunStatus::ALL {
        let wf = store.create_workflow("终态验证", None).unwrap();
        let run = store.create_run(&wf, None, Some(1), "{}").unwrap();
        // created 是初始状态，推进到它自己没有意义
        if *status == RunStatus::Created {
            continue;
        }
        store
            .advance_run_status(&run, status.as_str(), None)
            .unwrap();

        let ended = store.get_run(&run).unwrap().unwrap().ended_at.is_some();
        assert_eq!(
            ended,
            status.is_terminal(),
            "{} 的终态判定两边对不上",
            status.as_str()
        );
    }
}

#[test]
fn 启动运行必须指定跑哪个版本() {
    // 契约写的是「versionId 与 draftRev 必须且只能提供一个」，但这条约束
    // 原来只活在 Zod 里 —— HTTP 桥接与 MCP 都能绕过去。
    //
    // 绕过去的后果不是报错：run_graph 找不到图就返回 None，
    // 引擎拿一张空图跑，preflight 报「缺少入口节点」。
    // 用户看到的是「我的工作流明明有入口节点」，而真正的原因是调用方少传了参数。
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let supervisor = aiwf_engine::supervisor::Supervisor::new(dir.path().join("db.sqlite"));
    let wf = store.create_workflow("要跑的", None).unwrap();

    let both = aiwf_core_api::run_start(
        &store,
        &supervisor,
        dir.path(),
        wf.clone(),
        Some("ver_1".to_string()),
        Some(1),
        "{}".to_string(),
        None,
    );
    assert!(both.is_err(), "同时给两个应当被拒");

    let neither = aiwf_core_api::run_start(
        &store,
        &supervisor,
        dir.path(),
        wf,
        None,
        None,
        "{}".to_string(),
        None,
    );
    assert!(neither.is_err(), "一个都不给应当被拒");
}
