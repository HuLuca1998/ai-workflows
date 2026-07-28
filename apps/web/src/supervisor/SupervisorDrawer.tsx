import { useEffect, useRef, useState } from 'react';
import {
  applyPatch,
  type PatchOperation,
  type WorkflowDiff,
  type WorkflowGraph,
} from '@aiwf/contracts';
import { coreClient } from '../data/workspace.js';
import { DiffLines } from '../editor/DiffLines.js';

/**
 * 主管 AI 抽屉 —— 严格照图纸：468px 从右侧滑入。
 *
 * 「掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置」——
 * 它与工作流里的 AI 节点是两回事：节点在**运行中**做一件具体的事，
 * 主管 AI 在**编辑时**帮你操作这个应用本身。
 *
 * 两条界限：
 *
 * 1. **上下文是显式的**。头部那排 chips 就是「这次对话它能看到什么」。
 *    不显式列出来的话，用户无法判断它的回答基于什么 ——
 *    而可解释性是这个产品的核心。
 * 2. **改动先出 Diff**。AI 的任何修改都走 propose，用户确认才落草稿
 *    （图纸：「不会发布，也不会改动运行中的 v7」）。
 * 3. **底部常驻本次会话的 Scope**。用户随时看得到 AI 现在能做什么、
 *    不能做什么 —— 这是「AI 建议 ≠ 执行」在界面上的兜底。
 */

interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** agent 消息在流式过程中为 true。 */
  streaming?: boolean;
}

/** 头部那排上下文 chips。图标与文案照图纸。 */
export interface SupervisorContext {
  /** 当前草稿修订号，在编辑器里才有。 */
  draftRev?: number;
  /** 选中的节点数。 */
  selectedNodes?: number;
  /** 正在看的运行。 */
  runId?: string;
  /** 会注入的记忆条数。 */
  memoryCount?: number;
  /** 当前工作流。后端靠它读草稿的图，AI 才提得出能落地的操作。 */
  workflowId?: string;
}

export interface SupervisorDrawerProps {
  open: boolean;
  context: SupervisorContext;
  /** 当前草稿的图。有它才算得出 Diff —— 没有就只能问答。 */
  graph?: WorkflowGraph;
  /** 用户确认后把操作交给编辑器落草稿（那里有 baseRevision 守卫）。 */
  onApply?: (operations: PatchOperation[]) => void;
  onClose: () => void;
}

/** 历史会话列表里的一条。 */
interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  workflowId?: string;
  runId?: string;
}

/** 待确认的提议：AI 说了什么、会变成什么样。 */
interface Proposal {
  summary: string;
  operations: PatchOperation[];
  diff: WorkflowDiff;
}

interface ModelOption {
  id: string;
  name: string;
}

export function SupervisorDrawer({
  open,
  context,
  graph,
  onApply,
  onClose,
}: SupervisorDrawerProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  /**
   * 当前会话。
   *
   * 第一问时是 null（那时还没有会话），后端回来带上 id，
   * 之后的每一问都带着它 —— 不然同一次对话会散成好几条历史。
   */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  /** 这一问等了多久（秒）。0 表示没在等。 */
  const [waited, setWaited] = useState(0);
  /**
   * 取消的凭据。
   *
   * 取消之后后端仍会回来 —— 那时那个回答已经不是用户要的了，
   * 显示出来会让人以为自己的取消没生效。用一个自增的号码判断：
   * 回来时号码对不上就丢掉。
   */
  const askSeq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // 只列已启用的模型 —— 与 Agent 页同一条规则
    void coreClient
      .call('model.list', { enabledOnly: true })
      .then((result) => {
        const items = (result as { items: ModelOption[] }).items;
        setModels(items);
        setModelId((current) => current ?? items[0]?.id ?? null);
      })
      .catch(() => setModels([]));
  }, [open]);

  useEffect(() => {
    if (!busy) {
      setWaited(0);
      return;
    }
    // 一直「正在想…」而不说等了多久，用户没法判断是慢还是死了。
    // ACP 那边的超时是 180 秒 —— 干等三分钟没有任何反馈是不可接受的
    const started = Date.now();
    const timer = setInterval(() => {
      setWaited(Math.round((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    // 新消息进来时滚到底：对话是时间序的，用户要看最新那条。
    // 直接赋 scrollTop 而不是 scrollTo —— 后者在 jsdom 里没实现，
    // 测试会因为一个纯视觉的行为整片红掉
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [messages]);

  if (!open) return null;

  /** 读一条历史会话回对话区。 */
  const openSession = async (id: string) => {
    setError(null);
    try {
      const result = (await coreClient.call('supervisor.session', { sessionId: id })) as {
        messages: { role: 'user' | 'agent'; text: string; at: string }[];
      };
      setMessages(
        result.messages.map((message, index) => ({
          id: `${id}_${index}`,
          role: message.role,
          text: message.text,
        })),
      );
      setSessionId(id);
      setHistoryOpen(false);
      setProposal(null);
    } catch (err) {
      setError(describe(err));
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    setDraft('');
    setBusy(true);
    setError(null);
    const seq = (askSeq.current += 1);
    setMessages((prev) => [
      ...prev,
      { id: `u_${Date.now()}`, role: 'user', text },
      { id: `a_${Date.now()}`, role: 'agent', text: '', streaming: true },
    ]);

    try {
      const result = (await coreClient.call('supervisor.ask', {
        question: text,
        // 有会话就接上去 —— 不带的话后端会新开一条，
        // 同一次对话在历史里散成好几段
        ...(sessionId ? { sessionId } : {}),
        ...(modelId ? { modelRef: modelId } : {}),
        context: {
          ...(context.draftRev === undefined ? {} : { draftRev: context.draftRev }),
          ...(context.runId ? { runId: context.runId } : {}),
          // 后端靠它读当前草稿的图 —— 不给的话 AI 只能凭空造 nodeId，
          // 那些操作应用不到任何东西上
          ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        },
      })) as {
        text: string;
        sessionId?: string;
        proposal?: { summary: string; operations: PatchOperation[] };
      };

      if (result.sessionId) setSessionId(result.sessionId);

      setMessages((prev) =>
        prev.map((message) =>
          message.streaming ? { ...message, text: result.text, streaming: false } : message,
        ),
      );

      // 改动**先出 Diff**，用户确认才落草稿。
      // 这里只是算出「会变成什么样」，一个字节都不写
      if (result.proposal && graph) {
        try {
          // 用当前 rev 当 baseRevision：这一步只是**试算**，
          // 真正的守卫在落草稿那一步（editorStore 会带上它自己的 rev）
          const rev = context.draftRev ?? 0;
          const applied = applyPatch(graph, rev, {
            baseRevision: rev,
            operations: result.proposal.operations,
          });
          setProposal({
            summary: result.proposal.summary,
            operations: result.proposal.operations,
            diff: applied.diff,
          });
        } catch (err) {
          // AI 引用了一个不存在的节点 —— 多半是图变了而它拿的是旧的。
          // 给一个空 Diff 会让用户以为「没什么改动」然后点确认
          setProposal(null);
          setError(`这次的提议应用不上：${describe(err)}`);
        }
      }
    } catch (err) {
      if (seq !== askSeq.current) return;
      // 失败时把那条空的 agent 消息去掉 —— 留一个空气泡比没有更糟
      setMessages((prev) => prev.filter((message) => !message.streaming));
      setError(describe(err));
    } finally {
      if (seq === askSeq.current) setBusy(false);
    }
  };

  return (
    <div className="supervisor__backdrop" onClick={onClose}>
      <aside
        className="supervisor"
        aria-label="主管 AI"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className="supervisor__head">
          <span className="supervisor__avatar">
            <i className="ph ph-sparkle" aria-hidden="true" />
          </span>
          <div className="supervisor__title">
            <p className="supervisor__name">主管 AI</p>
            <p className="supervisor__sub">
              掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置
            </p>
          </div>

          <select
            className="supervisor__model"
            aria-label="切换模型"
            value={modelId ?? ''}
            onChange={(event) => setModelId(event.target.value)}
          >
            {models.length === 0 ? <option value="">未登记模型</option> : null}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="supervisor__close"
            aria-label="历史会话"
            aria-expanded={historyOpen}
            onClick={() => {
              const next = !historyOpen;
              setHistoryOpen(next);
              // 每次展开都重读：别的地方可能刚问过一句
              if (next) {
                void coreClient
                  .call('supervisor.sessions', {})
                  .then((result) => setSessions((result as { items: SessionSummary[] }).items))
                  .catch(() => setSessions([]));
              }
            }}
          >
            <i className="ph ph-clock-counter-clockwise" aria-hidden="true" />
          </button>

          <button
            type="button"
            className="supervisor__close"
            aria-label="新对话"
            onClick={() => {
              setMessages([]);
              setSessionId(null);
              setProposal(null);
              setError(null);
            }}
          >
            <i className="ph ph-plus" aria-hidden="true" />
          </button>

          <button type="button" className="supervisor__close" aria-label="关闭" onClick={onClose}>
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </header>

        {historyOpen ? (
          <section className="supervisor__history" aria-label="历史会话">
            {sessions === null ? <p className="supervisor__empty">正在读取…</p> : null}
            {sessions?.length === 0 ? (
              <p className="supervisor__empty">
                还没有历史会话。你问的每一句都会存下来，隔天回来还能接着问。
              </p>
            ) : null}
            {(sessions ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                className="supervisor__history-item"
                data-session={item.id}
                data-active={item.id === sessionId ? 'true' : undefined}
                onClick={() => void openSession(item.id)}
              >
                <span className="supervisor__history-title">{item.title}</span>
                <span className="supervisor__history-meta">
                  {/* 图纸：「按关联的工作流 / 运行 / 记忆 / 模型标注」 */}
                  {item.workflowId ? <span className="supervisor__chip">工作流</span> : null}
                  {item.runId ? <span className="supervisor__chip">运行</span> : null}
                  <span>{item.messageCount} 条</span>
                  <span>{formatWhen(item.updatedAt)}</span>
                </span>
              </button>
            ))}
          </section>
        ) : null}

        <div className="supervisor__context" aria-label="上下文">
          <span className="supervisor__context-label">上下文</span>
          {context.draftRev === undefined ? null : (
            <span className="supervisor__chip">
              <i className="ph ph-graph" aria-hidden="true" />
              草稿 rev{context.draftRev}
            </span>
          )}
          {context.selectedNodes ? (
            <span className="supervisor__chip">
              <i className="ph ph-selection" aria-hidden="true" />
              选中节点 {context.selectedNodes}
            </span>
          ) : null}
          {context.runId ? (
            <span className="supervisor__chip">
              <i className="ph ph-clock-counter-clockwise" aria-hidden="true" />
              {context.runId.slice(0, 10)}
            </span>
          ) : null}
          {context.memoryCount ? (
            <span className="supervisor__chip">
              <i className="ph ph-brain" aria-hidden="true" />
              记忆 {context.memoryCount} 条
            </span>
          ) : null}
        </div>

        <div className="supervisor__body" ref={bodyRef}>
          {messages.length === 0 ? (
            <p className="supervisor__empty">
              问它任何关于这个应用的事：怎么搭一条工作流、上次运行为什么失败、
              某条记忆会在哪里生效。它的改动都会先给你看 Diff。
            </p>
          ) : null}

          {messages.map((message) => (
            <div key={message.id} className="supervisor__message" data-role={message.role}>
              {message.role === 'agent' ? (
                <span className="supervisor__message-avatar">
                  <i className="ph ph-sparkle" aria-hidden="true" />
                </span>
              ) : null}
              <div className="supervisor__bubble">
                {message.streaming && !message.text ? (
                  <span className="supervisor__thinking">
                    正在想…
                    {waited >= 5 ? (
                      <span className="supervisor__waited">已等待 {waited} 秒</span>
                    ) : null}
                  </span>
                ) : (
                  message.text
                )}
              </div>
            </div>
          ))}

          {proposal ? (
            <section className="supervisor__proposal" aria-label="AI 提议的改动">
              <p className="supervisor__proposal-head">
                <i className="ph ph-git-diff" aria-hidden="true" />
                {proposal.summary}
              </p>
              <div className="ver__diff-body">
                <DiffLines diff={proposal.diff} empty="这组操作不会改变任何东西" />
              </div>
              <div className="supervisor__proposal-actions">
                <button type="button" className="runs__action" onClick={() => setProposal(null)}>
                  不用了
                </button>
                {/* 没有 onApply 就是没有草稿可落 —— 那时只显示 Diff 供参考 */}
                {onApply ? (
                  <button
                    type="button"
                    className="runs__action runs__action--primary"
                    onClick={() => {
                      onApply(proposal.operations);
                      setProposal(null);
                    }}
                  >
                    应用到草稿
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {error ? (
            <p className="runs__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="supervisor__scopes">
          <span>本次会话授予：</span>
          <code>workflow:read</code>
          <code>workflow:write-draft</code>
          <code>memory:read</code>
          <em>发布与运行未授权</em>
        </footer>

        <footer className="supervisor__foot">
          <textarea
            className="supervisor__input"
            aria-label="问主管 AI"
            placeholder="问它，或让它改这条工作流…"
            rows={2}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // ⏎ 发送、⇧⏎ 换行 —— 图纸底部标着那个 ⏎ 符号
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {/* 等待时给取消 —— 用户要能脱身。
              ACP 的超时是 180 秒，干等三分钟没有出口是不可接受的 */}
          {busy ? (
            <button
              type="button"
              className="runs__action"
              onClick={() => {
                // 号码一变，回来的答案就会被丢掉
                askSeq.current += 1;
                setBusy(false);
                setMessages((prev) => prev.filter((message) => !message.streaming));
              }}
            >
              取消
            </button>
          ) : (
            <button
              type="button"
              className="runs__action runs__action--primary"
              disabled={!draft.trim()}
              onClick={() => void send()}
            >
              发送
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

/** 历史列表里的时间。今天的只给时分，更早的带上日期。 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const today = new Date().toDateString() === at.toDateString();
  return at.toLocaleString('zh-CN', {
    hour12: false,
    ...(today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' }),
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
