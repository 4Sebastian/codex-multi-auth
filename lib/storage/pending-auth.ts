import { createHash } from "node:crypto";
import { decodeJWT } from "../auth/auth.js";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { withRetry } from "../fs-retry.js";
import { createLogger } from "../logger.js";
import { tempPathFor } from "../temp-path.js";
import { withFileTransactionLock } from "./file-lock.js";
import { getIntentionalResetMarkerPath } from "./backup-paths.js";
import type { AccountMetadataV3, AccountStorageV3 } from "./public-types.js";

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
const MAX_ENTRIES = 1000;
const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
type PendingAuth = z.infer<typeof entrySchema>;
export type PendingAuthRecoveryCredential = Pick<AccountMetadataV3,
	"refreshToken" | "accessToken" | "expiresAt" | "authInvalidatedAt" | "authInvalidationErrorCode" | "enabled" | "cooldownReason">;
const retry = { maxAttempts: 6, backoffMs: 25 };
const log = createLogger("pending-auth");

export function getPendingAuthPath(storagePath: string): string {
	return `${storagePath}.pending-auth.json`;
}

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
function mergeAuthorization(accessToken: string, sources: Array<Authorization & {accessToken?: string}>): Authorization {
	const invalidated = sources.filter(source => source.authInvalidatedAt && source.accessToken === accessToken)
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

export class PendingAuthObservationError extends Error {
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

/** Record a rotated credential beside the account pool. */
export async function recordPendingAuth(
	storagePath: string,
	auth: Omit<PendingAuth, "prior" | "committed"> & {priorRefreshToken: string},
): Promise<Omit<PendingAuth, "prior">> {
	const path = getPendingAuthPath(storagePath);
	return withFileTransactionLock(path, async () => {
        try {
            await fs.stat(getIntentionalResetMarkerPath(storagePath));
            throw Object.assign(new Error("Account pool was reset; rotated credentials were not retained."), {code:"ESTALE"});
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const prior = hash(auth.priorRefreshToken);
		const existing = await read(path);
		const authorities = existing.filter(entry => entry.committed).map(entry => ({...entry}));
		const recorded = existing.find(entry => entry.prior === prior);
		// Pruning can remove intermediate aliases, not this predecessor's authoritative mapping.
		const credential = recorded && !isNewerCredential(auth, recorded) ? recorded : auth;
		let retained: Omit<PendingAuth, "prior"> = {...credential, ...mergeAuthorization(credential.accessToken, [auth, ...(recorded ? [recorded] : [])])};
		const followed = new Set<string>();
		for (let next = existing.find(entry => entry.prior === hash(retained.refreshToken)); next; next = existing.find(entry => entry.prior === hash(retained.refreshToken))) {
			if (followed.has(next.prior)) throw Error("Cyclic pending credential rotation");
			followed.add(next.prior);
			const sameToken = next.refreshToken === retained.refreshToken;
			const credential = sameToken && isNewerCredential(retained, next) ? retained : next;
			retained = {...credential, ...mergeAuthorization(credential.accessToken, [retained, next])};
			if (sameToken) break;
		}
		const replacement: Omit<PendingAuth, "prior"> = {recordId: retained.recordId ?? auth.recordId ?? recorded?.recordId, refreshToken: retained.refreshToken, accessToken: retained.accessToken, expiresAt: retained.expiresAt, ...mergeAuthorization(retained.accessToken, [retained]), at: retained.at};
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
		Object.assign(replacement, mergeAuthorization(replacement.accessToken, [replacement, ...chained]));
		for (const entry of chained) Object.assign(entry, {...replacement, recordId: entry.recordId ?? replacement.recordId});
		const aliases = entries.filter(entry => entry.refreshToken === replacement.refreshToken);
		Object.assign(replacement, mergeAuthorization(replacement.accessToken, [replacement, ...aliases]));
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
		const excess = entries.length - MAX_ENTRIES;
		if (excess > 0) {
			// Drop the oldest other entries, never the credential being recorded now.
			const dropped = new Set(entries.filter((entry) => entry !== current).sort((a, b) => a.at - b.at).slice(0, excess));
			log.warn("Pending rotated credentials exceeded the journal cap; dropped the oldest entries", { dropped: dropped.size });
			await write(path, entries.filter((entry) => !dropped.has(entry)));
			return replacement;
		}
		await write(path, entries);
		return replacement;
	});
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
	if (!entries.length) return storage;
	for (const account of storage.accounts) {
		const entry = account.refreshToken ? entries.find((item) => item.prior === hash(account.refreshToken)) : undefined;
		if (!entry) continue;
		account.recordId ??= entry.recordId;
		const replacesCredential = account.accessToken !== entry.accessToken || account.refreshToken !== entry.refreshToken;
		const authorization = options.source === "historical-recovery" && entry.committed
			? mergeAuthorization(entry.accessToken, [entry])
			: mergeAuthorization(entry.accessToken, [entry, {...account, enabled: account.enabled === false ? false : undefined}]);
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
				const effective = mergeAuthorization(entry.accessToken, [entry, {...account, enabled: account.enabled === false ? false : undefined}]);
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
