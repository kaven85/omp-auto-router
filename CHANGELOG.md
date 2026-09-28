# Changelog

## [Unreleased]

## [0.8.0] - 2026-09-28

### Added

- **仪表盘 widget 新增缓存率行**：UVI 行后渲染 `cache: <provider> hit N.NN% · read X`，有缓存写入时追加 `· write Y`，按当前 provider 聚合其所有模型的会话内 prompt token（fresh / cacheRead / cacheWrite）。命中率 = cacheRead / (input + cacheRead + cacheWrite)，与 pi-ai 的 Anthropic 风格 usage 语义一致（`input` 不含缓存 token）。数据来自 `recordUsage` 新累计的 `sessionUsage.inputTokens/cacheRead/cacheWrite`，shadow 模式下不计入。
- **熔断状态跨会话持久化 + half-open 试探租约**：circuit 记录携带 `updatedAt`，成功写入 tombstone 而非删除，共享状态文件合并不会复活其他会话已消除的故障；`mergeSnapshot` 按 key 保留最新记录并清理 24h 前 tombstone，`persistRuntimeTrackers` 对 `circuit.json` 原子 read-modify-write。`tryAcquireTrial`/`releaseTrial` 进程内租约使单个 half-open 探测在并发请求间原子；租约改为在 host 真正打开 provider 流时才预留（`deferTrialReservation`），不再因排队在 OMP host 全局流锁后而误判；忙碌租约是路由内部并发控制而非 provider 故障，不再重开熔断或翻倍退避。circuit-open 排除原因现在提示 retry-in 秒数；`/auto-router reset` 同时清除熔断（以 tombstone 形式）与 cooldown 并立即持久化，两个 adapter 均接入 `persistTrackers`。
- **某层无可用目标时跨层可用性回退**：当一层所有目标都熔断/冷却/预算阻断时，不再让整个 profile 失败——pipeline 按剩余声明层回退，先向上（受升级上限与 role tierFloor 约束）再向下，采用第一个有可用候选的层。运行在 capability 升级之后，必需 capability 仍优先最近的更高 capable 层；固定 targets 链保持严格不回退。

### Fixed

- **复杂度分级不再被上一轮锁定**：每个请求按其当前任务复杂度独立定层；测试/构建失败仍会临时抬高下一请求的最低层级。

## [0.7.1] - 2026-08-25

### Fixed

- **Router error events expose `errorMessage` for host retry policies**: `routerErrorEvent` now includes a top-level `errorMessage` field. Pi's retry path reads this field instead of rendered assistant content, so transient router failures are classified as retryable and failover to the next candidate works. The omp adapter stream contract already carried the message in assistant content; tests now assert both hosts surface the text through the new field.


## [0.7.0] - 2026-08-24

### Added

- **Role routing (profile >> role)**: profiles gain an optional `roles` map so omp `modelRoles` can point each role at `auto-router/<profile>/<role>` — a profile picks the provider set, the role picks the chain inside it. Two role forms: a fixed `targets` chain (classification and LLM adjudication skipped, zero overhead) or `tierFloor`/`tierCap` soft clamps (classification runs as usual, result bounded). Shortcut pins (`@fast`/`@swe`/`@reasoning`) always escape both forms into the classified tier; undeclared roles route as `default`; `roles.default` may clamp the main session itself. Thinking precedence is target > role > tier.
- Virtual model registration now expands to profile × declared roles (`Auto Router: <profile> (<role>)` in `/model`); the bare `auto-router/<profile>` id is unchanged and equivalent to the `default` role.
- Role visibility: the status line shows `<profile>/<role>` for non-default roles, `/auto-router explain` prints `role=`, and decision events carry `role`.
- `/auto-router doctor` now probes `modelRoles`↔profile consistency (omp): it reads the user/project `config.yml` layers and flags dangling profile references (❌ with the available profile list), role segments not declared in the profile (⚠️ — they silently route as the default chain), and routed virtual models missing from the host registry (❌ pointing at H1). Entries pointed at real providers are ignored.

### Changed

- LLM adjudication of mixed-phase prompts now runs only for the `default` role — subagent/lightweight roles no longer spend an extra LLM call on tier ambiguity.

### Compatibility

- Existing configs are untouched: profiles without `roles` behave exactly as before, and `auto-router/<profile>` keeps its meaning. `RoutingDecision` gains a required `role` field; persisted legacy decisions without it display as `default`.

### Fixed

- **Trivial prompts no longer escalate with session context**: the short-Q&A signal measured the *context* estimate, which never fires in real sessions (the system prompt alone exceeds 200 tokens) — so a "你是谁" at 150k context hit `epic context` (weight 3) and routed to the top tier. The signal now measures the prompt itself, and a short general Q&A suppresses the context-size signal entirely. Context size is treated as a window capability, not a reasoning tier: epic contexts (≥100k tokens) auto-set a `minContextWindow` requirement (mirroring `@long`) and cap the classifier tier at `standard` — multi-step phrasing is the only path to `complex`. When the resolved tier's models are all smaller than the requirement, routing escalates to the nearest higher tier with a fitting window (same pattern as the reasoning guarantee).
- **Pi terminal error events now unwrap to their real message**: a pre-content `{type:"error", reason:"error"}` event carries its text at `error.errorMessage`, which `extractMessage` didn't read — so `formatError` fell back to a raw JSON dump (thinking content included) in cooldown reasons and event logs, and `defaultIsRetryable` saw no message at all, classifying transient socket failures as non-retryable and suppressing failover to the next candidate. `extractMessage` now reads top-level and nested `errorMessage`.

### Removed

- **Duplicate config loader**: the omp adapter's `assemble`/`readConfigFileSync`/`DEFAULT_CONFIG` duplicated `src/runtime/config.ts`; omp now wires only its paths (`.omp`, `PI_CODING_AGENT_DIR`) onto the single shared loader, including a new sync user+project variant `loadRouterConfigurationSync`.
- **Duplicate path activation**: `src/runtime/activation.ts` and `ProfileRegistry`'s private copy implemented the same `activate[].path` rule; the shared `matchPathActivation` now lives once in `src/core/profile-registry.ts` and both adapters + the registry use it.
- **Dead `conversationDepth` parameter**: declared in three types and passed through `pipeline`/`router-runtime`, but never read by `classifyComplexity`; removed along with the unused `RoutingContext` interface.
- **Duplicate target enumeration**: `runtime/commands.ts`'s private `getConfiguredTargets` duplicated `adapter-kit.configuredTargets`; both now use the single registry-based implementation.
- **Duplicate adjudication constants** (`ADJUDICATION_TIMEOUT_MS`/`ADJUDICATION_MAX_CHARS`): hoisted to `src/core/llm-adjudication.ts` and shared by both adapters.
- **Duplicate model metadata**: the omp command fallback rebuilt `VIRTUAL_MODEL_BASE` inline; it now reuses the exported constant. Duplicate `OmpProviderStreamModel` type (byte-identical to `OmpModel`) and the unused `src/core/index.ts` barrel removed.
- **Dead imports** across core/runtime/adapter and three test files (verified via `tsc --noUnusedLocals`).


## [0.6.0] - 2026-08-14

### Added

- Pi host adapter (`src/pi-adapter`): the package now declares a second host entry (`pi.extensions`) and runs on Pi via **public-interface stream delegation** — real providers are reached only through Pi's public ModelRegistry/Provider surface (`find` / `getProvider` / `getApiKeyAndHeaders`); no host source is modified, patched, or vendored. Profiles appear in the Pi model selector as `auto-router/<profile>`, `/auto-router use <profile>` switches via the model registry, and the full `/auto-router` command set is at parity with omp.
- Pi lifecycle wiring: project-layer config (`<repo>/.pi/auto-router.yml`) loads only for trusted projects (untrusted projects are ignored and `doctor` says so), `/auto-router reload` re-reads both layers, persisted decisions survive session resume/branch (tree restore), trackers persist on `session_shutdown`, and `activate:` path activation (longest-prefix match) works on `session_start`.
- Shared RouterRuntime (`src/runtime`): orchestration, failover, budgets, commands, widget, and config now live in one host-neutral implementation consumed by both adapters. Command behavior, the env-var dictionary, and the provider dictionary are unified across hosts.
- Neutral, versioned custom session entry types: new writes use `com.auto-router.v1.decision` / `com.auto-router.v1.state`; legacy omp `com.omp.auto-router.*` entries are still read back.
- Neutral env-var chain with precedence `AUTO_ROUTER_*` > `OMP_AUTO_ROUTER_*` (legacy alias) > `PI_AUTO_ROUTER_*`, covering `COOLDOWN_MS`, `QUOTA_REFRESH_MS`, `UVI_HARD`, `CONFIDENCE_THRESHOLD`, and `LLM_ADJUDICATE`.
- `scripts/routing-stats.ts --host omp|pi`: the analytics script can now aggregate the Pi state directory (`$PI_CODING_AGENT_DIR/auto-router`, else `~/.pi/agent/auto-router`); an explicit path argument still wins.
- Pi UVI explicit degradation: Pi's public interface has no usage-report quota API, so `/auto-router uvi`, `usage`, and `doctor` report UVI as explicitly unavailable instead of pretending quota is unused; the adapter never fabricates quota. Local budgets, session usage, provider balance endpoints (authenticated via `getApiKeyAndHeaders`), ratings, and cooldown/circuit/failover remain fully functional on Pi.

### Changed

- Dashboard widget duplicate-render suppression is now scoped per session instance instead of globally, so concurrent sessions no longer suppress each other's refreshes.
- Verification is one command: `bun run verify` runs the full test suite plus three isolated type checks (`tsconfig.runtime.json` / `tsconfig.adapter.json` / `tsconfig.pi-adapter.json`).

### Fixed

- LLM adjudication of mixed-phase prompts and the `UVI_HARD` / `CONFIDENCE_THRESHOLD` env wiring are honored again by the shared runtime — both had gone inert after the runtime migration.

### Compatibility

- Tested against the Pi 0.84.1 dev fixture through its public extension interface only; compatibility is defined by the public capability contract (ModelRegistry `find`/`getProvider`/`getApiKeyAndHeaders`/`complete`, trusted-project config, custom session entries, widget/notify with headless no-op degradation), not by a pinned host build. omp support is unchanged from 0.5.0. Required vs optional host capabilities are probed at runtime and reported by `/auto-router doctor`. Authenticated end-to-end smoke on both hosts is still pending manual execution — no real-provider results are claimed here.


## [0.5.0] - 2026-08-12

### Added

- Route targets can override their tier's thinking level with `thinking` (for example `{ provider: newapi, model: gpt-5.6-sol, thinking: low }`). The override is resolved per failover candidate, still clamped by that target's `thinkingCap`, and the previous session thinking level is restored after each delegate stream.
- User-editable classifier keyword rules via `/auto-router rules add/remove/reset`, persisted as `classifier-rules.json`.
- LLM adjudication for mixed-phase prompts: when the keyword classifier flags a request that bundles phases, the session's current LLM picks the tier; any error, timeout, or unparseable reply fails open to the heuristic decision.

### Security

- Project-layer config (`.omp/auto-router.yml` in a cloned repo) can no longer set `balanceEndpoint`: a malicious repo could otherwise receive the user's real provider API key as a Bearer token. The endpoint is only honored from the user config layer, and the balance fetch now carries a 10s timeout so a hung endpoint cannot block the request path.
- Redaction gaps closed in `redactSecrets` (moved to `src/core`): compound labels such as `aws_secret_access_key=…` evaded the word-boundary anchor; Groq/xAI/Perplexity/HuggingFace/GitLab/GitHub fine-grained/SendGrid key prefixes, non-HTTP URL credentials (`postgres://`, `redis://`), AWS presigned-URL parameters, `Authorization: Basic/Digest`, special-character passwords, and truncated PEM blocks now all redact. The cooldown failure reason and the failover aggregate error — both persisted — now pass through redaction like the event log already did.
- User classifier keywords are escaped before regex compilation: a persisted keyword like `C++` or `(a+)+` previously broke routing on every request (SyntaxError) or hung the process (catastrophic backtracking). Persisted `classifier-rules.json` is also shape-validated on load.
- Config/state maps keyed by YAML/JSON names now reject `__proto__`/`prototype`/`constructor` keys, preventing silent prototype mutation of profile, budget, and usage maps.
- LLM adjudication hardening: the user request is delimited and marked as data (prompt-injection tier steering), verbose adjudicator replies parse the last tier word instead of the first (negation safety), and the reply buffer is capped at 4096 chars.


## [0.4.2] - 2026-08-11

### Fixed

- Provider errors were logged as `[object Object]`: omp providers throw plain objects (`{status, error:{message}}`), and `String()` erased them. A new `formatError` unwraps Error/string/`{message}`/`{error:{message}}` shapes, annotates `[status N]`, and falls back to JSON — applied to every event-log error append (target failure, failover, thinking-level restore, quota fetch).
- Pressing Esc no longer cools the target down: `onTargetFailed` fired before the AbortError guard, and pi-ai's `{type:"error", reason:"aborted"}` terminal event bypassed it entirely, so a user abort put the target into cooldown and left single-target profiles with "no eligible candidates". Abort checks now run before failure recording — neither AbortError nor an aborted terminal event touches cooldown/circuit/failover.

### Changed

- Post-failure cooldown default shortened from 5 minutes to 60s, overridable via `OMP_AUTO_ROUTER_COOLDOWN_MS` (floored at 5s).
- Cooldowns now record the failure that caused them: the "no eligible candidates" error names the excluding layer (`auto-router [constraint-solver]`) and shows each cooled target's last failure, e.g. `cooling down until … (last failure: rate limit reached [status 429])`.


## [0.4.1] - 2026-08-11

### Fixed

- Request-path balance fetch was unreachable: the throttle gate keyed on `quotaCache.at`, but the quota cache was refreshed earlier in the same request, making the condition always false. Balance-capable providers (e.g. deepseek) now use a dedicated `balanceAt` timestamp decoupled from the quota cache, so the wallet balance renders in the dashboard widget on the first request.
- Widget UVI/balance lines now scope to the current provider only (the full breakdown is in `/auto-router usage`), and `balance:` renders separately from `uvi:` for balance-capable providers whose quota is tracked by wallet rather than usage windows.
- Decision line in the widget annotates per-token billing with `(per-token)` for immediate transparency.
- Routing latency now measures time to the first visible streamed output, including thinking deltas, rather than waiting for the first final-answer/tool event. Long visible reasoning no longer makes a responsive Kimi subscription appear stalled and yield priority to a metered fallback. The incompatible old rolling means are intentionally reset via the new `first-output-latency.json` persistence key, and the status/widget labels the metric as `first output`.

### Changed

- `buildWidgetLines` now requires the routed `decision` (or `undefined` when no decision exists) so the current provider can be identified for scoped widget rendering.


## [0.4.0] - 2026-08-10
### Added
- Subscription-first candidate ordering: within a partition bucket, subscription-billed candidates now outrank per-token ones, so paid quota is spent before metered balance. A per-token candidate only takes the lead when the subscription candidate's rolling latency crosses an absolute usability bar (`SUBSCRIPTION_LATENCY_MAX_MS`, 60s) and is worse than the metered candidate. Relative latency is deliberately ignored across billing groups.

### Fixed

- `/auto-router usage` is now the canonical name for the session usage command (the `useage` typo still works as an alias). Help text, README, and the internal `sessionUsage` state field renamed accordingly.
- Requests that reach the virtual provider before `session_start` (early prompts, extension hot-reload mid-session) now wait up to 5s for the boot event instead of failing immediately; the boot handler also writes through the live state ref so a config reload can't orphan the session context.

## [0.3.1] - 2026-08-07

### Added

- `OMP_AUTO_ROUTER_QUOTA_REFRESH_MS` env override for the background quota-refresh cadence (default 30000, floored at 10000 — provider usage reports update at minute granularity, so polling faster wastes auth-chain calls).
- Background quota refresh now pushes fresh UVI data to the dashboard widget immediately after landing, instead of waiting for the next request.
- Dashboard widget: UVI windows past their `resetsAt` are shown as freshly reset, and identical re-renders are suppressed.
- Thinking-cap clamping: each target model declares the thinking range it accepts (registry default, e.g. `deepseek-v4-pro` → `{min: high}`; overridable per-target via `thinkingCap: {min, max}`). A tier's configured thinking outside that range is clamped into range before the host is steered, and the clamp is recorded as a `warn` event with the original and applied levels. The `decision` event now also records the applied thinking level.

### Fixed

- Failover with no eligible candidates now raises an actionable error listing the exclusion reasons (unhealthy / cooldown / circuit / UVI / capability) instead of throwing a bare programmer error.

## [0.3.0] - 2026-08-05

### Added

- Provider registry (`src/omp-adapter/provider-registry.ts`): provider-specific knowledge (Kimi window labels, DeepSeek balance endpoint + parser) is centralized; a target-level `balanceEndpoint` in the profile config overrides the registry default, and generic `{currency, total_balance|balance}` payloads are accepted. All balance-capable providers now render in `/auto-router useage`.
- Background quota refresh: after `session_start`, UVI quota snapshots refresh every 30s on a host-managed timer (stopped on `session_shutdown`), so requests no longer block on the auth chain when the cache just expired.
- Dashboard widget: after each decision a profile/budget/circuit/UVI overview is rendered via the optional `setWidget` surface (probed at runtime; silent no-op when the host lacks it).
- `usage` is now an alias for `/auto-router useage`.
- Analytics script `scripts/routing-stats.ts`: aggregates the event log (decisions per profile/tier/target, failovers, top errors) with an optional `--tail N` window.

### Changed

- Event log rotates past ~2 MB, keeping the newest half (checked at most every ~8 KB of appends).
- Budget daily buckets older than 62 days are pruned on record; monthly rollups are retained.
- Keyword/word-boundary regexes in the intent and complexity classifiers are precompiled once at module load instead of per request.
- HostPorts are cached per adopted ctx instead of being rebuilt per request, and the configured-model discovery grace period runs once per session (`modelsReady`).

### Removed

- Dead `HostPorts.appendState`/`readState` session ports (never consumed; persistence goes through `appendEntry` directly) and the never-assigned `sessionId` state field.

## [0.2.0] - 2026-08-05

### Added

- Post-failure cooldown: a target that fails inside a failover chain is excluded for 5 minutes on subsequent requests; a success clears it. Wires up the previously dead `cooldownUntil` solver path.
- Rating feedback loop: candidates with ≥5 ratings and <40% good are stably demoted to the back of the chain (never removed); `/auto-router explain` now shows per-candidate rating stats.
- Test-failure escalation: a failing test/build bash command raises the tier floor by one level for 10 minutes; a passing run clears it (detected via `tool_result` interception).
- `BudgetTracker.mergeProfileLimits()` / `clearProfileLimits()` so config-provided budget defaults and user overrides coexist.
- Circuit breaker and latency rolling means now persist across restarts (`circuit.json` / `latency.json`), restored at state creation and saved after each settled stream and on `session_shutdown`.
- Entry-level tests for boot, session ctx adoption rules, path activation, and decision restore (`tests/omp-adapter/index.test.ts`); direct `fetchQuota` / `enrichCandidates` tests (`tests/omp-adapter/host-ports.test.ts`).

### Fixed

- `profile.budgets` in `auto-router.yml` now actually constrain routing; persisted command limits (`/auto-router budget set`) still take precedence over profile defaults.
- Context token estimation now uses the host's `ctx.getContextUsage()` when available, with a fallback that sums all visible text (messages + system prompts). This makes `long`/`epic` classification and `@long` constraints reliable in real conversations.
- `OMP_AUTO_ROUTER_UVI_HARD` and `OMP_AUTO_ROUTER_CONFIDENCE_THRESHOLD` environment flags are now wired into the routing pipeline.
- The tier's `thinking` level is now applied to the real request: set before the delegate stream starts and restored to the session's previous level afterwards (skipped in shadow mode).
- Failover latency is measured per target (from its own stream start), so a slow dead first candidate no longer poisons the fallback's rolling mean.

### Changed

- Adapter config loading: sync and async variants now share one layering implementation (`assemble`), eliminating drift between the production (sync) and tested (async) paths; a parity test locks them together.

## [0.1.0] - 2026-08-05

### Changed

- Host ports now resolve models through the live `ctx.models` facade instead of the load-time `modelsByKey` snapshot, so providers authenticated or discovered after extension load are routable.
- Config reload (`/auto-router-reload`) now carries over the live session context, restores persisted routing decisions, and refreshes the model index on the fresh state.

### Fixed

- Custom providers discovered asynchronously during host startup were excluded from routing candidates. The stream handler now waits a bounded grace period (50ms × up to 100 attempts, abort-aware) for a configured target to appear in the live registry before enriching candidates.

## [0.0.1] - 2026-08-01

- Initial release: profile-based, complexity-aware auto router core and omp adapter (virtual provider).
