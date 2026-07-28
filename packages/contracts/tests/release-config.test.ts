import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 发布配置的守卫。
 *
 * 这个应用在公司内部分发，装在同事各自的 Mac 上 —— 那些机器
 * 有 Apple Silicon 也可能有 Intel，而且都不会有我们的开发者证书。
 * 三件事必须成立，否则「装不上」会在发版之后才被发现。
 */

const release = readFileSync(
  join(import.meta.dirname, '../../../.github/workflows/release.yml'),
  'utf8',
);

describe('构建覆盖同事们的机器', () => {
  it('构建的是 universal —— Intel Mac 上也要能跑', () => {
    expect(
      release.includes('universal-apple-darwin'),
      '只构建 aarch64 的话，Intel Mac 上双击没有反应',
    ).toBe(true);
  });

  it('没有落单的 aarch64-only 构建 —— 漏一处就有人装不上', () => {
    const lines = release.split('\n').filter((line) => line.includes('apple-darwin'));
    const 落单 = lines.filter(
      (line) => line.includes('aarch64-apple-darwin') && !line.includes('universal'),
    );
    // 装 target 的那几行是例外：universal 要先把两个单架构都装上。
    // 认「同一行里两个架构都出现」而不是认 rustup —— 命令被拆成多行之后
    // rustup 与 --target 不在同一行
    const 非安装行 = 落单.filter(
      (line) => !line.includes('x86_64-apple-darwin') && !line.includes('rustup'),
    );
    expect(非安装行, `这些行仍是 aarch64-only：${非安装行.join(' / ')}`).toEqual([]);
  });

  it('两个架构的 rust target 都装了', () => {
    expect(release).toContain('aarch64-apple-darwin');
    expect(release).toContain('x86_64-apple-darwin');
  });
});

describe('没有证书时的说明要准确', () => {
  it('不再把「右键 → 打开」当成操作指引 —— macOS 15 起那条路已经被堵了', () => {
    // Apple 在 Sequoia 收紧了：右键打开不再绕过 Gatekeeper。
    // 照那句做的人会以为是应用坏了。
    //
    // 提它是可以的 —— 说明它「已经失效」正是用户需要知道的；
    // 不能出现的是把它写成「首次打开请右键 → 打开」这种指引。
    const 指引句式 = /(?:首次打开|请|需)[^。\n]*右键\s*→\s*打开/u;
    expect(指引句式.test(release), '还有地方把右键打开写成操作指引').toBe(false);
  });

  it('指向安装脚本 —— 一条命令比一段说明可靠', () => {
    expect(release).toContain('install-app.sh');
  });
});

describe('安装脚本', () => {
  const script = readFileSync(join(import.meta.dirname, '../../../scripts/install-app.sh'), 'utf8');

  it('去掉 quarantine 属性 —— 那是 Gatekeeper 拦人的依据', () => {
    expect(script).toContain('com.apple.quarantine');
  });

  it('不使用 sudo —— 与首次配置那一屏同一条产品原则', () => {
    const 命令行 = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(命令行.includes('sudo')).toBe(false);
  });

  it('只对我们自己的 App 动手 —— 路径写死，不接受任意参数', () => {
    expect(script).toContain('AI Workflows.app');
  });

  it('说明它在做什么以及为什么 —— 让人抹掉安全属性总得给个理由', () => {
    expect(script).toMatch(/隔离|quarantine|公证/u);
  });
});
