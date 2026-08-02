import { describe, expect, it } from 'vitest';
import { applyPatch } from '../src/patch.js';
import { IMPLEMENTED_NODE_TYPES } from '../src/nodes/index.js';
import { WORKFLOW_TEMPLATES } from '../src/templates/index.js';
import type { WorkflowGraph } from '../src/graph.js';

/**
 * 引擎实现了的节点类型，内置模板里要有人用。
 *
 * 为什么这条值得守：**模板是这些节点唯一被端到端跑过的地方**。
 * 单测能证明「executor 收到这个节点会做事」，证明不了
 * 「它在一条真实流程里拿得到上游的输出、下游接得住它的输出」——
 * 而那正是这个仓库最常见的缺陷形态（契约、界面、引擎各自绿灯，
 * 接缝处断掉）。
 *
 * 一个实现了却没有任何模板用的节点类型，等于**从来没有人
 * 把它接在别的节点中间跑过**。
 */

const 白名单: Record<string, string> = {
  // 子工作流节点要填一个**用户工作区里的** workflowId，
  // 而内置模板发出去时那个 id 还不存在（模板之间不能互相引用：
  // 模板是「怎么搭一张图」的操作序列，不是已经落库的工作流）。
  // 填占位值的话 PLACEHOLDER_CONFIG 会警告，等于出厂就带一条黄灯。
  //
  // 它的端到端覆盖在 `crates/engine/tests/subworkflow_test.rs`：
  // 那里现建两条工作流再互相调用，是模板做不到的事。
  subworkflow:
    '内置模板引用不了「用户工作区里的另一条工作流」—— ' +
    '端到端覆盖在 crates/engine/tests/subworkflow_test.rs',
};

function 模板里用到的类型(): Set<string> {
  const used = new Set<string>();
  const empty: WorkflowGraph = { nodes: [], edges: [], groups: [] };
  for (const template of WORKFLOW_TEMPLATES) {
    const { graph } = applyPatch(empty, 0, {
      baseRevision: 0,
      operations: template.operations,
    });
    for (const node of graph.nodes) used.add(node.type);
  }
  return used;
}

describe('内置模板对已实现节点的覆盖', () => {
  it('引擎实现了的每一种，都有模板在用', () => {
    const used = 模板里用到的类型();
    const 没人用 = IMPLEMENTED_NODE_TYPES.filter((type) => !used.has(type) && !(type in 白名单));
    expect(
      没人用,
      '这些节点类型引擎实现了，而没有任何内置模板用它 —— ' +
        '也就是从来没有人把它接在别的节点中间端到端跑过。' +
        '加一条模板用上它，或者进白名单并写明为什么模板表达不了它',
    ).toEqual([]);
  });

  it('白名单每一条都写了理由，且确实是已实现的类型', () => {
    for (const [type, reason] of Object.entries(白名单)) {
      expect(reason.trim().length, `${type} 进了白名单却没写理由`).toBeGreaterThan(10);
      expect(
        IMPLEMENTED_NODE_TYPES,
        `${type} 在白名单里但引擎并没有实现它 —— 白名单该跟着删`,
      ).toContain(type);
    }
  });

  it('白名单里的类型确实没被模板用 —— 用上了就该从白名单删掉', () => {
    const used = 模板里用到的类型();
    for (const type of Object.keys(白名单)) {
      expect(used.has(type), `${type} 已经有模板在用了，从白名单里删掉`).toBe(false);
    }
  });

  it('这条守卫自己会红', () => {
    // 元测试：假装引擎实现了一个没人用的类型，断言上面那条会抓到
    const used = new Set(['entry', 'end']);
    const 假清单 = ['entry', 'end', 'notify'];
    const 没人用 = 假清单.filter((t) => !used.has(t) && !(t in 白名单));
    expect(没人用).toEqual(['notify']);
  });
});
