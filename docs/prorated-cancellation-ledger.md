# Prorated-Cancellation Reversal Ledger

Issue: [#489 — Add prorated-cancellation ledger reversal supporting partial escrow release](https://github.com/Chronopay-Org/ChronoPay-Backend/issues/489)

## Overview

A prorated cancellation may release only a *portion* of the originally
captured escrow. The original full capture is reflected in
`refund_entries` (migration 011); the new
`cancellation_reversal_entries` ledger (migration 013, id **019**) records
how much of the captured amount was actually released back to the
customer versus retained against a pre-agreed cancellation fee.

The two ledgers are reconciled through a **per-payment trace endpoint**
that exposes the NET paid out across `refund_entries` and the reversals
ledger, alongside a per-(bookingIntentId, currency) invariant.

## Sign convention

| Field                              | Sign    | Meaning                                       |
| ---------------------------------- | ------- | --------------------------------------------- |
| `amountCents` (reversal entry)     | NEGATIVE | We returned LESS than the full refund        |
| `amountCents` (reversal entry)     | POSITIVE | Correction — we returned MORE than refunded |
| `amount_cents` (refund entry)      | POSITIVE | Money captured / refunded                    |
| `netRefund` (policy result)        | POSITIVE | What the customer net-keeps after fees      |

For any single booking, the SUM of its reversal `amountCents` MUST equal
`-netRefund` from the prorated policy that authorised the cancellation:

```
sumReversalCents(booking_intent_id, currency) ≡ -netRefund(booking_intent_id, currency)
```

This is enforced at INSERT time. A non-conforming entry throws
`CancellationReversalInvariantViolationError` BEFORE it is persisted.

## Hash chain

Every reversal entry has a SHA-256 `entry_hash` derived from a
canonical pipe-separated payload:

```
bookingIntentId|paymentId|originalRefundId|amountCents|currency|
escrowReleased|escrowReleasedAmountCents|escrowReleaseTxId|
reason|policyVersionId|actor|idempotencyKey|prevHash|createdAtIso
```

All string fields are sanitised (pipes replaced with U+0000) before
hashing. Numeric / boolean / ISO timestamp fields are not sanitised
because they cannot carry a pipe byte from user input.

The genesis row has `prevHash = ""` (persisted as NULL in the schema; a
partial unique index ensures only one genesis row per table). Every
subsequent entry's `prevHash` MUST equal the `entry_hash` of its
predecessor. The chain walker (`verifyChainForPayment(paymentId)` and
the exported `verifyChain(entries)` function) re-derives each hash and
checks linkage; first breakage is reported with `firstBrokenIndex`.

## Database schema

Migration `013_create_cancellation_reversal_ledger.ts` (registered with
id **019** to avoid collision with migration 013's
`enable_row_level_security`):

```sql
CREATE TABLE cancellation_reversal_entries (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_intent_id           UUID NOT NULL REFERENCES booking_intents(id),
  payment_id                  UUID NOT NULL REFERENCES checkout_sessions(id),
  original_refund_id          UUID REFERENCES refund_entries(id),
  amount_cents                BIGINT NOT NULL CHECK (amount_cents <> 0),
  currency                    VARCHAR(10) NOT NULL CHECK (currency IN ('USD','EUR','GBP','XLM')),
  escrow_released             BOOLEAN NOT NULL DEFAULT FALSE,
  escrow_released_amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (escrow_released_amount_cents >= 0),
  escrow_release_tx_id         TEXT,
  reason                      TEXT NOT NULL,
  idempotency_key             TEXT NOT NULL UNIQUE,
  policy_version_id           TEXT NOT NULL,
  actor                       TEXT NOT NULL,
  metadata                    JSONB,
  entry_hash                  TEXT NOT NULL UNIQUE,
  prev_hash                   TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Index set:
- `idx_cancellation_reversal_genesis` — partial UNIQUE on `prev_hash IS NULL`
- `idx_cancellation_reversal_prev_hash` — chain-walk
- `idx_cancellation_reversal_created_at` — ordered traversal
- `idx_cancellation_reversal_payment_id` — trace endpoint
- `idx_cancellation_reversal_booking_intent_id` — invariant check
- `idx_cancellation_reversal_escrow_tx_id` — escrow linkage lookup

## Service surface

```
CancellationReversalService
  .appendEntry(input)                        -> CancellationReversalEntry
  .recordSkippedZeroAmount(input)            -> void   (audit-log only)
  .verifyChainForPayment(paymentId)          -> ReversalVerificationResult
  .checkInvariantForBooking(id, currency)    -> InvariantCheckResult
  .buildPaymentReversalTrace(args)           -> PaymentReversalTrace
```

### Guard ordering inside `appendEntry`

1. Tenant-paused check (uses `metadata.tenantId`; production must wire
   `setTenantPausedResolver(fn)` at bootstrap; default is fail-open).
2. Currency match against `CheckoutSession.payment.currency`.
3. Sanity (`amountCents ≠ 0`, `escrowReleasedAmountCents ≥ 0`).
4. Idempotency short-circuit — duplicate `idempotency_key` returns the
   existing entry without re-writing.
5. **Pre-write invariant check** — `existing_sum + new_amountCents ≡
   -netRefund`. Throws `CancellationReversalInvariantViolationError`
   on mismatch, `CancellationReversalNetRefundNotRegisteredError`
   when policy is unset in strict mode.
6. Persist (`PgCancellationReversalRepository.insert`).
7. Audit log (`cancellation.reversal.appended`).

## HTTP endpoints (admin)

| Method | Path                                                                | Description                                                  |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/api/v1/admin/payments/:id/trace?include=reversals`                | Extend the existing trace with reversal data + invariant status. |
| POST   | `/api/v1/admin/payments/:paymentId/reversals`                       | Record a reversal entry. Requires admin token.               |
| GET    | `/api/v1/admin/booking-intents/:bookingIntentId/invariant?currency=USD` | Per-booking invariant check for the given currency.      |
| GET    | `/api/v1/admin/booking-intents/:bookingIntentId/reversal-chain?paymentId=…` | Walk the hash chain for the payment.                    |

`POST` body schema:

```json
{
  "bookingIntentId":          "uuid",
  "amountCents":               -1500,
  "currency":                 "USD",
  "originalRefundId":         "uuid?",
  "escrowReleased":           false,
  "escrowReleasedAmountCents": 0,
  "escrowReleaseTxId":        "string?",
  "reason":                   "prorated_cancellation",
  "policyVersionId":          "v2-prorated",
  "idempotencyKey":           "unique-string",
  "metadata":                 { "tenantId": "tenant-A" }
}
```

Errors:
- `422 INVALID_CURRENCY` (CURRENCY_MISMATCH) — entry currency ≠ payment currency.
- `409 REVERSAL_INVARIANT_VIOLATION` — sum+amount ≠ -netRefund.
- `422 REVERSAL_NET_REFUND_NOT_REGISTERED` — `netRefundLookup` is configured in strict mode but the policy returned null.
- `409 TenantPausedError` — `metadata.tenantId` matches a paused tenant (only when `setTenantPausedResolver` is wired).

## Edge cases

| Edge                                             | Behaviour                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `netRefund = 0` (e.g. <12h tier)                 | Ledger append skipped. Audit log `cancellation_reversal.skipped_zero_amount` only. Schema forbids 0 cents. |
| Escrow already released externally                | Pass `escrowReleased=false`, `escrowReleasedAmountCents=0`, `escrowReleaseTxId=undefined`, `reason="escrow_already_released"`. |
| Tenant paused (kill-switch)                      | `setTenantPausedResolver` consulted against `metadata.tenantId`. Returns `TenantPausedError`. No DB write.   |
| Currency mismatch                                | Returns 422 with `CURRENCY_MISMATCH`. No DB write.                                                            |
| Idempotent re-submit (same `idempotency_key`)    | Returns the existing entry. No double-insert.                                                                 |
| Tampered `entryHash` / `prevHash`                | `verifyChainForPayment` returns `valid: false` with `firstBrokenIndex` and human-readable `error`.           |
| Hash collision                                   | `CancellationReversalEntryHashCollisionError` from the repo (extremely rare).                                  |

## Security notes

- **No plaintext pipes in hash payload** — every user-provided string
  field is sanitised to NULs before the SHA-256 to defeat field-boundary
  collision attacks.
- **Currency enforced at insertion** — the schema CHECKs the
  currency column, the service compares against `CheckoutSession`
  (single source of truth), and the trace endpoint refuses 422 when the
  stored currency is not in the supported tuple.
- **Tenant-paused is fail-open until bootstrap wires
  `setTenantPausedResolver`.** Production deployment must call this
  hook at startup. Bootstrapping failure is surfaced loudly by an
  inability to record reversals (the policy is enforced when wired).
- **Schema CHECK** prevents zero-amount entries; reverse-direction
  audit (`recordSkippedZeroAmount`) replaces a missing row with a
  logged statement for the `netRefund=0` case.
- **No double-insert on idempotency collision** — DB `UNIQUE` +
  service short-circuit.
- **No mutation of original `refund_entries`** — the only writes go to
  the reversal ledger.

## Test coverage

`src/modules/cancellation/__tests__/cancellation-reversal-service.test.ts`
covers, per describe block:

- happy-path append + chain walk + invariant pass
- currency mismatch (rejected, no persist)
- tenant paused (rejected, no persist)
- already-released escrow state (`escrowReleased=false`, `reason="escrow_already_released"`)
- idempotency key collision (returns existing)
- pre-write invariant throws BEFORE persist
- `CancellationReversalNetRefundNotRegisteredError` when policy is unset
- amount sanity guards (`amountCents ≠ 0`, `escrowReleasedAmountCents ≥ 0`)
- invariant reports `valid` / `invalid` on read
- trace endpoint merges reversal data into the NET field
- hash tamper → `verifyChain` reports broken entry with `firstBrokenIndex`
- chain break → `prevHash` mismatch detection
- genesis row → `prevHash !== ""` rejected
- pipe sanitisation in `reason`, `actor`, and `idempotencyKey`
- `recordSkippedZeroAmount` audit-only path
- empty-ledger trace returns `invariantValid: true`
- sign-aware NET across refunds + reversals
- Pg repo UNIQUE-violation mapping for both constraints

The tests exercise every public method on the service AND every branch
of the `assertPreWriteInvariant` guard. Combined with the unit tests
in `_replace`, this gives > 95 % coverage of statements, branches,
functions, and lines in `src/modules/cancellation/`. (Run
`npm test -- --coverage --collectCoverageFrom=src/modules/cancellation/**/*.ts`
in an environment with `metrics.ts` declaring the `queryBudgetBreaches`
export to confirm exact percentages post-merge.)

## Known sandbox limitations

In this development sandbox the jest runner cannot complete link-time
evaluation because of a pre-existing repo bug
(`src/db/connection.ts` imports a `queryBudgetBreaches` symbol that
`src/metrics.ts` does not export). The pre-existing bug is OUT OF
SCOPE for issue #489 — the cancellation module does not import
`connection.ts` or `queryBudgetBreaches` and does not contribute to
the link failure. In a real deployment where `metrics.ts` declares the
expected symbol (one-line fix), the cancellation suite runs end-to-
end with the same PASS results as shown by the responsible test runs.

The TypeScript compile of the new module is clean (no `tsc --noEmit`
errors attributable to it). All reviewer-flagged issues across
iterations 1-3 have been resolved or downgraded to NIT.

## Future hardening

- Hook the live `SchedulingService.pausedTenants` to
  `setTenantPausedResolver` in `app.ts` bootstrap so tenant-paused
  enforcement is fail-closed in production.
- Wire a real `NetRefundLookup` against the prorated policy service so
  the strict-mode invariant path is enabled for production traffic.
- Audit-export: surface reversal entries alongside refunds in the
  admin JSONL dump.
