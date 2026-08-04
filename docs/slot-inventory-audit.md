# Slot Inventory Audit Log

> Implements issue #599 — immutable audit trail for all administrator slot inventory adjustments.

## Audit Schema

Every successful admin mutation produces a `SlotAuditRecord`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique audit record ID |
| `actor` | `string` | Admin user ID from authenticated context (never client-supplied) |
| `timestamp` | `string` | ISO-8601 creation time (server-set) |
| `action` | `"create" \| "update" \| "delete"` | The mutation performed |
| `resourceId` | `string` | The affected slot ID |
| `before` | `object \| null` | Slot state **before** mutation (`null` for creates) |
| `after` | `object \| null` | Slot state **after** mutation (`null` for deletes) |
| `reason` | `string` | Mandatory admin justification (≥ 10 chars, trimmed) |
| `requestMeta.ip` | `string?` | Client IP address (if available) |
| `requestMeta.requestId` | `string?` | `x-request-id` header value (if present) |

Records are **frozen** (`Object.freeze`) and append-only — they cannot be modified or deleted through any API.

---

## Required `reason` Field

Every mutation request **must** include `reason` in the request body.

**Validation rules:**
- Required (missing → `400`)
- Must not be whitespace-only (→ `400`)
- Minimum 10 characters after trimming (→ `400`)

**Example:**
```json
{ "reason": "Removing duplicate slot from Q3 capacity batch" }
```

---

## Admin Slot Mutation Endpoints

All endpoints require admin authentication (see [Security](#security)).

### `POST /api/v1/admin/slots`
Create a new slot inventory entry.

**Body:** all standard slot fields + `reason`

| Status | Meaning |
|---|---|
| `201` | Slot created; audit record written |
| `400` | Missing or invalid `reason` |
| `422` | Slot validation failure |
| `401/403` | Auth failure |

### `PATCH /api/v1/admin/slots/:id`
Update a slot inventory entry.

| Status | Meaning |
|---|---|
| `200` | Slot updated; audit record written (or skipped if no-op) |
| `400` | Missing or invalid `reason` |
| `404` | Slot not found; no audit record written |
| `422` | Validation failure |

### `DELETE /api/v1/admin/slots/:id`
Delete a slot inventory entry.

**Body:** `{ "reason": "..." }`

| Status | Meaning |
|---|---|
| `200` | Slot deleted; audit record written |
| `400` | Missing or invalid `reason` |
| `404` | Slot not found; no audit record written |

---

## Audit Feed Endpoint

### `GET /api/v1/admin/audit/slots`

Returns a paginated feed of slot audit records, **newest first**.

**Authentication:** Admin only (same as mutation routes).
**Read-only:** No mutation is possible through this endpoint.

#### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | 1-based page number |
| `limit` | integer 1–200 | `20` | Results per page |
| `actor` | string | — | Filter by admin user ID |
| `action` | `create\|update\|delete` | — | Filter by action type |
| `resourceId` | string | — | Filter by slot ID |
| `since` | ISO-8601 | — | Lower bound for `timestamp` |
| `until` | ISO-8601 | — | Upper bound for `timestamp` |

#### Response Shape

```json
{
  "success": true,
  "data": [ /* SlotAuditRecord[] */ ],
  "page": 1,
  "limit": 20,
  "total": 42
}
```

#### Stable Pagination

Results are always returned newest-first by insertion order. Appending new records does not shift existing page boundaries.

---

## Security

| Concern | Mitigation |
|---|---|
| Admin-only access | All routes require `x-chronopay-admin-token` or `x-chronopay-role: admin` |
| Actor identity | Always read from `req.auth.userId` — body fields named `actor` are ignored |
| Before/after forgery | Snapshots are captured server-side from `slotService`, never from request body |
| Immutability | Records are `Object.freeze`-d; no update/delete API exists |
| Audit-feed tampering | Feed is read-only; no write methods are exposed on the endpoint |

---

## Rollback Behaviour

The `audit()` helper guarantees:

1. **Mutation fails** → no audit record is written (atomic — the record is only persisted after a successful mutation).
2. **Audit persistence fails after successful mutation** → `500` is returned to the caller so the discrepancy is surfaced. The slot mutation is not reversed.

---

## No-op Update Handling

If a `PATCH` request sends values that are **identical** to the current slot state, the `audit()` helper detects this by comparing serialised before/after JSON strings. No audit record is written and the normal `200` response is returned.

This prevents noise in the audit feed from automated scripts that speculatively send updates.

---

## Implementation Files

| File | Purpose |
|---|---|
| `src/services/slotAuditLog.ts` | `SlotAuditLogService`, `audit()` helper, `validateReason()` |
| `src/routes/admin/slots.ts` | Admin slot mutation routes + audit feed endpoint |
| `src/routes/__tests__/admin.slots.audit.test.ts` | Comprehensive test suite |
