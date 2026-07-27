import { describe, expect, it } from 'vitest';
import {
  NODE_LIBRARY,
  NODE_TYPES,
  getNodeDefinition,
  type NodeType,
} from '../src/nodes/index.js';

/**
 * 节点定义 Schema 是 M0 冻结的第三件事（功能文档 §14）。
 * 配置表单由这些 Schema 驱动渲染，新增节点类型不得改 UI 代码——所以定义必须自洽。
 */

/** 每种节点的最小合法配置，同时充当文档：字段少到不能再少的样子。 */
const MINIMAL_CONFIG: Record<NodeType, unknown> = {
  'ai.analyze': { agentProfileId: 'ag_analyst', instruction: '分析根因', target: 'issue' },
  'ai.review': { agentProfileId: 'ag_reviewer', instruction: '审查改动', target: 'diff' },
  'ai.decide': { agentProfileId: 'ag_operator', instruction: '判断风险等级' },
  'ai.execute': { agentProfileId: 'ag_builder', instruction: '按方案修复' },
  entry: { trigger: 'manual', inputSchema: { type: 'object' } },
  subworkflow: { workflowId: 'wf_2', versionRef: 'latest' },
  branch: { cases: [{ port: 'high', when: '$.severity == "high"' }] },
  transform: { mappings: [{ from: '$.report.title', to: 'title' }] },
  end: { outcome: 'success' },
  approval: { title: '检查 Diff', interaction: 'confirm' },
  notify: { title: '运行完成', body: '工作流已结束' },
  'script.shell': { interpreter: 'zsh', script: 'pnpm lint' },
  'script.python': { interpreter: 'python3', script: 'print(1)' },
  'git.worktree': { repoRoot: '${input.repoPath}', baseBranch: 'main' },
  env: { operations: [{ op: 'set', key: 'FOO', value: 'bar', scope: 'run' }] },
  'mcp.tool': { serverId: 'mcp_github', toolAllowlist: ['create_pr'] },
};

describe('节点清单', () => {
  it('16 个节点类型，节点库里展示为 15 条（Shell 与 Python 脚本合并为一条）', () => {
    expect(NODE_TYPES).toHaveLength(16);
    expect(NODE_LIBRARY).toHaveLength(15);
  });

  it('节点库每条都指向已登记的类型，且不重不漏', () => {
    const covered = NODE_LIBRARY.flatMap((entry) => entry.types);
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual([...NODE_TYPES].sort());
  });

  it('每个类型都有定义，且 type 字段与键一致', () => {
    for (const type of NODE_TYPES) {
      expect(getNodeDefinition(type).type).toBe(type);
    }
  });

  it('未登记的类型取定义时报错，不静默返回空定义', () => {
    expect(() => getNodeDefinition('ai.hallucinate' as NodeType)).toThrow(/未登记/);
  });
});

describe('端口拓扑约束', () => {
  it('入口节点没有输入端口，且全图唯一', () => {
    const entry = getNodeDefinition('entry');
    expect(entry.ports.inputs).toHaveLength(0);
    expect(entry.singleton).toBe(true);
  });

  it('结束节点没有输出端口', () => {
    expect(getNodeDefinition('end').ports.outputs).toHaveLength(0);
  });

  it('其余节点至少一进一出', () => {
    for (const type of NODE_TYPES) {
      if (type === 'entry' || type === 'end') continue;
      const def = getNodeDefinition(type);
      expect(def.ports.inputs.length).toBeGreaterThan(0);
      expect(def.ports.outputs.length).toBeGreaterThan(0);
    }
  });

  it('AI 节点的分支端口与功能文档 §3.2 一致', () => {
    expect(getNodeDefinition('ai.analyze').ports.outputs.map((p) => p.id)).toEqual([
      'success',
      'insufficient_context',
    ]);
    expect(getNodeDefinition('ai.review').ports.outputs.map((p) => p.id)).toEqual([
      'passed',
      'changes_requested',
    ]);
    expect(getNodeDefinition('ai.execute').ports.outputs.map((p) => p.id)).toEqual([
      'success',
      'failed',
      'needs_decision',
    ]);
  });

  it('条件分支的输出端口由配置动态决定', () => {
    const def = getNodeDefinition('branch');
    expect(def.dynamicOutputs).toBe(true);
    expect(def.resolveOutputs?.({ cases: [{ port: 'high', when: 'x' }] })).toEqual([
      { id: 'high', label: 'high' },
      { id: 'default', label: 'default' },
    ]);
  });
});

describe('配置 Schema', () => {
  it('每种节点的最小配置都能通过校验', () => {
    for (const type of NODE_TYPES) {
      const parsed = getNodeDefinition(type).configSchema.safeParse(MINIMAL_CONFIG[type]);
      expect(parsed.success, `${type} 的最小配置未通过：${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it('AI 节点必须绑定 Agent 角色——节点引用角色而不是复制 Prompt', () => {
    const result = getNodeDefinition('ai.analyze').configSchema.safeParse({
      instruction: '分析',
      target: 'issue',
    });
    expect(result.success).toBe(false);
  });

  it('决策节点默认自动决策到 L2，L3 转人工', () => {
    const parsed = getNodeDefinition('ai.decide').configSchema.parse(MINIMAL_CONFIG['ai.decide']);
    expect(parsed).toMatchObject({ autoDecideUpTo: 'L2', onTimeout: 'escalate' });
  });

  it('脚本节点带输出上限与超时默认值，防止日志撑爆事件流', () => {
    const parsed = getNodeDefinition('script.shell').configSchema.parse(
      MINIMAL_CONFIG['script.shell'],
    );
    expect(parsed).toMatchObject({ outputLimitBytes: expect.any(Number) });
    expect((parsed as { outputLimitBytes: number }).outputLimitBytes).toBeGreaterThan(0);
  });

  it('脚本节点的解释器是白名单，不接受任意可执行文件', () => {
    expect(
      getNodeDefinition('script.shell').configSchema.safeParse({
        interpreter: '/usr/bin/env ruby',
        script: 'x',
      }).success,
    ).toBe(false);
  });

  it('worktree 节点默认 fetch 且带清理策略', () => {
    const parsed = getNodeDefinition('git.worktree').configSchema.parse(
      MINIMAL_CONFIG['git.worktree'],
    );
    expect(parsed).toMatchObject({ fetch: true, cleanupPolicy: expect.any(String) });
  });

  it('审批节点必须有标题，交互类型限定四种', () => {
    const def = getNodeDefinition('approval');
    expect(def.configSchema.safeParse({ interaction: 'confirm' }).success).toBe(false);
    expect(def.configSchema.safeParse({ title: 'x', interaction: 'poll' }).success).toBe(false);
  });
});

describe('能力声明（引擎强制，Prompt 无法越权）', () => {
  it('执行类节点默认声明文件与命令能力', () => {
    const caps = getNodeDefinition('ai.execute').defaultCapabilities;
    expect(caps.file).not.toBe('none');
    expect(caps.command).not.toBe('none');
  });

  it('通知节点不需要文件与命令能力', () => {
    const caps = getNodeDefinition('notify').defaultCapabilities;
    expect(caps.file).toBe('none');
    expect(caps.command).toBe('none');
  });

  it('没有任何节点默认开放 secret 能力——Secret 必须显式授予', () => {
    for (const type of NODE_TYPES) {
      expect(getNodeDefinition(type).defaultCapabilities.secret).toEqual([]);
    }
  });

  it('会产生外部写操作的节点被标记出来，供审批与幂等检查使用', () => {
    expect(getNodeDefinition('mcp.tool').externalWrite).toBe(true);
    expect(getNodeDefinition('transform').externalWrite).toBe(false);
  });
});
