# Changelog

## [0.1.0] - 2026-08-05

### Changed

- Host ports now resolve models through the live `ctx.models` facade instead of the load-time `modelsByKey` snapshot, so providers authenticated or discovered after extension load are routable.
- Config reload (`/auto-router-reload`) now carries over the live session context, restores persisted routing decisions, and refreshes the model index on the fresh state.

### Fixed

- Custom providers discovered asynchronously during host startup were excluded from routing candidates. The stream handler now waits a bounded grace period (50ms × up to 100 attempts, abort-aware) for a configured target to appear in the live registry before enriching candidates.

## [0.0.1] - 2026-08-01

- Initial release: profile-based, complexity-aware auto router core and omp adapter (Mode A virtual provider).
