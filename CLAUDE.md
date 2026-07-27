# 给 AI 协作者的说明

这个仓库按图纸施工，功能以测试先行为基准。动手前请先读：

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 分层与依赖方向
2. [docs/TESTING.md](docs/TESTING.md) —— 测试先行的具体要求
3. [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) —— 契约变更、加组件、加节点的流程

## 图纸在哪

`docs/design/client/` 是设计图纸（可交互原型 + 功能文档与里程碑 + 技术选型 + Nocturne 设计系统）。
实现要对得上图纸；**不一致时先改文档或记一条 ADR，不要静默偏离**。

## 硬性约束

这些不是偏好，违反了会破坏产品承诺：

- **契约是单一真源**。改 `packages/contracts` 要先改测试，改完跑 `pnpm contracts:gen`
  并提交生成物。不要手改 `generated/`
- **不要绕过 Core API**。UI 不直连数据库，MCP 不直连数据库，AI 的写操作走结构化 Patch
- **RunEvent 是唯一事实来源**。不要为某个视图新建状态表或从消息文本里拼状态
- **安全基元的改动必须配用例**。PathGuard、Redactor、能力校验——
  新增一种绕过方式的防护就补一条测试
- **Secret 只进 Keychain**。仓库里、事件里、日志里、导出物里都不能有明文，
  用 `keychain://` 引用
- **每个 UI 组件配 stories**（函数形式 + `Frame` 包裹），否则无法单独预览验收

## 常用命令

```bash
pnpm verify                          # 提交前的完整门禁
pnpm test                            # TS 测试
pnpm rs:test                         # Rust 测试
pnpm contracts:gen                   # 重新生成 JSON Schema
pnpm --filter @aiwf/ui preview       # 组件画廊 → localhost:5175
pnpm dev                             # Web 形态开发服务器
```

## 当前进度

M0（地基）已完成，见 [docs/ROADMAP.md](docs/ROADMAP.md)。
下一步是 M1（设计态）：节点库、无边界画布、Schema 驱动的配置表单、草稿与版本发布。

写代码前先确认这件事属于哪个里程碑——提前做后面的阶段会让前面的地基失去验证机会。

## 风格

- 注释与文档用中文，标识符用英文
- 注释解释「为什么」，不复述「是什么」
- 命名用完整词。这个项目的读者包括半年后的你
