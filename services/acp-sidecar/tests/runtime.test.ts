import { describe, expect, it } from 'vitest';
import {
  ACP_RUNTIME_REGISTRY,
  buildSpawnEnv,
  resolveRuntimeCommand,
  validateSessionCwd,
} from '../src/runtime.js';

/**
 * 这些用例全部来自 docs/acp/03-pitfalls.md ——
 * 每条都是真实踩过并修复的坑。固化成测试，避免重构时又踩回去。
 */

describe('runtime 注册表', () => {
  it('登记了 Claude Code 与 Codex 两个 runtime', () => {
    expect(Object.keys(ACP_RUNTIME_REGISTRY).sort()).toEqual(['claude-code', 'codex']);
  });

  it('用 2026 年改名后的新包 bin 名，不是已废弃的旧包', () => {
    expect(ACP_RUNTIME_REGISTRY['claude-code']?.command).toBe('claude-agent-acp');
    expect(ACP_RUNTIME_REGISTRY['claude-code']?.command).not.toBe('claude-code-acp');
    expect(ACP_RUNTIME_REGISTRY.codex?.command).toBe('codex-acp');
  });

  it('每个 runtime 都声明 adapter 与 CLI 的版本要求——两者必须成对锁定', () => {
    for (const entry of Object.values(ACP_RUNTIME_REGISTRY)) {
      expect(entry.expectedAdapterPackage).toBeTruthy();
      expect(entry.expectedProtocolVersion).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('嵌套会话标记（坑 #1，必踩）', () => {
  it('spawn 前清除 Claude Code 的嵌套标记', () => {
    const env = buildSpawnEnv(ACP_RUNTIME_REGISTRY['claude-code']!, {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '51234',
      HOME: '/Users/x',
    });

    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    // 其余环境原样保留，否则 runtime 找不到登录态
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/x');
  });

  it('清除 Codex 的沙箱标记', () => {
    const env = buildSpawnEnv(ACP_RUNTIME_REGISTRY.codex!, {
      CODEX_SANDBOX: 'seatbelt',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
    });
    expect(env.CODEX_SANDBOX).toBeUndefined();
    expect(env.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
  });

  it('Secret 不通过环境泄漏给 runtime：只注入显式声明的键', () => {
    const env = buildSpawnEnv(
      ACP_RUNTIME_REGISTRY['claude-code']!,
      { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_不该被继承' },
      { allowSecrets: [] },
    );
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('显式声明的凭据才注入', () => {
    const env = buildSpawnEnv(
      ACP_RUNTIME_REGISTRY['claude-code']!,
      { GITHUB_TOKEN: 'ghp_real' },
      { allowSecrets: ['GITHUB_TOKEN'] },
    );
    expect(env.GITHUB_TOKEN).toBe('ghp_real');
  });
});

describe('命令解析（坑 #9）', () => {
  it('环境变量覆盖优先，指向本地构建时用', () => {
    const resolved = resolveRuntimeCommand(ACP_RUNTIME_REGISTRY['claude-code']!, {
      ACP_CLAUDE_CMD: '/opt/dev/claude-agent-acp --debug',
    });
    expect(resolved.command).toBe('/opt/dev/claude-agent-acp');
    expect(resolved.args).toEqual(['--debug']);
  });

  it('默认用 node_modules/.bin 下的绝对路径——它不一定在 PATH 里', () => {
    const resolved = resolveRuntimeCommand(ACP_RUNTIME_REGISTRY['claude-code']!, {}, '/app');
    expect(resolved.command).toBe('/app/node_modules/.bin/claude-agent-acp');
  });
});

describe('会话工作目录（坑 #5）', () => {
  it('必须是绝对路径——cwd 由引擎决定，Prompt 不能改变安全边界', () => {
    expect(() => validateSessionCwd('relative/path')).toThrow(/绝对路径/u);
  });

  it('拒绝系统临时目录：目录名会进 ~/.claude/projects 成为历史，下次新会话串味', () => {
    expect(() => validateSessionCwd('/var/folders/xx/T/tmp-abc123')).toThrow(/临时目录/u);
    expect(() => validateSessionCwd('/tmp/tmp-abc123')).toThrow(/临时目录/u);
  });

  it('稳定的工作目录通过', () => {
    expect(validateSessionCwd('/Users/lin/worktrees/fix-548')).toBe('/Users/lin/worktrees/fix-548');
  });
});
