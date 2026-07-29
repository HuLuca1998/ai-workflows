import { describe, expect, it } from 'vitest';
import { CORE_API_METHODS, getMethodSpec } from '../src/api.js';

/**
 * 一键初始化的契约。
 *
 * 这是全应用破坏性最强的一条命令 —— 它把库清空重来。所以契约层要
 * 挡住的不是「怎么用」，而是「怎么被误用」：
 *
 * - **不对 MCP / HTTP 开放**（`scope: null`）。开给 Agent 等于给它一条
 *   「把用户的东西全删了」的路，而权限档挡不住它 —— 那不是扩权，
 *   是这条命令本身的语义。
 * - **必须显式确认**。`scope: null` 挡住了外部客户端，挡不住本地脚本
 *   照着命令名一把梭，`confirm` 让手滑至少要多打一个字段。
 * - **先预览再执行**。这个应用一贯的做法：图纸「06 首次安装与检测」
 *   把「将写入的位置」逐条列出来才让你点确认，删东西没有理由更随意。
 */

describe('workspace.reset 契约', () => {
  it('预览与执行两条方法都在', () => {
    expect(CORE_API_METHODS).toContain('workspace.resetPreview');
    expect(CORE_API_METHODS).toContain('workspace.reset');
  });

  it('两条都不对 MCP / HTTP 开放 —— scope 是 null', () => {
    // catalog.rs 就是照 scope 是不是 null 决定要不要进工具清单的，
    // 这里守住的是那条判断的输入
    expect(getMethodSpec('workspace.resetPreview').scope).toBeNull();
    expect(getMethodSpec('workspace.reset').scope).toBeNull();
  });

  it('执行是写操作且必须留痕', () => {
    const spec = getMethodSpec('workspace.reset');
    expect(spec.mutates).toBe(true);
    expect(spec.audited).toBe(true);
  });

  it('预览不改任何东西', () => {
    const spec = getMethodSpec('workspace.resetPreview');
    expect(spec.mutates).toBe(false);
  });

  it('不带 confirm 调不动', () => {
    const { input } = getMethodSpec('workspace.reset');
    expect(input.safeParse({}).success).toBe(false);
    expect(input.safeParse({ confirm: false }).success).toBe(false);
    expect(input.safeParse({ confirm: true }).success).toBe(true);
  });

  it('默认不碰工作目录里的产物 —— 那是用户自己的仓库', () => {
    const parsed = getMethodSpec('workspace.reset').input.parse({ confirm: true });
    expect(parsed).toMatchObject({ includeArtifacts: false });
  });

  it('预览逐条报出会清掉多少东西', () => {
    const { output } = getMethodSpec('workspace.resetPreview');
    const 样例 = {
      counts: { workflows: 3, runs: 12, memories: 4, agents: 4, prompts: 5, models: 2 },
      directories: [
        { path: '/tmp/aiwf/runs', kind: 'runs', bytes: 4096, insideWorkdir: false },
        {
          path: '/Users/x/code/.aiwf-artifacts',
          kind: 'artifacts',
          bytes: 90,
          insideWorkdir: true,
        },
      ],
    };
    expect(output.safeParse(样例).success).toBe(true);
  });

  it('产物目录要标出它在不在用户的工作目录里 —— 界面据此警告', () => {
    const { output } = getMethodSpec('workspace.resetPreview');
    const 缺标记 = {
      counts: { workflows: 0, runs: 0, memories: 0, agents: 0, prompts: 0, models: 0 },
      directories: [{ path: '/tmp/x', kind: 'artifacts', bytes: 0 }],
    };
    expect(output.safeParse(缺标记).success).toBe(false);
  });

  it('执行后回报真的删了哪些目录 —— 界面照实回显，不假设', () => {
    const { output } = getMethodSpec('workspace.reset');
    expect(output.safeParse({ ok: true, removedDirectories: ['/tmp/aiwf/runs'] }).success).toBe(
      true,
    );
    expect(output.safeParse({ ok: true }).success).toBe(false);
  });
});
