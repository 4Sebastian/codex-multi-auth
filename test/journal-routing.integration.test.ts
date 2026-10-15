import {once} from "node:events";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import WebSocket from "ws";
import {afterEach, expect, it, vi} from "vitest";
import {AccountManager} from "../lib/accounts.js";
import {setStoragePathDirect, type AccountStorageV3} from "../lib/storage.js";
import {getPendingAuthPath, recordPendingAuth} from "../lib/storage/pending-auth.js";
import {startRuntimeRotationProxy} from "../lib/runtime-rotation-proxy.js";
import {removeWithRetry} from "./helpers/remove-with-retry.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	setStoragePathDirect(null);
	for (const root of roots.splice(0)) await removeWithRetry(root, {recursive: true, force: true});
});
async function fixture(nativeOpenai: boolean, readPrimary?: () => Promise<AccountStorageV3>) {
	const root = await fs.mkdtemp(join(tmpdir(), "journal-routing-"));
	roots.push(root);
	const path = join(root, "accounts.json");
	setStoragePathDirect(path);
	const expiresAt = Date.now() + 3600000;
	const pool: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "fixture", accountId: "fixture", refreshToken: "fixture-refresh", accessToken: "fixture-managed", expiresAt, addedAt: 1, lastUsed: 1}]};
	await fs.writeFile(path, JSON.stringify(pool));
	const manager = new AccountManager(undefined, pool);
	const fetched = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
		? new Response('data: {"type":"response.completed","response":{"id":"fixture-response","status":"completed","output":[]}}\n\n', {headers: {"content-type": "text/event-stream"}})
		: Response.json({models: [{slug: "shared"}]}));
	const proxy = await startRuntimeRotationProxy({nativeOpenai, accountManager: manager,
		...(nativeOpenai ? {readNativeAccountStorage: readPrimary ?? (async () => structuredClone(pool))} : {}),
		clientApiKey: "fixture-independent", fetchImpl: fetched, upstreamBaseUrl: "http://127.0.0.1:1", readApiRoutes: async () => []});
	return {path, pool, expiresAt, manager, fetched, proxy};
}
const headers = {authorization: "Bearer fixture-independent", "content-type": "application/json"};

it.each([false, true].flatMap(native => ["EACCES", "EPERM", "EBUSY", "corrupt"].map(failure => ({native, failure}))))("refuses HTTP and an existing WebSocket create without upstream dispatch when journal is unknown (%j)", async ({native, failure}) => {
	const f = await fixture(native);
	const socket = new WebSocket(f.proxy.baseUrl.replace("http:", "ws:") + "/responses", {headers});
	socket.on("error", () => undefined);
	try {
		await once(socket, "open");
		await recordPendingAuth(f.path, {recordId: "fixture", priorRefreshToken: "fixture-refresh", refreshToken: "fixture-refresh", accessToken: "fixture-managed", expiresAt: f.expiresAt, authInvalidatedAt: 5000, enabled: false, at: 1});
		if (failure === "corrupt") await fs.writeFile(getPendingAuthPath(f.path), "private corrupt fixture");
		else {
			const read = fs.readFile.bind(fs);
			vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
				if (String(args[0]) === getPendingAuthPath(f.path)) throw Object.assign(Error("private fixture reason"), {code: failure});
				return read(...args);
			});
		}
		const response = await fetch(`${f.proxy.baseUrl}/responses`, {method: "POST", headers, body: JSON.stringify({model: "shared", input: []})});
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("private fixture");
		const rejected = once(socket, native ? "message" : "close");
		socket.send(JSON.stringify({type: "response.create", model: "shared", input: []}));
		const [result] = await rejected;
		if (native) expect(JSON.parse(String(result))).toMatchObject({type: "error", status: 503});
		else expect(result).toBe(1013);
		expect(f.fetched).not.toHaveBeenCalled();
		expect(f.proxy.getStatus().upstreamRequests).toBe(0);
	} finally {
		socket.terminate();
		vi.restoreAllMocks();
		await f.proxy.close();
	}
});

it("allows independent primary-only grace beyond two seconds but denies managed auth and freshly journaled disablement", async () => {
	let elapsed = 1000, locked = false;
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	let primary: AccountStorageV3;
	const f = await fixture(true, async () => {
		if (locked) throw Object.assign(Error("primary locked"), {code: "EBUSY"});
		return structuredClone(primary);
	});
	primary = f.pool;
	try {
		const warm = await fetch(`${f.proxy.baseUrl}/__auth_fixture__`, {headers});
		expect(warm.status).toBe(404); await warm.text();
		locked = true;
		elapsed += 3000;
		const managed = await fetch(`${f.proxy.baseUrl}/responses`, {method: "POST", headers: {...headers, authorization: "Bearer fixture-managed"}, body: JSON.stringify({model: "shared", input: []})});
		expect(managed.status).toBe(401); await managed.text();
		const response = await fetch(`${f.proxy.baseUrl}/responses`, {method: "POST", headers, body: JSON.stringify({model: "shared", input: []})});
		expect(response.status).toBe(200); await response.text();
		expect(f.fetched.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
		f.fetched.mockClear();
		await recordPendingAuth(f.path, {recordId: "fixture", priorRefreshToken: "fixture-refresh", refreshToken: "fixture-refresh", accessToken: "fixture-managed", expiresAt: f.expiresAt, enabled: false, authInvalidatedAt: 5000, at: 1});
		const denied = await fetch(`${f.proxy.baseUrl}/responses`, {method: "POST", headers, body: JSON.stringify({model: "shared", input: []})});
		expect(denied.status).not.toBe(200); await denied.text();
		expect(f.fetched).not.toHaveBeenCalled();
		elapsed = 31001;
		const expired = await fetch(`${f.proxy.baseUrl}/responses`, {method: "POST", headers, body: JSON.stringify({model: "shared", input: []})});
		expect(expired.status).toBe(503); await expired.text();
		expect(f.fetched).not.toHaveBeenCalled();
	} finally {await f.proxy.close();}
});
