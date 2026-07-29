// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'apps/web/src/styles.css'), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';
}

describe('画布视觉层级', () => {
  it('闲置节点使用稳定实边并提高正文对比度——避免拖动时虚线重绘闪烁', () => {
    const idle = rule(".wf-node[data-tone='idle']");
    const title = rule(".wf-node[data-tone='idle'] .wf-node__title");
    const sub = rule('.wf-node__sub');

    expect(idle).toMatch(/border:\s*1px solid/u);
    expect(idle).not.toContain('dashed');
    expect(title).toContain('--color-neutral-200');
    expect(sub).toContain('--color-neutral-500');
  });

  it('选中态用边框与阴影形成单一高亮，不使用会在亚像素移动时抖动的外置 outline', () => {
    const selected = rule(".wf-node[data-selected='true']");
    expect(selected).toContain('border-color: var(--color-accent-400)');
    expect(selected).toContain('box-shadow:');
    expect(selected).not.toContain('outline');
  });

  it('拖动中的 XYFlow 节点获得独立合成提示', () => {
    const dragging = rule('.react-flow__node.dragging');
    expect(dragging).toContain('will-change: transform');
  });
});
