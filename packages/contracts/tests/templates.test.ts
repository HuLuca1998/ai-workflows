import { describe, expect, it } from 'vitest';
import { applyPatch } from '../src/patch.js';
import { getNodeDefinition } from '../src/nodes/index.js';
import { topologicalOrder, validateGraph, type WorkflowGraph } from '../src/graph.js';
import { WORKFLOW_TEMPLATES, templateById } from '../src/templates.js';

/**
 * M1 的出口标准：「GitHub Issue 修复模板可完整搭出、校验通过并发布为 v1」。
 *
 * 这个文件就是那条标准的可执行验证——模板走的是与手工搭建、与 AI 改图
 * 完全相同的路径（applyPatch），所以它通过，等于这条路径本身通过。
 */

const EMPTY: WorkflowGraph = { nodes: [], edges: [], groups: [] };

function build(templateId: string) {
  const template = templateById(templateId);
  if (!template) throw new Error(`没有模板 ${templateId}`);
  return applyPatch(EMPTY, 0, { baseRevision: 0, operations: template.operations });
}

describe('GitHub Issue 修复模板', () => {
  it('能被结构化操作完整搭出，且校验通过', () => {
    const result = build('github-issue-fix');
    expect(
      result.validation.issues.filter((i) => i.level === 'error'),
      `校验未通过：${JSON.stringify(result.validation.issues)}`,
    ).toEqual([]);
    expect(result.validation.ok).toBe(true);
  });

  it('覆盖了图纸主线上的每一个环节', () => {
    const { graph } = build('github-issue-fix');
    const types = graph.nodes.map((n) => n.type);
    for (const required of [
      'entry',
      'script.shell',
      'ai.analyze',
      'approval',
      'git.worktree',
      'ai.execute',
      'ai.review',
      'ai.decide',
      'notify',
      'end',
    ] as const) {
      expect(types, `缺少 ${required} 节点`).toContain(required);
    }
  });

  it('用到了分支端口，而不是所有连线都走默认的第一个输出', () => {
    const { graph } = build('github-issue-fix');
    const ports = graph.edges.map((e) => e.source.port);
    // 审批的 approved、审查的 passed / changes_requested、决策的 escalated
    expect(ports).toContain('approved');
    expect(ports).toContain('passed');
    expect(ports).toContain('changes_requested');
    expect(ports).toContain('escalated');
  });

  it('每条连线的端口都真的存在于源节点的定义里', () => {
    const { graph } = build('github-issue-fix');
    for (const edge of graph.edges) {
      const source = graph.nodes.find((n) => n.id === edge.source.nodeId);
      expect(source, `连线 ${edge.id} 的源节点不存在`).toBeTruthy();
      if (!source) continue;
      const outputs = getNodeDefinition(source.type).ports.outputs.map((p) => p.id);
      expect(outputs, `${source.type} 没有端口 ${edge.source.port}`).toContain(edge.source.port);
    }
  });

  it('是有向无环图，能排出执行顺序', () => {
    const { graph } = build('github-issue-fix');
    const order = topologicalOrder(graph);
    expect(order[0]).toBe('entry');
    expect(order).toHaveLength(graph.nodes.length);
  });

  it('外部写操作前面要么是审批节点，要么是一次明确的分级决策', () => {
    // **挡住 push 的主力不是图的形状，是审批档**：`push_pr` 是脚本节点，
    // 引擎按脚本内容判成 `external_write`，于是「我来审批」与
    // 「AI 审批 + 关键节点问我」两档下都会挂人工，无人值守档下由 AI 表态
    // 并留下 approval.decided（`crates/engine/tests/risk_test.rs`）。
    //
    // 这条原本要求「指向 push 的每条边都必须来自 approval 节点」。
    // 那条约束现在会造成**批两次**：图上一次、引擎档位一次 ——
    // 而用户的原话是「不要有太多用户审批」。
    //
    // 留下来的是这一条：不能从一个既没审批、也没做过分级判断的地方
    // 直接跳到 push。
    const { graph } = build('github-issue-fix');
    const push = graph.nodes.find((n) => n.title.includes('Push'));
    expect(push).toBeTruthy();

    const incoming = graph.edges.filter((e) => e.target.nodeId === push?.id);
    expect(incoming.length).toBeGreaterThan(0);
    for (const edge of incoming) {
      const from = graph.nodes.find((n) => n.id === edge.source.nodeId);
      const 合法 =
        (from?.type === 'approval' && edge.source.port === 'approved') ||
        (from?.type === 'ai.decide' && edge.source.port === 'auto_decided');
      expect(合法, `${from?.id}.${edge.source.port} → push：既不是批准也不是分级放行`).toBe(true);
    }
  });

  it('每个输出端口都有下游——断在端口上的分支是安静地什么都不做', () => {
    // `decide` 曾经只连了 `escalated`：AI 判定「够小，自动放行」的那一支
    // 走到端口就没路了，节点成功、运行结束、PR 没建，
    // 而事件流里看不出哪里断的。
    //
    // 只查有下游的节点：`end` 与失败分支本来就该是终点
    const { graph } = build('github-issue-fix');
    const 有出边的节点 = new Set(graph.edges.map((e) => e.source.nodeId));

    for (const node of graph.nodes) {
      if (!有出边的节点.has(node.id)) continue;
      const 用到的端口 = new Set(
        graph.edges.filter((e) => e.source.nodeId === node.id).map((e) => e.source.port),
      );
      const 全部端口 = getNodeDefinition(node.type).ports.outputs.map((p) => p.id);
      // 失败端口允许悬空：失败就该停下来，接一条边反而是在掩盖
      const 漏掉的 = 全部端口.filter(
        (port) => !用到的端口.has(port) && !['failed', 'failure', 'error'].includes(port),
      );
      expect(漏掉的, `${node.id}（${node.type}）的端口没有下游：${漏掉的.join(', ')}`).toEqual([]);
    }
  });

  it('互斥入边的汇聚点必须是「任一到达」——默认的「等全部」永远凑不齐', () => {
    // 默认策略是 all（`graph.rs` 的 `join_strategy`）。
    // `approve_diff` 的两条入边来自 `review` 与 `decide` 的**互斥**端口，
    // 按「等全部到齐」算它永远执行不到 —— 于是从它往后整条尾巴
    // （审批 → 提交 → PR → 通知 → 结束）一次都跑不到，而且不报任何错。
    const { graph } = build('github-issue-fix');

    for (const node of graph.nodes) {
      const 入边 = graph.edges.filter((e) => e.target.nodeId === node.id);
      if (入边.length < 2) continue;
      // 入边来自不同节点的不同端口 —— 判不了互不互斥，一律要求显式声明
      expect(
        node.join?.strategy,
        `${node.id} 有 ${入边.length} 条入边却没声明汇聚策略，默认「等全部」多半凑不齐`,
      ).toBeDefined();
    }
  });

  it('每个节点的配置都通过各自的 Schema——模板不能带着非法配置发出去', () => {
    const { graph } = build('github-issue-fix');
    for (const node of graph.nodes) {
      const parsed = getNodeDefinition(node.type).configSchema.safeParse(node.config);
      expect(parsed.success, `${node.id} 配置不合法：${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it('入口节点全图唯一，且没有入边', () => {
    const { graph } = build('github-issue-fix');
    expect(graph.nodes.filter((n) => n.type === 'entry')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.target.nodeId === 'entry')).toHaveLength(0);
  });

  it('没有孤立节点——每个节点都在主线上', () => {
    const { graph } = build('github-issue-fix');
    const orphans = validateGraph(graph).issues.filter((i) => i.code === 'ORPHAN_NODE');
    expect(orphans, `孤立节点：${orphans.map((o) => o.nodeId).join(', ')}`).toEqual([]);
  });
});

describe('模板清单', () => {
  it('每个模板都有 id、名称与一句话说明', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.name).toBeTruthy();
      expect(template.summary.length).toBeGreaterThan(4);
    }
  });

  it('全部模板都能搭出合法的图', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const result = build(template.id);
      expect(result.validation.ok, `${template.name} 校验未通过`).toBe(true);
    }
  });

  it('取未知模板返回 undefined，不抛错', () => {
    expect(templateById('不存在')).toBeUndefined();
  });
});

/**
 * 端到端跑真实 GitHub 仓库时暴露的：节点叫「Commit / Push / PR」，
 * 脚本却只有 push 与 gh pr create —— 没有 commit。
 *
 * 于是推上去的是一个与 base 完全相同的空分支，`gh pr create` 以
 * 「No commits between main and …」失败。分支已经推出去了，PR 没有，
 * 而通知照样说「PR 已创建」。
 *
 * 模板是发给用户的出厂内容，照着跑一次就该成功。
 */
describe('Issue 修复模板 · 提交那一步', () => {
  const scriptOf = (nodeId: string): string => {
    const template = templateById('github-issue-fix');
    const node = template?.operations.find((op) => op.op === 'addNode' && op.nodeId === nodeId);
    return String((node as { config: { script?: unknown } }).config.script ?? '');
  };

  it('推之前先 commit —— 否则推上去的是空分支', () => {
    const script = scriptOf('push_pr');
    expect(script).toMatch(/git\s+add/);
    expect(script).toMatch(/git\s+commit/);
    expect(script.indexOf('git commit')).toBeLessThan(script.indexOf('git push'));
  });

  it('没有改动时明确失败，而不是推个空分支再让 gh 报错', () => {
    expect(scriptOf('push_pr')).toMatch(/exit\s+1/);
  });

  it('在 worktree 里跑 —— 隔离工作区才是改动所在', () => {
    expect(scriptOf('push_pr')).toContain('${worktree.success.path}');
  });

  /**
   * `cmd 2>&1 | tail -2` 这类写法会把退出码换成管道最后一节的，
   * 于是 `gh pr create` 失败也报「退出码 0」，节点显示成功。
   * 实跑那次就是这么把「PR 没建成」变成「完成通知」的。
   */
  it('不把退出码交给管道最后一节', () => {
    const script = scriptOf('push_pr');
    if (script.includes('|')) {
      expect(script).toMatch(/pipefail/);
    }
  });

  /**
   * `${…}` 展开时已经带上单引号（engine 的 `shell_quote`）。
   * 脚本里再套一层就成了 `'…'1'…'`，靠相邻字符串拼接才碰巧对 ——
   * 值里有空格或引号时就散架。模板是给人抄的，不能示范这种写法。
   */
  it('不在 ${…} 外面再套引号 —— 展开时已经带了', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      for (const op of template.operations) {
        if (op.op !== 'addNode') continue;
        const script = (op.config as { script?: unknown }).script;
        if (typeof script !== 'string') continue;
        expect(script, `${template.id}/${op.nodeId} 把 \${…} 套进了引号`).not.toMatch(
          /['"]\$\{[^}]+\}|\$\{[^}]+\}['"]/,
        );
      }
    }
  });
});
