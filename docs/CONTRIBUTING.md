# 协作约定

## 提交前

```bash
pnpm verify
```

等价于 CI 会跑的全部门禁。别指望 CI 帮你发现格式问题——那是浪费一轮往返。

## 分支与提交

- 从 `main` 切分支：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`
- 提交信息用中文，首行不超过 50 字，说明**做了什么以及为什么**，不是文件清单
- 一个提交只做一件事；重构与功能分开提交
- push 到 `main` 会触发一次 nightly 发布（见 [RELEASE.md](RELEASE.md)），
  所以 `main` 上的每个提交都应当是可运行的

## 契约变更流程

`packages/contracts` 是 UI、引擎、MCP 三方共用的真源，改它等于改所有人的地基。

1. 先改 `tests/`，用测试描述新的期望行为
2. 再改 `src/`
3. `pnpm contracts:gen` 重新生成 JSON Schema 并一并提交
4. 如果 Rust 侧有对应镜像（状态机、事件类型），同步更新并让 `contract_sync_test` 通过
5. 破坏性变更：递增 `CONTRACTS_VERSION`，在 PR 描述里写明影响面，并记一条 ADR

**不要**手改 `packages/contracts/generated/` —— CI 会打回。

## 加一个 UI 组件

组件必须能被单独预览与验收，所以每个组件都要配套三样：

1. `src/components/<Name>.tsx` —— 语义与状态在组件里，外观全部来自令牌
2. `src/components/<Name>.stories.tsx` —— 预览用例，**写成函数形式**
3. `tests/` 里的渲染测试 —— 无障碍关联、空态、禁用态、键盘操作

预览用例的约定：

```tsx
import { Frame } from './_frame.js';

// 一律用函数形式：CSF 的 args 对象形式会被 Preview.js 用空 props 渲染，看到的是空组件
export const Primary = () => (
  <Frame>
    <Button variant="primary">开始运行</Button>
  </Frame>
);
```

`Frame` 负责引入设计系统 CSS 并铺深色底——组件的令牌是为暗底设计的，
落在白底上等于看不见。

两种查看方式：

```bash
pnpm --filter @aiwf/ui preview     # 组件画廊 → http://localhost:5175
```

或在 VSCode 里用 Preview.js 插件打开组件文件（需要包内的 vite 版本与插件内置版本一致）。

除基本变体外，每个组件再给一条**组合场景**用例（整排审批按钮、全部状态并排），
一屏就能看出间距、对齐与对比度问题。

## 加一种节点类型

1. 在 `packages/contracts/src/nodes/index.ts` 追加定义（配置 Schema、端口、默认能力、是否外部写操作）
2. 在 `NODE_LIBRARY` 里决定它在节点库中的展示位置
3. 补 `tests/nodes.test.ts` 的最小配置用例
4. `pnpm contracts:gen`

**不需要改 UI 代码**——配置表单由 Schema 驱动渲染。如果发现必须改 UI，
说明 Schema 的表达力不够，那是要先解决的问题。

## 改安全相关的代码

PathGuard、Redactor、能力校验、审批授权——这几处的改动要求：

- 新增一种绕过方式的防护，就补一条对应的用例
- 放宽任何限制，要在 PR 描述里说明**为什么这个放宽是安全的**
- 不接受「先合了再说，后面补测试」

## 代码风格

- 注释写「为什么」，不写「是什么」。代码本身能说明是什么
- 命名用完整词，别用缩写。这个项目的读者包括半年后的你
- 中文注释与文档；标识符用英文
- Rust：`unsafe` 被 workspace 级禁用；`unwrap` / `expect` / `panic` 在生产代码里是警告（测试里已豁免）
- TypeScript：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 全开，别关

## 依赖

加依赖前先问：这个能力值不值一个依赖？

- 加进 `pnpm-workspace.yaml` 的 `allowBuilds` 才允许跑安装脚本——供应链最小信任面
- Rust 侧公共依赖走 `[workspace.dependencies]`，避免版本漂移
