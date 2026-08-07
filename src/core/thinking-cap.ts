/**
 * Thinking-cap clamping: bound a configured thinking level to the range a
 * target model actually accepts. Pure function over the ordered
 * `THINKING_LEVELS` ladder; used by the omp adapter before steering the host.
 */

import { THINKING_LEVELS, type ThinkingCap, type ThinkingLevel } from "./types";

/**
 * Clamp `level` into `cap`'s supported range (inclusive). Absent bounds are
 * unbounded; a cap that lists neither bound returns the level unchanged.
 */
export function clampThinking(level: ThinkingLevel, cap: ThinkingCap | undefined): ThinkingLevel {
	if (cap === undefined) return level;
	const index = THINKING_LEVELS.indexOf(level);
	if (cap.max !== undefined && index > THINKING_LEVELS.indexOf(cap.max)) return cap.max;
	if (cap.min !== undefined && index < THINKING_LEVELS.indexOf(cap.min)) return cap.min;
	return level;
}
