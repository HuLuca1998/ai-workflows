import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * codex 第三轮的 🟡：
 *
 * - 内置角色的两个模型下拉与保存按钮仍可动，改完必然被后端拒
 * - 保存成功后 pendingSelect 没清，警告还在说「有未保存的改动」
 * - 「删除」被换成「取消」时焦点掉到 body，下一次 Tab 从整页开头走
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');

function agent(id: string, name: string, builtin = false) {
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
    builtin,
  };
}

const MODEL = {
  id: 'model_1',
  name: '模型甲',
  runtime: 'acp.codex',
  modelId: 'gpt-x',
  effort: 'medium',
  contextWindow: 200000,
  capabilities: [],
  enabled: true,
};

function respond(items: ReturnType<typeof agent>[]) {
  const checked = createContractCall({
    'agent.list': () => ({ items, total: items.length }),
    'model.list': () => ({ items: [MODEL], total: 1 }),
    'agent.update': () => ({ ver: 2 }),
    'agent.delete': () => ({ ok: true }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
}

beforeEach(() => {
  call.mockReset();
});

describe('内置角色端到端只读', () => {
  it('模型下拉与保存按钮都不能动 —— 改了必然被后端拒', async () => {
    respond([agent('a1', '内置分析', true)]);
    const user = userEvent.setup();
    render(<AgentsPage />);
    await user.click(await screen.findByText('内置分析'));

    expect(screen.getByLabelText('模型')).toBeDisabled();
    expect(screen.getByLabelText('降级模型')).toBeDisabled();
    const save = screen.getByRole('button', { name: '保存新版本' });
    expect(save).toBeDisabled();
    expect(save.title).toContain('复制');
  });
});

describe('未保存守卫的收尾', () => {
  it('保存成功后那条警告要消失', async () => {
    respond([agent('a1', '角色甲'), agent('a2', '角色乙')]);
    const user = userEvent.setup();
    render(<AgentsPage />);

    await user.click(await screen.findByText('角色甲'));
    const name = await screen.findByLabelText('角色名称');
    await user.clear(name);
    await user.type(name, '改过的');
    await user.click(screen.getByText('角色乙'));
    await screen.findByText(/未保存/u);

    await user.click(screen.getByRole('button', { name: '保存新版本' }));
    await waitFor(() => {
      expect(screen.queryByText(/未保存/u), '保存完了警告还在说有未保存的改动').toBeNull();
    });
  });
});

describe('确认删除的焦点', () => {
  it('按钮被换掉时焦点跟到「取消」，不掉回 body', async () => {
    respond([agent('a1', '角色甲')]);
    const user = userEvent.setup();
    render(<AgentsPage />);
    await user.click(await screen.findByText('角色甲'));

    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      /*
       * 必须比对元素本身。
       *
       * 原来这里断言的是 `document.activeElement?.textContent` 含「取消」——
       * 焦点掉回 body 时 body 的全文同样含「取消」，于是这条测试
       * 无论修没修都是绿的。（codex 复核指出的假阳性。）
       */
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    });
  });
});

describe('有未保存改动时复制', () => {
  it('说清楚复制的是已保存的那一版 —— 后端拿不到界面里的草稿', async () => {
    respond([agent('a1', '角色甲')]);
    const user = userEvent.setup();
    render(<AgentsPage />);

    await user.click(await screen.findByText('角色甲'));
    const name = await screen.findByLabelText('角色名称');
    await user.clear(name);
    await user.type(name, '改过的');

    const copy = screen.getByRole('button', { name: /复制/u });
    expect(copy.title).toContain('已保存');
  });
});
