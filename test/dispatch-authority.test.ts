import {once} from "node:events";
import {existsSync, promises as fs} from "node:fs";
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
import * as refreshQueue from "../lib/refresh-queue.js";
import {getPendingAuthPath, recordPendingAuth} from "../lib/storage/pending-auth.js";
import {loadAccounts, setStoragePathDirect, type AccountStorageV3} from "../lib/storage.js";
import {removeWithRetry} from "./helpers/remove-with-retry.js";
import {getAccountPolicyKey, getAccountPolicyPath, upsertAccountPolicy, updateAccountPolicyStore} from "../lib/account-policy.js";
import {getBudgetGuardPath} from "../lib/budget-guard.js";
import {getRoutingProfilesPath} from "../lib/routing-profiles.js";
import {resetRuntimePolicyCacheForTests} from "../lib/policy/runtime-policy-cache.js";
import {ApiModelRuntime} from "../lib/runtime/api-model-runtime.js";
import type {ApiRouteCredential} from "../lib/api-route-store.js";
import {appendUsageLedgerRow} from "../lib/usage/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
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
async function fixture(native: boolean, delayed = false, readApiRoutes?: () => Promise<ApiRouteCredential[]>, refuse = false) {
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
	let reply: ((ws: WebSocket) => void) | undefined;
	upstream.on("upgrade", (req, socket, head) => {
		entered.resolve();
		void (delayed ? release.promise : Promise.resolve()).then(() => {
			if (socket.destroyed) return;
			if (refuse) {socket.end("HTTP/1.1 404 Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;}
			wss.handleUpgrade(req, socket, head, ws => {
				connections++;
				ws.on("message", data => {
					creates.push({token: req.headers.authorization, workspace: String(req.headers["chatgpt-account-id"]), body: JSON.parse(String(data))});
					if (reply) {reply(ws); return;}
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
	let postResponse: (() => Promise<Response>) | undefined;
	const fetchImpl: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") {discoveries.push(new Headers(init?.headers).get("authorization") ?? ""); return Response.json({models: [{slug: "shared"}], data: [{id: "shared"}]});}
		fetched.push(new Headers(init.headers).get("authorization") ?? "");
		if (postResponse) return postResponse();
		if (quotaFailure) return Response.json({error: {code: "usage_limit_reached"}}, {status: 429, headers: {"retry-after": "60"}});
		return new Response('data: {"type":"response.completed","response":{"id":"http-result","status":"completed","output":[]}}\n\n', {headers: {"content-type": "text/event-stream"}});
	};
	const proxy = await startRuntimeRotationProxy({readApiRoutes, nativeOpenai: native, accountManager: manager, fetchImpl, clientApiKey: "fixture-client", forcedAccountIndex: 0, upstreamBaseUrl: `${base}/backend-api`, ...(native ? {readNativeAccountStorage: async () => JSON.parse(await fs.readFile(path, "utf8"))} : {})});
	cleanups.push(async () => {await proxy.close(); await manager.flushPendingSave();});
	const connect = async () => {
		const ws = new WebSocket(`${proxy.baseUrl.replace("http:", "ws:")}/responses`, {headers: {authorization: "Bearer fixture-client"}});
		cleanups.push(async () => {ws.terminate();});
		await once(ws, "open");
		return ws;
	};
	const post = (model = "shared") => fetch(`${proxy.baseUrl}/responses`, {method: "POST", headers: {authorization: "Bearer fixture-client", "content-type": "application/json"}, body: JSON.stringify({model, input: []})});
	return {root, path, pool, manager, proxy, upstreamBaseUrl: base, entered, release, creates, fetched, discoveries, connect, post, rejectQuota: () => {quotaFailure = true;}, setPostResponse: (handler: (() => Promise<Response>) | undefined) => {postResponse = handler;}, connections: () => connections, setReply: (handler: ((ws: WebSocket) => void) | undefined) => {reply = handler;}};
}
it.each(["disable", "delete", "remove", "corrupt"])("rejects durable custom restrictions from another manager (%s)", async mutation => {
	const f = await fixture(false), ws = await f.connect();
	const first = await turn(ws);
	expect(first).toMatchObject({type: "response.completed"});
	const other = new AccountManager(undefined, f.pool);
	if (mutation === "disable") {other.setAccountEnabled(0, false); await other.saveToDisk();}
	if (mutation === "delete") {other.removeAccountByIndex(0); await other.saveToDisk();}
	if (mutation === "remove") await fs.unlink(f.path);
	if (mutation === "corrupt") await fs.writeFile(f.path, "invalid fixture");
	const result = await turn(ws, {previous_response_id: first.response.id});
	expect(result).toMatchObject({type: "error", error: {code: "previous_response_not_found"}});
	expect(f.creates).toHaveLength(1);
});

it.each(["custom", "native", "http"].flatMap(transport => ["primary", "policy", "usage", "metadata", "churn", "cooldown", "quota"].map(mutation => ({transport, mutation}))))
("rechecks changed authority during the final journal wait (%j)", async ({transport, mutation}) => {
	const native = transport === "native";
	const f = await fixture(native), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const original = f.manager.isAccountJournalEligible.bind(f.manager);
	let armed = false, observations = 0, repeatedChange = false;
	vi.spyOn(f.manager, "isAccountJournalEligible").mockImplementation(async account => {
		const eligible = await original(account);
		if (armed && ++observations === (transport === "custom" ? 2 : 3)) {armed = false; entered.resolve(); await release.promise;}
		else if (mutation === "churn" && !armed && observations > 0 && !repeatedChange) {
			repeatedChange = true;
			f.pool.accounts[0]!.accountLabel = "Second fixture label change";
			await fs.writeFile(f.path, JSON.stringify(f.pool));
		}
		return eligible;
	});
	const ws = await f.connect();
	const first = await turn(ws);
	expect(first).toMatchObject({type: "response.completed"});
	await f.manager.flushPendingSave();
	armed = true;
	const pending = transport === "http" ? f.post().then(async response => {const body = await response.text(); return {type: response.status >= 400 ? "error" : "success", status: response.status, body};}) :
		turn(ws, native ? {} : {previous_response_id: first.response.id});
	await Promise.race([entered.promise, pending.then(result => {throw Error(`Request completed before final journal barrier (${observations} observations): ${JSON.stringify(result)}`);})]);
	if (mutation === "primary") {
		const other = new AccountManager(undefined, f.pool);
		other.setAccountEnabled(0, false); await other.saveToDisk();
	} else if (mutation === "cooldown" || mutation === "quota") {
		if (mutation === "cooldown") Object.assign(f.pool.accounts[0]!, {coolingDownUntil: Date.now() + 60000, cooldownReason: "auth-failure"});
		else f.pool.accounts[0]!.rateLimitResetTimes = {[`${getModelFamily("shared")}:shared`]: Date.now() + 60000};
		await fs.writeFile(f.path, JSON.stringify(f.pool));
	} else if (mutation === "metadata" || mutation === "churn") {
		f.pool.accounts[0]!.accountLabel = "Fixture label change";
		await fs.writeFile(f.path, JSON.stringify(f.pool));
	} else if (mutation === "usage") {
		await appendUsageLedgerRow({source: "runtime-proxy", operation: "responses", model: "shared", outcome: "success"});
	} else {
		await updateAccountPolicyStore(store => {upsertAccountPolicy(store, getAccountPolicyKey(f.manager.getAccountByIndex(0)!), policy => {policy.paused = true;}); return {result: undefined, dirty: true};});
		cleanups.push(async () => {await updateAccountPolicyStore(store => {upsertAccountPolicy(store, getAccountPolicyKey(f.manager.getAccountByIndex(0)!), policy => {policy.paused = false;}); return {result: undefined, dirty: true};});});
	}
	release.resolve();
	const result = await pending;
	const permitted = mutation === "usage" || mutation === "metadata";
	expect(result.type).toBe(permitted ? transport === "http" ? "success" : "response.completed" : "error");
	if (mutation === "policy" && transport === "custom" && "closeCode" in result) expect(result.closeCode).toBe(1008);
	expect(f.creates).toHaveLength(permitted && transport !== "http" ? 2 : 1);
	expect(f.fetched).toEqual(permitted && transport === "http" ? ["Bearer A"] : []);
});

it.each([402, 403].flatMap(status => [false, true].map(workspaces => ({status, workspaces}))))
("preserves explicit recovery after a delayed workspace refusal (%j)", async ({status, workspaces}) => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const account = f.manager.getAccountByIndex(0)!;
	if (!workspaces) {account.workspaces = undefined; await f.manager.saveToDisk();}
	f.setPostResponse(async () => new Response(new ReadableStream({start(controller) {
		entered.resolve();
		void release.promise.then(() => {controller.enqueue(new TextEncoder().encode(JSON.stringify({error: {code: "deactivated_workspace"}}))); controller.close();});
	}}), {status}));
	const pending = f.post();
	await entered.promise;
	f.manager.updateFromAuth(account, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
	await f.manager.saveToDisk();
	f.setPostResponse(undefined);
	release.resolve();
	const refused = await pending; await refused.text();
	expect(refused.status).toBe(status);
	await f.manager.flushPendingSave();
	const persisted = JSON.parse(await fs.readFile(f.path, "utf8")).accounts[0];
	expect(persisted.accessToken).toBe("B");
	expect(persisted.enabled).not.toBe(false);
	expect(persisted.workspaces?.some((workspace: {enabled?: boolean}) => workspace.enabled === false)).not.toBe(true);
	expect(account.enabled).not.toBe(false);
	const accepted = await f.post(); await accepted.text();
	expect(accepted.status).toBe(200);
	expect(f.fetched).toEqual(["Bearer A", "Bearer B"]);
});

it.each(["api", "zdr"] as const)("rejects a known %s model denial acquired during final route observation", async kind => {
	const entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const routes: ApiRouteCredential[] = [{id: "fixture-paid", kind, label: "Fixture", apiKey: "fixture-key", enabled: true, priority: 0, visibleModels: ["shared"]}];
	let reads = 0;
	const f = await fixture(true, false, async () => {if (++reads === 2) {entered.resolve(); await release.promise;} return routes;});
	let runtime: ApiModelRuntime | undefined;
	const original = ApiModelRuntime.prototype.request;
	vi.spyOn(ApiModelRuntime.prototype, "request").mockImplementation(function(...args) {runtime = this; return original.apply(this, args);});
	const pending = f.post(`${kind}/shared`);
	await entered.promise;
	const advertised = runtime?.cachedCatalogs()[0]?.models[0];
	if (!advertised) throw Error("Missing fixture catalog");
	advertised.capability_probe_status = {responses: "unsupported"};
	release.resolve();
	const denied = await pending; await denied.text();
	expect(denied.status).toBe(502);
	expect(f.fetched).toEqual([]);
});

it.each(["http", "custom", "native", "http-stream", "native-stream"].flatMap(transport =>
	["workspace", "auth", "cooldown"].filter(kind => !transport.endsWith("stream") || kind === "auth").flatMap(kind =>
		[false, true].map(lossFirst => ({transport, kind, lossFirst})))))
("keeps durable recovery separate from delayed response restrictions (%j)", async ({transport, kind, lossFirst}) => {
	if (kind === "cooldown" && lossFirst && transport !== "custom") vi.useFakeTimers({toFake: ["Date"]});
	const native = transport.startsWith("native"), stream = transport.endsWith("stream");
	const f = await fixture(native), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const status = kind === "workspace" ? 402 : 401;
	const error = {code: kind === "workspace" ? "deactivated_workspace" : kind === "auth" ? "token_invalidated" : "unauthorized"};
	const payload = stream ? {type: "response.failed", response: {id: "fixture-loss", status: "failed", error}} : {type: "error", status, error};
	if (transport.startsWith("http")) {
		f.setPostResponse(async () => new Response(new ReadableStream({start(controller) {
			entered.resolve();
			void release.promise.then(() => {controller.enqueue(new TextEncoder().encode(stream ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload))); controller.close();});
		}}), {status: stream ? 200 : status, headers: stream ? {"content-type": "text/event-stream"} : {}}));
	} else {
		f.setReply(ws => {entered.resolve(); void release.promise.then(() => ws.send(JSON.stringify(payload)));});
	}
	const pending = transport.startsWith("http") ? f.post().then(response => response.text()) : turn(await f.connect());
	await entered.promise;
	const recover = async () => {
		const current = await loadAccounts();
		if (!current) throw Error("Missing fixture primary");
		const other = new AccountManager(undefined, current), account = other.getAccountByIndex(0)!;
		other.updateFromAuth(account, {type: "oauth", access: "B", refresh: "refresh-B", expires: kind === "workspace" ? f.pool.accounts[0]!.expiresAt! : Date.now() + 7200000});
		if (lossFirst) {other.setAccountEnabled(0, false); other.setAccountEnabled(0, true);}
		await other.saveToDisk();
	};
	if (lossFirst) {
		release.resolve(); await pending;
		await vi.waitFor(async () => {
			await f.manager.flushPendingSave();
			const account = JSON.parse(await fs.readFile(f.path, "utf8")).accounts[0];
			expect(kind === "workspace" ? account.enabled === false || account.workspaces?.some((workspace: {enabled?: boolean}) => workspace.enabled === false) : account.cooldownReason === "auth-failure").toBe(true);
		});
		await recover();
	} else {await recover(); release.resolve(); await pending;}
	f.setPostResponse(undefined); f.setReply(undefined);
	await f.manager.flushPendingSave();
	const reloaded = await loadAccounts();
	const account = reloaded?.accounts[0];
	expect(account?.accessToken).toBe("B");
	expect(account?.refreshToken).toBe("refresh-B");
	expect(account?.enabled).not.toBe(false);
	expect(account?.authInvalidatedAt).toBeUndefined();
	expect(account?.cooldownReason).not.toBe("auth-failure");
	expect(account?.workspaces?.some(workspace => workspace.enabled === false)).not.toBe(true);
	if (!lossFirst) expect(f.manager.getAccountByIndex(0)?.cooldownReason).not.toBe("auth-failure");
	if (kind === "cooldown" && lossFirst && transport !== "custom") {
		const cooling = await f.post(); const rejection = await cooling.json();
		expect(cooling.status).toBe(503);
		expect(rejection.error.reason).toBe("circuit-open");
		vi.setSystemTime(new Date(rejection.error.reset_at).getTime() + 1);
	}
	const accepted = await f.post(); const acceptedBody = await accepted.text();
	expect(accepted.status, acceptedBody).toBe(200);
	expect(f.fetched.at(-1)).toBe("Bearer B");
});

it("rejects a delayed refresh refusal against another manager's durable recovery", async () => {
	const f = await fixture(false), account = f.manager.getAccountByIndex(0)!;
	account.expires = 0;
	const entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	vi.spyOn(refreshQueue, "queuedRefresh").mockImplementation(async () => {entered.resolve(); await release.promise; return {type: "failed", reason: "http_error", statusCode: 401, message: "OAuth token has been invalidated"};});
	const pending = refreshRuntime.ensureFreshAccessToken({accountManager: f.manager, account, family: "codex", model: null, now: Date.now(), tokenRefreshSkewMs: 30000, tokenInvalidationCooldownMs: 60000});
	await entered.promise;
	const other = new AccountManager(undefined, (await loadAccounts())!);
	other.updateFromAuth(other.getAccountByIndex(0)!, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
	await other.saveToDisk(); release.resolve();
	expect(await pending).toMatchObject({ok: false, retryable: true, invalidated: false});
	expect(account.authInvalidatedAt).toBeUndefined();
	expect(account.coolingDownUntil).toBeUndefined();
	expect(account.consecutiveAuthFailures ?? 0).toBe(0);
	const durable = (await loadAccounts())?.accounts[0];
	expect(durable?.accessToken).toBe("B");
	expect(durable?.authInvalidatedAt).toBeUndefined();
	expect(durable?.cooldownReason).toBeUndefined();
});

it("keeps a current refusal authoritative despite a same-credential expiry update", async () => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	f.setPostResponse(async () => {entered.resolve(); await release.promise; return Response.json({error: {code: "token_invalidated"}}, {status: 401});});
	const pending = f.post(); await entered.promise;
	const other = new AccountManager(undefined, (await loadAccounts())!);
	other.getAccountByIndex(0)!.expires += 3600000;
	await other.saveToDisk(); release.resolve();
	await (await pending).text(); await f.manager.flushPendingSave();
	const durable = (await loadAccounts())?.accounts[0];
	expect(durable?.authInvalidatedAt).toBeGreaterThan(0);
	expect(durable?.cooldownReason).toBe("auth-failure");
});

it.each(["deleted", "unreadable"])("does not mutate restrictions against %s primary authority", async mutation => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	f.setPostResponse(async () => {entered.resolve(); await release.promise; return Response.json({error: {code: "deactivated_workspace"}}, {status: 403});});
	const pending = f.post(); await entered.promise;
	if (mutation === "deleted") await fs.unlink(f.path);
	else await fs.writeFile(f.path, "{invalid");
	release.resolve(); await (await pending).text();
	expect(f.manager.getAccountByIndex(0)?.enabled).not.toBe(false);
	if (mutation === "deleted") expect(existsSync(f.path)).toBe(false);
	else expect(await fs.readFile(f.path, "utf8")).toBe("{invalid");
});

it.each(["circuit", "quota", "allowed"])("honors final discovery runtime admission (%s)", async mutation => {
	const f = await fixture(true), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const original = refreshRuntime.ensureFreshAccessToken;
	let held = false;
	vi.spyOn(refreshRuntime, "ensureFreshAccessToken").mockImplementation(async args => {
		if (!held) {held = true; entered.resolve(); await release.promise;}
		return original(args);
	});
	const pending = fetch(`${f.proxy.baseUrl}/models`, {headers: {authorization: "Bearer fixture-client"}});
	await entered.promise;
	const account = f.manager.getAccountByIndex(0)!;
	if (mutation === "circuit") for (let i = 0; i < 3; i++) f.manager.recordFailure(account, "codex", null);
	if (mutation === "quota") f.manager.markRateLimitedWithReason(account, 60000, "codex", "quota", null);
	release.resolve();
	await (await pending).text();
	expect(f.discoveries.length).toBe(mutation === "allowed" ? 2 : 0);
});

it.each(["disk", "login"])("does not relabel an old auth cooldown when adopting %s recovery", async source => {
	const f = await fixture(false), account = f.manager.getAccountByIndex(0)!;
	f.manager.markAccountCoolingDown(account, 60000, "auth-failure");
	if (source === "disk") {
		const other = new AccountManager(undefined, f.pool);
		other.updateFromAuth(other.getAccountByIndex(0)!, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
		await other.saveToDisk();
	} else f.manager.updateFromAuth(account, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
	await f.manager.saveToDisk();
	const disk = (await loadAccounts())?.accounts[0];
	expect(disk?.accessToken).toBe("B");
	expect(disk?.coolingDownUntil).toBeUndefined();
	expect(disk?.cooldownReason).toBeUndefined();
});

function routeApiToFixture(base: string): void {
	const OriginalURL = URL, target = new OriginalURL(base);
	vi.stubGlobal("URL", class extends OriginalURL {
		constructor(input: string | URL, relativeTo?: string | URL) {
			super(input, relativeTo);
			if (this.hostname === "api.openai.com" && this.pathname === "/v1/responses") {this.protocol = "http:"; this.host = target.host;}
		}
	});
}

it.each(["api", "zdr"].flatMap(kind => [false, true].map(refuse => ({kind, refuse}))))
("rejects a known model denial after a real paid handshake (%j)", async ({kind, refuse}) => {
	const routes: ApiRouteCredential[] = [{id: "fixture-paid", kind: kind === "api" ? "api" : "zdr", label: "Fixture", apiKey: "fixture-key", enabled: true, priority: 0, visibleModels: ["shared"]}];
	const f = await fixture(true, true, async () => routes, refuse);
	routeApiToFixture(f.upstreamBaseUrl);
	let runtime: ApiModelRuntime | undefined;
	const original = ApiModelRuntime.prototype.request;
	vi.spyOn(ApiModelRuntime.prototype, "request").mockImplementation(function(...args) {runtime = this; return original.apply(this, args);});
	const ws = await f.connect(), pending = turn(ws, {model: `${kind}/shared`});
	await f.entered.promise;
	const model = runtime?.cachedCatalogs()[0]?.models[0];
	if (!model) throw Error("Missing fixture catalog");
	model.capability_probe_status = {responses: "unsupported"};
	f.release.resolve();
	expect(await pending).toMatchObject({type: "error", status: 502});
	expect(f.creates).toEqual([]);
	expect(f.fetched).toEqual([]);
});

it.each(["api", "zdr"] as const)("rejects known %s denial on a cached HTTP-only channel", async kind => {
	const entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const routes: ApiRouteCredential[] = [{id: "fixture-paid", kind, label: "Fixture", apiKey: "fixture-key", enabled: true, priority: 0, visibleModels: ["shared"]}];
	let armed = false, reads = 0;
	const f = await fixture(true, false, async () => {if (armed && ++reads === 2) {entered.resolve(); await release.promise;} return routes;}, true);
	routeApiToFixture(f.upstreamBaseUrl);
	let runtime: ApiModelRuntime | undefined;
	const original = ApiModelRuntime.prototype.request;
	vi.spyOn(ApiModelRuntime.prototype, "request").mockImplementation(function(...args) {runtime = this; return original.apply(this, args);});
	const ws = await f.connect();
	expect(await turn(ws, {model: `${kind}/shared`})).toMatchObject({type: "response.completed"});
	expect(f.fetched).toEqual(["Bearer fixture-key"]);
	armed = true;
	const pending = turn(ws, {model: `${kind}/shared`});
	await entered.promise;
	const model = runtime?.cachedCatalogs()[0]?.models[0];
	if (!model) throw Error("Missing fixture catalog");
	model.capability_probe_status = {responses: "unsupported"};
	release.resolve();
	expect(await pending).toMatchObject({type: "error", status: 502});
	expect(f.creates).toEqual([]);
	expect(f.fetched).toEqual(["Bearer fixture-key"]);
});

function turn(ws: WebSocket, extra: Record<string, unknown> = {}) {
	const listeners = new AbortController();
	const received = Promise.race([
		once(ws, "message", {signal: listeners.signal}).then(([data]) => JSON.parse(String(data))),
		once(ws, "close", {signal: listeners.signal}).then(([closeCode, reason]) => ({type: "error", closeCode, reason: String(reason)})),
	]).finally(() => listeners.abort());
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: [], ...extra}));
	return received;
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

it.each(["account", "budget", "profile"].flatMap(store => ["corrupt", "shape", "row", "unreadable"].map(failure => ({store, failure}))))
("denies dispatch when governance cannot be observed (%j)", async ({store, failure}) => {
	const f = await fixture(true);
	const path = store === "account" ? getAccountPolicyPath() : store === "budget" ? getBudgetGuardPath() : getRoutingProfilesPath();
	const contents = failure === "corrupt" ? "{fixture corrupt governance" : failure === "shape" ? JSON.stringify({version: 1}) :
		JSON.stringify(store === "account" ? {version: 1, accounts: {"sha256:fixture": failure === "row" ? {paused: "false"} : {}}} :
			store === "budget" ? {version: 1, limits: {default: failure === "row" ? {window: "day", maxRequests: "1"} : {window: "day", maxRequests: 1}}} :
			{version: 1, profiles: {fixture: failure === "row" ? {modelDenylist: "shared"} : {}}});
	await fs.mkdir(join(path, ".."), {recursive: true}); await fs.writeFile(path, contents);
	resetRuntimePolicyCacheForTests();
	const read = fs.readFile.bind(fs);
	if (failure === "unreadable") vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
		if (String(args[0]) === path) throw Object.assign(Error("fixture read denied"), {code: "EACCES"});
		return read(...args);
	});
	cleanups.push(async () => {await fs.rm(path, {force: true}); resetRuntimePolicyCacheForTests();});
	const response = await f.post(); const text = await response.text();
	expect(response.status, text).toBe(503);
	expect(JSON.parse(text).error.code).toBe("runtime_policy_unavailable");
	expect(f.fetched).toEqual([]);
	expect(f.creates).toEqual([]);
});

it("honors a durable runtime clear after this manager persisted its own restrictions", async () => {
	const f = await fixture(true);
	await (await f.post()).text();
	const account = f.manager.getAccountByIndex(0)!;
	f.manager.markAccountCoolingDown(account, 60000, "auth-failure");
	account.rateLimitResetTimes[`${getModelFamily("shared")}:shared`] = Date.now() + 60000;
	await f.manager.saveToDisk();
	const disk = await loadAccounts();
	if (!disk) throw Error("Missing fixture primary");
	const other = new AccountManager(undefined, disk), current = other.getAccountByIndex(0)!;
	other.clearAccountCooldown(current); current.rateLimitResetTimes = {};
	await other.saveToDisk();
	const response = await f.post(); const body = await response.text();
	expect(response.status, body).toBe(200);
	expect(account.coolingDownUntil).toBeUndefined();
	expect(account.rateLimitResetTimes).toEqual({});
	expect(f.fetched).toEqual(["Bearer A", "Bearer A"]);
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
