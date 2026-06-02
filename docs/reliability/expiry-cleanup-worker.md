# Expiry Cleanup Worker

The expiry cleanup worker is a periodic background job that keeps booking intents and checkout sessions from accumulating stale data.

## Behavior

- Expires pending booking intents older than `BOOKING_INTENT_TTL_MS`.
- Soft-expires checkout sessions whose `expiresAt` has passed.
- Deletes checkout sessions that have been non-pending for longer than `EXPIRY_SOFT_EXPIRY_GRACE_MS`.
- Uses batched, paginated cleanup of session storage and a safety brake to protect against runaway sweeps.

## Configuration

Environment variables:

- `BOOKING_INTENT_TTL_MS` — time in milliseconds before a pending booking intent is considered stale and expired. Defaults to `900000` (15 minutes).
- `EXPIRY_SOFT_EXPIRY_GRACE_MS` — soft-expiry grace window in milliseconds before an expired checkout session can be hard deleted. Defaults to `3600000` (1 hour).
- `EXPIRY_CLEANUP_BATCH_SIZE` — number of sessions processed per cleanup batch. Defaults to `100`.
- `EXPIRY_CLEANUP_SAFETY_THRESHOLD` — maximum total candidate rows allowed in a single sweep before the worker skips the cleanup. Defaults to `1000`.
- `EXPIRY_CLEANUP_INTERVAL_MS` — interval between periodic cleanup runs. Defaults to `300000` (5 minutes).

## Metrics

The worker exposes Prometheus counters:

- `expiry_cleanup_booking_intents_expired_total`
- `expiry_cleanup_checkout_sessions_soft_expired_total`
- `expiry_cleanup_checkout_sessions_deleted_total`
- `expiry_cleanup_safety_brake_triggers_total`
