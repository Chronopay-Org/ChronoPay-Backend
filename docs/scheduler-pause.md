# Scheduler Pause / Resume Kill-Switch

An admin-only, platform-wide kill-switch that **freezes new booking-intent
creation** during an incident (e.g. a downstream outage, a fraud spike, a bad
deploy) while leaving **read paths intact** — customers can still view existing
bookings, cancel previews, hold status, etc.

The switch is a single Redis flag (`scheduler:paused`) checked by a lightweight
guard middleware on the booking-intent *create* route. It is intentionally
cheap to read (one `GET`) and safe to fail.

- Relevant code: [`src/redis.ts`](../src/redis.ts),
  [`src/middleware/schedulerGate.ts`](../src/middleware/schedulerGate.ts),
  [`src/routes/admin/scheduler.ts`](../src/routes/admin/scheduler.ts),
  [`src/services/schedulerStatusBus.ts`](../src/services/schedulerStatusBus.ts)

---

## Endpoints

All three require the shared admin token in the `x-chronopay-admin-token`
header (see [`requireAdminToken`](../src/middleware/authorization.ts)). They are
mounted under `/api/v1/admin/scheduler`.

### `POST /api/v1/admin/scheduler/pause`

Freeze new booking-intent creation platform-wide.

Body:

| Field          | Type   | Required | Notes                                      |
| -------------- | ------ | -------- | ------------------------------------------ |
| `reason`       | string | yes      | Human-readable incident reason.            |
| `initiated_by` | string | yes      | Operator identity (also accepts `initiatedBy`). |

```bash
curl -X POST https://api.chronopay.com/api/v1/admin/scheduler/pause \
  -H "x-chronopay-admin-token: $CHRONOPAY_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{ "reason": "payments provider degraded", "initiated_by": "oncall-jane" }'
```

```json
200 OK
{
  "success": true,
  "scheduler": {
    "paused": true,
    "reason": "payments provider degraded",
    "initiatedBy": "oncall-jane",
    "pausedAt": "2026-07-31T09:15:04.512Z"
  }
}
```

### `POST /api/v1/admin/scheduler/resume`

Lift the freeze.

| Field          | Type   | Required |
| -------------- | ------ | -------- |
| `initiated_by` | string | yes      |

```json
200 OK
{ "success": true, "scheduler": { "paused": false, "initiatedBy": "oncall-jane" } }
```

### `GET /api/v1/admin/scheduler/status`

Read the current state (a read path — safe to call during a freeze).

```json
200 OK
{ "success": true, "scheduler": { "paused": true, "reason": "...", "initiatedBy": "...", "pausedAt": "..." } }
```

### Error responses

| Status | `code`                | When                                                     |
| ------ | --------------------- | -------------------------------------------------------- |
| 401    | (auth)                | Missing `x-chronopay-admin-token`.                       |
| 403    | (auth)                | Wrong admin token.                                       |
| 400    | `INVALID_REASON`      | `reason` missing/blank on pause.                         |
| 400    | `INVALID_INITIATED_BY`| `initiated_by` missing/blank.                            |
| 503    | `REDIS_UNAVAILABLE`   | Redis could not be reached to read/update the flag.      |
| 500    | `INTERNAL_ERROR`      | Unexpected failure.                                      |

---

## What callers see while paused

The guard ([`schedulerGate`](../src/middleware/schedulerGate.ts)) is attached to
the booking-intent **create** route only. While paused it returns:

```json
503 Service Unavailable
Retry-After: 120
{
  "success": false,
  "error": "Booking creation is temporarily paused by an operator.",
  "code": "SCHEDULER_PAUSED",
  "reason": "payments provider degraded",
  "initiatedBy": "oncall-jane",
  "pausedAt": "2026-07-31T09:15:04.512Z"
}
```

Read routes (`GET /:id/hold-status`, `GET /:id/cancel-preview`, listings, …) are
**not** guarded and keep working.

---

## The Redis flag

- **Key:** `scheduler:paused`
- **Value:** a small JSON payload — `{"paused":1,"reason":"…","initiated_by":"…","paused_at":"…"}`.
  The `paused` field is `1`, satisfying the "`scheduler:paused=1`" contract while
  still carrying the audit metadata. A bare legacy `"1"` value is also honoured.
- **Resume** deletes the key, so "not paused" is simply the *absence* of the key —
  the safest default if the value is ever evicted.

## Fail-open contract (important)

The pause flag is a **safety** mechanism, not a correctness one. If Redis is
unreachable **at guard time**, the guard **fails open** (allows the request) and
logs a warning. A kill-switch must never turn an unrelated Redis outage into a
total booking outage.

- Guard, Redis down → `next()` + `warn` log (traffic flows).
- Guard, flag set → `503 SCHEDULER_PAUSED` (traffic blocked).
- Control-plane write, Redis down → `503 REDIS_UNAVAILABLE` (the operator is told
  the pause/resume could not be persisted, rather than silently succeeding).

## Realtime broadcast

Every pause/resume is broadcast on the in-process status bus
([`schedulerStatusBus`](../src/services/schedulerStatusBus.ts), channel
`scheduler:status`). The WebSocket layer subscribes via `onSchedulerStatus(...)`
and relays the event to connected dashboards so a freeze is visible immediately
instead of by polling. Broadcasting is fire-and-forget and never fails the
underlying operation.

## Metrics

Two Prometheus counters (registered in [`src/metrics.ts`](../src/metrics.ts) and
exposed on `/metrics`):

- `scheduler_pause_total` — incremented on every successful pause.
- `scheduler_resume_total` — incremented on every successful resume.

## Configuration

| Env var                 | Purpose                                          | Default                    |
| ----------------------- | ------------------------------------------------ | -------------------------- |
| `REDIS_URL`             | Redis connection string for the flag.            | `redis://localhost:6379`   |
| `CHRONOPAY_ADMIN_TOKEN` | Shared secret for the admin control-plane.       | *(required)*               |

## Runbook

1. **Pause:** `POST /pause` with a clear `reason` and your handle in `initiated_by`.
2. Confirm with `GET /status` and watch `scheduler_pause_total` tick up.
3. Mitigate the incident. Booking creation returns `503 SCHEDULER_PAUSED`.
4. **Resume:** `POST /resume` with `initiated_by`. Confirm `paused:false` and
   `scheduler_resume_total`.
5. If `/pause` or `/resume` returns `503 REDIS_UNAVAILABLE`, Redis itself is the
   problem — bookings are already flowing (guard fails open); fix Redis first.
