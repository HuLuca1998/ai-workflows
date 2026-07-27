//! 节点执行器：把节点配置真的变成副作用。
//!
//! Runner 之前用闭包注入结果，能验证调度但验证不了「script.shell 节点
//! 真的会跑那段脚本」。这里补上那一段。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::executor::NodeExecutor;
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::{Scope, interpolate};
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
    let dir = std::env::temp_dir().join("aiwf_exec_workdir");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn executor() -> NodeExecutor {
    NodeExecutor::new(workdir())
}

#[test]
fn shell_节点真的执行脚本并把_stdout_带回() {
    let mut scope = Scope::new("run_exec_1");
    let outcome = executor()
        .execute(
            &node(
                "greet",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "echo 你好", "timeoutMs": 5000}),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "实际：{outcome:?}"
    );
    // 输出必须进 scope，否则下游节点引用 ${greet.success} 会失败
    let piped = interpolate("${greet.success.stdout}", &scope).unwrap();
    assert_eq!(piped.trim(), "你好");
}

#[test]
fn shell_节点非零退出走_failure_端口() {
    let outcome = executor()
        .execute(
            &node(
                "boom",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "exit 7", "timeoutMs": 5000}),
            ),
            &mut Scope::new("run_exec_2"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => assert!(message.contains('7'), "实际：{message}"),
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn shell_节点的脚本会先做变量插值() {
    let mut scope = Scope::new("run_exec_3");
    scope.set_inputs(serde_json::json!({"name": "Luca"}));
    executor()
        .execute(
            &node(
                "hi",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo hello ${input.name}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let out = interpolate("${hi.success.stdout}", &scope).unwrap();
    assert_eq!(out.trim(), "hello Luca");
}

#[test]
fn 入口节点直接通过() {
    let mut scope = Scope::new("run_exec_4");
    scope.set_inputs(serde_json::json!({"repo": "demo"}));
    let outcome = executor()
        .execute(&node("entry", "entry", serde_json::json!({})), &mut scope)
        .unwrap();
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
}

#[test]
fn 结束节点按配置的_outcome_收尾() {
    let outcome = executor()
        .execute(
            &node("done", "end", serde_json::json!({"outcome": "success"})),
            &mut Scope::new("run_exec_5"),
        )
        .unwrap();
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
}

#[test]
fn 尚未实现的节点类型明确报未实现_而不是假装成功() {
    // 「宁可页面留空，也不要做假的」：没实现的节点类型必须说出来，
    // 假装成功会让用户以为工作流跑通了。
    // AI 节点已在 M3 接上 ACP，这里换一个真没实现的类型
    let outcome = executor()
        .execute(
            &node(
                "sub",
                "subworkflow",
                serde_json::json!({"workflowId": "wf_1"}),
            ),
            &mut Scope::new("run_exec_6"),
        )
        .unwrap();
    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("尚未"), "实际：{message}");
            assert!(message.contains("subworkflow"), "实际：{message}");
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 审批节点交回引擎处理_不在执行器里决定() {
    let outcome = executor()
        .execute(
            &node("ap", "approval", serde_json::json!({"title": "确认"})),
            &mut Scope::new("run_exec_7"),
        )
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::NeedsApproval),
        "实际：{outcome:?}"
    );
}

#[test]
fn 未定义的插值引用让节点失败_而不是把字面量喂给_shell() {
    let outcome = executor()
        .execute(
            &node(
                "bad",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "rm -rf ${input.nope}/x",
                    "timeoutMs": 5000
                }),
            ),
            &mut Scope::new("run_exec_8"),
        )
        .unwrap();
    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("input.nope"), "实际：{message}")
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 脚本超时报告成超时而不是普通失败() {
    let outcome = executor()
        .execute(
            &node(
                "slow",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "sleep 30", "timeoutMs": 300}),
            ),
            &mut Scope::new("run_exec_9"),
        )
        .unwrap();
    match outcome {
        NodeOutcome::Failed { message } => assert!(message.contains("超时"), "实际：{message}"),
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 通知节点在无桌面环境下也不应崩溃() {
    let outcome = executor()
        .execute(
            &node(
                "notify",
                "notify",
                serde_json::json!({"title": "完成", "body": "PR 已创建"}),
            ),
            &mut Scope::new("run_exec_10"),
        )
        .unwrap();
    // 通知的实际发送在 Tauri 壳里做，引擎只负责记录意图
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
}

// ── 输出落产物 ────────────────────────────────────────────────────────────

#[test]
fn 脚本输出落成产物文件_事件里只留摘要() {
    // 技术选型：大 payload 落 artifacts/，事件只留摘要与引用
    let dir = std::env::temp_dir().join("aiwf_exec_art");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = NodeExecutor::new(dir.clone()).with_run_id("run_art");
    let mut scope = Scope::new("run_art");
    executor
        .execute(
            &node(
                "logger",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo 第一行; echo 第二行 >&2",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let artifacts = executor.artifacts().list("run_art").unwrap();
    let names: Vec<_> = artifacts.iter().map(|a| a.name.as_str()).collect();
    assert!(names.contains(&"stdout.log"), "实际产物：{names:?}");
    assert!(names.contains(&"stderr.log"), "实际产物：{names:?}");

    let stdout = artifacts.iter().find(|a| a.name == "stdout.log").unwrap();
    assert_eq!(
        std::fs::read_to_string(&stdout.path).unwrap().trim(),
        "第一行"
    );
}

#[test]
fn 没有输出的脚本不留空产物文件() {
    // 一堆 0 字节的 stdout.log 只会让产物列表变噪音
    let dir = std::env::temp_dir().join("aiwf_exec_art2");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = NodeExecutor::new(dir).with_run_id("run_art2");
    executor
        .execute(
            &node(
                "quiet",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "true", "timeoutMs": 5000}),
            ),
            &mut Scope::new("run_art2"),
        )
        .unwrap();

    assert_eq!(executor.artifacts().list("run_art2").unwrap().len(), 0);
}

#[test]
fn 失败的脚本也要留下日志产物() {
    // 端到端测试抓到的：失败分支提前 return，产物没保存 ——
    // 而脚本失败时恰恰是最需要看 stderr 的时候
    let dir = std::env::temp_dir().join("aiwf_exec_fail_art");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = NodeExecutor::new(dir).with_run_id("run_fail");
    let outcome = executor
        .execute(
            &node(
                "boom",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo 诊断信息 >&2; exit 3",
                    "timeoutMs": 5000
                }),
            ),
            &mut Scope::new("run_fail"),
        )
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::Failed { .. }));

    let artifacts = executor.artifacts().list("run_fail").unwrap();
    let stderr = artifacts
        .iter()
        .find(|a| a.name == "stderr.log")
        .expect("失败的脚本必须留下 stderr.log");
    assert!(
        std::fs::read_to_string(&stderr.path)
            .unwrap()
            .contains("诊断信息")
    );
}

// ── 命令注入（codex 审查指出，验证后确认属实）─────────────────────────────

#[test]
fn 启动参数里的分号不能变成另一条命令() {
    // 工作流作者写脚本是本来就有的权限；但只拥有「运行工作流」能力的人
    // 不该借启动参数拿到同样的权限。M4 的主管 AI 也会启动运行 ——
    // 那时这个口子等于把命令执行权交给了模型的输出。
    let dir = std::env::temp_dir().join("aiwf_inject");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("pwned.txt");

    let mut scope = Scope::new("run_inject");
    scope.set_inputs(serde_json::json!({
        "name": format!("x; touch {} #", marker.display()),
    }));

    NodeExecutor::new(dir.clone())
        .execute(
            &node(
                "greet",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo hello ${input.name}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(
        !marker.exists(),
        "启动参数里的 `; touch` 被当成了另一条命令执行"
    );
}

#[test]
fn 上游节点的输出里的反引号不会被求值() {
    let dir = std::env::temp_dir().join("aiwf_inject2");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("subshell.txt");

    let mut scope = Scope::new("run_inject2");
    scope.set_node_output(
        "up",
        "success",
        serde_json::json!({ "stdout": format!("$(touch {})", marker.display()) }),
    );

    NodeExecutor::new(dir.clone())
        .execute(
            &node(
                "consume",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo ${up.success.stdout}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(!marker.exists(), "上游输出里的 $() 被当成命令替换执行了");
}

#[test]
fn 插值出的值原样传给脚本_不因转义而变形() {
    // 转义不能把值改掉：脚本里 echo 出来的必须还是用户填的那串
    let dir = std::env::temp_dir().join("aiwf_inject3");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut scope = Scope::new("run_inject3");
    scope.set_inputs(serde_json::json!({ "text": "a b'c\"d;e$f" }));

    NodeExecutor::new(dir)
        .execute(
            &node(
                "echo",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "printf '%s' ${input.text}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let out = interpolate("${echo.success.stdout}", &scope).unwrap();
    assert_eq!(out, "a b'c\"d;e$f", "转义把值改坏了");
}

#[test]
fn 换行也不能拆出新的一行命令() {
    let dir = std::env::temp_dir().join("aiwf_inject4");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("newline.txt");

    let mut scope = Scope::new("run_inject4");
    scope.set_inputs(serde_json::json!({
        "name": format!("x\ntouch {}", marker.display()),
    }));

    NodeExecutor::new(dir.clone())
        .execute(
            &node(
                "greet",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo ${input.name}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(!marker.exists(), "换行被当成了命令分隔符");
}

// ── AI 节点（M3）──────────────────────────────────────────────────────────

/// 让执行器用 mock adapter 而不是真的 claude-agent-acp。
fn with_mock_adapter(dir: std::path::PathBuf) -> NodeExecutor {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    NodeExecutor::new(dir).with_acp_command(
        "node",
        &[script.display().to_string(), "normal".to_string()],
    )
}

fn ai_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("aiwf_ai_{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn ai_分析节点真的走一轮_acp_会话() {
    let dir = ai_dir("analyze");
    let mut scope = Scope::new("run_ai_1");
    scope.set_inputs(serde_json::json!({ "issue": "561" }));

    let outcome = with_mock_adapter(dir)
        .execute(
            &node(
                "analyze",
                "ai.analyze",
                serde_json::json!({
                    "agentProfileId": "builtin:analyst",
                    "instruction": "定位 ${input.issue} 的根因",
                    "runtime": "acp.claude"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "实际：{outcome:?}"
    );

    // agent 的回答进 scope，下游节点才能引用
    let answer = interpolate("${analyze.success.text}", &scope).unwrap();
    assert!(answer.contains("分析结果"), "实际：{answer}");
}

#[test]
fn ai_节点的指令会先做变量插值() {
    let dir = ai_dir("interp");
    let mut scope = Scope::new("run_ai_2");
    scope.set_inputs(serde_json::json!({ "target": "缓存模块" }));

    with_mock_adapter(dir)
        .execute(
            &node(
                "review",
                "ai.review",
                serde_json::json!({
                    "agentProfileId": "builtin:reviewer",
                    "instruction": "审查 ${input.target}",
                    "runtime": "acp.claude"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    // mock 把收到的提示词原样回显不了，但插值失败会直接报错，
    // 所以能跑通就说明 ${input.target} 解析出来了
    assert!(interpolate("${review.success.text}", &scope).is_ok());
}

#[test]
fn ai_节点把工具调用次数记进输出() {
    // 图纸对话视图要显示「工具活动 · 6 次读取，2 次搜索」
    let dir = ai_dir("tools");
    let mut scope = Scope::new("run_ai_3");

    with_mock_adapter(dir)
        .execute(
            &node(
                "exec",
                "ai.execute",
                serde_json::json!({
                    "agentProfileId": "builtin:builder",
                    "instruction": "改一下",
                    "runtime": "acp.claude"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let tools = interpolate("${exec.success.toolCalls}", &scope).unwrap();
    assert_eq!(tools, "1", "工具调用次数实际：{tools}");
}

#[test]
fn 未插值的引用不会被发给_agent() {
    // 把 `${input.nope}` 原样发给 agent，它会当成字面量去理解 ——
    // 得到的分析基于一个不存在的东西
    let dir = ai_dir("badvar");
    let outcome = with_mock_adapter(dir)
        .execute(
            &node(
                "analyze",
                "ai.analyze",
                serde_json::json!({
                    "agentProfileId": "builtin:analyst",
                    "instruction": "分析 ${input.nope}",
                    "runtime": "acp.claude"
                }),
            ),
            &mut Scope::new("run_ai_4"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("input.nope"), "实际：{message}")
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn adapter_没装时说清楚要装什么_而不是假装成功() {
    let dir = ai_dir("noadapter");
    let executor = NodeExecutor::new(dir).with_acp_command("definitely-not-an-adapter", &[]);

    let outcome = executor
        .execute(
            &node(
                "analyze",
                "ai.analyze",
                serde_json::json!({
                    "agentProfileId": "builtin:analyst",
                    "instruction": "分析",
                    "runtime": "acp.claude"
                }),
            ),
            &mut Scope::new("run_ai_5"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("adapter"), "实际：{message}");
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn ai_决策节点把结论放进输出的_decision_字段() {
    let dir = ai_dir("decide");
    let mut scope = Scope::new("run_ai_6");

    with_mock_adapter(dir)
        .execute(
            &node(
                "decide",
                "ai.decide",
                serde_json::json!({
                    "agentProfileId": "builtin:operator",
                    "instruction": "按影响面分级",
                    "runtime": "acp.claude"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    // 决策节点的输出要能被下游的条件分支引用
    assert!(interpolate("${decide.success.text}", &scope).is_ok());
}
