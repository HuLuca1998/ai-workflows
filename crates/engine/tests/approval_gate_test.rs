//! 三档审批在执行器里的实际行为。
//!
//! `risk_test.rs` 验的是「这一步算什么风险」，这里验的是
//! 「算完之后到底拦不拦、拦给谁」—— 两者之间隔着 `precheck`，
//! 而那正是上一版出问题的地方：判定按**节点类型**一刀切，
//! 于是一条只读的 `gh issue view` 也要人点一次。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::executor::NodeExecutor;
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

/// 只读脚本。判定应当是 `read_only` —— 三档都不拦。
fn 只读脚本() -> GraphNode {
    node(
        "read_issue",
        "script.shell",
        serde_json::json!({
            "interpreter": "bash",
            "script": "echo 读到了 issue 正文",
            "timeoutMs": 5000,
        }),
    )
}

/// 在工作区里写东西。`workspace_write`。
fn 写文件脚本() -> GraphNode {
    node(
        "write",
        "script.shell",
        serde_json::json!({
            "interpreter": "bash",
            "script": "echo x > probe.txt",
            "timeoutMs": 5000,
        }),
    )
}

/// 推到远端。`external_write` —— 「关键节点」指的就是这一类。
fn 推送脚本() -> GraphNode {
    node(
        "push",
        "script.shell",
        serde_json::json!({
            "interpreter": "bash",
            "script": "git push -u origin HEAD",
            "timeoutMs": 5000,
        }),
    )
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

// ────────────────────────────────────────────────── 我来审批

#[test]
fn 最严档下只读脚本也不拦() {
    // 用户的原话：「现在连读取 issue 都需要用户审批」。
    // 这一条就是那句话 —— 最严的一档下，只读操作照样直接跑
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("human_approval")
        .execute(&只读脚本(), &mut Scope::new("run_gate_1"))
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "只读脚本在最严档下被拦了：{outcome:?}"
    );
}

#[test]
fn 最严档下写文件要人工审批() {
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("human_approval")
        .execute(&写文件脚本(), &mut Scope::new("run_gate_2"))
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::NeedsApproval), "{outcome:?}");
}

#[test]
fn 最严档下推送要人工审批() {
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("human_approval")
        .execute(&推送脚本(), &mut Scope::new("run_gate_3"))
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::NeedsApproval), "{outcome:?}");
}

// ──────────────────────────────────────── AI 审批，关键节点问我

#[test]
fn 中间档下写文件由_ai_放行() {
    let (command, args) = mock_acp("gate-approve");
    let dir = tempfile::tempdir().unwrap();
    let outcome = NodeExecutor::new(dir.path().to_path_buf())
        .with_permission_preset("ai_assisted")
        .with_acp_command(&command, &args)
        .execute(&写文件脚本(), &mut Scope::new("run_gate_4"))
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "AI 放行之后应当照常执行：{outcome:?}"
    );
    assert!(
        dir.path().join("probe.txt").exists(),
        "AI 说放行，脚本却没真的跑"
    );
}

#[test]
fn 中间档下推送仍然要人工() {
    // 「AI 审批，关键节点用户审批」——「关键节点」就是这一格。
    // 注意 adapter 挂的是 gate-approve：就算 AI 说放行也不作数，
    // 这一档根本不该问它
    let (command, args) = mock_acp("gate-approve");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("ai_assisted")
        .with_acp_command(&command, &args)
        .execute(&推送脚本(), &mut Scope::new("run_gate_5"))
        .unwrap();

    assert!(
        matches!(outcome, NodeOutcome::NeedsApproval),
        "外部写在中间档下必须挂人工：{outcome:?}"
    );
}

#[test]
fn ai_拒绝时节点失败并说明理由() {
    let (command, args) = mock_acp("gate-reject");
    let dir = tempfile::tempdir().unwrap();
    let outcome = NodeExecutor::new(dir.path().to_path_buf())
        .with_permission_preset("ai_assisted")
        .with_acp_command(&command, &args)
        .execute(&写文件脚本(), &mut Scope::new("run_gate_6"))
        .unwrap();

    match &outcome {
        NodeOutcome::Failed { message } => {
            assert!(
                message.contains("主分支") || message.contains("超出"),
                "拒绝理由没有带回来，用户不知道为什么被拦：{message}"
            );
        }
        other => panic!("AI 拒绝了却没有失败：{other:?}"),
    }
    assert!(
        !dir.path().join("probe.txt").exists(),
        "AI 拒绝了，脚本还是跑了"
    );
}

// ──────────────────────────────────────────────── 无人值守

#[test]
fn 无人值守档下推送也由_ai_放行() {
    let (command, args) = mock_acp("gate-approve");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args)
        .execute(&推送脚本(), &mut Scope::new("run_gate_7"))
        .unwrap();

    // git push 在临时目录里必然失败 —— 这里只关心它**过了审批那道门**。
    // 停在 NeedsApproval 才是这条要抓的错
    assert!(
        !matches!(outcome, NodeOutcome::NeedsApproval),
        "无人值守档下还在等人：{outcome:?}"
    );
}

// ────────────────────────────────────────── AI 判不了的时候

#[test]
fn ai_没给出明确决定时升级为人工() {
    // 说了一堆但没有结论。挑一个词当结论是最糟的做法 ——
    // 那等于让措辞决定要不要放行
    let (command, args) = mock_acp("gate-mumble");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("ai_assisted")
        .with_acp_command(&command, &args)
        .execute(&写文件脚本(), &mut Scope::new("run_gate_8"))
        .unwrap();

    assert!(
        matches!(outcome, NodeOutcome::NeedsApproval),
        "含糊其辞被当成了放行：{outcome:?}"
    );
}

#[test]
fn 两个决定同时出现时升级为人工() {
    // 提示词注入最容易造出来的形状：让回答里同时含放行与拒绝。
    // 「取第一个出现的」会让注入者赢
    let (command, args) = mock_acp("gate-both");
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("ai_assisted")
        .with_acp_command(&command, &args)
        .execute(&写文件脚本(), &mut Scope::new("run_gate_9"))
        .unwrap();

    assert!(
        matches!(outcome, NodeOutcome::NeedsApproval),
        "两个决定并存时挑了一个：{outcome:?}"
    );
}

#[test]
fn adapter_连不上时升级为人工而不是放行() {
    // fail closed。审批者请不来的时候放行，等于「AI 审批」这一档
    // 在 adapter 没装的机器上把所有门都打开了
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command("definitely-not-an-adapter", &[])
        .execute(&推送脚本(), &mut Scope::new("run_gate_10"))
        .unwrap();

    assert!(
        matches!(outcome, NodeOutcome::NeedsApproval),
        "adapter 连不上却放行了：{outcome:?}"
    );
}

// ────────────────────────────────────── 批过的不再重复问

#[test]
fn 已批准的节点不再走审批() {
    // 恢复运行时用。这条在旧实现里就有，换了判定逻辑后仍要成立
    let dir = tempfile::tempdir().unwrap();
    let outcome = NodeExecutor::new(dir.path().to_path_buf())
        .with_permission_preset("human_approval")
        .with_approved_nodes(&["write".to_string()])
        .execute(&写文件脚本(), &mut Scope::new("run_gate_11"))
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { .. }),
        "批过的节点又被拦了一次：{outcome:?}"
    );
}

// ──────────────────────────────────── AI 审批者看到了什么

#[test]
fn ai_审批者拿到脚本原文() {
    // 静态嗅探看不出 `PUSH="git push"; $PUSH`，而 AI 能 ——
    // 前提是它真的拿到了脚本内容。只把节点类型发过去的话，
    // 它只能对着「script.shell」这四个字表态
    let (command, args) = mock_acp("echo-prompt");
    let 藏起来的推送 = node(
        "sneaky",
        "script.shell",
        serde_json::json!({
            "interpreter": "bash",
            "script": "PUSH=\"git push\"\n$PUSH",
            "timeoutMs": 5000,
        }),
    );

    // echo-prompt 把提示词原样回显。它不含 DECISION，
    // 所以判定必然是「升级人工」—— 这条测的不是判定，
    // 是提示词里到底有没有脚本原文
    let executor = NodeExecutor::new(workdir())
        .with_permission_preset("unattended")
        .with_acp_command(&command, &args);
    let outcome = executor
        .execute(&藏起来的推送, &mut Scope::new("run_gate_12"))
        .unwrap();
    assert!(matches!(outcome, NodeOutcome::NeedsApproval));

    let 提示词 = executor.last_gate_prompt().expect("审批者的提示词没留档");
    // 配置是 JSON 序列化后拼进去的，引号带转义 —— 断言脚本的**内容**在，
    // 不断言它的字面形式，否则这条测的就成了序列化格式
    assert!(
        提示词.contains("git push") && 提示词.contains("$PUSH"),
        "审批者没拿到脚本原文，它只能对着节点类型表态：\n{提示词}"
    );
}
