# API Keys and `apiKeyId`

ChronoPay Backend supports API key authentication through the `x-api-key` header. To avoid logging or storing raw secret key values, the service derives a stable, non-reversible `apiKeyId` from the incoming API key.

## Purpose

- Provide a consistent identity for telemetry, logs, and metrics.
- Avoid storing or emitting raw API keys anywhere in the system.
- Preserve the ability to attribute requests across service boundaries.

## How it works

1. The API key is validated against the configured runtime value.
2. When authentication succeeds, the request middleware derives `apiKeyId` from the raw API key.
3. The raw key is never persisted or logged.
4. `apiKeyId` is attached to the request context and can be used for structured logging.

## Derivation

ChronoPay derives `apiKeyId` using a secure one-way hash:

- Algorithm: `sha256`
- Output format: `apiKey_<hex digest>`
- Example: `apiKey_4c806362b613f7496abf284146efd31da90e4b16169fe001841ca17290f427c4`

This approach is deterministic for the same key, but non-reversible.

## Security guarantees

- The raw API key is not emitted in logs.
- Sensitive fields such as `x-api-key`, `authorization`, and `cookie` are redacted from log output.
- Request-level logging sanitizes headers before they are written.

## Runtime configuration

The application currently validates API keys using the runtime configuration passed to the application factory:

- `CHRONOPAY_API_KEY` is expected when the service is started.
- In test mode, the integration harness uses `test-api-key` by default.

## Notes for developers

- Use `req.apiKeyId` rather than raw API key values when tagging logs or metrics.
- Do not add raw API keys to request context, error details, or telemetry payloads.
