import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getStoragePath } from "../lib/storage.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = "1";

const accountManagerState = vi.hoisted(() => ({
	accounts: [] as Array<Record<string, unknown>>,
	accountSelections: [] as Array<Record<string, unknown> | null>,
	saveToDiskDebouncedCalls: 0,
	disableCurrentWorkspaceCalls: 0,
	rotateToNextWorkspaceCalls: 0,
	setAccountEnabledCalls: [] as Array<{ index: number; enabled: boolean }>,
}));

const recoveryState = vi.hoisted(() => ({
	forceRecoverable: false,
	isRecoverableErrorCalls: 0,
}));

interface WaitUtilsState {
	sleepWithCountdownCalls: number;
}

const waitUtilsState = vi.hoisted<WaitUtilsState>(() => ({
	sleepWithCountdownCalls: 0,
}));

interface RetryConfigState {
	retryAllAccountsRateLimited: boolean;
	retryAllAccountsMaxWaitMs: number;
	retryAllAccountsMaxRetries: number;
}

const retryConfigState = vi.hoisted<RetryConfigState>(() => ({
	retryAllAccountsRateLimited: true,
	retryAllAccountsMaxWaitMs: 5000,
	retryAllAccountsMaxRetries: 1,
}));

function createMockAccount(
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		index: 0,
		accountId: "account-1",
		email: "user@example.com",
		refreshToken: "refresh-token-account-1",
		access: "access-token-account-1",
		expires: Date.now() + 60_000,
		addedAt: Date.now(),
		lastUsed: Date.now(),
		rateLimitResetTimes: {},
		...overrides,
	};
}

function resetAccountManagerState(): void {
	accountManagerState.accounts = [createMockAccount()];
	accountManagerState.accountSelections = [null, accountManagerState.accounts[0] ?? null];
	accountManagerState.saveToDiskDebouncedCalls = 0;
	accountManagerState.disableCurrentWorkspaceCalls = 0;
	accountManagerState.rotateToNextWorkspaceCalls = 0;
	accountManagerState.setAccountEnabledCalls = [];
}

vi.mock("@codex-ai/plugin/tool", () => {
	const makeSchema = () => ({
		optional: () => makeSchema(),
		describe: () => makeSchema(),
	});

	const tool = (definition: any) => definition;
	(tool as any).schema = {
		number: () => makeSchema(),
		boolean: () => makeSchema(),
		string: () => makeSchema(),
	};

	return { tool };
});

vi.mock("../lib/request/fetch-helpers.js", () => ({
	extractRequestUrl: (input: any) => (typeof input === "string" ? input : String(input)),
	rewriteUrlForCodex: (url: string) => url,
	applyProxyCompatibleInit: (_url: string, init: RequestInit) => init,
	transformRequestForCodex: async (init: any) => ({ updatedInit: init, body: { model: "gpt-5.1" } }),
	shouldRefreshToken: vi.fn(() => false),
	refreshAndUpdateToken: vi.fn(async (auth: any) => auth),
	createCodexHeaders: (_requestInit: any, accountId?: string) =>
		new Headers(accountId ? { "x-account-id": accountId } : {}),
	handleErrorResponse: async (response: Response) => {
		const rawBody = await response.clone().text();
		let errorBody: unknown;
		try {
			errorBody = rawBody ? JSON.parse(rawBody) : undefined;
		} catch {
			errorBody = undefined;
		}
		return { response, rateLimit: response.status === 429 ? {retryAfterMs: Number(response.headers.get("retry-after") ?? 60) * 1000} : false, errorBody };
	},
	getUnsupportedCodexModelInfo: () => ({
		isUnsupported: false,
		unsupportedModel: undefined,
	}),
	resolveUnsupportedCodexFallbackModel: () => undefined,
	shouldFallbackToGpt52OnUnsupportedGpt53: () => false,
	handleSuccessResponse: async (response: Response) => response,
	isWorkspaceDisabledError: (status: number, code: string, bodyText: string) =>
		status === 403 &&
		(code.toLowerCase().includes("workspace_disabled") ||
			code.toLowerCase().includes("workspace_expired") ||
			bodyText.toLowerCase().includes("workspace disabled") ||
			bodyText.toLowerCase().includes("workspace expired")),
}));

vi.mock("../lib/request/request-transformer.js", () => ({
	applyFastSessionDefaults: <T>(config: T) => config,
}));

vi.mock("../lib/config.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/config.js")>(
		"../lib/config.js",
	);
	return {
		...actual,
		getRetryAllAccountsRateLimited: () =>
			retryConfigState.retryAllAccountsRateLimited,
		getRetryAllAccountsMaxWaitMs: () =>
			retryConfigState.retryAllAccountsMaxWaitMs,
		getRetryAllAccountsMaxRetries: () =>
			retryConfigState.retryAllAccountsMaxRetries,
		getTokenRefreshSkewMs: () => 0,
		getRateLimitToastDebounceMs: () => 0,
		getPrewarmCodexInstructions: () => false,
	};
});

vi.mock("../lib/request/wait-utils.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/request/wait-utils.js")>(
		"../lib/request/wait-utils.js",
	);
	return {
		...actual,
		createAbortableSleep: () => async () => {
			await Promise.resolve();
		},
		sleepWithCountdown: async () => {
			waitUtilsState.sleepWithCountdownCalls += 1;
			await Promise.resolve();
		},
	};
});

vi.mock("../lib/accounts.js", async () => {
	const tokenUtils = await vi.importActual("../lib/auth/token-utils.js");
	const tokenUtilsModule = tokenUtils as typeof import("../lib/auth/token-utils.js");
	class AccountManager {
		private currentAuthAccount: Record<string, any> | null = null;

		static async loadFromDisk() {
			return new AccountManager();
		}

		resolveSelectionStoragePath() { return getStoragePath(); }

		getAccountCount() {
			return accountManagerState.accounts.length;
		}

		getCurrentOrNextForFamily() {
			if (accountManagerState.accountSelections.length > 0) {
				return accountManagerState.accountSelections.shift() ?? null;
			}
			return accountManagerState.accounts[0] ?? null;
		}

		getCurrentOrNextForFamilyHybrid() {
			return this.getCurrentOrNextForFamily();
		}

		getAccountByIndex(index: number) {
			return (
				accountManagerState.accounts.find(
					(account) => Number(account.index) === index,
				) ?? null
			);
		}

		recordSuccess() {}

		recordRateLimit() {}

		recordFailure() {}

		toAuthDetails(account?: Record<string, any>) {
			const resolvedAccount =
				account ??
				this.currentAuthAccount ??
				accountManagerState.accounts[0] ??
				createMockAccount();
			this.currentAuthAccount = resolvedAccount;
			return {
				type: "oauth",
				access: String(
					resolvedAccount.access ?? `access-token-${resolvedAccount.accountId ?? "account-1"}`,
				),
				refresh: String(
					resolvedAccount.refreshToken ??
						`refresh-token-${resolvedAccount.accountId ?? "account-1"}`,
				),
				expires: Number(resolvedAccount.expires ?? Date.now() + 60_000),
				idToken:
					typeof resolvedAccount.idToken === "string"
						? resolvedAccount.idToken
						: undefined,
			};
		}

	hasRefreshToken(_token: string) {
		return true;
	}

		saveToDiskDebounced() {
			accountManagerState.saveToDiskDebouncedCalls += 1;
		}

		updateFromAuth() {}

		async saveToDisk() {}

		markAccountCoolingDown() {}

		markRateLimited() {}

		markRateLimitedWithReason() {}

		consumeToken() { return true; }

		refundToken() {}

		syncCodexCliActiveSelectionForIndex() {
			return Promise.resolve();
		}

		markSwitched() {}

		getMinWaitTimeForFamily() {
			return 1000;
		}

		shouldShowAccountToast() {
			return false;
		}

		markToastShown() {}

		clearAuthFailures() {}

		incrementAuthFailures(account: Record<string, unknown>) {
			account.consecutiveAuthFailures = Number(account.consecutiveAuthFailures ?? 0) + 1;
			return Number(account.consecutiveAuthFailures);
		}

		removeAccount(account: Record<string, unknown>) {
			accountManagerState.accounts = accountManagerState.accounts.filter(row => row !== account);
		}

		setAccountEnabled(index: number, enabled: boolean) {
			accountManagerState.setAccountEnabledCalls.push({ index, enabled });
			const account = this.getAccountByIndex(index);
			if (account) {
				account.enabled = enabled;
			}
			return account;
		}

		getCurrentWorkspace(account: Record<string, any>) {
			const workspaces = account.workspaces as Array<Record<string, any>> | undefined;
			if (!workspaces || workspaces.length === 0) {
				return null;
			}
			const currentWorkspaceIndex =
				typeof account.currentWorkspaceIndex === "number"
					? account.currentWorkspaceIndex
					: 0;
			return workspaces[currentWorkspaceIndex] ?? null;
		}

		disableCurrentWorkspace(account: Record<string, any>, expectedWorkspaceId?: string) {
			accountManagerState.disableCurrentWorkspaceCalls += 1;
			const workspace = this.getCurrentWorkspace(account);
			if (!workspace) {
				return false;
			}
			if (expectedWorkspaceId && workspace.id !== expectedWorkspaceId) {
				return false;
			}
			if (workspace.enabled === false) {
				return false;
			}
			workspace.enabled = false;
			workspace.disabledAt = 123;
			return true;
		}

		rotateToNextWorkspace(account: Record<string, any>) {
			accountManagerState.rotateToNextWorkspaceCalls += 1;
			const workspaces = account.workspaces as Array<Record<string, any>> | undefined;
			if (!workspaces || workspaces.length === 0) {
				return null;
			}
			const currentWorkspaceIndex =
				typeof account.currentWorkspaceIndex === "number"
					? account.currentWorkspaceIndex
					: 0;
			for (let offset = 1; offset < workspaces.length; offset += 1) {
				const nextIndex = (currentWorkspaceIndex + offset) % workspaces.length;
				const workspace = workspaces[nextIndex];
				if (workspace && workspace.enabled !== false) {
					account.currentWorkspaceIndex = nextIndex;
					return workspace;
				}
			}
			return null;
		}

		hasEnabledWorkspaces(account: Record<string, any>) {
			const workspaces = account.workspaces as Array<Record<string, any>> | undefined;
			if (!workspaces || workspaces.length === 0) {
				return true;
			}
			return workspaces.some((workspace) => workspace.enabled !== false);
		}
	}

	return {
		AccountManager,
		extractAccountEmail: (accessToken?: string) => {
			if (!accessToken) {
				return "user@example.com";
			}
			const match = /account-(\d+)/.exec(accessToken);
			return match ? `user${match[1]}@example.com` : "user@example.com";
		},
		extractAccountId: (accessToken?: string) => {
			const match = accessToken ? /account-\d+/.exec(accessToken) : null;
			return match?.[0] ?? "account-1";
		},
		selectBestAccountCandidate: (candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
		resolveRuntimeRequestIdentity: ({
			storedAccountId,
			source,
			storedEmail,
			accessToken,
			idToken,
		}: {
			storedAccountId?: string;
			source?: string;
			storedEmail?: string;
			accessToken?: string;
			idToken?: string;
		}) => {
			const tokenAccountId = accessToken
				? tokenUtilsModule.extractAccountId(accessToken)
				: undefined;
			const tokenEmail = tokenUtilsModule.sanitizeEmail(
				tokenUtilsModule.extractAccountEmail(accessToken, idToken),
			);
			const sanitizedStoredEmail = tokenUtilsModule.sanitizeEmail(storedEmail);
			return {
				accountId: tokenUtilsModule.resolveRequestAccountId(
					storedAccountId,
					source as never,
					tokenAccountId,
				),
				email: tokenEmail ?? sanitizedStoredEmail,
				tokenAccountId,
			};
		},
		resolveRequestAccountId: (
			tokenUtilsModule
		).resolveRequestAccountId,
		formatAccountLabel: (_account: any, index: number) => `Account ${index + 1}`,
		formatCooldown: (ms: number) => `${ms}ms`,
		formatWaitTime: (ms: number) => `${ms}ms`,
		sanitizeEmail: (email: string) => email,
		parseRateLimitReason: () => "unknown",
		lookupCodexCliTokensByEmail: vi.fn(async () => null),
		isCodexCliSyncEnabled: () => true,
	};
});

// Shared module-shape builder (test/helpers/cli-test-fixtures.ts): actual
// storage module spread plus this suite's bespoke stubs. Resolved lazily so
// vi.mock hoisting stays safe.
vi.mock("../lib/storage.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).storageModuleMock({
		getStoragePath: () => "",
		loadAccounts: async () => null,
		saveAccounts: async () => {},
		withAccountStorageTransaction: async <T>(
			handler: (
				loadedStorage: null,
				persist: (storage: unknown) => Promise<void>,
			) => Promise<T>,
		): Promise<T> => handler(null, async (_storage: unknown) => {}),
		setStoragePath: () => {},
		setStorageBackupEnabled: () => {},
		exportAccounts: async () => {},
		importAccounts: async () => ({ imported: 0, total: 0 }),
	}),
);

vi.mock("../lib/recovery.js", () => ({
	createSessionRecoveryHook: () => null,
	isRecoverableError: () => {
		recoveryState.isRecoverableErrorCalls += 1;
		return recoveryState.forceRecoverable;
	},
	detectErrorType: () => "tool_use_failed",
	getRecoveryToastContent: () => ({
		title: "Recoverable error",
		message: "retry",
	}),
}));

vi.mock("../lib/update-notice.js", () => ({
	checkAndNotify: async () => {},
	checkForUpdates: async () => ({ hasUpdate: false, currentVersion: "4.5.0", latestVersion: null, updateCommand: "" }),
	clearUpdateCache: () => {},
}));

describe("OpenAIAuthPlugin rate-limit retry", () => {
	const envKeys = [
		"CODEX_AUTH_FAILOVER_MODE",
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		"CODEX_AUTH_PREWARM",
	] as const;

	const originalEnv: Record<string, string | undefined> = {};
	let originalFetch: any;

	beforeEach(() => {
		resetAccountManagerState();
		recoveryState.forceRecoverable = false;
		recoveryState.isRecoverableErrorCalls = 0;
		waitUtilsState.sleepWithCountdownCalls = 0;
		retryConfigState.retryAllAccountsRateLimited = true;
		retryConfigState.retryAllAccountsMaxWaitMs = 5000;
		retryConfigState.retryAllAccountsMaxRetries = 1;
		vi.resetModules();

		for (const key of envKeys) originalEnv[key] = process.env[key];

		process.env.CODEX_AUTH_FAILOVER_MODE = "balanced";
		process.env.CODEX_AUTH_RETRY_ALL_RATE_LIMITED = "1";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS = "5000";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "1";
		process.env.CODEX_AUTH_TOKEN_REFRESH_SKEW_MS = "0";
		process.env.CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS = "0";
		process.env.CODEX_AUTH_PREWARM = "0";

		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as any;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.fetch = originalFetch;

		for (const key of envKeys) {
			const value = originalEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}

		vi.restoreAllMocks();
	});

	it("retains actual post-spend settlement failure without authentication removal or another OAuth spend", async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-settlement-"));
		const path = join(dir, "accounts.json");
		const account = createMockAccount({recordId: "record-A", expires: 1, enabled: true, consecutiveAuthFailures: 2});
		accountManagerState.accounts = [account];
		accountManagerState.accountSelections = [account];
		const {AccountManager} = await import("../lib/accounts.js");
		vi.spyOn(AccountManager.prototype, "resolveSelectionStoragePath").mockReturnValue(path);
		const helpers = await import("../lib/request/fetch-helpers.js");
		const realRefresh = await import("../lib/request/token-refresh.js");
		vi.mocked(helpers.shouldRefreshToken).mockImplementation(() => true);
		vi.mocked(helpers.refreshAndUpdateToken).mockImplementation(realRefresh.refreshAndUpdateToken);
		const {getPendingAuthPath, PendingAuthSettlementError} = await import("../lib/storage/pending-auth.js");
		const {getRefreshQueue, resetRefreshQueue} = await import("../lib/refresh-queue.js");
		const {RefreshLeaseCoordinator} = await import("../lib/refresh-lease.js");
		vi.spyOn(RefreshLeaseCoordinator.prototype, "acquire").mockResolvedValue({role: "leader", release: async () => undefined});
		await fs.writeFile(path, JSON.stringify({version: 3, activeIndex: 0, accounts: [{
			recordId: "record-A", accountId: account.accountId, refreshToken: account.refreshToken, accessToken: account.access, expiresAt: 1, enabled: true, addedAt: 1, lastUsed: 1,
		}]}));
		const cause = Object.assign(Error("fixture settlement failed"), {code: "ENOSPC"});
		const rename = fs.rename.bind(fs);
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === getPendingAuthPath(path)) throw cause;
			return rename(from, to);
		});
		const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			expect(String(input)).toBe("https://auth.openai.com/oauth/token");
			expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh-token-account-1");
			return Response.json({access_token: "fixture-new-access", refresh_token: "fixture-new-refresh", expires_in: 3600});
		});
		globalThis.fetch = fetch;
		const client = {tui: {showToast: vi.fn()}, auth: {set: vi.fn()}};
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "access-token-account-1", refresh: "refresh-token-account-1", expires: 1, multiAccount: true}), {options: {}, models: {}});
			const error = await sdk.fetch!("https://example.com", {}).catch(value => value);
			expect(error).toBeInstanceOf(PendingAuthSettlementError);
			expect(error.cause).toBe(cause);
			expect(account).toMatchObject({access: "fixture-new-access", refreshToken: "fixture-new-refresh", consecutiveAuthFailures: 2, enabled: true});
			expect(accountManagerState.accounts).toEqual([account]);
			expect(client.auth.set).not.toHaveBeenCalled();
			expect(accountManagerState.setAccountEnabledCalls).toEqual([]);
			await expect(getRefreshQueue().refresh("refresh-token-account-1", path)).rejects.toBe(error);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(helpers.shouldRefreshToken).mockImplementation(() => false);
			vi.mocked(helpers.refreshAndUpdateToken).mockImplementation(async auth => auth);
			resetRefreshQueue();
			await removeWithRetry(dir, {recursive: true, force: true});
		}
	});

	it("waits and retries when all accounts are rate-limited", async () => {
		vi.useRealTimers();
		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;

		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;

		const fetchPromise = sdk.fetch("https://example.com", {});
		expect(globalThis.fetch).not.toHaveBeenCalled();

		const response = await fetchPromise;
		expect(waitUtilsState.sleepWithCountdownCalls).toBe(1);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
	}, 30_000);

	it("does not replay across all accounts by default when every account is rate-limited", async () => {
		vi.useRealTimers();
		retryConfigState.retryAllAccountsRateLimited = false;
		retryConfigState.retryAllAccountsMaxWaitMs = 0;
		retryConfigState.retryAllAccountsMaxRetries = 0;
		vi.resetModules();
		const secondaryAccount = createMockAccount({
			index: 1,
			accountId: "account-2",
			email: "user2@example.com",
			refreshToken: "refresh-token-account-2",
			access: "access-token-account-2",
		});
		accountManagerState.accounts = [createMockAccount(), secondaryAccount];
		accountManagerState.accountSelections = [null];

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});
		const payload = await response.json();

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(response.status).toBe(429);
		expect(payload.error.message).toContain("All 2 account(s) are rate-limited.");
		expect(payload.error.message).toContain("15000ms");
	}, 30_000);

	it("fast-fails after repeated cross-account 5xx errors arm the server-burst cooldown", async () => {
		vi.useRealTimers();
		const accounts = Array.from({ length: 4 }, (_, index) =>
			createMockAccount({
				index,
				accountId: `account-${index + 1}`,
				email: `user${index + 1}@example.com`,
				refreshToken: `refresh-token-${index + 1}`,
				access: `access-token-account-${index + 1}`,
			}),
		);
		accountManagerState.accounts = accounts;
		accountManagerState.accountSelections = [...accounts];

		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						error: { code: "server_error", message: "temporary outage" },
					}),
					{
						status: 503,
						headers: { "content-type": "application/json" },
					},
				),
			),
		);
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const { clearPoolExhaustionCooldown } = await import(
			"../lib/request/request-resilience.js"
		);

		for (let index = 0; index < 3; index += 1) {
			accountManagerState.accounts = [accounts[index] as Record<string, unknown>];
			accountManagerState.accountSelections = [accounts[index] as Record<string, unknown>];
			const fetchPromise = sdk.fetch("https://example.com", {});
			await Promise.resolve();
			const response = await fetchPromise;
			expect(response.status).toBe(503);
			clearPoolExhaustionCooldown();
		}

		expect(fetchMock).toHaveBeenCalledTimes(3);

		accountManagerState.accounts = [accounts[3] as Record<string, unknown>];
		accountManagerState.accountSelections = [accounts[3] as Record<string, unknown>];
		const secondResponse = await sdk.fetch("https://example.com", {});
		const secondPayload = await secondResponse.json();
		expect(secondResponse.status).toBe(503);
		expect(secondPayload.error.message).toContain(
			"Multiple accounts recently failed with upstream server errors.",
		);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	}, 30_000);

	it("stops after the bounded outbound request budget even when more accounts are available", async () => {
		const logger = await import("../lib/logger.js");
		const logDebugSpy = vi.spyOn(logger, "logDebug").mockImplementation(() => {});
		const logWarnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

		const accounts = Array.from({ length: 8 }, (_, index) =>
			createMockAccount({
				index,
				accountId: `account-${index + 1}`,
				email: `user${index + 1}@example.com`,
				refreshToken: `refresh-token-${index + 1}`,
				access: `access-token-account-${index + 1}`,
			}),
		);
		accountManagerState.accounts = accounts;
		accountManagerState.accountSelections = [...accounts];

		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						error: { code: "rate_limit_exceeded", message: "fixture quota refused" },
					}),
					{
						status: 429,
						headers: { "content-type": "application/json", "retry-after": "120" },
					},
				),
			),
		);
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});
		const payload = await response.json();

		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(response.status).toBe(503);
		expect(payload).toEqual({
			error: {
				message:
					"Request attempt budget exhausted after 6 outbound request(s). Try again after the current retries settle.",
			},
		});
		expect(logDebugSpy).toHaveBeenCalledWith(
			"Configured outbound request attempt budget.",
			expect.objectContaining({
				budget: 6,
				accountCount: 8,
				maxSameAccountRetries: 1,
				emptyResponseMaxRetries: 2,
				streamFailoverMax: 1,
			}),
		);
		expect(logWarnSpy).toHaveBeenCalledWith(
			"Request attempt budget exhausted.",
			expect.objectContaining({
				reason: "primary",
				accountIndex: 6,
				budget: 6,
				consumed: 6,
			}),
		);
	});

	it("does not replay an accepted empty response into another account or server error", async () => {
		const logger = await import("../lib/logger.js");
		const logWarnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

		const accounts = Array.from({ length: 6 }, (_, index) =>
			createMockAccount({
				index,
				accountId: `account-${index + 1}`,
				email: `user${index + 1}@example.com`,
				refreshToken: `refresh-token-${index + 1}`,
				access: `access-token-account-${index + 1}`,
			}),
		);
		accountManagerState.accounts = accounts;
		accountManagerState.accountSelections = [...accounts];

		const serverErrorResponse = () =>
			new Response(
				JSON.stringify({
					error: { code: "server_error", message: "temporary outage" },
				}),
				{
					status: 500,
					headers: { "content-type": "application/json" },
				},
			);

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(serverErrorResponse())
			.mockResolvedValueOnce(serverErrorResponse())
			.mockResolvedValueOnce(serverErrorResponse())
			.mockResolvedValueOnce(serverErrorResponse())
			.mockResolvedValueOnce(serverErrorResponse());
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});
		const payload = await response.json();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			fetchMock.mock.calls.map(
				(call) => (call[1]?.headers as Headers).get("x-account-id"),
			),
		).toEqual(["account-1"]);
		expect(response.status).toBe(200);
		expect(payload).toEqual({});
		expect(logWarnSpy).not.toHaveBeenCalledWith(
			"Empty response received (attempt 1/2). Retrying...",
		);
		expect(logWarnSpy).not.toHaveBeenCalledWith(
			"Request attempt budget exhausted.",
			expect.anything(),
		);
	});

	it("rebuilds request headers after rotating to the next workspace", async () => {
		const account = createMockAccount({
			workspaces: [
				{ id: "workspace-1", name: "Workspace 1", enabled: true },
				{ id: "workspace-2", name: "Workspace 2", enabled: true },
			],
			currentWorkspaceIndex: 0,
		});
		accountManagerState.accounts = [account];
		accountManagerState.accountSelections = [account, account];

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "workspace_disabled",
							message: "Workspace expired",
						},
					}),
					{
						status: 403,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(1);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(1);
		expect(accountManagerState.saveToDiskDebouncedCalls).toBeGreaterThanOrEqual(1);
		expect((account.workspaces as Array<Record<string, unknown>>)[0]?.enabled).toBe(false);

		const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
		const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
		expect(firstHeaders.get("x-account-id")).toBe("workspace-1");
		expect(secondHeaders.get("x-account-id")).toBe("workspace-2");
	});

	it("disables an exhausted workspace account and retries with another enabled account", async () => {
		const exhaustedAccount = createMockAccount({
			index: 0,
			accountId: "account-1",
			workspaces: [
				{ id: "workspace-1", name: "Workspace 1", enabled: true },
			],
			currentWorkspaceIndex: 0,
		});
		const fallbackAccount = createMockAccount({
			index: 1,
			accountId: "account-2",
			email: "fallback@example.com",
			refreshToken: "refresh-token-2",
		});
		accountManagerState.accounts = [exhaustedAccount, fallbackAccount];
		accountManagerState.accountSelections = [exhaustedAccount, fallbackAccount];

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "workspace_disabled",
							message: "Workspace expired",
						},
					}),
					{
						status: 403,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(1);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(1);
		expect(accountManagerState.setAccountEnabledCalls).toContainEqual({
			index: 0,
			enabled: false,
		});
		expect(accountManagerState.saveToDiskDebouncedCalls).toBeGreaterThanOrEqual(1);
		expect(exhaustedAccount.enabled).toBe(false);

		const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
		const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
		expect(firstHeaders.get("x-account-id")).toBe("workspace-1");
		expect(secondHeaders.get("x-account-id")).toBe("account-2");
	});

	it("does not disable workspace-less accounts on workspace-disabled responses", async () => {
		const account = createMockAccount({
			workspaces: undefined,
			currentWorkspaceIndex: undefined,
		});
		accountManagerState.accounts = [account];
		accountManagerState.accountSelections = [account];

		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "workspace_disabled",
						message: "Workspace expired",
					},
				}),
				{
					status: 403,
					headers: { "content-type": "application/json" },
				},
			),
		) as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(403);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(0);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(0);
		expect(accountManagerState.setAccountEnabledCalls).toEqual([]);
		expect(recoveryState.isRecoverableErrorCalls).toBe(0);
	});

	it("retries with a fallback account after a workspace-less account gets a workspace-disabled response", async () => {
		const firstAccount = createMockAccount({
			index: 0,
			accountId: "account-1",
			workspaces: undefined,
			currentWorkspaceIndex: undefined,
		});
		const secondAccount = createMockAccount({
			index: 1,
			accountId: "account-2",
			email: "fallback@example.com",
			refreshToken: "refresh-token-2",
			workspaces: undefined,
			currentWorkspaceIndex: undefined,
		});
		accountManagerState.accounts = [firstAccount, secondAccount];
		accountManagerState.accountSelections = [firstAccount, secondAccount];

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "workspace_disabled",
							message: "Workspace expired",
						},
					}),
					{
						status: 403,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(0);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(0);
		expect(accountManagerState.setAccountEnabledCalls).toEqual([]);
	});
});

