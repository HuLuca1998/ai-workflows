/**
 * 离开当前屏之前问一句。
 *
 * 编辑器的工具栏「返回」自己拦了未保存的改动，而**左侧导航那 7 个链接
 * 一个都不拦**（第三方巡检 B-05 实测）：拖了节点直接点「记忆」，
 * 改动静默丢失，回来位置已还原。
 *
 * 做成模块级注册表而不是让 SideNav 直接读 editorStore，有两条理由：
 * 导航栏不该知道编辑器的存在；下一个有脏数据的屏可以注册同一个口子。
 *
 * 同一时刻只有一个守卫 —— 用户只可能在一屏上有未保存的改动，
 * 而叠一摞守卫会让「谁该被注销」变成一个要维护的问题。
 */

/**
 * 返回 true 表示放行；false 表示拦下（弹确认之类由守卫自己做）。
 *
 * `to` 是用户想去的地方。守卫要记住它 —— 不记的话「丢弃并离开」
 * 只能回一个写死的路径：用户点「记忆」，确认丢弃，落在工作流列表
 * （复核实测 B）。
 */
export type LeaveGuard = (to: string) => boolean;

let current: LeaveGuard | null = null;

export function registerLeaveGuard(guard: LeaveGuard): void {
  current = guard;
}

/** 卸载时必须调用 —— 留一个已卸载组件的守卫会把整个应用锁死。 */
export function clearLeaveGuard(): void {
  current = null;
}

/** 没有守卫时一律放行。 */
export function canLeave(to: string): boolean {
  return current === null || current(to);
}
