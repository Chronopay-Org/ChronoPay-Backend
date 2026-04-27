# Feature Flags

This document is the canonical map between feature flags and guarded HTTP routes.
Tests enforce that every registered flag and guarded route remains documented here.

## Supported Values

Feature flag environment variables are case-insensitive and support:

- Enabled: `true`, `1`, `on`, `yes`
- Disabled: `false`, `0`, `off`, `no`

Malformed values fail startup with a clear validation error.

## Registry

| Flag | Env Var | Default | Guarded Routes | Disabled Behavior |
| --- | --- | --- | --- | --- |
| `CREATE_SLOT` | `FF_CREATE_SLOT` | `true` | `POST /api/v1/slots` | `503` with `{ success: false, code: "FEATURE_DISABLED", error: "Feature CREATE_SLOT is currently disabled" }` |

## Security Notes

- Feature checks are fail-closed for malformed environment configuration at startup.
- Guarded endpoints return deterministic `503` payloads when disabled.
- Missing environment variables fall back to registry defaults.
- Unknown feature flag lookups are treated as server misconfiguration and rejected.

