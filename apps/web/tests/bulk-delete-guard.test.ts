import { describe, expect, it } from 'vitest';
import { needsBulkDeleteConfirm, BULK_DELETE_THRESHOLD } from '../src/editor/bulkDelete.js';

/**
 * 一次删掉一批节点之前要问一句。
 *
 * 第三方巡检 B-04 实测：⌘A 全选 + Delete，**一秒删光 15 个节点** ——
 * 无二次确认、无 toast、无撤销出口（撤销/重做在工具栏上永久禁用）。
 * 一次误触就是全毁，而这个编辑器里每一次误操作都是永久的。
 *
 * 撤销本身是另一件大事（要一份操作历史）。在它落地之前，
 * 至少不能让一次按键抹掉整张图。
 *
 * 判据抽成纯函数：删除路径在 `onNodesChange` 里，
 * 而那条路要渲染整个画布才走得到，jsdom 不做布局。
 */

describe('批量删除要先问', () => {
  it('删一个不问 —— 那是常规操作，问了只会烦人', () => {
    expect(needsBulkDeleteConfirm(1)).toBe(false);
  });

  it('删到阈值就问', () => {
    expect(needsBulkDeleteConfirm(BULK_DELETE_THRESHOLD)).toBe(true);
  });

  it('⌘A 全选那种规模一定要问', () => {
    expect(needsBulkDeleteConfirm(15)).toBe(true);
  });

  it('阈值不能高到形同虚设 —— 大部分图本来就没几个节点', () => {
    expect(BULK_DELETE_THRESHOLD).toBeLessThanOrEqual(3);
    expect(BULK_DELETE_THRESHOLD).toBeGreaterThan(1);
  });

  it('零个不问 —— 没东西可删时弹确认是纯粹的噪音', () => {
    expect(needsBulkDeleteConfirm(0)).toBe(false);
  });
});
