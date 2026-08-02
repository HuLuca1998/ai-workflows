//! B-6：`IMPLEMENTED` 清单与 executor 分派之间的守卫。
//!
//! 两份清单、零一致性检查是 B-1（notify 假实现）的成因：清单里有、
//! match 里也「有」—— 和 entry/end 并在空操作那一档，Dry Run 替它背书。
//!
//! 守法是**行为级**的，不扫源码：把每种契约节点类型喂给 executor，
//! - 不在 `IMPLEMENTED` ⇒ 必须报「尚未实现」
//! - 在 `IMPLEMENTED` ⇒ 不得报「尚未实现」，且**不得空手即成功** ——
//!   除了显式登记的标记节点（entry / end，它们就是标记，什么都不做是对的）

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::path::PathBuf;

use aiwf_engine::executor::NodeExecutor;
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::Scope;
use aiwf_engine::preflight::IMPLEMENTED;
use aiwf_engine::runner::NodeOutcome;

/// 显式登记的空操作节点。**加一个类型进来必须写清为什么它什么都不做是对的。**
///
/// - `entry` / `end`：图的起止标记，语义就是「无副作用」
const REGISTERED_NO_OPS: &[&str] = &["entry", "end"];

fn contract_node_types() -> BTreeSet<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/generated/contracts.meta.json");
    let raw = std::fs::read_to_string(&path).expect("先跑 pnpm contracts:gen");
    let meta: serde_json::Value = serde_json::from_str(&raw).unwrap();
    meta["nodeTypes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

/// 每种类型的最小节点配置。目标是**快速走到该类型自己的代码**：
/// 已实现的类型允许因缺配置而失败，但绝不允许报「尚未实现」或空手成功。
/// ai.* 指一个不存在的角色 —— 在真的拉起 adapter 之前就会失败
/// （CLAUDE.md：测试不得拉起真实 adapter）。
fn minimal_config(node_type: &str) -> serde_json::Value {
    match node_type {
        t if t.starts_with("ai.") => serde_json::json!({
            "agentProfileId": "builtin:不存在的角色",
            "instruction": "x",
        }),
        _ => serde_json::json!({}),
    }
}

fn run_one(node_type: &str) -> aiwf_engine::executor::Result<NodeOutcome> {
    let workdir = std::env::temp_dir().join("aiwf_dispatch_guard");
    std::fs::create_dir_all(&workdir).unwrap();
    let node = GraphNode {
        id: "probe".to_string(),
        node_type: node_type.to_string(),
        title: "探针".to_string(),
        config: minimal_config(node_type),
        join: None,
    };
    let mut scope = Scope::new("run_probe");
    // 预批准探针节点：不批的话 approval 在 precheck 就短路返回，
    // 根本走不进 match —— 删掉它的分派分支守卫也不红（假测试复核抓到的）。
    // adapter 换成 /usr/bin/false：AI 审批那条路失败得快且不连真 adapter
    NodeExecutor::new(workdir)
        .with_permission_preset("human_approval")
        .with_approved_nodes(&["probe".to_string()])
        .with_acp_command("/usr/bin/false", &[])
        .execute(&node, &mut scope)
}

/// 在 runner 那一层分派、不经过 executor 的节点类型。
///
/// 每一条都要写明**为什么非在 runner 不可** —— 否则这个名单会变成
/// 「executor 里没实现就往这儿放」的后门，而那正是这条守卫要防的。
///
/// 判据是「它需要 executor 刻意不给的东西」：executor 不碰数据库
/// （角色、提示词、模型都是 runner 一次性查好传进去的），
/// 所以要建 Run、要读运行树的，只能在 runner。
const RUNNER_LEVEL: &[(&str, &str)] = &[(
    "subworkflow",
    "要建独立子 Run（带 parent_run_id）、要读运行祖先做环检测、     要递归调 Runner —— 三样都得碰数据库，而 executor 刻意不碰。     行为守卫在 crates/engine/tests/subworkflow_test.rs",
)];

#[test]
fn runner_层的每一条都写了理由并且确实在_implemented_里() {
    for (node_type, reason) in RUNNER_LEVEL {
        assert!(
            !reason.trim().is_empty(),
            "{node_type} 进了 runner 层名单却没写理由"
        );
        assert!(
            IMPLEMENTED.contains(node_type),
            "{node_type} 在 runner 层名单里却不在 IMPLEMENTED —— 名单该跟着删"
        );
    }
}

#[test]
fn 清单里的每一种类型都不在_implemented_与分派脱节() {
    let contract_types = contract_node_types();

    // IMPLEMENTED 不得有契约之外的类型
    for t in IMPLEMENTED {
        assert!(
            contract_types.contains(*t),
            "IMPLEMENTED 里的 {t} 不在契约的节点类型里"
        );
    }

    for node_type in &contract_types {
        let implemented = IMPLEMENTED.contains(&node_type.as_str());
        let outcome = run_one(node_type);

        let unimplemented_reported = matches!(
            &outcome,
            Ok(NodeOutcome::Failed { message }) if message.contains("尚未实现")
        );

        if implemented {
            // runner 层分派的那几种，executor 报「尚未实现」是**对的**：
            // 它确实没实现，实现在 runner。名单本身由上面那条守着
            if RUNNER_LEVEL.iter().any(|(t, _)| t == node_type) {
                continue;
            }
            assert!(
                !unimplemented_reported,
                "{node_type} 在 IMPLEMENTED 里，executor 却报「尚未实现」—— 两份清单脱节"
            );
        } else {
            assert!(
                unimplemented_reported,
                "{node_type} 不在 IMPLEMENTED 里，executor 却没报「尚未实现」，\
                 实际结果：{outcome:?} —— Dry Run 会替一个不存在的实现背书"
            );
        }
    }
}

#[test]
fn 已实现的类型不得空手即成功_除非显式登记为标记节点() {
    for t in IMPLEMENTED {
        let outcome = run_one(t);
        let instant_success = matches!(&outcome, Ok(NodeOutcome::Succeeded { .. }));

        if REGISTERED_NO_OPS.contains(t) {
            assert!(
                instant_success,
                "{t} 登记为标记节点，空配置应当直接成功；实际：{outcome:?}。\
                 如果它现在有了真实语义，从 REGISTERED_NO_OPS 里删掉它"
            );
        } else {
            // notify 曾经在这里空手返回成功（B-1）——
            // 一个真实现面对空配置要么缺配置报错、要么等审批、要么执行失败
            assert!(
                !instant_success,
                "{t} 空配置就返回成功 —— 要么它是假实现（B-1 形态），\
                 要么它成了标记节点而没登记进 REGISTERED_NO_OPS"
            );
        }
    }
}
