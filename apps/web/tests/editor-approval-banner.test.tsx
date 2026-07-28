import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * 编辑器顶部的等待审批横幅 —— 图纸「02 画布编辑器」。
 *
 * 图纸原文：「节点 7 · 审批：检查 Diff」，右边「正在等待你的决定 ·
 * 已等待 2 分 11 秒 · 3 个文件变更，测试 12/12 通过」，
 * 两个按钮「查看 Diff」「处理审批」。
 *
 * 不给这条横幅的话，用户在编辑器里改流程时不会知道有一个运行
 * 正卡在审批上等他 —— 而那个运行占着 worktree，也占着他的时间。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

import type * as WorkspaceModule from '../src/data/workspace.js';

const { createContractCall } = await import('./_contractClient.js');
const { ApprovalBanner } = await import('../src/editor/ApprovalBanner.js');

const 等待中的运行 = {
  id: 'run_9f3c',
  workflowId: 'wf_1',
  workflowName: 'GitHub Issue 修复',
  status: 'waiting_approval',
  startedAt: '2026-07-28T12:00:00Z',
  currentNode: 'approve_diff',
  inputs: {},
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'run.list': () => ({ items: [等待中的运行], total: 1 }),
    'run.events': () => ({
      events: [
        {
          id: 'ev_1',
          runId: 'run_9f3c',
          seq: 7,
          ts: '2026-07-28T12:00:00Z',
          type: 'approval.requested',
          nodeId: 'approve_diff',
          nodeLabel: '审批：检查 Diff',
          actor: 'engine',
          summary: '3 个文件变更，测试 12/12 通过',
          sensitivity: 'normal',
          schemaVer: 1,
        },
      ],
      hasMore: false,
      nextSeq: 8,
    }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = () =>
  render(
    <MemoryRouter initialEntries={['/editor/wf_1']}>
      <Routes>
        <Route path="/editor/:workflowId" element={<ApprovalBanner workflowId="wf_1" />} />
      </Routes>
    </MemoryRouter>,
  );

describe('有运行在等审批时', () => {
  it('只问这条工作流的等待中运行 —— 别的工作流的审批不该弹在这里', async () => {
    view();
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('run.list', {
        workflowId: 'wf_1',
        status: ['waiting_approval'],
        limit: 1,
      });
    });
  });

  it('横幅写出是哪个节点在等 —— 用节点标题，不是内部 id', async () => {
    view();
    expect(await screen.findByText(/审批：检查 Diff/u)).toBeTruthy();
    expect(screen.queryByText(/approve_diff/u)).toBeNull();
  });

  it('那句「正在等待你的决定」照图纸', async () => {
    view();
    expect(await screen.findByText(/正在等待你的决定/u)).toBeTruthy();
  });

  it('带上审批请求里的摘要 —— 用户得知道在批什么', async () => {
    view();
    expect(await screen.findByText(/3 个文件变更，测试 12\/12 通过/u)).toBeTruthy();
  });

  it('两个按钮照图纸', async () => {
    view();
    expect(await screen.findByRole('link', { name: '查看 Diff' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '处理审批' })).toBeTruthy();
  });

  it('按钮指向那条运行的详情 —— 审批在那里做', async () => {
    view();
    const 处理 = await screen.findByRole('link', { name: '处理审批' });
    expect(处理.getAttribute('href')).toContain('run_9f3c');
  });
});

describe('没有等待中的运行时', () => {
  it('什么都不显示 —— 不留一条空横幅占着画布上方', async () => {
    respond({ 'run.list': () => ({ items: [], total: 0 }) });
    const { container } = view();

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('run.list', expect.anything());
    });
    expect(container.firstChild).toBeNull();
  });

  it('查询失败也不显示 —— 编辑器不该因为一次查询失败就多出个错误条', async () => {
    respond({
      'run.list': () => {
        throw new Error('数据库忙');
      },
    });
    const { container } = view();

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('run.list', expect.anything());
    });
    expect(container.firstChild).toBeNull();
  });
});

describe('等待时长', () => {
  it('显示已经等了多久 —— 图纸写的是「已等待 2 分 11 秒」', async () => {
    const user = userEvent.setup();
    void user;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-28T12:02:11Z'));

    view();
    expect(await screen.findByText(/已等待 2 分 11 秒/u)).toBeTruthy();
    vi.useRealTimers();
  });

  it('不满一分钟只说秒', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-28T12:00:43Z'));

    view();
    expect(await screen.findByText(/已等待 43 秒/u)).toBeTruthy();
    vi.useRealTimers();
  });
});
