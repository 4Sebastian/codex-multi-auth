/**
 * Refresh Queue Module
 *
 * Prevents race conditions when multiple concurrent requests try to refresh
 * the same account's token simultaneously. Instead of firing parallel refresh
 * requests, subsequent callers await the existing in-flight refresh.
 *
 * Ported from antigravity-auth refresh-queue.ts pattern.
 */

import { createHash } from "node:crypto";
import { refreshAccessToken } from "./auth/auth.js";
import type { TokenResult } from "./types.js";
import { createLogger } from "./logger.js";
import { RefreshLeaseCoordinator, DEFAULT_WAIT_TIMEOUT_MS } from "./refresh-lease.js";
import { isAbortError } from "./utils.js";
import { MAX_PENDING_AUTH_ENTRIES, PendingAuthAdmissionError, PendingAuthLocalError, PendingAuthCapacityError, PendingAuthSettlementError, withPendingAuthRefresh, captureQueuedRefreshAuthority, type FlaggedRefreshSource } from "./storage/pending-auth.js";
import { getStoragePath } from "./storage.js";
import { captureAuthorityRevision } from "./storage/authority-revision.js";
import { getIntentionalResetMarkerPath } from "./storage/backup-paths.js";

const log = createLogger("refresh-queue");

/**
 * Extra headroom beyond the lease wait budget before an acquire-stage entry is
 * treated as genuinely stuck. A lease acquire() polls on an interval and does
 * filesystem work, so it can overshoot its wait deadline slightly; this slack
 * keeps cleanup from evicting an acquire that is still legitimately waiting.
 */
const ACQUIRE_EVICTION_SLACK_MS = 5_000;

/**
 * Non-reversible correlation fingerprint for a token, for logs.
 *
 * Logging the trailing characters of a refresh token (`token.slice(-6)`) leaks
 * recoverable secret material into 0600 log files. A short SHA-256 prefix gives
 * the same cross-log correlation ("is this the same token?") without exposing
 * any part of the token itself.
 */
function tokenFingerprint(token: string): string {
  if (!token) return "none";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Entry representing an in-flight token refresh operation.
 */
type RefreshEntry = {
  promise: Promise<TokenResult>;
  startedAt: number;
  acquireEvictionAgeMs: number;
  generation: number;
  staleWarningLogged?: boolean;
} & (
  | { stage: "acquire" | "refresh" }
  | { stage: "unsettled"; error: PendingAuthSettlementError; token: string }
);

/**
 * Manages queued token refresh operations to prevent race conditions.
 *
 * When multiple concurrent requests need to refresh the same account's token,
 * only the first request triggers the actual refresh. Subsequent requests
 * await the same promise, ensuring:
 * - No duplicate refresh API calls for the same refresh token
 * - Consistent token state across all waiting callers
 * - Reduced load on OpenAI's token endpoint
 *
 * Token Rotation Handling:
 * When OpenAI rotates the refresh token during a refresh operation, we maintain
 * a mapping from old token → new token. This ensures that requests arriving with
 * either the old or new token will find the in-flight refresh and not trigger
 * duplicate refreshes.
 *
 * @example
 * ```typescript
 * const queue = new RefreshQueue();
 *
 * // These three concurrent calls will only trigger ONE actual refresh
 * const [result1, result2, result3] = await Promise.all([
 *   queue.refresh(refreshToken),
 *   queue.refresh(refreshToken),
 *   queue.refresh(refreshToken),
 * ]);
 *
 * // All three get the same result
 * console.log(result1 === result2); // true (same object reference)
 * ```
 */
export class RefreshQueue {
  private static pending: Map<string, RefreshEntry> = new Map();
  private get pending() { return RefreshQueue.pending; }
  private readonly leaseCoordinator: RefreshLeaseCoordinator;
  private static nextGeneration = 0;
  
  /**
   * Maps old refresh tokens to new tokens after rotation.
   * This allows lookups with either old or new token to find the same entry.
   * Format: oldToken → newToken
   */
  private static tokenRotationMap: Map<string, string> = new Map();
  private get tokenRotationMap() { return RefreshQueue.tokenRotationMap; }

  /**
   * Age threshold for stale pending refresh operations.
   */
  private readonly maxEntryAgeMs: number;

  /**
   * Create a new RefreshQueue instance.
   * @param maxEntryAgeMs - Maximum age for pending entries before cleanup (default: 30s)
   */
  constructor(
    maxEntryAgeMs: number = 30_000,
    leaseCoordinator: RefreshLeaseCoordinator = RefreshLeaseCoordinator.fromEnvironment(),
  ) {
    this.maxEntryAgeMs = maxEntryAgeMs;
    this.leaseCoordinator = leaseCoordinator;
  }

  /**
   * Refresh a token, deduplicating concurrent requests for the same refresh token.
   *
   * If a refresh is already in-flight for this token, returns the existing promise.
   * Otherwise, initiates a new refresh and caches the promise for other callers.
   *
   * @param refreshToken - The refresh token to use
   * @returns Token result (success with new tokens, or failure)
   */
  async refresh(refreshToken: string, storagePath = getStoragePath(), source?: FlaggedRefreshSource): Promise<TokenResult> {
    this.cleanup();
    let token = refreshToken;
    refreshToken = `${storagePath}\0${token}`;
    refreshToken = this.findOriginalToken(refreshToken) ?? refreshToken;
    const existing = this.pending.get(refreshToken);
    const unsettled = existing?.stage === "unsettled" ? existing : undefined;
    if (unsettled) {
      token = unsettled.token;
    }
    let ownerCurrent: ReturnType<typeof captureQueuedRefreshAuthority>;
    try { ownerCurrent = captureQueuedRefreshAuthority(storagePath, existing ? refreshToken.slice(storagePath.length + 1) : token, source, unsettled?.error); }
    catch (error) { throw unsettled?.error ?? error; }

    // Check for existing in-flight refresh (direct match)
    if (existing && !unsettled) {
      log.info("Reusing in-flight refresh for token", {
        tokenSuffix: tokenFingerprint(refreshToken),
        waitingMs: Date.now() - existing.startedAt,
      });
      const result = await existing.promise;
      if (!ownerCurrent(result.type === "success" ? result : undefined)) throw new PendingAuthAdmissionError(Object.assign(Error("Refresh follower authority changed"), {code: "ESTALE"}));
      return result;
    }

    if (!existing && this.pending.size >= MAX_PENDING_AUTH_ENTRIES) throw new PendingAuthCapacityError();

    // Start a new refresh immediately so local state reflects "in-flight"
    // without waiting on cross-process lease checks.
    const startedAt = Date.now();
    const configuredWaitTimeoutMs = this.leaseCoordinator.configuredWaitTimeoutMs;
    const leaseWaitTimeoutMs = typeof configuredWaitTimeoutMs === "number" && Number.isFinite(configuredWaitTimeoutMs)
      ? configuredWaitTimeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
    const acquireEvictionAgeMs = Math.max(this.maxEntryAgeMs, leaseWaitTimeoutMs + ACQUIRE_EVICTION_SLACK_MS);
    const generation = ++RefreshQueue.nextGeneration;
    const markStage = (stage: "acquire" | "refresh") => {
      const entry = this.pending.get(refreshToken);
      if (!entry || entry.generation !== generation) return;
      if (entry.stage !== "unsettled") entry.stage = stage;
      entry.startedAt = Date.now();
      entry.staleWarningLogged = false;
    };
    const getSupersedingPromise = (): Promise<TokenResult> | undefined => {
      const current = this.pending.get(refreshToken);
      if (!current || current.generation === generation) {
        return undefined;
      }
      log.info("Refresh generation superseded; joining newer in-flight refresh", {
        tokenSuffix: tokenFingerprint(refreshToken),
        staleGeneration: generation,
        activeGeneration: current.generation,
      });
      return current.promise;
    };
    const authorityCurrent = captureAuthorityRevision([storagePath], [getIntentionalResetMarkerPath(storagePath)]);
    const promise = (async (): Promise<TokenResult> => {
      let lease: Awaited<ReturnType<RefreshLeaseCoordinator["acquire"]>> | undefined;
      try {
        if (!authorityCurrent()) throw Object.assign(Error("Account pool was reset"), {code: "ESTALE"});
        try {
          lease = await this.leaseCoordinator.acquire(refreshToken);
        } catch (error) {
          log.warn("Refresh lease acquire failed; falling back to local refresh", {
            tokenSuffix: tokenFingerprint(token),
            error: (error as Error)?.message ?? String(error),
          });
        }
        const supersedingPromise = getSupersedingPromise();
        if (supersedingPromise) return supersedingPromise;
        markStage("refresh");
        const cached = unsettled?.error.result ?? (lease?.role === "follower" ? lease.result : undefined);
        if (!authorityCurrent()) throw Object.assign(Error("Account authority changed before refresh"), {code: "ESTALE"});
        const result = await withPendingAuthRefresh(storagePath, token, () =>
          cached ? Promise.resolve(cached) : this.executeRefreshWithRotationTracking(token, storagePath), unsettled?.error, source);
        if (!ownerCurrent(result.type === "success" ? result : undefined)) throw new PendingAuthAdmissionError(Object.assign(Error("Refresh publication authority changed"), {code: "ESTALE"}));
        try {
          await lease?.release(result);
        } catch (error) {
          log.warn("Failed to publish lease refresh result", {
            tokenSuffix: tokenFingerprint(token),
            error: (error as Error)?.message ?? String(error),
          });
        }
        return result;
      } catch (error) {
        if (unsettled || error instanceof PendingAuthSettlementError) {
          const firstError = unsettled?.error ?? error;
          if (firstError instanceof PendingAuthSettlementError) {
            const entry = this.pending.get(refreshToken);
            if (entry?.generation === generation) this.pending.set(refreshToken, {...entry, stage: "unsettled", error: firstError, token});
            throw firstError;
          }
        }
        throw error instanceof PendingAuthLocalError ? error : new PendingAuthAdmissionError(error);
      } finally {
        try {
          await lease?.release();
        } catch (error) {
          log.warn("Failed to release refresh lease", {
            tokenSuffix: tokenFingerprint(token),
            error: (error as Error)?.message ?? String(error),
          });
        }
      }
    })();
    this.pending.set(refreshToken, {
      promise,
      startedAt,
      acquireEvictionAgeMs,
      stage: unsettled ? "refresh" : "acquire",
      generation,
    });

    try {
      const result = await promise;
      if (!ownerCurrent(result.type === "success" ? result : undefined)) throw new PendingAuthAdmissionError(Object.assign(Error("Refresh owner authority changed"), {code: "ESTALE"}));
      return result;
    } finally {
      const entry = this.pending.get(refreshToken);
      if (!entry || (entry.generation === generation && entry.stage !== "unsettled")) {
        this.pending.delete(refreshToken);
        this.cleanupRotationMapping(refreshToken);
      }
    }
  }

  /** Retain an already-spent result for persistence-only retry in the bounded queue. */
  retainSettlement(storagePath: string, priorRefreshToken: string, error: PendingAuthSettlementError): void {
    const key = `${storagePath}\0${priorRefreshToken}`;
    if (this.pending.has(key)) throw new PendingAuthAdmissionError(new Error("A refresh already owns this credential"));
    if (this.pending.size >= MAX_PENDING_AUTH_ENTRIES) throw new PendingAuthCapacityError();
    const promise = Promise.reject<TokenResult>(error);
    void promise.catch(() => undefined);
    this.pending.set(key, {stage: "unsettled", error, token: priorRefreshToken, promise,
      startedAt: Date.now(), acquireEvictionAgeMs: this.maxEntryAgeMs, generation: ++RefreshQueue.nextGeneration});
    this.tokenRotationMap.set(key, `${storagePath}\0${error.result.refresh}`);
  }

  /** No entry means no retry and, importantly, no OAuth request. */
  retrySettlement(storagePath: string, credential: {access: string | undefined; refresh: string; expires: number | undefined}): Promise<TokenResult> | undefined {
    const key = `${storagePath}\0${credential.refresh}`;
    const entry = this.pending.get(this.findOriginalToken(key) ?? key);
    if (entry?.stage !== "unsettled" || entry.error.result.access !== credential.access ||
      entry.error.result.refresh !== credential.refresh || entry.error.result.expires !== credential.expires) return undefined;
    return this.refresh(credential.refresh, storagePath);
  }

  private findOriginalToken(newToken: string): string | undefined {
    for (const [oldToken, mappedNewToken] of this.tokenRotationMap.entries()) {
      if (mappedNewToken === newToken && this.pending.has(oldToken)) {
        return oldToken;
      }
    }
    return undefined;
  }

  private cleanupRotationMapping(token: string): void {
    this.tokenRotationMap.delete(token);
    for (const [oldToken, newToken] of this.tokenRotationMap.entries()) {
      if (newToken === token) {
        this.tokenRotationMap.delete(oldToken);
      }
    }
  }

  private async executeRefreshWithRotationTracking(refreshToken: string, storagePath: string): Promise<TokenResult> {
    const result = await this.executeRefresh(refreshToken);
    
    if (result.type === "success" && result.refresh !== refreshToken) {
      this.tokenRotationMap.set(`${storagePath}\0${refreshToken}`, `${storagePath}\0${result.refresh}`);
      log.info("Token rotated during refresh", {
        oldTokenSuffix: tokenFingerprint(refreshToken),
        newTokenSuffix: tokenFingerprint(result.refresh),
      });
    }
    
    return result;
  }

  /**
   * Execute the actual refresh and log results.
   */
  private async executeRefresh(refreshToken: string): Promise<TokenResult> {
    const startTime = Date.now();
    log.info("Starting token refresh", { tokenSuffix: tokenFingerprint(refreshToken) });
    const timeoutMs = Math.max(1_000, this.maxEntryAgeMs);
    const timeoutController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutErrorMessage = `Refresh timeout after ${timeoutMs}ms`;
      const timeoutPromise = new Promise<TokenResult>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = new Error(timeoutErrorMessage) as Error & { code?: string };
          timeoutError.name = "AbortError";
          timeoutError.code = "ABORT_ERR";
          timeoutController.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });
      const refreshPromise = refreshAccessToken(refreshToken, {
        signal: timeoutController.signal,
      });
      const result = await Promise.race([refreshPromise, timeoutPromise]);
      const duration = Date.now() - startTime;

      if (result.type === "success") {
        log.info("Token refresh succeeded", {
          tokenSuffix: tokenFingerprint(refreshToken),
          durationMs: duration,
        });
      } else {
        log.warn("Token refresh failed", {
          tokenSuffix: tokenFingerprint(refreshToken),
          reason: result.reason,
          durationMs: duration,
        });
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      if (isAbortError(error)) {
        log.warn("Token refresh aborted", {
          tokenSuffix: tokenFingerprint(refreshToken),
          error: (error as Error)?.message ?? String(error),
          durationMs: duration,
        });
        return {
          type: "failed",
          reason: "unknown",
          message: (error as Error)?.message ?? "Refresh aborted",
        };
      }
      log.error("Token refresh threw exception", {
        tokenSuffix: tokenFingerprint(refreshToken),
        error: (error as Error)?.message ?? String(error),
        durationMs: duration,
      });

      return {
        type: "failed",
        reason: "network_error",
        message: (error as Error)?.message ?? "Unknown error during refresh",
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Cleanup stale entries that have been pending too long.
   * Acquire-stage entries are evicted to prevent deadlocked refresh lanes.
   */
  private cleanup(): void {
    const now = Date.now();
    // A lease acquire() can legitimately block up to the coordinator's wait
    // budget. Evicting an acquire-stage entry before that budget elapses would
    // spawn a duplicate refresh whose refresh token OpenAI has already rotated on
    // first use (invalid_grant). So an acquire-stage entry is only evicted once it
    // exceeds BOTH the configured max age AND the lease wait budget plus slack —
    // never merely maxEntryAgeMs, which can be shorter than the wait budget.
    //
    // Read the budget the coordinator was actually CONFIGURED with (constructor
    // option / CODEX_AUTH_REFRESH_LEASE_WAIT_MS) rather than the static default:
    // under a larger configured budget the default would evict too early. An
    // injected test double may not expose the getter, so fall back to the default.
    for (const [token, entry] of this.pending.entries()) {
      if (entry.stage === "unsettled") continue;
      const ageMs = now - entry.startedAt;
      if (entry.stage === "acquire") {
        if (ageMs <= entry.acquireEvictionAgeMs) continue;
        log.warn("Evicting stale refresh entry during lease acquire stage", {
          tokenSuffix: tokenFingerprint(token),
          ageMs,
        });
        this.pending.delete(token);
        this.cleanupRotationMapping(token);
        continue;
      }
      if (ageMs <= this.maxEntryAgeMs) continue;
      if (!entry.staleWarningLogged) {
        log.warn("Refresh entry exceeded stale warning threshold", {
          tokenSuffix: tokenFingerprint(token),
          ageMs,
        });
        entry.staleWarningLogged = true;
      }
    }
  }

  /**
   * Check if there's an in-flight refresh for a given token.
   * @param refreshToken - The refresh token to check
   * @returns True if refresh is in progress
   */
  isRefreshing(refreshToken: string, storagePath = getStoragePath()): boolean {
    const key = `${storagePath}\0${refreshToken}`;
    return this.pending.has(this.findOriginalToken(key) ?? key);
  }

  /**
   * Get the number of pending refresh operations.
   * Useful for debugging and monitoring.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Clear all pending entries (primarily for testing).
   */
  clear(): void {
    RefreshQueue.resetForTests();
  }

  static resetForTests(): void {
    RefreshQueue.pending.clear();
    RefreshQueue.tokenRotationMap.clear();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let refreshQueueInstance: RefreshQueue | null = null;

/**
 * Get the singleton RefreshQueue instance.
 * @param maxEntryAgeMs - Maximum age for pending entries (only used on first call)
 * @returns The global RefreshQueue instance
 */
export function getRefreshQueue(maxEntryAgeMs?: number): RefreshQueue {
  if (!refreshQueueInstance) {
    refreshQueueInstance = new RefreshQueue(maxEntryAgeMs);
  }
  return refreshQueueInstance;
}

/**
 * Reset the singleton instance (primarily for testing).
 */
export function resetRefreshQueue(): void {
  RefreshQueue.resetForTests();
  refreshQueueInstance = null;
}

/**
 * Convenience function to refresh a token using the singleton queue.
 * @param refreshToken - The refresh token to use
 * @returns Token result
 */
export async function queuedRefresh(refreshToken: string, storagePath = getStoragePath(), source?: FlaggedRefreshSource): Promise<TokenResult> {
  return getRefreshQueue().refresh(refreshToken, storagePath, source);
}
