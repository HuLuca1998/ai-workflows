import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 启动表单 —— 图纸的 660px 对话框。
 *
 * 核心断言：字段由入口节点的输入 Schema 生成（不是写死的），
 * 依赖检查显示真实结果（不是永远「通过」）。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { LaunchDialog } = await import('../src/runs/LaunchDialog.js');

const GRAPH = {
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: {
        trigger: 'manual',
        inputSchema: {
          type: 'object',
          required: ['issue'],
          properties: {
            issue: { type: 'string', title: 'Issue 编号' },
            repo: { type: 'string', title: '仓库' },
            base: { type: 'string', title: '基础分支', default: 'main' },
          },
        },
      },
    },
  ],
  edges: [],
  groups: [],
};

const REPORT = {
  checks: [
    { label: '图结构', status: 'passed', detail: '2 个节点可依次执行' },
    { label: '解释器 bash', status: 'passed', detail: '/bin/bash' },
    { label: '节点类型 ai.execute', status: 'failed', detail: 'ai.execute 尚未实现' },
  ],
  passed: 2,
  failed: 1,
  ok: false,
};

const props = {
  workflowId: 'wf_1',
  workflowName: 'GitHub Issue 修复',
  graph: GRAPH as never,
  rev: 3,
  versions: [{ id: 'v_1', version: 1, configHash: 'abc', publishedAt: 't', publishedBy: 'me' }],
  onClose: vi.fn(),
  onStarted: vi.fn(),
};

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue(REPORT);
  props.onClose.mockReset();
  props.onStarted.mockReset();
});

describe('启动表单', () => {
  it('标题照图纸带上工作流名与那句说明', () => {
    render(<LaunchDialog {...props} />);
    expect(screen.getByText('运行 · GitHub Issue 修复')).toBeTruthy();
    expect(screen.getByText('启动表单由入口节点的输入 Schema 自动生成')).toBeTruthy();
  });

  it('字段来自入口节点的 inputSchema，必填项带星号', () => {
    render(<LaunchDialog {...props} />);
    expect(screen.getByLabelText(/Issue 编号/u)).toBeTruthy();
    expect(screen.getByLabelText(/仓库/u)).toBeTruthy();
    // required 里的字段标星。星号在 label 容器上而不是文本那层 ——
    // aria-labelledby 会取累积文本，星号一起进去的话
    // 字段的可读名就成了「Issue 编号 *」
    expect(screen.getByText('Issue 编号').closest('.launch__label')?.textContent).toContain('*');
    expect(screen.getByText('仓库').closest('.launch__label')?.textContent).not.toContain('*');
  });

  it('schema 里的默认值预填进表单', () => {
    render(<LaunchDialog {...props} />);
    expect(screen.getByLabelText(/基础分支/u).getAttribute('value')).toBe('main');
  });

  it('入口节点没有 inputSchema 时说明这个工作流不需要参数', () => {
    const noSchema = {
      ...GRAPH,
      nodes: [{ ...GRAPH.nodes[0], config: { trigger: 'manual' } }],
    };
    render(<LaunchDialog {...props} graph={noSchema as never} />);
    expect(screen.getByText(/不需要启动参数/u)).toBeTruthy();
  });

  it('运行版本可以在草稿与已发布版本之间选', () => {
    render(<LaunchDialog {...props} />);
    const picker = screen.getByRole('group', { name: '运行版本' });
    const options = within(picker)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(options).toEqual(['草稿 rev3', 'v1']);
  });

  it('打开时就发起依赖检查，不等用户点开始', async () => {
    render(<LaunchDialog {...props} />);
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'run.dryRun',
        expect.objectContaining({ workflowId: 'wf_1', draftRev: 3 }),
      );
    });
  });

  it('依赖检查的通过与缺失计数照图纸显示', async () => {
    render(<LaunchDialog {...props} />);
    expect(await screen.findByText('2 项通过 · 1 项缺失')).toBeTruthy();
  });

  it('每条检查列出标签与详情，失败的标出来', async () => {
    render(<LaunchDialog {...props} />);
    const failed = await screen.findByText(/ai.execute 尚未实现/u);
    expect(failed.closest('[data-status]')?.getAttribute('data-status')).toBe('failed');
  });

  it('检查没过时开始运行被拦住，并说明原因', async () => {
    render(<LaunchDialog {...props} />);
    const start = await screen.findByRole('button', { name: /开始运行/u });
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/依赖检查未通过/u)).toBeTruthy();
  });

  it('检查全通过时可以开始运行，参数原样送出', async () => {
    call.mockResolvedValue({ checks: [], passed: 0, failed: 0, ok: true });
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    await user.type(await screen.findByLabelText(/Issue 编号/u), '561');
    call.mockResolvedValueOnce('run_new');
    await user.click(screen.getByRole('button', { name: /开始运行/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'run.start',
        expect.objectContaining({
          workflowId: 'wf_1',
          draftRev: 3,
          inputs: expect.objectContaining({ issue: '561', base: 'main' }),
        }),
      );
    });
  });

  it('必填项没填时不让开始，也不发请求', async () => {
    call.mockResolvedValue({ checks: [], passed: 0, failed: 0, ok: true });
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    const start = await screen.findByRole('button', { name: /开始运行/u });
    await user.click(start);

    expect(call).not.toHaveBeenCalledWith('run.start', expect.anything());
    expect(screen.getByText(/Issue 编号/u)).toBeTruthy();
  });

  it('启动失败时留在表单里显示原因，不关掉让用户重填', async () => {
    call.mockResolvedValue({ checks: [], passed: 0, failed: 0, ok: true });
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    await user.type(await screen.findByLabelText(/Issue 编号/u), '561');
    call.mockRejectedValueOnce(new Error('工作目录不可写'));
    await user.click(screen.getByRole('button', { name: /开始运行/u }));

    expect(await screen.findByText(/工作目录不可写/u)).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('取消直接关掉，不发任何请求', async () => {
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(call).not.toHaveBeenCalledWith('run.start', expect.anything());
  });
});

describe('参数按 Schema 的类型渲染与校验', () => {
  const TYPED_GRAPH = {
    nodes: [
      {
        id: 'entry',
        type: 'entry',
        title: '入口',
        position: { x: 0, y: 0 },
        config: {
          trigger: 'manual',
          inputSchema: {
            type: 'object',
            required: ['count', 'flag', 'mode'],
            properties: {
              count: { type: 'integer', title: '数量', minimum: 1 },
              flag: { type: 'boolean', title: '开关' },
              mode: { type: 'string', title: '模式', enum: ['safe', 'fast'] },
              note: { type: 'string', title: '备注' },
            },
          },
        },
      },
    ],
    edges: [],
    groups: [],
  };

  /** Dry Run 通过的报告：不通过时「开始运行」本来就该被拦住。 */
  const OK_REPORT = {
    checks: [{ label: '图结构', status: 'passed' }],
    passed: 1,
    failed: 0,
    ok: true,
  };

  const open = () => {
    call.mockResolvedValue(OK_REPORT);
    return render(<LaunchDialog {...props} graph={TYPED_GRAPH as never} />);
  };

  it('integer 用数字输入并带上下限 —— 不是任意文本框', async () => {
    open();
    const input = (await screen.findByLabelText('数量')) as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.min).toBe('1');
  });

  it('boolean 用复选框', async () => {
    open();
    const input = (await screen.findByLabelText('开关')) as HTMLInputElement;
    expect(input.type).toBe('checkbox');
  });

  it('enum 用下拉，且只列出允许的值', async () => {
    open();
    const select = (await screen.findByLabelText('模式')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((o) => o.value).filter(Boolean)).toEqual(['safe', 'fast']);
  });

  it('没有类型信息的仍是文本框 —— 不为了统一而瞎猜', async () => {
    open();
    const input = (await screen.findByLabelText('备注')) as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('数字字段发出去的是数字，不是字符串', async () => {
    // 发成字符串的话，脚本里 ${input.count} + 1 会变成字符串拼接 ——
    // 而那只有跑到那一行时才会暴露
    const user = userEvent.setup();
    open();
    // 等 Dry Run 回来：没通过时「开始运行」是被拦住的
    await screen.findByText(/1 项通过/u);
    await user.type(await screen.findByLabelText('数量'), '5');
    await user.click(screen.getByLabelText('开关'));
    await user.selectOptions(screen.getByLabelText('模式'), 'fast');
    await user.click(screen.getByRole('button', { name: /开始运行/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'run.start',
        expect.objectContaining({
          inputs: expect.objectContaining({ count: 5, flag: true, mode: 'fast' }),
        }),
      );
    });
  });

  it('点弹层外面不关闭 —— 填到一半的参数不该就这么没了', async () => {
    // 用户报的：手一滑点到外面，填好的启动参数全没了，得从头再来。
    // 这个文件里 onStart 的 catch 分支已经写着「留在表单里：关掉的话
    // 用户填的参数就没了，还得重来一遍」—— 遮罩上那个 onClick 违反的
    // 正是同一条。关闭有明确入口：右上角 × 与「取消」
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    await user.type(screen.getByLabelText(/Issue 编号/u), '548');
    await user.click(screen.getByTestId('launch-backdrop'));

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Issue 编号/u)).toHaveValue('548');
  });

  it('右上角的 × 与「取消」照常关闭', async () => {
    // 别把出路一起堵死了
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('必填为空时给出中文错误与 aria-invalid，而不是只有红框', async () => {
    // codex 复测报的：三个 input 只有内部 data-missing，
    // aria-invalid 数量为 0，页面上没有任何可见的错误文本 ——
    // 读屏用户完全不知道为什么点了没反应
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: /开始运行/u }));

    expect(screen.getByLabelText('数量')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('必填项，请填写').length).toBeGreaterThan(0);
  });
});

describe('连点守卫(第 6 轮实测 #2)', () => {
  it('三连点开始运行只起一条', async () => {
    const user = userEvent.setup();
    let starts = 0;
    call.mockImplementation((method: string, input: unknown) => {
      if (method === 'run.dryRun')
        return Promise.resolve({ ...REPORT, ok: true, failed: 0, checks: [] });
      if (method === 'run.start') {
        starts += 1;
        return new Promise((resolve) => setTimeout(() => resolve({ runId: 'run_x' }), 30));
      }
      return Promise.resolve({});
    });
    render(<LaunchDialog {...props} />);
    // 填必填项 issue
    const issue = await screen.findByLabelText(/Issue 编号/u);
    await user.type(issue, '7');
    const btn = screen.getByRole('button', { name: /开始运行/u });
    // 同步三连点:用 fireEvent 不等重渲染
    btn.click();
    btn.click();
    btn.click();
    await new Promise((r) => setTimeout(r, 80));
    expect(starts).toBe(1);
  });
});
