import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 启动表单里的仓库字段（`format: 'repo'`）。
 *
 * 手填 `owner/name` 打错一个字，要等运行跑到 `git clone` 那一步才报错 ——
 * 而那时 worktree 已经建好了。仓库与分支都从本机已登录的 gh 里取，
 * 让用户选而不是记。
 *
 * 仓库与分支是**一个字段**：值是 `{name, branch}`，
 * 脚本里用 `${input.repo.name}` / `${input.repo.branch}`。
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
          required: ['repo'],
          properties: {
            repo: { type: 'object', format: 'repo', title: '仓库与分支' },
            issue: { type: 'string', title: 'Issue 编号' },
          },
        },
      },
    },
  ],
  edges: [],
  groups: [],
};

const OK_REPORT = { workdir: '/tmp/wd', checks: [], passed: 0, failed: 0, ok: true };

const REPOS = {
  items: [
    { fullName: 'BDBGAME2024/pp-game', defaultBranch: 'live', isOrg: true },
    { fullName: 'HuLuca1998/ai-workflows', defaultBranch: 'main', isOrg: false },
  ],
};

const BRANCHES = { items: ['main', 'dev', 'feature/x'], defaultBranch: 'main' };

const props = {
  workflowId: 'wf_1',
  workflowName: 'GitHub Issue 修复',
  graph: GRAPH as never,
  rev: 3,
  versions: [],
  onClose: vi.fn(),
  onStarted: vi.fn(),
};

/** 默认：三个方法都成功。个别用例再各自覆盖。 */
function respond(overrides: Record<string, unknown> = {}) {
  call.mockImplementation((method: string) => {
    if (method in overrides) {
      const value = overrides[method];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    if (method === 'run.dryRun') return Promise.resolve(OK_REPORT);
    if (method === 'github.repos') return Promise.resolve(REPOS);
    if (method === 'github.branches') return Promise.resolve(BRANCHES);
    if (method === 'run.start') return Promise.resolve({ runId: 'run_1' });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  call.mockReset();
  respond();
  props.onClose.mockReset();
  props.onStarted.mockReset();
});

describe('仓库字段', () => {
  it('渲染成仓库与分支两个下拉，而不是文本框', async () => {
    render(<LaunchDialog {...props} />);

    const 仓库 = await screen.findByLabelText('仓库');
    expect(仓库.tagName).toBe('SELECT');
    expect(screen.getByLabelText('分支').tagName).toBe('SELECT');
  });

  it('组织仓库单独分组 —— 个人的和组织的混在一列里很难找', async () => {
    render(<LaunchDialog {...props} />);

    const 仓库 = await screen.findByLabelText('仓库');
    await waitFor(() => {
      expect(within(仓库).getByRole('option', { name: 'BDBGAME2024/pp-game' })).toBeTruthy();
    });
    const 分组 = within(仓库)
      .getAllByRole('group')
      .map((g) => g.getAttribute('label'));
    expect(分组).toEqual(['组织', '个人']);
  });

  it('选了仓库才去问分支，并预选默认分支', async () => {
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    // 还没选仓库时不该白问一次 —— 也没有仓库可问
    expect(call.mock.calls.filter(([m]) => m === 'github.branches')).toHaveLength(0);

    await user.selectOptions(await screen.findByLabelText('仓库'), 'HuLuca1998/ai-workflows');

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('github.branches', { repo: 'HuLuca1998/ai-workflows' });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('分支')).toHaveValue('main');
    });
  });

  it('没选仓库时分支下拉是禁用的', async () => {
    render(<LaunchDialog {...props} />);
    expect(await screen.findByLabelText('分支')).toBeDisabled();
  });

  it('提交时合成一个 {name, branch} 对象', async () => {
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    await user.selectOptions(await screen.findByLabelText('仓库'), 'BDBGAME2024/pp-game');
    await waitFor(() => expect(screen.getByLabelText('分支')).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText('分支'), 'dev');
    await user.click(screen.getByRole('button', { name: /开始运行/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'run.start',
        expect.objectContaining({
          inputs: expect.objectContaining({
            repo: { name: 'BDBGAME2024/pp-game', branch: 'dev' },
          }),
        }),
      );
    });
  });

  it('必填的仓库没选时拦住，并说清是哪一个', async () => {
    const user = userEvent.setup();
    render(<LaunchDialog {...props} />);

    await screen.findByLabelText('仓库');
    await user.click(screen.getByRole('button', { name: /开始运行/u }));

    expect(call.mock.calls.filter(([m]) => m === 'run.start')).toHaveLength(0);
    expect(screen.getAllByText('必填项，请填写').length).toBeGreaterThan(0);
  });

  it('网络抖一下之后能重试，不用关掉重开', async () => {
    // 实际撞到的：`gh 报错：Get "https://api.github.com/user/repos?…": EOF`。
    // 代理切个节点就会这样，重试一次就好 —— 而当时唯一的出路是
    // 关掉对话框重开，那会把已经填好的其它参数一起丢掉
    const user = userEvent.setup();
    let 第几次 = 0;
    call.mockImplementation((method: string) => {
      if (method === 'run.dryRun') return Promise.resolve(OK_REPORT);
      if (method === 'github.repos') {
        第几次 += 1;
        return 第几次 === 1 ? Promise.reject(new Error('gh 报错：… EOF')) : Promise.resolve(REPOS);
      }
      if (method === 'github.branches') return Promise.resolve(BRANCHES);
      return Promise.resolve({});
    });
    render(<LaunchDialog {...props} />);

    await screen.findByText(/EOF/u);
    await user.click(screen.getByRole('button', { name: '重试' }));

    // 回到下拉，而不是停在手填框上
    await waitFor(() => {
      expect(screen.getByLabelText('仓库').tagName).toBe('SELECT');
    });
    expect(screen.queryByText(/EOF/u)).toBeNull();
  });

  it('gh 用不了时说清原因，并让用户能自己手填', async () => {
    // 一个空下拉看着像「你没有仓库」，用户会跑去 GitHub 上找自己哪儿配错了。
    // 而且不能就这么把人堵死 —— 手填仍要能跑
    const user = userEvent.setup();
    respond({
      'github.repos': Object.assign(new Error('gh 还没登录。在终端里跑一遍 `gh auth login`'), {
        code: 'EXTERNAL',
      }),
    });
    render(<LaunchDialog {...props} />);

    expect(await screen.findByText(/gh auth login/u)).toBeTruthy();

    const 仓库 = screen.getByLabelText('仓库');
    expect(仓库.tagName).toBe('INPUT');
    await user.type(仓库, 'owner/name');
    await user.type(screen.getByLabelText('分支'), 'main');
    await user.click(screen.getByRole('button', { name: /开始运行/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'run.start',
        expect.objectContaining({
          inputs: expect.objectContaining({ repo: { name: 'owner/name', branch: 'main' } }),
        }),
      );
    });
  });
});
