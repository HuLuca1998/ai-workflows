import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 「忽略」一条 AI 提议的记忆，实际发的是 `memory.delete` —— 永久删除，
 * 没有回收站，也没有二次确认。
 *
 * 「忽略」在任何界面里都读作「先放着不管」，这是纪律二说的第三种形态：
 * 界面文案承诺了一件事，实现里是另一件。后端没有「已忽略」这个状态
 * （提议就是 `source=ai_proposed && !enabled`，留着它就还在提议区），
 * 所以正确的修法是**把话说实**，而不是编一个不存在的状态。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { MemoryPage } = await import('../src/memory/MemoryPage.js');

const proposal = {
  id: 'mem_1',
  scope: 'workspace',
  key: '构建命令',
  value: 'pnpm verify',
  source: 'ai_proposed',
  createdBy: 'agent_1',
  createdAt: '2026-07-27T10:00:00Z',
  updatedAt: '2026-07-27T10:00:00Z',
  sensitivity: 'internal',
  ver: 1,
  tags: [],
  enabled: false,
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'memory.list': () => ({ items: [proposal], total: 1 }),
    'memory.delete': () => ({ ok: true }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('AI 提议的记忆', () => {
  it('丢弃它是永久删除，界面必须这么说，并且要确认', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    await screen.findByText('构建命令');

    // 「忽略」读作「先放着不管」，而这里发的是 memory.delete
    expect(screen.queryByRole('button', { name: /忽略/u })).toBeNull();

    const discard = screen.getByRole('button', { name: /丢弃这条提议/u });
    await user.click(discard);
    expect(
      call.mock.calls.filter(([m]) => m === 'memory.delete'),
      '第一下就删掉了 —— 没有回收站，必须先确认',
    ).toHaveLength(0);

    await user.click(await screen.findByRole('button', { name: /确认丢弃/u }));
    expect(call.mock.calls.filter(([m]) => m === 'memory.delete')).toHaveLength(1);
  });
});
