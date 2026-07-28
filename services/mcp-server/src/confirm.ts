import type { CoreApiClient } from '@aiwf/client-core';
import type { McpTool } from './tools.js';

/**
 * 通过应用向用户要确认。
 *
 * 「AI 的改动一律先出 Diff，用户确认才落草稿」是这个产品的核心规则。
 * 主管 AI 遵守了（DraftStore.propose），MCP 之前不能 —— 这个进程弹不出
 * 应用里的对话框，于是写工具只能整体关掉。
 *
 * 这里走一条信箱：提交待确认 → 应用显示确认卡 → 用户决定 →
 * 这边轮询读到结果。
 *
 * **出错一律不放行**：连不上应用、轮询失败、等太久，都当作没批准。
 * 默默写进去比拒绝糟得多 —— 用户根本不知道发生了什么。
 */

/** 多久查一次。太密会把 devserver 的线程占着，太疏用户会觉得应用没反应。 */
const POLL_MS = 800;

/** 等多久放弃。与引擎侧的 CONFIRM_TTL_SECS 对齐，留一点余量。 */
const GIVE_UP_MS = 190_000;

export function createConfirmViaApp(
  client: CoreApiClient,
): (tool: McpTool, input: unknown) => Promise<boolean> {
  return async (tool, input) => {
    let id: string;
    try {
      const result = (await client.call('mcp.requestConfirm', {
        tool: tool.name,
        inputJson: JSON.stringify(input ?? {}),
      })) as { id: string };
      id = result.id;
    } catch (error) {
      process.stderr.write(`[aiwf-mcp] 提交确认失败：${String(error)}
`);
      return false;
    }

    const deadline = Date.now() + GIVE_UP_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      try {
        const { status } = (await client.call('mcp.confirmStatus', { id })) as {
          status: string;
        };
        if (status === 'approved') return true;
        if (status === 'rejected' || status === 'expired') return false;
      } catch (error) {
        // 查不到状态就不放行：这条写操作的去向已经不明确了。
        // 写到 stderr 而不是静默 —— 否则用户只看到「未确认」，
        // 而真正的原因（连不上、契约不符）根本没人知道
        process.stderr.write(`[aiwf-mcp] 轮询确认状态失败：${String(error)}
`);
        return false;
      }
    }
    return false;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
