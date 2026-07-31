/**
 * ACP session/update 通知 → 归一化 AgentEvent。
 *
 * 注意 rawInput / rawOutput 不在 SDK 的 TypeScript 类型里（协议扩展字段），
 * 需要 as unknown 绕过类型检查——但它们确实存在，且是工具调用参数/结果的唯一来源。
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "./types.js";

export function normalizeUpdate(n: SessionNotification): AgentEvent | null {
  const u = n.update;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return u.content.type === "text" ? { kind: "message-chunk", text: u.content.text } : null;

    case "agent_thought_chunk":
      return u.content.type === "text" ? { kind: "thought-chunk", text: u.content.text } : null;

    case "tool_call": {
      const ext = u as unknown as { rawInput?: unknown; kind?: string };
      return {
        kind: "tool-call",
        id: u.toolCallId,
        title: u.title,
        status: u.status ?? "pending",
        ...(ext.rawInput !== undefined ? { input: ext.rawInput } : {}),
        ...(ext.kind !== undefined ? { toolKind: ext.kind } : {}),
        raw: u,
      };
    }

    case "tool_call_update": {
      const ext = u as unknown as { rawInput?: unknown; rawOutput?: unknown; content?: unknown };
      return {
        kind: "tool-call",
        id: u.toolCallId,
        title: u.title ?? "",
        status: u.status ?? "in_progress",
        ...(ext.rawInput !== undefined ? { input: ext.rawInput } : {}),
        ...(ext.rawOutput !== undefined
          ? { output: ext.rawOutput }
          : ext.content !== undefined
            ? { output: ext.content }
            : {}),
        raw: u,
      };
    }

    case "plan":
      return { kind: "plan", raw: u };

    // user_message_chunk 只在 session/load 回放历史时出现；
    // 常规 turn 中不需要，恢复场景请单独处理。
    default:
      return null;
  }
}

/**
 * 从 agent 回复正文里提取结构化 JSON。
 * 取第一个 { 到最后一个 } 之间的内容——模型几乎总会在 JSON 前后带解释文字，
 * 全文 JSON.parse 基本必挂。见 03-pitfalls #3。
 */
export function extractJson(text: string): unknown | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** 从 markdown 代码块里提取内容（让 agent 产出 YAML/配置时用）。 */
export function extractBlock(text: string, lang = "ya?ml"): string | null {
  const m = text.match(new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```"));
  return m ? m[1]!.trim() : null;
}
