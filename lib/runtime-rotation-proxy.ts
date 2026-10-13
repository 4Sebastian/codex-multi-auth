import { startAutomaticAccountChecks } from "./runtime/automatic-account-checks.js";
import { createAutomaticSubscriptionCheck } from "./runtime/automatic-subscription-checks.js";
import { ClientCancellationError } from "./request/client-cancellation.js";
import { getCircuitBreaker, type CircuitAdmissionReceipt } from "./circuit-breaker.js";
import { createNativeAccountStorageReader } from "./runtime/native-account-storage.js";
import { captureAuthorityRevision } from "./storage/authority-revision.js";
import { getIntentionalResetMarkerPath } from "./storage/backup-paths.js";
import { PendingAuthObservationError, getPendingAuthPath } from "./storage/pending-auth.js";
import { resetSnapshotQuota } from "./runtime/reset-credits.js";
import { createResetCreditService, loadResetCreditState } from "./runtime/account-reset-credits.js";
import { recoverResetQuota, applyConfirmedReset } from "./runtime/reset-credit-routing.js";
import { readSubscriptionQuotaEvent } from "./runtime/subscription-quota-event.js";
import { loadQuotaCache } from "./quota-cache.js";
import { findQuotaCacheEntryForAccount } from "./quota-readiness.js";
import { subscriptionQuotaPreference, compareSubscriptionQuota, type SubscriptionQuotaPreference } from "./runtime/subscription-quota-order.js";
import { inferenceAccountKey } from "./runtime/inference-activity.js";
import { modelScopeId, workspaceModelScopes } from "./runtime/workspace-model-scopes.js";
import { RuntimeCapabilityFailures, classifyCapabilityFailure } from "./runtime/runtime-capability-failures.js";
import { ResponseOutcome } from "./request/response-outcome.js";
import { ResponsesWebSocketGateway, type DispatchAuthorization } from "./runtime/responses-websocket.js";
import { ApiModelCapabilities } from "./runtime/api-model-capabilities.js";
import { saveModelInventory } from "./runtime/model-discovery-status.js";
import { loadApiRoutes, updateApiModelDiscovery, getApiRoutesPath, type ApiRouteCredential } from "./api-route-store.js";
import { ApiModelRuntime } from "./runtime/api-model-runtime.js";
import { buildVisibleModelUnion, parseModelRoute, canonicalServiceTier, isRouteModelEligible, type RouteModel } from "./model-route-policy.js";
import { isSameNativeAccount, syncNativeAccountCredentials } from "./runtime/native-account-sync.js";
import { resolveAccountRecordId } from "./storage/record-identity.js";
import { isNativeClientToken } from "./runtime/native-client-auth.js";
import { CatalogRetryError, AccountModelCatalog, clampCatalogRetryMs } from "./runtime/account-model-catalog.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import * as zlib from "node:zlib";
import {
	AccountManager,
	AUTH_INVALIDATION_MARKER,
	extractAccountId,
	type ManagedAccount,
	type CurrentAccountCredential,
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
	recordRuntimeInferenceRequest,
	flushRuntimeInferenceActivity,
	mutateRuntimeObservabilitySnapshot,
	recordRuntimeAccountRecovery,
	recordRuntimePoolExhaustion,
} from "./runtime/runtime-observability.js";
import {
	createRuntimeUsageRecorder,
	evaluateRuntimePolicy,
	loadRuntimePolicyState,
	captureRuntimePolicyRevision,
	type RuntimePolicyDecision,
	type RuntimeUsageRecorder,
} from "./policy/runtime-policy.js";
import {
	createUsageStreamScanner,
	extractResponsesUsage,
} from "./usage/usage-extraction.js";
import {
	isModelAtCapacityError,
	isWorkspaceDisabledError,
} from "./request/fetch-helpers.js";
import {
	PreemptiveQuotaScheduler,
	mergeQuotaReceipts,
	readQuotaSchedulerSnapshot,
	type QuotaObservationReceipt,
	type QuotaSchedulerSnapshot,
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
	isResponsesTokenInvalidationEvent,
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
export { resetRuntimePolicyCacheForTests } from "./policy/runtime-policy-cache.js";

const DEFAULT_HOST = "127.0.0.1";

// Persistent WebSocket connections outlive individual requests. Hybrid
// selection can therefore leave different sockets bound to different OAuth
// accounts and interleave those tokens from one IP indefinitely, bypassing the
// normal minimum-rotation window and triggering upstream anti-abuse revocation.
// Drain-first selection gives every new WebSocket the same active account and
// only advances after that account becomes unavailable.
const WEBSOCKET_SCHEDULING_STRATEGY = "sequential" as const;

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

/**
 * True only for a NUMERIC loopback literal, as `new URL().hostname` reports it.
 *
 * Duplicates the wrapper's predicate (scripts/codex.js) at library level — a
 * hostname like "localhost" is deliberately NOT enough: it is resolved by the
 * OS at connect time, so an /etc/hosts or Windows hosts entry can point it at
 * a routable address, and the upstream request carries the managed OAuth
 * bearer token and the request body. WHATWG URL always reports an IPv6 host in
 * its bracketed form, so `::1` is only ever seen here as `[::1]`.
 */
function isNumericLoopbackUrlHostname(hostname: string): boolean {
	if (hostname === "[::1]") {
		return true;
	}
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (!ipv4) {
		return false;
	}
	const octets = ipv4.slice(1).map((part) => Number(part));
	if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
		return false;
	}
	// The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
	return octets[0] === 127;
}

/**
 * Whether the raw URL text carries an explicit `:port` (mirrors the wrapper).
 *
 * `new URL()` erases a port that matches the scheme default, so
 * `http://127.0.0.1:80/x` reports `parsed.port === ""` and a `!parsed.port`
 * check would reject a perfectly valid, explicitly-ported loopback URL.
 */
function urlHasExplicitPort(raw: string): boolean {
	const withoutScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
	const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
	// Strip userinfo first, or a password containing ':' reads as a port.
	const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
	if (hostAndPort.startsWith("[")) {
		const close = hostAndPort.indexOf("]");
		return close !== -1 && /^:\d+$/.test(hostAndPort.slice(close + 1));
	}
	const colon = hostAndPort.indexOf(":");
	return colon !== -1 && /^:\d+$/.test(hostAndPort.slice(colon));
}

/**
 * Library-boundary enforcement for the upstream the proxy forwards managed
 * OAuth Bearer tokens to (runtime-proxy trust boundary).
 *
 * `options.upstreamBaseUrl` is a library input: callers are not all the
 * wrapper, so the env-var validation in scripts/codex.js does not protect this
 * boundary. A non-https or non-loopback value would exfiltrate account tokens
 * to whatever host it names. The policy mirrors the wrapper exactly: https is
 * always allowed, while http is accepted only for the documented dev path — a
 * NUMERIC loopback host (127.0.0.0/8 or [::1], never a name) with an explicit
 * port — and no URL may carry credentials, a query, or a fragment.
 */
function assertAllowedUpstreamBaseUrl(raw: string): void {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new CodexValidationError(
			`Runtime rotation proxy upstreamBaseUrl is not a valid absolute URL.`,
			{ field: "upstreamBaseUrl", expected: "an https URL, or an http URL on a numeric loopback host with an explicit port" },
		);
	}

	const isDevLoopback =
		parsed.protocol === "http:" &&
		isNumericLoopbackUrlHostname(parsed.hostname.toLowerCase()) &&
		Boolean(parsed.port || urlHasExplicitPort(raw));
	if (
		(parsed.protocol !== "https:" && !isDevLoopback) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new CodexValidationError(
			`Runtime rotation proxy refuses upstreamBaseUrl "${raw}". ` +
				"It forwards managed OAuth tokens: use https, or http only on a " +
				"numeric loopback host (127.0.0.0/8 or [::1]; a name such as " +
				'"localhost" can resolve off-host) with an explicit port, and no ' +
				"credentials, query, or fragment.",
			{
				field: "upstreamBaseUrl",
				expected: "an https URL, or an http URL on a numeric loopback host with an explicit port",
				context: { upstreamBaseUrl: raw },
			},
		);
	}
}

/**
 * Whether a fetch rejection is undici refusing to follow a redirect.
 *
 * The upstream fetch runs `redirect: "error"` so a 3xx can never re-send the
 * managed Bearer token to an arbitrary host. Instead of a Response, fetch
 * rejects with `TypeError("fetch failed")` whose `cause` is the network error
 * `unexpected redirect` (see undici's httpNetworkOrCacheFetch). Check the cause
 * level and the bare message so a custom fetchImpl delivering the same network
 * error unwrapped classifies identically.
 */
function isRedirectRejection(error: unknown): boolean {
	return [error, (error as { cause?: unknown } | null)?.cause].some(
		(candidate) =>
			candidate instanceof Error && candidate.message === "unexpected redirect",
	);
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

function getApiModelRuntime(state:RotationProxyState):ApiModelRuntime {
 if(state.apiModelRuntime)return state.apiModelRuntime;
 const capabilities=state.apiModelCapabilities??=new ApiModelCapabilities();
 const production=state.readApiRoutes===loadApiRoutes;
 state.apiModelRuntime=new ApiModelRuntime(state.fetchImpl,state.now,production?updateApiModelDiscovery:undefined,production?(models,refresh,route,force)=>capabilities.enrich(models,refresh,route,force):undefined,()=>{
  const runtime=state.apiModelRuntime;
  if(!runtime)return;
  const models=[...(state.catalogOAuthModels??[]),...buildVisibleModelUnion(runtime.cachedCatalogs())];
  setCatalogEtag(state,models);
  if(state.catalogInventory){
   state.catalogInventory={...state.catalogInventory,checkedAt:state.now(),entries:[
    ...state.catalogInventory.entries.filter(entry=>entry.kind==="oauth"),
    ...runtime.statuses(state.catalogApiRoutes??[]).map(entry=>({id:modelScopeId(entry.kind,entry.id),label:entry.label,kind:entry.kind,enabled:runtime.cachedCatalogs().some(c=>c.id===entry.id&&c.enabled),checkedAt:entry.checkedAt,error:entry.error,models:entry.availableModels,visibleModels:entry.visibleModels,entitlements:entry.entitlements})),
   ]};
   void saveModelInventory(state.catalogInventory).catch(()=>{state.status.lastError="Model discovery status could not be saved";});
  }
 });
 return state.apiModelRuntime;
}
function setCatalogEtag(state:RotationProxyState,models:RouteModel[]):string {
 return state.catalogEtag='"'+createHash("sha256").update(JSON.stringify(models)).digest("hex")+'"';
}


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

/** Files every native Responses request reads change rarely; share one read per second. */
const PER_REQUEST_READ_TTL_MS = 1000;
function cachedRead<T>(state: RotationProxyState, key: string, load: () => Promise<T>): Promise<T> {
	const cache = state.readCache ??= new Map();
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && hit.at <= now && now - hit.at < PER_REQUEST_READ_TTL_MS) return hit.value as Promise<T>;
	const value = load();
	cache.set(key, { at: now, value });
	value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
	return value;
}

function catalogAccountKey(account: ManagedAccount): string {
	return workspaceModelScopes(account).find(scope=>scope.bound)?.id ?? "unavailable";
}

function capabilityFailureKey(scope: string, credential: Pick<AccountDispatchBinding, "accessToken" | "refreshToken" | "expiresAt">): string {
	return createHash("sha256").update(JSON.stringify([scope, credential.accessToken, credential.refreshToken, credential.expiresAt])).digest("hex");
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
	requestedWorkspaceId: string,
): void {
	status.lastAccountIndex = identity.index;
	status.lastAccountLabel = identity.label;
	status.lastAccountId = identity.accountId;
	status.lastRequestedWorkspaceId = requestedWorkspaceId;
	status.lastAccountUpdatedAt = identity.updatedAt;
	mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.lastAccountIndex = identity.index;
		snapshot.lastAccountLabel = identity.label;
		snapshot.lastAccountEmail = null;
		snapshot.lastAccountId = identity.accountId;
		snapshot.lastRequestedWorkspaceId = requestedWorkspaceId;
		snapshot.lastAccountUpdatedAt = identity.updatedAt;
	});
}

async function persistRuntimeActiveAccount(
	accountManager: AccountManager,
	account: ManagedAccount,
	family: ModelFamily,
	isPinned: boolean,
	schedulingStrategy: string,
	preserveDesktopLogin = false,
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
		if (!preserveDesktopLogin) await accountManager.syncCodexCliActiveSelectionForIndex(account.index);
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

/** Inspect the decoded entity before any credential or policy decision. */
async function decodeRequestBody(body: Buffer, encoding: string | null, maxBytes: number): Promise<Buffer> {
	const coding = encoding?.trim().toLowerCase() ?? "identity";
	if (!coding || coding === "identity") return body;
	// Older supported Node releases lack Zstandard. Reject explicitly there;
	// forwarding opaque bytes would bypass the model/credential boundary.
	const zstd = (zlib as typeof zlib & { zstdDecompress?: typeof zlib.gunzip }).zstdDecompress;
	const decode: ((input: Buffer, options: { maxOutputLength: number }, callback: (error: Error | null, output: Buffer) => void) => void) | undefined = coding === "gzip" ? zlib.gunzip
		: coding === "deflate" ? zlib.inflate
		: coding === "br" ? zlib.brotliDecompress
		: coding === "zstd" ? zstd : undefined;
	if (!decode) throw createRuntimeProxyHttpError(
		"Unsupported request content encoding. Zstandard requires a Node runtime with Zstandard support.",
		415, "unsupported_content_encoding",
	);
	return new Promise((resolve, reject) => {
		decode(body, { maxOutputLength: maxBytes }, (error, decoded) => {
			if (error) {
				const tooLarge = "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
				reject(createRuntimeProxyHttpError(
					tooLarge ? "Decoded request body is too large." : "Invalid compressed request body.",
					tooLarge ? 413 : 400,
					tooLarge ? "runtime_rotation_proxy_payload_too_large" : "invalid_request_body",
				));
			} else resolve(decoded);
		});
	});
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
		// A model-less request buckets under the model a codex request runs on.
		// With every codex model retired that is `gpt-5.6-sol`, whose family is
		// gpt-5.2, the same family as DEFAULT_MODEL.
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
const INITIAL_WEBSOCKET_RECOVERY_DELAY_MS = 100;
const MAX_WEBSOCKET_RECOVERY_DELAY_MS = 60_000;
const WEBSOCKET_CLOSE_POLICY_VIOLATION = 1008;
const WEBSOCKET_CLOSE_TRY_AGAIN_LATER = 1013;
const MAX_WEBSOCKET_HANDSHAKE_ERROR_BODY_BYTES = 64 * 1024;
const MAX_QUEUED_WEBSOCKET_FRAMES = 16;
const WEBSOCKET_AUTH_FAILURE_CODES: ReadonlySet<string> = new Set([
	"authentication_error",
	"invalid_api_key",
	"invalid_authentication",
	"unauthorized",
]);

interface PendingWebSocketFrame {
	order: number;
	data: RawData;
	isBinary: boolean;
	recoveryAttempts?: number;
	upstreamConnection?: WebSocket;
	usageRecorder?: RuntimeUsageRecorder;
	request?: PreparedWebSocketRequest;
	submittedAccount?: ManagedAccount;
}

function hasConnectionScopedContinuation(frame: PendingWebSocketFrame): boolean {
	const body = parseRequestBody(rawDataToBuffer(frame.data));
	return readStringRecordValue(body ?? {}, "previous_response_id") !== null;
}

interface AccountDispatchBinding extends CurrentAccountCredential {
	accountManager: AccountManager;
	account: ManagedAccount;
	accessToken: string;
	accountId: string;
}

function captureDispatchBinding(accountManager: AccountManager, account: ManagedAccount, accessToken: string, accountId: string): AccountDispatchBinding {
	return {accountManager, account, recordId: account.recordId, refreshToken: account.refreshToken, accessToken, expiresAt: account.expires, accountId};
}

function quotaReceiptOwner(binding: CurrentAccountCredential): string {
	return modelScopeId(binding.recordId ?? "", binding.accessToken ?? "", binding.refreshToken, String(binding.expiresAt), binding.accountId ?? "");
}

function isDispatchBindingCurrent(state: RotationProxyState, binding: AccountDispatchBinding): boolean {
	const {accountManager, account} = binding;
	return state.activeAccountManager === accountManager && accountManager.getAccountByIndex(account.index) === account &&
		account.recordId === binding.recordId && account.access === binding.accessToken && account.refreshToken === binding.refreshToken &&
		account.expires === binding.expiresAt && workspaceModelScopes(account).some(scope => scope.accountId === binding.accountId && scope.routable);
}

async function applyDispatchRestriction(state: RotationProxyState, binding: AccountDispatchBinding, mutate: () => void): Promise<boolean> {
	return binding.accountManager.withCurrentAccountCredential(binding.account, binding, () => {
		if (state.activeAccountManager !== binding.accountManager ||
			!workspaceModelScopes(binding.account).some(scope => scope.accountId === binding.accountId && scope.routable)) return false;
		mutate();
		return true;
	});
}

interface PreparedWebSocketAccount extends AccountDispatchBinding {
	circuitAdmission: CircuitAdmissionReceipt;
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

interface ActiveWebSocketRequest extends AccountDispatchBinding {
	circuitAdmission: CircuitAdmissionReceipt;
	request: PreparedWebSocketRequest;
}

interface WebSocketTerminalEvent {
	record: Parameters<RuntimeUsageRecorder["record"]>[0];
	rawBody: string;
	errorMessage: string | null;
	tokenInvalidated: boolean;
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
	frame: PendingWebSocketFrame,
	accountManager = state.activeAccountManager,
): Promise<PreparedWebSocketRequest> {
	const existing = frame.request;
	const context = existing?.context ?? buildWebSocketRequestContext(req, frame.data);
	if (!context) {
		throw new CodexValidationError("WebSocket message must be response.create.");
	}
	if (!frame.usageRecorder) state.status.totalRequests += 1;
	const recorderInput: Parameters<typeof createRuntimeUsageRecorder>[0] = {
		source: "runtime-proxy",
		operation: "responses",
		model: context.model,
		projectKey: null,
		requestId: randomUUID(),
		startedAt: state.now(),
	};
	const usageRecorder = frame.usageRecorder ??= existing?.usageRecorder ?? createRuntimeUsageRecorder(recorderInput);
	const startedAt = state.now();
	let policyDecision: RuntimePolicyDecision;
	try {
		const policyState = await loadRuntimePolicyState();
		recorderInput.projectKey = policyState.project.projectKey;
		policyDecision = await evaluateRuntimePolicy({
			state: policyState,
			accounts: accountManager.getAccountsSnapshot(),
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
	const budgetAdvisory = state.contextBudgetGuard.getAdvisory(
		context.stableSessionKey ?? "",
		startedAt,
		context.model,
	);
	if (budgetAdvisory.level === "hard") {
		state.contextBudgetGuard.noteHardPauseEmitted(
			context.stableSessionKey ?? "",
		);
		await usageRecorder.record({
			outcome: "blocked",
			statusCode: HTTP_STATUS.OK,
			errorCode: "context_budget_guard_paused",
		});
		throw createRuntimeProxyHttpError(
			"Context budget guard paused this WebSocket request.",
			HTTP_STATUS.OK,
			"context_budget_guard_paused",
		);
	}
	return { context, policyDecision, usageRecorder };
}

function dispatchRuntimeSkipReason(
	state: RotationProxyState,
	accountManager: AccountManager,
	account: ManagedAccount,
	context: { family: ModelFamily; model: string | null },
	admission: CircuitAdmissionReceipt | undefined,
	admittedCooldown: Pick<ManagedAccount, "coolingDownUntil" | "cooldownReason"> | undefined,
	accountId: string,
): string | null {
	if (accountManager.getAccountByIndex(account.index) !== account ||
		(state.nativeOpenai && state.activeAccountManager !== accountManager)) return "missing";
	let reason = accountManager.getManagedAccountRuntimeSkipReason(account, context.family, context.model);
	if (reason?.startsWith("cooling-down") && admittedCooldown?.coolingDownUntil !== undefined &&
		account.coolingDownUntil === admittedCooldown.coolingDownUntil && account.cooldownReason === admittedCooldown.cooldownReason) {
		reason = account.circuitKeyId && !getCircuitBreaker(account.circuitKeyId).isAvailable() ? "circuit-open" : null;
	}
	if (admission) {
		const breaker = account.circuitKeyId ? getCircuitBreaker(account.circuitKeyId) : undefined;
		if (!breaker?.isAdmissionCurrent(admission)) return reason ?? "circuit-open";
		if (reason === "circuit-open" && admission.halfOpen) reason = null;
	}
	const scope = state.nativeOpenai ? workspaceModelScopes(account).find(scope => scope.accountId === accountId) : undefined;
	const baseline = state.nativeOpenai ? (scope ? state.subscriptionQuotaObservations?.get(JSON.stringify([scope.id, context.model])) : undefined) ?? null : undefined;
	const deferral = state.preemptiveQuotaScheduler.getDeferral(
		buildQuotaScheduleKey(account, context.family, context.model), state.now(), quotaReceiptOwner(captureDispatchBinding(accountManager, account, account.access ?? "", accountId)), baseline,
	);
	return reason ?? (deferral.defer ? "rate-limited" : null);
}

async function currentDispatchPolicy(state: RotationProxyState, context: RequestContext, manager: AccountManager): Promise<RuntimePolicyDecision> {
	try {
		const policy = await evaluateRuntimePolicy({state: await loadRuntimePolicyState(), accounts: manager.getAccountsSnapshot(), model: context.model, now: state.now()});
		if (!policy.allowed) throw createRuntimeProxyHttpError("Runtime policy blocked dispatch.", policy.statusCode, policy.errorCode ?? "policy_blocked");
		return policy;
	} catch (error) {
		if (isRuntimeProxyHttpError(error)) throw error;
		throw createRuntimeProxyHttpError("Runtime policy is unavailable.", 503, "runtime_policy_unavailable");
	}
}

async function validateAccountDispatch(
	state: RotationProxyState,
	context: RequestContext,
	binding: AccountDispatchBinding,
	admission?: CircuitAdmissionReceipt,
	admittedCooldown?: Pick<ManagedAccount, "coolingDownUntil" | "cooldownReason">,
	allowNativeGrace?: () => Promise<boolean>,
	retryChangedAuthority = true,
): Promise<string | null> {
	const {accountManager, account} = binding;
	const policyCurrent = captureRuntimePolicyRevision();
	const path = accountManager.resolveSelectionStoragePath();
	const authorityCurrent = captureAuthorityRevision([path, getPendingAuthPath(path)], [getIntentionalResetMarkerPath(path)]);
	if (accountManager.getAccountByIndex(account.index) !== account) throw createRuntimeProxyHttpError("Account membership changed.", 503, "routing_configuration_changed");
	const policy = await currentDispatchPolicy(state, context, accountManager);
	const snapshot = state.nativeOpenai && state.readNativeAccountStorage
		? await state.readNativeAccountStorage() : await accountManager.readDispatchAccountStorage();
	if (snapshot) {
		const storage = snapshot.verified || (state.nativeOpenai && snapshot.routingAvailable === true && await allowNativeGrace?.()) ? snapshot.storage : null;
		if (!storage || state.activeAccountManager !== accountManager) throw createRuntimeProxyHttpError("Native authorization is unavailable.", 503, "routing_configuration_changed");
		if (syncNativeAccountCredentials(accountManager, storage, snapshot.capturedAt)) {
			state.modelCatalog = undefined;
			state.modelCatalogs?.clear();
		}
		if (!storage.accounts.some(row => isSameNativeAccount(account, row))) throw createRuntimeProxyHttpError("Account generation changed.", 503, "routing_configuration_changed");
	}
	try {
		if (!await accountManager.isAccountJournalEligible(account)) throw createRuntimeProxyHttpError("Journal authorization changed.", 503, "routing_configuration_changed");
	} catch {
		throw createRuntimeProxyHttpError("Journal authorization is unavailable.", 503, "routing_configuration_changed");
	}
	const bindingCurrent = isDispatchBindingCurrent(state, binding) && (binding.expiresAt ?? 0) > state.now();
	if (!authorityCurrent() || !policyCurrent(policy.budgetEvaluations.length > 0)) {
		if (retryChangedAuthority && bindingCurrent) return validateAccountDispatch(state, context, binding, admission, admittedCooldown, allowNativeGrace, false);
		throw createRuntimeProxyHttpError("Request-bound authorization changed.", 503, "routing_configuration_changed");
	}
	if (!bindingCurrent) throw createRuntimeProxyHttpError("Request-bound authorization changed.", 503, "routing_configuration_changed");
	if (policy.blockedAccountIndexes.has(account.index)) throw createRuntimeProxyHttpError("Runtime policy blocked the account.", 403, "policy_blocked");
	if (state.contextBudgetGuard.getAdvisory(context.stableSessionKey ?? "", state.now(), context.model).level === "hard") {
		throw createRuntimeProxyHttpError("Context budget paused dispatch.", 503, "context_budget_guard_paused");
	}
	return dispatchRuntimeSkipReason(state, accountManager, account, context, admission, admittedCooldown, binding.accountId);
}

async function withDispatchAuthorization(state: RotationProxyState, authorize: DispatchAuthorization, operation: () => Promise<Response>): Promise<Response> {
	if (state.withDispatchAuthorization) return state.withDispatchAuthorization(authorize, operation);
	throw createRuntimeProxyHttpError("Dispatch authorization is unavailable.", 503, "routing_configuration_changed");
}

async function validateWebSocketRequestForAccount(
	state: RotationProxyState,
	request: PreparedWebSocketRequest,
	binding: AccountDispatchBinding,
	admission?: CircuitAdmissionReceipt,
): Promise<void> {
	const {account} = binding;
	let runtimeSkipReason: string | null;
	try {
		runtimeSkipReason = await validateAccountDispatch(state, request.context, binding, admission);
	} catch (error) {
		if (isRuntimeProxyHttpError(error) && error.code === "routing_configuration_changed") {
			throw createRuntimeProxyHttpError("The socket binding is no longer authorized.", 503, "websocket_account_deferred");
		}
		throw error;
	}
	if (request.policyDecision.blockedAccountIndexes.has(account.index)) {
		void request.usageRecorder.record({
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
	if (runtimeSkipReason) {
		const recoverable =
			runtimeSkipReason === "rate-limited" ||
			runtimeSkipReason === "circuit-open" ||
			runtimeSkipReason === "cooling-down" ||
			runtimeSkipReason.startsWith("cooling-down:");
		if (!recoverable) {
			void request.usageRecorder.record({
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
}

async function consumeWebSocketRequestForAccount(
	state: RotationProxyState,
	request: PreparedWebSocketRequest,
	binding: AccountDispatchBinding,
): Promise<CircuitAdmissionReceipt> {
	const {accountManager, account} = binding;
	await validateWebSocketRequestForAccount(state, request, binding);
	let admission: CircuitAdmissionReceipt | undefined;
	if (!accountManager.consumeToken(account, request.context.family, request.context.model, {onAdmission: receipt => {admission = receipt;}}) || !admission) {
		throw createRuntimeProxyHttpError(
			"The account bound to this WebSocket connection is temporarily unavailable.",
			HTTP_STATUS.SERVICE_UNAVAILABLE,
			"circuit_open",
		);
	}
	return admission;
}

function websocketTerminalUsage(
	data: RawData,
): WebSocketTerminalEvent | null {
	const body = rawDataToBuffer(data);
	const parsed = parseRequestBody(body);
	if (!parsed) return null;
	const response = isRecord(parsed.response) ? parsed.response : null;
	let type = readStringRecordValue(parsed, "type");
	if (type === "response.done") type = `response.${readStringRecordValue(response ?? {}, "status") ?? "completed"}`;
	let outcome: "success" | "failure" | "cancelled";
	if (
		type === "response.completed" ||
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
	const usage = extractResponsesUsage(parsed);
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
	const rawBody = JSON.stringify({error: error ?? {}});
	const errorMessage = readStringRecordValue(error ?? {}, "message");
	const tokenInvalidated = isResponsesTokenInvalidationEvent(parsed);
	const statusCode =
		(tokenInvalidated ? HTTP_STATUS.UNAUTHORIZED : null) ??
		readWebSocketStatusCode(parsed, response, error) ??
		(outcome === "success"
			? HTTP_STATUS.OK
			: inferWebSocketFailureStatus(errorCode, JSON.stringify({code: errorCode, message: errorMessage})));
	return {
		record: {
			outcome,
			statusCode,
			errorCode,
			...(usage ?? {}),
		},
		rawBody,
		errorMessage,
		tokenInvalidated,
		retryAfterMs:
			readFiniteNumber(parsed, "retry_after_ms") ??
			readFiniteNumber(error, "retry_after_ms"),
		retryHeaders: [...retryHeaders].length > 0 ? retryHeaders : null,
	};
}

async function applyWebSocketTransportAccountFailure(
	state: RotationProxyState,
	active: AccountDispatchBinding & Pick<ActiveWebSocketRequest, "request" | "circuitAdmission">,
): Promise<boolean> {
	const { accountManager, account, request } = active;
	try {
		const applied = await applyDispatchRestriction(state, active, () => {
			accountManager.recordFailure(account, request.context.family, request.context.model, active.circuitAdmission);
			accountManager.markAccountCoolingDown(account, state.networkErrorCooldownMs, "network-error");
		});
		if (applied) {
			state.sessionAffinityStore?.forgetSession(request.context.sessionKey);
			state.status.retries += 1;
			state.status.rotations += 1;
		}
		return applied;
	} catch (error) {
		state.status.lastError = error instanceof Error ? error.message : String(error);
		throw error;
	}
}

async function applyWebSocketTerminalAccountFailure(
	state: RotationProxyState,
	active: ActiveWebSocketRequest,
	terminal: WebSocketTerminalEvent,
): Promise<void> {
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
		const applied = await applyDispatchRestriction(state, active, () => {
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
		});
		if (applied) forgetAffinity();
		return;
	}
	if (statusCode === HTTP_STATUS.UNAUTHORIZED) {
		accountManager.refundToken(account, context.family, context.model);
		const applied = await applyDispatchRestriction(state, active, () => {
			accountManager.recordFailure(account, context.family, context.model, active.circuitAdmission);
			if (terminal.tokenInvalidated) {
				accountManager.markAuthInvalidated(account, "token_invalidated", undefined, active.accessToken);
				applyMonotonicAuthCooldown(accountManager, account, state.tokenInvalidationCooldownMs, active);
			} else {
				applyMonotonicAuthCooldown(accountManager, account, DEFAULT_AUTH_FAILURE_COOLDOWN_MS, active);
			}
		});
		if (applied) forgetAffinity();
		return;
	}
	if (
		(statusCode === 402 || statusCode === HTTP_STATUS.FORBIDDEN) &&
		isWorkspaceDisabledError(
			statusCode,
			terminal.record.errorCode,
			terminal.errorMessage ?? "",
		)
	) {
		accountManager.refundToken(account, context.family, context.model);
		const applied = await applyDispatchRestriction(state, active, () => {
			accountManager.recordFailure(account, context.family, context.model, active.circuitAdmission);
			accountManager.setAccountEnabled(account.index, false);
		});
		if (applied) forgetAffinity();
		return;
	}
	if (statusCode >= 500) {
		accountManager.refundToken(account, context.family, context.model);
		const applied = await applyDispatchRestriction(state, active, () => {
			accountManager.recordFailure(account, context.family, context.model, active.circuitAdmission);
			accountManager.markAccountCoolingDown(account, state.serverErrorCooldownMs, "server-error");
		});
		if (applied) forgetAffinity();
	}
}

function applyWebSocketTerminalAccountSuccess(
	state: RotationProxyState,
	active: ActiveWebSocketRequest,
	terminal: WebSocketTerminalEvent,
): void {
	if (terminal.record.outcome !== "success") return;
	if (!isDispatchBindingCurrent(state, active)) return;
	active.accountManager.recordSuccess(active.account, active.request.context.family, active.request.context.model, active.circuitAdmission);
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
): Promise<{upstream: WebSocket; release: () => void; error?: Error}> {
	return new Promise((resolve, reject) => {
		const upstream = new WebSocket(url, {
		headers,
		handshakeTimeout: timeoutMs,
		perMessageDeflate: false,
	});
		let settled = false;
		let readingUnexpectedResponse = false;
		let unexpectedResponse: IncomingMessage | null = null;
		const connection: {upstream: WebSocket; release: () => void; error?: Error} = {upstream, release: () => {
			signal.removeEventListener("abort", onAbort);
			upstream.off("error", onError);
			upstream.off("close", onClose);
		}};
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			upstream.off("open", onOpen);
			upstream.off("unexpected-response", onUnexpectedResponse);
			if (error) {upstream.terminate(); if (upstream.readyState === WebSocket.CLOSED) connection.release(); reject(error);}
			else resolve(connection);
		};
		const onOpen = (): void => finish();
		const onError = (error: Error): void => {
			connection.error = error;
			if (settled) upstream.terminate();
			else if (!readingUnexpectedResponse) finish(error);
		};
		const onClose = (): void => {
			connection.error ??= new Error("Upstream WebSocket closed before dispatch.");
			if (!readingUnexpectedResponse) finish(connection.error);
			if (settled) connection.release();
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
		upstream.on("error", onError);
		upstream.once("close", onClose);
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
	allowStaleRecovery: boolean,
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
				pidOffsetEnabled: state.pidOffsetEnabled,
				schedulingStrategy: WEBSOCKET_SCHEDULING_STRATEGY,
			});
		const selected =
			state.routingMutexMode === "enabled"
				? await withRoutingMutex(state.routingMutexMode, () => selectAccount())
				: selectAccount();
		if (!selected) {
			if (
				allowStaleRecovery &&
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
		if (!await accountManager.isAccountJournalEligible(selected)) {
			skipReasons.set(selected.index, "auth-failure");
			continue;
		}
		const quotaScheduleKey = buildQuotaScheduleKey(
			selected,
			context.family,
			context.model,
		);
		const quotaScopes = workspaceModelScopes(selected).filter(scope => scope.routable);
		const quotaAccountId = (quotaScopes.find(scope => scope.selected) ?? quotaScopes.find(scope => scope.bound) ?? quotaScopes[0])?.accountId ?? "";
		const preemptiveDeferral = state.preemptiveQuotaScheduler.getDeferral(
			quotaScheduleKey,
			state.now(),
			quotaReceiptOwner(captureDispatchBinding(accountManager, selected, selected.access ?? "", quotaAccountId)),
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
		let circuitAdmission: CircuitAdmissionReceipt | undefined;
		if (!accountManager.consumeToken(selected, context.family, context.model, {onAdmission: receipt => {circuitAdmission = receipt;}}) || !circuitAdmission) {
			skipReasons.set(selected.index, "circuit-open");
			continue;
		}
		attemptBudget.attempts += 1;
		const prepared: PreparedWebSocketAccount = {
			...captureDispatchBinding(accountManager, selected, selected.access ?? "", ""),
			circuitAdmission,
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
		Object.assign(prepared, captureDispatchBinding(accountManager, refreshed.account, refreshed.accessToken, ""));
		if (lifecycle.isClosed() || !prepared.tokenRefundable) {
			lifecycle.onReleased(prepared);
			refundPreparedWebSocketToken(prepared);
			return null;
		}
		const scopes = workspaceModelScopes(refreshed.account).filter(scope => scope.routable);
		const accountId = (scopes.find(scope => scope.selected) ?? scopes.find(scope => scope.bound) ?? scopes[0])?.accountId;
		if (!accountId) {
			refundPreparedWebSocketToken(prepared);
			try {
				await accountManager.withCurrentAccountCredential(refreshed.account, prepared, () => {
					if (state.activeAccountManager !== accountManager) return false;
					accountManager.recordFailure(refreshed.account, context.family, context.model, prepared.circuitAdmission);
					applyMonotonicAuthCooldown(accountManager, refreshed.account, DEFAULT_AUTH_FAILURE_COOLDOWN_MS, prepared);
					return true;
				});
			} finally {lifecycle.onReleased(prepared);}
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
	allowStaleRecovery: boolean,
): Promise<{ upstream: WebSocket; prepared: PreparedWebSocketAccount; release: () => void; connectionError: () => Error | undefined } | null> {
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
			allowStaleRecovery,
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
		let connection: Awaited<ReturnType<typeof openUpstreamWebSocket>> | undefined;
		try {
			await validateWebSocketRequestForAccount(state, request, prepared, prepared.circuitAdmission);
			if (lifecycle.isClosed() || !prepared.tokenRefundable) throw new ClientCancellationError();
			state.status.upstreamRequests += 1;
			connection = await openUpstreamWebSocket(
				buildWebSocketUpstreamUrl(req, state.upstreamBaseUrl),
				createWebSocketOutboundHeaders(context.headers, account, accessToken, accountId),
				state.fetchTimeoutMs,
				abortController.signal,
			);
			const {upstream} = connection;
			if (lifecycle.isClosed()) {
				refundPreparedWebSocketToken(prepared);
				lifecycle.onReleased(prepared);
				mirrorWebSocketClose(upstream, 1000, "Local client closed");
				break;
			}
			await validateWebSocketRequestForAccount(state, request, prepared, prepared.circuitAdmission);
			if (lifecycle.isClosed() || !prepared.tokenRefundable || upstream.readyState !== WebSocket.OPEN) throw new ClientCancellationError();
			if (!prepared.circuitAdmission.halfOpen) accountManager.recordSuccess(account, context.family, context.model, prepared.circuitAdmission);
			recordRuntimeAccountRecovery(account.index);
			recordLastRuntimeAccount(
				state.status,
				accountIdentityFromAccount(account, state.now()),
				accountId,
			);
			state.sessionAffinityStore?.remember(context.sessionKey, account.index, state.now());
			await persistRuntimeActiveAccount(
				accountManager,
				account,
				context.family,
				isPinned,
				WEBSOCKET_SCHEDULING_STRATEGY,
			);
			if (lifecycle.isClosed() || !prepared.tokenRefundable) {
				upstream.terminate();
				refundPreparedWebSocketToken(prepared);
				lifecycle.onReleased(prepared);
				break;
			}
			if (connection.error || upstream.readyState !== WebSocket.OPEN) throw connection.error ?? new Error("Upstream WebSocket closed before dispatch.");
			const connected = connection;
			return { upstream, prepared, release: connection.release, connectionError: () => connected.error };
		} catch (error) {
			connection?.upstream.terminate();
			prepared.abortHandshake = null;
			refundPreparedWebSocketToken(prepared);
			if (lifecycle.isClosed()) {lifecycle.onReleased(prepared); break;}
			if (isRuntimeProxyHttpError(error)) {lifecycle.onReleased(prepared); throw error;}
			state.status.lastError = error instanceof Error ? error.message : String(error);
			const handshakeError = error instanceof WebSocketHandshakeError ? error : null;
			const statusCode = handshakeError?.statusCode ?? null;
			const bodyText = handshakeError?.bodyText ?? "";
			state.sessionAffinityStore?.forgetSession(context.sessionKey);
			try {
				if (statusCode === HTTP_STATUS.UNAUTHORIZED) {
					const invalidated = isTokenInvalidationError(bodyText);
					await applyDispatchRestriction(state, prepared, () => {
						accountManager.recordFailure(account, context.family, context.model, prepared.circuitAdmission);
						if (invalidated) accountManager.markAuthInvalidated(account, "token_invalidated", undefined, accessToken);
						applyMonotonicAuthCooldown(accountManager, account, invalidated ? state.tokenInvalidationCooldownMs : DEFAULT_AUTH_FAILURE_COOLDOWN_MS, prepared);
					});
					if (invalidated) {
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
				} else if (statusCode === HTTP_STATUS.TOO_MANY_REQUESTS) {
					const retryAfterMs =
						(handshakeError
							? parseRetryAfterHeaderMs(handshakeError.headers, state.now())
							: null) ??
						parseRetryAfterBodyMs(bodyText, state.now()) ??
						60_000;
					await applyDispatchRestriction(state, prepared, () => {
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
					});
				} else {
					await applyDispatchRestriction(state, prepared, () => {
						accountManager.recordFailure(account, context.family, context.model, prepared.circuitAdmission);
						accountManager.markAccountCoolingDown(
							account,
							statusCode !== null && statusCode >= 500
								? state.serverErrorCooldownMs
								: state.networkErrorCooldownMs,
							statusCode !== null && statusCode >= 500 ? "server-error" : "network-error",
						);
					});
				}
			} catch (restrictionError) {
				await request.usageRecorder.record({outcome: "failure", statusCode: statusCode ?? HTTP_STATUS.BAD_GATEWAY, errorCode: "websocket_handshake_failed", account});
				throw restrictionError;
			} finally {lifecycle.onReleased(prepared);}
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
	const queuedFrames = new Set<PendingWebSocketFrame>();
	let queuedBytes = 0;
	let nextFrameOrder = 0;
	let settlingTurn = false;
	const releaseFrame = (frame: PendingWebSocketFrame): void => {
		if (queuedFrames.delete(frame)) queuedBytes -= rawDataToBuffer(frame.data).byteLength;
	};
	let upstream: WebSocket | null = null;
	let boundAccountManager: AccountManager | null = null;
	let boundAccount: ManagedAccount | null = null;
	let boundAuthority: AccountDispatchBinding | undefined;
	let pendingInitialRequest: PreparedWebSocketRequest | null = null;
	let pendingHandshake: PreparedWebSocketAccount | null = null;
	let connecting = false;
	let closed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let clientFrameQueue = Promise.resolve();
	const settlePendingHandshake = async (
		outcome: "failure" | "cancelled",
		errorCode: string,
		applyAccountFailure = false,
	): Promise<void> => {
		const prepared = pendingHandshake;
		const request = prepared?.request ?? pendingInitialRequest;
		if (!request) return;
		const abortHandshake = prepared?.abortHandshake;
		if (prepared) prepared.abortHandshake = null;
		abortHandshake?.();
		if (prepared) refundPreparedWebSocketToken(prepared);
		try {
			if (prepared && applyAccountFailure) await applyWebSocketTransportAccountFailure(state, prepared);
		} finally {
			if (pendingInitialRequest === request) pendingInitialRequest = null;
			if (pendingHandshake === prepared) pendingHandshake = null;
			await request.usageRecorder.record({
				outcome,
				statusCode: outcome === "failure" ? HTTP_STATUS.BAD_GATEWAY : null,
				errorCode,
				account: pending.find(frame => frame.request === request)?.submittedAccount ?? prepared?.account,
			});
		}
	};
	const settleAll = async (
		outcome: "failure" | "cancelled",
		errorCode: string,
		applyAccountFailure = false,
	): Promise<void> => {
		let failure: {error: unknown} | undefined;
		for (const active of activeRequests.slice()) {
			try {
				if (applyAccountFailure) await applyWebSocketTransportAccountFailure(state, active);
			} catch (error) {failure ??= {error};}
			const index = activeRequests.indexOf(active);
			if (index >= 0) activeRequests.splice(index, 1);
			await active.request.usageRecorder.record({
				outcome,
				statusCode: outcome === "failure" ? HTTP_STATUS.BAD_GATEWAY : null,
				errorCode,
				account: active.account,
			});
		}
		if (failure) throw failure.error;
	};
	const settlePending = (
		outcome: "failure" | "cancelled",
		errorCode: string,
		before?: PendingWebSocketFrame,
	): void => {
		for (const frame of queuedFrames) {
			if (before && frame.order >= before.order) continue;
			const context = frame.request?.context ?? buildWebSocketRequestContext(req, frame.data);
			if (before && !context) continue;
			releaseFrame(frame);
			if (!context) continue;
			if (!frame.usageRecorder) state.status.totalRequests += 1;
			const recorder = frame.usageRecorder ?? frame.request?.usageRecorder ?? createRuntimeUsageRecorder({
				source: "runtime-proxy", operation: "responses", model: context.model,
				projectKey: null, requestId: randomUUID(), startedAt: state.now(),
			});
			void recorder.record({outcome, statusCode: outcome === "failure" ? HTTP_STATUS.BAD_GATEWAY : null, errorCode, account: frame.submittedAccount});
		}
		for (let i = pending.length - 1; i >= 0; i--) {
			const frame = pending[i];
			if (frame && !queuedFrames.has(frame)) pending.splice(i, 1);
		}
	};
	const closeBoth = (code = WEBSOCKET_CLOSE_TRY_AGAIN_LATER, reason = "WebSocket proxy closed"): void => {
		if (closed) return;
		closed = true;
		settlePending("failure", "websocket_proxy_closed");
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		mirrorWebSocketClose(client, code, reason);
		if (upstream) mirrorWebSocketClose(upstream, code, reason);
	};
	const sendBuffered = (socket: WebSocket, data: RawData | string, isBinary = false): boolean => {
		const bytes = typeof data === "string" ? Buffer.byteLength(data) : rawDataToBuffer(data).byteLength;
		if (socket.bufferedAmount + bytes > state.maxRequestBodyBytes) {
			void settlePendingHandshake("failure", "websocket_buffer_exceeded").catch(rejectConnection);
			void settleAll("failure", "websocket_buffer_exceeded").catch(rejectConnection);
			settlePending("failure", "websocket_buffer_exceeded");
			closeBoth(WEBSOCKET_CLOSE_TRY_AGAIN_LATER, "WebSocket buffer exceeded");
			return false;
		}
		socket.send(data, {binary: isBinary});
		return true;
	};
	const reportConnectionScopedContinuationLoss = (): void => {
		if (client.readyState !== WebSocket.OPEN) return;
		// Match the Responses WebSocket protocol used by the official Codex CLI.
		// It treats this code as retryable, discards its cached socket state, and
		// rebuilds the next attempt from the full request instead of replaying a
		// previous_response_id that belonged to a different upstream connection.
		sendBuffered(client, JSON.stringify({
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
		void settlePendingHandshake("failure", "websocket_proxy_failed").catch(rejectConnection);
		void settleAll("failure", "websocket_proxy_failed").catch(rejectConnection);
		settlePending("failure", "websocket_proxy_failed");
		const policyViolation =
			error instanceof CodexValidationError || (isRuntimeProxyHttpError(error) && !(error instanceof PendingAuthObservationError));
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
		if (closed || client.readyState !== WebSocket.OPEN || !queuedFrames.has(frame)) {
			if (preparedHandshake) {
				refundPreparedWebSocketToken(preparedHandshake);
				if (pendingHandshake === preparedHandshake) void settlePendingHandshake("cancelled", "response_cancelled").catch(rejectConnection);
			}
			return;
		}
		const type = readStringRecordValue(parseRequestBody(rawDataToBuffer(frame.data)) ?? {}, "type");
		if (type === "response.create" && (activeRequests.length > 0 || settlingTurn)) {
			pending.push(frame);
			return;
		}
		if (type !== "response.create") {
			releaseFrame(frame);
			if (upstream?.readyState === WebSocket.OPEN && frame.upstreamConnection === upstream) sendBuffered(upstream, frame.data, frame.isBinary);
			return;
		}
		if (upstream?.readyState !== WebSocket.OPEN || (hasConnectionScopedContinuation(frame) && frame.upstreamConnection !== upstream)) {
			if (hasConnectionScopedContinuation(frame)) {
				const request = frame.request ?? await prepareWebSocketRequest(state, req, frame);
				if (closed || !queuedFrames.has(frame)) return;
				await request.usageRecorder.record({outcome: "failure", statusCode: HTTP_STATUS.BAD_GATEWAY, errorCode: "websocket_continuation_lost"});
				releaseFrame(frame);
				reportConnectionScopedContinuationLoss();
			} else {
				pending.push(frame);
				void initialize();
			}
			return;
		}
		const forwardingUpstream = upstream;
		let request = preparedHandshake?.request;
		let consumedForFrame = false;
		if (!request) {
			request = await prepareWebSocketRequest(state, req, frame, boundAccountManager ?? state.activeAccountManager);
			frame.request = request;
			if (closed || client.readyState !== WebSocket.OPEN || !queuedFrames.has(frame)) return;
			if (upstream !== forwardingUpstream || upstream.readyState !== WebSocket.OPEN) {
				if (hasConnectionScopedContinuation(frame)) {
					await request.usageRecorder.record({outcome: "failure", statusCode: HTTP_STATUS.BAD_GATEWAY, errorCode: "websocket_continuation_lost"});
					releaseFrame(frame);
					reportConnectionScopedContinuationLoss();
				} else if (upstream?.readyState === WebSocket.OPEN) {
					enqueueClientFrame(frame);
				} else {
					pending.push(frame);
					void initialize();
				}
				return;
			}
		}
		const forwardingAccountManager = preparedHandshake?.accountManager ?? boundAccountManager;
		const forwardingAccount = preparedHandshake?.account ?? boundAccount;
		if (preparedHandshake) {
			request = await prepareWebSocketRequest(state, req, frame, preparedHandshake.accountManager);
			frame.request = request;
		}
		const binding = preparedHandshake ?? boundAuthority;
		if (!forwardingAccountManager || !forwardingAccount || !binding) {
			throw createRuntimeProxyHttpError("The socket binding is unavailable.", 503, "websocket_account_unavailable");
		}
		let admission = preparedHandshake?.circuitAdmission;
		try {
			if (!preparedHandshake) {
				admission = await consumeWebSocketRequestForAccount(state, request, binding);
				consumedForFrame = true;
			}
			await validateWebSocketRequestForAccount(state, request, binding, admission);
		} catch (error) {
			if (preparedHandshake) refundPreparedWebSocketToken(preparedHandshake);
			else if (consumedForFrame) forwardingAccountManager.refundToken(forwardingAccount, request.context.family, request.context.model);
			if (closed || !queuedFrames.has(frame)) return;
			if (preparedHandshake || !isRecoverableWebSocketAccountError(error)) throw error;
			const staleUpstream = upstream;
			const staleAccount = boundAccount;
			upstream = null;
			boundAccountManager = null;
			boundAccount = null;
			boundAuthority = undefined;
			if (staleUpstream) mirrorWebSocketClose(staleUpstream, 1000, "account_rotation");
			if (hasConnectionScopedContinuation(frame)) {
				void request.usageRecorder.record({outcome: "failure", statusCode: HTTP_STATUS.BAD_GATEWAY, errorCode: "websocket_continuation_lost", account: staleAccount ?? undefined});
				releaseFrame(frame);
				reportConnectionScopedContinuationLoss();
				return;
			}
			frame.recoveryAttempts ??= 0;
			pending.unshift(frame);
			void initialize();
			return;
		}
		if (closed || client.readyState !== WebSocket.OPEN || !queuedFrames.has(frame) || upstream !== forwardingUpstream || forwardingUpstream.readyState !== WebSocket.OPEN) {
			if (preparedHandshake) refundPreparedWebSocketToken(preparedHandshake);
			else if (consumedForFrame) forwardingAccountManager.refundToken(forwardingAccount, request.context.family, request.context.model);
			if (!closed && client.readyState === WebSocket.OPEN && queuedFrames.has(frame)) enqueueClientFrame(frame);
			return;
		}
		if (!admission) throw createRuntimeProxyHttpError("Circuit admission is unavailable.", 503, "routing_configuration_changed");
		frame.submittedAccount = forwardingAccount;
		activeRequests.push({...binding, circuitAdmission: admission, request});
		try {
			if (!sendBuffered(forwardingUpstream, frame.data, frame.isBinary)) {
				if (preparedHandshake) refundPreparedWebSocketToken(preparedHandshake);
				else if (consumedForFrame) forwardingAccountManager.refundToken(forwardingAccount, request.context.family, request.context.model);
				return;
			}
		} catch (error) {
			const active = activeRequests.at(-1);
			if (active) {
				await applyWebSocketTransportAccountFailure(state, active).catch(() => undefined);
				const index = activeRequests.indexOf(active);
				if (index >= 0) activeRequests.splice(index, 1);
			}
			if (preparedHandshake) refundPreparedWebSocketToken(preparedHandshake);
			else if (consumedForFrame) {
				forwardingAccountManager.refundToken(
					forwardingAccount,
					request.context.family,
					request.context.model,
				);
			}
			await request.usageRecorder.record({
				outcome: "failure",
				statusCode: HTTP_STATUS.BAD_GATEWAY,
				errorCode: "websocket_send_failed",
				account: forwardingAccount,
			});
			throw error;
		}
		releaseFrame(frame);
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
			.catch(error => {if (!closed && queuedFrames.has(frame)) rejectConnection(error);});
	};
	const drainPending = (): void => {
		if (closed || activeRequests.length > 0 || settlingTurn) return;
		if (upstream?.readyState !== WebSocket.OPEN) { void initialize(); return; }
		for (const frame of pending.splice(0)) enqueueClientFrame(frame);
	};
	async function initialize(): Promise<void> {
		if (closed || settlingTurn || connecting || reconnectTimer || upstream || pending.length === 0) return;
		connecting = true;
		let firstFrame: PendingWebSocketFrame | undefined;
		try {
			// previous_response_id is scoped to the upstream WebSocket connection.
			// If the proxy needs a new upstream connection, replaying that delta frame
			// would make Codex reject it. Emit the backend's standard retryable error so
			// the client clears its cached continuation and rebuilds a full request.
			while (pending[0] && hasConnectionScopedContinuation(pending[0])) {
				const lost = pending[0];
				pending.shift();
				firstFrame = lost;
				const request = lost.request ?? await prepareWebSocketRequest(state, req, lost);
				if (closed || !queuedFrames.has(lost)) continue;
				await request.usageRecorder.record({outcome: "failure", statusCode: HTTP_STATUS.BAD_GATEWAY, errorCode: "websocket_continuation_lost", account: lost.submittedAccount});
				releaseFrame(lost);
				reportConnectionScopedContinuationLoss();
			}
			firstFrame = pending[0];
			if (!firstFrame) return;
			const firstRequest = await prepareWebSocketRequest(state, req, firstFrame);
			firstFrame.request = firstRequest;
			if (closed || client.readyState !== WebSocket.OPEN || !queuedFrames.has(firstFrame)) return;
			pendingInitialRequest = firstRequest;
			const handshakeFrame = firstFrame;
			const connected = await connectManagedWebSocket(
				state,
				req,
				firstRequest,
				{
					onPrepared: prepared => {
						pendingHandshake = prepared;
						if (!closed && client.readyState === WebSocket.OPEN && queuedFrames.has(handshakeFrame)) return true;
						void settlePendingHandshake("cancelled", "response_cancelled").catch(rejectConnection);
						return false;
					},
					onReleased: prepared => {if (pendingHandshake === prepared) pendingHandshake = null;},
					isClosed: () => closed || client.readyState !== WebSocket.OPEN || !queuedFrames.has(handshakeFrame),
				},
				firstFrame.recoveryAttempts === undefined,
			);
			if (closed || client.readyState !== WebSocket.OPEN || !queuedFrames.has(firstFrame)) {
				if (connected) {refundPreparedWebSocketToken(connected.prepared); connected.upstream.terminate();}
				return;
			}
			if (connected && (connected.connectionError() || connected.upstream.readyState !== WebSocket.OPEN)) {
				connected.upstream.terminate();
				refundPreparedWebSocketToken(connected.prepared);
				await applyWebSocketTransportAccountFailure(state, connected.prepared);
				throw connected.connectionError() ?? new Error("Upstream WebSocket closed before dispatch.");
			}
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
			boundAuthority = captureDispatchBinding(connected.prepared.accountManager, connected.prepared.account, connected.prepared.accessToken, connected.prepared.accountId);
			state.status.streamsStarted += 1;
			connectedUpstream.on("message", (data, isBinary) => {
				if (closed || upstream !== connectedUpstream) return;
				const terminal = websocketTerminalUsage(data);
				if (terminal) {
					const settled = activeRequests.shift();
					if (settled) {
						applyWebSocketTerminalAccountSuccess(state, settled, terminal);
						const restriction = applyWebSocketTerminalAccountFailure(state, settled, terminal);
						if (
							settled.request.context.stableSessionKey &&
							settled.request.context.model &&
							typeof terminal.record.inputTokens === "number" &&
							typeof terminal.record.outputTokens === "number"
						) {
							state.contextBudgetGuard.update(
								settled.request.context.stableSessionKey,
								{
									model: settled.request.context.model,
									contextTokens:
										terminal.record.inputTokens + terminal.record.outputTokens,
									updatedAt: state.now(),
								},
							);
						}
						settlingTurn = true;
						void (async () => {
							try {
								await restriction;
							} finally {
								await settled.request.usageRecorder.record({...terminal.record, account: settled.account});
								settlingTurn = false;
							}
							drainPending();
						})().catch(rejectConnection);
					}
				}
				if (terminal?.record.outcome === "failure" && terminal.tokenInvalidated) {
					if (client.readyState === WebSocket.OPEN) sendBuffered(client, JSON.stringify({type: "error", status: 401, error: {code: "token_invalidated", message: "OAuth token has been invalidated. Please re-login."}}));
					void settleAll("failure", "token_invalidated").catch(rejectConnection);
					settlePending("failure", "token_invalidated");
					closeBoth(WEBSOCKET_CLOSE_POLICY_VIOLATION, "OAuth token invalidated");
					return;
				}
				if (client.readyState === WebSocket.OPEN) sendBuffered(client, data, isBinary);
			});
			connectedUpstream.on("close", () => {
				void (async () => {
					if (closed || upstream !== connectedUpstream) return;
					upstream = null;
					boundAccountManager = null;
					boundAccount = null;
					boundAuthority = undefined;
					if (settlingTurn && activeRequests.length === 0 && !pendingHandshake) return;
					settlingTurn = true;
					await settlePendingHandshake("failure", "upstream_websocket_closed", true);
					if (activeRequests.length === 0) {settlingTurn = false; drainPending(); return;}
					await settleAll("failure", "upstream_websocket_closed", true);
					if (closed || client.readyState !== WebSocket.OPEN) return;
					sendBuffered(client, JSON.stringify({type: "error", status: HTTP_STATUS.BAD_GATEWAY, error: {code: "upstream_websocket_closed", message: "Upstream closed after request dispatch. The submitted turn was not replayed."}}));
					settlingTurn = false;
					drainPending();
				})().catch(rejectConnection);
			});
			connectedUpstream.on("error", (error) => {
				if (closed || upstream !== connectedUpstream) return;
				state.status.lastError = error.message;
				connectedUpstream.terminate();
			});
			connected.release();
			connected.prepared.abortHandshake = null;
			const queued = pending.splice(0);
			const queuedFirst = queued.shift();
			if (queuedFirst) enqueueClientFrame(queuedFirst, connected.prepared);
			for (const frame of queued) {
				enqueueClientFrame(frame);
			}
		} catch (error) {
			if (!closed && (!firstFrame || queuedFrames.has(firstFrame))) rejectConnection(error);
		} finally {
			connecting = false;
			if (!closed && !upstream && pending.length > 0 && !reconnectTimer) void initialize();
		}
	}
	client.on("message", (data, isBinary) => {
		if (closed) return;
		const bytes = rawDataToBuffer(data).byteLength;
		if (queuedFrames.size >= MAX_QUEUED_WEBSOCKET_FRAMES || queuedBytes + bytes > state.maxRequestBodyBytes) {
			rejectConnection(new CodexValidationError("WebSocket queue limit exceeded."));
			return;
		}
		const frame: PendingWebSocketFrame = {order: nextFrameOrder++, data, isBinary, upstreamConnection: upstream ?? undefined};
		queuedFrames.add(frame);
		queuedBytes += bytes;
		if (readStringRecordValue(parseRequestBody(rawDataToBuffer(data)) ?? {}, "type") === "response.cancel") {
			settlePending("cancelled", "response_cancelled", frame);
			if (pendingInitialRequest?.usageRecorder.hasRecorded()) void settlePendingHandshake("cancelled", "response_cancelled").catch(rejectConnection);
			if (upstream?.readyState !== WebSocket.OPEN) {
				void settleAll("cancelled", "response_cancelled").catch(rejectConnection);
				releaseFrame(frame);
				return;
			}
		}
		if (upstream?.readyState === WebSocket.OPEN) {
			enqueueClientFrame(frame);
			return;
		}
		pending.push(frame);
		void initialize();
	});
	client.on("close", (code, reason) => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		void settlePendingHandshake("cancelled", "client_websocket_closed").catch(rejectConnection);
		void settleAll("cancelled", "client_websocket_closed").catch(rejectConnection);
		settlePending("cancelled", "client_websocket_closed");
		closed = true;
		if (upstream) mirrorWebSocketClose(upstream, code, reason);
	});
	client.on("error", (error) => {
		state.status.lastError = error.message;
		void settlePendingHandshake("failure", "client_websocket_error").catch(rejectConnection);
		void settleAll("failure", "client_websocket_error").catch(rejectConnection);
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
	// Library-boundary trust enforcement: the wrapper validates the env override,
	// but options.upstreamBaseUrl reaches here from any caller — and Bearer
	// tokens are forwarded to whatever host it names. https always passes; http
	// is allowed only for the documented numeric-loopback dev path.
	if (options.upstreamBaseUrl !== undefined) {
		assertAllowedUpstreamBaseUrl(options.upstreamBaseUrl);
	}
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
			(options.nativeOpenai ? 0 : getPreemptiveQuotaRemainingPercent5h(pluginConfig)),
		remainingPercentThresholdSecondary:
			options.quotaRemainingPercentThreshold ??
			(options.nativeOpenai ? 0 : getPreemptiveQuotaRemainingPercent7d(pluginConfig)),
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
		nativeOpenai: options.nativeOpenai === true,
		readNativeAccountStorage: options.readNativeAccountStorage || !options.accountManager ? createNativeAccountStorageReader(options.readNativeAccountStorage, activeAccountManager.resolveSelectionStoragePath()) : undefined,
		readApiRoutes: options.readApiRoutes ?? loadApiRoutes,
		readSubscriptionQuota: options.readSubscriptionQuota ?? (options.accountManager ? undefined : loadQuotaCache),
		catalogAccount: options.catalogAccount,
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

	const websocketGateway = new ResponsesWebSocketGateway(fetchImpl, {maxPayloadBytes: state.maxRequestBodyBytes});
	state.fetchImpl = websocketGateway.fetch;
	state.webSocketRequestSent = () => websocketGateway.requestSent();
	state.withDispatchAuthorization = (authorize, operation) => websocketGateway.withDispatchAuthorization(authorize, operation);
	const server = createServer((req, res) => {
		websocketGateway.handle(req, () => handleRequest(state, req, res));
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
		if (state.nativeOpenai) return;
		socket.on("error", () => socket.destroy());
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

	if (state.nativeOpenai) websocketGateway.attach(server, `http://${urlHost}:${resolvedPort}`);
	// Embedded managers own their own lifecycle; ordinary CLI/app routers check opted-in accounts periodically.
	const automaticChecks = options.accountManager ? undefined : startAutomaticAccountChecks(createAutomaticSubscriptionCheck());
	return {
		host: bindHost,
		port: resolvedPort,
		baseUrl: `http://${urlHost}:${resolvedPort}`,
		close: async () => {
			await automaticChecks?.stop();
			for (const client of webSocketServer.clients) client.terminate();
			webSocketServer.close();
			websocketGateway.close();
			await closeServer(server, sockets);
			await flushRuntimeInferenceActivity();
			await state.activeAccountManager.flushPendingSave();
		},
		// Live client connections, which the app helper reads as evidence that a
		// detached consumer is still attached: a helper whose launcher is gone
		// and whose socket set is empty has nobody left to serve.
		getOpenConnectionCount: () => sockets.size,
		getStatus: () => ({
			...state.status,
 websocketConnections: websocketGateway.stats.connections,
 websocketUpstreamRequests: websocketGateway.stats.upstreamRequests,
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
		const bearer = incomingHeaders.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
		const apiKeyClient = isAuthorizedClient(incomingHeaders, state.clientApiKey);
		const isLiveManagedToken = (access: string | undefined, expires: number | undefined, enabled: boolean | undefined, invalidatedAt: number | undefined): boolean =>
			!!bearer && enabled !== false && !invalidatedAt && !!access && (expires ?? 0) > state.now() && safeEqual(bearer, access);
		const managedOAuthFor = (manager: AccountManager): boolean => state.nativeOpenai === true && manager.getAccountsSnapshot().some(account =>
			isLiveManagedToken(account.access, account.expires, account.enabled, account.authInvalidatedAt));
		let managedStorageVerified = true;
		// A missing or unreadable store (not a transient lock) must not become an
		// empty pool: that would discard the live manager's learned state and hide
		// the cause behind catalog/403 errors.
		let nativeStorageMissing = false;
        let nativeOAuthResult: boolean | undefined;
		const nativeOAuth = async (): Promise<boolean> =>
			(nativeOAuthResult ??= !!(state.nativeOpenai && bearer && await isNativeClientToken(bearer, state.now())));
		if (state.nativeOpenai && state.readNativeAccountStorage) {
			// Screen the caller before account storage can reshape the manager: a
			// request with no credential never reads disk, and a bearer that matches
			// nothing we hold (in memory or on disk) is refused before any credential
			// sync or manager swap.
			if (!apiKeyClient && !bearer) {
				writeUnauthorized(res);
				return;
			}
			const snapshot = await state.readNativeAccountStorage();
            const disk = snapshot.storage ?? {version: 3 as const, accounts: [], activeIndex: 0, activeIndexByFamily: {}};
            managedStorageVerified = snapshot.verified && snapshot.storage !== null;
            // A concurrent request may have replaced the manager while this read waited.
            accountManager = state.activeAccountManager;
			const presentsKnownCredential = apiKeyClient || (snapshot.storage !== null && managedOAuthFor(accountManager)) ||
				!!disk?.accounts.some(a => isLiveManagedToken(a.accessToken, a.expiresAt, a.enabled, a.authInvalidatedAt)) ||
				await nativeOAuth();
			if (!presentsKnownCredential) {
				writeUnauthorized(res);
				return;
			}
			if (snapshot.transientFailure && snapshot.routingAvailable === false && (apiKeyClient || await nativeOAuth())) {
                writeJson(res, 503, {error:{code:"native_account_storage_unavailable",message:"Account storage is temporarily unavailable. Retry when it is readable."}});
                return;
            }
            nativeStorageMissing = snapshot.storage === null && !snapshot.transientFailure;
            if ((snapshot.verified || snapshot.routingAvailable === true) && snapshot.storage !== null) {
			let accounts = accountManager.getAccountsSnapshot();
			const sameInventory = accounts.length === disk.accounts.length && accounts.every((a, i) => isSameNativeAccount(a, disk.accounts[i]));
			if (!sameInventory) {
				syncNativeAccountCredentials(accountManager, disk, snapshot.capturedAt);
				const previousManager = accountManager;
				accounts = accountManager.getAccountsSnapshot();
				accountManager = new AccountManager(undefined, disk);
				accountManager.setRoutingMutexMode(state.routingMutexMode);
                // Preserve independently learned limits by identity, never by the old index.
                // A record id survives an email change; the account identity survives a
                // re-login that re-derives an unstored record id. Rows with neither an
                // accountId nor an email share no identity and match only by refresh token.
                const rebuilt = accountManager.getAccountsSnapshot();
                const claimed = new Set<number>();
                const carryTarget = (previous: (typeof accounts)[number]) => {
                    const persisted = disk.accounts.find(row => isSameNativeAccount(previous, row));
                    const found = persisted && rebuilt.find(a => !claimed.has(a.index) && a.recordId === resolveAccountRecordId(persisted));
                    if (found) claimed.add(found.index);
                    return found;
                };
                for (const previous of accounts) {
                    const current = carryTarget(previous);
                    const live = current && accountManager.getAccountByIndex(current.index);
                    if (!current || !live) continue;
                    const previousLive = previousManager.getAccountByIndex(previous.index);
                    if (previousLive) accountManager.inheritNativeAuthObservation(live, previousManager, previousLive);
                    live.access = previous.access;
                    live.refreshToken = previous.refreshToken;
                    live.expires = previous.expires;
                    live.enabled = previous.enabled !== false && current.enabled !== false;
                    live.authInvalidatedAt = previous.authInvalidatedAt;
                    live.authInvalidationErrorCode = previous.authInvalidationErrorCode;
                    for (const [key, until] of Object.entries(previous.rateLimitResetTimes)) {
                        if (typeof until === "number" && until > state.now()) live.rateLimitResetTimes[key] = Math.max(live.rateLimitResetTimes[key] ?? 0, until);
                    }
                    if ((previous.coolingDownUntil ?? 0) > (live.coolingDownUntil ?? 0)) {
                        live.coolingDownUntil = previous.coolingDownUntil; live.cooldownReason = previous.cooldownReason;
                    }
                }
                // Reorders change index-based pins/affinity, so they deliberately reload too.
                const generation = disk.affinityGeneration ?? 0;
                if (generation <= state.lastObservedAffinityGeneration) state.sessionAffinityStore?.clearAll();
                state.activeAccountManager = accountManager;
				state.modelCatalog = undefined;
                state.modelCatalogs?.clear();
			} else if (syncNativeAccountCredentials(accountManager, disk, snapshot.capturedAt)) {
				state.modelCatalog = undefined;
                state.modelCatalogs?.clear();
			}
            }
		}
		if (!state.nativeOpenai && apiKeyClient) {
			const snapshot = await accountManager.readDispatchAccountStorage();
			accountManager = state.activeAccountManager;
			if (snapshot) {
				if (!snapshot.verified || !snapshot.storage) throw createRuntimeProxyHttpError("Account storage is unavailable.", 503, "routing_configuration_changed");
				if (syncNativeAccountCredentials(accountManager, snapshot.storage, snapshot.capturedAt)) {
					state.modelCatalog = undefined;
					state.modelCatalogs?.clear();
				}
			}
		}
		// Decide against the synced manager, so a credential revoked or disabled on
		// disk is refused even though it passed the screen above.
		if (!apiKeyClient && !(managedStorageVerified && managedOAuthFor(accountManager)) && !(await nativeOAuth())) {
			writeUnauthorized(res);
			return;
		}

		// The native client treats 426 as a signal to retry over HTTP/SSE.
		// Authenticate first; never forward an unsupported WebSocket handshake.
		if (
			req.method === "GET" && isResponsesPath(incomingUrl.pathname) &&
			incomingHeaders.get("upgrade")?.toLowerCase() === "websocket"
		) {
			res.setHeader("connection", "close");
			writeJson(res, 426, {
				error: {
					message: "Use HTTP streaming for Responses API requests.",
					code: "runtime_rotation_proxy_http_required",
				},
			});
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
		let requestBody =
			isResponsesRequest || isImageRequest ||
			(isThreadGoalRequest && req.method === "POST")
				? await readRequestBody(req, state.maxRequestBodyBytes)
				: Buffer.alloc(0);
		if (isResponsesRequest) {
			requestBody = await decodeRequestBody(requestBody, incomingHeaders.get("content-encoding"), state.maxRequestBodyBytes);
			const parsed = parseRequestBody(requestBody);
			if (!parsed || typeof parsed.model !== "string" || !parsed.model.trim()) {
				throw createRuntimeProxyHttpError("Responses requests require a JSON object with a model.", 400, "invalid_request_body");
			}
   let route;
   try { route=parseModelRoute(parsed.model); } catch { throw createRuntimeProxyHttpError("Invalid model route.",400,"invalid_model_route"); }
   if(route.kind==="oauth"&&route.serviceTier){
    if(parsed.service_tier&&canonicalServiceTier(String(parsed.service_tier))!==canonicalServiceTier(route.serviceTier))throw createRuntimeProxyHttpError("Conflicting speed selection.",400,"conflicting_service_tier");
    parsed.model=route.upstreamModel;parsed.service_tier=route.serviceTier;
    requestBody=Buffer.from(JSON.stringify(parsed));
   }
		}
		const context = isModelsRequest
			? buildModelsRequestContext(req)
			: isThreadGoalRequest
				? buildThreadGoalRequestContext(req, requestBody, incomingUrl.pathname)
				: isImageRequest
					? buildImageRequestContext(req, requestBody, incomingUrl.pathname)
						: buildResponsesRequestContext(req, requestBody);
		if (isResponsesRequest) {
			context.headers.delete("content-encoding");
			context.headers.delete("content-length");
		}
		// Explicit API/ZDR routes never touch the OAuth pool, so they stay available.
		// Everything else would route through a manager the store no longer backs.
		// A 401 would tell the native client its login is bad when the store is what
		// is missing, so independently authenticated clients get a 503 (#702).
		if (nativeStorageMissing && !(isResponsesRequest && context.model && /^(api|zdr)\//.test(context.model))) {
			writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
				error: {
					message: "Account storage is unavailable. Run codex-multi-auth login or check the account store.",
					code: "native_account_storage_unavailable",
				},
			});
			return;
		}
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

		// Explicit API aliases are handled before all OAuth selection. An absent
		// credential or catalog is a hard failure, never an ordinary-model fallback.
		if (context.model && /^(api|zdr)\//.test(context.model)) {
			if (!isResponsesRequest) {
				writeJson(res, 400, { error: { code: "api_route_requires_responses" } });
				return;
			}
			const body = parseRequestBody(requestBody);
			if (!body) {
				writeJson(res, 400, { error: { code: "invalid_request_body" } });
				return;
			}
			const apiRuntime=getApiModelRuntime(state);
			const apiModel = context.model;
			const controller = new AbortController();
			const abort = () => {
				if (!res.writableEnded) controller.abort();
			};
			res.on("close", abort);
			try {
				const apiRoutes = (await state.readApiRoutes?.()) ?? [];
				const attempt: {credential?: ApiRouteCredential} = {};
				const authorize: DispatchAuthorization = async (input, init) => {
					if (init.method !== "POST" || !new URL(String(input)).pathname.endsWith("/responses")) return;
					const policyCurrent = captureRuntimePolicyRevision();
					const routesCurrent = captureAuthorityRevision([getApiRoutesPath()]);
					const policy = await currentDispatchPolicy(state, context, state.activeAccountManager);
					const credential = attempt.credential;
					const current = (await state.readApiRoutes?.())?.find(route => route.id === credential?.id && route.kind === credential?.kind);
					const sent = parseRequestBody(Buffer.from(typeof init.body === "string" ? init.body : ""));
					const model = sent?.model;
					const effort = isRecord(sent?.reasoning) && typeof sent.reasoning.effort === "string" ? sent.reasoning.effort : undefined;
					const tier = typeof sent?.service_tier === "string" ? sent.service_tier : undefined;
					const catalog = apiRuntime.cachedCatalogs().find(item => item.id === credential?.id && item.kind === credential?.kind);
					const advertised = catalog?.models.find(item => item.slug === model);
					if (!credential || !current?.enabled || current.apiKey !== credential.apiKey || current.kind !== credential.kind ||
						new Headers(init.headers).get("authorization") !== `Bearer ${current.apiKey}` || typeof model !== "string" ||
						!policyCurrent(policy.budgetEvaluations.length > 0) || !routesCurrent() || !catalog || !advertised ||
						!isRouteModelEligible({...catalog, enabled: current.enabled, kind: current.kind, visibleModels: current.visibleModels}, advertised, effort, tier) ||
						!apiRuntime.supportsDispatch(current, model, effort, tier) ||
						state.contextBudgetGuard.getAdvisory(context.stableSessionKey ?? "", state.now(), context.model).level === "hard") {
						throw createRuntimeProxyHttpError("API dispatch eligibility changed.", 503, "routing_configuration_changed");
					}
				};
				const upstream = await withDispatchAuthorization(state, authorize, () => apiRuntime.request(
					apiModel,
					body,
					apiRoutes,
					controller.signal,
					(credentialIndex, credential) => {
						attempt.credential = credential;
						recordRuntimeInferenceRequest(`sha256:${modelScopeId(credential.kind, credential.id)}`, state.now());
						const label = `${context.model?.startsWith("zdr/") ? "ZDR" : "API"} credential ${credentialIndex + 1}`;
						state.status.upstreamRequests++;
						state.status.lastAccountIndex = null;
						state.status.lastAccountId = null;
						state.status.lastRequestedWorkspaceId = null;
						state.status.lastAccountLabel = label;
						state.status.lastAccountUpdatedAt = state.now();
						mutateRuntimeObservabilitySnapshot((snapshot) => {
							snapshot.lastAccountIndex = null;
							snapshot.lastAccountId = null;
							snapshot.lastRequestedWorkspaceId = null;
							snapshot.lastAccountEmail = null;
							snapshot.lastAccountLabel = label;
							snapshot.lastAccountUpdatedAt = state.now();
						});
					},
				));
				const responseOutcome = new ResponseOutcome(upstream.headers.get("content-type")?.includes("text/event-stream") === true);
				const nativeSent = state.webSocketRequestSent?.() === true;
				const nativeTerminal: {event: WebSocketTerminalEvent | null} = {event: null};
				const scanner = createUsageStreamScanner({
					contentType: upstream.headers.get("content-type"),
					onEvent: event => {
						responseOutcome.observe(event);
						if (nativeSent) {
							nativeTerminal.event ??= websocketTerminalUsage(Buffer.from(JSON.stringify(event)));
							const terminal = nativeTerminal.event;
							if (terminal?.record.outcome === "failure" && typeof terminal.record.statusCode === "number" && attempt.credential) {
								apiRuntime.recordStreamFailure(attempt.credential, apiModel, body, JSON.parse(terminal.rawBody), {
									status: terminal.record.statusCode, headers: terminal.retryHeaders ?? upstream.headers, retryAfterMs: terminal.retryAfterMs,
								});
							}
						}
					},
				});
				const forwarded = await forwardStreamingResponse(
					upstream,
					res,
					state.status,
					() => controller.abort(),
					state.streamStallTimeoutMs,
					scanner.push,
 state.catalogEtag ? {"x-models-etag":state.catalogEtag} : undefined,
					() => {scanner.result();return responseOutcome.finish();},
				);
				const clientDisconnected = res.destroyed && !res.writableEnded;
				const completion = responseOutcome.finish();
				if (!forwarded && !clientDisconnected && completion.outcome !== "cancelled" && attempt.credential && !nativeTerminal.event) apiRuntime.recordStreamFailure(attempt.credential, apiModel, body, responseOutcome.rejection);
				if (apiRuntime.lastPersistenceError) state.status.lastError = apiRuntime.lastPersistenceError;
				const usageTokens = scanner.result();
				if (usageTokens && context.stableSessionKey && context.model) {
					state.contextBudgetGuard.update(context.stableSessionKey, {
						model: context.model,
						contextTokens: usageTokens.inputTokens + usageTokens.outputTokens,
						updatedAt: state.now(),
					});
				}
				await usageRecorder.record({
					outcome: forwarded && upstream.ok ? "success" : clientDisconnected || completion.outcome === "cancelled" ? "cancelled" : "failure",
					statusCode: nativeTerminal.event?.record.statusCode ?? upstream.status,
					errorCode: clientDisconnected ? "client_disconnected" : nativeTerminal.event?.record.errorCode ?? completion.errorCode ?? (forwarded ? null : "stream_forward_failed"),
					...(usageTokens ?? {}),
				});
            } catch (error) {
                if (error instanceof ClientCancellationError || res.destroyed) {
                    await usageRecorder.record({outcome: "cancelled", statusCode: null, errorCode: "client_cancelled"});
                    if (!res.destroyed) res.destroy();
                    return;
                }
                throw error;
            } finally {
				res.off("close", abort);
			}
			return;
		}

		const upstreamUrl = buildUpstreamUrl(
			req,
			state.upstreamBaseUrl,
			context.upstreamPath,
		);
		const attemptedIndexes = new Set<number>();
		// The upstream's own capability 400/403/404, forwarded instead of a
		// synthetic 503 when no other account can take the request.
		let transportFailureAccount: ManagedAccount | undefined;
		let lastCapabilityRejection: { status: number; body: string; headers: Record<string, string>; account: ManagedAccount } | undefined;
		// True while no other failure has followed the last capability rejection.
		let capabilityRejectionIsLatest = false;
		// Entitlements belong to the workspace, so each workspace is tried at most
		// once per request even when several accounts share it.
		const rejectedWorkspaces = new Set<string>();
		const forwardCapabilityRejection = async (rejection: NonNullable<typeof lastCapabilityRejection>): Promise<void> => {
			res.writeHead(rejection.status, rejection.headers);
			res.end(rejection.body);
			await usageRecorder?.record({ outcome: "failure", statusCode: rejection.status, errorCode: "upstream_capability_rejected", account: rejection.account });
		};
        let catalogEligibleKeys: Set<string> | undefined;
        let catalogScopeEligible: ((key: string) => boolean) | undefined;
        const catalogExcludedIndexes = (): number[] => {
            const eligible = catalogEligibleKeys;
            return eligible ? accountManager.getAccountsSnapshot().filter(account => !workspaceCandidates.has(account.index)).map(account => account.index) : [];
        };
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
			for (const manager of new Set([state.activeAccountManager, accountManager])) manager.applyManualSelection(meta);
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
		const preferredIndex = state.nativeOpenai
			? storageMeta.pinnedAccountIndex ?? accountManager.getCurrentAccountForFamily(context.family)?.index ?? null
			: null;
		const workspaceCandidates = new Map<number, ReturnType<typeof workspaceModelScopes>>();
  const readSubscriptionQuota = state.readSubscriptionQuota;
  const subscriptionQuotaCache = state.nativeOpenai && isResponsesRequest && readSubscriptionQuota ? await cachedRead(state, "subscription-quota", readSubscriptionQuota).catch(()=>null) ?? null : null;
  const subscriptionQuotaByAccount: Record<number, SubscriptionQuotaPreference> = {};
  const resetCreditState=state.nativeOpenai&&isResponsesRequest ? await cachedRead(state, "reset-credits", loadResetCreditState).catch(()=>null):null;
  const quotaForScope = (account: ManagedAccount, scope: ReturnType<typeof workspaceModelScopes>[number]) => {
   // Scoped observations belong to this credential and workspace; legacy entries only describe the binding.
   const cached = findQuotaCacheEntryForAccount(subscriptionQuotaCache,account,accountManager.getAccountsSnapshot(),undefined,scope.accountId);
   const observed = state.subscriptionQuotaObservations?.get(JSON.stringify([scope.id,context.model]));
   const reset=resetCreditState?.snapshots[scope.id];
   if(reset && reset.updatedAt > Math.max(cached?.updatedAt??0,observed?.updatedAt??0) && reset.updatedAt <= state.now() && state.now()-reset.updatedAt<=60000)return resetSnapshotQuota(reset);
   return observed && observed.updatedAt >= (cached?.updatedAt ?? 0) ? observed : cached;
  };
  // A stored `switch` pin is a hard constraint in native mode too (#702), not a
  // preference: it fails with codex_pinned_account_unavailable rather than
  // silently serving from another account.
  const pinnedIndex = state.forcedAccountIndex ?? storageMeta.pinnedAccountIndex;
		const isPinned = typeof pinnedIndex === "number";
		if (state.nativeOpenai && (isModelsRequest || (isResponsesRequest && context.model))) {
			const requestedVersion = incomingUrl.searchParams.get("client_version") ?? incomingHeaders.get("version");
            const catalogClientVersion = requestedVersion && /^[0-9A-Za-z.+_-]{1,80}$/.test(requestedVersion) ? requestedVersion : undefined;
            const backoff = state.catalogBackoff ??= new Map();
			const forceCatalogRefresh = isModelsRequest && incomingUrl.searchParams.get("refresh_capabilities") === "1";
			// An explicit capability check is a deliberate retry: it must not stay
			// parked behind an earlier throttle's backoff.
			if (forceCatalogRefresh) backoff.clear();
			const catalogsByVersion = state.modelCatalogs ??= new Map();
			const versionKey = catalogClientVersion ?? "";
			state.modelCatalog = catalogsByVersion.get(versionKey);
			if (forceCatalogRefresh) state.modelCatalog?.refresh();
			state.modelCatalog ??= new AccountModelCatalog(async (key) => {
                const retryAt = backoff.get(key) ?? 0;
                if (retryAt > state.now()) throw new CatalogRetryError(retryAt - state.now());
                backoff.delete(key);
				const discoveryManager = state.activeAccountManager;
				const scope = discoveryManager.getAccountsSnapshot().flatMap(workspaceModelScopes).find(s=>s.id===key && s.enabled);
    const account = scope ? discoveryManager.getAccountByIndex(scope.accountIndex) : null;
				if (!account || account.enabled === false || discoveryManager.isAccountAuthInvalidated(account) ||
                    (account.cooldownReason === "auth-failure" && (account.coolingDownUntil ?? 0) > state.now())) throw new Error("Account unavailable");
				const fresh = await ensureFreshAccessToken({					accountManager: discoveryManager, account,
					family: "codex", model: null, now: state.now(), tokenRefreshSkewMs: state.tokenRefreshSkewMs,
					tokenInvalidationCooldownMs: state.tokenInvalidationCooldownMs				});
				if (!fresh.ok) throw new Error("Account authentication unavailable");
				const accountId = scope?.accountId;
				if (!accountId) throw new Error("Account identity unavailable");
				const url = new URL(state.upstreamBaseUrl);
				url.pathname = url.pathname.replace(/\/+$/, "") + "/codex/models";
				const clientVersion = catalogClientVersion;
				if (clientVersion && /^[0-9A-Za-z.+_-]{1,80}$/.test(clientVersion)) url.searchParams.set("client_version", clientVersion);
				const binding = captureDispatchBinding(discoveryManager, fresh.account, fresh.accessToken, accountId);
				const rejection = await validateAccountDispatch(state, context, binding, undefined, undefined, async () => apiKeyClient || await nativeOAuth());
				if (rejection) throw createRuntimeProxyHttpError("Catalog dispatch eligibility changed.", 503, "routing_configuration_changed");
				const response = await state.fetchImpl(url.toString(), {					method: "GET", redirect: "error",
					headers: createOutboundHeaders(new Headers(), fresh.account, fresh.accessToken, accountId),
					signal: AbortSignal.timeout(Math.min(state.fetchTimeoutMs, 15_000))				});
				if (!response.ok) {
                    await response.body?.cancel();
                    if (response.status === 429) {
                        const retryMs = clampCatalogRetryMs(parseRetryAfterHeaderMs(response.headers, state.now()));
                        if (backoff.size >= 100) backoff.delete(backoff.keys().next().value ?? "");
                        backoff.set(key, state.now() + retryMs);
                        throw new CatalogRetryError(retryMs);
                    }
                    throw new Error("Catalog unavailable");
                }
				// Bound remote bytes, not just the advertised content length.
				const reader = response.body?.getReader(); if (!reader) throw new Error("Empty catalog");
				const chunks: Uint8Array[] = []; let size = 0;
				try {					for (;;) {						const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
						if (size > 8 * 1024 * 1024) throw new Error("Catalog too large"); chunks.push(part.value);					}				}
				finally { await reader.cancel(); }
				if (state.activeAccountManager !== discoveryManager || discoveryManager.getAccountByIndex(fresh.account.index) !== fresh.account ||
					fresh.account.access !== binding.accessToken || fresh.account.recordId !== binding.recordId) throw new Error("Account authorization changed during discovery");
				return JSON.parse(Buffer.concat(chunks).toString("utf8"));
			}, state.now);
			const modelCatalog = state.modelCatalog;
			if (catalogsByVersion.size >= 4 && !catalogsByVersion.has(versionKey)) catalogsByVersion.delete(catalogsByVersion.keys().next().value ?? "");
			catalogsByVersion.set(versionKey, modelCatalog);
			const eligible = accountManager.getAccountsSnapshot().filter(a => a.enabled !== false &&
				(!isPinned || a.index === pinnedIndex) && !policyDecision?.blockedAccountIndexes.has(a.index));
			if (isModelsRequest) {
				const reference = state.catalogAccount;
				const discovery = accountManager
					.getAccountsSnapshot()
					.filter((a) => a.enabled !== false)
					.sort(
						(a, b) =>
							Number(
								Boolean(
									reference &&
										b.email === reference.email &&
										b.accountId === reference.accountId,
								),
							) -
							Number(
								Boolean(
									reference &&
										a.email === reference.email &&
										a.accountId === reference.accountId,
								),
							),
					);
				const scopes = discovery.flatMap(workspaceModelScopes);
				const enabledKeys = scopes.filter(scope => scope.enabled).map(scope => scope.id);
				const routableKeys = scopes.filter(scope => scope.routable).map(scope => scope.id);
				const oauthRefresh = modelCatalog.list(enabledKeys);
				// Explicit check waits for all workspaces; picker discovery runs API and OAuth in parallel.
				if (forceCatalogRefresh) await oauthRefresh;
				const apiRuntime = getApiModelRuntime(state);
				let apiConfigurationUnavailable = false;
                const configuredRoutes = await state.readApiRoutes?.().catch(() => {
                    apiConfigurationUnavailable = true;
                    state.status.lastError = "api_configuration_unavailable";
                    return [];
                }) ?? [];
				if (!apiConfigurationUnavailable && state.status.lastError === "api_configuration_unavailable") state.status.lastError = null;
                state.catalogApiRoutes = configuredRoutes;
				// Paid API probes respect the 15-minute cache unless `check capabilities` forces them.
				const forceProbes = forceCatalogRefresh && incomingUrl.searchParams.get("force_probes") === "1";
				const apiRefresh = apiRuntime.catalogs(configuredRoutes, forceCatalogRefresh, forceProbes, forceCatalogRefresh);
				const pickerSnapshot = () => [
					...modelCatalog.cachedList(routableKeys).filter(model => !/^(api|zdr)\//.test(model.slug)),
					...buildVisibleModelUnion(apiRuntime.cachedCatalogs().flatMap(catalog => {
						const route = configuredRoutes.find(route => route.id === catalog.id && route.enabled);
						return route ? [{...catalog, visibleModels: route.visibleModels, priority: route.priority}] : [];
					})),
				];
				const refresh = (async () => {
				await oauthRefresh;
				const apiCatalogs = await apiRefresh;
				const oauthModels = modelCatalog.cachedList(routableKeys).filter(model => !/^(api|zdr)\//.test(model.slug));
				const models = [...oauthModels, ...buildVisibleModelUnion(apiCatalogs)];
				if (state.modelCatalog === modelCatalog) {
					state.catalogOAuthModels = oauthModels;
					setCatalogEtag(state, models);
				}

				await saveModelInventory(state.catalogInventory = {
                    ...(apiConfigurationUnavailable ? {apiConfigurationUnavailable:true} : {}),
					version: 1,
					checkedAt: state.now(),
					clientVersion: catalogClientVersion,
					entries: [
						...scopes.map((scope) => {
							const entry = modelCatalog.snapshot(scope.id) ?? {
								checkedAt: 0,
								models: [],
								error: true,
							};
							return {
								...entry,
								id:scope.id,label:scope.label,routable:scope.routable,bound:scope.bound,selected:scope.selected,
        kind: "oauth" as const, enabled:scope.enabled,error:scope.enabled && entry.error,
        visibleModels: scope.routable?entry.models:[],
							};
						}),
						...apiRuntime
							.statuses(configuredRoutes)
							.map((a) => ({
								id:modelScopeId(a.kind,a.id),label: a.label,
								kind: a.kind,
								enabled: apiCatalogs.some((c) => c.id === a.id && c.enabled),
								checkedAt: a.checkedAt,
								error: a.error,
								models: a.availableModels,
								visibleModels: a.visibleModels,
 entitlements:a.entitlements,
							})),
					],
				}).catch(() => {
					state.status.lastError = "Model discovery status could not be saved";
				});

				return models;
				})();
				// Observe background failures even after the picker response has finished.
				void refresh.catch(() => { state.status.lastError = "Background model catalog refresh failed"; });
				let models: RouteModel[];
				if (forceCatalogRefresh) models = await refresh;
				else {
					const cached = pickerSnapshot();
					if (cached.length) models = cached;
					else {
						let timer: ReturnType<typeof setTimeout> | undefined;
						try {
							models = await Promise.race([refresh, new Promise<RouteModel[]>(resolve => {
								timer = setTimeout(() => resolve(pickerSnapshot()), 2000);
							})]);
						} finally { if (timer) clearTimeout(timer); }
					}
				}
				res.setHeader("etag", setCatalogEtag(state, models));

				writeJson(
					res,
					models.length ? 200 : 503,
					models.length
						? { models }
						: {
								error: {
									code: "account_catalog_unavailable",
									message: "No eligible account catalog is available.",
								},
							},
				);
				return;
			}

			const requestedModel = context.model;
			if (!requestedModel) throw new Error("Missing requested model");
			const requestedBody = parseRequestBody(requestBody);
			const effort = isRecord(requestedBody?.reasoning) && typeof requestedBody.reasoning.effort === "string" ? requestedBody.reasoning.effort : undefined;
			const requestedTier = typeof requestedBody?.service_tier === "string" ? requestedBody.service_tier : undefined;
			const failures = state.capabilityFailures ??= new RuntimeCapabilityFailures(state.now);
			const scopeAccounts = new Map(eligible.flatMap(account => workspaceModelScopes(account).map(scope => [scope.id, account.index] as const)));
			const capabilityEligible = (key: string): boolean => {
				const index = scopeAccounts.get(key);
				const account = index === undefined ? null : accountManager.getAccountByIndex(index);
				return !!account && typeof account.access === "string" && workspaceModelScopes(account).some(scope => scope.id === key && scope.routable) && failures.supports(
					capabilityFailureKey(key, {accessToken: account.access, refreshToken: account.refreshToken, expiresAt: account.expires}), requestedModel, effort, requestedTier);
			};
			catalogScopeEligible = key => capabilityEligible(key) && modelCatalog.supportsForRouting(key, requestedModel, effort, requestedTier);
			await modelCatalog.prepareRouting(
				eligible.flatMap(workspaceModelScopes).filter(scope => scope.routable).map(scope => scope.id),
				requestedModel, effort, requestedTier, capabilityEligible,
			);
			if (res.destroyed || res.writableEnded) return;
			let supported = 0;
   catalogEligibleKeys = new Set();
   for (const account of eligible) {
    const candidates: ReturnType<typeof workspaceModelScopes> = [];
    const scopes=workspaceModelScopes(account).filter(scope=>scope.routable).sort((a,b)=>Number(b.selected)-Number(a.selected)||Number(b.bound)-Number(a.bound));
    for(const scope of scopes) {
     // Fail open: an unknown catalog (outage/throttle) stays routable; only a fetched one excludes.
     if(catalogScopeEligible(scope.id)) candidates.push(scope);
    }
    if(candidates.length){
     candidates.sort((a,b)=>compareSubscriptionQuota(subscriptionQuotaPreference(quotaForScope(account,a),state.now()),subscriptionQuotaPreference(quotaForScope(account,b),state.now())));
     const first=candidates[0];
     subscriptionQuotaByAccount[account.index]=subscriptionQuotaPreference(first?quotaForScope(account,first):null,state.now());
     workspaceCandidates.set(account.index,candidates);catalogEligibleKeys.add(catalogAccountKey(account));supported++;
    }

   }
			if (!supported) {
				writeJson(res, 403, { error: { code: "model_not_available_in_account_catalog", message: "Selected model is not advertised by an eligible account. Refresh account access or account routing settings." } }); return;
			}
		}


  if (state.nativeOpenai && isResponsesRequest && context.model && resetCreditState?.lastRedemptionAt !== undefined) {
   for(const [index,scopes] of workspaceCandidates){const account=accountManager.getAccountByIndex(index);if(!account)continue;
    for(const scope of scopes)applyConfirmedReset({account,scope,model:context.model,family:context.family,manager:accountManager,snapshot:resetCreditState.snapshots[scope.id],lastRedemptionAt:resetCreditState.lastRedemptionAt,
     previous:state.subscriptionQuotaObservations?.get(JSON.stringify([scope.id,context.model])) ?? findQuotaCacheEntryForAccount(subscriptionQuotaCache,account,accountManager.getAccountsSnapshot(),undefined,scope.accountId),
     observations:state.subscriptionQuotaObservations ??=new Map(),now:state.now(),clearQuotaScheduler:a=>state.preemptiveQuotaScheduler.clear(buildQuotaScheduleKey(a,context.family,context.model))});
   }
  }
  if (state.nativeOpenai && isResponsesRequest && context.model && !isPinned) {
   try {
    await recoverResetQuota({model:context.model,family:context.family,native:true,pinned:false,manager:accountManager,
     scopes:workspaceCandidates,quotaForScope,priorityByAccount:policyDecision?.priorityByAccount,preferredIndex:storageMeta.pinnedAccountIndex,service:createResetCreditService(accountManager),
     observations:state.subscriptionQuotaObservations ??= new Map(),now:state.now,
     clearQuotaScheduler:account=>state.preemptiveQuotaScheduler.clear(buildQuotaScheduleKey(account,context.family,context.model)),
    });
   } catch { state.status.lastError="Subscription reset recovery could not be confirmed; no further automatic redemption attempted."; }
   // Recovery may have redeemed and written new reset state; the next request re-reads it.
   state.readCache?.delete("reset-credits");
  }


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
			const selectAccount = (): ManagedAccount | null => {
    for(const [index,scopes] of workspaceCandidates){
     const account=accountManager.getAccountByIndex(index);
     if(!account)continue;
     scopes.sort((a,b)=>compareSubscriptionQuota(subscriptionQuotaPreference(quotaForScope(account,a),state.now()),subscriptionQuotaPreference(quotaForScope(account,b),state.now())));
     const scope=scopes[0];
     if(scope)subscriptionQuotaByAccount[index]=subscriptionQuotaPreference(quotaForScope(account,scope),state.now());
    }
				const result=chooseAccount({
					accountManager,
					sessionAffinityStore: state.sessionAffinityStore,
					sessionKey: context.sessionKey,
					family: context.family,
					model: context.model,
					attemptedIndexes: new Set([...attemptedIndexes, ...catalogExcludedIndexes()]),
					now: state.now(),
					policy: policyDecision,
					pinnedIndex,
					preferredIndex,
					subscriptionQuotaByAccount: state.nativeOpenai && isResponsesRequest ? subscriptionQuotaByAccount : undefined,
					fallbackPinnedIndex: state.nativeOpenai ? storageMeta.pinnedAccountIndex : null,
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
    return result;
   };
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
            for (const index of catalogExcludedIndexes()) accountSkipReasons.set(index, "model-not-supported");
			if (!selected) {
				if (
					!reloadedAfterNoAccount &&
					!(state.nativeOpenai && state.readNativeAccountStorage) &&
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
                    const eligibilityIdentity = (manager: AccountManager) => JSON.stringify(manager.getAccountsSnapshot().map(account =>
                        [account.recordId, account.enabled, account.authInvalidatedAt, workspaceModelScopes(account)]));
                    const checkedInventory = state.nativeOpenai ? eligibilityIdentity(accountManager) : undefined;
					const reloadedManager = await recoverStaleRuntimeState(state);
					if (reloadedManager) {
                        if (checkedInventory !== undefined && checkedInventory !== eligibilityIdentity(reloadedManager)) {
                            res.setHeader("retry-after", "1");
                            writeJson(res,503,{error:{code:"account_catalog_refresh_pending",message:"Account inventory changed; retry with refreshed eligibility."}});
                            return;
                        }
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
			const admittedCooldown = isPinned && transientAttempts > 0
				? {coolingDownUntil: selected.coolingDownUntil, cooldownReason: selected.cooldownReason}
				: undefined;
			const quotaScheduleKey = buildQuotaScheduleKey(
				selected,
				context.family,
				context.model,
			);
			const selectedScope = state.nativeOpenai ? workspaceCandidates.get(selected.index)?.[0] : undefined;
			const preemptiveDeferral = state.preemptiveQuotaScheduler.getDeferral(
				quotaScheduleKey,
				state.now(),
				quotaReceiptOwner(captureDispatchBinding(accountManager, selected, selected.access ?? "", selectedScope?.accountId ?? resolveAccountId(selected, selected.access ?? "") ?? "")),
				state.nativeOpenai ? (selectedScope ? quotaForScope(selected, selectedScope) : null) ?? null : undefined,
			);
			if (preemptiveDeferral.defer && preemptiveDeferral.waitMs > 0) {
				accountSkipReasons.set(
					selected.index,
					preemptiveDeferral.reason ?? "quota-near-exhaustion",
				);
				exhaustionReason = "rate-limit";
				capabilityRejectionIsLatest = false;
				if (state.nativeOpenai && selectedScope) {
					workspaceCandidates.get(selected.index)?.shift();
					if (workspaceCandidates.get(selected.index)?.length) attemptedIndexes.delete(selected.index);
				} else {
					accountManager.markRateLimitedWithReason(selected, preemptiveDeferral.waitMs, context.family, "quota", context.model);
					accountManager.recordRateLimit(selected, context.family, context.model);
					accountManager.saveToDiskDebounced();
				}
				noteRotation();
				continue;
			}

			// consumeToken also takes the race-safe circuit admission slot, so it
			// can reject for either gate. Take the reason from the call that
			// rejected rather than re-deriving it: a second evaluation reports the
			// first blocker it finds (a live cooldown would mask a drained bucket)
			// and cannot see a half-open probe slot that was just claimed.
			if (!await accountManager.isAccountJournalEligible(selected)) {
				accountSkipReasons.set(selected.index, "auth-failure");
				continue;
			}
			let circuitAdmission: CircuitAdmissionReceipt | undefined;
			const admission = accountManager.consumeTokenWithReason(
				selected,
				context.family,
				context.model,
				{onAdmission: receipt => {circuitAdmission = receipt;}},
			);
			if (!admission.ok) {
				accountSkipReasons.set(selected.index, admission.reason);
				exhaustionReason = "rate-limit";
				capabilityRejectionIsLatest = false;
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

			if (!circuitAdmission) throw createRuntimeProxyHttpError("Circuit admission is unavailable.", 503, "routing_configuration_changed");
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
				capabilityRejectionIsLatest = false;
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

			const pendingScopes = workspaceCandidates.get(refreshed.account.index);
   // Revalidate enabled scopes after token refresh; never write a per-request choice to the account.
   const enabledScopes = new Set(workspaceModelScopes(refreshed.account).filter(s=>s.routable).map(s=>s.id));
   while(pendingScopes?.length && !enabledScopes.has(pendingScopes[0]?.id ?? "")) pendingScopes.shift();
   if (pendingScopes && !pendingScopes.length) {
    accountSkipReasons.set(refreshed.account.index, "workspace-disabled");
    capabilityRejectionIsLatest = false;
    if (isPinned) break;
    continue;
   }
   const requestScope = pendingScopes?.[0];
   const accountId = requestScope?.accountId ?? resolveAccountId(refreshed.account, refreshed.accessToken);
			if (!accountId) {
				await accountManager.withCurrentAccountCredential(refreshed.account, captureDispatchBinding(accountManager, refreshed.account, refreshed.accessToken, ""), () => {
					if (state.activeAccountManager !== accountManager) return false;
					accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
					applyMonotonicAuthCooldown(accountManager, refreshed.account, DEFAULT_AUTH_FAILURE_COOLDOWN_MS, {accessToken: refreshed.accessToken, refreshToken: refreshed.account.refreshToken, expiresAt: refreshed.account.expires});
					return true;
				});
				exhaustionReason = "auth-failure";
				capabilityRejectionIsLatest = false;
				transientAttempts += 1;
				transientExhaustionReason = "auth-failure";
				state.status.retries += 1;
				noteRotation();
				continue;
			}

			if (rejectedWorkspaces.has(accountId)) {
				// This workspace already rejected the model or setting for this request.
				if (pendingScopes && pendingScopes.length > 1) {
					pendingScopes.shift();
					attemptedIndexes.delete(refreshed.account.index);
				} else {
					policyDecision?.blockedAccountIndexes.add(refreshed.account.index);
				}
				continue;
			}

			const binding = captureDispatchBinding(accountManager, refreshed.account, refreshed.accessToken, accountId);
			const requestUsage = usageRecorder;
			const submittedUsageAccount = structuredClone(refreshed.account);
			const capabilityScopeId = requestScope?.id ?? workspaceModelScopes(refreshed.account).find(scope => scope.accountId === accountId)?.id ?? catalogAccountKey(refreshed.account);
			const submittedCapabilityKey = capabilityFailureKey(capabilityScopeId, binding);
			const validate = () => validateAccountDispatch(state, context, binding, circuitAdmission, admittedCooldown, async () => apiKeyClient || await nativeOAuth());
			const scopeEligible = () => !requestScope || (catalogScopeEligible?.(requestScope.id) === true && workspaceModelScopes(refreshed.account).some(scope => scope.id === requestScope.id && scope.routable));
			let finalAdmissionSkip: string | null = null;
			let dispatchAuthorized = false;
			const authorize: DispatchAuthorization = async () => {
				finalAdmissionSkip = await validate();
				if (finalAdmissionSkip || !scopeEligible()) throw createRuntimeProxyHttpError("Dispatch eligibility changed.", 503, "routing_configuration_changed");
				if (clientGone()) throw new ClientCancellationError();
				dispatchAuthorized = true;
				state.status.upstreamRequests++;
				recordLastRuntimeAccount(state.status, accountIdentity, accountId);
				if (isResponsesRequest || isImageRequest) recordRuntimeInferenceRequest(inferenceAccountKey(refreshed.account), state.now());
			};
			let runtimeSkipReason: string | null;
			try {
				runtimeSkipReason = await validate();
				if (clientGone()) throw new ClientCancellationError();
			} catch (error) {
				accountManager.refundToken(selected, context.family, context.model);
				throw error;
			}
			if (runtimeSkipReason) {
				accountManager.refundToken(selected, context.family, context.model);
				accountSkipReasons.set(selected.index, runtimeSkipReason);
				exhaustionReason = "rate-limit";
				capabilityRejectionIsLatest = false;
				if (isPinned) break;
				continue;
			}
			if (requestScope && (!catalogScopeEligible?.(requestScope.id) || !workspaceModelScopes(refreshed.account).some(scope => scope.id === requestScope.id && scope.routable))) {
				accountManager.refundToken(selected, context.family, context.model);
				pendingScopes?.shift();
				if (pendingScopes?.length) attemptedIndexes.delete(refreshed.account.index);
				accountSkipReasons.set(refreshed.account.index, "model-not-supported");
				continue;
			}
			const accountIdentity = accountIdentityFromAccount(refreshed.account, state.now());

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
				res.once("close", onClientClose);
				const upstreamRequestInit: RequestInit = {
					method: context.method,
					headers: outboundHeaders,
					signal: fetchAbortController.signal,
					// Redirect pinning: never follow an upstream redirect — a 3xx from
					// a compromised or misconfigured endpoint would re-send the
					// managed Bearer token to an arbitrary host. Matches the model
					// catalog fetch above.
					redirect: "error",
				};
				if (context.method === "POST") {
					upstreamRequestInit.body = context.body;
				}
				const fetchTimeoutMs = isImageRequest
					? Math.max(state.fetchTimeoutMs, 300_000)
					: state.fetchTimeoutMs;
				upstream = await withTimeout(
					withDispatchAuthorization(state, authorize, () => state.fetchImpl(upstreamUrl, upstreamRequestInit)),
					fetchTimeoutMs,
					() => fetchAbortController.abort(),
					`upstream fetch timed out after ${fetchTimeoutMs}ms`,
				);
			} catch (error) {
                if (clientGone() || (error instanceof ClientCancellationError)) {
                    await usageRecorder.record({outcome: "cancelled", statusCode: null, errorCode: "client_cancelled", account: refreshed.account});
                    if (!res.destroyed) res.destroy();
                    return;
                }
				if (isRuntimeProxyHttpError(error) || error instanceof PendingAuthObservationError) {
					accountManager.refundToken(selected, context.family, context.model);
					if (finalAdmissionSkip && !dispatchAuthorized && !state.webSocketRequestSent?.()) {
						accountSkipReasons.set(selected.index, finalAdmissionSkip);
						exhaustionReason = "rate-limit";
						capabilityRejectionIsLatest = false;
						if (isPinned) break;
						continue;
					}
					throw error;
				}
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
				// A redirect rejection is upstream configuration, not a transport
				// outage or an account-health signal: the 3xx arrived (so the path
				// works and no generation started), the Bearer token never reached
				// the redirect target, and every managed account would hit the
				// same redirect — cooling + rotating here would drain the pool on
				// one endpoint fault. This also covers the WebSocket httpFetch
				// fallback: SocketSession preserves init, so a refused-upgrade
				// turn on API/ZDR credentials can reject this way. Fail the
				// request in place and leave account state untouched.
				if (isRedirectRejection(error)) {
					writeJson(res, 502, {
						error: {
							code: "upstream_redirect_rejected",
							message:
								"Upstream endpoint attempted a redirect; redirects are never followed.",
						},
					});
					await usageRecorder.record({
						outcome: "failure",
						statusCode: 502,
						errorCode: "upstream_redirect_rejected",
						account: refreshed.account,
					});
					return;
				}
				if (state.webSocketRequestSent?.()) {
					const errorCode = "upstream_websocket_disconnected";
					writeJson(res, 502, {error: {code: errorCode, message: "Upstream request failed after dispatch; not replayed."}});
					await usageRecorder.record({outcome: "failure", statusCode: 502, errorCode, account: refreshed.account});
					return;
				}
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
				await applyDispatchRestriction(state, binding, () => {
					accountManager.markAccountCoolingDown(
						refreshed.account,
						state.networkErrorCooldownMs,
						"network-error",
					);
				}).catch(async restrictionError => {
					await requestUsage.record({outcome: "failure", statusCode: HTTP_STATUS.BAD_GATEWAY, errorCode: "upstream_transport_error", account: refreshed.account});
					throw restrictionError;
				});
				accountSkipReasons.set(refreshed.account.index, "network-error");
				exhaustionReason = "network-error";
				capabilityRejectionIsLatest = false;
				transientAttempts += 1;
				transientExhaustionReason = "network-error";
				if (dispatchAuthorized) {
					transportFailureAccount = submittedUsageAccount;
					break;
				}
				state.status.retries += 1;
				noteRotation();
				continue;
			} finally {
				res.off("close", onClientClose);
			}
			reconcileManualSelection();
			let pendingQuota: QuotaObservationReceipt | undefined;
			let quotaUpdate: Promise<void> | undefined;
			let restrictionFailure: {error: unknown} | undefined;
			const captureRestrictionFailure = (error: unknown): void => {restrictionFailure ??= {error};};
			const quotaScopeKey = state.nativeOpenai && requestScope && isResponsesRequest ? JSON.stringify([requestScope.id, context.model]) : undefined;
			const currentQuotaScope = () => quotaScopeKey ? state.subscriptionQuotaObservations?.get(quotaScopeKey) : undefined;
			const observeQuota = (snapshot: QuotaSchedulerSnapshot, planType?: string): Promise<void> => {
				if (state.activeAccountManager !== accountManager || accountManager.getAccountByIndex(refreshed.account.index) !== refreshed.account ||
					refreshed.account.recordId !== binding.recordId || refreshed.account.access !== binding.accessToken || refreshed.account.refreshToken !== binding.refreshToken || refreshed.account.expires !== binding.expiresAt) return Promise.resolve();
				if (quotaScopeKey && requestScope && !currentQuotaScope()) {
					const observations = state.subscriptionQuotaObservations ??= new Map();
					if (observations.size >= 1000) observations.delete(observations.keys().next().value ?? "");
					observations.set(quotaScopeKey, quotaForScope(refreshed.account, requestScope) ?? {model: context.model ?? "unknown", status: 200, updatedAt: 0, primary: {}, secondary: {}});
				}
				const receipt = state.preemptiveQuotaScheduler.receive(quotaScheduleKey, {...snapshot, planType}, quotaReceiptOwner(binding), currentQuotaScope());
				pendingQuota = mergeQuotaReceipts(receipt, pendingQuota);
				quotaUpdate ??= (async () => {
					let failure: {error: unknown} | undefined;
					try {
						while (pendingQuota) {
							const receipt = pendingQuota;
							pendingQuota = undefined;
							try {
								const applied = await applyDispatchRestriction(state, binding, () => {
									const merged = state.preemptiveQuotaScheduler.observeReceipt(quotaScheduleKey, receipt, currentQuotaScope());
									if (merged && quotaScopeKey) {
										const observations = state.subscriptionQuotaObservations ??= new Map();
										if (observations.size >= 1000 && !observations.has(quotaScopeKey)) observations.delete(observations.keys().next().value ?? "");
										observations.set(quotaScopeKey, Object.assign(merged, {model: context.model ?? "unknown"}));
									}
								});
								if (applied) state.preemptiveQuotaScheduler.settleReceipt(quotaScheduleKey, receipt, true, currentQuotaScope());
							} catch (error) {
								failure ??= {error};
								captureRestrictionFailure(error);
								state.preemptiveQuotaScheduler.settleReceipt(quotaScheduleKey, receipt, false, currentQuotaScope());
							}
						}
						if (failure) throw failure.error;
					} finally {quotaUpdate = undefined;}
				})();
				return quotaUpdate;
			};
			const quotaSnapshot = readQuotaSchedulerSnapshot(upstream.headers, upstream.status, state.now());
			if (quotaSnapshot) await observeQuota(quotaSnapshot, upstream.headers.get("x-codex-plan-type") ?? undefined).catch(captureRestrictionFailure);
			const readUpstreamErrorBody = async (maxBytes?: number): Promise<string> => {
				const body = await readErrorBody(upstream, state.streamStallTimeoutMs, maxBytes);
				upstream = new Response(body, {status: upstream.status, headers: upstream.headers});
				return body;
			};

			if (!restrictionFailure) try {
			if (isResponsesRequest && context.model && [400,403,404].includes(upstream.status)) {
    const errorBody = await readUpstreamErrorBody(65536);
    let data:unknown;try {data=JSON.parse(errorBody);}catch {data=null;}
    // Learning and rotating on capability rejections is native-only; other
    // proxies forward the upstream 4xx as they always have.
    const failure=state.nativeOpenai ? classifyCapabilityFailure(upstream.status,data) : null;
    if(failure){
     lastCapabilityRejection={status:upstream.status,body:errorBody,headers:responseHeadersForClient(upstream.headers),account:refreshed.account};
     const body=parseRequestBody(context.body);
     const effort=isRecord(body?.reasoning)&&typeof body.reasoning.effort==="string"?body.reasoning.effort:undefined;
     const tier=typeof body?.service_tier==="string"?body.service_tier:undefined;
     (state.capabilityFailures??=new RuntimeCapabilityFailures(state.now)).record(submittedCapabilityKey,context.model,failure,effort,tier);
     rejectedWorkspaces.add(accountId);capabilityRejectionIsLatest=true;
     if(pendingScopes && pendingScopes.length>1){
      pendingScopes.shift();attemptedIndexes.delete(refreshed.account.index);state.status.retries++;continue;
     }
     policyDecision?.blockedAccountIndexes.add(refreshed.account.index);
     if(!isPinned){state.status.retries++;noteRotation();continue;}
     writeJson(res,upstream.status,{error:{code:"pinned_model_capability_rejected",message:"The pinned account rejected this model or setting; no other account was used."}});
     await usageRecorder.record({outcome:"failure",statusCode:upstream.status,errorCode:"pinned_model_capability_rejected",account:refreshed.account});
     return;
    }
   }
			if (upstream.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
				const bodyText = await readUpstreamErrorBody();
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
				if (quotaScopeKey) await observeQuota({status: 429, updatedAt: state.now(), primary: {usedPercent: 100, resetAtMs: state.now() + retryAfterMs}, secondary: {}});
				await applyDispatchRestriction(state, binding, () => {
					// Preserve the consumed token; scoped native quota does not bench siblings.
					accountManager.recordRateLimit(refreshed.account, context.family, context.model);
					if (!quotaScopeKey || !refreshed.account.workspaces?.length) {
						state.preemptiveQuotaScheduler.markRateLimited(quotaScheduleKey, retryAfterMs, state.now());
						accountManager.markRateLimitedWithReason(refreshed.account, retryAfterMs, context.family, "quota", context.model);
					}
				});
				exhaustionReason = "rate-limit";
				capabilityRejectionIsLatest = false;
				transientAttempts += 1;
				transientExhaustionReason = "rate-limit";
				state.status.retries += 1;
				noteRotation();
				continue;
			}

			if (upstream.status === 402 || upstream.status === HTTP_STATUS.FORBIDDEN) {
				const bodyText = await readUpstreamErrorBody();
				const errorCode = extractErrorCodeFromBody(bodyText);
				if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {
					const restricted = await applyDispatchRestriction(state, binding, () => {
						if (requestScope && refreshed.account.workspaces?.length) accountManager.disableWorkspace(refreshed.account, requestScope.accountId);
						else {
							accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
							accountManager.setAccountEnabled(refreshed.account.index, false);
						}
					});
					const alreadyRestricted = state.activeAccountManager === accountManager &&
						accountManager.getAccountByIndex(refreshed.account.index) === refreshed.account &&
						refreshed.account.recordId === binding.recordId && refreshed.account.access === binding.accessToken &&
						refreshed.account.refreshToken === binding.refreshToken &&
						(refreshed.account.enabled === false || refreshed.account.workspaces?.some(workspace => workspace.id === binding.accountId && workspace.enabled === false));
					if (!restricted && !alreadyRestricted) {
						res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));
						res.end(bodyText);
						await usageRecorder.record({outcome: "failure", statusCode: upstream.status, errorCode, account: refreshed.account});
						return;
					}
     if(requestScope && refreshed.account.workspaces?.length) {
      pendingScopes?.shift();
      if(pendingScopes?.length) attemptedIndexes.delete(refreshed.account.index);
      else policyDecision?.blockedAccountIndexes.add(refreshed.account.index);
      state.status.retries++;noteRotation();continue;
     }
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					exhaustionReason = "deactivated";
					capabilityRejectionIsLatest = false;
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
				const bodyText = await readUpstreamErrorBody();
				const invalidated = isTokenInvalidationError(bodyText);
				const restricted = await applyDispatchRestriction(state, binding, () => {
					accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
					if (invalidated) accountManager.markAuthInvalidated(refreshed.account, extractErrorCodeFromBody(bodyText) ?? "token_invalidated", undefined, refreshed.accessToken);
					applyMonotonicAuthCooldown(accountManager, refreshed.account, invalidated ? state.tokenInvalidationCooldownMs : DEFAULT_AUTH_FAILURE_COOLDOWN_MS, binding);
				});
				if (!restricted) {
					res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));
					res.end(invalidated ? buildTokenInvalidationBody(bodyText) : bodyText);
					await usageRecorder.record({outcome: "failure", statusCode: upstream.status, errorCode: extractErrorCodeFromBody(bodyText), account: refreshed.account});
					return;
				}
				if (invalidated) {
					// The upstream explicitly revoked this OAuth token. Applying a long
					// cooldown prevents cascade invalidation: rapidly presenting each
					// account's token from the same IP triggers OpenAI's anti-abuse
					// detection and invalidates them in sequence. Return the 401 directly
					// rather than rotating so the client can prompt for re-login.
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
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

				exhaustionReason = "auth-failure";
				capabilityRejectionIsLatest = false;
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
				const bodyText = await readUpstreamErrorBody();
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
				await applyDispatchRestriction(state, binding, () => {
					accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
					accountManager.markAccountCoolingDown(
						refreshed.account,
						state.serverErrorCooldownMs,
						"server-error",
					);
				});

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

			} catch (error) {captureRestrictionFailure(error);}

			if (restrictionFailure && isThreadGoalRequest && upstream.status >= 400) {
				const bodyText = await readUpstreamErrorBody();
				const usage = extractResponsesUsage(parseRequestBody(Buffer.from(bodyText)));
				await usageRecorder.record({outcome: "failure", statusCode: upstream.status, errorCode: extractErrorCodeFromBody(bodyText) ?? "thread_goal_upstream_error", account: refreshed.account, ...(usage ?? {})});
				if (context.upstreamPath.endsWith("/get")) {
					writeJson(res, HTTP_STATUS.OK, {goal: context.sessionKey ? getThreadGoalFallback(state.threadGoalFallbacks, context.sessionKey) : null});
				} else if (isThreadGoalFallbackStatus(upstream.status) && context.sessionKey) {
					const parsedBody = parseRequestBody(context.body);
					const goal = typeof parsedBody?.goal === "string" ? parsedBody.goal : null;
					setThreadGoalFallback(state.threadGoalFallbacks, context.sessionKey, goal);
					writeJson(res, HTTP_STATUS.OK, {ok: true, goal});
				} else {
					res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));
					res.end(bodyText);
				}
				throw restrictionFailure.error;
			}

			// A successful request proves the account is usable, so clear any
			// stale runtime skip reason persisted for it on a prior pool
			// exhaustion. Without this the overlay reason (e.g. "token-exhausted",
			// "rate-limited") lingers on disk until an explicit runtime reset and
			// the forecast keeps reporting this working account as unavailable.
			// No-op when no reason is recorded, so the hot path stays write-free.
			const quotaDeferral = state.preemptiveQuotaScheduler.getDeferral(
				quotaScheduleKey,
				state.now(),
				quotaReceiptOwner(binding),
				state.nativeOpenai ? currentQuotaScope() ?? null : undefined,
			);
			const nearExhaustionWaitMs = quotaDeferral.defer
				? quotaDeferral.waitMs
				: 0;
			if (!restrictionFailure && nearExhaustionWaitMs > 0) {
				await applyDispatchRestriction(state, binding, () => {
					if (!quotaScopeKey) accountManager.markRateLimitedWithReason(
						refreshed.account,
						nearExhaustionWaitMs,
						context.family,
						"quota",
						context.model,
					);
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
				}).catch(captureRestrictionFailure);
			} else if (!restrictionFailure) {
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
			if (!restrictionFailure) await persistRuntimeActiveAccount(
				accountManager,
				refreshed.account,
				context.family,
				isPinned && refreshed.account.index === pinnedIndex,
				state.schedulingStrategy,
				state.nativeOpenai,
			).catch(captureRestrictionFailure);

			// Recover the upstream token counts as the body streams past. Without
			// them every ledger row lands with all-zero tokens and a zero cost, so
			// evaluateBudgetGuard compares `0 >= limit` for maxTokens/maxCostUsd
			// and those caps never fire — `budget set --cost 50` would allow
			// unlimited spend, with only --requests actually enforced.
			const responseOutcome = new ResponseOutcome(isResponsesRequest && upstream.headers.get("content-type")?.includes("text/event-stream") === true);
			let responseRestriction: Promise<boolean> | undefined;
			const nativeSent = state.webSocketRequestSent?.() === true;
			const nativeTerminal: {event: WebSocketTerminalEvent | null} = {event: null};
			const usageScanner = createUsageStreamScanner({
				contentType: upstream.headers.get("content-type"),
				onEvent: (event) => {
					responseOutcome.observe(event);
					if (nativeSent) {
						nativeTerminal.event ??= websocketTerminalUsage(Buffer.from(JSON.stringify(event)));
						const terminal = nativeTerminal.event;
						if (terminal?.record.outcome === "failure") {
							responseRestriction ??= (async () => {
								const status = terminal.record.statusCode;
								if (typeof status !== "number" || isModelAtCapacityError(status, terminal.rawBody)) return false;
								if (status === 429) {
									const retryAfterMs = (terminal.retryHeaders ? parseRetryAfterHeaderMs(terminal.retryHeaders, state.now()) : null) ?? terminal.retryAfterMs ?? parseRetryAfterBodyMs(terminal.rawBody, state.now()) ?? 60_000;
									if (quotaScopeKey) await observeQuota({status: 429, updatedAt: state.now(), primary: {usedPercent: 100, resetAtMs: state.now() + retryAfterMs}, secondary: {}});
									return applyDispatchRestriction(state, binding, () => {
										accountManager.recordRateLimit(refreshed.account, context.family, context.model);
										if (!quotaScopeKey || !refreshed.account.workspaces?.length) {
											state.preemptiveQuotaScheduler.markRateLimited(quotaScheduleKey, retryAfterMs, state.now());
											accountManager.markRateLimitedWithReason(refreshed.account, retryAfterMs, context.family, "quota", context.model);
										}
									});
								}
								return applyDispatchRestriction(state, binding, () => {
									if (status === 401) {
										accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
										if (terminal.tokenInvalidated) accountManager.markAuthInvalidated(refreshed.account, "token_invalidated", undefined, binding.accessToken);
										applyMonotonicAuthCooldown(accountManager, refreshed.account, terminal.tokenInvalidated ? state.tokenInvalidationCooldownMs : DEFAULT_AUTH_FAILURE_COOLDOWN_MS, binding);
									} else if ((status === 402 || status === 403) && isWorkspaceDisabledError(status, terminal.record.errorCode, terminal.errorMessage ?? "")) {
										if (requestScope && refreshed.account.workspaces?.length) accountManager.disableWorkspace(refreshed.account, requestScope.accountId);
										else {
											accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
											accountManager.setAccountEnabled(refreshed.account.index, false);
										}
									} else if (status >= 500) {
										accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
										accountManager.markAccountCoolingDown(refreshed.account, state.serverErrorCooldownMs, "server-error");
									}
								});
							})();
							void responseRestriction.catch(captureRestrictionFailure);
						}
					} else if (isResponsesTokenInvalidationEvent(event)) {
						responseRestriction ??= applyDispatchRestriction(state, binding, () => {
							accountManager.markAuthInvalidated(refreshed.account, "token_invalidated", undefined, binding.accessToken);
							accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
							applyMonotonicAuthCooldown(accountManager, refreshed.account, state.tokenInvalidationCooldownMs, binding);
							state.sessionAffinityStore?.forgetSession(context.sessionKey);
						});
						void responseRestriction.catch(captureRestrictionFailure);
					}
					const snapshot = readSubscriptionQuotaEvent(event, state.now());
					if (!snapshot) return;
					void observeQuota(snapshot, snapshot.planType).catch(captureRestrictionFailure);
					state.status.streamQuotaUpdates = (state.status.streamQuotaUpdates ?? 0) + 1;
					state.status.lastStreamQuotaUpdateAt = snapshot.updatedAt;
				},
			});
			let streamErrored = false;
			const forwarded = await forwardStreamingResponse(
				upstream,
				res,
				state.status,
				() => {
					streamErrored = true;
					// Deliberately NOT the pre-header transport policy above,
					// which skips recordFailure (#677). By this point the
					// upstream accepted the request and began responding, so a
					// broken stream is a signal about THIS account's session
					// (upstream tearing it down) rather than about the shared
					// network path, and it should still credit the breaker.
					responseRestriction = (responseRestriction ?? Promise.resolve(true)).then(() => applyDispatchRestriction(state, binding, () => {
						accountManager.recordFailure(refreshed.account, context.family, context.model, circuitAdmission);
						accountManager.markAccountCoolingDown(refreshed.account, state.networkErrorCooldownMs, "network-error");
						state.sessionAffinityStore?.forgetSession(context.sessionKey);
					}));
					return responseRestriction.then(() => undefined, captureRestrictionFailure);
				},
				state.streamStallTimeoutMs,
				usageScanner.push,
				{...(budgetAdvisory.level === "soft" ? buildContextBudgetHeaders(budgetAdvisory) : {}),...(state.catalogEtag ? {"x-models-etag":state.catalogEtag} : {})},
				() => {usageScanner.result();return responseOutcome.finish();},
			);
			await Promise.all([responseRestriction?.catch(captureRestrictionFailure), quotaUpdate?.catch(captureRestrictionFailure)]);
			// The client went away mid-stream: no upstream error, and the response was
			// neither completed nor failed. That says nothing about the account.
			const clientDisconnected = !forwarded && !streamErrored && !res.writableEnded;
			const completion = responseOutcome.finish();
			if (forwarded && upstream.ok && !restrictionFailure) {
				if (isDispatchBindingCurrent(state, binding)) {
					accountManager.recordSuccess(refreshed.account, context.family, context.model, circuitAdmission);
					recordRuntimeAccountRecovery(refreshed.account.index);
				}
			} else if (!clientDisconnected) {
				state.sessionAffinityStore?.forgetSession(context.sessionKey);
				const rejection = classifyCapabilityFailure(400, responseOutcome.rejection);
				if (rejection && context.model) {
					const body = parseRequestBody(context.body);
					const effort = isRecord(body?.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
					const tier = typeof body?.service_tier === "string" ? body.service_tier : undefined;
					(state.capabilityFailures ??= new RuntimeCapabilityFailures(state.now)).record(submittedCapabilityKey, context.model, rejection, effort, tier);
				}
			}
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
				outcome: forwarded && upstream.ok ? "success" : clientDisconnected || completion.outcome === "cancelled" ? "cancelled" : "failure",
				statusCode: nativeTerminal.event?.record.statusCode ?? upstream.status,
				errorCode: clientDisconnected ? "client_disconnected" : nativeTerminal.event?.record.errorCode ?? completion.errorCode ?? (forwarded ? null : "stream_forward_failed"),
				account: refreshed.account,
				...(usageTokens ?? {}),
			});
			if (restrictionFailure) throw restrictionFailure.error;
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
				account: transportFailureAccount,
			});
			writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, { error: errorBody });
			return;
		}

		// Forward the upstream capability rejection only when it is what ended the
		// request; a later 429/5xx/transport failure reports itself instead.
		if (lastCapabilityRejection && capabilityRejectionIsLatest && !isThreadGoalRequest) {
			await forwardCapabilityRejection(lastCapabilityRejection);
			return;
		}
		await usageRecorder?.record({
			outcome: "failure",
			statusCode: normalizeExhaustionStatus(exhaustionReason),
			errorCode: isThreadGoalRequest && context.upstreamPath.endsWith("/get") ? "thread_goal_pool_exhausted" : exhaustionReason,
			account: transportFailureAccount,
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
		if (error instanceof ClientCancellationError || (res.destroyed && !res.writableEnded)) {
			await usageRecorder?.record({outcome: "cancelled", statusCode: null, errorCode: "client_cancelled"});
			if (!res.destroyed) res.destroy();
			return;
		}
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
	} finally {
		if (res.destroyed && !res.writableEnded) await usageRecorder?.record({outcome: "cancelled", statusCode: null, errorCode: "client_cancelled"});
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
