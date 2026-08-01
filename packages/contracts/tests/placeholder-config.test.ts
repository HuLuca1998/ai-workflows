import { describe, expect, it } from 'vitest';
import { NODE_TYPES, getNodeDefinition, validateGraph } from '../src/index.js';
import type { WorkflowGraph } from '../src/index.js';

/**
 * 还带着占位值的节点要报出来。
 *
 * 拖进画布时用 `seed` 填一份能过 configSchema 的初始配置 ——
 * 而那些占位值是**真实字符串**（`待填写指令` / `待选择角色` /
 * `# 待填写命令`），于是 `z.string().min(1)` 一路放行：
 * 顶栏说「校验通过」，用户放心保存，点运行才发现 Dry Run 报
 * 「8 项缺失」（第三方巡检 B-07、复核 H；DEBT O-14 记的就是这条）。
 *
 * 是 **warning 不是 error**：编辑中途留着占位值是正常状态，
 * 此时禁掉保存会很难用。但顶栏必须说「有 N 项待填」而不是「校验通过」。
 *
 * 判据从 `seed` 算出来，不在这里抄一份清单 —— 抄的那份在
 * 新增节点类型时不会跟着长。
 */

const entry = {
  id: 'entry_1',
  type: 'entry' as const,
  title: '入口设置',
  position: { x: 0, y: 0 },
  config: getNodeDefinition('entry').seed ?? {},
};

const end = {
  id: 'end_1',
  type: 'end' as const,
  title: '结束',
  position: { x: 400, y: 0 },
  config: getNodeDefinition('end').seed ?? {},
};

function graphWith(node: WorkflowGraph['nodes'][number]): WorkflowGraph {
  return {
    nodes: [entry, node, end],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'entry_1', port: 'success' },
        target: { nodeId: node.id, port: 'input' },
      },
      {
        id: 'e2',
        source: { nodeId: node.id, port: 'success' },
        target: { nodeId: 'end_1', port: 'input' },
      },
    ],
    groups: [],
  } as WorkflowGraph;
}

describe('占位配置要报成待填', () => {
  it('刚拖进来的 AI 节点带占位值 —— 报 warning', () => {
    const node = {
      id: 'ai_1',
      type: 'ai.analyze' as const,
      title: 'AI · 分析',
      position: { x: 200, y: 0 },
      config: getNodeDefinition('ai.analyze').seed ?? {},
    };
    const result = validateGraph(graphWith(node));
    const 待填 = result.issues.filter((i) => i.code === 'PLACEHOLDER_CONFIG');

    expect(待填.length, 'seed 全是占位值，而校验说没问题').toBeGreaterThan(0);
    expect(待填[0]!.level, '编辑中途留占位是正常的，不该拦住保存').toBe('warning');
    expect(待填[0]!.nodeId).toBe('ai_1');
  });

  it('说清是哪几个字段 —— 只说「有占位」用户还得自己找', () => {
    const node = {
      id: 'ai_1',
      type: 'ai.analyze' as const,
      title: 'AI · 分析',
      position: { x: 200, y: 0 },
      config: getNodeDefinition('ai.analyze').seed ?? {},
    };
    const 那条 = validateGraph(graphWith(node)).issues.find(
      (i) => i.code === 'PLACEHOLDER_CONFIG',
    )!;
    expect(那条.message).toMatch(/指令|角色|对象/u);
  });

  it('填过的字段不再报 —— 报一个用户已经填好的东西是噪音', () => {
    const seed = getNodeDefinition('ai.analyze').seed ?? {};
    const node = {
      id: 'ai_1',
      type: 'ai.analyze' as const,
      title: 'AI · 分析',
      position: { x: 200, y: 0 },
      config: {
        ...seed,
        agentProfileId: 'builtin:analyst',
        instruction: '分析这次失败的根因',
        target: 'run_abc',
      },
    };
    expect(
      validateGraph(graphWith(node)).issues.filter((i) => i.code === 'PLACEHOLDER_CONFIG'),
    ).toEqual([]);
  });

  it('不含占位值的节点类型一开始就不报', () => {
    // end 的 seed 是 { outcome: 'success' } —— 那是真实的默认值，不是占位
    const result = validateGraph({
      nodes: [entry, end],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'entry_1', port: 'success' },
          target: { nodeId: 'end_1', port: 'input' },
        },
      ],
      groups: [],
    } as WorkflowGraph);
    expect(result.issues.filter((i) => i.code === 'PLACEHOLDER_CONFIG')).toEqual([]);
  });

  it('每种带占位 seed 的类型都能被认出来 —— 判据不是抄的一份清单', () => {
    const 带占位的 = NODE_TYPES.filter((type) => {
      const seed = getNodeDefinition(type).seed ?? {};
      return Object.values(seed).some((v) => typeof v === 'string' && /待[填选]/u.test(v));
    });
    expect(带占位的.length, '一个带占位 seed 的类型都没有？那这条测试该删了').toBeGreaterThan(0);

    for (const type of 带占位的) {
      const node = {
        id: 'n_x',
        type,
        title: getNodeDefinition(type).title,
        position: { x: 200, y: 0 },
        config: getNodeDefinition(type).seed ?? {},
      };
      const result = validateGraph({
        nodes: [entry, node, end],
        edges: [],
        groups: [],
      } as WorkflowGraph);
      expect(
        result.issues.some((i) => i.code === 'PLACEHOLDER_CONFIG' && i.nodeId === 'n_x'),
        `${type} 的占位值没被认出来`,
      ).toBe(true);
    }
  });
});
