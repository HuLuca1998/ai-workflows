import { act, render } from '@testing-library/react';
import type { Node, NodeChange, ReactFlowProps } from '@xyflow/react';
// 只要类型的命名空间导入：`import * as` 会把被 mock 的模块又当值引一次，
// 而 `import type * as` 不产生运行时引用
import type * as XYFlow from '@xyflow/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPage } from '../src/editor/EditorPage.js';
import { useEditor } from '../src/editor/editorStore.js';

const captured = vi.hoisted(() => ({
  props: null as ReactFlowProps | null,
}));

// 这里不测试 XYFlow 自己的拖拽实现，只截住它交给受控组件的 changes，
// 验证编辑器有没有把拖动中的位置立即回传给 nodes prop。
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof XYFlow>();
  const React = await import('react');
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    ReactFlow: (props: ReactFlowProps) => {
      captured.props = props;
      return React.createElement('div', { 'data-testid': 'react-flow' }, props.children);
    },
    ViewportPortal: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Background: () => null,
    useReactFlow: () => ({
      screenToFlowPosition: (position: { x: number; y: number }) => position,
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      zoomTo: vi.fn(),
      fitView: vi.fn(),
    }),
  };
});

const graph = {
  nodes: [
    {
      id: 'entry',
      type: 'entry' as const,
      title: '入口',
      position: { x: 40, y: 34 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
  ],
  edges: [],
  groups: [],
};

function flowProps(): ReactFlowProps {
  if (!captured.props) throw new Error('ReactFlow 尚未渲染');
  return captured.props;
}

function positionOf(nodeId: string): { x: number; y: number } | undefined {
  return (flowProps().nodes as Node[] | undefined)?.find((node) => node.id === nodeId)?.position;
}

beforeEach(() => {
  captured.props = null;
  useEditor.setState({
    workflowId: 'wf_1',
    name: '拖拽测试',
    rev: 1,
    graph,
    versions: [],
    validation: { ok: true, issues: [] },
    selection: [],
    loading: false,
    saving: false,
    dirty: false,
    error: null,
    load: async () => {},
    clear: () => {},
  });
});

describe('节点拖动', () => {
  it('按住鼠标时节点逐帧跟随，松手后才把最终位置写入草稿', () => {
    const apply = vi.fn();
    useEditor.setState({ apply });

    render(
      <MemoryRouter initialEntries={['/editor/wf_1']}>
        <Routes>
          <Route path="/editor/:workflowId" element={<EditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(positionOf('entry')).toEqual({ x: 40, y: 34 });

    act(() => {
      flowProps().onNodesChange?.([
        {
          id: 'entry',
          type: 'position',
          position: { x: 180, y: 120 },
          dragging: true,
        },
      ] as NodeChange[]);
    });

    expect(positionOf('entry')).toEqual({ x: 180, y: 120 });
    expect(apply).not.toHaveBeenCalled();

    act(() => {
      flowProps().onNodesChange?.([
        {
          id: 'entry',
          type: 'position',
          position: { x: 220, y: 150 },
          dragging: false,
        },
      ] as NodeChange[]);
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([
      { op: 'moveNode', nodeId: 'entry', position: { x: 220, y: 150 } },
    ]);
  });
});
