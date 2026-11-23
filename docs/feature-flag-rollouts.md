# Scheduled Feature-Flag Rollouts (#570)

Percentage-based, time-scheduled ramps for existing feature flags. A rollout
schedule ramps a flag from 0% up to 100% of traffic through an ordered list
of steps, each with its own activation time, scoped to a single
**(flag, tenant, environment)** tuple. This layers on top of the existing
boolean flag system in [`docs/feature-flags.md`](./feature-flags.md) — it
does not replace it.

## Model

```
RolloutSchedule {
  id
  flag              // one of FEATURE_FLAG_NAMES
  tenantId          // a specific tenant id, or "*" (ALL_TENANTS) for every tenant
  environment       // "development" | "test" | "production"
  steps: [{ percentage, at }]   // percentage 1–100, at = ISO-8601 timestamp
  status            // "pending" | "active" | "paused" | "rolled_back" | "completed"
  currentStepIndex  // -1 until the first step fires
  currentPercentage
  history           // append-only log of created/advanced/paused/resumed/rolled_back
}
```

Steps must be strictly increasing in both time and percentage — a schedule
is a ramp, not an arbitrary sequence.

Only one **in-flight** schedule (`pending`, `active`, or `paused`) may exist
per `(flag, tenant, environment)` tuple at a time. A new one may be created
once the previous has reached a terminal state (`completed` or
`rolled_back`).

## Evaluation

The boolean flag is always the outer kill-switch:

```
isFeatureEnabledForTenant(flag, tenantId, bucketKey, environment?)
  = isFeatureEnabled(flag) AND bucketOf(bucketKey) < rolloutPercentage(flag, tenantId, environment)
```

- If the boolean flag is disabled, the rollout percentage is irrelevant —
  the request is always rejected. A ramp can never turn on a flag that is
  off at the kill-switch level.
- If no schedule governs the tuple, the rollout percentage defaults to
  **100%** — a flag with no rollout schedule behaves exactly like the plain
  boolean flag it always was. This keeps every existing `isFeatureEnabled`
  call site unaffected.
- A tenant-specific schedule takes priority over an `ALL_TENANTS` (`"*"`)
  wildcard schedule for the same flag/environment.
- `bucketKey` (e.g. a user id, session id, or tenant id) is hashed with a
  32-bit FNV-1a hash into a bucket in `[0, 100)`. The same key always maps
  to the same bucket, so a rollout is sticky per key across requests instead
  of flapping.

Access it via the request-scoped accessor:

```ts
req.flags!.isEnabledForTenant("CREATE_SLOT", tenantId, userId);
```

or the standalone functions in `src/flags/rolloutEvaluator.ts` for
non-request contexts.

## Scheduler

`FlagRolloutScheduler` (`src/scheduler/flagRolloutScheduler.ts`) ticks once a
minute by default (`FLAG_ROLLOUT_INTERVAL_MS`) and calls
`RolloutScheduleRegistry.advanceDue(now)`, which advances every non-paused,
non-terminal schedule to the **latest** step whose `at` has passed `now`.

Disable the scheduler with `FLAG_ROLLOUT_SCHEDULER_DISABLED=true` (useful for
one-off scripts and some test harnesses).

### Missed steps / outage catch-up

Advancing always jumps straight to the latest due step instead of replaying
every intermediate one. If the scheduler process was down (or a schedule was
paused) while two step times passed, the next `advanceDue` call (or a
`resume`) applies the later step directly — it does not fire the
intermediate percentage first. This is deliberate: an outage should not
cause a burst of intermediate rollout percentages when the scheduler catches
up.

## Pause, resume, rollback

- **Pause** (`POST /:id/pause`) freezes the schedule at its current
  percentage. A paused schedule is skipped by every scheduler tick, even if
  a step's time has since passed.
- **Resume** (`POST /:id/resume`) un-pauses and immediately re-evaluates
  "what step is due right now" — it does not wait for the next tick. If
  steps became due while paused, resume jumps straight to the latest one
  (same outage-catch-up behavior as the scheduler).
- **Rollback** (`POST /:id/rollback`) reverts to an earlier step (defaults
  to one step back; pass `toStepIndex` to jump back across multiple steps
  at once, or `-1` to revert fully to 0%). Rollback is **terminal** — the
  scheduler will never advance a rolled-back schedule again. An operator
  must create a fresh schedule to resume ramping. This is intentional: an
  incident-triggered rollback should never silently resume ramping up on
  its own.

## Admin API

All routes are mounted at `/api/v1/admin/flag-rollouts` and require the
`x-chronopay-admin-token` header (same gate as `/api/v1/admin/fraud-models`,
see `src/middleware/authorization.ts`). Mutating actions take an explicit
`actor` field in the request body rather than deriving an actor identity
from the admin token itself, so the shared admin secret is never recorded as
an actor in audit logs or schedule history.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/` | `{ flag, tenantId, environment, steps, actor }` | Create a schedule. `409 SCHEDULE_IN_FLIGHT` if one is already in-flight for the tuple. |
| `GET` | `/` | — | List schedules; optional `?flag=&tenantId=&environment=&status=` filters. |
| `GET` | `/:id` | — | Fetch one schedule, including its full history. |
| `POST` | `/:id/pause` | `{ actor, reason? }` | Freeze at the current percentage. |
| `POST` | `/:id/resume` | `{ actor }` | Un-pause and catch up to now. |
| `POST` | `/:id/rollback` | `{ actor, reason, toStepIndex? }` | Revert to an earlier step; terminal. |

Every mutating action fires an audit event (`FLAG_ROLLOUT_CREATED`,
`FLAG_ROLLOUT_PAUSED`, `FLAG_ROLLOUT_RESUMED`, `FLAG_ROLLOUT_ROLLED_BACK`)
via `defaultAuditLogger`, fire-and-forget so a logging failure never blocks
the response.

### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `UNKNOWN_FLAG`, `UNKNOWN_ENVIRONMENT`, `MISSING_TENANT`, `MISSING_ACTOR`, `MISSING_REASON`, `EMPTY_STEPS`, `TOO_MANY_STEPS`, `INVALID_PERCENTAGE`, `INVALID_TIMESTAMP`, `STEPS_NOT_CHRONOLOGICAL`, `STEPS_NOT_INCREASING`, `INVALID_ROLLBACK_TARGET`, `NOTHING_TO_ROLLBACK` | 400 | Request validation failure. |
| `NOT_FOUND` | 404 | Unknown schedule id. |
| `SCHEDULE_IN_FLIGHT`, `ALREADY_PAUSED`, `ALREADY_ROLLED_BACK`, `INVALID_STATE_TRANSITION` | 409 | Conflicts with the schedule's current state. |

## Security notes

- Every admin route is behind the same shared-secret admin token gate used
  by the fraud-model rollback endpoints; there is no unauthenticated read or
  write access to rollout schedules.
- The boolean flag remains the fail-closed kill-switch; a rollout schedule
  can only narrow traffic further, never widen it past what the boolean flag
  already allows.
- Rollback is terminal by design, so an automated ramp can never silently
  resume after an incident-triggered rollback.
- Percentage bucketing is a deterministic hash, not `Math.random()` — the
  same bucket key always gets the same decision, so a rollout cannot be
  bypassed by retrying a request.
