import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@aiwf/contracts';
import { CoreApiClient } from '../src/client.js';
import { DraftStore } from '../src/draft-store.js';
import { MemoryTransport } from '../src/transport.js';

/**
 * 草稿 store 落实两条产品原则：
 * 「草稿与执行分离」——改草稿永远不影响运行中的版本；
 * 「AI 建议 ≠ 执行」——AI 的改动先进待确认区，出 Diff，用户点了才写。
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
    nodeId: 'run_lint',
    type: 'script.shell' as const,
    title: '运行 lint',
    position: { x: 150, y: 100 },
    config: { interpreter: 'zsh', script: 'pnpm lint' },
  },
];

function store(patchImpl?: (input: unknown) => unknown) {
  const transport = new MemoryTransport({
    'workflow.patch':
      patchImpl ??
      ((input) => ({
        rev: (input as { baseRevision: number }).baseRevision + 1,
        diff: { added: [], removed: [], changed: [] },
        validation: { ok: true, issues: [] },
      })),
  });
  return new DraftStore(new CoreApiClient(transport), 'wf_1', { graph: graph(), rev: 18 });
}

describe('本地乐观编辑', () => {
  it('应用操作后画布立即更新，不等服务端往返', () => {
    const draft = store();
    const result = draft.apply(addLint);

    expect(draft.graph.nodes.map((n) => n.id)).toContain('run_lint');
    expect(result.validation.ok).toBe(true);
    expect(draft.isDirty).toBe(true);
    // 服务端 rev 未变：本地改动还没落库
    expect(draft.rev).toBe(18);
  });

  it('非法操作不会污染画布', () => {
    const draft = store();
    expect(() => draft.apply([{ op: 'removeNode', nodeId: '不存在' }])).toThrow();
    expect(draft.graph.nodes).toHaveLength(2);
    expect(draft.isDirty).toBe(false);
  });

  it('提交成功后接受服务端 rev 并清掉待提交操作', async () => {
    const draft = store();
    draft.apply(addLint);
    await draft.commit();

    expect(draft.rev).toBe(19);
    expect(draft.isDirty).toBe(false);
  });

  it('版本冲突时回滚到提交前的图，并把冲突交给调用方处理', async () => {
    const draft = store(() => {
      throw { code: 'REVISION_CONFLICT', message: '草稿已变化', retriable: true };
    });
    draft.apply(addLint);

    await expect(draft.commit()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    // 回滚：本地不能留着一份服务端并不知道的图
    expect(draft.graph.nodes.map((n) => n.id)).not.toContain('run_lint');
    expect(draft.isDirty).toBe(false);
  });

  it('没有待提交操作时 commit 是空操作，不发请求', async () => {
    let called = 0;
    const draft = store(() => {
      called += 1;
      return {
        rev: 19,
        diff: { added: [], removed: [], changed: [] },
        validation: { ok: true, issues: [] },
      };
    });
    await draft.commit();
    expect(called).toBe(0);
  });
});

describe('AI 提议先出 Diff', () => {
  it('AI 的改动进待确认区，不直接改草稿', () => {
    const draft = store();
    const proposal = draft.propose(addLint, { by: 'supervisor-ai' });

    expect(draft.graph.nodes.map((n) => n.id)).not.toContain('run_lint');
    expect(proposal.diff.added[0]?.label).toContain('运行 lint');
    expect(proposal.validation.ok).toBe(true);
    expect(draft.pendingProposal?.by).toBe('supervisor-ai');
  });

  it('用户确认后才落到草稿', () => {
    const draft = store();
    draft.propose(addLint, { by: 'supervisor-ai' });
    draft.acceptProposal();

    expect(draft.graph.nodes.map((n) => n.id)).toContain('run_lint');
    expect(draft.pendingProposal).toBeNull();
    expect(draft.isDirty).toBe(true);
  });

  it('丢弃提议后草稿保持原样', () => {
    const draft = store();
    draft.propose(addLint, { by: 'supervisor-ai' });
    draft.discardProposal();

    expect(draft.graph.nodes).toHaveLength(2);
    expect(draft.pendingProposal).toBeNull();
    expect(draft.isDirty).toBe(false);
  });

  it('提议会产生非法图时照样返回，但标出问题让 AI 自查', () => {
    const draft = store();
    const proposal = draft.propose([
      {
        op: 'connect',
        edgeId: 'e9',
        source: { nodeId: 'end', port: 'success' },
        target: { nodeId: 'entry', port: 'input' },
      },
    ]);
    expect(proposal.validation.ok).toBe(false);
  });

  it('订阅者在草稿或提议变化时收到通知', () => {
    const draft = store();
    let notified = 0;
    draft.subscribe(() => {
      notified += 1;
    });

    draft.propose(addLint);
    draft.acceptProposal();
    expect(notified).toBe(2);
  });
});

describe('提交内容', () => {
  it('随操作一并提交结果图——applyPatch 只在客户端有实现（ADR-0008）', async () => {
    const seen: unknown[] = [];
    const transport = new MemoryTransport({
      'workflow.patch': (input) => {
        seen.push(input);
        return {
          rev: 19,
          diff: { added: [], removed: [], changed: [] },
          validation: { ok: true, issues: [] },
        };
      },
    });
    const draft = new DraftStore(new CoreApiClient(transport), 'wf_1', {
      graph: graph(),
      rev: 18,
    });

    draft.apply(addLint);
    await draft.commit();

    const payload = seen[0] as { graphJson?: string; operations: unknown[] };
    expect(payload.graphJson).toBeTruthy();
    // 操作列表也要在：审计与重放靠它，不能只剩一张图
    expect(payload.operations).toHaveLength(1);
    const submitted = JSON.parse(payload.graphJson as string) as { nodes: { id: string }[] };
    expect(submitted.nodes.map((n) => n.id)).toContain('run_lint');
  });
});
