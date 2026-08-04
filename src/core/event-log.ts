/**
 * EventLog — append-only JSONL log of RouterEvents.
 *
 * Best-effort by design: append never throws. IO failures are swallowed and
 * exposed via `lastError` so the host can surface them without breaking the
 * routing flow. Reads tolerate a truncated final line (interrupted write).
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RouterEvent } from "./types";

/** Append-only JSONL event log rooted at a directory. */
export class EventLog {
	/** Root directory; created lazily on first append. */
	readonly dir: string;
	/** Log file name within `dir`. */
	readonly fileName: string;
	/** Most recent swallowed IO error from `append`, if any. */
	lastError: Error | undefined;

	constructor(dir: string, fileName = "auto-router.events.jsonl") {
		this.dir = dir;
		this.fileName = fileName;
	}

	/** Absolute path of the log file. */
	get filePath(): string {
		return join(this.dir, this.fileName);
	}

	/**
	 * Append one event as a JSON line, creating the directory lazily.
	 * IO errors are swallowed into `lastError` — logging must never break
	 * routing.
	 */
	append(event: RouterEvent): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
		} catch (error) {
			this.lastError = error instanceof Error ? error : new Error(String(error));
		}
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
