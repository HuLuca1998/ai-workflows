import type { RunEvent } from './runsStore.js';

/**
 * 执行记录的「对话」视图 —— 图纸「03 执行记录」的 conv 那一支。
 *
 * 它长期是一句写死的话：「这次运行没有 AI 节点，所以没有对话」。
 * 而跑过 4 个 AI 节点的运行打开它，看到的还是那句 —— 因为引擎
 * 从来没发过 `conversation.*` 事件（文本攒进本地变量、存成产物就完了）。
 * 引擎那半已经补上，这里是把它显示出来的另一半。
 *
 * 图纸的结构：用户气泡 → Agent 消息（带一行折叠的工具活动）→
 * 审批卡 → Agent 消息。工具调用**折进它所属的那条消息**，
 * 不单独占行 —— 一次分析十几次工具调用，逐条列出来会把结论冲掉。
 */

/** 折叠进消息里的那一行工具活动。 */
interface ToolActivity {
  count: number;
  failed: number;
  /** 前几条的标题，鼠标悬停时能看清调了什么。 */
  titles: string[];
}

interface Turn {
  key: string;
  kind: 'user' | 'agent' | 'reasoning' | 'approval' | 'outcome';
  /** 谁说的。用户是「你」，Agent 是节点标题。 */
  who: string;
  text: string;
  ts: string;
  payloadRef?: string;
  tools?: ToolActivity;
}

const TOOL_TYPES = new Set(['tool.call_started', 'tool.call_finished', 'tool.call_failed']);

/**
 * 事件流 → 对话时间线。
 *
 * 工具调用先攒着，等到同一个节点的下一条消息时折进去；
 * 消息之后才出现的（节点结束前的收尾调用）挂在最后一条上。
 */
function toTurns(events: readonly RunEvent[]): Turn[] {
  const turns: Turn[] = [];
  let pending: RunEvent[] = [];

  const flushInto = (turn: Turn | undefined) => {
    if (pending.length === 0) return;
    const activity: ToolActivity = {
      count: pending.length,
      failed: pending.filter((e) => e.type === 'tool.call_failed').length,
      titles: pending.slice(0, 8).map((e) => e.summary),
    };
    if (turn) {
      turn.tools = activity;
    } else {
      // 还没有任何消息就先来了工具调用 —— 单独立一条，
      // 丢掉的话「它正在做什么」这段就没了
      turns.push({
        key: `tools-${pending[0]!.seq}`,
        kind: 'agent',
        who: pending[0]!.nodeLabel ?? pending[0]!.nodeId ?? 'Agent',
        text: '',
        ts: pending[0]!.ts,
        tools: activity,
      });
    }
    pending = [];
  };

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (TOOL_TYPES.has(event.type)) {
      pending.push(event);
      continue;
    }

    const base = {
      key: event.id,
      ts: event.ts,
      ...(event.payloadRef === undefined ? {} : { payloadRef: event.payloadRef }),
    };

    switch (event.type) {
      case 'conversation.user_message':
        flushInto(turns.at(-1));
        // 头像是「你」，署名写「本地用户」—— 图纸那条气泡就是这么标的。
        // 两处都写「你」的话，读屏会连着念两遍
        turns.push({ ...base, kind: 'user', who: '本地用户', text: event.summary });
        break;

      case 'reasoning.summary':
        flushInto(turns.at(-1));
        turns.push({
          ...base,
          kind: 'reasoning',
          who: event.nodeLabel ?? event.nodeId ?? 'Agent',
          text: event.summary,
        });
        break;

      case 'conversation.agent_message': {
        const turn: Turn = {
          ...base,
          kind: 'agent',
          who: event.nodeLabel ?? event.nodeId ?? 'Agent',
          text: event.summary,
        };
        turns.push(turn);
        // 这条消息之前的工具调用属于它
        flushInto(turn);
        break;
      }

      case 'approval.requested':
      case 'approval.decided':
        flushInto(turns.at(-1));
        turns.push({
          ...base,
          kind: 'approval',
          who: event.nodeLabel ?? event.nodeId ?? '审批',
          text: event.summary,
        });
        break;

      case 'node.failed':
      case 'run.failed':
      case 'run.succeeded':
        flushInto(turns.at(-1));
        turns.push({
          ...base,
          kind: 'outcome',
          who: event.nodeLabel ?? '运行',
          text: event.summary,
        });
        break;

      default:
        break;
    }
  }

  flushInto(turns.at(-1));
  return turns;
}

export interface ConversationViewProps {
  events: readonly RunEvent[];
  /**
   * 这次运行的图里有没有 AI 节点。
   *
   * 两种空态**必须分开说**：没有 AI 节点是「本来就不会有对话」，
   * 有 AI 节点却没消息是「还没跑到，或者出了问题」。
   * 混成一句的话，用户会以为自己的 AI 节点没生效。
   */
  hasAiNode: boolean;
  /** 点「全文」时把 payloadRef 交出去，由外层去读产物。 */
  onOpenArtifact?: (relPath: string) => void;
}

export function ConversationView({ events, hasAiNode, onOpenArtifact }: ConversationViewProps) {
  const turns = toTurns(events);

  if (turns.length === 0) {
    return (
      <p className="runs__empty">
        {hasAiNode
          ? '这次运行有 AI 节点，但还没有往返消息 —— 它可能还没跑到，或者在等 adapter。'
          : '这次运行没有 AI 节点，所以没有对话。含 AI 节点的运行会在这里显示完整的往返消息。'}
      </p>
    );
  }

  return (
    <>
      <ul className="conv">
        {turns.map((turn) => (
          <li key={turn.key} className="conv__turn" data-kind={turn.kind}>
            <span className="conv__avatar" aria-hidden="true">
              {turn.kind === 'user' ? (
                '你'
              ) : (
                <i className={turn.kind === 'approval' ? 'ph ph-user-check' : 'ph ph-sparkle'} />
              )}
            </span>
            <div className="conv__body">
              <p className="conv__meta">
                <span className="conv__who">{turn.who}</span>
                <span className="conv__time">{formatClock(turn.ts)}</span>
                {turn.kind === 'reasoning' ? <span className="conv__tag">推理</span> : null}
                {turn.payloadRef && onOpenArtifact ? (
                  <button
                    type="button"
                    className="conv__full"
                    onClick={() => onOpenArtifact(turn.payloadRef!)}
                  >
                    <i className="ph ph-arrows-out-simple" aria-hidden="true" />
                    全文
                  </button>
                ) : null}
              </p>
              {/* 摘要与署名一样时不重复显示：审批事件的 summary 常常
                  就是节点标题，渲染出来是「人工审批 / 人工审批」 */}
              {turn.text && turn.text !== turn.who ? (
                <p className="conv__text">{turn.text}</p>
              ) : null}
              {turn.tools ? (
                <p className="conv__tools" title={turn.tools.titles.join('\n')}>
                  <i className="ph ph-wrench" aria-hidden="true" />
                  工具活动 · {turn.tools.count} 次
                  {turn.tools.failed > 0 ? `（${turn.tools.failed} 次失败）` : ''}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="runs__redact">
        <i className="ph ph-shield-check" aria-hidden="true" />
        消息只存摘要，全文在产物里；Secret 值写入前已脱敏
      </p>
    </>
  );
}

/** 与事件列表同一种时间格式 —— 两个 tab 并排看时不该有两种写法。 */
function formatClock(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleTimeString('zh-CN', { hour12: false });
}
