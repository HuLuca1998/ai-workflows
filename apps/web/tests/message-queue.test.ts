import { describe, expect, it } from 'vitest';
import {
  QUEUE_MAX,
  QUEUE_TEXT_MAX,
  clear,
  edit,
  enqueue,
  next,
  remove,
  type QueuedMessage,
} from '../src/supervisor/messageQueue.js';

/**
 * 待发消息队列。
 *
 * 用户报的：「别的工具都有用户消息队列，可以撤回，或者在 ai 读之前可以修改」。
 * 而这个应用现在是 —— agent 忙时打的字**直接丢弃**
 * （`SupervisorDrawer.tsx` 的 `send()` 首行 `if (!text || busy) return`），
 * 输入框还被禁掉。
 *
 * 队列的两条核心能力就是「还没发出去 → 能改、能撤」。
 */

let counter = 0;
const makeId = () => `q_${(counter += 1)}`;

const 空队列: QueuedMessage[] = [];

describe('入队', () => {
  it('排在末尾 —— 用户按顺序说的话要按顺序到', () => {
    const a = enqueue(空队列, '第一句', 'queue', makeId);
    const b = enqueue(a.queue, '第二句', 'queue', makeId);
    expect(b.queue.map((item) => item.text)).toEqual(['第一句', '第二句']);
  });

  it('去掉首尾空白 —— 用户按回车前多打的空格不该进对话', () => {
    const result = enqueue(空队列, '  带空格  ', 'queue', makeId);
    expect(result.queue[0]!.text).toBe('带空格');
  });

  it('空消息不入队', () => {
    expect(enqueue(空队列, '   ', 'queue', makeId).ok).toBe(false);
  });

  it('记住是「排队」还是「插话」—— 那是按下按钮那一刻的意图', () => {
    const result = enqueue(空队列, '停一下', 'steer', makeId);
    expect(result.queue[0]!.mode).toBe('steer');
  });

  it('超长拒绝并说清多了多少', () => {
    const 太长 = 'x'.repeat(QUEUE_TEXT_MAX + 1);
    const result = enqueue(空队列, 太长, 'queue', makeId);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(String(QUEUE_TEXT_MAX));
    expect(result.queue).toHaveLength(0);
  });

  it('排满了不再收 —— agent 一条都没看到时排 20 条没有意义', () => {
    let queue: QueuedMessage[] = [];
    for (let i = 0; i < QUEUE_MAX; i += 1) {
      queue = enqueue(queue, `第 ${i} 条`, 'queue', makeId).queue;
    }
    const result = enqueue(queue, '再来一条', 'queue', makeId);
    expect(result.ok).toBe(false);
    expect(result.queue).toHaveLength(QUEUE_MAX);
  });

  it('不改原数组 —— 状态更新要靠新引用，改原地 React 看不见', () => {
    const before = enqueue(空队列, 'a', 'queue', makeId).queue;
    const after = enqueue(before, 'b', 'queue', makeId).queue;
    expect(before).toHaveLength(1);
    expect(after).not.toBe(before);
  });
});

describe('撤回', () => {
  it('删掉指定那条，其余不动', () => {
    const q1 = enqueue(空队列, 'a', 'queue', makeId).queue;
    const q2 = enqueue(q1, 'b', 'queue', makeId).queue;
    const q3 = enqueue(q2, 'c', 'queue', makeId).queue;

    const after = remove(q3, q3[1]!.id);
    expect(after.map((item) => item.text)).toEqual(['a', 'c']);
  });

  it('删一个不存在的 id 不炸也不改', () => {
    const q = enqueue(空队列, 'a', 'queue', makeId).queue;
    expect(remove(q, '不存在')).toEqual(q);
  });
});

describe('发出去之前能改', () => {
  it('改内容', () => {
    const q = enqueue(空队列, '原来的', 'queue', makeId).queue;
    const after = edit(q, q[0]!.id, '改过的');
    expect(after[0]!.text).toBe('改过的');
  });

  it('改成空等于撤回 —— 留一条空消息在队列里，发出去会被后端拒', () => {
    const q = enqueue(空队列, '原来的', 'queue', makeId).queue;
    expect(edit(q, q[0]!.id, '   ')).toHaveLength(0);
  });

  it('改的时候也守长度上限', () => {
    const q = enqueue(空队列, 'a', 'queue', makeId).queue;
    const after = edit(q, q[0]!.id, 'x'.repeat(QUEUE_TEXT_MAX + 500));
    expect(after[0]!.text).toHaveLength(QUEUE_TEXT_MAX);
  });

  it('改一条不动别的', () => {
    const q1 = enqueue(空队列, 'a', 'queue', makeId).queue;
    const q2 = enqueue(q1, 'b', 'queue', makeId).queue;
    const after = edit(q2, q2[0]!.id, 'A');
    expect(after.map((item) => item.text)).toEqual(['A', 'b']);
  });
});

describe('取下一条与清空', () => {
  it('先进先出', () => {
    const q1 = enqueue(空队列, '先', 'queue', makeId).queue;
    const q2 = enqueue(q1, '后', 'queue', makeId).queue;
    expect(next(q2)?.text).toBe('先');
  });

  it('空队列没有下一条', () => {
    expect(next(空队列)).toBeUndefined();
  });

  it('清空是彻底的 —— 取消当前轮时那些话是针对已经没了的上下文说的', () => {
    expect(clear()).toEqual([]);
  });
});
