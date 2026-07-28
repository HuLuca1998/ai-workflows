import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 提示词库 —— 图纸「06 提示词库」。
 *
 * 要压住的产品规则：
 * 1.「系统调用 AI 的每一处都在这里」—— 内置条目不能删，只能复制
 * 2.「框架分段可见可改 · 保存后新运行生效」
 * 3.「Secret 只能以引用形式出现，预览与日志中永不展开明文」
 * 4.「运行记录会引用当时的提示词版本，历史结果始终可解释」
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const PROMPT = {
  id: 'prompt_1',
  group: '系统内建 · 节点',
  name: '分析 · 根因',
  sections: [
    { title: 'Role', body: '你是一名代码分析师。' },
    { title: 'Task', body: '定位 ${input.issue} 的根因。' },
  ],
  vars: [{ name: '${input.issue}', source: '启动表单', onMissing: 'empty_and_log' }],
  ver: 4,
  builtin: false,
  updatedAt: '2026-07-27T10:00:00Z',
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'prompt.list': () => ({ items: [PROMPT], total: 0 }),
    'prompt.create': () => ({ id: 'prompt_new' }),
    'prompt.update': () => ({ ok: true }),
    'prompt.duplicate': () => ({ id: 'prompt_copy' }),
    'prompt.delete': () => ({ ok: true }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = () => render(<PromptsPage />);

describe('列表', () => {
  it('按分组显示，带版本号', async () => {
    view();
    expect(await screen.findByText('系统内建 · 节点')).toBeTruthy();
    const item = screen.getByRole('button', { name: /分析 · 根因/u });
    expect(item.textContent).toContain('v4');
  });

  it('搜索框占位文案照图纸', async () => {
    view();
    expect(await screen.findByPlaceholderText('搜索名称、变量或正文')).toBeTruthy();
  });

  it('搜索发给后端，不在前端过滤', async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText('系统内建 · 节点');

    await user.type(screen.getByPlaceholderText('搜索名称、变量或正文'), '根因');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      // 分页参数每次都带，这里只关心搜索词有没有发出去
      expect(call).toHaveBeenCalledWith('prompt.list', expect.objectContaining({ query: '根因' }));
    });
  });

  it('底部常驻那句关于「系统调用 AI 的每一处」的说明', async () => {
    view();
    expect(
      await screen.findByText(
        '系统调用 AI 的每一处都在这里：节点、⌘K 协作、记忆提议、通知与失败归因。',
      ),
    ).toBeTruthy();
  });

  it('一条都没有时说明这里会出现什么', async () => {
    respond({ 'prompt.list': () => ({ items: [], total: 0 }) });
    view();
    expect(await screen.findByText(/还没有提示词/u)).toBeTruthy();
  });
});

describe('详情的四个 tab', () => {
  async function open() {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 · 根因/u }));
    return user;
  }

  it('tab 照图纸：模板、变量、预览、版本', async () => {
    await open();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['模板', '变量', '预览', '版本']);
  });

  it('模板 tab 逐段显示，分段标题在上', async () => {
    await open();
    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).toContain('Role');
    expect(panel.textContent).toContain('你是一名代码分析师。');
    expect(panel.textContent).toContain('Task');
  });

  it('那句「框架分段可见可改 · 保存后新运行生效」在位', async () => {
    await open();
    expect(screen.getByText('框架分段可见可改 · 保存后新运行生效')).toBeTruthy();
  });

  it('变量 tab 列出来源与缺失时的行为', async () => {
    const user = await open();
    await user.click(screen.getByRole('tab', { name: '变量' }));

    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).toContain('${input.issue}');
    expect(panel.textContent).toContain('启动表单');
    expect(panel.textContent).toContain('留空并记录');
  });

  it('变量 tab 底部说明 Secret 永不展开明文', async () => {
    const user = await open();
    await user.click(screen.getByRole('tab', { name: '变量' }));
    expect(screen.getByText('Secret 只能以引用形式出现，预览与日志中永不展开明文。')).toBeTruthy();
  });

  it('版本 tab 说明运行记录引用的是具体版本', async () => {
    const user = await open();
    await user.click(screen.getByRole('tab', { name: '版本' }));
    expect(screen.getByText('运行记录会引用当时的提示词版本，历史结果始终可解释。')).toBeTruthy();
  });

  it('预览 tab 还没有真实运行上下文时说清在等什么', async () => {
    const user = await open();
    await user.click(screen.getByRole('tab', { name: '预览' }));
    // 用真实运行的上下文替换变量要等 M3 接上 ACP
    expect(screen.getByRole('tabpanel').textContent).toMatch(/需要一次真实运行|等/u);
  });
});

describe('编辑与版本', () => {
  it('保存新版本把分段发回后端', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 · 根因/u }));
    // 同 agents-page：先改一段再保存。原来直接点保存，
    // 发出的是一个缺 ver 的原样回写 —— 契约层会拒，而用例照样绿
    await user.type(screen.getByLabelText('Role'), '（改）');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'prompt.update',
        expect.objectContaining({ id: 'prompt_1', ver: 4 }),
      );
    });
  });

  it('内置提示词不给删除按钮', async () => {
    respond({ 'prompt.list': () => ({ items: [{ ...PROMPT, builtin: true }], total: 1 }) });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 · 根因/u }));

    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.getByText(/内置提示词不能删除/u)).toBeTruthy();
  });

  it('复制内置提示词得到可编辑的副本', async () => {
    respond({ 'prompt.list': () => ({ items: [{ ...PROMPT, builtin: true }], total: 1 }) });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 · 根因/u }));
    await user.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'prompt.duplicate',
        expect.objectContaining({ id: 'prompt_1' }),
      );
    });
  });

  it('删除自建的要先确认', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 · 根因/u }));
    await user.click(screen.getByRole('button', { name: '删除' }));

    expect(call).not.toHaveBeenCalledWith('prompt.delete', expect.anything());
    expect(screen.getByRole('button', { name: /确认删除/u })).toBeTruthy();
  });
});
