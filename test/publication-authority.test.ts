import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
import { refreshAndUpdateToken } from "../lib/request/token-refresh.js";
import { resetRefreshQueue } from "../lib/refresh-queue.js";
import { loadAccounts, setStoragePathDirect, withAccountStorageTransaction, type AccountStorageV3 } from "../lib/storage.js";
import { getPendingAuthPath, PendingAuthSettlementError } from "../lib/storage/pending-auth.js";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let dir: string, path: string;
const children: ChildProcess[] = [];
const pool = (): AccountStorageV3 => ({version: 3, activeIndex: 0, accounts: [{recordId: "owner", accountId: "workspace", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: 1, addedAt: 1, lastUsed: 1}]});
const gate = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};
beforeEach(async () => {
 dir = await fs.mkdtemp(join(tmpdir(), "publication-authority-")); path = join(dir, "pool.json");
 setStoragePathDirect(path); await fs.writeFile(path, JSON.stringify(pool()));
 vi.stubEnv("CODEX_AUTH_REFRESH_LEASE", "0");
 vi.stubEnv("CODEX_CLI_AUTH_PATH", join(dir, "auth.json"));
 vi.stubEnv("CODEX_CLI_ACCOUNTS_PATH", join(dir, "mirror.json"));
 vi.stubEnv("CODEX_CLI_CONFIG_PATH", join(dir, "config.toml"));
 vi.stubEnv("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
});
afterEach(async () => {
 vi.restoreAllMocks(); vi.unstubAllEnvs(); resetRefreshQueue(); setStoragePathDirect(null);
 for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;}
 await removeWithRetry(dir, {recursive: true, force: true});
});

it.each(["healthy", "expiry", "auth", "host-error"])("preserves raw refresh-only authority separately from SDK auth (%s)", async change => {
 const storage = pool(); delete storage.accounts[0]!.accessToken; delete storage.accounts[0]!.expiresAt;
 await fs.writeFile(path, JSON.stringify(storage));
 const manager = new AccountManager(undefined, await loadAccounts()), account = manager.getAccountByIndex(0)!;
 const auth = manager.toAuthDetails(account);
 expect(auth).toMatchObject({access: "", expires: 0}); expect(account.expires).toBeUndefined();
 const entered = gate(), release = gate();
 const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {entered.resolve(); await release.promise; return Response.json({access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600});});
 const cause = Object.assign(Error("fixture setter failed"), {code: "ENOSPC"});
 const setter = vi.fn(async () => {if (change === "host-error") throw cause;});
 const pending = refreshAndUpdateToken(auth, {auth: {set: setter}} as never, {accountManager: manager, account}).catch(error => error);
 await Promise.race([entered.promise, pending.then(value => {throw value instanceof Error ? value : Error("Refresh finished before fixture OAuth admission");})]);
 if (change === "expiry") account.expires = 0;
 if (change === "auth" && auth.type === "oauth") auth.expires = 2;
 release.resolve(); const outcome = await pending;
 if (change === "healthy") {
  expect(outcome).toBe(auth); expect(setter).toHaveBeenCalledOnce();
  if (auth.type !== "oauth") throw Error("Expected OAuth fixture");
  expect(await manager.commitRefreshedAuth(account, auth)).toBe(account);
  expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("next-refresh");
 } else if (change === "host-error") {
  expect(outcome).toBeInstanceOf(PendingAuthSettlementError); expect(outcome.cause).toBe(cause);
  expect(auth).toMatchObject({access: "next-access", refresh: "next-refresh"}); expect(account.refreshToken).toBe("next-refresh");
 } else {expect(outcome.code).toBe("EPENDINGAUTHADMISSION"); expect(setter).not.toHaveBeenCalled();}
 expect(fetch).toHaveBeenCalledOnce();
});

it.each(["EBUSY", "EINVAL"])("preserves the first primary error when rescue observation is corrupt (%s)", async code => {
 const manager = new AccountManager(undefined, await loadAccounts()), account = manager.getAccountByIndex(0)!;
 account.consecutiveAuthFailures = 2; manager.markAccountCoolingDown(account, 60000, "auth-failure");
 const cooldown = account.coolingDownUntil;
 vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => undefined);
 const cause = Object.assign(Error("fixture primary failed"), {code});
 const rename = fs.rename.bind(fs);
 vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
  if (String(to) === path) {await fs.writeFile(getPendingAuthPath(path), "{"); throw cause;}
  return rename(from, to);
 });
 const error = await manager.commitRefreshedAuth(account, {type: "oauth", access: "next-access", refresh: "next-refresh", expires: 2}).catch(value => value);
 expect(error).toBeInstanceOf(PendingAuthSettlementError); expect(error.cause.cause).toBe(cause); expect(error.durability).toBe("unverified");
 expect(error.result.refresh).toBe("next-refresh"); expect(account).toMatchObject({refreshToken: "fixture-refresh", consecutiveAuthFailures: 2, coolingDownUntil: cooldown});
});

it.each(["healthy", "reset", "disable", "expiry", "journal"])("checks managed ownership after async mirror reads (%s)", async change => {
 const source = pool().accounts[0]!;
 const selection = {accountId: source.accountId, accessToken: source.accessToken, refreshToken: source.refreshToken, expiresAt: source.expiresAt};
 const original = JSON.stringify({tokens: {access_token: "desktop", refresh_token: "desktop-refresh"}});
 await fs.writeFile(join(dir, "auth.json"), original);
 const read = fs.readFile.bind(fs); let armed = true;
 vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
  const result = await read(...args);
  if (armed && String(args[0]) === join(dir, "auth.json")) {
   armed = false;
   if (change === "reset") await fs.writeFile(getIntentionalResetMarkerPath(path), "{}");
   else if (change === "journal") await fs.writeFile(getPendingAuthPath(path), "{");
   else if (change !== "healthy") {const disk = pool(); if (change === "disable") disk.accounts[0]!.enabled = false; else disk.accounts[0]!.expiresAt = 2; await fs.writeFile(path, JSON.stringify(disk));}
  }
  return result;
 });
 expect(await setCodexCliActiveSelection(selection, {account: source})).toBe(change === "healthy");
 const written = await read(join(dir, "auth.json"), "utf8");
 if (change === "healthy") expect(JSON.parse(written).tokens.refresh_token).toBe(source.refreshToken);
 else expect(written).toBe(original);
});

it("reuses a held pool transaction without mirror queue inversion", async () => {
 const source = pool().accounts[0]!;
 const selection = {accountId: source.accountId, accessToken: source.accessToken, refreshToken: source.refreshToken, expiresAt: source.expiresAt};
 const start = gate();
 const outsider = start.promise.then(() => setCodexCliActiveSelection(selection, {account: source}));
 await withAccountStorageTransaction(async () => {
  start.resolve();
  expect(await setCodexCliActiveSelection(selection, {account: source})).toBe(true);
 });
 expect(await outsider).toBe(true);
});

it("rejects queued stale selection after a subprocess native lock wait", async () => {
 const script = join(dir, "binding-lock.mjs");
 buildSync({stdin: {contents: `import {withNativeBindingLock} from "./lib/runtime/native-binding-lock.js"; await withNativeBindingLock(process.argv[2], async () => {process.send("held"); await new Promise(done => process.once("message", done));}); process.disconnect();`, resolveDir: process.cwd()}, bundle: true, format: "esm", platform: "node", outfile: script, logLevel: "silent"});
 const child = fork(script, [join(dir, "config.toml")], {stdio: ["ignore", "ignore", "ignore", "ipc"]}); children.push(child);
 await once(child, "message");
 const source = pool().accounts[0]!;
 const entered = gate(); const lock = await import("../lib/runtime/native-binding-lock.js"); const actual = lock.withNativeBindingLock;
 vi.spyOn(lock, "withNativeBindingLock").mockImplementation((config, action) => {entered.resolve(); return actual(config, action);});
 const pending = setCodexCliActiveSelection({accountId: source.accountId, accessToken: source.accessToken, refreshToken: source.refreshToken, expiresAt: source.expiresAt}, {account: source});
 await entered.promise;
 const disk = pool(); disk.accounts[0]!.refreshToken = "replacement"; await fs.writeFile(path, JSON.stringify(disk));
 child.send("release"); expect(await pending).toBe(false);
 await expect(fs.readFile(join(dir, "auth.json"))).rejects.toMatchObject({code: "ENOENT"});
});
