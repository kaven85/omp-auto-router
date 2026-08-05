# Changelog

## [Unreleased]

### Fixed

- `profile.budgets` in `auto-router.yml` now actually constrain routing; persisted command limits (`/auto-router budget set`) still take precedence over profile defaults.
- Context token estimation now uses the host's `ctx.getContextUsage()` when available, with a fallback that sums all visible text (messages + system prompts). This makes `long`/`epic` classification and `@long` constraints reliable in real conversations.
- `OMP_AUTO_ROUTER_UVI_HARD` and `OMP_AUTO_ROUTER_CONFIDENCE_THRESHOLD` environment flags are now wired into the routing pipeline.
- The tier's `thinking` level is now applied to the real request: set before the delegate stream starts and restored to the session's previous level afterwards (skipped in shadow mode).

### Added

- `BudgetTracker.mergeProfileLimits()` / `clearProfileLimits()` so config-provided budget defaults and user overrides coexist.
- Circuit breaker and latency rolling means now persist across restarts (`circuit.json` / `latency.json`), restored at state creation and saved after each settled stream and on `session_shutdown`.
- Entry-level tests for boot, session ctx adoption rules, path activation, and decision restore (`tests/omp-adapter/index.test.ts`); direct `fetchQuota` / `enrichCandidates` tests (`tests/omp-adapter/host-ports.test.ts`).

## [0.1.0] - 2026-08-05

### Changed

- Host ports now resolve models through the live `ctx.models` facade instead of the load-time `modelsByKey` snapshot, so providers authenticated or discovered after extension load are routable.
- Config reload (`/auto-router-reload`) now carries over the live session context, restores persisted routing decisions, and refreshes the model index on the fresh state.

### Fixed

- Custom providers discovered asynchronously during host startup were excluded from routing candidates. The stream handler now waits a bounded grace period (50ms × up to 100 attempts, abort-aware) for a configured target to appear in the live registry before enriching candidates.

## [0.0.1] - 2026-08-01

- Initial release: profile-based, complexity-aware auto router core and omp adapter (Mode A virtual provider).
