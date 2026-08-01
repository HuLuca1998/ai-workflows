import { ISSUE_FIX } from './github-issue-fix.js';
import type { WorkflowTemplate } from './shared.js';

export type { WorkflowTemplate } from './shared.js';

/**
 * 内置模板清单。首页空态按这个顺序列出来。
 *
 * 每一条都由 `tests/templates.test.ts` 守着：能被 applyPatch 完整搭出、
 * 校验零 error、每个输出端口都有下游、互斥入边显式声明汇聚策略。
 * **只用引擎真跑得了的节点类型** —— 模板是用户的第一印象，
 * 里面出现一个「尚未实现」的节点，第一次运行就会停在那儿。
 */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [ISSUE_FIX];

export function templateById(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
