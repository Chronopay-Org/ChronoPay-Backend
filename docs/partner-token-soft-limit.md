# Partner Token Soft-Limit Warning Webhooks

Partners receive an early **soft-limit** warning webhook before token quotas hard-cut requests (HTTP 429). Delivery is **at-least-once** via a durable ledger with dedupe and ack tracking.

## Behavior

1. Operators configure a per-partner soft-limit fraction `(0, 1]` (default `0.8`) and an `https` webhook URL.
2. When quota consumption crosses the soft-limit (same path as the approaching-quota metric), ChronoPay enqueues a `token_quota_warning` delivery.
3. Dedupe key: `{partnerId}:{roundedPct}:{15minWindow}` — duplicate warnings in the same window are ignored.
4. Delivery stays `pending`/`failed` until the partner returns HTTP 2xx (`acked`) or attempts are exhausted.

## Configuration

```http
POST /webhooks/admin/partner-soft-limit
Content-Type: application/json

{
  "partnerId": "apiKey_<sha256>",
  "webhookUrl": "https://partner.example.com/hooks/quota",
  "softLimit": 0.8
}
```

```http
GET /webhooks/admin/partner-soft-limit/:partnerId
```

## Payload

```json
{
  "event": "token_quota_warning",
  "partner_id": "apiKey_...",
  "token_usage": 8500,
  "soft_limit": 0.8,
  "threshold_percent": 85,
  "message": "Token usage has reached 85% of the hard cutoff.",
  "timestamp": "2026-08-03T20:00:00.000Z"
}
```

## Delivery / retries

- Automatic first attempt on enqueue (fire-and-forget from the quota path).
- Retry pending/failed rows:

```http
POST /webhooks/partner-token/deliver
POST /api/v1/webhooks/partner-token/deliver   # HMAC-protected
```

HMAC-protected check endpoint (same semantics as usage enqueue):

```http
POST /api/v1/webhooks/partner-token/check
```

## Security notes

- Webhook URLs must use `https` outside tests.
- Soft-limit check on `/api/v1/webhooks/partner-token/*` requires internal HMAC auth.
- Ledger dedupe prevents webhook storms when usage oscillates near the threshold.

## Schema

Migration `021_create_partner_token_delivery_ledger` creates:

- `partner_token_soft_limit_config`
- `partner_token_delivery_ledger` (unique `dedupe_key`, retry index on `pending`/`failed`)
