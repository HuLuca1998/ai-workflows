import { describe, expect, it } from 'vitest';
import { coerceForTest } from '../src/runs/LaunchDialog.js';

/**
 * 可选字段留空时，键要**发出去**（值是空串），不能整个丢掉。
 *
 * 两条内置模板的文案明确承诺了这个用法：
 * `server-log-triage` 的「慢查询日志路径」写着「留空则跳过慢查询那一段」，
 * `release-checklist` 的「构建命令」写着「留空则跳过构建这一段」——
 * 默认值就是空串。
 *
 * 而 `raw === ''` 那一行把整个键丢掉了：空串不是「值为空」，
 * 是「键不存在」。脚本里 `if [ -n "$SLOW" ]` 那两个分支**永远走不到**，
 * 节点起手就报「未定义的引用 ${input.slowLogPath}」（独立复核实测）。
 */

const 字段 = (key: string, kind: 'text' | 'number' = 'text') => ({
  key,
  kind,
  label: key,
  required: false,
  defaultValue: '',
});

describe('可选字段留空', () => {
  it('空串照样发出去 —— 脚本里的「留空则跳过」分支才走得到', () => {
    const out = coerceForTest([字段('slowLogPath')], { slowLogPath: '' });
    expect(Object.keys(out)).toContain('slowLogPath');
    expect(out['slowLogPath']).toBe('');
  });

  it('用户压根没碰过的字段仍然不发 —— 那与「留空」是两回事', () => {
    // undefined = 表单里没这一项；'' = 用户看见了并留空
    const out = coerceForTest([字段('slowLogPath')], {});
    expect(Object.keys(out)).not.toContain('slowLogPath');
  });

  it('数字字段留空发空串，不发 NaN', () => {
    const out = coerceForTest([字段('hours', 'number')], { hours: '' });
    expect(out['hours']).toBe('');
  });

  it('有值时照旧', () => {
    const out = coerceForTest([字段('hours', 'number')], { hours: '24' });
    expect(out['hours']).toBe(24);
  });
});
