import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { z } from 'zod';
import { getMethodSpec } from '../src/api.js';
import type { CoreApiMethod } from '../src/api.js';

/**
 * 引擎的 DTO 与契约 output 之间的字段漂移。
 *
 * Zod 会**静默剥掉**未声明的字段 —— 引擎返回了、契约没声明，
 * 界面就拿到 undefined，而且没有任何一处报错。这类问题的症状离原因很远：
 *
 * - `WorkflowSummary` 少 `lastRun` → 每条工作流都显示成「草稿」
 * - `ArtifactDto` 少 `relPath` → 点「预览」报「run.artifactContent 的入参不合契约」
 *
 * 两次都是上线后靠人工试出来的。这条守卫扫 Rust 源码里的 DTO 字段，
 * 与契约 output 比对：引擎有而契约没有的字段，一个都不放过。
 *
 * 反过来（契约有而引擎没有）不在这里管 —— 那会让 Zod 校验直接失败，
 * 属于响亮的错误，不需要额外守卫。
 */

const 源码 = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/core-api/src/lib.rs'),
  'utf8',
);

/** DTO 与它所服务的契约方法。加新 DTO 时把映射补上，否则它没人守。 */
const 映射: { dto: string; method: CoreApiMethod; 字段路径?: string }[] = [
  { dto: 'ArtifactDto', method: 'run.artifacts', 字段路径: 'items' },
  { dto: 'ArtifactContentDto', method: 'run.artifactContent' },
  { dto: 'MemoryDto', method: 'memory.list', 字段路径: 'items' },
  { dto: 'PromptDto', method: 'prompt.list', 字段路径: 'items' },
  { dto: 'AgentDto', method: 'agent.list', 字段路径: 'items' },
  { dto: 'ModelDto', method: 'model.list', 字段路径: 'items' },
  { dto: 'RunEventDto', method: 'run.events', 字段路径: 'events' },
  { dto: 'SupervisorSessionDto', method: 'supervisor.sessions', 字段路径: 'items' },
  { dto: 'SupervisorMessageDto', method: 'supervisor.session', 字段路径: 'messages' },
  { dto: 'DryRunDto', method: 'run.dryRun' },
  { dto: 'WorkspaceStatsDto', method: 'workspace.stats' },
  { dto: 'WorkspaceSettingsDto', method: 'workspace.settings' },
  { dto: 'ConfirmationDto', method: 'mcp.pendingConfirms', 字段路径: 'items' },
  { dto: 'ConfirmStatusDto', method: 'mcp.confirmStatus' },
  { dto: 'ModelTestResult', method: 'model.test' },
  // sectionsJson / varsJson 在映射层解析成 sections / vars（引擎不理解它们的结构），
  // 字段名对不上是**有意**的，所以豁免而不是登记
];

/**
 * 从 Rust 源码里抠出一个结构体序列化后的键名。
 *
 * 三个 serde 属性会改变结果，都要认：
 * - `rename = "x"` —— 键名就是 x（RunEventDto 的 kind → type）
 * - `flatten` —— 那个字段不出现，它内部的键被摊到这一层
 * - `rename_all = "camelCase"` —— 结构体级，蛇形转驼峰
 */
function rust字段(结构体: string): string[] {
  const 开头 = 源码.indexOf(`pub struct ${结构体} {`);
  if (开头 < 0) throw new Error(`crates/core-api 里找不到 ${结构体}`);
  const 主体 = 源码.slice(开头, 源码.indexOf('\n}', 开头));

  const 键: string[] = [];
  let 待定重命名: string | null = null;

  for (const 行 of 主体.split('\n')) {
    const 属性 = 行.trim();
    if (属性.startsWith('#[serde(')) {
      if (/\bflatten\b/.test(属性)) {
        待定重命名 = '\u0000flatten';
        continue;
      }
      const 重命名 = /\brename\s*=\s*"([^"]+)"/.exec(属性);
      if (重命名) 待定重命名 = 重命名[1]!;
      continue;
    }

    const 字段 = /^(?:pub\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(属性);
    if (!字段) continue;

    if (待定重命名 === '\u0000flatten') {
      // 摊平的字段本身不成为键，它内部的键归属这一层 —— 由内部结构自己守
      待定重命名 = null;
      continue;
    }
    键.push(待定重命名 ?? 字段[1]!.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
    待定重命名 = null;
  }
  return 键;
}

/** 从契约 output 里取出字段名。字段路径指向数组元素时钻进去。 */
function 契约字段(method: CoreApiMethod, 字段路径?: string): string[] {
  let schema: z.ZodTypeAny = getMethodSpec(method).output;
  if (字段路径) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const 数组 = shape[字段路径];
    if (!数组) throw new Error(`${method} 的 output 里没有 ${字段路径}`);
    schema = (数组 as z.ZodArray<z.ZodTypeAny>).element;
  }
  // optional / default 包一层，剥到对象为止
  while ('unwrap' in schema && typeof schema.unwrap === 'function') {
    schema = (schema as unknown as { unwrap(): z.ZodTypeAny }).unwrap();
  }
  return Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
}

describe('引擎 DTO 与契约 output 不能漂移', () => {
  for (const { dto, method, 字段路径 } of 映射) {
    it(`${dto} 的每个字段在 ${method} 的契约里都声明了`, () => {
      const 引擎有 = rust字段(dto);
      const 契约有 = new Set(契约字段(method, 字段路径));
      const 漏掉的 = 引擎有.filter((名) => !契约有.has(名));

      expect(
        漏掉的,
        `${dto} 返回了这些字段但契约没声明，Zod 会静默剥掉：${漏掉的.join('、')}`,
      ).toEqual([]);
    });
  }

  it('映射表本身覆盖了源码里的 DTO —— 新加的不能漏', () => {
    const 源码里的 = [...源码.matchAll(/pub struct (\w+Dto) \{/g)].map((m) => m[1]!);
    const 已覆盖 = new Set(映射.map((e) => e.dto));
    // 有几个 DTO 是别的 DTO 的容器或嵌套片段，不直接对应一个方法
    const 豁免 = new Set([
      'ArtifactsDto',
      'LastRunDto',
      'VersionMetaDto',
      'PublishedDto',
      // 分段与变量以 JSON 字符串带回，映射层解析成数组 —— 字段名有意不同
      'PromptVersionDto',
      // 它只有 runId + nodeId，手写的 Serialize，没有 rename_all 可扫
      'RewindResult',
    ]);
    const 没人守的 = 源码里的.filter((名) => !已覆盖.has(名) && !豁免.has(名));

    expect(没人守的, `这些 DTO 没有对应的漂移守卫：${没人守的.join('、')}`).toEqual([]);
  });
});
