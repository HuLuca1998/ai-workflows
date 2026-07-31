import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * codex 复核出来的三条，每条都有明确的失败场景：
 *
 * 1. AgentsPage 的「新建角色」直接 setCreating(true)，绕过刚加的未保存守卫 ——
 *    改了名字没保存、点「+」，改动没了
 * 2. SupervisorDrawer 的 proposal 不带工作流身份：在工作流 A 里让 AI 提了
 *    一组改动，切到 B，提议还挂着，点「应用到草稿」就把 A 的操作落到了 B
 * 3. 隐私模式下 localStorage 抛异常，「先跳过」存不住，而首次引导又按
 *    「没跳过」处理 —— 用户被永久弹回引导页，点跳过也出不来
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');
const { AppShell } = await import('../src/AppShell.js');

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

beforeEach(() => {
  call.mockReset();
});

describe('未保存守卫覆盖「新建」这条路', () => {
  it('改了没保存时点「+」，先拦一下', async () => {
    const checked = createContractCall({
      'agent.list': () => ({ items: [agent('a1', '角色甲')], total: 1 }),
      'model.list': () => ({ items: [MODEL], total: 1 }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(<AgentsPage />);
    await user.click(await screen.findByText('角色甲'));
    const name = await screen.findByLabelText('角色名称');
    await user.clear(name);
    await user.type(name, '改过的');

    await user.click(screen.getByRole('button', { name: '新建角色' }));
    expect(await screen.findByText(/未保存/u)).toBeTruthy();
    // 还没跳到新建表单，改动还在
    expect(screen.getByLabelText('角色名称')).toHaveValue('改过的');
  });
});

describe('AI 提议绑定工作流身份', () => {
  it('切到别的工作流之后，上一条提议不能再往这张图上落', async () => {
    const graphA = {
      nodes: [
        {
          id: 'entry',
          type: 'entry' as const,
          title: '入口',
          position: { x: 0, y: 0 },
          config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
        },
      ],
      edges: [],
      groups: [],
    };
    const checked = createContractCall({
      'supervisor.sessions': () => ({ items: [] }),
      'model.list': () => ({ items: [], total: 0 }),
      'supervisor.ask': () => ({
        text: '改好了',
        toolCalls: 0,
        proposal: {
          summary: '把入口改名为「开始」',
          operations: [{ op: 'renameNode', nodeId: 'entry', title: '开始' }],
        },
      }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const onApply = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <SupervisorDrawer
        open
        context={{ workflowId: 'wf_A', draftRev: 1 }}
        graph={graphA}
        onApply={onApply}
        onClose={() => {}}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: /问主管 AI/u }), '加个通知');
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: '应用到草稿' });

    // 用户切到了另一条工作流
    rerender(
      <SupervisorDrawer
        open
        context={{ workflowId: 'wf_B', draftRev: 1 }}
        graph={graphA}
        onApply={onApply}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '应用到草稿' }),
        '上一条工作流的提议还能往这张图上落',
      ).toBeNull();
    });
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('隐私模式下的首次引导', () => {
  it('localStorage 存不住也不影响配置 —— 状态在后端，不在浏览器里', async () => {
    // 上一版靠一个 localStorage 标记记「这次先不配」，隐私模式下
    // 读写都抛，用户永远出不去。现在「配没配过」看后端的 envCheckedAt，
    // 与浏览器存储无关 —— 这条守的是「别再把状态放回 localStorage」
    // 隐私模式：读写都抛
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      },
    });

    const checked = createContractCall({
      'workspace.settings': () => ({ permissionPreset: 'ai_assisted', environment: 'local' }),
      'env.health': () => ({ ready: true, items: [] }),
      'run.list': () => ({ items: [], total: 0 }),
      'workflow.list': () => ({ items: [], total: 0 }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    );

    // 页面渲染得出来，且没有因为 localStorage 抛异常而崩
    await screen.findByText('配置这台机器');
    expect(screen.getByRole('button', { name: /开始使用/u })).toBeTruthy();
  });
});

describe('提问进行中切换工作流', () => {
  it('回答回来时提议不能挂到新的工作流上', async () => {
    const graphA = {
      nodes: [
        {
          id: 'entry',
          type: 'entry' as const,
          title: '入口',
          position: { x: 0, y: 0 },
          config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
        },
      ],
      edges: [],
      groups: [],
    };

    let release: null | (() => void) = null;
    const checked = createContractCall({
      'supervisor.sessions': () => ({ items: [] }),
      'model.list': () => ({ items: [], total: 0 }),
      'supervisor.ask': () =>
        new Promise<{ text: string; toolCalls: number; proposal: unknown }>((resolve) => {
          release = () =>
            resolve({
              text: '改好了',
              toolCalls: 0,
              proposal: {
                summary: '把入口改名为「开始」',
                operations: [{ op: 'renameNode', nodeId: 'entry', title: '开始' }],
              },
            });
        }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const onApply = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <SupervisorDrawer
        open
        context={{ workflowId: 'wf_A', draftRev: 1 }}
        graph={graphA}
        onApply={onApply}
        onClose={() => {}}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: /问主管 AI/u }), '改个名');
    await user.keyboard('{Enter}');

    // 回答还没回来，用户已经切到了另一条工作流
    rerender(
      <SupervisorDrawer
        open
        context={{ workflowId: 'wf_B', draftRev: 1 }}
        graph={graphA}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    (release as (() => void) | null)?.();

    await screen.findByText('改好了');
    expect(
      screen.queryByRole('button', { name: '应用到草稿' }),
      '在 A 上问的，回来时挂到了 B 上',
    ).toBeNull();
  });
});
