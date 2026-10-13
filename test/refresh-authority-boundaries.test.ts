import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { autoSyncActiveAccountToCodex, resetActiveAccountSyncMetaForTests } from "../lib/codex-manager/active-account-sync.js";
import { refreshAndUpdateToken } from "../lib/request/token-refresh.js";
import { applyMonotonicAuthCooldown, ensureFreshAccessToken } from "../lib/runtime/rotation-token-refresh.js";
import { RefreshGuardian } from "../lib/refresh-guardian.js";
import { loadAccounts, setStoragePathDirect, type AccountMetadataV3, type AccountStorageV3 } from "../lib/storage.js";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { captureRefreshCredentialAuthority, getPendingAuthPath, PendingAuthSettlementError, withRefreshCredentialRetention } from "../lib/storage/pending-auth.js";
import { mergeAccountRuntimeObservations, mergeAccountSnapshot } from "../lib/storage/snapshot-merge.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import * as refreshQueue from "../lib/refresh-queue.js";
import * as storageModule from "../lib/storage.js";
import { CodexAuthError } from "../lib/errors.js";
import type { OAuthAuthDetails, TokenSuccess } from "../lib/types.js";

let dir: string, path: string;
const row = (): AccountMetadataV3 => ({recordId: "owner-A", accountId: "workspace-A", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: 1, addedAt: 1, lastUsed: 1});
const pool = (account = row()): AccountStorageV3 => ({version: 3, activeIndex: 0, accounts: [account]});
const result: TokenSuccess = {type: "success", access: "fixture-new-access", refresh: "fixture-new-refresh", expires: 9999999999999};
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve}; };

beforeEach(async () => {
 dir = await fs.mkdtemp(join(tmpdir(), "refresh-authority-")); path = join(dir, "accounts.json");
 setStoragePathDirect(path); await fs.writeFile(path, JSON.stringify(pool()));
 vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
});
afterEach(async () => {
 vi.restoreAllMocks(); vi.unstubAllEnvs(); refreshQueue.resetRefreshQueue(); resetActiveAccountSyncMetaForTests(); setStoragePathDirect(null);
 await removeWithRetry(dir, {recursive: true, force: true});
});

it.each(["expiry", "record", "credential", "disable", "delete", "reset", "path", "member"])("rejects ordinary refresh success after authority changes (%s)", async change => {
 const storage = pool(), owner = storage.accounts[0]!; const held = gate();
 const pending = withRefreshCredentialRetention(owner, async () => {await held.promise; return result;}, () => storage.accounts.includes(owner));
 const assertion = expect(pending).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 const disk = pool();
 if (change === "expiry") disk.accounts[0]!.expiresAt = 2;
 if (change === "record") disk.accounts[0]!.recordId = "owner-B";
 if (change === "credential") disk.accounts[0]!.accessToken = "fixture-B-access";
 if (change === "disable") disk.accounts[0]!.enabled = false;
 if (change === "delete") disk.accounts = [];
 if (change === "reset") await fs.writeFile(getIntentionalResetMarkerPath(path), "{}");
 if (change === "path") setStoragePathDirect(join(dir, "other.json"));
 if (change === "member") storage.accounts = [];
 await fs.writeFile(path, JSON.stringify(disk)); held.resolve(); await assertion;
 expect(owner).toEqual(row());
});

it("fails closed after a second metadata change to the same captured authority", async () => {
 const current = captureRefreshCredentialAuthority(row());
 const metadata = pool(); metadata.accounts[0]!.lastUsed = 2;
 await fs.writeFile(path, JSON.stringify(metadata)); expect(current(result)).toBe(true);
 metadata.accounts[0]!.lastUsed = 3;
 await fs.writeFile(path, JSON.stringify(metadata)); expect(current(result)).toBe(false);
});

it("permits ordinary same-owner success and unrelated metadata changes", async () => {
 const owner = row(); const returned = await withRefreshCredentialRetention(owner, async () => {
  const disk = pool(); disk.accounts[0]!.lastUsed = 2; await fs.writeFile(path, JSON.stringify(disk)); return result;
 }); expect(returned).toBe(result);
});

it.each(["expiry", "disable", "corrupt", "delete", "new-corrupt"])("revalidates every flagged recovery root after refresh (%s)", async change => {
 const owner = row(), backup = join(dir, "openai-codex-flagged-accounts.json.bak.2");
 const flagged = {version: 1, accounts: [{...row(), flaggedAt: 1}]};
 if (change !== "new-corrupt") await fs.writeFile(backup, JSON.stringify(flagged));
 const pending = withRefreshCredentialRetention(owner, async () => {
  if (change === "expiry") flagged.accounts[0]!.expiresAt = 2;
  if (change === "disable") Object.assign(flagged.accounts[0]!, {enabled: false});
  if (change === "delete") await fs.unlink(backup);
  else await fs.writeFile(backup, change.includes("corrupt") ? "{" : JSON.stringify(flagged));
  return result;
 });
 await expect(pending).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 expect(owner).toEqual(row());
});

it("permits unchanged flagged roots while unrelated metadata changes", async () => {
 const backup = join(dir, "openai-codex-flagged-accounts.json.bak.2");
 const flagged = {version: 1, accounts: [{...row(), flaggedAt: 1}]};
 await fs.writeFile(backup, JSON.stringify(flagged));
 await expect(withRefreshCredentialRetention(row(), async () => {
  flagged.accounts[0]!.lastUsed = 2; await fs.writeFile(backup, JSON.stringify(flagged)); return result;
 })).resolves.toBe(result);
});

it("does not let an older flagged backup override the current primary generation", async () => {
 const backup = join(dir, "openai-codex-flagged-accounts.json.bak.2");
 await fs.writeFile(backup, JSON.stringify({version: 1, accounts: [{...row(), refreshToken: "fixture-older-refresh", accessToken: "fixture-older-access", expiresAt: 0, flaggedAt: 1}]}));
 await expect(withRefreshCredentialRetention(row(), async () => result)).resolves.toBe(result);
});

it.each(["replacement", "corrupt"])("rejects a stale authentication result after changed journal authority (%s)", async change => {
 const owner = row();
 await expect(withRefreshCredentialRetention(owner, async () => {
  const entry = {prior: createHash("sha256").update(owner.refreshToken).digest("hex"), recordId: owner.recordId, refreshToken: result.refresh, accessToken: result.access, expiresAt: result.expires, at: 1};
  await fs.writeFile(getPendingAuthPath(path), change === "corrupt" ? "{" : JSON.stringify({version: 1, entries: [entry]}));
  return {type: "failed", reason: "invalid_grant", message: "fixture authentication refusal"};
 })).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 expect(owner).toEqual(row());
});

it.each([".bak.2", ".wal", ".snapshot-history"])("revalidates canonical, WAL and discovered account recovery roots (%s)", async suffix => {
 const backup = `${path}${suffix}`, original = pool();
 await fs.writeFile(backup, JSON.stringify(suffix === ".wal" ? {version: 1, content: JSON.stringify(original)} : original));
 await expect(withRefreshCredentialRetention(row(), async () => {
  await fs.writeFile(backup, "{"); return result;
 })).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
});

it("keeps an explicit pool independent of ambient path changes", async () => {
 const owner = row();
 setStoragePathDirect(join(dir, "ambient-before.json"));
 const returned = await withRefreshCredentialRetention(owner, async () => {
  setStoragePathDirect(join(dir, "ambient-after.json")); return result;
 }, undefined, undefined, path);
 expect(returned).toBe(result); expect(owner).toEqual(row());
});

it.each(["expiry", "live", "journal", "corrupt", "reset", "current"])("validates the original owner before classifying a real OAuth refusal (%s)", async change => {
 const manager = new AccountManager(undefined, await loadAccounts()), account = manager.getAccountByIndex(0)!;
 account.consecutiveAuthFailures = 2;
 manager.markAccountCoolingDown(account, 60000, "auth-failure");
 const cooldown = account.coolingDownUntil;
 const auth = manager.toAuthDetails(account);
 const entered = gate(), release = gate();
 const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  entered.resolve(); await release.promise;
  return Response.json({error: "invalid_grant", error_description: "fixture refusal"}, {status: 400});
 });
 const setter = vi.fn();
 const pending = refreshAndUpdateToken(auth, {auth: {set: setter}} as never, {accountManager: manager, account}).catch(error => error);
 await entered.promise;
 if (change === "expiry") account.expires = 2;
 if (change === "live") manager.updateFromAuth(account, {type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires});
 if (change === "journal" || change === "corrupt") await fs.writeFile(getPendingAuthPath(path), change === "corrupt" ? "{" : JSON.stringify({version: 1, entries: [{prior: createHash("sha256").update("fixture-refresh").digest("hex"), recordId: account.recordId, refreshToken: result.refresh, accessToken: result.access, expiresAt: result.expires, at: 1}]}));
 if (change === "reset") await fs.writeFile(getIntentionalResetMarkerPath(path), "{}");
 const before = structuredClone(account);
 release.resolve();
 const error = await pending;
 if (change === "current") {expect(error).toBeInstanceOf(CodexAuthError); expect(error.retryable).toBe(false);}
 else {expect(error).not.toBeInstanceOf(CodexAuthError); expect(error.code).toBe("EPENDINGAUTHADMISSION");}
 expect(account).toEqual(before); expect(account.consecutiveAuthFailures).toBe(2);
 if (change !== "live") expect(account.coolingDownUntil).toBe(cooldown);
 expect(setter).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["ENOSPC", "EIO"])("retains newest material and the first host persistence error (%s)", async code => {
 const auth: OAuthAuthDetails = {type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1};
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({access_token: result.access, refresh_token: result.refresh, expires_in: 3600}));
 const cause = Object.assign(Error("fixture publication failed"), {code});
 const setter = vi.fn(async () => {throw cause;});
 const error = await refreshAndUpdateToken(auth, {auth: {set: setter}} as never).catch(error => error);
 expect(error).toBeInstanceOf(PendingAuthSettlementError); expect(error.cause).toBe(cause); expect(error.durability).toBe("journal");
 expect(auth.access).toBe(result.access); expect(auth.refresh).toBe(result.refresh);
 expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe(result.refresh); expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not overwrite an expiry-replaced owner during host publication", async () => {
 const auth: OAuthAuthDetails = {type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1};
 vi.spyOn(refreshQueue, "queuedRefresh").mockResolvedValue(result);
 const setter = vi.fn(async () => {auth.expires = 2; const disk = pool(); disk.accounts[0]!.expiresAt = 2; await fs.writeFile(path, JSON.stringify(disk));});
 await expect(refreshAndUpdateToken(auth, {auth: {set: setter}} as never)).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 expect(auth).toMatchObject({access: "fixture-access", refresh: "fixture-refresh", expires: 2});
});

it.each(["runtime", "guardian"])("does not penalize or heal auth state on pre-OAuth corruption (%s)", async consumer => {
 const manager = new AccountManager(undefined, await loadAccounts()); const account = manager.getAccountByIndex(0)!;
 account.consecutiveAuthFailures = 2; manager.markAccountCoolingDown(account, 60000, "auth-failure");
 const failure = vi.spyOn(manager, "recordFailure"), success = vi.spyOn(manager, "recordSuccess");
 const fetch = vi.spyOn(globalThis, "fetch"); await fs.writeFile(getPendingAuthPath(path), "{");
 if (consumer === "runtime") await expect(ensureFreshAccessToken({accountManager: manager, account, family: "codex", model: "gpt-5", now: Date.now(), tokenRefreshSkewMs: 0, tokenInvalidationCooldownMs: 300000})).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 else {manager.clearAccountCooldown(account); const guardian = new RefreshGuardian(() => manager); await guardian.tick();}
 expect(account.consecutiveAuthFailures).toBe(2); expect(account.enabled).not.toBe(false); expect(failure).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("does not apply a cooldown from an explicitly undefined submitted expiry to a replacement", async () => {
 const manager = new AccountManager(undefined, await loadAccounts()), account = manager.getAccountByIndex(0)!;
 account.expires = undefined;
 const submitted = {accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires};
 account.expires = 2;
 applyMonotonicAuthCooldown(manager, account, 60000, submitted);
 expect(account.coolingDownUntil).toBeUndefined();
 applyMonotonicAuthCooldown(manager, account, 60000);
 expect(account.coolingDownUntil).toBeGreaterThan(Date.now());
});

it.each([false, true])("does not relabel an old invalidation with a replacement expiry (current revoked=%s)", revoked => {
 const base = pool(); const local = structuredClone(base), disk = structuredClone(base);
 Object.assign(local.accounts[0]!, {authInvalidatedAt: 100, authInvalidationErrorCode: "late-A", coolingDownUntil: 1000, cooldownReason: "auth-failure"});
 Object.assign(disk.accounts[0]!, {expiresAt: 2, ...(revoked ? {authInvalidatedAt: 200, authInvalidationErrorCode: "current-B", coolingDownUntil: 2000, cooldownReason: "auth-failure"} : {})});
 for (const merge of [mergeAccountSnapshot, mergeAccountRuntimeObservations]) {
  const merged = merge(base, disk, local).accounts[0]!;
  expect(merged.expiresAt).toBe(2); expect(merged.authInvalidatedAt).toBe(revoked ? 200 : undefined); expect(merged.coolingDownUntil).toBe(revoked ? 2000 : undefined);
 }
});

it.each(["EINVAL", "EBUSY", "EACCES"])("preserves primary publication failure without authentication refusal or predecessor respend (%s)", async code => {
 const manager = new AccountManager(undefined, await loadAccounts()), account = manager.getAccountByIndex(0)!;
 account.consecutiveAuthFailures = 2;
 manager.markAccountCoolingDown(account, 60000, "auth-failure");
 const cooldown = account.coolingDownUntil;
 vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => undefined);
 const failure = vi.spyOn(manager, "recordFailure"), success = vi.spyOn(manager, "recordSuccess");
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({access_token: result.access, refresh_token: result.refresh, expires_in: 3600}));
 const cause = Object.assign(Error("fixture primary publication failed"), {code});
 const rename = fs.rename.bind(fs);
 vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
  if (String(to) === path) throw cause;
  return rename(from, to);
 });
 const params = {accountManager: manager, account, family: "codex" as const, model: "gpt-5", now: Date.now(), tokenRefreshSkewMs: 0, tokenInvalidationCooldownMs: 300000};
 const errors = await Promise.all([ensureFreshAccessToken(params), ensureFreshAccessToken(params)].map(pending => pending.catch(value => value)));
 const error = errors[0];
 expect(errors[1]).toBe(error);
 expect(error).toBeInstanceOf(PendingAuthSettlementError);
 expect(error.cause).toMatchObject({code, cause});
 expect(error.cause.cause).toBe(cause); expect(error.durability).toBe(code === "EINVAL" ? "unverified" : "journal");
 expect(account.coolingDownUntil).toBe(cooldown); expect(account.cooldownReason).toBe("auth-failure");
 expect(account).toMatchObject({access: result.access, refreshToken: result.refresh, consecutiveAuthFailures: 2});
 expect(account.enabled).not.toBe(false); expect(manager.getAccountByIndex(0)).toBe(account);
 expect(failure).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
 expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe(result.refresh);
 await expect(refreshQueue.getRefreshQueue().refresh("fixture-refresh", path)).resolves.toMatchObject({type: "success", refresh: result.refresh});
 expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["journal-after-load", "journal-before-load", "corrupt", "reset", "disable", "selection"])("does not mirror or cache a stale usable selection (%s)", async change => {
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir); vi.stubEnv("CODEX_CLI_AUTH_PATH", join(dir, "auth.json")); vi.stubEnv("CODEX_CLI_CONFIG_PATH", join(dir, "config.toml")); vi.stubEnv("CODEX_CLI_ACCOUNTS_PATH", join(dir, "mirror.json")); vi.stubEnv("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
 const globalPath = join(dir, "openai-codex-accounts.json");
 const initial = pool(); initial.accounts[0]!.expiresAt = result.expires;
 await fs.writeFile(globalPath, JSON.stringify(initial));
 const journal = JSON.stringify({version: 1, entries: [{prior: createHash("sha256").update("fixture-refresh").digest("hex"), recordId: "owner-A", refreshToken: result.refresh, accessToken: result.access, expiresAt: result.expires, at: 1}]});
 if (change === "journal-before-load") await fs.writeFile(getPendingAuthPath(globalPath), journal);
 const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({access_token: result.access, refresh_token: result.refresh, expires_in: 3600}));
 const originalLoad = storageModule.loadAccounts;
 vi.spyOn(storageModule, "loadAccounts").mockImplementationOnce(async () => {
  const loaded = change === "journal-before-load" ? structuredClone(initial) : await originalLoad();
  if (change === "journal-after-load") await refreshQueue.getRefreshQueue().refresh("fixture-refresh", globalPath);
  if (change === "corrupt") await fs.writeFile(getPendingAuthPath(globalPath), "{");
  if (change === "reset") await fs.writeFile(getIntentionalResetMarkerPath(globalPath), "{}");
  if (change === "disable" || change === "selection") {
   const disk = structuredClone(initial);
   if (change === "disable") disk.accounts[0]!.enabled = false;
   else {disk.accounts.push({...row(), recordId: "owner-B", refreshToken: "other-refresh"}); disk.activeIndex = 1;}
   await fs.writeFile(globalPath, JSON.stringify(disk));
  }
  return loaded;
 });
 const outcome = await autoSyncActiveAccountToCodex().catch(error => error);
 expect(outcome === false || outcome?.code === "EPENDINGAUTHADMISSION" || outcome?.code === "EPENDINGAUTHUNREADABLE").toBe(true);
 await expect(fs.readFile(join(dir, "auth.json"))).rejects.toMatchObject({code: "ENOENT"});
 if (change.startsWith("journal")) {
  expect(await fs.readFile(globalPath, "utf8")).toBe(JSON.stringify(initial));
  expect(await autoSyncActiveAccountToCodex()).toBe(true);
  expect(JSON.parse(await fs.readFile(join(dir, "auth.json"), "utf8")).tokens.refresh_token).toBe(result.refresh);
  expect(await autoSyncActiveAccountToCodex()).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(change === "journal-after-load" ? 1 : 0);
 }
});

it.each(["journal", "corrupt", "reset"])("observes changed warm-sync authority (%s)", async change => {
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir); vi.stubEnv("CODEX_CLI_AUTH_PATH", join(dir, "auth.json")); vi.stubEnv("CODEX_CLI_CONFIG_PATH", join(dir, "config.toml")); vi.stubEnv("CODEX_CLI_ACCOUNTS_PATH", join(dir, "mirror.json")); vi.stubEnv("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
 const globalPath = join(dir, "openai-codex-accounts.json"); const initial = pool(); initial.accounts[0]!.expiresAt = result.expires; await fs.writeFile(globalPath, JSON.stringify(initial));
 expect(await autoSyncActiveAccountToCodex()).toBe(true); expect(await autoSyncActiveAccountToCodex()).toBe(true);
 if (change === "corrupt") {await fs.writeFile(getPendingAuthPath(globalPath), "{"); await expect(autoSyncActiveAccountToCodex()).rejects.toMatchObject({code: "EPENDINGAUTHUNREADABLE"});}
 else if (change === "reset") {await fs.writeFile(getIntentionalResetMarkerPath(globalPath), "{}"); expect(await autoSyncActiveAccountToCodex()).toBe(false);}
 else {
  await fs.writeFile(getPendingAuthPath(globalPath), JSON.stringify({version: 1, entries: [{prior: createHash("sha256").update("fixture-refresh").digest("hex"), recordId: "owner-A", refreshToken: result.refresh, accessToken: result.access, expiresAt: result.expires, at: 1}]}));
  expect(await autoSyncActiveAccountToCodex()).toBe(true); expect(await fs.readFile(join(dir, "auth.json"), "utf8")).toContain(result.refresh);
 }
});
