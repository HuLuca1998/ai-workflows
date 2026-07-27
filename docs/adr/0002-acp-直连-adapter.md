# ADR 0002：Rust 引擎直连 ACP adapter，不再额外包一层 Node sidecar

日期：2026-07-28
状态：已采纳

## 背景

技术选型里画的链路是 `Rust 引擎 → ACP Sidecar（Node）→ Claude Code / Codex`。
`services/acp-sidecar` 已经存在，里面有 runtime 注册表（命令名、要清除的环境变量、
期望的 adapter 包与协议版本）。

实测确认：adapter（`@agentclientprotocol/claude-agent-acp`）本身就是一个
**stdio 上的 JSON-RPC 服务**。握手与建会话都验证过：

```
→ initialize        ← protocolVersion 1 + agentCapabilities
→ session/new       ← sessionId + modes（权限档位）
                    ← session/update 通知（available_commands_update）
```

## 决定

引擎直接 spawn adapter 进程并说 JSON-RPC，不在中间再放一个 Node 进程。

`services/acp-sidecar` 保留，但定位收窄为**知识**而非**进程**：
runtime 注册表（哪些 adapter、命令叫什么、要清哪些环境变量）仍是单一真源，
Rust 侧读它的导出而不是各自硬编码一份。

## 为什么

- **少一跳就少一处失败点**。多一个常驻进程意味着多一份生命周期管理、
  多一处崩溃后的恢复逻辑、多一个「到底是谁没响应」的排查分支。
- adapter 已经是 sidecar。技术选型说「Node 生态需以 sidecar 引入」——
  adapter 进程正是那个 sidecar，我们只是不再额外包一层。
- **协议本身没有 Node 特有的东西**。JSON-RPC over stdio，Rust 说得一样好；
  而 Rust 侧已经有成熟的子进程管理（超时、进程组、输出上限），
  再写一份 Node 的等于重复那些踩过的坑。

## 代价

- Rust 侧要自己实现 JSON-RPC 帧解析与请求路由。这部分不复杂
  （行分隔的 JSON），但要自己写测试。
- 将来若有只提供 Node SDK 的 ACP 能力（比如某个 adapter 只给 JS 客户端），
  得回头补 sidecar。届时 runtime 注册表还在，改动局限在一处。

## 影响

- 契约不变、UI 不变、事件流不变 —— 这是实现层的选择。
- `services/acp-sidecar` 的测试继续守着 runtime 注册表的正确性。
