import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { clearCircuitBreakers, getCircuitBreaker, type CircuitAdmissionReceipt } from "../lib/circuit-breaker.js";
import { createAccountDispatch } from "../lib/request/account-dispatch.js";
import { getPendingAuthPath } from "../lib/storage/pending-auth.js";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";
import { getAccountPolicyKey, updateAccountPolicyStore, upsertAccountPolicy } from "../lib/account-policy.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let dir: string, path: string;
const managers: AccountManager[] = [];
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "plugin-send-boundary-"));
	path = join(dir, "accounts.json");
	vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
	setStoragePathDirect(path);
});
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.flushPendingSave();
	vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCircuitBreakers(); setStoragePathDirect(null);
	await removeWithRetry(dir, {recursive: true, force: true});
});

it.each(["healthy", "metadata", "delete", "disable", "revoke", "expiry", "replacement", "journal", "primary", "reset", "policy", "circuit", "quota", "workspace"])("revalidates the captured binding at the actual send after preparation (%s)", async change => {
	const storage: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "submitted", accountId: "W1", email: "fixture@example.com", accessToken: "access-A", refreshToken: "refresh-A", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, workspaces: [{id: "W1", enabled: true}]}]};
	await fs.writeFile(path, JSON.stringify(storage));
	const manager = new AccountManager(undefined, storage); managers.push(manager);
	const account = manager.getAccountByIndex(0)!;
	let admission: CircuitAdmissionReceipt | undefined;
	manager.consumeToken(account, "codex", "gpt-5.1", {onAdmission: receipt => {admission = receipt;}});
	if (!admission) throw Error("Missing fixture admission");
	const dispatch = createAccountDispatch({manager, account, submitted: {recordId: account.recordId, accountId: "W1", accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires}, admission, family: "codex", model: "gpt-5.1", eligible: () => true});
	const disk = structuredClone(storage), row = disk.accounts[0]!;
	if (change === "delete") disk.accounts = [];
	if (change === "disable") row.enabled = false;
	if (change === "revoke") row.authInvalidatedAt = Date.now();
	if (change === "expiry") vi.spyOn(Date, "now").mockReturnValue(row.expiresAt! + 1);
	if (change === "replacement") row.accessToken = "access-B";
	if (change === "metadata") row.lastUsed = 2;
	if (change === "workspace") row.workspaces![0]!.enabled = false;
	if (change === "quota") row.rateLimitResetTimes = {codex: Date.now() + 60000};
	if (change === "journal") await fs.writeFile(getPendingAuthPath(path), "{");
	if (change === "reset") await fs.writeFile(getIntentionalResetMarkerPath(path), "{}");
	if (change === "policy") await updateAccountPolicyStore(store => {upsertAccountPolicy(store, getAccountPolicyKey(account), policy => {policy.paused = true;}); return {result: undefined, dirty: true};});
	if (change === "circuit") for (let i = 0; i < 3; i++) getCircuitBreaker(account.circuitKeyId!).recordFailure();
	await fs.writeFile(path, change === "primary" ? "{" : JSON.stringify(disk));
	const send = vi.fn(async () => Response.json({id: "accepted"}));
	if (change === "healthy" || change === "metadata") expect(await (await dispatch(send)).json()).toEqual({id: "accepted"});
	else await expect(dispatch(send)).rejects.toThrow();
	expect(send).toHaveBeenCalledTimes(change === "healthy" || change === "metadata" ? 1 : 0);
});

it("starts the authenticated send inside the locked authority boundary and preserves its first error", async () => {
	const storage: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "owner", accountId: "W1", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
	await fs.writeFile(path, JSON.stringify(storage));
	const manager = new AccountManager(undefined, storage); managers.push(manager);
	const account = manager.getAccountByIndex(0)!;
	let admission: CircuitAdmissionReceipt | undefined;
	manager.consumeToken(account, "codex", null, {onAdmission: receipt => {admission = receipt;}});
	if (!admission) throw Error("Missing fixture admission");
	const dispatch = createAccountDispatch({manager, account, submitted: {recordId: account.recordId, accountId: "W1", accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires}, admission, family: "codex", model: null, eligible: () => true});
	const first = new Error("fixture upstream transport failed");
	await expect(dispatch(async () => {await fs.writeFile(path, "{"); throw first;})).rejects.toBe(first);
});
