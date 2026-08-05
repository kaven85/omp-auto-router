/**
 * EventLog — append-only JSONL log of RouterEvents.
 *
 * Best-effort by design: append never throws. IO failures are swallowed and
 * exposed via `lastError` so the host can surface them without breaking the
 * routing flow. Reads tolerate a truncated final line (interrupted write).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RouterEvent } from "./types";

/** Default rotation threshold: keep the log under ~2 MB. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** Check file size at most once per this many appended bytes. */
const ROTATE_CHECK_INTERVAL_BYTES = 8 * 1024;

/** Append-only JSONL event log rooted at a directory. */
export class EventLog {
	/** Root directory; created lazily on first append. */
	readonly dir: string;
	/** Log file name within `dir`. */
	readonly fileName: string;
	/** Most recent swallowed IO error from `append`, if any. */
	lastError: Error | undefined;
	/** Rotate once the file exceeds this many bytes; the newest half is kept. */
	private readonly maxBytes: number;
	private bytesSinceRotateCheck = 0;

	constructor(dir: string, fileName = "auto-router.events.jsonl", maxBytes = DEFAULT_MAX_BYTES) {
		this.dir = dir;
		this.fileName = fileName;
		this.maxBytes = maxBytes;
	}

	/** Absolute path of the log file. */
	get filePath(): string {
		return join(this.dir, this.fileName);
	}

	/**
	 * Append one event as a JSON line, creating the directory lazily.
	 * IO errors are swallowed into `lastError` — logging must never break
	 * routing. When the file grows past `maxBytes` it is truncated to its
	 * newest half (checked at most every ~64 appends, so the hot path stays
	 * a single append syscall).
	 */
	append(event: RouterEvent): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			const line = `${JSON.stringify(event)}\n`;
			appendFileSync(this.filePath, line, "utf8");
			this.bytesSinceRotateCheck += line.length;
			if (this.bytesSinceRotateCheck >= Math.min(ROTATE_CHECK_INTERVAL_BYTES, this.maxBytes / 4)) {
				this.bytesSinceRotateCheck = 0;
				this.rotateIfNeeded();
			}
		} catch (error) {
			this.lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	/** Truncate the log to its newest half when it exceeds `maxBytes`. Never throws. */
	private rotateIfNeeded(): void {
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			return;
		}
		if (raw.length <= this.maxBytes) return;
		// Keep the newest half, aligned to a line boundary.
		const tail = raw.slice(-Math.floor(this.maxBytes / 2));
		const firstNewline = tail.indexOf("\n");
		writeFileSync(this.filePath, firstNewline === -1 ? tail : tail.slice(firstNewline + 1), "utf8");
	}

	/**
	 * Read every event in recorded order. A missing file yields `[]`;
	 * unparseable lines (e.g. a truncated last line from an interrupted
	 * write) are skipped — never throws.
	 */
	readAll(): RouterEvent[] {
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			return [];
		}
		const events: RouterEvent[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			try {
				events.push(JSON.parse(line) as RouterEvent);
			} catch {
				// truncated or corrupt line — skip it, keep the rest
			}
		}
		return events;
	}

	/** Number of parseable events currently in the log. */
	size(): number {
		return this.readAll().length;
	}
}
