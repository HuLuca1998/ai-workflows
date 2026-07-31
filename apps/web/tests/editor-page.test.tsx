import { act, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import userEvent from '@testing-library/user-event';
import { EditorPage } from '../src/editor/EditorPage.js';
import { useEditor } from '../src/editor/editorStore.js';

/**
 * 编辑器页面。这里验证图纸「02 画布编辑器」上的元素真的在：
 * 工具栏（名称 / 草稿标签 / 校验状态 / 版本 / 发布 / 运行）、
 * 节点库、缩放控件、左下状态条。
 */

const graph = {
  nodes: [
    {
      id: 'entry',
      type: 'entry' as const,
      title: '入口 · Issue 输入',
      position: { x: 40, y: 34 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    {
      id: 'end',
      type: 'end' as const,
      title: '结束',
      position: { x: 340, y: 34 },
      config: { outcome: 'success' as const },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'end', port: 'input' },
    },
  ],
  groups: [],
};

const renderEditor = (path = '/editor/wf_1') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/editor/:workflowId" element={<EditorPage />} />
        <Route path="/editor" element={<EditorPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  useEditor.setState({
    workflowId: 'wf_1',
    name: 'GitHub Issue 修复',
    rev: 4,
    graph,
    versions: [
      {
        id: 'wv_1',
        version: 7,
        configHash: 'abc',
        publishedAt: '2026-07-27T09:00:00.000Z',
        publishedBy: '本地用户',
      },
    ],
    validation: { ok: true, issues: [] },
    selection: [],
    loading: false,
    saving: false,
    dirty: false,
    error: null,
    // 页面挂载时会调 load，这里换成 noop 避免真的走 IPC
    load: async () => {},
    clear: async () => {},
  });
});

describe('工具栏', () => {
  it('显示工作流名与「草稿 · 基于 vN」标签（图纸原文）', async () => {
    renderEditor();
    expect(
      await screen.findByRole('heading', { name: 'GitHub Issue 修复', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('草稿 · 基于 v7')).toBeInTheDocument();
  });

  it('从未发布过时显示 rev 而不是编一个版本号', () => {
    useEditor.setState({ versions: [] });
    renderEditor();
    expect(screen.getByText('草稿 · rev4')).toBeInTheDocument();
  });

  it('校验通过时显示节点与连接数（图纸：校验通过 · 9 节点 8 连接）', () => {
    renderEditor();
    expect(screen.getByText('校验通过 · 2 节点 1 连接')).toBeInTheDocument();
  });

  it('有 error 级问题时改显示问题计数，并禁用发布', () => {
    useEditor.setState({
      validation: {
        ok: false,
        issues: [
          { level: 'error', code: 'INVALID_CONFIG', message: 'x', nodeId: 'entry' },
          { level: 'warning', code: 'ORPHAN_NODE', message: 'y', nodeId: 'end' },
        ],
      },
    });
    renderEditor();
    // warning 不计入：它不阻塞发布
    expect(screen.getByText('1 个问题 · 2 节点 1 连接')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发布版本' })).toBeDisabled();
  });

  it('没有改动时保存按钮显示「已保存」且禁用', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled();
  });

  it('有改动时保存按钮可点', () => {
    useEditor.setState({ dirty: true });
    renderEditor();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled();
  });

  it('有未保存改动时运行按钮禁用并说明原因——运行的是已落库的修订', () => {
    renderEditor();
    const run = screen.getByRole('button', { name: /运行/u });
    // 测试夹具的草稿是干净的，这里改脏后再断言
    act(() => {
      useEditor.setState({ dirty: true });
    });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', expect.stringContaining('先保存草稿'));
  });

  it('草稿干净且校验通过时可以运行', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: /运行/u })).toBeEnabled();
  });

  it('撤销重做保持禁用（快捷键表里标为待实现）', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: /撤销/u })).toBeDisabled();
    expect(screen.getByRole('button', { name: /重做/u })).toBeDisabled();
  });
});

describe('节点库', () => {
  it('标题与图纸一致，且列出可拖入的节点', () => {
    renderEditor();
    const lib = screen.getByRole('complementary', { name: '节点库' });
    expect(within(lib).getByText('节点库 · 拖入画布')).toBeInTheDocument();
    expect(within(lib).getByLabelText('搜索节点')).toBeInTheDocument();
    expect(within(lib).getByText('入口设置')).toBeInTheDocument();
    // 脚本那条在图纸里合并展示，拖入时要能分别选 shell 与 python
    expect(within(lib).getByText('Shell 脚本')).toBeInTheDocument();
    expect(within(lib).getByText('Python 脚本')).toBeInTheDocument();
  });

  it('搜索能过滤条目', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    renderEditor();
    const lib = screen.getByRole('complementary', { name: '节点库' });
    await userEvent.type(within(lib).getByLabelText('搜索节点'), '审批');
    expect(within(lib).getByText('审批')).toBeInTheDocument();
    expect(within(lib).queryByText('入口设置')).toBeNull();
  });
});

describe('画布周边', () => {
  it('四个缩放控件齐全（图纸右上角）', () => {
    renderEditor();
    for (const label of ['放大', '缩小', '适应视图', '缩放复位到 100%']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('左下状态条显示操作提示与计数（图纸原文）', () => {
    // 快捷键提示按平台走 —— 图纸画的是 macOS，这里就按 macOS 断言
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    renderEditor();
    expect(screen.getByText('双击编辑 · 右键菜单')).toBeInTheDocument();
    expect(screen.getByText('端口拖出连线 · 点连线可删')).toBeInTheDocument();
    expect(screen.getByText('Shift 框选 · ⌘A 全选')).toBeInTheDocument();
    expect(screen.getByText('未选中')).toBeInTheDocument();
    expect(screen.getByText('2 节点 1 连接')).toBeInTheDocument();
  });

  it('空图给出图纸上的提示语', () => {
    useEditor.setState({ graph: { nodes: [], edges: [], groups: [] } });
    renderEditor();
    expect(screen.getByText('从左侧拖入入口节点')).toBeInTheDocument();
  });

  it('渲染出画布节点本体', async () => {
    renderEditor();
    // 「结束」既是节点库条目也是画布节点标题，限定在画布内查找
    await waitFor(() => expect(screen.getByText('入口 · Issue 输入')).toBeInTheDocument());
    const canvasNodes = document.querySelectorAll('.wf-node__title');
    expect([...canvasNodes].map((el) => el.textContent)).toEqual(['入口 · Issue 输入', '结束']);
  });
});

describe('异常态', () => {
  it('错误以 alert 呈现，不是静默失败', () => {
    useEditor.setState({ error: '草稿已变化：基础版本 4，当前 rev 6' });
    renderEditor();
    expect(screen.getByRole('alert')).toHaveTextContent('草稿已变化');
  });

  it('不带工作流 id 时给空态与去处，而不是空白画布', () => {
    renderEditor('/editor');
    expect(screen.getByRole('heading', { name: '工作流编辑器', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '概览与工作流' })).toBeInTheDocument();
  });
});

describe('右键菜单', () => {
  it('节点右键弹出菜单，含图纸列出的五项', async () => {
    const { fireEvent } = await import('@testing-library/react');
    renderEditor();
    const node = document.querySelector('.wf-node');
    expect(node).not.toBeNull();

    fireEvent.contextMenu(node as Element);
    const menu = screen.getByRole('menu');
    for (const label of ['编辑配置', '复制', '断开全部连线', '用选中节点建分组', '删除']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('点「编辑配置」打开配置弹层而不是改图', async () => {
    const { fireEvent } = await import('@testing-library/react');
    renderEditor();
    fireEvent.contextMenu(document.querySelector('.wf-node') as Element);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑配置' }));

    expect(screen.getByRole('dialog')).toHaveAccessibleName(/配置/u);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Esc 关闭菜单', async () => {
    const { fireEvent } = await import('@testing-library/react');
    renderEditor();
    fireEvent.contextMenu(document.querySelector('.wf-node') as Element);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('选中不足两个时「建分组」禁用并给出原因', async () => {
    const { fireEvent } = await import('@testing-library/react');
    renderEditor();
    fireEvent.contextMenu(document.querySelector('.wf-node') as Element);
    const item = screen.getByRole('menuitem', { name: '用选中节点建分组' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', expect.stringContaining('两个以上'));
  });
});

describe('工作流改名', () => {
  it('双击标题进入编辑态', async () => {
    const user = userEvent.setup();
    renderEditor();

    const title = await screen.findByRole('heading', { level: 1 });
    await user.dblClick(title);

    expect(screen.getByLabelText('工作流名称')).toBeInTheDocument();
  });

  it('回车提交改名', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.dblClick(await screen.findByRole('heading', { level: 1 }));
    const input = screen.getByLabelText('工作流名称');
    await user.clear(input);
    await user.type(input, 'GitHub Issue 修复{Enter}');

    await waitFor(() => {
      expect(useEditor.getState().name).toBe('GitHub Issue 修复');
    });
  });

  it('Esc 取消，名字不变', async () => {
    const user = userEvent.setup();
    renderEditor();
    const before = useEditor.getState().name;

    await user.dblClick(await screen.findByRole('heading', { level: 1 }));
    const input = screen.getByLabelText('工作流名称');
    await user.clear(input);
    await user.type(input, '不该生效{Escape}');

    expect(useEditor.getState().name).toBe(before);
  });

  it('空名字不提交 —— 不为一次误触发一条审计记录', async () => {
    const user = userEvent.setup();
    renderEditor();
    const before = useEditor.getState().name;

    await user.dblClick(await screen.findByRole('heading', { level: 1 }));
    const input = screen.getByLabelText('工作流名称');
    await user.clear(input);
    await user.type(input, '   {Enter}');

    expect(useEditor.getState().name).toBe(before);
  });
});

describe('保存失败后用户有出路', () => {
  /**
   * codex 的原话：「恢复网络后没有『重试保存』，原修改也已经不在」。
   * 现在改动留着了（DraftStore 不再回滚），界面要把这件事说清楚：
   * 报错、按钮仍可按、以及一条主动放弃的出路。
   */
  it('报错时按钮仍是「保存草稿」而不是禁用的「已保存」', () => {
    useEditor.setState({ dirty: true, error: '连不上开发服务 http://127.0.0.1:5177' });
    renderEditor();

    const save = screen.getByRole('button', { name: '保存草稿' });
    expect(save).toBeEnabled();
  });

  it('报错旁边给「放弃本地改动」—— 冲突时重试没用，得能脱身', async () => {
    const user = userEvent.setup();
    let discarded = false;
    useEditor.setState({
      dirty: true,
      error: '草稿已变化：基础版本 4，当前 rev 6',
      discardLocal: () => {
        discarded = true;
      },
    });
    renderEditor();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('草稿已变化');

    await user.click(within(alert).getByRole('button', { name: '放弃本地改动' }));
    expect(discarded).toBe(true);
  });

  it('没有未保存改动时不给放弃按钮 —— 没东西可放弃', () => {
    useEditor.setState({ dirty: false, error: '读取失败' });
    renderEditor();

    expect(screen.queryByRole('button', { name: '放弃本地改动' })).toBeNull();
  });
});

describe('刷新前拦一下未保存的草稿', () => {
  /**
   * codex 的原话：「刷新页面不提示，未保存的整张草稿直接消失」。
   * 站内跳转再后退能保住现场（那条是 🟢），刷新和关标签不能 ——
   * 浏览器只给 beforeunload 这一个口子。
   */
  it('有未保存改动时 beforeunload 被拦下', () => {
    useEditor.setState({ dirty: true });
    renderEditor();

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented, '刷新会静默丢掉整张草稿').toBe(true);
  });

  it('已保存时不拦 —— 别为难没有风险的离开', () => {
    useEditor.setState({ dirty: false });
    renderEditor();

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('离开编辑器后不再拦 —— 监听得摘干净', () => {
    useEditor.setState({ dirty: true });
    const { unmount } = renderEditor();
    unmount();

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
