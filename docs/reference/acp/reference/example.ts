/**
 * 最小可跑示例：起一个 agent、发一轮 prompt、把事件实时打到终端。
 *
 *   npx tsx example.ts claude "总结当前目录的代码结构"
 *   npx tsx example.ts codex  "列出这个目录里的文件"
 *
 * 前置：本机已登录（claude /login 或 codex login / 设 CODEX_API_KEY）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpAdapter, ACP_RUNTIME_REGISTRY, allowPolicy, extractJson } from "./index.js";

const which = process.argv[2] === "codex" ? "codex" : "claude-code";
const promptText = process.argv[3] ?? "用一句话介绍你自己，不要使用任何工具。";

const entry = ACP_RUNTIME_REGISTRY[which]!;
const adapter = new AcpAdapter(entry, {
  permissionPolicy: allowPolicy, // 真实任务必须 allow，否则拿不到素材，见 03-pitfalls #2
  promptTimeoutMs: 240_000,
});

// 用独立临时目录做 cwd，避免污染真实工程；生产环境应指向受控的工作区
const cwd = mkdtempSync(path.join(tmpdir(), "acp-example-"));

const { sessionId } = await adapter.createSession({ cwd });
console.log(`[会话] ${which} sessionId=${sessionId} cwd=${cwd}\n`);

let reply = "";
try {
  for await (const ev of adapter.runTurn(sessionId, { prompt: promptText })) {
    switch (ev.kind) {
      case "message-chunk":
        reply += ev.text;
        process.stdout.write(ev.text);
        break;
      case "thought-chunk":
        process.stdout.write(`\x1b[2m${ev.text}\x1b[0m`); // 思考灰显
        break;
      case "tool-call":
        console.log(`\n🔧 [${ev.status}] ${ev.title}`);
        break;
      case "permission-request":
        console.log(`\n🔐 权限请求：${JSON.stringify(ev.toolCall).slice(0, 120)}`);
        break;
      case "permission-decision":
        console.log(`   └ 裁决：${ev.outcome}${ev.optionId ? ` (${ev.optionId})` : ""}`);
        break;
      case "done":
        console.log(`\n\n[完成] stopReason=${ev.stopReason}`);
        // 新版 runtime 才有 usage/cost；旧版这两个字段是 undefined
        if (ev.usage) console.log(`[用量] ${JSON.stringify(ev.usage)}`);
        if (ev.cost) console.log(`[成本] ${ev.cost.amount} ${ev.cost.currency}`);
        break;
      case "error":
        console.error(`\n[错误] ${ev.message}`);
        break;
    }
  }

  // 结构化输出优先，拿不到就用正文（见 03-pitfalls #3）
  const parsed = extractJson(reply);
  if (parsed !== undefined) console.log("\n[结构化输出]", JSON.stringify(parsed, null, 2));
} finally {
  await adapter.close(sessionId); // 必须关，否则子进程泄漏
}
