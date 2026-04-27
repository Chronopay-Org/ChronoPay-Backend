# Request Timeouts

## Overview
This document describes the request timeout middleware for the ChronoPay backend, including configuration, usage, and security considerations.

## Purpose
Request timeouts prevent hung or slow requests from exhausting server resources. This middleware enforces a maximum duration for each request, with safe defaults and per-route overrides.

## Configuration
- **Default timeout:** Set via `REQUEST_TIMEOUT_MS` environment variable (default: 10 seconds).
- **Per-route override:** Pass `{ timeoutMs: <number> }` in route options.

## Usage
- All routes are protected by a default timeout unless explicitly overridden.
- For long-running routes, specify a higher timeout as needed.

## Logging
- On timeout, logs include `requestId`, route, and duration.

## Security
- No partial data or internal stack traces are leaked on timeout.
- Returns HTTP 503 with a generic error message.

## Example
```ts
app.get('/api/v1/slow', timeoutMiddleware({ timeoutMs: 20000 }), handler);
```

## Testing
- All timeout scenarios are covered by automated tests.
- Edge cases (downstream timeouts, override logic) are tested.
