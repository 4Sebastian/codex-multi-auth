# Built-in image_gen provider compatibility

Codex 0.154.0 gates its built-in image extension using provider metadata. Its tool planner additionally checks actor authorization or native ChatGPT authentication, so merely naming a custom provider OpenAI is not sufficient for all gates.

Generated runtime provider configuration supplies the non-secret local marker:

```toml
http_headers = { "x-openai-actor-authorization" = "codex-multi-auth-local" }
```

This compatibility shim satisfies the client's actor-authorization capability predicate. It is NOT an actor credential, not an authentication bypass, and does not confer upstream access. The runtime proxy removes this header, case-insensitively, before forwarding; the selected managed account's normal OAuth bearer and account ID remain authoritative. The local client bearer remains mandatory.

The provider name remains `codex-multi-auth`, `requires_openai_auth = false`, and the base URL stays local. Existing bearer configuration and `model_catalog_json` are preserved. Both generated TOML and canonical-home CLI overrides receive the marker. No official Codex binary is modified.

Image route support is a separate prerequisite for successful generation. Client image capability/model-catalog requirements and subscription entitlements also still apply. This is a version-sensitive compatibility shim, not a documented general capability API; replace it if Codex exposes a supported provider capability setting.

## Activation and rollback

Newly generated wrapper/app-bind configuration carries the marker; start a fresh session after regenerating a bind through the normal supported flow. No account migration or reauthentication is needed. Revert this change and regenerate provider configuration to remove the shim. Do not enable native authentication as a substitute.
