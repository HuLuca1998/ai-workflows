// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 令牌是设计系统与实现之间的唯一接口。
 * 验收标准要求：深色界面在 Increase Contrast 与 Reduce Motion 下仍可用
 * （功能文档 §9），所以这两种偏好必须在令牌层就有响应，而不是各组件各自处理。
 */

const tokens = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8');
const base = readFileSync(fileURLToPath(new URL('../src/styles/base.css', import.meta.url)), 'utf8');

describe('Nocturne 令牌', () => {
  it('定义了色彩角色与全部 100–900 色阶', () => {
    for (const name of ['--color-bg', '--color-surface', '--color-text', '--color-accent']) {
      expect(tokens).toContain(`${name}:`);
    }
    for (const step of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(tokens).toContain(`--color-neutral-${step}:`);
      expect(tokens).toContain(`--color-accent-${step}:`);
    }
  });

  it('保留了设计系统给定的基准值，没有被随手改掉', () => {
    expect(tokens).toContain('#161826'); // --color-bg
    expect(tokens).toContain('#9184d9'); // --color-accent
    expect(tokens).toContain('#e9e9ed'); // --color-text
  });

  it('定义了状态语义色——运行状态在界面上到处都要用', () => {
    for (const name of [
      '--color-status-running',
      '--color-status-waiting',
      '--color-status-success',
      '--color-status-failed',
      '--color-status-idle',
    ]) {
      expect(tokens).toContain(`${name}:`);
    }
  });

  it('间距、圆角、阴影按 0.7 密度与 8px 圆角的既定尺度给出', () => {
    for (const name of ['--space-1', '--space-8', '--radius-md', '--shadow-sm', '--shadow-lg']) {
      expect(tokens).toContain(`${name}:`);
    }
    expect(tokens).toContain('--radius-md: 8px');
  });

  it('响应 Increase Contrast：提高文本与描边对比', () => {
    expect(tokens).toMatch(/@media\s*\(prefers-contrast:\s*more\)/u);
  });

  it('响应 Reduce Motion：关掉动画而不是缩短动画', () => {
    expect(base).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(base).toMatch(/animation-duration:\s*0\.01ms/u);
  });

  it('焦点环是主题化的 2px 强调色，不留浏览器默认蓝框', () => {
    expect(base).toContain(':focus-visible');
    expect(base).toContain('outline: 2px solid var(--color-accent)');
  });

  it('把令牌映射到 Tailwind 主题，业务代码不写死十六进制', () => {
    expect(tokens).toContain('@theme');
    expect(tokens).toContain('--color-accent: var(--nocturne-accent)');
  });
});
