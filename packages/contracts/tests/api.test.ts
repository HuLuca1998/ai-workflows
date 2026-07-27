import { describe, expect, it } from 'vitest';
import {
  CORE_API_METHODS,
  MCP_FIRST_RELEASE_TOOLS,
  getMethodSpec,
  requiredScope,
} from '../src/api.js';
import { ERROR_CODES } from '../src/errors.js';
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
