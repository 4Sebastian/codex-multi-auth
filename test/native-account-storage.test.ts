import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import * as filesystem from "node:fs";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { clearAccountStorageArtifacts } from "../lib/storage/account-clear.js";
import {recordPendingAuth, getPendingAuthPath} from "../lib/storage/pending-auth.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeAccountStorageReader } from "../lib/runtime/native-account-storage.js";
import * as parser from "../lib/storage/storage-parser.js";
vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {...actual, statSync: vi.fn(actual.statSync)};
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(filesystem.statSync).mockRestore(); for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
it.each(["EACCES","corrupt"])("never verifies unrestricted primary after journal observation fails (%s)",async failure=>{
 const root=await mkdtemp(join(tmpdir(),"native-journal-"));roots.push(root);const path=join(root,"accounts.json");
 const disk={version:3,activeIndex:0,accounts:[{recordId:"first",accessToken:"fixture-A",refreshToken:"fixture-refresh",expiresAt:Date.now()+3600000,addedAt:1,lastUsed:1}]};
 await writeFile(path,JSON.stringify(disk));const read=createNativeAccountStorageReader(undefined,path);expect((await read()).verified).toBe(true);
 await recordPendingAuth(path,{priorRefreshToken:"fixture-refresh",recordId:"first",refreshToken:"fixture-refresh",accessToken:"fixture-A",expiresAt:disk.accounts[0]!.expiresAt,authInvalidatedAt:1500,enabled:false,at:1});
 const original=fs.readFile.bind(fs);
 const blocked=vi.spyOn(fs,"readFile").mockImplementation(async(...args:Parameters<typeof fs.readFile>)=>{if(String(args[0])===getPendingAuthPath(path)) throw Object.assign(Error("fixture locked"),{code:"EACCES"});return original(...args);});
 if(failure==="corrupt") {blocked.mockRestore();await writeFile(getPendingAuthPath(path),"corrupt fixture");}
 const failed=await read();expect(failed.verified).toBe(false);
 blocked.mockRestore();await rm(getPendingAuthPath(path));
 expect((await read()).verified).toBe(true);
});
it.each(["surviving-primary", "busy-primary", "unreadable-marker", "during-journal"])("denies reset authority without cache or grace override (%s)", async mode => {
	const root = await mkdtemp(join(tmpdir(), "native-reset-")); roots.push(root);
	const path = join(root, "accounts.json"), marker = getIntentionalResetMarkerPath(path);
	await writeFile(path, JSON.stringify({version: 3, activeIndex: 0, accounts: [{recordId: "R1", refreshToken: "refresh-A", accessToken: "A", addedAt: 1, lastUsed: 1}]}));
	const read = createNativeAccountStorageReader(undefined, path);
	expect((await read()).verified).toBe(true);
	if (mode === "surviving-primary") {
		vi.spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(Error("fixture unlink failed"), {code: "EIO"}));
		await expect(clearAccountStorageArtifacts({path, resetMarkerPath: marker, walPath: path + ".wal", backupPaths: [], logError: () => undefined})).rejects.toThrow("fixture unlink failed");
	} else if (mode === "unreadable-marker") {
		const original = vi.mocked(filesystem.statSync).getMockImplementation();
		if (!original) throw Error("Missing fixture filesystem implementation");
		vi.mocked(filesystem.statSync).mockImplementation((...args: Parameters<typeof filesystem.statSync>) => {
			if (String(args[0]) === marker) throw Object.assign(Error("fixture marker unavailable"), {code: "EACCES"});
			return original(...args);
		});
	} else if (mode === "during-journal") {
		const original = fs.readFile.bind(fs);
		vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
			if (String(args[0]) === getPendingAuthPath(path)) await writeFile(marker, "{}");
			return original(...args);
		});
	} else {
		vi.spyOn(parser, "loadAccountsFromPath").mockRejectedValueOnce(Object.assign(Error("fixture primary locked"), {code: "EBUSY"}));
		await writeFile(marker, "{}");
	}
	expect(await read()).toMatchObject({storage: null, verified: false, routingAvailable: false});
	vi.restoreAllMocks(); vi.mocked(filesystem.statSync).mockRestore(); await rm(marker, {force: true});
	expect((await read()).verified).toBe(true);
});

it("rejects a primary revision changed during journal observation", async () => {
	const root = await mkdtemp(join(tmpdir(), "native-revision-")); roots.push(root);
	const path = join(root, "accounts.json");
	const pool = {version: 3, activeIndex: 0, accounts: [{recordId: "fixture", refreshToken: "refresh", accessToken: "A", addedAt: 1, lastUsed: 1}]};
	await writeFile(path, JSON.stringify(pool));
	const original = fs.readFile.bind(fs);
	let mutated = false;
	vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
		if (!mutated && String(args[0]) === getPendingAuthPath(path)) {
			mutated = true;
			await writeFile(path, JSON.stringify({...pool, accounts: [{...pool.accounts[0], enabled: false}]}));
		}
		return original(...args);
	});
	const read = createNativeAccountStorageReader(undefined, path);
	expect(await read()).toMatchObject({verified: false, routingAvailable: false, storage: null});
	expect((await read()).storage?.accounts[0]?.enabled).toBe(false);
});

it.each([undefined, 0, -1].flatMap(timestamp => [false, true].flatMap(warm => [false, true].map(normalizedMetadata => ({timestamp, warm, normalizedMetadata})))))("does not certify raw orphaned revocation across native cache reads (%j)", async ({timestamp, warm, normalizedMetadata}) => {
    const root = await mkdtemp(join(tmpdir(), "native-raw-revocation-")); roots.push(root);
    const path = join(root, "accounts.json");
    const disk = {version: 3, activeIndex: 0, accounts: [{recordId: "raw-owner", accountId: "W1", email: normalizedMetadata ? " Fixture@example.com " : "fixture@example.com", refreshToken: "refresh-A", accessToken: "access-A", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
    await writeFile(path, JSON.stringify(disk));
    const read = createNativeAccountStorageReader(undefined, path);
    if (warm) expect((await read()).verified).toBe(true);
    await writeFile(path, JSON.stringify({...disk, accounts: [{...disk.accounts[0], authInvalidationErrorCode: "token_invalidated", authInvalidatedAt: timestamp}]}));
    for (let i = 0; i < 2; i++) expect(await read()).toMatchObject({storage: null, verified: false, routingAvailable: false});
    vi.spyOn(parser, "loadAccountsFromPath").mockRejectedValueOnce(Object.assign(Error("fixture primary locked after revocation"), {code: "EBUSY"}));
    expect(await read()).toMatchObject({storage: null, verified: false, routingAvailable: false});
    await recordPendingAuth(path, {priorRefreshToken: "refresh-A", recordId: "raw-owner", refreshToken: "refresh-A", accessToken: "access-A", expiresAt: disk.accounts[0]!.expiresAt, at: 1});
    expect(await read()).toMatchObject({storage: null, verified: false, routingAvailable: false});
    await writeFile(path, JSON.stringify({...disk, accounts: [{...disk.accounts[0], refreshToken: "refresh-B", accessToken: "access-B"}]}));
    const recovered = await read();
    expect(recovered.verified).toBe(true);
    expect(recovered.storage?.accounts[0]).toMatchObject({recordId: "raw-owner", accessToken: "access-B"});
});

it("caches settled primary storage but adopts credential revocation on change", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-cache-"));
    roots.push(root);
    const path = join(root, "accounts.json");
    const disk = { version: 3, activeIndex: 0, accounts: [{ accountId: "example", email: "example@example.test", accessToken: "fixture-access", refreshToken: "fixture-refresh", addedAt: 1, lastUsed: 1 }] };
    await writeFile(path, JSON.stringify(disk));
    await utimes(path, new Date(0), new Date(0));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);
    const parse = vi.spyOn(parser, "loadAccountsFromPath"), read = createNativeAccountStorageReader(undefined, path);
    const first = await read();
    expect(first.storage?.accounts[0]?.accessToken).toBe("fixture-access");
    first.storage!.accounts[0]!.accessToken = "mutated";
    expect((await read()).storage?.accounts[0]?.accessToken).toBe("fixture-access");
    expect(parse).toHaveBeenCalledTimes(1);
    await writeFile(path, JSON.stringify({ ...disk, accounts: [{ ...disk.accounts[0], accessToken: undefined, enabled: false }] }));
    const revoked = await read();
    expect(revoked.verified).toBe(true);
    expect(revoked.storage?.accounts[0]?.accessToken).toBeUndefined();
    expect(revoked.storage?.accounts[0]?.enabled).toBe(false);
    await rm(path);
    expect((await read()).storage).toBeNull();
});
it("bounds the fallback grace and never labels cached credentials as verified", async () => {
    let now = 10000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const readFile = vi.fn().mockResolvedValueOnce({ version: 3, activeIndex: 0, accounts: [] }).mockRejectedValue(Object.assign(Error("locked"), { code: "EBUSY" }));
    const read = createNativeAccountStorageReader(readFile, "unused");
    expect((await read()).verified).toBe(true);
    expect((await read()).verified).toBe(false);
    now += 2001;
    expect((await read()).routingAvailable).toBe(true);
    now += 28000;
    expect((await read()).storage).toBeNull();
    expect(readFile).toHaveBeenCalledTimes(4);
});

it("refreshes the bounded fallback age after a verified settled cache hit", async () => {
    const root=await mkdtemp(join(tmpdir(),"native-cache-age-")); roots.push(root);
    const path=join(root,"accounts.json");
    await writeFile(path,JSON.stringify({version:3,activeIndex:0,accounts:[]}));
    let now=Date.now()+3000; vi.spyOn(Date,"now").mockImplementation(()=>now);
    const parse=vi.spyOn(parser,"loadAccountsFromPath"), read=createNativeAccountStorageReader(undefined,path);
    const initial=await read(); now+=10000;
    expect((await read()).verified).toBe(true); expect(parse).toHaveBeenCalledTimes(1);
    await writeFile(path,"changed"); parse.mockRejectedValueOnce(Object.assign(Error("locked"),{code:"EBUSY"}));
    expect(await read()).toMatchObject({storage:initial.storage,verified:false,transientFailure:true,routingAvailable:true});
});


it("counts a verified cache hit as fresh so one EBUSY after steady traffic keeps the snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-cache-grace-"));
    roots.push(root);
    const path = join(root, "accounts.json");
    const disk = { version: 3, activeIndex: 0, accounts: [{ accountId: "example", email: "example@example.test", accessToken: "fixture-access", refreshToken: "fixture-refresh", addedAt: 1, lastUsed: 1 }] };
    await writeFile(path, JSON.stringify(disk));
    await utimes(path, new Date(0), new Date(0));
    let now = Date.now() + 3000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = createNativeAccountStorageReader(undefined, path);
    expect((await read()).verified).toBe(true);
    now += 10_000;
    expect((await read()).verified).toBe(true);
    now += 1_000;
    await writeFile(path, JSON.stringify({ ...disk, activeIndex: 0, accounts: [{ ...disk.accounts[0], lastUsed: 2 }] }));
    vi.spyOn(parser, "loadAccountsFromPath").mockRejectedValueOnce(Object.assign(Error("locked"), { code: "EBUSY" }));
    const busy = await read();
    expect(busy.verified).toBe(false);
    expect(busy.storage?.accounts[0]?.accessToken).toBe("fixture-access");
});
