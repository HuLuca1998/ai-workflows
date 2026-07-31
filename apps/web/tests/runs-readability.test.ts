import { describe, expect, it } from 'vitest';
import { RUN_EVENT_TYPES } from '@aiwf/contracts';
import { eventTone, scriptExitTone, toneOfEvent } from '../src/runs/eventTone.js';
import { formatDuration, relativeTime, runDuration } from '../src/runs/formatTime.js';

describe('事件语气', () => {
  it('失败与成功不能同色 —— 这正是它要解决的问题', () => {
    expect(eventTone('node.failed')).toBe('failed');
    expect(eventTone('node.succeeded')).toBe('succeeded');
    expect(eventTone('run.failed')).toBe('failed');
    expect(eventTone('tool.call_failed')).toBe('failed');
  });

  it('一词之差的两个事件不会被前缀猜测归到一起', () => {
    expect(eventTone('system.permission_denied')).toBe('failed');
    expect(eventTone('system.permission_granted')).toBe('neutral');
    expect(eventTone('artifact.truncated')).toBe('warn');
    expect(eventTone('artifact.created')).toBe('neutral');
  });

  it('等待人来处理的事件是「等待」，不是中性', () => {
    expect(eventTone('approval.requested')).toBe('waiting');
    expect(eventTone('node.waiting')).toBe('waiting');
  });

  it('script.exited 按退出码判，判不出就中性 —— 不猜', () => {
    expect(scriptExitTone('退出码 0')).toBe('succeeded');
    expect(scriptExitTone('exit=1')).toBe('failed');
    expect(scriptExitTone('退出码 137')).toBe('failed');
    expect(scriptExitTone('脚本结束')).toBe('neutral');
    expect(toneOfEvent('script.exited', 'exit=0')).toBe('succeeded');
    expect(toneOfEvent('script.exited', 'exit=2')).toBe('failed');
  });

  it('内容型异常也算异常(第 9 轮实测 #5)', () => {
    // 通知发不出去:类型是 notification_sent(中性),摘要说没能发出
    expect(toneOfEvent('system.notification_sent', '通知没能发出（已归档）：这个环境发不了')).toBe(
      'warn',
    );
    expect(toneOfEvent('system.notification_sent', '已发送通知')).not.toBe('warn');
    // 节点走 failed 分支:类型是 node.succeeded,摘要含「走 failed 分支」
    expect(toneOfEvent('node.succeeded', '通知我 完成 · 走 failed 分支')).toBe('warn');
    expect(toneOfEvent('node.succeeded', '完成 · 走 success 分支')).not.toBe('warn');
  });

  it('契约里每个事件类型都能算出语气，且只落在五档里', () => {
    const allowed = ['failed', 'warn', 'succeeded', 'waiting', 'neutral'];
    for (const type of RUN_EVENT_TYPES) {
      expect(allowed, type).toContain(toneOfEvent(type, ''));
    }
  });
});

describe('时间可读性', () => {
  const now = new Date('2026-07-30T12:00:00Z').getTime();

  it('相对时间分档，超过一天退回绝对日期（返回空串由调用方兜）', () => {
    expect(relativeTime('2026-07-30T11:59:30Z', now)).toBe('刚刚');
    expect(relativeTime('2026-07-30T11:30:00Z', now)).toBe('30 分钟前');
    expect(relativeTime('2026-07-30T09:00:00Z', now)).toBe('3 小时前');
    expect(relativeTime('2026-07-20T09:00:00Z', now)).toBe('');
  });

  it('后端时钟稍快时不显示负数', () => {
    expect(relativeTime('2026-07-30T12:00:30Z', now)).toBe('刚刚');
  });

  it('时长最粗到小时', () => {
    expect(formatDuration(3_000)).toBe('3 秒');
    expect(formatDuration(90_000)).toBe('1 分 30 秒');
    expect(formatDuration(120_000)).toBe('2 分');
    expect(formatDuration(3_600_000)).toBe('1 小时');
    expect(formatDuration(5_400_000)).toBe('1 小时 30 分');
  });

  it('还在跑的运行时长算到现在，缺 startedAt 时返回空串而不是 0 秒', () => {
    expect(runDuration('2026-07-30T11:58:00Z', undefined, now)).toBe('2 分');
    expect(runDuration('2026-07-30T11:00:00Z', '2026-07-30T11:05:00Z', now)).toBe('5 分');
    expect(runDuration(undefined, undefined, now)).toBe('');
    expect(runDuration('不是时间', undefined, now)).toBe('');
  });
});
