import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Agent 角色 —— 图纸「05 Agent 角色」。
 *
 * 这一屏要压住的产品规则：
 * 1.「节点引用角色而不是复制 Prompt；角色升级后引用它的节点一并生效」
 * 2.「权限（引擎强制，Prompt 无法越权）」—— 权限展示要说明它由引擎兜底。
 *    **作用范围要一起说**：引擎只在挂得上角色的 AI 节点上校验，
 *    脚本与 worktree 挂不上（契约里没有 agentProfileId），它们由权限档管
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
  capabilities: { file: 'read', command: 'none', network: 'none', memory: 'none', secret: [] },
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
    'agent.update': () => ({ ver: 4 }),
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

  it('权限那块说清它是怎么生效的 —— 引擎不强制，写进提示词', async () => {
    // 引擎的 check_capability 已经撤了（权限由流程管）。
    // 界面上留着「引擎强制」那句话的话，用户把「命令」调成「不允许」
    // 会以为引擎真的会拦 —— 承诺一件实现里没有的事，比不承诺更糟
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    expect(screen.getByText('权限（写进提示词交给 agent，引擎不强制）')).toBeTruthy();
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
    expect(screen.getByText(/内置角色是只读的/u)).toBeTruthy();
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

describe('权限、工具白名单、输出契约可配', () => {
  /**
   * codex 第三轮的原话：「新建表单明确提示『权限、工具白名单和输出契约
   * 建完再调』，但建完后……详情中可操作的只有名称、目标、性格指令、模型」。
   *
   * 图纸「05 Agent 角色」的权限块画的是纯展示（五行 span），
   * 但同一屏有「保存新版本」按钮 —— 详情区本来就是编辑区，
   * 原型只是画了「配好之后长什么样」。不给入口的话，
   * 「权限（引擎强制，Prompt 无法越权）」这句话就没有下文：
   * 引擎确实会拦，而用户无处声明允许什么。
   */
  const 打开 = async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));
    return user;
  };

  it('五项权限都能改，取值照契约', async () => {
    await 打开();
    const 区 = await screen.findByRole('group', { name: /权限/u });

    expect(within(区).getByLabelText('文件')).toBeTruthy();
    expect(within(区).getByLabelText('命令')).toBeTruthy();
    expect(within(区).getByLabelText('网络')).toBeTruthy();
    expect(within(区).getByLabelText('记忆')).toBeTruthy();
  });

  it('文件权限的选项是 none / read / read-write', async () => {
    await 打开();
    const 区 = await screen.findByRole('group', { name: /权限/u });
    const options = [...within(区).getByLabelText('文件').querySelectorAll('option')].map(
      (el) => (el as HTMLOptionElement).value,
    );
    expect(options).toEqual(['none', 'read', 'read-write']);
  });

  it('改权限后保存，发给后端的是新值', async () => {
    const user = await 打开();
    const 区 = screen.getByRole('group', { name: /权限/u });

    await user.selectOptions(within(区).getByLabelText('命令'), 'declared');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      const 入参 = call.mock.calls.find((args) => args[0] === 'agent.update')?.[1] as
        { capabilities?: { command?: string } } | undefined;
      expect(入参?.capabilities?.command).toBe('declared');
    });
  });

  it('不出现「引擎强制」这几个字 —— 引擎已经不强制了', async () => {
    // 权限由流程管：执行节点拿最高权限，拦它的是工作流里的审批节点。
    // 这条守的是「别改回去」—— 那句话现在是假的
    await 打开();
    expect(screen.queryByText(/引擎强制/u)).toBeNull();
    expect(screen.queryByText(/Prompt 无法越权/u)).toBeNull();
    expect(await screen.findByText(/写进提示词交给 agent/u)).toBeTruthy();
  });

  it('工具白名单能加能删 —— 图纸有「+ 添加」', async () => {
    const user = await 打开();
    await user.click(screen.getByRole('button', { name: /添加/u }));

    const 输入 = await screen.findByLabelText('工具名');
    await user.type(输入, 'gh.pr_create');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('gh.pr_create')).toBeTruthy();
  });

  it('点「+ 添加」之后光标就在输入框里 —— 否则看起来像什么都没发生', async () => {
    // codex 第四轮报「点击后没有新输入框、弹窗、提示或列表项」。
    // 复测两条路径都能出现输入框，但它找不到是有原因的：
    // 输入框原地替换了按钮，没有标题、没有焦点，视觉上几乎没变化。
    // 点了就该能直接打字 —— 那也是「+ 添加」这个动作的本意
    const user = await 打开();
    await user.click(screen.getByRole('button', { name: /添加/u }));

    const 输入 = await screen.findByLabelText('工具名');
    expect(document.activeElement, '光标没落在输入框里').toBe(输入);
  });

  it('按 Esc 收起 —— 点开了又不想加时得能退出去', async () => {
    const user = await 打开();
    await user.click(screen.getByRole('button', { name: /添加/u }));
    await screen.findByLabelText('工具名');

    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('工具名')).toBeNull();
    expect(screen.getByRole('button', { name: /添加/u })).toBeTruthy();
  });

  it('输出契约可编辑', async () => {
    const user = await 打开();
    const 契约 = screen.getByLabelText('输出契约');
    await user.clear(契约);
    await user.type(契约, 'Diff + 测试结果');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      const 入参 = call.mock.calls.find((args) => args[0] === 'agent.update')?.[1] as
        { outputContract?: string } | undefined;
      expect(入参?.outputContract).toBe('Diff + 测试结果');
    });
  });

  it('内置角色这几块只读 —— 改它等于改掉系统某处的行为', async () => {
    respond({ 'agent.list': () => ({ items: [{ ...AGENT, builtin: true }], total: 1 }) });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 Agent/u }));

    const 区 = await screen.findByRole('group', { name: /权限/u });
    expect(within(区).queryByLabelText('文件')).toBeNull();
    expect(screen.queryByRole('button', { name: /添加/u })).toBeNull();
  });
});

describe('Agent 列表能搜', () => {
  /**
   * codex：「共有 138 条、每页 50 条，只有上一页 / 下一页，
   * 没有搜索框……寻找旧角色只能逐页浏览」。
   * 图纸「05 Agent 角色」左栏顶部就有搜索框。
   */
  it('搜索框在，占位文案照图纸', async () => {
    view();
    expect(await screen.findByPlaceholderText(/搜索角色/u)).toBeTruthy();
  });

  it('输入即搜，发给后端 —— 前端过滤只能过滤当前页', async () => {
    view();
    await screen.findByPlaceholderText(/搜索角色/u);
    call.mockClear();

    fireEvent.change(screen.getByPlaceholderText(/搜索角色/u), {
      target: { value: 'Builder' },
    });

    await waitFor(
      () => {
        expect(
          call.mock.calls.some(
            (args) =>
              args[0] === 'agent.list' && (args[1] as { query?: string }).query === 'Builder',
          ),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
  });
});
