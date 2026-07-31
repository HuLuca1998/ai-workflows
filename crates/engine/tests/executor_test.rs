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

/// 这个文件里出现过的节点 id，全部预批准。
///
/// 这里的用例测的是**节点真的做了那件事**，不是「拦不拦」——
/// 后者由 `approval_gate_test.rs` 专门测。不让开审批那道门的话，
/// 每个会写东西的节点都停在 `NeedsApproval`，一条行为都验证不到。
///
/// 预批准而不是放宽档位：新三档里没有「全部放行」的一档
/// （最松的 `unattended` 也要 AI 表态，那要起 adapter 进程），
/// 而 `with_approved_nodes` 恰好就是「这个我已经批过了」的意思。
///
/// **新加用例时 id 不在这里的话，它会停在审批上** ——
/// 那个失败信息（`NeedsApproval`）看起来会很莫名其妙，所以列全。
const 已批准的测试节点: &[&str] = &[
    "act", "analyze", "ap", "bad", "boom", "consume", "decide", "done", "e1", "echo", "entry",
    "exec", "fix", "greet", "hi", "logger", "n", "notify", "quiet", "review", "s1", "sh", "sh2",
    "sh3", "sh4", "slow", "sub", "wt",
];

fn 预批准() -> Vec<String> {
    已批准的测试节点.iter().map(|s| (*s).to_string()).collect()
}

/// 建一个「审批不挡路」的执行器。
///
/// 这个文件里除了 `mod 权限档改变行为` 之外的用例都用它 ——
/// 那一个模块**要**审批挡路，它是唯一在测审批的地方，
/// 所以那里仍然直接 `NodeExecutor::new`。
fn 执行器(workdir: std::path::PathBuf) -> NodeExecutor {
    NodeExecutor::new(workdir)
        .with_permission_preset("human_approval")
        .with_approved_nodes(&预批准())
}

/// 测节点本身行为的用例都用这个。
fn executor() -> NodeExecutor {
    执行器(workdir())
        .with_permission_preset("human_approval")
        .with_approved_nodes(&预批准())
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
fn 审批节点在最严档下交回给人() {
    // 这个 helper 预批准了 "ap"（它测的是别的东西），
    // 所以这里显式建一个没预批准的执行器 —— 门就该拦得住
    let outcome = NodeExecutor::new(workdir())
        .with_permission_preset("human_approval")
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
fn 通知节点在无桌面环境下不假装发出去了() {
    // 这条原来叫「在无桌面环境下也不应崩溃」，断言的是走 success 端口，
    // 注释写着「实际发送在 Tauri 壳里做，引擎只负责记录意图」——
    // **那两件事当时都不成立**：壳里没有实现，引擎也没记任何意图。
    // 它是 DEBT.md B-1 的三层掩护之一。
    //
    // 现在断言的是反过来那半句：发不出去就得看得出来。
    // 完整的 notify 行为在 tests/notify_test.rs
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
    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "failed"),
        "没有通知发送器却走了成功端口：{outcome:?}"
    );
}

// ── 输出落产物 ────────────────────────────────────────────────────────────

#[test]
fn 脚本输出落成产物文件_事件里只留摘要() {
    // 技术选型：大 payload 落 artifacts/，事件只留摘要与引用
    let dir = std::env::temp_dir().join("aiwf_exec_art");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = 执行器(dir.clone())
        .with_run_id("run_art")
        .with_permission_preset("human_approval");
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

    let executor = 执行器(dir)
        .with_run_id("run_art2")
        .with_permission_preset("human_approval");
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

    // 不留**空**的日志文件 —— 那是这条用例的本意。
    // command.sh 是另一回事：它记的是「插值之后真正跑的那份脚本」，
    // 排查时第一个要看的就是它，任何一次执行都该有
    let 产物: Vec<String> = executor
        .artifacts()
        .list("run_art2")
        .unwrap()
        .into_iter()
        .map(|a| a.name)
        .collect();
    assert_eq!(
        产物,
        vec!["command.sh".to_string()],
        "只该有命令，没有空日志"
    );
}

#[test]
fn 失败的脚本也要留下日志产物() {
    // 端到端测试抓到的：失败分支提前 return，产物没保存 ——
    // 而脚本失败时恰恰是最需要看 stderr 的时候
    let dir = std::env::temp_dir().join("aiwf_exec_fail_art");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = 执行器(dir)
        .with_run_id("run_fail")
        .with_permission_preset("human_approval");
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

    执行器(dir.clone())
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

    执行器(dir.clone())
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

    执行器(dir)
        .with_permission_preset("human_approval")
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

    执行器(dir.clone())
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

/// 夹具里那几个 AI 节点引用的内置角色。
///
/// 节点写了 `agentProfileId` 而执行器查不到就是硬错误 ——
/// 那正是「界面上显示着审查者，实际跑的是一个没有人设的模型」的防线。
/// 所以凡是用了角色 id 的夹具，都得把角色一起给它。
fn 内置角色() -> Vec<aiwf_engine::executor::AgentProfile> {
    ["builtin:analyst", "builtin:reviewer", "builtin:builder", "builtin:operator"]
        .into_iter()
        .map(|id| aiwf_engine::executor::AgentProfile {
            id: id.to_string(),
            name: id.to_string(),
            role: String::new(),
            goal: String::new(),
            persona: String::new(),
            // 空串表示「角色没指定 runtime」，于是听节点的 —— 这些夹具
            // 测的是别的东西，不该被 runtime 的归属搅进来
            runtime: String::new(),
            model_ref: "model:codex".to_string(),
            fallback_model_ref: String::new(),
            output_contract: String::new(),
            capabilities_json: r#"{"file":"read-write","command":"any","network":"any","memory":"read-write","secret":[]}"#.to_string(),
            timeout_ms: 900_000,
        })
        .collect()
}

/// 让执行器用 mock adapter 而不是真的 claude-agent-acp。
fn with_mock_adapter(dir: std::path::PathBuf) -> NodeExecutor {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    执行器(dir)
        .with_agent_profiles(&内置角色())
        // 显式声明权限档。默认是最严那一档，而 `ai.execute` 在那一档下
        // 会先挂起等审批 —— 这些用例问的是「跑起来之后 cwd 是哪个、
        // 走哪个端口」，不是「拦不拦」。拦不拦由
        // `权限档说的话要算数` 那一组单独压着。
        // 声明比放宽默认好：默认放宽等于替用户做一个他不知道的决定
        .with_permission_preset("human_approval")
        .with_acp_command(
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
    // ai.review 的端口是 passed / changes_requested，没有 success
    assert!(interpolate("${review.passed.text}", &scope).is_ok());
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
                    "runtime": "acp.claude",
                    // ai.execute 的 workdirSource 默认是 worktree，而这条用例
                    // 测的是工具调用次数，不该被工作目录的来源搅进来
                    "workdirSource": "inherit"
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
    let executor = 执行器(dir)
        .with_agent_profiles(&内置角色())
        .with_acp_command("definitely-not-an-adapter", &[])
        .with_permission_preset("human_approval");

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
    // ai.decide 的端口是 auto_decided / escalated
    assert!(interpolate("${decide.auto_decided.text}", &scope).is_ok());
}

// ── 记忆注入与溯源（M4 出口标准）──────────────────────────────────────────
//
// 「记忆注入可在事件中溯源」——记忆会改变 AI 的行为，
// 而用户看到一个出乎意料的结果时，第一个要问的就是「它凭什么这么干」。
// 答案必须在运行记录里，而不是让他去猜当时有哪几条记忆生效。

fn mock_acp() -> (String, Vec<String>) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    (
        "node".to_string(),
        vec![script.display().to_string(), "echo-prompt".to_string()],
    )
}

fn ai_节点() -> GraphNode {
    node(
        "analyze",
        "ai.analyze",
        serde_json::json!({
            "instruction": "看看这段代码",
            "runtime": "acp.claude",
            "outputSchema": {}
        }),
    )
}

/// 从 mock 回显的输出里拿到它实际收到的提示词。
///
/// mock 的 echo-prompt 场景把收到的提示词原样当成回答发回来，
/// 于是它落在 `outputs.<node>.success.text` 里。
/// snapshot 是 Scope 唯一的读出口 —— 内部结构是私有的，测试也不该依赖它。
fn 收到的提示词(scope: &Scope, node_id: &str) -> String {
    // 端口按节点类型不同：ai.review 走 passed、ai.decide 走 auto_decided。
    // 写死 `.success` 的话，这个助手只对 ai.analyze / ai.execute 有效
    let snapshot = scope.snapshot();
    let outputs = snapshot["outputs"].as_object().cloned().unwrap_or_default();
    outputs
        .iter()
        .find(|(key, _)| key.starts_with(&format!("{node_id}.")))
        .and_then(|(_, value)| value["text"].as_str())
        .unwrap_or_default()
        .to_string()
}

#[test]
fn ai_节点把记忆拼进提示词() {
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_memories(&[
            ("style.commit".to_string(), "提交信息用中文".to_string()),
            (
                "worktree.cleanup".to_string(),
                "PR 合并前保留 worktree".to_string(),
            ),
        ]);

    let mut scope = Scope::new("run_mem");
    let outcome = executor.execute(&ai_节点(), &mut scope).unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );

    let prompt = 收到的提示词(&scope, "analyze");
    assert!(
        prompt.contains("提交信息用中文"),
        "记忆没进提示词：{prompt}"
    );
    assert!(prompt.contains("PR 合并前保留 worktree"));
}

#[test]
fn 注入的记忆记在执行器上_供上层写事件() {
    // 执行器不碰数据库（它连 store 都没有），所以把「注入了哪几条」
    // 报给上层，由 runner 写成 system.memory_injected 事件
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_memories(&[("style.commit".to_string(), "用中文".to_string())]);

    let mut scope = Scope::new("run_mem");
    executor.execute(&ai_节点(), &mut scope).unwrap();

    assert_eq!(
        executor.injected_memory_keys(),
        vec!["style.commit".to_string()],
        "要能说出注入了哪几条"
    );
}

#[test]
fn 没有记忆时提示词里不留空段() {
    // 留一句「已知的长期上下文：」后面什么都没有，
    // 模型会以为上下文被截断了
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("human_approval");

    let mut scope = Scope::new("run_mem");
    executor.execute(&ai_节点(), &mut scope).unwrap();

    let prompt = 收到的提示词(&scope, "analyze");
    assert!(
        !prompt.contains("长期上下文"),
        "没记忆就不该有这一段：{prompt}"
    );
}

#[test]
fn 非_ai_节点不注入记忆() {
    // 脚本节点拿记忆没有意义，而拼进环境变量反而会泄露
    let executor =
        执行器(workdir()).with_memories(&[("style.commit".to_string(), "用中文".to_string())]);

    let node = node(
        "sh",
        "script.shell",
        serde_json::json!({"interpreter": "bash", "script": "echo hi", "timeoutMs": 10000}),
    );
    let mut scope = Scope::new("run_mem");
    executor.execute(&node, &mut scope).unwrap();

    assert!(executor.injected_memory_keys().is_empty());
}

/// 审批档改变的是「门由谁批」，不是「哪些节点会被拦」。
///
/// 执行节点一个都不拦 —— 那一版的代价是「读一个 Issue 也要人点一次」。
/// 完整的档位行为在 `approval_gate_test.rs`；这里只留跨模块的那几条。
mod 审批档改变行为 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::node;
    use aiwf_engine::executor::NodeExecutor;
    use aiwf_engine::interp::Scope;
    use aiwf_engine::runner::NodeOutcome;

    fn 写文件节点() -> aiwf_engine::graph::GraphNode {
        node(
            "s1",
            "script.shell",
            serde_json::json!({ "interpreter": "zsh", "script": "echo x > probe.txt" }),
        )
    }

    #[test]
    fn 最严档下执行节点照样直接跑() {
        // 权限由流程管：想拦它就在它前面放一道门
        let dir = tempfile::tempdir().unwrap();
        let outcome = NodeExecutor::new(dir.path().to_path_buf())
            .with_permission_preset("human_approval")
            .execute(&写文件节点(), &mut Scope::new("run_perm"))
            .unwrap();

        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "执行节点被自动拦了 —— 那是上一版的行为：{outcome:?}"
        );
    }

    #[test]
    fn 没设过档位时按最严的一档办() {
        // 默认放宽等于替用户做了一个他不知道自己做过的决定
        let dir = tempfile::tempdir().unwrap();
        let 门 = node(
            "gate",
            "approval",
            serde_json::json!({"title": "确认", "interaction": "confirm"}),
        );
        let outcome = NodeExecutor::new(dir.path().to_path_buf())
            .execute(&门, &mut Scope::new("run_perm"))
            .unwrap();

        assert!(
            matches!(outcome, NodeOutcome::NeedsApproval),
            "没设过就该按最严的办：{outcome:?}"
        );
    }

    #[test]
    fn 库里躺着上一版的档位名时按最严处理() {
        // 正常路径上读取处会先跑一次迁移（risk::migrate_approval_mode），
        // 这一条守的是**迁移也没接上**时的兜底
        let dir = tempfile::tempdir().unwrap();
        let 门 = node(
            "gate",
            "approval",
            serde_json::json!({"title": "确认", "interaction": "confirm"}),
        );
        for 旧值 in ["review_every_change", "workspace_safe", "trusted_workflow"] {
            let outcome = NodeExecutor::new(dir.path().to_path_buf())
                .with_permission_preset(旧值)
                .execute(&门, &mut Scope::new("run_perm"))
                .unwrap();
            assert!(
                matches!(outcome, NodeOutcome::NeedsApproval),
                "{旧值} 被当成了已知档位：{outcome:?}"
            );
        }
    }
}

/// 角色声明的能力**不再由引擎强制**，而是写进提示词。
///
/// 上一版在 `check_capability` 里逐项拦：角色的「文件」权限不是可读写
/// 就不让 `ai.execute` 跑。现在的设计是**权限由流程管** ——
/// 执行节点拿最高权限，拦它的是工作流里那道 `approval` 门。
///
/// 但字段不能就此不生效：用户在角色页上逐项设过它们，一个字都没到过
/// 模型面前的话，那一屏就是装饰。所以它们进提示词，交给 agent 自觉遵守。
/// **角色页上「引擎强制，Prompt 无法越权」那句话必须跟着改。**
mod 角色的能力声明进提示词 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::{mock_acp, node, workdir, 收到的提示词};
    use aiwf_engine::executor::NodeExecutor;
    use aiwf_engine::interp::Scope;

    fn 带能力的角色(caps: &str) -> aiwf_engine::executor::AgentProfile {
        aiwf_engine::executor::AgentProfile {
            id: "ap_cap".to_string(),
            name: "执行者".to_string(),
            role: "执行".to_string(),
            goal: String::new(),
            persona: String::new(),
            runtime: "acp.codex".to_string(),
            model_ref: "model:codex".to_string(),
            fallback_model_ref: String::new(),
            output_contract: String::new(),
            capabilities_json: caps.to_string(),
            timeout_ms: 900_000,
        }
    }

    fn 挂角色的执行节点() -> aiwf_engine::graph::GraphNode {
        node(
            "fix",
            "ai.execute",
            serde_json::json!({
                "agentProfileId": "ap_cap",
                "instruction": "改一下",
                "workdirSource": "inherit"
            }),
        )
    }

    #[test]
    fn 声明的边界逐项进提示词() {
        let (command, args) = mock_acp();
        let executor = NodeExecutor::new(workdir())
            .with_acp_command(&command, &args)
            .with_agent_profiles(&[带能力的角色(
                r#"{"file":"read","command":"declared","network":"none","memory":"read","secret":[]}"#,
            )]);

        let mut scope = Scope::new("run_caps_note");
        executor.execute(&挂角色的执行节点(), &mut scope).unwrap();

        let 提示词 = 收到的提示词(&scope, "fix");
        for 片段 in ["文件 read", "命令 declared", "网络 none"] {
            assert!(
                提示词.contains(片段),
                "「{片段}」没进提示词 —— 角色页上那一栏就成了装饰：\n{提示词}"
            );
        }
    }

    #[test]
    fn 拼错的能力值按最严说给_agent_听() {
        // 枚举外的值当成 none。说成「可读写」的话，
        // agent 会以为自己被授权做一件用户没授权的事
        let (command, args) = mock_acp();
        let executor = NodeExecutor::new(workdir())
            .with_acp_command(&command, &args)
            .with_agent_profiles(&[带能力的角色(
                r#"{"file":"READ-WRITE","command":"any","network":"none","memory":"read","secret":[]}"#,
            )]);

        let mut scope = Scope::new("run_caps_bad");
        executor.execute(&挂角色的执行节点(), &mut scope).unwrap();

        let 提示词 = 收到的提示词(&scope, "fix");
        assert!(
            提示词.contains("文件 none"),
            "拼错的能力值没有按最严处理：\n{提示词}"
        );
    }

    #[test]
    fn 没挂角色的节点不凭空编一段边界出来() {
        let (command, args) = mock_acp();
        let executor = NodeExecutor::new(workdir()).with_acp_command(&command, &args);

        let mut scope = Scope::new("run_caps_none");
        let 没角色 = node(
            "fix",
            "ai.execute",
            serde_json::json!({"instruction": "改一下", "workdirSource": "inherit"}),
        );
        executor.execute(&没角色, &mut scope).unwrap();

        let 提示词 = 收到的提示词(&scope, "fix");
        assert!(
            !提示词.contains("这个角色声明的边界"),
            "没挂角色却说了一段边界：\n{提示词}"
        );
    }
}

// ── Agent 角色真的生效（M3 出口标准）────────────────────────────────────────
//
// 图纸「05 Agent 角色」把角色画成四块：角色与目标、性格与指令、
// 模型与 Runtime、权限与工具。而 `run_ai` 长期只读 `instruction` 与
// `runtime` —— 用户在那一屏上填的目标、人设、输出契约、能力，
// 一个字都没到过模型面前。
//
// 症状不是报错，是「界面上摆着一排设置，改了没有任何区别」。
// 而运行记录里那句「用了哪个角色」也就无从谈起。

fn 角色(id: &str) -> aiwf_engine::executor::AgentProfile {
    aiwf_engine::executor::AgentProfile {
        id: id.to_string(),
        name: "审查者".to_string(),
        role: "审查".to_string(),
        goal: "只读检查改动，按严重度排序".to_string(),
        persona: "挑毛病，但每条都要能落到具体某一行".to_string(),
        runtime: "acp.claude".to_string(),
        model_ref: "model:codex".to_string(),
            fallback_model_ref: String::new(),
        output_contract: "问题清单：严重度、文件与行、复现方式".to_string(),
        capabilities_json:
            r#"{"file":"read","command":"none","network":"none","memory":"read","secret":[]}"#
                .to_string(),
        timeout_ms: 900_000,
    }
}

fn 挂角色的_ai_节点(profile_id: &str) -> GraphNode {
    node(
        "review",
        "ai.review",
        serde_json::json!({
            "agentProfileId": profile_id,
            "instruction": "看看这段改动",
            "target": "diff",
            "outputSchema": {}
        }),
    )
}

#[test]
fn 角色的目标人设与输出契约都进了提示词() {
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&[角色("builtin:reviewer")]);

    let mut scope = Scope::new("run_role");
    let outcome = executor
        .execute(&挂角色的_ai_节点("builtin:reviewer"), &mut scope)
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );

    let prompt = 收到的提示词(&scope, "review");
    for 片段 in [
        "只读检查改动，按严重度排序",
        "挑毛病，但每条都要能落到具体某一行",
        "问题清单：严重度、文件与行、复现方式",
    ] {
        assert!(
            prompt.contains(片段),
            "角色的「{片段}」没进提示词：\n{prompt}"
        );
    }
    // 节点自己的指令仍然要在，而且在最后 —— 它是这一次要干的事
    assert!(prompt.trim_end().ends_with("看看这段改动"), "{prompt}");
}

#[test]
fn 角色不存在时当场失败_而不是悄悄按没有角色跑() {
    // 悄悄跑下去的话，用户得到的分析是一个没有人设、没有输出契约、
    // 也没有权限约束的模型给的 —— 而界面上显示的是「审查者」
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("human_approval");

    let mut scope = Scope::new("run_role");
    let outcome = executor
        .execute(&挂角色的_ai_节点("builtin:nobody"), &mut scope)
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("builtin:nobody"), "{message}");
            assert!(
                message.contains("Agent 角色"),
                "要说清缺的是什么：{message}"
            );
        }
        other => panic!("角色不存在该失败，实得 {other:?}"),
    }
}

#[test]
fn 角色的_runtime_压过节点上写的那个() {
    // 节点上的 runtime 是 M2 时期的写法（那时还没有角色）。
    // 两处都写着时以角色为准 —— 界面上用户改的是角色那一栏
    let profiles = [aiwf_engine::executor::AgentProfile {
        runtime: "acp.codex".to_string(),
        ..角色("builtin:reviewer")
    }];
    let executor = 执行器(workdir()).with_agent_profiles(&profiles);

    assert_eq!(
        executor.resolved_runtime(&挂角色的_ai_节点("builtin:reviewer")),
        "acp.codex",
        "节点上写的是 acp.claude，但角色说 acp.codex"
    );
}

#[test]
fn 解析结果记在执行器上_供上层写可解释性事件() {
    // 「用了哪个模型 / 哪条提示词 / 哪个角色」是运行记录要回答的问题。
    // 执行器不碰数据库，所以把它报给上层去写 system.model_resolved
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&[角色("builtin:reviewer")]);

    executor
        .execute(
            &挂角色的_ai_节点("builtin:reviewer"),
            &mut Scope::new("run_x"),
        )
        .unwrap();

    let 记录 = executor.resolutions();
    assert_eq!(记录.len(), 1, "一个 AI 节点该留一条解析记录");
    let 一条 = &记录[0];
    assert_eq!(一条.node_id, "review");
    assert_eq!(一条.agent_profile_id, "builtin:reviewer");
    // 模型页空着（没 with_models）：角色的 model:codex 无从解析，
    // 记录里写实话「agent 默认」—— 写一个没生效的引用才是误导
    assert_eq!(一条.model_ref, "agent 默认");
    assert_eq!(一条.runtime, "acp.claude");
}

#[test]
fn 没挂角色的_ai_节点照旧能跑() {
    // 已经存在的工作流里有一堆没写 agentProfileId 的 AI 节点。
    // 一刀切要求挂角色的话，它们会在这次升级之后全部跑不了
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("human_approval");

    let outcome = executor
        .execute(&ai_节点(), &mut Scope::new("run_plain"))
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );
}

#[test]
fn worktree_的相对路径按运行工作目录算_不是进程的_cwd() {
    // 端到端验证抓到的第二个真问题：上一个脚本节点
    // `gh repo clone … repo` 把仓库克隆进运行工作目录，
    // 下一个 worktree 节点写 `repoRoot: "repo"` —— 报「不是一个 Git 仓库」。
    //
    // 原因是 `PathBuf::from("repo")` 按**进程的 CWD** 解析，而那是
    // 应用自己的目录。脚本节点的 cwd 是运行工作目录，两个节点对
    // 「相对路径相对于谁」的理解不一致，而错误信息里看不出这件事。
    // 自己的临时目录，不用共用的那个：worktree 会**在仓库里留下一个分支**，
    // 共用目录跨次运行还在，第二次跑就报「分支已存在」——
    // 而那是这条用例本身的残留，不是被测行为
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "测试"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }
    std::fs::write(repo.join("README.md"), "hi").unwrap();
    for args in [vec!["add", "."], vec!["commit", "-qm", "初始"]] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }

    let outcome = 执行器(dir.clone())
        .with_permission_preset("human_approval")
        .execute(
            &node(
                "wt",
                "git.worktree",
                serde_json::json!({
                    "repoRoot": "repo",
                    "baseBranch": "main",
                    "branchTemplate": "fix/相对路径"
                }),
            ),
            &mut Scope::new("run_wt_rel"),
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { .. }),
        "相对路径该按运行工作目录算：{outcome:?}"
    );
}

#[test]
fn worktree_的绝对路径原样使用() {
    // 相对路径改了解析基准，绝对路径不能跟着变
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let outcome = 执行器(dir.clone())
        .with_permission_preset("human_approval")
        .execute(
            &node(
                "wt",
                "git.worktree",
                serde_json::json!({
                    "repoRoot": "/definitely/not/here",
                    "baseBranch": "main",
                    "branchTemplate": "x"
                }),
            ),
            &mut Scope::new("run_wt_abs"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => assert!(
            message.contains("/definitely/not/here"),
            "报错要说的是用户给的那个路径：{message}"
        ),
        other => panic!("实际：{other:?}"),
    }
}

// ── workdirSource 是承诺，不是装饰 ──────────────────────────────────────────
//
// `ai.execute` 的这个字段在契约里写着「工作目录来源\n由引擎强制，
// Prompt 不能改变安全边界」，图纸里也写着「Fix Agent 的 cwd 固定为
// $GIT_WORKTREE_PATH，不会污染你当前分支」。
//
// 而 `run_ai` 一直把运行工作目录直接当 cwd 交给 ACP 会话 ——
// 那句「由引擎强制」是空的，而且它是**安全**声明。

fn 执行节点(workdir_source: &str) -> GraphNode {
    node(
        "fix",
        "ai.execute",
        serde_json::json!({
            "agentProfileId": "builtin:builder",
            "instruction": "改一下",
            "workdirSource": workdir_source
        }),
    )
}

#[test]
fn 声明了_worktree_却没有上游_worktree_时当场失败() {
    // 悄悄退回运行工作目录的话，Agent 会直接在克隆出来的仓库里改 ——
    // 那正是「不会污染你当前分支」要防的事，而用户不会知道它发生了
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("human_approval")
        .with_agent_profiles(&内置角色());

    let outcome = executor
        .execute(&执行节点("worktree"), &mut Scope::new("run_wds"))
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("worktree"), "{message}");
        }
        other => panic!("没有上游 worktree 就不该跑，实得 {other:?}"),
    }
}

#[test]
fn 声明了_worktree_时_cwd_就是那个_worktree() {
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("human_approval")
        .with_agent_profiles(&内置角色());

    let mut scope = Scope::new("run_wds2");
    // 上游 worktree 节点的输出形状
    scope.set_node_output(
        "wt",
        "success",
        serde_json::json!({ "path": "/tmp/某个/worktree", "branch": "fix/1" }),
    );

    let outcome = executor.execute(&执行节点("worktree"), &mut scope).unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );
    assert_eq!(
        executor.resolutions().first().map(|r| r.workdir.clone()),
        Some("/tmp/某个/worktree".to_string()),
        "cwd 该是 worktree 的路径"
    );
}

#[test]
fn 声明了_inherit_时_cwd_是运行工作目录() {
    let (command, args) = mock_acp();
    let dir = workdir();
    let executor = 执行器(dir.clone())
        .with_acp_command(&command, &args)
        .with_permission_preset("human_approval")
        .with_agent_profiles(&内置角色());

    executor
        .execute(&执行节点("inherit"), &mut Scope::new("run_wds3"))
        .unwrap();

    assert_eq!(
        executor.resolutions().first().map(|r| r.workdir.clone()),
        Some(dir.display().to_string()),
    );
}

#[test]
fn 分析与审查节点不受_worktree_约束() {
    // 只有 ai.execute 有 workdirSource。分析、审查、决策是只读的，
    // 强制要求上游有 worktree 会让一条纯分析的工作流跑不了
    let (command, args) = mock_acp();
    let executor = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("human_approval")
        .with_agent_profiles(&内置角色());

    let outcome = executor
        .execute(&ai_节点(), &mut Scope::new("run_wds4"))
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );
}

// ── AI 节点走的端口必须真的存在 ─────────────────────────────────────────────
//
// `run_ai` 一直硬编码 `port: "success"`。而契约里：
// - ai.review 的端口是 passed / changes_requested
// - ai.decide 的端口是 auto_decided / escalated
//
// 于是事件流里写着「审查修复 完成 · 走 success 分支」—— 一个不存在的分支；
// 输出也落在 `outputs.review.success` 上，而下游写 `${review.passed}`
// 会解析不出来。两样都是**记录不准确**。
//
// 注意这修的不是「按模型的结论选端口」（那是条件路由，还没做），
// 修的是「说出来的那个端口至少得存在」。

#[test]
fn 各类_ai_节点走的端口都在节点目录里() {
    let (command, args) = mock_acp();

    for (node_type, extra) in [
        ("ai.analyze", serde_json::json!({ "target": "x" })),
        ("ai.review", serde_json::json!({ "target": "x" })),
        ("ai.decide", serde_json::json!({})),
        (
            "ai.execute",
            serde_json::json!({ "workdirSource": "inherit" }),
        ),
    ] {
        let mut config = serde_json::json!({
            "agentProfileId": "builtin:builder",
            "instruction": "干活"
        });
        for (key, value) in extra.as_object().unwrap() {
            config[key] = value.clone();
        }

        let executor = 执行器(workdir())
            .with_acp_command(&command, &args)
            .with_permission_preset("human_approval")
            .with_agent_profiles(&内置角色());
        let mut scope = Scope::new("run_ports");
        let outcome = executor
            .execute(&node("n", node_type, config), &mut scope)
            .unwrap();

        let NodeOutcome::Succeeded { port } = outcome else {
            panic!("{node_type} 没跑成功：{outcome:?}");
        };

        let 合法 = aiwf_engine::catalog::outputs(node_type, &serde_json::Value::Null);
        assert!(
            合法.iter().any(|p| p.id == port),
            "{node_type} 走了 {port}，而它的端口是 {:?}",
            合法.iter().map(|p| &p.id).collect::<Vec<_>>()
        );

        // 输出也要落在那个端口上，下游才引用得到
        assert!(
            scope.snapshot()["outputs"]
                .get(format!("n.{port}"))
                .is_some(),
            "{node_type} 的输出没落在 {port} 上"
        );
    }
}

// ── 对话、推理、工具调用要进事件流 ─────────────────────────────────────────
//
// 契约里有 conversation.* / reasoning.* / tool.* 九类事件，
// `event-store.ts` 的对话投影收着它们，执行记录那一屏有一个「对话」tab。
// 而执行器把 agent 的文本攒进一个本地变量、存成产物就完了 ——
// 一条都不发。
//
// 结果是：跑完一条有 4 个 AI 节点的工作流，「对话」tab 里写着
// 「这次运行没有 AI 节点，所以没有对话」。产物里明明躺着 2943 字节的
// 审查结论，用户在界面上一个字都看不到。

#[derive(Default)]
struct 收集器(std::sync::Mutex<Vec<aiwf_engine::executor::NodeEvent>>);

impl 收集器 {
    fn 取(&self) -> Vec<aiwf_engine::executor::NodeEvent> {
        self.0.lock().map(|v| v.clone()).unwrap_or_default()
    }
    fn 某类(&self, kind: &str) -> Vec<aiwf_engine::executor::NodeEvent> {
        self.取().into_iter().filter(|e| e.kind == kind).collect()
    }
}

fn 跑一个_ai_节点带收集() -> (收集器, Scope) {
    // echo-prompt 场景：把收到的提示词原样回显，方便断言内容
    let (command, args) = mock_acp();
    跑带收集(&command, &args)
}

/// normal 场景会报一次工具调用；echo-prompt 不会。
fn 跑一个_ai_节点带工具调用() -> (收集器, Scope) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    跑带收集(
        "node",
        &[script.display().to_string(), "normal".to_string()],
    )
}

fn 跑带收集(command: &str, args: &[String]) -> (收集器, Scope) {
    let executor = 执行器(workdir())
        .with_acp_command(command, args)
        .with_agent_profiles(&内置角色());

    let sink = 收集器::default();
    let mut scope = Scope::new("run_conv");
    executor
        .execute_with_sink(&ai_节点(), &mut scope, &|event| {
            if let Ok(mut list) = sink.0.lock() {
                list.push(event);
            }
        })
        .unwrap();
    (sink, scope)
}

#[test]
fn 发出去的提示词进对话流_那是往返的另一半() {
    // 「含 AI 节点的运行会在这里显示完整的往返消息」—— 只有 agent 的回答
    // 不叫往返。用户要能看到「我们到底问了它什么」，包括拼进去的记忆与角色
    let (sink, _) = 跑一个_ai_节点带收集();
    let 提问 = sink.某类("conversation.user_message");

    assert_eq!(提问.len(), 1, "该有且只有一条提问");
    assert_eq!(提问[0].node_id, "analyze");
    assert!(
        提问[0].summary.contains("看看这段代码"),
        "摘要里要看得出问的是什么：{}",
        提问[0].summary
    );
    assert!(
        提问[0].payload_ref.is_some(),
        "全文要落产物 —— 提示词拼上记忆和角色之后可能几 KB"
    );
}

#[test]
fn agent_的回答进对话流_全文落产物() {
    let (sink, _) = 跑一个_ai_节点带收集();
    let 回答 = sink.某类("conversation.agent_message");

    assert_eq!(回答.len(), 1);
    assert_eq!(回答[0].node_id, "analyze");
    assert!(!回答[0].summary.is_empty());
    assert_eq!(
        回答[0].payload_ref.as_deref(),
        Some("analyze/agent.md"),
        "payload_ref 要指得到产物，界面才点得开全文"
    );
}

#[test]
fn 摘要不超过存储层的上限() {
    // 存储层拒收超过 2000 字符的摘要（逼大内容走 artifact + payload_ref）。
    // 超了的话事件根本写不进去 —— 而那时对话流会**静默地少一条**
    let (sink, _) = 跑一个_ai_节点带收集();
    for event in sink.取() {
        assert!(
            event.summary.chars().count() <= 2000,
            "{} 的摘要有 {} 字符",
            event.kind,
            event.summary.chars().count()
        );
    }
}

#[test]
fn 工具调用逐个发_不是只留一个总数() {
    // 图纸的对话视图里是「工具活动 · 6 次读取，2 次搜索」——
    // 那需要知道每次调的是什么，一个总数拼不出这句话
    let (sink, _) = 跑一个_ai_节点带工具调用();
    // mock 报的是 status=completed，所以落成 finished ——
    // 对话投影只收 finished / failed，全发 started 的话那一行永远是空的
    let 工具 = sink.某类("tool.call_finished");

    assert!(!工具.is_empty(), "mock 会报一次工具调用");
    assert!(
        工具.iter().any(|e| e.summary.contains("读取 src/cache.js")),
        "每条要说清调的是什么：{:?}",
        工具.iter().map(|e| &e.summary).collect::<Vec<_>>()
    );
}

#[test]
fn 没有推理时不发空的推理事件() {
    // 一条「推理摘要：」后面什么都没有，比没有这条更糟
    let (sink, _) = 跑一个_ai_节点带收集();
    for event in sink.某类("reasoning.summary") {
        assert!(!event.summary.trim().is_empty());
    }
}

#[test]
fn 不带_sink_时照旧能跑() {
    // 已有的调用点（测试、外部调度）用的是 execute()，
    // 加了事件通道不能让它们全部改签名
    let (command, args) = mock_acp();
    let outcome = 执行器(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&内置角色())
        .execute(&ai_节点(), &mut Scope::new("run_nosink"))
        .unwrap();
    assert!(matches!(outcome, NodeOutcome::Succeeded { .. }));
}

#[test]
fn 非_ai_节点不往对话流里塞东西() {
    // 脚本节点的 stdout 有自己的 script.* 事件与产物，
    // 混进对话流会把「AI 说了什么」淹掉
    let sink = 收集器::default();
    执行器(workdir())
        .with_permission_preset("human_approval")
        .execute_with_sink(
            &node(
                "sh",
                "script.shell",
                serde_json::json!({ "interpreter": "zsh", "script": "echo hi" }),
            ),
            &mut Scope::new("run_sh"),
            &|event| {
                if let Ok(mut list) = sink.0.lock() {
                    list.push(event);
                }
            },
        )
        .unwrap();

    assert!(
        sink.某类("conversation.agent_message").is_empty(),
        "脚本节点不该产生对话事件"
    );
}

#[test]
fn 工具调用的完成事件带得上标题_计数也不翻倍() {
    // ACP 的首帧带标题，更新帧只带 id 与状态。不按 id 记住标题的话，
    // 完成事件是一条「（completed）」—— 对话视图那一行说不出调了什么。
    // 而两帧都计数的话，「工具活动 · N 次」会翻倍。
    let (sink, scope) = 跑一个_ai_节点带工具调用();

    let 完成 = sink.某类("tool.call_finished");
    assert_eq!(完成.len(), 1, "一次调用一条完成事件");
    assert!(
        完成[0].summary.contains("读取 src/cache.js"),
        "更新帧要补上首帧的标题：{}",
        完成[0].summary
    );

    let 开始 = sink.某类("tool.call_started");
    assert_eq!(开始.len(), 1, "首帧是 in_progress，落成 started");

    // 输出里的次数按「结束」算，不是按帧数
    let 次数 = scope.snapshot()["outputs"]["n.success"]["toolCalls"]
        .as_u64()
        .or_else(|| {
            scope.snapshot()["outputs"]
                .as_object()?
                .values()
                .find_map(|v| v.get("toolCalls")?.as_u64())
        });
    assert_eq!(次数, Some(1), "两帧算一次调用");
}

// ── 每类节点各自的记录 ──────────────────────────────────────────────────────
//
// 「每个节点的信息全部分开，不同节点展示方式不同」——前提是每类节点
// 得先**各自留下记录**。而在此之前，脚本节点跑完只有 node.started /
// node.succeeded 两条：命令是什么、退出码多少、输出在哪，一概没有。
// 契约里 script.started / stdout / stderr / exited 四类事件一条都没人发。

fn 收集(node: &GraphNode, executor: &NodeExecutor) -> (收集器, NodeOutcome) {
    let sink = 收集器::default();
    let outcome = executor
        .execute_with_sink(node, &mut Scope::new("run_pernode"), &|event| {
            if let Ok(mut list) = sink.0.lock() {
                list.push(event);
            }
        })
        .unwrap();
    (sink, outcome)
}

#[test]
fn 脚本节点记下命令与退出码() {
    let dir = workdir();
    let executor = 执行器(dir).with_permission_preset("human_approval");
    let (sink, outcome) = 收集(
        &node(
            "sh",
            "script.shell",
            serde_json::json!({ "interpreter": "zsh", "script": "echo 干活了" }),
        ),
        &executor,
    );
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );

    let 开始 = sink.某类("script.started");
    assert_eq!(开始.len(), 1, "要记下这一步到底跑了什么");
    assert!(开始[0].summary.contains("zsh"), "{}", 开始[0].summary);
    assert!(
        开始[0].summary.contains("echo 干活了"),
        "{}",
        开始[0].summary
    );
    assert_eq!(
        开始[0].payload_ref.as_deref(),
        Some("sh/command.sh"),
        "插值之后的完整命令要落产物 —— 摘要装不下几十行脚本"
    );

    let 结束 = sink.某类("script.exited");
    assert_eq!(结束.len(), 1);
    assert!(
        结束[0].summary.contains('0'),
        "退出码要写出来：{}",
        结束[0].summary
    );
}

#[test]
fn 脚本的输出各自成一条_指向各自的产物() {
    let dir = workdir();
    let executor = 执行器(dir).with_permission_preset("human_approval");
    let (sink, _) = 收集(
        &node(
            "sh2",
            "script.shell",
            serde_json::json!({
                "interpreter": "zsh",
                "script": "echo 正常输出; echo 出错了 >&2"
            }),
        ),
        &executor,
    );

    let out = sink.某类("script.stdout");
    assert_eq!(out.len(), 1);
    assert!(out[0].summary.contains("正常输出"));
    assert_eq!(out[0].payload_ref.as_deref(), Some("sh2/stdout.log"));

    let err = sink.某类("script.stderr");
    assert_eq!(err.len(), 1);
    assert!(err[0].summary.contains("出错了"));
    assert_eq!(err[0].payload_ref.as_deref(), Some("sh2/stderr.log"));
}

#[test]
fn 没有输出时不发空的输出事件() {
    // 一条「stdout：」后面什么都没有，比没有这条更糟
    let dir = workdir();
    let executor = 执行器(dir).with_permission_preset("human_approval");
    let (sink, _) = 收集(
        &node(
            "sh3",
            "script.shell",
            serde_json::json!({ "interpreter": "zsh", "script": "true" }),
        ),
        &executor,
    );
    assert!(sink.某类("script.stdout").is_empty());
    assert!(sink.某类("script.stderr").is_empty());
    // 但「跑了、退出码 0」这两条仍然要有
    assert_eq!(sink.某类("script.started").len(), 1);
    assert_eq!(sink.某类("script.exited").len(), 1);
}

#[test]
fn 脚本失败时日志事件照样发() {
    // 失败时最需要看日志。失败分支提前 return 的话，
    // 恰恰是这时候什么都没有
    let dir = workdir();
    let executor = 执行器(dir).with_permission_preset("human_approval");
    let (sink, outcome) = 收集(
        &node(
            "sh4",
            "script.shell",
            serde_json::json!({ "interpreter": "zsh", "script": "echo 要炸了 >&2; exit 3" }),
        ),
        &executor,
    );
    assert!(matches!(outcome, NodeOutcome::Failed { .. }), "{outcome:?}");

    assert_eq!(sink.某类("script.stderr").len(), 1, "失败时更需要日志");
    let 结束 = sink.某类("script.exited");
    assert_eq!(结束.len(), 1);
    assert!(
        结束[0].summary.contains('3'),
        "退出码要是真的：{}",
        结束[0].summary
    );
}

#[test]
fn worktree_节点记下分支与路径() {
    // 「在哪个分支、哪个目录里改的」是这一步唯一要说清的事，
    // 而它原先只躺在 scope 里 —— 运行记录上看不到
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "测试"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }
    std::fs::write(repo.join("README.md"), "hi").unwrap();
    for args in [vec!["add", "."], vec!["commit", "-qm", "初始"]] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }

    let executor = 执行器(dir).with_permission_preset("human_approval");
    let (sink, outcome) = 收集(
        &node(
            "wt",
            "git.worktree",
            serde_json::json!({
                "repoRoot": "repo",
                "baseBranch": "main",
                "branchTemplate": "fix/记录测试"
            }),
        ),
        &executor,
    );
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );

    let 输出 = sink.某类("node.output_emitted");
    assert_eq!(输出.len(), 1);
    assert!(
        输出[0].summary.contains("fix/记录测试"),
        "{}",
        输出[0].summary
    );
    assert!(输出[0].summary.contains("worktree"), "{}", 输出[0].summary);
}

/// `target` 是契约里 `ai.analyze` / `ai.review` 的**必填**配置字段
/// （`z.string().min(1)`，描述是「分析对象」/「审查对象」）。
///
/// 用户报的：内置模板用 `target: "${read_issue.success}"` 把 issue 正文
/// 传给分析师，而引擎从不读这个字段 —— AI 收到的提示词里只有角色和记忆，
/// 于是回了一句「请提供要分析的具体问题和现有证据」。
/// 界面能填、能存、能校验，引擎不读 —— 填了不生效比报错更糟。
mod 分析对象 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::{mock_acp, node, workdir, 执行器, 收到的提示词};

    use aiwf_engine::interp::Scope;
    use aiwf_engine::runner::NodeOutcome;

    #[test]
    fn target_要进提示词() {
        let (command, args) = mock_acp();
        let executor = 执行器(workdir())
            .with_acp_command(&command, &args)
            .with_permission_preset("human_approval");

        let mut scope = Scope::new("run_target");
        let outcome = executor
            .execute(
                &node(
                    "analyze",
                    "ai.analyze",
                    serde_json::json!({
                        "instruction": "定位根因",
                        "target": "登录接口偶发 500，日志里有 connection reset",
                        "runtime": "acp.claude"
                    }),
                ),
                &mut scope,
            )
            .unwrap();
        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "{outcome:?}"
        );

        let prompt = 收到的提示词(&scope, "analyze");
        assert!(
            prompt.contains("connection reset"),
            "分析对象没进提示词，AI 拿到的是一个空任务：{prompt}"
        );
        assert!(prompt.contains("定位根因"), "指令也要在：{prompt}");
    }

    #[test]
    fn target_里的变量引用要先解析() {
        // 内置模板写的是 `${read_issue.success}` —— 不解析的话，
        // agent 收到的是那串字面量，会把它当成一个真实存在的东西去理解
        let (command, args) = mock_acp();
        let executor = 执行器(workdir())
            .with_acp_command(&command, &args)
            .with_permission_preset("human_approval");

        let mut scope = Scope::new("run_target_interp");
        scope.set_node_output(
            "read_issue",
            "success",
            serde_json::json!("标题：登录超时\n正文：并发一高就 500"),
        );

        executor
            .execute(
                &node(
                    "analyze",
                    "ai.analyze",
                    serde_json::json!({
                        "instruction": "定位根因",
                        "target": "${read_issue.success}",
                        "runtime": "acp.claude"
                    }),
                ),
                &mut scope,
            )
            .unwrap();

        let prompt = 收到的提示词(&scope, "analyze");
        assert!(prompt.contains("并发一高就 500"), "{prompt}");
        assert!(!prompt.contains("${read_issue"), "留下了字面量：{prompt}");
    }

    #[test]
    fn 没有_target_的节点照常跑() {
        // ai.decide / ai.execute 的契约里没有 target —— 不能因为缺它就失败
        let (command, args) = mock_acp();
        let executor = 执行器(workdir())
            .with_acp_command(&command, &args)
            .with_permission_preset("human_approval");

        let mut scope = Scope::new("run_no_target");
        let outcome = executor
            .execute(
                &node(
                    "act",
                    "ai.execute",
                    // workdirSource 用 inherit：默认的 worktree 要求上游有
                    // git.worktree 节点，那是另一回事，会盖住这条要测的东西
                    serde_json::json!({
                        "instruction": "改一下",
                        "workdirSource": "inherit",
                        "runtime": "acp.claude"
                    }),
                ),
                &mut scope,
            )
            .unwrap();

        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "{outcome:?}"
        );
    }
}

/// 审批档说的话要算数。
///
/// **权限由流程管**：执行节点拿最高权限，引擎不再按节点类型或脚本内容
/// 自动拦截。要不要停下来问，取决于工作流里有没有在那个位置放一个
/// `approval` 节点。
///
/// 上一版在这里按风险自动拦，代价是「读一个 Issue 也要人点一次」——
/// 用户的原话。这一组盯着那个行为不要回来，以及它的代价被如实记着。
mod 审批档说的话要算数 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::{node, workdir};
    use aiwf_engine::executor::NodeExecutor;
    use aiwf_engine::runner::NodeOutcome;

    fn ai_execute() -> aiwf_engine::graph::GraphNode {
        node(
            "fix",
            "ai.execute",
            serde_json::json!({
                "instruction": "改一下",
                "workdirSource": "inherit",
                "runtime": "acp.codex"
            }),
        )
    }

    fn 门() -> aiwf_engine::graph::GraphNode {
        node(
            "gate",
            "approval",
            serde_json::json!({"title": "确认", "interaction": "confirm"}),
        )
    }

    #[test]
    fn 只有审批节点会被拦() {
        // 执行节点一个都不拦 —— 包括那个会放一个自主 agent
        // 进 worktree 写文件跑命令的 ai.execute。
        //
        // 这条看起来像在给一个危险行为背书，但它记的是一个**设计决定**：
        // 拦 ai.execute 的应该是它前面那道门（内置模板里就有一道），
        // 不是引擎。哪天有人想加回自动拦截，得先来改它
        let executor = NodeExecutor::new(workdir()).with_permission_preset("human_approval");

        assert!(
            executor.precheck(&ai_execute()).is_none(),
            "执行节点被自动拦了 —— 那是上一版的行为"
        );
        assert!(
            matches!(executor.precheck(&门()), Some(NodeOutcome::NeedsApproval)),
            "最严档下审批门没有挂起等人"
        );
    }

    #[test]
    fn 认不出的档位按最严处理() {
        // CLAUDE.md：「认不出的档位按最严处理」。
        // 反过来的话，库里一个拼错的档位名会把门静默交给 AI，
        // 而用户以为那是他要亲自批的
        let executor = NodeExecutor::new(workdir()).with_permission_preset("拼错的档位");

        assert!(
            matches!(executor.precheck(&门()), Some(NodeOutcome::NeedsApproval)),
            "认不出的档位把门交给了 AI"
        );
    }

    #[test]
    fn 角色声明的能力写进提示词_而不是被引擎强制() {
        // 角色页原来写着「权限（引擎强制，Prompt 无法越权）」，
        // 而现在引擎不强制了 —— 那句话必须跟着改，否则就是假承诺。
        //
        // 但**字段不能就此不生效**：用户在角色页上逐项设过它们，
        // 一个字都没到过模型面前的话，那一屏就是装饰。
        // 所以它们进提示词，交给 agent 自觉遵守
        let 只读角色 = aiwf_engine::executor::AgentProfile {
            id: "ap_ro".to_string(),
            name: "审查者".to_string(),
            role: "审查".to_string(),
            goal: String::new(),
            persona: String::new(),
            runtime: "acp.codex".to_string(),
            model_ref: "model:codex".to_string(),
            fallback_model_ref: String::new(),
            output_contract: String::new(),
            capabilities_json:
                r#"{"file":"read","command":"none","network":"none","memory":"read","secret":[]}"#
                    .to_string(),
            timeout_ms: 900_000,
        };
        let mut 节点 = ai_execute();
        节点.config["agentProfileId"] = serde_json::json!("ap_ro");

        let (command, args) = super::mock_acp();
        let executor = NodeExecutor::new(workdir())
            .with_permission_preset("human_approval")
            .with_acp_command(&command, &args)
            .with_agent_profiles(&[只读角色]);

        // 不再被拦下
        assert!(executor.precheck(&节点).is_none(), "引擎还在强制能力声明");

        // 而声明确实到了模型面前
        let mut scope = aiwf_engine::interp::Scope::new("run_cap_note");
        executor.execute(&节点, &mut scope).unwrap();
        let 提示词 = super::收到的提示词(&scope, "fix");
        assert!(
            提示词.contains("文件 read") && 提示词.contains("命令 none"),
            "角色声明的边界没进提示词 —— 那一屏就成了装饰：\n{提示词}"
        );
    }
}

/// 这一轮是怎么结束的，要算数。
///
/// `acp.rs` 认真把 `stopReason` 解析成五种（EndTurn / MaxTokens /
/// Refusal / Cancelled / Other），而执行器**一种都不看** ——
/// 只要 `prompt()` 返回 Ok 就是 Succeeded，事件里写「完成 · 走 success 分支」。
///
/// 于是模型明确拒答、答到一半撞上 token 上限被截断、这一轮被取消，
/// 全都记成成功，半句话原样进 scope 交给下游。而 `ai.review` / `ai.decide`
/// 的下游是按端口分支走的 —— 一次拒答会让工作流带着一段空文本
/// 继续跑审查、分级、审批。
///
/// 掩护它的是那个五分支枚举本身（看着像处理过），加上 mock 从头到尾
/// 只回 `end_turn`，非正常结束一条测试都没有。
mod 这一轮怎么结束的要算数 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::{node, workdir, 内置角色, 执行器};
    use aiwf_engine::executor::NodeEvent;
    use aiwf_engine::interp::Scope;
    use aiwf_engine::runner::NodeOutcome;

    fn 用场景跑(scenario: &str) -> (NodeOutcome, Vec<NodeEvent>) {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("仓库根")
            .join("tests/fixtures/acp-mock.mjs");
        let executor = 执行器(workdir())
            .with_permission_preset("human_approval")
            .with_agent_profiles(&内置角色())
            .with_acp_command(
                "node",
                &[script.display().to_string(), scenario.to_string()],
            );

        let 收到 = std::sync::Mutex::new(Vec::new());
        let mut scope = Scope::new("run_stop");
        let outcome = executor
            .execute_with_sink(
                &node(
                    "analyze",
                    "ai.analyze",
                    serde_json::json!({
                        "agentProfileId": "builtin:analyst",
                        "instruction": "分析一下",
                        "target": "某段代码",
                        "runtime": "acp.claude"
                    }),
                ),
                &mut scope,
                &|event| 收到.lock().unwrap().push(event),
            )
            .unwrap();
        (outcome, 收到.into_inner().unwrap())
    }

    #[test]
    fn 模型拒答时节点失败_而不是带着空话往下走() {
        let (outcome, _) = 用场景跑("refusal");

        match outcome {
            NodeOutcome::Failed { message } => {
                assert!(
                    message.contains("拒绝"),
                    "没说清是模型拒绝了这一轮：{message}"
                );
            }
            other => panic!("模型拒答却报成功，下游会拿着半句话继续跑：{other:?}"),
        }
    }

    #[test]
    fn 答到一半被截断时说清楚_而不是当成完整回答() {
        // 截断与拒答不一样：那半句话是有用的，不该丢。
        // 但下游必须知道它不完整 —— 一份被砍掉一半的方案清单
        // 看起来和一份完整的没有区别
        let (outcome, 事件) = 用场景跑("max-tokens");

        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "截断不该让节点整个失败 —— 那半句话还有用：{outcome:?}"
        );

        let 说了不完整 = 事件
            .iter()
            .any(|e| e.summary.contains("截断") || e.summary.contains("不完整"));
        assert!(
            说了不完整,
            "没有任何一条事件说这份回答是被截断的：{:?}",
            事件.iter().map(|e| &e.summary).collect::<Vec<_>>()
        );
    }

    #[test]
    fn 正常结束时不多嘴() {
        // 每一轮都发一条「这轮怎么结束的」是噪声 ——
        // 正常结束是默认情况，说出来反而让异常那条淹掉
        let (outcome, 事件) = 用场景跑("normal");

        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "{outcome:?}"
        );
        assert!(
            !事件
                .iter()
                .any(|e| e.summary.contains("截断") || e.summary.contains("拒绝")),
            "正常结束却报了异常"
        );
    }
}

/// 模型设不上时**说出来**，而不是悄悄换一个。
///
/// `system.model_downgraded` 这个事件类型契约里一直有，
/// 而全仓**零发射** —— 与此同时 `AgentsPage.tsx` 上写着
/// 「降级发生时会写入 RunEvent，不会静默替换模型」。
/// 那句话一直是假的，这条测试压着它成真。
#[test]
fn 模型被_agent_拒掉时发一条降级事件() {
    // mock 的候选里没有这个值，它会照真实 agent 的行为拒掉
    // （实测 codex -32602 / claude -32603）
    let executor = with_mock_adapter(ai_dir("downgrade"))
        .with_model(Some("这个模型压根不存在".to_string()), None);

    let sink = 收集器::default();
    let mut scope = Scope::new("run_downgrade");
    let outcome = executor
        .execute_with_sink(&ai_节点(), &mut scope, &|event| {
            if let Ok(mut list) = sink.0.lock() {
                list.push(event);
            }
        })
        .expect("执行");

    // 关键：**节点照跑不误**。用户说的是「模型失效就用系统默认的」，
    // 一个设不上的模型不该让整条工作流停在这儿
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "模型设不上不该让节点失败：{outcome:?}"
    );

    let 降级 = sink.某类("system.model_downgraded");
    assert_eq!(降级.len(), 1, "模型被拒了却没发降级事件");
    assert!(
        降级[0].summary.contains("这个模型压根不存在"),
        "降级事件要说清是哪个值没设上：{}",
        降级[0].summary
    );
}

/// AI 节点的实时帧真的推得出来。
///
/// 与事件流是两回事：事件落库、是事实来源；帧不落库、是「正在发生」的投影。
/// 不推的话，一个跑五分钟的 AI 节点在运行面板上只有几条工具调用在动，
/// 而 agent 说的话要等节点结束才一次性出现 —— 用户没法判断它是在想
/// 还是已经卡死。
mod 实时帧 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    /// 把帧收进 Vec。生产里是桌面壳 emit 成 Tauri 事件。
    #[derive(Default)]
    struct 收帧器(std::sync::Mutex<Vec<aiwf_engine::acp::StreamChunk>>);

    impl aiwf_engine::acp::ChunkSink for 收帧器 {
        fn push(&self, chunk: &aiwf_engine::acp::StreamChunk) {
            if let Ok(mut list) = self.0.lock() {
                list.push(chunk.clone());
            }
        }
    }

    #[test]
    fn ai_节点边说边推帧_并且带上是哪个节点() {
        let sink = std::sync::Arc::new(收帧器::default());
        let executor = with_mock_adapter(ai_dir("stream")).with_stream(sink.clone());

        let mut scope = Scope::new("run_stream");
        executor
            .execute(&ai_节点(), &mut scope)
            .expect("跑 AI 节点");

        let 帧 = sink.0.lock().unwrap().clone();
        assert!(!帧.is_empty(), "一帧都没推出来");

        // 文本帧要带节点 id：运行面板上同时可能有几个节点在跑，
        // 不带的话这段话不知道该显示在哪一条下面
        let 有文本 = 帧.iter().any(|chunk| {
            matches!(
                chunk,
                aiwf_engine::acp::StreamChunk::Text { node_id: Some(id), .. } if id == "analyze"
            )
        });
        assert!(有文本, "没有带节点 id 的文本帧：{帧:?}");
    }

    #[test]
    fn 不设_sink_时什么都不推_也不报错() {
        // 无头运行与测试都走这条 —— 推送是可选的增强，不是必需的路径
        let executor = with_mock_adapter(ai_dir("nostream"));
        let mut scope = Scope::new("run_nostream");
        executor
            .execute(&ai_节点(), &mut scope)
            .expect("没有 sink 也该跑得完");
    }
}

/// 模型选择：节点的 `modelPolicy` 与角色的 `model_ref` 要真的生效。
///
/// 这两个字段在界面上能填、能存、能过校验，而引擎长期一个都不读 ——
/// `with_model` 的管道铺好了，没有任何生产代码喂值。
/// 「填了不生效比报错更糟」（CLAUDE.md 第二条纪律）。
mod 模型选择 {
    use super::*;
    use aiwf_engine::executor::ModelEntry;

    /// 「模型」页登记的目录。与 mock adapter 的候选（mock-model-a/b/c）对齐。
    fn 模型目录() -> Vec<ModelEntry> {
        vec![
            条目("model:fast", "快的", "acp.claude", "mock-model-a", "low", true),
            条目("model:mid", "中的", "acp.claude", "mock-model-b", "medium", true),
            条目("model:best", "好的", "acp.claude", "mock-model-c", "high", true),
            // 别的 runtime 的条目，不该被 claude 节点选中
            条目("model:other", "别家的", "acp.codex", "gpt-x", "high", true),
        ]
    }

    fn 条目(
        id: &str,
        name: &str,
        runtime: &str,
        model_id: &str,
        effort: &str,
        enabled: bool,
    ) -> ModelEntry {
        ModelEntry {
            id: id.to_string(),
            name: name.to_string(),
            runtime: runtime.to_string(),
            model_id: model_id.to_string(),
            effort: effort.to_string(),
            enabled,
        }
    }

    fn 带策略的节点(policy: serde_json::Value) -> GraphNode {
        node(
            "analyze",
            "ai.analyze",
            serde_json::json!({
                "instruction": "看看这段代码",
                "runtime": "acp.claude",
                "modelPolicy": policy,
                "outputSchema": {}
            }),
        )
    }

    fn 挑模型的角色(model_ref: &str, fallback: &str) -> Vec<aiwf_engine::executor::AgentProfile> {
        vec![aiwf_engine::executor::AgentProfile {
            id: "prof:选型".to_string(),
            name: "选型".to_string(),
            role: String::new(),
            goal: String::new(),
            persona: String::new(),
            runtime: String::new(),
            model_ref: model_ref.to_string(),
            fallback_model_ref: fallback.to_string(),
            output_contract: String::new(),
            capabilities_json: r#"{"file":"read-write","command":"any","network":"any","memory":"read-write","secret":[]}"#.to_string(),
            timeout_ms: 900_000,
        }]
    }

    fn 挂角色的节点(policy: Option<serde_json::Value>) -> GraphNode {
        let mut config = serde_json::json!({
            "instruction": "看看",
            "runtime": "acp.claude",
            "agentProfileId": "prof:选型",
            "outputSchema": {}
        });
        if let Some(policy) = policy {
            config["modelPolicy"] = policy;
        }
        node("analyze", "ai.analyze", config)
    }

    #[test]
    fn 钉住的模型解析成它登记的_model_id_与推理档() {
        let executor = 执行器(ai_dir("pin")).with_models(&模型目录());
        let scope = Scope::new("run_pin");

        let 解析 = executor
            .resolution_for(&带策略的节点(serde_json::json!({ "modelId": "model:mid" })), &scope)
            .expect("AI 节点该有解析");
        assert_eq!(解析.model_ref, "mock-model-b", "钉住的没生效：{解析:?}");
        assert_eq!(解析.effort, "medium");
    }

    #[test]
    fn 质量档选_effort_最高的_快速档选最低的() {
        let executor = 执行器(ai_dir("tier")).with_models(&模型目录());
        let scope = Scope::new("run_tier");

        let 质量 = executor
            .resolution_for(&带策略的节点(serde_json::json!("quality")), &scope)
            .unwrap();
        assert_eq!(质量.model_ref, "mock-model-c");

        let 快速 = executor
            .resolution_for(&带策略的节点(serde_json::json!("fast")), &scope)
            .unwrap();
        assert_eq!(快速.model_ref, "mock-model-a");

        let 均衡 = executor
            .resolution_for(&带策略的节点(serde_json::json!("balanced")), &scope)
            .unwrap();
        assert_eq!(均衡.model_ref, "mock-model-b", "均衡档该优先 medium");
    }

    #[test]
    fn 档位只在同_runtime_的候选里挑() {
        // 目录里 effort 最高的是 codex 的 gpt-x —— claude 节点不能选它：
        // 交给 adapter 一个它不认识的名字，等于替用户把模型换掉
        let executor = 执行器(ai_dir("tier_rt")).with_models(&模型目录());
        let scope = Scope::new("run_tier_rt");

        let 解析 = executor
            .resolution_for(&带策略的节点(serde_json::json!("quality")), &scope)
            .unwrap();
        assert_eq!(解析.model_ref, "mock-model-c", "选到别的 runtime 的条目了");
    }

    #[test]
    fn 钉住的不可用时降级并退回角色默认() {
        let executor = with_mock_adapter(ai_dir("pin_gone"))
            .with_models(&模型目录())
            .with_agent_profiles(&挑模型的角色("model:mid", ""));
        let 节点 = 挂角色的节点(Some(serde_json::json!({ "modelId": "model:没登记" })));

        // 纯函数先答：退回角色的 model:mid
        let scope = Scope::new("run_pin_gone");
        let 解析 = executor.resolution_for(&节点, &scope).unwrap();
        assert_eq!(解析.model_ref, "mock-model-b", "没退回角色默认：{解析:?}");

        // 执行时要把「要的给不了」说出来
        let sink = 收集器::default();
        let mut scope = Scope::new("run_pin_gone");
        let outcome = executor
            .execute_with_sink(&节点, &mut scope, &|event| {
                if let Ok(mut list) = sink.0.lock() {
                    list.push(event);
                }
            })
            .expect("执行");
        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "模型解析不到不该让节点失败：{outcome:?}"
        );
        let 降级 = sink.某类("system.model_downgraded");
        assert_eq!(降级.len(), 1, "钉住的模型不可用却没报降级");
        assert!(
            降级[0].summary.contains("model:没登记"),
            "降级事件要说清是哪个：{}",
            降级[0].summary
        );
    }

    #[test]
    fn 角色主选不可用走后备_并报降级() {
        let executor = with_mock_adapter(ai_dir("fallback"))
            .with_models(&模型目录())
            .with_agent_profiles(&挑模型的角色("model:没了", "model:fast"));
        let 节点 = 挂角色的节点(None);

        let scope = Scope::new("run_fallback");
        let 解析 = executor.resolution_for(&节点, &scope).unwrap();
        assert_eq!(解析.model_ref, "mock-model-a", "后备没生效：{解析:?}");

        let sink = 收集器::default();
        let mut scope = Scope::new("run_fallback");
        executor
            .execute_with_sink(&节点, &mut scope, &|event| {
                if let Ok(mut list) = sink.0.lock() {
                    list.push(event);
                }
            })
            .expect("执行");
        let 降级 = sink.某类("system.model_downgraded");
        assert_eq!(降级.len(), 1, "主选不可用却没报降级");
        assert!(
            降级[0].summary.contains("model:没了"),
            "要说清主选是哪个：{}",
            降级[0].summary
        );
    }

    #[test]
    fn 停用的条目按没配处理_不算降级() {
        // 停用是用户的显式动作 —— 把他刚停用的模型报成「降级」，
        // 等于把他自己的决定当故障
        let mut 目录 = 模型目录();
        目录.push(条目("model:off", "停了的", "acp.claude", "mock-model-b", "high", false));
        let executor = with_mock_adapter(ai_dir("disabled")).with_models(&目录);
        let 节点 = 带策略的节点(serde_json::json!({ "modelId": "model:off" }));

        let scope = Scope::new("run_disabled");
        let 解析 = executor.resolution_for(&节点, &scope).unwrap();
        assert_eq!(解析.model_ref, "agent 默认", "停用的条目不该被选中：{解析:?}");

        let sink = 收集器::default();
        let mut scope = Scope::new("run_disabled");
        executor
            .execute_with_sink(&节点, &mut scope, &|event| {
                if let Ok(mut list) = sink.0.lock() {
                    list.push(event);
                }
            })
            .expect("执行");
        assert!(
            sink.某类("system.model_downgraded").is_empty(),
            "用户自己停用的模型不该报降级"
        );
    }

    #[test]
    fn 跨_runtime_的引用说得清是_runtime_不符() {
        // 「未登记、未启用或 runtime 不符」三选一的文案没人读得懂 ——
        // 分开说，用户才知道该去改哪里
        let executor = with_mock_adapter(ai_dir("cross_rt"))
            .with_models(&模型目录())
            .with_agent_profiles(&挑模型的角色("model:other", ""));
        let 节点 = 挂角色的节点(None);

        let sink = 收集器::default();
        let mut scope = Scope::new("run_cross_rt");
        executor
            .execute_with_sink(&节点, &mut scope, &|event| {
                if let Ok(mut list) = sink.0.lock() {
                    list.push(event);
                }
            })
            .expect("执行");
        let 降级 = sink.某类("system.model_downgraded");
        assert_eq!(降级.len(), 1);
        assert!(
            降级[0].summary.contains("runtime") && 降级[0].summary.contains("acp.codex"),
            "要说清是 runtime 不符、属于哪个 runtime：{}",
            降级[0].summary
        );
    }

    #[test]
    fn 解析出的值真的递给了_adapter() {
        // 接缝的另一半：resolution 与降级事件都出自 resolve_model，
        // 证明不了 open_session 收到的是同一个值 —— 把 SessionSpec 那两行
        // 改回 self.model 的话，前面所有用例照样绿。这条不一样：
        // model:zed 解析得出（在目录里）、但 mock 的候选里没有 ——
        // 只有值真的递过去，adapter 才会拒、才有这条降级事件
        let mut 目录 = 模型目录();
        目录.push(条目("model:zed", "目录里有的", "acp.claude", "mock-model-z", "high", true));
        let executor = with_mock_adapter(ai_dir("wired")).with_models(&目录);
        let 节点 = 带策略的节点(serde_json::json!({ "modelId": "model:zed" }));

        let sink = 收集器::default();
        let mut scope = Scope::new("run_wired");
        let outcome = executor
            .execute_with_sink(&节点, &mut scope, &|event| {
                if let Ok(mut list) = sink.0.lock() {
                    list.push(event);
                }
            })
            .expect("执行");
        assert!(matches!(outcome, NodeOutcome::Succeeded { .. }), "{outcome:?}");

        let 降级 = sink.某类("system.model_downgraded");
        assert_eq!(降级.len(), 1, "mock 拒掉的值没有产生降级 —— 解析结果没递给 adapter");
        assert!(
            降级[0].summary.contains("mock-model-z"),
            "降级要说清被拒的是哪个值：{}",
            降级[0].summary
        );
    }

    #[test]
    fn 更高的推理档也认得() {
        // xhigh / max / ultra 两端 runtime 都真实报过 —— 当 medium 排的话，
        // quality 会把最高档当中档
        let mut 目录 = 模型目录();
        目录.push(条目("model:ultra", "顶配", "acp.claude", "mock-model-a", "xhigh", true));
        let executor = 执行器(ai_dir("xhigh")).with_models(&目录);
        let scope = Scope::new("run_xhigh");

        let 解析 = executor
            .resolution_for(&带策略的节点(serde_json::json!("quality")), &scope)
            .unwrap();
        assert_eq!(解析.effort, "xhigh", "quality 没选中最高档：{解析:?}");
    }

    #[test]
    fn 模型页空着不算降级() {
        // 全新安装的机器上模型页是空的。每个 AI 节点都报一条降级是误导 ——
        // 那不是降级，是根本没登记过。agent 用自己的默认，与今天行为一致
        let executor = with_mock_adapter(ai_dir("no_catalog"))
            .with_agent_profiles(&挑模型的角色("model:mid", ""));
        let 节点 = 挂角色的节点(Some(serde_json::json!({ "modelId": "model:mid" })));

        let sink = 收集器::default();
        let mut scope = Scope::new("run_no_catalog");
        executor
            .execute_with_sink(&节点, &mut scope, &|event| {
                if let Ok(mut list) = sink.0.lock() {
                    list.push(event);
                }
            })
            .expect("执行");
        assert!(
            sink.某类("system.model_downgraded").is_empty(),
            "模型页空着不该报降级"
        );
    }

    #[test]
    fn 没配策略也没角色默认时不设模型() {
        let executor = 执行器(ai_dir("none")).with_models(&模型目录());
        let scope = Scope::new("run_none");

        let 解析 = executor.resolution_for(&ai_节点(), &scope).unwrap();
        assert_eq!(解析.model_ref, "agent 默认", "没配就该明说用 agent 默认");
        assert_eq!(解析.effort, "");
    }
}
