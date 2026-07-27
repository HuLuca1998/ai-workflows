import { describe, expect, it } from 'vitest';
import {
  CORE_API_METHODS,
  MCP_FIRST_RELEASE_TOOLS,
  getMethodSpec,
  requiredScope,
} from '../src/api.js';
import { ERROR_CODES } from '../src/errors.js';
import { WorkflowSchema } from '../src/domain.js';
import { SCOPES } from '../src/capabilities.js';

/**
 * Core API 是唯一执行写操作的入口；UI、MCP、HTTP 都只是它的调用方（技术选型 §6）。
 * 这组测试是 CI 里「MCP 工具不得绕过 Core」那条门禁的契约侧依据。
 */

describe('方法清单', () => {
  it('覆盖技术选型 §11 列出的全部方法', () => {
    for (const method of [
      'workflow.list',
      'workflow.get',
      'workflow.patch',
      'workflow.validate',
      'workflow.publish',
      'run.start',
      'run.events',
      'run.resume',
      'run.cancel',
      'run.retryNode',
      'approval.decide',
      'env.health',
      'env.install',
    ] as const) {
      expect(CORE_API_METHODS).toContain(method);
    }
  });

  it('记忆 / 提示词 / 模型 / Agent 四组都是标准 CRUD', () => {
    for (const domain of ['memory', 'prompt', 'model', 'agent'] as const) {
      for (const action of ['list', 'create', 'update', 'delete'] as const) {
        expect(CORE_API_METHODS).toContain(`${domain}.${action}`);
      }
    }
  });

  it('方法名统一是 domain.action 形式', () => {
    for (const method of CORE_API_METHODS) {
      expect(method).toMatch(/^[a-z]+\.[a-zA-Z]+$/u);
    }
  });

  it('每个方法都有 input / output schema，可用于生成两端类型', () => {
    for (const method of CORE_API_METHODS) {
      const spec = getMethodSpec(method);
      expect(spec.input).toBeDefined();
      expect(spec.output).toBeDefined();
    }
  });
});

describe('Scope 与审计', () => {
  it('每个方法要求的 Scope 都在冻结的六个之内', () => {
    for (const method of CORE_API_METHODS) {
      const scope = requiredScope(method);
      if (scope === null) continue; // 仅本地 UI 可调用，不对外暴露
      expect(SCOPES).toContain(scope);
    }
  });

  it('读写分级正确', () => {
    expect(requiredScope('workflow.get')).toBe('workflow:read');
    expect(requiredScope('workflow.patch')).toBe('workflow:write-draft');
    expect(requiredScope('workflow.publish')).toBe('workflow:publish');
    expect(requiredScope('run.start')).toBe('workflow:run');
    expect(requiredScope('memory.list')).toBe('memory:read');
    expect(requiredScope('memory.create')).toBe('memory:write');
  });

  it('所有写方法都记审计事件', () => {
    for (const method of CORE_API_METHODS) {
      const spec = getMethodSpec(method);
      if (!spec.mutates) continue;
      expect(spec.audited, `${method} 是写方法但未标记审计`).toBe(true);
    }
  });

  it('环境安装只允许本地 UI 触发，不给远端 Scope', () => {
    expect(requiredScope('env.install')).toBeNull();
  });
});

describe('MCP 出口的落地顺序', () => {
  it('首版只开只读 + create + patch + validate + 记忆 CRUD', () => {
    expect(MCP_FIRST_RELEASE_TOOLS).toContain('workflow.get');
    expect(MCP_FIRST_RELEASE_TOOLS).toContain('workflow.patch');
    expect(MCP_FIRST_RELEASE_TOOLS).toContain('workflow.validate');
    expect(MCP_FIRST_RELEASE_TOOLS).toContain('memory.create');
  });

  it('publish 与 run 稳定后再开，首版不暴露', () => {
    expect(MCP_FIRST_RELEASE_TOOLS).not.toContain('workflow.publish');
    expect(MCP_FIRST_RELEASE_TOOLS).not.toContain('run.start');
    expect(MCP_FIRST_RELEASE_TOOLS).not.toContain('run.cancel');
  });

  it('MCP 暴露的工具必须都是 Core API 方法，不存在旁路工具', () => {
    for (const tool of MCP_FIRST_RELEASE_TOOLS) {
      expect(CORE_API_METHODS).toContain(tool);
    }
  });
});

describe('入参出参形状', () => {
  it('workflow.patch 可以带上客户端应用 Patch 后的结果图', () => {
    // 结构化 Patch 的应用逻辑（applyPatch）在这个包里，Rust 侧没有对应实现。
    // 所以客户端算完 Diff 与新图后，把结果图一并提交，引擎只做 baseRevision
    // 守卫与落库。详见 docs/adr/0008-patch-carries-resulting-graph.md
    const parsed = getMethodSpec('workflow.patch').input.safeParse({
      id: 'wf_1',
      baseRevision: 18,
      operations: [{ op: 'renameNode', nodeId: 'n1', title: 'x' }],
      graphJson: '{"nodes":[],"edges":[],"groups":[]}',
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { graphJson?: string }).graphJson).toBeTruthy();
  });

  it('workflow.patch 携带 baseRevision，冲突时返回 REVISION_CONFLICT', () => {
    const spec = getMethodSpec('workflow.patch');
    const parsed = spec.input.safeParse({
      id: 'wf_1',
      baseRevision: 18,
      operations: [{ op: 'renameNode', nodeId: 'n1', title: 'x' }],
    });
    expect(parsed.success).toBe(true);
    expect(ERROR_CODES).toContain('REVISION_CONFLICT');
  });

  it('run.events 是游标分页，可按类别过滤', () => {
    const parsed = getMethodSpec('run.events').input.safeParse({
      runId: 'run_1',
      fromSeq: 1,
      limit: 200,
      categories: ['node', 'approval'],
    });
    expect(parsed.success).toBe(true);
  });

  it('run.events 的 limit 有上限，防止一次拉走十万条事件', () => {
    expect(
      getMethodSpec('run.events').input.safeParse({ runId: 'run_1', fromSeq: 1, limit: 100_000 })
        .success,
    ).toBe(false);
  });

  it('run.start 必须指定运行的是已发布版本还是草稿修订', () => {
    const spec = getMethodSpec('run.start');
    expect(spec.input.safeParse({ workflowId: 'wf_1', inputs: {} }).success).toBe(false);
    expect(
      spec.input.safeParse({ workflowId: 'wf_1', versionId: 'v7', inputs: {}, workdir: '~/code/x' })
        .success,
    ).toBe(true);
    expect(
      spec.input.safeParse({ workflowId: 'wf_1', draftRev: 19, inputs: {}, workdir: '~/code/x' })
        .success,
    ).toBe(true);
  });

  it('approval.decide 记录决定、所选项与补充说明', () => {
    expect(
      getMethodSpec('approval.decide').input.safeParse({
        runId: 'run_1',
        nodeId: 'n7',
        decision: 'approved',
        selected: ['opt_1'],
        supplement: '顺手补一条 CHANGELOG',
      }).success,
    ).toBe(true);
  });

  it('memory 写操作携带版本号做乐观锁', () => {
    expect(
      getMethodSpec('memory.update').input.safeParse({ id: 'm_1', value: '新内容' }).success,
    ).toBe(false);
    expect(
      getMethodSpec('memory.update').input.safeParse({ id: 'm_1', value: '新内容', ver: 3 })
        .success,
    ).toBe(true);
  });
});

describe('workspace.stats', () => {
  it('token 用量可以缺席 —— 那表示还没有数据源，不是本周花了 0', () => {
    const spec = getMethodSpec('workspace.stats');
    const withoutTokens = {
      pendingApprovals: 1,
      runsToday: 12,
      runsTodaySucceeded: 10,
      activeWorktrees: 3,
      worktreeBytes: 432_013_312,
    };
    expect(spec.output.safeParse(withoutTokens).success).toBe(true);
    expect(spec.output.safeParse({ ...withoutTokens, tokensThisWeek: 1_240_000 }).success).toBe(
      true,
    );
  });

  it('计数不能是负数 —— 那只可能来自算错', () => {
    const spec = getMethodSpec('workspace.stats');
    const parsed = spec.output.safeParse({
      pendingApprovals: -1,
      runsToday: 0,
      runsTodaySucceeded: 0,
      activeWorktrees: 0,
      worktreeBytes: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('成功数不该超过今日运行数 —— 但那是引擎的事，契约只保证类型', () => {
    // 这条用例存在是为了记下边界在哪：跨字段的一致性由引擎测试压，
    // 契约层做这种校验会让「运行中途查询」这种正常情况被拒
    const spec = getMethodSpec('workspace.stats');
    expect(
      spec.output.safeParse({
        pendingApprovals: 0,
        runsToday: 1,
        runsTodaySucceeded: 5,
        activeWorktrees: 0,
        worktreeBytes: 0,
      }).success,
    ).toBe(true);
  });
});

describe('工作流列表带运行态投影', () => {
  it('没运行过时 lastRun 缺席 —— 界面据此显示「草稿」', () => {
    const parsed = WorkflowSchema.safeParse({
      id: 'wf_1',
      name: '批量文件整理',
      createdAt: '2026-07-27T10:00:00Z',
      updatedAt: '2026-07-27T10:00:00Z',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.lastRun).toBeUndefined();
  });

  it('失败的运行带上停在哪个节点 —— 图纸写的是「失败 · 节点 3」', () => {
    const parsed = WorkflowSchema.safeParse({
      id: 'wf_1',
      name: '错误日志归因',
      createdAt: '2026-07-27T10:00:00Z',
      updatedAt: '2026-07-27T10:00:00Z',
      latestVersion: 11,
      lastRun: {
        id: 'run_1',
        status: 'failed',
        startedAt: '2026-07-27T21:40:00Z',
        durationMs: 48_000,
        failedNodeLabel: '节点 3',
        version: 11,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('运行中的没有 durationMs —— 时长由界面按当前时间算', () => {
    const parsed = WorkflowSchema.safeParse({
      id: 'wf_1',
      name: '运行中的',
      createdAt: '2026-07-27T10:00:00Z',
      updatedAt: '2026-07-27T10:00:00Z',
      lastRun: { id: 'run_1', status: 'running', startedAt: '2026-07-27T21:40:00Z' },
    });
    expect(parsed.success).toBe(true);
  });

  it('lastRun 的状态必须是契约里的运行状态，不能自造', () => {
    const parsed = WorkflowSchema.safeParse({
      id: 'wf_1',
      name: '状态自造',
      createdAt: '2026-07-27T10:00:00Z',
      updatedAt: '2026-07-27T10:00:00Z',
      lastRun: { id: 'run_1', status: '跑完了', startedAt: '2026-07-27T21:40:00Z' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('run.artifactContent', () => {
  const spec = () => getMethodSpec('run.artifactContent');

  it('按 runId + path 定位，不接受绝对路径 —— 那是任意文件读', () => {
    // 产物读取是唯一一个「按用户给的路径读文件」的接口。
    // 接受绝对路径的话，界面上一个输入框就变成了任意文件读取器
    expect(spec().input.safeParse({ runId: 'run_1', path: 'node_1/stdout.log' }).success).toBe(
      true,
    );
    expect(spec().input.safeParse({ runId: 'run_1', path: '/etc/passwd' }).success).toBe(false);
    expect(spec().input.safeParse({ runId: 'run_1', path: '../../../etc/passwd' }).success).toBe(
      false,
    );
  });

  it('文本内容与「太大或不是文本」两种结果都能表达', () => {
    expect(spec().output.safeParse({ text: 'hello', truncated: false, bytes: 5 }).success).toBe(
      true,
    );
    // 截断也是正常结果：18KB 的日志不该整个塞进事件流去渲染
    expect(
      spec().output.safeParse({ text: '前 64KB…', truncated: true, bytes: 18_432 }).success,
    ).toBe(true);
  });

  it('二进制产物不给 text，只说明它是二进制', () => {
    // 给一段乱码比不给更糟：用户会以为文件坏了
    expect(spec().output.safeParse({ binary: true, bytes: 1024, truncated: false }).success).toBe(
      true,
    );
  });

  it('读取是只读操作 —— 不该被记成变更', () => {
    expect(spec().mutates).toBe(false);
  });

  it('要 workflow:read 权限 —— 产物里可能有敏感输出', () => {
    expect(requiredScope('run.artifactContent')).toBe('workflow:read');
  });
});

describe('主管 AI 的改动先出 Diff', () => {
  const spec = () => getMethodSpec('supervisor.ask');

  it('回答可以带一组结构化操作 —— 那是要给用户看 Diff 的东西', () => {
    const parsed = spec().output.safeParse({
      text: '我给你在分析节点后面插了一个审批。',
      toolCalls: 0,
      proposal: {
        summary: '在「分析」后插入人工审批',
        operations: [
          {
            op: 'addNode',
            type: 'approval',
            title: '人工审批',
            position: { x: 400, y: 200 },
            config: {},
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('纯问答不带 proposal —— 大多数提问不该改任何东西', () => {
    expect(spec().output.safeParse({ text: '上次失败是因为超时。', toolCalls: 2 }).success).toBe(
      true,
    );
  });

  it('操作必须是契约里的 op，不能自造', () => {
    const parsed = spec().output.safeParse({
      text: '改好了',
      toolCalls: 0,
      proposal: { summary: '乱改', operations: [{ op: 'rewriteEverything' }] },
    });
    expect(parsed.success).toBe(false);
  });

  it('proposal 必须有 summary —— Diff 上面那句话是用户判断要不要接受的依据', () => {
    const parsed = spec().output.safeParse({
      text: '改好了',
      toolCalls: 0,
      proposal: { operations: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('空操作列表不算提议 —— 那会让用户看到一个没内容的 Diff', () => {
    const parsed = spec().output.safeParse({
      text: '改好了',
      toolCalls: 0,
      proposal: { summary: '什么都没改', operations: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('这个方法本身仍然不写库 —— 落草稿走 workflow.patch，那里才有 baseRevision 守卫', () => {
    expect(spec().mutates).toBe(false);
    expect(requiredScope('supervisor.ask')).toBe('workflow:read');
  });
});
