import { getNodeDefinition, type NodeType } from '@aiwf/contracts';

/**
 * 从节点库拖入画布时的初始标题与配置。
 *
 * 配置只填**能填的**：必填字段给一个明显是占位的值（如 `待填写`），
 * 可选字段一律交给 Schema 的默认值。刚拖进来的节点校验不通过是对的——
 * 工具栏会显示问题计数，用户点开配置补齐。给一个「看起来能跑」的假配置
 * 反而会让人以为不用配。
 */

const TITLES: Record<NodeType, string> = {
  'ai.analyze': 'AI · 分析',
  'ai.review': 'AI · 审查',
  'ai.decide': 'AI · 决策',
  'ai.execute': 'AI · 执行',
  entry: '入口设置',
  subworkflow: '调用子工作流',
  branch: '条件分支',
  transform: '数据转换',
  end: '结束',
  approval: '人工审批',
  notify: '系统通知',
  'script.shell': 'Shell 脚本',
  'script.python': 'Python 脚本',
  'git.worktree': 'Git worktree',
  env: '环境变量',
  'mcp.tool': 'MCP 工具',
};

export function titleFor(type: NodeType): string {
  return TITLES[type] ?? getNodeDefinition(type).title;
}

/** 必填字段的占位值。留空会让 Schema 校验直接拒绝，节点根本加不进来。 */
const SEEDS: Record<NodeType, Record<string, unknown>> = {
  'ai.analyze': { agentProfileId: '待选择角色', instruction: '待填写指令', target: '待填写对象' },
  'ai.review': { agentProfileId: '待选择角色', instruction: '待填写指令', target: '待填写对象' },
  'ai.decide': { agentProfileId: '待选择角色', instruction: '待填写指令' },
  'ai.execute': { agentProfileId: '待选择角色', instruction: '待填写指令' },
  entry: { trigger: 'manual', inputSchema: { type: 'object' } },
  subworkflow: { workflowId: '待选择工作流', versionRef: 'latest' },
  branch: { cases: [{ port: 'case_1', when: '待填写条件' }] },
  transform: { mappings: [{ from: '$.待填写', to: '待填写' }] },
  end: { outcome: 'success' },
  approval: { title: '待填写标题', interaction: 'confirm' },
  notify: { title: '待填写标题', body: '待填写正文' },
  'script.shell': { interpreter: 'zsh', script: '# 待填写命令' },
  'script.python': { interpreter: 'python3', script: '# 待填写脚本' },
  'git.worktree': { repoRoot: '待填写仓库根', baseBranch: 'main' },
  env: { operations: [{ op: 'set', key: 'KEY', value: '', scope: 'run' }] },
  'mcp.tool': { serverId: '待选择 Server', toolAllowlist: ['待选择工具'] },
};

export function minimalConfigFor(type: NodeType): unknown {
  const seed = SEEDS[type] ?? {};
  // 过一遍 Schema：填上默认值，同时保证拖进来的节点结构一定合法
  const parsed = getNodeDefinition(type).configSchema.safeParse(seed);
  return parsed.success ? parsed.data : seed;
}
