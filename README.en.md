# omp-auto-router

[简体中文](README.md) | English

A profile-based, complexity-aware auto-routing extension for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/earendil-works/pi): one package, two host entries, one shared routing core. It exposes a set of model-selection strategies (profiles) that picks different models per task complexity, with same-request failover, budget/quota awareness, and explainable decisions.

Ported from the design ideas of [pi-auto-router](https://github.com/danialranjha/pi-auto-router), with omp-native adaptation and a decoupled refactor into three layers: `src/core` (pure routing engine) → `src/runtime` (shared RouterRuntime: orchestration, failover, budgets, commands, widget, config) → `src/omp-adapter` / `src/pi-adapter` (thin host mappings). Command behavior is a single shared implementation registered by each adapter.

## Capabilities

- **Profile system**: multiple named profiles (e.g. `premium`/`economy`/`offline`), millisecond switching
- **Complexity tiers**: every request is auto-classified as `trivial / simple / standard / complex`; tier drives model + thinking effort
- **Explicit pinning**: `@reasoning` / `@swe` / `@long` / `@vision` / `@fast` / `@profile:<name>` (tokens are stripped automatically — the model never sees them)
- **Same-request failover**: if the first target fails (retryable error, no substantive output), the next candidate takes over; thinking-only partials don't block the switch
- **Post-failure cooldown**: a failed target enters a 5-minute transient cooldown — later requests skip it instead of rediscovering the failure; a success clears it
- **Rating feedback**: `/auto-router rate` scores feed ordering — candidates with ≥5 ratings and <40% good are demoted to the back of the chain (never removed; still the failover of last resort)
- **Test-failure escalation**: after a test/build bash command fails, the tier floor rises one level for 10 minutes (debugging deserves a stronger model); a passing run clears it
- **Budgets & quotas**: per-provider daily/monthly USD budgets (warn at 80%, block + switch chain at 100%; `profile.budgets` in config are defaults, CLI `budget set` overrides), UVI quota pacing (critical blocks / stressed demotes / surplus promotes)
- **Policy rules**: force-tier / prefer / exclude-provider / force-billing / force-constraint, with hour-of-day and weekday conditions
- **Shadow mode**: record decisions but route by configured order, for comparison and validation
- **Explainable**: `/auto-router explain` prints the full reasoning chain plus per-candidate ratings; decisions/usage are persisted as JSONL
- **Restart memory**: circuit-breaker state and rolling first-visible-output latency persist (`circuit.json` / `first-output-latency.json`) for warm starts
- **Env switches** (neutral names; legacy `OMP_AUTO_ROUTER_*` / `PI_AUTO_ROUTER_*` spellings still work as aliases): `AUTO_ROUTER_UVI_HARD=1` (exclude stressed-UVI providers), `AUTO_ROUTER_CONFIDENCE_THRESHOLD=<0..1>` (classifier confidence gate, default 0.45), `AUTO_ROUTER_COOLDOWN_MS=<ms>` (post-failure target cooldown, default 60000, floor 5000), `AUTO_ROUTER_QUOTA_REFRESH_MS=<ms>` (quota refresh cadence, default 30000, floor 10000), `AUTO_ROUTER_LLM_ADJUDICATE=0|false` (disable LLM adjudication of mixed-phase prompts, default on)
- **Background quota refresh**: UVI quota snapshots refresh every 30s in the background (host-managed timer), so requests never block on an expired cache
- **Dashboard widget**: after each decision a profile/target/first-visible-output latency/budget/circuit/UVI overview is rendered via `setWidget` (degrades silently when the host lacks it)
- **Provider registry**: provider-specific knowledge (Kimi window labels, DeepSeek balance endpoint, per-model thinking ranges) lives in `provider-registry.ts`; target-level `balanceEndpoint` / `thinkingCap` override the defaults
- **Log rotation**: the event log truncates to its newest half past ~2 MB; daily budget buckets are kept for 62 days (monthly rollups indefinitely)
- **Analytics script**: `bun scripts/routing-stats.ts [--host omp|pi] [path]` aggregates the event log (decisions per profile/tier/target, failovers, top errors); `--host pi` reads the Pi state directory

---

## Installation

The plugin is a directory containing a `package.json` (declaring both an `omp.extensions` and a `pi.extensions` entry). Two ways to load it into omp:

**Option A: permanent (recommended)** — `~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/omp-auto-router
```

**Option B: one-off debugging**:

```bash
omp --extension /path/to/omp-auto-router
```

> Note: point at the **package directory** (containing `package.json`), not a single file. Auto-discovery under `~/.omp/agent/extensions/` only scans one level of `*.ts`; multi-module plugins must be referenced explicitly via `config.yml`.

### Installing into Pi

The same package directory doubles as a Pi package — no modifying, patching, or copying of Pi/OMP installation files is involved:

```bash
pi install /path/to/omp-auto-router
# or a one-off load:
pi -e /path/to/omp-auto-router
```

See [Pi support and capability degradation](#pi-support-and-capability-degradation) for Pi config locations, the trust model, and degraded capabilities.

---

## Onboarding on omp (zero to working)

Follow these steps in order; each has a verifiable outcome. Once complete, the plugin takes over routing. (For Pi, installation and config locations are covered in [Installing into Pi](#installing-into-pi) and [Pi support](#pi-support-and-capability-degradation); the commands and config schema are identical.)

### Step 0: prerequisites

- omp starts: `omp --version`
- Confirm your **actually available** model ids: start omp → `/model` and note the provider/model values (e.g. `anthropic/claude-sonnet-4-5`, `deepseek/deepseek-v4-flash`). **Targets only accept these ids** — a typo causes "Model not found".

### Step 1: place the plugin

```bash
# plugin directory (contains package.json; omp.extensions declares the entry)
ls /path/to/omp-auto-router/package.json
```

### Step 2: declare the extension and verify loading

`~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/omp-auto-router
```

Restart the omp session, then run `/auto-router doctor` — seeing the `auto-router doctor` output means loading succeeded; `not ready` means the session hasn't triggered boot yet (wait for the next turn).

### Step 3: write a minimal working config

Start with a **single profile, single tier, single target** (using a model confirmed in step 0) to prove the pipeline, then expand tiers. `~/.omp/agent/auto-router.yml`:

```yaml
active: test
profiles:
  test:
    defaultTier: standard
    tiers:
      standard:
        targets:
          - { provider: anthropic, model: claude-sonnet-4-5 }   # ← replace with a real id from your /model list
```

After editing, `/auto-router reload` (or restart the session).

### Step 4: enable routing

Append to `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: auto-router/test
```

Restart the session. All requests now go through `auto-router/test`.

### Step 5: acceptance checklist

```text
[ ] /auto-router doctor
    → H1 registerProvider/stream ✅, H2 ctx.models has a count, no config errors
[ ] send a message
    → tail ~/.omp/agent/auto-router/auto-router.events.jsonl shows a decision + settled pair
[ ] /auto-router explain
    → shows profile/test + tier + reasoning chain
[ ] pinning works: ask a hard problem with @reasoning
    → explain's tier becomes complex (or per your config)
[ ] failover works (optional): add a nonexistent model to standard targets, then remove it
    → a failover event appears in the log
[ ] subagent routing (optional): add task: auto-router/test to modelRoles
    → subagent requests also produce decisions (profile=test)
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Model "auto-router/xxx" not found` | virtual model registration failed, or targets don't match real models | check H1 via `/auto-router doctor`; verify target ids against `/model` |
| `/auto-router` says `not ready` | session_start boot not finished | wait until the session is ready and retry; check omp logs for `auto-router: boot failed` |
| message sent but no decision in the event log | current model is not auto-router/* (modelRoles not in effect) | confirm current model via `/model`; check config.yml spelling, then restart |
| doctor shows config errors | auto-router.yml validation failed (e.g. empty targets) | fix the reported dotted path; the broken layer falls back to builtin defaults |
| decisions are all budget blocks/chain switches | budget exceeded or UVI critical | `/auto-router budget show`, `/auto-router uvi show`; retry after `clear` |
| subagents bypass routing | `modelRoles.task` not configured | add `task: auto-router/<profile>`; confirm the subagent model change (`model_change` entry in the session file) |
| config unchanged after `/auto-router reload` | you edited the project layer but cwd doesn't match | confirm `<cwd>/.omp/auto-router.yml` exists and cwd matches |
| Pi: profile routes but every candidate is skipped as unauthenticated | target provider has no credentials in Pi's auth storage | run `/login` (or the provider's auth flow) for the target provider, then retry |
| Pi: target is available in `/model` but never routed to | scoped models (`enabledModels`/`--models`) exclude it | include both the virtual `auto-router/*` profiles AND the real targets in the scope |
| Pi: project config ignored | project not trusted | trust the project in Pi; `/auto-router doctor` reports the untrusted state |
| every candidate reports cooldown/circuit open | recent failures cooled down the whole chain | cooldowns expire on their own (default 60s, `AUTO_ROUTER_COOLDOWN_MS`); check `/auto-router status` and the event-log `error` entries for the underlying provider failures |
| Pi: provider streams an error event immediately | target API error (quota/billing/overload) surfaces as an assistant error event | read the event-log `error` entries; routing fails over only before substantive output |

### Final onboarding checklist

- [ ] plugin directory referenced in `config.yml extensions` (or `--extension`)
- [ ] all targets in `auto-router.yml` are ids that exist in `/model`
- [ ] `modelRoles.default` (or manual `/model`) points at `auto-router/<profile>`
- [ ] `/auto-router doctor` shows no red items and no config errors
- [ ] event log shows decision + settled
- [ ] `@reasoning` pinning matches the `explain` reasoning chain



## Configuration

Config has two layers, merged by the plugin (builtin defaults < user < project):

| Layer | omp path | Pi path | Scope |
|---|---|---|---|
| user | `~/.omp/agent/auto-router.yml` | `<agentDir>/auto-router.yml` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) | global |
| project | `<repo>/.omp/auto-router.yml` | `<repo>/.pi/auto-router.yml` (loaded only when the project is trusted) | overrides within that project (same-name profiles are replaced wholesale) |

Quick start: copy `auto-router.example.yml` from the repo root to your user-layer path, and replace `targets` with models that actually exist in your model selector.

### Full example

```yaml
active: premium                    # default active profile
profiles:
  premium:
    description: daily development, subscription-first
    defaultTier: standard           # fallback when classifier confidence is low
    tiers:
      trivial:                      # short Q&A / meta questions
        thinking: low               # drives omp thinking effort
        targets:
          - { provider: deepseek, model: deepseek-v4-flash, billing: per-token }
          - { provider: ollama,  model: glm-5.1:cloud }      # failover chain
      simple:                       # single-file edits / explanations
        thinking: low
        targets:
          - { provider: deepseek, model: deepseek-v4-flash, billing: per-token }
      standard:                     # regular coding
        thinking: medium
        targets:
          - { provider: anthropic, model: claude-sonnet-4-5 }
          - { provider: openai-codex, model: gpt-5.5 }
      complex:                      # architecture / refactors / multi-step reasoning
        thinking: high
        targets:
          - { provider: anthropic, model: claude-opus-4-5 }
    budgets:
      google: { amount: 20, monthly: true }   # per-provider USD limit
    rules:                                    # policy rules (per-profile scope)
      - type: exclude-provider
        providers: [google]
        when: { hourStart: 23, hourEnd: 7 }   # exclude google 23:00–7:00
      - type: force-tier
        tier: trivial
aliases:
  eco: [economy]                    # /auto-router use eco
activate:                           # auto-activate by cwd prefix
  - { path: ~/work, profile: premium }
  - { path: ~/oss, profile: economy }
```

### Field reference (by level)

#### Root

| Field | Type | Required | Description |
|---|---|---|---|
| `profiles` | mapping | ✅ | at least one profile; keys are profile names |
| `active` | string | no | default active profile, must be defined; falls back to the first one |
| `aliases` | mapping | no | alias → `string[]`, e.g. `eco: [economy]` |
| `activate` | array | no | path-based auto-activation; elements per the table below |

#### profile

| Field | Type | Required | Description |
|---|---|---|---|
| `description` | string | no | display only |
| `defaultTier` | `trivial/simple/standard/complex` | no | fallback when classifier confidence < 0.45; default `standard` |
| `tiers` | mapping | ✅ | keys limited to these four tiers; subsets allowed (ladder fallback: up first, then down) |
| `budgets` | mapping | no | key is provider name → budget limit |
| `rules` | array | no | policy rule array |

#### tier

| Field | Type | Required | Description |
|---|---|---|---|
| `thinking` | `off/minimal/low/medium/high/xhigh/max` | no | drives omp thinking effort |
| `targets` | array | ✅ | non-empty; order is the failover chain |

#### target

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string | ✅ | e.g. `anthropic`, `deepseek` |
| `model` | string | ✅ | must match the id shown by `/model` |
| `label` | string | no | display label |
| `billing` | `subscription/per-token` | no | default `subscription`; affects budget bucket and synthetic UVI |
| `balanceEndpoint` | string | no | custom balance API (per-token providers); **user layer only** — project-layer overrides are stripped for security |
| `thinking` | `off/minimal/low/medium/high/xhigh/max` | no | overrides the owning tier's `thinking`; applied when failover reaches this target |
| `thinkingCap` | `{min?, max?}` | no | thinking range (inclusive) the model accepts; overrides the provider-registry default. A tier/target thinking outside the range is clamped into range before steering, recorded as a `warn` event. E.g. `deepseek-v4-pro` defaults to `{min: high}` (accepts high/max only, rejects low/medium) |

Credentials come from omp's auth chain (`agent.db` multi-credential) — **no keys** in the config file.

#### budget limit

| Field | Type | Required | Description |
|---|---|---|---|
| `amount` | number | ✅ | positive, USD |
| `monthly` | boolean | no | `false` = daily limit (default); `true` = monthly limit (triggers synthetic UVI) |

Warn at 80% usage, block + switch chain at 100%.

#### policy rule

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | see below | ✅ | determines which extra fields must appear |
| `priority` | number | no | higher runs first; default 0 |
| `profiles` | `string[]` | no | only applies to the listed profiles; default global |
| `when` | object | no | time condition |
| `tier` | one of the four tiers | required for `force-tier` | forced pinning |
| `providers` | `string[]` | required for `prefer/exclude-provider` | preferred/excluded providers |
| `billing` | `subscription/per-token` | required for `force-billing` | forced billing mode |
| `constraint` | object | required for `force-constraint` | capability constraint |

`type` values: `force-tier` / `prefer-provider` / `exclude-provider` / `force-billing` / `force-constraint`

#### when (rule time condition)

| Field | Type | Required | Description |
|---|---|---|---|
| `hourStart` | integer 0–23 | no | local start hour (inclusive); cross-midnight via `hourStart > hourEnd` |
| `hourEnd` | integer 0–23 | no | local end hour (exclusive) |
| `weekdays` | `integer[]` 0–6 | no | 0 = Sunday … 6 = Saturday |

#### constraint (force-constraint)

| Field | Type | Required | Description |
|---|---|---|---|
| `reasoning` | boolean | no | require reasoning support |
| `vision` | boolean | no | require image input support |
| `minContextWindow` | number | no | minimum context window (tokens) |

#### activate element

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | supports `~` expansion; longest matching prefix wins |
| `profile` | string | ✅ | must be defined in `profiles` |

### Builtin defaults

With no config file, or when all layers fail to parse, the plugin falls back to builtin defaults: `active: default`, with all four tiers pointing at `deepseek/deepseek-v4-flash` (trivial/simple), `anthropic/claude-sonnet-4-5` (standard), and `anthropic/claude-opus-4-5` (complex).

### Merge strategy

- **profiles**: same-name profiles are **replaced wholesale**; distinct names are kept
- **active / aliases / activate**: a later layer's value wins when present; otherwise the earlier value is kept

## Pi support and capability degradation

On Pi the same routing core and command set run through the Pi adapter (`src/pi-adapter`), which delegates to real providers only via Pi's **public** ModelRegistry/Provider interfaces (Mode A). Behavior differences to be aware of:

- **Profile models**: every profile appears in the model selector as `auto-router/<profile>`; `/auto-router use <profile>` switches through the model registry. Command names and argument grammar are shared with omp; host-capability differences are explicit below.
- **Config locations**: user layer `<agentDir>/auto-router.yml` (agentDir = `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`); project layer `<repo>/.pi/auto-router.yml` is read **only when the project is trusted** — untrusted projects are ignored, and `/auto-router doctor` says so.
- **Scoped models** (`enabledModels` / `--models`): a non-empty scope is a real allowlist. It must include **both** the virtual `auto-router/*` profile models **and** every real target, or routing cannot reach the targets.
- **UVI unavailable**: Pi's public interface exposes no usage-report quota API, so UVI pacing is explicitly unavailable — `/auto-router uvi`, `usage`, and `doctor` say so, and the adapter never fabricates quota. Local budgets, session usage, provider balance endpoints, ratings, and cooldown/circuit/failover all still work.
- **Balance endpoints**: authenticated via Pi's public auth resolution (`getApiKeyAndHeaders`); only the user config layer may set `balanceEndpoint`.
- **State directory**: `<agentDir>/auto-router/` — separate from omp's `~/.omp/agent/auto-router`; there is no cross-host state migration.
- **Session entries**: new writes use the neutral, versioned types `com.auto-router.v1.decision` / `com.auto-router.v1.state`; legacy omp `com.omp.auto-router.*` entries are still read back.
- **Path activation** (`activate:` in config): longest-prefix match; works on Pi `session_start`.
- **Print/JSON modes**: UI calls (widget, prompts, notifications) degrade to no-ops; routing itself is unaffected.

### Command-level Pi differences

| Command | Pi behavior | omp difference |
|---|---|---|
| `status` | Identifies `mode: A (stream delegation)` after the active profile and latest decision. | omp reports its own adapter mode/state. |
| `doctor` | Reports the required public Mode A surface, project-trust state, and UVI as an **optional unavailable** capability. | The omp adapter reports its H1–H7 host probe matrix and can expose quota capabilities. |
| `uvi show\|enable\|disable\|refresh` | Every action returns the explicit unavailable notice; it does not toggle state or fabricate/refetch quota. | Available only when omp exposes usage-report quota data. |
| `usage [page]` | Shows settled local calls, local budgets, and any authenticated provider balance; UVI/quota windows are unavailable. | Can include host usage-report quota windows. |
| `use <profile>` | Resolves the already-registered `auto-router/<profile>` through Pi's public model registry. With scoped models, both the virtual profile and real targets must be allowed. | omp resolves through its model facade/model-role configuration. |
| `reload` | Re-reads the user layer and the project layer only when Pi trusts the project. | omp reads its normal user/project layers. |
| `budget`, `shadow`, `rules`, `rate`, `list`, `show`, `explain`, `help` | Same command semantics. `rate` and a populated `explain` require a settled routed request; headless print/JSON UI output is a safe no-op. | No intentional behavior difference. |



## Enabling routing

*(omp host; on Pi, select `auto-router/<profile>` in the model selector or `/auto-router use <profile>` — see [Pi support](#pi-support-and-capability-degradation).)*

```text
/model or /switch auto-router/<profile>
  → select Auto Router: <profile> (for example, /switch auto-router/company)
```
`/switch newapi/gpt-5.5` bypasses the plugin and goes directly to OMP's built-in NewAPI transport. The direct model's wire protocol is determined by OMP's model catalog (static `models.yml` records / provider discovery), not by an auto-router target.

Or take over globally / per role (`~/.omp/agent/config.yml`):

```yaml
modelRoles:
  default: auto-router/premium   # main session routed by complexity
  task:    auto-router/economy   # subagents use the money-saving profile (verified)
  smol:    auto-router/economy   # lightweight tasks like titles/memory
```

Once selected, **no manual intervention is needed**: every request is auto-classified and routed. Switch anytime with `/auto-router use <profile|alias>` (millisecond-level, persisted per session).

## Complexity tiers & shortcuts

| Tier | Typical signals | Effect |
|---|---|---|
| `trivial` | short Q&A, no code | thinking low |
| `simple` | single-file edits, explanations, grep-like | thinking low |
| `standard` | code blocks, multi-file paths, diffs, implementation phrasing | thinking medium |
| `complex` | refactor/migration/architecture keywords, long context, multi-turn same-task | thinking high |

> **Split analysis**: the prompt is split into a phase sequence by phase conjunctions (`并/然后/接着/随后/再`, `and/then`) and sentence boundaries, and **the first phase sets the tier** — later phases are classified when their own turn arrives, so the tier flows with the phases. "帮我设计并实现一个登录功能" starts with design → complex (the build turn lands standard later: complex→standard); "实现支付逻辑，然后设计对账方案" starts with the build → standard (the design turn escalates: standard→complex); "按设计方案实现支付逻辑" is a single phase building on an existing plan → standard. Hard scope words (`重构/迁移/架构/跨文件`, `refactor/migrate/rewrite`) only count inside the first phase.
>
> Mixed-phase prompts (both planning and implementation phrasing inside the first phase, e.g. "implement the payment logic per the design doc") are semantically hard for keywords: by default the router asks **the current LLM** (the last decision's target; on a fresh session, the standard tier's first target) for a one-word adjudication (trivial/simple/standard/complex). Precedence: shortcut pin > policy force-tier > LLM adjudication > heuristic classifier. Adjudication failures/timeouts/unparseable replies fall back to the heuristic result and never touch routing health state. Disable with `AUTO_ROUTER_LLM_ADJUDICATE=0` (legacy `OMP_AUTO_ROUTER_LLM_ADJUDICATE` still works).

Explicit pinning (highest priority, tokens stripped):

```text
@fast quick question
@swe refactor this module
@reasoning prove there are infinitely many primes
@long summarize this 80-page document      # forces contextWindow ≥ max(100k, estimate)
@vision describe this screenshot
@profile:economy temporarily switch profile (single request)
```

Low confidence (< 0.45) falls back to `defaultTier`; multi-turn same-task conversations stick upward and never demote — except a clean build phase (implementation phrasing, no multi-step/repair signals), which may downgrade complex→standard so the tier flows with the design→build phase transition.

### Trigger conditions & wordlists per tier

Tiering is decided by **weighted signal scoring** (argmax + confidence ≥ 0.45 required; below that, fall back to `defaultTier`). The adopted trigger conditions and wordlists, by tier:

#### → `complex` (weight 5, the only signal that pins complex directly)

Any **multi-step word** hit pushes complex; or `@reasoning` pinning; or context ≥ 100k tokens (epic).

**Multi-step words — substring match (includes Chinese)**
```
重构 迁移 重新设计 跨文件 跨模块 架构 多文件 多个文件
方案 设计 规划 规格 拆分 蓝图 路线图 拆解
```
```
refactor migrate migration redesign rearchitect re-architect overhaul rewrite
across files  multiple files  cross-file  architecture
```

> `方案/设计/规划/规格` and the whole-word `plan/design/spec` families are **soft planning words**, counted only inside the first task: demoted when that task also carries implementation phrasing (see the `standard` section), otherwise they push complex. All other multi-step words are hard scope terms and always escalate within the first task.

**Multi-step words — word-boundary match (whole English words, avoids false hits like `planetary`/`specific`/`respect`)**
```
plan plans planning planned          design designs designing
spec specs specification specifications
roadmap blueprint strategy decompose modularize modularise restructure
```

**Pinning**: `@reasoning` (conf 1.0, highest priority).

#### → `standard`

Any of these strong signals, with no multi-step word claiming complex:
- structural code signals: code fences ` ``` ` / `~~~`, multi-file paths (`src/a.ts` etc.), diffs (`+++`/`---`/`@@` or line-leading `+/-`), stack traces (`at X (file:line)` / Traceback)
- repair/debug words (promote to standard, not complex):
  ```
  bug debug debugging broken crash exception stack trace traceback runtime error
  why is  why does  why did  what's wrong  what is wrong
  报错 异常 崩溃 排查 定位问题 什么原因 为什么会 为什么报错
  ```
- implementation phrasing (promotes to standard; soft planning words in the current task are demoted from complex):
  ```
  实现 开发 新增 添加 写个 写一个 做个 做一个 落地
  ```
  whole English words (word-boundary match):
  ```
  implement implements implemented implementing implementation
  build builds building  create creates creating  add adds adding
  develop develops developing
  ```
- code / analysis intent (intent words like `实现`, `analyze`, `分析`) without structural signals
- context 32k–100k tokens (long)
- pinning: `@swe`

#### → `simple`

- context 4k–32k tokens (medium)
- image input (without multi-step/repair signals)
- single-file edits, explanations, grep-like queries
- pinning: `@fast`

#### → `trivial`

- short general Q&A (estimated < 200 tokens, no code/repair/image signals)
- context < 4k tokens (short)
- no dedicated pinning token (`@fast` lands on simple, already one of the lowest tiers)

#### Intent wordlists (assist standard/trivial decisions)

| intent | English | Chinese |
|---|---|---|
| code | code coding function bug debug compile exception typescript javascript python regex sql api endpoint unit test implement refactor runtime error | 代码 报错 函数 调试 编译 实现 修复 |
| creative | poem poetry story blog essay lyrics song novel fiction joke | 写诗 诗歌 诗 故事 小说 博客 散文 文案 歌词 |
| analysis | analyze analyse analysis summarize summary compare comparison contrast review evaluate assessment explain pros and cons | 分析 总结 对比 比较 评审 评估 解释 |

> Wordlist sources: `src/core/complexity-classifier.ts` (multi-step/repair), `src/core/intent-classifier.ts` (intent), `src/core/context-analyzer.ts` (context bands), `src/core/shortcut-parser.ts` (pinning tokens). Wordlists are tunable; changes don't affect routing logic.

## Commands

| Command | Description | Example |
|---|---|---|
| `/auto-router status` | current profile + latest decision + mode | `/auto-router status` |
| `/auto-router profiles` / `current` | list / current profile | `/auto-router profiles` |
| `/auto-router use <profile\|alias>` | switch profile (persisted; survives resume/branch) | `/auto-router use economy` |
| `/auto-router list` / `show <profile>` | current profile's tier chain / profile details | `/auto-router show premium` |
| `/auto-router explain` | full reasoning chain of the last decision (including host-available quota data) | `/auto-router explain` |
| `/auto-router doctor` | host capability diagnostics + configuration errors (omp: H1–H7; Pi: Mode A/trust/UVI) | `/auto-router doctor` |
| `/auto-router reload` | re-read auto-router.yml | `/auto-router reload` |
| `/auto-router budget show\|set <p> <usd> [monthly]\|clear <p>` | budget management (warn 80% / block 100%) | `/auto-router budget set google 20 monthly` |
| `/auto-router uvi show\|enable\|disable\|refresh` | usage-report quota pacing; Pi explicitly reports it unavailable for every action | `/auto-router uvi show` |
| `/auto-router shadow show\|enable\|disable` | shadow mode | `/auto-router shadow enable` |
| `/auto-router rate good\|bad [comment]` | decision feedback (persisted) | `/auto-router rate good good pick` |
| `/auto-router rules [show]\|add\|remove <list> <words…>\|reset` | view/edit complexity classification rules (persisted; takes effect next request) | `/auto-router rules add mechanicalOp 同步数据` |
| `/auto-router help` | all subcommands with examples | `/auto-router help` |

In-request pinning: `@fast` / `@swe` / `@reasoning` / `@long` / `@vision` / `@profile:<name>` (see previous section).

## omp integration points

| omp mechanism | Integration |
|---|---|
| `modelRoles` | a profile is a virtual model; any role can point at it (including `task` subagents, verified) |
| config layering | `auto-router.yml` mirrors omp's user/project layering convention |
| `omp --profile <name>` | agent dir follows; each omp profile gets its own `auto-router.yml` |
| session persistence | decisions are written to the session via `appendEntry`; `explain` still works after resume/branch |
| event system | `auto_retry_*` / `credential_disabled` go to the event log for stats; host events persist only whitelisted scalar fields, with strings secret-redacted |
| credentials | reuses omp `agent.db` multi-credential (`modelRegistry.getApiKey`); no separate auth |
| subagents | point `modelRoles.task` at `auto-router/<profile>` to route them (verified) |

## Security & credentials

- **No separate credential store**: API keys are fetched at runtime through the host's public auth resolution (omp `modelRegistry.getApiKey`; Pi `getApiKeyAndHeaders`); no keys in config, nothing persisted by the plugin.
- **Transport**: balance/quota probes use `https` + `Authorization: Bearer`; keys never go into URLs or logs.
- **Disk whitelist**: host events (`auto_retry_*` / `credential_disabled` etc.) keep only whitelisted scalar fields (`provider` / `model` / `attempt` / `reason`); nested objects and request content are dropped.
- **Write-time redaction**: every string written to `auto-router.events.jsonl` / `budget-*.json` / `ratings.json` (including error strings) passes through `redactSecrets` — Bearer tokens, `sk-` / `ghp_` / `AKIA` / JWT / PEM key blocks / URL-embedded credentials are all replaced with `[REDACTED]`.
- **Path guard**: `state-store` rejects names containing path separators or dot-escapes (`assertBareName`); config paths are fixed constant joins.
- **Bounded persistence**: `ratings.json` keeps the latest 1000 ratings by default (`FeedbackTracker.maxEntries`), avoiding unbounded growth.

Secret redaction and whitelist rules live in `src/core/redact.ts` (the path guard is in `src/core/state-store.ts`). These are defense-in-depth on top of "first discipline: don't leak", not a replacement for it.

## Verification & debugging

```text
/auto-router doctor      # capability probe matrix — start here
/auto-router explain     # why this model was picked last time
```

Event log (one `decision` line + one `settled` line per request, with real token usage and estimated cost):

```bash
tail ~/.omp/agent/auto-router/auto-router.events.jsonl        # omp
tail "${PI_CODING_AGENT_DIR:-~/.pi/agent}/auto-router/auto-router.events.jsonl"   # Pi
```

Budget/rating persistence: `budget-usage.json`, `budget-limits.json`, `ratings.json` in the same host state directory.

Repo-level verification (from the package directory):

```bash
bun run verify                        # full test suite + three isolated type checks (runtime / omp adapter / pi adapter)
./node_modules/.bin/pi --list-models -e .   # Pi model-discovery probe: lists the auto-router/<profile> models
```

## Limitations

- Virtual model metadata (contextWindow etc.) is static; only affects `/model` display
- Under multi-session (RPC), ctx is a process-level singleton; the plugin assumes a "single active session"
- Env switches resolve in the order `AUTO_ROUTER_*` > `OMP_AUTO_ROUTER_*` (legacy) > `PI_AUTO_ROUTER_*`; supported suffixes: `UVI_HARD`, `CONFIDENCE_THRESHOLD`, `QUOTA_REFRESH_MS`, `COOLDOWN_MS`, `LLM_ADJUDICATE`. Other suffixes are not implemented
- On Pi, UVI quota pacing is unavailable (no public usage-report API) — see [Pi support and capability degradation](#pi-support-and-capability-degradation)
- The plugin is not yet distributed via the omp marketplace / `omp install` (currently referenced as a directory)

## Compatibility & maintenance

The extension **never modifies, patches, or vendors host source** (omp or Pi). Compatibility is maintained exclusively through public host interfaces plus runtime capability probes (`/auto-router doctor`); when a capability is absent the dependent feature degrades explicitly rather than monkey-patching around it.

## Development

```bash
bun install
bun test tests/          # full suite (core + runtime + both adapters)
bun run verify           # tests + three isolated type checks below
bun run check:runtime    # runtime tsc
bun run check:adapter    # omp adapter tsc (host types are structural subsets + ambient shims)
bun run check:pi         # Pi adapter tsc (against @earendil-works/pi-* public types)
```

Directory layout:

```
src/core/          routing engine (host-agnostic, zero host imports; directly testable with bun:test)
src/core/redact.ts       secret redaction + event disk-write whitelist
src/runtime/       shared RouterRuntime: orchestration, failover, budgets, commands, widget, config
src/omp-adapter/   omp adapter layer (ExtensionAPI mapping)
src/pi-adapter/    Pi adapter layer (public ModelRegistry/Provider delegation)
auto-router.example.yml
```
