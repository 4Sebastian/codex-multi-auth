import { stat } from "node:fs/promises";
import { captureAuthorityRevision } from "../storage/authority-revision.js";
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
        const authorityCurrent = captureAuthorityRevision([path, getPendingAuthPath(path)]);
        pending = (async (): Promise<NativeAccountSnapshot> => {
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
                        storage = (await loadAccountsFromPath(path, {normalizeAccountStorage, isRecord})).normalized;
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
