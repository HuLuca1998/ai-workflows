import { describe, expect, it } from 'vitest';
import { summarize } from '../src/editor/graphAdapter.js';
import { describeTrigger } from '@aiwf/contracts';

/**
 * 入口节点在画布上说的那句话。
 *
 * 改这条之前它是 `触发：${c.trigger ?? 'manual'}` —— 把契约的枚举值
 * 原样贴出去，用户看到的是「触发：schedule」，既不知道几点，
 * 也不知道那到底是不是生效了。
 *
 * 现在走契约里的 `describeTrigger`，与工作流列表、与 Rust 调度日志
 * 是同一句话（`crates/engine/tests/trigger_reach_test.rs` 守着两侧一致）。
 */
describe('入口节点的画布摘要', () => {
  it('每天定时说清几点', () => {
    expect(summarize('entry', { trigger: 'schedule', scheduleTime: '09:30' })).toContain(
      '每天 09:30',
    );
  });

  it('间隔触发说清多久一次', () => {
    expect(summarize('entry', { trigger: 'interval', intervalMinutes: 120 })).toContain(
      '每 2 小时',
    );
  });

  it('不把枚举值原样贴给用户', () => {
    const text = summarize('entry', { trigger: 'schedule', scheduleTime: '09:30' });
    expect(text).not.toMatch(/schedule|interval|manual/u);
  });

  it('选了定时却没填时刻时直说不完整，而不是退回「手动」', () => {
    // 退回「手动」会让用户以为自己没设过定时，而实际上是设了没填全
    const text = summarize('entry', { trigger: 'schedule' });
    expect(text).toMatch(/还没填|未填/u);
    expect(text).not.toMatch(/^触发：手动触发$/u);
  });

  it('与契约那份逐字一致 —— 画布与列表不能各说各的', () => {
    for (const config of [
      { trigger: 'manual' },
      { trigger: 'schedule', scheduleTime: '00:00' },
      { trigger: 'interval', intervalMinutes: 45 },
    ]) {
      expect(summarize('entry', config)).toContain(describeTrigger(config));
    }
  });
});
