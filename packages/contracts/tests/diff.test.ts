import { describe, expect, it } from 'vitest';
import { diffGraphs } from '../src/diff.js';
import type { WorkflowGraph } from '../src/graph.js';

/**
 * 两份图之间的 Diff。版本抽屉用它对比「草稿 vs 某个已发布版本」，
 * 图纸里那四行就是它的输出：
 *   + node  script.shell「运行 lint」
 *   + edge  execute → run_lint
 *   − edge  execute → review
 *   ~ node  decide：可自动决策层级 L1 → L1–L2
 */

const base = (): WorkflowGraph => ({
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    {
      id: 'decide',
      type: 'ai.decide',
      title: '决策',
      position: { x: 300, y: 0 },
      config: { agentProfileId: 'a1', instruction: '判断', autoDecideUpTo: 'L1' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'decide', port: 'input' },
    },
  ],
  groups: [],
});

describe('新增与删除', () => {
  it('新增节点标 +，带类型与标题', () => {
    const next = base();
    next.nodes.push({
      id: 'lint',
      type: 'script.shell',
      title: '运行 lint',
      position: { x: 600, y: 0 },
      config: { interpreter: 'zsh', script: 'pnpm lint' },
    });

    const diff = diffGraphs(base(), next);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toMatchObject({ kind: 'node', id: 'lint' });
    expect(diff.added[0]?.label).toBe('node script.shell「运行 lint」');
  });

  it('删除连线标 −，标签写清两端', () => {
    const next = base();
    next.edges = [];
    const diff = diffGraphs(base(), next);
    expect(diff.removed[0]).toMatchObject({ kind: 'edge', id: 'e1' });
    expect(diff.removed[0]?.label).toBe('edge entry.success → decide');
  });

  it('两份一样的图没有任何 Diff', () => {
    const diff = diffGraphs(base(), base());
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

describe('修改', () => {
  it('配置变化标 ~，标签指出改了哪个字段与前后值', () => {
    const next = base();
    const decide = next.nodes.find((n) => n.id === 'decide');
    if (decide) decide.config = { ...(decide.config as object), autoDecideUpTo: 'L2' };

    const diff = diffGraphs(base(), next);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.label).toBe('node decide：autoDecideUpTo L1 → L2');
  });

  it('多个字段变化时都列出来', () => {
    const next = base();
    const decide = next.nodes.find((n) => n.id === 'decide');
    if (decide)
      decide.config = {
        ...(decide.config as object),
        autoDecideUpTo: 'L3',
        instruction: '重新判断',
      };

    const diff = diffGraphs(base(), next);
    expect(diff.changed[0]?.label).toContain('autoDecideUpTo L1 → L3');
    expect(diff.changed[0]?.label).toContain('instruction');
  });

  it('标题变化单独标出来', () => {
    const next = base();
    const decide = next.nodes.find((n) => n.id === 'decide');
    if (decide) decide.title = '风险分级';

    const diff = diffGraphs(base(), next);
    expect(diff.changed[0]?.label).toBe('node decide：标题 决策 → 风险分级');
  });

  it('只挪了位置不算改动——布局不影响执行语义', () => {
    const next = base();
    const decide = next.nodes.find((n) => n.id === 'decide');
    if (decide) decide.position = { x: 999, y: 999 };

    expect(diffGraphs(base(), next).changed).toEqual([]);
  });
});

describe('分组', () => {
  it('新增与删除分组都算 Diff', () => {
    const next = base();
    next.groups = [{ id: 'g1', title: '判断阶段', nodeIds: ['decide'] }];

    const diff = diffGraphs(base(), next);
    expect(diff.added[0]).toMatchObject({ kind: 'group', id: 'g1' });
    expect(diff.added[0]?.label).toBe('group「判断阶段」');

    const back = diffGraphs(next, base());
    expect(back.removed[0]).toMatchObject({ kind: 'group', id: 'g1' });
  });
});

describe('前后值', () => {
  it('每条 Diff 都带 before / after，界面要能展开看细节', () => {
    const next = base();
    const decide = next.nodes.find((n) => n.id === 'decide');
    if (decide) decide.config = { ...(decide.config as object), autoDecideUpTo: 'L2' };

    const entry = diffGraphs(base(), next).changed[0];
    expect(entry?.before).toMatchObject({ autoDecideUpTo: 'L1' });
    expect(entry?.after).toMatchObject({ autoDecideUpTo: 'L2' });
  });
});
