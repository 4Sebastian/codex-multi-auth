/**
 * OpenAI ChatGPT (Codex) OAuth Authentication Plugin for Codex CLI host runtime
 *
 * COMPLIANCE NOTICE:
 * This plugin uses OpenAI's official OAuth authentication flow (the same method
 * used by OpenAI's official Codex CLI at https://github.com/openai/codex).
 *
 * INTENDED USE: Personal development and coding assistance with your own
 * ChatGPT Plus/Pro subscription.
 *
 * NOT INTENDED FOR: Commercial resale, multi-user services, high-volume
 * automated extraction, or any use that violates OpenAI's Terms of Service.
 *
 * Users are responsible for ensuring their usage complies with:
 * - OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
 * - OpenAI Usage Policies: https://openai.com/policies/usage-policies/
 *
 * For production applications, use the OpenAI Platform API: https://platform.openai.com/
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @author ndycode
 * @repository https://github.com/ndycode/codex-multi-auth

 */

import type { Plugin, PluginInput } from "@codex-ai/plugin";
import { tool } from "@codex-ai/plugin/tool";
import type { Auth } from "@codex-ai/sdk";
import {
	AccountManager,
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	formatCooldown,
	formatWaitTime,
	getAccountIdCandidates,
	isCodexCliSyncEnabled,
	lookupCodexCliTokensByEmail,
	parseRateLimitReason,
	resolveRequestAccountId,
	resolveRuntimeRequestIdentity,
	sanitizeEmail,
	selectBestAccountCandidate,
	shouldUpdateAccountIdFromToken,
} from "./lib/accounts.js";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	redactOAuthUrlForLog,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import {
	isBrowserLaunchSuppressed,
	openBrowserUrl,
} from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { checkAndNotify } from "./lib/update-notice.js";
import { CapabilityPolicyStore } from "./lib/capability-policy.js";
import { promptAddAnotherAccount, promptLoginMode } from "./lib/cli.js";
import {
	getAutoResume,
	getCodexMode,
	getEmptyResponseMaxRetries,
	getFallbackToGpt52OnUnsupportedGpt53,
	getFastSession,
	getFastSessionMaxInputItems,
	getFastSessionStrategy,
	getFetchTimeoutMs,
	getRateLimitDedupWindowMs,
	getRateLimitMaxBackoffMs,
	getRateLimitShortRetryThresholdMs,
	getRateLimitStateResetMs,
	getLiveAccountSync,
	getLiveAccountSyncDebounceMs,
	getLiveAccountSyncPollMs,
	getNetworkErrorCooldownMs,
	getPerProjectAccounts,
	getPidOffsetEnabled,
	getPreemptiveQuotaEnabled,
	getPreemptiveQuotaMaxDeferralMs,
	getPreemptiveQuotaRemainingPercent5h,
	getPreemptiveQuotaRemainingPercent7d,
	getContextBudgetGuardEnabled,
	getContextBudgetGuardSoftPercent,
	getContextBudgetGuardHardPercent,
	getContextBudgetGuardModelWindowOverrides,
	getProactiveRefreshBufferMs,
	getProactiveRefreshGuardian,
	getProactiveRefreshIntervalMs,
	getRateLimitToastDebounceMs,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getRetryAllAccountsRateLimited,
	getBackgroundResponses,
	getResponseContinuation,
	getServerErrorCooldownMs,
	getSessionAffinity,
	getSessionAffinityMaxEntries,
	getSessionAffinityTtlMs,
	getSessionRecovery,
	getStorageBackupEnabled,
	getStreamStallTimeoutMs,
	getToastDurationMs,
	getTokenRefreshSkewMs,
	getUnsupportedCodexFallbackChain,
	getUnsupportedCodexPolicy,
	loadPluginConfig,
} from "./lib/config.js";
import {
	ACCOUNT_LIMITS,
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	LOG_STAGES,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";
import { handleContextOverflow } from "./lib/context-overflow.js";
import { ContextBudgetGuard } from "./lib/context-budget-guard.js";
import {
	buildContextBudgetHeaders,
	createContextBudgetPauseResponse,
} from "./lib/context-budget-response.js";
import {
	EntitlementCache,
	resolveEntitlementAccountKey,
} from "./lib/entitlement-cache.js";
import { LiveAccountSync } from "./lib/live-account-sync.js";
import {
	clearCorrelationId,
	initLogger,
	logDebug,
	logError,
	logInfo,
	logRequest,
	logWarn,
	setCorrelationId,
} from "./lib/logger.js";
import {
	PreemptiveQuotaScheduler,
	readQuotaSchedulerSnapshot,
	type QuotaObservationReceipt,
} from "./lib/preemptive-quota-scheduler.js";
import { modelScopeId } from "./lib/runtime/workspace-model-scopes.js";
import {
	createRuntimeUsageRecorder,
	evaluateRuntimePolicy,
	loadRuntimePolicyState,
	type RuntimePolicyDecision,
	type RuntimeUsageRecorder,
	type RuntimeUsageRecordInput,
} from "./lib/policy/runtime-policy.js";
import { createStreamUsageDeferral } from "./lib/usage/stream-usage-deferral.js";

const USAGE_STREAM_IDLE_TIMEOUT_MS = 15 * 60_000;
import {
	getModelFamily,
	MODEL_FAMILIES,
	prewarmCodexInstructions,
} from "./lib/prompts/codex.js";
import { prewarmHostCodexPrompt } from "./lib/prompts/host-codex-prompt.js";
import {
	fetchCodexQuotaSnapshot,
	formatQuotaSnapshotLine,
} from "./lib/quota-probe.js";
import { loadQuotaCache, type QuotaCacheEntry } from "./lib/quota-cache.js";
import {
	findQuotaCacheEntryForAccount,
	isQuotaCacheEntryExhausted,
} from "./lib/quota-readiness.js";
import {
	detectErrorType,
	getRecoveryToastContent,
	isRecoverableError,
} from "./lib/recovery.js";
import { RefreshGuardian } from "./lib/refresh-guardian.js";
import type { CircuitAdmissionReceipt } from "./lib/circuit-breaker.js";
import { queuedRefresh } from "./lib/refresh-queue.js";
import { createAccountDispatch } from "./lib/request/account-dispatch.js";
import { isFlaggedRecoverySourceCurrent, PendingAuthLocalError, withRefreshCredentialRetention } from "./lib/storage/pending-auth.js";
import {
	parseEnvInt,
	parseFailoverMode,
} from "./lib/request/failover-config.js";
import {
	capStreamFailoverMax,
	computeOutboundRequestAttemptBudget,
} from "./lib/request/request-attempt-budget.js";
import {
	armPoolExhaustionCooldown,
	clearPoolExhaustionCooldown,
	clearServerBurstCooldown,
	getPoolExhaustionCooldownRemaining,
	getServerBurstCooldownRemaining,
	recordServerBurstFailure,
} from "./lib/request/request-resilience.js";
import {
	evaluateFailurePolicy,
	type FailoverMode,
} from "./lib/request/failure-policy.js";
import {
	applyProxyCompatibleInit,
	createCodexHeaders,
	extractRequestUrl,
	getUnsupportedCodexModelInfo,
	handleErrorResponse,
	handleSuccessResponse,
	isWorkspaceDisabledError,
	refreshAndUpdateToken,
	resolveUnsupportedCodexFallbackModel,
	rewriteUrlForCodex,
	shouldRefreshToken,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import {
	configureRateLimitBackoff,
	getRateLimitBackoff,
	MAX_SHORT_RETRY_ATTEMPTS,
	getRateLimitShortRetryThresholdMs as getConfiguredRateLimitShortRetryThresholdMs,
	resetRateLimitBackoff,
} from "./lib/request/rate-limit-backoff.js";
import {
	normalizeRequestInit,
	parseRequestBodyFromInit,
} from "./lib/request/request-init.js";
import { CURRENT_CODEX_MODEL } from "./lib/request/helpers/model-map.js";
import { applyFastSessionDefaults } from "./lib/request/request-transformer.js";
import { applyResponseCompaction } from "./lib/request/response-compaction.js";
import { CodexAuthError } from "./lib/errors.js";
import {
	parseRetryAfterHintMs,
	sanitizeResponseHeadersForLog,
} from "./lib/request/response-metadata.js";
import { withStreamingFailover } from "./lib/request/stream-failover.js";
import {
	createAbortableSleep,
	sleepWithCountdown,
} from "./lib/request/wait-utils.js";
import { addJitter } from "./lib/rotation.js";
import {
	clampActiveIndices,
	isFlaggableFailure,
} from "./lib/runtime/account-check-helpers.js";
import { runRuntimeAccountCheck } from "./lib/runtime/account-check.js";
import { createAccountCheckWorkingState } from "./lib/runtime/account-check-types.js";
import {
	invalidateRuntimeAccountManagerCache,
	reloadRuntimeAccountManager,
} from "./lib/runtime/account-manager-cache.js";
import {
	type TokenSuccessWithAccount as AccountPoolTokenSuccessWithAccount,
	persistAccountPoolResults,
} from "./lib/runtime/account-pool.js";
import { resolveAccountSelection } from "./lib/runtime/account-selection.js";
import {
	formatRateLimitEntry,
	getRateLimitResetTimeForFamily,
	resolveActiveIndex,
} from "./lib/runtime/account-status.js";
import {
	createPersistAccounts,
	runRuntimeOAuthFlow,
} from "./lib/runtime/auth-facade.js";
import { applyAccountStorageScopeEntry } from "./lib/runtime/account-storage-scope-entry.js";
import { getAppBindStatus } from "./lib/runtime/app-bind.js";
import { runBrowserOAuthFlow } from "./lib/runtime/browser-oauth-flow.js";
import { handleRuntimeEvent } from "./lib/runtime/event-handler.js";
import { hydrateRuntimeEmails } from "./lib/runtime/hydrate-emails.js";
import { buildLoginMenuAccounts } from "./lib/runtime/login-menu-accounts.js";
import {
	readAppRuntimeHelperAccountSignal,
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
	type AccountCurrentMarker,
} from "./lib/runtime/runtime-current-account.js";
import { isRateLimitedMarker } from "./lib/codex-manager/rate-limit-markers.js";
import { ensureLiveAccountSyncEntry } from "./lib/runtime/live-sync-entry.js";
import { applyLoaderRuntimeSetup } from "./lib/runtime/loader-setup.js";
import { buildManualOAuthFlow } from "./lib/runtime/manual-oauth-flow.js";
import { applyPreemptiveQuotaSettingsFromConfig } from "./lib/runtime/quota-settings.js";
import { applyContextBudgetGuardSettingsFromConfig } from "./lib/runtime/context-budget-settings.js";
import {
	ensureLiveAccountSyncState,
	ensureRefreshGuardianState,
	ensureSessionAffinityState,
} from "./lib/runtime/runtime-services.js";
import {
	getRuntimeObservabilitySnapshot,
	mutateRuntimeObservabilitySnapshot,
} from "./lib/runtime/runtime-observability.js";
import { applyAccountStorageScopeFromConfig } from "./lib/runtime/storage-scope.js";
import { showRuntimeToast } from "./lib/runtime/toast.js";
import { createRuntimeSessionRecoveryHook } from "./lib/runtime/session-recovery.js";
import {
	applyUiRuntimeFromConfig,
	getStatusMarker,
} from "./lib/runtime/ui-runtime.js";
import { verifyRuntimeFlaggedAccounts } from "./lib/runtime/verify-flagged.js";
import { SessionAffinityStore } from "./lib/session-affinity.js";
import { clearAccountsAndCredentialSidecars } from "./lib/storage/credential-sidecars.js";
import { registerCleanup } from "./lib/shutdown.js";
import {
	type AccountStorageV3,
	clearAccounts,
	clearFlaggedAccounts,
	exportAccounts,
	findMatchingAccountIndex,
	formatStorageErrorHint,
	getStoragePath,
	importAccounts,
	loadAccounts,
	loadFlaggedAccounts,
	StorageError,
	saveAccounts,
	saveFlaggedAccounts,
	setStorageBackupEnabled,
	setStoragePath,
	withAccountAndFlaggedStorageTransaction,
	withFlaggedStorageTransaction,
	withAccountStorageTransaction,
} from "./lib/storage.js";
import {
	buildTableHeader,
	buildTableRow,
	type TableOptions,
} from "./lib/table-formatter.js";
import {
	createHashlineEditTool,
	createHashlineReadTool,
} from "./lib/tools/hashline-tools.js";
import type {
	OAuthAuthDetails,
	RequestBody,
	TokenResult,
	UserConfig,
} from "./lib/types.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
	paintUiText,
} from "./lib/ui/format.js";
import { setUiRuntimeOptions } from "./lib/ui/runtime.js";

function currentMarkerLabel(marker: AccountCurrentMarker): string {
	return marker === "in-use" ? "in use" : marker;
}

async function resolveRuntimeCurrentForStorage(
	storage: AccountStorageV3,
	now: number,
) {
	const [appBindStatus, appHelperStatus] = await Promise.all([
		getAppBindStatus()
			.then((status) => (status.running ? status.router : null))
			.catch(() => null),
		Promise.resolve()
			.then(() => readAppRuntimeHelperAccountSignal())
			.catch(() => null),
	]);
	return resolveRuntimeCurrentAccount(
		storage,
		{
			runtimeSnapshot: getRuntimeObservabilitySnapshot(),
			appBindStatus,
			appHelperStatus,
		},
		{ now },
	);
}

function appendQuotaStatusMarkers(
	statuses: string[],
	quotaEntry: QuotaCacheEntry | null,
	now = Date.now(),
): void {
	if (
		quotaEntry?.status === 429 &&
		!statuses.some((status) => isRateLimitedMarker(status))
	) {
		statuses.push("rate-limited");
	}
	if (isQuotaCacheEntryExhausted(quotaEntry, now)) {
		statuses.push("quota-exhausted");
	}
}

/**
 * OpenAI Codex OAuth authentication plugin for Codex CLI host runtime
 *
 * This plugin enables the host runtime to use OpenAI's Codex backend via ChatGPT Plus/Pro
 * OAuth authentication, allowing users to leverage their ChatGPT subscription
 * instead of OpenAI Platform API credits.
 *
 * @example
 * ```json
 * {
 *   "plugin": ["codex-multi-auth"],

 *   "model": "openai/gpt-5.3-codex"
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/require-await
export const OpenAIOAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	initLogger(client);
	let cachedAccountManager: AccountManager | null = null;
	let accountManagerPromise: Promise<AccountManager> | null = null;
	let loaderMutex: Promise<void> | null = null;
	let startupPrewarmTriggered = false;
	let lastCodexCliActiveSyncIndex: number | null = null;
	let perProjectStorageWarningShown = false;
	let liveAccountSync: LiveAccountSync | null = null;
	let liveAccountSyncPath: string | null = null;
	let liveAccountSyncConfigKey: string | null = null;
	let refreshGuardian: RefreshGuardian | null = null;
	let refreshGuardianConfigKey: string | null = null;
	let refreshGuardianCleanupRegistered = false;
	let sessionAffinityStore: SessionAffinityStore | null =
		new SessionAffinityStore();
	let sessionAffinityWriteVersion = 0;
	let sessionAffinityConfigKey: string | null = null;
	const entitlementCache = new EntitlementCache();
	const preemptiveQuotaScheduler = new PreemptiveQuotaScheduler();
	const contextBudgetGuard = new ContextBudgetGuard();
	const capabilityPolicyStore = new CapabilityPolicyStore();
	let accountReloadInFlight: Promise<AccountManager> | null = null;
	const exposeAdvancedCodexTools =
		(process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS ?? "").trim() === "1";
	const MIN_BACKOFF_MS = 100;
	const STREAM_FAILOVER_MAX_BY_MODE: Record<FailoverMode, number> = {
		aggressive: 1,
		balanced: 2,
		conservative: 2,
	};
	const STREAM_FAILOVER_SOFT_TIMEOUT_BY_MODE: Record<FailoverMode, number> = {
		aggressive: 10_000,
		balanced: 15_000,
		conservative: 20_000,
	};

	type RuntimeMetrics = {
		startedAt: number;
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		responsesRequests: number;
		authRefreshRequests: number;
		diagnosticProbeRequests: number;
		outboundRequestAttemptBudget: number | null;
		outboundRequestAttemptsConsumed: number;
		requestAttemptBudgetExhaustions: number;
		poolExhaustionFastFails: number;
		serverBurstFastFails: number;
		rateLimitedResponses: number;
		serverErrors: number;
		networkErrors: number;
		userAborts: number;
		authRefreshFailures: number;
		emptyResponseRetries: number;
		accountRotations: number;
		sameAccountRetries: number;
		streamFailoverAttempts: number;
		streamFailoverCandidatesConsidered: number;
		lastStreamFailoverCandidateCount: number;
		streamFailoverRecoveries: number;
		streamFailoverCrossAccountRecoveries: number;
		cumulativeLatencyMs: number;
		lastRequestAt: number | null;
		lastError: string | null;
	};

	const runtimeMetrics: RuntimeMetrics = {
		startedAt: Date.now(),
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		responsesRequests: 0,
		authRefreshRequests: 0,
		diagnosticProbeRequests: 0,
		outboundRequestAttemptBudget: null,
		outboundRequestAttemptsConsumed: 0,
		requestAttemptBudgetExhaustions: 0,
		poolExhaustionFastFails: 0,
		serverBurstFastFails: 0,
		rateLimitedResponses: 0,
		serverErrors: 0,
		networkErrors: 0,
		userAborts: 0,
		authRefreshFailures: 0,
		emptyResponseRetries: 0,
		accountRotations: 0,
		sameAccountRetries: 0,
		streamFailoverAttempts: 0,
		streamFailoverCandidatesConsidered: 0,
		lastStreamFailoverCandidateCount: 0,
		streamFailoverRecoveries: 0,
		streamFailoverCrossAccountRecoveries: 0,
		cumulativeLatencyMs: 0,
		lastRequestAt: null,
		lastError: null,
	};

	type TokenSuccess = Extract<TokenResult, { type: "success" }>;
	type TokenSuccessWithAccount = AccountPoolTokenSuccessWithAccount;

	const resolveTokenSuccessAccount = (
		tokens: TokenSuccess,
	): TokenSuccessWithAccount =>
		resolveAccountSelection(tokens, {
			envAccountId: process.env.CODEX_AUTH_ACCOUNT_ID,
			logInfo,
			getAccountIdCandidates,
			selectBestAccountCandidate,
		});

	const persistAccountPool = createPersistAccounts({
		persistAccountPoolResults,
		withAccountStorageTransaction,
		extractAccountId,
		extractAccountEmail,
		sanitizeEmail,
		findMatchingAccountIndex,
		modelFamilies: MODEL_FAMILIES,
	});
	const syncRuntimeObservability = (requestId: string | null): void => {
		mutateRuntimeObservabilitySnapshot((snapshot) => {
			const now = Date.now();
			const poolRemaining = getPoolExhaustionCooldownRemaining(now);
			const burstRemaining = getServerBurstCooldownRemaining(now);
			snapshot.currentRequestId = requestId;
			snapshot.poolExhaustionCooldownUntil =
				poolRemaining > 0 ? now + poolRemaining : null;
			snapshot.serverBurstCooldownUntil =
				burstRemaining > 0 ? now + burstRemaining : null;
			snapshot.responsesRequests = runtimeMetrics.responsesRequests;
			snapshot.authRefreshRequests = runtimeMetrics.authRefreshRequests;
			snapshot.diagnosticProbeRequests = runtimeMetrics.diagnosticProbeRequests;
			snapshot.runtimeMetrics = { ...runtimeMetrics };
		});
	};
	const persistAccountPoolAndFlagged = async (
		results: TokenSuccessWithAccount[],
		flaggedStorage: Parameters<typeof saveFlaggedAccounts>[0],
		replaceAll: boolean = false,
		publicationCurrent: () => boolean,
		recoveredSources: import("./lib/storage.js").FlaggedAccountMetadataV1[],
	): Promise<void> =>
		results.length === 0 ? withFlaggedStorageTransaction(async (currentFlagged, persist) => {
			if (!publicationCurrent()) throw new PendingAuthLocalError("Flagged publication authority changed");
			const nextFlagged = {...currentFlagged, accounts: currentFlagged.accounts.map(row => flaggedStorage.accounts.find(remaining => remaining.recordId ? remaining.recordId === row.recordId : remaining.refreshToken === row.refreshToken) ?? row)};
			await persist(nextFlagged);
		}) : withAccountAndFlaggedStorageTransaction(async (loadedStorage, persist, currentFlagged) => {
			if (!publicationCurrent() || recoveredSources.some((source, index) => !isFlaggedRecoverySourceCurrent(currentFlagged.accounts, source, results[index]))) throw new PendingAuthLocalError("Flagged publication authority changed");
			const nextFlagged = {...currentFlagged, accounts: currentFlagged.accounts.filter(row => !recoveredSources.some(source => source.recordId ? source.recordId === row.recordId : (source.refreshToken === row.refreshToken || results[recoveredSources.indexOf(source)]?.refresh === row.refreshToken) && source.accountId === row.accountId && source.email === row.email))};
			for (const remaining of flaggedStorage.accounts) {
				const index = nextFlagged.accounts.findIndex(row => row.recordId ? row.recordId === remaining.recordId : row.refreshToken === remaining.refreshToken);
				if (index >= 0) nextFlagged.accounts[index] = remaining;
			}
			await persistAccountPoolResults({
				results,
				recoveredSources,
				replaceAll,
				modelFamilies: MODEL_FAMILIES,
				withAccountStorageTransaction: async (handler) =>
					handler(loadedStorage, async (storage) => {
						await persist(storage, nextFlagged);
					}),
				findMatchingAccountIndex,
				extractAccountId,
				extractAccountEmail,
				sanitizeEmail,
			});
		});

	const accountManagerCacheInvalidationDeps = {
		setCachedAccountManager: (value: unknown) => {
			cachedAccountManager = value as AccountManager | null;
		},
		setAccountManagerPromise: (value: Promise<unknown> | null) => {
			accountManagerPromise = value as Promise<AccountManager> | null;
		},
	};

	const makeReloadAccountManagerDeps = (authFallback?: OAuthAuthDetails) => ({
		currentReloadInFlight: accountReloadInFlight,
		loadFromDisk: (fallback?: OAuthAuthDetails) =>
			AccountManager.loadFromDisk(fallback),
		setCachedAccountManager: (value: AccountManager) => {
			cachedAccountManager = value;
		},
		setAccountManagerPromise: (value: Promise<AccountManager> | null) => {
			accountManagerPromise = value;
		},
		setReloadInFlight: (value: Promise<AccountManager> | null) => {
			accountReloadInFlight = value;
		},
		authFallback,
	});

	const reloadAccountManagerFromDisk = async (
		authFallback?: OAuthAuthDetails,
	): Promise<AccountManager> =>
		reloadRuntimeAccountManager<AccountManager>(
			makeReloadAccountManagerDeps(authFallback),
		);

	const applyAccountStorageScope = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void =>
		applyAccountStorageScopeEntry({
			pluginConfig,
			getPerProjectAccounts,
			getStorageBackupEnabled,
			setStorageBackupEnabled,
			isCodexCliSyncEnabled,
			getWarningShown: () => perProjectStorageWarningShown,
			setWarningShown: (shown) => {
				perProjectStorageWarningShown = shown;
			},
			logWarn,
			pluginName: PLUGIN_NAME,
			setStoragePath,
			cwd: () => process.cwd(),
			applyAccountStorageScopeFromConfig,
		});

	const ensureLiveAccountSync = async (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
		authFallback?: OAuthAuthDetails,
	): Promise<void> => {
		const next = await ensureLiveAccountSyncEntry({
			pluginConfig,
			authFallback,
			currentSync: liveAccountSync,
			currentPath: liveAccountSyncPath,
			currentConfigKey: liveAccountSyncConfigKey,
			getLiveAccountSync,
			getLiveAccountSyncDebounceMs,
			getLiveAccountSyncPollMs,
			getStoragePath,
			createSync: (oauthFallback) =>
				new LiveAccountSync(
					async () => {
						await reloadRuntimeAccountManager<AccountManager>(
							makeReloadAccountManagerDeps(oauthFallback),
						);
					},
					{
						debounceMs: getLiveAccountSyncDebounceMs(pluginConfig),
						pollIntervalMs: getLiveAccountSyncPollMs(pluginConfig),
					},
				),
			registerCleanup,
			logWarn,
			pluginName: PLUGIN_NAME,
			ensureLiveAccountSyncState,
		});
		liveAccountSync = next.liveAccountSync;
		liveAccountSyncPath = next.liveAccountSyncPath;
		liveAccountSyncConfigKey = next.liveAccountSyncConfigKey;
	};
	const ensureRefreshGuardian = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void => {
		const next = ensureRefreshGuardianState({
			enabled: getProactiveRefreshGuardian(pluginConfig),
			intervalMs: getProactiveRefreshIntervalMs(pluginConfig),
			bufferMs: getProactiveRefreshBufferMs(pluginConfig),
			currentGuardian: refreshGuardian,
			currentConfigKey: refreshGuardianConfigKey,
			currentCleanupRegistered: refreshGuardianCleanupRegistered,
			getCurrentGuardian: () => refreshGuardian,
			createGuardian: ({ intervalMs, bufferMs }) =>
				new RefreshGuardian(() => cachedAccountManager, {
					intervalMs,
					bufferMs,
				}),
			registerCleanup,
		});
		refreshGuardian = next.refreshGuardian;
		refreshGuardianConfigKey = next.refreshGuardianConfigKey;
		refreshGuardianCleanupRegistered = next.refreshGuardianCleanupRegistered;
	};

	const ensureSessionAffinity = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void => {
		const next = ensureSessionAffinityState({
			enabled:
				getSessionAffinity(pluginConfig) ||
				getResponseContinuation(pluginConfig),
			ttlMs: getSessionAffinityTtlMs(pluginConfig),
			maxEntries: getSessionAffinityMaxEntries(pluginConfig),
			currentStore: sessionAffinityStore,
			currentConfigKey: sessionAffinityConfigKey,
			createStore: ({ ttlMs, maxEntries }) =>
				new SessionAffinityStore({ ttlMs, maxEntries }),
		});
		sessionAffinityStore = next.sessionAffinityStore;
		sessionAffinityConfigKey = next.sessionAffinityConfigKey;
	};

	const applyPreemptiveQuotaSettings = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void =>
		applyPreemptiveQuotaSettingsFromConfig(pluginConfig, {
			configure: (options) => preemptiveQuotaScheduler.configure(options),
			getPreemptiveQuotaEnabled,
			getPreemptiveQuotaRemainingPercent5h,
			getPreemptiveQuotaRemainingPercent7d,
			getPreemptiveQuotaMaxDeferralMs,
		});

	const applyContextBudgetGuardSettings = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void =>
		applyContextBudgetGuardSettingsFromConfig(pluginConfig, {
			configure: (options) => contextBudgetGuard.configure(options),
			getContextBudgetGuardEnabled,
			getContextBudgetGuardSoftPercent,
			getContextBudgetGuardHardPercent,
			getContextBudgetGuardModelWindowOverrides,
		});

	// Event handler for session recovery and account selection
	const eventHandler = async (input: {
		event: { type: string; properties?: unknown };
	}) =>
		handleRuntimeEvent({
			input,
			providerId: PROVIDER_ID,
			modelFamilies: MODEL_FAMILIES,
			loadAccounts,
			saveAccounts,
			hasCachedAccountManager: () => !!cachedAccountManager,
			syncCodexCliActiveSelectionForIndex: async (index) => {
				if (!cachedAccountManager) return;
				await cachedAccountManager.syncCodexCliActiveSelectionForIndex(index);
			},
			setLastCodexCliActiveSyncIndex: (index) => {
				lastCodexCliActiveSyncIndex = index;
			},
			reloadAccountManagerFromDisk: () => reloadAccountManagerFromDisk(),
			showToast: (message, variant) =>
				showRuntimeToast(client, message, variant),
			logDebug,
			pluginName: PLUGIN_NAME,
		});

	// Initialize runtime UI settings once on plugin load; auth/tools refresh this dynamically.
	applyUiRuntimeFromConfig(loadPluginConfig(), setUiRuntimeOptions);

	return {
		event: eventHandler,
		auth: {
			provider: PROVIDER_ID,
			/**
			 * Loader function that configures OAuth authentication and request handling
			 *
			 * This function:
			 * 1. Validates OAuth authentication
			 * 2. Loads multi-account pool from disk (fallback to current auth)
			 * 3. Loads user configuration from runtime model config
			 * 4. Fetches Codex system instructions from GitHub (cached)
			 * 5. Returns SDK configuration with custom fetch implementation
			 *
			 * @param getAuth - Function to retrieve current auth state
			 * @param provider - Provider configuration from runtime model config
			 * @returns SDK configuration object or empty object for non-OAuth auth
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();
				const pluginConfig = loadPluginConfig();
				applyLoaderRuntimeSetup({
					pluginConfig,
					applyUiRuntimeFromConfig: (config) =>
						applyUiRuntimeFromConfig(config, setUiRuntimeOptions),
					applyAccountStorageScope,
					ensureSessionAffinity,
					ensureRefreshGuardian,
					applyPreemptiveQuotaSettings,
					applyContextBudgetGuardSettings,
				});

				// Only handle OAuth auth type, skip API key auth
				if (auth.type !== "oauth") {
					return {};
				}

				// Prefer multi-account auth metadata when available, but still handle
				// plain OAuth credentials (for legacy runtime versions that inject internal
				// Codex auth first and omit the multiAccount marker).
				const authWithMulti = auth as typeof auth & { multiAccount?: boolean };
				if (!authWithMulti.multiAccount) {
					logDebug(
						`[${PLUGIN_NAME}] Auth is missing multiAccount marker; continuing with single-account compatibility mode`,
					);
				}
				// Acquire mutex for thread-safe initialization
				// Use while loop to handle multiple concurrent waiters correctly
				while (loaderMutex) {
					await loaderMutex;
				}

				let resolveMutex: (() => void) | undefined;
				loaderMutex = new Promise<void>((resolve) => {
					resolveMutex = resolve;
				});
				try {
					await ensureLiveAccountSync(pluginConfig, auth);
					if (!accountManagerPromise) {
						await reloadRuntimeAccountManager<AccountManager>(
							makeReloadAccountManagerDeps(auth as OAuthAuthDetails),
						);
					}
					const managerPromise =
						accountManagerPromise ??
						reloadRuntimeAccountManager<AccountManager>(
							makeReloadAccountManagerDeps(auth as OAuthAuthDetails),
						);
					let accountManager = await managerPromise;
					cachedAccountManager = accountManager;
					const refreshToken = auth.type === "oauth" ? auth.refresh : "";
					const needsPersist =
						refreshToken && !accountManager.hasRefreshToken(refreshToken);
					if (needsPersist) {
						await accountManager.saveToDisk();
					}

					if (accountManager.getAccountCount() === 0) {
						logDebug(
							`[${PLUGIN_NAME}] No OAuth accounts available (run codex-multi-auth login)`,
						);
						return {};
					}
					// Extract user configuration (global + per-model options)
					const providerConfig = provider as
						| {
								options?: Record<string, unknown>;
								models?: UserConfig["models"];
						  }
						| undefined;
					const userConfig: UserConfig = {
						global: providerConfig?.options || {},
						models: providerConfig?.models || {},
					};

					// Load plugin configuration and determine CODEX_MODE
					// Priority: CODEX_MODE env var > config file > default (true)
					const codexMode = getCodexMode(pluginConfig);
					const fastSessionEnabled = getFastSession(pluginConfig);
					const fastSessionStrategy = getFastSessionStrategy(pluginConfig);
					const fastSessionMaxInputItems =
						getFastSessionMaxInputItems(pluginConfig);
					const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
					configureRateLimitBackoff({
						dedupWindowMs: getRateLimitDedupWindowMs(pluginConfig),
						stateResetMs: getRateLimitStateResetMs(pluginConfig),
						maxBackoffMs: getRateLimitMaxBackoffMs(pluginConfig),
						shortRetryThresholdMs:
							getRateLimitShortRetryThresholdMs(pluginConfig),
					});
					const rateLimitToastDebounceMs =
						getRateLimitToastDebounceMs(pluginConfig);
					const retryAllAccountsRateLimited =
						getRetryAllAccountsRateLimited(pluginConfig);
					const retryAllAccountsMaxWaitMs =
						getRetryAllAccountsMaxWaitMs(pluginConfig);
					const retryAllAccountsMaxRetries =
						getRetryAllAccountsMaxRetries(pluginConfig);
					const unsupportedCodexPolicy =
						getUnsupportedCodexPolicy(pluginConfig);
					const fallbackOnUnsupportedCodexModel =
						unsupportedCodexPolicy === "fallback";
					const fallbackToGpt52OnUnsupportedGpt53 =
						getFallbackToGpt52OnUnsupportedGpt53(pluginConfig);
					const unsupportedCodexFallbackChain =
						getUnsupportedCodexFallbackChain(pluginConfig);
					const toastDurationMs = getToastDurationMs(pluginConfig);
					const fetchTimeoutMs = getFetchTimeoutMs(pluginConfig);
					const streamStallTimeoutMs = getStreamStallTimeoutMs(pluginConfig);
					const networkErrorCooldownMs =
						getNetworkErrorCooldownMs(pluginConfig);
					const serverErrorCooldownMs = getServerErrorCooldownMs(pluginConfig);
					const failoverMode = parseFailoverMode(
						process.env.CODEX_AUTH_FAILOVER_MODE,
					);
					const streamFailoverMax = Math.max(
						0,
						capStreamFailoverMax(
							parseEnvInt(process.env.CODEX_AUTH_STREAM_FAILOVER_MAX) ??
								STREAM_FAILOVER_MAX_BY_MODE[failoverMode],
						),
					);
					const streamFailoverSoftTimeoutMs = Math.max(
						1_000,
						parseEnvInt(process.env.CODEX_AUTH_STREAM_STALL_SOFT_TIMEOUT_MS) ??
							STREAM_FAILOVER_SOFT_TIMEOUT_BY_MODE[failoverMode],
					);
					const streamFailoverHardTimeoutMs = Math.max(
						streamFailoverSoftTimeoutMs,
						parseEnvInt(process.env.CODEX_AUTH_STREAM_STALL_HARD_TIMEOUT_MS) ??
							streamStallTimeoutMs,
					);
					const maxSameAccountRetries =
						failoverMode === "conservative"
							? 2
							: failoverMode === "balanced"
								? 1
								: 0;

					const sessionRecoveryEnabled = getSessionRecovery(pluginConfig);
					const autoResumeEnabled = getAutoResume(pluginConfig);
					const emptyResponseMaxRetries =
						getEmptyResponseMaxRetries(pluginConfig);
					const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
					const effectiveUserConfig = fastSessionEnabled
						? applyFastSessionDefaults(userConfig)
						: userConfig;
					if (fastSessionEnabled) {
						logDebug("Fast session mode enabled", {
							reasoningEffort: "none/low",
							reasoningSummary: "auto",
							textVerbosity: "low",
							fastSessionStrategy,
							fastSessionMaxInputItems,
						});
					}

					const prewarmEnabled =
						process.env.CODEX_AUTH_PREWARM !== "0" &&
						process.env.VITEST !== "true" &&
						process.env.NODE_ENV !== "test";

					if (!startupPrewarmTriggered && prewarmEnabled) {
						startupPrewarmTriggered = true;
						const configuredModels = Object.keys(userConfig.models ?? {});
						prewarmCodexInstructions(configuredModels);
						if (codexMode) {
							prewarmHostCodexPrompt();
						}
					}

					const recoveryHook = createRuntimeSessionRecoveryHook({
						enabled: sessionRecoveryEnabled,
						client,
						directory: process.cwd(),
						autoResume: autoResumeEnabled,
					});

					checkAndNotify(async (message, variant) => {
						await showRuntimeToast(client, message, variant);
					}).catch((err) => {
						logDebug(
							`Update check failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});

					// Return SDK configuration
					return {
						apiKey: DUMMY_API_KEY,
						baseURL: CODEX_BASE_URL,
						/**
						 * Custom fetch implementation for Codex API
						 *
						 * Handles:
						 * - Token refresh when expired
						 * - URL rewriting for Codex backend
						 * - Request body transformation
						 * - OAuth header injection
						 * - SSE to JSON conversion for non-tool requests
						 * - Error handling and logging
						 *
						 * @param input - Request URL or Request object
						 * @param init - Request options
						 * @returns Response from Codex API
						 */
						async fetch(
							input: Request | string | URL,
							init?: RequestInit,
						): Promise<Response> {
							let usageRecorder: RuntimeUsageRecorder | null = null;
							let usageCompletion: RuntimeUsageRecordInput | null = null;
							const usageDeferral = createStreamUsageDeferral<RuntimeUsageRecordInput>(
								{
									record: async (completion) => {
										await usageRecorder?.record(completion);
									},
									fallbackMs: USAGE_STREAM_IDLE_TIMEOUT_MS,
								},
							);
							try {
								if (
									cachedAccountManager &&
									cachedAccountManager !== accountManager
								) {
									accountManager = cachedAccountManager;
								}

								// Step 1: Extract and rewrite URL for Codex backend
								const originalUrl = extractRequestUrl(input);
								const url = rewriteUrlForCodex(originalUrl);

								// Step 3: Transform request body with model-specific Codex instructions
								// Instructions are fetched per model family (codex-max, codex, gpt-5.1)
								// Capture original stream value before transformation
								// generateText() sends no stream field, streamText() sends stream=true
								const baseInit = await normalizeRequestInit(input, init);
								const originalBody = await parseRequestBodyFromInit(
									baseInit?.body,
									logWarn,
								);
								const isStreaming = originalBody.stream === true;
								const parsedBody =
									Object.keys(originalBody).length > 0
										? { ...originalBody }
										: undefined;
								const transformation = await transformRequestForCodex(
									baseInit,
									url,
									effectiveUserConfig,
									codexMode,
									parsedBody,
									{
										fastSession: fastSessionEnabled,
										fastSessionStrategy,
										fastSessionMaxInputItems,
										deferFastSessionInputTrimming: fastSessionEnabled,
										allowBackgroundResponses:
											getBackgroundResponses(pluginConfig),
									},
								);
								let requestInit = transformation?.updatedInit ?? baseInit;
								let transformedBody: RequestBody | undefined =
									transformation?.body;
								let pendingFastSessionInputTrim =
									transformation?.deferredFastSessionInputTrim;
								const promptCacheKey = transformedBody?.prompt_cache_key;
								let model = transformedBody?.model;
								let modelFamily = model ? getModelFamily(model) : "gpt-5.1";
								let quotaKey = model ? `${modelFamily}:${model}` : modelFamily;
								const responseContinuationEnabled =
									getResponseContinuation(pluginConfig);
								const threadIdCandidate =
									(process.env.CODEX_THREAD_ID ?? promptCacheKey ?? "")
										.toString()
										.trim() || undefined;
								const sessionAffinityKey =
									threadIdCandidate ?? promptCacheKey ?? null;
								// Context budget guard: pause BEFORE spending an upstream
								// round-trip on a request the tracked session is already over
								// the hard threshold for, rather than waiting on the eventual
								// context_length_exceeded 400 that handleContextOverflow below
								// only reacts to after the fact. Independent of which account
								// ends up serving the request, so it runs ahead of account
								// selection entirely rather than inside its retry loop.
								const contextBudgetAdvisory = contextBudgetGuard.getAdvisory(
									sessionAffinityKey ?? "",
									Date.now(),
									model,
								);
								if (contextBudgetAdvisory.level === "hard") {
									// One-shot: this pause returns before the request is
									// forwarded, so the onUsage hook that would lower the
									// recorded usage never runs. Dropping the snapshot keeps
									// the session recoverable — otherwise the `/compact` turn
									// this message asks for is blocked by the same key.
									contextBudgetGuard.noteHardPauseEmitted(
										sessionAffinityKey ?? "",
									);
									return createContextBudgetPauseResponse(
										contextBudgetAdvisory,
									);
								}
								const sessionAffinityVersion =
									(sessionAffinityWriteVersion += 1);
								const effectivePromptCacheKey =
									(sessionAffinityKey ?? promptCacheKey ?? "")
										.toString()
										.trim() || undefined;
								const shouldUseResponseContinuation =
									Boolean(transformedBody) &&
									responseContinuationEnabled &&
									!transformedBody?.previous_response_id;
								if (shouldUseResponseContinuation && transformedBody) {
									const lastResponseId =
										sessionAffinityStore?.getLastResponseId(sessionAffinityKey);
									if (lastResponseId) {
										transformedBody = {
											...transformedBody,
											previous_response_id: lastResponseId,
										};
										requestInit = {
											...requestInit,
											body: JSON.stringify(transformedBody),
										};
									}
								}
								const preferredSessionAccountIndex =
									sessionAffinityStore?.getPreferredAccountIndex(
										sessionAffinityKey,
									);
								sessionAffinityStore?.prune();
								const requestCorrelationId = setCorrelationId(
									threadIdCandidate
										? `${threadIdCandidate}:${Date.now()}`
										: undefined,
								);
								const requestTraceId = requestCorrelationId;
								runtimeMetrics.lastRequestAt = Date.now();
								syncRuntimeObservability(requestTraceId);
								let runtimePolicyDecision: RuntimePolicyDecision | null = null;
								try {
									const runtimePolicyState = await loadRuntimePolicyState();
									runtimePolicyDecision = await evaluateRuntimePolicy({
										state: runtimePolicyState,
										accounts: accountManager.getAccountsSnapshot(),
										model: model ?? null,
										capabilityPolicy: capabilityPolicyStore,
									});
								} catch (policyError) {
									logWarn("Runtime policy evaluation failed open.", {
										error:
											policyError instanceof Error
												? policyError.message
												: String(policyError),
									});
								}
								usageRecorder = createRuntimeUsageRecorder({
									source: "plugin-host",
									operation: "responses",
									model: model ?? null,
									projectKey: runtimePolicyDecision?.projectKey ?? null,
									requestId: requestTraceId,
									startedAt: Date.now(),
								});
								usageCompletion = {
									outcome: "failure",
									statusCode: null,
									errorCode: "plugin_host_request_failed",
								};
								if (runtimePolicyDecision && !runtimePolicyDecision.allowed) {
									runtimeMetrics.failedRequests += 1;
									runtimeMetrics.lastError = "Runtime policy blocked request";
									syncRuntimeObservability(requestTraceId);
									usageCompletion = {
										outcome: "blocked",
										statusCode: runtimePolicyDecision.statusCode,
										errorCode: runtimePolicyDecision.errorCode,
									};
									return new Response(
										JSON.stringify({
											error: {
												message: "Runtime policy blocked this local request.",
												code:
													runtimePolicyDecision.errorCode ??
													"policy_blocked",
												reasons: runtimePolicyDecision.reasons,
											},
										}),
										{
											status: runtimePolicyDecision.statusCode,
											headers: {
												"content-type": "application/json; charset=utf-8",
											},
										},
									);
								}

								const abortSignal = requestInit?.signal ?? init?.signal ?? null;
								const sleep = createAbortableSleep(abortSignal);
								const poolCooldownRemainingMs =
									getPoolExhaustionCooldownRemaining();
								if (poolCooldownRemainingMs > 0) {
									runtimeMetrics.failedRequests += 1;
									runtimeMetrics.poolExhaustionFastFails += 1;
									runtimeMetrics.lastError = "Pool exhaustion cooldown active";
									syncRuntimeObservability(requestTraceId);
									usageCompletion = {
										outcome: "failure",
										statusCode: 429,
										errorCode: "pool_exhaustion_cooldown",
									};
									return new Response(
										JSON.stringify({
											error: {
												message: `The account pool is cooling down after recent rate-limit exhaustion. Try again in ${formatWaitTime(poolCooldownRemainingMs)} or inspect \`codex-multi-auth status\`.`,
											},
										}),
										{
											status: 429,
											headers: {
												"content-type": "application/json; charset=utf-8",
											},
										},
									);
								}
								const serverBurstCooldownRemainingMs =
									getServerBurstCooldownRemaining();
								if (serverBurstCooldownRemainingMs > 0) {
									runtimeMetrics.failedRequests += 1;
									runtimeMetrics.serverBurstFastFails += 1;
									runtimeMetrics.lastError = "Server burst cooldown active";
									syncRuntimeObservability(requestTraceId);
									usageCompletion = {
										outcome: "failure",
										statusCode: 503,
										errorCode: "server_burst_cooldown",
									};
									return new Response(
										JSON.stringify({
											error: {
												message: `Multiple accounts recently failed with upstream server errors. Try again in ${formatWaitTime(serverBurstCooldownRemainingMs)} or inspect \`codex-multi-auth report --json\`.`,
											},
										}),
										{
											status: 503,
											headers: {
												"content-type": "application/json; charset=utf-8",
											},
										},
									);
								}
								const maxOutboundRequestAttempts =
									computeOutboundRequestAttemptBudget({
										accountCount: accountManager.getAccountCount(),
										maxSameAccountRetries,
										emptyResponseMaxRetries,
										streamFailoverMax,
									});
								runtimeMetrics.outboundRequestAttemptBudget ??=
									maxOutboundRequestAttempts;
								logDebug("Configured outbound request attempt budget.", {
									requestTraceId,
									budget: maxOutboundRequestAttempts,
									accountCount: accountManager.getAccountCount(),
									maxSameAccountRetries,
									emptyResponseMaxRetries,
									streamFailoverMax,
								});
								syncRuntimeObservability(requestTraceId);
								let outboundRequestAttemptsRemaining =
									maxOutboundRequestAttempts;
								const tryConsumeOutboundRequestAttempt = (
									reason: "primary" | "stream-failover",
									accountIndex: number,
								): boolean => {
									if (outboundRequestAttemptsRemaining <= 0) {
										runtimeMetrics.requestAttemptBudgetExhaustions += 1;
										runtimeMetrics.lastError = `Request attempt budget exhausted after ${maxOutboundRequestAttempts} outbound request(s)`;
										logWarn("Request attempt budget exhausted.", {
											requestTraceId,
											reason,
											accountIndex,
											budget: maxOutboundRequestAttempts,
											consumed: maxOutboundRequestAttempts,
										});
										syncRuntimeObservability(requestTraceId);
										return false;
									}

									runtimeMetrics.outboundRequestAttemptsConsumed += 1;
									outboundRequestAttemptsRemaining -= 1;
									return true;
								};

								let allRateLimitedRetries = 0;
								const attemptedUnsupportedFallbackModels = new Set<string>();
								if (model) {
									attemptedUnsupportedFallbackModels.add(model);
								}

								while (true) {
									const accountCount = accountManager.getAccountCount();
									const attempted = new Set<number>();
									let restartAccountTraversalWithFallback = false;
									let retryNextAccountBeforeFallback = false;
									let usedPreferredSessionAccount = false;
									const capabilityBoostByAccount: Record<number, number> = {};
									type AccountSnapshotCandidate = {
										index: number;
										accountId?: string;
										email?: string;
									};
									const accountSnapshotSource = accountManager as {
										getAccountsSnapshot?: () => AccountSnapshotCandidate[];
										getAccountByIndex?: (
											index: number,
										) => AccountSnapshotCandidate | null;
									};
									const accountSnapshotList =
										typeof accountSnapshotSource.getAccountsSnapshot ===
										"function"
											? (accountSnapshotSource.getAccountsSnapshot() ?? [])
											: [];
									if (
										accountSnapshotList.length === 0 &&
										typeof accountSnapshotSource.getAccountByIndex ===
											"function"
									) {
										for (
											let accountSnapshotIndex = 0;
											accountSnapshotIndex < accountCount;
											accountSnapshotIndex += 1
										) {
											const candidate =
												accountSnapshotSource.getAccountByIndex(
													accountSnapshotIndex,
												);
											if (candidate) {
												accountSnapshotList.push(candidate);
											}
										}
									}
									for (const candidate of accountSnapshotList) {
										const accountKey = resolveEntitlementAccountKey(candidate);
										capabilityBoostByAccount[candidate.index] =
											capabilityPolicyStore.getBoost(
												accountKey,
												model ?? modelFamily,
											);
									}
									for (const [rawIndex, boost] of Object.entries(
										runtimePolicyDecision?.scoreBoostByAccount ?? {},
									)) {
										const index = Number(rawIndex);
										if (!Number.isInteger(index)) continue;
										capabilityBoostByAccount[index] =
											(capabilityBoostByAccount[index] ?? 0) + boost;
									}

									accountAttemptLoop: while (
										attempted.size < Math.max(1, accountCount)
									) {
										let account = null;
										if (
											!usedPreferredSessionAccount &&
											typeof preferredSessionAccountIndex === "number"
										) {
											usedPreferredSessionAccount = true;
											if (
												accountManager.isAccountAvailableForFamily(
													preferredSessionAccountIndex,
													modelFamily,
													model,
												) &&
												!runtimePolicyDecision?.blockedAccountIndexes.has(
													preferredSessionAccountIndex,
												)
											) {
												account = accountManager.getAccountByIndex(
													preferredSessionAccountIndex,
												);
												if (account) {
													account.lastUsed = Date.now();
													accountManager.markSwitched(
														account,
														"rotation",
														modelFamily,
													);
												}
											} else {
												sessionAffinityStore?.forgetSession(sessionAffinityKey);
											}
										}

										if (!account) {
											account = accountManager.getCurrentOrNextForFamilyHybrid(
												modelFamily,
												model,
												{
													pidOffsetEnabled,
													scoreBoostByAccount: capabilityBoostByAccount,
												},
											);
										}
										if (!account || attempted.has(account.index)) {
											break;
										}
										attempted.add(account.index);
										if (
											runtimePolicyDecision?.blockedAccountIndexes.has(
												account.index,
											)
										) {
											continue;
										}
										// Log account selection for debugging rotation
										logDebug(
											`Using account ${account.index + 1}/${accountCount}: ${account.email ?? "unknown"} for ${modelFamily}`,
										);

										let refreshHealth: (success?: boolean) => boolean = () => false;
										let accountAuth = accountManager.toAuthDetails(
											account,
										) as OAuthAuthDetails;
										try {
											if (shouldRefreshToken(accountAuth, tokenRefreshSkewMs, accountManager.resolveSelectionStoragePath())) {
												refreshHealth = accountManager.captureRefreshHealth(account, modelFamily, model);
												runtimeMetrics.authRefreshRequests += 1;
												syncRuntimeObservability(requestTraceId);
												accountAuth = (await refreshAndUpdateToken(
													accountAuth,
													client,
													{accountManager, account},
												)) as OAuthAuthDetails;
												await accountManager.commitRefreshedAuth(
													account,
													accountAuth,
												);
											}
										} catch (err) {
											if (err instanceof PendingAuthLocalError) throw err;
											logDebug(
												`[${PLUGIN_NAME}] Auth refresh failed for account: ${(err as Error)?.message ?? String(err)}`,
											);
											runtimeMetrics.authRefreshFailures++;
											runtimeMetrics.failedRequests++;
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError =
												(err as Error)?.message ?? String(err);
											const isRetryableRefreshError =
												err instanceof CodexAuthError && err.retryable;
											const accountLabel = formatAccountLabel(
												account,
												account.index,
											);

											sessionAffinityStore?.forgetSession(sessionAffinityKey);

											if (isRetryableRefreshError) {
												runtimeMetrics.networkErrors++;
												const retryableRefreshPolicy = evaluateFailurePolicy(
													{ kind: "network", failoverMode },
													{ networkCooldownMs: networkErrorCooldownMs },
												);
												if (retryableRefreshPolicy.recordFailure) {
													refreshHealth(false);
												}
												if (
													typeof retryableRefreshPolicy.cooldownMs ===
														"number" &&
													retryableRefreshPolicy.cooldownReason
												) {
													accountManager.markAccountCoolingDown(
														account,
														retryableRefreshPolicy.cooldownMs,
														retryableRefreshPolicy.cooldownReason,
													);
													accountManager.saveToDiskDebounced();
												}
												continue;
											}

											const failures =
												accountManager.incrementAuthFailures(account);
											const authFailurePolicy = evaluateFailurePolicy({
												kind: "auth-refresh",
												consecutiveAuthFailures: failures,
											});

											if (authFailurePolicy.removeAccount) {
												const removedIndex = account.index;
												sessionAffinityStore?.forgetAccount(removedIndex);
												accountManager.removeAccount(account);
												sessionAffinityStore?.reindexAfterRemoval(removedIndex);
												accountManager.saveToDiskDebounced();
												await showRuntimeToast(
													client,
													`Removed ${accountLabel} after ${failures} consecutive auth failures. Run 'codex-multi-auth login' to re-add.`,
													"error",
													{ duration: toastDurationMs * 2 },
												);
												continue;
											}

											if (
												typeof authFailurePolicy.cooldownMs === "number" &&
												authFailurePolicy.cooldownReason
											) {
												accountManager.markAccountCoolingDown(
													account,
													authFailurePolicy.cooldownMs,
													authFailurePolicy.cooldownReason,
												);
											}
											accountManager.saveToDiskDebounced();
											continue;
										}

										const currentWorkspace =
											accountManager.getCurrentWorkspace(account);
										const storedAccountId =
											currentWorkspace?.id ?? account.accountId;
										const storedAccountIdSource = currentWorkspace
											? "manual"
											: account.accountIdSource;
										const storedEmail = account.email;
										const hadAccountId = !!storedAccountId;
										const runtimeIdentity = resolveRuntimeRequestIdentity({
											storedAccountId,
											source: storedAccountIdSource,
											storedEmail,
											accessToken: accountAuth.access,
											idToken: accountAuth.idToken,
										});
										const tokenAccountId = runtimeIdentity.tokenAccountId;
										const accountId = runtimeIdentity.accountId;
										if (!accountId) {
											accountManager.markAccountCoolingDown(
												account,
												ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
												"auth-failure",
											);
											accountManager.saveToDiskDebounced();
											continue;
										}
										const resolvedEmail = runtimeIdentity.email;
										const entitlementAccountKey = resolveEntitlementAccountKey({
											accountId: storedAccountId ?? accountId,
											email: resolvedEmail,
											refreshToken: account.refreshToken,
											index: account.index,
										});
										const entitlementBlock = entitlementCache.isBlocked(
											entitlementAccountKey,
											model ?? modelFamily,
										);
										if (entitlementBlock.blocked) {
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError = `Entitlement cached block for account ${account.index + 1}`;
											logWarn(
												`Skipping account ${account.index + 1} due to cached entitlement block (${formatWaitTime(entitlementBlock.waitMs)} remaining).`,
											);
											continue;
										}
										account.accountId = accountId;
										if (
											!hadAccountId &&
											tokenAccountId &&
											accountId === tokenAccountId
										) {
											account.accountIdSource =
												storedAccountIdSource ?? "token";
										}
										if (resolvedEmail) {
											account.email = resolvedEmail;
										}

										// Consume a token before making the request for proactive rate limiting
										let primaryAdmission: CircuitAdmissionReceipt | undefined;
										const tokenConsumed = accountManager.consumeToken(
											account,
											modelFamily,
											model,
											{onAdmission: receipt => { primaryAdmission = receipt; }},
										);
										if (!tokenConsumed) {
											accountManager.recordRateLimit(
												account,
												modelFamily,
												model,
											);
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError = `Local token bucket depleted for account ${account.index + 1} (${modelFamily}${model ? `:${model}` : ""})`;
											logWarn(
												`Skipping account ${account.index + 1}: local token bucket depleted for ${modelFamily}${model ? `:${model}` : ""}`,
											);
											continue;
										}

										const primarySubmittedCredential = {recordId: account.recordId, accessToken: accountAuth.access, refreshToken: accountAuth.refresh, expiresAt: account.expires, accountId};
										const primarySubmittedAccount = structuredClone(account);
										const quotaOwner = modelScopeId(primarySubmittedCredential.recordId ?? "", primarySubmittedCredential.accessToken, primarySubmittedCredential.refreshToken, String(primarySubmittedCredential.expiresAt), primarySubmittedCredential.accountId);
										const quotaScheduleKey = `${entitlementAccountKey}:${model ?? modelFamily}:${quotaOwner}`;
										if (!primaryAdmission) throw new Error("Missing circuit admission");
										const dispatchPrimary = createAccountDispatch({manager: accountManager, account, submitted: primarySubmittedCredential, admission: primaryAdmission, family: modelFamily, model: model ?? null,
											eligible: () => !entitlementCache.isBlocked(entitlementAccountKey, model ?? modelFamily).blocked && !preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, Date.now(), quotaOwner).defer && contextBudgetGuard.getAdvisory(sessionAffinityKey ?? "", Date.now(), model).level !== "hard",
										});
										if (
											accountCount > 1 &&
											accountManager.shouldShowAccountToast(
												account.index,
												rateLimitToastDebounceMs,
											)
										) {
											const accountLabel = formatAccountLabel(
												account,
												account.index,
											);
											await showRuntimeToast(
												client,
												`Using ${accountLabel} (${account.index + 1}/${accountCount})`,
												"info",
											);
											accountManager.markToastShown(account.index);
										}

										const headers = createCodexHeaders(
											requestInit,
											accountId,
											accountAuth.access,
											{
												model,
												promptCacheKey: effectivePromptCacheKey,
											},
										);
										if (transformedBody && pendingFastSessionInputTrim) {
											const activeFastSessionInputTrim =
												pendingFastSessionInputTrim;
											pendingFastSessionInputTrim = undefined;
											const compactionResult = await applyResponseCompaction({
												body: transformedBody,
												requestUrl: url,
												headers,
												trim: activeFastSessionInputTrim,
												fetchImpl: async (requestUrl, requestInit) => {
													const normalizedCompactionUrl =
														typeof requestUrl === "string"
															? requestUrl
															: String(requestUrl);
													return dispatchPrimary(() => fetch(
														normalizedCompactionUrl,
														applyProxyCompatibleInit(
															normalizedCompactionUrl,
															requestInit,
														),
													));
												},
												signal: abortSignal,
												timeoutMs: Math.min(fetchTimeoutMs, 4_000),
											});
											if (compactionResult.mode !== "unchanged") {
												transformedBody = compactionResult.body;
												requestInit = {
													...(requestInit ?? {}),
													body: JSON.stringify(transformedBody),
												};
											}
										}
										const capabilityModelKey = model ?? modelFamily;
										const quotaDeferral =
											preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, Date.now(), quotaOwner);
										if (quotaDeferral.defer && quotaDeferral.waitMs > 0) {
											accountManager.markRateLimitedWithReason(
												account,
												quotaDeferral.waitMs,
												modelFamily,
												"quota",
												model,
											);
											accountManager.recordRateLimit(
												account,
												modelFamily,
												model,
											);
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError = `Preemptive quota deferral for account ${account.index + 1}`;
											accountManager.saveToDiskDebounced();
											continue;
										}


										let shortRateLimitRetryCount = 0;
										let shortRetryResponse: Response | undefined;
										let restrictionObservationFailed = false;
										const observeRestrictionFailure = (error: unknown) => {
											restrictionObservationFailed = true;
											runtimeMetrics.lastError = error instanceof Error ? error.message : String(error);
											logWarn("Submitted outcome restriction authority could not be observed", {error});
											return false;
										};
										const applySubmittedRestriction = (mutate: () => boolean | void, persistChanges = false) =>
											accountManager.withCurrentAccountCredential(account, primarySubmittedCredential, mutate, persistChanges).catch(observeRestrictionFailure);
										while (true) {
											if (
												!tryConsumeOutboundRequestAttempt(
													"primary",
													account.index,
												)
											) {
												runtimeMetrics.failedRequests++;
												const lastErrorDetail = runtimeMetrics.lastError;
												const message = lastErrorDetail
													? `${lastErrorDetail}. Try again after the current retries settle.`
													: "Request attempt budget exhausted. Try again shortly.";
												return new Response(
													JSON.stringify({ error: { message } }),
													{
														status: 503,
														headers: {
															"content-type": "application/json; charset=utf-8",
														},
													},
												);
											}

											let response: Response;
											let quotaReceipt: QuotaObservationReceipt | undefined;
											let rateLimitResetFloor = 0;
											const receiveQuota = (received: Response): Response => {
												const now = Date.now();
												let snapshot = readQuotaSchedulerSnapshot(received.headers, received.status, now);
												const planType = received.headers.get("x-codex-plan-type")?.trim();
												if (planType) snapshot = {...(snapshot ?? {status: received.status, updatedAt: now, primary: {}, secondary: {}}), planType};
												const overload = [502, 503, 529].includes(received.status);
												const waitMs = received.status === 429 ? parseRetryAfterHintMs(received.headers) ?? 60_000 : overload ? evaluateFailurePolicy({kind: "server", failoverMode, serverRetryAfterMs: parseRetryAfterHintMs(received.headers) ?? undefined}, {serverCooldownMs: serverErrorCooldownMs}).cooldownMs : undefined;
												if (typeof waitMs === "number") {
													const previous = preemptiveQuotaScheduler.getSnapshot(quotaScheduleKey, quotaOwner);
													rateLimitResetFloor = Math.max((snapshot?.primary.usedPercent ?? 0) >= 100 ? snapshot?.primary.resetAtMs ?? 0 : 0, (previous?.primary.usedPercent ?? 0) >= 100 ? previous?.primary.resetAtMs ?? 0 : 0);
													snapshot = {...(snapshot ?? {status: received.status, updatedAt: now, secondary: {}}), status: 429, primary: {usedPercent: 100, resetAtMs: Math.max(rateLimitResetFloor, now + waitMs)}};
												}
												if (snapshot) {
													quotaReceipt = preemptiveQuotaScheduler.receive(quotaScheduleKey, snapshot, quotaOwner);
													preemptiveQuotaScheduler.observeReceipt(quotaScheduleKey, quotaReceipt);
												}
												return received;
											};
											const applyReceivedRateLimit = (mutate: () => number) => applySubmittedRestriction(() => {
												if (!quotaReceipt) return false;
												const primaryReceipt = {...quotaReceipt, secondary: undefined, planType: undefined};
												if (!preemptiveQuotaScheduler.observeReceipt(quotaScheduleKey, primaryReceipt)) return false;
												const waitMs = mutate();
												primaryReceipt.snapshot = {...primaryReceipt.snapshot, primary: {usedPercent: 100, resetAtMs: Math.max(rateLimitResetFloor, primaryReceipt.snapshot.updatedAt + waitMs)}};
												preemptiveQuotaScheduler.observeReceipt(quotaScheduleKey, primaryReceipt);
												preemptiveQuotaScheduler.settleReceipt(quotaScheduleKey, primaryReceipt, true);
												return true;
											});
											const fetchStart = performance.now();

											// Merge user AbortSignal with timeout without AbortSignal.any (keeps listeners bounded)
											const fetchController = new AbortController();
											const requestTimeoutMs = fetchTimeoutMs;
											let requestTimedOut = false;
											const timeoutReason = new Error("Request timeout");
											const fetchTimeoutId = setTimeout(() => {
												requestTimedOut = true;
												fetchController.abort(timeoutReason);
											}, requestTimeoutMs);

											const onUserAbort = abortSignal
												? () =>
														fetchController.abort(
															abortSignal.reason ??
																new Error("Aborted by user"),
														)
												: null;

											if (abortSignal?.aborted) {
												clearTimeout(fetchTimeoutId);
												fetchController.abort(
													abortSignal.reason ?? new Error("Aborted by user"),
												);
											} else if (abortSignal && onUserAbort) {
												abortSignal.addEventListener("abort", onUserAbort, {
													once: true,
												});
											}

											try {
												runtimeMetrics.totalRequests++;
												runtimeMetrics.responsesRequests++;
												syncRuntimeObservability(requestTraceId);
												response = await dispatchPrimary(() => fetch(
													url,
													applyProxyCompatibleInit(url, {
														...requestInit,
														headers,
														signal: fetchController.signal,
													}),
												).then(receiveQuota));
											} catch (networkError) {
												if (networkError instanceof PendingAuthLocalError) {
													if (shortRetryResponse) return shortRetryResponse;
													throw networkError;
												}
												const fetchAbortReason = fetchController.signal.reason;
												const isTimeoutAbort =
													requestTimedOut ||
													(fetchAbortReason instanceof Error &&
														fetchAbortReason.message === timeoutReason.message);
												const isUserAbort =
													Boolean(abortSignal?.aborted) && !isTimeoutAbort;
												if (isUserAbort) {
													accountManager.refundToken(
														account,
														modelFamily,
														model,
													);
													runtimeMetrics.userAborts++;
													runtimeMetrics.lastError = "request aborted by user";
													sessionAffinityStore?.forgetSession(
														sessionAffinityKey,
													);
													throw fetchAbortReason instanceof Error
														? fetchAbortReason
														: new Error("Aborted by user");
												}
												const errorMsg =
													networkError instanceof Error
														? networkError.message
														: String(networkError);
												logWarn(
													`Network error for account ${account.index + 1}: ${errorMsg}`,
												);
												runtimeMetrics.failedRequests++;
												runtimeMetrics.networkErrors++;
												runtimeMetrics.lastError = errorMsg;
												const policy = evaluateFailurePolicy(
													{ kind: "network", failoverMode },
													{ networkCooldownMs: networkErrorCooldownMs },
												);
												if (policy.refundToken) {
													accountManager.refundToken(
														account,
														modelFamily,
														model,
													);
												}
												await applySubmittedRestriction(() => {
													if (policy.recordFailure) {
														accountManager.recordFailure(account, modelFamily, model, primaryAdmission);
														capabilityPolicyStore.recordFailure(entitlementAccountKey, capabilityModelKey);
													}
													if (typeof policy.cooldownMs === "number" &&
														policy.cooldownReason) {
														accountManager.markAccountCoolingDown(account, policy.cooldownMs, policy.cooldownReason);
														accountManager.saveToDiskDebounced();
													}
												});
												sessionAffinityStore?.forgetSession(sessionAffinityKey);
												usageCompletion = {outcome: "failure", errorCode: "upstream_transport_error", account: {index: primarySubmittedAccount.index, accountId: primarySubmittedAccount.accountId, email: primarySubmittedAccount.email}};
												throw networkError;
											} finally {
												clearTimeout(fetchTimeoutId);
												if (abortSignal && onUserAbort) {
													abortSignal.removeEventListener("abort", onUserAbort);
												}
											}
											const fetchLatencyMs = Math.round(
												performance.now() - fetchStart,
											);

											logRequest(LOG_STAGES.RESPONSE, {
												status: response.status,
												ok: response.ok,
												statusText: response.statusText,
												latencyMs: fetchLatencyMs,
												headers: sanitizeResponseHeadersForLog(
													response.headers,
												),
											});
											usageCompletion = {outcome: "failure", statusCode: response.status, errorCode: response.ok ? null : `http_${response.status}`, account: {index: primarySubmittedAccount.index, accountId: primarySubmittedAccount.accountId, email: primarySubmittedAccount.email}};
											if (quotaReceipt) {
												const receipt = quotaReceipt;
												const applied = await applySubmittedRestriction(() => {
													preemptiveQuotaScheduler.observeReceipt(quotaScheduleKey, receipt);
													return true;
												});
												preemptiveQuotaScheduler.settleReceipt(quotaScheduleKey, receipt, applied);
												if (restrictionObservationFailed && !response.ok) return response;
											}

											if (!response.ok) {
												const contextOverflowResult =
													await handleContextOverflow(response, model);
												if (contextOverflowResult.handled) {
													return contextOverflowResult.response;
												}

												const {
													response: errorResponse,
													rateLimit,
													errorBody,
												} = await handleErrorResponse(response, {
													requestCorrelationId,
													threadId: threadIdCandidate,
												});

												const unsupportedModelInfo =
													getUnsupportedCodexModelInfo(errorBody);
												const hasRemainingAccounts =
													attempted.size < Math.max(1, accountCount);
												const blockedModel =
													unsupportedModelInfo.unsupportedModel ??
													model ??
													"requested model";
												const blockedModelNormalized =
													blockedModel.toLowerCase();
												const shouldForceSparkFallback =
													unsupportedModelInfo.isUnsupported &&
													(blockedModelNormalized === "gpt-5.3-codex-spark" ||
														blockedModelNormalized.includes(
															"gpt-5.3-codex-spark",
														));
												const shouldForceGpt55Fallback =
													unsupportedModelInfo.isUnsupported &&
													(
														blockedModelNormalized === "gpt-5.5" ||
														blockedModelNormalized === "gpt-5.5-pro" ||
														blockedModelNormalized === "gpt-5.5-2026-04-23" ||
														blockedModelNormalized ===
															"gpt-5.5-pro-2026-04-23" ||
														blockedModelNormalized === "gpt-5.5-20260423" ||
														blockedModelNormalized ===
															"gpt-5.5-pro-20260423"
													);
												const allowUnsupportedFallback =
													fallbackOnUnsupportedCodexModel ||
													shouldForceSparkFallback ||
													shouldForceGpt55Fallback;

												// Entitlements can differ by account/workspace, so try remaining
												// accounts before degrading the model via fallback.
												// Spark entitlement is commonly unavailable on non-Pro/Business workspaces;
												// force direct fallback instead of traversing every account/workspace first.
												if (
													unsupportedModelInfo.isUnsupported &&
													hasRemainingAccounts &&
													!shouldForceSparkFallback
												) {
													await applySubmittedRestriction(() => {
														entitlementCache.markBlocked(entitlementAccountKey, blockedModel, "unsupported-model");
														capabilityPolicyStore.recordUnsupported(entitlementAccountKey, blockedModel);
														accountManager.refundToken(account, modelFamily, model);
														accountManager.recordFailure(account, modelFamily, model, primaryAdmission);
														capabilityPolicyStore.recordFailure(entitlementAccountKey, capabilityModelKey);
														sessionAffinityStore?.forgetSession(sessionAffinityKey);
														account.lastSwitchReason = "rotation";
													});
													if (restrictionObservationFailed) return errorResponse;
													runtimeMetrics.lastError = `Unsupported model on account ${account.index + 1}: ${blockedModel}`;
													logWarn(
														`Model ${blockedModel} is unsupported for account ${account.index + 1}. Trying next account/workspace before fallback.`,
														{
															unsupportedCodexPolicy,
															requestedModel: blockedModel,
															effectiveModel: blockedModel,
															fallbackApplied: false,
															fallbackReason: "unsupported-model-entitlement",
														},
													);
													retryNextAccountBeforeFallback = true;
													break;
												}

												const fallbackModel =
													resolveUnsupportedCodexFallbackModel({
														requestedModel: model,
														errorBody,
														attemptedModels: attemptedUnsupportedFallbackModels,
														fallbackOnUnsupportedCodexModel:
															allowUnsupportedFallback,
														fallbackToGpt52OnUnsupportedGpt53,
														customChain: unsupportedCodexFallbackChain,
													});

												if (fallbackModel) {
													const previousModel = model ?? CURRENT_CODEX_MODEL;
													const previousModelFamily = modelFamily;
													attemptedUnsupportedFallbackModels.add(previousModel);
													attemptedUnsupportedFallbackModels.add(fallbackModel);
													await applySubmittedRestriction(() => {
														entitlementCache.markBlocked(entitlementAccountKey, previousModel, "unsupported-model");
														capabilityPolicyStore.recordUnsupported(entitlementAccountKey, previousModel);
														accountManager.refundToken(account, previousModelFamily, previousModel);
													});
													if (restrictionObservationFailed) return errorResponse;

													model = fallbackModel;
													modelFamily = getModelFamily(model);
													quotaKey = `${modelFamily}:${model}`;

													if (
														transformedBody &&
														typeof transformedBody === "object"
													) {
														transformedBody = { ...transformedBody, model };
													} else {
														let fallbackBody: Record<string, unknown> = {
															model,
														};
														if (
															requestInit?.body &&
															typeof requestInit.body === "string"
														) {
															try {
																const parsed = JSON.parse(
																	requestInit.body,
																) as Record<string, unknown>;
																fallbackBody = { ...parsed, model };
															} catch {
																// Keep minimal fallback body if parsing fails.
															}
														}
														transformedBody = fallbackBody as RequestBody;
													}

													requestInit = {
														...(requestInit ?? {}),
														body: JSON.stringify(transformedBody),
													};
													runtimeMetrics.lastError = `Model fallback: ${previousModel} -> ${model}`;
													logWarn(
														`Model ${previousModel} is unsupported for this ChatGPT account. Falling back to ${model}.`,
														{
															unsupportedCodexPolicy,
															requestedModel: previousModel,
															effectiveModel: model,
															fallbackApplied: true,
															fallbackReason: "unsupported-model-entitlement",
														},
													);
													await showRuntimeToast(
														client,
														`Model ${previousModel} is not available for this account. Retrying with ${model}.`,
														"warning",
														{ duration: toastDurationMs },
													);
													restartAccountTraversalWithFallback = true;
													break;
												}

												if (
													unsupportedModelInfo.isUnsupported &&
													!allowUnsupportedFallback
												) {
													await applySubmittedRestriction(() => {
														entitlementCache.markBlocked(entitlementAccountKey, blockedModel, "unsupported-model");
														capabilityPolicyStore.recordUnsupported(entitlementAccountKey, blockedModel);
													});
													if (restrictionObservationFailed) return errorResponse;
													runtimeMetrics.lastError = `Unsupported model (strict): ${blockedModel}`;
													logWarn(
														`Model ${blockedModel} is unsupported for this ChatGPT account. Strict policy blocks automatic fallback.`,
														{
															unsupportedCodexPolicy,
															requestedModel: blockedModel,
															effectiveModel: blockedModel,
															fallbackApplied: false,
															fallbackReason: "unsupported-model-entitlement",
														},
													);
													await showRuntimeToast(
														client,
														`Model ${blockedModel} is not available for this account. Strict policy blocked automatic fallback.`,
														"warning",
														{ duration: toastDurationMs },
													);
												}
												if (
													unsupportedModelInfo.isUnsupported &&
													allowUnsupportedFallback &&
													!hasRemainingAccounts &&
													!fallbackModel
												) {
													await applySubmittedRestriction(() => {
														entitlementCache.markBlocked(entitlementAccountKey, blockedModel, "unsupported-model");
														capabilityPolicyStore.recordUnsupported(entitlementAccountKey, blockedModel);
													});
													if (restrictionObservationFailed) return errorResponse;
												}
												const workspaceErrorCode =
													(
														errorBody as
															| { error?: { code?: string } }
															| undefined
													)?.error?.code ?? "";
												const workspaceErrorMessage =
													(
														errorBody as
															| { error?: { message?: string } }
															| undefined
													)?.error?.message ?? "";
												const isDisabledWorkspaceError =
													isWorkspaceDisabledError(
														errorResponse.status,
														workspaceErrorCode,
														workspaceErrorMessage,
													);

												// Handle workspace disabled/expired errors by rotating to the next workspace
												// within the same account before falling back to another account.
												if (isDisabledWorkspaceError) {
													runtimeMetrics.failedRequests++;
													runtimeMetrics.lastError = `Workspace disabled for account ${account.index + 1}`;

													if (
														!account.workspaces ||
														account.workspaces.length === 0
													) {
														logWarn(
															`Workspace disabled/expired for account ${account.index + 1} without tracked workspaces. Leaving account enabled.`,
															{ errorCode: workspaceErrorCode },
														);
														if (hasRemainingAccounts) {
															continue accountAttemptLoop;
														}
														return errorResponse;
													} else {
														const submittedWorkspace = primarySubmittedAccount.workspaces?.find(workspace => workspace.id === primarySubmittedCredential.accountId);
														const workspaceName = submittedWorkspace?.name ?? primarySubmittedCredential.accountId ?? "unknown";

														logWarn(
															`Workspace disabled/expired for account ${account.index + 1} - workspace: ${workspaceName}. Rotating to next workspace.`,
															{ errorCode: workspaceErrorCode },
														);

														const rotation: {workspace: ReturnType<typeof accountManager.getCurrentWorkspace>} = {workspace: null};
														const workspaceApplied = await applySubmittedRestriction(() => {
															if (!primarySubmittedCredential.accountId || !accountManager.disableWorkspace(account, primarySubmittedCredential.accountId))
																return false;
															rotation.workspace = accountManager.getCurrentWorkspace(account);
															if (rotation.workspace?.id === primarySubmittedCredential.accountId)
																rotation.workspace = accountManager.rotateToNextWorkspace(account);
															if (!account.workspaces?.some(workspace => workspace.enabled !== false))
																accountManager.setAccountEnabled(account.index, false);
															return true;
														}, true);
														if (restrictionObservationFailed) return errorResponse;
														if (!workspaceApplied) return errorResponse;

														if (rotation.workspace) {
															accountManager.saveToDiskDebounced();

															const newWorkspaceName =
																rotation.workspace.name ?? rotation.workspace.id;
															await showRuntimeToast(
																client,
																`Workspace ${workspaceName} disabled. Switched to ${newWorkspaceName}.`,
																"warning",
																{ duration: toastDurationMs },
															);

															logInfo(
																`Rotated to workspace ${newWorkspaceName} for account ${account.index + 1}`,
															);

															// Allow the same account to be selected again with fresh request state.
															attempted.delete(account.index);
															continue accountAttemptLoop;
														}

														logWarn(
															`All workspaces disabled for account ${account.index + 1}. Disabling account.`,
														);


														await showRuntimeToast(
															client,
															`All workspaces disabled for account ${account.index + 1}. Switching to another account.`,
															"warning",
															{ duration: toastDurationMs },
														);

														// Forget session affinity and continue the outer loop so another
														// enabled account can service the request.
														sessionAffinityStore?.forgetSession(
															sessionAffinityKey,
														);
														continue accountAttemptLoop;
													}
												}

												if (
													errorResponse.status === 403 &&
													!unsupportedModelInfo.isUnsupported &&
													!isDisabledWorkspaceError
												) {
													await applySubmittedRestriction(() => {
														entitlementCache.markBlocked(entitlementAccountKey, model ?? modelFamily, "plan-entitlement");
														capabilityPolicyStore.recordFailure(entitlementAccountKey, capabilityModelKey);
													});
													if (restrictionObservationFailed) return errorResponse;
												}

												if (
													recoveryHook &&
													errorBody &&
													isRecoverableError(errorBody)
												) {
													const errorType = detectErrorType(errorBody);
													const toastContent =
														getRecoveryToastContent(errorType);
													await showRuntimeToast(
														client,
														`${toastContent.title}: ${toastContent.message}`,
														"warning",
														{ duration: toastDurationMs },
													);
													logDebug(
														`[${PLUGIN_NAME}] Recoverable error detected: ${errorType}`,
													);
												}

												// Preserve the original 5xx outcome without replaying the authorized request.
												if (response.status >= 500 && response.status < 600) {
													logWarn(
														`Server error ${response.status} for account ${account.index + 1}. Request not replayed.`,
													);
													runtimeMetrics.failedRequests++;
													runtimeMetrics.serverErrors++;
													runtimeMetrics.lastError = `HTTP ${response.status}`;
													const serverRetryAfterMs = parseRetryAfterHintMs(
														response.headers,
													);
													const policy = evaluateFailurePolicy(
														{
															kind: "server",
															failoverMode,
															serverRetryAfterMs:
																serverRetryAfterMs ?? undefined,
														},
														{ serverCooldownMs: serverErrorCooldownMs },
													);
													let serverBurstCooldownUntil = 0;
													await applySubmittedRestriction(() => { serverBurstCooldownUntil = recordServerBurstFailure(account.index); });
													if (restrictionObservationFailed) return errorResponse;
													if (serverBurstCooldownUntil > 0) {
														runtimeMetrics.lastError =
															"Repeated upstream server errors across the account pool";
														syncRuntimeObservability(requestTraceId);
													}
													// Overload-type server errors (502 Bad Gateway, 503 Service
													// Unavailable, 529 Overloaded) signal upstream capacity
													// pressure. Notify the quota scheduler so it can proactively
													// defer subsequent requests for this quota key, mirroring the
													// 429 handler's scheduler awareness.
													if (
														(response.status === 502 ||
															response.status === 503 ||
															response.status === 529) &&
														typeof policy.cooldownMs === "number"
													) {
														const cooldownMs = policy.cooldownMs;
														await applyReceivedRateLimit(() => cooldownMs);
														if (restrictionObservationFailed) return errorResponse;
													}
													if (policy.refundToken) {
														accountManager.refundToken(
															account,
															modelFamily,
															model,
														);
													}
													await applySubmittedRestriction(() => {
														if (policy.recordFailure) {
															accountManager.recordFailure(account, modelFamily, model, primaryAdmission);
															capabilityPolicyStore.recordFailure(entitlementAccountKey, capabilityModelKey);
														}
														if (typeof policy.cooldownMs === "number" &&
															policy.cooldownReason) {
															accountManager.markAccountCoolingDown(account, policy.cooldownMs, policy.cooldownReason);
															accountManager.saveToDiskDebounced();
														}
													});
													if (restrictionObservationFailed) return errorResponse;
													sessionAffinityStore?.forgetSession(
														sessionAffinityKey,
													);
													return errorResponse;
												}

												if (errorResponse.status === 429 && rateLimit) {
													runtimeMetrics.rateLimitedResponses++;
													const retryAfterMs =
														rateLimit?.retryAfterMs ?? 60_000;
													let cooldownMs = 0;
													if (!await applyReceivedRateLimit(() => {
														const {delayMs} = getRateLimitBackoff(account.index, quotaKey, retryAfterMs, primarySubmittedCredential.accountId ?? primarySubmittedAccount.email ?? null);
														cooldownMs = Math.max(delayMs, retryAfterMs);
														accountManager.markRateLimitedWithReason(account, cooldownMs, modelFamily, parseRateLimitReason(rateLimit?.code), model);
														accountManager.recordRateLimit(account, modelFamily, model);
														accountManager.saveToDiskDebounced();
														return cooldownMs;
													})) return errorResponse;
													const waitLabel = formatWaitTime(cooldownMs);
													const shortRetryThresholdMs =
														getConfiguredRateLimitShortRetryThresholdMs();

													if (
														cooldownMs <= shortRetryThresholdMs &&
														shortRateLimitRetryCount < MAX_SHORT_RETRY_ATTEMPTS
													) {
														shortRateLimitRetryCount += 1;

														// Mark the account unavailable BEFORE we sleep so
														// concurrent in-flight requests do not select the
														// same freshly rate-limited account during the retry
														// window. Without this, the fetch loop amplifies the
														// throttling pressure instead of spreading load.
														// The current request will continue after the sleep
														// regardless of the cooldown mark (AUDIT-H3 / D-07).
														if (
															accountManager.shouldShowAccountToast(
																account.index,
																rateLimitToastDebounceMs,
															)
														) {
															await showRuntimeToast(
																client,
																`Rate limited. Retrying in ${waitLabel} (attempt ${shortRateLimitRetryCount})...`,
																"warning",
																{ duration: toastDurationMs },
															);
															accountManager.markToastShown(account.index);
														}

														await sleep(
															addJitter(
																Math.max(MIN_BACKOFF_MS, cooldownMs),
																0.2,
															),
														);
														if (!await applySubmittedRestriction(() => true)) return errorResponse;
														shortRetryResponse = errorResponse;
														continue;
													}

													const restrictionApplied = await applySubmittedRestriction(() => {
														account.lastSwitchReason = "rate-limit";
														sessionAffinityStore?.forgetSession(sessionAffinityKey);
														runtimeMetrics.accountRotations++;
														accountManager.saveToDiskDebounced();
													});
													if (restrictionObservationFailed) return errorResponse;
													if (!restrictionApplied) return errorResponse;
													logWarn(
														`Rate limited. Rotating account ${account.index + 1} (${account.email ?? "unknown"}).`,
													);

													if (
														accountManager.getAccountCount() > 1 &&
														accountManager.shouldShowAccountToast(
															account.index,
															rateLimitToastDebounceMs,
														)
													) {
														await showRuntimeToast(
															client,
															`Rate limited. Switching accounts (retry in ${waitLabel}).`,
															"warning",
															{ duration: toastDurationMs },
														);
														accountManager.markToastShown(account.index);
													}
													break;
												}
												if (
													!rateLimit &&
													!unsupportedModelInfo.isUnsupported &&
													errorResponse.status !== 403
												) {
													await applySubmittedRestriction(() => {
														capabilityPolicyStore.recordFailure(entitlementAccountKey, capabilityModelKey);
													});
													if (restrictionObservationFailed) return errorResponse;
												}
												runtimeMetrics.failedRequests++;
												runtimeMetrics.lastError = `HTTP ${response.status}`;
												return errorResponse;
											}

											runtimeMetrics.cumulativeLatencyMs += fetchLatencyMs;
											const responseForSuccess = isStreaming ? withStreamingFailover(response, () => Promise.resolve(null), {
												maxFailovers: streamFailoverMax,
												softTimeoutMs: streamFailoverSoftTimeoutMs,
												hardTimeoutMs: streamFailoverHardTimeoutMs,
												requestInstanceId: requestCorrelationId ?? undefined,
											}) : response;
											const affinityCurrent = sessionAffinityStore?.captureWriteAuthority(sessionAffinityKey);
											let observedResponseIdForSuccess: string | undefined;
											let acceptedUsage: ReturnType<typeof usageDeferral.captured> = null;
											let observedCompletion: import("./lib/request/response-outcome.js").StreamCompletion | undefined;
											const acceptedRow: RuntimeUsageRecordInput = {
												outcome: "failure", statusCode: responseForSuccess.status, errorCode: "upstream_missing_terminal",
												account: {index: primarySubmittedAccount.index, accountId: primarySubmittedAccount.accountId ?? null, email: primarySubmittedAccount.email ?? null},
											};
											const settleAcceptedResponse = async (completion: import("./lib/request/response-outcome.js").StreamCompletion) => {
												acceptedRow.account = {index: primarySubmittedAccount.index, accountId: primarySubmittedAccount.accountId ?? null, email: primarySubmittedAccount.email ?? null};
												if (completion.success) {
													runtimeMetrics.successfulRequests++;
													runtimeMetrics.lastError = null;
													let successApplied = false;
													try {
														successApplied = await accountManager.withCurrentAccountCredential(account, primarySubmittedCredential, () => {
															if (restrictionObservationFailed || !primaryAdmission || !accountManager.recordSuccess(account, modelFamily, model, primaryAdmission)) return false;
															if (!preemptiveQuotaScheduler.getDeferral(quotaScheduleKey, Date.now(), quotaOwner).defer) resetRateLimitBackoff(account.index, quotaKey, primarySubmittedCredential.accountId ?? primarySubmittedAccount.email ?? null);
															if (affinityCurrent?.()) {
																sessionAffinityStore?.rememberWithVersion(sessionAffinityKey, account.index, Date.now(), sessionAffinityVersion);
																if (responseContinuationEnabled && observedResponseIdForSuccess) sessionAffinityStore?.updateLastResponseId(sessionAffinityKey, observedResponseIdForSuccess, Date.now(), sessionAffinityVersion);
															}
															capabilityPolicyStore.recordSuccess(entitlementAccountKey, capabilityModelKey);
															entitlementCache.clear(entitlementAccountKey, capabilityModelKey);
															return true;
														}, false);
													} catch (error) {
														runtimeMetrics.lastError = error instanceof Error ? error.message : String(error);
														logWarn("Accepted response recovery authority could not be observed", {error});
													}
													if (successApplied) {
														if (lastCodexCliActiveSyncIndex !== account.index) {
															void accountManager.syncCodexCliActiveSelectionForIndex(account.index, primarySubmittedCredential);
															lastCodexCliActiveSyncIndex = account.index;
														}
														clearPoolExhaustionCooldown();
														clearServerBurstCooldown();
													}
												} else {
													runtimeMetrics.failedRequests++;
													runtimeMetrics.lastError = completion.errorCode;
													await accountManager.withCurrentAccountCredential(account, primarySubmittedCredential, () => {
														accountManager.recordFailure(account, modelFamily, model, primaryAdmission);
													}, false).catch(observeRestrictionFailure);
												}
												syncRuntimeObservability(requestTraceId);
												await usageDeferral.complete({...acceptedRow, outcome: completion.outcome, errorCode: completion.errorCode, ...(acceptedUsage ?? {})});
											};
											const successResponse = await handleSuccessResponse(responseForSuccess, isStreaming, {
												onResponseId: responseId => {if (responseContinuationEnabled) observedResponseIdForSuccess = responseId;},
												onUsage: usage => {
													acceptedUsage = usage;
													usageDeferral.onUsage(usage, false);
													if (sessionAffinityKey && model) contextBudgetGuard.update(sessionAffinityKey, {model, contextTokens: usage.inputTokens + usage.outputTokens, updatedAt: Date.now()});
												},
												onCompletion: async completion => {
													observedCompletion = completion;
													if (isStreaming || completion.errorCode === "stream_read_failed" || completion.errorCode === "client_cancelled") {
														await settleAcceptedResponse(completion);
														usageCompletion = null;
													}
												},
												streamStallTimeoutMs,
												streamIdleTimeoutMs: USAGE_STREAM_IDLE_TIMEOUT_MS,
											});
											if (!isStreaming) {
												acceptedRow.statusCode = successResponse.status;
												await settleAcceptedResponse(observedCompletion ?? {success: successResponse.ok, outcome: successResponse.ok ? "success" : "failure", errorCode: successResponse.ok ? null : "upstream_response_failed", missingTerminal: false});
											}
											usageCompletion = null;
											// Non-blocking: contextBudgetAdvisory reflects usage
											// observed as of the PRIOR turn (this turn's own usage
											// isn't known yet for a streaming body), attached as a
											// header for `codex-multi-auth status` / the statusline
											// rather than altering this response's body.
											if (contextBudgetAdvisory.level === "soft") {
												const headers = new Headers(successResponse.headers);
												for (const [name, value] of Object.entries(
													buildContextBudgetHeaders(contextBudgetAdvisory),
												)) {
													headers.set(name, value);
												}
												return new Response(successResponse.body, {
													status: successResponse.status,
													statusText: successResponse.statusText,
													headers,
												});
											}
											return successResponse;
										}
										if (retryNextAccountBeforeFallback) {
											retryNextAccountBeforeFallback = false;
											continue;
										}

										if (restartAccountTraversalWithFallback) {
											break;
										}
									}

									if (restartAccountTraversalWithFallback) {
										continue;
									}

									const waitMs = accountManager.getMinWaitTimeForFamily(
										modelFamily,
										model,
									);
									const count = accountManager.getAccountCount();

									if (
										retryAllAccountsRateLimited &&
										count > 0 &&
										waitMs > 0 &&
										(retryAllAccountsMaxWaitMs === 0 ||
											waitMs <= retryAllAccountsMaxWaitMs) &&
										allRateLimitedRetries < retryAllAccountsMaxRetries
									) {
										const countdownMessage = `All ${count} account(s) rate-limited. Waiting`;
										await sleepWithCountdown({
											totalMs: addJitter(waitMs, 0.2),
											message: countdownMessage,
											sleep,
											showToast: (message, variant, options) =>
												showRuntimeToast(client, message, variant, options),
											formatWaitTime,
											toastDurationMs,
											abortSignal,
										});
										allRateLimitedRetries++;
										continue;
									}

									const now = Date.now();
									const poolCooldownUntil =
										count > 0 && waitMs > 0
											? armPoolExhaustionCooldown(waitMs, now)
											: 0;
									const effectiveWaitMs =
										poolCooldownUntil > 0
											? Math.max(0, poolCooldownUntil - now)
											: waitMs;
									const waitLabel =
										effectiveWaitMs > 0
											? formatWaitTime(effectiveWaitMs)
											: "a bit";
									const message =
										count === 0
											? "No Codex accounts configured. Run `codex-multi-auth login`."
											: effectiveWaitMs > 0
												? `All ${count} account(s) are rate-limited. A short pool cooldown is now active for ${waitLabel}. Try again later or inspect \`codex-multi-auth status\`.`
												: `All ${count} account(s) failed (server errors or auth issues). Check account health with \`codex-multi-auth report --json\`.`;
									runtimeMetrics.failedRequests++;
									runtimeMetrics.lastError = message;
									syncRuntimeObservability(requestTraceId);
									return new Response(JSON.stringify({ error: { message } }), {
										status: effectiveWaitMs > 0 ? 429 : 503,
										headers: {
											"content-type": "application/json; charset=utf-8",
										},
									});
								}
							} finally {
								if (usageRecorder && usageCompletion) {
									await usageRecorder.record(usageCompletion);
								}
								syncRuntimeObservability(null);
								clearCorrelationId();
							}
						},
					};
				} finally {
					resolveMutex?.();
					loaderMutex = null;
				}
			},
			methods: [
				{
					label: AUTH_LABELS.OAUTH,
					type: "oauth" as const,
					authorize: async (inputs?: Record<string, string>) => {
						const authPluginConfig = loadPluginConfig();
						applyUiRuntimeFromConfig(authPluginConfig, setUiRuntimeOptions);
						applyAccountStorageScopeFromConfig(authPluginConfig, {
							getPerProjectAccounts,
							getStorageBackupEnabled,
							setStorageBackupEnabled,
							isCodexCliSyncEnabled,
							getWarningShown: () => perProjectStorageWarningShown,
							setWarningShown: (shown) => {
								perProjectStorageWarningShown = shown;
							},
							logWarn,
							pluginName: PLUGIN_NAME,
							setStoragePath,
							cwd: () => process.cwd(),
						});

						const accounts: TokenSuccessWithAccount[] = [];
						const noBrowser =
							inputs?.manual === "true" ||
							inputs?.noBrowser === "true" ||
							inputs?.["no-browser"] === "true";
						const useManualMode = noBrowser || isBrowserLaunchSuppressed();
						const explicitLoginMode =
							inputs?.loginMode === "fresh" || inputs?.loginMode === "add"
								? inputs.loginMode
								: null;

						let startFresh = explicitLoginMode === "fresh";
						let refreshAccountIndex: number | undefined;

						if (!explicitLoginMode) {
							while (true) {
								const loadedStorage = await hydrateRuntimeEmails(
									await loadAccounts(),
									{
										queuedRefresh,
										extractAccountId,
										sanitizeEmail,
										extractAccountEmail,
										shouldUpdateAccountIdFromToken,
										saveAccounts,
										logWarn,
										pluginName: PLUGIN_NAME,
									},
								);
								const workingStorage = loadedStorage
									? {
											...loadedStorage,
											accounts: loadedStorage.accounts.map((account) => ({
												...account,
											})),
											activeIndexByFamily: loadedStorage.activeIndexByFamily
												? { ...loadedStorage.activeIndexByFamily }
												: {},
										}
									: {
											version: 3 as const,
											accounts: [],
											activeIndex: 0,
											activeIndexByFamily: {},
										};
								const flaggedStorage = await loadFlaggedAccounts();

								if (
									workingStorage.accounts.length === 0 &&
									flaggedStorage.accounts.length === 0
								) {
									break;
								}

								const now = Date.now();
								const activeIndex = resolveActiveIndex(workingStorage, "codex");
								const runtimeCurrent = await resolveRuntimeCurrentForStorage(
									workingStorage,
									now,
								);
								const existingAccounts = buildLoginMenuAccounts(
									workingStorage.accounts,
									{
										now,
										activeIndex,
										runtimeCurrent,
										formatRateLimitEntry: (account, currentNow) =>
											formatRateLimitEntry(account, currentNow, formatWaitTime),
									},
								);

								const menuResult = await promptLoginMode(existingAccounts, {
									flaggedCount: flaggedStorage.accounts.length,
								});

								if (menuResult.mode === "cancel") {
									return {
										url: "",
										instructions: "Authentication cancelled",
										method: "auto",
										callback: () =>
											Promise.resolve({
												type: "failed" as const,
											}),
									};
								}

								const accountCheckDeps = {
									hydrateEmails: (storage: AccountStorageV3 | null) =>
										hydrateRuntimeEmails(storage, {
											queuedRefresh,
											extractAccountId,
											sanitizeEmail,
											extractAccountEmail,
											shouldUpdateAccountIdFromToken,
											saveAccounts,
											logWarn,
											pluginName: PLUGIN_NAME,
										}),
									loadAccounts,
									createEmptyStorage: () => ({
										version: 3 as const,
										accounts: [],
										activeIndex: 0,
										activeIndexByFamily: {},
									}),
									loadFlaggedAccounts,
									createAccountCheckWorkingState,
									lookupCodexCliTokensByEmail,
									extractAccountId,
									shouldUpdateAccountIdFromToken,
									sanitizeEmail,
									extractAccountEmail,
									queuedRefresh,
									isRuntimeFlaggableFailure: isFlaggableFailure,
									fetchCodexQuotaSnapshot,
									resolveRequestAccountId,
									formatCodexQuotaLine: formatQuotaSnapshotLine,
									clampRuntimeActiveIndices: clampActiveIndices,
									MODEL_FAMILIES,
									saveAccounts,
									invalidateAccountManagerCache: () =>
										invalidateRuntimeAccountManagerCache(
											accountManagerCacheInvalidationDeps,
										),
									saveFlaggedAccounts,
									showLine: (message: string) => console.log(message),
								};

								if (menuResult.mode === "check") {
									await runRuntimeAccountCheck(false, accountCheckDeps);
									continue;
								}
								if (menuResult.mode === "deep-check") {
									await runRuntimeAccountCheck(true, accountCheckDeps);
									continue;
								}
								if (menuResult.mode === "verify-flagged") {
									await verifyRuntimeFlaggedAccounts({
										loadFlaggedAccounts,
										lookupCodexCliTokensByEmail,
										queuedRefresh,
										resolveTokenSuccessAccount,
										persistAccounts: persistAccountPool,
										persistAccountsAndFlagged: persistAccountPoolAndFlagged,
										invalidateAccountManagerCache: () =>
											invalidateRuntimeAccountManagerCache(
												accountManagerCacheInvalidationDeps,
											),
										saveFlaggedAccounts,
										showLine: (message) => console.log(message),
									});
									continue;
								}

								if (menuResult.mode === "manage") {
									if (typeof menuResult.deleteAccountIndex === "number") {
										const target =
											workingStorage.accounts[menuResult.deleteAccountIndex];
										if (target) {
											workingStorage.accounts.splice(
												menuResult.deleteAccountIndex,
												1,
											);
											clampActiveIndices(workingStorage, MODEL_FAMILIES);
											await saveAccounts(workingStorage);
											await saveFlaggedAccounts({
												version: 1,
												accounts: flaggedStorage.accounts.filter(
													(flagged) =>
														flagged.refreshToken !== target.refreshToken,
												),
											});
											invalidateRuntimeAccountManagerCache(
												accountManagerCacheInvalidationDeps,
											);
											console.log(
												`\nDeleted ${target.email ?? `Account ${menuResult.deleteAccountIndex + 1}`}.\n`,
											);
										}
										continue;
									}

									if (typeof menuResult.toggleAccountIndex === "number") {
										const target =
											workingStorage.accounts[menuResult.toggleAccountIndex];
										if (target) {
											target.enabled = target.enabled === false ? true : false;
											await saveAccounts(workingStorage);
											invalidateRuntimeAccountManagerCache(
												accountManagerCacheInvalidationDeps,
											);
											console.log(
												`\n${target.email ?? `Account ${menuResult.toggleAccountIndex + 1}`} ${target.enabled === false ? "disabled" : "enabled"}.\n`,
											);
										}
										continue;
									}

									if (typeof menuResult.refreshAccountIndex === "number") {
										refreshAccountIndex = menuResult.refreshAccountIndex;
										startFresh = false;
										break;
									}

									continue;
								}

								if (menuResult.mode === "fresh") {
									startFresh = true;
									if (menuResult.deleteAll) {
										// Raw sk- API keys and per-account runtime state live beside the
										// pool; they are removed even if the pool clear fails.
										await clearAccountsAndCredentialSidecars(async () => {
											await clearAccounts();
											await clearFlaggedAccounts();
										});
										invalidateRuntimeAccountManagerCache(
											accountManagerCacheInvalidationDeps,
										);
										console.log(
											"\nCleared saved accounts and API credentials. Account recovery snapshots remain available. Starting fresh.\n",
										);
									}
									break;
								}

								startFresh = false;
								break;
							}
						}

						const latestStorage = await loadAccounts();
						const existingCount = latestStorage?.accounts.length ?? 0;
						const requestedCount = Number.parseInt(
							inputs?.accountCount ?? "1",
							10,
						);
						const normalizedRequested = Number.isFinite(requestedCount)
							? requestedCount
							: 1;
						const availableSlots =
							refreshAccountIndex !== undefined
								? 1
								: startFresh
									? ACCOUNT_LIMITS.MAX_ACCOUNTS
									: ACCOUNT_LIMITS.MAX_ACCOUNTS - existingCount;

						if (availableSlots <= 0) {
							return {
								url: "",
								instructions:
									"Account limit reached. Remove an account or start fresh.",
								method: "auto",
								callback: () =>
									Promise.resolve({
										type: "failed" as const,
									}),
							};
						}

						let targetCount = Math.max(
							1,
							Math.min(normalizedRequested, availableSlots),
						);
						if (refreshAccountIndex !== undefined) {
							targetCount = 1;
						}
						if (useManualMode) {
							targetCount = 1;
						}

						if (useManualMode) {
							const { pkce, state, url } = await createAuthorizationFlow();
							return buildManualOAuthFlow({
								pkce,
								url,
								expectedState: state,
								redirectUri: REDIRECT_URI,
								parseAuthorizationInput,
								exchangeAuthorizationCode,
								resolveTokenSuccess: resolveTokenSuccessAccount,
								instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
								onSuccess: async (tokens) => {
									try {
										await persistAccountPool([tokens], startFresh);
										invalidateRuntimeAccountManagerCache(
											accountManagerCacheInvalidationDeps,
										);
									} catch (err) {
										const storagePath = getStoragePath();
										const errorCode =
											(err as NodeJS.ErrnoException)?.code || "UNKNOWN";
										const hint =
											err instanceof StorageError
												? err.hint
												: formatStorageErrorHint(err, storagePath);
										logError(
											`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`,
										);
										await showRuntimeToast(client, hint, "error", {
											title: "Account Persistence Failed",
											duration: 10000,
										});
									}
								},
							});
						}

						const explicitCountProvided =
							typeof inputs?.accountCount === "string" &&
							inputs.accountCount.trim().length > 0;

						while (accounts.length < targetCount) {
							logInfo(`=== OpenAI OAuth (Account ${accounts.length + 1}) ===`);
							const forceNewLogin =
								accounts.length > 0 || refreshAccountIndex !== undefined;
							const result = await runRuntimeOAuthFlow(forceNewLogin, {
								runBrowserOAuthFlow: (input) =>
									runBrowserOAuthFlow({
										...input,
										createAuthorizationFlow,
										redactOAuthUrlForLog,
										startLocalOAuthServer,
										openBrowserUrl,
										pluginName: PLUGIN_NAME,
										authManualLabel: AUTH_LABELS.OAUTH_MANUAL,
										exchangeAuthorizationCode,
										redirectUri: REDIRECT_URI,
									}),
								manualModeLabel: AUTH_LABELS.OAUTH_MANUAL,
								logInfo,
								logDebug,
								logWarn,
								pluginName: PLUGIN_NAME,
							});

							let resolved: TokenSuccessWithAccount | null = null;
							if (result.type === "success") {
								resolved = resolveTokenSuccessAccount(result);
								const email = extractAccountEmail(
									resolved.access,
									resolved.idToken,
								);
								const accountId =
									resolved.accountIdOverride ??
									extractAccountId(resolved.access);
								const label =
									resolved.accountLabel ??
									email ??
									accountId ??
									"Unknown account";
								logInfo(`Authenticated as: ${label}`);

								const isDuplicate =
									findMatchingAccountIndex(
										accounts.map((account) => ({
											accountId:
												account.accountIdOverride ??
												extractAccountId(account.access),
											email: sanitizeEmail(
												extractAccountEmail(account.access, account.idToken),
											),
											refreshToken: account.refresh,
										})),
										{
											accountId,
											email: sanitizeEmail(email),
											refreshToken: resolved.refresh,
										},
										{
											allowUniqueAccountIdFallbackWithoutEmail: true,
										},
									) !== undefined;

								if (isDuplicate) {
									logWarn(
										`WARNING: duplicate account login detected (${label}). Existing entry will be updated.`,
									);
								}
							}

							if (result.type === "failed") {
								if (accounts.length === 0) {
									return {
										url: "",
										instructions: "Authentication failed.",
										method: "auto",
										callback: () => Promise.resolve(result),
									};
								}
								logWarn(
									`[${PLUGIN_NAME}] Skipping failed account ${accounts.length + 1}`,
								);
								break;
							}

							if (!resolved) {
								continue;
							}

							accounts.push(resolved);
							await showRuntimeToast(
								client,
								`Account ${accounts.length} authenticated`,
								"success",
							);

							try {
								const isFirstAccount = accounts.length === 1;
								await persistAccountPool(
									[resolved],
									isFirstAccount && startFresh,
								);
								invalidateRuntimeAccountManagerCache(
									accountManagerCacheInvalidationDeps,
								);
							} catch (err) {
								const storagePath = getStoragePath();
								const errorCode =
									(err as NodeJS.ErrnoException)?.code || "UNKNOWN";
								const hint =
									err instanceof StorageError
										? err.hint
										: formatStorageErrorHint(err, storagePath);
								logError(
									`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`,
								);
								await showRuntimeToast(client, hint, "error", {
									title: "Account Persistence Failed",
									duration: 10000,
								});
							}

							if (accounts.length >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
								break;
							}

							if (
								!explicitCountProvided &&
								refreshAccountIndex === undefined &&
								accounts.length < availableSlots &&
								accounts.length >= targetCount
							) {
								const addMore = await promptAddAnotherAccount(accounts.length);
								if (addMore) {
									targetCount = Math.min(targetCount + 1, availableSlots);
									continue;
								}
								break;
							}
						}

						const primary = accounts[0];
						if (!primary) {
							return {
								url: "",
								instructions: "Authentication cancelled",
								method: "auto",
								callback: () =>
									Promise.resolve({
										type: "failed" as const,
									}),
							};
						}

						let actualAccountCount = accounts.length;
						try {
							const finalStorage = await loadAccounts();
							if (finalStorage) {
								actualAccountCount = finalStorage.accounts.length;
							}
						} catch (err) {
							logWarn(
								`[${PLUGIN_NAME}] Failed to load final account count: ${(err as Error)?.message ?? String(err)}`,
							);
						}

						return {
							url: "",
							instructions: `Multi-account setup complete (${actualAccountCount} account(s)).`,
							method: "auto",
							callback: () => Promise.resolve(primary),
						};
					},
				},

				{
					label: AUTH_LABELS.OAUTH_MANUAL,
					type: "oauth" as const,
					authorize: async () => {
						// Initialize storage path for manual OAuth flow
						// Must happen BEFORE persistAccountPool to ensure correct storage location
						const manualPluginConfig = loadPluginConfig();
						applyUiRuntimeFromConfig(manualPluginConfig, setUiRuntimeOptions);
						applyAccountStorageScopeFromConfig(manualPluginConfig, {
							getPerProjectAccounts,
							getStorageBackupEnabled,
							setStorageBackupEnabled,
							isCodexCliSyncEnabled,
							getWarningShown: () => perProjectStorageWarningShown,
							setWarningShown: (shown) => {
								perProjectStorageWarningShown = shown;
							},
							logWarn,
							pluginName: PLUGIN_NAME,
							setStoragePath,
							cwd: () => process.cwd(),
						});

						const { pkce, state, url } = await createAuthorizationFlow();
						return buildManualOAuthFlow({
							pkce,
							url,
							expectedState: state,
							redirectUri: REDIRECT_URI,
							parseAuthorizationInput,
							exchangeAuthorizationCode,
							resolveTokenSuccess: resolveTokenSuccessAccount,
							instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
							onSuccess: async (tokens) => {
								try {
									await persistAccountPool([tokens], false);
								} catch (err) {
									const storagePath = getStoragePath();
									const errorCode =
										(err as NodeJS.ErrnoException)?.code || "UNKNOWN";
									const hint =
										err instanceof StorageError
											? err.hint
											: formatStorageErrorHint(err, storagePath);
									logError(
										`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`,
									);
									await showRuntimeToast(client, hint, "error", {
										title: "Account Persistence Failed",
										duration: 10000,
									});
								}
							},
						});
					},
				},
			],
		},
		tool: {
			edit: createHashlineEditTool(),
			// Legacy runtime v1.2.x exposes apply_patch (not edit) to the model.
			// Register the same hashline-capable implementation under both names.
			apply_patch: createHashlineEditTool(),
			hashline_read: createHashlineReadTool(),
			"codex-list": tool({
				description:
					"List all Codex OAuth accounts and the current active index.",
				args: {},
				async execute() {
					const ui = applyUiRuntimeFromConfig(
						loadPluginConfig(),
						setUiRuntimeOptions,
					);
					const storage = await loadAccounts();
					const storePath = getStoragePath();

					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Codex accounts"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex-multi-auth login", "accent"),
								formatUiKeyValue(ui, "Storage", storePath, "muted"),
							].join("\n");
						}
						return [
							"No Codex accounts configured.",
							"",
							"Add accounts:",
							"  codex-multi-auth login",
							"",
							`Storage: ${storePath}`,
						].join("\n");
					}

					const now = Date.now();
					const activeIndex = resolveActiveIndex(storage, "codex");
					const runtimeCurrent = await resolveRuntimeCurrentForStorage(storage, now);
					const quotaCache = await loadQuotaCache().catch(() => null);
					if (ui.v2Enabled) {
						const lines: string[] = [
							...formatUiHeader(ui, "Codex accounts"),
							formatUiKeyValue(ui, "Total", String(storage.accounts.length)),
							formatUiKeyValue(ui, "Storage", storePath, "muted"),
							"",
							...formatUiSection(ui, "Accounts"),
						];

						storage.accounts.forEach((account, index) => {
							const label = formatAccountLabel(account, index);
							const badges: string[] = [];
							for (const marker of resolveAccountCurrentMarkers(
								index,
								activeIndex,
								runtimeCurrent,
							)) {
								badges.push(
									formatUiBadge(
										ui,
										currentMarkerLabel(marker),
										marker === "current" ? "accent" : "muted",
									),
								);
							}
							if (account.enabled === false)
								badges.push(formatUiBadge(ui, "disabled", "danger"));
							const rateLimit = formatRateLimitEntry(
								account,
								now,
								formatWaitTime,
							);
							if (rateLimit)
								badges.push(formatUiBadge(ui, "rate-limited", "warning"));
							const quotaEntry = findQuotaCacheEntryForAccount(
								quotaCache,
								account,
								storage.accounts,
							);
							if (quotaEntry?.status === 429 && !rateLimit) {
								badges.push(formatUiBadge(ui, "rate-limited", "warning"));
							}
							if (isQuotaCacheEntryExhausted(quotaEntry, now)) {
								badges.push(formatUiBadge(ui, "quota-exhausted", "warning"));
							}
							if (
								typeof account.coolingDownUntil === "number" &&
								account.coolingDownUntil > now
							) {
								badges.push(formatUiBadge(ui, "cooldown", "warning"));
							}
							if (badges.length === 0) {
								badges.push(formatUiBadge(ui, "ok", "success"));
							}

							lines.push(
								formatUiItem(
									ui,
									`${index + 1}. ${label} ${badges.join(" ")}`.trim(),
								),
							);
							if (rateLimit) {
								lines.push(
									`  ${paintUiText(ui, `rate limit: ${rateLimit}`, "muted")}`,
								);
							}
						});

						lines.push("");
						lines.push(...formatUiSection(ui, "Commands"));
						lines.push(formatUiItem(ui, "Add account: codex-multi-auth login", "accent"));
						lines.push(
							formatUiItem(ui, "Switch account: codex-switch <index>"),
						);
						lines.push(formatUiItem(ui, "Detailed status: codex-status"));
						lines.push(formatUiItem(ui, "Health check: codex-health"));
						return lines.join("\n");
					}

					const listTableOptions: TableOptions = {
						columns: [
							{ header: "#", width: 3 },
							{ header: "Label", width: 42 },
							{ header: "Status", width: 44 },
						],
					};

					const lines: string[] = [
						`Codex Accounts (${storage.accounts.length}):`,
						"",
						...buildTableHeader(listTableOptions),
					];

					storage.accounts.forEach((account, index) => {
						const label = formatAccountLabel(account, index);
						const statuses: string[] = [];
						const rateLimit = formatRateLimitEntry(
							account,
							now,
							formatWaitTime,
						);
						const quotaEntry = findQuotaCacheEntryForAccount(
							quotaCache,
							account,
							storage.accounts,
						);
						statuses.push(
							...resolveAccountCurrentMarkers(
								index,
								activeIndex,
								runtimeCurrent,
							).map(currentMarkerLabel),
						);
						if (rateLimit) statuses.push("rate-limited");
						appendQuotaStatusMarkers(statuses, quotaEntry, now);
						if (
							typeof account.coolingDownUntil === "number" &&
							account.coolingDownUntil > now
						) {
							statuses.push("cooldown");
						}
						const statusText = statuses.length > 0 ? statuses.join(", ") : "ok";
						lines.push(
							buildTableRow(
								[String(index + 1), label, statusText],
								listTableOptions,
							),
						);
					});

					lines.push("");
					lines.push(`Storage: ${storePath}`);
					lines.push("");
					lines.push("Commands:");
					lines.push("  - Add account: codex-multi-auth login");
					lines.push("  - Switch account: codex-switch");
					lines.push("  - Status details: codex-status");
					lines.push("  - Health check: codex-health");

					return lines.join("\n");
				},
			}),
			"codex-switch": tool({
				description: "Switch active Codex account by index (1-based).",
				args: {
					index: tool.schema
						.number()
						.describe(
							"Account number to switch to (1-based, e.g., 1 for first account)",
						),
				},
				async execute({ index }) {
					const ui = applyUiRuntimeFromConfig(
						loadPluginConfig(),
						setUiRuntimeOptions,
					);
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex-multi-auth login", "accent"),
							].join("\n");
						}
						return "No Codex accounts configured. Run: codex-multi-auth login";
					}

					const targetIndex = Math.floor((index ?? 0) - 1);
					if (
						!Number.isFinite(targetIndex) ||
						targetIndex < 0 ||
						targetIndex >= storage.accounts.length
					) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(ui, `Invalid account number: ${index}`, "danger"),
								formatUiKeyValue(
									ui,
									"Valid range",
									`1-${storage.accounts.length}`,
									"muted",
								),
							].join("\n");
						}
						return `Invalid account number: ${index}\n\nValid range: 1-${storage.accounts.length}`;
					}

					const now = Date.now();
					const account = storage.accounts[targetIndex];
					if (account) {
						account.lastUsed = now;
						account.lastSwitchReason = "rotation";
					}

					storage.activeIndex = targetIndex;
					storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
					for (const family of MODEL_FAMILIES) {
						storage.activeIndexByFamily[family] = targetIndex;
					}
					try {
						await saveAccounts(storage);
					} catch (saveError) {
						logWarn("Failed to save account switch", {
							error: String(saveError),
						});
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(
									ui,
									`Switched to ${formatAccountLabel(account, targetIndex)}`,
									"warning",
								),
								formatUiItem(
									ui,
									"Failed to persist change. It may be lost on restart.",
									"danger",
								),
							].join("\n");
						}
						return `Switched to ${formatAccountLabel(account, targetIndex)} but failed to persist. Changes may be lost on restart.`;
					}

					if (cachedAccountManager) {
						await reloadRuntimeAccountManager<AccountManager>(
							makeReloadAccountManagerDeps(),
						);
					}

					const label = formatAccountLabel(account, targetIndex);
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Switch account"),
							"",
							formatUiItem(
								ui,
								`${getStatusMarker(ui, "ok")} Switched to ${label}`,
								"success",
							),
						].join("\n");
					}
					return `Switched to account: ${label}`;
				},
			}),
			"codex-status": tool({
				description: "Show detailed status of Codex accounts and rate limits.",
				args: {},
				async execute() {
					const ui = applyUiRuntimeFromConfig(
						loadPluginConfig(),
						setUiRuntimeOptions,
					);
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Account status"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex-multi-auth login", "accent"),
							].join("\n");
						}
						return "No Codex accounts configured. Run: codex-multi-auth login";
					}

					const now = Date.now();
					const activeIndex = resolveActiveIndex(storage, "codex");
					const runtimeCurrent = await resolveRuntimeCurrentForStorage(storage, now);
					const quotaCache = await loadQuotaCache().catch(() => null);
					if (ui.v2Enabled) {
						const lines: string[] = [
							...formatUiHeader(ui, "Account status"),
							formatUiKeyValue(ui, "Total", String(storage.accounts.length)),
							"",
							...formatUiSection(ui, "Accounts"),
						];

						storage.accounts.forEach((account, index) => {
							const label = formatAccountLabel(account, index);
							const badges: string[] = [];
							for (const marker of resolveAccountCurrentMarkers(
								index,
								activeIndex,
								runtimeCurrent,
							)) {
								badges.push(
									formatUiBadge(
										ui,
										currentMarkerLabel(marker),
										marker === "current" ? "accent" : "muted",
									),
								);
							}
							if (account.enabled === false)
								badges.push(formatUiBadge(ui, "disabled", "danger"));
							const rateLimit =
								formatRateLimitEntry(account, now, formatWaitTime) ?? "none";
							const cooldown = formatCooldown(account, now) ?? "none";
							const quotaEntry = findQuotaCacheEntryForAccount(
								quotaCache,
								account,
								storage.accounts,
							);
							if (rateLimit !== "none")
								badges.push(formatUiBadge(ui, "rate-limited", "warning"));
							if (quotaEntry?.status === 429 && rateLimit === "none")
								badges.push(formatUiBadge(ui, "rate-limited", "warning"));
							if (isQuotaCacheEntryExhausted(quotaEntry, now))
								badges.push(formatUiBadge(ui, "quota-exhausted", "warning"));
							if (cooldown !== "none")
								badges.push(formatUiBadge(ui, "cooldown", "warning"));
							if (badges.length === 0)
								badges.push(formatUiBadge(ui, "ok", "success"));

							lines.push(
								formatUiItem(
									ui,
									`${index + 1}. ${label} ${badges.join(" ")}`.trim(),
								),
							);
							lines.push(
								`  ${formatUiKeyValue(ui, "rate limit", rateLimit, rateLimit === "none" ? "muted" : "warning")}`,
							);
							lines.push(
								`  ${formatUiKeyValue(ui, "cooldown", cooldown, cooldown === "none" ? "muted" : "warning")}`,
							);
						});

						lines.push("");
						lines.push(...formatUiSection(ui, "Active index by model family"));
						for (const family of MODEL_FAMILIES) {
							const idx = storage.activeIndexByFamily?.[family];
							const familyIndexLabel =
								typeof idx === "number" && Number.isFinite(idx)
									? String(idx + 1)
									: "-";
							lines.push(formatUiItem(ui, `${family}: ${familyIndexLabel}`));
						}

						lines.push("");
						lines.push(
							...formatUiSection(
								ui,
								"Rate limits by model family (per account)",
							),
						);
						storage.accounts.forEach((account, index) => {
							const statuses = MODEL_FAMILIES.map((family) => {
								const resetAt = getRateLimitResetTimeForFamily(
									account,
									now,
									family,
								);
								if (typeof resetAt !== "number") return `${family}=ok`;
								return `${family}=${formatWaitTime(resetAt - now)}`;
							});
							lines.push(
								formatUiItem(
									ui,
									`Account ${index + 1}: ${statuses.join(" | ")}`,
								),
							);
						});

						return lines.join("\n");
					}

					const statusTableOptions: TableOptions = {
						columns: [
							{ header: "#", width: 3 },
							{ header: "Label", width: 42 },
							{ header: "Current", width: 18 },
							{ header: "Rate Limit", width: 48 },
							{ header: "Cooldown", width: 16 },
							{ header: "Last Used", width: 16 },
						],
					};

					const lines: string[] = [
						`Account Status (${storage.accounts.length} total):`,
						"",
						...buildTableHeader(statusTableOptions),
					];

					storage.accounts.forEach((account, index) => {
						const label = formatAccountLabel(account, index);
						const active =
							resolveAccountCurrentMarkers(index, activeIndex, runtimeCurrent)
								.map(currentMarkerLabel)
								.join(", ") || "No";
						const rateLimit =
							formatRateLimitEntry(account, now, formatWaitTime) ?? "None";
						const quotaEntry = findQuotaCacheEntryForAccount(
							quotaCache,
							account,
							storage.accounts,
						);
						const quotaStatuses: string[] = [];
						if (rateLimit === "None" && quotaEntry?.status === 429) {
							quotaStatuses.push("rate-limited");
						}
						if (isQuotaCacheEntryExhausted(quotaEntry, now)) {
							quotaStatuses.push("quota-exhausted");
						}
						const rateLimitDisplay =
							rateLimit !== "None"
								? [rateLimit, ...quotaStatuses].join(", ")
								: quotaStatuses.length > 0
									? quotaStatuses.join(", ")
									: "None";
						const cooldown = formatCooldown(account, now) ?? "No";
						const lastUsed =
							typeof account.lastUsed === "number" && account.lastUsed > 0
								? `${formatWaitTime(now - account.lastUsed)} ago`
								: "-";

						lines.push(
							buildTableRow(
								[
									String(index + 1),
									label,
									active,
									rateLimitDisplay,
									cooldown,
									lastUsed,
								],
								statusTableOptions,
							),
						);
					});

					lines.push("");
					lines.push("Active index by model family:");
					for (const family of MODEL_FAMILIES) {
						const idx = storage.activeIndexByFamily?.[family];
						const familyIndexLabel =
							typeof idx === "number" && Number.isFinite(idx)
								? String(idx + 1)
								: "-";
						lines.push(`  ${family}: ${familyIndexLabel}`);
					}

					lines.push("");
					lines.push("Rate limits by model family (per account):");
					storage.accounts.forEach((account, index) => {
						const statuses = MODEL_FAMILIES.map((family) => {
							const resetAt = getRateLimitResetTimeForFamily(
								account,
								now,
								family,
							);
							if (typeof resetAt !== "number") return `${family}=ok`;
							return `${family}=${formatWaitTime(resetAt - now)}`;
						});
						lines.push(`  Account ${index + 1}: ${statuses.join(" | ")}`);
					});

					return lines.join("\n");
				},
			}),
			...(exposeAdvancedCodexTools
				? {
						"codex-metrics": tool({
							description:
								"Show runtime request metrics for this plugin process.",
							args: {},
							execute() {
								const ui = applyUiRuntimeFromConfig(
									loadPluginConfig(),
									setUiRuntimeOptions,
								);
								const now = Date.now();
								const uptimeMs = Math.max(0, now - runtimeMetrics.startedAt);
								const total = runtimeMetrics.totalRequests;
								const successful = runtimeMetrics.successfulRequests;
								const successRate =
									total > 0 ? ((successful / total) * 100).toFixed(1) : "0.0";
								const avgLatencyMs =
									successful > 0
										? Math.round(
												runtimeMetrics.cumulativeLatencyMs / successful,
											)
										: 0;
								const liveSyncSnapshot = liveAccountSync?.getSnapshot();
								const guardianStats = refreshGuardian?.getStats();
								const sessionAffinityEntries =
									sessionAffinityStore?.size() ?? 0;
								const lastRequest =
									runtimeMetrics.lastRequestAt !== null
										? `${formatWaitTime(now - runtimeMetrics.lastRequestAt)} ago`
										: "never";

								const lines = [
									"Codex Plugin Metrics:",
									"",
									`Uptime: ${formatWaitTime(uptimeMs)}`,
									`Total upstream requests: ${total}`,
									`Successful responses: ${successful}`,
									`Failed responses: ${runtimeMetrics.failedRequests}`,
									`Success rate: ${successRate}%`,
									`Average successful latency: ${avgLatencyMs}ms`,
									`Rate-limited responses: ${runtimeMetrics.rateLimitedResponses}`,
									`Server errors (5xx): ${runtimeMetrics.serverErrors}`,
									`Network errors: ${runtimeMetrics.networkErrors}`,
									`User aborts: ${runtimeMetrics.userAborts}`,
									`Auth refresh failures: ${runtimeMetrics.authRefreshFailures}`,
									`Account rotations: ${runtimeMetrics.accountRotations}`,
									`Same-account retries: ${runtimeMetrics.sameAccountRetries}`,
									`Stream failover attempts: ${runtimeMetrics.streamFailoverAttempts}`,
									`Stream failover recoveries: ${runtimeMetrics.streamFailoverRecoveries}`,
									`Stream failover cross-account recoveries: ${runtimeMetrics.streamFailoverCrossAccountRecoveries}`,
									`Empty-response retries: ${runtimeMetrics.emptyResponseRetries}`,
									`Session affinity entries: ${sessionAffinityEntries}`,
									`Live sync: ${liveSyncSnapshot?.running ? "on" : "off"} (${liveSyncSnapshot?.reloadCount ?? 0} reloads)`,
									`Refresh guardian: ${guardianStats ? "on" : "off"} (${guardianStats?.refreshed ?? 0} refreshed, ${guardianStats?.failed ?? 0} failed)`,
									`Last upstream request: ${lastRequest}`,
								];

								if (runtimeMetrics.lastError) {
									lines.push(`Last error: ${runtimeMetrics.lastError}`);
								}

								if (ui.v2Enabled) {
									const styled: string[] = [
										...formatUiHeader(ui, "Codex plugin metrics"),
										formatUiKeyValue(ui, "Uptime", formatWaitTime(uptimeMs)),
										formatUiKeyValue(
											ui,
											"Total upstream requests",
											String(total),
										),
										formatUiKeyValue(
											ui,
											"Successful responses",
											String(successful),
											"success",
										),
										formatUiKeyValue(
											ui,
											"Failed responses",
											String(runtimeMetrics.failedRequests),
											"danger",
										),
										formatUiKeyValue(
											ui,
											"Success rate",
											`${successRate}%`,
											"accent",
										),
										formatUiKeyValue(
											ui,
											"Average successful latency",
											`${avgLatencyMs}ms`,
										),
										formatUiKeyValue(
											ui,
											"Rate-limited responses",
											String(runtimeMetrics.rateLimitedResponses),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Server errors (5xx)",
											String(runtimeMetrics.serverErrors),
											"danger",
										),
										formatUiKeyValue(
											ui,
											"Network errors",
											String(runtimeMetrics.networkErrors),
											"danger",
										),
										formatUiKeyValue(
											ui,
											"User aborts",
											String(runtimeMetrics.userAborts),
											"muted",
										),
										formatUiKeyValue(
											ui,
											"Auth refresh failures",
											String(runtimeMetrics.authRefreshFailures),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Account rotations",
											String(runtimeMetrics.accountRotations),
											"accent",
										),
										formatUiKeyValue(
											ui,
											"Same-account retries",
											String(runtimeMetrics.sameAccountRetries),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Stream failover attempts",
											String(runtimeMetrics.streamFailoverAttempts),
											"muted",
										),
										formatUiKeyValue(
											ui,
											"Stream failover recoveries",
											String(runtimeMetrics.streamFailoverRecoveries),
											"success",
										),
										formatUiKeyValue(
											ui,
											"Stream failover cross-account recoveries",
											String(
												runtimeMetrics.streamFailoverCrossAccountRecoveries,
											),
											"accent",
										),
										formatUiKeyValue(
											ui,
											"Empty-response retries",
											String(runtimeMetrics.emptyResponseRetries),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Session affinity entries",
											String(sessionAffinityEntries),
											"muted",
										),
										formatUiKeyValue(
											ui,
											"Live sync",
											`${liveSyncSnapshot?.running ? "on" : "off"} (${liveSyncSnapshot?.reloadCount ?? 0} reloads)`,
											liveSyncSnapshot?.running ? "success" : "muted",
										),
										formatUiKeyValue(
											ui,
											"Refresh guardian",
											guardianStats
												? `on (${guardianStats.refreshed} refreshed, ${guardianStats.failed} failed)`
												: "off",
											guardianStats ? "success" : "muted",
										),
										formatUiKeyValue(
											ui,
											"Last upstream request",
											lastRequest,
											"muted",
										),
									];
									if (runtimeMetrics.lastError) {
										styled.push(
											formatUiKeyValue(
												ui,
												"Last error",
												runtimeMetrics.lastError,
												"danger",
											),
										);
									}
									return Promise.resolve(styled.join("\n"));
								}

								return Promise.resolve(lines.join("\n"));
							},
						}),
					}
				: {}),
			"codex-health": tool({
				description:
					"Check health of all Codex accounts by validating refresh tokens.",
				args: {},
				async execute() {
					const ui = applyUiRuntimeFromConfig(
						loadPluginConfig(),
						setUiRuntimeOptions,
					);
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Health check"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex-multi-auth login", "accent"),
							].join("\n");
						}
						return "No Codex accounts configured. Run: codex-multi-auth login";
					}

					const results: string[] = ui.v2Enabled
						? []
						: [`Health Check (${storage.accounts.length} accounts):`, ""];

					let healthyCount = 0;
					let unhealthyCount = 0;

					for (let i = 0; i < storage.accounts.length; i++) {
						const account = storage.accounts[i];
						if (!account) continue;

						const label = formatAccountLabel(account, i);
						try {
							const refreshResult = await withRefreshCredentialRetention(account, () => queuedRefresh(account.refreshToken), () => storage.accounts.includes(account));
							if (refreshResult.type === "success") {
								results.push(
									`  ${getStatusMarker(ui, "ok")} ${label}: Healthy`,
								);
								healthyCount++;
							} else {
								results.push(
									`  ${getStatusMarker(ui, "error")} ${label}: Token refresh failed`,
								);
								unhealthyCount++;
							}
						} catch (error) {
							if (error instanceof PendingAuthLocalError) throw error;
							const errorMsg =
								error instanceof Error ? error.message : String(error);
							results.push(
								`  ${getStatusMarker(ui, "error")} ${label}: Error - ${errorMsg.slice(0, 120)}`,
							);
							unhealthyCount++;
						}
					}

					results.push("");
					results.push(
						`Summary: ${healthyCount} healthy, ${unhealthyCount} unhealthy`,
					);

					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Health check"),
							"",
							...results.map((line) => paintUiText(ui, line, "normal")),
						].join("\n");
					}

					return results.join("\n");
				},
			}),
			...(exposeAdvancedCodexTools
				? {
						"codex-remove": tool({
							description:
								"Remove a Codex account by index (1-based). Use codex-list to list accounts first.",
							args: {
								index: tool.schema
									.number()
									.describe(
										"Account number to remove (1-based, e.g., 1 for first account)",
									),
							},
							async execute({ index }) {
								const ui = applyUiRuntimeFromConfig(
									loadPluginConfig(),
									setUiRuntimeOptions,
								);
								const storage = await loadAccounts();
								if (!storage || storage.accounts.length === 0) {
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Remove account"),
											"",
											formatUiItem(ui, "No accounts configured.", "warning"),
										].join("\n");
									}
									return "No Codex accounts configured. Nothing to remove.";
								}

								const targetIndex = Math.floor((index ?? 0) - 1);
								if (
									!Number.isFinite(targetIndex) ||
									targetIndex < 0 ||
									targetIndex >= storage.accounts.length
								) {
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Remove account"),
											"",
											formatUiItem(
												ui,
												`Invalid account number: ${index}`,
												"danger",
											),
											formatUiKeyValue(
												ui,
												"Valid range",
												`1-${storage.accounts.length}`,
												"muted",
											),
											formatUiItem(
												ui,
												"Use codex-list to list all accounts.",
												"accent",
											),
										].join("\n");
									}
									return `Invalid account number: ${index}\n\nValid range: 1-${storage.accounts.length}\n\nUse codex-list to list all accounts.`;
								}

								const account = storage.accounts[targetIndex];
								if (!account) {
									return `Account ${index} not found.`;
								}

								const label = formatAccountLabel(account, targetIndex);

								storage.accounts.splice(targetIndex, 1);

								if (storage.accounts.length === 0) {
									storage.activeIndex = 0;
									storage.activeIndexByFamily = {};
								} else {
									if (storage.activeIndex >= storage.accounts.length) {
										storage.activeIndex = 0;
									} else if (storage.activeIndex > targetIndex) {
										storage.activeIndex -= 1;
									}

									if (storage.activeIndexByFamily) {
										for (const family of MODEL_FAMILIES) {
											const idx = storage.activeIndexByFamily[family];
											if (typeof idx === "number") {
												if (idx >= storage.accounts.length) {
													storage.activeIndexByFamily[family] = 0;
												} else if (idx > targetIndex) {
													storage.activeIndexByFamily[family] = idx - 1;
												}
											}
										}
									}
								}

								try {
									await saveAccounts(storage);
								} catch (saveError) {
									logWarn("Failed to save account removal", {
										error: String(saveError),
									});
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Remove account"),
											"",
											formatUiItem(
												ui,
												`Removed ${formatAccountLabel(account, targetIndex)} from memory`,
												"warning",
											),
											formatUiItem(
												ui,
												"Failed to persist. Change may be lost on restart.",
												"danger",
											),
										].join("\n");
									}
									return `Removed ${formatAccountLabel(account, targetIndex)} from memory but failed to persist. Changes may be lost on restart.`;
								}

								if (cachedAccountManager) {
									await reloadRuntimeAccountManager<AccountManager>(
										makeReloadAccountManagerDeps(),
									);
								}

								const remaining = storage.accounts.length;
								if (ui.v2Enabled) {
									return [
										...formatUiHeader(ui, "Remove account"),
										"",
										formatUiItem(
											ui,
											`${getStatusMarker(ui, "ok")} Removed: ${label}`,
											"success",
										),
										remaining > 0
											? formatUiKeyValue(
													ui,
													"Remaining accounts",
													String(remaining),
												)
											: formatUiItem(
													ui,
													"No accounts remaining. Run: codex-multi-auth login",
													"warning",
												),
									].join("\n");
								}
								return [
									`Removed: ${label}`,
									"",
									remaining > 0
										? `Remaining accounts: ${remaining}`
										: "No accounts remaining. Run: codex-multi-auth login",
								].join("\n");
							},
						}),

						"codex-refresh": tool({
							description:
								"Manually refresh OAuth tokens for all accounts to verify they're still valid.",
							args: {},
							async execute() {
								const ui = applyUiRuntimeFromConfig(
									loadPluginConfig(),
									setUiRuntimeOptions,
								);
								const storage = await loadAccounts();
								if (!storage || storage.accounts.length === 0) {
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Refresh accounts"),
											"",
											formatUiItem(ui, "No accounts configured.", "warning"),
											formatUiItem(ui, "Run: codex-multi-auth login", "accent"),
										].join("\n");
									}
									return "No Codex accounts configured. Run: codex-multi-auth login";
								}

								const results: string[] = ui.v2Enabled
									? []
									: [`Refreshing ${storage.accounts.length} account(s):`, ""];

								let refreshedCount = 0;
								let failedCount = 0;

								for (let i = 0; i < storage.accounts.length; i++) {
									const account = storage.accounts[i];
									if (!account) continue;
									const label = formatAccountLabel(account, i);

									try {
										const refreshResult = await withRefreshCredentialRetention(account, () => queuedRefresh(account.refreshToken), () => storage.accounts.includes(account));
										if (refreshResult.type === "success") {
											account.refreshToken = refreshResult.refresh;
											account.accessToken = refreshResult.access;
											account.expiresAt = refreshResult.expires;
											results.push(
												`  ${getStatusMarker(ui, "ok")} ${label}: Refreshed`,
											);
											refreshedCount++;
										} else {
											results.push(
												`  ${getStatusMarker(ui, "error")} ${label}: Failed - ${refreshResult.message ?? refreshResult.reason}`,
											);
											failedCount++;
										}
									} catch (error) {
										if (error instanceof PendingAuthLocalError) throw error;
										const errorMsg =
											error instanceof Error ? error.message : String(error);
										results.push(
											`  ${getStatusMarker(ui, "error")} ${label}: Error - ${errorMsg.slice(0, 120)}`,
										);
										failedCount++;
									}
								}

								await saveAccounts(storage);
								if (cachedAccountManager) {
									await reloadRuntimeAccountManager<AccountManager>(
										makeReloadAccountManagerDeps(),
									);
								}
								results.push("");
								results.push(
									`Summary: ${refreshedCount} refreshed, ${failedCount} failed`,
								);
								if (ui.v2Enabled) {
									return [
										...formatUiHeader(ui, "Refresh accounts"),
										"",
										...results.map((line) => paintUiText(ui, line, "normal")),
									].join("\n");
								}
								return results.join("\n");
							},
						}),

						"codex-export": tool({
							description:
								"Export accounts to a JSON file for backup or migration to another machine.",
							args: {
								path: tool.schema
									.string()
									.describe(
										"File path to export to (e.g., ~/codex-backup.json)",
									),
								force: tool.schema
									.boolean()
									.optional()
									.describe("Overwrite existing file (default: true)"),
							},
							async execute({ path: filePath, force }) {
								const ui = applyUiRuntimeFromConfig(
									loadPluginConfig(),
									setUiRuntimeOptions,
								);
								try {
									await exportAccounts(filePath, force ?? true);
									const storage = await loadAccounts();
									const count = storage?.accounts.length ?? 0;
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Export accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "ok")} Exported ${count} account(s)`,
												"success",
											),
											formatUiKeyValue(ui, "Path", filePath, "muted"),
										].join("\n");
									}
									return `Exported ${count} account(s) to: ${filePath}`;
								} catch (error) {
									const msg =
										error instanceof Error ? error.message : String(error);
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Export accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "error")} Export failed`,
												"danger",
											),
											formatUiKeyValue(ui, "Error", msg, "danger"),
										].join("\n");
									}
									return `Export failed: ${msg}`;
								}
							},
						}),

						"codex-import": tool({
							description:
								"Import accounts from a JSON file, merging with existing accounts.",
							args: {
								path: tool.schema
									.string()
									.describe(
										"File path to import from (e.g., ~/codex-backup.json)",
									),
							},
							async execute({ path: filePath }) {
								const ui = applyUiRuntimeFromConfig(
									loadPluginConfig(),
									setUiRuntimeOptions,
								);
								try {
									const result = await importAccounts(filePath);
									invalidateRuntimeAccountManagerCache(
										accountManagerCacheInvalidationDeps,
									);
									const lines = [`Import complete.`, ``];
									if (result.imported > 0) {
										lines.push(`New accounts: ${result.imported}`);
									}
									if (result.skipped > 0) {
										lines.push(`Duplicates skipped: ${result.skipped}`);
									}
									lines.push(`Total accounts: ${result.total}`);
									if (ui.v2Enabled) {
										const styled = [
											...formatUiHeader(ui, "Import accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "ok")} Import complete`,
												"success",
											),
											formatUiKeyValue(ui, "Path", filePath, "muted"),
											formatUiKeyValue(
												ui,
												"New accounts",
												String(result.imported),
												result.imported > 0 ? "success" : "muted",
											),
											formatUiKeyValue(
												ui,
												"Duplicates skipped",
												String(result.skipped),
												result.skipped > 0 ? "warning" : "muted",
											),
											formatUiKeyValue(
												ui,
												"Total accounts",
												String(result.total),
												"accent",
											),
										];
										return styled.join("\n");
									}
									return lines.join("\n");
								} catch (error) {
									const msg =
										error instanceof Error ? error.message : String(error);
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Import accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "error")} Import failed`,
												"danger",
											),
											formatUiKeyValue(ui, "Error", msg, "danger"),
										].join("\n");
									}
									return `Import failed: ${msg}`;
								}
							},
						}),
					}
				: {}),
		},
	};
};

export const OpenAIAuthPlugin = OpenAIOAuthPlugin;

export default OpenAIOAuthPlugin;
