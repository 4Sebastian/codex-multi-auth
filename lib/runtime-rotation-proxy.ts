import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
	AccountManager,
	AUTH_INVALIDATION_MARKER,
	extractAccountId,
	type ManagedAccount,
} from "./accounts.js";
import { withRoutingMutex } from "./routing-mutex.js";
import {
	getFetchTimeoutMs,
	getNetworkErrorCooldownMs,
	getRetryAllAccountsMaxRetries,
	getServerErrorCooldownMs,
	getSessionAffinity,
	getSessionAffinityMaxEntries,
	getSessionAffinityTtlMs,
	getStreamStallTimeoutMs,
	getMinRotationIntervalMs,
	getTokenInvalidationCooldownMs,
	getTokenRefreshSkewMs,
	getPidOffsetEnabled,
	getPreemptiveQuotaEnabled,
	getPreemptiveQuotaMaxDeferralMs,
	getPreemptiveQuotaRemainingPercent5h,
	getPreemptiveQuotaRemainingPercent7d,
	getContextBudgetGuardEnabled,
	getContextBudgetGuardSoftPercent,
	getContextBudgetGuardHardPercent,
	getContextBudgetGuardModelWindowOverrides,
	getRoutingMutexMode,
	getSchedulingStrategy,
	loadPluginConfig,
} from "./config.js";
import {
	CODEX_BASE_URL,
	HTTP_STATUS,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
	URL_PATHS,
} from "./constants.js";
import { getModelFamily, type ModelFamily } from "./prompts/codex.js";
import { CURRENT_CODEX_MODEL } from "./request/helpers/model-map.js";
import {
	mutateRuntimeObservabilitySnapshot,
	recordRuntimeAccountRecovery,
	recordRuntimePoolExhaustion,
} from "./runtime/runtime-observability.js";
import {
	createRuntimeUsageRecorder,
	evaluateRuntimePolicy,
	loadRuntimePolicyState,
	type RuntimePolicyDecision,
	type RuntimeUsageRecorder,
} from "./policy/runtime-policy.js";
import { createUsageStreamScanner } from "./usage/usage-extraction.js";
import {
	isModelAtCapacityError,
	isWorkspaceDisabledError,
} from "./request/fetch-helpers.js";
import {
	PreemptiveQuotaScheduler,
	readQuotaSchedulerSnapshot,
} from "./preemptive-quota-scheduler.js";
import { ContextBudgetGuard } from "./context-budget-guard.js";
import {
	buildContextBudgetHeaders,
	createContextBudgetPauseResponse,
} from "./context-budget-response.js";
import { createLogger, maskString, runWithCorrelationId } from "./logger.js";
import { CodexValidationError } from "./errors.js";
import { normalizeEmailKey } from "./storage/identity.js";
import {
	buildPinnedUnavailableErrorBody,
	buildTokenInvalidationBody,
	extractErrorCodeFromBody,
	isTokenInvalidationError,
	normalizeExhaustionStatus,
	parseRetryAfterBodyMs,
	parseRetryAfterHeaderMs,
} from "./request/rate-limit-decision.js";
import {
	forwardStreamingResponse,
	HOP_BY_HOP_HEADERS,
	readErrorBody,
	responseHeadersForClient,
	withTimeout,
} from "./request/stream-failover-runtime.js";
import { getAccountRecoveryBoundsForFamily } from "./runtime/account-status.js";
import { chooseAccount } from "./runtime/rotation-account-selection.js";
import {
	createRotationProxyState,
	recoverStaleRuntimeState,
	type RotationProxyState,
} from "./runtime/rotation-proxy-state.js";
import type {
	ExhaustionReason,
	RequestContext,
	RuntimeProxyHttpError,
	RuntimeRotationAccountIdentity,
	RuntimeRotationProxyOptions,
	RuntimeRotationProxyServer,
	RuntimeRotationProxyStatus,
} from "./runtime/rotation-server-types.js";
import { readStorageMetaFromDisk } from "./runtime/rotation-storage-meta.js";
import {
	applyMonotonicAuthCooldown,
	DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
	ensureFreshAccessToken,
} from "./runtime/rotation-token-refresh.js";
import { SessionAffinityStore } from "./session-affinity.js";
import type { RequestBody } from "./types.js";
import { isRecord, sleep } from "./utils.js";

// Re-exports: these symbols were defined in this module before the §4.1.3
// phase-1 and phase-2 carves and are part of its public surface (lib/index.ts
// star-exports this file; tests and scripts import them from here). Keep every
// existing import path working.
export type {
	RuntimeRotationProxyOptions,
	RuntimeRotationProxyServer,
	RuntimeRotationProxyStatus,
} from "./runtime/rotation-server-types.js";
export {
	buildPinnedUnavailableErrorBody,
	buildTokenInvalidationBody,
} from "./request/rate-limit-decision.js";
export type { PinnedUnavailableErrorBody } from "./request/rate-limit-decision.js";
export { chooseAccount } from "./runtime/rotation-account-selection.js";
export {
	maybeInvalidateAffinityFromDisk,
	readPinnedAccountIndexFromDisk,
	readStorageMetaFromDisk,
	resetPinCacheForTesting,
} from "./runtime/rotation-storage-meta.js";
export type { StorageMeta } from "./runtime/rotation-storage-meta.js";

const DEFAULT_HOST = "127.0.0.1";

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "127.0.0.1" ||
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]"
	);
}

// IPv6 literals must be presented in two distinct forms and the proxy
// previously conflated them (runtime-proxy IPv6 bug). Node's
// net.Server.listen(port, host) requires the RAW literal ("::1"); a bracketed
// literal ("[::1]") makes the bind fail or behave wrong. Conversely a URL
// authority requires the BRACKETED literal ("[::1]") so "http://[::1]:port"
// parses unambiguously — the raw form yields the unparseable "http://::1:port".
// Normalize each form ONCE at startup so concurrent rotation paths never race
// on inconsistent host string representations.
function stripIpv6Brackets(host: string): string {
	const trimmed = host.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

// Raw literal suitable for server.listen: "[::1]" -> "::1", others unchanged.
function toBindHost(host: string): string {
	return stripIpv6Brackets(host);
}

// URL authority host: IPv6 literals are bracketed ("::1" -> "[::1]") while
// IPv4 addresses and hostnames (no embedded colon) pass through unchanged.
function toUrlHost(host: string): string {
	const bare = stripIpv6Brackets(host);
	return bare.includes(":") ? `[${bare}]` : bare;
}

// Structured logger for the default-on runtime proxy (errors-logging-01,
// runtime-proxy-04). Previously the 1900-LOC proxy had zero logger integration;
// failures surfaced only as a last-write-wins status.lastError string. Logs are
// level-gated and carry the per-request correlation id set in handleRequest.
const proxyLog = createLogger("runtime-proxy");

/**
 * Pinned skip reasons that no timer clears: the account stays unselectable
 * after any concurrent rate-limit record or cooldown expires, so the pinned
 * 503 must not advertise that record's expiry as a recovery time.
 */
const PINNED_PERMANENT_SKIP_REASONS: ReadonlySet<string> = new Set([
	"missing",
	"disabled",
	"workspace-disabled",
	"policy-blocked",
	AUTH_INVALIDATION_MARKER,
]);
const DEFAULT_QUOTA_REMAINING_THRESHOLD = 10;

/** @internal Stable identity key for in-memory quota snapshots across reloads. */
/**
 * Quota-scheduler key prefix identifying ONE account across every family and
 * model key it owns.
 *
 * The trailing separator is part of the contract: without it the prefix
 * `account:email:foo` also matches `account:email:foobar:codex`, so clearing
 * one account's observations would silently clear a neighbour's.
 */
export function buildQuotaScheduleAccountPrefix(
	account: Pick<ManagedAccount, "accountId" | "email" | "refreshToken"> & {
		/** Stable per-record discriminator retained across token/account-id updates. */
		addedAt?: number;
		recordId?: string;
	},
): string {
	const emailKey = normalizeEmailKey(account.email);
	const accountId = account.accountId?.trim();
	const refreshToken = account.refreshToken?.trim() ?? "";
	const recordId = account.recordId?.trim();
	const recordDiscriminator =
		typeof account.addedAt === "number" &&
		Number.isFinite(account.addedAt) &&
		account.addedAt > 0
			? `:added:${Math.floor(account.addedAt)}`
			: "";
	const accountIdentity = recordId
		? `record:${recordId}`
		: emailKey
		? `email:${emailKey}${recordDiscriminator}`
		: accountId
			? `id:${accountId}${recordDiscriminator}`
			: `refresh:${createHash("sha256").update(refreshToken).digest("hex")}${recordDiscriminator}`;
	return `account:${accountIdentity}:`;
}

export function buildQuotaScheduleKey(
	account: Pick<ManagedAccount, "accountId" | "email" | "refreshToken"> & {
		/** Stable per-record discriminator retained across token/account-id updates. */
		addedAt?: number;
		recordId?: string;
	},
	family: ModelFamily,
	model?: string | null,
): string {
	return `${buildQuotaScheduleAccountPrefix(account)}${model ?? family}`;
}

const DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS = 4;
// This is a hard safety ceiling over every pinned selection pass, including
// branches that do not consume the transient-attempt budget. It deliberately
// overrides larger retry settings for pinned requests.
const MAX_PINNED_SELECTION_ITERATIONS = 16;
/**
 * Ceiling on same-account re-sends for one pinned request.
 *
 * The pool's transient budget is derived from `retryAllAccountsMaxRetries`,
 * whose documented meaning is "wait and retry when EVERY account is
 * rate-limited". For an unpinned pool that budget spends across different
 * accounts; for a pin every unit of it is another copy of the same
 * (non-idempotent) request to the same upstream, so raising that pool knob
 * must not silently multiply pinned re-sends. A user who LOWERS the knob
 * still gets fewer attempts.
 */
const MAX_PINNED_TRANSIENT_ATTEMPTS = 4;
/**
 * Backoff before each pinned re-attempt: 250ms, 500ms, 1s, capped.
 *
 * A pinned retry re-sends the SAME non-idempotent request to the SAME
 * upstream, and the retry loop has no other delay anywhere in it. The
 * account's cooldown used to supply that spacing by accident, by blocking
 * selection outright — which is also why the retry budget could never be
 * spent. Waiving the cooldown for the retry (see `allowPinnedCooldown`)
 * removes that accidental spacing, so replace it with a real one that is
 * short enough not to dominate the request's latency: at most
 * 250 + 500 + 1000 = 1.75s across the whole request at the default budget.
 */
const PINNED_RETRY_BACKOFF_STEPS_MS = [250, 500, 1_000] as const;

function pinnedRetryBackoffMs(attempt: number): number {
	const index = Math.min(
		Math.max(0, attempt - 1),
		PINNED_RETRY_BACKOFF_STEPS_MS.length - 1,
	);
	return PINNED_RETRY_BACKOFF_STEPS_MS[index] ?? 0;
}

/**
 * Backoff schedule for a model-capacity wait (issue #689).
 *
 * Deliberately much longer than `PINNED_RETRY_BACKOFF_STEPS_MS`. That schedule
 * spaces out re-sends of a request whose account might already be fine;
 * capacity pressure is upstream and measured in minutes, so re-sending every
 * 250ms would just be a tight poll against a busy backend. The last step
 * repeats for every attempt past the table.
 */
const CAPACITY_RETRY_BACKOFF_STEPS_MS = [
	2_000, 5_000, 15_000, 30_000, 60_000,
] as const;

/**
 * Default wall-clock ceiling on capacity waiting for ONE request.
 *
 * The reporter's case is a long-running task started before stepping away, so
 * the default has to be long enough to outlast a real capacity blip. It is
 * still a hard ceiling: the request ends with the normal pool-exhausted 503
 * rather than hanging forever.
 */
const DEFAULT_MODEL_CAPACITY_RETRY_MS = 10 * 60_000;
const MAX_MODEL_CAPACITY_RETRY_MS = 60 * 60_000;
const MODEL_CAPACITY_RETRY_ENV = "CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS";

function capacityRetryBackoffMs(attempt: number): number {
	const index = Math.min(
		Math.max(0, attempt - 1),
		CAPACITY_RETRY_BACKOFF_STEPS_MS.length - 1,
	);
	return CAPACITY_RETRY_BACKOFF_STEPS_MS[index] ?? 0;
}

/**
 * Total time one request may spend waiting out model capacity.
 *
 * `0` disables the behaviour entirely and restores the pre-#689 handling, where
 * a capacity response rotates the pool and 503s. Anything unparseable falls
 * back to the default rather than disabling, so a typo does not silently turn
 * the feature off.
 */
export function normalizeModelCapacityRetryMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_MODEL_CAPACITY_RETRY_MS;
	}
	return Math.min(Math.floor(value), MAX_MODEL_CAPACITY_RETRY_MS);
}

export function resolveModelCapacityRetryMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = (env[MODEL_CAPACITY_RETRY_ENV] ?? "").trim();
	if (!raw) return DEFAULT_MODEL_CAPACITY_RETRY_MS;
	// An explicit 0 is the documented kill switch and must survive normalization,
	// which otherwise treats "not a usable number" as "use the default".
	const parsed = Number(raw);
	if (parsed === 0) return 0;
	return normalizeModelCapacityRetryMs(parsed);
}

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_THREAD_GOAL_FALLBACKS = 512;
const ALLOWED_RESPONSES_PATHS = new Set([
	URL_PATHS.RESPONSES,
	URL_PATHS.CODEX_RESPONSES,
	`/v1${URL_PATHS.RESPONSES}`,
	`/v1${URL_PATHS.CODEX_RESPONSES}`,
]);
const ALLOWED_MODELS_PATHS = new Set([
	URL_PATHS.MODELS,
	`/v1${URL_PATHS.MODELS}`,
]);
const ALLOWED_IMAGE_PATHS = new Set([
	"/images/generations",
	"/images/edits",
	"/v1/images/generations",
	"/v1/images/edits",
]);
const ALLOWED_THREAD_GOAL_PATHS = new Set([
	"/thread/goal/get",
	"/thread/goal/set",
	"/codex/thread/goal/get",
	"/codex/thread/goal/set",
]);

function isResponsesPath(pathname: string): boolean {
	return ALLOWED_RESPONSES_PATHS.has(pathname);
}

function isModelsPath(pathname: string): boolean {
	return ALLOWED_MODELS_PATHS.has(pathname);
}

function isThreadGoalPath(pathname: string): boolean {
	return ALLOWED_THREAD_GOAL_PATHS.has(pathname);
}

function normalizeThreadGoalUpstreamPath(pathname: string): string {
	return pathname.startsWith("/codex/") ? pathname : `/codex${pathname}`;
}

function headersFromIncoming(req: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(key, item);
			}
			continue;
		}
		headers.set(key, value);
	}
	return headers;
}

function createOutboundHeaders(
	incoming: Headers,
	account: ManagedAccount,
	accessToken: string,
	accountId: string,
): Headers {
	const headers = new Headers(incoming);
	for (const name of HOP_BY_HOP_HEADERS) {
		headers.delete(name);
	}
	headers.delete("host");
	headers.delete("x-api-key");
	// Never forward inbound client credentials upstream: a Cookie / proxy-auth
	// header would ride along with the managed OAuth Bearer to OpenAI.
	headers.delete("cookie");
	headers.delete("proxy-authorization");
	// Local capability marker for Codex image_gen, never an upstream credential.
	headers.delete("x-openai-actor-authorization");
	headers.set("authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	return headers;
}

function isAuthorizedClient(headers: Headers, clientApiKey: string): boolean {
	const authorization = headers.get("authorization") ?? "";
	const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
	const bearer = bearerMatch?.[1]?.trim();
	if (bearer && safeEqual(bearer, clientApiKey)) return true;
	const apiKey = headers.get("x-api-key");
	return typeof apiKey === "string" && safeEqual(apiKey, clientApiKey);
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, "utf8");
	const rightBuffer = Buffer.from(right, "utf8");
	const compareLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
	const paddedLeft = Buffer.alloc(compareLength);
	const paddedRight = Buffer.alloc(compareLength);
	leftBuffer.copy(paddedLeft);
	rightBuffer.copy(paddedRight);
	return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

function readTrimmedString(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function accountIdentityFromAccount(
	account: ManagedAccount,
	updatedAt: number,
): RuntimeRotationAccountIdentity {
	return {
		index: account.index,
		label: `Account ${account.index + 1}`,
		accountId: readTrimmedString(account.accountId),
		updatedAt,
	};
}

function recordLastRuntimeAccount(
	status: RuntimeRotationProxyStatus,
	identity: RuntimeRotationAccountIdentity,
): void {
	status.lastAccountIndex = identity.index;
	status.lastAccountLabel = identity.label;
	status.lastAccountId = identity.accountId;
	status.lastAccountUpdatedAt = identity.updatedAt;
	mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.lastAccountIndex = identity.index;
		snapshot.lastAccountLabel = identity.label;
		snapshot.lastAccountEmail = null;
		snapshot.lastAccountId = identity.accountId;
		snapshot.lastAccountUpdatedAt = identity.updatedAt;
	});
}

async function persistRuntimeActiveAccount(
	accountManager: AccountManager,
	account: ManagedAccount,
	family: ModelFamily,
	isPinned: boolean,
	schedulingStrategy: string,
): Promise<void> {
	if (isPinned) {
		// When the user has manually pinned an account, the proxy MUST NOT
		// clobber that pin via markSwitched("rotation"), saveToDiskDebounced(),
		// or syncCodexCliActiveSelectionForIndex(). Pin mutations only flow
		// from the `switch`/`unpin`/`best` CLI commands. See #474.
		return;
	}
	try {
		// accounts-01/08: serialize the cursor mutation through the routing mutex
		// (when routingMutex="enabled") because this commit spans an await
		// (syncCodexCliActiveSelectionForIndex), which is the lost-update window the
		// mutex exists to close. In legacy mode markSwitchedLocked runs inline, so
		// behavior is unchanged by default.
		//
		// L4 fix: in "enabled" mode the SELECTION path already committed the cursor
		// for this account inside the routing mutex (atomic select+commit, see the
		// hot-path caller). Re-running markSwitchedLocked here — after the upstream
		// fetch, in a *separate* critical section — would redundantly re-advance the
		// cursor and could clobber a concurrent request's atomic advance that landed
		// while this request was awaiting upstream. So only do the locked cursor
		// commit in legacy mode, where selection does NOT commit under a lock and
		// this remains the sole commit site (preserving legacy behavior exactly).
		// `saveToDiskDebounced` + CLI sync still run in both modes: they snapshot the
		// current in-memory state / mirror the CLI selection and do not advance the
		// in-memory rotation cursor.
		//
		// Sequential scheduling fix (#509): in "sequential" mode a within-request
		// fallback to a different account must NOT advance the drain-first primary
		// pointer — only a true primary-exhaustion in chooseAccount may do that.
		// Apply the same guard here as the in-loop re-commit (lines 939-958) so
		// the legacy branch cannot silently clobber the sequential drain order.
		if (
			accountManager.getRoutingMutexMode() !== "enabled" &&
			schedulingStrategy !== "sequential"
		) {
			await accountManager.markSwitchedLocked(account, "rotation", family);
		}
		accountManager.saveToDiskDebounced();
		await accountManager.syncCodexCliActiveSelectionForIndex(account.index);
	} catch {
		// Runtime forwarding must not fail after a valid upstream response just
		// because the local status mirrors are temporarily locked.
	}
}

function createRuntimeProxyHttpError(
	message: string,
	statusCode: number,
	code: string,
): RuntimeProxyHttpError {
	return Object.assign(new Error(message), { statusCode, code });
}

function isRuntimeProxyHttpError(error: unknown): error is RuntimeProxyHttpError {
	return (
		error instanceof Error &&
		"statusCode" in error &&
		typeof error.statusCode === "number" &&
		"code" in error &&
		typeof error.code === "string"
	);
}

function isRecoverableWebSocketAccountError(error: unknown): boolean {
	return (
		isRuntimeProxyHttpError(error) &&
		(error.code === "circuit_open" || error.code === "websocket_account_deferred")
	);
}

async function readRequestBody(
	req: IncomingMessage,
	maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > maxBytes) {
			throw createRuntimeProxyHttpError(
				"Runtime rotation proxy request body is too large.",
				HTTP_STATUS.PAYLOAD_TOO_LARGE,
				"runtime_rotation_proxy_payload_too_large",
			);
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function parseRequestBody(body: Buffer): RequestBody | null {
	if (body.length === 0) return null;
	try {
		const parsed = JSON.parse(body.toString("utf8")) as unknown;
		return isRecord(parsed) ? (parsed as RequestBody) : null;
	} catch {
		return null;
	}
}

function readStringRecordValue(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function readStringSearchParam(searchParams: URLSearchParams, key: string): string | null {
	const value = searchParams.get(key);
	return value && value.trim().length > 0 ? value.trim() : null;
}

function isThreadGoalFallbackStatus(status: number): boolean {
	return status === HTTP_STATUS.FORBIDDEN;
}

function setThreadGoalFallback(
	fallbacks: Map<string, string | null>,
	key: string,
	goal: string | null,
): void {
	if (fallbacks.has(key)) {
		fallbacks.delete(key);
	}
	fallbacks.set(key, goal);
	while (fallbacks.size > MAX_THREAD_GOAL_FALLBACKS) {
		const oldestKey = fallbacks.keys().next().value;
		if (typeof oldestKey !== "string") break;
		fallbacks.delete(oldestKey);
	}
}

function getThreadGoalFallback(
	fallbacks: Map<string, string | null>,
	key: string,
): string | null {
	if (!fallbacks.has(key)) return null;
	const goal = fallbacks.get(key) ?? null;
	fallbacks.delete(key);
	fallbacks.set(key, goal);
	return goal;
}

/**
 * Session identity that is stable for the life of a conversation.
 *
 * Every source here keeps the same value across turns, so state keyed on it
 * accumulates. `resolveSessionKey` adds `previous_response_id` on top for
 * callers that only need "requests that belong together right now".
 */
function resolveStableSessionKey(
	headers: Headers,
	parsedBody: RequestBody | null,
): string | null {
	const headerKey =
		headers.get(OPENAI_HEADERS.SESSION_ID) ??
		headers.get(OPENAI_HEADERS.CONVERSATION_ID) ??
		null;
	if (headerKey && headerKey.trim().length > 0) return headerKey.trim();
	if (!parsedBody) return null;
	if (typeof parsedBody.prompt_cache_key === "string") {
		const key = parsedBody.prompt_cache_key.trim();
		if (key.length > 0) return key;
	}
	const metadata = parsedBody.metadata;
	if (isRecord(metadata)) {
		return (
			readStringRecordValue(metadata, "session_id") ??
			readStringRecordValue(metadata, "conversation_id") ??
			readStringRecordValue(metadata, "thread_id")
		);
	}
	return null;
}

/**
 * Session identity for affinity/pinning: the stable sources above, plus
 * `previous_response_id` as a last resort. Precedence is unchanged from
 * before `resolveStableSessionKey` was split out — `previous_response_id`
 * still outranks the `metadata` fallbacks — so which account a request pins
 * to does not shift.
 */
function resolveSessionKey(headers: Headers, parsedBody: RequestBody | null): string | null {
	const headerKey =
		headers.get(OPENAI_HEADERS.SESSION_ID) ??
		headers.get(OPENAI_HEADERS.CONVERSATION_ID) ??
		null;
	if (headerKey && headerKey.trim().length > 0) return headerKey.trim();
	if (!parsedBody) return null;
	if (typeof parsedBody.prompt_cache_key === "string") {
		const key = parsedBody.prompt_cache_key.trim();
		if (key.length > 0) return key;
	}
	if (typeof parsedBody.previous_response_id === "string") {
		const key = parsedBody.previous_response_id.trim();
		if (key.length > 0) return key;
	}
	const metadata = parsedBody.metadata;
	if (isRecord(metadata)) {
		return (
			readStringRecordValue(metadata, "session_id") ??
			readStringRecordValue(metadata, "conversation_id") ??
			readStringRecordValue(metadata, "thread_id")
		);
	}
	return null;
}

function buildResponsesRequestContext(
	req: IncomingMessage,
	body: Buffer,
): RequestContext {
	const headers = headersFromIncoming(req);
	const parsedBody = parseRequestBody(body);
	const model =
		typeof parsedBody?.model === "string" && parsedBody.model.trim().length > 0
			? parsedBody.model.trim()
			: null;
	return {
		body,
		headers,
		method: "POST",
		upstreamPath: URL_PATHS.CODEX_RESPONSES,
		model,
		// The /codex/responses path is codex-family. A model-less request must
		// bucket into the codex family (rotation/cooldown/budget), so fall back to
		// the current codex model — NOT the general DEFAULT_MODEL (gpt-5.5), whose
		// family is gpt-5.2 and would mis-account a pass-through codex request.
		family: getModelFamily(model ?? CURRENT_CODEX_MODEL),
		stream: parsedBody?.stream === true,
		sessionKey: resolveSessionKey(headers, parsedBody),
		stableSessionKey: resolveStableSessionKey(headers, parsedBody),
	};
}

function buildImageRequestContext(
	req: IncomingMessage,
	body: Buffer,
	pathname: string,
): RequestContext {
	return {
		...buildResponsesRequestContext(req, body),
		upstreamPath: `/codex${pathname.replace(/^\/v1/, "")}`,
		family: "codex",
	};
}

function buildModelsRequestContext(req: IncomingMessage): RequestContext {
	return {
		body: Buffer.alloc(0),
		headers: headersFromIncoming(req),
		method: "GET",
		upstreamPath: URL_PATHS.MODELS,
		model: null,
		family: "codex",
		stream: false,
		sessionKey: null,
		stableSessionKey: null,
	};
}

function buildThreadGoalRequestContext(
	req: IncomingMessage,
	body: Buffer,
	pathname: string,
): RequestContext {
	const headers = headersFromIncoming(req);
	const parsedBody = parseRequestBody(body);
	const searchParams = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
	const queryThreadKey =
		readStringSearchParam(searchParams, "thread_id") ??
		readStringSearchParam(searchParams, "threadId");
	const bodyThreadKey = parsedBody
		? (readStringRecordValue(parsedBody, "thread_id") ??
			readStringRecordValue(parsedBody, "threadId"))
		: null;
	const sessionKey = bodyThreadKey ?? queryThreadKey ?? resolveSessionKey(headers, parsedBody);
	return {
		body,
		headers,
		method: req.method === "GET" ? "GET" : "POST",
		upstreamPath: normalizeThreadGoalUpstreamPath(pathname),
		model: null,
		family: "codex",
		stream: false,
		sessionKey,
		stableSessionKey:
			bodyThreadKey ?? queryThreadKey ?? resolveStableSessionKey(headers, parsedBody),
	};
}

function buildUpstreamUrl(
	req: IncomingMessage,
	upstreamBaseUrl: string,
	upstreamPath: string,
): string {
	const incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
	const upstream = new URL(upstreamBaseUrl);
	const basePath = upstream.pathname.replace(/\/+$/, "");
	upstream.pathname = `${basePath}${upstreamPath}`;
	upstream.search = incomingUrl.search;
	return upstream.toString();
}

function resolveAccountId(account: ManagedAccount, accessToken: string): string | null {
	const stored = account.accountId?.trim();
	if (stored) return stored;
	return extractAccountId(accessToken)?.trim() || null;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(`${JSON.stringify(payload)}\n`);
}

function writeMethodOrPathError(res: ServerResponse): void {
	writeJson(res, 404, {
		error: {
			message:
				"Runtime rotation proxy only accepts Responses API, images, model discovery, and Codex thread goal requests.",
			code: "runtime_rotation_proxy_not_found",
		},
	});
}

function writeUnauthorized(res: ServerResponse): void {
	writeJson(res, HTTP_STATUS.UNAUTHORIZED, {
		error: {
			message: "Runtime rotation proxy rejected an unauthenticated local request.",
			code: "runtime_rotation_proxy_unauthorized",
		},
	});
}

function writePoolExhausted(params: {
	res: ServerResponse;
	accountManager: AccountManager;
	family: ModelFamily;
	model: string | null;
	reason: ExhaustionReason;
	accountSkipReasons?: Record<string, string>;
}): void {
	const { res, accountManager, family, model, reason } = params;
	const waitMs = accountManager.getMinWaitTimeForFamily(family, model);
	const accountCount = accountManager.getAccountCount();
	const accountSkipReasons = params.accountSkipReasons ?? {};
	recordRuntimePoolExhaustion({
		reason,
		retryAfterMs: waitMs,
		accountSkipReasons,
	});
	const hint =
		reason === "no-account" && accountCount > 0
			? "Accounts exist but all failed runtime availability checks. Run `codex-multi-auth report --json` to inspect runtime skip reasons, or `codex-multi-auth rotation reset-runtime` to reload the runtime proxy."
			: "Run `codex-multi-auth rotation status` to inspect account state.";
	writeJson(res, normalizeExhaustionStatus(reason), {
		error: {
			message:
				"All managed Codex accounts are temporarily unavailable for this runtime request.",
			code: "codex_runtime_rotation_pool_exhausted",
			reason,
			retry_after_ms: waitMs,
			account_skip_reasons: accountSkipReasons,
			hint,
		},
	});
}

const CODEX_RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
const PREVIOUS_RESPONSE_NOT_FOUND_MESSAGE =
	"Previous response was not found. Retrying the full request.";
const INITIAL_WEBSOCKET_RECOVERY_DELAY_MS = 5_000;
const MAX_WEBSOCKET_RECOVERY_DELAY_MS = 60_000;
const WEBSOCKET_CLOSE_POLICY_VIOLATION = 1008;
const WEBSOCKET_CLOSE_TRY_AGAIN_LATER = 1013;
const MAX_WEBSOCKET_HANDSHAKE_ERROR_BODY_BYTES = 64 * 1024;
const WEBSOCKET_AUTH_FAILURE_CODES: ReadonlySet<string> = new Set([
	"authentication_error",
	"invalid_api_key",
	"invalid_authentication",
	"unauthorized",
]);

interface PendingWebSocketFrame {
	data: RawData;
	isBinary: boolean;
	recoveryAttempts?: number;
	request?: PreparedWebSocketRequest;
}

function hasConnectionScopedContinuation(frame: PendingWebSocketFrame): boolean {
	const body = parseRequestBody(rawDataToBuffer(frame.data));
	return readStringRecordValue(body ?? {}, "previous_response_id") !== null;
}

interface PreparedWebSocketAccount {
	accountManager: AccountManager;
	account: ManagedAccount;
	accessToken: string;
	accountId: string;
	request: PreparedWebSocketRequest;
	isPinned: boolean;
	tokenRefundable: boolean;
	abortHandshake: (() => void) | null;
}

interface PreparedWebSocketRequest {
	context: RequestContext;
	policyDecision: RuntimePolicyDecision;
	usageRecorder: RuntimeUsageRecorder;
}

interface ActiveWebSocketRequest {
	request: PreparedWebSocketRequest;
	accountManager: AccountManager;
	account: ManagedAccount;
	frame: PendingWebSocketFrame;
	sawUpstreamEvent: boolean;
}

interface WebSocketTerminalEvent {
	record: Parameters<RuntimeUsageRecorder["record"]>[0];
	rawBody: string;
	retryAfterMs: number | null;
	retryHeaders: Headers | null;
}

interface WebSocketAttemptBudget {
	attempts: number;
	limit: number;
}

interface WebSocketHandshakeLifecycle {
	onPrepared: (prepared: PreparedWebSocketAccount) => boolean;
	onReleased: (prepared: PreparedWebSocketAccount) => void;
	isClosed: () => boolean;
}

class WebSocketHandshakeError extends Error {
	readonly statusCode: number | null;
	readonly headers: Headers;
	readonly bodyText: string;

	constructor(
		message: string,
		statusCode: number | null = null,
		headers = new Headers(),
		bodyText = "",
	) {
		super(message);
		this.name = "WebSocketHandshakeError";
		this.statusCode = statusCode;
		this.headers = headers;
		this.bodyText = bodyText;
	}
}

function refundPreparedWebSocketToken(prepared: PreparedWebSocketAccount): void {
	if (!prepared.tokenRefundable) return;
	prepared.tokenRefundable = false;
	prepared.accountManager.refundToken(
		prepared.account,
		prepared.request.context.family,
		prepared.request.context.model,
	);
}

function rawDataToBuffer(data: RawData): Buffer {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function readFiniteNumber(record: Record<string, unknown> | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function readWebSocketStatusCode(
	...records: Array<Record<string, unknown> | null>
): number | null {
	for (const record of records) {
		for (const key of ["status", "status_code"] as const) {
			const value = record?.[key];
			const parsed =
				typeof value === "number"
					? value
					: typeof value === "string" && /^\d{3}$/.test(value.trim())
						? Number.parseInt(value.trim(), 10)
						: Number.NaN;
			if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
				return parsed;
			}
		}
	}
	return null;
}

function inferWebSocketFailureStatus(errorCode: string | null, rawBody: string): number | null {
	const normalizedCode = errorCode?.trim().toLowerCase() ?? "";
	if (
		normalizedCode === "token_invalidated" ||
		WEBSOCKET_AUTH_FAILURE_CODES.has(normalizedCode) ||
		isTokenInvalidationError(rawBody)
	) {
		return HTTP_STATUS.UNAUTHORIZED;
	}
	if (
		/(?:rate.?limit|usage_limit|quota|insufficient_quota|billing|out_of_budget)/i.test(
			normalizedCode,
		)
	) {
		return HTTP_STATUS.TOO_MANY_REQUESTS;
	}
	if (
		/(?:workspace|organization|account)_(?:disabled|expired|terminated|deactivated)/i.test(
			normalizedCode,
		)
	) {
		return HTTP_STATUS.FORBIDDEN;
	}
	if (
		/(?:^|_)(?:server_error|internal_server_error|service_unavailable|overloaded|upstream_error)(?:$|_)/i.test(
			normalizedCode,
		)
	) {
		return HTTP_STATUS.SERVICE_UNAVAILABLE;
	}
	return null;
}

function buildWebSocketRequestContext(
	req: IncomingMessage,
	firstFrame: RawData,
): RequestContext | null {
	const body = rawDataToBuffer(firstFrame);
	const parsedBody = parseRequestBody(body);
	if (!parsedBody || readStringRecordValue(parsedBody, "type") !== "response.create") {
		return null;
	}
	const model = readStringRecordValue(parsedBody, "model");
	const headers = headersFromIncoming(req);
	return {
		body,
		headers,
		method: "POST",
		upstreamPath: URL_PATHS.CODEX_RESPONSES,
		model,
		family: getModelFamily(model ?? CURRENT_CODEX_MODEL),
		stream: true,
		sessionKey: resolveSessionKey(headers, parsedBody),
		stableSessionKey: resolveStableSessionKey(headers, parsedBody),
	};
}

function buildWebSocketUpstreamUrl(req: IncomingMessage, upstreamBaseUrl: string): string {
	const upstream = new URL(
		buildUpstreamUrl(req, upstreamBaseUrl, URL_PATHS.CODEX_RESPONSES),
	);
	upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
	return upstream.toString();
}

async function prepareWebSocketRequest(
	state: RotationProxyState,
	req: IncomingMessage,
	frame: RawData,
): Promise<PreparedWebSocketRequest> {
	const context = buildWebSocketRequestContext(req, frame);
	if (!context) {
		throw new CodexValidationError("WebSocket message must be response.create.");
	}
	state.status.totalRequests += 1;
	const startedAt = state.now();
	const requestId = randomUUID();
	let projectKey: string | null = null;
	let policyDecision: RuntimePolicyDecision;
	try {
		const policyState = await loadRuntimePolicyState();
		projectKey = policyState.project.projectKey;
		policyDecision = await evaluateRuntimePolicy({
			state: policyState,
			accounts: state.activeAccountManager.getAccountsSnapshot(),
			model: context.model,
			now: startedAt,
		});
		mutateRuntimeObservabilitySnapshot((snapshot) => {
			snapshot.policyBlockedIndexes = [...policyDecision.blockedAccountIndexes];
			snapshot.policyBlockedReasons = Object.fromEntries(
				[...policyDecision.blockedAccountIndexes].map((index) => [
					String(index),
					"policy-blocked",
				]),
			);
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		state.status.lastError = message;
		const usageRecorder = createRuntimeUsageRecorder({
			source: "runtime-proxy",
			operation: "responses",
			model: context.model,
			projectKey,
			requestId,
			startedAt,
		});
		await usageRecorder.record({
			outcome: "failure",
			statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
			errorCode: "runtime_policy_unavailable",
		});
		throw createRuntimeProxyHttpError(
			"Runtime policy could not be loaded for this WebSocket request.",
			HTTP_STATUS.SERVICE_UNAVAILABLE,
			"runtime_policy_unavailable",
		);
	}
	const usageRecorder = createRuntimeUsageRecorder({
		source: "runtime-proxy",
		operation: "responses",
		model: context.model,
		projectKey,
		requestId,
		startedAt,
	});
	if (!policyDecision.allowed) {
		await usageRecorder.record({
			outcome: "blocked",
			statusCode: policyDecision.statusCode,
			errorCode: policyDecision.errorCode,
		});
		throw createRuntimeProxyHttpError(
			"Runtime policy blocked this WebSocket request.",
			policyDecision.statusCode,
			policyDecision.errorCode ?? "policy_blocked",
		);
	}
	return { context, policyDecision, usageRecorder };
}

async function consumeWebSocketRequestForAccount(
	request: PreparedWebSocketRequest,
	accountManager: AccountManager,
	account: ManagedAccount,
): Promise<void> {
	if (request.policyDecision.blockedAccountIndexes.has(account.index)) {
		await request.usageRecorder.record({
			outcome: "blocked",
			statusCode: HTTP_STATUS.FORBIDDEN,
			errorCode: "policy_blocked",
			account,
		});
		throw createRuntimeProxyHttpError(
			"Runtime policy blocked the account bound to this WebSocket connection.",
			HTTP_STATUS.FORBIDDEN,
			"policy_blocked",
		);
	}
	const runtimeSkipReason = accountManager.getManagedAccountRuntimeSkipReason(
		account,
		request.context.family,
		request.context.model,
	);
	if (runtimeSkipReason) {
		const recoverable =
			runtimeSkipReason === "rate-limited" ||
			runtimeSkipReason === "circuit-open" ||
			runtimeSkipReason === "cooling-down" ||
			runtimeSkipReason.startsWith("cooling-down:");
		if (!recoverable) {
			await request.usageRecorder.record({
				outcome: "failure",
				statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
				errorCode: "websocket_account_unavailable",
				account,
			});
		}
		throw createRuntimeProxyHttpError(
			"The account bound to this WebSocket connection is temporarily unavailable.",
			HTTP_STATUS.SERVICE_UNAVAILABLE,
			recoverable
				? "websocket_account_deferred"
				: "websocket_account_unavailable",
		);
	}
	if (!accountManager.consumeToken(account, request.context.family, request.context.model)) {
		throw createRuntimeProxyHttpError(
			"The account bound to this WebSocket connection is temporarily unavailable.",
			HTTP_STATUS.SERVICE_UNAVAILABLE,
			"circuit_open",
		);
	}
}

function websocketTerminalUsage(
	data: RawData,
): WebSocketTerminalEvent | null {
	const body = rawDataToBuffer(data);
	const parsed = parseRequestBody(body);
	if (!parsed) return null;
	const type = readStringRecordValue(parsed, "type");
	let outcome: "success" | "failure" | "cancelled";
	if (
		type === "response.completed" ||
		type === "response.done" ||
		type === "response.incomplete"
	) {
		outcome = "success";
	} else if (type === "response.cancelled") {
		outcome = "cancelled";
	} else if (type === "response.failed" || type === "error") {
		outcome = "failure";
	} else {
		return null;
	}
	const response = isRecord(parsed.response) ? parsed.response : null;
	const usage = response && isRecord(response.usage) ? response.usage : null;
	const inputDetails = usage && isRecord(usage.input_tokens_details)
		? usage.input_tokens_details
		: null;
	const outputDetails = usage && isRecord(usage.output_tokens_details)
		? usage.output_tokens_details
		: null;
	const error = response && isRecord(response.error)
		? response.error
		: isRecord(parsed.error)
			? parsed.error
			: null;
	const headerValues = isRecord(parsed.headers)
		? parsed.headers
		: isRecord(error?.headers)
			? error.headers
			: null;
	const retryHeaders = new Headers();
	if (headerValues) {
		for (const [name, value] of Object.entries(headerValues)) {
			if (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				retryHeaders.set(name, String(value));
			}
		}
	}
	const errorCode =
		readStringRecordValue(error ?? {}, "code") ??
		readStringRecordValue(parsed, "code") ??
		readStringRecordValue(error ?? {}, "type");
	const rawBody = body.toString("utf8");
	const statusCode =
		readWebSocketStatusCode(parsed, response, error) ??
		(outcome === "success"
			? HTTP_STATUS.OK
			: inferWebSocketFailureStatus(errorCode, rawBody));
	return {
		record: {
			outcome,
			statusCode,
			errorCode,
			inputTokens: readFiniteNumber(usage, "input_tokens"),
			outputTokens: readFiniteNumber(usage, "output_tokens"),
			cachedInputTokens: readFiniteNumber(inputDetails, "cached_tokens"),
			reasoningTokens: readFiniteNumber(outputDetails, "reasoning_tokens"),
			totalTokens: readFiniteNumber(usage, "total_tokens"),
		},
		rawBody,
		retryAfterMs:
			readFiniteNumber(parsed, "retry_after_ms") ??
			readFiniteNumber(error, "retry_after_ms"),
		retryHeaders: [...retryHeaders].length > 0 ? retryHeaders : null,
	};
}

function applyWebSocketTransportAccountFailure(
	state: RotationProxyState,
	active: Pick<ActiveWebSocketRequest, "request" | "accountManager" | "account">,
): void {
	const { accountManager, account, request } = active;
	accountManager.recordFailure(
		account,
		request.context.family,
		request.context.model,
	);
	accountManager.markAccountCoolingDown(
		account,
		state.networkErrorCooldownMs,
		"network-error",
	);
	state.sessionAffinityStore?.forgetSession(request.context.sessionKey);
	state.status.retries += 1;
	state.status.rotations += 1;
	accountManager.saveToDiskDebounced();
}

function applyWebSocketTerminalAccountFailure(
	state: RotationProxyState,
	active: ActiveWebSocketRequest,
	terminal: WebSocketTerminalEvent,
): void {
	if (terminal.record.outcome !== "failure") return;
	const statusCode = terminal.record.statusCode;
	if (typeof statusCode !== "number") return;
	const { accountManager, account, request } = active;
	const { context } = request;
	const forgetAffinity = (): void => {
		state.sessionAffinityStore?.forgetSession(context.sessionKey);
		state.status.retries += 1;
		state.status.rotations += 1;
	};
	if (statusCode === HTTP_STATUS.TOO_MANY_REQUESTS) {
		const retryAfterMs =
			(terminal.retryHeaders
				? parseRetryAfterHeaderMs(terminal.retryHeaders, state.now())
				: null) ??
			terminal.retryAfterMs ??
			parseRetryAfterBodyMs(terminal.rawBody, state.now()) ??
			60_000;
		state.preemptiveQuotaScheduler.markRateLimited(
			buildQuotaScheduleKey(account, context.family, context.model),
			retryAfterMs,
			state.now(),
		);
		accountManager.recordRateLimit(account, context.family, context.model);
		accountManager.markRateLimitedWithReason(
			account,
			retryAfterMs,
			context.family,
			"quota",
			context.model,
		);
		forgetAffinity();
		accountManager.saveToDiskDebounced();
		return;
	}
	if (statusCode === HTTP_STATUS.UNAUTHORIZED) {
		accountManager.refundToken(account, context.family, context.model);
		accountManager.recordFailure(account, context.family, context.model);
		if (terminal.record.errorCode === "token_invalidated") {
			accountManager.markAuthInvalidated(account, terminal.record.errorCode);
			applyMonotonicAuthCooldown(
				accountManager,
				account,
				state.tokenInvalidationCooldownMs,
			);
		} else {
			applyMonotonicAuthCooldown(
				accountManager,
				account,
				DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
			);
		}
		forgetAffinity();
		accountManager.saveToDiskDebounced();
		return;
	}
	if (
		(statusCode === 402 || statusCode === HTTP_STATUS.FORBIDDEN) &&
		isWorkspaceDisabledError(
			statusCode,
			terminal.record.errorCode,
			terminal.rawBody,
		)
	) {
		accountManager.refundToken(account, context.family, context.model);
		accountManager.recordFailure(account, context.family, context.model);
		accountManager.setAccountEnabled(account.index, false);
		forgetAffinity();
		accountManager.saveToDiskDebounced();
		return;
	}
	if (statusCode >= 500) {
		accountManager.refundToken(account, context.family, context.model);
		accountManager.recordFailure(account, context.family, context.model);
		accountManager.markAccountCoolingDown(
			account,
			state.serverErrorCooldownMs,
			"server-error",
		);
		forgetAffinity();
		accountManager.saveToDiskDebounced();
	}
}

function applyWebSocketTerminalAccountSuccess(
	state: RotationProxyState,
	active: ActiveWebSocketRequest,
	terminal: WebSocketTerminalEvent,
): void {
	if (terminal.record.outcome !== "success") return;
	state.lastGlobalAccountIndex = active.account.index;
	state.lastGlobalSwitchAt = state.now();
}

function isSendableWebSocketCloseCode(code: number): boolean {
	return (
		(code >= 1000 &&
			code <= 1014 &&
			code !== 1004 &&
			code !== 1005 &&
			code !== 1006) ||
		(code >= 3000 && code <= 4999)
	);
}

function mirrorWebSocketClose(
	target: WebSocket,
	code: number,
	reason: Buffer | string,
): void {
	if (target.readyState !== WebSocket.OPEN) return;
	if (isSendableWebSocketCloseCode(code)) {
		target.close(code, reason);
		return;
	}
	target.terminate();
}

function createWebSocketOutboundHeaders(
	incoming: Headers,
	account: ManagedAccount,
	accessToken: string,
	accountId: string,
): Record<string, string> {
	const headers = createOutboundHeaders(incoming, account, accessToken, accountId);
	for (const name of [
		"accept",
		"content-encoding",
		"content-length",
		"content-type",
		"sec-websocket-extensions",
		"sec-websocket-key",
		"sec-websocket-protocol",
		"sec-websocket-version",
	]) {
		headers.delete(name);
	}
	headers.set(OPENAI_HEADERS.BETA, CODEX_RESPONSES_WEBSOCKET_BETA);
	return Object.fromEntries(headers.entries());
}

function rejectWebSocketUpgrade(
	socket: Duplex,
	statusCode: number,
	statusText: string,
): void {
	const body = `${statusText}\n`;
	socket.end(
		`HTTP/1.1 ${statusCode} ${statusText}\r\n` +
			"Connection: close\r\n" +
			"Content-Type: text/plain; charset=utf-8\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
	);
}

function openUpstreamWebSocket(
	url: string,
	headers: Record<string, string>,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const upstream = new WebSocket(url, {
		headers,
		handshakeTimeout: timeoutMs,
		perMessageDeflate: false,
	});
		let settled = false;
		let readingUnexpectedResponse = false;
		let unexpectedResponse: IncomingMessage | null = null;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			upstream.off("open", onOpen);
			upstream.off("error", onError);
			upstream.off("unexpected-response", onUnexpectedResponse);
			if (error) reject(error);
			else resolve(upstream);
		};
		const onOpen = (): void => finish();
		const onError = (error: Error): void => {
			if (!readingUnexpectedResponse) finish(error);
		};
		const onAbort = (): void => {
			try {
				unexpectedResponse?.destroy();
				upstream.terminate();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const onUnexpectedResponse = (
			_request: IncomingMessage,
			response: IncomingMessage,
		): void => {
			readingUnexpectedResponse = true;
			unexpectedResponse = response;
			const statusCode = response.statusCode ?? null;
			const responseHeaders = headersFromIncoming(response);
			void readBoundedIncomingBody(
				response,
				MAX_WEBSOCKET_HANDSHAKE_ERROR_BODY_BYTES,
				timeoutMs,
			).then((bodyText) => {
				finish(
					new WebSocketHandshakeError(
						`Upstream WebSocket handshake returned HTTP ${statusCode ?? 0}`,
						statusCode,
						responseHeaders,
						bodyText,
					),
				);
			});
		};
		upstream.once("open", onOpen);
		upstream.once("error", onError);
		upstream.once("unexpected-response", onUnexpectedResponse);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

function readBoundedIncomingBody(
	response: IncomingMessage,
	maxBytes: number,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let settled = false;
		function finish(): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			response.off("data", onData);
			response.off("end", finish);
			response.off("close", finish);
			response.off("error", finish);
			resolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
		}
		function onData(chunk: Buffer | string): void {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = maxBytes - totalBytes;
			if (remaining > 0) {
				const accepted = buffer.subarray(0, remaining);
				chunks.push(accepted);
				totalBytes += accepted.byteLength;
			}
			if (buffer.byteLength > remaining) {
				response.destroy();
				finish();
			}
		}
		const timeout = setTimeout(() => {
			response.destroy();
			finish();
		}, Math.max(1, timeoutMs));
		response.on("data", onData);
		response.once("end", finish);
		response.once("close", finish);
		response.once("error", finish);
	});
}

async function prepareWebSocketAccount(
	state: RotationProxyState,
	request: PreparedWebSocketRequest,
	attemptedIndexes: Set<number>,
	skipReasons: Map<number, string>,
	attemptBudget: WebSocketAttemptBudget,
	lifecycle: WebSocketHandshakeLifecycle,
): Promise<PreparedWebSocketAccount | null> {
	const { context, policyDecision } = request;
	let accountManager = state.activeAccountManager;
	const storageMeta = readStorageMetaFromDisk();
	const pinnedIndex = state.forcedAccountIndex ?? storageMeta.pinnedAccountIndex;
	const isPinned = typeof pinnedIndex === "number";
	if (storageMeta.affinityGeneration > state.lastObservedAffinityGeneration) {
		state.sessionAffinityStore?.clearAll();
		state.lastObservedAffinityGeneration = storageMeta.affinityGeneration;
	}
	let reloaded = false;
	while (
		attemptedIndexes.size < accountManager.getAccountCount() &&
		attemptBudget.attempts < attemptBudget.limit
	) {
		const rotationStickyBoost: Record<number, number> =
			state.minRotationIntervalMs > 0 &&
			state.lastGlobalAccountIndex !== null &&
			state.now() - state.lastGlobalSwitchAt < state.minRotationIntervalMs
				? { [state.lastGlobalAccountIndex]: 1000 }
				: {};
		const selectAccount = (): ManagedAccount | null =>
			chooseAccount({
				accountManager,
				sessionAffinityStore: state.sessionAffinityStore,
				sessionKey: context.sessionKey,
				family: context.family,
				model: context.model,
				attemptedIndexes,
				now: state.now(),
				policy: policyDecision,
				pinnedIndex,
				skipReasons,
				stickyBoostByAccount: rotationStickyBoost,
				pidOffsetEnabled: state.pidOffsetEnabled,
				schedulingStrategy: state.schedulingStrategy,
			});
		const selected =
			state.routingMutexMode === "enabled"
				? await withRoutingMutex(state.routingMutexMode, async () => {
						const candidate = selectAccount();
						if (
							candidate &&
							pinnedIndex === null &&
							state.schedulingStrategy !== "sequential"
						) {
							await accountManager.markSwitchedLocked(
								candidate,
								"rotation",
								context.family,
							);
						}
						return candidate;
					})
				: selectAccount();
		if (!selected) {
			if (
				!reloaded &&
				!isPinned &&
				accountManager.getAccountCount() > 0 &&
				policyDecision.blockedAccountIndexes.size === 0 &&
				![...skipReasons.values()].some((reason) => reason === "policy-blocked")
			) {
				reloaded = true;
				const recovered = await recoverStaleRuntimeState(state);
				if (recovered) {
					accountManager = recovered;
					attemptBudget.limit = Math.max(
						1,
						Math.min(
							accountManager.getAccountCount(),
							state.maxRuntimeAccountAttempts,
						),
					);
					skipReasons.clear();
					continue;
				}
			}
			break;
		}
		attemptedIndexes.add(selected.index);
		const quotaScheduleKey = buildQuotaScheduleKey(
			selected,
			context.family,
			context.model,
		);
		const preemptiveDeferral = state.preemptiveQuotaScheduler.getDeferral(
			quotaScheduleKey,
			state.now(),
		);
		if (preemptiveDeferral.defer && preemptiveDeferral.waitMs > 0) {
			skipReasons.set(
				selected.index,
				preemptiveDeferral.reason ?? "quota-near-exhaustion",
			);
			accountManager.markRateLimitedWithReason(
				selected,
				preemptiveDeferral.waitMs,
				context.family,
				"quota",
				context.model,
			);
			accountManager.recordRateLimit(selected, context.family, context.model);
			accountManager.saveToDiskDebounced();
			state.status.rotations += 1;
			continue;
		}
		if (!accountManager.consumeToken(selected, context.family, context.model)) {
			skipReasons.set(selected.index, "circuit-open");
			continue;
		}
		attemptBudget.attempts += 1;
		const prepared: PreparedWebSocketAccount = {
			accountManager,
			account: selected,
			accessToken: "",
			accountId: "",
			request,
			isPinned,
			tokenRefundable: true,
			abortHandshake: null,
		};
		if (!lifecycle.onPrepared(prepared)) {
			lifecycle.onReleased(prepared);
			refundPreparedWebSocketToken(prepared);
			return null;
		}
		const refreshed = await ensureFreshAccessToken({
			accountManager,
			account: selected,
			family: context.family,
			model: context.model,
			now: state.now(),
			tokenRefreshSkewMs: state.tokenRefreshSkewMs,
			tokenInvalidationCooldownMs: state.tokenInvalidationCooldownMs,
		});
		if (!refreshed.ok) {
			lifecycle.onReleased(prepared);
			refundPreparedWebSocketToken(prepared);
			skipReasons.set(selected.index, "auth-failure");
			if (refreshed.invalidated) {
				state.sessionAffinityStore?.forgetSession(context.sessionKey);
				await request.usageRecorder.record({
					outcome: "failure",
					statusCode: HTTP_STATUS.UNAUTHORIZED,
					errorCode: "token_invalidated",
					account: selected,
				});
				throw createRuntimeProxyHttpError(
					"OAuth token has been invalidated. Please re-login.",
					HTTP_STATUS.UNAUTHORIZED,
					"token_invalidated",
				);
			}
			continue;
		}
		prepared.account = refreshed.account;
		prepared.accessToken = refreshed.accessToken;
		if (lifecycle.isClosed() || !prepared.tokenRefundable) {
			lifecycle.onReleased(prepared);
			refundPreparedWebSocketToken(prepared);
			return null;
		}
		const accountId = resolveAccountId(refreshed.account, refreshed.accessToken);
		if (!accountId) {
			lifecycle.onReleased(prepared);
			refundPreparedWebSocketToken(prepared);
			accountManager.recordFailure(refreshed.account, context.family, context.model);
			accountManager.markAccountCoolingDown(
				refreshed.account,
				DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
				"auth-failure",
			);
			accountManager.saveToDiskDebounced();
			skipReasons.set(refreshed.account.index, "auth-failure");
			continue;
		}
		prepared.accountId = accountId;
		return prepared;
	}
	return null;
}

async function connectManagedWebSocket(
	state: RotationProxyState,
	req: IncomingMessage,
	request: PreparedWebSocketRequest,
	lifecycle: WebSocketHandshakeLifecycle,
): Promise<{ upstream: WebSocket; prepared: PreparedWebSocketAccount } | null> {
	const attemptedIndexes = new Set<number>();
	const skipReasons = new Map<number, string>();
	const attemptBudget: WebSocketAttemptBudget = {
		attempts: 0,
		limit: Math.max(
			1,
			Math.min(
				state.activeAccountManager.getAccountCount(),
				state.maxRuntimeAccountAttempts,
			),
		),
	};
	while (
		attemptedIndexes.size < state.activeAccountManager.getAccountCount() &&
		attemptBudget.attempts < attemptBudget.limit
	) {
		const prepared = await prepareWebSocketAccount(
			state,
			request,
			attemptedIndexes,
			skipReasons,
			attemptBudget,
			lifecycle,
		);
		if (!prepared) break;
		const { accountManager, account, accessToken, accountId, isPinned } = prepared;
		const { context } = request;
		const abortController = new AbortController();
		prepared.abortHandshake = () => abortController.abort();
		if (lifecycle.isClosed() || !prepared.tokenRefundable) {
			prepared.abortHandshake = null;
			lifecycle.onReleased(prepared);
			refundPreparedWebSocketToken(prepared);
			break;
		}
		try {
			state.status.upstreamRequests += 1;
			const upstream = await openUpstreamWebSocket(
				buildWebSocketUpstreamUrl(req, state.upstreamBaseUrl),
				createWebSocketOutboundHeaders(context.headers, account, accessToken, accountId),
				state.fetchTimeoutMs,
				abortController.signal,
			);
			prepared.abortHandshake = null;
			if (lifecycle.isClosed()) {
				refundPreparedWebSocketToken(prepared);
				lifecycle.onReleased(prepared);
				mirrorWebSocketClose(upstream, 1000, "Local client closed");
				break;
			}
			accountManager.recordSuccess(account, context.family, context.model);
			recordRuntimeAccountRecovery(account.index);
			recordLastRuntimeAccount(
				state.status,
				accountIdentityFromAccount(account, state.now()),
			);
			state.sessionAffinityStore?.remember(context.sessionKey, account.index, state.now());
			await persistRuntimeActiveAccount(
				accountManager,
				account,
				context.family,
				isPinned,
				state.schedulingStrategy,
			);
			return { upstream, prepared };
		} catch (error) {
			prepared.abortHandshake = null;
			lifecycle.onReleased(prepared);
			refundPreparedWebSocketToken(prepared);
			if (lifecycle.isClosed()) break;
			state.status.lastError = error instanceof Error ? error.message : String(error);
			const handshakeError = error instanceof WebSocketHandshakeError ? error : null;
			const statusCode = handshakeError?.statusCode ?? null;
			const bodyText = handshakeError?.bodyText ?? "";
			const errorCode = extractErrorCodeFromBody(bodyText);
			state.sessionAffinityStore?.forgetSession(context.sessionKey);
			if (statusCode === HTTP_STATUS.UNAUTHORIZED) {
				accountManager.recordFailure(account, context.family, context.model);
				if (
					errorCode === "token_invalidated" ||
					isTokenInvalidationError(bodyText)
				) {
					accountManager.markAuthInvalidated(
						account,
						errorCode ?? "token_invalidated",
					);
					applyMonotonicAuthCooldown(
						accountManager,
						account,
						state.tokenInvalidationCooldownMs,
					);
					await accountManager.saveToDisk();
					await request.usageRecorder.record({
						outcome: "failure",
						statusCode,
						errorCode: "token_invalidated",
						account,
					});
					throw createRuntimeProxyHttpError(
						"OAuth token has been invalidated. Please re-login.",
						HTTP_STATUS.UNAUTHORIZED,
						"token_invalidated",
					);
				}
				applyMonotonicAuthCooldown(
					accountManager,
					account,
					DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
				);
			} else if (statusCode === HTTP_STATUS.TOO_MANY_REQUESTS) {
				const retryAfterMs =
					(handshakeError
						? parseRetryAfterHeaderMs(handshakeError.headers, state.now())
						: null) ??
					parseRetryAfterBodyMs(bodyText, state.now()) ??
					60_000;
				state.preemptiveQuotaScheduler.markRateLimited(
					buildQuotaScheduleKey(account, context.family, context.model),
					retryAfterMs,
					state.now(),
				);
				accountManager.recordRateLimit(account, context.family, context.model);
				accountManager.markRateLimitedWithReason(
					account,
					retryAfterMs,
					context.family,
					"quota",
					context.model,
				);
			} else {
				accountManager.recordFailure(account, context.family, context.model);
				accountManager.markAccountCoolingDown(
					account,
					statusCode !== null && statusCode >= 500
						? state.serverErrorCooldownMs
						: state.networkErrorCooldownMs,
					statusCode !== null && statusCode >= 500 ? "server-error" : "network-error",
				);
			}
			accountManager.saveToDiskDebounced();
			if (isPinned) break;
			state.status.retries += 1;
			state.status.rotations += 1;
		}
	}
	return null;
}

function bridgeWebSocketConnection(
	state: RotationProxyState,
	req: IncomingMessage,
	client: WebSocket,
): void {
	const pending: PendingWebSocketFrame[] = [];
	const activeRequests: ActiveWebSocketRequest[] = [];
	let upstream: WebSocket | null = null;
	let boundAccountManager: AccountManager | null = null;
	let boundAccount: ManagedAccount | null = null;
	let pendingInitialRequest: PreparedWebSocketRequest | null = null;
	let pendingHandshake: PreparedWebSocketAccount | null = null;
	let connecting = false;
	let closed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let clientFrameQueue = Promise.resolve();
	const settlePendingHandshake = (
		outcome: "failure" | "cancelled",
		errorCode: string,
		applyAccountFailure = false,
	): void => {
		const prepared = pendingHandshake;
		const request = prepared?.request ?? pendingInitialRequest;
		if (!request) return;
		pendingInitialRequest = null;
		pendingHandshake = null;
		const abortHandshake = prepared?.abortHandshake;
		if (prepared) prepared.abortHandshake = null;
		abortHandshake?.();
		if (prepared) refundPreparedWebSocketToken(prepared);
		if (prepared && applyAccountFailure) {
			applyWebSocketTransportAccountFailure(state, {
				request: prepared.request,
				accountManager: prepared.accountManager,
				account: prepared.account,
			});
		}
		void request.usageRecorder.record({
			outcome,
			statusCode: outcome === "failure" ? HTTP_STATUS.BAD_GATEWAY : null,
			errorCode,
			account: prepared?.account,
		});
	};
	const settleAll = (
		outcome: "failure" | "cancelled",
		errorCode: string,
		applyAccountFailure = false,
	): void => {
		for (const active of activeRequests.splice(0)) {
			if (applyAccountFailure) {
				applyWebSocketTransportAccountFailure(state, active);
			}
			void active.request.usageRecorder.record({
				outcome,
				statusCode: outcome === "failure" ? HTTP_STATUS.BAD_GATEWAY : null,
				errorCode,
				account: active.account,
			});
		}
	};
	const settlePending = (
		outcome: "failure" | "cancelled",
		errorCode: string,
	): void => {
		for (const frame of pending.splice(0)) {
			if (!frame.request) continue;
			void frame.request.usageRecorder.record({
				outcome,
				statusCode: outcome === "failure" ? HTTP_STATUS.BAD_GATEWAY : null,
				errorCode,
			});
		}
	};
	const closeBoth = (code = WEBSOCKET_CLOSE_TRY_AGAIN_LATER, reason = "WebSocket proxy closed"): void => {
		if (closed) return;
		closed = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		mirrorWebSocketClose(client, code, reason);
		if (upstream) mirrorWebSocketClose(upstream, code, reason);
	};
	const reportConnectionScopedContinuationLoss = (): void => {
		if (client.readyState !== WebSocket.OPEN) return;
		// Match the Responses WebSocket protocol used by the official Codex CLI.
		// It treats this code as retryable, discards its cached socket state, and
		// rebuilds the next attempt from the full request instead of replaying a
		// previous_response_id that belonged to a different upstream connection.
		client.send(JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				code: PREVIOUS_RESPONSE_NOT_FOUND_CODE,
				message: PREVIOUS_RESPONSE_NOT_FOUND_MESSAGE,
			},
		}));
	};
	const rejectConnection = (error: unknown): void => {
		state.status.lastError = error instanceof Error ? error.message : String(error);
		settlePendingHandshake("failure", "websocket_proxy_failed");
		settleAll("failure", "websocket_proxy_failed");
		const policyViolation =
			error instanceof CodexValidationError || isRuntimeProxyHttpError(error);
		closeBoth(
			policyViolation
				? WEBSOCKET_CLOSE_POLICY_VIOLATION
				: WEBSOCKET_CLOSE_TRY_AGAIN_LATER,
			policyViolation ? "WebSocket request rejected" : "WebSocket proxy failed",
		);
	};
	const forwardClientFrame = async (
		frame: PendingWebSocketFrame,
		preparedHandshake?: PreparedWebSocketAccount,
	): Promise<void> => {
		if (closed || upstream?.readyState !== WebSocket.OPEN) {
			if (preparedHandshake) {
				settlePendingHandshake("cancelled", "client_websocket_closed");
			}
			return;
		}
		let request = preparedHandshake?.request ?? frame.request;
		let consumedForFrame = false;
		if (!request) {
			const parsed = parseRequestBody(rawDataToBuffer(frame.data));
			if (readStringRecordValue(parsed ?? {}, "type") !== "response.create") {
				upstream.send(frame.data, { binary: frame.isBinary });
				return;
			}
			request = await prepareWebSocketRequest(state, req, frame.data);
			if (!boundAccountManager || !boundAccount) {
				throw createRuntimeProxyHttpError(
					"The account bound to this WebSocket connection is unavailable.",
					HTTP_STATUS.SERVICE_UNAVAILABLE,
					"websocket_account_unavailable",
				);
			}
			try {
				await consumeWebSocketRequestForAccount(
					request,
					boundAccountManager,
					boundAccount,
				);
			} catch (error) {
				if (!isRecoverableWebSocketAccountError(error)) throw error;
				const staleUpstream = upstream;
				const staleAccount = boundAccount;
				upstream = null;
				boundAccountManager = null;
				boundAccount = null;
				if (staleUpstream) {
					mirrorWebSocketClose(staleUpstream, 1000, "account_rotation");
				}
				if (hasConnectionScopedContinuation(frame)) {
					void request.usageRecorder.record({
						outcome: "failure",
						statusCode: HTTP_STATUS.BAD_GATEWAY,
						errorCode: "websocket_continuation_lost",
						account: staleAccount ?? undefined,
					});
					reportConnectionScopedContinuationLoss();
					return;
				}
				pending.unshift({
					...frame,
					recoveryAttempts: frame.recoveryAttempts ?? 0,
					request,
				});
				void initialize();
				return;
			}
			consumedForFrame = true;
			activeRequests.push({
				request,
				accountManager: boundAccountManager,
				account: boundAccount,
				frame,
				sawUpstreamEvent: false,
			});
		} else {
			if (!boundAccountManager || !boundAccount) {
				throw createRuntimeProxyHttpError(
					"The account bound to this WebSocket connection is unavailable.",
					HTTP_STATUS.SERVICE_UNAVAILABLE,
					"websocket_account_unavailable",
				);
			}
			activeRequests.push({
				request,
				accountManager: boundAccountManager,
				account: boundAccount,
				frame,
				sawUpstreamEvent: false,
			});
		}
		try {
			upstream.send(frame.data, { binary: frame.isBinary });
		} catch (error) {
			const active = activeRequests.pop();
			if (active) applyWebSocketTransportAccountFailure(state, active);
			if (preparedHandshake) refundPreparedWebSocketToken(preparedHandshake);
			else if (consumedForFrame && boundAccountManager && boundAccount) {
				boundAccountManager.refundToken(
					boundAccount,
					request.context.family,
					request.context.model,
				);
			}
			await request.usageRecorder.record({
				outcome: "failure",
				statusCode: HTTP_STATUS.BAD_GATEWAY,
				errorCode: "websocket_send_failed",
				account: boundAccount,
			});
			throw error;
		}
		if (preparedHandshake) {
			preparedHandshake.tokenRefundable = false;
			preparedHandshake.abortHandshake = null;
			if (pendingInitialRequest === preparedHandshake.request) {
				pendingInitialRequest = null;
			}
			if (pendingHandshake === preparedHandshake) pendingHandshake = null;
		}
	};
	const enqueueClientFrame = (
		frame: PendingWebSocketFrame,
		preparedHandshake?: PreparedWebSocketAccount,
	): void => {
		clientFrameQueue = clientFrameQueue
			.then(() => forwardClientFrame(frame, preparedHandshake))
			.catch(rejectConnection);
	};
	const handshakeLifecycle: WebSocketHandshakeLifecycle = {
		onPrepared: (prepared) => {
			pendingHandshake = prepared;
			if (!closed) return true;
			settlePendingHandshake("cancelled", "client_websocket_closed");
			return false;
		},
		onReleased: (prepared) => {
			if (pendingHandshake === prepared) pendingHandshake = null;
		},
		isClosed: () => closed,
	};
	async function initialize(): Promise<void> {
		if (connecting || reconnectTimer || upstream || pending.length === 0) return;
		connecting = true;
		try {
			const firstFrame = pending[0];
			if (!firstFrame) return;
			// previous_response_id is scoped to the upstream WebSocket connection.
			// If the proxy needs a new upstream connection, replaying that delta frame
			// would make Codex reject it. Emit the backend's standard retryable error so
			// the client clears its cached continuation and rebuilds a full request.
			if (hasConnectionScopedContinuation(firstFrame)) {
				pending.shift();
				reportConnectionScopedContinuationLoss();
				return;
			}
			const firstRequest =
				firstFrame.request ?? await prepareWebSocketRequest(state, req, firstFrame.data);
			firstFrame.request = firstRequest;
			pendingInitialRequest = firstRequest;
			if (closed) {
				settlePendingHandshake("cancelled", "client_websocket_closed");
				return;
			}
			const connected = await connectManagedWebSocket(
				state,
				req,
				firstRequest,
				handshakeLifecycle,
			);
			if (!connected) {
				pendingInitialRequest = null;
				if (firstFrame.recoveryAttempts !== undefined) {
					const attempt = firstFrame.recoveryAttempts + 1;
					firstFrame.recoveryAttempts = attempt;
					const delayMs = Math.min(
						INITIAL_WEBSOCKET_RECOVERY_DELAY_MS * 2 ** Math.max(0, attempt - 1),
						MAX_WEBSOCKET_RECOVERY_DELAY_MS,
					);
					reconnectTimer = setTimeout(() => {
						reconnectTimer = null;
						void initialize();
					}, delayMs);
					reconnectTimer.unref?.();
					return;
				}
				pending.shift();
				await firstRequest.usageRecorder.record({
					outcome: "failure",
					statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
					errorCode: "codex_runtime_rotation_pool_exhausted",
				});
				closeBoth(
					WEBSOCKET_CLOSE_TRY_AGAIN_LATER,
					"All managed Codex accounts are temporarily unavailable",
				);
				return;
			}
			upstream = connected.upstream;
			const connectedUpstream = connected.upstream;
			boundAccountManager = connected.prepared.accountManager;
			boundAccount = connected.prepared.account;
			if (closed || client.readyState !== WebSocket.OPEN) {
				settlePendingHandshake("cancelled", "client_websocket_closed");
				mirrorWebSocketClose(connectedUpstream, 1000, "Local client closed");
				return;
			}
			state.status.streamsStarted += 1;
			connectedUpstream.on("message", (data, isBinary) => {
				const active = activeRequests[0];
				if (active) active.sawUpstreamEvent = true;
				const terminal = websocketTerminalUsage(data);
				if (terminal) {
					const settled = activeRequests.shift();
					if (settled) {
						applyWebSocketTerminalAccountSuccess(state, settled, terminal);
						applyWebSocketTerminalAccountFailure(state, settled, terminal);
						void settled.request.usageRecorder.record({
							...terminal.record,
							account: settled.account,
						});
					}
				}
				if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
			});
			connectedUpstream.on("close", (code, reason) => {
				if (upstream !== connectedUpstream) return;
				upstream = null;
				boundAccountManager = null;
				boundAccount = null;
				settlePendingHandshake("failure", "upstream_websocket_closed", true);
				if (activeRequests.length === 0) return;
				if (
					activeRequests.length === 1 &&
					activeRequests[0]?.sawUpstreamEvent === false
				) {
					const [interrupted] = activeRequests.splice(0);
					if (interrupted) {
						applyWebSocketTransportAccountFailure(state, interrupted);
						if (hasConnectionScopedContinuation(interrupted.frame)) {
							void interrupted.request.usageRecorder.record({
								outcome: "failure",
								statusCode: HTTP_STATUS.BAD_GATEWAY,
								errorCode: "websocket_continuation_lost",
								account: interrupted.account,
							});
							reportConnectionScopedContinuationLoss();
							return;
						}
						pending.unshift({
							...interrupted.frame,
							recoveryAttempts: interrupted.frame.recoveryAttempts ?? 0,
							request: interrupted.request,
						});
						void initialize();
						return;
					}
				}
				settleAll("failure", "upstream_websocket_closed", true);
				closed = true;
				mirrorWebSocketClose(client, code, reason);
			});
			connectedUpstream.on("error", (error) => {
				state.status.lastError = error.message;
				connectedUpstream.terminate();
			});
			const queued = pending.splice(0);
			const queuedFirst = queued.shift();
			if (queuedFirst) enqueueClientFrame(queuedFirst, connected.prepared);
			for (const frame of queued) {
				enqueueClientFrame(frame);
			}
		} catch (error) {
			rejectConnection(error);
		} finally {
			connecting = false;
		}
	}
	client.on("message", (data, isBinary) => {
		if (upstream?.readyState === WebSocket.OPEN) {
			enqueueClientFrame({ data, isBinary });
			return;
		}
		pending.push({ data, isBinary });
		void initialize();
	});
	client.on("close", (code, reason) => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		settlePendingHandshake("cancelled", "client_websocket_closed");
		settleAll("cancelled", "client_websocket_closed");
		settlePending("cancelled", "client_websocket_closed");
		closed = true;
		if (upstream) mirrorWebSocketClose(upstream, code, reason);
	});
	client.on("error", (error) => {
		state.status.lastError = error.message;
		settlePendingHandshake("failure", "client_websocket_error");
		settleAll("failure", "client_websocket_error");
		settlePending("failure", "client_websocket_error");
		closeBoth(WEBSOCKET_CLOSE_TRY_AGAIN_LATER, "Local WebSocket error");
	});
}

/**
 * Coerce a forced-account pin from an option (number) or the launcher's env
 * string into a normalized 0-based index, or null when absent/invalid. Invalid
 * or negative values collapse to null so an out-of-range env value can never
 * throw at proxy startup; chooseAccount reports the deterministic
 * pinned-account failure per-request instead. Exported for unit tests.
 *
 * @internal
 */
export function normalizeForcedAccountIndex(
	value: number | string | null | undefined,
): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed =
		typeof value === "number" ? value : Number.parseInt(value.trim(), 10);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return null;
	}
	return parsed;
}

export async function startRuntimeRotationProxy(
	options: RuntimeRotationProxyOptions,
): Promise<RuntimeRotationProxyServer> {
	const pluginConfig = loadPluginConfig();
	const activeAccountManager = options.accountManager ?? (await AccountManager.loadFromDisk());
	// accounts-01/08: apply the configured routing-mutex mode so the proxy's
	// async select->commit path (persistRuntimeActiveAccount) can serialize cursor
	// mutations when routingMutex="enabled". Legacy mode keeps the inline fast path.
	const routingMutexMode = getRoutingMutexMode(pluginConfig);
	activeAccountManager.setRoutingMutexMode(routingMutexMode);
	const schedulingStrategy = getSchedulingStrategy(pluginConfig);
	const fetchImpl = options.fetchImpl ?? fetch;
	const host = options.host ?? DEFAULT_HOST;
	// Defense in depth (runtime-proxy-01): the proxy presents managed OAuth tokens
	// and must never be reachable off-box. It is loopback-only with NO opt-out —
	// binding a non-loopback host would expose every managed account to the
	// network, so it is refused unconditionally.
	if (!isLoopbackHost(host)) {
		throw new CodexValidationError(
			`Runtime rotation proxy refuses to bind non-loopback host "${host}". ` +
				"It forwards managed OAuth tokens and is loopback-only.",
			{ field: "host", expected: "a loopback host", context: { host } },
		);
	}
	// Normalize the validated host into its two representations exactly once so the
	// listen() bind and the emitted baseUrl can never disagree under concurrent
	// rotation: bindHost is the raw literal Node's listen() expects ("[::1]"->"::1"),
	// urlHost is the bracketed form a URL authority requires ("::1"->"[::1]").
	const bindHost = toBindHost(host);
	const urlHost = toUrlHost(host);
	const port = options.port ?? 0;
	const upstreamBaseUrl = options.upstreamBaseUrl ?? CODEX_BASE_URL;
	const clientApiKey =
		typeof options.clientApiKey === "string" &&
		options.clientApiKey.trim().length > 0
			? options.clientApiKey.trim()
			: null;
	if (!clientApiKey) {
		throw new CodexValidationError(
			"Runtime rotation proxy requires a clientApiKey.",
			{ field: "clientApiKey", expected: "a non-empty string" },
		);
	}
	const now = options.now ?? Date.now;
	// Ephemeral per-invocation pin (issue #623). Prefer an explicit option (used by
	// tests and the in-process inline proxy); otherwise fall back to the numeric env
	// the launcher publishes, which is how the value reaches a detached app-helper
	// process. `??` means both `undefined` and an explicit `null` option defer to the
	// env, so "no option" and "no pin" behave identically. Invalid/negative values
	// are ignored (treated as "no forced pin") rather than throwing — the launcher
	// already validated the selector, and an out-of-range index is surfaced
	// per-request as a deterministic pinned-account failure by chooseAccount rather
	// than crashing proxy startup.
	const forcedAccountIndex = normalizeForcedAccountIndex(
		options.forcedAccountIndex ??
			process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX,
	);
	const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
	const networkErrorCooldownMs = getNetworkErrorCooldownMs(pluginConfig);
	const serverErrorCooldownMs = getServerErrorCooldownMs(pluginConfig);
	// Normalize the explicit option as well as the env var: a caller passing a
	// negative or multi-hour value would otherwise bypass the documented cap.
	// `0` stays 0, since it is the documented kill switch.
	const modelCapacityRetryMs =
		options.modelCapacityRetryMs === 0
			? 0
			: options.modelCapacityRetryMs === undefined
				? resolveModelCapacityRetryMs()
				: normalizeModelCapacityRetryMs(options.modelCapacityRetryMs);
	const tokenInvalidationCooldownMs = getTokenInvalidationCooldownMs(pluginConfig);
	const minRotationIntervalMs = getMinRotationIntervalMs(pluginConfig);
	const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
	const fetchTimeoutMs = options.fetchTimeoutMs ?? getFetchTimeoutMs(pluginConfig);
	const streamStallTimeoutMs =
		options.streamStallTimeoutMs ?? getStreamStallTimeoutMs(pluginConfig);
	const configuredMaxRetries = getRetryAllAccountsMaxRetries(pluginConfig);
	const maxRuntimeAccountAttempts =
		configuredMaxRetries > 0
			? configuredMaxRetries + 1
			: DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS;
	const maxRequestBodyBytes =
		options.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;
	const quotaRemainingPercentThreshold =
		options.quotaRemainingPercentThreshold ?? DEFAULT_QUOTA_REMAINING_THRESHOLD;
	const preemptiveQuotaScheduler = new PreemptiveQuotaScheduler({
		enabled: getPreemptiveQuotaEnabled(pluginConfig),
		remainingPercentThresholdPrimary:
			options.quotaRemainingPercentThreshold ??
			getPreemptiveQuotaRemainingPercent5h(pluginConfig),
		remainingPercentThresholdSecondary:
			options.quotaRemainingPercentThreshold ??
			getPreemptiveQuotaRemainingPercent7d(pluginConfig),
		maxDeferralMs: getPreemptiveQuotaMaxDeferralMs(pluginConfig),
	});
	const contextBudgetGuard = new ContextBudgetGuard({
		enabled: getContextBudgetGuardEnabled(pluginConfig),
		softPercent: getContextBudgetGuardSoftPercent(pluginConfig),
		hardPercent: getContextBudgetGuardHardPercent(pluginConfig),
		modelWindowOverrides: getContextBudgetGuardModelWindowOverrides(pluginConfig),
	});
	const sessionAffinityStore = getSessionAffinity(pluginConfig)
		? new SessionAffinityStore({
				ttlMs: getSessionAffinityTtlMs(pluginConfig),
				maxEntries: getSessionAffinityMaxEntries(pluginConfig),
			})
		: null;
	// Initialize from disk so the proxy starts in sync with whatever generation
	// the storage file already shows. Subsequent disk bumps (from CLI commands)
	// are detected per-request via `maybeInvalidateAffinityFromDisk`.
	const lastObservedAffinityGeneration =
		readStorageMetaFromDisk().affinityGeneration;
	const state = createRotationProxyState({
		activeAccountManager,
		routingMutexMode,
		schedulingStrategy,
		fetchImpl,
		upstreamBaseUrl,
		clientApiKey,
		now,
		tokenRefreshSkewMs,
		networkErrorCooldownMs,
		serverErrorCooldownMs,
		modelCapacityRetryMs,
		tokenInvalidationCooldownMs,
		minRotationIntervalMs,
		pidOffsetEnabled,
		fetchTimeoutMs,
		streamStallTimeoutMs,
		maxRuntimeAccountAttempts,
		maxRequestBodyBytes,
		quotaRemainingPercentThreshold,
		preemptiveQuotaScheduler,
		contextBudgetGuard,
		sessionAffinityStore,
		lastObservedAffinityGeneration,
		forcedAccountIndex,
	});

	const server = createServer((req, res) => {
		void handleRequest(state, req, res);
	});
	const webSocketServer = new WebSocketServer({
		noServer: true,
		maxPayload: maxRequestBodyBytes,
		perMessageDeflate: false,
	});
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
		});
	});
	server.on("upgrade", (req, socket, head) => {
		let incomingUrl: URL;
		try {
			incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		} catch {
			rejectWebSocketUpgrade(socket, HTTP_STATUS.BAD_REQUEST, "Bad Request");
			return;
		}
		if (!isResponsesPath(incomingUrl.pathname)) {
			rejectWebSocketUpgrade(socket, 404, "Not Found");
			return;
		}
		if (!isAuthorizedClient(headersFromIncoming(req), clientApiKey)) {
			rejectWebSocketUpgrade(socket, HTTP_STATUS.UNAUTHORIZED, "Unauthorized");
			return;
		}
		webSocketServer.handleUpgrade(req, socket, head, (client) => {
			bridgeWebSocketConnection(state, req, client);
		});
	});
	const onPostStartupServerError = (error: Error): void => {
		state.status.lastError = error.message;
	};

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, bindHost);
	});
	server.on("error", onPostStartupServerError);

	const address = server.address();
	const resolvedPort =
		typeof address === "object" && address ? address.port : port;

	return {
		host: bindHost,
		port: resolvedPort,
		baseUrl: `http://${urlHost}:${resolvedPort}`,
		close: async () => {
			for (const client of webSocketServer.clients) client.terminate();
			webSocketServer.close();
			await closeServer(server, sockets);
			await state.activeAccountManager.flushPendingSave();
		},
		// Live client connections, which the app helper reads as evidence that a
		// detached consumer is still attached: a helper whose launcher is gone
		// and whose socket set is empty has nobody left to serve.
		getOpenConnectionCount: () => sockets.size,
		getStatus: () => ({
			...state.status,
			// Redact any email/token material that leaked into a raw upstream or
			// refresh error string before exposing it to status/report consumers
			// (errors-logging-08). maskString is a no-op for clean diagnostic text.
			lastError: state.status.lastError === null ? null : maskString(state.status.lastError),
		}),
	};
}

async function handleRequest(
	state: RotationProxyState,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	// Per-request trace id (errors-logging-03): distinct from sessionKey, which
	// is shared across a thread's requests. Bound to this request's async context
	// so every proxyLog line and usage row can be correlated to one request.
	const traceId = randomUUID();
	return runWithCorrelationId(traceId, () => handleRequestInner(state, req, res, traceId));
}

async function handleRequestInner(
	state: RotationProxyState,
	req: IncomingMessage,
	res: ServerResponse,
	traceId: string,
): Promise<void> {
	let usageRecorder: ReturnType<typeof createRuntimeUsageRecorder> | null = null;
	let accountManager = state.activeAccountManager;
	try {
		const incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		// Authenticate before discriminating path/method so an unauthenticated
		// caller cannot enumerate which endpoints exist: an unknown caller always
		// gets 401, never a 404 that would confirm a path is invalid (vs. just
		// unauthorized). Authorized callers still fall through to the 404 below
		// when they hit an unsupported path/method.
		const incomingHeaders = headersFromIncoming(req);
		if (!isAuthorizedClient(incomingHeaders, state.clientApiKey)) {
			writeUnauthorized(res);
			return;
		}

		const isResponsesRequest =
			req.method === "POST" && isResponsesPath(incomingUrl.pathname);
		const isModelsRequest =
			req.method === "GET" && isModelsPath(incomingUrl.pathname);
		const isImageRequest =
			req.method === "POST" && ALLOWED_IMAGE_PATHS.has(incomingUrl.pathname);
		const isThreadGoalRequest =
			(req.method === "GET" || req.method === "POST") &&
			isThreadGoalPath(incomingUrl.pathname);
		if (
			!isResponsesRequest && !isModelsRequest &&
			!isThreadGoalRequest && !isImageRequest
		) {
			writeMethodOrPathError(res);
			return;
		}

		state.status.totalRequests += 1;
		const requestBody =
			isResponsesRequest || isImageRequest ||
			(isThreadGoalRequest && req.method === "POST")
				? await readRequestBody(req, state.maxRequestBodyBytes)
				: Buffer.alloc(0);
		const context = isModelsRequest
			? buildModelsRequestContext(req)
			: isThreadGoalRequest
				? buildThreadGoalRequestContext(req, requestBody, incomingUrl.pathname)
				: isImageRequest
					? buildImageRequestContext(req, requestBody, incomingUrl.pathname)
					: buildResponsesRequestContext(req, requestBody);
		const requestStartedAt = state.now();
		let policyDecision: RuntimePolicyDecision | null = null;
		let projectKey: string | null = null;
		let policyError: string | null = null;
		try {
			const policyState = await loadRuntimePolicyState();
			projectKey = policyState.project.projectKey;
			policyDecision = await evaluateRuntimePolicy({
				state: policyState,
				accounts: accountManager.getAccountsSnapshot(),
				model: context.model,
				now: requestStartedAt,
			});
			mutateRuntimeObservabilitySnapshot((snapshot) => {
				snapshot.policyBlockedIndexes = [
					...(policyDecision?.blockedAccountIndexes ?? new Set<number>()),
				];
				snapshot.policyBlockedReasons = Object.fromEntries(
					[...(policyDecision?.blockedAccountIndexes ?? new Set<number>())].map(
						(index) => [String(index), "policy-blocked"],
					),
				);
			});
		} catch (error) {
			policyError = error instanceof Error ? error.message : String(error);
			state.status.lastError = policyError;
		}
		usageRecorder = createRuntimeUsageRecorder({
			source: "runtime-proxy",
			operation: isModelsRequest
				? "models"
				: isThreadGoalRequest
					? "thread-goal"
					: isImageRequest
						? "images"
						: "responses",
			model: context.model,
			projectKey,
			requestId: traceId,
			startedAt: requestStartedAt,
		});
		if (policyError) {
			await usageRecorder.record({
				outcome: "failure",
				statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
				errorCode: "runtime_policy_unavailable",
			});
			writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
				error: {
					message: "Runtime policy could not be loaded for this local request.",
					code: "runtime_policy_unavailable",
				},
			});
			return;
		}
		if (policyDecision && !policyDecision.allowed) {
			await usageRecorder.record({
				outcome: "blocked",
				statusCode: policyDecision.statusCode,
				errorCode: policyDecision.errorCode,
			});
			writeJson(res, policyDecision.statusCode, {
				error: {
					message: "Runtime policy blocked this local request.",
					code: policyDecision.errorCode ?? "policy_blocked",
					reasons: policyDecision.reasons,
				},
			});
			return;
		}
		// Context budget guard: pause BEFORE spending an upstream round-trip on a
		// request that the tracked session is already over the hard threshold
		// for, rather than reacting to the eventual context_length_exceeded 400
		// (which this rotation-proxy path does not otherwise handle at all — see
		// lib/context-overflow.ts, wired only into the plugin-loader fetch path).
		// Runs independent of account selection: which account serves the
		// request has no bearing on how full its context already is. Hoisted
		// to function scope (not just this `if`) so the soft-threshold branch
		// below can attach its non-blocking header to the eventual forwarded
		// response.
		let budgetAdvisory: ReturnType<typeof state.contextBudgetGuard.getAdvisory> = {
			level: "ok",
		};
		if (isResponsesRequest) {
			budgetAdvisory = state.contextBudgetGuard.getAdvisory(
				context.stableSessionKey ?? "",
				requestStartedAt,
				context.model,
			);
			if (budgetAdvisory.level === "hard") {
				// One-shot: the pause returns before the request is forwarded, so
				// `update()` below never runs for it and the recorded usage cannot
				// fall on its own. Without dropping the snapshot the first crossing
				// would wedge the session permanently — including the `/compact`
				// turn this pause tells the user to run, which carries the same
				// session key.
				state.contextBudgetGuard.noteHardPauseEmitted(
					context.stableSessionKey ?? "",
				);
				await usageRecorder.record({
					outcome: "blocked",
					statusCode: HTTP_STATUS.OK,
					errorCode: "context_budget_guard_paused",
				});
				const pauseResponse = createContextBudgetPauseResponse(budgetAdvisory);
				res.writeHead(
					pauseResponse.status,
					Object.fromEntries(pauseResponse.headers.entries()),
				);
				res.end(await pauseResponse.text());
				return;
			}
		}

		const upstreamUrl = buildUpstreamUrl(
			req,
			state.upstreamBaseUrl,
			context.upstreamPath,
		);
		const attemptedIndexes = new Set<number>();
		let exhaustionReason: ExhaustionReason = "no-account";
		let accountCount = accountManager.getAccountCount();
		let transientAttemptLimit = Math.max(
			1,
			Math.min(accountCount, state.maxRuntimeAccountAttempts),
		);
		let transientAttempts = 0;
		let transientExhaustionReason: ExhaustionReason | null = null;
		// Capacity waits are counted separately from `transientAttempts` and from
		// the pinned selection cap. Both of those bound how many DIFFERENT
		// accounts or re-sends a failing request may burn; a capacity wait is not
		// a failure of any account, it is the same request pausing for an
		// upstream that is busy, and it has its own wall-clock ceiling. See #689.
		let capacityRetries = 0;
		// A wall-clock deadline, not a sum of sleeps. The upstream request and
		// the error-body read also consume the budget, so summing only the
		// planned sleeps let a slow capacity response push one request past the
		// documented ceiling. Request-local, so concurrent requests never share
		// a deadline.
		let capacityDeadlineAt: number | null = null;
		// Only the RESPONSE tells us the caller is still there. `req` is an
		// IncomingMessage whose stream Node destroys once the request body has
		// been fully read, which this proxy does up front, so `req.destroyed` is
		// routinely true on a perfectly healthy request and must not be read as a
		// disconnect.
		const clientGone = (): boolean => res.destroyed || res.writableEnded;
		const accountSkipReasons = new Map<number, string>();
		let reloadedAfterNoAccount = false;

		// Read the manual pin and affinity generation from disk (mtime-cached)
		// on each request so a `codex-multi-auth switch|unpin|best` invocation
		// in another process is honored without forcing a full AccountManager
		// reload. The CLI bumps `affinityGeneration` on user-initiated changes
		// so the proxy can invalidate sticky session affinity that would
		// otherwise glue an in-flight chat thread to the previously selected
		// account. The proxy itself never bumps the generation, so its own
		// debounced disk writes do not clear affinity. See issue #474.
		/** Reconcile once before selection or recording a new upstream observation. */
		const reconcileManualSelection = () => {
			const meta = readStorageMetaFromDisk();
			for (const manager of state.knownAccountManagers) {
				manager.applyManualSelection(meta);
			}
			if (meta.affinityGeneration > state.lastObservedAffinityGeneration) {
				const switchedAccount = meta.pinnedAccountIndex === null
					? null
					: accountManager.getAccountByIndex(meta.pinnedAccountIndex);
				if (switchedAccount) {
					state.preemptiveQuotaScheduler.clearByPrefix(
						buildQuotaScheduleAccountPrefix(switchedAccount),
					);
				} else if (meta.pinnedAccountIndex !== null) {
					// A pin we cannot resolve: this long-lived proxy re-reads only
					// pin/gen, never the account list, so a `login` that appended an
					// account before the `switch` leaves the new index out of range
					// here. The generation only bumps on the NEXT user-initiated
					// switch, so skipping the clear and advancing anyway would strand
					// the pre-switch quota observation forever, which is the exact
					// deferral this reconciliation exists to end. Drop every cached
					// observation instead: it only costs a re-probe, and real 429
					// windows live on the accounts themselves, not in this cache.
					state.preemptiveQuotaScheduler.clearAll();
				}
				state.sessionAffinityStore?.clearAll();
				state.lastObservedAffinityGeneration = meta.affinityGeneration;
			}
			return meta;
		};
		const storageMeta = reconcileManualSelection();
		// The ephemeral --account pin (issue #623) takes precedence over the
		// persisted `switch` pin for this invocation, without ever mutating disk
		// state. Use `??` (not `||`) so a forced index of 0 is honored. When set,
		// everything downstream — deterministic pick, no cursor advance, no
		// stale-state recovery, the `codex_pinned_account_unavailable` failure —
		// applies unchanged because it all keys off `pinnedIndex` / `isPinned`.
		const pinnedIndex = state.forcedAccountIndex ?? storageMeta.pinnedAccountIndex;
		const isPinned = typeof pinnedIndex === "number";
		// `rotations` counts moves to a DIFFERENT account. A pinned request has
		// nowhere to move: every retry below re-attempts the same one. Counting
		// those reported several account rotations on a single-account pool whose
		// pin forbids rotation, in `rotation status` and the persisted counters.
		const noteRotation = (): void => {
			if (!isPinned) state.status.rotations += 1;
		};
		// Pool attempts are normally capped by account count because an unpinned
		// account is selected at most once per request. A pin can only retry the
		// same account, so use the configured transient-attempt limit instead of
		// the account-count limit -- capped by MAX_PINNED_TRANSIENT_ATTEMPTS so a
		// pool knob about rate-limited rotation cannot become a same-account
		// re-send multiplier. Every pinned pass is still subject to the hard
		// 16-selection ceiling above.
		if (isPinned) {
			transientAttemptLimit = Math.max(
				1,
				Math.min(state.maxRuntimeAccountAttempts, MAX_PINNED_TRANSIENT_ATTEMPTS),
			);
		}

		/**
		 * Wait out a "selected model is at capacity" response, then let the loop
		 * re-send the request (issue #689).
		 *
		 * Capacity is a property of the MODEL, not of an account, so the normal
		 * handling is actively wrong for it: rotating spends the pool's transient
		 * budget against accounts that will all fail identically, and the request
		 * ends as a pool-exhausted 503 within seconds. That is what kills a
		 * long-running task started before the user stepped away.
		 *
		 * The responding account is left completely unpenalized: it is not marked
		 * rate limited or cooled down, and it is removed from `attemptedIndexes` so
		 * it stays selectable. Selection then
		 * runs normally on the next pass, which may pick a different account. That
		 * is deliberate: with capacity being model-wide, no account is a better bet,
		 * and forcing a request-local pin here would duplicate the pinning path for
		 * no gain.
		 *
		 * @param retryAfterMs Upstream hint when one was actually sent, else `null`
		 * so the backoff table is used. Do NOT pass a synthesized default.
		 * @param account Account that just saw the capacity response.
		 * @returns `"retry"` to re-send, `"give-up"` to fall through to normal
		 * handling, `"client-gone"` when the caller must abandon the request.
		 */
		const waitOutModelCapacity = async (
			retryAfterMs: number | null,
			account: ManagedAccount,
		): Promise<"retry" | "give-up" | "client-gone"> => {
			const budgetMs = state.modelCapacityRetryMs;
			if (!Number.isFinite(budgetMs) || budgetMs <= 0) return "give-up";
			if (capacityDeadlineAt === null) {
				capacityDeadlineAt = state.now() + budgetMs;
			}
			const remainingMs = capacityDeadlineAt - state.now();
			if (remainingMs <= 0) return "give-up";
			if (clientGone()) return "client-gone";
			const hinted =
				retryAfterMs !== null &&
				Number.isFinite(retryAfterMs) &&
				retryAfterMs > 0
					? retryAfterMs
					: capacityRetryBackoffMs(capacityRetries + 1);
			const waitMs = Math.min(Math.max(0, Math.floor(hinted)), remainingMs);
			if (waitMs <= 0) return "give-up";
			capacityRetries += 1;
			state.status.retries += 1;
			proxyLog.warn("model at capacity; waiting before re-sending", {
				traceId,
				waitMs,
				attempt: capacityRetries,
				remainingMs,
				budgetMs,
			});
			attemptedIndexes.delete(account.index);
			await sleep(waitMs);
			// A capacity wait runs for tens of seconds. Re-sending an authenticated
			// upstream request for a response nobody is reading wastes upstream
			// capacity and extends how long the token is in flight.
			if (clientGone()) return "client-gone";
			return "retry";
		};

		let runtimeSelectionIterations = 0;
		while (
			(isPinned || attemptedIndexes.size < accountCount) &&
			transientAttempts < transientAttemptLimit &&
			(!isPinned ||
				runtimeSelectionIterations - capacityRetries <
					MAX_PINNED_SELECTION_ITERATIONS)
		) {
			// Space out same-account re-sends. The loop has no other delay in it,
			// and the pinned retry deliberately waives the account's own cooldown
			// (below), so without this two copies of the same non-idempotent
			// request would hit upstream back to back.
			if (isPinned && transientAttempts > 0) {
				await sleep(pinnedRetryBackoffMs(transientAttempts));
			}
			runtimeSelectionIterations += 1;
			const rotationStickyBoost: Record<number, number> =
				state.minRotationIntervalMs > 0 &&
				state.lastGlobalAccountIndex !== null &&
				state.now() - state.lastGlobalSwitchAt < state.minRotationIntervalMs
					? { [state.lastGlobalAccountIndex]: 1000 }
					: {};
			// L4 fix (routing mutex): when `routingMutex === "enabled"`, run the
			// selection AND the cursor commit inside ONE mutex acquisition so two
			// concurrent requests cannot read the same cursor and stampede before
			// the locked commit lands. `chooseAccount` is sync and mutates the
			// cursor internally (session-affinity `markSwitched`, the hybrid
			// selector's own advance, and the round-robin fallback `markSwitched`);
			// holding the mutex across the whole call serializes all of those.
			// We then `markSwitchedLocked` the winner to (a) re-commit the cursor
			// under the lock across the await boundary and (b) hand
			// `persistRuntimeActiveAccount` a cursor that is already correct. That
			// later `markSwitchedLocked` runs INLINE (reentrant) within this held
			// section, so there is no double-acquire and no deadlock on the
			// non-reentrant FIFO queue. In legacy mode the inline `markSwitched`
			// calls inside `chooseAccount` are used unchanged and no lock is taken,
			// so default behavior and perf are identical to before.
			const selectAccount = (): ManagedAccount | null =>
				chooseAccount({
					accountManager,
					sessionAffinityStore: state.sessionAffinityStore,
					sessionKey: context.sessionKey,
					family: context.family,
					model: context.model,
					attemptedIndexes,
					now: state.now(),
					policy: policyDecision,
					pinnedIndex,
					skipReasons: accountSkipReasons,
					stickyBoostByAccount: rotationStickyBoost,
					pidOffsetEnabled: state.pidOffsetEnabled,
					schedulingStrategy: state.schedulingStrategy,
					// Only on a RETRY pass. The first pass still honors a cooldown
					// another request left on the pin, so an already-cooling pinned
					// account 503s immediately as before; from the second pass on,
					// this request's own retry budget outranks the cooldown it just
					// created for itself.
					allowPinnedCooldown: isPinned && transientAttempts > 0,
				});
			const selected =
				state.routingMutexMode === "enabled"
					? await withRoutingMutex(state.routingMutexMode, async () => {
							const candidate = selectAccount();
							if (
								candidate &&
								pinnedIndex === null &&
								state.schedulingStrategy !== "sequential"
							) {
								// Re-commit the cursor under the held mutex. Skipped when a
								// manual pin is active so the proxy never clobbers the pin
								// (see #474); pinned selections are deterministic and need no
								// cursor advance. Also skipped in sequential mode: the
								// sequential selector already committed the correct active
								// index inside this held mutex, and re-committing `candidate`
								// would wrongly advance the drain-first primary when the pick
								// came from the non-advancing linear-scan fallback (#509).
								// Runs inline via reentrancy — see comment above.
								await accountManager.markSwitchedLocked(
									candidate,
									"rotation",
									context.family,
								);
							}
							return candidate;
						})
					: selectAccount();
			if (!selected) {
				if (
					!reloadedAfterNoAccount &&
					!isPinned &&
					accountCount > 0 &&
					exhaustionReason === "no-account" &&
					(policyDecision?.blockedAccountIndexes.size ?? 0) === 0 &&
					![...accountSkipReasons.values()].some(
						// Only policy blocks still suppress stale-state recovery: a policy
						// decision is external and won't change across a disk reload, so
						// reloading cannot help. "rate-limited" and "cooling-down*" are
						// transient states that recovery is *designed* to escape — they are
						// persisted to disk (buildStorageSnapshot) and so survive a reload,
						// which previously deadlocked the pool against the very recovery that
						// would clear them. recoverStaleRuntimeState now wipes that transient
						// state after reloading, so let those reasons through (issue #606).
						(reason) => reason === "policy-blocked",
					)
				) {
					reloadedAfterNoAccount = true;
					const reloadedManager = await recoverStaleRuntimeState(state);
					if (reloadedManager) {
						accountManager = reloadedManager;
						accountCount = accountManager.getAccountCount();
						transientAttemptLimit = Math.max(
							1,
							Math.min(accountCount, state.maxRuntimeAccountAttempts),
						);
						accountSkipReasons.clear();
						attemptedIndexes.clear();
						continue;
					}
				}
				break;
			}
			attemptedIndexes.add(selected.index);
			const quotaScheduleKey = buildQuotaScheduleKey(
				selected,
				context.family,
				context.model,
			);
			const preemptiveDeferral = state.preemptiveQuotaScheduler.getDeferral(
				quotaScheduleKey,
				state.now(),
			);
			if (preemptiveDeferral.defer && preemptiveDeferral.waitMs > 0) {
				accountSkipReasons.set(
					selected.index,
					preemptiveDeferral.reason ?? "quota-near-exhaustion",
				);
				exhaustionReason = "rate-limit";
				accountManager.markRateLimitedWithReason(
					selected,
					preemptiveDeferral.waitMs,
					context.family,
					"quota",
					context.model,
				);
				accountManager.recordRateLimit(selected, context.family, context.model);
				accountManager.saveToDiskDebounced();
				noteRotation();
				continue;
			}

			// consumeToken also takes the race-safe circuit admission slot, so it
			// can reject for either gate. Take the reason from the call that
			// rejected rather than re-deriving it: a second evaluation reports the
			// first blocker it finds (a live cooldown would mask a drained bucket)
			// and cannot see a half-open probe slot that was just claimed.
			const admission = accountManager.consumeTokenWithReason(
				selected,
				context.family,
				context.model,
			);
			if (!admission.ok) {
				accountSkipReasons.set(selected.index, admission.reason);
				exhaustionReason = "rate-limit";
				// Neither gate can change inside this loop -- nothing here refills the
				// bucket or closes a circuit -- and a pin has no other account to move
				// to, so re-selecting would burn the whole 16-iteration ceiling
				// re-deriving the identical verdict. (For a pin the bucket is bypassed
				// entirely, so the reason here is always circuit-open.) Unpinned
				// selection still continues -- there the next pass picks a DIFFERENT
				// account.
				if (isPinned) break;
				continue;
			}

			const refreshed = await ensureFreshAccessToken({
				accountManager,
				account: selected,
				family: context.family,
				model: context.model,
				now: state.now(),
				tokenRefreshSkewMs: state.tokenRefreshSkewMs,
				tokenInvalidationCooldownMs: state.tokenInvalidationCooldownMs,
			});
			if (!refreshed.ok) {
				// No accountSkipReasons write here: ensureFreshAccessToken always
				// applies an auth cooldown before returning !ok, so the next
				// selection pass overwrites whatever this set with
				// cooling-down:auth-failure, the invalidated exit returns a 401
				// without reading the map at all, and the budget-boundary block
				// below already records "auth-failure" for a pin out of retries.
				exhaustionReason = "auth-failure";
				if (refreshed.invalidated) {
					// Refresh endpoint explicitly revoked the token. Stop cascade:
					// return auth error to client instead of rotating to the next account.
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					res.writeHead(HTTP_STATUS.UNAUTHORIZED, { "content-type": "application/json" });
					// Route through the shared builder so both invalidation exit paths stay
					// in lockstep — empty input yields { error: { message: <fallback>,
					// code: "token_invalidated" } }.
					res.end(buildTokenInvalidationBody(""));
					await usageRecorder.record({
						outcome: "failure",
						statusCode: HTTP_STATUS.UNAUTHORIZED,
						errorCode: "token_invalidated",
						account: selected,
					});
					return;
				}
				if (!refreshed.retryable) continue;
				transientAttempts += 1;
				transientExhaustionReason = "auth-failure";
				state.status.retries += 1;
				noteRotation();
				continue;
			}

			const accountId = resolveAccountId(refreshed.account, refreshed.accessToken);
			if (!accountId) {
				accountManager.recordFailure(refreshed.account, context.family, context.model);
				accountManager.markAccountCoolingDown(
					refreshed.account,
					DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
					"auth-failure",
				);
				// Persist the cooldown like every other cooldown branch in this loop
				// (network-error, 429, server-error, 401). `coolingDownUntil`/
				// `cooldownReason` are serialized in the V3 snapshot, so without this
				// a restart inside the cooldown window loses it and immediately
				// re-selects the still-broken account.
				accountManager.saveToDiskDebounced();
				exhaustionReason = "auth-failure";
				transientAttempts += 1;
				transientExhaustionReason = "auth-failure";
				state.status.retries += 1;
				noteRotation();
				continue;
			}

			const accountIdentity = accountIdentityFromAccount(refreshed.account, state.now());
			recordLastRuntimeAccount(state.status, accountIdentity);

			const outboundHeaders = createOutboundHeaders(
				context.headers,
				refreshed.account,
				refreshed.accessToken,
				accountId,
			);

			let upstream: Response;
			// Abort the in-flight upstream fetch when the client disconnects
			// before headers arrive. Image generation holds upstream capacity
			// for the full fetch timeout, so a caller that goes away right
			// after sending must not leave that work running. `forwardStreamingResponse`
			// already cancels the stream once headers are written; this covers
			// the pre-header window instead. `writableEnded` distinguishes a
			// premature close from the clean `res.end()` that ends every request.
			//
			// The listener is removed in `finally` once the fetch settles. Without
			// that, every retry above the 10-listener default threshold that reaches
			// this fetch leaks another one-shot `close` handler onto the same `res`,
			// emitting `MaxListenersExceededWarning` when `retryAllAccountsMaxRetries`
			// is high and the account pool is large.
			const fetchAbortController = new AbortController();
			const onClientClose = () => {
				if (!res.writableEnded) fetchAbortController.abort();
			};
			try {
				state.status.upstreamRequests += 1;
				res.once("close", onClientClose);
				const upstreamRequestInit: RequestInit = {
					method: context.method,
					headers: outboundHeaders,
					signal: fetchAbortController.signal,
				};
				if (context.method === "POST") {
					upstreamRequestInit.body = context.body;
				}
				const fetchTimeoutMs = isImageRequest
					? Math.max(state.fetchTimeoutMs, 300_000)
					: state.fetchTimeoutMs;
				upstream = await withTimeout(
					state.fetchImpl(upstreamUrl, upstreamRequestInit),
					fetchTimeoutMs,
					() => fetchAbortController.abort(),
					`upstream fetch timed out after ${fetchTimeoutMs}ms`,
				);
			} catch (error) {
				// errors-logging-08: a custom fetchImpl, a proxy agent, or an undici
				// cause chain can embed the request URL or credential material in the
				// raw message, so mask before it reaches any state.status consumer.
				const transportError = maskString(
					error instanceof Error ? error.message : String(error),
				);
				state.status.lastError = transportError;
				// errors-logging-01: give the failure a structured, trace-correlated
				// line instead of only a last-write-wins status string. Nothing else
				// on this path reaches proxyLog, because the request does not throw.
				proxyLog.error("upstream transport failure", {
					traceId,
					code: "codex_runtime_rotation_transport_error",
					error: transportError,
				});
				// A timeout may occur after generation; do not retry within this request.
				if (isImageRequest) {
					writeJson(res, 502, {
						error: {
							code: "image_upstream_transport_error",
							message: "Image upstream transport failed; not retried by the proxy.",
						},
					});
					await usageRecorder.record({
						outcome: "failure", statusCode: 502,
						errorCode: "image_upstream_transport_error", account: refreshed.account,
					});
					return;
				}
				// A pre-header transport exception is a property of the network path,
				// not of this account's credentials or quota, so it must NOT feed the
				// account's circuit breaker / health tracker: that is what would
				// otherwise retire a healthy account for an outage it did not cause.
				// See #677.
				//
				// The short timed cooldown IS still applied. It is self-healing, it
				// keeps an account whose upstream hangs from stalling 1/N of every
				// later request for the full fetch timeout, and it is what gives the
				// exhaustion 503 a non-zero `retry_after_ms` to back the client off
				// with (`getMinWaitTimeForFamily` returns 0 while any account is
				// still selectable).
				accountManager.markAccountCoolingDown(
					refreshed.account,
					state.networkErrorCooldownMs,
					"network-error",
				);
				accountManager.saveToDiskDebounced();
				accountSkipReasons.set(refreshed.account.index, "network-error");
				exhaustionReason = "network-error";
				transientAttempts += 1;
				transientExhaustionReason = "network-error";
				state.status.retries += 1;
				noteRotation();
				continue;
			} finally {
				res.off("close", onClientClose);
			}
			reconcileManualSelection();
			const quotaSnapshot = readQuotaSchedulerSnapshot(
				upstream.headers,
				upstream.status,
				state.now(),
			);
			if (quotaSnapshot) {
				state.preemptiveQuotaScheduler.update(quotaScheduleKey, quotaSnapshot);
			}

			if (upstream.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
				const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);
				// Keep the upstream HINT separate from the 60s fallback. Passing the
				// synthesized default into the capacity wait would make every
				// hint-less capacity 429 sleep a full minute and leave the 2s/5s/15s
				// backoff table dead on this path.
				const retryAfterHintMs =
					parseRetryAfterHeaderMs(upstream.headers, state.now()) ??
					parseRetryAfterBodyMs(bodyText, state.now());
				const retryAfterMs = retryAfterHintMs ?? 60_000;
				// Reading the body awaited I/O; a switch may have landed meanwhile.
				reconcileManualSelection();
				// A capacity 429 is not this account's quota. Marking it rate
				// limited would take a healthy account out of the pool for the
				// retry-after window on an outage that affects every account.
				if (isModelAtCapacityError(upstream.status, bodyText)) {
					const outcome = await waitOutModelCapacity(
						retryAfterHintMs,
						refreshed.account,
					);
					if (outcome === "client-gone") {
						await usageRecorder.record({
							outcome: "failure",
							statusCode: upstream.status,
							errorCode: "client_disconnected_during_capacity_wait",
							account: refreshed.account,
						});
						return;
					}
					if (outcome === "retry") continue;
				}
				state.preemptiveQuotaScheduler.markRateLimited(
					quotaScheduleKey,
					retryAfterMs,
					state.now(),
				);
				// A 429 is the upstream quota signal for the attempted account, so
				// keep the consumed runtime token drained.
				accountManager.recordRateLimit(refreshed.account, context.family, context.model);
				accountManager.markRateLimitedWithReason(
					refreshed.account,
					retryAfterMs,
					context.family,
					"quota",
					context.model,
				);
				accountManager.saveToDiskDebounced();
				exhaustionReason = "rate-limit";
				transientAttempts += 1;
				transientExhaustionReason = "rate-limit";
				state.status.retries += 1;
				noteRotation();
				continue;
			}

			if (upstream.status === 402 || upstream.status === HTTP_STATUS.FORBIDDEN) {
				const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);
				const errorCode = extractErrorCodeFromBody(bodyText);
				if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {
					const accountWasEnabled =
						accountManager.getAccountByIndex(refreshed.account.index)?.enabled !==
						false;
					if (accountWasEnabled) {
						accountManager.recordFailure(
							refreshed.account,
							context.family,
							context.model,
						);
						accountManager.setAccountEnabled(refreshed.account.index, false);
						accountManager.saveToDiskDebounced();
					}
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					exhaustionReason = "deactivated";
					state.status.retries += 1;
					noteRotation();
					continue;
				}

				if (isThreadGoalRequest && isThreadGoalFallbackStatus(upstream.status)) {
					const parsedGoalBody = parseRequestBody(context.body);
					const fallbackKey = context.sessionKey;
					const goal =
						typeof parsedGoalBody?.goal === "string" ? parsedGoalBody.goal : null;
					if (!fallbackKey) {
						if (context.upstreamPath.endsWith("/get")) {
							writeJson(res, HTTP_STATUS.OK, { goal: null });
							await usageRecorder.record({
								outcome: "failure",
								statusCode: upstream.status,
								errorCode: "thread_goal_session_key_required",
								account: refreshed.account,
							});
							return;
						}
						await usageRecorder.record({
							outcome: "failure",
							statusCode: HTTP_STATUS.BAD_REQUEST,
							errorCode: "thread_goal_session_key_required",
							account: refreshed.account,
						});
						writeJson(res, HTTP_STATUS.BAD_REQUEST, {
							error: {
								message:
									"Thread goal fallback requires a thread_id, threadId, or session header.",
								code: "thread_goal_session_key_required",
							},
						});
						return;
					}
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode: "thread_goal_upstream_blocked",
						account: refreshed.account,
					});
					if (context.upstreamPath.endsWith("/set")) {
						setThreadGoalFallback(state.threadGoalFallbacks, fallbackKey, goal);
						writeJson(res, HTTP_STATUS.OK, { ok: true, goal });
						return;
					}
					writeJson(res, HTTP_STATUS.OK, {
						goal: getThreadGoalFallback(state.threadGoalFallbacks, fallbackKey),
					});
					return;
				}

				if (isThreadGoalRequest && context.upstreamPath.endsWith("/get")) {
					writeJson(res, HTTP_STATUS.OK, { goal: null });
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode,
						account: refreshed.account,
					});
					return;
				}
				res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));
				res.end(bodyText);
				await usageRecorder.record({
					outcome: "failure",
					statusCode: upstream.status,
					errorCode,
					account: refreshed.account,
				});
				return;
			}

			if (upstream.status === HTTP_STATUS.UNAUTHORIZED) {
				const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);
				accountManager.recordFailure(refreshed.account, context.family, context.model);
				if (isTokenInvalidationError(bodyText)) {
					// The upstream explicitly revoked this OAuth token. Applying a long
					// cooldown prevents cascade invalidation: rapidly presenting each
					// account's token from the same IP triggers OpenAI's anti-abuse
					// detection and invalidates them in sequence. Return the 401 directly
					// rather than rotating so the client can prompt for re-login.
					accountManager.markAuthInvalidated(
						refreshed.account,
						extractErrorCodeFromBody(bodyText) ?? "token_invalidated",
					);
					applyMonotonicAuthCooldown(
						accountManager,
						refreshed.account,
						state.tokenInvalidationCooldownMs,
					);
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					// The invalidation marker must be durable before returning the 401.
					// A delayed save would allow a proxy restart to reload and route the
					// revoked account again.
					await accountManager.saveToDisk();
					// Emit the same machine-readable shape as the refresh-failure path
					// (code: "token_invalidated") instead of forwarding the raw upstream
					// body, so the client contract is consistent across both vectors.
					const clientHeaders = responseHeadersForClient(upstream.headers);
					clientHeaders["content-type"] = "application/json";
					res.writeHead(upstream.status, clientHeaders);
					res.end(buildTokenInvalidationBody(bodyText));
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode: "token_invalidated",
						account: refreshed.account,
					});
					return;
				}
				applyMonotonicAuthCooldown(
					accountManager,
					refreshed.account,
					DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
				);
				accountManager.saveToDiskDebounced();
				exhaustionReason = "auth-failure";
				transientAttempts += 1;
				transientExhaustionReason = "auth-failure";
				state.status.retries += 1;
				noteRotation();
				continue;
			}

			// Forward image validation/moderation/5xx errors without cross-account replay.
			// Explicit 429 quota and 401 auth handling above still use the existing pool.
			if (isImageRequest && upstream.status >= 400) {
				const forwarded = await forwardStreamingResponse(
					upstream, res, state.status, () => undefined, state.streamStallTimeoutMs,
				);
				await usageRecorder.record({
					outcome: "failure", statusCode: upstream.status,
					errorCode: forwarded ? "image_upstream_error" : "stream_forward_failed",
					account: refreshed.account,
				});
				return;
			}
			if (upstream.status >= 500) {
				const bodyText = await readErrorBody(
					upstream,
					state.streamStallTimeoutMs,
				);
				// A capacity 5xx is upstream load, not a broken account, so it
				// must not cool the account down or count against the pool.
				if (isModelAtCapacityError(upstream.status, bodyText)) {
					const outcome = await waitOutModelCapacity(
						parseRetryAfterHeaderMs(upstream.headers, state.now()),
						refreshed.account,
					);
					if (outcome === "client-gone") {
						await usageRecorder.record({
							outcome: "failure",
							statusCode: upstream.status,
							errorCode: "client_disconnected_during_capacity_wait",
							account: refreshed.account,
						});
						return;
					}
					if (outcome === "retry") continue;
				}
				accountManager.recordFailure(refreshed.account, context.family, context.model);
				accountManager.markAccountCoolingDown(
					refreshed.account,
					state.serverErrorCooldownMs,
					"server-error",
				);
				accountManager.saveToDiskDebounced();
				exhaustionReason = "server-error";
				transientAttempts += 1;
				transientExhaustionReason = "server-error";
				state.status.retries += 1;
				noteRotation();
				continue;
			}

			if (isThreadGoalRequest && upstream.status >= 400) {
				if (context.upstreamPath.endsWith("/get")) {
					writeJson(res, HTTP_STATUS.OK, { goal: null });
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode: "thread_goal_upstream_error",
						account: refreshed.account,
					});
					return;
				}
				const forwarded = await forwardStreamingResponse(
					upstream,
					res,
					state.status,
					() => undefined,
					state.streamStallTimeoutMs,
				);
				await usageRecorder.record({
					outcome: "failure",
					statusCode: upstream.status,
					errorCode: forwarded ? "thread_goal_upstream_error" : "stream_forward_failed",
					account: refreshed.account,
				});
				return;
			}

			accountManager.recordSuccess(refreshed.account, context.family, context.model);
			// A successful request proves the account is usable, so clear any
			// stale runtime skip reason persisted for it on a prior pool
			// exhaustion. Without this the overlay reason (e.g. "token-exhausted",
			// "rate-limited") lingers on disk until an explicit runtime reset and
			// the forecast keeps reporting this working account as unavailable.
			// No-op when no reason is recorded, so the hot path stays write-free.
			recordRuntimeAccountRecovery(refreshed.account.index);
			const quotaDeferral = state.preemptiveQuotaScheduler.getDeferral(
				quotaScheduleKey,
				state.now(),
			);
			const nearExhaustionWaitMs = quotaDeferral.defer
				? quotaDeferral.waitMs
				: 0;
			if (nearExhaustionWaitMs > 0) {
				accountManager.markRateLimitedWithReason(
					refreshed.account,
					nearExhaustionWaitMs,
					context.family,
					"quota",
					context.model,
				);
				state.sessionAffinityStore?.forgetSession(context.sessionKey);
				accountManager.saveToDiskDebounced();
			} else {
				state.sessionAffinityStore?.remember(
					context.sessionKey,
					refreshed.account.index,
					state.now(),
				);
				if (refreshed.account.index !== state.lastGlobalAccountIndex) {
					state.lastGlobalAccountIndex = refreshed.account.index;
				}
				state.lastGlobalSwitchAt = state.now();
			}
			await persistRuntimeActiveAccount(
				accountManager,
				refreshed.account,
				context.family,
				isPinned && refreshed.account.index === pinnedIndex,
				state.schedulingStrategy,
			);

			// Recover the upstream token counts as the body streams past. Without
			// them every ledger row lands with all-zero tokens and a zero cost, so
			// evaluateBudgetGuard compares `0 >= limit` for maxTokens/maxCostUsd
			// and those caps never fire — `budget set --cost 50` would allow
			// unlimited spend, with only --requests actually enforced.
			const usageScanner = createUsageStreamScanner({
				contentType: upstream.headers.get("content-type"),
			});
			const forwarded = await forwardStreamingResponse(
				upstream,
				res,
				state.status,
				() => {
					// Deliberately NOT the pre-header transport policy above,
					// which skips recordFailure (#677). By this point the
					// upstream accepted the request and began responding, so a
					// broken stream is a signal about THIS account's session
					// (upstream tearing it down) rather than about the shared
					// network path, and it should still credit the breaker.
					accountManager.recordFailure(
						refreshed.account,
						context.family,
						context.model,
					);
					accountManager.markAccountCoolingDown(
						refreshed.account,
						state.networkErrorCooldownMs,
						"network-error",
					);
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					accountManager.saveToDiskDebounced();
				},
				state.streamStallTimeoutMs,
				usageScanner.push,
				budgetAdvisory.level === "soft"
					? buildContextBudgetHeaders(budgetAdvisory)
					: undefined,
			);
			// A stream that broke mid-flight still bills for whatever the upstream
			// reported before the break, so record the counts on both outcomes.
			const usageTokens = usageScanner.result();
			// Responses is mostly stateless (store=false): each successful turn's
			// input_tokens reflects the full conversation resent this call, so it
			// doubles as a live read of the session's current context size. Record
			// it even on a broken stream, matching the ledger's own choice above —
			// the tokens upstream billed for were still resent as full context.
			//
			// input + output, NOT total: `usageTokens.totalTokens` is the
			// provider's `total_tokens`, which also counts `reasoning_tokens`.
			// Reasoning is not carried into the next turn's input, so counting
			// it here inflates the measurement by this turn's thinking budget
			// against a deliberately tight threshold. `outputTokens` is already
			// reasoning-stripped (lib/usage/usage-extraction.ts).
			if (usageTokens && context.stableSessionKey && context.model) {
				state.contextBudgetGuard.update(context.stableSessionKey, {
					model: context.model,
					contextTokens: usageTokens.inputTokens + usageTokens.outputTokens,
					updatedAt: state.now(),
				});
			}
			await usageRecorder.record({
				outcome: forwarded ? "success" : "failure",
				statusCode: upstream.status,
				errorCode: forwarded ? null : "stream_forward_failed",
				account: refreshed.account,
				...(usageTokens ?? {}),
			});
			return;
		}

		if (
			isPinned &&
			typeof pinnedIndex === "number" &&
			transientAttempts >= transientAttemptLimit
		) {
			const pinnedAccount = accountManager.getAccountByIndex(pinnedIndex);
			const liveReason = pinnedAccount
				? accountManager.getManagedAccountRuntimeSkipReason(
						pinnedAccount,
						context.family,
						context.model,
					)
				: "missing";
			const finalAttemptReason =
				transientExhaustionReason === "rate-limit"
					? "rate-limited"
					: transientExhaustionReason;
			const finalPinnedReason = liveReason ?? finalAttemptReason;
			if (finalPinnedReason !== null) {
				accountSkipReasons.set(pinnedIndex, finalPinnedReason);
			}
		}

		if (
			transientAttempts >= transientAttemptLimit &&
			(isPinned || attemptedIndexes.size < accountCount)
		) {
			exhaustionReason = "budget";
		} else if (
			exhaustionReason === "deactivated" &&
			transientExhaustionReason
		) {
			exhaustionReason = transientExhaustionReason;
		}

		// When a manual pin is set and the pinned account is unavailable, do
		// NOT silently fall through to rotation. Hard-fail with a 503 so the
		// user is informed the pin cannot be honored. See issue #474.
		//
		// Surface the runtime skip reason in both the human-readable message
		// and a structured `reason` field, mirroring `writePoolExhausted`. A
		// null reason indicates a forecast/runtime state desync (the pinned
		// account was selected but no skip reason was recorded) — see #486.
		if (isPinned) {
			const pinnedAccount =
				typeof pinnedIndex === "number"
					? accountManager.getAccountByIndex(pinnedIndex)
					: null;
			const pinnedSkipReason =
				typeof pinnedIndex === "number"
					? accountSkipReasons.get(pinnedIndex) ?? null
					: null;
			// A permanent blocker (disabled, no enabled workspace, invalidated
			// auth, policy block, out-of-range pin) outlives every timed record,
			// so advertising a record's expiry would invite a retry into another
			// 503.
			//
			// The recorded reason alone is not enough to detect every concurrent
			// state change: it is the most recent selection/attempt verdict, while
			// this request or another one can make the pin permanently unselectable
			// after that verdict was recorded. Re-read the pin's CURRENT runtime
			// state so a permanent blocker cannot hide behind an earlier transient
			// failure; the recorded reason still covers selection-only verdicts
			// ("missing", "policy-blocked") that state cannot express.
			const pinnedCurrentSkipReason =
				pinnedAccount === null
					? null
					: accountManager.getManagedAccountRuntimeSkipReason(
							pinnedAccount,
							context.family,
							context.model,
						);
			const pinnedBlockedPermanently =
				(pinnedSkipReason !== null &&
					PINNED_PERMANENT_SKIP_REASONS.has(pinnedSkipReason)) ||
				(pinnedCurrentSkipReason !== null &&
					PINNED_PERMANENT_SKIP_REASONS.has(pinnedCurrentSkipReason));
			// Otherwise recovery comes from the pinned account's persisted state,
			// not merely the recorded skip token. With several overlapping records
			// the account stays skipped until the LAST one expires, so the latest
			// bound is the one worth advertising.
			//
			// One clock for the whole body. The recovery bound and the
			// rate-limit bound are compared against each other below, so
			// reading state.now() per lookup would let a record expire between
			// them and report a rate-limited pin as bounded by something else.
			const evaluatedAtMs = state.now();
			// Both bounds come from a single pass over the account's records.
			const pinnedRecoveryBounds =
				pinnedAccount === null
					? null
					: getAccountRecoveryBoundsForFamily(
							pinnedAccount,
							evaluatedAtMs,
							context.family,
							context.model,
						);
			const pinnedStateRecoveryAtMs =
				pinnedRecoveryBounds?.recoveryAtMs ?? null;
			// An open circuit outlives the short failure cooldowns that tripped
			// it; its deadline lives in the breaker, not the account record.
			const pinnedCircuitRecoveryAtMs =
				pinnedAccount === null
					? null
					: accountManager.getCircuitRecoveryTime(pinnedAccount, evaluatedAtMs);
			const pinnedResetAtMs =
				pinnedBlockedPermanently ||
				(pinnedStateRecoveryAtMs === null && pinnedCircuitRecoveryAtMs === null)
					? null
					: Math.max(
							pinnedStateRecoveryAtMs ?? 0,
							pinnedCircuitRecoveryAtMs ?? 0,
						);
			// The message only words the recovery deadline as a rate-limit reset
			// when the rate-limit records are in fact what supplies it — a
			// breaker or cooldown can end later and then bounds it instead.
			const pinnedRateLimitResetAtMs =
				pinnedRecoveryBounds?.rateLimitAtMs ?? null;
			const recoveryBound =
				pinnedResetAtMs !== null &&
				pinnedRateLimitResetAtMs !== null &&
				pinnedRateLimitResetAtMs >= pinnedResetAtMs
					? "rate-limit"
					: "other";
			const errorBody = buildPinnedUnavailableErrorBody(
				pinnedIndex,
				accountSkipReasons,
				{
					// typeof check so a forced index of 0 still reads as forced.
					pinSource:
						typeof state.forcedAccountIndex === "number" ? "forced" : "manual",
					resetAtMs: pinnedResetAtMs,
					recoveryBound,
					// Re-read runtime state for the operator-facing sentence so a
					// concurrent or later blocker can refine the recorded verdict.
					currentSkipReason: pinnedCurrentSkipReason,
					now: evaluatedAtMs,
				},
			);
			if (errorBody.reason === null) {
				state.status.lastError = `pinned-503 missing skip reason (pinnedIndex=${pinnedIndex})`;
			}
			await usageRecorder?.record({
				outcome: "failure",
				statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
				errorCode: "codex_pinned_account_unavailable",
			});
			writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, { error: errorBody });
			return;
		}

		await usageRecorder?.record({
			outcome: "failure",
			statusCode: normalizeExhaustionStatus(exhaustionReason),
			errorCode: isThreadGoalRequest && context.upstreamPath.endsWith("/get") ? "thread_goal_pool_exhausted" : exhaustionReason,
		});
		if (isThreadGoalRequest && context.upstreamPath.endsWith("/get")) {
			writeJson(res, HTTP_STATUS.OK, { goal: null });
		} else {
			writePoolExhausted({
				res,
				accountManager,
				family: context.family,
				model: context.model,
				reason: exhaustionReason,
				accountSkipReasons: Object.fromEntries(
					[...accountSkipReasons.entries()].map(([index, reason]) => [
						String(index),
						reason,
					]),
				),
			});
		}
	} catch (error) {
		const rawErrorMessage = error instanceof Error ? error.message : String(error);
		// errors-logging-08: redact any email/token material that leaked into a
		// raw upstream or refresh error string before it reaches state.status consumers
		// or the structured log. maskString is a no-op for clean diagnostic text.
		const maskedErrorMessage = maskString(rawErrorMessage);
		state.status.lastError = maskedErrorMessage;
		// errors-logging-01: surface the failure through the structured logger
		// (redaction-safe) with the request trace id, instead of only stashing a
		// last-write-wins status string.
		proxyLog.error("runtime proxy request failed", {
			traceId,
			code: isRuntimeProxyHttpError(error) ? error.code : "codex_runtime_rotation_proxy_error",
			error: maskedErrorMessage,
		});
		if (!res.headersSent) {
			if (isRuntimeProxyHttpError(error)) {
				await usageRecorder?.record({
					outcome: "failure",
					statusCode: error.statusCode,
					errorCode: error.code,
				});
				writeJson(res, error.statusCode, {
					error: {
						message: error.message,
						code: error.code,
					},
				});
				return;
			}
			await usageRecorder?.record({
				outcome: "failure",
				statusCode: 500,
				errorCode: "codex_runtime_rotation_proxy_error",
			});
			writeJson(res, 500, {
				error: {
					message: "Runtime rotation proxy failed before forwarding the request.",
					code: "codex_runtime_rotation_proxy_error",
				},
			});
		} else if (!res.destroyed) {
			res.destroy(error instanceof Error ? error : undefined);
		}
	}
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	if (!server.listening) return;
	const closed = new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
	server.closeIdleConnections?.();
	for (const socket of sockets) {
		socket.destroy();
	}
	await closed;
}
