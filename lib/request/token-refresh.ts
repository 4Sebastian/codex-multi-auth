/**
 * Token refresh helpers for the custom fetch implementation
 * Extracted from fetch-helpers.ts (audit roadmap §4.1.2); fetch-helpers.ts
 * re-exports the public symbols so existing importers are unchanged.
 */

import type { Auth, CodexClient } from "@codex-ai/sdk";
import { captureRefreshCredentialAuthority, PendingAuthAdmissionError, PendingAuthSettlementError, withRefreshCredentialRetention } from "../storage/pending-auth.js";
import { getStoragePath } from "../storage.js";
import type { AccountManager, ManagedAccount } from "../accounts.js";
import { getRefreshQueue, queuedRefresh } from "../refresh-queue.js";
import type { TokenResult } from "../types.js";
import { CodexAuthError } from "../errors.js";
import { HTTP_STATUS, ERROR_MESSAGES } from "../constants.js";

interface CodexAuthSetter {
	auth: {
		set(args: {
			path: { id: string };
			body: {
				type: "oauth";
				access: string;
				refresh: string;
				expires: number;
				multiAccount: boolean;
			};
		}): Promise<unknown>;
	};
}

/**
 * Determines if the current auth token needs to be refreshed
 * @param auth - Current authentication state
 * @returns True if token is expired or invalid
 */
export function shouldRefreshToken(auth: Auth, skewMs = 0, storagePath = getStoragePath()): boolean {
	if (auth.type !== "oauth") return true;
	if (getRefreshQueue().isRefreshing(auth.refresh, storagePath)) return true;
	if (!auth.access) return true;

	const safeSkewMs = Math.max(0, Math.floor(skewMs));
	return auth.expires <= Date.now() + safeSkewMs;
}

function isRetryableRefreshFailure(
	result: Extract<TokenResult, { type: "failed" }>,
): boolean {
	switch (result.reason) {
		case "network_error":
		case "unknown":
		case "invalid_response":
			return true;
		case "missing_refresh":
			return false;
		case "http_error":
			return !(
				result.statusCode === HTTP_STATUS.BAD_REQUEST ||
				result.statusCode === HTTP_STATUS.UNAUTHORIZED ||
				result.statusCode === HTTP_STATUS.FORBIDDEN
			);
		default:
			return false;
	}
}

/**
 * Refreshes the OAuth token and updates stored credentials
 *
 * Mutation contract: on success the passed `currentAuth` object is updated
 * IN PLACE (access/refresh/expires) after the persistence await, and the same
 * reference is returned. Same-account refreshes are serialized by
 * `queuedRefresh`, so two concurrent calls for one account coalesce rather
 * than race; callers must still not share one Auth object across calls for
 * DIFFERENT accounts, and must not read token fields from a shared reference
 * while a refresh for it is in flight (the window between the persistence
 * await and the mutation block exposes the pre-refresh values).
 *
 * @param currentAuth - Current auth state
 * @param client - Codex client for updating stored credentials
 * @returns Updated auth (throws on failure)
 */
export async function refreshAndUpdateToken(
	currentAuth: Auth,
	client: CodexClient,
	source?: {accountManager: AccountManager; account: ManagedAccount},
): Promise<Auth> {
	const authSetter = (client as Partial<CodexAuthSetter>).auth;
	if (!authSetter || typeof authSetter.set !== "function") {
		throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, {
			retryable: false,
		});
	}

	const refreshToken = currentAuth.type === "oauth" ? currentAuth.refresh : "";
	const storagePath = source?.accountManager.resolveSelectionStoragePath() ?? getStoragePath();
	const sourceCurrent = () => !source || source.accountManager.getAccountByIndex(source.account.index) === source.account &&
		source.accountManager.resolveSelectionStoragePath() === storagePath;
	const authCurrent = currentAuth.type === "oauth" ? captureRefreshCredentialAuthority(currentAuth, sourceCurrent, undefined, storagePath) : () => true;
	const accountCurrent = source ? captureRefreshCredentialAuthority(source.account, sourceCurrent, undefined, storagePath) : () => true;
	const publish = async () => {
		const result = await queuedRefresh(refreshToken, storagePath);
		if (!authCurrent(result.type === "success" ? result : undefined) || !accountCurrent(result.type === "success" ? result : undefined)) throw new PendingAuthAdmissionError(Object.assign(Error("Account authority changed before publication"), {code: "ESTALE"}));
		if (result.type === "failed") {
			throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, {
				retryable: isRetryableRefreshFailure(result),
				context: {refreshFailureReason: result.reason, statusCode: result.statusCode},
			});
		}
		try {
			await authSetter.set({
				path: {id: "openai"},
				body: {type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires, multiAccount: true},
			});
		} catch (error) {
			throw new PendingAuthSettlementError(result, error, () => authCurrent(result) && accountCurrent(result), undefined, "journal");
		}
		if (!authCurrent(result) || !accountCurrent(result)) throw new PendingAuthAdmissionError(Object.assign(Error("Account authority changed during publication"), {code: "ESTALE"}));
		return result;
	};
	const retainAuth = () => currentAuth.type === "oauth"
		? withRefreshCredentialRetention(currentAuth, publish, sourceCurrent, undefined, storagePath)
		: publish();
	const refreshResult = source
		? await withRefreshCredentialRetention(source.account, retainAuth, sourceCurrent, undefined, storagePath)
		: await retainAuth();

	// Update current auth reference if it's OAuth type
	if (currentAuth.type === "oauth") {
		currentAuth.access = refreshResult.access;
		currentAuth.refresh = refreshResult.refresh;
		currentAuth.expires = refreshResult.expires;
	}

	return currentAuth;
}
