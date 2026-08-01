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
        total: 2,
      }),
    });
    view();
    // 限定在列表区域：接入方式下拉里也有同样的文字
    const 列表 = await screen.findByRole('region', { name: '模型列表' });
    expect(within(列表).getByText('Claude Code（ACP）')).toBeTruthy();
    expect(within(列表).getByText('Codex（ACP）')).toBeTruthy();
  });

  it('底部常驻那句关于「只列已启用」的说明', async () => {
    view();
    expect(
      await screen.findByText(
        '系统内所有模型下拉只列出这里已启用的条目，AI 无法引用未登记的模型。',
      ),
    ).toBeTruthy();
  });

  it('一个模型都没有时，指向「同步」而不是让人手工敲', async () => {
    // 这条原先断言的是「ACP 握手不返回模型列表，所以要手工登记」——
    // **那句话是错的**，session/new 的 configOptions 里就带着清单
    // （两端实测）。照它去手敲，敲出来的值多半不在 agent 认的候选里，
    // 设下去当场被拒。守一句错的承诺比不守更糟
    respond({ 'model.list': () => ({ items: [], total: 0 }) });
    view();
    expect(await screen.findByText(/还没有模型/u)).toBeTruthy();
    expect(screen.getByText(/点「同步」/u)).toBeTruthy();
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

    // 拦住明文是这条测试的核心；那句话怎么写归
    // model-credential-honesty.test.tsx 管（它要求说清怎么办，
    // 而不是把用户丢在「请先存进钥匙串」上）
    expect(screen.getByText(/不收明文/u)).toBeTruthy();
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

describe('测试连通性（图纸「07 模型」）', () => {
  /**
   * 图纸详情区的按钮顺序是「测试连通性 | 启用/停用 | 删除 | 保存」，
   * 凭据卡里有一行「延迟 · 1.4s（最近一次测试）」。
   *
   * ROADMAP 把它留给 M5「和环境健康中心一起做，共用同一套探测逻辑」——
   * 它们确实共用：都是启动 adapter 握手。
   */
  const 打开模型 = async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5 · high/u }));
    return user;
  };

  it('按钮在，且排在启用/停用前面 —— 图纸的顺序', async () => {
    await 打开模型();
    const actions = [...document.querySelectorAll('.models__detail header button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(actions.slice(0, 2)).toEqual(['测试连通性', '停用']);
  });

  it('点它把模型 id 发给后端', async () => {
    const user = await 打开模型();
    await user.click(screen.getByRole('button', { name: '测试连通性' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('model.test', { id: 'model_1' });
    });
  });

  it('测试期间按钮变成「测试中…」并禁用 —— 那要几秒', async () => {
    respond({
      'model.list': () => ({ items: [MODEL], total: 1 }),
      'model.test': () => new Promise(() => {}),
    });
    const user = await 打开模型();
    await user.click(screen.getByRole('button', { name: '测试连通性' }));

    expect(await screen.findByRole('button', { name: '测试中…' })).toBeDisabled();
  });

  it('通了显示延迟与说明', async () => {
    respond({
      'model.list': () => ({ items: [MODEL], total: 1 }),
      'model.test': () => ({ ok: true, latencyMs: 1420, detail: '握手成功 · 协议 v1' }),
    });
    const user = await 打开模型();
    await user.click(screen.getByRole('button', { name: '测试连通性' }));

    // 说明来自 model.test 的返回；延迟落在模型行上，由重新拉的列表带回来
    // （那条链由「测完刷新列表」那条用例验）
    expect(await screen.findByText(/握手成功/u)).toBeTruthy();
  });

  it('没通时把原因显示出来 —— 那正是用户要的', async () => {
    respond({
      'model.list': () => ({ items: [MODEL], total: 1 }),
      'model.test': () => ({
        ok: false,
        latencyMs: 12,
        detail: 'acp.claude 的 adapter 没有安装。在「设置与环境」里能看到怎么装',
      }),
    });
    const user = await 打开模型();
    await user.click(screen.getByRole('button', { name: '测试连通性' }));

    expect(await screen.findByText(/adapter 没有安装/u)).toBeTruthy();
  });

  it('测完刷新列表 —— 延迟要落到凭据卡上', async () => {
    let 测过 = false;
    respond({
      'model.list': () => ({
        items: [{ ...MODEL, lastLatencyMs: 测过 ? 1420 : 342 }],
        total: 1,
      }),
      'model.test': () => {
        测过 = true;
        return { ok: true, latencyMs: 1420, detail: '握手成功' };
      },
    });
    const user = await 打开模型();
    expect(screen.getByText(/342 ms/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '测试连通性' }));
    await waitFor(() => {
      expect(screen.getByText(/1420 ms（最近一次测试）/u)).toBeTruthy();
    });
  });
});

describe('失败时要说话', () => {
  /**
   * 第 5 轮审查 F3：「模型页启用/停用与删除没有错误处理，
   * 失败时界面一声不吭」。
   *
   * 用户点了「停用」，什么都没发生 —— 他会再点几次，
   * 然后开始怀疑是不是自己没点上。而真正的原因（乐观锁冲突、
   * 数据库忙）一个字都没露出来。
   */
  const 打开模型 = async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /Opus 5 · high/u }));
    return user;
  };

  it('停用失败时把原因显示出来', async () => {
    respond({
      'model.list': () => ({ items: [MODEL], total: 1 }),
      'model.update': () => {
        throw new Error('版本冲突：这条模型在别处改过了');
      },
    });
    const user = await 打开模型();
    await user.click(screen.getByRole('button', { name: '停用' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突');
  });

  it('删除失败时把原因显示出来，且不清空选中', async () => {
    respond({
      'model.list': () => ({ items: [MODEL], total: 1 }),
      'model.delete': () => {
        throw new Error('还有工作流在引用它');
      },
    });
    const user = await 打开模型();
    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('还有工作流在引用它');
    // 详情区还在：清空的话用户连重试都找不到入口
    expect(screen.getByRole('button', { name: '停用' })).toBeTruthy();
  });

  it('成功时不留报错', async () => {
    const user = await 打开模型();
    await user.click(screen.getByRole('button', { name: '停用' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('model.update', expect.anything());
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('从 runtime 同步模型清单', () => {
  /*
   * 「先同步，然后选择」。
   *
   * 在这之前模型要**手工登记**：用户自己敲模型 ID、上下文窗口、能力清单。
   * 那套做法的问题不是麻烦，是**敲进去的值多半是错的** —— 内置种子里那两条
   * （gpt-5-codex / claude-opus-5）实测都不在 agent 认的候选里，
   * 设下去会被当场拒掉。清单只能问 runtime 要。
   */
  it('点同步会去问 runtime，然后刷新列表', async () => {
    const 同步入参: unknown[] = [];
    respond({
      'model.list': () => ({ items: [MODEL], total: 1 }),
      'model.sync': (input) => {
        同步入参.push(input);
        return {
          models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: '' }],
          efforts: [{ value: 'high', label: 'High', description: '' }],
          currentModel: 'gpt-5.6-sol',
          currentEffort: 'high',
          added: 1,
        };
      },
    });
    view();

    await userEvent.click(await screen.findByRole('button', { name: /同步/ }));

    await waitFor(() => expect(同步入参.length).toBe(1));
    expect(同步入参[0]).toMatchObject({ runtime: expect.any(String) });
    // 同步完必须重拉列表：不拉的话用户点完什么都没变，
    // 而条目其实已经进库了 —— 他会再点几次
    await waitFor(() =>
      expect(call.mock.calls.filter((c) => c[0] === 'model.list').length).toBeGreaterThan(1),
    );
  });

  it('同步失败时说清怎么办，而不是留一个空列表', async () => {
    respond({
      'model.list': () => ({ items: [], total: 0 }),
      'model.sync': () => {
        throw new Error('acp.codex 的 adapter 没有安装');
      },
    });
    view();

    await userEvent.click(await screen.findByRole('button', { name: /同步/ }));

    // 空列表与「adapter 没装」在界面上长得一样，而用户要做的事完全不同
    expect(await screen.findByText(/没有安装/)).toBeTruthy();
  });

  it('空态不再说「ACP 握手不返回模型列表」—— 那句话是错的', async () => {
    respond({ 'model.list': () => ({ items: [], total: 0 }) });
    view();

    await screen.findByRole('button', { name: /同步/ });
    expect(
      screen.queryByText(/握手不返回模型列表/),
      'session/new 的 configOptions 里就带着模型清单（两端实测），\n' +
        '这句话会让用户以为只能手工敲',
    ).toBeNull();
  });
});
