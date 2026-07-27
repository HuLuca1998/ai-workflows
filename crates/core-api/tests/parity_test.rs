//! 两端方法集必须一致。
//!
//! 桌面壳（Tauri IPC）与开发 HTTP 桥接各注册一份命令表。
//! 漏注册一个命令不会编译报错 —— 症状是「桌面版好用、Web 版某个按钮没反应」，
//! 而这种问题要点到那个按钮才发现。用测试拦住。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

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
    let source = read("crates/core-api/src/lib.rs");

    let mut in_struct = false;
    let mut previous = "";
    let mut offenders = Vec::new();

    for line in source.lines() {
        if line.starts_with("pub struct ") && line.ends_with('{') {
            in_struct = true;
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
