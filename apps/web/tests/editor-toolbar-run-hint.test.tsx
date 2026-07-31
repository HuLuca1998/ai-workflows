import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EditorToolbar } from '../src/editor/EditorToolbar.js';

/**
 * 第 1 轮浏览器实测：「校验通过 · 2 节点 0 连接」与置灰的「运行」同屏出现，
 * 唯一的解释（「有未保存的改动。先保存草稿再运行」）藏在原生 title 里，
 * 要悬停一秒才冒出来 —— 用户面对一个绿色状态和一个灰按钮，只能猜。
 * 置灰的原因必须是**可见文本**。
 */

const base = {
  name: '测试工作流',
  rev: 1,
  dirty: false,
  saving: false,
  validation: { ok: true, issues: [] },
  nodeCount: 2,
  edgeCount: 0,
  onSave: vi.fn(),
  onPublish: vi.fn(),
  onToggleVersions: vi.fn(),
  onRun: vi.fn(),
  onRename: vi.fn(),
};

function mount(overrides: Partial<typeof base>) {
  return render(
    <MemoryRouter>
      <EditorToolbar {...base} {...overrides} />
    </MemoryRouter>,
  );
}

describe('运行按钮置灰时，原因是可见文本', () => {
  it('有未保存改动：状态栏直说「未保存」而不是只挂 title', () => {
    mount({ dirty: true });
    // getByText 不会命中 title 属性 —— 修复前这条红
    expect(screen.getByText(/未保存/)).toBeTruthy();
  });

  it('已保存且校验通过：不显示未保存提示，运行可点', () => {
    mount({ dirty: false });
    expect(screen.queryByText(/未保存/)).toBeNull();
    expect(screen.getByRole('button', { name: /运行/ })).not.toHaveProperty('disabled', true);
  });
});
