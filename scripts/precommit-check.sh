#!/bin/bash
# 提交前跑一遍：单元 + 端到端。
#
# CI 只手动触发，所以这一条是实际的门禁。
# 端到端需要本地服务在跑；没跑就自动起。
set -e

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

echo "▸ 单元与契约门禁"
pnpm verify

echo
echo "▸ 真实 ACP adapter（没装就跳过）"
node tests/e2e/acp-real.mjs

echo
echo "▸ 端到端（需要本地服务）"
./scripts/local-test-env.sh start > /dev/null
node scripts/seed-test-data.mjs > /dev/null
pnpm exec playwright test

echo
echo "全部通过，可以提交"
