/**
 * AcpAdapter：把 ACP runtime 包装成统一的 AgentAdapter 接口。
 *
 * 与 PolyCrew 原版的关键区别：**runTurn 是真流式的**。
 * 原版先 await prompt（要等整个 turn 结束）再补发全部事件，AsyncIterable 的外壳
 * 骗了自己——UI 上会白屏几十秒再一次性刷出。这里用 onUpdate 回调 + 异步队列，
 * 事件产生即消费。见 03-pitfalls #7。
 */
import { mkdirSync } from "node:fs";
import {
  AcpAgentHandle,
  rejectPolicy,
  type AcpHandleOptions,
  type PermissionPolicy,
} from "./handle.js";
import { normalizeUpdate } from "./normalize.js";
import { resolveRuntimeCommand, type AcpRuntimeEntry } from "./registry.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentTurnRequest,
  Cost,
  CreateSessionInput,
  TokenUsage,
} from "./types.js";

/** 生产者/消费者队列：让 push 进来的事件被 for-await 立即消费。 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface AcpAdapterOptions {
  permissionPolicy?: PermissionPolicy;
  /** 见 handle.ts：只对 claude 生效，codex 不走 fs 代理。 */
  serveFs?: AcpHandleOptions["serveFs"];
  /** 单个 turn 的超时（毫秒）。超时会 cancel + 结束队列。默认 240s。 */
  promptTimeoutMs?: number;
  /** 握手 + 建会话的超时（毫秒）。默认 60s。 */
  handshakeTimeoutMs?: number;
}

function withTimeout<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export class AcpAdapter implements AgentAdapter {
  private sessions = new Map<string, { handle: AcpAgentHandle; cwd: string }>();

  constructor(
    private entry: AcpRuntimeEntry,
    private policyOrOptions: PermissionPolicy | AcpAdapterOptions = rejectPolicy,
  ) {}

  private get opts(): AcpAdapterOptions {
    return typeof this.policyOrOptions === "function"
      ? { permissionPolicy: this.policyOrOptions }
      : this.policyOrOptions;
  }

  /** 一会话一子进程：隔离彻底、互不影响，代价是进程数要自己管（见 04-recipes 会话池）。 */
  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    mkdirSync(input.cwd, { recursive: true }); // cwd 必须已存在，见 03-pitfalls #8
    const { command, args } = resolveRuntimeCommand(this.entry);
    const handleOpts: AcpHandleOptions = {
      command,
      args,
      envRemove: this.entry.envRemove ?? [],
      permissionPolicy: this.opts.permissionPolicy ?? rejectPolicy,
    };
    if (this.opts.serveFs) handleOpts.serveFs = this.opts.serveFs;
    const handle = new AcpAgentHandle(handleOpts);

    const t = this.opts.handshakeTimeoutMs ?? 60_000;
    try {
      await withTimeout("initialize", t, handle.initialize());
      const s = await withTimeout("newSession", t, handle.newSession(input.cwd));
      this.sessions.set(s.sessionId, { handle, cwd: input.cwd });
      return { sessionId: s.sessionId, runtimeId: this.entry.id };
    } catch (err) {
      // 握手失败时 stderr 里才有真正的原因（认证、嵌套变量、版本错配）
      const tail = handle.stderrTail(600);
      await handle.close();
      throw new Error(`${String(err)}${tail ? `\n--- agent stderr ---\n${tail}` : ""}`);
    }
  }

  /** 跨进程恢复：新建进程 + session/load，历史会以通知形式完整回放。 */
  async resumeSession(sessionId: string, cwd: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return { sessionId, runtimeId: this.entry.id };

    const { command, args } = resolveRuntimeCommand(this.entry);
    const handle = new AcpAgentHandle({
      command,
      args,
      envRemove: this.entry.envRemove ?? [],
      permissionPolicy: this.opts.permissionPolicy ?? rejectPolicy,
    });
    const t = this.opts.handshakeTimeoutMs ?? 60_000;
    const init = await withTimeout("initialize", t, handle.initialize());
    if (!init.agentCapabilities?.loadSession) {
      await handle.close();
      throw new Error("runtime 不支持 session/load，请改为新建会话并用持久化状态重建 prompt");
    }
    await withTimeout("loadSession", this.opts.promptTimeoutMs ?? 240_000, handle.loadSession(sessionId, cwd));
    this.sessions.set(sessionId, { handle, cwd });
    return { sessionId, runtimeId: this.entry.id };
  }

  /** 真流式：事件产生即 yield，不等 turn 结束。 */
  async *runTurn(sessionId: string, request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      yield { kind: "error", message: `unknown session ${sessionId}` };
      return;
    }

    const queue = new AsyncQueue<AgentEvent>();
    let permSeq = 0;
    // 成本出现在通知流里（不在 prompt 响应里），先接住、turn 结束时随 done 一起给出
    let lastCost: Cost | undefined;

    // 装上实时回调——这是流式的关键
    rec.handle.setCallbacks({
      onUpdate: (n) => {
        const cost = (n.update as unknown as { cost?: Cost }).cost;
        if (cost && typeof cost.amount === "number") lastCost = cost;
        const ev = normalizeUpdate(n);
        if (ev) queue.push(ev);
      },
      onPermission: (req, outcome) => {
        const id = String(permSeq++);
        queue.push({
          kind: "permission-request",
          id,
          toolCall: req.toolCall,
          options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        });
        queue.push({
          kind: "permission-decision",
          id,
          outcome: outcome.outcome,
          ...(outcome.outcome === "selected" ? { optionId: outcome.optionId } : {}),
        });
      },
    });

    const timeoutMs = this.opts.promptTimeoutMs ?? 240_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`prompt timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    // 不 await：让 prompt 在后台跑，事件通过队列实时流出
    void Promise.race([rec.handle.prompt(sessionId, request.prompt), timeout])
      .then((resp) => {
        // 新版 runtime 在响应里带 token 计量；旧版没有这个字段，故为可选。
        const ext = resp as unknown as { usage?: TokenUsage };
        queue.push({
          kind: "done",
          stopReason: resp.stopReason,
          ...(ext.usage ? { usage: ext.usage } : {}),
          ...(lastCost ? { cost: lastCost } : {}),
        });
      })
      .catch(async (err) => {
        // 超时不能只 reject：agent 还在后台跑、还在烧钱。见 03-pitfalls #10。
        await rec.handle.cancel(sessionId).catch(() => {});
        queue.push({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        clearTimeout(timer);
        rec.handle.setCallbacks({});
        queue.close();
      });

    yield* queue;
  }

  async cancel(sessionId: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (rec) await rec.handle.cancel(sessionId).catch(() => {});
  }

  /** 切权限/沙箱档位：claude 是 permission mode，codex 是 sandbox 档位。 */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (rec) await rec.handle.setMode(sessionId, modeId);
  }

  async close(sessionId: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (rec) {
      await rec.handle.close();
      this.sessions.delete(sessionId);
    }
  }

  /** 进程退出前批量释放，防子进程泄漏。见 03-pitfalls #4。 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
