import { z } from 'zod';
import type { CoreApiClient } from '@aiwf/client-core';
import {
  CoreApiError,
  MCP_FIRST_RELEASE_TOOLS,
  getMethodSpec,
  type CoreApiMethod,
  type Scope,
} from '@aiwf/contracts';

/**
 * MCP 工具层。
 *
 * 它**只是** Core API 面向 Agent 的适配层：工具清单由契约派生、调用一律经
 * CoreApiClient。没有直连数据库或文件的路径——那会绕过版本守卫与审计，
 * AI 一旦写坏就无法解释和回滚（技术选型 §6）。
 */

export type McpToolName = (typeof MCP_FIRST_RELEASE_TOOLS)[number];

export interface McpTool {
  name: McpToolName;
  description: string;
  inputSchema: unknown;
  scope: Scope;
  mutates: boolean;
}

/** 工具清单：契约怎么写，这里就是什么，不手工维护第二份。 */
export function listMcpTools(): McpTool[] {
  return MCP_FIRST_RELEASE_TOOLS.map((name) => {
    const spec = getMethodSpec(name);
    if (spec.scope === null) {
      throw new Error(`${name} 是本地专属方法，不该出现在 MCP 清单里`);
    }
    return {
      name,
      description: spec.summary,
      inputSchema: z.toJSONSchema(spec.input, {
        target: 'draft-2020-12',
        io: 'input',
        unrepresentable: 'any',
      }),
      scope: spec.scope,
      mutates: spec.mutates,
    };
  });
}

export interface McpToolRegistryOptions {
  /**
   * 写操作前的确认回调。产品原则「AI 建议 ≠ 执行」：
   * 修改草稿要先展示 Diff 并确认，发布、运行、删除、扩权需单独授权。
   */
  confirmWrite?: (tool: McpTool, input: unknown) => Promise<boolean>;
}

export class McpToolRegistry {
  private readonly client: CoreApiClient;
  private readonly options: McpToolRegistryOptions;
  private readonly tools = new Map<string, McpTool>();

  constructor(client: CoreApiClient, options: McpToolRegistryOptions = {}) {
    this.client = client;
    this.options = options;
    for (const tool of listMcpTools()) this.tools.set(tool.name, tool);
  }

  list(): McpTool[] {
    return [...this.tools.values()];
  }

  async call(name: McpToolName, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new CoreApiError({
        code: 'PERMISSION',
        message: `工具 ${name} 未暴露给 MCP`,
        hint: '首版只开只读 + create + patch + validate + 记忆 CRUD；发布与运行稍后开放',
      });
    }

    if (tool.mutates && this.options.confirmWrite) {
      const approved = await this.options.confirmWrite(tool, input);
      if (!approved) {
        throw new CoreApiError({
          code: 'PERMISSION',
          message: `${name} 的改动未确认`,
          hint: '在应用内查看 Diff 后确认，或让 Agent 重新提议',
        });
      }
    }

    return this.client.call(tool.name as CoreApiMethod, input);
  }
}
