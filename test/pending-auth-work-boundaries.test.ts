import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPendingAuth, captureQueuedRefreshAuthority } from "../lib/storage/pending-auth.js";
import { setStoragePathDirect } from "../lib/storage.js";
import type { AccountStorageV3 } from "../lib/storage/public-types.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

vi.mock("node:crypto", async importOriginal => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, createHash: vi.fn(actual.createHash) };
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
	const current = captureQueuedRefreshAuthority(path, storage.accounts[999]!.refreshToken);
	expect(current()).toBe(true);
	expect(clone.mock.calls.some(([value]) => value && typeof value === "object" && "accounts" in value &&
		Array.isArray(value.accounts) && value.accounts.length > 1)).toBe(false);
	storage.accounts[999]!.enabled = false;
	await fs.writeFile(path, JSON.stringify(storage));
	expect(current()).toBe(false);
});
