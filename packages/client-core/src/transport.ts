import type { CoreApiMethod, RunEvent } from '@aiwf/contracts';

/**
 * 传输抽象。
 *
 * 桌面走 Tauri IPC + event channel，Web 走 tRPC over HTTP + SSE；
 * 两端都是「调方法 + 订阅 RunEvent 流」，所以界面代码不感知差异（技术选型 §1）。
 */
export interface Transport {
  call(method: CoreApiMethod, input: unknown): Promise<unknown>;
  /**
   * 订阅某次运行的事件。实现方负责重连；重连后从 fromSeq 之后重发，
   * 重复推送由 EventStore 去重。返回取消订阅的函数。
   */
  subscribeEvents(
    runId: string,
    fromSeq: number,
    onEvents: (events: RunEvent[]) => void,
  ): () => void;
}

/** 测试与 Storybook 用的内存传输：把方法映射成同步函数。 */
export class MemoryTransport implements Transport {
  private readonly handlers: Record<string, (input: unknown) => unknown>;
  private readonly onCall: ((method: string, input: unknown) => void) | undefined;
  private readonly subscribers = new Map<string, ((events: RunEvent[]) => void)[]>();

  constructor(
    handlers: Record<string, (input: unknown) => unknown> = {},
    onCall?: (method: string, input: unknown) => void,
  ) {
    this.handlers = handlers;
    this.onCall = onCall;
  }

  async call(method: CoreApiMethod, input: unknown): Promise<unknown> {
    this.onCall?.(method, input);
    const handler = this.handlers[method];
    if (!handler) {
      throw { code: 'INTERNAL', message: `内存传输未实现方法 ${method}` };
    }
    return handler(input);
  }

  subscribeEvents(runId: string, _fromSeq: number, onEvents: (events: RunEvent[]) => void) {
    const list = this.subscribers.get(runId) ?? [];
    list.push(onEvents);
    this.subscribers.set(runId, list);
    return () => {
      this.subscribers.set(
        runId,
        (this.subscribers.get(runId) ?? []).filter((fn) => fn !== onEvents),
      );
    };
  }

  /** 测试里手动推事件。 */
  emit(runId: string, events: RunEvent[]): void {
    for (const fn of this.subscribers.get(runId) ?? []) fn(events);
  }
}
