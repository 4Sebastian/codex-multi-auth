import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import * as prompts from "../lib/prompts/codex.js";
import { getAccountPolicyKey, saveAccountPolicyStore, upsertAccountPolicy, type AccountPolicyStore } from "../lib/account-policy.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
import { createAutomaticSubscriptionCheck } from "../lib/runtime/automatic-subscription-checks.js";
import { getStoragePath, loadAccounts, setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { captureRefreshCredentialAuthority, getPendingAuthPath, withPendingAuthRefresh } from "../lib/storage/pending-auth.js";
import { collectRestorableCredentials, getAccountsBackupRecoveryCandidatesWithDiscovery, getAccountsBackupRecoveryCandidatesWithDiscoverySync } from "../lib/storage/recovery-credentials.js";
import * as storageModule from "../lib/storage.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

vi.mock("../lib/prompts/codex.js", async importOriginal => ({...(await importOriginal<typeof import("../lib/prompts/codex.js")>()), getCodexInstructions: vi.fn().mockResolvedValue("Representative fixture instructions")}));
let dir: string, home: string, path: string;
const held = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};};
const pool = (): AccountStorageV3 => ({version: 3, activeIndex: 0, accounts: [{recordId: "fixture-source", accountId: "fixture-workspace", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: 1, addedAt: 1, lastUsed: 1}]});
beforeEach(async () => {
 dir = await fs.mkdtemp(join(tmpdir(), "recovery-sources-"));
 home = await fs.mkdtemp(join(homedir(), "recovery-sources-home-"));
 path = join(dir, "accounts.json");
 vi.stubEnv("CODEX_HOME", home); vi.stubEnv("CODEX_MULTI_AUTH_DIR", join(home, "multi-auth")); vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
 setStoragePathDirect(path); await fs.writeFile(path, JSON.stringify(pool()));
});
afterEach(async () => {
 resetRefreshQueue(); setStoragePathDirect(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
 await removeWithRetry(dir, {recursive: true, force: true}); await removeWithRetry(home, {recursive: true, force: true});
});
it("refreshes an expired opt-in owner after recording a real automatic-check history, then mirrors and scans recovery", async () => {
 const storage = pool(), policies: AccountPolicyStore = {version: 1, accounts: {}};
 upsertAccountPolicy(policies, getAccountPolicyKey(storage.accounts[0]!), policy => {policy.autoPrime = true;});
 await saveAccountPolicyStore(policies);
 expect(getStoragePath()).toBe(path);
 const snapshot = await (await import("../lib/runtime/native-account-storage.js")).createNativeAccountStorageReader(undefined, path)();
 expect(snapshot.verified).toBe(true); expect(snapshot.storage?.accounts).toHaveLength(1);
 expect(getAccountPolicyKey(snapshot.storage!.accounts[0]!)).toBe(getAccountPolicyKey(storage.accounts[0]!));
 const oauth = vi.fn(), probe = vi.fn(), observe = vi.fn();
 vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
  if (String(url) === "https://auth.openai.com/oauth/token") {oauth(); return Response.json({access_token: "fixture-rotated-access", refresh_token: "fixture-rotated-refresh", expires_in: 3600});}
  expect(String(url)).toContain("/codex/responses"); probe();
  return new Response('data: {"type":"response.completed","response":{"id":"fixture-probe","status":"completed","output":[]}}\n\n', {headers: {"content-type": "text/event-stream", "x-codex-primary-used-percent": "1"}});
 }));
 await createAutomaticSubscriptionCheck(observe)(new AbortController().signal);
 const attempts = Object.entries(JSON.parse(await fs.readFile(`${path}.automatic-checks.json`, "utf8")));
 expect(attempts).toHaveLength(1); expect(attempts[0]?.[0]).toMatch(/^sha256:[a-f0-9]{64}$/); expect(attempts[0]?.[1]).toEqual(expect.any(Number));
 expect(oauth).toHaveBeenCalledTimes(1); expect(probe).toHaveBeenCalledTimes(1); expect(observe).toHaveBeenCalledTimes(1);
 const saved = (await loadAccounts())!.accounts[0]!;
 expect(saved).toMatchObject({accessToken: "fixture-rotated-access", refreshToken: "fixture-rotated-refresh"});
 expect(captureRefreshCredentialAuthority(saved, undefined, undefined, path)()).toBe(true);
 expect(await setCodexCliActiveSelection({accountId: saved.accountId!, accessToken: saved.accessToken!, refreshToken: saved.refreshToken, expiresAt: saved.expiresAt}, {account: saved, storagePath: path})).toBe(true);
 expect(JSON.parse(await fs.readFile(join(home, "auth.json"), "utf8")).tokens.refresh_token).toBe(saved.refreshToken);
 expect((await collectRestorableCredentials(path, true)).map(row => row.refreshToken)).toContain(saved.refreshToken);
 expect((await getAccountsBackupRecoveryCandidatesWithDiscovery(path, true))).toEqual(getAccountsBackupRecoveryCandidatesWithDiscoverySync(path));
});
it.each(["deleted", "revoked", "code-only", "replacement", "expiry", "workspace", "policy", "fallback"])("denies an automatic probe that loses its submitted authority during preparation (%s)", async change => {
 const storage = pool(); storage.accounts[0]!.expiresAt = Date.now() + 3600000;
 await fs.writeFile(path, JSON.stringify(storage));
 const policies: AccountPolicyStore = {version: 1, accounts: {}};
 upsertAccountPolicy(policies, getAccountPolicyKey(storage.accounts[0]!), policy => {policy.autoPrime = true;}); await saveAccountPolicyStore(policies);
 const gate = held(), preparation = vi.fn(), observe = vi.fn();
 vi.mocked(prompts.getCodexInstructions).mockImplementation(async () => {preparation(); if (change !== "fallback" || preparation.mock.calls.length === 2) await gate.promise; return "Fixture prompt";});
 const sends = vi.fn(async () => Response.json({error: {message: "model unsupported", code: "model_not_supported"}}, {status: 400}));
 vi.stubGlobal("fetch", sends);
 const pending = createAutomaticSubscriptionCheck(observe)(new AbortController().signal);
 try {
  await vi.waitFor(() => expect(preparation).toHaveBeenCalledTimes(change === "fallback" ? 2 : 1));
  if (change === "deleted" || change === "fallback") storage.accounts = [];
  if (change === "revoked") storage.accounts[0]!.authInvalidatedAt = Date.now();
  if (change === "code-only") storage.accounts[0]!.authInvalidationErrorCode = "token_invalidated";
  if (change === "replacement") storage.accounts[0]!.accessToken = "fixture-replacement";
  if (change === "expiry") storage.accounts[0]!.expiresAt! += 1;
  if (change === "workspace") storage.accounts[0]!.accountId = "other-workspace";
  if (change === "policy") {upsertAccountPolicy(policies, getAccountPolicyKey(storage.accounts[0]!), policy => {policy.autoPrime = false;}); await saveAccountPolicyStore(policies);}
  await fs.writeFile(path, JSON.stringify(storage)); gate.release(); await pending;
  expect(sends).toHaveBeenCalledTimes(change === "fallback" ? 1 : 0); expect(observe).not.toHaveBeenCalled();
 } finally {gate.release(); await pending; vi.mocked(prompts.getCodexInstructions).mockResolvedValue("Fixture instructions");}
});
it.each(["account", "workspace"].flatMap(kind => [1, 2].map(repeats => ({kind, repeats}))))("never republishes an old runtime disable after failed persistence and replacement (%j)", async ({kind, repeats}) => {
 const storage = pool(); storage.accounts[0]!.expiresAt = Date.now() + 3600000;
 storage.accounts[0]!.workspaces = [{id: "fixture-workspace", enabled: true}, {id: "other", enabled: true}];
 await fs.writeFile(path, JSON.stringify(storage));
 const manager = new AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
 const original = JSON.parse(await fs.readFile(path, "utf8")) as AccountStorageV3;
 const cause = Object.assign(Error("Fixture primary denied"), {code: "EBUSY"});
 const transaction = vi.spyOn(storageModule, "withAccountStorageTransaction").mockImplementation(async callback => callback(structuredClone(original), async () => {throw cause;}));
 for (let attempt = 0; attempt < repeats; attempt++) {
  const restricted = manager.withCurrentAccountCredential(account, {recordId: account.recordId, accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires, accountId: account.accountId}, () => {
   if (kind === "account") manager.setAccountEnabled(account.index, false);
   else manager.disableWorkspace(account, "fixture-workspace");
   return true;
  });
  // Account disablement denies another admission; workspace retries retain ownership.
  if (kind === "account" && attempt > 0) await expect(restricted).resolves.toBe(false);
  else await expect(restricted).rejects.toBe(cause);
 }
 transaction.mockRestore();
 const replacement = structuredClone(original); Object.assign(replacement.accounts[0]!, {accessToken: "fixture-B-access", refreshToken: "fixture-B-refresh", expiresAt: Date.now() + 7200000});
 await fs.writeFile(path, JSON.stringify(replacement)); await manager.saveToDisk(true);
 const saved = (await loadAccounts())!.accounts[0]!;
 expect(saved.refreshToken).toBe("fixture-B-refresh"); expect(saved.enabled).not.toBe(false);
 expect(saved.workspaces?.find(workspace => workspace.id === "fixture-workspace")).toMatchObject({enabled: true});
});
it("preserves explicit operator disablement when a newer credential is adopted", async () => {
 const storage = pool(), manager = new AccountManager(undefined, storage);
 manager.setAccountEnabled(0, false);
 const replacement = structuredClone(storage); Object.assign(replacement.accounts[0]!, {accessToken: "fixture-B", refreshToken: "fixture-B-refresh", expiresAt: Date.now() + 7200000});
 await fs.writeFile(path, JSON.stringify(replacement)); await manager.saveToDisk();
 expect((await loadAccounts())!.accounts[0]).toMatchObject({refreshToken: "fixture-B-refresh", enabled: false});
});
it("preserves operator confirmation of an earlier failed runtime disable across replacement", async () => {
 const storage = pool(), manager = new AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
 const transaction = vi.spyOn(storageModule, "withAccountStorageTransaction").mockImplementationOnce(async callback => callback(structuredClone(storage), async () => {throw Object.assign(Error("fixture denied"), {code: "EBUSY"});}));
 await expect(manager.withCurrentAccountCredential(account, {recordId: account.recordId, accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires, accountId: account.accountId}, () => {manager.setAccountEnabled(0, false); return true;})).rejects.toMatchObject({code: "EBUSY"});
 transaction.mockRestore(); manager.setAccountEnabled(0, false);
 const replacement = structuredClone(storage); Object.assign(replacement.accounts[0]!, {accessToken: "fixture-B", refreshToken: "fixture-B-refresh", expiresAt: Date.now() + 7200000});
 await fs.writeFile(path, JSON.stringify(replacement)); await manager.saveToDisk();
 expect((await loadAccounts())!.accounts[0]).toMatchObject({refreshToken: "fixture-B-refresh", enabled: false});
});
it("separates one metadata reconciliation from the owned result publication and denies later churn", async () => {
 const storage = pool(), owner = structuredClone(storage.accounts[0]!);
 const current = captureRefreshCredentialAuthority(owner, undefined, undefined, path);
 storage.accounts.push({...owner, recordId: "fixture-other", refreshToken: "fixture-other-refresh"});
 await fs.writeFile(path, JSON.stringify(storage)); expect(current()).toBe(true);
 const result = {type: "success" as const, access: "fixture-owned-result", refresh: "fixture-owned-refresh", expires: 2};
 Object.assign(storage.accounts[0]!, {accessToken: result.access, refreshToken: result.refresh, expiresAt: result.expires});
 await fs.writeFile(path, JSON.stringify(storage)); expect(current(result)).toBe(true);
 storage.accounts[1]!.lastUsed += 1; await fs.writeFile(path, JSON.stringify(storage)); expect(current(result)).toBe(false);
});
it.each(["authInvalidatedAt", "authInvalidationErrorCode"] as const)("does not let result publication supersede a new durable %s", async marker => {
 const storage = pool(), current = captureRefreshCredentialAuthority(storage.accounts[0]!, undefined, undefined, path);
 const result = {type: "success" as const, access: "fixture-owned-result", refresh: "fixture-owned-refresh", expires: 2};
 Object.assign(storage.accounts[0]!, {accessToken: result.access, refreshToken: result.refresh, expiresAt: result.expires}, {[marker]: marker === "authInvalidatedAt" ? 100 : "token_invalidated"});
 await fs.writeFile(path, JSON.stringify(storage)); expect(current(result)).toBe(false);
});
it("selects a unique durable member among duplicate refresh tokens and rejects ambiguous aliases", async () => {
 const storage = pool(); storage.accounts[0]!.recordId = undefined;
 storage.accounts.push({...storage.accounts[0]!, email: "fixture-second@example.test"});
 await fs.writeFile(path, JSON.stringify(storage));
 expect(captureRefreshCredentialAuthority(storage.accounts[1]!, undefined, undefined, path)()).toBe(true);
 expect(() => captureRefreshCredentialAuthority({type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1}, undefined, undefined, path)).toThrow(expect.objectContaining({code: "EPENDINGAUTHADMISSION"}));
});
it("fails closed before OAuth when discovered roots exceed the existing 1000-owner bound", async () => {
 await Promise.all(Array.from({length: 1001}, (_, i) => fs.writeFile(`${path}.history-${i}`, JSON.stringify(pool()))));
 const oauth = vi.fn(async () => ({type: "failed" as const}));
 expect(() => getAccountsBackupRecoveryCandidatesWithDiscoverySync(path)).toThrow();
 await expect(getAccountsBackupRecoveryCandidatesWithDiscovery(path, true)).rejects.toThrow();
 await expect(withPendingAuthRefresh(path, "fixture-refresh", oauth)).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 expect(oauth).not.toHaveBeenCalled(); expect(await fs.stat(getPendingAuthPath(path)).catch(() => null)).toBeNull();
});
it("bounds distinct retained credential proof across individually valid recovery roots", async () => {
 const rows = Array.from({length: 501}, (_, i) => ({...pool().accounts[0]!, recordId: `proof-${i}`, refreshToken: `fixture-proof-${i}`}));
 await fs.writeFile(`${path}.bak`, JSON.stringify({version: 3, activeIndex: 0, accounts: rows}));
 await fs.writeFile(`${path}.bak.1`, JSON.stringify({version: 3, activeIndex: 0, accounts: rows.map((row, i) => ({...row, recordId: `proof-other-${i}`, refreshToken: `fixture-proof-other-${i}`}))}));
 await expect(collectRestorableCredentials(path)).rejects.toThrow();
});
it("accepts exactly 1000 distinct credential proofs without counting backup duplicates twice", async () => {
 const rows = Array.from({length: 1000}, (_, i) => ({...pool().accounts[0]!, recordId: `proof-${i}`, refreshToken: `fixture-proof-${i}`}));
 for (const suffix of [".bak", ".bak.1"]) await fs.writeFile(`${path}${suffix}`, JSON.stringify({version: 3, activeIndex: 0, accounts: rows}));
 expect(new Set((await collectRestorableCredentials(path)).map(row => row.refreshToken)).size).toBe(1000);
});
it("still denies a malformed unknown discovered recovery file without spending OAuth", async () => {
 await fs.writeFile(`${path}.unknown-history`, JSON.stringify({timestamps: []}));
 const oauth = vi.fn(async () => ({type: "failed" as const}));
 await expect(withPendingAuthRefresh(path, "fixture-refresh", oauth)).rejects.toMatchObject({code: "EPENDINGAUTHADMISSION"});
 expect(oauth).not.toHaveBeenCalled(); expect(await fs.stat(getPendingAuthPath(path)).catch(() => null)).toBeNull();
});
it("denies a previously managed owner when every primary and backup is gone", async () => {
 const manager = new AccountManager(undefined, pool()), owner = manager.getAccountByIndex(0)!;
 await fs.unlink(path); const oauth = vi.fn(async () => ({type: "failed" as const}));
 expect(() => captureRefreshCredentialAuthority(owner, () => manager.getAccountByIndex(0) === owner, undefined, path)).toThrow(expect.objectContaining({code: "EPENDINGAUTHADMISSION"}));
 expect(oauth).not.toHaveBeenCalled();
});
it("denies an already existing reset marker before a missing-primary queue can spend", async () => {
 await fs.unlink(path); await fs.writeFile(getIntentionalResetMarkerPath(path), "{}");
 const oauth = vi.fn(async () => ({type: "success" as const, access: "fixture-new", refresh: "fixture-new-refresh", expires: Date.now() + 3600000}));
 await expect(withPendingAuthRefresh(path, "fixture-refresh", oauth)).rejects.toMatchObject({code: "ESTALE"});
 expect(oauth).not.toHaveBeenCalled(); expect(await fs.stat(getPendingAuthPath(path)).catch(() => null)).toBeNull();
});
