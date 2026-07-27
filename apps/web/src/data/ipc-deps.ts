/**
 * ipc.ts 的依赖出口。
 *
 * 单独一层是为了让 ipc.ts 能在 node 环境下被测试直接引入——
 * 从 @aiwf/client-core 拿 Transport 类型会连带拉进 React 相关的模块。
 */
export { CoreApiError, ERROR_CODES, type CoreApiMethod, type ErrorCode } from '@aiwf/contracts';
export type { Transport } from '@aiwf/client-core';
