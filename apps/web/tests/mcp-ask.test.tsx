import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Agent 向用户提问 —— 选一个 / 选几个 / 补一段。
 *
 * 与「确认一次写操作」共用同一条队列（机制一样：TTL、过期、轮询），
 * 但渲染成不同的卡：确认给的是批准/拒绝，提问给的是选项或输入框。
 *
 * **组件目录是白名单**：agent 只能从 choice / multiChoice / form / confirm
 * 里挑一个填数据，碰不到布局也发明不了新组件 —— 让它返回 HTML
 * 等于把渲染通道接到它的权限面上，而这个 agent 连着系统 MCP、能改草稿。
 *
 * 这里压住的是「用户选的东西要原样回到 agent 手上」：
 * 回不去的话，agent 的那次工具调用拿到一个空回答，
 * 而用户以为自己已经告诉它了。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

import type * as WorkspaceModule from '../src/data/workspace.js';

const { createContractCall } = await import('./_contractClient.js');
const { McpConfirmCard } = await import('../src/mcp/McpConfirmCard.js');

/** 一条提问。`ask` 在就渲染成提问卡。 */
const 提问 = (ask: Record<string, unknown>) => ({
  id: 'mcpc_ask',
  tool: 'ask_user',
  inputJson: JSON.stringify(ask),
  createdAt: '2026-07-28T10:00:00Z',
  ask,
});

let 收到的回答: unknown = null;

function respond(items: unknown[]) {
  收到的回答 = null;
  const checked = createContractCall({
    'mcp.pendingConfirms': () => ({ items }),
    'mcp.decideConfirm': () => ({ ok: true }),
    'mcp.answerAsk': (input) => {
      收到的回答 = input;
      return { ok: true };
    },
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
});

describe('单选', () => {
  it('选一个提交，选的那个原样回到 agent 手上', async () => {
    respond([
      提问({
        kind: 'choice',
        title: '先修哪个方向',
        detail: '两条路都能走通',
        options: [
          { value: 'cache', label: '先改缓存层', description: '影响面小' },
          { value: 'lock', label: '换成悲观锁', description: '改动大但根治' },
        ],
        fields: [],
        defaults: [],
      }),
    ]);
    render(<McpConfirmCard />);

    // 问题与理由都要显示 —— 只给选项的话用户不知道在选什么
    expect(await screen.findByText(/先修哪个方向/u)).toBeTruthy();
    expect(screen.getByText(/两条路都能走通/u)).toBeTruthy();
    // 选项的补充说明也要在：差别常常不在标题上
    expect(screen.getByText(/影响面小/u)).toBeTruthy();

    await userEvent.click(screen.getByRole('radio', { name: /先改缓存层/u }));
    await userEvent.click(screen.getByRole('button', { name: /提交/u }));

    await waitFor(() => expect(收到的回答).not.toBeNull());
    expect(收到的回答).toMatchObject({
      id: 'mcpc_ask',
      answer: { selected: 'cache' },
    });
  });

  it('没选就不能提交 —— 空答案会被 agent 当成「用户没意见」', async () => {
    respond([
      提问({
        kind: 'choice',
        title: '选一个',
        detail: '',
        options: [{ value: 'a', label: 'A', description: '' }],
        fields: [],
        defaults: [],
      }),
    ]);
    render(<McpConfirmCard />);

    const submit = await screen.findByRole('button', { name: /提交/u });
    expect(submit.hasAttribute('disabled')).toBe(true);
  });
});

describe('多选', () => {
  it('选几个提交，全都回到 agent 手上', async () => {
    respond([
      提问({
        kind: 'multiChoice',
        title: '这 3 处修哪几个',
        detail: '',
        options: [
          { value: 'a', label: '空指针', description: '' },
          { value: 'b', label: '竞态', description: '' },
          { value: 'c', label: '拼写', description: '' },
        ],
        fields: [],
        defaults: [],
      }),
    ]);
    render(<McpConfirmCard />);

    await userEvent.click(await screen.findByRole('checkbox', { name: /空指针/u }));
    await userEvent.click(screen.getByRole('checkbox', { name: /竞态/u }));
    await userEvent.click(screen.getByRole('button', { name: /提交/u }));

    await waitFor(() => expect(收到的回答).not.toBeNull());
    expect(收到的回答).toMatchObject({ answer: { selectedMany: ['a', 'b'] } });
  });

  it('一个都不选也能提交 —— 「一个都不修」是有意义的回答', async () => {
    respond([
      提问({
        kind: 'multiChoice',
        title: '修哪几个',
        detail: '',
        options: [{ value: 'a', label: 'A', description: '' }],
        fields: [],
        defaults: [],
      }),
    ]);
    render(<McpConfirmCard />);

    await userEvent.click(await screen.findByRole('button', { name: /提交/u }));
    await waitFor(() => expect(收到的回答).not.toBeNull());
    expect(收到的回答).toMatchObject({ answer: { selectedMany: [] } });
  });
});

describe('补充输入', () => {
  it('填的内容按字段名回到 agent 手上', async () => {
    respond([
      提问({
        kind: 'form',
        title: '还缺两件事',
        detail: '',
        options: [],
        fields: [
          { name: 'branch', label: '分支名', multiline: false, required: true, placeholder: '' },
          { name: 'why', label: '背景', multiline: true, required: false, placeholder: '' },
        ],
        defaults: [],
      }),
    ]);
    render(<McpConfirmCard />);

    await userEvent.type(await screen.findByLabelText(/分支名/u), 'fix/cache');
    await userEvent.type(screen.getByLabelText(/背景/u), '线上报了三次');
    await userEvent.click(screen.getByRole('button', { name: /提交/u }));

    await waitFor(() => expect(收到的回答).not.toBeNull());
    expect(收到的回答).toMatchObject({
      answer: { fields: { branch: 'fix/cache', why: '线上报了三次' } },
    });
  });

  it('必填没填就不能提交', async () => {
    respond([
      提问({
        kind: 'form',
        title: '缺一件',
        detail: '',
        options: [],
        fields: [
          { name: 'branch', label: '分支名', multiline: false, required: true, placeholder: '' },
        ],
        defaults: [],
      }),
    ]);
    render(<McpConfirmCard />);

    const submit = await screen.findByRole('button', { name: /提交/u });
    expect(submit.hasAttribute('disabled')).toBe(true);
  });
});

describe('确认', () => {
  /*
   * `confirm` 在 ASK_KINDS 白名单里，所以它必须真的可用 ——
   * 曾经它 known=true 却没有渲染分支：卡片上只有一个裸的「提交」，
   * 点下去发的是 {selectedMany:[], fields:{}} —— 恰好是这条链路
   * 从头到尾都在防的那个空答案。
   */
  const 确认提问 = () =>
    提问({
      kind: 'confirm',
      title: '要把这 3 个文件删掉吗',
      detail: '删了就不可恢复',
      options: [],
      fields: [],
      defaults: [],
    });

  it('「是」带着明确的肯定回到 agent 手上', async () => {
    respond([确认提问()]);
    render(<McpConfirmCard />);

    await userEvent.click(await screen.findByRole('button', { name: /^是$/u }));
    await waitFor(() => expect(收到的回答).not.toBeNull());
    expect(收到的回答).toMatchObject({ answer: { selected: 'yes' } });
  });

  it('「否」是一个回答，不是「不回答」', async () => {
    // 「否」要走 answerAsk 带回 {selected:'no'} —— 走拒绝的话
    // agent 分不清「用户明确说不」和「用户不想理这个问题」
    respond([确认提问()]);
    render(<McpConfirmCard />);

    await userEvent.click(await screen.findByRole('button', { name: /^否$/u }));
    await waitFor(() => expect(收到的回答).not.toBeNull());
    expect(收到的回答).toMatchObject({ answer: { selected: 'no' } });
  });

  it('没有裸的「提交」—— 那条路发出去的是空答案', async () => {
    respond([确认提问()]);
    render(<McpConfirmCard />);

    await screen.findByRole('button', { name: /^是$/u });
    expect(screen.queryByRole('button', { name: /提交/u })).toBeNull();
    // 「不回答」始终可用：它与「否」是两件事
    expect(screen.getByRole('button', { name: /不回答/u }).hasAttribute('disabled')).toBe(false);
  });
});

describe('目录之外的东西', () => {
  it('认不出的 kind 降级成原文，不静默吞掉', async () => {
    // agent 用了一个我们不认识的组件。**至少要让用户看到它问了什么** ——
    // 吞掉的话界面上什么都没有，而 agent 那边还挂着等回答
    respond([
      提问({
        kind: '未来才有的组件',
        title: '这是个新形态',
        detail: '',
        options: [],
        fields: [],
        defaults: [],
      }),
    ]);
    render(<McpConfirmCard />);

    // 标题照常显示（原文里也有同一句，所以按角色定位而不是按文本）
    const card = await screen.findByRole('alertdialog', { name: /AI 提问/u });
    expect(card.textContent).toContain('这是个新形态');
    // 原文也摊开，用户能自己判断它在问什么
    expect(card.textContent).toContain('未来才有的组件');
    // 而「提交」是关着的 —— 界面渲染不出这个形态，收不到有意义的回答
    expect(screen.getByRole('button', { name: /提交/u }).hasAttribute('disabled')).toBe(true);
    // 「不回答」始终可用：agent 那边挂着，总得有条出路
    expect(screen.getByRole('button', { name: /不回答/u }).hasAttribute('disabled')).toBe(false);
  });

  it('关掉提问走拒绝，不带答案 —— 空答案会被当成「什么都没选」', async () => {
    let 拒绝了 = false;
    const checked = createContractCall({
      'mcp.pendingConfirms': () => ({
        items: [
          提问({
            kind: 'choice',
            title: '选一个',
            detail: '',
            options: [{ value: 'a', label: 'A', description: '' }],
            fields: [],
            defaults: [],
          }),
        ],
      }),
      'mcp.decideConfirm': (input) => {
        拒绝了 = (input as { approved: boolean }).approved === false;
        return { ok: true };
      },
      'mcp.answerAsk': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    render(<McpConfirmCard />);

    await userEvent.click(await screen.findByRole('button', { name: /不回答/u }));
    await waitFor(() => expect(拒绝了).toBe(true));
  });
});
