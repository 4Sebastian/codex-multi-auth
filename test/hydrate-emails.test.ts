import { afterAll, describe, expect, it, vi } from "vitest";
import { useAccountSourceFixtures, writeAccountSourceFixture } from "./helpers/account-source-fixture.js";
useAccountSourceFixtures();
import { hydrateRuntimeEmails } from "../lib/runtime/hydrate-emails.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { TokenResult } from "../lib/types.js";

const ORIGINAL_ENV = { ...process.env };

async function withTestEnv<T>(fn: () => Promise<T> | T): Promise<T> {
	// hydrateRuntimeEmails short-circuits in test mode by design — clear the
	// flags it watches for so the function actually runs in this suite.
	// Must be async + await fn() so the finally block doesn't restore the
	// env BEFORE fn's first internal await resolves.
	const previous = {
		VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
		NODE_ENV: process.env.NODE_ENV,
		CODEX_SKIP_EMAIL_HYDRATE: process.env.CODEX_SKIP_EMAIL_HYDRATE,
	};
	delete process.env.VITEST_WORKER_ID;
	delete process.env.NODE_ENV;
	delete process.env.CODEX_SKIP_EMAIL_HYDRATE;
	try {
		return await fn();
	} finally {
		if (previous.VITEST_WORKER_ID !== undefined)
			process.env.VITEST_WORKER_ID = previous.VITEST_WORKER_ID;
		if (previous.NODE_ENV !== undefined) process.env.NODE_ENV = previous.NODE_ENV;
		if (previous.CODEX_SKIP_EMAIL_HYDRATE !== undefined)
			process.env.CODEX_SKIP_EMAIL_HYDRATE = previous.CODEX_SKIP_EMAIL_HYDRATE;
	}
}

function makeStorage(
	accounts: Array<Partial<AccountStorageV3["accounts"][number]>>,
): AccountStorageV3 {
	const storage: AccountStorageV3 = {
		version: 3,
		accounts: accounts.map((a) => ({
			addedAt: 1, lastUsed: 1,
			refreshToken: "rt",
			...a,
		})) as AccountStorageV3["accounts"],
		activeIndex: 0,
		activeIndexByFamily: {},
	};
	writeAccountSourceFixture(storage);
	return storage;
}

function tokenSuccess(overrides: Partial<TokenResult & { type: "success" }>): TokenResult {
	return {
		type: "success",
		access: "access",
		refresh: "rt",
		idToken: undefined,
		expires: Date.now() + 60_000,
		...overrides,
	} as TokenResult;
}

afterAll(() => {
	process.env = ORIGINAL_ENV;
});

describe("hydrateRuntimeEmails", () => {
	it("does not collapse two accounts that share an undefined accountId", async () => {
		await withTestEnv(async () => {
			const storage = makeStorage([
				{ refreshToken: "rt-a", accountId: undefined },
				{ refreshToken: "rt-b", accountId: undefined },
			]);

			const refreshByToken = new Map<string, TokenResult>([
				["rt-a", tokenSuccess({ access: "tok-a" })],
				["rt-b", tokenSuccess({ access: "tok-b" })],
			]);

			const saveAccounts = vi.fn(async () => undefined);

			await hydrateRuntimeEmails(storage, {
				queuedRefresh: async (rt) => refreshByToken.get(rt) ?? { type: "failed" } as TokenResult,
				extractAccountId: (access) => (access === "tok-a" ? "id-a" : access === "tok-b" ? "id-b" : undefined),
				sanitizeEmail: (email) => email,
				extractAccountEmail: (access) => (access === "tok-a" ? "a@example.com" : access === "tok-b" ? "b@example.com" : undefined),
				shouldUpdateAccountIdFromToken: () => true,
				saveAccounts,
				logWarn: () => {},
				pluginName: "test",
			});

			// Each row got its own hydrated email/accessToken — no cross-contamination.
			expect(storage.accounts[0]?.email).toBe("a@example.com");
			expect(storage.accounts[1]?.email).toBe("b@example.com");
			expect(storage.accounts[0]?.accessToken).toBe("tok-a");
			expect(storage.accounts[1]?.accessToken).toBe("tok-b");
			expect(storage.accounts[0]?.accountId).toBe("id-a");
			expect(storage.accounts[1]?.accountId).toBe("id-b");
			expect(saveAccounts).toHaveBeenCalledTimes(1);
		});
	});

	it("preserves untouched accounts when only some are hydrated", async () => {
		await withTestEnv(async () => {
			const storage = makeStorage([
				{ refreshToken: "rt-stale", email: "preserved@example.com", accountId: "preserved" },
				{ refreshToken: "rt-new", accountId: undefined },
			]);

			const saveAccounts = vi.fn(async () => undefined);

			await hydrateRuntimeEmails(storage, {
				queuedRefresh: async (rt) =>
					rt === "rt-new"
						? tokenSuccess({ access: "fresh" })
						: ({ type: "failed" } as TokenResult),
				extractAccountId: () => "fresh-id",
				sanitizeEmail: (email) => email,
				extractAccountEmail: () => "fresh@example.com",
				shouldUpdateAccountIdFromToken: () => true,
				saveAccounts,
				logWarn: () => {},
				pluginName: "test",
			});

			// Index 0 was already populated → untouched.
			expect(storage.accounts[0]?.email).toBe("preserved@example.com");
			expect(storage.accounts[0]?.accountId).toBe("preserved");
			// Index 1 was hydrated.
			expect(storage.accounts[1]?.email).toBe("fresh@example.com");
			expect(storage.accounts[1]?.accountId).toBe("fresh-id");
			// Hydration committed exactly once.
			expect(saveAccounts).toHaveBeenCalledTimes(1);
		});
	});

	it("does not call saveAccounts when every queuedRefresh fails", async () => {
		await withTestEnv(async () => {
			const storage = makeStorage([{ refreshToken: "rt-x" }]);
			const saveAccounts = vi.fn(async () => undefined);
			const logWarn = vi.fn();

			await hydrateRuntimeEmails(storage, {
				queuedRefresh: async () => ({ type: "failed" } as TokenResult),
				extractAccountId: () => undefined,
				sanitizeEmail: (email) => email,
				extractAccountEmail: () => undefined,
				shouldUpdateAccountIdFromToken: () => true,
				saveAccounts,
				logWarn,
				pluginName: "test",
			});

			// changed===false → no save, no patching.
			expect(saveAccounts).not.toHaveBeenCalled();
			expect(storage.accounts[0]?.email).toBeUndefined();
			expect(storage.accounts[0]?.accessToken).toBeUndefined();
		});
	});
});
