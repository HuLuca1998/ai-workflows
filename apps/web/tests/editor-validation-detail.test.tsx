import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import type { ValidationResult } from '@aiwf/contracts';
import { EditorToolbar } from '../src/editor/EditorToolbar.js';

/**
 * 「N 个问题」必须说得出是哪 N 个。
 *
 * 第三方巡检 B-02 实测：顶栏红字写「2 个问题」，而那是一段死文字 ——
 * 无 title、无 onclick，点它什么都不发生；节点只描红边，没有 tooltip
 * 也没有错误面板。同时「发布版本」和「运行」被禁用，
 * **用户被卡住却拿不到任何线索**。
 *
 * 同一份 issues 一直就在组件手里，只是没渲染出来。
 */

const base = {
  name: '测试工作流',
  rev: 1,
  dirty: false,
  saving: false,
  nodeCount: 3,
  edgeCount: 2,
  onSave: vi.fn(),
  onPublish: vi.fn(),
  onToggleVersions: vi.fn(),
  onRun: vi.fn(),
  onRename: vi.fn(),
};

const 两个问题: ValidationResult = {
  ok: false,
  issues: [
    { level: 'error' as const, code: 'ENTRY_MISSING' as const, message: '工作流缺少入口节点' },
    {
      level: 'error' as const,
      code: 'CYCLE' as const,
      message: '节点 n2 连到了自己',
      nodeId: 'n2',
    },
  ],
};

const view = (validation: ValidationResult) =>
  render(
    <MemoryRouter>
      <EditorToolbar {...base} validation={validation} />
    </MemoryRouter>,
  );

describe('校验结果要查得出细节', () => {
  it('「2 个问题」是可点的，点开列出每一条', async () => {
    const user = userEvent.setup();
    view(两个问题);

    const trigger = screen.getByRole('button', { name: /2 个问题/u });
    await user.click(trigger);

    expect(screen.getByText(/工作流缺少入口节点/u)).toBeTruthy();
    expect(screen.getByText(/节点 n2 连到了自己/u)).toBeTruthy();
  });

  it('带节点 id 的问题把 id 显示出来 —— 用户要能在画布上找到它', async () => {
    const user = userEvent.setup();
    view(两个问题);
    await user.click(screen.getByRole('button', { name: /2 个问题/u }));

    const 那条 = screen.getByText(/节点 n2 连到了自己/u).closest('li');
    expect(那条?.textContent).toContain('n2');
  });

  it('没有问题时不给一个点开是空的按钮', () => {
    view({ ok: true, issues: [] });
    expect(screen.queryByRole('button', { name: /校验通过/u })).toBeNull();
    expect(screen.getByText(/校验通过/u)).toBeTruthy();
  });

  it('警告也列出来 —— 它们不拦发布，但用户有权知道', async () => {
    const user = userEvent.setup();
    view({
      ok: false,
      issues: [
        { level: 'error' as const, code: 'ENTRY_MISSING' as const, message: '工作流缺少入口节点' },
        {
          level: 'warning' as const,
          code: 'ORPHAN_NODE' as const,
          message: '节点 n5 从入口走不到，但仍会被执行',
          nodeId: 'n5',
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: /1 个问题/u }));

    expect(screen.getByText(/从入口走不到/u)).toBeTruthy();
  });

  it('只有警告时不说「校验通过」—— 那会让人以为什么都没有', () => {
    view({
      ok: true,
      issues: [
        {
          level: 'warning' as const,
          code: 'ORPHAN_NODE' as const,
          message: '节点 n5 从入口走不到，但仍会被执行',
          nodeId: 'n5',
        },
      ],
    });
    // 第三方巡检 B-07：15 个互不相连的节点，顶栏写「校验通过」，
    // 点运行才知道 Dry Run 报「这些节点从入口走不到」
    expect(screen.queryByText(/^校验通过/u), '有警告却说校验通过').toBeNull();
    expect(screen.getByRole('button', { name: /1 项提醒/u })).toBeTruthy();
  });
});
