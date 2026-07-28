#!/usr/bin/env node
/**
 * MCP Server 的可执行入口。
 *
 * 连到本地 Core API 的 HTTP 桥接（与 Web 形态同一个），把工具暴露给
 * Claude Desktop / Claude Code。
 *
 * 用法（在 MCP 客户端的配置里）：
 *
 *     {
 *       "mcpServers": {
 *         "ai-workflows": {
 *           "command": "node",
 *           "args": ["<仓库>/services/mcp-server/dist/bin.js"],
 *           "env": { "AIWF_API": "http://127.0.0.1:5177" }
 *         }
 *       }
 *     }
 *
 * **stdout 只能有协议消息** —— 日志一律走 stderr，多打一行就会把流搞乱，
 * 而症状是客户端一言不发地断开。
 */

import {
  CoreApiClient,
  fromIpcResult,
  ipcCommandFor,
  normalizeIpcError,
  toIpcInput,
} from '@aiwf/client-core';
import type { CoreApiMethod } from '@aiwf/contracts';
import { serve } from './stdio.js';
import { createConfirmViaApp } from './confirm.js';

const base = process.env['AIWF_API'] ?? 'http://127.0.0.1:5177';

const client = new CoreApiClient({
  async call(method: CoreApiMethod, input: unknown) {
    const command = ipcCommandFor(method);
    if (!command) throw new Error(`${method} 没有对应的引擎命令`);

    // 走与桌面壳、Web 形态**同一套**转换。
    // 自己拼一份的话，第一个不一致的返回形状就是「返回值不合契约」——
    // 而那正是 MCP 第一次接上时踩到的
    const response = await fetch(`${base}/ipc/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toIpcInput(method, input)),
    });

    const text = await response.text();
    if (!response.ok) {
      throw normalizeIpcError(text || `HTTP ${response.status}`);
    }
    return fromIpcResult(method, text ? (JSON.parse(text) as unknown) : null);
  },

  // MCP 首版不暴露运行相关的工具，所以事件订阅用不到。
  // 真要订阅的话得开 SSE —— 那是 M6 Web 形态的事
  subscribeEvents() {
    return () => {};
  },
});

/**
 * 写工具要开，但每一次写都要用户确认。
 *
 * 「AI 的改动一律先出 Diff，用户确认才落草稿」是这个产品的核心规则。
 * 主管 AI 遵守了，MCP 之前不能 —— 这个进程弹不出应用里的对话框，
 * 于是写工具只能整体关掉。
 *
 * 现在走 `createConfirmViaApp`：提交待确认 → 应用里弹确认卡 →
 * 用户决定 → 这边读到结果。出错、超时一律不放行。
 *
 * `AIWF_MCP_SKIP_CONFIRM=1` 跳过确认，只给自动化用（比如 e2e）。
 * 它不是「方便一点」的开关 —— 开了之后 AI 就能不经过任何人写你的草稿。
 */
const skipConfirm = process.env['AIWF_MCP_SKIP_CONFIRM'] === '1';
const confirmWrite = skipConfirm ? async () => true : createConfirmViaApp(client);

process.stderr.write(
  `[aiwf-mcp] 已连到 ${base}（写操作${
    skipConfirm ? '不需确认 —— 只应在自动化里这样用' : '需在应用里确认'
  }）\n`,
);

serve({ client, confirmWrite }, process.stdin, process.stdout);
