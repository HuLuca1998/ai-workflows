import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 仓库卫生：那些「写了但不生效」的陷阱。
 *
 * 每条规则都对应一次真实踩坑。共同点是失败时**没有任何报错**——
 * 测试静默不跑、配置静默不生效，只有事后翻日志才发现。
 */

const ROOT = join(import.meta.dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', 'target', '.git', 'coverage', '.turbo']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('仓库卫生', () => {
  it('测试文件只放在 tests/ 目录下', () => {
    // 各包的 vitest include 都是 tests/**，源码旁的 .test.ts 会被静默跳过：
    // 文件在、内容对、就是永远不跑。这个坑踩过一次（transport.test.ts）
    const strays = walk(ROOT)
      .filter((path) => /\.test\.tsx?$/.test(path))
      .filter((path) => !path.includes(`${'/'}tests${'/'}`))
      .map((path) => path.slice(ROOT.length + 1));

    expect(strays, `这些测试永远不会运行，移到所属包的 tests/ 下：\n${strays.join('\n')}`).toEqual(
      [],
    );
  });

  it('每个 vitest 配置都同时收集 .test.ts 与 .test.tsx', () => {
    // 只收其中一种的话，另一种后缀的测试文件会静默不跑
    const configs = walk(ROOT)
      .filter((path) => path.endsWith('vitest.config.ts'))
      .map((path) => [path, readFileSync(path, 'utf8')] as const)
      // 根配置用 projects 聚合，自己不收集文件
      .filter(([, source]) => source.includes('include:'));
    expect(configs.length).toBeGreaterThan(0);

    for (const [config, source] of configs) {
      const relative = config.slice(ROOT.length + 1);
      expect(source, `${relative} 漏了 .test.ts`).toMatch(/tests\/\*\*\/\*\.test\.ts'/);
      expect(source, `${relative} 漏了 .test.tsx`).toMatch(/tests\/\*\*\/\*\.test\.tsx'/);
    }
  });
});
