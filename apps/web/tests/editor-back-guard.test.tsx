import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { EditorToolbar } from '../src/editor/EditorToolbar.js';

/**
 * 第 2 轮实测的数据丢失路径：对话框里点完「保存到草稿」（只落本地草稿），
 * 顶栏仍是「未保存」，此时点「返回工作流列表」—— 没有任何提示，
 * 改动直接丢（实测丢失）。dirty 时返回必须先问。
 */

const base = {
  name: '测试工作流',
  rev: 1,
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

function mount(dirty: boolean) {
  return render(
    <MemoryRouter initialEntries={['/editor/wf_1']}>
      <Routes>
        <Route path="/" element={<div>列表页</div>} />
        <Route path="/editor/:id" element={<EditorToolbar {...base} dirty={dirty} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('dirty 时点返回先确认', () => {
  it('有未保存改动：返回弹确认，留下不丢改动', () => {
    mount(true);
    fireEvent.click(screen.getByRole('button', { name: '返回工作流列表' }));

    // 没有直接跳走
    expect(screen.queryByText('列表页')).toBeNull();
    // 弹出了确认，且把后果说清楚
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/现在返回，这些改动会丢/)).toBeTruthy();

    // 选「留下」：回到编辑器，什么都没丢
    fireEvent.click(screen.getByRole('button', { name: /留下|继续编辑/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('列表页')).toBeNull();
  });

  it('确认丢弃后才真的返回', () => {
    mount(true);
    fireEvent.click(screen.getByRole('button', { name: '返回工作流列表' }));
    fireEvent.click(screen.getByRole('button', { name: /丢弃并返回/ }));
    expect(screen.getByText('列表页')).toBeTruthy();
  });

  it('没有改动时直接返回，不打扰', () => {
    mount(false);
    fireEvent.click(screen.getByRole('button', { name: '返回工作流列表' }));
    expect(screen.getByText('列表页')).toBeTruthy();
  });
});
