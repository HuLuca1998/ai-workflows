#!/usr/bin/env node
/**
 * 用**真实的** ACP adapter 跑一遍完整链路。
 *
 * 单元测试用 mock（真实 adapter 要登录凭据、会真调模型、每次响应不一样），
 * 这个脚本补上那一半：确认我们对协议的理解与真实 adapter 一致。
 *
 * 需要先装 adapter：
 *     pnpm --filter @aiwf/acp-sidecar add @agentclientprotocol/claude-agent-acp
 *
 * 没装就跳过（退出码 0）—— 它不该挡住别人的构建。
 *
 *     node tests/e2e/acp-real.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const ADAPTER = 'services/acp-sidecar/node_modules/.bin/claude-agent-acp';

if (!existsSync(ADAPTER)) {
  console.log('跳过：没装 claude-agent-acp');
  process.exit(0);
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

const proc = spawn(ADAPTER, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
const notifications = [];
let nextId = 1;

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method) {
      notifications.push(message);
    } else if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function call(method, params, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  console.log('▸ 真实 ACP adapter 链路');

  const init = await call('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  check('握手成功', Boolean(init));
  check('协议版本是 1', init.protocolVersion === 1, `实际 ${init.protocolVersion}`);
  check('返回了 agentCapabilities', Boolean(init.agentCapabilities));

  // 图纸那句「ACP 握手只返回协议能力与 session modes，不返回可用模型」
  check(
    '握手不返回模型列表（所以模型要在「模型」页登记）',
    !('models' in init) && !('availableModels' in init),
    Object.keys(init).join(','),
  );

  const session = await call('session/new', { cwd: process.cwd(), mcpServers: [] });
  check('建会话拿到 sessionId', typeof session.sessionId === 'string');
  check(
    'session/new 返回权限档位（modes）',
    Array.isArray(session.modes?.availableModes) && session.modes.availableModes.length > 0,
    JSON.stringify(session.modes ?? {}).slice(0, 120),
  );

  // 通知也要能收到 —— 界面的对话视图靠它
  await new Promise((resolve) => setTimeout(resolve, 1500));
  check(
    '收到了 session/update 通知',
    notifications.some((n) => n.method === 'session/update'),
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n共 ${checks.length} 项，失败 ${failed.length} 项`);
  proc.kill();
  process.exit(failed.length > 0 ? 1 : 0);
} catch (error) {
  console.error(`失败：${error.message}`);
  proc.kill();
  process.exit(1);
}
