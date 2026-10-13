import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runRuntimeAccountCheck } from "../lib/runtime/account-check.js";
import { hydrateRuntimeEmails } from "../lib/runtime/hydrate-emails.js";
import { verifyRuntimeFlaggedAccounts } from "../lib/runtime/verify-flagged.js";
import { runHealthCheck } from "../lib/codex-manager/health-check.js";
import { runFix, type RepairCommandDeps } from "../lib/codex-manager/repair-commands.js";
import { autoSyncActiveAccountToCodex } from "../lib/codex-manager/active-account-sync.js";
import { proactiveRefreshAccount } from "../lib/proactive-refresh.js";
import { RefreshGuardian } from "../lib/refresh-guardian.js";
import { refreshAndUpdateToken } from "../lib/request/token-refresh.js";
import { persistAndSyncSelectedAccount } from "../lib/codex-manager/persist-selected-account.js";
import { queuedRefresh, RefreshQueue, resetRefreshQueue } from "../lib/refresh-queue.js";
import { RefreshLeaseCoordinator } from "../lib/refresh-lease.js";
import { AccountManager } from "../lib/accounts.js";
import { ensureFreshAccessToken } from "../lib/runtime/rotation-token-refresh.js";
import { loadAccounts, loadFlaggedAccounts, getFlaggedAccountsPath, getStoragePath, saveAccounts, setStoragePathDirect } from "../lib/storage.js";
import { PendingAuthLocalError, PendingAuthSettlementError, applyPendingAuth, capturePendingAuth, getPendingAuthPath, prunePendingAuth } from "../lib/storage/pending-auth.js";
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
	vi.unstubAllEnvs();
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

type Message = {event: string; token?: string; result?: TokenResult; tokens?: string[]; enabled?: boolean; error?: string; code?: string};
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
  } catch (error) {send({event: "error", error: error.message, code: error.code});}
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
			if (events.includes(row.event)) {cleanup(); resolve(row);}
			else if (row.event === "error") {cleanup(); reject(Error(row.error));}
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
	const [aResult, bResult] = await Promise.all([a.next(["settled"]), b.next(["error"])]);
	await a.next(["done"]);
	expect(boundary.event).toBe("blocked");
	expect(aResult.result?.type).toBe("success");
	expect(bResult).toMatchObject({event: "error", code: "EPENDINGAUTHCAPACITY"});
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
	expect(await b.next(["error"])).toMatchObject({event: "error", code: "EPENDINGAUTHCAPACITY"});
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
		pending = contender.next(["error"]);
		await fs.writeFile(getIntentionalResetMarkerPath(path), "fixture-reset");
	});
	expect(await pending).toMatchObject({event: "error", code: "EPENDINGAUTHADMISSION"});
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
			await expect(waiting.next(["settled"])).rejects.toThrow("admission");
			expect(waiting.messages.some(row => row.event === "spend")).toBe(false);
		});
	} else await expect(queue().refresh("A", path)).rejects.toBeInstanceOf(PendingAuthLocalError);
	expect(fetch).not.toHaveBeenCalled();
}, 20000);

function denyJournalSettlement() {
	const rename = fs.rename.bind(fs);
	const cause = Object.assign(Error("fixture journal full"), {code: "ENOSPC"});
	const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === getPendingAuthPath(path)) throw cause;
		return rename(from, to);
	});
	return {cause, spy};
}

it.each([".bak.1", ".bak.2"])("retains older flagged recovery roots through saves and capacity admission (%s)", async suffix => {
	const roots = ["flagged", ...Array.from({length: 998}, (_, index) => `root-${index}`)];
	await fs.writeFile(path, JSON.stringify(pool(["A", "B"])));
	await fs.writeFile(`${path}.snapshot-old`, JSON.stringify(pool(roots.slice(1))));
	await fs.writeFile(`${getFlaggedAccountsPath()}${suffix}`, JSON.stringify({version: 1, accounts: pool(["flagged"]).accounts.map(row => ({...row, flaggedAt: 1}))}));
	await fs.writeFile(getPendingAuthPath(path), JSON.stringify({version: 1, entries: roots.map(token => ({prior: sha(token), recordId: token, refreshToken: `${token}-next`, accessToken: `access-${token}-next`, expiresAt: 2, at: 1}))}));
	await saveAccounts((await loadAccounts())!);
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(999);
	const fetch = injectRefresh();
	expect(await queue().refresh("A", path)).toMatchObject({type: "success", refresh: "A-next"});
	await expect(queue().refresh("B", path)).rejects.toMatchObject({code: "EPENDINGAUTHCAPACITY"});
	expect(fetch).toHaveBeenCalledTimes(1);
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(1000);
	expect((await loadFlaggedAccounts()).accounts[0]?.refreshToken).toBe("flagged-next");
});

it.each(["openai-codex-flagged-accounts.json", "openai-codex-blocked-accounts.json"])("rejects changed and corrupt older flagged roots (%s)", async name => {
	await seedNearCapacity();
	const source = join(dir, `${name}.bak.2`);
	await fs.writeFile(source, JSON.stringify({version: 1, accounts: pool(["old-0"]).accounts}));
	const read = fs.readFile.bind(fs);
	const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
		const content = await read(...args);
		if (String(args[0]) === source) await fs.writeFile(source, JSON.stringify({version: 1, accounts: pool(["changed-root"]).accounts}));
		return content;
	});
	await expect(collectRestorableCredentials(path)).rejects.toThrow("changed during scan");
	spy.mockRestore();
	await fs.writeFile(source, "{");
	const fetch = injectRefresh();
	expect(await queue().refresh("A", path)).toMatchObject({type: "success"});
	const bytes = await fs.readFile(getPendingAuthPath(path), "utf8");
	await expect(queue().refresh("B", path)).rejects.toMatchObject({code: "EPENDINGAUTHCAPACITY"});
	await prunePendingAuth(path, pool(["A-next", "B"]), () => collectRestorableCredentials(path));
	expect(await fs.readFile(getPendingAuthPath(path), "utf8")).toBe(bytes);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["proactive", "request", "selected"])("retains new credentials and first error in the real %s consumer", async consumer => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
	const manager = new AccountManager(undefined, (await loadAccounts())!);
	const account = manager.getAccountByIndex(0)!;
	account.consecutiveAuthFailures = 2;
	const fetch = injectRefresh();
	const {cause, spy} = denyJournalSettlement();
	const auth = {type: "oauth" as const, access: account.access!, refresh: account.refreshToken, expires: account.expires!};
	const setter = vi.fn();
	const stored = (await loadAccounts())!;
	const operation = consumer === "proactive" ? proactiveRefreshAccount(account)
		: consumer === "request" ? refreshAndUpdateToken(auth, {auth: {set: setter}} as never, {accountManager: manager, account})
		: persistAndSyncSelectedAccount({storage: stored, targetIndex: 0, parsed: 1, switchReason: "manual"});
	const error = await operation.catch(value => value);
	expect(error).toBeInstanceOf(PendingAuthSettlementError);
	expect(error.cause).toBe(cause);
	expect(JSON.stringify(error)).not.toContain("access-A");
	expect(JSON.stringify(error)).not.toContain("A-next");
	if (consumer === "selected") expect(stored.accounts[0]).toMatchObject({refreshToken: "A-next", accessToken: "access-A-next"});
	else expect(account).toMatchObject({refreshToken: "A-next", access: "access-A-next", consecutiveAuthFailures: 2});
	if (consumer === "request") expect(auth).toMatchObject({refresh: "A-next", access: "access-A-next"});
	expect(setter).not.toHaveBeenCalled();
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(0);
	await expect(queue().refresh("A", path)).rejects.toBe(error);
	await expect(queue().refresh("A-next", path)).rejects.toBe(error);
	expect(fetch).toHaveBeenCalledTimes(1);
	spy.mockRestore();
	expect(await queue().refresh("A-next", path)).toMatchObject({type: "success", refresh: "A-next"});
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("A-next");
	expect(await queue().refresh("A-next", path)).toMatchObject({type: "success", refresh: "A-next-next"});
	expect(fetch).toHaveBeenCalledTimes(2);
	vi.unstubAllEnvs();
});

it("retains Guardian live credentials without healing or an authentication failure", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
	const manager = new AccountManager(undefined, (await loadAccounts())!);
	const account = manager.getAccountByIndex(0)!;
	account.consecutiveAuthFailures = 2;
	const success = vi.spyOn(manager, "recordSuccess");
	const failure = vi.spyOn(manager, "incrementAuthFailures");
	const fetch = injectRefresh();
	const {cause} = denyJournalSettlement();
	const guardian = new RefreshGuardian(() => manager);
	await guardian.tick();
	expect(account).toMatchObject({refreshToken: "A-next", access: "access-A-next", consecutiveAuthFailures: 2});
	expect(guardian.getStats()).toMatchObject({failed: 1, networkFailed: 0, authFailed: 0, refreshed: 0});
	expect(success).not.toHaveBeenCalled();
	expect(failure).not.toHaveBeenCalled();
	await guardian.tick();
	await expect(queue().refresh("A", path)).rejects.toMatchObject({cause});
	expect(fetch).toHaveBeenCalledTimes(1);
	vi.unstubAllEnvs();
});

it.each(["record", "expiry", "credential", "disable", "reset"])("does not overwrite changed authority after settlement failure (%s)", async change => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
	const manager = new AccountManager(undefined, (await loadAccounts())!);
	const account = manager.getAccountByIndex(0)!;
	const entered = deferred(), release = deferred();
	const fetch = injectRefresh({token: "A", entered, release});
	denyJournalSettlement();
	const pending = proactiveRefreshAccount(account).catch(error => error);
	await entered.promise;
	if (change === "record") account.recordId = "replacement";
	else if (change === "expiry") account.expires = 2;
	else if (change === "credential") {account.access = "B-access"; account.refreshToken = "B";}
	else if (change === "disable") account.enabled = false;
	else await fs.writeFile(getIntentionalResetMarkerPath(path), "fixture-reset");
	const expected = {...account};
	release.resolve();
	const error = await pending;
	expect(error).toBeInstanceOf(PendingAuthSettlementError);
	expect(account).toEqual(expected);
	await expect(queue().refresh("A", path)).rejects.toBe(error);
	expect(fetch).toHaveBeenCalledTimes(1);
	vi.unstubAllEnvs();
});

it("coalesces failed settlement followers across queue instances and retains scope isolation", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const entered = deferred(), release = deferred();
	const fetch = injectRefresh({token: "A", entered, release});
	denyJournalSettlement();
	const first = queue(true).refresh("A", path).catch(error => error);
	await entered.promise;
	const follower = queue().refresh("A", path).catch(error => error);
	release.resolve();
	const error = await first;
	expect(await follower).toBe(error);
	await expect(queue().refresh("A-next", path)).rejects.toBe(error);
	expect(fetch).toHaveBeenCalledTimes(1);
	const other = join(dir, "other.json");
	await fs.writeFile(other, JSON.stringify(pool(["A"])));
	expect(await queue().refresh("A", other)).toMatchObject({type: "success", refresh: "A-next"});
	expect(fetch).toHaveBeenCalledTimes(2);
	expect((await fs.readdir(join(dir, "leases"))).filter(file => file.endsWith(".result.json"))).toEqual([]);
});

it("retains a failed same-token renewal until persistence-only settlement", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({access_token: "renewed-access", refresh_token: "A", expires_in: 3600}));
	const {spy} = denyJournalSettlement();
	const error = await queue().refresh("A", path).catch(value => value);
	await expect(queue().refresh("A", path)).rejects.toBe(error);
	expect(fetch).toHaveBeenCalledTimes(1);
	spy.mockRestore();
	expect(await queue().refresh("A", path)).toMatchObject({type: "success", refresh: "A", access: "renewed-access"});
	expect(fetch).toHaveBeenCalledTimes(1);
	expect((await loadAccounts())?.accounts[0]?.accessToken).toBe("renewed-access");
});

it("settles retained material after a compatible primary save without another OAuth spend", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const fetch = injectRefresh();
	const {spy} = denyJournalSettlement();
	const error = await queue().refresh("A", path).catch(value => value);
	spy.mockRestore();
	const saved = pool(["A"]);
	Object.assign(saved.accounts[0]!, {accessToken: error.result.access, refreshToken: error.result.refresh, expiresAt: error.result.expires});
	await fs.writeFile(path, JSON.stringify(saved));
	expect(await queue().refresh("A-next", path)).toMatchObject(error.result);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(await queue().refresh("A-next", path)).toMatchObject({type: "success", refresh: "A-next-next"});
	expect(fetch).toHaveBeenCalledTimes(2);
});


it.each(["health", "repair", "sync"])("keeps the original settlement error in the real CLI %s path", async consumer => {
	vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
	vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
	setStoragePathDirect(null);
	path = getStoragePath();
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	const fetch = injectRefresh();
	const {cause} = denyJournalSettlement();
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	const deps: RepairCommandDeps = {
		stylePromptText: text => text,
		styleAccountDetailText: text => text,
		formatResultSummary: segments => segments.map(segment => segment.text).join(" | "),
		resolveActiveIndex: () => 0,
		hasUsableAccessToken: () => false,
		hasLikelyInvalidRefreshToken: () => false,
		normalizeFailureDetail: (message, reason) => message ?? reason ?? "unknown",
		buildQuotaEmailFallbackState: () => new Map(),
		updateQuotaCacheForAccount: () => false,
		cloneQuotaCacheData: cache => structuredClone(cache),
		pruneUnsafeQuotaEmailCacheEntry: () => false,
		formatCompactQuotaSnapshot: () => "fixture",
		resolveStoredAccountIdentity: (accountId, accountIdSource) => ({accountId, accountIdSource}),
		applyTokenAccountIdentity: () => false,
		reboundUnauthorizedAccountIdentity: async () => null,
		refreshCodexCliMirror: async () => null,
	};
	const operation = consumer === "health" ? runHealthCheck({forceRefresh: true})
		: consumer === "repair" ? runFix(["--json"], deps) : autoSyncActiveAccountToCodex();
	const error = await operation.catch(value => value);
	expect(error).toBeInstanceOf(PendingAuthSettlementError);
	expect(error.cause).toBe(cause);
	expect(error.result).toMatchObject({access: "access-A-next", refresh: "A-next"});
	await expect(queue().refresh("A", path)).rejects.toBe(error);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect((await loadAccounts())?.accounts).toHaveLength(1);
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(0);
});

it("does not flag or remove an account on failed settlement during a real account check", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
	const fetch = injectRefresh();
	const {cause, spy} = denyJournalSettlement();
	const showLine = vi.fn();
	const flag = vi.fn();
	const probe = vi.fn(async () => {throw Error("Unexpected fixture quota probe");});
	const deps: Parameters<typeof runRuntimeAccountCheck>[1] = {
		hydrateEmails: async storage => storage, loadAccounts, createEmptyStorage: () => pool([]),
		loadFlaggedAccounts: async () => ({version: 1, accounts: []}),
		createAccountCheckWorkingState: flaggedStorage => ({flaggedStorage, removeFromActive: new Set(), storageChanged: false, flaggedChanged: false, ok: 0, errors: 0, disabled: 0}),
		lookupCodexCliTokensByEmail: async () => null, extractAccountId: () => undefined,
		shouldUpdateAccountIdFromToken: () => false, sanitizeEmail: email => email, extractAccountEmail: () => undefined,
		queuedRefresh, isRuntimeFlaggableFailure: () => true, fetchCodexQuotaSnapshot: probe,
		resolveRequestAccountId: () => undefined, formatCodexQuotaLine: () => "fixture",
		clampRuntimeActiveIndices: () => undefined, MODEL_FAMILIES: ["codex"], saveAccounts,
		invalidateAccountManagerCache: () => undefined, saveFlaggedAccounts: flag, showLine,
	};
	await expect(runRuntimeAccountCheck(true, deps)).rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT", cause});
	expect(showLine).not.toHaveBeenCalledWith("Results: 0 ok, 1 error, 0 disabled");
	expect(flag).not.toHaveBeenCalled();
	expect(probe).not.toHaveBeenCalled();
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("A");
	await expect(queue().refresh("A", path)).rejects.toMatchObject({cause, result: {refresh: "A-next"}});
	spy.mockRestore();
	await runRuntimeAccountCheck(true, deps);
	expect(showLine).toHaveBeenCalledWith("Results: 1 ok, 0 error, 0 disabled");
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("A-next");
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("retains hydrate credentials in their actual live row without claiming a completed save", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
	vi.stubEnv("VITEST_WORKER_ID", undefined);
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("CODEX_SKIP_EMAIL_HYDRATE", "0");
	const storage = (await loadAccounts())!;
	const fetch = injectRefresh();
	const {cause} = denyJournalSettlement();
	const save = vi.fn();
	const warn = vi.fn();
	await expect(hydrateRuntimeEmails(storage, {
		queuedRefresh, extractAccountId: () => undefined, sanitizeEmail: email => email, extractAccountEmail: () => undefined,
		shouldUpdateAccountIdFromToken: () => false, saveAccounts: save, logWarn: warn, pluginName: "fixture",
	})).rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT", cause});
	expect(storage.accounts[0]).toMatchObject({refreshToken: "A-next", accessToken: "access-A-next"});
	expect(save).not.toHaveBeenCalled();
	expect(warn).not.toHaveBeenCalled();
	await expect(queue().refresh("A", path)).rejects.toMatchObject({cause});
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("retains flagged credentials without restoring an unsettled sign-in", async () => {
	await fs.writeFile(path, JSON.stringify(pool(["A"])));
	vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
	const flagged = {version: 1 as const, accounts: pool(["flagged"]).accounts.map(row => ({...row, flaggedAt: 1, enabled: false}))};
	await fs.writeFile(getFlaggedAccountsPath(), JSON.stringify(flagged));
	const fetch = injectRefresh();
	const {cause} = denyJournalSettlement();
	const restore = vi.fn();
	const save = vi.fn();
	const showLine = vi.fn();
	await expect(verifyRuntimeFlaggedAccounts({
		loadFlaggedAccounts: async () => flagged, lookupCodexCliTokensByEmail: async () => null, queuedRefresh,
		resolveTokenSuccessAccount: tokens => tokens, persistAccounts: restore,
		invalidateAccountManagerCache: () => undefined, saveFlaggedAccounts: save, showLine,
	})).rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT", cause});
	expect(flagged.accounts[0]).toMatchObject({refreshToken: "flagged-next", accessToken: "access-flagged-next", enabled: false});
	expect(save).not.toHaveBeenCalled();
	expect(restore).not.toHaveBeenCalled();
	await expect(queue().refresh("flagged", path)).rejects.toMatchObject({cause});
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(showLine.mock.calls.flat().join(" ")).not.toContain("access-flagged");
});

it("backpressures at 1000 unsettled owners without evicting spent authority", async () => {
	const tokens = Array.from({length: 1001}, (_, index) => `bound-${index}`);
	await fs.writeFile(path, JSON.stringify(pool(tokens)));
	const fetch = injectRefresh();
	denyJournalSettlement();
	for (const token of tokens.slice(0, 1000)) await expect(queue().refresh(token, path)).rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT"});
	expect(queue().pendingCount).toBe(1000);
	await expect(queue().refresh(tokens[1000]!, path)).rejects.toMatchObject({code: "EPENDINGAUTHCAPACITY"});
	await expect(queue().refresh(tokens[0]!, path)).rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT"});
	expect(fetch).toHaveBeenCalledTimes(1000);
	expect(queue().pendingCount).toBe(1000);
}, 20000);
