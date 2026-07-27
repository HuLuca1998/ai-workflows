import { describe, expect, it } from 'vitest';
import { CoreApiError } from '../src/errors.js';
import { applyPatch, PatchOperationSchema, type PatchOperation } from '../src/patch.js';
import type { WorkflowGraph } from '../src/graph.js';

/**
 * 主管 AI 的所有写操作只能经 Core API 的结构化 Patch，禁止直接改图 JSON（功能文档 §14）。
 * 这组测试守住三件事：版本守卫、原子性、可视化 Diff。
 */

const baseGraph = (): WorkflowGraph => ({
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    {
      id: 'fix',
      type: 'ai.execute',
      title: '修复',
      position: { x: 200, y: 0 },
      config: { agentProfileId: 'ag_builder', instruction: '修' },
    },
    {
      id: 'approve',
      type: 'approval',
      title: '检查 Diff',
      position: { x: 400, y: 0 },
      config: { title: '检查 Diff', interaction: 'confirm' },
    },
    { id: 'end', type: 'end', title: '结束', position: { x: 600, y: 0 }, config: { outcome: 'success' } },
  ],
  edges: [
    { id: 'e1', source: { nodeId: 'entry', port: 'success' }, target: { nodeId: 'fix', port: 'input' } },
    { id: 'e2', source: { nodeId: 'fix', port: 'success' }, target: { nodeId: 'approve', port: 'input' } },
    {
      id: 'e3',
      source: { nodeId: 'approve', port: 'approved' },
      target: { nodeId: 'end', port: 'input' },
    },
  ],
  groups: [],
});

describe('baseRevision 版本守卫', () => {
  it('版本一致时应用成功，rev 单调递增', () => {
    const result = applyPatch(baseGraph(), 18, {
      baseRevision: 18,
      operations: [{ op: 'renameNode', nodeId: 'fix', title: '修复缺陷' }],
    });
    expect(result.rev).toBe(19);
  });

  it('版本落后时拒绝写入并抛 REVISION_CONFLICT', () => {
    try {
      applyPatch(baseGraph(), 19, {
        baseRevision: 18,
        operations: [{ op: 'renameNode', nodeId: 'fix', title: '别的名字' }],
      });
      expect.unreachable('应当抛出版本冲突');
    } catch (error) {
      expect(error).toBeInstanceOf(CoreApiError);
      expect((error as CoreApiError).code).toBe('REVISION_CONFLICT');
      // 冲突可重试：调用方重新读取 rev 后再试
      expect((error as CoreApiError).retriable).toBe(true);
      expect((error as CoreApiError).hint).toBeTruthy();
    }
  });
});

describe('结构化操作', () => {
  it('没有「整份回写」这种操作——AI 无法绕过版本守卫覆盖全图', () => {
    const forbidden = { op: 'replaceGraph', graph: {} };
    expect(PatchOperationSchema.safeParse(forbidden).success).toBe(false);
  });

  it('addNode 生成节点并可指定 id，配置按节点 Schema 填默认值', () => {
    const result = applyPatch(baseGraph(), 18, {
      baseRevision: 18,
      operations: [
        {
          op: 'addNode',
          nodeId: 'run_lint',
          type: 'script.shell',
          title: '运行 lint',
          position: { x: 300, y: 120 },
          config: { interpreter: 'zsh', script: 'pnpm lint' },
        },
      ],
    });
    const added = result.graph.nodes.find((n) => n.id === 'run_lint');
    expect(added?.type).toBe('script.shell');
    // Schema 默认值必须落到草稿里，否则运行时行为取决于读取方，不可解释
    expect(added?.config).toMatchObject({ outputLimitBytes: expect.any(Number) });
  });

  it('原型里那次 AI 改动可以完整表达：插入节点并改接连线', () => {
    const operations: PatchOperation[] = [
      {
        op: 'addNode',
        nodeId: 'run_lint',
        type: 'script.shell',
        title: '运行 lint',
        position: { x: 300, y: 120 },
        config: { interpreter: 'zsh', script: 'pnpm lint' },
      },
      { op: 'connect', edgeId: 'e4', source: { nodeId: 'fix', port: 'success' }, target: { nodeId: 'run_lint', port: 'input' } },
      { op: 'connect', edgeId: 'e5', source: { nodeId: 'run_lint', port: 'success' }, target: { nodeId: 'approve', port: 'input' } },
      { op: 'disconnect', edgeId: 'e2' },
    ];
    const result = applyPatch(baseGraph(), 18, { baseRevision: 18, operations });

    expect(result.validation.ok).toBe(true);
    expect(result.graph.edges.map((e) => e.id).sort()).toEqual(['e1', 'e3', 'e4', 'e5']);
    expect(result.diff.added).toHaveLength(3); // 1 节点 + 2 连线
    expect(result.diff.removed).toHaveLength(1);
    expect(result.diff.added[0]?.label).toContain('运行 lint');
  });

  it('removeNode 连带断开它的所有连线', () => {
    const result = applyPatch(baseGraph(), 18, {
      baseRevision: 18,
      operations: [{ op: 'removeNode', nodeId: 'approve' }],
    });
    expect(result.graph.nodes.map((n) => n.id)).not.toContain('approve');
    expect(result.graph.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('setConfig 产出「改了什么」的 Diff，前后值都留痕', () => {
    const result = applyPatch(baseGraph(), 18, {
      baseRevision: 18,
      operations: [
        { op: 'setConfig', nodeId: 'approve', config: { title: '检查 Diff', interaction: 'single' } },
      ],
    });
    const changed = result.diff.changed[0];
    expect(changed?.id).toBe('approve');
    expect(changed?.before).toMatchObject({ interaction: 'confirm' });
    expect(changed?.after).toMatchObject({ interaction: 'single' });
  });
});

describe('原子性与校验', () => {
  it('任一操作失败则整批不生效（不留半截草稿）', () => {
    const original = baseGraph();
    expect(() =>
      applyPatch(original, 18, {
        baseRevision: 18,
        operations: [
          { op: 'renameNode', nodeId: 'fix', title: '改了名' },
          { op: 'removeNode', nodeId: '不存在的节点' },
        ],
      }),
    ).toThrow(CoreApiError);
    expect(original.nodes.find((n) => n.id === 'fix')?.title).toBe('修复');
  });

  it('操作不修改传入的图对象（调用方的草稿不被就地改写）', () => {
    const original = baseGraph();
    applyPatch(original, 18, {
      baseRevision: 18,
      operations: [{ op: 'renameNode', nodeId: 'fix', title: '新名字' }],
    });
    expect(original.nodes.find((n) => n.id === 'fix')?.title).toBe('修复');
  });

  it('应用后自动校验，结果一并返回给调用方决定是否落草稿', () => {
    const result = applyPatch(baseGraph(), 18, {
      baseRevision: 18,
      operations: [{ op: 'disconnect', edgeId: 'e1' }],
    });
    expect(result.validation.ok).toBe(true);
    expect(result.validation.issues.some((i) => i.code === 'ORPHAN_NODE')).toBe(true);
  });

  it('产生非法图的 Patch 仍会返回（供 AI 自查），但 validation.ok 为 false', () => {
    const result = applyPatch(baseGraph(), 18, {
      baseRevision: 18,
      operations: [
        {
          op: 'connect',
          edgeId: 'e9',
          source: { nodeId: 'end', port: 'success' },
          target: { nodeId: 'entry', port: 'input' },
        },
      ],
    });
    expect(result.validation.ok).toBe(false);
  });
});
