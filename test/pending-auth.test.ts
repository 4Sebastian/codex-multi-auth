import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPendingAuth, getPendingAuthPath, prunePendingAuth, recordPendingAuth } from "../lib/storage/pending-auth.js";
import type { AccountStorageV3 } from "../lib/storage/public-types.js";

const logs = vi.hoisted(() => ({error:vi.fn(),warn:vi.fn()}));
vi.mock("../lib/logger.js", async importOriginal => {
 const actual=await importOriginal<typeof import("../lib/logger.js")>();
 return {...actual,createLogger:(name:string)=>({...actual.createLogger(name),error:logs.error,warn:logs.warn})};
});
let dir: string;
let storagePath: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "pending-auth-"));
	storagePath = join(dir, "accounts.json");
});
afterEach(async () => {
	vi.restoreAllMocks();
 vi.clearAllMocks();
 const {setStoragePathDirect}=await import("../lib/storage.js");setStoragePathDirect(null);
	await fs.rm(dir, { recursive: true, force: true });
});
const rotation = (prior: string, next: string) => ({ priorRefreshToken: prior, refreshToken: next, accessToken: `access-${next}`, expiresAt: 1, at: 1 });
const storage = () => ({ version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "spent-a", addedAt: 1, lastUsed: 1 }, { refreshToken: "spent-b", addedAt: 1, lastUsed: 1 }] });
function failReads(code: string, times: number, skip = 0) {
	const path = getPendingAuthPath(storagePath);
	const original = fs.readFile.bind(fs);
	let left = times;
	return vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...rest: unknown[]) => {
		if (String(file) === path) {
			if (skip > 0) skip--;
			else if (left-- > 0) throw Object.assign(new Error("busy"), {code});
		}
		return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
	}) as typeof fs.readFile);
}

it("retries a transient lock and keeps other accounts' pending tokens", async () => {
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	failReads("EBUSY", 2);
	await recordPendingAuth(storagePath, rotation("spent-b", "new-b"));
	vi.restoreAllMocks();
	const applied = await applyPendingAuth(storagePath, storage());
	expect(applied?.accounts.map((a) => a.refreshToken)).toEqual(["new-a", "new-b"]);
});

it("refuses to overwrite when the pending file stays unreadable", async () => {
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	failReads("EBUSY", 1000);
	await expect(recordPendingAuth(storagePath, rotation("spent-b", "new-b"))).rejects.toThrow();
	vi.restoreAllMocks();
	const applied = await applyPendingAuth(storagePath, storage());
	expect(applied?.accounts[0]?.refreshToken).toBe("new-a");
});

it("never overwrites a corrupt pending file", async () => {
	const path = getPendingAuthPath(storagePath);
	await fs.writeFile(path, "{torn");
	await expect(recordPendingAuth(storagePath, rotation("spent-b", "new-b"))).rejects.toThrow();
	await expect(prunePendingAuth(storagePath, storage())).rejects.toThrow();
	expect(await fs.readFile(path, "utf8")).toBe("{torn");
});

it.each(["probe", "renewal"].flatMap(mode => [0, 1].map(skip => ({mode, skip}))))("refuses false recovery after required journal capture fails (%j)", async ({mode, skip}) => {
 const {saveAccounts,loadAccounts,setStoragePathDirect}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);
 await saveAccounts({version:3,activeIndex:0,accounts:[{recordId:"first",refreshToken:"b",accessToken:"access-b",expiresAt:10000,addedAt:1,lastUsed:1}]});
 await recordPendingAuth(storagePath,{...rotation("b","b"),recordId:"first",expiresAt:10000,authInvalidatedAt:1500});
 const pool=(await loadAccounts())!;
 delete pool.accounts[0]!.authInvalidatedAt;
 if(mode==="renewal") Object.assign(pool.accounts[0]!,{accessToken:"access-new",expiresAt:20000});
 failReads("EBUSY",6,skip);
 await expect(saveAccounts(pool)).rejects.toThrow();
 expect((await loadAccounts())?.accounts[0]?.accessToken).toBe("access-b");
 expect((await loadAccounts())?.accounts[0]?.authInvalidatedAt).toBe(1500);
 await saveAccounts(pool);
 const restarted=(await loadAccounts())!;
 expect(restarted.accounts[0]?.accessToken).toBe(pool.accounts[0]?.accessToken);
 expect(restarted.accounts[0]?.authInvalidatedAt).toBeUndefined();
});
it("never logs journal contents on read or post-save prune failures",async()=>{
 const {saveAccounts,setStoragePathDirect}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);
 await fs.writeFile(getPendingAuthPath(storagePath),'fixture-secret');
 await applyPendingAuth(storagePath,storage());
 await expect(saveAccounts(storage())).rejects.toThrow("Failed to observe pending account recovery");
 expect(logs.error).toHaveBeenCalled();expect(logs.warn).toHaveBeenCalled();
 expect(JSON.stringify([logs.error.mock.calls,logs.warn.mock.calls])).not.toContain("fixture-secret");
});
it("clears the pending journal only after its writer releases the lock",async()=>{
 const {withFileTransactionLock}=await import("../lib/storage/file-lock.js");
 const {clearAccounts,setStoragePathDirect,saveAccounts}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);await saveAccounts(storage());
 const path=getPendingAuthPath(storagePath);
 let release!:()=>void, entered!:()=>void,attempted!:()=>void;
 const gate=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r),attempt=new Promise<void>(r=>attempted=r);
 const writer=withFileTransactionLock(path,async()=>{entered();await gate;await fs.writeFile(path,"private fixture");});
 await inside;
 const lockPath=join(await fs.realpath(dir), "accounts.json.pending-auth.json.write-lock");
 const original=fs.rename.bind(fs);
 vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{if(String(to)===lockPath)attempted();return original(from,to);});
 const remove=vi.spyOn(fs,"rm");
 const clear=clearAccounts();
 try {
  await Promise.race([attempt,clear]);
  expect(remove.mock.calls.some(([file])=>String(file)===path)).toBe(false);
 } finally {release();await writer;await clear;}
 await expect(fs.stat(path)).rejects.toMatchObject({code:"ENOENT"});
});
it("retries a transient Windows lock when clearing pending credentials",async()=>{
 const {clearAccounts,setStoragePathDirect,saveAccounts}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);await saveAccounts(storage());
 await recordPendingAuth(storagePath,rotation("spent-a","fresh"));
 const path=getPendingAuthPath(storagePath),original=fs.rm.bind(fs);let attempts=0;
 vi.spyOn(fs,"rm").mockImplementation(async(file,options)=>{
  if(String(file)===path && ++attempts===1)throw Object.assign(new Error("busy"),{code:"EBUSY"});
  return original(file,options);
 });
 await clearAccounts();expect(attempts).toBe(2);
 await expect(fs.stat(path)).rejects.toMatchObject({code:"ENOENT"});
});
it("refuses a late rotated credential after the pool was reset",async()=>{
 const {clearAccounts,setStoragePathDirect,saveAccounts}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);await saveAccounts(storage());await clearAccounts();
 await expect(recordPendingAuth(storagePath,rotation("spent-a","late"))).rejects.toMatchObject({code:"ESTALE"});
 await expect(fs.stat(getPendingAuthPath(storagePath))).rejects.toMatchObject({code:"ENOENT"});
});
it.each(["auth-failure","network-error","rate-limit"] as const)("only clears obsolete authentication blockers when replaying journaled auth (%s)",async reason=>{
 await recordPendingAuth(storagePath,{...rotation("spent-a","fresh"), accessToken: `e30.${Buffer.from(JSON.stringify({iat: 2})).toString("base64url")}.fixture`});
 const pool=storage();Object.assign(pool.accounts[0]!,{coolingDownUntil:Date.now()+60000,cooldownReason:reason,authInvalidatedAt:1});
 const result=await applyPendingAuth(storagePath,pool);
 expect(result?.accounts[0]?.authInvalidatedAt).toBeUndefined();
 if(reason==="auth-failure")expect(result?.accounts[0]?.coolingDownUntil).toBeUndefined();
 else expect(result?.accounts[0]?.cooldownReason).toBe(reason);
});

it("keeps the journal within its cap so a full file never strands every pending token", async () => {
	const { createHash } = await import("node:crypto");
	const sha = (token: string) => createHash("sha256").update(token).digest("hex");
	const path = getPendingAuthPath(storagePath);
	const seeded = Array.from({ length: 1000 }, (_, i) => ({ prior: sha(`old-${i}`), refreshToken: `new-old-${i}`, accessToken: "a", expiresAt: 1, at: 10 + i }));
	await fs.writeFile(path, JSON.stringify({ version: 1, entries: seeded }));
	await recordPendingAuth(storagePath, { ...rotation("spent-a", "new-a"), at: 5000 });
	const applied = await applyPendingAuth(storagePath, { version: 3, activeIndex: 0, accounts: [{ refreshToken: "spent-a", addedAt: 1, lastUsed: 1 }, { refreshToken: "old-999", addedAt: 1, lastUsed: 1 }] });
	expect(applied?.accounts.map((a) => a.refreshToken)).toEqual(["new-a", "new-old-999"]);
	const entries = JSON.parse(await fs.readFile(path, "utf8")).entries as { prior: string }[];
	expect(entries).toHaveLength(1000);
	expect(entries.some((entry) => entry.prior === sha("old-0"))).toBe(false);
	expect(logs.warn).toHaveBeenCalled();
});

it("still reads and trims an over-cap journal an earlier writer left behind", async () => {
	const { createHash } = await import("node:crypto");
	const sha = (token: string) => createHash("sha256").update(token).digest("hex");
	const path = getPendingAuthPath(storagePath);
	const seeded = Array.from({ length: 1001 }, (_, i) => ({ prior: sha(`old-${i}`), refreshToken: `new-old-${i}`, accessToken: "a", expiresAt: 1, at: 10 + i }));
	await fs.writeFile(path, JSON.stringify({ version: 1, entries: seeded }));
	const applied = await applyPendingAuth(storagePath, { version: 3, activeIndex: 0, accounts: [{ refreshToken: "old-5", addedAt: 1, lastUsed: 1 }] });
	expect(applied?.accounts[0]?.refreshToken).toBe("new-old-5");
	await recordPendingAuth(storagePath, { ...rotation("spent-a", "new-a"), at: 5000 });
	expect(JSON.parse(await fs.readFile(path, "utf8")).entries).toHaveLength(1000);
});

it("preserves the automatic attempt identity when legacy credentials recover from a failed save", async () => {
    const { resolveAccountRecordId } = await import("../lib/accounts.js");
    const { automaticAccountCheckKey } = await import("../lib/runtime/automatic-account-checks.js");
    const pool = storage();
    const original = pool.accounts[0]!;
    const key = automaticAccountCheckKey(original);
    const auth = { ...rotation("spent-a", "new-a"), recordId: resolveAccountRecordId(original) };
    await recordPendingAuth(storagePath, auth);
    await recordPendingAuth(storagePath, rotation("new-a", "newer-a"));
    const restored = await applyPendingAuth(storagePath, pool);
    expect(restored?.accounts[0]?.refreshToken).toBe("newer-a");
    expect(automaticAccountCheckKey(restored!.accounts[0]!)).toBe(key);
});

it("saves recovered legacy credentials without changing the original record identity", async () => {
    const storageModule = await import("../lib/storage.js");
    const { AccountManager, resolveAccountRecordId } = await import("../lib/accounts.js");
    storageModule.setStoragePathDirect(storagePath);
    const pool = storage();
    await storageModule.saveAccounts(pool);
    const originalId = resolveAccountRecordId(pool.accounts[0]!);
    const manager = new AccountManager(undefined, await storageModule.loadAccounts());
    const transaction = vi.spyOn(storageModule, "withAccountStorageTransaction").mockRejectedValueOnce(Object.assign(new Error("busy"), {code:"EBUSY"}));
    try {
        await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, {type:"oauth",refresh:"rotated",access:"access-rotated",expires:Date.now()+3600000});
    } finally { transaction.mockRestore(); }
    await manager.flushPendingSave();
    const saved = await storageModule.loadAccounts();
    expect(saved?.accounts).toHaveLength(2);
    expect(saved?.accounts[0]).toMatchObject({ recordId: originalId, refreshToken: "rotated" });
});

it("keeps an entry while a recovery source still holds its spent token, then prunes it", async () => {
	const { createHash } = await import("node:crypto");
	const sha = (token: string) => createHash("sha256").update(token).digest("hex");
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	const saved = { version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "new-a", addedAt: 1, lastUsed: 1 }] };
	// A backup slot still holding the spent token keeps the entry.
	await prunePendingAuth(storagePath, saved, async () => ["spent-a"]);
	const kept = JSON.parse(await fs.readFile(getPendingAuthPath(storagePath), "utf8")) as { entries: { prior: string }[] };
	expect(kept.entries.some((entry) => entry.prior === sha("spent-a"))).toBe(true);
	// Once no source can surface it, the entry (and the file) goes away.
	await prunePendingAuth(storagePath, saved, async () => []);
	await expect(fs.stat(getPendingAuthPath(storagePath))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps every entry when the recovery-source scan fails", async () => {
	const { createHash } = await import("node:crypto");
	const sha = (token: string) => createHash("sha256").update(token).digest("hex");
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	const saved = { version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "new-a", addedAt: 1, lastUsed: 1 }] };
	await prunePendingAuth(storagePath, saved, async () => { throw new Error("scan failed"); });
	expect(logs.warn).toHaveBeenCalled();
	const kept = JSON.parse(await fs.readFile(getPendingAuthPath(storagePath), "utf8")) as { entries: { prior: string }[] };
	expect(kept.entries.some((entry) => entry.prior === sha("spent-a"))).toBe(true);
});

it.each(["invalidated", "disabled"] as const)("replays journaled credentials without removing %s authorization", async state => {
	const auth = {
		...rotation("spent-a", "new-a"),
		...(state === "invalidated"
			? {authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"}
			: {enabled: false as const}),
	};
	await recordPendingAuth(storagePath, auth);
	const restored = await applyPendingAuth(storagePath, storage());
	expect(restored?.accounts[0]).toMatchObject({refreshToken: "new-a", accessToken: "access-new-a"});
	if (state === "invalidated") expect(restored?.accounts[0]).toMatchObject({authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"});
	else expect(restored?.accounts[0]?.enabled).toBe(false);
});

it("never rewinds a chained rotation when a delayed rescue journals its older attempt", async () => {
	await recordPendingAuth(storagePath, rotation("a", "b"));
	await recordPendingAuth(storagePath, rotation("b", "c"));
	const retained = await recordPendingAuth(storagePath, {...rotation("a", "b"), at: 1000});
	expect(retained).toMatchObject({refreshToken: "c", accessToken: "access-c"});
	for (const token of ["a", "b"]) {
		const pool = {version: 3 as const, activeIndex: 0, accounts: [{refreshToken: token, addedAt: 1, lastUsed: 1}]};
		expect((await applyPendingAuth(storagePath, pool))?.accounts[0]?.refreshToken).toBe("c");
	}
});

it.each(["plain", "invalidated", "disabled", "old-revocation"])("retains the authoritative lineage after its intermediate alias is pruned (%s)", async state => {
	const pool = (token: string): AccountStorageV3 => ({version: 3, activeIndex: 0, accounts: [{refreshToken: token, addedAt: 1, lastUsed: 1}]});
	await recordPendingAuth(storagePath, {...rotation("a", "b"), recordId: "first"});
	await recordPendingAuth(storagePath, {
		...rotation("b", "c"), recordId: "first",
		...(state === "invalidated" ? {authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"} : {}),
		...(state === "disabled" ? {enabled: false} : {}),
	});
	await prunePendingAuth(storagePath, pool("c"), async () => ["a"]);
	expect((await applyPendingAuth(storagePath, pool("b")))?.accounts[0]?.refreshToken).toBe("b");
	const retained = await recordPendingAuth(storagePath, {
		...rotation("a", "b"), at: 1000, expiresAt: 50000,
		...(state === "old-revocation" ? {authInvalidatedAt: 9000, authInvalidationErrorCode: "token_invalidated"} : {}),
	});
	expect(retained).toMatchObject({recordId: "first", refreshToken: "c", accessToken: "access-c", expiresAt: 1});
	const restored = (await applyPendingAuth(storagePath, pool("a")))?.accounts[0];
	expect(restored).toMatchObject({recordId: "first", refreshToken: "c", accessToken: "access-c"});
	expect(restored?.authInvalidatedAt).toBe(state === "invalidated" ? 1500 : undefined);
	expect(restored?.enabled).toBe(state === "disabled" ? false : undefined);
});

it("recovers the current credential from backup after save, prune, and delayed rescue", async () => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	const original: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "a", accessToken: "access-a", expiresAt: 10000, addedAt: 1, lastUsed: 1}]};
	await saveAccounts(original);
	await recordPendingAuth(storagePath, {...rotation("a", "b"), recordId: "first"});
	await recordPendingAuth(storagePath, {...rotation("b", "c"), recordId: "first"});
	const current = await loadAccounts();
	if (!current) throw Error("Fixture account pool missing");
	await saveAccounts(current);
	await fs.writeFile(`${storagePath}.bak`, JSON.stringify(original));
	const intermediate: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{refreshToken: "b", addedAt: 1, lastUsed: 1}]};
	expect((await applyPendingAuth(storagePath, intermediate))?.accounts[0]?.refreshToken).toBe("b");
	await recordPendingAuth(storagePath, {...rotation("a", "b"), recordId: "first", at: 1000});
	await fs.writeFile(storagePath, "{torn primary fixture");
	expect((await loadAccounts())?.accounts[0]).toMatchObject({refreshToken: "c", accessToken: "access-c"});
});

it("adopts an authenticated newer replacement from the same predecessor after pruning", async () => {
	const access = (iat: number) => `e30.${Buffer.from(JSON.stringify({iat})).toString("base64url")}.fixture`;
	await recordPendingAuth(storagePath, {...rotation("a", "b"), recordId: "first", accessToken: access(1)});
	await recordPendingAuth(storagePath, {...rotation("b", "c"), accessToken: access(2)});
	await prunePendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: "c", addedAt: 1, lastUsed: 1}]}, async () => ["a"]);
	const retained = await recordPendingAuth(storagePath, {...rotation("a", "d"), accessToken: access(3)});
	expect(retained).toMatchObject({recordId: "first", refreshToken: "d", accessToken: access(3)});
});

it.each(["disabled", "invalidated", "self"])("scopes delayed journal restrictions to their credential generation (%s)", async state => {
	await recordPendingAuth(storagePath, rotation("b", state === "self" ? "b" : "c"));
	if (state === "self") await recordPendingAuth(storagePath, {...rotation("b", "b"), authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"});
	const restrictions = state === "disabled" ? {enabled: false as const} : state === "invalidated" ? {authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"} : {};
	const retained = await recordPendingAuth(storagePath, {...rotation("a", "b"), ...restrictions, at: 2000});
	if (state === "disabled") expect(retained.enabled).toBe(false);
	else expect(retained.authInvalidatedAt).toBe(state === "self" ? 1500 : undefined);
	for (const token of ["a", "b"]) {
		const restored = await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: token, addedAt: 1, lastUsed: 1}]});
		if (state === "disabled") expect(restored?.accounts[0]?.enabled).toBe(false);
		else expect(restored?.accounts[0]?.authInvalidatedAt).toBe(state === "self" ? 1500 : undefined);
	}
});

it("preserves authorization carried by another alias of the retained credential", async () => {
	const {createHash} = await import("node:crypto");
	const prior = (token: string) => createHash("sha256").update(token).digest("hex");
	await fs.writeFile(getPendingAuthPath(storagePath), JSON.stringify({version: 1, entries: [
		{prior: prior("a"), refreshToken: "c", accessToken: "access-c", expiresAt: 1, at: 1, enabled: false},
		{prior: prior("b"), refreshToken: "c", accessToken: "access-c", expiresAt: 1, at: 1},
	]}));
	const retained = await recordPendingAuth(storagePath, rotation("d", "b"));
	expect(retained).toMatchObject({refreshToken: "c", enabled: false});
	for (const token of ["a", "b", "d"]) {
		const restored = await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: token, addedAt: 1, lastUsed: 1}]});
		expect(restored?.accounts[0]).toMatchObject({refreshToken: "c", enabled: false});
	}
});

it.each([false, true])("only clears disk revocation with an authenticated replacement generation, recovered=%s", async recovered => {
	const token = recovered ? "fixture-new-generation" : "old";
	await recordPendingAuth(storagePath, {...rotation("a", "b"), accessToken: token});
	const restored = await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: "a", accessToken: "old", authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated", enabled: false, addedAt: 1, lastUsed: 1}]});
	expect(restored?.accounts[0]?.authInvalidatedAt).toBe(recovered ? undefined : 1500);
	expect(restored?.accounts[0]?.enabled).toBe(false);
});

it.each(["probe", "enable", "renewal"])("commits recovery over a journal self-entry (%s)", async mode => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	const access = (iat: number) => `e30.${Buffer.from(JSON.stringify({iat})).toString("base64url")}.fixture`;
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "a", accessToken: access(1), expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
	const restriction = mode === "enable" ? {enabled: false as const} : {authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"};
	await recordPendingAuth(storagePath, {...rotation("a", "b"), recordId: "first", accessToken: access(1), expiresAt: 10000, ...restriction});
	await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", accessToken: access(1), expiresAt: 10000, ...restriction});
	const pool = (await loadAccounts())!;
	delete pool.accounts[0]!.authInvalidatedAt;
	delete pool.accounts[0]!.authInvalidationErrorCode;
	pool.accounts[0]!.enabled = true;
	if (mode === "renewal") {pool.accounts[0]!.accessToken = access(3); pool.accounts[0]!.expiresAt = 20000;}
	await saveAccounts(pool);
	const restored = (await loadAccounts())!;
	expect(restored.accounts[0]?.authInvalidatedAt).toBeUndefined();
	expect(restored.accounts[0]?.enabled).not.toBe(false);
	expect(restored.accounts[0]?.accessToken).toBe(pool.accounts[0]?.accessToken);
	expect(restored.accounts[0]?.expiresAt).toBe(pool.accounts[0]?.expiresAt);
	const old = await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: "a", accessToken: access(1), expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
	expect(old?.accounts[0]?.refreshToken).toBe("b");
	expect(old?.accounts[0]?.accessToken).toBe(pool.accounts[0]?.accessToken);
	expect(old?.accounts[0]?.authInvalidatedAt).toBeUndefined();
});

it.each([10000, 20000])("retains a later same-refresh renewal when its persistence also fails (%s)", async expiresAt => {
	const access = (iat: number) => `e30.${Buffer.from(JSON.stringify({iat})).toString("base64url")}.fixture`;
	await recordPendingAuth(storagePath, {...rotation("a", "b"), accessToken: access(1), expiresAt: 10000, authInvalidatedAt: 1500});
	await recordPendingAuth(storagePath, {...rotation("b", "b"), accessToken: access(1), expiresAt: 10000, authInvalidatedAt: 1500});
	const renewed = await recordPendingAuth(storagePath, {...rotation("b", "b"), accessToken: access(3), expiresAt, at: 2});
	expect(renewed).toMatchObject({accessToken: access(3), expiresAt});
	expect(renewed.authInvalidatedAt).toBeUndefined();
	for (const token of ["a", "b"]) {
		const restored = await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: token, addedAt: 1, lastUsed: 1}]});
		expect(restored?.accounts[0]?.accessToken).toBe(access(3));
		expect(restored?.accounts[0]?.authInvalidatedAt).toBeUndefined();
	}
	const delayed = await recordPendingAuth(storagePath, {...rotation("b", "b"), accessToken: access(1), expiresAt: 30000, at: 3});
	expect(delayed).toMatchObject({accessToken: access(3), expiresAt});
});

it.each(["delayed-old", "new-revocation"])("orders journal writers against committed probe recovery (%s)", async ordering => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
	const auth = {...rotation("b", "b"), recordId: "first", expiresAt: 10000, authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"};
	await recordPendingAuth(storagePath, auth);
	const pool = (await loadAccounts())!;
	delete pool.accounts[0]!.authInvalidatedAt; delete pool.accounts[0]!.authInvalidationErrorCode;
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>(resolve => {release = resolve;}), ready = new Promise<void>(resolve => {entered = resolve;});
	let saved!: () => void;
	const committed = new Promise<void>(resolve => {saved = resolve;});
	const rename = fs.rename.bind(fs);
	const blocked = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === (ordering === "delayed-old" ? getPendingAuthPath(storagePath) : storagePath)) {entered(); await gate;}
		const result = await rename(from, to);
		if (String(to) === storagePath) saved();
		return result;
	});
	const first = ordering === "delayed-old" ? recordPendingAuth(storagePath, {...auth, at: 2}) : saveAccounts(pool);
	try {
		await ready;
		if (ordering === "delayed-old") {
			const recovery = saveAccounts(pool);
			await committed; release(); await first; await recovery;
		} else {
			await recordPendingAuth(storagePath, {...auth, authInvalidatedAt: 2500}); release(); await first;
		}
		expect((await loadAccounts())?.accounts[0]?.authInvalidatedAt).toBe(ordering === "delayed-old" ? undefined : 2500);
	} finally {release(); await first; blocked.mockRestore();}
});

it("retains mappings through corrupt recovery sources and failed primary writes", async () => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
	await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", expiresAt: 10000, authInvalidatedAt: 1500});
	const pool = (await loadAccounts())!;
	delete pool.accounts[0]!.authInvalidatedAt;
	const rename = fs.rename.bind(fs);
	const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {if (String(to) === storagePath) throw Error("fixture primary failure"); return rename(from, to);});
	try {await expect(saveAccounts(pool)).rejects.toThrow("fixture primary failure");} finally {failure.mockRestore();}
	expect((await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1}]}))?.accounts[0]?.authInvalidatedAt).toBe(1500);
	await fs.writeFile(`${storagePath}.bak.2`, "corrupt fixture backup");
	await saveAccounts(pool);
	expect((await loadAccounts())?.accounts[0]?.authInvalidatedAt).toBeUndefined();
	expect(JSON.parse(await fs.readFile(getPendingAuthPath(storagePath), "utf8")).entries).toHaveLength(1);
});

it.each(["revocation", "auth-cooldown", "disablement"])("retains committed authorization while a backup has stale state (%s)", async mode => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	const restriction = mode === "revocation" ? {authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"} : {};
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1, ...restriction,
		...(mode === "auth-cooldown" ? {cooldownReason: "auth-failure", coolingDownUntil: Date.now() + 60000} : {})}]});
	await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", expiresAt: 10000, ...restriction,
		...(mode === "disablement" ? {enabled: false} : {})});
	const pool = await loadAccounts();
	const account = pool?.accounts[0];
	if (!pool || !account) throw Error("Fixture account missing");
	delete account.authInvalidatedAt;
	delete account.authInvalidationErrorCode;
	delete account.cooldownReason;
	delete account.coolingDownUntil;
	await saveAccounts(pool);
	await fs.writeFile(storagePath, "{torn primary fixture");
	const recovered = (await loadAccounts())?.accounts[0];
	expect(recovered?.authInvalidatedAt).toBeUndefined();
	expect(recovered?.cooldownReason).toBeUndefined();
	expect(recovered?.enabled === false).toBe(mode === "disablement");
});

async function committedPrunedLineage(restriction: "disablement" | "revocation" | "auth-cooldown", legacy = false) {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	const original: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{
		recordId: "first", refreshToken: "a", accessToken: "access-a", expiresAt: 10000, addedAt: 1, lastUsed: 1,
		...(restriction === "disablement" ? {enabled: false} : {}),
		...(restriction === "revocation" ? {authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"} : {}),
		...(restriction === "auth-cooldown" ? {cooldownReason: "auth-failure", coolingDownUntil: Date.now() + 60000} : {}),
	}]};
	await saveAccounts(original);
	await recordPendingAuth(storagePath, {...rotation("a", "b"), recordId: "first"});
	const auth = {...rotation("b", "c"), ...(legacy ? {} : {recordId: "first"})};
	await recordPendingAuth(storagePath, {...auth, ...(restriction === "disablement" ? {enabled: false} : {})});
	const current = await loadAccounts();
	const account = current?.accounts[0];
	if (!current || !account) throw Error("Fixture account missing");
	account.enabled = true;
	delete account.authInvalidatedAt;
	delete account.authInvalidationErrorCode;
	delete account.cooldownReason;
	delete account.coolingDownUntil;
	await saveAccounts(current);
	const {capturePendingAuth} = await import("../lib/storage/pending-auth.js");
	const before = await capturePendingAuth(storagePath, current.accounts);
	expect(before.entries).toHaveLength(1);
	expect(before.entries[0]).toMatchObject({recordId: "first", refreshToken: "c", committed: true});
	expect((await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: "b", addedAt: 1, lastUsed: 1}]}))?.accounts[0]?.refreshToken).toBe("b");
	return {auth, current, original, loadAccounts, capturePendingAuth};
}

it.each(["disablement", "revocation", "auth-cooldown"] as const)("preserves committed authority after delayed rescue of a pruned predecessor (%s)", async restriction => {
	const {auth, loadAccounts, capturePendingAuth} = await committedPrunedLineage(restriction);
	const retained = await recordPendingAuth(storagePath, {...auth, at: 9000});
	expect(retained).toMatchObject({recordId: "first", refreshToken: "c", accessToken: "access-c", committed: true});
	const journal = await capturePendingAuth(storagePath, []);
	expect(journal.entries).toHaveLength(2);
	for (const entry of journal.entries) expect(entry.committed).toBe(true);
	await fs.writeFile(storagePath, "{torn primary fixture");
	const restored = (await loadAccounts())?.accounts[0];
	expect(restored).toMatchObject({recordId: "first", refreshToken: "c", accessToken: "access-c"});
	expect(restored?.enabled).not.toBe(false);
	expect(restored?.authInvalidatedAt).toBeUndefined();
	expect(restored?.cooldownReason).toBeUndefined();
});

it("preserves alias identity for a delayed legacy rescue of a pruned predecessor", async () => {
	const {auth, capturePendingAuth, loadAccounts} = await committedPrunedLineage("disablement", true);
	const retained = await recordPendingAuth(storagePath, auth);
	expect(retained).toMatchObject({recordId: "first", committed: true});
	for (const entry of (await capturePendingAuth(storagePath, [])).entries) {
		expect(entry).toMatchObject({recordId: "first", committed: true});
	}
	await fs.writeFile(storagePath, "{torn primary fixture");
	expect((await loadAccounts())?.accounts[0]?.enabled).not.toBe(false);
});

it.each(["identity", "refresh", "access", "expiry", "disablement", "revocation"])("invalidates incompatible committed aliases for a changed %s", async change => {
	const {auth, capturePendingAuth} = await committedPrunedLineage("disablement");
	const incoming = {...auth, at: 9000,
		...(change === "identity" ? {recordId: "different"} : {}),
		...(change === "refresh" ? {refreshToken: "d", accessToken: "access-d"} : {}),
		...(change === "access" ? {accessToken: "access-new"} : {}),
		...(change === "expiry" ? {expiresAt: 20000} : {}),
		...(change === "disablement" ? {enabled: false as const} : {}),
		...(change === "revocation" ? {authInvalidatedAt: 2500, authInvalidationErrorCode: "token_invalidated"} : {}),
		committed: true,
	};
	const retained = await recordPendingAuth(storagePath, incoming);
	expect(retained.committed).toBeUndefined();
	for (const entry of (await capturePendingAuth(storagePath, [])).entries) {
		expect(entry.committed).toBe(change === "refresh" && entry.refreshToken === "c" ? true : undefined);
		if (entry.recordId !== "different") expect(entry.recordId).toBe("first");
	}
});

it("keeps current primary and native restrictions after a committed pruned-predecessor rescue", async () => {
	const {auth, current, loadAccounts} = await committedPrunedLineage("disablement");
	expect((await recordPendingAuth(storagePath, auth)).committed).toBe(true);
	Object.assign(current.accounts[0]!, {enabled: false, authInvalidatedAt: 5000, authInvalidationErrorCode: "token_invalidated"});
	await fs.writeFile(storagePath, JSON.stringify(current));
	expect((await loadAccounts())?.accounts[0]).toMatchObject({enabled: false, authInvalidatedAt: 5000});
	const {createNativeAccountStorageReader} = await import("../lib/runtime/native-account-storage.js");
	expect((await createNativeAccountStorageReader(undefined, storagePath)()).storage?.accounts[0]).toMatchObject({enabled: false, authInvalidatedAt: 5000});
});

it("recovers committed pruned-predecessor authority through a real WAL", async () => {
	const {auth, original, loadAccounts} = await committedPrunedLineage("disablement");
	expect((await recordPendingAuth(storagePath, auth)).committed).toBe(true);
	const content = JSON.stringify(original);
	await fs.writeFile(`${storagePath}.wal`, JSON.stringify({version: 1, createdAt: Date.now(), path: storagePath,
		checksum: createHash("sha256").update(content).digest("hex"), content}));
	await fs.writeFile(storagePath, "{torn primary fixture");
	const restored = (await loadAccounts())?.accounts[0];
	expect(restored).toMatchObject({recordId: "first", refreshToken: "c", accessToken: "access-c"});
	expect(restored?.enabled).not.toBe(false);
	expect(JSON.parse(await fs.readFile(storagePath, "utf8")).accounts[0].enabled).not.toBe(false);
});

it("does not derive new credential authority from a committed alias mutated during chaining", async () => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "a", addedAt: 1, lastUsed: 1}]});
	await recordPendingAuth(storagePath, {...rotation("a", "b"), recordId: "first"});
	await saveAccounts((await loadAccounts())!);
	const {capturePendingAuth} = await import("../lib/storage/pending-auth.js");
	expect((await capturePendingAuth(storagePath, [])).entries[0]?.committed).toBe(true);
	const retained = await recordPendingAuth(storagePath, {...rotation("b", "c"), recordId: "first"});
	expect(retained.committed).toBeUndefined();
	for (const entry of (await capturePendingAuth(storagePath, [])).entries) {
		expect(entry.refreshToken).toBe("c");
		expect(entry.committed).toBeUndefined();
	}
});

it("keeps alias-local identity instead of sharing another record's committed authority", async () => {
	const {auth, capturePendingAuth} = await committedPrunedLineage("disablement");
	const journal = await capturePendingAuth(storagePath, []);
	const authority = journal.entries[0];
	if (!authority) throw Error("Fixture authority missing");
	await fs.writeFile(getPendingAuthPath(storagePath), JSON.stringify({version: 1, entries: [authority,
		{...authority, prior: createHash("sha256").update("other").digest("hex"), recordId: "other-record", committed: undefined}]}));
	expect((await recordPendingAuth(storagePath, auth)).committed).toBe(true);
	const aliases = (await capturePendingAuth(storagePath, [])).entries;
	expect(aliases.find(entry => entry.recordId === "other-record")?.committed).toBeUndefined();
	expect(aliases.filter(entry => entry.recordId === "first").every(entry => entry.committed)).toBe(true);
});

it("never trusts an incoming rescue claim of committed authority", async () => {
	const incoming = {...rotation("a", "b"), committed: true};
	const retained = await recordPendingAuth(storagePath, incoming);
	expect(retained.committed).toBeUndefined();
});

it("preserves current primary revocation over a committed journal recovery clear", async () => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1, authInvalidatedAt: 1500}]});
	await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", expiresAt: 10000, authInvalidatedAt: 1500});
	const pool = await loadAccounts();
	const account = pool?.accounts[0];
	if (!pool || !account) throw Error("Fixture account missing");
	delete account.authInvalidatedAt;
	await saveAccounts(pool);
	const delayed = await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", expiresAt: 10000});
	expect(delayed.committed).toBe(true);
	const committedAccount = pool.accounts[0];
	if (!committedAccount) throw Error("Committed fixture account missing");
	committedAccount.authInvalidatedAt = 5000;
	await fs.writeFile(storagePath, JSON.stringify(pool));
	expect((await loadAccounts())?.accounts[0]?.authInvalidatedAt).toBe(5000);
	const {createNativeAccountStorageReader} = await import("../lib/runtime/native-account-storage.js");
	expect((await createNativeAccountStorageReader(undefined, storagePath)()).storage?.accounts[0]?.authInvalidatedAt).toBe(5000);
	const revoked = await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", expiresAt: 10000, authInvalidatedAt: 5000});
	expect(revoked.committed).toBeUndefined();
	await fs.writeFile(storagePath, "{torn primary fixture");
	expect((await loadAccounts())?.accounts[0]?.authInvalidatedAt).toBe(5000);
});

it("does not report committed recovery when journal reconciliation fails", async () => {
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
	await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", expiresAt: 10000, authInvalidatedAt: 1500});
	const pool = (await loadAccounts())!;
	delete pool.accounts[0]!.authInvalidatedAt;
	const rename = fs.rename.bind(fs);
	const remove = fs.rm.bind(fs);
	const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {if (String(to) === getPendingAuthPath(storagePath)) throw Error("fixture journal failure"); return rename(from, to);});
	const removeFailure = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {if (String(path) === getPendingAuthPath(storagePath)) throw Error("fixture journal failure"); return remove(path, options);});
	try {await expect(saveAccounts(pool)).rejects.toThrow("Failed to reconcile pending account recovery");} finally {failure.mockRestore(); removeFailure.mockRestore();}
	await saveAccounts(pool);
	expect((await loadAccounts())?.accounts[0]?.authInvalidatedAt).toBeUndefined();
});

it("keeps committed self renewal mappings when recovery-source scanning fails", async () => {
	const {capturePendingAuth} = await import("../lib/storage/pending-auth.js");
	const {saveAccounts, loadAccounts, setStoragePathDirect} = await import("../lib/storage.js");
	setStoragePathDirect(storagePath);
	await saveAccounts({version: 3, activeIndex: 0, accounts: [{recordId: "first", refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
	await recordPendingAuth(storagePath, {...rotation("b", "b"), recordId: "first", expiresAt: 10000, authInvalidatedAt: 1500});
	const pool = (await loadAccounts())!;
	const observed = await capturePendingAuth(storagePath, pool.accounts);
	const committed = structuredClone(pool);
	Object.assign(committed.accounts[0]!, {accessToken: "access-renewed", expiresAt: 20000, authInvalidatedAt: undefined});
	await prunePendingAuth(storagePath, committed, async () => {throw Error("fixture scan failure");}, observed);
	const restored = await applyPendingAuth(storagePath, committed);
	expect(restored?.accounts[0]).toMatchObject({accessToken: "access-renewed", expiresAt: 20000});
	expect(restored?.accounts[0]?.authInvalidatedAt).toBeUndefined();
	const old = await applyPendingAuth(storagePath, {version: 3, activeIndex: 0, accounts: [{refreshToken: "b", accessToken: "access-b", expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
	expect(old?.accounts[0]?.accessToken).toBe("access-renewed");
});

it("covers an intermediate spent token when rotations chain", async () => {
	// a -> b -> c with only journaled state: a restore can resurface either
	// spent token, so BOTH must map to the newest credential.
	await recordPendingAuth(storagePath, rotation("a", "b"));
	await recordPendingAuth(storagePath, rotation("b", "c"));
	const pool = (token: string) => ({ version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: token, addedAt: 1, lastUsed: 1 }] });
	expect((await applyPendingAuth(storagePath, pool("a")))?.accounts[0]?.refreshToken).toBe("c");
	expect((await applyPendingAuth(storagePath, pool("b")))?.accounts[0]?.refreshToken).toBe("c");
	// And the chain still collapses to at most two entries — not one per hop.
	const { entries } = JSON.parse(await fs.readFile(getPendingAuthPath(storagePath), "utf8")) as { entries: unknown[] };
	expect(entries).toHaveLength(2);
});
