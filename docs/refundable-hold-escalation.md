# Refundable Hold Escalation

## Overview

When a payment capture completes for a refundable hold, the booking state automatically escalates from `confirmed` to `firm`, representing a non-refundable commitment.

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
