# Internal HMAC Authentication

ChronoPay supports optional HMAC authentication for internal scheduler/worker trigger endpoints.

## Protected endpoint

- `POST /internal/cron/reminders/trigger`

## Enablement

Set `INTERNAL_HMAC_SECRET` in the environment.  
When unset, internal HMAC auth is bypassed for local development.

## Required headers

- `x-chronopay-timestamp`: Unix timestamp in milliseconds
- `x-chronopay-signature`: HMAC-SHA256 hex digest

## Signature format

Server verifies:

`HMAC_SHA256(secret, "<timestamp>.<METHOD>.<path>.<sha256(jsonBody)>")`

Example for `/internal/cron/reminders/trigger`:

`1713948800000.POST./internal/cron/reminders/trigger.<body-sha256>`

## Replay protection

- Default skew window: 300 seconds
- A matching `timestamp + signature` is accepted once, then rejected with `409`
- Replay cache prefers Redis; falls back to in-memory cache if Redis is unavailable

## Rotation guidance

- Rotate `INTERNAL_HMAC_SECRET` via environment management (secret manager/KMS)
- During rotation, deploy signer and verifier in a coordinated window
- Never log raw secret values or unsigned payloads containing sensitive data
