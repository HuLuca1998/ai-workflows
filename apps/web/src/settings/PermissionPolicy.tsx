import { useEffect, useState } from 'react';
import type { PERMISSION_PRESETS } from '@aiwf/contracts';
import { coreClient } from '../data/workspace.js';

/**
 * 权限策略三档 —— 严格照图纸「05 设置与环境」的三张并排卡。
 *
 * 这三档**引擎真的按它办事**：`review_every_change` 下有副作用的节点
 * （脚本、worktree、commit、PR、MCP 工具）会先挂起等审批。
 * 界面能选而引擎不拦的话，那是假的安全感 —— 比没有更糟。
 */

/** 文案一字不差照图纸。 */
const CARDS: { id: (typeof PERMISSION_PRESETS)[number]; name: string; detail: string }[] = [
  {
    id: 'review_every_change',
    name: 'Review Every Change',
    detail: '文件写入、命令与外部写操作逐项审批。适合陌生工作流。',
  },
  {
    id: 'workspace_safe',
    name: 'Workspace Safe',
    detail: '授权目录内可读写与执行已声明命令；Push、PR、删除仍需审批。',
  },
  {
    id: 'trusted_workflow',
    name: 'Trusted Workflow',
    detail: '对指定已发布版本沿用保存策略；权限扩大后自动失效。',
  },
];

export function PermissionPolicy() {
  // 没读到之前按最严的显示 —— 引擎也是这么办的
  const [preset, setPreset] = useState<string>('review_every_change');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    coreClient
      .call('workspace.settings', {})
      .then((result) => {
        const current = (result as { permissionPreset?: string }).permissionPreset;
        if (!cancelled && current) setPreset(current);
      })
      .catch(() => {
        // 读不到就按最严的显示，不报错 —— 那与引擎的默认一致
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (next: string) => {
    if (next === preset) return;
    setError(null);
    const previous = preset;
    setPreset(next);
    try {
      await coreClient.call('workspace.updateSettings', { permissionPreset: next });
    } catch (err) {
      // 写失败就退回去：留一个假的选中态，用户会以为已经改了
      setPreset(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="permission">
      <h5 className="permission__title">权限策略</h5>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="permission__cards" role="radiogroup" aria-label="权限策略">
        {CARDS.map((card) => (
          <label key={card.id} className="permission__card" data-active={preset === card.id}>
            <input
              type="radio"
              name="permission-preset"
              className="sr-only"
              checked={preset === card.id}
              onChange={() => void choose(card.id)}
            />
            <span className="permission__card-name">
              {preset === card.id ? (
                <i className="ph-fill ph-radio-button" aria-hidden="true" />
              ) : null}
              {card.name}
            </span>
            <span className="permission__card-detail">{card.detail}</span>
          </label>
        ))}
      </div>

      {/* 说清对运行的实际影响：不说的话用户不知道选了会怎样。
          这里点名的每一类都必须真的会挂起 —— 原来写的是
          「脚本、worktree、commit、PR 与 MCP 工具节点」，
          而 commit 与 PR **在契约里根本不是节点类型**，
          真正会挂起的那个（AI 执行）反倒没提。
          承诺得比实际多，比不承诺更糟 */}
      <p className="permission__note">
        选「Review Every Change」时，脚本、AI 执行、worktree 与 MCP 工具节点
        会在执行前挂起等你审批；批准过的节点恢复运行时不再重复询问。
      </p>
    </section>
  );
}
