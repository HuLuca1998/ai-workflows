import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphNode, WorkflowGraph } from '@aiwf/contracts';
import { NodeConfigDialog } from '../src/editor/NodeConfigDialog.js';

/**
 * 节点配置弹层。核心验证点是「表单完全由 Schema 驱动」——
 * 换一种节点类型，字段自动变，这个文件不用改。
 */

const graph: WorkflowGraph = { nodes: [], edges: [], groups: [] };

const shellNode: GraphNode = {
  id: 'lint',
  type: 'script.shell',
  title: '运行 lint',
  position: { x: 0, y: 0 },
  config: {
    interpreter: 'zsh',
    script: 'pnpm lint',
    env: { CI: '1' },
    secretEnv: {},
    outputParse: 'none',
    successExitCodes: [0],
    outputLimitBytes: 1048576,
    timeoutMs: 900000,
  },
};

const renderDialog = (node: GraphNode = shellNode, onSave = vi.fn()) => {
  const utils = render(
    <NodeConfigDialog node={node} graph={graph} onClose={() => {}} onSave={onSave} />,
  );
  return { ...utils, onSave };
};

describe('弹层结构（照图纸）', () => {
  it('是模态对话框，标题可编辑', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('节点标题')).toHaveValue('运行 lint');
  });

  it('四个标签页与图纸一致，并常驻「改动只影响草稿」', () => {
    renderDialog();
    for (const tab of ['配置', '输入 / 输出', '权限与能力', '重试与超时']) {
      expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    }
    expect(screen.getByText('改动只影响草稿')).toBeInTheDocument();
  });

  it('底部三个按钮；试运行禁用并说明要等引擎', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存到草稿' })).toBeInTheDocument();
    const testRun = screen.getByRole('button', { name: '测试运行此节点' });
    expect(testRun).toBeDisabled();
    expect(testRun).toHaveAttribute('title', expect.stringContaining('M2'));
  });
});

describe('Schema 驱动的表单', () => {
  it('字段标签来自 Schema 的 describe，不是 camelCase 键名', () => {
    renderDialog();
    expect(screen.getByLabelText(/解释器/u)).toBeInTheDocument();
    expect(screen.getByLabelText(/脚本内容/u)).toBeInTheDocument();
    expect(screen.getByLabelText(/输出上限（字节）/u)).toBeInTheDocument();
    // 键名不该出现在界面上
    expect(screen.queryByText('outputLimitBytes')).toBeNull();
  });

  it('枚举渲染成下拉并带全部可选值', () => {
    renderDialog();
    const select = screen.getByLabelText(/解释器/u);
    expect(select.tagName).toBe('SELECT');
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      'zsh',
      'bash',
      'sh',
    ]);
  });

  it('长文本渲染成 textarea，数字渲染成 number 输入', () => {
    renderDialog();
    expect(screen.getByLabelText(/脚本内容/u).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(/输出上限（字节）/u)).toHaveAttribute('type', 'number');
  });

  it('字符串数组渲染成 chips，可增删', () => {
    renderDialog();
    // successExitCodes 是数字数组，也走 chips
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移除 0' })).toBeInTheDocument();
  });

  it('键值对渲染成两列表格', () => {
    renderDialog();
    expect(screen.getByLabelText('键 1')).toHaveValue('CI');
    expect(screen.getByLabelText('值 1')).toHaveValue('1');
  });

  it('必填字段标出星号，可选字段的下拉给「未设置」选项', () => {
    renderDialog();
    const interpreterLabel = screen.getByText(/解释器/u);
    expect(interpreterLabel.textContent).toContain('*');
    const parse = screen.getByLabelText(/输出解析/u) as HTMLSelectElement;
    // outputParse 有默认值所以非必填，要能清空
    expect([...parse.options].some((o) => o.textContent === '未设置')).toBe(true);
  });

  it('换一种节点类型，字段自动跟着变（同一个组件不改代码）', () => {
    const approval: GraphNode = {
      id: 'ap',
      type: 'approval',
      title: '检查 Diff',
      position: { x: 0, y: 0 },
      config: {
        title: '检查 Diff',
        interaction: 'confirm',
        bodyMarkdown: '',
        options: [],
        waitStrategy: 'forever',
      },
    };
    renderDialog(approval);
    expect(screen.getByLabelText(/审批标题/u)).toBeInTheDocument();
    expect(screen.getByLabelText(/交互类型/u)).toBeInTheDocument();
    expect(screen.queryByLabelText(/解释器/u)).toBeNull();
  });

  it('字段提示来自 describe 的第二行——产品原则要能出现在界面上', () => {
    const exec: GraphNode = {
      id: 'ex',
      type: 'ai.execute',
      title: '执行',
      position: { x: 0, y: 0 },
      config: {
        agentProfileId: 'a1',
        instruction: '改代码',
        workdirSource: 'worktree',
        verifyCommands: [],
        turnLimit: 12,
      },
    };
    renderDialog(exec);
    expect(screen.getByText(/由引擎强制，Prompt 不能改变安全边界/u)).toBeInTheDocument();
  });
});

describe('保存', () => {
  it('通过 Schema 校验后回传解析结果与标题', () => {
    const onSave = vi.fn();
    renderDialog(shellNode, onSave);
    fireEvent.change(screen.getByLabelText(/脚本内容/u), { target: { value: 'pnpm test' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到草稿' }));

    expect(onSave).toHaveBeenCalledOnce();
    const [config, title] = onSave.mock.calls[0] as [Record<string, unknown>, string];
    expect(config.script).toBe('pnpm test');
    expect(title).toBe('运行 lint');
  });

  it('校验不通过时逐字段回显错误，不弹一句「保存失败」让人猜', () => {
    const onSave = vi.fn();
    renderDialog(shellNode, onSave);
    fireEvent.change(screen.getByLabelText(/脚本内容/u), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到草稿' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

describe('其余标签页', () => {
  it('输入输出页显示端口与引用写法，并注明只读', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '输入 / 输出' }));
    expect(screen.getByText('只读 · 在画布上改连线')).toBeInTheDocument();
    expect(screen.getByText('输出 · success')).toBeInTheDocument();
    expect(screen.getByText('${lint.success}')).toBeInTheDocument();
  });

  it('权限页显示能力声明，并写明由引擎强制', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '权限与能力' }));
    expect(screen.getByText(/能力声明（由引擎强制，Prompt 无法越权）/u)).toBeInTheDocument();
    expect(screen.getByText('文件：read-write')).toBeInTheDocument();
    expect(screen.getByText('凭据：未授予')).toBeInTheDocument();
  });

  it('外部写操作的节点在权限页给出额外警示', () => {
    const mcp: GraphNode = {
      id: 'm',
      type: 'mcp.tool',
      title: 'MCP',
      position: { x: 0, y: 0 },
      config: { serverId: 's', toolAllowlist: ['t'], args: {}, scopes: [] },
    };
    renderDialog(mcp);
    fireEvent.click(screen.getByRole('tab', { name: '权限与能力' }));
    expect(screen.getByText(/会产生外部写操作/u)).toBeInTheDocument();
  });

  it('重试页显示实际取值，并说明编辑要等引擎', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '重试与超时' }));
    expect(screen.getByText('15 min（墙钟）')).toBeInTheDocument();
    expect(screen.getByText(/要等引擎/u)).toBeInTheDocument();
  });
});

describe('校验文案是中文', () => {
  it('必填为空时说「不能为空」，不是 Zod 的英文默认值', () => {
    // codex 报的原文：清空脚本内容点保存，显示
    // `Too small: expected string to have >=1 characters`。
    // 能挡住保存，但不符合界面语言
    const onSave = vi.fn();
    render(<NodeConfigDialog node={shellNode} graph={graph} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/脚本内容/u), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到草稿' }));

    expect(screen.getByText('脚本内容不能为空')).toBeTruthy();
    expect(screen.queryByText(/Too small|expected string/u)).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});
