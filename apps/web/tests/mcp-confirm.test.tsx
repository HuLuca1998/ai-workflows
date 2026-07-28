import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * MCP 写操作的确认卡 —— M4 剩下的那一件事。
 *
 * 「AI 的改动一律先出 Diff，用户确认才落草稿」是核心规则。
 * MCP 进程弹不出应用里的对话框，所以它把待确认放进信箱，
 * 应用轮询到之后显示这张卡。
 *
 * 这张卡不在图纸里 —— 图纸画的是 M1 的形态，那时 MCP 还没有写工具。
 * 样式沿用主管 AI 提议的那套（同样是「AI 要改东西，你先看」）。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

import type * as WorkspaceModule from '../src/data/workspace.js';

const { createContractCall } = await import('./_contractClient.js');
const { McpConfirmCard } = await import('../src/mcp/McpConfirmCard.js');

const 待确认 = {
  id: 'mcpc_1',
  tool: 'workflow.patch',
  inputJson: JSON.stringify({ id: 'wf_1', operations: [{ op: 'addNode' }] }),
  createdAt: '2026-07-28T10:00:00Z',
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'mcp.pendingConfirms': () => ({ items: [待确认] }),
    'mcp.decideConfirm': () => ({ ok: true }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = () => render(<McpConfirmCard />);

describe('有待确认时', () => {
  it('显示是哪个工具要写', async () => {
    view();
    expect(await screen.findByText(/workflow\.patch/u)).toBeTruthy();
  });

  it('把入参原样摊开 —— 用户得看清它到底要改什么', async () => {
    view();
    expect(await screen.findByText(/wf_1/u)).toBeTruthy();
    expect(screen.getByText(/addNode/u)).toBeTruthy();
  });

  it('说清这是 MCP 发起的，不是应用自己要改', async () => {
    view();
    expect(await screen.findByText(/MCP/u)).toBeTruthy();
  });

  it('两个按钮：批准与拒绝', async () => {
    view();
    expect(await screen.findByRole('button', { name: '批准这次写入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
  });

  it('批准把决定发回去', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '批准这次写入' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('mcp.decideConfirm', { id: 'mcpc_1', approved: true });
    });
  });

  it('拒绝也发回去 —— 不发的话那边要干等到超时', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '拒绝' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('mcp.decideConfirm', { id: 'mcpc_1', approved: false });
    });
  });

  it('决定之后卡片消失', async () => {
    const user = userEvent.setup();
    let 决定过 = false;
    respond({
      'mcp.pendingConfirms': () => ({ items: 决定过 ? [] : [待确认] }),
      'mcp.decideConfirm': () => {
        决定过 = true;
        return { ok: true };
      },
    });
    view();
    await user.click(await screen.findByRole('button', { name: '拒绝' }));

    await waitFor(() => {
      expect(screen.queryByText(/workflow\.patch/u)).toBeNull();
    });
  });
});

describe('没有待确认时', () => {
  it('什么都不显示 —— 不留一张空卡占着屏幕', async () => {
    respond({ 'mcp.pendingConfirms': () => ({ items: [] }) });
    const { container } = view();

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('mcp.pendingConfirms', {});
    });
    expect(container.firstChild).toBeNull();
  });

  it('轮询失败也不显示 —— 那条报错帮不上用户', async () => {
    respond({
      'mcp.pendingConfirms': () => {
        throw new Error('连不上');
      },
    });
    const { container } = view();

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('mcp.pendingConfirms', {});
    });
    expect(container.firstChild).toBeNull();
  });
});
