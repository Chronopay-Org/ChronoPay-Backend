# Update Slot Endpoint

## Scope

This document describes the `PATCH /api/v1/slots/:id` endpoint implementation in ChronoPay backend.

## Endpoint Contract

- Method: `PATCH`
- Path: `/api/v1/slots/:id`
- Header: `x-chronopay-admin-token` (required)
- Body: one or more of `professional`, `startTime`, `endTime`

## Acceptance Criteria

- Returns `200` with updated slot when payload and authorization are valid.
- Returns `400` for invalid slot id, invalid payload shape, invalid values, or reversed ranges.
- Returns `401` when the admin token header is missing.
- Returns `403` when the token header is present but invalid.
- Returns `404` when the slot does not exist.
- Returns `503` when authorization is not configured on the server.

## Failure-Mode Handling

- Update requests are atomic at service level: slot data is replaced only after full validation passes.
- Non-existent slots are rejected without mutating any in-memory state.
- Partial updates are validated as a full final range (`endTime > startTime`) before persisting.

## Security Notes

- Sensitive update operations are protected by a server-configured admin token.
- Authorization failures intentionally do not leak token details.
- Input validation blocks malformed updates and invalid schedule windows.