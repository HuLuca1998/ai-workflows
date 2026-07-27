/**
 * @aiwf/mcp-server —— 对外 MCP 工具层。
 *
 * 唯一执行写操作的是内部 Core API；这里只做工具发现、Scope 校验与确认流程。
 */

export {
  McpToolRegistry,
  listMcpTools,
  type McpTool,
  type McpToolName,
  type McpToolRegistryOptions,
} from './tools.js';
