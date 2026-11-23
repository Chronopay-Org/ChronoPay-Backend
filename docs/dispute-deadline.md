# Dispute Deadline Scheduler

Auto-resolves disputes that have been left inactive past configurable policy windows. Each auto-resolution records an audit event and can be reversed by an admin within a configurable reversal window.

## Auto-Resolution Rules

| Current Status   | Target Status | Condition                                                     |
|------------------|---------------|---------------------------------------------------------------|
| OPEN             | TIMEOUT       | No chain activity within `DISPUTE_INACTIVITY_TIMEOUT_MS`      |
| EVIDENCED        | TIMEOUT       | No chain activity within `DISPUTE_INACTIVITY_TIMEOUT_MS`      |
| ADJUDICATED      | CLOSED        | Appeal window (`appealWindowMs` or default 72h) has expired   |
| APPEALED         | CLOSED        | Senior review deadline (`DISPUTE_SENIOR_REVIEW_TIMEOUT_MS`)   |
| SENIOR_REVIEW    | CLOSED        | Senior review deadline (`DISPUTE_SENIOR_REVIEW_TIMEOUT_MS`)   |

**Rulings applied:**
- OPEN / EVIDENCED → TIMEOUT: `"TIMEOUT_NO_ACTIVITY"`
- ADJUDICATED / APPEALED / SENIOR_REVIEW → CLOSED: Original `ruling` value or `"NO_RULING_AVAILABLE"`

## Reversibility

Every auto-resolution stores `autoResolvedAt` and `autoResolveWindowMs` on the dispute. Within that window (default 24h), an admin can reverse the auto-resolution via:

```
POST /api/v1/admin/disputes/:id/reverse-auto-resolve
```

The dispute is restored to the status it held immediately before the auto-resolution (determined from the finality hash chain).

### Reversal Error Codes

| Code                      | HTTP Status | Meaning                                    |
|---------------------------|-------------|--------------------------------------------|
| `DISPUTE_NOT_FOUND`       | 404         | No dispute with the given id exists        |
| `NOT_AUTO_RESOLVED`       | 400         | Dispute was never auto-resolved            |
| `REVERSAL_WINDOW_EXPIRED` | 410         | The reversal window has elapsed            |
| `INVALID_STATE`           | 409         | Dispute is not in TIMEOUT or CLOSED state  |

## Admin Endpoints

### One-off Scan
```
POST /api/v1/admin/disputes/deadline/scan
```
Triggers a single scan of all disputes. Returns `{ resolved: [...], skipped: number }`.

### Reversal
```
POST /api/v1/admin/disputes/:id/reverse-auto-resolve
```
Reverses an auto-resolution. Returns the restored dispute.

### Scheduler Status
```
GET /api/v1/admin/disputes/deadline/status
```
Returns `{ running: boolean }`.

## Configuration

| Env Variable                       | Default       | Description                                        |
|------------------------------------|---------------|----------------------------------------------------|
| `DISPUTE_DEADLINE_INTERVAL_MS`     | 60000 (1 min) | How often the scheduler scans for stale disputes   |
| `DISPUTE_INACTIVITY_TIMEOUT_MS`    | 30 days       | Grace period for OPEN / EVIDENCED inactivity       |
| `DISPUTE_SENIOR_REVIEW_TIMEOUT_MS` | 14 days       | Deadline for APPEALED / SENIOR_REVIEW resolution   |
| `DISPUTE_AUTO_RESOLVE_WINDOW_MS`   | 24 hours      | Window for admin reversal of auto-resolution       |
| `DISPUTE_DEADLINE_DISABLED`        | (unset)       | Set to `"true"` to disable the background scheduler|

## Audit Events

| Event                         | Meaning                                    |
|-------------------------------|--------------------------------------------|
| `DISPUTE_AUTO_RESOLVED`       | A dispute was auto-resolved by the scanner |
| `DISPUTE_AUTO_RESOLVE_REVERSED` | An auto-resolution was reversed by admin |

## Architecture

```
┌──────────────────────┐     ┌──────────────────────────────┐
│  DisputeDeadline     │────→│  scanAndAutoResolve()        │
│  Scheduler           │     │  - iterates disputes         │
│  (setInterval)       │     │  - checks grace windows      │
└──────────────────────┘     │  - transitions state         │
                             │  - appends finality chain    │
┌──────────────────────┐     │  - emits audit event         │
│  Admin HTTP Endpoint │────→│  - returns result            │
│  (POST /scan)        │     └──────────────────────────────┘
└──────────────────────┘
```

The scheduler and the on-demand scan endpoint share the same `scanAndAutoResolve` function.
