import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 在运行页问「上次为什么失败」时，AI 应该知道你在看哪条运行。
 *
 * `runId` 这个 chip 有渲染代码、契约的 supervisor.ask.context 也收它，
 * 但 AppShell 从不传 —— 又是一条两侧各自绿灯、中间断开的链路。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { useRuns } = await import('../src/runs/runsStore.js');
const { AppShell } = await import('../src/AppShell.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'workspace.settings': () => ({
      workdir: '/tmp/ws',
      permissionPreset: 'workspace_safe',
      environment: 'local',
      blockers: [],
    }),
    'run.list': () => ({ items: [], total: 0 }),
    'workflow.list': () => ({ items: [], total: 0 }),
    'supervisor.sessions': () => ({ items: [] }),
    'model.list': () => ({ items: [], total: 0 }),
    'supervisor.ask': () => ({ text: '因为超时。', toolCalls: 0 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
  useRuns.setState({ selectedId: 'run_abcdef123' });
});

describe('主管 AI 的运行上下文', () => {
  it('运行页选中一条运行时，那条运行的 id 进上下文并发给后端', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/runs']}>
        <AppShell />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /询问 AI/u }));
    expect(await screen.findByText(/run_abcde/u)).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: /问主管 AI/u }), '上次为什么失败');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      const ask = call.mock.calls.find(([m]) => m === 'supervisor.ask');
      expect((ask?.[1] as { context: { runId?: string } }).context.runId).toBe('run_abcdef123');
    });
  });
});
