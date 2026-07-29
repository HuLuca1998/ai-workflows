import { useState } from 'react';

import { ConversationView } from './ConversationView.js';
import type { RunEvent } from './runsStore.js';

/**
 * 选中一个节点时的详情面板。
 *
 * 一条原则：**不同类型的节点该看的东西不一样**。
 * 脚本节点要看命令、退出码、两路输出；AI 节点要看用了谁、问了什么、
 * 想了什么、调了哪些工具、答了什么；worktree 要看分支与路径；
 * 审批要看谁在什么时候批了什么。
 *
 * 全都塞进同一张按时间排的事件表里，等于让用户自己去认哪几行有用 ——
 * 一次 AI 分析有几十条工具调用事件，结论那一条淹在中间。
 *
 * 没有专属视图的类型退回事件列表，而不是留一片空白：
 * 空白会让人以为「这个节点什么都没发生」。
 */

export interface NodeDetailProps {
  nodeId: string;
  /** 图里声明的类型。决定用哪一套渲染。 */
  nodeType: string;
  nodeLabel: string;
  /** 这个节点的事件，已经按 nodeId 过滤过。 */
  events: readonly RunEvent[];
  onOpenArtifact?: (relPath: string) => void;
}

/** 一栏。`aria-label` 是它的名字 —— 读屏与测试都靠它定位。 */
function Section({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section className="ndetail__section" role="group" aria-label={name}>
      <h5 className="ndetail__section-title">{name}</h5>
      {children}
    </section>
  );
}

function Block({
  text,
  payloadRef,
  onOpenArtifact,
}: {
  text: string;
  payloadRef?: string | undefined;
  onOpenArtifact?: ((relPath: string) => void) | undefined;
}) {
  return (
    <>
      <pre className="ndetail__pre">{text}</pre>
      {payloadRef && onOpenArtifact ? (
        <button type="button" className="conv__full" onClick={() => onOpenArtifact(payloadRef)}>
          <i className="ph ph-arrows-out-simple" aria-hidden="true" />
          全文
        </button>
      ) : null}
    </>
  );
}

export function NodeDetail({
  nodeId,
  nodeType,
  nodeLabel,
  events,
  onOpenArtifact,
}: NodeDetailProps) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const first = (type: string) => ordered.find((event) => event.type === type);

  if (ordered.length === 0) {
    return (
      <p className="runs__empty">「{nodeLabel}」还没跑到。上游节点跑完之后这里会显示它的详情。</p>
    );
  }

  const failure = ordered.find(
    (event) => event.type === 'node.failed' || event.type === 'node.cancelled',
  );

  return (
    <div className="ndetail" data-node-type={nodeType}>
      {/* 耗时顶在最上面。AI 节点动辄两三分钟，不显示的话用户分不清
          「它很慢」和「它卡住了」—— 而那是两件要采取不同行动的事 */}
      <p className="ndetail__elapsed">
        <i className="ph ph-timer" aria-hidden="true" />
        {elapsedOf(ordered)}
      </p>

      {/* 失败原因永远在最前面：出问题时用户第一眼要看的是「为什么」，
          不是按时间顺序翻到最后一行 */}
      {failure ? (
        <Section name="失败原因">
          <p className="ndetail__fail">{failure.summary}</p>
        </Section>
      ) : null}

      {nodeType.startsWith('ai.') ? (
        <AiNode nodeId={nodeId} events={ordered} {...(onOpenArtifact ? { onOpenArtifact } : {})} />
      ) : nodeType.startsWith('script.') ? (
        <ScriptNode events={ordered} {...(onOpenArtifact ? { onOpenArtifact } : {})} />
      ) : nodeType === 'git.worktree' ? (
        <WorktreeNode event={first('node.output_emitted')} />
      ) : nodeType === 'approval' ? (
        <ApprovalNode events={ordered} />
      ) : (
        <FallbackNode events={ordered} />
      )}
    </div>
  );
}

// ── AI 节点 ─────────────────────────────────────────────────────────────────

function AiNode({
  nodeId,
  events,
  onOpenArtifact,
}: {
  nodeId: string;
  events: readonly RunEvent[];
  onOpenArtifact?: (relPath: string) => void;
}) {
  const resolved = events.find((event) => event.type === 'system.model_resolved');
  const toolCalls = events.filter(
    (event) => event.type === 'tool.call_finished' || event.type === 'tool.call_failed',
  );
  // 对话那一栏不再重复渲染工具活动 —— 它有自己一栏了
  const conversationEvents = events.filter((event) => !event.type.startsWith('tool.'));

  return (
    <>
      {/* 「这一步用了谁」是 AI 节点独有的一栏：角色、模型、runtime、cwd。
          图纸承诺「Fix Agent 的 cwd 固定为 worktree」，用户核对那句话
          就靠这里 */}
      {resolved ? (
        <Section name="这一步用了谁">
          <p className="ndetail__who">{resolved.summary}</p>
        </Section>
      ) : null}

      <Section name="对话">
        <ConversationView
          events={conversationEvents}
          hasAiNode
          {...(onOpenArtifact ? { onOpenArtifact } : {})}
        />
      </Section>

      {/* 工具调用单列一栏并**默认折起**。一次分析几十次调用，
          铺开的话结论那一条会被冲掉；但折掉不等于丢掉 ——
          「它到底动了什么」是要能展开逐条看的 */}
      {toolCalls.length > 0 ? <ToolActivity items={toolCalls} /> : null}
      <p className="sr-only">{nodeId}</p>
    </>
  );
}

function ToolActivity({ items }: { items: readonly RunEvent[] }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((event) => event.type === 'tool.call_failed').length;

  return (
    <section className="ndetail__section" role="group" aria-label="工具活动">
      <button
        type="button"
        className="ndetail__fold"
        aria-expanded={open}
        onClick={() => setOpen((on) => !on)}
      >
        <i className={open ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />
        <i className="ph ph-wrench" aria-hidden="true" />
        工具活动 · {items.length} 次{failed > 0 ? `（${failed} 次失败）` : ''}
      </button>
      {open ? (
        <ul className="ndetail__plain">
          {items.map((event) => (
            <li key={event.id} data-failed={event.type === 'tool.call_failed' ? 'true' : undefined}>
              <span className="ndetail__plain-time">{formatClock(event.ts)}</span>
              <span>{event.summary}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * 这一步花了多久。
 *
 * 没结束就说「进行中」，不编一个「到现在为止」的数字 ——
 * 那个数字每次刷新都在变，看起来像耗时其实不是。
 */
function elapsedOf(events: readonly RunEvent[]): string {
  const started = events.find((event) => event.type === 'node.started');
  const ended = events.find((event) =>
    ['node.succeeded', 'node.failed', 'node.skipped', 'node.cancelled'].includes(event.type),
  );
  if (!started) return '耗时未知';
  if (!ended) return '进行中';

  const ms = new Date(ended.ts).getTime() - new Date(started.ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '耗时未知';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `耗时 ${seconds}s` : `耗时 ${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

// ── 脚本节点 ────────────────────────────────────────────────────────────────

function ScriptNode({
  events,
  onOpenArtifact,
}: {
  events: readonly RunEvent[];
  onOpenArtifact?: (relPath: string) => void;
}) {
  const started = events.find((event) => event.type === 'script.started');
  const exited = events.find((event) => event.type === 'script.exited');
  const stdout = events.find((event) => event.type === 'script.stdout');
  const stderr = events.find((event) => event.type === 'script.stderr');

  return (
    <>
      {started ? (
        <Section name="跑的是什么">
          <Block
            text={started.summary}
            payloadRef={started.payloadRef}
            onOpenArtifact={onOpenArtifact}
          />
        </Section>
      ) : null}

      {exited ? (
        <Section name="结果">
          <p
            className="ndetail__exit"
            data-ok={!exited.summary.includes('退出码 0') ? 'no' : 'yes'}
          >
            {exited.summary}
          </p>
        </Section>
      ) : null}

      {/* 两路输出分开。混成一坨的话，一个 warning 会淹在几百行正常输出里 */}
      {stdout ? (
        <Section name="标准输出">
          <Block
            text={stdout.summary}
            payloadRef={stdout.payloadRef}
            onOpenArtifact={onOpenArtifact}
          />
        </Section>
      ) : null}
      {stderr ? (
        <Section name="标准错误">
          <Block
            text={stderr.summary}
            payloadRef={stderr.payloadRef}
            onOpenArtifact={onOpenArtifact}
          />
        </Section>
      ) : null}
    </>
  );
}

// ── worktree ───────────────────────────────────────────────────────────────

function WorktreeNode({ event }: { event?: RunEvent | undefined }) {
  if (!event) {
    return <p className="runs__empty">这个 worktree 节点没有留下分支信息。</p>;
  }
  return (
    <Section name="隔离工作区">
      <p className="ndetail__who">{event.summary}</p>
      <p className="ndetail__note">改动发生在这个 worktree 里，不会污染仓库的当前分支。</p>
    </Section>
  );
}

// ── 审批 ────────────────────────────────────────────────────────────────────

function ApprovalNode({ events }: { events: readonly RunEvent[] }) {
  const requested = events.find((event) => event.type === 'approval.requested');
  const decided = events.find((event) => event.type === 'approval.decided');

  return (
    <Section name="审批">
      <p className="ndetail__who">{requested?.summary ?? '等待人工决定'}</p>
      {decided ? (
        <p className="ndetail__decision">
          {decided.summary} · 由 {decided.actor} 于 {formatClock(decided.ts)}
        </p>
      ) : (
        <p className="ndetail__note">还在等人决定 —— 引擎不会替它做决定。</p>
      )}
    </Section>
  );
}

// ── 其余类型 ────────────────────────────────────────────────────────────────

function FallbackNode({ events }: { events: readonly RunEvent[] }) {
  return (
    <Section name="发生了什么">
      <ul className="ndetail__plain">
        {events.map((event) => (
          <li key={event.id}>
            <span className="ndetail__plain-time">{formatClock(event.ts)}</span>
            <span className="ndetail__plain-type">{event.type}</span>
            <span>{event.summary}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function formatClock(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleTimeString('zh-CN', { hour12: false });
}
