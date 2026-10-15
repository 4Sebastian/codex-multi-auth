# Current bounded documentation repair at 1f692de6

Run: 01M4YXD0G335FMKNZFTBGN47AQ. Starting committed head: 1f692de67c311ba0d4eabb93513cada0f83f0891. Base: 5735e20936e561938c8423bcb615f3df66df8bb9. This section supersedes earlier current-head and remaining-path counts, not historical evidence or requirements.

The exact documentation patch excluding this report has SHA-256 5d5a2db26f0b0d293666ee30e47f48304b07661b40206c6be25ab9de28d8b56b. Production source, tests, package metadata and lockfile were not changed in this fix continuation. No custody, policy, counter or checkpoint operation was performed.

## Finding disposition and invariant

- review-4 is legitimate. The shared-root ownership promise contradicted recursive generic-directory deletion, .gitignore deletion and filename-prefix globs in both shell examples. The defect was ownership inference in the guidance, not a missing cleanup subsystem.
- Removed both manual wipe scripts and both soft-reset deletion examples. Replacement guidance requires resolved-path checks, private backups, stopped installation-owned writers and inspection of exact artifacts. Unknown ownership means leave the entry alone. Official CLI state and unrelated shared data remain protected.
- Linked uninstall guidance now starts with a dry-run preview and explains that the preview is not ownership proof. Uninstall and --clear-accounts do not guarantee complete credential erasure. Backups, WAL, pending-auth, project pools and exported copies are separately relevant. The storage reference no longer claims every entry under the namespace belongs to this project.
- R1, R2, review-1, review-2, api-catalog-source-authority, api-fast-wire-tier and automatic-probe-expiry-authority remain binding and their existing fixes/tests were preserved. The focused execution below revalidates them but does not independently approve them.
- R3, review-3 and review-5 remain unresolved FIX obligations for the same entire integration. No coverage waiver, approval, new deferred warning or completion is claimed. Risk remains high, scope source-or-external, because mandatory independent whole-change coverage is still incomplete. The original two deferred warnings are unchanged.

## Concrete inspection and caller judgments in this fix phase

These are fixer inspection notes, not new independent coverage. Read ranges below were contiguous and nontruncated; an excerpt never establishes whole-file review.

- `docs/privacy.md`: read the complete original page, traced its Bash and PowerShell examples against the advertised shared-root promise, then reviewed replacement cleanup prose. Default paths, overrides, generic directories and matching prefixes do not establish ownership. No executable deletion recipe remains in this page.
- `docs/troubleshooting.md`: read the complete original page. Soft reset used a hard-coded default path and did not distinguish active state from credential recovery copies. Removed those commands rather than introducing replacement destructive commands. Uninstall now links the same preconditions and presents a preview, not a broad wipe.
- `docs/reference/storage-paths.md`: complete original ranges 1-145 and 146-277. Root overrides, project pools, legacy paths, backups and official CLI state show why an inventory cannot certify all directory contents. Corrected its blanket ownership bullet. No cleanup code was added.
- `docs/reference/commands.md`: range 540-604 only. Preserved command syntax and flags while adding the same ownership and erasure limits to the uninstall reference. The rest of this file is not newly reviewed.
- `docs/upgrade.md`: complete 1-163. Existing uninstall references route readers to the revised troubleshooting procedure; no alternate recursive wipe recipe substitutes for the removed examples. This reading is not independent approval of the whole upgrade procedure or its live provider commands.
- `lib/codex-manager/commands/uninstall.ts`: complete 1-190 and 191-361. Dry-run branches avoid launcher loading and mutating hooks. Actual cleanup operates configured host/cache paths and a supplied credential-clearing callback, so a preview cannot prove shared-root ownership or comprehensive credential erasure. Error aggregation and conservative malformed-config handling remain unchanged.
- `test/uninstall-command.test.ts`: complete 1-180, 181-360 and 361-527. The executable tests supply disposable paths and inert launcher/unbind dependencies, assert config/cache results and shared bun.lock preservation, and expose partial failures. These tests do not certify safety of arbitrary shared overrides or any removed shell recipe.
- `lib/storage/credential-sidecars.ts`: complete 1-58. Explicit credential-sidecar removals use existing file locks/retries; first failure is retained across clear steps. This is not a promise to erase all exported, flagged, project or historical copies.
- `lib/storage.ts`: range 2850-3028 only. Account and flagged clears have separate entry points and backup/reset handling; exports can live at separately resolved paths. Deleting one active JSON file is not proof of total credential erasure. No whole storage review is claimed.
- `scripts/codex.js`: range 3835-4009 only. Stale shadow cleanup requires recorded wrapper and child identity/liveness, treats unknown evidence conservatively, and retains non-marker contents even after both owners are gone. These controls are not permission for users to delete an arbitrary shared root.
- `lib/accounts.ts`: range 2490-2646 only. The locked credential callback compares original record/access/refresh/exact expiry/workspace and rechecks source/journal state before mutation. Expiry equality remains distinct from the automatic job's strictly-future send check; settlement semantics were not changed.
- `index.ts`: ranges 1690-1845 and 2375-2484 only. Header receipts precede classification waits; the owning finally releases reservations. Cancelled accepted responses retain usage completion without failure or false healing, and successful recovery remains gated by original credential/circuit ownership. The rest of the plugin remains outstanding.
- `lib/runtime-rotation-proxy.ts`: ranges 4435-4544 and 5100-5179 only. Header receipt reservation is conditional on actual quota/plan or a classification-needing 429; owned completion releases it. Recovery is denied while unrelated quota work is pending and terminal ledger completion remains owned. Whole runtime, custom/native and cancellation coverage is still outstanding.
- Retained-boundary rereads: complete `lib/api-route-store.ts` 1-215; `lib/runtime/api-model-capabilities.ts` 270-514; complete `lib/runtime/automatic-subscription-checks.ts` 1-68; `lib/preemptive-quota-scheduler.ts` 285-429; `lib/usage/pricing.ts` 220-319. Original general/probe authority, bounded file checks, local denial classification, original receipt epochs, expiry-in-lock, actual upstream model pricing and null-cost behavior were preserved.

## Focused executable verification

One focused verification ran after all four documentation edits, with isolated HOME, USERPROFILE, CODEX_HOME, CODEX_MULTI_AUTH_DIR and TMPDIR rooted at the ignored worktree fixture `.tmp/review4.gzWciy`. The existing global sandbox further redirects each worker before application imports. No personal cleanup, provider/auth/priming, client, daemon, global installation, or PowerShell execution is claimed.

```sh
npm test -- test/documentation.test.ts test/uninstall-command.test.ts test/uninstall-ebusy-retry.test.ts test/codex-manager-uninstall-dispatch.test.ts test/credential-sidecars.test.ts test/api-catalog-authority.test.ts test/api-probe-authorization.test.ts test/api-route-store.test.ts test/api-model-runtime.test.ts test/api-model-capabilities.test.ts test/model-discovery-status.test.ts test/automatic-subscription-checks.test.ts test/automatic-account-checks.test.ts test/quota-probe.test.ts test/usage-ledger.test.ts test/usage-pricing-coverage.test.ts test/usage-service-tier.test.ts test/budget-guard.test.ts test/model-route-policy.test.ts test/preemptive-quota-scheduler.test.ts test/index-retry.test.ts test/runtime-rotation-proxy.test.ts test/dispatch-authority.test.ts test/native-error-no-replay.test.ts test/native-journal-auth.integration.test.ts
```

Exit 0. All 25 files and 1,687 tests passed in 67.98 seconds. This includes retained authority/consent/queued catalog/body/cache/publication/ETag, Fast-to-Priority, expiry preparation/fallback, pricing/ledger/budget, nine-probe, receipt cleanup, terminal accounting and no-replay controls. No source, test or user-facing documentation changes followed this run. Documentation assertions are existing contract checks, not evidence that natural-language instructions enforce ownership; the unsafe examples were removed and the replacement prose was reviewed directly. No source-string safety test was added.

Full normal Test, Document, Lint, typechecking/build and actual linked installed-delivery acceptance remain separate outstanding phases. The outer executor owns them. The prior failing focused runs and historical results below remain evidence, not final acceptance.

## Independent-review evidence retained and reconciled

The round-3 returned report at b72a23a4 listed 76 judged paths. The latest returned independent report for 1f692de6 listed 92, stated that no tests/build/lint ran in that review, and left whole-change coverage incomplete. Their supplied path metadata is retained below. Their full per-path ranges/judgments were not supplied in the returned JSON; none are fabricated here. External shared-boundary reassessments remain supporting context, not independent review.

Of the earlier 76, 71 were unchanged by b72a23a4..1f692de6. Four changed paths were listed again in the latest independent report; `test/automatic-subscription-checks.test.ts` was not. The current repair changes `docs/privacy.md`, requiring independent re-review despite its presence in the latest report. The other three changed user docs and this report also need independent review.

The union of supplied metadata, after excluding changed paths not rejudged, leaves 385 of the 509 paths awaiting independent coverage or reconciliation in the current inventory. This is an auditable handoff count, not certification of the other paths or permission to omit shared callers.

Next independent review must prioritize complete omitted files: `index.ts`, `lib/accounts.ts`, `lib/storage.ts`, `lib/runtime-rotation-proxy.ts`, `scripts/codex.js`, then omitted whole test/config/docs files. Continue contiguous nontruncated source/caller/security/failure inspection, reconcile all prior FIX requirements and the changed docs, and record substantive judgments before acceptance. This instruction to the next phase does not start or control a workflow.

### Prior returned independent path metadata at b72a23a4

- `.github/workflows/ci.yml`
- `.github/workflows/codex-plugin-scanner.yml`
- `codex_plugin_scanner/__init__.py`
- `codex_plugin_scanner/action_runner.py`
- `lib/AGENTS.md`
- `lib/accounts/rate-limits.ts`
- `lib/api-route-store.ts`
- `lib/codex-manager/commands/uninstall.ts`
- `lib/concurrency.ts`
- `lib/context-budget/model-context-windows.ts`
- `lib/env-parsing.ts`
- `lib/model-route-policy.ts`
- `lib/preemptive-quota-scheduler.ts`
- `lib/request/account-dispatch.ts`
- `lib/request/client-cancellation.ts`
- `lib/request/helpers/input-utils.ts`
- `lib/request/request-transformer.ts`
- `lib/request/response-compaction.ts`
- `lib/request/response-outcome.ts`
- `lib/request/stream-failover-runtime.ts`
- `lib/request/stream-failover.ts`
- `lib/request/url-rewriting.ts`
- `lib/runtime-constants.ts`
- `lib/runtime-paths.ts`
- `lib/runtime/account-model-catalog.ts`
- `lib/runtime/api-model-capabilities.ts`
- `lib/runtime/api-model-runtime.ts`
- `lib/runtime/automatic-account-checks.ts`
- `lib/runtime/automatic-subscription-checks.ts`
- `lib/runtime/catalog-capabilities.ts`
- `lib/runtime/catalog-client-version.ts`
- `lib/runtime/config-toml.ts`
- `lib/runtime/inference-activity.ts`
- `lib/runtime/model-discovery-status.ts`
- `lib/runtime/native-account-storage.ts`
- `lib/runtime/native-account-sync.ts`
- `lib/runtime/native-binding-lock.ts`
- `lib/runtime/native-client-auth.ts`
- `lib/runtime/native-rate-limits.ts`
- `lib/runtime/response-output-history.ts`
- `lib/runtime/responses-websocket.ts`
- `lib/runtime/rotation-server-types.ts`
- `lib/runtime/runtime-capability-failures.ts`
- `lib/runtime/subscription-first-use.ts`
- `lib/runtime/subscription-quota-event.ts`
- `lib/runtime/subscription-quota-order.ts`
- `lib/runtime/workspace-model-scopes.ts`
- `lib/storage/authority-revision.ts`
- `lib/storage/recovery-credentials.ts`
- `lib/usage/pricing.ts`
- `lib/utils.ts`
- `package.json`
- `scripts/check-pack-budget-lib.js`
- `scripts/codex-app-router.js`
- `scripts/codex-multi-auth.js`
- `scripts/codex-routing.js`
- `test/AGENTS.md`
- `test/account-dispatch-boundaries.test.ts`
- `test/account-reset-target.test.ts`
- `test/automatic-account-checks.test.ts`
- `test/automatic-subscription-checks.test.ts`
- `test/catalog-client-version.test.ts`
- `test/ci-workflows.test.ts`
- `test/codex-cli-writer-callers.test.ts`
- `test/concurrency.test.ts`
- `test/credential-sidecars.test.ts`
- `test/model-route-policy.test.ts`
- `test/native-client-auth.test.ts`
- `test/python-output-encoding.test.ts`
- `test/reset-credit-routing.test.ts`
- `test/reset-identity-collision.test.ts`
- `test/response-outcome.test.ts`
- `test/response-output-history.test.ts`
- `test/runtime-capability-failures.test.ts`
- `test/subscription-quota-event.test.ts`
- `test/subscription-quota-order.test.ts`

### Latest returned independent path metadata at 1f692de6

- `.codex-plugin/plugin.json`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yml`
- `.github/workflows/codeql.yml`
- `.github/workflows/codex-plugin-scanner.yml`
- `.gitignore`
- `.nvmrc`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `codex_plugin_scanner/__init__.py`
- `codex_plugin_scanner/action_runner.py`
- `docs/privacy.md`
- `eslint.config.js`
- `knip.jsonc`
- `lib/account-policy.ts`
- `lib/api-route-store.ts`
- `lib/audit.ts`
- `lib/auth/server.ts`
- `lib/budget-guard.ts`
- `lib/circuit-breaker.ts`
- `lib/codex-manager/commands/uninstall.ts`
- `lib/concurrency.ts`
- `lib/context-budget/model-context-windows.ts`
- `lib/env-parsing.ts`
- `lib/local-bridge.ts`
- `lib/local-client-tokens.ts`
- `lib/logger.ts`
- `lib/model-route-policy.ts`
- `lib/policy/runtime-policy-cache.ts`
- `lib/policy/runtime-policy.ts`
- `lib/preemptive-quota-scheduler.ts`
- `lib/prompts/codex.ts`
- `lib/request/account-dispatch.ts`
- `lib/request/client-cancellation.ts`
- `lib/request/helpers/input-utils.ts`
- `lib/request/helpers/tool-utils.ts`
- `lib/request/url-rewriting.ts`
- `lib/routing-profiles.ts`
- `lib/runtime-paths.ts`
- `lib/runtime/api-model-capabilities.ts`
- `lib/runtime/api-model-runtime.ts`
- `lib/runtime/automatic-subscription-checks.ts`
- `lib/runtime/catalog-capabilities.ts`
- `lib/runtime/catalog-client-version.ts`
- `lib/runtime/config-toml.ts`
- `lib/runtime/model-discovery-status.ts`
- `lib/runtime/native-account-storage.ts`
- `lib/runtime/native-account-sync.ts`
- `lib/runtime/native-client-auth.ts`
- `lib/runtime/responses-websocket.ts`
- `lib/runtime/runtime-capability-failures.ts`
- `lib/runtime/workspace-model-scopes.ts`
- `lib/storage/authority-revision.ts`
- `lib/storage/credential-sidecars.ts`
- `lib/storage/file-lock.ts`
- `lib/storage/file-paths.ts`
- `lib/storage/json-store-lock.ts`
- `lib/storage/path-state.ts`
- `lib/storage/paths.ts`
- `lib/storage/pending-auth.ts`
- `lib/storage/record-identity.ts`
- `lib/storage/recovery-credentials.ts`
- `lib/utils.ts`
- `package.json`
- `scripts/bench-format/models.mjs`
- `scripts/check-pack-budget-lib.js`
- `scripts/codex-app-router.js`
- `scripts/codex-bin-resolver.js`
- `scripts/codex-multi-auth.js`
- `scripts/codex-routing.js`
- `test/api-catalog-authority.test.ts`
- `test/catalog-client-version.test.ts`
- `test/check-pack-budget.test.ts`
- `test/ci-workflows.test.ts`
- `test/codex-app-router.test.ts`
- `test/codex-cli-writer-callers.test.ts`
- `test/concurrency.test.ts`
- `test/context-budget-window-coverage.test.ts`
- `test/env-parsing.test.ts`
- `test/gpt61-sol-models.test.ts`
- `test/local-bridge.test.ts`
- `test/package-bin.test.ts`
- `test/paths.test.ts`
- `test/python-output-encoding.test.ts`
- `test/retired-models.test.ts`
- `test/router-address-probe.test.ts`
- `test/runtime-paths.test.ts`
- `test/token-utils.test.ts`
- `test/utils.test.ts`
- `tsconfig.json`
- `tsconfig.scripts.json`
- `vendor/provenance.json`

# Historical integration review continuation

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

## Exact paths awaiting independent coverage or reconciliation now

These 385 paths are not credited by the retained returned reports at the current working state. This list replaces the historical 438-path inventory; fixer reads and focused tests add no independent credit. Other reported paths still require exact-final-head and caller reconciliation before whole-change approval.

- `.bugsweep-index.md`
- `.bugsweep-transform.md`
- `AGENTS.md`
- `CHANGELOG.md`
- `README.md`
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
- `index.ts`
- `lib/accounts.ts`
- `lib/auth/account-access.ts`
- `lib/auth/auth.ts`
- `lib/auth/token-utils.ts`
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
- `lib/oc-chatgpt-target-detection.ts`
- `lib/proactive-refresh.ts`
- `lib/quota-cache.ts`
- `lib/quota-probe.ts`
- `lib/quota-readiness.ts`
- `lib/refresh-guardian.ts`
- `lib/refresh-queue.ts`
- `lib/request/error-classification.ts`
- `lib/request/fetch-helpers.ts`
- `lib/request/helpers/model-map.ts`
- `lib/request/rate-limit-decision.ts`
- `lib/request/response-handler.ts`
- `lib/request/token-refresh.ts`
- `lib/rotation.ts`
- `lib/runtime-rotation-proxy.ts`
- `lib/runtime/account-check.ts`
- `lib/runtime/account-pool.ts`
- `lib/runtime/account-reset-credits.ts`
- `lib/runtime/app-bind.ts`
- `lib/runtime/hydrate-emails.ts`
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
- `lib/storage/flagged-storage-io.ts`
- `lib/storage/flagged-storage.ts`
- `lib/storage/migrations.ts`
- `lib/storage/public-types.ts`
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
- `test/check-progress.test.ts`
- `test/circuit-breaker.test.ts`
- `test/cli-output-contracts.test.ts`
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
- `test/crash-mid-write.test.ts`
- `test/dashboard-settings-data.test.ts`
- `test/dashboard-settings.test.ts`
- `test/dispatch-authority.test.ts`
- `test/documentation.test.ts`
- `test/effort-suffix-stripping.test.ts`
- `test/fetch-helpers.test.ts`
- `test/fixtures/custom-upgrade-error.mjs`
- `test/flagged-publication-boundaries.test.ts`
- `test/gpt56-models.test.ts`
- `test/gpt6-astra-models.test.ts`
- `test/gpt6-sol-luna-models.test.ts`
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
- `test/rotation-account-selection.test.ts`
- `test/rotation-integration.test.ts`
- `test/rotation-proxy-state.test.ts`
- `test/rotation-token-refresh.test.ts`
- `test/routing-profiles.test.ts`
- `test/runtime-account-check.test.ts`
- `test/runtime-observability.test.ts`
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
- `test/tool-utils.test.ts`
- `test/ui-runtime.test.ts`
- `test/ui-theme.test.ts`
- `test/unified-settings.test.ts`
- `test/usage-extraction.test.ts`
- `test/usage-ledger.test.ts`
- `test/usage-redaction.test.ts`
- `test/usage-service-tier.test.ts`
- `test/zz-stress-helper-lifecycle.test.ts`
