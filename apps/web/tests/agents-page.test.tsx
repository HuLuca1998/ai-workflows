import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Agent 角色 —— 图纸「05 Agent 角色」。
 *
 * 这一屏要压住的产品规则：
 * 1.「节点引用角色而不是复制 Prompt；角色升级后引用它的节点一并生效」
 * 2.「权限（引擎强制，Prompt 无法越权）」—— 权限展示要说明它由引擎兜底
 * 3.「下拉只列出模型页里已启用的条目」
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
  role: '分析师',
  goal: '定位根因，给出可验证的方案',
  persona: '先读代码再下结论；不确定时说不确定。',
  runtime: 'acp.claude',
  modelRef: 'model_opus',
  tools: ['read', 'grep'],
  capabilities: { fileRead: true, fileWrite: false, network: 'none' },
  outputContract: '结构化 JSON',
  turnLimit: 12,
  timeoutMs: 900_000,
  ver: 3,
  builtin: false,
};

const MODEL = {
  id: 'model_opus',
  name: 'Opus 5 · high',
  runtime: 'acp.claude',
  modelId: 'claude-opus-5',
  effort: 'high',
  contextWindow: 200_000,
  capabilities: ['结构化输出'],
  enabled: true,
};

function respond(handlers: Record<string, (input: unknown) => unknown>) {
  const checked = createContractCall({
    'agent.list': () => ({ items: [AGENT], total: 0 }),
    'model.list': () => ({ items: [MODEL], total: 0 }),
    'agent.create': () => ({ id: 'agent_new' }),
    'agent.update': () => ({ ok: true }),
    'agent.delete': () => ({ ok: true }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond({});
});

const view = () => render(<AgentsPage />);

describe('角色列表', () => {
  it('列出角色，带上版本号', async () => {
    view();
    const item = await screen.findByRole('button', { name: /分析 Agent/u });
    expect(item.textContent).toContain('v3');
  });

  it('底部常驻那句关于「引用而不是复制」的说明', async () => {
    view();
    expect(
      await screen.findByText('节点引用角色而不是复制 Prompt；角色升级后引用它的节点一并生效。'),
    ).toBeTruthy();
  });

  it('一个角色都没有时说明这里会出现什么', async () => {
    respond({ 'agent.list': () => ({ items: [], total: 0 }) });
    view();
    expect(await screen.findByText(/还没有 Agent 角色/u)).toBeTruthy();
  });

  it('内置角色标出来', async () => {
    respond({ 'agent.list': () => ({ items: [{ ...AGENT, builtin: true }], total: 1 }) });
    view();
    const item = await screen.findByRole('button', { name: /分析 Agent/u });
    expect(item.textContent).toContain('内置');
  });
});

describe('角色详情', () => {
  it('四块内容照图纸：角色与目标、性格与指令、模型与 Runtime、权限与工具', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));

    const detail = screen.getByRole('region', { name: '角色详情' });
    expect(detail.textContent).toContain('分析师');
    expect(detail.textContent).toContain('定位根因，给出可验证的方案');
    expect(detail.textContent).toContain('先读代码再下结论');
    expect(detail.textContent).toContain('结构化 JSON');
  });

  it('权限那块说明它由引擎强制，Prompt 无法越权', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    expect(screen.getByText('权限（引擎强制，Prompt 无法越权）')).toBeTruthy();
  });

  it('底部说明节点能覆盖什么、不能覆盖什么', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    expect(
      screen.getByText(
        '节点可覆盖任务指令、输出 Schema 和 Turn 上限，但不能静默扩大这里声明的权限。',
      ),
    ).toBeTruthy();
  });

  it('工具白名单逐个列出', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    const tools = screen.getByRole('list', { name: '工具与 MCP 白名单' });
    expect(
      within(tools)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['read', 'grep']);
  });

  it('模型下拉只列已启用的条目', async () => {
    respond({
      'model.list': () => ({
        items: [MODEL, { ...MODEL, id: 'model_off', name: '停用的' }],
        total: 1,
      }),
    });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));

    // 只请求已启用的：过滤放在后端，前端不该拿到停用条目再自己筛
    await waitFor(() => {
      // 显式要满额：不写 limit 的话拿到分页默认值（50），
      // 第 51 条之后的已启用模型在下拉里根本不存在
      expect(call).toHaveBeenCalledWith('model.list', { enabledOnly: true, limit: 200 });
    });
  });

  it('保存后版本号递增 —— 图纸的按钮就叫「保存新版本」', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    // 得先真的改点什么：原样回写没有版本可递增，
    // 这条用例最初直接点保存，于是测的是一个后端会拒的空更新
    await user.clear(screen.getByLabelText('目标'));
    await user.type(screen.getByLabelText('目标'), '改过的目标');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'agent.update',
        expect.objectContaining({ id: 'agent_1', ver: 3 }),
      );
    });
  });
});

describe('复制与删除', () => {
  it('复制产出一个可编辑的副本', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    await user.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'agent.duplicate',
        expect.objectContaining({ id: 'agent_1' }),
      );
    });
  });

  it('内置角色不给删除按钮', async () => {
    respond({ 'agent.list': () => ({ items: [{ ...AGENT, builtin: true }], total: 1 }) });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));

    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.getByText(/内置角色不能删除/u)).toBeTruthy();
  });

  it('删除自建角色要先确认 —— 引用它的节点会失效', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    await user.click(screen.getByRole('button', { name: '删除' }));

    expect(call).not.toHaveBeenCalledWith('agent.delete', expect.anything());
    expect(screen.getByText(/引用它的节点会失效/u)).toBeTruthy();
  });
});
