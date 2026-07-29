# Refundable Hold Expiry Sweeper

## Overview

The `RefundableHoldSweeper` is a background worker in `src/scheduler/refundableHoldSweeper.ts` that periodically scans for expired refundable holds and releases slot capacity back to the marketplace.

When buyers reserve slot capacity under a refundable hold (e.g. during intent creation or escrow lock), slots are marked as non-bookable. If a hold passes its deadline (`expiresAt`) without buyer confirmation, the sweeper restores slot inventory promptly so the slots re-appear in marketplace search results.

---

## Architecture & Workflow

```
[ Active Holds ]
      │
      ▼
┌──────────────────────────────────────┐
│  RefundableHoldSweeper.sweepOnce()   │
└──────────────────────────────────────┘
      │
      ├─ 1. Filter active holds where expiresAt <= now
      ├─ 2. Skip holds for paused tenants (schedulingService.pausedTenants)
      ├─ 3. Check safety brake (if total candidates > safetyThreshold, skip)
      ├─ 4. Fair scheduling (round-robin sampling across tenants up to batchSize)
      ├─ 5. Re-verify hold status (race condition check against buyer confirm)
      ├─ 6. Call schedulingService.releaseSlot(slotId)
      ├─ 7. Mark hold status as 'expired'
      ├─ 8. Emit 'hold_released' event on holdReleaseEvents EventEmitter
      │     └─ Invalidates slot search cache (slotCache.invalidateSlotsCache)
      └─ 9. Record Prometheus release lag metric against deadline
```

---

## Key Features & Guarantees

### 1. Fair Scheduling Across Tenants
During high-volume backlog conditions, expired holds are grouped by tenant. A round-robin fair distribution algorithm samples items iteratively from each tenant's bucket up to `batchSize`. Optional `maxPerTenantPerBatch` caps maximum slots processed per tenant per tick, ensuring no single tenant starves others.

### 2. Race Condition Protection (Buyer Confirm)
Before mutating slot state, the worker re-queries `deps.holdRepository.findById(candidate.id)` to re-verify that the hold status is still `"active"`. If a buyer confirmed or captured the payment concurrently, the status will no longer be `"active"`, and the sweep skips that hold safely.

### 3. Tenant Pausing Support
When a tenant's operations or escrow contract are paused (`deps.schedulingService.pausedTenants.has(tenantId)`), candidate holds for that tenant are skipped during the sweep and left untouched until the tenant is unpaused.

### 4. Search Cache Invalidation
Releasing slot capacity emits a `hold_released` event on the `holdReleaseEvents` bus. Subscribed handlers automatically invoke `invalidateSlotsCache()` from `src/cache/slotCache.ts` to invalidate Redis/in-memory marketplace search cache entries immediately.

### 5. Prometheus Observability
The worker reports:
- `refundable_hold_release_lag_seconds`: Histogram measuring lag between hold expiry deadline (`expiresAt`) and actual release time (`nowMs`).
- `refundable_holds_released_total`: Counter tracking total expired holds released per tenant.
- `refundable_hold_sweeper_safety_brake_triggers_total`: Counter tracking sweep runs skipped because candidate count exceeded `safetyThreshold`.

---

## Configuration

| Option | Environment Variable / Default | Description |
| :--- | :--- | :--- |
| `batchSize` | `100` | Max holds released in a single tick |
| `safetyThreshold` | `10,000` | Max eligible candidates before tripping safety brake |
| `intervalMs` | `5,000` (5s) | Worker loop polling interval |
| `maxPerTenantPerBatch` | `Infinity` | Max items allowed per tenant per batch tick |

---

## Usage Example

```typescript
import {
  runRefundableHoldSweeper,
  sweepRefundableHoldExpiryOnce,
  InMemoryRefundableHoldRepository,
} from "./scheduler/refundableHoldSweeper.js";

const abortController = new AbortController();

// Run single sweep
await sweepRefundableHoldExpiryOnce({
  holdRepository,
  schedulingService,
});

// Run background loop
runRefundableHoldSweeper(abortController.signal, {
  holdRepository,
  schedulingService,
}, { batchSize: 50 });
```
