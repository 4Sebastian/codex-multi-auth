import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { clearCircuitBreakers, type CircuitAdmissionReceipt } from "../lib/circuit-breaker.js";
import { createAccountDispatch } from "../lib/request/account-dispatch.js";
import { PendingAuthAdmissionError } from "../lib/storage/pending-auth.js";
import { createNativeAccountStorageReader } from "../lib/runtime/native-account-storage.js";
import { loadAccounts, setStoragePathDirect, withAccountStorageTransaction, type AccountStorageV3 } from "../lib/storage.js";
import { getAccountPolicyKey, updateAccountPolicyStore, upsertAccountPolicy } from "../lib/account-policy.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { mergeAccountSnapshot, mergeAccountRuntimeObservations } from "../lib/storage/snapshot-merge.js";

let dir: string, path: string;
const managers: AccountManager[] = [];
beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "recovered-authority-"));
    path = join(dir, "accounts.json");
    vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
    setStoragePathDirect(path);
});
afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.flushPendingSave();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCircuitBreakers(); setStoragePathDirect(null);
    await removeWithRetry(dir, {recursive: true, force: true});
});
function pool(): AccountStorageV3 {
    return {version: 3, activeIndex: 0, accounts: ["A", "B"].map(id => ({recordId: id, accountId: id, refreshToken: `refresh-${id}`, accessToken: `access-${id}`, expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}))};
}

it.each(["healthy", "code-only", "zero", "negative", "zero-only", "negative-only"])("preserves native denial through load, unrelated save and reload (%s)", async mode => {
    const storage = pool(), row = storage.accounts[0]!;
    if (mode !== "healthy") {
        if (!mode.endsWith("-only") || mode === "code-only") row.authInvalidationErrorCode = "token_invalidated";
        if (mode.startsWith("zero")) row.authInvalidatedAt = 0;
        if (mode.startsWith("negative")) row.authInvalidatedAt = -1;
    }
    await fs.writeFile(path, JSON.stringify(storage));
    const read = createNativeAccountStorageReader(undefined, path);
    expect((await read()).verified).toBe(mode === "healthy");
    const loaded = await loadAccounts();
    if (!loaded) throw Error("Missing fixture pool");
    const manager = new AccountManager(undefined, loaded); managers.push(manager);
    manager.getAccountByIndex(1)!.lastUsed = 123;
    await manager.saveToDisk();
    const saved = JSON.parse(await fs.readFile(path, "utf8"));
    expect(saved.accounts[0].accessToken).toBe("access-A");
    expect(saved.accounts[0].authInvalidatedAt).toBe(row.authInvalidatedAt);
    expect(saved.accounts[0].authInvalidationErrorCode).toBe(row.authInvalidationErrorCode);
    expect((await read()).verified).toBe(mode === "healthy");
    const reloaded = await loadAccounts();
    if (!reloaded) throw Error("Missing reloaded pool");
    const restarted = new AccountManager(undefined, reloaded); managers.push(restarted);
    expect(restarted.isAccountAuthInvalidated(restarted.getAccountByIndex(0)!)).toBe(mode !== "healthy");
    expect(restarted.isAccountAuthInvalidated(restarted.getAccountByIndex(1)!)).toBe(false);
    // Only a separately committed replacement generation removes predecessor denial.
    await withAccountStorageTransaction(async (current, persist) => {
        if (!current) throw Error("Missing recovery pool");
        Object.assign(current.accounts[0]!, {accessToken: "recovered-A", refreshToken: "recovered-refresh-A"});
        delete current.accounts[0]!.authInvalidatedAt;
        delete current.accounts[0]!.authInvalidationErrorCode;
        await persist(current);
    });
    expect((await read()).verified).toBe(true);
    manager.getAccountByIndex(1)!.lastUsed = 124;
    await manager.saveToDisk();
    const recovered = await read();
    expect(recovered.verified).toBe(true);
    expect(recovered.storage?.accounts[0]?.accessToken).toBe("recovered-A");
});

it.each([undefined, 0, -1])("keeps orphaned denial when both snapshots omit it, including runtime-only conflict rescue (%s)", timestamp => {
    const base = pool();
    Object.assign(base.accounts[0]!, {authInvalidatedAt: timestamp, authInvalidationErrorCode: "token_invalidated"});
    const disk = structuredClone(base), local = structuredClone(base);
    for (const storage of [disk, local]) {
        delete storage.accounts[0]!.authInvalidatedAt;
        delete storage.accounts[0]!.authInvalidationErrorCode;
    }
    for (const merge of [mergeAccountSnapshot, mergeAccountRuntimeObservations]) {
        expect(merge(base, disk, local).accounts[0]).toMatchObject({authInvalidatedAt: timestamp, authInvalidationErrorCode: "token_invalidated"});
        const recovered = structuredClone(disk);
        Object.assign(recovered.accounts[0]!, {accessToken: "new-generation", refreshToken: "new-generation-refresh"});
        const saved = merge(base, recovered, local).accounts[0]!;
        expect(saved.accessToken).toBe("new-generation");
        expect(saved.authInvalidatedAt).toBeUndefined();
        expect(saved.authInvalidationErrorCode).toBeUndefined();
    }
});

it.each(["paused", "drained", "eligible", "other-paused", "target-removed", "replacement"])("binds the evaluated policy to the selected account across held reindexing (%s)", async mode => {
    const storage = pool();
    await fs.writeFile(path, JSON.stringify(storage));
    const manager = new AccountManager(undefined, storage); managers.push(manager);
    const first = manager.getAccountByIndex(0)!, selected = manager.getAccountByIndex(1)!;
    if (["paused", "drained", "other-paused"].includes(mode)) {
        await updateAccountPolicyStore(store => {
            upsertAccountPolicy(store, getAccountPolicyKey(mode === "other-paused" ? first : selected), policy => {
                if (mode === "drained") policy.drained = true;
                else policy.paused = true;
            });
            return {result: undefined, dirty: true};
        });
    }
    let admission: CircuitAdmissionReceipt | undefined;
    manager.consumeToken(selected, "codex", "gpt-5.1", {onAdmission: receipt => {admission = receipt;}});
    if (!admission) throw Error("Missing fixture admission");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => {entered = resolve;});
    const held = new Promise<void>(resolve => {release = resolve;});
    const authorize = manager.withCurrentAccountCredential.bind(manager);
    vi.spyOn(manager, "withCurrentAccountCredential").mockImplementation(async (...args) => {entered(); await held; return authorize(...args);});
    const dispatch = createAccountDispatch({manager, account: selected, submitted: {recordId: selected.recordId, accountId: selected.accountId, accessToken: selected.access, refreshToken: selected.refreshToken, expiresAt: selected.expires}, admission, family: "codex", model: "gpt-5.1", eligible: () => true});
    const send = vi.fn(async () => Response.json({id: "accepted"}));
    const pending = dispatch(send).catch(error => error);
    await ready;
    manager.removeAccount(mode === "target-removed" ? selected : first);
    if (mode === "replacement") {
        storage.accounts[1]!.accessToken = "replacement-B";
        await fs.writeFile(path, JSON.stringify(storage));
    }
    release();
    const result = await pending;
    const allowed = mode === "eligible" || mode === "other-paused";
    if (allowed) expect(await result.json()).toEqual({id: "accepted"});
    else expect(result).toBeInstanceOf(PendingAuthAdmissionError);
    expect(send).toHaveBeenCalledTimes(allowed ? 1 : 0);
});
