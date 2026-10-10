import {once} from "node:events";
import {promises as fs} from "node:fs";
import {createServer, type Server} from "node:http";
import type {Socket} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import WebSocket, {WebSocketServer} from "ws";
import {afterEach, expect, it, vi} from "vitest";
import {AccountManager} from "../lib/accounts.js";
import {CircuitBreaker, getCircuitBreaker, clearCircuitBreakers, type CircuitAdmissionReceipt} from "../lib/circuit-breaker.js";
import {PreemptiveQuotaScheduler} from "../lib/preemptive-quota-scheduler.js";
import {getModelFamily} from "../lib/prompts/codex.js";
import {startRuntimeRotationProxy} from "../lib/runtime-rotation-proxy.js";
import * as refreshRuntime from "../lib/runtime/rotation-token-refresh.js";
import {getPendingAuthPath, recordPendingAuth} from "../lib/storage/pending-auth.js";
import {setStoragePathDirect, type AccountStorageV3} from "../lib/storage.js";
import {removeWithRetry} from "./helpers/remove-with-retry.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of cleanups.splice(0).reverse()) await close();
	setStoragePathDirect(null);
	clearCircuitBreakers();
});
function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>(done => {resolve = done;});
	return {promise, resolve};
}
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Missing fixture address");
	return `http://127.0.0.1:${address.port}`;
}
async function fixture(native: boolean, delayed = false) {
	const root = await fs.mkdtemp(join(tmpdir(), "dispatch-authority-"));
	cleanups.push(() => removeWithRetry(root, {recursive: true, force: true}));
	const path = join(root, "accounts.json");
	setStoragePathDirect(path);
	const pool: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "R1", accountId: "W1", refreshToken: "refresh-A", accessToken: "A", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, workspaces: [{id: "W1", enabled: true}, {id: "W2", enabled: true}], currentWorkspaceIndex: 0}]};
	await fs.writeFile(path, JSON.stringify(pool));
	const manager = new AccountManager(undefined, pool);
	const upstream = createServer();
	const sockets = new Set<Socket>();
	upstream.on("connection", socket => {sockets.add(socket); socket.once("close", () => sockets.delete(socket));});
	const wss = new WebSocketServer({noServer: true});
	const entered = deferred(), release = deferred();
	const creates: Array<{token: string | undefined; workspace: string | undefined; body: Record<string, unknown>}> = [];
	let connections = 0;
	upstream.on("upgrade", (req, socket, head) => {
		entered.resolve();
		void (delayed ? release.promise : Promise.resolve()).then(() => {
			if (socket.destroyed) return;
			wss.handleUpgrade(req, socket, head, ws => {
				connections++;
				ws.on("message", data => {
					creates.push({token: req.headers.authorization, workspace: String(req.headers["chatgpt-account-id"]), body: JSON.parse(String(data))});
					ws.send(JSON.stringify({type: "response.completed", response: {id: `response-${creates.length}`, status: "completed", output: []}}));
				});
			});
		});
	});
	const base = await listen(upstream);
	cleanups.push(async () => {
		release.resolve();
		for (const ws of wss.clients) ws.terminate();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(done => wss.close(() => done()));
		await new Promise<void>(done => upstream.close(() => done()));
	});
	const fetched: string[] = [], discoveries: string[] = [];
	let quotaFailure = false;
	const fetchImpl: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") {discoveries.push(new Headers(init?.headers).get("authorization") ?? ""); return Response.json({models: [{slug: "shared"}]});}
		fetched.push(new Headers(init.headers).get("authorization") ?? "");
		if (quotaFailure) return Response.json({error: {code: "usage_limit_reached"}}, {status: 429, headers: {"retry-after": "60"}});
		return new Response('data: {"type":"response.completed","response":{"id":"http-result","status":"completed","output":[]}}\n\n', {headers: {"content-type": "text/event-stream"}});
	};
	const proxy = await startRuntimeRotationProxy({nativeOpenai: native, accountManager: manager, fetchImpl, clientApiKey: "fixture-client", forcedAccountIndex: 0, upstreamBaseUrl: `${base}/backend-api`, ...(native ? {readNativeAccountStorage: async () => JSON.parse(await fs.readFile(path, "utf8"))} : {})});
	cleanups.push(async () => {await proxy.close(); await manager.flushPendingSave();});
	const connect = async () => {
		const ws = new WebSocket(`${proxy.baseUrl.replace("http:", "ws:")}/responses`, {headers: {authorization: "Bearer fixture-client"}});
		cleanups.push(async () => {ws.terminate();});
		await once(ws, "open");
		return ws;
	};
	const post = () => fetch(`${proxy.baseUrl}/responses`, {method: "POST", headers: {authorization: "Bearer fixture-client", "content-type": "application/json"}, body: JSON.stringify({model: "shared", input: []})});
	return {root, path, pool, manager, proxy, entered, release, creates, fetched, discoveries, connect, post, rejectQuota: () => {quotaFailure = true;}, connections: () => connections};
}
function turn(ws: WebSocket, extra: Record<string, unknown> = {}) {
	const received = once(ws, "message");
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: [], ...extra}));
	return received.then(([data]) => JSON.parse(String(data)));
}

it.each(["quota", "scheduler", "circuit", "revoked", "journal"])("rechecks native %s authority after a delayed real handshake", async mutation => {
	const f = await fixture(true, true);
	const ws = await f.connect();
	const result = turn(ws);
	await f.entered.promise;
	const account = f.manager.getAccountByIndex(0)!;
	if (mutation === "quota") {
		f.rejectQuota();
		const concurrent = await f.post(); await concurrent.text();
		expect(concurrent.status).toBe(503);
		expect(f.manager.getAccountRuntimeSkipReason(0, getModelFamily("shared"), "shared")).toBe("rate-limited");
	}
	if (mutation === "scheduler") vi.spyOn(PreemptiveQuotaScheduler.prototype, "getDeferral").mockReturnValue({defer: true, waitMs: 60000});
	if (mutation === "circuit") for (let i = 0; i < 3; i++) f.manager.recordFailure(account, "codex", "shared");
	if (mutation === "revoked") await recordPendingAuth(f.path, {recordId: "R1", priorRefreshToken: "refresh-A", refreshToken: "refresh-A", accessToken: "A", expiresAt: account.expires!, enabled: false, authInvalidatedAt: 5000, at: 1});
	if (mutation === "journal") await fs.writeFile(getPendingAuthPath(f.path), "invalid journal");
	f.release.resolve();
	expect(await result).toMatchObject({type: "error", status: 503});
	expect(f.creates).toEqual([]);
	expect(f.fetched).toEqual(mutation === "quota" ? ["Bearer A"] : []);
	expect(f.proxy.getStatus().upstreamRequests).toBe(mutation === "quota" ? 1 : 0);
});

it("retains valid native authority through a delayed handshake and a reused channel", async () => {
	const f = await fixture(true, true), ws = await f.connect();
	const first = turn(ws);
	await f.entered.promise;
	f.release.resolve();
	expect(await first).toMatchObject({type: "response.completed"});
	expect(await turn(ws)).toMatchObject({type: "response.completed"});
	expect(f.creates.map(create => create.token)).toEqual(["Bearer A", "Bearer A"]);
	expect(f.connections()).toBe(1);
});

it.each(["credential", "workspace"].flatMap(mutation => [false, true].map(continuation => ({mutation, continuation}))))
("rejects or replaces the actual idle custom binding (%j)", async ({mutation, continuation}) => {
	const f = await fixture(false), ws = await f.connect();
	const first = await turn(ws);
	expect(first).toMatchObject({type: "response.completed"});
	const account = f.manager.getAccountByIndex(0)!;
	if (mutation === "credential") f.manager.updateFromAuth(account, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
	else f.manager.disableWorkspace(account, "W1");
	await f.manager.saveToDisk();
	const next = await turn(ws, continuation ? {previous_response_id: first.response.id} : {});
	if (continuation) {
		expect(next).toMatchObject({type: "error", error: {code: "previous_response_not_found"}});
		expect(f.creates).toHaveLength(1);
	} else {
		expect(next).toMatchObject({type: "response.completed"});
		expect(f.creates).toHaveLength(2);
		expect(f.creates[1]).toMatchObject(mutation === "credential" ? {token: "Bearer B"} : {workspace: "W2"});
		expect(f.connections()).toBe(2);
	}
});

it("rejects same-record durable credential replacement before HTTP dispatch", async () => {
	const f = await fixture(true), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	let admitted = false, held = false;
	const consume = f.manager.consumeTokenWithReason.bind(f.manager);
	vi.spyOn(f.manager, "consumeTokenWithReason").mockImplementation((...args) => {const result = consume(...args); admitted ||= result.ok; return result;});
	const refresh = refreshRuntime.ensureFreshAccessToken;
	vi.spyOn(refreshRuntime, "ensureFreshAccessToken").mockImplementation(async args => {if (admitted && !held) {held = true; entered.resolve(); await release.promise;} return refresh(args);});
	const pending = f.post();
	await entered.promise;
	Object.assign(f.pool.accounts[0]!, {accessToken: "B", refreshToken: "refresh-B", expiresAt: Date.now() + 7200000});
	await fs.writeFile(f.path, JSON.stringify(f.pool));
	release.resolve();
	const denied = await pending; await denied.text();
	expect(denied.status).toBe(503);
	expect(f.fetched).toEqual([]);
	const current = await f.post(); await current.text();
	expect(current.status).toBe(200);
	expect(f.fetched).toEqual(["Bearer B"]);
});

it("denies a closed-admitted request while another request owns the half-open epoch", async () => {
	const f = await fixture(true), aEntered = deferred(), aRelease = deferred(), bEntered = deferred(), bRelease = deferred();
	cleanups.push(async () => {aRelease.resolve(); bRelease.resolve();});
	let admissions = 0;
	const consume = f.manager.consumeTokenWithReason.bind(f.manager);
	vi.spyOn(f.manager, "consumeTokenWithReason").mockImplementation((...args) => {const result = consume(...args); if (result.ok) admissions++; return result;});
	const refresh = refreshRuntime.ensureFreshAccessToken;
	vi.spyOn(refreshRuntime, "ensureFreshAccessToken").mockImplementation(async args => {
		const attempt = admissions;
		if (attempt === 1) {aEntered.resolve(); await aRelease.promise;}
		if (attempt === 2) {bEntered.resolve(); await bRelease.promise;}
		return refresh(args);
	});
	const a = f.post(); void a.catch(() => undefined); await aEntered.promise;
	const account = f.manager.getAccountByIndex(0)!;
	const breaker = getCircuitBreaker(account.circuitKeyId!);
	for (let i = 0; i < 3; i++) breaker.recordFailure();
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + 30001);
	const b = f.post(); void b.catch(() => undefined); await bEntered.promise;
	expect(breaker.getState()).toBe("half-open");
	aRelease.resolve();
	const denied = await a; await denied.text();
	expect(denied.status).toBe(503);
	expect(f.fetched).toEqual([]);
	expect(breaker.getState()).toBe("half-open");
	bRelease.resolve();
	const accepted = await b; await accepted.text();
	expect(accepted.status).toBe(200);
	expect(f.fetched).toEqual(["Bearer A"]);
});

it("does not dispatch discovery for a deleted or foreign manager member", async () => {
	const f = await fixture(true), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const account = f.manager.getAccountByIndex(0)!;
	const foreign = new AccountManager(undefined, f.pool).getAccountByIndex(0)!;
	expect(await f.manager.isAccountJournalEligible(foreign)).toBe(false);
	const refresh = refreshRuntime.ensureFreshAccessToken;
	let held = false;
	vi.spyOn(refreshRuntime, "ensureFreshAccessToken").mockImplementation(async args => {if (!held) {held = true; entered.resolve(); await release.promise;} return refresh(args);});
	const pending = fetch(`${f.proxy.baseUrl}/models`, {headers: {authorization: "Bearer fixture-client"}});
	await entered.promise;
	f.manager.removeAccount(account);
	release.resolve();
	const response = await pending; await response.text();
	expect(await f.manager.isAccountJournalEligible(account)).toBe(false);
	expect(f.discoveries).toEqual([]);
});

it.each(["open", "reset", "window", "other-breaker"])("invalidates a circuit receipt after %s without taking another probe", change => {
	const breaker = new CircuitBreaker({failureThreshold: 1, resetTimeoutMs: 1});
	let receipt: CircuitAdmissionReceipt | undefined;
	breaker.tryCanExecute(value => {receipt = value;});
	if (!receipt) throw Error("Missing admission");
	expect(breaker.isAdmissionCurrent(receipt)).toBe(true);
	if (change === "reset") breaker.reset();
	else if (change === "other-breaker") {expect(new CircuitBreaker().isAdmissionCurrent(receipt)).toBe(false); return;}
	else {
		breaker.recordFailure();
		if (change === "window") {
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2);
			let probe: CircuitAdmissionReceipt | undefined;
			breaker.tryCanExecute(value => {probe = value;});
			if (!probe) throw Error("Missing probe");
			expect(breaker.isAdmissionCurrent(probe)).toBe(true);
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2);
			let next: CircuitAdmissionReceipt | undefined;
			breaker.tryCanExecute(value => {next = value;});
			if (!next) throw Error("Missing renewed probe");
			expect(breaker.isAdmissionCurrent(probe)).toBe(false);
			expect(breaker.isAdmissionCurrent(next)).toBe(true);
		}
	}
	expect(breaker.isAdmissionCurrent(receipt)).toBe(false);
});
