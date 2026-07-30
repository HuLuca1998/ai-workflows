import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 抽屉头部那排 chip 的承诺是「这次对话它能看到什么」。
 *
 * 两条没兑现：
 * - `runId` 这个 chip 有渲染代码、契约也收这个字段，但 AppShell 从不传，
 *   于是在运行页问「上次为什么失败」，AI 拿不到任何运行 id
 * - `memoryCount` 更彻底：契约的 context 里根本没有记忆这一项，
 *   前端也无从知道后端会注入哪些 —— 这个 chip 说不了真话
 *
 * 还有一条：AI 回了提议但当前没有草稿图时，提议被 `if (proposal && graph)`
 * 静默丢掉，界面上什么都不显示。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

const PROPOSAL = {
  summary: '加一个通知节点',
  operations: [
    {
      op: 'addNode',
      id: 'n_new',
      type: 'notify',
      title: '通知',
      position: { x: 10, y: 10 },
      config: { channel: 'system', template: '跑完了' },
    },
  ],
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'supervisor.sessions': () => ({ items: [] }),
    'model.list': () => ({ items: [], total: 0 }),
    'supervisor.ask': () => ({ text: '我改好了。', toolCalls: 3, proposal: PROPOSAL }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('上下文 chips', () => {
  it('不再有一个说不了真话的「记忆 N 条」', async () => {
    // 渲染层测不出「死代码被删了」——不传字段时它本来就不显示。
    // 这里直接守源码：只要 memoryCount 还在，那条链路就还是单侧绿灯。
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(
      join(process.cwd(), 'apps/web/src/supervisor/SupervisorDrawer.tsx'),
      'utf-8',
    );
    const declared = source
      .split('\n')
      .filter((line) => line.includes('memoryCount') && !line.trim().startsWith('*'));
    expect(declared, '契约里没有这一项，前端无从知道后端注入了哪些记忆').toEqual([]);
  });
});

describe('工具活动', () => {
  it('契约给了 toolCalls，界面要说出来 —— 它是这轮做了什么的唯一线索', async () => {
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);
    await user.type(screen.getByRole('textbox'), '帮我看看');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(/工具活动 · 3 次/u)).toBeTruthy();
  });
});

describe('没有草稿图时的提议', () => {
  it('不静默丢掉，明说要去哪里才能应用', async () => {
    const user = userEvent.setup();
    // 没有 graph / onApply —— 用户是在运行页或设置页打开抽屉的
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);
    await user.type(screen.getByRole('textbox'), '加个通知节点');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(screen.getByText(/加一个通知节点/u)).toBeTruthy();
    });
    expect(screen.getByText(/工作流编辑器/u)).toBeTruthy();
  });
});
