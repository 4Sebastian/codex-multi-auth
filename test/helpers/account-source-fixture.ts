import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { getStoragePath } from "../../lib/storage/file-paths.js";
import { isRecord } from "../../lib/utils.js";
import { removeWithRetry } from "./remove-with-retry.js";

/** Keep each unit case's physical authority separate from its injected I/O. */
export function useAccountSourceFixtures(): void {
	let directory: string;
	let previous: string | undefined;
	beforeEach(() => {
		previous = process.env.CODEX_MULTI_AUTH_DIR;
		directory = mkdtempSync(join(tmpdir(), "managed-source-fixture-"));
		process.env.CODEX_MULTI_AUTH_DIR = directory;
	});
	afterEach(async () => {
		if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
		else process.env.CODEX_MULTI_AUTH_DIR = previous;
		await removeWithRetry(directory, {recursive: true, force: true});
	});
}

export function writeAccountSourceFixture(storage: unknown, path = getStoragePath()): void {
	if (storage == null) return;
	const within = (root: string) => {
		const child = relative(root, path);
		return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
	};
	const root = process.env.CODEX_MULTI_AUTH_DIR;
	if ((!root || !within(root)) && !within(tmpdir())) throw Error("Account source fixture escaped its sandbox");
	// Older command fixtures omit non-authorizing required timestamps.
	const source = isRecord(storage) && Array.isArray(storage.accounts)
		? {...storage, accounts: storage.accounts.map(row => isRecord(row) ? {...row, addedAt: row.addedAt ?? 1, lastUsed: row.lastUsed ?? 1} : row)}
		: storage;
	const raw = JSON.stringify(source);
	if (raw === undefined) throw Error("Expected a JSON account source fixture");
	mkdirSync(dirname(path), {recursive: true});
	try {if (readFileSync(path, "utf8") === raw) return;}
	catch (error) {if (!(isRecord(error) && error.code === "ENOENT")) throw error;}
	writeFileSync(path, raw);
}

export function withAccountSourceFixture<T>(load: () => Promise<T>): () => Promise<T> {
	return async () => {
		const storage = await load();
		writeAccountSourceFixture(storage);
		return storage;
	};
}
