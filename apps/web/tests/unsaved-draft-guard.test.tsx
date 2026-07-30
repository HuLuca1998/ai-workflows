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
    const name = await screen.findByLabelText("角色名称");
    await user.clear(name);
    await user.type(name, '改过的名字');

    await user.click(screen.getByText('角色乙'));

    // 拦住了：还停在角色甲，改动还在
    await waitFor(() => {
      expect(screen.getByText(/未保存/u)).toBeTruthy();
    });
    expect(screen.getByLabelText("角色名称")).toHaveValue('改过的名字');

    // 明确选择放弃之后才真的切走
    await user.click(screen.getByRole('button', { name: /放弃改动/u }));
    await waitFor(() => {
      expect(screen.getByLabelText("角色名称")).toHaveValue('角色乙');
    });
  });

  it('没改过就直接切，不打扰', async () => {
    const user = userEvent.setup();
    render(<AgentsPage />);

    await user.click(await screen.findByText('角色甲'));
    await screen.findByLabelText("角色名称");
    await user.click(screen.getByText('角色乙'));

    await waitFor(() => {
      expect(screen.getByLabelText("角色名称")).toHaveValue('角色乙');
    });
    expect(screen.queryByText(/未保存/u)).toBeNull();
  });
});
