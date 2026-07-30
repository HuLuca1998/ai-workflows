import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 「上下文以 chips 呈现，**可增删**」（规范 §6）。
 *
 * 此前只呈现不可动：想问一个一般性的问题（「工作流一般怎么组织」），
 * 当前草稿会被一起发过去把回答带偏；想让别人看这次对话时，也没法
 * 先把那条运行的 id 摘掉。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'supervisor.sessions': () => ({ items: [] }),
    'model.list': () => ({ items: [], total: 0 }),
    'supervisor.ask': () => ({ text: '好的', toolCalls: 0 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

const context = { workflowId: 'wf_1', draftRev: 19, runId: 'run_abcdef123' };

function askedContext() {
  const ask = call.mock.calls.find(([m]) => m === 'supervisor.ask');
  return (ask?.[1] as { context: Record<string, unknown> } | undefined)?.context;
}

async function send(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /问主管 AI/u }), '问一句');
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(call.mock.calls.some(([m]) => m === 'supervisor.ask')).toBe(true);
  });
}

describe('上下文 chips', () => {
  it('默认把当前草稿与运行都带上', async () => {
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={context} onClose={() => {}} />);
    await send(user);
    expect(askedContext()).toEqual({ workflowId: 'wf_1', draftRev: 19, runId: 'run_abcdef123' });
  });

  it('移除运行之后就不再发它', async () => {
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={context} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /移除运行/u }));
    await send(user);
    expect(askedContext()).toEqual({ workflowId: 'wf_1', draftRev: 19 });
  });

  it('移除草稿会连 rev 一起去掉 —— 后端靠 workflowId 读草稿的图', async () => {
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={context} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /移除草稿/u }));
    await send(user);
    expect(askedContext()).toEqual({ runId: 'run_abcdef123' });
  });

  it('移除之后能加回来', async () => {
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={context} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /移除运行/u }));
    await user.click(await screen.findByRole('button', { name: /加回运行/u }));
    await send(user);
    expect(askedContext()).toEqual({ workflowId: 'wf_1', draftRev: 19, runId: 'run_abcdef123' });
  });
});
