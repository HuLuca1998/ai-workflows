#!/usr/bin/env node
/**
 * 环境检查（CLI 版）。
 *
 * 这是 M5「环境健康中心」的前身：同一份检查项清单，先以命令行形式提供，
 * 到 M5 时由引擎侧实现并在界面上展示 Ready / Needs Attention 与 Repair。
 *
 * 原则与产品一致：**只检测，不静默安装**。缺什么、去哪装、装到哪，都写清楚。
 *
 *   pnpm env:check          检查开发环境
 *   pnpm env:check --json   机器可读输出（M5 的健康中心会消费同一份结构）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const asJson = process.argv.includes('--json');

/** 把版本字符串里的第一个 x.y.z 抠出来。 */
function parseVersion(text) {
  return /(\d+)\.(\d+)\.(\d+)/u.exec(text ?? '')?.[0] ?? null;
}

function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function run(command, args, extraPath) {
  try {
    const env = extraPath
      ? { ...process.env, PATH: `${extraPath}:${process.env.PATH}` }
      : process.env;
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
  } catch {
    return null;
  }
}

const cargoBin = join(homedir(), '.cargo', 'bin');

/**
 * 检查项。
 * kind: required（缺了没法开发）/ optional（只有部分工作流需要）
 */
const CHECKS = [
  {
    name: 'Node.js',
    kind: 'required',
    min: '22.0.0',
    probe: () => parseVersion(run('node', ['--version'])),
    fix: '用 nvm / fnm 安装 Node 22 或更高：https://nodejs.org',
  },
  {
    name: 'pnpm',
    kind: 'required',
    min: '11.0.0',
    probe: () => parseVersion(run('pnpm', ['--version'])),
    fix: 'npm i -g pnpm',
  },
  {
    name: 'Rust（rustc）',
    kind: 'required',
    min: '1.85.0',
    probe: () => parseVersion(run('rustc', ['--version'], cargoBin)),
    fix: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
  },
  {
    name: 'Cargo',
    kind: 'required',
    min: '1.85.0',
    probe: () => parseVersion(run('cargo', ['--version'], cargoBin)),
    fix: '随 rustup 一起安装；已装但找不到时把 ~/.cargo/bin 加进 PATH',
  },
  {
    name: 'Git',
    kind: 'required',
    min: '2.39.0',
    probe: () => parseVersion(run('git', ['--version'])),
    fix: 'xcode-select --install',
  },
  {
    name: 'GitHub CLI',
    kind: 'optional',
    min: '2.40.0',
    probe: () => parseVersion(run('gh', ['--version'])),
    fix: 'brew install gh —— 发布流水线与 issue 操作需要',
  },
  {
    name: 'jq',
    kind: 'optional',
    probe: () =>
      parseVersion(run('jq', ['--version'])) ?? (run('jq', ['--version']) ? '存在' : null),
    fix: 'brew install jq —— 发布流水线注入版本号时需要（CI runner 自带）',
  },
];

/** 仓库自身的状态检查：装没装、生成物有没有漂、密钥备份在不在。 */
const REPO_CHECKS = [
  {
    name: '依赖已安装',
    kind: 'required',
    check: () => existsSync('node_modules') && existsSync('packages/contracts/node_modules'),
    detail: () => 'node_modules 就绪',
    fix: 'pnpm install',
  },
  {
    name: '契约生成物',
    kind: 'required',
    check: () => existsSync('packages/contracts/generated/contracts.meta.json'),
    detail: () => {
      const meta = JSON.parse(
        readFileSync('packages/contracts/generated/contracts.meta.json', 'utf8'),
      );
      return `契约 v${meta.version} · ${meta.nodeTypes.length} 种节点 · ${meta.eventTypes.length} 类事件 · ${meta.methods.length} 个方法`;
    },
    fix: 'pnpm contracts:gen',
  },
  {
    name: '更新签名私钥备份',
    kind: 'optional',
    check: () => existsSync(join(homedir(), '.aiwf-updater', 'updater.key')),
    detail: () => `本地备份在 ~/.aiwf-updater/updater.key（请另存到密码管理器）`,
    fix: '只有发布者需要。见 docs/RELEASE.md「签名密钥」',
  },
];

const results = [];

for (const check of CHECKS) {
  const version = check.probe();
  if (!version) {
    results.push({
      name: check.name,
      kind: check.kind,
      status: 'missing',
      detail: '未安装或不在 PATH',
      fix: check.fix,
    });
    continue;
  }
  if (check.min && compare(version, check.min) < 0) {
    results.push({
      name: check.name,
      kind: check.kind,
      status: 'outdated',
      detail: `${version}（需要 ≥ ${check.min}）`,
      fix: check.fix,
    });
    continue;
  }
  results.push({ name: check.name, kind: check.kind, status: 'ready', detail: version });
}

for (const check of REPO_CHECKS) {
  let ok = false;
  let detail = '';
  try {
    ok = check.check();
    if (ok) detail = check.detail();
  } catch (error) {
    ok = false;
    detail = String(error);
  }
  results.push({
    name: check.name,
    kind: check.kind,
    status: ok ? 'ready' : 'missing',
    detail: ok ? detail : '缺失',
    ...(ok ? {} : { fix: check.fix }),
  });
}

const blocking = results.filter((r) => r.status !== 'ready' && r.kind === 'required');
const attention = results.filter((r) => r.status !== 'ready' && r.kind === 'optional');

if (asJson) {
  console.log(JSON.stringify({ ok: blocking.length === 0, results }, null, 2));
  process.exit(blocking.length === 0 ? 0 : 1);
}

const MARK = { ready: '✓', missing: '✗', outdated: '!' };

/** 终端里 CJK 与全角符号占两列，按字符数对齐会错位。 */
const displayWidth = (text) =>
  [...text].reduce((sum, ch) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) ? 2 : 1), 0);

const width = Math.max(...results.map((r) => displayWidth(r.name))) + 2;

console.log('');
for (const r of results) {
  const pad = ' '.repeat(Math.max(0, width - displayWidth(r.name)));
  const tag = r.kind === 'optional' && r.status !== 'ready' ? '（可选）' : '';
  console.log(`${MARK[r.status]} ${r.name}${pad}${r.detail}${tag}`);
  if (r.fix) console.log(`  ${' '.repeat(width)}  → ${r.fix}`);
}

console.log('');
if (blocking.length === 0) {
  console.log(
    attention.length === 0
      ? '环境就绪。下一步：pnpm verify（跑一遍完整门禁）'
      : `环境可用，${attention.length} 项可选依赖缺失（只影响部分工作流）`,
  );
} else {
  console.log(`有 ${blocking.length} 项必需依赖未就绪，按上面的提示装好后再跑一次。`);
}
console.log('');

process.exit(blocking.length === 0 ? 0 : 1);
