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

    reply(id, {
      sessionId: `mock-session-${leaked}`,
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
    if (scenario === 'crash-after-session') {
      // 不回复，直接退出 —— 客户端应当报「进程退出」而不是无限等
      process.exit(1);
    }

    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: '读取 src/cache.js',
        status: 'completed',
        kind: 'read',
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
