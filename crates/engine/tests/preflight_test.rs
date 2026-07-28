//! Dry Run 依赖检查。
//!
//! 图纸的启动表单里有一块「Dry Run 依赖检查 · N 项通过 · M 项缺失」。
//! 这里只列**真的查过**的项：查不了的（ACP 握手、网络白名单）
//! 不出现在结果里，绝不放一个永远显示「通过」的假条目。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::graph::WorkflowGraph;
use aiwf_engine::preflight::{CheckStatus, dry_run};

fn graph(json: serde_json::Value) -> WorkflowGraph {
    serde_json::from_value(json).unwrap()
}

fn minimal() -> serde_json::Value {
    serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "run", "type": "script.shell", "title": "跑",
             "config": {"interpreter": "bash", "script": "echo hi"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "run", "port": "input"}}
        ],
        "groups": []
    })
}

#[test]
fn 图结构没问题时给出通过的检查项() {
    let workdir = std::env::temp_dir();
    let report = dry_run(&graph(minimal()), &workdir);

    let structure = report
        .checks
        .iter()
        .find(|c| c.label.contains("图结构"))
        .expect("应当有图结构检查");
    assert_eq!(structure.status, CheckStatus::Passed);
    assert!(report.ok);
}

#[test]
fn 有环的图在_dry_run_就被拦下_不必等到跑起来() {
    let cyclic = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A", "config": {"script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B", "config": {"script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "b", "port": "success"}, "target": {"nodeId": "a", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(cyclic), &std::env::temp_dir());
    assert!(!report.ok);
    let failed = report
        .checks
        .iter()
        .find(|c| c.status == CheckStatus::Failed)
        .unwrap();
    assert!(failed.detail.contains("环"), "详情实际：{}", failed.detail);
}

#[test]
fn 缺少入口节点时明确指出() {
    let no_entry = serde_json::json!({
        "nodes": [{"id": "a", "type": "script.shell", "title": "A", "config": {"script": "x"}}],
        "edges": [],
        "groups": []
    });
    let report = dry_run(&graph(no_entry), &std::env::temp_dir());
    assert!(!report.ok);
    assert!(
        report.checks.iter().any(|c| c.detail.contains("入口")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 工作目录不存在是缺失而不是通过() {
    let report = dry_run(
        &graph(minimal()),
        std::path::Path::new("/definitely/not/here"),
    );
    let workdir = report
        .checks
        .iter()
        .find(|c| c.label.contains("工作目录"))
        .expect("应当有工作目录检查");
    assert_eq!(workdir.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn 图里用到的解释器会被逐个检查() {
    let with_zsh = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A",
             "config": {"interpreter": "bash", "script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B",
             "config": {"interpreter": "definitely-not-a-shell", "script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_zsh), &std::env::temp_dir());

    let bash = report
        .checks
        .iter()
        .find(|c| c.label.contains("bash"))
        .unwrap();
    assert_eq!(bash.status, CheckStatus::Passed);
    let missing = report
        .checks
        .iter()
        .find(|c| c.label.contains("definitely-not-a-shell"))
        .unwrap();
    assert_eq!(missing.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn 同一个解释器用在多个节点上只检查一次() {
    let repeated = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A", "config": {"interpreter": "bash", "script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B", "config": {"interpreter": "bash", "script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(repeated), &std::env::temp_dir());
    assert_eq!(
        report
            .checks
            .iter()
            .filter(|c| c.label.contains("bash"))
            .count(),
        1
    );
}

#[test]
fn git_worktree_节点会检查_git_可用() {
    let with_git = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "wt", "type": "git.worktree", "title": "worktree",
             "config": {"repoRoot": "/tmp", "baseBranch": "main"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "wt", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_git), &std::env::temp_dir());
    assert!(
        report.checks.iter().any(|c| c.label.contains("git")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 没有_git_节点时不检查_git_不列无关条目() {
    // 列一堆与这个工作流无关的检查项，会让用户以为自己缺东西
    let report = dry_run(&graph(minimal()), &std::env::temp_dir());
    assert!(!report.checks.iter().any(|c| c.label.contains("git ")));
}

#[test]
fn 尚未实现的节点类型在_dry_run_就说清楚() {
    // 跑到一半才说「这个类型没实现」太晚了，那时已经产生了副作用
    let with_sub = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "sub", "type": "subworkflow", "title": "子流程", "config": {"workflowId": "wf_1"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "sub", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_sub), &std::env::temp_dir());
    let unimplemented = report
        .checks
        .iter()
        .find(|c| c.label.contains("subworkflow"))
        .expect("应当指出未实现的节点类型");
    assert_eq!(unimplemented.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn ai_节点检查的是_adapter_装没装_而不是类型没实现() {
    // 两件事说的话不一样：「类型没实现」是我们的问题，
    // 「adapter 没装」是用户能自己解决的
    let with_ai = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ai", "type": "ai.execute", "title": "修复",
             "config": {"instruction": "修", "runtime": "acp.claude"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "ai", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_ai), &std::env::temp_dir());

    // 不该再报「ai.execute 尚未实现」
    assert!(
        !report.checks.iter().any(|c| c.detail.contains("尚未实现")),
        "检查项：{:?}",
        report.checks
    );
    // 该有一条关于 adapter 的检查
    assert!(
        report
            .checks
            .iter()
            .any(|c| c.label.contains("ACP adapter")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 汇总计数与检查项一致() {
    let report = dry_run(&graph(minimal()), &std::env::temp_dir());
    assert_eq!(
        report.passed,
        report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Passed)
            .count()
    );
    assert_eq!(
        report.failed,
        report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Failed)
            .count()
    );
}

#[test]
fn 从入口到不了的节点要在_dry_run_就报出来() {
    // codex 的用户测试发现的：拖了三个节点忘了连线，
    // 校验说「通过」、Dry Run 说「3 个节点可依次执行」，
    // 然后引擎真的把那个孤立的脚本跑了 —— 用户没料到它会执行。
    let disconnected = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "orphan", "type": "script.shell", "title": "忘了连线的脚本",
             "config": {"interpreter": "bash", "script": "rm -rf /tmp/important"}},
            {"id": "end", "type": "end", "title": "结束", "config": {"outcome": "success"}}
        ],
        "edges": [],
        "groups": []
    });

    let report = dry_run(&graph(disconnected), &std::env::temp_dir());
    assert!(!report.ok, "有孤立节点时不该说「通过」");

    let unreachable = report
        .checks
        .iter()
        .find(|c| c.label.contains("可达"))
        .expect("应当有一条可达性检查");
    assert_eq!(unreachable.status, CheckStatus::Failed);
    assert!(
        unreachable.detail.contains("忘了连线的脚本") || unreachable.detail.contains("orphan"),
        "详情要指出是哪个节点：{}",
        unreachable.detail
    );
}

#[test]
fn 全部连通时可达性检查通过() {
    let connected = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "run", "type": "script.shell", "title": "跑",
             "config": {"interpreter": "bash", "script": "echo hi"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "run", "port": "input"}}
        ],
        "groups": []
    });

    let report = dry_run(&graph(connected), &std::env::temp_dir());
    let check = report
        .checks
        .iter()
        .find(|c| c.label.contains("可达"))
        .expect("应当有一条可达性检查");
    assert_eq!(check.status, CheckStatus::Passed);
}

// ── 脚本里的引号陷阱 ────────────────────────────────────────────────────────
//
// 端到端验证抓到的真问题：AI 写出 `gh issue view "${input.issue}"`，
// 而引擎替进去的值已经加过 shell 引号，命令收到的是 `"'1'"`，
// 报「invalid issue format」—— 错误信息离原因隔着一层引号。
//
// 引擎加引号是对的（单引号内没有元字符会被解释）。坏在这件事只有
// 跑起来才发现，而那时脚本可能已经产生了别的副作用。

fn 脚本图(script: &str) -> aiwf_engine::graph::WorkflowGraph {
    let graph = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"sh","type":"script.shell","title":"跑一下","position":{"x":1,"y":0},
             "config":{"interpreter":"zsh","script":script}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},
             "target":{"nodeId":"sh","port":"input"}}
        ],
        "groups": []
    });
    serde_json::from_value(graph).expect("图解析不了")
}

fn 找检查<'a>(
    report: &'a aiwf_engine::preflight::DryRunReport,
    关键词: &str,
) -> Option<&'a str> {
    report
        .checks
        .iter()
        .find(|c| c.label.contains(关键词))
        .map(|c| c.detail.as_str())
}

#[test]
fn 变量被重复加引号时_dry_run_就拦下() {
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(
        &脚本图(r#"gh issue view "${input.issue}" --repo "${input.repo}""#),
        dir.path(),
    );

    let detail = 找检查(&report, "引号").expect("该有一条引号检查");
    assert!(detail.contains("sh"), "要说清是哪个节点：{detail}");
    assert!(detail.contains("input.issue"), "要说清是哪个变量：{detail}");
    assert!(!report.ok, "这条该让 Dry Run 不通过");
}

#[test]
fn 单引号里的变量同样会被重复加引号() {
    let dir = tempfile::tempdir().unwrap();
    let report =
        aiwf_engine::preflight::dry_run(&脚本图("echo '${input.name}' > out.txt"), dir.path());
    assert!(找检查(&report, "引号").is_some(), "单引号也要认");
}

#[test]
fn 没套引号的变量不报() {
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(
        &脚本图("gh issue view ${input.issue} --repo ${input.repo}"),
        dir.path(),
    );
    assert!(找检查(&report, "引号").is_none(), "这是正确的写法，不该报");
}

#[test]
fn 引号里没有变量的照样不报() {
    // 「脚本里有引号」不是问题，「引号包着一个变量」才是
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(
        &脚本图("echo \"固定的一句话\" && echo '另一句'"),
        dir.path(),
    );
    assert!(找检查(&report, "引号").is_none());
}

#[test]
fn 变量只是挨着引号而不是被包住_不报() {
    // `echo "前缀"${input.x}` 是合法写法：引号闭合在变量之前
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(&脚本图("echo \"前缀\"${input.x}"), dir.path());
    assert!(找检查(&report, "引号").is_none(), "这不是重复加引号");
}
