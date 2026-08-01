import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 新建角色时，模型下拉只能列与所选 Runtime 相符的模型。
 *
 * 第三方巡检 C-05 实测：下拉把 Claude 和 Codex 两边的模型混在一起，
 * Runtime 保持 `Codex（ACP）` 却选了 `Sonnet`（claude 侧），创建后
 * 打开新角色，模型显示 **GPT-5.2** —— 无报错、无提示，
 * 选择被丢掉换成了列表第一项。
 *
 * 「用户长期误以为自己配对了」比报错糟得多：他以为在用 Sonnet，
 * 实际每次运行跑的是另一个模型。详情区的下拉一直是按 runtime 过滤的
 * （`model.runtime === selected.runtime`），只有新建表单漏了。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');

const 两端模型 = [
  {
    id: 'model:gpt',
    name: 'GPT-5.2',
    runtime: 'acp.codex',
    modelId: 'gpt-5.2',
    effort: 'high',
    contextWindow: 400000,
    caps: ['text'],
    enabled: true,
  },
  {
    id: 'model:sonnet',
    name: 'Sonnet',
    runtime: 'acp.claude',
    modelId: 'claude-sonnet-5',
    effort: 'high',
    contextWindow: 200000,
    caps: ['text'],
    enabled: true,
  },
];

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'agent.list': () => ({ items: [], total: 0 }),
    'model.list': () => ({ items: 两端模型, total: 两端模型.length }),
    'agent.create': () => ({ id: 'agent_new' }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

const view = () =>
  render(
    <MemoryRouter>
      <AgentsPage />
    </MemoryRouter>,
  );

async function 打开新建表单(user: ReturnType<typeof userEvent.setup>) {
  view();
  await user.click(await screen.findByRole('button', { name: /新建角色/u }));
  return screen.getByRole('form', { name: '新建角色' });
}

describe('新建角色的模型下拉按 Runtime 过滤', () => {
  it('选 Codex 时列不出 claude 侧的模型', async () => {
    const user = userEvent.setup();
    const form = await 打开新建表单(user);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: '模型' })).toBeTruthy();
    });
    const 选项 = [...form.querySelectorAll('option')].map((o) => o.textContent);
    expect(选项, 'claude 侧的 Sonnet 不该出现在 Codex 角色的候选里').not.toContain('Sonnet');
    expect(选项).toContain('GPT-5.2');
  });

  it('换成 Claude 后列出的是 claude 侧的', async () => {
    const user = userEvent.setup();
    const form = await 打开新建表单(user);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Runtime' }), 'acp.claude');

    await waitFor(() => {
      const 选项 = [...form.querySelectorAll('option')].map((o) => o.textContent);
      expect(选项).toContain('Sonnet');
      expect(选项).not.toContain('GPT-5.2');
    });
  });

  it('换 Runtime 时把已选的跨端模型换成本端第一条，不留一个存不下去的值', async () => {
    const user = userEvent.setup();
    await 打开新建表单(user);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Runtime' }), 'acp.claude');

    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement).value).toBe(
        'model:sonnet',
      );
    });
  });

  it('创建时发出去的就是用户看到的那个 —— 不能被静默替换', async () => {
    const user = userEvent.setup();
    await 打开新建表单(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Runtime' }), 'acp.claude');
    await user.type(screen.getByRole('textbox', { name: '名称' }), '测试角色');
    await user.type(screen.getByRole('textbox', { name: '角色' }), '测试');

    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'agent.create',
        expect.objectContaining({ runtime: 'acp.claude', modelRef: 'model:sonnet' }),
      );
    });
  });

  it('默认那一端没有模型时退到有的那一端，而不是给一个空下拉', async () => {
    // 「优先 codex」是偏好不是「绝不用 claude」——
    // 只装了 claude adapter 的机器上，默认停在 codex 会让用户
    // 对着空下拉，而他其实有可用模型
    const checked = createContractCall({
      'agent.list': () => ({ items: [], total: 0 }),
      'model.list': () => ({ items: [两端模型[1]!], total: 1 }),
      'agent.create': () => ({ id: 'agent_new' }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    await 打开新建表单(user); // 默认 codex，而库里只有 claude 侧的模型

    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: 'Runtime' }) as HTMLSelectElement).value).toBe(
        'acp.claude',
      );
      expect((screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement).value).toBe(
        'model:sonnet',
      );
    });
  });

  it('用户自己选过 Runtime 之后不再被退路改掉', async () => {
    const checked = createContractCall({
      'agent.list': () => ({ items: [], total: 0 }),
      'model.list': () => ({ items: [两端模型[1]!], total: 1 }),
      'agent.create': () => ({ id: 'agent_new' }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    const form = await 打开新建表单(user);
    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: 'Runtime' }) as HTMLSelectElement).value).toBe(
        'acp.claude',
      );
    });

    // 用户明确选了没有模型的那一端：尊重他的选择，并说清这一端是空的
    await user.selectOptions(screen.getByRole('combobox', { name: 'Runtime' }), 'acp.codex');

    expect((screen.getByRole('combobox', { name: 'Runtime' }) as HTMLSelectElement).value).toBe(
      'acp.codex',
    );
    expect(form.textContent, '这一端没有可用模型时要说出来').toMatch(/没有已启用的模型/u);
  });
});
