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
    screen.getByRole('button', { name: '应用改动' }).focus();
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

describe('点节点库加节点不堆叠', () => {
  // 第 2 轮实测 P6:连点四次全部 translate 到同一坐标,
  // 画布上只看得见最后一个,用户以为前三次没生效。
  // 摆放逻辑是纯函数 cascadeFrom;页面接线只有一行。
  it('基准点被占就阶梯错开,直到空位', async () => {
    const { cascadeFrom } = await import('../src/editor/nodeDefaults.js');
    const nodes = [{ position: { x: 100, y: 100 } }, { position: { x: 128, y: 128 } }];
    expect(cascadeFrom(nodes, { x: 100, y: 100 })).toEqual({ x: 156, y: 156 });
  });

  it('基准点空着就原样返回', async () => {
    const { cascadeFrom } = await import('../src/editor/nodeDefaults.js');
    expect(cascadeFrom([], { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
    expect(cascadeFrom([{ position: { x: 300, y: 300 } }], { x: 100, y: 100 })).toEqual({
      x: 100,
      y: 100,
    });
  });
});
