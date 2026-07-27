import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowGraph } from '@aiwf/contracts';
import { VersionDrawer } from '../src/editor/VersionDrawer.js';

/**
 * 版本抽屉。照图纸：草稿卡在顶部、版本列表、Diff、底部三个操作。
 * 重点验证「发布快照不可变」这条原则在界面上说清了，以及未保存时不让发布。
 */

const versionGraph: WorkflowGraph = {
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
  ],
  edges: [],
  groups: [],
};

const draftGraph: WorkflowGraph = {
  nodes: [
    ...versionGraph.nodes,
    {
      id: 'lint',
      type: 'script.shell',
      title: '运行 lint',
      position: { x: 300, y: 0 },
      config: { interpreter: 'zsh', script: 'pnpm lint' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'lint', port: 'input' },
    },
  ],
  groups: [],
};

const versions = [
  {
    id: 'wv_2',
    version: 2,
    configHash: 'bbbbbbbbbbbbbbbb',
    publishedAt: '2026-07-27T10:00:00.000Z',
    publishedBy: '本地用户',
  },
  {
    id: 'wv_1',
    version: 1,
    configHash: 'aaaaaaaaaaaaaaaa',
    publishedAt: '2026-07-27T09:00:00.000Z',
    publishedBy: '本地用户',
  },
];

const renderDrawer = (overrides: Partial<Parameters<typeof VersionDrawer>[0]> = {}) => {
  const props = {
    rev: 5,
    dirty: false,
    graph: draftGraph,
    versions,
    loadVersionGraph: vi.fn(async () => versionGraph),
    onClose: vi.fn(),
    onPublish: vi.fn(),
    onRollback: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
  return { ...render(<VersionDrawer {...props} />), props };
};

describe('结构（照图纸）', () => {
  it('标题与那句原则说明都在', () => {
    renderDrawer();
    expect(screen.getByText('版本历史')).toBeInTheDocument();
    expect(screen.getByText('发布快照不可变，运行记录永远引用具体版本')).toBeInTheDocument();
  });

  it('顶部是当前草稿卡，显示 rev 与节点连接数', () => {
    renderDrawer();
    expect(screen.getByText('当前草稿 rev5')).toBeInTheDocument();
    expect(screen.getByText(/2 节点 1 连接/u)).toBeInTheDocument();
  });

  it('版本列表最新在前，并标出「最新」', () => {
    renderDrawer();
    const items = screen.getAllByRole('button', { name: /^v\d/u });
    expect(items[0]).toHaveTextContent('v2');
    expect(items[0]).toHaveTextContent('最新');
    expect(items[1]).toHaveTextContent('v1');
  });

  it('从未发布过时说明这里会出现什么', () => {
    renderDrawer({ versions: [] });
    expect(screen.getByText(/还没有发布过版本/u)).toBeInTheDocument();
  });
});

describe('版本对比', () => {
  it('默认选中最新版本并显示它与草稿的 Diff', async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByText('v2 → 当前草稿')).toBeInTheDocument());
    const diff = screen.getByLabelText('版本对比');
    // 草稿里多了 lint 节点与一条连线
    expect(within(diff).getByText(/\+ node script\.shell「运行 lint」/u)).toBeInTheDocument();
    expect(within(diff).getByText(/\+ edge entry\.success → lint/u)).toBeInTheDocument();
  });

  it('切换版本会重新读图', async () => {
    const loadVersionGraph = vi.fn(async () => versionGraph);
    renderDrawer({ loadVersionGraph });
    await waitFor(() => expect(loadVersionGraph).toHaveBeenCalledWith('wv_2'));

    fireEvent.click(screen.getByRole('button', { name: /v1/u }));
    await waitFor(() => expect(loadVersionGraph).toHaveBeenCalledWith('wv_1'));
  });

  it('与选中版本一致时明确说出来，而不是显示空白', async () => {
    renderDrawer({ graph: versionGraph });
    await waitFor(() => expect(screen.getByText('与这个版本完全一致')).toBeInTheDocument());
  });

  it('读版本失败时报错，不假装没有差异', async () => {
    renderDrawer({
      loadVersionGraph: vi.fn(async () => {
        throw new Error('版本的图数据无法解析');
      }),
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法解析'));
  });
});

describe('底部操作', () => {
  it('发布按钮标出下一个版本号', async () => {
    renderDrawer();
    expect(screen.getByRole('button', { name: '发布草稿为 v3' })).toBeInTheDocument();
  });

  it('有未保存改动时禁止发布并说明原因——发布的是已落库的修订', () => {
    renderDrawer({ dirty: true });
    const publish = screen.getByRole('button', { name: /发布草稿为/u });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute('title', expect.stringContaining('先保存草稿'));
    expect(screen.getByText(/先保存草稿才能发布/u)).toBeInTheDocument();
  });

  it('回滚回传版本 id，由引擎写成新的草稿修订', async () => {
    const onRollback = vi.fn();
    renderDrawer({ onRollback });
    await waitFor(() => screen.getByText('v2 → 当前草稿'));
    fireEvent.click(screen.getByRole('button', { name: '回滚为草稿' }));
    expect(onRollback).toHaveBeenCalledWith('wv_2', 2);
  });

  it('导出回传该版本的图与标签', async () => {
    const onExport = vi.fn();
    renderDrawer({ onExport });
    await waitFor(() => screen.getByText('v2 → 当前草稿'));
    fireEvent.click(screen.getByRole('button', { name: '导出此版本' }));
    expect(onExport).toHaveBeenCalledWith(versionGraph, 'v2');
  });
});
