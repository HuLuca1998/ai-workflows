import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 连通性测试的结果挂在页面级 state 上，不随选中项走：在模型 A 上测出
 * 「连不上」，切到 B，那句红字还挂在 B 的详情里 —— 用户会以为 B 也坏了。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');

function model(id: string, name: string) {
  return {
    id,
    name,
    runtime: 'acp.codex',
    modelId: 'gpt-x',
    effort: 'medium',
    contextWindow: 200000,
    capabilities: [],
    enabled: true,
  };
}

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'model.list': () => ({ items: [model('m1', '模型甲'), model('m2', '模型乙')], total: 2 }),
    'model.test': () => ({ ok: false, detail: '连不上：超时', latencyMs: 5000 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('连通性测试结果', () => {
  it('不跟着跑到另一个模型的详情里', async () => {
    const user = userEvent.setup();
    render(<ModelsPage />);

    await user.click(await screen.findByText('模型甲'));
    await user.click(screen.getByRole('button', { name: '测试连通性' }));
    await screen.findByText(/连不上/u);

    await user.click(screen.getByText('模型乙'));
    expect(screen.queryByText(/连不上/u), '模型甲的失败结果挂在了模型乙的详情下').toBeNull();
  });
});
