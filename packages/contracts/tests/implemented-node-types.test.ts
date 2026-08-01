import { describe, expect, it } from 'vitest';
import { NODE_TYPES, IMPLEMENTED_NODE_TYPES, getNodeDefinition } from '../src/index.js';

/**
 * 「引擎真的能跑哪几种节点」必须在契约里，而不是只在
 * `crates/engine/src/preflight.rs` 的一个 Rust 常量里。
 *
 * 现状（第三方巡检 B-06 实测）：节点库照常列出 16 种、拖得进画布、
 * 配置表单字段齐全可填可存，**只字不提其中 6 种跑不了** ——
 * 只有点了「运行」之后 Dry Run 才说「branch 尚未实现，运行会在这个节点停下」。
 * 用户已经搭完整条流程了。
 *
 * 违反的是纪律二的第三种形态：界面承诺了一件事，实现里没有对应代码。
 * 把清单挪进契约，UI 才可能在**拖之前**就说清楚。
 */

describe('未实现的节点类型要在契约里说出来', () => {
  it('每个节点定义都表态自己实现没实现', () => {
    for (const type of NODE_TYPES) {
      expect(
        typeof getNodeDefinition(type).implemented,
        `${type} 没说自己实现没实现 —— 界面据此标注，漏一个就是一个假承诺`,
      ).toBe('boolean');
    }
  });

  it('IMPLEMENTED_NODE_TYPES 与各定义的表态一致', () => {
    const fromDefinitions = NODE_TYPES.filter((type) => getNodeDefinition(type).implemented);
    expect([...IMPLEMENTED_NODE_TYPES].sort()).toEqual([...fromDefinitions].sort());
  });

  it('已实现的那几种就是引擎 executor 真的分派的那几种', () => {
    // 这份期望是照着 crates/engine/src/preflight.rs 的 IMPLEMENTED 写的。
    // 两边不一致时，Rust 侧的 contract_sync_test 会红 —— 这里守的是
    // 「契约自己别乱改」：把一个没实现的标成已实现，是最难发现的谎
    expect([...IMPLEMENTED_NODE_TYPES].sort()).toEqual(
      [
        'ai.analyze',
        'ai.decide',
        'ai.execute',
        'ai.review',
        'approval',
        'end',
        'entry',
        'git.worktree',
        'notify',
        'script.shell',
      ].sort(),
    );
  });

  it('确实有未实现的 —— 全标 true 说明有人图省事', () => {
    const unimplemented = NODE_TYPES.filter((type) => !getNodeDefinition(type).implemented);
    expect(unimplemented.length).toBeGreaterThan(0);
    // 这几种在 DEBT O-1 里记着
    expect(unimplemented).toContain('branch');
    expect(unimplemented).toContain('subworkflow');
  });
});
