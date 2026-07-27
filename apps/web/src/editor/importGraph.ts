import { WorkflowGraphSchema, validateGraph, type WorkflowGraph } from './editorDeps.js';

/**
 * 导入工作流图。
 *
 * 导出物就是图本身，所以导入 = 解析 + 按 Schema 校验 + 跑一遍图校验。
 * 三道都过了才交给调用方——**导入一份坏图比导入失败更糟**：
 * 坏图会先覆盖掉当前草稿，然后在画布上以各种奇怪的方式表现出来。
 */

export interface ImportResult {
  ok: boolean;
  graph?: WorkflowGraph;
  /** 失败原因，直接展示给用户。 */
  error?: string;
  /** 图校验的警告（不阻塞导入，但要让用户知道）。 */
  warnings?: string[];
}

export function parseGraphFile(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = WorkflowGraphSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('；');
    return { ok: false, error: `不是有效的工作流图 —— ${detail}` };
  }

  const graph = parsed.data as WorkflowGraph;
  const validation = validateGraph(graph);
  const errors = validation.issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    return {
      ok: false,
      error: `图存在 ${errors.length} 个错误，无法导入：${errors
        .slice(0, 3)
        .map((i) => i.message)
        .join('；')}`,
    };
  }

  const warnings = validation.issues.filter((i) => i.level === 'warning').map((i) => i.message);
  return { ok: true, graph, ...(warnings.length > 0 ? { warnings } : {}) };
}
