import type { AccountManager, ManagedAccount } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";
import { queuedRefresh } from "../refresh-queue.js";
import {
	isTokenInvalidationError,
	isTokenRefreshRetryable,
} from "../request/rate-limit-decision.js";
import type { OAuthAuthDetails } from "../types.js";

/** @internal */
export const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 30_000;

// Monotonic auth-failure cooldown: only extend, never shorten. Two concurrent
// requests on the same account can race so that an invalidation path sets a
// long cooldown (5 min) and a subsequent generic 401 truncates it (30 s).
// Reading the live coolingDownUntil before writing prevents that race.
/** @internal */
export function applyMonotonicAuthCooldown(
	accountManager: AccountManager,
	account: ManagedAccount,
	cooldownMs: number,
	submittedAccessToken = account.access,
): void {
	if (accountManager.getAccountByIndex(account.index) !== account || account.access !== submittedAccessToken) return;
	const existing = accountManager.getAccountByIndex(account.index)?.coolingDownUntil ?? 0;
	// Intentionally Date.now(), not the proxy's injected now(): coolingDownUntil is
	// written by markAccountCoolingDown via nowMs() (== Date.now()), so both sides of
	// this comparison must live in the same real-wall-clock domain. Switching to the
	// injected now() would mis-compare an injected-clock value against a real-clock
	// deadline and silently defeat the monotonic guard.
	if (Date.now() + cooldownMs > existing) {
		accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
	}
}

function hasUsableAccessToken(
	account: ManagedAccount,
	now: number,
	skewMs: number,
): boolean {
	return (
		typeof account.access === "string" &&
		account.access.trim().length > 0 &&
		typeof account.expires === "number" &&
		account.expires > now + Math.max(0, skewMs)
	);
}

const runtimeRefreshCommitQueues = new WeakMap<
	AccountManager,
	Map<string, Promise<ManagedAccount | null>>
>();

async function commitRefreshedAuthOnce(
	accountManager: AccountManager,
	account: ManagedAccount,
	auth: OAuthAuthDetails,
	priorRefreshToken: string,
): Promise<ManagedAccount | null> {
	const key = [
		account.index,
		account.accountId ?? "",
		account.email ?? "",
		priorRefreshToken,
	].join("\0");
	let queue = runtimeRefreshCommitQueues.get(accountManager);
	if (!queue) {
		queue = new Map();
		runtimeRefreshCommitQueues.set(accountManager, queue);
	}
	const existing = queue.get(key);
	if (existing) return existing;
	const pending = accountManager
		.commitRefreshedAuth(account, auth)
		.finally(() => queue?.delete(key));
	queue.set(key, pending);
	return pending;
}

/** @internal */
export async function ensureFreshAccessToken(params: {
	accountManager: AccountManager;
	account: ManagedAccount;
	family: ModelFamily;
	model: string | null;
	now: number;
	tokenRefreshSkewMs: number;
	tokenInvalidationCooldownMs: number;
}): Promise<
	| { ok: true; accessToken: string; account: ManagedAccount }
	| { ok: false; retryable: boolean; invalidated?: boolean }
> {
	const { accountManager, account, family, model, now, tokenRefreshSkewMs, tokenInvalidationCooldownMs } =
		params;
	if (hasUsableAccessToken(account, now, tokenRefreshSkewMs)) {
		return { ok: true, accessToken: account.access ?? "", account };
	}

	const submittedAccessToken = account.access, submittedRefreshToken = account.refreshToken;
	const refreshResult = await queuedRefresh(submittedRefreshToken);
	if ((account.access !== submittedAccessToken || account.refreshToken !== submittedRefreshToken) &&
		!(refreshResult.type === "success" && account.access === refreshResult.access && account.refreshToken === refreshResult.refresh)) {
		return accountManager.getAccountByIndex(account.index) === account && hasUsableAccessToken(account, now, tokenRefreshSkewMs) && account.enabled !== false && !accountManager.isAccountAuthInvalidated(account)
			? {ok: true, accessToken: account.access ?? "", account}
			: {ok: false, retryable: true};
	}
	if (refreshResult.type === "failed") {
		accountManager.recordFailure(account, family, model);
		accountManager.incrementAuthFailures(account);
		// If the refresh endpoint itself returns an explicit invalidation message
		// (e.g. Microsoft/Outlook SSO revokes the refresh token server-side), apply
		// the long cooldown and signal to the caller to stop rotating rather than
		// presenting other accounts' tokens from the same IP.
		const invalidated = isTokenInvalidationError(refreshResult.message ?? "");
		if (invalidated) {
			accountManager.markAuthInvalidated(account, "token_invalidated", undefined, submittedAccessToken);
		}
		applyMonotonicAuthCooldown(
			accountManager,
			account,
			invalidated ? tokenInvalidationCooldownMs : DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
			submittedAccessToken,
		);
		accountManager.saveToDiskDebounced();
		return { ok: false, retryable: isTokenRefreshRetryable(refreshResult), invalidated };
	}

	const auth: OAuthAuthDetails = {
		type: "oauth",
		access: refreshResult.access,
		refresh: refreshResult.refresh,
		expires: refreshResult.expires,
	};
	try {
		const updatedAccount = await commitRefreshedAuthOnce(
			accountManager,
			account,
			auth,
			submittedRefreshToken,
		);
		// If commit succeeded, use the stored access token from the committed
		// account — this also handles the dedup case where two concurrent callers
		// share one commit and both end up with the same committed token.
		// If commit returned null (account missing from storage after persist),
		// fall back to the original account object but always use refreshResult.access:
		// the original account may carry an expired token, and using that would
		// cause a downstream 401 and incorrectly trigger invalidation-cooldown logic.
		const resolvedAccount = updatedAccount ?? account;
		const accessToken =
			updatedAccount !== null
				? (updatedAccount.access ?? refreshResult.access)
				: refreshResult.access;
		return {
			ok: true,
			accessToken,
			account: resolvedAccount,
		};
	} catch {
		if (account.access !== submittedAccessToken || account.refreshToken !== submittedRefreshToken) return {ok: false, retryable: true};
		accountManager.recordFailure(account, family, model);
		accountManager.markAccountCoolingDown(
			account,
			DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
			"auth-failure",
		);
		accountManager.saveToDiskDebounced();
		return { ok: false, retryable: true };
	}
}
