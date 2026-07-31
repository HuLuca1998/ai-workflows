//! 审批风险判定。
//!
//! 这里判的是「这一步会造成什么」，判完交给档位决定谁来批。
//! 判低了等于把门让出去，所以每条降级用例都要有对应的
//! 「差一点就降级但不该降」的反例 —— 只测「该降的降了」的话，
//! 一个把什么都降成只读的实现也是全绿。

use aiwf_engine::risk::{
    ApprovalDecider, RiskLevel, approval_decider, base_risk, migrate_approval_mode, node_risk,
    script_risk,
};
use serde_json::json;

fn 脚本节点(script: &str) -> aiwf_engine::graph::GraphNode {
    serde_json::from_value(json!({
        "id": "n1",
        "type": "script.shell",
        "title": "脚本",
        "position": {"x": 0, "y": 0},
        "config": {"interpreter": "zsh", "script": script},
    }))
    .expect("构造节点")
}

// ---------------------------------------------------------------- 判定矩阵

#[test]
fn 判定矩阵与契约逐格一致() {
    // TypeScript 那份在 packages/contracts/src/approval.ts。
    // 两份实现，所以这张表在两边各写一次 —— 值不一样时，
    // 用户在设置里选的那一档在引擎里就是另一个意思
    let 矩阵: &[(&str, RiskLevel, ApprovalDecider)] = &[
        ("human_approval", RiskLevel::ReadOnly, ApprovalDecider::None),
        ("ai_assisted", RiskLevel::ReadOnly, ApprovalDecider::None),
        ("unattended", RiskLevel::ReadOnly, ApprovalDecider::None),
        (
            "human_approval",
            RiskLevel::WorkspaceWrite,
            ApprovalDecider::Human,
        ),
        (
            "ai_assisted",
            RiskLevel::WorkspaceWrite,
            ApprovalDecider::Ai,
        ),
        (
            "unattended",
            RiskLevel::WorkspaceWrite,
            ApprovalDecider::Ai,
        ),
        (
            "human_approval",
            RiskLevel::ExternalWrite,
            ApprovalDecider::Human,
        ),
        (
            "ai_assisted",
            RiskLevel::ExternalWrite,
            ApprovalDecider::Human,
        ),
        ("unattended", RiskLevel::ExternalWrite, ApprovalDecider::Ai),
    ];

    for (mode, risk, expected) in 矩阵 {
        assert_eq!(
            approval_decider(mode, *risk),
            *expected,
            "{mode} × {risk:?} 判成了别的"
        );
    }
}

#[test]
fn 认不出的档位全部按人工处理() {
    // 库里躺着上一版的档位名时走到这里。
    // 静默放行的话，用户以为自己选了某一档，实际一道门都没有
    for 旧值 in ["review_every_change", "workspace_safe", "trusted_workflow", ""] {
        for risk in [RiskLevel::WorkspaceWrite, RiskLevel::ExternalWrite] {
            assert_eq!(
                approval_decider(旧值, risk),
                ApprovalDecider::Human,
                "{旧值} 被当成了已知档位"
            );
        }
    }
}

#[test]
fn 无人值守也要留下是谁放行的() {
    // 返回 None 就没有 approval.decided 事件，
    // 事后没人能回答「这次 push 是谁批的」
    assert_eq!(
        approval_decider("unattended", RiskLevel::ExternalWrite),
        ApprovalDecider::Ai
    );
}

// -------------------------------------------------------------- 旧值迁移

#[test]
fn 上一版的档位按严格程度映射过来() {
    // 用户从旧版升上来，库里躺着这三个值。读取处不迁移的话，
    // 它们会全部落到「认不出 → 最严」那一支 —— 一个原本选了
    // 「全放行」的用户升级后突然每一步都被拦，而他没改过任何设置。
    //
    // 与契约的 migrateApprovalMode 逐条等价
    assert_eq!(migrate_approval_mode("review_every_change"), "human_approval");
    assert_eq!(migrate_approval_mode("workspace_safe"), "ai_assisted");
    assert_eq!(migrate_approval_mode("trusted_workflow"), "unattended");
}

#[test]
fn 新值原样返回() {
    // 迁移在每次读取时都跑，把已经迁好的又改一遍就成了另一个 bug
    for mode in ["human_approval", "ai_assisted", "unattended"] {
        assert_eq!(migrate_approval_mode(mode), mode);
    }
}

#[test]
fn 认不出的值迁到最严那档() {
    for 坏值 in ["", "随便什么", "Workspace Safe"] {
        assert_eq!(migrate_approval_mode(坏值), "human_approval", "{坏值}");
    }
}

// ------------------------------------------------------------ 基线来自契约

#[test]
fn 基线风险读的是生成物不是手抄的表() {
    // 抄一份的话会与契约悄悄分叉。这几条是抽样，
    // 全覆盖那条在 contract_sync_test 里
    assert_eq!(base_risk("entry"), RiskLevel::ReadOnly);
    assert_eq!(base_risk("ai.analyze"), RiskLevel::ReadOnly);
    assert_eq!(base_risk("ai.execute"), RiskLevel::WorkspaceWrite);
    assert_eq!(base_risk("git.worktree"), RiskLevel::WorkspaceWrite);
    assert_eq!(base_risk("mcp.tool"), RiskLevel::ExternalWrite);
}

#[test]
fn 未登记的节点类型按外部写算() {
    // 契约加了新节点而生成物没重新生成时走到这里。
    // 默认只读的话，新节点会带着「三档全放行」上线
    assert_eq!(base_risk("something.new"), RiskLevel::ExternalWrite);
}

// -------------------------------------------------------------- 脚本嗅探

#[test]
fn 只读命令不该拦() {
    // 用户的原话：「现在连读取 issue 都需要用户审批」。
    // 这条就是那句话
    for 脚本 in [
        "gh issue view \"$ISSUE\" --repo owner/repo --json title,body",
        "git log --oneline -20",
        "git status",
        "git diff HEAD~1",
        "cat README.md",
        "ls -la src/",
        "echo hello",
        "grep -rn TODO src/",
        "cat a.txt | grep x | wc -l",
        "gh pr view 12 --json title",
        "",
        "# 只有注释\n\n# 再来一条",
    ] {
        assert_eq!(
            script_risk(脚本),
            RiskLevel::ReadOnly,
            "这段本该放行：{脚本:?}"
        );
    }
}

#[test]
fn 外部写命令要判到最高档() {
    for 脚本 in [
        "git push -u origin HEAD",
        "git push",
        "gh pr create --fill",
        "gh issue comment 5 --body hi",
        "gh release create v1.0.0",
        "npm publish",
        "cargo publish",
        "docker push repo/image:tag",
        "curl -X POST https://example.com/hook",
        "curl -d 'a=1' https://example.com/hook",
        // 前面只读、后面推送 —— 取最高那一段
        "gh issue view 1 && git push",
        // 换行分隔同理
        "set -euo pipefail\ngit add -A\ngit commit -m x\ngit push",
    ] {
        assert_eq!(
            script_risk(脚本),
            RiskLevel::ExternalWrite,
            "这段本该按外部写算：{脚本:?}"
        );
    }
}

#[test]
fn 差一点就降级但不该降的() {
    // 只测「该降的降了」的话，一个把什么都判成只读的实现也全绿。
    // 这几条长得像只读，但不是
    for 脚本 in [
        // 重定向就是写文件，哪怕左边是 echo
        "echo hello > out.txt",
        "cat a.txt >> b.txt",
        // tee 不在只读白名单里 —— 管道右边同样要查
        "cat a.txt | tee out.txt",
        // 命令替换里的东西看不见，不给降级
        "echo $(some-unknown-thing)",
        "echo `whatever`",
        // 白名单里没有的命令
        "rm -rf build/",
        "mv a b",
        "pnpm install",
        "git commit -m x",
        // find 带 -exec 能执行任意命令
        "find . -name '*.tmp' -exec rm {} ;",
        // 只读命令 + 一个陌生命令
        "git log && ./deploy.sh",
    ] {
        assert_eq!(
            script_risk(脚本),
            RiskLevel::WorkspaceWrite,
            "这段不该降到只读：{脚本:?}"
        );
    }
}

#[test]
fn 藏在命令替换里的推送照样识别() {
    // 嗅探只看命令的第一个词的话，这条会漏
    assert_eq!(script_risk("echo $(git push)"), RiskLevel::ExternalWrite);
}

#[test]
fn gh_api_不进只读白名单() {
    // `gh api` 默认 GET，看着像只读 —— 但 `-X POST` 只差三个字符，
    // 而白名单是按命令名匹配的。整条命令族排除掉
    assert_eq!(script_risk("gh api repos/o/r"), RiskLevel::WorkspaceWrite);
    assert_eq!(
        script_risk("gh api -X DELETE repos/o/r/issues/1"),
        RiskLevel::ExternalWrite
    );
}

// ---------------------------------------------------------- 节点整体判定

#[test]
fn shell_脚本按内容判定可以低于基线() {
    // script.shell 的基线是 workspace_write，而这一条比基线还低。
    // 这正是用户那句「连读取 issue 都需要用户审批」要的结果 ——
    // 敢降是因为白名单要求**整段**脚本每条命令都只读
    let 只读脚本 = 脚本节点("git log");
    assert_eq!(node_risk(&只读脚本), RiskLevel::ReadOnly);

    let 推送脚本 = 脚本节点("git push");
    assert_eq!(node_risk(&推送脚本), RiskLevel::ExternalWrite);

    // 白名单挡住的那半句：只读命令后面跟一个陌生的，就不降了
    let 混合脚本 = 脚本节点("git log && ./deploy.sh");
    assert_eq!(node_risk(&混合脚本), RiskLevel::WorkspaceWrite);
}

#[test]
fn python_脚本不嗅探内容一律用基线() {
    // 这里没有 Python 的解析，猜不出 subprocess.run 里装着什么。
    // 「看起来只读」在这里必须等于「不知道」
    let python: aiwf_engine::graph::GraphNode = serde_json::from_value(json!({
        "id": "p1",
        "type": "script.python",
        "title": "python",
        "position": {"x": 0, "y": 0},
        "config": {"script": "print('hello')"},
    }))
    .expect("构造节点");
    assert_eq!(node_risk(&python), RiskLevel::WorkspaceWrite);
}

#[test]
fn 非脚本节点不做内容嗅探直接用基线() {
    let ai执行: aiwf_engine::graph::GraphNode = serde_json::from_value(json!({
        "id": "n2",
        "type": "ai.execute",
        "title": "执行",
        "position": {"x": 0, "y": 0},
        // 配置里出现 "git push" 字样也不该改变判定 ——
        // 那是给 agent 看的指令，不是要执行的命令
        "config": {"agentProfileId": "builtin:builder", "instruction": "别 git push"},
    }))
    .expect("构造节点");
    assert_eq!(node_risk(&ai执行), RiskLevel::WorkspaceWrite);
}
