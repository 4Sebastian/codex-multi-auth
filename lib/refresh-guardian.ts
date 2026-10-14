import { PendingAuthLocalError } from "./storage/pending-auth.js";
import { createLogger } from "./logger.js";
import { refreshExpiringAccounts } from "./proactive-refresh.js";
import type { AccountManager, CurrentAccountCredential, ManagedAccount } from "./accounts.js";
import { applyMonotonicAuthCooldown } from "./runtime/rotation-token-refresh.js";
import { ACCOUNT_LIMITS } from "./constants.js";
import { CodexAuthError } from "./errors.js";
import type { ModelFamily } from "./prompts/codex.js";
import type { CooldownReason } from "./storage.js";
import type { TokenResult } from "./types.js";

const log = createLogger("refresh-guardian");
const REFRESH_HEALTH_FAMILY: ModelFamily = "codex";

export interface RefreshGuardianOptions {
	intervalMs?: number;
	bufferMs?: number;
}

export interface RefreshGuardianStats {
	runs: number;
	refreshed: number;
	failed: number;
	notNeeded: number;
	noRefreshToken: number;
	rateLimited: number;
	networkFailed: number;
	authFailed: number;
	lastRunAt: number | null;
}

const DEFAULT_INTERVAL_MS = 60_000;
const NETWORK_FAILURE_COOLDOWN_MS = 6_000;

export class RefreshGuardian {
	private readonly getAccountManager: () => AccountManager | null;
	private readonly intervalMs: number;
	private readonly bufferMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private stats: RefreshGuardianStats = {
		runs: 0,
		refreshed: 0,
		failed: 0,
		notNeeded: 0,
		noRefreshToken: 0,
		rateLimited: 0,
		networkFailed: 0,
		authFailed: 0,
		lastRunAt: null,
	};

	constructor(
		getAccountManager: () => AccountManager | null,
		options: RefreshGuardianOptions = {},
	) {
		this.getAccountManager = getAccountManager;
		this.intervalMs = Math.max(5_000, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
		this.bufferMs = Math.max(30_000, Math.floor(options.bufferMs ?? 5 * 60_000));
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		if (typeof this.timer === "object" && "unref" in this.timer && typeof this.timer.unref === "function") {
			this.timer.unref();
		}
		log.debug("Refresh guardian started", {
			intervalMs: this.intervalMs,
			bufferMs: this.bufferMs,
		});
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	getStats(): RefreshGuardianStats {
		return { ...this.stats };
	}

	private classifyFailureReason(tokenResult: TokenResult | undefined): CooldownReason {
		if (!tokenResult || tokenResult.type !== "failed") {
			return "network-error";
		}

		const statusCode = tokenResult.statusCode;
		if (statusCode === 429) return "rate-limit";
		if (tokenResult.reason === "network_error") return "network-error";
		if (tokenResult.reason === "missing_refresh") return "auth-failure";
		if (tokenResult.reason === "invalid_response") return "auth-failure";
		if (
			tokenResult.reason === "http_error" &&
			(statusCode === 400 || statusCode === 401 || statusCode === 403)
		) {
			return "auth-failure";
		}
		return "network-error";
	}

	private getNetworkFailureCooldownMs(): number {
		return Math.min(this.bufferMs, NETWORK_FAILURE_COOLDOWN_MS);
	}

	private getAuthFailureCooldownMs(failureCount: number): number {
		const streak = Math.max(1, Math.floor(failureCount));
		return Math.min(this.bufferMs, ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS * streak);
	}

	private async applyRefreshOutcome(
		manager: AccountManager,
		sourceAccount: ReturnType<AccountManager["getAccountsSnapshot"]>[number],
		result: Awaited<ReturnType<typeof refreshExpiringAccounts>> extends Map<
			number,
			infer TValue
		>
			? TValue
			: never,
		refreshHealth: (success?: boolean) => boolean,
		owner: {account: ManagedAccount; submitted: CurrentAccountCredential; storagePath: string},
	): Promise<void> {
		const ownerCurrent = () => this.getAccountManager() === manager &&
			manager.resolveSelectionStoragePath() === owner.storagePath &&
			manager.getAccountByIndex(owner.account.index) === owner.account;
		if (!ownerCurrent()) return;
		if (result.reason === "not_needed") {
			this.stats.notNeeded += 1;
			return;
		}
		let cooldownReason: CooldownReason = result.reason === "no_refresh_token"
			? "auth-failure" : result.reason === "success" ? "network-error" : this.classifyFailureReason(result.tokenResult);
		if (result.reason === "success" && result.tokenResult?.type === "success") {
			const refreshedAuth = {
				type: "oauth" as const,
				access: result.tokenResult.access,
				refresh: result.tokenResult.refresh,
				expires: result.tokenResult.expires,
				multiAccount: true,
			};
			try {
				const committed = await manager.commitRefreshedAuth(sourceAccount, refreshedAuth);
				if (committed) {
					const applied = await manager.withCurrentAccountCredential(committed, {
						...owner.submitted, accessToken: refreshedAuth.access,
						refreshToken: refreshedAuth.refresh, expiresAt: refreshedAuth.expires,
					}, () => ownerCurrent() && refreshHealth(), false);
					if (applied) this.stats.refreshed += 1;
					return;
				}
				cooldownReason = "network-error";
			} catch (error) {
				log.warn("Refresh guardian commit failed", {
					sourceIndex: sourceAccount.index,
					error: error instanceof Error ? error.message : String(error),
				});
				if (error instanceof PendingAuthLocalError) {
					this.stats.failed += 1;
					return;
				}
				cooldownReason = error instanceof CodexAuthError && !error.retryable
					? "auth-failure" : "network-error";
			}
		}
		const account = owner.account;
		const applied = await manager.withCurrentAccountCredential(account, owner.submitted, row => {
			if (!ownerCurrent() || account.enabled === false) return false;
			if ((row?.coolingDownUntil ?? 0) > (account.coolingDownUntil ?? 0)) {
				account.coolingDownUntil = row?.coolingDownUntil;
				account.cooldownReason = row?.cooldownReason;
			}
			if (cooldownReason === "rate-limit") {
				manager.clearAuthFailures(account);
				manager.markRateLimited(account, this.bufferMs, "codex");
				manager.recordRateLimit(account, REFRESH_HEALTH_FAMILY);
			} else if (cooldownReason === "auth-failure") {
				const count = manager.incrementAuthFailures(account);
				applyMonotonicAuthCooldown(manager, account, this.getAuthFailureCooldownMs(count), owner.submitted);
				refreshHealth(false);
			} else {
				manager.clearAuthFailures(account);
				const duration = this.getNetworkFailureCooldownMs();
				if (Date.now() + duration > (account.coolingDownUntil ?? 0)) {
					manager.markAccountCoolingDown(account, duration, cooldownReason);
				}
				refreshHealth(false);
			}
			if (result.reason === "no_refresh_token") manager.setAccountEnabled(account.index, false);
			return true;
		});
		if (!applied) return;
		this.stats.failed += 1;
		if (result.reason === "no_refresh_token") this.stats.noRefreshToken += 1;
		if (cooldownReason === "rate-limit") this.stats.rateLimited += 1;
		else if (cooldownReason === "auth-failure") this.stats.authFailed += 1;
		else this.stats.networkFailed += 1;
		return;
	}

	async tick(): Promise<void> {
		if (this.running) return;
		const manager = this.getAccountManager();
		if (!manager) return;
		this.running = true;
		try {
			const snapshot = manager.getAccountsSnapshot().filter((account) => account.enabled !== false).map(account => ({...account}));
			if (snapshot.length === 0) {
				return;
			}

			const eligibleSnapshot = snapshot.filter((account) => !manager.isAccountCoolingDown(account));
			if (eligibleSnapshot.length === 0) {
				this.stats.runs += 1;
				this.stats.lastRunAt = Date.now();
				return;
			}

			const storagePath = manager.resolveSelectionStoragePath();
			const owners = new Map(eligibleSnapshot.map(source => {
				const account = manager.getAccountByIdentity(source);
				return [source.index, account ? {
					account, storagePath,
					submitted: {recordId: account.recordId, accessToken: account.access,
						refreshToken: account.refreshToken, expiresAt: account.expires, accountId: account.accountId},
				} : undefined] as const;
			}));
			const refreshHealth = new Map(eligibleSnapshot.map(source => {
				const account = manager.getAccountByIdentity(source);
				return [source.index, account ? manager.captureRefreshHealth(account, REFRESH_HEALTH_FAMILY) : () => false] as const;
			}));
			const refreshResults = await refreshExpiringAccounts(
				eligibleSnapshot,
				this.bufferMs,
				async (sourceAccount, result) => {
					const owner = owners.get(sourceAccount.index);
					if (!owner) return;
					await this.applyRefreshOutcome(
						manager,
						sourceAccount,
						result,
						refreshHealth.get(sourceAccount.index) ?? (() => false),
						owner,
					);
				},
				storagePath,
				source => manager.resolveSelectionStoragePath() === storagePath ? manager.getAccountByIdentity(source) : null,
			);
			if (refreshResults.size === 0) {
				this.stats.runs += 1;
				this.stats.lastRunAt = Date.now();
				return;
			}

			this.stats.runs += 1;
			this.stats.lastRunAt = Date.now();
		} catch (error) {
			if (error instanceof PendingAuthLocalError) {
				this.stats.failed += 1;
			}
			log.warn("Refresh guardian tick failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.running = false;
		}
	}
}
