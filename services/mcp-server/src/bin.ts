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

process.stderr.write(`[aiwf-mcp] 已连到 ${base}\n`);
serve({ client }, process.stdin, process.stdout);
