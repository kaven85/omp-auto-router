/**
 * modelRoles consistency probe for `/auto-router doctor`.
 *
 * omp routes host roles (default/task/smol/slow) by the `modelRoles` map in
 * its own config.yml — outside the extension API, so the probe reads the
 * files directly: user layer `<agentDir>/config.yml`, project layer
 * `<cwd>/.omp/config.yml` (project wins per role key, mirroring omp's
 * layering). Only entries pointing at `auto-router/*` are checked; roles
 * pointed elsewhere are the user's business.
 *
 * Detects the three ways role routing silently degrades:
 *   - dangling profile   — `auto-router/premiun` (typo) resolves nowhere
 *   - undeclared role    — `auto-router/premium/taskk` falls back to the
 *                          default chain (pipeline: "role=X undeclared")
 *   - unregistered model — the virtual model never made it into the host
 *                          registry (registerProvider failed; see H1)
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { DEFAULT_ROLE, type ProfileRegistry } from "../core/profile-registry";
import { ROUTER_PROVIDER_ID } from "../runtime/adapter-kit";

export interface ModelRolesProbeInput {
	registry: ProfileRegistry;
	agentDir: string;
	cwd: string;
	/** Whether a virtual model id (e.g. `premium/task`) is registered in the host. */
	isRegistered: (virtualId: string) => boolean;
}

/** omp config.yml `modelRoles` values: "provider/model" or {provider, model}. */
function normalizeTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null) {
		const record = value as { provider?: unknown; model?: unknown; id?: unknown };
		if (typeof record.provider === "string" && typeof record.model === "string") return `${record.provider}/${record.model}`;
		if (typeof record.provider === "string" && typeof record.id === "string") return `${record.provider}/${record.id}`;
	}
	return undefined;
}

/** modelRoles of one config.yml layer; undefined when absent/unreadable. */
function readModelRolesLayer(file: string): { roles: Record<string, string>; parseError?: string } | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined; // missing layer is normal
	}
	try {
		const doc = parseYaml(raw) as { modelRoles?: unknown } | null;
		if (typeof doc?.modelRoles !== "object" || doc.modelRoles === null) return { roles: {} };
		const roles: Record<string, string> = {};
		for (const [role, value] of Object.entries(doc.modelRoles)) {
			const target = normalizeTarget(value);
			if (target !== undefined) roles[role] = target;
		}
		return { roles };
	} catch (error) {
		return { roles: {}, parseError: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Doctor lines for the modelRoles↔profile consistency check. One ✅ summary
 * when every routed role is consistent, otherwise one line per problem plus
 * the summary of what does route.
 */
export function probeModelRoles(input: ModelRolesProbeInput): string[] {
	const userLayer = readModelRolesLayer(path.join(input.agentDir, "config.yml"));
	const projectLayer = readModelRolesLayer(path.join(input.cwd, ".omp", "config.yml"));
	const problems: string[] = [];
	for (const [label, layer] of [["user", userLayer], ["project", projectLayer]] as const) {
		if (layer?.parseError) problems.push(`⚠️ modelRoles — ${label} config.yml unparseable: ${layer.parseError}`);
	}

	// Project layer overrides user per role key.
	const merged: Record<string, string> = { ...(userLayer?.roles ?? {}), ...(projectLayer?.roles ?? {}) };
	const routed = Object.entries(merged).filter(([, target]) => target.startsWith(`${ROUTER_PROVIDER_ID}/`));
	if (routed.length === 0) {
		return [
			...problems,
			"⚠️ modelRoles — no host role routed through auto-router/* (manual /model only); set modelRoles in config.yml to enable role routing",
		];
	}

	const ok: string[] = [];
	for (const [hostRole, target] of routed) {
		const virtualId = target.slice(ROUTER_PROVIDER_ID.length + 1);
		const { profile, role } = input.registry.parseVirtualModelId(virtualId);
		const profileCfg = input.registry.profile(profile);
		const ref = `modelRoles.${hostRole} → ${target}`;
		if (profileCfg === undefined) {
			problems.push(`❌ ${ref}: unknown profile "${profile}" — typo? available: ${input.registry.list().map((p) => p.name).join(", ")}`);
			continue;
		}
		if (role !== DEFAULT_ROLE && profileCfg.roles?.[role] === undefined) {
			problems.push(`⚠️ ${ref}: role "${role}" not declared in profile "${profile}" — routes as the default chain`);
			continue;
		}
		if (!input.isRegistered(virtualId)) {
			problems.push(`❌ ${ref}: virtual model not in the host registry — registration failed? see H1`);
			continue;
		}
		ok.push(`${hostRole}→${virtualId}`);
	}
	return [
		...problems,
		ok.length > 0
			? `✅ modelRoles — routed: ${ok.join(", ")}`
			: "❌ modelRoles — every auto-router/* entry is broken; see above",
	];
}
