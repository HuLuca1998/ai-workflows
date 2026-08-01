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
  } catch {
    /*
     * **不带 V8 的原文。**
     *
     * `Unexpected token 'h', "this is not"... is not valid JSON` 对用户
     * 没有任何用处：他手上多半是个从别处拷来的文件，需要知道的是
     * 「该拿什么样的文件」而不是第几个字节出了问题
     * （第三方巡检 A-07：中文界面里夹着裸的英文校验器输出）。
     */
    return {
      ok: false,
      error: '这个文件不是 JSON。导入要的是从这个应用「导出」出来的工作流文件。',
    };
  }

  const parsed = WorkflowGraphSchema.safeParse(raw);
  if (!parsed.success) {
    // 同理：`nodes: Invalid input: expected array, received undefined`
    // 只说得出「哪个字段」，说不出「所以呢」。点名字段 + 一句人话
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '(根)')))]
      .slice(0, 3)
      .join('、');
    return {
      ok: false,
      error:
        `这是一个 JSON，但不是工作流图 —— ${fields} 这几处对不上。` +
        '要导入的是「导出此版本」产出的那个文件。',
    };
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
