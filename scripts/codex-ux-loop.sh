#!/usr/bin/env bash
#
# 让 codex 持续以用户身份使用这个应用，并逐轮写报告。
#
#   bash scripts/codex-ux-loop.sh            # 跑一轮
#   bash scripts/codex-ux-loop.sh --rounds 5 # 连跑五轮
#
# 每轮做三件事：
#   1. 读上一轮的报告，先复测里面还没修的问题
#   2. 自由使用，自己决定测什么
#   3. 写一份带编号的新报告到 docs/testing/ux-round-N-codex.md
#
# 报告全部留在仓库里 —— 它们是「这个功能被真人用过」的唯一证据，
# 而 CI 与单元测试都证明不了这件事。
#
# codex 只被允许写那一个报告文件。边界写死在 prompt 里，
# 跑完由调用方 git status 亲自核对。

set -euo pipefail

ROUNDS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --rounds) ROUNDS="$2"; shift 2 ;;
    *) echo "不认识的参数：$1（--rounds N）" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$HOME/.claude/skills/codex-collab/scripts/codex_dev.sh"

if [ ! -f "$SKILL" ]; then
  echo "找不到 codex_dev.sh：$SKILL" >&2
  exit 1
fi

# 服务没起来的话 codex 只会看到一片白，白跑一轮
if ! curl -sf -o /dev/null http://localhost:5173/ 2>/dev/null; then
  echo "web 没在 5173 上跑。先执行：bash scripts/local-test-env.sh start" >&2
  exit 1
fi

next_round() {
  local n=1
  while [ -f "$ROOT/docs/testing/ux-round-$n-codex.md" ]; do
    n=$((n + 1))
  done
  echo "$n"
}

# 上一轮的报告 = docs/testing 下最近改过的那份 ux-*-codex.md。
#
# 不按文件名推：早期几轮的名字各不相同（ux-audit / ux-retest / ux-free /
# ux-round3），按模式拼名字会漏掉它们，于是复测清单是空的 ——
# 第一次跑这个脚本时就这么漏了一轮。
latest_report() {
  ls -t "$ROOT"/docs/testing/ux-*-codex.md 2>/dev/null | head -1
}

for _ in $(seq 1 "$ROUNDS"); do
  ROUND="$(next_round)"
  REPORT="docs/testing/ux-round-$ROUND-codex.md"
  PREV_ABS="$(latest_report || true)"
  PREV_REPORT=""
  [ -n "$PREV_ABS" ] && PREV_REPORT="docs/testing/$(basename "$PREV_ABS")"

  echo "▸ 第 $ROUND 轮 → $REPORT"

  {
    echo "你是这个应用的用户。它跑在 http://localhost:5173。"
    echo
    echo "## 铁律（违反即任务失败）"
    echo "- 你**只能写一个文件**：\`$REPORT\`。除它以外不许创建、修改、删除任何文件。"
    echo "- 绝对不许改 apps/ crates/ packages/ tests/ scripts/ docs/design/ 下的任何内容。"
    echo "- 绝对不许 git commit / git push / 任何 gh 命令 / 任何 git 写操作。"
    echo "- 临时脚本与 Playwright 的失败产物都只放 /tmp。"
    echo "- 不要重启或停止 5173 与 5177 上的服务。"
    echo
    echo "## 环境"
    echo "- Web：http://localhost:5173"
    echo "- 后端 HTTP：127.0.0.1:5177/ipc/<方法名>（POST，JSON body）"
    echo "- 数据库：~/aiwf-local-test/data/aiwf.sqlite（只读查询）"
    echo "- 用 Playwright 驱动浏览器，脚本写在 /tmp"
    echo

    if [ -n "$PREV_REPORT" ] && [ -f "$ROOT/$PREV_REPORT" ]; then
      echo "## 第一部分：复测"
      echo "上一轮的报告在 \`$PREV_REPORT\`。先读它，逐条实测里面报的问题，"
      echo "写明「已修复 / 仍存在 / 部分修复」并给复现步骤。"
      echo "已经修好的不用再花时间。"
      echo
    fi

    echo "## 第二部分：自由使用"
    echo "像真实用户那样用它，自己决定这一轮想做什么、试到什么程度。"
    echo "想深挖某一处就深挖，想广泛走一遍就走一遍。"
    echo "**换一个和上轮不同的角度** —— 重复同样的路径没有新信息。"
    echo "遇到不顺手、看不懂、没反应、结果出乎意料的地方记下来；"
    echo "真正好用的地方也记下来，不要只找茬。"
    echo
    echo "## 输出"
    echo "写到 \`$REPORT\`，中文。结构你自己定，但每条问题都要能让别人照着复现，"
    echo "并按 🔴 走不通 / 🟡 能用但别扭 / 🟢 细节 分类。"
    echo "只写你**亲自操作遇到**的，不要读代码猜。"
  } | bash "$SKILL" -d "$ROOT" -l "ux-round-$ROUND"

  echo "▸ 第 $ROUND 轮完成"
done
