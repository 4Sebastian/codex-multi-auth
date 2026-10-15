import {createHash} from "node:crypto";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {loadAccounts, saveAccounts, setStoragePathDirect, withAccountStorageTransaction, type AccountStorageV3} from "../lib/storage.js";
import {applyPendingAuth, capturePendingAuth, getPendingAuthPath, prunePendingAuth, recordPendingAuth} from "../lib/storage/pending-auth.js";
import {createNativeAccountStorageReader} from "../lib/runtime/native-account-storage.js";
import {removeWithRetry} from "./helpers/remove-with-retry.js";

let root: string, path: string;
beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "journal-boundary-"));
	path = join(root, "accounts.json");
	setStoragePathDirect(path);
});
afterEach(async () => {
	vi.restoreAllMocks();
	setStoragePathDirect(null);
	await removeWithRetry(root, {recursive: true, force: true});
});
const pool = (token: string): AccountStorageV3 => ({version: 3, activeIndex: 0, accounts: [{recordId: "first", accountId: "fixture-account", refreshToken: token, accessToken: `access-${token}`, expiresAt: 10000, addedAt: 1, lastUsed: 1}]});
const rotation = (prior: string, next: string) => ({recordId: "first", priorRefreshToken: prior, refreshToken: next, accessToken: `access-${next}`, expiresAt: 10000, at: 1});
async function threeRotations() {
	for (const [prior, next] of [["a", "b"], ["b", "c"], ["c", "d"]] as const) await recordPendingAuth(path, rotation(prior, next));
}

it.each(["a", "b", "c"])("hydrates every retained root through ordinary, native, transaction, backup and WAL paths (%s)", async token => {
	await fs.writeFile(path, JSON.stringify(pool(token)));
	await threeRotations();
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("d");
	expect((await createNativeAccountStorageReader(undefined, path)()).storage?.accounts[0]?.refreshToken).toBe("d");
	await withAccountStorageTransaction(async current => {expect(current?.accounts[0]?.refreshToken).toBe("d");});
	const rename = fs.rename.bind(fs);
	const failedWrite = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === path) throw Error("fixture primary write failed");
		return rename(from, to);
	});
	try {await expect(saveAccounts(pool("d"))).rejects.toThrow("fixture primary write failed");}
	finally {failedWrite.mockRestore();}
	expect((await createNativeAccountStorageReader(undefined, path)()).storage?.accounts[0]?.refreshToken).toBe("d");
	await fs.writeFile(`${path}.bak`, JSON.stringify(pool(token)));
	await fs.writeFile(path, "{torn fixture primary");
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("d");
	const content = JSON.stringify(pool(token));
	await fs.writeFile(`${path}.wal`, JSON.stringify({version: 1, path, createdAt: Date.now(), content, checksum: createHash("sha256").update(content).digest("hex")}));
	await fs.writeFile(path, "{torn fixture primary");
	expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("d");
});

it.each(["plain", "disabled", "revoked"])("advances every retained alias across prune, delayed rescue and further rotation (%s)", async restriction => {
	await recordPendingAuth(path, rotation("a", "b"));
	await recordPendingAuth(path, {...rotation("b", "c"), authInvalidatedAt: 1500});
	const auth = {...rotation("c", "d"), ...(restriction === "disabled" ? {enabled: false as const} : {}), ...(restriction === "revoked" ? {authInvalidatedAt: 5000} : {})};
	await recordPendingAuth(path, auth);
	for (const token of ["a", "b", "c"]) {
		const account = (await applyPendingAuth(path, pool(token)))?.accounts[0];
		expect(account?.refreshToken).toBe("d");
		expect(account?.enabled === false).toBe(restriction === "disabled");
		expect(account?.authInvalidatedAt).toBe(restriction === "revoked" ? 5000 : undefined);
	}
	await prunePendingAuth(path, pool("d"), async () => ["a", "b"]);
	expect((await recordPendingAuth(path, {...rotation("b", "c"), at: 9000})).refreshToken).toBe("d");
	await recordPendingAuth(path, rotation("d", "e"));
	for (const token of ["a", "b", "d"]) {
		const account = (await applyPendingAuth(path, pool(token)))?.accounts[0];
		expect(account?.refreshToken).toBe("e");
		expect(account?.enabled === false).toBe(restriction === "disabled");
		expect(account?.authInvalidatedAt).toBeUndefined();
	}
	expect((await capturePendingAuth(path, [])).entries).toHaveLength(3);
});

it.each(["EACCES", "EPERM", "EBUSY", "corrupt"])("never routes a cached native primary when journal observation fails (%s)", async failure => {
	const primary = pool("a");
	const reader = createNativeAccountStorageReader(async () => primary, path);
	expect((await reader()).verified).toBe(true);
	if (failure === "corrupt") await fs.writeFile(getPendingAuthPath(path), "private corrupt fixture");
	else {
		const read = fs.readFile.bind(fs);
		vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
			if (String(args[0]) === getPendingAuthPath(path)) throw Object.assign(Error("private fixture reason"), {code: failure});
			return read(...args);
		});
	}
	const snapshot = await reader();
	expect(snapshot.storage).toBeNull();
	expect(snapshot.verified).toBe(false);
	expect(snapshot.routingAvailable).not.toBe(true);
});

it("reconciles fresh journal restrictions during primary-only grace beyond two seconds and bounds age monotonically", async () => {
	let elapsed = 1000;
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const read = vi.fn().mockResolvedValueOnce(pool("a")).mockRejectedValue(Object.assign(Error("locked primary"), {code: "EBUSY"}));
	const reader = createNativeAccountStorageReader(read, path);
	expect((await reader()).verified).toBe(true);
	elapsed += 3000;
	const available = await reader();
	expect(available).toMatchObject({verified: false, routingAvailable: true});
	expect(available.storage?.accounts[0]?.refreshToken).toBe("a");
	await recordPendingAuth(path, {...rotation("a", "a"), authInvalidatedAt: 5000, enabled: false});
	expect((await reader()).storage?.accounts[0]).toMatchObject({authInvalidatedAt: 5000, enabled: false});
	vi.spyOn(Date, "now").mockReturnValue(1);
	elapsed = 31001;
	expect(await reader()).toMatchObject({storage: null, verified: false, routingAvailable: false});
});

it("surfaces a sanitized journal observation failure from ordinary and transaction hydration", async () => {
	await fs.writeFile(path, JSON.stringify(pool("a")));
	await fs.writeFile(getPendingAuthPath(path), "private corrupt fixture");
	await expect(applyPendingAuth(path, pool("a"))).rejects.toThrow("Failed to observe pending account recovery");
	await expect(loadAccounts()).rejects.toThrow("Failed to observe pending account recovery");
	await expect(withAccountStorageTransaction(async () => undefined)).rejects.toThrow("Failed to observe pending account recovery");
});

it.each(["disablement", "revocation", "auth-cooldown"])("commits recovery from effective primary authorization before historical restoration (%s)", async restriction => {
	const primary = pool("a");
	const original = primary.accounts[0];
	if (!original) throw Error("Fixture account missing");
	Object.assign(original, restriction === "disablement" ? {enabled: false} : restriction === "revocation" ? {authInvalidatedAt: 1500, authInvalidationErrorCode: "token_invalidated"} : {cooldownReason: "auth-failure", coolingDownUntil: Date.now() + 60000});
	await saveAccounts(primary);
	await recordPendingAuth(path, rotation("a", "a"));
	const current = await loadAccounts();
	const account = current?.accounts[0];
	if (!current || !account) throw Error("Fixture account missing");
	account.enabled = true;
	delete account.authInvalidatedAt;
	delete account.authInvalidationErrorCode;
	delete account.cooldownReason;
	delete account.coolingDownUntil;
	await saveAccounts(current);
	expect((await capturePendingAuth(path, [])).entries[0]?.committed).toBe(true);
	await fs.writeFile(path, "{torn primary fixture");
	const restored = (await loadAccounts())?.accounts[0];
	expect(restored?.enabled).not.toBe(false);
	expect(restored?.authInvalidatedAt).toBeUndefined();
	expect(restored?.cooldownReason).toBeUndefined();
});
