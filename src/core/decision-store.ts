/**
 * DecisionStore — bounded in-memory history of RoutingDecisions.
 *
 * Newest-first listing, fixed capacity with oldest-first eviction, and a
 * `restore` path so a rebuilt session can reload prior decisions (e.g. from
 * the event log or HostPorts.readState).
 */

import type { RoutingDecision } from "./types";

/** Bounded ring of routing decisions, most recent retained. */
export class DecisionStore {
	private readonly capacity: number;
	private decisions: RoutingDecision[] = [];

	/**
	 * @param capacity Maximum retained decisions (oldest evicted first).
	 * @throws RangeError when capacity is not a positive integer.
	 */
	constructor(capacity = 50) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`DecisionStore: capacity must be a positive integer, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	/** Record a decision, evicting the oldest when over capacity. */
	record(decision: RoutingDecision): void {
		this.decisions.push(decision);
		if (this.decisions.length > this.capacity) {
			this.decisions.splice(0, this.decisions.length - this.capacity);
		}
	}

	/** Most recently recorded decision, if any. */
	last(): RoutingDecision | undefined {
		return this.decisions[this.decisions.length - 1];
	}

	/** All retained decisions, newest first. */
	list(): RoutingDecision[] {
		return [...this.decisions].reverse();
	}

	/**
	 * Replace the contents during session rebuild. `decisions` is in recorded
	 * (oldest → newest) order; only the most recent `capacity` are kept.
	 */
	restore(decisions: RoutingDecision[]): void {
		this.decisions = decisions.slice(-this.capacity);
	}

	/** Drop all retained decisions. */
	clear(): void {
		this.decisions = [];
	}
}
