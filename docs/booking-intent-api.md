# Booking Intent API

## Overview

ChronoPay now exposes a booking-intent creation endpoint for reserving a bookable slot before downstream payment or confirmation work occurs.

## Endpoint

- `POST /api/v1/booking-intents`

## Authentication and authorization

The current backend architecture assumes authentication is terminated by a trusted upstream layer. The backend consumes these headers:

- `x-chronopay-user-id` required
- `x-chronopay-role` optional

Allowed roles for booking intent creation:

- `customer`
- `admin`

Requests with missing identity fail with `401`.
Requests with an unauthorized role fail with `403`.

## Request schema

```json
{
  "slotId": "slot-100",
  "note": "Please confirm wheelchair access"
}
```

### Validation rules

- `slotId` is required
- `slotId` must match `^[a-zA-Z0-9-]{3,64}$`
- `note` is optional
- if provided, `note` must be a non-empty string trimmed to 500 characters or fewer
- client-supplied ownership fields are ignored; the customer identity comes from auth headers

## Success response

Status: `201`

```json
{
  "success": true,
  "bookingIntent": {
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

- `400` invalid payload
- `401` missing authenticated actor
- `403` unauthorized role or self-booking attempt
- `404` slot not found
- `409` slot not bookable
- `409` duplicate intent for the same customer and slot
- `409` conflicting active intent already exists for the slot
- `500` unexpected service failure with a sanitized error

## Security notes

- booking details are derived from the server-side slot catalog using `slotId`
- the API does not trust client-supplied `customerId`
- self-booking is blocked
- errors are sanitized and do not expose internal exception details
- mass-assignment risk is reduced by explicitly parsing only supported request fields

## Assumptions and constraints

- slot data is currently backed by an in-memory repository aligned with the existing stub backend architecture
- booking intents are currently stored in memory as a preparation step, not durable persistence
- this is a focused vertical slice intended to fit the present repo shape without introducing a larger persistence subsystem
