// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@aiwf/contracts';
import {
  defaultSourcePort,
  defaultTargetPort,
  summarize,
  toFlowEdges,
  toFlowNodes,
} from '../src/editor/graphAdapter.js';

/**
 * 图 ↔ 画布的转换。转换错的症状是「画布上少了东西」而不是报错，
 * 所以每条规则都要有用例。
 */

const graph = (): WorkflowGraph => ({
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 40, y: 34 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    {
      id: 'lint',
      type: 'script.shell',
      title: '运行 lint',
      position: { x: 290, y: 34 },
      config: { interpreter: 'zsh', script: 'pnpm lint\n还有第二行' },
    },
    {
      id: 'end',
      type: 'end',
      title: '结束',
      position: { x: 540, y: 34 },
      config: { outcome: 'success' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'lint', port: 'input' },
    },
    {
      id: 'e2',
      source: { nodeId: 'lint', port: 'success' },
      target: { nodeId: 'end', port: 'input' },
    },
  ],
  groups: [],
});

describe('节点转换', () => {
  it('每个图节点都变成一个画布节点，位置原样保留', () => {
    const nodes = toFlowNodes(graph());
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ id: 'entry', type: 'workflow', position: { x: 40, y: 34 } });
  });

  it('M1 没有运行数据，节点一律是 idle 而不是假装完成', () => {
    for (const node of toFlowNodes(graph())) {
      expect((node.data as { tone: string }).tone).toBe('idle');
    }
  });

  it('扇出扇入徽标按连线算出来', () => {
    const g = graph();
    g.edges.push({
      id: 'e3',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'end', port: 'input' },
    });
    const nodes = toFlowNodes(g);
    expect(nodes[0]?.data).toMatchObject({ joinBadge: '⋔2' });
    expect(nodes[2]?.data).toMatchObject({ joinBadge: '⋀2' });
  });

  it('校验有 error 的节点被标出来，供画布定位', () => {
    const nodes = toFlowNodes(graph(), {
      issues: [{ level: 'error', code: 'INVALID_CONFIG', message: 'x', nodeId: 'lint' }],
    });
    expect(nodes[1]?.data).toMatchObject({ hasIssue: true });
    expect(nodes[0]?.data).not.toHaveProperty('hasIssue');
  });

  it('warning 不标问题——不阻塞发布的东西不该在画布上报警', () => {
    const nodes = toFlowNodes(graph(), {
      issues: [{ level: 'warning', code: 'ORPHAN_NODE', message: 'x', nodeId: 'lint' }],
    });
    expect(nodes[1]?.data).not.toHaveProperty('hasIssue');
  });
});

describe('副文本', () => {
  it('脚本节点显示解释器与命令首行，长命令截断', () => {
    expect(summarize('script.shell', { interpreter: 'zsh', script: 'pnpm lint\n第二行' })).toBe(
      'zsh · pnpm lint',
    );
  });

  it('入口显示触发方式', () => {
    expect(summarize('entry', { trigger: 'manual' })).toBe('触发：manual');
  });

  it('AI 节点显示指令摘要，没指令时退回角色 id', () => {
    expect(summarize('ai.analyze', { instruction: '分析根因', agentProfileId: 'a1' })).toBe(
      '分析根因',
    );
    expect(summarize('ai.analyze', { agentProfileId: 'a1' })).toBe('a1');
  });

  it('审批没标题时给出可读兜底，而不是空白', () => {
    expect(summarize('approval', {})).toBe('等待人工决定');
  });

  it('配置为空也不会抛错——画布不能因为一个坏节点整屏白', () => {
    for (const type of ['entry', 'branch', 'transform', 'env', 'mcp.tool', 'end'] as const) {
      expect(() => summarize(type, undefined)).not.toThrow();
    }
  });
});

describe('连线转换', () => {
  it('边带上逻辑端口；源节点只有一个输出时不标 label —— 那是纯噪声', () => {
    const edges = toFlowEdges(graph());
    expect(edges[0]).toMatchObject({
      id: 'e1',
      source: 'entry',
      target: 'lint',
    });
    // entry 只有 success 一个输出端口。一条 5 节点的线性流程会因此摆 4 个
    // 「success」标签，而它们不传递任何信息 —— 每个标签还是一块底色方块。
    // 只在真有分叉（resolveNodeOutputs 返回 >1 个端口）时才标。
    expect(edges[0]).not.toHaveProperty('label');
    // 端口语义仍然留在 data 里，右键菜单据此切换
    expect(edges[0]?.data).toMatchObject({ sourcePort: 'success', targetPort: 'input' });
  });

  it('新建连线默认取第一个输出端口', () => {
    expect(defaultSourcePort('entry', {})).toBe('success');
    expect(defaultSourcePort('ai.execute', {})).toBe('success');
    expect(defaultSourcePort('approval', {})).toBe('approved');
  });

  it('条件分支的默认端口跟着配置走', () => {
    expect(defaultSourcePort('branch', { cases: [{ port: 'high', when: 'x' }] })).toBe('high');
  });

  it('结束节点没有输出端口，不能从它拖出连线', () => {
    expect(defaultSourcePort('end', {})).toBeNull();
  });

  it('入口节点没有输入端口，不能连到它', () => {
    expect(defaultTargetPort('entry')).toBeNull();
    expect(defaultTargetPort('end')).toBe('input');
  });
});

describe('自定义类型必须是注册过的', () => {
  it('边的 type 必须是 EditorPage 注册过的 —— 未注册的会静默退化并刷控制台', () => {
    // React Flow 对未注册的 type 不报错，只是退回默认样式，
    // 同时每渲染一次刷一条 `Edge type "xxx" not found`。
    // 一次编辑累计几十条，把真正的错误淹掉了。
    //
    // 边现在走 floating：端点按两端节点的矩形实时选（4×4 取最近的一对），
    // 不绑 Handle —— 绑了的话把节点拖到另一侧，线还从原来那条边出去。
    const registered = new Set(['floating']);
    const edges = toFlowEdges(graph());
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.type, `边 ${edge.id} 的 type 没有对应的自定义组件`).toBe('floating');
      expect(registered.has(edge.type as string)).toBe(true);
    }
  });

  it('节点带 workflow 类型 —— 那个是注册过的', () => {
    const nodes = toFlowNodes(graph(), {});
    expect(nodes.every((node) => node.type === 'workflow')).toBe(true);
  });
});
