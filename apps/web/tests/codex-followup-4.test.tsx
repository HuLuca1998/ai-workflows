import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * codex 第三轮指出的覆盖缺口 —— 三处实现没有会红的守卫。
 *
 * 「守卫不能证明自己会红，就不是守卫」：
 * - Models 的并发测试只验证了「测 A 时 B 可点」，退回单槽仍然全绿
 * - 焦点只测了 Agents 一页，删掉另外两页的 ref 不会红
 * - 判别联合没构造过 `id: "new"` 的角色，退回字符串哨兵仍然全绿
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

function agent(id: string, name: string) {
  return {
    id,
    name,
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
    builtin: false,
  };
}

function model(id: string, name: string) {
  return {
    id,
    name,
    runtime: 'acp.codex',
    modelId: 'gpt-x',
    effort: 'medium',
    contextWindow: 200000,
    capabilities: [],
    enabled: true,
  };
}

function prompt(id: string, name: string) {
  return {
    id,
    group: '系统内建 · 节点',
    name,
    sections: [{ title: 'Role', body: '正文' }],
    vars: [],
    ver: 1,
    builtin: false,
    updatedAt: '2026-07-27T10:00:00Z',
  };
}

const MODEL = model('model_1', '模型甲');

beforeEach(() => {
  call.mockReset();
});

describe('模型连通性测试的并发', () => {
  it('A 先结束不能把 B 的中间态一起清掉', async () => {
    const release: Record<string, (value: unknown) => void> = {};
    const checked = createContractCall({
      'model.list': () => ({ items: [model('m1', '模型甲'), model('m2', '模型乙')], total: 2 }),
      'model.test': (input: unknown) =>
        new Promise((resolve) => {
          release[(input as { id: string }).id] = resolve;
        }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(<ModelsPage />);

    await user.click(await screen.findByText('模型甲'));
    await user.click(screen.getByRole('button', { name: '测试连通性' }));
    await user.click(screen.getByText('模型乙'));
    await user.click(screen.getByRole('button', { name: '测试连通性' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '测试中…' })).toBeTruthy();
    });

    // A 先回来
    release['m1']?.({ ok: true, detail: '通', latencyMs: 12 });

    // B 还在飞，它的按钮不能恢复可点
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /测试/u }),
        'A 结束把 B 的中间态一起清掉了 —— B 还在请求中，按钮却又能点了',
      ).toBeDisabled();
    });
    release['m2']?.({ ok: true, detail: '通', latencyMs: 12 });
  });
});

describe('确认删除的焦点在三页都接管', () => {
  it('模型页', async () => {
    const checked = createContractCall({
      'model.list': () => ({ items: [MODEL], total: 1 }),
      'model.delete': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    const user = userEvent.setup();
    render(<ModelsPage />);
    await user.click(await screen.findByText('模型甲'));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    });
  });

  it('提示词页', async () => {
    const checked = createContractCall({
      'prompt.list': () => ({ items: [prompt('p1', '提示甲')], total: 1 }),
      'prompt.delete': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    const user = userEvent.setup();
    render(<PromptsPage />);
    await user.click(await screen.findByText('提示甲'));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    });
  });
});

describe('一条 id 恰好叫 new 的角色', () => {
  it('放弃改动后进的是这个角色，不是新建表单', async () => {
    const checked = createContractCall({
      'agent.list': () => ({
        items: [agent('a1', '角色甲'), agent('new', '恰好叫 new')],
        total: 2,
      }),
      'model.list': () => ({ items: [MODEL], total: 1 }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(<AgentsPage />);

    await user.click(await screen.findByText('角色甲'));
    const name = await screen.findByLabelText('角色名称');
    await user.clear(name);
    await user.type(name, '改过的');

    await user.click(screen.getByText('恰好叫 new'));
    await user.click(await screen.findByRole('button', { name: /放弃改动/u }));

    await waitFor(() => {
      expect(
        screen.getByLabelText('角色名称'),
        '字符串哨兵把这个真实角色当成了「新建」',
      ).toHaveValue('恰好叫 new');
    });
  });
});
