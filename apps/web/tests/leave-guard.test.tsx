import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import { SideNav } from '../src/layout/SideNav.js';
import { registerLeaveGuard, clearLeaveGuard } from '../src/layout/leaveGuard.js';

/**
 * 编辑器里有未保存的改动时，**从左侧导航离开也要先问**。
 *
 * 第三方巡检 B-05 实测：工具栏的「返回工作流列表」做得很好（弹窗 +
 * 两个明确出口），而侧栏那 7 个导航项一个都不拦 —— 拖了节点直接点
 * 「记忆」，改动静默丢失，回来节点位置已还原。
 *
 * 守卫做成模块级注册表而不是让 SideNav 直接读 editorStore：
 * 导航栏不该知道编辑器的事，而且下一个有脏数据的屏（Agent 角色页
 * 已经有自己的脏数据拦截）可以注册同一个口子。
 */

afterEach(() => clearLeaveGuard());

function view() {
  return render(
    <MemoryRouter initialEntries={['/editor/wf_1']}>
      <SideNav />
      <Routes>
        <Route path="/editor/:id" element={<p>编辑器</p>} />
        <Route path="/memory" element={<p>记忆页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('侧栏导航要尊重离开守卫', () => {
  it('守卫说「先别走」时不跳转', async () => {
    let asked = 0;
    registerLeaveGuard(() => {
      asked += 1;
      return false; // 拦下
    });
    const user = userEvent.setup();
    view();

    await user.click(screen.getByRole('link', { name: /记忆/u }));

    expect(asked, '守卫没被问过 —— 导航直接跳走了').toBe(1);
    expect(screen.queryByText('记忆页'), '守卫说了不走，却还是走了').toBeNull();
    expect(screen.getByText('编辑器')).toBeTruthy();
  });

  it('守卫拿得到用户想去哪 —— 不然「丢弃并离开」只能回一个写死的路径', async () => {
    // 复核实测 B：点「记忆」、确认丢弃，落在工作流列表
    let target: string | null = null;
    registerLeaveGuard((to) => {
      target = to;
      return false;
    });
    const user = userEvent.setup();
    view();

    await user.click(screen.getByRole('link', { name: /记忆/u }));

    expect(target).toBe('/memory');
  });

  it('守卫放行时正常跳转', async () => {
    registerLeaveGuard(() => true);
    const user = userEvent.setup();
    view();

    await user.click(screen.getByRole('link', { name: /记忆/u }));

    await waitFor(() => {
      expect(screen.getByText('记忆页')).toBeTruthy();
    });
  });

  it('没有守卫时不影响任何导航', async () => {
    const user = userEvent.setup();
    view();

    await user.click(screen.getByRole('link', { name: /记忆/u }));

    await waitFor(() => {
      expect(screen.getByText('记忆页')).toBeTruthy();
    });
  });

  it('注销之后不再拦 —— 编辑器卸载了守卫必须跟着走', async () => {
    registerLeaveGuard(() => false);
    clearLeaveGuard();
    const user = userEvent.setup();
    view();

    await user.click(screen.getByRole('link', { name: /记忆/u }));

    await waitFor(() => {
      expect(screen.getByText('记忆页')).toBeTruthy();
    });
  });
});
