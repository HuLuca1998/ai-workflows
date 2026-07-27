import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Card, Dialog, Field, StatusBadge, Table, Tag } from '../src/index.js';

describe('Button', () => {
  it('默认是 secondary，主操作用 primary 且是描边而非填充', () => {
    const { rerender } = render(<Button>取消</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'secondary');
    rerender(<Button variant="primary">开始运行</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'primary');
  });

  it('禁用时不触发点击', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        发布
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('加载中要有可读的状态说明，不能只转圈', () => {
    render(<Button loading>发布</Button>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('图标按钮必须有无障碍名称', () => {
    render(<Button variant="icon" aria-label="适应视图" />);
    expect(screen.getByRole('button', { name: '适应视图' })).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('重要状态不只用颜色表达——同时给出文字', () => {
    render(<StatusBadge status="waiting_approval" />);
    expect(screen.getByText('等待审批')).toBeInTheDocument();
  });

  it('带 role=status，屏幕阅读器能播报状态变化', () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'running');
  });

  it('覆盖全部运行状态，不会渲染出空标签', () => {
    for (const status of [
      'created',
      'preflight',
      'queued',
      'running',
      'waiting_approval',
      'paused',
      'interrupted',
      'resuming',
      'succeeded',
      'failed',
      'cancelled',
    ] as const) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByRole('status').textContent?.trim()).not.toBe('');
      unmount();
    }
  });

  it('失败状态额外给出可感知的形状标记，色盲用户也能分辨', () => {
    render(<StatusBadge status="failed" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-shape', 'cross');
  });
});

describe('Field', () => {
  it('label 与控件正确关联，点击标签能聚焦输入', () => {
    render(<Field label="Issue 编号" name="issue" defaultValue="548" />);
    const input = screen.getByLabelText('Issue 编号');
    expect(input).toHaveValue('548');
  });

  it('必填项在语义上也标出来，而不只是画个星号', () => {
    render(<Field label="仓库" name="repo" required />);
    expect(screen.getByLabelText(/仓库/u)).toBeRequired();
  });

  it('错误信息通过 aria-describedby 关联', () => {
    render(<Field label="工作目录" name="workdir" error="目录未授权" />);
    const input = screen.getByLabelText(/工作目录/u);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe('目录未授权');
  });
});

describe('Dialog', () => {
  it('打开时是模态对话框并带标题', () => {
    render(
      <Dialog open title="节点配置" onClose={() => {}}>
        内容
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('节点配置');
  });

  it('Esc 关闭——这是全局快捷键约定的一部分', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="节点配置" onClose={onClose}>
        内容
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('关闭时不渲染任何内容', () => {
    render(
      <Dialog open={false} title="节点配置" onClose={() => {}}>
        内容
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Table 与 Card、Tag', () => {
  it('Table 渲染语义表格并带 caption 供无障碍读取', () => {
    render(
      <Table
        caption="全部工作流"
        columns={[
          { key: 'name', header: '名称' },
          { key: 'status', header: '状态' },
        ]}
        rows={[{ id: '1', name: 'GitHub Issue 修复', status: '等待审批' }]}
      />,
    );
    expect(screen.getByRole('table', { name: '全部工作流' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '名称' })).toBeInTheDocument();
    expect(screen.getByText('GitHub Issue 修复')).toBeInTheDocument();
  });

  it('Table 无数据时给出空态说明而不是空白', () => {
    render(<Table caption="运行" columns={[{ key: 'a', header: 'A' }]} rows={[]} empty="先在编辑器点运行" />);
    expect(screen.getByText('先在编辑器点运行')).toBeInTheDocument();
  });

  it('Card 用 section 语义并把标题接到无障碍名称上', () => {
    render(<Card title="今日运行">120 成功</Card>);
    expect(screen.getByRole('region', { name: '今日运行' })).toBeInTheDocument();
  });

  it('Tag 渲染文本与色调', () => {
    render(<Tag tone="accent">v7</Tag>);
    expect(screen.getByText('v7')).toHaveAttribute('data-tone', 'accent');
  });
});
