import type { Workspace } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";
import type { AccountMetadataV3, AccountStorageV3, FlaggedAccountMetadataV1 } from "../storage.js";
import type { AccountIdSource, TokenResult } from "../types.js";
import { PendingAuthLocalError } from "../storage/pending-auth.js";

export type TokenSuccessWithAccount = Extract<
	TokenResult,
	{ type: "success" }
> & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	workspaces?: Workspace[];
	/** Set, keep (undefined) or clear (null) the saved CodexCliMirror. */
	codexCliMirror?: AccountMetadataV3["codexCliMirror"] | null;
};

export function recoveredFlaggedAccountMetadata(source: FlaggedAccountMetadataV1): AccountMetadataV3 {
	return {
		recordId: source.recordId, addedAt: source.addedAt, lastUsed: source.lastUsed,
		refreshToken: source.refreshToken, accountId: source.accountId, accountIdSource: source.accountIdSource,
		accountLabel: source.accountLabel, email: source.email, lastSwitchReason: source.lastSwitchReason,
		workspaces: structuredClone(source.workspaces), currentWorkspaceIndex: source.currentWorkspaceIndex,
		codexCliMirror: source.codexCliMirror, rateLimitResetTimes: source.rateLimitResetTimes,
		coolingDownUntil: source.cooldownReason === "auth-failure" ? undefined : source.coolingDownUntil,
		cooldownReason: source.cooldownReason === "auth-failure" ? undefined : source.cooldownReason,
	};
}

export async function persistAccountPoolResults(params: {
	results: TokenSuccessWithAccount[];
	recoveredSources?: FlaggedAccountMetadataV1[];
	replaceAll?: boolean;
	modelFamilies: readonly ModelFamily[];
	withAccountStorageTransaction: <T>(
		handler: (
			loadedStorage: AccountStorageV3 | null,
			persist: (storage: AccountStorageV3) => Promise<void>,
		) => Promise<T>,
	) => Promise<T>;
	findMatchingAccountIndex: typeof import("../storage.js").findMatchingAccountIndex;
	extractAccountId: (accessToken: string) => string | undefined;
	extractAccountEmail: (
		accessToken: string,
		idToken?: string,
	) => string | undefined;
	sanitizeEmail: (email: string | undefined) => string | undefined;
}): Promise<void> {
	const { results, replaceAll = false } = params;
	if (results.length === 0) return;

	await params.withAccountStorageTransaction(async (loadedStorage, persist) => {
		const now = Date.now();
		const stored = replaceAll ? null : loadedStorage;
		const accounts = stored?.accounts ? [...stored.accounts] : [];

		for (const [resultIndex, result] of results.entries()) {
			const source = params.recoveredSources?.[resultIndex];
			const sourceMetadata = source ? recoveredFlaggedAccountMetadata(source) : undefined;
			const accountId =
				result.accountIdOverride ?? params.extractAccountId(result.access) ?? source?.accountId;
			const accountIdSource = accountId
				? (result.accountIdSource ??
					(result.accountIdOverride ? "manual" : "token"))
				: undefined;
			const accountLabel = result.accountLabel ?? source?.accountLabel;
			const accountEmail = params.sanitizeEmail(
				params.extractAccountEmail(result.access, result.idToken) ?? source?.email,
			);
			const sourceIndex = source?.recordId ? accounts.findIndex(row => row.recordId === source.recordId) : -1;
			const existingIndex = sourceIndex >= 0 ? sourceIndex : params.findMatchingAccountIndex(
				accounts,
				{
					accountId,
					email: accountEmail,
					refreshToken: result.refresh,
				},
				{
					allowUniqueAccountIdFallbackWithoutEmail: true,
				},
			);

			if (existingIndex === undefined) {
				const initialWorkspaceIndex =
					result.workspaces && result.workspaces.length > 0
						? (() => {
								if (accountId) {
									const matchingWorkspaceIndex = result.workspaces.findIndex(
										(workspace) => workspace.id === accountId,
									);
									if (matchingWorkspaceIndex >= 0) {
										return matchingWorkspaceIndex;
									}
								}
								const firstEnabledWorkspaceIndex = result.workspaces.findIndex(
									(workspace) => workspace.enabled !== false,
								);
								return firstEnabledWorkspaceIndex >= 0
									? firstEnabledWorkspaceIndex
									: 0;
							})()
						: undefined;
				accounts.push({
					...sourceMetadata,
					accountId,
					accountIdSource,
					accountLabel,
					email: accountEmail,
					refreshToken: result.refresh,
					accessToken: result.access,
					expiresAt: result.expires,
					addedAt: source?.addedAt ?? now,
					lastUsed: now,
					workspaces: source?.workspaces ?? result.workspaces,
					currentWorkspaceIndex: source?.currentWorkspaceIndex ?? initialWorkspaceIndex,
					...(result.codexCliMirror ? { codexCliMirror: result.codexCliMirror } : {}),
				});
				continue;
			}

			const storedAccount = accounts[existingIndex];
			if (!storedAccount) continue;
			if (source?.recordId && storedAccount.recordId && source.recordId !== storedAccount.recordId) throw new PendingAuthLocalError("Flagged recovery cannot replace another primary record");
			const existing = source ? {
				...sourceMetadata, ...storedAccount,
				recordId: source.recordId ?? storedAccount.recordId, addedAt: source.addedAt,
				workspaces: storedAccount.workspaces ?? source.workspaces,
				currentWorkspaceIndex: storedAccount.currentWorkspaceIndex ?? source.currentWorkspaceIndex,
			} : storedAccount;

			const nextEmail = accountEmail ?? params.sanitizeEmail(existing.email);
			const nextAccountId = accountId ?? existing.accountId;
			const nextAccountIdSource = accountId
				? (accountIdSource ?? existing.accountIdSource)
				: existing.accountIdSource;
			const nextAccountLabel = accountLabel ?? existing.accountLabel;
			const mergedWorkspaces = result.workspaces
				? result.workspaces.map((newWs) => {
						const existingWs = existing.workspaces?.find(
							(w) => w.id === newWs.id,
						);
						return existingWs
							? {
									...newWs,
									enabled: existingWs.enabled,
									disabledAt: existingWs.disabledAt,
								}
							: newWs;
					})
				: existing.workspaces;
			const currentWorkspaceId =
				existing.workspaces?.[
					typeof existing.currentWorkspaceIndex === "number"
						? existing.currentWorkspaceIndex
						: 0
				]?.id;
			const nextCurrentWorkspaceIndex =
				mergedWorkspaces && mergedWorkspaces.length > 0
					? (() => {
							if (currentWorkspaceId) {
								const matchingWorkspaceIndex = mergedWorkspaces.findIndex(
									(workspace) => workspace.id === currentWorkspaceId,
								);
								if (matchingWorkspaceIndex >= 0) {
									return matchingWorkspaceIndex;
								}
							}
							const defaultWorkspaceIndex = mergedWorkspaces.findIndex(
								(workspace) => workspace.isDefault === true,
							);
							if (defaultWorkspaceIndex >= 0) {
								return defaultWorkspaceIndex;
							}
							const firstEnabledWorkspaceIndex = mergedWorkspaces.findIndex(
								(workspace) => workspace.enabled !== false,
							);
							return firstEnabledWorkspaceIndex >= 0
								? firstEnabledWorkspaceIndex
								: 0;
						})()
					: existing.currentWorkspaceIndex;
			accounts[existingIndex] = {
				...existing,
				accountId: nextAccountId,
				accountIdSource: nextAccountIdSource,
				accountLabel: nextAccountLabel,
				email: nextEmail,
				refreshToken: result.refresh,
				accessToken: result.access,
				expiresAt: result.expires,
				lastUsed: now,
				...(source ? {enabled: true, authInvalidatedAt: undefined, authInvalidationErrorCode: undefined,
					...(existing.cooldownReason === "auth-failure" ? {coolingDownUntil: undefined, cooldownReason: undefined} : {})} : {}),
				workspaces: mergedWorkspaces,
				currentWorkspaceIndex: nextCurrentWorkspaceIndex,
				codexCliMirror:
					result.codexCliMirror === null
						? undefined
						: (result.codexCliMirror ?? existing.codexCliMirror),
			};
		}

		if (accounts.length === 0) return;

		const activeIndex = replaceAll
			? 0
			: typeof stored?.activeIndex === "number" &&
					Number.isFinite(stored.activeIndex)
				? stored.activeIndex
				: 0;

		const clampedActiveIndex = Math.max(
			0,
			Math.min(activeIndex, accounts.length - 1),
		);
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of params.modelFamilies) {
			const storedFamilyIndex = stored?.activeIndexByFamily?.[family];
			const rawFamilyIndex = replaceAll
				? 0
				: typeof storedFamilyIndex === "number" &&
						Number.isFinite(storedFamilyIndex)
					? storedFamilyIndex
					: clampedActiveIndex;
			activeIndexByFamily[family] = Math.max(
				0,
				Math.min(Math.floor(rawFamilyIndex), accounts.length - 1),
			);
		}

		await persist({
			version: 3,
			accounts: accounts as AccountMetadataV3[],
			activeIndex: clampedActiveIndex,
			activeIndexByFamily,
		});
	});
}
