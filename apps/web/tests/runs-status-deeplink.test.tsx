import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * `/runs?status=waiting_approval` 要真的落到「待审批」那一档。
 *
 * 概览页的「等待审批 3」现在是个链接（第三方巡检 A-12：四张统计卡
 * 原来全是死的）。而运行页此前**不读 `status` 参数** —— 那个链接
 * 会把用户送到「全部」，他看到一整页运行，还得自己再点一次筛选。
 *
 * 一个不落地的深链比不可点更糟：用户以为自己点错了。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');
const { useRuns } = await import('../src/runs/runsStore.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'run.list': () => ({ items: [], total: 0 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
  // store 是模块级单例：上一条用例切到的筛选会留给下一条 ——
  // 「不带参数时停在全部」会因为前一条的 status=failed 而假红
  useRuns.setState({ filter: 'all', query: '' });
});

const view = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/runs${search}`]}>
      <RunsPage />
    </MemoryRouter>,
  );

describe('运行页认 status 深链', () => {
  it('?status=waiting_approval 落在「待审批」档', async () => {
    view('?status=waiting_approval');

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '待审批' }).dataset['active'],
        '深链没落地，用户被送到「全部」还得自己再点一次',
      ).toBe('true');
    });
  });

  it('落地的筛选真的发给后端 —— 不然只是按钮亮着', async () => {
    view('?status=waiting_approval');

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'run.list',
        expect.objectContaining({ status: ['waiting_approval'] }),
      );
    });
  });

  it('?status=failed 同样认', async () => {
    view('?status=failed');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '失败' }).dataset['active']).toBe('true');
    });
  });

  it('不带参数时停在「全部」', async () => {
    view('');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '全部' }).dataset['active']).toBe('true');
    });
  });

  it('认不出的值当没传 —— 不能因为一个坏链接空白一屏', async () => {
    view('?status=不存在的状态');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '全部' }).dataset['active']).toBe('true');
    });
  });
});
