import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error 仓库级脚本，没有 .d.ts；这里只用到三个具名导出
import { SKIP, 待扫文件, 扫描 } from '../../../scripts/scan-secrets.mjs';

/**
 * Secret 扫描器自身的守卫。
 *
 * 这条测试是踩坑之后补的：`30328839212` 那次发版挂在「门禁」步骤，
 * 表面看像单元测试挂了，实际是扫描器把**脱敏测试的夹具**当成真泄漏，
 * 一口气报了 21 处。测脱敏就得写像密钥的样本，扫描器分不清——
 * 那不是它的错，是白名单没跟上。
 *
 * 更根本的成因是**扫描器不在 `pnpm verify` 里**：本地门禁全绿，
 * 问题一路溜到 macOS runner 上才炸，反馈慢了整整一个发版周期。
 * 把它挂进 vitest 就补上了这个缺口——全仓扫一遍只要 0.09 秒。
 */

const 白名单文件 = (前缀: string) => join(import.meta.dirname, '../../..', 前缀);

describe('Secret 扫描器', () => {
  it('当前仓库没有明文凭据', () => {
    const 命中 = 扫描(待扫文件()) as { file: string; line: number; rule: string }[];

    // 失败时把位置全列出来——只说「有 N 处」还得再跑一遍脚本才知道在哪
    expect(命中.map((c) => `${c.file}:${c.line} ${c.rule}`)).toEqual([]);
  });

  it('白名单里的路径都真实存在', () => {
    // 路径写歪了不会报错，只会静默地不豁免（或豁免了个空气）。
    // 文件改名、目录搬家之后，这条会立刻指出白名单该跟着改
    const 失效 = (SKIP as string[]).filter((前缀) => !existsSync(白名单文件(前缀)));

    expect(失效).toEqual([]);
  });

  it('规则确实抓得住每一种凭据形态', () => {
    // 白名单一路加下去，容易演变成「扫描器还在跑，但什么都抓不到了」。
    // 这里给每条规则喂一个样本，确认它还活着
    const 样本 = [
      ['GitHub Token', 'token=ghp_0123456789abcdefghijklmnopqrstuvwxyz'],
      ['GitHub PAT', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
      ['OpenAI / Anthropic Key', 'key: sk-proj-0123456789abcdefghijklmnop'],
      ['Slack Token', 'xoxb-0123456789-abcdefghij'],
      ['AWS Access Key', 'AKIAIOSFODNN7EXAMPLE'],
      ['Google API Key', 'AIzaSyA0123456789abcdefghijklmnopqrstuvw'],
      ['私钥文件内容', '-----BEGIN RSA PRIVATE KEY-----'],
      ['Tauri 更新私钥', 'untrusted comment: minisign encrypted secret key'],
    ];

    const dir = mkdtempSync(join(tmpdir(), 'aiwf-scan-'));

    for (const [规则, 内容] of 样本) {
      const 文件 = join(dir, '样本.txt');
      writeFileSync(文件, `无关的一行\n${内容}\n又一行无关的\n`);

      const 命中 = 扫描([文件]) as { line: number; rule: string }[];

      expect(命中, `${规则} 没抓到：${内容}`).toHaveLength(1);
      expect(命中[0]?.rule).toBe(规则);
      expect(命中[0]?.line, '行号要指到出问题那一行').toBe(2);
    }
  });

  it('白名单只豁免测试与文档，不碰会被打包的代码', () => {
    // 整文件豁免是有代价的：那些文件里将来混进真凭据也不会被抓。
    // 所以豁免范围必须停在「测试夹具 + 文档 + 扫描器自己」，
    // 一旦有人为了让门禁变绿而把 src/ 下的实现文件加进来，这条就红
    const 可豁免 = (路径: string) =>
      路径.startsWith('docs/') ||
      路径.includes('/tests/') ||
      路径 === 'scripts/scan-secrets.mjs' ||
      // Redactor 的实现里写着要匹配的形态，绕不开
      路径 === 'crates/engine/src/redactor.rs' ||
      路径 === 'pnpm-lock.yaml';

    expect((SKIP as string[]).filter((p) => !可豁免(p))).toEqual([]);
  });
});
