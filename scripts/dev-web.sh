#!/bin/bash
# Web 形态一键启动：devserver（真引擎的 HTTP 桥）+ Vite 前端。
#
# 直接 `pnpm dev` 起的前端**不连引擎** —— 没有 VITE_AIWF_SERVER 时
# apps/web/src/data/workspace.ts 退到 MemoryTransport，列表恒空。
# 页面全都进得去，于是「看到空态就以为对了」，这是假性通过的常见来源。
#
# 与 local-test-env.sh 的分工：那个后台常驻、数据留在 ~/aiwf-local-test，
# 给 precommit 的端到端用；这个前台跑、日志直接打在终端、Ctrl-C 两个一起退。
set -euo pipefail

cd "$(dirname "$0")/.."
# 从 GUI 或非登录 shell 起时 cargo 不在 PATH（打包版栽过同一个坑）
export PATH="$HOME/.cargo/bin:$PATH"

PORT=5177
WEB_PORT=5173
DB="$PWD/.aiwf/dev/aiwf.sqlite"
FRESH=0

usage() {
  cat <<'EOF'
用法：scripts/dev-web.sh [选项]

  --port <n>       devserver 端口（默认 5177）
  --web-port <n>   前端端口（默认 5173）
  --db <path>      数据库路径（默认 .aiwf/dev/aiwf.sqlite，已被 gitignore）
  --fresh          启动前删掉数据库，从空工作区开始
  -h, --help       看这段

Ctrl-C 一次同时停掉前后端。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 1 ;;
  esac
done

# 探活用 HTTP 而不是 lsof：端口在 TIME_WAIT 里也会被 lsof 看到，
# 于是脚本以为服务还在，实际早被杀了
server_alive() {
  curl -sf -o /dev/null -X POST "http://127.0.0.1:$PORT/ipc/workflow_list" -d '{}' 2>/dev/null
}

web_alive() {
  curl -sf -o /dev/null "http://localhost:$WEB_PORT/" 2>/dev/null
}

# -sTCP:LISTEN 不能省：不带它 lsof 连 ESTABLISHED 的**客户端**也一起报出来，
# 于是「清端口」把连着这个页面的浏览器给杀了
free_port() {
  lsof -ti:"$1" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "▸ 停止中…"
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  # pnpm 自己会 fork 出 vite，杀父进程留得下子进程占着端口 —— 按端口兜一道
  free_port "$WEB_PORT"
  free_port "$PORT"
  wait 2>/dev/null || true
  echo "已停止"
}
trap cleanup INT TERM EXIT

if [ "$FRESH" = 1 ]; then
  rm -f "$DB" "$DB-wal" "$DB-shm"
  echo "▸ 已清空数据库：$DB"
fi
mkdir -p "$(dirname "$DB")"

# 先编译再起：cargo run 会 fork 出真正的二进制，杀 cargo 未必杀得掉它，
# 拿不到准确的 pid 就收不干净
echo "▸ 编译 devserver…"
cargo build -q -p aiwf-devserver

free_port "$PORT"
free_port "$WEB_PORT"

# stdin 接 /dev/null：后台进程读终端会吃 SIGTTIN 挂起，
# vite 恰好要读 stdin 做交互快捷键
./target/debug/aiwf-devserver --port "$PORT" --db "$DB" < /dev/null &
SERVER_PID=$!

for _ in $(seq 1 30); do
  server_alive && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "devserver 起不来（见上面的输出）" >&2; exit 1; }
  sleep 1
done
server_alive || { echo "devserver 30 秒内没响应" >&2; exit 1; }

VITE_AIWF_SERVER="http://127.0.0.1:$PORT" pnpm --filter @aiwf/web dev --port "$WEB_PORT" < /dev/null &
WEB_PID=$!

for _ in $(seq 1 40); do
  web_alive && break
  kill -0 "$WEB_PID" 2>/dev/null || { echo "前端起不来（见上面的输出）" >&2; exit 1; }
  sleep 1
done
web_alive || { echo "前端 40 秒内没响应" >&2; exit 1; }

echo
echo "  前端      http://localhost:$WEB_PORT"
echo "  devserver http://127.0.0.1:$PORT"
echo "  数据库    $DB"
echo
echo "  Ctrl-C 停止"
echo

# 任一边挂了就整体收尾 —— 只剩前端活着最容易骗人：
# 界面照样开得出，数据全空
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done

kill -0 "$SERVER_PID" 2>/dev/null || echo "devserver 退出了" >&2
kill -0 "$WEB_PID" 2>/dev/null || echo "前端退出了" >&2
