#!/usr/bin/env node
/**
 * Secret 泄漏扫描。
 *
 * 验收标准要求：Secret 从不出现在事件、日志、预览与导出中（功能文档 §9）。
 * 这条门禁把范围扩到整个仓库——一旦有人把真实凭据提交进来，CI 立刻红。
 *
 * 只扫 git 已跟踪的文件；规则与 crates/engine 的 Redactor 保持同源，
 * 那边新增形态时这里一并补上。
 *
 * 既是 CLI 也是模块：`node scripts/scan-secrets.mjs` 直接跑，
 * 测试则 import 出 SKIP 与 扫描() 来验证白名单没写歪、规则还抓得住。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** [规则名, 正则]。整条命中即视为泄漏。 */
export const RULES = [
  ['GitHub Token', /\bgh[pousr]_[A-Za-z0-9]{16,}\b/],
  ['GitHub PAT', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['OpenAI / Anthropic Key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Slack Token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API Key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['私钥文件内容', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // Tauri 更新签名私钥：必须只存在于 GitHub Secret 里
  ['Tauri 更新私钥', /untrusted comment: (rsign|minisign) encrypted secret key/],
];

/**
 * 这些路径本身就在讲 Secret 的形态，跳过以免自我误报。
 *
 * 后半段那几个是**脱敏功能的测试夹具与剧本**：要验证 Redactor 能把
 * `ghp_…` 抹掉，就必须先写一个长得像 `ghp_…` 的样本。扫描器分不清
 * 「测试用的假值」和「真的漏了」——那是对的，所以这里逐个豁免。
 *
 * 曾经想过改成「用明显不是密钥的字符串」（`49d0b3a` 对 e2e 用例就是那么修的），
 * 但那招在脱敏测试上行不通：样本一旦不像密钥，测的就是空气。
 *
 * 代价要认：整文件豁免意味着这些文件里将来混进真凭据也不会被抓。
 * 它们都是测试与文档，不参与打包分发，权衡下来可以接受。
 */
export const SKIP = [
  'scripts/scan-secrets.mjs',
  // 扫描器自己的测试：给每条规则各喂一个样本，确认规则还抓得住
  'apps/web/tests/scan-secrets.test.ts',
  'crates/engine/src/redactor.rs',
  // 诊断包脱敏：断言导出的诊断包里不含这些样本
  'crates/core-api/tests/diagnostics_test.rs',
  // 存储层脱敏：事件摘要、运行入参、产物内容三条路径的样本
  'crates/store/tests/store_test.rs',
  // 审查剧本与证据：手工审查时要照着这些形态去界面上找，
  // 报告里会原样引用命中的那一行
  'docs/archive/',
  // 目录从 docs/reference/acp/ 移到了 docs/acp/（另一个会话做的整理）
  'docs/acp/',
  'pnpm-lock.yaml',
];

/**
 * 按**规则**豁免，而不是逐个列举文件名。
 *
 * 逐个列举的代价刚兑现过：新加一条产物脱敏测试
 * （`crates/core-api/tests/artifact_redact_test.rs`），本地全绿，
 * 一跑全量就红 —— 而它和已经在名单里的 `redactor_test.rs` 是同一类东西。
 * 名单记的是「我当时知道的那几个」，不是「哪一类文件该豁免」。
 *
 * 规则：文件名里带 redact 的，按定义就是在讲脱敏，
 * 里面必须有长得像密钥的样本，否则测的是空气。
 */
export const SKIP_PATTERNS = [/(?:^|\/)[^/]*redact[^/]*\.(?:rs|ts|tsx|mjs)$/u];

/** 这个文件要不要扫。 */
export function 该跳过(file) {
  return (
    SKIP.some((prefix) => file.startsWith(prefix)) ||
    SKIP_PATTERNS.some((pattern) => pattern.test(file))
  );
}

const MAX_BYTES = 2 * 1024 * 1024;

/** git 已跟踪、且不在白名单里的文件。 */
export function 待扫文件() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !该跳过(file));
}

/**
 * 扫一批文件，返回命中列表。
 * @param {string[]} files 文件路径
 * @returns {{file: string, line: number, rule: string}[]}
 */
export function 扫描(files) {
  const findings = [];

  for (const file of files) {
    let size;
    try {
      size = statSync(file).size;
    } catch {
      continue; // 已删除但仍在索引里
    }
    if (size > MAX_BYTES) continue;

    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // 二进制
    }

    const lines = content.split('\n');
    for (const [rule, pattern] of RULES) {
      for (const [index, line] of lines.entries()) {
        if (!pattern.test(line)) continue;
        findings.push({ file, line: index + 1, rule });
      }
    }
  }

  return findings;
}

function main() {
  const files = 待扫文件();
  const findings = 扫描(files);

  for (const { file, line, rule } of findings) {
    console.error(`✗ ${file}:${line} 疑似${rule}`);
  }

  if (findings.length > 0) {
    console.error(
      `\n发现 ${findings.length} 处疑似凭据。凭据只能进 Keychain 或 GitHub Secret；` +
        '仓库里一律用 keychain:// 引用或占位符。',
    );
    process.exit(1);
  }

  console.log(`✓ 扫描 ${files.length} 个文件，未发现明文凭据`);
}

// 被 import 时只导出，不执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
