# Changelog

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
