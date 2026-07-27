#!/bin/bash
# 本地测试环境：数据留存，不清空。
#
# 每个里程碑的功能都在这里跑一遍，工作流、运行记录、产物都留着，
# 出问题时可以直接翻历史，而不是「重跑一次看看还会不会出现」。
set -e

ROOT="${AIWF_TEST_ROOT:-$HOME/aiwf-local-test}"
PORT="${AIWF_TEST_PORT:-5177}"
WEB_PORT="${AIWF_WEB_PORT:-5173}"

mkdir -p "$ROOT"/{data,runs,repos,reports}

case "${1:-start}" in
  start)
    if lsof -ti:$PORT > /dev/null 2>&1; then
      echo "devserver 已在 $PORT 上跑着"
    else
      cargo build -q -p aiwf-devserver
      nohup ./target/debug/aiwf-devserver --port "$PORT" --db "$ROOT/data/aiwf.sqlite" \
        > "$ROOT/devserver.log" 2>&1 &
      sleep 2
      echo "devserver → http://127.0.0.1:$PORT（库：$ROOT/data/aiwf.sqlite）"
    fi

    if lsof -ti:$WEB_PORT > /dev/null 2>&1; then
      echo "web 已在 $WEB_PORT 上跑着"
    else
      VITE_AIWF_SERVER="http://127.0.0.1:$PORT" nohup pnpm dev > "$ROOT/web.log" 2>&1 &
      for _ in $(seq 1 30); do
        curl -sf -o /dev/null "http://localhost:$WEB_PORT/" && break
        sleep 1
      done
      echo "web       → http://localhost:$WEB_PORT"
    fi
    ;;

  stop)
    lsof -ti:$PORT | xargs kill 2>/dev/null || true
    lsof -ti:$WEB_PORT | xargs kill 2>/dev/null || true
    echo "已停止"
    ;;

  status)
    echo "数据目录：$ROOT"
    if [ -f "$ROOT/data/aiwf.sqlite" ]; then
      sqlite3 "$ROOT/data/aiwf.sqlite" "
        SELECT '  工作流 ' || COUNT(*) FROM workflow;
        SELECT '  运行   ' || COUNT(*) FROM run;
        SELECT '  事件   ' || COUNT(*) FROM run_event;
        SELECT '  模型   ' || COUNT(*) FROM model;
      " 2>/dev/null
    else
      echo "  （还没有数据）"
    fi
    lsof -ti:$PORT > /dev/null 2>&1 && echo "  devserver 运行中" || echo "  devserver 未运行"
    lsof -ti:$WEB_PORT > /dev/null 2>&1 && echo "  web 运行中" || echo "  web 未运行"
    ;;

  *)
    echo "用法：$0 [start|stop|status]"
    exit 1
    ;;
esac
