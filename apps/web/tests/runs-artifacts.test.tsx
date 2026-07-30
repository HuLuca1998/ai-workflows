import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 产物列表只在挂载时拉一次。运行还在跑的时候产物是**边跑边产**的，
 * 于是用户看到的永远是打开那一刻的快照 —— 后面产的 diff、报告一个都不出现，
 * 界面上也没有任何刷新入口，只能切走 tab 再切回来（还得先卸载）。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');

const run = {
  id: 'run_1',
  workflowId: 'wf_1',
  workflowName: '示例工作流',
  versionId: 'v1',
  status: 'running',
  inputs: {},
  startedAt: '2026-07-30T11:30:00Z',
  workdir: '/tmp/aiwf/run_1',
};

function artifact(name: string) {
  return {
    nodeId: 'n1',
    kind: 'diff',
    name,
    path: `/tmp/aiwf/run_1/${name}`,
    relPath: name,
    bytes: 128,
    sha256: 'a'.repeat(64),
  };
}

let artifacts = [artifact('patch.diff')];

beforeEach(() => {
  call.mockReset();
  artifacts = [artifact('patch.diff')];
  const checked = createContractCall({
    'run.list': () => ({ items: [run], total: 1 }),
    'run.events': () => ({ events: [], nextSeq: 1 }),
    'run.artifacts': () => ({ items: artifacts, root: '/tmp/aiwf/run_1' }),
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
});

describe('产物列表', () => {
  it('有刷新入口，点了能拿到运行中新产出的产物', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>,
    );
    const row = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('.runs__item');
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(row);
    await user.click(await screen.findByRole('tab', { name: '产物' }));
    await screen.findByText('patch.diff');

    // 运行还在跑，后端这会儿又产出了一份报告
    artifacts = [artifact('patch.diff'), artifact('report.md')];
    expect(screen.queryByText('report.md')).toBeNull();

    await user.click(screen.getByRole('button', { name: '刷新产物' }));
    await screen.findByText('report.md');
  });
});
