# UI 对比审查（codex）

## 审查范围与结论

- 基准视口：1440 × 900；原型从 `docs/design/client/AI Workflows 客户端.dc.html` 直接渲染并逐项点击左侧导航，实现从 `http://localhost:5173` 逐路由打开。
- 临时截图与 Playwright 量测脚本均在 `/tmp`，未写入仓库。数值引用为浏览器 `getBoundingClientRect()` / `getComputedStyle()` 的实际结果。
- 10 个原型屏均已覆盖。当前没有“已核对，一致”的整屏：概览、编辑器、执行记录、模型已有主体实现但仍有未被 `blueprint.spec.ts` 覆盖的差异；记忆、Agent、提示词、设置、首次配置仍明显未达到原型；技术架构路由缺失。
- 本报告只记录 UI/信息层级差异，不把原型演示数据与本地实时业务数据的条数差异本身判为缺陷；但“有数据仍不默认选中”“组件没有接收真实状态”等确定的界面行为会列出。

## 屏：全局外壳（10 屏共用）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 标题栏上下文与运行态 | 显示仓库 `~/code/atlas-api`、当前工作流 `GitHub Issue 修复`，并常驻“1 个运行中”（原型 HTML:34-46） | `AppShell` 未向 `TitleBar` 传 `workdir` / `activeRuns`（`apps/web/src/AppShell.tsx:35`）；组件退回“尚未授权工作目录”，且 `activeRuns=0` 时完全隐藏运行态（`apps/web/src/layout/TitleBar.tsx:23,39,53-58`） | 所有路由顶部都丢失工作区/工作流层级和运行状态；当前页面菜单名被当作第二级面包屑，不是原型的任务上下文。 |
| 左栏权限与环境状态 | “Workspace Safe”卡片 + “环境正常 · Git 2.45 · gh 2.52”（原型 HTML:62-68） | `AppShell` 只传空计数 `counts={{}}`（`apps/web/src/AppShell.tsx:37-38`），未传 `permission` / `environment`，因此固定显示“未设置权限档”“环境尚未检查”（`apps/web/src/layout/SideNav.tsx:52-70`） | 底部常驻状态在已有后端的页面中仍呈未配置态，和原型的安全状态表达相反。 |

### 🟡 数值有出入但观感接近

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 导航项密度与选中轮廓 | 34px 高、`padding:0 10px`、gap 10px、13px 字号、8px 圆角，选中态还有 1px 内描边（原型 HTML:1768-1770） | 实测高 30.56px、`padding:5.6px 8.4px`、gap 8.4px、12.5px 字号、圆角 0；来源为 `var(--space-2/3)` 与 `var(--radius-sm)`（`apps/web/src/styles.css:249-270`） | 左栏整体比原型更密、更方，选中项像一条直角色带。圆角为 0 的根因是 `@theme inline` 把 `--radius-sm/md/lg` 自引用（`packages/ui/src/styles/tokens.css:105-116`），浏览器最终取不到令牌。 |
| 标题栏留白与交通灯 | 水平 padding 16px、gap 14px，并有三枚 12px 交通灯和分隔线（原型 HTML:27-38） | 实测 padding/gap 均为 11.2px（`apps/web/src/styles.css:29-33`）；Web 形态不渲染交通灯/分隔线（`apps/web/src/layout/TitleBar.tsx:16-18,30-35`） | 标题栏内容整体向左收 4.8px，Web 截图也少了原型左上角的窗口层级锚点。 |
| 主导航图标语义 | 编辑器/执行记录/Agent/提示词/设置/首次配置依次用 `graph`、`clock-counter-clockwise`、`user-circle-gear`、`text-aa`、`sliders-horizontal`、`download-simple`（原型 HTML:1752-1761） | 分别改为 `flow-arrow`、`list-checks`、`robot`、`quotes`、`gear`、`rocket-launch`（`apps/web/src/navigation.ts:26-44`） | 图标都“意思接近”但不是验收稿那套；尤其执行记录由“历史时钟”变成清单、首次配置由“下载”变成火箭。 |

## 屏：01 工作流首页（`/`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 四张统计卡内容 | 四张卡均有大数字及副说明：1 / 12 / 1.24M / 3（原型 HTML:88-104） | `OverviewPage` 调用四次 `Stat` 时都不传 `value` / `note`（`apps/web/src/pages/OverviewPage.tsx:110-115`），`Stat` 把缺省值渲染为空字符串（同文件:234-256） | 当前页面留下四块大面积空卡，只剩标题；这是用户一眼可见的未完成态。 |
| 工作流列表的层级 | 外层是有 1px 边框、10px 圆角、surface 底色的容器；内部为 5 列网格，首列有工作流类型图标，末列固定 90px 放运行/重试与更多操作（原型 HTML:117-155） | 直接渲染 4 列原生表格，无外层卡片边框/圆角、无工作流图标、无操作列（`apps/web/src/pages/OverviewPage.tsx:177-224`；`apps/web/src/styles.css:569-610`） | 虽然字段名接近，但视觉上从“可操作的工作流卡表”变成普通只读数据表，列对齐和行内操作层级均丢失。 |

### 🟡 数值有出入但观感接近

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 内容区宽度 | 屏占满主区 1224px，左右 padding 32px，内容宽 1160px（原型 HTML:74；实测右边界 x=1408） | `.overview` 额外 `max-width:1180px`，实测外宽 1180px、内容宽 1116px、右边界 x=1364（`apps/web/src/styles.css:417-420`） | 整页比图纸窄 44px，右侧留下不对称空白；统计卡与表格都随之变窄。 |
| 统计卡高度 | 实测 99.20px（原型 HTML:88-104） | 实测 86.81px；实现给 28px 数值行强制 `line-height:1.1`（`apps/web/src/styles.css:495-503`） | 每张卡短约 12.39px，首屏纵向节奏明显更扁。 |
| 搜索框圆角与内部 gap | 8px 圆角、图标到文案 gap 8px（原型 HTML:81-83） | 实测圆角 0、gap 5.6px；使用失效的 `--radius-md` 和 `--space-2`（`apps/web/src/styles.css:447-470`；`packages/ui/src/styles/tokens.css:105-116`） | 尺寸 250×32 对了，但仍呈直角且内容更挤，是“看起来差不多但不是那版”。 |

## 屏：02 画布编辑器（`/editor`、`/editor/:workflowId`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| `/editor` 入口态 | 进入该屏就是 50px 工具栏 + 节点库 + 画布（原型 HTML:161-175,197-252） | 无 `workflowId` 时改为通用文章空态“先在概览与工作流里选一个…”（`apps/web/src/editor/EditorPage.tsx:180-190`） | 任务指定的 `/editor` 路由并非原型屏，而是一张几乎空白的说明页；只有从列表进入参数路由后才出现编辑器结构。 |
| 等待审批横幅 | 工具栏下有紫色强调横幅，包含手掌图标、等待时长、变更/测试摘要、“查看 Diff”“处理审批”（原型 HTML:177-185） | 编辑器主体只依次渲染工具栏、启动弹窗、错误、版本抽屉和画布（`apps/web/src/editor/EditorPage.tsx:196-258`），没有审批横幅或对应状态入口 | 原型最醒目的当前运行状态层级完全缺失；即使运行处于等待审批，编辑器也无位置呈现。 |
| 节点库分组层级 | 15 类节点按“AI 能力 / 流程与编排 / 人与通知 / 脚本与环境”四组显示，组标题为 10px 大写字距；条目是 30px 高卡片（原型 HTML:1839-1867） | 把 `NODE_LIBRARY` 展平成一个数组后直接连续渲染，DOM 中无任何组标题（`apps/web/src/editor/NodeLibrary.tsx:20-38,55-82`） | 节点仍都能找到，但信息架构被压成一条长列表；不同安全/执行类别无法扫视区分。 |

### 🟡 数值有出入但观感接近

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 工具栏动作顺序 | “版本 / 发布版本 / 运行”三个动作（原型 HTML:171-174） | 在“版本”和“发布版本”之间新增常驻“已保存/保存草稿”按钮（`apps/web/src/editor/EditorToolbar.tsx:84-94`） | 多一个按钮改变右侧对齐和动作主次；保存状态应如何表达需要按图纸另找位置，而不是插入主操作链。 |

### 🟢 细节建议

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 节点库文案与图标 | AI 分类条目显示“分析/审查/决策/执行”；条件分支用 `ph-arrows-split`，环境变量用 `ph-brackets-curly`（原型 HTML:1840-1843,1847,1857） | AI 条目显示“AI · 分析”等（`packages/contracts/src/nodes/definitions.ts:97-100,116-119,140-143,176-179`）；两个图标分别为 `ph-git-fork`、`ph-sliders-horizontal`（`apps/web/src/editor/nodeVisuals.ts:38,46`） | 小文案更长，且两个图标不是图纸选择；在 186px 窄栏里会进一步削弱分组扫视。 |

## 屏：03 执行记录（`/runs`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 初始选中与三栏信息密度 | 初始 `runSel='r1'`，一进入就同时看到选中的运行、节点进度和完整详情（原型 HTML:1528,259-354） | Store 初始 `selectedId:null`，`load()` 只更新列表、不选第一条（`apps/web/src/runs/runsStore.ts:84-105`）；未选择时中栏/右栏显示两句空态（`apps/web/src/runs/RunsPage.tsx:170-184,281-283`） | 即使后端返回运行列表，首屏仍有约三分之二面积为空，和原型的“默认展开最近一次”完全不同。 |

### 🟡 数值有出入但观感接近

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 左栏工具图标 | 小标题右侧同时有筛选 `funnel-simple` 与刷新 `arrows-clockwise`（原型 HTML:263-267） | 只实现刷新按钮（`apps/web/src/runs/RunsPage.tsx:67-79`） | 筛选图标缺失；虽然下方已有 chips，但图纸明确保留了进一步筛选入口。 |
| 筛选文案 | “全部 / 进行中 / 等待审批 / 失败”（原型 HTML:1974-1982） | “全部 / 运行中 / 待审批 / 失败”（`apps/web/src/runs/RunsPage.tsx:17-22`） | 两处常驻文案被近义改写，且“进行中”在图纸语义里包含运行中与等待审批，实现的 `running` 过滤只含 `running`（`apps/web/src/runs/runsStore.ts:43-50`）。 |
| 详情 Tab 顺序与名称 | “对话 / 事件 / 产物”，默认事件（原型 HTML:2257-2262；状态默认见 HTML:1613） | “事件流 / 产物 / 对话”（`apps/web/src/runs/RunsPage.tsx:24-30,254-269`） | 顺序、首项和“事件”文案均不一致，用户的浏览路径被重新排列。 |
| 详情内容对齐 | 标题、Tab 内容、事件卡与底部输入框都放在 `min(680px,88%)` 容器中并水平居中（原型 HTML:333-353,373-384,567-585） | 标题和 Tab 直接用 26px 左右 padding；事件列表 `width:min(680px,100%)` 但左对齐（`apps/web/src/styles.css:2224-2229,2356-2363,2386-2403`） | 宽屏下详情流贴左，右侧出现大片空白；原型的阅读列中轴丢失。 |

## 屏：04 记忆管理（`/memory`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 整屏结构 | “Memory / 全局记忆”页头、搜索/历史/新建、5 个作用域、AI 提议卡、四列表格、安全说明和 420px 编辑抽屉（原型 HTML:592-705） | 路由没有真实内容，被统一送入 `PlaceholderPage`（`apps/web/src/pages/index.tsx:33-63`），只显示“记忆 / 管理长期上下文 / 当前是 M0…”（`apps/web/src/pages/PlaceholderPage.tsx:15-27`） | 不是布局微差，而是整屏功能与信息层级尚未实现。 |

## 屏：05 Agent 角色（`/agents`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 整屏结构 | 250px 角色列表 + 详情编辑区；详情含人格、Runtime/模型、权限、工具白名单与输出契约（原型 HTML:710-800） | 路由落入通用 `PlaceholderPage`，只有标题、摘要和里程碑说明（`apps/web/src/pages/index.tsx:33-63`；`apps/web/src/pages/PlaceholderPage.tsx:15-27`） | 原型的主从层级、角色状态标签和所有配置卡均缺失。 |

## 屏：06 提示词库（`/prompts`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 整屏结构 | 266px 可搜索/分组的提示词列表 + 右侧版本化编辑器；包含模板/变量/运行时预览/版本四个 Tab（原型 HTML:899-990） | 路由落入通用 `PlaceholderPage`（`apps/web/src/pages/index.tsx:33-63`），只显示“提示词库”说明与 M0 文案（`apps/web/src/pages/PlaceholderPage.tsx:15-27`） | 列表、编辑区、变量层级、状态与版本样式全部缺失。 |

## 屏：07 模型（`/models`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 初始选中与详情 | 初始 `modelSel='m2'`，页面直接展开 Codex 5.6 · high（原型 HTML:1530-1534,830-893） | `selectedId` 初始为 `null`，加载后不自动选择；只有用户点击列表才展开详情（`apps/web/src/models/ModelsPage.tsx:36-59,252-254`） | 有模型数据时首屏仍只显示“选一个模型…”空态，右侧大面积留白。左栏 262px 和两侧 padding 虽已通过现有测试，但首屏层级仍不对。 |
| 详情动作与下半区 | 顶部有“测试连通性 / 停用 / 删除 / 保存”；卡片含计费与限流；ACP 提示带 3 个导入动作；底部还有模型策略映射（原型 HTML:837-840,856-893） | 顶部仅停用/删除（`apps/web/src/models/ModelsPage.tsx:158-185`）；凭据卡只显示凭据/延迟（同文件:213-226）；ACP 块只剩说明（同文件:241-250），没有导入按钮或策略映射 | 主体看似相似，但关键动作和约三分之一的信息区块被删掉，详情页明显比原型短且能力不完整。 |

### 🟡 数值有出入但观感接近

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 接入方式分组 | 按 `ACP · Codex`、`ACP · Claude Code`、`HTTPS · OpenAI 兼容`、`HTTPS · Anthropic`、`HTTPS · 自建网关` 分组（原型 HTML:1531-1539；列表模板 HTML:813-825） | 只映射 `Codex（ACP）`、`Claude Code（ACP）`、`API 提供商` 三类（`apps/web/src/models/ModelsPage.tsx:24-33,102-108`） | HTTPS 提供商/自建网关的层级被合并，左栏分组无法达到原型的可扫视粒度。 |

### 🟢 细节建议

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 可用状态文案 | 列表用“可用 / 不可用 / 已停用”，详情用“可用 · 最近测试通过”（原型 HTML:2521,2624） | 列表和详情统一成“已启用 / 已停用”（`apps/web/src/models/ModelsPage.tsx:127-129,160-164`） | “启用”只表达配置开关，原型的“可用”还表达连通性；状态信息被压扁。 |

## 屏：05 设置与环境（`/settings`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 整屏结构 | 184px 二级设置导航 + “运行环境健康”详情；含 Ready 状态条、5 行能力表和三档权限策略（原型 HTML:994-1027） | 通用页面标题下只挂一个“版本”更新卡；`SettingsPage` 明确只返回 `UpdateCard`（`apps/web/src/pages/SettingsPage.tsx:5-13`），Web 形态卡片只有版本文案（`apps/web/src/updater/UpdateCard.tsx:35-43`） | 设置导航、健康检测表、状态图标、权限策略卡全部缺失；当前画面不是原型中的任何设置分区。 |

## 屏：06 首次安装与检测（`/onboarding`）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 整屏结构 | 居中的 860px 四步向导，包含设备检测、工具安装表、命令预览、ACP 探测、系统权限、写入路径和底部动作（原型 HTML:1033-1123） | 路由落入通用 `PlaceholderPage`，只显示“首次配置 / 装好即可用 / 当前是 M0…”（`apps/web/src/pages/index.tsx:24-25,52-63`；`apps/web/src/pages/PlaceholderPage.tsx:15-27`） | 向导进度、安装状态色、表格、权限卡和操作区全部缺失。 |

## 屏：07 技术架构（实现无对应路由）

### 🔴 明显走样

| 项 | 原型 | 实现 | 差异 |
|---|---|---|---|
| 导航与整屏 | 左栏有“技术架构”入口；页面包含架构标题、完整选型文档按钮、三层架构卡、Core API/MCP 强调卡和两张选型说明卡（原型 HTML:1128-1171,1761） | `NAV_ITEMS` 在“首次配置”结束，没有技术架构项（`apps/web/src/navigation.ts:18-45`）；访问 `/architecture` 落入 `NotFoundPage`（`apps/web/src/pages/NotFoundPage.tsx:4-12`） | 原型第 10 屏完全缺失，且无法从实现导航到达。 |

## 优先修正顺序

1. 先补齐缺失整屏：技术架构、记忆、Agent、提示词、设置、首次配置。
2. 再修已有主屏的首屏层级：Runs/Models 默认选中、编辑器审批横幅、节点库分组、首页表格外观与操作列。
3. 最后统一全局令牌与细节：修复圆角自引用、恢复 34px 导航密度、校正图标/文案/详情阅读列。
