import { describe, expect, it } from 'vitest';

import { validateGraph } from '../src/graph.js';
import type { WorkflowGraph } from '../src/graph.js';

/**
 * 上一个节点的产出，在下一个 AI 节点里没被用到 —— 校验器要说出来。
 *
 * ## 为什么这条必须在校验器里，而不只是内置模板的测试
 *
 * 每个 AI 节点各开一条 ACP 会话，**没有跨节点上下文**。上一步的结论
 * 不显式写进 `instruction` / `target`，模型就真的看不到 ——
 * 它的提示词里只有角色、记忆和这段指令。
 *
 * 实测（run_ff4b95648b3eb581，真 GitHub 仓库的 issue 修复）：
 * `github-issue-fix` 的 `fix` 节点指令全文是
 * 「按选定方案修改代码，小步提交，每步可验证。」——
 * 上游 `analyze` 给出的方案一个字都没接进来。那个 agent 手上什么都没有，
 * 最后开出的 PR 里只有一个多余的锁文件。
 *
 * 我们自己的模板可以逐条修，**而用户自己搭的工作流没人替他检查**。
 * 所以判据放在 `validateGraph` 里：谁搭都一样查。
 *
 * ## 判据
 *
 * 从图上算每个 AI 节点的「最近产出祖先」（**要穿过审批节点** ——
 * 审批不携带内容往下传），指令里没引用到就报 warning。
 *
 * 是 warning 不是 error：编辑中途还没写完指令是正常状态，
 * 而且「有意不引用、让 agent 自己用 MCP 去读」是合法做法。
 */

const 位置 = { x: 0, y: 0 };

function 图(nodes: unknown[], edges: unknown[]): WorkflowGraph {
  return { nodes, edges, groups: [] } as unknown as WorkflowGraph;
}

/** entry → sh(脚本) → ai，ai 的指令由参数决定。 */
function 直链(instruction: string): WorkflowGraph {
  return 图(
    [
      { id: 'entry', type: 'entry', title: '入口', position: 位置, config: {} },
      {
        id: 'sh',
        type: 'script.shell',
        title: '取数据',
        position: 位置,
        config: { interpreter: 'zsh', script: 'echo hi' },
      },
      {
        id: 'ai',
        type: 'ai.execute',
        title: '处理',
        position: 位置,
        config: { instruction, workdirSource: 'inherit' },
      },
      {
        id: 'done',
        type: 'end',
        title: '结束',
        position: 位置,
        config: { outcome: 'success', artifacts: [] },
      },
    ],
    [
      {
        id: 'e1',
        source: { nodeId: 'entry', port: 'success' },
        target: { nodeId: 'sh', port: 'input' },
      },
      {
        id: 'e2',
        source: { nodeId: 'sh', port: 'success' },
        target: { nodeId: 'ai', port: 'input' },
      },
      {
        id: 'e3',
        source: { nodeId: 'ai', port: 'success' },
        target: { nodeId: 'done', port: 'input' },
      },
    ],
  );
}

const 找 = (graph: WorkflowGraph, code: string) =>
  validateGraph(graph).issues.filter((i) => i.code === code);

describe('上游产出没被下游 AI 节点用到', () => {
  it('没引用就报 warning，并说出是哪个上游', () => {
    const issues = 找(直链('处理一下'), 'UPSTREAM_UNUSED');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.nodeId).toBe('ai');
    expect(issues[0]!.message).toContain('sh');
  });

  it('引用了就不报', () => {
    expect(找(直链('处理这个：${sh.success}'), 'UPSTREAM_UNUSED')).toHaveLength(0);
  });

  it('穿过审批节点找上游 —— 审批不把内容传下去', () => {
    /*
     * `analyze → approve → fix` 是内置模板的真实形状。
     * 只看直接上游的话，`fix` 的上游是审批节点，这条检查看不见 `analyze` ——
     * 而那正是实测里出问题的那一处。
     */
    const graph = 图(
      [
        { id: 'entry', type: 'entry', title: '入口', position: 位置, config: {} },
        {
          id: 'analyze',
          type: 'ai.analyze',
          title: '分析',
          position: 位置,
          config: { instruction: '分析', target: '${input.x}' },
        },
        {
          id: 'approve',
          type: 'approval',
          title: '审批',
          position: 位置,
          config: { title: '批一下', interaction: 'confirm', decider: 'user', options: [] },
        },
        {
          id: 'fix',
          type: 'ai.execute',
          title: '改',
          position: 位置,
          config: { instruction: '按方案改', workdirSource: 'inherit' },
        },
        {
          id: 'done',
          type: 'end',
          title: '结束',
          position: 位置,
          config: { outcome: 'success', artifacts: [] },
        },
      ],
      [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'analyze', port: 'input' },
        },
        {
          id: 'e2',
          source: { nodeId: 'analyze', port: 'success' },
          target: { nodeId: 'approve', port: 'input' },
        },
        {
          id: 'e3',
          source: { nodeId: 'approve', port: 'approved' },
          target: { nodeId: 'fix', port: 'input' },
        },
        {
          id: 'e4',
          source: { nodeId: 'fix', port: 'success' },
          target: { nodeId: 'done', port: 'input' },
        },
      ],
    );
    const issues = 找(graph, 'UPSTREAM_UNUSED');
    expect(issues.map((i) => i.nodeId)).toContain('fix');
    expect(issues.find((i) => i.nodeId === 'fix')!.message).toContain('analyze');
  });

  it('上游是入口时不报 —— 入口的产出是 ${input.*}，不叫节点引用', () => {
    const graph = 图(
      [
        { id: 'entry', type: 'entry', title: '入口', position: 位置, config: {} },
        {
          id: 'ai',
          type: 'ai.execute',
          title: '处理',
          position: 位置,
          config: { instruction: '处理 ${input.x}', workdirSource: 'inherit' },
        },
        {
          id: 'done',
          type: 'end',
          title: '结束',
          position: 位置,
          config: { outcome: 'success', artifacts: [] },
        },
      ],
      [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'ai', port: 'input' },
        },
        {
          id: 'e2',
          source: { nodeId: 'ai', port: 'success' },
          target: { nodeId: 'done', port: 'input' },
        },
      ],
    );
    expect(找(graph, 'UPSTREAM_UNUSED')).toHaveLength(0);
  });

  it('只查 AI 节点 —— 脚本节点靠 env / 参数拿上游，不看指令', () => {
    const graph = 图(
      [
        { id: 'entry', type: 'entry', title: '入口', position: 位置, config: {} },
        {
          id: 'a',
          type: 'script.shell',
          title: '一',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo 1' },
        },
        {
          id: 'b',
          type: 'script.shell',
          title: '二',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo 2' },
        },
        {
          id: 'done',
          type: 'end',
          title: '结束',
          position: 位置,
          config: { outcome: 'success', artifacts: [] },
        },
      ],
      [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'a', port: 'input' },
        },
        {
          id: 'e2',
          source: { nodeId: 'a', port: 'success' },
          target: { nodeId: 'b', port: 'input' },
        },
        {
          id: 'e3',
          source: { nodeId: 'b', port: 'success' },
          target: { nodeId: 'done', port: 'input' },
        },
      ],
    );
    expect(找(graph, 'UPSTREAM_UNUSED')).toHaveLength(0);
  });
});
