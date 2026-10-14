import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyRuntimeFlaggedAccounts } from "../lib/runtime/verify-flagged.js";
import { isFlaggedRecoverySourceCurrent, PendingAuthAdmissionError } from "../lib/storage/pending-auth.js";
import { getIntentionalResetMarkerPath } from "../lib/storage/backup-paths.js";
import { getFlaggedAccountsPath, loadAccounts, loadFlaggedAccounts, setStoragePathDirect, withAccountAndFlaggedStorageTransaction, type FlaggedAccountStorageV1 } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let dir: string, path: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "flagged-publication-")); path = join(dir, "accounts.json");
	setStoragePathDirect(path);
	await fs.writeFile(path, JSON.stringify({version: 3, activeIndex: 0, accounts: []}));
});
afterEach(async () => {
	vi.restoreAllMocks(); setStoragePathDirect(null);
	await removeWithRetry(dir, {recursive: true, force: true});
});

it("never converts a future-expiry cached credential into flagged recovery proof", async () => {
	const flagged: FlaggedAccountStorageV1 = {version: 1, accounts: [{recordId: "revoked-cache-owner", email: "fixture@example.com", accountId: "W1", accessToken: "revoked-access", refreshToken: "revoked-refresh", expiresAt: Date.now() + 3600000, authInvalidatedAt: 1, authInvalidationErrorCode: "token_invalidated", flaggedAt: 1, addedAt: 1, lastUsed: 1}]};
	await fs.writeFile(getFlaggedAccountsPath(), JSON.stringify(flagged));
	const cached = vi.fn(async () => ({accessToken: "revoked-access", refreshToken: "revoked-refresh", expiresAt: Date.now() + 3600000}));
	const refresh = vi.fn(async () => ({type: "failed" as const, reason: "invalid_grant" as const, message: "fixture refused recovery"}));
	const publish = vi.fn<Parameters<typeof verifyRuntimeFlaggedAccounts>[0]["persistAccountsAndFlagged"]>().mockResolvedValue(undefined), invalidate = vi.fn();
	await verifyRuntimeFlaggedAccounts({loadFlaggedAccounts, lookupCodexCliTokensByEmail: cached, queuedRefresh: refresh, resolveTokenSuccessAccount: tokens => ({...tokens}), persistAccounts: vi.fn(), saveFlaggedAccounts: vi.fn(), persistAccountsAndFlagged: publish, invalidateAccountManagerCache: invalidate, showLine: vi.fn()});
	expect(refresh).toHaveBeenCalledOnce();
	expect(publish.mock.calls[0]?.[0]).toEqual([]);
	expect(invalidate).not.toHaveBeenCalled();
	expect((await loadAccounts())?.accounts).toEqual([]);
});

it.each(["healthy", "delete", "reset", "flagged-reset", "record", "expiry", "revocation", "replacement"])("publishes flagged recovery only while its original source remains current (%s)", async change => {
	const flagged: FlaggedAccountStorageV1 = {version: 1, accounts: [{recordId: "flagged-owner", accountId: "W1", accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 3600000, authInvalidatedAt: 1, authInvalidationErrorCode: "token_invalidated", flaggedAt: 1, flaggedReason: "token_invalidated", addedAt: 1, lastUsed: 1}]};
	await fs.writeFile(getFlaggedAccountsPath(), JSON.stringify(flagged));
	const queuedRefresh = vi.fn(async () => ({type: "success" as const, access: "new-access", refresh: "new-refresh", expires: Date.now() + 7200000}));
	const cached = vi.fn(async () => ({accessToken: "cached-revoked", refreshToken: "cached-refresh", expiresAt: Date.now() + 7200000}));
	const publication = verifyRuntimeFlaggedAccounts({
		loadFlaggedAccounts, lookupCodexCliTokensByEmail: cached, queuedRefresh, resolveTokenSuccessAccount: tokens => ({...tokens}),
		persistAccounts: async () => {throw Error("Unowned separate publication");}, saveFlaggedAccounts: async () => {throw Error("Unowned separate flagged save");},
		invalidateAccountManagerCache: vi.fn(), showLine: vi.fn(),
		persistAccountsAndFlagged: async (results, _nextFlagged, _replaceAll, current, sources) => {
			const row = flagged.accounts[0]!;
			if (change === "delete") flagged.accounts = [];
			if (change === "record") row.recordId = "replacement-owner";
			if (change === "expiry") row.expiresAt = (row.expiresAt ?? 0) + 1;
			if (change === "revocation") row.authInvalidatedAt = 2;
			if (change === "replacement") row.refreshToken = "replacement-refresh";
			if (change === "reset") await fs.writeFile(getIntentionalResetMarkerPath(path), "{}");
			if (change === "flagged-reset") await fs.writeFile(getIntentionalResetMarkerPath(getFlaggedAccountsPath()), "{}");
			await fs.writeFile(getFlaggedAccountsPath(), JSON.stringify(flagged));
			await withAccountAndFlaggedStorageTransaction(async (storage, persist, currentFlagged) => {
				if (!current() || !sources.every((source, index) => isFlaggedRecoverySourceCurrent(currentFlagged.accounts, source, results[index]))) throw new PendingAuthAdmissionError(Error("Flagged source changed before publication"));
				if (!storage) throw Error("Missing fixture primary");
				storage.accounts = results.map((result, index) => ({recordId: sources[index]!.recordId, accountId: "W1", accessToken: result.access, refreshToken: result.refresh, expiresAt: result.expires, addedAt: 1, lastUsed: 1}));
				await persist(storage, {version: 1, accounts: []});
			});
		},
	});
	if (change === "healthy") await publication;
	else await expect(publication).rejects.toBeInstanceOf(PendingAuthAdmissionError);
	expect(queuedRefresh).toHaveBeenCalledOnce(); expect(cached).not.toHaveBeenCalled();
	expect((await loadAccounts())?.accounts).toHaveLength(change === "healthy" ? 1 : 0);
	if (change === "healthy") expect((await loadFlaggedAccounts()).accounts).toHaveLength(0);
});
