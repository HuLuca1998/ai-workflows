import { describe, expect, it } from 'vitest';
import { validateGraph, type WorkflowGraph } from '../src/graph.js';

/**
 * 两条运行时才会咬人的图规则。
 *
 * 它们原来只在 `templates.test.ts` 里守着内置模板 —— **用户自己画的图
 * 完全不受保护**：Dry Run 全绿，跑起来才出事，而两种症状都极难查。
 * 两条都是独立复核实跑出来的。
 */

const 空: WorkflowGraph = { nodes: [], edges: [], groups: [] };
const 入口 = {
  id: 'entry',
  type: 'entry' as const,
  title: '入口',
  position: { x: 0, y: 0 },
  config: { inputSchema: { type: 'object' } },
};
const 终点 = (id: string) => ({
  id,
  type: 'end' as const,
  title: '结束',
  position: { x: 3, y: 0 },
  config: { outcome: 'success' as const, artifacts: [] },
});
const 脚本 = {
  id: 'sh',
  type: 'script.shell' as const,
  title: '跑',
  position: { x: 1, y: 0 },
  config: { interpreter: 'zsh' as const, script: 'echo ok' },
};
const 边 = (id: string, from: string, port: string, to: string) => ({
  id,
  source: { nodeId: from, port },
  target: { nodeId: to, port: 'input' },
});

const codes = (graph: WorkflowGraph) => validateGraph(graph).issues.map((i) => i.code);

describe('端口没有下游', () => {
  it('只接了 success、failed 悬空 —— 报出来', () => {
    /*
     * 实测症状：notify 无发送器时走 `failed` 口，而图上只接了 success ⇒
     * 运行判 **succeeded**，后面的节点一个没跑，事件流里没有任何异常。
     * 收 report.json 的那个 end 节点因此永不执行 —— 报告抽屉空着，运行绿着。
     */
    const graph: WorkflowGraph = {
      ...空,
      nodes: [入口, 脚本, 终点('done')],
      edges: [边('a', 'entry', 'success', 'sh'), 边('b', 'sh', 'success', 'done')],
    };
    expect(codes(graph)).toContain('PORT_NO_DOWNSTREAM');
  });

  it('两个端口都接了就不报', () => {
    const graph: WorkflowGraph = {
      ...空,
      nodes: [入口, 脚本, 终点('done'), 终点('bad')],
      edges: [
        边('a', 'entry', 'success', 'sh'),
        边('b', 'sh', 'success', 'done'),
        边('c', 'sh', 'failed', 'bad'),
      ],
    };
    expect(codes(graph)).not.toContain('PORT_NO_DOWNSTREAM');
  });

  it('终点节点没有出边 —— 不该被误报', () => {
    const graph: WorkflowGraph = {
      ...空,
      nodes: [入口, 终点('done')],
      edges: [边('a', 'entry', 'success', 'done')],
    };
    expect(codes(graph)).not.toContain('PORT_NO_DOWNSTREAM');
  });
});

describe('汇聚策略没声明', () => {
  it('两条来自不同端口的入边 —— 报 error', () => {
    /*
     * 实测症状：默认策略是「等全部到齐」，而互斥端口只会走一条 ⇒
     * `run.failed · 没有可继续的节点`，`current_node` 是 NULL、
     * **没有 node.failed 事件** —— 界面上是一条不知道死在哪的失败运行。
     */
    const graph: WorkflowGraph = {
      ...空,
      nodes: [入口, 脚本, 终点('done')],
      edges: [
        边('a', 'entry', 'success', 'sh'),
        边('b', 'sh', 'success', 'done'),
        边('c', 'sh', 'failed', 'done'),
      ],
    };
    expect(codes(graph)).toContain('JOIN_STRATEGY_MISSING');
  });

  it('显式声明了 any 就不报', () => {
    const graph: WorkflowGraph = {
      ...空,
      nodes: [入口, 脚本, { ...终点('done'), join: { strategy: 'any' as const } }],
      edges: [
        边('a', 'entry', 'success', 'sh'),
        边('b', 'sh', 'success', 'done'),
        边('c', 'sh', 'failed', 'done'),
      ],
    };
    expect(codes(graph)).not.toContain('JOIN_STRATEGY_MISSING');
  });

  it('同一来源的重复边不算「多条入边」', () => {
    // 重复连线由 DUPLICATE_EDGE 管，不该在这里也报一遍
    const graph: WorkflowGraph = {
      ...空,
      nodes: [入口, 脚本, 终点('done')],
      edges: [
        边('a', 'entry', 'success', 'sh'),
        边('b', 'sh', 'success', 'done'),
        边('c', 'sh', 'success', 'done'),
        边('d', 'sh', 'failed', 'done'),
      ].slice(0, 3),
    };
    expect(codes(graph)).not.toContain('JOIN_STRATEGY_MISSING');
  });

  it('只有一条入边不报', () => {
    const graph: WorkflowGraph = {
      ...空,
      nodes: [入口, 脚本, 终点('done'), 终点('bad')],
      edges: [
        边('a', 'entry', 'success', 'sh'),
        边('b', 'sh', 'success', 'done'),
        边('c', 'sh', 'failed', 'bad'),
      ],
    };
    expect(codes(graph)).not.toContain('JOIN_STRATEGY_MISSING');
  });
});
