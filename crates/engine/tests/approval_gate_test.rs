//! 审批门：谁来批，以及批的那一位看见了什么。
//!
//! ## 权限由流程管
//!
//! 执行节点拿最高权限，引擎**不再**按节点类型或脚本内容自动拦截。
//! 要不要停下来问，取决于工作流里有没有在那个位置放一个 `approval`
//! 节点 —— 「探索完成 → 开始编辑」之间一道，「编码完成 → 开 PR」
//! 之间一道。
//!
//! 上一版按风险自动拦，结果是「读一个 Issue 也要人点一次」。
//! 这个文件的第一组用例盯着那个行为不要回来，最后一组盯着
//! 它的代价（没放门就真的一路跑到底）也被如实记着。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Mutex;

use aiwf_engine::executor::{NodeEvent, NodeExecutor};
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::Scope;
use aiwf_engine::runner::NodeOutcome;

fn node(id: &str, node_type: &str, config: serde_json::Value) -> GraphNode {
    GraphNode {
        id: id.to_string(),
        node_type: node_type.to_string(),
        title: id.to_string(),
        config,
        join: None,
    }
}

fn workdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("aiwf_gate_workdir");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 一道门。`decider` 不写就是 `auto`（跟随全局档位）。
fn 门(decider: Option<&str>) -> GraphNode {
    let mut config = serde_json::json!({
        "title": "检查 Diff 与风险",
        "bodyMarkdown": "接下来会 commit → push → 创建 PR。",
        "interaction": "confirm",
    });
    if let Some(d) = decider {
        config["decider"] = serde_json::Value::String(d.to_string());
    }
    node("gate", "approval", config)
}

fn mock_acp(场景: &str) -> (String, Vec<String>) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    (
        "node".to_string(),
        vec![script.display().to_string(), 场景.to_string()],
    )
}

// ─────────────────────────────── 执行节点不再被自动拦

#[test]
fn 最严档下只读脚本直接跑() {
    // 用户的原话：「现在连读取 issue 都需要用户审批」
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("human_approval")
        .execute(
            &node(
                "read_issue",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash", "script": "echo 读到了 issue", "timeoutMs": 5000,
                }),
            ),
            &mut Scope::new("run_g1"),
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "只读脚本被拦了：{outcome:?}"
    );
}

#[test]
fn 最严档下写文件的脚本也直接跑() {
    // **权限由流程管**：想拦它就在它前面放一道门。
    // 引擎替你拦的那一版，代价是连只读也拦
    let dir = tempfile::tempdir().unwrap();
    let outcome = NodeExecutor::new(dir.path().to_path_buf())
        .with_permission_preset("human_approval")
        .execute(
            &node(
                "write",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash", "script": "echo x > probe.txt", "timeoutMs": 5000,
                }),
            ),
            &mut Scope::new("run_g2"),
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { .. }),
        "执行节点被自动拦了 —— 那是上一版的行为：{outcome:?}"
    );
    assert!(dir.path().join("probe.txt").exists());
}

#[test]
fn 没放门的工作流会一路跑到底_这是设计的代价() {
    // **把代价如实记下来。** 一条工作流里如果没有 approval 节点，
    // 那么它做什么都不会停 —— 包括推分支。
    //
    // 这条测试存在的意义不是「验证一个好行为」，是让这个代价
    // 有一处会红的记录：哪天有人想加回自动拦截，得先来改它，
    // 而改的时候会看到上面这段话
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("human_approval")
        .execute(
            &node(
                "push",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash", "script": "git push -u origin HEAD", "timeoutMs": 5000,
                }),
            ),
            &mut Scope::new("run_g3"),
        )
        .unwrap();

    // 临时目录里 git push 必然失败 —— 这里只关心它**没有停在审批上**
    assert!(
        !matches!(outcome, NodeOutcome::NeedsApproval),
        "推送被自动拦了 —— 拦它的应该是工作流里的一道门，不是引擎：{outcome:?}"
    );
}

// ─────────────────────────────────────── 门由谁批

#[test]
fn 最严档下每道门都由人批() {
    for decider in [None, Some("user"), Some("ai")] {
        let outcome = NodeExecutor::new(workdir())
            .with_permission_preset("human_approval")
            .execute(&门(decider), &mut Scope::new("run_g4"))
            .unwrap();
        assert!(
            matches!(outcome, NodeOutcome::NeedsApproval),
            "节点上写着 {decider:?}，而这一档说的是「每一道门都我批」：{outcome:?}"
        );
    }
}

#[test]
fn 中间档下标了必须我批的门停在人这里() {
    // 「AI 审批，关键节点用户审批」——「关键」由工作流作者在节点上标出来。
    // adapter 挂的是 gate-approve：就算 AI 说放行也不作数，
    // 这一档根本不该问它
    let (command, args) = mock_acp("gate-approve");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("ai_assisted")
        .with_acp_command(&command, &args)
        .execute(&门(Some("user")), &mut Scope::new("run_g5"))
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::NeedsApproval), "{outcome:?}");
}

#[test]
fn 中间档下没标的门由_ai_批() {
    let (command, args) = mock_acp("gate-approve");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("ai_assisted")
        .with_acp_command(&command, &args)
        .execute(&门(None), &mut Scope::new("run_g6"))
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "approved"),
        "AI 放行之后该走 approved 端口：{outcome:?}"
    );
}

#[test]
fn 无人值守连必须我批的门也交给_ai() {
    // 否则它不叫无人值守
    let (command, args) = mock_acp("gate-approve");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args)
        .execute(&门(Some("user")), &mut Scope::new("run_g7"))
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "approved"),
        "{outcome:?}"
    );
}

#[test]
fn ai_拒绝时走_rejected_端口_而不是让节点失败() {
    // 图上那条 rejected 边是工作流作者画的「被拒之后走哪」。
    // 让节点失败的话，那条边就白连了
    let (command, args) = mock_acp("gate-reject");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args)
        .execute(&门(None), &mut Scope::new("run_g8"))
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "rejected"),
        "{outcome:?}"
    );
}

// ─────────────────────────── AI 判不了的时候一律交回给人

#[test]
fn ai_没给出明确决定时交回给人() {
    // 说了一堆但没有结论。挑一个词当结论是最糟的做法 ——
    // 那等于让措辞决定要不要放行
    let (command, args) = mock_acp("gate-mumble");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args)
        .execute(&门(None), &mut Scope::new("run_g9"))
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::NeedsApproval), "{outcome:?}");
}

#[test]
fn 两个决定同时出现时交回给人() {
    // 提示词注入最容易造出来的形状：让回答里同时含放行与拒绝。
    // 「取第一个出现的」会让注入者赢
    let (command, args) = mock_acp("gate-both");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args)
        .execute(&门(None), &mut Scope::new("run_g10"))
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::NeedsApproval), "{outcome:?}");
}

#[test]
fn adapter_连不上时交回给人_而不是放行() {
    // fail closed。审批者请不来的时候放行，等于「AI 审批」这一档
    // 在没装 adapter 的机器上把所有门都打开了
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command("definitely-not-an-adapter", &[])
        .execute(&门(None), &mut Scope::new("run_g11"))
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::NeedsApproval), "{outcome:?}");
}

#[test]
fn 批过的门不再问第二次() {
    // 恢复运行时用
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("human_approval")
        .with_approved_nodes(&["gate".to_string()])
        .execute(&门(Some("user")), &mut Scope::new("run_g12"))
        .unwrap();

    assert!(
        !matches!(outcome, NodeOutcome::NeedsApproval),
        "批过的门又拦了一次，运行会永远卡在这里：{outcome:?}"
    );
}

// ─────────────────────────── 批的那一位看见了什么

#[test]
fn 审批者拿到上游刚产出的东西() {
    // 只把门的标题发过去的话，AI 只能对着「检查 Diff 与风险」
    // 这几个字表态 —— 那种审批看起来在工作，实际什么都没审
    let (command, args) = mock_acp("echo-prompt");
    let mut scope = Scope::new("run_g13");
    scope.set_node_output(
        "fix",
        "success",
        serde_json::json!("改了 src/cache.ts：热重载后清空对应缓存键"),
    );

    let executor = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args);
    // echo-prompt 回显提示词，里面没有 DECISION —— 判定必然是交回给人。
    // 这条测的不是判定，是提示词里到底有没有上游的产出
    let outcome = executor.execute(&门(None), &mut scope).unwrap();
    assert!(matches!(outcome, NodeOutcome::NeedsApproval));

    let 提示词 = executor.last_gate_prompt().expect("审批者的提示词没留档");
    assert!(
        提示词.contains("src/cache.ts"),
        "审批者没拿到上游产出：\n{提示词}"
    );
    assert!(
        提示词.contains("检查 Diff 与风险"),
        "审批者不知道这道门守的是什么：\n{提示词}"
    );
}

#[test]
fn 上游产出太长时截断并说明() {
    // 一份几十 MB 的 stdout 发过去只会撑爆上下文。
    // 而**悄悄**截断更糟：审批者会对着半份 diff 做判断，
    // 而它看起来是完整的
    let (command, args) = mock_acp("echo-prompt");
    let mut scope = Scope::new("run_g14");
    scope.set_node_output("big", "success", serde_json::json!("x".repeat(50_000)));

    let executor = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args);
    executor.execute(&门(None), &mut scope).unwrap();

    let 提示词 = executor.last_gate_prompt().unwrap();
    assert!(提示词.len() < 30_000, "没截断，长度 {}", 提示词.len());
    assert!(
        提示词.contains("太长"),
        "截断了却没说 —— 审批者会以为这就是全部：\n{}",
        &提示词[提示词.len().saturating_sub(400)..]
    );
}

#[test]
fn 上游什么都没产出时明说_而不是给一段空白() {
    // 一道门前面没有任何产出，本身就值得怀疑。
    // 给审批者一段空白，他只能猜
    let (command, args) = mock_acp("echo-prompt");
    let executor = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args);
    executor
        .execute(&门(None), &mut Scope::new("run_g15"))
        .unwrap();

    let 提示词 = executor.last_gate_prompt().unwrap();
    assert!(
        提示词.contains("没有产出"),
        "上游是空的却没说清：\n{提示词}"
    );
}

#[test]
fn 每次审批都留下事件_不管结果是什么() {
    // 「RunEvent 是唯一事实来源」。事后要能回答
    // 「这次 push 是谁放行的、凭什么」
    for (场景, 期望) in [("gate-approve", "放行"), ("gate-reject", "拒绝")] {
        let (command, args) = mock_acp(场景);
        let 事件: Mutex<Vec<NodeEvent>> = Mutex::new(Vec::new());
        NodeExecutor::new(workdir())
            .with_permission_preset("unattended")
            .with_acp_command(&command, &args)
            .execute_with_sink(&门(None), &mut Scope::new("run_g16"), &|e| {
                事件.lock().unwrap().push(e);
            })
            .unwrap();

        let 事件 = 事件.lock().unwrap();
        assert!(
            事件.iter().any(|e| e.kind == "approval.requested"),
            "{场景}：没有 approval.requested —— 用户看不到审批正在进行"
        );
        let decided = 事件
            .iter()
            .find(|e| e.kind == "approval.decided")
            .unwrap_or_else(|| panic!("{场景}：没有 approval.decided"));
        assert!(
            decided.summary.contains(期望),
            "{场景}：事件摘要看不出结果是什么：{}",
            decided.summary
        );
    }
}
