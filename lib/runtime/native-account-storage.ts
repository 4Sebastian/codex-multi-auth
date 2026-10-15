import { stat } from "node:fs/promises";
import { captureAuthorityRevision } from "../storage/authority-revision.js";
import { getIntentionalResetMarkerPath } from "../storage/backup-paths.js";
import { getStoragePath, normalizeAccountStorage, type AccountStorageV3 } from "../storage.js";
import { loadAccountsFromPath } from "../storage/storage-parser.js";
import { applyPendingAuth, capturePendingAuth, getPendingAuthPath } from "../storage/pending-auth.js";
import { isRecord } from "../utils.js";
export interface NativeAccountSnapshot {
    storage: AccountStorageV3 | null;
    verified: boolean;
    capturedAt: number;
    transientFailure?: boolean;
    /** Independent client auth may retain routing for at most 30 seconds. */
    routingAvailable?: boolean;
}
/** Cache parsed primary storage only; backup recovery must never resurrect revoked credentials. */
export function createNativeAccountStorageReader(read?: () => Promise<AccountStorageV3 | null>, path = getStoragePath()): () => Promise<NativeAccountSnapshot> {
    let cached: AccountStorageV3 | null = null;
    let signature: string | undefined;
    let lastSuccess: number | undefined;
    let pending: Promise<NativeAccountSnapshot> | undefined;
    return () => {
        if (pending) return pending;
        const capturedAt = performance.now();
        const authorityCurrent = captureAuthorityRevision([path, getPendingAuthPath(path)], [getIntentionalResetMarkerPath(path)]);
        pending = (async (): Promise<NativeAccountSnapshot> => {
            if (!authorityCurrent()) {
                cached = null;
                signature = undefined;
                lastSuccess = undefined;
                return {storage: null, verified: false, capturedAt, routingAvailable: false};
            }
            let storage: AccountStorageV3 | null;
            let nextSignature: string | undefined;
            let verified = true;
            try {
                if (!read) {
                    const info = await stat(path);
                    nextSignature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
                    if (cached && nextSignature === signature && Date.now() - Math.max(info.mtimeMs, info.ctimeMs) > 2000) {
                        storage = structuredClone(cached);
                    } else {
                        storage = (await loadAccountsFromPath(path, {normalizeAccountStorage: data => {
                            const normalized = normalizeAccountStorage(data);
                            if (normalized && isRecord(data) && Array.isArray(data.accounts)) {
                                for (const row of normalized.accounts) {
                                    const revoked = data.accounts.find(raw => isRecord(raw) && raw.recordId === row.recordId && raw.accountId === row.accountId && raw.email === row.email && raw.refreshToken === row.refreshToken && raw.accessToken === row.accessToken && raw.expiresAt === row.expiresAt &&
                                        (raw.authInvalidatedAt !== undefined || raw.authInvalidationErrorCode !== undefined));
                                    if (isRecord(revoked)) {
                                        if (revoked.authInvalidatedAt !== undefined && typeof revoked.authInvalidatedAt !== "number" || revoked.authInvalidationErrorCode !== undefined && typeof revoked.authInvalidationErrorCode !== "string") throw new Error("Invalid primary revocation evidence");
                                        row.authInvalidatedAt = revoked.authInvalidatedAt;
                                        row.authInvalidationErrorCode = revoked.authInvalidationErrorCode;
                                    }
                                }
                            }
                            return normalized;
                        }, isRecord})).normalized;
                    }
                } else {
                    storage = await read();
                }
            } catch (error) {
                signature = undefined;
                const code = (error as NodeJS.ErrnoException).code;
                const transientFailure = ["EBUSY", "EPERM", "EACCES"].includes(code ?? "");
                if (!transientFailure) cached = null;
                if (!transientFailure || cached === null || lastSuccess === undefined || performance.now() - lastSuccess >= 30000) {
                    return {storage: null, verified: false, capturedAt, transientFailure, routingAvailable: false};
                }
                storage = structuredClone(cached);
                verified = false;
            }
            try {
                const observed = await capturePendingAuth(path, storage?.accounts);
                const snapshot = await applyPendingAuth(path, structuredClone(storage), observed.entries);
                if (snapshot?.accounts.some(row => (row.authInvalidatedAt !== undefined || row.authInvalidationErrorCode !== undefined) &&
                    (row.authInvalidatedAt === undefined || !Number.isFinite(row.authInvalidatedAt) || row.authInvalidatedAt <= 0))) {
                    cached = null;
                    signature = undefined;
                    lastSuccess = undefined;
                    return {storage: null, verified: false, capturedAt, transientFailure: true, routingAvailable: false};
                }
                if (!verified && (lastSuccess === undefined || performance.now() - lastSuccess >= 30000)) {
                    return {storage: null, verified: false, capturedAt, transientFailure: true, routingAvailable: false};
                }
                if (!authorityCurrent()) {
                    cached = null;
                    lastSuccess = undefined;
                    signature = undefined;
                    return {storage: null, verified: false, capturedAt, transientFailure: true, routingAvailable: false};
                }
                if (verified) {
                    cached = structuredClone(storage);
                    signature = nextSignature;
                    lastSuccess = capturedAt;
                }
                return {storage: snapshot, verified, capturedAt, transientFailure: !verified, routingAvailable: snapshot !== null};
            } catch {
                signature = undefined;
                return {storage: null, verified: false, capturedAt, transientFailure: true, routingAvailable: false};
            }
        })().finally(() => {pending = undefined;});
        return pending;
    };
}
