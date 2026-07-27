import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 产物预览 —— 图纸「03 执行记录」的产物列表，每条右边是「预览」与「导出」。
 *
 * codex 报的原话：「只显示 stderr.log、33 B 和磁盘路径，条目不可点击；
 * 幸好错误摘要重复了这次 stderr，否则用户看不到完整日志」。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');
const { useRuns } = await import('../src/runs/runsStore.js');

const RUN = {
  id: 'run_1',
  workflowId: 'wf_1',
  workflowName: '错误日志归因',
  versionId: 'ver_1',
  status: 'failed',
  startedAt: '2026-07-28T09:12:00.000Z',
  inputs: {},
};

const ARTIFACTS = {
  items: [
    {
      nodeId: 'node_1',
      kind: 'log',
      name: 'stderr.log',
      path: '/tmp/run_1/node_1/stderr.log',
      relPath: 'node_1/stderr.log',
      bytes: 33,
      sha256: 'abc',
    },
  ],
  root: '/tmp/run_1',
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'run.artifacts': () => ARTIFACTS,
    'run.artifactContent': () => ({
      text: '故障原因：模拟退出码 7',
      binary: false,
      truncated: false,
      bytes: 33,
    }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
  useRuns.setState({
    items: [RUN] as never,
    selectedId: 'run_1',
    events: [],
    error: null,
    loading: false,
  });
});

async function openArtifacts() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/runs/run_1']}>
      <RunsPage />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('tab', { name: /产物/u }));
  await screen.findByText('stderr.log');
  return user;
}

describe('产物列表', () => {
  it('每条都有预览按钮 —— 图纸就是这样', async () => {
    await openArtifacts();
    expect(screen.getByRole('button', { name: '预览 stderr.log' })).toBeTruthy();
  });

  it('点预览后显示内容', async () => {
    const user = await openArtifacts();
    await user.click(screen.getByRole('button', { name: '预览 stderr.log' }));

    expect(await screen.findByText('故障原因：模拟退出码 7')).toBeTruthy();
  });

  it('预览发的是相对路径 —— 绝对路径进了接口就是任意文件读', async () => {
    const user = await openArtifacts();
    await user.click(screen.getByRole('button', { name: '预览 stderr.log' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('run.artifactContent', {
        runId: 'run_1',
        path: 'node_1/stderr.log',
      });
    });
  });

  it('截断时说明还有更多 —— 否则用户以为日志就这么点', async () => {
    respond({
      'run.artifactContent': () => ({
        text: '前面一段…',
        binary: false,
        truncated: true,
        bytes: 18_432,
      }),
    });
    const user = await openArtifacts();
    await user.click(screen.getByRole('button', { name: '预览 stderr.log' }));

    expect(await screen.findByText(/只显示了前|已截断/u)).toBeTruthy();
  });

  it('二进制产物说明它不是文本，而不是显示乱码', async () => {
    respond({
      'run.artifactContent': () => ({ binary: true, truncated: false, bytes: 1024 }),
    });
    const user = await openArtifacts();
    await user.click(screen.getByRole('button', { name: '预览 stderr.log' }));

    expect(await screen.findByText(/二进制/u)).toBeTruthy();
  });

  it('读取失败时报错，不留一个空的预览框', async () => {
    respond({
      'run.artifactContent': () => {
        throw new Error('文件不在了');
      },
    });
    const user = await openArtifacts();
    await user.click(screen.getByRole('button', { name: '预览 stderr.log' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('文件不在了');
  });

  it('再点一次收起 —— 预览是就地展开，不是弹层', async () => {
    const user = await openArtifacts();
    const button = screen.getByRole('button', { name: '预览 stderr.log' });

    await user.click(button);
    expect(await screen.findByText('故障原因：模拟退出码 7')).toBeTruthy();

    await user.click(button);
    await waitFor(() => {
      expect(screen.queryByText('故障原因：模拟退出码 7')).toBeNull();
    });
  });
});
