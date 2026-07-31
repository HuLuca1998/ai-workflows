/**
 * ACP runtime 注册表。
 * 新增一个 ACP 兼容 runtime = 追加一条记录，不写新代码。
 */
import path from "node:path";

export interface AcpRuntimeEntry {
  id: string;
  /** 可执行文件名（期望在 PATH 或 node_modules/.bin 中）或绝对路径 */
  command: string;
  args: string[];
  /** 用于覆盖命令的环境变量名（指向本地构建/特定版本时用） */
  commandEnvVar: string;
  /**
   * 启动子进程前必须从环境中清除的变量。
   *
   * 关键：你的程序可能被用户从某个 agent 会话的终端里启动，继承了宿主 agent
   * 的嵌套标记；不清掉的话 runtime 会误判自己运行在另一个 agent 内部而拒绝服务。
   * 见 03-pitfalls #1。
   */
  envRemove?: string[];
}

export const ACP_RUNTIME_REGISTRY: Record<string, AcpRuntimeEntry> = {
  "claude-code": {
    id: "claude-code",
    // 新包 @agentclientprotocol/claude-agent-acp 的 bin 名。
    // 旧包 @zed-industries/claude-code-acp 的 bin 名是 claude-code-acp。
    command: "claude-agent-acp",
    args: [],
    commandEnvVar: "ACP_CLAUDE_CMD",
    envRemove: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"],
  },
  codex: {
    id: "codex",
    command: "codex-acp",
    args: [],
    commandEnvVar: "ACP_CODEX_CMD",
    envRemove: ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"],
  },
};

/**
 * 解析实际要执行的命令。
 * 优先级：环境变量覆盖 > node_modules/.bin 下的绝对路径 > 裸命令名（靠 PATH）。
 */
export function resolveRuntimeCommand(entry: AcpRuntimeEntry): { command: string; args: string[] } {
  const override = process.env[entry.commandEnvVar];
  if (override) {
    const [command = entry.command, ...args] = override.split(" ");
    return { command, args };
  }
  // node_modules/.bin 不一定在 PATH 里，优先用绝对路径（见 03-pitfalls #9）
  const local = path.resolve(process.cwd(), "node_modules/.bin", entry.command);
  return { command: local, args: entry.args };
}
