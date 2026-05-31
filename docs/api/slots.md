# Slots API

## Overview

The Slots API provides endpoints for managing time slots that professionals can make available for booking. Slots support conflict detection to prevent overlapping reservations for the same professional.

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
  "code": "CONFLICT",
  "message": "Slot overlaps with an existing reservation for this professional",
  "error": "Slot overlaps with an existing reservation for this professional",
  "timestamp": "2026-01-01T00:00:00.000Z"
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

### `GET /api/v1/slots`

Lists all available slots. Results are served from Redis cache when available (TTL controlled by `REDIS_SLOT_TTL_SECONDS` env var, default 60s). The `X-Cache` response header indicates whether the response was a cache HIT or MISS.

**Authentication**

- Optional: `x-chronopay-user-id` and `x-chronopay-role` headers for authenticated access

**Responses**

| Status | Code | Message | Condition |
|---|---|---|---|
| `200 OK` | - | Slots retrieved successfully | Request succeeded |
| `401 Unauthorized` | `UNAUTHORIZED` | Authentication required | Missing auth headers (if required) |
| `403 Forbidden` | `FORBIDDEN` | Role is not authorized for this action | Invalid role |

**Success response**

```json
{
  "slots": [
    {
      "id": 1,
      "professional": "alice",
      "startTime": 1704067200000,
      "endTime": 1704070800000,
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

**Response headers**

- `X-Cache`: `HIT` or `MISS` - indicates cache status

### `POST /api/v1/slots`

Creates a new slot. Requires API key authentication for service access.

**Authentication**

- Required: `x-api-key` header

**Rate limiting**

- Protected by auth-aware rate limiter

**Payload limit**

- Maximum payload size: `32kb`

**Idempotency**

- Protected by idempotency middleware to prevent duplicate creations

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `professional` | string | ✅ | Professional identifier |
| `startTime` | string or number | ✅ | Start time (ISO-8601 string or Unix timestamp in ms) |
| `endTime` | string or number | ✅ | End time (ISO-8601 string or Unix timestamp in ms, must be > startTime) |

**Responses**

| Status | Code | Message | Condition |
|---|---|---|---|
| `201 Created` | - | Slot created successfully | Slot created |
| `400 Bad Request` | `BAD_REQUEST` | Missing required fields | Missing professional, startTime, or endTime |
| `400 Bad Request` | `BAD_REQUEST` | endTime must be greater than startTime | Invalid time range |
| `400 Bad Request` | `BAD_REQUEST` | Slot validation error | Service layer validation failed |
| `401 Unauthorized` | `UNAUTHORIZED` | Missing API key | Missing x-api-key header |
| `403 Forbidden` | `FORBIDDEN` | Invalid API key | Invalid x-api-key |
| `409 Conflict` | `CONFLICT` | Slot overlaps with an existing reservation | Conflict detected |
| `413 Payload Too Large` | `PAYLOAD_TOO_LARGE` | Request body exceeds the 32kb limit | Payload exceeds 32kb |
| `429 Too Many Requests` | `TOO_MANY_REQUESTS` | Rate limit exceeded | Too many requests |
| `500 Internal Server Error` | `INTERNAL_ERROR` | Slot creation failed | Unexpected error |

**Success response**

```json
{
  "success": true,
  "slot": {
    "id": 1,
    "professional": "alice",
    "startTime": 1704067200000,
    "endTime": 1704070800000,
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "meta": {
    "invalidatedKeys": ["slots:all", "slots:list:all"]
  }
}
```

### `GET /api/v1/slots/:id`

Returns a single slot by ID. Attempts to read from cache first, then falls back to data store.

**Authentication**

- Optional: `x-chronopay-user-id` and `x-chronopay-role` headers for authenticated access

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | integer | ✅ | Slot ID (path parameter) |

**Responses**

| Status | Code | Message | Condition |
|---|---|---|---|
| `200 OK` | - | Slot found | Slot retrieved successfully |
| `400 Bad Request` | `BAD_REQUEST` | Invalid slot id | ID is not a positive integer |
| `401 Unauthorized` | `UNAUTHORIZED` | Authentication required | Missing auth headers (if required) |
| `403 Forbidden` | `FORBIDDEN` | Role is not authorized for this action | Invalid role |
| `404 Not Found` | `NOT_FOUND` | Slot not found | Slot does not exist |

**Success response**

```json
{
  "slot": {
    "id": 1,
    "professional": "alice",
    "startTime": 1704067200000,
    "endTime": 1704070800000,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Response headers**

- `X-Cache`: `HIT` or `MISS` - indicates cache status

### `PATCH /api/v1/slots/:id`

Updates an existing slot. Requires admin token authentication.

**Authentication**

- Required: `x-chronopay-admin-token` header

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | integer | ✅ | Slot ID (path parameter) |

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `professional` | string | ❌ | New professional identifier |
| `startTime` | string or number | ❌ | New start time |
| `endTime` | string or number | ❌ | New end time |

At least one field must be provided.

**Responses**

| Status | Code | Message | Condition |
|---|---|---|---|
| `200 OK` | - | Slot updated | Update successful |
| `400 Bad Request` | `BAD_REQUEST` | slotId must be a positive integer | Invalid ID format |
| `400 Bad Request` | `BAD_REQUEST` | Missing required header: x-chronopay-admin-token | Missing admin token |
| `400 Bad Request` | `BAD_REQUEST` | update payload must include at least one field | No fields provided |
| `400 Bad Request` | `BAD_REQUEST` | Slot validation error | Service layer validation failed |
| `401 Unauthorized` | `UNAUTHORIZED` | Missing required header: x-chronopay-admin-token | Missing admin token |
| `403 Forbidden` | `FORBIDDEN` | Invalid admin token | Invalid admin token |
| `404 Not Found` | `NOT_FOUND` | Slot {id} was not found | Slot does not exist |
| `409 Conflict` | `CONFLICT` | Slot overlaps with an existing reservation | Updated range conflicts |
| `503 Service Unavailable` | `SERVICE_UNAVAILABLE` | Update slot authorization is not configured | Admin token not configured |
| `500 Internal Server Error` | `INTERNAL_ERROR` | Slot update failed | Unexpected error |

**Success response**

```json
{
  "success": true,
  "slot": {
    "id": 1,
    "professional": "alice",
    "startTime": 1704067200000,
    "endTime": 1704070800000,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### `DELETE /api/v1/slots/:id`

Deletes an existing slot. Requires owner or admin authentication.

**Authentication**

- Required: `x-user-id` and `x-role` headers
- Allowed roles: `admin` (can delete any slot)
- Owners: Professionals can delete their own slots

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | integer | ✅ | Slot ID (path parameter) |

**Responses**

| Status | Code | Message | Condition |
|---|---|---|---|
| `200 OK` | - | Slot deleted | Deletion successful |
| `400 Bad Request` | `BAD_REQUEST` | Invalid slot id | ID is not a positive integer |
| `400 Bad Request` | `BAD_REQUEST` | Caller identity is required | Missing x-user-id and x-role |
| `401 Unauthorized` | `UNAUTHORIZED` | Authentication required | Missing auth headers |
| `403 Forbidden` | `FORBIDDEN` | Access denied | Not owner or admin |
| `404 Not Found` | `NOT_FOUND` | Slot not found | Slot does not exist |

**Success response**

```json
{
  "success": true,
  "deletedSlotId": 1
}
```

## Caching

- List endpoint (`GET /api/v1/slots`) is cached in Redis
- Individual slot retrieval (`GET /api/v1/slots/:id`) attempts cache first
- Cache is invalidated on POST, PATCH, and DELETE operations
- Cache TTL is controlled by `REDIS_SLOT_TTL_SECONDS` environment variable (default: 60s)

## Security considerations

- POST endpoint requires API key authentication
- PATCH endpoint requires admin token
- DELETE endpoint requires authentication and authorization (owner or admin)
- Payload size is limited to 32kb to reduce abuse surface
- Rate limiting is applied to prevent abuse
- Conflict detection prevents overlapping slots for the same professional
- Self-booking is prevented in booking intents (professionals cannot book their own slots)
