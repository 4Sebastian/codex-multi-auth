import type { AccountManager } from "../accounts.js";
import { sanitizeEmail } from "../auth/token-utils.js";
import type { AccountStorageV3 } from "../storage.js";
import { mergeAccountCooldown } from "../storage/snapshot-merge.js";

type Identity = { recordId?: string; accountId?: string; email?: string; refreshToken?: string };
/**
 * The manager stores sanitized (lower-cased) emails while storage keeps the raw
 * value, so match a stored record ID first and otherwise the canonical identity.
 * Two rows with neither an accountId nor an email share no identity at all
 * (undefined === undefined), so those match only by their refresh token.
 */
export function isSameNativeAccount(account: Identity, disk: Identity | undefined): boolean {
	if (!disk) return false;
	const left = account.recordId?.trim();
	const right = disk.recordId?.trim();
	if (left && right) return left === right;
	const accountId = account.accountId?.trim() || undefined;
	const email = sanitizeEmail(account.email);
	if (!accountId && !email) {
		const token = account.refreshToken?.trim();
		return !disk.accountId?.trim() && !sanitizeEmail(disk.email) && !!token && token === disk.refreshToken?.trim();
	}
	return accountId === (disk.accountId?.trim() || undefined) && email === sanitizeEmail(disk.email);
}

/** Adopt credentials from a re-login without resetting independent quota state. */
export function syncNativeAccountCredentials(
	manager: AccountManager,
	storage: AccountStorageV3,
	capturedAt = performance.now(),
): boolean {
	let changed = manager.syncWorkspaceSelections(storage, capturedAt);
	for (const snapshot of manager.getAccountsSnapshot()) {
		const account = manager.getAccountByIndex(snapshot.index);
		if (!account || !manager.isNativeSnapshotCurrent(account, capturedAt)) continue;
		const disk = storage.accounts.find((a) => isSameNativeAccount(account, a));
		if (!disk) {
			manager.setAccountEnabled(account.index, false);
			changed = true;
			continue;
		}
		const adoptCredentials = manager.acceptNativeCredentials(account, disk);
		changed = manager.syncAuthInvalidationFromSnapshot(account, disk, capturedAt, !adoptCredentials) || changed;
		if (!adoptCredentials) continue;
		if (
			disk.accessToken === account.access &&
			disk.refreshToken === account.refreshToken &&
			disk.expiresAt === account.expires
		)
			continue;
		const replaced = disk.accessToken !== account.access || disk.refreshToken !== account.refreshToken;
		const cooldown = mergeAccountCooldown({...account, accessToken: account.access},
			disk.cooldownReason === "auth-failure" && (disk.coolingDownUntil ?? 0) <= Date.now() ? {...disk, coolingDownUntil: undefined, cooldownReason: undefined} : disk, {
			accessToken: disk.accessToken, refreshToken: disk.refreshToken,
			coolingDownUntil: replaced && account.cooldownReason === "auth-failure" ? undefined : account.coolingDownUntil,
			cooldownReason: replaced && account.cooldownReason === "auth-failure" ? undefined : account.cooldownReason,
		});
		account.access = disk.accessToken;
		account.refreshToken = disk.refreshToken;
		account.expires = disk.expiresAt;
		Object.assign(account, cooldown);
		changed = true;
	}
	return changed;
}
