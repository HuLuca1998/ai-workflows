#!/usr/bin/env node
/**
 * Secret 泄漏扫描。
 *
 * 验收标准要求：Secret 从不出现在事件、日志、预览与导出中（功能文档 §9）。
 * 这条门禁把范围扩到整个仓库——一旦有人把真实凭据提交进来，CI 立刻红。
 *
 * 只扫 git 已跟踪的文件；规则与 crates/engine 的 Redactor 保持同源，
 * 那边新增形态时这里一并补上。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/** [规则名, 正则]。整条命中即视为泄漏。 */
const RULES = [
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

/** 这些路径本身就在讲 Secret 的形态，跳过以免自我误报。 */
const SKIP = [
  'scripts/scan-secrets.mjs',
  'crates/engine/src/redactor.rs',
  'crates/engine/tests/redactor_test.rs',
  'docs/reference/acp/',
  'docs/design/',
  'pnpm-lock.yaml',
];

const MAX_BYTES = 2 * 1024 * 1024;

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !SKIP.some((prefix) => file.startsWith(prefix)));

let findings = 0;

for (const file of tracked) {
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
  for (const [name, pattern] of RULES) {
    for (const [index, line] of lines.entries()) {
      if (!pattern.test(line)) continue;
      findings += 1;
      console.error(`✗ ${file}:${index + 1} 疑似${name}`);
    }
  }
}

if (findings > 0) {
  console.error(
    `\n发现 ${findings} 处疑似凭据。凭据只能进 Keychain 或 GitHub Secret；` +
      '仓库里一律用 keychain:// 引用或占位符。',
  );
  process.exit(1);
}

console.log(`✓ 扫描 ${tracked.length} 个文件，未发现明文凭据`);
