import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getStoragePath } from "../lib/storage.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { CircuitBreaker, type CircuitAdmissionReceipt } from "../lib/circuit-breaker.js";

process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = "1";

const accountManagerState = vi.hoisted(() => ({
	accounts: [] as Array<Record<string, unknown>>,
	accountSelections: [] as Array<Record<string, unknown> | null>,
	saveToDiskDebouncedCalls: 0,
	durableRestrictionCommits: 0,
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
	accountManagerState.durableRestrictionCommits = 0;
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

		async withCurrentAccountCredential(_account: unknown, _submitted: unknown, mutate: () => boolean | void, persist = true) {
			const applied = mutate() !== false;
			if (applied && persist) accountManagerState.durableRestrictionCommits++;
			return applied;
		}

		captureRefreshHealth() {return () => true;}
		getAccountsSnapshot() {return accountManagerState.accounts;}
		getManagedAccountRuntimeSkipReason() {return null;}
		recordSuccess() { return true; }

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

		consumeToken(_account?: unknown, _family?: unknown, _model?: unknown, options?: {onAdmission?: (receipt: CircuitAdmissionReceipt) => void}) { return new CircuitBreaker().tryCanExecute(options?.onAdmission).ok; }

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

		disableWorkspace(account: Record<string, any>, expectedWorkspaceId: string) {
			accountManagerState.disableCurrentWorkspaceCalls += 1;
			const workspace = account.workspaces?.find((item: {id: string}) => item.id === expectedWorkspaceId);
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

	it("keeps a delayed W1 rejection from disabling the recovered W2", async () => {
		const hooks = new Map(["SIGINT", "SIGTERM", "beforeExit"].map(event => [event, new Set(process.listeners(event))]));
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-workspace-outcome-")), path = join(dir, "accounts.json");
		const storage: import("../lib/storage.js").AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "workspace-outcome", accountId: "W1", refreshToken: "refresh-workspace", accessToken: "access-workspace", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, currentWorkspaceIndex: 0, workspaces: [{id: "W1", enabled: true}, {id: "W2", enabled: true}]}]};
		await fs.writeFile(path, JSON.stringify(storage));
		const storageModule = await import("../lib/storage.js"), realStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		for (const method of ["getStoragePath", "loadAccounts", "saveAccounts", "withAccountStorageTransaction"] as const) vi.spyOn(storageModule, method).mockImplementation(realStorage[method] as never);
		const realAccounts = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js"); realStorage.setStoragePathDirect(path);
		const manager = new realAccounts.AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
		const {AccountManager} = await import("../lib/accounts.js"); vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager as never);
		let releaseFirst!: () => void, releaseSecond!: () => void;
		const firstGate = new Promise<void>(done => {releaseFirst = done;}), secondGate = new Promise<void>(done => {releaseSecond = done;});
		const submitted: string[] = [];
		globalThis.fetch = vi.fn(async (_input, init) => {
			const workspace = new Headers(init?.headers).get("x-account-id")!; submitted.push(workspace);
			if (workspace === "W1") {await (submitted.length === 1 ? firstGate : secondGate); return Response.json({error: {code: "workspace_disabled"}}, {status: 403});}
			return Response.json({id: "recovered-W2", output: []});
		});
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client: {tui: {showToast: vi.fn()}, auth: {set: vi.fn()}}} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "access-workspace", refresh: "refresh-workspace", expires: Date.now() + 3600000, multiAccount: true}), {options: {}, models: {}});
			const first = sdk.fetch!("https://example.com", {}), second = sdk.fetch!("https://example.com", {});
			await vi.waitFor(() => expect(submitted).toEqual(["W1", "W1"])); releaseFirst();
			expect((await first).status).toBe(200);
			const afterRecovery = structuredClone(account.workspaces);
			releaseSecond(); expect((await second).status).toBe(403);
			expect(submitted).toEqual(["W1", "W1", "W2"]);
			expect(account.workspaces).toEqual(afterRecovery); expect(account.enabled).not.toBe(false);
			expect(account.workspaces).toEqual([expect.objectContaining({id: "W1", enabled: false}), {id: "W2", enabled: true}]);
			expect((await realStorage.loadAccounts())?.accounts[0]?.workspaces).toEqual(account.workspaces);
		} finally {
			releaseFirst(); releaseSecond(); await (await import("../lib/shutdown.js")).runCleanup();
			for (const [event, previous] of hooks) for (const listener of process.listeners(event)) if (!previous.has(listener)) process.removeListener(event, listener);
			await manager.flushPendingSave(); realStorage.setStoragePathDirect(null); await removeWithRetry(dir, {recursive: true, force: true});
		}
	});

	it.each(["primary", "journal"].flatMap(change => ["network", 401, 403, 429, 503].map(status => ({change, status}))))("preserves the original plugin rejection when local settlement cannot observe authority (%j)", async ({change, status}) => {
		const stream = false;
		const hooks = new Map(["SIGINT", "SIGTERM", "beforeExit"].map(event => [event, new Set(process.listeners(event))]));
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-outcome-")), path = join(dir, "accounts.json");
		const storage: import("../lib/storage.js").AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: `outcome-${stream}-${change}`, accountId: "W1", refreshToken: "refresh-outcome", accessToken: "access-outcome", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, workspaces: [{id: "W1", enabled: true}]}]};
		await fs.writeFile(path, JSON.stringify(storage));
		const storageModule = await import("../lib/storage.js"), realStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		for (const method of ["getStoragePath", "loadAccounts", "saveAccounts", "withAccountStorageTransaction"] as const) vi.spyOn(storageModule, method).mockImplementation(realStorage[method] as never);
		const realAccounts = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js");
		realStorage.setStoragePathDirect(path);
		const manager = new realAccounts.AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
		const {AccountManager} = await import("../lib/accounts.js");
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager as never);
		const helpers = await import("../lib/request/fetch-helpers.js"), actualHelpers = await vi.importActual<typeof import("../lib/request/fetch-helpers.js")>("../lib/request/fetch-helpers.js");
		vi.spyOn(helpers, "handleSuccessResponse").mockImplementation(actualHelpers.handleSuccessResponse);
		vi.spyOn(helpers, "createCodexHeaders").mockImplementation(actualHelpers.createCodexHeaders);
		const {getPendingAuthPath} = await import("../lib/storage/pending-auth.js");
		const {readUsageLedgerRows} = await import("../lib/usage/index.js");
		const {getCircuitBreaker} = await import("../lib/circuit-breaker.js");
		const before = new Set((await readUsageLedgerRows()).map(row => row.id));
		const logger = await import("../lib/logger.js");
		const logWarnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
		const client = {tui: {showToast: vi.fn()}, auth: {set: vi.fn()}};

		const first = new Error("original fixture network outcome");
		const payload = JSON.stringify({error: {code: status === 403 ? "workspace_disabled" : "fixture_rejection", message: "original fixture rejection"}, usage: {input_tokens: 7, output_tokens: 3}});
		const upstream = new Response(payload, {status: typeof status === "number" ? status : 503});
		const fetch = vi.fn(async () => {
			account.consecutiveAuthFailures = 2;
			await fs.writeFile(change === "journal" ? getPendingAuthPath(path) : path, "{");
			if (status === "network") throw first;
			return upstream;
		});
		globalThis.fetch = fetch;
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "access-outcome", refresh: "refresh-outcome", expires: Date.now() + 3600000, multiAccount: true}), {options: {}, models: {}});
			if (status === "network") await expect(sdk.fetch!("https://example.com", {body: JSON.stringify({model: "gpt-5.1", stream})})).rejects.toBe(first);
			else {
				const response = await sdk.fetch!("https://example.com", {body: JSON.stringify({model: "gpt-5.1", stream})});
				expect(response.status).toBe(status); expect(await response.text()).toBe(payload);
			}
			expect(fetch).toHaveBeenCalledOnce(); expect(account.consecutiveAuthFailures).toBe(2);
			expect(logWarnSpy).toHaveBeenCalledWith("Submitted outcome restriction authority could not be observed", expect.objectContaining({error: expect.any(Error)}));
			await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
			expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))[0]).toMatchObject({outcome: "failure", account: {index: 0}});
		} finally {
			if (change === "journal") await fs.unlink(getPendingAuthPath(path));
			else await fs.writeFile(path, JSON.stringify(storage));
			await (await import("../lib/shutdown.js")).runCleanup();
			for (const [event, previous] of hooks) for (const listener of process.listeners(event)) if (!previous.has(listener)) process.removeListener(event, listener);
			await manager.flushPendingSave(); realStorage.setStoragePathDirect(null); await removeWithRetry(dir, {recursive: true, force: true});
		}
	});

	it.each(["healthy", "delete", "disable", "revoke", "expiry", "replacement", "journal"])("checks plugin actual-send authority after the awaited account toast (%s)", async change => {
		const stream = true;
		const hooks = new Map(["SIGINT", "SIGTERM", "beforeExit"].map(event => [event, new Set(process.listeners(event))]));
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-outcome-")), path = join(dir, "accounts.json");
		const storage: import("../lib/storage.js").AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: `outcome-${stream}-${change}`, accountId: "W1", refreshToken: "refresh-outcome", accessToken: "access-outcome", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
		storage.accounts.push({...storage.accounts[0]!, recordId: "standby", accountId: "W2", refreshToken: "standby-refresh", accessToken: "standby-access", enabled: false});
		await fs.writeFile(path, JSON.stringify(storage));
		const storageModule = await import("../lib/storage.js"), realStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		for (const method of ["getStoragePath", "loadAccounts", "saveAccounts", "withAccountStorageTransaction"] as const) vi.spyOn(storageModule, method).mockImplementation(realStorage[method] as never);
		const realAccounts = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js");
		realStorage.setStoragePathDirect(path);
		const manager = new realAccounts.AccountManager(undefined, storage), account = manager.getAccountByIndex(0)!;
		const {AccountManager} = await import("../lib/accounts.js");
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager as never);
		const helpers = await import("../lib/request/fetch-helpers.js"), actualHelpers = await vi.importActual<typeof import("../lib/request/fetch-helpers.js")>("../lib/request/fetch-helpers.js");
		vi.spyOn(helpers, "handleSuccessResponse").mockImplementation(actualHelpers.handleSuccessResponse);
		vi.spyOn(helpers, "createCodexHeaders").mockImplementation(actualHelpers.createCodexHeaders);
		const {getPendingAuthPath} = await import("../lib/storage/pending-auth.js");
		const {readUsageLedgerRows} = await import("../lib/usage/index.js");
		const {getCircuitBreaker} = await import("../lib/circuit-breaker.js");
		const before = new Set((await readUsageLedgerRows()).map(row => row.id));
		const logger = await import("../lib/logger.js");
		const logWarnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
		const client = {tui: {showToast: vi.fn()}, auth: {set: vi.fn()}};

		vi.spyOn(manager, "shouldShowAccountToast").mockReturnValue(true);
		const toast = await import("../lib/runtime/toast.js");
		let changed = false;
		vi.spyOn(toast, "showRuntimeToast").mockImplementation(async (_client, message) => {
			if (!message.startsWith("Using ") || changed) return;
			changed = true;
			const disk = structuredClone(storage), row = disk.accounts[0]!;
			if (change === "delete") disk.accounts.shift();
			if (change === "disable") row.enabled = false;
			if (change === "revoke") row.authInvalidatedAt = Date.now();
			if (change === "expiry") vi.spyOn(Date, "now").mockReturnValue(row.expiresAt! + 1);
			if (change === "replacement") row.accessToken = "replacement-access";
			if (change === "journal") await fs.writeFile(getPendingAuthPath(path), "{");
			await fs.writeFile(path, JSON.stringify(disk));
		});
		const fetch = vi.fn(async () => new Response('data: {"type":"response.completed","response":{"id":"original-accepted","status":"completed","output":[]}}\\n\\n', {headers: {"Content-Type": "text/event-stream"}}));
		globalThis.fetch = fetch;
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "access-outcome", refresh: "refresh-outcome", expires: Date.now() + 3600000, multiAccount: true}), {options: {}, models: {}});
			if (change === "healthy") expect(await (await sdk.fetch!("https://example.com", {body: JSON.stringify({model: "gpt-5.1", stream})})).text()).toContain("original-accepted");
			else await expect(sdk.fetch!("https://example.com", {body: JSON.stringify({model: "gpt-5.1", stream})})).rejects.toThrow();
			expect(changed).toBe(true); expect(fetch).toHaveBeenCalledTimes(change === "healthy" ? 1 : 0);
		} finally {
			if (change === "journal") await fs.unlink(getPendingAuthPath(path));
			await fs.writeFile(path, JSON.stringify(storage));
			await (await import("../lib/shutdown.js")).runCleanup();
			for (const [event, previous] of hooks) for (const listener of process.listeners(event)) if (!previous.has(listener)) process.removeListener(event, listener);
			await manager.flushPendingSave(); realStorage.setStoragePathDirect(null); await removeWithRetry(dir, {recursive: true, force: true});
		}
	});

	it.each([false, true])("bills the immutable submitted index after concurrent earlier-account removal (fallback=%s)", async fallback => {
		const stream = true;
		const hooks = new Map(["SIGINT", "SIGTERM", "beforeExit"].map(event => [event, new Set(process.listeners(event))]));
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-outcome-")), path = join(dir, "accounts.json");
		const storage: import("../lib/storage.js").AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: `outcome-${stream}-reindex`, accountId: "W1", refreshToken: "refresh-outcome", accessToken: "access-outcome", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
		if (fallback) storage.accounts.push({...storage.accounts[0]!, recordId: `fallback-${stream}-reindex`, accountId: "W2", refreshToken: "refresh-outcome-fallback", accessToken: "access-outcome-fallback"});
		storage.accounts.unshift({...storage.accounts[0]!, recordId: "removed-before-completion", accountId: "removed-workspace", accessToken: "removed-access", refreshToken: "removed-refresh", enabled: false});
		await fs.writeFile(path, JSON.stringify(storage));
		const storageModule = await import("../lib/storage.js"), realStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		for (const method of ["getStoragePath", "loadAccounts", "saveAccounts", "withAccountStorageTransaction"] as const) vi.spyOn(storageModule, method).mockImplementation(realStorage[method] as never);
		const realAccounts = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js");
		realStorage.setStoragePathDirect(path);
		const manager = new realAccounts.AccountManager(undefined, storage), account = manager.getAccountByIndex(fallback ? 2 : 1)!;
		const {AccountManager} = await import("../lib/accounts.js");
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager as never);
		const helpers = await import("../lib/request/fetch-helpers.js"), actualHelpers = await vi.importActual<typeof import("../lib/request/fetch-helpers.js")>("../lib/request/fetch-helpers.js");
		vi.spyOn(helpers, "handleSuccessResponse").mockImplementation(actualHelpers.handleSuccessResponse);
		vi.spyOn(helpers, "createCodexHeaders").mockImplementation(actualHelpers.createCodexHeaders);
		const {readUsageLedgerRows} = await import("../lib/usage/index.js");
		const before = new Set((await readUsageLedgerRows()).map(row => row.id));
		const client = {tui: {showToast: vi.fn()}, auth: {set: vi.fn()}};
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const bearer = new Headers(init?.headers).get("authorization");
			if (fallback && bearer === "Bearer access-outcome") return new Response("safe explicit rejection", {status: 429, headers: {"Retry-After": "60"}});
			expect(bearer).toBe(fallback ? "Bearer access-outcome-fallback" : "Bearer access-outcome");
			account.consecutiveAuthFailures = 2;
			expect(manager.removeAccount(manager.getAccountByIndex(0)!)).toBe(true); await manager.saveToDisk();
			const type = "response.completed";
			return new Response(`data: ${JSON.stringify({type, response: {id: "accepted-original", status: "completed", output: [], usage: {input_tokens: 7, output_tokens: 3, total_tokens: 10}}})}\n\n`, {headers: {"Content-Type": "text/event-stream"}});
		});
		globalThis.fetch = fetch;
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "access-outcome", refresh: "refresh-outcome", expires: Date.now() + 3600000, multiAccount: true}), {options: {}, models: {}});
			const response = await sdk.fetch!("https://example.com", {body: JSON.stringify({model: "gpt-5.1", stream})});
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("accepted-original");
			expect(fetch).toHaveBeenCalledTimes(fallback ? 2 : 1); expect(account.consecutiveAuthFailures).toBe(0);
			await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
			expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))[0]).toMatchObject({outcome: "success", account: {index: fallback ? 2 : 1}, tokens: {inputTokens: 7, outputTokens: 3, totalTokens: 10}});
		} finally {
			await (await import("../lib/shutdown.js")).runCleanup();
			for (const [event, previous] of hooks) for (const listener of process.listeners(event)) if (!previous.has(listener)) process.removeListener(event, listener);
			await manager.flushPendingSave(); realStorage.setStoragePathDirect(null);
			await removeWithRetry(dir, {recursive: true, force: true});
		}
	});


	it.each([false, true].flatMap(fallback => [false, true].flatMap(stream => ["healthy", "journal", "primary", "revocation", "circuit", "failed", "error", "eof"].map(change => ({fallback, stream, change})))) )("preserves accepted plugin outcomes without unauthorized healing (%j)", async ({fallback, stream, change}) => {
		const hooks = new Map(["SIGINT", "SIGTERM", "beforeExit"].map(event => [event, new Set(process.listeners(event))]));
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-outcome-")), path = join(dir, "accounts.json");
		const storage: import("../lib/storage.js").AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: `outcome-${stream}-${change}`, accountId: "W1", refreshToken: "refresh-outcome", accessToken: "access-outcome", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
		if (fallback) storage.accounts.push({...storage.accounts[0]!, recordId: `fallback-${stream}-${change}`, accountId: "W2", refreshToken: "refresh-outcome-fallback", accessToken: "access-outcome-fallback"});
		await fs.writeFile(path, JSON.stringify(storage));
		const storageModule = await import("../lib/storage.js"), realStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		for (const method of ["getStoragePath", "loadAccounts", "saveAccounts", "withAccountStorageTransaction"] as const) vi.spyOn(storageModule, method).mockImplementation(realStorage[method] as never);
		const realAccounts = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js");
		realStorage.setStoragePathDirect(path);
		const manager = new realAccounts.AccountManager(undefined, storage), account = manager.getAccountByIndex(fallback ? 1 : 0)!;
		const {AccountManager} = await import("../lib/accounts.js");
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager as never);
		const helpers = await import("../lib/request/fetch-helpers.js"), actualHelpers = await vi.importActual<typeof import("../lib/request/fetch-helpers.js")>("../lib/request/fetch-helpers.js");
		vi.spyOn(helpers, "handleSuccessResponse").mockImplementation(actualHelpers.handleSuccessResponse);
		vi.spyOn(helpers, "createCodexHeaders").mockImplementation(actualHelpers.createCodexHeaders);
		const {getPendingAuthPath} = await import("../lib/storage/pending-auth.js");
		const {readUsageLedgerRows} = await import("../lib/usage/index.js");
		const {getCircuitBreaker} = await import("../lib/circuit-breaker.js");
		const before = new Set((await readUsageLedgerRows()).map(row => row.id));
		const logger = await import("../lib/logger.js");
		const logWarnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
		const client = {tui: {showToast: vi.fn()}, auth: {set: vi.fn()}};
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const bearer = new Headers(init?.headers).get("authorization");
			if (fallback && bearer === "Bearer access-outcome") return new Response("safe explicit rejection", {status: 429, headers: {"Retry-After": "60"}});
			expect(bearer).toBe(fallback ? "Bearer access-outcome-fallback" : "Bearer access-outcome");
			account.consecutiveAuthFailures = 2;
			if (change === "journal") await fs.writeFile(getPendingAuthPath(path), "{");
			if (change === "primary") await fs.writeFile(path, "{");
			if (change === "revocation") {storage.accounts[fallback ? 1 : 0]!.authInvalidatedAt = Date.now(); storage.accounts[fallback ? 1 : 0]!.authInvalidationErrorCode = "token_invalidated"; await fs.writeFile(path, JSON.stringify(storage));}
			if (change === "circuit") {
				const breaker = getCircuitBreaker(account.circuitKeyId!);
				for (let i = 0; i < 3; i++) breaker.recordFailure();
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
				expect(breaker.tryCanExecute().ok).toBe(true);
			}
			const type = change === "failed" ? "response.failed" : change === "error" ? "error" : change === "eof" ? "response.created" : "response.completed";
			return new Response(`data: ${JSON.stringify({type, response: {id: "accepted-original", status: change === "failed" ? "failed" : "completed", output: [], usage: {input_tokens: 7, output_tokens: 3, total_tokens: 10}}})}\n\n`, {headers: {"Content-Type": "text/event-stream"}});
		});
		globalThis.fetch = fetch;
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "access-outcome", refresh: "refresh-outcome", expires: Date.now() + 3600000, multiAccount: true}), {options: {}, models: {}});
			const response = await sdk.fetch!("https://example.com", {body: JSON.stringify({model: "gpt-5.1", stream})});
			expect(response.status).toBe(!stream && (change === "failed" || change === "error") ? 502 : 200);
			expect(await response.text()).toContain(!stream && (change === "failed" || change === "error") ? "sse_terminal_error" : "accepted-original");
			expect(fetch).toHaveBeenCalledTimes(fallback ? 2 : 1); expect(account.consecutiveAuthFailures).toBe(change === "healthy" ? 0 : 2);
			if (change === "journal" || change === "primary") {
				const observation = logWarnSpy.mock.calls.find(call => call[0] === "Accepted response recovery authority could not be observed")?.[1] as {error?: Error} | undefined;
				expect(observation?.error).toBeInstanceOf(Error);
				expect(observation?.error?.cause).toBeInstanceOf(SyntaxError);
			}
			if (change === "circuit") expect(getCircuitBreaker(account.circuitKeyId!).getState()).toBe("half-open");
			await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
			expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))[0]).toMatchObject({outcome: ["failed", "error", "eof"].includes(change) ? "failure" : "success", account: {index: fallback ? 1 : 0}, tokens: {inputTokens: 7, outputTokens: 3, totalTokens: 10}});
		} finally {
			if (change === "journal") await fs.unlink(getPendingAuthPath(path));
			if (change === "primary") await fs.writeFile(path, JSON.stringify(storage));
			await (await import("../lib/shutdown.js")).runCleanup();
			for (const [event, previous] of hooks) for (const listener of process.listeners(event)) if (!previous.has(listener)) process.removeListener(event, listener);
			await manager.flushPendingSave(); realStorage.setStoragePathDirect(null);
			await removeWithRetry(dir, {recursive: true, force: true});
		}
	});

	it.each([false, true].flatMap(fallback => ["healthy", "revocation", "circuit", "forget", "replacement"].map(change => ({fallback, change}))))("revalidates delayed stream affinity while preserving original bytes and usage (%j)", async ({fallback, change}) => {
		const stream = true;
		const previousThreadId = process.env.CODEX_THREAD_ID;
		process.env.CODEX_THREAD_ID = "fixture-delayed-affinity";
		const config = await import("../lib/config.js");
		vi.spyOn(config, "getResponseContinuation").mockReturnValue(true);
		const {SessionAffinityStore} = await import("../lib/session-affinity.js");
		const selectionSpy = vi.spyOn(SessionAffinityStore.prototype, "getPreferredAccountIndex");
		const updateSpy = vi.spyOn(SessionAffinityStore.prototype, "updateLastResponseId");
		const hooks = new Map(["SIGINT", "SIGTERM", "beforeExit"].map(event => [event, new Set(process.listeners(event))]));
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-outcome-")), path = join(dir, "accounts.json");
		const storage: import("../lib/storage.js").AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: `outcome-${stream}-${change}`, accountId: "W1", refreshToken: "refresh-outcome", accessToken: "access-outcome", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
		if (fallback) storage.accounts.push({...storage.accounts[0]!, recordId: `fallback-${stream}-${change}`, accountId: "W2", refreshToken: "refresh-outcome-fallback", accessToken: "access-outcome-fallback"});
		await fs.writeFile(path, JSON.stringify(storage));
		const storageModule = await import("../lib/storage.js"), realStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		for (const method of ["getStoragePath", "loadAccounts", "saveAccounts", "withAccountStorageTransaction"] as const) vi.spyOn(storageModule, method).mockImplementation(realStorage[method] as never);
		const realAccounts = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js");
		realStorage.setStoragePathDirect(path);
		const manager = new realAccounts.AccountManager(undefined, storage), account = manager.getAccountByIndex(fallback ? 1 : 0)!;
		const {AccountManager} = await import("../lib/accounts.js");
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager as never);
		const helpers = await import("../lib/request/fetch-helpers.js"), actualHelpers = await vi.importActual<typeof import("../lib/request/fetch-helpers.js")>("../lib/request/fetch-helpers.js");
		vi.spyOn(helpers, "handleSuccessResponse").mockImplementation(actualHelpers.handleSuccessResponse);
		vi.spyOn(helpers, "createCodexHeaders").mockImplementation(actualHelpers.createCodexHeaders);
		const {getPendingAuthPath} = await import("../lib/storage/pending-auth.js");
		const {readUsageLedgerRows} = await import("../lib/usage/index.js");
		const {getCircuitBreaker} = await import("../lib/circuit-breaker.js");
		const before = new Set((await readUsageLedgerRows()).map(row => row.id));
		const logger = await import("../lib/logger.js");
		const logWarnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
		const client = {tui: {showToast: vi.fn()}, auth: {set: vi.fn()}};
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const bearer = new Headers(init?.headers).get("authorization");
			if (fallback && bearer === "Bearer access-outcome") return new Response("safe explicit rejection", {status: 429, headers: {"Retry-After": "60"}});
			expect(bearer).toBe(fallback ? "Bearer access-outcome-fallback" : "Bearer access-outcome");
			account.consecutiveAuthFailures = 2;
			return new Response('data: {"type":"response.completed","response":{"id":"accepted-original","status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n', {headers: {"Content-Type": "text/event-stream"}});
		});
		globalThis.fetch = fetch;
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "access-outcome", refresh: "refresh-outcome", expires: Date.now() + 3600000, multiAccount: true}), {options: {}, models: {}});
			const response = await sdk.fetch!("https://example.com", {body: JSON.stringify({model: "gpt-5.1", stream, prompt_cache_key: "fixture-delayed-affinity"})});
			expect(response.status).toBe(200);
			const context = selectionSpy.mock.contexts.find(value => value instanceof SessionAffinityStore);
			if (!(context instanceof SessionAffinityStore)) throw Error("No actual affinity store was consulted");
			const session = selectionSpy.mock.calls.find(call => call[0])?.[0];
			expect(session).toBe("fixture-delayed-affinity");
			account.consecutiveAuthFailures = 2;
			if (change === "revocation") {storage.accounts[fallback ? 1 : 0]!.authInvalidatedAt = Date.now(); await fs.writeFile(path, JSON.stringify(storage));}
			if (change === "replacement") {storage.accounts[fallback ? 1 : 0]!.accessToken = "fixture-replaced"; await fs.writeFile(path, JSON.stringify(storage));}
			if (change === "circuit") for (let i = 0; i < 3; i++) getCircuitBreaker(account.circuitKeyId!).recordFailure();
			if (change === "forget") context.forgetSession(session);
			updateSpy.mockClear();
			expect(await response.text()).toContain("accepted-original");
			await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
			// Drain the same nonreentrant pool lane after the stream callback.
			await realStorage.withAccountStorageTransaction(async () => undefined);
			if (change === "healthy") await vi.waitFor(() => expect(context.getLastResponseId(session)).toBe("accepted-original"));
			else {expect(context.getLastResponseId(session)).toBeNull(); if (change === "forget") expect(context.getPreferredAccountIndex(session)).toBeNull();}

			expect(fetch).toHaveBeenCalledTimes(fallback ? 2 : 1); expect(account.consecutiveAuthFailures).toBe(change === "healthy" || change === "forget" ? 0 : 2);
			if (change === "circuit") expect(getCircuitBreaker(account.circuitKeyId!).getState()).toBe("open");
			await vi.waitFor(async () => expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))).toHaveLength(1));
			expect((await readUsageLedgerRows()).filter(row => !before.has(row.id))[0]).toMatchObject({outcome: "success", account: {index: fallback ? 1 : 0}, tokens: {inputTokens: 7, outputTokens: 3, totalTokens: 10}});
		} finally {
			if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previousThreadId;
			await (await import("../lib/shutdown.js")).runCleanup();
			for (const [event, previous] of hooks) for (const listener of process.listeners(event)) if (!previous.has(listener)) process.removeListener(event, listener);
			await manager.flushPendingSave(); realStorage.setStoragePathDirect(null);
			await removeWithRetry(dir, {recursive: true, force: true});
		}
	});

	it.each(["primary", "safe-rejection-fallback", "accepted-empty"])("preserves raw refresh-only plugin accounts at the dispatch boundary (%s)", async route => {
		const hooks = new Map(["SIGINT", "SIGTERM", "beforeExit"].map(event => [event, new Set(process.listeners(event))]));
		const dir = await fs.mkdtemp(join(tmpdir(), "plugin-first-token-"));
		const path = join(dir, "accounts.json");
		const firstRefresh = `fixture-first-refresh-${route}`;
		const nextRefresh = `fixture-first-next-${route}`;
		const firstAccess = `fixture-first-access-${route}`;
		const firstRecordId = `first-token-${route}`;
		const storage: import("../lib/storage.js").AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: firstRecordId, accountId: `workspace-first-${route}`, refreshToken: firstRefresh, addedAt: 1, lastUsed: 1}]};
		if (route !== "primary") storage.accounts.unshift({recordId: "primary-token", accountId: "workspace-primary", refreshToken: "fixture-primary-refresh", accessToken: "fixture-primary-access", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1});
		await fs.writeFile(path, JSON.stringify(storage));
		const storageModule = await import("../lib/storage.js");
		const realStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		for (const method of ["getStoragePath", "loadAccounts", "saveAccounts", "withAccountStorageTransaction"] as const) {
			vi.spyOn(storageModule, method).mockImplementation(realStorage[method] as never);
		}
		const realAccounts = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js");
		realStorage.setStoragePathDirect(path);
		const manager = new realAccounts.AccountManager(undefined, storage);
		expect(manager.resolveSelectionStoragePath()).toBe(path);
		expect(storageModule.getStoragePath()).toBe(path);
		const {AccountManager} = await import("../lib/accounts.js");
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager as never);
		const helpers = await import("../lib/request/fetch-helpers.js");
		const realRefresh = await import("../lib/request/token-refresh.js");
		vi.mocked(helpers.shouldRefreshToken).mockImplementation(auth => auth.type !== "oauth" || !auth.access);
		vi.mocked(helpers.refreshAndUpdateToken).mockImplementation(realRefresh.refreshAndUpdateToken);
		const {RefreshLeaseCoordinator} = await import("../lib/refresh-lease.js");
		vi.spyOn(RefreshLeaseCoordinator.prototype, "acquire").mockResolvedValue({role: "leader", release: async () => undefined});
		const client = {tui: {showToast: vi.fn()}, auth: {set: vi.fn(async () => undefined)}};
		const oauth = vi.fn(), inference = vi.fn();
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === "https://auth.openai.com/oauth/token") {oauth(); return Response.json({access_token: firstAccess, refresh_token: nextRefresh, expires_in: 3600});}
			inference();
			if (route === "accepted-empty") return new Response("", {headers: {"Content-Type": "text/event-stream"}});
			if (route === "safe-rejection-fallback") {
				if (inference.mock.calls.length === 1) return Response.json({error: {code: "rate_limit_exceeded"}}, {status: 429, headers: {"retry-after": "60"}});
				return new Response('data: {"type":"response.completed","response":{"id":"first-token","output":[],"usage":{"input_tokens":7,"output_tokens":3}}}\n\n', {headers: {"Content-Type": "text/event-stream"}});
			}
			return Response.json({id: "first-token", output: []});
		});
		try {
			const {OpenAIAuthPlugin} = await import("../index.js");
			const plugin = await OpenAIAuthPlugin({client} as never);
			const sdk = await plugin.auth!.loader!(async () => ({type: "oauth", access: "", refresh: firstRefresh, expires: 0, multiAccount: true}), {options: {}, models: {}});
			const response = await sdk.fetch!("https://example.com", route !== "primary" ? {body: JSON.stringify({model: "gpt-5.1", stream: true})} : {});
			expect(response.status).toBe(200); const body = await response.text();
			if (route === "safe-rejection-fallback") expect(body).toContain('"id":"first-token"');
			if (route === "accepted-empty") expect(body).toBe("");
			expect(oauth).toHaveBeenCalledTimes(route === "accepted-empty" ? 0 : 1);
			expect(inference).toHaveBeenCalledTimes(route === "safe-rejection-fallback" ? 2 : 1);
			expect(client.auth.set).toHaveBeenCalledTimes(route === "accepted-empty" ? 0 : 1);
			expect(storageModule.getStoragePath()).toBe(path);
			expect((await storageModule.loadAccounts())?.accounts.find(row => row.recordId === firstRecordId)?.refreshToken).toBe(route === "accepted-empty" ? firstRefresh : nextRefresh);
		} finally {
			vi.mocked(helpers.shouldRefreshToken).mockImplementation(() => false);
			vi.mocked(helpers.refreshAndUpdateToken).mockImplementation(async auth => auth);
			(await import("../lib/refresh-queue.js")).resetRefreshQueue();
			await (await import("../lib/shutdown.js")).runCleanup();
			for (const [event, previous] of hooks) for (const listener of process.listeners(event)) if (!previous.has(listener)) process.removeListener(event, listener);
			await manager.flushPendingSave(); storageModule.setStoragePathDirect(null);
			await removeWithRetry(dir, {recursive: true, force: true});
		}
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
		expect(accountManagerState.durableRestrictionCommits).toBe(1);
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

