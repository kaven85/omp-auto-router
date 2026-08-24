/**
 * Adapter kit — the wiring every host adapter (omp, pi) needs identically.
 *
 * Host-neutral: operates on RouterRuntimeState plus caller-supplied host
 * callbacks; no omp/pi imports. Adapters keep only their ExtensionAPI
 * mapping; constants and flows that used to be copy-pasted between
 * src/omp-adapter and src/pi-adapter live here once.
 */

import { redactSecrets } from "../core/redact";
import type { ProfileConfig, RouteTarget, RoutingDecision } from "../core/types";
import { DEFAULT_ROLE, profileTargets, type ProfileRegistry } from "../core/profile-registry";
import { resolveBalanceEndpoint, type ProviderBalance } from "./provider-dictionary";
import { LEGACY_OMP_DECISION_ENTRY, ROUTER_DECISION_ENTRY, type RouterRuntimeState } from "./router-runtime";
import { renderRouterWidget } from "./widget";

// ─────────────────────────────────────────────────────────────────────────────
// Virtual provider registration
// ─────────────────────────────────────────────────────────────────────────────

/** The virtual provider id both hosts register (`auto-router/<profile>[/<role>]`). */
export const ROUTER_PROVIDER_ID = "auto-router";
/** Placeholder endpoint/key: the virtual provider never sends requests itself. */
export const VIRTUAL_BASE_URL = "http://127.0.0.1:0";
export const VIRTUAL_API_KEY = "AUTO_ROUTER_VIRTUAL_KEY";

/** Static metadata of one virtual model (cosmetic for /model display; routing resolves real models per request). */
export interface VirtualModelMeta {
	id: string;
	name: string;
	reasoning: true;
	input: ("text" | "image")[];
	cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
	contextWindow: number;
	maxTokens: number;
}

/**
 * One virtual model per profile (bare id = default role) plus one per
 * declared role (`<profile>/<role>`), so host role routing (omp modelRoles)
 * can point each role at a role-scoped chain inside the same profile.
 */
export function buildVirtualModels(profiles: Record<string, ProfileConfig>): VirtualModelMeta[] {
	return Object.entries(profiles).flatMap(([name, profile]) => [
		{ id: name, name: `Auto Router: ${name}`, ...VIRTUAL_MODEL_BASE },
		...Object.keys(profile.roles ?? {})
			.filter((role) => role !== DEFAULT_ROLE)
			.map((role) => ({ id: `${name}/${role}`, name: `Auto Router: ${name} (${role})`, ...VIRTUAL_MODEL_BASE })),
	]);
}

const VIRTUAL_MODEL_BASE = {
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} as const;

export { VIRTUAL_MODEL_BASE };

// ─────────────────────────────────────────────────────────────────────────────
// Session-branch decision restore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decision entries of a session branch, newest last. Both hosts expose
 * `sessionManager.getBranch()` with the same {type, customType, data} shape;
 * legacy OMP entries are read back too.
 */
export function decisionEntries(
	branch: Iterable<{ type: string; customType?: unknown; data?: unknown }>,
): RoutingDecision[] {
	const out: RoutingDecision[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== ROUTER_DECISION_ENTRY && entry.customType !== LEGACY_OMP_DECISION_ENTRY) continue;
		if (entry.data && typeof entry.data === "object") out.push(entry.data as RoutingDecision);
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test/build outcome detection (temporary tier escalation)
// ─────────────────────────────────────────────────────────────────────────────

/** Matches common test/build invocations in bash tool commands. */
export const TEST_COMMAND_RE =
	/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build)\b|\b(?:vitest|jest|pytest|go\s+test|cargo\s+test)\b|\btsc\b/;

/**
 * A failed test/build command temporarily raises the next request's tier
 * floor (see TEST_FAILURE_ESCALATION_MS in router-runtime) — debugging
 * benefits from a stronger model; a passing run clears the escalation.
 */
export function recordTestOutcome(state: RouterRuntimeState, command: string, failed: boolean): void {
	state.testFailureAt = failed ? Date.now() : undefined;
	state.eventLog.append({
		type: failed ? "error" : "decision",
		at: Date.now(),
		what: failed ? "test-failure" : "test-pass",
		command: redactSecrets(command.slice(0, 200)),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-stream visibility (balance refresh + widget render)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a stream settles: refresh the settled provider's prepaid balance
 * (adapter-authenticated fetch; the runtime never sees credentials) and
 * render the shared widget. Best-effort — failures never break the turn.
 */
export async function refreshSettledBalanceAndWidget(
	state: RouterRuntimeState,
	targets: RouteTarget[],
	fetchBalance: (provider: string, endpoint: string) => Promise<ProviderBalance | undefined>,
	setWidget: (lines: string[]) => void,
): Promise<void> {
	const decision = state.lastDecision?.decision;
	if (!decision) return;
	try {
		const endpoint = resolveBalanceEndpoint(decision.target.provider, targets);
		if (endpoint) {
			const balance = await fetchBalance(decision.target.provider, endpoint);
			if (balance) (state.balanceCache ??= {})[decision.target.provider] = balance;
		}
		renderRouterWidget(state, setWidget, decision);
	} catch {
		// headless/UI-less contexts tolerate absent widget surfaces
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────

/** Every target configured across every profile (all tiers plus role chains). */
export function configuredTargets(registry: ProfileRegistry): RouteTarget[] {
	return registry.list().flatMap((entry) => {
		const profile = registry.profile(entry.name);
		return profile ? profileTargets(profile) : [];
	});
}

/**
 * Adapter-generated terminal error event. Hosts clone terminal messages by
 * reading `message.usage.cost` unconditionally, so adapter errors must
 * satisfy the same AssistantMessage contract as provider-generated events.
 */
export function routerErrorEvent(model: { api: string; provider: string; id: string }, message: string) {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [{ type: "text", text: message }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
		},
	};
}
