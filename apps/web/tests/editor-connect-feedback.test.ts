import { describe, expect, it } from 'vitest';
import { getNodeDefinition } from '@aiwf/contracts';

import { describeConnection } from '../src/editor/connectRules.js';
import { defaultSourcePort, defaultTargetPort } from '../src/editor/graphAdapter.js';

/**
 * 连线被拒时要说一句话，而且**自连要当场拒掉**。
 *
 * 第三方巡检实测的两条：
 *
 * - B-03：从一个节点的右端口拖到**它自己**的左端口，连线被接受，
 *   问题数 +1；而这条自环边渲染成宽度 0 的竖线压在节点底下，
 *   `elementFromPoint` 命中的是端口而不是连线 —— **点不到，删不掉**，
 *   只能删掉整个节点连带丢配置。存进草稿的死结。
 * - B-11：从「结束」拖向「入口设置」，拖拽虚线正常画出、目标端口
 *   还高亮成紫色（跟合法目标一模一样），松手后连线凭空消失，
 *   无 toast 无文案，用户只会以为自己手滑了。
 *
 * 判定抽成纯函数才测得了：`onConnect` 里那几行 early return
 * 只能靠渲染整个画布去验，而 jsdom 不做布局。
 */

const 端口 = (type: Parameters<typeof getNodeDefinition>[0]) => ({
  source: defaultSourcePort(type, getNodeDefinition(type).seed ?? {}),
  target: defaultTargetPort(type),
});

describe('自连当场拒掉', () => {
  it('同一个节点连到自己 —— 拒绝并说明理由', () => {
    const verdict = describeConnection({
      sourceType: 'ai.analyze',
      targetType: 'ai.analyze',
      sameNode: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason, '要说清为什么，不能默默消失').toMatch(/自己|自连|环/u);
  });

  it('不同节点之间的正常连线照常放行', () => {
    const verdict = describeConnection({
      sourceType: 'ai.analyze',
      targetType: 'approval',
      sameNode: false,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe('端口不存在的方向要给理由', () => {
  it('从「结束」往外连 —— 它没有输出端口', () => {
    expect(端口('end').source, 'end 有输出端口的话这条测试的前提就没了').toBeNull();
    const verdict = describeConnection({
      sourceType: 'end',
      targetType: 'entry',
      sameNode: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/结束|输出/u);
  });

  it('连到「入口设置」—— 它没有输入端口', () => {
    expect(端口('entry').target, 'entry 有输入端口的话这条测试的前提就没了').toBeNull();
    const verdict = describeConnection({
      sourceType: 'ai.analyze',
      targetType: 'entry',
      sameNode: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/入口|输入/u);
  });

  it('理由是给人看的一句话，不是错误码', () => {
    const verdict = describeConnection({
      sourceType: 'end',
      targetType: 'entry',
      sameNode: false,
    });
    expect(verdict.reason).not.toMatch(/^[A-Z_]+$/u);
    expect((verdict.reason ?? '').length).toBeGreaterThan(6);
  });
});
