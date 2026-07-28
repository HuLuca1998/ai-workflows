import { describe, expect, it } from 'vitest';
import { NODE_LIBRARY, NODE_TYPES, getNodeDefinition, type NodeType } from '../src/nodes/index.js';

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
      expect(
        parsed.success,
        `${type} 的最小配置未通过：${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
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

describe('契约要表达得了 UI 需要的一切', () => {
  /**
   * CLAUDE.md 的核心设计承诺：「新增节点类型不改 UI 代码。
   * 如果发现必须改 UI，说明 Schema 表达力不够，那才是要解决的问题」。
   *
   * 第 5 轮审查 B1-C7 用最硬的办法验了它 —— 往契约里加一个真节点类型、
   * 一行 UI 代码不改，然后用真实浏览器看：**七种控件够用，9 种字段形状
   * 全部正确渲染**，SchemaField 与 NodeConfigDialog 确实一行都不用改。
   *
   * 坏消息是它们之外还有三张按节点类型穷举的 `Record<NodeType, X>`：
   * TITLES / SEEDS / ICONS。`Record` 要求每个键都在，所以那三处是**强制**的，
   * 加节点类型时 CI 直接打回；更糟的是运行期 —— Vite 不做类型检查，
   * 界面照样起得来，但**节点拖不进画布**，用户看到一句
   * 「节点配置不合法」，而他什么都还没填。
   *
   * 按那条判据逐张看：TITLES 完全冗余（兜底就是 definition.title），
   * SEEDS 与 ICONS 是契约表达力不够 —— 补在这里。
   */
  it('每个节点都有图标 —— 节点库里不能有一个通用圆圈', () => {
    for (const type of NODE_TYPES) {
      const icon = getNodeDefinition(type).icon;
      expect(icon, `${type} 没有图标`).toBeTruthy();
      // Phosphor 的类名，界面直接用
      expect(icon).toMatch(/^ph-/u);
    }
  });

  it('必填字段有占位值 —— 没有的话节点根本加不进画布', () => {
    for (const type of NODE_TYPES) {
      const definition = getNodeDefinition(type);
      const seed = definition.seed ?? {};
      // 用占位值去过一遍自己的 Schema：过不了就说明缺了必填项
      const parsed = definition.configSchema.safeParse(seed);
      expect(
        parsed.success,
        `${type} 的占位值过不了自己的 configSchema：${JSON.stringify(parsed.error?.issues?.slice(0, 2))}`,
      ).toBe(true);
    }
  });

  it('图标各不相同 —— 一眼分不出类型的话图标就白给了', () => {
    const icons = NODE_TYPES.map((type) => getNodeDefinition(type).icon);
    const 重复 = icons.filter((icon, index) => icons.indexOf(icon) !== index);
    expect([...new Set(重复)], `这些图标被多个节点共用：${重复.join('、')}`).toEqual([]);
  });
});

describe('新增节点类型不改 UI 代码 —— 这条承诺要能被验证', () => {
  /**
   * CLAUDE.md：「节点配置表单由 Schema 驱动渲染 —— 新增节点类型不改 UI 代码。
   * 如果发现必须改 UI，说明 Schema 表达力不够，那才是要解决的问题」。
   *
   * 第 5 轮审查发现三张按节点类型穷举的 `Record<NodeType, X>` 让这条不成立。
   * 那三张表已经搬进契约（icon / seed）或删掉（TITLES 完全冗余）。
   *
   * 这条守卫盯着别再长出第四张：UI 代码里不该有任何
   * `Record<NodeType, …>` —— 它一出现，加节点类型就必须改 UI。
   */
  it('UI 代码里没有按节点类型穷举的表', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const 违规: string[] = [];
    const 扫 = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          扫(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // 先去掉注释：解释「为什么不该有这张表」的文字里必然提到它
        const text = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/^\s*\/\/.*$/gmu, '');
        // Record<NodeType, X> 要求每个键都在 —— 加节点类型时 CI 直接打回
        if (/Record<\s*NodeType\s*,/u.test(text)) 违规.push(path);
      }
    };
    扫(join(import.meta.dirname, '../../../apps/web/src'));

    expect(
      违规,
      `这些文件按节点类型穷举，新增类型时必须改它们：${违规.join('、')}\n` +
        `需要什么信息就加到 NodeDefinition 上，别在 UI 里另立一张表`,
    ).toEqual([]);
  });

  it('契约给齐了渲染一个节点所需的全部信息', () => {
    // 节点库要 icon + title + summary + group；画布要 ports；
    // 配置弹层要 configSchema；拖进来要 seed
    for (const type of NODE_TYPES) {
      const d = getNodeDefinition(type);
      expect(d.icon, `${type} 缺 icon`).toBeTruthy();
      expect(d.title, `${type} 缺 title`).toBeTruthy();
      expect(d.summary, `${type} 缺 summary`).toBeTruthy();
      expect(d.group, `${type} 缺 group`).toBeTruthy();
      expect(d.ports, `${type} 缺 ports`).toBeTruthy();
      expect(d.configSchema, `${type} 缺 configSchema`).toBeTruthy();
    }
  });
});

describe('节点库从定义派生，不是第二份清单', () => {
  /**
   * 第 5 轮审查 B1-C7（第 15 条）：「NODE_LIBRARY 是与 NODE_TYPES
   * 并行维护的第二份清单」—— label 与 group 手抄了一遍 definition，
   * 改了一边忘了另一边就会对不上，而没有任何东西会报错。
   */
  it('每条的 label 与 group 都来自它的第一个类型', () => {
    for (const entry of NODE_LIBRARY) {
      const first = entry.types[0];
      expect(first, `${entry.id} 没有类型`).toBeTruthy();
      const definition = getNodeDefinition(first!);
      expect(entry.group, `${entry.id} 的 group 与定义对不上`).toBe(definition.group);
      // 合并条目（脚本）的 label 是自己的，其余必须与定义一致
      if (entry.types.length === 1) {
        expect(entry.label, `${entry.id} 的 label 与定义对不上`).toBe(definition.title);
      }
    }
  });

  it('每个节点类型都能在节点库里找到 —— 一个都不能漏', () => {
    const covered = new Set(NODE_LIBRARY.flatMap((entry) => entry.types));
    const 漏掉的 = NODE_TYPES.filter((type) => !covered.has(type));
    expect(漏掉的, `这些类型在节点库里没有入口：${漏掉的.join('、')}`).toEqual([]);
  });

  it('没有类型被列进两条 —— 那会在节点库里出现两次', () => {
    const all = NODE_LIBRARY.flatMap((entry) => entry.types);
    const 重复 = all.filter((type, index) => all.indexOf(type) !== index);
    expect([...new Set(重复)]).toEqual([]);
  });
});
