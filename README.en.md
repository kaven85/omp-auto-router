# omp-auto-router

[简体中文](README.md) | English

A profile-based, complexity-aware auto-routing plugin for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi): a set of model-selection strategies (profiles) that picks different models per task complexity, with same-request failover, budget/quota awareness, and explainable decisions.

Ported from the design ideas of [pi-auto-router](https://github.com/danialranjha/pi-auto-router), with omp-native adaptation and a decoupled refactor.

## Capabilities

- **Profile system**: multiple named profiles (e.g. `premium`/`economy`/`offline`), millisecond switching
- **Complexity tiers**: every request is auto-classified as `trivial / simple / standard / complex`; tier drives model + thinking effort
- **Explicit pinning**: `@reasoning` / `@swe` / `@long` / `@vision` / `@fast` / `@profile:<name>` (tokens are stripped automatically — the model never sees them)
- **Same-request failover**: if the first target fails (retryable error, no substantive output), the next candidate takes over; thinking-only partials don't block the switch
- **Budgets & quotas**: per-provider daily/monthly USD budgets (warn at 80%, block + switch chain at 100%), UVI quota pacing (critical blocks / stressed demotes / surplus promotes)
- **Policy rules**: force-tier / prefer / exclude-provider / force-billing / force-constraint, with hour-of-day and weekday conditions
- **Shadow mode**: record decisions but route by configured order, for comparison and validation
- **Explainable**: `/auto-router explain` prints the full reasoning chain; decisions/usage are persisted as JSONL

---

## Installation

The plugin is a directory containing a `package.json` (with an `omp.extensions` manifest). Two ways to load it:

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

---

## Onboarding (zero to working)

Follow these steps in order; each has a verifiable outcome. Once complete, the plugin takes over routing.

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

### Final onboarding checklist

- [ ] plugin directory referenced in `config.yml extensions` (or `--extension`)
- [ ] all targets in `auto-router.yml` are ids that exist in `/model`
- [ ] `modelRoles.default` (or manual `/model`) points at `auto-router/<profile>`
- [ ] `/auto-router doctor` shows no red items and no config errors
- [ ] event log shows decision + settled
- [ ] `@reasoning` pinning matches the `explain` reasoning chain



## Configuration

Config has two layers, merged by the plugin (builtin defaults < user < project):

| Layer | Path | Scope |
|---|---|---|
| user | `~/.omp/agent/auto-router.yml` | global |
| project | `<repo>/.omp/auto-router.yml` | overrides within that project (same-name profiles are replaced wholesale) |

Quick start: copy `auto-router.example.yml` from the repo root to `~/.omp/agent/auto-router.yml`, and replace `targets` with models that actually exist in your `/model` list.

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
| `balanceEndpoint` | string | no | custom balance API (per-token providers) |

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



## Enabling routing

```text
/model            → select Auto Router: <profile> (i.e. auto-router/<profile>)
```

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
| `standard` | code blocks, multi-file paths, diffs | thinking medium |
| `complex` | refactor/migration/architecture keywords, long context, multi-turn same-task | thinking high |

Explicit pinning (highest priority, tokens stripped):

```text
@fast quick question
@swe refactor this module
@reasoning prove there are infinitely many primes
@long summarize this 80-page document      # forces contextWindow ≥ max(100k, estimate)
@vision describe this screenshot
@profile:economy temporarily switch profile (single request)
```

Low confidence (< 0.45) falls back to `defaultTier`; multi-turn same-task conversations stick upward and never demote.

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
| `/auto-router explain` | full reasoning chain of the last decision (incl. exclusions, budget, UVI) | `/auto-router explain` |
| `/auto-router doctor` | capability probe matrix (H1–H7) + config errors | `/auto-router doctor` |
| `/auto-router reload` | re-read auto-router.yml | `/auto-router reload` |
| `/auto-router budget show\|set <p> <usd> [monthly]\|clear <p>` | budget management (warn 80% / block 100%) | `/auto-router budget set google 20 monthly` |
| `/auto-router uvi show\|enable\|disable\|refresh` | UVI quota pacing | `/auto-router uvi show` |
| `/auto-router shadow show\|enable\|disable` | shadow mode | `/auto-router shadow enable` |
| `/auto-router rate good\|bad [comment]` | decision feedback (persisted) | `/auto-router rate good good pick` |
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

- **No separate credential store**: API keys are fetched at runtime via the omp host's `modelRegistry.getApiKey`; no keys in config, nothing persisted by the plugin.
- **Transport**: balance/quota probes use `https` + `Authorization: Bearer`; keys never go into URLs or logs.
- **Disk whitelist**: host events (`auto_retry_*` / `credential_disabled` etc.) keep only whitelisted scalar fields (`provider` / `model` / `attempt` / `reason`); nested objects and request content are dropped.
- **Write-time redaction**: every string written to `auto-router.events.jsonl` / `budget-*.json` / `ratings.json` (including error strings) passes through `redactSecrets` — Bearer tokens, `sk-` / `ghp_` / `AKIA` / JWT / PEM key blocks / URL-embedded credentials are all replaced with `[REDACTED]`.
- **Path guard**: `state-store` rejects names containing path separators or dot-escapes (`assertBareName`); config paths are fixed constant joins.
- **Bounded persistence**: `ratings.json` keeps the latest 1000 ratings by default (`FeedbackTracker.maxEntries`), avoiding unbounded growth.

Secret redaction and whitelist rules live in `src/omp-adapter/redact.ts` (the path guard is in `src/core/state-store.ts`). These are defense-in-depth on top of "first discipline: don't leak", not a replacement for it.

## Verification & debugging

```text
/auto-router doctor      # capability probe matrix — start here
/auto-router explain     # why this model was picked last time
```

Event log (one `decision` line + one `settled` line per request, with real token usage and estimated cost):

```bash
tail ~/.omp/agent/auto-router/auto-router.events.jsonl
```

Budget/rating persistence: `~/.omp/agent/auto-router/budget-usage.json`, `budget-limits.json`, `ratings.json`.

## Limitations

- Virtual model metadata (contextWindow etc.) is static; only affects `/model` display
- Under multi-session (RPC), ctx is a process-level singleton; the plugin assumes a "single active session"
- `OMP_AUTO_ROUTER_*` env switches (e.g. UVI hard mode) are not implemented yet
- The plugin is not yet distributed via the omp marketplace / `omp install` (currently referenced as a directory)

## Development

```bash
bun install
bun test tests/          # full core + adapter suite (344 cases)
bun run check            # core tsc
bun run check:adapter    # adapter tsc (host types are structural subsets + ambient shims)
```

Directory layout:

```
src/core/          routing engine (host-agnostic, zero omp imports; directly testable with bun:test)
src/omp-adapter/   omp adapter layer (the only place that touches ExtensionAPI)
src/omp-adapter/redact.ts   secret redaction + event disk-write whitelist
auto-router.example.yml
```
