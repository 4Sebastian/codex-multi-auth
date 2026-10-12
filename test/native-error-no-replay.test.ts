import {once} from "node:events";
import {promises as fs} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import WebSocket, {WebSocketServer} from "ws";
import {afterEach, expect, it, vi} from "vitest";
import {AccountManager} from "../lib/accounts.js";
import {clearCircuitBreakers} from "../lib/circuit-breaker.js";
import {resetTrackers} from "../lib/rotation.js";
import {startRuntimeRotationProxy} from "../lib/runtime-rotation-proxy.js";
import {setStoragePathDirect, type AccountStorageV3} from "../lib/storage.js";
import {readUsageLedgerRows} from "../lib/usage/index.js";
import type {ApiRouteCredential} from "../lib/api-route-store.js";
import {removeWithRetry} from "./helpers/remove-with-retry.js";

const transport = vi.hoisted(() => ({base: ""}));
vi.mock("ws", async importOriginal => {
	const actual = await importOriginal<typeof import("ws")>();
	const LocalWebSocket = new Proxy(actual.default, {
		construct(target, args) {
			const url = new URL(String(args[0]));
			if (url.hostname === "api.openai.com") args[0] = transport.base.replace("http:", "ws:") + url.pathname;
			return Reflect.construct(target, args);
		},
	});
	return {...actual, default: LocalWebSocket, WebSocket: LocalWebSocket};
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	setStoragePathDirect(null);
	clearCircuitBreakers();
	resetTrackers();
	transport.base = "";
});

const failures = [
	{status: 400, code: "unsupported_model"},
	{status: 401, code: "authentication_error"},
	{status: 402, code: "deactivated_workspace"},
	{status: 403, code: "workspace_disabled"},
	{status: 403, code: "model_access_denied"},
	{status: 404, code: "model_not_found"},
	{status: 429, code: "insufficient_quota"},
	{status: 429, code: "model_at_capacity"},
	{status: 500, code: "server_error"},
	{status: 503, code: "model_at_capacity"},
];
it.each(["oauth", "api", "zdr"].flatMap(kind => failures.flatMap(failure => ["first", "usage", "created"].map(mode => ({kind, mode, ...failure})))))
("never replays a sent native terminal error (%j)", async ({kind, mode, status, code}) => {
	const root = await fs.mkdtemp(join(tmpdir(), "native-terminal-"));
	cleanups.push(() => removeWithRetry(root, {recursive: true, force: true}));
	vi.stubEnv("CODEX_MULTI_AUTH_DIR", root);
	const path = join(root, "accounts.json");
	setStoragePathDirect(path);
	const pool: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [0, 1].map(index => ({
		recordId: `R${index}`, accountId: `W${index}`, refreshToken: `fixture-refresh-${index}`, accessToken: `fixture-access-${index}`,
		expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1,
		workspaces: [{id: `W${index}`, enabled: true}, {id: `W${index}-sibling`, enabled: true}], currentWorkspaceIndex: 0,
	}))};
	await fs.writeFile(path, JSON.stringify(pool));
	const manager = new AccountManager(undefined, pool);
	const routes: ApiRouteCredential[] = kind === "oauth" ? [] : [0, 1].map(index => ({
		id: `route-${index}`, kind: kind === "zdr" ? "zdr" : "api", label: `Fixture ${index}`, apiKey: `fixture-api-${index}`, enabled: true,
		priority: 10 - index, visibleModels: ["shared"],
	}));
	const upstream = createServer((_req, res) => {httpPosts++; res.writeHead(500); res.end();});
	const wss = new WebSocketServer({server: upstream});
	const creates: Array<{authorization: string | undefined; workspace: string | undefined}> = [];
	let httpPosts = 0;
	wss.on("connection", (ws, req) => ws.on("message", () => {
		creates.push({authorization: req.headers.authorization, workspace: String(req.headers["chatgpt-account-id"])});
		if (creates.length > 1) {
			ws.send(JSON.stringify({type: "response.completed", response: {id: "new-turn", status: "completed"}}));
			return;
		}
		if (mode === "created") ws.send(JSON.stringify({type: "response.created", response: {id: "first-turn"}}));
		ws.send(JSON.stringify({type: "error", status, error: {code, message: "Fixture refusal"}, headers: {"retry-after": "60"},
			...(mode === "usage" ? {response: {id: "first-turn", status: "failed", error: {code}, usage: {input_tokens: 17, output_tokens: 4, total_tokens: 21}}} : {}),
		}));
	}));
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	const address = upstream.address();
	if (!address || typeof address === "string") throw Error("Fixture address missing");
	transport.base = `http://127.0.0.1:${address.port}`;
	cleanups.push(async () => {
		for (const ws of wss.clients) ws.terminate();
		await new Promise<void>(done => wss.close(() => done()));
		upstream.closeAllConnections();
		await new Promise<void>(done => upstream.close(() => done()));
	});
	const proxy = await startRuntimeRotationProxy({
		accountManager: manager, nativeOpenai: true, clientApiKey: "fixture-local", upstreamBaseUrl: transport.base,
		readApiRoutes: async () => routes,
		fetchImpl: async (_url, init) => {
			if (init?.method === "POST") {httpPosts++; return Response.json({error: {code: "unexpected_http_fallback"}}, {status: 500});}
			return Response.json({models: [{slug: "shared"}], data: [{id: "shared"}]});
		},
	});
	cleanups.push(async () => {await proxy.close(); await manager.flushPendingSave();});
	const client = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses", {headers: {authorization: "Bearer fixture-local"}});
	cleanups.push(async () => {client.terminate();});
	await once(client, "open");
	const events: Array<Record<string, unknown>> = [];
	client.on("message", raw => events.push(JSON.parse(String(raw))));
	const send = () => client.send(JSON.stringify({type: "response.create", model: kind === "oauth" ? "shared" : `${kind}/shared`, input: []}));
	send();
	await vi.waitFor(async () => expect(await readUsageLedgerRows()).toHaveLength(1));
	expect(creates).toHaveLength(1);
	expect(httpPosts).toBe(0);
	expect(events.at(-1)).toMatchObject({type: "error", status, error: {code}});
	const row = (await readUsageLedgerRows())[0];
	expect(row).toMatchObject({outcome: "failure", statusCode: status, errorCode: code, tokens: {inputTokens: mode === "usage" ? 17 : 0, outputTokens: mode === "usage" ? 4 : 0, totalTokens: mode === "usage" ? 21 : 0}});
	if (kind === "oauth") expect(row?.account?.index).toBe(0);
	expect(proxy.getStatus().retries).toBe(0);
	send();
	await vi.waitFor(async () => expect(await readUsageLedgerRows()).toHaveLength(2));
	expect(creates).toHaveLength(2);
	expect(httpPosts).toBe(0);
	expect(events.at(-1)?.type).toBe("response.completed");
	if ([400, 404].includes(status) || status === 403 && code === "model_access_denied") {
		if (kind === "oauth") expect(creates[1]?.workspace).not.toBe(creates[0]?.workspace);
		else expect(creates[1]?.authorization).not.toBe(creates[0]?.authorization);
	}
	if (kind === "oauth" && [401, 402, 403, 429, 500].includes(status) && !["model_at_capacity", "model_access_denied"].includes(code)) {
		expect(creates[1]?.workspace).not.toBe(creates[0]?.workspace);
	}
});
