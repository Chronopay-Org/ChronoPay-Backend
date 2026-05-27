# Slots API

## Conflict Detection

### Semantics

Two slots for the **same professional** conflict when their time ranges overlap.
The overlap check uses a **half-open interval** model: `[startTime, endTime)`.

| Scenario | Conflict? |
|---|---|
| Identical range | ✅ Yes |
| New slot starts inside existing | ✅ Yes |
| New slot ends inside existing | ✅ Yes |
| New slot fully wraps existing | ✅ Yes |
| New slot fully inside existing | ✅ Yes |
| New slot starts exactly when existing ends (`end == start`) | ❌ No (adjacent) |
| New slot ends exactly when existing starts | ❌ No (adjacent) |
| No time overlap at all | ❌ No |
| Same time range, different professional | ❌ No |

### Error response

When a conflict is detected, the API returns **HTTP 409 Conflict**:

```json
{
  "success": false,
  "error": "Slot overlaps with an existing reservation for this professional"
}
```

### Two-layer defence

Conflict prevention is enforced at two layers:

1. **Service layer** (`SlotService.createSlot` / `updateSlot`)  
   Checks for conflicts in-memory before writing. Returns a fast `409` without
   a DB round-trip on the happy path.

2. **Database layer** (migration `003_add_slot_conflict_exclusion`)  
   A PostgreSQL `EXCLUDE USING gist` constraint on the `slots` table prevents
   overlapping rows from being inserted even under concurrent requests that
   race past the service-layer check.

   ```sql
   ALTER TABLE slots
     ADD CONSTRAINT excl_slots_no_overlap
     EXCLUDE USING gist (
       professional_id WITH =,
       tstzrange(start_time, end_time) WITH &&
     );
   ```

   The `btree_gist` extension is required to mix an equality operator (`=`) with
   a range operator (`&&`) in a single exclusion constraint.

### Security assumptions

- The service layer check is **not** a substitute for the DB constraint. Under
  concurrent load, two requests can both pass the service check before either
  commits. The DB constraint is the authoritative last line of defence.
- The DB constraint fires at statement time (`DEFERRABLE INITIALLY IMMEDIATE`),
  which is the safest default. It cannot be deferred by client code.
- Callers that receive a `409` should **not** retry automatically — the conflict
  is deterministic and will not resolve without a change to the existing slot.

## Endpoints

### `POST /api/v1/slots`

Creates a new slot.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `professional` | string | ✅ | Professional identifier (trimmed before use) |
| `startTime` | number | ✅ | Unix timestamp (ms) — start of the slot |
| `endTime` | number | ✅ | Unix timestamp (ms) — end of the slot (must be > startTime) |

**Responses**

| Status | Meaning |
|---|---|
| `201 Created` | Slot created successfully |
| `400 Bad Request` | Missing required fields or invalid time range |
| `409 Conflict` | Slot overlaps an existing reservation for this professional |
| `503 Service Unavailable` | Feature flag `FF_CREATE_SLOT` is disabled |

### `PATCH /api/v1/slots/:id`

Updates an existing slot. Requires `x-chronopay-admin-token` header.

Conflict detection applies to updates: the updated slot must not overlap any
**other** slot for the same professional. Updating a slot to its own current
range is always allowed (self-exclusion).

**Responses**

| Status | Meaning |
|---|---|
| `200 OK` | Slot updated |
| `400 Bad Request` | Invalid payload or resulting time range |
| `401 Unauthorized` | Missing admin token header |
| `403 Forbidden` | Invalid admin token |
| `404 Not Found` | Slot not found |
| `409 Conflict` | Updated range overlaps another slot |
| `503 Service Unavailable` | Admin token not configured |
