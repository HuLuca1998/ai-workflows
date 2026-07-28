import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 分页控件。
 *
 * 1292 条工作流一次铺满页面，浏览器要建出上千个 DOM 节点，
 * 而用户真正关心的那几条淹在里面。
 *
 * 这个控件被所有列表共用 —— 各写一份的话，翻页行为会各不相同，
 * 而用户会以为是自己记错了。
 */

const { Pager } = await import('../src/layout/Pager.js');

const view = (props: Partial<React.ComponentProps<typeof Pager>> = {}) => {
  const onChange = vi.fn();
  render(<Pager total={1292} pageSize={50} offset={0} onChange={onChange} {...props} />);
  return onChange;
};

describe('显示', () => {
  it('说清现在看的是哪一段、一共多少', () => {
    view();
    // 范围与总数分在两个元素里（总数用弱化的样式），所以整段一起看
    const range = screen.getByRole('status').textContent ?? '';
    expect(range).toMatch(/1\s*–\s*50/u);
    expect(range).toContain('1,292');
  });

  it('最后一页不足一整页时按实际条数显示', () => {
    view({ total: 1292, offset: 1250 });
    expect(screen.getByText(/1251\s*–\s*1292/u)).toBeTruthy();
  });

  it('一页就装得下时整个控件不出现 —— 那时它只是噪音', () => {
    const { container } = render(<Pager total={12} pageSize={50} offset={0} onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('一条都没有时也不出现', () => {
    const { container } = render(<Pager total={0} pageSize={50} offset={0} onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('翻页', () => {
  it('下一页把 offset 推进一整页', async () => {
    const user = userEvent.setup();
    const onChange = view();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(onChange).toHaveBeenCalledWith(50);
  });

  it('上一页退回一整页', async () => {
    const user = userEvent.setup();
    const onChange = view({ offset: 100 });
    await user.click(screen.getByRole('button', { name: '上一页' }));
    expect(onChange).toHaveBeenCalledWith(50);
  });

  it('第一页时上一页不可点 —— 而不是点了没反应', () => {
    view({ offset: 0 });
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  it('最后一页时下一页不可点', () => {
    view({ total: 100, offset: 50 });
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('翻到最后一页不会越过总数', async () => {
    const user = userEvent.setup();
    const onChange = view({ total: 1292, offset: 1200 });
    await user.click(screen.getByRole('button', { name: '下一页' }));
    // 1250 仍在范围内（1251–1292）
    expect(onChange).toHaveBeenCalledWith(1250);
  });
});

describe('无障碍', () => {
  it('是一个有名字的导航区 —— 读屏要能跳到它', () => {
    view();
    expect(screen.getByRole('navigation', { name: '分页' })).toBeTruthy();
  });

  it('当前范围用 status 播报 —— 翻页后读屏用户要知道自己在哪', () => {
    view();
    expect(screen.getByRole('status').textContent).toMatch(/1\s*–\s*50/u);
  });
});

describe('防御', () => {
  it('total 缺失时不渲染，而不是在 toLocaleString 上崩掉', () => {
    // 加载中、或者后端还没接上分页时都会走到这，
    // 而一个未捕获的异常会让整页白屏
    const { container } = render(
      <Pager total={undefined as unknown as number} pageSize={50} offset={0} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('offset 缺失时当第一页', () => {
    view({ offset: undefined as unknown as number });
    expect(screen.getByRole('status').textContent).toMatch(/1\s*–\s*50/u);
  });
});
