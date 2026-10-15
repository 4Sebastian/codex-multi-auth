import { promises as fs, opendirSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../logger.js";
import { isRecord } from "../utils.js";
import { captureAuthorityRevision } from "./authority-revision.js";
import { getAccountsBackupRecoveryCandidates, getAccountsWalPath, ACCOUNTS_WAL_SUFFIX, RESET_MARKER_SUFFIX } from "./backup-paths.js";
import { isCacheLikeBackupArtifactName } from "./cache-artifacts.js";
import type { AccountMetadataV3 } from "./public-types.js";
import { FLAGGED_ACCOUNTS_FILE_NAME, LEGACY_FLAGGED_ACCOUNTS_FILE_NAME, getFlaggedAccountsPath, getFlaggedBackupPaths, getAutomaticCheckHistoryPath } from "./file-paths.js";

const log = createLogger("storage");
export const MAX_RECOVERY_SOURCES = 1000;
export class RecoverySourceCapacityError extends Error {
	readonly code = "ERECOVERYSOURCECAPACITY";
	constructor() {super("Account recovery proof exceeds its 1000-source bound");}
}
export function assertRecoverySourceCount(count: number): void {
	if (count > MAX_RECOVERY_SOURCES) throw new RecoverySourceCapacityError();
}
export type PendingAuthRecoveryCredential = Pick<AccountMetadataV3,
	"refreshToken" | "accessToken" | "expiresAt" | "authInvalidatedAt" | "authInvalidationErrorCode" | "enabled" | "cooldownReason">;

export function getPendingAuthPath(storagePath: string): string {
	return `${storagePath}.pending-auth.json`;
}

function backupRecoveryScan(path: string) {
	const knownCandidates = getAccountsBackupRecoveryCandidates(
		path,
		3,
	);
	const discoveredCandidates = new Set<string>();
	const candidatePrefix = `${basename(path)}.`;
	const knownCandidateSet = new Set(knownCandidates);
	const directoryPath = dirname(path);

	return {
		add(entry: Dirent): void {
			if (!entry.isFile() || !entry.name.startsWith(candidatePrefix) || isCacheLikeBackupArtifactName(entry.name) ||
				entry.name.endsWith(RESET_MARKER_SUFFIX) || entry.name.endsWith(".tmp") || entry.name.includes(".rotate.") || entry.name.endsWith(ACCOUNTS_WAL_SUFFIX)) return;
			const candidatePath = join(directoryPath, entry.name);
			if (candidatePath === getPendingAuthPath(path) || candidatePath === getAutomaticCheckHistoryPath(path) || knownCandidateSet.has(candidatePath)) return;
			discoveredCandidates.add(candidatePath);
			// Reserve primary, canonical/legacy flagged chains and WAL as well.
			assertRecoverySourceCount(knownCandidates.length + discoveredCandidates.size + 10);
		},
		result(): string[] {
			return [...knownCandidates, ...Array.from(discoveredCandidates).sort((a, b) => a.localeCompare(b, undefined, {sensitivity: "base"}))];
		},
	};
}

export function getAccountsBackupRecoveryCandidatesWithDiscoverySync(path: string): string[] {
	const scan = backupRecoveryScan(path);
	try {
		const directory = opendirSync(dirname(path));
		try {let entry: Dirent | null; while ((entry = directory.readSync())) scan.add(entry);}
		finally {directory.closeSync();}
		return scan.result();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return scan.result();
		throw error;
	}
}

export async function getAccountsBackupRecoveryCandidatesWithDiscovery(path: string, strict = false): Promise<string[]> {
	const scan = backupRecoveryScan(path);
	try {
		for await (const entry of await fs.opendir(dirname(path))) scan.add(entry);
		return scan.result();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (strict || error instanceof RecoverySourceCapacityError) throw error;
		if (code !== "ENOENT") log.warn("Failed to discover account backup candidates", {path, error: String(error)});
		return backupRecoveryScan(path).result();
	}
}

export async function collectRestorableCredentials(path: string, includePrimary = false): Promise<PendingAuthRecoveryCredential[]> {
	const directoryCurrent = captureAuthorityRevision([dirname(path)]);
	const candidates = await getAccountsBackupRecoveryCandidatesWithDiscovery(path, true);
	const flagged = [FLAGGED_ACCOUNTS_FILE_NAME, LEGACY_FLAGGED_ACCOUNTS_FILE_NAME]
		.flatMap(name => {const source = getFlaggedAccountsPath(path, name); return [source, ...getFlaggedBackupPaths(source)];});
	const sources = [...(includePrimary ? [path] : []), ...candidates, ...flagged, getAccountsWalPath(path)];
	assertRecoverySourceCount(sources.length);
	const sourcesCurrent = captureAuthorityRevision(sources);
	const tokens = new Map<string, PendingAuthRecoveryCredential>();
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
				const credential: PendingAuthRecoveryCredential = {
					refreshToken: account.refreshToken,
					accessToken: typeof account.accessToken === "string" ? account.accessToken : undefined,
					expiresAt: typeof account.expiresAt === "number" ? account.expiresAt : undefined,
					authInvalidatedAt: typeof account.authInvalidatedAt === "number" ? account.authInvalidatedAt : undefined,
					authInvalidationErrorCode: typeof account.authInvalidationErrorCode === "string" ? account.authInvalidationErrorCode : undefined,
					enabled: account.enabled === false ? false : undefined,
					cooldownReason: account.cooldownReason === "auth-failure" ? "auth-failure" : undefined,
				};
				tokens.set(JSON.stringify(credential), credential);
				assertRecoverySourceCount(tokens.size);
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
	return [...tokens.values()];
}

