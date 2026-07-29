# Supplier Cancellation Overrides

Per-supplier cancellation fee tier overrides. Allows admins to configure custom
cancellation terms for individual suppliers that take precedence over the global
cancellation policy.

## How it works

1. Each supplier (identified by `professional` on `BookingIntentRecord`) can have
   an optional `SupplierCancellationOverride` stored in the in-memory override store.
2. When `CancellationPolicyService.calculateRefund()` runs, it first checks for a
   per-supplier override via `intent.professional`.
3. If an override exists, its terms are used instead of the grandfathered or global
   policy terms.
4. If no override exists, behavior falls back to the existing policy resolution
   (grandfathered snapshot → legacy V1 fallback).

## Tier semantics

Tiers follow **inclusive-lower, exclusive-upper** boundaries:

| Condition                  | Tier selected          |
|----------------------------|------------------------|
| `hours >= minHoursUntilStart` AND `hours < maxHoursUntilStart` | Matching tier |
| `hours >= minHoursUntilStart` AND `maxHoursUntilStart` is undefined | Matching tier (unbounded upper) |
| No tier matches             | `null` — 0 refund, 0 fee |

## API Reference

All endpoints require admin authentication via `x-chronopay-admin-token` header.

### `GET /api/v1/admin/cancellation-overrides`

List all supplier overrides (sorted by `supplierId`).

**Response:**
```json
{
  "success": true,
  "overrides": [
    {
      "supplierId": "prof-1",
      "terms": {
        "tiers": [...],
        "minRefundAmount": 0,
        "maxRefundAmount": 50000
      },
      "createdAt": "2026-07-01T00:00:00.000Z",
      "updatedAt": "2026-07-01T00:00:00.000Z",
      "createdBy": "admin-1",
      "updatedBy": "admin-1",
      "description": "Custom terms for prof-1"
    }
  ]
}
```

### `GET /api/v1/admin/cancellation-overrides/:supplierId`

Get a single supplier override.

**Response:** `200` with the override object, or `404` if not found.

### `PUT /api/v1/admin/cancellation-overrides/:supplierId`

Create or update a supplier override (upsert semantics).

**Body:**
```json
{
  "tiers": [
    {
      "minHoursUntilStart": 48,
      "refundRatio": 1.0,
      "flatFee": 0,
      "taxReversalRatio": 0.1
    },
    {
      "minHoursUntilStart": 24,
      "maxHoursUntilStart": 48,
      "refundRatio": 0.5,
      "flatFee": 25,
      "taxReversalRatio": 0.1
    },
    {
      "minHoursUntilStart": 0,
      "maxHoursUntilStart": 24,
      "refundRatio": 0.0,
      "flatFee": 0,
      "taxReversalRatio": 0.1
    }
  ],
  "minRefundAmount": 0,
  "maxRefundAmount": 50000,
  "description": "Custom terms for premium supplier"
}
```

**Response:** `200` with the created/updated override.

**Validation:**
- `tiers` must be a non-empty array
- Each tier: `refundRatio` in [0,1], `flatFee` ≥ 0, `percentageFee` in [0,1]
- Tiers must not overlap (validated by `validateProratedCancellationTerms`)
- `minRefundAmount` ≤ `maxRefundAmount` when both are set

### `DELETE /api/v1/admin/cancellation-overrides/:supplierId`

Delete a supplier override.

**Response:** `200` with `{ deleted: true }`, or `404` if not found.

## Audit trail

Every mutation (create / update / delete) writes an audit event:

| Action                                  | Event name                                      |
|-----------------------------------------|-------------------------------------------------|
| Override created or updated             | `cancellation_policy.supplier_override`         |
| Override deleted                        | `cancellation_policy.supplier_override_deleted` |

Each audit event includes the `supplierId`, `action`, `changedBy`, `at`,
`previousTerms` (on update/delete), and `newTerms` (on create/update).

## Code location

| File | Purpose |
|------|---------|
| `src/services/supplierCancellationOverrideStore.ts` | Store interface + in-memory implementation |
| `src/services/cancellationPolicy.ts` | Policy service with supplier override resolution |
| `src/routes/admin.ts` | CRUD route handlers |
| `src/services/__tests__/supplierCancellationOverrideStore.test.ts` | Store unit tests |
| `src/services/__tests__/cancellationPolicy.test.ts` | Policy + override integration tests |
| `src/routes/__tests__/admin.cancellation-overrides.test.ts` | Admin route tests |

## Test coverage

- Store: CRUD operations, audit logging, validation, seed data
- Policy integration: override takes precedence, fallback when absent, boundary
  testing (exact boundary hours), no-store-configured case
- Routes: all four CRUD endpoints, auth enforcement, validation errors, edge
  cases
