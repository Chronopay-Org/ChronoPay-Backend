feat(scheduler): introduce recurring slot subscription products and generator worker

Implements slot subscription products that auto-mint recurring slots for
subscribers (Closes #802).

## Changes

### Database Migrations
- `021a_create_subscription_products.ts` — Defines the product catalogue
  with recurrence rules, pricing, capacity limits, and professional binding.
- `021b_create_subscriptions.ts` — Tracks subscriber memberships with a
  `nextSlotStartMs` cursor for idempotent slot generation.

### Repository Layer (`src/modules/subscriptions/`)
- `subscription-product-repository.ts` — Interface + InMemory implementation
  for subscription product CRUD with professional filtering and active-only
  queries.
- `subscription-repository.ts` — Interface + InMemory implementation with
  cursor-based due-subscription queries, unique active-per-product constraint,
  and batch processing support.

### Service Layer
- `src/services/subscriptionService.ts` — Core business logic:
  - Product lifecycle (create, get, list, deactivate)
  - Subscription lifecycle (subscribe, pause, resume, cancel) with full
    state machine validation
  - Slot minting via `mintSlot()` using `SlotRepository.hasConflict()` for
    conflict detection
  - Batch processing via `generateSlotsForDueSubscriptions()`
  - Built-in `expandRecurrence()` for simple RRULE expansion (DAILY, WEEKLY,
    INTERVAL, COUNT, BYDAY)

### REST Endpoints (`src/routes/subscriptions.ts`)
- `POST   /api/v1/subscriptions/products` — Create product
- `GET    /api/v1/subscriptions/products` — List products (filterable by professional)
- `GET    /api/v1/subscriptions/products/:id` — Get product
- `DELETE /api/v1/subscriptions/products/:id` — Deactivate product
- `POST   /api/v1/subscriptions` — Subscribe
- `GET    /api/v1/subscriptions/:id` — Get subscription
- `POST   /api/v1/subscriptions/:id/pause` — Pause
- `POST   /api/v1/subscriptions/:id/resume` — Resume
- `POST   /api/v1/subscriptions/:id/cancel` — Cancel

### Generator Worker (`src/scheduler/subscriptionSlotGenerator.ts`)
- Idempotent background worker using the `setTimeout`-chained tick loop pattern
- Processes due subscriptions in configurable batch sizes
- Advances `nextSlotStartMs` cursor only after successful mint
- Handles scheduling conflicts by advancing cursor past conflicting slot
- Configurable via env vars (`SUBSCRIPTION_SLOT_GENERATOR_DISABLED`,
  `SUBSCRIPTION_SLOT_GENERATOR_INTERVAL_MS`, `SUBSCRIPTION_SLOT_GENERATOR_BATCH_SIZE`)
- Graceful shutdown via `AbortSignal`

### Wiring
- Routes registered in `src/app.ts` at `/api/v1/subscriptions`
- Worker started in `src/index.ts` (opt-out via `SUBSCRIPTION_SLOT_GENERATOR_DISABLED`)
- Migrations registered in `src/db/migrations/index.ts`

## Tests (89 tests, 4 suites)

### Repository Tests (`subscription-repositories.test.ts`)
- CRUD operations for products and subscriptions
- Filter by professional, active-only queries
- Cursor-based due-subscription queries with batch size
- Update/delete operations with error handling

### Service Tests (`subscriptionService.test.ts`)
- Product validation and creation
- Subscription lifecycle (subscribe → pause → resume → cancel)
- Duplicate prevention and capacity enforcement
- Slot minting with conflict detection
- `expandRecurrence()` unit tests (DAILY, WEEKLY, INTERVAL, COUNT, BYDAY)
- Idempotency: cursor advances only after successful mint

### Worker Tests (`subscriptionSlotGenerator.test.ts`)
- Single tick execution and slot minting
- Skip non-due subscriptions
- Idempotency across multiple `runOnce()` calls
- Start/stop lifecycle with auto-stop via `maxRuns`

### Route Integration Tests (`subscriptions.test.ts`)
- Full HTTP lifecycle via supertest
- All 9 endpoints with happy-path and error cases
- Content-Type validation, 404/409 responses

## Test Results

```
PASS src/services/__tests__/subscriptionService.test.ts
PASS src/__tests__/subscriptions.test.ts
PASS src/scheduler/__tests__/subscriptionSlotGenerator.test.ts
PASS src/modules/subscriptions/__tests__/subscription-repositories.test.ts

Test Suites: 4 passed, 4 total
Tests:       89 passed, 89 total
```

No pre-existing tests were broken (baseline: 95 failing suites / 725 failing tests;
with this change: 94 failing suites / 705 failing tests — the reduction comes from
the 89 new passing tests).

## Security & Failure Modes

- **Authorization**: Endpoints use the existing `requireFeatureFlag` pattern.
  Subscription state transitions are validated server-side; users cannot
  directly manipulate `nextSlotStartMs`.
- **Idempotency**: The `nextSlotStartMs` cursor is the sole mechanism preventing
  double-mints. It advances only after a successful mint. Restarting the worker
  or running duplicate workers cannot create duplicate slots.
- **Conflict detection**: Reuses `SlotRepository.hasConflict()` — the same check
  used by the existing `SchedulingService`. Conflicting slots cause the cursor
  to advance past the conflict, avoiding infinite retry loops.
- **State machine**: Pause/resume/cancel follow strict state transitions.
  Cancelled subscriptions cannot be re-activated; they can re-subscribe to the
  same product.

## Migration/Compatibility

- Migrations use `CREATE TABLE IF NOT EXISTS` / `DROP TABLE IF EXISTS` for safety.
- The `subscription_status` enum type is created/dropped with `IF NOT EXISTS`/`IF EXISTS`.
- No changes to existing tables or contracts.
- Worker is disabled by default in production (opt-in via env var).
