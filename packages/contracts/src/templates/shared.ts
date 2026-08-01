import type { PatchOperation } from '../patch.js';

/**
 * 内置模板的公共定义。
 *
 * 模板以**结构化操作**的形式给出，而不是一份现成的图：
 * 这样新建时走的是与手工搭建、与 AI 改图完全相同的路径（applyPatch），
 * 模板本身也就被同一套校验守住了。
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  summary: string;
  operations: PatchOperation[];
}

/** 内置角色。种子数据里有这四个，模板直接引用。 */
export const AGENT = {
  analyst: 'builtin:analyst',
  builder: 'builtin:builder',
  reviewer: 'builtin:reviewer',
  operator: 'builtin:operator',
} as const;
