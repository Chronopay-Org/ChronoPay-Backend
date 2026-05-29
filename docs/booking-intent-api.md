# Booking Intent API

## Overview

ChronoPay exposes a booking-intent creation endpoint for reserving a bookable slot before downstream payment or confirmation work occurs.

## Endpoint

- `POST /api/v1/booking-intents`

## Feature flag

This endpoint is protected by the `FF_CREATE_BOOKING_INTENT` feature flag. When disabled, requests return `503 Service Unavailable`.

## Authentication and authorization

The current backend architecture assumes authentication is terminated by a trusted upstream layer. The backend consumes these headers:

- `x-chronopay-user-id` required
- `x-chronopay-role` required

Allowed roles for booking intent creation:

- `customer`
- `admin`

Requests with missing identity fail with `401`.
Requests with an unauthorized role fail with `403`.

## Rate limiting

This endpoint is protected by an auth-aware rate limiter that applies per-user rate limits.

## Payload limit

This endpoint enforces a maximum payload size of `16kb`. Requests exceeding this limit return `413 Payload Too Large`.

## Request schema

```json
{
  "slotId": "slot-100",
  "note": "Please confirm wheelchair access"
}
```

### Validation rules

- `slotId` is required
- `slotId` must be a non-empty string
- `slotId` must match `^[a-zA-Z0-9-]{3,64}$` after trimming
- `note` is optional
- if provided, `note` must be a string
- if provided, `note` must be a non-empty string after trimming
- if provided, `note` must be 500 characters or fewer after trimming
- client-supplied ownership fields are ignored; the customer identity comes from auth headers

## Success response

Status: `201 Created`

```json
{
  "success": true,
  "intent": {
    "id": "intent-1",
    "slotId": "slot-100",
    "professional": "alice",
    "customerId": "customer-1",
    "startTime": 1900000000000,
    "endTime": 1900000360000,
    "status": "pending",
    "note": "Please confirm wheelchair access",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

## Failure modes

| Status | Code | Message | Condition |
|---|---|---|---|
| `400` | `BAD_REQUEST` | `Booking intent payload must be a JSON object.` | Request body is not an object |
| `400` | `BAD_REQUEST` | `slotId is required.` | slotId field is missing |
| `400` | `BAD_REQUEST` | `slotId format is invalid.` | slotId does not match pattern |
| `400` | `BAD_REQUEST` | `note must be a string when provided.` | note is not a string |
| `400` | `BAD_REQUEST` | `note cannot be empty when provided.` | note is empty after trimming |
| `400` | `BAD_REQUEST` | `note must be 500 characters or fewer.` | note exceeds 500 characters |
| `401` | `UNAUTHORIZED` | `Authentication required` | Missing x-chronopay-user-id header |
| `403` | `FORBIDDEN` | `Role is not authorized for this action` | Role not in [customer, admin] |
| `403` | `FORBIDDEN` | `You cannot create a booking intent for your own slot.` | Self-booking attempt |
| `404` | `NOT_FOUND` | `Selected slot was not found.` | Slot does not exist |
| `409` | `CONFLICT` | `Selected slot is not bookable.` | Slot is marked as not bookable |
| `409` | `CONFLICT` | `A booking intent already exists for this slot.` | Duplicate intent for same customer and slot |
| `409` | `CONFLICT` | `Selected slot already has an active booking intent.` | Conflicting active intent exists for the slot |
| `413` | `PAYLOAD_TOO_LARGE` | `Request body exceeds the 16kb limit for this endpoint.` | Payload exceeds 16kb |
| `429` | `TOO_MANY_REQUESTS` | Rate limit exceeded | Too many requests from user |
| `503` | `SERVICE_UNAVAILABLE` | Feature flag disabled | FF_CREATE_BOOKING_INTENT is false |
| `500` | `INTERNAL_ERROR` | `Internal server error` | Unexpected service failure |

## Security notes

- booking details are derived from the server-side slot catalog using `slotId`
- the API does not trust client-supplied `customerId`
- self-booking is blocked (professionals cannot book their own slots)
- errors are sanitized and do not expose internal exception details
- mass-assignment risk is reduced by explicitly parsing only supported request fields
- payload size is limited to 16kb to reduce abuse surface
- rate limiting prevents abuse from individual users

## Audit logging

All booking intent creation attempts are logged with:
- Actor identity (userId, role)
- Request payload (slotId, note)
- Result (success/failure)
- Timestamp

## Assumptions and constraints

- slot data is currently backed by an in-memory repository aligned with the existing stub backend architecture
- booking intents are currently stored in memory as a preparation step, not durable persistence
- this is a focused vertical slice intended to fit the present repo shape without introducing a larger persistence subsystem
