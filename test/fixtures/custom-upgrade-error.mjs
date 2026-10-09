import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, Socket } from "node:net";
import WebSocket from "ws";
import { AccountManager } from "../../lib/accounts.js";
import { startRuntimeRotationProxy } from "../../lib/runtime-rotation-proxy.js";

const [scenario, code] = process.argv.slice(2);
const now = Date.now();
const manager = new AccountManager(undefined, {
	version: 3,
	activeIndex: 0,
	accounts: [{
		recordId: "fixture", accountId: "fixture", refreshToken: "fixture-refresh",
		accessToken: "fixture-access", expiresAt: now + 3600000,
		addedAt: now, lastUsed: now, enabled: true,
	}],
});
const proxy = await startRuntimeRotationProxy({
	accountManager: manager,
	clientApiKey: "fixture-client",
	fetchImpl: async () => new Response('{"data":[]}', {
		headers: { "content-type": "application/json" },
	}),
});
const originalEnd = Socket.prototype.end;
const originalWrite = Socket.prototype.write;
let injected = 0;
let failedSocket;
function fail(socket) {
	if (socket.localPort !== proxy.port || injected) return false;
	injected++;
	failedSocket = socket;
	socket.destroy(Object.assign(new Error("fixture upgrade socket failure"), { code }));
	return true;
}
Socket.prototype.end = function (...args) {
	if (scenario !== "accept" && fail(this)) return this;
	return Reflect.apply(originalEnd, this, args);
};
Socket.prototype.write = function (...args) {
	if (scenario === "accept" && fail(this)) return false;
	return Reflect.apply(originalWrite, this, args);
};
try {
	const client = createConnection({ host: proxy.host, port: proxy.port });
	client.on("error", () => client.destroy());
	const closed = once(client, "close");
	await once(client, "connect");
	const target = scenario === "malformed" ? "http://%/responses" : scenario === "unsupported" ? "/missing" : "/responses";
	client.write(`GET ${target} HTTP/1.1\r\nHost: ${proxy.host}:${proxy.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Zml4dHVyZS11cGdyYWRlIQ==\r\n${scenario === "accept" ? "Authorization: Bearer fixture-client\r\n" : ""}\r\n`);
	await closed;
	assert.equal(injected, 1);
	assert.equal(failedSocket.destroyed, true);
	Socket.prototype.end = originalEnd;
	Socket.prototype.write = originalWrite;
	const response = await fetch(`${proxy.baseUrl}/models`, {
		headers: { authorization: "Bearer fixture-client" },
		signal: AbortSignal.timeout(2000),
	});
	assert.equal(response.status, 200);
	await response.text();
	const valid = new WebSocket(`${proxy.baseUrl.replace("http:", "ws:")}/responses`, {
		headers: { authorization: "Bearer fixture-client" },
		handshakeTimeout: 2000,
	});
	await once(valid, "open");
	const validClosed = once(valid, "close");
	valid.terminate();
	await validClosed;
} finally {
	Socket.prototype.end = originalEnd;
	Socket.prototype.write = originalWrite;
	await proxy.close();
}
assert.equal(proxy.getOpenConnectionCount(), 0);
process.stdout.write("survived\n");
