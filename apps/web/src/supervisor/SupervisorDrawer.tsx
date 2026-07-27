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
    // 新消息进来时滚到底：对话是时间序的，用户要看最新那条。
    // 直接赋 scrollTop 而不是 scrollTo —— 后者在 jsdom 里没实现，
    // 测试会因为一个纯视觉的行为整片红掉
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [messages]);

  if (!open) return null;

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    setDraft('');
    setBusy(true);
    setError(null);
    setMessages((prev) => [
      ...prev,
      { id: `u_${Date.now()}`, role: 'user', text },
      { id: `a_${Date.now()}`, role: 'agent', text: '', streaming: true },
    ]);

    try {
      const result = (await coreClient.call('supervisor.ask', {
        question: text,
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
        proposal?: { summary: string; operations: PatchOperation[] };
      };

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
      // 失败时把那条空的 agent 消息去掉 —— 留一个空气泡比没有更糟
      setMessages((prev) => prev.filter((message) => !message.streaming));
      setError(describe(err));
    } finally {
      setBusy(false);
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

          <button type="button" className="supervisor__close" aria-label="关闭" onClick={onClose}>
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </header>

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
                  <span className="supervisor__thinking">正在想…</span>
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
          <button
            type="button"
            className="runs__action runs__action--primary"
            disabled={busy || !draft.trim()}
            onClick={() => void send()}
          >
            {busy ? '思考中' : '发送'}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
