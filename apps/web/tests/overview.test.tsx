import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { OverviewPage } from '../src/pages/OverviewPage.js';
import { useWorkspace } from '../src/data/workspace.js';

/**
 * 概览页按图纸「01 工作流首页」实现。
 *
 * 这里守的核心是一条产品原则：**界面上不出现假数据**。
 * 引擎还没接上的统计必须显示「—」并说明原因，否则「可解释优先」就失效了。
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

  it('统计条四列齐全', () => {
    renderPage();
    // 在统计区内查找：「工作流」既是大标题也是统计卡标签
    const stats = screen.getByRole('region', { name: '概览统计' });
    for (const label of ['等待审批', '今日运行', 'Token 用量', '工作流']) {
      expect(within(stats).getByText(label)).toBeInTheDocument();
    }
  });

  it('引擎未接上的统计显示「—」并标明何时可用，而不是编一个数字', () => {
    renderPage();
    const stats = screen.getByRole('region', { name: '概览统计' });
    expect(within(stats).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(within(stats).getAllByText(/接上后可用/u).length).toBeGreaterThan(0);
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
    expect(screen.getByText(/模板库（6 个预设流程）在 M1/u)).toBeInTheDocument();
    // 两个入口：头部的与空态里的
    expect(screen.getAllByRole('button', { name: /新建工作流/u }).length).toBe(2);
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
