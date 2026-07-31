import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * 主管 AI 的流式展示。
 *
 * 在这之前一轮对话要几十秒，而界面上只有一个转圈 —— 用户唯一能判断
 * 「它还活着吗」的方式是继续等。这份测试压着两件事：
 *
 * 1. 帧真的落到那条 streaming 消息上（不是攒完才显示）；
 * 2. **取消之后不再往界面上写** —— 否则「已取消」下面还会继续冒字，
 *    而那正是用户刚放弃的那一问。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

/** Tauri 的事件通道替身：把监听器抓在手里，测试自己发帧。 */
let 发帧: ((payload: unknown) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    发帧 = (payload) => handler({ payload });
    return Promise.resolve(() => {
      发帧 = null;
    });
  },
}));

// 流式只在桌面形态挂 —— Web 侧还没有推送通道
vi.mock('../src/updater/useAppVersion.js', () => ({
  isDesktopRuntime: () => true,
  useAppVersion: () => null,
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

beforeEach(() => {
  call.mockReset();
  发帧 = null;
});

/** 让 supervisor.ask 挂着不返回 —— 流式发生在「还没回来」那段时间里。 */
function 挂起提问() {
  const checked = createContractCall({
    'model.list': () => ({
      items: [
        {
          id: 'm1',
          name: 'Codex',
          runtime: 'acp.codex',
          modelId: 'gpt-5.6-sol',
          effort: 'high',
          contextWindow: 400000,
          capabilities: [],
          enabled: true,
        },
      ],
      total: 1,
    }),
    'model.sync': () => ({
      models: [{ value: 'gpt-5.6-sol', label: 'Sol', description: '' }],
      efforts: [{ value: 'high', label: 'High', description: '' }],
      currentModel: 'gpt-5.6-sol',
      currentEffort: 'high',
      added: 0,
    }),
    'workspace.settings': () => ({}),
    'supervisor.sessions': () => ({ items: [] }),
    'supervisor.ask': () => new Promise(() => {}),
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

async function 提问() {
  const { default: userEvent } = await import('@testing-library/user-event');
  const box = await screen.findByRole('textbox');
  await userEvent.type(box, '帮我看看');
  await userEvent.keyboard('{Enter}');
}

describe('主管 AI 的流式', () => {
  it('帧边到边显示，不是攒完才出现', async () => {
    挂起提问();
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);
    await 提问();

    // 挂上监听之前不发帧 —— 挂载是异步的（动态 import）
    await waitFor(() => expect(发帧).not.toBeNull());

    发帧?.({ kind: 'text', text: '这条工作流' });
    expect(await screen.findByText(/这条工作流/u)).toBeTruthy();

    // 第二帧接在后面，而不是替换掉
    发帧?.({ kind: 'text', text: '有三个节点' });
    expect(await screen.findByText(/这条工作流有三个节点/u)).toBeTruthy();
  });

  it('工具调用显示成「正在做什么」，而不是干等', async () => {
    挂起提问();
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);
    await 提问();
    await waitFor(() => expect(发帧).not.toBeNull());

    发帧?.({ kind: 'toolCall', title: '读取 workflow.json', status: 'in_progress' });

    // 「正在想…」挂十几秒与卡死长得一模一样，而这句不会
    expect(await screen.findByText(/读取 workflow.json/u)).toBeTruthy();
  });

  it('取消之后不再往界面上写', async () => {
    挂起提问();
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);
    await 提问();
    await waitFor(() => expect(发帧).not.toBeNull());
    发帧?.({ kind: 'text', text: '开头' });
    await screen.findByText(/开头/u);

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /取消/u }));

    // 取消后来的帧要被丢掉：显示出来会让用户以为取消没生效
    发帧?.({ kind: 'text', text: '不该出现的后续' });
    await waitFor(() => {
      expect(screen.queryByText(/不该出现的后续/u)).toBeNull();
    });
  });
});
