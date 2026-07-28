/**
 * 把契约导出为 JSON Schema，供不吃 TypeScript 的消费方使用：
 * Rust 引擎的配置校验、MCP Server 的工具入参声明、文档站。
 *
 * 用法：
 *   pnpm gen         写入 generated/
 *   pnpm gen:check   只比对，不写入；不一致时退出码 1（CI 门禁）
 *
 * 单一真源原则：手改 generated/ 下的文件一定会被 CI 打回。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CORE_API_METHODS, getMethodSpec } from '../src/api.js';
import { CONFORMANCE_CASES, DIFF_CASES } from '../src/conformance.js';
import { diffGraphs } from '../src/diff.js';
import { CoreApiError } from '../src/errors.js';
import { validateGraph } from '../src/graph.js';
import { applyPatch } from '../src/patch.js';
import { RunEventSchema, RUN_EVENT_TYPES, RUN_EVENT_CATEGORIES } from '../src/events.js';
import { WorkflowGraphSchema } from '../src/graph.js';
import { NODE_TYPES, getNodeDefinition } from '../src/nodes/index.js';
import { PATCH_OPS } from '../src/patch.js';
import { CONTRACTS_VERSION } from '../src/index.js';
import { RUN_STATUSES, NODE_STATUSES } from '../src/state-machine.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'generated');
const checkOnly = process.argv.includes('--check');

const toSchema = (schema: z.ZodType): unknown =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });

const files: Record<string, unknown> = {
  'contracts.meta.json': {
    version: CONTRACTS_VERSION,
    eventCategories: RUN_EVENT_CATEGORIES,
    eventTypes: RUN_EVENT_TYPES,
    nodeTypes: NODE_TYPES,
    // 状态机也进生成物：Rust 侧的镜像要能**读着契约比**，
    // 而不是跟测试文件里硬编码的字面量比 —— 那种守卫加第 12 个状态
    // 照样绿，漂移完整出厂
    runStatuses: RUN_STATUSES,
    nodeStatuses: NODE_STATUSES,
    patchOps: PATCH_OPS,
    methods: CORE_API_METHODS,
  },
  'run-event.schema.json': toSchema(RunEventSchema),
  'workflow-graph.schema.json': toSchema(WorkflowGraphSchema),
  'node-configs.schema.json': Object.fromEntries(
    NODE_TYPES.map((type) => [type, toSchema(getNodeDefinition(type).configSchema)]),
  ),
  /**
   * 节点目录：配置 Schema 之外的那一半。
   *
   * 端口、能力、externalWrite、seed —— 这些只活在 `definitions.ts` 的
   * TypeScript 对象里，而 Rust 侧要校验一张图的连线、要按类型申请能力，
   * 全靠它们。少了这份生成物，`workflow.patch` / `workflow.validate`
   * 就只能是 TypeScript 独有的能力，通过 MCP 连进来的 Agent 改不动工作流。
   */
  'node-catalog.json': Object.fromEntries(
    NODE_TYPES.map((type) => {
      const def = getNodeDefinition(type);
      return [
        type,
        {
          title: def.title,
          group: def.group,
          summary: def.summary,
          icon: def.icon,
          ports: def.ports,
          // 缺席的字段显式写成 false / null：Rust 侧按固定形状反序列化，
          // 「有时有有时没有」会逼它把每个字段都做成 Option
          dynamicOutputs: def.dynamicOutputs ?? null,
          defaultCapabilities: def.defaultCapabilities,
          externalWrite: def.externalWrite,
          singleton: def.singleton ?? false,
          seed: def.seed ?? null,
        },
      ];
    }),
  ),
  /**
   * 跨语言一致性夹具：输入在 `src/conformance.ts`，期望输出在这里算出来。
   *
   * Rust 侧读同一份文件逐条比对（`crates/engine/tests/conformance_test.rs`）。
   * 两份实现里任何一份改了行为，这份生成物或那条测试就会红 ——
   * 而不是等到用户对着「界面说行、MCP 说不行」不知道信谁。
   */
  'conformance.json': {
    version: CONTRACTS_VERSION,
    cases: CONFORMANCE_CASES.map((item) => {
      const validation = validateGraph(item.graph);
      if (!item.patch) return { name: item.name, graph: item.graph, validation };

      const currentRevision = item.currentRevision ?? item.patch.baseRevision;
      const 公共 = {
        name: item.name,
        graph: item.graph,
        patch: item.patch,
        currentRevision,
      };

      try {
        const result = applyPatch(item.graph, currentRevision, item.patch);
        return { ...公共, result: { ok: true, ...result } };
      } catch (error) {
        // 失败也是行为的一部分：错误码与文案同样要两边一致，
        // 用户看到的那句话不该取决于他走的是界面还是 MCP
        if (!(error instanceof CoreApiError)) throw error;
        return {
          ...公共,
          result: { ok: false, error: { code: error.code, message: error.message } },
        };
      }
    }),
    diffs: DIFF_CASES.map((item) => ({
      name: item.name,
      before: item.before,
      after: item.after,
      diff: diffGraphs(item.before, item.after),
    })),
  },
  'core-api.schema.json': Object.fromEntries(
    CORE_API_METHODS.map((method) => {
      const spec = getMethodSpec(method);
      return [
        method,
        {
          summary: spec.summary,
          scope: spec.scope,
          mutates: spec.mutates,
          audited: spec.audited,
          input: toSchema(spec.input),
          output: toSchema(spec.output),
        },
      ];
    }),
  ),
};

mkdirSync(outDir, { recursive: true });

let drifted = 0;
for (const [name, content] of Object.entries(files)) {
  const path = join(outDir, name);
  const next = `${JSON.stringify(content, null, 2)}\n`;
  /**
   * 两份文本的第一处差异，带行号与上下文。
   *
   * 生成物是格式化过的 JSON，逐行比就够用 —— 不用引入 diff 库。
   */
  function firstDifference(current: string, next: string): string | null {
    const a = current.split('\n');
    const b = next.split('\n');
    const max = Math.max(a.length, b.length);

    for (let i = 0; i < max; i += 1) {
      if (a[i] === b[i]) continue;
      const 行号 = i + 1;
      const 现有 = a[i] === undefined ? '（文件到此结束）' : a[i]!.trim();
      const 应为 = b[i] === undefined ? '（应到此结束）' : b[i]!.trim();
      return `第 ${行号} 行：\n    生成物：${现有}\n    契约源：${应为}`;
    }
    return null;
  }

  if (checkOnly) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    if (current !== next) {
      drifted += 1;
      console.error(`✗ ${name} 与契约源不一致，请跑 pnpm contracts:gen 后提交`);
      // 指出第一处差异。只说「不一致」的话，要在 9000 行 JSON 里
      // 自己找 —— 而 CI 上连文件都拿不到
      const 差异 = firstDifference(current, next);
      if (差异) console.error(`  ${差异}`);
    }
  } else {
    writeFileSync(path, next);
    console.log(`✓ ${name}`);
  }
}

if (checkOnly) {
  if (drifted > 0) {
    console.error(`\n${drifted} 个生成物漂移。`);
    process.exit(1);
  }
  console.log('✓ 生成物与契约源一致');
}
