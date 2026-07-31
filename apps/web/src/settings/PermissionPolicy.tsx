import { useEffect, useState } from 'react';
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, migrateApprovalMode } from '@aiwf/contracts';
import { coreClient } from '../data/workspace.js';

/**
 * 审批三档 —— **谁来批工作流里的那些门**。
 *
 * 引擎真的按它办事（`crates/engine/src/risk.rs` 的 `approval_decider`）：
 * `approval` 节点走到时按这一档决定挂人工还是交给 AI。
 * 界面能选而引擎不认的话，那是假的安全感 —— 比没有更糟。
 *
 * 文案取自契约的 `APPROVAL_MODE_LABELS`，这里不再抄一份：
 * 设置页、引导页、运行页的审批卡片说的必须是同一件事，
 * 各写一份的时候同一个档位在三个地方承诺的东西会不一样。
 */

export function PermissionPolicy() {
  // 没读到之前按最严的显示 —— 引擎也是这么办的
  const [mode, setMode] = useState<string>('human_approval');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    coreClient
      .call('workspace.settings', {})
      .then((result) => {
        const current = (result as { permissionPreset?: string }).permissionPreset;
        // 库里可能躺着上一版的档位名。不迁移的话它落到「认不出」那一支，
        // 界面显示最严档而用户从没选过它
        if (!cancelled && current) setMode(migrateApprovalMode(current));
      })
      .catch(() => {
        // 读不到就按最严的显示，不报错 —— 那与引擎的默认一致
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (next: string) => {
    if (next === mode) return;
    setError(null);
    const previous = mode;
    setMode(next);
    try {
      await coreClient.call('workspace.updateSettings', { permissionPreset: next });
    } catch (err) {
      // 写失败就退回去：留一个假的选中态，用户会以为已经改了
      setMode(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="permission">
      <h5 className="permission__title">谁来审批</h5>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="permission__cards" role="radiogroup" aria-label="审批策略">
        {APPROVAL_MODES.map((id) => {
          const card = APPROVAL_MODE_LABELS[id];
          return (
            <label key={id} className="permission__card" data-active={mode === id}>
              <input
                type="radio"
                name="approval-mode"
                className="sr-only"
                checked={mode === id}
                onChange={() => void choose(id)}
              />
              <span className="permission__card-name">
                {mode === id ? <i className="ph-fill ph-radio-button" aria-hidden="true" /> : null}
                {card.name}
              </span>
              <span className="permission__card-detail">{card.detail}</span>
            </label>
          );
        })}
      </div>

      {/* 说清对运行的实际影响。这里点名的每一件事都必须真的成立 ——
          承诺得比实际多，比不承诺更糟 */}
      <p className="permission__note">
        <strong>这一档管的是「工作流里的那些门由谁批」，不是「哪些操作会被拦」。</strong>
        执行节点拿到的是最高权限；要不要停下来问，取决于工作流的作者有没有在那个位置放一个
        「审批」节点 —— 通常在「探索完成 → 开始改代码」之间、「代码写完 → 开 PR」之间各一道。
      </p>
      <p className="permission__note">
        推论要说清楚：<strong>一条没放审批节点的工作流会一路跑到底</strong>，包括推分支与建 PR。
        跑一条陌生的工作流之前，先在画布上看一眼它有几道门 —— 运行前的依赖检查也会列出来。
      </p>
      <p className="permission__note">
        交给 AI 批时，它拿到的是<strong>上游刚产出的东西</strong>（改了哪些文件、跑出什么结果），
        并要给出放行或拒绝的理由，全程留档。它判不了的时候一律交回给你 —— adapter
        连不上、超时、没给出明确决定，都算判不了。
      </p>
    </section>
  );
}
