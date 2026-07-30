import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 改了名字没保存，点另一条 —— 改动被 `setDraft({})` 静默丢掉。
 *
 * 这一屏的编辑是「改完点保存」而不是即时保存，所以切走这个动作本身
 * 不该销毁数据；用户也没有任何提示，回来才发现名字还是旧的。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');

function agent(id: string, name: string) {
  return {
    id,
    name,
    role: '分析师',
    goal: '定位根因',
    persona: '先读代码再下结论',
    runtime: 'acp.codex',
    modelRef: 'model_1',
    tools: [],
    capabilities: { file: 'read', command: 'none', network: 'none', memory: 'none', secret: [] },
    outputContract: '',
    turnLimit: 12,
    timeoutMs: 900_000,
    ver: 1,
    builtin: false,
  };
}

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'agent.list': () => ({ items: [agent('a1', '角色甲'), agent('a2', '角色乙')], total: 2 }),
    'model.list': () => ({
      items: [
        {
          id: 'model_1',
          name: '模型甲',
          runtime: 'acp.codex',
          modelId: 'gpt-x',
          effort: 'medium',
          contextWindow: 200000,
          capabilities: [],
          enabled: true,
        },
      ],
      total: 1,
    }),
    'agent.update': () => ({ ver: 2 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('未保存的改动', () => {
  it('切到另一条时要拦一下，而不是悄悄丢掉', async () => {
    const user = userEvent.setup();
    render(<AgentsPage />);

    await user.click(await screen.findByText('角色甲'));
    const name = await screen.findByLabelText('角色名称');
    await user.clear(name);
    await user.type(name, '改过的名字');

    await user.click(screen.getByText('角色乙'));

    // 拦住了：还停在角色甲，改动还在
    await waitFor(() => {
      expect(screen.getByText(/未保存/u)).toBeTruthy();
    });
    expect(screen.getByLabelText('角色名称')).toHaveValue('改过的名字');

    // 明确选择放弃之后才真的切走
    await user.click(screen.getByRole('button', { name: /放弃改动/u }));
    await waitFor(() => {
      expect(screen.getByLabelText('角色名称')).toHaveValue('角色乙');
    });
  });

  it('没改过就直接切，不打扰', async () => {
    const user = userEvent.setup();
    render(<AgentsPage />);

    await user.click(await screen.findByText('角色甲'));
    await screen.findByLabelText('角色名称');
    await user.click(screen.getByText('角色乙'));

    await waitFor(() => {
      expect(screen.getByLabelText('角色名称')).toHaveValue('角色乙');
    });
    expect(screen.queryByText(/未保存/u)).toBeNull();
  });
});

/**
 * 提示词页同一个坑：改了正文没保存、点另一条，`setSections(null)` 就把
 * 改动丢了。Agent 页已经拦了，这页没跟上 —— 同一类坑修一半比不修更难发现，
 * 用户会以为「这一屏也会拦我」。
 */
describe('提示词页的未保存改动', () => {
  it('切到另一条时也要拦一下', async () => {
    const { createContractCall: 建 } = await import('./_contractClient.js');
    const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

    function prompt(id: string, name: string) {
      return {
        id,
        group: '系统内建 · 节点',
        name,
        sections: [{ title: 'Role', body: `${name} 的正文` }],
        vars: [],
        ver: 1,
        builtin: false,
        updatedAt: '2026-07-27T10:00:00Z',
      };
    }

    const checked = 建({
      'prompt.list': () => ({ items: [prompt('p1', '提示甲'), prompt('p2', '提示乙')], total: 2 }),
      'prompt.update': () => ({ ver: 2 }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(<PromptsPage />);

    await user.click(await screen.findByText('提示甲'));
    const body = await screen.findByLabelText('Role');
    await user.type(body, '改一句');

    await user.click(screen.getByText('提示乙'));
    expect(await screen.findByText(/未保存/u)).toBeTruthy();
    expect(screen.getByLabelText('Role')).toHaveValue('提示甲 的正文改一句');

    await user.click(screen.getByRole('button', { name: /放弃改动/u }));
    await waitFor(() => {
      expect(screen.getByLabelText('Role')).toHaveValue('提示乙 的正文');
    });
  });
});
