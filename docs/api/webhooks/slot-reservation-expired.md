# `slot.reservation.expired` webhook

Sent to a supplier's configured webhook endpoint whenever a slot hold is
released because its booking intent expired before checkout completed.

## Delivery

- `POST` to the supplier's configured URL (`supplier_webhook_endpoints.url`).
- `Content-Type: application/json`
- `X-ChronoPay-Event: slot.reservation.expired`
- `X-ChronoPay-Signature: sha256=<hex hmac>` — HMAC-SHA256 over the raw
  request body, keyed with the supplier's stored secret
  (`supplier_webhook_endpoints.secret`). Verify with a constant-time
  comparison (see `verifySignature` in
  `src/services/supplierWebhookDispatcher.ts` for the reference
  implementation).

## Opting out

Suppliers can disable this event via `supplier_webhook_preferences`
(`supplier_id`, `event_type = 'slot.reservation.expired'`, `enabled =
false`). Absent a row, the event is enabled by default.

## Retries

Failed deliveries (non-2xx response, timeout, network error) are retried
with exponential backoff (30s, 1m, 2m, 4m, ... capped at 1 hour), tracked
per event in `webhook_delivery_attempts`. There is currently no maximum
attempt cap or dead-letter queue — retention/cleanup of long-failing rows
is handled by the existing outbox compaction worker
(`src/scheduler/outboxCompactionWorker.ts`).

## Payload

```json
{
  "event": "slot.reservation.expired",
  "data": {
    "slotId": "slot-11111111-1111-4111-8111-111111111111",
    "start": "2026-08-15T14:30:00.000Z",
    "timezone": "UTC",
    "reason": "booking_intent_expired"
  },
  "occurredAt": "2026-08-15T14:45:00.000Z"
}
```

### JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "slot.reservation.expired",
  "type": "object",
  "required": ["event", "data", "occurredAt"],
  "properties": {
    "event": { "const": "slot.reservation.expired" },
    "data": {
      "type": "object",
      "required": ["slotId", "start", "timezone", "reason"],
      "properties": {
        "slotId": { "type": "string" },
        "start": { "type": "string", "format": "date-time" },
        "timezone": { "type": "string", "description": "IANA timezone identifier, or UTC" },
        "reason": { "const": "booking_intent_expired" }
      }
    },
    "occurredAt": { "type": "string", "format": "date-time" }
  }
}
```

## Known limitation

`timezone` is currently always `"UTC"`. `TimezoneResolverService`
(`src/services/timezoneResolverService.ts`) already supports resolving a
slot's true store/supplier/tenant timezone, but isn't yet threaded into
`BookingIntentService`. `start` is always a correct, unambiguous UTC
ISO-8601 instant in the meantime.