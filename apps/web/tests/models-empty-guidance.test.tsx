import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 一条模型都没启用时，界面要给出路。
 *
 * 第三方巡检 C-04 实测：首次进模型页，两条内置模型都挂着红色「已停用」，
 * 右侧是「选一个模型查看详情」的空态 —— 没有横幅、没有提示、没有一键启用。
 * 唯一线索是左栏底部一行 11px 灰字。
 *
 * 连锁后果：此时所有 Agent 角色、AI 节点的模型下拉都是空的，
 * 四个内置角色全部显示 `model:codex（已停用或已删除）`，**系统开箱不可用**。
 *
 * 停用本身是对的（那两条的 model_id 是示例值，两端 adapter 都不认，
 * 启用了每次运行都写 model_downgraded）—— 缺的是「那我该做什么」。
 * DEBT O-18 记着这条。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');

const 停用的内置两条 = [
  {
    id: 'model:codex',
    name: 'Codex（本地 ACP）',
    runtime: 'acp.codex',
    modelId: 'gpt-5-codex',
    effort: 'high',
    contextWindow: 400000,
    caps: ['text'],
    enabled: false,
  },
  {
    id: 'model:claude',
    name: 'Claude Code（本地 ACP）',
    runtime: 'acp.claude',
    modelId: 'claude-opus-5',
    effort: 'high',
    contextWindow: 1000000,
    caps: ['text'],
    enabled: false,
  },
];

function respond(items: unknown[]) {
  const checked = createContractCall({
    'model.list': () => ({ items, total: items.length }),
    'model.sync': () => ({
      models: [{ value: 'gpt-5-codex', label: 'gpt-5-codex' }],
      efforts: [
        { value: 'low', label: 'low' },
        { value: 'high', label: 'high' },
      ],
      currentModel: 'gpt-5-codex',
      added: 1,
    }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
}

beforeEach(() => {
  call.mockReset();
  respond(停用的内置两条);
});

const view = () =>
  render(
    <MemoryRouter>
      <ModelsPage />
    </MemoryRouter>,
  );

describe('一条模型都没启用时要给出路', () => {
  it('给一条醒目的提示，而不是只有一行灰字', async () => {
    view();
    const banner = await screen.findByRole('status', { name: /没有可用模型/u });
    expect(banner.textContent, '要说清后果：AI 节点跑不了').toMatch(/AI|跑不|用不了/u);
  });

  it('提示里带一键同步，点了真的调 model.sync', async () => {
    const user = userEvent.setup();
    view();
    const banner = await screen.findByRole('status', { name: /没有可用模型/u });

    await user.click(within(banner).getByRole('button', { name: /同步/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'model.sync',
        expect.objectContaining({ runtime: expect.any(String) }),
      );
    });
  });

  it('有启用的模型时不显示这条提示 —— 常驻的提醒会被无视', async () => {
    respond([{ ...停用的内置两条[0]!, enabled: true }]);
    view();

    await screen.findByText(/Codex/u);
    expect(screen.queryByRole('status', { name: /没有可用模型/u })).toBeNull();
  });

  it('列表为空（连内置都没有）时同样给出路', async () => {
    respond([]);
    view();

    expect(await screen.findByRole('status', { name: /没有可用模型/u })).toBeTruthy();
  });
});
