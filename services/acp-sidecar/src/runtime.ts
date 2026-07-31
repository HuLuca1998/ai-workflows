import path from 'node:path';

/**
 * ACP runtime 注册表与进程环境构造。
 *
 * 完整背景见 docs/acp/。这里只留下引擎真正需要的那部分，
 * 并把踩过的坑写成代码里的硬约束而不是注释里的提醒。
 *
 * 新增一个 ACP 兼容 runtime = 追加一条记录，不写新代码。
 */

export interface AcpRuntimeEntry {
  id: string;
  /** 可执行文件名（期望在 node_modules/.bin 或 PATH 中）。 */
  command: string;
  args: string[];
  /** 覆盖命令的环境变量名：指向本地构建或特定版本时用。 */
  commandEnvVar: string;
  /**
   * spawn 前必须从环境中清除的变量。
   *
   * 应用可能被用户从某个 agent 会话的终端里启动，继承了宿主 agent 的嵌套标记；
   * 不清掉的话 runtime 会误判自己运行在另一个 agent 内部而拒绝服务。
   */
  envRemove: string[];
  /** 期望的 adapter 包名——adapter 与 CLI 版本要成对锁定，否则模型元数据会错配。 */
  expectedAdapterPackage: string;
  /** 握手期望的协议版本。 */
  expectedProtocolVersion: number;
}

export const ACP_RUNTIME_REGISTRY: Record<string, AcpRuntimeEntry> = {
  'claude-code': {
    id: 'claude-code',
    // 2026 年三个包全部改名，旧包 @zed-industries/* 已 deprecated
    command: 'claude-agent-acp',
    args: [],
    commandEnvVar: 'ACP_CLAUDE_CMD',
    envRemove: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'],
    expectedAdapterPackage: '@agentclientprotocol/claude-agent-acp',
    expectedProtocolVersion: 1,
  },
  codex: {
    id: 'codex',
    command: 'codex-acp',
    args: [],
    commandEnvVar: 'ACP_CODEX_CMD',
    envRemove: ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'],
    expectedAdapterPackage: '@agentclientprotocol/codex-acp',
    expectedProtocolVersion: 1,
  },
};

export interface SpawnEnvOptions {
  /**
   * 允许透传给 runtime 的凭据键。默认不透传任何 Secret：
   * Secret 只在执行目标节点时按需注入，不写进持久化环境快照（技术选型 §5）。
   */
  allowSecrets?: string[];
}

/** 看着像凭据的环境变量键：默认一律不继承。 */
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|credential)/iu;

export function buildSpawnEnv(
  entry: AcpRuntimeEntry,
  source: Record<string, string | undefined>,
  options: SpawnEnvOptions = {},
): Record<string, string | undefined> {
  const allow = new Set(options.allowSecrets ?? []);
  const env: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(source)) {
    if (entry.envRemove.includes(key)) continue;
    if (SECRET_KEY_PATTERN.test(key) && !allow.has(key)) continue;
    env[key] = value;
  }
  return env;
}

export function resolveRuntimeCommand(
  entry: AcpRuntimeEntry,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): { command: string; args: string[] } {
  const override = env[entry.commandEnvVar];
  if (override) {
    const [command = entry.command, ...args] = override.split(' ');
    return { command, args };
  }
  // node_modules/.bin 不一定在 PATH 里，优先用绝对路径
  return { command: path.resolve(cwd, 'node_modules/.bin', entry.command), args: entry.args };
}

/** 系统临时目录：会话历史会按目录名归档，临时名会让下一次新会话串味。 */
const TEMP_DIR_PATTERN = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/u;

export function validateSessionCwd(cwd: string): string {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`会话工作目录必须是绝对路径：${cwd}`);
  }
  if (TEMP_DIR_PATTERN.test(cwd)) {
    throw new Error(
      `不要用系统临时目录作为会话工作目录：${cwd}。` +
        '目录名会进入 runtime 的历史记录，下一次新会话会串味；请用 worktree 或授权目录',
    );
  }
  return cwd;
}
