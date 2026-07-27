import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Agent 角色的**编辑**路径。
 *
 * codex 用真实浏览器点了一遍，发现这一屏「看得见但改不了」：
 * 「+」按钮点了没反应、模型下拉选完立刻弹回、保存报「入参不合契约」。
 * 根因有两个，都在这里各钉一条：
 *
 * 1. 详情区是**只读展示**——受控 select 有 value 没 onChange，
 *    React 会把用户的选择直接丢掉。
 * 2. update 是**乐观锁**接口，少发 ver 时后端无从判断改动基于哪一版，
 *    契约层就拒了。错误信息只说「不合契约」，用户完全无从下手。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');

const AGENT = {
  id: 'agent_1',
  name: '分析 Agent',
  role: '根因分析',
  goal: '找出失败的根因',
  persona: '克制、只讲证据',
  runtime: 'acp.claude',
  modelRef: 'model_1',
  tools: ['read'],
  capabilities: { fileRead: true, fileWrite: false, network: 'none' },
  outputContract: '',
  turnLimit: 12,
  timeoutMs: 900_000,
  ver: 3,
  builtin: false,
};

const MODELS = [
  { id: 'model_1', name: 'Opus 5 · high' },
  { id: 'model_2', name: 'Sonnet 5 · medium' },
];

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'agent.list': () => ({ items: [AGENT] }),
    'model.list': () => ({ items: MODELS.map(full) }),
    'agent.update': () => ({ ver: 4 }),
    'agent.create': () => ({ id: 'agent_new' }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

function full(model: { id: string; name: string }) {
  return {
    ...model,
    runtime: 'acp.claude',
    modelId: 'claude-opus-5',
    effort: 'high',
    contextWindow: 200_000,
    capabilities: [],
    enabled: true,
  };
}

beforeEach(() => {
  call.mockReset();
  respond();
});

async function open() {
  const user = userEvent.setup();
  render(<AgentsPage />);
  await user.click(await screen.findByText('分析 Agent'));
  return user;
}

describe('详情区可编辑', () => {
  it('改模型后下拉保持新选择 —— 不弹回原值', async () => {
    const user = await open();
    const select = screen.getByLabelText('模型') as HTMLSelectElement;

    await user.selectOptions(select, 'model_2');
    expect(select.value).toBe('model_2');
  });

  it('保存带上 ver —— update 是乐观锁接口', async () => {
    const user = await open();
    await user.selectOptions(screen.getByLabelText('模型'), 'model_2');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('agent.update', {
        id: 'agent_1',
        ver: 3,
        modelRef: 'model_2',
      });
    });
  });

  it('只发改过的字段 —— 全量回写会盖掉并发的其他改动', async () => {
    const user = await open();
    await user.clear(screen.getByLabelText('目标'));
    await user.type(screen.getByLabelText('目标'), '新目标');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('agent.update', {
        id: 'agent_1',
        ver: 3,
        goal: '新目标',
      });
    });
  });

  it('没改动就点保存时说清楚，而不是发一个空请求', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('没有改动');
    expect(call).not.toHaveBeenCalledWith('agent.update', expect.anything());
  });

  it('引用的模型已停用时保留它并标出来 —— 不静默跳到第一项', async () => {
    // 模型页停用了 model_1，enabledOnly 就不再返回它
    respond({ 'model.list': () => ({ items: [full(MODELS[1]!)] }) });
    const user = await open();
    void user;

    const select = screen.getByLabelText('模型') as HTMLSelectElement;
    expect(select.value).toBe('model_1');
    expect(screen.getByText(/model_1（已停用或已删除）/u)).toBeTruthy();
  });
});

describe('新建角色', () => {
  it('点「+」打开表单 —— 而不是什么都不发生', async () => {
    const user = userEvent.setup();
    render(<AgentsPage />);
    await screen.findByText('分析 Agent');

    await user.click(screen.getByRole('button', { name: '新建角色' }));
    expect(screen.getByRole('form', { name: '新建角色' })).toBeTruthy();
  });

  it('名称与角色是必填 —— 没填完创建按钮不可点', async () => {
    const user = userEvent.setup();
    render(<AgentsPage />);
    await screen.findByText('分析 Agent');
    await user.click(screen.getByRole('button', { name: '新建角色' }));

    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
    await user.type(screen.getByLabelText('名称'), '审查 Agent');
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
    await user.type(screen.getByLabelText('角色'), '代码审查');
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
  });

  it('创建时补齐契约要求的字段', async () => {
    const user = userEvent.setup();
    render(<AgentsPage />);
    await screen.findByText('分析 Agent');
    await user.click(screen.getByRole('button', { name: '新建角色' }));

    await user.type(screen.getByLabelText('名称'), '审查 Agent');
    await user.type(screen.getByLabelText('角色'), '代码审查');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'agent.create',
        expect.objectContaining({
          name: '审查 Agent',
          role: '代码审查',
          runtime: 'acp.claude',
          modelRef: 'model_1',
        }),
      );
    });
  });

  it('一个模型都没登记时说清楚该先去哪 —— 而不是给一个空下拉', async () => {
    respond({ 'model.list': () => ({ items: [] }) });
    const user = userEvent.setup();
    render(<AgentsPage />);
    await screen.findByText('分析 Agent');
    await user.click(screen.getByRole('button', { name: '新建角色' }));

    expect(screen.getByText('先去「模型」页登记一个')).toBeTruthy();
  });
});
