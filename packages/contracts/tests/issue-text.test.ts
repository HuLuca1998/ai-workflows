import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeIssue } from '../src/nodes/index.js';
import { getNodeDefinition } from '../src/nodes/definitions.js';

/**
 * Zod 的默认文案是英文（`Too small: expected string to have >=1 characters`）。
 *
 * 节点配置表单是 Schema 驱动渲染的 —— 校验文案也该由 Schema 驱动，
 * 而不是在每个界面里各写一遍 if。字段的中文名已经在 `.describe()` 里了，
 * 差的只是把 issue 拼成一句人话。
 *
 * 不用 Zod 的全局 error map：那会连带改掉所有校验的文案，
 * 包括契约自身那些本就该给开发者看的。
 */

describe('把 Zod issue 翻成人话', () => {
  const shell = getNodeDefinition('script.shell')!;

  const issueFor = (config: Record<string, unknown>) => {
    const result = shell.configSchema.safeParse(config);
    if (result.success) throw new Error('这个配置应当校验失败');
    return result.error.issues[0]!;
  };

  it('必填为空时说清是哪个字段', () => {
    const issue = issueFor({ interpreter: 'bash', script: '', timeoutMs: 1000 });
    expect(describeIssue(issue, shell.configSchema)).toBe('脚本内容不能为空');
  });

  it('字段缺席时说「必填」而不是「Required」', () => {
    const issue = issueFor({ interpreter: 'bash', timeoutMs: 1000 });
    expect(describeIssue(issue, shell.configSchema)).toContain('必填');
  });

  it('取值不在枚举里时列出可选值', () => {
    const issue = issueFor({ interpreter: 'fish', script: 'x', timeoutMs: 1000 });
    const text = describeIssue(issue, shell.configSchema);
    expect(text).toContain('bash');
  });

  it('数字越界时说清边界', () => {
    const issue = issueFor({ interpreter: 'bash', script: 'x', timeoutMs: -5 });
    const text = describeIssue(issue, shell.configSchema);
    expect(text).toMatch(/超时|timeoutMs/u);
    expect(text).not.toMatch(/Too small|expected/u);
  });

  it('没有 describe 的字段退回字段名 —— 也好过一句英文', () => {
    const schema = z.object({ weird_field: z.string().min(1) });
    const result = schema.safeParse({ weird_field: '' });
    const issue = result.success ? null : result.error.issues[0]!;
    expect(describeIssue(issue!, schema)).toContain('weird_field');
  });

  it('嵌套字段带上路径 —— 用户要知道改哪一层', () => {
    const schema = z.object({
      retry: z.object({ times: z.number().int().min(1).describe('重试次数') }),
    });
    const result = schema.safeParse({ retry: { times: 0 } });
    const issue = result.success ? null : result.error.issues[0]!;
    expect(describeIssue(issue!, schema)).toContain('重试次数');
  });

  it('任何 issue 都不会漏出英文默认文案', () => {
    // 兜底：拿几种常见 issue 过一遍，确认没有英文漏出去
    const schema = z.object({
      a: z.string().min(2).describe('甲'),
      b: z.number().max(10).describe('乙'),
      c: z.enum(['x', 'y']).describe('丙'),
      d: z.string().email().describe('丁'),
    });
    const result = schema.safeParse({ a: '1', b: 99, c: 'z', d: '不是邮箱' });
    if (result.success) throw new Error('应当失败');

    for (const issue of result.error.issues) {
      const text = describeIssue(issue, schema);
      expect(text, `issue ${issue.code} 漏了英文：${text}`).not.toMatch(
        /Too small|Too big|Invalid|expected|received/u,
      );
    }
  });
});
