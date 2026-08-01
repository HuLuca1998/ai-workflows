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

/**
 * 「把上一步的结论写成 report.json」这条指令，模板之间共用。
 *
 * 报告链路是这样接起来的，缺一环都会让抽屉空着：
 *
 * 1. 这个 `ai.execute` 节点（`workdirSource: 'inherit'`）把
 *    `report.json` 写进**运行目录**
 * 2. `end` 节点的 `artifacts: ['report.json']` 把它收进产物库
 *    （`crates/engine/src/executor.rs` 的 `collect_final_artifacts`）
 * 3. 界面按 `REPORT_ARTIFACT_NAME` 找那个产物，渲染成报告抽屉
 *
 * 组件白名单与字段含义在 `src/report.ts`，MCP 侧同一份说明挂在
 * `aiwf://guide/write-report` —— agent 连着系统 MCP，能自己读到。
 */
export const REPORT_INSTRUCTION = [
  '把上一步的结论写成一份结构化报告，存为工作目录根下的 `report.json`。',
  '',
  '格式：`{"schemaVer":1,"title":"…","summary":"…","outcome":"success|warning|failed","blocks":[…]}`',
  'blocks 每项的 kind 只能是这六种之一：',
  '  metrics  {"kind":"metrics","items":[{"label":"合并的 PR","value":"12","tone":"good|warn|bad"}]}',
  '  prose    {"kind":"prose","heading":"可选标题","text":"段落正文"}',
  '  table    {"kind":"table","columns":["列1","列2"],"rows":[["a","b"]]}',
  '  timeline {"kind":"timeline","items":[{"at":"2026-08-02T09:00:00Z","text":"发生了什么"}]}',
  '  code     {"kind":"code","language":"bash","text":"命令或日志片段"}',
  '  links    {"kind":"links","items":[{"label":"PR #12","href":"https://…"}]}',
  '',
  '三条硬要求：',
  '① href 只能是 http/https，别的会被整块丢掉',
  '② table 每一行的长度必须等于 columns 的长度',
  '③ **没有数据支撑的不要写**。这份报告会被当成事实读，',
  '   拿不准就写进 prose 说明「这一项没查到」，不要编一个数字',
  '',
  '详细说明也可以从系统 MCP 读：资源 `aiwf://guide/write-report`。',
  '写完确认文件真的存在且是合法 JSON —— 格式不对时界面只能显示原文。',
].join('\n');
