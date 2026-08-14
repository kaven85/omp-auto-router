import { BudgetTracker } from "../core/budget-tracker";
import { CircuitBreaker } from "../core/circuit-breaker";
import { sanitizeClassifierOverrides } from "../core/complexity-classifier";
import { DecisionStore } from "../core/decision-store";
import { EventLog } from "../core/event-log";
import { FeedbackTracker } from "../core/feedback-tracker";
import { LatencyTracker } from "../core/latency-tracker";
import { ProfileRegistry } from "../core/profile-registry";
import { JsonStateStore } from "../core/state-store";
import type { BudgetLimit, BudgetUsage, RatingEntry, RouterConfig } from "../core/types";
import { cooldownAfterFailureMs } from "./env";
import type { RouterRuntimeState } from "./router-runtime";

export interface PersistentRuntimeState extends RouterRuntimeState {
	config: RouterConfig;
	stateStore: JsonStateStore;
	configErrors: string[];
}

export function createPersistentRuntimeState(config: RouterConfig, stateDir: string, cwd: string, configErrors: string[] = []): PersistentRuntimeState {
	const stateStore = new JsonStateStore(stateDir);
	const budgets = new BudgetTracker(
		{ load: () => stateStore.readJson<BudgetUsage>("budget-usage.json"), save: (value) => stateStore.writeJson("budget-usage.json", value) },
		{ load: () => stateStore.readJson<Record<string, BudgetLimit>>("budget-limits.json"), save: (value) => stateStore.writeJson("budget-limits.json", value) },
	);
	for (const profile of Object.values(config.profiles)) {
		if (profile.budgets) budgets.mergeProfileLimits(profile.budgets);
	}
	const circuit = new CircuitBreaker();
	const latency = new LatencyTracker();
	const circuitSnapshot = stateStore.readJson<Record<string, { consecutiveFailures: number; openedAt: number; cooldownMs: number }>>("circuit.json");
	if (circuitSnapshot) circuit.restore(circuitSnapshot);
	const latencySnapshot = stateStore.readJson<Record<string, number>>("first-output-latency.json");
	if (latencySnapshot) latency.restore(latencySnapshot);
	return {
		config,
		stateStore,
		configErrors,
		registry: new ProfileRegistry(config, { cwd }),
		circuit,
		latency,
		budgets,
		decisions: new DecisionStore(),
		eventLog: new EventLog(stateDir),
		cooldowns: new Map(),
		ratings: new FeedbackTracker({
			load: () => stateStore.readJson<RatingEntry[]>("ratings.json"),
			save: (value) => stateStore.writeJson("ratings.json", value),
		}),
		classifierOverrides: sanitizeClassifierOverrides(stateStore.readJson("classifier-rules.json")),
		sessionUsage: { calls: new Map(), cost: new Map(), thinking: new Map() },
		uviEnabled: true,
		shadowEnabled: false,
		cooldownAfterFailureMs: cooldownAfterFailureMs(),
		quotaCache: { at: 0, data: [] },
		balanceCache: {},
	};
}

export function persistRuntimeTrackers(state: PersistentRuntimeState): void {
	state.stateStore.writeJson("circuit.json", state.circuit.snapshot());
	state.stateStore.writeJson("first-output-latency.json", state.latency.snapshot());
}
