# 实战配方

可直接抄的做法，都在真实项目里跑过。代码引用见
[reference/](reference/)。

---

## 配方 1：多轮对话（系统提示只发一次）

ACP 会话**自带上下文**，第二轮开始不用重复系统提示，只发用户这一句就行。
重复发不仅浪费 token，还会让模型行为漂移。

```ts
const session = { id: sessionId, turns: 0 };

async function send(userText: string) {
  const prompt = session.turns === 0
    ? SYSTEM_PROMPT + "\n\n" + userText   // 第一轮：系统提示 + 用户消息
    : userText;                            // 后续：只发用户消息
  session.turns++;

  let reply = "";
  const thoughts: string[] = [];
  for await (const ev of adapter.runTurn(session.id, { prompt })) {
    if (ev.kind === "message-chunk") reply += ev.text;
    else if (ev.kind === "thought-chunk") thoughts.push(ev.text);
    else if (ev.kind === "error") throw new Error(ev.message);
  }
  return { reply, thoughts };
}
```

**实测耗时参考**（Claude，真实模型调用）：一轮澄清追问约 9 秒，
生成一份完整结构化产物约 32 秒。UI 上必须有进度提示，否则用户以为卡死。

---

## 配方 2：结构化输出 + 自然语言兜底

```ts
function extractJson(text: string): unknown | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

// 消费：
const parsed = extractJson(reply);
const value = parsed === undefined ? reply.trim() : parsed;
if (value === "") throw new Error("agent produced no output");
```

要点：
- **不要全文 `JSON.parse`**——模型几乎总会在 JSON 前后带解释文字；
- **不要因为不是 JSON 就判失败**——周报/邮件/纪要这类交付物本来就是自然语言
  （见 [03-pitfalls #3](03-pitfalls.md)）；
- 想提高 JSON 命中率，把格式要求单独放在 prompt 末尾，比混在正文里有效。

如果要提取 markdown 代码块里的内容（比如让 agent 产出 YAML 配置）：

```ts
function extractBlock(text: string, lang = "ya?ml"): string | null {
  const m = text.match(new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```"));
  return m ? m[1].trim() : null;
}
```

---

## 配方 3：跨会话续聊（让"我记得"是真的）

用户切走再回来、或服务重启后，有两条路：

**路 A：`session/load`**（推荐，保真度最高）——前提是你持久化了 `sessionId`
和 `cwd`，且进程还能访问同一台机器的历史。

**路 B：把历史 transcript 拼进新会话的第一条 prompt**——跨机器、或 load 失败时
的降级方案：

```ts
function buildResumedPrompt(systemPrompt: string, transcript: string) {
  return systemPrompt
    .replace("这是一段全新的对话，之前没有任何上下文。",
             "这是你和这位用户对话的延续（不是全新对话）。")
    .replace("现在开始，用户的需求是：",
             "【接着之前的对话继续】下面是你和这位用户此前已经聊过的真实记录，" +
             "请在此基础上直接往下聊，不要说\"这是新对话\"，也不要让用户把说过的信息再重复一遍：\n\n" +
             transcript.trim() + "\n\n【用户现在发来的新消息】");
}
```

**关键**：如果 UI 上写了"已恢复之前的对话"，就必须真的把历史喂进去。
只在前端存一份 localStorage、后端开个全新空会话，用户第一句就会发现 AI 失忆
（见 [03-pitfalls #6](03-pitfalls.md)）。

---

## 配方 4：会话池（防子进程泄漏）

```ts
const MAX_SESSIONS = 6;
const sessions = new Map<string, SessionRecord>();   // Map 保持插入顺序 = LRU 基础

async function openSession(cwd: string) {
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    await closeSession(oldest);        // 关掉最旧的，释放子进程
  }
  // ... createSession 并放进 map
}
```

再加三道保险：
1. 每次用完 `finally { await close(sessionId) }`；
2. 进程退出钩子里批量关闭（`process.on("exit"|"SIGINT", ...)`）；
3. 浏览器端会话用 `navigator.sendBeacon` 在页面卸载时通知后端释放。

---

## 配方 5：真流式（边跑边出）

天真实现会等整个 turn 结束才吐事件（[03-pitfalls #7](03-pitfalls.md)）。
真流式要靠 `onUpdate` 回调 + 异步队列：

```ts
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
```

用法见 [reference/adapter.ts](reference/adapter.ts) 的 `runTurn`。

---

## 配方 6：超时与取消

```ts
function withTimeout<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
```

建议档位：
- `initialize` / `session/new`：60s
- `session/prompt`：240s 起（真实编码任务要更长，按任务类型分级）

**超时后必须同时**：`session/cancel` + 杀子进程。只 reject Promise 的话，
agent 还在后台跑、还在烧钱、还可能继续改文件。

---

## 配方 7：权限策略怎么选

```ts
export function preferOption(kinds: string[]): PermissionPolicy {
  return (req) => {
    for (const kind of kinds) {
      const opt = req.options.find((o) => o.kind === kind);
      if (opt) return { outcome: "selected", optionId: opt.optionId };
    }
    const fallback = req.options[0];
    return fallback ? { outcome: "selected", optionId: fallback.optionId }
                    : { outcome: "cancelled" };
  };
}
export const allowPolicy  = preferOption(["allow_once", "allow_always"]);
export const rejectPolicy = preferOption(["reject_once", "reject_always"]);
```

| 场景 | 用哪个 |
|---|---|
| 真实任务（要读文件、跑测试） | `allowPolicy` + 隔离 cwd + sandbox 档位 |
| 只读分析（不该改任何东西） | `allowPolicy` + codex 设 `read-only` sandbox 档位 |
| 需要人工逐条批准 | 自定义策略：把请求挂起投递给 UI，等用户裁决后再 resolve |
| 探针 / 测试隔离性 | `rejectPolicy` |

人工批准的策略写法（把同步回调变成可等待的）：

```ts
const policy: PermissionPolicy = async (req) => {
  const decision = await askUser(req);            // 返回 Promise
  return decision.approved
    ? { outcome: "selected", optionId: pickAllow(req).optionId }
    : { outcome: "selected", optionId: pickReject(req).optionId };
};
```

注意 `Client.requestPermission` 支持返回 Promise，所以策略可以是异步的——
agent 会一直阻塞等你，记得配超时。

---

## 配方 8：选 claude 还是 codex

| 需求 | 选择 | 理由 |
|---|---|---|
| 分析、写作、审查、结构化输出 | **claude** | 输出质量与指令遵循更好；走 fs 代理，有 path guard 落点 |
| 写代码、跑测试、改仓库 | 两者都行 | claude 走 fs 代理更可控；codex sandbox 档位更硬 |
| **无人值守 / CI / 批量** | **codex** | 支持 `CODEX_API_KEY` / `OPENAI_API_KEY` 纯环境变量认证，不依赖会过期的本机登录态 |
| 需要 client 端硬拦截文件写入 | **claude** | codex 不走 fs 代理（[02-runtime-findings #3](02-runtime-findings.md)） |
| 需要"独立第二意见"（审查） | 两者混用 | implementer 用一个、reviewer 用另一个，天然独立 session + 独立模型 |

---

## 配方 9：把 agent 输出做成可回放的 transcript

把每条归一化事件按 `(runId, nodeId, attempt, kind, data, at)` 持久化，
就能得到"像 Claude Code 对话界面一样"的完整过程回放：prompt 全文、思考、
每次工具调用的参数与结果、最终输出。

实践要点：
- **prompt 全文要存**，不要只存 hash——排查"为什么模型这么答"时全靠它；
- 工具调用按 `toolCallId` 合并 `tool_call` 与后续 `tool_call_update`；
- 存 `attempt` 序号，重试/返工的多轮才能分组展示；
- 大字段截断（stdout 存前 4000 字符），否则数据库会被日志撑爆。

---

## 配方 10：token 预算与成本核算（新版本才有）

新版 runtime 在 `session/prompt` 的响应里带 `usage`，通知流里带 `cost`
（实测数据见 [02-runtime-findings §5](02-runtime-findings.md)）。
参考实现已把它们挂在 `done` 事件上：

```ts
let spentUsd = 0;
let totalTokens = 0;

for await (const ev of adapter.runTurn(sessionId, { prompt })) {
  if (ev.kind === "done") {
    totalTokens += ev.usage?.totalTokens ?? 0;
    spentUsd += ev.cost?.amount ?? 0;
    if (spentUsd > BUDGET_USD) throw new Error(`预算超支：已花 $${spentUsd.toFixed(4)}`);
  }
}
```

要点：

- **`cachedReadTokens` 通常远大于 `inputTokens`**。实测一个只回一个词的 turn：
  `inputTokens: 2, outputTokens: 4, cachedReadTokens: 15498, totalTokens: 28479`。
  用 `totalTokens` 判断预算会严重高估真实成本——**直接用 runtime 给的
  `cost.amount`** 最准。
- 预算检查只能在 **turn 结束后**做（事中拿不到），所以要配合 turn 数上限，
  避免单个 turn 就烧穿预算。
- 旧版本（0.16.x）没有这两个字段，`ev.usage` / `ev.cost` 会是 `undefined`——
  代码要能容忍缺失，别直接解引用。
- 兜底始终保留 **turn 数上限 + 墙钟超时**，它们不依赖 runtime 是否提供计量。
