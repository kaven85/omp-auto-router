# omp-auto-router

面向 [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi) 的 profile 化、复杂度感知自动路由插件：一套模型选择策略（profile），按任务复杂度自动挑选不同模型，带同请求 failover、预算/配额感知、可解释决策。

基于 [pi-auto-router](https://github.com/danialranjha/pi-auto-router) 的设计思想移植，但做了 omp 原生适配与解耦重构。

## 能力一览

- **Profile 体系**：多个命名 profile（如 `premium`/`economy`/`offline`），毫秒级切换
- **复杂度分级**：每次请求自动分类 `trivial / simple / standard / complex`，层级联动模型 + thinking 强度
- **显式钉层**：`@reasoning` / `@swe` / `@long` / `@vision` / `@fast` / `@profile:<name>`（token 自动剥离，模型看不到）
- **同请求 failover**：首选目标失败（可重试错误、未产出实质内容）自动换下一候选；thinking-only 部分不阻断切换
- **预算与配额**：per-provider 日/月 USD 预算（80% 警告、100% 阻断换链）、UVI 配额配速（critical 阻断 / stressed 降级 / surplus 提升）
- **策略规则**：force-tier / prefer / exclude-provider / force-billing / force-constraint，支持时间段与周几条件
- **影子模式**：照记决策但按配置顺序路由，对比验证
- **可解释**：`/auto-router explain` 输出完整推理链；决策/用量 JSONL 落盘

---

## 安装

插件是含 `package.json`（`omp.extensions` 清单）的目录。两种加载方式：

**方式 A：常驻（推荐）** — `~/.omp/agent/config.yml`：

```yaml
extensions:
  - /path/to/omp-auto-router
```

**方式 B：一次性调试**：

```bash
omp --extension /path/to/omp-auto-router
```

> 注意：指向的是**包目录**（含 `package.json`），不是单个文件；`~/.omp/agent/extensions/` 的自动发现只扫一层 `*.ts`，多模块插件请用 `config.yml` 显式引用。

---

## 接入指引（从零到跑通）

按顺序执行，每步都有可验证的结果；全部完成后插件即接管路由。

### 第 0 步：确认前置条件

- omp 可启动：`omp --version`
- 确认你**真实可用**的模型 id：启动 omp → `/model` 记下 provider/model（例如 `anthropic/claude-sonnet-4-5`、`deepseek/deepseek-v4-flash`）。**插件的 targets 只认这些 id**，写错会导致 "Model not found"。

### 第 1 步：放置插件

```bash
# 插件目录（含 package.json，omp.extensions 声明了入口）
ls /path/to/omp-auto-router/package.json
```

### 第 2 步：声明扩展并验证加载

`~/.omp/agent/config.yml`：

```yaml
extensions:
  - /path/to/omp-auto-router
```

重启 omp 会话后执行 `/auto-router doctor`——出现 `auto-router doctor` 输出即加载成功；若提示 `not ready` 说明 session 未触发 boot（等下一轮）。

### 第 3 步：写最小可跑配置

先用**单 profile、单 tier、单 target**（用第 0 步确认的模型）跑通链路，再扩展层级。`~/.omp/agent/auto-router.yml`：

```yaml
active: test
profiles:
  test:
    defaultTier: standard
    tiers:
      standard:
        targets:
          - { provider: anthropic, model: claude-sonnet-4-5 }   # ← 换成你 /model 里的真实 id
```

改配置后 `/auto-router reload`（或重启会话）。

### 第 4 步：启用路由

`~/.omp/agent/config.yml` 追加：

```yaml
modelRoles:
  default: auto-router/test
```

重启会话。此时所有请求应走 `auto-router/test`。

### 第 5 步：验收清单

```text
[ ] /auto-router doctor
    → H1 registerProvider/stream ✅、H2 ctx.models 有数量、无 config errors
[ ] 发一条消息
    → tail ~/.omp/agent/auto-router/auto-router.events.jsonl 出现 decision + settled 两行
[ ] /auto-router explain
    → 显示 profile/test + tier + 推理链
[ ] 钉层生效：输入 @reasoning 复杂问题
    → explain 的 tier 变为 complex（或按你的配置）
[ ] failover 生效（可选）：把 standard targets 加一个不存在的模型再删掉
    → 日志出现 failover 事件
[ ] 子代理接入（可选）：modelRoles 加 task: auto-router/test
    → 子代理请求同样产生 decision（profile=test）
```

### 常见失败排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Model "auto-router/xxx" not found` | 虚拟模型注册失败或 targets 与真实模型不一致 | `/auto-router doctor` 看 H1；`/model` 核对 target id |
| `/auto-router` 提示 `not ready` | session_start boot 未完成 | 等待会话就绪后重试；看 omp 日志 `auto-router: boot failed` |
| 发了消息但事件日志无 decision | 当前模型不是 auto-router/*（modelRoles 未生效） | `/model` 确认当前模型；检查 config.yml 拼写后重启会话 |
| doctor 显示 config errors | auto-router.yml 校验失败（如 targets 为空） | 按报错 dotted path 修正；错误层会回退到内置默认 |
| 决策全是预算阻断/换链 | budget 超限或 UVI critical | `/auto-router budget show`、`/auto-router uvi show`；`clear` 后重试 |
| 子代理没走路由 | `modelRoles.task` 未配置 | 加 `task: auto-router/<profile>`；确认子代理模型变更（会话文件 `model_change` 条目） |
| `/auto-router reload` 后配置没变 | 改的是项目层但 cwd 不对 | 确认 `<cwd>/.omp/auto-router.yml` 存在且 cwd 匹配 |

### 接入 checklist（最后确认）

- [ ] 插件目录引用在 `config.yml extensions`（或 `--extension`）
- [ ] `auto-router.yml` 的 targets 全部是 `/model` 里存在的 id
- [ ] `modelRoles.default`（或 `/model` 手动）指向 `auto-router/<profile>`
- [ ] `/auto-router doctor` 无红色项、无 config errors
- [ ] 事件日志出现 decision + settled
- [ ] `@reasoning` 钉层与 `explain` 推理链一致



## 配置

配置分两层，插件自行合并（内置默认 < 用户 < 项目）：

| 层 | 路径 | 生效范围 |
|---|---|---|
| 用户 | `~/.omp/agent/auto-router.yml` | 全局 |
| 项目 | `<repo>/.omp/auto-router.yml` | 该项目内覆盖（同名 profile 整体替换） |

快速上手：复制仓库根 `auto-router.example.yml` 到 `~/.omp/agent/auto-router.yml`，把 `targets` 换成你 `/model` 里真实存在的模型。

### 完整示例

```yaml
active: premium                    # 默认激活 profile
profiles:
  premium:
    description: 日常开发，订阅优先
    defaultTier: standard           # 分类器低置信时的兜底层
    tiers:
      trivial:                      # 短问答/元问题
        thinking: low               # 联动 omp thinking 强度
        targets:
          - { provider: deepseek, model: deepseek-v4-flash, billing: per-token }
          - { provider: ollama,  model: glm-5.1:cloud }      # failover 链
      simple:                       # 单文件改动/解释
        thinking: low
        targets:
          - { provider: deepseek, model: deepseek-v4-flash, billing: per-token }
      standard:                     # 常规编码
        thinking: medium
        targets:
          - { provider: anthropic, model: claude-sonnet-4-5 }
          - { provider: openai-codex, model: gpt-5.5 }
      complex:                      # 架构/重构/多步推理
        thinking: high
        targets:
          - { provider: anthropic, model: claude-opus-4-5 }
    budgets:
      google: { amount: 20, monthly: true }   # per-provider USD 限额
    rules:                                    # 策略规则（per-profile 作用域）
      - type: exclude-provider
        providers: [google]
        when: { hourStart: 23, hourEnd: 7 }   # 23:00–7:00 排除 google
      - type: force-tier
        tier: trivial
aliases:
  eco: [economy]                    # /auto-router use eco
activate:                           # 按 cwd 前缀自动激活
  - { path: ~/work, profile: premium }
  - { path: ~/oss, profile: economy }
```

### 配置项参考（按层级）

#### 根级

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `profiles` | mapping | ✅ | 至少一个 profile，key 为 profile 名称 |
| `active` | string | 否 | 默认激活的 profile，必须已定义；缺省取第一个 |
| `aliases` | mapping | 否 | 别名 → `string[]`，如 `eco: [economy]` |
| `activate` | array | 否 | 路径自动激活，元素见下表 |

#### profile

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `description` | string | 否 | 展示用 |
| `defaultTier` | `trivial/simple/standard/complex` | 否 | 分类器置信度 < 0.45 时兜底；缺省 `standard` |
| `tiers` | mapping | ✅ | key 限这四级，可只定义子集（阶梯回退：先向上再向下） |
| `budgets` | mapping | 否 | key 为 provider 名 → budget limit |
| `rules` | array | 否 | 策略规则数组 |

#### tier

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `thinking` | `off/minimal/low/medium/high/xhigh/max` | 否 | 联动 omp thinking 强度 |
| `targets` | array | ✅ | 非空；顺序即 failover 链 |

#### target

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `provider` | string | ✅ | 如 `anthropic`、`deepseek` |
| `model` | string | ✅ | 与 `/model` 显示的 id 一致 |
| `label` | string | 否 | 展示标签 |
| `billing` | `subscription/per-token` | 否 | 缺省 `subscription`；影响预算桶与合成 UVI |
| `balanceEndpoint` | string | 否 | 自定义余额 API（per-token 提供商） |

凭证走 omp 的 auth 链（`agent.db` 多凭证），**无需**在配置里写密钥。

#### budget limit

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amount` | number | ✅ | 正数，USD |
| `monthly` | boolean | 否 | `false`=日限额（缺省）；`true`=月限额（触发合成 UVI） |

80% 用量警告、100% 阻断换链。

#### policy rule

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | 见下 | ✅ | 决定哪些附加字段必须出现 |
| `priority` | number | 否 | 越大越先执行；缺省 0 |
| `profiles` | `string[]` | 否 | 仅对指定 profile 生效；缺省全局 |
| `when` | object | 否 | 时间条件 |
| `tier` | 复杂度四级 | `force-tier` 时必填 | 强制钉层 |
| `providers` | `string[]` | `prefer/exclude-provider` 时必填 | 偏好/排除的提供商 |
| `billing` | `subscription/per-token` | `force-billing` 时必填 | 强制计费方式 |
| `constraint` | object | `force-constraint` 时必填 | 能力约束 |

`type` 可选值：`force-tier` / `prefer-provider` / `exclude-provider` / `force-billing` / `force-constraint`

#### when（规则时间条件）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `hourStart` | 整数 0–23 | 否 | 本地起始小时（含）；跨午夜用 `hourStart > hourEnd` |
| `hourEnd` | 整数 0–23 | 否 | 本地结束小时（不含） |
| `weekdays` | `整数[]` 0–6 | 否 | 0=周日 … 6=周六 |

#### constraint（force-constraint）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `reasoning` | boolean | 否 | 要求模型支持 reasoning |
| `vision` | boolean | 否 | 要求模型支持图片输入 |
| `minContextWindow` | number | 否 | 最小上下文窗口（token） |

#### activate 元素

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | ✅ | 支持 `~` 展开；取最长匹配前缀 |
| `profile` | string | ✅ | 必须已在 `profiles` 中定义 |

### 内置默认

无配置文件或所有层解析失败时，回退到内置默认：`active: default`，四级 tier 全部指向 `deepseek/deepseek-v4-flash`（trivial/simple）、`anthropic/claude-sonnet-4-5`（standard）、`anthropic/claude-opus-4-5`（complex）。

### 合并策略

- **profiles**：同名 profile **整体替换**，不同名保留
- **active / aliases / activate**：后层有值覆盖，无值保留前层



## 启用路由

```text
/model            → 选择 Auto Router: <profile>（即 auto-router/<profile>）
```

或全局/按角色接管（`~/.omp/agent/config.yml`）：

```yaml
modelRoles:
  default: auto-router/premium   # 主会话按复杂度路由
  task:    auto-router/economy   # 子代理走省钱 profile（已验证）
  smol:    auto-router/economy   # 标题/记忆等轻量任务
```

选中后**无需手动干预**：每次请求自动分级选模型。可随时 `/auto-router use <profile|alias>` 切换（毫秒级，会话级持久化）。

## 复杂度分级与快捷键

| 层 | 典型信号 | 联动 |
|---|---|---|
| `trivial` | 短问答、无代码 | thinking low |
| `simple` | 单文件改动、解释、grep 类 | thinking low |
| `standard` | 代码块、多文件路径、diff | thinking medium |
| `complex` | 重构/迁移/架构关键词、长上下文、同任务多轮 | thinking high |

显式钉层（优先级最高，token 剥离）：

```text
@fast 快问快答
@swe 重构这个模块
@reasoning 证明素数无限
@long 总结这份 80 页文档      # 强制 contextWindow ≥ max(100k, 估算)
@vision 描述这张截图
@profile:economy 临时切换 profile（单次请求）
```

低置信（< 0.45）落到 `defaultTier`；同任务多轮粘性升级、不降级。

### 各分级触发条件与触发词参考

分级由**加权信号打分**决定（argmax + 置信度 ≥ 0.45 才采纳；低于则落 `defaultTier`）。下面是被采纳的触发条件与词表，按层列出。

#### → `complex`（权重 5，唯一定层到 complex 的信号）

命中**任一多步词**即 push complex；或 `@reasoning` 钉层；或上下文 ≥ 100k tokens（epic）。

**多步词 —— 子串匹配（含中文）**
```
重构 迁移 重新设计 跨文件 跨模块 架构 多文件 多个文件
方案 设计 规划 规格 拆分 蓝图 路线图 拆解
```
```
refactor migrate migration redesign rearchitect re-architect overhaul rewrite
across files  multiple files  cross-file  architecture
```

**多步词 —— 词边界匹配（英文整词，避免误伤 `planetary`/`specific`/`respect`）**
```
plan plans planning planned          design designs designing
spec specs specification specifications
roadmap blueprint strategy decompose modularize modularise restructure
```

**钉层**：`@reasoning`（conf 1.0，最高优先）。

#### → `standard`

以下任一强信号，且无 multi-step 词抢到 complex：
- 结构代码信号：代码围栏 ` ``` ` / `~~~`、多文件路径（`src/a.ts` 等）、diff（`+++`/`---`/`@@` 或行首 `+/-`）、堆栈（`at X (file:line)` / Traceback）
- repair/debug 词（升 standard，不升 complex）：
  ```
  bug debug debugging broken crash exception stack trace traceback runtime error
  why is  why does  why did  what's wrong  what is wrong
  报错 异常 崩溃 排查 定位问题 什么原因 为什么会 为什么报错
  ```
- code / analysis 意图（含 `实现`、`analyze`、`分析` 等意图词）但无结构信号
- 上下文 32k–100k tokens（long）
- 钉层：`@swe`

#### → `simple`

- 上下文 4k–32k tokens（medium）
- 图片输入（无 multi-step/repair 时）
- 单文件改动、解释类、grep 类
- 钉层：`@fast`

#### → `trivial`

- 短 general 问答（估算 < 200 tokens、无代码/repair/图片信号）
- 上下文 < 4k tokens（short）
- 钉层无专属 token（`@fast` 落 simple，已是最低档之一）

#### 意图词表（辅助 standard/trivial 判定）

| intent | 英文 | 中文 |
|---|---|---|
| code | code coding function bug debug compile exception typescript javascript python regex sql api endpoint unit test implement refactor runtime error | 代码 报错 函数 调试 编译 实现 修复 |
| creative | poem poetry story blog essay lyrics song novel fiction joke | 写诗 诗歌 诗 故事 小说 博客 散文 文案 歌词 |
| analysis | analyze analyse analysis summarize summary compare comparison contrast review evaluate assessment explain pros and cons | 分析 总结 对比 比较 评审 评估 解释 |

> 词表来源：`src/core/complexity-classifier.ts`（多步/repair）、`src/core/intent-classifier.ts`（意图）、`src/core/context-analyzer.ts`（上下文分档）、`src/core/shortcut-parser.ts`（钉层 token）。词表可调，改动不影响路由逻辑。

## 命令

| 命令 | 说明 | 示例 |
|---|---|---|
| `/auto-router status` | 当前 profile + 最近决策 + 模式 | `/auto-router status` |
| `/auto-router profiles` / `current` | 列表 / 当前 profile | `/auto-router profiles` |
| `/auto-router use <profile\|alias>` | 切换 profile（持久化，resume/branch 保留） | `/auto-router use economy` |
| `/auto-router list` / `show <profile>` | 当前 profile 的 tier 链 / 某 profile 详情 | `/auto-router show premium` |
| `/auto-router explain` | 上次决策的完整推理链（含排除原因、预算、UVI） | `/auto-router explain` |
| `/auto-router doctor` | 能力探测矩阵（H1–H7）+ 配置错误 | `/auto-router doctor` |
| `/auto-router reload` | 重读 auto-router.yml | `/auto-router reload` |
| `/auto-router budget show\|set <p> <usd> [monthly]\|clear <p>` | 预算管理（80% 警告 / 100% 阻断） | `/auto-router budget set google 20 monthly` |
| `/auto-router uvi show\|enable\|disable\|refresh` | UVI 配额配速 | `/auto-router uvi show` |
| `/auto-router shadow show\|enable\|disable` | 影子模式 | `/auto-router shadow enable` |
| `/auto-router rate good\|bad [comment]` | 决策反馈（持久化） | `/auto-router rate good 选得好` |
| `/auto-router help` | 全部子命令的说明 + 示例 | `/auto-router help` |

请求内钉层：`@fast` / `@swe` / `@reasoning` / `@long` / `@vision` / `@profile:<name>`（见上节）。

## 与 omp 的集成点

| omp 机制 | 集成方式 |
|---|---|
| `modelRoles` | profile 即虚拟模型，任意角色可指向（含 `task` 子代理，已验证） |
| 配置分层 | `auto-router.yml` 镜像 omp 的 用户/项目 分层惯例 |
| `omp --profile <name>` | agent 目录跟随，每 profile 独立 `auto-router.yml` |
| 会话持久化 | 决策经 `appendEntry` 写入会话，resume/branch 后 `explain` 仍可查 |
| 事件系统 | `auto_retry_*` / `credential_disabled` 写入事件日志供统计；宿主事件仅白名单标量字段落盘，字符串经密钥脱敏 |
| 凭证 | 复用 omp `agent.db` 多凭证（`modelRegistry.getApiKey`），无独立 auth |
| 子代理 | `modelRoles.task` 指向 `auto-router/<profile>` 即走路由（已验证） |

## 安全与凭证

- **无独立凭证存储**：API key 运行时经 omp 宿主 `modelRegistry.getApiKey` 取，配置里不写密钥、不经插件持久化。
- **传输**：余额/配额探测走 `https` + `Authorization: Bearer`，密钥不进 URL、不落日志。
- **落盘白名单**：宿主事件（`auto_retry_*` / `credential_disabled` 等）仅保留白名单标量字段（`provider` / `model` / `attempt` / `reason`），嵌套对象与请求内容一律丢弃。
- **写盘脱敏**：所有写向 `auto-router.events.jsonl` / `budget-*.json` / `ratings.json` 的字符串（含错误串）经 `redactSecrets` 清洗 —— Bearer token、`sk-` / `ghp_` / `AKIA` / JWT / PEM 密钥块 / URL 内嵌凭证均替换为 `[REDACTED]`。
- **路径防护**：`state-store` 拒绝含路径分隔符 / dot-escape 的名字（`assertBareName`），配置路径为固定常量拼接。
- **有界持久化**：`ratings.json` 默认保留最近 1000 条评分（`FeedbackTracker.maxEntries`），避免随使用无限增长。

密钥脱敏与白名单规则集中在 `src/omp-adapter/redact.ts`（路径防护在 `src/core/state-store.ts`），是"防止泄露的第一道纪律"之外的纵深防御，不是替代品。

## 验证与排障

```text
/auto-router doctor      # 能力探测矩阵，先看这里
/auto-router explain     # 上次为什么选了这个模型
```

事件日志（每请求一行 `decision` + 一行 `settled`，含真实 token 用量与估算成本）：

```bash
tail ~/.omp/agent/auto-router/auto-router.events.jsonl
```

预算/评分持久化：`~/.omp/agent/auto-router/budget-usage.json`、`budget-limits.json`、`ratings.json`。

## 局限

- 虚拟模型元数据（contextWindow 等）为静态值，仅影响 `/model` 展示
- 多会话（RPC）下 ctx 为进程级单例，按"单活动会话"假设运行
- `OMP_AUTO_ROUTER_*` 环境开关（如 UVI hard mode）尚未实现
- 插件包尚未走 omp 市场/`omp install` 安装形态（当前为目录引用）

## 开发
```bash
bun install
bun test tests/          # core + adapter 全量（344 用例）
bun run check            # core tsc
bun run check:adapter    # adapter tsc（宿主类型为结构性子集 + ambient shim）
```

目录结构：

```
src/core/          路由引擎（宿主机无关，零 omp import；bun:test 直测）
src/omp-adapter/   omp 适配层（唯一接触 ExtensionAPI 的地方）
src/omp-adapter/redact.ts   密钥脱敏 + 事件落盘白名单
auto-router.example.yml
```
