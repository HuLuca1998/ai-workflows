// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CoreApiError } from '@aiwf/contracts';
import { ipcCommandFor, toIpcInput, fromIpcResult, normalizeIpcError } from '@aiwf/client-core';

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
    // 不再是 workflow_save_draft（整份回写）：引擎自己应用结构化操作，
    // 见 ADR-0009。走整份回写的那一版只能回一个 rev，于是 Diff 与
    // 校验结果只好在映射层编出来
    expect(ipcCommandFor('workflow.patch')).toBe('workflow_patch');
    expect(ipcCommandFor('workflow.validate')).toBe('workflow_validate');
    expect(ipcCommandFor('workflow.diff')).toBe('workflow_diff');
    expect(ipcCommandFor('workflow.publish')).toBe('workflow_publish');
    expect(ipcCommandFor('workflow.delete')).toBe('workflow_delete');
  });

  it('尚未接通的方法返回 null，由调用方报明确的未实现错误', () => {
    // run.retryNode 属于 M2 后半段，env.install 属于 M5 的安装那一半
    //（检测已经接通，安装还没有）
    expect(ipcCommandFor('run.retryNode')).toBeNull();
    expect(ipcCommandFor('env.install')).toBeNull();
  });
});

describe('入参转换', () => {
  it('workflow.patch 把结构化操作与 baseRevision 送下去', () => {
    const operations = [{ op: 'removeNode', nodeId: 'n1' }];
    const graph = { nodes: [], edges: [], groups: [] };
    const input = toIpcInput('workflow.patch', {
      id: 'wf_1',
      baseRevision: 18,
      operations,
      graphJson: JSON.stringify(graph),
    });
    expect(input).toEqual({
      id: 'wf_1',
      baseRevision: 18,
      operations,
      graphJson: JSON.stringify(graph),
    });
  });

  it('结果图是可选的 —— MCP 那一侧没有客户端替它算', () => {
    const operations = [{ op: 'removeNode', nodeId: 'n1' }];
    expect(toIpcInput('workflow.patch', { id: 'wf_1', baseRevision: 1, operations })).toEqual({
      id: 'wf_1',
      baseRevision: 1,
      operations,
    });
  });

  it('operations 为空时直接报错 —— 结构化操作是唯一的写入形态', () => {
    // 空操作列表送下去只会白写一个修订。而更要紧的是：
    // 它意味着调用方本来想传的东西丢了，静默通过会让那次丢失无从发现
    expect(() =>
      toIpcInput('workflow.patch', { id: 'wf_1', baseRevision: 1, operations: [] }),
    ).toThrow(/operations/u);
  });

  it('其余方法原样透传', () => {
    expect(toIpcInput('workflow.get', { id: 'wf_1' })).toEqual({ id: 'wf_1' });
    expect(toIpcInput('workflow.publish', { id: 'wf_1', rev: 3 })).toEqual({ id: 'wf_1', rev: 3 });
  });
});

describe('出参转换', () => {
  it('workflow.list 把 snake_case 转成契约形状', () => {
    const raw = {
      items: [{ id: 'wf_1', name: '流程', folder: null, updatedAt: '2026-07-27T10:00:00.000Z' }],
      total: 1,
    };
    const result = fromIpcResult('workflow.list', raw) as { items: unknown[]; total: number };
    expect(result.items[0]).toMatchObject({
      id: 'wf_1',
      name: '流程',
      updatedAt: '2026-07-27T10:00:00.000Z',
      archived: false,
    });
    // total 是分页控件的依据，不能在转换层丢掉
    expect(result.total).toBe(1);
  });

  it('workflow.get 把 graphJson 解析成对象，并保留 rev 与版本列表', () => {
    const raw = {
      id: 'wf_1',
      name: '流程',
      folder: null,
      createdAt: '2026-07-27T09:00:00.000Z',
      updatedAt: '2026-07-27T10:00:00.000Z',
      rev: 4,
      graphJson: '{"nodes":[],"edges":[],"groups":[]}',
      versions: [
        {
          id: 'wv_1',
          version: 1,
          configHash: 'abc',
          publishedAt: '2026-07-27T09:30:00.000Z',
          publishedBy: '本地用户',
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

  it('graphJson 坏掉时报错而不是给一张空图——空图会让用户以为工作流丢了', () => {
    expect(() =>
      fromIpcResult('workflow.get', {
        id: 'wf_1',
        name: 'x',
        createdAt: 'a',
        updatedAt: 'a',
        rev: 1,
        graphJson: '{ 这不是 JSON',
        versions: [],
      }),
    ).toThrow(/图数据/u);
  });

  it('workflow.patch 原样回传引擎算的 Diff 与校验结果', () => {
    // 曾经在这一层编一个空 Diff 加「ok: true」。任何不经过 DraftStore
    // 的调用方（MCP、脚本）都会收到「校验通过、什么都没改」，
    // 而图可能已经坏了
    const raw = {
      rev: 19,
      diff: {
        added: [{ kind: 'node', id: 'n2', label: 'node end「结束」' }],
        removed: [],
        changed: [],
      },
      validation: {
        ok: false,
        issues: [{ level: 'error', code: 'ENTRY_MISSING', message: '缺入口' }],
      },
    };
    expect(fromIpcResult('workflow.patch', raw)).toEqual(raw);
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

  /**
   * hint 是「接下来该干什么」，界面直接展示它（`editorStore.describe` 会拼成
   * `message（hint）`）。引擎那边好不容易算出来的这句话，不能在还原时被丢掉。
   *
   * 第 5 轮 B1 预言过这个坑：「即使将来 Rust 补上 hint，也会在这一层被丢掉 ——
   * 当下看不出症状、补了上游也不生效」。第 3 轮实测证实了：引擎已经返回
   * `hint: "别处已经把它改到 rev1…刷新拿到最新版本再改一次"`，
   * 而编辑器错误条上只有「草稿已变化：基础版本 1，当前 rev 2」。
   */
  it('还原时带上 hint 与 details —— 丢了的话用户就没有下一步', () => {
    const error = normalizeIpcError({
      code: 'REVISION_CONFLICT',
      message: '草稿已变化：基础版本 1，当前 rev 2',
      retriable: true,
      hint: '别处已经把它改到 rev2，而你这次基于 rev1。刷新拿到最新版本再改一次',
      details: { base: 1, current: 2 },
    });
    expect(error.hint).toBe('别处已经把它改到 rev2，而你这次基于 rev1。刷新拿到最新版本再改一次');
    expect(error.details).toEqual({ base: 1, current: 2 });
  });
});

describe('未接通的方法', () => {
  it('调用未实现的方法时给出明确原因与去处，而不是静默返回空', async () => {
    const { createTauriTransport } = await import('@aiwf/client-core');
    const invoke = vi.fn();
    const transport = createTauriTransport(async (cmd, args) => invoke(cmd, args));
    await expect(transport.call('env.install', { tools: ['node'] })).rejects.toThrow(
      /尚未接通|ROADMAP/u,
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
