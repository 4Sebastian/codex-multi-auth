import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RefreshQueue, resetRefreshQueue } from "../lib/refresh-queue.js";
import { RefreshLeaseCoordinator } from "../lib/refresh-lease.js";
import { AccountManager } from "../lib/accounts.js";
import { ensureFreshAccessToken } from "../lib/runtime/rotation-token-refresh.js";
import { loadAccounts, loadFlaggedAccounts, getFlaggedAccountsPath, saveAccounts, setStoragePathDirect } from "../lib/storage.js";
import { applyPendingAuth, capturePendingAuth, getPendingAuthPath, prunePendingAuth } from "../lib/storage/pending-auth.js";
import { collectRestorableCredentials } from "../lib/storage/recovery-credentials.js";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import type { TokenResult } from "../lib/types.js";

let dir: string, path: string;
const children: ChildProcess[] = [];
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const pool = (tokens: string[]) => ({version: 3 as const, activeIndex: 0, accounts: tokens.map(refreshToken => ({recordId: refreshToken, refreshToken, accessToken: `access-${refreshToken}`, expiresAt: 1, addedAt: 1, lastUsed: 1}))});
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {resolve = done;});
	return {resolve, promise};
};
const queue = (enabled = false) => new RefreshQueue(30_000, new RefreshLeaseCoordinator({enabled, leaseDir: join(dir, "leases")}));
function injectRefresh(hold?: {token: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>}) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		expect(String(url)).toBe("https://auth.openai.com/oauth/token");
		expect(init?.method).toBe("POST");
		const token = new URLSearchParams(String(init?.body)).get("refresh_token")!;
		if (hold?.token === token) {hold.entered.resolve(); await hold.release.promise;}
		return Response.json({access_token: `access-${token}-next`, refresh_token: `${token}-next`, expires_in: 3600});
	});
}

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "journal-refresh-"));
	path = join(dir, "accounts.json");
	setStoragePathDirect(path);
});
afterEach(async () => {
	vi.restoreAllMocks();
	resetRefreshQueue();
	setStoragePathDirect(null);
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	}
	await removeWithRetry(dir, {recursive: true, force: true});
});

async function seedNearCapacity() {
	const roots = Array.from({length: 999}, (_, i) => `old-${i}`);
	await fs.writeFile(path, JSON.stringify(pool(["A", "B", ...roots.slice(0, 333)])));
	await fs.writeFile(`${path}.wal`, JSON.stringify({version: 1, content: JSON.stringify(pool(roots.slice(333, 666)))}));
	await fs.writeFile(`${path}.snapshot-wal`, JSON.stringify(pool(roots.slice(333, 666))));
	await fs.writeFile(`${path}.snapshot-old`, JSON.stringify(pool(roots.slice(666))));
	await fs.writeFile(getPendingAuthPath(path), JSON.stringify({version: 1, entries: roots.map(token => ({prior: sha(token), recordId: token, refreshToken: `${token}-next`, accessToken: `access-${token}-next`, expiresAt: 2, at: 1}))}));
	return roots;
}

type Message = {event: string; token?: string; result?: TokenResult; tokens?: string[]; enabled?: boolean; error?: string};
async function worker(token: string, options = "") {
	const workerPath = join(dir, "refresh-worker.mjs");
	if (!existsSync(workerPath)) buildSync({stdin: {contents: `
import { promises as fs, existsSync } from "node:fs";
import { RefreshQueue } from "./lib/refresh-queue.js";
import { RefreshLeaseCoordinator } from "./lib/refresh-lease.js";
import { AccountManager } from "./lib/accounts.js";
import { loadAccounts, setStoragePathDirect } from "./lib/storage.js";
const [path, token, option] = process.argv.slice(2);
setStoragePathDirect(path);
const send = message => process.send(message);
const wait = event => new Promise(resolve => process.on("message", message => {if (message === event) resolve();}));
if (token === "read") {
  send({event: "read", tokens: (await loadAccounts()).accounts.map(row => row.refreshToken)});
  process.disconnect();
} else {
  const manager = new AccountManager(undefined, await loadAccounts());
  manager.saveToDiskDebounced = () => undefined;
  const rename = fs.rename.bind(fs);
  let blocked = false;
  fs.rename = async (from, to) => {
    if (!blocked && [path + ".write-lock", path + ".pending-auth.json.write-lock"].includes(String(to)) && existsSync(to)) {blocked = true; send({event: "blocked"});}
    if (String(to) === path) throw Object.assign(Error("fixture primary failed"), {code: "EACCES"});
    return rename(from, to);
  };
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://auth.openai.com/oauth/token") throw Error("Unexpected fixture request");
    const spent = new URLSearchParams(String(init.body)).get("refresh_token");
    const gate = spent === "A" ? wait("release") : Promise.resolve();
    send({event: "spend", token: spent});
    await gate;
    return Response.json({access_token: "access-" + spent + "-next", refresh_token: spent + "-next", expires_in: 3600});
  };
  const queue = new RefreshQueue(30000, new RefreshLeaseCoordinator({enabled: false}));
  try {
    const result = await queue.refresh(token, path);
    const committed = option === "hold" ? wait("commit") : Promise.resolve();
    send({event: "settled", result});
    await committed;
    if (result.type === "success") {
      const account = manager.getAccountsSnapshot().find(row => row.refreshToken === token);
      await manager.commitRefreshedAuth(account, {type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires});
    }
    send({event: "done", tokens: (await loadAccounts()).accounts.map(row => row.refreshToken)});
  } catch (error) {send({event: "error", error: error.message});}
  process.disconnect();
}
`, resolveDir: process.cwd()}, bundle: true, format: "esm", platform: "node", outfile: workerPath, logLevel: "silent"});
	const child = fork(workerPath, [path, token, options], {stdio: ["ignore", "pipe", "pipe", "ipc"]});
	children.push(child);
	const messages: Message[] = [];
	child.on("message", message => {messages.push(message as Message);});
	const next = (events: string[]) => new Promise<Message>((resolve, reject) => {
		const known = messages.find(message => events.includes(message.event));
		if (known) {resolve(known); return;}
		const received = (message: unknown) => {
			const row = message as Message;
			if (row.event === "error") {cleanup(); reject(Error(row.error));}
			else if (events.includes(row.event)) {cleanup(); resolve(row);}
		};
		const exited = () => {cleanup(); reject(Error(`Fixture exited before ${events.join("/")}`));};
		const cleanup = () => {child.off("message", received); child.off("exit", exited);};
		child.on("message", received);
		child.on("exit", exited);
	});
	return {child, messages, next};
}

it("protects the final slot across distinct-process OAuth spend and failed managed primary commits", async () => {
	const roots = await seedNearCapacity();
	const a = await worker("A");
	await a.next(["spend"]);
	const b = await worker("B");
	const boundary = await b.next(["blocked", "spend"]);
	a.child.send("release");
	const [aResult, bResult] = await Promise.all([a.next(["settled"]), b.next(["settled"])]);
	await Promise.all([a.next(["done"]), b.next(["done"])]);
	expect(boundary.event).toBe("blocked");
	expect(aResult.result?.type).toBe("success");
	expect(bResult.result?.type).toBe("failed");
	expect([...a.messages, ...b.messages].filter(row => row.event === "spend").map(row => row.token)).toEqual(["A"]);
	const entries = (await capturePendingAuth(path, [])).entries;
	expect(entries).toHaveLength(1000);
	expect(entries.find(row => row.prior === sha("A"))).toMatchObject({recordId: "A", refreshToken: "A-next"});
	for (const token of roots) expect(entries.find(row => row.prior === sha(token))?.refreshToken).toBe(`${token}-next`);
	const fresh = await worker("read");
	expect((await fresh.next(["read"])).tokens).toContain("A-next");
	for (const tokens of [roots.slice(0, 333), roots.slice(333, 666), roots.slice(666)]) {
		expect((await applyPendingAuth(path, pool(tokens)))?.accounts.map(row => row.refreshToken)).toEqual(tokens.map(token => `${token}-next`));
	}
}, 20000);

it("keeps settled credentials after owner process loss and recovers its abandoned lock", async () => {
	await seedNearCapacity();
	const a = await worker("A", "hold");
	await a.next(["spend"]);
	a.child.send("release");
	expect((await a.next(["settled"])).result?.type).toBe("success");
	const exited = once(a.child, "exit");
	a.child.kill("SIGKILL");
	await exited;
	const b = await worker("B");
	expect((await b.next(["settled"])).result?.type).toBe("failed");
	expect(b.messages.some(row => row.event === "spend")).toBe(false);
	const fresh = await worker("read");
	expect((await fresh.next(["read"])).tokens).toContain("A-next");
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(1000);
}, 20000);

it("recovers a dead pre-settlement owner without retaining invented credentials", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A", "B"])));
	const a = await worker("A");
	await a.next(["spend"]);
	const exited = once(a.child, "exit");
	a.child.kill("SIGKILL");
	await exited;
	const b = await worker("B");
	expect((await b.next(["settled"])).result?.type).toBe("success");
	await b.next(["done"]);
	const entries = (await capturePendingAuth(path, [])).entries;
	expect(entries.some(row => row.prior === sha("A"))).toBe(false);
	expect(entries.find(row => row.prior === sha("B"))?.refreshToken).toBe("B-next");
}, 20000);

it("settles before publishing same-token lease followers and preserves rotation aliases", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const entered = deferred(), release = deferred();
	const fetch = injectRefresh({token: "A", entered, release});
	const journalEntered = deferred(), journalRelease = deferred();
	const rename = fs.rename.bind(fs);
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === getPendingAuthPath(path)) {journalEntered.resolve(); await journalRelease.promise;}
		return rename(from, to);
	});
	const first = queue(true).refresh("A", path);
	await entered.promise;
	let followerFinished = false;
	const second = queue(true).refresh("A", path).then(result => {followerFinished = true; return result;});
	release.resolve();
	await journalEntered.promise;
	expect(followerFinished).toBe(false);
	expect((await fs.readdir(join(dir, "leases"))).filter(file => file.endsWith(".result.json"))).toEqual([]);
	journalRelease.resolve();
	const [a, b] = await Promise.all([first, second]);
	expect(a.type).toBe("success");
	expect(b).toMatchObject({type: "success", access: "access-A-next", refresh: "A-next"});
	expect(fetch).toHaveBeenCalledTimes(1);
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("A-next");
	const next = await queue().refresh("A-next", path);
	expect(next).toMatchObject({type: "success", refresh: "A-next-next"});
	expect((await applyPendingAuth(path, pool(["A", "A-next"])))?.accounts.map(row => row.refreshToken)).toEqual(["A-next-next", "A-next-next"]);
});

it("settles a rotation after a same-refresh-token renewal without borrowing its retired credential", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const fetch = vi.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(Response.json({access_token: "renewed-A", refresh_token: "A", expires_in: 3600}))
		.mockResolvedValueOnce(Response.json({access_token: "rotated-A", refresh_token: "A-next", expires_in: 7200}));
	expect(await queue().refresh("A", path)).toMatchObject({type: "success", access: "renewed-A", refresh: "A"});
	expect(await queue().refresh("A", path)).toMatchObject({type: "success", access: "rotated-A", refresh: "A-next"});
	expect((await loadAccounts())?.accounts[0]).toMatchObject({accessToken: "rotated-A", refreshToken: "A-next"});
	expect(fetch).toHaveBeenCalledTimes(2);
});

it("commits managed rescue to its captured pool after the default storage path changes", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const manager = new AccountManager(undefined, (await loadAccounts())!);
	vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => undefined);
	injectRefresh();
	const result = await queue().refresh("A", path);
	if (result.type !== "success") throw Error("Fixture refresh failed");
	const other = join(dir, "other.json");
	const otherContent = JSON.stringify(pool(["B"]));
	await fs.writeFile(other, otherContent);
	setStoragePathDirect(other);
	const rename = fs.rename.bind(fs);
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === path) throw Object.assign(Error("fixture primary denied"), {code: "EACCES"});
		return rename(from, to);
	});
	await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, {type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires});
	expect((await capturePendingAuth(path, [])).entries[0]).toMatchObject({recordId: "A", refreshToken: "A-next"});
	expect(await fs.readFile(other, "utf8")).toBe(otherContent);
});

it("does not join identical tokens from different storage paths", async () => {
	const other = join(dir, "other.json");
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	await fs.writeFile(other, JSON.stringify(pool(["A"])));
	const entered = deferred(), release = deferred();
	const fetch = injectRefresh({token: "A", entered, release});
	const shared = queue(true);
	const first = shared.refresh("A", path);
	await entered.promise;
	const second = shared.refresh("A", other);
	release.resolve();
	await Promise.all([first, second]);
	expect(fetch).toHaveBeenCalledTimes(2);
	for (const target of [path, other]) expect((await capturePendingAuth(target, [])).entries[0]).toMatchObject({recordId: "A", refreshToken: "A-next"});
});

it.each(["reset", "delete", "disable", "expiry"])("fails closed on uncoordinated primary authority change during spend (%s)", async mutation => {
	const original = pool(["A"]);
	await fs.writeFile(path, JSON.stringify(original));
	const entered = deferred(), release = deferred();
	injectRefresh({token: "A", entered, release});
	const pending = queue().refresh("A", path);
	const observed = pending.catch(error => error);
	await entered.promise;
	if (mutation === "reset") await fs.writeFile(getIntentionalResetMarkerPath(path), "fixture-reset");
	else if (mutation === "delete") await fs.unlink(path);
	else {
		const changed = pool(["A"]);
		if (mutation === "disable") Object.assign(changed.accounts[0]!, {enabled: false});
		else changed.accounts[0]!.expiresAt = 2;
		await fs.writeFile(path, JSON.stringify(changed));
	}
	release.resolve();
	expect(await observed).toMatchObject({code: "EPENDINGAUTHSETTLEMENT", result: {type: "success", refresh: "A-next"}, cause: {code: "ESTALE"}});
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(0);
});

it("rejects a queued cross-process refresh after reset authority changes while acquiring the pool lock", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A", "B"])));
	let pending!: Promise<Message>;
	let contender!: Awaited<ReturnType<typeof worker>>;
	await withFileTransactionLock(path, async () => {
		contender = await worker("B");
		await contender.next(["blocked"]);
		pending = contender.next(["settled"]);
		await fs.writeFile(getIntentionalResetMarkerPath(path), "fixture-reset");
	});
	expect((await pending).result?.type).toBe("failed");
	expect(contender.messages.some(row => row.event === "spend")).toBe(false);
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(0);
}, 20000);

it("releases admission after a refresh timeout without publishing credentials", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {once: true});
	}));
	const timed = new RefreshQueue(1000, new RefreshLeaseCoordinator({enabled: false}));
	expect(await timed.refresh("A", path)).toMatchObject({type: "failed", reason: "unknown"});
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(0);
	expect((await fs.readdir(dir)).some(file => file.endsWith(".write-lock"))).toBe(false);
});

it("retains live rotated material without healing and propagates the first settlement error", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const manager = new AccountManager(undefined, (await loadAccounts())!);
	const account = manager.getAccountByIndex(0)!;
	manager.markAccountCoolingDown(account, 60_000, "network-error");
	const cooldown = account.coolingDownUntil;
	injectRefresh();
	const rename = fs.rename.bind(fs);
	const firstError = Object.assign(Error("fixture journal denied"), {code: "EACCES"});
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === getPendingAuthPath(path)) throw firstError;
		return rename(from, to);
	});
	await expect(ensureFreshAccessToken({accountManager: manager, account, family: "codex", model: "gpt-5", now: Date.now(), tokenRefreshSkewMs: 0, tokenInvalidationCooldownMs: 60_000})).rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT", cause: firstError});
	expect(account).toMatchObject({access: "access-A-next", refreshToken: "A-next", coolingDownUntil: cooldown, cooldownReason: "network-error"});
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(0);
	expect(await fs.readdir(dir)).not.toContain("accounts.json.write-lock");
	expect(await fs.readdir(join(dir, "leases")).catch(() => [])).not.toEqual(expect.arrayContaining([expect.stringMatching(/result\.json$/)]));
});

it("propagates the original managed primary error when journal rescue also fails", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const manager = new AccountManager(undefined, (await loadAccounts())!);
	vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => undefined);
	const rename = fs.rename.bind(fs);
	const firstError = Object.assign(Error("fixture primary denied"), {code: "EACCES"});
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === path) throw firstError;
		if (String(to) === getPendingAuthPath(path)) throw Object.assign(Error("fixture journal denied"), {code: "EACCES"});
		return rename(from, to);
	});
	await expect(manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, {type: "oauth", access: "access-A-next", refresh: "A-next", expires: 2})).rejects.toMatchObject({cause: {cause: firstError}});
	expect(manager.getAccountByIndex(0)?.refreshToken).toBe("A-next");
});

it("can refresh another account after primary persistence makes a slot safely removable", async () => {
	const roots = Array.from({length: 999}, (_, i) => `old-${i}`);
	await fs.writeFile(path, JSON.stringify(pool(["A", "B", ...roots])));
	await fs.writeFile(`${path}.snapshot-old`, JSON.stringify(pool(roots)));
	await fs.writeFile(getPendingAuthPath(path), JSON.stringify({version: 1, entries: roots.map(token => ({prior: sha(token), refreshToken: `${token}-next`, accessToken: `access-${token}-next`, expiresAt: 2, at: 1}))}));
	const fetch = injectRefresh();
	await queue().refresh("A", path);
	const saved = (await loadAccounts())!;
	await saveAccounts(saved);
	await fs.unlink(`${path}.bak`);
	await prunePendingAuth(path, saved, () => collectRestorableCredentials(path));
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(999);
	expect(await queue().refresh("B", path)).toMatchObject({type: "success", refresh: "B-next"});
	expect(fetch).toHaveBeenCalledTimes(2);
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(1000);
});

it("recovers flagged rotations through the shared journal and retains their required roots", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const flaggedPath = getFlaggedAccountsPath();
	const flagged = {version: 1, accounts: pool(["flagged"]).accounts.map(row => ({...row, enabled: false, flaggedAt: 1}))};
	await fs.writeFile(flaggedPath, JSON.stringify(flagged));
	const fetch = injectRefresh();
	expect(await queue().refresh("flagged", path)).toMatchObject({type: "success", refresh: "flagged-next"});
	expect((await loadFlaggedAccounts()).accounts[0]).toMatchObject({refreshToken: "flagged-next", enabled: false, flaggedAt: 1});
	const saved = (await loadAccounts())!;
	await saveAccounts(saved);
	expect((await capturePendingAuth(path, [])).entries.find(row => row.prior === sha("flagged"))?.refreshToken).toBe("flagged-next");
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("never publishes a lease success when journal settlement fails", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	injectRefresh();
	const rename = fs.rename.bind(fs);
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === getPendingAuthPath(path)) throw Object.assign(Error("fixture journal denied"), {code: "EACCES"});
		return rename(from, to);
	});
	await expect(queue(true).refresh("A", path)).rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT", result: {refresh: "A-next"}});
	expect((await fs.readdir(join(dir, "leases"))).filter(file => file.endsWith(".result.json"))).toEqual([]);
});

it("retains committed roots when lock release is deferred", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	injectRefresh();
	const unlink = fs.unlink.bind(fs);
	vi.spyOn(fs, "unlink").mockImplementation(async file => {
		if (String(file).includes(".write-lock/")) throw Object.assign(Error("fixture release denied"), {code: "EACCES"});
		return unlink(file);
	});
	expect(await queue().refresh("A", path)).toMatchObject({type: "success", refresh: "A-next"});
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("A-next");
	expect((await capturePendingAuth(path, [])).entries[0]?.refreshToken).toBe("A-next");
});

it.each(["corrupt-journal", "corrupt-primary", "locked"])("denies admission before OAuth spend (%s)", async failure => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	if (failure === "corrupt-journal") await fs.writeFile(getPendingAuthPath(path), "{");
	if (failure === "corrupt-primary") await fs.writeFile(path, "{");
	const fetch = injectRefresh();
	if (failure === "locked") {
		await withFileTransactionLock(path, async () => {
			const waiting = await worker("B");
			await waiting.next(["blocked"]);
			expect((await waiting.next(["settled"])).result?.type).toBe("failed");
			expect(waiting.messages.some(row => row.event === "spend")).toBe(false);
		});
	} else expect((await queue().refresh("A", path)).type).toBe("failed");
	expect(fetch).not.toHaveBeenCalled();
}, 20000);
