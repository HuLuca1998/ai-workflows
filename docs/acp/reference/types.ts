/**
 * 归一化的 agent 事件与接口定义。
 * 与具体 runtime 解耦：ACP 家族（claude/codex）和将来可能的 HTTP-API 家族
 * 都翻译成这一套事件，上层业务只依赖这里。
 */

/** 归一化 agent 事件：ACP 的 session/update 私有格式都翻译成它。 */
export type AgentEvent =
  | { kind: "message-chunk"; text: string }
  | { kind: "thought-chunk"; text: string }
  | {
      kind: "tool-call";
      id: string;
      title: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      /** 工具调用参数（从 runtime raw 的 rawInput 提取，非标准字段但确实存在） */
      input?: unknown;
      /** 工具调用结果（rawOutput 或 content） */
      output?: unknown;
      toolKind?: string;
      raw?: unknown;
    }
  | {
      kind: "permission-request";
      id: string;
      toolCall: unknown;
      options: Array<{ optionId: string; name: string; kind: string }>;
    }
  | { kind: "permission-decision"; id: string; outcome: string; optionId?: string }
  | { kind: "plan"; raw: unknown }
  /** turn 结束。新版 runtime（claude-agent-acp 0.62+）会带 token 计量与成本。 */
  | { kind: "done"; stopReason: string; usage?: TokenUsage; cost?: Cost }
  | { kind: "error"; message: string; raw?: unknown };

/** session/prompt 响应里的 token 计量。旧版本（0.16.x）没有这个字段。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 缓存命中的读取量——通常远大于 inputTokens，算成本时要按缓存价计 */
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
}

/** runtime 直接给出的美元成本，不用自己按价目表换算。 */
export interface Cost {
  amount: number;
  currency: string;
}

export interface CreateSessionInput {
  /** 必须是已存在的绝对路径。agent 不参与选择 cwd。 */
  cwd: string;
  mcpServers?: unknown[];
}

export interface AgentSession {
  sessionId: string;
  /** runtime 注册表 id，如 "claude-code" / "codex" */
  runtimeId: string;
}

export interface AgentTurnRequest {
  prompt: string;
}

export interface AgentAdapter {
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  runTurn(sessionId: string, request: AgentTurnRequest): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}
