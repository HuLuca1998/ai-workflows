import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage, type McpSession } from '../src/stdio.js';

/**
 * MCP 的 stdio 协议层。
 *
 * 工具注册表早就写好了，但没有 server —— Claude Desktop / Claude Code
 * 连不上一个只是「导出了几个函数」的包。这一层把 JSON-RPC 接上。
 *
 * 协议本身是 JSON-RPC 2.0 over stdio：initialize → tools/list → tools/call。
 * 每条消息一行，不能有多余的 stdout 输出 —— 那会把协议流搞乱，
 * 而症状是客户端一言不发地断开。
 */

const call = vi.fn();

function session(): McpSession {
  return {
    client: { call } as never,
    confirmWrite: undefined,
  };
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ items: [] });
});

const request = (method: string, params?: unknown, id: number | string = 1) =>
  handleMessage(session(), { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

describe('握手', () => {
  it('initialize 返回协议版本与工具能力', async () => {
    const response = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        capabilities: { tools: expect.anything() },
        serverInfo: { name: expect.stringContaining('aiwf') },
      },
    });
  });

  it('notifications/initialized 不回消息 —— 通知没有 id 就不该有响应', async () => {
    const response = await handleMessage(session(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(response).toBeNull();
  });
});

describe('工具清单', () => {
  it('tools/list 给出契约派生的清单', async () => {
    // 带上确认才看得到完整清单 —— 只读会话只给只读工具，
    // 那条规则由「写工具的安全默认」那组用例守着
    const response = (await handleMessage(
      { client: { call } as never, confirmWrite: async () => true },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    )) as { result: { tools: { name: string }[] } };

    const names = response.result.tools.map((t) => t.name);
    expect(names).toContain('workflow.list');
    expect(names).toContain('memory.create');
    // 运行与发布首版不开放 —— 那是能直接产生副作用的
    expect(names).not.toContain('run.start');
    expect(names).not.toContain('workflow.publish');
  });

  it('每个工具都带 inputSchema —— 没有它客户端只能瞎猜参数', async () => {
    const response = (await request('tools/list')) as {
      result: { tools: { inputSchema: unknown }[] };
    };
    expect(response.result.tools.every((t) => t.inputSchema !== undefined)).toBe(true);
  });
});

describe('调用工具', () => {
  it('tools/call 转给 Core API 并把结果包成 content', async () => {
    call.mockResolvedValue({ items: [{ id: 'wf_1', name: '流程' }] });
    const response = (await request('tools/call', {
      name: 'workflow.list',
      arguments: {},
    })) as { result: { content: { type: string; text: string }[] } };

    expect(call).toHaveBeenCalledWith('workflow.list', {});
    expect(response.result.content[0]?.type).toBe('text');
    expect(response.result.content[0]?.text).toContain('wf_1');
  });

  it('工具报错时用 isError 而不是 JSON-RPC 错误 —— Agent 要看得到原因才能改', async () => {
    // JSON-RPC 层的 error 在多数客户端里会直接中断对话；
    // isError 的结果仍然进上下文，Agent 能读到「哪个字段不对」再试一次
    call.mockRejectedValue(new Error('baseRevision 对不上'));
    const response = (await handleMessage(
      { client: { call } as never, confirmWrite: async () => true },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'workflow.patch',
          arguments: { workflowId: 'wf_1', baseRevision: 1, operations: [] },
        },
      },
    )) as { result: { isError: boolean; content: { text: string }[] } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toContain('baseRevision');
  });

  it('没暴露的工具被拒 —— 清单之外没有旁路', async () => {
    const response = (await request('tools/call', {
      name: 'run.start',
      arguments: {},
    })) as { result: { isError: boolean; content: { text: string }[] } };

    expect(response.result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('未知方法回 JSON-RPC 错误码 -32601', async () => {
    const response = (await request('nonsense/method')) as { error: { code: number } };
    expect(response.error.code).toBe(-32601);
  });
});

describe('写操作要确认', () => {
  it('confirmWrite 拒绝时不落库', async () => {
    const confirmWrite = vi.fn().mockResolvedValue(false);
    const response = (await handleMessage(
      { client: { call } as never, confirmWrite },
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'memory.create', arguments: { scope: 'workspace', key: 'k', value: 'v' } },
      },
    )) as { result: { isError: boolean } };

    expect(confirmWrite).toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(response.result.isError).toBe(true);
  });

  it('只读工具不问确认 —— 每次 list 都弹一次会让人直接关掉确认', async () => {
    const confirmWrite = vi.fn().mockResolvedValue(true);
    await handleMessage(
      { client: { call } as never, confirmWrite },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'workflow.list' } },
    );
    expect(confirmWrite).not.toHaveBeenCalled();
  });
});

describe('写工具的安全默认', () => {
  it('没有确认机制时，写工具不出现在清单里', async () => {
    // MCP Server 是独立进程，弹不出应用里的确认对话框。
    // 静默放行意味着 AI 能直接改用户的草稿，而「AI 的改动一律先出 Diff」
    // 是这个产品的核心规则 —— 主管 AI 遵守了，MCP 不该例外。
    //
    // 安全默认是「不给写」：要写就得显式接上确认。
    const response = (await handleMessage(
      { client: { call } as never },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    )) as { result: { tools: { name: string }[] } };

    const names = response.result.tools.map((t) => t.name);
    expect(names).toContain('workflow.list');
    expect(names).toContain('workflow.get');
    // 写类工具全部不在
    expect(names).not.toContain('workflow.patch');
    expect(names).not.toContain('workflow.create');
    expect(names).not.toContain('memory.create');
  });

  it('接上确认后写工具才出现', async () => {
    const confirmWrite = vi.fn().mockResolvedValue(true);
    const response = (await handleMessage(
      { client: { call } as never, confirmWrite },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    )) as { result: { tools: { name: string }[] } };

    const names = response.result.tools.map((t) => t.name);
    expect(names).toContain('workflow.patch');
    expect(names).toContain('memory.create');
  });

  it('绕过清单直接调写工具也会被拒 —— 清单之外没有旁路', async () => {
    const response = (await handleMessage(
      { client: { call } as never },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'workflow.patch', arguments: {} },
      },
    )) as { result: { isError: boolean; content: { text: string }[] } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toMatch(/确认|只读/u);
    expect(call).not.toHaveBeenCalled();
  });

  it('只读工具在两种模式下都能用', async () => {
    await handleMessage(
      { client: { call } as never },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workflow.list' } },
    );
    expect(call).toHaveBeenCalledWith('workflow.list', {});
  });
});
