import { createHash } from "node:crypto";
import { decodeJWT } from "../auth/auth.js";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import { getStoragePath, getFlaggedAccountsPath, getFlaggedBackupPaths, FLAGGED_ACCOUNTS_FILE_NAME, LEGACY_FLAGGED_ACCOUNTS_FILE_NAME } from "./file-paths.js";
import { dirname } from "node:path";
import { z } from "zod";
import { withRetry } from "../fs-retry.js";
import { createLogger } from "../logger.js";
import { tempPathFor } from "../temp-path.js";
import type { OAuthAuthDetails, TokenResult, TokenSuccess } from "../types.js";
import { AccountsJournalEntrySchema, AnyAccountStorageSchema, FlaggedAccountStorageV1Schema } from "../schemas.js";
import { migrateV1ToV3 } from "./migrations.js";
import { captureAuthorityRevision } from "./authority-revision.js";
import { withFileTransactionLock } from "./file-lock.js";
import { getAccountsWalPath, getIntentionalResetMarkerPath } from "./backup-paths.js";
import type { ManagedAccount } from "../accounts.js";
import type { AccountMetadataV3, AccountStorageV3 } from "./public-types.js";
import { collectRestorableCredentials, getAccountsBackupRecoveryCandidatesWithDiscoverySync, getPendingAuthPath, type PendingAuthRecoveryCredential } from "./recovery-credentials.js";
export { getPendingAuthPath, type PendingAuthRecoveryCredential } from "./recovery-credentials.js";

/**
 * Rotated OAuth credentials that could not be written to the account pool
 * (a locked or unreadable accounts file). A refresh spends the previous
 * refresh token upstream, so losing the new one with the process means the
 * account needs a re-login. Every load applies these entries until a save
 * persists them.
 */
const entrySchema = z.object({
	/** sha256 of the spent refresh token: identifies the row without storing it. */
	prior: z.string().regex(/^[0-9a-f]{64}$/),
	recordId: z.string().trim().min(1).optional(),
	refreshToken: z.string().min(1),
	accessToken: z.string().min(1),
	expiresAt: z.number(),
	authInvalidatedAt: z.number().positive().optional(),
	authInvalidationErrorCode: z.string().optional(),
	enabled: z.literal(false).optional(),
	/** Provenance from a verified durable primary save, never an incoming rescue claim. */
	committed: z.literal(true).optional(),
	at: z.number(),
});
/** The writer keeps the journal at this size; the reader accepts any size so an
 * over-cap file an earlier writer left behind still loads and is trimmed on the next write. */
export const MAX_PENDING_AUTH_ENTRIES = 1000;
const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
type PendingAuth = z.infer<typeof entrySchema>;
const retry = { maxAttempts: 6, backoffMs: 25 };
const log = createLogger("pending-auth");

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

type Credential = Pick<PendingAuth, "refreshToken" | "accessToken" | "expiresAt">;
function isNewerCredential(candidate: Credential, current: Credential): boolean {
	const candidateIssuedAt = decodeJWT(candidate.accessToken)?.iat;
	const currentIssuedAt = decodeJWT(current.accessToken)?.iat;
	if (typeof candidateIssuedAt === "number" && Number.isFinite(candidateIssuedAt) && candidateIssuedAt > 0 &&
		typeof currentIssuedAt === "number" && Number.isFinite(currentIssuedAt) && currentIssuedAt > 0) {
		return candidateIssuedAt > currentIssuedAt;
	}
	return candidate.refreshToken === current.refreshToken && candidate.expiresAt > current.expiresAt;
}

type Authorization = Pick<PendingAuth, "authInvalidatedAt" | "authInvalidationErrorCode" | "enabled">;
function mergeAuthorization(credential: Credential, sources: Array<Authorization & Partial<Credential>>): Authorization {
	const invalidated = sources.filter(source => source.authInvalidatedAt && source.accessToken === credential.accessToken && source.refreshToken === credential.refreshToken && source.expiresAt === credential.expiresAt)
		.sort((a, b) => (b.authInvalidatedAt ?? 0) - (a.authInvalidatedAt ?? 0))[0];
	return {
		authInvalidatedAt: invalidated?.authInvalidatedAt,
		authInvalidationErrorCode: invalidated?.authInvalidationErrorCode,
		enabled: sources.some(source => source.enabled === false) ? false : undefined,
	};
}

/**
 * Only a missing file is empty. The entries are the only copy of rotated
 * tokens, so a lock that outlasts the retries or a torn/corrupt file throws:
 * a writer must never replace it with a partial list.
 */
async function read(path: string): Promise<PendingAuth[]> {
	let raw: string;
	try {
		raw = await withRetry(() => fs.readFile(path, "utf8"), retry);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return fileSchema.parse(JSON.parse(raw)).entries;
}

async function write(path: string, entries: PendingAuth[]): Promise<void> {
	if (entries.length > MAX_PENDING_AUTH_ENTRIES) throw new PendingAuthCapacityError();
	if (!entries.length) {
		await withRetry(() => fs.rm(path, { force: true }), retry);
		return;
	}
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = tempPathFor(path);
	try {
		await fs.writeFile(temp, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600, flag: "wx" });
		await withRetry(() => fs.rename(temp, path), retry);
	} finally {
		await fs.rm(temp, { force: true }).catch(() => undefined);
	}
}

export class PendingAuthLocalError extends Error {}

export class PendingAuthAdmissionError extends PendingAuthLocalError {
	readonly code = "EPENDINGAUTHADMISSION";
	constructor(cause: unknown) {
		super("Account refresh admission failed", {cause});
		this.name = "PendingAuthAdmissionError";
	}
}

export class PendingAuthObservationError extends PendingAuthLocalError {
	readonly code = "EPENDINGAUTHUNREADABLE";
	readonly statusCode = 503;
	constructor() {
		super("Failed to observe pending account recovery");
		this.name = "PendingAuthObservationError";
	}
}

export async function capturePendingAuth(storagePath: string, accounts: readonly AccountMetadataV3[] | null | undefined) {
	const entries = await read(getPendingAuthPath(storagePath)).catch(error => {
		const code = typeof (error as NodeJS.ErrnoException).code === "string" && /^[A-Z_]{1,40}$/.test((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code : "INVALID_PENDING_AUTH";
		log.warn("Failed to capture pending rotated credentials", {code});
		throw new PendingAuthObservationError();
	});
	return {entries, accounts: structuredClone(accounts ?? [])};
}

export class PendingAuthCapacityError extends PendingAuthLocalError {
	readonly code = "EPENDINGAUTHCAPACITY";
	constructor(options?: ErrorOptions) {
		super("Cannot safely retain rotated credentials within the journal capacity", options);
		this.name = "PendingAuthCapacityError";
	}
}

async function trimToCapacity(storagePath: string, entries: PendingAuth[], protectedPrior: string, reserve = 0): Promise<PendingAuth[]> {
	const excess = entries.length + reserve - MAX_PENDING_AUTH_ENTRIES;
	if (excess <= 0) return entries;
	let roots: PendingAuthRecoveryCredential[];
	try {
		roots = await collectRestorableCredentials(storagePath, true);
	} catch (cause) {
		throw new PendingAuthCapacityError({cause});
	}
	const required = new Set(roots.map(root => hash(root.refreshToken)));
	required.add(protectedPrior);
	const removable = entries.filter(entry => !required.has(entry.prior));
	if (removable.length < excess) throw new PendingAuthCapacityError();
	const dropped = new Set(removable.slice(0, excess));
	return entries.filter(entry => !dropped.has(entry));
}

export class PendingAuthSettlementError extends PendingAuthLocalError {
	readonly code = "EPENDINGAUTHSETTLEMENT";
	constructor(readonly result: TokenSuccess, cause: unknown, readonly authorityCurrent: () => boolean = () => true, readonly owner?: AccountMetadataV3, readonly durability: "memory" | "journal" | "unverified" = "memory") {
		super(durability === "journal" ? "Journaled credentials could not be published" : durability === "unverified" ? "Rotated credential publication failed; durable retention is unverified" : "Rotated credentials could not be durably retained; they remain only in memory", {cause});
		this.name = "PendingAuthSettlementError";
		Object.defineProperties(this, {result: {enumerable: false}, owner: {enumerable: false}, authorityCurrent: {enumerable: false}});
	}
}

type RefreshOwner = ManagedAccount | AccountMetadataV3 | OAuthAuthDetails;

function refreshBinding(owner: RefreshOwner, result?: TokenSuccess): unknown[] {
	const replaced = result && !("type" in owner) && (("index" in owner ? owner.access : owner.accessToken) !== result.access || owner.refreshToken !== result.refresh || ("index" in owner ? owner.expires : owner.expiresAt) !== result.expires);
	return "type" in owner
		? [owner.type, result?.access ?? owner.access, result?.refresh ?? owner.refresh, result?.expires ?? owner.expires]
		: [owner.recordId, result?.access ?? ("index" in owner ? owner.access : owner.accessToken), result?.refresh ?? owner.refreshToken,
			result?.expires ?? ("index" in owner ? owner.expires : owner.expiresAt), owner.accountId, owner.enabled === false,
			replaced ? undefined : owner.authInvalidatedAt, replaced ? undefined : owner.authInvalidationErrorCode, JSON.stringify(owner.workspaces), owner.currentWorkspaceIndex];
}

export function captureRefreshCredentialAuthority(
	account: RefreshOwner,
	current: () => boolean = () => true,
	retainAccount: () => RefreshOwner | null = () => account,
	storagePath = getStoragePath(),
): (result?: TokenSuccess) => boolean {
	const submitted = structuredClone(account);
	const ambientPath = getStoragePath();
	const flaggedPaths = [FLAGGED_ACCOUNTS_FILE_NAME, LEGACY_FLAGGED_ACCOUNTS_FILE_NAME].flatMap(name => {
		const path = getFlaggedAccountsPath(storagePath, name);
		return [path, ...getFlaggedBackupPaths(path)];
	});
	let accountBackups: string[];
	try { accountBackups = getAccountsBackupRecoveryCandidatesWithDiscoverySync(storagePath); }
	catch (error) { throw new PendingAuthAdmissionError(error); }
	const walPath = getAccountsWalPath(storagePath);
	const paths = [storagePath, ...flaggedPaths, ...accountBackups, walPath];
	let revision = captureAuthorityRevision(paths, [getIntentionalResetMarkerPath(storagePath)]);
	let revalidated = false;
	const resetCurrent = captureAuthorityRevision([], [getIntentionalResetMarkerPath(storagePath)]);
	const matches = (row: AccountMetadataV3, result?: TokenSuccess) => "type" in submitted ? row.refreshToken === submitted.refresh || row.refreshToken === result?.refresh
		: submitted.recordId && row.recordId ? row.recordId === submitted.recordId : row.refreshToken === submitted.refreshToken || row.refreshToken === result?.refresh;
	const sample = (path: string, result?: TokenSuccess): AccountMetadataV3 | undefined => {
		try {
			let value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!flaggedPaths.includes(path)) {
				if (path === walPath) value = JSON.parse(AccountsJournalEntrySchema.pick({version: true, content: true}).parse(value).content);
				const storage = AnyAccountStorageSchema.parse(value);
				return (storage.version === 3 ? storage : migrateV1ToV3(storage)).accounts.find(row => matches(row, result));
			}
			return FlaggedAccountStorageV1Schema.parse(value).accounts.find(row => matches(row, result));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new PendingAuthAdmissionError(error);
		}
	};
	const sampledRoots = paths.map(path => ({path, row: sample(path)}));
	// The primary owns the current generation; older backups remain revision proofs.
	const roots = sampledRoots.filter(root => root.row).slice(0, 1);
	if (existsSync(storagePath) && !roots.some(root => root.row)) throw new PendingAuthAdmissionError(Object.assign(Error("Submitted account is not in the current pool"), {code: "ESTALE"}));
	const journalRevision = captureAuthorityRevision([getPendingAuthPath(storagePath)]);
	const journal = (): PendingAuth[] => {
		try {return fileSchema.parse(JSON.parse(readFileSync(getPendingAuthPath(storagePath), "utf8"))).entries;}
		catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new PendingAuthAdmissionError(error);}
	};
	const entries = journal();
	const credentials = (owner: RefreshOwner) => "type" in owner ? [owner.access, owner.refresh, owner.expires]
		: ["index" in owner ? owner.access : owner.accessToken, owner.refreshToken, "index" in owner ? owner.expires : owner.expiresAt];
	for (const {row} of roots) {
		if (!row) continue;
		const effective = overlayPendingAuth({version: 3, accounts: [structuredClone(row)], activeIndex: 0}, entries).accounts[0];
		if (!effective) throw new PendingAuthAdmissionError(Object.assign(Error("Recovery owner is absent"), {code: "ESTALE"}));
		const rawMatches = credentials(row).every((value, index) => value === credentials(submitted)[index]);
		const authorization = rawMatches ? row : effective;
		if (!rawMatches && !credentials(effective).every((value, index) => value === credentials(submitted)[index]) ||
			!("type" in submitted) && ((row.recordId && row.recordId !== submitted.recordId) || (row.enabled === false) !== (submitted.enabled === false) ||
				authorization.authInvalidatedAt !== submitted.authInvalidatedAt || authorization.authInvalidationErrorCode !== submitted.authInvalidationErrorCode ||
				row.accountId !== submitted.accountId || JSON.stringify(row.workspaces) !== JSON.stringify(submitted.workspaces) || row.currentWorkspaceIndex !== submitted.currentWorkspaceIndex)) {
			throw new PendingAuthAdmissionError(Object.assign(Error("Submitted account is no longer current"), {code: "ESTALE"}));
		}
	}
	return result => {
		const owner = retainAccount();
		if (!owner || !current() || !resetCurrent() || (ambientPath === storagePath && getStoragePath() !== ambientPath)) return false;
		try {
			if (JSON.stringify(getAccountsBackupRecoveryCandidatesWithDiscoverySync(storagePath)) !== JSON.stringify(accountBackups)) return false;
		} catch (error) { throw new PendingAuthAdmissionError(error); }
		const live = refreshBinding(owner);
		const same = (expected: unknown[]) => live.every((value, index) => value === expected[index]);
		if (!same(refreshBinding(submitted)) && !(result && same(refreshBinding(submitted, result)))) return false;
		if (!journalRevision()) {
			const pending = journal();
			for (const {path, row} of roots) {
				const disk = sample(path, result);
				if (!row || !disk) return false;
				const effective = overlayPendingAuth({version: 3, accounts: [disk], activeIndex: 0}, pending).accounts[0];
				if (!effective) return false;
				const actual = refreshBinding(effective);
				if (!actual.every((value, index) => value === refreshBinding(row)[index]) &&
					!(result && actual.every((value, index) => value === refreshBinding(row, result)[index]))) return false;
			}
		}
		if (revision()) return true;
		if (!roots.length || revalidated) return false;
		const nextRevision = captureAuthorityRevision(paths, [getIntentionalResetMarkerPath(storagePath)]);
		const valid = sampledRoots.every(({path, row}) => {
			const disk = sample(path, result);
			if (!row) {
				if (!disk) return true;
				const actual = refreshBinding(disk);
				return actual.every((value, index) => value === refreshBinding(submitted)[index]) ||
					!!result && actual.every((value, index) => value === refreshBinding(submitted, result)[index]);
			}
			if (!disk) return false;
			const expected = refreshBinding(row), actual = refreshBinding(disk);
			return actual.every((value, index) => value === expected[index]) || !!result && actual.every((value, index) => value === refreshBinding(row, result)[index]);
		});
		if (!valid || !nextRevision()) return false;
		revision = nextRevision;
		revalidated = true;
		return true;
	};
}

export async function withRefreshCredentialRetention<T extends TokenResult>(
	account: RefreshOwner,
	operation: () => Promise<T>,
	current: () => boolean = () => true,
	retainAccount: () => typeof account | null = () => account,
	storagePath = getStoragePath(),
): Promise<T> {
	const authorityCurrent = captureRefreshCredentialAuthority(account, current, retainAccount, storagePath);
	try {
		const result = await operation();
		const tokenResult: TokenResult = result;
		const credential = tokenResult.type === "success" ? tokenResult : undefined;
		if (!authorityCurrent(credential)) throw new PendingAuthAdmissionError(Object.assign(Error("Account authority changed during refresh"), {code: "ESTALE"}));
		return result;
	} catch (error) {
		const owner = retainAccount();
		let retain = false;
		try { retain = error instanceof PendingAuthSettlementError && error.authorityCurrent() && authorityCurrent(error.result); } catch { retain = false; }
		if (owner && error instanceof PendingAuthSettlementError && retain) {
			if ("type" in owner) {
				owner.access = error.result.access;
				owner.refresh = error.result.refresh;
				owner.expires = error.result.expires;
			} else if ("index" in owner) {
				owner.access = error.result.access;
				owner.refreshToken = error.result.refresh;
				owner.expires = error.result.expires;
			} else {
				owner.accessToken = error.result.access;
				owner.refreshToken = error.result.refresh;
				owner.expiresAt = error.result.expires;
			}
		}
		throw error;
	}
}

export async function withPendingAuthRefresh(
	storagePath: string,
	refreshToken: string,
	refresh: () => Promise<TokenResult>,
	settlement?: PendingAuthSettlementError,
): Promise<TokenResult> {
	const current = captureAuthorityRevision([storagePath], [getIntentionalResetMarkerPath(storagePath)]);
	return withFileTransactionLock(storagePath, () => withFileTransactionLock(getPendingAuthPath(storagePath), async () => {
		if (!current()) throw Object.assign(Error("Account pool was reset"), {code: "ESTALE"});
		let primary: AccountStorageV3 | null = null;
		try {
			const stored = AnyAccountStorageSchema.parse(JSON.parse(await fs.readFile(storagePath, "utf8")));
			primary = stored.version === 3 ? stored : migrateV1ToV3(stored);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PendingAuthCapacityError({cause: error});
		}
		const entries = await read(getPendingAuthPath(storagePath));
		const effective = await applyPendingAuth(storagePath, primary, entries);
		const owner = effective?.accounts.find(row => row.refreshToken === refreshToken);
		if (settlement && !settlement.authorityCurrent()) {
			const captured = settlement.owner;
			const row = captured && primary?.accounts.find(account => captured.recordId
				? account.recordId === captured.recordId : account.refreshToken === captured.refreshToken);
			const sameAuthority = captured && row && row.accountId === captured.accountId && row.enabled === captured.enabled &&
				row.authInvalidatedAt === captured.authInvalidatedAt && row.authInvalidationErrorCode === captured.authInvalidationErrorCode;
			const sameCredential = captured && row && row.accessToken === captured.accessToken && row.refreshToken === captured.refreshToken && row.expiresAt === captured.expiresAt;
			const settledCredential = row && row.accessToken === settlement.result.access && row.refreshToken === settlement.result.refresh && row.expiresAt === settlement.result.expires;
			if (!sameAuthority || (!sameCredential && !settledCredential)) throw settlement;
		}
		const prior = hash(refreshToken);
		const retained = entries.find(entry => entry.prior === prior && entry.refreshToken !== refreshToken);
		if (!current()) throw Object.assign(Error("Account authority changed before refresh"), {code: "ESTALE"});
		if (retained) return {type: "success", access: retained.accessToken, refresh: retained.refreshToken, expires: retained.expiresAt};
		await trimToCapacity(storagePath, entries, prior, entries.some(entry => entry.prior === prior) ? 0 : 1);
		if (!current()) throw Object.assign(Error("Account authority changed before refresh"), {code: "ESTALE"});
		const result = await refresh();
		if (result.type !== "success") return result;
		try {
			if (!current()) throw Object.assign(Error("Account authority changed during refresh"), {code: "ESTALE"});
			const journaled = await recordPendingAuthLocked(storagePath, {
				priorRefreshToken: refreshToken,
				recordId: owner?.recordId,
				refreshToken: result.refresh,
				accessToken: result.access,
				expiresAt: result.expires,
				enabled: owner?.enabled === false ? false : undefined,
				authInvalidatedAt: owner?.accessToken === result.access && owner.refreshToken === result.refresh && owner.expiresAt === result.expires ? owner.authInvalidatedAt : undefined,
				authInvalidationErrorCode: owner?.accessToken === result.access && owner.refreshToken === result.refresh && owner.expiresAt === result.expires ? owner.authInvalidationErrorCode : undefined,
				at: Date.now(),
			}, entries.find(entry => entry.prior === prior));
			if (journaled.refreshToken === result.refresh && journaled.accessToken === result.access && journaled.expiresAt === result.expires) return result;
			return {...result, refresh: journaled.refreshToken, access: journaled.accessToken, expires: journaled.expiresAt};
		} catch (cause) {
			throw new PendingAuthSettlementError(result, cause, current, owner ? structuredClone(owner) : undefined);
		}
	}));
}

/** Record a rotated credential beside the account pool. */
export async function recordPendingAuth(
	storagePath: string,
	auth: Omit<PendingAuth, "prior" | "committed"> & {priorRefreshToken: string},
): Promise<Omit<PendingAuth, "prior">> {
	return withFileTransactionLock(getPendingAuthPath(storagePath), () => recordPendingAuthLocked(storagePath, auth));
}

async function recordPendingAuthLocked(
	storagePath: string,
	auth: Parameters<typeof recordPendingAuth>[1],
	observed?: PendingAuth,
): Promise<Omit<PendingAuth, "prior">> {
	const path = getPendingAuthPath(storagePath);
	try {
		await fs.stat(getIntentionalResetMarkerPath(storagePath));
		throw Object.assign(new Error("Account pool was reset; rotated credentials were not retained."), {code:"ESTALE"});
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const prior = hash(auth.priorRefreshToken);
	const existing = await read(path);
	const authorities = existing.filter(entry => entry.committed).map(entry => ({...entry}));
	const recorded = existing.find(entry => entry.prior === prior);
	// Pruning can remove intermediate aliases, not this predecessor's authoritative mapping.
	const spentObservedCredential = recorded && observed && recorded.refreshToken === auth.priorRefreshToken &&
		JSON.stringify(recorded) === JSON.stringify(observed);
	const credential = recorded && !spentObservedCredential && !isNewerCredential(auth, recorded) ? recorded : auth;
	let retained: Omit<PendingAuth, "prior"> = {...credential, ...mergeAuthorization(credential, [auth, ...(recorded ? [recorded] : [])])};
	const followed = new Set<string>();
	for (let next = existing.find(entry => entry.prior === hash(retained.refreshToken)); next; next = existing.find(entry => entry.prior === hash(retained.refreshToken))) {
		if (next.prior === prior && spentObservedCredential) break;
		if (followed.has(next.prior)) throw Error("Cyclic pending credential rotation");
		followed.add(next.prior);
		const sameToken = next.refreshToken === retained.refreshToken;
		const credential = sameToken && isNewerCredential(retained, next) ? retained : next;
		retained = {...credential, ...mergeAuthorization(credential, [retained, next])};
		if (sameToken) break;
	}
	const replacement: Omit<PendingAuth, "prior"> = {recordId: retained.recordId ?? auth.recordId ?? recorded?.recordId, refreshToken: retained.refreshToken, accessToken: retained.accessToken, expiresAt: retained.expiresAt, ...mergeAuthorization(retained, [retained]), at: retained.at};
	replacement.committed = undefined;
	const entries = existing.filter(
		(entry) => entry.prior !== prior && (entry.prior !== hash(replacement.refreshToken) || entry.refreshToken === replacement.refreshToken),
	);
	// Rotating a token that is itself only journaled: extend that entry to the
	// newest credential, but ALSO keep an entry keyed by the token this
	// rotation just spent. A backup slot or WAL can still hold that
	// intermediate token, and pruning now keeps entries whose spent token any
	// recovery source can surface — a stale-snapshot restore then self-heals
	// straight to the newest credential instead of reviving a spent token.
	const chained = entries.filter(entry => entry.refreshToken === auth.priorRefreshToken);
	Object.assign(replacement, mergeAuthorization(replacement, [replacement, ...chained]));
	for (const entry of chained) Object.assign(entry, {...replacement, recordId: entry.recordId ?? replacement.recordId});
	const aliases = entries.filter(entry => entry.refreshToken === replacement.refreshToken);
	Object.assign(replacement, mergeAuthorization(replacement, [replacement, ...aliases]));
	const identities = new Set(aliases.map(entry => entry.recordId).filter(id => id !== undefined));
	if (identities.size === 1) replacement.recordId ??= identities.values().next().value;
	const committedFor = (candidate: Omit<PendingAuth, "prior">): PendingAuth["committed"] => authorities.some(authority =>
		(auth.recordId === undefined || auth.recordId === authority.recordId) && candidate.recordId === authority.recordId &&
		candidate.refreshToken === authority.refreshToken && candidate.accessToken === authority.accessToken && candidate.expiresAt === authority.expiresAt &&
		candidate.authInvalidatedAt === authority.authInvalidatedAt && candidate.authInvalidationErrorCode === authority.authInvalidationErrorCode &&
		(candidate.enabled === false) === (authority.enabled === false)) ? true : undefined;
	replacement.committed = committedFor(replacement);
	for (const entry of aliases) {
		const updated = {...replacement, recordId: entry.recordId ?? replacement.recordId};
		Object.assign(entry, {...updated, committed: committedFor(updated)});
	}
	const current: PendingAuth = {prior, ...replacement};
	entries.push(current);
	await write(path, await trimToCapacity(storagePath, entries, prior));
	return replacement;
}

/** Overlay pending rotated credentials on rows that still hold the spent token. */
export async function applyPendingAuth(
	storagePath: string,
	storage: AccountStorageV3 | null,
	entries?: Awaited<ReturnType<typeof capturePendingAuth>>["entries"],
	options: {source?: "historical-recovery"} = {},
): Promise<AccountStorageV3 | null> {
	if (!storage) return storage;
	try {
		entries ??= await read(getPendingAuthPath(storagePath));
	} catch (error) {
		log.error("Pending rotated credentials could not be read; affected accounts may need a re-login if this persists", {
			path: getPendingAuthPath(storagePath),
			code: typeof (error as NodeJS.ErrnoException).code === "string" && /^[A-Z_]{1,40}$/.test((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code : "INVALID_PENDING_AUTH",
		});
		throw new PendingAuthObservationError();
	}
	return overlayPendingAuth(storage, entries, options);
}

function overlayPendingAuth(storage: AccountStorageV3, entries: PendingAuth[], options: {source?: "historical-recovery"} = {}): AccountStorageV3 {
	if (!entries.length) return storage;
	for (const account of storage.accounts) {
		const entry = account.refreshToken ? entries.find((item) => item.prior === hash(account.refreshToken)) : undefined;
		if (!entry) continue;
		account.recordId ??= entry.recordId;
		const replacesCredential = account.accessToken !== entry.accessToken || account.refreshToken !== entry.refreshToken || account.expiresAt !== entry.expiresAt;
		const authorization = options.source === "historical-recovery" && entry.committed
			? mergeAuthorization(entry, [entry])
			: mergeAuthorization(entry, [entry, {...account, enabled: account.enabled === false ? false : undefined}]);
		account.refreshToken = entry.refreshToken;
		account.accessToken = entry.accessToken;
		account.expiresAt = entry.expiresAt;
		account.authInvalidatedAt = authorization.authInvalidatedAt;
		account.authInvalidationErrorCode = authorization.authInvalidationErrorCode;
		if (options.source === "historical-recovery" && entry.committed) account.enabled = authorization.enabled;
		else if (authorization.enabled === false) account.enabled = false;
		if (!account.authInvalidatedAt && account.cooldownReason === "auth-failure" &&
			(replacesCredential || (options.source === "historical-recovery" && entry.committed))) {
			delete account.coolingDownUntil;
			delete account.cooldownReason;
		}
	}
	return storage;
}

/**
 * After a save, drop entries whose spent token is no longer in any restorable
 * state. `saved` is the primary content just persisted; callers may also
 * supply `restorableRefreshTokens` — refresh tokens still present in recovery
 * sources (rotating/discovered backups, a WAL payload) — since a restore can
 * resurface a spent token, its entry must survive until no source holds it.
 * A scan failure keeps every entry: retention is the safe direction.
 */
export async function prunePendingAuth(
	storagePath: string,
	saved: AccountStorageV3,
	restorableRefreshTokens?: () => Promise<Iterable<string | PendingAuthRecoveryCredential>>,
	observed?: Awaited<ReturnType<typeof capturePendingAuth>>,
): Promise<void> {
	const path = getPendingAuthPath(storagePath);
	const current = await read(path);
	if (!current.length) return;
	await withFileTransactionLock(path, async () => {
		const spent = new Set(saved.accounts.map((account) => hash(account.refreshToken)));
		const recovery: Array<string | PendingAuthRecoveryCredential> = [];
		let scanFailed = false;
		if (restorableRefreshTokens) {
			try {
				for (const source of await restorableRefreshTokens()) {
					recovery.push(source);
					spent.add(hash(typeof source === "string" ? source : source.refreshToken));
				}
			} catch (error) {
				log.warn("Recovery-source scan failed; keeping all pending rotated credentials", {
					code: typeof (error as NodeJS.ErrnoException).code === "string" && /^[A-Z_]{1,40}$/.test((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code : "UNKNOWN",
				});
				scanFailed = true;
			}
		}
		const entries = await read(path);
		const unchanged = (entry: PendingAuth) => {
			const previous = (observed?.entries ?? current).find(row => row.prior === entry.prior);
			return previous !== undefined && JSON.stringify({...entry, at: 0}) === JSON.stringify({...previous, at: 0});
		};
		const concurrent = new Set(entries.filter(entry => !unchanged(entry)));
		const committedEntries = new Set<PendingAuth>();
		let changed = false;
		for (const entry of entries) {
			if (!observed || concurrent.has(entry)) continue;
			const known = observed.accounts.find(account => {
				const effective = mergeAuthorization(entry, [entry, {...account, enabled: account.enabled === false ? false : undefined}]);
				return account.refreshToken === entry.refreshToken && account.accessToken === entry.accessToken && account.expiresAt === entry.expiresAt &&
					account.authInvalidatedAt === effective.authInvalidatedAt && account.authInvalidationErrorCode === effective.authInvalidationErrorCode &&
					(account.enabled === false) === (effective.enabled === false) && (!entry.recordId || entry.recordId === account.recordId);
			});
			if (!known) continue;
			const committed = saved.accounts.find(account => known.recordId && account.recordId ? known.recordId === account.recordId : known.refreshToken === account.refreshToken);
			if (!committed?.accessToken || committed.expiresAt === undefined) continue;
			const before = JSON.stringify(entry);
			Object.assign(entry, {recordId: committed.recordId ?? entry.recordId, refreshToken: committed.refreshToken, accessToken: committed.accessToken, expiresAt: committed.expiresAt,
				authInvalidatedAt: committed.authInvalidatedAt, authInvalidationErrorCode: committed.authInvalidationErrorCode, enabled: committed.enabled === false ? false : undefined, committed: true});
			committedEntries.add(entry);
			changed ||= before !== JSON.stringify(entry);
		}
		const remaining = entries.filter(entry => {
			if (scanFailed || concurrent.has(entry)) return true;
			if (committedEntries.has(entry) && entry.prior === hash(entry.refreshToken) && saved.accounts.some(account => account.refreshToken === entry.refreshToken && account.accessToken === entry.accessToken && account.expiresAt === entry.expiresAt)) {
				return recovery.some(source => typeof source === "string" ? hash(source) === entry.prior : hash(source.refreshToken) === entry.prior && (
					source.accessToken !== entry.accessToken || source.expiresAt !== entry.expiresAt ||
					source.authInvalidatedAt !== entry.authInvalidatedAt || source.authInvalidationErrorCode !== entry.authInvalidationErrorCode ||
					(source.enabled === false) !== (entry.enabled === false) ||
					(source.cooldownReason === "auth-failure" && !entry.authInvalidatedAt)
				));
			}
			return spent.has(entry.prior);
		});
		if (changed || remaining.length !== entries.length) await write(path, remaining);
	});
}

/** Coordinate resets with pending credential writers, including Windows rename locks. */
export async function clearPendingAuth(storagePath: string): Promise<void> {
 const path=getPendingAuthPath(storagePath);
 await withFileTransactionLock(path,()=>withRetry(()=>fs.rm(path,{force:true}),retry));
}
