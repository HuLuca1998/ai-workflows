# 踩坑清单

每条都是真实踩过并修复的。按"踩到的概率 × 排查难度"排序。

---

## 1. 嵌套会话变量导致 runtime 拒绝服务 ⚠️ 必踩

**现象**：在自己的终端里手跑没问题，但从 Claude Code 会话里启动你的程序，
agent 子进程起不来或立刻退出，stderr 里说自己已经在 agent 里了。

**原因**：Claude Code 会给子进程注入 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、
`CLAUDE_CODE_SSE_PORT` 等嵌套标记。你的程序继承了这些变量，再传给
`claude-agent-acp`，它就误判自己运行在另一个 agent 内部而拒绝服务。

**修复**：spawn 前从环境里删掉这些变量。固化进 runtime 注册表：

```ts
"claude-code": {
  envRemove: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"],
},
codex: {
  envRemove: ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"],
},
```

```ts
const env = { ...process.env };
for (const key of entry.envRemove ?? []) delete env[key];
spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
```

**为什么难排查**：只在"从 agent 终端启动"时复现，你自己开发时多半不会碰到，
一交给用户就炸。

---

## 2. 用 rejectPolicy 跑真实任务 → agent 不产出结构化输出 ⚠️

**现象**：让 Claude 分析代码并返回 JSON，它啥都没返回，或者只回一句
"我无法读取文件"。

**原因**：默认给了个保守的 `rejectPolicy`（拒绝所有权限请求）。Claude 想用
Read/Grep 工具去看真实文件 → 被拒 → 它没有素材 → 于是不产出结构化结果，
只回一句解释。

**修复**：真实任务要用 `allowPolicy`（允许 `allow_once` / `allow_always`），
把安全性交给 **cwd 隔离 + sandbox 档位 + OS 兜底**，而不是靠拒绝工具调用。

```ts
new AcpAdapter(ACP_RUNTIME_REGISTRY["claude-code"], allowPolicy);
```

**教训**：权限回调是策略层不是安全边界（见
[02-runtime-findings #2](02-runtime-findings.md)）。用它做安全会同时失去
安全性和可用性。

---

## 3. 强制要求 JSON 输出 → 自然语言交付物被判失败

**现象**：让 agent 写周报/纪要/邮件，明明写得很好，程序却判定这一步失败、
把成品丢了。

**原因**：解析逻辑写成"必须能提取出 JSON，否则 fail"。但周报、纪要、邮件这类
交付物本来就不该是 JSON。

**修复**：分层降级——

```ts
const parsed = extractJson(text);          // 优先取结构化
const value = parsed === undefined ? text.trim() : parsed;   // 没有就用正文
if (value === "") return fail("agent produced no output");   // 只有真空才算失败
```

`extractJson` 取第一个 `{` 到最后一个 `}` 之间的内容尝试 parse，失败返回
`undefined`。别用严格全文 parse——模型经常在 JSON 前后带解释性文字。

---

## 4. 子进程泄漏

**现象**：跑久了机器上一堆 `claude-agent-acp` 进程，内存吃满。

**原因**：只 `createSession` 不 `close`；或者会话对象被 GC 了但子进程还活着。

**修复**：
- 每个 session 用完必须 `close`（`finally` 里调）；
- 长期服务要设**并发会话上限**，超了就关掉最旧的：

```ts
const MAX_SESSIONS = 6;
while (sessions.size >= MAX_SESSIONS) {
  const oldest = sessions.keys().next().value;   // Map 保持插入顺序
  await endSession(oldest);
}
```

- `close` 要先 `SIGTERM`、等一小会、还没退再 `SIGKILL`：

```ts
child.kill("SIGTERM");
const code = await Promise.race([exited, sleep(3000).then(() => null)]);
if (code === null && child.exitCode === null) child.kill("SIGKILL");
```

- 浏览器端触发的会话，页面关闭时用 `navigator.sendBeacon` 通知后端释放，
  否则用户一关标签页进程就泄漏。

---

## 5. 临时 cwd 目录名导致会话历史串味 ⚠️ 隐蔽

**现象**：开一个**全新**对话，agent 却"记得"上一次对话的内容，甚至复述出
上次测试时注入的句子。

**原因**：Claude Code 会按 cwd 路径在 `~/.claude/projects/<路径编码>` 下存历史。
如果你用固定前缀创建临时目录（比如 `mkdtemp(tmpdir() + "/myapp-chat-")`），
虽然每次目录名不同，但**历史目录会累积**，且在某些情况下新会话会读到同前缀的
旧历史。

**修复**：新建会话前，清掉自己产生的临时项目历史（只删自己前缀的，绝不碰用户
真实项目）：

```ts
function purgeStaleChatHistory(prefix = "myapp-chat") {
  try {
    const projects = path.join(homedir(), ".claude", "projects");
    for (const d of readdirSync(projects)) {
      if (d.includes(prefix)) rmSync(path.join(projects, d), { recursive: true, force: true });
    }
  } catch { /* 目录不存在或无权限时跳过 */ }
}
```

**为什么危险**：这会导致"AI 好像记得不该记得的东西"，在多用户/多任务场景里
是数据串扰，不只是体验问题。

---

## 6. "重新开始"没有真的重新开始

**现象**：用户点了"清空重来"，AI 还是带着之前的记忆。

**原因**：只清了前端状态 / localStorage，后端 ACP 会话还是原来那个。

**修复**：清空必须**真删服务端草稿 + 真关旧 session + 真建新 session**。
如果承诺了"记得之前聊过什么"，那就要真的把历史 transcript 拼进新会话的第一条
prompt 里（见 [04-recipes](04-recipes.md) 续聊配方），而不是嘴上说记得。

**教训**：面向用户的状态承诺（记得/忘记/恢复）必须在后端真实兑现，
用户一测就穿帮。

---

## 7. 天真的 runTurn 不是流式 ⚠️ 设计缺陷

**现象**：UI 上工具调用、思考过程全是 turn 结束后"唰"地一次性冒出来，
中间几十秒白屏。

**原因**：这样写：

```ts
const before = handle.updates.length;
const resp = await handle.prompt(sessionId, text);       // ← 阻塞到整个 turn 结束
for (const n of handle.updates.slice(before)) yield normalize(n);   // ← 然后才补发
```

`session/prompt` 要整个 turn 完成才 resolve，所以事件全在结束后才被 yield。
`AsyncIterable` 的外壳骗了自己。

**修复**：用 `onUpdate` 回调把通知实时推进一个异步队列，`runTurn` 消费队列：

```ts
async function* runTurn(sessionId, prompt) {
  const queue = new AsyncQueue<AgentEvent>();
  handle.onUpdate = (n) => { const ev = normalize(n); if (ev) queue.push(ev); };
  handle.prompt(sessionId, prompt)
    .then((r) => queue.push({ kind: "done", stopReason: r.stopReason }))
    .catch((e) => queue.push({ kind: "error", message: String(e) }))
    .finally(() => queue.close());
  yield* queue;
}
```

完整实现见 [reference/adapter.ts](reference/adapter.ts)。

---

## 8. cwd 不存在 / 用相对路径

`session/new` 的 `cwd` 必须是**已存在的绝对路径**。传相对路径或不存在的目录，
会话创建会失败，错误信息还不一定清楚。创建前 `mkdirSync(cwd, { recursive: true })`。

---

## 9. 找不到可执行文件

`claude-agent-acp` / `codex-acp` 在 `node_modules/.bin/` 下，不一定在 PATH 里。

**修复**：用绝对路径，并允许环境变量覆盖（方便指向本地构建或特定版本）：

```ts
const cmd = path.resolve(process.cwd(), "node_modules/.bin/claude-agent-acp");
process.env.MYAPP_ACP_CLAUDE_CMD = cmd;   // registry 会优先读这个
```

---

## 10. 长 turn 的超时策略

`session/prompt` 可能跑很久（实测：多轮对话里的追问约 9s，生成完整产物约 32s；
真实编码任务可以到几分钟）。

- 握手/建会话给 60s 足够；
- prompt 给 240s 起步，真实编码任务要更长；
- **超时后不要只是 reject**，还要 `session/cancel` + 杀进程，否则子进程还在跑；
- 长 turn（>10min）下 stdio 流的稳定性**尚未充分验证**——这是遗留的未知项，
  真上生产要自己观测。

---

## 11. stderr 必须收集

agent 崩溃、认证失败、版本错配的信息**只在 stderr 里**，ACP 消息流里什么都没有。
一定要 `child.stderr.on("data", ...)` 收集并在报错时带出来，否则排查基本靠猜。

---

## 12. 包名已全部变更

`@zed-industries/*` 三个包都 deprecated 了。新项目直接用
`@agentclientprotocol/sdk`、`@agentclientprotocol/claude-agent-acp`、
`@agentclientprotocol/codex-acp`。详见 [README](README.md) 版本状态段。
