/**
 * 能力探针：接新环境/新版本后先跑这个复验，再写业务代码。
 *
 *   npx tsx probe.ts all --agent claude
 *   npx tsx probe.ts session-load --agent codex
 *
 * 场景：handshake（握手与能力）· auth（无头认证）· session-load（恢复保真度）
 *      · permission（权限路由）· fs（文件代理路径）· usage（token 数据粒度）
 *
 * 注意：session-load / permission / fs / usage 会产生**真实模型调用**。
 * "负面结果"（能力缺失）同样是有效数据——02-runtime-findings 里最有价值的几条
 * 结论都来自负面结果。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpAgentHandle, allowPolicy, rejectPolicy, type SessionNotification } from "./handle.js";
import { ACP_RUNTIME_REGISTRY, resolveRuntimeCommand } from "./registry.js";

const HANDSHAKE_MS = 60_000;
const PROMPT_MS = 240_000;
const MARKER = "ACP_PROBE_OK_7391";

const agentArgIdx = process.argv.indexOf("--agent");
const which = agentArgIdx > 0 ? process.argv[agentArgIdx + 1] : "claude";
const scenario = process.argv[2] ?? "handshake";
const entry = ACP_RUNTIME_REGISTRY[which === "codex" ? "codex" : "claude-code"]!;
const workDir = mkdtempSync(path.join(tmpdir(), "acp-probe-"));

function makeHandle(extra: Partial<ConstructorParameters<typeof AcpAgentHandle>[0]> = {}) {
  const { command, args } = resolveRuntimeCommand(entry);
  return new AcpAgentHandle({ command, args, envRemove: entry.envRemove ?? [], ...extra });
}

function withTimeout<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}
const serializeErr = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

function chunkText(updates: readonly SessionNotification[], type: "agent_message_chunk" | "user_message_chunk") {
  let text = "";
  for (const { update } of updates) {
    if (update.sessionUpdate === type && update.content.type === "text") text += update.content.text;
  }
  return text;
}

/** 递归找任何形如 usage/token/cost 的字段——用来判定预算能否精确执法。 */
function findUsageLike(value: unknown, pathStr = "$", hits: string[] = []): string[] {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/usage|token|cost|credit/i.test(k)) hits.push(`${pathStr}.${k} = ${JSON.stringify(v)?.slice(0, 80)}`);
      findUsageLike(v, `${pathStr}.${k}`, hits);
    }
  }
  return hits;
}

const scenarios: Record<string, () => Promise<Record<string, unknown>>> = {
  /** 握手：协议版本、agentCapabilities（含 loadSession）、authMethods。 */
  async handshake() {
    const h = makeHandle();
    try {
      const init = await withTimeout("initialize", HANDSHAKE_MS, h.initialize());
      return {
        protocolVersion: init.protocolVersion,
        loadSessionCapability: init.agentCapabilities?.loadSession ?? false,
        promptCapabilities: init.agentCapabilities?.promptCapabilities ?? null,
        authMethods: init.authMethods ?? [],
      };
    } finally {
      await h.close();
    }
  },

  /** 无头认证：能否直接 newSession（复用本机登录态）；顺带看 session modes。 */
  async auth() {
    const h = makeHandle();
    try {
      const init = await withTimeout("initialize", HANDSHAKE_MS, h.initialize());
      try {
        const s = await withTimeout("newSession", HANDSHAKE_MS, h.newSession(workDir));
        // modes 里就是 claude 的 permission mode / codex 的 sandbox 档位
        return { headlessSessionOk: true, sessionId: s.sessionId, modes: s.modes ?? null };
      } catch (err) {
        return {
          headlessSessionOk: false,
          newSessionError: serializeErr(err),
          availableAuthMethods: init.authMethods?.map((m) => m.id) ?? [],
          stderrTail: h.stderrTail(600),
        };
      }
    } finally {
      await h.close();
    }
  },

  /** 恢复保真度：建会话 → 留标记 → 杀进程 → 新进程 load → 验历史与上下文延续。 */
  async ["session-load"]() {
    const h1 = makeHandle({ permissionPolicy: rejectPolicy });
    let sessionId: string;
    let firstReply = "";
    try {
      const init = await withTimeout("initialize#1", HANDSHAKE_MS, h1.initialize());
      if (!init.agentCapabilities?.loadSession) {
        return { loadSessionCapability: false, verdict: "不支持：恢复必须新建会话 + 重建 prompt" };
      }
      const s = await withTimeout("newSession", HANDSHAKE_MS, h1.newSession(workDir));
      sessionId = s.sessionId;
      await withTimeout("prompt#1", PROMPT_MS,
        h1.prompt(sessionId, `Reply with exactly this marker and nothing else, without using any tools: ${MARKER}`));
      firstReply = chunkText(h1.updates, "agent_message_chunk");
    } finally {
      await h1.close(); // 模拟崩溃：直接杀进程
    }

    const h2 = makeHandle({ permissionPolicy: rejectPolicy });
    try {
      await withTimeout("initialize#2", HANDSHAKE_MS, h2.initialize());
      let loadOk = false;
      let loadError: string | undefined;
      try {
        await withTimeout("loadSession", PROMPT_MS, h2.loadSession(sessionId!, workDir));
        loadOk = true;
      } catch (err) {
        loadError = serializeErr(err);
      }
      let continuity = "";
      if (loadOk) {
        const before = h2.updates.length;
        await withTimeout("prompt#2", PROMPT_MS,
          h2.prompt(sessionId!, "Without using any tools, repeat the exact marker string from your previous reply."));
        continuity = chunkText(h2.updates.slice(before), "agent_message_chunk");
      }
      return {
        loadSessionCapability: true,
        firstReplyHasMarker: firstReply.includes(MARKER),
        loadOk,
        ...(loadError ? { loadError } : {}),
        replayedUpdateCount: h2.updates.length,
        replayUserHasMarker: chunkText(h2.updates, "user_message_chunk").includes(MARKER),
        replayAgentHasMarker: chunkText(h2.updates, "agent_message_chunk").includes(MARKER),
        continuityAfterReload: continuity.includes(MARKER),
      };
    } finally {
      await h2.close();
    }
  },

  /** 权限路由：诱发文件写入，看 request_permission 何时触发、reject 是否真生效。 */
  async permission() {
    const h = makeHandle({ permissionPolicy: rejectPolicy });
    try {
      await withTimeout("initialize", HANDSHAKE_MS, h.initialize());
      const s = await withTimeout("newSession", HANDSHAKE_MS, h.newSession(workDir));
      const resp = await withTimeout("prompt", PROMPT_MS,
        h.prompt(s.sessionId, "Create a file named probe-permission.txt containing the word hello in the current directory."));
      return {
        stopReason: resp.stopReason,
        permissionRequestCount: h.permissionRequests.length,
        requests: h.permissionRequests.map((r) => ({
          toolTitle: (r.toolCall as { title?: string }).title ?? null,
          toolKind: (r.toolCall as { kind?: string }).kind ?? null,
          options: r.options.map((o) => ({ kind: o.kind, name: o.name })),
        })),
        // 关键断言：拒绝后文件不该存在
        fileCreatedDespiteReject: existsSync(path.join(workDir, "probe-permission.txt")),
      };
    } finally {
      await h.close();
    }
  },

  /** fs 代理路径：写文件走 client fs 代理还是 agent 自带 shell？（两个 runtime 不同！） */
  async fs() {
    const h = makeHandle({
      permissionPolicy: allowPolicy,
      serveFs: {
        async readTextFile(req) { return readFileSync(req.path, "utf8"); },
        async writeTextFile(req) { writeFileSync(req.path, req.content); },
      },
    });
    try {
      await withTimeout("initialize", HANDSHAKE_MS, h.initialize());
      const s = await withTimeout("newSession", HANDSHAKE_MS, h.newSession(workDir));
      const target = path.join(workDir, "probe-fs.txt");
      const resp = await withTimeout("prompt", PROMPT_MS,
        h.prompt(s.sessionId, `Create a file at ${target} containing exactly: fs-proxy-check`));
      const writes = h.fsCalls.filter((c) => c.method === "write");
      const fileExists = existsSync(target);
      return {
        stopReason: resp.stopReason,
        clientFsWriteCalls: writes.length,
        fileExists,
        // route=agent-own-tools 意味着你的 path guard 对这个 runtime 无效
        route: writes.length > 0 ? "client-fs" : fileExists ? "agent-own-tools" : "none",
      };
    } finally {
      await h.close();
    }
  },

  /** usage 粒度：流里有没有任何 token 计量数据（实测两者都没有）。 */
  async usage() {
    const h = makeHandle({ permissionPolicy: rejectPolicy });
    try {
      await withTimeout("initialize", HANDSHAKE_MS, h.initialize());
      const s = await withTimeout("newSession", HANDSHAKE_MS, h.newSession(workDir));
      const resp = await withTimeout("prompt", PROMPT_MS,
        h.prompt(s.sessionId, "Without using any tools, reply with the single word: pong"));
      const hits = [...findUsageLike(h.updates, "$updates"), ...findUsageLike(resp, "$promptResponse")];
      return {
        stopReason: resp.stopReason,
        updateCount: h.updates.length,
        usageLikeFields: hits.slice(0, 20),
        verdict: hits.length > 0 ? "有 usage 数据，可做 token 预算" : "无 usage 数据：预算只能用 turn 数 + 墙钟",
      };
    } finally {
      await h.close();
    }
  },
};

const names = scenario === "all" ? Object.keys(scenarios) : [scenario];
for (const name of names) {
  const fn = scenarios[name];
  if (!fn) {
    console.error(`未知场景 ${name}；可用：${Object.keys(scenarios).join(" / ")} / all`);
    process.exit(1);
  }
  console.log(`\n━━━ ${name} @ ${entry.id} ━━━`);
  try {
    console.log(JSON.stringify(await fn(), null, 2));
  } catch (err) {
    console.error(`✗ ${name} 失败：`, serializeErr(err));
  }
}
