# Changelog


## [Unreleased]

### Added

- Route targets can override their tier's thinking level with `thinking` (for example `{ provider: newapi, model: gpt-5.6-sol, thinking: low }`). The override is resolved per failover candidate, still clamped by that target's `thinkingCap`, and the previous session thinking level is restored after each delegate stream.


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

- Initial release: profile-based, complexity-aware auto router core and omp adapter (Mode A virtual provider).
