// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CoreApiError } from '@aiwf/contracts';
import { ipcCommandFor, toIpcInput, fromIpcResult, normalizeIpcError } from '../src/data/ipc.js';

/**
 * Core API 方法 ↔ Tauri IPC 命令的映射。
 *
 * 契约用 camelCase 与点号方法名，IPC 用 snake_case，两边形状不同，
 * 转换逻辑必须能单测——否则字段名写错时症状是「数据莫名为空」而不是报错。
 */

describe('方法名映射', () => {
  it('已接通的方法映射到对应 IPC 命令', () => {
    expect(ipcCommandFor('workflow.list')).toBe('workflow_list');
    expect(ipcCommandFor('workflow.get')).toBe('workflow_get');
    expect(ipcCommandFor('workflow.patch')).toBe('workflow_save_draft');
    expect(ipcCommandFor('workflow.publish')).toBe('workflow_publish');
    expect(ipcCommandFor('workflow.delete')).toBe('workflow_delete');
  });

  it('尚未接通的方法返回 null，由调用方报明确的未实现错误', () => {
    // run.retryNode 属于 M2 后半段，env.health 属于 M5
    expect(ipcCommandFor('run.retryNode')).toBeNull();
    expect(ipcCommandFor('env.health')).toBeNull();
  });
});

describe('入参转换', () => {
  it('workflow.patch 把结构化操作应用后的整图与 baseRevision 一起送下去', () => {
    const graph = { nodes: [], edges: [], groups: [] };
    const input = toIpcInput('workflow.patch', {
      id: 'wf_1',
      baseRevision: 18,
      operations: [],
      graphJson: JSON.stringify(graph),
    });
    expect(input).toEqual({ id: 'wf_1', baseRev: 18, graphJson: JSON.stringify(graph) });
  });

  it('patch 缺少 graphJson 时直接报错——静默发一个空图会清掉用户的工作流', () => {
    expect(() =>
      toIpcInput('workflow.patch', { id: 'wf_1', baseRevision: 1, operations: [] }),
    ).toThrow(/graphJson/u);
  });

  it('其余方法原样透传', () => {
    expect(toIpcInput('workflow.get', { id: 'wf_1' })).toEqual({ id: 'wf_1' });
    expect(toIpcInput('workflow.publish', { id: 'wf_1', rev: 3 })).toEqual({ id: 'wf_1', rev: 3 });
  });
});

describe('出参转换', () => {
  it('workflow.list 把 snake_case 转成契约形状', () => {
    const raw = [
      { id: 'wf_1', name: '流程', folder: null, updated_at: '2026-07-27T10:00:00.000Z' },
    ];
    const result = fromIpcResult('workflow.list', raw) as { items: unknown[] };
    expect(result.items[0]).toMatchObject({
      id: 'wf_1',
      name: '流程',
      updatedAt: '2026-07-27T10:00:00.000Z',
      archived: false,
    });
  });

  it('workflow.get 把 graph_json 解析成对象，并保留 rev 与版本列表', () => {
    const raw = {
      id: 'wf_1',
      name: '流程',
      folder: null,
      created_at: '2026-07-27T09:00:00.000Z',
      updated_at: '2026-07-27T10:00:00.000Z',
      rev: 4,
      graph_json: '{"nodes":[],"edges":[],"groups":[]}',
      versions: [
        {
          id: 'wv_1',
          version: 1,
          config_hash: 'abc',
          published_at: '2026-07-27T09:30:00.000Z',
          published_by: '本地用户',
        },
      ],
    };
    const result = fromIpcResult('workflow.get', raw) as {
      rev: number;
      graph: { nodes: unknown[] };
      versions: { version: number }[];
    };
    expect(result.rev).toBe(4);
    expect(result.graph.nodes).toEqual([]);
    expect(result.versions[0]?.version).toBe(1);
  });

  it('graph_json 坏掉时报错而不是给一张空图——空图会让用户以为工作流丢了', () => {
    expect(() =>
      fromIpcResult('workflow.get', {
        id: 'wf_1',
        name: 'x',
        created_at: 'a',
        updated_at: 'a',
        rev: 1,
        graph_json: '{ 这不是 JSON',
        versions: [],
      }),
    ).toThrow(/图数据/u);
  });

  it('workflow.patch 返回新 rev 与空 diff（Diff 已在客户端算过）', () => {
    const result = fromIpcResult('workflow.patch', 19) as { rev: number };
    expect(result.rev).toBe(19);
  });
});

describe('错误规范化', () => {
  it('版本冲突还原成 CoreApiError 且可重试', () => {
    const error = normalizeIpcError({
      code: 'REVISION_CONFLICT',
      message: '草稿已变化：基础版本 1，当前 rev 2',
      retriable: true,
    });
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error.code).toBe('REVISION_CONFLICT');
    expect(error.retriable).toBe(true);
  });

  it('未识别的错误兜底成 INTERNAL 并保留原文', () => {
    const error = normalizeIpcError('window.__TAURI__ 未定义');
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('未定义');
  });
});

describe('未接通的方法', () => {
  it('调用未实现的方法时给出明确原因与去处，而不是静默返回空', async () => {
    const { createTauriTransport } = await import('../src/data/ipc.js');
    const invoke = vi.fn();
    const transport = createTauriTransport(async (cmd, args) => invoke(cmd, args));
    await expect(transport.call('env.health', {})).rejects.toThrow(/尚未接通|ROADMAP/u);
    expect(invoke).not.toHaveBeenCalled();
  });
});
