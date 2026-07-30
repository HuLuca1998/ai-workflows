//! 能力校验写给了谁。
//!
//! `check_capability` 的每一支都从 `profile_for(node)` 取能力，
//! 而 `profile_for` 只认 config 里的 `agentProfileId`。给一个
//! **没有这个字段**的节点类型写分支，那一支永远匹配不到：
//! 代码看着有一道防线，运行时一次都不会经过。
//!
//! 这不是学术问题 —— 「Agent 角色」页上写着「权限（引擎强制，
//! Prompt 无法越权）」，用户会照着它把「命令」调成「不允许」，
//! 然后以为脚本节点跑不起来了。实际它照跑。
//!
//! （运行级的 `with_capabilities` 也曾被当成第二条来源，
//! 但它在生产里零调用 —— 只有测试传过。）

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

const NODE_CONFIGS: &str =
    include_str!("../../../packages/contracts/generated/node-configs.schema.json");
const EXECUTOR_SRC: &str = include_str!("../src/executor.rs");

/// 契约里声明了 `agentProfileId` 的节点类型 —— 只有它们挂得上角色。
fn 挂得上角色的() -> BTreeSet<String> {
    let spec: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(NODE_CONFIGS).expect("node-configs.schema.json");
    spec.into_iter()
        .filter(|(_, schema)| {
            schema
                .get("properties")
                .and_then(|p| p.get("agentProfileId"))
                .is_some()
        })
        .map(|(node_type, _)| node_type)
        .collect()
}

/// `check_capability` 的 match 分支里出现的节点类型字面量。
fn 校验里写到的() -> BTreeSet<String> {
    let 起 = EXECUTOR_SRC
        .find("fn check_capability")
        .expect("找不到 check_capability —— 改名了就把这条测试一起改");
    let 函数 = &EXECUTOR_SRC[起..];
    // match 的收尾：`_ => Ok(())`
    let 止 = 函数
        .find("_ => Ok(())")
        .expect("check_capability 的 match 收尾变了");
    let 体 = &函数[..止];

    let mut out = BTreeSet::new();
    // 分支形如 `"script.shell" | "script.python" if ...`
    for 行 in 体.lines() {
        let 行 = 行.trim();
        if !行.starts_with('"') {
            continue;
        }
        for 片 in 行.split('|') {
            let 片 = 片.trim();
            if let Some(rest) = 片.strip_prefix('"') {
                if let Some(name) = rest.split('"').next() {
                    if name.contains('.') {
                        out.insert(name.to_string());
                    }
                }
            }
        }
    }
    assert!(
        !out.is_empty(),
        "一个分支都没解析出来 —— 解析逻辑跟不上代码了"
    );
    out
}

#[test]
fn 能力校验只写给挂得上角色的节点() {
    let 可达 = 挂得上角色的();
    let 写到的 = 校验里写到的();

    let 够不着: Vec<&String> = 写到的.iter().filter(|t| !可达.contains(*t)).collect();

    assert!(
        够不着.is_empty(),
        "check_capability 给这些节点写了分支，但它们的 configSchema 里没有 agentProfileId，\n\
         `profile_for` 永远返回 None，这些分支一次都不会走到：{够不着:?}\n\
         要么给这些节点接一条真的能力来源，要么删掉分支并把「Agent 角色」页上\n\
         那句「引擎强制」的作用范围写清楚。留着等于向用户承诺一道不存在的防线。\n\
         挂得上角色的类型：{可达:?}"
    );
}
