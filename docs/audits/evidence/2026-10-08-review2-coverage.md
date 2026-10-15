# Integration review continuation

## Current fix continuation: b72a23a4

Committed head: b72a23a4f1403eca719b5c7b479649b6c522ef31. Historical base remains 5735e20936e561938c8423bcb615f3df66df8bb9. This section supersedes the older working-diff binding and coverage inventory below; older inspection notes and verification are historical context, not new independent review.

Verified tracked source/test diff SHA-256 (report excluded): f5a16d91aa4b2f37f5e764f299c9428f273c6f347b3695dcf47d6813d57e5416.
New untracked behavioral test `test/api-catalog-authority.test.ts` SHA-256: c152c87f93269abf08403a10f9970e4f0998a7a249e5dc1cbc5dd4f75c0414c4.

### Validated invariants and changes

- R1/R2 and review-1/review-2 remain binding. The focused run includes their authorization, nine-probe, receipt-release, model-identity pricing and budget regressions. Passing these tests is not independent approval.
- General catalog authority now captures the original source root/path, id, kind, key and enabled state before waits. Paid probes additionally require original/current explicit consent. The source binding is retained from the start of route loading, including when the ambient source changes before catalog capture.
- The same bounded, schema-validated route check supplies synchronous live proof at queued GET sends, response acceptance, cached results, statuses, enrichment and publication. Missing proof is denied. Each check reads at most 1 MiB plus an overflow sentinel and closes its handle. Observed denial stays denied; an unchanged or metadata-only rewrite does not itself revoke an otherwise unchanged route.
- Discovery metadata updates capture authority before their serialized queue and check again immediately before synchronous atomic rename. Existing expected-configuration and lock checks remain. No replacement key/source is adopted.
- Background enrichment retains the existing paid-evidence proof while awaiting replacement proof; it does not temporarily replace a consent-bearing proof with general route authority. Existing paid metadata receives consent proof before becoming an intermediate cached snapshot.
- Standalone inventory and native picker/background/ETag publication carry the same general proof, independently of probe consent. Historical loaded inventory is not promoted to live permission. Probe withdrawal does not unnecessarily forbid a freshly fetched non-probing catalog, but cannot publish paid evidence.
- Explicit API/ZDR Fast aliases and equivalent body selections send `service_tier: "priority"`; upstream model, route/failure identity and `store:false` remain unchanged. The provider oracle rejects any non-Priority Fast wire tier.
- Automatic quota diagnostics check original submitted `expiresAt > Date.now()` inside each final locked send callback. Held prompt preparation and unsupported-model fallback cover expired, exact-boundary, missing and valid expiry. Settlement credential matching was not changed.
- Caller/failure-path retracing covered queued workers, non-OK responses, bounded body acceptance, persistence rejection, enrichment rejection, cache/status reads, inventory commit, native picker publication, API payload/failure keys, and automatic preparation/fallback admission. This is fixer self-review, not completion of the independent integration review.
- Fixtures now persist the routes they authorize, isolate per-test source roots, persist replacement credentials, and attach explicit proof to synthetic inventory-writer entries. Production defaults never use those fixture callbacks.

### Focused verification and limits

The final focused command selected these 20 suites: api-catalog-authority, api-probe-authorization, api-route-store, api-model-runtime, api-model-capabilities, model-discovery-status, automatic-subscription-checks, automatic-account-checks, quota-probe, usage-ledger, usage-pricing-coverage, usage-service-tier, budget-guard, model-route-policy, preemptive-quota-scheduler, index-retry, runtime-rotation-proxy, dispatch-authority, native-error-no-replay and native-journal-auth.integration.

- Initial execution: 1,599 passed and 18 failed. It exposed revision-only rejection of unchanged configuration as well as fixtures with non-durable route/key changes, cross-test source contamination, missing synthetic proof, an incorrect documentation-GET counter, and an overstrict withdrawn-consent status expectation.
- After corrections: all 20 files and 1,617 tests passed.
- Subsequent caller retracing found and removed an intermediate background proof downgrade while a replacement consent proof was awaiting resolution. Added an executable regression using a seeded paid catalog and a held authorization boundary.
- Final execution: exit 0, all 20 files and 1,618 tests passed, duration 66.81 seconds. No source or test changes followed that final run.
- `git diff --check` passed before the final report update; package.json and package-lock.json remain unchanged.
- No full repository tests/lint, typecheck, build, installed/global-linked build, personal-client/provider activity, subagents, publication or pipeline control were performed. Independent normal phases and installed-delivery acceptance remain outstanding.

### Independent review remains incomplete

The prior reassessment reported 76 of 508 committed paths substantively reviewed and 432 not reviewed. Five of those 76 have changed in this continuation and require independent re-review: `lib/api-route-store.ts`, `lib/runtime/api-model-runtime.ts`, `lib/runtime/automatic-subscription-checks.ts`, `lib/runtime/model-discovery-status.ts`, `test/automatic-subscription-checks.test.ts`. The added behavioral test also requires independent review. Thus 438 of the current 509 paths are explicitly awaiting independent coverage/reconciliation below. No independent coverage was added by this fixer, and these counts do not certify the other paths or waive exact-head reconciliation.

R3 and review-3 remain FIX, unresolved. The integration is not approved. No HIGH-to-PR escape, review waiver or replacement workflow is authorized. Only the original cancelled-terminal-usage-precedence and health-summary-revocation-exception warnings remain deferred; no new finding is deferred.

## Historical binding and decision


Run: 01M4YXD0G335FMKNZFTBGN47AQ

Reviewed committed head: 04a069154844ea2f413cd0d0f5bc3c7524751048

Historical base: 5735e20936e561938c8423bcb615f3df66df8bb9

Final verified working fix diff SHA-256: c70c26991fc922fbdcd0b8341809f0b0c01a407829ec15c8c0963ee5ae628369

The fingerprint covers pricing.ts and the four modified tests, not this report. Later source or test changes require reconciliation. Earlier round R1/R2 inspections are retained as context, not promoted to whole-file coverage from truncated excerpts.

R1/R2 and review-1/review-2 are fixes, not approvals. R3 remains FIX and incomplete. No whole-integration approval, coverage waiver, installed-build proof, independent review, push or publication is claimed. Only cancelled-terminal-usage-precedence and health-summary-revocation-exception remain the original deferred warnings.

## Substantive path inspection in this continuation

These notes record code inspection, not test results or acceptance of every connected subsystem.

### `lib/usage/pricing.ts`

Traced parsed upstream identity into exact own-property price lookup. Explicit API/ZDR identifiers avoid both OAuth replacement mechanisms; malformed routes remain null. Tier and long-context pricing still depend on extracted billed tier. Historical explicit costs are handled in redaction, not recomputed here.

### `lib/model-route-policy.ts`

Inspected complete parser, eligibility, union and entitlement filtering. Route and speed prefixes are single-use; nested prefixes reject. API visibility is explicit and optional settings require advertised support. Cross-credential metadata merging remains a separate integration acceptance concern.

### `lib/api-route-store.ts`

Inspected complete store, bounded read, schema, source annotation, captured probe authorization and optimistic discovery updates. Authority keeps original id/kind/key/consent rather than adopting replacement credentials. Actual send and publication callers were retraced. No provider activity performed.

### `lib/runtime/api-model-capabilities.ts`

Inspected complete documentation/probe/cache lifecycle. Six missing efforts plus compatibility and two tiers explain nine POSTs when low is documented. Every paid slot checks authorization; result/body/cache acceptance checks again. Local authority failure propagates without recording credential loss. Provider owner-loss and group retirement still clear verified results.

### `lib/runtime/api-model-runtime.ts`

Inspected complete discovery, enrich acceptance, snapshots, API payload, rejection classification and no-replay transport handling. Outbound explicit models use parsed upstreamModel unchanged; API requests force store:false. Cached snapshot publication proof is checked independently from route replacement. Request-time catalogs suppress billable capability enrichment.

### `lib/runtime/model-discovery-status.ts`

Inspected complete standalone discovery, probe persistence, inventory publication and formatting. Original API authorization is captured before async work; publication callbacks run again immediately before atomic rename. Persisted losses merge under file lock. OAuth entries use catalog authority; loaded historical inventory is not dispatch authority.

### `lib/preemptive-quota-scheduler.ts`

Inspected complete scheduler and receipt lifecycle. Empty reservations share an idempotent release marker across copies; epoch pending count protects other in-flight reservations. Deletion requires the same live epoch, no retained horizon, no owned fields and no signal. Independent field order, failed horizons and replacement epochs remain checked separately.

### `lib/runtime/native-account-storage.ts`

Inspected complete primary-only reader. Cache grace is bounded to transient permission/busy errors and cannot convert an unverified snapshot into send authority. Pending-auth and reset/source revisions are rechecked after waits. Malformed revocation evidence fails closed.

### `lib/runtime/native-account-sync.ts`

Inspected complete identity and sync logic with AccountManager excerpts. Stable record identity wins; anonymous fallback requires matching refresh token. Credentials, auth invalidation and runtime restrictions are adopted separately, with captured observation ordering. AccountManager as a whole remains unreviewed.

### `lib/runtime/responses-websocket.ts`

Inspected all 741 lines in three contiguous reads. Traced loopback authentication, cancellation generations, queue/session/history bounds, authorize-before-create/HTTP, handshake-only API fallback and sent-create no-replay handling. Output history is remembered only for completed responses. Runtime callers and full websocket test coverage remain separately open.

### `test/api-probe-authorization.test.ts`

Inspected complete behavioral matrix. Held docs and paid slots exercise disable/delete/rekey/kind/consent/unreadable/source changes; expected sends remain zero/four. Authorized control asserts six dedicated non-low effort requests and three low-bearing compatibility/tier requests. Held file write tests consent at final persisted publication.

## Partial inspections not counted as complete

- `index.ts`: receive/classify/settle paths around 1680-1875 and the attempt finally around 2450-2485; release encloses response/error returns. The rest of the 4,293-line plugin remains open.
- `lib/runtime-rotation-proxy.ts`: binding/rate-limit receipt completion around 1120-1200, native header receipts around 4435-4500, and stream completion/finally around 5135-5185; full 5,419-line runtime remains open, including native/custom socket callers and every terminal/ledger outcome.
- `lib/accounts.ts`: runtime gates, primary/journal readers, current-credential restrictions and persistence excerpts. These preserve credential/expiry/workspace matching across locked waits; complete selection, refresh and persistence interaction review remains open.
- `lib/storage.ts`, `lib/storage/pending-auth.ts`, `lib/storage/transactions.ts`, `lib/storage/recovery-credentials.ts`, `lib/storage/credential-sidecars.ts`, `lib/storage/file-lock.ts`, `lib/runtime/account-reset-credits.ts`, `lib/request/account-dispatch.ts`: earlier excerpt inspection is not counted as complete. The tentative transaction-context lifetime concern has not been established as a defect.
- `lib/usage/redaction.ts`, `lib/usage/ledger.ts`, `lib/budget-guard.ts`: traced token normalization, explicit historical costs and unknown-cost budget denial. Complete changed-area review of the budget store and all ledger callers remains open.
- Changed probe/runtime/usage tests and prior scheduler/plugin regressions have been inspected in relevant excerpts; except the complete authorization fixture above, whole test-file review remains open.

## Verification

Development dependencies were installed inside the worktree using the authorized `CI=1 npm ci --ignore-scripts`; the lockfile is unchanged. Prior fix-round test invocation failed before execution with `vitest: not found`.

Focused verification executed with:

```sh
npm test -- test/usage-ledger.test.ts test/usage-pricing-coverage.test.ts test/usage-service-tier.test.ts test/usage-extraction.test.ts test/usage-redaction.test.ts test/budget-guard.test.ts test/model-route-policy.test.ts test/api-probe-authorization.test.ts test/api-model-capabilities.test.ts test/api-model-runtime.test.ts test/api-route-store.test.ts test/model-discovery-status.test.ts test/preemptive-quota-scheduler.test.ts test/runtime-rotation-proxy.test.ts test/index-retry.test.ts
```

- First execution: exit 1; 1,083 passed, two failed. The late-writer rename fixture intercepted promises.rename while guarded publication commits with renameSync. The capacity-only fixture expected 503 although rate-limit exhaustion maps to 429. Neither failure required weakening production authority checks.
- Corrected the rename fault at the synchronous commit boundary and retained rejection plus persisted owner-loss assertions. Corrected the exact capacity status to 429 and added an assertion that account rate-limit state stays empty, retaining all scheduler resource assertions.
- Second execution: exit 1; 1,084 passed, one failed plus an unhandled assertion rejection. Native ESM exports cannot be spied on directly. Added a passthrough node:fs module mock so the existing real filesystem operations remain intact and the synchronous rename fault can be injected.
- Final execution: exit 0; all 15 files and all 1,085 tests passed, with no reported unhandled errors. Duration 31.97 seconds. This includes prior R1/R2 regressions, the nine-POST controls and real API-payload/ledger/budget matrix. No source or test changes followed this passing run.
- git diff --check passed. The lockfile is unchanged. No typecheck, build, full repository test or lint run was performed in this phase.

Full independent Test, Document, Lint and installed-delivery checks belong to their later phases. These focused results do not close R3.

## Exact paths awaiting independent review at this fix head

This current inventory replaces the historical 496-path list. It includes the 432 prior omissions, five changed previously reviewed paths, and the new behavioral test. Partial reads, focused test passes and this report are not independent coverage.

- `.bugsweep-index.md`
- `.bugsweep-transform.md`
- `.codex-plugin/plugin.json`
- `.github/pull_request_template.md`
- `.github/workflows/codeql.yml`
- `.gitignore`
- `.nvmrc`
- `AGENTS.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `README.md`
- `SECURITY.md`
- `config/README.md`
- `config/codex-legacy.json`
- `config/codex-modern.json`
- `config/minimal-codex.json`
- `docs/DOCUMENTATION.md`
- `docs/README.md`
- `docs/STYLE_GUIDE.md`
- `docs/_config.yml`
- `docs/architecture.md`
- `docs/audits/evidence/2026-10-08-review2-coverage.md`
- `docs/configuration.md`
- `docs/design/earned-reset-credits.md`
- `docs/design/model-route-pools-release.md`
- `docs/design/model-route-pools-review.md`
- `docs/design/model-route-pools.md`
- `docs/development/ARCHITECTURE.md`
- `docs/development/CONFIG_FIELDS.md`
- `docs/development/CONFIG_FLOW.md`
- `docs/development/CONTEXT_BUDGET_GUARD_PLAN.md`
- `docs/development/REPOSITORY_SCOPE.md`
- `docs/development/RUNBOOK_ADD_AUTH_COMMAND.md`
- `docs/development/RUNBOOK_ADD_AUTH_MANAGER_COMMAND.md`
- `docs/development/RUNBOOK_ADD_CONFIG_FIELD.md`
- `docs/development/RUNBOOK_ADD_CONFIG_FIELD_SAFELY.md`
- `docs/development/RUNBOOK_CHANGE_ROUTING_POLICY.md`
- `docs/development/RUNBOOK_CHANGE_ROUTING_POLICY_SAFELY.md`
- `docs/development/TESTING.md`
- `docs/development/TUI_PARITY_CHECKLIST.md`
- `docs/faq.md`
- `docs/features.md`
- `docs/getting-started.md`
- `docs/index.md`
- `docs/privacy.md`
- `docs/reference/commands.md`
- `docs/reference/error-contracts.md`
- `docs/reference/public-api.md`
- `docs/reference/settings.md`
- `docs/reference/storage-paths.md`
- `docs/releases/v0.1.7.md`
- `docs/releases/v0.1.8.md`
- `docs/releases/v0.1.9.md`
- `docs/releases/v1.1.10.md`
- `docs/releases/v1.1.11.md`
- `docs/releases/v1.2.0.md`
- `docs/releases/v1.2.1.md`
- `docs/releases/v1.2.2.md`
- `docs/releases/v1.2.4.md`
- `docs/releases/v1.2.5.md`
- `docs/releases/v1.2.6.md`
- `docs/releases/v1.2.7.md`
- `docs/releases/v1.3.0.md`
- `docs/releases/v1.3.1.md`
- `docs/releases/v1.3.2.md`
- `docs/releases/v2.0.0.md`
- `docs/releases/v2.0.1.md`
- `docs/releases/v2.0.2.md`
- `docs/releases/v2.1.0.md`
- `docs/releases/v2.1.1.md`
- `docs/releases/v2.1.10.md`
- `docs/releases/v2.1.12.md`
- `docs/releases/v2.1.13-beta.1.md`
- `docs/releases/v2.1.2.md`
- `docs/releases/v2.1.3.md`
- `docs/releases/v2.1.4.md`
- `docs/releases/v2.1.5.md`
- `docs/releases/v2.1.7.md`
- `docs/releases/v2.1.8.md`
- `docs/releases/v2.1.9.md`
- `docs/releases/v2.10.0.md`
- `docs/releases/v2.11.0.md`
- `docs/releases/v2.12.0.md`
- `docs/releases/v2.13.0.md`
- `docs/releases/v2.14.0.md`
- `docs/releases/v2.15.0.md`
- `docs/releases/v2.16.0.md`
- `docs/releases/v2.17.0.md`
- `docs/releases/v2.17.1.md`
- `docs/releases/v2.17.2.md`
- `docs/releases/v2.17.3.md`
- `docs/releases/v2.18.0.md`
- `docs/releases/v2.19.0.md`
- `docs/releases/v2.19.1.md`
- `docs/releases/v2.2.0.md`
- `docs/releases/v2.2.1.md`
- `docs/releases/v2.2.2.md`
- `docs/releases/v2.3.0-beta.0.md`
- `docs/releases/v2.3.0-beta.1.md`
- `docs/releases/v2.3.0-beta.2.md`
- `docs/releases/v2.3.0-beta.3.md`
- `docs/releases/v2.3.0.md`
- `docs/releases/v2.3.2.md`
- `docs/releases/v2.3.3.md`
- `docs/releases/v2.4.0.md`
- `docs/releases/v2.5.0.md`
- `docs/releases/v2.6.0.md`
- `docs/releases/v2.6.1.md`
- `docs/releases/v2.7.0.md`
- `docs/releases/v2.7.1.md`
- `docs/releases/v2.8.0.md`
- `docs/releases/v2.8.1.md`
- `docs/releases/v2.8.3.md`
- `docs/releases/v2.8.4.md`
- `docs/releases/v2.8.5.md`
- `docs/releases/v2.8.6.md`
- `docs/releases/v2.8.7.md`
- `docs/releases/v2.9.0.md`
- `docs/releases/v2.9.1.md`
- `docs/releases/v2.9.2.md`
- `docs/troubleshooting.md`
- `docs/upgrade.md`
- `eslint.config.js`
- `index.ts`
- `knip.jsonc`
- `lib/account-policy.ts`
- `lib/accounts.ts`
- `lib/api-route-store.ts`
- `lib/audit.ts`
- `lib/auth/account-access.ts`
- `lib/auth/auth.ts`
- `lib/auth/server.ts`
- `lib/auth/token-utils.ts`
- `lib/budget-guard.ts`
- `lib/circuit-breaker.ts`
- `lib/cli.ts`
- `lib/codex-cli/state.ts`
- `lib/codex-cli/writer.ts`
- `lib/codex-manager.ts`
- `lib/codex-manager/account-manager-commands.ts`
- `lib/codex-manager/account-pool-write.ts`
- `lib/codex-manager/active-account-sync.ts`
- `lib/codex-manager/api-login-menu.ts`
- `lib/codex-manager/commands/account.ts`
- `lib/codex-manager/commands/best.ts`
- `lib/codex-manager/commands/budget.ts`
- `lib/codex-manager/commands/check.ts`
- `lib/codex-manager/commands/forecast.ts`
- `lib/codex-manager/commands/history.ts`
- `lib/codex-manager/commands/report.ts`
- `lib/codex-manager/commands/resets.ts`
- `lib/codex-manager/commands/rotation.ts`
- `lib/codex-manager/commands/status.ts`
- `lib/codex-manager/dashboard-settings-data.ts`
- `lib/codex-manager/formatters/quota-formatters.ts`
- `lib/codex-manager/formatters/subscription-status.ts`
- `lib/codex-manager/formatters/text-style.ts`
- `lib/codex-manager/health-check.ts`
- `lib/codex-manager/help.ts`
- `lib/codex-manager/login-flow.ts`
- `lib/codex-manager/login-menu-data.ts`
- `lib/codex-manager/login-oauth.ts`
- `lib/codex-manager/login-workspace-choice.ts`
- `lib/codex-manager/persist-selected-account.ts`
- `lib/codex-manager/quota-cache-helpers.ts`
- `lib/codex-manager/repair-commands.ts`
- `lib/codex-manager/settings-hub/dashboard.ts`
- `lib/codex-manager/settings-panels.ts`
- `lib/codex-manager/theme-settings-panel.ts`
- `lib/config.ts`
- `lib/dashboard-settings.ts`
- `lib/local-bridge.ts`
- `lib/local-client-tokens.ts`
- `lib/logger.ts`
- `lib/oc-chatgpt-target-detection.ts`
- `lib/policy/runtime-policy-cache.ts`
- `lib/policy/runtime-policy.ts`
- `lib/proactive-refresh.ts`
- `lib/prompts/codex.ts`
- `lib/quota-cache.ts`
- `lib/quota-probe.ts`
- `lib/quota-readiness.ts`
- `lib/refresh-guardian.ts`
- `lib/refresh-queue.ts`
- `lib/request/error-classification.ts`
- `lib/request/fetch-helpers.ts`
- `lib/request/helpers/model-map.ts`
- `lib/request/helpers/tool-utils.ts`
- `lib/request/rate-limit-decision.ts`
- `lib/request/response-handler.ts`
- `lib/request/token-refresh.ts`
- `lib/rotation.ts`
- `lib/routing-profiles.ts`
- `lib/runtime-rotation-proxy.ts`
- `lib/runtime/account-check.ts`
- `lib/runtime/account-pool.ts`
- `lib/runtime/account-reset-credits.ts`
- `lib/runtime/api-model-runtime.ts`
- `lib/runtime/app-bind.ts`
- `lib/runtime/automatic-subscription-checks.ts`
- `lib/runtime/hydrate-emails.ts`
- `lib/runtime/model-discovery-status.ts`
- `lib/runtime/native-provider-config.ts`
- `lib/runtime/reset-credit-routing.ts`
- `lib/runtime/reset-credits.ts`
- `lib/runtime/resume-picker.ts`
- `lib/runtime/rotation-account-selection.ts`
- `lib/runtime/rotation-proxy-state.ts`
- `lib/runtime/rotation-token-refresh.ts`
- `lib/runtime/runtime-observability.ts`
- `lib/runtime/verify-flagged.ts`
- `lib/schemas.ts`
- `lib/session-affinity.ts`
- `lib/storage.ts`
- `lib/storage/account-save.ts`
- `lib/storage/credential-sidecars.ts`
- `lib/storage/file-lock.ts`
- `lib/storage/file-paths.ts`
- `lib/storage/flagged-storage-io.ts`
- `lib/storage/flagged-storage.ts`
- `lib/storage/json-store-lock.ts`
- `lib/storage/migrations.ts`
- `lib/storage/path-state.ts`
- `lib/storage/paths.ts`
- `lib/storage/pending-auth.ts`
- `lib/storage/public-types.ts`
- `lib/storage/record-identity.ts`
- `lib/storage/snapshot-merge.ts`
- `lib/storage/storage-parser.ts`
- `lib/storage/transactions.ts`
- `lib/ui/auth-menu-builder.ts`
- `lib/ui/auth-menu.ts`
- `lib/ui/check-progress.ts`
- `lib/ui/format.ts`
- `lib/ui/index.ts`
- `lib/ui/runtime.ts`
- `lib/ui/theme.ts`
- `lib/ui/ui-copy.ts`
- `lib/unified-settings.ts`
- `lib/usage/stream-usage-deferral.ts`
- `lib/usage/usage-extraction.ts`
- `package-lock.json`
- `scripts/bench-format/models.mjs`
- `scripts/codex-bin-resolver.js`
- `scripts/codex.js`
- `test/README.md`
- `test/account-access.test.ts`
- `test/account-model-catalog.test.ts`
- `test/account-policy.test.ts`
- `test/account-rate-limits.test.ts`
- `test/accounts-load-from-disk.test.ts`
- `test/accounts-workspace-baseline.test.ts`
- `test/accounts.test.ts`
- `test/active-account-sync.test.ts`
- `test/api-catalog-authority.test.ts`
- `test/api-login-menu.test.ts`
- `test/api-model-capabilities.test.ts`
- `test/api-model-runtime.test.ts`
- `test/api-probe-authorization.test.ts`
- `test/api-route-store.test.ts`
- `test/app-bind.test.ts`
- `test/audit.test.ts`
- `test/auth.test.ts`
- `test/automatic-subscription-checks.test.ts`
- `test/budget-guard.test.ts`
- `test/chaos/fault-injection.test.ts`
- `test/chaos/fs-faults.test.ts`
- `test/chaos/net-faults.test.ts`
- `test/check-pack-budget.test.ts`
- `test/check-progress.test.ts`
- `test/circuit-breaker.test.ts`
- `test/cli-output-contracts.test.ts`
- `test/codex-app-router.test.ts`
- `test/codex-bin-wrapper.test.ts`
- `test/codex-cli-mirror.test.ts`
- `test/codex-cli-org-account-alignment.test.ts`
- `test/codex-cli-state.test.ts`
- `test/codex-cli-writer.test.ts`
- `test/codex-manager-account-command.test.ts`
- `test/codex-manager-best-command.test.ts`
- `test/codex-manager-budget-command.test.ts`
- `test/codex-manager-check-command.test.ts`
- `test/codex-manager-cli.test.ts`
- `test/codex-manager-forecast-command.test.ts`
- `test/codex-manager-formatters.test.ts`
- `test/codex-manager-history-command.test.ts`
- `test/codex-manager-login-menu-refresh.test.ts`
- `test/codex-manager-models-command.test.ts`
- `test/codex-manager-report-command.test.ts`
- `test/codex-manager-resets.test.ts`
- `test/codex-manager-rotation-command.test.ts`
- `test/codex-manager-selection-diagnostics.test.ts`
- `test/codex-manager-status-command.test.ts`
- `test/codex-manager-uninstall-dispatch.test.ts`
- `test/codex-model-resolution.test.ts`
- `test/codex-prompts.test.ts`
- `test/codex.test.ts`
- `test/config-save.test.ts`
- `test/config-toml-restore.test.ts`
- `test/config.test.ts`
- `test/context-budget-guard-proxy.test.ts`
- `test/context-budget-guard.test.ts`
- `test/context-budget-window-coverage.test.ts`
- `test/crash-mid-write.test.ts`
- `test/dashboard-settings-data.test.ts`
- `test/dashboard-settings.test.ts`
- `test/dispatch-authority.test.ts`
- `test/documentation.test.ts`
- `test/effort-suffix-stripping.test.ts`
- `test/env-parsing.test.ts`
- `test/fetch-helpers.test.ts`
- `test/fixtures/custom-upgrade-error.mjs`
- `test/flagged-publication-boundaries.test.ts`
- `test/gpt56-models.test.ts`
- `test/gpt6-astra-models.test.ts`
- `test/gpt6-sol-luna-models.test.ts`
- `test/gpt61-sol-models.test.ts`
- `test/health-check.test.ts`
- `test/helpers/account-source-fixture.ts`
- `test/helpers/cli-test-fixtures.ts`
- `test/helpers/owned-pids.ts`
- `test/hydrate-emails.test.ts`
- `test/index-retry.test.ts`
- `test/index.test.ts`
- `test/inference-activity.test.ts`
- `test/input-utils.test.ts`
- `test/install-codex-auth.test.ts`
- `test/issue-474-pin-end-to-end.test.ts`
- `test/issue-474-pin-safety.test.ts`
- `test/issue-689-model-capacity-retry.test.ts`
- `test/journal-authorization-boundary.test.ts`
- `test/journal-routing.integration.test.ts`
- `test/json-store-atomic-write.test.ts`
- `test/json-store-lock.test.ts`
- `test/live-account-sync.test.ts`
- `test/live-proxy-parallel.test.ts`
- `test/local-bridge.test.ts`
- `test/local-client-tokens.test.ts`
- `test/logger.test.ts`
- `test/login-flow.test.ts`
- `test/login-menu-data.test.ts`
- `test/login-oauth-selection.test.ts`
- `test/login-workspace-choice.test.ts`
- `test/mcodex-statusline-scope.test.ts`
- `test/model-capability-matrix.test.ts`
- `test/model-discovery-status.test.ts`
- `test/model-map.test.ts`
- `test/multi-proc-save.test.ts`
- `test/named-backup-export.test.ts`
- `test/native-account-storage.test.ts`
- `test/native-account-sync.test.ts`
- `test/native-error-no-replay.test.ts`
- `test/native-journal-auth.integration.test.ts`
- `test/native-provider-config.test.ts`
- `test/native-rate-limits.test.ts`
- `test/native-usage-command.test.ts`
- `test/native-wrapper-binding.test.ts`
- `test/oauth-server.integration.test.ts`
- `test/oc-chatgpt-target-detection.test.ts`
- `test/outcome-authority.test.ts`
- `test/package-bin.test.ts`
- `test/paths.test.ts`
- `test/pending-auth-capacity.integration.test.ts`
- `test/pending-auth-refresh.integration.test.ts`
- `test/pending-auth.test.ts`
- `test/persist-selected-account.test.ts`
- `test/pr691-switch-revalidation.test.ts`
- `test/preemptive-quota-scheduler.test.ts`
- `test/proactive-refresh.test.ts`
- `test/property/account-identity.property.test.ts`
- `test/property/budget-guard.property.test.ts`
- `test/property/circuit-breaker.property.test.ts`
- `test/property/ledger-redaction.property.test.ts`
- `test/property/model-map.property.test.ts`
- `test/property/request-body.property.test.ts`
- `test/property/sse-parse.property.test.ts`
- `test/property/storage-roundtrip.property.test.ts`
- `test/property/transformer.property.test.ts`
- `test/publication-authority.test.ts`
- `test/quota-cache.test.ts`
- `test/quota-probe.test.ts`
- `test/rate-limit-decision.test.ts`
- `test/recovery-source-boundaries.test.ts`
- `test/refresh-authority-boundaries.test.ts`
- `test/refresh-guardian.test.ts`
- `test/refresh-queue.test.ts`
- `test/repair-commands.test.ts`
- `test/request-transformer.test.ts`
- `test/reset-authority.test.ts`
- `test/reset-credits.test.ts`
- `test/resilience-storage.integration.test.ts`
- `test/response-compaction.test.ts`
- `test/response-handler.test.ts`
- `test/responses-websocket.test.ts`
- `test/resume-picker.test.ts`
- `test/retired-models.test.ts`
- `test/rotation-account-selection.test.ts`
- `test/rotation-integration.test.ts`
- `test/rotation-proxy-state.test.ts`
- `test/rotation-token-refresh.test.ts`
- `test/router-address-probe.test.ts`
- `test/routing-profiles.test.ts`
- `test/runtime-account-check.test.ts`
- `test/runtime-observability.test.ts`
- `test/runtime-paths.test.ts`
- `test/runtime-policy-cache.test.ts`
- `test/runtime-policy.test.ts`
- `test/runtime-rotation-proxy.test.ts`
- `test/runtime-upgrade-error.test.ts`
- `test/runtime-verify-flagged.test.ts`
- `test/schemas.test.ts`
- `test/security-stress.test.ts`
- `test/server.unit.test.ts`
- `test/settings-hub-utils.test.ts`
- `test/settings-panels.test.ts`
- `test/storage-file-lock.test.ts`
- `test/storage-parser.test.ts`
- `test/storage-snapshot-merge.test.ts`
- `test/storage.test.ts`
- `test/stream-failover-runtime.test.ts`
- `test/stream-failover.test.ts`
- `test/stream-usage-deferral.test.ts`
- `test/subscription-first-use.test.ts`
- `test/subscription-status.test.ts`
- `test/token-utils.test.ts`
- `test/tool-utils.test.ts`
- `test/ui-runtime.test.ts`
- `test/ui-theme.test.ts`
- `test/unified-settings.test.ts`
- `test/usage-extraction.test.ts`
- `test/usage-ledger.test.ts`
- `test/usage-redaction.test.ts`
- `test/usage-service-tier.test.ts`
- `test/utils.test.ts`
- `test/zz-stress-helper-lifecycle.test.ts`
- `tsconfig.json`
- `tsconfig.scripts.json`
- `vendor/provenance.json`
