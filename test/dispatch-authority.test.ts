import {once} from "node:events";
import {existsSync, promises as fs} from "node:fs";
import {createServer, type Server} from "node:http";
import type {Socket} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import WebSocket, {WebSocketServer, type RawData} from "ws";
import {afterEach, expect, it, vi} from "vitest";
import {AccountManager} from "../lib/accounts.js";
import {ContextBudgetGuard} from "../lib/context-budget-guard.js";
import {CircuitBreaker, getCircuitBreaker, clearCircuitBreakers, type CircuitAdmissionReceipt} from "../lib/circuit-breaker.js";
import {PreemptiveQuotaScheduler} from "../lib/preemptive-quota-scheduler.js";
import * as quotaOrdering from "../lib/runtime/subscription-quota-order.js";
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
import {appendUsageLedgerRow, readUsageLedgerRows} from "../lib/usage/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	for (const close of cleanups.splice(0).reverse()) await close();
	vi.unstubAllEnvs();
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
async function fixture(native: boolean, delayed = false, readApiRoutes?: () => Promise<ApiRouteCredential[]>, refuse: boolean | number | {status: number; error: {code: string; param?: string; message?: string}; workspace?: string} = false, quotaRemainingPercentThreshold?: number) {
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
			if (refuse && (typeof refuse !== "object" || !refuse.workspace || refuse.workspace === req.headers["chatgpt-account-id"])) {
				const status = typeof refuse === "object" ? refuse.status : typeof refuse === "number" ? refuse : 404;
				const body = typeof refuse === "object" ? JSON.stringify({error: refuse.error}) : "";
				socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
				return;
			}
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
	const fetched: string[] = [], discoveries: string[] = [], httpWorkspaces: string[] = [];
	let quotaFailure = false;
	let postResponse: (() => Promise<Response>) | undefined;
	const fetchImpl: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") {discoveries.push(new Headers(init?.headers).get("authorization") ?? ""); return Response.json({models: [{slug: "shared", ...(typeof refuse === "object" ? {supported_reasoning_levels: [{effort: "high"}], service_tiers: [{id: "priority", name: "Priority", description: "Fixture"}]} : {})}], data: [{id: "shared"}]});}
		fetched.push(new Headers(init.headers).get("authorization") ?? "");
		httpWorkspaces.push(new Headers(init.headers).get("chatgpt-account-id") ?? "");
		if (postResponse) return postResponse();
		if (quotaFailure) return Response.json({error: {code: "usage_limit_reached"}}, {status: 429, headers: {"retry-after": "60"}});
		return new Response('data: {"type":"response.completed","response":{"id":"http-result","status":"completed","output":[]}}\n\n', {headers: {"content-type": "text/event-stream"}});
	};
	const proxy = await startRuntimeRotationProxy({readApiRoutes, quotaRemainingPercentThreshold, nativeOpenai: native, accountManager: manager, fetchImpl, clientApiKey: "fixture-client", forcedAccountIndex: 0, upstreamBaseUrl: `${base}/backend-api`, ...(native ? {readNativeAccountStorage: async () => JSON.parse(await fs.readFile(path, "utf8"))} : {})});
	cleanups.push(async () => {await proxy.close(); await manager.flushPendingSave();});
	const connect = async () => {
		const ws = new WebSocket(`${proxy.baseUrl.replace("http:", "ws:")}/responses`, {headers: {authorization: "Bearer fixture-client"}});
		cleanups.push(async () => {ws.terminate();});
		await once(ws, "open");
		return ws;
	};
	const post = (model = "shared", sessionKey?: string) => fetch(`${proxy.baseUrl}/responses`, {method: "POST", headers: {authorization: "Bearer fixture-client", "content-type": "application/json"}, body: JSON.stringify({model, input: [], ...(sessionKey ? {prompt_cache_key: sessionKey} : {})})});
	return {root, path, pool, manager, proxy, upstreamBaseUrl: base, entered, release, creates, fetched, discoveries, httpWorkspaces, connect, post, rejectQuota: () => {quotaFailure = true;}, setPostResponse: (handler: (() => Promise<Response>) | undefined) => {postResponse = handler;}, connections: () => connections, setReply: (handler: ((ws: WebSocket) => void) | undefined) => {reply = handler;}};
}
it.each(["disable", "delete", "remove", "corrupt", "reset"])("rejects durable custom restrictions from another manager (%s)", async mutation => {
	const f = await fixture(false), ws = await f.connect();
	const first = await turn(ws);
	expect(first).toMatchObject({type: "response.completed"});
	const other = new AccountManager(undefined, f.pool);
	if (mutation === "disable") {other.setAccountEnabled(0, false); await other.saveToDisk();}
	if (mutation === "delete") {other.removeAccountByIndex(0); await other.saveToDisk();}
	if (mutation === "reset") await fs.writeFile(`${f.path}.reset-intent`, "{}");
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

it.each((["api", "zdr"] as const).flatMap(kind => [401, 429].map(status => ({kind, status}))))
("rejects a prepared API create after credential deferral during final route observation (%j)", async ({kind, status}) => {
	const entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const routes: ApiRouteCredential[] = [{id: "prepared", kind, label: "Fixture", apiKey: "fixture-key", enabled: true, priority: 0, visibleModels: ["shared"]}];
	let reads = 0;
	const f = await fixture(true, false, async () => {if (++reads === 2) {entered.resolve(); await release.promise;} return routes;});
	let runtime: ApiModelRuntime | undefined;
	const request = ApiModelRuntime.prototype.request;
	vi.spyOn(ApiModelRuntime.prototype, "request").mockImplementation(function(...args) {runtime = this; return request.apply(this, args);});
	const pending = f.post(`${kind}/shared`);
	await entered.promise;
	if (!runtime) throw Error("Missing runtime");
	runtime.recordStreamFailure(routes[0]!, `${kind}/shared`, {}, {error: {code: status === 401 ? "invalid_api_key" : "quota_exceeded"}}, {status, headers: new Headers({"retry-after": "60"})});
	release.resolve();
	const denied = await pending;
	await denied.text();
	expect(denied.status).toBe(502);
	expect(f.fetched).toEqual([]);
	expect(f.creates).toEqual([]);
});

it.each(["http", "custom", "native", "http-stream", "native-stream"].flatMap(transport =>
	["workspace", "auth", "cooldown"].filter(kind => !transport.endsWith("stream") || kind === "auth").flatMap(kind =>
		[false, true].map(lossFirst => ({transport, kind, lossFirst})))))
("keeps durable recovery separate from delayed response restrictions (%j)", async ({transport, kind, lossFirst}) => {
	if (kind === "cooldown" && lossFirst && transport !== "custom") vi.useFakeTimers({toFake: ["Date"]});
	const native = transport.startsWith("native"), stream = transport.endsWith("stream");
	const f = await fixture(native), entered = deferred(), release = deferred();
	if (native && kind === "cooldown" && lossFirst) {
		const account = f.manager.getAccountByIndex(0)!;
		f.manager.recordFailure(account, getModelFamily("shared"), "shared");
		f.manager.recordFailure(account, getModelFamily("shared"), "shared");
		expect(getCircuitBreaker(account.circuitKeyId!).getFailureCount()).toBe(2);
	}
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
	if (native) expect(f.creates).toHaveLength(1);
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

it("does not apply an old refusal after a durable expiry-only update", async () => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	f.setPostResponse(async () => {entered.resolve(); await release.promise; return Response.json({error: {code: "token_invalidated"}}, {status: 401});});
	const pending = f.post(); await entered.promise;
	const other = new AccountManager(undefined, (await loadAccounts())!);
	other.getAccountByIndex(0)!.expires += 3600000;
	const expiresAt = other.getAccountByIndex(0)!.expires;
	await other.saveToDisk(); release.resolve();
	await (await pending).text(); await f.manager.flushPendingSave();
	const durable = (await loadAccounts())?.accounts[0];
	expect(durable).toMatchObject({accessToken: "A", refreshToken: "refresh-A", expiresAt});
	expect(durable?.authInvalidatedAt).toBeUndefined();
	expect(durable?.cooldownReason).toBeUndefined();
	expect(f.manager.getAccountByIndex(0)?.authInvalidatedAt).toBeUndefined();
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

it.each(["credential", "expiry"])("rechecks submitted credential generation after final journal observation (%s)", async mutation => {
	const f = await fixture(false), account = f.manager.getAccountByIndex(0)!;
	const submitted = {recordId: account.recordId, accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires, accountId: "W1"};
	const entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const journal = f.manager.isAccountJournalEligible.bind(f.manager);
	vi.spyOn(f.manager, "isAccountJournalEligible").mockImplementation(async candidate => {const eligible = await journal(candidate); entered.resolve(); await release.promise; return eligible;});
	const restrict = vi.fn(() => {f.manager.markAccountCoolingDown(account, 60000, "server-error");});
	const pending = f.manager.withCurrentAccountCredential(account, submitted, restrict);
	await entered.promise;
	if (mutation === "credential") f.manager.updateFromAuth(account, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
	else account.expires = Date.now() + 7200000;
	release.resolve();
	expect(await pending).toBe(false);
	expect(restrict).not.toHaveBeenCalled();
	await f.manager.saveToDisk();
	expect((await loadAccounts())?.accounts[0]?.cooldownReason).toBeUndefined();
});

it.each(["http", "custom", "native"].flatMap(transport => ["auth", "workspace", "quota"].map(failure => ({transport, failure}))))
("isolates delayed restrictions from expiry-only recovery (%j)", async ({transport, failure}) => {
	const f = await fixture(transport === "native"), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const status = failure === "auth" ? 401 : failure === "workspace" ? 402 : 429;
	const terminal = {type: "response.failed", status, response: {id: "old-expiry", status: "failed", error: {code: failure === "auth" ? "token_invalidated" : failure === "workspace" ? "deactivated_workspace" : "usage_limit_reached"}, usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}};
	if (transport === "http") f.setPostResponse(async () => {
		entered.resolve();
		return new Response(new ReadableStream({start(controller) {void release.promise.then(() => {controller.enqueue(Buffer.from(`data: ${JSON.stringify(terminal)}\n\n`)); controller.close();});}}), {headers: {"content-type": "text/event-stream"}});
	});
	else f.setReply(ws => {entered.resolve(); void release.promise.then(() => ws.send(JSON.stringify(terminal)));});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const pending = transport === "http" ? f.post().then(response => response.text()) : turn(await f.connect());
	await entered.promise;
	const current = (await loadAccounts())!;
	const replacement = new AccountManager(undefined, current);
	const expires = f.pool.accounts[0]!.expiresAt! + 3600000;
	replacement.getAccountByIndex(0)!.expires = expires;
	await replacement.saveToDisk();
	f.manager.getAccountByIndex(0)!.expires = expires;
	release.resolve(); await pending;
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	await f.manager.flushPendingSave();
	const saved = (await loadAccounts())!.accounts[0]!;
	expect(saved).toMatchObject({accessToken: "A", refreshToken: "refresh-A", expiresAt: expires});
	expect(saved.authInvalidatedAt).toBeUndefined();
	expect(saved.cooldownReason).toBeUndefined();
	expect(saved.workspaces?.every(workspace => workspace.enabled !== false)).toBe(true);
	expect(Object.values(saved.rateLimitResetTimes ?? {}).some(at => at > Date.now())).toBe(false);
	const rows = (await readUsageLedgerRows()).filter(row => !before.has(row.id));
	expect(rows[0]).toMatchObject({outcome: "failure", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	f.setPostResponse(undefined); f.setReply(undefined);
	const accepted = await f.post(); const body = await accepted.text();
	expect(accepted.status, body).toBe(200);
	expect(f.fetched.at(-1)).toBe("Bearer A");
});

it.each(["header", "event"])("does not admit pending %s quota against an expiry-only replacement", async input => {
	const f = await fixture(true), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const transaction = f.manager.withCurrentAccountCredential.bind(f.manager);
	let held = false;
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		if (!held) {held = true; entered.resolve(); await release.promise;}
		return transaction(...args);
	});
	const completed = {type: "response.completed", response: {id: "old-quota-expiry", status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}};
	const quota = {type: "codex.rate_limits", rate_limits: {primary: {used_percent: 100, reset_after_seconds: 600}}};
	f.setPostResponse(async () => new Response(`${input === "event" ? `data: ${JSON.stringify(quota)}\n\n` : ""}data: ${JSON.stringify(completed)}\n\n`, {headers: {"content-type": "text/event-stream", ...(input === "header" ? {"x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "600"} : {})}}));
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const pending = f.post().then(response => response.text());
	await entered.promise;
	const replacement = new AccountManager(undefined, (await loadAccounts())!);
	const expires = f.pool.accounts[0]!.expiresAt! + 3600000;
	replacement.getAccountByIndex(0)!.expires = expires;
	await replacement.saveToDisk();
	f.manager.getAccountByIndex(0)!.expires = expires;
	f.setPostResponse(undefined);
	const accepted = await f.post(); const body = await accepted.text();
	expect(accepted.status, body).toBe(200);
	expect(f.httpWorkspaces).toEqual(["W1", "W1"]);
	release.resolve(); expect(await pending).toContain('"response.completed"');
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(2));
	await f.manager.flushPendingSave();
	const saved = (await loadAccounts())!.accounts[0]!;
	expect(saved).toMatchObject({accessToken: "A", refreshToken: "refresh-A", expiresAt: expires});
	const rows = (await readUsageLedgerRows()).filter(row => !before.has(row.id));
	expect(new Set(rows.map(row => row.requestId)).size).toBe(2);
	expect(rows.find(row => row.tokens?.totalTokens === 21)).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	const next = await f.post(); await next.text();
	expect(next.status).toBe(200);
	expect(f.httpWorkspaces).toEqual(["W1", "W1", "W1"]);
});

it("does not apply a delayed refresh refusal to an expiry-only replacement", async () => {
	const f = await fixture(false), account = f.manager.getAccountByIndex(0)!;
	account.expires = 0;
	f.pool.accounts[0]!.expiresAt = 0;
	await fs.writeFile(f.path, JSON.stringify(f.pool));
	const entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	vi.spyOn(refreshQueue, "queuedRefresh").mockImplementation(async () => {entered.resolve(); await release.promise; return {type: "failed", reason: "http_error", statusCode: 401, message: "OAuth token has been invalidated"};});
	const pending = refreshRuntime.ensureFreshAccessToken({accountManager: f.manager, account, family: getModelFamily("shared"), model: "shared", now: Date.now(), tokenRefreshSkewMs: 30000, tokenInvalidationCooldownMs: 60000});
	await entered.promise;
	const replacement = new AccountManager(undefined, (await loadAccounts())!);
	replacement.getAccountByIndex(0)!.expires = Date.now() + 7200000;
	await replacement.saveToDisk();
	release.resolve();
	expect(await pending).toMatchObject({ok: false, retryable: true, invalidated: false});
	expect(account.cooldownReason).toBeUndefined();
	expect((await loadAccounts())!.accounts[0]!.authInvalidatedAt).toBeUndefined();
});

it.each(["http-server", "http-network", "http-stream", "http-quota", "custom-server", "custom-quota", "custom-close", "custom-handshake"].flatMap(mode =>
	["same", "local", "durable"].flatMap(recovery => (mode.startsWith("http") ? [false, true] : [false]).map(native => ({mode, recovery, native})))))
("attributes delayed server, quota and transport restrictions to the submitted generation (%j)", async ({mode, recovery, native}) => {
	const handshake = mode === "custom-handshake";
	const f = await fixture(native, handshake, undefined, handshake ? 503 : false);
	const entered = handshake ? f.entered : deferred(), release = handshake ? f.release : deferred();
	cleanups.push(async () => {release.resolve();});
	const quota = mode.endsWith("quota"), server = mode.endsWith("server") || handshake;
	const status = quota ? 429 : 503;
	if (mode.startsWith("http")) f.setPostResponse(async () => {
		entered.resolve();
		if (mode === "http-stream") return new Response(new ReadableStream({start(controller) {
			controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"A"}}\n\n'));
			void release.promise.then(() => controller.error(Error("fixture stream failure")));
		}}), {headers: {"content-type": "text/event-stream"}});
		await release.promise;
		if (mode === "http-network") throw Error("fixture network failure");
		return Response.json({error: {code: quota ? "usage_limit_reached" : "server_error"}}, {status, headers: quota ? {"retry-after": "60"} : {}});
	});
	else if (!handshake) f.setReply(ws => {
		entered.resolve();
		if (mode === "custom-close") ws.send(JSON.stringify({type: "response.created", response: {id: "A"}}));
		void release.promise.then(() => {
			if (mode === "custom-close") ws.close();
			else ws.send(JSON.stringify({type: "response.failed", response: {id: "A", status: "failed", error: {code: quota ? "usage_limit_reached" : "server_error"}, usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}, status}));
		});
	});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const pending = mode.startsWith("http") ? f.post().then(response => response.text()).catch(() => undefined) : turn(await f.connect());
	await entered.promise;
	if (recovery !== "same") {
		const manager = recovery === "local" ? f.manager : new AccountManager(undefined, (await loadAccounts())!);
		manager.updateFromAuth(manager.getAccountByIndex(0)!, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
		await manager.saveToDisk();
		f.setPostResponse(undefined);
	}
	release.resolve(); await pending;
	await vi.waitFor(async () => {
		const rows = (await readUsageLedgerRows()).filter(row => !before.has(row.id));
		expect(rows).toHaveLength(1);
	});
	await f.manager.flushPendingSave();
	const account = (await loadAccounts())?.accounts[0];
	const expected = quota ? undefined : server ? "server-error" : "network-error";
	if (recovery === "same") {
		if (quota && native) {
			const denied = await f.post(); await denied.text();
			expect(denied.status).toBe(503);
			expect(f.httpWorkspaces).toEqual(["W1", "W2"]);
			expect(account?.rateLimitResetTimes ?? {}).toEqual({});
		} else if (quota) expect(Object.values(account?.rateLimitResetTimes ?? {}).some(at => at > Date.now())).toBe(true);
		else expect(account?.cooldownReason).toBe(expected);
	} else {
		expect(account).toMatchObject({accessToken: "B", refreshToken: "refresh-B"});
		expect(account?.cooldownReason).toBeUndefined();
		expect(Object.values(account?.rateLimitResetTimes ?? {}).some(at => at > Date.now())).toBe(false);
		const current = new AccountManager(undefined, (await loadAccounts())!);
		expect(current.getAccountRuntimeSkipReason(0, getModelFamily("shared"), "shared")).toBeNull();
	}
	if (mode === "custom-server" || mode === "custom-quota") {
		const row = (await readUsageLedgerRows()).find(row => !before.has(row.id));
		expect(row).toMatchObject({outcome: "failure", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	}
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

it.each(["quota", "scheduler", "circuit", "revoked", "journal", "reset"])("rechecks native %s authority after a delayed real handshake", async mutation => {
	const f = await fixture(true, true);
	if (mutation === "quota") {
		f.manager.disableWorkspace(f.manager.getAccountByIndex(0)!, "W2");
		await f.manager.saveToDisk();
	}
	const ws = await f.connect();
	const result = turn(ws);
	await f.entered.promise;
	const account = f.manager.getAccountByIndex(0)!;
	if (mutation === "quota") {
		f.rejectQuota();
		const concurrent = await f.post(); await concurrent.text();
		expect(concurrent.status).toBe(503);
		expect(f.httpWorkspaces).toEqual(["W1"]);
	}
	if (mutation === "scheduler") vi.spyOn(PreemptiveQuotaScheduler.prototype, "getDeferral").mockReturnValue({defer: true, waitMs: 60000});
	if (mutation === "circuit") for (let i = 0; i < 3; i++) f.manager.recordFailure(account, "codex", "shared");
	if (mutation === "revoked") await recordPendingAuth(f.path, {recordId: "R1", priorRefreshToken: "refresh-A", refreshToken: "refresh-A", accessToken: "A", expiresAt: account.expires!, enabled: false, authInvalidatedAt: 5000, at: 1});
	if (mutation === "reset") await fs.writeFile(`${f.path}.reset-intent`, "{}");
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

it.each(["http", "custom", "native"])("keeps an already-sent completion out of another half-open epoch (%s)", async transport => {
	const f = await fixture(transport === "native");
	const aEntered = deferred(), aRelease = deferred(), bEntered = deferred(), bRelease = deferred();
	cleanups.push(async () => {aRelease.resolve(); bRelease.resolve();});
	let sends = 0;
	const complete = (id: string) => ({type: "response.completed", response: {id, status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
	if (transport === "http") f.setPostResponse(async () => {
		const first = ++sends === 1, entered = first ? aEntered : bEntered, release = first ? aRelease : bRelease;
		return new Response(new ReadableStream({start(controller) {
			entered.resolve();
			void release.promise.then(() => {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(complete(first ? "A" : "B"))}\n\n`));
				controller.close();
			});
		}}), {headers: {"content-type": "text/event-stream"}});
	});
	else f.setReply(ws => {const first = ++sends === 1; (first ? aEntered : bEntered).resolve(); void (first ? aRelease : bRelease).promise.then(() => ws.send(JSON.stringify(complete(first ? "A" : "B"))));});
	const rowsBefore = (await readUsageLedgerRows()).length;
	const post = () => f.post().then(async response => {const body = await response.text(); expect(response.status, body).toBe(200);});
	const a = transport === "http" ? post() : turn(await f.connect());
	await aEntered.promise;
	const account = f.manager.getAccountByIndex(0)!, breaker = getCircuitBreaker(account.circuitKeyId!);
	for (let i = 0; i < 3; i++) breaker.recordFailure();
	const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 30001);
	const b = transport === "http" ? post() : turn(await f.connect());
	void b.catch(() => undefined);
	await bEntered.promise;
	expect(breaker.getState()).toBe("half-open");
	aRelease.resolve(); await a;
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).length).toBe(rowsBefore + 1));
	expect(breaker.getState()).toBe("half-open");
	expect(breaker.isAvailable()).toBe(false);
	bRelease.resolve(); await b;
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).length).toBe(rowsBefore + 2));
	expect(breaker.getState()).toBe("closed");
	const rows = (await readUsageLedgerRows()).slice(rowsBefore);
	expect(rows.map(row => ({outcome: row.outcome, input: row.tokens.inputTokens, output: row.tokens.outputTokens, total: row.tokens.totalTokens}))).toEqual([
		{outcome: "success", input: 17, output: 4, total: 21}, {outcome: "success", input: 17, output: 4, total: 21},
	]);
	expect(sends).toBe(2);
});

it.each(["http", "custom", "native"])("records terminal usage even if restriction persistence cannot observe the journal (%s)", async transport => {
	const f = await fixture(transport === "native"), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const terminal = {type: "response.failed", response: {id: "invalid-A", status: "failed", error: {code: "token_invalidated", message: "OAuth token invalidated"}, usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}};
	let sends = 0;
	if (transport === "http") f.setPostResponse(async () => {
		sends++; entered.resolve();
		return new Response(new ReadableStream({start(controller) {
			void release.promise.then(() => {controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`)); controller.close();});
		}}), {headers: {"content-type": "text/event-stream"}});
	});
	else f.setReply(ws => {sends++; entered.resolve(); void release.promise.then(() => ws.send(JSON.stringify(terminal)));});
	const priorRows = await readUsageLedgerRows(), before = priorRows.length;
	const priorIds = new Set(priorRows.map(row => row.id));
	const result = transport === "http" ? f.post().then(response => response.text()) : turn(await f.connect());
	void result.catch(() => undefined);
	await entered.promise;
	await fs.writeFile(getPendingAuthPath(f.path), "invalid terminal fixture journal");
	release.resolve(); await result;
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).length).toBe(before + 1));
	const newRows = (await readUsageLedgerRows()).filter(row => !priorIds.has(row.id));
	expect(newRows).toHaveLength(1);
	const row = newRows[0]!;
	expect(row).toMatchObject({outcome: "failure", errorCode: transport === "http" ? "upstream_response_failed" : "token_invalidated", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(row.account?.accountHash).toBeTruthy();
	const blocked = await f.post();
	expect(blocked.status).not.toBe(200); await blocked.text();
	expect(sends).toBe(1);
});

it.each([false, true].flatMap(sawEvent => ["success", "reject", "stale"].flatMap(restriction => ["client", "cancel", "shutdown", "reject"].map(ending => ({sawEvent, restriction, ending})))))
("retains sent custom accounting through an interrupted close wait (%j)", async ({sawEvent, restriction, ending}) => {
	const f = await fixture(false), entered = deferred(), release = deferred(), finished = deferred();
	cleanups.push(async () => {release.resolve();});
	const actual = f.manager.withCurrentAccountCredential.bind(f.manager);
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		entered.resolve(); await release.promise;
		try {if (restriction === "reject") throw Error("fixture restriction failure"); return await actual(...args);}
		finally {finished.resolve();}
	});
	f.setReply(ws => {if (sawEvent) ws.send(JSON.stringify({type: "response.created", response: {id: "active-A"}})); ws.close();});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const ws = await f.connect();
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	await entered.promise;
	if (restriction === "stale") {
		const other = new AccountManager(undefined, (await loadAccounts())!);
		other.updateFromAuth(other.getAccountByIndex(0)!, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
		await other.saveToDisk();
	}
	if (ending === "client") {const closed = once(ws, "close"); ws.close(); await closed;}
	if (ending === "cancel") ws.send(JSON.stringify({type: "response.cancel"}));
	if (ending === "shutdown") await f.proxy.close();
	if (ending === "reject") {const closed = once(ws, "close"); for (let i = 0; i < 32; i++) ws.send("{}"); await closed;}
	try {
		await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
		const row = (await readUsageLedgerRows()).find(row => !before.has(row.id));
		expect(row).toMatchObject({outcome: ending === "reject" ? "failure" : "cancelled", account: {index: 0}});
		expect(row?.account?.accountHash).toBeTruthy();
	} finally {release.resolve(); await finished.promise;}
	await new Promise(resolve => setTimeout(resolve, 20));
	expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1);
	expect(f.creates).toHaveLength(1);
	expect(f.connections()).toBe(1);
	if (restriction === "stale") expect((await loadAccounts())?.accounts[0]).toMatchObject({accessToken: "B", refreshToken: "refresh-B"});
});

it("retains original cancellation accounting during a synchronous send failure", async () => {
	const f = await fixture(false), entered = deferred(), release = deferred(), finished = deferred();
	cleanups.push(async () => {release.resolve();});
	const restrict = f.manager.withCurrentAccountCredential.bind(f.manager);
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		entered.resolve(); await release.promise;
		try {return await restrict(...args);} finally {finished.resolve();}
	});
	const send = WebSocket.prototype.send;
	vi.spyOn(WebSocket.prototype, "send").mockImplementation(function(this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
		if (this.url?.startsWith(f.upstreamBaseUrl.replace("http:", "ws:"))) throw Error("fixture synchronous upstream send failure");
		return send.apply(this, args);
	});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const ws = await f.connect();
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	await entered.promise;
	const closed = once(ws, "close"); ws.close(); await closed;
	try {
		await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
		expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "cancelled", account: {index: 0}});
	} finally {release.resolve(); await finished.promise;}
	await new Promise(resolve => setTimeout(resolve, 20));
	expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1);
	expect(f.creates).toHaveLength(0);
});

it.each([401, 429, 503])("retains handshake accounting while its failed restriction waits (%s)", async status => {
	const f = await fixture(false, false, undefined, status), entered = deferred(), release = deferred(), finished = deferred();
	cleanups.push(async () => {release.resolve();});
	const restrict = f.manager.withCurrentAccountCredential.bind(f.manager);
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		entered.resolve(); await release.promise;
		try {return await restrict(...args);} finally {finished.resolve();}
	});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const ws = await f.connect();
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	await entered.promise;
	const closed = once(ws, "close"); ws.close(); await closed;
	try {
		await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
		expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "cancelled", account: {index: 0}});
	} finally {release.resolve(); await finished.promise;}
	await new Promise(resolve => setTimeout(resolve, 20));
	expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1);
	expect(f.creates).toHaveLength(0);
});

it("retains the submitted account while a dispatched custom disconnect settles", async () => {
	vi.stubEnv("CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS", "0");
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const ws = await f.connect(), before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const restriction = f.manager.withCurrentAccountCredential.bind(f.manager);
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {entered.resolve(); await release.promise; return restriction(...args);});
	f.setReply(socket => {socket.close();});
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	await entered.promise;
	const closed = once(ws, "close"); ws.close(); await closed;
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "cancelled", account: {index: 0}});
	release.resolve();
	await new Promise(resolve => setTimeout(resolve, 20));
	expect(f.creates).toHaveLength(1);
	expect(f.connections()).toBe(1);
	expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1);
});

it.each(["independent", "continuation", "stale"])("retains submitted custom accounting and independent continuation controls (%s)", async mode => {
	vi.stubEnv("CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS", "0");
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const ws = await f.connect();
	const initialRows = new Set((await readUsageLedgerRows()).map(row => row.id));
	const first = mode === "continuation" ? await turn(ws) : undefined;
	if (first) await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !initialRows.has(row.id))).toHaveLength(1));
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const actual = f.manager.withCurrentAccountCredential.bind(f.manager);
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {entered.resolve(); await release.promise; return actual(...args);});
	f.setReply(socket => {socket.close();});
	const pending = turn(ws, first ? {previous_response_id: first.response.id} : {});
	await entered.promise;
	f.setReply(undefined);
	if (mode === "stale") {
		const other = new AccountManager(undefined, (await loadAccounts())!);
		other.updateFromAuth(other.getAccountByIndex(0)!, {type: "oauth", access: "B", refresh: "refresh-B", expires: Date.now() + 7200000});
		await other.saveToDisk();
	}
	release.resolve();
	const result = await pending;
	expect(result.type).toBe("error");
	if (mode === "independent") expect(result.error.code).toBe("upstream_websocket_closed");
	if (mode === "continuation") expect(result.error.code).toBe("upstream_websocket_closed");
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	const row = (await readUsageLedgerRows()).find(row => !before.has(row.id));
	expect(row).toMatchObject({outcome: "failure", account: {index: 0}});
	expect(f.creates).toHaveLength(mode === "continuation" ? 2 : 1);
	if (mode !== "stale") {
		const later = await turn(ws);
		expect(later.type).toBe("response.completed");
		await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(2));
		expect(f.creates).toHaveLength(mode === "continuation" ? 3 : 2);
		expect((await readUsageLedgerRows()).filter(row => !before.has(row.id)).map(record => record.outcome)).toEqual(["failure", "success"]);
	}
});

it.each(["header", "near", "event"].flatMap(boundary => ["journal", "persist"].flatMap(failure => [false, true].map(native => ({boundary, failure, native})))))
("consumes original quota response usage despite durability failure (%j)", async ({boundary, failure, native}) => {
	const f = await fixture(native, false, undefined, false, 5);
	if (native) {
		f.manager.disableWorkspace(f.manager.getAccountByIndex(0)!, "W2");
		await f.manager.saveToDisk();
	}
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const heals = vi.spyOn(f.manager, "recordSuccess"), contextUpdates = vi.spyOn(ContextBudgetGuard.prototype, "update");
	let healsAtSend = 0, consumed = false, restrictions = 0;
	const actual = f.manager.withCurrentAccountCredential.bind(f.manager);
	const rename = fs.rename.bind(fs);
	const fail = async () => {
		if (failure === "journal") await fs.writeFile(getPendingAuthPath(f.path), "fixture corrupt quota journal");
		else vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
			if (String(args[1]) === f.path) throw Object.assign(Error("fixture quota persistence failed"), {code: "EIO"});
			return rename(...args);
		});
	};
	if (boundary === "near") vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		restrictions++;
		if (restrictions === 1) {const result = await actual(...args); await fail(); return result;}
		return actual(...args);
	});
	const terminal = {type: "response.completed", response: {id: "quota-A", status: "completed", output: [], service_tier: "priority", usage: {input_tokens: 17, output_tokens: 6, total_tokens: 23, input_tokens_details: {cached_tokens: 3}, output_tokens_details: {reasoning_tokens: 2}}}};
	const quota = {type: "codex.rate_limits", rate_limits: {primary: {used_percent: 99, reset_at: Math.floor(Date.now() / 1000) + 60}}};
	f.setPostResponse(async () => {
		healsAtSend = heals.mock.calls.length;
		if (boundary !== "near") await fail();
		let sent = false;
		return new Response(new ReadableStream({pull(controller) {
			if (!sent) {sent = true; controller.enqueue(new TextEncoder().encode(`${boundary === "event" ? `data: ${JSON.stringify(quota)}\n\n` : ""}data: ${JSON.stringify(terminal)}\n\n`));}
			else {consumed = true; controller.close();}
		}}), {headers: {"content-type": "text/event-stream", ...(boundary !== "event" ? {"x-codex-primary-used-percent": "99", "x-codex-primary-reset-after-seconds": "60"} : {})}});
	});
	const response = await f.post("shared", "fixture-quota-session"), body = await response.text();
	expect(response.status, body).toBe(200);
	expect(body).toContain('"response.completed"');
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	const row = (await readUsageLedgerRows()).find(row => !before.has(row.id));
	expect(row).toMatchObject({outcome: "success", statusCode: 200, account: {index: 0}, tokens: {serviceTier: "priority", inputTokens: 17, outputTokens: 4, cachedInputTokens: 3, reasoningTokens: 2, totalTokens: 23}});
	expect(consumed).toBe(true);
	expect(heals).toHaveBeenCalledTimes(healsAtSend);
	expect(contextUpdates).toHaveBeenCalledWith("fixture-quota-session", expect.objectContaining({model: "shared", contextTokens: 21}));
	const sends = f.fetched.length;
	const blocked = await f.post(); await blocked.text();
	expect(blocked.status).not.toBe(200);
	expect(f.fetched).toHaveLength(sends);
});

it.each([200, 400, 401, 402, 403, 429, 503])("consumes non-SSE quota response accounting before reporting durability failure (%s)", async status => {
	const f = await fixture(false);
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let consumed = false;
	f.setPostResponse(async () => {
		await fs.writeFile(getPendingAuthPath(f.path), "fixture corrupt non-SSE quota journal");
		let sent = false;
		return new Response(new ReadableStream({pull(controller) {
			if (!sent) {sent = true; controller.enqueue(new TextEncoder().encode(JSON.stringify({object: "response", status: status === 200 ? "completed" : "failed", error: status === 200 ? undefined : {code: "fixture_error"}, service_tier: "priority", usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}})));}
			else {consumed = true; controller.close();}
		}}), {status, headers: {"content-type": "application/json", "x-codex-primary-used-percent": "99", "x-codex-primary-reset-after-seconds": "60"}});
	});
	const response = await f.post(); await response.text();
	expect(response.status).toBe(status);
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: status === 200 ? "success" : "failure", statusCode: status, account: {index: 0}, tokens: {serviceTier: "priority", inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(consumed).toBe(true);
	expect(f.fetched).toEqual(["Bearer A"]);
});

it.each([401, 403, 429, 503])("consumes error usage when its own restriction fails without quota headers (%s)", async status => {
	const f = await fixture(false), before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let consumed = false;
	f.setPostResponse(async () => {
		await fs.writeFile(getPendingAuthPath(f.path), "fixture corrupt error restriction journal");
		let sent = false;
		return new Response(new ReadableStream({pull(controller) {
			if (!sent) {sent = true; controller.enqueue(new TextEncoder().encode(JSON.stringify({error: {code: status === 403 ? "workspace_disabled" : "fixture_error"}, service_tier: "priority", usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}})));}
			else {consumed = true; controller.close();}
		}}), {status, headers: {"content-type": "application/json"}});
	});
	const response = await f.post(); await response.text();
	expect(response.status).toBe(status);
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "failure", statusCode: status, account: {index: 0}, tokens: {serviceTier: "priority", inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(consumed).toBe(true);
	expect(f.fetched).toEqual(["Bearer A"]);
});

it.each([403, 404, 503].flatMap(status => ["get", "set"].map(operation => ({status, operation}))))
("consumes original error usage before thread goal fallback with failed quota (%j)", async ({status, operation}) => {
	const f = await fixture(false), before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let consumed = false;
	f.setPostResponse(async () => {
		await fs.writeFile(getPendingAuthPath(f.path), "fixture corrupt goal quota journal");
		let sent = false;
		return new Response(new ReadableStream({pull(controller) {
			if (!sent) {sent = true; controller.enqueue(new TextEncoder().encode(JSON.stringify({error: {code: "fixture_goal_error"}, usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}})));}
			else {consumed = true; controller.close();}
		}}), {status, headers: {"content-type": "application/json", "x-codex-primary-used-percent": "99"}});
	});
	const response = await fetch(`${f.proxy.baseUrl}/thread/goal/${operation}`, {method: "POST", headers: {authorization: "Bearer fixture-client", "content-type": "application/json"}, body: JSON.stringify({thread_id: "fixture-thread", goal: "fixture-goal"})});
	const body = await response.json();
	expect(response.status).toBe(operation === "get" || status === 403 ? 200 : status);
	if (operation === "get") expect(body).toEqual({goal: null});
	if (operation === "set" && status === 403) expect(body).toEqual({ok: true, goal: "fixture-goal"});
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "failure", statusCode: status, account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(consumed).toBe(true);
	expect(f.fetched).toEqual(["Bearer A"]);
});

it.each([
	{status: 403, code: "workspace_disabled"},
	{status: 402, code: "deactivated_workspace"},
	{status: 404, code: "model_not_found"},
	{status: 400, code: "unsupported_value", param: "reasoning.effort"},
	{status: 400, code: "unsupported_parameter", param: "service_tier"},
])("retains native handshake decisions and recovers only through an eligible sibling (%j)", async ({status, code, ...setting}) => {
	const f = await fixture(true, false, undefined, {status, error: {code, ...setting, message: "fixture credential-secret diagnosis"}, workspace: "W1"});
	const ws = await f.connect();
	const result = await turn(ws, {reasoning: {effort: "high"}, service_tier: "priority"});
	expect(result, JSON.stringify(result)).toMatchObject({type: "response.completed"});
	expect(f.creates.map(create => create.workspace)).toEqual(["W2"]);
	expect(f.fetched).toEqual([]);
	await vi.waitFor(async () => expect((await loadAccounts())?.accounts[0]?.workspaces?.find(workspace => workspace.id === "W1")?.enabled).toBe([402, 403].includes(status) ? false : true));
	expect(await turn(ws, {reasoning: {effort: "high"}, service_tier: "priority"})).toMatchObject({type: "response.completed"});
	expect(f.creates.map(create => create.workspace)).toEqual(["W2", "W2"]);
	expect(f.fetched).toEqual([]);
});

it("consumes native gateway quota usage without ambiguous replay or health healing", async () => {
	const f = await fixture(true), heals = vi.spyOn(f.manager, "recordSuccess");
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let healsAtSend = 0;
	f.setReply(socket => {
		healsAtSend = heals.mock.calls.length;
		void fs.writeFile(getPendingAuthPath(f.path), "fixture corrupt native gateway journal").then(() => {
			socket.send(JSON.stringify({type: "codex.rate_limits", rate_limits: {primary: {used_percent: 99}}}));
			socket.send(JSON.stringify({type: "response.completed", response: {id: "native-A", status: "completed", output: [], service_tier: "priority", usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}}));
		});
	});
	const ws = await f.connect();
	const terminal = new Promise<Record<string, unknown>>(resolve => {ws.on("message", data => {
		const event = JSON.parse(String(data));
		if (event.type === "response.completed" || event.type === "error") resolve(event);
	});});
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	expect((await terminal).type).toBe("response.completed");
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "success", account: {index: 0}, tokens: {serviceTier: "priority", inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(heals).toHaveBeenCalledTimes(healsAtSend);
	expect(await turn(ws)).toMatchObject({type: "error"});
	expect(f.creates).toHaveLength(1);
	expect(f.connections()).toBe(1);
	expect(f.fetched).toHaveLength(0);
});

it.each(["primary", "secondary"].flatMap(window => ["http", "websocket"].map(transport => ({window, transport}))))
("keeps native workspace exhaustion isolated from its healthy sibling (%j)", async ({window, transport}) => {
	const f = await fixture(true), before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const quota = {type: "codex.rate_limits", rate_limits: {[window]: {used_percent: 100, reset_at: Math.floor(Date.now() / 1000) + 600}}};
	let count = 0;
	const completed = () => ({type: "response.completed", response: {id: `scope-${++count}`, status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
	f.setReply(ws => {if (!count) ws.send(JSON.stringify(quota)); ws.send(JSON.stringify(completed()));});
	f.setPostResponse(async () => new Response((!count ? `data: ${JSON.stringify(quota)}\n\n` : "") + `data: ${JSON.stringify(completed())}\n\n`, {headers: {"content-type": "text/event-stream"}}));
	const ws = transport === "websocket" ? await f.connect() : undefined;
	const dispatch = async () => {
		if (ws) {
			const result = new Promise<Record<string, unknown>>(resolve => {
				const receive = (data: RawData) => {
					const event = JSON.parse(String(data));
					if (event.type === "response.completed" || event.type === "error") {ws.off("message", receive); resolve(event);}
				};
				ws.on("message", receive);
			});
			ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
			return result;
		}
		const response = await f.post(), body = await response.text();
		return {type: response.ok && body.includes('"response.completed"') ? "response.completed" : "error"};
	};
	expect(await dispatch()).toMatchObject({type: "response.completed"});
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "success", tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(await dispatch()).toMatchObject({type: "response.completed"});
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(2));
	expect(ws ? f.creates.map(create => create.workspace) : f.httpWorkspaces).toEqual(["W1", "W2"]);
	for (const row of (await readUsageLedgerRows()).filter(row => !before.has(row.id))) expect(row).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect((await loadAccounts())?.accounts[0]?.rateLimitResetTimes ?? {}).toEqual({});
});

it("tries the healthy native workspace after a workspace-local HTTP quota rejection", async () => {
	const f = await fixture(true), before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let count = 0;
	f.setPostResponse(async () => ++count === 1 ? Response.json({error: {code: "usage_limit_reached"}}, {status: 429, headers: {"retry-after": "60"}}) : new Response('data: {"type":"response.completed","response":{"id":"healthy-sibling","status":"completed","output":[],"usage":{"input_tokens":17,"output_tokens":4,"total_tokens":21}}}\n\n', {headers: {"content-type": "text/event-stream"}}));
	const response = await f.post(), body = await response.text();
	expect(response.status, body).toBe(200);
	expect(body).toContain('"response.completed"');
	expect(f.httpWorkspaces).toEqual(["W1", "W2"]);
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "success", tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect((await loadAccounts())?.accounts[0]?.rateLimitResetTimes ?? {}).toEqual({});
});

it("coalesces held quota observations while preserving original terminal accounting", async () => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const restriction = vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async () => {
		entered.resolve(); await release.promise; throw Error("fixture first coalesced quota failure");
	});
	f.setPostResponse(async () => new Response(
		Array.from({length: 128}, (_, i) => `data: ${JSON.stringify({type: "codex.rate_limits", rate_limits: {primary: {used_percent: 90 + i % 10}}})}\n\n`).join("") +
		'data: {"type":"response.completed","response":{"id":"coalesced-A","status":"completed","output":[],"usage":{"input_tokens":17,"output_tokens":4,"total_tokens":21}}}\n\n',
		{headers: {"content-type": "text/event-stream"}},
	));
	const body = f.post().then(response => response.text());
	await entered.promise;
	expect(await body).toContain('"response.completed"');
	expect(restriction).toHaveBeenCalledTimes(1);
	release.resolve();
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(f.proxy.getStatus().lastError).toBe("fixture first coalesced quota failure");
	expect(restriction).toHaveBeenCalledTimes(2);
});

it("retains quota-failed partial usage when the client cancels the HTTP body", async () => {
	const f = await fixture(false);
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let cancelled = false;
	f.setPostResponse(async () => {
		await fs.writeFile(getPendingAuthPath(f.path), "fixture corrupt cancelled quota journal");
		return new Response(new ReadableStream({start(controller) {
			controller.enqueue(new TextEncoder().encode('data: {"type":"response.in_progress","response":{"id":"partial-A","usage":{"input_tokens":7,"output_tokens":0,"total_tokens":7}}}\n\n'));
		}, cancel() {cancelled = true;}}), {headers: {"content-type": "text/event-stream", "x-codex-primary-used-percent": "99"}});
	});
	const response = await f.post(), reader = response.body!.getReader();
	expect(response.status).toBe(200);
	expect((await reader.read()).done).toBe(false);
	await reader.cancel();
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "cancelled", statusCode: 200, account: {index: 0}, tokens: {inputTokens: 7, outputTokens: 0, totalTokens: 7}});
	expect(cancelled).toBe(true);
	const denied = await f.post(); await denied.text();
	expect(denied.status).not.toBe(200);
	expect(f.fetched).toHaveLength(1);
});

it("does not drain a closing channel before its terminal restriction settles", async () => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const restrict = f.manager.withCurrentAccountCredential.bind(f.manager);
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {entered.resolve(); await release.promise; return restrict(...args);});
	f.setReply(ws => {ws.send(JSON.stringify({type: "response.failed", status: 503, response: {id: "A", status: "failed", error: {code: "server_error"}}})); ws.close();});
	const ws = await f.connect(), first = turn(ws);
	await entered.promise; await first;
	const queued = turn(ws);
	await new Promise(resolve => setTimeout(resolve, 20));
	expect(f.connections()).toBe(1);
	release.resolve();
	expect(await queued).toMatchObject({type: "error"});
	expect(f.creates).toHaveLength(1);
});

it.each(["terminal", "close-before-event", "close-after-event"])("settles custom transport failure despite a restriction transaction error (%s)", async mode => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const terminal = {type: "response.failed", status: 503, response: {id: "failed-A", status: "failed", error: {code: "server_error"}, usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}};
	f.setReply(ws => {
		entered.resolve();
		if (mode === "close-after-event") ws.send(JSON.stringify({type: "response.created", response: {id: "A"}}));
		void release.promise.then(() => {if (mode === "terminal") ws.send(JSON.stringify(terminal)); else ws.close();});
	});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const ws = await f.connect(), pending = turn(ws);
	await entered.promise;
	await fs.writeFile(getPendingAuthPath(f.path), "fixture unreadable journal");
	release.resolve(); await pending;
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	const row = (await readUsageLedgerRows()).find(row => !before.has(row.id));
	expect(row).toMatchObject({outcome: "failure", account: {index: 0}});
	if (mode === "terminal") expect(row?.tokens).toMatchObject({inputTokens: 17, outputTokens: 4, totalTokens: 21});
	const blocked = await f.post(); await blocked.text();
	expect(blocked.status).not.toBe(200);
	expect(f.creates).toHaveLength(1);
});

it.each(["http", "sse"].flatMap(mode => [false, true].map(replace => ({mode, replace}))))("scopes late capability denial to its submitted credentials (%j)", async ({mode, replace}) => {
	const f = await fixture(true, false, undefined, true), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const account = f.manager.getAccountByIndex(0)!;
	account.workspaces!.splice(1);
	await f.manager.saveToDisk();
	let sends = 0;
	f.setPostResponse(async () => {
		if (++sends > 1) return new Response('data: {"type":"response.completed","response":{"id":"B","status":"completed","output":[]}}\n\n', {headers: {"content-type": "text/event-stream"}});
		entered.resolve(); await release.promise;
		const error = {code: "model_not_supported", message: "Model unavailable for credential A"};
		return mode === "http" ? Response.json({error}, {status: 400}) : new Response(`data: ${JSON.stringify({type: "response.failed", response: {id: "A", status: "failed", error}})}\n\n`, {headers: {"content-type": "text/event-stream"}});
	});
	const a = f.post().then(async response => ({status: response.status, body: await response.text()}));
	void a.catch(() => undefined); await entered.promise;
	if (replace) {
		f.manager.updateFromAuth(account, {type: "oauth", access: "B", refresh: "refresh-B", expires: account.expires!});
		await f.manager.saveToDisk();
	}
	release.resolve(); await a;
	const b = await f.post(); const body = await b.text();
	expect(b.status, body).toBe(replace ? 200 : 403);
	expect(body).toContain(replace ? '"response.completed"' : '"model_not_available_in_account_catalog"');
	expect(f.fetched).toEqual(replace ? ["Bearer A", "Bearer B"] : ["Bearer A"]);
	expect(sends).toBe(replace ? 2 : 1);
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

it.each(["primary", "secondary"])("checkpoint preserves pending independent %s quota exhaustion before the next native create", async exhausted => {
	const f = await fixture(true), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const account = f.manager.getAccountByIndex(0)!;
	account.workspaces!.splice(1);
	await f.manager.saveToDisk();
	const original = f.manager.withCurrentAccountCredential.bind(f.manager);
	let held = false;
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		if (!held) {held = true; entered.resolve(); await release.promise;}
		return original(...args);
	});
	let upstream: WebSocket | undefined;
	f.setReply(ws => {upstream = ws; ws.send(JSON.stringify({type: "codex.rate_limits", rate_limits: {[exhausted === "primary" ? "secondary" : "primary"]: {used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 600}}}));});
	const rowsBefore = new Set((await readUsageLedgerRows()).map(row => row.id));
	const ws = await f.connect();
	const terminal = new Promise<Record<string, unknown>>(resolve => ws.on("message", data => {const event = JSON.parse(String(data)); if (event.type === "response.completed" || event.type === "error") resolve(event);}));
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	await entered.promise;
	if (!upstream) throw Error("Fixture upstream missing");
	upstream.send(JSON.stringify({type: "codex.rate_limits", plan_type: "pro", rate_limits: {[exhausted]: {used_percent: 100, reset_at: Math.floor(Date.now() / 1000) + 600}}}));
	upstream.send(JSON.stringify({type: "codex.rate_limits", rate_limits: {[exhausted === "primary" ? "secondary" : "primary"]: {used_percent: 20, reset_at: Math.floor(Date.now() / 1000) + 600}}}));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(3));
	upstream.send(JSON.stringify({type: "response.completed", response: {id: "quota-A", status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}}));
	release.resolve();
	expect((await terminal).type).toBe("response.completed");
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !rowsBefore.has(row.id))).toHaveLength(1));
	const row = (await readUsageLedgerRows()).find(row => !rowsBefore.has(row.id))!;
	expect(row).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	f.setReply(ws => ws.send(JSON.stringify({type: "response.completed", response: {id: "unexpected-next", status: "completed", output: []}})));
	expect(await turn(ws)).toMatchObject({type: "error"});
	expect(f.creates).toHaveLength(1);
});



it.each(["primary", "secondary"].flatMap(exhausted =>
	["native", "http-native", "http-custom"].flatMap(transport =>
		["pending", "consumed", "header", "replacement"]
			.filter(sequence => transport !== "native" || (sequence !== "pending" && sequence !== "header"))
			.map(sequence => ({exhausted, transport, sequence})))))
("retains response-local independent quota fields across partial observations (%j)", async ({exhausted, transport, sequence}) => {
	const f = await fixture(transport !== "http-custom"), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const account = f.manager.getAccountByIndex(0)!;
	account.workspaces!.splice(1);
	await f.manager.saveToDisk();
	const resetAt = Math.floor(Date.now() / 1000) + 600;
	const other = exhausted === "primary" ? "secondary" : "primary";
	const quota = (window: string, used: number, reset = true) => ({
		type: "codex.rate_limits",
		rate_limits: {[window]: {used_percent: used, ...(reset ? {reset_at: resetAt} : {})}},
	});
	const original = f.manager.withCurrentAccountCredential.bind(f.manager);
	let started = 0, completed = 0;
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		if (++started === (sequence === "header" ? 2 : 1)) {entered.resolve(); await release.promise;}
		const result = await original(...args);
		completed++;
		return result;
	});
	const scheduler = vi.spyOn(PreemptiveQuotaScheduler.prototype, "update");
	let send: (event: Record<string, unknown>) => void = () => {throw Error("Fixture upstream missing");};
	const firstEvent = quota(sequence === "pending" ? other : exhausted, sequence === "pending" ? 10 : 100);
	let socket: WebSocket | undefined;
	let result: Promise<unknown>;
	const rowsBefore = new Set((await readUsageLedgerRows()).map(row => row.id));
	if (transport === "native") {
		f.setReply(ws => {send = event => ws.send(JSON.stringify(event)); send(firstEvent);});
		socket = await f.connect();
		result = new Promise(resolve => socket!.on("message", data => {
			const event = JSON.parse(String(data));
			if (event.type === "response.completed" || event.type === "error") resolve(event);
		}));
		socket.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	} else {
		f.setPostResponse(async () => new Response(new ReadableStream({
			start(controller) {
				send = event => {
					controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
					if (event.type === "response.completed") controller.close();
				};
				send(firstEvent);
			},
		}), {headers: {"content-type": "text/event-stream", ...(sequence === "header" ? {
			[`x-codex-${other}-used-percent`]: "10",
			[`x-codex-${other}-reset-after-seconds`]: "600",
		} : {})}}));
		result = f.post().then(async response => {
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('"response.completed"');
		});
	}
	await entered.promise;
	if (sequence === "consumed") {
		release.resolve();
		await vi.waitFor(() => expect(completed).toBe(1));
	}
	if (sequence === "pending") send(quota(exhausted, 100));
	if (sequence === "replacement") send(quota(exhausted, 0, false));
	send({...quota(other, 20), rate_limits: {
		[other]: {used_percent: 20, reset_at: resetAt},
		...(sequence !== "replacement" ? {[exhausted]: {used_percent: "invalid", reset_at: resetAt}} : {}),
	}});
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(sequence === "pending" || sequence === "replacement" ? 3 : 2));
	send({type: "response.completed", response: {id: "independent-quota-A", status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
	release.resolve();
	const response = await result;
	if (transport === "native") expect(response).toMatchObject({type: "response.completed"});
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !rowsBefore.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !rowsBefore.has(row.id))).toMatchObject({
		outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21},
	});
	const snapshot = scheduler.mock.calls.at(-1)?.[1];
	expect(snapshot?.[exhausted]).toEqual(sequence === "replacement" ? {usedPercent: 0} : {usedPercent: 100, resetAtMs: resetAt * 1000});
	expect(snapshot?.[other]).toEqual({usedPercent: 20, resetAtMs: resetAt * 1000});
	expect(snapshot).toMatchObject({status: 200, updatedAt: expect.any(Number)});
	f.setReply(undefined);
	f.setPostResponse(undefined);
	if (socket) expect(await turn(socket)).toMatchObject({type: sequence === "replacement" ? "response.completed" : "error"});
	else {
		const next = await f.post(); await next.text();
		expect(next.status === 200).toBe(sequence === "replacement");
	}
	expect(transport === "native" ? f.creates.length : f.fetched.length).toBe(sequence === "replacement" ? 2 : 1);
});

it.each(["free", "pro"].flatMap(planType => [false, true].map(replace => ({planType, replace}))))
("retains the latest supplied plan through coalesced native quota windows (%j)", async ({planType, replace}) => {
	const f = await fixture(true), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	f.manager.getAccountByIndex(0)!.workspaces!.splice(1);
	await f.manager.saveToDisk();
	const preference = vi.spyOn(quotaOrdering, "subscriptionQuotaPreference");
	const original = f.manager.withCurrentAccountCredential.bind(f.manager);
	let held = false;
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		if (!held) {held = true; entered.resolve(); await release.promise;}
		return original(...args);
	});
	let upstream: WebSocket | undefined;
	f.setReply(ws => {
		upstream = ws;
		ws.send(JSON.stringify({type: "codex.rate_limits", rate_limits: {primary: {used_percent: 10}}}));
	});
	const ws = await f.connect();
	const terminal = new Promise(resolve => ws.on("message", data => {
		const event = JSON.parse(String(data));
		if (event.type === "response.completed" || event.type === "error") resolve(event);
	}));
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	ws.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	await entered.promise;
	if (!upstream) throw Error("Fixture upstream missing");
	upstream.send(JSON.stringify({type: "codex.rate_limits", plan_type: planType, rate_limits: {secondary: {used_percent: 20}}}));
	const expectedPlan = replace ? (planType === "free" ? "pro" : "free") : planType;
	upstream.send(JSON.stringify({type: "codex.rate_limits", ...(replace ? {plan_type: expectedPlan} : {}), rate_limits: {primary: {used_percent: 0}}}));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(3));
	upstream.send(JSON.stringify({type: "response.completed", response: {id: "plan-A", status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}}));
	release.resolve();
	expect(await terminal).toMatchObject({type: "response.completed"});
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({
		outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21},
	});
	const callsBeforeNext = preference.mock.calls.length;
	f.setReply(undefined);
	expect(await turn(ws)).toMatchObject({type: "response.completed"});
	const observed = preference.mock.calls.slice(callsBeforeNext).filter(([entry]) => entry?.planType === expectedPlan);
	expect(observed.length).toBeGreaterThan(0);
	expect(observed[0]?.[0]).toMatchObject({planType: expectedPlan, primary: {usedPercent: 0}, secondary: {usedPercent: 20}});
	const hints = preference.mock.results.slice(callsBeforeNext).filter(result => result.type === "return").map(result => result.value);
	expect(hints).toContainEqual(expect.objectContaining({plan: expectedPlan === "free" ? "free" : "subscription", remainingPercent: 80}));
	expect(f.creates).toHaveLength(2);
});

it.each(["primary", "secondary"].flatMap(exhausted => ["event", "header"].map(input => ({exhausted, input}))))
("merges concurrent HTTP quota deltas against committed shared windows (%j)", async ({exhausted, input}) => {
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now);
	const f = await fixture(false);
	const bothDispatched = deferred(), headers = deferred();
	cleanups.push(async () => {headers.resolve();});
	const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const other = exhausted === "primary" ? "secondary" : "primary";
	const resetAt = Math.floor(now / 1000) + 600;
	let calls = 0;
	f.setPostResponse(async () => {
		const index = calls++;
		if (index === 1) {
			bothDispatched.resolve();
			if (input === "header") await headers.promise;
		}
		return new Response(new ReadableStream({start(controller) {
			controllers[index] = controller;
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type: "response.created", response: {id: `concurrent-${index}`}})}\n\n`));
		}}), {headers: {"content-type": "text/event-stream", ...(index === 1 && input === "header" ? {
			[`x-codex-${other}-used-percent`]: "20",
			[`x-codex-${other}-reset-after-seconds`]: "600",
		} : {})}});
	});
	const actual = f.manager.withCurrentAccountCredential.bind(f.manager);
	let commit = deferred();
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		const notification = commit;
		const applied = await actual(...args);
		expect(applied).toBe(true);
		notification.resolve();
		return applied;
	});
	const send = (index: number, event: Record<string, unknown>) => controllers[index]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const a = await f.post(), aBody = a.text();
	const bPending = f.post();
	await bothDispatched.promise;
	let b = input === "event" ? await bPending : undefined;
	let bBody = b?.text();
	send(0, {type: "codex.rate_limits", rate_limits: {[exhausted]: {used_percent: 100, reset_at: resetAt}}});
	await commit.promise;
	commit = deferred();
	if (input === "header") {
		headers.resolve();
		b = await bPending; bBody = b.text();
	} else {
		send(1, {type: "codex.rate_limits", rate_limits: {[other]: {used_percent: 20, reset_at: resetAt}}});
	}
	await commit.promise;
	expect(a.status).toBe(200); expect(b?.status).toBe(200);
	for (let index = 0; index < 2; index++) {
		send(index, {type: "response.completed", response: {id: `concurrent-${index}`, status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
		controllers[index]!.close();
	}
	for (const body of await Promise.all([aBody, bBody])) expect(body).toContain('"response.completed"');
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(2));
	const rows = (await readUsageLedgerRows()).filter(row => !before.has(row.id));
	for (const row of rows) expect(row).toMatchObject({outcome: "success", statusCode: 200, account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(new Set(rows.map(row => row.requestId)).size).toBe(2);
	f.setPostResponse(undefined);
	const next = await f.post(); await next.text();
	expect(next.status).not.toBe(200);
	expect(f.fetched).toHaveLength(2);
});

it.each(["primary", "secondary"].flatMap(exhausted => [false, true].map(held => ({exhausted, held}))))
("does not replay consumed native quota fields over a concurrent replacement (%j)", async ({exhausted, held}) => {
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now);
	const f = await fixture(true), bothSent = deferred(), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	f.manager.getAccountByIndex(0)!.workspaces!.splice(1);
	await f.manager.saveToDisk();
	const preference = vi.spyOn(quotaOrdering, "subscriptionQuotaPreference");
	const upstream: WebSocket[] = [];
	f.setReply(ws => {
		upstream.push(ws);
		ws.send(JSON.stringify({type: "response.created", response: {id: `native-concurrent-${upstream.length}`}}));
		if (upstream.length === 2) bothSent.resolve();
	});
	const clients = [await f.connect(), await f.connect()];
	const terminals = clients.map(client => new Promise<Record<string, unknown>>(resolve => {
		const onMessage = (data: RawData) => {
			const event = JSON.parse(String(data));
			if (event.type === "response.completed" || event.type === "error") {client.off("message", onMessage); resolve(event);}
		};
		client.on("message", onMessage);
	}));
	const actual = f.manager.withCurrentAccountCredential.bind(f.manager);
	let started = 0, commit = deferred();
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		const notification = commit;
		if (++started === 2 && held) {entered.resolve(); await release.promise;}
		const applied = await actual(...args);
		expect(applied).toBe(true);
		notification.resolve();
		return applied;
	});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	for (const client of clients) client.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
	await bothSent.promise;
	const resetAt = Math.floor(now / 1000) + 600;
	const other = exhausted === "primary" ? "secondary" : "primary";
	upstream[0]!.send(JSON.stringify({type: "codex.rate_limits", plan_type: "free", rate_limits: {[exhausted]: {used_percent: 100, reset_at: resetAt}}}));
	await commit.promise;
	commit = deferred();
	const partial = {type: "codex.rate_limits", ...(held ? {plan_type: " "} : {}), rate_limits: {[other]: {used_percent: 20, reset_at: resetAt}}};
	let heldCommit: ReturnType<typeof deferred> | undefined;
	if (held) {
		heldCommit = commit;
		upstream[0]!.send(JSON.stringify(partial));
		await entered.promise;
		commit = deferred();
	}
	upstream[1]!.send(JSON.stringify({type: "codex.rate_limits", plan_type: "pro", rate_limits: {[exhausted]: {used_percent: 0}}}));
	await commit.promise;
	if (held) {release.resolve(); await heldCommit!.promise;}
	else {commit = deferred(); upstream[0]!.send(JSON.stringify(partial)); await commit.promise;}
	for (let index = 0; index < 2; index++) upstream[index]!.send(JSON.stringify({type: "response.completed", response: {id: `native-concurrent-${index}`, status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}}));
	for (const terminal of await Promise.all(terminals)) expect(terminal.type).toBe("response.completed");
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(2));
	const rows = (await readUsageLedgerRows()).filter(row => !before.has(row.id));
	for (const row of rows) expect(row).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(new Set(rows.map(row => row.requestId)).size).toBe(2);
	const callsBeforeNext = preference.mock.calls.length;
	f.setReply(undefined);
	expect(await turn(clients[0]!)).toMatchObject({type: "response.completed"});
	expect(preference.mock.calls.slice(callsBeforeNext).map(([entry]) => entry)).toContainEqual(expect.objectContaining({
		planType: "pro", [exhausted]: {usedPercent: 0}, [other]: {usedPercent: 20, resetAtMs: resetAt * 1000},
	}));
	expect(f.creates).toHaveLength(3);
	expect(f.connections()).toBe(2);
	expect(f.fetched).toHaveLength(0);
});

it.each(["primary", "secondary"])("receipt-order regression retains newer %s exhaustion despite an older pending delta", async window => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	const encoder = new TextEncoder();
	const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	f.setPostResponse(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {
		streams.push(controller); emit(controller, {type: "response.in_progress", response: {id: `held-${streams.length}`}});
	}}), {headers: {"content-type": "text/event-stream"}}));
	const responses = await Promise.all([f.post(), f.post()]);
	const bodies = responses.map(response => response.text());
	const [a, b] = streams;
	if (!a || !b) throw Error("Missing concurrent fixture streams");
	const eligibility = f.manager.isAccountJournalEligible.bind(f.manager);
	let held = false;
	vi.spyOn(f.manager, "isAccountJournalEligible").mockImplementation(async (...args) => {
		if (!held) {held = true; entered.resolve(); await release.promise;}
		return eligibility(...args);
	});
	const transaction = f.manager.withCurrentAccountCredential.bind(f.manager);
	let committed = 0;
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {const value = await transaction(...args); committed++; return value;});
	const other = window === "primary" ? "secondary" : "primary";
	const quota = (field: string, used: number) => ({type: "codex.rate_limits", rate_limits: {[field]: {used_percent: used, reset_at: Math.floor(Date.now() / 1000) + 600}}});
	emit(a, quota(other, 10)); await entered.promise;
	emit(a, quota(window, 20));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(2));
	emit(b, quota(window, 100));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(3));
	release.resolve();
	await vi.waitFor(() => expect(committed).toBe(3));
	for (const [index, controller] of streams.entries()) {
		emit(controller, {type: "response.completed", response: {id: `terminal-${index}`, status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
		controller.close();
	}
	await Promise.all(bodies);
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(2));
	for (const row of (await readUsageLedgerRows()).filter(row => !before.has(row.id))) expect(row).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	f.setPostResponse(undefined);
	const next = await f.post(); const body = await next.text();
	expect(next.status, body).not.toBe(200);
	expect(f.fetched).toHaveLength(2);
});

it("failed-worker regression retains pending exhaustion after the first transaction rejects", async () => {
	const f = await fixture(false), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const encoder = new TextEncoder();
	const emit = (event: unknown) => {if (!stream) throw Error("Missing quota fixture stream"); stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));};
	f.setPostResponse(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {
		stream = controller; emit({type: "response.in_progress", response: {id: "held-quota"}});
	}}), {headers: {"content-type": "text/event-stream"}}));
	const response = await f.post(), body = response.text();
	const transaction = f.manager.withCurrentAccountCredential.bind(f.manager);
	let held = false;
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		const value = await transaction(...args);
		if (!held) {held = true; entered.resolve(); await release.promise; throw Error("fixture quota transaction completion failure");}
		return value;
	});
	const quota = (used: number) => ({type: "codex.rate_limits", rate_limits: {primary: {used_percent: used, reset_at: Math.floor(Date.now() / 1000) + 600}}});
	emit(quota(20)); await entered.promise;
	emit(quota(100));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(2));
	release.resolve();
	emit({type: "response.completed", response: {id: "quota-terminal", status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
	if (!stream) throw Error("Missing quota fixture stream"); stream.close();
	expect(await body).toContain('"response.completed"');
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	expect(f.proxy.getStatus().lastError).toBe("fixture quota transaction completion failure");
	f.setPostResponse(undefined);
	const next = await f.post(); const result = await next.text();
	expect(next.status, result).not.toBe(200);
	expect(f.fetched).toHaveLength(1);
});

it.each(["primary", "secondary"].flatMap(window => [false, true].flatMap(native =>
	[false, true].map(healthy => ({window, native, healthy})))))
("orders queued quota fields by receipt rather than completion (%j)", async ({window, native, healthy}) => {
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now);
	const f = await fixture(native), entered = deferred(), release = deferred(), ready = deferred();
	cleanups.push(async () => {release.resolve();});
	f.manager.getAccountByIndex(0)!.workspaces!.splice(1);
	await f.manager.saveToDisk();
	const preference = vi.spyOn(quotaOrdering, "subscriptionQuotaPreference");
	const streams: Array<(event: unknown) => void> = [], controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	let clients: WebSocket[] = [], bodies: Promise<unknown>[];
	if (native) {
		f.setReply(ws => {
			streams.push(event => ws.send(JSON.stringify(event)));
			ws.send(JSON.stringify({type: "response.created", response: {id: `receipt-${streams.length}`}}));
			if (streams.length === 2) ready.resolve();
		});
		clients = [await f.connect(), await f.connect()];
		bodies = clients.map(client => new Promise(resolve => {
			const onMessage = (data: RawData) => {
				const event = JSON.parse(String(data));
				if (event.type === "response.completed" || event.type === "error") {client.off("message", onMessage); resolve(event);}
			};
			client.on("message", onMessage);
		}));
		for (const client of clients) client.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
		await ready.promise;
	} else {
		f.setPostResponse(async () => new Response(new ReadableStream({start(controller) {
			controllers.push(controller);
			streams.push(event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)));
			streams.at(-1)!({type: "response.created", response: {id: `receipt-${streams.length}`}});
		}}), {headers: {"content-type": "text/event-stream"}}));
		const responses = await Promise.all([f.post(), f.post()]);
		for (const response of responses) expect(response.status).toBe(200);
		bodies = responses.map(response => response.text());
	}
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	const eligibility = f.manager.isAccountJournalEligible.bind(f.manager);
	let held = false, committed = 0;
	vi.spyOn(f.manager, "isAccountJournalEligible").mockImplementation(async (...args) => {
		if (!held) {held = true; entered.resolve(); await release.promise;}
		return eligibility(...args);
	});
	const transaction = f.manager.withCurrentAccountCredential.bind(f.manager);
	vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		const result = await transaction(...args); committed++; return result;
	});
	const other = window === "primary" ? "secondary" : "primary";
	const quota = (field: string, used: number, plan_type?: string) => ({
		type: "codex.rate_limits", plan_type, rate_limits: {[field]: {used_percent: used, reset_at: Math.floor(now / 1000) + 600}},
	});
	streams[0]!(quota(other, 10)); await entered.promise;
	streams[0]!(quota(window, healthy ? 100 : 20, "free"));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(2));
	streams[1]!(quota(window, healthy ? 0 : 100, "pro"));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(3));
	release.resolve();
	await vi.waitFor(() => expect(committed).toBe(3));
	for (let index = 0; index < 2; index++) {
		streams[index]!({type: "response.completed", response: {id: `receipt-${index}`, status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
		controllers[index]?.close();
	}
	for (const result of await Promise.all(bodies)) {
		if (native) expect(result).toMatchObject({type: "response.completed"});
		else expect(result).toContain('"response.completed"');
	}
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(2));
	for (const row of (await readUsageLedgerRows()).filter(row => !before.has(row.id))) expect(row).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	const callsBeforeNext = preference.mock.calls.length;
	f.setPostResponse(undefined); f.setReply(undefined);
	if (native) {
		expect(await turn(clients[0]!)).toMatchObject({type: healthy ? "response.completed" : "error"});
		expect(preference.mock.calls.slice(callsBeforeNext).map(([entry]) => entry)).toContainEqual(expect.objectContaining({planType: "pro", [window]: {usedPercent: healthy ? 0 : 100, resetAtMs: (Math.floor(now / 1000) + 600) * 1000}}));
		expect(f.creates).toHaveLength(healthy ? 3 : 2);
	} else {
		const next = await f.post(); await next.text();
		expect(next.status === 200).toBe(healthy);
		expect(f.fetched).toHaveLength(healthy ? 3 : 2);
	}
});

it.each(["primary", "secondary"].flatMap(window => [false, true].flatMap(native =>
	["completion", "persist", "journal"].map(failure => ({window, native, failure})))))
("settles known pending quota after worker failure without another event (%j)", async ({window, native, failure}) => {
	const f = await fixture(native), entered = deferred(), release = deferred();
	cleanups.push(async () => {release.resolve();});
	f.manager.getAccountByIndex(0)!.workspaces!.splice(1);
	await f.manager.saveToDisk();
	let emit: (event: unknown) => void = () => {throw Error("Missing failed quota stream");};
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let body: Promise<unknown>;
	if (native) {
		f.setReply(ws => {
			emit = event => ws.send(JSON.stringify(event));
			emit({type: "response.created", response: {id: "failed-worker"}});
		});
		const client = await f.connect();
		body = new Promise(resolve => {
			const onMessage = (data: RawData) => {
				const event = JSON.parse(String(data));
				if (event.type === "response.completed" || event.type === "error") {client.off("message", onMessage); resolve(event);}
			};
			client.on("message", onMessage);
		});
		client.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
		await vi.waitFor(() => expect(f.creates).toHaveLength(1));
	} else {
		f.setPostResponse(async () => new Response(new ReadableStream({start(value) {
			controller = value;
			emit = event => value.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
			emit({type: "response.created", response: {id: "failed-worker"}});
		}}), {headers: {"content-type": "text/event-stream"}}));
		const response = await f.post(); expect(response.status).toBe(200);
		body = response.text();
	}
	const before = new Set((await readUsageLedgerRows()).map(row => row.id));
	let failed = false;
	const transaction = f.manager.withCurrentAccountCredential.bind(f.manager);
	if (failure === "completion") vi.spyOn(f.manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {
		const result = await transaction(...args);
		if (!failed) {failed = true; entered.resolve(); await release.promise; throw Error("fixture first quota completion failure");}
		return result;
	});
	if (failure === "persist") {
		const rename = fs.rename.bind(fs);
		vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
			if (String(args[1]) === f.path && !failed) {
				failed = true; entered.resolve(); await release.promise;
				throw Object.assign(Error("fixture first quota persist failure"), {code: "EIO"});
			}
			return rename(...args);
		});
	}
	if (failure === "journal") {
		const eligibility = f.manager.isAccountJournalEligible.bind(f.manager);
		vi.spyOn(f.manager, "isAccountJournalEligible").mockImplementation(async (...args) => {
			if (!failed) {failed = true; entered.resolve(); await release.promise;}
			return eligibility(...args);
		});
	}
	const quota = (used: number) => ({type: "codex.rate_limits", rate_limits: {[window]: {used_percent: used, reset_at: Math.floor(Date.now() / 1000) + 600}}});
	emit(quota(20)); await entered.promise;
	emit(quota(100));
	await vi.waitFor(() => expect(f.proxy.getStatus().streamQuotaUpdates).toBe(2));
	if (failure === "journal") await fs.writeFile(getPendingAuthPath(f.path), "fixture unreadable pending quota journal");
	emit({type: "response.completed", response: {id: "failed-worker", status: "completed", output: [], usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}});
	controller?.close();
	release.resolve();
	const result = await body;
	if (native) expect(result).toMatchObject({type: "response.completed"});
	else expect(result).toContain('"response.completed"');
	await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
	expect((await readUsageLedgerRows()).find(row => !before.has(row.id))).toMatchObject({outcome: "success", account: {index: 0}, tokens: {inputTokens: 17, outputTokens: 4, totalTokens: 21}});
	await vi.waitFor(() => expect(f.proxy.getStatus().lastError).not.toBeNull());
	if (failure !== "journal") expect(f.proxy.getStatus().lastError).toBe(`${failure === "persist" ? "Failed to save accounts: " : ""}fixture first quota ${failure} failure`);
	if (failure === "journal") await fs.unlink(getPendingAuthPath(f.path));
	f.setPostResponse(undefined); f.setReply(undefined);
	const next = await f.post(); const text = await next.text();
	expect(next.status, text).not.toBe(200);
	expect(native ? f.creates.length : f.fetched.length).toBe(1);
});
