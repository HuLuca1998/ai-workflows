#!/usr/bin/env python3
"""真实 GitHub 场景：读 Issue → worktree → 改代码 → 提交 → 推送 → 建 PR。

这是「图纸里那条主线」的真实版本，只是把 AI 节点换成了脚本 ——
AI 节点要等 M3 接 ACP。除此之外每一步都是真的：
真的调 gh、真的建 worktree、真的推分支、真的开 PR。

需要 gh 已登录，且 --repo 指向一个你有写权限的仓库。
跑完会自动清理：关掉 PR、删远端分支、移除 worktree。

    python3 tests/e2e/github_scenario.py --repo /tmp/aiwf-e2e --issue 1
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from api_e2e import Api, Report, create_with_graph, wait_for  # noqa: E402


def graph(issue: str, repo_root: str, branch: str):
    """图纸「GitHub Issue 修复」的可执行版本。

    AI 节点（分析 / 执行 / 审查 / 决策）留给 M3；这里用脚本把
    读 Issue、改代码、提交、推送、开 PR 这几步真的做出来。
    """
    return {
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口 · Issue 输入",
             "position": {"x": 40, "y": 40},
             "config": {"trigger": "manual",
                        "inputSchema": {"type": "object", "required": ["issue", "repo"],
                                        "properties": {"issue": {"type": "string"},
                                                       "repo": {"type": "string"}}}}},

            {"id": "read_issue", "type": "script.shell", "title": "读取 Issue",
             "position": {"x": 290, "y": 40},
             "config": {"interpreter": "bash",
                        "script": f'cd "{repo_root}" && gh issue view ${{input.issue}} --json title,body',
                        "outputParse": "json", "timeoutMs": 60000}},

            {"id": "worktree", "type": "git.worktree", "title": "创建 Git worktree",
             "position": {"x": 540, "y": 40},
             "config": {"repoRoot": "${input.repo}", "baseBranch": "main",
                        "branchTemplate": branch}},

            {"id": "fix", "type": "script.shell", "title": "修复（脚本代替 AI）",
             "position": {"x": 790, "y": 40},
             "config": {"interpreter": "bash",
                        "script": """cd ${worktree.success.path} && cat > src/cache.js <<'JS'
// 配置缓存。TTL 到期前不重读磁盘。
const cache = new Map();
const TTL_MS = 60_000;

export function getConfig(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = readFromDisk(key);
  cache.set(key, { value, at: Date.now() });
  return value;
}

// 热重载时主动失效缓存条目，否则 TTL 到期前一直读到旧值
export function onFileChanged(key) {
  cache.delete(key);
  readFromDisk(key);
}

function readFromDisk(key) {
  return { key, loadedAt: Date.now() };
}
JS
echo written""",
                        "timeoutMs": 60000}},

            {"id": "verify", "type": "script.shell", "title": "验证改动",
             "position": {"x": 40, "y": 200},
             "config": {"interpreter": "bash",
                        "script": 'cd ${worktree.success.path} && grep -q "cache.delete" src/cache.js && echo 修复已生效',
                        "timeoutMs": 30000}},

            {"id": "approve", "type": "approval", "title": "审批 · 检查 Diff",
             "position": {"x": 290, "y": 200},
             "config": {"title": "将要 commit → push → 开 PR",
                        "bodyMarkdown": "外部写操作，需要确认。",
                        "interaction": "confirm"}},

            {"id": "push_pr", "type": "script.shell", "title": "Commit / Push / PR",
             "position": {"x": 540, "y": 200},
             "config": {"interpreter": "bash",
                        "script": """cd ${worktree.success.path} \
&& git add -A \
&& git -c user.email=e2e@aiwf.test -c user.name='AI Workflows E2E' commit -qm '修复配置热重载后缓存未失效' \
&& git push -q -u origin HEAD \
&& gh pr create --title '修复配置热重载后缓存未失效' --body '关闭 #${input.issue}

由 AI Workflows 端到端测试自动生成。' --base main""",
                        "timeoutMs": 180000}},

            {"id": "done", "type": "end", "title": "结束",
             "position": {"x": 790, "y": 200}, "config": {"outcome": "success"}},
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "read_issue", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "read_issue", "port": "success"},
             "target": {"nodeId": "worktree", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "worktree", "port": "success"},
             "target": {"nodeId": "fix", "port": "input"}},
            {"id": "e4", "source": {"nodeId": "fix", "port": "success"},
             "target": {"nodeId": "verify", "port": "input"}},
            {"id": "e5", "source": {"nodeId": "verify", "port": "success"},
             "target": {"nodeId": "approve", "port": "input"}},
            {"id": "e6", "source": {"nodeId": "approve", "port": "approved"},
             "target": {"nodeId": "push_pr", "port": "input"}},
            {"id": "e7", "source": {"nodeId": "push_pr", "port": "success"},
             "target": {"nodeId": "done", "port": "input"}},
        ],
        "groups": [],
    }


def git(repo, *args, check=False):
    result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {args} 失败：{result.stderr}")
    return result.stdout.strip()


def cleanup(repo, branch, report=None):
    """把测试留下的痕迹清干净：PR、远端分支、worktree、本地分支。"""
    subprocess.run(["gh", "pr", "close", branch, "--delete-branch"],
                   cwd=repo, capture_output=True, text=True)
    for line in git(repo, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree ") and "aiwf" in line:
            subprocess.run(["git", "worktree", "remove", "--force", line.split(" ", 1)[1]],
                           cwd=repo, capture_output=True)
    subprocess.run(["git", "branch", "-D", branch], cwd=repo, capture_output=True)
    subprocess.run(["git", "push", "origin", "--delete", branch], cwd=repo, capture_output=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:5177")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--issue", default="1")
    parser.add_argument("--workdir", default="/tmp/aiwf-github-scenario")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    branch = f"aiwf-e2e/fix-{args.issue}-{int(time.time())}"

    api = Api(args.api)
    report = Report()

    print(f"▸ 真实 GitHub 场景（仓库 {repo}，Issue #{args.issue}，分支 {branch}）")
    cleanup(repo, branch)

    workflow_id, rev = create_with_graph(
        api, f"GitHub Issue 修复 · {branch}", graph(args.issue, str(repo), branch))

    # Dry Run 先过一遍：真实工作流跑起来代价不小，先确认环境齐全
    check = api.call("run_dry_run", {"workflowId": workflow_id, "draftRev": rev,
                                     "workdir": str(workdir)})
    report.check("Dry Run 通过", check["ok"],
                 "; ".join(f"{c['label']}: {c['detail']}"
                           for c in check["checks"] if c["status"] == "failed"))
    if not check["ok"]:
        print("环境不齐，后面的步骤跑不了")
        return 1

    run_id = api.call("run_start", {"workflowId": workflow_id, "draftRev": rev,
                                    "inputsJson": json.dumps({"issue": args.issue,
                                                              "repo": str(repo)}),
                                    "workdir": str(workdir)})
    print(f"  运行 {run_id}")

    status = wait_for(api, run_id, {"waiting_approval", "failed", "succeeded"}, limit=180)
    events = api.call("run_events", {"runId": run_id, "fromSeq": 0, "limit": 300})["events"]
    report.check("跑到审批点停下", status == "waiting_approval",
                 " | ".join(f"{e['type']}: {e['summary']}" for e in events[-3:]))

    if status != "waiting_approval":
        cleanup(repo, branch)
        return 1

    # 审批之前：改动只在 worktree 里，主仓库和远端都没被动
    report.check("审批前主仓库工作区干净", git(repo, "status", "--porcelain") == "")
    report.check("审批前远端还没有这个分支",
                 branch not in git(repo, "ls-remote", "--heads", "origin"))

    artifacts = api.call("run_artifacts", {"runId": run_id})["items"]
    report.check("读 Issue 的输出落成产物",
                 any(a["nodeId"] == "read_issue" for a in artifacts),
                 str([a["nodeId"] for a in artifacts]))

    print("  批准，继续推送与开 PR…")
    api.call("approval_decide", {"runId": run_id, "nodeId": "approve", "decision": "approved"})
    status = wait_for(api, run_id, {"succeeded", "failed"}, limit=180)

    events = api.call("run_events", {"runId": run_id, "fromSeq": 0, "limit": 300})["events"]
    report.check("整条工作流成功", status == "succeeded",
                 " | ".join(f"{e['type']}: {e['summary']}" for e in events[-4:]))

    # 真实产物：分支推上去了、PR 开出来了
    report.check("分支已推到远端",
                 branch in git(repo, "ls-remote", "--heads", "origin"))

    pr_list = subprocess.run(["gh", "pr", "list", "--head", branch, "--json", "number,title,state"],
                             cwd=repo, capture_output=True, text=True).stdout
    prs = json.loads(pr_list) if pr_list.strip() else []
    report.check("PR 真的创建了", len(prs) == 1, pr_list)
    if prs:
        print(f"  PR #{prs[0]['number']}：{prs[0]['title']}")
        report.check("PR 标题来自工作流", "缓存" in prs[0]["title"], prs[0]["title"])

    # 事件流讲清了整个过程
    types = [e["type"] for e in events]
    for expected in ["run.created", "approval.requested", "approval.decided", "run.succeeded"]:
        report.check(f"事件流含 {expected}", expected in types)
    report.check("每个节点都有 succeeded 事件",
                 sum(1 for e in events if e["type"] == "node.succeeded") == 8,
                 str([e.get("nodeId") for e in events if e["type"] == "node.succeeded"]))

    print("\n  清理测试痕迹…")
    cleanup(repo, branch)
    report.check("清理后远端分支已删除",
                 branch not in git(repo, "ls-remote", "--heads", "origin"))

    failed = report.failed
    print(f"\n{'=' * 60}")
    print(f"共 {len(report.results)} 项断言，失败 {len(failed)} 项")
    for item in failed:
        print(f"  ✗ {item.name}" + (f" — {item.detail}" if item.detail else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
