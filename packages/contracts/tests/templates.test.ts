import { describe, expect, it } from 'vitest';
import { applyPatch } from '../src/patch.js';
import { getNodeDefinition } from '../src/nodes/index.js';
import { topologicalOrder, validateGraph, type WorkflowGraph } from '../src/graph.js';
import { WORKFLOW_TEMPLATES, templateById } from '../src/templates.js';

/**
 * M1 的出口标准：「GitHub Issue 修复模板可完整搭出、校验通过并发布为 v1」。
 *
 * 这个文件就是那条标准的可执行验证——模板走的是与手工搭建、与 AI 改图
 * 完全相同的路径（applyPatch），所以它通过，等于这条路径本身通过。
 */

const EMPTY: WorkflowGraph = { nodes: [], edges: [], groups: [] };

function build(templateId: string) {
  const template = templateById(templateId);
  if (!template) throw new Error(`没有模板 ${templateId}`);
  return applyPatch(EMPTY, 0, { baseRevision: 0, operations: template.operations });
}

describe('GitHub Issue 修复模板', () => {
  it('能被结构化操作完整搭出，且校验通过', () => {
    const result = build('github-issue-fix');
    expect(
      result.validation.issues.filter((i) => i.level === 'error'),
      `校验未通过：${JSON.stringify(result.validation.issues)}`,
    ).toEqual([]);
    expect(result.validation.ok).toBe(true);
  });

  it('覆盖了图纸主线上的每一个环节', () => {
    const { graph } = build('github-issue-fix');
    const types = graph.nodes.map((n) => n.type);
    for (const required of [
      'entry',
      'script.shell',
      'ai.analyze',
      'approval',
      'git.worktree',
      'ai.execute',
      'ai.review',
      'ai.decide',
      'notify',
      'end',
    ] as const) {
      expect(types, `缺少 ${required} 节点`).toContain(required);
    }
  });

  it('用到了分支端口，而不是所有连线都走默认的第一个输出', () => {
    const { graph } = build('github-issue-fix');
    const ports = graph.edges.map((e) => e.source.port);
    // 审批的 approved、审查的 passed / changes_requested、决策的 escalated
    expect(ports).toContain('approved');
    expect(ports).toContain('passed');
    expect(ports).toContain('changes_requested');
    expect(ports).toContain('escalated');
  });

  it('每条连线的端口都真的存在于源节点的定义里', () => {
    const { graph } = build('github-issue-fix');
    for (const edge of graph.edges) {
      const source = graph.nodes.find((n) => n.id === edge.source.nodeId);
      expect(source, `连线 ${edge.id} 的源节点不存在`).toBeTruthy();
      if (!source) continue;
      const outputs = getNodeDefinition(source.type).ports.outputs.map((p) => p.id);
      expect(outputs, `${source.type} 没有端口 ${edge.source.port}`).toContain(edge.source.port);
    }
  });

  it('是有向无环图，能排出执行顺序', () => {
    const { graph } = build('github-issue-fix');
    const order = topologicalOrder(graph);
    expect(order[0]).toBe('entry');
    expect(order).toHaveLength(graph.nodes.length);
  });

  it('外部写操作被审批挡在前面——这是产品的硬约束', () => {
    const { graph } = build('github-issue-fix');
    const push = graph.nodes.find((n) => n.title.includes('Push'));
    expect(push).toBeTruthy();

    // 找出所有直接指向 push 节点的边，其源头必须是审批
    const incoming = graph.edges.filter((e) => e.target.nodeId === push?.id);
    expect(incoming.length).toBeGreaterThan(0);
    for (const edge of incoming) {
      const from = graph.nodes.find((n) => n.id === edge.source.nodeId);
      expect(from?.type, 'push / PR 前面必须是审批节点').toBe('approval');
      expect(edge.source.port, '只有批准分支能往下走').toBe('approved');
    }
  });

  it('每个节点的配置都通过各自的 Schema——模板不能带着非法配置发出去', () => {
    const { graph } = build('github-issue-fix');
    for (const node of graph.nodes) {
      const parsed = getNodeDefinition(node.type).configSchema.safeParse(node.config);
      expect(parsed.success, `${node.id} 配置不合法：${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it('入口节点全图唯一，且没有入边', () => {
    const { graph } = build('github-issue-fix');
    expect(graph.nodes.filter((n) => n.type === 'entry')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.target.nodeId === 'entry')).toHaveLength(0);
  });

  it('没有孤立节点——每个节点都在主线上', () => {
    const { graph } = build('github-issue-fix');
    const orphans = validateGraph(graph).issues.filter((i) => i.code === 'ORPHAN_NODE');
    expect(orphans, `孤立节点：${orphans.map((o) => o.nodeId).join(', ')}`).toEqual([]);
  });
});

describe('模板清单', () => {
  it('每个模板都有 id、名称与一句话说明', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.name).toBeTruthy();
      expect(template.summary.length).toBeGreaterThan(4);
    }
  });

  it('全部模板都能搭出合法的图', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const result = build(template.id);
      expect(result.validation.ok, `${template.name} 校验未通过`).toBe(true);
    }
  });

  it('取未知模板返回 undefined，不抛错', () => {
    expect(templateById('不存在')).toBeUndefined();
  });
});
