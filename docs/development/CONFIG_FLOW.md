# Configuration Flow

How configuration is resolved at runtime from files, env, and defaults.

* * *

## 1) Root Directory Resolution

Runtime root priority (`getCodexMultiAuthDir`):

1. `CODEX_MULTI_AUTH_DIR` when set
2. If `CODEX_HOME` is an explicit non-default path: **only** `$CODEX_HOME/multi-auth` (no cross-root scan)
3. Otherwise prefer candidate roots under `CODEX_HOME` / `~/.codex` that already hold account storage
4. Fall back to `~/.codex/multi-auth` (canonical default) or other roots that already show multi-auth signals
5. Legacy path fallback only when storage signals exist

Canonical target is `~/.codex/multi-auth` when no override is set.

* * *

## 2) Unified Settings Resolution

`settings.json` is read for:

- `dashboardDisplaySettings`
- `pluginConfig`

If legacy config exists, compatibility load and migration path still apply.

* * *

## 3) Runtime Value Precedence

For runtime values stored in `pluginConfig`, source selection is:

1. Fallback file from `CODEX_MULTI_AUTH_CONFIG_PATH` when set **and the file exists** (also the preferred save target when set)
2. Unified settings `pluginConfig` from `settings.json` (if present and valid)
3. Legacy compatibility path when unified config is missing/invalid
4. Hardcoded default in `DEFAULT_PLUGIN_CONFIG`

After source selection, environment variables apply per-setting overrides.

A `CODEX_MULTI_AUTH_CONFIG_PATH` that is set but not yet created is ignored for load; the first save still creates/writes that path when the env var remains set.

For dashboard display values:

1. Persisted `dashboardDisplaySettings`
2. Normalization + fallback defaults

* * *

## 4) Account Storage Path Flow

1. Resolve root directory.
2. Use global accounts file by default.
3. If project-scoped mode is active, use project namespaced path under root.
4. Attempt legacy project-file migration when applicable.

* * *

## 5) Command Routing Flow

1. Standalone manager receives `codex-multi-auth ...` and normalizes bare subcommands to `auth ...` before dispatch.
2. Optional wrapper receives `codex-multi-auth-codex ...`, normalizes compatibility aliases, and runs auth-manager commands locally.
3. If a wrapper command is not in auth-manager scope, discover and forward to the official Codex CLI binary.
4. For forwarded request-bearing commands, check whether runtime rotation is enabled.

* * *

## 6) Runtime Rotation Flow

1. Resolve `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY`; if unset, read `pluginConfig.codexRuntimeRotationProxy`, which defaults to enabled.
2. If disabled or the forwarded command is help/non-requesting, forward directly to official Codex.
3. If enabled, start a loopback HTTP/SSE and persistent WebSocket Responses proxy with a per-process client token.
4. Select a transport from the forwarded argv:
   - **No forwarded subcommand (interactive TUI)** — keep the canonical `CODEX_HOME` and pass `codex-multi-auth-runtime-proxy` as ephemeral `-c model_providers.*` overrides. Nothing is copied, no provider or transport config is written into `config.toml`, and the helper detaches on exit. The transport-independent `cli_auth_credentials_store` reconcile below still applies.
   - **`resume` / `fork`** — the same canonical-home transport as the interactive TUI. These resume an existing thread, and the shadow home omits the runtime SQLite state, so the shadow transport could not see the requested thread (#647).
   - **`codex app`** — run the app runtime helper against a shadow `CODEX_HOME`.
   - **Any other request-bearing command** — create a temporary shadow `CODEX_HOME` and rewrite its `config.toml` to use `codex-multi-auth-runtime-proxy`.
5. Forward official Codex with the selected home.
6. HTTP/SSE handling selects or refreshes managed accounts and rotates on rate limit, auth, network, or server failure before streaming starts.
7. WebSocket handling binds one account per connection, applies policy and usage governance to every `response.create`, and makes handshake or reconnect failover decisions from the same bounded account-routing controls.
8. On process exit, shadow-home transports sync refreshed official Codex state files back and remove the shadow home. The canonical-home transport wrote state in place, so there is nothing to sync.

Independently of the transport, the wrapper reconciles the top-level `cli_auth_credentials_store = "file"` assignment in the real `~/.codex/config.toml` at startup (idempotent; see `lib/codex-cli/writer.ts`). That is the only key this project persists into the official config.

* * *

## 7) Request Handling Flow (Plugin Host)

1. Transform request for Codex backend compatibility.
2. Resolve account candidate set (health, cooldown, quota, affinity).
3. Execute request with timeout/retry policy.
4. Apply failover/rotation/cooldown decisions.
5. Persist account/cache/session updates.

* * *

## 8) Unsupported Model / Entitlement Flow

1. Detect unsupported model or entitlement failures.
2. Record in entitlement cache.
3. Apply capability penalties for account/model pair.
4. Use fallback model policy if enabled.
5. Re-evaluate account scoring and retry path.

* * *

## 9) Live Runtime Sync Flow

1. File watcher detects account-file updates.
2. Debounce and reload in-memory account manager.
3. Session affinity and guardian processes continue with updated state.

* * *

## 10) Debugging Effective Config

Use:

```bash
codex-multi-auth status
codex-multi-auth report --json
codex-multi-auth rotation status
```

Check files:

- `~/.codex/multi-auth/settings.json`
- `~/.codex/multi-auth/openai-codex-accounts.json`

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../configuration.md](../configuration.md)
