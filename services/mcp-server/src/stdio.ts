import type { CoreApiClient } from '@aiwf/client-core';
import { CoreApiError, type CoreApiMethod } from '@aiwf/contracts';
import { McpToolRegistry, listMcpTools, type McpTool } from './tools.js';

/**
 * MCP 的 stdio 协议层。
 *
 * 工具注册表本身不知道自己在跟谁说话；这一层把它接到 JSON-RPC 2.0 over stdio，
 * 也就是 Claude Desktop / Claude Code 认的那套。
 *
 * 一条铁律：**stdout 只能有协议消息**。多打一行日志就会把流搞乱，
 * 而症状是客户端一言不发地断开 —— 完全没有线索。所以日志一律走 stderr。
 */

/** MCP 协议版本。客户端会拿它判断能用哪些特性。 */
const PROTOCOL_VERSION = '2024-11-05';

export interface McpSession {
  client: CoreApiClient;
  /** 写操作前的确认。不提供就是「不确认直接写」——只在受信任的场景里这么配。 */
  confirmWrite?: ((tool: McpTool, input: unknown) => Promise<boolean>) | undefined;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: number | string } & (
  { result: unknown } | { error: { code: number; message: string } }
);

/**
 * 处理一条消息，返回要回给客户端的响应。
 *
 * 返回 null 表示「不该回」—— 通知（没有 id 的消息）就是这样，
 * 回了反而会让客户端认为协议出错。
 */
export async function handleMessage(
  session: McpSession,
  message: JsonRpcMessage,
): Promise<JsonRpcResponse | null> {
  const { id, method } = message;

  // 通知没有 id，也不该有响应
  if (id === undefined) return null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aiwf-mcp-server', version: '0.0.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: listMcpTools().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      };

    case 'tools/call':
      return { jsonrpc: '2.0', id, result: await callTool(session, message.params) };

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `未知方法：${method}` },
      };
  }
}

/**
 * 调用一个工具。
 *
 * 失败时返回 `isError: true` 而不是 JSON-RPC 层的 error：
 * 后者在多数客户端里会直接中断对话，而 isError 的结果仍然进上下文 ——
 * Agent 读得到「哪个字段不对」，然后自己改了再试一次。
 */
async function callTool(session: McpSession, params: unknown): Promise<unknown> {
  const { name, arguments: input } = (params ?? {}) as {
    name?: string;
    arguments?: unknown;
  };

  if (!name) {
    return errorResult('tools/call 缺少 name');
  }

  const registry = new McpToolRegistry(
    session.client,
    session.confirmWrite ? { confirmWrite: session.confirmWrite } : {},
  );

  try {
    const result = await registry.call(name as CoreApiMethod, input ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  } catch (error) {
    const message =
      error instanceof CoreApiError
        ? `${error.message}${error.hint ? `（${error.hint}）` : ''}`
        : error instanceof Error
          ? error.message
          : String(error);
    return errorResult(message);
  }
}

function errorResult(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * 把 stdin 上的 JSON-RPC 流接到 handleMessage。
 *
 * 按行切：MCP 用的是 newline-delimited JSON，不是 Content-Length 分帧。
 */
export function serve(
  session: McpSession,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): void {
  let buffer = '';

  stdin.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    // 最后一段可能是半条消息，留到下次
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      void dispatch(session, line, stdout);
    }
  });
}

async function dispatch(
  session: McpSession,
  line: string,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    // 解析不了的行直接丢：回一个 error 也没用 —— 我们连它的 id 都不知道
    process.stderr.write(`[aiwf-mcp] 收到无法解析的消息：${line.slice(0, 120)}\n`);
    return;
  }

  try {
    const response = await handleMessage(session, message);
    if (response) stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    // handleMessage 本身炸了是实现 bug。仍然要回一条 ——
    // 不回的话客户端会一直等着那个 id
    if (message.id !== undefined) {
      stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        })}\n`,
      );
    }
  }
}
