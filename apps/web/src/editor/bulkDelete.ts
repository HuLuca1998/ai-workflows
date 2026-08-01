/**
 * 一次删掉一批节点之前要问一句。
 *
 * ⌘A 全选 + Delete 会**一秒删光整张图**，无确认、无 toast、无撤销出口
 * （撤销/重做在工具栏上永久禁用）—— 一次误触就是全毁
 * （第三方巡检 B-04）。
 *
 * 撤销本身要一份操作历史，是另一件事。在它落地之前，
 * 至少不能让一次按键抹掉整张图。
 */

/**
 * 从几个起要确认。
 *
 * 2 而不是 5：这个应用里的图本来就没几个节点，阈值定高了等于没有。
 * 删单个不问 —— 那是常规操作，问了只会让人学会闭眼点确认。
 */
export const BULK_DELETE_THRESHOLD = 2;

export function needsBulkDeleteConfirm(count: number): boolean {
  return count >= BULK_DELETE_THRESHOLD;
}
