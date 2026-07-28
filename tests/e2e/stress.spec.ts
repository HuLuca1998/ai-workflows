import { expect, test } from '@playwright/test';
import { api, 允许直接执行 } from './_api.js';

/**
 * 边界与压力。
 *
 * 这一组测的是「量大了会不会垮」——正常路径已经被前面几组覆盖，
 * 这里专门找那些只在规模上来后才出现的问题。
 */

/** 一条 N 节点的链，用来看画布与执行在规模上的表现。 */
function chain(count: number) {
  const nodes = [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
    },
  ];
  const edges = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: `n${index}`,
      type: 'script.shell',
      title: `节点 ${index}`,
      position: { x: 240 * ((index % 8) + 1), y: 140 * Math.floor(index / 8) },
      config: { interpreter: 'bash', script: `echo ${index}`, timeoutMs: 10_000 },
    } as never);
    edges.push({
      id: `e${index}`,
      source: { nodeId: index === 0 ? 'entry' : `n${index - 1}`, port: 'success' },
      target: { nodeId: `n${index}`, port: 'input' },
    } as never);
  }
  return { nodes, edges, groups: [] };
}

test.describe('规模', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await 允许直接执行(page);
  });

  test('200 节点的画布能打开，节点数显示正确', async ({ page }) => {
    const id = (await api(page, 'workflow_create', { name: '200 节点' })) as string;
    await api(page, 'workflow_save_draft', {
      id,
      baseRev: 0,
      graphJson: JSON.stringify(chain(200)),
    });

    const started = Date.now();
    await page.goto(`/editor/${id}`);
    await expect(page.locator('.editor-bar')).toContainText('201 节点', { timeout: 20_000 });
    const elapsed = Date.now() - started;

    // 不是性能基准，只是拦住「大图直接卡死」这种情况
    expect(elapsed).toBeLessThan(20_000);
  });

  test('200 节点画布拖动时的真实帧率', async ({ page }) => {
    // M1 的验收项之一，此前只验证过「每帧计算」够快
    //（节点转换 1ms、校验 1ms），真实渲染帧率要浏览器才测得到
    const id = (await api(page, 'workflow_create', { name: '帧率基准' })) as string;
    await api(page, 'workflow_save_draft', {
      id,
      baseRev: 0,
      graphJson: JSON.stringify(chain(200)),
    });

    await page.goto(`/editor/${id}`);
    await expect(page.locator('.editor-bar')).toContainText('201 节点', { timeout: 20_000 });

    // 一边拖画布一边数帧
    const fps = await page.evaluate(async () => {
      const pane = document.querySelector('.react-flow__pane');
      if (!pane) return 0;

      let frames = 0;
      let running = true;
      const count = () => {
        frames += 1;
        if (running) requestAnimationFrame(count);
      };
      requestAnimationFrame(count);

      const rect = pane.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) =>
        pane.dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: 1 }),
        );

      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      fire('mousedown', startX, startY);
      const started = performance.now();
      for (let step = 0; step < 60; step += 1) {
        fire('mousemove', startX + step * 4, startY + step * 2);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      fire('mouseup', startX + 240, startY + 120);
      const elapsed = performance.now() - started;

      running = false;
      return Math.round((frames / elapsed) * 1000);
    });

    // 目标是 60fps；30 是「明显掉帧」的红线，低于它用户会觉得卡
    expect(fps, `拖动 200 节点画布时只有 ${fps} fps`).toBeGreaterThan(30);
    test.info().annotations.push({ type: '帧率', description: `${fps} fps` });
  });

  test('长事件流不会把执行记录页拖垮', async ({ page }) => {
    // 40 个节点 = 80+ 条节点事件 + 生命周期事件
    const id = (await api(page, 'workflow_create', { name: '长事件流' })) as string;
    const rev = (await api(page, 'workflow_save_draft', {
      id,
      baseRev: 0,
      graphJson: JSON.stringify(chain(40)),
    })) as number;
    const runId = (await api(page, 'run_start', {
      workflowId: id,
      draftRev: rev,
      inputsJson: '{}',
    })) as string;

    await page.goto(`/runs?run=${runId}`);
    const events = page.locator('.runs__event');
    await expect(events.first()).toBeVisible({ timeout: 30_000 });

    // 跑完后事件条数与节点数对得上
    await expect.poll(async () => events.count(), { timeout: 60_000 }).toBeGreaterThan(80);
  });

  test('超长脚本输出被截断并标记，不把界面撑爆', async ({ page }) => {
    const id = (await api(page, 'workflow_create', { name: '超长输出' })) as string;
    const rev = (await api(page, 'workflow_save_draft', {
      id,
      baseRev: 0,
      graphJson: JSON.stringify({
        nodes: [
          {
            id: 'entry',
            type: 'entry',
            title: '入口',
            position: { x: 0, y: 0 },
            config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
          },
          {
            id: 'flood',
            type: 'script.shell',
            title: '刷屏',
            position: { x: 250, y: 0 },
            config: {
              interpreter: 'bash',
              script: 'for i in $(seq 1 60000); do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done',
              timeoutMs: 60_000,
            },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'entry', port: 'success' },
            target: { nodeId: 'flood', port: 'input' },
          },
        ],
        groups: [],
      }),
    })) as number;

    const runId = (await api(page, 'run_start', {
      workflowId: id,
      draftRev: rev,
      inputsJson: '{}',
    })) as string;

    await page.goto(`/runs?run=${runId}`);
    await expect(
      page.locator('.runs__event-type').filter({ hasText: 'run.succeeded' }),
    ).toHaveCount(1, { timeout: 60_000 });

    // 产物落盘了，但事件表里只有摘要 —— 大 payload 不进事件
    await page.getByRole('tab', { name: '产物' }).click();
    const detail = page.getByRole('region', { name: '运行详情' });
    await expect(detail.getByText('stdout.log')).toBeVisible();
    // 1MB 上限：显示成 KB 或 MB 都行，但不能是几十 MB
    const meta = await detail.locator('.runs__artifact-meta').first().textContent();
    expect(meta).toMatch(/KB|MB/);
  });
});

test.describe('并发', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await 允许直接执行(page);
  });

  test('同时启动 5 个运行，界面全都跟得上', async ({ page }) => {
    // 5 个运行 × 4 个节点，每个节点起一次真实进程。
    // 默认 30s 的用例预算不够 —— 这条本来就是压力测试
    test.setTimeout(120_000);
    const id = (await api(page, 'workflow_create', { name: '并发 5 个' })) as string;
    const rev = (await api(page, 'workflow_save_draft', {
      id,
      baseRev: 0,
      graphJson: JSON.stringify(chain(3)),
    })) as number;

    const runIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      runIds.push(
        (await api(page, 'run_start', {
          workflowId: id,
          draftRev: rev,
          inputsJson: '{}',
        })) as string,
      );
    }

    // 先确认引擎跑完，再看界面 —— 反过来的话，界面的 1.2s 轮询会和
    // poll 里每轮 5 次 page.evaluate 挤在一起，把一件 1 秒的事拖成一分钟。
    // 用一次 run_list 拿全部状态，而不是逐个 run_get。
    // 按 workflowId 筛：列表分页后一页封顶，这 5 条新运行
    // 在 500 多条历史里不一定都落在第一页
    await expect
      .poll(
        async () => {
          const page1 = (await api(page, 'run_list', {
            workflowId: id,
            statuses: ['succeeded'],
            limit: 200,
          })) as { items: { id: string }[] };
          const finished = new Set((page1.items ?? []).map((run) => run.id));
          return runIds.filter((runId) => finished.has(runId)).length;
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(5);

    await page.goto('/runs');

    await page.reload();
    await expect(page.locator('.runs__item')).toHaveCount(
      await page.locator('.runs__item').count(),
    );
  });
});
