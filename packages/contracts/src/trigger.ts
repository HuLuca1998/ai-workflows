/**
 * 触发方式的人话。
 *
 * 画布上的入口节点、工作流列表的定时徽章、运行记录的来源列 ——
 * 三处说的必须是同一句话，而 Rust 侧的调度器日志也说同一句
 * （`aiwf_engine::schedule::Trigger::describe`）。
 *
 * 两份实现的对冲：`TRIGGER_DESCRIPTION_CASES` 进生成物，
 * Rust 侧逐条比（`crates/engine/tests/trigger_reach_test.rs`）。
 * 一侧改了措辞而另一侧没跟上，那里会红 —— 否则用户在画布上看到
 * 「每天 09:30」而在日志里看到「daily at 9:30」，无从判断是不是同一件事。
 */

/** 入口节点的触发配置里我们关心的那几项。 */
export interface TriggerConfig {
  trigger?: string | undefined;
  scheduleTime?: string | undefined;
  intervalMinutes?: number | undefined;
}

/**
 * 一句话描述。**配置不完整时直说不完整**，不要退回「手动触发」——
 * 那会让用户以为自己没设定时，而实际上是设了但没填时刻。
 */
export function describeTrigger(config: TriggerConfig): string {
  switch (config.trigger) {
    case 'schedule': {
      const at = config.scheduleTime;
      return typeof at === 'string' && at.length > 0 ? `每天 ${at}` : '每天定时（还没填几点）';
    }
    case 'interval': {
      const minutes = config.intervalMinutes;
      if (typeof minutes !== 'number' || minutes <= 0) return '按间隔（还没填间隔）';
      return minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
    }
    // 缺字段按契约的 default 走
    case 'manual':
    case undefined:
      return '手动触发';
    default:
      // 契约加了新枚举值而这里没跟上。直说，别猜
      return `触发方式 ${config.trigger}（界面还不认识它）`;
  }
}

/** 这个触发方式会自己跑起来吗。 */
export function isAutomaticTrigger(config: TriggerConfig): boolean {
  return config.trigger === 'schedule' || config.trigger === 'interval';
}

/**
 * 定时触发的两条前提，界面上必须说清楚。
 *
 * 两条都不是实现缺陷而是有意的取舍，但用户猜不到 ——
 * 「我设了每天 9 点，第二天来看什么都没跑」的原因就在这两条里。
 */
export const SCHEDULE_CAVEATS = [
  '只跑已发布的版本 —— 草稿改到一半时被定时跑起来是最糟的形态',
  '只在应用开着的时候触发，错过就是错过，不会补跑',
] as const;

/**
 * 两侧措辞一致的夹具。生成物里带着它，Rust 侧逐条比。
 *
 * 注意别放「配置不完整」那两条：Rust 的 `Trigger` 是解析成功之后的
 * 结果类型，压根表达不了「选了 schedule 但没填时刻」——
 * 那种情况在 Rust 侧走的是 `from_entry_config` 的 `Err`。
 */
export const TRIGGER_DESCRIPTION_CASES: ReadonlyArray<{
  config: TriggerConfig;
  text: string;
}> = [
  { config: { trigger: 'manual' }, text: '手动触发' },
  { config: {}, text: '手动触发' },
  { config: { trigger: 'schedule', scheduleTime: '09:30' }, text: '每天 09:30' },
  { config: { trigger: 'schedule', scheduleTime: '00:00' }, text: '每天 00:00' },
  { config: { trigger: 'interval', intervalMinutes: 45 }, text: '每 45 分钟' },
  { config: { trigger: 'interval', intervalMinutes: 60 }, text: '每 1 小时' },
  { config: { trigger: 'interval', intervalMinutes: 120 }, text: '每 2 小时' },
  { config: { trigger: 'interval', intervalMinutes: 90 }, text: '每 90 分钟' },
];
