import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfirmViaApp } from '../src/confirm.js';
import type { McpTool } from '../src/tools.js';

/**
 * MCP 写操作的确认通道 —— M4 剩下的那一件事。
 *
 * 「AI 的改动一律先出 Diff，用户确认才落草稿」是核心规则。
 * MCP 进程弹不出应用里的对话框，所以走一条信箱：
 * 提交待确认 → 应用显示 → 用户决定 → 这边轮询读到结果。
 */

const 工具 = { name: 'workflow.patch', mutates: true } as unknown as McpTool;

let call: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  call = vi.fn();
});

const client = () => ({ call }) as never;

describe('提交与轮询', () => {
  it('先提交，拿到 id', async () => {
    call.mockResolvedValueOnce({ id: 'mcpc_1' }).mockResolvedValue({ status: 'approved' });
    const confirm = createConfirmViaApp(client());

    await confirm(工具, { id: 'wf_1' });

    expect(call).toHaveBeenNthCalledWith(1, 'mcp.requestConfirm', {
      tool: 'workflow.patch',
      inputJson: JSON.stringify({ id: 'wf_1' }),
    });
  });

  it('批准就放行', async () => {
    call.mockResolvedValueOnce({ id: 'mcpc_1' }).mockResolvedValue({ status: 'approved' });
    const confirm = createConfirmViaApp(client());

    await expect(confirm(工具, {})).resolves.toBe(true);
  });

  it('拒绝就不放行', async () => {
    call.mockResolvedValueOnce({ id: 'mcpc_1' }).mockResolvedValue({ status: 'rejected' });
    const confirm = createConfirmViaApp(client());

    await expect(confirm(工具, {})).resolves.toBe(false);
  });

  it('过期算拒绝 —— 没人理的写操作不该生效', async () => {
    call.mockResolvedValueOnce({ id: 'mcpc_1' }).mockResolvedValue({ status: 'expired' });
    const confirm = createConfirmViaApp(client());

    await expect(confirm(工具, {})).resolves.toBe(false);
  });

  it('pending 时继续等，直到有结果', async () => {
    call
      .mockResolvedValueOnce({ id: 'mcpc_1' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'approved' });
    const confirm = createConfirmViaApp(client());

    const promise = confirm(工具, {});
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBe(true);
    // 1 次提交 + 3 次查
    expect(call.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('等太久就放弃 —— 而放弃等于拒绝', async () => {
    call.mockResolvedValueOnce({ id: 'mcpc_1' }).mockResolvedValue({ status: 'pending' });
    const confirm = createConfirmViaApp(client());

    const promise = confirm(工具, {});
    await vi.advanceTimersByTimeAsync(200_000);

    await expect(promise).resolves.toBe(false);
  });
});

describe('出错时不放行', () => {
  it('提交失败就当没批准 —— 那比默默写进去强', async () => {
    call.mockRejectedValue(new Error('连不上应用'));
    const confirm = createConfirmViaApp(client());

    await expect(confirm(工具, {})).resolves.toBe(false);
  });

  it('轮询失败也不放行', async () => {
    call.mockResolvedValueOnce({ id: 'mcpc_1' }).mockRejectedValue(new Error('连不上'));
    const confirm = createConfirmViaApp(client());

    const promise = confirm(工具, {});
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBe(false);
  });
});
