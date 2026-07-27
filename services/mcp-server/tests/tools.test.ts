import { describe, expect, it, vi } from 'vitest';
import { CoreApiClient, MemoryTransport } from '@aiwf/client-core';
import { MCP_FIRST_RELEASE_TOOLS } from '@aiwf/contracts';
import { McpToolRegistry, listMcpTools } from '../src/tools.js';

/**
 * MCP Server 只是 Core API 面向 Agent 的适配层。
 *
 * CI 的门禁之一是「MCP 工具不得绕过 Core」——这组测试就是它的依据：
 * 工具清单由契约派生，调用一律经 CoreApiClient，没有第二条写入路径。
 */

describe('工具清单', () => {
  it('完全由契约的首版清单派生，不手写', () => {
    expect(listMcpTools().map((t) => t.name)).toEqual([...MCP_FIRST_RELEASE_TOOLS]);
  });

  it('每个工具都带描述与入参 Schema，Agent 才能自动发现与正确调用', () => {
    for (const tool of listMcpTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTruthy();
      expect((tool.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('首版不暴露发布与运行——它们稳定后再开', () => {
    const names = listMcpTools().map((t) => t.name);
    expect(names).not.toContain('workflow.publish');
    expect(names).not.toContain('run.start');
    expect(names).not.toContain('run.cancel');
    expect(names).not.toContain('env.install');
  });

  it('每个工具标注所需 Scope，便于逐工具授权与撤销', () => {
    for (const tool of listMcpTools()) {
      expect(tool.scope).toMatch(/^(workflow|memory):/u);
    }
  });

  it('写工具被标出来，界面据此要求二次确认', () => {
    const byName = new Map(listMcpTools().map((t) => [t.name, t]));
    expect(byName.get('workflow.patch')?.mutates).toBe(true);
    expect(byName.get('workflow.get')?.mutates).toBe(false);
  });
});

describe('调用路径', () => {
  const registry = (scopes: string[] = ['workflow:read', 'workflow:write-draft']) => {
    const calls: { method: string; input: unknown }[] = [];
    const transport = new MemoryTransport(
      {
        'workflow.get': () => ({
          workflow: {
            id: 'wf_1',
            name: '流程',
            createdAt: '2026-07-27T00:00:00.000Z',
            updatedAt: '2026-07-27T00:00:00.000Z',
            archived: false,
          },
          graph: { nodes: [], edges: [], groups: [] },
          rev: 18,
          versions: [],
        }),
      },
      (method, input) => calls.push({ method, input }),
    );
    const client = new CoreApiClient(transport, {
      grantedScopes: scopes as never,
    });
    return { registry: new McpToolRegistry(client), calls };
  };

  it('工具调用落到 Core API，不存在旁路', async () => {
    const { registry: r, calls } = registry();
    await r.call('workflow.get', { id: 'wf_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('workflow.get');
  });

  it('未登记的工具名被拒绝', async () => {
    const { registry: r } = registry();
    await expect(r.call('database.query' as never, {})).rejects.toThrow(/未暴露/u);
  });

  it('即使是 Core API 方法，不在首版清单里也不给调', async () => {
    const { registry: r, calls } = registry(['workflow:read', 'workflow:publish']);
    await expect(r.call('workflow.publish' as never, { id: 'wf_1', rev: 1 })).rejects.toThrow(
      /未暴露/u,
    );
    expect(calls).toHaveLength(0);
  });

  it('Scope 不足时由客户端拦下，返回 PERMISSION', async () => {
    const { registry: r } = registry(['workflow:read']);
    await expect(
      r.call('workflow.patch', {
        id: 'wf_1',
        baseRevision: 18,
        operations: [{ op: 'renameNode', nodeId: 'n1', title: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION' });
  });

  it('写操作前触发确认回调——AI 的修改一律先由用户确认', async () => {
    const confirm = vi.fn(async () => false);
    const transport = new MemoryTransport({ 'workflow.patch': () => ({ rev: 19, diff: { added: [], removed: [], changed: [] }, validation: { ok: true, issues: [] } }) });
    const r = new McpToolRegistry(new CoreApiClient(transport), { confirmWrite: confirm });

    await expect(
      r.call('workflow.patch', {
        id: 'wf_1',
        baseRevision: 18,
        operations: [{ op: 'renameNode', nodeId: 'n1', title: 'x' }],
      }),
    ).rejects.toThrow(/未确认/u);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('读操作不需要确认', async () => {
    const confirm = vi.fn(async () => false);
    const { registry: r } = registry();
    const withConfirm = new McpToolRegistry(
      new CoreApiClient(
        new MemoryTransport({
          'workflow.list': () => ({ items: [] }),
        }),
      ),
      { confirmWrite: confirm },
    );
    await withConfirm.call('workflow.list', {});
    expect(confirm).not.toHaveBeenCalled();
    void r;
  });
});
