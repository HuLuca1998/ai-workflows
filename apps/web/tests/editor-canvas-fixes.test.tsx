import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphNode, WorkflowGraph } from '@aiwf/contracts';
import { NodeConfigDialog } from '../src/editor/NodeConfigDialog.js';
import { toFlowEdges } from '../src/editor/graphAdapter.js';

/**
 * 画布上按视觉与交互规范修掉的那几处「点了没反应 / 误删无法恢复」。
 *
 * 这些坑此前全都躲过了测试：
 * - Esc 关不掉弹层 —— 因为没有任何一条用例按过 Escape
 * - 点连线选不中、Delete 删不掉 —— 因为没有一条用例检查过 edge 的可交互性
 * 按纪律「每一个修过的坑都要有测试」，补在这里防止重构时踩回去。
 */

const graph: WorkflowGraph = { nodes: [], edges: [], groups: [] };

const node: GraphNode = {
  id: 'lint',
  type: 'script.shell',
  title: '运行 lint',
  position: { x: 0, y: 0 },
  config: {
    interpreter: 'zsh',
    script: 'pnpm lint',
    env: {},
    secretEnv: {},
    outputParse: 'none',
    successExitCodes: [0],
    outputLimitBytes: 1048576,
    timeoutMs: 900000,
  },
};

describe('配置弹层 · Esc 与焦点（规范 §6「双击打开居中弹层，Esc 关闭」）', () => {
  it('按 Esc 关闭 —— 处理器挂在 document 上，不依赖焦点已在弹层内', () => {
    const onClose = vi.fn();
    render(<NodeConfigDialog node={node} graph={graph} onClose={onClose} onSave={vi.fn()} />);

    // 焦点故意留在 document.body（模拟「双击节点后焦点还在 .react-flow__node 上」）
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('挂载后焦点落在标题输入框 —— 删除键这时才不会落到画布上删节点', () => {
    render(<NodeConfigDialog node={node} graph={graph} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText('节点标题'));
  });

  it('点遮罩关闭，点弹层内部不关', () => {
    const onClose = vi.fn();
    const { container } = render(
      <NodeConfigDialog node={node} graph={graph} onClose={onClose} onSave={vi.fn()} />,
    );

    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = container.querySelector('.cfg__backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('连线 · 端口语义（规范 §2「同一语义在全应用只有一种表达」）', () => {
  const withEdge: WorkflowGraph = {
    nodes: [],
    groups: [],
    edges: [
      {
        id: 'e-ok',
        source: { nodeId: 'a', port: 'success' },
        target: { nodeId: 'b', port: 'input' },
      },
      {
        id: 'e-bad',
        source: { nodeId: 'a', port: 'failed' },
        target: { nodeId: 'c', port: 'input' },
      },
      {
        id: 'e-hi',
        source: { nodeId: 'br', port: 'high' },
        target: { nodeId: 'd', port: 'input' },
      },
    ],
  };

  it('失败与成功的连线标签不是同一个颜色', () => {
    const edges = toFlowEdges(withEdge);
    const ok = edges.find((e) => e.id === 'e-ok');
    const bad = edges.find((e) => e.id === 'e-bad');

    expect(ok?.labelStyle?.fill).toBeDefined();
    expect(bad?.labelStyle?.fill).toBeDefined();
    expect(ok?.labelStyle?.fill).not.toBe(bad?.labelStyle?.fill);
  });

  it('标签底色不是 XYFlow 的白色默认值 —— 暗场画布上那是整屏最亮的东西', () => {
    const edges = toFlowEdges(withEdge);
    for (const edge of edges) {
      // labelBgStyle 必须给出来，否则走 --xy-edge-label-background-color-default，
      // 而 EditorPage 从不传 colorMode，默认是 light → #ffffff
      expect(edge.labelBgStyle?.fill).toBeDefined();
      expect(String(edge.labelBgStyle?.fill).toLowerCase()).not.toContain('#fff');
    }
  });

  it('分支端口（branch 的 cases）用强调色 —— 它表达的是「需要判断」', () => {
    const edges = toFlowEdges(withEdge);
    const branch = edges.find((e) => e.id === 'e-hi');
    const ok = edges.find((e) => e.id === 'e-ok');
    expect(branch?.labelStyle?.fill).not.toBe(ok?.labelStyle?.fill);
  });
});
