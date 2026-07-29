# No-Show Grace-Window Configuration

Per-slot-category configurable grace windows that control how long the system
waits after a slot's scheduled start time before triggering a no-show
evaluation.

---

## Overview

Different appointment categories tolerate different amounts of lateness.
A medical consultation might allow 10 minutes; a fitness class might only allow
2 minutes.  The grace-window config lets admins set this threshold per category
without a code change.

**Resolution order (highest → lowest priority):**

1. Category-specific override (set via the admin API)
2. System default — **900 seconds (15 minutes)**

All values are in **seconds**, not minutes.

---

## Slot Categories

A slot's category is stored in the `category` field on the `SlotRecord` (and in
the `slots.category` DB column added by migration `016`).  Any non-empty string
is a valid category name (max 100 characters).  Well-known built-in values:

| Category      | Description                         |
|---------------|-------------------------------------|
| `medical`     | Medical appointments                |
| `fitness`     | Gym classes, personal training      |
| `beauty`      | Hair, nail, spa appointments        |
| `legal`       | Legal consultations                 |
| `tutoring`    | Academic tutoring sessions          |
| `hospitality` | Restaurant / hotel bookings         |
| `other`       | Catch-all                           |

Custom categories are supported — just use any string as the `category` value.

---

## Grace-Window Constraints

| Constraint              | Value                |
|-------------------------|----------------------|
| Minimum                 | 1 second             |
| Maximum                 | 86 400 seconds (24 h)|
| Type                    | Integer seconds      |
| Default (no override)   | 900 seconds (15 min) |

---

## Admin API

All endpoints require the `x-chronopay-admin-token` header.

---

### List All Configured Categories

```
GET /api/v1/admin/slot-categories/grace-windows
```

Returns all categories that have an explicit override.  Categories using the
default are **not** listed here (they never have an entry).

**Response 200**
```json
{
  "success": true,
  "configs": [
    {
      "category": "medical",
      "graceWindowSeconds": 600,
      "updatedBy": "admin@example.com",
      "updatedAt": "2026-07-28T12:00:00.000Z"
    }
  ],
  "defaultGraceWindowSeconds": 900
}
```

---

### Get Effective Grace Window for a Category

```
GET /api/v1/admin/slot-categories/:category/grace-window
```

Returns the effective grace window for the given category, whether it comes
from an explicit config or the system default.

**Response 200**
```json
{
  "success": true,
  "category": "medical",
  "graceWindowSeconds": 600,
  "isDefault": false,
  "defaultGraceWindowSeconds": 900,
  "config": {
    "category": "medical",
    "graceWindowSeconds": 600,
    "updatedBy": "admin-1",
    "updatedAt": "2026-07-28T12:00:00.000Z"
  }
}
```

When `isDefault` is `true`, the category has no explicit override and the
system default applies; `config` will be `null`.

---

### Set or Update Grace Window for a Category

```
PUT /api/v1/admin/slot-categories/:category/grace-window
```

Creates a new config or updates an existing one.  Every call appends an
immutable history entry and emits an audit event.

**Request body**
```json
{
  "graceWindowSeconds": 600,
  "reason": "Medical clients often need extra time to park"
}
```

| Field                | Type    | Required | Constraints                        |
|----------------------|---------|----------|------------------------------------|
| `graceWindowSeconds` | integer | ✅        | 1 – 86 400                        |
| `reason`             | string  | ❌        | Max 500 characters                 |

**Response 200**
```json
{
  "success": true,
  "config": {
    "category": "medical",
    "graceWindowSeconds": 600,
    "updatedBy": "admin-token-value",
    "updatedAt": "2026-07-28T12:00:00.000Z"
  }
}
```

**Error responses**

| Status | Condition                                 |
|--------|-------------------------------------------|
| 400    | `graceWindowSeconds` missing              |
| 401    | Missing admin token                       |
| 403    | Invalid admin token                       |
| 422    | Validation failure (wrong type / range)   |

---

### Delete Grace Window Override

```
DELETE /api/v1/admin/slot-categories/:category/grace-window
```

Removes the category-specific override.  The category reverts to the system
default.  A history entry is still written (deletion is audited).

**Request body (optional)**
```json
{ "reason": "Reverting to default" }
```

**Response 200**
```json
{
  "success": true,
  "message": "Grace window config for \"medical\" deleted. Reverted to default (900s).",
  "defaultGraceWindowSeconds": 900
}
```

**Response 404** — returned when the category had no explicit config.

---

### Get Change History for a Category

```
GET /api/v1/admin/slot-categories/:category/grace-window/history
```

Returns the immutable change log for the given category, most-recent first.

**Query parameters**

| Param    | Default | Max | Description         |
|----------|---------|-----|---------------------|
| `limit`  | 50      | 200 | Results per page    |
| `offset` | 0       | —   | Pagination offset   |

**Response 200**
```json
{
  "success": true,
  "category": "medical",
  "history": [
    {
      "id": "a1b2c3d4-...",
      "category": "medical",
      "previousGraceWindowSeconds": 900,
      "newGraceWindowSeconds": 600,
      "changedBy": "admin-1",
      "changedAt": "2026-07-28T12:00:00.000Z",
      "reason": "Medical clients need more time"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

`previousGraceWindowSeconds` is `null` for the first-ever write on a category.

---

### Get Change History Across All Categories

```
GET /api/v1/admin/slot-categories/grace-windows/history
```

Same shape as the per-category history endpoint but includes all categories.
Supports the same `limit` / `offset` pagination.

---

## Security

- All endpoints require a valid admin token (`x-chronopay-admin-token`).
- Every write (create, update, delete) is recorded in an append-only
  `slot_category_grace_window_history` table and emitted as a structured audit
  event via the application audit logger.
- Grace-window values are validated server-side before persistence; the DB also
  carries CHECK constraints as a last-line-of-defence.
- The `changedBy` actor ID is derived from the authenticated request (JWT `userId`
  when available, otherwise the admin token value as a stable identifier).

---

## Database Schema

Migration `016_add_grace_window_config` adds:

```sql
-- Current effective config per category (one row per category)
CREATE TABLE slot_category_grace_windows (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category             TEXT        NOT NULL,
  grace_window_seconds INTEGER     NOT NULL,
  updated_by           TEXT        NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_grace_windows_category UNIQUE (category),
  CONSTRAINT chk_grace_window_positive CHECK (grace_window_seconds >= 1),
  CONSTRAINT chk_grace_window_max      CHECK (grace_window_seconds <= 86400)
);

-- Append-only audit history (never updated or deleted)
CREATE TABLE slot_category_grace_window_history (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category                      TEXT        NOT NULL,
  previous_grace_window_seconds INTEGER,
  new_grace_window_seconds      INTEGER     NOT NULL,
  changed_by                    TEXT        NOT NULL,
  changed_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason                        TEXT
);

-- Nullable category column on slots
ALTER TABLE slots ADD COLUMN category TEXT;
```

---

## Integration with No-Show Detection

`SchedulingService` exposes two helpers:

```ts
// Returns the effective grace window in seconds for a slot's category.
scheduler.resolveGraceWindow(slotId: string): number

// Returns the epoch-ms timestamp after which a no-show evaluation should fire.
// deadline = slot.startTime + graceWindowSeconds * 1000
scheduler.noShowDeadlineMs(slotId: string): number
```

The no-show evaluation job calls `noShowDeadlineMs()` to determine when to
invoke `NoShowDetector.evaluate()`.  Until the deadline passes the slot is still
within the grace window and no penalty is applied.

---

## Audit Events

| Action                        | When                                  |
|-------------------------------|---------------------------------------|
| `grace_window.config_changed` | On every PUT (create or update)       |
| `grace_window.config_deleted` | On every DELETE                       |

Each event is written to `logs/audit.log` in the standard `AuditEventV1`
envelope (`version: "1.0.0"`).
