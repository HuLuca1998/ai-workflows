import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationView } from '../src/runs/ConversationView.js';
import type { RunEvent } from '../src/runs/runsStore.js';

/**
 * 执行记录的「对话」tab。
 *
 * 它长期是一句写死的话：「这次运行没有 AI 节点，所以没有对话」——
 * 而跑过 4 个 AI 节点的运行打开它，看到的还是那句。产物里躺着
 * 2943 字节的审查结论，用户在界面上一个字都看不到。
 *
 * 图纸「03 执行记录」的对话视图是：用户气泡 → Agent 消息 + 工具活动 →
 * 审批卡 → Agent 消息。这里守住那个结构与两种空态的区别。
 */

let seq = 0;
const 事件 = (type: string, extra: Partial<RunEvent> = {}): RunEvent =>
  ({
    id: `e${(seq += 1)}`,
    runId: 'run_1',
    seq,
    type,
    actor: 'agent',
    summary: '',
    ts: '2026-07-28T12:03:41.000Z',
    sensitivity: 'internal',
    schemaVer: 1,
    artifactRefs: [],
    ...extra,
  }) as RunEvent;

describe('对话视图', () => {
  it('没有 AI 节点时说的是「没有 AI 节点」', () => {
    render(
      <ConversationView events={[事件('run.created', { actor: 'engine' })]} hasAiNode={false} />,
    );
    expect(screen.getByText(/这次运行没有 AI 节点/u)).toBeTruthy();
  });

  it('有 AI 节点但还没说话时，说的是另一句', () => {
    // 两种空态混成一句的话，用户会以为自己的 AI 节点没生效 ——
    // 而实际上它可能只是还没跑到
    render(<ConversationView events={[事件('node.started', { nodeId: 'analyze' })]} hasAiNode />);
    expect(screen.queryByText(/没有 AI 节点/u)).toBeNull();
    expect(screen.getByText(/还没有往返消息/u)).toBeTruthy();
  });

  it('提问与回答各自成一条，按 seq 排', () => {
    render(
      <ConversationView
        events={[
          事件('conversation.user_message', {
            nodeId: 'analyze',
            nodeLabel: '分析 Issue',
            summary: '定位根因，给出 2–3 个方案',
          }),
          事件('conversation.agent_message', {
            nodeId: 'analyze',
            nodeLabel: '分析 Issue',
            summary: 'TTL 缓存在热重载时没有清空',
          }),
        ]}
        hasAiNode
      />,
    );

    const 条目 = screen.getAllByRole('listitem');
    expect(条目).toHaveLength(2);
    expect(条目[0]!.textContent).toContain('定位根因');
    expect(条目[1]!.textContent).toContain('TTL 缓存');
    // 谁说的要看得出来
    expect(within(条目[0]!).getByText('你')).toBeTruthy();
    expect(within(条目[1]!).getByText('分析 Issue')).toBeTruthy();
  });

  it('工具调用折进它所属的那条消息里，不单独占一行', () => {
    // 图纸是「工具活动 · 6 次读取，2 次搜索」一行折叠，
    // 每次调用单独一条会把对话冲得没法读
    render(
      <ConversationView
        events={[
          事件('tool.call_finished', {
            nodeId: 'analyze',
            summary: '读取 src/cache.js（completed）',
          }),
          事件('tool.call_finished', { nodeId: 'analyze', summary: '搜索 TTL（completed）' }),
          事件('conversation.agent_message', {
            nodeId: 'analyze',
            nodeLabel: '分析 Issue',
            summary: '结论',
          }),
        ]}
        hasAiNode
      />,
    );

    const 条目 = screen.getAllByRole('listitem');
    expect(条目).toHaveLength(1);
    expect(条目[0]!.textContent).toContain('工具活动 · 2 次');
  });

  it('全文点得开 —— 事件里只有摘要', () => {
    const onOpen = vi.fn();
    render(
      <ConversationView
        events={[
          事件('conversation.agent_message', {
            nodeId: 'analyze',
            nodeLabel: '分析 Issue',
            summary: '结论（截断了）…',
            payloadRef: 'analyze/agent.md',
          }),
        ]}
        hasAiNode
        onOpenArtifact={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /全文/u }));
    expect(onOpen).toHaveBeenCalledWith('analyze/agent.md');
  });

  it('没有 payloadRef 的消息不给「全文」按钮', () => {
    // 点了没反应比没有按钮糟
    render(
      <ConversationView
        events={[事件('conversation.agent_message', { nodeId: 'a', summary: '短消息' })]}
        hasAiNode
      />,
    );
    expect(screen.queryByRole('button', { name: /全文/u })).toBeNull();
  });

  it('审批作为一条独立的卡出现', () => {
    render(
      <ConversationView
        events={[
          事件('approval.requested', {
            nodeId: 'approve',
            nodeLabel: '人工审批',
            summary: '人工审批',
          }),
          事件('approval.decided', { nodeId: 'approve', actor: 'user', summary: '决定：approved' }),
        ]}
        hasAiNode
      />,
    );
    expect(screen.getByText(/人工审批/u)).toBeTruthy();
    expect(screen.getByText(/approved/u)).toBeTruthy();
  });

  it('推理摘要与回答分开显示', () => {
    render(
      <ConversationView
        events={[
          事件('reasoning.summary', { nodeId: 'analyze', summary: '先看 watcher 的顺序' }),
          事件('conversation.agent_message', { nodeId: 'analyze', summary: '结论' }),
        ]}
        hasAiNode
      />,
    );
    expect(screen.getByText(/先看 watcher 的顺序/u)).toBeTruthy();
    expect(screen.getByText(/推理/u)).toBeTruthy();
  });
});
