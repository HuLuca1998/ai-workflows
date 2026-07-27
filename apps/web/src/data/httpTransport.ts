import { CoreApiError, type CoreApiMethod } from '@aiwf/contracts';
import {
  fromIpcResult,
  ipcCommandFor,
  normalizeIpcError,
  toIpcInput,
  type Transport,
} from '@aiwf/client-core';

/**
 * 开发用 HTTP 传输：让浏览器里的 Web 形态连上真实引擎（aiwf-devserver）。
 *
 * 复用与桌面完全相同的入参 / 出参转换（`ipc.ts`），所以两端的形状不会分叉。
 * 差别只有一处：怎么把命令送出去。
 *
 * **只用于本地开发与端到端测试**。生产的 Web 形态（M6）走 tRPC + SSE + 鉴权。
 */
export function createHttpTransport(baseUrl: string): Transport {
  return {
    async call(method: CoreApiMethod, input: unknown) {
      const command = ipcCommandFor(method);
      if (!command) {
        throw new CoreApiError({
          code: 'INTERNAL',
          message: `${method} 尚未接通引擎`,
          hint: '该方法所属的能力还没实现，见 docs/ROADMAP.md 的里程碑安排',
        });
      }

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/ipc/${command}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toIpcInput(method, input)),
        });
      } catch (error) {
        // 连不上开发服务是最常见的情况，直接说清楚怎么起它
        throw new CoreApiError({
          code: 'INTERNAL',
          message: `连不上开发服务 ${baseUrl}`,
          hint: '先跑 pnpm dev:server 起 aiwf-devserver',
          details: error,
        });
      }

      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw normalizeIpcError(payload);
      return fromIpcResult(method, payload);
    },

    subscribeEvents() {
      // 事件推送在 M6 随远程引擎一起做；现在界面靠轮询
      return () => {};
    },
  };
}
