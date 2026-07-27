// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  validateGraph,
  type PatchOperation,
  type WorkflowGraph,
} from '@aiwf/contracts';
import { toFlowEdges, toFlowNodes } from '../src/editor/graphAdapter.js';
import { groupBoxes } from '../src/editor/GroupFrame.js';

/**
 * 画布计算的性能下限。
 *
 * M1 的出口标准是「200 节点画布拖拽仍保持 60 fps」。真实帧率要浏览器环境
 * 才测得准（列在 M2 的性能基准里，WKWebView 与 Chromium 各跑一次），
 * 但**每一帧都会触发的计算**在这里就能测——它们超了 16ms，
 * 后面再怎么优化渲染也不可能到 60 fps。
 *
 * 阈值取得比 16ms 宽松：CI 机器有波动，这里要挡的是「算法退化成 O(n²) 卡死」，
 * 不是精确计时。
 */

function bigGraph(nodeCount: number): WorkflowGraph {
  const operations: PatchOperation[] = [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
  ];

  for (let i = 0; i < nodeCount - 1; i++) {
    const id = `n${i}`;
    operations.push({
      op: 'addNode',
      nodeId: id,
      type: 'script.shell',
      title: `节点 ${i}`,
      position: { x: (i % 20) * 260, y: Math.floor(i / 20) * 120 + 120 },
      config: { interpreter: 'zsh', script: `echo ${i}` },
    });
    operations.push({
      op: 'connect',
      edgeId: `e${i}`,
      source:
        i === 0 ? { nodeId: 'entry', port: 'success' } : { nodeId: `n${i - 1}`, port: 'success' },
      target: { nodeId: id, port: 'input' },
    });
  }

  return applyPatch({ nodes: [], edges: [], groups: [] }, 0, {
    baseRevision: 0,
    operations,
  }).graph;
}

const measure = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

describe('200 节点', () => {
  const graph = bigGraph(200);

  it('图确实有 200 个节点与 199 条连线', () => {
    expect(graph.nodes).toHaveLength(200);
    expect(graph.edges).toHaveLength(199);
  });

  it('节点转换在一帧预算内（每次图变化都要跑）', () => {
    const ms = measure(() => toFlowNodes(graph));
    expect(ms, `节点转换耗时 ${ms.toFixed(1)}ms`).toBeLessThan(50);
  });

  it('连线转换在一帧预算内', () => {
    const ms = measure(() => toFlowEdges(graph));
    expect(ms, `连线转换耗时 ${ms.toFixed(1)}ms`).toBeLessThan(50);
  });

  it('图校验没有退化成平方级——它在每次编辑后都会跑', () => {
    const ms = measure(() => validateGraph(graph));
    expect(ms, `校验耗时 ${ms.toFixed(1)}ms`).toBeLessThan(120);
  });

  it('分组包围盒计算随节点数线性增长', () => {
    const withGroups: WorkflowGraph = {
      ...graph,
      groups: [
        { id: 'g1', title: '前半', nodeIds: graph.nodes.slice(0, 100).map((n) => n.id) },
        { id: 'g2', title: '后半', nodeIds: graph.nodes.slice(100).map((n) => n.id) },
      ],
    };
    const ms = measure(() => groupBoxes(withGroups));
    expect(ms, `分组计算耗时 ${ms.toFixed(1)}ms`).toBeLessThan(50);
  });

  it('拖动一个节点只产生一次 Patch，不重算全图布局', () => {
    const ms = measure(() => {
      applyPatch(graph, 0, {
        baseRevision: 0,
        operations: [{ op: 'moveNode', nodeId: 'n5', position: { x: 10, y: 10 } }],
      });
    });
    expect(ms, `单次拖动落库耗时 ${ms.toFixed(1)}ms`).toBeLessThan(80);
  });
});

describe('规模上限', () => {
  it('500 节点时校验仍在可接受范围——超出说明算法有问题', () => {
    const graph = bigGraph(500);
    const ms = measure(() => validateGraph(graph));
    // 200 → 500 是 2.5 倍节点。若是 O(n²)，耗时会涨 6 倍以上
    expect(ms, `500 节点校验耗时 ${ms.toFixed(1)}ms`).toBeLessThan(600);
  });
});
