import { describe, expect, it } from 'vitest';
import { getMethodSpec } from '@aiwf/contracts';
import { fromIpcResult, ipcCommandFor, toIpcInput } from '@aiwf/client-core';

/**
 * IPC 转换层。
 *
 * 契约用点号方法名与 camelCase，Rust 侧是另一套形状。字段名写错的症状是
 * 「数据莫名为空」而不是报错，所以每条映射都要有断言压着。
 */

// ── run.* 与 approval.decide（M2）──────────────────────────────────────────

describe('run.* 的映射', () => {
  it('run.start 把 inputs 序列化成 JSON 字符串', () => {
    const args = toIpcInput('run.start', {
      workflowId: 'wf_1',
      draftRev: 3,
      inputs: { issue: '42' },
      workdir: '/tmp/x',
      dryRun: false,
    });
    expect(args.workflowId).toBe('wf_1');
    expect(args.draftRev).toBe(3);
    // Rust 侧收字符串：让 serde 去解 Value 会把类型契约糊掉
    expect(args.inputsJson).toBe('{"issue":"42"}');
  });

  it('run.start 不发送 undefined 的 versionId', () => {
    const args = toIpcInput('run.start', {
      workflowId: 'wf_1',
      draftRev: 0,
      inputs: {},
      workdir: '/tmp/x',
    });
    expect('versionId' in args).toBe(false);
  });

  it('run.start 结果包成 runId 对象', () => {
    expect(fromIpcResult('run.start', 'run_abc')).toEqual({ runId: 'run_abc' });
  });

  it('run.list 把 status 数组转成 statuses 参数', () => {
    const args = toIpcInput('run.list', { status: ['running', 'succeeded'] });
    expect(args.statuses).toEqual(['running', 'succeeded']);
  });

  it('run.list 没给筛选时发空数组而不是 undefined', () => {
    // Rust 侧参数是 Vec<String>，undefined 会让 invoke 直接报参数错误
    const args = toIpcInput('run.list', {});
    expect(args.statuses).toEqual([]);
  });

  it('run.list 把 inputs_json 解析回对象', () => {
    const result = fromIpcResult('run.list', [
      {
        id: 'run_1',
        workflowId: 'wf_1',
        workflowName: '批量整理',
        status: 'running',
        inputsJson: '{"issue":"42"}',
        currentNode: 'fix',
        startedAt: '2026-07-27T10:00:00Z',
      },
    ]) as { items: { inputs: Record<string, unknown>; workflowName: string }[] };

    expect(result.items[0]?.inputs).toEqual({ issue: '42' });
    expect(result.items[0]?.workflowName).toBe('批量整理');
  });

  it('inputs_json 损坏时给空对象而不是让整页崩掉', () => {
    // 一条坏记录不该让整个执行记录页打不开
    const result = fromIpcResult('run.list', [
      { id: 'run_1', workflowId: 'wf_1', workflowName: 'x', status: 'failed', inputsJson: '{坏' },
    ]) as { items: { inputs: Record<string, unknown> }[] };
    expect(result.items[0]?.inputs).toEqual({});
  });

  it('run.get 读不到时返回 null 而不是抛错', () => {
    expect(fromIpcResult('run.get', null)).toEqual({ run: null });
  });

  it('run.events 原样带上 nextSeq 与 hasMore', () => {
    const page = fromIpcResult('run.events', {
      events: [{ id: 'ev_1', seq: 1, ts: 't', kind: 'run.created', actor: 'engine', summary: 's' }],
      nextSeq: 1,
      hasMore: false,
    }) as { events: unknown[]; nextSeq: number; hasMore: boolean };
    expect(page.events).toHaveLength(1);
    expect(page.nextSeq).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it('approval.decide 只发 Rust 需要的三个字段', () => {
    const args = toIpcInput('approval.decide', {
      runId: 'run_1',
      nodeId: 'ap',
      decision: 'approved',
      selected: ['方案一'],
      supplement: '记得留 worktree',
    });
    expect(args).toEqual({ runId: 'run_1', nodeId: 'ap', decision: 'approved' });
  });

  it('run.cancel / run.resume 回 runId 对象', () => {
    expect(fromIpcResult('run.cancel', null)).toEqual({ ok: true });
    expect(fromIpcResult('run.resume', null)).toEqual({ ok: true });
  });

  it('每个 run.* 方法都有对应的 IPC 命令', () => {
    for (const method of [
      'run.start',
      'run.list',
      'run.get',
      'run.events',
      'run.cancel',
      'run.resume',
      'approval.decide',
    ] as const) {
      expect(ipcCommandFor(method)).not.toBeNull();
    }
  });
});

describe('界面用到的方法都接通了', () => {
  it('源码里 coreClient.call 的每个方法都在契约与映射表里', async () => {
    // 漏配一个方法不会编译报错，也不会有测试变红 ——
    // 只有点到那个按钮才发现「点了没反应」。
    // agent.duplicate 就这么漏过一次：UI 调了一个契约里不存在的方法
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { CORE_API_METHODS } = await import('@aiwf/contracts');

    const root = join(import.meta.dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk(root);

    const used = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\.call\(\s*'([a-z]+\.[a-zA-Z]+)'/gu)) {
        if (match[1]) used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(5);

    const notInContract = [...used].filter(
      (method) => !(CORE_API_METHODS as readonly string[]).includes(method),
    );
    expect(notInContract, `这些方法契约里没有：${notInContract.join(', ')}`).toEqual([]);

    const notMapped = [...used].filter((method) => ipcCommandFor(method as never) === null);
    expect(notMapped, `这些方法没有 IPC 映射：${notMapped.join(', ')}`).toEqual([]);
  });
});

describe('契约不会悄悄剥掉后端发的字段', () => {
  it('run.list 的 workflowName 与 workdir 能穿过 Zod', async () => {
    // Zod 默认 strip 未声明的字段 —— 后端发了、契约没声明的，
    // 会在 CoreApiClient 里被无声地删掉。症状是「运行条目只剩状态徽章」，
    // 没有任何报错。踩过一次，所以这里用真实的 spec 走一遍
    const { getMethodSpec } = await import('@aiwf/contracts');
    const parsed = getMethodSpec('run.list').output.parse({
      items: [
        {
          id: 'run_1',
          workflowId: 'wf_1',
          workflowName: '真实工作流名',
          status: 'succeeded',
          inputs: {},
          envSnapshot: {},
          workdir: '/tmp/x',
          startedAt: '2026-07-27T10:00:00.000Z',
        },
      ],
    }) as { items: Record<string, unknown>[] };

    expect(parsed.items[0]?.workflowName).toBe('真实工作流名');
    expect(parsed.items[0]?.workdir).toBe('/tmp/x');
  });

  it('fromIpcResult 造出来的对象也能穿过 Zod', async () => {
    // 转换层与契约各对一半的情况：转换层加了字段但契约没有，
    // 或者契约要求的字段转换层没给
    const { getMethodSpec } = await import('@aiwf/contracts');
    const converted = fromIpcResult('run.list', [
      {
        id: 'run_1',
        workflowId: 'wf_1',
        workflowName: '批量整理',
        status: 'running',
        inputsJson: '{"issue":"42"}',
        currentNode: 'fix',
        workdir: '/tmp/runs',
        startedAt: '2026-07-27T10:00:00.000Z',
      },
    ]);

    const result = getMethodSpec('run.list').output.safeParse(converted);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });
});

describe('保存类方法的返回值不能被转换层吃掉', () => {
  it('agent.update / prompt.update 原样透传 —— 它们返回的是新版本号', () => {
    // 这两个原本和 delete 归在同一档「返回 { ok: true }」，
    // 于是后端算出的 ver 在这一层被丢掉，界面拿不到新版本，
    // 下一次保存必然撞乐观锁 —— 症状是「第二次保存就报冲突」
    expect(fromIpcResult('agent.update', { ver: 7 })).toEqual({ ver: 7 });
    expect(fromIpcResult('prompt.update', { ver: 2 })).toEqual({ ver: 2 });
  });

  it('返回值合契约 —— 转换后能通过 output 校验', () => {
    for (const method of ['agent.update', 'prompt.update'] as const) {
      const parsed = getMethodSpec(method).output.safeParse(fromIpcResult(method, { ver: 3 }));
      expect(parsed.success, `${method} 的返回值不合契约`).toBe(true);
    }
  });

  it('prompt.update 的入参保留 ver —— 乐观锁不能被字段转换吃掉', () => {
    const sent = toIpcInput('prompt.update', {
      id: 'prompt_1',
      ver: 4,
      sections: [{ title: 'Role', body: '正文' }],
    });
    expect(sent).toMatchObject({ id: 'prompt_1', ver: 4 });
  });
});
