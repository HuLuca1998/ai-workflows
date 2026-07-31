import { useState } from 'react';
import { ASK_KINDS, type AskSpec } from '@aiwf/contracts';

/**
 * Agent 向用户提的一个问题。
 *
 * 与「确认一次写操作」共用同一条队列（机制一样：TTL、过期、轮询），
 * 但渲染成不同的形态：确认给的是批准/拒绝，提问给的是选项或输入框。
 *
 * **组件目录是白名单。** agent 只能从 `ASK_KINDS` 里挑一个、填数据，
 * 碰不到布局也发明不了新组件。市面上还有两种更松的做法
 * （agent 返回 UI spec、agent 返回 HTML），这里都不用 ——
 * 那等于把渲染通道接到它的权限面上，而这个 agent 连着系统 MCP、
 * 读得到工作流、改得动草稿。
 *
 * 认不出的 `kind` **降级成原文**而不是吞掉：agent 那边还挂着等回答，
 * 界面上什么都不显示的话，用户连「它在问什么」都不知道。
 */

export interface AskCardProps {
  spec: AskSpec;
  /** 原始 JSON。认不出 kind 时摊开给用户看。 */
  raw: string;
  busy: boolean;
  onAnswer: (answer: {
    selected?: string;
    selectedMany: string[];
    fields: Record<string, string>;
  }) => void;
  onDecline: () => void;
}

export function AskCard({ spec, raw, busy, onAnswer, onDecline }: AskCardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>(spec.defaults ?? []);
  const [fields, setFields] = useState<Record<string, string>>({});

  const known = (ASK_KINDS as readonly string[]).includes(spec.kind);

  /*
   * 能不能提交。
   *
   * 单选没选、必填没填时**拦住** —— 一个空答案会被 agent 当成
   * 「用户没意见」，而那与「用户还没回答」是两件事。
   *
   * 多选一个都不选**允许**：「一个都不修」是有意义的回答。
   */
  const ready =
    spec.kind === 'choice'
      ? selected !== null
      : spec.kind === 'form'
        ? spec.fields.every((field) => !field.required || (fields[field.name] ?? '').trim() !== '')
        : true;

  const submit = () =>
    onAnswer({
      ...(selected !== null ? { selected } : {}),
      selectedMany: spec.kind === 'multiChoice' ? checked : [],
      fields: spec.kind === 'form' ? fields : {},
    });

  return (
    <>
      <p className="mcp-confirm__head">
        <i className="ph-fill ph-question" aria-hidden="true" />
        <span>{spec.title}</span>
      </p>

      {spec.detail ? <p className="mcp-confirm__note">{spec.detail}</p> : null}

      {!known ? (
        <>
          {/* 目录之外的东西。摊开原文 —— 用户至少要知道 agent 问了什么，
              而「不回答」这条路始终可用 */}
          <p className="mcp-confirm__note">
            这个提问用了界面还不认识的形态（<code>{spec.kind}</code>）。原文如下：
          </p>
          <pre className="mcp-confirm__input">{raw}</pre>
        </>
      ) : null}

      {known && spec.kind === 'choice' ? (
        <div className="ask__options" role="radiogroup" aria-label={spec.title}>
          {spec.options.map((option) => (
            <label key={option.value} className="ask__option">
              <input
                type="radio"
                name="ask-choice"
                value={option.value}
                checked={selected === option.value}
                onChange={() => setSelected(option.value)}
              />
              <span className="ask__option-body">
                <span className="ask__option-label">{option.label}</span>
                {option.description ? (
                  <span className="ask__option-desc">{option.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {known && spec.kind === 'multiChoice' ? (
        <div className="ask__options" role="group" aria-label={spec.title}>
          {spec.options.map((option) => (
            <label key={option.value} className="ask__option">
              <input
                type="checkbox"
                value={option.value}
                checked={checked.includes(option.value)}
                onChange={(event) =>
                  setChecked((now) =>
                    event.target.checked
                      ? [...now, option.value]
                      : now.filter((value) => value !== option.value),
                  )
                }
              />
              <span className="ask__option-body">
                <span className="ask__option-label">{option.label}</span>
                {option.description ? (
                  <span className="ask__option-desc">{option.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {known && spec.kind === 'form' ? (
        <div className="ask__fields">
          {spec.fields.map((field) => (
            <label key={field.name} className="ask__field">
              <span className="ask__field-label">
                {field.label}
                {field.required ? <span aria-hidden="true"> *</span> : null}
              </span>
              {field.multiline ? (
                <textarea
                  rows={3}
                  placeholder={field.placeholder}
                  value={fields[field.name] ?? ''}
                  onChange={(event) =>
                    setFields((now) => ({ ...now, [field.name]: event.target.value }))
                  }
                />
              ) : (
                <input
                  type="text"
                  placeholder={field.placeholder}
                  value={fields[field.name] ?? ''}
                  onChange={(event) =>
                    setFields((now) => ({ ...now, [field.name]: event.target.value }))
                  }
                />
              )}
            </label>
          ))}
        </div>
      ) : null}

      <div className="mcp-confirm__actions">
        {/* 「不回答」而不是「拒绝」：用户拒绝的是这次提问，不是某个写操作。
            走的是同一条 decideConfirm(false) —— agent 拿到「被拒绝」，
            而不是一个空答案（空答案会被它当成「什么都没选」） */}
        <button type="button" className="runs__action" disabled={busy} onClick={onDecline}>
          不回答
        </button>
        <button
          type="button"
          className="runs__action runs__action--primary"
          disabled={busy || !known || !ready}
          onClick={submit}
        >
          提交
        </button>
      </div>
    </>
  );
}
