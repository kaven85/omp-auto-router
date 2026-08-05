import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLog } from "../src/core/event-log";
import type { RouterEvent } from "../src/core/types";

describe("EventLog", () => {
	let dir: string;
	let log: EventLog;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "auto-router-events-"));
		log = new EventLog(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("readAll on a fresh log yields []", () => {
		expect(log.readAll()).toEqual([]);
		expect(log.size()).toBe(0);
	});

	test("append + readAll round-trips events in recorded order", () => {
		const first: RouterEvent = { type: "decision", at: 1000, profile: "default" };
		const second: RouterEvent = { type: "failover", at: 2000, from: "a", to: "b" };
		log.append(first);
		log.append(second);
		expect(log.readAll()).toEqual([first, second]);
		expect(log.size()).toBe(2);
	});

	test("append creates the directory lazily", () => {
		const lazy = new EventLog(join(dir, "not", "there", "yet"));
		lazy.append({ type: "settled", at: 1 });
		expect(lazy.readAll()).toEqual([{ type: "settled", at: 1 }]);
	});

	test("a truncated last line is tolerated", () => {
		log.append({ type: "decision", at: 1 });
		log.append({ type: "settled", at: 2 });
		appendFileSync(log.filePath, '{"type":"error","at":3', "utf8");
		expect(log.readAll()).toEqual([
			{ type: "decision", at: 1 },
			{ type: "settled", at: 2 },
		]);
		expect(log.size()).toBe(2);
	});

	test("blank lines are ignored", () => {
		log.append({ type: "uvi", at: 1 });
		appendFileSync(log.filePath, "\n\n", "utf8");
		expect(log.readAll()).toEqual([{ type: "uvi", at: 1 }]);
	});

	test("custom fileName is honored", () => {
		const custom = new EventLog(dir, "custom.jsonl");
		custom.append({ type: "rating", at: 7 });
		expect(custom.filePath).toBe(join(dir, "custom.jsonl"));
		expect(custom.readAll()).toEqual([{ type: "rating", at: 7 }]);
		// default-named log in the same dir sees nothing
		expect(log.readAll()).toEqual([]);
	});

	test("append swallows IO errors into lastError instead of throwing", () => {
		const blocker = join(dir, "blocked");
		writeFileSync(blocker, "i am a file, not a directory", "utf8");
		const broken = new EventLog(blocker);
		expect(() => broken.append({ type: "error", at: 1 })).not.toThrow();
		expect(broken.lastError).toBeInstanceOf(Error);
		// reads stay total too
		expect(broken.readAll()).toEqual([]);
	});

	test("lastError stays undefined on the happy path", () => {
		log.append({ type: "decision", at: 1 });
		expect(log.lastError).toBeUndefined();
	});

	test("rotates to the newest half once past maxBytes", () => {
		const tiny = new EventLog(dir, "rotating.jsonl", 200);
		for (let i = 0; i < 100; i++) {
			tiny.append({ type: "decision", at: i, profile: "p".repeat(20) });
		}
		const kept = tiny.readAll();
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(100);
		// kept events are the newest ones, still in order
		expect(kept.at(-1)).toEqual({ type: "decision", at: 99, profile: "p".repeat(20) });
		// file stays within roughly the rotation bound
		expect(tiny.lastError).toBeUndefined();
	});
});
