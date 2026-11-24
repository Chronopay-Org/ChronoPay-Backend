# Supplier payout quarantine

ChronoPay now tracks repeated supplier payout failures and quarantines a payout after a configurable failure threshold is reached.

Quarantine entries and failure counts are stored in PostgreSQL, so they persist across process restarts and are shared by application instances.

## Behavior

- Each failed payout reconciliation attempt increments the cumulative failure count for that payout id.
- When the count reaches the configured threshold, the payout is marked as quarantined and an alert event is emitted.
- Failure increments and threshold transitions are atomic in PostgreSQL, so concurrent failures emit only one alert for a transition.
- An admin can list quarantined payouts and release one from quarantine after inspection.
- After release, the next failure starts a new failure count for that payout id.

## Configuration

Set `PAYOUT_QUARANTINE_THRESHOLD` to control when quarantine kicks in. The default is `3`.

## Admin endpoints

- `GET /api/v1/admin/payouts/quarantine` lists quarantined payouts.
- `POST /api/v1/admin/payouts/:transactionId/quarantine/release` releases a payout from quarantine.
