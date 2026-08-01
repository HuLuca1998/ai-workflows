#!/usr/bin/env node
/**
 * ACP 往返记录探针 —— 把每一行 JSON-RPC 原样落盘。
 *
 * 与 `probe.ts` 的区别：那份用 SDK，这份**手写 JSON-RPC**，
 * 因为本仓库的 Rust 客户端（`crates/engine/src/acp.rs`）也是手写的 ——
 * 记录下来的就是我们实际会发出去的字节，不是 SDK 替我们美化过的版本。
 *
 * 用法：
 *   node docs/acp/reference/transcript-probe.mjs <场景> [--agent codex|claude]
 *
 * 场景见文件末尾的 SCENARIOS。产物落在 docs/acp/transcripts/<场景>.jsonl，
 * 每行一条：
 *   {"t":毫秒,"dir":"→"|"←"|"#","raw":{…}}
 *   → 我们发出去的     ← agent 回来的     # 探针自己的标注
 *
 * 默认用 codex：这个应用本身跑在 Claude Code 里开发，用 claude 的 adapter
 * 会与开发环境撞在一起（见 06-repo-rules 规则 15）。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'transcripts');
const PROTOCOL_VERSION = 1;

/** 与 acp.rs 的 adapter_command / env_to_remove 保持一致。 */
const RUNTIMES = {
  codex: {
    bin: 'codex-acp',
    envRemove: ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'],
  },
  claude: {
    bin: 'claude-agent-acp',
    envRemove: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'],
  },
};

class Recorder {
  constructor(file) {
    this.file = file;
    this.t0 = Date.now();
    writeFileSync(file, '');
  }
  write(dir, raw) {
    appendFileSync(this.file, `${JSON.stringify({ t: Date.now() - this.t0, dir, raw })}\n`);
  }
  note(text, extra = {}) {
    this.write('#', { note: text, ...extra });
  }
}

/**
 * 一条 ACP 连接。
 *
 * 刻意保持与 acp.rs 同构：同一个 id 计数器、同样的 ndjson 写法、
 * 反向请求同样要应答（不应答的话双方互等到超时 —— acp.rs:110 那段注释
 * 描述的就是这个）。
 */
class Conn {
  constructor(runtime, rec, { permission = 'reject' } = {}) {
    const spec = RUNTIMES[runtime];
    const env = { ...process.env };
    for (const key of spec.envRemove) delete env[key];

    this.rec = rec;
    this.permission = permission;
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.onUpdate = null;

    this.child = spawn(spec.bin, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
    this.child.on('error', (e) => rec.note(`spawn 失败：${e.message}`));

    // stderr 单独收：agent 崩溃、认证失败、版本错配的信息只在这里
    // （06-repo-rules 规则 13）
    createInterface({ input: this.child.stderr }).on('line', (line) => {
      if (line.trim()) rec.write('#', { stderr: line });
    });

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        rec.write('#', { unparsable: line.slice(0, 400) });
        return;
      }
      rec.write('←', msg);
      this.dispatch(msg);
    });
  }

  dispatch(msg) {
    // 反向请求：有 method 也有 id
    if (msg.method && msg.id !== undefined) {
      this.answerReverse(msg);
      return;
    }
    if (msg.method) {
      if (msg.method === 'session/update') {
        this.updates.push(msg.params);
        this.onUpdate?.(msg.params);
      }
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (waiter) {
      this.pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
    }
  }

  /** 与 acp.rs:423 同构：从 agent 给的 options 里挑，绝不自己编 optionId。 */
  answerReverse(msg) {
    let result;
    if (msg.method === 'session/request_permission') {
      const options = msg.params?.options ?? [];
      const want = this.permission === 'allow' ? 'allow' : 'reject';
      const picked =
        options.find((o) => String(o.kind ?? '').startsWith(want)) ?? options.at(-1);
      result = picked
        ? { outcome: { outcome: 'selected', optionId: picked.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    } else if (msg.method === 'fs/read_text_file') {
      result = { content: '' };
    } else if (msg.method === 'fs/write_text_file') {
      result = null;
    } else {
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `客户端不支持 ${msg.method}` },
      });
      return;
    }
    this.send({ jsonrpc: '2.0', id: msg.id, result });
  }

  send(payload) {
    this.rec.write('→', payload);
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, timeoutMs = 180_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send(payload);
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async initialize() {
    return this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  }

  async newSession(cwd, mcpServers = []) {
    return this.request('session/new', { cwd, mcpServers });
  }

  /** 收集这一轮的正文，顺便返回 stopReason 与 usage。 */
  async prompt(sessionId, text, timeoutMs = 180_000) {
    let reply = '';
    this.onUpdate = (p) => {
      const u = p?.update ?? {};
      if (u.sessionUpdate === 'agent_message_chunk') reply += u.content?.text ?? '';
    };
    const res = await this.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text }] },
      timeoutMs,
    );
    this.onUpdate = null;
    return { reply, ...res };
  }

  kill() {
    try {
      this.child.kill('SIGKILL');
    } catch {}
  }
}

function freshCwd() {
  // 每次一个全新目录：固定前缀的临时目录会让会话历史串味
  // （03-pitfalls #5）。用完即删
  return mkdtempSync(path.join(tmpdir(), 'aiwf-acp-probe-'));
}

// ── 场景 ──────────────────────────────────────────────────────────────────

const SCENARIOS = {
  /** 握手：agent 到底声明了哪些能力。不产生模型调用，最快。 */
  async handshake(runtime, rec) {
    const conn = new Conn(runtime, rec);
    const init = await conn.initialize();
    rec.note('agentCapabilities 全貌', { capabilities: init.agentCapabilities });

    const cwd = freshCwd();
    const session = await conn.newSession(cwd);
    rec.note('session/new 返回的 modes', { modes: session.modes });

    conn.kill();
    rmSync(cwd, { recursive: true, force: true });
    return { protocolVersion: init.protocolVersion, sessionId: session.sessionId };
  },

  /**
   * 多轮对话：同一条 ACP 会话连问三轮。
   *
   * 第二轮**只发用户原话**（不重发任何系统提示词），第三轮问它前两轮说了什么 ——
   * 答得出来就证明上下文在 agent 侧（06-repo-rules 规则 1、2）。
   */
  /**
   * 一轮还没结束时再发一条消息会怎样。
   *
   * 两端握手都声明了这个能力（claude 是
   * `agentCapabilities._meta.claudeCode.promptQueueing`，codex 是顶层
   * `_meta.steering.supported`），而本仓库一处都没用过 ——
   * 界面在 agent 忙时直接把用户打的字丢掉。
   *
   * codex adapter 的源码里方法名是 `_session/steering`，入参
   * `{ sessionId, prompt: ContentBlock[] }`，返回 `{ outcome }`：
   * 有活跃 turn 时 `injected`（插进当前这一轮），否则开新一轮。
   * **这个场景就是去证实它。**
   */
  async steering(runtime, rec) {
    const conn = new Conn(runtime, rec);
    const init = await conn.initialize();
    rec.note('握手声明的队列能力', {
      claudePromptQueueing: init.agentCapabilities?._meta?.claudeCode?.promptQueueing ?? null,
      steering: init._meta?.steering ?? null,
    });

    const cwd = freshCwd();
    const { sessionId } = await conn.newSession(cwd);

    // 第一轮故意给一个要想一会儿的任务，好在它还没答完时插话
    rec.note('第 1 轮：发一个耗时的问题，不等它答完');
    let firstReply = '';
    conn.onUpdate = (p) => {
      const u = p?.update ?? {};
      if (u.sessionUpdate === 'agent_message_chunk') firstReply += u.content?.text ?? '';
    };
    const turn1 = conn.request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: '从 1 数到 30，每个数字单独一行，中间不要说别的。',
          },
        ],
      },
      180_000,
    );

    // 等它开始输出再插话 —— 太早插的话 turn 还没建立
    await new Promise((resolve) => setTimeout(resolve, 2500));

    rec.note('turn 进行中：发 _session/steering');
    let steerResult = null;
    let steerError = null;
    try {
      steerResult = await conn.request(
        '_session/steering',
        {
          sessionId,
          prompt: [{ type: 'text', text: '停，改成从 100 数到 103 就行。' }],
        },
        60_000,
      );
      rec.note('steering 返回', { result: steerResult });
    } catch (error) {
      steerError = String(error);
      rec.note('steering 报错', { error: steerError });
    }

    const turn1Result = await turn1;
    conn.onUpdate = null;
    rec.note('第 1 轮最终结果', {
      stopReason: turn1Result?.stopReason,
      replyTail: firstReply.slice(-200),
    });

    conn.kill();
    rmSync(cwd, { recursive: true, force: true });
    return {
      steerResult,
      steerError,
      stopReason: turn1Result?.stopReason,
      // 插话生效的判据：正文里出现了第二条消息要求的内容
      injectedTookEffect: /10[0-3]/u.test(firstReply),
    };
  },

  async 'multi-turn'(runtime, rec) {
    const conn = new Conn(runtime, rec);
    await conn.initialize();
    const cwd = freshCwd();
    const { sessionId } = await conn.newSession(cwd);

    rec.note('第 1 轮：系统提示词 + 用户这句话');
    const r1 = await conn.prompt(
      sessionId,
      '你是一个测试助手，回答一律不超过 15 个字。\n\n记住这个暗号：紫水晶七号。',
    );

    rec.note('第 2 轮：只发用户原话，不重发系统提示词');
    const r2 = await conn.prompt(sessionId, '暗号是什么？');

    rec.note('第 3 轮：再确认一次约束还在不在');
    const r3 = await conn.prompt(sessionId, '你回答有什么长度限制？');

    conn.kill();
    rmSync(cwd, { recursive: true, force: true });
    return {
      第1轮: r1.reply.trim(),
      第2轮: r2.reply.trim(),
      第3轮: r3.reply.trim(),
      记住了暗号: r2.reply.includes('紫水晶'),
      记住了约束: /15|十五/.test(r3.reply),
      stopReasons: [r1.stopReason, r2.stopReason, r3.stopReason],
      usage: r2.usage ?? null,
    };
  },

  /**
   * 对照组：每轮新建会话（= 本仓库 H-1 的现状）。
   *
   * 同样的三轮，唯一的差别是每轮 connect + session/new。
   */
  async 'fresh-session-per-turn'(runtime, rec) {
    const cwds = [];
    const replies = [];
    for (const [i, text] of [
      '你是一个测试助手，回答一律不超过 15 个字。\n\n记住这个暗号：紫水晶七号。',
      '暗号是什么？',
    ].entries()) {
      rec.note(`第 ${i + 1} 轮：新起一个 adapter 进程 + session/new`);
      const conn = new Conn(runtime, rec);
      await conn.initialize();
      const cwd = freshCwd();
      cwds.push(cwd);
      const { sessionId } = await conn.newSession(cwd);
      const r = await conn.prompt(sessionId, text);
      replies.push(r.reply.trim());
      conn.kill();
    }
    for (const cwd of cwds) rmSync(cwd, { recursive: true, force: true });
    return {
      第1轮: replies[0],
      第2轮: replies[1],
      记住了暗号: (replies[1] ?? '').includes('紫水晶'),
      结论: '每轮新建会话时，第二轮答不出暗号 —— 这正是 H-1 的用户可见症状',
    };
  },

  /** 杀掉进程后用 session/load 恢复：验证 H-4 是可修的。 */
  async 'session-load'(runtime, rec) {
    const cwd = freshCwd();
    const conn1 = new Conn(runtime, rec);
    const init = await conn1.initialize();
    const loadSupported = init.agentCapabilities?.loadSession === true;
    rec.note('loadSession capability', { loadSupported });

    const { sessionId } = await conn1.newSession(cwd);
    await conn1.prompt(sessionId, '记住这个暗号：青金石九号。回答不超过 10 个字。');
    rec.note('杀掉 adapter 进程，模拟应用重启');
    conn1.kill();
    await new Promise((r) => setTimeout(r, 500));

    const conn2 = new Conn(runtime, rec);
    await conn2.initialize();
    let replayed = 0;
    conn2.onUpdate = (p) => {
      const kind = p?.update?.sessionUpdate ?? '';
      if (kind.endsWith('_message_chunk')) replayed += 1;
    };
    rec.note('新进程里 session/load 同一个 sessionId');
    let loadError = null;
    try {
      await conn2.request('session/load', { sessionId, cwd, mcpServers: [] });
    } catch (e) {
      loadError = e.message;
    }
    rec.note('历史回放的 chunk 数', { replayed });

    let recalled = null;
    if (!loadError) {
      const r = await conn2.prompt(sessionId, '暗号是什么？');
      recalled = r.reply.trim();
    }
    conn2.kill();
    rmSync(cwd, { recursive: true, force: true });
    return { loadSupported, loadError, 回放的chunk数: replayed, 复述: recalled,
             记住了: (recalled ?? '').includes('青金石') };
  },

  /** session/cancel：验证 H-7 的修法真的能停住远端。 */
  async cancel(runtime, rec) {
    const conn = new Conn(runtime, rec);
    await conn.initialize();
    const cwd = freshCwd();
    const { sessionId } = await conn.newSession(cwd);

    rec.note('发一个会跑一阵的 prompt，然后中途 session/cancel');
    const started = Date.now();
    const pending = conn.prompt(sessionId, '从 1 数到 300，每个数字单独一行，不要省略。');
    await new Promise((r) => setTimeout(r, 4000));
    rec.note('发 session/cancel（通知，不是请求）');
    conn.notify('session/cancel', { sessionId });

    let outcome;
    try {
      outcome = await pending;
    } catch (e) {
      outcome = { error: e.message };
    }
    const elapsed = Date.now() - started;
    conn.kill();
    rmSync(cwd, { recursive: true, force: true });
    return { stopReason: outcome.stopReason ?? null, 耗时ms: elapsed,
             正文长度: (outcome.reply ?? '').length };
  },

  /**
   * 权限：让 agent 干一件需要动手的事，看 request_permission 长什么样。
   *
   * 两遍 —— 先全拒（本仓库现状，acp.rs:423），再全允许，对比产出差异。
   * 这是 03-pitfalls #2 的实证。
   */
  async permission(runtime, rec) {
    const out = {};
    for (const mode of ['reject', 'allow']) {
      rec.note(`===== 裁决策略：${mode} =====`);
      const conn = new Conn(runtime, rec, { permission: mode });
      await conn.initialize();
      const cwd = freshCwd();
      const { sessionId } = await conn.newSession(cwd);
      let asked = 0;
      const origin = conn.answerReverse.bind(conn);
      conn.answerReverse = (msg) => {
        if (msg.method === 'session/request_permission') asked += 1;
        return origin(msg);
      };
      const r = await conn.prompt(
        sessionId,
        `在当前目录建一个文件 hello.txt，内容写 "acp probe"。做完回一句「完成」。`,
      );
      let created = false;
      try {
        const { statSync } = await import('node:fs');
        created = statSync(path.join(cwd, 'hello.txt')).isFile();
      } catch {}
      out[mode] = {
        请求权限次数: asked,
        文件真的建了: created,
        stopReason: r.stopReason,
        回复: r.reply.trim().slice(0, 200),
      };
      conn.kill();
      rmSync(cwd, { recursive: true, force: true });
    }
    return out;
  },

  /**
   * 决定性对照：`session/set_mode` 到 read-only 之后，同一件事还做不做得成。
   *
   * `permission` 场景已经证明：codex 默认档（`agent`）下建文件**一次都不问**
   * `request_permission`，所以客户端那套裁决逻辑在那一档下形同虚设。
   * 那么真正的执法点在哪 —— 这个场景回答它。
   */
  async 'permission-readonly'(runtime, rec) {
    const conn = new Conn(runtime, rec, { permission: 'reject' });
    await conn.initialize();
    const cwd = freshCwd();
    const { sessionId, modes } = await conn.newSession(cwd);
    rec.note('建会话时的默认档', { currentModeId: modes?.currentModeId });

    rec.note('切到 read-only');
    await conn.request('session/set_mode', { sessionId, modeId: 'read-only' });

    let asked = 0;
    const origin = conn.answerReverse.bind(conn);
    conn.answerReverse = (msg) => {
      if (msg.method === 'session/request_permission') {
        asked += 1;
        rec.note('收到权限请求', { toolCall: msg.params?.toolCall, options: msg.params?.options });
      }
      return origin(msg);
    };

    const r = await conn.prompt(
      sessionId,
      `在当前目录建一个文件 hello.txt，内容写 "acp probe"。做完回一句「完成」。`,
    );
    let created = false;
    try {
      const { statSync } = await import('node:fs');
      created = statSync(path.join(cwd, 'hello.txt')).isFile();
    } catch {}

    conn.kill();
    rmSync(cwd, { recursive: true, force: true });
    return {
      默认档: modes?.currentModeId,
      切档后请求权限次数: asked,
      文件真的建了: created,
      stopReason: r.stopReason,
      回复: r.reply.trim().slice(0, 300),
      结论:
        asked > 0
          ? 'read-only 档才会走 request_permission —— 客户端裁决在这一档下才有意义'
          : 'read-only 档下它连问都不问，直接不做 —— 执法完全在 runtime 侧',
    };
  },

  /** 探测那些文档里写着、但本仓库一个都没用过的方法到底能不能调。 */
  async 'new-methods'(runtime, rec) {
    const conn = new Conn(runtime, rec);
    const init = await conn.initialize();
    const cwd = freshCwd();
    const session = await conn.newSession(cwd);
    const { sessionId } = session;

    const probe = async (method, params) => {
      try {
        const result = await conn.request(method, params, 30_000);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e.message.slice(0, 300) };
      }
    };

    /*
     * 档位 id **不能硬编码**：codex 是 read-only / agent / agent-full-access，
     * claude 是 auto / default / acceptEdits / plan / dontAsk / bypassPermissions。
     * 写死一个名字，换个 runtime 就静默失败 —— 这正是抽象层要吃掉的那类差异。
     */
    const 最严档 = session.modes?.availableModes?.[0]?.id;

    const out = {
      声明的capabilities: init.agentCapabilities,
      可用档位: session.modes?.availableModes?.map((m) => m.id),
      默认档位: session.modes?.currentModeId,
      配置项: session.configOptions?.map((o) => `${o.id}=${o.currentValue}`),
      有models字段: session.models !== undefined,
      'session/list': await probe('session/list', {}),
      'session/set_mode': await probe('session/set_mode', { sessionId, modeId: 最严档 }),
      'session/resume': await probe('session/resume', { sessionId, cwd, mcpServers: [] }),
      'session/close': await probe('session/close', { sessionId }),
    };
    conn.kill();
    rmSync(cwd, { recursive: true, force: true });
    return out;
  },

  /**
   * 模型怎么选、能不能设、设了生不生效。
   *
   * 这个场景**会产生真实模型调用**（要验「设了之后跑的是不是那个」，
   * 只能真跑一轮）。claude 侧三轮实测花了 $0.49。
   *
   * 三件事按顺序验：
   *
   * 1. **清单从哪来** —— `models.availableModels` 只有 codex 有，
   *    `configOptions` 两端都有。按 `category` 取而不是按 `id`：
   *    id 两端不一样（`reasoning_effort` vs `effort`），category 一样
   * 2. **`session/new` 带 model 参数会怎样** —— 两端都**静默忽略**：
   *    不报错、不采纳。这是最坏的一种「不支持」，照直觉实现会全绿而从不生效
   * 3. **`set_config_option` 设了生不生效** —— 响应回全量 configOptions
   *    可当场回读；再配一条「设不存在的值」的对照，证明 agent 真的在校验
   *
   * 候选值一律从 agent 给的 options 里取，**不硬编码** ——
   * 本地 CLI 一升级模型清单就会变，写死的候选到那天会静默失效。
   */
  async model(runtime, rec) {
    const probe = async (conn, method, params, timeoutMs = 30_000) => {
      try {
        return { ok: true, result: await conn.request(method, params, timeoutMs) };
      } catch (e) {
        return { ok: false, error: e.message.slice(0, 300) };
      }
    };
    /** configOptions 按 category 取 —— id 两端不一样，category 一样。 */
    const 按类取 = (session, category) =>
      (session.configOptions ?? []).find((o) => o.category === category);

    const conn = new Conn(runtime, rec);
    await conn.initialize();
    const cwds = [];
    const 新目录 = () => {
      const d = freshCwd();
      cwds.push(d);
      return d;
    };

    // ── 1. 清单从哪来 ────────────────────────────────────────────────────
    const 基准 = await conn.newSession(新目录());
    const 模型项 = 按类取(基准, 'model');
    const 强度项 = 按类取(基准, 'thought_level');
    rec.note('模型清单的两个来源', {
      'models.availableModels': 基准.models ?? null,
      'configOptions[category=model]': 模型项 ?? null,
      'configOptions[category=thought_level]': 强度项 ?? null,
    });

    // ── 2. session/new 里塞 model：认不认 ────────────────────────────────
    //
    // 挑一个**与当前值不同**的候选，不然「采纳了」与「忽略了」长得一样
    const 别的模型 = 模型项?.options?.find((o) => o.value !== 模型项.currentValue)?.value;
    rec.note('试着在 session/new 里直接指定模型', { 想要的: 别的模型 });
    const 带model = await probe(conn, 'session/new', {
      cwd: 新目录(),
      mcpServers: [],
      model: 别的模型,
    });
    const 建完的值 = 带model.ok ? 按类取(带model.result, 'model')?.currentValue : null;

    // ── 3. set_config_option：设、回读、设假值 ───────────────────────────
    const { sessionId } = 基准;
    const 设模型 = 别的模型
      ? await probe(conn, 'session/set_config_option', {
          sessionId,
          // 参数名是 configId 不是 optionId —— 写错时 agent 回的是
          // 「configId: expected string, received undefined」
          configId: 模型项.id,
          value: 别的模型,
        })
      : { ok: false, error: '没有第二个模型可选' };

    const 别的强度 = 强度项?.options?.find((o) => o.value !== 强度项.currentValue)?.value;
    const 设强度 = 别的强度
      ? await probe(conn, 'session/set_config_option', {
          sessionId,
          configId: 强度项.id,
          value: 别的强度,
        })
      : { ok: false, error: '没有第二个强度档可选' };

    // 对照：一个一定不存在的值。被拒 = agent 真的在校验，
    // 那意味着**校验不必我们自己做**
    const 设假值 = await probe(conn, 'session/set_config_option', {
      sessionId,
      configId: 模型项?.id ?? 'model',
      value: '这个模型一定不存在-aiwf-probe',
    });

    // ── 4. 设了之后跑的是不是那个 ───────────────────────────────────────
    //
    // 回读只证明 agent **记住了**，要证明它**照做了**得真跑一轮。
    // 两端的证据形状不同：codex 在 `_meta.quota.model_usage[].model` 里
    // 自报模型名，claude 没有这个字段，只能看 usage_update 的上下文窗口
    let 跑一轮 = null;
    if (设模型.ok) {
      const usage通知 = [];
      const 原 = conn.onUpdate;
      conn.onUpdate = (p) => {
        if (p?.update?.sessionUpdate === 'usage_update') usage通知.push(p.update);
      };
      const r = await probe(
        conn,
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: '只回答一个字：好' }] },
        120_000,
      );
      conn.onUpdate = 原;
      跑一轮 = {
        设成的模型: 别的模型,
        'codex 侧的自报（_meta.quota.model_usage）':
          (r.result?._meta?.quota?.model_usage ?? []).map((m) => m.model).join(',') ||
          '没有这个字段',
        usage: r.result?.usage ?? null,
        'claude 侧的旁证（usage_update.size）': usage通知.at(-1)?.size ?? null,
        stopReason: r.result?.stopReason ?? r.error,
      };
    }

    // ── 5. codex 有 session/set_model，claude 没有 ──────────────────────
    //
    // **必须放在 prompt 之后**：它与 set_config_option 写的是同一个状态，
    // 后调的覆盖先调的。放在前面的话，上面那一轮验的就不是我们设的模型了 ——
    // 这是这个探针自己踩过的坑：设 terra、回读 terra，agent 却报用了 sol，
    // 因为中间这一行把它设回 availableModels[0] 了
    const set_model = await probe(
      conn,
      'session/set_model',
      { sessionId, modelId: 基准.models?.availableModels?.[0]?.modelId ?? 'x' },
      15_000,
    );
    const set_model之后 = set_model.ok
      ? await probe(conn, 'session/set_config_option', {
          sessionId,
          configId: 模型项?.id ?? 'model',
          value: 模型项?.currentValue,
        })
      : null;

    // ── 6. 会话级还是进程级 ─────────────────────────────────────────────
    const 再建 = await conn.newSession(新目录());

    conn.kill();
    for (const d of cwds) rmSync(d, { recursive: true, force: true });

    return {
      清单来源: {
        'models.availableModels': 基准.models
          ? `${基准.models.availableModels.length} 个 · current=${基准.models.currentModelId}`
          : '没有这个字段',
        'configOptions[model]': 模型项
          ? `id=${模型项.id} · ${模型项.options.length} 个 · current=${模型项.currentValue}`
          : '没有',
        'configOptions[thought_level]': 强度项
          ? `id=${强度项.id} · ${强度项.options.length} 个 · current=${强度项.currentValue}`
          : '没有',
      },
      'session/new 带 model': 带model.ok
        ? {
            报错了吗: '没报错',
            想要的: 别的模型,
            建完的: 建完的值,
            被采纳了吗: 建完的值 === 别的模型,
          }
        : { 报错: 带model.error },
      set_config_option: {
        设模型: 设模型.ok
          ? `成功 · 回读 ${按类取(设模型.result, 'model')?.currentValue}`
          : 设模型.error,
        设强度: 设强度.ok
          ? `成功 · 回读 ${按类取(设强度.result, 'thought_level')?.currentValue}`
          : 设强度.error,
        设一个不存在的值: 设假值.ok ? `静默接受（危险）` : `被拒：${设假值.error}`,
      },
      'session/set_model': set_model.ok
        ? `支持 · 它与 set_config_option 写同一个状态（设完再读 model=${
            set_model之后?.ok
              ? 按类取(set_model之后.result, 'model')?.currentValue
              : '读不到'
          }）`
        : set_model.error,
      设了之后真的用了吗: 跑一轮,
      新会话的默认值: {
        model: 按类取(再建, 'model')?.currentValue,
        与第一条一致: 按类取(再建, 'model')?.currentValue === 模型项?.currentValue,
        说明: '一致 = 配置是会话级的，不会漏给下一条会话',
      },
    };
  },
};

// ── 入口 ──────────────────────────────────────────────────────────────────

const [, , scenario, ...rest] = process.argv;
const runtime = rest.includes('--agent') ? rest[rest.indexOf('--agent') + 1] : 'codex';

if (!scenario || !SCENARIOS[scenario]) {
  console.error(`用法：node transcript-probe.mjs <场景> [--agent codex|claude]

场景：
${Object.keys(SCENARIOS)
  .map((k) => `  ${k}`)
  .join('\n')}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${runtime}-${scenario}.jsonl`);
const rec = new Recorder(file);
rec.note(`场景 ${scenario} · runtime ${runtime}`, {
  node: process.version,
  when: new Date().toISOString(),
});

/**
 * 落盘后立刻脱敏，**不给忘记的机会**。
 *
 * 这不是防御性编程，是一次真实事故的补救：`session/list` 一调下去，
 * codex 把本机全部会话都回了过来（实测 25 条，全部属于别的项目），
 * `title` 是那些会话的完整 prompt 正文，当场落进了要提交的 jsonl。
 * `available_commands_update` 同理会带上本机装的全部 skill。
 */
async function redact() {
  const { spawnSync } = await import('node:child_process');
  const script = path.join(HERE, 'redact-transcript.mjs');
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  if (r.stdout?.trim()) console.error(r.stdout.trim());
}

try {
  const summary = await SCENARIOS[scenario](runtime, rec);
  rec.note('结论', { summary });
  await redact();
  console.log(JSON.stringify({ 场景: scenario, runtime, 产物: file, 结论: summary }, null, 2));
  process.exit(0);
} catch (error) {
  rec.note(`场景失败：${error.message}`);
  await redact();
  console.error(`✗ ${scenario} 失败：${error.message}\n  记录仍已落盘：${file}`);
  process.exit(1);
}
