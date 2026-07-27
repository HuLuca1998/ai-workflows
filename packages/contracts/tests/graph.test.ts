import { describe, expect, it } from 'vitest';
import {
  JOIN_STRATEGIES,
  fanIn,
  fanOut,
  topologicalOrder,
  validateGraph,
  type WorkflowGraph,
} from '../src/graph.js';

/**
 * 执行语义由连线决定，不在节点里配置（功能文档 §3.1）：
 * 1→N 并行分发、N→N 并行、N→1 阻塞汇聚。校验器是画布工具栏「问题计数」的数据源，
 * 每条问题都必须能定位到具体节点或连线。
 */

const node = (id: string, type: string, config: unknown): WorkflowGraph['nodes'][number] =>
  ({ id, type, title: id, position: { x: 0, y: 0 }, config }) as WorkflowGraph['nodes'][number];

const edge = (id: string, from: string, fromPort: string, to: string) => ({
  id,
  source: { nodeId: from, port: fromPort },
  target: { nodeId: to, port: 'input' },
});

const entryNode = node('entry', 'entry', { trigger: 'manual', inputSchema: { type: 'object' } });
const endNode = node('end', 'end', { outcome: 'success' });

const minimalGraph = (): WorkflowGraph => ({
  nodes: [entryNode, endNode],
  edges: [edge('e1', 'entry', 'success', 'end')],
  groups: [],
});

describe('图校验', () => {
  it('最小合法图通过校验', () => {
    const result = validateGraph(minimalGraph());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('缺少入口节点是错误', () => {
    const graph: WorkflowGraph = { nodes: [endNode], edges: [], groups: [] };
    expect(validateGraph(graph).issues.map((i) => i.code)).toContain('ENTRY_MISSING');
  });

  it('入口节点全图唯一', () => {
    const graph = minimalGraph();
    graph.nodes.push(
      node('entry2', 'entry', { trigger: 'manual', inputSchema: { type: 'object' } }),
    );
    expect(validateGraph(graph).issues.map((i) => i.code)).toContain('ENTRY_DUPLICATE');
  });

  it('入口节点不能有入边', () => {
    const graph = minimalGraph();
    graph.nodes.push(node('s1', 'script.shell', { interpreter: 'zsh', script: 'x' }));
    graph.edges.push(edge('e2', 's1', 'success', 'entry'));
    expect(validateGraph(graph).issues.map((i) => i.code)).toContain('ENTRY_HAS_INPUT');
  });

  it('未登记的节点类型是错误，且问题带 nodeId 可定位', () => {
    const graph = minimalGraph();
    graph.nodes.push(node('x1', 'ai.imagine', {}));
    const issue = validateGraph(graph).issues.find((i) => i.code === 'UNKNOWN_NODE_TYPE');
    expect(issue?.nodeId).toBe('x1');
  });

  it('节点配置不合法时报 INVALID_CONFIG 并带上字段路径', () => {
    const graph = minimalGraph();
    // 缺 agentProfileId
    graph.nodes.push(node('a1', 'ai.analyze', { instruction: '分析', target: 'issue' }));
    graph.edges.push(edge('e2', 'entry', 'success', 'a1'));
    const issue = validateGraph(graph).issues.find((i) => i.code === 'INVALID_CONFIG');
    expect(issue?.nodeId).toBe('a1');
    expect(issue?.message).toMatch(/agentProfileId/);
  });

  it('连线指向不存在的节点是错误', () => {
    const graph = minimalGraph();
    graph.edges.push(edge('e2', 'entry', 'success', 'ghost'));
    const issue = validateGraph(graph).issues.find((i) => i.code === 'DANGLING_EDGE');
    expect(issue?.edgeId).toBe('e2');
  });

  it('连线用了节点定义里没有的端口是错误', () => {
    const graph = minimalGraph();
    graph.edges[0] = edge('e1', 'entry', 'maybe', 'end');
    expect(validateGraph(graph).issues.map((i) => i.code)).toContain('UNKNOWN_PORT');
  });

  it('条件分支的动态端口按配置解析，不算未知端口', () => {
    const graph: WorkflowGraph = {
      nodes: [
        entryNode,
        node('b1', 'branch', { cases: [{ port: 'high', when: '$.sev == "high"' }] }),
        endNode,
      ],
      edges: [edge('e1', 'entry', 'success', 'b1'), edge('e2', 'b1', 'high', 'end')],
      groups: [],
    };
    expect(validateGraph(graph).ok).toBe(true);
  });

  it('有环时报 CYCLE', () => {
    const graph: WorkflowGraph = {
      nodes: [
        entryNode,
        node('s1', 'script.shell', { interpreter: 'zsh', script: 'a' }),
        node('s2', 'script.shell', { interpreter: 'zsh', script: 'b' }),
        endNode,
      ],
      edges: [
        edge('e1', 'entry', 'success', 's1'),
        edge('e2', 's1', 'success', 's2'),
        edge('e3', 's2', 'success', 's1'),
        edge('e4', 's2', 'success', 'end'),
      ],
      groups: [],
    };
    expect(validateGraph(graph).issues.map((i) => i.code)).toContain('CYCLE');
  });

  it('不可达节点在编辑时只是警告 —— 拖了节点还没连线是正常状态', () => {
    const graph = minimalGraph();
    graph.nodes.push(node('lonely', 'script.shell', { interpreter: 'zsh', script: 'x' }));
    const result = validateGraph(graph);
    const orphan = result.issues.find((i) => i.code === 'ORPHAN_NODE');

    expect(orphan?.level).toBe('warning');
    expect(result.ok).toBe(true); // 只有 error 才让 ok 变 false
  });

  it('不可达节点的提示要说对后果：它会被执行，不是被跳过', () => {
    // 原来的文案是「运行时会被跳过」，正好说反了 ——
    // 调度器挑的是「上游都完成了的节点」，一个没有上游的节点
    // 从第一轮起就满足条件。用户操作级测试真的碰到了：
    // 三个断开的节点显示「校验通过」，然后那个脚本被执行了。
    // 真正的拦截在 Dry Run，那时用户是要真的跑了
    const graph = minimalGraph();
    graph.nodes.push(node('lonely', 'script.shell', { interpreter: 'zsh', script: 'x' }));
    const orphan = validateGraph(graph).issues.find((i) => i.code === 'ORPHAN_NODE');

    expect(orphan?.message).toContain('仍会被执行');
    expect(orphan?.message).not.toContain('跳过');
  });

  it('quorum 汇聚必须给出合法的票数', () => {
    const graph: WorkflowGraph = {
      nodes: [
        entryNode,
        node('s1', 'script.shell', { interpreter: 'zsh', script: 'a' }),
        node('s2', 'script.shell', { interpreter: 'zsh', script: 'b' }),
        { ...endNode, join: { strategy: 'quorum', quorum: 5 } },
      ],
      edges: [
        edge('e1', 'entry', 'success', 's1'),
        edge('e2', 'entry', 'success', 's2'),
        edge('e3', 's1', 'success', 'end'),
        edge('e4', 's2', 'success', 'end'),
      ],
      groups: [],
    };
    expect(validateGraph(graph).issues.map((i) => i.code)).toContain('JOIN_QUORUM_INVALID');
  });
});

describe('拓扑与徽标', () => {
  const fanGraph = (): WorkflowGraph => ({
    nodes: [
      entryNode,
      node('a', 'script.shell', { interpreter: 'zsh', script: 'a' }),
      node('b', 'script.shell', { interpreter: 'zsh', script: 'b' }),
      node('c', 'script.shell', { interpreter: 'zsh', script: 'c' }),
      { ...endNode, join: { strategy: 'all' } },
    ],
    edges: [
      edge('e1', 'entry', 'success', 'a'),
      edge('e2', 'entry', 'success', 'b'),
      edge('e3', 'entry', 'success', 'c'),
      edge('e4', 'a', 'success', 'end'),
      edge('e5', 'b', 'success', 'end'),
      edge('e6', 'c', 'success', 'end'),
    ],
    groups: [],
  });

  it('汇聚策略只有四种（全部 / 任一 / Quorum / 顺序）', () => {
    expect([...JOIN_STRATEGIES].sort()).toEqual(['all', 'any', 'quorum', 'sequential'].sort());
  });

  it('扇出扇入计数即画布徽标 ⋔3 / ⋀3 的来源', () => {
    const graph = fanGraph();
    expect(fanOut(graph, 'entry')).toBe(3);
    expect(fanIn(graph, 'end')).toBe(3);
  });

  it('拓扑排序给出执行记录里的节点顺序', () => {
    const order = topologicalOrder(fanGraph());
    expect(order[0]).toBe('entry');
    expect(order.at(-1)).toBe('end');
    expect(order).toHaveLength(5);
  });

  it('有环图排序时抛错，调用方必须先过校验', () => {
    const graph = minimalGraph();
    graph.edges.push(edge('e2', 'end', 'success', 'entry'));
    expect(() => topologicalOrder(graph)).toThrow(/环/);
  });
});
