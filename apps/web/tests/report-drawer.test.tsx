import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 报告抽屉：从产物取到渲染这一整条链。
 *
 * ## 这条守的是什么
 *
 * `ReportView`（怎么画）有测试，而**它前面那一段没有** ——
 * 「找到 `report.json` 这个产物 → 取内容 → 解析 → 交给 ReportView」。
 * 那一段全是接缝：产物名对不上、`relPath` 取错字段、
 * 解析失败没兜住，任何一处断了，用户点开抽屉看到的都是空白或红条，
 * 而 `ReportView` 那一堆测试照样全绿。
 *
 * 这正是这个仓库最常见的缺陷形态（CLAUDE.md 第三条纪律）：
 * 单侧测试全绿而功能不工作。
 *
 * ## 判据
 *
 * 用**契约的真实形状**喂进去（`_contractClient` 会按契约校验
 * 每一次调用的出入参），断言报告的内容真的出现在屏幕上。
 */

const call = vi.fn();
// 不展开真实模块 —— 展开会把真的 coreClient 一起带进来，
// 于是渲染时打到的是它而不是这个替身（照 artifact-preview.test.tsx 的写法）
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { ReportDrawer } = await import('../src/runs/ReportDrawer.js');

/** 一份六种块都齐的报告 —— 与内置模板让 AI 写的那份同形。 */
const 报告 = {
  schemaVer: 1,
  title: '发布前检查 · pp-game',
  summary: '测试全过，但有两个依赖跨了 major，建议排期升。',
  outcome: 'warning',
  blocks: [
    {
      kind: 'metrics',
      items: [
        { label: '测试', value: '全过', note: '退出码 0' },
        { label: '过期依赖', value: '15' },
      ],
    },
    { kind: 'prose', body: '上一个 tag 到现在共 23 条提交，其中 3 条动了数据迁移。' },
    {
      kind: 'table',
      columns: ['包', '当前', '最新'],
      rows: [['vite', '5.0.1', '7.2.0']],
    },
  ],
};

/** 一条产物记录，形状照契约填全 —— `_contractClient` 会逐字段校验。 */
function 产物(nodeId: string, name: string) {
  const relPath = `${nodeId}/${name}`;
  return {
    nodeId,
    name,
    relPath,
    kind: name.endsWith('.json') ? 'json' : 'log',
    path: `/tmp/.aiwf-artifacts/run_1/${relPath}`,
    bytes: 128,
    sha256: 'f'.repeat(64),
  };
}

function 接上(artifacts: ReturnType<typeof 产物>[], text: string) {
  const checked = createContractCall({
    'run.artifacts': () => ({ root: '/tmp/.aiwf-artifacts/run_1', items: artifacts }),
    'run.artifactContent': () => ({ text, truncated: false, bytes: text.length }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
}

beforeEach(() => {
  // **块体，不是表达式体。** `() => call.mockReset()` 会把 mockReset 的
  // 返回值（mock 本身）当成返回值交出去，而 vitest 把 beforeEach 返回的
  // 函数登记成清理钩子 —— 于是每条用例结束时它**无参调用一次 `call`**，
  // 报「未登记的 Core API 方法：undefined」，而错误位置指向 mock 实现那一行
  call.mockReset();
});

describe('从产物取到渲染这一整条链', () => {
  it('报告的标题、结论与各块内容都到得了屏幕上', async () => {
    接上(
      [产物('write_report', 'stdout.log'), 产物('write_report', 'report.json')],
      JSON.stringify(报告),
    );

    render(<ReportDrawer runId="run_1" runLabel="2026-08-02 12:47" onClose={() => {}} />);

    expect(await screen.findByText('发布前检查 · pp-game')).toBeTruthy();
    expect(screen.getByText(/两个依赖跨了 major/)).toBeTruthy();
    // 三种块各验一个：只验标题的话，「解析成功但没画」也会绿
    expect(screen.getByText('全过')).toBeTruthy();
    expect(screen.getByText(/23 条提交/)).toBeTruthy();
    expect(screen.getByText('vite')).toBeTruthy();
  });

  it('按产物名找 report.json，而不是拿第一个产物', async () => {
    // 产物列表里 report.json 通常不在最前面（prompt.md / stdout.log 先写）。
    // 取第一个的话，抽屉里会显示一段 shell 日志
    接上(
      [产物('write_report', 'prompt.md'), 产物('write_report', 'report.json')],
      JSON.stringify(报告),
    );

    render(<ReportDrawer runId="run_1" runLabel="x" onClose={() => {}} />);
    await screen.findByText('发布前检查 · pp-game');

    const 取内容 = call.mock.calls.find(([m]) => m === 'run.artifactContent');
    expect(取内容?.[1]).toMatchObject({ path: 'write_report/report.json' });
  });

  it('这次运行没产出报告时说清楚，而不是空白', async () => {
    接上([产物('a', 'stdout.log')], '');

    render(<ReportDrawer runId="run_1" runLabel="x" onClose={() => {}} />);
    expect(await screen.findByText(/没有产出报告/)).toBeTruthy();
  });

  it('报告是坏的时候显示原文，而不是让抽屉打不开', async () => {
    /*
     * 报告由 AI 写，写坏是常态（少个字段、outcome 拼错）。
     * 抛出去的话用户点开是一片红，而那份原文里往往就有他要的信息。
     */
    接上([产物('w', 'report.json')], '{"schemaVer":1,"title":"半份报告"');

    render(<ReportDrawer runId="run_1" runLabel="x" onClose={() => {}} />);
    expect(await screen.findByText(/半份报告/)).toBeTruthy();
  });

  it('抽屉顶上说清这是哪一次运行 —— 同一条工作流可能有好几个 run', async () => {
    接上([产物('w', 'report.json')], JSON.stringify(报告));

    render(<ReportDrawer runId="run_abc123" runLabel="2026-08-02 12:47" onClose={() => {}} />);
    await screen.findByText('发布前检查 · pp-game');
    expect(screen.getByText(/2026-08-02 12:47/)).toBeTruthy();
  });
});
