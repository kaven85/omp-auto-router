/**
 * Adapter-side state shared across the extension entry: the router's core
 * singletons plus the adapter's host mappings. One instance per session.
 */

import { BudgetTracker } from "../core/budget-tracker";
import { CircuitBreaker } from "../core/circuit-breaker";
import { DecisionStore } from "../core/decision-store";
import { EventLog } from "../core/event-log";
import { FeedbackTracker } from "../core/feedback-tracker";
import { JsonStateStore } from "../core/state-store";
import { LatencyTracker } from "../core/latency-tracker";
import { ProfileRegistry } from "../core/profile-registry";
import type { HostPorts } from "../core/host-ports";
import type { BudgetLimit, RouterConfig, RoutingDecision, QuotaSnapshot } from "../core/types";
import type { OmpExtensionContext, OmpModel } from "./omp-api";

export function collectProfileBudgets(config: RouterConfig): Record<string, BudgetLimit> {
	const merged: Record<string, BudgetLimit> = {};
	for (const profile of Object.values(config.profiles)) {
		if (!profile.budgets) continue;
		for (const [provider, limit] of Object.entries(profile.budgets)) {
			merged[provider] = limit;
		}
	}
	return merged;
}

/** Warm-start circuit breaker and latency rolling means from persisted snapshots (best effort). */
function restoreTrackers(stateStore: JsonStateStore, circuit: CircuitBreaker, latency: LatencyTracker): void {
	const circuitSnapshot = stateStore.readJson<Record<string, { consecutiveFailures: number; openedAt: number; cooldownMs: number }>>("circuit.json");
	if (circuitSnapshot) circuit.restore(circuitSnapshot);
	const latencySnapshot = stateStore.readJson<Record<string, number>>("latency.json");
	if (latencySnapshot) latency.restore(latencySnapshot);
}

/** Persist circuit breaker + latency snapshots so restarts keep warm-start data. */
export function persistTrackers(state: AdapterState): void {
	state.stateStore.writeJson("circuit.json", state.circuit.snapshot());
	state.stateStore.writeJson("latency.json", state.latency.snapshot());
}

export interface AdapterState {
	config: RouterConfig;
	registry: ProfileRegistry;
	circuit: CircuitBreaker;
	latency: LatencyTracker;
	budgets: BudgetTracker;
	decisions: DecisionStore;
	eventLog: EventLog;
	/** agentDir-scoped JSON state (config-independent persistence). */
	stateStore: JsonStateStore;
	/** Raw omp models by "provider/id" key, from ctx.models.list(). */
	modelsByKey: Map<string, OmpModel>;
	/** Cached HostPorts bound to the adopted ctx; rebuilt when ctx changes. */
	hostPorts: { ctx: OmpExtensionContext; host: HostPorts } | undefined;
	/** True once a configured target resolved in the live registry; skips the per-request polling grace period. */
	modelsReady: boolean;
	/** Resolved project path for path-activation; mirrors ctx.cwd. */
	cwd: string;
	/** Last pipeline result (for /auto-router explain). */
	lastDecision: { at: number; decision: RoutingDecision; cleanPrompt: string } | undefined;
	/** Capability-probe results (H1..H7) filled by the entry / doctor. */
	doctorProbes: {
		registerProvider: boolean;
		models: boolean;
		setModel: boolean;
		retryEvents: boolean;
		appendEntry: boolean;
		ui: boolean;
		quota: boolean;
	};
	/** Non-fatal config validation errors surfaced by /auto-router doctor. */
	configErrors: string[];
	/** Host extension context captured at session_start (streams run outside ctx). */
	ctx?: OmpExtensionContext;
	/** UVI monitoring on/off (default on; /auto-router uvi toggle). */
	uviEnabled: boolean;
	/** Shadow mode: log pipeline result but route in config order (default off). */
	shadowEnabled: boolean;
	/** Throttled quota fetch cache: { at, data }. */
	quotaCache: { at: number; data: QuotaSnapshot[] };
	/** "provider/model" → epoch ms until which the target is excluded (transient cooldown after failure). */
	cooldowns: Map<string, number>;
	/** Epoch ms of the most recent test/build tool failure; drives temporary tier escalation. */
	testFailureAt: number | undefined;
	/** User ratings of routing decisions. */
	ratings: FeedbackTracker;
	/** Per-session settled-call stats (normal mode only; shadow pauses counting). */
	sessionUsage: {
		/** "provider/model" → successful settled call count this session. */
		calls: Map<string, number>;
		/** "provider/model" → estimated USD cost this session. */
		cost: Map<string, number>;
		/** "provider/model" → distinct thinking levels used this session (shadow pauses tracking). */
		thinking: Map<string, Set<string>>;
	};
}

export function createAdapterState(
	config: RouterConfig,
	stateDir: string,
	cwd: string,
	configErrors: string[] = [],
): AdapterState {
	const stateStore = new JsonStateStore(stateDir);
	const usageStore = {
		load: () => stateStore.readJson<import("../core/types").BudgetUsage>("budget-usage.json"),
		save: (v: unknown) => stateStore.writeJson("budget-usage.json", v),
	};
	const limitsStore = {
		load: () => stateStore.readJson<Record<string, import("../core/types").BudgetLimit>>("budget-limits.json"),
		save: (v: unknown) => stateStore.writeJson("budget-limits.json", v),
	};
	const ratingsStore = {
		load: () => stateStore.readJson<import("../core/types").RatingEntry[]>("ratings.json"),
		save: (v: unknown) => stateStore.writeJson("ratings.json", v),
	};
	const budgets = new BudgetTracker(usageStore, limitsStore);
	budgets.mergeProfileLimits(collectProfileBudgets(config));
	const circuit = new CircuitBreaker();
	const latency = new LatencyTracker();
	restoreTrackers(stateStore, circuit, latency);
	return {
		config,
		registry: new ProfileRegistry(config, { cwd }),
		circuit,
		latency,
		budgets,
		decisions: new DecisionStore(),
		eventLog: new EventLog(stateDir),
		stateStore,
		modelsByKey: new Map(),
		hostPorts: undefined,
		modelsReady: false,
		cwd,
		lastDecision: undefined,
		doctorProbes: {
			registerProvider: false,
			models: false,
			setModel: false,
			retryEvents: false,
			appendEntry: false,
			ui: false,
			quota: false,
		},
		configErrors,
		uviEnabled: true,
		shadowEnabled: false,
		quotaCache: { at: 0, data: [] },
		cooldowns: new Map(),
		testFailureAt: undefined,
		ratings: new FeedbackTracker(ratingsStore),
		sessionUsage: { calls: new Map(), cost: new Map(), thinking: new Map() },
	};
}

/** Refresh the raw-model index from the host (ctx.models). */
export function refreshModels(state: AdapterState, ctx: OmpExtensionContext): void {
	state.modelsByKey.clear();
	for (const model of ctx.models.list()) {
		state.modelsByKey.set(`${model.provider}/${model.id}`, model);
	}
}
