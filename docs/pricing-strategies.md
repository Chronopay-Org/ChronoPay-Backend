# Pricing Strategies

ChronoPay supports dynamic pricing on time slots. Suppliers opt in by attaching a `pricingStrategy` object to a slot. When a booking intent is created the price is resolved once and snapshotted onto the intent for auditability — the resolved price never changes even if the slot's strategy is later updated.

## How it works

1. Supplier creates/updates a slot with a `pricingStrategy` config.
2. Customer creates a booking intent for that slot.
3. `BookingIntentService.createIntent` calls `resolvePrice(strategyId, inputs)`.
4. The result (price + all inputs) is stored as `pricingSnapshot` on the `BookingIntentRecord`.
5. Slots without a `pricingStrategy` produce no snapshot — price is handled out-of-band.

## Strategies

### `fixed`

Price never changes regardless of time or demand.

```json
{
  "strategyId": "fixed",
  "basePrice": 5000,
  "config": { "strategy": "fixed" }
}
```

**Formula:** `price = basePrice`

---

### `time_decay`

Price decreases linearly from `basePrice` to `basePrice × minMultiplier` as the slot start time approaches. Outside the decay window the full base price applies.

```json
{
  "strategyId": "time_decay",
  "basePrice": 5000,
  "config": {
    "strategy": "time_decay",
    "windowMs": 86400000,
    "minMultiplier": 0.5
  }
}
```

| Parameter      | Type   | Constraint      | Description                                              |
| -------------- | ------ | --------------- | -------------------------------------------------------- |
| `windowMs`     | number | > 0             | Milliseconds before slot start during which decay runs   |
| `minMultiplier`| number | 0 – 1 inclusive | Multiplier applied at the moment the slot starts         |

**Formula:**
```
msUntilStart = slotStartMs - nowMs

if msUntilStart >= windowMs:  multiplier = 1
if msUntilStart <= 0:         multiplier = minMultiplier
else:
  progress   = 1 - msUntilStart / windowMs   # 0→1 as time approaches start
  multiplier = 1 - progress × (1 - minMultiplier)

price = round(basePrice × multiplier)
```

---

### `demand_based`

Price scales linearly from `basePrice` (0 bookings) to `basePrice × maxMultiplier` (fully booked).

```json
{
  "strategyId": "demand_based",
  "basePrice": 5000,
  "capacity": 5,
  "config": {
    "strategy": "demand_based",
    "maxMultiplier": 2.0
  }
}
```

| Parameter       | Type    | Constraint | Description                                        |
| --------------- | ------- | ---------- | -------------------------------------------------- |
| `maxMultiplier` | number  | ≥ 1        | Multiplier applied when the slot is fully booked   |
| `capacity`      | integer | ≥ 1        | Set on `SlotPricingStrategy`, not inside `config`  |

**Formula:**
```
demandRatio = clamp(activeBookings, 0, capacity) / capacity
multiplier  = 1 + demandRatio × (maxMultiplier - 1)
price       = round(basePrice × multiplier)
```

---

## Pricing snapshot

Every `BookingIntentRecord` may carry a `pricingSnapshot`:

```ts
interface PricingSnapshot {
  strategyId: StrategyId;      // "fixed" | "time_decay" | "demand_based"
  resolvedPrice: number;       // final price in smallest currency unit
  basePrice: number;
  slotStartMs: number;
  nowMs: number;
  activeBookings: number;
  capacity: number;
  config: StrategyConfig;
}
```

The snapshot is immutable after creation and serves as the audit trail for the price the customer was shown.

## Security & correctness

- **Deterministic:** strategies are pure functions — same inputs always produce the same price.
- **Input validation:** each strategy validates its config and throws on invalid values (negative base price, `windowMs ≤ 0`, `maxMultiplier < 1`, etc.).
- **No floating-point leakage:** prices are rounded to the nearest integer before being stored.
- **Clamping:** `activeBookings` is clamped to `[0, capacity]` so over-booked states don't produce prices above `maxMultiplier`.
- **Snapshot immutability:** the snapshot is written once at intent creation; subsequent strategy changes on the slot do not affect existing intents.

## Adding a new strategy

1. Add a new `StrategyId` literal to the union in `src/services/pricingStrategy.ts`.
2. Define a config interface extending `StrategyConfig`.
3. Implement the pure strategy function.
4. Register it in `REGISTRY`.
5. Add tests in `src/services/__tests__/pricingStrategy.test.ts`.
