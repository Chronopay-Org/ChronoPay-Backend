# Supplier payout quarantine

ChronoPay now tracks repeated supplier payout failures and quarantines a payout after a configurable failure threshold is reached.

## Behavior

- Each failed payout reconciliation attempt increments the cumulative failure count for that payout id.
- When the count reaches the configured threshold, the payout is marked as quarantined and an alert event is emitted.
- An admin can list quarantined payouts and release one from quarantine after inspection.

## Configuration

Set `PAYOUT_QUARANTINE_THRESHOLD` to control when quarantine kicks in. The default is `3`.

## Admin endpoints

- `GET /api/v1/admin/payouts/quarantine` lists quarantined payouts.
- `POST /api/v1/admin/payouts/:transactionId/quarantine/release` releases a payout from quarantine.
