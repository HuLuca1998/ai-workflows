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

/** 权限三档（功能文档 §7）。扩权或版本重要变化时自动失效并重新确认。 */
export const PERMISSION_PRESETS = ['review_every_change', 'workspace_safe', 'trusted_workflow'] as const;
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

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
