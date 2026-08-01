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
import { baseRiskOf } from '../src/approval.js';
import { CONFORMANCE_CASES, DIFF_CASES } from '../src/conformance.js';
import { diffGraphs } from '../src/diff.js';
import { CoreApiError } from '../src/errors.js';
import { validateGraph } from '../src/graph.js';
import { applyPatch } from '../src/patch.js';
import { ASK_KINDS, AskSpecSchema } from '../src/domain.js';
import { PERMISSION_PRESETS } from '../src/capabilities.js';
import { RunEventSchema, RUN_EVENT_TYPES, RUN_EVENT_CATEGORIES } from '../src/events.js';
import { WorkflowGraphSchema } from '../src/graph.js';
import { IMPLEMENTED_NODE_TYPES, NODE_TYPES, getNodeDefinition } from '../src/nodes/index.js';
import { PATCH_OPS } from '../src/patch.js';
import { CONTRACTS_VERSION } from '../src/index.js';
import { RUN_STATUSES, NODE_STATUSES } from '../src/state-machine.js';
import { templateById } from '../src/templates/index.js';
import { TRIGGER_DESCRIPTION_CASES } from '../src/trigger.js';

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
    // 引擎真能跑的那几种。原来只有 Rust 侧一份常量，界面拿不到 ——
    // 于是节点库把 6 个跑不了的类型跟能跑的摆在一起，用户搭完
    // 整条流程点运行才知道（第三方巡检 B-06）
    implementedNodeTypes: IMPLEMENTED_NODE_TYPES,
    // 状态机也进生成物：Rust 侧的镜像要能**读着契约比**，
    // 而不是跟测试文件里硬编码的字面量比 —— 那种守卫加第 12 个状态
    // 照样绿，漂移完整出厂
    runStatuses: RUN_STATUSES,
    nodeStatuses: NODE_STATUSES,
    patchOps: PATCH_OPS,
    methods: CORE_API_METHODS,
    // 提问组件的白名单。`AskSpec.kind` 故意不用 enum（前向兼容），
    // 于是 schema 里查不到合法值 —— Rust 侧的守卫从这里读，
    // 保证工具描述与指南里列的 kind 不落后于契约
    askKinds: ASK_KINDS,
    // 权限档三档。改名(review_every_change→human_approval)那次,契约改了、
    // 前端改了,而 core-api 的校验常量没跟上 —— 全新用户在向导页
    // 100% 被挡(第 10 轮实测)。让 Rust 侧读这份,不再各写一份
    permissionPresets: PERMISSION_PRESETS,
    // 触发方式的措辞。画布、列表、Rust 侧的调度日志说的必须是
    // 同一句话 —— 否则用户在画布上看「每天 09:30」、在日志里看
    // 「daily at 9:30」，无从判断是不是同一件事
    triggerDescriptions: TRIGGER_DESCRIPTION_CASES,
  },
  /**
   * agent 提问的形状。MCP 的内建 `ask_user` 工具拿它当入参 schema ——
   * 不从这里拿就得手写第二份，而第二份会漂移。
   */
  'ask-spec.schema.json': toSchema(AskSpecSchema),
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
          /**
           * 审批判定的下限。引擎按脚本内容往上调，**不下调**。
           *
           * 走生成物而不是让 Rust 手抄一份表：抄的那份会与契约悄悄分叉，
           * 而分叉的症状是「设置里选的档位在引擎里是另一个含义」——
           * 没有任何东西会红
           */
          baseRisk: baseRiskOf(type),
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
  /**
   * 一键初始化种下的那条示例工作流，已经是**应用完模板操作之后的图**。
   *
   * 为什么算在这里而不是在存储层：模板是 `templates.ts` 里的
   * PatchOperation 数组，把它变成图要跑 applyPatch —— 而 Rust 那份
   * 住在 engine 里，engine 依赖 store，store 不能反过来依赖 engine。
   * 手抄一份图进种子 SQL 是另一条路，代价是它会与模板悄悄分叉：
   * 模板改了节点，示例还是老样子，而没有任何东西会红。
   *
   * 走生成物就没这个问题 —— `pnpm contracts:check` 守着它与模板一致，
   * 模板一改这份就得重新生成，否则 CI 打回。
   */
  'sample-workflow.json': (() => {
    const template = templateById('github-issue-fix');
    if (!template) throw new Error('内置模板 github-issue-fix 不见了 —— 示例工作流没法生成');
    return {
      name: template.name,
      summary: template.summary,
      // 与界面「从模板新建」走的是同一条路（workspace.ts 的 createWorkflow）：
      // 空图 + rev 0 起步，模板因此被同一套校验守住
      graph: applyPatch({ nodes: [], edges: [], groups: [] }, 0, {
        baseRevision: 0,
        operations: [...template.operations],
      }).graph,
    };
  })(),
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
