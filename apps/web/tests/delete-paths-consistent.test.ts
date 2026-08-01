import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 删除节点只能有一条路。
 *
 * 画布跑在**非受控模式**（`defaultNodes`）：XYFlow 自己维护一份内部 store。
 * 绕过它直接 `apply({op:'removeNode'})` 的话，那个节点在 XYFlow 眼里还在 ——
 * 随后任何一次批量删除都会把它算进去，对着一个草稿里已经没有的 id
 * 再 removeNode 一次，整页崩成「节点 notify_1 不存在」。
 *
 * 复核实测（N1）的复现配方：
 *
 * 1. 新建工作流（rev0，**从未保存**）
 * 2. 加三个节点
 * 3. **右键菜单**删掉一个
 * 4. ⌘A + Delete → 确认 → 崩
 *
 * **只在 rev0 上复现**：保存过一次之后 `load` 会重建整个 graph，
 * XYFlow 的 store 跟着重来，那条脏记录就没了 —— 也就是说
 * 「先建流程、存一次、再测删除」的验证脚本一定是绿的。
 * 上一轮的修复正是这么被放过的（那次只改了 ⌘A 那条路）。
 *
 * 这条守卫查源码：**没有第二处直接 apply removeNode 的地方**。
 * 行为验证在浏览器里做（jsdom 不跑 React Flow 的内部 store）。
 */

const EDITOR = await readFile(join(process.cwd(), 'apps/web/src/editor/EditorPage.tsx'), 'utf-8');

describe('删除节点只走 React Flow 那一条路', () => {
  it('EditorPage 里没有绕过 deleteElements 的 removeNode', () => {
    // 允许出现的两处：
    // - onNodesChange 里把 XYFlow 报上来的 remove change 落成 patch（那是终点，不是起点）
    // - 类型标注 `op: 'removeNode'`（onApply 里过滤右键菜单的删除操作）
    const lines = EDITOR.split('\n');
    const 可疑 = lines
      .map((line, index) => ({ line: line.trim(), no: index + 1 }))
      .filter((entry) => /apply\(\s*\[?\s*\{\s*op:\s*'removeNode'/u.test(entry.line));

    expect(
      可疑.map((entry) => `${entry.no}: ${entry.line}`),
      '直接 apply removeNode 会让 XYFlow 内部 store 与草稿不一致，' +
        '下一次批量删除就崩（复核实测 N1）。删除要走 flow.deleteElements',
    ).toEqual([]);
  });

  it('右键菜单的 onApply 把删除转交给 deleteElements', () => {
    // 菜单产出的是 PatchOperation[]，其中 removeNode 那部分要改走 React Flow
    expect(
      /onApply=\{\(ops\) => \{[\s\S]*?deleteElements/u.test(EDITOR),
      '右键菜单的 onApply 仍在直接 apply —— 那正是 N1 的入口',
    ).toBe(true);
  });

  it('确认过的删除会放行，不再弹第二次确认', () => {
    // 菜单上点过「删除」就是确认过了；deleteElements 会重新触发
    // onBeforeDelete，那一次必须直接放行
    expect(/confirmedDelete\.current\.add/u.test(EDITOR)).toBe(true);
  });

  it('这条守卫自己会红', () => {
    const 假的 = `onClick={() => apply([{ op: 'removeNode', nodeId: node.id }])}`;
    expect(/apply\(\s*\[?\s*\{\s*op:\s*'removeNode'/u.test(假的)).toBe(true);
  });
});
