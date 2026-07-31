import { describe, expect, it } from 'vitest';
import {
  CORE_API_METHODS,
  MCP_FIRST_RELEASE_TOOLS,
  getMethodSpec,
  requiredScope,
} from '../src/api.js';
import { ERROR_CODES } from '../src/errors.js';
import { PERMISSION_PRESETS } from '../src/capabilities.js';
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

  it('它不能直接改工作流 —— 落草稿走 workflow.patch，那里才有 baseRevision 守卫', () => {
    // 守的是「AI 的改动先出 Diff」这条产品规则：
    // 这个方法的 output 里只有 proposal（提议），没有 rev ——
    // 改动生效必须经过 workflow.patch，而那一步由用户触发。
    //
    // 它本身是写操作（建会话、存两条消息），但写的是**对话历史**，
    // 不是工作流。曾经声明 mutates:false，那会让 MCP 的只读会话
    // 把它当只读工具放行 —— 一个声明只读却写库的方法绕过整道过滤。
    const output = spec().output.safeParse({
      text: '建议加个审批节点',
      toolCalls: 0,
      proposal: {
        summary: '插入审批',
        operations: [
          {
            op: 'addNode',
            type: 'approval',
            title: '审批',
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
      },
    });
    expect(output.success).toBe(true);
    expect(output.success && 'rev' in (output.data as object)).toBe(false);
  });

  it('是写操作，Scope 覆盖得了它写的东西', () => {
    expect(spec().mutates).toBe(true);
    expect(requiredScope('supervisor.ask')).toBe('workflow:write-draft');
  });
});

describe('run.diagnostics', () => {
  const spec = () => getMethodSpec('run.diagnostics');

  it('按 runId 打包，输出落到用户指定的位置', () => {
    expect(spec().input.safeParse({ runId: 'run_1' }).success).toBe(true);
    expect(
      spec().output.safeParse({ path: '/tmp/run_1-diagnostics.json', bytes: 4096 }).success,
    ).toBe(true);
  });

  it('是写操作，且要审计 —— 它把运行数据落到磁盘', () => {
    expect(spec().mutates).toBe(true);
    expect(spec().audited).toBe(true);
  });

  it('不给远端 Scope —— 诊断包落在本机文件系统上', () => {
    // 与 env.install 同一条理由：会动本机文件的操作只允许本地 UI 触发
    expect(requiredScope('run.diagnostics')).toBeNull();
  });
});

describe('主管 AI 的历史会话', () => {
  it('会话按关联对象标注 —— 图纸要求「按关联的工作流 / 运行 / 记忆 / 模型」', () => {
    const spec = getMethodSpec('supervisor.sessions');
    const parsed = spec.output.safeParse({
      items: [
        {
          id: 'sess_1',
          title: '给这条流程加个审批',
          startedAt: '2026-07-28T10:00:00.000Z',
          updatedAt: '2026-07-28T10:05:00.000Z',
          messageCount: 4,
          workflowId: 'wf_1',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('关联对象都是可选的 —— 不在任何上下文里问的问题也是会话', () => {
    const spec = getMethodSpec('supervisor.sessions');
    expect(
      spec.output.safeParse({
        items: [
          {
            id: 'sess_1',
            title: '这个应用怎么用',
            startedAt: '2026-07-28T10:00:00.000Z',
            updatedAt: '2026-07-28T10:00:00.000Z',
            messageCount: 2,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('读一个会话拿到完整消息 —— 恢复对话靠它', () => {
    const spec = getMethodSpec('supervisor.session');
    const parsed = spec.output.safeParse({
      session: {
        id: 'sess_1',
        title: '给这条流程加个审批',
        startedAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T10:05:00.000Z',
        messageCount: 2,
      },
      messages: [
        { role: 'user', text: '加个审批', at: '2026-07-28T10:00:00.000Z' },
        { role: 'agent', text: '加好了', at: '2026-07-28T10:00:30.000Z' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('消息的角色只有 user 与 agent，不能自造', () => {
    const spec = getMethodSpec('supervisor.session');
    expect(
      spec.output.safeParse({
        session: {
          id: 'sess_1',
          title: 't',
          startedAt: '2026-07-28T10:00:00.000Z',
          updatedAt: '2026-07-28T10:00:00.000Z',
          messageCount: 1,
        },
        messages: [{ role: 'system', text: 'x', at: '2026-07-28T10:00:00.000Z' }],
      }).success,
    ).toBe(false);
  });

  it('ask 可以续接一个已有会话', () => {
    const spec = getMethodSpec('supervisor.ask');
    expect(spec.input.safeParse({ question: '那再加一个通知', sessionId: 'sess_1' }).success).toBe(
      true,
    );
  });

  it('ask 回答里带上会话 id —— 界面据此把后续问题接到同一条', () => {
    const spec = getMethodSpec('supervisor.ask');
    expect(spec.output.safeParse({ text: '好', toolCalls: 0, sessionId: 'sess_1' }).success).toBe(
      true,
    );
  });
});

describe('列表分页', () => {
  const LIST_METHODS = [
    'workflow.list',
    'run.list',
    'memory.list',
    'prompt.list',
    'model.list',
    'agent.list',
  ] as const;

  it('每个列表方法都收 limit 与 offset', () => {
    // 1292 条工作流一次铺满页面，浏览器要建出上千个 DOM 节点，
    // 而用户真正关心的那几条淹在里面
    for (const method of LIST_METHODS) {
      const parsed = getMethodSpec(method).input.safeParse({ limit: 50, offset: 100 });
      expect(parsed.success, `${method} 不收分页参数`).toBe(true);
    }
  });

  it('不给分页参数时有默认值 —— 老调用方不该因此拿到空列表', () => {
    for (const method of LIST_METHODS) {
      const parsed = getMethodSpec(method).input.safeParse({});
      expect(parsed.success, `${method} 的分页参数不是可选的`).toBe(true);
      const data = parsed.success ? (parsed.data as { limit?: number }) : {};
      expect(data.limit, `${method} 没有默认 limit`).toBeGreaterThan(0);
    }
  });

  it('limit 有上限 —— 不然「分页」就是摆设', () => {
    for (const method of LIST_METHODS) {
      expect(
        getMethodSpec(method).input.safeParse({ limit: 100_000 }).success,
        `${method} 接受了无上限的 limit`,
      ).toBe(false);
    }
  });

  it('负的 offset 被拒 —— 那只可能来自算错', () => {
    for (const method of LIST_METHODS) {
      expect(getMethodSpec(method).input.safeParse({ offset: -1 }).success).toBe(false);
    }
  });

  it('返回总数与还有没有更多 —— 界面靠它画分页控件', () => {
    for (const method of LIST_METHODS) {
      const spec = getMethodSpec(method);
      const shape = (spec.output as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape), `${method} 的返回里没有 total`).toContain('total');
    }
  });
});

describe('env.health 的返回形状', () => {
  const spec = () => getMethodSpec('env.health');

  it('每一项都带显示名 —— capability 是 id，界面要的是能读的名字', () => {
    const parsed = spec().output.safeParse({
      ready: false,
      items: [
        {
          capability: 'acp.claude',
          label: 'Claude Code（ACP）',
          source: 'app_managed',
          status: 'ready',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('缺失项带安装建议，且建议要说清出处', () => {
    // 「复制这行到终端」是让用户执行我们给的代码，得说清它哪来的
    const parsed = spec().output.safeParse({
      ready: false,
      items: [
        {
          capability: 'node',
          label: 'Node.js',
          source: 'missing',
          status: 'missing',
          installHint: { command: 'brew install node@22', source: 'Homebrew' },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('安装建议不带 command 不合法 —— 那就没有任何可操作的东西', () => {
    const parsed = spec().output.safeParse({
      ready: false,
      items: [
        {
          capability: 'node',
          label: 'Node.js',
          source: 'missing',
          status: 'missing',
          installHint: { source: 'Homebrew' },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('整体用布尔的 ready —— 比 status 枚举少一层解码', () => {
    expect(spec().output.safeParse({ ready: true, items: [] }).success, 'ready 应当是布尔').toBe(
      true,
    );
  });
});

describe('workflow.list 的筛选', () => {
  it('收状态筛选 —— 分页之后前端过滤只能过滤当前页', () => {
    // codex 复测：「停在第 29 页点『失败』，页码仍显示 1401–1424，
    // 页面只剩当前页内的一条失败记录」。筛选必须在后端做。
    const spec = getMethodSpec('workflow.list');
    expect(spec.input.safeParse({ status: 'failed' }).success).toBe(true);
    expect(spec.input.safeParse({ status: 'running' }).success).toBe(true);
    expect(spec.input.safeParse({ status: 'draft' }).success).toBe(true);
  });

  it('自造的状态被拒', () => {
    expect(getMethodSpec('workflow.list').input.safeParse({ status: '乱写' }).success).toBe(false);
  });
});

describe('产物列表与预览之间的字段要接得上', () => {
  /**
   * codex 的原话：点「预览」显示「`run.artifactContent` 的入参不合契约」。
   *
   * 根因是 Zod 会静默剥掉未声明的字段：引擎的 ArtifactDto 有 relPath，
   * 契约的 output 只声明了 path，于是界面拿到 undefined，把它当 path
   * 传给预览接口 —— 报错说的是「入参不合契约」，而问题出在上一个接口
   * 的返回值上。同一类坑之前在 WorkflowSummary 的 lastRun 上踩过。
   */
  const artifacts = getMethodSpec('run.artifacts');

  it('产物条目带 relPath —— 预览接口收的就是它', () => {
    const parsed = artifacts.output.safeParse({
      items: [
        {
          nodeId: 'script_shell_2',
          kind: 'log',
          name: 'stdout.log',
          path: '/Users/me/.aiwf/runs/run_1/script_shell_2/stdout.log',
          relPath: 'script_shell_2/stdout.log',
          bytes: 21,
          sha256: 'a'.repeat(64),
        },
      ],
      root: '/Users/me/.aiwf/runs/run_1',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const items = parsed.data as { items: { relPath: string }[] };
    expect(items.items[0]?.relPath).toBe('script_shell_2/stdout.log');
  });

  it('relPath 直接能过预览接口的入参校验 —— 两端对得上才算接住', () => {
    const parsed = artifacts.output.safeParse({
      items: [
        {
          nodeId: 'script_shell_2',
          kind: 'log',
          name: 'stdout.log',
          path: '/abs/run_1/script_shell_2/stdout.log',
          relPath: 'script_shell_2/stdout.log',
          bytes: 21,
          sha256: 'b'.repeat(64),
        },
      ],
      root: '/abs/run_1',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const items = parsed.data as { items: { relPath: string }[] };
    const next = getMethodSpec('run.artifactContent').input.safeParse({
      runId: 'run_1',
      path: items.items[0]?.relPath,
    });
    expect(next.success, '产物列表给的路径过不了预览接口的校验').toBe(true);
  });

  it('绝对路径的 path 过不了预览接口 —— 那道防线还在', () => {
    const next = getMethodSpec('run.artifactContent').input.safeParse({
      runId: 'run_1',
      path: '/Users/me/.aiwf/runs/run_1/script_shell_2/stdout.log',
    });
    expect(next.success).toBe(false);
  });
});

describe('工作区设置', () => {
  /**
   * codex 复测：点「用默认目录开始」之后顶栏仍写「尚未授权工作目录」，
   * 侧栏仍写「未设置权限档」「环境尚未检查」。
   *
   * 根因是那三处没有数据源 —— 界面上悬着三条「未配置」，
   * 而应用里没有任何东西能把它们改掉。
   */
  it('读设置不需要入参，三项都可缺席', () => {
    const spec = getMethodSpec('workspace.settings');
    expect(spec.input.safeParse({}).success).toBe(true);

    const parsed = spec.output.safeParse({});
    expect(parsed.success, '一项都没配过是合法状态').toBe(true);
  });

  it('权限档只能是契约里那三档 —— 界面文案与存的 ID 是两回事', () => {
    const spec = getMethodSpec('workspace.updateSettings');
    for (const preset of PERMISSION_PRESETS) {
      expect(spec.input.safeParse({ permissionPreset: preset }).success).toBe(true);
    }
    // 图纸上显示的是「Workspace Safe」，存的是 workspace_safe。
    // 把显示文案直接存进去的话，改个文案就把历史数据读不出来了
    expect(spec.input.safeParse({ permissionPreset: 'Workspace Safe' }).success).toBe(false);
    expect(spec.input.safeParse({ permissionPreset: '随便什么' }).success).toBe(false);
  });

  it('写设置是 mutates —— 它改的是「这台机器被授权到什么程度」', () => {
    const spec = getMethodSpec('workspace.updateSettings');
    expect(spec.mutates).toBe(true);
    expect(spec.audited, '授权变更必须留痕').toBe(true);
  });

  it('空对象也能写 —— 只改一项时别的不用带', () => {
    const spec = getMethodSpec('workspace.updateSettings');
    expect(spec.input.safeParse({ workdir: '~/code/atlas-api' }).success).toBe(true);
    expect(spec.input.safeParse({ envCheckedAt: '2026-07-28T13:00:00Z' }).success).toBe(true);
  });

  it('工作目录不能是空串 —— 那等于没授权，却看着像授权了', () => {
    const spec = getMethodSpec('workspace.updateSettings');
    expect(spec.input.safeParse({ workdir: '' }).success).toBe(false);
  });
});

describe('环境诊断导出', () => {
  /**
   * 图纸「06 首次安装与检测」与「05 设置与环境」底部都有「导出脱敏报告」。
   * 那两屏都还没有任何一次运行，所以 `run.diagnostics`（要 runId）用不上。
   *
   * M5 的出口标准写着「诊断包不含 Secret」—— 这个方法与 run.diagnostics
   * 共用同一条脱敏管道，理由也一样：用户要把环境情况发给别人看，
   * 手工整理必然会漏掉某处的 token。
   */
  it('不需要 runId —— 那两屏都还没跑过任何东西', () => {
    const spec = getMethodSpec('env.diagnostics');
    expect(spec.input.safeParse({}).success).toBe(true);
  });

  it('返回落盘位置与大小，跟 run.diagnostics 一样', () => {
    const spec = getMethodSpec('env.diagnostics');
    const parsed = spec.output.safeParse({ path: '/tmp/aiwf-env-diag.json', bytes: 4096 });
    expect(parsed.success).toBe(true);
  });

  it('会动本机文件，所以不给远端 Scope', () => {
    const spec = getMethodSpec('env.diagnostics');
    expect(spec.scope, 'MCP 能触发写本机文件就是一条越权路径').toBeNull();
    expect(spec.audited).toBe(true);
  });

  it('不在 MCP 首发工具清单里', () => {
    expect(MCP_FIRST_RELEASE_TOOLS).not.toContain('env.diagnostics');
  });
});

describe('新建工作流的默认名', () => {
  /**
   * codex 的原话：「不同 ID 的新工作流反复得到同一个名称『未命名工作流 51』，
   * 数据库里已有 23 条同名记录」。
   *
   * 界面算的是「当前页条数 + 1」，而分页之后每页固定 50 条。
   * 编号只能由后端给 —— 只有它看得见全部数据。
   */
  it('不传 name 也能建 —— 那时由后端编号', () => {
    const spec = getMethodSpec('workflow.create');
    expect(spec.input.safeParse({}).success).toBe(true);
  });

  it('传了 name 就用传的 —— 模板与导入都靠它', () => {
    const spec = getMethodSpec('workflow.create');
    const parsed = spec.input.safeParse({ name: 'GitHub Issue 修复' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as { name?: string }).name).toBe('GitHub Issue 修复');
  });

  it('空串仍然不行 —— 那是「我想取名但取了个空」，不是「你帮我取」', () => {
    const spec = getMethodSpec('workflow.create');
    expect(spec.input.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('回到最近审批点', () => {
  /**
   * 图纸失败横幅的第二个按钮。用户在审批那一步选错了（批准了一个
   * 不该批的 Diff），后面才发现 —— 「从失败节点重试」没用，
   * 那会沿用同一个决定继续往下。
   */
  it('只要 runId —— 回到哪个点由引擎从检查点里找', () => {
    const spec = getMethodSpec('run.rewindToApproval');
    expect(spec.input.safeParse({ runId: 'run_1' }).success).toBe(true);
    expect(spec.input.safeParse({}).success).toBe(false);
  });

  it('返回新的 runId 与回到了哪个节点', () => {
    const spec = getMethodSpec('run.rewindToApproval');
    const parsed = spec.output.safeParse({ runId: 'run_2', nodeId: 'approve_1' });
    expect(parsed.success).toBe(true);
  });

  it('是写操作且要留痕 —— 它改变了「谁批准了什么」', () => {
    const spec = getMethodSpec('run.rewindToApproval');
    expect(spec.mutates).toBe(true);
    expect(spec.audited).toBe(true);
    expect(spec.scope).toBe('workflow:run');
  });
});

describe('提示词的版本历史', () => {
  /**
   * 图纸「06 提示词库」版本页列的是「v4 · 当前 / 2 天前 · 你 /
   * 加入『信息不足时列出缺什么』约束」，下面还有 v3、v2。
   *
   * 之前只显示当前版本，而那一页底部写着「运行记录会引用当时的提示词版本，
   * 历史结果始终可解释」—— 历史都看不到，那句话就是空的。
   */
  it('只要 promptId', () => {
    const spec = getMethodSpec('prompt.versions');
    expect(spec.input.safeParse({ promptId: 'pr_1' }).success).toBe(true);
    expect(spec.input.safeParse({}).success).toBe(false);
  });

  it('每条带版本号、时间和是谁改的', () => {
    const spec = getMethodSpec('prompt.versions');
    const parsed = spec.output.safeParse({
      items: [
        {
          ver: 3,
          name: '根因分析',
          sections: [{ key: 'role', title: 'Role', body: '你是…' }],
          vars: [],
          changedBy: '你',
          createdAt: '2026-07-26T10:00:00Z',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('一条历史都没有是合法的 —— 从没改过的提示词就是这样', () => {
    const spec = getMethodSpec('prompt.versions');
    expect(spec.output.safeParse({ items: [] }).success).toBe(true);
  });

  it('是只读的', () => {
    const spec = getMethodSpec('prompt.versions');
    expect(spec.mutates).toBe(false);
    expect(spec.scope).toBe('workflow:read');
  });

  it('prompt.update 能带上「是谁改的」—— AI 提议与人工修改要分得开', () => {
    const spec = getMethodSpec('prompt.update');
    expect(spec.input.safeParse({ id: 'pr_1', ver: 1, changedBy: 'AI 提议' }).success).toBe(true);
    // 不带就是用户自己改的
    expect(spec.input.safeParse({ id: 'pr_1', ver: 1 }).success).toBe(true);
  });
});

describe('模型连通性测试', () => {
  /**
   * 图纸「07 模型」详情区的「测试连通性」按钮，与凭据卡里那行
   * 「延迟 · 1.4s（最近一次测试）」。
   *
   * ROADMAP 把它留给了 M5「和环境健康中心一起做，共用同一套探测逻辑」——
   * 它们确实共用：都是启动 adapter 握手，区别只是这里还要量时间。
   */
  it('只要模型 id', () => {
    const spec = getMethodSpec('model.test');
    expect(spec.input.safeParse({ id: 'model_1' }).success).toBe(true);
    expect(spec.input.safeParse({}).success).toBe(false);
  });

  it('返回通没通、多少毫秒、以及一句能看懂的说明', () => {
    const spec = getMethodSpec('model.test');
    expect(spec.output.safeParse({ ok: true, latencyMs: 1420, detail: '握手成功' }).success).toBe(
      true,
    );
  });

  it('没通时也要有 detail —— 「失败」两个字帮不上任何忙', () => {
    const spec = getMethodSpec('model.test');
    expect(spec.output.safeParse({ ok: false, latencyMs: 0 }).success).toBe(false);
    expect(spec.output.safeParse({ ok: false, latencyMs: 0, detail: 'adapter 没装' }).success).toBe(
      true,
    );
  });

  it('会启进程，所以不给远端 Scope', () => {
    const spec = getMethodSpec('model.test');
    // 与 env.install / run.diagnostics 同一条理由：
    // 让 MCP 能在这台机器上拉起进程就是一条越权路径
    expect(spec.scope).toBeNull();
    expect(spec.audited).toBe(true);
  });

  it('不在 MCP 首发工具清单里', () => {
    expect(MCP_FIRST_RELEASE_TOOLS).not.toContain('model.test');
  });
});

describe('契约层允许同步形态的 contextWindow=0', () => {
  /**
   * 第 1 轮浏览器实测抓到的接缝断裂：`sync_models` 对 ACP 同步来的条目
   * 故意写 contextWindow=0（两端语义不同，编一个数字更糟 ——
   * 见 store sync_models 的注释），而 ModelSchema 曾要求 positive。
   * 结果是「同步成功新增 5 条」与「model.list 的返回值不合契约」
   * 同屏出现，列表纹丝不动。0 在这里的语义是「未知」。
   *
   * **只守契约层**：这里手写的是期望形状，不经过真实 sync/list 链路 ——
   * Rust 侧真正写 0 的路径由 store 的 sync_models 测试压。
   */
  it('同步来源的 contextWindow=0（未知）能过 model.list', () => {
    const spec = getMethodSpec('model.list');
    const synced = {
      id: 'model_x',
      name: 'GPT-5.2',
      runtime: 'acp.codex',
      modelId: 'gpt-5.2',
      effort: 'medium',
      contextWindow: 0,
      capabilities: [],
      enabled: true,
    };
    expect(spec.output.safeParse({ items: [synced], total: 1 }).success).toBe(true);
  });

  it('update 也拒绝把窗口改成 0 或负数 —— 0 是同步来源专属的「未知」', () => {
    // codex 复核抓到的:patchOf(ModelSchema) 曾放行 contextWindow: 0,
    // 手动登记的模型能被改成「未知」,界面还会谎称它是同步来源
    const spec = getMethodSpec('model.update');
    expect(spec.input.safeParse({ id: 'm1', contextWindow: 0 }).success).toBe(false);
    expect(spec.input.safeParse({ id: 'm1', contextWindow: -1 }).success).toBe(false);
    expect(spec.input.safeParse({ id: 'm1', contextWindow: 400000 }).success).toBe(true);
    expect(spec.input.safeParse({ id: 'm1', name: '改名' }).success).toBe(true);
  });

  it('手动登记仍然拒绝 0 —— 表单里的人知道自己在登记什么', () => {
    const spec = getMethodSpec('model.create');
    const manual = {
      name: '某模型',
      runtime: 'acp.codex',
      modelId: 'm-1',
      effort: 'medium',
      contextWindow: 0,
      capabilities: [],
      enabled: true,
    };
    expect(spec.input.safeParse(manual).success).toBe(false);
    expect(spec.input.safeParse({ ...manual, contextWindow: 400000 }).success).toBe(true);
  });
});

describe('MCP 写操作的确认通道', () => {
  /**
   * M4 剩下的那一件事。「AI 的改动一律先出 Diff，用户确认才落草稿」
   * 是核心规则 —— 主管 AI 遵守了，MCP 之前不能：那个进程弹不出应用里的
   * 对话框，于是写工具只能整体关掉。
   *
   * 这四个方法是两个进程之间的信箱。
   */
  it('提交时带上工具名与入参 —— 用户要看清它到底要改什么', () => {
    const spec = getMethodSpec('mcp.requestConfirm');
    expect(
      spec.input.safeParse({ tool: 'workflow.patch', inputJson: '{"id":"wf_1"}' }).success,
    ).toBe(true);
    expect(spec.input.safeParse({ tool: 'workflow.patch' }).success).toBe(false);
  });

  it('提交只返回一个 id —— 决定要等用户，不在这一次调用里', () => {
    const spec = getMethodSpec('mcp.requestConfirm');
    expect(spec.output.safeParse({ id: 'mcpc_1' }).success).toBe(true);
  });

  it('查状态返回四种之一', () => {
    const spec = getMethodSpec('mcp.confirmStatus');
    for (const status of ['pending', 'approved', 'rejected', 'expired']) {
      expect(spec.output.safeParse({ status }).success, status).toBe(true);
    }
    expect(spec.output.safeParse({ status: '随便' }).success).toBe(false);
  });

  it('待确认列表带上提交时间 —— 用户要知道它等了多久', () => {
    const spec = getMethodSpec('mcp.pendingConfirms');
    const parsed = spec.output.safeParse({
      items: [
        {
          id: 'mcpc_1',
          tool: 'workflow.patch',
          inputJson: '{}',
          createdAt: '2026-07-28T10:00:00Z',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('决定是布尔 —— 没有「稍后再说」，那等同于拒绝', () => {
    const spec = getMethodSpec('mcp.decideConfirm');
    expect(spec.input.safeParse({ id: 'mcpc_1', approved: true }).success).toBe(true);
    expect(spec.input.safeParse({ id: 'mcpc_1' }).success).toBe(false);
  });

  it('提交与决定都要留痕', () => {
    expect(getMethodSpec('mcp.requestConfirm').audited).toBe(true);
    expect(getMethodSpec('mcp.decideConfirm').audited).toBe(true);
  });

  it('决定只能由本地 UI 做 —— 给远端 Scope 就等于自己批准自己', () => {
    expect(getMethodSpec('mcp.decideConfirm').scope).toBeNull();
    expect(getMethodSpec('mcp.pendingConfirms').scope).toBeNull();
  });

  it('这四个都不在 MCP 首发工具清单里 —— 否则 MCP 能自己批准自己', () => {
    for (const method of [
      'mcp.requestConfirm',
      'mcp.confirmStatus',
      'mcp.pendingConfirms',
      'mcp.decideConfirm',
    ] as const) {
      expect(MCP_FIRST_RELEASE_TOOLS).not.toContain(method);
    }
  });
});

describe('主管 AI 的回答要说清历史存没存住', () => {
  /**
   * 第 5 轮审查 B2：「主管 AI 的三次写库全部『失败也不管』，
   * 接口照常返回成功 → 对话可能没进历史而用户毫不知情」。
   *
   * 但「存失败就把回答一起丢掉」也不对：用户已经等了几十秒，
   * 拿不到答案比丢掉历史糟得多。
   *
   * 正解是两者都不选：**回答照给，但把「没存住」说出来** ——
   * 用户至少知道这条对话隔天回来找不到。
   */
  it('答案里带一个「历史存住了没有」的标记', () => {
    const spec = getMethodSpec('supervisor.ask');
    const parsed = spec.output.safeParse({
      text: '这条工作流缺一个结束节点。',
      toolCalls: 2,
      historySaved: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('缺省算存住了 —— 绝大多数时候它就是存住的', () => {
    const spec = getMethodSpec('supervisor.ask');
    const parsed = spec.output.parse({ text: '答案', toolCalls: 0 });
    expect((parsed as { historySaved: boolean }).historySaved).toBe(true);
  });

  it('没存住时 sessionId 可以缺席 —— 会话都没建起来', () => {
    const spec = getMethodSpec('supervisor.ask');
    expect(spec.output.safeParse({ text: '答案', toolCalls: 0, historySaved: false }).success).toBe(
      true,
    );
  });
});

describe('mutates 与实际行为不能对不上', () => {
  /**
   * 第 5 轮审查 B1：`supervisor.ask` 声明 `mutates:false` / `workflow:read`，
   * **实际写三次库**（建会话 + 两条消息，动态交叉验证：会话数 12→13）。
   *
   * mutates 不只是文档 —— MCP 的只读会话按它过滤工具，
   * 一个声明只读却写库的方法会绕过那道过滤。
   */
  it('supervisor.ask 声明为写操作 —— 它确实建会话、存消息', () => {
    const spec = getMethodSpec('supervisor.ask');
    expect(spec.mutates, '声明只读却写三次库').toBe(true);
  });

  it('它的 Scope 要能覆盖写 —— workflow:read 覆盖不了建会话', () => {
    const spec = getMethodSpec('supervisor.ask');
    expect(spec.scope).not.toBe('workflow:read');
  });

  it('写操作一律留痕', () => {
    for (const method of CORE_API_METHODS) {
      const spec = getMethodSpec(method);
      if (!spec.mutates) continue;
      expect(spec.audited, `${method} 会写库却不留痕`).toBe(true);
    }
  });

  it('只读方法不能出现在需要写权限的 Scope 上 —— 那是反过来的错配', () => {
    for (const method of CORE_API_METHODS) {
      const spec = getMethodSpec(method);
      if (spec.mutates) continue;
      expect(
        spec.scope === 'workflow:write-draft' || spec.scope === 'memory:write',
        `${method} 声明只读却要写权限`,
      ).toBe(false);
    }
  });
});
