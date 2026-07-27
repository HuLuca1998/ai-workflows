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
    // required 里的字段标星
    expect(screen.getByText('Issue 编号').textContent).toContain('*');
    expect(screen.getByText('仓库').textContent).not.toContain('*');
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
