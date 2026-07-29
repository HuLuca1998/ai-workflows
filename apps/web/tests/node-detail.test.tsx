import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NodeDetail } from '../src/runs/NodeDetail.js';
import type { RunEvent } from '../src/runs/runsStore.js';

/**
 * 选中一个节点时的详情面板。
 *
 * 一条原则：**不同类型的节点该看的东西不一样**。
 * 脚本节点要看命令、退出码、stdout/stderr；AI 节点要看提示词、推理、
 * 工具调用、回答；worktree 要看分支与路径；审批要看谁在什么时候批了什么。
 * 全都塞进同一张事件表里，等于让用户自己去认哪几行是有用的。
 */

let seq = 0;
const 事件 = (type: string, extra: Partial<RunEvent> = {}): RunEvent =>
  ({
    id: `e${(seq += 1)}`,
    runId: 'run_1',
    seq,
    type,
    actor: 'engine',
    summary: '',
    ts: '2026-07-28T12:03:41.000Z',
    sensitivity: 'internal',
    schemaVer: 1,
    artifactRefs: [],
    nodeId: 'n',
    ...extra,
  }) as RunEvent;

describe('节点详情', () => {
  it('脚本节点：命令、退出码、两路输出各自成块', () => {
    render(
      <NodeDetail
        nodeId="n"
        nodeType="script.shell"
        nodeLabel="读取 Issue"
        events={[
          事件('script.started', { summary: 'zsh · gh issue view 1', payloadRef: 'n/command.sh' }),
          事件('script.stdout', { summary: '{"number":1}', payloadRef: 'n/stdout.log' }),
          事件('script.stderr', { summary: 'warning: 慢了点', payloadRef: 'n/stderr.log' }),
          事件('script.exited', { summary: '退出码 0' }),
        ]}
      />,
    );

    expect(screen.getByText(/gh issue view 1/u)).toBeTruthy();
    expect(screen.getByText(/退出码 0/u)).toBeTruthy();
    // 两路输出要分开，不能混成一坨
    expect(screen.getByRole('group', { name: '标准输出' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '标准错误' })).toBeTruthy();
  });

  it('脚本节点没有 stderr 时不显示那一块', () => {
    render(
      <NodeDetail
        nodeId="n"
        nodeType="script.shell"
        nodeLabel="脚本"
        events={[事件('script.exited', { summary: '退出码 0' })]}
      />,
    );
    expect(screen.queryByRole('group', { name: '标准错误' })).toBeNull();
  });

  it('AI 节点：角色与模型在最前，然后是对话', () => {
    render(
      <NodeDetail
        nodeId="n"
        nodeType="ai.analyze"
        nodeLabel="分析 Issue"
        events={[
          事件('system.model_resolved', {
            summary:
              'Agent 角色「分析师」（builtin:analyst）· 模型 model:codex · runtime acp.codex · cwd /tmp/x',
          }),
          事件('conversation.user_message', { summary: '定位根因', actor: 'agent' }),
          事件('conversation.agent_message', { summary: 'TTL 缓存没清', actor: 'agent' }),
        ]}
      />,
    );

    // 「用了谁」是 AI 节点独有的一栏
    const 归属 = screen.getByRole('group', { name: '这一步用了谁' });
    expect(within(归属).getByText(/分析师/u)).toBeTruthy();
    expect(within(归属).getByText(/model:codex/u)).toBeTruthy();
    expect(screen.getByText(/TTL 缓存没清/u)).toBeTruthy();
  });

  it('worktree 节点：分支与路径单独一栏', () => {
    render(
      <NodeDetail
        nodeId="n"
        nodeType="git.worktree"
        nodeLabel="创建 Worktree"
        events={[事件('node.output_emitted', { summary: '分支 fix/1 · worktree /tmp/wt/fix-1' })]}
      />,
    );
    expect(screen.getByRole('group', { name: '隔离工作区' })).toBeTruthy();
    expect(screen.getByText(/fix\/1/u)).toBeTruthy();
  });

  it('审批节点：谁在什么时候批了什么', () => {
    render(
      <NodeDetail
        nodeId="n"
        nodeType="approval"
        nodeLabel="人工审批"
        events={[
          事件('approval.requested', { summary: '人工审批' }),
          事件('approval.decided', { summary: '决定：approved', actor: 'user' }),
        ]}
      />,
    );
    const 卡 = screen.getByRole('group', { name: '审批' });
    expect(within(卡).getByText(/approved/u)).toBeTruthy();
    expect(within(卡).getByText(/user/u)).toBeTruthy();
  });

  it('没有专属视图的类型退回事件列表，而不是一片空白', () => {
    // 新加一种节点类型时不该在这里留一个空面板 ——
    // 那会让人以为「这个节点什么都没发生」
    render(
      <NodeDetail
        nodeId="n"
        nodeType="notify"
        nodeLabel="通知"
        events={[事件('node.succeeded', { summary: '通知 完成 · 走 success 分支' })]}
      />,
    );
    expect(screen.getByText(/通知 完成/u)).toBeTruthy();
  });

  it('节点还没跑到时说清楚', () => {
    render(<NodeDetail nodeId="n" nodeType="ai.review" nodeLabel="审查" events={[]} />);
    expect(screen.getByText(/还没跑到/u)).toBeTruthy();
  });

  it('失败的节点把原因放在最前面', () => {
    // 失败时用户第一眼要看的是「为什么」，不是按时间顺序翻到最后一行
    render(
      <NodeDetail
        nodeId="n"
        nodeType="script.shell"
        nodeLabel="脚本"
        events={[
          事件('script.started', { summary: 'zsh · false' }),
          事件('node.failed', { summary: '脚本以退出码 1 结束' }),
        ]}
      />,
    );
    const 面板 = screen.getByRole('group', { name: '失败原因' });
    expect(within(面板).getByText(/退出码 1/u)).toBeTruthy();
  });
});
