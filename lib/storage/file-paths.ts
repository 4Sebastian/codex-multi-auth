import { dirname, join } from "node:path";
import { getStoragePathState } from "./path-state.js";
import { getConfigDir } from "./paths.js";
import {
	ACCOUNTS_BACKUP_SUFFIX,
	ACCOUNTS_WAL_SUFFIX,
	getAccountsBackupPath,
	getAccountsBackupRecoveryCandidates as getBackupRecoveryCandidates,
	getAccountsWalPath,
	getIntentionalResetMarkerPath,
	RESET_MARKER_SUFFIX,
} from "./backup-paths.js";

export const ACCOUNTS_FILE_NAME = "openai-codex-accounts.json";
const ACCOUNTS_BACKUP_HISTORY_DEPTH = 3;

export function getStoragePath(): string {
	return getStoragePathState().currentStoragePath || join(getConfigDir(), ACCOUNTS_FILE_NAME);
}
export const FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-flagged-accounts.json";
export const LEGACY_FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-blocked-accounts.json";

export {
	ACCOUNTS_BACKUP_SUFFIX,
	ACCOUNTS_WAL_SUFFIX,
	getAccountsBackupPath,
	getAccountsWalPath,
	getIntentionalResetMarkerPath,
	RESET_MARKER_SUFFIX,
};

export function getAccountsBackupRecoveryCandidates(path: string): string[] {
	return getBackupRecoveryCandidates(path, ACCOUNTS_BACKUP_HISTORY_DEPTH);
}

export function getFlaggedBackupPaths(path: string): string[] {
	return [`${path}.bak`, `${path}.bak.1`, `${path}.bak.2`];
}

export function getFlaggedAccountsPath(
	storagePath: string,
	fileName: string,
): string {
	return buildSiblingStoragePath(storagePath, fileName);
}

function buildSiblingStoragePath(storagePath: string, fileName: string): string {
	return join(dirname(storagePath), fileName);
}

export function getLegacyFlaggedAccountsPath(
	storagePath: string,
	legacyFileName: string,
): string {
	return buildSiblingStoragePath(storagePath, legacyFileName);
}
