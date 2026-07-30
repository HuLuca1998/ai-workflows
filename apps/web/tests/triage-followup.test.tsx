import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { parseRules } from './_specBudget.js';

/**
 * 另一轮核对翻出来的剩余条目 —— 都是「小但确实错」的那类。
 */

const CSS = await readFile(join(process.cwd(), 'apps/web/src/styles.css'), 'utf-8');
const rule = (selector: string) =>
  parseRules(CSS).find((entry) => entry.selector.trim() === selector);

describe('颜色说的是不是那个意思', () => {
  it('「全部放行」是一句陈述，不是危险 —— 不该用失败红', () => {
    // §2.3：失败红只给「出问题了」。这句说的是「这一档下不再逐项确认」，
    // 它需要的是注意（黄），不是失败
    expect(rule('.supervisor__scopes em')?.body).not.toMatch(/--color-status-failed/u);
  });

  it('版本读不到是「需要注意」，不是「失败」', async () => {
    const { UpdateCard } = await import('../src/updater/UpdateCard.js');
    render(
      <MemoryRouter>
        <UpdateCard
          versionInfo={{ version: 'dev', source: 'unavailable', error: '读不到' }}
          backend={{
            check: async () => ({ available: false }),
            download: async () => {},
            installAndRestart: async () => {},
          }}
          autoCheck={false}
        />
      </MemoryRouter>,
    );
    const tag = await screen.findByText('未知');
    expect(tag.getAttribute('data-tone'), '读不到版本≠更新失败').toBe('warning');
  });

  it('审批横幅的标题有强调色 —— 它是全屏唯一要人动手的地方', () => {
    expect(rule('.editor-approval__text b')?.body).toMatch(/color:/u);
  });
});

describe('停用不等于不能操作', () => {
  it('整行压暗会把仍然可点的按钮一起压暗', () => {
    const row = rule(".memory__row[data-enabled='false']");
    expect(row?.body).toMatch(/opacity/u);
    // 操作列要豁免出来，否则「启用」按钮看着像不能点
    const actions = parseRules(CSS).find((entry) =>
      /\.memory__row\[data-enabled='false'\][^,]*\.memory__actions/u.test(entry.selector),
    );
    expect(actions?.body, '停用行里的按钮跟着被压暗了').toMatch(/opacity:\s*1/u);
  });
});

describe('两处无效或不达标的样式', () => {
  it('收起态不写对 flex 无效的 justify-items', () => {
    // .side-nav 是 flex column —— justify-items 只对 grid 生效，这行是死的
    expect(rule(".side-nav[data-collapsed='true']")?.body).not.toMatch(/justify-items/u);
  });

  it('设置左栏的行高到规范下限（34px）', () => {
    const body = rule('.settings-nav__item')?.body ?? '';
    const matched = /min-height:\s*(\d+)px/u.exec(body) ?? /height:\s*(\d+)px/u.exec(body);
    expect(Number(matched?.[1] ?? 0)).toBeGreaterThanOrEqual(34);
  });
});

describe('工作目录路径', () => {
  it('截掉的是前面那截 —— 最有辨识度的是尾部的目录名', () => {
    const body = rule('.title-bar__workdir')?.body ?? '';
    expect(body, '尾部截断把 ~/work/ai-workflows 显示成 ~/work/ai-work…').toMatch(
      /direction:\s*rtl/u,
    );
  });

  it('鼠标悬上去能看到完整路径', async () => {
    const { TitleBar } = await import('../src/layout/TitleBar.js');
    render(
      <MemoryRouter>
        <TitleBar onAskAi={() => {}} workdir="/Users/x/work/ai-workflows" />
      </MemoryRouter>,
    );
    expect(screen.getByText('/Users/x/work/ai-workflows').title).toBe('/Users/x/work/ai-workflows');
  });

  it('面包屑那一整条都能拖动窗口 —— 只有被标记的元素本身能拖，子元素不冒泡', async () => {
    const { TitleBar } = await import('../src/layout/TitleBar.js');
    const { container } = render(
      <MemoryRouter>
        <TitleBar onAskAi={() => {}} workdir="/tmp/ws" />
      </MemoryRouter>,
    );
    const crumb = container.querySelector('.title-bar__breadcrumb')!;
    for (const child of crumb.children) {
      expect(child.hasAttribute('data-tauri-drag-region'), `${child.className} 拖不动`).toBe(true);
    }
  });
});
