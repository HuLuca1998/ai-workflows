/**
 * 统一错误对象（技术选型 §11）：{code, message, retriable, hint}。
 * IPC、tRPC、MCP 三个出口共用同一套错误码，界面才能给出一致的处置建议。
 */

export const ERROR_CODES = [
  'VALIDATION',
  'PERMISSION',
  'REVISION_CONFLICT',
  'RUNTIME',
  'TIMEOUT',
  'EXTERNAL',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 默认可重试性：冲突与超时值得再试一次，权限与校验错误重试没有意义。 */
const DEFAULT_RETRIABLE: Record<ErrorCode, boolean> = {
  VALIDATION: false,
  PERMISSION: false,
  REVISION_CONFLICT: true,
  RUNTIME: true,
  TIMEOUT: true,
  EXTERNAL: true,
  INTERNAL: false,
};

export interface CoreApiErrorInit {
  code: ErrorCode;
  message: string;
  /** 给用户的下一步建议，界面直接展示。 */
  hint?: string;
  retriable?: boolean;
  details?: unknown;
}

export class CoreApiError extends Error {
  readonly code: ErrorCode;
  readonly retriable: boolean;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(init: CoreApiErrorInit) {
    super(init.message);
    this.name = 'CoreApiError';
    this.code = init.code;
    this.retriable = init.retriable ?? DEFAULT_RETRIABLE[init.code];
    this.hint = init.hint;
    this.details = init.details;
  }

  /** 序列化成跨进程传输的纯对象（Tauri IPC / SSE / MCP 都走这个形状）。 */
  toJSON(): { code: ErrorCode; message: string; retriable: boolean; hint?: string; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
