# 系统级 MCP：把整个应用接给你的 AI 客户端

这个应用自带一个 MCP Server。接上之后，Claude Code 与 Codex 能**读懂这个系统**
（它是什么、有哪些节点、端口叫什么、现在有哪些角色与模型），
也能**操作它**（设计工作流、发起运行、回头分析执行数据）。

它是 Core API 面向 Agent 的适配层 —— 工具清单由契约派生，调用一律经
`aiwf_core_api::dispatch`。没有直连数据库或文件的路径：绕过 Core API
就等于绕过版本守卫与审计，AI 一旦写坏，既解释不清也回滚不了。

## 一键接入

**设置与环境 → MCP 与集成 → 一键接入。** 它会替你跑对应客户端的
`mcp add`，把地址与令牌写进去。

服务跟着应用一起起来，监听 `127.0.0.1`，默认端口 5178（被占就往后挪，
挪到的端口会存回配置，客户端里那个地址不会失效）。

想自己跑一遍的话：

```bash
# Claude Code
claude mcp add --transport http --scope user aiwf \
  http://127.0.0.1:5178/mcp \
  --header "Authorization: Bearer <令牌>"

# Codex
codex mcp add aiwf --url http://127.0.0.1:5178/mcp/<令牌>
```

令牌在「MCP 与集成」那一档，点「显示」能看到；也在
`<应用数据目录>/mcp.json`（权限 0600）。

### 为什么两个客户端的令牌位置不一样

不是风格问题，是它们各自支持什么：

| 客户端      | 令牌怎么带                           | 原因                                                                                                  |
| ----------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Claude Code | `--header "Authorization: Bearer …"` | 它支持自定义头                                                                                        |
| Codex       | 令牌在 URL 路径里                    | `codex mcp add --url` 只认「从环境变量读 bearer」或 OAuth；<br>要一键就不能要求用户先 export 一个变量 |

服务端两种都认。

### 不用桌面壳时

有一个独立二进制，接同一个数据库：

```bash
cargo run -p aiwf-mcp --bin aiwf-mcp -- --db ~/Library/Application\ Support/aiwf/aiwf.sqlite
```

它会把两条 `mcp add` 命令直接打印出来。用 MCP Inspector 调试也走它。

## 传输：Streamable HTTP

按 MCP 规范 2025-03-26 引入、2025-11-25 仍在用的那套。单一端点 `/mcp`：

| 方法     | 行为                                                               |
| -------- | ------------------------------------------------------------------ |
| `POST`   | 收 JSON-RPC 消息。请求回 JSON；通知与响应回 `202 Accepted` 空 body |
| `GET`    | 回 `405` —— 服务端不主动往客户端推消息                             |
| `DELETE` | 带 `Mcp-Session-Id` 结束会话                                       |

协议版本**按客户端要的回**，认 `2025-11-25` / `2025-06-18` / `2025-03-26` /
`2024-11-05`。写死一个版本的话，装着旧版客户端的机器会在握手时断开，
而症状是「加了 server 但工具列表是空的」。

`initialize` 的响应带一个新的 `Mcp-Session-Id`。认不出来的会话 id 回 `404`，
客户端据此重新握手。会话闲置一小时清掉 —— 客户端退出时不一定发 DELETE。

## 安全

规范里的三条要求，一条都不能省。少一条，任何网页都能通过 DNS 重绑定
打到你本机这个端口，而这个端口能删工作流、能起运行。

1. **校验 `Origin`**。原生客户端不发 Origin，那是正常的；带 Origin 的
   一定是浏览器，那时只认 `localhost` / `127.0.0.1` / `[::1]`。
   `http://127.0.0.1.evil.com` 这种也挡得住 —— 比的是主机名整段，不是前缀。
2. **只绑 127.0.0.1**，不绑 `0.0.0.0`。
3. **令牌鉴权**。24 字节随机数，来自 `/dev/urandom`（不用时间戳做种：
   那可预测）。存在单独的 `mcp.json` 里而**不进 `workspace_setting`**——
   那张表会被诊断包导出、也显示在界面上。

**刻意没有 CORS 头。** 加一个 `Access-Control-Allow-Origin: *` 会让第 1 条
彻底作废，而客户端是原生进程，不需要 CORS。

## 暴露了什么

### 工具（50 个契约派生 + 1 个内建）

清单 = 契约里声明的方法 ∩ 引擎真的能分派的命令。**由契约派生，不手工维护**——
手写一份的结局是「界面上能做的事，Agent 说它做不到」，而这种缺口只有
用户碰上了才知道。`crates/mcp/tests/catalog_test.rs` 守着这条。

清单之外有一个内建工具 `ask_user`：agent 向用户提一个问题
（choice / multiChoice / form / confirm），调用挂起直到用户在应用里回答
（最长三分钟），答案原样带回。它不是某个 Core API 命令的镜像，
所以不走派生 —— `dispatch` 从进门持库锁到返回，挂着等回答的调用放进去，
用户提交答案的那条会被同一把锁挡在门外。入参 schema 来自契约生成物
`ask-spec.schema.json`，行为由 `crates/mcp/tests/ask_user_test.rs` 守着。
用户拒绝回答报 `declined`、没人理会报 `no_answer`，两者都不是空答案 ——
空对象会被 agent 当成「用户什么都没选」。

| 类别    | 覆盖                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------- |
| 工作流  | list / get / create / patch / validate / diff / publish / rollback / rename / delete / versionGraph     |
| 运行    | start / dryRun / list / get / events / artifacts / artifactContent / cancel / resume / rewindToApproval |
| 审批    | decide                                                                                                  |
| 记忆    | list / create / update / toggle / delete                                                                |
| 提示词  | list / create / update / versions / duplicate / delete                                                  |
| Agent   | list / create / update / duplicate / delete                                                             |
| 模型    | list / create / update / delete                                                                         |
| 工作区  | settings / updateSettings / stats / env.health                                                          |
| 主管 AI | ask / sessions / session                                                                                |

**不开放的只有两类，各有各的理由：**

- 确认通道本身（`mcp.requestConfirm` / `confirmStatus` / `pendingConfirms` /
  `decideConfirm`）。把 `decideConfirm` 给 Agent，等于让它批准自己的写操作。
- `workflow.saveDraft`（整份回写）。那是留给界面的路 —— 界面在本地已经
  走过一次 applyPatch，Diff 给用户看过了。开给 Agent 就是给
  `workflow.patch` 的版本守卫与结构化审计开了一条旁路。

另外，契约里 `scope: null` 的方法（`model.test`、`run.diagnostics`、
`env.diagnostics`）按定义是本地专属，不对 MCP 开放。

### 资源（7 份系统知识）

工具回答「我能做什么」，资源回答「这个系统是什么」。只给工具的话，
Agent 得靠工具名去猜节点类型叫什么、端口叫什么 —— 猜出来的图连不上线，
它再试一次，几轮之后开始编造不存在的节点类型。

| URI                           | 内容                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `aiwf://guide/overview`       | 这个系统是什么、每一屏能干什么、草稿与版本的区别       |
| `aiwf://guide/build-and-run`  | 从零设计一条工作流并跑起来：该按什么顺序调哪个工具     |
| `aiwf://guide/read-run-data`  | 怎么读一次运行的完整数据：九类事件分别回答什么问题     |
| `aiwf://catalog/nodes`        | 16 种节点：端口 + 配置字段（中文标签、必填、默认值）   |
| `aiwf://catalog/node-configs` | 配置的完整 JSON Schema                                 |
| `aiwf://catalog/contracts`    | 事件类型、状态机、Patch 操作名、方法表                 |
| `aiwf://workspace/inventory`  | **实时**：现有的工作流、Agent 角色、提示词、模型、记忆 |

最后一份最要紧：AI 节点的 `agentProfileId` 必须来自 inventory。
编一个不存在的 id，图能存进去，但要到 Dry Run 才暴露。

### 提示词模板

`design_workflow`（把一句话的目标变成一条跑得通的工作流）与
`diagnose_run`（读完整事件流，说清哪一步出了问题）。

## 写操作要不要先确认

挂在**权限档**上，与节点执行同一个开关（设置与环境 · 权限策略）：

| 档位                | 行为                                         |
| ------------------- | -------------------------------------------- |
| Review Every Change | 任何写操作都先提交给用户确认                 |
| Workspace Safe      | 改草稿与写记忆放行；发布、运行、删除仍要确认 |
| Trusted Workflow    | 全放行                                       |
| 认不出来的值        | **按最严处理**                               |

被挡住时工具返回 `isError: true` 并说清在等什么 —— 用户在应用里点
「同意」之后 Agent 再调一次即可。

不在这里另起一套判断，是因为用户在「设置与环境」里调的是同一个开关，
两处行为不同会让他无从预期。

## 排查

| 症状                      | 多半是                                                     |
| ------------------------- | ---------------------------------------------------------- |
| 加了 server 但工具是空的  | 握手失败。用 `curl` 打一次 `initialize` 看回什么           |
| 401                       | 令牌不对。「MCP 与集成」里重新复制一次                     |
| 403                       | Origin 被拒。从浏览器打的话这是预期行为                    |
| 404 且带 `Mcp-Session-Id` | 会话过期了，重新 `initialize`                              |
| 一键接入点了没反应        | 服务没起来。看「MCP 与集成」里的状态条 —— 那是真的探了一次 |

手动探一次：

```bash
curl -s -X POST http://127.0.0.1:5178/mcp/<令牌> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
```

## 主管 AI 也走这条

应用内的主管 AI 通过 ACP 的 `session/new` 把同一个 MCP 接给自己的 agent
（两个 adapter 都声明了 `mcpCapabilities.http`）。所以它与外部客户端
看到的是**同一份能力与同一份知识** —— 不存在「界面里的 AI 知道得更多」
这种差异。
