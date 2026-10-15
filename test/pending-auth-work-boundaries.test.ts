import { createHash } from "node:crypto";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPendingAuth, captureQueuedRefreshAuthority } from "../lib/storage/pending-auth.js";
import { setStoragePathDirect } from "../lib/storage.js";
import { AnyAccountStorageSchema } from "../lib/schemas.js";
import { RefreshQueue, resetRefreshQueue } from "../lib/refresh-queue.js";
import { RefreshLeaseCoordinator } from "../lib/refresh-lease.js";
import type { AccountStorageV3 } from "../lib/storage/public-types.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

vi.mock("node:crypto", async importOriginal => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, createHash: vi.fn(actual.createHash) };
});

vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let dir: string;
let path: string;
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const pool = (count: number): AccountStorageV3 => ({
	version: 3,
	activeIndex: 0,
	accounts: Array.from({ length: count }, (_, index) => ({
		recordId: `owner-${index}`,
		refreshToken: `fixture-before-${index}`,
		accessToken: `fixture-access-${index}`,
		expiresAt: 1,
		addedAt: 1,
		lastUsed: 1,
	})),
});

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "pending-work-"));
	path = join(dir, "accounts.json");
	setStoragePathDirect(path);
	vi.clearAllMocks();
});
afterEach(async () => {
	vi.restoreAllMocks();
	resetRefreshQueue();
	setStoragePathDirect(null);
	await removeWithRetry(dir, { recursive: true, force: true });
});

it("overlays every owner at capacity without hashing each token for every journal entry", async () => {
	const storage = pool(1000);
	const entries = storage.accounts.map((account, index) => ({
		prior: sha(account.refreshToken),
		refreshToken: `fixture-after-${index}`,
		accessToken: `fixture-next-access-${index}`,
		expiresAt: 2,
		at: 1,
	}));
	vi.mocked(createHash).mockClear();
	const result = await applyPendingAuth(path, storage, entries);
	expect(createHash).toHaveBeenCalled();
	expect(vi.mocked(createHash).mock.calls.length).toBeLessThanOrEqual(storage.accounts.length);
	expect(result?.accounts.map(account => [account.refreshToken, account.accessToken, account.expiresAt]))
		.toEqual(entries.map(entry => [entry.refreshToken, entry.accessToken, entry.expiresAt]));
});

it("keeps the first journal mapping when duplicate predecessors are present", async () => {
	const storage = pool(1);
	const first = { prior: sha(storage.accounts[0]!.refreshToken), refreshToken: "fixture-first", accessToken: "fixture-first-access", expiresAt: 2, at: 1 };
	const second = { ...first, refreshToken: "fixture-second", accessToken: "fixture-second-access", at: 2 };
	const result = await applyPendingAuth(path, storage, [first, second]);
	expect(result?.accounts[0]).toMatchObject({ refreshToken: first.refreshToken, accessToken: first.accessToken });
});

it("captures an owner without cloning the whole inventory when no journal exists", async () => {
	const storage = pool(1000);
	await fs.writeFile(path, JSON.stringify(storage));
	const clone = vi.spyOn(globalThis, "structuredClone");
	const parse = vi.spyOn(AnyAccountStorageSchema, "parse");
	const current = captureQueuedRefreshAuthority(path, storage.accounts[999]!.refreshToken);
	expect(current()).toBe(true);
	expect(parse).toHaveBeenCalledTimes(1);
	expect(clone.mock.calls.some(([value]) => value && typeof value === "object" && "accounts" in value &&
		Array.isArray(value.accounts) && value.accounts.length > 1)).toBe(false);
	storage.accounts[999]!.enabled = false;
	await fs.writeFile(path, JSON.stringify(storage));
	expect(current()).toBe(false);
});

it("uses the original queue authority and one fresh locked primary parse before spending", async () => {
	const storage = pool(1000);
	await fs.writeFile(path, JSON.stringify(storage));
	const parse = vi.spyOn(AnyAccountStorageSchema, "parse");
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({access_token: "fixture-next", refresh_token: "fixture-rotated", expires_in: 3600}));
	const rename = fs.rename.bind(fs);
	const cause = Object.assign(Error("fixture publication denied"), {code: "EACCES"});
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(to) === `${path}.pending-auth.json`) throw cause;
		return rename(from, to);
	});
	const queue = new RefreshQueue(30_000, new RefreshLeaseCoordinator({enabled: false, leaseDir: join(dir, "leases")}));
	await expect(queue.refresh(storage.accounts[999]!.refreshToken, path))
		.rejects.toMatchObject({code: "EPENDINGAUTHSETTLEMENT", cause});
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(parse).toHaveBeenCalledTimes(2);
	expect(queue.pendingCount).toBe(1);
});

it.each(["disabled owner", "malformed sibling"])("revalidates changed primary bytes before capturing authority: %s", async change => {
	const storage = pool(1000);
	await fs.writeFile(path, JSON.stringify(storage));
	const original = vi.mocked(readFileSync).getMockImplementation()!;
	let reads = 0;
	vi.mocked(readFileSync).mockImplementation((...args) => {
		if (String(args[0]) === path && ++reads === 2) {
			if (change === "disabled owner") storage.accounts[999]!.enabled = false;
			else storage.accounts[0]!.addedAt = Number.NaN;
			writeFileSync(path, JSON.stringify(storage));
		}
		return original(...args);
	});
	expect(() => captureQueuedRefreshAuthority(path, storage.accounts[999]!.refreshToken))
		.toThrow(expect.objectContaining({ code: "EPENDINGAUTHADMISSION" }));
	expect(reads).toBeGreaterThanOrEqual(2);
});
