import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 登记模型的表单不是 `<form>`：
 *
 * - 在输入框里按回车什么都不会发生（浏览器的默认提交要有 form 才成立），
 *   而这是填表最自然的收尾动作
 * - 「上下文窗口」是 `type="text"` + `Number(...)`，填「abc」得到 NaN，
 *   `.trim()` 那道校验只看非空，于是 NaN 被发到后端
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'model.list': () => ({ items: [], total: 0 }),
    'model.create': () => ({ id: 'model_new' }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function openForm() {
  const user = userEvent.setup();
  render(<ModelsPage />);
  await user.click(await screen.findByRole('button', { name: /登记模型/u }));
  return user;
}

describe('登记模型表单', () => {
  it('填完在输入框里按回车就能提交', async () => {
    const user = await openForm();
    await user.type(screen.getByLabelText('名称'), '我的模型');
    await user.type(screen.getByLabelText('模型 ID'), 'gpt-x');
    await user.type(screen.getByLabelText('上下文窗口'), '200000{Enter}');

    expect(call.mock.calls.filter(([m]) => m === 'model.create')).toHaveLength(1);
  });

  it('上下文窗口填了非数字就拦下，不把 NaN 发给后端', async () => {
    const user = await openForm();
    await user.type(screen.getByLabelText('名称'), '我的模型');
    await user.type(screen.getByLabelText('模型 ID'), 'gpt-x');
    await user.type(screen.getByLabelText('上下文窗口'), 'abc');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(call.mock.calls.filter(([m]) => m === 'model.create')).toHaveLength(0);
    expect((await screen.findByRole('alert')).textContent).toContain('上下文窗口');
  });
});
