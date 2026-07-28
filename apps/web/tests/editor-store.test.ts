// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreApiClient, DraftStore, MemoryTransport } from '@aiwf/client-core';
import type { WorkflowGraph } from '@aiwf/contracts';
import { __setDraftForTest, useEditor } from '../src/editor/editorStore.js';
import { coreClient } from '../src/data/workspace.js';

/**
 * 编辑器状态。这里测的是「界面能不能正确反映草稿的真实状态」：
 * 脏标记、校验结果、冲突后的回滚、发布前的拦截。
 */

const graph = (): WorkflowGraph => ({
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    {
      id: 'end',
      type: 'end',
      title: '结束',
      position: { x: 300, y: 0 },
      config: { outcome: 'success' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'end', port: 'input' },
    },
  ],
  groups: [],
});

const addLint = [
  {
    op: 'addNode' as const,
    nodeId: 'lint',
    type: 'script.shell' as const,
    title: '运行 lint',
    position: { x: 150, y: 120 },
    config: { interpreter: 'zsh', script: 'pnpm lint' },
  },
];

function withDraft(patchImpl?: (input: unknown) => unknown) {
  const transport = new MemoryTransport({
    'workflow.patch':
      patchImpl ??
      ((input) => ({
        rev: (input as { baseRevision: number }).baseRevision + 1,
        diff: { added: [], removed: [], changed: [] },
        validation: { ok: true, issues: [] },
      })),
  });
  const store = new DraftStore(new CoreApiClient(transport), 'wf_1', { graph: graph(), rev: 4 });
  __setDraftForTest(store);
  useEditor.setState({
    workflowId: 'wf_1',
    name: '流程',
    rev: 4,
    graph: graph(),
    dirty: false,
    error: null,
  });
  return store;
}

beforeEach(() => {
  __setDraftForTest(null);
  useEditor.getState().clear();
});

describe('编辑与脏标记', () => {
  it('应用操作后画布图更新且标记为脏', () => {
    withDraft();
    useEditor.getState().apply(addLint);

    const state = useEditor.getState();
    expect(state.graph.nodes.map((n) => n.id)).toContain('lint');
    expect(state.dirty).toBe(true);
    // rev 不变：本地改动还没落库
    expect(state.rev).toBe(4);
  });

  it('非法操作不改图，把原因显示出来', () => {
    withDraft();
    useEditor.getState().apply([{ op: 'removeNode', nodeId: '不存在' }]);

    const state = useEditor.getState();
    expect(state.graph.nodes).toHaveLength(2);
    expect(state.error).toMatch(/不存在/u);
  });

  it('每次改动都重算校验——工具栏的问题计数靠它', () => {
    withDraft();
    useEditor.getState().apply([{ op: 'disconnect', edgeId: 'e1' }]);
    expect(useEditor.getState().validation.issues.some((i) => i.code === 'ORPHAN_NODE')).toBe(true);
  });
});

describe('保存', () => {
  it('保存成功后接受新 rev 并清掉脏标记', async () => {
    withDraft();
    useEditor.getState().apply(addLint);
    await useEditor.getState().save();

    const state = useEditor.getState();
    expect(state.rev).toBe(5);
    expect(state.dirty).toBe(false);
    expect(state.error).toBeNull();
  });

  it('没有改动时保存是空操作', async () => {
    let called = 0;
    withDraft(() => {
      called += 1;
      return {
        rev: 5,
        diff: { added: [], removed: [], changed: [] },
        validation: { ok: true, issues: [] },
      };
    });
    await useEditor.getState().save();
    expect(called).toBe(0);
  });

  it('版本冲突时把图回滚并说明原因，不留一份服务端不知道的图', async () => {
    withDraft(() => {
      throw {
        code: 'REVISION_CONFLICT',
        message: '草稿已变化：基础版本 4，当前 rev 6',
        retriable: true,
      };
    });
    useEditor.getState().apply(addLint);
    await useEditor.getState().save();

    const state = useEditor.getState();
    expect(state.graph.nodes.map((n) => n.id)).not.toContain('lint');
    expect(state.dirty).toBe(false);
    expect(state.error).toMatch(/草稿已变化/u);
  });
});

describe('发布', () => {
  it('有未保存改动时拦住发布并说清原因——发布的是已落库的修订', async () => {
    withDraft();
    useEditor.getState().apply(addLint);

    const version = await useEditor.getState().publish();
    expect(version).toBeNull();
    expect(useEditor.getState().error).toMatch(/先保存草稿/u);
  });
});

describe('离开编辑器不删任何东西', () => {
  /**
   * 曾经在 clear 里顺手丢空草稿，回退了。
   *
   * effect 的 cleanup 分不出「切换工作流」与「真的离开」，而 React 的
   * 双次挂载会让它在用户刚新建、还没做任何事时就触发。实测的请求序列是
   * `create → discard_if_empty → save_draft` —— 用户刚拖的节点保存到了
   * 一个已经被删掉的工作流上。
   *
   * 这条用例守住「别再加回去」。清理走概览页的显式入口。
   */
  it('clear 不发任何写请求', () => {
    const calls: string[] = [];
    vi.spyOn(coreClient, 'call').mockImplementation(async (method: string) => {
      calls.push(method);
      return {};
    });

    useEditor.setState({ workflowId: 'wf_1', dirty: false });
    useEditor.getState().clear();

    expect(calls).toEqual([]);
    expect(useEditor.getState().workflowId).toBeNull();
  });

  it('clear 是同步的 —— 状态在返回时就已经清干净', () => {
    // 异步版本踩过：clear 的 set() 跑在 await 之后，那时下一个 load
    // 可能已经完成，于是刚加载的工作流被清成空白。
    // 症状是「改名刷新后名字变回旧的」，而原因离症状很远。
    useEditor.setState({ workflowId: 'wf_1', name: '旧的', dirty: true });
    const result = useEditor.getState().clear();

    expect(result).toBeUndefined();
    expect(useEditor.getState().workflowId).toBeNull();
    expect(useEditor.getState().name).toBe('');
    expect(useEditor.getState().dirty).toBe(false);
  });
});
