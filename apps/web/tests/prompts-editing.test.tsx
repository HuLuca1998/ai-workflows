import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 提示词库的**编辑**路径。
 *
 * 图纸在这一屏写着「框架分段可见可改」，但实现只做到了「可见」：
 * 分段渲染成 <pre>，整屏没有一个输入框，而「保存新版本」按钮就在那儿。
 * codex 报的原话是「宣称可见可改，但没有任何可编辑控件」。
 *
 * 内置条目是例外：改它等于改掉系统某处调用的行为。
 * 那不是「不给改」，是「先复制一份再改」——所以复制按钮一直在。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const USER_PROMPT = {
  id: 'prompt_1',
  group: '分析',
  name: '根因分析',
  sections: [
    { title: 'Role', body: '你是根因分析者' },
    { title: 'Task', body: '找出失败原因' },
  ],
  vars: [],
  ver: 2,
  builtin: false,
  updatedAt: '2026-07-27T10:00:00Z',
};

const BUILTIN = { ...USER_PROMPT, id: 'prompt_2', name: '记忆提议', builtin: true };

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'prompt.list': () => ({ items: [USER_PROMPT, BUILTIN] }),
    'prompt.update': () => ({ ver: 3 }),
    'prompt.create': () => ({ id: 'prompt_new' }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

async function open(name = '根因分析') {
  const user = userEvent.setup();
  render(<PromptsPage />);
  await user.click(await screen.findByText(name));
  return user;
}

describe('分段可改', () => {
  it('用户自己的提示词，每一段都是输入框', async () => {
    await open();
    expect((screen.getByLabelText('Role') as HTMLTextAreaElement).value).toBe('你是根因分析者');
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe('找出失败原因');
  });

  it('改一段不影响其余段 —— 分段存在的意义就在这', async () => {
    const user = await open();
    await user.clear(screen.getByLabelText('Task'));
    await user.type(screen.getByLabelText('Task'), '只改这段');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('prompt.update', {
        id: 'prompt_1',
        ver: 2,
        sections: [
          { title: 'Role', body: '你是根因分析者' },
          { title: 'Task', body: '只改这段' },
        ],
      });
    });
  });

  it('保存带 ver —— 和 agent.update 一样是乐观锁', async () => {
    const user = await open();
    await user.type(screen.getByLabelText('Role'), '！');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('prompt.update', expect.objectContaining({ ver: 2 }));
    });
  });

  it('没改动就保存时说清楚，而不是发一个原样回写', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('没有改动');
    expect(call).not.toHaveBeenCalledWith('prompt.update', expect.anything());
  });
});

describe('内置条目', () => {
  it('内置的分段是只读的 —— 改它等于改掉系统某处调用', async () => {
    await open('记忆提议');
    expect(screen.queryByLabelText('Role')).toBeNull();
    expect(screen.getByText('你是根因分析者')).toBeTruthy();
  });

  it('对内置点保存时指向「先复制一份」，而不是抛一个契约错误', async () => {
    const user = await open('记忆提议');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('先「复制」一份');
    expect(call).not.toHaveBeenCalledWith('prompt.update', expect.anything());
  });

  it('复制出来的副本可编辑 —— 那是「先复制再改」的下半句', async () => {
    respond({ 'prompt.list': () => ({ items: [{ ...BUILTIN, builtin: false, id: 'copy_1' }] }) });
    await open('记忆提议');
    expect(screen.getByLabelText('Role')).toBeTruthy();
  });
});

describe('新建提示词', () => {
  it('点「+」打开表单', async () => {
    const user = userEvent.setup();
    render(<PromptsPage />);
    await screen.findByText('根因分析');

    await user.click(screen.getByRole('button', { name: '新建提示词' }));
    expect(screen.getByRole('form', { name: '新建提示词' })).toBeTruthy();
  });

  it('按框架分段建出骨架 —— 用户不用自己想该写哪几段', async () => {
    const user = userEvent.setup();
    render(<PromptsPage />);
    await screen.findByText('根因分析');
    await user.click(screen.getByRole('button', { name: '新建提示词' }));

    await user.type(screen.getByLabelText('名称'), '新提示词');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'prompt.create',
        expect.objectContaining({
          name: '新提示词',
          sections: [
            { title: 'Role', body: '' },
            { title: 'Task', body: '' },
            { title: 'Context', body: '' },
            { title: 'Constraints', body: '' },
            { title: 'Output contract', body: '' },
          ],
        }),
      );
    });
  });

  it('分组默认取已有的，避免同类散在几个名字略不同的组里', async () => {
    const user = userEvent.setup();
    render(<PromptsPage />);
    await screen.findByText('根因分析');
    await user.click(screen.getByRole('button', { name: '新建提示词' }));

    expect((screen.getByLabelText('分组') as HTMLInputElement).value).toBe('分析');
  });
});
