import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { EditorPage } from '../src/editor/EditorPage.js';
import { useEditor } from '../src/editor/editorStore.js';

/**
 * 第 2 轮浏览器实测的阻断级事故：配置弹层开着时，焦点落在弹层内
 * 非输入元素上（按钮、标签页…），按 ⌘A —— 画布把 6 个节点全选中；
 * 随后一个 Backspace 清空整张画布，而撤销是「待实现」。
 *
 * 弹层是模态的：它开着时，画布级快捷键必须整体失效。
 */

const graph = {
  nodes: [
    {
      id: 'entry',
      type: 'entry' as const,
      title: '入口 · Issue 输入',
      position: { x: 40, y: 34 },
      config: { trigger: 'manual' },
    },
    {
      id: 'end',
      type: 'end' as const,
      title: '结束',
      position: { x: 340, y: 34 },
      config: { outcome: 'success' as const },
    },
  ],
  edges: [],
  groups: [],
};

const renderEditor = () =>
  render(
    <MemoryRouter initialEntries={['/editor/wf_1']}>
      <Routes>
        <Route path="/editor/:workflowId" element={<EditorPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  useEditor.setState({
    workflowId: 'wf_1',
    name: '测试流程',
    rev: 1,
    graph,
    versions: [],
    dirty: false,
    selection: [],
  });
});

describe('配置弹层开着时画布快捷键失效', () => {
  it('⌘A 不再全选画布节点', async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByText('入口 · Issue 输入')).toBeTruthy());

    // 双击节点打开配置弹层
    fireEvent.doubleClick(screen.getByText('入口 · Issue 输入'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // 焦点落在弹层里的**按钮**上（不是输入框）—— 事故现场的形态
    screen.getByRole('button', { name: '保存到草稿' }).focus();
    fireEvent.keyDown(window, { key: 'a', metaKey: true });

    expect(useEditor.getState().selection).toEqual([]);
  });

  it('弹层关掉后 ⌘A 恢复全选', async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByText('入口 · Issue 输入')).toBeTruthy());

    fireEvent.doubleClick(screen.getByText('入口 · Issue 输入'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    expect(useEditor.getState().selection).toEqual(['entry', 'end']);
  });
});
