import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonStateStore } from "../src/core/state-store";

describe("JsonStateStore", () => {
	let dir: string;
	let store: JsonStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "auto-router-state-"));
		store = new JsonStateStore(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("readJson returns undefined for a missing file", () => {
		expect(store.readJson("missing.json")).toBeUndefined();
	});

	test("writeJson + readJson round-trips a value", () => {
		const value = { provider: "anthropic", tiers: ["simple", "complex"], n: 42 };
		store.writeJson("state.json", value);
		const roundTripped = store.readJson("state.json");
		expect(roundTripped).toEqual(value);
	});

	test("writeJson overwrites an existing document", () => {
		store.writeJson("state.json", { v: 1 });
		store.writeJson("state.json", { v: 2 });
		const afterOverwrite = store.readJson("state.json");
		expect(afterOverwrite).toEqual({ v: 2 });
	});

	test("writeJson creates a nested store directory lazily", () => {
		const nested = new JsonStateStore(join(dir, "deep", "deeper"));
		nested.writeJson("state.json", { ok: true });
		const nestedRead = nested.readJson("state.json");
		expect(nestedRead).toEqual({ ok: true });
	});

	test("atomic write leaves no .tmp file behind", () => {
		store.writeJson("state.json", { ok: true });
		store.writeJson("state.json", { ok: false });
		expect(readdirSync(dir).sort()).toEqual(["state.json"]);
	});

	test("corrupt JSON reads back as undefined and recovers on next write", () => {
		writeFileSync(store.path("bad.json"), "{ not json", "utf8");
		expect(store.readJson("bad.json")).toBeUndefined();
		store.writeJson("bad.json", { recovered: true });
		const recovered = store.readJson("bad.json");
		expect(recovered).toEqual({ recovered: true });
	});

	test("path resolves bare names inside the store directory", () => {
		expect(store.path("a.json")).toBe(join(dir, "a.json"));
	});

	test("non-bare names are rejected as programmer errors", () => {
		for (const bad of ["", ".", "..", "a/b.json", "../evil.json", "a\\b.json"]) {
			expect(() => store.path(bad)).toThrow(/invalid bare file name/);
			expect(() => store.readJson(bad)).toThrow(/invalid bare file name/);
			expect(() => store.writeJson(bad, {})).toThrow(/invalid bare file name/);
		}
	});
});
