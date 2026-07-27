import { describe, expect, it } from 'vitest';
import {
  NODE_STATUSES,
  RUN_STATUSES,
  canTransitionNode,
  canTransitionRun,
  isNodeTerminal,
  isRunResumable,
  isRunTerminal,
  nextAttempt,
  type NodeStatus,
  type RunStatus,
} from '../src/state-machine.js';

/**
 * 状态机是「可解释优先」的地基：任何时刻都要能回答「现在跑到哪、为什么停」。
 * 这里锁死合法迁移，引擎与 UI 都不许自行发明状态。
 */

describe('Run 状态机', () => {
  it('状态集合与技术选型 §13 一致', () => {
    expect([...RUN_STATUSES].sort()).toEqual(
      [
        'cancelled',
        'created',
        'failed',
        'interrupted',
        'paused',
        'preflight',
        'queued',
        'resuming',
        'running',
        'succeeded',
        'waiting_approval',
      ].sort(),
    );
  });

  it('主干路径合法', () => {
    const path: RunStatus[] = ['created', 'preflight', 'queued', 'running', 'succeeded'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionRun(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('审批等待与恢复路径合法', () => {
    expect(canTransitionRun('running', 'waiting_approval')).toBe(true);
    expect(canTransitionRun('waiting_approval', 'running')).toBe(true);
    // 杀掉 App：running / waiting_approval 都会落到 interrupted，重启后经 resuming 回到 running
    expect(canTransitionRun('waiting_approval', 'interrupted')).toBe(true);
    expect(canTransitionRun('interrupted', 'resuming')).toBe(true);
    expect(canTransitionRun('resuming', 'running')).toBe(true);
  });

  it('不能跳过 preflight 直接开跑', () => {
    expect(canTransitionRun('created', 'running')).toBe(false);
    expect(canTransitionRun('created', 'queued')).toBe(false);
  });

  it('preflight 失败直接进 failed，不进队列', () => {
    expect(canTransitionRun('preflight', 'failed')).toBe(true);
    expect(canTransitionRun('preflight', 'running')).toBe(false);
  });

  it('终态没有出边', () => {
    for (const terminal of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(isRunTerminal(terminal)).toBe(true);
      for (const to of RUN_STATUSES) {
        expect(canTransitionRun(terminal, to)).toBe(false);
      }
    }
  });

  it('任何非终态都能被取消（用户永远能叫停）', () => {
    for (const status of RUN_STATUSES) {
      if (isRunTerminal(status)) continue;
      expect(canTransitionRun(status, 'cancelled')).toBe(true);
    }
  });

  it('可恢复状态就是重启后要在列表顶部提示的那几种', () => {
    expect(RUN_STATUSES.filter(isRunResumable).sort()).toEqual(
      ['interrupted', 'paused', 'waiting_approval'].sort(),
    );
  });
});

describe('Node 状态机', () => {
  it('状态集合与技术选型 §13 一致', () => {
    expect([...NODE_STATUSES].sort()).toEqual(
      [
        'cancelled',
        'failed',
        'idle',
        'queued',
        'running',
        'skipped',
        'succeeded',
        'waiting',
      ].sort(),
    );
  });

  it('主干路径合法', () => {
    const path: NodeStatus[] = ['idle', 'queued', 'running', 'succeeded'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionNode(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('waiting 用于审批与汇聚等待，可回到 running', () => {
    expect(canTransitionNode('running', 'waiting')).toBe(true);
    expect(canTransitionNode('waiting', 'running')).toBe(true);
  });

  it('failed 可以重试回队列——这是「从失败节点重试」的依据', () => {
    expect(canTransitionNode('failed', 'queued')).toBe(true);
    expect(isNodeTerminal('failed')).toBe(false);
  });

  it('succeeded / cancelled / skipped 是终态', () => {
    for (const terminal of ['succeeded', 'cancelled', 'skipped'] as const) {
      expect(isNodeTerminal(terminal)).toBe(true);
      for (const to of NODE_STATUSES) {
        expect(canTransitionNode(terminal, to)).toBe(false);
      }
    }
  });

  it('每次重试产生新 attempt，从 1 起', () => {
    expect(nextAttempt(undefined)).toBe(1);
    expect(nextAttempt(1)).toBe(2);
    expect(() => nextAttempt(0)).toThrow();
  });
});
