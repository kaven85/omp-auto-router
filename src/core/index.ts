/** router-core public barrel. Host-agnostic — no omp imports anywhere under src/core. */

export * from "./types";
export type { HostModel, HostPorts } from "./host-ports";
export { loadRouterConfigFile, mergeRouterConfigs, parseRouterConfig } from "./config-loader";
export { ProfileRegistry } from "./profile-registry";
export { classifyContextSize, estimateTokens } from "./context-analyzer";
export { parseShortcut } from "./shortcut-parser";
export { classifyIntent } from "./intent-classifier";
export { classifyComplexity } from "./complexity-classifier";
export { PolicyEngine } from "./policy-engine";
export { solveConstraints } from "./constraint-solver";
export { CircuitBreaker } from "./circuit-breaker";
export { LatencyTracker } from "./latency-tracker";
export { partitionCandidates } from "./candidate-partitioner";
export { classifyMonthlySpendUvi, computeAllUvi, computeUvi } from "./uvi";
export { BudgetTracker } from "./budget-tracker";
export type { BudgetStore, LimitsStore } from "./budget-tracker";
export { auditBudget } from "./budget-auditor";
export { JsonStateStore } from "./state-store";
export { EventLog } from "./event-log";
export { DecisionStore } from "./decision-store";
export { FeedbackTracker } from "./feedback-tracker";
export type { RatingStore } from "./feedback-tracker";
export { defaultIsRetryable, defaultIsSubstantive, failoverStream } from "./failover-engine";
export { route } from "./pipeline";
export type { PipelineDeps, PipelineInput, PipelineResult } from "./pipeline";
