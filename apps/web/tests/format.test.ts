import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatBytes } from '../src/data/format.js';

/**
 * 字节数的显示。
 *
 * 第 5 轮审查 F3（第 16 条）：「formatBytes 两份实现输出不同，
 * 且超 1GB 显示成『2048.0 MB』」。同一个 412MB 的 worktree，
 * 在概览页显示「412 MB」，在执行记录里显示「412.0 MB」——
 * 用户会以为是两个不同的数。
 */

describe('formatBytes', () => {
  it('小于 1KB 直接给字节数', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('KB / MB / GB 各自进位', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('超过 1GB 不再显示成几千 MB', () => {
    // 旧实现：2 GB → 「2048.0 MB」
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });

  it('TB 也有 —— 产物目录攒久了真会到', () => {
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('负数与非法值不崩，也不显示成「NaN B」', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('只有一份实现', () => {
  it('没有别的文件自己写 formatBytes', () => {
    const 违规: string[] = [];
    const 扫 = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          扫(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (path.includes('data/format')) continue;
        if (/function formatBytes/u.test(readFileSync(path, 'utf8'))) 违规.push(path);
      }
    };
    扫(join(import.meta.dirname, '../src'));

    expect(违规, `这些文件自己实现了 formatBytes：${违规.join('、')}`).toEqual([]);
  });
});

describe('分页大小只有一个来源', () => {
  /**
   * 第 5 轮审查 F3（第 22 条）：「LIST_PAGE_SIZE = 50 抄了 5 份，
   * 而契约已经导出了它」。
   *
   * 改一处改不动其余六处 —— 而症状是「某一页多出/少了几条」，
   * 那种不一致要翻好几个文件才能定位。
   */
  it('没有文件自己定义 LIST_PAGE_SIZE', () => {
    const 违规: string[] = [];
    const 扫 = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          扫(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/const LIST_PAGE_SIZE\s*=/u.test(readFileSync(path, 'utf8'))) 违规.push(path);
      }
    };
    扫(join(import.meta.dirname, '../src'));

    expect(违规, `这些文件自己定义了分页大小，改用契约的：${违规.join('、')}`).toEqual([]);
  });

  it('没有地方把 50 写死在 Pager 上', () => {
    const 违规: string[] = [];
    const 扫 = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          扫(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/pageSize=\{\s*\d+\s*\}/u.test(readFileSync(path, 'utf8'))) 违规.push(path);
      }
    };
    扫(join(import.meta.dirname, '../src'));

    expect(违规, `这些文件把分页大小写死了：${违规.join('、')}`).toEqual([]);
  });
});
