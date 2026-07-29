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

    reply(id, {
      sessionId: `mock-session${编号}${leaked}`,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: '每次外部写操作都问' },
          { id: 'auto', name: 'Auto', description: '用分类器自动批准低风险操作' },
        ],
      },
    });

    notify('session/update', {
      sessionId: 'mock-session',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
    });
    return;
  }

  if (method === 'session/prompt') {
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

  // 未知方法：按 JSON-RPC 回错误码，而不是沉默
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `未实现的方法 ${method}` },
  });
}
