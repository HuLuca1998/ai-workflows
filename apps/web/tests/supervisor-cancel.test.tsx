import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「取消」要真的把 agent 叫停，不能只是界面显示「已取消」。
 *
 * ## 这条守的是什么
 *
 * 原来那个按钮是**纯前端**的：换一个自增号码把回来的答案丢掉、
 * 界面上留一条「已取消」的回执 —— 而 agent 那边照说不误。
 * 后果三条，用户一条都看不见：
 *
 * · 配额照烧（一轮真实对话 10 到 30 秒）
 * · 会话槽位照占，他接着发的下一句要排在这一轮后面才轮得到
 * · 那一轮的工具调用照做 —— 而主管 AI 手上有 51 个系统 MCP 工具，
 *   其中有写操作
 *
 * 这是「界面文案承诺了一件事，实现里没有对应代码」那一档。
 *
 * ## 判据
 *
 * 按下取消之后 **`supervisor.cancel` 这条命令真的被发出去了**，
 * 并且带着当前会话 id —— 光看界面上有没有「已取消」是看不出来的，
 * 那一行原来就有。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

/** 这一轮答不完，直到测试放行 —— 「正在跑」是这条测试的前提。 */
let 放行: (() => void) | null = null;

function 慢答(sessionId: string | undefined = 'sess_1') {
  const checked = createContractCall({
    'supervisor.sessions': () => ({ items: [] }),
    'model.list': () => ({ items: [], total: 0 }),
    'supervisor.cancel': () => ({ cancelled: true }),
    'supervisor.ask': async () => {
      await new Promise<void>((resolve) => {
        放行 = resolve;
      });
      return { text: '答完了', historySaved: true, ...(sessionId ? { sessionId } : {}) };
    },
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
}

/** 问一句并等到「取消」按钮出现（= 这一轮真的在跑）。 */
async function 问一句(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox'), '帮我建一条工作流');
  await user.click(screen.getByRole('button', { name: '发送' }));
  return screen.findByRole('button', { name: '取消' });
}

beforeEach(() => {
  call.mockReset();
  放行 = null;
});

describe('取消要真的叫停 agent', () => {
  it('按下取消会发出 supervisor.cancel', async () => {
    慢答();
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);

    // 第一轮先跑完，拿到 sessionId —— 取消要带着它
    await user.type(screen.getByRole('textbox'), '你好');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '取消' });
    放行?.();
    await screen.findByRole('button', { name: '发送' });

    const 取消 = await 问一句(user);
    call.mockClear();
    await user.click(取消);

    const 发出的 = call.mock.calls.find(([method]) => method === 'supervisor.cancel');
    expect(
      发出的,
      '按了取消却没发 supervisor.cancel —— 界面显示「已取消」而 agent 照说不误：' +
        `实际发出的是 ${JSON.stringify(call.mock.calls.map(([m]) => m))}`,
    ).toBeTruthy();
    expect(发出的?.[1]).toMatchObject({ sessionId: 'sess_1' });

    放行?.();
  });

  it('取消命令失败也不拦住用户 —— 界面照样回到可输入', async () => {
    /*
     * 那一轮刚好已经答完时，后端会回 `cancelled: false`；
     * 更极端的情况是命令本身报错（adapter 进程没了）。
     *
     * 两种都不该弹红条：用户要的是「别说了」，而界面这一侧已经做到了。
     * 把一个技术性失败甩给他，只会让他以为取消没生效而再按几次。
     */
    const checked = createContractCall({
      'supervisor.sessions': () => ({ items: [] }),
      'model.list': () => ({ items: [], total: 0 }),
      'supervisor.cancel': () => {
        throw new Error('adapter 进程已退出');
      },
      'supervisor.ask': async () => {
        await new Promise<void>((resolve) => {
          放行 = resolve;
        });
        return { text: '答完了', historySaved: true, sessionId: 'sess_1' };
      },
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);
    await user.type(screen.getByRole('textbox'), '你好');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '取消' });
    放行?.();
    await screen.findByRole('button', { name: '发送' });

    const 取消 = await 问一句(user);
    await user.click(取消);

    expect(await screen.findByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.queryByText(/adapter 进程已退出/)).toBeNull();
    放行?.();
  });

  it('还没有会话 id 时不发 —— 那一轮在池子里没有 key，发了也找不到', async () => {
    // 第一句话还没答完就取消：sessionId 要等回答才有。
    // 硬发一条 sessionId 为空的命令，只会在契约那一层被拒
    慢答(undefined);
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={{}} onClose={() => {}} />);

    const 取消 = await 问一句(user);
    call.mockClear();
    await user.click(取消);

    expect(call.mock.calls.filter(([m]) => m === 'supervisor.cancel')).toHaveLength(0);
    放行?.();
  });
});
