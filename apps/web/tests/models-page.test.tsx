import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 模型页 —— 图纸「07 模型」。
 *
 * 两条产品规则要压住：
 * 1.「系统内所有模型下拉只列出这里已启用的条目」
 * 2. 凭据只显示 keychain:// 引用，界面上不存在查看明文的路径
 */

// 走契约校验的替身：界面发出不合契约的 payload 时这里就会失败，
// 而不是等到真实运行时被 Core API 挡下来
const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { createContractCall } = await import('./_contractClient.js');

const { ModelsPage } = await import('../src/models/ModelsPage.js');

const MODEL = {
  id: 'model_1',
  name: 'Opus 5 · high',
  runtime: 'acp.claude',
  modelId: 'claude-opus-5',
  effort: 'high',
  contextWindow: 200000,
  capabilities: ['结构化输出', '工具调用'],
  credentialRef: 'keychain://anthropic',
  enabled: true,
  lastLatencyMs: 342,
};

/** 按方法给返回值，入参一律先过契约。 */
function respond(handlers: Record<string, (input: unknown) => unknown>) {
  const checked = createContractCall(handlers);
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond({
    'model.list': () => ({ items: [MODEL], total: 0 }),
    'model.create': () => ({ id: 'model_new' }),
    'model.update': () => ({ ok: true }),
    'model.delete': () => ({ ok: true }),
  });
});

const view = () => render(<ModelsPage />);

describe('模型列表', () => {
  it('按接入方式分组显示', async () => {
    respond({
      'model.list': () => ({
        items: [MODEL, { ...MODEL, id: 'model_2', name: 'Codex', runtime: 'acp.codex' }],
      }),
    });
    view();
    expect(await screen.findByText('Claude Code（ACP）')).toBeTruthy();
    expect(screen.getByText('Codex（ACP）')).toBeTruthy();
  });

  it('底部常驻那句关于「只列已启用」的说明', async () => {
    view();
    expect(
      await screen.findByText(
        '系统内所有模型下拉只列出这里已启用的条目，AI 无法引用未登记的模型。',
      ),
    ).toBeTruthy();
  });

  it('一个模型都没有时说明要先登记，并解释 ACP 为什么不自动发现', async () => {
    respond({ 'model.list': () => ({ items: [], total: 0 }) });
    view();
    expect(await screen.findByText(/还没有登记模型/u)).toBeTruthy();
    expect(screen.getByText(/ACP 握手不返回模型列表/u)).toBeTruthy();
  });

  it('停用的条目在列表里标出来', async () => {
    respond({ 'model.list': () => ({ items: [{ ...MODEL, enabled: false }], total: 1 }) });
    view();
    const item = await screen.findByRole('button', { name: /Opus 5/u });
    expect(item.textContent).toContain('已停用');
  });
});

describe('模型详情', () => {
  it('选中后显示接入方式、模型 ID、档位与上下文窗口', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));

    const detail = screen.getByRole('region', { name: '模型详情' });
    expect(detail.textContent).toContain('claude-opus-5');
    expect(detail.textContent).toContain('200,000');
  });

  it('凭据只显示引用，界面上没有查看明文的入口', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));

    expect(screen.getByText('keychain://anthropic')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /查看|显示明文/u })).toBeNull();
  });

  it('最近一次测试的延迟显示出来', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));
    expect(screen.getByText(/342 ms/u)).toBeTruthy();
  });

  it('从未测过时不显示假的延迟数字', async () => {
    respond({
      'model.list': () => ({ items: [{ ...MODEL, lastLatencyMs: undefined }], total: 1 }),
    });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));
    expect(screen.getByText(/尚未测试/u)).toBeTruthy();
  });

  it('能力标签逐个列出', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));
    const caps = screen.getByRole('list', { name: '能力标签' });
    expect(
      within(caps)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['结构化输出', '工具调用']);
  });

  it('说明不具备结构化输出的模型会被节点下拉过滤掉', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));
    expect(
      screen.getByText('不具备「结构化输出」的模型不会出现在要求 JSON Schema 的节点下拉里。'),
    ).toBeTruthy();
  });

  it('停用后重新拉列表，让状态立刻反映', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));
    await user.click(screen.getByRole('button', { name: '停用' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('model.update', { id: 'model_1', enabled: false });
    });
  });

  it('删除前要确认，直接删掉会让引用它的 Agent 失效', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));
    await user.click(screen.getByRole('button', { name: '删除' }));

    // 第一次点击只是进入确认态，不发请求
    expect(call).not.toHaveBeenCalledWith('model.delete', expect.anything());
    expect(screen.getByRole('button', { name: /确认删除/u })).toBeTruthy();
  });

  it('确认后才真的删除', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: /确认删除/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('model.delete', { id: 'model_1' });
    });
  });
});

describe('登记新模型', () => {
  it('新建表单里凭据字段只接受 keychain:// 引用', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '登记模型' }));

    const cred = screen.getByLabelText(/凭据/u);
    await user.type(cred, 'sk-ant-secret');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByText(/必须是 keychain:\/\/ 引用/u)).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith('model.create', expect.anything());
  });

  it('必填项齐全时提交登记', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '登记模型' }));

    await user.type(screen.getByLabelText(/^名称/u), 'Sonnet 5');
    await user.type(screen.getByLabelText(/模型 ID/u), 'claude-sonnet-5');
    await user.type(screen.getByLabelText(/上下文窗口/u), '200000');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'model.create',
        expect.objectContaining({ name: 'Sonnet 5', modelId: 'claude-sonnet-5' }),
      );
    });
  });
});

describe('推理档位的展示语义', () => {
  it('当前档位有 aria-pressed —— 四个按钮 class 相同时它是唯一线索', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));

    const group = screen.getByRole('group', { name: '推理档位' });
    const pressed = within(group)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toBe('high');
  });

  it('档位按钮不可点 —— 改档位等于换一个条目，不是编辑', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5/u }));

    for (const button of within(screen.getByRole('group', { name: '推理档位' })).getAllByRole(
      'button',
    )) {
      expect(button).toBeDisabled();
    }
  });
});
