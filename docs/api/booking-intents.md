# Booking Intents API

## Overview

The Booking Intents API allows customers to express intent to book a professional's available time slot. This endpoint is feature-flagged for safe rollout and includes strict validation, rate limiting, and security controls.

## Endpoint

### POST /api/v1/booking-intents

Create a new booking intent for a specific slot.

**Feature Flag:** `FF_CREATE_BOOKING_INTENT` (default: disabled)

**Authentication:** Required

- Header: `x-chronopay-user-id` (string, required)
- Header: `x-chronopay-role` (string, required, one of: `customer`, `admin`)

**Rate Limit:** 10 requests per 15 minutes per IP

## Request

### Headers

```
x-chronopay-user-id: customer-123
x-chronopay-role: customer
Content-Type: application/json
```

### Body

```json
{
  "slotId": "slot-100",
  "note": "Window seat please"
}
```

#### Fields

| Field    | Type   | Required | Constraints                              | Description                               |
| -------- | ------ | -------- | ---------------------------------------- | ----------------------------------------- |
| `slotId` | string | Yes      | 3-64 alphanumeric chars, hyphens allowed | ID of the slot to book                    |
| `note`   | string | No       | Max 500 characters                       | Optional booking note or special requests |

## Response

### Success (201 Created)

```json
{
  "success": true,
  "intent": {
    "id": "intent-1",
    "slotId": "slot-100",
    "customerId": "customer-123",
    "professional": "alice",
    "startTime": 1900000000000,
    "endTime": 1900003600000,
    "status": "pending",
    "note": "Window seat please",
    "createdAt": "2026-01-01T12:00:00.000Z"
  }
}
```

### Error Responses

#### 400 Bad Request

Invalid payload or validation error.

```json
{
  "success": false,
  "error": "slotId format is invalid."
}
```

Common validation errors:

- `slotId is required.`
- `slotId format is invalid.` (must be 3-64 alphanumeric chars with hyphens)
- `note must be a string when provided.`
- `note cannot be empty when provided.`
- `note must be 500 characters or fewer.`

#### 401 Unauthorized

Missing or invalid authentication.

```json
{
  "success": false,
  "error": "Authentication required."
}
```

#### 403 Forbidden

User lacks permission or business rule violation.

```json
{
  "success": false,
  "error": "You cannot create a booking intent for your own slot."
}
```

Common forbidden errors:

- `You cannot create a booking intent for your own slot.` (professional cannot book own slot)
- `Role is not authorized for this action.` (only customer/admin allowed)

#### 404 Not Found

Slot does not exist.

```json
{
  "success": false,
  "error": "Selected slot was not found."
}
```

#### 409 Conflict

Business rule violation.

```json
{
  "success": false,
  "error": "Selected slot is not bookable."
}
```

Common conflict errors:

- `Selected slot is not bookable.`
- `A booking intent already exists for this slot.` (duplicate for same customer)
- `Selected slot already has an active booking intent.` (slot already booked)

#### 429 Too Many Requests

Rate limit exceeded.

```json
{
  "success": false,
  "error": "Too many requests, please try again later."
}
```

#### 503 Service Unavailable

Feature flag is disabled.

```json
{
  "success": false,
  "code": "FEATURE_DISABLED",
  "error": "Feature CREATE_BOOKING_INTENT is currently disabled"
}
```

#### 500 Internal Server Error

Unexpected server error.

```json
{
  "success": false,
  "error": "Internal server error"
}
```

## Examples

### Create a booking intent

```bash
curl -X POST http://localhost:3001/api/v1/booking-intents \
  -H "Content-Type: application/json" \
  -H "x-chronopay-user-id: customer-123" \
  -H "x-chronopay-role: customer" \
  -d '{
    "slotId": "slot-100",
    "note": "Window seat please"
  }'
```

### Create without optional note

```bash
curl -X POST http://localhost:3001/api/v1/booking-intents \
  -H "Content-Type: application/json" \
  -H "x-chronopay-user-id: customer-123" \
  -H "x-chronopay-role: customer" \
  -d '{
    "slotId": "slot-100"
  }'
```

## Security Considerations

### Validation

- **Payload validation:** Strict schema validation prevents injection attacks
- **SlotId format:** Alphanumeric with hyphens only (3-64 chars) prevents malformed IDs
- **Note length:** Max 500 characters prevents unbounded storage
- **Authentication:** Required headers prevent unauthorized access

### Rate Limiting

- **Per-IP limiting:** 10 requests per 15 minutes prevents abuse
- **Deterministic errors:** 429 responses include `RateLimit` headers per RFC draft-7

### Business Logic

- **Slot validation:** Ensures slot exists and is bookable
- **Self-booking prevention:** Professionals cannot book their own slots
- **Duplicate prevention:** One booking intent per customer per slot
- **Audit logging:** All requests logged with IP, resource, and status

### Feature Flag

- **Safe rollout:** Disabled by default (`FF_CREATE_BOOKING_INTENT`)
- **Deterministic 503:** When disabled, returns 503 with feature flag code
- **Environment-driven:** Enable via `FF_CREATE_BOOKING_INTENT=true` env var

## Environment Variables

| Variable                   | Default           | Description                                      |
| -------------------------- | ----------------- | ------------------------------------------------ |
| `FF_CREATE_BOOKING_INTENT` | `false`           | Enable/disable booking intent creation           |
| `RATE_LIMIT_WINDOW_MS`     | `900000` (15 min) | Rate limit window in milliseconds                |
| `RATE_LIMIT_MAX`           | `100`             | Global rate limit (per-endpoint limits override) |

## Implementation Notes

### Repositories

The endpoint uses in-memory repositories for development. Replace with database layer in production:

- `BookingIntentRepository`: Manages booking intent records
- `SlotRepository`: Manages slot records

### Service Layer

`BookingIntentService` handles business logic:

- Slot validation (exists, bookable)
- Authorization (not own slot)
- Duplicate prevention
- Record creation

### Middleware Stack

1. **Rate Limiter:** Per-endpoint stricter limit (10/15min)
2. **Feature Flag:** Returns 503 if disabled
3. **Authentication:** Validates user ID and role
4. **Audit Logging:** Logs action after response
5. **Error Handler:** Catches and formats errors

## Testing

Run tests with:

```bash
npm test -- src/__tests__/booking-intents.test.ts
```

Test coverage includes:

- Feature flag gating (enabled/disabled)
- Authentication (missing headers, invalid roles)
- Payload validation (format, length, type)
- Business logic (slot not found, not bookable, self-booking, duplicates)
- Rate limiting (within limit, exceeding limit)
- Security headers (all headers present)
- Error responses (deterministic error envelopes)
