# Refundable Hold Escalation

## Overview

When a payment capture completes for a refundable hold, the booking state automatically escalates from `confirmed` to `firm`, representing a non-refundable commitment.

## Hold Auto-Refund Worker

Holds that are never captured expire when their `holdUntilMs` deadline passes. The hold auto-refund worker (`src/scheduler/holdAutoRefundWorker.ts`) runs in the background, polls `BookingIntentRepository.findExpiredHolds`, and calls `BookingIntentService.autoRefundHold` for each expired hold.

The worker is wired from `src/index.ts` and shares the process-wide singleton repository with the HTTP routes (via `src/modules/booking-intents/bookingIntentContainer.ts`), so refunds issued by the worker are immediately visible through the API.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOLD_AUTO_REFUND_DISABLED` | _(unset)_ | Set to `"true"` to disable the worker entirely (e.g. read-only replicas, single-shot scripts). |
| `HOLD_AUTO_REFUND_INTERVAL_MS` | `60000` | Polling interval in milliseconds. |
| `HOLD_AUTO_REFUND_BATCH_SIZE` | `100` | Maximum holds processed per cycle. |
| `HOLD_AUTO_REFUND_SAFETY_THRESHOLD` | `1000` | Circuit-breaker: the cycle is skipped if more expired holds are found than this value, to prevent runaway mass-refunds. |

### Lifecycle

The worker registers a stop hook with `ApplicationLifecycle` under the name `"hold-auto-refund"`. On `SIGTERM` or `SIGINT` the loop exits cleanly via an `AbortController` without leaving a pending timer.

## State Transitions

- **confirmed → firm**: Payment captured (Captured event)
- **firm → cancelled**: Service completed (Released event) or refunded (Refunded event)
- **firm → expired**: Protocol penalty (Slashed event)

## Idempotency

Duplicate capture events are safely handled:
- Same event replayed → `noop_slot_already` outcome
- Intent already firm → No state change
- Capture after terminal state → `noop_terminal_intent`

## Security

All events must originate from allowlisted contract addresses. Non-allowlisted events are rejected with `noop_rejected_address`.

## Audit Trail

Every successful capture escalation emits an audit event:
- Action: `escrow.capture.firm_booking`
- Includes: intent ID, slot ID, customer ID, tx hash, amount, capture time

## Edge Cases

1. **Capture after refund**: Refund wins (terminal state), capture is rejected
2. **Multiple captures**: First wins, subsequent captures are no-ops
3. **Partial capture**: Not currently supported, full capture only
