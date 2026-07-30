import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { McpConfirmCard } from '../src/mcp/McpConfirmCard.js';

/**
 * 这张卡是 `role="alertdialog"` —— 那个角色的含义是「打断你，等你决定」。
 *
 * 而它从不接管焦点：卡片出现在屏幕角落，键盘用户要一路 Tab 过整屏才够得着，
 * 读屏用户则完全不知道它出现了。一个不打断的 alertdialog 是在说假话。
 *
 * 另一半：无人使用时它每 1.2 秒查一次信箱，永远不停 ——
 * MCP 客户端没连上的机器上，这是一条纯粹白烧的定时器。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const pending = {
  id: 'c1',
  tool: 'workflow.patch',
  inputJson: '{"op":"addNode"}',
  createdAt: '2026-07-30T12:00:00Z',
};

beforeEach(() => {
  call.mockReset();
});

describe('MCP 写入确认卡', () => {
  it('出现时接管焦点 —— alertdialog 的含义就是打断', async () => {
    call.mockImplementation((method: string) => {
      if (method === 'mcp.status') return Promise.resolve({ running: true });
      if (method === 'mcp.pendingConfirms') return Promise.resolve({ items: [pending] });
      return Promise.resolve({ ok: true });
    });

    render(<McpConfirmCard />);
    const card = await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(card.contains(document.activeElement)).toBe(true);
    });
  });

  it('MCP 没连上时不轮询 —— 那是一条纯白烧的定时器', async () => {
    vi.useFakeTimers();
    call.mockImplementation((method: string) => {
      if (method === 'mcp.status') return Promise.resolve({ running: false, tools: 0 });
      return Promise.resolve({ items: [] });
    });

    render(<McpConfirmCard />);
    await vi.advanceTimersByTimeAsync(6000);
    expect(call.mock.calls.filter(([m]) => m === 'mcp.pendingConfirms').length).toBeLessThanOrEqual(
      1,
    );
    vi.useRealTimers();
  });
});
