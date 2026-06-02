# Pricing Strategies

ChronoPay supports dynamic pricing on booking intents. Suppliers can opt into one of three strategies. The resolved price and all inputs are **snapshotted** onto the intent at creation time, making resolution deterministic and auditable.

## Strategies

| Strategy | Description |
|---|---|
| `fixed` | Always returns `basePrice` unchanged |
| `time_decay` | Price decays linearly to 50% floor over 24 h before slot start |
| `demand_based` | Price increases 10% per active pending intent, capped at 3× base |

## Usage

Pass `pricingStrategyId` and `basePrice` when creating a booking intent:

```http
POST /api/v1/booking-intents
Content-Type: application/json

{
  "slotId": "slot-11111111-1111-4111-8111-111111111111",
  "pricingStrategyId": "demand_based",
  "basePrice": 1000
}
```

Response includes the resolved price and a full input snapshot:

```json
{
  "id": "intent-1",
  "pricingStrategyId": "demand_based",
  "resolvedPrice": 1100,
  "pricingSnapshot": {
    "basePrice": 1000,
    "slotStartTime": 1900000000000,
    "nowMs": 1899999000000,
    "activeIntentCount": 1
  }
}
```

When `pricingStrategyId` is omitted, no pricing fields are set.

## Strategy Details

### `fixed`
`resolvedPrice = basePrice`

### `time_decay`
```
ratio = clamp((slotStartTime - nowMs) / 86_400_000, 0, 1)
resolvedPrice = round(basePrice * 0.5 + basePrice * 0.5 * ratio)
```
Full price ≥24 h away; 50% floor at or past start.

### `demand_based`
```
resolvedPrice = round(min(basePrice * (1 + activeIntentCount * 0.1), basePrice * 3))
```
10% surcharge per active intent, capped at 3×.

## Security & Correctness

- `basePrice` must be ≥ 0
- Unknown strategy IDs are rejected
- All strategies are pure functions — same inputs always produce the same price
- Snapshot is immutable after creation

## Implementation

- `src/services/pricingStrategy.ts` — interface, strategies, registry, resolver
- `src/modules/booking-intents/booking-intent-service.ts` — integration
- `src/services/__tests__/pricingStrategy.test.ts` — unit tests
- `src/modules/booking-intents/__tests__/booking-intent-pricing.test.ts` — integration tests
