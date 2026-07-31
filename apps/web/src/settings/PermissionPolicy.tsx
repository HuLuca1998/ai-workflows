import { useEffect, useState } from 'react';
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, migrateApprovalMode } from '@aiwf/contracts';
import { coreClient } from '../data/workspace.js';

/**
 * 审批三档 —— 用户选的是**谁来批**，不是「哪一类操作要批」。
 *
 * 这三档**引擎真的按它办事**（`crates/engine/src/risk.rs`）：
 * 风险由这一步会造成什么决定，不由节点属于哪种类型决定。
 * 界面能选而引擎不拦的话，那是假的安全感 —— 比没有更糟。
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
        判断的是**这一步会造成什么**，不是它属于哪种节点：一条只读的{' '}
        <code>gh issue view</code> 三档都不拦，而一条 <code>git push</code> 只有在「无人值守」下
        才不问你。脚本节点按内容判定，判不出来时按「会改工作区」算 —— 多问一次是麻烦，不问是把边界让出去了。
      </p>
      <p className="permission__note">
        静态判断看不出 <code>CMD=&quot;git push&quot;; $CMD</code> 这类写法。
        「AI 审批」两档下 AI 拿到的是脚本原文，它认得出；要逐字精确的控制就选第一档。
      </p>
    </section>
  );
}
