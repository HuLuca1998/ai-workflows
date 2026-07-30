import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * codex 第二轮：跨条目残留的剩余几处。
 *
 * 上一轮把「结果」绑上了 id，但「进行中」与「错误」还是页面级的 ——
 * 同一类坑只修了一半。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');

function run(id: string, status: string) {
  return {
    id,
    workflowId: 'wf_1',
    workflowName: '示例工作流',
    versionId: 'v1',
    status,
    inputs: {},
    startedAt: '2026-07-30T11:30:00Z',
  };
}

function model(id: string, name: string) {
  return {
    id,
    name,
    runtime: 'acp.codex',
    modelId: 'gpt-x',
    effort: 'medium',
    contextWindow: 200000,
    capabilities: [],
    enabled: true,
  };
}

beforeEach(() => {
  call.mockReset();
});

async function openRuns(items: ReturnType<typeof run>[]) {
  const user = userEvent.setup();
  const { container } = render(
    <MemoryRouter>
      <RunsPage />
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(container.querySelectorAll('.runs__item')).toHaveLength(items.length);
  });
  /*
   * 每次现查而不是存一份引用：列表每 1.2 秒被 load() 重渲染一次，
   * 存下来的那个 DOM 节点很快就不在树里了，点它不会触发任何 handler。
   */
  const row = (index: number) =>
    container.querySelectorAll<HTMLElement>('.runs__item')[index] as HTMLElement;
  return { user, container, row };
}

describe('导出诊断包的反馈', () => {
  it('成功运行也看得到路径 —— 反馈此前长在失败横幅里面', async () => {
    const checked = createContractCall({
      'run.list': () => ({ items: [run('run_1', 'succeeded')], total: 1 }),
      'run.events': () => ({ events: [], nextSeq: 1, hasMore: false }),
      'run.diagnostics': () => ({ path: '/tmp/diag.zip', bytes: 2048 }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const { user, row } = await openRuns([run('run_1', 'succeeded')]);
    await user.click(row(0));
    await user.click(screen.getByRole('button', { name: '导出诊断包' }));

    expect(await screen.findByText(/diag\.zip/u)).toBeTruthy();
  });

  it('不跟着跑到另一条运行的详情里', async () => {
    const items = [run('run_1', 'succeeded'), run('run_2', 'succeeded')];
    const checked = createContractCall({
      'run.list': () => ({ items, total: 2 }),
      'run.events': () => ({ events: [], nextSeq: 1, hasMore: false }),
      'run.diagnostics': () => ({ path: '/tmp/diag.zip', bytes: 2048 }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const { user, row } = await openRuns(items);
    await user.click(row(0));
    await user.click(screen.getByRole('button', { name: '导出诊断包' }));
    await screen.findByText(/diag\.zip/u);

    await user.click(row(1));
    await waitFor(() => {
      expect(screen.queryByText(/diag\.zip/u), 'run_1 的诊断包路径挂在了 run_2 下').toBeNull();
    });
  });
});

describe('取消运行的中间态', () => {
  it('不跟着跑到另一条运行的按钮上', async () => {
    const items = [run('run_1', 'running'), run('run_2', 'running')];
    let release: null | (() => void) = null;
    const checked = createContractCall({
      'run.list': () => ({ items, total: 2 }),
      'run.events': () => ({ events: [], nextSeq: 1, hasMore: false }),
      'run.cancel': () =>
        new Promise<{ runId: string }>((resolve) => {
          release = () => resolve({ runId: 'run_1' });
        }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const { user, row } = await openRuns(items);
    await user.click(row(0));
    await user.click(await screen.findByRole('button', { name: '取消运行' }));
    await user.click(screen.getByRole('button', { name: /确认取消运行/u }));

    await user.click(row(1));
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /取消运行/u });
      expect(button, 'run_1 的「取消中…」显示在了 run_2 的按钮上').toBeEnabled();
    });

    /*
     * 光「看着能点」不够 —— 点下去必须真的发出去。
     *
     * 只把显示按 target 解耦、锁还是一个布尔的话，B 的按钮是亮的，
     * 而 run() 会因为 A 的请求还在飞而静默丢弃这一次点击：
     * 用户点了、按钮闪了一下、什么都没发生，这比按钮灰着更糟。
     */
    await user.click(screen.getByRole('button', { name: '取消运行' }));
    await user.click(screen.getByRole('button', { name: /确认取消运行/u }));
    await waitFor(() => {
      const cancels = call.mock.calls.filter(([m]) => m === 'run.cancel');
      expect(cancels.map(([, input]) => (input as { runId: string }).runId)).toEqual([
        'run_1',
        'run_2',
      ]);
    });
    (release as (() => void) | null)?.();
  });
});

describe('模型连通性测试的中间态与错误', () => {
  it('测 A 时切到 B，B 不该显示「测试中」也不该显示 A 的错误', async () => {
    let release: null | ((value: unknown) => void) = null;
    const checked = createContractCall({
      'model.list': () => ({ items: [model('m1', '模型甲'), model('m2', '模型乙')], total: 2 }),
      'model.test': () =>
        new Promise<never>((_resolve, reject) => {
          release = () => reject(new Error('连不上：超时'));
        }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(<ModelsPage />);

    await user.click(await screen.findByText('模型甲'));
    await user.click(screen.getByRole('button', { name: '测试连通性' }));
    await user.click(screen.getByText('模型乙'));

    expect(screen.getByRole('button', { name: /测试连通性/u })).toBeEnabled();

    (release as ((value: unknown) => void) | null)?.(null);
    await waitFor(() => {
      expect(screen.queryByText(/连不上/u), '模型甲的错误挂在了模型乙的详情下').toBeNull();
    });
  });
});
