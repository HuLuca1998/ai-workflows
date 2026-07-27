import {
  CoreApiError,
  ERROR_CODES,
  getMethodSpec,
  requiredScope,
  type CoreApiMethod,
  type ErrorCode,
  type Scope,
} from '@aiwf/contracts';
import type { Transport } from './transport.js';

/**
 * Core API 客户端。
 *
 * 它不是一层薄封装：入参在本地先按契约校验、Scope 在本地先判、
 * 出参也要过一次校验——引擎返回不合契约时，界面应该立刻知道是实现 bug，
 * 而不是渲染出一个似是而非的画面。
 */

export interface CoreApiClientOptions {
  /**
   * 本次会话被授予的 Scope。不传表示本地 UI（不做 Scope 限制）；
   * MCP / HTTP 调用方必须传，越权在这里就被挡下。
   */
  grantedScopes?: readonly Scope[];
}

export class CoreApiClient {
  private readonly transport: Transport;
  private readonly grantedScopes: readonly Scope[] | undefined;

  constructor(transport: Transport, options: CoreApiClientOptions = {}) {
    this.transport = transport;
    this.grantedScopes = options.grantedScopes;
  }

  async call(method: CoreApiMethod, input: unknown): Promise<unknown> {
    const spec = getMethodSpec(method);
    const scope = requiredScope(method);

    if (this.grantedScopes) {
      // scope 为 null 表示仅本地 UI 可调用：远端调用方无论授予什么都不放行
      if (scope === null || !this.grantedScopes.includes(scope)) {
        throw new CoreApiError({
          code: 'PERMISSION',
          message: `方法 ${method} 需要 ${scope ?? '本地 UI'} 权限`,
          hint: scope ? `在会话中申请 ${scope} 后重试` : '该操作只能由用户在应用内触发',
        });
      }
    }

    const parsedInput = spec.input.safeParse(input);
    if (!parsedInput.success) {
      throw new CoreApiError({
        code: 'VALIDATION',
        message: `${method} 的入参不合契约`,
        details: parsedInput.error.issues,
        hint: '按 @aiwf/contracts 的方法签名修正入参',
      });
    }

    let raw: unknown;
    try {
      raw = await this.transport.call(method, parsedInput.data);
    } catch (error) {
      throw normalizeError(error, method);
    }

    const parsedOutput = spec.output.safeParse(raw);
    if (!parsedOutput.success) {
      throw new CoreApiError({
        code: 'INTERNAL',
        message: `${method} 的返回值不合契约`,
        details: parsedOutput.error.issues,
        hint: '这是引擎侧实现与契约不一致，请提 issue 而不是在界面里兼容',
      });
    }
    return parsedOutput.data;
  }

  subscribeEvents(
    runId: string,
    fromSeq: number,
    onEvents: Parameters<Transport['subscribeEvents']>[2],
  ): () => void {
    return this.transport.subscribeEvents(runId, fromSeq, onEvents);
  }
}

/** 跨进程传来的错误是纯对象；还原成 CoreApiError，界面只处理一种错误类型。 */
function normalizeError(error: unknown, method: string): CoreApiError {
  if (error instanceof CoreApiError) return error;

  if (error && typeof error === 'object' && 'code' in error) {
    const candidate = error as { code: unknown; message?: unknown; retriable?: unknown; hint?: unknown };
    const code = ERROR_CODES.find((c) => c === candidate.code);
    if (code) {
      return new CoreApiError({
        code: code as ErrorCode,
        message: typeof candidate.message === 'string' ? candidate.message : `${method} 调用失败`,
        ...(typeof candidate.retriable === 'boolean' ? { retriable: candidate.retriable } : {}),
        ...(typeof candidate.hint === 'string' ? { hint: candidate.hint } : {}),
      });
    }
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new CoreApiError({
    code: 'INTERNAL',
    message: `${method} 调用失败：${detail}`,
    details: error,
  });
}
