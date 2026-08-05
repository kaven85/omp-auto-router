#!/usr/bin/env bun
/**
 * Routing analytics over the auto-router event log (D6).
 *
 * Usage:
 *   bun scripts/routing-stats.ts [path-to-events.jsonl] [--tail N]
 *
 * Default path: ~/.omp/agent/auto-router/auto-router.events.jsonl
 * Aggregates decisions per profile/tier/target, failover counts, and the top
 * error reasons, from the append-only JSONL the adapter writes per decision.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface RouterEventShape {
	type?: string;
	at?: number;
	profile?: string;
	tier?: string;
	target?: { provider?: string; model?: string };
	from?: string;
	to?: string;
	what?: string;
	error?: string;
}

const args = process.argv.slice(2);
const tailIndex = args.indexOf("--tail");
const tail = tailIndex === -1 ? undefined : Number(args[tailIndex + 1]);
const filePath =
	args.find((arg, index) => !arg.startsWith("--") && (tailIndex === -1 || index !== tailIndex + 1)) ??
	join(homedir(), ".omp", "agent", "auto-router", "auto-router.events.jsonl");

let raw: string;
try {
	raw = readFileSync(filePath, "utf8");
} catch {
	console.error(`cannot read ${filePath}`);
	process.exit(1);
}

const events: RouterEventShape[] = [];
for (const line of raw.split("\n")) {
	if (line.trim() === "") continue;
	try {
		events.push(JSON.parse(line) as RouterEventShape);
	} catch {
		// truncated tail line — skip
	}
}
const window = tail !== undefined && Number.isFinite(tail) ? events.slice(-tail) : events;

function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, limit = 10): Array<[string, number]> {
	return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const decisions = new Map<string, number>();
const targets = new Map<string, number>();
const profiles = new Map<string, number>();
const failovers = new Map<string, number>();
const errors = new Map<string, number>();
let decisionCount = 0;

for (const event of window) {
	if (event.type === "decision") {
		decisionCount++;
		bump(profiles, event.profile ?? "unknown");
		bump(decisions, `${event.profile ?? "?"} / ${event.tier ?? "?"}`);
		if (event.target?.provider) {
			bump(targets, `${event.target.provider}/${event.target.model ?? "?"}`);
		}
	} else if (event.type === "failover") {
		bump(failovers, `${event.from ?? event.what ?? "?"} → ${event.to ?? "?"}`);
	} else if (event.type === "error") {
		bump(errors, `${event.what ?? "error"}: ${(event.error ?? "").slice(0, 80)}`);
	}
}

function render(title: string, map: Map<string, number>): void {
	console.log(`\n${title}`);
	const entries = top(map);
	if (entries.length === 0) {
		console.log("  (none)");
		return;
	}
	for (const [key, count] of entries) console.log(`  ${String(count).padStart(5)}  ${key}`);
}

console.log(`${filePath}`);
console.log(`${window.length} events analyzed${tail !== undefined ? ` (tail ${tail})` : ""}, ${decisionCount} decisions`);
render("decisions by profile / tier", decisions);
render("decisions by target", targets);
render("decisions by profile", profiles);
render("failovers", failovers);
render("top errors", errors);
