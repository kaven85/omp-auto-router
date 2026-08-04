/**
 * JsonStateStore — atomic JSON file persistence for router-core state.
 *
 * Host-agnostic: uses node:fs only (Bun-compatible). Writes are atomic
 * (write tmp file + rename) so a crash mid-write never leaves a torn file
 * behind; reads are total (missing or corrupt data yields `undefined`,
 * never throws).
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Names are bare file names within the store directory — a name containing a
 * path separator (or a dot-escape) is a programmer error, not an IO error.
 */
function assertBareName(name: string): void {
	if (
		name.length === 0 ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\")
	) {
		throw new Error(`JsonStateStore: invalid bare file name: ${JSON.stringify(name)}`);
	}
}

/** Directory-scoped JSON document store with atomic writes. */
export class JsonStateStore {
	/** Root directory; created lazily on first write. */
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/**
	 * Absolute path for a bare file name.
	 * @throws on names containing path separators or dot-escapes.
	 */
	path(name: string): string {
		assertBareName(name);
		return join(this.dir, name);
	}

	/**
	 * Read and parse a JSON document. Returns `undefined` when the file is
	 * missing or its contents are corrupt — never throws on IO/parse errors.
	 * @throws on invalid (non-bare) names.
	 */
	readJson<T = unknown>(name: string): T | undefined {
		const file = this.path(name);
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			return undefined;
		}
	}

	/**
	 * Atomically persist a JSON-able value: write to `<name>.tmp`, fsync
	 * (best-effort), then rename over `<name>`. Creates the store directory
	 * lazily. Real IO errors (permissions, disk full) propagate.
	 * @throws on invalid (non-bare) names.
	 */
	writeJson(name: string, value: unknown): void {
		const file = this.path(name);
		mkdirSync(this.dir, { recursive: true });
		const tmp = `${file}.tmp`;
		const text = JSON.stringify(value) ?? "null";
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, text, "utf8");
			try {
				fsyncSync(fd);
			} catch {
				// best-effort durability; a failed fsync must not lose the write
			}
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, file);
	}
}
