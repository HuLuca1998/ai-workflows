import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { OverviewPage } from '../src/pages/OverviewPage.js';
import { useWorkspace } from '../src/data/workspace.js';

/**
 * 概览页按图纸「01 工作流首页」实现。
 *
 * 守的是两件事：结构与图纸一致（四张卡、标签、筛选 chips），
 * 以及引擎未接通时数值位留空——不填演示数字，也不加图纸上没有的说明文案。
 */

const renderPage = () =>
  render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  // 把 load 换成 noop：这里测的是渲染与交互，数据层由 workspace 自己的用例覆盖。
  // 不换的话页面挂载时的真实加载会把预置状态覆盖掉。
  useWorkspace.setState({ workflows: [], loading: false, error: null, load: async () => {} });
});

describe('页面骨架', () => {
  it('标题与 kicker 按图纸：大标题「工作流」+ 本地优先计数', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '工作流', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/本地优先 · \d+ 个工作流/u)).toBeInTheDocument());
  });

  it('统计条四张卡与图纸一致', () => {
    renderPage();
    const stats = screen.getByRole('region', { name: '概览统计' });
    for (const label of ['等待审批', '今日运行', 'Token 用量', '活跃 worktree']) {
      expect(within(stats).getByText(label)).toBeInTheDocument();
    }
  });

  it('引擎未接通时数值位留空，不填演示数字也不加图纸外的文案', () => {
    renderPage();
    const stats = screen.getByRole('region', { name: '概览统计' });
    expect(stats.textContent).not.toMatch(/[0-9]/u);
    expect(stats.textContent).not.toMatch(/可用|待接入|—/u);
  });

  it('搜索框与两个操作按钮就位', () => {
    renderPage();
    expect(screen.getByLabelText('搜索工作流')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入' })).toBeInTheDocument();
    // 空态里也有一个「新建工作流」，头部这个在页面头部内
    const head = screen.getByRole('heading', { name: '工作流', level: 1 }).closest('header');
    expect(head).not.toBeNull();
    expect(
      within(head as HTMLElement).getByRole('button', { name: /新建工作流/u }),
    ).toBeInTheDocument();
  });
});

describe('空态', () => {
  it('没有工作流时说明会发生什么，并给一条出路', () => {
    renderPage();
    expect(screen.getByText('还没有工作流')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新建空白工作流/u })).toBeInTheDocument();
  });

  it('列出可用模板（图纸：空态显示模板库入口）', async () => {
    const { WORKFLOW_TEMPLATES } = await import('@aiwf/contracts');
    renderPage();
    for (const template of WORKFLOW_TEMPLATES) {
      expect(screen.getByText(template.name)).toBeInTheDocument();
      expect(screen.getByText(template.summary)).toBeInTheDocument();
    }
  });

  it('点模板会带着模板的结构化操作去创建', async () => {
    const { WORKFLOW_TEMPLATES } = await import('@aiwf/contracts');
    const created: unknown[] = [];
    useWorkspace.setState({
      createWorkflow: async (name, operations) => {
        created.push({ name, count: operations?.length ?? 0 });
        return 'wf_new';
      },
    });
    renderPage();

    const template = WORKFLOW_TEMPLATES[0];
    expect(template).toBeDefined();
    fireEvent.click(screen.getByText(template!.name));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ name: template!.name });
    expect((created[0] as { count: number }).count).toBeGreaterThan(10);
  });
});

describe('列表与筛选', () => {
  const seed = () =>
    useWorkspace.setState({
      workflows: [
        { id: 'wf_1', name: 'GitHub Issue 修复', updatedAt: '2026-07-27T09:00:00.000Z' },
        {
          id: 'wf_2',
          name: '错误日志归因',
          folder: '工作区',
          updatedAt: '2026-07-27T08:00:00.000Z',
        },
      ],
      loading: false,
      error: null,
    });

  it('有数据时渲染表格与四列表头', () => {
    seed();
    renderPage();
    expect(screen.getByRole('columnheader', { name: '名称' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '版本 · 触发' })).toBeInTheDocument();
    expect(screen.getByText('GitHub Issue 修复')).toBeInTheDocument();
  });

  it('搜索按名称过滤', () => {
    seed();
    renderPage();
    fireEvent.change(screen.getByLabelText('搜索工作流'), { target: { value: '归因' } });
    expect(screen.queryByText('GitHub Issue 修复')).toBeNull();
    expect(screen.getByText('错误日志归因')).toBeInTheDocument();
  });

  it('筛选无结果时提示并提供清除筛选', () => {
    seed();
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: '运行中' }));
    expect(screen.getByText(/当前筛选下没有工作流/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByText('GitHub Issue 修复')).toBeInTheDocument();
  });

  it('读取失败时报出原因，而不是显示空列表假装正常', () => {
    useWorkspace.setState({ workflows: [], loading: false, error: 'workflow.list 调用失败' });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('workflow.list 调用失败');
  });
});
