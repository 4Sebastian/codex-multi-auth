import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { getCircuitBreaker, clearCircuitBreakers, type CircuitAdmissionReceipt } from "../lib/circuit-breaker.js";
import { RefreshGuardian } from "../lib/refresh-guardian.js";
import * as proactiveRefresh from "../lib/proactive-refresh.js";
import { ensureFreshAccessToken } from "../lib/runtime/rotation-token-refresh.js";
import { queuedRefresh, resetRefreshQueue } from "../lib/refresh-queue.js";
import { loadAccounts, setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";
import { captureRefreshCredentialAuthority, getPendingAuthPath, withRefreshCredentialRetention } from "../lib/storage/pending-auth.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let dir: string, path: string;
const pool = (): AccountStorageV3 => ({version: 3, activeIndex: 0, accounts: [{recordId: "A", accountId: "W1", accessToken: "access-A", refreshToken: "refresh-A", expiresAt: 1, addedAt: 1, lastUsed: 1}]});
beforeEach(async () => {
 dir = await fs.mkdtemp(join(tmpdir(), "outcome-authority-")); path = join(dir, "accounts.json");
 setStoragePathDirect(path); await fs.writeFile(path, JSON.stringify(pool()));
 vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
});
afterEach(async () => {
 vi.restoreAllMocks(); vi.unstubAllEnvs(); resetRefreshQueue(); clearCircuitBreakers(); setStoragePathDirect(null);
 await removeWithRetry(dir, {recursive: true, force: true});
});

it.each([".bak", ".bak.2", ".wal", ".snapshot-history", "flagged"])("does not let retained lineage authorize a deleted primary refresh (%s)", async root => {
 const original = pool(), manager = new AccountManager(undefined, original), account = manager.getAccountByIndex(0)!;
 const backup = root === "flagged" ? join(dir, "openai-codex-flagged-accounts.json") : `${path}${root}`;
 await fs.writeFile(backup, JSON.stringify(root === ".wal" ? {version: 1, content: JSON.stringify(original)} : root === "flagged" ? {version: 1, accounts: [{...original.accounts[0], flaggedAt: 1}]} : original));
 const remaining = pool(); remaining.accounts[0] = {...remaining.accounts[0]!, recordId: "B", refreshToken: "refresh-B", accessToken: "access-B"};
 await fs.writeFile(path, JSON.stringify(remaining));
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({access_token: "unexpected-access", refresh_token: "unexpected-refresh", expires_in: 3600}));
 expect(() => captureRefreshCredentialAuthority(account)).toThrow();
 await expect(withRefreshCredentialRetention(original.accounts[0]!, () => queuedRefresh("refresh-A"))).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 await expect(queuedRefresh("refresh-A")).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 expect(fetch).not.toHaveBeenCalled();
 expect(await fs.stat(getPendingAuthPath(path)).catch(() => null)).toBeNull();
 expect(account.refreshToken).toBe("refresh-A");
});

it.each(["healthy", "removed", "changed", "backup-only", "foreign-token"])("refreshes only an explicitly current flagged source (%s)", async change => {
 const flagged = {...pool().accounts[0]!, flaggedAt: 1};
 const flaggedPath = join(dir, "openai-codex-flagged-accounts.json");
 await fs.writeFile(path, JSON.stringify({version: 3, activeIndex: 0, accounts: []}));
 await fs.writeFile(flaggedPath, JSON.stringify({version: 1, accounts: [flagged]}));
 const source = {kind: "flagged" as const, account: flagged};
 if (change === "removed") await fs.unlink(flaggedPath);
 if (change === "changed") await fs.writeFile(flaggedPath, JSON.stringify({version: 1, accounts: [{...flagged, flaggedAt: 2}]}));
 if (change === "backup-only") {await fs.writeFile(`${flaggedPath}.bak`, JSON.stringify({version: 1, accounts: [flagged]})); await fs.unlink(flaggedPath);}
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600}));
 const pending = withRefreshCredentialRetention(flagged, () => queuedRefresh(change === "foreign-token" ? "refresh-foreign" : flagged.refreshToken, path, source), undefined, undefined, path, source);
 if (change === "healthy") {
  expect(await pending).toMatchObject({type: "success", refresh: "next-refresh"});
  expect(JSON.parse(await fs.readFile(getPendingAuthPath(path), "utf8")).entries[0].recordId).toBe("A");
 } else await expect(pending).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 expect(fetch).toHaveBeenCalledTimes(change === "healthy" ? 1 : 0);
});

it.each(["replacement", "expiry", "disabled", "deleted", "reset", "journal", "cooldown", "current"])("guards guardian failure after the batch callback is delayed (%s)", async mutation => {
 const storage = pool(); storage.accounts[0]!.expiresAt = Date.now() + 20000;
 await fs.writeFile(path, JSON.stringify(storage));
 const manager = new AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
 let entered!: () => void, release!: () => void;
 const ready = new Promise<void>(r => {entered = r;}), gate = new Promise<void>(r => {release = r;});
 const refreshBatch = proactiveRefresh.refreshExpiringAccounts;
 vi.spyOn(proactiveRefresh, "refreshExpiringAccounts").mockImplementation((accounts, buffer, onResult, storagePath, resolveAccount) =>
  refreshBatch(accounts, buffer, async (source, result) => {entered(); await gate; await onResult?.(source, result);}, storagePath, resolveAccount));
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({error: "invalid_grant", error_description: "fixture refusal"}, {status: 400}));
 const guardian = new RefreshGuardian(() => manager), pending = guardian.tick();
 await ready;
 try {
  if (mutation === "replacement") Object.assign(account, {access: "access-B", refreshToken: "refresh-B"});
  if (mutation === "expiry") account.expires! += 1000;
  const disk = structuredClone(storage);
  if (["replacement", "expiry"].includes(mutation)) Object.assign(disk.accounts[0]!, {accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires});
  if (mutation === "disabled") disk.accounts[0]!.enabled = false;
  if (mutation === "deleted") disk.accounts = [];
  const newerCooldown = Date.now() + 600000;
  if (mutation === "cooldown") Object.assign(disk.accounts[0]!, {coolingDownUntil: newerCooldown, cooldownReason: "auth-failure"});
  if (mutation === "reset") await fs.writeFile(`${path}.reset-intent`, "{}");
  if (mutation === "journal") await fs.writeFile(getPendingAuthPath(path), "invalid journal");
  else await fs.writeFile(path, JSON.stringify(disk));
  release(); await pending;
  expect(fetch).toHaveBeenCalledTimes(1);
  if (mutation === "current" || mutation === "cooldown") {
   expect(account.consecutiveAuthFailures).toBe(1);
   expect(account.coolingDownUntil).toBeGreaterThan(Date.now());
   if (mutation === "cooldown") expect(account.coolingDownUntil).toBe(newerCooldown);
   expect((await loadAccounts())?.accounts[0]?.cooldownReason).toBe("auth-failure");
   expect((await loadAccounts())?.accounts[0]?.coolingDownUntil).toBe(account.coolingDownUntil);
  } else {
   expect(account.consecutiveAuthFailures ?? 0).toBe(0);
   expect(account.coolingDownUntil).toBeUndefined();
   if (!["reset", "journal", "deleted"].includes(mutation)) {
    const persisted = (await loadAccounts())!.accounts[0]!;
    expect(persisted.coolingDownUntil).toBeUndefined();
    expect(persisted.accessToken).toBe(disk.accounts[0]?.accessToken);
    expect(persisted.expiresAt).toBe(disk.accounts[0]?.expiresAt);
   }
  }
 } finally {release(); await pending; await manager.flushPendingSave();}
});

it("does not persist or count a guardian failure after its manager changes at the locked mutation boundary", async () => {
 const storage = pool(); storage.accounts[0]!.expiresAt = Date.now() + 20000;
 await fs.writeFile(path, JSON.stringify(storage));
 const manager = new AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
 let current = manager;
 const lockedMutation = manager.withCurrentAccountCredential.bind(manager);
 vi.spyOn(manager, "withCurrentAccountCredential").mockImplementation((target, submitted, mutate, persist) =>
  lockedMutation(target, submitted, row => {
   current = new AccountManager(undefined, storage);
   return mutate(row);
  }, persist));
 const before = await fs.readFile(path, "utf8");
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({error: "invalid_grant"}, {status: 400}));
 const guardian = new RefreshGuardian(() => current);
 await guardian.tick();
 expect(fetch).toHaveBeenCalledOnce();
 expect(account.consecutiveAuthFailures ?? 0).toBe(0);
 expect(current.getAccountByIndex(0)?.consecutiveAuthFailures ?? 0).toBe(0);
 expect(guardian.getStats().failed).toBe(0);
 expect(await fs.readFile(path, "utf8")).toBe(before);
 await manager.flushPendingSave(); await current.flushPendingSave();
});

it.each(["guardian", "runtime"])("keeps an inference half-open probe owned during %s OAuth failure", async caller => {
 const storage = pool(); storage.accounts[0]!.expiresAt = Date.now() + 20000;
 await fs.writeFile(path, JSON.stringify(storage));
 const manager = new AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
 manager.getCircuitRecoveryTime(account);
 const breaker = getCircuitBreaker(account.circuitKeyId!);
 for (let i = 0; i < 3; i++) breaker.recordFailure();
 vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
 let admission: CircuitAdmissionReceipt | undefined;
 manager.consumeToken(account, "codex", null, {onAdmission: receipt => {admission = receipt;}});
 if (!admission) throw Error("Missing inference fixture probe");
 expect(admission.halfOpen).toBe(true); expect(breaker.getState()).toBe("half-open");
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({error: "invalid_grant", error_description: "fixture OAuth refusal"}, {status: 400}));
 if (caller === "guardian") await new RefreshGuardian(() => manager).tick();
 else await ensureFreshAccessToken({accountManager: manager, account, family: "codex", model: null, now: Date.now(), tokenRefreshSkewMs: 30000, tokenInvalidationCooldownMs: 300000});
 expect(fetch).toHaveBeenCalledOnce();
 expect(breaker.getState()).toBe("half-open"); expect(breaker.isAdmissionCurrent(admission)).toBe(true);
 manager.recordFailure(account, "codex", null, admission);
 expect(breaker.getState()).toBe("open");
 await manager.flushPendingSave();
});

it("keeps a half-open probe and all healing owned by its admission", async () => {
 const manager = new AccountManager(undefined, await loadAccounts()), account = manager.getAccountByIndex(0)!;
 let old: CircuitAdmissionReceipt | undefined, current: CircuitAdmissionReceipt | undefined;
 manager.consumeToken(account, "codex", undefined, {onAdmission: receipt => {old = receipt;}});
 const refreshHealth = manager.captureRefreshHealth(account, "codex");
 const breaker = getCircuitBreaker(account.circuitKeyId!);
 for (let i = 0; i < 3; i++) breaker.recordFailure();
 vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
 manager.consumeToken(account, "codex", undefined, {onAdmission: receipt => {current = receipt;}});
 expect(breaker.getState()).toBe("half-open"); account.consecutiveAuthFailures = 2;
 expect(manager.recordSuccess(account, "codex", undefined, old)).toBe(false);
 expect(refreshHealth()).toBe(false);
 expect(refreshHealth(false)).toBe(false);
 manager.recordFailure(account, "codex");
 breaker.recordFailure();
 breaker.recordSuccess();
 expect(breaker.isAdmissionCurrent(current!)).toBe(true);
 expect(manager.recordSuccess(account, "codex")).toBe(false);
 expect(account.consecutiveAuthFailures).toBe(2); expect(breaker.getState()).toBe("half-open");
 expect(manager.recordSuccess(account, "codex", undefined, current)).toBe(true);
 expect(account.consecutiveAuthFailures).toBe(0); expect(breaker.getState()).toBe("closed");
 await manager.flushPendingSave();
});
