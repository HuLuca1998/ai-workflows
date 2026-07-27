import type { WorkflowDiff } from './editorDeps.js';

/**
 * Diff 的行渲染 —— 严格照图纸的版本抽屉：
 *
 * ```
 * + node  script.shell「运行 lint」
 * − edge  execute → run_lint → review
 * ~ node  decide：可自动决策层级 L1 → L1–L2
 * ```
 *
 * 版本对比与主管 AI 的提议用**同一套渲染**：两处都是「这些改动会让图变成什么样」，
 * 长得不一样的话用户得学两遍。
 *
 * 减号是 U+2212 而不是连字符 —— 与加号等宽，三种前缀才对得齐。
 */
export function DiffLines({ diff, empty }: { diff: WorkflowDiff; empty?: string }) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) {
    return <p className="ver__diff-line">{empty ?? '与这个版本完全一致'}</p>;
  }

  return (
    <>
      {diff.added.map((entry) => (
        <p key={`a-${entry.kind}-${entry.id}`} className="ver__diff-line ver__diff-line--added">
          + {entry.label}
        </p>
      ))}
      {diff.removed.map((entry) => (
        <p key={`r-${entry.kind}-${entry.id}`} className="ver__diff-line ver__diff-line--removed">
          − {entry.label}
        </p>
      ))}
      {diff.changed.map((entry) => (
        <p key={`c-${entry.kind}-${entry.id}`} className="ver__diff-line ver__diff-line--changed">
          ~ {entry.label}
        </p>
      ))}
    </>
  );
}
