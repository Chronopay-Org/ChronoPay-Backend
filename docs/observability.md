# Observability

## Request Correlation IDs

ChronoPay uses `X-Request-Id` for end-to-end request correlation.

- If a client sends `X-Request-Id`, the server validates and reuses it.
- If absent or malformed, the server generates a new request ID.
- The request ID is always returned in the `X-Request-Id` response header.

### Log propagation

- Request logging includes the correlation ID as `requestId`.
- Error logs include the same `requestId` to link failures to originating requests.

### Error response propagation

- Standard error envelopes include `error.requestId` for troubleshooting.
- This allows API consumers to provide a single identifier when reporting incidents.

## Service Level Objectives (SLOs)

Route-level objectives and burn-rate metrics are defined in `src/metrics/sloMetrics.ts` (`booking_intent`, `slots_list`, `checkout`, `escrow_listener`).

A **weekly error-budget report** is posted to Slack every Monday (see [slo-weekly-report.md](./slo-weekly-report.md) and `ops/dashboards/slo-burn-rate.json`).

### Booking Intents
- **Availability & Latency:** 99.9% of booking-intent creates (`POST /api/v1/booking-intents`) complete in under 500ms over a rolling 30-day window.

### Security notes

- Correlation IDs are not derived from secrets or sensitive payload fields.
- IDs are treated as opaque metadata for diagnostics only.
