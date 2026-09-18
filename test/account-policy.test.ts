import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("account policy store", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	async function resetAccountPolicyQueue(): Promise<void> {
		const { resetAccountPolicyWriteQueueForTests } = await import(
			"../lib/account-policy.js"
		);
		resetAccountPolicyWriteQueueForTests();
	}

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-account-policy-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
		await resetAccountPolicyQueue();
	});

	afterEach(async () => {
		await resetAccountPolicyQueue();
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("stores policy rows by hashed account identity", async () => {
		const {
			getAccountPolicyKey,
			getAccountPolicyPath,
			loadAccountPolicyStore,
			saveAccountPolicyStore,
			upsertAccountPolicy,
		} = await import("../lib/account-policy.js");
		const account = {
			accountId: "acct_sensitive",
			email: "owner@example.com",
		};
		const accountKey = getAccountPolicyKey(account, 0);
		const store = await loadAccountPolicyStore();
		upsertAccountPolicy(store, accountKey, (policy) => {
			policy.tags.push("Team A");
			policy.weight = 2;
			policy.paused = true;
			policy.note = "local note";
		}, 123);
		await saveAccountPolicyStore(store);

		const raw = await fs.readFile(getAccountPolicyPath(), "utf8");
		expect(raw).toContain("team-a");
		expect(raw).not.toContain("acct_sensitive");
		expect(raw).not.toContain("owner@example.com");

		const loaded = await loadAccountPolicyStore();
		expect(loaded.accounts[accountKey]).toMatchObject({
			tags: ["team-a"],
			weight: 2,
			paused: true,
			note: "local note",
			updatedAt: 123,
		});
	});

	it("does not use mutable account indexes as policy identity", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");
		const unidentified = {
			accountId: undefined,
			email: undefined,
		};

		expect(getAccountPolicyKey(unidentified, 0)).toBe(
			getAccountPolicyKey(unidentified, 4),
		);
	});

	it("separates two accounts that have neither an accountId nor an email", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");

		// Both used to hash the literal "unknown" and share one policy entry, so
		// pausing, draining or tagging either one silently applied to both.
		expect(
			getAccountPolicyKey({ refreshToken: "refresh-a" }, 0),
		).not.toBe(getAccountPolicyKey({ refreshToken: "refresh-b" }, 1));
	});

	it("keeps the refresh-token fallback key stable across slots", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");
		const account = { refreshToken: "refresh-a" };

		// Policy state is persisted and survives reordering, so the key must not
		// move when the account does.
		expect(getAccountPolicyKey(account, 0)).toBe(getAccountPolicyKey(account, 6));
	});

	it("prefers a real identity over the refresh-token fallback", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");
		const withId = { accountId: "acc_1", refreshToken: "refresh-a" };
		const withEmail = { email: "user@example.com", refreshToken: "refresh-a" };

		// Hydrating an account's identity must not orphan its existing policy.
		expect(getAccountPolicyKey(withId)).toBe(
			getAccountPolicyKey({ accountId: "acc_1", refreshToken: "refresh-z" }),
		);
		expect(getAccountPolicyKey(withEmail)).toBe(
			getAccountPolicyKey({ email: "USER@example.com", refreshToken: "refresh-z" }),
		);
		expect(getAccountPolicyKey(withId)).not.toBe(getAccountPolicyKey(withEmail));
	});

	it("namespaces the refresh token so it cannot collide with an email", async () => {
		const { getAccountPolicyKey } = await import("../lib/account-policy.js");

		expect(getAccountPolicyKey({ refreshToken: "user@example.com" })).not.toBe(
			getAccountPolicyKey({ email: "user@example.com", refreshToken: "refresh-a" }),
		);
	});
});

