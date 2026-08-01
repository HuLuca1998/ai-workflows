import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * agent 忙时用户打的字要进队列，不能丢。
 *
 * 用户报的：「别的工具都有用户消息队列，可以撤回，或者在 ai 读之前可以修改」。
 * 而这一屏原来是 `send()` 首行 `if (!text || busy) return` —— **直接丢弃**，
 * 输入框还 `disabled={busy}`：用户想补一句「等等，改成 X」只能干等几十秒，
 * 等完还得自己重打一遍。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

/** 一轮要多久答完由这个 promise 决定 —— 测试里手动放行。 */
let 放行: (() => void) | null = null;

function respond(options: { slow?: boolean } = {}) {
  const checked = createContractCall({
    'supervisor.sessions': () => ({ items: [] }),
    'model.list': () => ({ items: [], total: 0 }),
    'supervisor.ask': async () => {
      if (options.slow) {
        await new Promise<void>((resolve) => {
          放行 = resolve;
        });
      }
      return { text: '答完了', historySaved: true };
    },
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
}

beforeEach(() => {
  call.mockReset();
  放行 = null;
  respond({ slow: true });
});

const view = () => render(<SupervisorDrawer open context={{}} onClose={vi.fn()} />);

async function 发一条并等它忙(user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = await screen.findByRole('textbox', { name: /问主管 AI/u });
  await user.type(input, text);
  await user.click(screen.getByRole('button', { name: '发送' }));
  // busy 的判据：取消按钮出现了
  await screen.findByRole('button', { name: '取消' });
  return input;
}

describe('agent 忙时打的字不丢', () => {
  it('输入框不再被禁用 —— 用户要能继续打', async () => {
    const user = userEvent.setup();
    view();
    const input = await 发一条并等它忙(user, '第一个问题');

    expect(input, 'busy 时输入框被禁掉，用户连打字都不行').not.toBeDisabled();
  });

  it('忙时发送 → 进队列，不是消失', async () => {
    const user = userEvent.setup();
    view();
    const input = await 发一条并等它忙(user, '第一个问题');

    await user.type(input, '等等，补一句');
    await user.keyboard('{Enter}');

    const queue = await screen.findByRole('list', { name: '待发消息' });
    expect(queue.textContent).toContain('等等，补一句');
  });

  it('队列里的能撤回', async () => {
    const user = userEvent.setup();
    view();
    const input = await 发一条并等它忙(user, '第一个问题');
    await user.type(input, '要撤回的');
    await user.keyboard('{Enter}');

    await user.click(await screen.findByRole('button', { name: /撤回：要撤回的/u }));

    await waitFor(() => {
      expect(screen.queryByRole('list', { name: '待发消息' })).toBeNull();
    });
  });

  it('队列里的能改 —— AI 读之前用户还能反悔', async () => {
    const user = userEvent.setup();
    view();
    const input = await 发一条并等它忙(user, '第一个问题');
    await user.type(input, '打错的');
    await user.keyboard('{Enter}');

    await user.click(await screen.findByRole('button', { name: /修改：打错的/u }));
    const editBox = await screen.findByRole('textbox', { name: /修改待发消息/u });
    await user.clear(editBox);
    await user.type(editBox, '改对的');
    await user.keyboard('{Enter}');

    const queue = await screen.findByRole('list', { name: '待发消息' });
    expect(queue.textContent).toContain('改对的');
    expect(queue.textContent).not.toContain('打错的');
  });

  it('这一轮答完，队列里的自动发出去', async () => {
    const user = userEvent.setup();
    view();
    const input = await 发一条并等它忙(user, '第一个问题');
    await user.type(input, '排队的那条');
    await user.keyboard('{Enter}');
    await screen.findByRole('list', { name: '待发消息' });

    // 第一轮答完
    放行?.();

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'supervisor.ask',
        expect.objectContaining({ question: '排队的那条' }),
      );
    });
  });

  it('取消时队列一起清 —— 那些话是针对已经没了的上下文说的', async () => {
    const user = userEvent.setup();
    view();
    const input = await 发一条并等它忙(user, '第一个问题');
    await user.type(input, '排队的');
    await user.keyboard('{Enter}');
    await screen.findByRole('list', { name: '待发消息' });

    await user.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('list', { name: '待发消息' })).toBeNull();
    });
  });

  it('不忙时照常直接发，不进队列', async () => {
    respond({ slow: false });
    const user = userEvent.setup();
    view();
    const input = await screen.findByRole('textbox', { name: /问主管 AI/u });
    await user.type(input, '直接发');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'supervisor.ask',
        expect.objectContaining({ question: '直接发' }),
      );
    });
    expect(screen.queryByRole('list', { name: '待发消息' })).toBeNull();
  });
});
