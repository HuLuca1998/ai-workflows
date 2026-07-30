import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 内置条目是只读的，界面得从头到尾这么表现。
 *
 * 提示词页：「保存新版本」在内置条目上仍是那个最显眼的紫色主按钮，
 * 点下去必然弹一句「内置提示词不能直接改」—— 那句话应该长在按钮上，
 * 而不是等用户点完才说。
 *
 * Agent 页：权限、工具、输出契约在内置角色上都是只读的，
 * 而名称、目标、性格三个输入框照样能改 —— 改完保存同样必然被拒。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');

const PROMPT = {
  id: 'p1',
  group: '系统内建 · 节点',
  name: '分析 · 根因',
  sections: [{ title: 'Role', body: '你是一名代码分析师。' }],
  vars: [],
  ver: 4,
  builtin: true,
  updatedAt: '2026-07-27T10:00:00Z',
};

const AGENT = {
  id: 'a1',
  name: '内置分析',
  role: '分析师',
  goal: '定位根因',
  persona: '严谨',
  runtime: 'acp.codex',
  modelRef: 'model_1',
  tools: [],
  capabilities: { file: 'read', command: 'none', network: 'none', memory: 'none', secret: [] },
  outputContract: '',
  turnLimit: 12,
  timeoutMs: 900_000,
  ver: 1,
  builtin: true,
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'prompt.list': () => ({ items: [PROMPT], total: 1 }),
    'prompt.update': () => ({ ver: 5 }),
    'agent.list': () => ({ items: [AGENT], total: 1 }),
    'agent.update': () => ({ ver: 2 }),
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
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('内置提示词', () => {
  it('「保存新版本」不该是可点的主按钮 —— 点了必然被拒', async () => {
    const user = userEvent.setup();
    render(<PromptsPage />);
    await user.click(await screen.findByText('分析 · 根因'));

    const save = screen.getByRole('button', { name: /保存新版本/u });
    expect(save).toBeDisabled();
    // 而且要说清楚出路在哪
    expect(save.title).toContain('复制');
  });
});

describe('内置角色', () => {
  it('名称/目标/性格与权限一样只读 —— 不能一半能改一半不能', async () => {
    const user = userEvent.setup();
    render(<AgentsPage />);
    await user.click(await screen.findByText('内置分析'));

    expect(screen.getByLabelText('角色名称')).toHaveAttribute('readonly');
    expect(await screen.findByLabelText('目标')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('性格与指令')).toHaveAttribute('readonly');
  });
});
