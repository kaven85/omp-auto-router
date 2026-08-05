# omp-auto-router 优化与扩展机会调研报告

> 调研日期：2026-08-05 · 版本基线：0.1.0（`package.json:3`）
> 方法：通读 `src/core/`（21 模块，3685 行）与 `src/omp-adapter/`（8 模块）全部源码、`tests/`（25 个测试文件）、omp 扩展文档（`omp://extensions.md`）、上游 [danialranjha/pi-auto-router](https://github.com/danialranjha/pi-auto-router) README 与关键源码。
> 所有结论均标注一手来源。Rust/WASM 迁移已另行否决，不在本报告范围。

---

## 1. 优化项（现有功能的缺口与粗糙点）

### A. README 宣称但代码未闭环（功能缺口，优先修）

#### A1. thinking 联动只到状态栏，未到请求 ⚠️ 最重要缺口

- **宣称**：README.md「能力一览」：「层级联动模型 + thinking 强度」；配置参考 tier 表：`thinking` —「联动 omp thinking 强度」；内置默认配置也写了 `thinking: low/medium/high`（`src/omp-adapter/config.ts:32/36/43`）。
- **现状**：pipeline 计算 `decision.thinking`（`src/core/pipeline.ts:270`），状态栏展示它（`src/omp-adapter/router.ts:194`），`useage` 命令统计它（`router.ts:236-242`）——但 **没有任何代码把它应用到真实请求**：
  - `HostPorts.setThinkingLevel` 端口存在但零调用方（`src/core/host-ports.ts:40`；实现 `src/omp-adapter/host-ports.ts:46-48`；全仓库 grep 无调用）。
  - 委派流的 options 只透传原始 options + apiKey，未注入 thinking/reasoning 参数（`src/omp-adapter/router.ts:80-89`）。
- **建议**：两条路线二选一：(a) 确认 pi-ai `streamSimple` options 是否接受 thinking/reasoning 字段，在 `buildFactory` 注入；(b) 请求前 `pi.setThinkingLevel(decision.thinking)`，流结束后恢复原值（需注意并发与中止语义）。
- **收益**：高（用户配置的核心心智模型就是「复杂度 → 模型 + thinking」双联动；当前只有模型一半生效）。**工作量**：中（依赖对 pi-ai options 的一次核实）。

#### A2. profile 级 `budgets` 配置解析了但不生效

- **宣称**：README.md 完整示例含 `budgets: { google: { amount: 20, monthly: true } }`，配置参考 profile 表列出 `budgets` 字段。
- **现状**：config-loader 解析进 `profile.budgets`（`src/core/config-loader.ts:304-314`），`/auto-router show` 展示它（`src/omp-adapter/commands.ts:428-430`），但 pipeline 只读 `BudgetTracker` 的 limits（`src/core/pipeline.ts:228`），而 limits 只能由 `/auto-router budget set` 写入（`commands.ts:484`）。**配置文件里写的 budgets 永远不会约束路由。**
- **建议**：路由前将 active profile 的 `budgets` 与 tracker limits 合并（profile 配置为下限/默认值，命令行 set 覆盖），或在 profile 激活/ reload 时同步进 tracker。
- **收益**：高（文档示例直接误导用户以为已受保护）。**工作量**：低。

#### A3. `balanceEndpoint` target 字段是死配置

- **宣称**：README.md target 表：`balanceEndpoint` —「自定义余额 API（per-token 提供商）」。
- **现状**：字段被解析进 `RouteTarget.balanceEndpoint`（`src/core/types.ts:32-33`、`src/core/config-loader.ts:103-106`），此后无任何消费方。唯一的余额抓取把 DeepSeek 的 URL 硬编码在命令层（`src/omp-adapter/commands.ts:213-222`，`https://api.deepseek.com/user/balance`）。
- **建议**：实现通用 balance fetcher（target 级 `balanceEndpoint` 优先，内置 registry 兜底；响应解析器可配置或按 provider 注册），或删除该字段并修正 README。
- **收益**：中。**工作量**：中。

#### A4. `cooldownUntil` 有消费方、无生产方（死路径）

- **现状**：`CandidateInfo.cooldownUntil` 定义于 `src/core/types.ts:145-146`，constraint-solver 会排除冷却中的候选（`src/core/constraint-solver.ts:74-76`），但全仓库无任何代码赋值——`enrichCandidates` 构造候选时不带它（`src/omp-adapter/host-ports.ts:155-178`）。上游明确实现了「可重试失败 → 目标进入临时冷却」（上游 README "Behavior notes"：*Retryable failures put the target on a temporary cooldown*）。
- **建议**：新增轻量 CooldownTracker（`recordFailure` 时设 `cooldownUntil = now + N分钟`，成功清除），在 `enrichCandidates` 注入；或从类型中删除该字段。
- **收益**：中（与熔断互补：熔断管「连续失败」，冷却管「刚失败过先缓缓」）。**工作量**：低-中。

#### A5. UVI hard mode / 置信度阈值 / 全局规则等 pipeline 参数未从适配层接线

- **现状**：pipeline 支持 `uviHardMode`、`confidenceThreshold`、`globalRules`（`src/core/pipeline.ts:59-64`，且 `pipeline.ts:59` 注释已写明 `OMP_AUTO_ROUTER_UVI_HARD`），pipeline 测试覆盖它们（`tests/pipeline.test.ts:171/189/324/343`），但适配层调用 `route()` 时一个都没传（`src/omp-adapter/router.ts:165-174`）。README「局限」节也承认：「`OMP_AUTO_ROUTER_*` 环境开关（如 UVI hard mode）尚未实现」。
- **建议**：读环境变量（或 omp `registerFlag`/`getFlag`，见扩展项 E5）在 router.ts 装配 deps。
- **收益**：中（一个 env 开关即可解锁已测试完成的能力）。**工作量**：极低。

#### A6. 用户评分「反馈闭环」未闭合

- **宣称**：`/auto-router rate` 子命令描述为「给上次决策打分（持久化，驱动反馈闭环）」（`src/omp-adapter/commands.ts:237`）。
- **现状**：`FeedbackTracker.statsFor` 的唯一调用方是 rate 命令自己的回显（`commands.ts:566`）；路由链路完全不读评分。上游同样未实现，但已列入其 ROADMAP 第一优先级（上游 ROADMAP.md #1 Feedback-driven policy rules）。
- **建议**：在 candidate-partitioner 注入 `goodFraction`：低于阈值（如 <40% 且样本 ≥5）的候选 demote 一档；或先只做 `explain` 展示评分（上游已做：*"Per-provider stats appear in /auto-router explain"*）。
- **收益**：中。**工作量**：中。

### B. 已实现但粗糙的逻辑

#### B1. 上下文 token 估算只看最后一条 user 消息 → long/epic 信号几乎不可达

- **现状**：`lastUserText` 只抽取最后一条 user 消息文本（`src/omp-adapter/router.ts:33-51`），pipeline 用 `ceil(文本长度/4)` 估算（`src/core/pipeline.ts:94`）。系统提示、会话历史、工具定义全部不计。后果：
  - 上下文分档信号（4k/32k/100k 边界，`src/core/context-analyzer.ts:14-18`）在真实长会话中严重低估，「长上下文 → standard/complex」这一 README 宣称的触发条件（README.md 复杂度表）实际很难命中；
  - `@long` 的 `minContextWindow = max(100k, estimatedTokens)`（`pipeline.ts:156-158`）中的 estimatedTokens 同样失真。
- **建议**：用 omp `ctx.getContextUsage()`（`omp://extensions.md` "Handler context"）取真实上下文占用，或至少累加 `context.messages` 全部文本 + systemPrompt 再估算。
- **收益**：高（直接修复一个核心分级信号的效度）。**工作量**：低-中。

#### B2. `conversationDepth` 是死参数；sticky escalation 粒度是整个会话

- **现状**：`conversationDepth` 在类型和注释里宣称「同任务连续轮次」（`src/core/types.ts:278-279`、`src/core/complexity-classifier.ts:27-28`），但 `classifyComplexity` 函数体从未解构使用它（解构见 `complexity-classifier.ts:163`）；适配层传入的值是 `state.decisions.list().length`——本会话全部决策数，与「同任务」无关（`src/omp-adapter/router.ts:163`）。同时 sticky escalation 的规则是「会话内永不降级」（`complexity-classifier.ts:259-265`），意味着一次 complex 查询会把整个会话剩余请求钉在 complex 层。README 宣称的是「同任务多轮粘性升级、不降级」（README.md 复杂度分级节）。
- **建议**：引入任务边界判定（如时间间隔 > N 分钟或话题切换即重置 priorTier），或给 sticky escalation 加衰减窗；删除或启用 conversationDepth。
- **收益**：中（影响每次后续请求的成本）。**工作量**：中。

#### B3. 每次请求动态编译 ~70+ 个正则

- **现状**：`countKeywordHits` 对每个关键词 `new RegExp(...)`（`src/core/intent-classifier.ts:76-87`，三类词表合计约 60+ 词）；复杂度分类器对每个 multi-step 整词在 filter 回调内 `new RegExp`（`src/core/complexity-classifier.ts:166-169`）。每个请求都重复编译。
- **建议**：模块加载时预编译为 `readonly RegExp[]`。
- **收益**：低-中（路由热路径延迟与 GC 压力；非瓶颈但修起来零风险）。**工作量**：极低。

#### B4. failover 后延迟统计口径污染

- **现状**：`started` 在整个 failover 链开始前取（`src/omp-adapter/router.ts:202`），`onTargetSettled` 记录的是「链开始 → 某候选产出实质内容」的总时长（`router.ts:231-232`）。若第一候选慢死 30 秒后 failover 到第二候选秒回，第二候选会被记 30+ 秒延迟，污染其滚动均值，进而污染 partitioner 的延迟排序（`src/core/candidate-partitioner.ts:131-150`）。
- **建议**：按候选分别计时（factory 调用时刻起算，需 failover-engine 透出 per-target 开始钩子或在 factory 内包一层计时）。
- **收益**：中（排序正确性）。**工作量**：低。

#### B5. 熔断器与延迟数据不持久化，重启即冷启动

- **现状**：`CircuitBreaker` 纯内存 Map，无 snapshot/restore API（`src/core/circuit-breaker.ts:46`；构造处 `src/omp-adapter/state.ts:92`）。`LatencyTracker` 有 snapshot/restore（`src/core/latency-tracker.ts:63-79`）但适配层从未调用（grep 确认 adapter 侧无 `latency.restore`/`latency.snapshot` 调用）。上游两者都持久化（上游 README：*"Data persists in `~/.pi/agent/extensions/auto-router.latency.json` and survives restarts"*）。
- **建议**：经 `JsonStateStore` 落盘（如 `latency.json`、`circuit.json`），在 session_start 恢复、`session_shutdown`（或每次 record 节流）保存。注意熔断记录带 `openedAt` 时间戳，恢复时需容忍时钟漂移。
- **收益**：中。**工作量**：低。

#### B6. 事件日志与预算用量无界增长

- **现状**：`EventLog.append` 无限追加，无轮转/截断（`src/core/event-log.ts:34-44`）；`size()` 每次全量读文件（`event-log.ts:66-74`）。`BudgetTracker` 的 daily bucket 按 `YYYY-MM-DD` 永久累积，无清理（`src/core/budget-tracker.ts:173-183`）。对比：ratings 有 1000 条上限（`src/core/feedback-tracker.ts:28`），是唯一有界的持久化。
- **建议**：事件日志按大小/天数轮转（保留最近 N MB）；daily bucket 保留最近 62 天即可（月统计不依赖更老的 daily）。
- **收益**：低-中（长期使用后的磁盘与读放大）。**工作量**：低。

#### B7. provider 特定逻辑硬编码在通用适配层

- **现状**：Kimi 窗口标签映射与 provider 展示顺序写死（`src/omp-adapter/commands.ts:88-96`：`KIMI_WINDOW_LABELS`、`PROVIDER_DISPLAY_ORDER`）；DeepSeek 余额 API 写死（`commands.ts:209-222`）。新增 provider 需要改源码。
- **建议**：抽成 provider registry（id → {窗口标签、余额端点、解析器}），配合 A3 一起做。
- **收益**：低-中（可维护性）。**工作量**：低-中。

#### B8. quota 30 秒节流为硬编码常量，且无后台刷新

- **现状**：请求路径上 `30_000` 字面量节流（`src/omp-adapter/router.ts:136-144`），`useage` 命令重复同样的字面量（`commands.ts:617`）。没有定时器后台预热；30 秒窗口内的 UVI 判定用的是旧快照。
- **建议**：常量上移到配置（如 `quotaRefreshSeconds`）；用 `ctx.setInterval` 做后台周期刷新（omp 文档要求后台定时必须走 `ctx.setInterval` 而非裸 `setInterval`——`omp://extensions.md` "Background work"，裸定时器回调抛异常会拖垮整个会话）。
- **收益**：低。**工作量**：低。

#### B9. 每请求重建宿主适配对象 + 每请求轮询模型注册表

- **现状**：`createHostPorts` 每请求新建（`src/omp-adapter/router.ts:95`），`enrichCandidates` 每请求全量重建候选（`router.ts:131`；`src/omp-adapter/host-ports.ts:155-178`），`waitForConfiguredModel` 每请求都可能跑最多 100×50ms=5s 的轮询（`router.ts:93-108`，仅当所有 target 都无法解析时才跑满，但常态下每个请求都至少进入一次循环）。另有 `state.modelsByKey` 缓存（`src/omp-adapter/state.ts:120-124`）与 per-request `ctx.models.resolve` 并存的冗余。
- **建议**：host ports 在 boot 时创建一次（ctx 变化时重建）；`waitForConfiguredModel` 改为仅在「首次请求 / 上次全部解析失败」时启用，成功后标记不再轮询。
- **收益**：低（每请求稳定省掉一段 await 与重复对象分配）。**工作量**：低。

### C. 代码卫生（顺手清理，非功能问题）

| # | 问题 | 证据 | 工作量 |
|---|---|---|---|
| C1 | `useage` 拼写错误扩散到用户可见命令名 `/auto-router useage` | `src/omp-adapter/state.ts:58`（`sessionUseage`）、`src/omp-adapter/commands.ts:233`（SUBCOMMANDS 表）；且 README 命令表完全没有收录该命令 | 极低（加 `usage` 别名，保留旧名兼容） |
| C2 | `loadAdapterConfig`（async）与 `loadAdapterConfigSync` 双实现漂移风险；生产只用 sync 版，测试只测 async 版 | `src/omp-adapter/config.ts:67-91` vs `config.ts:99-124`；`src/omp-adapter/index.ts:37` 用 sync；`tests/omp-adapter/config.test.ts:7` 只 import async 版 | 低（合并共享实现，生产/测试同源） |
| C3 | `sessionId` 死管道：从未赋值（仅 reload 时复制），却一直传给 `getApiKey` | `src/omp-adapter/state.ts:31`、`src/omp-adapter/index.ts:89`、`src/omp-adapter/host-ports.ts:31` | 极低（接上真实 session id 或删除字段） |
| C4 | `HostPorts.appendState/readState` 死端口：适配层实现了（`src/omp-adapter/host-ports.ts:98-110`），但 index.ts 直接调 `pi.appendEntry` / 直读 `sessionManager.getBranch()`（`src/omp-adapter/index.ts:150,209-216`），端口零调用 | `src/core/host-ports.ts:47-50` | 极低（收窄接口或改走端口） |
| C5 | `complexity-classifier.ts` 第 33-34 行注释块出现连续 `/**` `/**`（文档注释嵌套笔误） | `src/core/complexity-classifier.ts:33-34` | 极低 |
| C6 | Mode B 预留完全 inert：`pi.on("input", () => {})` 空处理器 | `src/omp-adapter/index.ts:198-199` | 极低（保留即可，属已知预留） |

---

## 2. 扩展项（omp ExtensionAPI 已支持但本项目未用）

来源：omp 官方扩展文档 `omp://extensions.md`（本节逐条标注对应小节）。按结合价值排序。

### E1. `before_provider_request` / `after_provider_response` — 全量请求观测与改写 【价值：高】

- **omp 支持**：`omp://extensions.md` "Prompt and turn lifecycle"：`before_provider_request` 可替换 provider 请求载荷，`after_provider_response` 观测响应。
- **结合点**：(a) 当前用量/延迟统计只覆盖走 `auto-router/*` 虚拟模型的请求；挂上这两个事件后，用户手动 `/model` 选的直连模型也能纳入统计与事件日志，数据完整性大幅提升；(b) `before_provider_request` 是 Mode B 的天然载体（改写目标模型而非委派流），也是实现 A1（thinking 注入真实请求）的另一条路径。
- **成本**：中。需处理「非本扩展路由的请求」与「本扩展委派的请求」的去重（避免双重计数）。

### E2. `tool_call` / `tool_result` 拦截 — 结果驱动的复杂度再评估 【价值：高】

- **omp 支持**：`omp://extensions.md` "Tool lifecycle"：`tool_call` 可阻断/改写入参，`tool_result` 可补丁结果；所有工具（内置 + 扩展 + MCP）都被拦截。
- **结合点**：移植上游 `validation-outcome-detector.ts`（[源码](https://github.com/danialranjha/pi-auto-router/blob/main/src/validation-outcome-detector.ts)：识别 bash 里的 test/build 命令并从输出判定 passed/failed）。用途：本轮测试失败 → 下一请求自动提升 tier 或强制 reasoning 候选（「修 bug 需要更强模型」的自动化）；同时可按模型归因工具失败率，喂给 A6 的反馈闭环。
- **成本**：中。

### E3. `ctx.getContextUsage()` — 真实上下文用量替代 chars/4 估算 【价值：高，低成本】

- **omp 支持**：`omp://extensions.md` "Handler context" 列出 `getContextUsage()`。
- **结合点**：直接修复 B1——上下文分档信号改用宿主权威 token 数，`long/epic` 信号与 `@long` 的 `minContextWindow` 计算立即恢复效度。
- **成本**：低。

### E4. `session_stop` — 会话收尾钩子：状态落盘 + 路由摘要 【价值：中】

- **omp 支持**：`omp://extensions.md` "Prompt and turn lifecycle"：`session_stop` 在 settle 前被 await，可返回 `{ continue, additionalContext }` 或 block；不在子代理会话触发。
- **结合点**：(a) B5 的 latency/circuit 快照落盘的天然时机；(b) 会话结束时写一条「本次会话路由汇总」（决策数、failover 率、成本）到事件日志，对标上游 `routing-session-stats.mjs` 的会话级分析（见 D6）。
- **成本**：低-中。

### E5. `registerShortcut` / `registerFlag` — 快捷键切 profile + flag 替代环境变量 【价值：中】

- **omp 支持**：`omp://extensions.md` "Registration and actions"：`registerShortcut`（保留键列表见 "Constraints and pitfalls"：ctrl+c/d/z/k/p/l/o/t/g/q、alt+m 等不可用）、`registerFlag`/`getFlag`。
- **结合点**：(a) 一个快捷键循环切换 profile（比 `/auto-router use` 快）；(b) 用 flag 实现 A5 的 UVI hard mode / shadow / confidence 阈值，比 `OMP_AUTO_ROUTER_*` 环境变量更 omp 原生、可运行时切换。
- **成本**：低。

### E6. `registerMessageRenderer` / `registerAssistantThinkingRenderer` — 决策可视化 【价值：中】

- **omp 支持**：`omp://extensions.md` "Rendering extension points"：自定义消息渲染器；thinking 渲染器在每条可见 thinking 块下方追加展示组件，注册顺序追加，不得修改消息本体。
- **结合点**：在 assistant 消息下方渲染路由徽章（`profile | tier (conf) | provider/model | failover n 次`），把现在只有 `/auto-router explain` 可见的信息变成默认可见；也可渲染 `com.omp.auto-router.decision` 自定义会话条目（已通过 `appendEntry` 写入，`src/omp-adapter/router.ts:190`）。
- **成本**：中（需引入 pi-tui 组件，适配层新增依赖面）。

### E7. `ctx.ui.setWidget` — 常驻路由仪表盘 【价值：中】

- **omp 支持**：`omp://extensions.md` "UI integration points"：`setWidget` 经 `setHookWidget` 渲染在编辑器上/下方（`placement: "aboveEditor" | "belowEditor"`），字符串数组内容上限 10 行；RPC 模式仅支持字符串数组。
- **结合点**：比单行 `setStatus`（现用法，`src/omp-adapter/host-ports.ts:117-123`）信息量大一个量级：当前 profile/tier、各 provider UVI 状态条、预算进度、熔断状态，常驻可见。上游 README 的 status line 已有 `⚠ google: 87% of $20 monthly`、`uvi: anthropic=1.64 stressed` 等段落（本项目状态栏目前只有一行 decision），widget 可直接容纳这些信息。
- **成本**：低-中。

### E8. `ctx.setInterval` 后台任务 — 配额/健康周期预热 【价值：中，低成本】

- **omp 支持**：`omp://extensions.md` "Background work"：必须用 `ctx.setInterval`/`ctx.setTimeout`（异常隔离 + session_shutdown 自动清理）；裸定时器回调抛异常会导致整个会话被拆除。
- **结合点**：B8 的后台 quota 刷新；移植上游 `health-check.ts`（OAuth token 健康缓存，healthy TTL 60s / unhealthy TTL 10s，[源码](https://github.com/danialranjha/pi-auto-router/blob/main/src/health-check.ts)）后的周期健康探测。注意：本项目 `waitForConfiguredModel` 已正确使用 `ctx.setTimeout`（`src/omp-adapter/router.ts:101-103`），值得延续同一纪律。
- **成本**：低。

### E9. `registerTool` — 把路由能力暴露为 LLM 可调用工具 【价值：中】

- **omp 支持**：`omp://extensions.md` "Tool authoring details"（zod/arktype 参数 schema、`renderCall`/`renderResult`、`defaultInactive` 等）。
- **结合点**：注册如 `auto_router_status` / `auto_router_switch` 工具，让 agent 在长任务中自查当前路由状态、或在明确感知任务变复杂时自切 profile（子代理已可走路由——README「接入指引」第 5 步——但没有自省能力）。需权衡工具占用的上下文 token，可用 `defaultInactive: true` 默认关闭。
- **成本**：中。

### E10. `ctx.memory` — 跨会话路由偏好记忆 【价值：低-中】

- **omp 支持**：`omp://extensions.md` "Handler context"：`memory`（可选结构化记忆运行时，status/search/save）。
- **结合点**：把 A6 的评分与「哪类任务在哪个模型上表现好」沉淀为跨会话记忆，替代/补充本地 `ratings.json`；会话恢复时可先验排序。依赖宿主配置了 memory 后端，需优雅降级。
- **成本**：中。

### E11. `sendMessage` / `sendUserMessage` — 主动告警与转向 【价值：中】

- **omp 支持**：`omp://extensions.md` "Message delivery semantics"：`deliverAs: steer/followUp/nextTurn`。
- **结合点**：预算 100% 阻断、UVI critical、全部候选熔断时，主动 notify 之外的升级手段——注入一条 followUp 消息告知用户「已降级到 X，原因 Y」，避免用户困惑为什么模型变了。
- **成本**：低。

### E12. `getServiceTiers` / `setServiceTier` — 按复杂度联动 service tier 【价值：低-中】

- **omp 支持**：`omp://extensions.md` "Registration and actions"：OpenAI 支持 `auto/default/flex/scale/priority`，Anthropic 支持 `priority`，Google 支持 `flex/priority`。
- **结合点**：trivial/simple 层顺手 `flex`（省钱），complex 层 `priority`（省时）——在模型联动之外再开一个成本/延迟维度。仅对订阅/API 支持该参数的 provider 有效。
- **成本**：低-中。

### E13. `mcp_notification` — 外部配额推送通道 【价值：低】

- **omp 支持**：`omp://extensions.md` "MCP notifications"：所有 JSON-RPC notification 透传，未知方法也投递；订阅前缓冲（FIFO 100 条）。
- **结合点**：若把配额/余额监控做成 MCP 服务（或接入已有的用量监控 MCP），可替代轮询式 `fetchUsageReports`，变「拉」为「推」。当前没有现成推送源，属于远期选项。
- **成本**：中（需要先有一个推送端）。

### E14. `user_bash` / `user_python` 拦截 — `!` 快捷命令 【价值：低】

- **omp 支持**：`omp://extensions.md` "User command interception"：可返回 `{ result }` 覆盖执行。
- **结合点**：`!route premium` 之类的轻量操作入口。与已有 `/auto-router` 命令面重叠，边际价值低。
- **成本**：低。

### E15. `session_before_compact` / `context` — 压缩感知 【价值：低】

- **omp 支持**：`omp://extensions.md` "Session lifecycle"（可取消的 pre-event）与 "Prompt and turn lifecycle"（`context`）。
- **结合点**：压缩后上下文骤降，B1 的上下文信号会跳变；可在压缩事件后重置 priorTier / 重估分档基准。属于 B2 任务边界判定的辅助信号。
- **成本**：低。

---

## 3. 与上游 pi-auto-router 的差距（有而未移植）

来源：上游 [README](https://github.com/danialranjha/pi-auto-router) 及仓库源码（`src/` 文件清单与实现）。本项目是其设计思想的 omp 重构移植（README.md:6），以下为上游已落地而本项目未有的能力：

| # | 上游能力 | 本项目现状 | 来源 |
|---|---|---|---|
| D1 | 失败目标临时冷却（cooldown） | 类型与 solver 消费已就位，生产方缺失（见 A4） | 上游 README "Behavior notes"；`src/core/constraint-solver.ts:74-76` |
| D2 | 延迟数据持久化（`auto-router.latency.json`，重启保留） | `LatencyTracker.snapshot/restore` 已就绪但未接线（见 B5） | 上游 README "Performance-based ranking"；`src/core/latency-tracker.ts:63-79` |
| D3 | 通用余额抓取 `balance-fetcher.ts`（指数退避重试 + 合成月度 UVI 窗口） | 仅 DeepSeek 硬编码、无重试（见 A3） | [上游 src/balance-fetcher.ts](https://github.com/danialranjha/pi-auto-router/blob/main/src/balance-fetcher.ts)；`src/omp-adapter/commands.ts:209-222` |
| D4 | OAuth 健康缓存 `health-check.ts`（独立于 UVI，healthy TTL 60s / unhealthy 10s） | `isHealthy` 仅做 `models.resolve` 存在性检查，不验证凭证可用性（`src/omp-adapter/host-ports.ts:34-37`） | [上游 src/health-check.ts](https://github.com/danialranjha/pi-auto-router/blob/main/src/health-check.ts) |
| D5 | TTL 配额缓存模块 `quota-cache.ts`（批量抓取、按 provider 发快照） | 30s 字面量节流内联在请求路径（见 B8） | [上游 src/quota-cache.ts](https://github.com/danialranjha/pi-auto-router/blob/main/src/quota-cache.ts)；`src/omp-adapter/router.ts:136-144` |
| D6 | 三个分析脚本：`routing-stats.mjs` / `routing-quality-stats.mjs` / `routing-session-stats.mjs`（日维度模型构成、UVI 时间线、drift 分析、延迟/成本分布、Top 触发 failover 的错误） | 仅有 ad-hoc 冒烟脚本 `scripts/complex-smoke.ts`；事件日志已落盘但无任何分析工具 | 上游 README "Troubleshooting with routing analytics scripts"；`scripts/complex-smoke.ts:1-5` |
| D7 | 更多运维命令：`circuit`（熔断状态）、`rules`（规则与 trace）、`search` / `aliases` / `resolve` / `models` / `shortcuts`、`balance show\|fetch`、`reset`（清冷却/历史/预算告警） | 本项目 14 个子命令中无对应项（`src/omp-adapter/commands.ts:224-240`） | 上游 README "Commands" |
| D8 | 测试/构建结果检测 `validation-outcome-detector.ts` + 评分归因 `rating-attribution.ts` + SWE 子任务启发式 `swe-subtask-heuristics.ts` + 上下文净化 `context-sanitizer.ts` | 无对应模块（D8 的落地依赖 E2 的工具拦截） | 上游仓库 src/ 文件清单 |

说明：上游的 `/auto-router explain` 展示评分、状态栏含预算/UVI 段落（上游 README "Status line"）也属于 D6/D7 衍生差距，可随 E7 一并补齐。

---

## 4. 测试缺口

基线：25 个测试文件、README 宣称 344 用例（README.md 开发节）。core 各模块均有对应测试文件且覆盖良好（pipeline 的 uviHardMode/globalRules/confidenceThreshold/escalation 分支均有用例，`tests/pipeline.test.ts:171-380`）。缺口集中在适配层与「生产路径与测试路径不一致」：

| # | 缺口 | 证据 | 风险 |
|---|---|---|---|
| T1 | **适配层入口 `index.ts` 完全无测试**：boot 流程、`session_start` 的子代理 ctx 采纳规则（首个会话胜出、有 UI 会话优先）、`matchPathActivation` 最长前缀匹配、`restoreDecisions` 分支回放 | `src/omp-adapter/index.ts:158-181`（采纳规则注释显示逻辑微妙易回归）、`index.ts:219-238`、`index.ts:209-216`；tests 目录无任何 import `omp-adapter/index` 的文件 | 高：子代理会话 clobber 主会话 ctx 这类 bug 只能靠手工发现 |
| T2 | **`host-ports.ts` 无直接测试**：`fetchQuota` 的 usedFraction 三分支换算（直接值 / used÷limit / 缺失）、窗口字段透传、异常落日志；`enrichCandidates` 的跨 tier 去重；`wrapModel` 默认值 | `src/omp-adapter/host-ports.ts:50-96,155-178`；grep tests 无 `enrichCandidates`/`fetchQuota`/`createHostPorts` 命中（`createHostPorts` 仅在 commands.test 的 useage 流程中间接触及） | 中-高：quota 解析错误直接污染 UVI 与阻断判定 |
| T3 | **生产用 sync 配置加载、测试只测 async 版**（C2 的测试面） | `tests/omp-adapter/config.test.ts:7` 只 import `loadAdapterConfig`；生产入口 `src/omp-adapter/index.ts:37,82` 用 `loadAdapterConfigSync` | 中：sync 版回归无防护 |
| T4 | 请求路径上的 quota 30s 节流行为无测试（缓存命中/过期/refresh 清空后重取） | `src/omp-adapter/router.ts:136-144`；tests 中 `quotaCache` 断言仅出现在 useage 命令测试（`tests/omp-adapter/commands.test.ts:265`） | 中 |
| T5 | `recordUsage` 成本估算（含 cacheRead/cacheWrite、无定价时 cost=0）无直接测试 | `src/omp-adapter/router.ts:255-287` | 低-中：成本错误直接污染预算阻断 |
| T6 | `waitForConfiguredModel` 的 5s 轮询上限、中止信号响应 | `src/omp-adapter/router.ts:93-108`（router.test.ts:129-140 只覆盖了「迟到模型最终解析成功」一条路径） | 低 |
| T7 | core 小模块测试偏薄但可接受：`context-analyzer`（48 行测试，模块本身仅 37 行，边界已覆盖，`tests/context-analyzer.test.ts:26-50`）、`state-store`（71 行）、`decision-store`（88 行） | tests 对应文件 | 低（模块小且纯，当前覆盖与风险相称） |

---

## 5. 优先级排序表（收益 ÷ 成本，高者优先）

| 优先级 | 条目 | 类型 | 收益 | 成本 | 一句话理由 |
|---|---|---|---|---|---|
| P0 | A2 profile.budgets 接线 | 优化 | 高 | 低 | 文档示例承诺的保护当前完全不生效 |
| P0 | A5 UVI hard mode 等 env/flag 接线 | 优化 | 中 | 极低 | pipeline 与测试都已就绪，只差一行装配 |
| P0 | B1/E3 上下文估算改用 `ctx.getContextUsage()` | 优化+扩展 | 高 | 低 | 修复核心分级信号效度，omp 现成 API |
| P1 | A1 thinking 联动闭环 | 优化 | 高 | 中 | 用户心智模型的另一半；需先核实 pi-ai options |
| P1 | T1 适配层入口测试（boot/子代理采纳/路径激活） | 测试 | 高 | 中 | 全仓库最微妙逻辑零防护 |
| P1 | B5 熔断/延迟持久化 | 优化 | 中 | 低 | core API 半就绪，上游已验证价值 |
| P1 | T2 host-ports fetchQuota/enrichCandidates 测试 | 测试 | 中-高 | 低 | 解析错误直通路由判定 |
| P2 | A4 冷却生产方（CooldownTracker） | 优化 | 中 | 低-中 | 补齐 solver 死路径，对标上游行为 |
| P2 | A6 评分反哺排序（先 explain 展示，后 demote） | 优化 | 中 | 中 | 「反馈闭环」承诺的最小闭环 |
| P2 | B4 failover 延迟按候选计时 | 优化 | 中 | 低 | 排序正确性修复 |
| P2 | E2 tool_result 拦截 + 测试结果检测 | 扩展 | 高 | 中 | 差异化能力，上游已验证形态 |
| P2 | E1 before/after_provider_request 观测 | 扩展 | 高 | 中 | 统计完整性 + Mode B 载体 |
| P2 | C2 配置加载双实现合并 + T3 sync 版测试 | 卫生+测试 | 中 | 低 | 消除「测的不是跑的」 |
| P3 | A3/B7 balanceEndpoint 通用 balance fetcher + provider registry | 优化 | 中 | 中 | 扩 provider 的前置条件 |
| P3 | B3 正则预编译 | 优化 | 低-中 | 极低 | 热路径零风险提速 |
| P3 | B6 日志/用量轮转 | 优化 | 低-中 | 低 | 长期健康 |
| P3 | B8/E8 quota 后台周期刷新（`ctx.setInterval`） | 优化+扩展 | 低-中 | 低 | UVI 时效性 |
| P3 | E7 setWidget 路由仪表盘 | 扩展 | 中 | 低-中 | 运维可见性跃升 |
| P3 | D6 路由分析脚本 | 扩展 | 中 | 中 | 事件日志已有，分析器缺位 |
| P4 | B9 host ports 单例化 + 轮询收敛 | 优化 | 低 | 低 | 稳定小额省时 |
| P4 | C1 `useage`→`usage` 别名 + README 补文档 | 卫生 | 低 | 极低 | 用户可见拼写 |
| P4 | C3/C4 死管道/死端口清理 | 卫生 | 低 | 极低 | 收窄表面积 |
| P4 | E5 快捷键/flag、E11 主动告警 | 扩展 | 中 | 低 | 体验增强 |
| P4 | E6 消息渲染器、E9 LLM 工具、E12 service tier | 扩展 | 中 | 中 | 锦上添花 |
| P5 | E10 memory、E13 MCP 推送、E14 user_bash、E15 compact 感知 | 扩展 | 低 | 低-中 | 远期选项，依赖外部条件 |
| P5 | B2 conversationDepth/任务边界 | 优化 | 中 | 中 | 需要先定义「任务边界」，建议与 E15 一起做 |

**建议的第一批落地组合（一个迭代可完成）**：A2 + A5 + B1/E3 + B5 + B4 + B3 + C1/C2/C3/C4 + T2 + T3。共同特征：core 侧能力已就绪或 omp API 现成，改动集中在适配层，风险低、收益立竿见影。

---

## 附：调研覆盖清单

- **core 全部 21 模块已审**：pipeline、complexity-classifier、intent-classifier、context-analyzer、shortcut-parser、profile-registry、policy-engine、constraint-solver、candidate-partitioner、budget-tracker、budget-auditor、uvi、circuit-breaker、latency-tracker、failover-engine、feedback-tracker、decision-store、event-log、state-store、config-loader、host-ports（端口定义）。
- **adapter 全部 8 文件已审**：index、router、commands、state、config、host-ports、redact、omp-api。
- **tests 25 文件**：按符号级 grep 核实覆盖关系（T1–T7）。
- **omp 文档**：`omp://extensions.md` 全文（事件面、工具面、UI 面、状态模式）。
- **上游**：README 全文 + `health-check.ts`、`validation-outcome-detector.ts` 源码精读，其余模块按 README 架构表与文件清单对照。
