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

/**
 * 写工具默认不开放。
 *
 * 这个进程弹不出应用里的确认对话框，而「AI 的改动一律先出 Diff」
 * 是这个产品的核心规则 —— 主管 AI 遵守了，MCP 不该例外。
 *
 * `AIWF_MCP_ALLOW_WRITE=1` 显式接受：写入仍然过 Core API 的
 * baseRevision 守卫与审计，改的也只是草稿（不是已发布版本），
 * 用户能在版本抽屉里看到 Diff 并回滚。但确认那一步没有了。
 */
const allowWrite = process.env['AIWF_MCP_ALLOW_WRITE'] === '1';

process.stderr.write(`[aiwf-mcp] 已连到 ${base}（${allowWrite ? '可写' : '只读'}）\n`);

serve(
  {
    client,
    // 已经显式开了写：这里就不再逐次问 —— 真正的确认要接到桌面壳，
    // 那是 M4 剩下的一件事
    ...(allowWrite ? { confirmWrite: async () => true } : {}),
  },
  process.stdin,
  process.stdout,
);
