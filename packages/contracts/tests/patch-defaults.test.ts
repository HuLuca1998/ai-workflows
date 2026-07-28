import { describe, expect, it } from 'vitest';
import { getMethodSpec } from '../src/api.js';
import type { CoreApiMethod } from '../src/api.js';

/**
 * patch 类入参不能把缺席字段填成默认值。
 *
 * `Schema.partial()` 让字段变可选，但**不会去掉 `.default()`** ——
 * 缺席时 Zod 照样填默认值。于是界面只发 `{id, ver, goal}`，
 * 校验之后变成 `{id, ver, goal, persona: '', tools: [], outputContract: ''…}`，
 * 后端 COALESCE 收到的是空字符串而不是 NULL，照写。
 *
 * codex 亲手踩到：新建 Agent 时填了「性格与指令」，之后只改「目标」
 * 点保存，那段指令**被清空了**。静默数据丢失 —— 用户只有刷新之后
 * 才会发现，而那时原文已经没了。
 */

/** 这些方法是「只发改过的字段」的语义，缺席必须真的缺席。 */
const PATCH_METHODS: CoreApiMethod[] = [
  'agent.update',
  'prompt.update',
  'model.update',
  'memory.update',
  'workspace.updateSettings',
];

describe('缺席的字段不能被填出来', () => {
  for (const method of PATCH_METHODS) {
    it(`${method} 只带必填项时，不该冒出别的字段`, () => {
      const spec = getMethodSpec(method);
      // 每个方法的必填项不同，逐个试最小入参
      const 最小: Record<string, unknown> = {};
      const shape = (spec.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      if ('id' in shape) 最小['id'] = 'x_1';
      if ('ver' in shape) 最小['ver'] = 1;

      const parsed = spec.input.safeParse(最小);
      expect(parsed.success, `最小入参过不了校验：${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.success) return;

      const 多出来的 = Object.keys(parsed.data as object).filter((key) => !(key in 最小));
      expect(
        多出来的,
        `这些字段没发却被填了默认值，后端会把它们当成「用户要改成这个」：${多出来的.join('、')}`,
      ).toEqual([]);
    });
  }
});

describe('发了的字段照旧生效', () => {
  it('agent.update 带上 persona 时它要过得去', () => {
    const result = getMethodSpec('agent.update').input.safeParse({
      id: 'agent_1',
      ver: 2,
      persona: '简洁、谨慎',
    });
    expect(result.success).toBe(true);
    expect(result.success && (result.data as { persona?: string }).persona).toBe('简洁、谨慎');
  });

  it('显式发空串仍然是「改成空」—— 那是用户的意思', () => {
    const result = getMethodSpec('agent.update').input.safeParse({
      id: 'agent_1',
      ver: 2,
      persona: '',
    });
    expect(result.success).toBe(true);
    expect(result.success && (result.data as { persona?: string }).persona).toBe('');
  });
});
