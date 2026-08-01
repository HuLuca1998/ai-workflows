import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 变量表的后两列不能假装是可配置项。
 *
 * 第三方巡检 C-07 实测：「变量」页签摆出三列（变量 / 运行时来源 /
 * 缺失时），用户自己写的每个变量都显示「未登记 / 留空并记录」，
 * 而整个页签**零个可交互控件** —— 看起来像一张等着被填的配置表。
 *
 * 实证下来比「没做编辑入口」更糟：`onMissing` 在引擎生产代码里
 * **零消费**（只有种子 SQL 与测试提到它）。引擎按正文占位符插值，
 * 缺了就统一报「未定义的引用 ${…}」—— 那三档缺失策略一档都不生效。
 *
 * 所以正确的做法不是补编辑入口（补了也是 B-5 那种「填了不生效」），
 * 而是照 `NodeConfigDialog.tsx` 那个写法**在界面上直说**。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const 带变量的 = {
  id: 'prompt_1',
  name: '我的提示词',
  group: '审查',
  sections: [{ title: 'ROLE', body: '审查 ${input.target} 这个对象' }],
  vars: [],
  ver: 1,
  builtin: false,
  updatedAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'prompt.list': () => ({ items: [带变量的], total: 1 }),
    'prompt.versions': () => ({ items: [] }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function 打开变量页() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <PromptsPage />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: /我的提示词/u }));
  await user.click(screen.getByRole('tab', { name: '变量' }));
  return user;
}

describe('变量表要说清哪些是真生效的', () => {
  it('列出正文里的变量', async () => {
    await 打开变量页();
    expect(screen.getByText('${input.target}')).toBeTruthy();
  });

  it('说清「缺失时」这一列引擎目前不读 —— 不说就是一张假的配置表', async () => {
    await 打开变量页();
    const panel = document.querySelector('.prompts__vars')!;
    expect(panel.textContent, 'onMissing 在引擎里零消费，而这一列摆着三档策略的文案').toMatch(
      /引擎目前不读|不生效|暂不/u,
    );
  });

  it('说清缺变量时引擎实际会怎样 —— 那才是用户要知道的', async () => {
    await 打开变量页();
    const panel = document.querySelector('.prompts__vars')!;
    // 引擎的真实行为：报「未定义的引用 ${…}」，节点失败
    expect(panel.textContent).toMatch(/未定义的引用|会失败|报错/u);
  });
});
