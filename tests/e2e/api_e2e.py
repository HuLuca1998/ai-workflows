#!/usr/bin/env python3
"""通过 HTTP 桥接跑真实工作流的端到端测试。

与 Rust 侧的集成测试互补：那些直接调引擎，这里走
「前端发的那条路」—— core-api 的分派、参数取值、DTO 序列化都在链路上。
两端形状对不上的问题只有这样才暴露得出来。

用法：
    python3 tests/e2e/api_e2e.py --api http://127.0.0.1:5177 --workdir /tmp/aiwf-e2e
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Result:
    name: str
    passed: bool
    detail: str = ""
    duration_ms: int = 0


@dataclass
class Report:
    results: list = field(default_factory=list)

    def check(self, name, condition, detail=""):
        self.results.append(Result(name, bool(condition), detail))
        mark = "✓" if condition else "✗"
        print(f"  {mark} {name}" + (f" — {detail}" if detail and not condition else ""))
        return bool(condition)

    @property
    def failed(self):
        return [r for r in self.results if not r.passed]


class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def call(self, command, payload=None):
        body = json.dumps(payload or {}).encode()
        request = urllib.request.Request(
            f"{self.base}/ipc/{command}",
            data=body,
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise ApiError(json.loads(error.read())) from error


class ApiError(Exception):
    def __init__(self, payload):
        self.payload = payload
        super().__init__(payload.get("message", str(payload)))


def graph_two_scripts():
    """两个 shell 节点串联，下游引用上游输出。"""
    return {
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口",
             "position": {"x": 40, "y": 40}, "config": {"trigger": "manual"}},
            {"id": "gen", "type": "script.shell", "title": "产出数据",
             "position": {"x": 290, "y": 40},
             "config": {"interpreter": "bash", "script": "echo hello-from-engine",
                        "timeoutMs": 10000}},
            {"id": "use", "type": "script.shell", "title": "消费上游输出",
             "position": {"x": 540, "y": 40},
             "config": {"interpreter": "bash",
                        "script": "echo received=${gen.success.stdout} > result.txt; cat result.txt",
                        "timeoutMs": 10000}},
            {"id": "done", "type": "end", "title": "结束",
             "position": {"x": 790, "y": 40}, "config": {"outcome": "success"}},
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "gen", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "gen", "port": "success"},
             "target": {"nodeId": "use", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "use", "port": "success"},
             "target": {"nodeId": "done", "port": "input"}},
        ],
        "groups": [],
    }


def graph_with_approval():
    return {
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口",
             "position": {"x": 40, "y": 40}, "config": {"trigger": "manual"}},
            {"id": "ap", "type": "approval", "title": "确认继续",
             "position": {"x": 290, "y": 40},
             "config": {"title": "确认继续", "interaction": "confirm"}},
            {"id": "after", "type": "script.shell", "title": "批准后执行",
             "position": {"x": 540, "y": 40},
             "config": {"interpreter": "bash", "script": "echo approved > approved.txt",
                        "timeoutMs": 10000}},
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "ap", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "ap", "port": "approved"},
             "target": {"nodeId": "after", "port": "input"}},
        ],
        "groups": [],
    }


def wait_for(api, run_id, wanted, limit=30):
    deadline = time.time() + limit
    last = None
    while time.time() < deadline:
        run = api.call("run_get", {"runId": run_id})
        last = run["status"] if run else "none"
        if last in wanted:
            return last
        time.sleep(0.25)
    return last


def create_with_graph(api, name, graph):
    workflow_id = api.call("workflow_create", {"name": name})
    rev = api.call("workflow_save_draft", {
        "id": workflow_id, "baseRev": 0, "graphJson": json.dumps(graph),
    })
    return workflow_id, rev


def suite_workflow_crud(api, report):
    print("\n▸ 工作流 CRUD")
    before = len(api.call("workflow_list", {}))
    workflow_id = api.call("workflow_create", {"name": "CRUD 测试"})
    report.check("建工作流返回 id", isinstance(workflow_id, str) and workflow_id.startswith("wf_"),
                 f"实际 {workflow_id!r}")
    report.check("列表增加一条", len(api.call("workflow_list", {})) == before + 1)

    detail = api.call("workflow_get", {"id": workflow_id})
    report.check("详情带回草稿 rev 与图", "rev" in detail and "graph_json" in detail,
                 f"字段 {list(detail)}")
    report.check("新建的图是空图", json.loads(detail["graph_json"])["nodes"] == [])

    # 版本守卫
    graph = graph_two_scripts()
    rev = api.call("workflow_save_draft", {
        "id": workflow_id, "baseRev": detail["rev"], "graphJson": json.dumps(graph)})
    report.check("存草稿后 rev 递增", rev > detail["rev"], f"{detail['rev']} → {rev}")

    try:
        api.call("workflow_save_draft", {
            "id": workflow_id, "baseRev": detail["rev"], "graphJson": json.dumps(graph)})
        report.check("用过期 baseRev 提交被拒绝", False, "居然成功了")
    except ApiError as error:
        report.check("用过期 baseRev 提交被拒绝",
                     error.payload.get("code") == "REVISION_CONFLICT",
                     f"错误码 {error.payload.get('code')}")

    published = api.call("workflow_publish", {"id": workflow_id, "rev": rev})
    report.check("发布产出版本号与配置哈希",
                 published.get("version") == 1 and len(published.get("config_hash", "")) > 0,
                 str(published))

    api.call("workflow_delete", {"id": workflow_id})
    report.check("删除后列表恢复", len(api.call("workflow_list", {})) == before)
    return True


def suite_dry_run(api, report, workdir):
    print("\n▸ Dry Run 依赖检查")
    workflow_id, rev = create_with_graph(api, "Dry Run 测试", graph_two_scripts())
    result = api.call("run_dry_run", {"workflowId": workflow_id, "draftRev": rev,
                                      "workdir": str(workdir)})
    labels = {c["label"]: c for c in result["checks"]}
    report.check("检查通过", result["ok"], json.dumps(result, ensure_ascii=False))
    report.check("检查了图结构", "图结构" in labels)
    report.check("检查了工作目录", "工作目录" in labels)
    report.check("检查了脚本用到的解释器", "解释器 bash" in labels)
    report.check("没有 git 节点就不查 git",
                 not any(l.startswith("git") for l in labels), str(list(labels)))

    # 未实现的节点类型必须在 Dry Run 就说清楚
    graph = graph_two_scripts()
    graph["nodes"].append({"id": "ai", "type": "ai.execute", "title": "AI",
                           "position": {"x": 40, "y": 200}, "config": {"instruction": "改"}})
    graph["edges"].append({"id": "e4", "source": {"nodeId": "done", "port": "success"},
                           "target": {"nodeId": "ai", "port": "input"}})
    ai_id, ai_rev = create_with_graph(api, "带 AI 节点", graph)
    ai_result = api.call("run_dry_run", {"workflowId": ai_id, "draftRev": ai_rev,
                                         "workdir": str(workdir)})
    report.check("AI 节点在 Dry Run 就报未实现",
                 not ai_result["ok"] and any("ai.execute" in c["label"] for c in ai_result["checks"]),
                 json.dumps(ai_result, ensure_ascii=False))

    # 工作目录不存在
    missing = api.call("run_dry_run", {"workflowId": workflow_id, "draftRev": rev,
                                       "workdir": "/definitely/not/here"})
    report.check("工作目录不存在被判缺失", not missing["ok"])
    return True


def suite_run_lifecycle(api, report, workdir):
    print("\n▸ 运行生命周期（真实执行脚本）")
    run_dir = workdir / "lifecycle"
    run_dir.mkdir(parents=True, exist_ok=True)
    workflow_id, rev = create_with_graph(api, "真实脚本流程", graph_two_scripts())

    run_id = api.call("run_start", {"workflowId": workflow_id, "draftRev": rev,
                                    "inputsJson": "{}", "workdir": str(run_dir)})
    report.check("启动返回 run id", isinstance(run_id, str) and run_id.startswith("run_"))

    status = wait_for(api, run_id, {"succeeded", "failed"})
    report.check("运行成功", status == "succeeded", f"实际 {status}")

    events = api.call("run_events", {"runId": run_id, "fromSeq": 0, "limit": 200})["events"]
    kinds = [e["kind"] for e in events]
    report.check("seq 从 1 起连续无缺口",
                 [e["seq"] for e in events] == list(range(1, len(events) + 1)))
    for expected in ["run.created", "run.preflight_passed", "run.queued",
                     "run.started", "run.succeeded"]:
        report.check(f"事件流含 {expected}", expected in kinds, str(kinds))
    for node in ["entry", "gen", "use", "done"]:
        report.check(f"{node} 有 started/succeeded 配对",
                     any(e["kind"] == "node.started" and e.get("nodeId") == node for e in events)
                     and any(e["kind"] == "node.succeeded" and e.get("nodeId") == node
                             for e in events))

    # 真实副作用：下游拿到了上游的输出
    result_file = run_dir / "result.txt"
    report.check("下游节点真的写出了文件", result_file.exists())
    if result_file.exists():
        content = result_file.read_text().strip()
        report.check("文件内容来自上游节点的 stdout",
                     content == "received=hello-from-engine", f"实际 {content!r}")

    # 产物
    artifacts = api.call("run_artifacts", {"runId": run_id})
    names = {f"{a['nodeId']}/{a['name']}" for a in artifacts["items"]}
    report.check("脚本的 stdout 落成产物", "gen/stdout.log" in names, str(sorted(names)))
    report.check("没有输出的节点不留空产物文件",
                 "entry/stdout.log" not in names, str(sorted(names)))
    return True


def suite_approval(api, report, workdir):
    print("\n▸ 审批与恢复")
    run_dir = workdir / "approval"
    run_dir.mkdir(parents=True, exist_ok=True)
    workflow_id, rev = create_with_graph(api, "带审批的流程", graph_with_approval())

    run_id = api.call("run_start", {"workflowId": workflow_id, "draftRev": rev,
                                    "inputsJson": "{}", "workdir": str(run_dir)})
    status = wait_for(api, run_id, {"waiting_approval", "failed", "succeeded"})
    report.check("跑到审批节点就停下", status == "waiting_approval", f"实际 {status}")
    report.check("批准前下游没有执行", not (run_dir / "approved.txt").exists())

    events = api.call("run_events", {"runId": run_id, "fromSeq": 0, "limit": 200})["events"]
    report.check("写了 approval.requested 事件",
                 any(e["kind"] == "approval.requested" for e in events))

    api.call("approval_decide", {"runId": run_id, "nodeId": "ap", "decision": "approved"})
    status = wait_for(api, run_id, {"succeeded", "failed"})
    report.check("批准后跑完", status == "succeeded", f"实际 {status}")
    report.check("批准后下游真的执行了", (run_dir / "approved.txt").exists())

    events = api.call("run_events", {"runId": run_id, "fromSeq": 0, "limit": 200})["events"]
    decided = [e for e in events if e["kind"] == "approval.decided"]
    report.check("审批决定记了是谁做的",
                 len(decided) == 1 and decided[0]["actor"] == "user",
                 str(decided))
    return True


def suite_parallel(api, report, workdir):
    print("\n▸ 并行运行互不影响")
    workflow_id, rev = create_with_graph(api, "并行测试", {
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口",
             "position": {"x": 0, "y": 0}, "config": {"trigger": "manual"}},
            {"id": "w", "type": "script.shell", "title": "写标记",
             "position": {"x": 250, "y": 0},
             "config": {"interpreter": "bash",
                        "script": "sleep 0.3; echo $AIWF_RUN_ID > who.txt",
                        "timeoutMs": 10000}},
        ],
        "edges": [{"id": "e1", "source": {"nodeId": "entry", "port": "success"},
                   "target": {"nodeId": "w", "port": "input"}}],
        "groups": [],
    })

    runs = {}
    for tag in ["a", "b", "c"]:
        run_dir = workdir / f"parallel-{tag}"
        run_dir.mkdir(parents=True, exist_ok=True)
        run_id = api.call("run_start", {"workflowId": workflow_id, "draftRev": rev,
                                        "inputsJson": "{}", "workdir": str(run_dir)})
        runs[run_id] = run_dir

    all_ok = True
    for run_id, run_dir in runs.items():
        status = wait_for(api, run_id, {"succeeded", "failed"}, limit=40)
        if status != "succeeded":
            all_ok = False
    report.check("三个并行运行都成功", all_ok)

    for run_id, run_dir in runs.items():
        marker = run_dir / "who.txt"
        report.check(f"{run_id[:12]} 写的是自己的 id",
                     marker.exists() and marker.read_text().strip() == run_id,
                     f"实际 {marker.read_text().strip() if marker.exists() else '(无文件)'}")
    return True


def suite_failure(api, report, workdir):
    print("\n▸ 失败处理")
    run_dir = workdir / "failure"
    run_dir.mkdir(parents=True, exist_ok=True)
    workflow_id, rev = create_with_graph(api, "会失败的流程", {
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口",
             "position": {"x": 0, "y": 0}, "config": {"trigger": "manual"}},
            {"id": "boom", "type": "script.shell", "title": "失败的脚本",
             "position": {"x": 250, "y": 0},
             "config": {"interpreter": "bash", "script": "echo 出错细节 >&2; exit 7",
                        "timeoutMs": 10000}},
            {"id": "after", "type": "script.shell", "title": "不该执行",
             "position": {"x": 500, "y": 0},
             "config": {"interpreter": "bash", "script": "echo x > should-not-exist.txt",
                        "timeoutMs": 10000}},
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "boom", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "boom", "port": "success"},
             "target": {"nodeId": "after", "port": "input"}},
        ],
        "groups": [],
    })

    run_id = api.call("run_start", {"workflowId": workflow_id, "draftRev": rev,
                                    "inputsJson": "{}", "workdir": str(run_dir)})
    status = wait_for(api, run_id, {"succeeded", "failed"})
    report.check("运行标记为失败", status == "failed", f"实际 {status}")
    report.check("失败节点的下游没有执行",
                 not (run_dir / "should-not-exist.txt").exists())

    events = api.call("run_events", {"runId": run_id, "fromSeq": 0, "limit": 200})["events"]
    failed = [e for e in events if e["kind"] == "node.failed"]
    report.check("记录了是哪个节点失败", len(failed) == 1 and failed[0]["nodeId"] == "boom",
                 str(failed))
    report.check("失败摘要里有退出码",
                 failed and "7" in failed[0]["summary"],
                 failed[0]["summary"] if failed else "")
    report.check("stderr 落成产物",
                 any(a["name"] == "stderr.log" for a in
                     api.call("run_artifacts", {"runId": run_id})["items"]))
    return True


def suite_cancel(api, report, workdir):
    print("\n▸ 取消运行")
    run_dir = workdir / "cancel"
    run_dir.mkdir(parents=True, exist_ok=True)
    workflow_id, rev = create_with_graph(api, "可取消的流程", {
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口",
             "position": {"x": 0, "y": 0}, "config": {"trigger": "manual"}},
            {"id": "slow", "type": "script.shell", "title": "慢节点",
             "position": {"x": 250, "y": 0},
             "config": {"interpreter": "bash", "script": "sleep 2", "timeoutMs": 20000}},
            {"id": "after", "type": "script.shell", "title": "取消后不该跑",
             "position": {"x": 500, "y": 0},
             "config": {"interpreter": "bash", "script": "echo x > after-cancel.txt",
                        "timeoutMs": 10000}},
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "slow", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "slow", "port": "success"},
             "target": {"nodeId": "after", "port": "input"}},
        ],
        "groups": [],
    })

    run_id = api.call("run_start", {"workflowId": workflow_id, "draftRev": rev,
                                    "inputsJson": "{}", "workdir": str(run_dir)})
    wait_for(api, run_id, {"running"}, limit=10)
    api.call("run_cancel", {"runId": run_id})
    status = wait_for(api, run_id, {"cancelled", "succeeded", "failed"}, limit=15)
    report.check("状态变为已取消", status == "cancelled", f"实际 {status}")
    time.sleep(1.0)
    report.check("取消后下游没有执行", not (run_dir / "after-cancel.txt").exists())
    return True


def suite_models(api, report):
    print("\n▸ 模型登记")
    before = len(api.call("model_list", {"enabledOnly": False}))
    model_id = api.call("model_create", {
        "name": "E2E 模型", "runtime": "acp_claude_code", "modelId": "claude-opus-5",
        "effort": "high", "contextWindow": 200000,
        "capabilities": ["结构化输出"], "credentialRef": "keychain://e2e", "enabled": True,
    })
    report.check("登记模型返回 id", isinstance(model_id, str) and model_id.startswith("model_"))

    items = api.call("model_list", {"enabledOnly": False})
    report.check("列表增加一条", len(items) == before + 1)
    created = next((m for m in items if m["id"] == model_id), None)
    report.check("凭据以引用形式存回", created and created["credentialRef"] == "keychain://e2e")

    try:
        api.call("model_create", {
            "name": "明文", "runtime": "acp_codex", "modelId": "x", "effort": "low",
            "contextWindow": 1000, "capabilities": [],
            "credentialRef": "sk-ant-plaintext-key", "enabled": True})
        report.check("明文密钥被拒绝", False, "居然写进去了")
    except ApiError as error:
        report.check("明文密钥被拒绝", "keychain://" in error.payload.get("message", ""),
                     error.payload.get("message", ""))
        report.check("报错里不回显密钥原文",
                     "plaintext-key" not in error.payload.get("message", ""),
                     error.payload.get("message", ""))

    api.call("model_update", {"id": model_id, "enabled": False})
    enabled_only = api.call("model_list", {"enabledOnly": True})
    report.check("停用后不出现在「只列已启用」里",
                 all(m["id"] != model_id for m in enabled_only))

    api.call("model_update", {"id": model_id, "name": "改名后"})
    after = next(m for m in api.call("model_list", {"enabledOnly": False})
                 if m["id"] == model_id)
    report.check("部分更新不清空其他字段",
                 after["name"] == "改名后" and after["modelId"] == "claude-opus-5"
                 and after["credentialRef"] == "keychain://e2e", str(after))

    api.call("model_delete", {"id": model_id})
    report.check("删除后列表恢复",
                 len(api.call("model_list", {"enabledOnly": False})) == before)
    return True


def suite_git_worktree(api, report, workdir, repo):
    print("\n▸ Git worktree（真实仓库）")
    if not repo or not Path(repo).is_dir():
        print("  跳过：没有提供 --repo")
        return True

    run_dir = workdir / "worktree"
    run_dir.mkdir(parents=True, exist_ok=True)
    branch = f"aiwf-e2e/{int(time.time())}"
    workflow_id, rev = create_with_graph(api, "worktree 测试", {
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口",
             "position": {"x": 0, "y": 0},
             "config": {"trigger": "manual",
                        "inputSchema": {"type": "object", "required": ["repo"],
                                        "properties": {"repo": {"type": "string"}}}}},
            {"id": "wt", "type": "git.worktree", "title": "建 worktree",
             "position": {"x": 250, "y": 0},
             "config": {"repoRoot": "${input.repo}", "baseBranch": "main",
                        "branchTemplate": branch}},
            {"id": "edit", "type": "script.shell", "title": "在 worktree 里改代码",
             "position": {"x": 500, "y": 0},
             "config": {"interpreter": "bash",
                        "script": "cd ${wt.success.path} && echo '// 由 AI Workflows 修改' >> src/cache.js && git add -A && git -c user.email=e2e@test -c user.name=E2E commit -qm '测试提交' && git log --oneline -1",
                        "timeoutMs": 30000}},
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "wt", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "wt", "port": "success"},
             "target": {"nodeId": "edit", "port": "input"}},
        ],
        "groups": [],
    })

    run_id = api.call("run_start", {
        "workflowId": workflow_id, "draftRev": rev,
        "inputsJson": json.dumps({"repo": str(repo)}), "workdir": str(run_dir)})
    status = wait_for(api, run_id, {"succeeded", "failed"}, limit=60)
    events = api.call("run_events", {"runId": run_id, "fromSeq": 0, "limit": 200})["events"]
    report.check("worktree 工作流成功", status == "succeeded",
                 " | ".join(e["summary"] for e in events[-3:]))

    # 主仓库工作区必须干净 —— worktree 存在的全部理由
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=repo,
                           capture_output=True, text=True).stdout.strip()
    report.check("主仓库工作区没有被动过", dirty == "", f"实际 {dirty!r}")

    branches = subprocess.run(["git", "branch", "--list", branch], cwd=repo,
                              capture_output=True, text=True).stdout.strip()
    report.check("新分支真的建出来了", branch in branches, f"实际 {branches!r}")

    # 清理
    worktrees = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=repo,
                               capture_output=True, text=True).stdout
    for line in worktrees.splitlines():
        if line.startswith("worktree ") and "aiwf" in line:
            subprocess.run(["git", "worktree", "remove", "--force", line.split(" ", 1)[1]],
                           cwd=repo, capture_output=True)
    subprocess.run(["git", "branch", "-D", branch], cwd=repo, capture_output=True)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:5177")
    parser.add_argument("--workdir", default="/tmp/aiwf-e2e-runs")
    parser.add_argument("--repo", default=None, help="真实 git 仓库路径（worktree 测试用）")
    parser.add_argument("--report", default=None, help="把结果写成 markdown")
    args = parser.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    api = Api(args.api)
    report = Report()

    started = time.time()
    suites = [
        ("工作流 CRUD", lambda: suite_workflow_crud(api, report)),
        ("Dry Run", lambda: suite_dry_run(api, report, workdir)),
        ("运行生命周期", lambda: suite_run_lifecycle(api, report, workdir)),
        ("审批", lambda: suite_approval(api, report, workdir)),
        ("并行", lambda: suite_parallel(api, report, workdir)),
        ("失败处理", lambda: suite_failure(api, report, workdir)),
        ("取消", lambda: suite_cancel(api, report, workdir)),
        ("模型登记", lambda: suite_models(api, report)),
        ("Git worktree", lambda: suite_git_worktree(api, report, workdir, args.repo)),
    ]

    for name, run in suites:
        try:
            run()
        except Exception as error:  # noqa: BLE001 - 套件崩了也要继续跑其余的
            report.check(f"{name} 套件本身没有崩", False, f"{type(error).__name__}: {error}")

    elapsed = time.time() - started
    total = len(report.results)
    failed = report.failed
    print(f"\n{'=' * 60}")
    print(f"共 {total} 项断言，失败 {len(failed)} 项，用时 {elapsed:.1f}s")
    for item in failed:
        print(f"  ✗ {item.name}" + (f" — {item.detail}" if item.detail else ""))

    if args.report:
        write_report(Path(args.report), report, elapsed)
    return 1 if failed else 0


def write_report(path, report, elapsed):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# 端到端测试报告（API 层）",
        "",
        f"- 断言总数：{len(report.results)}",
        f"- 失败：{len(report.failed)}",
        f"- 用时：{elapsed:.1f}s",
        "",
        "| 结果 | 断言 | 说明 |",
        "| ---- | ---- | ---- |",
    ]
    for item in report.results:
        mark = "✅" if item.passed else "❌"
        lines.append(f"| {mark} | {item.name} | {item.detail} |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"报告已写入 {path}")


if __name__ == "__main__":
    sys.exit(main())
