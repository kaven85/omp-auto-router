import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { RouterConfig } from "../../src/core/types";
import { createPersistentRuntimeState, persistRuntimeTrackers } from "../../src/runtime/state";

const CONFIG: RouterConfig = {
	active: "default",
	profiles: {
		default: {
			defaultTier: "standard",
			tiers: { standard: { targets: [{ provider: "p", model: "m" }] } },
		},
	},
};

const dirs: string[] = [];
function tempStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "auto-router-state-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("persistRuntimeTrackers multi-process merge", () => {
	test("adopts a newer failure written by another process instead of clobbering it", () => {
		const dir = tempStateDir();
		const state = createPersistentRuntimeState(CONFIG, dir, "/tmp");
		state.circuit.recordFailure("local/m", 1_000);

		// Another session writes its own failure after ours.
		const other = createPersistentRuntimeState(CONFIG, dir, "/tmp");
		other.circuit.recordFailure("remote/m", 2_000);
		other.circuit.recordFailure("remote/m", 2_001);
		other.circuit.recordFailure("remote/m", 2_002);
		persistRuntimeTrackers(other);

		persistRuntimeTrackers(state);
		const onDisk = state.stateStore.readJson<Record<string, { consecutiveFailures: number }>>("circuit.json");
		expect(onDisk?.["remote/m"]?.consecutiveFailures).toBe(3);
		expect(onDisk?.["local/m"]?.consecutiveFailures).toBe(1);
		// Memory adopted the remote failure too — routing in this process respects it.
		expect(state.circuit.state("remote/m", 2_002)).toBe("open");
	});

	test("a local success tombstone beats an older failure another process wrote earlier", () => {
		const dir = tempStateDir();
		const base = Date.now();
		// The other process wrote its failure first.
		const other = createPersistentRuntimeState(CONFIG, dir, "/tmp");
		other.circuit.recordFailure("p/m", base);
		other.circuit.recordFailure("p/m", base + 1);
		other.circuit.recordFailure("p/m", base + 2);
		persistRuntimeTrackers(other);

		// This process restored that failure at boot, then its half-open trial succeeded.
		const state = createPersistentRuntimeState(CONFIG, dir, "/tmp");
		state.circuit.recordSuccess("p/m", base + 62_000);
		persistRuntimeTrackers(state);

		const onDisk = state.stateStore.readJson<Record<string, { consecutiveFailures: number }>>("circuit.json");
		expect(onDisk?.["p/m"]?.consecutiveFailures).toBe(0);
		expect(state.circuit.state("p/m", base + 62_000)).toBe("closed");
	});
});
