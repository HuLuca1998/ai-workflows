import { z } from 'zod';

/**
 * 能力声明。产品原则「显式权限」：读写文件、执行命令、访问网络、使用 Secret
 * 都由策略控制，**引擎强制，Prompt 无法越权**（功能文档 §1）。
 *
 * 节点声明自己需要什么，Agent 角色声明自己允许什么，运行时取两者交集，
 * 且不得超出当前权限档（Review Every Change / Workspace Safe / Trusted Workflow）。
 */

export const FILE_CAPABILITIES = ['none', 'read', 'read-write'] as const;
export const COMMAND_CAPABILITIES = ['none', 'declared', 'any'] as const;
export const NETWORK_CAPABILITIES = ['none', 'allowlist', 'any'] as const;
export const MEMORY_CAPABILITIES = ['none', 'read', 'read-write'] as const;

export const CapabilitiesSchema = z.object({
  /** 文件读写范围仍受授权根目录约束，PathGuard 在引擎侧兜底。 */
  file: z.enum(FILE_CAPABILITIES).default('none'),
  /** declared：只能执行节点配置里显式列出的命令。 */
  command: z.enum(COMMAND_CAPABILITIES).default('none'),
  network: z.enum(NETWORK_CAPABILITIES).default('none'),
  memory: z.enum(MEMORY_CAPABILITIES).default('none'),
  /** 允许注入的凭据引用（credentialRef）。默认空数组：Secret 必须显式授予。 */
  secret: z.array(z.string().min(1)).default([]),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/**
 * 审批三档 —— 用户在设置里选的是**谁来批**，不是「哪类操作要批」。
 *
 * 语义与判定矩阵在 `approval.ts`。常量定义留在这里是为了避开循环依赖：
 * `approval.ts` 要读节点定义，而节点定义要读本文件。
 *
 * 存储字段仍叫 `permissionPreset`（数据库列、API DTO、设置键都是它）——
 * 那是历史名字，值域已经换成下面这三个。旧值靠
 * [`migrateApprovalMode`] 在读取时映射，不做数据迁移：
 * 用户可能在旧版与新版之间来回切，改库反而回不去。
 */
export const APPROVAL_MODES = ['human_approval', 'ai_assisted', 'unattended'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * 一步操作会造成什么。分界线是**能不能收回**，详见 `approval.ts`。
 */
export const RISK_LEVELS = ['read_only', 'workspace_write', 'external_write'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** 字段值域的名字。与 [`APPROVAL_MODES`] 是同一组值。 */
export const PERMISSION_PRESETS = APPROVAL_MODES;
export type PermissionPreset = ApprovalMode;

/**
 * 上一版三档 → 新三档。
 *
 * 用户的库里躺着 `review_every_change` / `workspace_safe` / `trusted_workflow`，
 * 而这三个值在新的值域里都非法。**在读取处映射，不改库**：
 * 改了库之后用户装回旧版就读不出来了，而回退是内部分发最常发生的事。
 *
 * 映射按**严格程度**对齐，不按名字像不像：
 * - `review_every_change`（逐项审批）→ `human_approval`
 * - `workspace_safe`（工作区内放行、外部写仍要确认）→ `ai_assisted`
 * - `trusted_workflow`（全放行）→ `unattended`
 *
 * 认不出的值一律回到最严那档 —— 拼错的档位名不该把审批静默关掉。
 */
export function migrateApprovalMode(value: string | null | undefined): ApprovalMode {
  if ((APPROVAL_MODES as readonly string[]).includes(value ?? '')) return value as ApprovalMode;
  switch (value) {
    case 'workspace_safe':
      return 'ai_assisted';
    case 'trusted_workflow':
      return 'unattended';
    default:
      return 'human_approval';
  }
}

/** MCP / HTTP API 的能力范围（技术选型 §6）。 */
export const SCOPES = [
  'workflow:read',
  'workflow:write-draft',
  'workflow:publish',
  'workflow:run',
  'memory:read',
  'memory:write',
] as const;
export type Scope = (typeof SCOPES)[number];

export const NO_CAPABILITIES: Capabilities = {
  file: 'none',
  command: 'none',
  network: 'none',
  memory: 'none',
  secret: [],
};

/**
 * 判断 requested 是否被 granted 覆盖。任何一项越权即返回 false——
 * 这是「Prompt 不能扩大安全边界」在契约层的表达。
 */
export function isWithinCapabilities(requested: Capabilities, granted: Capabilities): boolean {
  const rank = <T extends readonly string[]>(scale: T, value: string): number =>
    scale.indexOf(value as T[number]);

  if (rank(FILE_CAPABILITIES, requested.file) > rank(FILE_CAPABILITIES, granted.file)) return false;
  if (rank(COMMAND_CAPABILITIES, requested.command) > rank(COMMAND_CAPABILITIES, granted.command))
    return false;
  if (rank(NETWORK_CAPABILITIES, requested.network) > rank(NETWORK_CAPABILITIES, granted.network))
    return false;
  if (rank(MEMORY_CAPABILITIES, requested.memory) > rank(MEMORY_CAPABILITIES, granted.memory))
    return false;
  return requested.secret.every((ref) => granted.secret.includes(ref));
}
