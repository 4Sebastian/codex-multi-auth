# codex-multi-auth Architecture

How `codex-multi-auth` fits around the official Codex CLI: which binaries exist, what each one does, how a forwarded request travels through the loopback rotation proxy to a managed account, and where state lives.

For the maintainer-level module map, see [development/ARCHITECTURE.md](development/ARCHITECTURE.md).

---

## The Short Version

`codex-multi-auth` is a multi-account OAuth manager for the official `@openai/codex` CLI. It keeps a pool of ChatGPT-backed Codex accounts on disk, picks the healthiest one for each request, and keeps the official CLI in charge of everything else.

- `codex-multi-auth ...` runs the local account manager (login, switch, health, repair, governance).
- `codex-multi-auth-codex ...` is the opt-in forwarding wrapper: `auth ...` commands stay local, everything else is forwarded to the official Codex CLI with runtime rotation applied.
- `mcodex ...` is a convenience launcher over that same wrapper.
- The package does **not** publish a global `codex` binary; that name stays owned by the official Codex install.
- Runtime rotation is **default-on**: request-bearing sessions launched through the wrapper (or the packaged-app bind) send Responses traffic through a localhost-only proxy that selects a managed account per request.
- All state — accounts, settings, quota cache, usage ledger, policies, backups — lives under `~/.codex/multi-auth`. Official Codex state stays under `~/.codex`.

---

## Published Binaries

`package.json` publishes four bins:

| Binary | Script | Role |
| --- | --- | --- |
| `codex-multi-auth` | `scripts/codex-multi-auth.js` | Account manager only. Bare subcommands normalize to `auth` subcommands, so `codex-multi-auth status` and `codex-multi-auth auth status` are the same call. |
| `codex-multi-auth-codex` | `scripts/codex.js` | Wrapper/forwarder. `auth ...` runs locally; every other command resolves the real official Codex binary and forwards to it, with runtime rotation wired in when enabled. |
| `mcodex` | `scripts/mcodex.js` | Convenience launcher. Forwards to `codex.js`; adds `--monitor` (watch `codex-multi-auth list`) and `--tmux` / `-t` session helpers. Contains no account logic. |
| `codex-multi-auth-app-launcher` | `scripts/codex-app-launcher.js` | OS-level launcher routing: retargets supported user-level shortcuts or installs a managed wrapper app. |

A fifth shipped script, `scripts/codex-app-router.js`, is the persistent localhost router used by the packaged-app bind — it is spawned, not a bin.

---

## The Request Path, End to End

The default rotation path for a forwarded request-bearing command (for example `codex-multi-auth-codex exec "…"`):

```text
You
 |
 | codex-multi-auth-codex exec "..."      (or mcodex, or the bound Codex app)
 v
scripts/codex.js  ─── auth ...? ──yes──> local account manager (lib/codex-manager.ts)
 |
 | no: resolve official Codex binary
 | build shadow CODEX_HOME (or canonical home + -c overrides for TUI/resume/app-server)
 | model_provider = "codex-multi-auth-runtime-proxy", base_url = http://127.0.0.1:<port>
 | inject per-launch client key via OPENAI_API_KEY
 v
Official Codex CLI ──POST /responses──>
 |
 v
Runtime rotation proxy (loopback only)
 |
 | 1. authenticate client (per-launch key, timing-safe compare)
 | 2. gate method/path/body (Responses, models, images, thread-goal only)
 | 3. evaluateRuntimePolicy: model allow/deny, budgets, pause/drain, tags
 | 4. choose account: pin → priority → sequential|affinity → hybrid → scan
 | 5. refresh access token if inside the 60s skew window
 | 6. forward upstream (redirects never followed)
 | 7. on retryable failure mark + rotate to next eligible account
 v
https://chatgpt.com/backend-api (official upstream)
 |
 | stream back: strip hop-by-hop + private headers, scan usage, record ledger row
 v
Your terminal
```

Details worth knowing:

- **Loopback only.** The proxy refuses non-loopback binds and authenticates every request with a random per-launch key. Your account tokens are injected upstream; they never appear in client-facing responses.
- **Auth before routing.** An unauthenticated request gets `401 runtime_rotation_proxy_unauthorized` before the path is even inspected.
- **Redirects are never followed** (`redirect: "error"`), so a Bearer token cannot be exfiltrated to a redirected host.
- **Failure is never a silent hang.** Transient failures rotate to another account; true exhaustion returns `503 codex_runtime_rotation_pool_exhausted` with per-account skip reasons and `retry_after_ms`, and points at `codex-multi-auth rotation status`.
- **Two homes.** Non-interactive commands get a throwaway shadow `CODEX_HOME` (state synced back on exit). Interactive TUI, `resume`/`fork`, and `app-server` run against the canonical `CODEX_HOME` with the provider injected as `-c` overrides, so session history is not copied and reindexed on every launch. `codex app` also gets a shadow home through the app-helper context unless `CODEX_MULTI_AUTH_APP_ROTATION_USE_CANONICAL_HOME=1`.
- **Opt-out.** `codex-multi-auth rotation disable` or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` returns to plain forwarding.

### Account selection, in one breath

Per request the proxy tries, in order: a soft pin left by `codex-multi-auth switch`, policy priority tiers (lower `account priority` numbers first), a hard pin from `--account`/`CODEX_MULTI_AUTH_FORCE_ACCOUNT`, the sequential stick-until-exhausted cursor, session affinity (20-minute sticky sessions), a hybrid score (`health*2 + tokens*5 + hoursSinceUsed*2 + capability boost`), and finally a linear scan. An account is skipped when it is disabled, workspace-disabled, token-invalid, rate-limited, cooling down, or has an open circuit breaker. Equal hybrid scores use the committed rotation cursor as the tie-breaker, so concurrent selections in the same clock tick do not repeatedly choose the first stored account.

HTTP and WebSocket requests retain their circuit admission receipt through completion. A success or failure from an older circuit epoch cannot settle a newer half-open probe. Successful completion also checks the submitted account credential binding before healing account health. Capability denials learned from HTTP errors or SSE terminal errors use a hashed key of the submitted workspace, access token, refresh token and expiry. Routing reads that evidence for the current credential generation. A delayed denial from an older generation cannot restrict replacement credentials, while denial for the unchanged generation still blocks repeated sends. The cache retains its existing size and expiry bounds.

Quota headers and stream events may supply primary, secondary and plan fields independently. Shared quota observations preserve the latest supplied field in receipt order, including equal-clock events and transactions that finish out of order. A response carries only unconsumed deltas, so unrelated partial updates cannot erase exhaustion or replay an older blocker. The credential-scoped worker consumes pending deltas even after an earlier write fails. Failed exhaustion remains scoped to the submitted credentials through its reset window; a settled newer healthy observation can replace it. Terminal accounting retains the original persistence error without losing the upstream outcome or billed usage. Native admission evaluates the selected workspace's baseline and failed receipts, not a sibling's shared account/model snapshot. Workspace-local exhaustion and 429 responses do not create account-wide restrictions that bench eligible siblings; legacy accounts without workspace records retain their account-wide 429 restriction.

Terminal usage remains attributed to the submitted account even when its circuit receipt is no longer current. After an upstream stream error, the forwarding boundary awaits the credential-scoped failure restriction before exposing the broken body to the client. Restriction-write failure still closes the body and records the original terminal usage before propagating the persistence error. The custom socket closes on that error rather than draining queued work, and subsequent admission continues to reject unreadable journal authority.

---

## Components

### 1. Account manager

`codex-multi-auth <command>` dispatches to `lib/codex-manager.ts` + `lib/codex-manager/commands/`:

| Area | Commands |
| --- | --- |
| Accounts | `login`, `list`, `status`, `switch <index>`, `unpin`, `workspace` |
| Health / selection | `check`, `forecast`, `best`, `report`, `why-selected` |
| Repair | `fix`, `doctor`, `verify`, `verify-flagged` |
| Rotation | `rotation status\|enable\|disable\|bind-app\|unbind-app\|reset-runtime` |
| Governance | `usage`, `budget`, `account` (tag/weight/priority/pause/drain/note), `models`, `monitor` |
| Bridge / integrations | `bridge token …`, `integrations` |
| Sessions / config | `history`, `config explain`, `init-config`, `debug bundle`, `uninstall` |

On an interactive terminal with a populated pool, bare `codex-multi-auth login` opens the dashboard instead of a bare sign-in; `--device-auth` covers headless/remote logins, and `--manual`/`--no-browser` prints a paste-back flow. The OAuth callback server binds port `1455` on both `::1` and `127.0.0.1` — the registered redirect URI is fixed, so a conflict on either family is fatal rather than silently degraded.

### 2. Wrapper and shadow `CODEX_HOME`

`codex-multi-auth-codex` resolves the real official Codex binary (env override → installed package → global npm root → `PATH`), then:

- reconciles `cli_auth_credentials_store = "file"` in `~/.codex/config.toml` so forwarded sessions use file-backed auth (opt out with `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0`),
- resolves an ephemeral `--account <index|email|id>` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT` pin (never mutates the persisted `switch` pin),
- starts the loopback rotation proxy and points the Codex provider config at it,
- spawns official Codex (with bounded retries and an unsupported-model fallback chain), and
- syncs refreshed official state back out of the shadow home on exit.

Stale-home sweeps require affirmative evidence that both the recorded wrapper and child have stopped. Missing, corrupt or unreadable ownership markers, unknown process identity, and wrapper-only markers retain the home regardless of directory age. Failure to record a spawned child must not authorize deletion of its unsynced state. The launching wrapper still synchronizes its own state before cleanup.

### 3. Runtime rotation proxy

`lib/runtime-rotation-proxy.ts`, provider id `codex-multi-auth-runtime-proxy`. It forwards only these routes: `POST /responses` (+ `/codex/`, `/v1/` aliases), `GET /models` (+ `/v1`), [image generation/edit routes](reference/image-routes.md), and `GET|POST /thread/goal/*`. Everything else is a 404. Bodies are capped at 64 MiB; gzip/deflate/br/zstd request encodings are decoded.

Per request it applies policy before picking an account, refreshes tokens through a deduplicating queue (one in-flight refresh per token, cross-process leases so two CLIs do not double-refresh), classifies upstream responses into rotation marks (rate-limit, cooldown, circuit breaker, workspace disable, token invalidation), and streams successful bytes back with stall detection and backpressure. Runtime counters land in `runtime-observability.json` for `status`, `report`, `monitor`, `rotation status`, and `why-selected`.

The local Pi integration also accepts authenticated WebSocket upgrades on the Responses routes. Custom-provider sockets keep their upstream account until it becomes unavailable, using drain-first selection independently of HTTP scheduling. Each `response.create` rechecks policy, circuit-breaker admission, and the optional context budget guard, and records normalized usage including reasoning tokens and service tier. Lost connection-scoped continuations return `previous_response_not_found` so the client can resend complete context. Native OpenAI sockets instead use `lib/runtime/responses-websocket.ts` and the native HTTP routing boundary, including workspace capabilities and explicit API/ZDR pools. Only one transport handles each upgrade.

Runtime admission does not impose a synthetic requests-per-minute cap. Upstream quota responses, cooldowns, account policies, and circuit breakers still apply. Explicit recovery requires successful refresh or a completed live response probe. A later JWT timestamp alone does not clear revocation, and quota headers on a 401 do not prove recovery.

HTTP dispatch and each WebSocket create require a readable pending-auth journal. An unreadable or corrupt journal denies dispatch rather than trusting cached credentials. A request binds its manager, record generation, credential, expiry, and workspace; dispatch checks that binding again after asynchronous preparation. Native WebSocket creates and API/ZDR HTTP fallback re-enter request-local routing authorization after the upstream handshake. A rejected native handshake retains only recognized workspace, model or setting decision codes and the required setting parameter. Its bounded diagnostic body is never forwarded; unknown or malformed decisions remain generic. Eligible siblings can recover before any upstream create, without HTTP replay. Custom sockets validate their original credential and workspace on later turns, replacing stale idle bindings only for requests without connection-scoped continuations. Circuit admission receipts identify the breaker and its epoch: a genuine half-open probe retains its slot, but an earlier closed-state admission cannot borrow another request's probe. Native primary reconciliation and journal eligibility also reject replaced credentials and foreign or deleted manager members. Native routing permits up to 30 seconds of primary-file availability grace for independently authenticated clients, but still reconciles the journal on every read. The grace uses a monotonic clock, never extends on failed reads, and cannot authenticate a managed bearer.

### 4. Local governance

File-backed, local-only, and enforced on the rotation path by `evaluateRuntimePolicy` (`lib/policy/runtime-policy.ts`):

| Concern | Storage under `~/.codex/multi-auth` | CLI |
| --- | --- | --- |
| Usage ledger | `usage/usage-ledger.jsonl` (+ rotated archives) | `codex-multi-auth usage` |
| Budget guards | `budget-guards.json` | `codex-multi-auth budget` |
| Account policy (tags, weight, priority, pause/drain, notes) | `account-policies.json` | `codex-multi-auth account …` |
| Routing profiles (per-project allow/deny, tag weights, budget key) | `routing-profiles.json` | file-only writes; `monitor` reads |
| Quota snapshots | `quota-cache.json` | `limits`, `check`, `forecast --live`, `report` |
| Operator view | runtime observability + all of the above | `codex-multi-auth monitor` |

Actual-send governance reads distinguish absent policy stores from malformed or unreadable authority. Account policies, budget guards and routing profiles use strict observation at this boundary; failures deny dispatch rather than supplying empty defaults. Cached reads require a stable file revision. Project revision watches stop at the established Git root, but still observe lower markers and all ancestors when no Git boundary exists.

Budgets are **advisory**: evaluations read a pre-request ledger snapshot, so racing requests can briefly overshoot a limit. Ledger rows are redacted — hashed account identity and request metadata, never prompts or credentials.

### 5. Local bridge (optional)

`lib/local-bridge.ts` exposes a loopback-only OpenAI-compatible surface (`/health`, `/v1/models`, `/v1/responses`) that forwards to a runtime proxy base URL. Client tokens are `cma_local_*` values; only SHA-256 hashes and prefixes are stored in `local-client-tokens.json`, and the plaintext is shown once at `codex-multi-auth bridge token create|rotate`.

### 6. Storage and project pools

Account storage uses the V3 format (`AccountStorageV3`) under the multi-auth root:

- Global pool: `~/.codex/multi-auth/openai-codex-accounts.json`
- Per-project pools: `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`, keyed by repo identity root so linked Git worktrees share one pool
- Durability: write-ahead journal (`.wal`), temp-file-then-rename writes `0600`, and a throttled `.bak`/`.bak.1`/`.bak.2` rotation, plus named backups under `backups/`
- Recovery: flagged-account sidecar (`openai-codex-flagged-accounts.json`), pending-auth journal, and `verify`/`fix`/`doctor` repair commands. Journal retention scans every predecessor that a recovery loader can restore, including flagged `.bak`, `.bak.1`, and `.bak.2` files.

Refresh admission holds the existing pool and journal locks, in that order, from before OAuth refresh until the returned credentials are journaled. A post-refresh settlement failure retains the new credential and original persistence error without publishing a successful lease or treating the failure as authentication refusal. The shared queue keeps at most 1,000 unsettled owners without age eviction; calls using either the spent token or its replacement retry persistence, not OAuth. Callers retain token material only on the captured live binding, without clearing restrictions or healing health. This protects a running process, not the gap between remote acceptance and local receipt or survival across a process crash.

Delayed refusals and authentication cooldowns may restrict only their submitted record, credential pair, expiry, and workspace. The account storage transaction verifies current durable credentials and expiry, then rechecks the live binding after journal observation before applying those restrictions, so an older response cannot disable a recovery committed by another manager. New custom HTTP requests reconcile durable credentials before selection; the final send still validates its captured binding. A changed authority file permits at most one complete revalidation, not a binding replacement. Continued changes fail closed. A known runtime blocker may select another account only before dispatch authorization and before any WebSocket send; it cannot replay an authorized request. A memory-only refresh still honors newly observed primary revocation, while an unchanged pre-recovery marker does not revoke its replacement again. Proxy catalog discovery also consumes the shared validator's runtime rejection before sending an authenticated request. Standalone OAuth discovery rejects invalidation, cooldown and quota restrictions, then rechecks durable record, credential, expiry, workspace and journal authority after token preparation and immediately before its catalog GET.

Capability probe revocation affects only evidence attributable to the failing credential. Invalidated evidence carries the loss observation timestamp through export and persisted merges. The private probe cache also records the loss barrier observed by each generation. Under its existing file transaction, a late writer that did not observe a newer credential loss cannot republish earlier verification merely because its inconclusive probes finished later. Owner-loss authority survives model and credential-group eviction in the existing private store and in-memory reader. Its independent 1,000-owner bound rejects overflow without replacing committed authority; loss barriers do not expire with model cache entries. Reloaded caches restore that barrier, and the publishing caller renders the accepted cache results without additional provider requests. A missing accepted result strips inherited probe verification and tiers while preserving documented capabilities. An explicit forced check starts a fresh probe generation, even when an earlier healthy batch is still in flight. Retired batches cannot borrow or mutate a newer generation's cached evidence after delayed documentation reads, reuse denied in-flight results, or revive late successes from that generation. Independent imported credentials and documented capabilities remain intact.

Durable cooldowns and quota reset times reconcile even when credentials and expiry are unchanged. The runtime compares each observed primary snapshot with local observations, preserving concurrent restrictions while honoring explicit clears. Replaying a journal self-mapping does not clear a later current-primary authentication cooldown; credential replacement or verified historical recovery may clear an obsolete one.

Each credential rotation advances every retained predecessor to the newest credential. Pruning retains predecessors that backups or the WAL can restore. Only verified primary saves establish committed recovery authorization. Unchanged aliases preserve that authorization, while current primary disablement and revocation remain authoritative.

The active selection is mirrored into the official `~/.codex/auth.json` / `accounts.json` so plain forwarded Codex commands keep the intended account.

### 7. Reversible packaged-app bind

`codex-multi-auth rotation bind-app` backs up the real `~/.codex/config.toml`, points the packaged Codex desktop app at a persistent localhost router (`scripts/codex-app-router.js`), and installs a user-level startup entry. `rotation unbind-app` / `rotation disable` restores the backup. Official app binaries are never patched.

### 8. Lazy first-run setup

`npm` postinstall is notice-only. On the first `codex-multi-auth` invocation from a durable global install, `lib/runtime/first-run.ts` claims `first-run-setup.json` once and runs three best-effort steps: app bind, launcher install, and the `cli_auth_credentials_store` pin. Skipped under CI, `npx`, and project-local installs; failures never block the command.

### 9. Plugin-host entry (compatibility)

The package root still exports a plugin-host runtime (`index.ts`) for hosts that load plugins: it reuses the same pool, refresh queue, request transformer, and policy evaluation. Normal `codex-multi-auth ...` use does not require it.

---

## Design Constraints

- The official OAuth flow remains the source of authentication; the callback port stays `1455`.
- The canonical command family is `codex-multi-auth ...`; no global `codex` bin is published.
- Runtime rotation is default-on, loopback-only, and authenticated with a per-launch client key.
- Proxied Responses requests are forced to `stream: true` and `store: false` (stateless compatibility), with `reasoning.encrypted_content` included, unless background-response compatibility is explicitly enabled.
- Credentials and governance state stay local under `~/.codex/multi-auth`.
- The desktop app bind is reversible and does not patch official app files.
- Default general model routing uses `gpt-6.1-sol`; diagnostic live/quota probes lead with `gpt-5.6-sol`.

---

## Related

- [getting-started.md](getting-started.md)
- [features.md](features.md)
- [configuration.md](configuration.md)
- [faq.md](faq.md)
- [reference/commands.md](reference/commands.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
