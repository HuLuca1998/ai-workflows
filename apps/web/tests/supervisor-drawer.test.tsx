import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 主管 AI 抽屉 —— 图纸的 468px 右侧抽屉。
 *
 * 要压住的：
 * 1. 上下文显式列出 —— 用户要能判断它的回答基于什么
 * 2. Scope 常驻 —— 「AI 建议 ≠ 执行」在界面上的兜底
 * 3. 模型下拉只列已启用的
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

const MODEL = {
  id: 'model_1',
  name: 'Opus 5 · high',
  runtime: 'acp.claude',
  modelId: 'claude-opus-5',
  effort: 'high',
  contextWindow: 200_000,
  capabilities: [],
  enabled: true,
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'model.list': () => ({ items: [MODEL], total: 0 }),
    'supervisor.ask': () => ({ text: '这条工作流缺一个结束节点。', toolCalls: 2 }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = (context = {}) =>
  render(<SupervisorDrawer open context={context} onClose={vi.fn()} />);

describe('结构', () => {
  it('标题与那句「掌握全部功能」照图纸', () => {
    view();
    expect(screen.getByText('主管 AI')).toBeTruthy();
    expect(
      screen.getByText('掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置'),
    ).toBeTruthy();
  });

  it('底部常驻本次会话的 Scope，并标出未授权的部分', () => {
    view();
    expect(screen.getByText('workflow:read')).toBeTruthy();
    expect(screen.getByText('workflow:write-draft')).toBeTruthy();
    expect(screen.getByText('发布与运行未授权')).toBeTruthy();
  });

  it('关掉时不渲染', () => {
    const { container } = render(<SupervisorDrawer open={false} context={{}} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('空对话时说明能问什么', () => {
    view();
    expect(screen.getByText(/问它任何关于这个应用的事/u)).toBeTruthy();
  });
});

describe('上下文', () => {
  it('有草稿时显示 rev', () => {
    view({ draftRev: 19 });
    expect(screen.getByText('草稿 rev19')).toBeTruthy();
  });

  it('有选中节点时显示数量', () => {
    view({ selectedNodes: 7 });
    expect(screen.getByText('选中节点 7')).toBeTruthy();
  });

  it('有记忆时显示条数 —— 那些会被注入', () => {
    view({ memoryCount: 4 });
    expect(screen.getByText('记忆 4 条')).toBeTruthy();
  });

  it('没有上下文时只显示标签，不编造 chips', () => {
    view();
    const region = screen.getByLabelText('上下文');
    expect(region.textContent?.trim()).toBe('上下文');
  });
});

describe('对话', () => {
  it('模型下拉只列已启用的', async () => {
    view();
    await waitFor(() => {
      // 显式要满额：不写 limit 的话拿到分页默认值（50），
      // 第 51 条之后的已启用模型在下拉里根本不存在
      expect(call).toHaveBeenCalledWith('model.list', { enabledOnly: true, limit: 200 });
    });
  });

  it('发问后把问题与上下文一起送出', async () => {
    const user = userEvent.setup();
    view({ draftRev: 19, runId: 'run_abc123' });

    await user.type(screen.getByLabelText(/问主管 AI/u), '这条工作流缺什么？');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'supervisor.ask',
        expect.objectContaining({
          question: '这条工作流缺什么？',
          context: expect.objectContaining({ draftRev: 19, runId: 'run_abc123' }),
        }),
      );
    });
  });

  it('回答显示在对话里', async () => {
    const user = userEvent.setup();
    view();

    await user.type(screen.getByLabelText(/问主管 AI/u), '缺什么？');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('这条工作流缺一个结束节点。')).toBeTruthy();
  });

  it('⇧⏎ 换行而不是发送', async () => {
    const user = userEvent.setup();
    view();

    const input = screen.getByLabelText(/问主管 AI/u);
    await user.type(input, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(call).not.toHaveBeenCalledWith('supervisor.ask', expect.anything());
  });

  it('空输入不发送', async () => {
    const user = userEvent.setup();
    view();

    await user.click(screen.getByLabelText(/问主管 AI/u));
    await user.keyboard('{Enter}');
    expect(call).not.toHaveBeenCalledWith('supervisor.ask', expect.anything());
  });

  it('历史没存住时说出来 —— 隔天回来找不到这条对话会以为是自己记错了', async () => {
    // 第 5 轮审查 B2：三次写库全部「失败也不管」，接口照常返回成功。
    // 不丢答案是对的（用户等了几十秒），但不能假装成功
    respond({
      'supervisor.ask': () => ({
        text: '这条工作流缺一个结束节点。',
        toolCalls: 0,
        historySaved: false,
      }),
    });
    const user = userEvent.setup();
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '缺什么？');
    await user.keyboard('{Enter}');

    // 答案照常显示
    expect(await screen.findByText('这条工作流缺一个结束节点。')).toBeTruthy();
    // 但要说清这条没进历史
    expect(await screen.findByText(/没能存进历史/u)).toBeTruthy();
  });

  it('存住了就不提 —— 那是常态，说了是噪音', async () => {
    const user = userEvent.setup();
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '缺什么？');
    await user.keyboard('{Enter}');
    await screen.findByText('这条工作流缺一个结束节点。');

    expect(screen.queryByText(/没能存进历史/u)).toBeNull();
  });

  it('失败时报错，并且不留一个空气泡', async () => {
    respond({
      'supervisor.ask': () => {
        throw new Error('连不上 adapter');
      },
    });
    const user = userEvent.setup();
    view();

    await user.type(screen.getByLabelText(/问主管 AI/u), '试试');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('连不上 adapter');
    expect(screen.queryByText('正在想…')).toBeNull();
  });
});

describe('等待与取消', () => {
  it('超过一定时间说明它在等什么 —— 而不是一直「正在想…」', async () => {
    // codex 自主体验时的原话：「连续等待 30 秒仍没有回复、超时提示或取消入口；
    // 控制台也没有可见错误」。它恰好是在首次配置受阻后最需要帮助的时候点的这里。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respond({ 'supervisor.ask': () => new Promise(() => {}) });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '怎么用');
    await user.keyboard('{Enter}');

    await vi.advanceTimersByTimeAsync(8_000);
    expect(screen.getByText(/已等待/u)).toBeTruthy();
    vi.useRealTimers();
  });

  it('等待时给取消按钮 —— 用户要能脱身', async () => {
    respond({ 'supervisor.ask': () => new Promise(() => {}) });
    const user = userEvent.setup();
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '怎么用');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('取消后在对话里留一条回执 —— 不留的话像是自己没点上', async () => {
    // codex 两轮都提：「取消后等待状态消失并恢复『发送』，
    // 但消息区只剩原问题，没有『已取消』、取消时间或原因」。
    // 用户按了取消，界面上什么都没变化 —— 那和没按上是一样的观感
    respond({ 'supervisor.ask': () => new Promise(() => {}) });
    const user = userEvent.setup();
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '怎么用');
    await user.keyboard('{Enter}');

    await user.click(await screen.findByRole('button', { name: '取消' }));

    expect(await screen.findByText(/已取消/u)).toBeTruthy();
  });

  it('取消回执写明等了多久 —— 那是用户判断要不要换个模型的依据', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respond({ 'supervisor.ask': () => new Promise(() => {}) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '怎么用');
    await user.keyboard('{Enter}');

    await vi.advanceTimersByTimeAsync(12_000);
    await user.click(await screen.findByRole('button', { name: '取消' }));

    expect(await screen.findByText(/等待 12 秒后已取消/u)).toBeTruthy();
    vi.useRealTimers();
  });

  it('取消后回到可以再问的状态，且不留空气泡', async () => {
    respond({ 'supervisor.ask': () => new Promise(() => {}) });
    const user = userEvent.setup();
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '怎么用');
    await user.keyboard('{Enter}');

    await user.click(await screen.findByRole('button', { name: '取消' }));

    expect(screen.queryByText('正在想…')).toBeNull();
    expect(screen.getByLabelText(/问主管 AI/u)).toBeEnabled();
    // 问题本身留着 —— 用户可能只是想换个模型再问一次
    expect(screen.getByText('怎么用')).toBeTruthy();
  });

  it('取消之后即使后端回来了也不显示 —— 那已经不是用户要的了', async () => {
    let resolve: (value: unknown) => void = () => {};
    respond({
      'supervisor.ask': () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const user = userEvent.setup();
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '怎么用');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: '取消' }));

    resolve({ text: '迟到的回答', toolCalls: 0 });
    await waitFor(() => {
      expect(screen.queryByText('迟到的回答')).toBeNull();
    });
  });

  it('答完就没有取消按钮了', async () => {
    const user = userEvent.setup();
    view();
    await user.type(screen.getByLabelText(/问主管 AI/u), '缺什么？');
    await user.keyboard('{Enter}');
    await screen.findByText('这条工作流缺一个结束节点。');

    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
  });
});
