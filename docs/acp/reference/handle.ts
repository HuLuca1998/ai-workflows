/**
 * 一个 ACP agent 子进程的受控句柄：spawn → 握手 → 会话 → prompt 往返，
 * 并完整记录 update / 权限请求 / fs 调用 / stderr。
 *
 * 这层刻意只做"忠实记录 + 原样转发"，不做业务判断——探针和生产适配器共用它，
 * 记录本身就是可分析的观测数据。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

/**
 * 权限裁决策略。agent 会阻塞等待返回值，所以可以是异步的
 * （比如挂起等用户在 UI 上点确认）——但记得配超时。
 */
export type PermissionPolicy = (
  req: RequestPermissionRequest,
) => RequestPermissionResponse["outcome"] | Promise<RequestPermissionResponse["outcome"]>;

/** 按 option kind 优先级选择的策略工厂。 */
export function preferOption(kinds: string[]): PermissionPolicy {
  return (req) => {
    for (const kind of kinds) {
      const opt = req.options.find((o) => o.kind === kind);
      if (opt) return { outcome: "selected", optionId: opt.optionId };
    }
    const fallback = req.options[0];
    return fallback ? { outcome: "selected", optionId: fallback.optionId } : { outcome: "cancelled" };
  };
}

/** 真实任务用这个：拒绝工具调用会让 agent 拿不到素材、不产出结果。见 03-pitfalls #2。 */
export const allowPolicy: PermissionPolicy = preferOption(["allow_once", "allow_always"]);
/** 只用于探针/隔离性测试。 */
export const rejectPolicy: PermissionPolicy = preferOption(["reject_once", "reject_always"]);

export interface AcpHandleOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 从子进程环境中删除的变量（嵌套会话标记等）。见 03-pitfalls #1。 */
  envRemove?: string[];
  permissionPolicy?: PermissionPolicy;
  /**
   * 声明并服务 client fs capability。
   * 注意：只有 claude 会走这条路，codex 用自带 shell 写文件（见 02-runtime-findings #3）。
   * 在这里做 canonical path guard 可以硬拦截工作区外的读写——但只对 claude 有效。
   */
  serveFs?: {
    readTextFile: (req: ReadTextFileRequest) => Promise<string>;
    writeTextFile: (req: WriteTextFileRequest) => Promise<void>;
  };
  /** 实时通知回调：真流式的关键，不设的话只能等 prompt 返回后批量取 updates。 */
  onUpdate?: (n: SessionNotification) => void;
  /** 权限请求发生时的观测回调（裁决仍由 permissionPolicy 决定）。 */
  onPermission?: (req: RequestPermissionRequest, outcome: RequestPermissionResponse["outcome"]) => void;
}

export class AcpAgentHandle {
  /** 全量记录，供事后分析与探针使用；实时消费请用 onUpdate。 */
  readonly updates: SessionNotification[] = [];
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly permissionOutcomes: RequestPermissionResponse["outcome"][] = [];
  readonly fsCalls: Array<{ method: "read" | "write"; path: string; sessionId: string }> = [];
  readonly stderrChunks: string[] = [];

  private child: ChildProcessWithoutNullStreams;
  private conn: ClientSideConnection;
  private exited: Promise<number | null>;

  constructor(private opts: AcpHandleOptions) {
    // 注意：client 处理器里读 this.opts 是**动态**读取（不是构造时快照），
    // setCallbacks 才能在 turn 之间切换回调。
    const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
    for (const key of opts.envRemove ?? []) delete env[key];

    this.child = spawn(opts.command, opts.args ?? [], { stdio: ["pipe", "pipe", "pipe"], env });

    // stderr 是 agent 崩溃/认证失败/版本错配信息的唯一来源，必须收集。见 03-pitfalls #11。
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderrChunks.push(chunk));

    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );

    const handle = this;
    const client: Client = {
      async requestPermission(req) {
        handle.permissionRequests.push(req);
        const policy = handle.opts.permissionPolicy ?? rejectPolicy;
        const outcome = await policy(req);
        handle.permissionOutcomes.push(outcome);
        handle.opts.onPermission?.(req, outcome);
        return { outcome };
      },
      async sessionUpdate(n) {
        handle.updates.push(n);
        handle.opts.onUpdate?.(n);
      },
      ...(opts.serveFs
        ? {
            async readTextFile(req: ReadTextFileRequest) {
              handle.fsCalls.push({ method: "read", path: req.path, sessionId: req.sessionId });
              return { content: await handle.opts.serveFs!.readTextFile(req) };
            },
            async writeTextFile(req: WriteTextFileRequest) {
              handle.fsCalls.push({ method: "write", path: req.path, sessionId: req.sessionId });
              await handle.opts.serveFs!.writeTextFile(req);
              return {};
            },
          }
        : {}),
    };

    this.conn = new ClientSideConnection(() => client, stream);
  }

  /**
   * 按 turn 切换实时回调。
   * 回调是 per-turn 的（每个 runTurn 装上、结束时卸下），所以不能只在构造时传。
   * 传空对象即卸载。
   */
  setCallbacks(cb: Pick<AcpHandleOptions, "onUpdate" | "onPermission">): void {
    const next: AcpHandleOptions = { ...this.opts };
    delete next.onUpdate;
    delete next.onPermission;
    if (cb.onUpdate) next.onUpdate = cb.onUpdate;
    if (cb.onPermission) next.onPermission = cb.onPermission;
    this.opts = next;
  }

  /** 握手：协商协议版本、声明 client capability、拿到 agent capability 与 authMethods。 */
  async initialize(): Promise<InitializeResponse> {
    return this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: Boolean(this.opts.serveFs),
          writeTextFile: Boolean(this.opts.serveFs),
        },
        terminal: false,
      },
    });
  }

  /** cwd 必须是已存在的绝对路径。返回值里的 modes 含权限/沙箱档位。 */
  async newSession(cwd: string, mcpServers: never[] = []): Promise<NewSessionResponse> {
    return this.conn.newSession({ cwd, mcpServers });
  }

  /** 跨进程恢复：历史会以 *_message_chunk 通知形式完整回放。需要同时提供原 cwd。 */
  async loadSession(sessionId: string, cwd: string, mcpServers: never[] = []): Promise<LoadSessionResponse> {
    return this.conn.loadSession({ sessionId, cwd, mcpServers });
  }

  /** 阻塞到整个 turn 结束才 resolve；turn 期间的内容通过 onUpdate 实时推来。 */
  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.conn.prompt({ sessionId, prompt: [{ type: "text", text }] });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.conn.cancel({ sessionId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.conn.authenticate({ methodId });
  }

  /** 切换权限/沙箱档位（claude: permission mode，codex: sandbox 档位）。 */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.conn.setSessionMode({ sessionId, modeId });
  }

  stderrTail(maxChars = 2000): string {
    return this.stderrChunks.join("").slice(-maxChars);
  }

  /** 先 SIGTERM 等 3 秒，还没退再 SIGKILL——直接 KILL 会丢掉未刷完的输出。 */
  async close(): Promise<number | null> {
    this.child.kill("SIGTERM");
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 3000));
    const code = await Promise.race([this.exited, timeout]);
    if (code === null && this.child.exitCode === null) this.child.kill("SIGKILL");
    return this.child.exitCode;
  }
}

export { RequestError, PROTOCOL_VERSION };
export type { SessionNotification, RequestPermissionRequest, InitializeResponse };
