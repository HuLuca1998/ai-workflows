import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 提示词库 —— 图纸「06 提示词库」。
 *
 * 要压住的产品规则：
 * 1. 这里收着系统调用 AI 的各处提示词 —— 内置条目不能删，只能复制
 * 2. 执行路径尚未接上，界面必须如实说明（纪律二：绝不假装成功）
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

  it('底部常驻的说明如实交代「执行路径尚未接上」', async () => {
    view();
    expect(
      await screen.findByText(/执行路径尚未接上 —— 运行时用的仍是引擎内建的那一份/u),
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

  // DEBT.md B-3：run_ai 只读 agentProfileId + instruction，promptId 在
  // crates/engine/src 里出现 0 次。界面不能承诺「保存后新运行生效」。
  it('提示条如实说明引擎目前不读提示词库', async () => {
    await open();
    expect(
      screen.getByText('框架分段可见可改 · 引擎目前不读提示词库，改了不会影响运行'),
    ).toBeTruthy();
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

describe('版本页照图纸列出历史', () => {
  /**
   * 图纸「06 提示词库」版本页：
   *   v4 · 当前 | 2 天前 · 你    | 加入「信息不足时列出缺什么」约束
   *   v3       | 上周 · AI 提议 | 输出契约改为多篇 Markdown + JSON 摘要
   *   v2       | 3 周前 · 你    | 限制单篇 400 字
   *
   * 之前只显示当前版本，而这一页底部写着「运行记录会引用当时的提示词版本，
   * 历史结果始终可解释」—— 历史都看不到，那句话就是空的。
   */
  const 历史 = {
    items: [
      {
        ver: 2,
        name: '根因分析',
        sections: [{ title: 'Role', body: '第二版' }],
        vars: [],
        changedBy: 'AI 提议',
        createdAt: '2026-07-26T10:00:00Z',
      },
      {
        ver: 1,
        name: '根因分析',
        sections: [{ title: 'Role', body: '第一版' }],
        vars: [],
        changedBy: '你',
        createdAt: '2026-07-20T10:00:00Z',
      },
    ],
  };

  it('打开版本页时才去取历史 —— 别为一个没人看的页签发请求', async () => {
    const user = userEvent.setup();
    respond({ 'prompt.versions': () => 历史 });
    view();
    await screen.findByText('分析 · 根因');
    expect(call).not.toHaveBeenCalledWith('prompt.versions', expect.anything());

    await user.click(screen.getByText('分析 · 根因'));
    await user.click(screen.getByRole('tab', { name: '版本' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('prompt.versions', { promptId: 'prompt_1' });
    });
  });

  it('当前版本排最前并标「当前」，历史跟在后面', async () => {
    const user = userEvent.setup();
    respond({ 'prompt.versions': () => 历史 });
    view();
    await user.click(await screen.findByText('分析 · 根因'));
    await user.click(screen.getByRole('tab', { name: '版本' }));

    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('当前');
    // 版本号在各自那一行的 __version-name 里，直接取那个元素 ——
    // 对整行文本做正则会把后面的时间戳一起吃进来
    const names = rows.map((r) => r.querySelector('.prompts__version-name')?.textContent);
    expect(names).toEqual(['v4 · 当前', 'v2', 'v1']);
  });

  it('分得清人改的还是 AI 改的 —— 图纸写的是「你」与「AI 提议」', async () => {
    const user = userEvent.setup();
    respond({ 'prompt.versions': () => 历史 });
    view();
    await user.click(await screen.findByText('分析 · 根因'));
    await user.click(screen.getByRole('tab', { name: '版本' }));

    expect(await screen.findByText(/AI 提议/u)).toBeTruthy();
  });

  it('没有历史时说明为什么 —— 而不是只剩一行当前版本', async () => {
    const user = userEvent.setup();
    respond({ 'prompt.versions': () => ({ items: [] }) });
    view();
    await user.click(await screen.findByText('分析 · 根因'));
    await user.click(screen.getByRole('tab', { name: '版本' }));

    expect(await screen.findByText(/还没有改过/u)).toBeTruthy();
  });

  it('保存新版本之后历史要重新拉 —— 刚被替换掉的那份就在里面', async () => {
    // codex 报「亲自把同一提示词从 v2 保存到 v3 后，版本页仍只有 v3」。
    // effect 只依赖 prompt.id 的话，保存后 id 没变、历史不重拉 ——
    // 用户看到的还是保存前那份（那时确实只有当前版本）
    const user = userEvent.setup();
    let 保存过 = false;
    respond({
      'prompt.versions': () =>
        保存过 ? { items: [{ ...历史.items[1]!, ver: 4 }] } : { items: [] },
      'prompt.update': () => {
        保存过 = true;
        return { ver: 5 };
      },
      'prompt.list': () => ({ items: [{ ...PROMPT, ver: 保存过 ? 5 : 4 }], total: 1 }),
    });
    view();
    await user.click(await screen.findByText('分析 · 根因'));
    await user.click(screen.getByRole('tab', { name: '版本' }));
    expect(await screen.findByText(/还没有改过/u)).toBeTruthy();

    // 回模板页改一笔再保存
    await user.click(screen.getByRole('tab', { name: '模板' }));
    await user.type(screen.getByLabelText('Role'), '改一笔');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));
    await waitFor(() => expect(保存过).toBe(true));

    await user.click(screen.getByRole('tab', { name: '版本' }));
    await waitFor(() => {
      expect(screen.getByText('v4')).toBeTruthy();
    });
  });

  it('取历史失败不该把这一页弄成空白', async () => {
    const user = userEvent.setup();
    respond({
      'prompt.versions': () => {
        throw new Error('数据库忙');
      },
    });
    view();
    await user.click(await screen.findByText('分析 · 根因'));
    await user.click(screen.getByRole('tab', { name: '版本' }));

    // 当前版本照旧显示，报错单独说
    expect(await screen.findByText(/v4 · 当前/u)).toBeTruthy();
    expect(await screen.findByRole('alert')).toHaveTextContent('数据库忙');
  });
});

describe('分段编辑照图纸', () => {
  /**
   * 图纸「06 提示词库」的分段区：每段标题右边有「插入变量」，
   * 列表底部有「添加分段（Examples / 失败处理 / 语言风格…）」。
   *
   * codex 的原话：变量页「没有告诉用户支持哪种占位符语法」。
   * 图纸的答案不是在变量页加「添加变量」按钮 —— 那里本来就只是张表；
   * 答案是「插入变量」：点它往正文里插入正确的写法。
   */
  async function open() {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 · 根因/u }));
    return user;
  }

  it('每段标题旁有「插入变量」', async () => {
    const user = await open();
    void user;
    const buttons = await screen.findAllByRole('button', { name: '插入变量' });
    expect(buttons.length).toBe(PROMPT.sections.length);
  });

  it('点它把占位符插进正文 —— 用户由此学会语法', async () => {
    const user = await open();
    const role = screen.getByLabelText('Role') as HTMLTextAreaElement;
    const before = role.value;

    await user.click(screen.getAllByRole('button', { name: '插入变量' })[0]!);

    expect(role.value.length).toBeGreaterThan(before.length);
    expect(role.value).toMatch(/\$\{[^}]+\}/u);
  });

  it('插入之后焦点回到正文，接着打字就能补完变量名', async () => {
    // codex 的原话：「点击『插入变量』会把 ${input.} 写入 textarea……
    // 但焦点仍留在按钮，紧接着键入 topic 时正文没有变化。
    // 用户必须再点回文本框并自己定位光标」。
    //
    // 插入的价值就在于「接着往下打」——不把焦点交回去的话，
    // 它只是个把字符串贴进去的按钮
    const user = await open();
    const role = screen.getByLabelText('Role') as HTMLTextAreaElement;

    await user.click(screen.getAllByRole('button', { name: '插入变量' })[0]!);
    expect(document.activeElement, '焦点没回到正文').toBe(role);

    await user.keyboard('topic');
    expect(role.value).toContain('topic');
  });

  it('光标落在占位符里面 —— 打出来的字要进 ${input.…} 而不是跟在后面', async () => {
    const user = await open();
    const role = screen.getByLabelText('Role') as HTMLTextAreaElement;

    await user.click(screen.getAllByRole('button', { name: '插入变量' })[0]!);
    await user.keyboard('topic');

    expect(role.value).toContain('${input.topic}');
  });

  it('底部有「添加分段」，文案照图纸给出例子', async () => {
    await open();
    expect(
      await screen.findByRole('button', { name: /添加分段（Examples \/ 失败处理 \/ 语言风格…）/u }),
    ).toBeTruthy();
  });

  it('加出来的分段能改名 —— 图纸的例子是 Examples、失败处理、语言风格', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: /添加分段/u }));

    const 新标题 = await screen.findByLabelText('新分段的标题');
    await user.clear(新标题);
    await user.type(新标题, '失败处理');
    await user.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByLabelText('失败处理')).toBeTruthy();
  });

  it('内置提示词不给这两个入口 —— 它是只读的', async () => {
    respond({ 'prompt.list': () => ({ items: [{ ...PROMPT, builtin: true }], total: 1 }) });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByText('分析 · 根因'));

    expect(screen.queryByRole('button', { name: '插入变量' })).toBeNull();
    expect(screen.queryByRole('button', { name: /添加分段/u })).toBeNull();
  });
});

describe('变量从正文里认出来', () => {
  /**
   * 图纸的变量表没有「添加」按钮：变量是**写在正文里**的占位符，
   * 表格只是把它们列出来说明各自从哪来。
   *
   * 之前变量表只显示后端存的那份，用户在正文里写了 ${input.repo}
   * 也不会出现在表里 —— 于是「0 变量」和正文里明明有的占位符对不上。
   */
  async function open() {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /分析 · 根因/u }));
    return user;
  }

  it('正文里的占位符出现在变量表里', async () => {
    const user = await open();
    await user.click(screen.getByRole('tab', { name: '变量' }));

    // fixture 的 Task 段里有 ${input.issue}
    expect(await screen.findByText('${input.issue}')).toBeTruthy();
  });

  it('新写进正文的占位符立刻出现在表里', async () => {
    const user = await open();
    const role = screen.getByLabelText('Role') as HTMLTextAreaElement;
    await user.click(role);
    await user.paste('仓库是 ${input.repo}。');

    await user.click(screen.getByRole('tab', { name: '变量' }));
    expect(await screen.findByText('${input.repo}')).toBeTruthy();
  });

  it('同一个占位符出现多次只列一行', async () => {
    const user = await open();
    const role = screen.getByLabelText('Role') as HTMLTextAreaElement;
    await user.click(role);
    await user.paste('${input.issue} 和 ${input.issue}');

    await user.click(screen.getByRole('tab', { name: '变量' }));
    expect(screen.getAllByText('${input.issue}')).toHaveLength(1);
  });

  it('没在正文里出现的变量标出来 —— 那多半是删正文时漏了它', async () => {
    respond({
      'prompt.list': () => ({
        items: [
          {
            ...PROMPT,
            sections: [{ title: 'Role', body: '没有任何占位符' }],
            vars: [{ name: '${input.issue}', source: '启动表单', onMissing: 'empty_and_log' }],
          },
        ],
        total: 1,
      }),
    });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByText('分析 · 根因'));
    await user.click(screen.getByRole('tab', { name: '变量' }));

    expect(await screen.findByText('正文里没用到')).toBeTruthy();
  });
});
