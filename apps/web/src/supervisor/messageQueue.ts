/**
 * 主管 AI 的待发消息队列。
 *
 * ## 为什么需要它
 *
 * agent 正在答一轮时，用户打的字**被直接丢弃** —— `send()` 首行
 * `if (!text || busy) return`，输入框还被禁掉。用户想补一句
 * 「等等，改成 X」只能干等几十秒，等完还得自己重打一遍。
 *
 * ## 为什么是「队列」而不是「直接插话」
 *
 * ACP 有 `_session/steering`（实测两端都返回 `outcome: injected`，
 * 见 docs/acp/08-runtime-abstraction.md）—— 但它是**插进当前这一轮**，
 * 会抢占 agent 正在做的事。那是一种有用的能力，不是默认行为：
 *
 * - 大多数补充是「顺带说一句」，等这轮答完再发更合理
 * - 插话在 claude 侧会让被抢占那轮以 `-32603` 结束，代价不小
 *
 * 所以默认排队、显式插话。而排队的直接好处正是用户要的那两条：
 * **还没发出去的消息就在前端，可以改、可以撤。**
 *
 * ## 状态
 *
 * 队列项只有一种状态（等待发送）。发出去的那一刻它就离开队列变成
 * 对话里的一条消息 —— 不存「已发送」的历史，那份历史本来就在消息列表里。
 */

export interface QueuedMessage {
  id: string;
  text: string;
  /**
   * 发出去的方式。
   *
   * - `queue`：等当前这一轮结束，作为新的一轮发（默认）
   * - `steer`：立刻插进当前这一轮（`_session/steering`）
   *
   * 存在项上而不是发送时再问：用户按下「插话」的那一刻就决定了意图，
   * 而队列可能排了好几条 —— 到时候一条条问「这条要插还是要排」很荒谬。
   */
  mode: 'queue' | 'steer';
}

/** 一条待发消息最长多少字。与输入框的限制一致，超了就不是「补一句」了。 */
export const QUEUE_TEXT_MAX = 4000;

/** 队列最多排几条。排太多说明用户在自言自语，而 agent 一条都还没看到。 */
export const QUEUE_MAX = 10;

export interface EnqueueResult {
  ok: boolean;
  queue: QueuedMessage[];
  /** 拒绝时给人看的一句话。 */
  reason?: string;
}

/**
 * 入队。
 *
 * 空串与超长直接拒 —— 前者是误触，后者会让「补一句」变成另一轮对话，
 * 而队列里的东西用户看不全（那一栏是窄的）。
 */
export function enqueue(
  queue: readonly QueuedMessage[],
  text: string,
  mode: QueuedMessage['mode'],
  makeId: () => string,
): EnqueueResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, queue: [...queue], reason: '空消息' };
  if (trimmed.length > QUEUE_TEXT_MAX) {
    return {
      ok: false,
      queue: [...queue],
      reason: `一条最多 ${QUEUE_TEXT_MAX} 字，这条有 ${trimmed.length} 字 —— 太长的话拆成两条，或者等这轮答完再问`,
    };
  }
  if (queue.length >= QUEUE_MAX) {
    return {
      ok: false,
      queue: [...queue],
      reason: `已经排了 ${QUEUE_MAX} 条，agent 一条都还没看到 —— 先等它答完这轮`,
    };
  }
  return { ok: true, queue: [...queue, { id: makeId(), text: trimmed, mode }] };
}

/** 撤回一条。发出去之前用户随时可以反悔 —— 这是队列存在的一半理由。 */
export function remove(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((item) => item.id !== id);
}

/**
 * 改一条的内容。
 *
 * 改成空串等于撤回 —— 留一条空消息在队列里，发出去的时候会被后端拒，
 * 而那时用户已经不记得自己清空过它。
 */
export function edit(queue: readonly QueuedMessage[], id: string, text: string): QueuedMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return remove(queue, id);
  return queue.map((item) =>
    item.id === id ? { ...item, text: trimmed.slice(0, QUEUE_TEXT_MAX) } : item,
  );
}

/** 队列里的下一条 —— 一轮结束时发它。 */
export function next(queue: readonly QueuedMessage[]): QueuedMessage | undefined {
  return queue[0];
}

/** 全部清空。取消当前轮时用：那些消息是针对已经不存在的上下文说的。 */
export function clear(): QueuedMessage[] {
  return [];
}
