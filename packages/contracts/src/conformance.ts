import type { WorkflowGraph } from './graph.js';
import type { WorkflowPatch } from './patch.js';
import { templateById } from './templates.js';

/**
 * 跨语言一致性夹具。
 *
 * `validateGraph` 与 `applyPatch` 从 M0 起就只有 TypeScript 一份实现。
 * Rust 侧要给 MCP 提供 `workflow.patch` / `workflow.validate`，就必须有第二份 ——
 * 而两份实现各自演化的结局是：界面说这条连线没问题，Agent 从 MCP 得到
 * 「没有这个输出端口」，用户对着两句互相矛盾的话不知道信谁。
 *
 * 所以两份实现之间摆一组夹具：这里定义输入，生成器用 TypeScript 那份算出
 * 期望输出写进 `generated/conformance.json`，Rust 的
 * `crates/engine/tests/conformance_test.rs` 逐条比对。
 * **连错误文案都要一致** —— 用户看到的那句话不该取决于他走的是哪条路径。
 *
 * 加规则时先在这儿加一条用例：夹具红了才说明另一边还没跟上。
 */

export interface ConformanceCase {
  name: string;
  /** 起始图。 */
  graph: WorkflowGraph;
  /** 有 patch 就跑 applyPatch，没有就只跑 validateGraph。 */
  patch?: WorkflowPatch;
  /**
   * 草稿现在的 rev。**显式给**，不默认等于 `patch.baseRevision` ——
   * 默认相等的话版本守卫这条路径永远走不到，而那正是最该被两边对齐的一条：
   * 它决定界面是「重新读取草稿」还是「让用户去改配置」。
   */
  currentRevision?: number;
}

const 位置 = { x: 0, y: 0 };

/** 一个能过校验的最小图：入口 → 结束。 */
const 最小图 = (): WorkflowGraph => ({
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: 位置,
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    { id: 'done', type: 'end', title: '结束', position: 位置, config: { outcome: 'success' } },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'done', port: 'input' },
    },
  ],
  groups: [],
});

const 空图 = (): WorkflowGraph => ({ nodes: [], edges: [], groups: [] });

/** 模板走一遍 applyPatch 得到的那张图 —— 真实规模的样本。 */
const 模板图 = (): WorkflowGraph => 空图();

const 模板补丁 = (): WorkflowPatch => ({
  baseRevision: 0,
  // 模板本身就是一串结构化操作，直接当 Patch 用
  operations: templateById('github-issue-fix')?.operations ?? [],
});

export const CONFORMANCE_CASES: ConformanceCase[] = [
  // ── 校验：每个 ValidationCode 一条 ────────────────────────────────────
  { name: '空图', graph: 空图() },
  { name: '最小可用图', graph: 最小图() },
  {
    name: '缺入口',
    graph: {
      nodes: [
        { id: 'done', type: 'end', title: '结束', position: 位置, config: { outcome: 'success' } },
      ],
      edges: [],
      groups: [],
    },
  },
  {
    name: '两个入口',
    graph: {
      nodes: [
        {
          id: 'a',
          type: 'entry',
          title: '入口 A',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        {
          id: 'b',
          type: 'entry',
          title: '入口 B',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
      ],
      edges: [],
      groups: [],
    },
  },
  {
    name: '入口有入边',
    graph: {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        {
          id: 'sh',
          type: 'script.shell',
          title: '脚本',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo hi' },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'sh', port: 'input' },
        },
        {
          id: 'e2',
          source: { nodeId: 'sh', port: 'success' },
          target: { nodeId: 'entry', port: 'input' },
        },
      ],
      groups: [],
    },
  },
  {
    name: '节点类型未登记',
    graph: {
      nodes: [
        {
          id: 'x',
          // 契约里没有这个类型：模型凭空造类型名是最常见的一种提议错误
          type: 'ai.hallucinate' as never,
          title: '不存在的类型',
          position: 位置,
          config: {},
        },
      ],
      edges: [],
      groups: [],
    },
  },
  {
    name: '配置不合法',
    graph: {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        // script 是必填且 minLength 1
        { id: 'sh', type: 'script.shell', title: '脚本', position: 位置, config: {} },
      ],
      edges: [],
      groups: [],
    },
  },
  {
    name: '节点 id 重复',
    graph: {
      nodes: [
        {
          id: 'dup',
          type: 'entry',
          title: '入口',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        { id: 'dup', type: 'end', title: '结束', position: 位置, config: { outcome: 'success' } },
      ],
      edges: [],
      groups: [],
    },
  },
  {
    name: '悬空连线',
    graph: {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: '不存在', port: 'input' },
        },
      ],
      groups: [],
    },
  },
  {
    name: '端口名不存在',
    graph: {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        { id: 'done', type: 'end', title: '结束', position: 位置, config: { outcome: 'success' } },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: '并没有这个端口' },
          target: { nodeId: 'done', port: '也没有' },
        },
      ],
      groups: [],
    },
  },
  {
    name: '重复连线',
    graph: {
      nodes: 最小图().nodes,
      edges: [
        ...最小图().edges,
        {
          id: 'e2',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'done', port: 'input' },
        },
      ],
      groups: [],
    },
  },
  {
    name: '环',
    graph: {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        {
          id: 'a',
          type: 'script.shell',
          title: 'A',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo a' },
        },
        {
          id: 'b',
          type: 'script.shell',
          title: 'B',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo b' },
        },
      ],
      edges: [
        {
          id: 'e0',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'a', port: 'input' },
        },
        {
          id: 'e1',
          source: { nodeId: 'a', port: 'success' },
          target: { nodeId: 'b', port: 'input' },
        },
        {
          id: 'e2',
          source: { nodeId: 'b', port: 'success' },
          target: { nodeId: 'a', port: 'input' },
        },
      ],
      groups: [],
    },
  },
  {
    name: '孤立节点',
    graph: {
      nodes: [
        ...最小图().nodes,
        {
          id: 'lonely',
          type: 'script.shell',
          title: '没连线的',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo alone' },
        },
      ],
      edges: 最小图().edges,
      groups: [],
    },
  },
  {
    name: 'Quorum 越界',
    graph: {
      nodes: [
        ...最小图().nodes,
        {
          id: 'join',
          type: 'transform',
          title: '汇聚',
          position: 位置,
          config: { language: 'jsonata', expression: '$' },
          join: { strategy: 'quorum', quorum: 9, merge: 'namespaced', onPartialFailure: 'fail' },
        },
      ],
      edges: [
        ...最小图().edges,
        {
          id: 'e2',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'join', port: 'input' },
        },
      ],
      groups: [],
    },
  },
  {
    name: '条件分支的动态端口',
    graph: {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: 位置,
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        {
          id: 'br',
          type: 'branch',
          title: '分支',
          position: 位置,
          config: {
            cases: [
              { port: 'high', when: 'x > 3' },
              { port: 'low', when: 'x <= 3' },
            ],
            defaultPort: '兜底',
          },
        },
        { id: 'done', type: 'end', title: '结束', position: 位置, config: { outcome: 'success' } },
      ],
      edges: [
        {
          id: 'e0',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'br', port: 'input' },
        },
        // high 是配置里声明出来的端口，合法
        {
          id: 'e1',
          source: { nodeId: 'br', port: 'high' },
          target: { nodeId: 'done', port: 'input' },
        },
        // default 已被 defaultPort 改名成「兜底」，这条应报 UNKNOWN_PORT
        {
          id: 'e2',
          source: { nodeId: 'br', port: 'default' },
          target: { nodeId: 'done', port: 'input' },
        },
      ],
      groups: [],
    },
  },

  // ── Patch：12 种操作各一条，外加守卫 ──────────────────────────────────
  {
    name: 'patch · 版本守卫拒绝陈旧的 baseRevision',
    graph: 最小图(),
    currentRevision: 12,
    patch: { baseRevision: 7, operations: [{ op: 'removeNode', nodeId: 'done' }] },
  },
  {
    name: 'patch · addNode 固化 Schema 默认值',
    graph: 最小图(),
    patch: {
      baseRevision: 3,
      operations: [
        {
          op: 'addNode',
          nodeId: 'sh',
          type: 'script.shell',
          title: '脚本',
          position: { x: 10, y: 20 },
          // 只给必填项，其余靠 Schema 的 .default() 补齐
          config: { interpreter: 'zsh', script: 'echo hi' },
        },
      ],
    },
  },
  {
    name: 'patch · addNode 不给 nodeId 时自动编号',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        {
          op: 'addNode',
          type: 'notify',
          title: '通知',
          position: 位置,
          config: { title: '完成', body: '好了' },
        },
      ],
    },
  },
  {
    name: 'patch · addNode 撞已有 id',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        {
          op: 'addNode',
          nodeId: 'done',
          type: 'end',
          title: '又一个结束',
          position: 位置,
          config: { outcome: 'success' },
        },
      ],
    },
  },
  {
    name: 'patch · addNode 配置不合法整批作废',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        { op: 'renameNode', nodeId: 'done', title: '先改个名' },
        {
          op: 'addNode',
          nodeId: 'sh',
          type: 'script.shell',
          title: '脚本',
          position: 位置,
          config: { interpreter: '并不是白名单里的' },
        },
      ],
    },
  },
  {
    name: 'patch · removeNode 连带断线',
    graph: 最小图(),
    patch: { baseRevision: 0, operations: [{ op: 'removeNode', nodeId: 'done' }] },
  },
  {
    name: 'patch · removeNode 指向不存在的节点',
    graph: 最小图(),
    patch: { baseRevision: 0, operations: [{ op: 'removeNode', nodeId: '查无此人' }] },
  },
  {
    name: 'patch · renameNode',
    graph: 最小图(),
    patch: { baseRevision: 1, operations: [{ op: 'renameNode', nodeId: 'done', title: '收工' }] },
  },
  {
    name: 'patch · moveNode 不进 Diff',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [{ op: 'moveNode', nodeId: 'done', position: { x: 999, y: -12.5 } }],
    },
  },
  {
    name: 'patch · setConfig',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [{ op: 'setConfig', nodeId: 'done', config: { outcome: 'failure' } }],
    },
  },
  {
    name: 'patch · setJoin',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        {
          op: 'setJoin',
          nodeId: 'done',
          join: { strategy: 'any', merge: 'shallow', onPartialFailure: 'continue' },
        },
      ],
    },
  },
  {
    name: 'patch · setCapabilities 是合并不是替换',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        { op: 'setCapabilities', nodeId: 'done', capabilities: { file: 'read' } },
        { op: 'setCapabilities', nodeId: 'done', capabilities: { network: 'allowlist' } },
      ],
    },
  },
  {
    name: 'patch · setRetry 是合并不是替换',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        { op: 'setRetry', nodeId: 'done', retry: { maxAttempts: 3 } },
        { op: 'setRetry', nodeId: 'done', retry: { backoff: 'fixed' } },
      ],
    },
  },
  {
    name: 'patch · connect 不给 edgeId 时自动编号',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        {
          op: 'addNode',
          nodeId: 'sh',
          type: 'script.shell',
          title: '脚本',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo hi' },
        },
        {
          op: 'connect',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'sh', port: 'input' },
        },
      ],
    },
  },
  {
    name: 'patch · connect 指向不存在的节点',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        {
          op: 'connect',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: '查无此人', port: 'input' },
        },
      ],
    },
  },
  {
    name: 'patch · disconnect',
    graph: 最小图(),
    patch: { baseRevision: 0, operations: [{ op: 'disconnect', edgeId: 'e1' }] },
  },
  {
    name: 'patch · disconnect 指向不存在的连线',
    graph: 最小图(),
    patch: { baseRevision: 0, operations: [{ op: 'disconnect', edgeId: '查无此线' }] },
  },
  {
    name: 'patch · createGroup 与 deleteGroup',
    graph: 最小图(),
    patch: {
      baseRevision: 0,
      operations: [
        { op: 'createGroup', title: '第一组', nodeIds: ['entry', 'done'] },
        { op: 'createGroup', groupId: '第二组', title: '第二组', nodeIds: ['done'] },
        { op: 'deleteGroup', groupId: '第二组' },
      ],
    },
  },
  {
    name: 'patch · deleteGroup 指向不存在的分组',
    graph: 最小图(),
    patch: { baseRevision: 0, operations: [{ op: 'deleteGroup', groupId: '查无此组' }] },
  },
  {
    name: 'patch · 内置模板从空图搭起来',
    graph: 模板图(),
    patch: 模板补丁(),
  },
];

/** `diffGraphs` 的夹具：一对图，比出一份 Diff。 */
export interface DiffCase {
  name: string;
  before: WorkflowGraph;
  after: WorkflowGraph;
}

export const DIFF_CASES: DiffCase[] = [
  { name: 'diff · 两份一样的图', before: 最小图(), after: 最小图() },
  {
    name: 'diff · 加了一个节点',
    before: 最小图(),
    after: {
      ...最小图(),
      nodes: [
        ...最小图().nodes,
        {
          id: 'sh',
          type: 'script.shell',
          title: '脚本',
          position: 位置,
          config: { interpreter: 'zsh', script: 'echo hi' },
        },
      ],
    },
  },
  {
    name: 'diff · 删了一个节点与它的连线',
    before: 最小图(),
    after: { nodes: [最小图().nodes[0]!], edges: [], groups: [] },
  },
  {
    name: 'diff · 改标题与配置',
    before: 最小图(),
    after: {
      ...最小图(),
      nodes: [
        最小图().nodes[0]!,
        { id: 'done', type: 'end', title: '收工', position: 位置, config: { outcome: 'failure' } },
      ],
    },
  },
  {
    name: 'diff · 位置变化不算改动',
    before: 最小图(),
    after: {
      ...最小图(),
      nodes: 最小图().nodes.map((node) => ({ ...node, position: { x: 500, y: 500 } })),
    },
  },
  {
    name: 'diff · 长配置值按字符截断',
    before: {
      ...最小图(),
      nodes: [
        最小图().nodes[0]!,
        {
          id: 'sh',
          type: 'script.shell',
          title: '脚本',
          position: 位置,
          // 30 个汉字：超过 24 的截断阈值。按字节切会切出半个字
          config: { interpreter: 'zsh', script: '一二三四五六七八九十'.repeat(3) },
        },
      ],
    },
    after: {
      ...最小图(),
      nodes: [
        最小图().nodes[0]!,
        {
          id: 'sh',
          type: 'script.shell',
          title: '脚本',
          position: 位置,
          config: { interpreter: 'bash', script: '甲乙丙丁戊己庚辛壬癸'.repeat(3) },
        },
      ],
    },
  },
  {
    name: 'diff · 汇聚策略变了',
    before: 最小图(),
    after: {
      ...最小图(),
      nodes: [
        最小图().nodes[0]!,
        {
          ...最小图().nodes[1]!,
          join: { strategy: 'quorum', quorum: 2, merge: 'deep', onPartialFailure: 'continue' },
        },
      ],
    },
  },
  {
    name: 'diff · 分组增删',
    before: { ...最小图(), groups: [{ id: 'g1', title: '旧组', nodeIds: ['entry'] }] },
    after: { ...最小图(), groups: [{ id: 'g2', title: '新组', nodeIds: ['done'] }] },
  },
];
