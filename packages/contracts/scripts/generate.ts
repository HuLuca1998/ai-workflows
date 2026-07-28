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
