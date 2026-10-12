import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { clearAccounts, loadAccounts, saveAccounts, setStoragePathDirect } from "../lib/storage.js";
import { assertPendingAuthRefreshCapacity, getPendingAuthPath, recordPendingAuth } from "../lib/storage/pending-auth.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { withRetry } from "../lib/fs-retry.js";

let dir: string;
let path: string;
const children: ChildProcess[] = [];
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const pool = (tokens: string[]) => ({version: 3 as const, activeIndex: 0, accounts: tokens.map((refreshToken, i) => ({recordId: `record-${i}`, refreshToken, accessToken: `access-${refreshToken}`, expiresAt: 1, addedAt: i + 1, lastUsed: 1}))});
const rotation = (prior: string, next: string) => ({priorRefreshToken: prior, refreshToken: next, accessToken: `access-${next}`, expiresAt: 1, at: 1});
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "journal-capacity-"));
	path = join(dir, "accounts.json");
	setStoragePathDirect(path);
});
afterEach(async () => {
	vi.restoreAllMocks();
	setStoragePathDirect(null);
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	}
	await withRetry(() => fs.rm(dir, {recursive: true, force: true}), {maxAttempts: 6, backoffMs: 25});
});

it("recovers oldest primary, WAL and backup roots after 1002 failed-primary rotations", async () => {
	await saveAccounts(pool(["token-0"]));
	const manager = new AccountManager(undefined, await loadAccounts());
	vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => undefined);
	const rename = fs.rename.bind(fs);
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === path) throw Object.assign(Error("fixture locked primary"), {code: "EACCES"});
		return rename(from, to);
	});
	await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, {type: "oauth", access: "access-token-1", refresh: "token-1", expires: 1});
	await fs.writeFile(`${path}.wal`, JSON.stringify({version: 1, content: JSON.stringify(pool(["token-1"]))}));
	await fs.writeFile(`${path}.bak.2`, JSON.stringify(pool(["token-2"])));
	await fs.writeFile(`${path}.snapshot-old`, JSON.stringify(pool(["token-3"])));
	for (let i = 1; i < 1002; i++) await recordPendingAuth(path, {...rotation(`token-${i}`, `token-${i + 1}`), recordId: "record-0"});
	expect(JSON.parse(await fs.readFile(path, "utf8")).accounts[0].refreshToken).toBe("token-0");
	const entries = JSON.parse(await fs.readFile(getPendingAuthPath(path), "utf8")).entries;
	expect(entries).toHaveLength(1000);
	for (const token of ["token-0", "token-1", "token-2", "token-3"]) {
		expect(entries.find((entry: {prior: string}) => entry.prior === sha(token)).refreshToken).toBe("token-1002");
	}
	const fresh = new AccountManager(undefined, await loadAccounts());
	expect(fresh.getAccountByIndex(0)?.refreshToken).toBe("token-1002");
	const {applyPendingAuth} = await import("../lib/storage/pending-auth.js");
	for (const token of ["token-1", "token-2", "token-3"]) {
		expect((await applyPendingAuth(path, pool([token])))?.accounts[0]?.refreshToken).toBe("token-1002");
	}
}, 20000);

async function seedFull(required = false) {
	await fs.writeFile(path, JSON.stringify(pool(required ? Array.from({length: 1000}, (_, i) => `old-${i}`) : ["old-0"])));
	await fs.writeFile(getPendingAuthPath(path), JSON.stringify({version: 1, entries: Array.from({length: 1000}, (_, i) => ({prior: sha(`old-${i}`), ...rotation(`old-${i}`, `new-${i}`)}))}));
}

it.each(["missing-primary", "corrupt-primary", "corrupt-wal", "corrupt-backup", "unreadable", "discovery", "changing"])("preserves committed bytes and denies uncertain capacity (%s)", async mode => {
	await seedFull();
	if (mode === "missing-primary") await fs.unlink(path);
	if (mode === "corrupt-primary") await fs.writeFile(path, "{");
	if (mode === "corrupt-wal") await fs.writeFile(`${path}.wal`, "{");
	if (mode === "corrupt-backup") await fs.writeFile(`${path}.snapshot-old`, "{");
	if (mode === "unreadable") {
		const read = fs.readFile.bind(fs);
		vi.spyOn(fs, "readFile").mockImplementation((async (file, ...args) => {
			if (String(file) === path) throw Object.assign(Error("fixture denied"), {code: "EACCES"});
			return read(file, ...args);
		}) as typeof fs.readFile);
	}
	if (mode === "discovery") {
		const readdir = fs.readdir.bind(fs);
		let scans = 0;
		vi.spyOn(fs, "readdir").mockImplementation((async (target, ...args) => {
			if (String(target) === dir && ++scans % 2 === 0) throw Object.assign(Error("fixture denied"), {code: "EACCES"});
			return readdir(target, ...args);
		}) as typeof fs.readdir);
	}
	if (mode === "changing") {
		const read = fs.readFile.bind(fs);
		vi.spyOn(fs, "readFile").mockImplementation((async (file, ...args) => {
			const result = await read(file, ...args);
			if (String(file) === path) await fs.writeFile(path, JSON.stringify(pool(["replacement"])));
			return result;
		}) as typeof fs.readFile);
	}
	const before = await fs.readFile(getPendingAuthPath(path), "utf8");
	await expect(recordPendingAuth(path, rotation("spent", "fresh"))).rejects.toMatchObject({code: "EPENDINGAUTHCAPACITY"});
	await expect(assertPendingAuthRefreshCapacity(path, "spent")).rejects.toMatchObject({code: "EPENDINGAUTHCAPACITY"});
	expect(await fs.readFile(getPendingAuthPath(path), "utf8")).toBe(before);
});

it("denies upstream refresh at required-root capacity and retains an already-spent live credential with the first error", async () => {
	await seedFull(true);
	const before = await fs.readFile(getPendingAuthPath(path), "utf8");
	const auth = await import("../lib/auth/auth.js");
	const upstream = vi.spyOn(auth, "refreshAccessToken").mockResolvedValue({type: "success", access: "fixture", refresh: "fixture", expires: 1});
	const {queuedRefresh} = await import("../lib/refresh-queue.js");
	expect((await queuedRefresh("new-0")).type).toBe("failed");
	expect(upstream).not.toHaveBeenCalled();
	const manager = new AccountManager(undefined, await loadAccounts());
	vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => undefined);
	const rename = fs.rename.bind(fs);
	const firstError = Object.assign(Error("fixture primary failed"), {code: "EACCES"});
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === path) throw firstError;
		return rename(from, to);
	});
	await expect(manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, {type: "oauth", access: "access-newest", refresh: "newest", expires: 2})).rejects.toMatchObject({cause: {cause: firstError}});
	expect(manager.getAccountByIndex(0)?.refreshToken).toBe("newest");
	expect(await fs.readFile(getPendingAuthPath(path), "utf8")).toBe(before);
	expect((await queuedRefresh("newest")).type).toBe("failed");
	expect(upstream).not.toHaveBeenCalled();
});

it("holds the pool lock through contended journal reset before a new process saves and rotates", async () => {
	await saveAccounts(pool(["old"]));
	const workerPath = join(dir, "writer.mjs");
	buildSync({stdin: {contents: `
import { promises as fs, existsSync } from "node:fs";
import { saveAccounts, loadAccounts, setStoragePathDirect } from "./lib/storage.js";
import { AccountManager } from "./lib/accounts.js";
const path = process.argv[2];
setStoragePathDirect(path);
const rename = fs.rename.bind(fs);
let announced = false;
fs.rename = async (from, to) => {
  if (String(to) === path + ".write-lock" && !announced) {
    announced = true;
    process.send({event: "attempt", locked: existsSync(to)});
  }
  return rename(from, to);
};
await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "new", refreshToken: "new", addedAt: 1, lastUsed: 1}]});
const manager = new AccountManager(undefined, await loadAccounts());
manager.saveToDiskDebounced = () => undefined;
fs.rename = async (from, to) => {
  if (String(to) === path) throw Object.assign(Error("fixture failed primary"), {code: "EACCES"});
  return rename(from, to);
};
await manager.commitRefreshedAuth(manager.getAccountByIndex(0), {type: "oauth", access: "access-rotated", refresh: "rotated", expires: 1});
process.send({event: "recovered", token: (await loadAccounts()).accounts[0].refreshToken});
process.disconnect();
`, resolveDir: process.cwd()}, bundle: true, format: "esm", platform: "node", outfile: workerPath, logLevel: "silent"});
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>(resolve => {release = resolve;});
	const inside = new Promise<void>(resolve => {entered = resolve;});
	const journal = withFileTransactionLock(getPendingAuthPath(path), async () => {entered(); await gate;});
	await inside;
	let waiting!: () => void;
	const contended = new Promise<void>(resolve => {waiting = resolve;});
	const rename = fs.rename.bind(fs);
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === `${getPendingAuthPath(path)}.write-lock`) waiting();
		return rename(from, to);
	});
	const resetting = clearAccounts();
	await contended;
	const child = fork(workerPath, [path], {stdio: ["ignore", "pipe", "pipe", "ipc"]});
	children.push(child);
	const messages: Array<{event: string; locked?: boolean; token?: string}> = [];
	const received = (event: string) => new Promise<{event: string; locked?: boolean; token?: string}>((resolve, reject) => {
		child.on("message", message => {
			const row = message as {event: string; locked?: boolean; token?: string};
			messages.push(row);
			if (row.event === event) resolve(row);
		});
		child.on("exit", code => {if (code !== 0) reject(Error(`Fixture writer exited ${code}`));});
	});
	const attempted = received("attempt");
	const recovered = received("recovered");
	try {
		expect((await attempted).locked).toBe(true);
		expect(messages.some(message => message.event === "recovered")).toBe(false);
		await expect(fs.stat(getIntentionalResetMarkerPath(path))).resolves.toBeDefined();
	} finally {
		release();
		await journal;
		await resetting;
	}
	expect((await recovered).token).toBe("rotated");
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("rotated");
}, 20000);
