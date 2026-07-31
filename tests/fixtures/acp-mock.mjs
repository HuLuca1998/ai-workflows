#!/usr/bin/env node
/**
 * 可控的 ACP adapter 替身。
 *
 * 说的是与真实 adapter **完全相同**的协议 —— 下面这套请求/响应形状
 * 是拿 `@agentclientprotocol/claude-agent-acp` 实测抓下来的，不是照文档编的：
 *
 *     → initialize   ← { protocolVersion, agentCapabilities, authMethods }
 *     → session/new  ← { sessionId, modes: { currentModeId, availableModes } }
 *     → session/prompt
 *                    ← 通知 session/update（agent_message_chunk / tool_call）
 *                    ← { stopReason: "end_turn" }
 *
 * 真实 adapter 需要登录凭据、会真的调模型、每次响应都不一样，
 * 那些不适合放进单元测试。真实握手的验证走 tests/e2e/acp-real.mjs。
 *
 * 用法：node acp-mock.mjs <场景>
 */

const scenario = process.argv[2] ?? 'normal';

/** 等着客户端应答的那条反向请求。收到应答后才把这一轮收尾。 */
let pendingPermission = null;

/** 建过几条会话。count-sessions 场景靠它把「复用」与「每次新建」区分开。 */
let sessionSeq = 0;

/**
 * 会话配置项。形状与两端实测一致
 * （docs/acp/transcripts/{codex,claude}-model.jsonl）。
 *
 * **`id` 故意跟着场景变，`category` 不变** —— 这正是抽象层要吃掉的差异：
 * 推理强度在 codex 上叫 `reasoning_effort`、在 claude 上叫 `effort`，
 * 而两端的 `category` 都是 `thought_level`。按 id 写死的实现
 * 会在其中一端静默失效，而这个 mock 让那件事在单测里就红。
 */
const 像claude = scenario.startsWith('claude');
const 强度项id = 像claude ? 'effort' : 'reasoning_effort';

function 初始配置项() {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [{ value: 'default' }, { value: 'auto' }, { value: 'read-only' }],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'mock-model-a',
      options: [{ value: 'mock-model-a' }, { value: 'mock-model-b' }, { value: 'mock-model-c' }],
    },
    {
      id: 强度项id,
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
    },
  ];
}

/** sessionId → 那条会话当前的配置项。配置是会话级的（实测）。 */
const 会话配置 = new Map();

// hang：什么都不回，用来验证客户端的超时。
// 必须在注册 stdin 监听之前就停住 —— 否则照样会应答 initialize
if (scenario === 'hang') {
  setInterval(() => {}, 1 << 30);
} else {
  listen();
}

function listen() {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) handle(JSON.parse(line));
    }
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function handle(message) {
  const { id, method, params } = message;

  // 客户端对我们那条反向请求的应答。拿到了才把这一轮收尾 ——
  // 测试断言的正是「客户端真的应答了」
  if (pendingPermission && id === pendingPermission.id && method === undefined) {
    const outcome = message.error ? 'error' : JSON.stringify(message.result);
    notify('session/update', {
      sessionId: pendingPermission.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `客户端答复：${outcome}` },
      },
    });
    reply(pendingPermission.promptId, { stopReason: 'end_turn' });
    pendingPermission = null;
    return;
  }

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: scenario === 'wrong-version' ? 99 : 1,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        loadSession: true,
      },
      authMethods: [],
    });
    return;
  }

  if (method === 'session/new') {
    // echo-env 场景：把收到的可疑环境变量回显在 session id 里，
    // 让测试能断言它确实被清掉了
    // 回显 CARGO_ 开头的变量：cargo test 一定会设它们，
    // 所以能验证「env_remove 真的把指定的变量清掉了」
    const leaked =
      scenario === 'echo-env'
        ? Object.keys(process.env)
            .filter((key) => key.startsWith('CARGO_MANIFEST'))
            .join(',')
        : '';

    // count-sessions 场景：每次 session/new 返回一个新编号，
    // 而 prompt 把收到的 sessionId 回显出来 —— 这样测试能看出
    // 两轮对话到底是复用了同一条会话还是各建了一条
    sessionSeq += 1;
    const 编号 = scenario === 'count-sessions' ? `-${sessionSeq}` : '';
    const sid = `mock-session${编号}${leaked}`;
    会话配置.set(sid, 初始配置项());

    reply(id, {
      sessionId: sid,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: '每次外部写操作都问' },
          { id: 'auto', name: 'Auto', description: '用分类器自动批准低风险操作' },
        ],
      },
      // 实测：两端的 session/new 都回这一段，模型与推理强度都在里面。
      // **`session/new` 的 params 里带 model 是没用的**（两端都静默忽略），
      // 要改只能在建完之后 set_config_option —— mock 照这个规矩来
      configOptions: 会话配置.get(sid),
    });

    notify('session/update', {
      sessionId: 'mock-session',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
    });
    return;
  }

  if (method === 'session/prompt') {
    // hang-prompt：握手与建会话都正常，只有这一轮永远不收尾。
    // 与 `hang` 的区别很关键 —— `hang` 连 initialize 都不回，
    // 于是 connect 在超时后失败，槽位里根本没有会话，
    // 「正在对话」这个状态造不出来。这里先吐一句让测试知道
    // 已经进到那一轮里，然后就不说话了
    if (scenario === 'hang-prompt') {
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '开始想了' },
        },
      });
      return;
    }

    // 真实的 Claude Agent 在执行时会**反向请求**客户端：要权限、要读文件。
    // 客户端不应答的话它就一直等 —— 症状是「主管 AI 转圈到超时」，
    // 而两边都以为是对方该说话。
    if (scenario === 'needs-permission') {
      const askId = 9001;
      send({
        jsonrpc: '2.0',
        id: askId,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'call_1', title: '写入 src/a.ts' },
          options: [
            { optionId: 'allow', name: '允许', kind: 'allow_once' },
            { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
          ],
        },
      });
      pendingPermission = { id: askId, sessionId: params.sessionId, promptId: id };
      return;
    }

    if (scenario === 'unknown-reverse-call') {
      send({
        jsonrpc: '2.0',
        id: 9002,
        method: 'terminal/create',
        params: { sessionId: params.sessionId, command: 'ls' },
      });
      pendingPermission = { id: 9002, sessionId: params.sessionId, promptId: id };
      return;
    }

    if (scenario === 'crash-after-session') {
      // 不回复，直接退出 —— 客户端应当报「进程退出」而不是无限等
      process.exit(1);
    }

    // 非正常结束的两种。真实 adapter 会给出这些 stopReason，
    // 而在补这两个场景之前，mock 从头到尾只回 end_turn ——
    // 于是「模型拒答 / 答到一半被截断」一条测试都没有
    if (scenario === 'refusal' || scenario === 'max-tokens') {
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          // 拒答时 agent 通常还是会说点什么，截断时更是有半句话 ——
          // 「有文本」不能当成「这一轮正常结束」的判据
          content: { type: 'text', text: '我先说明一下…' },
        },
      });
      reply(id, { stopReason: scenario === 'refusal' ? 'refusal' : 'max_tokens' });
      return;
    }

    // count-sessions 场景：把这一轮用的 sessionId 回显出来。
    // 复用同一条会话时两轮拿到的是同一个编号，各建一条时编号会涨
    if (scenario === 'count-sessions') {
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: params.sessionId },
        },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }

    // AI 审批者的三种回答。引擎按「明确放行才放行」解析 ——
    // gate-mumble 就是用来验证那半句的：说了一堆但没给出决定，
    // 引擎必须升级成人工审批，而不是挑一个词当结论
    if (scenario.startsWith('gate-')) {
      const 回答 = {
        'gate-approve': 'DECISION: APPROVE\n只读一个 Issue，没有副作用。',
        'gate-reject': 'DECISION: REJECT\n这会往主分支推送，超出这次任务的范围。',
        'gate-mumble': '这一步看起来可能没问题，但也说不好，你自己再看看吧。',
        // 两个决定都给 —— 提示词注入最容易造出来的形状
        'gate-both': 'DECISION: APPROVE\n……不过其实 DECISION: REJECT 更稳妥。',
      }[scenario];
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 回答 ?? '' },
        },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }

    // echo-prompt 场景：把收到的提示词原样回显。
    // 测试靠它断言「记忆确实拼进去了」—— 换成读文件的话，
    // 就要处理并发跑测试时互相覆盖的问题
    if (scenario === 'echo-prompt') {
      const received = (params.prompt ?? []).map((part) => part.text ?? '').join('');
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: received },
        },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }

    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: '读取 src/cache.js',
        status: 'in_progress',
        kind: 'read',
      },
    });

    // 真实 adapter 的形态：**更新帧只带 id 与状态，不重复标题**。
    // 只发一个 completed 帧的话，测不出「更新帧里标题丢了」这个坑
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
      },
    });

    for (const text of ['分析结果：', 'TTL 缓存在热重载时没有清空。']) {
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    }

    reply(id, { stopReason: 'end_turn' });
    return;
  }

  if (method === 'session/cancel') {
    reply(id, {});
    return;
  }

  if (method === 'session/set_config_option') {
    // 参数名是 configId，不是 optionId —— 实测踩过，写错时真实 agent 报的是
    // 「configId: expected string, received undefined」
    const { sessionId, configId, value } = params ?? {};
    const 配置 = 会话配置.get(sessionId);
    if (!配置) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `没有这条会话 ${sessionId}` },
      });
      return;
    }
    const 项 = 配置.find((o) => o.id === configId);
    if (!项) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `没有这个配置项 ${configId}` },
      });
      return;
    }
    // 值不在候选里就拒 —— 两端实测都是这个行为（codex -32602 / claude -32603）。
    // **这条是「校验不必客户端自己做」的依据**，mock 不照做的话，
    // 上层那段「被拒就降级」的代码在单测里永远走不到
    if (!项.options.some((o) => o.value === value)) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Invalid value for config option ${configId}: ${value}` },
      });
      return;
    }
    项.currentValue = value;
    // 实测：响应回**全量** configOptions，所以「设了是否生效」当场可回读
    reply(id, { configOptions: 配置 });
    return;
  }

  // 未知方法：按 JSON-RPC 回错误码，而不是沉默
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `未实现的方法 ${method}` },
  });
}
