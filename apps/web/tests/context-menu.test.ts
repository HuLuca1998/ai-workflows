// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPatch, type WorkflowGraph } from '@aiwf/contracts';
import { menuItemsFor, operationsFor } from '../src/editor/menuActions.js';

/**
 * 右键菜单。菜单项来自功能文档 §3.1；这里验证「点了之后图变成什么样」。
 *
 * 每个动作都把产出的 Patch 真的应用一遍再断言——只测「生成了哪些操作」
 * 会漏掉「这批操作放在一起其实非法」这类问题。
 */

const graph = (): WorkflowGraph => ({
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    {
      id: 'exec',
      type: 'ai.execute',
      title: '执行',
      position: { x: 300, y: 0 },
      config: { agentProfileId: 'a1', instruction: '改代码' },
    },
    {
      id: 'end',
      type: 'end',
      title: '结束',
      position: { x: 600, y: 0 },
      config: { outcome: 'success' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'exec', port: 'input' },
    },
    {
      id: 'e2',
      source: { nodeId: 'exec', port: 'success' },
      target: { nodeId: 'end', port: 'input' },
    },
  ],
  groups: [{ id: 'g1', title: '修复阶段', nodeIds: ['exec'] }],
});

const ctx = (selection: string[] = []) => ({ graph: graph(), selection });

/** 应用一批操作，返回结果图与校验结果。 */
const run = (ops: ReturnType<typeof operationsFor>, base = graph()) =>
  applyPatch(base, 0, { baseRevision: 0, operations: ops });

describe('菜单项', () => {
  it('节点菜单与功能文档 §3.1 一致', () => {
    const items = menuItemsFor({ kind: 'node', nodeId: 'exec' }, ctx());
    expect(items.map((i) => i.label)).toEqual([
      '编辑配置',
      '复制',
      '断开全部连线',
      '用选中节点建分组',
      '删除',
    ]);
  });

  it('连线菜单含删除 / 反转 / 插入节点，外加端口切换', () => {
    const items = menuItemsFor({ kind: 'edge', edgeId: 'e2' }, ctx());
    expect(items.map((i) => i.id)).toEqual([
      'switch-port',
      'reverse',
      'insert-node',
      'delete-edge',
    ]);
  });

  it('只有一个输出端口时禁用端口切换并说明原因', () => {
    // entry 只有 success 一个输出
    const items = menuItemsFor({ kind: 'edge', edgeId: 'e1' }, ctx());
    const switchPort = items.find((i) => i.id === 'switch-port');
    expect(switchPort?.disabled).toBe(true);
    expect(switchPort?.disabledReason).toMatch(/只有一个输出端口/u);
  });

  it('选中不足两个时禁用建分组，并说清要怎么做', () => {
    const item = menuItemsFor({ kind: 'node', nodeId: 'exec' }, ctx(['exec'])).find(
      (i) => i.id === 'group',
    );
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toMatch(/两个以上/u);
  });

  it('没有连线的节点禁用「断开全部连线」', () => {
    const g = graph();
    g.edges = [];
    const item = menuItemsFor({ kind: 'node', nodeId: 'exec' }, { graph: g, selection: [] }).find(
      (i) => i.id === 'disconnect',
    );
    expect(item?.disabled).toBe(true);
  });

  it('破坏性操作被标出来，界面上要区别对待', () => {
    expect(
      menuItemsFor({ kind: 'node', nodeId: 'exec' }, ctx()).find((i) => i.id === 'delete')?.danger,
    ).toBe(true);
    expect(
      menuItemsFor({ kind: 'group', groupId: 'g1' }, ctx()).find((i) => i.id === 'dissolve-group')
        ?.danger,
    ).toBe(true);
  });
});

describe('节点操作', () => {
  it('复制产生一个偏移的同类型节点，配置一并带过去', () => {
    const ops = operationsFor('duplicate', { kind: 'node', nodeId: 'exec' }, ctx());
    const result = run(ops);
    const copy = result.graph.nodes.find((n) => n.title === '执行 副本');
    expect(copy?.type).toBe('ai.execute');
    expect(copy?.position).toEqual({ x: 340, y: 40 });
    expect(result.validation.ok).toBe(true);
  });

  it('断开全部连线只断这个节点的边', () => {
    const ops = operationsFor('disconnect', { kind: 'node', nodeId: 'exec' }, ctx());
    const result = run(ops);
    expect(result.graph.edges).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(3);
  });

  it('删除节点连带断开它的连线，不留悬空边', () => {
    const result = run(operationsFor('delete', { kind: 'node', nodeId: 'exec' }, ctx()));
    expect(result.graph.nodes.map((n) => n.id)).toEqual(['entry', 'end']);
    expect(result.graph.edges).toHaveLength(0);
    // 悬空边会让校验直接报 DANGLING_EDGE
    expect(result.validation.issues.some((i) => i.code === 'DANGLING_EDGE')).toBe(false);
  });

  it('用选中节点建分组', () => {
    const ops = operationsFor('group', { kind: 'canvas' }, ctx(['entry', 'exec']), {
      value: '准备阶段',
    });
    const result = run(ops);
    expect(result.graph.groups.at(-1)).toMatchObject({
      title: '准备阶段',
      nodeIds: ['entry', 'exec'],
    });
  });

  it('没给标题时用「新分组」而不是空标题', () => {
    const result = run(operationsFor('group', { kind: 'canvas' }, ctx(['entry', 'exec'])));
    expect(result.graph.groups.at(-1)?.title).toBe('新分组');
  });
});

describe('连线操作', () => {
  it('切换源端口 = 断开重连，目标端口不变', () => {
    const ops = operationsFor('switch-port', { kind: 'edge', edgeId: 'e2' }, ctx(), {
      value: 'failed',
    });
    const result = run(ops);
    const edge = result.graph.edges.find((e) => e.source.nodeId === 'exec');
    expect(edge?.source.port).toBe('failed');
    expect(edge?.target).toEqual({ nodeId: 'end', port: 'input' });
    expect(result.validation.ok).toBe(true);
  });

  it('反转方向后仍是合法图', () => {
    const result = run(operationsFor('reverse', { kind: 'edge', edgeId: 'e1' }, ctx()));
    // entry 不能有入边，所以反转 entry→exec 会得到非法图；校验必须能报出来
    expect(result.validation.issues.some((i) => i.code === 'ENTRY_HAS_INPUT')).toBe(true);
  });

  it('从 end 出发的方向不可能合法，直接不产生操作', () => {
    // e2 反转后是 end → exec，end 没有输出端口
    expect(operationsFor('reverse', { kind: 'edge', edgeId: 'e2' }, ctx())).toEqual([]);
  });

  it('在连线上插入节点：断开原边，接成两段', () => {
    const ops = operationsFor('insert-node', { kind: 'edge', edgeId: 'e1' }, ctx(), {
      nodeType: 'script.shell',
      nodeTitle: '运行 lint',
      nodeConfig: { interpreter: 'zsh', script: 'pnpm lint' },
    });
    const result = run(ops);

    expect(result.graph.edges).toHaveLength(3);
    const inserted = result.graph.nodes.find((n) => n.title === '运行 lint');
    expect(inserted).toBeTruthy();
    // entry → 新节点 → exec，原来的 entry → exec 不在了
    expect(
      result.graph.edges.some(
        (e) => e.source.nodeId === 'entry' && e.target.nodeId === inserted?.id,
      ),
    ).toBe(true);
    expect(
      result.graph.edges.some(
        (e) => e.source.nodeId === inserted?.id && e.target.nodeId === 'exec',
      ),
    ).toBe(true);
    expect(
      result.graph.edges.some((e) => e.source.nodeId === 'entry' && e.target.nodeId === 'exec'),
    ).toBe(false);
    expect(result.validation.ok).toBe(true);
  });

  it('删除连线', () => {
    const result = run(operationsFor('delete-edge', { kind: 'edge', edgeId: 'e1' }, ctx()));
    expect(result.graph.edges.map((e) => e.id)).toEqual(['e2']);
  });
});

describe('分组操作', () => {
  it('重命名保留成员', () => {
    const result = run(
      operationsFor('rename-group', { kind: 'group', groupId: 'g1' }, ctx(), { value: '执行阶段' }),
    );
    expect(result.graph.groups).toHaveLength(1);
    expect(result.graph.groups[0]).toMatchObject({
      id: 'g1',
      title: '执行阶段',
      nodeIds: ['exec'],
    });
  });

  it('空标题不改动', () => {
    expect(
      operationsFor('rename-group', { kind: 'group', groupId: 'g1' }, ctx(), { value: '   ' }),
    ).toEqual([]);
  });

  it('解散分组不动节点', () => {
    const result = run(operationsFor('dissolve-group', { kind: 'group', groupId: 'g1' }, ctx()));
    expect(result.graph.groups).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(3);
  });
});

describe('文件命名', () => {
  it('editor 目录里不存在仅大小写不同的同名文件', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../src/editor', import.meta.url));
    const names = readdirSync(dir);
    const lowered = names.map((n) => n.toLowerCase());
    // macOS 的文件系统大小写不敏感：ContextMenu.tsx 与 contextMenu.ts 并存时
    // import 会解析到错的那个，症状是组件变成 undefined
    expect(new Set(lowered).size, `重名：${names.join(', ')}`).toBe(names.length);
  });
});

describe('不改图的动作', () => {
  it('编辑配置只影响界面状态，不产生 Patch', () => {
    expect(operationsFor('edit', { kind: 'node', nodeId: 'exec' }, ctx())).toEqual([]);
  });

  it('未知动作 id 不产生任何操作', () => {
    expect(operationsFor('drop-database', { kind: 'node', nodeId: 'exec' }, ctx())).toEqual([]);
  });
});
