import { promises as fs, readdirSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../logger.js";
import { isRecord } from "../utils.js";
import { captureAuthorityRevision } from "./authority-revision.js";
import { getAccountsBackupRecoveryCandidates, getAccountsWalPath, ACCOUNTS_WAL_SUFFIX, RESET_MARKER_SUFFIX } from "./backup-paths.js";
import { isCacheLikeBackupArtifactName } from "./cache-artifacts.js";
import type { AccountMetadataV3 } from "./public-types.js";
import { FLAGGED_ACCOUNTS_FILE_NAME, LEGACY_FLAGGED_ACCOUNTS_FILE_NAME, getFlaggedAccountsPath, getFlaggedBackupPaths } from "./file-paths.js";

const log = createLogger("storage");
export type PendingAuthRecoveryCredential = Pick<AccountMetadataV3,
	"refreshToken" | "accessToken" | "expiresAt" | "authInvalidatedAt" | "authInvalidationErrorCode" | "enabled" | "cooldownReason">;

export function getPendingAuthPath(storagePath: string): string {
	return `${storagePath}.pending-auth.json`;
}

function backupRecoveryCandidates(path: string, entries: readonly Dirent[]): string[] {
	const knownCandidates = getAccountsBackupRecoveryCandidates(
		path,
		3,
	);
	const discoveredCandidates = new Set<string>();
	const candidatePrefix = `${basename(path)}.`;
	const knownCandidateSet = new Set(knownCandidates);
	const directoryPath = dirname(path);

	for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(candidatePrefix)) continue;
			if (isCacheLikeBackupArtifactName(entry.name)) continue;
			if (entry.name.endsWith(RESET_MARKER_SUFFIX)) continue;
			if (entry.name.endsWith(".tmp")) continue;
			if (entry.name.includes(".rotate.")) continue;
			if (entry.name.endsWith(ACCOUNTS_WAL_SUFFIX)) continue;
			const candidatePath = join(directoryPath, entry.name);
			if (candidatePath === getPendingAuthPath(path)) continue;
			if (knownCandidateSet.has(candidatePath)) continue;
			discoveredCandidates.add(candidatePath);
	}

	const discoveredOrdered = Array.from(discoveredCandidates).sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: "base" }),
	);
	return [...knownCandidates, ...discoveredOrdered];
}

export function getAccountsBackupRecoveryCandidatesWithDiscoverySync(path: string): string[] {
	try { return backupRecoveryCandidates(path, readdirSync(dirname(path), {withFileTypes: true})); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return backupRecoveryCandidates(path, []);
		throw error;
	}
}

export async function getAccountsBackupRecoveryCandidatesWithDiscovery(path: string, strict = false): Promise<string[]> {
	try {
		return backupRecoveryCandidates(path, await fs.readdir(dirname(path), {withFileTypes: true}));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (strict) throw error;
		if (code !== "ENOENT") log.warn("Failed to discover account backup candidates", {path, error: String(error)});
		return backupRecoveryCandidates(path, []);
	}
}

export async function collectRestorableCredentials(path: string, includePrimary = false): Promise<PendingAuthRecoveryCredential[]> {
	const directoryCurrent = captureAuthorityRevision([dirname(path)]);
	const candidates = await getAccountsBackupRecoveryCandidatesWithDiscovery(path, true);
	const flagged = [FLAGGED_ACCOUNTS_FILE_NAME, LEGACY_FLAGGED_ACCOUNTS_FILE_NAME]
		.flatMap(name => {const source = getFlaggedAccountsPath(path, name); return [source, ...getFlaggedBackupPaths(source)];});
	const sources = [...(includePrimary ? [path] : []), ...candidates, ...flagged, getAccountsWalPath(path)];
	const sourcesCurrent = captureAuthorityRevision(sources);
	const tokens: PendingAuthRecoveryCredential[] = [];
	const collectContent = (raw: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("Unparseable account recovery source");
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.accounts) || (parsed.version !== 1 && parsed.version !== 3)) throw new Error("Invalid account recovery source");
		for (const account of parsed.accounts) {
			if (
				isRecord(account) &&
				typeof account.refreshToken === "string" &&
				account.refreshToken.length > 0
			) {
				tokens.push({
					refreshToken: account.refreshToken,
					accessToken: typeof account.accessToken === "string" ? account.accessToken : undefined,
					expiresAt: typeof account.expiresAt === "number" ? account.expiresAt : undefined,
					authInvalidatedAt: typeof account.authInvalidatedAt === "number" ? account.authInvalidatedAt : undefined,
					authInvalidationErrorCode: typeof account.authInvalidationErrorCode === "string" ? account.authInvalidationErrorCode : undefined,
					enabled: account.enabled === false ? false : undefined,
					cooldownReason: account.cooldownReason === "auth-failure" ? "auth-failure" : undefined,
				});
			} else throw new Error("Invalid account recovery credential");
		}
	};
	if (includePrimary) collectContent(await fs.readFile(path, "utf-8"));
	for (const candidate of [...candidates, ...flagged]) {
		try {
			collectContent(await fs.readFile(candidate, "utf-8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	try {
		const walEntry: unknown = JSON.parse(
			await fs.readFile(getAccountsWalPath(path), "utf-8"),
		);
		if (!isRecord(walEntry) || typeof walEntry.content !== "string") throw new Error("Invalid account recovery journal");
		collectContent(walEntry.content);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!directoryCurrent() || !sourcesCurrent()) throw new Error("Account recovery sources changed during scan");
	return tokens;
}

